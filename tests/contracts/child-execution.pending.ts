import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow, createNode, type FlowDefinition, type Workflow, type WorkflowNode } from '@studio/spec';
import { RunStore, scopedKey } from '../../apps/runner/src/state/store.js';
import { ChildScopeExecutor, ROOT_SCOPE, type ChildWaitLifecycle, type ScopeSuspension } from '../../apps/runner/src/execution/child-scopes.js';
import { DurableGraph } from '../../apps/runner/src/execution/durable-graph.js';
import { ActiveExecutionDeadline } from '../../apps/runner/src/execution/concurrency.js';
import { RunnerError } from '../../apps/runner/src/errors.js';

const stores: RunStore[] = [];
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
function call(target = 'child') { const value = node('subworkflow', 'call'); value.config.flowRef = { kind: 'local', flowId: target }; value.inputBindings.input = { from: 'workflowInput', pointer: '', onMissing: 'error' }; return value; }
function flow(work: WorkflowNode): FlowDefinition {
  const input = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = { from: 'node', nodeId: work.id, pointer: '/data', onMissing: 'error' };
  const nodes = [input, work, output]; return { inputs: true, outputs: true, entryNodeId: 'input', nodes, edges: nodes.slice(0, -1).map((value, index) => ({ id: `edge${index}`, from: { nodeId: value.id, port: 'next' }, to: { nodeId: nodes[index + 1]!.id, port: 'in' } })) };
}
function question() { const value = node('form', 'question'); value.config = { mode: 'request', title: '질문', schema: true }; value.inputBindings.context = { from: 'node', nodeId: 'input', pointer: '/data', onMissing: 'error' }; return value; }
function fixture(nested = false) {
  const owner = call(), child = flow(question()); const workflow: Workflow = { ...createBasicWorkflow(), ...flow(owner), modelProfiles: {}, subworkflows: nested ? { child: flow(call('deep')), deep: child } : { child } };
  const store = new RunStore(':memory:'); stores.push(store);
  store.savePackage({ handle: 'fixture', filename: 'unused.zip', sha256: 'a'.repeat(64), name: 'internal child contract', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'request', requestHash: 'hash', packageHandle: 'fixture', planHash: 'b'.repeat(64), plan: {}, inputs: {}, modelBindings: {}, nodeIds: workflow.nodes.map(item => item.id), edges: workflow.edges, maxModelCalls: 2, maxTotalTokens: 5000 }); store.transitionRun(run.id, 'running');
  return { store, runId: run.id, owner, workflow };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });

/** These hook-level tests use real graph/SQLite records but are not evidence of a service restart or production wait capability. */
describe('R10-A prepared execution progress boundary', () => {
  it('keeps the existing output-only API unsupported even if lifecycle hooks are supplied', async () => {
    const item = fixture(); let waits = 0;
    const hooks: ChildWaitLifecycle = { restore() { throw new Error('Not a resume'); }, create() { waits++; throw new Error('Must not create a wait'); }, suspend() { throw new Error('Must not suspend'); }, canResumeOwner: () => true };
    const executor = new ChildScopeExecutor({ ...item, resources: {}, expiresAt: performance.now() + 10000, waits: hooks, async runNode() { return { output: { data: 'input' }, port: 'next' }; } });
    await expect(executor.execute(item.owner, { input: {} }, ROOT_SCOPE, new AbortController().signal)).rejects.toMatchObject({ code: 'CHILD_WAIT_UNSUPPORTED' });
    expect(waits).toBe(0); expect(item.store.listChildScopes(item.runId)[0]!.status).toBe('blocked');
  });

  it.each([false, true])('propagates suspension and restores committed bindings with nested=%s', async nested => {
    const item = fixture(nested), calls: string[] = [], suspended: string[] = []; let waitId = '', ready = false;
    const hooks: ChildWaitLifecycle = {
      restore() { return ready ? { state: 'ready' } : { state: 'suspended', waitIds: [waitId] }; },
      create(work, inputs, scope) {
        const nodeId = scopedKey(scope.id, work.id), attemptId = item.store.beginAttempt(item.runId, nodeId);
        const wait = item.store.createWait({ runId: item.runId, nodeId, attemptId, kind: 'input', title: 'test boundary', schema: true, context: inputs, ttlMs: 60000, activeMs: 0 });
        waitId = wait.id; return { state: 'suspended', waitIds: [wait.id] };
      },
      // DB15's durable scope/frame transitions are intentionally not supplied by this preparation harness.
      suspend(scope) { suspended.push(scope.id); }, canResumeOwner: () => ready,
    };
    const executor: ChildScopeExecutor = new ChildScopeExecutor({ ...item, resources: {}, expiresAt: performance.now() + 10000, waits: hooks,
      async runNode(work, inputs, _flow, flowInput, scope, signal) {
        calls.push(`${scope.flowId}/${work.id}`);
        if (work.type === 'subworkflow') {
          item.store.transitionNode(item.runId, scopedKey(scope.id, work.id), 'waiting_children');
          const progress = await executor.advance(work, inputs, scope, signal);
          return progress.state === 'completed' ? { output: progress.output, port: 'next' } : progress;
        }
        return { output: { data: work.type === 'input' ? flowInput : inputs.result }, port: 'next' };
      },
    });
    const first = await executor.advance(item.owner, { input: { original: 'kept' } }, ROOT_SCOPE, new AbortController().signal);
    expect(first).toEqual({ state: 'suspended', waitIds: [waitId] }); expect(suspended).toHaveLength(nested ? 2 : 1);
    expect(item.store.listChildScopes(item.runId).every(scope => scope.result === null)).toBe(true);
    const before = [...calls]; expect(await executor.advance(item.owner, { input: { original: 'kept' } }, ROOT_SCOPE, new AbortController().signal)).toEqual(first); expect(calls).toEqual(before);
    const wait = item.store.getWait(waitId), waitingScope = item.store.listChildScopes(item.runId).find(scope => wait.nodeId.startsWith(scope.id + '/'))!;
    const definition = item.workflow.subworkflows[waitingScope.flowId]!;
    item.store.acceptWaitResponse(item.runId, waitId, 'answer', { response: { answer: 'accepted' } });
    new DurableGraph(item.runId, definition, item.store, waitingScope.id).complete(definition.nodes.find(work => work.id === 'question')!, 'next', { data: { answer: 'accepted' } }, 'succeeded', waitId); ready = true;
    expect(await executor.advance(item.owner, { input: { original: 'kept' } }, ROOT_SCOPE, new AbortController().signal)).toEqual({ state: 'completed', output: { data: { answer: 'accepted' } } });
    expect(calls.filter(value => value.endsWith('/input'))).toHaveLength(nested ? 2 : 1); expect(calls.filter(value => value.endsWith('/question'))).toHaveLength(0);
    const completedCalls = [...calls]; await executor.advance(item.owner, { input: { original: 'kept' } }, ROOT_SCOPE, new AbortController().signal); expect(calls).toEqual(completedCalls);
  });

  it('cannot re-enable a user wait under an unsupported ancestor', async () => {
    const item = fixture(); let created = false;
    const executor = new ChildScopeExecutor({ ...item, resources: {}, expiresAt: performance.now() + 10000, waits: { restore: () => ({ state: 'ready' }), create() { created = true; throw new Error('Forbidden'); }, suspend() {}, canResumeOwner: () => true }, async runNode() { return { output: { data: {} }, port: 'next' }; } });
    await expect(executor.advance(item.owner, { input: {} }, { ...ROOT_SCOPE, waitsAllowed: false }, new AbortController().signal)).rejects.toMatchObject({ code: 'CHILD_WAIT_UNSUPPORTED' }); expect(created).toBe(false);
  });

  it('refuses running leaf replay even if a faulty restore hook claims readiness', async () => {
    const item = fixture(); const record = item.store.createChildScope({ runId: item.runId, parentScopeId: 'main', ownerNodeId: 'call', key: 'call', flowId: 'child', depth: 1, flow: item.workflow.subworkflows.child!, input: {} });
    item.store.transitionNode(item.runId, scopedKey(record.id, 'input'), 'running'); let calls = 0;
    const executor = new ChildScopeExecutor({ ...item, resources: {}, expiresAt: performance.now() + 10000, waits: { restore: () => ({ state: 'ready' }), create() { throw new Error('Forbidden'); }, suspend() {}, canResumeOwner: () => true }, async runNode() { calls++; throw new Error('Forbidden'); } });
    await expect(executor.advance(item.owner, { input: {} }, ROOT_SCOPE, new AbortController().signal)).rejects.toMatchObject({ code: 'CHILD_NOT_REPLAYABLE' }); expect(calls).toBe(0);
  });

  it('rejects a malformed suspension before treating it as a checkpoint', async () => {
    const item = fixture(); let suspended = false;
    const executor = new ChildScopeExecutor({ ...item, resources: {}, expiresAt: performance.now() + 10000, waits: { restore: () => ({ state: 'ready' }), create: () => ({ state: 'suspended', waitIds: [] } as ScopeSuspension), suspend() { suspended = true; }, canResumeOwner: () => true }, async runNode() { return { output: { data: {} }, port: 'next' }; } });
    await expect(executor.advance(item.owner, { input: {} }, ROOT_SCOPE, new AbortController().signal)).rejects.toMatchObject({ code: 'CHILD_WAIT_STATE_INVALID' }); expect(suspended).toBe(false);
  });

  it('only selects a subworkflow waiting_children checkpoint, never an arbitrary running node', () => {
    const item = fixture(); item.store.transitionNode(item.runId, 'input', 'succeeded', { data: {} }); item.store.transitionNode(item.runId, 'call', 'waiting_children');
    expect(new DurableGraph(item.runId, item.workflow, item.store).next()).toBeUndefined();
    expect(new DurableGraph(item.runId, item.workflow, item.store, 'main', { canResumeOwner: () => true }).next()?.id).toBe('call');
    item.store.transitionNode(item.runId, 'call', 'running'); expect(new DurableGraph(item.runId, item.workflow, item.store, 'main', { canResumeOwner: () => true }).next()).toBeUndefined();
  });
});

