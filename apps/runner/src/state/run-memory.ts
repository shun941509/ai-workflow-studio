import type { DatabaseSync } from 'node:sqlite';
import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { RunnerError } from '../errors.js';

export interface MemoryRequest { operationId: string; operation: 'get' | 'put' | 'delete'; key: string; value?: unknown; ttlMs?: number }
export interface MemoryResult { scope: 'run'; key: string; operation: MemoryRequest['operation']; found: boolean; value: unknown; version: number; expiresAt: string | null; lastCommit: { sequence: number; operationId: string; operation: 'put' | 'delete' | 'expire'; at: string } | null }
export const MEMORY_MIGRATION = `
CREATE TABLE IF NOT EXISTS run_memory(run_id TEXT NOT NULL REFERENCES runs(id),key TEXT NOT NULL,value_json TEXT,version INTEGER NOT NULL,expires_at INTEGER,last_commit TEXT NOT NULL,PRIMARY KEY(run_id,key));
CREATE TABLE IF NOT EXISTS memory_operations(run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(run_id,operation_id));
`;
const MAX_VALUE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024, MAX_KEYS = 1000;
type Row = { value_json: string | null; version: number; expires_at: number | null; last_commit: string };

/** Bounds apply to live values and idempotent snapshots together, preventing repeated reads from growing an unlimited ledger. */
export function validateMemoryRequest(input: MemoryRequest): void {
  try { assertJsonData(input); } catch { throw new RunnerError('MEMORY_INPUT_INVALID', '기억 입력은 유효한 일반 JSON이어야 합니다.'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.operationId) || !['get', 'put', 'delete'].includes(input.operation)) throw new RunnerError('MEMORY_OPERATION_INVALID', '기억 작업 식별자가 올바르지 않습니다.');
  if (typeof input.key !== 'string' || !input.key.length || input.key.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.key)) throw new RunnerError('MEMORY_KEY_INVALID', '기억 키는 제어문자를 제외한 1~256자 문자열이어야 합니다.');
  if (input.ttlMs !== undefined && (input.operation !== 'put' || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 2592000000)) throw new RunnerError('MEMORY_TTL_INVALID', 'TTL은 저장 작업에서만 1밀리초~30일로 지정할 수 있습니다.');
  if (input.operation === 'put') { if (!Object.hasOwn(input, 'value')) throw new RunnerError('MEMORY_VALUE_REQUIRED', '저장할 값을 명시하세요.'); assertJsonData(input.value); if (Buffer.byteLength(JSON.stringify(input.value), 'utf8') > MAX_VALUE_BYTES) throw new RunnerError('MEMORY_QUOTA_EXCEEDED', '기억 값은 1 MiB 이하이어야 합니다.'); }
}

/** Called only inside RunStore's BEGIN IMMEDIATE transaction; value, version, event and replay ledger commit together. */
export function applyRunMemory(db: DatabaseSync, runId: string, input: MemoryRequest, running: boolean, event: (type: string, payload: unknown) => void): MemoryResult {
  validateMemoryRequest(input); const requestHash = canonicalDigest(input);
  const previous = db.prepare('SELECT request_hash,result_json FROM memory_operations WHERE run_id=? AND operation_id=?').get(runId, input.operationId) as { request_hash: string; result_json: string } | undefined;
  if (previous) { if (previous.request_hash !== requestHash) throw new RunnerError('MEMORY_OPERATION_CONFLICT', '같은 기억 작업에 다른 입력을 전달할 수 없습니다.'); return JSON.parse(previous.result_json) as MemoryResult; }
  if (!running) throw new RunnerError('MEMORY_RUN_INACTIVE', '진행 중인 실행에서만 새 기억 작업을 할 수 있습니다.');
  let row = db.prepare('SELECT value_json,version,expires_at,last_commit FROM run_memory WHERE run_id=? AND key=?').get(runId, input.key) as Row | undefined;
  const commit = (operation: 'put' | 'delete' | 'expire', value: string | null, expires: number | null) => {
    const version = Number(row?.version ?? 0) + 1; const at = new Date().toISOString();
    event(`memory.${operation}`, { key: input.key, operationId: input.operationId, version, ...(expires === null ? {} : { expiresAt: new Date(expires).toISOString() }) });
    const sequence = Number((db.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE run_id=?').get(runId) as { sequence: number }).sequence);
    const lastCommit = { sequence, operationId: input.operationId, operation, at };
    db.prepare('INSERT INTO run_memory(run_id,key,value_json,version,expires_at,last_commit) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,expires_at=excluded.expires_at,last_commit=excluded.last_commit').run(runId, input.key, value, version, expires, JSON.stringify(lastCommit));
    row = { value_json: value, version, expires_at: expires, last_commit: JSON.stringify(lastCommit) };
  };
  // Expiration is a committed tombstone. A new get cannot return stale data after the deadline.
  if (row?.value_json !== null && row?.expires_at !== null && row?.expires_at !== undefined && row.expires_at <= Date.now()) commit('expire', null, null);
  if (input.operation === 'put') commit('put', JSON.stringify(input.value), input.ttlMs === undefined ? null : Date.now() + input.ttlMs);
  else if (input.operation === 'delete') commit('delete', null, null);
  else event('memory.get', { key: input.key, operationId: input.operationId, found: row?.value_json !== null && row !== undefined, version: Number(row?.version ?? 0) });
  const result: MemoryResult = { scope: 'run', key: input.key, operation: input.operation, found: row !== undefined && row.value_json !== null, value: row?.value_json == null ? null : JSON.parse(row.value_json), version: Number(row?.version ?? 0), expiresAt: row?.expires_at == null ? null : new Date(row.expires_at).toISOString(), lastCommit: row ? JSON.parse(row.last_commit) : null };
  const encoded = JSON.stringify(result);
  db.prepare('INSERT INTO memory_operations(run_id,operation_id,request_hash,result_json) VALUES(?,?,?,?)').run(runId, input.operationId, requestHash, encoded);
  const quota = db.prepare('SELECT (SELECT COUNT(*) FROM run_memory WHERE run_id=?) AS keys, (SELECT COALESCE(SUM(LENGTH(CAST(value_json AS BLOB))),0) FROM run_memory WHERE run_id=?)+(SELECT COALESCE(SUM(LENGTH(CAST(result_json AS BLOB))),0) FROM memory_operations WHERE run_id=?) AS bytes').get(runId, runId, runId) as { keys: number; bytes: number };
  if (quota.keys > MAX_KEYS || quota.bytes > MAX_TOTAL_BYTES) throw new RunnerError('MEMORY_QUOTA_EXCEEDED', '실행의 기억 키 또는 값·중복 방지 기록 한도를 초과했습니다.');
  return result;
}
