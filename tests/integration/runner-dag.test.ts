// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowEdge, type WorkflowNode, type Binding } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import { ModelError, type ModelProvider, type ModelRequest } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const made: { directory: string; store: RunStore; service: RunnerService }[] = [];
const literal = (value: unknown) => ({ from: 'literal', value }) as Binding;
const from = (nodeId: string, onMissing: 'error' | 'omit' = 'error') => ({ from: 'node', nodeId, pointer: '/data', onMissing }) as Binding;
function node<T extends WorkflowNode['type']>(type: T, id: string): Extract<WorkflowNode, { type: T }> { return { ...createNode(type), id } as Extract<WorkflowNode, { type: T }>; }
function edge(source: string, target: string, port = 'next'): WorkflowEdge { return { id: `${source}_${port}_${target}`, from: { nodeId: source, port }, to: { nodeId: target, port: 'in' } }; }
function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { ...createBasicWorkflow('DAG 통합 검증'), entryNodeId: 'input', nodes: nodes as Workflow['nodes'], edges, outputs: true, modelProfiles: {} };
}
function formatted(id: string, value: string) {
  const result = node('transform', id); result.inputBindings.value = literal({}); result.config = { steps: [{ op: 'format', options: { template: value } }], resultSchema: { type: 'string' } }; return result;
}

/** The only external boundary replaced here is a model account; graph execution and durable state are production code. */
async function fixture(definition: Workflow, provider: ModelProvider = { async countInputTokens(): Promise<never> { throw new Error('Pure workflows cannot request model token counts'); }, async generate() { throw new Error('A pure workflow must not call a model'); } }) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-dag-test-')); const store = new RunStore(join(directory, 'state.sqlite'));
  const secrets = new Map<string, string>(); const credentials: CredentialStore = { available: true, async set(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async delete(id) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, provider); made.push({ directory, store, service });
  const profile = await service.createProfile({ name: 'test', model: 'contract-model', apiKey: 'fixed-test-only-key' });
  const built = await buildPackage({ workflow: definition, host: 'codex' }); const imported = await service.importPackage(built.bytes);
  const request = { packageHandle: imported.packageHandle, requestId: 'dag-case', inputs: { text: 'yes' }, modelBindings: Object.fromEntries(Object.keys(definition.modelProfiles).map((alias) => [alias, profile.id])) };
  return { directory, store, service, request };
}

afterEach(async () => { for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-dag-test-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); } });

function branching() {
  const input = node('input', 'input'), condition = node('condition', 'condition'), yes = formatted('yes', '선택한 참 경로'), no = formatted('no', '선택한 거짓 경로'), merge = node('merge', 'merge'), output = node('output', 'output');
  condition.inputBindings.value = { from: 'workflowInput', pointer: '/text', onMissing: 'error' }; condition.config.expression = { op: 'eq', args: [{ var: '/value' }, { literal: 'yes' }] };
  merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = { yes: from('yes', 'omit'), no: from('no', 'omit') }; output.inputBindings.result = from('merge');
  // Intentionally reverse visual order: readiness must depend on edges, not array position.
  return workflow([output, merge, no, condition, input, yes], [edge('input', 'condition'), edge('condition', 'yes', 'true'), edge('condition', 'no', 'false'), edge('yes', 'merge'), edge('no', 'merge'), edge('merge', 'output')]);
}

function errorFlow(kind: 'transform' | 'guardrail' | 'ai' = 'transform', rethrow = false) {
  const input = node('input', 'input'), work = node(kind, 'work'), success = formatted('success', '원래 결과'), recovery = node('error', 'recovery'), merge = node('merge', 'merge'), output = node('output', 'output');
  if (work.type === 'transform') { work.inputBindings.value = literal({}); work.config = { steps: [{ op: 'pick', options: { keys: ['absent'] } }], resultSchema: true }; }
  if (work.type === 'guardrail') { work.inputBindings.value = literal('X'); work.config = { rules: [{ id: 'minimum', kind: 'length', parameters: { min: 2 } }], onViolation: 'block' }; }
  if (work.type === 'ai') work.inputBindings.content = literal('요청');
  work.execution.onError = 'route'; recovery.config.mode = rethrow ? 'rethrow' : 'recover'; recovery.inputBindings.error = { from: 'error', pointer: '', onMissing: 'error' };
  if (!rethrow) recovery.inputBindings.fallback = literal(null);
  merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = { success: from('success', 'omit'), ...(!rethrow ? { recovered: from('recovery', 'omit') } : {}) }; output.inputBindings.result = from('merge');
  const definition = workflow([output, recovery, merge, work, success, input], [edge('input', 'work'), edge('work', 'success'), edge('work', 'recovery', 'error'), edge('success', 'merge'), ...(!rethrow ? [edge('recovery', 'merge')] : []), edge('merge', 'output')]);
  if (kind === 'ai') definition.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } };
  return definition;
}

