import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type Workflow } from '@studio/spec';
import {
  applyTransform, classifyByRules, collectRequirements, CoreOperationError, evaluateCondition, evaluateExpression, evaluateRules,
  mergeValues, propagateInactiveEdges, resolveNodeActivation, selectControlEdges, type TransformStep,
} from '@studio/workflow-core';

/** Pure helpers exercise real branching/transform semantics without claiming any Runner handler exists. */
function diamond(): Workflow {
  const flow = createBasicWorkflow();
  const entry = flow.nodes[0]!;
  const choice = createNode('condition'); choice.id = 'choice';
  const left = createNode('ai'); left.id = 'left';
  const right = createNode('ai'); right.id = 'right';
  const join = createNode('merge'); join.id = 'join';
  const finish = flow.nodes[2]!;
  flow.nodes = [entry, choice, left, right, join, finish];
  flow.edges = [
    { id: 'start_choice', from: { nodeId: 'start', port: 'next' }, to: { nodeId: 'choice', port: 'in' } },
    { id: 'choose_left', from: { nodeId: 'choice', port: 'true' }, to: { nodeId: 'left', port: 'in' } },
    { id: 'choose_right', from: { nodeId: 'choice', port: 'false' }, to: { nodeId: 'right', port: 'in' } },
    { id: 'left_join', from: { nodeId: 'left', port: 'next' }, to: { nodeId: 'join', port: 'in' } },
    { id: 'right_join', from: { nodeId: 'right', port: 'next' }, to: { nodeId: 'join', port: 'in' } },
    { id: 'join_finish', from: { nodeId: 'join', port: 'next' }, to: { nodeId: 'finish', port: 'in' } },
  ];
  return flow;
}

describe('bounded expression evaluation', () => {
  it('compares JSON values structurally without scalar coercion', () => {
    expect(evaluateExpression({ op: 'eq', args: [{ literal: { b: 2, a: 1 } }, { literal: { a: 1, b: 2 } }] }, {})).toBe(true);
    expect(evaluateExpression({ op: 'eq', args: [{ literal: 1 }, { literal: '1' }] }, {})).toBe(false);
    expect(evaluateExpression({ op: 'in', args: [{ literal: { a: 1 } }, { literal: [{ a: 1 }, { a: 2 }] }] }, {})).toBe(true);
    expect(() => evaluateExpression({ op: 'gt', args: [{ literal: 3 }, { literal: '2' }] }, {})).toThrow(/same type/);
  });

  it('keeps missing different from null and supports an explicit existence guard', () => {
    expect(evaluateCondition({ op: 'exists', args: [{ var: '/present' }] }, { present: null })).toBe(true);
    expect(evaluateCondition({ op: 'exists', args: [{ var: '/absent' }] }, {})).toBe(false);
    expect(evaluateCondition({ op: 'and', args: [{ op: 'exists', args: [{ var: '/absent' }] }, { op: 'gt', args: [{ var: '/absent' }, { literal: 0 }] }] }, {})).toBe(false);
    expect(() => evaluateExpression({ var: '/absent' }, {})).toThrow(/unavailable/);
  });

  it('requires actual booleans, valid arity and an explicitly supported operator', () => {
    expect(() => evaluateCondition({ literal: 'false' }, {})).toThrow(/boolean/);
    expect(() => evaluateExpression({ op: 'eq', args: [{ literal: 1 }] }, {})).toThrow(/argument count/);
    expect(() => evaluateExpression({ op: 'and', args: [{ literal: false }, { op: 'exec', args: [{ literal: 'code' }] }] }, {})).toThrow(/Unsupported/);
    expect(() => evaluateExpression({ literal: 1, var: '/x' }, {})).toThrow(/Unsupported option/);
  });

  it('rejects prototype pointers even behind short-circuit logic', () => {
    expect(() => evaluateExpression({ op: 'or', args: [{ literal: true }, { var: '/safe/constructor' }] }, {})).toThrow(/Prototype/);
    expect(evaluateExpression({ var: '/a~1b/~0x' }, { 'a/b': { '~x': 4 } })).toBe(4);
  });

  it('bounds expression nesting and copies returned data', () => {
    let expression: unknown = { literal: true };
    for (let index = 0; index < 34; index += 1) expression = { op: 'not', args: [expression] };
    expect(() => evaluateExpression(expression, {})).toThrow(/limit/);
    const context = { data: [1, 2] };
    const result = evaluateExpression({ var: '/data' }, context) as number[];
    result.push(3); expect(context.data).toEqual([1, 2]);
  });
});

