import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Binding, type FlowDefinition, type Workflow, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { CANDIDATE_VERIFIER } from '../../apps/runner/src/execution/candidate-search.js';
import { ModelError, type ModelProvider } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const made: { directory: string; store: RunStore; service: RunnerService }[] = [];
const literal = (value: unknown): Binding => ({ from: 'literal', value }) as Binding;
const input = (pointer = ''): Binding => ({ from: 'workflowInput', pointer, onMissing: 'error' });
const from = (nodeId: string): Binding => ({ from: 'node', nodeId, pointer: '/data', onMissing: 'error' });
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
const goal = { task: 'ready가 참인 후보 찾기', acceptanceSchema: { type: 'object', properties: { ready: { const: true } }, required: ['ready'] } };
const noModel: ModelProvider = { async countInputTokens(): Promise<never> { throw new Error('Pure search must not count tokens'); }, async generate(): Promise<never> { throw new Error('Pure search must not call a model'); } };

function search() {
  const value = node('candidate_search', 'search'); value.config = { mode: 'tree', verifierId: 'json-schema-v1', generatorFlowRef: { kind: 'local', flowId: 'generator' }, maxCandidates: 10, maxDepth: 3, maxVerifications: 10 };
  value.inputBindings = { goal: literal(goal), initialCandidates: input('/seeds') }; return value;
}
function flow(result: Binding, work?: WorkflowNode): FlowDefinition {
  const start = node('input', 'input'), finish = node('output', 'output'); finish.inputBindings.result = result;
  return { entryNodeId: start.id, inputs: true, outputs: true, nodes: (work ? [start, work, finish] : [start, finish]) as FlowDefinition['nodes'], edges: work ? [edge(start.id, work.id), edge(work.id, finish.id)] : [edge(start.id, finish.id)] };
}
function project(work = search(), generator = flow(literal({ candidates: [{ ready: true }] }))): Workflow {
  return { ...createBasicWorkflow('제한된 후보 탐색'), ...flow(from(work.id), work), modelProfiles: {}, subworkflows: { generator } };
}
async function fixture(definition: Workflow, host: 'codex' | 'claude-code' | 'opencode' = 'codex', provider = noModel) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-candidate-test-')); const store = new RunStore(join(directory, 'state.db'));
  const secrets = new Map<string, string>(); const credentials: CredentialStore = { available: true, async get(id) { return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, provider); const item = { directory, store, service }; made.push(item);
  const modelBindings: Record<string, string> = {};
  if (Object.keys(definition.modelProfiles).length) { const profile = await service.createProfile({ name: 'Test provider boundary', model: 'fixture-model', apiKey: 'test-only-no-live-key' }); for (const alias of Object.keys(definition.modelProfiles)) modelBindings[alias] = profile.id; }
  const built = await buildPackage({ workflow: definition, host }); const imported = await service.importPackage(built.bytes);
  return { ...item, credentials, request: { packageHandle: imported.packageHandle, requestId: `candidate-${host}`, inputs: { seeds: [] }, modelBindings } };
}
async function run(item: Awaited<ReturnType<typeof fixture>>, seeds: unknown[] = []) {
  const started = await item.service.start({ ...item.request, inputs: { seeds } }); await item.service.waitForIdle(); return item.service.status(started.runId);
}
afterEach(async () => {
  for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-candidate-test-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true }); }
});

