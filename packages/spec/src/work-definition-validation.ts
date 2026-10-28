import schema from '../schemas/work-definition.schema.json' with { type: 'json' };
import type { Workflow } from './generated/types.generated.js';
import { assertJsonData } from './strict-json.js';
import { createSchemaValidator, type ValidationIssue, type ValidationResult } from './validation.js';

/** This alias follows the canonical Workflow schema generation; it is not a handwritten competing contract. */
export type WorkDefinition = NonNullable<Workflow['workDefinition']>;
const shape = createSchemaValidator().compile<WorkDefinition>(schema);
const issue = (message: string): ValidationIssue => ({ severity: 'error', stage: 'work-definition', code: 'WORK_DEFINITION_INVALID', message, instancePath: '/workDefinition' });

/** Validate bounded shared business data before reading fields. Personal bindings, credentials and session
 * manifests are unknown keys and cannot become part of a portable business definition. */
export function validateWorkDefinitionDeclaration(value: unknown): ValidationResult<WorkDefinition> {
  try {
    assertJsonData(value);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144 || !shape(value)) throw new Error('업무 정의는 지원하는 version 1 형식과 256 KiB 이하의 크기여야 합니다.');
    const definition = value;
    const labels = [definition.card.title, definition.card.purpose, definition.role.title, definition.role.responsibility, definition.task.title, definition.task.goal, ...definition.task.assets.map(asset => asset.purpose), ...definition.task.skills.map(skill => skill.purpose)];
    if (labels.some(label => !label.trim())) throw new Error('업무 이름·목적·책임과 자료 용도는 공백만으로 구성할 수 없습니다.');
    const aliases = [...definition.task.assets, ...definition.task.skills].map(asset => asset.alias);
    if (new Set(aliases).size !== aliases.length) throw new Error('업무 자산과 Skill의 별칭은 서로 중복될 수 없습니다.');
    return { valid: true, value: structuredClone(definition), issues: [] };
  } catch (error) { return { valid: false, issues: [issue(error instanceof Error ? error.message : '업무 정의를 확인할 수 없습니다.')] }; }
}
