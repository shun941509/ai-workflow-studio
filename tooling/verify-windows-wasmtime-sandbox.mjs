// Experimental fixed Wasmtime profile. The report never registers production Worker support.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWasmtimeRuntime, wasmtimeRuntimeDirectory, wasmtimeRuntimeInventory, ordinaryAncestors, readBoundedOrdinaryFile } from './prepare-windows-wasmtime.mjs';

const execute = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.tools', 'windows-wasmtime-sandbox');
const host = path.join(base, 'SandboxHost.Wasmtime.exe');
const source = path.join(workspace, 'native/windows-sandbox/SandboxHost.cs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };

/** Resolve installed OS tools from a consistent local Windows root, never PATH or a supplied executable. */
export async function windowsSystemTools(environment = process.env) {
  const root = environment.SystemRoot;
  check(typeof root === 'string' && /^[A-Za-z]:\\[^\r\n]+$/.test(root) && !root.includes('..') && (!environment.windir || path.resolve(environment.windir).toLowerCase() === path.resolve(root).toLowerCase()), 'Windows root is unavailable or inconsistent');
  await ordinaryAncestors(root); check((await fs.realpath(root)).toLowerCase() === path.resolve(root).toLowerCase(), 'Windows root must not be redirected');
  const compiler = path.join(root, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const powershell = path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const filename of [path.join(root, 'System32/kernel32.dll'), compiler, powershell]) { await ordinaryAncestors(filename); check((await fs.lstat(filename)).isFile(), 'Installed Windows tool is missing'); }
  return { root, compiler, powershell };
}

/** A fresh report replaces stale success before any runtime validation or compiler work can fail. */
export async function withVerificationReport(filename, initial, work) {
  await ordinaryAncestors(filename); await fs.mkdir(path.dirname(filename), { recursive: true });
  const report = { ...initial, verificationId: crypto.randomUUID(), status: 'in_progress', productionReady: false, verifiedAt: new Date().toISOString() };
  const persist = async () => {
    await ordinaryAncestors(filename);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), { flag: 'wx' });
    // A single rename avoids publishing a half-written report. The temporary file is our own exact path.
    try { await fs.rename(temporary, filename); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  };
  await persist();
  try { await work(report); check(report.status === 'partial' || report.status === 'confirmed', 'Verification did not produce a terminal result'); }
  catch (error) { report.status = 'failed'; report.error = error.message; throw Object.assign(error, { verification: report }); }
  finally {
    report.finishedAt = new Date().toISOString(); await persist();
    // Keep final evidence when the next run replaces latest; only duplicate binaries are retention targets.
    const archive = path.join(path.dirname(filename), `${path.basename(filename, '.json')}.${report.verificationId}.json`);
    await ordinaryAncestors(archive); await fs.writeFile(archive, JSON.stringify(report, null, 2), { flag: 'wx' });
  }
  return report;
}

/** Cleanup accepts only the exact duplicate bin directory, not a task root or a user-selected path. */
export function runtimeCopyPath(root, parent = base) {
  const absolute = path.resolve(root); const owner = path.resolve(parent);
  check(path.isAbsolute(root) && path.dirname(absolute).toLowerCase() === owner.toLowerCase() && /^run-[a-f0-9]{32}$/.test(path.basename(absolute)), 'Runtime copy must be an exact sandbox run directory');
  return path.join(absolute, 'bin');
}

/** An active Wasmtime process makes cleanup fail closed; this reads process names only, never command lines. */
export async function assertNoWasmtimeProcesses(powershell, paths = []) {
  // Windows has additional reparse tags beyond symlinks/junctions. Inspect its native attribute bit too.
  // Paths cross stdin as JSON, not interpolated PowerShell source or command arguments.
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $paths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); foreach ($item in $paths) { $cursor=[IO.Path]::GetFullPath([string]$item); while ($cursor) { if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in runtime-copy path' }; $parent=[IO.Directory]::GetParent($cursor); if ($parent) { $cursor=$parent.FullName } else { $cursor=$null } } }; if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq 'wasmtime' -or $_.ProcessName -eq 'wasmtime-min' }).Count -ne 0) { throw 'Running Wasmtime process' }; [Console]::Out.Write('0')";
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 4096 }, (error, output) => error ? reject(error) : resolve(output));
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify(paths));
  });
  check(stdout.trim() === '0', 'Running Wasmtime processes prevent runtime copy cleanup');
}

