import { setImmediate as yieldTurn } from 'node:timers/promises';
import { validateJsonValue, type Workflow, type WorkflowNode, type FlowDefinition, type FlowRef } from '@studio/spec';
import { evaluateCondition, resolveBindings, type NodeOutput } from '@studio/workflow-core';
import { RunStore, scopedKey, type ChildScopeRecord } from '../state/store.js';
import { RunnerError, publicError } from '../errors.js';
import { ModelError } from '../providers/model-provider.js';
import { isRecoverableFailure, type RecoverableFailure } from '../handlers/pure.js';
import { DurableGraph } from './durable-graph.js';
import { LeafConcurrency, interruption } from './concurrency.js';
import { validateFixedTeam } from '../handlers/bounded-agents.js';
import { executeCandidateSearch } from './candidate-search.js';
import { scopeWaitKind } from './scope-waits.js';

export interface ExecutionScope { id: string; flowId: string; depth: number; lineage: readonly string[]; waitsAllowed?: boolean }
export const ROOT_SCOPE: ExecutionScope = { id: 'main', flowId: 'main', depth: 0, lineage: ['main'] };
export interface ScopeSuspension { state: 'suspended'; waitIds: readonly string[] }
export type ScopeProgress = { state: 'completed'; output: NodeOutput } | ScopeSuspension;
export type ChildNodeProgress = { output: NodeOutput; port: string } | ScopeSuspension;
/** Trusted service hooks must persist/verify the checkpoint before returning. Workflow data cannot supply this authority. */
export interface ChildWaitLifecycle {
  restore(record: ChildScopeRecord, scope: ExecutionScope): { state: 'ready' } | ScopeSuspension;
  create(node: WorkflowNode, inputs: Record<string, unknown>, scope: ExecutionScope): ScopeSuspension;
  suspend(scope: ExecutionScope, waitIds: readonly string[]): void;
  canResumeOwner(scope: ExecutionScope, node: WorkflowNode): boolean;
}
export interface ChildExecutorOptions {
  runId: string; workflow: Workflow; store: RunStore; resources: Record<string, unknown>; expiresAt: number;
  runNode: (node: WorkflowNode, inputs: Record<string, unknown>, flow: FlowDefinition, flowInput: unknown, scope: ExecutionScope, signal: AbortSignal, failure?: RecoverableFailure) => Promise<ChildNodeProgress>;
  waits?: ChildWaitLifecycle;
}

export function compositeNode(node: WorkflowNode): boolean { return ['subworkflow', 'loop', 'parallel', 'agent_team', 'candidate_search'].includes(node.type); }
interface ChildJob { id: string; key: string; flowRef: FlowRef; input: unknown }
interface ChildJobResult { id: string; status: 'succeeded' | 'failed'; result?: unknown; error?: { code: string; message: string } }
const detailOf = (error: unknown) => error instanceof ModelError ? { code: error.code, message: error.message } : publicError(error);
// A durable journal uncertainty is protected just like an unknown paid response, including across composite scopes.
const uncertain = (error: unknown) => error instanceof ModelError && error.outcome === 'unknown' || ['RAG_RECONCILIATION_REQUIRED', 'AGENTIC_RECONCILIATION_REQUIRED'].includes(detailOf(error).code);
const collectible = (error: unknown) => !uncertain(error) && (isRecoverableFailure(detailOf(error).code) || detailOf(error).code === 'CHILD_INPUT_INVALID');

/** Suspension is a nonempty bounded list of saved waits, not a fabricated successful output or a retry request. */
function checkedSuspension(value: ScopeSuspension): ScopeSuspension {
  if (value.state !== 'suspended' || !Array.isArray(value.waitIds) || value.waitIds.length < 1 || value.waitIds.length > 32 || new Set(value.waitIds).size !== value.waitIds.length || value.waitIds.some(id => !/^wait_[a-f0-9-]{36}$/.test(id))) throw new RunnerError('CHILD_WAIT_STATE_INVALID', '저장된 하위 대기 정보를 확인하지 못했습니다.');
  return { state: 'suspended', waitIds: Object.freeze([...value.waitIds]) };
}

function completedOutput(value: unknown): NodeOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new RunnerError('CHILD_STATE_INVALID', '저장된 하위 작업의 완료 결과를 확인하지 못했습니다.');
  return value as NodeOutput;
}

/** Every child is a durable namespace inside one root budget, never a fresh independently funded run. */
export class ChildScopeExecutor {
  readonly concurrency: LeafConcurrency;
  constructor(private readonly options: ChildExecutorOptions) { this.concurrency = new LeafConcurrency(options.workflow.policy.limits.maxConcurrentNodes); }

