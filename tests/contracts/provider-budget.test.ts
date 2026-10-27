import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const created: { root: string; service: RunnerService; store: RunStore }[] = [];
async function runWire(value: unknown, countValue: unknown = { object: 'response.input_tokens', input_tokens: 2 }) {
  // Only fetch and credentials are replaced: package import, broker reservations and SQLite are real.
  let calls = 0; let generations = 0; const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { calls++; sent.push({ url, body: JSON.parse(String(options.body)) }); const count = url.endsWith('/input_tokens'); if (!count) generations++; return new Response(JSON.stringify(count ? countValue : value), { status: 200 }); });
  const values = new Map<string, string>();
  const credentials: CredentialStore = { available: true, async set(id, value) { values.set(id, value); }, async get(id) { return values.get(id)!; }, async has(id) { return values.has(id); }, async delete(id) { values.delete(id); } };
  const root = await mkdtemp(join(tmpdir(), 'studio-provider-budget-')); const store = new RunStore(join(root, 'state.db'));
  const service = new RunnerService(store, credentials, root); created.push({ root, service, store });
  const profile = await service.createProfile({ name: 'Internal test boundary', model: 'contract-model', apiKey: 'not-a-real-provider-key' });
  const pack = await service.importPackage((await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' })).bytes);
  const run = await service.start({ packageHandle: pack.packageHandle, requestId: 'wire_test', inputs: { text: 'internal private request' }, modelBindings: { 'text-default': profile.id } });
  await service.waitForIdle();
  return { result: service.status(run.runId), events: service.events(run.runId), calls, generations, sent };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const item of created.splice(0)) {
    await item.service.shutdown(); item.store.close();
    const target = resolve(item.root);
    if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-provider-budget-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
describe('confirmed usage on unsuccessful provider output', () => {
  it.each([
    { status: 'incomplete', output: [{ content: [{ type: 'output_text', text: 'partial' }] }], code: 'MODEL_INCOMPLETE' },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'internal private refusal' }] }], code: 'MODEL_REFUSAL' },
    { status: 'completed', output: [], code: 'MODEL_OUTPUT_MISSING' },
  ])('accounts for confirmed usage when $code stops execution', async sample => {
    const { result, events, calls } = await runWire({ ...sample, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
    expect(result).toMatchObject({ status: 'failed', error: { code: sample.code }, usage: { consumedTokens: 5, reservedTokens: 0 } });
    expect(calls).toBe(2); expect(events.some(event => event.type === 'model.usage' && (event.payload as { actualTokens?: number }).actualTokens === 5)).toBe(true);
    expect(JSON.stringify(result.error)).not.toContain('internal private');
  });
  it('retains reservations for nonterminal responses rather than treating partial usage as final', async () => {
    const { result, calls } = await runWire({ status: 'in_progress', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
    expect(result.status).toBe('attention_required'); expect(result.usage.consumedTokens).toBe(0); expect(result.usage.reservedTokens).toBeGreaterThan(0); expect(calls).toBe(2);
  });
  it('does not refund a reservation using internally inconsistent token counts', async () => {
    const { result } = await runWire({ status: 'incomplete', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 0 } });
    expect(result.usage.consumedTokens).toBe(0); expect(result.usage.reservedTokens).toBeGreaterThan(0);
  });

  it.each([null, {}, { object: 'wrong', input_tokens: 2 }, { object: 'response.input_tokens', input_tokens: -1 }, { object: 'response.input_tokens', input_tokens: 1.5 }, { object: 'response.input_tokens', input_tokens: '2' }])('never generates or reserves after malformed count %j', async count => {
    const outcome = await runWire({}, count); expect(outcome.generations).toBe(0); expect(outcome.result).toMatchObject({ status: 'failed', error: { code: 'MODEL_COUNT_INVALID' }, usage: { modelCalls: 0, consumedTokens: 0, reservedTokens: 0 } });
    expect(outcome.events.some(event => event.type === 'model.count_failed')).toBe(true);
  });

  it('reserves the counted input plus explicit output cap and sends the same input fields', async () => {
    const outcome = await runWire({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'confirmed' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
    expect(outcome.result.status).toBe('succeeded'); const count = outcome.sent[0]!.body as Record<string, unknown>; const generation = outcome.sent[1]!.body as Record<string, unknown>;
    expect(count).toEqual(Object.fromEntries(Object.entries(generation).filter(([key]) => !['max_output_tokens', 'store'].includes(key)))); expect(count).not.toHaveProperty('store'); expect(count).not.toHaveProperty('max_output_tokens');
    const reservation = outcome.events.find(event => event.type === 'model.reserved')!.payload as { tokens: number; count: { inputTokens: number; maxOutputTokens: number; requestHash: string } };
    expect(reservation.tokens).toBe(2 + Number(generation.max_output_tokens)); expect(reservation.count.inputTokens).toBe(2); expect(reservation.count.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('settles actual usage then stops when actual input exceeds the counted input', async () => {
    const outcome = await runWire({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'must not publish' }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
    expect(outcome.result).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { consumedTokens: 5, reservedTokens: 0 } }); expect(outcome.result.result).toBeNull();
    expect(outcome.events.find(event => event.type === 'model.usage_mismatch')?.payload).toMatchObject({ inputUndercount: true });
  });

  it('records total/output reservation overrun even below the project total budget', async () => {
    const outcome = await runWire({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'too much' }] }], usage: { input_tokens: 2, output_tokens: 10000, total_tokens: 10002 } });
    expect(outcome.result).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { consumedTokens: 10002, reservedTokens: 0 } }); expect(outcome.events.find(event => event.type === 'model.usage_mismatch')?.payload).toMatchObject({ overrun: true, outputOverrun: true });
  });

  it('records harmless over-count drift and releases unused reservations with known usage', async () => {
    const outcome = await runWire({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'known' }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    expect(outcome.result).toMatchObject({ status: 'succeeded', usage: { consumedTokens: 3, reservedTokens: 0 } }); expect(outcome.events.find(event => event.type === 'model.usage_mismatch')?.payload).toMatchObject({ inputUndercount: false, expectedInputTokens: 2, actualInputTokens: 1 });
  });

  it('retains the reservation and stops when a completed response omits usage', async () => {
    const outcome = await runWire({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'unaccounted' }] }] });
    expect(outcome.result).toMatchObject({ status: 'attention_required', error: { code: 'MODEL_USAGE_UNKNOWN' }, usage: { consumedTokens: 0 } }); expect(outcome.result.usage.reservedTokens).toBeGreaterThan(0);
  });
});