describe('closed transform DSL', () => {
  it('parses, maps, selects, renames and formats a real JSON data transformation', () => {
    const steps: TransformStep[] = [
      { op: 'parse_json' },
      { op: 'map', options: { steps: [
        { op: 'pick', options: { keys: ['name', 'count'] } },
        { op: 'rename', options: { mapping: { name: 'title' } } },
        { op: 'format', options: { template: '{{/title}}: {{/count}}' } },
      ] } },
    ];
    expect(applyTransform('[{"name":"가","count":2,"unused":true},{"name":"나","count":3}]', steps, { type: 'array', items: { type: 'string' } })).toEqual(['가: 2', '나: 3']);
  });

  it('uses explicit missing behavior and rejects silent rename overwrites', () => {
    expect(() => applyTransform({ a: 1 }, [{ op: 'pick', options: { keys: ['missing'] } }])).toThrow(/Missing/);
    expect(applyTransform({ a: 1 }, [{ op: 'pick', options: { keys: ['missing'], missing: 'omit' } }])).toEqual({});
    expect(() => applyTransform({ a: 1, b: 2 }, [{ op: 'rename', options: { mapping: { a: 'b' } } }])).toThrow(/overwrite/);
    expect(applyTransform({ a: 1, b: 2 }, [{ op: 'rename', options: { mapping: { a: 'b', b: 'a' } } }])).toEqual({ a: 2, b: 1 });
  });

  it('does not mutate source objects and supports explicit JSON serialization', () => {
    const source = { a: 1, nested: { b: 2 } };
    const result = applyTransform(source, [{ op: 'omit', options: { keys: ['a'] } }]) as { nested: { b: number } };
    result.nested.b = 9; expect(source.nested.b).toBe(2);
    expect(applyTransform({ a: 1 }, [{ op: 'stringify_json', options: { indent: 2 } }])).toBe('{\n  "a": 1\n}');
    expect(() => applyTransform({ a: 1 }, [{ op: 'parse_json' }])).toThrow(/requires a string/);
  });

  it('rejects arbitrary options, executable expressions and ambiguous templates', () => {
    expect(() => applyTransform({ a: 1 }, [{ op: 'pick', options: { keys: ['a'], script: 'return 1' } }])).toThrow(/Unsupported option/);
    expect(() => applyTransform({}, [{ op: 'eval', options: {} } as unknown as TransformStep])).toThrow(/Unsupported transform/);
    expect(() => applyTransform({}, [{ op: 'format', options: { template: '{{process.exit()}}' } }])).toThrow(/JSON Pointer/);
    expect(() => applyTransform({}, [{ op: 'format', options: { template: '{{/unclosed' } }])).toThrow(/unmatched/);
    expect(() => applyTransform({ a: {} }, [{ op: 'format', options: { template: '{{/a}}' } }])).toThrow(/scalars/);
  });

  it('uses strict JSON parsing and enforces the final result contract', () => {
    expect(() => applyTransform('{"a":1,"a":2}', [{ op: 'parse_json' }])).toThrow(/Duplicate/);
    expect(() => applyTransform({ a: 1 }, [{ op: 'pick', options: { keys: ['a'] } }], { type: 'string' })).toThrow(/result schema/);
    expect(() => applyTransform({}, [{ op: 'rename', options: { mapping: { a: 'constructor' } } }])).toThrow(/Prototype/);
  });

  it('bounds map input and nested operation work', () => {
    expect(() => applyTransform(Array.from({ length: 10001 }, () => ({})), [{ op: 'map', options: { steps: [{ op: 'stringify_json' }] } }])).toThrow(/10000/);
    let step: TransformStep = { op: 'stringify_json' };
    for (let index = 0; index < 10; index += 1) step = { op: 'map', options: { steps: [step] } };
    expect(() => applyTransform([], [step])).toThrow(/nested maps/);
  });
});

