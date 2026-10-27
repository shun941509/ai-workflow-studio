import { validateJsonValue } from '@studio/spec';
import type { NodeOutput } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';

/** A completed node is not a successful workflow unless the final result contract holds. */
export function executeOutput(result: unknown, schema: unknown): NodeOutput {
  if (!validateJsonValue(schema, result).valid) throw new RunnerError('OUTPUT_INVALID', '최종 결과가 프로젝트의 결과 형식과 일치하지 않습니다.');
  return { data: result, ...(typeof result === 'string' ? { text: result } : {}) };
}
