import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNode, type WorkflowNode } from '@studio/spec';
import { ArtifactStore } from '../../apps/runner/src/artifacts/store.js';
import { executeTextExtraction } from '../../apps/runner/src/artifacts/document-extract.js';

const roots: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), 'studio-text-extraction-')); roots.push(root); return new ArtifactStore(join(root, 'files')); }
function node() { return createNode('document_extract') as Extract<WorkflowNode, { type: 'document_extract' }>; }
function put(store: ArtifactStore, text: string | Uint8Array, filename = '문서.txt', mimeType = 'text/plain') {
  return store.put('run_a', { operationId: 'upload', filename, mimeType, bytes: typeof text === 'string' ? Buffer.from(text, 'utf8') : text });
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Cleanup is limited to the exact temporary directories this test created.
    const target = resolve(root); if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('studio-text-extraction-')) throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

/** These tests read actual stored bytes and validate provenance; no document converter or OCR is simulated. */
describe('managed UTF-8 text extraction', () => {
  it.each([
    ['문서.txt', 'text/plain', '\uFEFF한글😀\r\n둘째 줄'],
    ['문서.md', 'text/markdown', '# 제목\n<script>alert(1)</script>'],
    ['문서.json', 'application/json', '\uFEFF{ "한글": "😀" }\r\n'],
  ])('preserves exact bytes and location of %s', (filename, mime, text) => {
    const store = setup(); const file = put(store, text, filename, mime);
    const result = executeTextExtraction(node(), { file }, { store, runId: 'run_a' });
    expect(result.text).toBe(text); expect(Buffer.from(result.text!)).toEqual(Buffer.from(text));
    expect(result.data).toMatchObject({ text, tables: [], uncertainties: [], extraction: 'verbatim_utf8' });
    expect(result.sources).toEqual([{ file, extractor: { id: 'builtin-utf8-verbatim', version: 1 }, textSha256: createHash('sha256').update(text).digest('hex'), location: { encoding: 'utf8', start: 0, end: Buffer.byteLength(text) } }]);
    expect(store.read('run_a', file.id).bytes).toEqual(Buffer.from(text));
  });
  it.each([
    [Buffer.from([0xc3, 0x28]), 'DOCUMENT_TEXT_ENCODING'],
    [Buffer.from('abc\0hidden'), 'DOCUMENT_TEXT_ENCODING'],
    [Buffer.from(''), 'DOCUMENT_INPUT_LIMIT'],
    [Buffer.alloc(2 * 1024 * 1024 + 1, 97), 'DOCUMENT_INPUT_LIMIT'],
  ])('rejects invalid UTF-8, binary controls and size violations', (bytes, code) => {
    const store = setup(); const file = put(store, bytes as Uint8Array);
    expect(() => executeTextExtraction(node(), { file }, { store, runId: 'run_a' })).toThrow(expect.objectContaining({ code }));
  });
  it('rejects mismatched MIME, unsupported PDF and duplicate JSON keys', () => {
    for (const [filename, mime, text, code] of [['a.txt', 'application/json', '{}', 'DOCUMENT_FORMAT_UNSUPPORTED'], ['a.pdf', 'application/pdf', '%PDF-1.7', 'DOCUMENT_FORMAT_UNSUPPORTED'], ['a.json', 'application/json', '{"x":1,"x":2}', 'DOCUMENT_JSON_INVALID']]) {
      const store = setup(); const file = put(store, text!, filename, mime);
      expect(() => executeTextExtraction(node(), { file }, { store, runId: 'run_a' })).toThrow(expect.objectContaining({ code }));
    }
  });
  it('cannot resolve a file from another run or accept a forged declared hash', () => {
    const store = setup(); const file = put(store, '실제 문서');
    expect(() => executeTextExtraction(node(), { file }, { store, runId: 'run_b' })).toThrow();
    expect(() => executeTextExtraction(node(), { file: { ...file, sha256: 'a'.repeat(64) } }, { store, runId: 'run_a' })).toThrow();
  });
  it.each([{ mode: 'ocr' }, { mode: 'table' }, { mode: 'text', languages: ['ko'] }, { mode: 'text', workerProfile: 'python' }])('does not silently substitute text decoding for %j', config => {
    const store = setup(); const file = put(store, '문서'); const work = node(); work.config = config as typeof work.config;
    expect(() => executeTextExtraction(work, { file }, { store, runId: 'run_a' })).toThrow(expect.objectContaining({ code: 'DOCUMENT_MODE_UNSUPPORTED' }));
  });
});