describe('explicit control tokens', () => {
  it('waits until every merge path is decided and every active predecessor is complete', () => {
    expect(resolveNodeActivation({ nodeId: 'join', entryNodeId: 'start', waitFor: 'all_active', incoming: [{ edgeId: 'a', state: 'active', outcome: 'succeeded' }, { edgeId: 'b', state: 'pending' }] }).state).toBe('waiting');
    expect(resolveNodeActivation({ nodeId: 'join', entryNodeId: 'start', waitFor: 'all_active', incoming: [{ edgeId: 'a', state: 'active', outcome: 'succeeded' }, { edgeId: 'b', state: 'inactive' }] })).toEqual({ state: 'ready', activeEdgeIds: ['a'] });
    expect(resolveNodeActivation({ nodeId: 'join', entryNodeId: 'start', waitFor: 'all_active', incoming: [{ edgeId: 'a', state: 'active' }, { edgeId: 'b', state: 'inactive' }] }).state).toBe('waiting');
  });

  it('does not wait forever on failed or protected predecessors', () => {
    for (const outcome of ['failed', 'blocked', 'cancelled'] as const) expect(resolveNodeActivation({ nodeId: 'join', entryNodeId: 'start', waitFor: 'all_active', incoming: [{ edgeId: 'a', state: 'active', outcome }, { edgeId: 'b', state: 'pending' }] }).state).toBe(outcome);
    expect(() => resolveNodeActivation({ nodeId: 'ordinary', entryNodeId: 'start', incoming: [{ edgeId: 'error', state: 'active', outcome: 'handled_error' }] })).toThrow(/error handler/);
    expect(resolveNodeActivation({ nodeId: 'handler', entryNodeId: 'start', acceptRecoverableError: true, incoming: [{ edgeId: 'error', state: 'active', outcome: 'handled_error' }] }).state).toBe('ready');
  });

  it('only accepts a single predecessor outside explicit merge and skips wholly inactive input', () => {
    expect(() => resolveNodeActivation({ nodeId: 'ordinary', entryNodeId: 'start', incoming: [{ edgeId: 'a', state: 'inactive' }, { edgeId: 'b', state: 'inactive' }] })).toThrow(/merge/);
    expect(resolveNodeActivation({ nodeId: 'join', entryNodeId: 'start', waitFor: 'all_active', incoming: [{ edgeId: 'a', state: 'inactive' }, { edgeId: 'b', state: 'inactive' }] }).state).toBe('skipped');
    expect(resolveNodeActivation({ nodeId: 'start', entryNodeId: 'start', incoming: [] }).state).toBe('ready');
  });

  it('propagates a non-selected branch while preserving its shared join and output', () => {
    const flow = diamond();
    const decision = selectControlEdges('choice', 'true', flow.edges);
    expect(decision).toEqual({ choose_left: 'active', choose_right: 'inactive' });
    const result = propagateInactiveEdges(flow, { start_choice: 'active', ...decision });
    expect(result.skippedNodeIds).toEqual(['right']);
    expect(result.edgeStates.right_join).toBe('inactive');
    expect(result.edgeStates.left_join).toBe('pending');
    expect(result.edgeStates.join_finish).toBe('pending');
  });

  it('propagates all-inactive joins and refuses to overwrite a previously active edge', () => {
    const flow = diamond();
    const inactive = propagateInactiveEdges(flow, { choose_left: 'inactive', choose_right: 'inactive' });
    expect(inactive.skippedNodeIds).toEqual(['finish', 'join', 'left', 'right']);
    expect(() => propagateInactiveEdges(flow, { choose_right: 'inactive', right_join: 'active' })).toThrow(/already active/);
    expect(() => selectControlEdges('choice', 'unknown', flow.edges)).toThrow(/selected control port/);
    expect(() => propagateInactiveEdges(flow, { nonexistent: 'active' })).toThrow(/missing edge/);
  });
});

