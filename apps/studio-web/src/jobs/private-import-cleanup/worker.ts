import 'server-only';
import { createHash } from 'node:crypto';
import { assertJsonData } from '@studio/spec';

export const CLEANUP_LIMIT = 5;
export const CLEANUP_MAX_BYTES = 32 * 1024 * 1024;
export const CLEANUP_TOTAL_MS = 120000;
const PROCESS_MS = 100000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export type CleanupOutcome = 'deleted' | 'not_found' | 'retry';
export interface CleanupLease { jobId: string; importId: string; leaseId: string; bucket: 'authoring-imports'; path: string; expectedSha256: string; attempts: number }
export interface CleanupRepository {
  /** Only the privileged claim RPC can supply leases. No browser-selected bucket/path is accepted. */
  claim(limit: number, signal: AbortSignal): Promise<unknown>;
  openObject(path: string, signal: AbortSignal): Promise<Response>;
  removeObject(path: string, signal: AbortSignal): Promise<void>;
  finish(jobId: string, leaseId: string, outcome: CleanupOutcome, signal: AbortSignal): Promise<void>;
}
export interface CleanupJobResult { jobId: string; outcome: CleanupOutcome; storage: 'absent' | 'not_deleted' | 'unknown'; finalization: 'confirmed' | 'unconfirmed' | 'not_attempted'; code?: string }
export interface CleanupReport { status: 'completed' | 'retry_required' | 'attention_required' | 'claim_failed' | 'claim_invalid'; claimed: number | null; jobs: CleanupJobResult[]; code?: string }
export class CleanupError extends Error { constructor(readonly code: string) { super(code); this.name = 'CleanupError'; } }
const fixedError = (error: unknown, fallback: string) => error instanceof CleanupError ? error.code : fallback;

/** The SDK must honor abort, but racing the boundary also bounds this function when a broken transport does not settle.
 * A timed-out mutation is never treated as undone. Its lease/outcome is left retryable or explicitly unconfirmed. */
export async function withinCleanupDeadline<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new CleanupError('CLEANUP_DEADLINE');
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new CleanupError('CLEANUP_DEADLINE')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new CleanupError('CLEANUP_DEADLINE'); return operation(); }).then(
      value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(new CleanupError('CLEANUP_DEADLINE')); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** Validate the entire claim before any read/delete. Deleted accounts keep their original UUID path prefix. */
export function parseCleanupLeases(value: unknown, limit: number): readonly Readonly<CleanupLease>[] {
  try {
    assertJsonData(value); if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLEANUP_LIMIT || !Array.isArray(value) || value.length > limit) throw new Error();
    const keys = ['jobId', 'importId', 'leaseId', 'bucket', 'path', 'expectedSha256', 'attempts']; const jobs = new Set<string>(), imports = new Set<string>(), leases = new Set<string>();
    return Object.freeze(value.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw new Error();
      const item = row as Record<string, unknown>;
      if (![item.jobId, item.importId, item.leaseId].every(id => typeof id === 'string' && uuid.test(id)) || item.bucket !== 'authoring-imports' || typeof item.path !== 'string' || typeof item.expectedSha256 !== 'string' || !digest.test(item.expectedSha256) || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 1 || Number(item.attempts) > 2147483647) throw new Error();
      const parts = item.path.split('/'); if (parts.length !== 3 || !uuid.test(parts[0]!) || parts[1] !== item.importId || parts[2] !== `${item.expectedSha256}.zip`) throw new Error();
      if (jobs.has(String(item.jobId)) || imports.has(String(item.importId)) || leases.has(String(item.leaseId))) throw new Error(); jobs.add(String(item.jobId)); imports.add(String(item.importId)); leases.add(String(item.leaseId));
      return Object.freeze({ ...item }) as unknown as Readonly<CleanupLease>;
    }));
  } catch { throw new CleanupError('CLEANUP_LEASE_RECORD_INVALID'); }
}

