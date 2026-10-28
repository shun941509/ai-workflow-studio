import { createNode, type FlowDefinition, type FlowRef, type Workflow, type WorkflowNode, type ValidationIssue } from '@studio/spec';
import { releaseUnusedResourcePins } from './resource-links';
import { normalizeLayout, type LocalDraft, type EditorLayout } from './local-drafts';
import type { StoredViewport } from './canvas-navigation';

export const ROOT_FLOW = 'main';

/** A scoped view reuses the existing inspectors without granting access to nodes in another flow. */
export function flowView(workflow: Workflow, flowId: string): Workflow {
  if (flowId === ROOT_FLOW) return workflow;
  const definition = workflow.subworkflows[flowId];
  if (!definition) throw new Error('해당 하위 흐름을 찾을 수 없습니다.');
  return { ...workflow, ...definition };
}

/** Only the canonical five flow fields move between scopes; resource/model/policy declarations stay global. */
function definitionOf(view: Workflow): FlowDefinition {
  return { entryNodeId: view.entryNodeId, inputs: view.inputs, outputs: view.outputs, nodes: view.nodes, edges: view.edges };
}

export function flowPositions(editor: EditorLayout, flowId: string): EditorLayout['positions'] {
  return flowId === ROOT_FLOW ? editor.positions : editor.subflows?.[flowId]?.positions ?? {};
}

export function flowViewport(editor: EditorLayout, flowId: string): StoredViewport | undefined {
  return flowId === ROOT_FLOW ? editor.viewport : editor.subflows?.[flowId]?.viewport;
}
/** View changes are persisted separately from document history; duplicate node IDs cannot share a camera. */
export function withFlowViewport(draft: LocalDraft, flowId: string, viewport: StoredViewport): LocalDraft {
  if (flowId !== ROOT_FLOW && !Object.hasOwn(draft.workflow.subworkflows, flowId)) return draft;
  if (JSON.stringify(flowViewport(draft.editor, flowId)) === JSON.stringify(viewport)) return draft;
  const editor = flowId === ROOT_FLOW ? { ...draft.editor, viewport } : { ...draft.editor, subflows: { ...draft.editor.subflows, [flowId]: { ...draft.editor.subflows?.[flowId], positions: flowPositions(draft.editor, flowId), viewport } } };
  return { ...draft, editor, updatedAt: new Date().toISOString() };
}
/** Undo restores content and positions while retaining cameras for scopes that still exist. */
export function retainViewports(snapshot: LocalDraft, current: LocalDraft): LocalDraft {
  let next = snapshot;
  for (const id of [ROOT_FLOW, ...Object.keys(snapshot.workflow.subworkflows)]) { const view = flowViewport(current.editor, id); if (view) next = withFlowViewport(next, id, view); }
  return next;
}

/** Every mutation returns a whole-project snapshot. Cleanup runs after restoring the complete graph so other scopes retain their pins. */
export function editFlowDraft(draft: LocalDraft, flowId: string, edit: (view: LocalDraft) => LocalDraft): LocalDraft {
  const changed = edit({ ...draft, workflow: flowView(draft.workflow, flowId), editor: { ...draft.editor, positions: flowPositions(draft.editor, flowId) } });
  const workflow = flowId === ROOT_FLOW ? changed.workflow : { ...changed.workflow, ...definitionOf(draft.workflow), subworkflows: { ...changed.workflow.subworkflows, [flowId]: definitionOf(changed.workflow) } };
  // Legacy inspector helpers may remove a pin using the scoped view; the authoritative pass sees every flow.
  const complete = releaseUnusedResourcePins(draft.workflow, { ...workflow, resources: { ...draft.workflow.resources, ...workflow.resources } });
  const editor = flowId === ROOT_FLOW ? changed.editor : { ...draft.editor, subflows: { ...draft.editor.subflows, [flowId]: { ...draft.editor.subflows?.[flowId], positions: changed.editor.positions } } };
  return { ...changed, workflow: complete, editor };
}

/** References are read only from typed config fields, never from literals or arbitrary user strings. */
function references(node: WorkflowNode): FlowRef[] {
  switch (node.type) {
    case 'subworkflow': return [node.config.flowRef];
    case 'loop': return [node.config.bodyFlowRef];
    case 'parallel': return node.config.branches.map(branch => branch.flowRef);
    case 'candidate_search': return [node.config.generatorFlowRef];
    case 'agent_team': return [...node.config.members.map(member => member.flowRef), ...(node.config.integrationFlowRef ? [node.config.integrationFlowRef] : [])];
    case 'orchestrator': return node.config.allowedFlows;
    case 'agent': return node.config.retrievalPolicy?.clarificationFlowRef ? [node.config.retrievalPolicy.clarificationFlowRef] : [];
    default: return [];
  }
}

