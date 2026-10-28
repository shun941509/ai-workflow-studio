import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { deliveryArtifact } from '../helpers/publication-delivery';
import { canonicalDigest } from '@studio/package-kit';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
vi.mock('../../apps/studio-web/src/server/auth', () => ({ authenticatedClient: vi.fn(async () => ({ user: { id: 'test-user' } })) }));
import { downloadConfiguredPublication, preparePublicationDownload, publicationDownloadResponse, readDeliveryBytes, MAX_DELIVERY_BYTES, type DeliveryRepository } from '../../apps/studio-web/src/server/publication-delivery';
import { HttpError } from '../../apps/studio-web/src/server/http';

const id = '10000000-0000-4000-8000-000000000001', submission = '20000000-0000-4000-8000-000000000002';
/** The transport boundary is replaced in tests while ZIP parsing, signature and every byte digest remain real. */
async function setup(options: Parameters<typeof deliveryArtifact>[0] = {}) {
  const artifact = await deliveryArtifact(options); expect(artifact.report.status).toBe('passed');
  const record = { releaseId: id, submissionId: submission, artifactSha256: artifact.report.artifactSha256, manifestSha256: artifact.report.manifestSha256, artifactBytes: artifact.bytes.length, targetHost: artifact.host, storagePath: `releases/${submission}/${artifact.report.artifactSha256}.zip`, sourceSnapshotSha256: artifact.report.sourceSnapshotSha256, report: artifact.report, signingKey: { id: 'package-test', publicKey: artifact.publicKey, sha256: artifact.keyHash, notBefore: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' } };
  const resolve = vi.fn(async () => structuredClone(record)); const openObject = vi.fn(async () => new Response(artifact.bytes)); return { ...artifact, record, repository: { resolve, openObject } satisfies DeliveryRepository };
}

describe('exact public ZIP delivery boundary', () => {
  it('reads real fetch-decompressed bytes while retaining the decoded stream limit', async () => {
    const source = Buffer.from('원본 공개 파일 검증 '.repeat(100)); const compressed = gzipSync(source);
    const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); response.end(compressed); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const response = await fetch(url);
      expect(Number(response.headers.get('content-length'))).toBe(compressed.length); expect(compressed.length).toBeLessThan(source.length);
      expect(Buffer.from(await readDeliveryBytes(response, source.length, new AbortController().signal))).toEqual(source);
      await expect(readDeliveryBytes(await fetch(url), source.length - 1, new AbortController().signal)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  for (const host of ['codex', 'claude-code', 'opencode'] as const) it(`returns the original signed ${host} bytes only after the second lookup`, async () => {
    const item = await setup({ host }); const result = await preparePublicationDownload(item.repository, id); expect(result.bytes).toEqual(item.bytes); expect(item.repository.resolve).toHaveBeenCalledTimes(2); expect(item.repository.openObject).toHaveBeenCalledWith(item.record.storagePath, expect.any(AbortSignal));
    const response = publicationDownloadResponse(result); expect(response.headers.get('content-type')).toBe('application/zip'); expect(response.headers.get('content-disposition')).toBe(`attachment; filename="workflow-${id}-${host}.zip"`); expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect([...response.headers].join(' ')).not.toContain('releases/'); expect(new Uint8Array(await response.arrayBuffer())).toEqual(item.bytes);
  });
  it('rejects an unsigned package despite a passed static report', async () => { const item = await setup({ signed: false }); await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); });
  it('rejects changed raw bytes before signature or second lookup', async () => { const item = await setup(); const changed = item.bytes.slice(); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1; item.repository.openObject.mockResolvedValue(new Response(changed)); await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); expect(item.repository.resolve).toHaveBeenCalledTimes(1); });
  it('rejects a changed manifest hash even when the report was recomputed', async () => { const item = await setup(); item.record.manifestSha256 = 'f'.repeat(64); item.record.report.manifestSha256 = item.record.manifestSha256; const { reportSha256: _, ...body } = item.record.report; item.record.report.reportSha256 = canonicalDigest(body); await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); });
  it('does not silently convert one approved host ZIP into another', async () => { const item = await setup(); item.record.targetHost = 'opencode'; await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); });
  it('rejects altered report evidence and arbitrary private object paths before reading', async () => { for (const field of ['report', 'path'] as const) { const item = await setup(); if (field === 'report') item.record.report.artifactBytes++; else item.record.storagePath = 'resources/other-user/private.txt'; await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); expect(item.repository.openObject).not.toHaveBeenCalled(); } });
  it('rejects expired and not-yet-valid signing trust without reading bytes', async () => { for (const field of ['expiresAt', 'notBefore'] as const) { const item = await setup(); item.record.signingKey[field] = field === 'expiresAt' ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z'; await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); expect(item.repository.openObject).not.toHaveBeenCalled(); } });
  it('does not accept a supplied public key whose DER fingerprint differs', async () => { const item = await setup(); item.record.signingKey.sha256 = 'f'.repeat(64); await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); });
  it('blocks revocation while Storage is still streaming, before returning any download', async () => {
    const item = await setup(); let revoked = false;
    item.repository.openObject.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(item.bytes.slice(0, 100)); revoked = true; controller.enqueue(item.bytes.slice(100)); controller.close(); } })));
    item.repository.resolve.mockImplementation(async () => { if (revoked) throw new HttpError(404, 'DELIVERY_NOT_AVAILABLE', '철회됨'); return structuredClone(item.record); });
    await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_NOT_AVAILABLE' }); expect(item.repository.resolve).toHaveBeenCalledTimes(2);
  });
  it('rejects changed immutable identity on the final current-state lookup', async () => { const item = await setup(); item.repository.resolve.mockResolvedValueOnce(structuredClone(item.record)).mockResolvedValueOnce({ ...item.record, targetHost: 'opencode' }); await expect(preparePublicationDownload(item.repository, id)).rejects.toMatchObject({ code: 'DELIVERY_CHANGED' }); });
  it('bounds real streamed bytes when Content-Length is absent or false', async () => {
    for (const contentLength of [null, '1', String(MAX_DELIVERY_BYTES + 1)]) { const headers = new Headers(); if (contentLength) headers.set('content-length', contentLength); const response = new Response(new Uint8Array(9), { headers }); await expect(readDeliveryBytes(response, 8, new AbortController().signal)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' }); }
  });
  it('cancels a stalled object stream promptly and never emits a success response', async () => { const abort = new AbortController(); const cancelled = vi.fn(); const response = new Response(new ReadableStream({ cancel: cancelled })); const reading = readDeliveryBytes(response, 8, abort.signal); abort.abort(); await expect(reading).rejects.toMatchObject({ code: 'DELIVERY_CANCELLED' }); expect(cancelled).toHaveBeenCalledTimes(1); });
  it('requires server-only configuration and rejects query/range without network calls', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', ''); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ''); const fetch = vi.spyOn(globalThis, 'fetch');
    try { await expect(downloadConfiguredPublication(id, new Request(`http://studio.local/api/publications/${id}/download`))).rejects.toMatchObject({ status: 503, code: 'DELIVERY_NOT_CONFIGURED' }); for (const request of [new Request(`http://studio.local/api/publications/${id}/download?host=codex`), new Request(`http://studio.local/api/publications/${id}/download`, { headers: { range: 'bytes=0-100' } })]) await expect(downloadConfiguredPublication(id, request)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('uses the real server SDK adapter with bounded private transport and no secret/path in its response', async () => {
    const item = await setup(); const testSecret = 'sb_secret_predictable_test_only_value'; vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test.invalid'); vi.stubEnv('SUPABASE_SECRET_KEY', testSecret);
    const seen: string[] = []; let lookups = 0;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); seen.push(url.pathname); expect(url.origin).toBe('https://supabase.test.invalid'); expect(options?.redirect).toBe('error'); expect(options?.cache).toBe('no-store');
      if (url.pathname === '/rest/v1/rpc/resolve_publication_delivery') { lookups++; expect(JSON.parse(String(options?.body))).toEqual({ p_release: id }); return new Response(JSON.stringify(item.record), { headers: { 'content-type': 'application/json' } }); }
      expect(url.pathname).toBe(`/storage/v1/object/publication-releases/${item.record.storagePath}`); return new Response(item.bytes, { headers: { 'content-type': 'application/zip' } });
    });
    try { const response = await downloadConfiguredPublication(id, new Request(`http://studio.local/api/publications/${id}/download`)); expect(new Uint8Array(await response.arrayBuffer())).toEqual(item.bytes); expect(lookups).toBe(2); expect(seen).toHaveLength(3); expect([...response.headers].join(' ')).not.toContain(testSecret); expect([...response.headers].join(' ')).not.toContain(item.record.storagePath); }
    finally { transport.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('preserves current-state denial from the real SDK after the object was read', async () => {
    const item = await setup(); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test.invalid'); vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_predictable_test_only_value'); let lookups = 0;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/rest/v1/rpc/resolve_publication_delivery') { lookups++; if (lookups === 2) return new Response(JSON.stringify({ code: 'P0001', message: 'DELIVERY_NOT_AVAILABLE' }), { status: 400, headers: { 'content-type': 'application/json' } }); return new Response(JSON.stringify(item.record), { headers: { 'content-type': 'application/json' } }); }
      return new Response(item.bytes, { headers: { 'content-type': 'application/zip' } });
    });
    try { await expect(downloadConfiguredPublication(id, new Request(`http://studio.local/api/publications/${id}/download`))).rejects.toMatchObject({ status: 404, code: 'DELIVERY_NOT_AVAILABLE' }); expect(lookups).toBe(2); }
    finally { transport.mockRestore(); vi.unstubAllEnvs(); }
  });
});
