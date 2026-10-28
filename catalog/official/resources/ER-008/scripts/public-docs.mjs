/** Minimal bounded MCP reader for two anonymous official documentation servers; never executes remote instructions. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fail = (code) => { throw new Error(code); };
const profiles = {
  cloudflare: { url: 'https://docs.mcp.cloudflare.com/mcp', tools: ['search_cloudflare_documentation'], sourceHost: 'developers.cloudflare.com' },
  learn: { url: 'https://learn.microsoft.com/api/mcp', tools: ['microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search'], sourceHost: 'learn.microsoft.com' },
};

/** Every request has one overall deadline and a total byte ceiling, including indefinitely open SSE streams. */
export async function rpc(endpoint, message, headers = {}) {
  if (!Object.values(profiles).some(profile => profile.url === endpoint)) fail('ENDPOINT_DENIED');
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(message) });
  if (!response.ok) fail(`MCP_HTTP_${response.status}`);
  const session = response.headers.get('mcp-session-id');
  if (session && (!/^[\x21-\x7e]{1,256}$/.test(session))) fail('INVALID_SESSION');
  if (message.id === undefined) { await response.body?.cancel(); if (response.status !== 202) fail('NOTIFICATION_STATUS'); return { session }; }
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json') && !type.startsWith('text/event-stream')) fail('RESPONSE_TYPE');
  const reader = response.body?.getReader(); if (!reader) fail('EMPTY_RESPONSE');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, buffer = '';
  const checked = value => {
    if (!value || value.jsonrpc !== '2.0' || value.id !== message.id || value.error || !Object.hasOwn(value, 'result')) fail('MCP_RESPONSE');
    return { session, result: value.result };
  };
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 1048576) fail('RESPONSE_LIMIT');
      buffer += decoder.decode(part.value, { stream: true });
      if (type.startsWith('text/event-stream')) {
        buffer = buffer.replaceAll('\r\n', '\n'); let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const value = JSON.parse(data);
          // Server notifications are data; server-initiated requests are unsupported and never acted upon.
          if (value.id === message.id) return checked(value);
          if (value.id !== undefined) fail('UNEXPECTED_SERVER_REQUEST');
        }
      }
    }
    buffer += decoder.decode();
    if (type.startsWith('application/json')) return checked(JSON.parse(buffer));
    fail('MISSING_RPC_RESPONSE');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function readDocumentation(input, service) {
  const profile = profiles[service]; if (!profile) fail('SERVICE_DENIED');
  if (!input || !['list', 'read'].includes(input.operation)) fail('OPERATION_DENIED');
  if (input.operation === 'read' && !profile.tools.includes(input.tool)) fail('READ_TOOL_REQUIRED');
  const init = await rpc(profile.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'studio-official-docs-reader', version: '1.0.0' } } });
  if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(init.result?.protocolVersion)) fail('PROTOCOL_UNSUPPORTED');
  const headers = { 'MCP-Protocol-Version': init.result.protocolVersion, ...(init.session ? { 'Mcp-Session-Id': init.session } : {}) };
  await rpc(profile.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const tools = []; let cursor;
  for (let page = 0; page < 10; page++) {
    const response = await rpc(profile.url, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, headers);
    if (!Array.isArray(response.result?.tools) || response.result.tools.length > 100) fail('TOOLS_CONTRACT');
    tools.push(...response.result.tools); cursor = response.result.nextCursor;
    if (!cursor) break;
    if (typeof cursor !== 'string' || cursor.length > 4096 || page === 9) fail('PAGINATION_LIMIT');
  }
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) fail('DUPLICATE_TOOL');
  const available = tools.filter(tool => profile.tools.includes(tool.name));
  if (input.operation === 'list') return { service, endpoint: profile.url, protocolVersion: init.result.protocolVersion, tools: available, hostVerification: 'unverified' };
  if (input.operation !== 'read' || !profile.tools.includes(input.tool)) fail('READ_TOOL_REQUIRED');
  const selected = available.find(tool => tool.name === input.tool); if (!selected) fail('REQUIRED_TOOL_UNAVAILABLE');
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('ARGUMENTS_REQUIRED');
  const allowed = input.tool === 'microsoft_docs_fetch' ? ['url'] : input.tool === 'microsoft_code_sample_search' ? ['query', 'language'] : ['query'];
  if (Object.keys(args).some(key => !allowed.includes(key))) fail('ARGUMENT_DENIED');
  if (input.tool === 'microsoft_docs_fetch') {
    const url = new URL(args.url); if (url.protocol !== 'https:' || url.hostname !== profile.sourceHost || url.username || url.password || url.port) fail('SOURCE_URL_DENIED');
  } else if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) fail('QUERY_LIMIT');
  if (args.language !== undefined && (typeof args.language !== 'string' || args.language.length > 50)) fail('LANGUAGE_LIMIT');
  // Refuse changed required parameters or incompatible primitive types instead of guessing at a new server contract.
  const schema = selected.inputSchema;
  if (schema?.type !== 'object' || !schema.properties || (schema.required ?? []).some(key => args[key] === undefined)) fail('SCHEMA_CHANGED');
  for (const [key, value] of Object.entries(args)) if (schema.properties[key]?.type !== typeof value) fail('SCHEMA_CHANGED');
  const response = await rpc(profile.url, { jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: input.tool, arguments: args } }, headers);
  if (response.result?.isError || !Array.isArray(response.result?.content)) fail('TOOL_FAILED');
  return { service, endpoint: profile.url, tool: input.tool, result: response.result, sourceVerification: 'compare returned quotes with original URLs', hostVerification: 'unverified' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const profile = JSON.parse(await readFile(new URL('../connection.json', import.meta.url), 'utf8'));
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) fail('INPUT_LIMIT'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(await readDocumentation(input, profile.service)) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: /^[A-Z_0-9]+$/.test(error?.message) ? error.message : 'MCP_READ_FAILED', message: 'No successful read or host verification is claimed.' }) + '\n'); process.exitCode = 1;
  }
}