/** Verify all candidates before deleting any, and unlink only the four byte-identical originals without recursive deletion. */
export async function pruneVerifiedRuntimeCopies(roots) {
  const { powershell } = await windowsSystemTools(); const inventory = await wasmtimeRuntimeInventory(); const names = Object.keys(inventory).sort();
  check(names.join(',') === 'LICENSE,README.md,wasmtime-min.exe,wasmtime.exe', 'Unexpected original Wasmtime inventory');
  await assertNoWasmtimeProcesses(powershell, roots.flatMap(root => { const bin = runtimeCopyPath(root); return [bin, ...names.map(name => path.join(bin, name))]; })); const verified = [];
  for (const root of [...new Set(roots)]) {
    const bin = runtimeCopyPath(root); await ordinaryAncestors(bin); check((await fs.lstat(bin)).isDirectory(), 'Runtime copy is not an ordinary directory');
    check((await fs.realpath(bin)).toLowerCase() === bin.toLowerCase(), 'Runtime copy is redirected');
    check((await fs.readdir(bin)).sort().join(',') === names.join(','), 'Runtime copy inventory changed');
    for (const name of names) { const item = inventory[name]; check(sha(await readBoundedOrdinaryFile(path.join(bin, name), item.bytes, item.bytes)) === item.sha256, 'Runtime copy hash changed'); }
    verified.push(bin);
  }
  let removedBytes = 0;
  for (const bin of verified) {
    await assertNoWasmtimeProcesses(powershell, [bin, ...names.map(name => path.join(bin, name))]); await ordinaryAncestors(bin);
    for (const name of names) {
      const filename = path.join(bin, name); const item = inventory[name];
      check(sha(await readBoundedOrdinaryFile(filename, item.bytes, item.bytes)) === item.sha256, 'Runtime copy changed before cleanup');
      await ordinaryAncestors(filename); await fs.unlink(filename); removedBytes += item.bytes;
    }
    await fs.rmdir(bin); // Non-recursive: any unexpected new entry prevents directory removal.
  }
  return { removedDirectories: verified.length, removedBytes, retained: 'input/output/report and central pinned runtime' };
}

/** Fresh task roots are the only ACL targets; no original binary, user file, or global setting is modified. */
async function stage(wat) {
  const root = path.join(base, `run-${crypto.randomUUID().replaceAll('-', '')}`); await fs.mkdir(root);
  for (const folder of ['bin', 'input', 'output', 'outside', 'aap-canary']) await fs.mkdir(path.join(root, folder));
  for (const name of await fs.readdir(wasmtimeRuntimeDirectory)) await fs.copyFile(path.join(wasmtimeRuntimeDirectory, name), path.join(root, 'bin', name), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, 'input/worker.wat'), wat, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'input/request.json'), '{"value":42}', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'input/allowed.txt'), 'sandbox input', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'outside/private.txt'), 'disposable outside sentinel', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'aap-canary/readable-by-appcontainers.txt'), 'disposable AAP sentinel', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'aap-canary/canary.txt'), 'disposable AAP sentinel', { flag: 'wx' });
  return root;
}

/** Only fixed numeric limits/profile enter the command, and helper output remains evidence. */
async function launch(root, wall = 6000, cpu = 3000, memory = 256, profile = 'wasmtime', whileRunning) {
  const pending = execute(host, [root, String(wall), String(memory), String(cpu), profile, 'none'], { windowsHide: true, timeout: 35000, maxBuffer: 1024 * 1024, env: { ...process.env, STUDIO_SANDBOX_TEST_CANARY: 'must-not-inherit' } });
  // Observe the same process promise even when a concurrent guard check fails; no helper is abandoned.
  void pending.catch(() => {}); let guardError;
  try { if (whileRunning) await whileRunning(); } catch (error) { guardError = error; }
  const result = await pending; if (guardError) throw guardError;
  check(!result.stderr.trim(), 'Unexpected helper stderr');
  const bytes = await fs.readFile(path.join(root, 'output/stdout.txt')); const stderr = await fs.readFile(path.join(root, 'output/stderr.txt'));
  return { host: JSON.parse(result.stdout), stdout: bytes.length <= 8192 ? bytes.toString('base64') : undefined, stdoutBytes: bytes.length, stdoutSha256: sha(bytes), stderr: stderr.includes(0) ? '[binary stderr omitted]' : stderr.toString('utf8').slice(0, 8192), stderrBytes: stderr.length, stderrSha256: sha(stderr), root };
}

