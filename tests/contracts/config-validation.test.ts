import { describe, expect, it } from 'vitest';
import { validateNodeConfig } from '@studio/spec';
import { validateExpression, validateGuardrail, validateTransformSteps } from '@studio/workflow-core';

/** Editor preflight reuses the same closed constraints as execution without evaluating user data. */
describe('shared config validation', () => {
  it('rejects unknown config fields, types and versions without coercing values', () => {
    expect(validateNodeConfig('input', 1, {}).valid).toBe(true);
    expect(validateNodeConfig('input', 1, { hidden: true }).valid).toBe(false);
    expect(validateNodeConfig('constructor', 1, {}).valid).toBe(false);
    expect(validateNodeConfig('input', 2, {}).valid).toBe(false);
    expect(validateNodeConfig('review', 1, { question: 123, responseSchema: {} }).valid).toBe(false);
  });
  it('validates expressions and nested transform options without reading unavailable input variables', () => {
    expect(() => validateExpression({ op: 'gt', args: [{ var: '/not-yet-provided' }, { literal: 0 }] })).not.toThrow();
    expect(() => validateExpression({ op: 'or', args: [{ literal: true }, { op: 'shell', args: [] }] })).toThrow();
    expect(() => validateTransformSteps([{ op: 'map', options: { steps: [{ op: 'pick', options: { keys: ['name'], hidden: true } }] } }])).toThrow();
    expect(() => validateTransformSteps([{ op: 'pick', options: { keys: ['name'] } }])).not.toThrow();
  });
  it('shares guardrail shape and closed parameter checks across UI and Runner', () => {
    expect(() => validateGuardrail({ onViolation: 'block', rules: [{ id: 'length', kind: 'length', parameters: { min: 1, max: 10 } }] })).not.toThrow();
    expect(() => validateGuardrail({ onViolation: 'block', rules: [{ id: 'length', kind: 'length', parameters: { min: 10, max: 1 } }] })).toThrow();
    expect(() => validateGuardrail({ onViolation: 'block', rules: [{ id: 'fields', kind: 'required_fields', parameters: { fields: ['name'], skipMissing: true } }] })).toThrow();
  });
});
