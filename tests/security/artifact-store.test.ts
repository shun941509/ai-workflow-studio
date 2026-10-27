import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, linkSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../apps/runner/src/artifacts/store.js';
import { createNode, type WorkflowNode } from '@studio/spec';
import { executeManagedFileInput, executeManagedFileOutput } from '../../apps/runner/src/artifacts/file-handlers.js';

const roots: string[] = [];
function setup(limits: ConstructorParameters<typeof ArtifactStore>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-artifact-test-')); roots.push(root);
  return { root, store: new ArtifactStore(join(root, 'managed'), limits) };
}
const input = (text = '실제 저장되는 한글 결과') => ({ operationId: 'export_1', filename: '결과 보고서.txt', mimeType: 'text/plain', bytes: Buffer.from(text) });
function physical(root: string, id: string) {
  const run = readdirSync(join(root, 'managed')).find(name => name.startsWith('run_'))!;
  return join(root, 'managed', run, id);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only directories returned by mkdtemp inside the OS temp directory are removed.
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('studio-artifact-test-')) throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

/** File handlers serialize real managed output; unsupported converters cannot report pretend artifacts. */
describe('builtin managed file handlers', () => {
  function output(format: Extract<WorkflowNode, { type: 'file_output' }>['config']['format'], filename: string) {
    const node = createNode('file_output') as Extract<WorkflowNode, { type: 'file_output' }>;
    node.config = { format, filename, outputDirectory: 'outputs' }; return node;
  }
  it.each([
    ['text', '결과.txt', '한글 그대로', '한글 그대로'],
    ['markdown', '결과.md', '# 보고서\n\n본문', '# 보고서\n\n본문'],
    ['json', '결과.json', { count: 0, ready: false, missing: null }, '{\n  "count": 0,\n  "ready": false,\n  "missing": null\n}\n'],
  ] as const)('creates actual %s bytes and exposes the same validated FileRef', (format, filename, content, expected) => {
    const { store } = setup(); const result = executeManagedFileOutput(output(format, filename), { content }, { store, runId: 'run_a', operationId: 'output_1' });
    const reference = store.resolve('run_a', result.data);
    expect(result.files).toEqual([reference]); expect(Buffer.from(store.read('run_a', reference.id).bytes).toString()).toBe(expected);
  });
  it('creates rectangular CSV with correct quote/comma/newline escapes and explicit scalar types', () => {
    const { store } = setup(); const content = { columns: ['이름', '수량', '비고'], rows: [{ 이름: '민수, 고객', 수량: -12, 비고: '"인용"\n다음 줄' }] };
    const result = executeManagedFileOutput(output('csv', '자료.csv'), { content }, { store, runId: 'run_a', operationId: 'csv_1' });
    const text = Buffer.from(store.read('run_a', result.files![0]!.id).bytes).toString();
    expect(text).toBe('\uFEFF"이름","수량","비고"\r\n"민수, 고객","-12","""인용""\n다음 줄"\r\n');
  });
  it.each(['=HYPERLINK("https://invalid.example")', ' @SUM(1)', '＝1+1', '\tvalue', '\nvalue', '+1', '-1'])('rejects spreadsheet-active string %s without modifying its meaning', value => {
    const { root, store } = setup();
    expect(() => executeManagedFileOutput(output('csv', '자료.csv'), { content: { columns: ['value'], rows: [{ value }] } }, { store, runId: 'run_a', operationId: 'csv_1' })).toThrow(/수식/);
    expect(readdirSync(join(root, 'managed'))).toEqual([]);
  });
  it('does not fabricate PDF, allow arbitrary output paths, or disguise formats', () => {
    const { store } = setup(); const context = { store, runId: 'run_a', operationId: 'output_1' };
    expect(() => executeManagedFileOutput(output('pdf', '결과.pdf'), { content: 'text' }, context)).toThrow(/변환/);
    expect(() => executeManagedFileOutput(output('text', '결과.cmd'), { content: 'text' }, context)).toThrow(/확장자/);
    const external = output('text', '결과.txt'); external.config.outputDirectory = '../outside';
    expect(() => executeManagedFileOutput(external, { content: 'text' }, context)).toThrow(/저장 위치/);
  });
  it('copies verified bytes and validates selected files against the current run and filters', () => {
    const { store } = setup(); const original = store.put('run_a', input('원본'));
    const result = executeManagedFileOutput(output('copy', '복사.txt'), { file: original }, { store, runId: 'run_a', operationId: 'copy_1' });
    expect(result.files![0]!.sha256).toBe(original.sha256); expect(result.files![0]!.id).not.toBe(original.id);
    const node = createNode('file_input') as Extract<WorkflowNode, { type: 'file_input' }>;
    expect(executeManagedFileInput(node, { files: [original] }, { store, runId: 'run_a' }).data).toEqual([original]);
    expect(() => executeManagedFileInput(node, { files: [original, original] }, { store, runId: 'run_a' })).toThrow(/중복/);
    expect(() => executeManagedFileInput(node, { files: [original] }, { store, runId: 'run_b' })).toThrow();
    node.config.mimeTypes = ['application/pdf'];
    expect(() => executeManagedFileInput(node, { files: [original] }, { store, runId: 'run_a' })).toThrow(/허용 형식/);
  });
});

