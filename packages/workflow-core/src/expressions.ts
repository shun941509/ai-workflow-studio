import { assertJsonData, validateJsonValue, type WorkflowNode } from '@studio/spec';
import { canonicalize } from 'json-canonicalize';
import { assertAllowedKeys, assertSafeKey, copyJson, CoreOperationError, lookupPointer, requireRecord } from './transform/json.js';

export type Expression = Extract<WorkflowNode, { type: 'condition' }>['config']['expression'];
type Operator = Extract<Expression, { op: string }>['op'];
const unary = new Set<Operator>(['not', 'exists']);
const binary = new Set<Operator>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);
const logical = new Set<Operator>(['and', 'or']);
const MISSING = Symbol('missing-expression-value');

/** Validate every branch before evaluation; short-circuiting must not conceal an unsupported operator. */
export function validateExpression(expression: unknown): Expression {
  assertJsonData(expression);
  let count = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++count > 256 || depth > 32) throw new CoreOperationError('EXPRESSION_LIMIT', 'Expression exceeds its node or nesting limit');
    const node = requireRecord(value, 'INVALID_EXPRESSION');
    const keys = Object.keys(node);
    if (Object.hasOwn(node, 'literal')) { assertAllowedKeys(node, ['literal']); return; }
    if (Object.hasOwn(node, 'var')) {
      assertAllowedKeys(node, ['var']);
      if (typeof node.var !== 'string') throw new CoreOperationError('INVALID_EXPRESSION', 'var must be a JSON Pointer string');
      lookupPointer({}, node.var); return;
    }
    assertAllowedKeys(node, ['op', 'args']);
    if (keys.length !== 2 || typeof node.op !== 'string' || !Array.isArray(node.args)) throw new CoreOperationError('INVALID_EXPRESSION', 'An operator and args are required');
    const op = node.op as Operator;
    if (!unary.has(op) && !binary.has(op) && !logical.has(op)) throw new CoreOperationError('UNSUPPORTED_OPERATOR', `Unsupported expression operator: ${node.op}`);
    const size = node.args.length;
    if ((unary.has(op) && size !== 1) || (binary.has(op) && size !== 2) || (logical.has(op) && (size < 2 || size > 64))) throw new CoreOperationError('EXPRESSION_ARITY', `Invalid argument count for ${op}`);
    for (const child of node.args) visit(child, depth + 1);
  };
  visit(expression, 0);
  return expression as Expression;
}

function requirePresent(value: unknown | typeof MISSING): unknown {
  if (value === MISSING) throw new CoreOperationError('EXPRESSION_MISSING_VALUE', 'Expression references an unavailable value');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CoreOperationError('EXPRESSION_TYPE', 'A logical expression must return a boolean');
  return value;
}

