import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, validateNodeShape } from '@studio/spec';
import { validateAgenticRag, validateTaskAgent } from '@studio/workflow-core';
import { AGENTIC_CONTRACT } from '../../apps/runner/src/agentic/contracts.js';
import { AGENTIC_AUTHORING, AGENTIC_DEFAULTS, addAgenticDeclaration, changeAgentStrategy, nextAgenticAlias, validateAuthoredAgent, type AgentNode } from '../../apps/studio-web/src/features/editor/agent-authoring';
import { addLocalFlow, editFlowDraft } from '../../apps/studio-web/src/features/editor/flow-helpers';
import { newLocalDraft } from '../../apps/studio-web/src/features/editor/local-drafts';
import { bindingFields, editorSupportIssues } from '../../apps/studio-web/src/features/editor/editor-contract';
import { nodeValueOptions } from '../../apps/studio-web/src/features/editor/binding-options';
import { withResourceAttachment } from '../../apps/studio-web/src/features/editor/resource-links';

/** These are authoring definitions, not model responses or evidence of actual index ownership. */
function fixture() {
  const workflow = createBasicWorkflow('에이전트 작성 회귀');
  const created = createNode('agent'); if (created.type !== 'agent') throw new Error('agent factory');
  const node: AgentNode = { ...created, id: 'agent_work', config: { ...created.config, maxSteps: 1, instructions: '출처로 확인할 수 없는 내용은 유보하세요.', resultSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }, inputBindings: { task: { from: 'literal', value: '문서에서 배송 기간을 찾아주세요.' }, context: { from: 'literal', value: { locale: 'ko' } } } };
  workflow.nodes.push(node);
  return { workflow, node };
}
function agenticFixture() {
  const initial = fixture();
  let workflow = { ...initial.workflow, ...changeAgentStrategy(initial.workflow, initial.node.id, 'agentic_rag') };
  workflow = { ...workflow, ...addAgenticDeclaration(workflow, initial.node.id, 'agentic_default') };
  const node = workflow.nodes.find(item => item.id === initial.node.id) as AgentNode;
  node.inputBindings = { ...node.inputBindings, indexes: { from: 'node', nodeId: 'indexes', pointer: '/data', onMissing: 'error' } };
  return { workflow, node };
}