/** These tests use real files and hard links; a forged object is never treated as authorization. */
describe('managed run artifacts', () => {
  it('preserves exact bytes and stable identity across retries and reopening', () => {
    const { root, store } = setup(); const source = input();
    const reference = store.put('run_a', source);
    expect(store.put('run_a', source)).toEqual(reference);
    source.bytes.fill(0);
    const reopened = new ArtifactStore(join(root, 'managed'));
    expect(Buffer.from(reopened.read('run_a', reference.id).bytes).toString('utf8')).toBe('실제 저장되는 한글 결과');
    expect(reopened.resolve('run_a', reference)).toEqual(reference);
    expect(reference.relativePath).toBe(`artifacts/${reference.id}/결과 보고서.txt`);
  });
  it('accepts an empty file without treating it as absent', () => {
    const { store } = setup(); const reference = store.put('run_a', input(''));
    expect(reference.bytes).toBe(0); expect(store.read('run_a', reference.id).bytes).toHaveLength(0);
  });
  it('denies another run even when its ID and the exact metadata are known', () => {
    const { store } = setup(); const reference = store.put('run_a', input());
    store.put('run_b', input('별도 결과'));
    expect(() => store.read('run_b', reference.id)).toThrow();
    expect(() => store.resolve('run_b', reference)).toThrow();
    expect(() => store.read('../run_a', reference.id)).toThrow();
  });
  it('rejects conflicts without overwriting the original', () => {
    const { store } = setup(); const ref = store.put('run_a', input('원본'));
    expect(() => store.put('run_a', input('다른 값'))).toThrow(/다른 내용/);
    expect(Buffer.from(store.read('run_a', ref.id).bytes).toString()).toBe('원본');
  });
  it.each(['../outside.txt', 'C:secret.txt', 'sub/file.txt', 'sub\\file.txt', 'NUL.txt', 'COM¹.log', 'CONIN$.txt', 'trailing.', 'x.txt ', 'decomposed-e\u0301.txt'])('rejects unsafe display name %s before creating files', name => {
    const { root, store } = setup(); expect(() => store.put('run_a', { ...input(), filename: name })).toThrow();
    expect(readdirSync(join(root, 'managed'))).toEqual([]);
  });
  it('rejects a forged path, MIME, extra properties and malformed identifiers', () => {
    const { store } = setup(); const reference = store.put('run_a', input());
    for (const forged of [{ ...reference, relativePath: '../secret' }, { ...reference, mimeType: 'text/html' }, { ...reference, url: 'file:///secret' }, { ...reference, id: '../outside' }]) expect(() => store.resolve('run_a', forged)).toThrow();
    expect(() => store.put('run_a', { ...input(), mimeType: 'text/plain\r\nX-Test: injected' })).toThrow();
  });
  it('enforces per-file bytes, total bytes, file count and idempotent quota accounting', () => {
    const { store } = setup({ maxBytesPerFile: 4, maxBytesPerRun: 6, maxFilesPerRun: 2 });
    const first = store.put('run_a', input('1234'));
    expect(store.put('run_a', input('1234'))).toEqual(first);
    expect(() => store.put('run_a', { ...input('12345'), operationId: 'second' })).toThrow(/크기/);
    expect(() => store.put('run_a', { ...input('123'), operationId: 'second' })).toThrow(/전체 크기/);
    store.put('run_a', { ...input('12'), operationId: 'second' });
    expect(() => store.put('run_a', { ...input(''), operationId: 'third' })).toThrow(/개수/);
  });
  it('detects original-byte mutation even when the byte length is unchanged', () => {
    const { root, store } = setup(); const ref = store.put('run_a', input('original'));
    writeFileSync(join(physical(root, ref.id), 'data'), 'modified');
    expect(() => store.read('run_a', ref.id)).toThrow(/원본/);
  });
  it('rejects descriptor substitution, unlisted files and non-unique hardlinked bytes', () => {
    const { root, store } = setup(); const ref = store.put('run_a', input()); const path = physical(root, ref.id);
    const original = readFileSync(join(path, 'record.json'));
    const changed = JSON.parse(original.toString()); changed.reference.relativePath = '../outside';
    writeFileSync(join(path, 'record.json'), JSON.stringify(changed));
    expect(() => store.read('run_a', ref.id)).toThrow(/고정 정보/);
    writeFileSync(join(path, 'record.json'), original);
    linkSync(join(path, 'data'), join(root, 'outside-link'));
    expect(() => store.read('run_a', ref.id)).toThrow(/연결/);
    writeFileSync(join(path, 'extra'), 'unlisted');
    expect(() => store.read('run_a', ref.id)).toThrow(/구성 목록/);
  });
  it('rejects a junction or symbolic link at the store root', () => {
    const { root } = setup(); mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new ArtifactStore(join(root, 'linked'))).toThrow(/링크/);
  });
  it('ignores incomplete crash staging as a result and never overwrites it', () => {
    const { root, store } = setup(); const first = store.put('run_a', input());
    const runDirectory = join(physical(root, first.id), '..'); const stage = join(runDirectory, '.pending-interrupted');
    mkdirSync(stage); writeFileSync(join(stage, 'data'), 'incomplete');
    const second = store.put('run_a', { ...input('완료'), operationId: 'second' });
    expect(store.read('run_a', second.id).reference).toEqual(second);
    expect(readFileSync(join(stage, 'data'), 'utf8')).toBe('incomplete');
  });
});
