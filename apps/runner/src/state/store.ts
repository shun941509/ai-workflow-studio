import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RunnerError } from '../errors.js';
import { parseStrictJson, validateJsonValue, type WorkflowEdge, type FlowDefinition, type FileRef, type RunOutcome } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import type { ControlEdgeState, ControlOutcome } from '@studio/workflow-core';
import { applyRunMemory, MEMORY_MIGRATION, type MemoryRequest, type MemoryResult } from './run-memory.js';
import { CandidateSearchStore, CANDIDATE_SEARCH_MIGRATION } from './candidate-search-state.js';
import type { DisclosureSnapshot, DisclosureState } from '../provenance/run-disclosure.js';
import { AgenticStore, AGENTIC_MIGRATION } from './agentic-state.js';
import { RUN_OUTCOME_MIGRATION, initializeRunOutcome, readRunOutcome, finalizeRunOutcome } from './run-outcomes.js';
import { WorkingContextStore, WORKING_CONTEXT_MIGRATION } from './working-context.js';

export type RunStatus = 'created' | 'running' | 'waiting' | 'cancelling' | 'attention_required' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export interface ModelProfile { id: string; name: string; provider: 'openai'; model: string; credentialRef: string; kind?: 'chat' | 'embedding' | 'reranker' }
export interface ModelCountEvidence { countId: string; requestHash: string; inputTokens: number; maxOutputTokens: number }
/** Embedding measurement is local/conservative evidence, never a remote Responses token count. */
export interface EmbeddingReservationEvidence { requestHash: string; contractHash: string; localTokens: number; reservedTokens: number; inputCount: number; tokenizerFingerprint: string; reservationRule: string }
export interface RunRecord {
  id: string; requestId: string; packageHandle: string; status: RunStatus; createdAt: string; updatedAt: string;
  cancelRequested: boolean; error: { code: string; message: string } | null; result: unknown;
  outcome: RunOutcome | null;
  activeMs: number;
  usage: { modelCalls: number; consumedTokens: number; reservedTokens: number };
}
export interface PackageRecord { handle: string; filename: string; sha256: string; name: string; createdAt: string }
export interface ArtifactRecord { reference: FileRef; source: 'user_upload' | 'node_output'; operationId: string; waitId: string | null }
export interface EdgeRecord { edgeId: string; state: ControlEdgeState; outcome?: ControlOutcome }
export interface NodeRecord { nodeId: string; status: string; result: unknown }
export interface ChildScopeRecord { id: string; runId: string; parentScopeId: string; ownerNodeId: string; key: string; flowId: string; depth: number; status: string; input: unknown; result: unknown; error: { code: string; message: string } | null }
/** Storage keys isolate duplicate local node/edge IDs without allowing workflow data to select a scope. */
export function scopedKey(scopeId: string, localId: string): string { return scopeId === 'main' ? localId : `${scopeId}/${localId}`; }
export interface WaitRecord {
  id: string; runId: string; nodeId: string; nodeInstanceId: string; planHash: string; requestId: string;
  kind: 'input' | 'review' | 'files'; title: string; responseSchema: unknown; context: unknown;
  state: 'pending' | 'responded' | 'consumed' | 'cancelled' | 'expired'; createdAt: string; expiresAt: string;
  responseRequestId: string | null; response: unknown; decision: 'accepted' | 'rejected' | null; respondedAt: string | null;
}

