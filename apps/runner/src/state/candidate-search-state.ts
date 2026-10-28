import type { DatabaseSync } from 'node:sqlite';
import { RunnerError } from '../errors.js';

export interface CandidateLimits { maxCandidates: number; maxDepth: number; maxVerifications: number }
export interface CandidateRecord {
  id: string; parentId: string | null; depth: number; value: unknown; expanded: boolean;
  verificationReserved: boolean; verification: { accepted: boolean; score: 0 | 1 } | null;
}
export interface CandidateVerifierPin { id: 'json-schema-v1'; version: 1; contractHash: string }
export interface CandidateSearchResult {
  candidates: CandidateRecord[]; selected: CandidateRecord | null;
  stopReason: 'accepted' | 'exhausted' | 'max_candidates' | 'max_verifications' | 'max_depth';
  counts: { candidates: number; verifications: number; generations: number }; verifier: CandidateVerifierPin;
}
export interface CandidateSearchState {
  revision: number; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'attention_required';
  limits: CandidateLimits; candidates: CandidateRecord[]; verifier: CandidateVerifierPin;
  verifications: number; generations: number; reservedCandidates: number;
  generation: { key: string; parentId: string | null; depth: number; slots: number } | null;
  result: CandidateSearchResult | null; error: { code: string; message: string } | null;
}
export const CANDIDATE_SEARCH_MIGRATION = `
CREATE TABLE IF NOT EXISTS candidate_searches(node_instance_id TEXT PRIMARY KEY REFERENCES node_instances(id),run_id TEXT NOT NULL REFERENCES runs(id),request_hash TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS candidate_search_run ON candidate_searches(run_id,status);
`;
const candidate = (value: unknown, index: number, parentId: string | null, depth: number): CandidateRecord => ({ id: `candidate_${String(index + 1).padStart(6, '0')}`, parentId, depth, value: structuredClone(value), expanded: false, verificationReserved: false, verification: null });
type Row = { request_hash: string; body: string };

