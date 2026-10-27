// Experimental zero-capability Python LPAC verification. This never advertises a Runner worker.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyPythonRuntime, pythonRuntimeDirectory, PYTHON_EMBED } from './prepare-windows-python.mjs';
import { compileWindowsProbe } from './windows-probe-build.mjs';

const execute = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.tools', 'windows-python-sandbox');
const host = path.join(base, 'SandboxHost.Python.exe');
const source = path.join(workspace, 'native', 'windows-sandbox', 'SandboxHost.cs');
const probe = path.join(workspace, 'tests', 'security', 'windows-python-sandbox.worker.py');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };

/** Fresh sibling task roots isolate every ACL mutation; original distribution files are copied. */
async function stage(mode, port = 0) {
  const root = path.join(base, `run-${crypto.randomUUID().replaceAll('-', '')}`);
  await fs.mkdir(root);
  for (const name of ['bin', 'input', 'output', 'outside', 'aap-canary']) await fs.mkdir(path.join(root, name));
  for (const name of await fs.readdir(pythonRuntimeDirectory)) await fs.copyFile(path.join(pythonRuntimeDirectory, name), path.join(root, 'bin', name), fs.constants.COPYFILE_EXCL);
  await fs.copyFile(probe, path.join(root, 'input', 'worker.py'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, 'input', 'request.json'), JSON.stringify({ mode, port }), { flag: 'wx' });
  await fs.writeFile(path.join(root, 'input', 'allowed.txt'), 'python sandbox input', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'outside', 'private.txt'), 'disposable Python outside sentinel', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'aap-canary', 'readable-by-appcontainers.txt'), 'AAP must not grant LPAC access', { flag: 'wx' });
  return root;
}