/** Comparisons use JSON structural equality and explicit scalar types; no eval, coercion, or locale state. */
export function evaluateExpression(expression: unknown, context: unknown): unknown {
  const checked = validateExpression(expression);
  assertJsonData(context);
  const evaluate = (node: Expression): unknown | typeof MISSING => {
    if ('literal' in node) return node.literal;
    if ('var' in node) {
      const found = lookupPointer(context, node.var);
      return found.found ? found.value : MISSING;
    }
    const { op, args } = node;
    if (op === 'exists') return evaluate(args[0]!) !== MISSING;
    if (op === 'not') return !boolean(requirePresent(evaluate(args[0]!)));
    if (op === 'and') {
      for (const arg of args) if (!boolean(requirePresent(evaluate(arg)))) return false;
      return true;
    }
    if (op === 'or') {
      for (const arg of args) if (boolean(requirePresent(evaluate(arg)))) return true;
      return false;
    }
    const left = requirePresent(evaluate(args[0]!)); const right = requirePresent(evaluate(args[1]!));
    if (op === 'eq' || op === 'ne') {
      const equal = canonicalize(left) === canonicalize(right);
      return op === 'eq' ? equal : !equal;
    }
    if (op === 'in') {
      if (!Array.isArray(right)) throw new CoreOperationError('EXPRESSION_TYPE', 'The right operand of in must be an array');
      const key = canonicalize(left);
      return right.some(candidate => canonicalize(candidate) === key);
    }
    if (!((typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string'))) throw new CoreOperationError('EXPRESSION_TYPE', 'Ordering requires two numbers or two strings of the same type');
    // ECMAScript string ordering is deterministic UTF-16 ordering, never environment-dependent collation.
    if (op === 'gt') return left > right;
    if (op === 'gte') return left >= right;
    if (op === 'lt') return left < right;
    if (op === 'lte') return left <= right;
    throw new CoreOperationError('UNSUPPORTED_OPERATOR', `Unsupported operator: ${op}`);
  };
  return copyJson(requirePresent(evaluate(checked)));
}

/** Condition ports require an actual boolean; strings such as "false" are not truthy conditions. */
export function evaluateCondition(expression: unknown, context: unknown): boolean {
  return boolean(evaluateExpression(expression, context));
}

export interface ClassificationRule { id: string; expression: Expression }
export interface RuleClassification { label: string; matchedRuleIds: string[]; reason: 'matched' | 'unclassified' }

/** Internal deterministic classification helper; it does not add a rules mode to the model-based classify node. */
export function classifyByRules(content: unknown, rules: readonly ClassificationRule[], onUnmatched: 'unclassified' | 'error' = 'unclassified'): RuleClassification {
  assertJsonData(rules);
  if (!Array.isArray(rules) || !rules.length || rules.length > 100) throw new CoreOperationError('CLASSIFICATION_RULES_REQUIRED', 'Classification requires 1 to 100 rules');
  if (!['unclassified', 'error'].includes(onUnmatched)) throw new CoreOperationError('UNSUPPORTED_OPTION', 'Unsupported unmatched policy');
  const ids = new Set<string>(); const matches: string[] = [];
  for (const rule of rules) {
    assertJsonData(rule); assertAllowedKeys(requireRecord(rule), ['id', 'expression']); assertSafeKey(rule.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rule.id) || ['in', 'next', 'error', 'unclassified'].includes(rule.id) || ids.has(rule.id)) throw new CoreOperationError('INVALID_RULE_ID', 'Classification rule IDs must be unique non-reserved identifiers');
    ids.add(rule.id);
    if (evaluateCondition(rule.expression, content)) matches.push(rule.id);
  }
  if (matches.length > 1) throw new CoreOperationError('CLASSIFICATION_AMBIGUOUS', 'Multiple classification rules matched; priorities must not be inferred');
  if (!matches.length && onUnmatched === 'error') throw new CoreOperationError('CLASSIFICATION_UNMATCHED', 'No classification rule matched');
  return matches.length ? { label: matches[0]!, matchedRuleIds: matches, reason: 'matched' } : { label: 'unclassified', matchedRuleIds: [], reason: 'unclassified' };
}

export interface EvaluationRule { id: string; expression: Expression }
export interface RulesEvaluation { scores: Record<string, number>; passed: boolean; evidence: { ruleId: string; result: boolean | number }[] }

/** Rules return booleans or numbers; boolean scores are explicitly 1/0 and no invented aggregate is added. */
export function evaluateRules(value: unknown, rules: readonly EvaluationRule[], passRule: unknown, resultSchema?: unknown): RulesEvaluation {
  assertJsonData(rules);
  if (!Array.isArray(rules) || !rules.length || rules.length > 100) throw new CoreOperationError('EVALUATION_RULES_REQUIRED', 'Rule evaluation requires 1 to 100 rules');
  const scores: Record<string, number> = Object.create(null) as Record<string, number>;
  const evidence: RulesEvaluation['evidence'] = [];
  for (const rule of rules) {
    assertJsonData(rule); assertAllowedKeys(requireRecord(rule), ['id', 'expression']); assertSafeKey(rule.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rule.id) || Object.hasOwn(scores, rule.id)) throw new CoreOperationError('INVALID_RULE_ID', 'Evaluation rule IDs must be unique identifiers');
    const result = evaluateExpression(rule.expression, value);
    if (typeof result !== 'boolean' && typeof result !== 'number') throw new CoreOperationError('EVALUATION_TYPE', 'A rule must return a boolean or finite numeric score');
    scores[rule.id] = typeof result === 'boolean' ? (result ? 1 : 0) : result;
    evidence.push({ ruleId: rule.id, result });
  }
  const passed = evaluateCondition(passRule, { scores, evidence, value });
  const result = { scores, passed, evidence };
  if (resultSchema !== undefined && !validateJsonValue(resultSchema, result).valid) throw new CoreOperationError('EVALUATION_OUTPUT_INVALID', 'Evaluation output violates its declared result schema');
  return result;
}
