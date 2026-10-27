import { extname } from 'node:path';
import { assertJsonData, type WorkflowNode } from '@studio/spec';
import { validateManagedOutput, type NodeOutput } from '@studio/workflow-core';
export { validateManagedOutput } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';
import { ArtifactStore } from './store.js';

type OutputNode = Extract<WorkflowNode, { type: 'file_output' }>;
type InputNode = Extract<WorkflowNode, { type: 'file_input' }>;
export interface ManagedFileContext { store: ArtifactStore; runId: string; operationId: string }
const formats = {
  text: { mime: 'text/plain', extensions: ['.txt'] },
  markdown: { mime: 'text/markdown', extensions: ['.md', '.markdown'] },
  json: { mime: 'application/json', extensions: ['.json'] },
  csv: { mime: 'text/csv', extensions: ['.csv'] },
} as const;
const reject = (code: string, message: string): never => { throw new RunnerError(code, message); };


/** CSV uses explicit columns and scalar cells. Dangerous spreadsheet strings fail instead of silently changing data. */
function encodeCsv(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('CSV_INPUT_INVALID', 'CSV에는 columns와 rows가 필요합니다.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'columns,rows' || !Array.isArray(input.columns) || !input.columns.length || input.columns.length > 100 || input.columns.some(column => typeof column !== 'string' || !column || column.length > 200) || new Set(input.columns).size !== input.columns.length || !Array.isArray(input.rows) || input.rows.length > 10000) reject('CSV_INPUT_INVALID', 'CSV 열 또는 행의 형식·개수 한도를 확인하세요.');
  const columns = input.columns as string[]; const rows = input.rows as unknown[];
  const cell = (value: unknown): string => {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) reject('CSV_CELL_INVALID', 'CSV 셀에는 문자열·숫자·불리언·null만 사용할 수 있습니다.');
    if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/.test(value))) reject('CSV_FORMULA_REJECTED', '수식으로 해석될 수 있는 CSV 값이 있습니다. 원본 보존이 필요하면 JSON 형식을 사용하세요.');
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  };
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column))) reject('CSV_ROW_INVALID', '모든 CSV 행은 선언된 열을 정확히 포함해야 합니다.');
    lines.push(columns.map(column => cell((row as Record<string, unknown>)[column])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Builtin serialization writes exact bytes, never executes content, templates, shell commands or host paths. */
export function executeManagedFileOutput(node: OutputNode, inputs: Record<string, unknown>, context: ManagedFileContext): NodeOutput {
  validateManagedOutput(node.config); let bytes: Uint8Array; let mimeType: string;
  if (node.config.format === 'copy') {
    const reference = context.store.resolve(context.runId, inputs.file);
    if (extname(node.config.filename).toLowerCase() !== extname(reference.filename).toLowerCase()) reject('FILE_EXTENSION_INVALID', '복사한 파일의 원본 확장자를 유지하세요.');
    bytes = context.store.read(context.runId, reference.id).bytes; mimeType = reference.mimeType;
  } else {
    assertJsonData(inputs.content);
    const format = node.config.format as keyof typeof formats; mimeType = formats[format].mime;
    let text: string;
    if (format === 'json') text = JSON.stringify(inputs.content, null, 2) + '\n';
    else if (format === 'csv') text = encodeCsv(inputs.content);
    else { if (typeof inputs.content !== 'string') reject('FILE_CONTENT_INVALID', '텍스트 파일에는 문자열 내용이 필요합니다.'); text = inputs.content as string; }
    bytes = new TextEncoder().encode(text);
  }
  const reference = context.store.put(context.runId, { operationId: context.operationId, filename: node.config.filename, mimeType, bytes });
  return { data: reference, files: [reference] };
}

/** Selection must already be persisted through an authorized user upload; model-supplied references grant no access. */
export function executeManagedFileInput(node: InputNode, inputs: Record<string, unknown>, context: Pick<ManagedFileContext, 'runId' | 'store'>): NodeOutput {
  if (!Array.isArray(inputs.files) || !inputs.files.length || inputs.files.length > node.config.maxFiles) reject('FILE_COUNT_INVALID', '허용된 개수의 파일을 선택하세요.');
  const files = (inputs.files as unknown[]).map(value => context.store.resolve(context.runId, value));
  if (new Set(files.map(file => file.id)).size !== files.length) reject('FILE_DUPLICATE', '같은 파일을 중복 선택할 수 없습니다.');
  for (const file of files) {
    if (!node.config.mimeTypes.includes(file.mimeType) || file.bytes > node.config.maxBytesPerFile) reject('FILE_FILTER_REJECTED', '선택한 파일이 허용 형식 또는 크기와 다릅니다.');
  }
  return { data: files, files };
}
