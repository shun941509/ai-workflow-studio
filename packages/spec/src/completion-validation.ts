import { schemaBundle } from './generated/schema-bundle.generated.js';
import type { CompletionContract } from './generated/completion.generated.js';
import { assertJsonData } from './strict-json.js';
import { createSchemaValidator, validateJsonValue, type ValidationIssue, type ValidationResult } from './validation.js';

const validator = createSchemaValidator();
const completionShape = validator.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: '#/$defs/completion', $defs: schemaBundle.$defs });
const issue = (code: string, message: string): ValidationIssue => ({ severity: 'error', stage: 'completion', code, message, instancePath: '/completion' });

/** Criteria are bounded JSON declarations, with unique identities and the same safe user-schema policy as outputs. */
export function validateCompletionDeclaration(value: unknown): ValidationResult<CompletionContract> {
  try {
    assertJsonData(value);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144 || !completionShape(value)) throw new Error('완료 기준은 1~32개의 올바른 항목과 256 KiB 이하의 선언이어야 합니다.');
    const completion = value as CompletionContract; const ids = new Set<string>();
    for (const criterion of completion.criteria) {
      if (ids.has(criterion.id) || !criterion.label.trim()) throw new Error('완료 기준의 ID는 고유해야 하며 설명은 비어 있을 수 없습니다.');
      ids.add(criterion.id);
      if (criterion.kind === 'result_schema') {
        const checked = validateJsonValue(criterion.schema, null);
        if (!checked.valid && checked.issues.some(item => item.code === 'UNSUPPORTED_SCHEMA_OR_VALUE')) throw new Error('지원하지 않는 완료 기준 스키마입니다.');
      }
    }
    return { valid: true, value: completion, issues: [] };
  } catch (error) { return { valid: false, issues: [issue('COMPLETION_INVALID', error instanceof Error ? error.message : '완료 기준을 확인할 수 없습니다.')] }; }
}

// The browser entry uses the same semantics with a build-time, CSP-safe shape validator.
export { validateRunOutcome } from './run-outcome-validation.js';
