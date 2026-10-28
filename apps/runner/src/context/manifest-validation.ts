import { assertJsonData, createSchemaValidator } from '@studio/spec';
import type { WorkingContextManifest } from '../state/working-context.js';
import { RunnerError } from '../errors.js';

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const closed = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
/** Server-owned runtime DTO schema. Workflow and Node declarations continue to use the shared generated schemas. */
const shape = createSchemaValidator().compile(closed({
  version: { const: 1 }, runId: text(100), nodeId: text(64), nodeInstanceId: text(200), attemptId: text(100), planHash: digest,
  workDefinitionHash: digest, contextNodeId: text(64), contextResultHash: digest, businessTaskHash: digest,
  maxBytes: { type: 'integer', minimum: 1024, maximum: 1048576 }, requestHash: digest, requestBytes: { type: 'integer', minimum: 1, maximum: 1048576 }, model: text(120), provider: { const: 'openai' }, selectionScope: { const: 'task_fixed_attachments' },
  assets: { type: 'array', maxItems: 80, items: closed({ alias: text(64), id: text(64), revision: { type: 'integer', minimum: 1 }, sha256: digest, kind: { enum: ['instruction', 'document', 'skill'] }, usage: { enum: ['instructions', 'reference', 'template'] }, purpose: text(1000), required: { type: 'boolean' }, selected: { type: 'boolean' }, reason: { enum: ['selected', 'not_selected'] }, files: { type: 'array', minItems: 1, maxItems: 10000, items: closed({ path: text(1024), sha256: digest, bytes: { type: 'integer', minimum: 0, maximum: 262144 }, selected: { type: 'boolean' }, purpose: { enum: ['instructions', 'reference', 'template', 'skill_reference', 'skill_asset', 'excluded'] }, reason: { enum: ['selected', 'not_selected', 'license_not_context', 'binary_metadata_only', 'execution_not_supported'] } }) } }) },
}));

/** Parse/DB values remain unknown until their closed shape and bounded size are confirmed. */
export function checkedWorkingContextManifest(value: unknown): WorkingContextManifest {
  assertJsonData(value);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144 || !shape(value)) throw new RunnerError('WORK_CONTEXT_STATE_INVALID', '업무 문맥 기록 형식을 확인할 수 없습니다.');
  const manifest = value as unknown as WorkingContextManifest;
  if (manifest.requestBytes > manifest.maxBytes || new Set(manifest.assets.map(asset => asset.alias)).size !== manifest.assets.length || manifest.assets.some(asset => new Set(asset.files.map(file => file.path)).size !== asset.files.length)) throw new RunnerError('WORK_CONTEXT_STATE_INVALID', '업무 문맥 크기 또는 고정 자료 목록이 올바르지 않습니다.');
  return manifest;
}
