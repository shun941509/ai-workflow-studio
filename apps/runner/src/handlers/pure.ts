import type { WorkflowNode } from '@studio/spec';
import { applyTransform, evaluateCondition, evaluateRules, mergeValues, type NodeOutput } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';

export interface RecoverableFailure { code: string; message: string; nodeId: string; recoverable: true }
export interface PureResult { output: NodeOutput; port: string }

/** Pure handlers only consume resolved JSON and return data plus an explicit control port. */
export function executePure(node: WorkflowNode, inputs: Record<string, unknown>, failure?: RecoverableFailure): PureResult {
  let data: unknown;
  if (node.type === 'transform') data = applyTransform(inputs.value, node.config.steps, node.config.resultSchema);
  else if (node.type === 'condition') { const matched = evaluateCondition(node.config.expression, inputs); return { output: { data: { matched, value: inputs.value } }, port: matched ? 'true' : 'false' }; }
  else if (node.type === 'merge') data = mergeValues(inputs, node.config);
  else if (node.type === 'evaluate') {
    if (node.config.mode !== 'rules') throw new RunnerError('CAPABILITY_MISSING', '모델 기반 평가는 아직 지원하지 않습니다.');
    data = evaluateRules(inputs.value, node.config.rules ?? [], node.config.passRule, node.config.resultSchema);
  } else if (node.type === 'error') {
    if (!failure || failure.recoverable !== true) throw new RunnerError('ERROR_CONTEXT_REQUIRED', '확인된 복구 가능 오류만 처리할 수 있습니다.');
    if (node.config.mode === 'rethrow') throw new RunnerError('WORKFLOW_RETHROWN', failure.message);
    if (!Object.hasOwn(inputs, 'fallback')) throw new RunnerError('ERROR_FALLBACK_REQUIRED', '오류 복구에는 명시적인 대체 결과가 필요합니다.');
    data = inputs.fallback;
  } else throw new RunnerError('CAPABILITY_MISSING', `${node.type} 순수 실행 기능이 없습니다.`);
  return { output: { data }, port: 'next' };
}

/** An allowlist separates ordinary data failures from permissions, limits, cancellation and uncertain calls. */
export function isRecoverableFailure(code: string): boolean {
  return new Set(['TRANSFORM_MISSING_FIELD', 'TRANSFORM_TYPE', 'TRANSFORM_COLLISION', 'TRANSFORM_OUTPUT_INVALID', 'INVALID_JSON', 'DUPLICATE_JSON_KEY', 'MODEL_OUTPUT_INVALID', 'MODEL_REFUSAL', 'EXPRESSION_MISSING', 'EXPRESSION_TYPE', 'MERGE_TYPE', 'MERGE_COLLISION', 'MERGE_SELECTION_MISSING', 'EVALUATION_OUTPUT_INVALID', 'EVALUATION_TYPE']).has(code);
}
