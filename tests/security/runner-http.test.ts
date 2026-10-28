import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const instances: { directory: string; server: ReturnType<typeof createLocalServer>; service: RunnerService; store: RunStore }[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runner-http-test-'));
  const store = new RunStore(':memory:');
  const credentials: CredentialStore = { available: false, async set() { throw new Error('unavailable'); }, async get() { throw new Error('unavailable'); }, async has() { return false; }, async delete() {} };
  const service = new RunnerService(store, credentials, directory);
  const server = createLocalServer(service, { bearerToken: 'test-only-loopback-token' });
  const { origin } = await server.listen(); instances.push({ directory, server, service, store }); return { origin, server };
}
afterEach(async () => { for (const item of instances.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-runner-http-test-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

/** Real loopback requests prove the browser and daemon authorization boundary. */
describe('Runner HTTP trust boundary', () => {
  it('requires authentication and rejects a foreign Origin even with a valid bearer', async () => {
    const { origin } = await fixture();
    expect((await fetch(`${origin}/api/info`)).status).toBe(401);
    expect((await fetch(`${origin}/api/info`, { headers: { authorization: 'Bearer test-only-loopback-token', origin: 'https://untrusted.invalid' } })).status).toBe(403);
    const accepted = await fetch(`${origin}/api/info`, { headers: { authorization: 'Bearer test-only-loopback-token' } });
    expect(accepted.status).toBe(200);
    const capabilities = (await accepted.json()).capabilities as string[];
    expect(capabilities).toEqual(expect.arrayContaining(['node.input@1', 'node.ai@1', 'node.output@1', 'document_extract.builtin_utf8@1', 'knowledge.keyword@1', 'retrieval.keyword@1']));
    // Authorization gives access to the actual runtime contract, without promising unimplemented Worker or graph modes.
    expect(capabilities.some(capability => capability.startsWith('worker.') || capability === 'retrieval.graph@1')).toBe(false);
  });

  it('rejects Host rebinding and cross-origin session bootstrap', async () => {
    const { origin } = await fixture();
    // Native fetch normalizes Host; a raw HTTP client is needed to exercise DNS-rebinding protection.
    const deniedHost = await new Promise<number>((resolveStatus, reject) => {
      const call = httpRequest(`${origin}/api/info`, { headers: { host: 'attacker.invalid', authorization: 'Bearer test-only-loopback-token' } }, (response) => { response.resume(); resolveStatus(response.statusCode ?? 0); });
      call.on('error', reject); call.end();
    });
    expect(deniedHost).toBe(403);
    expect((await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin: 'https://untrusted.invalid', 'sec-fetch-site': 'cross-site' }, body: '{}' })).status).toBe(403);
  });

  it('requires memory CSRF plus same-origin browser metadata after bootstrap', async () => {
    const { origin } = await fixture();
    const response = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin, 'sec-fetch-site': 'same-origin' }, body: '{}' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await response.json() as { csrf: string };
    expect((await fetch(`${origin}/api/info`, { headers: { cookie } })).status).toBe(401);
    const allowed = await fetch(`${origin}/api/info`, { headers: { cookie, 'x-studio-csrf': csrf, 'sec-fetch-site': 'same-origin' } });
    expect(allowed.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly'); expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
  });

  it('rejects duplicate JSON keys before performing a model-profile mutation', async () => {
    const { origin } = await fixture();
    const response = await fetch(`${origin}/api/profiles`, { method: 'POST', headers: { authorization: 'Bearer test-only-loopback-token', 'content-type': 'application/json' }, body: '{"name":"one","name":"two"}' });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_JSON');
  });

  it('rejects malformed UTF-8 and misleading JSON MIME prefixes before mutation', async () => {
    const { origin } = await fixture(); const headers = { authorization: 'Bearer test-only-loopback-token', 'content-type': 'application/json; charset=utf-8' };
    const malformed = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const response = await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: malformed });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_JSON');
    const wrongMime = await fetch(`${origin}/api/profiles`, { method: 'POST', headers: { ...headers, 'content-type': 'application/jsonp' }, body: '{}' });
    expect(wrongMime.status).toBe(415);
  });

  it('reports package validation failures as safe client errors', async () => {
    const { origin } = await fixture();
    const response = await fetch(`${origin}/api/packages/import`, { method: 'POST', headers: { authorization: 'Bearer test-only-loopback-token', 'content-type': 'application/zip' }, body: 'not-a-zip' });
    expect(response.status).toBe(400); expect((await response.json()).error.code).not.toBe('INTERNAL_ERROR');
  });
});
