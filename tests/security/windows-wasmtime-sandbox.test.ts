import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { expect, it } from 'vitest';

/** Real OS/engine probes distinguish bounded guest execution from an unfinished production Worker. */
it.skipIf(process.platform !== 'win32')('executes Wasmtime under zero-capability LPAC and preserves incomplete release gates', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('tooling/verify-windows-wasmtime-sandbox.mjs')], { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ status: 'partial', productionReady: false, wasmtimeCompatibility: 'confirmed', accessBoundaryStatus: 'confirmed', networkBoundaryStatus: 'unverified', boundedStdioStatus: 'confirmed' });
  expect(report.runtime).toMatchObject({ version: '50.0.0', sha256: 'cea9ccc700aaccb2b5507e96ac990ba60104bd7ab39284fb2e67cb64d58efcc4' });
  for (const name of ['startup', 'access', 'memory', 'fuel', 'unknownImport', 'socketDescriptor']) {
    expect(report.tests[name].host).toMatchObject({ appContainer: true, lpacOptOut: true, capabilities: [], networkCapabilityCount: 0, profileDeleted: true, activeProcessLimit: 1 });
  }
  expect(report.tests.access.errnosAndCounts).toEqual([0, 0, 13, 2, 0, 0, 14, 63, 63, 63, 0, 0, 0, 2, 63]);
  expect(Buffer.from(report.tests.access.stdout, 'base64').subarray(60).toString('utf8')).toBe('sandbox input');
  expect(report.tests.memory.host.exitCode).toBe(0);
  expect(report.tests.fuel.host).toMatchObject({ exitCode: 3, timedOut: false });
  expect(report.tests.fuel.stderr).toContain('all fuel consumed');
  expect(report.tests.unknownImport.stderr).toContain('env::spawn');
  for (const name of ['junction', 'hardlink', 'diagnostic']) expect(report.tests[name].rejected).toBe(true);
  expect(report.tests.stdio.host).toMatchObject({ boundedStdio: true, outputLimitExceeded: false, exitCode: 0 });
  expect(Buffer.from(report.tests.stdio.stdout, 'base64').toString('utf8')).toBe('{"value":42}');
  for (const name of ['stdoutLimit', 'stderrLimit']) expect(report.tests[name].host).toMatchObject({ outputLimitExceeded: true, jobClosedOnOutputLimit: true, timedOut: false });
  expect(report.tests.stdoutLimit.stdoutBytes).toBe(1024 * 1024);
  expect(report.tests.stderrLimit.stderrBytes).toBe(64 * 1024);
  expect(report.tests.stdinLimit.rejected).toBe(true);
  expect(report.tests.stdioWallTime.host).toMatchObject({ jobClosedOnTimeout: true, timedOut: true, outputLimitExceeded: false });
  expect(report.tests.stdioWallTime.outputGuard).toMatchObject({ comparisonWriteSucceeded: true, renameDenied: expect.stringMatching(/^(EBUSY|EACCES|EPERM)$/), writeDenied: expect.stringMatching(/^(EBUSY|EACCES|EPERM)$/) });
  expect(report.retention.removedDirectories).toBe(Object.keys(report.tests).length);
  // Evidence survives successful runtime-copy cleanup; only the verified duplicate bin subtree is removed.
  for (const value of Object.values(report.tests) as { root: string }[]) { await expect(fs.stat(path.join(value.root, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' }); expect((await fs.stat(path.join(value.root, 'input'))).isDirectory()).toBe(true); expect((await fs.stat(path.join(value.root, 'output'))).isDirectory()).toBe(true); }
}, 100000);