/** The fresh probe root is the only mutation target. Unexpected rename success is immediately reversed before failing. */
async function verifyLiveOutputGuards(root) {
  runtimeCopyPath(root); await ordinaryAncestors(root);
  const output = path.join(root, 'output'), stdout = path.join(output, 'stdout.txt'), moved = path.join(root, 'output-moved');
  const deadline = Date.now() + 10000;
  for (;;) { try { await fs.stat(stdout); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); } }
  const control = path.join(root, 'outside/parent-write-control.txt');
  await fs.writeFile(control, 'before', { flag: 'wx' }); await fs.writeFile(control, 'after');
  check(await fs.readFile(control, 'utf8') === 'after', 'Parent comparison file was not writable');
  let renameDenied, writeDenied;
  try { await fs.rename(output, moved); } catch (error) { renameDenied = error.code; }
  if (!renameDenied) {
    // These paths were both created for this one probe; never delete or redirect a pre-existing user path.
    await fs.rename(moved, output); throw new Error('Live output directory rename unexpectedly succeeded');
  }
  try { await fs.writeFile(stdout, 'bad'); } catch (error) { writeDenied = error.code; }
  check(['EBUSY', 'EACCES', 'EPERM'].includes(renameDenied) && ['EBUSY', 'EACCES', 'EPERM'].includes(writeDenied), 'Live output parent handles did not refuse rename/write');
  return { renameDenied, writeDenied, comparisonWriteSucceeded: true, scope: 'same-user attempts while parent handles are open; not a general TOCTOU proof' };
}

