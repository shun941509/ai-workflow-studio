import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, NODE_DEFINITIONS, parseStrictJson, parseWorkflowJson, validateJsonValue, validateNodeShape, validateWorkflowShape } from '@studio/spec';

/** Contract tests exercise public validators rather than comparing implementation-private schema objects. */
describe('canonical Studio contracts', () => {
  it('accepts the real basic workflow and a strict JSON round-trip', () => {
    const workflow = createBasicWorkflow('한글 회의 요약');
    expect(validateWorkflowShape(workflow).valid).toBe(true);
    expect(parseWorkflowJson(JSON.stringify(workflow)).valid).toBe(true);
  });

  it('rejects local flow names that cannot be referenced or located unambiguously', () => {
    const workflow = createBasicWorkflow();
    const child = { entryNodeId: workflow.entryNodeId, inputs: workflow.inputs, outputs: workflow.outputs, nodes: workflow.nodes, edges: workflow.edges };
    for (const name of ['', 'a/b', 'a~b', '_hidden', 'a'.repeat(65)]) {
      expect(validateWorkflowShape({ ...workflow, subworkflows: { [name]: child } }).valid, name).toBe(false);
    }
    expect(validateWorkflowShape({ ...workflow, subworkflows: { chapter_2: child } }).valid).toBe(true);
  });

  it('defines exactly 31 distinct closed node configs without claiming handler availability', () => {
    expect(new Set(NODE_DEFINITIONS.map(node => node.type)).size).toBe(31);
    expect(NODE_DEFINITIONS.filter(node => node.availableInP2).map(node => node.type).sort()).toEqual(['ai', 'input', 'output']);
    for (const definition of NODE_DEFINITIONS) {
      const node = createNode(definition.type);
      expect(validateNodeShape(node).valid, definition.type).toBe(true);
      expect(validateNodeShape({ ...node, config: { ...node.config, unsupportedField: true } }).valid, definition.type).toBe(false);
    }
  });

  it('rejects an unknown type and a future type version', () => {
    expect(validateNodeShape({ ...createNode('input'), type: 'imaginary' }).valid).toBe(false);
    expect(validateNodeShape({ ...createNode('input'), typeVersion: 2 }).valid).toBe(false);
  });

  it('requires Hybrid fusion and execution-Skill worker configuration', () => {
    const retrieval = createNode('retrieval');
    expect(validateNodeShape({ ...retrieval, config: { mode: 'hybrid', topK: 5, maxContextTokens: 1000 } }).valid).toBe(false);
    const skill = createNode('skill');
    expect(validateNodeShape({ ...skill, config: { resource: 'document-skill', mode: 'execute' } }).valid).toBe(false);
  });

  it('does not combine literal fields with reference fields or ambiguous defaults', () => {
    const node = createNode('output');
    expect(validateNodeShape({ ...node, inputBindings: { result: { from: 'literal', value: 'text', pointer: '' } } }).valid).toBe(false);
    expect(validateNodeShape({ ...node, inputBindings: { result: { from: 'workflowInput', pointer: '', onMissing: 'default' } } }).valid).toBe(false);
    expect(validateNodeShape({ ...node, inputBindings: { result: { from: 'workflowInput', pointer: '', onMissing: 'error', defaultValue: null } } }).valid).toBe(false);
  });

  it('never coerces values or inserts schema defaults', () => {
    const value: Record<string, unknown> = { count: '4' };
    const schema = { type: 'object', properties: { count: { type: 'integer' }, name: { type: 'string', default: 'name' } }, additionalProperties: false };
    expect(validateJsonValue(schema, value).valid).toBe(false);
    expect(value).toEqual({ count: '4' });
    const empty = {};
    expect(validateJsonValue({ type: 'object', properties: { name: { type: 'string', default: 'name' } } }, empty).valid).toBe(true);
    expect(empty).toEqual({});
  });

  it('supports bounded local references while rejecting external and recursive references', () => {
    const local = { $defs: { answer: { type: 'string' } }, $ref: '#/$defs/answer' };
    expect(validateJsonValue(local, 'real answer').valid).toBe(true);
    expect(validateJsonValue({ $ref: 'https://example.invalid/never-fetch.json' }, {}).valid).toBe(false);
    expect(validateJsonValue({ $defs: { recurse: { $ref: '#/$defs/recurse' } }, $ref: '#/$defs/recurse' }, {}).valid).toBe(false);
    expect(validateJsonValue({ type: 'string', pattern: '(a+)+$' }, 'aaa!').valid).toBe(false);
  });

  it('rejects an unsupported embedded schema before a workflow can be exported', () => {
    const workflow = createBasicWorkflow();
    workflow.outputs = { $ref: 'https://example.invalid/result.json' };
    expect(validateWorkflowShape(workflow).valid).toBe(false);
  });
});

describe('strict JSON boundary', () => {
  it('rejects duplicate decoded keys, comments, trailing commas and trailing values', () => {
    for (const invalid of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1,}', '[1,]', '{} true', '{/*comment*/"a":1}']) {
      expect(() => parseStrictJson(invalid), invalid).toThrow();
    }
  });

  it('preserves escaped strings and valid Unicode, including a surrogate pair', () => {
    expect(parseStrictJson('{"text":"한글 😀 \\"문자\\""}'.replaceAll('\\\\"', '\\"'))).toBeDefined();
    expect(parseStrictJson('[null,false,1.25e2,"\\uD83D\\uDE00"]')).toEqual([null, false, 125, '😀']);
    expect(() => parseStrictJson('"\\uD800"')).toThrow(/surrogate/);
  });

  it('rejects prototype keys and does not execute an accessor received through an object API', () => {
    expect(() => parseStrictJson('{"__proto__":{"admin":true}}')).toThrow();
    let invoked = false;
    const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return '1.0.0'; } });
    expect(validateWorkflowShape(hostile).valid).toBe(false);
    expect(invoked).toBe(false);
  });

  it('bounds nesting and rejects non-finite numbers', () => {
    expect(() => parseStrictJson('['.repeat(70) + '0' + ']'.repeat(70))).toThrow(/complexity/);
    expect(() => parseStrictJson('1e10000')).toThrow(/finite/);
    expect(validateJsonValue({ type: 'string' }, '\uD800').valid).toBe(false);
    expect(validateJsonValue({ type: 'array' }, new Array(2)).valid).toBe(false);
  });
});
