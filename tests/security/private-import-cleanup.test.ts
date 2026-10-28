import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { CLEANUP_MAX_BYTES, parseCleanupLeases, runPrivateImportCleanup, verifyCleanupObject, type CleanupLease, type CleanupRepository } from '../../apps/studio-web/src/jobs/private-import-cleanup/worker';
import { runConfiguredPrivateImportCleanup } from '../../apps/studio-web/src/jobs/private-import-cleanup/configured';

const bytes = new TextEncoder().encode('An exact opaque archive awaiting disposal; never extracted or executed.');
const sha = createHash('sha256').update(bytes).digest('hex');
const owner = '10000000-0000-4000-8000-000000000001';
const lease = (i = 1): CleanupLease => ({ jobId: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, importId: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`, leaseId: `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, bucket: 'authoring-imports', path: `${owner}/30000000-0000-4000-8000-${String(i).padStart(12, '0')}/${sha}.zip`, expectedSha256: sha, attempts: 1 });
function fixture(rows: unknown = [lease()]) {
  const absent = new Set<string>(), removals: string[] = [], finishes: { jobId: string; leaseId: string; outcome: string }[] = [], reads: string[] = [];
  const repository: CleanupRepository = { async claim() { return rows; }, async openObject(path) { reads.push(path); return absent.has(path) ? new Response(null, { status: 404 }) : new Response(bytes); }, async removeObject(path) { removals.push(path); absent.add(path); }, async finish(jobId, leaseId, outcome) { finishes.push({ jobId, leaseId, outcome }); } };
  return { repository, absent, removals, finishes, reads };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('private import cleanup lease and real streamed hash boundaries', () => {
  it('defaults to at most five leased objects and mutates only each verified exact key once', async () => {
    const item = fixture(Array.from({ length: 5 }, (_, i) => lease(i + 1))), claim = vi.spyOn(item.repository, 'claim'); const report = await runPrivateImportCleanup(item.repository);
    expect(claim).toHaveBeenCalledWith(5, expect.any(AbortSignal)); expect(report.status).toBe('completed'); expect(report.jobs).toHaveLength(5); expect(report.jobs.every(job => job.outcome === 'deleted' && job.storage === 'absent' && job.finalization === 'confirmed')).toBe(true);
    expect(item.removals).toEqual(Array.from({ length: 5 }, (_, i) => lease(i + 1).path)); expect(item.reads).toHaveLength(10); expect(item.finishes.every(value => value.outcome === 'deleted')).toBe(true); expect(JSON.stringify(report)).not.toContain(owner); expect(JSON.stringify(report)).not.toContain(sha);
  });
  it.each([0, 6, 100, -1, 1.5, NaN])('rejects limit %s before acquiring a privileged lease', async limit => {
    const item = fixture(), claim = vi.spyOn(item.repository, 'claim'); await expect(runPrivateImportCleanup(item.repository, { limit })).rejects.toMatchObject({ code: 'CLEANUP_LIMIT_INVALID' }); expect(claim).not.toHaveBeenCalled();
  });
  it.each(['extra', 'bucket', 'owner', 'import', 'hash', 'suffix', 'encoded', 'attempts', 'duplicate', 'too_many'] as const)('rejects the entire malformed claim %s before reading, finishing or deleting anything', async kind => {
    const row: Record<string, unknown> = { ...lease() }; if (kind === 'extra') row.endpoint = 'https://outside.invalid'; if (kind === 'bucket') row.bucket = 'publication-releases'; if (kind === 'owner') row.path = `../${lease().importId}/${sha}.zip`; if (kind === 'import') row.importId = lease(2).importId; if (kind === 'hash') row.expectedSha256 = 'f'.repeat(64); if (kind === 'suffix') row.path += '/other'; if (kind === 'encoded') row.path = lease().path.replace('/', '%2f'); if (kind === 'attempts') row.attempts = 0;
    const rows = kind === 'duplicate' ? [lease(), lease()] : kind === 'too_many' ? Array.from({ length: 6 }, (_, i) => lease(i + 1)) : [lease(2), row]; const item = fixture(rows); const report = await runPrivateImportCleanup(item.repository); expect(report.status).toBe('claim_invalid'); expect(item.reads).toEqual([]); expect(item.removals).toEqual([]); expect(item.finishes).toEqual([]);
  });
  it('owns the immutable validated claim and accepts the preserved original owner path without a live account lookup', () => {
    const row = lease(), parsed = parseCleanupLeases([row], 5); row.path = 'changed'; expect(parsed[0]!.path).toBe(lease().path); expect(Object.isFrozen(parsed[0])).toBe(true);
  });
  it('only a confirmed 404 yields not_found; other HTTP statuses never authorize a deletion', async () => {
    for (const status of [404, 403, 500, 206]) { const item = fixture(); item.repository.openObject = async () => new Response('opaque', { status }); const report = await runPrivateImportCleanup(item.repository); expect(item.removals).toEqual([]); expect(report.jobs[0]!.outcome).toBe(status === 404 ? 'not_found' : 'retry'); expect(item.finishes[0]!.outcome).toBe(status === 404 ? 'not_found' : 'retry'); }
  });
  it('a mismatching full body is retryable and never deleted even if its size header is plausible', async () => {
    const item = fixture(); item.repository.openObject = async () => new Response('changed', { headers: { 'Content-Length': '7' } }); const report = await runPrivateImportCleanup(item.repository); expect(report).toMatchObject({ status: 'retry_required', jobs: [{ outcome: 'retry', storage: 'not_deleted', code: 'CLEANUP_OBJECT_HASH' }] }); expect(item.removals).toEqual([]);
  });
  it('hashes actual chunks and rejects overflow without trusting Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024); let sent = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 100) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled = true; } });
    await expect(verifyCleanupObject(new Response(stream), sha, new AbortController().signal)).rejects.toMatchObject({ code: 'CLEANUP_OBJECT_SIZE' }); expect(cancelled).toBe(true); expect(sent).toBeLessThanOrEqual(34);
    const exactHash = createHash('sha256'); for (let i = 0; i < 32; i++) exactHash.update(chunk); let remaining = 32;
    await expect(verifyCleanupObject(new Response(new ReadableStream({ pull(controller) { if (remaining--) controller.enqueue(chunk); else controller.close(); } }), { headers: { 'Content-Length': String(CLEANUP_MAX_BYTES) } }), exactHash.digest('hex'), new AbortController().signal)).resolves.toBeUndefined();
  });
  it('rejects truncated, empty, malformed length and prematurely errored streams', async () => {
    for (const response of [new Response(bytes, { headers: { 'Content-Length': String(bytes.length + 1) } }), new Response(new Uint8Array()), new Response(bytes, { headers: { 'Content-Length': 'NaN' } }), new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.error(new Error('private transport detail')); } }))]) await expect(verifyCleanupObject(response, sha, new AbortController().signal)).rejects.toThrow();
  });
  it('keeps uncertain deletion and a still-present readback retryable without a second delete', async () => {
    for (const unknown of [true, false]) { const item = fixture(); item.repository.removeObject = async path => { item.removals.push(path); if (unknown) throw new Error('connection lost after dispatch'); }; const report = await runPrivateImportCleanup(item.repository); expect(report).toMatchObject({ status: 'retry_required', jobs: [{ outcome: 'retry', storage: 'unknown', finalization: 'confirmed' }] }); expect(item.removals).toEqual([lease().path]); }
  });
  it('distinguishes confirmed absence from an unconfirmed finish RPC and never reports overall completion', async () => {
    const item = fixture(); item.repository.finish = async () => { throw new Error(`private failure: ${lease().path}`); }; const report = await runPrivateImportCleanup(item.repository); expect(report).toMatchObject({ status: 'attention_required', jobs: [{ outcome: 'deleted', storage: 'absent', finalization: 'unconfirmed', code: 'CLEANUP_FINISH_UNCONFIRMED' }] }); expect(JSON.stringify(report)).not.toContain(owner);
  });
  it('a later reclaimed lease can finalize an already missing object without replaying the earlier deletion', async () => {
    const item = fixture(), finish = item.repository.finish; item.repository.finish = async () => { throw new Error('finish acknowledgement lost'); }; expect((await runPrivateImportCleanup(item.repository)).status).toBe('attention_required');
    item.repository.claim = async () => [{ ...lease(), leaseId: lease(2).leaseId, attempts: 2 }]; item.repository.finish = finish; const recovered = await runPrivateImportCleanup(item.repository); expect(recovered).toMatchObject({ status: 'completed', jobs: [{ outcome: 'not_found', storage: 'absent', finalization: 'confirmed' }] }); expect(item.removals).toHaveLength(1); expect(item.finishes[0]!.leaseId).toBe(lease(2).leaseId);
  });
  it('cancellation after a mutation starts leaves its outcome unknown and does not use an aborted signal to claim DB completion', async () => {
    const item = fixture(), controller = new AbortController(); item.repository.removeObject = async path => { item.removals.push(path); controller.abort(); }; const report = await runPrivateImportCleanup(item.repository, { signal: controller.signal }); expect(report).toMatchObject({ status: 'attention_required', jobs: [{ outcome: 'retry', storage: 'unknown', finalization: 'not_attempted', code: 'CLEANUP_FINISH_NOT_ATTEMPTED' }] }); expect(item.removals).toHaveLength(1); expect(item.finishes).toEqual([]);
  });
  it('reserves the last twenty seconds for retry finalization after a stalled stream hits the processing deadline', async () => {
    vi.useFakeTimers(); const item = fixture(); let cancelled = false; item.repository.openObject = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })); const pending = runPrivateImportCleanup(item.repository); await vi.advanceTimersByTimeAsync(100001); const report = await pending; expect(report.status).toBe('retry_required'); expect(report.jobs[0]).toMatchObject({ outcome: 'retry', storage: 'not_deleted', finalization: 'confirmed', code: 'CLEANUP_DEADLINE' }); expect(item.removals).toEqual([]); expect(item.finishes[0]!.outcome).toBe('retry'); expect(cancelled).toBe(true);
  });
  it('bounds a broken deletion transport that ignores abort and records retry without claiming it was undone', async () => {
    vi.useFakeTimers(); const item = fixture(); item.repository.removeObject = async path => { item.removals.push(path); return new Promise<void>(() => {}); }; const pending = runPrivateImportCleanup(item.repository); await vi.advanceTimersByTimeAsync(100001); expect(await pending).toMatchObject({ status: 'retry_required', jobs: [{ storage: 'unknown', outcome: 'retry', finalization: 'confirmed' }] }); expect(item.removals).toHaveLength(1);
  });
  it('bounds even a hung finish at 120 seconds and leaves the lease unconfirmed for recovery', async () => {
    vi.useFakeTimers(); const item = fixture(); item.repository.finish = async () => new Promise<void>(() => {}); const pending = runPrivateImportCleanup(item.repository); await vi.advanceTimersByTimeAsync(120001); expect(await pending).toMatchObject({ status: 'attention_required', jobs: [{ outcome: 'deleted', storage: 'absent', finalization: 'unconfirmed' }] }); expect(item.removals).toHaveLength(1);
  });
  it('an already cancelled invocation makes no DB or Storage request', async () => {
    const item = fixture(), claim = vi.spyOn(item.repository, 'claim'); const controller = new AbortController(); controller.abort(); expect(await runPrivateImportCleanup(item.repository, { signal: controller.signal })).toMatchObject({ status: 'claim_failed', claimed: null }); expect(claim).not.toHaveBeenCalled();
  });
});

