import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createNode, type WorkflowNode } from '@studio/spec';
import { validateRunRagNode } from '@studio/workflow-core';
import { createCorpusGeneration, buildLocalSearchIndex, normalizeRankedHits } from '@studio/rag-core';
import { prepareRerank, decodeRerank, rerankProfile, RERANK_CONTRACT, RERANK_CONTRACT_HASH } from '../../apps/runner/src/providers/rerank-contract.js';
import { serializeOpenAIRequest } from '../../apps/runner/src/providers/request.js';
import { OpenAIResponsesProvider } from '../../apps/runner/src/providers/openai.js';
import { RunStore } from '../../apps/runner/src/state/store.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('studio-rerank-contract-')) throw new Error('Unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); } });

/** Build actual sealed evidence so protocol tests use the same candidate identity/provenance as runtime search. */
async function candidates() {
  const text = '배송 안내'; const bytes = new TextEncoder().encode(text);
  const corpus = await createCorpusGeneration({ scope: { tenantId: 'tenant', projectId: 'project' }, corpusId: 'corpus', generationId: 'generation', documents: [{ documentId: 'doc', revision: 1, originalBytes: bytes, extractedText: text, sourceUri: 'urn:test:doc', extraction: { id: 'utf8', version: '1', options: {} } }], chunks: [{ chunkId: 'a', documentId: 'doc', start: 0, end: bytes.length }, { chunkId: 'b', documentId: 'doc', start: 0, end: bytes.length }] });
  const index = await buildLocalSearchIndex({ corpus, indexId: 'index', generationId: 'generation', kind: 'keyword' });
  return normalizeRankedHits({ status: 'ok', index: index.index.ref, corpus: corpus.ref, hits: [{ chunkId: 'a', rank: 1, score: 1 }, { chunkId: 'b', rank: 2, score: 1 }] }, corpus, index.index, 'keyword');
}
const response = (text: string, model: string | undefined = RERANK_CONTRACT.model) => ({ text, model, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });

describe('explicit Responses reranker contract', () => {
  it('sends bounded opaque IDs and exact shared count/generation input with explicit reasoning', async () => {
    const evidence = await candidates(); const prepared = prepareRerank('배송', evidence);
    const wire = serializeOpenAIRequest({ ...prepared.request, model: RERANK_CONTRACT.model });
    const counted = JSON.parse(wire.countBody); const generated = JSON.parse(wire.generationBody);
    expect(counted.reasoning).toEqual({ effort: 'none' }); expect(counted.model).toBe(RERANK_CONTRACT.model);
    expect(counted).toEqual(Object.fromEntries(Object.entries(generated).filter(([key]) => !['store', 'max_output_tokens'].includes(key))));
    expect(counted.input).not.toContain(evidence[0]!.id); expect(JSON.parse(counted.input).candidates.map((item: { id: string }) => item.id)).toEqual(['c1', 'c2']);
    expect(generated.store).toBe(false); expect(generated.max_output_tokens).toBe(4096); expect(RERANK_CONTRACT_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { items: [{ id: 'outside', score: 50 }, { id: 'c2', score: 90 }] },
    { items: [{ id: 'c1', score: 50 }, { id: 'c1', score: 90 }] },
    { items: [{ id: 'c1', score: 50 }] },
    { items: [{ id: 'c1', score: 50.1 }, { id: 'c2', score: 90 }] },
    { items: [{ id: 'c1', score: -1 }, { id: 'c2', score: 101 }] },
    { items: [{ id: 'c1', score: 1, text: 'injected' }, { id: 'c2', score: 2 }] },
  ])('rejects invalid candidate inventory/score %j', async body => {
    const prepared = prepareRerank('query', await candidates()); expect(() => decodeRerank(response(JSON.stringify(body)), prepared, RERANK_CONTRACT_HASH)).toThrow(expect.objectContaining({ code: 'RERANK_RESULT_INVALID' }));
  });
  it('requires the actual response model and accepts only the full original ID inventory', async () => {
    const evidence = await candidates(); const prepared = prepareRerank('query', evidence); const text = JSON.stringify({ items: [{ id: 'c2', score: 100 }, { id: 'c1', score: 0 }] });
    expect(() => decodeRerank(response(text, 'gpt-5.4-mini'), prepared, RERANK_CONTRACT_HASH)).toThrow(expect.objectContaining({ code: 'RERANK_MODEL_MISMATCH' }));
    expect(() => decodeRerank({ text, usage: null }, prepared, RERANK_CONTRACT_HASH)).toThrow(expect.objectContaining({ code: 'RERANK_MODEL_MISMATCH' }));
    expect(decodeRerank(response(text), prepared, RERANK_CONTRACT_HASH)).toMatchObject({ status: 'ok', items: [{ id: evidence[1]!.id, score: 100 }, { id: evidence[0]!.id, score: 0 }] });
  });
  it('never silently truncates candidates or text, or promotes a chat profile', async () => {
    const evidence = await candidates(); expect(() => prepareRerank('q', [...evidence, evidence[0]!])).toThrow(); expect(() => prepareRerank('x'.repeat(65536), evidence)).toThrow();
    expect(() => prepareRerank('q', Array.from({ length: 21 }, (_, i) => ({ ...evidence[0]!, id: `candidate${i}` })))).toThrow();
    expect(() => rerankProfile({ id: 'profile', name: 'chat', provider: 'openai', model: RERANK_CONTRACT.model, credentialRef: 'secret' }, 'rank')).toThrow(expect.objectContaining({ code: 'RERANK_PROFILE_UNSUPPORTED' }));
  });
  it.each(['keyword', 'vector', 'hybrid'] as const)('requires candidateLimit before topK for %s', mode => {
    const node = createNode('retrieval') as Extract<WorkflowNode, { type: 'retrieval' }>; node.config = { mode, topK: 2, maxContextTokens: 100, reranker: { modelProfile: 'rank', timeoutMs: 1000, onFailure: 'fail' }, ...(mode === 'hybrid' ? { keywordTopK: 5, vectorTopK: 5, fusion: { method: 'rrf', k: 60 } } : {}) };
    expect(() => validateRunRagNode(node)).toThrow(); node.config.candidateLimit = 1; expect(() => validateRunRagNode(node)).toThrow(); node.config.candidateLimit = 21; expect(() => validateRunRagNode(node)).toThrow(); node.config.candidateLimit = 20; expect(() => validateRunRagNode(node)).not.toThrow();
  });
  it('migrates v9 profile CHECK atomically without reclassifying old profiles or changing DPAPI references', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-rerank-contract-')); directories.push(directory); const path = join(directory, 'state.sqlite'); const old = new DatabaseSync(path);
    old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(9,'past'); CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,credential_ref TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','embedding'))); INSERT INTO profiles VALUES('old','old','openai','gpt-5.4-mini-2026-03-17','old-secret','chat'); INSERT INTO profiles VALUES('embed','embed','openai','text-embedding-3-small','embed-secret','embedding');"); old.close();
    const store = new RunStore(path); expect(store.getProfile('old')).toMatchObject({ credentialRef: 'old-secret' }); expect(store.getProfile('old').kind).toBeUndefined(); expect(store.getProfile('embed').kind).toBe('embedding');
    store.saveProfile({ id: 'rank', name: 'rank', kind: 'reranker', provider: 'openai', model: RERANK_CONTRACT.model, credentialRef: 'rank-secret' }); store.close();
    const reopened = new RunStore(path); expect(reopened.getProfile('rank')).toMatchObject({ kind: 'reranker', credentialRef: 'rank-secret' }); reopened.close();
  });
  it('uses the real fixed-origin Responses wire adapter without a fictional rerank endpoint', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { sent.push({ url, body: JSON.parse(String(options.body)) }); expect(options.redirect).toBe('error'); return new Response(JSON.stringify(url.endsWith('/input_tokens') ? { object: 'response.input_tokens', input_tokens: 3 } : { status: 'completed', model: RERANK_CONTRACT.model, output: [{ content: [{ type: 'output_text', text: '{"items":[]}' }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } })); });
    const request = { ...prepareRerank('query', await candidates()).request, model: RERANK_CONTRACT.model }; const provider = new OpenAIResponsesProvider(); const context = { apiKey: 'internal-test-only', signal: new AbortController().signal };
    expect(await provider.countInputTokens(request, context)).toBe(3); expect((await provider.generate(request, context)).model).toBe(RERANK_CONTRACT.model);
    expect(sent.map(item => item.url)).toEqual(['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses']);
  });
});
