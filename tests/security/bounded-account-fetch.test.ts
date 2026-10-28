import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { ACCOUNT_QUERY_LIMITS, boundedAccountFetch } from '../../apps/studio-web/src/server/bounded-account-fetch';

const origin = 'https://account-storage.example';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Real ReadableStreams exercise byte accounting before any SDK JSON parse; transport alone is a test double. */
describe('bounded account SDK transport', () => {
  it('retains query/auth semantics but fixes origin, redirects, cache and a cancellation signal', async () => {
    const transport = vi.fn(async () => new Response('{"id":"owned"}', { headers: { 'Content-Type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'test-session=updated' } })); vi.stubGlobal('fetch', transport);
    const call = boundedAccountFetch(origin), response = await call(`${origin}/rest/v1/resources?select=id`, { method: 'GET', redirect: 'follow', headers: { 'x-test-header': 'preserve' } });
    expect(await response.json()).toEqual({ id: 'owned' }); expect(response.headers.get('content-encoding')).toBeNull(); expect(response.headers.get('set-cookie')).toBe('test-session=updated');
    expect(transport).toHaveBeenCalledWith(`${origin}/rest/v1/resources?select=id`, expect.objectContaining({ redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal), headers: { 'x-test-header': 'preserve' } }));
    await expect(call('https://different.example/rest/v1/resources')).rejects.toMatchObject({ code: 'ACCOUNT_DESTINATION_INVALID' });
    await expect(call('https://user:password@account-storage.example/rest/v1/resources')).rejects.toMatchObject({ code: 'ACCOUNT_DESTINATION_INVALID' }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized streamed bytes despite a lying Content-Length and cancels the body', async () => {
    let sent = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 1000) controller.enqueue(new Uint8Array(65536)); else controller.close(); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-length': '1' } })));
    await expect(boundedAccountFetch(origin)(`${origin}/rest/v1/resource_versions`)).rejects.toMatchObject({ code: 'ACCOUNT_RESPONSE_TOO_LARGE' }); expect(cancelled).toBe(true);
  });
  it('rejects declared oversized bodies before consuming them', async () => {
    let cancelled = false; const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-length': String(ACCOUNT_QUERY_LIMITS.responseBytes + 1) } })));
    await expect(boundedAccountFetch(origin)(`${origin}/auth/v1/user`)).rejects.toMatchObject({ code: 'ACCOUNT_RESPONSE_TOO_LARGE' }); expect(cancelled).toBe(true);
  });
  it('counts concurrent responses against one aggregate budget and permanently aborts that client on overflow', async () => {
    const transport = vi.fn(async () => new Response(new Uint8Array(600))); vi.stubGlobal('fetch', transport);
    const call = boundedAccountFetch(origin, { maxTotalBytes: 1000 });
    const results = await Promise.allSettled([call(`${origin}/rest/v1/resources`), call(`${origin}/rest/v1/resource_versions`)]);
    expect(results.some(result => result.status === 'rejected' && result.reason.code === 'ACCOUNT_RESPONSE_TOO_LARGE')).toBe(true);
    await expect(call(`${origin}/rest/v1/resources`)).rejects.toMatchObject({ code: 'ACCOUNT_RESPONSE_TOO_LARGE' }); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('cancels an unfinished body on parent cancellation instead of waiting indefinitely', async () => {
    let cancelled = false; const controller = new AbortController(); const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    const reading = boundedAccountFetch(origin, { signal: controller.signal })(`${origin}/rest/v1/resources`);
    const assertion = expect(reading).rejects.toThrow('cancel account read'); await Promise.resolve(); controller.abort(new Error('cancel account read')); await assertion; expect(cancelled).toBe(true);
  });
  it('preserves empty statuses and does not accept unsafe budget/configuration overrides', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const response = await boundedAccountFetch(origin)(`${origin}/rest/v1/resources`); expect(response.status).toBe(204); expect(response.body).toBeNull();
    for (const maxTotalBytes of [0, Number.NaN, ACCOUNT_QUERY_LIMITS.totalBytes + 1]) expect(() => boundedAccountFetch(origin, { maxTotalBytes })).toThrow('ACCOUNT_FETCH_CONFIGURATION_INVALID');
    expect(() => boundedAccountFetch('http://untrusted.example')).toThrow('ACCOUNT_FETCH_CONFIGURATION_INVALID');
  });
});
