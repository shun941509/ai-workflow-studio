import type { Server } from 'node:http';
import { RunnerError } from '../errors.js';

// WHATWG Fetch §2.9 (2026-10-19): https://fetch.spec.whatwg.org/#port-blocking
// Windows may use a customized ephemeral range that intersects these browser-blocked ports.
const BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Reserve the final socket directly; never probe a free port and reopen it with a race. */
export async function listenBrowserLoopback(server: Server, requestedPort = 0): Promise<number> {
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || requestedPort !== 0 && BLOCKED_PORTS.has(requestedPort)) throw new RunnerError('LISTEN_PORT_INVALID', '브라우저에서 사용할 수 있는 포트를 지정하세요.');
  // Only automatically allocated, browser-blocked ports are retried; bind errors keep their original meaning.
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolveListen(); };
      server.once('error', onError); server.once('listening', onListening);
      try { server.listen(requestedPort, '127.0.0.1'); }
      catch (error) { server.removeListener('error', onError); server.removeListener('listening', onListening); reject(error); }
    });
    const address = server.address();
    if (address && typeof address !== 'string' && !BLOCKED_PORTS.has(address.port)) return address.port;
    // This socket has not been published as an origin. Close it before asking the OS for another address.
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    if (requestedPort !== 0) break;
  }
  throw new RunnerError('LISTEN_FAILED', '사용 가능한 Runner 주소를 만들지 못했습니다. 다시 시작하세요.');
}
