import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type FlowDefinition, type Workflow, type WorkflowNode } from '@studio/spec';
import { mayCreateUserWait, resolveScopeWait, scopeWaitKind, singleChildWaitBlockers, type WaitScopeRecord } from '../../apps/runner/src/execution/scope-waits.js';
import { RunWakeCoordinator } from '../../apps/runner/src/execution/run-wake-coordinator.js';

const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
function flow(work: WorkflowNode): FlowDefinition {
  const input = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = { from: 'node', nodeId: work.id, pointer: '/data', onMissing: 'error' };
  const nodes = [input, work, output]; return { inputs: true, outputs: true, entryNodeId: input.id, nodes, edges: nodes.slice(0, -1).map((value, index) => ({ id: `e${index}`, from: { nodeId: value.id, port: 'next' }, to: { nodeId: nodes[index + 1]!.id, port: 'in' } })) };
}
function question() { const value = node('form', 'question'); value.config = { mode: 'request', title: 'scope question', schema: true }; return value; }
function call(target = 'child') { const value = node('subworkflow', 'call'); value.config.flowRef = { kind: 'local', flowId: target }; return value; }
function project(): Workflow { return { ...createBasicWorkflow(), ...flow(call()), modelProfiles: {}, subworkflows: { child: flow(question()) } }; }

/** Independent helpers are not Runner support: the pending execution test still fails until the service is connected. */
describe('R10-A independent scope wait helpers', () => {
  it('distinguishes actual empty file selection from malformed data and static uncertainty', () => {
    const form = question(), files = node('file_input', 'files'); files.inputBindings.files = { from: 'literal', value: [] };
    expect(scopeWaitKind(form, {})).toBe('input'); expect(scopeWaitKind(node('review', 'review'), {})).toBe('review');
    form.config = { mode: 'initial', title: 'initial' }; expect(scopeWaitKind(form, {})).toBeUndefined();
    expect(scopeWaitKind(files, { files: [] })).toBe('files'); expect(scopeWaitKind(files, { files: 'not an array' })).toBeUndefined();
    expect(mayCreateUserWait(files)).toBe(true); files.inputBindings.files = { from: 'literal', value: [{ id: 'not inspected by this static helper' }] }; expect(mayCreateUserWait(files)).toBe(false);
    files.inputBindings.files = { from: 'workflowInput', pointer: '/files', onMissing: 'error' }; expect(mayCreateUserWait(files)).toBe(true);
  });
  it('allows direct and nested subworkflow chains without declaring capability support', () => {
    const value = project(); expect(singleChildWaitBlockers(value)).toEqual([]);
    value.subworkflows.deep = value.subworkflows.child!; value.subworkflows.child = flow(call('deep')); expect(singleChildWaitBlockers(value)).toEqual([]);
  });
  it('finds parallel waiting through an intermediate local call', () => {
    const value = project(), parallel = node('parallel', 'parallel'); parallel.config.branches = [{ id: 'a', flowRef: { kind: 'local', flowId: 'middle' } }];
    Object.assign(value, flow(parallel)); value.subworkflows.middle = flow(call());
    expect(singleChildWaitBlockers(value)).toEqual([{ flowId: 'main', nodeId: 'parallel', targetFlowId: 'middle', code: 'CHILD_WAIT_CALLER_UNSUPPORTED' }]);
  });
  it('rejects each unsupported owner even when another call path is supported', () => {
    const value = project(), loop = node('loop', 'loop'), team = node('agent_team', 'team'), candidate = node('candidate_search', 'search'), planner = node('orchestrator', 'planner');
    loop.config.bodyFlowRef = { kind: 'local', flowId: 'child' }; team.config.members = [{ id: 'one', role: 'worker', flowRef: { kind: 'local', flowId: 'child' } }];
    candidate.config.generatorFlowRef = { kind: 'local', flowId: 'child' }; planner.config.allowedFlows = [{ kind: 'local', flowId: 'child' }];
    value.nodes.push(loop, team, candidate, planner);
    expect(singleChildWaitBlockers(value).map(item => item.nodeId)).toEqual(['loop', 'team', 'search', 'planner']);
  });
  it('does not block the existing nonwaiting parallel/loop modes', () => {
    const value = project(), initial = question(), loop = node('loop', 'loop'); initial.config = { mode: 'initial', title: 'initial' }; value.subworkflows.child = flow(initial); loop.config.bodyFlowRef = { kind: 'local', flowId: 'child' }; Object.assign(value, flow(loop));
    expect(singleChildWaitBlockers(value)).toEqual([]);
  });
  it('resolves duplicate local IDs only through the saved run and exact nested owner chain', () => {
    const value = project(); value.subworkflows.deep = value.subworkflows.child!; value.subworkflows.child = flow(call('deep'));
    const a = 'scope_' + 'a'.repeat(32), b = 'scope_' + 'b'.repeat(32), hash = 'd'.repeat(64);
    const records: Record<string, WaitScopeRecord> = {
      [a]: { id: a, runId: 'run', parentScopeId: 'main', ownerNodeId: 'call', key: 'call', flowId: 'child', depth: 1 },
      [b]: { id: b, runId: 'run', parentScopeId: a, ownerNodeId: `${a}/call`, key: 'call', flowId: 'deep', depth: 2 },
    };
    const wait = { runId: 'run', nodeId: `${b}/question`, nodeInstanceId: `run:${b}/question`, planHash: hash, kind: 'input' as const };
    const result = resolveScopeWait(value, wait, hash, id => records[id]!); expect(result.flowId).toBe('deep'); expect(result.localNodeId).toBe('question'); expect(result.ownerPath.map(item => item.flowId)).toEqual(['child', 'deep']);
    for (const change of [{ runId: 'other' }, { key: 'branch:a' }, { depth: 1 }, { parentScopeId: b }, { ownerNodeId: `${a}/question` }, { flowId: 'child' }]) {
      const changed = structuredClone(records); Object.assign(changed[b]!, change); expect(() => resolveScopeWait(value, wait, hash, id => changed[id]!)).toThrow(/실행 범위/);
    }
    expect(() => resolveScopeWait(value, { ...wait, planHash: 'e'.repeat(64) }, hash, id => records[id]!)).toThrow();
    expect(() => resolveScopeWait(value, { ...wait, nodeInstanceId: 'other:' + wait.nodeId }, hash, id => records[id]!)).toThrow();
  });
  it('rejects a fabricated main scope prefix or wrong wait kind without reading child records', () => {
    const value = { ...project(), ...flow(question()) }, hash = 'd'.repeat(64), wait = { runId: 'run', nodeId: 'question', nodeInstanceId: 'run:question', planHash: hash, kind: 'input' as const };
    const lookup = (): never => { throw new Error('A root wait must not load a child'); };
    expect(resolveScopeWait(value, wait, hash, lookup).scopeId).toBe('main');
    expect(() => resolveScopeWait(value, { ...wait, kind: 'review' }, hash, lookup)).toThrow(/실행 범위/);
    expect(() => resolveScopeWait(value, { ...wait, nodeId: 'main/question', nodeInstanceId: 'run:main/question' }, hash, lookup)).toThrow(/실행 범위/);
  });
});