/** The actual installed Supabase SDK uses this controlled fetch boundary; no service key, DB or Storage account is real. */
async function transport(mode: 'normal' | 'missing' | 'empty404' | 'forged404' | 'empty200' | 'overflow' | 'hash' | 'delete_unknown' | 'finish_error' = 'normal') {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.cleanup.invalid'); vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_cleanup_test_only');
  const seen: { path: string; method: string; body: unknown }[] = []; let removed = false, streamCancelled = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); expect(url.origin).toBe('https://supabase.cleanup.invalid'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined; seen.push({ path: url.pathname, method, body });
    if (url.pathname.endsWith('/rpc/claim_private_import_cleanup')) { expect(body).toEqual({ p_limit: 5 }); return Response.json([lease()]); }
    if (url.pathname.endsWith('/rpc/finish_private_import_cleanup')) { if (mode === 'finish_error') return Response.json({ code: 'P0001', message: `CLEANUP_LEASE_INVALID ${lease().path} sb_secret_cleanup_test_only` }, { status: 400 }); return new Response(null, { status: 204 }); }
    if (method === 'DELETE') { expect(url.pathname).toBe('/storage/v1/object/authoring-imports'); expect(body).toEqual({ prefixes: [lease().path] }); if (mode === 'delete_unknown') throw new Error('socket closed after deletion'); removed = true; return Response.json([]); }
    expect(method).toBe('GET'); expect(url.pathname).toBe(`/storage/v1/object/authoring-imports/${lease().path}`);
    if (mode === 'empty404') return new Response(null, { status: 404 }); if (removed || mode === 'missing') return Response.json({ statusCode: '404', message: 'Not found' }, { status: 404 });
    if (mode === 'forged404') return Response.json({ statusCode: '404', message: 'Not found' }, { status: 403 }); if (mode === 'empty200') return new Response(null, { status: 200 });
    if (mode === 'overflow') { let left = 100; return new Response(new ReadableStream({ pull(controller) { if (left--) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); }, cancel() { streamCancelled = true; } })); }
    return new Response(mode === 'hash' ? new TextEncoder().encode('different') : bytes);
  });
  return { seen, get cancelled() { return streamCancelled; } };
}

