import { describe, expect, it } from 'vitest';
import { createNode, validateWorkflowShape, type Workflow } from '@studio/spec';
import { analyzeWorkflow, applyWorkingContextPreset, removeWorkingContextPreset, collectRequirements, mergeValues, resolveBindings, validateWorkingContextSemantics, workingTaskContext } from '@studio/workflow-core';
import { buildPackage, inspectPackage, prepareAuthoringImport } from '@studio/package-kit';
import { createAvatarMeetingProject } from '../../tooling/catalog/materialize-avatar-meeting-followup.js';

async function source() { return (await createAvatarMeetingProject()).workflow; }
async function example() { return applyWorkingContextPreset(await source()); }
const mapping = (workflow: Workflow) => workflow.workDefinition!.harness.workingContext!.bindings[0]!;
const merge = (workflow: Workflow) => workflow.nodes.find(node => node.id === mapping(workflow).contextNodeId)!;
const performer = (workflow: Workflow) => workflow.nodes.find(node => node.id === mapping(workflow).nodeId)!;

/** These tests inspect real graph/data transformations and ZIPs; no provider response is needed or invented. */
describe('explicit working context preset', () => {
  it('preserves its source, opaque instructions, task input and policy while inserting one real merge', async () => {
    const original = await source(), before = structuredClone(original), workflow = applyWorkingContextPreset(original);
    expect(original).toEqual(before); expect(workflow.nodes).toHaveLength(original.nodes.length + 1);
    expect(workflow.policy).toEqual(original.policy); expect(performer(workflow).config).toEqual(original.nodes.find(node => node.id === 'draft')!.config);
    expect(performer(workflow).inputBindings.task).toEqual(original.nodes.find(node => node.id === 'draft')!.inputBindings.task);
    expect(analyzeWorkflow(workflow)).toEqual([]); expect(validateWorkflowShape(workflow).valid).toBe(true);
    expect(collectRequirements(workflow).capabilities).toContain('workflow.working_context@1');
    expect(collectRequirements(original).capabilities).not.toContain('workflow.working_context@1');
  });
  it.each([null, '본문', ['A', 0, false], { businessTask: '사용자 문자열', sourceText: '원문' }])('namespaces the original %j context without flattening or promotion', async value => {
    const original = await source(); original.nodes.find(node => node.id === 'draft')!.inputBindings.context = { from: 'literal', value };
    const workflow = applyWorkingContextPreset(original), context = merge(workflow);
    if (context.type !== 'merge') throw new Error('Expected context merge');
    const inputs = resolveBindings(context, { workflowInput: {}, nodeOutputs: {} });
    const data = mergeValues(inputs, context.config);
    expect(data).toEqual({ request: value, businessTask: workingTaskContext(workflow) });
    expect(JSON.stringify(workingTaskContext(workflow))).not.toContain('sourceText');
  });
  it('refreshes explicit metadata and selection without nesting the previous context or adding nodes', async () => {
    const workflow = await example(), count = workflow.nodes.length;
    workflow.workDefinition!.task.goal = '수정한 명시적 업무 목표';
    expect(validateWorkingContextSemantics(workflow).map(issue => issue.code)).toContain('WORK_CONTEXT_CONTENT_INVALID');
    const refreshed = applyWorkingContextPreset(workflow, 65536);
    expect(refreshed.nodes).toHaveLength(count); expect(validateWorkingContextSemantics(refreshed)).toEqual([]);
    expect(merge(refreshed).inputBindings.request).toEqual(merge(workflow).inputBindings.request);
    expect(refreshed.workDefinition!.harness.workingContext!.maxBytes).toBe(65536);
  });
  it('removes only its private wrapper and preserves original request binding and authored instruction bytes', async () => {
    const original = await source(), wrapped = applyWorkingContextPreset(original), restored = removeWorkingContextPreset(wrapped);
    expect(restored.nodes).toEqual(original.nodes); expect(analyzeWorkflow(restored)).toEqual([]);
    expect(restored.workDefinition!.harness.workingContext).toBeUndefined(); expect(mapping(wrapped)).toBeDefined();
    const reused = await example(); reused.nodes.find(node => node.type === 'output')!.inputBindings.reused = { from: 'node', nodeId: mapping(reused).contextNodeId, pointer: '/data', onMissing: 'error' };
    expect(() => removeWorkingContextPreset(reused)).toThrow('다른 블록');
    const extended = await example(); merge(extended).inputBindings.extra = { from: 'literal', value: '사용자가 추가한 문맥' };
    expect(() => removeWorkingContextPreset(extended)).toThrow('추가한 입력');
  });
  it.each([0, 1023, 1048577, 1000.5])('rejects invalid byte bound %s before changing a graph', async bound => {
    const workflow = await source(), snapshot = structuredClone(workflow);
    expect(() => applyWorkingContextPreset(workflow, bound)).toThrow(); expect(workflow).toEqual(snapshot);
  });
  it('blocks missing, extra, duplicate and promoted attachments against the explicit selected asset set', async () => {
    for (const mode of ['missing', 'extra', 'duplicate', 'promoted']) {
      const workflow = await example(), node = performer(workflow);
      if (mode === 'missing') node.attachments.pop();
      if (mode === 'extra') node.attachments.push({ resource: 'other', role: 'reference' });
      if (mode === 'duplicate') node.attachments.push(structuredClone(node.attachments[0]!));
      if (mode === 'promoted') node.attachments.find(attachment => attachment.resource === 'template')!.role = 'instructions';
      expect(validateWorkingContextSemantics(workflow).map(issue => issue.code)).toContain('WORK_CONTEXT_ATTACHMENTS_MISMATCH');
    }
  });
  it('does not accept child IDs, duplicate mappings, unselected perform nodes or unrelated context output', async () => {
    for (const mode of ['child', 'duplicate', 'missing', 'wrong-output']) {
      const workflow = await example();
      if (mode === 'child') mapping(workflow).nodeId = 'child/draft';
      if (mode === 'duplicate') workflow.workDefinition!.harness.workingContext!.bindings.push(structuredClone(mapping(workflow)));
      if (mode === 'missing') workflow.workDefinition!.harness.perform.push('absent');
      if (mode === 'wrong-output') performer(workflow).inputBindings.context = { from: 'node', nodeId: 'source', pointer: '/data', onMissing: 'error' };
      expect(validateWorkingContextSemantics(workflow).length).toBeGreaterThan(0);
    }
  });
  it('rejects altered control paths and does not silently repair them on reapplication', async () => {
    const workflow = await example(); workflow.edges.find(edge => edge.to.nodeId === 'draft')!.from.nodeId = 'source';
    expect(validateWorkingContextSemantics(workflow).map(issue => issue.code)).toContain('WORK_CONTEXT_CONTROL_INVALID');
    expect(() => applyWorkingContextPreset(workflow)).toThrow();
  });
  it('rejects unsupported Agentic context and optional omissions without mutating the workflow', async () => {
    const original = await source(), node = original.nodes.find(value => value.id === 'draft')!;
    node.inputBindings.context = { from: 'workflowInput', pointer: '/missing', onMissing: 'omit' };
    expect(() => applyWorkingContextPreset(original)).toThrow('기본값');
    const workflow = await example(); const agent = createNode('agent'); if (agent.type !== 'agent') throw new Error('Expected agent'); agent.id = 'draft'; agent.config.strategy = 'agentic_rag';
    workflow.nodes[workflow.nodes.findIndex(value => value.id === 'draft')] = agent;
    expect(validateWorkingContextSemantics(workflow).map(issue => issue.code)).toContain('WORK_CONTEXT_NODE_UNSUPPORTED');
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves the compiled context and selected source pins in %s operational ZIPs', async host => {
    const original = await createAvatarMeetingProject(), workflow = applyWorkingContextPreset(original.workflow);
    const archive = await buildPackage({ host, workflow, resources: original.resourceFiles });
    const imported = await inspectPackage(archive.bytes); expect(imported.manifest.requiredCapabilities).toContain('workflow.working_context@1');
    const authored = await prepareAuthoringImport(archive.bytes);
    expect(authored.workflow).toEqual(workflow);
    expect(authored.workflow!.resources).toEqual(original.workflow.resources);
  });
});
