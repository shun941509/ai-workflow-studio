import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBasicWorkflow, createNode, type Binding, type FileRef, type Workflow, type WorkflowNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import type { IndexRef } from '@studio/rag-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { buildRunRagContext } from '../../apps/runner/src/rag/context-tokenizer.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { RunRagRuntime } from '../../apps/runner/src/rag/run-runtime.js';
import { RERANK_CONTRACT } from '../../apps/runner/src/providers/rerank-contract.js';
import { EMBEDDING_CONTRACT } from '../../apps/runner/src/providers/embedding-contract.js';
import { ModelError, type ModelProvider, type ModelRequest, type ModelResponse } from '../../apps/runner/src/providers/model-provider.js';
import type { EmbeddingProvider } from '../../apps/runner/src/providers/embedding-provider.js';
import { WindowsCredentialStore, type CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { createBridge } from '../../apps/runner/src/mcp/bridge.js';

const make = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const from = (nodeId: string): Binding => ({ from: 'node', nodeId, pointer: '/data', onMissing: 'error' });
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
type Mode = 'keyword' | 'vector' | 'hybrid';
function definition(mode: Mode = 'keyword', pause = false): Workflow {
  const input = make('input', 'input'), files = make('file_input', 'files'), build = make('knowledge', 'build'), search = make('retrieval', 'search'), output = make('output', 'output');
  files.config = { mimeTypes: ['text/plain'], maxFiles: 2, maxBytesPerFile: 100000 }; files.inputBindings = { files: { from: 'literal', value: [] } };
  build.config = { operation: 'build', profile: mode === 'keyword' ? 'local-run-keyword-v1' : 'local-run-embedding-v1', indexSettings: { kind: mode, chunkSize: 1000, chunkOverlap: 0, ...(mode !== 'keyword' ? { embeddingProfile: 'embed' } : {}) } }; build.inputBindings = { documents: from('files') };
  search.config = { mode, topK: 1, candidateLimit: 2, maxContextTokens: 300, reranker: { modelProfile: 'rank', timeoutMs: 10000, onFailure: 'fail' }, ...(mode === 'hybrid' ? { keywordTopK: 2, vectorTopK: 2, fusion: { method: 'rrf' as const, k: 60 } } : {}) }; search.inputBindings = { index: from('build'), query: { from: 'literal', value: '배송' } };
  output.inputBindings = { result: from('search') }; const nodes: Workflow['nodes'] = [input, files, build];
  if (pause) { const form = make('form', 'pause'); form.config = { mode: 'request', title: '검색 계속', schema: true }; form.inputBindings = {}; nodes.push(form); }
  nodes.push(search, output);
  return { ...createBasicWorkflow('실행별 재순위'), inputs: true, outputs: true, modelProfiles: { rank: { kind: 'reranker', requiredFeatures: ['rerank'] }, ...(mode !== 'keyword' ? { embed: { kind: 'embedding' as const, requiredFeatures: ['embedding'] } } : {}) }, nodes, entryNodeId: 'input', edges: nodes.slice(0, -1).map((node, index) => edge(node.id, nodes[index + 1]!.id)) };
}
const searchNode = (workflow: Workflow) => workflow.nodes.find(node => node.type === 'retrieval')! as Extract<WorkflowNode, { type: 'retrieval' }>;
type Hook = (request: ModelRequest, signal: AbortSignal) => Promise<void> | void;
/** Only provider/OS-secret boundaries are substituted. Bytes, SQLite, search, ranking and loopback routes are actual implementations. */
function fixtureProvider(options: { count?: Hook; generate?: Hook; output?: (request: ModelRequest) => ModelResponse; counted?: number } = {}) {
  const counted: ModelRequest[] = [], generated: ModelRequest[] = [];
  const provider: ModelProvider = {
    async countInputTokens(request, context) { counted.push(structuredClone(request)); await options.count?.(request, context.signal); return options.counted ?? 10; },
    async generate(request, context) {
      generated.push(structuredClone(request)); await options.generate?.(request, context.signal);
      return options.output?.(request) ?? { model: request.model, text: JSON.stringify({ items: (request.content as { candidates: { id: string }[] }).candidates.map((candidate, index) => ({ id: candidate.id, score: index * 100 })) }), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    },
  }; return { provider, counted, generated };
}
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; server: ReturnType<typeof createLocalServer>; origin: string; workflow: Workflow; packageBytes: Uint8Array; model: ReturnType<typeof fixtureProvider>; embedding: EmbeddingProvider; embeddingCalls: string[][]; getHook?: () => void; runId?: string; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> } }
const fixtures: Fixture[] = [];
async function setup(workflow = definition(), host: 'codex' | 'claude-code' | 'opencode' = 'codex', model = fixtureProvider()): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-rerank-run-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); let item: Fixture;
  const credentials: CredentialStore = { available: true, async get(id) { item?.getHook?.(); const key = secrets.get(id); if (!key) throw new Error('missing test secret'); return key; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const embeddingCalls: string[][] = []; const embedding: EmbeddingProvider = { async embed(request) { embeddingCalls.push([...request.input]); return { model: request.model, vectors: request.input.map(() => Array.from({ length: 256 }, (_, index) => index === 0 ? 1 : 0)), usage: { inputTokens: request.input.length, outputTokens: 0, totalTokens: request.input.length } }; } };
  const service = new RunnerService(store, credentials, directory, model.provider, buildRunRagContext, embedding); const server = createLocalServer(service, { bearerToken: 'test-rerank-bridge' }); const { origin } = await server.listen();
  const profile = await service.createProfile({ name: '재순위 테스트', kind: 'reranker', model: RERANK_CONTRACT.model, apiKey: 'test-only-no-live-key' });
  const bindings: Record<string, string> = { rank: profile.id }; if (workflow.modelProfiles.embed) bindings.embed = (await service.createProfile({ name: '임베딩 테스트', kind: 'embedding', model: EMBEDDING_CONTRACT.model, apiKey: 'test-only-embed-key' })).id;
  const pack = await buildPackage({ workflow, host }); const imported = await service.importPackage(pack.bytes);
  item = { directory, store, service, credentials, server, origin, workflow, packageBytes: pack.bytes, model, embedding, embeddingCalls, request: { packageHandle: imported.packageHandle, requestId: randomUUID(), inputs: {}, modelBindings: bindings } }; fixtures.push(item); return item;
}
async function session(item: Fixture) {
  const response = await fetch(`${item.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin: item.origin, 'sec-fetch-site': 'same-origin' }, body: '{}' }); const body = await response.json() as { csrf: string };
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-studio-csrf': body.csrf, origin: item.origin, 'sec-fetch-site': 'same-origin' };
}
async function fillFiles(item: Fixture, runId: string, texts = ['배송 안내 A.', '배송 안내 B.']) {
  item.runId = runId; await item.service.waitForIdle(); const run = item.service.status(runId); expect(run.status).toBe('waiting'); const wait = run.waits[0]!; const files: FileRef[] = [];
  for (let index = 0; index < texts.length; index++) {
    const response = await fetch(`${item.origin}/api/runs/${runId}/waits/${wait.id}/files`, { method: 'POST', headers: { ...await session(item), 'content-type': 'application/octet-stream', 'x-studio-filename': encodeURIComponent(`정책${index}.txt`), 'x-studio-mime-type': 'text/plain', 'x-studio-upload-id': `upload-${index}` }, body: new TextEncoder().encode(texts[index]!) }); expect(response.status).toBe(201); files.push(await response.json() as FileRef);
  }
  item.service.respondWait(runId, wait.id, { requestId: randomUUID(), response: files }); await item.service.waitForIdle(); return item.service.status(runId);
}
async function complete(item: Fixture, texts?: string[]) { return fillFiles(item, (await item.service.start(item.request)).runId, texts); }
function mutateAccess(item: Fixture, action: 'tombstone' | 'group' | 'grant_group') {
  const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite')); const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite'));
  try { const principal = ledger.principal(item.runId!); const current = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: current.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: action === 'grant_group' ? ['team'] : [] }], documents: current.documents.map(doc => action === 'tombstone' ? { ...doc, tombstoned: true } : action === 'grant_group' ? { ...doc, allowedSubjects: [], allowedGroups: ['team'] } : doc) }); }
  finally { db.close(); ledger.close(); }
}
async function restart(item: Fixture) {
  await item.service.shutdown(); await item.server.close(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.store.recoverInterruptedRuns(); item.service = new RunnerService(item.store, item.credentials, item.directory, item.model.provider, buildRunRagContext, item.embedding); item.server = createLocalServer(item.service, { bearerToken: 'test-rerank-bridge' }); item.origin = (await item.server.listen()).origin; await item.service.restoreWaitingRuns();
}
afterEach(async () => { vi.restoreAllMocks(); for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); const directory = resolve(item.directory); if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('studio-rerank-run-')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); } });

describe('actual run-local reranker pipeline', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP uploads real bytes and ranks candidateLimit before topK', async host => {
    const item = await setup(definition(), host); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).ready).toBe(true); expect(item.model.counted).toHaveLength(0);
    const run = await complete(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(run.usage).toMatchObject({ modelCalls: 1, consumedTokens: 30, reservedTokens: 0 });
    const result = run.result as { data: { rerank: { status: string; candidateCount: number }; candidates: { id: string; rank: number; stages: { keyword: { rank: number }; reranker: { score: number } } }[]; citations: { candidateId: string; quote: string }[] } };
    expect(result.data.rerank).toMatchObject({ status: 'reranked', candidateCount: 2 }); expect(result.data.candidates).toHaveLength(1); expect(result.data.candidates[0]!.stages.keyword.rank).toBe(2); expect(result.data.candidates[0]!.stages.reranker.score).toBe(100); expect(result.data.candidates[0]!.rank).toBe(1); expect(result.data.citations[0]!.candidateId).toBe(result.data.candidates[0]!.id);
    const audit = item.service.events(run.id).find(event => event.type === 'rag.rerank')!; expect(audit.payload).toMatchObject({ status: 'reranked', ranks: expect.arrayContaining([expect.objectContaining({ before: 2, after: 1, score: 100 })]) }); expect(JSON.stringify(audit)).not.toContain('배송');
    expect((await item.service.start(item.request)).runId).toBe(run.id); expect(item.model.generated).toHaveLength(1);
    const response = await fetch(`${item.origin}/api/runs/${run.id}/results`, { headers: { authorization: 'Bearer test-rerank-bridge' } }); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).toContain('reranked');
  });
  it.each(['vector', 'hybrid'] as const)('%s retains distinct raw/RRF/reranker stages and shares embedding usage', async mode => {
    const item = await setup(definition(mode)); const run = await complete(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(run.usage.modelCalls).toBe(3); expect(item.embeddingCalls).toHaveLength(2);
    const stages = (run.result as { data: { candidates: { stages: Record<string, unknown> }[] } }).data.candidates[0]!.stages; expect(stages.vector).toBeDefined(); expect(stages.reranker).toBeDefined(); if (mode === 'hybrid') { expect(stages.rrf).toBeDefined(); expect(stages.keyword).toBeDefined(); }
  });
  it('does not promote chat connections and rejects unknown model/overridden fixed fields', async () => {
    const item = await setup(); const chat = await item.service.createProfile({ name: 'chat', model: RERANK_CONTRACT.model, apiKey: 'test' }); expect((await item.service.validate(item.request.packageHandle, { rank: chat.id })).ready).toBe(false);
    await expect(item.service.createProfile({ name: 'bad', kind: 'reranker', model: 'gpt-5.4-mini', apiKey: 'test' })).rejects.toMatchObject({ code: 'RERANK_PROFILE_UNSUPPORTED' });
    await expect(item.service.createProfile({ name: 'bad', kind: 'reranker', model: RERANK_CONTRACT.model, apiKey: 'test', endpoint: 'https://example.invalid' })).rejects.toMatchObject({ code: 'RERANK_PROFILE_UNSUPPORTED' }); expect(JSON.stringify(item.service.listProfiles())).not.toContain('credentialRef'); expect(item.model.counted).toHaveLength(0);
  });
  it.each(['before_count', 'before_generate', 'after_generate'] as const)('tombstone %s cannot disclose a later stage or return successful fallback', async stage => {
    let item: Fixture; const workflow = definition(); searchNode(workflow).config.reranker!.onFailure = 'use_original';
    const model = fixtureProvider({ count: () => { if (stage === 'before_generate') mutateAccess(item, 'tombstone'); }, generate: () => { if (stage === 'after_generate') mutateAccess(item, 'tombstone'); } }); item = await setup(workflow, 'codex', model); if (stage === 'before_count') item.getHook = () => mutateAccess(item, 'tombstone');
    const run = await complete(item); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('RAG_DISCLOSURE_CHANGED'); expect(run.result).toBeNull(); expect(model.counted).toHaveLength(stage === 'before_count' ? 0 : 1); expect(model.generated).toHaveLength(stage === 'after_generate' ? 1 : 0); expect(run.usage.reservedTokens).toBe(0);
  });
  it('a group grant after the first observation already blocks wait resume without sending a count', async () => {
    let item: Fixture; const model = fixtureProvider({ count: () => mutateAccess(item, 'group') }); item = await setup(definition('keyword', true), 'codex', model); const paused = await complete(item); expect(paused.status).toBe('waiting'); mutateAccess(item, 'grant_group');
    expect(() => item.service.respondWait(paused.id, paused.waits.find(wait => wait.nodeId === 'pause')!.id, { requestId: randomUUID(), response: {} })).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_CHANGED' })); expect(item.service.status(paused.id).disclosure.allowed).toBe(false); expect(model.counted).toHaveLength(0); expect(model.generated).toHaveLength(0);
  });
  it('explicit fallback is recorded for a confirmed 429 without retrying a completed retrieval attempt', async () => {
    const workflow = definition(); const node = searchNode(workflow); node.config.reranker!.onFailure = 'use_original'; node.execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['RATE_LIMITED'] };
    const model = fixtureProvider({ generate: () => { throw new ModelError('RATE_LIMITED', 'test rate limit', 'not_started', true); } }); const item = await setup(workflow, 'codex', model); const run = await complete(item); expect(run.status).toBe('succeeded'); expect(run.result).toMatchObject({ data: { rerank: { status: 'fallback', failureCode: 'RATE_LIMITED' }, candidates: [{ rank: 1 }] } }); expect(model.generated).toHaveLength(1); expect(run.usage).toMatchObject({ consumedTokens: 0, reservedTokens: 0 });
    const rag = new RunRagRuntime(join(item.directory, 'rag'), () => { throw new Error('No files read during replay'); }, buildRunRagContext);
    try { const index = (item.store.graphState(run.id).nodes.find(node => node.nodeId === 'build')!.result as { data: IndexRef }).data; await expect(rag.execute(run.id, 'search', node, { index, query: '배송' }, { signal: new AbortController().signal, checkpoint() {} })).rejects.toMatchObject({ code: 'RAG_REPLAY_FORBIDDEN' }); } finally { rag.close(); }
  });
  it('fail policy and configured node retries do not replay an external ranking', async () => {
    const workflow = definition(); searchNode(workflow).execution.retry = { maxAttempts: 3, backoffMs: 1, retryOn: ['RATE_LIMITED'] }; const model = fixtureProvider({ generate: () => { throw new ModelError('RATE_LIMITED', 'test', 'not_started', true); } }); const item = await setup(workflow, 'codex', model); const run = await complete(item); expect(run.status).toBe('failed'); expect(model.generated).toHaveLength(1);
  });
  it.each(['missing_usage', 'network', 'invalid_id', 'wrong_model'] as const)('%s is never hidden by use_original', async mode => {
    const workflow = definition(); searchNode(workflow).config.reranker!.onFailure = 'use_original'; const model = fixtureProvider({ generate: () => { if (mode === 'network') throw new ModelError('MODEL_NETWORK_ERROR', 'unknown', 'unknown'); }, output: request => ({ model: mode === 'wrong_model' ? 'other' : request.model, text: JSON.stringify({ items: (request.content as { candidates: { id: string }[] }).candidates.map((item, i) => ({ id: mode === 'invalid_id' ? 'outside' : item.id, score: i })) }), usage: mode === 'missing_usage' ? null : { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }) }); const item = await setup(workflow, 'codex', model); const run = await complete(item); expect(run.status).toBe(mode === 'network' || mode === 'missing_usage' ? 'attention_required' : 'failed'); expect(run.result).toBeNull(); expect(run.usage.reservedTokens > 0).toBe(mode === 'network' || mode === 'missing_usage');
    await restart(item); expect(item.service.status(run.id).usage.reservedTokens).toBe(run.usage.reservedTokens); expect(model.generated).toHaveLength(1);
  });
  it('count failure never generates and default fail does not invent a ranking', async () => {
    const item = await setup(definition(), 'codex', fixtureProvider({ count: () => { throw new ModelError('MODEL_COUNT_INVALID', 'test', 'not_started'); } })); const run = await complete(item); expect(run.status).toBe('failed'); expect(item.model.generated).toHaveLength(0); expect(run.usage.modelCalls).toBe(0);
  });
  it('insufficient counted-token budget prevents generation without fallback', async () => {
    const workflow = definition(); workflow.policy.limits.maxTotalTokens = 4100; searchNode(workflow).config.reranker!.onFailure = 'use_original'; const item = await setup(workflow); const run = await complete(item); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('BUDGET_EXCEEDED'); expect(item.model.generated).toHaveLength(0); expect(run.usage.reservedTokens).toBe(0);
  });
  it('embedding and reranking cannot spend separate model-call allowances', async () => {
    const workflow = definition('hybrid'); workflow.policy.limits.maxModelCalls = 2; const item = await setup(workflow); const run = await complete(item); expect(run.status).toBe('blocked'); expect(item.embeddingCalls).toHaveLength(2); expect(item.model.counted).toHaveLength(0);
  });
  it('cancellation after count stops before generation', async () => {
    let item: Fixture; const model = fixtureProvider({ count: () => { item.service.cancel(item.runId!); } }); item = await setup(definition(), 'codex', model); const run = await complete(item); expect(run.status).toBe('cancelled'); expect(model.generated).toHaveLength(0); expect(run.usage.reservedTokens).toBe(0);
    await restart(item); expect(item.service.status(run.id).status).toBe('cancelled'); expect(model.counted).toHaveLength(1); expect(model.generated).toHaveLength(0);
  });
  it('cancellation with confirmed completed usage settles the bill and publishes no result', async () => {
    let item: Fixture; const model = fixtureProvider({ generate: () => { item.service.cancel(item.runId!); } }); item = await setup(definition(), 'codex', model); const run = await complete(item); expect(run.status).toBe('cancelled'); expect(run.result).toBeNull(); expect(run.usage).toMatchObject({ consumedTokens: 30, reservedTokens: 0 });
    await restart(item); expect(item.service.status(run.id).status).toBe('cancelled'); expect(model.generated).toHaveLength(1);
  });
  it('cancellation after dispatch retains unknown usage and attention_required across restart', async () => {
    let item: Fixture; const model = fixtureProvider({ generate: () => { item.service.cancel(item.runId!); throw new ModelError('MODEL_INTERRUPTED', 'test unknown cancellation', 'unknown'); } }); item = await setup(definition(), 'codex', model); const run = await complete(item); expect(run.status).toBe('attention_required'); expect(run.usage).toMatchObject({ consumedTokens: 0, reservedTokens: 4106 }); expect(run.result).toBeNull();
    await restart(item); expect(item.service.status(run.id)).toMatchObject({ status: 'attention_required', usage: { reservedTokens: 4106 } }); expect(model.generated).toHaveLength(1);
  });
  it('a profile changed during count cannot receive generation or release an unknown claim', async () => {
    let item: Fixture; const model = fixtureProvider({ count: () => { const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('UPDATE profiles SET model=? WHERE id=?').run('changed', item.request.modelBindings.rank!); db.close(); } }); item = await setup(definition(), 'codex', model); const run = await complete(item); expect(run.status).toBe('failed'); expect(model.generated).toHaveLength(0); expect(run.usage.reservedTokens).toBe(0);
  });
  it('confirmed response token overrun is accounted for and blocks fallback', async () => {
    const workflow = definition(); searchNode(workflow).config.reranker!.onFailure = 'use_original';
    const item = await setup(workflow, 'codex', fixtureProvider({ output: request => ({ model: request.model, text: '{}', usage: { inputTokens: 11, outputTokens: 20, totalTokens: 31 } }) })); const run = await complete(item); expect(run.status).toBe('blocked'); expect(run.usage).toMatchObject({ consumedTokens: 31, reservedTokens: 0 }); expect(run.result).toBeNull();
  });
  it.each(['MODEL_COUNT_UNAVAILABLE', 'MODEL_REFUSAL'] as const)('explicit safe %s fallback retains confirmed usage semantics', async code => {
    const workflow = definition(); searchNode(workflow).config.reranker!.onFailure = 'use_original'; const model = fixtureProvider({ count: () => { if (code === 'MODEL_COUNT_UNAVAILABLE') throw new ModelError(code, 'test', 'not_started'); }, generate: () => { if (code === 'MODEL_REFUSAL') throw new ModelError(code, 'test', 'completed', false, { inputTokens: 10, outputTokens: 20, totalTokens: 30 }); } }); const item = await setup(workflow, 'codex', model); const run = await complete(item); expect(run.status).toBe('succeeded'); expect(run.result).toMatchObject({ data: { rerank: { status: 'fallback', failureCode: code } } }); expect(run.usage.consumedTokens).toBe(code === 'MODEL_REFUSAL' ? 30 : 0);
  });
  it('a dispatched timeout retains unknown reservation and does not become fallback', async () => {
    const workflow = definition(); searchNode(workflow).config.reranker = { modelProfile: 'rank', timeoutMs: 30, onFailure: 'use_original' };
    const model = fixtureProvider({ generate: (_request, signal) => new Promise((_resolve, reject) => { const fail = () => reject(new ModelError('MODEL_INTERRUPTED', 'test', 'unknown')); if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true }); }) }); const item = await setup(workflow, 'codex', model); const run = await complete(item); expect(run.status).toBe('attention_required'); expect(run.usage.reservedTokens).toBeGreaterThan(0); expect(model.generated).toHaveLength(1);
  });
  it('empty results skip the model explicitly and preserve current ACL', async () => {
    const workflow = definition(); searchNode(workflow).inputBindings.query = { from: 'literal', value: '존재하지않는단어' }; const item = await setup(workflow); const run = await complete(item); expect(run.status).toBe('succeeded'); expect(run.result).toMatchObject({ data: { rerank: { status: 'skipped_empty', candidateCount: 0 }, candidates: [], citations: [] } }); expect(item.model.counted).toHaveLength(0);
  });
  it('restart waits for explicit input and rejects changed pinned reranker before consuming it', async () => {
    const item = await setup(definition('keyword', true)); const paused = await complete(item); expect(paused.status).toBe('waiting'); await restart(item); expect(item.model.counted).toHaveLength(0); const wait = item.service.status(paused.id).waits.find(wait => wait.nodeId === 'pause')!;
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('UPDATE profiles SET model=? WHERE id=?').run('changed', item.request.modelBindings.rank!); db.close(); item.service.respondWait(paused.id, wait.id, { requestId: randomUUID(), response: {} }); await item.service.waitForIdle(); expect(item.service.status(paused.id).status).toBe('failed'); expect(item.store.getWait(wait.id).state).toBe('responded'); expect(item.model.counted).toHaveLength(0);
  });
  it('real MCP initialization validates without inference, and explicit start drives the authenticated daemon', async () => {
    const item = await setup(); const directory = join(item.directory, 'mcp-package'); const inspected = await inspectPackage(item.packageBytes);
    for (const [path, bytes] of inspected.files) { const target = resolve(directory, path); if (!target.startsWith(resolve(directory) + '\\')) throw new Error('Unsafe extraction'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    await writeFile(join(item.directory, 'discovery.json'), JSON.stringify({ instanceId: 'test-rerank', port: Number(new URL(item.origin).port), credentialRef: 'runner_bridge' }));
    vi.spyOn(WindowsCredentialStore.prototype, 'get').mockImplementation(async id => { expect(id).toBe('runner_bridge'); return 'test-rerank-bridge'; }); const bridge = await createBridge(directory, item.directory); type Transport = Parameters<typeof bridge.connect>[0]; const responses: Record<string, unknown>[] = []; let id = 0;
    const transport: Transport = { async start() {}, async close() {}, async send(message) { responses.push(message as unknown as Record<string, unknown>); } };
    const call = async (method: string, params: Record<string, unknown>) => { const requestId = ++id; transport.onmessage!({ jsonrpc: '2.0', id: requestId, method, params }); await vi.waitFor(() => expect(responses.some(message => message.id === requestId)).toBe(true)); const response = responses.find(message => message.id === requestId)!; expect(response.error).toBeUndefined(); return response.result as Record<string, unknown>; };
    const tool = async (name: string, args: Record<string, unknown>) => { const result = await call('tools/call', { name, arguments: args }); expect(result.isError, JSON.stringify(result)).not.toBe(true); return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>; };
    try { await bridge.connect(transport); await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); expect((await tool('studio.validate', { modelBindings: item.request.modelBindings })).ready).toBe(true); expect(item.model.counted).toHaveLength(0); const started = await tool('studio.start', { requestId: randomUUID(), inputs: {}, modelBindings: item.request.modelBindings }); await fillFiles(item, String(started.runId)); const result = await tool('studio.results', { runId: started.runId }); expect(JSON.stringify(result)).toContain('reranked'); expect(item.model.generated).toHaveLength(1); }
    finally { await bridge.close(); }
  });
});
