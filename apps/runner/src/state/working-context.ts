import type { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '@studio/package-kit';
import { assertJsonData, parseStrictJson, validateWorkflowShape } from '@studio/spec';
import { workingTaskContext } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';
import type { WorkingContextDraft } from '../context/working-context.js';
import { checkedWorkingContextManifest } from '../context/manifest-validation.js';

export const WORKING_CONTEXT_MIGRATION = `CREATE TABLE IF NOT EXISTS working_contexts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),node_instance_id TEXT NOT NULL REFERENCES node_instances(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),manifest TEXT NOT NULL,manifest_hash TEXT NOT NULL,request_hash TEXT NOT NULL,count_id TEXT UNIQUE,reservation_id TEXT UNIQUE REFERENCES reservations(id),count_state TEXT NOT NULL,generation_state TEXT NOT NULL,error_code TEXT,prepared_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS working_contexts_run ON working_contexts(run_id,prepared_at,id);`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface WorkingContextManifest extends WorkingContextDraft { requestHash: string; requestBytes: number; model: string; provider: 'openai' }
export interface WorkingContextRecord { id: string; manifest: WorkingContextManifest; manifestHash: string; countId: string | null; reservationId: string | null; countState: string; generationState: string; errorCode: string | null; preparedAt: string; updatedAt: string }
const now = () => new Date().toISOString();
const conflict = () => new RunnerError('WORK_CONTEXT_STATE_INVALID', '업무 문맥의 고정 실행 근거를 확인할 수 없습니다.');

/** Each manifest belongs to one actual attempt. Callback intent is durable evidence, not proof of external API acceptance. */
export class WorkingContextStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(work: () => T) => T, private readonly event: (runId: string, type: string, payload: unknown) => void) {}

  prepare(manifest: WorkingContextManifest): string {
    assertJsonData(manifest); const body = JSON.stringify(manifest), manifestHash = canonicalDigest(manifest);
    if (Buffer.byteLength(body, 'utf8') > 262144 || !Number.isSafeInteger(manifest.requestBytes) || manifest.requestBytes > manifest.maxBytes) throw new RunnerError('WORK_CONTEXT_SIZE_LIMIT', '업무 문맥 요청 또는 출처 기록의 크기 한도를 초과했습니다.');
    checkedWorkingContextManifest(manifest);
    return this.transaction(() => {
      this.verifyPinned(manifest, true);
      const existing = this.db.prepare('SELECT id,manifest_hash FROM working_contexts WHERE attempt_id=?').get(manifest.attemptId) as Row | undefined;
      if (existing) { if (existing.manifest_hash !== manifestHash) throw conflict(); return String(existing.id); }
      const id = `context_${canonicalDigest({ runId: manifest.runId, attemptId: manifest.attemptId })}`, timestamp = now();
      this.db.prepare("INSERT INTO working_contexts(id,run_id,node_instance_id,attempt_id,manifest,manifest_hash,request_hash,count_state,generation_state,prepared_at,updated_at) VALUES(?,?,?,?,?,?,?,'not_started','not_started',?,?)").run(id, manifest.runId, manifest.nodeInstanceId, manifest.attemptId, body, manifestHash, manifest.requestHash, timestamp, timestamp);
      this.event(manifest.runId, 'context.prepared', { contextId: id, nodeId: manifest.nodeId, attemptId: manifest.attemptId, manifestHash, requestHash: manifest.requestHash }); return id;
    });
  }

  /** Called within the existing count-intent transaction, before the provider can observe any request bytes. */
  linkCount(runId: string, nodeId: string, id: string, countId: string, requestHash: string): void {
    const row = this.db.prepare('SELECT * FROM working_contexts WHERE id=? AND run_id=?').get(id, runId) as Row | undefined;
    if (!row || row.node_instance_id !== `${runId}:${nodeId}` || row.request_hash !== requestHash || row.count_state !== 'not_started') throw conflict();
    this.db.prepare("UPDATE working_contexts SET count_id=?,count_state='invocation_intent',updated_at=? WHERE id=?").run(countId, now(), id);
  }

  /** Count completion and reservation links are committed by RunStore's existing transaction boundaries. */
  finishCount(runId: string, countId: string, code?: string): void { this.db.prepare('UPDATE working_contexts SET count_state=?,error_code=?,updated_at=? WHERE run_id=? AND count_id=?').run(code ? 'failed' : 'confirmed', code ?? null, now(), runId, countId); }
  linkReservation(runId: string, countId: string, reservationId: string, requestHash: string): void {
    const row = this.db.prepare('SELECT id,request_hash,count_state FROM working_contexts WHERE run_id=? AND count_id=?').get(runId, countId) as Row | undefined;
    if (!row) return; if (row.request_hash !== requestHash || row.count_state !== 'confirmed') throw conflict();
    this.db.prepare('UPDATE working_contexts SET reservation_id=?,updated_at=? WHERE id=?').run(reservationId, now(), String(row.id));
  }

  /** Persist intent and returned/unknown lifecycle evidence without conflating it with handler or business acceptance. */
  generation(id: string, state: 'invocation_intent' | 'response_confirmed' | 'not_started' | 'failed_confirmed' | 'unknown', code?: string): void {
    if (code !== undefined && !/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) throw conflict();
    this.transaction(() => {
      const row = this.db.prepare('SELECT run_id,reservation_id,generation_state FROM working_contexts WHERE id=?').get(id) as Row | undefined;
      if (!row || !row.reservation_id || (state === 'invocation_intent' ? row.generation_state !== 'not_started' : row.generation_state !== 'invocation_intent')) throw conflict();
      this.db.prepare('UPDATE working_contexts SET generation_state=?,error_code=?,updated_at=? WHERE id=?').run(state, code ?? null, now(), id);
      this.event(String(row.run_id), 'context.generation', { contextId: id, state, ...(code ? { code } : {}) });
    });
  }

  /** Startup marks in-flight disclosure as unknown; it never replays a model call or turns preparation into delivery. */
  recover(runId: string): void {
    const interrupted = this.db.prepare("SELECT id,count_state,generation_state FROM working_contexts WHERE run_id=? AND (count_state='invocation_intent' OR generation_state='invocation_intent')").all(runId) as Row[];
    this.db.prepare("UPDATE working_contexts SET count_state=CASE WHEN count_state='invocation_intent' THEN 'unknown' ELSE count_state END,generation_state=CASE WHEN generation_state='invocation_intent' THEN 'unknown' ELSE generation_state END,updated_at=? WHERE run_id=?").run(now(), runId);
    for (const row of interrupted) this.event(runId, 'context.recovered', { contextId: String(row.id), countState: row.count_state === 'invocation_intent' ? 'unknown' : row.count_state, generationState: row.generation_state === 'invocation_intent' ? 'unknown' : row.generation_state });
  }

  /** Return bounded, cross-checked metadata only; the service must authorize current run disclosure before calling. */
  list(runId: string): { records: WorkingContextRecord[]; total: number } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS total FROM working_contexts WHERE run_id=?').get(runId) as Row).total);
    const records: WorkingContextRecord[] = []; let returnedBytes = 0;
    // Iterate one bounded record at a time and cap the combined response; total still reports omitted records honestly.
    for (const raw of this.db.prepare('SELECT id,run_id,node_instance_id,attempt_id,CASE WHEN length(CAST(manifest AS BLOB))<=262144 THEN manifest ELSE NULL END AS manifest,manifest_hash,request_hash,count_id,reservation_id,count_state,generation_state,error_code,prepared_at,updated_at FROM working_contexts WHERE run_id=? ORDER BY prepared_at,id LIMIT 100').iterate(runId)) {
      const row = raw as Row; if (row.manifest === null) throw conflict(); const bytes = Buffer.byteLength(String(row.manifest), 'utf8') + 1024;
      if (returnedBytes + bytes > 524288) break;
      const manifest = checkedWorkingContextManifest(parseStrictJson(String(row.manifest)));
      if (canonicalDigest(manifest) !== row.manifest_hash || manifest.runId !== runId || manifest.requestHash !== row.request_hash || manifest.nodeInstanceId !== row.node_instance_id || manifest.attemptId !== row.attempt_id) throw conflict();
      this.verifyPinned(manifest, false); this.verifyModelEvidence(row, manifest);
      records.push({ id: String(row.id), manifest, manifestHash: String(row.manifest_hash), countId: row.count_id === null ? null : String(row.count_id), reservationId: row.reservation_id === null ? null : String(row.reservation_id), countState: String(row.count_state), generationState: String(row.generation_state), errorCode: row.error_code === null ? null : String(row.error_code), preparedAt: String(row.prepared_at), updatedAt: String(row.updated_at) }); returnedBytes += bytes;
    }
    return { records, total };
  }

  /** An assessment row cannot redefine its immutable plan, actual attempt, completed context or verified source inventory. */
  private verifyPinned(manifest: WorkingContextManifest, running: boolean): void {
    const run = this.db.prepare('SELECT r.plan_hash,r.cancel_requested,r.status,p.body FROM runs r JOIN plans p ON p.hash=r.plan_hash WHERE r.id=?').get(manifest.runId) as Row | undefined;
    const attempt = this.db.prepare('SELECT a.node_instance_id,a.status,n.run_id FROM attempts a JOIN node_instances n ON n.id=a.node_instance_id WHERE a.id=?').get(manifest.attemptId) as Row | undefined;
    const context = this.db.prepare('SELECT status,result FROM node_instances WHERE run_id=? AND node_id=?').get(manifest.runId, manifest.contextNodeId) as Row | undefined;
    if (!run || run.plan_hash !== manifest.planHash || running && (run.cancel_requested !== 0 || run.status !== 'running') || !attempt || running && attempt.status !== 'running' || attempt.node_instance_id !== manifest.nodeInstanceId || attempt.run_id !== manifest.runId || context?.status !== 'succeeded' || context.result === null || canonicalDigest(parseStrictJson(String(context.result))) !== manifest.contextResultHash) throw conflict();
    const plan = parseStrictJson(String(run.body)) as Record<string, unknown>;
    if (canonicalDigest(plan) !== manifest.planHash || !plan || typeof plan !== 'object') throw conflict();
    const checked = validateWorkflowShape(plan.workflow); if (!checked.valid) throw conflict();
    const workflow = checked.value, definition = workflow.workDefinition, binding = definition?.harness.workingContext?.bindings.find(value => value.nodeId === manifest.nodeId), node = workflow.nodes.find(value => value.id === manifest.nodeId);
    if (!definition || !binding || binding.contextNodeId !== manifest.contextNodeId || manifest.nodeInstanceId !== `${manifest.runId}:${manifest.nodeId}` || definition.harness.workingContext!.maxBytes !== manifest.maxBytes || canonicalDigest(definition) !== manifest.workDefinitionHash || canonicalDigest(workingTaskContext(workflow)) !== manifest.businessTaskHash || canonicalDigest(plan.workingContextAssets) !== canonicalDigest(manifest.assets) || !node || node.type !== 'ai' && node.type !== 'agent') throw conflict();
    const profiles = plan.modelProfiles as Record<string, { provider?: unknown; model?: unknown }> | undefined; const profile = profiles?.[node.config.modelProfile];
    if (profile?.provider !== manifest.provider || profile?.model !== manifest.model) throw conflict();
  }

  /** Count/reservation journal links are independent records; matching only a self-computed manifest hash is insufficient. */
  private verifyModelEvidence(row: Row, manifest: WorkingContextManifest): void {
    const event = (type: string, key: string, value: string) => this.db.prepare('SELECT sequence,payload FROM events WHERE run_id=? AND type=? AND json_extract(payload,?)=? ORDER BY sequence DESC LIMIT 1').get(manifest.runId, type, `$.${key}`, value) as Row | undefined;
    const prepared = event('context.prepared', 'contextId', String(row.id));
    if (!prepared || (parseStrictJson(String(prepared.payload)) as Record<string, unknown>).manifestHash !== row.manifest_hash || !['not_started', 'invocation_intent', 'confirmed', 'failed', 'unknown'].includes(String(row.count_state)) || !['not_started', 'invocation_intent', 'response_confirmed', 'failed_confirmed', 'unknown'].includes(String(row.generation_state))) throw conflict();
    if (!row.count_id) { if (row.count_state !== 'not_started' || row.reservation_id || row.generation_state !== 'not_started') throw conflict(); return; }
    const requested = event('model.count_requested', 'countId', String(row.count_id)); const counted = event('model.counted', 'countId', String(row.count_id));
    if (!requested) throw conflict(); const payload = parseStrictJson(String(requested.payload)) as Record<string, unknown>;
    if (payload.requestHash !== manifest.requestHash || payload.nodeId !== manifest.nodeId || payload.workingContextId !== row.id || row.count_state === 'not_started' || row.count_state === 'confirmed' && !counted || row.count_state === 'failed' && !event('model.count_failed', 'countId', String(row.count_id))) throw conflict();
    if (row.count_state === 'confirmed') { const confirmation = parseStrictJson(String(counted!.payload)) as Record<string, unknown>; if (confirmation.countId !== row.count_id || !Number.isSafeInteger(confirmation.inputTokens) || Number(confirmation.inputTokens) < 0) throw conflict(); }
    const generation = event('context.generation', 'contextId', String(row.id));
    const generationState = generation ? (parseStrictJson(String(generation.payload)) as Record<string, unknown>).state : 'not_started';
    if (generationState !== row.generation_state) {
      // Only an explicit later crash-recovery event can downgrade an in-flight intent to unknown. No recovery can confirm it.
      const recovery = event('context.recovered', 'contextId', String(row.id));
      if (row.generation_state !== 'unknown' || generationState !== 'invocation_intent' || !recovery || Number(recovery.sequence) <= Number(generation?.sequence ?? 0) || (parseStrictJson(String(recovery.payload)) as Record<string, unknown>).generationState !== 'unknown') throw conflict();
    }
    if (!row.reservation_id) { if (row.generation_state !== 'not_started') throw conflict(); return; }
    const reservation = this.db.prepare('SELECT run_id,node_instance_id,status FROM reservations WHERE id=?').get(String(row.reservation_id)) as Row | undefined;
    const reserved = event('model.reserved', 'reservationId', String(row.reservation_id)); if (!reservation || !reserved) throw conflict();
    const evidence = (parseStrictJson(String(reserved.payload)) as { count?: { countId?: unknown; requestHash?: unknown } }).count;
    if (reservation.run_id !== manifest.runId || reservation.node_instance_id !== manifest.nodeInstanceId || evidence?.countId !== row.count_id || evidence.requestHash !== manifest.requestHash || row.count_state !== 'confirmed' || row.generation_state === 'response_confirmed' && reservation.status !== 'settled') throw conflict();
  }
}
