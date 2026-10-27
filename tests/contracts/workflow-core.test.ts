import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode } from '@studio/spec';
import { analyzeWorkflow, collectRequirements, ContractError, createResolvedPlan, resolveBindings } from '@studio/workflow-core';

/** Build an explicit branch/merge graph to detect dominance and skipped-path regressions. */
function branchingWorkflow(): Workflow {
  const workflow = createBasicWorkflow('조건별 처리');
  const input = workflow.nodes[0]!;
  const condition = createNode('condition'); condition.id = 'choice'; condition.inputBindings = { value: { from: 'literal', value: true } };
  const left = createNode('ai'); left.id = 'left'; left.inputBindings = { content: { from: 'node', nodeId: 'start', pointer: '/data/text', onMissing: 'error' } };
  const right = createNode('ai'); right.id = 'right'; right.inputBindings = structuredClone(left.inputBindings);
  const merge = createNode('merge'); merge.id = 'join';
  merge.inputBindings = {
    left: { from: 'node', nodeId: 'left', pointer: '/data', onMissing: 'omit' },
    right: { from: 'node', nodeId: 'right', pointer: '/data', onMissing: 'omit' },
  };
  const output = createNode('output'); output.id = 'finish'; output.inputBindings = { result: { from: 'node', nodeId: 'join', pointer: '/data', onMissing: 'error' } };
  workflow.nodes = [input, condition, left, right, merge, output];
  workflow.outputs = true;
  workflow.edges = [
    { id: 'a', from: { nodeId: 'start', port: 'next' }, to: { nodeId: 'choice', port: 'in' } },
    { id: 'b', from: { nodeId: 'choice', port: 'true' }, to: { nodeId: 'left', port: 'in' } },
    { id: 'c', from: { nodeId: 'choice', port: 'false' }, to: { nodeId: 'right', port: 'in' } },
    { id: 'd', from: { nodeId: 'left', port: 'next' }, to: { nodeId: 'join', port: 'in' } },
    { id: 'e', from: { nodeId: 'right', port: 'next' }, to: { nodeId: 'join', port: 'in' } },
    { id: 'f', from: { nodeId: 'join', port: 'next' }, to: { nodeId: 'finish', port: 'in' } },
  ];
  return workflow;
}

describe('workflow semantics', () => {
  it('accepts a complete basic workflow and derives exactly its three capabilities', () => {
    const workflow = createBasicWorkflow();
    expect(analyzeWorkflow(workflow)).toEqual([]);
    expect(collectRequirements(workflow)).toEqual({ capabilities: ['node.ai@1', 'node.input@1', 'node.output@1'], modelProfiles: ['text-default'], resourceAliases: [] });
  });

  it('rejects missing nodes, ports, duplicate IDs and cycles before model calls', () => {
    const absent = createBasicWorkflow(); absent.edges[0]!.to.nodeId = 'absent';
    expect(analyzeWorkflow(absent).some(issue => issue.code === 'INVALID_EDGE')).toBe(true);
    const port = createBasicWorkflow(); port.edges[0]!.from.port = 'imaginary';
    expect(analyzeWorkflow(port).some(issue => issue.code === 'INVALID_PORT')).toBe(true);
    const duplicate = createBasicWorkflow(); duplicate.nodes.push(structuredClone(duplicate.nodes[1]!));
    expect(analyzeWorkflow(duplicate).some(issue => issue.code === 'DUPLICATE_ID')).toBe(true);
    const cyclic = createBasicWorkflow(); cyclic.edges.push({ id: 'cycle', from: { nodeId: 'work', port: 'next' }, to: { nodeId: 'start', port: 'in' } });
    expect(analyzeWorkflow(cyclic).some(issue => issue.code === 'CYCLE_DETECTED')).toBe(true);
  });

  it('requires explicit merge and rejects a future result reference', () => {
    const workflow = branchingWorkflow();
    workflow.edges[3]!.to.nodeId = 'finish'; workflow.edges[4]!.to.nodeId = 'finish';
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'MERGE_REQUIRED')).toBe(true);
    const future = createBasicWorkflow();
    future.nodes[1]!.inputBindings.content = { from: 'node', nodeId: 'finish', pointer: '/data', onMissing: 'error' };
    expect(analyzeWorkflow(future).some(issue => issue.code === 'BINDING_NOT_PREDECESSOR')).toBe(true);
  });

  it('rejects statically impossible result pointers and wrong literal input types', () => {
    const workflow = createBasicWorkflow();
    workflow.nodes[2]!.inputBindings.result = { from: 'node', nodeId: 'work', pointer: '/answer', onMissing: 'error' };
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'BINDING_PATH_NOT_FOUND')).toBe(true);
    const tool = createNode('tool'); tool.id = 'work'; tool.inputBindings.arguments = { from: 'literal', value: 'not an argument object' };
    const other = createBasicWorkflow(); other.nodes[1] = tool;
    expect(analyzeWorkflow(other).some(issue => issue.code === 'INPUT_TYPE_MISMATCH')).toBe(true);
  });

  it('accepts explicit missing policies at a branch merge and rejects required optional-branch results', () => {
    const workflow = branchingWorkflow();
    expect(analyzeWorkflow(workflow)).toEqual([]);
    const join = workflow.nodes.find(node => node.id === 'join')!;
    join.inputBindings.left = { from: 'node', nodeId: 'left', pointer: '/data', onMissing: 'error' };
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'BINDING_NOT_AVAILABLE')).toBe(true);
  });

  it('rejects undeclared resources, profiles and recursive child flows', () => {
    const workflow = createBasicWorkflow();
    workflow.nodes[1]!.attachments = [{ resource: 'private-data', role: 'reference' }];
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'RESOURCE_NOT_FOUND')).toBe(true);
    workflow.nodes[1]!.attachments = []; workflow.modelProfiles = {};
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'MODEL_PROFILE_NOT_FOUND')).toBe(true);
    const child = createBasicWorkflow();
    const call = createNode('subworkflow'); call.id = 'work'; call.config = { flowRef: { kind: 'local', flowId: 'child' } }; call.inputBindings = { input: { from: 'workflowInput', pointer: '', onMissing: 'error' } };
    child.nodes[1] = call;
    const root = createBasicWorkflow(); root.subworkflows.child = { entryNodeId: child.entryNodeId, inputs: child.inputs, outputs: child.outputs, nodes: child.nodes, edges: child.edges };
    expect(analyzeWorkflow(root).some(issue => issue.code === 'FLOW_RECURSION')).toBe(true);
  });
});