describe('merge data and deterministic rules', () => {
  it('requires the evaluation mode separately so rules support cannot admit model evaluation', () => {
    const workflow = createBasicWorkflow();
    const evaluation = createNode('evaluate'); evaluation.id = 'work';
    if (evaluation.type !== 'evaluate') throw new Error('Expected evaluate node from registry');
    workflow.nodes[1] = evaluation;
    const rules = collectRequirements(workflow).capabilities;
    expect(rules).toContain('node.evaluate@1');
    expect(rules).toContain('evaluate.rules@1');
    expect(rules).not.toContain('evaluate.model@1');
    evaluation.config.mode = 'model'; evaluation.config.modelProfile = 'text-default'; evaluation.config.instructions = '고정한 기준으로 평가합니다.';
    const model = collectRequirements(workflow).capabilities;
    expect(model).toContain('evaluate.model@1');
    expect(model).not.toContain('evaluate.rules@1');
    expect(model.filter(capability => !rules.includes(capability))).toEqual(['evaluate.model@1']);
  });

  it('orders arrays by alias and rejects object collisions or ambiguous selection', () => {
    expect(mergeValues({ z: 2, a: 1 }, { waitFor: 'all_active', combine: 'array', collision: 'error' })).toEqual([1, 2]);
    expect(() => mergeValues({ a: { value: 1 }, b: { value: 2 } }, { waitFor: 'all_active', combine: 'object', collision: 'error' })).toThrow(/overwrite/);
    expect(mergeValues({ a: { value: 1 }, b: { value: 2 } }, { waitFor: 'all_active', combine: 'object', collision: 'namespace' })).toEqual({ a: { value: 1 }, b: { value: 2 } });
    expect(() => mergeValues({ a: 1, b: 2 }, { waitFor: 'all_active', combine: 'select', collision: 'error' })).toThrow(/exactly one/);
    expect(mergeValues({ a: 1, b: 2 }, { waitFor: 'all_active', combine: 'select', collision: 'error', selectKey: 'b' })).toBe(2);
  });

  it('rejects irrelevant merge options and does not manufacture a result for no active input', () => {
    expect(() => mergeValues({}, { waitFor: 'all_active', combine: 'object', collision: 'error' })).toThrow(/skipped/);
    expect(() => mergeValues({ a: 1 }, { waitFor: 'all_active', combine: 'array', collision: 'namespace' })).toThrow(/only applies/);
    expect(() => mergeValues({ a: {} }, { waitFor: 'all_active', combine: 'object', collision: 'error', selectKey: 'a' })).toThrow(/only valid/);
  });

  it('classifies only unambiguous rule matches without inventing confidence', () => {
    const rules = [
      { id: 'high', expression: { op: 'gte', args: [{ var: '/priority' }, { literal: 3 }] } },
      { id: 'low', expression: { op: 'lt', args: [{ var: '/priority' }, { literal: 3 }] } },
    ] as const;
    expect(classifyByRules({ priority: 4 }, rules as unknown as Parameters<typeof classifyByRules>[1])).toEqual({ label: 'high', matchedRuleIds: ['high'], reason: 'matched' });
    expect(classifyByRules({}, [{ id: 'never', expression: { literal: false } }]).label).toBe('unclassified');
    expect(() => classifyByRules({}, [{ id: 'a', expression: { literal: true } }, { id: 'b', expression: { literal: true } }])).toThrow(/Multiple/);
  });

  it('records exact rule scores and uses a separate pass expression', () => {
    const result = evaluateRules({ count: 4, complete: true }, [
      { id: 'count', expression: { var: '/count' } },
      { id: 'complete', expression: { var: '/complete' } },
    ], { op: 'and', args: [{ op: 'gte', args: [{ var: '/scores/count' }, { literal: 5 }] }, { op: 'eq', args: [{ var: '/scores/complete' }, { literal: 1 }] }] });
    expect(result.scores).toEqual({ count: 4, complete: 1 });
    expect(result.passed).toBe(false);
    expect(result.evidence).toEqual([{ ruleId: 'count', result: 4 }, { ruleId: 'complete', result: true }]);
    expect(() => evaluateRules({}, [], { literal: true })).toThrow(/requires/);
    expect(() => evaluateRules({}, [{ id: 'text', expression: { literal: 'good' } }], { literal: true })).toThrow(/numeric score/);
    expect(() => evaluateRules({}, [{ id: 'one', expression: { literal: 1 } }], { literal: 1 })).toThrow(/boolean/);
  });

  it('rejects missing rule IDs and malformed collections without implicit string conversion', () => {
    const missingId = [{ expression: { literal: true } }] as unknown as Parameters<typeof evaluateRules>[1];
    expect(() => evaluateRules({}, missingId, { literal: true })).toThrow(/strings/);
    expect(() => classifyByRules({}, missingId)).toThrow(/strings/);
    expect(() => evaluateRules({}, { length: 1 } as unknown as Parameters<typeof evaluateRules>[1], { literal: true })).toThrow(/requires/);
    expect(() => resolveNodeActivation({ nodeId: 1, entryNodeId: 1, incoming: [] } as unknown as Parameters<typeof resolveNodeActivation>[0])).toThrow(/activation input/);
  });
});
