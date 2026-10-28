import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenBrowserLoopback } from '../../apps/runner/src/local-api/listen-loopback.js';

const servers: Server[] = [];
function makeServer() { const server = createServer((_request, response) => response.end('ready')); servers.push(server); return server; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** The OS allocation result is controlled where necessary; listening, close/rebind and HTTP are real. */
describe('browser-compatible loopback allocation', () => {
  it('reserves an actual reachable loopback socket', async () => {
    const server = makeServer(); const port = await listenBrowserLoopback(server);
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ready');
  });
  it.each([6000, 10080, -1, 65536, 1.5])('rejects an explicitly unusable port %s before listening', async port => {
    const server = makeServer(); await expect(listenBrowserLoopback(server, port)).rejects.toMatchObject({ code: 'LISTEN_PORT_INVALID' });
    expect(server.listening).toBe(false);
  });
  it('closes an allocated blocked port and publishes only the replacement socket', async () => {
    const server = makeServer(); const baseline = server.listeners('listening'); const close = vi.spyOn(server, 'close');
    vi.spyOn(server, 'address').mockReturnValueOnce({ address: '127.0.0.1', family: 'IPv4', port: 6000 });
    const port = await listenBrowserLoopback(server);
    expect(close).toHaveBeenCalled(); expect(port).not.toBe(6000);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ready');
    expect(server.listeners('listening')).toEqual(baseline); expect(server.listenerCount('error')).toBe(0);
  });
  it('bounds repeated blocked allocations and releases the last socket', async () => {
    const server = makeServer(); const listen = vi.spyOn(server, 'listen');
    vi.spyOn(server, 'address').mockReturnValue({ address: '127.0.0.1', family: 'IPv4', port: 6000 });
    await expect(listenBrowserLoopback(server)).rejects.toMatchObject({ code: 'LISTEN_FAILED' });
    expect(listen).toHaveBeenCalledTimes(32); expect(server.listening).toBe(false);
  });
  it('preserves an explicit occupied-port error instead of changing the requested address', async () => {
    const owner = makeServer(); const port = await listenBrowserLoopback(owner); const contender = makeServer(); const baseline = contender.listeners('listening');
    await expect(listenBrowserLoopback(contender, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(owner.listening).toBe(true); expect(contender.listening).toBe(false);
    expect(contender.listenerCount('error')).toBe(0); expect(contender.listeners('listening')).toEqual(baseline);
  });
});
