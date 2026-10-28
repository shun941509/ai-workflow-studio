import type { FlowDefinition, FlowRef, Workflow, WorkflowNode } from '@studio/spec';
import { RunnerError } from '../errors.js';

export type ScopeWaitKind = 'input' | 'review' | 'files';
export interface ScopeWaitBlocker { flowId: string; nodeId: string; targetFlowId: string; code: 'CHILD_WAIT_CALLER_UNSUPPORTED' }
export interface WaitScopeRecord { id: string; runId: string; parentScopeId: string; ownerNodeId: string; key: string; flowId: string; depth: number }
export interface WaitIdentity { runId: string; nodeId: string; nodeInstanceId: string; planHash: string; kind: ScopeWaitKind }
export interface ScopeWaitOwner { scopeId: string; flowId: string; ownerNodeId: string; label: string }
export interface ResolvedScopeWait { scopeId: string; flowId: string; localNodeId: string; node: WorkflowNode; flow: FlowDefinition; ownerPath: ScopeWaitOwner[] }

/** Actual file waiting requires an empty resolved array. Missing, forged or malformed files remain normal input failures. */
export function scopeWaitKind(node: WorkflowNode, inputs: Record<string, unknown>): ScopeWaitKind | undefined {
  if (node.type === 'review') return 'review';
  if (node.type === 'form' && node.config.mode === 'request') return 'input';
  if (node.type === 'file_input' && Array.isArray(inputs.files) && inputs.files.length === 0) return 'files';
  return undefined;
}

/** A nonliteral file binding can resolve to an empty selection. Preflight must not assume it will contain a file. */
export function mayCreateUserWait(node: WorkflowNode): boolean {
  if (node.type === 'review' || node.type === 'form' && node.config.mode === 'request') return true;
  if (node.type !== 'file_input') return false;
  const files = node.inputBindings.files;
  return files?.from !== 'literal' || Array.isArray(files.value) && files.value.length === 0;
}

function references(node: WorkflowNode): FlowRef[] {
  if (node.type === 'subworkflow') return [node.config.flowRef];
  if (node.type === 'loop') return [node.config.bodyFlowRef];
  if (node.type === 'parallel') return node.config.branches.map(branch => branch.flowRef);
  if (node.type === 'agent_team') return [...node.config.members.map(member => member.flowRef), ...(node.config.integrationFlowRef ? [node.config.integrationFlowRef] : [])];
  if (node.type === 'candidate_search') return [node.config.generatorFlowRef];
  if (node.type === 'orchestrator') return [...node.config.allowedFlows];
  if (node.type === 'agent' && node.config.retrievalPolicy?.clarificationFlowRef) return [node.config.retrievalPolicy.clarificationFlowRef];
  return [];
}

/** R10-A permits only subworkflow call chains. A fixed-point closure catches unsupported callers several flows above a wait. */
export function singleChildWaitBlockers(workflow: Workflow): ScopeWaitBlocker[] {
  const flows: [string, FlowDefinition][] = [['main', workflow]];
  for (const [id, flow] of Object.entries(workflow.subworkflows)) { if (!flow) invalid(); flows.push([id, flow]); }
  const waiting = new Set(flows.filter(([, flow]) => flow.nodes.some(mayCreateUserWait)).map(([id]) => id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, flow] of flows) {
      if (waiting.has(id)) continue;
      if (flow.nodes.some(node => references(node).some(ref => ref.kind === 'local' && waiting.has(ref.flowId)))) { waiting.add(id); changed = true; }
    }
  }
  const blockers: ScopeWaitBlocker[] = [];
  for (const [flowId, flow] of flows) for (const node of flow.nodes) {
    if (node.type === 'subworkflow') continue;
    const targets = new Set(references(node).filter((ref): ref is Extract<FlowRef, { kind: 'local' }> => ref.kind === 'local' && waiting.has(ref.flowId)).map(ref => ref.flowId));
    for (const targetFlowId of targets) blockers.push({ flowId, nodeId: node.id, targetFlowId, code: 'CHILD_WAIT_CALLER_UNSUPPORTED' });
  }
  return blockers;
}

const LOCAL_NODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SCOPE_ID = /^scope_[a-f0-9]{32}$/;
function invalid(): never { throw new RunnerError('WAIT_SCOPE_INVALID', '대기의 고정 실행 범위와 부모 흐름을 확인하지 못했습니다.'); }

/** Identity resolution grants no permission: callers must still check wait state, cancellation, expiry and current disclosure. */
export function resolveScopeWait(workflow: Workflow, wait: WaitIdentity, planHash: string, loadScope: (id: string) => WaitScopeRecord): ResolvedScopeWait {
  if (!['input', 'review', 'files'].includes(wait.kind) || !/^[a-f0-9]{64}$/.test(planHash) || wait.planHash !== planHash || wait.nodeInstanceId !== `${wait.runId}:${wait.nodeId}`) invalid();
  const parts = wait.nodeId.split('/');
  if (parts.length > 2 || !LOCAL_NODE.test(parts.at(-1)!)) invalid();
  const localNodeId = parts.at(-1)!, scopeId = parts.length === 1 ? 'main' : parts[0]!;
  if (parts.length === 2 && scopeId === 'main') invalid();
  let flow: FlowDefinition = workflow, flowId = 'main'; const ownerPath: ScopeWaitOwner[] = [];
  if (scopeId !== 'main') {
    if (!SCOPE_ID.test(scopeId)) invalid();
    let current = loadScope(scopeId); const seen = new Set<string>();
    if (current.id !== scopeId) invalid();
    flowId = current.flowId; flow = workflow.subworkflows[flowId]!; if (!flow) invalid();
    while (true) {
      if (!SCOPE_ID.test(current.id) || current.runId !== wait.runId || current.key !== 'call' || seen.has(current.id) || !Number.isInteger(current.depth) || current.depth < 1 || current.depth > workflow.policy.limits.maxChildDepth) invalid();
      seen.add(current.id); if (seen.size > workflow.policy.limits.maxChildDepth) invalid();
      if (current.parentScopeId !== 'main' && !SCOPE_ID.test(current.parentScopeId)) invalid();
      const parent = current.parentScopeId === 'main' ? undefined : loadScope(current.parentScopeId);
      if (parent && (parent.id !== current.parentScopeId || parent.runId !== wait.runId)) invalid();
      const parentFlow = parent ? workflow.subworkflows[parent.flowId] : workflow;
      const prefix = parent ? `${parent.id}/` : '';
      if (!parentFlow || current.depth !== (parent?.depth ?? 0) + 1 || !current.ownerNodeId.startsWith(prefix)) invalid();
      const ownerId = current.ownerNodeId.slice(prefix.length); if (!LOCAL_NODE.test(ownerId)) invalid();
      const owner = parentFlow.nodes.find(node => node.id === ownerId);
      if (!owner || owner.type !== 'subworkflow' || owner.config.flowRef.kind !== 'local' || owner.config.flowRef.flowId !== current.flowId) invalid();
      ownerPath.unshift({ scopeId: current.id, flowId: current.flowId, ownerNodeId: owner.id, label: owner.label });
      if (!parent) break;
      current = parent;
    }
  }
  const node = flow.nodes.find(value => value.id === localNodeId);
  if (!node || (wait.kind === 'review' ? node.type !== 'review' : wait.kind === 'input' ? node.type !== 'form' || node.config.mode !== 'request' : node.type !== 'file_input')) invalid();
  return { scopeId, flowId, localNodeId, node, flow, ownerPath };
}
