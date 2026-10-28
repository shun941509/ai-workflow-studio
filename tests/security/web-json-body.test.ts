import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { readBody } from '../../apps/studio-web/src/server/http';

function request(body: Uint8Array<ArrayBuffer> | string, mime = 'application/json') {
  vi.stubEnv('STUDIO_PUBLIC_ORIGIN', 'https://studio.example');
  return new Request('https://studio.example/api/projects', { method: 'POST', headers: { origin: 'https://studio.example', 'content-type': mime }, body });
}
afterEach(() => vi.unstubAllEnvs());

/** The actual streaming HTTP boundary must retain strict bytes, MIME and duplicate-key validation. */
describe('web JSON request boundary', () => {
  it.each(['application/jsonp', 'application/json-invalid', 'text/plain'])('rejects %s as a JSON substitute', async mime => {
    await expect(readBody(request('{}', mime))).rejects.toMatchObject({ status: 415, code: 'JSON_REQUIRED' });
  });
  it('accepts UTF-8 JSON with parameters and a case-insensitive MIME type', async () => {
    expect(await readBody(request('{"name":"한글"}', 'Application/JSON; charset=utf-8'))).toEqual({ name: '한글' });
  });
  it('rejects invalid UTF-8 and duplicate keys without silently rewriting the input', async () => {
    const malformed = new Uint8Array([...Buffer.from('{"name":"'), 0xc3, 0x28, ...Buffer.from('"}')]);
    await expect(readBody(request(malformed))).rejects.toMatchObject({ status: 400, code: 'JSON_INVALID' });
    await expect(readBody(request('{"name":1,"name":2}'))).rejects.toMatchObject({ status: 400, code: 'JSON_INVALID' });
  });
});
