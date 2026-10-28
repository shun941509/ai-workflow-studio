import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';

/** Verify the built distribution through real HTTP, without a model key or an in-process daemon double. */
if (process.argv.length !== 3 || !process.argv[2]?.trim()) throw new Error('사용법: pnpm verify:runner <build:runner가 출력한 배포 후보 폴더>');
const directory = resolve(process.argv[2]);
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
  const detail = await imported.json() as { packageHandle: string; modelRequirements: { alias: string; kind: string }[] };
  check(detail.modelRequirements.length === 1 && detail.modelRequirements[0]?.alias === 'text-default' && detail.modelRequirements[0]?.kind === 'chat', 'bundled package metadata identifies the required chat connection');
  const readiness = await fetch(origin + `/api/packages/${detail.packageHandle}/validate`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"modelBindings":{}}' });
  const readinessBody = await readiness.json() as { ready: boolean; issues: unknown[] };
  check(readiness.ok && !readinessBody.ready && readinessBody.issues.length > 0, 'missing model connection blocks execution');
  const runs = await fetch(origin + '/api/runs', { headers });
  check((await runs.json() as unknown[]).length === 0, 'import and readiness inspection create no run');

  // A real model-free job also verifies the packaged tokenizer data and SQLite RAG runtime, not only startup.
  const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
  const input = node('input', 'input'), file = node('file_output', 'file'), document = node('document_extract', 'document'), index = node('knowledge', 'index'), search = node('retrieval', 'search'), merge = node('merge', 'merge'), resultNode = node('output', 'output');
  file.config = { format: 'text', filename: 'delivery.txt', outputDirectory: 'outputs' }; file.inputBindings = { content: { from: 'workflowInput', pointer: '/source', onMissing: 'error' } };
  document.config = { mode: 'text' }; document.inputBindings = { file: { from: 'node', nodeId: 'file', pointer: '/data', onMissing: 'error' } };
  index.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 2000, chunkOverlap: 100 } }; index.inputBindings = { documents: { from: 'node', nodeId: 'file', pointer: '/files', onMissing: 'error' } };
  search.config = { mode: 'keyword', topK: 3, maxContextTokens: 500 }; search.inputBindings = { query: { from: 'literal', value: '배송' }, index: { from: 'node', nodeId: 'index', pointer: '/data', onMissing: 'error' } };
  merge.config = { combine: 'object', collision: 'namespace', waitFor: 'all_active' }; merge.inputBindings = { document: { from: 'node', nodeId: 'document', pointer: '/data', onMissing: 'error' }, search: { from: 'node', nodeId: 'search', pointer: '/data', onMissing: 'error' } };
  resultNode.inputBindings = { result: { from: 'node', nodeId: 'merge', pointer: '/data', onMissing: 'error' } };
  const nodes: Workflow['nodes'] = [input, file, document, index, search, merge, resultNode];
  const workflow: Workflow = { ...createBasicWorkflow('문서·키워드 검색 배포 검증'), entryNodeId: 'input', nodes, edges: nodes.slice(0, -1).map((item, position) => ({ id: `edge_${position}`, from: { nodeId: item.id, port: 'next' }, to: { nodeId: nodes[position + 1]!.id, port: 'in' } })), modelProfiles: { 'unused-search': { kind: 'embedding', requiredFeatures: ['embedding'] } }, inputs: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'], additionalProperties: false }, outputs: true };
  const pureArchive = await buildPackage({ workflow, host: 'codex' });
  const pureImport = await fetch(origin + '/api/packages/import', { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: Buffer.from(pureArchive.bytes) });
  check(pureImport.status === 201, 'document and keyword workflow imported by bundled daemon');
  const pureDetail = await pureImport.json() as { packageHandle: string; modelProfiles: string[]; modelRequirements: unknown[] };
  const { packageHandle } = pureDetail;
  check(pureDetail.modelProfiles.length === 0 && pureDetail.modelRequirements.length === 0, 'unused embedding declarations do not require a live connection');
  const pureReadiness = await fetch(origin + `/api/packages/${packageHandle}/validate`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"modelBindings":{}}' });
  check(pureReadiness.ok && (await pureReadiness.json() as { ready: boolean }).ready, 'model-free document and keyword workflow is ready');
  const source = '서울 배송 안내입니다. 주문 후 배송은 영업일 3일 이내입니다.\n원문과 검색 인용을 그대로 보존합니다.';
  const started = await fetch(origin + '/api/runs', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ packageHandle, requestId: 'bundled-document-search', inputs: { source }, modelBindings: {} }) });
  check(started.status === 202, 'model-free workflow started through authenticated API');
  const { runId } = await started.json() as { runId: string };
  type Status = { status: string; usage: { modelCalls: number }; result?: { data: { document: { text: string }; search: { context: string; contextBudget: { tokenCount: number; encoding: string }; citations: { quote: string }[] } } }; files: { reference: { id: string } }[] };
  let completed: Status | undefined; const runDeadline = Date.now() + 20000;
  do { const response = await fetch(origin + `/api/runs/${runId}`, { headers }); if (!response.ok) throw new Error('Cannot inspect bundled run'); completed = await response.json() as Status; if (!['queued', 'running'].includes(completed.status)) break; await delay(100); } while (Date.now() < runDeadline);
  check(completed?.status === 'succeeded' && completed.usage.modelCalls === 0, 'bundled document and keyword runtime completes without model calls');
  check(completed.result?.data.document.text === source && completed.result.data.search.context.includes(source) && completed.result.data.search.citations.some(citation => citation.quote === source), 'bundled extraction and citations preserve the original text');
  check(completed.result.data.search.contextBudget.encoding === 'o200k_base' && completed.result.data.search.contextBudget.tokenCount > 0 && completed.result.data.search.contextBudget.tokenCount <= 500, 'bundled real tokenizer enforces the context budget');
  check(completed.files.length === 1, 'managed output file is registered to the completed run');
  const download = await fetch(origin + `/api/runs/${runId}/artifacts/${completed.files[0]!.reference.id}`, { headers });
  check(download.ok && (await download.text()) === source, 'bundled managed artifact downloads the exact original bytes');
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