  /** Only this explicit progress API may suspend a fixed single-child call; the old output API keeps its strict contract. */
  async advance(node: WorkflowNode, inputs: Record<string, unknown>, scope: ExecutionScope, signal: AbortSignal): Promise<ScopeProgress> {
    if (node.type === 'subworkflow') return this.childProgress(node, scope, 'call', node.config.flowRef, inputs.input, signal, true);
    return { state: 'completed', output: await this.execute(node, inputs, scope, signal) };
  }

  async execute(node: WorkflowNode, inputs: Record<string, unknown>, scope: ExecutionScope, signal: AbortSignal): Promise<NodeOutput> {
    this.check(signal);
    if (node.type === 'candidate_search') return executeCandidateSearch(node, inputs, {
      runId: this.options.runId, nodeId: scopedKey(scope.id, node.id), store: this.options.store.candidateSearch, signal, checkpoint: () => this.check(signal),
      // Candidate depth is logical search depth, while each fixed generator call is a sibling child scope.
      generate: (key, input, childSignal) => this.child(node, scope, key, node.config.generatorFlowRef, input, childSignal),
    });
    if (node.type === 'subworkflow') return this.child(node, scope, 'call', node.config.flowRef, inputs.input, signal);
    if (node.type === 'agent_team') {
      validateFixedTeam(node);
      const members: { id: string; role: string; result: unknown }[] = [];
      const memberInput = (member: typeof node.config.members[number]) => ({ task: inputs.task, context: inputs.context ?? null, member: { id: member.id, role: member.role }, previousResults: structuredClone(members) });
      if (node.config.mode === 'sequential') {
        for (const member of node.config.members) { const output = await this.child(node, scope, `member:${member.id}`, member.flowRef, memberInput(member), signal); members.push({ id: member.id, role: member.role, result: output.data }); this.bounded(members); }
      } else {
        // All parallel inputs are frozen before dispatch, so there is no timing-dependent predecessor context.
        const jobs = node.config.members.map((member) => ({ id: member.id, key: `member:${member.id}`, flowRef: member.flowRef, input: memberInput(member) }));
        const completed = await this.batch(node, scope, jobs, signal, node.config.maxConcurrency, false);
        for (const [index, result] of completed.entries()) members.push({ id: result.id, role: node.config.members[index]!.role, result: result.result });
      }
      const integratedResult = node.config.integrationFlowRef ? (await this.child(node, scope, 'integration', node.config.integrationFlowRef, { task: inputs.task, context: inputs.context ?? null, members }, signal)).data : null;
      const data = { members, integratedResult, stopReason: 'completed' }; this.bounded(data); return { data };
    }
    if (node.type === 'loop') {
      const results: unknown[] = []; const context = inputs.context ?? null;
      if (node.config.mode === 'foreach') {
        if (!Array.isArray(inputs.items)) throw new RunnerError('CHILD_INPUT_INVALID', '반복할 목록이 필요합니다.');
        const items = structuredClone(inputs.items);
        if (items.length > node.config.maxIterations) throw new RunnerError('LOOP_LIMIT', '목록의 길이가 최대 반복 횟수를 초과합니다. 일부 항목만 실행하지 않았습니다.');
        for (let index = 0; index < items.length; index++) { const output = await this.child(node, scope, `item:${index}`, node.config.bodyFlowRef, { item: items[index], index, context }, signal); results.push(output.data); this.bounded(results); }
        return { data: { results, iterations: results.length, reason: 'completed' } };
      }
      let state = structuredClone(inputs.state);
      for (let iteration = 1; iteration <= node.config.maxIterations; iteration++) {
        const output = await this.child(node, scope, `iteration:${iteration}`, node.config.bodyFlowRef, { state, iteration, context }, signal);
        state = output.data; results.push(state); this.bounded(results);
        if (evaluateCondition(node.config.untilExpression, { state, iteration, context })) return { data: { results, finalState: state, iterations: iteration, reason: 'condition_met' } };
      }
      return { data: { results, finalState: state, iterations: node.config.maxIterations, reason: 'max_iterations' } };
    }
    if (node.type !== 'parallel' || node.config.mode !== 'all') throw new RunnerError('CAPABILITY_MISSING', '이 병렬 실행 모드는 아직 지원하지 않습니다.');
    const branchInputs = inputs.branches as Record<string, unknown>; const branches = node.config.branches;
    if (new Set(branches.map((branch) => branch.id)).size !== branches.length || Object.keys(branchInputs).some((key) => !branches.some((branch) => branch.id === key)) || branches.some((branch) => !Object.hasOwn(branchInputs, branch.id))) throw new RunnerError('PARALLEL_INPUT_INVALID', '선언한 각 병렬 분기에 정확히 하나의 입력을 연결하세요.');
    const jobs = branches.map((branch) => ({ id: branch.id, key: `branch:${branch.id}`, flowRef: branch.flowRef, input: { input: branchInputs[branch.id], branchId: branch.id, context: inputs.context ?? null } }));
    return { data: { branches: await this.batch(node, scope, jobs, signal, node.config.maxConcurrency, node.config.failurePolicy === 'collect') } };
  }