describe('R10-A active parent deadline preparation', () => {
  it('preserves consumed time across a long human pause and exhausts only the remainder', () => {
    vi.useFakeTimers(); let now = 100;
    const first = new ActiveExecutionDeadline(1000, 200, new AbortController().signal, () => now); now += 300;
    expect(first.close()).toEqual({ activeMs: 500, elapsedMs: 300, remainingMs: 500 }); now += 50000; vi.advanceTimersByTime(50000);
    expect(first.signal.aborted).toBe(false); expect(first.close().activeMs).toBe(500);
    const resumed = new ActiveExecutionDeadline(1000, 500, new AbortController().signal, () => now);
    vi.advanceTimersByTime(499); expect(resumed.signal.aborted).toBe(false); vi.advanceTimersByTime(1); expect(resumed.signal.reason).toMatchObject({ code: 'BUDGET_EXCEEDED' }); resumed.close();
  });

  it('keeps parent cancellation and an already-exhausted allowance explicit', () => {
    const parent = new AbortController(), deadline = new ActiveExecutionDeadline(1000, 0, parent.signal);
    parent.abort(new RunnerError('RUN_CANCELLED', 'cancelled')); expect(deadline.signal.reason).toMatchObject({ code: 'RUN_CANCELLED' }); deadline.close();
    const exhausted = new ActiveExecutionDeadline(1000, 1000, new AbortController().signal); expect(exhausted.signal.reason).toMatchObject({ code: 'BUDGET_EXCEEDED' }); exhausted.close();
  });

  it('rejects invalid persisted accounting and backward clocks without refunding budget', () => {
    for (const saved of [-1, NaN, Infinity]) expect(() => new ActiveExecutionDeadline(1000, saved, new AbortController().signal)).toThrow(/실행 시간/);
    let now = 20; const deadline = new ActiveExecutionDeadline(1000, 50, new AbortController().signal, () => now); now = 10;
    expect(() => deadline.close()).toThrow(/측정/); now = 30; expect(deadline.close().activeMs).toBe(60);
  });
});