/** The owning RunStore supplies its transaction and event writers; handler code never writes SQL or chooses a different run budget. */
export class CandidateSearchStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(work: () => T) => T, private readonly event: (runId: string, type: string, payload: unknown) => void) {}

  private row(runId: string, nodeId: string): Row | undefined {
    return this.db.prepare('SELECT request_hash,body FROM candidate_searches WHERE run_id=? AND node_instance_id=?').get(runId, `${runId}:${nodeId}`) as Row | undefined;
  }
  private writableRun(runId: string): void {
    const run = this.db.prepare('SELECT status,cancel_requested FROM runs WHERE id=?').get(runId) as { status: string; cancel_requested: number } | undefined;
    if (!run || run.cancel_requested) throw new RunnerError('RUN_CANCELLED', '후보 탐색 실행이 취소되었거나 없습니다.');
    if (run.status !== 'running') throw new RunnerError('CANDIDATE_NOT_REPLAYABLE', '실행 중인 run에서만 후보 탐색 상태를 변경할 수 있습니다.');
  }
  get(runId: string, nodeId: string): CandidateSearchState {
    const row = this.row(runId, nodeId); if (!row) throw new RunnerError('CANDIDATE_STATE_MISSING', '후보 탐색 기록이 없습니다.');
    return JSON.parse(row.body) as CandidateSearchState;
  }
  private save(runId: string, nodeId: string, state: CandidateSearchState, type: string): void {
    this.db.prepare('UPDATE candidate_searches SET status=?,body=? WHERE run_id=? AND node_instance_id=?').run(state.status, JSON.stringify(state), runId, `${runId}:${nodeId}`);
    this.event(runId, type, { nodeId, revision: state.revision, status: state.status, candidates: state.candidates.length, verifications: state.verifications, generations: state.generations, reservedCandidates: state.reservedCandidates });
  }
  private change(runId: string, nodeId: string, revision: number, type: string, update: (state: CandidateSearchState) => void): CandidateSearchState {
    return this.transaction(() => {
      this.writableRun(runId); const state = this.get(runId, nodeId);
      if (state.revision !== revision) throw new RunnerError('CANDIDATE_STATE_CONFLICT', '후보 탐색 상태가 이미 변경되었습니다.');
      if (state.status !== 'running') throw new RunnerError('CANDIDATE_NOT_REPLAYABLE', '종료되거나 미확인인 탐색은 다시 실행할 수 없습니다.');
      update(state); state.revision++; this.save(runId, nodeId, state, type); return state;
    });
  }

  /** Initial candidates are admitted atomically; a previous incomplete invocation is never reset by retry or restart. */
  begin(runId: string, nodeId: string, requestHash: string, limits: CandidateLimits, verifier: CandidateVerifierPin, initial: readonly unknown[]): CandidateSearchState {
    return this.transaction(() => {
      const previous = this.row(runId, nodeId);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new RunnerError('CANDIDATE_REQUEST_CONFLICT', '같은 후보 탐색 식별자에 다른 요청을 사용할 수 없습니다.');
        const state = JSON.parse(previous.body) as CandidateSearchState;
        if (state.status !== 'succeeded') throw new RunnerError('CANDIDATE_NOT_REPLAYABLE', '미완료·실패·취소한 탐색은 자동 재실행하지 않습니다.');
        return state;
      }
      this.writableRun(runId);
      if (!Number.isSafeInteger(limits.maxCandidates) || limits.maxCandidates < 1 || limits.maxCandidates > 1000 || !Number.isSafeInteger(limits.maxVerifications) || limits.maxVerifications < 1 || limits.maxVerifications > 1000 || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 20 || initial.length > limits.maxCandidates) throw new RunnerError('CANDIDATE_LIMIT', '후보 탐색 한도 또는 초기 후보 수가 올바르지 않습니다.');
      const state: CandidateSearchState = { revision: 0, status: 'running', limits: structuredClone(limits), verifier: structuredClone(verifier), candidates: initial.map((value, index) => candidate(value, index, null, 0)), verifications: 0, generations: 0, reservedCandidates: 0, generation: null, result: null, error: null };
      this.db.prepare('INSERT INTO candidate_searches VALUES(?,?,?,?,?)').run(`${runId}:${nodeId}`, runId, requestHash, state.status, JSON.stringify(state));
      this.event(runId, 'candidate.started', { nodeId, candidates: initial.length, verifier }); return state;
    });
  }
  reserveVerification(runId: string, nodeId: string, revision: number, id: string): CandidateSearchState {
    return this.change(runId, nodeId, revision, 'candidate.verification_reserved', state => {
      const item = state.candidates.find(value => value.id === id);
      if (!item || item.verificationReserved || state.verifications >= state.limits.maxVerifications) throw new RunnerError('CANDIDATE_LIMIT', '검증 횟수 한도 또는 후보 상태가 올바르지 않습니다.');
      item.verificationReserved = true; state.verifications++;
    });
  }
  verified(runId: string, nodeId: string, revision: number, id: string, accepted: boolean): CandidateSearchState {
    return this.change(runId, nodeId, revision, 'candidate.verified', state => {
      const item = state.candidates.find(value => value.id === id);
      if (!item?.verificationReserved || item.verification || typeof accepted !== 'boolean') throw new RunnerError('CANDIDATE_STATE_CONFLICT', '예약된 후보 검증만 한 번 확정할 수 있습니다.');
      item.verification = { accepted, score: accepted ? 1 : 0 };
    });
  }
  reserveGeneration(runId: string, nodeId: string, revision: number, parentId: string | null): CandidateSearchState {
    return this.change(runId, nodeId, revision, 'candidate.generation_reserved', state => {
      const parent = parentId === null ? null : state.candidates.find(value => value.id === parentId);
      const slots = state.limits.maxCandidates - state.candidates.length;
      if (state.generation || state.reservedCandidates || slots < 1 || state.verifications >= state.limits.maxVerifications || (parentId === null ? state.candidates.length !== 0 || state.generations !== 0 : !parent || !parent.verification || parent.verification.accepted || parent.expanded || parent.depth >= state.limits.maxDepth)) throw new RunnerError('CANDIDATE_LIMIT', '이 후보를 추가로 확장할 수 없습니다.');
      state.generation = { key: parentId === null ? 'candidate:root' : `candidate:expand:${parentId}`, parentId, depth: parent ? parent.depth + 1 : 0, slots };
      state.reservedCandidates = slots; state.generations++; if (parent) parent.expanded = true;
    });
  }
  generated(runId: string, nodeId: string, revision: number, values: readonly unknown[]): CandidateSearchState {
    return this.change(runId, nodeId, revision, 'candidate.generated', state => {
      const pending = state.generation;
      if (!pending || values.length > pending.slots || state.reservedCandidates !== pending.slots) throw new RunnerError('CANDIDATE_LIMIT', '생성한 후보가 예약한 후보 수를 초과했습니다.');
      const offset = state.candidates.length;
      state.candidates.push(...values.map((value, index) => candidate(value, offset + index, pending.parentId, pending.depth)));
      state.reservedCandidates = 0; state.generation = null;
    });
  }
  complete(runId: string, nodeId: string, revision: number, reason: CandidateSearchResult['stopReason'], selectedId: string | null): CandidateSearchState {
    return this.change(runId, nodeId, revision, 'candidate.finished', state => {
      const selected = selectedId === null ? null : state.candidates.find(value => value.id === selectedId);
      if (state.generation || state.reservedCandidates || state.candidates.some(value => value.verificationReserved && !value.verification) || (reason === 'accepted' ? !selected?.verification?.accepted : selectedId !== null)) throw new RunnerError('CANDIDATE_STATE_CONFLICT', '미확인 작업이 남은 탐색을 완료할 수 없습니다.');
      const frontier = state.candidates.filter(value => !value.expanded);
      const allVerified = state.candidates.every(value => value.verification !== null);
      if (!['accepted', 'exhausted', 'max_candidates', 'max_verifications', 'max_depth'].includes(reason) || reason !== 'accepted' && state.candidates.some(value => value.verification?.accepted) || reason === 'max_candidates' && (!allVerified || state.candidates.length < state.limits.maxCandidates) || reason === 'max_verifications' && state.verifications < state.limits.maxVerifications || reason === 'max_depth' && (!allVerified || !frontier.length || frontier.some(value => value.depth < state.limits.maxDepth)) || reason === 'exhausted' && (!allVerified || frontier.length > 0 || state.generations === 0)) throw new RunnerError('CANDIDATE_STATE_CONFLICT', '저장된 탐색 상태가 종료 이유를 뒷받침하지 않습니다.');
      state.status = 'succeeded'; state.result = { candidates: structuredClone(state.candidates), selected: selected ? structuredClone(selected) : null, stopReason: reason, counts: { candidates: state.candidates.length, verifications: state.verifications, generations: state.generations }, verifier: state.verifier };
    });
  }
  /** Failures retain all reservations. A cancelled/uncertain operation is not an empty successful generation. */
  stop(runId: string, nodeId: string, status: 'failed' | 'cancelled' | 'attention_required', error: { code: string; message: string }): void {
    this.transaction(() => { const state = this.get(runId, nodeId); if (state.status !== 'running') return; state.status = status; state.error = error; state.revision++; this.save(runId, nodeId, state, 'candidate.stopped'); });
  }
  /** Called only inside RunStore's startup recovery transaction; never dispatches a generation or refunds a reservation. */
  recoverInterrupted(runId: string): void {
    for (const row of this.db.prepare("SELECT node_instance_id,body FROM candidate_searches WHERE run_id=? AND status='running'").all(runId) as { node_instance_id: string; body: string }[]) {
      const state = JSON.parse(row.body) as CandidateSearchState; state.status = 'attention_required'; state.revision++; state.error = { code: 'RUN_INTERRUPTED', message: '중단된 후보 탐색을 자동 재실행하지 않았습니다.' };
      this.save(runId, row.node_instance_id.slice(runId.length + 1), state, 'candidate.interrupted');
    }
  }
}
