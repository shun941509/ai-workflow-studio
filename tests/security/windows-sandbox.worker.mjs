// Adversarial integration fixture only. It operates exclusively on verifier-created disposable data.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.dirname(path.dirname(process.argv[2]));
const output = path.join(root, 'output');
const save = value => fs.writeFileSync(path.join(output, 'worker-report.json'), JSON.stringify(value));
const attempt = operation => {
  try { return { allowed: true, value: operation() }; }
  catch (error) { return { allowed: false, code: error.code ?? error.name }; }
};

if (request.mode === 'timeout') {
  save({ started: true });
  setTimeout(() => save({ escapedTimeout: true }), 60000);
} else if (request.mode === 'cpu') {
  save({ started: true });
  for (;;) Math.sqrt(Math.random());
} else if (request.mode === 'memory') {
  const buffers = [];
  for (let index = 0; index < 40; index++) {
    save({ allocatedMiB: index * 8 });
    try { buffers.push(Buffer.alloc(8 * 1024 * 1024, 0xa5)); }
    catch (error) { save({ memoryDenied: true, code: error.code ?? error.name, allocatedMiB: index * 8 }); process.exit(0); }
  }
  save({ escapedMemoryLimit: true });
} else {
  const result = {
    input: attempt(() => fs.readFileSync(path.join(root, 'input', 'allowed.txt'), 'utf8')),
    output: attempt(() => { fs.writeFileSync(path.join(output, 'allowed.txt'), 'sandbox output'); return 'written'; }),
    inputWrite: attempt(() => fs.writeFileSync(path.join(root, 'input', 'allowed.txt'), 'unwanted change')),
    outsideRead: attempt(() => fs.readFileSync(path.join(root, 'outside', 'private.txt'), 'utf8')),
    outsideWrite: attempt(() => fs.writeFileSync(path.join(root, 'outside', 'new.txt'), 'unwanted change')),
    allAppPackagesRead: attempt(() => fs.readFileSync(path.join(root, 'aap-canary', 'readable-by-appcontainers.txt'), 'utf8')),
    envKeys: Object.keys(process.env).sort(),
  };
  result.network = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: request.port });
    socket.once('connect', () => { socket.destroy(); resolve({ allowed: true }); });
    socket.once('error', error => resolve({ allowed: false, code: error.code }));
    socket.setTimeout(2000, () => { socket.destroy(); resolve({ allowed: false, code: 'TIMEOUT_INCONCLUSIVE' }); });
  });
  result.child = await new Promise(resolve => {
    try {
      const child = spawn(process.execPath, ['--version'], { shell: false, stdio: 'ignore' });
      child.once('error', error => resolve({ allowed: false, code: error.code }));
      child.once('spawn', () => resolve({ allowed: true }));
    } catch (error) { resolve({ allowed: false, code: error.code, errno: error.errno }); }
  });
  save(result);
}
