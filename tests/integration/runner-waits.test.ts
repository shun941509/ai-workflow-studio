// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunnerService, type StartRequest } from '../../apps/runner/src/service.js';
import type { ModelProvider } from '../../apps/runner/src/providers/model-provider.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const edge = (from: string, to: string, port = 'next'): WorkflowEdge => ({ id: `${from}_${port}_${to}`, from: { nodeId: from, port }, to: { nodeId: to, port: 'in' } });
function node<T extends WorkflowNode['type']>(type: T, id: string) { return { ...createNode(type), id } as Extract<WorkflowNode, { type: T }>; }
function formFlow(initial = false): Workflow {
  const input = node('input', 'input'), ai = node('ai', 'ai'), form = node('form', 'form'), output = node('output', 'output');
  ai.inputBindings.content = { from: 'workflowInput', pointer: '/text', onMissing: 'error' };
  form.config = initial ? { mode: 'initial', title: '초기 입력' } : { mode: 'request', title: '답변해 주세요', schema };
  form.inputBindings.context = { from: 'node', nodeId: 'ai', pointer: '/data', onMissing: 'error' }; output.inputBindings.result = { from: 'node', nodeId: 'form', pointer: '/data', onMissing: 'error' };
  if (initial) { form.inputBindings = {}; return { ...createBasicWorkflow(), entryNodeId: 'form', nodes: [form, output], edges: [edge('form', 'output')], outputs: true, modelProfiles: {} }; }
  return { ...createBasicWorkflow(), entryNodeId: 'input', nodes: [input, ai, form, output], edges: [edge('input', 'ai'), edge('ai', 'form'), edge('form', 'output')], outputs: true };
}
function reviewFlow(): Workflow {
  const input = node('input', 'input'), review = node('review', 'review'), accepted = node('transform', 'accepted'), rejected = node('transform', 'rejected'), merge = node('merge', 'merge'), output = node('output', 'output');
  review.config = { question: '결과가 적절한가요?', responseSchema: schema }; review.inputBindings.value = { from: 'workflowInput', pointer: '/text', onMissing: 'error' };
  for (const branch of [accepted, rejected]) { branch.inputBindings.value = { from: 'node', nodeId: 'review', pointer: '/data', onMissing: 'error' }; branch.config = { steps: [{ op: 'pick', options: { keys: ['decision', 'feedback'] } }], resultSchema: true }; }
  merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = { accepted: { from: 'node', nodeId: 'accepted', pointer: '/data', onMissing: 'omit' }, rejected: { from: 'node', nodeId: 'rejected', pointer: '/data', onMissing: 'omit' } }; output.inputBindings.result = { from: 'node', nodeId: 'merge', pointer: '/data', onMissing: 'error' };
  return { ...createBasicWorkflow(), entryNodeId: 'input', nodes: [input, review, accepted, rejected, merge, output], edges: [edge('input', 'review'), edge('review', 'accepted', 'accepted'), edge('review', 'rejected', 'rejected'), edge('accepted', 'merge'), edge('rejected', 'merge'), edge('merge', 'output')], outputs: true, modelProfiles: {} };
}

interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; provider: ModelProvider; request: StartRequest; calls: () => number }
const fixtures: Fixture[] = [];
/** External model and secret storage are test boundaries; waiting state and restart use a real SQLite file. */
async function setup(definition = formFlow()): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-wait-test-')); const secrets = new Map<string, string>(); let calls = 0;
  const credentials: CredentialStore = { available: true, async set(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async delete(id) { secrets.delete(id); } };
  const provider = { async countInputTokens() { return 4; }, async generate() { calls++; return { text: '실제 작업 이전의 확인된 결과', usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } }; } };
  const store = new RunStore(join(directory, 'state.sqlite')); const service = new RunnerService(store, credentials, directory, provider);
  const profile = await service.createProfile({ name: 'test', model: 'contract-model', apiKey: 'fixed-test-value' }); const built = await buildPackage({ workflow: definition, host: 'codex' }); const imported = await service.importPackage(built.bytes);
  const request = { packageHandle: imported.packageHandle, requestId: 'waiting-run', inputs: { text: '검토 자료' }, modelBindings: Object.fromEntries(Object.keys(definition.modelProfiles).map((alias) => [alias, profile.id])) };
  const result = { directory, store, service, credentials, provider, request, calls: () => calls }; fixtures.push(result); return result;
}
async function restart(item: Fixture) {
  await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite'));
  const recovered = item.store.recoverInterruptedRuns(); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); await item.service.restoreWaitingRuns(); return recovered;
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-wait-test-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('persistent input and content-review waiting', () => {
  it('returns root inputs directly for form.initial', async () => {
    const item = await setup(formFlow(true)); const started = await item.service.start(item.request); await item.service.waitForIdle();
    expect(item.service.status(started.runId)).toMatchObject({ status: 'succeeded', result: { data: item.request.inputs }, waits: [] });
  });

  it('restores the same pending wait and completed model result after a real database restart', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    expect(wait).toMatchObject({ kind: 'input', nodeId: 'form', requestId: item.request.requestId, state: 'pending' }); expect(wait.planHash).toHaveLength(64); expect(item.calls()).toBe(1);
    expect(await restart(item)).toBe(0); expect(item.service.status(run.runId).waits[0]!.id).toBe(wait.id); expect(item.calls()).toBe(1);
    item.service.respondWait(run.runId, wait.id, { requestId: 'reply', response: { answer: '확인했습니다' } }); await item.service.waitForIdle();
    expect(item.service.status(run.runId)).toMatchObject({ status: 'succeeded', result: { data: { answer: '확인했습니다' } } }); expect(item.calls()).toBe(1);
    const completedInput = item.service.events(run.runId).filter((event) => event.type === 'node.status' && (event.payload as { nodeId: string; status: string }).nodeId === 'input' && (event.payload as { status: string }).status === 'succeeded'); expect(completedInput).toHaveLength(1);
  });

  it('deduplicates simultaneous identical responses and rejects a conflicting body or another response ID', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!; const reply = { requestId: 'same-response', response: { answer: '한 번만' } };
    const answers = await Promise.all([Promise.resolve().then(() => item.service.respondWait(run.runId, wait.id, reply)), Promise.resolve().then(() => item.service.respondWait(run.runId, wait.id, reply))]); expect(answers[0]!.waitId).toBe(answers[1]!.waitId);
    expect(() => item.service.respondWait(run.runId, wait.id, { ...reply, response: { answer: '변경' } })).toThrow(/다른 내용/);
    expect(() => item.service.respondWait(run.runId, wait.id, { ...reply, requestId: 'second-response' })).toThrow(/이미 종료/);
    await item.service.waitForIdle(); expect(item.calls()).toBe(1); expect(item.store.getWait(wait.id).state).toBe('consumed');
    expect(item.service.respondWait(run.runId, wait.id, reply).state).toBe('consumed');
  });

  it('validates response schemas and rejects caller-supplied actor identities without leaving the wait', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    expect(() => item.service.respondWait(run.runId, wait.id, { requestId: 'wrong', response: { answer: 7 } })).toThrow(/입력 형식/);
    expect(() => item.service.respondWait(run.runId, wait.id, { requestId: 'actor', response: { answer: 'yes' }, actor: 'administrator' })).toThrow(/응답 ID/);
    expect(item.store.getWait(wait.id).state).toBe('pending'); expect(item.service.status(run.runId).status).toBe('waiting');
  });

  it('accepts only one of two competing response identities', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    const results = await Promise.allSettled(['first', 'second'].map((name) => Promise.resolve().then(() => item.service.respondWait(run.runId, wait.id, { requestId: name, response: { answer: name } }))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1); await item.service.waitForIdle();
    expect(item.service.events(run.runId).filter((event) => event.type === 'wait.responded')).toHaveLength(1); expect(item.calls()).toBe(1);
  });

  it('restores a committed but unconsumed reply and resumes only the remaining nodes', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    item.store.acceptWaitResponse(run.runId, wait.id, 'committed-reply', { answer: '저장된 답변' });
    await restart(item); await item.service.waitForIdle(); expect(item.service.status(run.runId)).toMatchObject({ status: 'succeeded', result: { data: { answer: '저장된 답변' } } }); expect(item.calls()).toBe(1);
  });

  it('cancels a wait atomically and refuses later replies', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    expect(item.service.cancel(run.runId).status).toBe('cancelled'); expect(item.store.getWait(wait.id).state).toBe('cancelled');
    expect(() => item.service.respondWait(run.runId, wait.id, { requestId: 'late', response: { answer: 'late' } })).toThrow(/이미 종료/); expect(item.calls()).toBe(1);
  });

  it('expires an unanswered wait without inventing a response', async () => {
    const definition = formFlow(); definition.nodes.find((node) => node.type === 'form')!.execution.waitTtlMs = 1000;
    const item = await setup(definition); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    await restart(item);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1150)); expect(item.store.getWait(wait.id).state).toBe('expired'); expect(item.service.status(run.runId)).toMatchObject({ status: 'failed', error: { code: 'WAIT_EXPIRED' }, result: null });
  });

  it('excludes a long wait from active time and retains accumulated active time after restart', async () => {
    const definition = formFlow(); definition.policy.limits.maxActiveMs = 1000;
    const item = await setup(definition); const run = await item.service.start(item.request); await item.service.waitForIdle(); const before = item.service.status(run.runId); const wait = before.waits[0]!;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1150)); expect(item.service.status(run.runId).activeMs).toBe(before.activeMs);
    await restart(item); expect(item.service.status(run.runId).activeMs).toBe(before.activeMs);
    item.service.respondWait(run.runId, wait.id, { requestId: 'after-wait', response: { answer: '응답' } }); await item.service.waitForIdle(); expect(item.service.status(run.runId).status).toBe('succeeded'); expect(item.service.status(run.runId).activeMs).toBeLessThan(1000);
  });

  it('does not reset an already consumed active budget when resuming', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    // Model a prior durable active segment; resumption must trust persisted usage, not reset its deadline.
    item.store.checkpointActiveTime(run.runId, 86400001, true); item.service.respondWait(run.runId, wait.id, { requestId: 'over-budget', response: { answer: '응답' } }); await item.service.waitForIdle();
    expect(item.service.status(run.runId)).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
  });

  it.each(['accepted', 'rejected'] as const)('follows the explicit %s content-review branch without granting permissions', async (decision) => {
    const item = await setup(reviewFlow()); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    item.service.respondWait(run.runId, wait.id, { requestId: 'review-response', decision, response: { answer: '검토 의견' } }); await item.service.waitForIdle(); const status = item.service.status(run.runId);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { decision, feedback: { answer: '검토 의견' } } } }); expect(status.nodes).toContainEqual({ nodeId: decision === 'accepted' ? 'rejected' : 'accepted', status: 'skipped' }); expect(status.result).not.toHaveProperty('effects');
  });

  it('allows only the local cookie/CSRF browser route to answer, never a bridge bearer', async () => {
    const item = await setup(); const run = await item.service.start(item.request); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
    const server = createLocalServer(item.service, { bearerToken: 'test-bridge-only' }); const { origin } = await server.listen(); const path = `${origin}/api/runs/${run.runId}/waits/${wait.id}/responses`; const body = JSON.stringify({ requestId: 'browser-reply', response: { answer: 'UI 답변' } });
    try {
      expect((await fetch(path, { method: 'POST', headers: { authorization: 'Bearer test-bridge-only', 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' }, body })).status).toBe(403);
      const bootstrap = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin', 'x-studio-client': 'local-ui' }, body: '{}' });
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!; const { csrf } = await bootstrap.json() as { csrf: string }; const headers = { cookie, 'x-studio-csrf': csrf, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', origin };
      expect((await fetch(path, { method: 'POST', headers: { ...headers, authorization: 'Bearer test-bridge-only' }, body })).status).toBe(403);
      expect((await fetch(path, { method: 'POST', headers, body })).status).toBe(202); await item.service.waitForIdle(); expect(item.service.status(run.runId).status).toBe('succeeded');
    } finally { await server.close(); }
  });
});