/** Prove actual startup and bounded WASI access; a successful probe is not production integration. */
export async function verifyWindowsWasmtimeSandbox() {
  return withVerificationReport(path.join(base, 'latest-verification.json'), { osRelease: os.release(), tests: {}, limitation: 'Internal fixed probes only; bounded guest stdio is not a native process disk quota. No production Worker, kernel network proof, installer or complete isolation claim.' }, async report => {
    check(process.platform === 'win32' && process.arch === 'x64', 'Windows x64 required');
    report.runtime = await verifyWasmtimeRuntime(); const tools = await windowsSystemTools();
    await execute(tools.compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${host}`, source], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    report.nativeSourceSha256 = sha(await fs.readFile(source));
    report.tests.startup = await launch(await stage('(module (func (export "_start")))'));
    const observed = report.tests.startup;
    check(observed.host.appContainer && observed.host.lpacOptOut && observed.host.capabilities.length === 0 && observed.host.networkCapabilityCount === 0 && observed.host.profileDeleted, 'Zero-capability LPAC policy not observed');
    report.wasmtimeCompatibility = observed.host.exitCode === 0 ? 'confirmed' : 'failed';
    check(report.wasmtimeCompatibility === 'confirmed', 'Wasmtime did not execute the module in zero-capability LPAC');
    const probe = await fs.readFile(path.join(workspace, 'tests/security/windows-wasmtime-sandbox.probe.wat'), 'utf8'); report.probeSha256 = sha(probe);
    const access = await launch(await stage(probe)); report.tests.access = access;
    const bytes = Buffer.from(access.stdout, 'base64'); check(access.host.exitCode === 0 && bytes.length === 73, 'WASI access probe failed');
    const words = Array.from({ length: 15 }, (_, index) => bytes.readUInt32LE(index * 4)); access.errnosAndCounts = words;
    check(words[0] === 0 && words[1] === 0 && words[2] === 13 && bytes.subarray(60).toString('utf8') === 'sandbox input', 'Allowlisted input read failed');
    check(words[4] === 0 && words[5] === 0 && words[6] === 14 && await fs.readFile(path.join(access.root, 'output/allowed.txt'), 'utf8') === 'sandbox output', 'Allowlisted output write failed');
    for (const index of [3, 7, 8, 9, 13, 14]) check([2, 63, 76].includes(words[index]), `Expected access/capability denial at probe ${index}, received ${words[index]}`);
    check(words[10] === 0 && words[11] === 0 && words[12] === 0, 'Guest environment was not empty');
    check(await fs.readFile(path.join(access.root, 'input/allowed.txt'), 'utf8') === 'sandbox input' && await fs.readFile(path.join(access.root, 'outside/private.txt'), 'utf8') === 'disposable outside sentinel', 'Sentinel changed');
    report.accessBoundaryStatus = 'confirmed';
    const memory = await launch(await stage('(module (memory 1) (func (export "_start") (if (i32.ne (memory.grow (i32.const 300)) (i32.const -1)) (then unreachable))))')); report.tests.memory = memory;
    check(memory.host.exitCode === 0, 'Guest linear-memory growth was not refused');
    const fuel = await launch(await stage('(module (func (export "_start") (loop $forever (br $forever))))')); report.tests.fuel = fuel;
    check(fuel.host.exitCode !== 0 && !fuel.host.timedOut && /fuel/.test(fuel.stderr), 'Guest fuel exhaustion was not observed');
    const unknownImport = await launch(await stage('(module (import "env" "spawn" (func $spawn)) (func (export "_start") (call $spawn)))')); report.tests.unknownImport = unknownImport;
    check(unknownImport.host.exitCode !== 0 && /unknown import/.test(unknownImport.stderr), 'Unregistered process import was accepted');
    // WASIp1 exposes no API for opening a client socket; descriptor 99 is not an inherited socket.
    const network = await launch(await stage('(module (import "wasi_snapshot_preview1" "sock_shutdown" (func $socket (param i32 i32) (result i32))) (memory (export "memory") 1) (func (export "_start") (if (i32.ne (call $socket (i32.const 99) (i32.const 3)) (i32.const 8)) (then unreachable))))')); report.tests.socketDescriptor = network;
    check(network.host.exitCode === 0, 'Unexpected inherited socket descriptor');
    report.networkBoundaryStatus = 'unverified';
    // Pre-launch link checks must fail before the helper changes ACLs or executes the engine.
    for (const kind of ['junction', 'hardlink']) {
      const root = await stage('(module (func (export "_start")))');
      if (kind === 'junction') await fs.symlink(path.join(root, 'outside'), path.join(root, 'input/junction'), 'junction');
      else await fs.link(path.join(root, 'outside/private.txt'), path.join(root, 'input/hardlink.txt'));
      let rejected = false;
      try { await launch(root); } catch (error) { rejected = kind === 'junction' ? /Reparse point/.test(error.stderr ?? '') : /Hard-linked/.test(error.stderr ?? ''); }
      check(rejected, `${kind} was not rejected before launch`); report.tests[kind] = { rejected: true, processStarted: false, root };
    }
    const invalid = await stage('(module (func (export "_start")))'); let rejected = false;
    try { await execute(host, [invalid, '6000', '256', '3000', 'wasmtime', 'registry-read-diagnostic'], { windowsHide: true }); }
    catch (error) { rejected = /Wasmtime profile requires zero capabilities/.test(error.stderr ?? ''); }
    check(rejected, 'Wasmtime accepted a diagnostic capability'); report.tests.diagnostic = { rejected: true, processStarted: false, root: invalid };
    // The narrower stdio profile has no directory preopens or writable file handles. Real pipes
    // bound bytes before persistence, so the guest cannot fill disk through stdout/stderr.
    const echo = '(module (import "wasi_snapshot_preview1" "fd_read" (func $r (param i32 i32 i32 i32) (result i32))) (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32))) (import "wasi_snapshot_preview1" "fd_prestat_get" (func $p (param i32 i32) (result i32))) (memory (export "memory") 1) (func (export "_start") (if (i32.ne (call $p (i32.const 3) (i32.const 32)) (i32.const 8)) (then unreachable)) (i32.store (i32.const 0) (i32.const 1024)) (i32.store (i32.const 4) (i32.const 4096)) (if (call $r (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 16)) (then unreachable)) (i32.store (i32.const 4) (i32.load (i32.const 16))) (if (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16)) (then unreachable))))';
    const stdio = await launch(await stage(echo), 6000, 3000, 256, 'wasmtime-stdio'); report.tests.stdio = stdio;
    check(stdio.host.exitCode === 0 && stdio.host.boundedStdio && !stdio.host.outputLimitExceeded && Buffer.from(stdio.stdout ?? '', 'base64').toString('utf8') === '{"value":42}', 'Bounded stdio echo or no-preopens proof failed');
    const flood = descriptor => `(module (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32))) (memory (export "memory") 1) (func (export "_start") (i32.store (i32.const 0) (i32.const 1024)) (i32.store (i32.const 4) (i32.const 60000)) (loop $forever (drop (call $w (i32.const ${descriptor}) (i32.const 0) (i32.const 1) (i32.const 16))) (br $forever))))`;
    for (const [name, descriptor, maximum] of [['stdoutLimit', 1, 1024 * 1024], ['stderrLimit', 2, 64 * 1024]]) {
      const limit = await launch(await stage(flood(descriptor)), 10000, 3000, 256, 'wasmtime-stdio'); report.tests[name] = limit;
      check(limit.host.boundedStdio && limit.host.outputLimitExceeded && limit.host.jobClosedOnOutputLimit && !limit.host.timedOut, `${name} did not enforce its live byte limit`);
      check((descriptor === 1 ? limit.stdoutBytes : limit.stderrBytes) === maximum, `${name} persisted bytes beyond its cap`);
      check((await fs.readdir(path.join(limit.root, 'output'))).sort().join(',') === 'stderr.txt,stdout.txt', 'Unexpected guest disk output');
    }
    const oversized = await stage(echo); await fs.writeFile(path.join(oversized, 'input/request.json'), Buffer.alloc(1024 * 1024 + 1)); rejected = false;
    try { await launch(oversized, 6000, 3000, 256, 'wasmtime-stdio'); } catch (error) { rejected = /input exceeds fixed byte limit/.test(error.stderr ?? ''); }
    check(rejected, 'Oversized stdin was accepted'); report.tests.stdinLimit = { rejected: true, processStarted: false, root: oversized };
    const sleeping = '(module (import "wasi_snapshot_preview1" "poll_oneoff" (func $p (param i32 i32 i32 i32) (result i32))) (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32))) (memory (export "memory") 1) (data (i32.const 256) "started") (func (export "_start") (i32.store (i32.const 300) (i32.const 256)) (i32.store (i32.const 304) (i32.const 7)) (drop (call $w (i32.const 1) (i32.const 300) (i32.const 1) (i32.const 320))) (i32.store (i32.const 16) (i32.const 1)) (i64.store (i32.const 24) (i64.const 60000000000)) (drop (call $p (i32.const 0) (i32.const 128) (i32.const 1) (i32.const 200)))))';
    const guardedRoot = await stage(sleeping); let outputGuard;
    const wallTime = await launch(guardedRoot, 1000, 3000, 256, 'wasmtime-stdio', async () => { outputGuard = await verifyLiveOutputGuards(guardedRoot); }); report.tests.stdioWallTime = { ...wallTime, outputGuard };
    check(wallTime.host.timedOut && wallTime.host.jobClosedOnTimeout && !wallTime.host.outputLimitExceeded && Buffer.from(wallTime.stdout ?? '', 'base64').toString('utf8') === 'started', 'Blocked guest was not killed by the wall deadline');
    report.boundedStdioStatus = 'confirmed';
    report.status = 'partial';
    const finished = Object.values(report.tests);
    check(finished.every(test => test.host?.profileDeleted === true || test.rejected === true && test.processStarted === false), 'A worker has no completed cleanup evidence');
    // Retain all input/output evidence. Only successful, fully accounted-for runs lose duplicate runtime binaries.
    report.retention = await pruneVerifiedRuntimeCopies(finished.map(test => test.root));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyWindowsWasmtimeSandbox(), null, 2)); }
  catch (error) { console.error(JSON.stringify(error.verification ?? { status: 'failed', error: error.message }, null, 2)); process.exitCode = 1; }
}
