import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, getNodeDefinition, type ResourceRef } from '@studio/spec';
import { editorDefinitions, editorSupportIssues, outputPorts, bindingFields } from '../../apps/studio-web/src/features/editor/editor-contract';
import { withResourceAttachment, withoutResourceAttachment, releaseUnusedResourcePins } from '../../apps/studio-web/src/features/editor/resource-links';
import { nextNodePosition } from '../../apps/studio-web/src/features/editor/local-drafts';

/** These tests cover authoring/permission seams; model execution and private database ownership are tested separately. */
describe('editor contract', () => {
  it('exposes precisely the 21 tested block families with canonical input contracts', () => {
    expect(editorDefinitions.map((item) => item.type)).toEqual(['input', 'form', 'ai', 'agent', 'classify', 'output', 'resource', 'transform', 'condition', 'merge', 'guardrail', 'evaluate', 'error', 'review', 'file_input', 'file_output', 'document_extract', 'memory', 'knowledge', 'retrieval', 'subworkflow']);
    for (const item of editorDefinitions) expect(item).toMatchObject({ type: item.type, inputSchema: getNodeDefinition(item.type)!.inputSchema });
    expect(bindingFields(createNode('condition'))).toEqual([{ key: 'value', required: true }]);
    const error = createNode('error'); if (error.type !== 'error') throw new Error('wrong node'); error.config.mode = 'recover';
    expect(bindingFields(error)).toContainEqual({ key: 'fallback', required: true });
  });
  it('blocks unsupported document conversion settings at the shared export boundary', () => {
    const workflow = createBasicWorkflow(); const document = createNode('document_extract'); if (document.type !== 'document_extract') throw new Error('Wrong factory');
    workflow.nodes.push(document); expect(editorSupportIssues(workflow)).toEqual([]);
    document.config.mode = 'ocr'; expect(editorSupportIssues(workflow)).toEqual([expect.objectContaining({ nodeId: document.id, code: 'EDITOR_MODE_UNSUPPORTED' })]);
  });
  it('keeps index inputs mode-specific and blocks unsupported retrieval configuration', () => {
    const workflow = createBasicWorkflow(); const knowledge = createNode('knowledge'), retrieval = createNode('retrieval'); if (knowledge.type !== 'knowledge' || retrieval.type !== 'retrieval') throw new Error('Wrong factories');
    workflow.nodes.push(knowledge, retrieval); expect(bindingFields(knowledge)).toEqual([{ key: 'index', required: true }]);
    // Opening a current-run index carries no new embedding profile or external transfer.
    knowledge.config = { operation: 'open' }; expect(editorSupportIssues(workflow)).toEqual([]);
    knowledge.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 2000, chunkOverlap: 200 } };
    expect(bindingFields(knowledge)).toEqual([{ key: 'documents', required: true }]); expect(bindingFields(retrieval)).toEqual([{ key: 'query', required: true }, { key: 'index', required: true }]);
    expect(editorSupportIssues(workflow)).toEqual([]); retrieval.config.mode = 'graph_local';
    expect(editorSupportIssues(workflow)).toEqual([expect.objectContaining({ nodeId: retrieval.id, code: 'EDITOR_MODE_UNSUPPORTED' })]);
  });
  it('requires actual file/value inputs and blocks unsupported modes at the export boundary', () => {
    const workflow = createBasicWorkflow(); const file = createNode('file_output'); const memory = createNode('memory'); const agent = createNode('agent');
    if (file.type !== 'file_output' || memory.type !== 'memory' || agent.type !== 'agent') throw new Error('Wrong factories');
    memory.config.operation = 'put'; workflow.nodes.push(file, memory, agent);
    expect(editorSupportIssues(workflow).map(issue => issue.nodeId)).toEqual(expect.arrayContaining([file.id, memory.id, agent.id]));
    file.inputBindings.content = { from: 'literal', value: 'actual text' }; memory.inputBindings.value = { from: 'literal', value: null }; agent.config.maxSteps = 1;
    expect(editorSupportIssues(workflow)).toEqual([]);
    file.config.filename = '../outside.txt'; memory.config.scope = 'project';
    expect(editorSupportIssues(workflow).map(issue => issue.nodeId)).toEqual(expect.arrayContaining([file.id, memory.id]));
    expect(bindingFields(file)).toEqual([{ key: 'content', required: true }]);
    expect(bindingFields(memory)).toContainEqual({ key: 'value', required: true });
  });
  it('does not replace decision routes with a generic next port', () => {
    const classify = createNode('classify'); if (classify.type !== 'classify') throw new Error('wrong node');
    classify.config.labels = [{ id: 'billing', description: '청구' }, { id: 'support', description: '지원' }]; classify.execution.onError = 'route';
    expect(outputPorts(classify)).toEqual(['billing', 'support', 'unclassified', 'error']);
    expect(outputPorts(createNode('review'))).toEqual(['accepted', 'rejected']);
    expect(outputPorts(createNode('condition'))).toEqual(['true', 'false']);
    expect(outputPorts(createNode('output'))).toEqual([]);
  });
  it('blocks unsupported nested flows and modes even if their schema is recognized', () => {
    const workflow = createBasicWorkflow(); const evaluation = createNode('evaluate');
    if (evaluation.type !== 'evaluate') throw new Error('wrong node');
    evaluation.config.mode = 'model'; evaluation.config.modelProfile = 'text-default'; evaluation.config.instructions = '평가';
    workflow.nodes.push(evaluation, createNode('parallel'));
    expect(editorSupportIssues(workflow).map((issue) => issue.nodeId)).toEqual([evaluation.id, workflow.nodes.at(-1)!.id]);
    workflow.subworkflows.child = { entryNodeId: 'start', inputs: true, outputs: true, nodes: createBasicWorkflow().nodes, edges: workflow.edges };
    expect(editorSupportIssues(workflow).some((issue) => issue.instancePath === '/subworkflows')).toBe(false);
  });
  it('reads a pinned resource through config and retains a shared AI attachment', () => {
    const workflow = createBasicWorkflow(); const read = createNode('resource'); workflow.nodes.push(read);
    const first: ResourceRef = { id: 'guide', revision: 1, kind: 'document', sha256: 'a'.repeat(64) };
    const second: ResourceRef = { id: 'policy', revision: 2, kind: 'instruction', sha256: 'b'.repeat(64) };
    const shared = withResourceAttachment(withResourceAttachment(workflow, 'work', first), read.id, first);
    const changed = withResourceAttachment(shared, read.id, second);
    expect(changed.resources.guide).toEqual(first);
    const node = changed.nodes.find((item) => item.id === read.id)!;
    expect(node.config).toEqual({ resource: 'policy' }); expect(node.attachments).toEqual([]);
    const detached = withoutResourceAttachment(changed, read.id, 'policy');
    expect(detached.resources.policy).toBeUndefined(); expect(detached.resources.guide).toEqual(first);
    expect(workflow.resources).toEqual({});
  });
  it('rejects silent version upgrades and non-text resource kinds', () => {
    const workflow = createBasicWorkflow(); const read = createNode('resource'); workflow.nodes.push(read);
    const ref: ResourceRef = { id: 'guide', revision: 1, kind: 'document', sha256: 'a'.repeat(64) };
    const pinned = withResourceAttachment(workflow, read.id, ref);
    expect(() => withResourceAttachment(pinned, read.id, { ...ref, revision: 2 })).toThrow(/다른 버전/);
    expect(() => withResourceAttachment(workflow, read.id, { ...ref, kind: 'skill' })).toThrow();
  });
  it('rejects invalid DSL options and protection parameters without executing a made-up input', () => {
    const workflow = createBasicWorkflow(); const transform = createNode('transform'); const guard = createNode('guardrail'); const condition = createNode('condition');
    if (transform.type !== 'transform' || guard.type !== 'guardrail' || condition.type !== 'condition') throw new Error('wrong nodes');
    transform.config.steps = [{ op: 'map', options: { steps: 'run arbitrary code' } }];
    guard.config.rules = [{ id: 'check', kind: 'length', parameters: { min: 10, max: 2 } }];
    condition.config.expression = { op: 'eq', args: [{ literal: true }] };
    workflow.nodes.push(transform, guard, condition);
    expect(editorSupportIssues(workflow).map((issue) => issue.nodeId)).toEqual([transform.id, guard.id, condition.id]);
  });
  it('drops the last private resource when its read block is deleted and preserves unrelated explicit pins', () => {
    const workflow = createBasicWorkflow(); const node = createNode('resource'); workflow.nodes.push(node);
    const pinned = withResourceAttachment(workflow, node.id, { id: 'private_doc', revision: 1, kind: 'document', sha256: 'a'.repeat(64) });
    pinned.resources.explicit = { id: 'explicit', revision: 1, kind: 'document', sha256: 'b'.repeat(64) };
    const after = releaseUnusedResourcePins(pinned, { ...pinned, nodes: pinned.nodes.filter((item) => item.id !== node.id) as typeof pinned.nodes });
    expect(after.resources.private_doc).toBeUndefined(); expect(after.resources.explicit).toEqual(pinned.resources.explicit);
    expect(pinned.resources.private_doc).toBeDefined();
  });
  it('places click-added cards in free cells rather than stacking them on the starter graph', () => {
    const occupied = { start: { x: 70, y: 170 }, work: { x: 370, y: 170 }, output: { x: 670, y: 170 } };
    const next = nextNodePosition(occupied);
    expect(next.y).toBeGreaterThan(170);
    expect(Object.values(occupied).every((point) => Math.abs(point.x - next.x) >= 280 || Math.abs(point.y - next.y) >= 250)).toBe(true);
  });
});
