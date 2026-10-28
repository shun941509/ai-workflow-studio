import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, parseStrictJson, parseWorkflowJson, validateJsonValue } from '@studio/spec';

const strict = (value: unknown): unknown => parseStrictJson(JSON.stringify(value));
const ordinary = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Equality must survive the actual ZIP parser/child-input boundary, rather than depend on which parser ran first. */
describe('JSON-semantic user schema equality', () => {
  it.each(['const', 'enum'] as const)('%s accepts equal nested objects/arrays for all parser representations', keyword => {
    const constant = { answers: [{ done: true, score: 0 }, ['한글 😀', null, false]], notes: {} };
    const reordered = { notes: {}, answers: [{ score: -0, done: true }, ['한글 😀', null, false]] };
    const schema = { [keyword]: keyword === 'const' ? constant : [constant, 'other'] };
    for (const schemaParser of [strict, ordinary]) for (const valueParser of [strict, ordinary]) {
      const value = valueParser(reordered); const result = validateJsonValue(schemaParser(schema), value);
      expect(result.valid, JSON.stringify(result.issues)).toBe(true); if (result.valid) expect(result.value).toBe(value);
    }
  });
  it.each(['const', 'enum'] as const)('%s preserves object fields, scalar types and array order', keyword => {
    const constant = { answers: [1, '1', null] }; const schema = strict({ [keyword]: keyword === 'const' ? constant : [constant] });
    for (const value of [{ answers: ['1', 1, null] }, { answers: [1, 1, null] }, { answers: [1, '1'] }, { answers: [1, '1', null], extra: true }, {}, [], null]) {
      const result = validateJsonValue(schema, value); expect(result.valid).toBe(false); expect(result.issues[0]!.code).toBe('SCHEMA_INVALID');
    }
  });
  it('handles JSON keys named valueOf/toString/toJSON as data without invoking or rejecting them', () => {
    const value = { valueOf: { nested: 'value' }, toString: ['text'], toJSON: 'literal data' };
    expect(validateJsonValue(strict({ const: value }), value).valid).toBe(true);
    expect(validateJsonValue(strict({ enum: [value, { valueOf: 2, toString: 'different' }] }), strict(value)).valid).toBe(true);
    expect(validateJsonValue({ const: { valueOf: 1 } }, { valueOf: 2 }).valid).toBe(false);
  });
  it('retains object/array const in a parsed workflow and validates the normal child input directly', () => {
    const workflow = createBasicWorkflow('Object constants'); const expected = { stages: [{ label: '검증', enabled: true }], options: [] };
    const child = { entryNodeId: workflow.entryNodeId, inputs: { const: expected }, outputs: { enum: [expected] }, nodes: workflow.nodes, edges: workflow.edges };
    workflow.subworkflows = { child }; const parsed = parseWorkflowJson(JSON.stringify(workflow)); expect(parsed.valid, JSON.stringify(parsed.issues)).toBe(true);
    if (!parsed.valid) return;
    expect(Object.getPrototypeOf(parsed.value.subworkflows.child!.inputs)).toBeNull();
    expect(validateJsonValue(parsed.value.subworkflows.child!.inputs, expected).valid).toBe(true);
    expect(validateJsonValue(parsed.value.subworkflows.child!.outputs, strict(expected)).valid).toBe(true);
  });
  it('uses JSON equality for uniqueItems, including mixed prototypes, nested arrays and -0', () => {
    const schema = { type: 'array', uniqueItems: true };
    expect(validateJsonValue(schema, [strict({ a: [1], b: 2 }), { b: 2, a: [1] }]).valid).toBe(false);
    expect(validateJsonValue(schema, [strict({ a: [1, 2] }), { a: [2, 1] }]).valid).toBe(true);
    expect(validateJsonValue(schema, [0, -0]).valid).toBe(false);
    expect(validateJsonValue(schema, [1, '1', true, null, {}, []]).valid).toBe(true);
    expect(validateJsonValue(schema, [{ valueOf: 1 }, strict({ valueOf: 2 })]).valid).toBe(true);
    expect(validateJsonValue({ type: 'array', uniqueItems: false }, [strict({ x: 1 }), { x: 1 }]).valid).toBe(true);
  });
  it('preserves duplicate enum meaning while retaining the existing rejection of an empty enum', () => {
    expect(validateJsonValue(strict({ enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }), { b: 2, a: 1 }).valid).toBe(true);
    expect(validateJsonValue({ enum: [strict({ valueOf: 1 }), { valueOf: 1 }] }, { valueOf: 1 }).valid).toBe(true);
    expect(validateJsonValue({ enum: [0, -0] }, 0).valid).toBe(true);
    const empty = validateJsonValue({ enum: [] }, {}); expect(empty.valid).toBe(false); expect(empty.issues[0]!.code).toBe('UNSUPPORTED_SCHEMA_OR_VALUE');
    expect(validateJsonValue(strict({ enum: [{ a: 1 }, { a: 2 }] }), { a: 2 }).valid).toBe(true);
  });
  it('does not count inherited properties as JSON object properties', () => {
    const schema = { type: 'object', required: ['toString'], properties: { toString: true } };
    expect(validateJsonValue(schema, {}).valid).toBe(false);
    expect(validateJsonValue(schema, Object.create(null)).valid).toBe(false);
    expect(validateJsonValue(schema, { toString: 'own data' }).valid).toBe(true);
  });
  it('does not mutate schema/data or keep compiled const references owned by the caller', () => {
    const schema = { const: { value: ['original'] } }; const value = strict({ value: ['original'] }); const before = JSON.stringify(value);
    expect(validateJsonValue(schema, value).valid).toBe(true); schema.const.value[0] = 'changed';
    expect(validateJsonValue({ const: { value: ['original'] } }, value).valid).toBe(true);
    expect(validateJsonValue(schema, value).valid).toBe(false);
    expect(JSON.stringify(value)).toBe(before); expect(Object.getPrototypeOf(value)).toBeNull();
  });
  it('rejects accessors/functions/prototype keys before compilation or comparison can invoke them', () => {
    let calls = 0; const getter = Object.defineProperty({}, 'const', { enumerable: true, get() { calls++; return {}; } });
    expect(validateJsonValue(getter, {}).valid).toBe(false);
    expect(validateJsonValue({ const: {} }, Object.defineProperty({}, 'valueOf', { enumerable: true, get() { calls++; return 1; } })).valid).toBe(false);
    expect(validateJsonValue({ const: { toJSON() { calls++; return 1; } } }, {}).valid).toBe(false);
    expect(validateJsonValue({ const: JSON.parse('{"constructor":1}') }, {}).valid).toBe(false); expect(calls).toBe(0);
  });
  it('does not execute inherited array serialization hooks accepted as JSON array data', () => {
    let calls = 0; const prototype = Object.create(Array.prototype) as object; Object.defineProperty(prototype, 'toJSON', { value() { calls++; return ['wrong']; } });
    const constant = Object.setPrototypeOf([{ value: 1 }], prototype) as unknown[];
    expect(validateJsonValue({ const: constant }, [{ value: 1 }]).valid).toBe(true); expect(calls).toBe(0);
  });
  it('keeps existing bounded schema and JSON safety rejection rules', () => {
    const deep = '['.repeat(65) + '0' + ']'.repeat(65);
    expect(validateJsonValue({ const: JSON.parse(deep) }, []).valid).toBe(false);
    expect(validateJsonValue({ const: { bad: Infinity } }, {}).valid).toBe(false);
    expect(validateJsonValue({ $ref: 'https://example.invalid/schema' }, {}).valid).toBe(false);
    expect(validateJsonValue({ type: 'string', pattern: '(a+)+$' }, 'x').valid).toBe(false);
  });
});