export function flowReferrers(workflow: Workflow, flowId: string): { flowId: string; nodeId: string; label: string }[] {
  return [[ROOT_FLOW, workflow], ...Object.entries(workflow.subworkflows)].flatMap(([scope, definition]) => (definition as FlowDefinition | undefined)?.nodes.flatMap(node => references(node).some(ref => ref.kind === 'local' && ref.flowId === flowId) ? [{ flowId: String(scope), nodeId: node.id, label: node.label }] : []) ?? []);
}

/** New local flows are a working pass-through; naming never renames existing callers implicitly. */
export function addLocalFlow(workflow: Workflow, flowId: string): Workflow {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(flowId) || ['main', '__proto__', 'prototype', 'constructor'].includes(flowId) || Object.hasOwn(workflow.subworkflows, flowId)) throw new Error('중복되지 않는 영문 흐름 이름을 입력하세요. main은 기본 흐름 이름입니다.');
  const input = { ...createNode('input'), id: 'input' }; const output = { ...createNode('output'), id: 'output' };
  output.config = { format: 'json' }; output.inputBindings = { result: { from: 'workflowInput', pointer: '', onMissing: 'error' } };
  return { ...workflow, subworkflows: { ...workflow.subworkflows, [flowId]: { entryNodeId: input.id, inputs: true, outputs: true, nodes: [input, output], edges: [{ id: 'input_output', from: { nodeId: input.id, port: 'next' }, to: { nodeId: output.id, port: 'in' } }] } } };
}

/** Friendly names are presentation data. Renaming them never changes executable references or schema paths. */
export function flowDisplayNames(draft: LocalDraft): Record<string, string> {
  return Object.fromEntries([['main', '기본 흐름'], ...Object.keys(draft.workflow.subworkflows).filter(id => id !== 'main').map(id => [id, draft.editor.subflows?.[id]?.name ?? id])]);
}
function friendlyName(draft: LocalDraft, value: string, except?: string): string {
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('흐름 이름을 1~80자로 입력하세요.');
  if (Object.entries(flowDisplayNames(draft)).some(([id, label]) => id !== except && label.toLowerCase() === name.toLowerCase())) throw new Error('다른 흐름과 구별할 수 있는 이름을 입력하세요.');
  return name;
}
export function addNamedLocalFlow(draft: LocalDraft, value: string): { draft: LocalDraft; flowId: string } {
  const name = friendlyName(draft, value);
  // Preserve existing ASCII names for readable JSON, while Korean/spaced names get an opaque stable ID.
  const flowId = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) && !['main', 'constructor', 'prototype'].includes(name) && !Object.hasOwn(draft.workflow.subworkflows, name) ? name : `flow_${crypto.randomUUID().replaceAll('-', '')}`;
  const workflow = addLocalFlow(draft.workflow, flowId); const editor = normalizeLayout(draft.editor, workflow);
  editor.subflows![flowId] = { ...editor.subflows![flowId]!, name };
  return { flowId, draft: { ...draft, workflow, editor } };
}
export function renameLocalFlow(draft: LocalDraft, flowId: string, value: string): LocalDraft {
  if (flowId === ROOT_FLOW || !Object.hasOwn(draft.workflow.subworkflows, flowId)) throw new Error('이름을 바꿀 하위 흐름을 선택하세요.');
  const name = friendlyName(draft, value, flowId);
  return { ...draft, editor: { ...draft.editor, subflows: { ...draft.editor.subflows, [flowId]: { ...draft.editor.subflows?.[flowId], positions: flowPositions(draft.editor, flowId), name } } } };
}

/** Deletion cannot leave dangling references, including from modes not yet offered in the palette. */
export function removeLocalFlow(workflow: Workflow, flowId: string): Workflow {
  if (flowId === ROOT_FLOW || !Object.hasOwn(workflow.subworkflows, flowId)) throw new Error('삭제할 하위 흐름을 선택하세요.');
  if (flowReferrers(workflow, flowId).length) throw new Error('이 흐름을 호출하는 블록이 있습니다. 호출 연결을 먼저 해제하세요.');
  const subworkflows = { ...workflow.subworkflows }; delete subworkflows[flowId];
  return releaseUnusedResourcePins(workflow, { ...workflow, subworkflows });
}

/** Scope comes from the existing instancePath contract; duplicate local node IDs cannot redirect an issue to the root. */
export function issueLocation(issue: ValidationIssue, workflow: Workflow): { flowId: string; nodeId?: string } {
  const flowId = Object.keys(workflow.subworkflows).sort((a, b) => b.length - a.length).find(id => issue.instancePath === `/subworkflows/${id}` || issue.instancePath.startsWith(`/subworkflows/${id}/`)) ?? ROOT_FLOW;
  const view = flowView(workflow, flowId); const suffix = flowId === ROOT_FLOW ? issue.instancePath : issue.instancePath.slice(`/subworkflows/${flowId}`.length);
  const index = /^\/nodes\/(\d+)(?:\/|$)/.exec(suffix)?.[1];
  return { flowId, nodeId: index !== undefined ? view.nodes[Number(index)]?.id : issue.nodeId && view.nodes.some(node => node.id === issue.nodeId) ? issue.nodeId : undefined };
}
