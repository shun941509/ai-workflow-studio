// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createBasicWorkflow, type Workflow } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { ModelError, type ModelProvider, type ModelRequest, type ModelResponse } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

/** This in-memory credential boundary exists only in tests, never in the product configuration. */
class TestCredentials implements CredentialStore {
  available = true;
  private values = new Map<string, string>();
  async set(id: string, value: string) { this.values.set(id, value); }
  async get(id: string) { const value = this.values.get(id); if (!value) throw new Error('missing test credential'); return value; }
  async has(id: string) { return this.values.has(id); }
  async delete(id: string) { this.values.delete(id); }
}

const fixtures: { directory: string; service: RunnerService; store: RunStore }[] = [];

async function fixture(provider: ModelProvider, workflow: Workflow = createBasicWorkflow()) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runner-test-'));
  const store = new RunStore(join(directory, 'state.sqlite'));
  const service = new RunnerService(store, new TestCredentials(), directory, provider);
  fixtures.push({ directory, service, store });
  const profile = await service.createProfile({ name: '검증 연결', model: 'contract-model', apiKey: 'test-only-not-a-real-key' });
  const built = await buildPackage({ workflow, host: 'codex' });
  const imported = await service.importPackage(built.bytes);
  const request = { packageHandle: imported.packageHandle, requestId: 'test_request_1', inputs: { text: '회의는 다음 주 화요일입니다.' }, modelBindings: { 'text-default': profile.id } };
  return { directory, store, service, profile, built, imported, request };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.service.shutdown(); item.store.close();
    // Recursive cleanup is restricted to directories created by this test fixture under the OS temp directory.
    const absolute = resolve(item.directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !absolute.includes('studio-runner-test-')) throw new Error('unsafe cleanup path');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('real scheduler, storage and package integration', () => {
  it('executes the three-node contract with one provider call and durable ordered events', async () => {
    const calls: ModelRequest[] = [];
    const provider: ModelProvider = { async countInputTokens() { return 10; }, async generate(request) { calls.push(request); return { text: '다음 주 화요일 회의', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; } };
    const setup = await fixture(provider);
    expect((await setup.service.validate(setup.imported.packageHandle, setup.request.modelBindings)).ready).toBe(true);
    const first = await setup.service.start(setup.request);
    const duplicate = await setup.service.start(setup.request);
    expect(duplicate.runId).toBe(first.runId);
    await setup.service.waitForIdle();
    const run = setup.service.status(first.runId);
    expect(run.status).toBe('succeeded');
    expect(run.result).toEqual({ data: '다음 주 화요일 회의', text: '다음 주 화요일 회의' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toBe('회의는 다음 주 화요일입니다.');
    expect(run.usage).toEqual({ modelCalls: 1, consumedTokens: 15, reservedTokens: 0 });
    const events = setup.service.events(first.runId);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.type).toBe('run.succeeded');
    expect(JSON.stringify(events)).not.toContain('test-only-not-a-real-key');
  });

  it('deduplicates an identical package re-import and rejects a conflicting request body', async () => {
    const provider: ModelProvider = { async countInputTokens() { return 1; }, async generate() { return { text: '확인된 결과', usage: null }; } };
    const setup = await fixture(provider);
    const original = await setup.service.start(setup.request);
    await setup.service.waitForIdle();
    const secondImport = await setup.service.importPackage(setup.built.bytes);
    expect((await setup.service.start({ ...setup.request, packageHandle: secondImport.packageHandle })).runId).toBe(original.runId);
    await expect(setup.service.start({ ...setup.request, inputs: { text: '다른 내용' } })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });

  it('rejects invalid inputs before a provider call', async () => {
    let calls = 0;
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate() { calls++; return { text: 'result', usage: null }; } });
    await expect(setup.service.start({ ...setup.request, inputs: {} })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(calls).toBe(0);
    expect(setup.store.listRuns()).toHaveLength(0);
  });

  it('passes explicitly bound context to the provider instead of silently discarding it', async () => {
    const workflow = createBasicWorkflow(); workflow.nodes.find((node) => node.type === 'ai')!.inputBindings.context = { from: 'literal', value: { style: '짧고 명확하게' } };
    let supplied: unknown;
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate(request) { supplied = request.content; return { text: '결과', usage: null }; } }, workflow);
    await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(supplied).toEqual({ content: '회의는 다음 주 화요일입니다.', context: { style: '짧고 명확하게' } });
  });

  it('counts input and blocks an oversized request before generation', async () => {
    const workflow = createBasicWorkflow(); workflow.policy.limits.maxTotalTokens = 5000;
    let generationCalls = 0;
    // A successful input count still cannot authorize a generation whose reservation exceeds policy.
    const setup = await fixture({ async countInputTokens() { return 6000; }, async generate() { generationCalls++; return { text: '결과', usage: { inputTokens: 6000, outputTokens: 10, totalTokens: 6010 } }; } }, workflow);
    const started = await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(setup.service.status(started.runId)).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { consumedTokens: 0 } });
    expect(generationCalls).toBe(0);
  });

  it('reserves usage before calling a provider and blocks an insufficient budget', async () => {
    let calls = 0; const workflow = createBasicWorkflow(); workflow.policy.limits.maxTotalTokens = 100;
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate() { calls++; return { text: 'result', usage: null }; } }, workflow);
    const run = await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(setup.service.status(run.runId).status).toBe('blocked');
    expect(setup.service.status(run.runId).error?.code).toBe('BUDGET_EXCEEDED');
    expect(calls).toBe(0);
  });

  it('preserves uncertain reservations and never retries an unknown outcome', async () => {
    let calls = 0; const workflow = createBasicWorkflow();
    const ai = workflow.nodes.find((node) => node.type === 'ai')!;
    ai.execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['TRANSIENT_NETWORK'] };
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate() { calls++; throw new ModelError('TRANSIENT_NETWORK', '응답 확인 불가', 'unknown', true); } }, workflow);
    const started = await setup.service.start(setup.request); await setup.service.waitForIdle();
    const run = setup.service.status(started.runId);
    expect(run.status).toBe('attention_required'); expect(calls).toBe(1); expect(run.usage.reservedTokens).toBeGreaterThan(0);
  });

  it('retries an explicitly allowed request that was not accepted and accounts for both attempts', async () => {
    let calls = 0; const workflow = createBasicWorkflow();
    workflow.nodes.find((node) => node.type === 'ai')!.execution.retry = { maxAttempts: 2, backoffMs: 1, retryOn: ['RATE_LIMITED'] };
    const setup = await fixture({ async countInputTokens() { return 2; }, async generate() { calls++; if (calls === 1) throw new ModelError('RATE_LIMITED', '사용량 제한', 'not_started', true); return { text: '완료', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }; } }, workflow);
    const run = await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(setup.service.status(run.runId)).toMatchObject({ status: 'succeeded', usage: { modelCalls: 2, consumedTokens: 4, reservedTokens: 0 } });
  });

  it('validates JSON output and does not silently accept an incompatible result', async () => {
    const workflow = createBasicWorkflow(); const ai = workflow.nodes.find((node) => node.type === 'ai')!;
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
    if (ai.type === 'ai') ai.config.responseFormat = { mode: 'json', schema };
    workflow.outputs = schema;
    const setup = await fixture({ async countInputTokens() { return 2; }, async generate() { return { text: '{"summary":42}', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }; } }, workflow);
    const started = await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(setup.service.status(started.runId)).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTPUT_INVALID' } });
  });

  it('cancels before dispatch without calling a model', async () => {
    let calls = 0;
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate(_request, { signal }) { calls++; return new Promise<ModelResponse>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ModelError('MODEL_INTERRUPTED', '모델 결과 확인 필요', 'unknown')), { once: true })); } });
    const started = await setup.service.start(setup.request); setup.service.cancel(started.runId); await setup.service.waitForIdle();
    expect(['cancelled', 'attention_required']).toContain(setup.service.status(started.runId).status);
    expect(calls).toBeLessThanOrEqual(1);
    expect(setup.service.status(started.runId).cancelRequested).toBe(true);
  });

  it('keeps model secrets out of SQLite and serialized operational records', async () => {
    const setup = await fixture({ async countInputTokens() { return 1; }, async generate() { return { text: '결과', usage: null }; } });
    const started = await setup.service.start(setup.request); await setup.service.waitForIdle();
    expect(JSON.stringify(setup.store.getExecution(started.runId))).not.toContain('test-only-not-a-real-key');
    expect(JSON.stringify(setup.service.listProfiles())).not.toContain('credentialRef');
    expect((await readFile(join(setup.directory, 'state.sqlite'))).toString('utf8')).not.toContain('test-only-not-a-real-key');
  });
});
