import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { receivePublicationArchive } from '../../apps/studio-web/src/features/library/download-publication';

const id = '10000000-0000-4000-8000-000000000001'; const bytes = new TextEncoder().encode('Opaque test bytes; server package verification is tested independently.');
const hash = createHash('sha256').update(bytes).digest('hex');
const headers = { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="workflow-${id}-codex.zip"` };

/** Browser checks bind downloaded bytes to the displayed version without trusting a filename or success flag. */
describe('public archive browser receipt', () => {
  it('preserves complete matching bytes and the fixed host filename', async () => {
    const result = await receivePublicationArchive(new Response(bytes, { headers }), id, hash, new AbortController().signal);
    expect(result.filename).toBe(`workflow-${id}-codex.zip`); expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
  });
  it('rejects a changed body even if the server supplied ZIP headers', async () => {
    await expect(receivePublicationArchive(new Response('changed', { headers }), id, hash, new AbortController().signal)).rejects.toThrow('공개 버전과 다릅니다');
  });
  it.each(['../../private.zip', `workflow-${id}-other-host.zip`, 'workflow-20000000-0000-4000-8000-000000000002-codex.zip'])('does not accept an arbitrary download filename: %s', async name => {
    await expect(receivePublicationArchive(new Response(bytes, { headers: { ...headers, 'Content-Disposition': `attachment; filename="${name}"` } }), id, hash, new AbortController().signal)).rejects.toThrow('파일 정보를');
  });
  it('rejects HTML/error responses instead of saving them as archives', async () => {
    await expect(receivePublicationArchive(new Response('<h1>error</h1>', { headers: { ...headers, 'Content-Type': 'text/html' } }), id, hash, new AbortController().signal)).rejects.toThrow('응답 형식');
    await expect(receivePublicationArchive(new Response(bytes, { status: 403, headers }), id, hash, new AbortController().signal)).rejects.toThrow('응답 형식');
  });
  it('bounds actual bytes even with no Content-Length', async () => {
    let remaining = 33; let cancelled = false; const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({ pull(controller) { if (remaining--) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled = true; } });
    await expect(receivePublicationArchive(new Response(body, { headers }), id, hash, new AbortController().signal)).rejects.toThrow('크기가 허용된 한도'); expect(cancelled).toBe(true);
  });
  it('cancels a stalled body without emitting a partial archive', async () => {
    const controller = new AbortController(); let cancelled = false; const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const pending = receivePublicationArchive(new Response(body, { headers }), id, hash, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow(); expect(cancelled).toBe(true);
  });
});
