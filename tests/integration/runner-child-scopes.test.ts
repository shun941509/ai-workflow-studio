// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type FlowDefinition, type WorkflowEdge, type Binding } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore, scopedKey } from '../../apps/runner/src/state/store.js';
import { ModelError, type ModelProvider } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const made: { directory: string; store: RunStore; service: RunnerService }[] = [];
const literal = (value: unknown) => ({ from: 'literal', value }) as Binding;
const input = (pointer = '') => ({ from: 'workflowInput', pointer, onMissing: 'error' }) as Binding;
const from = (id: string) => ({ from: 'node', nodeId: id, pointer: '/data', onMissing: 'error' }) as Binding;
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const edge = (source: string, target: string, port = 'next'): WorkflowEdge => ({ id: `${source}_${port}_${target}`, from: { nodeId: source, port }, to: { nodeId: target, port: 'in' } });
const ref = (flowId = 'child') => ({ kind: 'local' as const, flowId });

/** Test flows use the same local IDs deliberately; only production scope keys prevent state collisions. */
function flow(work?: WorkflowNode, binding: Binding = input()): FlowDefinition {
  const entry = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = work ? from(work.id) : binding;
  return { entryNodeId: entry.id, inputs: true, outputs: true, nodes: (work ? [entry, work, output] : [entry, output]) as FlowDefinition['nodes'], edges: work ? [edge(entry.id, work.id), edge(work.id, output.id)] : [edge(entry.id, output.id)] };
}
function project(work: WorkflowNode, child = flow()): Workflow { return { ...createBasicWorkflow('하위 실행 검증'), ...flow(work), modelProfiles: {}, subworkflows: { child } }; }
function call(id = 'call', flowId = 'child') { const value = node('subworkflow', id); value.config.flowRef = ref(flowId); value.inputBindings.input = input(); return value; }
function loop(mode: 'foreach' | 'until' = 'foreach') { const value = node('loop', 'loop'); value.config = { mode, bodyFlowRef: ref(), maxIterations: 3, ...(mode === 'until' ? { untilExpression: { literal: false } } : {}) }; value.inputBindings = mode === 'foreach' ? { items: input('/items') } : { state: input('/state') }; return value; }
function parallel(ids = ['first', 'second', 'third']) { const value = node('parallel', 'parallel'); value.config = { branches: ids.map((id) => ({ id, flowRef: ref() })) as typeof value.config.branches, mode: 'all', maxConcurrency: 3, failurePolicy: 'fail_fast' }; value.inputBindings.branches = literal(Object.fromEntries(ids.map((id) => [id, id]))); return value; }
function ai() { const value = node('ai', 'work'); value.inputBindings.content = input('/input'); return value; }
function modelProject(work = parallel()) { const value = project(work, flow(ai())); value.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } }; return value; }

async function fixture(definition: Workflow, provider: ModelProvider = { async countInputTokens(): Promise<never> { throw new Error('Pure workflows cannot request model token counts'); }, async generate() { throw new Error('Pure workflows cannot call a model'); } }) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-child-test-')); const store = new RunStore(join(directory, 'state.sqlite'));
  const secrets = new Map<string, string>(); const credentials: CredentialStore = { available: true, async get(id) { return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, provider); const item = { directory, store, service }; made.push(item);
  const profile = await service.createProfile({ name: 'test', model: 'contract-model', apiKey: 'fixed-test-only-key' });
  const built = await buildPackage({ workflow: definition, host: 'codex' }); const imported = await service.importPackage(built.bytes);
  const request = { packageHandle: imported.packageHandle, requestId: 'children-test', inputs: {}, modelBindings: Object.fromEntries(Object.keys(definition.modelProfiles).map((alias) => [alias, profile.id])) };
  return { ...item, request, credentials };
}
async function run(item: Awaited<ReturnType<typeof fixture>>, inputs: unknown = {}) { const started = await item.service.start({ ...item.request, inputs }); await item.service.waitForIdle(); return item.service.status(started.runId); }
afterEach(async () => { for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-child-test-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); } });

