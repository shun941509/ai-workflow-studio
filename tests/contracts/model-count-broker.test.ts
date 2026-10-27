import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelBroker } from '../../apps/runner/src/providers/model-broker.js';
import { ModelError, type ModelProvider, type ModelRequest } from '../../apps/runner/src/providers/model-provider.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const owned: { directory: string; store: RunStore }[] = [];
const profile = { id: 'profile', name: 'test', provider: 'openai' as const, model: 'contract-model', credentialRef: 'test-credential' };
const request = () => ({ instructions: 'instructions', content: { nested: { text: 'original' } }, maxOutputTokens: 100, responseFormat: { mode: 'json' as const, schema: { type: 'object', properties: { answer: { type: 'string' } } } } });
/** Actual SQLite accounting is used; only the provider and credential boundaries are test-only implementations. */
function setup(provider: ModelProvider, maxTotalTokens = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-count-broker-')); const store = new RunStore(join(directory, 'state.sqlite')); owned.push({ directory, store });
  store.savePackage({ handle: 'package', filename: 'test-state-only.zip', sha256: '0'.repeat(64), name: 'Internal accounting test', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'request', requestHash: '0'.repeat(64), packageHandle: 'package', planHash: '1'.repeat(64), plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['node'], edges: [], maxModelCalls: 4, maxTotalTokens });
  const credentials: CredentialStore = { available: true, async get() { return 'internal-test-key'; }, async has() { return true; }, async set() {}, async delete() {} };
  return { store, runId: run.id, broker: new ModelBroker(store, credentials, provider) };
}
afterEach(() => { for (const item of owned.splice(0)) { item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-count-broker-')) throw new Error('unsafe cleanup'); rmSync(path, { recursive: true, force: true }); } });

describe('provider count and durable reservation boundary', () => {
  it('owns and deeply freezes the same request before any async work', async () => {
    const original = request(); let counted: ModelRequest | undefined; let generated: ModelRequest | undefined;
    const item = setup({ async countInputTokens(value) { counted = value; expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen((value.content as typeof original.content).nested)).toBe(true); expect(Object.isFrozen(value.responseFormat)).toBe(true); return 5; }, async generate(value) { generated = value; return { text: '{}', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }; } });
    const pending = item.broker.invoke(item.runId, 'node', profile, original, new AbortController().signal); original.content.nested.text = 'changed after call'; original.responseFormat.schema.properties.answer.type = 'number';
    await pending; expect(generated).toBe(counted); expect(generated!.content).toEqual({ nested: { text: 'original' } }); expect(generated!.responseFormat).toMatchObject({ schema: { properties: { answer: { type: 'string' } } } });
    expect(item.store.getRun(item.runId).usage).toEqual({ modelCalls: 1, consumedTokens: 7, reservedTokens: 0 });
  });

  it('does not generate or reserve if count fails, even when the provider reports an arbitrary error', async () => {
    let generated = 0; const item = setup({ async countInputTokens() { throw new Error('private count failure'); }, async generate() { generated++; throw new Error('unexpected generation'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_COUNT_UNAVAILABLE', outcome: 'not_started' });
    expect(generated).toBe(0); expect(item.store.getRun(item.runId).usage).toEqual({ modelCalls: 0, consumedTokens: 0, reservedTokens: 0 }); expect(JSON.stringify(item.store.listEvents(item.runId))).not.toContain('private count failure');
  });

  it('does not generate after cancellation during count', async () => {
    const controller = new AbortController(); let generated = 0; const item = setup({ async countInputTokens() { controller.abort(); return 5; }, async generate() { generated++; throw new Error('unexpected'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), controller.signal)).rejects.toMatchObject({ outcome: 'not_started' }); expect(generated).toBe(0); expect(item.store.getRun(item.runId).usage.reservedTokens).toBe(0);
  });

  it('keeps a count timeout as a protected budget stop with no generation reservation', async () => {
    const controller = new AbortController(); let generated = 0; const item = setup({ async countInputTokens() { controller.abort(new DOMException('test timeout', 'TimeoutError')); return 5; }, async generate() { generated++; throw new Error('unexpected'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), controller.signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', outcome: 'not_started' }); expect(generated).toBe(0); expect(item.store.getRun(item.runId).usage.reservedTokens).toBe(0);
  });

  it('checks already insufficient output budget before transmitting the count payload', async () => {
    let counted = 0; const item = setup({ async countInputTokens() { counted++; return 1; }, async generate() { throw new Error('unexpected'); } }, 50);
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' }); expect(counted).toBe(0);
  });

  it('atomically refuses a count that cannot fit with the requested output', async () => {
    let generated = 0; const item = setup({ async countInputTokens() { return 11; }, async generate() { generated++; throw new Error('unexpected'); } }, 110);
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' }); expect(generated).toBe(0); expect(item.store.getRun(item.runId).usage.modelCalls).toBe(0);
  });

  it.each([NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER])('refuses invalid or overflowing count %s', async count => {
    let generated = 0; const item = setup({ async countInputTokens() { return count; }, async generate() { generated++; throw new Error('unexpected'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_COUNT_INVALID' }); expect(generated).toBe(0);
  });

  it('retains reservations across uncertain generation and malformed completed usage', async () => {
    const item = setup({ async countInputTokens() { return 5; }, async generate() { throw new ModelError('NETWORK_UNKNOWN', 'unknown', 'unknown'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ outcome: 'unknown' }); expect(item.store.getRun(item.runId).usage.reservedTokens).toBe(105);
    const malformed = setup({ async countInputTokens() { return 5; }, async generate() { return { text: 'unsafe to publish', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 1 } }; } });
    await expect(malformed.broker.invoke(malformed.runId, 'node', profile, request(), new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_USAGE_UNKNOWN', outcome: 'unknown' }); expect(malformed.store.getRun(malformed.runId).usage.reservedTokens).toBe(105);
  });
});
