import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridge } from '../src/mcp/bridge.js';

/** Actual SDK initialize/list-tools must not inspect a package or contact a daemon. */
describe('MCP bridge initialization', () => {
  it('advertises operational tools without requiring a running daemon or reading a project', async () => {
    const server = await createBridge('Z:\\does-not-exist\\package', 'Z:\\does-not-exist\\state');
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['studio.inspect_package', 'studio.validate', 'studio.start', 'studio.status', 'studio.events', 'studio.cancel', 'studio.results']);
      expect(listed.tools.some((tool) => tool.name.includes('approve'))).toBe(false);
      const unknown = await client.callTool({ name: 'studio.approve', arguments: {} });
      expect(unknown.isError).toBe(true); expect(JSON.stringify(unknown.content)).toContain('TOOL_NOT_FOUND');
    } finally { await client.close(); await server.close(); }
  });
});
