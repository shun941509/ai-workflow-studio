import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { analyzeWorkflow, applyWorkingContextPreset, validateWorkingContextSemantics, validateWorkDefinitionSemantics, workingTaskContext } from '@studio/workflow-core';
import { buildPackage, inspectPackage, prepareAuthoringImport } from '@studio/package-kit';
import { applyCompletionEdit, completionReferenceIssues, completionSources } from '../../apps/studio-web/src/features/editor/completion-authoring';

const edge = (a: string, b: string, port = 'next'): WorkflowEdge => ({ id: `${a}_${port}_${b}`, from: { nodeId: a, port }, to: { nodeId: b, port: 'in' } });
const from = (nodeId: string) => ({ from: 'node' as const, nodeId, pointer: '/data', onMissing: 'error' as const });
function rootReviewFlow(): Workflow {
  const workflow = createBasicWorkflow(), check = createNode('evaluate'), review = createNode('review'), merge = createNode('merge');
  if (check.type !== 'evaluate' || review.type !== 'review' || merge.type !== 'merge') throw new Error('Unexpected factory node');
  check.id = 'check'; check.label = '필수 검사'; check.inputBindings.value = from('work');
  review.id = 'review'; review.label = '최종 검토'; review.inputBindings.value = from('work'); review.config.responseSchema = true;
  merge.id = 'merge'; merge.inputBindings = { selected: from('review') }; merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' };
  workflow.nodes.splice(2, 0, check, review, merge); workflow.nodes.find(node => node.type === 'output')!.inputBindings.result = from('merge'); workflow.outputs = true;
  workflow.edges = [edge('start', 'work'), edge('work', 'check'), edge('check', 'review'), edge('review', 'merge', 'accepted'), edge('review', 'merge', 'rejected'), edge('merge', 'finish')]; return workflow;
}
function defined(): Workflow {
  const workflow = applyCompletionEdit(rootReviewFlow(), { type: 'enable' });
  workflow.workDefinition = { version: 1, id: 'business', revision: 1, card: { id: 'card', title: '정리 파트너', purpose: '입력을 정리' }, role: { id: 'role', title: '작성 담당', responsibility: '원문 보존' }, task: { id: 'task', title: '초안 만들기', goal: '확인 가능한 초안', criterionIds: ['criterion_1'], assets: [], skills: [] }, harness: { context: ['start'], perform: ['work'], accept: ['finish'], deliver: ['finish'], selectedContext: [] } }; return workflow;
}