/** Real packages, runtime, pure child nodes and SQLite prove search execution without an account or model response. */
describe('bounded tree search in Runner', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('runs actual pure generator bytes from a %s ZIP with one global leaf permit', async host => {
    const definition = project(); definition.policy.limits.maxConcurrentNodes = 1; const item = await fixture(definition, host); const status = await run(item);
    expect(status).toMatchObject({ status: 'succeeded', usage: { modelCalls: 0, consumedTokens: 0 }, result: { data: { selected: { value: { ready: true }, depth: 0 }, stopReason: 'accepted', counts: { candidates: 1, verifications: 1, generations: 1 }, verifier: CANDIDATE_VERIFIER } } });
    expect(status.childScopes).toHaveLength(1); expect(item.store.getChildScope(status.childScopes[0]!.id)).toMatchObject({ key: 'candidate:root', depth: 1, status: 'succeeded', input: { goal, parent: null, depth: 0, remaining: { candidates: 10, verifications: 10 } } });
    expect(item.store.getExecution(status.id).plan).toMatchObject({ resolved: { verifiedDependencies: { candidateVerifiers: { 'json-schema-v1': CANDIDATE_VERIFIER } } } });
    const events = item.service.events(status.id); expect(events.findIndex(event => event.type === 'candidate.generation_reserved')).toBeLessThan(events.findIndex(event => event.type === 'scope.started'));
  });
  it('checks all initial candidates before expanding and selects the first accepted value', async () => {
    const item = await fixture(project()); const status = await run(item, [{ ready: false }, { ready: true, choice: 2 }, { ready: true, choice: 3 }]);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { selected: { id: 'candidate_000002', value: { ready: true, choice: 2 } }, counts: { candidates: 3, verifications: 2, generations: 0 } } } }); expect(status.childScopes).toHaveLength(0);
  });
  it('expands in deterministic BFS order and passes parent values without incrementing call depth', async () => {
    const child = flow(input('/parent/value/next')); const item = await fixture(project(search(), child));
    const a = { name: 'A', next: { candidates: [{ name: 'A1', next: { candidates: [{ ready: true, name: 'A2' }] } }] } };
    const b = { name: 'B', next: { candidates: [{ ready: true, name: 'B1' }] } };
    const status = await run(item, [a, b]);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { selected: { depth: 1, parentId: 'candidate_000002', value: { name: 'B1' } }, counts: { candidates: 4, generations: 2, verifications: 4 } } } });
    expect(status.childScopes.map(scope => scope.depth)).toEqual([1, 1]); expect(status.childScopes.map(scope => item.store.getChildScope(scope.id).input)).toEqual(expect.arrayContaining([expect.objectContaining({ parent: { id: 'candidate_000001', depth: 0, value: a }, depth: 1 }), expect.objectContaining({ parent: { id: 'candidate_000002', depth: 0, value: b }, depth: 1 })]));
  });
  it.each(['max_candidates', 'max_verifications', 'max_depth'] as const)('returns explicit no-winner outcome at %s without fabricating success', async reason => {
    const work = search(); if (reason === 'max_candidates') work.config.maxCandidates = 1; if (reason === 'max_verifications') work.config.maxVerifications = 1; if (reason === 'max_depth') work.config.maxDepth = 1;
    const item = await fixture(project(work, flow(literal({ candidates: [false] })))); const status = await run(item, [false]);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { selected: null, stopReason: reason } } });
    expect(status.childScopes).toHaveLength(reason === 'max_depth' ? 1 : 0);
  });
  it('treats an empty generator list as exhausted and repeated values as separate tree candidates', async () => {
    const empty = await fixture(project(search(), flow(literal({ candidates: [] })))); expect(await run(empty)).toMatchObject({ result: { data: { candidates: [], selected: null, stopReason: 'exhausted', counts: { generations: 1 } } } });
    const work = search(); work.config.maxDepth = 1; const repeated = await fixture(project(work, flow(literal({ candidates: [false, false] })))); const status = await run(repeated, [false]);
    expect(status).toMatchObject({ result: { data: { counts: { candidates: 3, verifications: 3 }, stopReason: 'max_depth' } } });
  });
  it.each([{ candidates: [1], score: 1 }, [1], { candidates: 'not-array' }])('rejects malformed generator results without silently accepting them %#', async value => {
    const item = await fixture(project(search(), flow(literal(value)))); const status = await run(item);
    expect(status).toMatchObject({ status: 'failed', error: { code: 'CANDIDATE_GENERATION_INVALID' } });
    expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ status: 'failed', reservedCandidates: 10 });
  });
  it('rejects a generator overrunning its reservation and never truncates extra candidates', async () => {
    const work = search(); work.config.maxCandidates = 1; const item = await fixture(project(work, flow(literal({ candidates: [{ ready: true }, { ready: true }] })))); const status = await run(item);
    expect(status).toMatchObject({ status: 'blocked', error: { code: 'CANDIDATE_LIMIT' } }); expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ candidates: [], reservedCandidates: 1 });
  });
  it.each(['graph', 'verifier', 'goal'] as const)('blocks unsupported %s before creating a run', async kind => {
    const work = search(); if (kind === 'graph') work.config.mode = 'graph'; if (kind === 'verifier') work.config.verifierId = 'user-worker'; if (kind === 'goal') work.inputBindings.goal = literal({ task: 'x', acceptanceSchema: { pattern: 'a+' } });
    const definition = project(work); const item = await fixture(definition); expect((await item.service.validate(item.request.packageHandle, {})).ready).toBe(false); await expect(item.service.start(item.request)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' }); expect(item.store.listRuns()).toHaveLength(0);
    if (kind !== 'goal') expect(collectRequirements(definition).capabilities).toContain(kind === 'graph' ? 'candidate_search.graph@1' : 'verifier.user-worker@1');
  });
  it('enforces root node budgets while generation has its own independent candidate limit', async () => {
    const definition = project(); definition.policy.limits.maxNodeInstances = 2; const item = await fixture(definition); const status = await run(item);
    expect(status).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } }); expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ status: 'failed', reservedCandidates: 10 });
  });
  it('separates search depth two from the one permitted child-call level', async () => {
    const work = search(); const definition = project(work, flow(input('/parent/value/next'))); definition.policy.limits.maxChildDepth = 1;
    const seed = { next: { candidates: [{ next: { candidates: [{ ready: true }] } }] } }; const item = await fixture(definition); const status = await run(item, [seed]);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: { selected: { depth: 2 }, counts: { generations: 2 } } } });
    expect(status.childScopes.map(scope => scope.depth)).toEqual([1, 1]);
  });
  it('fails closed when a generator input schema rejects the actual bounded context', async () => {
    const generator = flow(literal({ candidates: [{ ready: true }] })); generator.inputs = { type: 'string' };
    const item = await fixture(project(search(), generator)); const status = await run(item);
    expect(status).toMatchObject({ status: 'failed', error: { code: 'CHILD_INPUT_INVALID' } }); expect(status.childScopes).toHaveLength(0);
    expect(item.store.candidateSearch.get(status.id, 'search').reservedCandidates).toBe(10);
  });
  it('cancels a real pure verification loop without any provider invocation', async () => {
    const work = search(); work.config.maxCandidates = 1000; work.config.maxVerifications = 1000;
    const item = await fixture(project(work)); const started = await item.service.start({ ...item.request, inputs: { seeds: Array(1000).fill(false) } });
    let observed = false;
    for (let index = 0; index < 100; index++) { if (item.service.events(started.runId).some(event => event.type === 'candidate.verified')) { observed = true; break; } await yieldTurn(); }
    expect(observed).toBe(true); item.service.cancel(started.runId); await item.service.waitForIdle();
    const status = item.service.status(started.runId), state = item.store.candidateSearch.get(started.runId, 'search');
    expect(status).toMatchObject({ status: 'cancelled', usage: { modelCalls: 0, consumedTokens: 0 } }); expect(state.status).toBe('cancelled'); expect(state.verifications).toBeGreaterThan(0); expect(state.verifications).toBeLessThan(1000); expect(state.result).toBeNull();
  });
  it('persists completed results and interrupted reservations across a real DB restart without autostart', async () => {
    const item = await fixture(project()); const status = await run(item); const completed = item.store.candidateSearch.get(status.id, 'search');
    const interrupted = item.store.createRun({ requestId: 'interrupted', requestHash: 'different', packageHandle: item.request.packageHandle, planHash: 'crash', plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['search'], maxModelCalls: 1, maxTotalTokens: 5000 }); item.store.transitionRun(interrupted.id, 'running');
    let state = item.store.candidateSearch.begin(interrupted.id, 'search', 'hash', { maxCandidates: 3, maxDepth: 2, maxVerifications: 3 }, CANDIDATE_VERIFIER, []); state = item.store.candidateSearch.reserveGeneration(interrupted.id, 'search', state.revision, null);
    await item.service.shutdown(); item.store.close(); const reopened = new RunStore(join(item.directory, 'state.db')); const service = new RunnerService(reopened, item.credentials, item.directory, noModel); Object.assign(made.find(value => value.directory === item.directory)!, { store: reopened, service });
    reopened.recoverInterruptedRuns(); await service.waitForIdle();
    expect(reopened.candidateSearch.get(status.id, 'search')).toEqual(completed); expect(reopened.candidateSearch.get(interrupted.id, 'search')).toMatchObject({ status: 'attention_required', reservedCandidates: 3, generations: 1 }); expect(reopened.listChildScopes(interrupted.id)).toHaveLength(0);
    const duplicate = await service.start(item.request); expect(duplicate.runId).toBe(status.id); expect(service.status(status.id).childScopes).toHaveLength(1);
  });
});

