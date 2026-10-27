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
    expect(accepted.status).toBe(200); expect((await accepted.json()).capabilities).toEqual(['node.input@1', 'node.ai@1', 'node.output@1', 'node.resource@1', 'node.transform@1', 'node.condition@1', 'node.merge@1', 'node.evaluate@1', 'evaluate.rules@1', 'node.guardrail@1', 'node.error@1', 'node.form@1', 'node.review@1', 'node.classify@1', 'evaluate.model@1', 'node.subworkflow@1', 'node.loop@1', 'node.parallel@1', 'flow.local@1', 'loop.foreach@1', 'loop.until@1', 'parallel.all@1', 'node.file_input@1', 'node.file_output@1', 'file_output.text@1', 'file_output.markdown@1', 'file_output.json@1', 'file_output.csv@1', 'file_output.copy@1', 'node.memory@1', 'memory.run@1', 'node.skill@1', 'skill.instructions@1', 'node.agent@1', 'agent.task@1', 'agent.single_step@1', 'node.agent_team@1', 'agent_team.sequential@1', 'agent_team.parallel@1', 'node.orchestrator@1', 'orchestrator.plan@1']);
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

  it('reports package validation failures as safe client errors', async () => {
    const { origin } = await fixture();
    const response = await fetch(`${origin}/api/packages/import`, { method: 'POST', headers: { authorization: 'Bearer test-only-loopback-token', 'content-type': 'application/zip' }, body: 'not-a-zip' });
    expect(response.status).toBe(400); expect((await response.json()).error.code).not.toBe('INTERNAL_ERROR');
  });
});
