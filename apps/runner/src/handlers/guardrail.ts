import { validateJsonValue, type WorkflowNode } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { validateGuardrail, type NodeOutput } from '@studio/workflow-core';
export { validateGuardrail } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';

type GuardrailConfig = Extract<WorkflowNode, { type: 'guardrail' }>['config'];

/** A failed guardrail is a protected stop, never a recoverable business error or a fabricated default value. */
export function executeGuardrail(value: unknown, config: GuardrailConfig): NodeOutput {
  validateGuardrail(config);
  for (const rule of config.rules) {
    const p = rule.parameters; let passed = false;
    if (rule.kind === 'schema') passed = validateJsonValue(p.schema, value).valid;
    else if (rule.kind === 'length') {
      let length: number | undefined;
      if (typeof value === 'string') { length = 0; for (const _point of value) length++; }
      else if (Array.isArray(value)) length = value.length;
      passed = length !== undefined && (p.min === undefined || length >= Number(p.min)) && (p.max === undefined || length <= Number(p.max));
    } else if (rule.kind === 'allowed_values') passed = (p.values as unknown[]).some((allowed) => canonicalDigest(allowed) === canonicalDigest(value));
    else passed = value !== null && typeof value === 'object' && !Array.isArray(value) && (p.fields as string[]).every((field) => Object.hasOwn(value, field));
    if (!passed) throw new RunnerError('GUARDRAIL_BLOCKED', `보호 규칙 '${rule.id}'을 통과하지 못하여 실행을 중단했습니다.`);
  }
  return { data: structuredClone(value), ...(typeof value === 'string' ? { text: value } : {}) };
}