function discard(response: Response): void { void response.body?.cancel().catch(() => undefined); }
/** Hash actual streamed bytes with a hard cap. No ZIP extraction, path traversal or header-only verification is involved. */
export async function verifyCleanupObject(response: Response, sha256: string, signal: AbortSignal): Promise<void> {
  if (response.status !== 200 || !response.body || response.redirected) { discard(response); throw new CleanupError('CLEANUP_OBJECT_UNAVAILABLE'); }
  const length = response.headers.get('content-length'), encoded = !!response.headers.get('content-encoding') && response.headers.get('content-encoding')!.toLowerCase().trim() !== 'identity';
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || !encoded && Number(length) > CLEANUP_MAX_BYTES)) { discard(response); throw new CleanupError('CLEANUP_OBJECT_SIZE'); }
  const reader = response.body.getReader(), hash = createHash('sha256'); let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) { const part = await withinCleanupDeadline(() => reader.read(), signal); if (part.done) break; if (!(part.value instanceof Uint8Array) || total + part.value.byteLength > CLEANUP_MAX_BYTES) throw new CleanupError('CLEANUP_OBJECT_SIZE'); total += part.value.byteLength; hash.update(part.value); }
    if (!total || length !== null && !encoded && Number(length) !== total) throw new CleanupError('CLEANUP_OBJECT_SIZE');
    if (hash.digest('hex') !== sha256) throw new CleanupError('CLEANUP_OBJECT_HASH');
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* A broken pending read remains cancelled; it cannot authorize a delete. */ } }
}

/** Process one bounded lease batch. Storage and PostgreSQL are separate systems; successful deletion is not a DB commit. */
export async function runPrivateImportCleanup(repository: CleanupRepository, options: { limit?: number; signal?: AbortSignal } = {}): Promise<CleanupReport> {
  const limit = options.limit ?? CLEANUP_LIMIT; if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLEANUP_LIMIT) throw new CleanupError('CLEANUP_LIMIT_INVALID');
  const total = new AbortController(), processing = new AbortController(); const totalTimer = setTimeout(() => total.abort(), CLEANUP_TOTAL_MS), processTimer = setTimeout(() => processing.abort(), PROCESS_MS);
  const totalSignal = options.signal ? AbortSignal.any([options.signal, total.signal]) : total.signal;
  const workSignal = AbortSignal.any([totalSignal, processing.signal]); const jobs: CleanupJobResult[] = [];
  try {
    let raw: unknown;
    try { raw = await withinCleanupDeadline(() => repository.claim(limit, workSignal), workSignal); }
    catch (error) { return { status: 'claim_failed', claimed: null, jobs, code: fixedError(error, 'CLEANUP_CLAIM_UNAVAILABLE') }; }
    let claimed: readonly Readonly<CleanupLease>[];
    try { claimed = parseCleanupLeases(raw, limit); }
    catch { return { status: 'claim_invalid', claimed: null, jobs, code: 'CLEANUP_LEASE_RECORD_INVALID' }; }
    for (const lease of claimed) {
      let outcome: CleanupOutcome = 'retry', storage: CleanupJobResult['storage'] = 'not_deleted', code: string | undefined, removeStarted = false;
      try {
        const response = await withinCleanupDeadline(() => repository.openObject(lease.path, workSignal), workSignal);
        if (response.status === 404 && !response.redirected) { discard(response); outcome = 'not_found'; storage = 'absent'; }
        else {
          await verifyCleanupObject(response, lease.expectedSha256, workSignal);
          await withinCleanupDeadline(() => { removeStarted = true; return repository.removeObject(lease.path, workSignal); }, workSignal);
          // Even an empty successful SDK deletion result is not absence proof. Re-read only this exact object.
          const after = await withinCleanupDeadline(() => repository.openObject(lease.path, workSignal), workSignal); discard(after);
          if (after.status !== 404 || after.redirected) throw new CleanupError('CLEANUP_DELETE_NOT_CONFIRMED');
          outcome = 'deleted'; storage = 'absent';
        }
      } catch (error) { storage = removeStarted ? 'unknown' : 'not_deleted'; code = fixedError(error, removeStarted ? 'CLEANUP_DELETE_UNKNOWN' : 'CLEANUP_OBJECT_UNAVAILABLE'); }
      let finalization: CleanupJobResult['finalization'] = 'not_attempted';
      if (!totalSignal.aborted) {
        try { await withinCleanupDeadline(() => repository.finish(lease.jobId, lease.leaseId, outcome, totalSignal), totalSignal); finalization = 'confirmed'; }
        catch { finalization = 'unconfirmed'; code = 'CLEANUP_FINISH_UNCONFIRMED'; }
      } else code = 'CLEANUP_FINISH_NOT_ATTEMPTED';
      // No raw path, owner ID, source bytes, service key or provider/DB error body enters this report.
      jobs.push({ jobId: lease.jobId, outcome, storage, finalization, ...(code ? { code } : {}) });
    }
    return { status: jobs.some(job => job.finalization !== 'confirmed') ? 'attention_required' : jobs.some(job => job.outcome === 'retry') ? 'retry_required' : 'completed', claimed: claimed.length, jobs };
  } finally { clearTimeout(totalTimer); clearTimeout(processTimer); }
}
