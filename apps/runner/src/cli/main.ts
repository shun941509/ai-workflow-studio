import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../state/store.js';
import { WindowsCredentialStore } from '../security/credential-store.js';
import { RunnerService } from '../service.js';
import { createLocalServer } from '../local-api/server.js';
import { defaultDataDirectory } from './paths.js';
import { RunnerError, publicError } from '../errors.js';

/** Long-lived daemon owns execution; a host's short-lived MCP bridge never owns this process. */
async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const option = (name: string) => { const index = arguments_.indexOf(name); return index >= 0 ? arguments_[index + 1] : undefined; };
  const dataDirectory = resolve(option('--data-dir') ?? defaultDataDirectory());
  const uiDirectory = resolve(option('--ui-dir') ?? fileURLToPath(new URL('../../../runner-ui/dist/', import.meta.url)));
  const port = Number(option('--port') ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RunnerError('INVALID_PORT', '포트 번호가 올바르지 않습니다.');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RunStore(join(dataDirectory, 'state.sqlite'));
  const instanceId = randomUUID();
  try { store.claimDaemon(instanceId, process.pid); } catch (error) { store.close(); throw error; }
  const credentials = new WindowsCredentialStore(join(dataDirectory, 'secrets'));
  let local: ReturnType<typeof createLocalServer> | undefined;
  let service: RunnerService | undefined;
  const discoveryPath = join(dataDirectory, 'discovery.json');
  try {
    if (!credentials.available) throw new RunnerError('SECURE_STORE_UNAVAILABLE', '이 Runner 설치본은 Windows 보안 저장소가 필요합니다.');
    const bearerToken = randomBytes(32).toString('hex');
    await credentials.set('runner_bridge', bearerToken);
    store.recoverInterruptedRuns();
    service = new RunnerService(store, credentials, dataDirectory);
    local = createLocalServer(service, { bearerToken, uiDirectory });
    const address = await local.listen(port);
    await writeFile(discoveryPath, JSON.stringify({ version: 1, instanceId, pid: process.pid, port: address.port, credentialRef: 'runner_bridge' }), { mode: 0o600 });
    await service.restoreWaitingRuns();
    // Only a public loopback address is printed; the credential stays in DPAPI storage.
    process.stdout.write(`Studio Runner: ${address.origin}\n`);
    await new Promise<void>((resolveStop) => {
      let stopping = false;
      const stop = () => { if (stopping) return; stopping = true; void service!.shutdown().then(resolveStop); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally {
    await service?.shutdown();
    if (local) await local.close();
    store.releaseDaemon(instanceId);
    store.close();
    const ownDiscovery = await readFile(discoveryPath, 'utf8').then((text) => JSON.parse(text) as { pid?: number }).catch(() => undefined);
    if (ownDiscovery?.pid === process.pid) await unlink(discoveryPath).catch(() => undefined);
  }
}

void main().catch((error: unknown) => { const safe = publicError(error); process.stderr.write(`${safe.code}: ${safe.message}\n`); process.exitCode = 1; });
