import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Tooling modules are JavaScript entry points; dynamic URLs exercise their actual exported I/O contracts.
const prepareUrl = pathToFileURL(path.resolve('tooling/prepare-windows-wasmtime.mjs')).href;
const verifyUrl = pathToFileURL(path.resolve('tooling/verify-windows-wasmtime-sandbox.mjs')).href;
const { readBoundedOrdinaryFile, readBoundedHandle, WASMTIME_ARCHIVE_LIMIT } = await import(prepareUrl);
const { withVerificationReport, runtimeCopyPath, windowsSystemTools, assertNoWasmtimeProcesses } = await import(verifyUrl);
const made: string[] = [];
async function scratch() { const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-wasmtime-boundary-')); made.push(directory); return directory; }
afterEach(async () => { for (const directory of made.splice(0)) { const resolved = path.resolve(directory); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('studio-wasmtime-boundary-')) throw new Error('Unsafe scratch cleanup'); await fs.rm(resolved, { recursive: true, force: true }); } });

describe('bounded Wasmtime cache reads', () => {
  it('rejects a real oversized sparse cache before hashing or allocating its payload', async () => {
    const file = path.join(await scratch(), 'oversized.zip'); await fs.writeFile(file, '');
    if (process.platform === 'win32') { const { root } = await windowsSystemTools(); await promisify(execFile)(path.join(root, 'System32/fsutil.exe'), ['sparse', 'setflag', file], { windowsHide: true }); }
    await fs.truncate(file, 512 * 1024 * 1024);
    expect((await fs.stat(file)).size).toBe(512 * 1024 * 1024);
    await expect(readBoundedOrdinaryFile(file, WASMTIME_ARCHIVE_LIMIT)).rejects.toThrow(/byte limit/);
  });
  it('enforces exact extracted member size and preserves valid bytes', async () => {
    const file = path.join(await scratch(), 'member'); await fs.writeFile(file, 'original');
    expect(await readBoundedOrdinaryFile(file, 8, 8)).toEqual(Buffer.from('original'));
    await expect(readBoundedOrdinaryFile(file, 10, 7)).rejects.toThrow(/byte limit/);
  });
  it('rejects hard-linked cache files', async () => {
    const directory = await scratch(), file = path.join(directory, 'cache'), link = path.join(directory, 'other'); await fs.writeFile(file, 'data'); await fs.link(file, link);
    await expect(readBoundedOrdinaryFile(file, 100)).rejects.toThrow(/ordinary/);
  });
  it('rejects a junction/symlink ancestor before reading the target', async () => {
    const directory = await scratch(), target = path.join(directory, 'target'), link = path.join(directory, 'linked'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'cache'), 'data'); await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readBoundedOrdinaryFile(path.join(link, 'cache'), 100)).rejects.toThrow(/Linked/);
  });
  it.each([65537, 131073])('detects growth to %i bytes during actual FileHandle reads', async growth => {
    const file = path.join(await scratch(), 'growing'); await fs.writeFile(file, Buffer.alloc(65536, 7));
    const reader = await fs.open(file, 'r'), writer = await fs.open(file, 'r+'); let changed = false;
    try {
      // An actual second file handle grows the file after the first read, making the timing deterministic without a product test hook.
      const observed = { stat: () => reader.stat(), read: async (buffer: Buffer, offset: number, length: number, position: number) => { const result = await reader.read(buffer, offset, length, position); if (!changed) { changed = true; await writer.truncate(growth); } return result; } };
      await expect(readBoundedHandle(observed, 131072)).rejects.toThrow(growth > 131072 ? /grew beyond/ : /changed while/);
    } finally { await reader.close(); await writer.close(); }
  });
});

describe('fresh verification evidence and cleanup path boundaries', () => {
  it.each(['runtime', 'compiler'])('replaces stale success when initial %s validation fails', async phase => {
    const file = path.join(await scratch(), 'latest-verification.json'); await fs.writeFile(file, JSON.stringify({ status: 'confirmed', oldEvidence: 'must disappear' }));
    await expect(withVerificationReport(file, { tests: {} }, async (report: Record<string, unknown>) => {
      expect(JSON.parse(await fs.readFile(file, 'utf8')).status).toBe('in_progress');
      if (phase === 'compiler') report.runtime = { checked: true };
      throw new Error(`${phase} validation failed`);
    })).rejects.toThrow(`${phase} validation failed`);
    const current = JSON.parse(await fs.readFile(file, 'utf8')); expect(current).toMatchObject({ status: 'failed', productionReady: false, error: `${phase} validation failed` }); expect(current.oldEvidence).toBeUndefined(); expect(current.finishedAt).toBeTruthy();
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(file), `latest-verification.${current.verificationId}.json`), 'utf8'))).toEqual(current);
  });
  it('keeps successful partial evidence explicitly ineligible for production', async () => {
    const file = path.join(await scratch(), 'latest-verification.json'); await withVerificationReport(file, {}, async (report: Record<string, unknown>) => { report.status = 'partial'; });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ status: 'partial', productionReady: false });
  });
  it('accepts only an exact run UUID sibling and returns only its bin child', async () => {
    const directory = await scratch(), root = path.join(directory, `run-${'a'.repeat(32)}`); expect(runtimeCopyPath(root, directory)).toBe(path.join(root, 'bin'));
    for (const invalid of [directory, path.join(root, 'bin'), path.join(directory, 'run-bad'), path.join(path.dirname(directory), `run-${'a'.repeat(32)}`), 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) expect(() => runtimeCopyPath(invalid, directory)).toThrow();
  });
  it('refuses relative, UNC and inconsistent Windows roots before launching any tool', async () => {
    for (const environment of [{ SystemRoot: 'Windows' }, { SystemRoot: '\\\\server\\Windows' }, { SystemRoot: 'C:\\Windows', windir: 'D:\\Windows' }]) await expect(windowsSystemTools(environment)).rejects.toThrow(/Windows root/);
  });
  it.skipIf(process.platform !== 'win32')('checks the Windows reparse attribute before considering cleanup', async () => {
    const directory = await scratch(), target = path.join(directory, '한글 target'), link = path.join(directory, '한글 linked'); await fs.mkdir(target); await fs.symlink(target, link, 'junction');
    const { powershell } = await windowsSystemTools();
    await expect(assertNoWasmtimeProcesses(powershell, [target, link])).rejects.toThrow(/Reparse point/);
  });
});
