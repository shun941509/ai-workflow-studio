import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

/** A recorded startup failure must never be promoted into verified Python worker support. */
it.skipIf(process.platform !== 'win32')('records real embedded Python LPAC startup and keeps failed proof gates closed', async () => {
  let report: any;
  let verifierExitedSuccessfully = false;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('tooling/verify-windows-python-sandbox.mjs')], { windowsHide: true, timeout: 110000, maxBuffer: 1024 * 1024 });
    report = JSON.parse(stdout);
    verifierExitedSuccessfully = true;
  } catch (error) {
    // Only a structured experiment result is accepted. Compiler, missing-runtime, or tool errors fail.
    const failure = error as { stderr?: string };
    report = JSON.parse(failure.stderr ?? '');
  }
  expect(report.productionReady).toBe(false);
  expect(report.runtime).toMatchObject({ version: '3.14.10', sha256: '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159' });
  expect(report.tests.access.host).toMatchObject({ appContainer: true, lpacOptOut: true, capabilities: [], networkCapabilityCount: 0, profileDeleted: true });
  if (report.pythonCompatibility === 'failed') {
    expect(verifierExitedSuccessfully).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.tests.access.host.exitCode).toBe(0xc0000022);
    expect(report.tests.access.worker).toBeNull();
    expect(report.tests.loader.host).toMatchObject({ exitCode: 0, capabilities: [], profileDeleted: true });
    expect(report.tests.loader.worker).toMatchObject({ pythonDllRead: 0, pythonImageMap: 0, crtLoad: 0, versionLoad: 0, winsockLoad: 0, bcryptLoad: 0, ucrtLoad: 0, pythonDllLoad: 5 });
    expect(report.accessBoundaryStatus).not.toBe('confirmed');
    expect(report.networkBoundaryStatus).not.toBe('confirmed');
  } else {
    // This branch is a real success path for a future compatible OS/runtime, not a test substitute.
    expect(verifierExitedSuccessfully).toBe(true);
    expect(report.pythonCompatibility).toBe('confirmed');
    expect(report.accessBoundaryStatus).toBe('confirmed');
    expect(report.tests.access.worker.input).toMatchObject({ allowed: true, value: 'python sandbox input' });
    for (const name of ['inputWrite', 'outsideRead', 'outsideWrite', 'allAppPackagesRead', 'child']) expect(report.tests.access.worker[name].allowed).toBe(false);
    expect(report.tests.wallTime.host.jobClosedOnTimeout).toBe(true);
    expect(report.tests.cpuTime.host.exitCode).toBe(0xc0000044);
    expect(report.tests.memory.worker.memoryDenied).toBe(true);
    expect(report.tests.junction.rejected).toBe(true);
    expect(report.tests.hardlink.rejected).toBe(true);
    expect(report.tests.diagnosticRejected.rejected).toBe(true);
  }
}, 120000);