describe('explicit completion authoring', () => {
  it('leaves legacy untouched until explicit opt-in and copies output shape without aliasing', () => {
    const original = createBasicWorkflow(), before = structuredClone(original); expect(original.completion).toBeUndefined();
    const next = applyCompletionEdit(original, { type: 'enable' }); expect(original).toEqual(before);
    expect(next.completion).toEqual({ version: 1, criteria: [{ id: 'criterion_1', kind: 'result_schema', label: '최종 결과 형식 확인', schema: original.outputs }] });
    expect(next.completion!.criteria[0]).not.toBe(original.outputs); expect(next.nodes).toBe(original.nodes); expect(next.edges).toBe(original.edges);
    const criterion = next.completion!.criteria[0]!; if (criterion.kind !== 'result_schema' || typeof criterion.schema !== 'object') throw new Error('schema'); criterion.schema.minLength = 7; expect(original.outputs).toEqual(before.outputs);
  });
  it('rejects implicit add, repeated opt-in and child-flow edits', () => {
    const original = createBasicWorkflow(); expect(() => applyCompletionEdit(original, { type: 'add', kind: 'result_schema', label: '형식' })).toThrow();
    const enabled = applyCompletionEdit(original, { type: 'enable' }); expect(() => applyCompletionEdit(enabled, { type: 'enable' })).toThrow(); expect(() => applyCompletionEdit(enabled, { type: 'disable' }, 'child')).toThrow(/기본 흐름/);
  });
  it('requires a separate disable action for the last criterion and never alters results or logic', () => {
    const enabled = applyCompletionEdit(rootReviewFlow(), { type: 'enable' }), before = structuredClone(enabled);
    expect(() => applyCompletionEdit(enabled, { type: 'remove', id: 'criterion_1' })).toThrow(/해제/);
    const disabled = applyCompletionEdit(enabled, { type: 'disable' }); expect(disabled).not.toHaveProperty('completion'); expect(disabled.nodes).toEqual(before.nodes); expect(disabled.outputs).toEqual(before.outputs); expect(enabled).toEqual(before);
  });
  it('lists only unique root sources in supported modes, with current labels', () => {
    const workflow = rootReviewFlow(), child = rootReviewFlow(); workflow.subworkflows.child = { entryNodeId: child.entryNodeId, inputs: child.inputs, outputs: child.outputs, nodes: child.nodes, edges: child.edges };
    const agent = createNode('agent'); if (agent.type !== 'agent') throw new Error('factory'); agent.id = 'search'; agent.config = { modelProfile: 'text-default', strategy: 'agentic_rag', instructions: '근거 확인', maxSteps: 12, toolAllowlist: [], resultSchema: true, retrievalPolicy: { maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000, onInsufficient: 'abstain' } }; agent.inputBindings = { task: { from: 'literal', value: '질문' }, indexes: { from: 'literal', value: [] } }; workflow.nodes.push(agent);
    const loop = createNode('loop'); if (loop.type !== 'loop') throw new Error('factory'); loop.id = 'until'; loop.config = { mode: 'until', maxIterations: 3, bodyFlowRef: { kind: 'local', flowId: 'child' }, untilExpression: { literal: true } }; workflow.nodes.push(loop);
    expect(completionSources(workflow).map(source => [source.id, source.kind])).toEqual([['check', 'evaluate_passed'], ['review', 'review_accepted'], ['search', 'agentic_answered'], ['until', 'loop_condition_met']]);
    workflow.nodes.find(node => node.id === 'review')!.label = '이름 바뀐 검토'; expect(completionSources(workflow).find(source => source.id === 'review')!.label).toBe('이름 바뀐 검토');
    agent.config.retrievalPolicy!.onInsufficient = 'ask'; loop.config.mode = 'foreach'; const check = workflow.nodes.find((node): node is Extract<WorkflowNode, { type: 'evaluate' }> => node.type === 'evaluate')!; check.config.mode = 'model';
    expect(completionSources(workflow).map(source => source.id)).toEqual(['review']); workflow.nodes.push(structuredClone(workflow.nodes.find(node => node.id === 'review')!)); expect(completionSources(workflow)).toEqual([]);
  });
  it.each(['missing', 'work', 'start'] as const)('rejects a newly selected invalid review target %s', nodeId => {
    const enabled = applyCompletionEdit(rootReviewFlow(), { type: 'enable' }); expect(() => applyCompletionEdit(enabled, { type: 'add', kind: 'review_accepted', label: '검토', nodeId })).toThrow();
  });
  it('repairs multiple stale references independently without dropping or silently retargeting the others', () => {
    const workflow = applyCompletionEdit(rootReviewFlow(), { type: 'enable' }); workflow.completion!.criteria.push({ id: 'stale1', kind: 'review_accepted', label: '전 검토', nodeId: 'removed1' }, { id: 'stale2', kind: 'review_accepted', label: '다른 검토', nodeId: 'removed2' });
    expect(completionReferenceIssues(workflow)).toHaveLength(2);
    const repaired = applyCompletionEdit(workflow, { type: 'replace', id: 'stale1', criterion: { id: 'stale1', kind: 'review_accepted', label: '전 검토', nodeId: 'review' } });
    expect(completionReferenceIssues(repaired).map(issue => issue.id)).toEqual(['stale2']); expect(workflow.completion!.criteria[1]).toHaveProperty('nodeId', 'removed1');
    const fixed = applyCompletionEdit(repaired, { type: 'remove', id: 'stale2' }); expect(completionReferenceIssues(fixed)).toEqual([]);
  });
  it('rejects changed IDs, whitespace labels, invalid schemas and more than 32 criteria without mutation', () => {
    const workflow = applyCompletionEdit(rootReviewFlow(), { type: 'enable' }), original = structuredClone(workflow), first = workflow.completion!.criteria[0]!;
    expect(() => applyCompletionEdit(workflow, { type: 'replace', id: first.id, criterion: { ...first, id: 'new' } })).toThrow();
    expect(() => applyCompletionEdit(workflow, { type: 'replace', id: first.id, criterion: { ...first, label: '  ' } })).toThrow();
    expect(() => applyCompletionEdit(workflow, { type: 'replace', id: first.id, criterion: { id: first.id, label: first.label, kind: 'result_schema', schema: { type: 'string', pattern: '(a+)+' } } })).toThrow(); expect(workflow).toEqual(original);
    let full = workflow; for (let i = 1; i < 32; i++) full = applyCompletionEdit(full, { type: 'add', kind: 'result_schema', label: `기준 ${i}` });
    const before = structuredClone(full); expect(() => applyCompletionEdit(full, { type: 'add', kind: 'result_schema', label: '33번째' })).toThrow(); expect(full).toEqual(before);
  });
  it('adds the selected existing rules/review pair atomically and does not duplicate existing evidence', () => {
    const workflow = rootReviewFlow(), original = structuredClone(workflow), next = applyCompletionEdit(workflow, { type: 'checks-and-review', evaluationId: 'check', reviewId: 'review' });
    expect(next.completion!.criteria.map(criterion => criterion.kind)).toEqual(['evaluate_passed', 'review_accepted']); expect(next.nodes).toEqual(original.nodes); expect(next.edges).toEqual(original.edges); expect(workflow).toEqual(original);
    expect(() => applyCompletionEdit(next, { type: 'checks-and-review', evaluationId: 'check', reviewId: 'review' })).toThrow(/이미/);
    expect(() => applyCompletionEdit(next, { type: 'checks-and-review', evaluationId: 'work', reviewId: 'review' })).toThrow();
  });
  it('keeps all business criterion IDs and acceptance nodes canonical in one edit', () => {
    const workflow = defined(), before = structuredClone(workflow), next = applyCompletionEdit(workflow, { type: 'checks-and-review', evaluationId: 'check', reviewId: 'review' });
    expect(next.workDefinition!.task.criterionIds).toEqual(next.completion!.criteria.map(criterion => criterion.id)); expect(next.workDefinition!.harness.accept).toEqual(['finish', 'check', 'review']); expect(validateWorkDefinitionSemantics(next)).toEqual([]);
    expect(next.workDefinition!.task.goal).toBe(before.workDefinition!.task.goal); expect(next.nodes).toEqual(before.nodes); expect(workflow).toEqual(before);
    expect(() => applyCompletionEdit(workflow, { type: 'disable' })).toThrow(/업무 정의/); expect(() => applyCompletionEdit(workflow, { type: 'remove', id: 'criterion_1' })).toThrow(/최소/);
  });
  it('refreshes existing generated businessTask context without changing request, instructions, budget or control edges', () => {
    const workflow = applyWorkingContextPreset(defined(), 65536), before = structuredClone(workflow), next = applyCompletionEdit(workflow, { type: 'add', kind: 'review_accepted', label: '수락', nodeId: 'review' });
    expect(validateWorkingContextSemantics(next)).toEqual([]); expect(next.workDefinition!.harness.workingContext!.maxBytes).toBe(65536);
    const binding = next.workDefinition!.harness.workingContext!.bindings[0]!, context = next.nodes.find(node => node.id === binding.contextNodeId)!, priorContext = before.nodes.find(node => node.id === binding.contextNodeId)!;
    expect(context.inputBindings.businessTask).toEqual({ from: 'literal', value: workingTaskContext(next) }); expect(context.inputBindings.request).toEqual(priorContext.inputBindings.request);
    expect(next.nodes.filter(node => node.id !== context.id)).toEqual(before.nodes.filter(node => node.id !== context.id)); expect(next.edges).toEqual(before.edges); expect(next.policy).toEqual(before.policy); expect(workflow).toEqual(before);
  });
  it.each(['control', 'binding', 'literal'] as const)('does not repair a previously tampered working context %s while editing criteria', tamper => {
    const workflow = applyWorkingContextPreset(defined()), binding = workflow.workDefinition!.harness.workingContext!.bindings[0]!;
    if (tamper === 'control') workflow.edges = workflow.edges.filter(edge => edge.from.nodeId !== binding.contextNodeId);
    else if (tamper === 'binding') workflow.nodes.find(node => node.id === binding.nodeId)!.inputBindings.context = { from: 'literal', value: 'other' };
    else workflow.nodes.find(node => node.id === binding.contextNodeId)!.inputBindings.businessTask = { from: 'literal', value: 'tampered' };
    const before = structuredClone(workflow); expect(() => applyCompletionEdit(workflow, { type: 'add', kind: 'review_accepted', label: '검토', nodeId: 'review' })).toThrow(/문맥/); expect(workflow).toEqual(before);
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves %s authored acceptance through the real package and re-import boundary', async host => {
    const workflow = applyCompletionEdit(defined(), { type: 'checks-and-review', evaluationId: 'check', reviewId: 'review' }); expect(analyzeWorkflow(workflow)).toEqual([]);
    const built = await buildPackage({ host, workflow }), inspected = await inspectPackage(built.bytes), restored = await prepareAuthoringImport(built.bytes);
    expect(inspected.workflow).toEqual(workflow); expect(restored.workflow).toEqual(workflow); expect(inspected.manifest.requiredCapabilities).toContain('workflow.completion@1'); expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
  });
});