describe('configured cleanup uses real SDK method/status boundaries', () => {
  it('claims, verifies, removes one exact key, confirms 404, then finalizes the same job and lease', async () => {
    const item = await transport(); const report = await runConfiguredPrivateImportCleanup(); expect(report.status).toBe('completed'); expect(item.seen.map(value => value.method)).toEqual(['POST', 'GET', 'DELETE', 'GET', 'POST']); expect(item.seen.at(-1)!.body).toEqual({ p_job: lease().jobId, p_lease: lease().leaseId, p_outcome: 'deleted' }); expect(JSON.stringify(report)).not.toContain('sb_secret'); expect(JSON.stringify(report)).not.toContain(lease().path);
  });
  it.each(['missing', 'empty404'] as const)('accepts actual %s as not_found without issuing DELETE', async mode => {
    const item = await transport(mode); const report = await runConfiguredPrivateImportCleanup(); expect(report.jobs[0]).toMatchObject({ outcome: 'not_found', storage: 'absent', finalization: 'confirmed' }); expect(item.seen.some(value => value.method === 'DELETE')).toBe(false);
  });
  it.each(['forged404', 'empty200', 'overflow', 'hash'] as const)('does not delete or finalize absence for %s', async mode => {
    const item = await transport(mode); const report = await runConfiguredPrivateImportCleanup(); expect(report.status).toBe('retry_required'); expect(report.jobs[0]!.outcome).toBe('retry'); expect(item.seen.some(value => value.method === 'DELETE')).toBe(false); expect(item.seen.at(-1)!.body).toMatchObject({ p_outcome: 'retry' }); if (mode === 'overflow') expect(item.cancelled).toBe(true);
  });
  it.each(['delete_unknown', 'finish_error'] as const)('keeps %s separate from completed cleanup and redacts provider text', async mode => {
    const item = await transport(mode); const report = await runConfiguredPrivateImportCleanup(); expect(report.status).toBe(mode === 'delete_unknown' ? 'retry_required' : 'attention_required'); expect(item.seen.filter(value => value.method === 'DELETE')).toHaveLength(1); expect(JSON.stringify(report)).not.toContain(lease().path); expect(JSON.stringify(report)).not.toContain('sb_secret');
  });
  it('is inert on import and reports missing server configuration without making a request', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ''); vi.stubEnv('SUPABASE_SECRET_KEY', ''); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ''); const fetch = vi.spyOn(globalThis, 'fetch'); expect(await runConfiguredPrivateImportCleanup()).toMatchObject({ status: 'claim_failed', code: 'CLEANUP_CLAIM_UNAVAILABLE' }); expect(fetch).not.toHaveBeenCalled();
  });
});