  /** Parallel jobs share one cancellation group; every started child drains before any protected outcome returns. */
  private async batch(owner: WorkflowNode, scope: ExecutionScope, jobs: ChildJob[], signal: AbortSignal, maximum: number, collect: boolean): Promise<ChildJobResult[]> {
    const group = new AbortController(); const childSignal = AbortSignal.any([signal, group.signal]);
    const results: ChildJobResult[] = new Array(jobs.length);
    const failures: unknown[] = []; let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length && !childSignal.aborted) {
        const index = cursor++; const branch = jobs[index]!;
        try {
          const output = await this.child(owner, scope, branch.key, branch.flowRef, branch.input, childSignal);
          results[index] = { id: branch.id, status: 'succeeded', result: output.data }; this.bounded(results.filter(Boolean));
        } catch (error) {
          results[index] = { id: branch.id, status: 'failed', error: detailOf(error) };
          if (collect && collectible(error) && !childSignal.aborted) continue;
          failures.push(error); group.abort(new RunnerError('CHILD_CANCELLED', '다른 병렬 분기의 종료로 작업을 중단했습니다.')); break;
        }
      }
    };
    // Drain every started branch before returning; a winner or failure cannot hide an uncertain sibling call.
    await Promise.all(Array.from({ length: Math.min(jobs.length, maximum) }, worker));
    const unknown = failures.find(uncertain);
    if (unknown) throw unknown;
    if (signal.aborted) throw interruption(signal);
    if (failures.length) throw failures.find((error) => !['CHILD_CANCELLED', 'RUN_CANCELLED'].includes(detailOf(error).code)) ?? failures[0];
    return results;
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw interruption(signal);
    if (performance.now() >= this.options.expiresAt) throw new RunnerError('BUDGET_EXCEEDED', '전체 실행의 활성 시간 한도를 초과했습니다.');
  }

  private bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024 * 1024) throw new RunnerError('CHILD_RESULT_LIMIT', '하위 작업의 합산 결과가 8 MiB를 초과했습니다.'); }

  private async child(owner: WorkflowNode, parent: ExecutionScope, key: string, reference: FlowRef, input: unknown, signal: AbortSignal): Promise<NodeOutput> {
    const progress = await this.childProgress(owner, parent, key, reference, input, signal, false);
    if (progress.state !== 'completed') throw new RunnerError('CHILD_WAIT_UNSUPPORTED', '이 호출 경로의 하위 사용자 대기는 아직 지원하지 않습니다.');
    return progress.output;
  }

  private async childProgress(owner: WorkflowNode, parent: ExecutionScope, key: string, reference: FlowRef, input: unknown, signal: AbortSignal, allowSuspension: boolean): Promise<ScopeProgress> {
    this.check(signal);
    if (reference.kind !== 'local') throw new RunnerError('CAPABILITY_MISSING', '외부 패키지 하위 흐름은 아직 지원하지 않습니다.');
    const { workflow, store, runId } = this.options; const flow = workflow.subworkflows[reference.flowId];
    if (!flow) throw new RunnerError('CHILD_FLOW_MISSING', '고정한 하위 흐름을 찾을 수 없습니다.');
    if (parent.lineage.includes(reference.flowId)) throw new RunnerError('FLOW_RECURSION', '하위 흐름을 재귀 호출할 수 없습니다.');
    if (parent.depth + 1 > workflow.policy.limits.maxChildDepth) throw new RunnerError('FLOW_DEPTH_EXCEEDED', '하위 작업의 최대 깊이를 초과했습니다.');
    if (!validateJsonValue(flow.inputs, input).valid) throw new RunnerError('CHILD_INPUT_INVALID', '하위 흐름의 입력 형식과 전달한 값이 일치하지 않습니다.');
    input = structuredClone(input);
    const record = store.createChildScope({ runId, parentScopeId: parent.id, ownerNodeId: scopedKey(parent.id, owner.id), key, flowId: reference.flowId, depth: parent.depth + 1, flow, input });
    const waits = allowSuspension && parent.waitsAllowed !== false && owner.type === 'subworkflow' && key === 'call' ? this.options.waits : undefined;
    // A nested call cannot escape a loop/team/parallel ancestor by switching to the progress API farther down the tree.
    const scope: ExecutionScope = { id: record.id, flowId: reference.flowId, depth: record.depth, lineage: [...parent.lineage, reference.flowId], waitsAllowed: !!waits };
    if (!record.fresh) {
      if (record.status === 'succeeded') return { state: 'completed', output: completedOutput(record.result) };
      if (!waits || !['waiting', 'running'].includes(record.status)) throw new RunnerError('CHILD_NOT_REPLAYABLE', '미완료 또는 실패한 하위 실행을 자동 재실행할 수 없습니다.');
      const state = waits.restore(record, scope);
      if (state.state === 'suspended') return checkedSuspension(state);
      if (state.state !== 'ready') throw new RunnerError('CHILD_WAIT_STATE_INVALID', '안전한 하위 작업 재개 지점을 확인하지 못했습니다.');
    }
    const graph = new DurableGraph(runId, flow, store, scope.id, waits ? { canResumeOwner: node => waits.canResumeOwner(scope, node) } : undefined);
    const outputs: Record<string, NodeOutput> = Object.create(null) as Record<string, NodeOutput>; const errors = new Map<string, RecoverableFailure>();
    // A known wait resumes bindings from committed outputs. Running leaves and unknown results are never inferred as complete.
    const persisted = store.graphState(runId, scope.id);
    for (const node of persisted.nodes) {
      if (node.status === 'succeeded') outputs[node.nodeId] = completedOutput(node.result);
      if (!record.fresh && ['running', 'ready', 'retry_wait', 'reconciling', 'failed', 'blocked', 'cancelled'].includes(node.status)) throw new RunnerError('CHILD_NOT_REPLAYABLE', '하위 작업에 결과가 확인되지 않은 실행이 남아 있습니다.');
    }
    const suspend = (value: ScopeSuspension): ScopeSuspension => {
      if (!waits) throw new RunnerError('CHILD_WAIT_UNSUPPORTED', '이 호출 경로의 하위 사용자 대기는 아직 지원하지 않습니다.');
      const progress = checkedSuspension(value); waits.suspend(scope, progress.waitIds); return progress;
    };
    let current: WorkflowNode | undefined;
    try {
      // A crash after durable output completion can reuse that exact output only after restore() authorizes the checkpoint.
      const final = flow.nodes.find(node => node.type === 'output' && Object.hasOwn(outputs, node.id));
      if (final) { const output = outputs[final.id]!; store.finishChildScope(scope.id, 'succeeded', output); return { state: 'completed', output }; }
      while ((current = graph.next())) {
        this.check(signal); const node = current; const storedId = scopedKey(scope.id, node.id);
        store.claimNode(runId, storedId, workflow.policy.limits.maxNodeInstances); store.transitionNode(runId, storedId, 'ready');
        try {
          if (!waits && (node.type === 'review' || node.type === 'form' && node.config.mode === 'request')) throw new RunnerError('CHILD_WAIT_UNSUPPORTED', '하위 흐름 안의 사용자 대기는 아직 지원하지 않습니다.');
          const inputs = resolveBindings(node, { workflowInput: input, nodeOutputs: outputs, resources: this.options.resources, ...(errors.has(node.id) ? { error: errors.get(node.id) } : {}) });
          if (scopeWaitKind(node, inputs) && waits) return suspend(waits.create(node, inputs, scope));
          const result = await this.options.runNode(node, inputs, flow, input, scope, signal, errors.get(node.id));
          if ('state' in result) {
            if (node.type !== 'subworkflow') throw new RunnerError('CHILD_WAIT_UNSUPPORTED', '이 호출 경로의 하위 사용자 대기는 아직 지원하지 않습니다.');
            return suspend(result);
          }
          const { output, port } = result;
          outputs[node.id] = output; graph.complete(node, node.type === 'output' ? undefined : port, output); current = undefined;
          if (node.type === 'output') { store.finishChildScope(scope.id, 'succeeded', output); return { state: 'completed', output }; }
        } catch (error) {
          const detail = detailOf(error);
          if (node.execution.onError !== 'route' || !collectible(error) || signal.aborted) throw error;
          const target = flow.edges.find((edge) => edge.from.nodeId === node.id && edge.from.port === 'error')!.to.nodeId;
          errors.set(target, { ...detail, nodeId: node.id, recoverable: true }); graph.complete(node, 'error', undefined, 'handled_error'); current = undefined;
        }
        await yieldTurn();
      }
      throw new RunnerError('CHILD_OUTPUT_MISSING', '하위 흐름이 최종 결과에 도달하지 못했습니다.');
    } catch (error) {
      const detail = detailOf(error); const unknown = uncertain(error);
      const cancelled = !unknown && signal.aborted && ['CHILD_CANCELLED', 'RUN_CANCELLED'].includes(detailOf(interruption(signal)).code);
      const blocked = !unknown && !cancelled && !collectible(error);
      if (current) store.transitionNode(runId, scopedKey(scope.id, current.id), unknown ? 'reconciling' : cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed');
      store.finishChildScope(scope.id, unknown ? 'attention_required' : cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed', undefined, detail); throw error;
    }
  }
}