/** Test-only provider boundaries exercise cancellation and uncertain outcomes; no product fallback or live API is used. */
describe('candidate generation protected outcomes', () => {
  function modelProject() { const ai = node('ai', 'ai'); ai.config.responseFormat = { mode: 'json', schema: true }; ai.inputBindings.content = input(); const definition = project(search(), flow(from(ai.id), ai)); definition.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['json_schema'] } }; return definition; }
  it.each(['calls', 'tokens'] as const)('shares root %s budget across successive candidate generations', async kind => {
    let calls = 0; const definition = modelProject(); if (kind === 'calls') definition.policy.limits.maxModelCalls = 1; else definition.policy.limits.maxTotalTokens = 1025;
    const item = await fixture(definition, 'codex', { async countInputTokens() { return 1; }, async generate() { calls++; return { text: '{"candidates":[false]}', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } });
    const status = await run(item); expect(calls).toBe(1); expect(status).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { modelCalls: 1, consumedTokens: 2 } });
    expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ status: 'failed', generations: 2, verifications: 1, reservedCandidates: 9 });
  });
  it('retains both candidate and model reservations for unknown outcomes and never retries the parent', async () => {
    let calls = 0; const definition = modelProject(); definition.nodes.find(value => value.type === 'candidate_search')!.execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['PROVIDER_UNAVAILABLE'] };
    const item = await fixture(definition, 'codex', { async countInputTokens() { return 1; }, async generate() { calls++; throw new ModelError('PROVIDER_UNAVAILABLE', 'test-only unknown response', 'unknown', true); } });
    const status = await run(item); expect(status).toMatchObject({ status: 'attention_required', usage: { modelCalls: 1, reservedTokens: 1025 } }); expect(calls).toBe(1);
    expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ status: 'attention_required', generations: 1, reservedCandidates: 10 }); expect(status.childScopes[0]!.status).toBe('attention_required');
  });
  it('cancels an active generator and retains the interrupted candidate reservation', async () => {
    let notify!: () => void; const ready = new Promise<void>(resolve => { notify = resolve; }); let calls = 0;
    const item = await fixture(modelProject(), 'codex', { async countInputTokens() { return 1; }, async generate(_request, context) { calls++; notify(); await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => resolve(), { once: true }); if (context.signal.aborted) resolve(); }); throw new ModelError('MODEL_NOT_STARTED', 'test-only pre-send cancellation', 'not_started'); } });
    const started = await item.service.start(item.request); await ready; item.service.cancel(started.runId); await item.service.waitForIdle(); const status = item.service.status(started.runId);
    expect(status.status).toBe('cancelled'); expect(calls).toBe(1); expect(item.store.candidateSearch.get(status.id, 'search')).toMatchObject({ status: 'cancelled', reservedCandidates: 10, generations: 1 }); expect(status.childScopes.every(scope => scope.status !== 'running')).toBe(true);
  });
});
