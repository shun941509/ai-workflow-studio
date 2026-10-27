import { parseStrictJson, type FileRef } from '@studio/spec';
import { RunnerError } from '../errors.js';

export const MAX_TEXT_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Decode only declared text formats, preserving original Unicode, BOM and line endings for byte-addressed citations. */
export function decodeUtf8Document(reference: FileRef, bytes: Uint8Array): string {
  const extensions: Record<string, readonly string[]> = { 'text/plain': ['.txt'], 'text/markdown': ['.md', '.markdown'], 'application/json': ['.json'] };
  const extension = reference.filename.slice(reference.filename.lastIndexOf('.')).toLowerCase();
  if (!extensions[reference.mimeType]?.includes(extension)) throw new RunnerError('DOCUMENT_FORMAT_UNSUPPORTED', 'UTF-8 TXT·Markdown·JSON 문서만 지원합니다.');
  if (!bytes.byteLength || bytes.byteLength > MAX_TEXT_DOCUMENT_BYTES) throw new RunnerError('DOCUMENT_INPUT_LIMIT', '문서는 비어 있지 않은 2 MiB 이하의 텍스트여야 합니다.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RunnerError('DOCUMENT_TEXT_ENCODING', '원본 파일을 올바른 UTF-8로 읽을 수 없습니다.'); }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw new RunnerError('DOCUMENT_TEXT_ENCODING', '바이너리 제어문자가 포함된 문서는 지원하지 않습니다.');
  if (reference.mimeType === 'application/json') {
    // Validate JSON without modifying the extraction: a leading BOM remains in returned source text.
    try { parseStrictJson(text.startsWith('\uFEFF') ? text.slice(1) : text); }
    catch { throw new RunnerError('DOCUMENT_JSON_INVALID', 'JSON 문법·중복 키·복잡도 검사를 통과하지 못했습니다.'); }
  }
  return text;
}
