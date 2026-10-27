import { FORBIDDEN_KEYS, validateNodeConfig, validateJsonValue, type WorkflowNode } from '@studio/spec';
import { CoreOperationError } from './transform/json.js';

type GuardrailConfig = Extract<WorkflowNode, { type: 'guardrail' }>['config'];

/** Rule parameters are explicit and bounded; unknown options never silently weaken a protection rule. */
export function validateGuardrail(config: GuardrailConfig): void {
  if (!validateNodeConfig('guardrail', 1, config).valid) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '보호 규칙 설정이 공통 규격과 다릅니다.');
  if (!config.rules.length || config.rules.length > 100) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '보호 규칙은 1~100개가 필요합니다.');
  const ids = new Set<string>();
  for (const rule of config.rules) {
    if (ids.has(rule.id)) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '보호 규칙 ID가 중복되었습니다.'); ids.add(rule.id);
    const parameters = rule.parameters;
    const allowed = rule.kind === 'schema' ? ['schema'] : rule.kind === 'length' ? ['min', 'max'] : rule.kind === 'allowed_values' ? ['values'] : ['fields'];
    if (Object.keys(parameters).some((key) => !allowed.includes(key))) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '지원하지 않는 보호 규칙 설정입니다.');
    if (rule.kind === 'schema') {
      if (!Object.hasOwn(parameters, 'schema') || validateJsonValue(parameters.schema, null).issues.some((issue) => issue.code === 'UNSUPPORTED_SCHEMA_OR_VALUE')) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '보호 검사에 유효한 JSON Schema가 필요합니다.');
    } else if (rule.kind === 'length') {
      if (!Object.keys(parameters).length || Object.values(parameters).some((value) => !Number.isSafeInteger(value) || Number(value) < 0) || (parameters.min !== undefined && parameters.max !== undefined && Number(parameters.min) > Number(parameters.max))) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '길이 범위는 0 이상의 정수이고 최소값이 최대값 이하여야 합니다.');
    } else if (rule.kind === 'allowed_values') {
      if (!Array.isArray(parameters.values) || !parameters.values.length || parameters.values.length > 1000) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '허용값은 1~1000개의 JSON 값으로 지정하세요.');
    } else {
      const fields = parameters.fields;
      if (!Array.isArray(fields) || !fields.length || fields.length > 1000 || fields.some((field) => typeof field !== 'string' || !field || FORBIDDEN_KEYS.has(field)) || new Set(fields).size !== fields.length) throw new CoreOperationError('GUARDRAIL_CONFIG_INVALID', '필수 필드에는 중복되지 않은 안전한 필드 이름을 지정하세요.');
    }
  }
}
