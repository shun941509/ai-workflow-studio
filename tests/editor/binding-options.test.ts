import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type NodeType, type WorkflowNode } from '@studio/spec';
import { readJsonPointer } from '@studio/workflow-core';
import { bindingValueOptions, nodeValueOptions, schemaValueOptions } from '../../apps/studio-web/src/features/editor/binding-options';
import { executeInput } from '../../apps/runner/src/handlers/input';
import { executePure } from '../../apps/runner/src/handlers/pure';
import { executeTaskAgent } from '../../apps/runner/src/handlers/bounded-agents';

const workflow = () => createBasicWorkflow();
function node<T extends NodeType>(type: T): Extract<WorkflowNode, { type: T }> { return createNode(type) as Extract<WorkflowNode, { type: T }>; }

/** Suggestions are executable data locations, not synthetic examples or a promise that an unimplemented mode can run. */
describe('binding value choices', () => {
  it('resolves each escaped direct schema field through the real JSON Pointer reader', () => {
    const names = ['a/b', 'a~b', '한글', '', '~1/0'];
    const schema = { type: 'object', properties: Object.fromEntries(names.map(name => [name, { type: 'string' }])), required: names };
    const data = Object.fromEntries(names.map((name, index) => [name, index]));
    const choices = schemaValueOptions(schema, '/data');
    expect(choices.map(item => item.pointer)).toEqual(['/data/a~1b', '/data/a~0b', '/data/한글', '/data/', '/data/~01~10']);
    for (const [index, choice] of choices.entries()) expect(readJsonPointer({ data }, choice.pointer)).toBe(index);
  });
  it('does not invent fields from unions, refs, arrays, booleans or forbidden/impossible properties', () => {
    for (const schema of [true, false, { $ref: '#/$defs/result' }, { oneOf: [{ type: 'object', properties: { text: {} } }] }, { type: 'array', items: { type: 'object' } }]) expect(schemaValueOptions(schema, '/data')).toEqual([]);
    const properties = JSON.parse('{"constructor":{},"prototype":{},"__proto__":{},"never":false,"allowed":true}');
    expect(schemaValueOptions({ type: 'object', properties }, '/data').map(item => item.pointer)).toEqual(['/data/allowed']);
    expect(schemaValueOptions({ type: 'object', properties: Object.create({ inherited: {} }) }, '/data')).toEqual([]);
  });
  it('labels optional fields honestly and bounds suggestions without changing their data paths', () => {
    const properties = Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`key${index}`, { type: 'string' }]));
    const choices = schemaValueOptions({ type: 'object', properties, required: ['key0'] }, '/data');
    expect(choices).toHaveLength(100); expect(choices[0]!.label).toBe('항목: key0'); expect(choices[1]!.label).toContain('선택 항목');
    expect(choices[99]!.pointer).toBe('/data/key99'); expect(Object.keys(properties)).toHaveLength(110);
  });
  it('offers workflow input fields at different roots for entry output and direct execution input', () => {
    const flow = workflow(); const entry = flow.nodes.find(item => item.type === 'input')!;
    const choices = nodeValueOptions(entry, flow); const text = choices.find(item => item.pointer === '/data/text')!;
    expect(readJsonPointer(executeInput({ text: '실제 입력' }), text.pointer)).toBe('실제 입력');
    expect(bindingValueOptions({ from: 'workflowInput', pointer: '', onMissing: 'error' }, flow).map(item => item.pointer)).toEqual(['', '/text']);
  });
  it('uses the actual form mode schema rather than assuming every answer has text', () => {
    const flow = workflow(); const form = node('form');
    form.config = { mode: 'request', title: '질문', schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } };
    expect(nodeValueOptions(form, flow).map(item => item.pointer)).toEqual(['/data', '/data/answer']);
    form.config = { mode: 'initial', title: '질문' };
    expect(nodeValueOptions(form, flow).map(item => item.pointer)).toEqual(['/data', '/data/text']);
  });
  it('distinguishes file lists, single managed files, extracted text and keyword retrieval envelopes', () => {
    const flow = workflow(); const file = node('file_input'), output = node('file_output'), extract = node('document_extract'), knowledge = node('knowledge'), retrieval = node('retrieval');
    retrieval.config.mode = 'keyword';
    expect(nodeValueOptions(file, flow).map(item => item.pointer)).toEqual(['/data', '/data/0']);
    expect(nodeValueOptions(output, flow).map(item => item.pointer)).toEqual(['/data']);
    expect(nodeValueOptions(extract, flow).map(item => item.pointer)).toEqual(['/data', '/data/text', '/data/locations']);
    expect(nodeValueOptions(knowledge, flow)[0]!.label).toBe('검색용 색인 (전체 결과)');
    expect(nodeValueOptions(retrieval, flow).map(item => item.pointer)).toEqual(['/data', '/data/context', '/data/citations', '/data/candidates', '/data/index']);
    retrieval.config.mode = 'graph_local'; extract.config.mode = 'ocr';
    expect(nodeValueOptions(retrieval, flow).map(item => item.pointer)).toEqual(['/data']); expect(nodeValueOptions(extract, flow).map(item => item.pointer)).toEqual(['/data']);
  });
  it('does not treat optional registry text/files as guaranteed paths for arbitrary data', () => {
    const flow = workflow();
    for (const type of ['resource', 'guardrail', 'merge', 'error', 'program'] as const) expect(nodeValueOptions(node(type), flow).map(item => item.pointer)).toEqual(['/data']);
    const ai = node('ai'); ai.config.responseFormat = { mode: 'json', schema: { type: 'object', properties: { summary: { type: 'string' } } } };
    expect(nodeValueOptions(ai, flow).map(item => item.pointer)).toEqual(['/data', '/data/summary']);
    ai.config.responseFormat = { mode: 'text' }; expect(nodeValueOptions(ai, flow).map(item => item.pointer)).toEqual(['/data']);
  });
  it('reads task Agent fields inside result, matching the real handler envelope', async () => {
    const flow = workflow(); const agent = node('agent');
    agent.config.maxSteps = 1; agent.config.resultSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const result = await executeTaskAgent(agent, { task: '검토' }, async () => ({ text: JSON.stringify({ resultJson: JSON.stringify({ answer: '검증된 구조' }) }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), { instructions: [], references: [] });
    const choices = nodeValueOptions(agent, flow);
    expect(readJsonPointer(result, choices.find(item => item.pointer === '/data/result/answer')!.pointer)).toBe('검증된 구조');
    expect(choices.map(item => item.pointer)).not.toContain('/data/answer');
  });
  it('matches condition and rule evaluation handler outputs without implying branch availability', () => {
    const flow = workflow(); const condition = node('condition'); condition.config.expression = { literal: true };
    const result = executePure(condition, { value: '내용' }).output;
    expect(readJsonPointer(result, nodeValueOptions(condition, flow).find(item => item.label === '검사한 원래 값')!.pointer)).toBe('내용');
    const evaluation = node('evaluate'); const output = executePure(evaluation, { value: '내용' }).output;
    for (const choice of nodeValueOptions(evaluation, flow)) expect(typeof readJsonPointer(output, choice.pointer)).not.toBe('symbol');
  });
  it('preserves custom paths, missing-source identity and null semantics without mutating the binding', () => {
    const flow = workflow(); const memory = node('memory'); flow.nodes.push(memory);
    const binding = { from: 'node' as const, nodeId: memory.id, pointer: '/data/value/custom', onMissing: 'default' as const, defaultValue: null };
    const before = structuredClone(binding); const choices = bindingValueOptions(binding, flow);
    expect(choices.find(item => item.pointer === '/data/value')!.description).toContain('null'); expect(binding).toEqual(before);
    expect(bindingValueOptions({ ...binding, nodeId: 'removed-node' }, flow)).toEqual([]);
    expect(bindingValueOptions({ from: 'literal', value: { text: 'private' } }, flow)).toEqual([]);
  });
  it('derives review answer fields under feedback and excludes answers from the outer envelope', () => {
    const flow = workflow(); const review = node('review'); review.config.responseSchema = { type: 'object', properties: { acceptedReason: { type: 'string' } }, required: ['acceptedReason'] };
    expect(nodeValueOptions(review, flow).map(item => item.pointer)).toEqual(['/data', '/data/decision', '/data/feedback', '/data/feedback/acceptedReason']);
    expect(bindingValueOptions({ from: 'error', pointer: '', onMissing: 'error' }, flow).map(item => item.pointer)).toEqual(['', '/code', '/message', '/nodeId']);
  });
});