describe('local child scope execution', () => {
  it('uses child input and output schemas instead of leaking the root input', async () => {
    const work = call(); work.inputBindings.input = literal({ answer: 42 }); const child = flow(undefined, input('/answer')); child.inputs = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false }; child.outputs = { type: 'number' };
    const item = await fixture(project(work, child)); const status = await run(item, { secretRootValue: 'not a child input' });
    expect(status).toMatchObject({ status: 'succeeded', result: { data: 42 } }); expect(status.childScopes).toHaveLength(1); expect(status.childScopes[0]).toMatchObject({ depth: 1, key: 'call', status: 'succeeded' }); expect(status.nodes).toHaveLength(3);
    expect(item.store.graphState(status.id, status.childScopes[0]!.id).nodes).toHaveLength(2);
  });

  it('isolates repeated local node IDs and records real nested depths', async () => {
    const definition = project(call(), flow(call('call', 'grandchild'))); definition.subworkflows.grandchild = flow();
    const item = await fixture(definition); const status = await run(item, 5); expect(status).toMatchObject({ status: 'succeeded', result: { data: 5 } });
    expect(status.childScopes.map((scope) => scope.depth).sort()).toEqual([1, 2]); expect(new Set(status.childScopes.map((scope) => scope.id)).size).toBe(2);
    for (const scope of status.childScopes) expect(item.store.graphState(status.id, scope.id).nodes.every((entry) => entry.status === 'succeeded')).toBe(true);
  });

  it('returns foreach results in snapshot order and gives each iteration its own scope', async () => {
    const item = await fixture(project(loop(), flow())); const status = await run(item, { items: ['z', null, false] });
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { results: [{ item: 'z', index: 0, context: null }, { item: null, index: 1, context: null }, { item: false, index: 2, context: null }], iterations: 3, reason: 'completed' } } });
    expect(status.childScopes.map((scope) => scope.key).sort()).toEqual(['item:0', 'item:1', 'item:2']);
  });

  it.each([0, 4])('handles a list of %i items without silently truncating it', async (size) => {
    const item = await fixture(project(loop())); const status = await run(item, { items: Array(size).fill(1) }); expect(status.childScopes).toHaveLength(0);
    if (!size) expect(status).toMatchObject({ status: 'succeeded', result: { data: { results: [], iterations: 0 } } }); else expect(status).toMatchObject({ status: 'blocked', error: { code: 'LOOP_LIMIT' } });
  });

  it.each([true, false])('checks the until condition after each body and records termination (%s)', async (finish) => {
    const work = loop('until'); work.config.untilExpression = finish ? { op: 'gte', args: [{ var: '/iteration' }, { literal: 2 }] } : { literal: false };
    const item = await fixture(project(work, flow(undefined, input('/iteration')))); const status = await run(item, { state: 'initial' });
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { results: finish ? [1, 2] : [1, 2, 3], finalState: finish ? 2 : 3, iterations: finish ? 2 : 3, reason: finish ? 'condition_met' : 'max_iterations' } } });
    expect(item.store.listChildScopes(status.id).find((scope) => scope.key === 'iteration:2')!.input).toEqual({ state: 1, iteration: 2, context: null });
  });

  it('counts child nodes in the root node budget', async () => {
    const definition = project(loop()); definition.policy.limits.maxNodeInstances = 5; const item = await fixture(definition); const status = await run(item, { items: [1, 2, 3] });
    expect(status).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } }); expect(status.childScopes.filter((scope) => scope.status === 'succeeded')).toHaveLength(1); expect(status.result).toBeNull();
  });

  it('rejects a child input mismatch before creating a scope or executing any child', async () => {
    const child = flow(); child.inputs = { type: 'number' }; const item = await fixture(project(call(), child)); const status = await run(item, 'wrong');
    expect(status).toMatchObject({ status: 'failed', error: { code: 'CHILD_INPUT_INVALID' } }); expect(status.childScopes).toHaveLength(0);
  });

  it('does not advertise external flow or first-match modes and rejects child user waits in preflight', async () => {
    const form = node('form', 'request'); form.config = { mode: 'request', title: '답변', schema: true }; const item = await fixture(project(call(), flow(form)));
    expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).issues.map((issue) => issue.code)).toContain('CHILD_WAIT_UNSUPPORTED'); expect(item.service.capabilities).not.toContain('flow.package@1'); expect(item.service.capabilities).not.toContain('parallel.first_match@1');
  });

  it('rejects unsupported first-match before creating a run', async () => {
    const work = parallel(); work.config.mode = 'first_match'; work.config.matchExpression = { literal: true }; const item = await fixture(project(work));
    expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).issues.some((issue) => issue.code === 'CAPABILITY_MISSING' && issue.message.includes('parallel.first_match@1'))).toBe(true);
    await expect(item.service.start(item.request)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' }); expect(item.store.listRuns()).toHaveLength(0);
  });

  it.each(['recursive', 'too-deep'])('rejects %s local flow graphs before packaging', async (kind) => {
    const definition = project(call(), flow(call('nested', kind === 'recursive' ? 'child' : 'grandchild'))); if (kind === 'too-deep') { definition.subworkflows.grandchild = flow(); definition.policy.limits.maxChildDepth = 1; }
    await expect(buildPackage({ workflow: definition, host: 'codex' })).rejects.toThrow();
  });
});

