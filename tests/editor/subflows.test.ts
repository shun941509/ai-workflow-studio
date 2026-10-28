import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type ResourceRef, type Workflow, type WorkflowNode } from '@studio/spec';
import { analyzeWorkflow } from '@studio/workflow-core';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { addLocalFlow, addNamedLocalFlow, renameLocalFlow, flowDisplayNames, removeLocalFlow, editFlowDraft, flowReferrers, flowView, issueLocation } from '../../apps/studio-web/src/features/editor/flow-helpers';
import { normalizeLayout, type LocalDraft } from '../../apps/studio-web/src/features/editor/local-drafts';
import { editorSupportIssues, explainEditorIssue } from '../../apps/studio-web/src/features/editor/editor-contract';
import { withResourceAttachment, withoutResourceAttachment } from '../../apps/studio-web/src/features/editor/resource-links';
import { nodeValueOptions } from '../../apps/studio-web/src/features/editor/binding-options';

const typedNode = <T extends WorkflowNode['type']>(type: T) => createNode(type) as Extract<WorkflowNode, { type: T }>;
const draftOf = (workflow: Workflow): LocalDraft => ({ storageVersion: 1, workflow, editor: normalizeLayout({}, workflow), updatedAt: '2026-10-28T00:00:00Z' });
/** These contracts exercise scope collisions and real archive bytes without calling a provider. */
describe('subflow authoring boundaries', () => {
  it('keeps Korean names in layout while stable references survive renaming and scoped edits', () => {
    const created = addNamedLocalFlow(draftOf(createBasicWorkflow()), '문서 정리');
    expect(created.flowId).toMatch(/^flow_[a-f0-9]{32}$/);
    expect(flowDisplayNames(created.draft)[created.flowId]).toBe('문서 정리');
    const call = typedNode('subworkflow'); call.config.flowRef = { kind: 'local', flowId: created.flowId };
    created.draft.workflow.nodes.push(call);
    created.draft.editor = normalizeLayout(created.draft.editor, created.draft.workflow);
    const renamed = renameLocalFlow(created.draft, created.flowId, '결과 검토');
    expect(renamed.workflow).toBe(created.draft.workflow);
    expect(call.config.flowRef).toEqual({ kind: 'local', flowId: created.flowId });
    const edited = editFlowDraft(renamed, created.flowId, view => ({ ...view, workflow: { ...view.workflow, inputs: { type: 'string' } } }));
    expect(edited.editor.subflows![created.flowId]!.name).toBe('결과 검토');
    expect(normalizeLayout(JSON.parse(JSON.stringify(edited.editor)), edited.workflow)).toEqual(edited.editor);
    for (const name of ['', '기본 흐름', '결과 검토', 'a\u0000b', 'a'.repeat(81)]) expect(() => addNamedLocalFlow(edited, name)).toThrow();
    const ascii = addNamedLocalFlow(edited, 'details'); expect(ascii.flowId).toBe('details');
    expect(() => renameLocalFlow(ascii.draft, created.flowId, 'details')).toThrow();
  });
  it('adds a valid pass-through and rejects reserved, duplicate, or unsafe new names', () => {
    const workflow = addLocalFlow(createBasicWorkflow(), 'child');
    expect(analyzeWorkflow(workflow)).toEqual([]); expect(editorSupportIssues(workflow)).toEqual([]);
    for (const name of ['main', 'child', '__proto__', 'constructor', '../child', '']) expect(() => addLocalFlow(workflow, name)).toThrow();
    expect(() => removeLocalFlow(workflow, 'main')).toThrow(); expect(() => flowView(workflow, 'missing')).toThrow();
  });
  it('scopes identical node ids, edge edits, schemas and layout inside one immutable snapshot', () => {
    const workflow = addLocalFlow(addLocalFlow(createBasicWorkflow(), 'child'), 'second'); const original = draftOf(workflow);
    const next = editFlowDraft(original, 'child', view => ({ ...view, workflow: { ...view.workflow, inputs: { type: 'string' }, nodes: view.workflow.nodes.map(node => node.id === 'input' ? { ...node, label: 'Child entry' } : node) as Workflow['nodes'] }, editor: { ...view.editor, positions: { ...view.editor.positions, input: { x: 900, y: 500 } } } }));
    expect(next.workflow.subworkflows.child!.nodes[0]!.label).toBe('Child entry'); expect(next.workflow.nodes).toEqual(original.workflow.nodes);
    expect(next.workflow.subworkflows.second).toEqual(original.workflow.subworkflows.second); expect(next.editor.subflows!.child!.positions.input).toEqual({ x: 900, y: 500 });
    expect(next.editor.positions).toEqual(original.editor.positions); expect(original.workflow.subworkflows.child!.inputs).toBe(true);
    const reopened = normalizeLayout(JSON.parse(JSON.stringify(next.editor)), next.workflow); expect(reopened).toEqual(next.editor);
  });
  it('bounds old and nested layouts and discards deleted scopes', () => {
    const workflow = addLocalFlow(createBasicWorkflow(), 'child');
    const layout = normalizeLayout({ positions: { [workflow.entryNodeId]: { x: 12, y: 20 } }, subflows: { child: { positions: { input: { x: Infinity, y: 0 } } }, stale: { positions: {} } } }, workflow);
    expect(layout.positions[workflow.entryNodeId]).toEqual({ x: 12, y: 20 }); expect(layout.subflows!.child!.positions.input).toEqual({ x: 70, y: 170 }); expect(layout.subflows).not.toHaveProperty('stale');
  });
  it('blocks deletion for references in other scopes and unsupported modes but ignores literal strings', () => {
    let workflow = addLocalFlow(addLocalFlow(createBasicWorkflow(), 'child'), 'caller'); const call = typedNode('subworkflow'); call.config.flowRef = { kind: 'local', flowId: 'child' }; workflow.subworkflows.caller!.nodes.push(call);
    expect(flowReferrers(workflow, 'child')).toHaveLength(1); expect(() => removeLocalFlow(workflow, 'child')).toThrow();
    workflow.subworkflows.caller!.nodes.pop(); const parallel = typedNode('parallel'); parallel.config.branches[0]!.flowRef = { kind: 'local', flowId: 'child' }; workflow.nodes.push(parallel);
    expect(() => removeLocalFlow(workflow, 'child')).toThrow(); workflow.nodes.pop(); workflow.nodes[1]!.inputBindings.context = { from: 'literal', value: { kind: 'local', flowId: 'child' } };
    expect(removeLocalFlow(workflow, 'child').subworkflows).not.toHaveProperty('child');
  });
  it('checks every hidden mode and resolves issues to the child with repeated node ids', () => {
    const workflow = addLocalFlow(createBasicWorkflow(), 'child'); const request = typedNode('form'); request.id = 'work'; request.config.mode = 'request'; workflow.subworkflows.child!.nodes.push(request);
    const issue = editorSupportIssues(workflow)[0]!; expect(issue.instancePath).toBe('/subworkflows/child/nodes/2/config'); expect(issueLocation(issue, workflow)).toEqual({ flowId: 'child', nodeId: 'work' });
    expect(explainEditorIssue(issue, workflow).message).toContain('[child]');
    workflow.subworkflows.child!.nodes.push(typedNode('parallel')); expect(editorSupportIssues(workflow).some(item => item.instancePath === '/subworkflows/child/nodes/3')).toBe(true);
  });
  it('preserves the complete resource graph when a scoped helper releases its last visible attachment', () => {
    const reference: ResourceRef = { id: 'shared', kind: 'instruction', revision: 1, sha256: 'a'.repeat(64) };
    let workflow = addLocalFlow(createBasicWorkflow(), 'child'); const ai = createNode('ai'); ai.id = 'work'; workflow.subworkflows.child!.nodes.push(ai);
    workflow = withResourceAttachment(workflow, 'work', reference); let draft = editFlowDraft(draftOf(workflow), 'child', view => ({ ...view, workflow: withResourceAttachment(view.workflow, 'work', reference) }));
    draft = editFlowDraft(draft, 'child', view => ({ ...view, workflow: withoutResourceAttachment(view.workflow, 'work', reference.id) }));
    expect(draft.workflow.resources.shared).toEqual(reference); expect(draft.workflow.nodes.find(node => node.id === 'work')!.attachments).toHaveLength(1);
    draft = editFlowDraft(draft, 'main', view => ({ ...view, workflow: withoutResourceAttachment(view.workflow, 'work', reference.id) })); expect(draft.workflow.resources.shared).toBeUndefined();
  });
  it('only suggests declared child data fields with no invented result wrapper', () => {
    const workflow = addLocalFlow(createBasicWorkflow(), 'child'); workflow.subworkflows.child!.outputs = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    const call = typedNode('subworkflow'); call.config.flowRef = { kind: 'local', flowId: 'child' };
    expect(nodeValueOptions(call, workflow).map(option => option.pointer)).toEqual(['/data', '/data/title']);
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves the full graph and scoped positions in a real %s archive', async host => {
    const draft = draftOf(addLocalFlow(createBasicWorkflow(), 'child')); draft.editor.subflows!.child!.positions.input = { x: 900, y: 500 };
    const archive = await buildPackage({ workflow: draft.workflow, editor: draft.editor, host }); const inspected = await inspectPackage(archive.bytes);
    expect(inspected.workflow).toEqual(draft.workflow); expect(JSON.parse(new TextDecoder().decode(inspected.files.get('editor.json')))).toEqual(draft.editor);
  });
  it('retains the core fail-closed recursive/missing/depth checks', () => {
    const workflow = addLocalFlow(createBasicWorkflow(), 'child'); const call = typedNode('subworkflow'); call.config.flowRef = { kind: 'local', flowId: 'child' }; call.inputBindings.input = { from: 'workflowInput', pointer: '', onMissing: 'error' }; workflow.subworkflows.child!.nodes.push(call);
    expect(analyzeWorkflow(workflow).map(issue => issue.code)).toContain('FLOW_RECURSION'); call.config.flowRef.flowId = 'missing'; expect(analyzeWorkflow(workflow).map(issue => issue.code)).toContain('FLOW_NOT_FOUND');
    const nested = addLocalFlow(workflow, 'grandchild'); call.config.flowRef.flowId = 'grandchild'; const rootCall = typedNode('subworkflow'); rootCall.config.flowRef = { kind: 'local', flowId: 'child' }; nested.nodes.push(rootCall); nested.policy.limits.maxChildDepth = 1;
    expect(analyzeWorkflow(nested).map(issue => issue.code)).toContain('FLOW_DEPTH_EXCEEDED');
  });
});
