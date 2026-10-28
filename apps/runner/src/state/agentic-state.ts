import type { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '@studio/package-kit';
import { parseStrictJson } from '@studio/spec';
import { agenticUsage, beginAgenticRound, reserveAgenticOperation, settleAgenticOperation, completeAgenticSession, type AgenticSession, type AgenticReservation } from '@studio/rag-core';
import type { AgenticEvidence } from '../agentic/contracts.js';
import { RunnerError } from '../errors.js';

export interface AgenticResult { status: 'answered' | 'insufficient_evidence' | 'conflicting_evidence'; result: unknown; citations: AgenticEvidence['citation'][]; stopReason: string; usage: ReturnType<typeof agenticUsage> }
export interface AgenticState {
  version: 1; revision: number; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'attention_required'; session: AgenticSession;
  evidence: AgenticEvidence[]; records: { operationId: string; requestHash: string; resultHash: string | null }[]; pending: string | null; result: AgenticResult | null; errorCode: string | null;
}
export const AGENTIC_MIGRATION = `CREATE TABLE IF NOT EXISTS agentic_sessions(node_instance_id TEXT PRIMARY KEY REFERENCES node_instances(id),run_id TEXT NOT NULL REFERENCES runs(id),request_hash TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL); CREATE INDEX IF NOT EXISTS agentic_run ON agentic_sessions(run_id);`;

/** All session transitions share the owning RunStore transaction. No handler can choose another database or reset a budget. */
export class AgenticStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(work: () => T) => T, private readonly event: (runId: string, type: string, payload: unknown) => void) {}
  private active(runId: string): void { const run = this.db.prepare('SELECT status,cancel_requested FROM runs WHERE id=?').get(runId); if (!run || run.cancel_requested) throw new RunnerError('RUN_CANCELLED', 'Agentic RAG 실행이 취소되었습니다.'); if (run.status !== 'running') throw new RunnerError('AGENTIC_NOT_RUNNING', '실행 중인 run에서만 검색을 진행할 수 있습니다.'); }
  get(runId: string, nodeId: string): AgenticState {
    const row = this.db.prepare('SELECT revision,body,body_hash FROM agentic_sessions WHERE run_id=? AND node_instance_id=?').get(runId, `${runId}:${nodeId}`);
    if (!row) throw new RunnerError('AGENTIC_STATE_MISSING', 'Agentic RAG 실행 기록이 없습니다.');
    try {
      if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 2 * 1024 * 1024) throw new Error('size'); const value = parseStrictJson(row.body) as unknown as AgenticState;
      if (value.version !== 1 || value.revision !== row.revision || canonicalDigest(value) !== row.body_hash || value.session.scope.projectId !== runId || !['running', 'succeeded', 'failed', 'cancelled', 'attention_required'].includes(value.status) || value.evidence.length > 100 || value.records.length > 32) throw new Error('state'); agenticUsage(value.session); return value;
    } catch { throw new RunnerError('AGENTIC_STATE_INVALID', 'Agentic RAG 기록의 버전·해시·범위를 확인하지 못했습니다.'); }
  }
  begin(runId: string, nodeId: string, requestHash: string, session: AgenticSession): AgenticState {
    return this.transaction(() => {
      this.active(runId); const old = this.db.prepare('SELECT request_hash FROM agentic_sessions WHERE run_id=? AND node_instance_id=?').get(runId, `${runId}:${nodeId}`);
      if (old) throw new RunnerError(old.request_hash === requestHash ? 'AGENTIC_REPLAY_FORBIDDEN' : 'AGENTIC_REQUEST_CONFLICT', '같은 에이전트 실행은 완료·실패·중단 여부와 관계없이 자동 재호출하지 않습니다.');
      agenticUsage(session); if (session.scope.projectId !== runId) throw new RunnerError('AGENTIC_SCOPE_DENIED', '현재 실행의 색인만 허용됩니다.');
      const state: AgenticState = { version: 1, revision: 1, status: 'running', session: structuredClone(session), evidence: [], records: [], pending: null, result: null, errorCode: null };
      this.db.prepare('INSERT INTO agentic_sessions VALUES(?,?,?,?,?,?)').run(`${runId}:${nodeId}`, runId, requestHash, state.revision, JSON.stringify(state), canonicalDigest(state)); this.event(runId, 'agentic.started', { nodeId, requestHash }); return state;
    });
  }
  private change(runId: string, nodeId: string, revision: number, event: string, change: (state: AgenticState) => void, stopping = false): AgenticState {
    return this.transaction(() => {
      if (!stopping) this.active(runId); const state = this.get(runId, nodeId); if (state.revision !== revision || state.status !== 'running') throw new RunnerError('AGENTIC_STATE_CONFLICT', '이미 변경되거나 종료된 에이전트 상태입니다.');
      change(state); state.revision++; const usage = agenticUsage(state.session); const body = JSON.stringify(state); if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new RunnerError('AGENTIC_STATE_LIMIT', '검색 근거 기록 한도를 초과했습니다.');
      const result = this.db.prepare('UPDATE agentic_sessions SET revision=?,body=?,body_hash=? WHERE run_id=? AND node_instance_id=? AND revision=?').run(state.revision, body, canonicalDigest(state), runId, `${runId}:${nodeId}`, revision);
      if (Number(result.changes) !== 1) throw new RunnerError('AGENTIC_STATE_CONFLICT', '에이전트 상태의 원자 갱신이 충돌했습니다.');
      // Events are metadata only: no raw question, query, evidence, answer, or provider body.
      this.event(runId, event, { nodeId, revision: state.revision, status: state.status, usage, pending: state.pending, errorCode: state.errorCode }); return state;
    });
  }
  round(runId: string, nodeId: string, revision: number) { return this.change(runId, nodeId, revision, 'agentic.round', state => { if (state.pending) throw new RunnerError('AGENTIC_PENDING', '미확인 작업을 먼저 확인해야 합니다.'); state.session = beginAgenticRound(state.session); }); }
  reserve(runId: string, nodeId: string, revision: number, request: AgenticReservation, requestHash: string) {
    return this.change(runId, nodeId, revision, 'agentic.reserved', state => {
      if (state.pending || state.records.some(record => record.operationId === request.operationId)) throw new RunnerError('AGENTIC_REPLAY_FORBIDDEN', '이미 예약한 작업을 다시 호출할 수 없습니다.');
      state.session = reserveAgenticOperation(state.session, request); state.pending = request.operationId; state.records.push({ operationId: request.operationId, requestHash, resultHash: null });
    });
  }
  settle(runId: string, nodeId: string, revision: number, operationId: string, chunks: number, tokens: number, resultHash: string, evidence: readonly AgenticEvidence[] = []) {
    return this.change(runId, nodeId, revision, 'agentic.settled', state => {
      if (state.pending !== operationId) throw new RunnerError('AGENTIC_STATE_CONFLICT', '예약한 단계와 완료 단계가 다릅니다.');
      state.session = settleAgenticOperation(state.session, operationId, { status: 'confirmed', actualChunks: chunks, actualContextTokens: tokens }); state.pending = null; state.records.find(record => record.operationId === operationId)!.resultHash = resultHash;
      for (const item of evidence) { const old = state.evidence.find(value => value.id === item.id); if (old && canonicalDigest(old) !== canonicalDigest(item)) throw new RunnerError('AGENTIC_EVIDENCE_CONFLICT', '같은 근거 ID가 다른 원문을 가리킵니다.'); if (!old) state.evidence.push(structuredClone(item)); }
    });
  }
  complete(runId: string, nodeId: string, revision: number, result: AgenticResult) { return this.change(runId, nodeId, revision, 'agentic.completed', state => { state.session = completeAgenticSession(state.session); state.status = 'succeeded'; state.result = result; }); }
  stop(runId: string, nodeId: string, revision: number, code: string, status: 'failed' | 'cancelled' | 'attention_required') {
    return this.change(runId, nodeId, revision, 'agentic.stopped', state => { if (state.pending && status === 'attention_required') state.session = settleAgenticOperation(state.session, state.pending, { status: 'unknown' }); state.status = status; state.errorCode = code; }, true);
  }
  /** Called inside RunStore startup recovery's existing transaction, never as a replay command. */
  recoverInterrupted(runId: string): void {
    const rows = this.db.prepare('SELECT node_instance_id FROM agentic_sessions WHERE run_id=?').all(runId);
    for (const row of rows) {
      const nodeId = String(row.node_instance_id).slice(runId.length + 1); const state = this.get(runId, nodeId); if (state.status !== 'running') continue;
      if (state.pending) state.session = settleAgenticOperation(state.session, state.pending, { status: 'unknown' });
      state.status = 'attention_required'; state.errorCode = 'RUN_INTERRUPTED'; state.revision++;
      this.db.prepare('UPDATE agentic_sessions SET revision=?,body=?,body_hash=? WHERE run_id=? AND node_instance_id=?').run(state.revision, JSON.stringify(state), canonicalDigest(state), runId, row.node_instance_id!);
      this.event(runId, 'agentic.recovered', { nodeId, revision: state.revision, status: state.status, pending: state.pending });
    }
  }
}