describe('bounded parallel children', () => {
  it('runs actual overlapping work within the root and local limits, but returns declaration order', async () => {
    let active = 0, maximum = 0; const finished: string[] = []; const definition = modelProject(); definition.policy.limits.maxConcurrentNodes = 2;
    const item = await fixture(definition, { async countInputTokens() { return 1; }, async generate(request) { active++; maximum = Math.max(maximum, active); const name = String(request.content); await delay(name === 'first' ? 40 : 5); finished.push(name); active--; return { text: name, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const status = await run(item);
    expect(maximum).toBe(2); expect(finished[0]).toBe('second'); expect(status).toMatchObject({ status: 'succeeded', usage: { modelCalls: 3, consumedTokens: 6 }, result: { data: { branches: ['first', 'second', 'third'].map((id) => ({ id, status: 'succeeded', result: id })) } } });
  });

  it('lets nested parents wait without monopolizing the single global leaf permit', async () => {
    const definition = project(parallel(['first', 'second']), flow(call('nested', 'grandchild'))); definition.subworkflows.grandchild = flow(); definition.policy.limits.maxConcurrentNodes = 1;
    const item = await fixture(definition); const status = await run(item); expect(status.status).toBe('succeeded'); expect(status.childScopes.filter((scope) => scope.depth === 2)).toHaveLength(2);
  });

  it('honors a smaller local concurrency limit even when root permits are available', async () => {
    let active = 0, maximum = 0; const work = parallel(); work.config.maxConcurrency = 1; const item = await fixture(modelProject(work), { async countInputTokens() { return 1; }, async generate(request) { maximum = Math.max(maximum, ++active); await delay(2); active--; return { text: String(request.content), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } });
    expect((await run(item)).status).toBe('succeeded'); expect(maximum).toBe(1);
  });

  it('atomically shares the root model-call budget across concurrent branches', async () => {
    let calls = 0; const definition = modelProject(); definition.policy.limits.maxModelCalls = 1;
    const item = await fixture(definition, { async countInputTokens() { return 1; }, async generate() { calls++; await delay(5); return { text: 'started', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const status = await run(item);
    expect(calls).toBe(1); expect(status.status).toBe('blocked'); expect(status.error?.code).toBe('BUDGET_EXCEEDED'); expect(status.childScopes.every((scope) => scope.status !== 'running')).toBe(true);
  });

  it('holds shared token reservations while concurrent children are still running', async () => {
    // Each fixture reserves 1 counted input token + 1024 maximum output tokens; only one fits.
    let calls = 0; const definition = modelProject(); definition.policy.limits.maxTotalTokens = 1500;
    const item = await fixture(definition, { async countInputTokens() { return 1; }, async generate() { calls++; await delay(5); return { text: 'one', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const status = await run(item);
    expect(calls).toBe(1); expect(status).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
  });

  it('collects confirmed business failures but keeps success values and failure codes explicit', async () => {
    const work = node('transform', 'work'); work.inputBindings.value = input('/input'); work.config = { steps: [{ op: 'pick', options: { keys: ['x'] } }], resultSchema: true }; const branches = parallel(['valid', 'invalid']); branches.config.failurePolicy = 'collect'; branches.inputBindings.branches = literal({ valid: { x: 1 }, invalid: {} });
    const item = await fixture(project(branches, flow(work))); const status = await run(item);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { branches: [{ id: 'valid', status: 'succeeded', result: { x: 1 } }, { id: 'invalid', status: 'failed', error: { code: 'TRANSFORM_MISSING_FIELD' } }] } } });
  });

  it('cannot collect a guardrail stop into a successful parent', async () => {
    const work = node('guardrail', 'work'); work.inputBindings.value = literal('x'); work.config = { rules: [{ id: 'minimum', kind: 'length', parameters: { min: 10 } }], onViolation: 'block' }; const branches = parallel(); branches.config.failurePolicy = 'collect';
    const item = await fixture(project(branches, flow(work))); const status = await run(item); expect(status).toMatchObject({ status: 'blocked', error: { code: 'GUARDRAIL_BLOCKED' } }); expect(status.result).toBeNull();
  });

  it('drains an uncertain sibling and makes the whole root require attention', async () => {
    let settled = 0; const branches = parallel(['first', 'second']); branches.config.failurePolicy = 'collect';
    const item = await fixture(modelProject(branches), { async countInputTokens() { return 1; }, async generate(request, context) { if (request.content === 'first') { await delay(20); throw new ModelError('MODEL_OUTPUT_INVALID', '확인할 수 없는 외부 결과', 'unknown'); } await new Promise<void>((done) => context.signal.addEventListener('abort', () => { settled++; done(); }, { once: true })); throw new ModelError('MODEL_NETWORK_ERROR', '중단된 외부 결과', 'unknown'); } }); const status = await run(item);
    expect(settled).toBe(1); expect(status.status).toBe('attention_required'); expect(status.usage.reservedTokens).toBeGreaterThan(0); expect(status.childScopes.every((scope) => scope.status !== 'running')).toBe(true);
  });

  it('cancels and drains all started children without starting the remaining branch', async () => {
    let calls = 0, settled = 0; let notify!: () => void; const ready = new Promise<void>((done) => { notify = done; }); const definition = modelProject(); definition.policy.limits.maxConcurrentNodes = 2;
    const item = await fixture(definition, { async countInputTokens() { return 1; }, async generate(_request, context) { if (++calls === 2) notify(); await new Promise<void>((done) => context.signal.addEventListener('abort', () => { settled++; done(); }, { once: true })); throw new ModelError('MODEL_NOT_STARTED', '전송 전 취소', 'not_started'); } });
    const started = await item.service.start(item.request); await ready; item.service.cancel(started.runId); await item.service.waitForIdle(); const status = item.service.status(started.runId);
    expect(calls).toBe(2); expect(settled).toBe(2); expect(status.status).toBe('cancelled'); expect(status.childScopes.every((scope) => scope.status !== 'running')).toBe(true);
  });
});

describe('child scope durability', () => {
  it('restores completed child data and marks interrupted scopes for attention without replay', async () => {
    const item = await fixture(project(call())); const status = await run(item, { durable: true }); const existing = item.store.listChildScopes(status.id)[0]!;
    // A second created root simulates a crash after a child starts; no provider process is involved.
    const record = item.store.createRun({ requestId: 'crash', requestHash: 'crash', packageHandle: item.request.packageHandle, planHash: 'crash', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['owner'], edges: [], maxModelCalls: 10, maxTotalTokens: 10000 }); item.store.transitionRun(record.id, 'running');
    const child = item.store.createChildScope({ runId: record.id, parentScopeId: 'main', ownerNodeId: 'owner', key: 'call', flowId: 'child', depth: 1, flow: flow(), input: {} }); item.store.transitionNode(record.id, 'owner', 'waiting_children'); item.store.transitionNode(record.id, scopedKey(child.id, 'input'), 'running');
    item.store.close(); const reopened = new RunStore(join(item.directory, 'state.sqlite')); made.find((value) => value.directory === item.directory)!.store = reopened; made.find((value) => value.directory === item.directory)!.service = new RunnerService(reopened, item.credentials, item.directory);
    reopened.recoverInterruptedRuns(); expect(reopened.getRun(record.id).status).toBe('attention_required'); expect(reopened.getChildScope(child.id).status).toBe('attention_required'); expect(reopened.getChildScope(existing.id).result).toEqual({ data: { durable: true } }); expect(reopened.graphState(record.id).nodes[0]!.status).toBe('reconciling');
    expect(reopened.createChildScope({ runId: record.id, parentScopeId: 'main', ownerNodeId: 'owner', key: 'call', flowId: 'child', depth: 1, flow: flow(), input: {} }).fresh).toBe(false);
    expect(() => reopened.createChildScope({ runId: record.id, parentScopeId: 'main', ownerNodeId: 'owner', key: 'call', flowId: 'child', depth: 1, flow: flow(), input: { changed: true } })).toThrow();
  });
});