// Every state transition and its event commit together. SQL values are always bound parameters.
const MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daemon_lease(id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, pid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS packages(handle TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider='openai'), model TEXT NOT NULL, credential_ref TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans(hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, package_handle TEXT NOT NULL REFERENCES packages(handle),
 plan_hash TEXT NOT NULL REFERENCES plans(hash), status TEXT NOT NULL, inputs TEXT NOT NULL, model_bindings TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
 result TEXT, error TEXT, model_calls INTEGER NOT NULL DEFAULT 0, consumed_tokens INTEGER NOT NULL DEFAULT 0,
 reserved_tokens INTEGER NOT NULL DEFAULT 0, max_model_calls INTEGER NOT NULL, max_total_tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_instances(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, UNIQUE(run_id,node_id));
CREATE TABLE IF NOT EXISTS edge_instances(run_id TEXT NOT NULL REFERENCES runs(id), edge_id TEXT NOT NULL, source_node TEXT NOT NULL, target_node TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT, PRIMARY KEY(run_id,edge_id));
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, node_instance_id TEXT NOT NULL REFERENCES node_instances(id), status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_instance_id TEXT NOT NULL REFERENCES node_instances(id), tokens INTEGER NOT NULL, status TEXT NOT NULL, actual_tokens INTEGER);
CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,sequence));
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run_timing(run_id TEXT PRIMARY KEY REFERENCES runs(id),active_ms REAL NOT NULL DEFAULT 0,segment_started_at TEXT);
CREATE TABLE IF NOT EXISTS waits(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),node_instance_id TEXT NOT NULL UNIQUE REFERENCES node_instances(id),plan_hash TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),kind TEXT NOT NULL,title TEXT NOT NULL,response_schema TEXT NOT NULL,context TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,response_request_id TEXT,response TEXT,decision TEXT,responded_at TEXT);
CREATE TABLE IF NOT EXISTS wait_responses(request_id TEXT PRIMARY KEY,wait_id TEXT NOT NULL REFERENCES waits(id),request_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS child_scopes(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),parent_scope_id TEXT NOT NULL,owner_node_id TEXT NOT NULL,scope_key TEXT NOT NULL,flow_id TEXT NOT NULL,depth INTEGER NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,owner_node_id,scope_key));
CREATE TABLE IF NOT EXISTS node_claims(node_instance_id TEXT PRIMARY KEY REFERENCES node_instances(id),run_id TEXT NOT NULL REFERENCES runs(id));
CREATE INDEX IF NOT EXISTS node_claims_run ON node_claims(run_id);
CREATE INDEX IF NOT EXISTS child_scopes_run ON child_scopes(run_id,created_at,id);
CREATE TABLE IF NOT EXISTS artifact_metadata(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),operation_id TEXT NOT NULL,reference_json TEXT NOT NULL,source TEXT NOT NULL,wait_id TEXT REFERENCES waits(id));
${MEMORY_MIGRATION}
${CANDIDATE_SEARCH_MIGRATION}
${AGENTIC_MIGRATION}
${RUN_OUTCOME_MIGRATION}
${WORKING_CONTEXT_MIGRATION}
CREATE TABLE IF NOT EXISTS plan_proposals(node_instance_id TEXT PRIMARY KEY REFERENCES node_instances(id),run_id TEXT NOT NULL REFERENCES runs(id),plan_hash TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_disclosure(run_id TEXT PRIMARY KEY REFERENCES runs(id),version INTEGER NOT NULL CHECK(version=1),state TEXT NOT NULL CHECK(state IN ('unobserved','pinned','blocked')),snapshot TEXT,code TEXT);
`;

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const now = () => new Date().toISOString();

/** SQLite owns durable execution truth; transport and handler code never write SQL directly. */
export class RunStore {
  private readonly db: DatabaseSync;
  readonly candidateSearch: CandidateSearchStore;
  readonly agentic: AgenticStore;
  readonly workingContexts: WorkingContextStore;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const future = exists ? this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Row : undefined;
    if (Number(future?.version ?? 0) > 14) { this.db.close(); throw new RunnerError('STATE_VERSION_UNSUPPORTED', '이 실행 기록에는 더 새로운 Runner가 필요합니다.'); }
    // Additive migrations are atomic, and an older binary checks the version before changing schema tables.
    this.transaction(() => {
      this.db.exec(MIGRATION);
      // Existing profiles remain chat profiles; migrations never infer a new paid capability from a model name.
      if (!(this.db.prepare('PRAGMA table_info(profiles)').all() as Row[]).some(column => column.name === 'kind')) this.db.exec("ALTER TABLE profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','embedding'))");
      // SQLite cannot widen an existing column CHECK in place. Copy known fields atomically, preserving IDs and DPAPI references.
      if (Number(future?.version ?? 0) < 10) this.db.exec(`CREATE TABLE profiles_v10(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider='openai'),model TEXT NOT NULL,credential_ref TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','embedding','reranker'))); INSERT INTO profiles_v10 SELECT id,name,provider,model,credential_ref,kind FROM profiles; DROP TABLE profiles; ALTER TABLE profiles_v10 RENAME TO profiles;`);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(14,?)').run(now());
      this.db.exec("INSERT OR IGNORE INTO run_timing(run_id) SELECT id FROM runs; INSERT OR IGNORE INTO node_claims(node_instance_id,run_id) SELECT id,run_id FROM node_instances WHERE status NOT IN ('pending','skipped')");
    });
    this.candidateSearch = new CandidateSearchStore(this.db, work => this.transaction(work), (runId, type, payload) => this.event(runId, type, payload));
    this.agentic = new AgenticStore(this.db, work => this.transaction(work), (runId, type, payload) => this.event(runId, type, payload));
    this.workingContexts = new WorkingContextStore(this.db, work => this.transaction(work), (runId, type, payload) => this.event(runId, type, payload));
  }

  close(): void { this.db.close(); }

  /** SQLite serializes lease claims, allowing recovery without a lock-file deletion race. */
  claimDaemon(instanceId: string, pid: number): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT pid FROM daemon_lease WHERE id=1').get() as Row | undefined;
      if (current) {
        let alive = true;
        try { process.kill(Number(current.pid), 0); }
        catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new RunnerError('DAEMON_LOCKED', 'Studio Runner가 이미 실행 중입니다.');
      }
      this.db.prepare('INSERT INTO daemon_lease(id,instance_id,pid) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id,pid=excluded.pid').run(instanceId, pid);
    });
  }

  releaseDaemon(instanceId: string): void { this.db.prepare('DELETE FROM daemon_lease WHERE id=1 AND instance_id=?').run(instanceId); }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private event(runId: string, type: string, payload: unknown): void {
    this.db.prepare('INSERT INTO events(run_id,sequence,type,payload,created_at) SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,? FROM events WHERE run_id=?')
      .run(runId, type, JSON.stringify(payload), now(), runId);
  }

  savePackage(record: PackageRecord): void {
    this.db.prepare('INSERT INTO packages VALUES(?,?,?,?,?)').run(record.handle, record.filename, record.sha256, record.name, record.createdAt);
  }

  getPackage(handle: string): PackageRecord {
    const row = this.db.prepare('SELECT * FROM packages WHERE handle=?').get(handle) as Row | undefined;
    if (!row) throw new RunnerError('PACKAGE_NOT_FOUND', '가져온 패키지를 찾을 수 없습니다.', 404);
    return { handle: String(row.handle), filename: String(row.filename), sha256: String(row.sha256), name: String(row.name), createdAt: String(row.created_at) };
  }

  listPackages(): PackageRecord[] {
    return (this.db.prepare('SELECT handle FROM packages ORDER BY created_at DESC').all() as Row[]).map((row) => this.getPackage(String(row.handle)));
  }

  saveProfile(profile: ModelProfile): void {
    this.db.prepare('INSERT INTO profiles(id,name,provider,model,credential_ref,kind) VALUES(?,?,?,?,?,?)').run(profile.id, profile.name, profile.provider, profile.model, profile.credentialRef, profile.kind ?? 'chat');
  }

  getProfile(id: string): ModelProfile {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new RunnerError('MODEL_PROFILE_REQUIRED', '모델 연결을 선택하세요.');
    return { id: String(row.id), name: String(row.name), provider: 'openai', model: String(row.model), credentialRef: String(row.credential_ref), ...(row.kind === 'embedding' || row.kind === 'reranker' ? { kind: row.kind } : {}) };
  }

  listProfiles(): ModelProfile[] {
    return (this.db.prepare('SELECT id FROM profiles ORDER BY name').all() as Row[]).map((row) => this.getProfile(String(row.id)));
  }

  /** Missing rows remain legacy; migration never invents an authorization history for an old RAG result. */
  getDisclosureState(runId: string): DisclosureState {
    this.getRun(runId); const row = this.db.prepare('SELECT version,state,snapshot,code FROM run_disclosure WHERE run_id=?').get(runId) as Row | undefined;
    if (!row) return { state: 'legacy' };
    if (row.version !== 1) throw new RunnerError('RAG_DISCLOSURE_UNAVAILABLE', '자료 공개 기록 버전을 확인할 수 없습니다.');
    if (row.state === 'unobserved' && row.snapshot === null && row.code === null) return { state: 'unobserved' };
    if (row.state === 'blocked' && typeof row.code === 'string' && row.code.startsWith('RAG_DISCLOSURE_')) return { state: 'blocked', code: row.code };
    if (row.state === 'pinned' && typeof row.snapshot === 'string' && row.snapshot.length < 2000) {
      try {
        const snapshot = parseStrictJson(row.snapshot) as unknown as DisclosureSnapshot;
        if (snapshot && snapshot.authority === 'run-rag-v1' && snapshot.scope?.projectId === runId && typeof snapshot.scope.tenantId === 'string' && typeof snapshot.subjectId === 'string' && Number.isSafeInteger(snapshot.epoch) && snapshot.epoch > 0 && /^[a-f0-9]{64}$/.test(snapshot.aclHash)) return { state: 'pinned', snapshot };
      } catch { /* Corrupt persisted metadata is a denial, never a fresh unobserved run. */ }
    }
    throw new RunnerError('RAG_DISCLOSURE_UNAVAILABLE', '자료 공개 기록의 형식을 확인할 수 없습니다.');
  }

  requiresRagDisclosure(runId: string): boolean {
    const plan = this.getExecution(runId).plan as { workflow?: { nodes?: { type?: string; config?: { strategy?: string } }[]; subworkflows?: Record<string, { nodes?: { type?: string; config?: { strategy?: string } }[] }> } };
    return [plan.workflow, ...Object.values(plan.workflow?.subworkflows ?? {})].some(flow => flow?.nodes?.some(node => node.type === 'knowledge' || node.type === 'retrieval' || node.type === 'agent' && node.config?.strategy === 'agentic_rag'));
  }

  /** A first observation can only seal a newly created run. Concurrent first observers must agree exactly. */
  pinDisclosure(runId: string, snapshot: DisclosureSnapshot): void {
    this.transaction(() => {
      const state = this.getDisclosureState(runId);
      if (state.state === 'pinned' && canonicalDigest(state.snapshot) === canonicalDigest(snapshot)) return;
      if (state.state !== 'unobserved' || snapshot.scope.projectId !== runId) throw new RunnerError('RAG_DISCLOSURE_STATE_REQUIRED', '자료 공개 기준을 새로 고정할 수 없습니다. 새 실행이 필요합니다.');
      this.db.prepare("UPDATE run_disclosure SET state='pinned',snapshot=? WHERE run_id=? AND state='unobserved'").run(JSON.stringify(snapshot), runId);
      this.event(runId, 'rag.disclosure_pinned', { epoch: snapshot.epoch, snapshotHash: canonicalDigest(snapshot) });
    });
  }

  blockDisclosure(runId: string, code: string): void {
    if (!/^RAG_DISCLOSURE_[A-Z_]+$/.test(code)) throw new RunnerError('RAG_DISCLOSURE_UNAVAILABLE', '자료 공개 오류가 올바르지 않습니다.');
    this.transaction(() => {
      this.getRun(runId); const old = this.db.prepare('SELECT state FROM run_disclosure WHERE run_id=?').get(runId);
      if (old?.state === 'blocked') return;
      this.db.prepare("INSERT INTO run_disclosure(run_id,version,state,code) VALUES(?,1,'blocked',?) ON CONFLICT(run_id) DO UPDATE SET state='blocked',code=excluded.code").run(runId, code);
      this.event(runId, 'rag.disclosure_blocked', { code });
    });
  }

  /** Rank audit contains IDs, hashes and numeric stages only; source text, query and credentials never enter these events. */
  recordRerank(runId: string, nodeId: string, evidence: { status: 'reranked' | 'fallback' | 'skipped_empty' | 'failed'; fingerprint: string; inventoryHash: string; failureCode?: string; ranks: { id: string; before: number; after: number | null; score?: number }[] }): void {
    if (evidence.ranks.length > 20 || !/^[a-f0-9]{64}$/.test(evidence.fingerprint) || !/^[a-f0-9]{64}$/.test(evidence.inventoryHash) || Buffer.byteLength(JSON.stringify(evidence)) > 32768) throw new RunnerError('RERANK_AUDIT_INVALID', '재순위 기록이 고정 한도를 벗어났습니다.');
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM node_instances WHERE run_id=? AND node_id=?').get(runId, nodeId)) throw new RunnerError('NODE_NOT_FOUND', '재순위 실행 노드를 찾을 수 없습니다.');
      this.event(runId, 'rag.rerank', { nodeId, ...evidence });
    });
  }

  /** Request identity includes the complete normalized request; same ID/different content is rejected. */
  findRequest(requestId: string, requestHash: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT id,request_hash FROM runs WHERE request_id=?').get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new RunnerError('REQUEST_CONFLICT', '같은 요청 ID에 다른 실행 내용이 전달되었습니다.', 409);
    return this.getRun(String(row.id));
  }

  /** Recovery discloses only the accepted run ID. It must not load inputs, model bindings or RAG results. */
  findRequestRunId(requestId: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM runs WHERE request_id=?').get(requestId) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  createRun(input: { requestId: string; requestHash: string; packageHandle: string; planHash: string; plan: unknown; inputs: unknown; modelBindings: Record<string, string>; nodeIds: string[]; edges?: readonly WorkflowEdge[]; maxModelCalls: number; maxTotalTokens: number }): RunRecord {
    return this.transaction(() => {
      const previous = this.findRequest(input.requestId, input.requestHash);
      if (previous) return previous;
      const id = `run_${randomUUID()}`;
      const date = now();
      this.db.prepare('INSERT OR IGNORE INTO plans(hash,body) VALUES(?,?)').run(input.planHash, JSON.stringify(input.plan));
      this.db.prepare('INSERT INTO runs(id,request_id,request_hash,package_handle,plan_hash,status,inputs,model_bindings,created_at,updated_at,max_model_calls,max_total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.requestId, input.requestHash, input.packageHandle, input.planHash, 'created', JSON.stringify(input.inputs), JSON.stringify(input.modelBindings), date, date, input.maxModelCalls, input.maxTotalTokens);
      const insert = this.db.prepare('INSERT INTO node_instances(id,run_id,node_id,status) VALUES(?,?,?,?)');
      for (const nodeId of input.nodeIds) insert.run(`${id}:${nodeId}`, id, nodeId, 'pending');
      const insertEdge = this.db.prepare('INSERT INTO edge_instances(run_id,edge_id,source_node,target_node,state) VALUES(?,?,?,?,?)');
      for (const edge of input.edges ?? []) insertEdge.run(id, edge.id, edge.from.nodeId, edge.to.nodeId, 'pending');
      this.db.prepare('INSERT INTO run_timing(run_id) VALUES(?)').run(id);
      this.event(id, 'run.created', { planHash: input.planHash });
      this.db.prepare("INSERT INTO run_disclosure(run_id,version,state) VALUES(?,1,'unobserved')").run(id);
      initializeRunOutcome(this.db, id, input.plan, input.planHash);
      return this.getRun(id);
    });
  }

  getRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new RunnerError('RUN_NOT_FOUND', '실행 기록을 찾을 수 없습니다.', 404);
    return {
      id: String(row.id), requestId: String(row.request_id), packageHandle: String(row.package_handle), status: row.status as RunStatus,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), cancelRequested: row.cancel_requested === 1,
      error: row.error ? JSON.parse(String(row.error)) : null, result: row.result ? JSON.parse(String(row.result)) : null,
      outcome: readRunOutcome(this.db, id, { planHash: String(row.plan_hash), status: String(row.status), result: row.result ? JSON.parse(String(row.result)) : null }),
      activeMs: Number((this.db.prepare('SELECT active_ms FROM run_timing WHERE run_id=?').get(id) as Row | undefined)?.active_ms ?? 0),
      usage: { modelCalls: Number(row.model_calls), consumedTokens: Number(row.consumed_tokens), reservedTokens: Number(row.reserved_tokens) },
    };
  }

  listRuns(limit = 50): RunRecord[] {
    return (this.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))) as Row[]).map((row) => this.getRun(String(row.id)));
  }

  /** Only service-created IDs are read; inputs and plans never include credentials. */
  getExecution(id: string): { inputs: unknown; modelBindings: Record<string, string>; plan: unknown; planHash: string } {
    const row = this.db.prepare('SELECT r.inputs,r.model_bindings,r.plan_hash,p.body FROM runs r JOIN plans p ON p.hash=r.plan_hash WHERE r.id=?').get(id) as Row | undefined;
    if (!row) throw new RunnerError('RUN_NOT_FOUND', '실행 기록을 찾을 수 없습니다.', 404);
    return { inputs: JSON.parse(String(row.inputs)), modelBindings: JSON.parse(String(row.model_bindings)), plan: JSON.parse(String(row.body)), planHash: String(row.plan_hash) };
  }

  transitionRun(id: string, status: RunStatus, detail?: { error?: { code: string; message: string }; result?: unknown }): void {
    this.transaction(() => {
      const previous = this.getRun(id);
      const allowed: Partial<Record<RunStatus, RunStatus[]>> = {
        created: ['running', 'cancelling', 'attention_required', 'failed'],
        running: ['succeeded', 'failed', 'blocked', 'cancelling', 'cancelled', 'waiting', 'attention_required'],
        waiting: ['running', 'cancelling', 'cancelled', 'blocked', 'failed', 'attention_required'],
        cancelling: ['cancelled', 'attention_required', 'failed'],
      };
      if (!allowed[previous.status]?.includes(status)) throw new RunnerError('INVALID_STATE_TRANSITION', '완료된 실행을 다시 시작하거나 잘못된 상태로 바꿀 수 없습니다.');
      this.db.prepare('UPDATE runs SET status=?,updated_at=?,error=?,result=? WHERE id=?')
        .run(status, now(), detail?.error ? JSON.stringify(detail.error) : null, detail && 'result' in detail ? JSON.stringify(detail.result) : null, id);
      this.event(id, `run.${status}`, detail?.error ? { error: detail.error } : {});
      finalizeRunOutcome(this.db, id, (type, payload) => this.event(id, type, payload));
    });
  }

  transitionNode(runId: string, nodeId: string, status: string, result?: unknown): void {
    this.transaction(() => {
      const changed = this.db.prepare('UPDATE node_instances SET status=?,result=? WHERE run_id=? AND node_id=?').run(status, result === undefined ? null : JSON.stringify(result), runId, nodeId);
      if (Number(changed.changes) !== 1) throw new RunnerError('NODE_NOT_FOUND', '실행 노드를 찾을 수 없습니다.');
      this.event(runId, 'node.status', { nodeId, status });
    });
  }

  graphState(runId: string, scopeId = 'main'): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    this.getRun(runId);
    const prefix = scopeId === 'main' ? '' : `${scopeId}/`;
    const nodeRows = scopeId === 'main' ? this.db.prepare("SELECT node_id,status,result FROM node_instances WHERE run_id=? AND instr(node_id,'/')=0 ORDER BY node_id").all(runId) : this.db.prepare('SELECT node_id,status,result FROM node_instances WHERE run_id=? AND substr(node_id,1,?)=? ORDER BY node_id').all(runId, prefix.length, prefix);
    const edgeRows = scopeId === 'main' ? this.db.prepare("SELECT edge_id,state,outcome FROM edge_instances WHERE run_id=? AND instr(edge_id,'/')=0 ORDER BY edge_id").all(runId) : this.db.prepare('SELECT edge_id,state,outcome FROM edge_instances WHERE run_id=? AND substr(edge_id,1,?)=? ORDER BY edge_id').all(runId, prefix.length, prefix);
    const nodes = (nodeRows as Row[]).map((row) => ({ nodeId: String(row.node_id).slice(prefix.length), status: String(row.status), result: row.result === null ? null : JSON.parse(String(row.result)) }));
    const edges = (edgeRows as Row[]).map((row) => ({ edgeId: String(row.edge_id).slice(prefix.length), state: row.state as ControlEdgeState, ...(row.outcome ? { outcome: row.outcome as ControlOutcome } : {}) }));
    return { nodes, edges };
  }

  /** One root-run budget covers every real node instance, including nested scopes and repeated iterations. */
  claimNode(runId: string, nodeId: string, maxNodeInstances: number): void {
    this.transaction(() => {
      if (this.getRun(runId).cancelRequested) throw new RunnerError('RUN_CANCELLED', '실행 취소가 요청되었습니다.');
      const id = `${runId}:${nodeId}`;
      if (this.db.prepare('SELECT node_instance_id FROM node_claims WHERE node_instance_id=?').get(id)) return;
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM node_claims WHERE run_id=?').get(runId) as Row;
      if (Number(count.count) >= maxNodeInstances) throw new RunnerError('BUDGET_EXCEEDED', '하위 작업을 포함한 최대 노드 실행 수를 초과했습니다.');
      this.db.prepare('INSERT INTO node_claims(node_instance_id,run_id) VALUES(?,?)').run(id, runId);
    });
  }

  createChildScope(input: { runId: string; parentScopeId: string; ownerNodeId: string; key: string; flowId: string; depth: number; flow: FlowDefinition; input: unknown }): ChildScopeRecord & { fresh: boolean } {
    return this.transaction(() => {
      const inputHash = canonicalDigest({ flowId: input.flowId, input: input.input });
      const prior = this.db.prepare('SELECT id,input_hash FROM child_scopes WHERE run_id=? AND owner_node_id=? AND scope_key=?').get(input.runId, input.ownerNodeId, input.key) as Row | undefined;
      if (prior) { if (prior.input_hash !== inputHash) throw new RunnerError('CHILD_SCOPE_CONFLICT', '같은 하위 실행 키에 다른 입력이 전달되었습니다.'); return { ...this.getChildScope(String(prior.id)), fresh: false }; }
      const id = `scope_${randomUUID().replaceAll('-', '')}`; const date = now();
      this.db.prepare('INSERT INTO child_scopes(id,run_id,parent_scope_id,owner_node_id,scope_key,flow_id,depth,status,input,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.runId, input.parentScopeId, input.ownerNodeId, input.key, input.flowId, input.depth, 'running', JSON.stringify(input.input), inputHash, date, date);
      for (const node of input.flow.nodes) { const key = scopedKey(id, node.id); this.db.prepare('INSERT INTO node_instances(id,run_id,node_id,status) VALUES(?,?,?,?)').run(`${input.runId}:${key}`, input.runId, key, 'pending'); }
      for (const edge of input.flow.edges) this.db.prepare('INSERT INTO edge_instances(run_id,edge_id,source_node,target_node,state) VALUES(?,?,?,?,?)').run(input.runId, scopedKey(id, edge.id), scopedKey(id, edge.from.nodeId), scopedKey(id, edge.to.nodeId), 'pending');
      this.event(input.runId, 'scope.started', { scopeId: id, parentScopeId: input.parentScopeId, ownerNodeId: input.ownerNodeId, key: input.key, flowId: input.flowId, depth: input.depth }); return { ...this.getChildScope(id), fresh: true };
    });
  }

  getChildScope(id: string): ChildScopeRecord {
    const row = this.db.prepare('SELECT * FROM child_scopes WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new RunnerError('CHILD_SCOPE_NOT_FOUND', '하위 실행 기록을 찾을 수 없습니다.');
    return { id: String(row.id), runId: String(row.run_id), parentScopeId: String(row.parent_scope_id), ownerNodeId: String(row.owner_node_id), key: String(row.scope_key), flowId: String(row.flow_id), depth: Number(row.depth), status: String(row.status), input: JSON.parse(String(row.input)), result: row.result === null ? null : JSON.parse(String(row.result)), error: row.error === null ? null : JSON.parse(String(row.error)) };
  }

  listChildScopes(runId: string): ChildScopeRecord[] { return (this.db.prepare('SELECT id FROM child_scopes WHERE run_id=? ORDER BY created_at,id').all(runId) as Row[]).map((row) => this.getChildScope(String(row.id))); }

  /** Bytes commit first; this idempotent transaction publishes their immutable reference and audit event together. */
  registerArtifact(runId: string, record: ArtifactRecord): void {
    this.transaction(() => {
      this.getRun(runId); const previous = this.db.prepare('SELECT run_id FROM artifacts WHERE id=?').get(record.reference.id) as Row | undefined;
      if (previous) { if (previous.run_id !== runId || canonicalDigest(this.getArtifact(runId, record.reference.id)) !== canonicalDigest(record)) throw new RunnerError('ARTIFACT_OPERATION_CONFLICT', '파일 등록 정보가 기존 작업과 다릅니다.'); return; }
      this.db.prepare('INSERT INTO artifacts(id,run_id,relative_path,sha256,bytes) VALUES(?,?,?,?,?)').run(record.reference.id, runId, record.reference.relativePath, record.reference.sha256, record.reference.bytes);
      this.db.prepare('INSERT INTO artifact_metadata(artifact_id,operation_id,reference_json,source,wait_id) VALUES(?,?,?,?,?)').run(record.reference.id, record.operationId, JSON.stringify(record.reference), record.source, record.waitId);
      this.event(runId, 'artifact.registered', { fileId: record.reference.id, filename: record.reference.filename, bytes: record.reference.bytes, source: record.source, waitId: record.waitId });
    });
  }

  getArtifact(runId: string, fileId: string): ArtifactRecord {
    const row = this.db.prepare('SELECT m.* FROM artifacts a JOIN artifact_metadata m ON m.artifact_id=a.id WHERE a.run_id=? AND a.id=?').get(runId, fileId) as Row | undefined;
    if (!row) throw new RunnerError('ARTIFACT_NOT_FOUND', '이 실행에 등록된 파일이 아닙니다.', 404);
    return { reference: JSON.parse(String(row.reference_json)) as FileRef, source: row.source as ArtifactRecord['source'], operationId: String(row.operation_id), waitId: row.wait_id === null ? null : String(row.wait_id) };
  }

  listArtifacts(runId: string): ArtifactRecord[] { return (this.db.prepare('SELECT id FROM artifacts WHERE run_id=? ORDER BY rowid').all(runId) as Row[]).map((row) => this.getArtifact(runId, String(row.id))); }

  /** Memory is always rooted in the authenticated run; local child scopes share it without expanding access. */
  runMemory(runId: string, request: MemoryRequest): MemoryResult {
    return this.transaction(() => { const run = this.getRun(runId); return applyRunMemory(this.db, runId, request, run.status === 'running' && !run.cancelRequested, (type, payload) => this.event(runId, type, payload)); });
  }

  /** Validated proposals are immutable data, never replacements for the active plan or authorization to dispatch tasks. */
  savePlanProposal<T>(runId: string, nodeId: string, tasks: T[]): { revision: 1; planHash: string; tasks: T[] } {
    return this.transaction(() => {
      const planHash = canonicalDigest({ revision: 1, tasks }); const nodeInstanceId = `${runId}:${nodeId}`;
      const previous = this.db.prepare('SELECT plan_hash FROM plan_proposals WHERE node_instance_id=? AND run_id=?').get(nodeInstanceId, runId) as Row | undefined;
      if (previous) { if (previous.plan_hash !== planHash) throw new RunnerError('PLAN_PROPOSAL_CONFLICT', '고정된 계획 제안을 다른 내용으로 바꿀 수 없습니다.'); return { revision: 1, planHash, tasks }; }
      const run = this.getRun(runId); if (run.status !== 'running' || run.cancelRequested) throw new RunnerError('RUN_CANCELLED', '실행이 종료되어 계획 제안을 저장할 수 없습니다.');
      this.db.prepare('INSERT INTO plan_proposals(node_instance_id,run_id,plan_hash,body,created_at) VALUES(?,?,?,?,?)').run(nodeInstanceId, runId, planHash, JSON.stringify(tasks), now());
      this.event(runId, 'orchestrator.planned', { nodeId, revision: 1, planHash, taskCount: tasks.length, dispatched: false }); return { revision: 1, planHash, tasks };
    });
  }

  listPlanProposals(runId: string): { nodeInstanceId: string; planHash: string; tasks: unknown; createdAt: string }[] {
    return (this.db.prepare('SELECT * FROM plan_proposals WHERE run_id=? ORDER BY created_at,node_instance_id').all(runId) as Row[]).map((row) => ({ nodeInstanceId: String(row.node_instance_id), planHash: String(row.plan_hash), tasks: JSON.parse(String(row.body)), createdAt: String(row.created_at) }));
  }

  /** Polling metadata never loads large child inputs or results; durable events retain the full execution sequence. */
  childScopeSummary(runId: string): { scopes: Omit<ChildScopeRecord, 'input' | 'result'>[]; total: number } {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM child_scopes WHERE run_id=?').get(runId) as Row;
    const rows = this.db.prepare('SELECT id,run_id,parent_scope_id,owner_node_id,scope_key,flow_id,depth,status,error FROM child_scopes WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(runId) as Row[];
    return { total: Number(count.count), scopes: rows.reverse().map((row) => ({ id: String(row.id), runId: String(row.run_id), parentScopeId: String(row.parent_scope_id), ownerNodeId: String(row.owner_node_id), key: String(row.scope_key), flowId: String(row.flow_id), depth: Number(row.depth), status: String(row.status), error: row.error === null ? null : JSON.parse(String(row.error)) })) };
  }

  finishChildScope(id: string, status: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'attention_required', result?: unknown, error?: { code: string; message: string }): void {
    this.transaction(() => {
      const scope = this.getChildScope(id);
      if (scope.status !== 'running') throw new RunnerError('CHILD_SCOPE_TERMINAL', '종료된 하위 실행의 결과를 바꿀 수 없습니다.');
      this.db.prepare('UPDATE child_scopes SET status=?,result=?,error=?,updated_at=? WHERE id=?').run(status, result === undefined ? null : JSON.stringify(result), error ? JSON.stringify(error) : null, now(), id);
      if (status !== 'succeeded') this.db.prepare("UPDATE node_instances SET status=? WHERE run_id=? AND substr(node_id,1,?)=? AND status IN ('pending','ready','retry_wait','waiting_children')").run(status === 'cancelled' ? 'cancelled' : 'blocked', scope.runId, id.length + 1, `${id}/`);
      this.event(scope.runId, 'scope.finished', { scopeId: id, status, ...(error ? { error } : {}) });
    });
  }

  /** Node completion, chosen edges, skipped branches and their events form one durable scheduling decision. */
  completeGraphStep(runId: string, completion: { nodeId: string; status: 'succeeded' | 'handled_error'; result?: unknown; waitId?: string }, edges: EdgeRecord[], skipped: string[]): void {
    this.transaction(() => {
      if (completion.waitId) {
        const wait = this.getWait(completion.waitId);
        if (wait.runId !== runId || wait.nodeId !== completion.nodeId || wait.state !== 'responded' || this.getRun(runId).status !== 'waiting') throw new RunnerError('WAIT_NOT_PENDING', '응답을 적용할 수 없는 대기 상태입니다.', 409);
        this.db.prepare("UPDATE waits SET state='consumed' WHERE id=?").run(wait.id);
        this.db.prepare("UPDATE attempts SET status='succeeded',ended_at=? WHERE id=(SELECT attempt_id FROM waits WHERE id=?) AND status='waiting'").run(now(), wait.id);
        this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(now(), runId);
        this.event(runId, 'wait.consumed', { waitId: wait.id, nodeId: wait.nodeId }); this.event(runId, 'attempt.finished', { waitId: wait.id, nodeId: wait.nodeId, status: 'succeeded' }); this.event(runId, 'run.running', {});
      }
      this.db.prepare('UPDATE node_instances SET status=?,result=? WHERE run_id=? AND node_id=?').run(completion.status, completion.result === undefined ? null : JSON.stringify(completion.result), runId, completion.nodeId);
      this.event(runId, 'node.status', { nodeId: completion.nodeId, status: completion.status });
      for (const edge of edges) {
        const changed = this.db.prepare("UPDATE edge_instances SET state=?,outcome=? WHERE run_id=? AND edge_id=? AND state='pending'").run(edge.state, edge.outcome ?? null, runId, edge.edgeId);
        if (Number(changed.changes) !== 1) throw new RunnerError('CONTROL_STATE_CONFLICT', '이미 결정한 실행 연결을 변경할 수 없습니다.');
        this.event(runId, 'edge.status', edge);
      }
      for (const nodeId of skipped) {
        const changed = this.db.prepare("UPDATE node_instances SET status='skipped' WHERE run_id=? AND node_id=? AND status='pending'").run(runId, nodeId);
        if (Number(changed.changes) !== 1) throw new RunnerError('CONTROL_STATE_CONFLICT', '진행한 노드를 건너뛴 상태로 변경할 수 없습니다.');
        this.event(runId, 'node.status', { nodeId, status: 'skipped' });
      }
    });
  }

  /** A protected run stop leaves every unexecuted active candidate terminal, so no join can resume it. */
  stopPendingNodes(runId: string, status: 'blocked' | 'cancelled'): void {
    this.transaction(() => {
      const pending = this.db.prepare("SELECT node_id FROM node_instances WHERE run_id=? AND status IN ('pending','ready','retry_wait','waiting_children')").all(runId) as Row[];
      for (const row of pending) { const nodeId = String(row.node_id); this.db.prepare('UPDATE node_instances SET status=? WHERE run_id=? AND node_id=?').run(status, runId, nodeId); this.event(runId, 'node.status', { nodeId, status }); }
    });
  }

  beginAttempt(runId: string, nodeId: string): string {
    const id = `attempt_${randomUUID()}`;
    this.transaction(() => {
      this.db.prepare('INSERT INTO attempts(id,node_instance_id,status,started_at) VALUES(?,?,?,?)').run(id, `${runId}:${nodeId}`, 'running', now());
      this.event(runId, 'attempt.started', { nodeId, attemptId: id });
    });
    return id;
  }

  finishAttempt(runId: string, attemptId: string, status: string, error?: { code: string; message: string }): void {
    this.transaction(() => {
      this.db.prepare('UPDATE attempts SET status=?,ended_at=?,error=? WHERE id=?').run(status, now(), error ? JSON.stringify(error) : null, attemptId);
      this.event(runId, 'attempt.finished', { attemptId, status, ...(error ? { error } : {}) });
    });
  }

  requestCancel(id: string): RunRecord {
    this.transaction(() => {
      const run = this.getRun(id);
      if (!['created', 'running', 'waiting'].includes(run.status)) return;
      if (run.status === 'waiting') {
        this.db.prepare("UPDATE waits SET state='cancelled' WHERE run_id=? AND state IN ('pending','responded')").run(id);
        this.db.prepare("UPDATE node_instances SET status='cancelled' WHERE run_id=? AND status IN ('pending','ready','waiting_input','waiting_review','waiting_files')").run(id);
        this.db.prepare("UPDATE attempts SET status='cancelled',ended_at=? WHERE status='waiting' AND node_instance_id IN (SELECT id FROM node_instances WHERE run_id=?)").run(now(), id);
        this.db.prepare("UPDATE runs SET cancel_requested=1,status='cancelled',updated_at=? WHERE id=?").run(now(), id); this.event(id, 'run.cancelled', {});
        finalizeRunOutcome(this.db, id, (type, payload) => this.event(id, type, payload)); return;
      }
      this.db.prepare('UPDATE runs SET cancel_requested=1,status=?,updated_at=? WHERE id=?').run('cancelling', now(), id);
      this.event(id, 'run.cancel_requested', {});
    });
    return this.getRun(id);
  }

  /** Active time is checkpointed between nodes; waiting periods never start an active segment. */
  beginActiveSegment(runId: string): void { this.db.prepare('UPDATE run_timing SET segment_started_at=? WHERE run_id=?').run(now(), runId); }
  checkpointActiveTime(runId: string, elapsedMs: number, stop = false): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RunnerError('INVALID_TIME_ACCOUNTING', '활성 실행 시간 기록이 올바르지 않습니다.');
    this.db.prepare('UPDATE run_timing SET active_ms=active_ms+?,segment_started_at=? WHERE run_id=?').run(elapsedMs, stop ? null : now(), runId);
  }

  createWait(input: { runId: string; nodeId: string; attemptId: string; kind: 'input' | 'review' | 'files'; title: string; schema: unknown; context: unknown; ttlMs: number; activeMs: number }): WaitRecord {
    return this.transaction(() => {
      const run = this.getRun(input.runId); if (run.status !== 'running' || run.cancelRequested) throw new RunnerError('RUN_CANCELLED', '실행이 취소되어 대기할 수 없습니다.');
      const execution = this.getExecution(input.runId); const id = `wait_${randomUUID()}`; const createdAt = now(); const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      this.db.prepare('INSERT INTO waits(id,run_id,node_instance_id,plan_hash,request_id,attempt_id,kind,title,response_schema,context,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.runId, `${input.runId}:${input.nodeId}`, execution.planHash, run.requestId, input.attemptId, input.kind, input.title, JSON.stringify(input.schema), JSON.stringify(input.context), 'pending', createdAt, expiresAt);
      const nodeStatus = input.kind === 'review' ? 'waiting_review' : input.kind === 'files' ? 'waiting_files' : 'waiting_input';
      this.db.prepare('UPDATE node_instances SET status=? WHERE run_id=? AND node_id=?').run(nodeStatus, input.runId, input.nodeId);
      this.db.prepare("UPDATE attempts SET status='waiting' WHERE id=?").run(input.attemptId);
      this.db.prepare("UPDATE runs SET status='waiting',updated_at=? WHERE id=?").run(createdAt, input.runId);
      this.checkpointActiveTime(input.runId, input.activeMs, true);
      this.event(input.runId, 'node.status', { nodeId: input.nodeId, status: nodeStatus }); this.event(input.runId, 'wait.created', { waitId: id, nodeId: input.nodeId, kind: input.kind, expiresAt }); this.event(input.runId, 'run.waiting', {});
      return this.getWait(id);
    });
  }

  getWait(id: string): WaitRecord {
    const row = this.db.prepare('SELECT w.*,n.node_id FROM waits w JOIN node_instances n ON n.id=w.node_instance_id WHERE w.id=?').get(id) as Row | undefined;
    if (!row) throw new RunnerError('WAIT_NOT_FOUND', '사용자 응답 대기를 찾을 수 없습니다.', 404);
    return { id: String(row.id), runId: String(row.run_id), nodeId: String(row.node_id), nodeInstanceId: String(row.node_instance_id), planHash: String(row.plan_hash), requestId: String(row.request_id), kind: row.kind as WaitRecord['kind'], title: String(row.title), responseSchema: JSON.parse(String(row.response_schema)), context: JSON.parse(String(row.context)), state: row.state as WaitRecord['state'], createdAt: String(row.created_at), expiresAt: String(row.expires_at), responseRequestId: row.response_request_id ? String(row.response_request_id) : null, response: row.response === null ? null : JSON.parse(String(row.response)), decision: row.decision as WaitRecord['decision'], respondedAt: row.responded_at ? String(row.responded_at) : null };
  }

  listWaits(runId?: string): WaitRecord[] {
    const rows = runId ? this.db.prepare('SELECT id FROM waits WHERE run_id=? ORDER BY created_at').all(runId) : this.db.prepare("SELECT id FROM waits WHERE state IN ('pending','responded') ORDER BY created_at").all();
    return (rows as Row[]).map((row) => this.getWait(String(row.id)));
  }

  /** Response identities are global and atomically accepted; caller-supplied actor/approval identities do not exist. */
  acceptWaitResponse(runId: string, waitId: string, requestId: string, response: unknown, decision?: 'accepted' | 'rejected'): WaitRecord {
    this.expireWait(waitId);
    return this.transaction(() => {
      const wait = this.getWait(waitId); if (wait.runId !== runId) throw new RunnerError('WAIT_SCOPE_DENIED', '이 실행에 속한 응답 대기가 아닙니다.', 403);
      const requestHash = canonicalDigest({ runId, waitId, response, ...(decision ? { decision } : {}) });
      const prior = this.db.prepare('SELECT wait_id,request_hash FROM wait_responses WHERE request_id=?').get(requestId) as Row | undefined;
      if (prior) { if (prior.wait_id !== waitId || prior.request_hash !== requestHash) throw new RunnerError('RESPONSE_CONFLICT', '같은 응답 ID에 다른 내용이 전달되었습니다.', 409); return wait; }
      if (wait.state !== 'pending' || this.getRun(runId).status !== 'waiting') throw new RunnerError(wait.state === 'expired' ? 'WAIT_EXPIRED' : 'WAIT_NOT_PENDING', '이미 종료되거나 처리한 대기에는 응답할 수 없습니다.', 409);
      if (wait.kind === 'review' ? !['accepted', 'rejected'].includes(decision ?? '') : decision !== undefined) throw new RunnerError('REVIEW_DECISION_INVALID', '검토 결정은 수락 또는 거절이어야 하며 일반 입력에는 결정을 포함하지 않습니다.');
      if (!validateJsonValue(wait.responseSchema, response).valid) throw new RunnerError('WAIT_RESPONSE_INVALID', '응답이 요청한 입력 형식과 일치하지 않습니다.');
      if (Date.parse(wait.expiresAt) <= Date.now()) throw new RunnerError('WAIT_EXPIRED', '사용자 응답 대기 시간이 만료되었습니다.', 409);
      const date = now(); this.db.prepare('INSERT INTO wait_responses(request_id,wait_id,request_hash,created_at) VALUES(?,?,?,?)').run(requestId, waitId, requestHash, date);
      this.db.prepare("UPDATE waits SET state='responded',response_request_id=?,response=?,decision=?,responded_at=? WHERE id=?").run(requestId, JSON.stringify(response), decision ?? null, date, waitId);
      this.event(runId, 'wait.responded', { waitId, responseRequestId: requestId, actor: 'local-user', ...(decision ? { decision } : {}) }); return this.getWait(waitId);
    });
  }

  /** Expiration is terminal and cannot authorize a default answer or choose a review branch. */
  expireWait(waitId: string): boolean {
    return this.transaction(() => {
      const wait = this.getWait(waitId); if (wait.state !== 'pending' || Date.parse(wait.expiresAt) > Date.now()) return false;
      const error = { code: 'WAIT_EXPIRED', message: '사용자 응답 대기 시간이 만료되었습니다.' };
      this.db.prepare("UPDATE waits SET state='expired' WHERE id=?").run(waitId);
      this.db.prepare("UPDATE runs SET status='failed',error=?,updated_at=? WHERE id=? AND status='waiting'").run(JSON.stringify(error), now(), wait.runId);
      this.db.prepare("UPDATE node_instances SET status=CASE WHEN node_id=? THEN 'failed' ELSE 'blocked' END WHERE run_id=? AND status IN ('pending','ready','waiting_input','waiting_review','waiting_files')").run(wait.nodeId, wait.runId);
      this.db.prepare("UPDATE attempts SET status='failed',ended_at=?,error=? WHERE id=(SELECT attempt_id FROM waits WHERE id=?) AND status='waiting'").run(now(), JSON.stringify(error), waitId);
      this.event(wait.runId, 'wait.expired', { waitId }); this.event(wait.runId, 'run.failed', { error });
      finalizeRunOutcome(this.db, wait.runId, (type, payload) => this.event(wait.runId, type, payload)); return true;
    });
  }

  /** Counting also discloses the payload externally. Check known budgets/cancellation and journal that intent before sending. */
  beginModelCount(runId: string, nodeId: string, requestHash: string, maxOutputTokens: number, workingContextId?: string): string {
    if (!/^[a-f0-9]{64}$/.test(requestHash) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new RunnerError('INVALID_BUDGET', '입력 토큰 확인 요청이 올바르지 않습니다.');
    return this.transaction(() => {
      const run = this.getRun(runId); const row = this.db.prepare('SELECT max_model_calls,max_total_tokens FROM runs WHERE id=?').get(runId) as Row;
      if (run.cancelRequested) throw new RunnerError('RUN_CANCELLED', '실행 취소가 요청되었습니다.');
      if (run.usage.modelCalls >= Number(row.max_model_calls) || run.usage.consumedTokens + run.usage.reservedTokens + maxOutputTokens > Number(row.max_total_tokens)) throw new RunnerError('BUDGET_EXCEEDED', '알려진 모델 호출·출력 토큰 한도가 부족해 입력을 전송하지 않았습니다.');
      const countId = `count_${randomUUID()}`;
      if (workingContextId) this.workingContexts.linkCount(runId, nodeId, workingContextId, countId, requestHash);
      this.event(runId, 'model.count_requested', { countId, nodeId, requestHash, maxOutputTokens, ...(workingContextId ? { workingContextId } : {}) }); return countId;
    });
  }

  /** Counting outcomes contain only hashes/counts/error codes; submitted content and credentials are never journaled. */
  finishModelCount(runId: string, countId: string, outcome: { inputTokens: number } | { code: string }): void {
    if (!/^count_[a-f0-9-]{36}$/.test(countId) || 'inputTokens' in outcome && (!Number.isSafeInteger(outcome.inputTokens) || outcome.inputTokens < 0) || 'code' in outcome && !/^[A-Z][A-Z0-9_]{0,99}$/.test(outcome.code)) throw new RunnerError('INVALID_USAGE', '입력 토큰 확인 결과가 올바르지 않습니다.');
    this.transaction(() => { this.getRun(runId); this.workingContexts.finishCount(runId, countId, 'code' in outcome ? outcome.code : undefined); this.event(runId, 'inputTokens' in outcome ? 'model.counted' : 'model.count_failed', { countId, ...outcome }); });
  }

  /** BEGIN IMMEDIATE prevents concurrent reservations from spending the same counted input/output budget. */
  reserveModel(runId: string, nodeId: string, tokens: number, evidence?: ModelCountEvidence, embedding?: EmbeddingReservationEvidence): string {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new RunnerError('INVALID_BUDGET', '모델 사용량 예약이 올바르지 않습니다.');
    if (evidence && (!/^[a-f0-9]{64}$/.test(evidence.requestHash) || !/^count_[a-f0-9-]{36}$/.test(evidence.countId) || !Number.isSafeInteger(evidence.inputTokens) || evidence.inputTokens < 0 || !Number.isSafeInteger(evidence.maxOutputTokens) || evidence.maxOutputTokens < 1 || evidence.inputTokens + evidence.maxOutputTokens !== tokens)) throw new RunnerError('INVALID_BUDGET', '확인한 입력 토큰과 출력 한도가 예약량과 일치하지 않습니다.');
    if (embedding && (evidence || embedding.reservedTokens !== tokens || [embedding.localTokens, embedding.inputCount].some(value => !Number.isSafeInteger(value) || value < 1) || [embedding.requestHash, embedding.contractHash, embedding.tokenizerFingerprint].some(value => !/^[a-f0-9]{64}$/.test(value)) || embedding.reservationRule !== 'max-local-bpe-utf8-bytes-plus64-per-input-v1')) throw new RunnerError('INVALID_BUDGET', '임베딩의 로컬 측정과 예약 증거가 일치하지 않습니다.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Row | undefined;
      if (!row) throw new RunnerError('RUN_NOT_FOUND', '실행 기록을 찾을 수 없습니다.', 404);
      if (row.cancel_requested === 1) throw new RunnerError('RUN_CANCELLED', '실행 취소가 요청되었습니다.');
      if (Number(row.model_calls) + 1 > Number(row.max_model_calls) || Number(row.consumed_tokens) + Number(row.reserved_tokens) + tokens > Number(row.max_total_tokens)) {
        throw new RunnerError('BUDGET_EXCEEDED', '프로젝트의 모델 호출 또는 토큰 한도를 초과합니다.');
      }
      const id = `reservation_${randomUUID()}`;
      this.db.prepare('INSERT INTO reservations(id,run_id,node_instance_id,tokens,status) VALUES(?,?,?,?,?)').run(id, runId, `${runId}:${nodeId}`, tokens, 'reserved');
      this.db.prepare('UPDATE runs SET model_calls=model_calls+1,reserved_tokens=reserved_tokens+? WHERE id=?').run(tokens, runId);
      if (evidence) this.workingContexts.linkReservation(runId, evidence.countId, id, evidence.requestHash);
      this.event(runId, 'model.reserved', { reservationId: id, tokens, ...(evidence ? { count: evidence } : {}), ...(embedding ? { embedding } : {}) });
      return id;
    });
  }

  settleReservation(id: string, actualTokens: number | null, count?: { requestHash: string; expectedInputTokens: number; actualInputTokens: number; maxOutputTokens: number; actualOutputTokens: number }): { overrun: boolean; inputUndercount: boolean; outputOverrun: boolean } | null {
    if (count && (!/^[a-f0-9]{64}$/.test(count.requestHash) || [count.expectedInputTokens, count.actualInputTokens, count.maxOutputTokens, count.actualOutputTokens].some(value => !Number.isSafeInteger(value) || value < 0))) throw new RunnerError('INVALID_USAGE', '토큰 비교 기록이 올바르지 않습니다.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id) as Row | undefined;
      if (!row || row.status !== 'reserved') return null;
      const runId = String(row.run_id);
      const overrun = actualTokens !== null && actualTokens > Number(row.tokens);
      const inputUndercount = count !== undefined && count.actualInputTokens > count.expectedInputTokens;
      const outputOverrun = count !== undefined && count.actualOutputTokens > count.maxOutputTokens;
      if (actualTokens === null) {
        this.db.prepare('UPDATE reservations SET status=? WHERE id=?').run('unknown', id);
      } else {
        if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) throw new RunnerError('INVALID_USAGE', '모델 사용량이 올바르지 않습니다.');
        const current = this.getRun(runId);
        if (!Number.isSafeInteger(current.usage.consumedTokens + actualTokens)) throw new RunnerError('INVALID_USAGE', '누적 모델 사용량이 정수 범위를 초과합니다.');
        this.db.prepare('UPDATE reservations SET status=?,actual_tokens=? WHERE id=?').run('settled', actualTokens, id);
        this.db.prepare('UPDATE runs SET reserved_tokens=reserved_tokens-?,consumed_tokens=consumed_tokens+? WHERE id=?').run(Number(row.tokens), actualTokens, runId);
      }
      this.event(runId, 'model.usage', { reservationId: id, actualTokens, status: actualTokens === null ? 'unknown' : 'settled' });
      if (overrun || outputOverrun || count && count.expectedInputTokens !== count.actualInputTokens) this.event(runId, 'model.usage_mismatch', { reservationId: id, reservedTokens: Number(row.tokens), actualTokens, overrun, inputUndercount, outputOverrun, ...(count ?? {}) });
      return { overrun, inputUndercount, outputOverrun };
    });
  }

  listEvents(runId: string, after = 0, limit = 100): { sequence: number; type: string; payload: unknown; createdAt: string }[] {
    this.getRun(runId);
    return (this.db.prepare('SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(runId, Math.max(0, after), Math.max(1, Math.min(limit, 500))) as Row[])
      .map((row) => ({ sequence: Number(row.sequence), type: String(row.type), payload: JSON.parse(String(row.payload)), createdAt: String(row.created_at) }));
  }

  /** Startup never replays interrupted model calls; confirmed results remain available for inspection. */
  recoverInterruptedRuns(): number {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM runs WHERE status IN ('created','running','cancelling')").all() as Row[];
      const error = { code: 'RUN_INTERRUPTED', message: 'Runner가 중단되었습니다. 중복 호출을 막기 위해 자동 재실행하지 않았습니다.' };
      for (const row of rows) {
        const runId = String(row.id);
        this.candidateSearch.recoverInterrupted(runId);
        this.agentic.recoverInterrupted(runId);
        this.workingContexts.recover(runId);
        const timing = this.db.prepare('SELECT segment_started_at FROM run_timing WHERE run_id=?').get(runId) as Row | undefined;
        if (timing?.segment_started_at) this.checkpointActiveTime(runId, Math.max(0, Date.now() - Date.parse(String(timing.segment_started_at))), true);
        this.db.prepare('UPDATE runs SET status=?,error=?,updated_at=? WHERE id=?').run('attention_required', JSON.stringify(error), now(), runId);
        this.db.prepare("UPDATE node_instances SET status='reconciling' WHERE run_id=? AND status IN ('running','waiting_children')").run(runId);
        this.db.prepare("UPDATE child_scopes SET status='attention_required',error=?,updated_at=? WHERE run_id=? AND status='running'").run(JSON.stringify(error), now(), runId);
        this.db.prepare("UPDATE attempts SET status='interrupted',ended_at=? WHERE node_instance_id IN (SELECT id FROM node_instances WHERE run_id=?) AND status='running'").run(now(), runId);
        this.db.prepare("UPDATE reservations SET status='unknown' WHERE run_id=? AND status='reserved'").run(runId);
        this.event(runId, 'run.recovered', { status: 'attention_required', error });
      }
      return rows.length;
    });
  }
}
