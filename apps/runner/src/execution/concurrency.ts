import { RunnerError } from '../errors.js';

export interface ActiveTimeSnapshot { activeMs: number; elapsedMs: number; remainingMs: number }

/** One active segment of a persisted parent timeout. A new segment receives the saved total, never a fresh allowance. */
export class ActiveExecutionDeadline {
  private readonly controller = new AbortController();
  private readonly started: number;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private closed: ActiveTimeSnapshot | undefined;
  readonly signal: AbortSignal;

  constructor(private readonly maximumMs: number, private readonly previousActiveMs: number, parent: AbortSignal, private readonly clock: () => number = () => performance.now()) {
    if (!Number.isFinite(maximumMs) || maximumMs <= 0 || maximumMs > 2_147_483_647 || !Number.isFinite(previousActiveMs) || previousActiveMs < 0) throw new RunnerError('CHILD_TIME_STATE_INVALID', '하위 작업의 저장된 실행 시간 한도를 확인하지 못했습니다.');
    this.started = clock();
    if (!Number.isFinite(this.started)) throw new RunnerError('CHILD_TIME_STATE_INVALID', '활성 실행 시간 측정을 시작하지 못했습니다.');
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    const remaining = maximumMs - previousActiveMs;
    const timeout = () => this.controller.abort(new RunnerError('BUDGET_EXCEEDED', '하위 작업의 누적 활성 시간 한도를 초과했습니다.'));
    if (remaining <= 0) timeout();
    else { this.timer = setTimeout(timeout, Math.ceil(remaining)); this.timer.unref(); }
  }

  /** The caller atomically persists this total when suspending; reading it does not grant a continuation. */
  snapshot(): ActiveTimeSnapshot {
    if (this.closed) return { ...this.closed };
    const point = this.clock();
    if (!Number.isFinite(point) || point < this.started) throw new RunnerError('CHILD_TIME_STATE_INVALID', '활성 실행 시간 측정이 올바르지 않습니다.');
    const elapsedMs = point - this.started, activeMs = this.previousActiveMs + elapsedMs;
    return { activeMs, elapsedMs, remainingMs: Math.max(0, this.maximumMs - activeMs) };
  }

  /** End the segment before returning a human wait. Later wall time cannot consume or reset the saved active budget. */
  close(): ActiveTimeSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.closed ??= this.snapshot();
    return { ...this.closed };
  }
}

/** Cancellation-aware permits limit real leaf work; parents awaiting children never hold a permit. */
export class LeafConcurrency {
  private active = 0;
  private readonly pending: { signal: AbortSignal; grant: () => void; abort: () => void }[] = [];
  constructor(private readonly maximum: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(interruption(signal));
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        grant: () => { signal.removeEventListener('abort', entry.abort); this.active++; let released = false; resolve(() => { if (released) return; released = true; this.active--; this.drain(); }); },
        abort: () => { const index = this.pending.indexOf(entry); if (index >= 0) this.pending.splice(index, 1); signal.removeEventListener('abort', entry.abort); reject(interruption(signal)); },
      };
      if (this.active < this.maximum && !this.pending.length) entry.grant();
      else { this.pending.push(entry); signal.addEventListener('abort', entry.abort, { once: true }); if (signal.aborted) entry.abort(); }
    });
  }

  private drain(): void {
    while (this.active < this.maximum && this.pending.length) { const next = this.pending.shift()!; if (next.signal.aborted) next.abort(); else next.grant(); }
  }
}

/** Parent timeout and user cancellation remain explicit protected outcomes at every child boundary. */
export function interruption(signal: AbortSignal): Error {
  if (signal.reason instanceof RunnerError) return signal.reason;
  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') return new RunnerError('BUDGET_EXCEEDED', '하위 작업의 실행 시간 한도를 초과했습니다.');
  return new RunnerError('RUN_CANCELLED', '실행이 취소되었습니다.');
}
