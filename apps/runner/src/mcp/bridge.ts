import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { canonicalDigest, readPackageDirectory } from '@studio/package-kit';
import { parseStrictJson } from '@studio/spec';
import { WindowsCredentialStore } from '../security/credential-store.js';
import { defaultDataDirectory } from '../cli/paths.js';
import { RunnerError, objectValue, publicError, stringValue } from '../errors.js';

/** A bridge relays to a separately running daemon; closing stdio cannot terminate an execution. */
export async function createBridge(packageDirectory: string, dataDirectory = defaultDataDirectory()): Promise<Server> {
  const server = new Server({ name: 'studio-runner', version: '0.1.0' }, { capabilities: { tools: {} } });
  const credentials = new WindowsCredentialStore(join(dataDirectory, 'secrets'));
  let connection: { instanceId: string; port: number; token: string } | undefined;
  let packageHandle: string | undefined;
  let packageDigest: string | undefined;

  async function client(path: string, method = 'GET', payload?: unknown, zip?: Uint8Array): Promise<unknown> {
    let discovery: Record<string, unknown>;
    try { discovery = objectValue(parseStrictJson(await readFile(join(dataDirectory, 'discovery.json'), 'utf8'))); }
    catch { throw new RunnerError('RUNNER_NOT_RUNNING', 'Studio Runner를 먼저 실행하세요.'); }
    if (!Number.isInteger(discovery.port) || Number(discovery.port) < 1 || Number(discovery.port) > 65535 || discovery.credentialRef !== 'runner_bridge') throw new RunnerError('DISCOVERY_INVALID', 'Runner 연결 정보가 올바르지 않습니다.');
    const instanceId = stringValue(discovery.instanceId, 'Runner ID');
    if (connection?.instanceId !== instanceId) connection = { instanceId, port: Number(discovery.port), token: await credentials.get('runner_bridge') };
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
        method, headers: { authorization: `Bearer ${connection.token}`, ...(method === 'GET' ? {} : { 'content-type': zip ? 'application/zip' : 'application/json' }) },
        body: zip ? Buffer.from(zip) : payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(30000),
      });
    } catch { throw new RunnerError('RUNNER_UNREACHABLE', 'Studio Runner에 연결하지 못했습니다. 실행 상태를 확인하세요.'); }
    const result: unknown = await response.json();
    if (!response.ok) {
      const error = objectValue(objectValue(result).error);
      throw new RunnerError(stringValue(error.code, '오류 코드'), stringValue(error.message, '오류 내용', 2000), response.status);
    }
    return result;
  }

  async function ensurePackage(): Promise<string> {
    if (packageHandle) return packageHandle;
    // Files are read only when a tool is explicitly called. MCP initialize has no import/network side effects.
    const imported = objectValue(await client('/api/packages/import', 'POST', undefined, await readPackageDirectory(packageDirectory)));
    packageHandle = stringValue(imported.packageHandle, '패키지 ID');
    packageDigest = canonicalDigest(imported.manifest);
    return packageHandle;
  }

  async function assertOwnRun(runId: string): Promise<void> {
    await ensurePackage();
    const run = objectValue(await client(`/api/runs/${encodeURIComponent(runId)}`));
    const source = objectValue(await client(`/api/packages/${encodeURIComponent(stringValue(run.packageHandle, '패키지 ID'))}`));
    if (canonicalDigest(source.manifest) !== packageDigest) throw new RunnerError('RUN_SCOPE_DENIED', '이 프로젝트의 실행 기록만 사용할 수 있습니다.', 403);
  }

  const runIdProperty = { type: 'string', minLength: 1, maxLength: 100 };
  const modelBindingsProperty = { type: 'object', additionalProperties: { type: 'string' } };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'studio.inspect_package', description: '현재 프로젝트의 운영 패키지와 필요한 입력·모델 연결을 확인합니다. 실행하지 않습니다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'studio.validate', description: '현재 패키지의 실행 준비 상태를 검사합니다. 모델 호출은 하지 않습니다.', inputSchema: { type: 'object', properties: { modelBindings: modelBindingsProperty }, additionalProperties: false } },
    { name: 'studio.start', description: '사용자가 요청한 워크플로를 시작합니다. 동일 요청을 재전송할 때 requestId를 유지하세요.', inputSchema: { type: 'object', properties: { requestId: { type: 'string', maxLength: 128 }, inputs: {}, modelBindings: modelBindingsProperty }, required: ['requestId', 'inputs'], additionalProperties: false } },
    { name: 'studio.status', description: '이 프로젝트의 실행 상태와 사용량을 확인합니다.', inputSchema: { type: 'object', properties: { runId: runIdProperty }, required: ['runId'], additionalProperties: false } },
    { name: 'studio.events', description: '지정한 순번 이후의 실행 이벤트를 확인합니다.', inputSchema: { type: 'object', properties: { runId: runIdProperty, after: { type: 'integer', minimum: 0 } }, required: ['runId'], additionalProperties: false } },
    { name: 'studio.cancel', description: '실행 취소를 요청합니다. 이미 완료한 외부 변경의 롤백을 뜻하지 않습니다.', inputSchema: { type: 'object', properties: { runId: runIdProperty }, required: ['runId'], additionalProperties: false } },
    { name: 'studio.results', description: '확인된 실행 결과를 가져옵니다.', inputSchema: { type: 'object', properties: { runId: runIdProperty }, required: ['runId'], additionalProperties: false } },
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      // Unknown tools are rejected before package I/O, including attempts to invent approval methods.
      if (!['studio.inspect_package', 'studio.validate', 'studio.start', 'studio.status', 'studio.events', 'studio.cancel', 'studio.results'].includes(params.name)) throw new RunnerError('TOOL_NOT_FOUND', '지원하지 않는 Studio 도구입니다.');
      const args = objectValue(params.arguments ?? {});
      const handle = await ensurePackage();
      let result: unknown;
      if (params.name === 'studio.inspect_package') result = { ...objectValue(await client(`/api/packages/${handle}`)), availableModels: await client('/api/profiles') };
      else if (params.name === 'studio.validate') result = await client(`/api/packages/${handle}/validate`, 'POST', { modelBindings: args.modelBindings ?? {} });
      else if (params.name === 'studio.start') result = await client('/api/runs', 'POST', { packageHandle: handle, requestId: stringValue(args.requestId, '요청 ID', 128), inputs: args.inputs, modelBindings: args.modelBindings ?? {} });
      else {
        const runId = stringValue(args.runId, '실행 ID', 100);
        if (!/^run_[a-f0-9-]+$/.test(runId)) throw new RunnerError('INVALID_RUN_ID', '실행 ID가 올바르지 않습니다.');
        await assertOwnRun(runId);
        const path = `/api/runs/${runId}`;
        if (params.name === 'studio.status') result = await client(path);
        else if (params.name === 'studio.results') result = await client(`${path}/results`);
        else if (params.name === 'studio.cancel') result = await client(`${path}/cancel`, 'POST', {});
        else if (params.name === 'studio.events') {
          const after = args.after ?? 0;
          if (!Number.isSafeInteger(after) || Number(after) < 0) throw new RunnerError('INVALID_CURSOR', '이벤트 조회 위치가 올바르지 않습니다.');
          result = await client(`${path}/events?after=${after}`);
        } else throw new RunnerError('TOOL_NOT_FOUND', '지원하지 않는 Studio 도구입니다.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: publicError(error) }) }] }; }
  });
  return server;
}

/** The installer invokes this entry with a fixed project directory; tools cannot select arbitrary paths. */
async function main(): Promise<void> {
  const index = process.argv.indexOf('--package');
  const directory = resolve(index >= 0 ? process.argv[index + 1] ?? '.' : '.');
  const server = await createBridge(directory);
  await server.connect(new StdioServerTransport());
}

// Tests import the factory without starting stdio; the production launcher always supplies --stdio.
if (process.argv.includes('--stdio')) void main().catch((error) => { const safe = publicError(error); process.stderr.write(`${safe.code}: ${safe.message}\n`); process.exitCode = 1; });
