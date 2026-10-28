import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyArtifact, COPY_RELEASE_ID } from '../helpers/publication-copy';
const owner = '30000000-0000-4000-8000-000000000003', requestId = '40000000-0000-4000-8000-000000000004', importId = '50000000-0000-4000-8000-000000000005', projectId = '60000000-0000-4000-8000-000000000006';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
const mocks = vi.hoisted(() => ({ authenticated: vi.fn(), status: vi.fn() }));
vi.mock('../../apps/studio-web/src/server/auth', () => ({ authenticatedClient: mocks.authenticated }));
import { POST, GET } from '../../apps/studio-web/src/app/api/publications/[id]/copy/route';

const context = { params: Promise.resolve({ id: COPY_RELEASE_ID }) };
function post(body: unknown = { requestId }, origin: string | null = 'http://studio.local') {
  return new Request(`http://studio.local/api/publications/${COPY_RELEASE_ID}/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.authenticated.mockReset(); mocks.status.mockReset(); });

/** The real Supabase SDK routes through controlled HTTP responses. No real account, credential or storage object is created. */
async function transport(options: { committed?: boolean; exists?: boolean; commitError?: boolean | string; errorCode?: string } = {}) {
  const item = await copyArtifact(), receipt = { importId, projectId, resources: [] };
  const envelope = { importId, requestId, releaseId: COPY_RELEASE_ID, state: options.committed ? 'committed' : 'staging', storage: { bucket: 'authoring-imports', path: `${owner}/${importId}/${item.report.artifactSha256}.zip`, bytes: item.bytes.length, sha256: item.report.artifactSha256 }, resolution: item.record, receipt: options.committed ? receipt : null };
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test.invalid'); vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_internal_copy_test');
  mocks.authenticated.mockResolvedValue({ user: { id: owner }, client: { rpc: mocks.status } });
  const seen: string[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); expect(url.origin).toBe('https://supabase.test.invalid'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store'); seen.push(url.pathname);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1), body = JSON.parse(String(init?.body));
      if (name === 'begin_private_import') { expect(body).toEqual({ p_owner: owner, p_request: requestId, p_release: COPY_RELEASE_ID }); return Response.json(envelope); }
      if (name === 'resolve_publication_copy') return Response.json(item.record);
      if (name === 'stage_private_import') { expect(body.p_import).toBe(importId); expect(body.p_stored_sha).toBe(item.report.artifactSha256); return Response.json(envelope); }
      if (name === 'commit_private_import') { if (options.commitError) return Response.json({ code: options.errorCode ?? 'P0001', message: typeof options.commitError === 'string' ? options.commitError : 'COPY_NOT_AVAILABLE' }, { status: 400 }); return Response.json({ ...envelope, state: 'committed', receipt }); }
      if (name === 'fail_private_import') return Response.json({ ...envelope, state: 'failed' });
      throw new Error(`Unexpected RPC ${name}`);
    }
    if (url.pathname.startsWith('/storage/v1/object/publication-releases/')) return new Response(item.bytes);
    expect(url.pathname).toBe(`/storage/v1/object/authoring-imports/${envelope.storage.path}`);
    if (init?.method === 'POST') {
      expect(new Headers(init.headers).get('x-upsert')).toBe('false'); expect(init.body).toEqual(item.bytes);
      return options.exists ? Response.json({ statusCode: '409', error: 'Duplicate', message: 'already exists' }, { status: 409 }) : Response.json({ Key: `authoring-imports/${envelope.storage.path}` });
    }
    return new Response(item.bytes);
  });
  return { item, receipt, envelope, fetch, seen };
}

describe('authenticated private copy HTTP boundary', () => {
  for (const exists of [false, true]) it(`uses conditional Storage creation and verified bytes (${exists ? 'retry' : 'first copy'})`, async () => {
    const item = await transport({ exists }); const response = await POST(post(), context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: item.receipt }); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(item.seen.filter(path => path.endsWith('/resolve_publication_copy'))).toHaveLength(3);
    expect(item.seen.filter(path => path.includes('/authoring-imports/'))).toHaveLength(2);
    expect(item.seen.at(-1)).toBe('/rest/v1/rpc/commit_private_import');
  });
  it('recovers a committed request with no second download/upload or copy', async () => {
    const item = await transport({ committed: true }); const response = await POST(post(), context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: item.receipt }); expect(item.seen).toEqual(['/rest/v1/rpc/begin_private_import']);
  });
  it('does not present a receipt when the final current-state check rejects commit', async () => {
    await transport({ commitError: true }); const response = await POST(post(), context);
    expect(response.status).toBe(409); const body = await response.json(); expect(body.error.code).toBe('COPY_NOT_AVAILABLE'); expect(body.receipt).toBeUndefined(); expect(JSON.stringify(body)).not.toContain('sb_secret');
  });
  for (const sqlError of ['COPY_RIGHTS_UNAVAILABLE', 'IMPORT_NOT_AVAILABLE', 'IMPORT_SOURCE_CHANGED', 'IMPORT_PREPARATION_INVALID', 'IMPORT_STORAGE_MISMATCH']) it(`ends the request only after a confirmed ${sqlError} and failure receipt`, async () => {
    const item = await transport({ commitError: sqlError }); const response = await POST(post(), context);
    expect(response.status).toBe(409); expect((await response.json()).error.issues).toEqual({ requestEnded: true }); expect(item.seen.at(-1)).toBe('/rest/v1/rpc/fail_private_import');
  });
  it('does not interpret an unconfirmed error string as a terminal SQL result', async () => {
    const item = await transport({ commitError: 'IMPORT_NOT_AVAILABLE', errorCode: 'TRANSPORT_UNKNOWN' }); const response = await POST(post(), context);
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('COPY_RETRYABLE'); expect(item.seen).not.toContain('/rest/v1/rpc/fail_private_import');
  });
  it('rejects foreign/missing origin, identity forgery and oversized body before authentication', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    for (const input of [post({}, null), post({}, 'https://evil.invalid'), post({ requestId, ownerId: owner }), post({ requestId, storagePath: 'arbitrary' }), post({ requestId: 'x'.repeat(1500) })]) expect((await POST(input, context)).status).toBeGreaterThanOrEqual(400);
    expect(mocks.authenticated).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('reports missing service setup without making any privileged transport request', async () => {
    mocks.authenticated.mockResolvedValue({ user: { id: owner } }); vi.stubEnv('SUPABASE_SECRET_KEY', ''); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ''); const network = vi.spyOn(globalThis, 'fetch');
    const response = await POST(post(), context); expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('AUTHORING_SERVICE_NOT_CONFIGURED'); expect(network).not.toHaveBeenCalled();
  });
  it('returns only a user-scoped receipt from status recovery and rejects a different release', async () => {
    const item = await transport({ committed: true }); mocks.status.mockResolvedValue({ data: { ...item.envelope, failureCode: null }, error: null });
    const response = await GET(new Request(`http://studio.local/api/publications/${COPY_RELEASE_ID}/copy?requestId=${requestId}`), context);
    expect(response.status).toBe(200); const body = await response.json(); expect(body.receipt).toEqual(item.receipt); expect(body.storage).toBeUndefined(); expect(body.resolution).toBeUndefined(); expect(mocks.status).toHaveBeenCalledWith('get_private_import_status', { p_request: requestId });
    const wrong = await GET(new Request(`http://studio.local/api/publications/${projectId}/copy?requestId=${requestId}`), { params: Promise.resolve({ id: projectId }) }); expect(wrong.status).toBe(404);
  });
  it('rejects duplicate or unsupported status query fields before account lookup', async () => {
    for (const query of [`requestId=${requestId}&requestId=${requestId}`, `requestId=${requestId}&ownerId=${owner}`, '']) expect((await GET(new Request(`http://studio.local/api/publications/${COPY_RELEASE_ID}/copy?${query}`), context)).status).toBe(400);
    expect(mocks.authenticated).not.toHaveBeenCalled();
  });
});