/** Numeric policy and fixed profile only. Stderr/report bytes remain evidence, not executable input. */
async function launch(root, { wall = 6000, memory = 128, cpu = 3000, profile = 'python-embed' } = {}) {
  const { stdout, stderr } = await execute(host, [root, String(wall), String(memory), String(cpu), profile, 'none'], {
    windowsHide: true, timeout: 35000, maxBuffer: 1024 * 1024,
    env: { ...process.env, STUDIO_SANDBOX_TEST_CANARY: 'internal-non-secret-must-not-inherit' },
  });
  check(!stderr.trim(), `Unexpected helper stderr: ${stderr}`);
  const observed = JSON.parse(stdout);
  let worker = null;
  try { worker = JSON.parse(await fs.readFile(path.join(root, 'output', 'worker-report.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { host: observed, worker, stderrExcerpt: (await fs.readFile(path.join(root, 'output', 'stderr.txt'), 'utf8')).slice(0, 4096), root };
}

/** Real OS errors, fresh canaries, byte verification and kernel job limits establish each claim. */
export async function verifyWindowsPythonSandbox() {
  check(process.platform === 'win32' && process.arch === 'x64', 'This verification requires Windows x64');
  const runtime = await verifyPythonRuntime(); // Preparation/download is a separate explicit step.
  await fs.mkdir(base, { recursive: true });
  await execute(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${host}`, source], { windowsHide: true });
  const report = {
    status: 'failed', productionReady: false, verifiedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(),
    runtime, nativeSourceSha256: hash(await fs.readFile(source)), probeSha256: hash(await fs.readFile(probe)), tests: {},
    limitation: 'Only this machine and the explicit probes are verified; no Runner policy, deployment, or complete OS attack-surface claim.',
  };
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('live local canary'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
    report.canaryReachableFromParent = true;
    const access = await launch(await stage('normal', port)); report.tests.access = access;
    report.pythonCompatibility = access.host.exitCode === 0 && access.worker?.python === PYTHON_EMBED.version ? 'confirmed' : 'failed';
    if (report.pythonCompatibility === 'failed') {
      // Separate fixed native diagnosis preserves the Python failure and adds no OS capability.
      const loader = path.join(base, 'python-loader-probe.exe');
      report.buildTools = await compileWindowsProbe({ source: path.join(workspace, 'tests', 'security', 'windows-python-loader.probe.c'), object: path.join(base, 'python-loader-probe.obj'), output: loader, libraries: ['kernel32.lib'] });
      const diagnostic = await stage('normal');
      await fs.copyFile(loader, path.join(diagnostic, 'bin', 'native-probe.exe'));
      await fs.writeFile(path.join(diagnostic, 'input', 'native-mode.txt'), 'loader');
      report.tests.loader = await launch(diagnostic, { profile: 'native-probe' });
    }
    check(report.pythonCompatibility === 'confirmed', 'Embedded Python did not execute the probe in zero-capability LPAC');
    check(access.host.appContainer && access.host.lpacOptOut && access.host.capabilities.length === 0 && access.host.networkCapabilityCount === 0, 'Required zero-capability LPAC policy was not observed');
    check(access.worker.input.allowed && access.worker.input.value === 'python sandbox input', 'Allowlisted Python read failed');
    check(access.worker.output.allowed && await fs.readFile(path.join(access.root, 'output', 'allowed.txt'), 'utf8') === 'python sandbox output', 'Allowlisted Python write failed');
    for (const key of ['inputWrite', 'outsideRead', 'outsideWrite', 'allAppPackagesRead', 'child']) {
      const value = access.worker[key];
      check(!value.allowed && [5, 367, 1260].includes(value.winerror), `Missing explicit OS denial for ${key}: ${JSON.stringify(value)}`);
    }
    check(await fs.readFile(path.join(access.root, 'input', 'allowed.txt'), 'utf8') === 'python sandbox input', 'Input changed');
    check(await fs.readFile(path.join(access.root, 'outside', 'private.txt'), 'utf8') === 'disposable Python outside sentinel', 'Outside sentinel changed');
    check(!access.worker.envKeys.includes('STUDIO_SANDBOX_TEST_CANARY'), 'Parent environment leaked');
    check(access.worker.isolated === 1 && access.worker.ignoreEnvironment === 1 && access.worker.noSite === 1 && access.worker.safePath === true, 'Python isolation flags differ');
    check(access.worker.searchPaths.every(value => value === path.join(access.root, 'bin') || value === path.join(access.root, 'bin', 'python314.zip')), 'Python import path escaped its staged runtime');
    report.accessBoundaryStatus = 'confirmed';
    // A failed socket import can explain compatibility but cannot prove a successful connect denial.
    report.networkBoundaryStatus = access.worker.networkStartup.allowed && access.worker.networkConnect.allowed === false && access.worker.networkConnect.winerror === 10013 ? 'confirmed' : 'unverified';
    check(access.worker.networkConnect.allowed !== true, 'Unexpected network access');
    const timeout = await launch(await stage('timeout'), { wall: 500 }); report.tests.wallTime = timeout;
    check(timeout.worker?.started && timeout.host.timedOut && timeout.host.jobClosedOnTimeout && !timeout.worker.escapedTimeout, 'Python wall-time job-close termination not observed');
    const cpu = await launch(await stage('cpu'), { wall: 20000, cpu: 200 }); report.tests.cpuTime = cpu;
    check(cpu.worker?.started && !cpu.host.timedOut && cpu.host.exitCode === 0xc0000044, 'Python CPU quota termination not observed');
    const memory = await launch(await stage('memory'), { memory: 64 }); report.tests.memory = memory;
    check(memory.worker?.memoryDenied && !memory.worker.escapedMemoryLimit && !memory.host.timedOut && memory.host.peakJobMemoryBytes <= 64 * 1024 * 1024, 'Python memory quota not observed');
    const linked = await stage('normal');
    await fs.symlink(path.join(linked, 'outside'), path.join(linked, 'input', 'junction'), 'junction');
    try { await launch(linked); throw new Error('Junction accepted'); }
    catch (error) { check(String(error.stderr).includes('Reparse point'), 'Expected junction rejection before launch'); }
    report.tests.junction = { rejected: true, root: linked };
    const hardlinked = await stage('normal');
    await fs.link(path.join(hardlinked, 'outside', 'private.txt'), path.join(hardlinked, 'input', 'hardlink.txt'));
    try { await launch(hardlinked); throw new Error('Hard link accepted'); }
    catch (error) { check(String(error.stderr).includes('Hard-linked'), 'Expected hard-link rejection before launch'); }
    report.tests.hardlink = { rejected: true, root: hardlinked };
    // Python's fixed profile rejects diagnostic capabilities even if a diagnostic binary is built later.
    const invalid = await stage('normal');
    try { await execute(host, [invalid, '6000', '128', '3000', 'python-embed', 'registry-read-diagnostic'], { windowsHide: true }); throw new Error('Python admitted registry capability'); }
    catch (error) { check(String(error.stderr).includes('Python embedded profile requires zero capabilities'), 'Expected Python diagnostic rejection'); }
    report.tests.diagnosticRejected = { rejected: true, root: invalid };
    report.status = report.networkBoundaryStatus === 'confirmed' ? 'confirmed' : 'partial';
  } catch (error) {
    report.error = error.message;
    if (error.stdout || error.stderr) report.diagnostic = String(error.stdout || error.stderr).slice(0, 4096);
    throw Object.assign(error, { verification: report });
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Preserve raw observations and fresh task roots. No recursive deletion or global ACL mutation.
    await fs.writeFile(path.join(base, 'latest-verification.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyWindowsPythonSandbox(), null, 2)); }
  catch (error) { console.error(JSON.stringify(error.verification ?? { status: 'failed', error: error.message, diagnostic: error.stderr ?? error.stdout }, null, 2)); process.exitCode = 1; }
}
