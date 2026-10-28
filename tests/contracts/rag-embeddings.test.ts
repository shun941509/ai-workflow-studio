import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EMBEDDING_CONTRACT, embeddingBatches, embeddingProfile, measureEmbeddingInputs } from '../../apps/runner/src/providers/embedding-contract.js';
import { EmbeddingBroker } from '../../apps/runner/src/providers/embedding-broker.js';
import { OpenAIEmbeddingProvider, type EmbeddingProvider } from '../../apps/runner/src/providers/embedding-provider.js';
import { ModelBroker } from '../../apps/runner/src/providers/model-broker.js';
import { ModelError } from '../../apps/runner/src/providers/model-provider.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { buildLocalSearchIndex, createCorpusGeneration, openLocalSearchProvider, sealIndexGeneration, embeddingFingerprint, type Candidate } from '@studio/rag-core';
import { buildRunRagContext, countRagContextTokens } from '../../apps/runner/src/rag/context-tokenizer.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';

const profile = { id: 'embedding_profile', name: 'Test only', kind: 'embedding' as const, provider: 'openai' as const, model: EMBEDDING_CONTRACT.model, credentialRef: 'test-credential' };
const vector = (axis = 0) => Array.from({ length: 256 }, (_, offset) => offset === axis ? 2 : 0);
const credentials: CredentialStore = { available: true, async get() { return 'test-only-key'; }, async has() { return true; }, async set() {}, async delete() {} };
const owned: { directory: string; store?: RunStore }[] = [];
function setup(provider: EmbeddingProvider, budget = 1000, maxCalls = 100) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-embed-contract-')); const store = new RunStore(join(directory, 'state.sqlite')); owned.push({ directory, store });
  store.savePackage({ handle: 'package', filename: 'internal-test.zip', sha256: '0'.repeat(64), name: 'Test', createdAt: new Date().toISOString() });
  const run = store.createRun({ requestId: 'request', requestHash: '0'.repeat(64), packageHandle: 'package', planHash: '1'.repeat(64), plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['node'], edges: [], maxModelCalls: maxCalls, maxTotalTokens: budget });
  return { directory, store, runId: run.id, broker: new EmbeddingBroker(store, credentials, provider) };
}
const success: EmbeddingProvider = { async embed(request) { return { model: request.model, vectors: request.input.map(() => vector()), usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 } }; } };
afterEach(() => { vi.unstubAllGlobals(); for (const item of owned.splice(0)) { item.store?.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-embed-contract-')) throw new Error('unsafe cleanup'); rmSync(path, { recursive: true, force: true }); } });

describe('closed embedding measurement and durable budget', () => {
  it('distinguishes local BPE count, conservative reservation and fixed profile identity', () => {
    expect(measureEmbeddingInputs(['hello world']).localTokens).toBe(2);
    expect(measureEmbeddingInputs(['hello world']).reservedTokens).toBe(75);
    expect(measureEmbeddingInputs(['<|endoftext|>']).localTokens).toBeGreaterThan(1);
    expect(embeddingProfile(profile, 'embed')).toMatchObject({ dimensions: 256, normalization: 'l2', modelRevision: 'unversioned-provider-alias', parameters: { profileId: profile.id, bindingAlias: 'embed' } });
    expect(EMBEDDING_CONTRACT.tokenizer.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => embeddingProfile({ ...profile, model: 'text-embedding-3-large' }, 'embed')).toThrow();
    expect(() => embeddingProfile({ ...profile, kind: 'chat' }, 'embed')).toThrow();
  });
  it.each([[], [''], ['x'.repeat(8129)], ['\ud800'], Array(17).fill('x')])('rejects input bounds before requests %#', value => expect(() => measureEmbeddingInputs(value)).toThrow());
  it('prevalidates every chunk and deterministically batches count and reservation limits', () => {
    expect(embeddingBatches(Array(17).fill('hello')).map(batch => batch.length)).toEqual([16, 1]);
    expect(embeddingBatches(Array(9).fill('word '.repeat(1600))).map(batch => batch.length)).toEqual([4, 4, 1]);
    expect(() => measureEmbeddingInputs(['x'.repeat(513)])).toThrow();
    expect(() => embeddingBatches(Array(129).fill('x'))).toThrow();
    expect(() => embeddingBatches(['okay', 'x'.repeat(8129)])).toThrow();
  });
  it('owns request bytes before awaits and settles real usage while preserving measurement evidence', async () => {
    const input = ['original']; let seen = '';
    const item = setup({ async embed(request) { expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.input)).toBe(true); seen = request.input[0]!; return success.embed(request, { apiKey: '', signal: new AbortController().signal }); } });
    const pending = item.broker.invoke(item.runId, 'node', profile, input, new AbortController().signal); input[0] = 'changed';
    expect((await pending)[0]![0]).toBe(1); expect(seen).toBe('original');
    expect(item.store.getRun(item.runId).usage).toEqual({ modelCalls: 1, consumedTokens: 3, reservedTokens: 0 });
    const events = JSON.stringify(item.store.listEvents(item.runId)); expect(events).toContain('localTokens'); expect(events).toContain('reservationRule'); expect(events).not.toContain('original'); expect(events).not.toContain('test-only-key');
  });
  it('shares atomic reservations with Responses and blocks parallel overspending before provider send', async () => {
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const item = setup({ async embed(request, context) { calls++; await barrier; return success.embed(request, context); } }, 100);
    const first = item.broker.invoke(item.runId, 'node', profile, ['hello'], new AbortController().signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    const chat = new ModelBroker(item.store, credentials, { async countInputTokens() { return 1; }, async generate() { throw new Error('must not send'); } });
    await expect(chat.invoke(item.runId, 'node', { ...profile, kind: 'chat' }, { instructions: '', content: 'hello', maxOutputTokens: 40, responseFormat: { mode: 'text' } }, new AbortController().signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(item.broker.invoke(item.runId, 'node', profile, ['hello'], new AbortController().signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    release(); await first; expect(calls).toBe(1);
  });
  it.each(['missing', 'malformed', 'network'] as const)('retains unknown usage reservation: %s', async mode => {
    const item = setup({ async embed(request) { if (mode === 'network') throw new Error('private upstream detail'); return { model: request.model, vectors: [vector()], usage: mode === 'missing' ? null : { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } });
    await expect(item.broker.invoke(item.runId, 'node', profile, ['hello'], new AbortController().signal)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(item.store.getRun(item.runId).usage).toEqual({ modelCalls: 1, consumedTokens: 0, reservedTokens: 69 });
  });
  it('charges overrun and stops, while 429 is not automatically retried', async () => {
    const item = setup({ async embed(request) { return { model: request.model, vectors: [vector()], usage: { inputTokens: 70, outputTokens: 0, totalTokens: 70 } }; } });
    await expect(item.broker.invoke(item.runId, 'node', profile, ['hello'], new AbortController().signal)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', outcome: 'completed' }); expect(item.store.getRun(item.runId).usage.consumedTokens).toBe(70);
    let calls = 0; const refused = setup({ async embed() { calls++; throw new ModelError('RATE_LIMITED', 'rejected', 'not_started', true); } });
    await expect(refused.broker.invoke(refused.runId, 'node', profile, ['hello'], new AbortController().signal)).rejects.toMatchObject({ retryable: false }); expect(calls).toBe(1); expect(refused.store.getRun(refused.runId).usage.reservedTokens).toBe(0);
  });
  it('cancellation before send has no reservation; cancellation after send retains unknown budget', async () => {
    const controller = new AbortController(); const item = setup({ async embed() { controller.abort(); throw new Error('connection lost'); } });
    await expect(item.broker.invoke(item.runId, 'node', profile, ['hello'], AbortSignal.abort())).rejects.toMatchObject({ outcome: 'not_started' }); expect(item.store.getRun(item.runId).usage.modelCalls).toBe(0);
    await expect(item.broker.invoke(item.runId, 'node', profile, ['hello'], controller.signal)).rejects.toMatchObject({ outcome: 'unknown' }); expect(item.store.getRun(item.runId).usage.reservedTokens).toBe(69);
  });
  it('migrates old profile rows to chat atomically and persists explicit embedding profiles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-embed-contract-')); const path = join(directory, 'state.sqlite'); const old = new DatabaseSync(path);
    old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(8,'past'); CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT,provider TEXT,model TEXT,credential_ref TEXT); INSERT INTO profiles VALUES('old','old','openai','text-embedding-3-small','old-credential');"); old.close();
    const store = new RunStore(path); owned.push({ directory, store }); expect(store.getProfile('old').kind).toBeUndefined(); store.saveProfile(profile); expect(store.getProfile(profile.id).kind).toBe('embedding');
    store.close(); const reopened = new RunStore(path); owned.at(-1)!.store = reopened; expect(reopened.getProfile(profile.id).kind).toBe('embedding'); expect(reopened.getProfile('old').kind).toBeUndefined();
  });
});

describe('OpenAI Embeddings wire boundary (test transport only)', () => {
  const request = { model: EMBEDDING_CONTRACT.model, dimensions: 256, input: ['first', 'second'] };
  const context = { apiKey: 'test-only-key', signal: new AbortController().signal };
  const response = () => ({ object: 'list', model: String(request.model), data: [{ object: 'embedding', index: 1, embedding: vector(1) }, { object: 'embedding', index: 0, embedding: vector(0) }], usage: { prompt_tokens: 2, total_tokens: 2 } });
  it('uses only the fixed origin/body, rejects redirects and maps explicit response indices', async () => {
    const sent: unknown[] = []; vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { sent.push(url, JSON.parse(String(options.body)), options.redirect); return Response.json(response()); });
    const result = await new OpenAIEmbeddingProvider().embed(request, context);
    expect(sent).toEqual(['https://api.openai.com/v1/embeddings', { model: request.model, dimensions: 256, input: request.input, encoding_format: 'float' }, 'error']); expect(result.vectors[0]![0]).toBe(1); expect(result.vectors[1]![1]).toBe(1); expect(result.usage?.totalTokens).toBe(2);
  });
  it.each([401, 403, 429, 500, 302])('classifies HTTP %s without disclosing body or retrying', async status => {
    const fetcher = vi.fn(async () => new Response('private source and secret', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(new OpenAIEmbeddingProvider().embed(request, context)).rejects.toMatchObject({ outcome: status >= 400 && status < 500 ? 'not_started' : 'unknown', retryable: false }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['model', 'dimension', 'zero', 'index', 'cardinality', 'duplicate-json', 'oversize', 'utf8'])('fails closed on %s response', async mode => {
    const value = response(); if (mode === 'model') value.model = 'unknown'; if (mode === 'dimension') value.data[0]!.embedding.pop(); if (mode === 'zero') value.data[0]!.embedding.fill(0); if (mode === 'index') value.data[0]!.index = 0; if (mode === 'cardinality') value.data.pop();
    vi.stubGlobal('fetch', async () => new Response(mode === 'duplicate-json' ? '{"object":"list","object":"list"}' : mode === 'oversize' ? 'x'.repeat(512 * 1024 + 1) : mode === 'utf8' ? new Uint8Array([0xc3, 0x28]) : JSON.stringify(value)));
    await expect(new OpenAIEmbeddingProvider().embed(request, context)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('never sends unknown models, altered dimensions or already cancelled requests', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(new OpenAIEmbeddingProvider().embed({ ...request, model: 'unknown' }, context)).rejects.toThrow();
    await expect(new OpenAIEmbeddingProvider().embed({ ...request, dimensions: 1536 }, context)).rejects.toThrow();
    await expect(new OpenAIEmbeddingProvider().embed(request, { ...context, signal: AbortSignal.abort() })).rejects.toMatchObject({ outcome: 'not_started' }); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('source provenance and bounded synchronous tokenizer work', () => {
  it('refuses long/repeated work for both encodings before BPE instead of relying on a timer', () => {
    const started = performance.now();
    expect(() => measureEmbeddingInputs(['x'.repeat(8000)])).toThrow();
    expect(() => countRagContextTokens('x'.repeat(8000))).toThrow(/work limit/);
    expect(() => countRagContextTokens('x'.repeat(400) + ' ' + 'y'.repeat(400))).toThrow(/work limit/);
    expect(() => countRagContextTokens('a '.repeat(9000))).toThrow(/work limit/);
    expect(() => embeddingBatches(Array(16).fill('x'.repeat(400)))).toThrow(/작업량/);
    expect(performance.now() - started).toBeLessThan(3000); // A regression detector, not a promised OS deadline.
  });
  it('charges repeated whole-context trials cumulatively while preserving admitted exact token counts', async () => {
    expect(countRagContextTokens('hello world')).toBe(2);
    const base = await createCorpusGeneration({ scope: { tenantId: 'tenant', projectId: 'project' }, corpusId: 'corpus', generationId: 'generation', documents: [{ documentId: 'doc', revision: 1, sourceUri: 'urn:test:doc', originalBytes: Buffer.from('word '.repeat(40)), extractedText: 'word '.repeat(40), extraction: { id: 'test', version: '1', options: {} } }], chunks: [{ chunkId: 'chunk', documentId: 'doc', start: 0, end: 200 }] });
    const bundle = await buildLocalSearchIndex({ corpus: base, indexId: 'index', generationId: 'generation', kind: 'keyword' });
    const candidates: Candidate[] = Array.from({ length: 64 }, (_, i) => ({ id: `test-${i}`, index: bundle.index.ref, chunk: base.chunks[0]!.ref, text: base.chunks[0]!.text, rank: i + 1, stages: {} }));
    expect(() => buildRunRagContext(candidates, 200000)).toThrow(/work limit/);
  });
  it('pins source chunk hashes and rejects a re-sealed vector inventory with false provenance', async () => {
    const corpus = await createCorpusGeneration({ scope: { tenantId: 'tenant', projectId: 'project' }, corpusId: 'corpus', generationId: 'generation', documents: [{ documentId: 'doc', revision: 1, sourceUri: 'urn:test:doc', originalBytes: Buffer.from('hello'), extractedText: 'hello', extraction: { id: 'test', version: '1', options: {} } }], chunks: [{ chunkId: 'chunk', documentId: 'doc', start: 0, end: 5 }] });
    const profileValue = embeddingProfile(profile, 'embed'); const unit = vector().map(number => number / 2);
    const bundle = await buildLocalSearchIndex({ corpus, indexId: 'index', generationId: 'generation', kind: 'vector', embeddingProfile: profileValue, embeddings: [{ chunkId: 'chunk', vector: unit }] });
    const artifact = JSON.parse(Buffer.from(bundle.artifacts[0]!.bytes).toString()) as { rows: { sourceChunkSha256: string }[] }; expect(artifact.rows[0]!.sourceChunkSha256).toBe(corpus.chunks[0]!.ref.sha256); artifact.rows[0]!.sourceChunkSha256 = '0'.repeat(64);
    const artifacts = [{ id: bundle.artifacts[0]!.id, bytes: Buffer.from(JSON.stringify(artifact)) }]; const changed = await sealIndexGeneration({ corpus: corpus.ref, indexId: 'index', generationId: 'generation', kind: 'vector', embeddingProfile: profileValue, artifacts });
    await expect(openLocalSearchProvider({ corpus, index: changed, artifacts })).rejects.toMatchObject({ code: 'LOCAL_VECTOR_PROVENANCE' });
    const provider = await openLocalSearchProvider(bundle, { async embed() { return { fingerprint: await embeddingFingerprint({ ...profileValue, tokenizerRevision: 'unknown' }), vector: unit }; } });
    await expect(provider.search({ index: bundle.index.ref, query: 'hello', channel: 'vector', allowedDocumentIds: ['doc'], authorizationEpoch: 1, limit: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'EMBEDDING_MISMATCH' });
  });
  it('atomically refuses activation when authority changes during immutable-byte verification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-embed-contract-')); owned.push({ directory }); const store = new SqliteRagStore(join(directory, 'rag.sqlite'));
    const scope = { tenantId: 'tenant', projectId: 'project' }; const document = { documentId: 'doc', revision: 1, sourceUri: 'urn:test:doc', originalBytes: Buffer.from('hello'), extractedText: 'hello', extraction: { id: 'test', version: '1', options: {} } };
    try {
      store.createScope(scope); const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'generation', documents: [document], chunks: [{ chunkId: 'chunk', documentId: 'doc', start: 0, end: 5 }] });
      const bundle = await buildLocalSearchIndex({ corpus, indexId: 'index', generationId: 'generation', kind: 'vector', embeddingProfile: embeddingProfile(profile, 'embed'), embeddings: [{ chunkId: 'chunk', vector: vector().map(value => value / 2) }] }); const ref = await store.stageGeneration({ ...bundle, documents: [document] });
      const access = [{ documentId: 'doc', revision: 1, tombstoned: false, allowedSubjects: ['reader'], allowedGroups: [] }]; store.replaceAccess(scope, { expectedEpoch: 1, subjects: [{ subjectId: 'reader', groupIds: [] }], documents: access });
      const pending = store.activate(scope, ref, null, { subjectId: 'reader', epoch: 2 }); store.replaceAccess(scope, { expectedEpoch: 2, subjects: [{ subjectId: 'reader', groupIds: [] }], documents: access.map(value => ({ ...value, tombstoned: true })) });
      await expect(pending).rejects.toMatchObject({ code: 'RAG_AUTHORIZATION_CHANGED' }); expect(store.getActiveIndex(scope, ref.indexId)).toBeNull();
    } finally { store.close(); }
  });
});
