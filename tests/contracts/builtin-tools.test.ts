import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSchemaValidator, type ToolRef } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { ArtifactStore } from '../../apps/runner/src/artifacts/store.js';
import { executeBuiltinTool, getBuiltinToolDescriptor, assertBuiltinToolPin, validateBuiltinArguments, BUILTIN_TOOL_CAPABILITIES, type BuiltinToolContext } from '../../apps/runner/src/tools/builtin-registry.js';
import { RunnerError } from '../../apps/runner/src/errors.js';

const roots: string[] = [];
const ref = (id: 'file.inspect' | 'document.read_utf8'): ToolRef => ({ kind: 'builtin', id, version: 1 });
const plan = (tool: ToolRef) => { const descriptor = getBuiltinToolDescriptor(tool); return { resolved: { verifiedDependencies: { builtinTools: { [`${descriptor.id}@${descriptor.version}`]: descriptor } } } }; };
function setup(text: string | Uint8Array = '\uFEFF한글 😀\r\n원문', filename = '원문.txt', mimeType = 'text/plain') {
  const root = mkdtempSync(join(tmpdir(), 'studio-builtin-contract-')); roots.push(root); const store = new ArtifactStore(join(root, 'artifacts'));
  const file = store.put('run_test', { operationId: 'upload', filename, mimeType, bytes: typeof text === 'string' ? Buffer.from(text) : text });
  const context: BuiltinToolContext = { runId: 'run_test', store, signal: new AbortController().signal, checkpoint: () => {}, authorizeFile: value => store.resolve('run_test', value) };
  return { store, file, context, text };
}
afterEach(() => { for (const root of roots.splice(0)) { const path = resolve(root); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-builtin-contract-')) throw new Error('Unsafe cleanup'); rmSync(path, { recursive: true, force: true }); } });

/** These tests use actual artifact bytes; only the trusted service-authorization callback is provided by the test harness. */
describe('trusted read-only builtin registry', () => {
  it('exposes exactly two deeply immutable contracts, without handlers or workflow-selected classification', () => {
    expect(BUILTIN_TOOL_CAPABILITIES).toEqual(['node.tool@1', 'tool.builtin.file.inspect@1', 'tool.builtin.document.read_utf8@1']);
    const descriptor = getBuiltinToolDescriptor(ref('file.inspect')); expect(descriptor).toMatchObject({ classification: 'read_only', scope: 'current_run_managed_files' });
    const { contractHash, ...body } = descriptor; expect(contractHash).toBe(canonicalDigest(body)); expect(descriptor).not.toHaveProperty('handler');
    expect(() => { (descriptor as { classification: string }).classification = 'write'; }).toThrow();
    expect(() => { (descriptor.argumentsSchema as Record<string, unknown>).additionalProperties = true; }).toThrow();
  });
  it.each([{ kind: 'builtin', id: 'file.inspect', version: 2 }, { kind: 'builtin', id: 'file.delete', version: 1 }, { kind: 'mcp', connection: 'external', name: 'read', schemaSha256: 'a'.repeat(64) }, { kind: 'builtin', id: 'file.inspect', version: 1, effects: [], classification: 'read_only' }])('rejects unsupported or metadata-augmented tool refs %#', tool => {
    expect(() => getBuiltinToolDescriptor(tool as ToolRef)).toThrow(expect.objectContaining({ code: 'BUILTIN_TOOL_UNSUPPORTED' }));
  });
  it('checks pin version, classification, schemas and hash instead of trusting an effects declaration', () => {
    const tool = ref('file.inspect'), saved = plan(tool); expect(() => assertBuiltinToolPin(tool, saved)).not.toThrow();
    for (const change of [{ classification: 'write' }, { contractHash: 'b'.repeat(64) }, { argumentsSchema: true }, { effects: [] }, { version: 2 }]) {
      const changed = structuredClone(saved); Object.assign(changed.resolved.verifiedDependencies.builtinTools['file.inspect@1']!, change);
      expect(() => assertBuiltinToolPin(tool, changed)).toThrow(expect.objectContaining({ code: 'BUILTIN_TOOL_CHANGED' }));
    }
    expect(() => assertBuiltinToolPin(tool, {})).toThrow();
  });
  it('allows only a FileRef argument and rejects URL/path/code/effect extras', () => {
    const { file } = setup(); expect(validateBuiltinArguments(ref('file.inspect'), { file })).toEqual({ file });
    for (const value of [{ file, path: 'C:/private' }, { file, url: 'https://example.invalid' }, { file, code: 'read()' }, { file, effects: [] }, { file, classification: 'read_only' }, { file: { ...file, bytes: '3' } }, { id: file.id }]) expect(() => validateBuiltinArguments(ref('file.inspect'), value)).toThrow(expect.objectContaining({ code: 'BUILTIN_ARGUMENTS_INVALID' }));
  });
  it('returns real file metadata after authorization, without generating effects', () => {
    const { file, context } = setup(); const tool = ref('file.inspect');
    expect(executeBuiltinTool(tool, { file }, plan(tool), context)).toEqual({ data: { file, integrity: 'verified' } });
    const validate = createSchemaValidator().compile(getBuiltinToolDescriptor(tool).resultSchema);
    expect(validate({ data: { file, integrity: 'verified' }, effects: [] })).toBe(false);
  });
  it.each([['원문.txt', 'text/plain'], ['원문.md', 'text/markdown'], ['원문.json', 'application/json']])('reuses original text/hash/UTF8 location for %s', (filename, mimeType) => {
    const text = mimeType === 'application/json' ? '\uFEFF{ "text":"한글😀" }\r\n' : '\uFEFF원문 😀\r\n바꾸지 않음';
    const { file, context } = setup(text, filename, mimeType), tool = ref('document.read_utf8'); const output = executeBuiltinTool(tool, { file }, plan(tool), context);
    expect(output.text).toBe(text); expect(output.sources).toEqual([{ file, extractor: { id: 'builtin-utf8-verbatim', version: 1 }, textSha256: createHash('sha256').update(text).digest('hex'), location: { encoding: 'utf8', start: 0, end: Buffer.byteLength(text) } }]);
    expect(output).not.toHaveProperty('effects'); expect(output.data).toMatchObject({ tables: [], uncertainties: [], extraction: 'verbatim_utf8' });
  });
  it('rejects forged file metadata and a trusted callback accidentally substituting a different file', () => {
    const { file, context } = setup(), tool = ref('file.inspect');
    expect(() => executeBuiltinTool(tool, { file: { ...file, sha256: '0'.repeat(64) } }, plan(tool), context)).toThrow();
    expect(() => executeBuiltinTool(tool, { file }, plan(tool), { ...context, authorizeFile: () => ({ ...file, filename: 'other.txt' }) })).toThrow(expect.objectContaining({ code: 'BUILTIN_FILE_MISMATCH' }));
  });
  it('checks cancellation before authorization and time budget before releasing a result', () => {
    const { file, context } = setup(), tool = ref('document.read_utf8'); const controller = new AbortController(); controller.abort(new RunnerError('RUN_CANCELLED', 'test cancellation'));
    let reads = 0; expect(() => executeBuiltinTool(tool, { file }, plan(tool), { ...context, signal: controller.signal, authorizeFile: () => { reads++; return file; } })).toThrow(expect.objectContaining({ code: 'RUN_CANCELLED' })); expect(reads).toBe(0);
    let checks = 0; expect(() => executeBuiltinTool(tool, { file }, plan(tool), { ...context, checkpoint: () => { if (++checks === 3) throw new RunnerError('BUDGET_EXCEEDED', 'test deadline'); } })).toThrow(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
  });
  it.each([[Buffer.from('%PDF-1.7'), 'doc.pdf', 'application/pdf', 'DOCUMENT_FORMAT_UNSUPPORTED'], [Buffer.from([0xc3, 0x28]), 'doc.txt', 'text/plain', 'DOCUMENT_TEXT_ENCODING'], [Buffer.from('{"x":1,"x":2}'), 'doc.json', 'application/json', 'DOCUMENT_JSON_INVALID']])('does not pretend unsupported document bytes were extracted %#', (bytes, filename, mime, code) => {
    const { file, context } = setup(bytes as Uint8Array, filename as string, mime as string), tool = ref('document.read_utf8');
    expect(() => executeBuiltinTool(tool, { file }, plan(tool), context)).toThrow(expect.objectContaining({ code }));
  });
});
