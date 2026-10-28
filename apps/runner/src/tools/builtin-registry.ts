import { assertJsonData, createNode, createSchemaValidator, type FileRef, type ToolRef, type Workflow, type WorkflowNode } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import type { NodeOutput } from '@studio/workflow-core';
import fileRefSchema from '../../../../packages/spec/schemas/file-ref.schema.json' with { type: 'json' };
import toolRefSchema from '../../../../packages/spec/schemas/tool-ref.schema.json' with { type: 'json' };
import { executeTextExtraction } from '../artifacts/document-extract.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { RunnerError } from '../errors.js';
import { interruption } from '../execution/concurrency.js';

export interface BuiltinToolDescriptor {
  kind: 'builtin'; id: 'file.inspect' | 'document.read_utf8'; version: 1;
  classification: 'read_only'; scope: 'current_run_managed_files';
  argumentsSchema: Record<string, unknown>; resultSchema: Record<string, unknown>; contractHash: string;
}
export interface BuiltinToolContext {
  runId: string; store: ArtifactStore; signal: AbortSignal; checkpoint: () => void;
  /** Service-owned callback verifies durable current-run registration as well as the persisted artifact bytes. */
  authorizeFile: (reference: unknown) => FileRef;
}
type ToolNode = Extract<WorkflowNode, { type: 'tool' }>;
const reference = { $ref: '#/$defs/FileRef' };
const argumentSchema = { type: 'object', properties: { file: reference }, required: ['file'], additionalProperties: false, $defs: { FileRef: fileRefSchema } };
const source = { type: 'object', properties: {
  file: reference,
  extractor: { type: 'object', properties: { id: { const: 'builtin-utf8-verbatim' }, version: { const: 1 } }, required: ['id', 'version'], additionalProperties: false },
  textSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  location: { type: 'object', properties: { encoding: { const: 'utf8' }, start: { const: 0 }, end: { type: 'integer', minimum: 1, maximum: 2 * 1024 * 1024 } }, required: ['encoding', 'start', 'end'], additionalProperties: false },
}, required: ['file', 'extractor', 'textSha256', 'location'], additionalProperties: false };
const sourceArray = { type: 'array', minItems: 1, maxItems: 1, items: { $ref: '#/$defs/Source' } };
const fileResultSchema = { type: 'object', properties: { data: { type: 'object', properties: { file: reference, integrity: { const: 'verified' } }, required: ['file', 'integrity'], additionalProperties: false } }, required: ['data'], additionalProperties: false, $defs: { FileRef: fileRefSchema } };
const documentResultSchema = { type: 'object', properties: {
  data: { type: 'object', properties: { text: { type: 'string' }, tables: { type: 'array', maxItems: 0 }, locations: sourceArray, uncertainties: { type: 'array', maxItems: 0 }, extraction: { const: 'verbatim_utf8' } }, required: ['text', 'tables', 'locations', 'uncertainties', 'extraction'], additionalProperties: false },
  text: { type: 'string' }, sources: sourceArray,
}, required: ['data', 'text', 'sources'], additionalProperties: false, $defs: { FileRef: fileRefSchema, Source: source } };

function freeze<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function descriptor(id: BuiltinToolDescriptor['id'], resultSchema: Record<string, unknown>): BuiltinToolDescriptor {
  const body = structuredClone({ kind: 'builtin' as const, id, version: 1 as const, classification: 'read_only' as const, scope: 'current_run_managed_files' as const, argumentsSchema: argumentSchema, resultSchema });
  return freeze({ ...body, contractHash: canonicalDigest(body) });
}
const metadata = [descriptor('file.inspect', fileResultSchema), descriptor('document.read_utf8', documentResultSchema)];
const ajv = createSchemaValidator();
const validRef = ajv.compile(toolRefSchema);
// This internal adapter fixes the UTF-8 configuration independently of future authoring defaults.
const textNode = (() => { const node = createNode('document_extract'); if (node.type !== 'document_extract') throw new Error('Document extraction registry mismatch'); node.config = { mode: 'text' }; return freeze(node); })();
const handlers: Record<BuiltinToolDescriptor['id'], (file: FileRef, context: BuiltinToolContext) => NodeOutput> = {
  'file.inspect': file => ({ data: { file, integrity: 'verified' } }),
  'document.read_utf8': (file, context) => executeTextExtraction(textNode, { file }, { store: context.store, runId: context.runId }),
};
// Private implementations are selected by exact registry identity, never imported from Workflow content or descriptor strings.
const registry = new Map(metadata.map(item => [`${item.id}@${item.version}`, { descriptor: item, arguments: ajv.compile(item.argumentsSchema), result: ajv.compile(item.resultSchema), invoke: handlers[item.id] }]));
export const BUILTIN_TOOL_CAPABILITIES = Object.freeze(['node.tool@1', ...metadata.map(item => `tool.builtin.${item.id}@${item.version}`)]);

