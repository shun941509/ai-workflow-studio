import { type FileRef, type WorkflowNode } from '@studio/spec';
import { RunnerError } from '../errors.js';
import { decodeUtf8Document, MAX_TEXT_DOCUMENT_BYTES } from '../artifacts/text-document.js';
export { validateRunRagNode } from '@studio/workflow-core';

export type RunRagNode = Extract<WorkflowNode, { type: 'knowledge' | 'retrieval' }>;
export const RUN_KEYWORD_PROFILE = 'local-run-keyword-v1';
export const RUN_RAG_CAPABILITIES = ['node.knowledge@1', 'knowledge.build@1', 'knowledge.open@1', 'knowledge.keyword@1', 'knowledge.vector@1', 'knowledge.hybrid@1', 'embedding.openai_small_256@1', 'rag.run_local@1', 'node.retrieval@1', 'retrieval.keyword@1', 'retrieval.vector@1', 'retrieval.hybrid@1'] as const;
export const RUN_RAG_LIMITS = Object.freeze({ files: 32, fileBytes: MAX_TEXT_DOCUMENT_BYTES, buildBytes: 8 * 1024 * 1024, runBytes: 16 * 1024 * 1024, runChunks: 2000, buildChunks: 1000, builds: 4, operations: 100 });

/** The original decoded UTF-8 text is preserved: markdown/JSON are text, not executable code or an OCR/parser claim. */
export function decodeManagedText(reference: FileRef, bytes: Uint8Array): string {
  try { return decodeUtf8Document(reference, bytes); }
  catch (error) {
    // Keep stable RAG error codes while using the same verbatim decoder as document extraction.
    if (!(error instanceof RunnerError)) throw error;
    const code = error.code === 'DOCUMENT_FORMAT_UNSUPPORTED' ? 'RAG_FILE_FORMAT_UNSUPPORTED' : error.code.replace(/^DOCUMENT_/, 'RAG_');
    throw new RunnerError(code, error.message);
  }
}

/** Byte ranges end on Unicode boundaries; overlap rounds forward and every iteration strictly advances. */
export function chunkUtf8(bytes: Uint8Array, size: number, overlap: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []; let start = 0;
  if (!Number.isSafeInteger(size) || size < 100 || size > 20000 || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= size) throw new RunnerError('RAG_CHUNK_SETTINGS', 'UTF-8 청크 설정이 올바르지 않습니다.');
  while (start < bytes.byteLength) {
    let end = Math.min(start + size, bytes.byteLength);
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end <= start) throw new RunnerError('RAG_CHUNK_SETTINGS', '청크 경계가 진행하지 못했습니다.');
    ranges.push({ start, end });
    if (ranges.length > RUN_RAG_LIMITS.buildChunks) throw new RunnerError('RAG_INPUT_LIMIT', '한 색인은 최대 1000개의 청크를 지원합니다.');
    if (end === bytes.byteLength) break;
    let next = Math.max(start + 1, end - overlap);
    while (next < end && (bytes[next]! & 0xc0) === 0x80) next++;
    start = next;
  }
  return ranges;
}