describe('binding evaluation', () => {
  it('keeps null distinct from missing and does not mutate predecessor data', () => {
    const node = createNode('output');
    node.inputBindings.result = { from: 'workflowInput', pointer: '/value', onMissing: 'default', defaultValue: 'fallback' };
    expect(resolveBindings(node, { workflowInput: { value: null }, nodeOutputs: {} }).result).toBe(null);
    expect(resolveBindings(node, { workflowInput: {}, nodeOutputs: {} }).result).toBe('fallback');
    const original = { nested: ['a'] };
    node.inputBindings.result = { from: 'node', nodeId: 'source', pointer: '/data', onMissing: 'error' };
    const resolved = resolveBindings(node, { workflowInput: {}, nodeOutputs: { source: { data: original } } });
    (resolved.result as { nested: string[] }).nested.push('b');
    expect(original).toEqual({ nested: ['a'] });
  });

  it('handles escaped pointers and rejects malformed or prototype pointers', () => {
    const node = createNode('output');
    node.inputBindings.result = { from: 'workflowInput', pointer: '/a~1b/~0key', onMissing: 'error' };
    expect(resolveBindings(node, { workflowInput: { 'a/b': { '~key': 7 } }, nodeOutputs: {} }).result).toBe(7);
    node.inputBindings.result = { from: 'workflowInput', pointer: '/~2bad', onMissing: 'error' };
    expect(() => resolveBindings(node, { workflowInput: {}, nodeOutputs: {} })).toThrow(ContractError);
    node.inputBindings.result = { from: 'workflowInput', pointer: '/constructor', onMissing: 'error' };
    expect(() => resolveBindings(node, { workflowInput: {}, nodeOutputs: {} })).toThrow(/Prototype/);
  });

  it('omits inactive branch inputs while rejecting omission of a required output', () => {
    const join = branchingWorkflow().nodes.find(node => node.id === 'join')!;
    expect(resolveBindings(join, { workflowInput: {}, nodeOutputs: { left: { data: 'left result' } } })).toEqual({ left: 'left result' });
    const output = createNode('output'); output.inputBindings.result = { from: 'node', nodeId: 'absent', pointer: '/data', onMissing: 'omit' };
    expect(() => resolveBindings(output, { workflowInput: {}, nodeOutputs: {} })).toThrow(/result/);
  });

  it('does not let an ordinary node read the error context', () => {
    const node = createNode('output'); node.inputBindings.result = { from: 'error', pointer: '', onMissing: 'error' };
    expect(() => resolveBindings(node, { workflowInput: {}, nodeOutputs: {}, error: { code: 'anything' } })).toThrow(/error handler/);
  });

  it('requires an actual index for local retrieval even when its missing binding says omit', () => {
    const node = createNode('retrieval');
    node.inputBindings.query = { from: 'literal', value: '질문' };
    node.inputBindings.index = { from: 'node', nodeId: 'absent', pointer: '/data', onMissing: 'omit' };
    expect(() => resolveBindings(node, { workflowInput: {}, nodeOutputs: {} })).toThrow(/index/);
  });
});

describe('resolved execution plan', () => {
  it('hashes semantic key order consistently and deeply freezes a copy', async () => {
    const workflow = createBasicWorkflow();
    const first = await createResolvedPlan(workflow, { packageHash: 'a'.repeat(64), revision: 1 }, { modelProfiles: { 'text-default': { id: 'local', provider: 'openai', model: 'configured-model' } } });
    const second = await createResolvedPlan(workflow, { revision: 1, packageHash: 'a'.repeat(64) }, { modelProfiles: { 'text-default': { model: 'configured-model', provider: 'openai', id: 'local' } } });
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planHash).toBe(second.planHash);
    expect(Object.isFrozen(first.workflow.nodes[1]!.config)).toBe(true);
    workflow.name = 'changed source';
    expect(first.workflow.name).not.toBe('changed source');
    expect((await createResolvedPlan(workflow, { packageHash: 'a'.repeat(64) }, { modelProfiles: { 'text-default': { id: 'local', provider: 'openai', model: 'configured-model' } } })).planHash).not.toBe(first.planHash);
  });

  it('rejects credentials and undeclared runtime model aliases', async () => {
    const workflow = createBasicWorkflow();
    await expect(createResolvedPlan(workflow, {}, { modelProfiles: { 'text-default': { apiKey: 'not-a-real-key' } } })).rejects.toThrow(/secret/);
    await expect(createResolvedPlan(workflow, {}, { modelProfiles: { unknown: { model: 'configured' } } })).rejects.toThrow(/Unknown model profile/);
    await expect(createResolvedPlan(workflow, {}, {})).rejects.toThrow(/Resolve model profile/);
  });
});