function lookup(ref: ToolRef) {
  try { assertJsonData(ref); } catch { throw new RunnerError('BUILTIN_TOOL_UNSUPPORTED', '도구 참조는 고정 ID와 버전이어야 합니다.'); }
  if (!validRef(ref) || ref.kind !== 'builtin') throw new RunnerError('BUILTIN_TOOL_UNSUPPORTED', '등록된 읽기 전용 builtin 도구만 사용할 수 있습니다.');
  const item = registry.get(`${ref.id}@${ref.version}`);
  if (!item) throw new RunnerError('BUILTIN_TOOL_UNSUPPORTED', '등록되지 않은 도구 ID 또는 버전입니다.');
  return item;
}

/** A deeply frozen contract can be displayed or pinned, but does not expose a mutable registry or executable function. */
export function getBuiltinToolDescriptor(ref: ToolRef): Readonly<BuiltinToolDescriptor> { return lookup(ref).descriptor; }
export function validateBuiltinArguments(ref: ToolRef, value: unknown): { file: FileRef } {
  const item = lookup(ref);
  try { assertJsonData(value); } catch { throw new RunnerError('BUILTIN_ARGUMENTS_INVALID', '도구 인수는 일반 JSON이어야 합니다.'); }
  if (!item.arguments(value)) throw new RunnerError('BUILTIN_ARGUMENTS_INVALID', '도구 인수에는 관리 파일 참조 file 하나만 넣으세요.');
  return structuredClone(value) as { file: FileRef };
}
export function validateBuiltinToolNode(node: ToolNode): void {
  lookup(node.config.tool);
  if (node.inputBindings.arguments?.from === 'literal') validateBuiltinArguments(node.config.tool, node.inputBindings.arguments.value);
}
export function builtinToolPins(workflow: Workflow): Record<string, Readonly<BuiltinToolDescriptor>> {
  const pins: Record<string, Readonly<BuiltinToolDescriptor>> = Object.create(null) as Record<string, Readonly<BuiltinToolDescriptor>>;
  for (const flow of [workflow, ...Object.values(workflow.subworkflows)]) for (const node of flow?.nodes ?? []) if (node.type === 'tool') { const item = lookup(node.config.tool).descriptor; pins[`${item.id}@${item.version}`] = item; }
  return pins;
}
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
function savedPins(plan: unknown): unknown { return field(field(field(plan, 'resolved'), 'verifiedDependencies'), 'builtinTools'); }
function matches(actual: unknown, expected: unknown): boolean { try { assertJsonData(actual); return canonicalDigest(actual) === canonicalDigest(expected); } catch { return false; } }
export function assertBuiltinToolPlan(workflow: Workflow, plan: unknown): void {
  const expected = builtinToolPins(workflow); if (!Object.keys(expected).length) return;
  if (!matches(savedPins(plan), expected)) throw new RunnerError('BUILTIN_TOOL_CHANGED', '고정한 도구 계약과 현재 Runner가 다릅니다. 새 실행 계획이 필요합니다.');
}
export function assertBuiltinToolPin(ref: ToolRef, plan: unknown): void {
  const expected = lookup(ref).descriptor;
  if (!matches(field(savedPins(plan), `${expected.id}@${expected.version}`), expected)) throw new RunnerError('BUILTIN_TOOL_CHANGED', '실행 계획의 도구 ID·버전·분류·형식이 현재 등록과 다릅니다.');
}

/** Only verified managed FileRefs reach the two fixed handlers. Both inputs and actual output obey trusted closed schemas. */
export function executeBuiltinTool(ref: ToolRef, value: unknown, plan: unknown, context: BuiltinToolContext): NodeOutput {
  const item = lookup(ref); assertBuiltinToolPin(ref, plan); const args = validateBuiltinArguments(ref, value);
  const checkpoint = () => { if (context.signal.aborted) throw interruption(context.signal); context.checkpoint(); };
  checkpoint(); const file = context.authorizeFile(args.file); checkpoint();
  if (!matches(file, args.file)) throw new RunnerError('BUILTIN_FILE_MISMATCH', '검증한 파일과 요청한 파일 참조가 다릅니다.');
  const output = item.invoke(file, context);
  checkpoint(); assertJsonData(output);
  if (!item.result(output)) throw new RunnerError('BUILTIN_RESULT_INVALID', '등록 도구의 실제 결과가 고정한 결과 형식과 다릅니다.');
  return output;
}