describe('bounded Agentic authoring contract', () => {
  it('keeps browser-safe limits aligned with the real Runner contract without importing Runner into the client', () => {
    const { contractId, ...limits } = AGENTIC_AUTHORING;
    expect(contractId).toBe(AGENTIC_CONTRACT.id);
    expect(AGENTIC_CONTRACT).toMatchObject(limits);
    expect(AGENTIC_DEFAULTS).toEqual({ maxSteps: 12, maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000 });
  });
  it('preserves task instructions, schema, model, input bindings, execution and unrelated nodes in one patch', () => {
    const { workflow, node } = fixture(); const before = structuredClone(workflow);
    const patch = changeAgentStrategy(workflow, node.id, 'agentic_rag'); const next = { ...workflow, ...patch };
    expect(Object.keys(patch)).toEqual(['nodes']); expect(workflow).toEqual(before);
    const changed = next.nodes.find(item => item.id === node.id) as AgentNode;
    expect(changed.config).toEqual({ ...node.config, strategy: 'agentic_rag', maxSteps: 12, retrievalPolicy: { maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000, onInsufficient: 'abstain' } });
    expect(changed.inputBindings).toEqual(node.inputBindings); expect(changed.inputBindings).not.toHaveProperty('indexes');
    expect(changed.execution).toEqual(node.execution); expect(changed.attachments).toEqual(node.attachments);
    expect(next.nodes.filter(item => item.id !== node.id)).toEqual(before.nodes.filter(item => item.id !== node.id));
    expect(validateNodeShape(changed).valid).toBe(true);
    expect(() => validateAuthoredAgent(changed, next)).toThrow(/작업과 현재 실행/);
  });
  it('accepts the supported completed definition and integer endpoint settings', () => {
    const { node, workflow } = agenticFixture();
    expect(() => validateAuthoredAgent(node, workflow)).not.toThrow(); expect(() => validateAgenticRag(node)).not.toThrow();
    for (const settings of [
      { maxSteps: 3, maxRounds: 1, maxQueriesPerRound: 1, maxRetrievedChunks: 1, maxContextTokens: 20 },
      { maxSteps: 32, maxRounds: 4, maxQueriesPerRound: 3, maxRetrievedChunks: 100, maxContextTokens: 12000 },
    ]) {
      const { maxSteps, ...policy } = settings;
      const bounded = { ...node, config: { ...node.config, maxSteps, retrievalPolicy: { ...node.config.retrievalPolicy!, ...policy } } };
      expect(() => validateAuthoredAgent(bounded, workflow)).not.toThrow();
    }
  });
  it.each([
    ['maxSteps', 2], ['maxSteps', 33], ['maxSteps', 3.5], ['maxSteps', Number.NaN],
    ['maxRounds', 0], ['maxRounds', 5], ['maxRounds', 1.5],
    ['maxQueriesPerRound', 0], ['maxQueriesPerRound', 4], ['maxQueriesPerRound', 1.5],
    ['maxRetrievedChunks', 0], ['maxRetrievedChunks', 101], ['maxRetrievedChunks', 1.5],
    ['maxContextTokens', 19], ['maxContextTokens', 12001], ['maxContextTokens', 20.5],
  ] as const)('rejects %s=%s without rounding or clamping', (key, value) => {
    const { node } = agenticFixture();
    if (key === 'maxSteps') node.config.maxSteps = value; else node.config.retrievalPolicy![key] = value;
    expect(() => validateAuthoredAgent(node)).toThrow();
    expect(key === 'maxSteps' ? node.config.maxSteps : node.config.retrievalPolicy![key]).toBe(value);
  });
  it.each(['attachments', 'long-instructions', 'tools', 'retry', 'error-route', 'error-edge', 'unknown-input', 'unsupported-task'] as const)('does not erase %s while changing to search', mode => {
    const { workflow, node } = fixture();
    if (mode === 'attachments') node.attachments = [{ resource: 'saved', role: 'reference' }];
    if (mode === 'long-instructions') node.config.instructions = '가'.repeat(16001);
    if (mode === 'tools') node.config.toolAllowlist = [{ kind: 'builtin', id: 'future', version: 1 }];
    if (mode === 'retry') node.execution.retry.maxAttempts = 2;
    if (mode === 'error-route') node.execution.onError = 'route';
    if (mode === 'error-edge') workflow.edges.push({ id: 'error_edge', from: { nodeId: node.id, port: 'error' }, to: { nodeId: workflow.nodes[0].id, port: 'in' } });
    if (mode === 'unknown-input') node.inputBindings.future = { from: 'literal', value: '원문 보존' };
    if (mode === 'unsupported-task') node.config.maxSteps = 8;
    const before = structuredClone(workflow);
    expect(() => changeAgentStrategy(workflow, node.id, 'agentic_rag')).toThrow(); expect(workflow).toEqual(before);
  });
  it('requires explicit search removal and preserves every unrelated setting when returning to task', () => {
    const { workflow, node } = agenticFixture(); const before = structuredClone(workflow);
    expect(() => changeAgentStrategy(workflow, node.id, 'task')).toThrow(/제거/); expect(workflow).toEqual(before);
    const patch = changeAgentStrategy(workflow, node.id, 'task', { discardSearchSettings: true }); const changed = patch.nodes!.find(item => item.id === node.id) as AgentNode;
    expect(Object.keys(patch)).toEqual(['nodes']); expect(changed.config).not.toHaveProperty('retrievalPolicy'); expect(changed.inputBindings).not.toHaveProperty('indexes');
    expect(changed.config).toEqual({ strategy: 'task', maxSteps: 1, modelProfile: node.config.modelProfile, instructions: node.config.instructions, resultSchema: node.config.resultSchema, toolAllowlist: [] });
    expect(changed.inputBindings).toEqual({ task: node.inputBindings.task, context: node.inputBindings.context }); expect(changed.execution).toEqual(node.execution);
    expect(() => validateTaskAgent(changed)).not.toThrow(); expect(workflow).toEqual(before);
  });
  it('does not silently repair unsupported imported Agentic settings on same-mode selection', () => {
    const { workflow, node } = agenticFixture(); node.config.retrievalPolicy!.onInsufficient = 'ask'; node.config.retrievalPolicy!.clarificationFlowRef = { kind: 'local', flowId: 'ask_user' };
    const before = structuredClone(workflow);
    expect(changeAgentStrategy(workflow, node.id, 'agentic_rag')).toEqual({});
    expect(() => validateAuthoredAgent(node)).toThrow(/추가 질문/); expect(workflow).toEqual(before);
  });
  it.each(['tools', 'attachment', 'retry', 'route', 'unexpected-input', 'missing-task', 'missing-indexes'] as const)('rejects the unsupported Agentic %s boundary', mode => {
    const { node } = agenticFixture();
    if (mode === 'tools') node.config.toolAllowlist = [{ kind: 'builtin', id: 'future', version: 1 }];
    if (mode === 'attachment') node.attachments = [{ resource: 'saved', role: 'reference' }];
    if (mode === 'retry') node.execution.retry.maxAttempts = 2;
    if (mode === 'route') node.execution.onError = 'route';
    if (mode === 'unexpected-input') node.inputBindings.query = { from: 'literal', value: '금지' };
    if (mode === 'missing-task') delete node.inputBindings.task;
    if (mode === 'missing-indexes') delete node.inputBindings.indexes;
    expect(() => validateAuthoredAgent(node)).toThrow();
  });
  it('validates literal task characters and UTF-8 serialized context bytes independently', () => {
    const { node } = agenticFixture(); node.inputBindings.task = { from: 'literal', value: '가'.repeat(16000) };
    node.inputBindings.context = { from: 'literal', value: '가'.repeat(5460) + 'ab' };
    expect(new TextEncoder().encode(JSON.stringify(node.inputBindings.context.value)).byteLength).toBe(16384);
    expect(() => validateAuthoredAgent(node)).not.toThrow();
    node.inputBindings.context.value += 'c'; expect(() => validateAuthoredAgent(node)).toThrow(/16 KiB/); delete node.inputBindings.context;
    for (const value of ['', '  \n ', 3, 'a'.repeat(16001)]) { node.inputBindings.task = { from: 'literal', value }; expect(() => validateAuthoredAgent(node)).toThrow(/16,000자/); }
  });
  it('rejects direct index cardinality errors while leaving dynamic ownership and generation checks to Runner', () => {
    const { node } = agenticFixture();
    for (const value of [[], 'one-index', [1, 2, 3, 4, 5]]) { node.inputBindings.indexes = { from: 'literal', value }; expect(() => validateAuthoredAgent(node)).toThrow(/1~4개/); }
    node.inputBindings.indexes = { from: 'workflowInput', pointer: '/indexes', onMissing: 'error' };
    expect(() => validateAuthoredAgent(node)).not.toThrow(); // A child input is structurally valid, not evidence that any runtime IndexRef is trusted.
  });
  it('adds a distinct chat declaration and reference in one patch without overwriting existing roles', () => {
    const { workflow, node } = agenticFixture(); workflow.modelProfiles.embedding = { kind: 'embedding', requiredFeatures: ['embedding'] }; const before = structuredClone(workflow);
    const patch = addAgenticDeclaration(workflow, node.id, 'planner');
    expect(patch.modelProfiles!.planner).toEqual({ kind: 'chat', requiredFeatures: ['json_schema'] });
    expect((patch.nodes!.find(item => item.id === node.id) as AgentNode).config.modelProfile).toBe('planner');
    expect(patch.modelProfiles!.embedding).toEqual(before.modelProfiles.embedding); expect(workflow).toEqual(before);
    expect(() => addAgenticDeclaration(workflow, node.id, 'embedding')).toThrow(/이미/);
    for (const alias of ['한글', '../profile', '__proto__', 'prototype', 'constructor', '', 'a'.repeat(65)]) expect(() => addAgenticDeclaration(workflow, node.id, alias)).toThrow();
    expect(() => addAgenticDeclaration(fixture().workflow, node.id, 'planner')).toThrow(/먼저/);
  });
  it.each(['embedding', 'reranker', 'missing'] as const)('does not treat %s as a chat declaration', kind => {
    const { workflow, node } = agenticFixture(); node.config.modelProfile = 'other';
    if (kind !== 'missing') workflow.modelProfiles.other = { kind, requiredFeatures: [] };
    expect(() => validateAuthoredAgent(node, workflow)).toThrow(/대화/);
  });
  it('allocates aliases across roles and scopes and commits a child without changing root identity or layout', () => {
    const draft = newLocalDraft(); draft.workflow = addLocalFlow(draft.workflow, 'child'); const rootNode = fixture().node;
    draft.workflow.nodes.push(rootNode); draft.workflow.subworkflows.child!.nodes.push(structuredClone(rootNode));
    draft.editor.subflows = { child: { name: '근거 확인', positions: { agent_work: { x: 90, y: 140 } } } };
    const before = structuredClone(draft);
    const switched = editFlowDraft(draft, 'child', view => ({ ...view, workflow: { ...view.workflow, ...changeAgentStrategy(view.workflow, 'agent_work', 'agentic_rag') } }));
    const declared = editFlowDraft(switched, 'child', view => ({ ...view, workflow: { ...view.workflow, ...addAgenticDeclaration(view.workflow, 'agent_work', nextAgenticAlias(view.workflow)) } }));
    expect(declared.workflow.nodes).toEqual(before.workflow.nodes); expect(declared.editor).toEqual(before.editor); expect(draft).toEqual(before);
    expect(declared.workflow.modelProfiles.agentic_default).toEqual({ kind: 'chat', requiredFeatures: ['json_schema'] });
    expect((declared.workflow.subworkflows.child!.nodes.at(-1) as AgentNode).config).toMatchObject({ strategy: 'agentic_rag', modelProfile: 'agentic_default' });
    expect(nextAgenticAlias(declared.workflow)).toBe('agentic_2'); declared.workflow.modelProfiles.agentic_2 = { kind: 'embedding', requiredFeatures: [] }; expect(nextAgenticAlias(declared.workflow)).toBe('agentic_3');
    // Each returned full draft is a self-contained history snapshot; real browser undo/redo remains an integration check.
    expect(switched.workflow.modelProfiles).toEqual(before.workflow.modelProfiles); expect((switched.workflow.subworkflows.child!.nodes.at(-1) as AgentNode).config.modelProfile).toBe(rootNode.config.modelProfile);
  });
  it('exposes required index arrays only for Agentic and applies the same export gate to child flows', () => {
    expect(bindingFields(fixture().node)).toEqual([{ key: 'task', required: true }, { key: 'context', required: false }]);
    const { workflow, node } = agenticFixture();
    expect(bindingFields(node)).toEqual([{ key: 'task', required: true }, { key: 'context', required: false }, { key: 'indexes', required: true }]);
    expect(editorSupportIssues(workflow)).toEqual([]);
    const child = structuredClone(node); child.config.retrievalPolicy!.onInsufficient = 'ask';
    workflow.subworkflows.child = { entryNodeId: 'entry', inputs: true, outputs: true, nodes: [child, createNode('output')], edges: [] };
    expect(editorSupportIssues(workflow)).toEqual([expect.objectContaining({ nodeId: child.id, instancePath: '/subworkflows/child/nodes/0/config', code: 'EDITOR_MODE_UNSUPPORTED' })]);
  });
  it('describes nullable answers without treating required result-schema fields as unconditional outputs', () => {
    const { workflow, node } = agenticFixture(); const options = nodeValueOptions(node, workflow);
    expect(options.map(option => option.pointer)).toEqual(['/data', '/data/status', '/data/result', '/data/citations', '/data/stopReason', '/data/usage', '/data/result/answer']);
    expect(options.find(option => option.pointer === '/data/result')!.description).toContain('null');
    expect(options.find(option => option.pointer === '/data/result/answer')!.description).toContain('없습니다');
  });
  it('rechecks the current strategy before a delayed material attachment can change the workflow', () => {
    const { workflow, node } = fixture(); const reference = { id: 'document', revision: 1, kind: 'document' as const, sha256: 'a'.repeat(64) };
    expect(withResourceAttachment(workflow, node.id, reference).nodes.find(item => item.id === node.id)!.attachments).toEqual([{ resource: 'document', role: 'reference' }]);
    const changed = { ...workflow, ...changeAgentStrategy(workflow, node.id, 'agentic_rag') }; const before = structuredClone(changed);
    expect(() => withResourceAttachment(changed, node.id, reference)).toThrow(/직접 자료/); expect(changed).toEqual(before);
  });
});
