// Request recovery exercises the real HTTP/service/SQLite boundary; it never needs a provider or a credential.
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

const setups: { directory: string; store: RunStore; service: RunnerService; server: ReturnType<typeof createLocalServer> }[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-request-lookup-'));
  const store = new RunStore(join(directory, 'state.sqlite'));
  store.savePackage({ handle: 'package-handle', filename: 'test.zip', sha256: '0'.repeat(64), name: 'Lookup boundary', createdAt: new Date().toISOString() });
  const credentials = { available: false, async set() { throw Error('unavailable'); }, async get(): Promise<string> { throw Error('unavailable'); }, async has() { return false; }, async delete() {} };
  const service = new RunnerService(store, credentials, directory);
  const server = createLocalServer(service, { bearerToken: 'test-only-request-lookup' });
  setups.push({ directory, store, service, server });
  return { store, ...(await server.listen()) };
}

afterEach(async () => {
  for (const item of setups.splice(0)) {
    await item.service.shutdown(); await item.server.close(); item.store.close();
    const target = resolve(item.directory);
    // Cleanup is limited to this test's direct temporary directory, never a computed user workspace.
    if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-request-lookup-')) throw Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

const headers = { authorization: 'Bearer test-only-request-lookup' };
it('finds an accepted request outside the recent list without exposing request content', async () => {
  const { origin, store } = await setup(); const requestId = randomUUID();
  const run = store.createRun({ requestId, requestHash: 'request-hash', packageHandle: 'package-handle', planHash: 'plan-hash', plan: {}, inputs: { confidential: 'private text' }, modelBindings: { privateAlias: 'private-profile' }, nodeIds: [], maxModelCalls: 1, maxTotalTokens: 1 });
  for (let i = 0; i < 51; i++) store.createRun({ requestId: randomUUID(), requestHash: String(i), packageHandle: 'package-handle', planHash: 'plan-hash', plan: {}, inputs: {}, modelBindings: {}, nodeIds: [], maxModelCalls: 1, maxTotalTokens: 1 });
  const response = await fetch(`${origin}/api/run-requests/${requestId}`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ state: 'found', runId: run.id });
});

it('reports a present-time miss without creating a run or reserving model work', async () => {
  const { origin, store } = await setup();
  const response = await fetch(`${origin}/api/run-requests/${randomUUID()}`, { headers });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'not_found' });
  expect(store.listRuns()).toEqual([]);
});

it('requires local authentication, rejects foreign origins and validates lookup identifiers', async () => {
  const { origin } = await setup(); const endpoint = `${origin}/api/run-requests/${randomUUID()}`;
  expect((await fetch(endpoint)).status).toBe(401);
  expect((await fetch(endpoint, { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status).toBe(403);
  expect((await fetch(`${origin}/api/run-requests/invalid-id`, { headers })).status).toBe(400);
});
