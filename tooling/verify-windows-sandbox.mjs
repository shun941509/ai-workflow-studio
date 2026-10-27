// Real Windows integration verification, never a product worker or an advertised execution capability.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compileWindowsProbe } from './windows-probe-build.mjs';

const execute = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.tools', 'windows-sandbox');
const host = path.join(base, 'SandboxHost.exe');
const diagnosticHost = path.join(base, 'SandboxHost.Diagnostics.exe');
const fixedNode = process.execPath; // verifyWindowsSandbox rejects any version except the pinned Node 24.22.1.
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function check(value, message) { if (!value) throw new Error(message); }

/** Every modified DACL belongs to a fresh direct child of this dedicated verifier directory. */
async function stage(mode, port = 0) {
  const root = path.join(base, `run-${crypto.randomUUID().replaceAll('-', '')}`);
  await fs.mkdir(root);
  for (const directory of ['bin', 'input', 'output', 'outside', 'aap-canary']) await fs.mkdir(path.join(root, directory));
  await fs.copyFile(fixedNode, path.join(root, 'bin', 'node.exe'));
  await fs.copyFile(path.join(base, 'native-probe.exe'), path.join(root, 'bin', 'native-probe.exe'));
  await fs.copyFile(path.join(workspace, 'tests', 'security', 'windows-sandbox.worker.mjs'), path.join(root, 'input', 'worker.mjs'));
  await fs.writeFile(path.join(root, 'input', 'request.json'), JSON.stringify({ mode, port }));
  await fs.writeFile(path.join(root, 'input', 'native-mode.txt'), `${mode} ${port}`);
  await fs.writeFile(path.join(root, 'input', 'allowed.txt'), 'sandbox input');
  await fs.writeFile(path.join(root, 'outside', 'private.txt'), 'disposable outside sentinel');
  await fs.writeFile(path.join(root, 'aap-canary', 'readable-by-appcontainers.txt'), 'AAP grant must not grant LPAC access');
  return root;
}