function classificationFlow() {
  const input = node('input', 'input'), classify = node('classify', 'classify'), merge = node('merge', 'merge'), output = node('output', 'output');
  classify.config = { modelProfile: 'text-default', labels: [{ id: 'urgent', description: '빠른 조치가 필요한 내용' }, { id: 'routine', description: '일반적인 내용' }], onUncertain: 'unclassified' };
  classify.inputBindings.content = { from: 'workflowInput', pointer: '/text', onMissing: 'error' };
  const branches = ['urgent', 'routine', 'unclassified'].map((id) => formatted(id, id));
  merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = Object.fromEntries(branches.map((branch) => [branch.id, from(branch.id, 'omit')])); output.inputBindings.result = from('merge');
  const result = workflow([input, classify, ...branches, merge, output], [edge('input', 'classify'), ...branches.map((branch) => edge('classify', branch.id, branch.id)), ...branches.map((branch) => edge(branch.id, 'merge')), edge('merge', 'output')]); result.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } }; return result;
}

describe('durable active-edge execution', () => {
  it.each([['yes', 'yes', 'no', '선택한 참 경로'], ['no', 'no', 'yes', '선택한 거짓 경로']])('selects %s and preserves the shared merge/output', async (inputText, active, skipped, result) => {
    const item = await fixture(branching()); const run = await item.service.start({ ...item.request, inputs: { text: inputText } }); await item.service.waitForIdle();
    const status = item.service.status(run.runId);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: result } });
    expect(status.nodes).toContainEqual({ nodeId: skipped, status: 'skipped' }); expect(status.nodes).toContainEqual({ nodeId: active, status: 'succeeded' }); expect(status.nodes).toContainEqual({ nodeId: 'merge', status: 'succeeded' });
    expect(status.edges.find((value) => value.edgeId === `${skipped}_next_merge`)!.state).toBe('inactive');
    const events = item.service.events(run.runId); expect(events.filter((event) => event.type === 'node.status' && (event.payload as { nodeId: string; status: string }).nodeId === 'output' && (event.payload as { status: string }).status === 'succeeded')).toHaveLength(1);
  });

  it('orders merge arrays by binding alias and distinguishes null, false and zero from missing', async () => {
    const input = node('input', 'input'), merge = node('merge', 'merge'), output = node('output', 'output'); merge.config = { waitFor: 'all_active', combine: 'array', collision: 'error' }; merge.inputBindings = { z: literal(0), a: literal(null), m: literal(false) }; output.inputBindings.result = from('merge');
    const item = await fixture(workflow([input, merge, output], [edge('input', 'merge'), edge('merge', 'output')])); const run = await item.service.start(item.request); await item.service.waitForIdle();
    expect(item.service.status(run.runId)).toMatchObject({ status: 'succeeded', result: { data: [null, false, 0] } });
  });

  it('rejects a merge with no active data instead of inventing an empty successful value', async () => {
    const definition = branching(); definition.nodes.find((value) => value.type === 'merge')!.inputBindings = {};
    const item = await fixture(definition); const run = await item.service.start(item.request); await item.service.waitForIdle();
    expect(item.service.status(run.runId)).toMatchObject({ status: 'failed', error: { code: 'NO_ACTIVE_INPUT' } });
  });

  it('executes transformation, deterministic evaluation and guardrail schema checks through a real package', async () => {
    const input = node('input', 'input'), transform = node('transform', 'transform'), evaluation = node('evaluate', 'evaluation'), guard = node('guardrail', 'guard'), output = node('output', 'output');
    transform.inputBindings.value = literal('{"title":"회의","extra":7}'); transform.config = { steps: [{ op: 'parse_json' }, { op: 'pick', options: { keys: ['title'] } }, { op: 'rename', options: { mapping: { title: 'name' } } }], resultSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } };
    evaluation.inputBindings.value = from('transform'); evaluation.config = { mode: 'rules', rules: [{ id: 'named', expression: { op: 'eq', args: [{ var: '/name' }, { literal: '회의' }] } }], passRule: { op: 'eq', args: [{ var: '/scores/named' }, { literal: 1 }] }, resultSchema: true };
    guard.inputBindings.value = from('evaluation'); guard.config = { rules: [{ id: 'pass', kind: 'schema', parameters: { schema: { type: 'object', properties: { passed: { const: true } }, required: ['passed'] } } }], onViolation: 'block' }; output.inputBindings.result = from('guard');
    const item = await fixture(workflow([input, transform, evaluation, guard, output], [edge('input', 'transform'), edge('transform', 'evaluation'), edge('evaluation', 'guard'), edge('guard', 'output')])); const run = await item.service.start(item.request); await item.service.waitForIdle();
    expect(item.service.status(run.runId)).toMatchObject({ status: 'succeeded', result: { data: { scores: { named: 1 }, passed: true, evidence: [{ ruleId: 'named', result: true }] } }, usage: { modelCalls: 0 } });
  });

  it('routes a confirmed data error and preserves an explicit null fallback', async () => {
    const item = await fixture(errorFlow()); const run = await item.service.start(item.request); await item.service.waitForIdle();
    const status = item.service.status(run.runId); expect(status).toMatchObject({ status: 'succeeded', result: { data: null } });
    expect(status.nodes).toContainEqual({ nodeId: 'work', status: 'handled_error' }); expect(status.nodes).toContainEqual({ nodeId: 'success', status: 'skipped' }); expect(status.edges).toContainEqual({ edgeId: 'work_error_recovery', state: 'active', outcome: 'handled_error' });
  });

  it('supports explicit rethrow without running a recovery successor', async () => {
    const item = await fixture(errorFlow('transform', true)); const run = await item.service.start(item.request); await item.service.waitForIdle();
    const status = item.service.status(run.runId); expect(status).toMatchObject({ status: 'failed', error: { code: 'WORKFLOW_RETHROWN' } }); expect(status.nodes).toContainEqual({ nodeId: 'output', status: 'skipped' });
  });

  it('does not let an error route or merge bypass a guardrail stop', async () => {
    const item = await fixture(errorFlow('guardrail')); const run = await item.service.start(item.request); await item.service.waitForIdle();
    const status = item.service.status(run.runId); expect(status).toMatchObject({ status: 'blocked', error: { code: 'GUARDRAIL_BLOCKED' } });
    expect(status.nodes).toContainEqual({ nodeId: 'recovery', status: 'blocked' }); expect(status.nodes).toContainEqual({ nodeId: 'output', status: 'blocked' }); expect(status.result).toBeNull();
  });

  it('does not route an uncertain external result even if its code resembles a recoverable error', async () => {
    let calls = 0; const item = await fixture(errorFlow('ai'), { async countInputTokens() { return 1; }, async generate() { calls++; throw new ModelError('MODEL_OUTPUT_INVALID', '외부 결과 확인 불가', 'unknown', true); } });
    const run = await item.service.start(item.request); await item.service.waitForIdle(); const status = item.service.status(run.runId);
    expect(status.status).toBe('attention_required'); expect(status.nodes).toContainEqual({ nodeId: 'recovery', status: 'blocked' }); expect(status.usage.reservedTokens).toBeGreaterThan(0); expect(calls).toBe(1);
  });

  it('executes model evaluation through the broker and advertises its installed mode', async () => {
    const input = node('input', 'input'), evaluation = node('evaluate', 'evaluation'), output = node('output', 'output'); evaluation.inputBindings.value = literal('value'); evaluation.config = { mode: 'model', modelProfile: 'text-default', instructions: '평가', resultSchema: true, passRule: { literal: true } }; output.inputBindings.result = from('evaluation');
    evaluation.config.passRule = { op: 'gte', args: [{ var: '/scores/quality' }, { literal: 0.9 }] };
    const definition = workflow([input, evaluation, output], [edge('input', 'evaluation'), edge('evaluation', 'output')]); definition.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } };
    const item = await fixture(definition, { async countInputTokens() { return 20; }, async generate() { return { text: '{"scores":[{"id":"quality","value":0.8}],"evidence":[{"id":"quality","reason":"명시된 자료를 확인함"}]}', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }; } }); const readiness = await item.service.validate(item.request.packageHandle, item.request.modelBindings);
    expect(readiness.ready).toBe(true); expect(item.service.capabilities).toContain('evaluate.rules@1'); expect(item.service.capabilities).toContain('evaluate.model@1');
    const run = await item.service.start(item.request); await item.service.waitForIdle(); expect(item.service.status(run.runId)).toMatchObject({ status: 'succeeded', usage: { modelCalls: 1, consumedTokens: 30 }, result: { data: { scores: { quality: 0.8 }, passed: false } } });
  });

  it.each(['urgent', 'routine', 'unclassified'])('routes a validated model classification to %s only', async (label) => {
    const calls: ModelRequest[] = [];
    const item = await fixture(classificationFlow(), { async countInputTokens() { return 7; }, async generate(request) { calls.push(request); return { text: JSON.stringify({ label, reason: '입력에서 확인한 근거' }), usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }; } });
    const run = await item.service.start(item.request); await item.service.waitForIdle(); const status = item.service.status(run.runId);
    expect(status).toMatchObject({ status: 'succeeded', result: { data: label }, usage: { modelCalls: 1, consumedTokens: 10 } });
    expect(status.nodes.filter((item) => item.status === 'skipped')).toHaveLength(2); expect(calls[0]!.responseFormat).toMatchObject({ mode: 'json' }); expect(calls[0]).not.toHaveProperty('tools');
  });

  it('rejects an undeclared classification instead of silently selecting unclassified', async () => {
    const item = await fixture(classificationFlow(), { async countInputTokens() { return 7; }, async generate() { return { text: '{"label":"administrator","reason":"설정 변경"}', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }; } });
    const run = await item.service.start(item.request); await item.service.waitForIdle(); const status = item.service.status(run.runId);
    expect(status).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTPUT_INVALID' }, usage: { modelCalls: 1, consumedTokens: 10 } }); expect(status.nodes).toContainEqual({ nodeId: 'unclassified', status: 'blocked' });
  });
});
