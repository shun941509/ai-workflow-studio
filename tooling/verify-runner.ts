import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';

/** Verify the built distribution through real HTTP, without a model key or an in-process daemon double. */
const directory = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(join(directory, 'build-manifest.json'), 'utf8')) as { node: string; platform: string };
if (manifest.node !== 'v24.22.1' || manifest.platform !== 'win32-x64') throw new Error('검증 대상 런타임이 다릅니다.');
const dataDirectory = await mkdtemp(join(tmpdir(), 'studio-runtime-smoke-'));
const child = spawn(join(directory, 'node.exe'), [join(directory, 'runner.mjs'), '--data-dir', dataDirectory, '--ui-dir', join(directory, 'ui')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; let errors = ''; let failure: unknown;
child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
child.on('error', (error) => { failure = error; });
const checks: string[] = [];
function check(value: unknown, name: string): asserts value { if (!value) throw new Error(name); checks.push(name); }
try {
  const deadline = Date.now() + 20000;
  while (!output.includes('http://127.0.0.1:') && Date.now() < deadline && child.exitCode === null && !failure) await delay(100);
  const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
  check(origin, 'bundled daemon started with Windows secure storage');
  const page = await fetch(origin);
  check(page.ok && (await page.text()).includes('id="root"'), 'built local UI served');
  check((await fetch(origin + '/api/info')).status === 401, 'anonymous API access denied');
  const session = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-studio-client': 'local-ui', 'content-type': 'application/json' }, body: '{}' });
  check(session.ok, 'same-origin UI session created');
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  const { csrf } = await session.json() as { csrf: string };
  check(cookie && csrf, 'session cookie and CSRF response issued');
  const headers = { cookie, 'x-studio-csrf': csrf, 'sec-fetch-site': 'same-origin', origin };
  const info = await fetch(origin + '/api/info', { headers });
  const infoBody = await info.json() as { runtimeVersion: string; secureStoreAvailable: boolean; capabilities: string[] };
  check(info.ok && infoBody.runtimeVersion === 'v24.22.1' && infoBody.secureStoreAvailable, 'bundled runtime version and secure store confirmed');
  const archive = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' });
  const imported = await fetch(origin + '/api/packages/import', { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: Buffer.from(archive.bytes) });
  check(imported.status === 201, 'real exported package imported by bundled daemon');
  const detail = await imported.json() as { packageHandle: string };
  const readiness = await fetch(origin + `/api/packages/${detail.packageHandle}/validate`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"modelBindings":{}}' });
  const readinessBody = await readiness.json() as { ready: boolean; issues: unknown[] };
  check(readiness.ok && !readinessBody.ready && readinessBody.issues.length > 0, 'missing model connection blocks execution');
  const runs = await fetch(origin + '/api/runs', { headers });
  check((await runs.json() as unknown[]).length === 0, 'import and readiness inspection create no run');
  const evidence = { checkedAt: new Date().toISOString(), node: process.version, distribution: directory, checks, externalModelTested: false };
  await writeFile(join(directory, 'local-verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} catch (error) {
  process.stderr.write(errors.slice(0, 2000));
  throw failure ?? error;
} finally {
  // Only the child started by this verification is terminated; installed user daemons are untouched.
  child.kill();
}