describe('R10 wake coalescing without automatic operation retry', () => {
  it('does not lose a second reply while one drain is waiting, or a wake just after completion', async () => {
    const coordinator = new RunWakeCoordinator(); let calls = 0, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const drain = async () => { calls++; if (calls === 1) { entered(); await gate; } };
    const first = coordinator.wake('run', drain); await started;
    const second = coordinator.wake('run', async () => { throw new Error('The active drain callback must not be replaced'); }); expect(second).toBe(first);
    release(); await first; expect(calls).toBe(2); await coordinator.wake('run', drain); await coordinator.idle(); expect(calls).toBe(3);
  });
  it('does not serialize independent root runs behind one pending human response callback', async () => {
    const coordinator = new RunWakeCoordinator(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const first = coordinator.wake('first', () => gate); let other = false;
    await coordinator.wake('second', async () => { other = true; }); expect(other).toBe(true); release(); await first; await coordinator.idle();
  });
  it('does not repeat a failed drain automatically even when another wake arrived', async () => {
    const coordinator = new RunWakeCoordinator(); let calls = 0;
    const first = coordinator.wake('run', async () => { calls++; throw new Error('unknown operation outcome'); });
    coordinator.wake('run', async () => { throw new Error('must not replace'); }); await expect(first).rejects.toThrow('unknown operation outcome'); await coordinator.idle(); expect(calls).toBe(1);
  });
});