async function launch(root, { wall = 6000, memory = 256, cpu = 3000, profile = 'native-probe', diagnostic = false } = {}) {
  // Argument array and windowsHide avoid shell parsing and visible helper windows; no key is passed.
  const { stdout, stderr } = await execute(diagnostic ? diagnosticHost : host, [root, String(wall), String(memory), String(cpu), profile, diagnostic ? 'registry-read-diagnostic' : 'none'], { windowsHide: true, timeout: 35000, maxBuffer: 1024 * 1024 });
  check(!stderr.trim(), `Unexpected helper diagnostic: ${stderr}`);
  const hostResult = JSON.parse(stdout.trim());
  let worker = null;
  try { worker = JSON.parse(await fs.readFile(path.join(root, 'output', 'worker-report.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stderrExcerpt = (await fs.readFile(path.join(root, 'output', 'stderr.txt'), 'utf8')).slice(0, 4096);
  return { host: hostResult, worker, stderrExcerpt, root };
}

/** Verify actual denials, not merely launch flags, PIDs, or a parent-side timeout. */
export async function verifyWindowsSandbox() {
  check(process.platform === 'win32', 'Windows verification is required; this is not a passing cross-platform substitute');
  check(process.versions.node === '24.22.1', 'Use the pinned Node 24.22.1 verifier');
  await fs.mkdir(base, { recursive: true });
  await execute(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${host}`, path.join(workspace, 'native', 'windows-sandbox', 'SandboxHost.cs')], { windowsHide: true });
  await execute(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:STUDIO_SANDBOX_DIAGNOSTICS', `/out:${diagnosticHost}`, path.join(workspace, 'native', 'windows-sandbox', 'SandboxHost.cs')], { windowsHide: true });
  // The adversarial probe has no CRT/USER32 dependency, separating OS policy checks from Node loader compatibility.
  const buildTools = await compileWindowsProbe({ source: path.join(workspace, 'tests', 'security', 'windows-sandbox.probe.c'), object: path.join(base, 'native-probe.obj'), output: path.join(base, 'native-probe.exe'), libraries: ['kernel32.lib', 'ws2_32.lib', 'advapi32.lib'] });
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('local verifier canary'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const report = { status: 'failed', productionReady: false, verifiedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(), node: process.version, buildTools, tests: {}, nativeSourceSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(workspace, 'native', 'windows-sandbox', 'SandboxHost.cs'))).digest('hex') };
  try {
    const port = server.address().port;
    // A successful unsandboxed connection proves the canary exists; timeout/refusal is not accepted as isolation evidence.
    await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
    const node = await launch(await stage('normal', port), { profile: 'node' });
    report.nodeCompatibility = { status: node.host.exitCode === 0 && node.worker ? 'confirmed' : 'failed', ...node };
    const nodeDiagnostic = await launch(await stage('normal', port), { profile: 'node', diagnostic: true });
    report.nodeRegistryReadDiagnostic = { status: nodeDiagnostic.host.exitCode === 0 && nodeDiagnostic.worker ? 'confirmed' : 'failed', ...nodeDiagnostic };
    const deniedDiagnostic = await stage('normal', port);
    try { await execute(host, [deniedDiagnostic, '6000', '256', '3000', 'native-probe', 'registry-read-diagnostic'], { windowsHide: true }); throw new Error('Normal binary admitted diagnostic capability'); }
    catch (error) { check(String(error.stderr).includes('Diagnostic capability is absent'), 'Expected production-binary diagnostic rejection'); }
    report.tests.diagnosticCompileBoundary = { rejected: true };
    const normal = await launch(await stage('normal', port)); report.tests.access = normal;
    check(normal.host.exitCode === 0 && normal.worker, 'Native worker did not start successfully inside LPAC');
    check(normal.worker.input === 0, 'Allowlisted read failed');
    check(normal.worker.output === 0 && await fs.readFile(path.join(normal.root, 'output', 'allowed.txt'), 'utf8') === 'sandbox output', 'Allowlisted write failed');
    for (const key of ['inputWrite', 'outsideRead', 'outsideWrite', 'allAppPackagesRead', 'child']) {
      const result = normal.worker[key];
      check([5, 367, 1260].includes(result), `Missing explicit OS access denial for ${key}: ${JSON.stringify(result)}`);
    }
    check(await fs.readFile(path.join(normal.root, 'outside', 'private.txt'), 'utf8') === 'disposable outside sentinel', 'Outside file changed');
    const network = await launch(await stage('normal', port), { diagnostic: true }); report.tests.networkDiagnostic = network;
    check(network.host.exitCode === 0 && network.worker?.network === 10013, 'Explicit loopback WSAEACCES denial not observed');
    check(network.worker.outsideRead === 5 && network.worker.outsideWrite === 5 && network.worker.allAppPackagesRead === 5, 'Registry diagnostic broadened file access');
    const timeout = await launch(await stage('timeout'), { wall: 500 }); report.tests.wallTime = timeout;
    check(timeout.worker?.started && !timeout.worker.escapedTimeout && timeout.host.timedOut && timeout.host.jobClosedOnTimeout && timeout.host.elapsedMs < 10000, 'Wall-time job-close termination was not observed');
    const cpu = await launch(await stage('cpu'), { wall: 20000, cpu: 200 }); report.tests.cpuTime = cpu;
    check(cpu.worker?.started && !cpu.host.timedOut && cpu.host.exitCode === 0xc0000044, 'Kernel CPU-time quota termination was not observed');
    const memory = await launch(await stage('memory'), { wall: 6000, memory: 128 }); report.tests.memory = memory;
    check(memory.worker && !memory.worker.escapedMemoryLimit && !memory.host.timedOut && (memory.worker.memoryDenied || memory.host.exitCode !== 0), 'Memory limit was not observed');
    check(memory.host.peakJobMemoryBytes <= 128 * 1024 * 1024, 'Job memory exceeded its limit');
    // Junction rejection uses only a new canary directory inside the same disposable task.
    const linked = await stage('normal', port);
    await fs.symlink(path.join(linked, 'outside'), path.join(linked, 'input', 'junction'), 'junction');
    try { await launch(linked); throw new Error('Junction unexpectedly accepted'); }
    catch (error) { check(String(error.stderr).includes('Reparse point'), 'Expected pre-launch junction rejection'); }
    report.tests.junction = { rejected: true, root: linked };
    const hardLinked = await stage('normal', port);
    await fs.link(path.join(hardLinked, 'outside', 'private.txt'), path.join(hardLinked, 'input', 'hardlink.txt'));
    try { await launch(hardLinked); throw new Error('Hard link unexpectedly accepted'); }
    catch (error) { check(String(error.stderr).includes('Hard-linked'), 'Expected pre-launch hard-link rejection'); }
    report.tests.hardlink = { rejected: true, root: hardLinked };
    report.nativeBoundaryStatus = 'confirmed';
    report.status = report.nodeCompatibility.status === 'confirmed' ? 'confirmed' : 'partial';
  } catch (error) {
    report.error = error.message;
    throw Object.assign(error, { verification: report });
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Preserve test evidence; no recursive deletion or permission changes outside fresh task folders.
    await fs.writeFile(path.join(base, 'latest-verification.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await verifyWindowsSandbox(); console.log(JSON.stringify(report, null, 2)); if (process.argv.includes('--require-node') && report.nodeCompatibility.status !== 'confirmed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify(error.verification ?? { status: 'failed', error: error.message, diagnostic: error.stdout ?? error.stderr }, null, 2)); process.exitCode = 1; }
}

