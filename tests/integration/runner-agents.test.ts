// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type WorkflowEdge, type FlowDefinition, type Binding } from '@studio/spec';
import { buildPackage, createTextResource } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { ModelError, type ModelProvider, type ModelRequest } from '../../apps/runner/src/providers/model-provider.js';

const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const literal = (value: unknown) => ({ from: 'literal', value }) as Binding;
const from = (nodeId: string, pointer = '/data') => ({ from: 'node', nodeId, pointer, onMissing: 'error' }) as Binding;
const input = (pointer = '') => ({ from: 'workflowInput', pointer, onMissing: 'error' }) as Binding;
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
function flow(work?: WorkflowNode, result?: Binding): FlowDefinition { const entry = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = result ?? (work ? from(work.id) : input()); return { entryNodeId: entry.id, inputs: true, outputs: true, nodes: (work ? [entry, work, output] : [entry, output]) as FlowDefinition['nodes'], edges: work ? [edge('input', work.id), edge(work.id, 'output')] : [edge('input', 'output')] }; }
function project(work: WorkflowNode): Workflow { return { ...createBasicWorkflow('에이전트 실행 검증'), ...flow(work) }; }
function agent() { const value = node('agent', 'agent'); value.config = { strategy: 'task', modelProfile: 'text-default', instructions: '작업 결과를 작성하세요.', maxSteps: 1, toolAllowlist: [], resultSchema: true }; value.inputBindings.task = literal('초안을 작성하세요'); return value; }
function team(mode: 'sequential' | 'parallel' = 'sequential') { const value = node('agent_team', 'team'); value.inputBindings = { task: literal('팀 작업'), context: literal({ subject: 'example' }) }; value.config = { mode, maxConcurrency: 2, members: [{ id: 'writer', role: '작성자', flowRef: { kind: 'local', flowId: 'member' } }, { id: 'reviewer', role: '검토자', flowRef: { kind: 'local', flowId: 'member' } }], integrationFlowRef: { kind: 'local', flowId: 'integrate' } }; return value; }
function teamProject(mode: 'sequential' | 'parallel' = 'sequential') { const definition = project(team(mode)); const work = agent(); work.inputBindings = { task: input('/task'), context: input() }; definition.subworkflows = { member: flow(work, from(work.id, '/data/result')), integrate: flow(undefined, input('/members')) }; return definition; }
function planner() { const value = node('orchestrator', 'planner'); value.inputBindings.goal = literal('두 개의 초안을 계획하세요'); value.config = { mode: 'plan', modelProfile: 'text-default', maxReplans: 0, maxTasks: 2, allowedFlows: [{ kind: 'local', flowId: 'draft' }] }; return value; }
function planProject() { const definition = project(planner()); const child = flow(); child.inputs = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }; definition.subworkflows.draft = child; return definition; }
const planTasks = () => [{ id: 'first', flowId: 'draft', inputJson: '{"text":"one"}', dependsOn: [] as string[], purpose: '첫 초안' }, { id: 'second', flowId: 'draft', inputJson: '{"text":"two"}', dependsOn: ['first'], purpose: '둘째 초안' }];
const response = (result: unknown) => ({ text: JSON.stringify({ resultJson: JSON.stringify(result) }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const fixtures: { directory: string; store: RunStore; service: RunnerService }[] = [];
async function setup(workflow: Workflow, provider: ModelProvider = { async countInputTokens() { return 1; }, async generate() { return response({ answer: 'done' }); } }, host: 'codex' | 'claude-code' | 'opencode' = 'codex', resources?: Record<string, Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-agent-test-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>();
  const credentials = { available: true, async set(id: string, value: string) { secrets.set(id, value); }, async get(id: string) { return secrets.get(id)!; }, async has(id: string) { return secrets.has(id); }, async delete(id: string) { secrets.delete(id); } };
  // Only this test boundary supplies a model double; production mode capabilities must come from the real service.
  const calls: ModelRequest[] = []; const service = new RunnerService(store, credentials, directory, { async countInputTokens(request, context) { return provider.countInputTokens(request, context); }, async generate(request, context) { calls.push(request); return provider.generate(request, context); } }); const owner = { directory, store, service }; fixtures.push(owner);
  const profile = await service.createProfile({ name: 'test', model: 'contract-model', apiKey: 'test-only-fixed-secret' }); const built = await buildPackage({ workflow, host, ...(resources ? { resources } : {}) }); const imported = await service.importPackage(built.bytes);
  return { ...owner, owner, credentials, calls, request: { packageHandle: imported.packageHandle, requestId: 'agent-case', inputs: {}, modelBindings: Object.fromEntries(Object.keys(workflow.modelProfiles).map((alias) => [alias, profile.id])) } };
}
async function run(item: Awaited<ReturnType<typeof setup>>) { const started = await item.service.start(item.request); await item.service.waitForIdle(); return item.service.status(started.runId); }
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-agent-test-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('bounded single-step agent', () => {
  it('records one actual model invocation and validates the final result schema', async () => {
    const work = agent(); work.config.resultSchema = { type: 'object', properties: { answer: { const: 'done' } }, required: ['answer'], additionalProperties: false }; const item = await setup(project(work)); const result = await run(item);
    expect(result).toMatchObject({ status: 'succeeded', result: { data: { result: { answer: 'done' }, steps: 1, stopReason: 'completed' } }, usage: { modelCalls: 1, consumedTokens: 2 } }); expect(item.calls[0]).not.toHaveProperty('tools'); expect(item.calls[0]!.maxOutputTokens).toBe(4096); expect(item.calls[0]!.responseFormat.mode).toBe('json');
  });

  it.each(['malformed', 'schema', 'effects'] as const)('rejects %s output instead of claiming successful agent work', async (kind) => {
    const work = agent(); work.config.resultSchema = { type: 'number' }; const item = await setup(project(work), { async countInputTokens() { return 1; }, async generate() { return { text: kind === 'malformed' ? '{' : kind === 'schema' ? JSON.stringify({ resultJson: JSON.stringify('wrong') }) : '{"resultJson":"1","effects":[{"approved":true}]}', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const result = await run(item); expect(result).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTPUT_INVALID' } }); expect(item.calls).toHaveLength(1);
  });

  it.each(['multi-step', 'tools', 'indexes', 'agentic-rag'] as const)('rejects unsupported %s configuration in readiness', async (kind) => {
    const work = agent(); if (kind === 'multi-step') work.config.maxSteps = 2; if (kind === 'tools') work.config.toolAllowlist = [{ kind: 'builtin', id: 'knowledge.search', version: 1 }]; if (kind === 'indexes') work.inputBindings.indexes = literal([]); if (kind === 'agentic-rag') { work.config.strategy = 'agentic_rag'; work.config.retrievalPolicy = { maxRounds: 1, maxQueriesPerRound: 1, maxRetrievedChunks: 1, maxContextTokens: 100, onInsufficient: 'abstain' }; }
    const item = await setup(project(work)); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).issues.map((issue) => issue.code)).toContain('AGENT_MODE_UNSUPPORTED'); expect(item.calls).toHaveLength(0);
  });

  it('consumes explicitly attached instruction material while still providing no tool interface', async () => {
    const work = agent(); const resource = createTextResource({ id: 'guide', revision: 1, name: '작성 지침', kind: 'instruction', text: 'ATTACHED_GUIDE' }); work.attachments = [{ resource: 'guide', role: 'instructions' }]; const definition = project(work); definition.resources.guide = resource.reference; const item = await setup(definition, undefined, 'codex', resource.files); expect((await run(item)).status).toBe('succeeded'); expect(item.calls[0]!.instructions).toContain('ATTACHED_GUIDE'); expect(item.calls[0]).not.toHaveProperty('tools');
  });

  it('does not retry an unknown provider outcome despite a permissive retry configuration', async () => {
    const work = agent(); work.execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['TRANSIENT_NETWORK'] }; const item = await setup(project(work), { async countInputTokens() { return 1; }, async generate() { throw new ModelError('TRANSIENT_NETWORK', '확인할 수 없음', 'unknown', true); } }); const result = await run(item); expect(result.status).toBe('attention_required'); expect(result.usage.reservedTokens).toBeGreaterThan(0); expect(item.calls).toHaveLength(1);
  });

  it('retains a confirmed refusal as failure and settles its known usage', async () => {
    const item = await setup(project(agent()), { async countInputTokens() { return 2; }, async generate() { throw new ModelError('MODEL_REFUSAL', '공급자 거부', 'completed', false, { inputTokens: 2, outputTokens: 1, totalTokens: 3 }); } });
    expect(await run(item)).toMatchObject({ status: 'failed', result: null, error: { code: 'MODEL_REFUSAL' }, usage: { modelCalls: 1, consumedTokens: 3, reservedTokens: 0 } });
  });
});

describe('fixed agent teams', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP passes fixed roles and previous confirmed results, then runs explicit integration', async (host) => {
    const item = await setup(teamProject(), { async countInputTokens() { return 1; }, async generate(request) { const context = (request.content as { context: { member: { id: string }; previousResults: unknown[] } }).context; return response({ member: context.member.id, previousCount: context.previousResults.length }); } }, host); const result = await run(item);
    const members = [{ id: 'writer', role: '작성자', result: { member: 'writer', previousCount: 0 } }, { id: 'reviewer', role: '검토자', result: { member: 'reviewer', previousCount: 1 } }];
    expect(result).toMatchObject({ status: 'succeeded', result: { data: { members, integratedResult: members, stopReason: 'completed' } }, usage: { modelCalls: 2 } }); expect(result.childScopes).toHaveLength(3); expect(result.childScopes.every((scope) => scope.depth === 1)).toBe(true); expect(item.calls[1]!.content).toMatchObject({ task: '팀 작업', context: { member: { id: 'reviewer', role: '검토자' }, previousResults: [members[0]] } });
  });

  it('executes parallel members with empty predecessor snapshots and declaration-ordered results', async () => {
    let active = 0, maximum = 0; const item = await setup(teamProject('parallel'), { async countInputTokens() { return 1; }, async generate(request) { const context = (request.content as { context: { member: { id: string }; previousResults: unknown[] } }).context; maximum = Math.max(maximum, ++active); await delay(context.member.id === 'writer' ? 30 : 5); active--; return response({ member: context.member.id, previousCount: context.previousResults.length }); } }); const result = await run(item);
    expect(maximum).toBe(2); expect(result).toMatchObject({ status: 'succeeded', result: { data: { members: [{ id: 'writer', result: { previousCount: 0 } }, { id: 'reviewer', result: { previousCount: 0 } }] } } });
  });

  it('shares the one root model budget across team members and does not integrate failed work', async () => {
    const definition = teamProject('parallel'); definition.policy.limits.maxModelCalls = 1; const item = await setup(definition, { async countInputTokens() { return 1; }, async generate() { await delay(5); return response('known'); } }); const result = await run(item); expect(result).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } }); expect(item.calls).toHaveLength(1); expect(result.childScopes.some((scope) => scope.key === 'integration')).toBe(false);
  });

  it('cancels and drains uncertain team members before returning attention_required', async () => {
    let started = 0, settled = 0; let signalReady!: () => void; const ready = new Promise<void>((done) => { signalReady = done; }); const item = await setup(teamProject('parallel'), { async countInputTokens() { return 1; }, async generate(_request, context) { if (++started === 2) signalReady(); await new Promise<void>((done) => context.signal.addEventListener('abort', () => { settled++; done(); }, { once: true })); throw new ModelError('MODEL_INTERRUPTED', '외부 결과 확인 필요', 'unknown'); } });
    const result = await item.service.start(item.request); await ready; item.service.cancel(result.runId); await item.service.waitForIdle(); const final = item.service.status(result.runId); expect(final.status).toBe('attention_required'); expect(settled).toBe(2); expect(final.childScopes.every((scope) => scope.status !== 'running')).toBe(true); expect(final.childScopes.some((scope) => scope.key === 'integration')).toBe(false);
  });
});

