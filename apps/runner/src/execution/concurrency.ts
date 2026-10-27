import { RunnerError } from '../errors.js';

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
