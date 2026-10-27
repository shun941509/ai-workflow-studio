import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

/** Real Windows integration checks only; a non-Windows skip is explicitly not release evidence. */
it.skipIf(process.platform !== 'win32')('enforces native LPAC boundaries and records Node compatibility separately', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('tooling/verify-windows-sandbox.mjs')], { windowsHide: true, timeout: 110000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  expect(report.nativeBoundaryStatus).toBe('confirmed');
  expect(report.productionReady).toBe(false);
  expect(report.tests.access.worker).toMatchObject({ input: 0, output: 0, inputWrite: 5, outsideRead: 5, outsideWrite: 5, allAppPackagesRead: 5, child: 367 });
  expect(report.tests.networkDiagnostic.worker.network).toBe(10013);
  expect(report.tests.networkDiagnostic.host.capabilities).toEqual(['registryRead']);
  expect(report.tests.access.host.capabilities).toEqual([]);
  expect(report.tests.wallTime.host.jobClosedOnTimeout).toBe(true);
  expect(report.tests.cpuTime.host.exitCode).toBe(0xc0000044);
  expect(report.tests.memory.worker.memoryDenied).toBe(true);
  expect(report.tests.memory.host.peakJobMemoryBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  expect(report.tests.junction.rejected).toBe(true);
  expect(report.tests.hardlink.rejected).toBe(true);
  expect(report.tests.diagnosticCompileBoundary.rejected).toBe(true);
  for (const check of Object.values(report.tests) as { host?: { profileDeleted: boolean } }[]) if (check.host) expect(check.host.profileDeleted).toBe(true);
  // The diagnostic Node process may work, but cannot satisfy the zero-capability production gate.
  expect(['partial', 'confirmed']).toContain(report.status);
  if (report.nodeCompatibility.status === 'failed') expect(report.status).toBe('partial');
}, 120000);