describe('planning-only orchestration', () => {
  it('persists an immutable validated plan without dispatching any child or replacing the active plan', async () => {
    const item = await setup(planProject(), { async countInputTokens() { return 1; }, async generate() { return { text: JSON.stringify({ tasks: planTasks() }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const result = await run(item);
    expect(result).toMatchObject({ status: 'succeeded', childScopes: [], result: { data: { stopReason: 'planned', taskResults: [], planHistory: [{ revision: 1, tasks: [{ id: 'first', input: { text: 'one' }, dependsOn: [] }, { id: 'second', input: { text: 'two' }, dependsOn: ['first'] }] }] } } }); expect(item.calls).toHaveLength(1);
    const proposal = item.store.listPlanProposals(result.id)[0]!; expect(proposal.planHash).toHaveLength(64); expect(proposal.planHash).not.toBe(item.store.getExecution(result.id).planHash); expect(item.service.events(result.id).find((event) => event.type === 'orchestrator.planned')?.payload).toMatchObject({ dispatched: false, taskCount: 2 });
    expect(item.store.savePlanProposal(result.id, 'planner', proposal.tasks as unknown[]).planHash).toBe(proposal.planHash); expect(() => item.store.savePlanProposal(result.id, 'planner', [])).toThrowError(/바꿀 수 없습니다/); expect(item.service.events(result.id).filter((event) => event.type === 'orchestrator.planned')).toHaveLength(1);
    await item.service.shutdown(); item.store.close(); const reopened = new RunStore(join(item.directory, 'state.sqlite')); item.owner.store = reopened; item.owner.service = new RunnerService(reopened, item.credentials, item.directory); expect(reopened.listPlanProposals(result.id)).toEqual([proposal]); expect(reopened.listChildScopes(result.id)).toHaveLength(0);
  });

  it('does not publish or dispatch an uncertain planner outcome', async () => {
    const item = await setup(planProject(), { async countInputTokens() { return 1; }, async generate() { throw new ModelError('MODEL_INTERRUPTED', '확인 필요', 'unknown'); } }); const result = await run(item);
    expect(result).toMatchObject({ status: 'attention_required', childScopes: [], result: null }); expect(item.store.listPlanProposals(result.id)).toHaveLength(0); expect(item.calls).toHaveLength(1);
  });

  it.each(['duplicate', 'forward', 'self', 'flow', 'input', 'too-many', 'effects'] as const)('rejects %s plan proposals before publishing or executing anything', async (kind) => {
    const tasks = planTasks(); if (kind === 'duplicate') tasks[1]!.id = 'first'; if (kind === 'forward') tasks[0]!.dependsOn = ['second']; if (kind === 'self') tasks[0]!.dependsOn = ['first']; if (kind === 'flow') tasks[0]!.flowId = 'unauthorized'; if (kind === 'input') tasks[0]!.inputJson = '{"unknown":true}'; if (kind === 'too-many') tasks.push({ ...tasks[1]!, id: 'third' });
    const item = await setup(planProject(), { async countInputTokens() { return 1; }, async generate() { return { text: JSON.stringify({ tasks, ...(kind === 'effects' ? { approved: true } : {}) }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }); const result = await run(item); expect(result.status).toBe('failed'); expect(item.store.listPlanProposals(result.id)).toHaveLength(0); expect(result.childScopes).toHaveLength(0); expect(result.result).toBeNull();
  });

  it.each(['adaptive', 'dynamic', 'replan'] as const)('blocks %s orchestration in readiness', async (kind) => {
    const definition = planProject(); const work = definition.nodes.find((value) => value.type === 'orchestrator')!; if (kind === 'replan') work.config.maxReplans = 1; else work.config.mode = kind; const item = await setup(definition); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).issues.map((issue) => issue.code)).toContain('ORCHESTRATOR_MODE_UNSUPPORTED'); expect(item.calls).toHaveLength(0);
  });
});
