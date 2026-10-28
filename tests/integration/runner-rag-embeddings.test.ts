import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBasicWorkflow, createNode, type Binding, type FileRef, type Workflow, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { buildPackage, canonicalDigest, inspectPackage } from '@studio/package-kit';
import type { IndexRef } from '@studio/rag-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { buildRunRagContext } from '../../apps/runner/src/rag/context-tokenizer.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { EMBEDDING_CONTRACT } from '../../apps/runner/src/providers/embedding-contract.js';
import { ModelError } from '../../apps/runner/src/providers/model-provider.js';
import type { EmbeddingProvider, EmbeddingRequest } from '../../apps/runner/src/providers/embedding-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { WindowsCredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { createBridge } from '../../apps/runner/src/mcp/bridge.js';

const make = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const from = (nodeId: string): Binding => ({ from: 'node', nodeId, pointer: '/data', onMissing: 'error' });
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
const utf8 = (value: string) => new TextEncoder().encode(value);
const source = '배송은 영업일 3일 이내입니다. 배송 문의는 고객센터에서 확인합니다.';

/** The only model substitute lives in this test: storage, search, ranking, bytes, transport and budgets are real. */
function definition(mode: 'vector' | 'hybrid' = 'hybrid', pause = false): Workflow {
  const input = make('input', 'input'), files = make('file_input', 'files'), build = make('knowledge', 'build'), open = make('knowledge', 'open'), search = make('retrieval', 'search'), output = make('output', 'output');
  files.config = { mimeTypes: ['text/plain'], maxFiles: 32, maxBytesPerFile: 2 * 1024 * 1024 }; files.inputBindings = { files: { from: 'literal', value: [] } };
  build.config = { operation: 'build', profile: 'local-run-embedding-v1', indexSettings: { kind: mode, chunkSize: 100, chunkOverlap: 0, embeddingProfile: 'embed' } }; build.inputBindings = { documents: from('files') }; build.execution.timeoutMs = 30000;
  open.config = { operation: 'open' }; open.inputBindings = { index: from('build') };
  search.config = { mode, topK: 5, maxContextTokens: 300, ...(mode === 'hybrid' ? { keywordTopK: 10, vectorTopK: 10, candidateLimit: 10, fusion: { method: 'rrf' as const, k: 60 } } : {}) }; search.inputBindings = { index: from('open'), query: { from: 'literal', value: mode === 'vector' ? '택배' : '배송' } }; search.execution.timeoutMs = 30000;
  output.inputBindings = { result: from('search') }; const nodes: Workflow['nodes'] = [input, files, build];
  if (pause) { const form = make('form', 'pause'); form.config = { mode: 'request', title: '검색 계속', schema: true }; form.inputBindings = {}; nodes.push(form); }
  nodes.push(open, search, output);
  return { ...createBasicWorkflow('실행별 임베딩 검색'), inputs: true, outputs: true, modelProfiles: { embed: { kind: 'embedding', requiredFeatures: ['embedding'] } }, nodes, entryNodeId: 'input', edges: nodes.slice(0, -1).map((node, i) => edge(node.id, nodes[i + 1]!.id)) };
}
const noChat = { async countInputTokens(): Promise<never> { throw new Error('No chat count allowed'); }, async generate(): Promise<never> { throw new Error('No chat call allowed'); } };
function fixtureProvider(hook?: (request: EmbeddingRequest, signal: AbortSignal, call: number) => Promise<void>) {
  const calls: EmbeddingRequest[] = [];
  const provider: EmbeddingProvider = { async embed(request, { signal }) {
    calls.push(structuredClone(request)); await hook?.(request, signal, calls.length);
    return { model: request.model, vectors: request.input.map(text => Array.from({ length: 256 }, (_, i) => i === (/배송|택배/.test(text) ? 0 : 1) ? 1 : 0)), usage: { inputTokens: request.input.length, outputTokens: 0, totalTokens: request.input.length } };
  } };
  return { provider, calls };
}
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; server: ReturnType<typeof createLocalServer>; origin: string; packageBytes: Uint8Array; embeddings: ReturnType<typeof fixtureProvider>; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> } }
const fixtures: Fixture[] = [];
async function setup(workflow = definition(), host: 'codex' | 'claude-code' | 'opencode' = 'codex', embeddings = fixtureProvider()): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-embed-run-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>();
  const credentials: CredentialStore = { available: true, async get(id) { const key = secrets.get(id); if (!key) throw new Error('missing test credential'); return key; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, noChat, buildRunRagContext, embeddings.provider); const server = createLocalServer(service, { bearerToken: 'test-embedding-bridge' }); const { origin } = await server.listen();
  const profile = await service.createProfile({ name: 'Embedding test', kind: 'embedding', model: EMBEDDING_CONTRACT.model, apiKey: 'test-only-embedding-key' });
  const built = await buildPackage({ workflow, host }); const imported = await service.importPackage(built.bytes);
  const item = { directory, store, service, credentials, server, origin, packageBytes: built.bytes, embeddings, request: { packageHandle: imported.packageHandle, requestId: randomUUID(), inputs: {}, modelBindings: { embed: profile.id } } }; fixtures.push(item); return item;
}
async function session(item: Fixture) {
  const response = await fetch(`${item.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin: item.origin, 'sec-fetch-site': 'same-origin' }, body: '{}' });
  const body = await response.json() as { csrf: string }; return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-studio-csrf': body.csrf, origin: item.origin, 'sec-fetch-site': 'same-origin' };
}
async function begin(item: Fixture) { const result = await item.service.start(item.request); await item.service.waitForIdle(); const run = item.service.status(result.runId); expect(run.status).toBe('waiting'); return run; }
async function upload(item: Fixture, runId: string, waitId: string, text = source) {
  const response = await fetch(`${item.origin}/api/runs/${runId}/waits/${waitId}/files`, { method: 'POST', headers: { ...await session(item), 'content-type': 'application/octet-stream', 'x-studio-filename': encodeURIComponent('정책.txt'), 'x-studio-mime-type': 'text/plain', 'x-studio-upload-id': 'upload-one' }, body: utf8(text) }); expect(response.status).toBe(201); return await response.json() as FileRef;
}
async function complete(item: Fixture, text = source) { const run = await begin(item); const file = await upload(item, run.id, run.waits[0]!.id, text); item.service.respondWait(run.id, run.waits[0]!.id, { requestId: randomUUID(), response: [file] }); await item.service.waitForIdle(); return { run: item.service.status(run.id), file }; }
function ref(item: Fixture, runId: string): IndexRef { return (item.store.graphState(runId).nodes.find(node => node.nodeId === 'build')!.result as { data: IndexRef }).data; }
async function restart(item: Fixture) {
  await item.service.shutdown(); await item.server.close(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.store.recoverInterruptedRuns();
  item.service = new RunnerService(item.store, item.credentials, item.directory, noChat, buildRunRagContext, item.embeddings.provider); item.server = createLocalServer(item.service, { bearerToken: 'test-embedding-bridge' }); item.origin = (await item.server.listen()).origin; await item.service.restoreWaitingRuns();
}
afterEach(async () => { vi.restoreAllMocks(); for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-embed-run-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('run-local vector and hybrid execution', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP uploads actual bytes, seals vectors and queries with budgeted RRF', async host => {
    const item = await setup(definition(), host); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).ready).toBe(true); expect(item.embeddings.calls).toHaveLength(0);
    const { run, file } = await complete(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(run.usage.modelCalls).toBe(2); expect(run.usage.reservedTokens).toBe(0);
    const data = (run.result as { data: { candidates: { stages: { rrf?: unknown } }[]; context: string; citations: { chunk: { document: { originalSha256: string } }; quote: string }[] } }).data;
    expect(data.context).toContain('배송'); expect(data.candidates.every(candidate => candidate.stages.rrf)).toBe(true); expect(data.citations[0]!.chunk.document.originalSha256).toBe(file.sha256);
    const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite'));
    try { const index = ref(item, run.id); const bundle = await db.loadGeneration(index.scope, index); expect(bundle.index.embedding?.profile).toMatchObject({ modelId: EMBEDDING_CONTRACT.model, dimensions: 256, normalization: 'l2', modelRevision: 'unversioned-provider-alias' }); expect(Buffer.from(bundle.artifacts[0]!.bytes).toString()).toContain(bundle.corpus.chunks[0]!.ref.sha256); }
    finally { db.close(); }
    expect((await item.service.start(item.request)).runId).toBe(run.id); expect(item.embeddings.calls).toHaveLength(2);
    // The MCP bridge uses this exact authenticated daemon route; credentials and embedding vectors are not accepted as arguments.
    const result = await fetch(`${item.origin}/api/runs/${run.id}/results`, { headers: { authorization: 'Bearer test-embedding-bridge' } }); expect(result.status).toBe(200); expect(JSON.stringify(await result.json())).toContain('배송');
  });
  it('exact vector search returns a source without a keyword match', async () => {
    const item = await setup(definition('vector')); const { run } = await complete(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(JSON.stringify(run.result)).toContain('배송'); expect(item.embeddings.calls[1]!.input).toEqual(['택배']);
  });
  it('a second-batch 429 leaves no partial generation and never retries even with node retry configured', async () => {
    const workflow = definition(); workflow.nodes.find(node => node.id === 'build')!.execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['RATE_LIMITED'] };
    const embeddings = fixtureProvider(async (_request, _signal, call) => { if (call === 2) throw new ModelError('RATE_LIMITED', 'rate limited', 'not_started', true); });
    const item = await setup(workflow, 'codex', embeddings); const { run } = await complete(item, '배송 '.repeat(450)); expect(run.status).toBe('failed'); expect(embeddings.calls).toHaveLength(2); expect(run.usage.modelCalls).toBe(2);
    const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); try { expect(db.statistics().generations).toBe(0); } finally { db.close(); }
    await restart(item); expect(item.service.status(run.id).status).toBe('failed'); expect(embeddings.calls).toHaveLength(2);
  });
  it('rejects an overlarge chunk inventory before the first provider call', async () => {
    const item = await setup(); const { run } = await complete(item, 'x'.repeat(12900)); expect(run.status).toBe('failed'); expect(run.error?.code).toBe('EMBEDDING_CHUNK_LIMIT'); expect(item.embeddings.calls).toHaveLength(0);
  });
  it('retains unknown reservation and never autostarts after a durable restart', async () => {
    const embeddings = fixtureProvider(async () => { throw new ModelError('EMBEDDING_RESULT_UNKNOWN', 'unknown', 'unknown'); }); const item = await setup(definition(), 'codex', embeddings); const { run } = await complete(item);
    expect(run.status).toBe('attention_required'); expect(run.usage.reservedTokens).toBeGreaterThan(0); await restart(item); expect(item.service.status(run.id).usage.reservedTokens).toBe(run.usage.reservedTokens); expect(embeddings.calls).toHaveLength(1);
  });
  it('query embedding consumes the same call limit as generation batches', async () => {
    const workflow = definition(); workflow.policy.limits.maxModelCalls = 1; const item = await setup(workflow); const { run } = await complete(item); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('BUDGET_EXCEEDED'); expect(item.embeddings.calls).toHaveLength(1);
  });
  it('restores a completed generation at a human wait without sending any embedding until explicit response', async () => {
    const item = await setup(definition('vector', true)); const { run } = await complete(item); expect(run.status).toBe('waiting'); expect(item.embeddings.calls).toHaveLength(1); const index = ref(item, run.id);
    await restart(item); expect(item.embeddings.calls).toHaveLength(1); const wait = item.service.status(run.id).waits.find(wait => wait.nodeId === 'pause')!;
    item.service.respondWait(run.id, wait.id, { requestId: randomUUID(), response: {} }); await item.service.waitForIdle(); expect(item.service.status(run.id).status).toBe('succeeded'); expect(ref(item, run.id)).toEqual(index); expect(item.embeddings.calls).toHaveLength(2);
  });
  it.each(['tombstone', 'membership'] as const)('reauthorizes after query embedding await: %s', async mutation => {
    let item: Fixture; const embeddings = fixtureProvider(async (_request, _signal, call) => {
      if (call !== 2) return;
      const runId = item.store.listRuns()[0]!.id; const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite'));
      try { const principal = ledger.principal(runId); const access = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: access.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: mutation === 'membership' ? ['new-group'] : [] }], documents: mutation === 'tombstone' ? access.documents.map(doc => ({ ...doc, tombstoned: true })) : access.documents }); } finally { db.close(); ledger.close(); }
    });
    item = await setup(definition('vector', true), 'codex', embeddings); const { run: paused } = await complete(item);
    item.service.respondWait(paused.id, paused.waits.find(wait => wait.nodeId === 'pause')!.id, { requestId: randomUUID(), response: {} }); await item.service.waitForIdle(); const run = item.service.status(paused.id);
    expect(run.status, JSON.stringify(run.error)).toBe('blocked'); expect(run.result).toBeNull(); expect(run.error?.code).toBe('RAG_DISCLOSURE_CHANGED'); expect(item.embeddings.calls).toHaveLength(2); expect(run.usage.reservedTokens).toBe(0);
  });
  it('rejects a changed profile before consuming a durable human response', async () => {
    const item = await setup(definition('vector', true)); const { run } = await complete(item); const wait = run.waits.find(wait => wait.nodeId === 'pause')!;
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('UPDATE profiles SET model=? WHERE id=?').run('unknown-model', item.request.modelBindings.embed!); db.close();
    item.service.respondWait(run.id, wait.id, { requestId: randomUUID(), response: {} }); await item.service.waitForIdle(); expect(item.service.status(run.id).status).toBe('failed'); expect(item.embeddings.calls).toHaveLength(1); expect(item.store.getWait(wait.id).state).toBe('responded');
  });
  it('revocation during build cannot activate a generation or disclose a later batch', async () => {
    let item: Fixture; const embeddings = fixtureProvider(async () => {
      const runId = item.store.listRuns()[0]!.id; const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite'));
      try { const principal = ledger.principal(runId); const access = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: access.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: access.documents.map(doc => ({ ...doc, tombstoned: true })) }); } finally { db.close(); ledger.close(); }
    });
    item = await setup(definition(), 'codex', embeddings); const { run } = await complete(item, '배송 '.repeat(450)); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('RAG_DISCLOSURE_CHANGED'); expect(embeddings.calls).toHaveLength(1);
    const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); try { expect(db.statistics().generations).toBe(0); } finally { db.close(); }
  });
  it('cancels an in-flight provider request, preserves unknown reservation and exposes no active generation', async () => {
    const embeddings = fixtureProvider(async (_request, signal) => { await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ModelError('EMBEDDING_RESULT_UNKNOWN', 'cancelled', 'unknown')), { once: true })); }); const item = await setup(definition(), 'codex', embeddings);
    const run = await begin(item); const file = await upload(item, run.id, run.waits[0]!.id); item.service.respondWait(run.id, run.waits[0]!.id, { requestId: randomUUID(), response: [file] }); await vi.waitFor(() => expect(embeddings.calls).toHaveLength(1)); item.service.cancel(run.id); await item.service.waitForIdle();
    expect(item.service.status(run.id).status).toBe('attention_required'); expect(item.service.status(run.id).usage.reservedTokens).toBeGreaterThan(0); const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); try { expect(db.statistics().generations).toBe(0); } finally { db.close(); }
  });
  it('keeps external credentials and dimensions behind the local authenticated boundary', async () => {
    const item = await setup(); const bad = await fetch(`${item.origin}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bad', kind: 'embedding', model: EMBEDDING_CONTRACT.model, apiKey: 'test-secret' }) }); expect(bad.status).toBe(401);
    await expect(item.service.createProfile({ name: 'bad', kind: 'embedding', model: EMBEDDING_CONTRACT.model, dimensions: 1536, apiKey: 'test-secret' })).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_UNSUPPORTED' });
    await expect(item.service.createProfile({ name: 'bad', kind: 'embedding', model: 'unknown-model', apiKey: 'test-secret' })).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_UNSUPPORTED' });
    const chat = await item.service.createProfile({ name: 'chat', model: EMBEDDING_CONTRACT.model, apiKey: 'test-secret' }); expect((await item.service.validate(item.request.packageHandle, { embed: chat.id })).ready).toBe(false); expect(item.embeddings.calls).toHaveLength(0);
    expect(JSON.stringify(item.service.listProfiles())).not.toContain('test-secret'); expect(JSON.stringify(item.service.listProfiles())).not.toContain('credentialRef');
  });
  it('MCP initialization has no embedding side effect and explicit start uses the same daemon execution', async () => {
    const item = await setup(definition('vector')); const packageDirectory = join(item.directory, 'mcp-package'); const inspected = await inspectPackage(item.packageBytes);
    for (const [path, bytes] of inspected.files) { const target = resolve(packageDirectory, path); if (!target.startsWith(resolve(packageDirectory) + '\\')) throw new Error('unsafe test extraction'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    await writeFile(join(item.directory, 'discovery.json'), JSON.stringify({ instanceId: 'test-embedding-daemon', port: Number(new URL(item.origin).port), credentialRef: 'runner_bridge' }));
    // Only the OS secret adapter is substituted; actual MCP protocol handlers call the real authenticated local HTTP service.
    vi.spyOn(WindowsCredentialStore.prototype, 'get').mockImplementation(async id => { expect(id).toBe('runner_bridge'); return 'test-embedding-bridge'; });
    const bridge = await createBridge(packageDirectory, item.directory); type Transport = Parameters<typeof bridge.connect>[0]; const responses: Record<string, unknown>[] = [];
    const transport: Transport = { async start() {}, async close() {}, async send(message) { responses.push(message as unknown as Record<string, unknown>); } }; let requestId = 0;
    const call = async (method: string, params: Record<string, unknown>) => { const id = ++requestId; transport.onmessage!({ jsonrpc: '2.0', id, method, params }); await vi.waitFor(() => expect(responses.some(response => response.id === id)).toBe(true)); const response = responses.find(response => response.id === id)!; expect(response.error).toBeUndefined(); return response.result as Record<string, unknown>; };
    const tool = async (name: string, args: Record<string, unknown>) => { const result = await call('tools/call', { name, arguments: args }); expect(result.isError, JSON.stringify(result)).not.toBe(true); return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>; };
    try {
      await bridge.connect(transport); await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'internal-test-client', version: '1' } }); expect(item.embeddings.calls).toHaveLength(0);
      const validation = await tool('studio.validate', { modelBindings: item.request.modelBindings }); expect(validation.ready).toBe(true); expect(item.embeddings.calls).toHaveLength(0);
      const started = await tool('studio.start', { requestId: randomUUID(), inputs: {}, modelBindings: item.request.modelBindings }); await item.service.waitForIdle(); const run = item.service.status(String(started.runId));
      const file = await upload(item, run.id, run.waits[0]!.id); item.service.respondWait(run.id, run.waits[0]!.id, { requestId: randomUUID(), response: [file] }); await item.service.waitForIdle(); const result = await tool('studio.results', { runId: run.id }); expect(JSON.stringify(result)).toContain('배송'); expect(item.embeddings.calls).toHaveLength(2);
    } finally { await bridge.close(); }
  });
});
