import { describe, expect, it, vi } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import { buildLocalSearchIndex, createCorpusGeneration, embeddingFingerprint, openLocalSearchProvider, searchCurrentChannel, sealIndexGeneration, type AuthorizationSnapshot, type EmbeddingProfile, type LocalSearchBundle, type QueryEmbedder } from '@studio/rag-core';

const scope = { tenantId: 'tenant', projectId: 'project' };
const bytes = (value: string) => new TextEncoder().encode(value);
const signal = () => new AbortController().signal;
const profile: EmbeddingProfile = { providerId: 'internal-test', modelId: 'explicit-vectors', modelRevision: 'test-v1', dimensions: 2, distance: 'cosine', normalization: 'l2', tokenizerRevision: 'test-v1', preprocessingRevision: 'identity-v1', parameters: {} };

/** Analytical vectors below test arithmetic only and are never presented as provider/model integration evidence. */
async function fixture(kind: 'keyword' | 'vector' | 'hybrid' = 'keyword', metric: EmbeddingProfile['distance'] = 'cosine') {
  const texts = ['alpha alpha beta', 'beta gamma', 'private alpha alpha alpha'];
  const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c1', documents: texts.map((value, i) => ({ documentId: `d${i}`, revision: 1, sourceUri: `urn:sample:d${i}`, originalBytes: bytes(value), extractedText: value, extraction: { id: 'text', version: '1', options: {} } })), chunks: texts.map((value, i) => ({ chunkId: `c${i}`, documentId: `d${i}`, start: 0, end: value.length })) });
  const exactProfile = { ...profile, distance: metric };
  const bundle = await buildLocalSearchIndex({ corpus, indexId: 'index', generationId: 'g1', kind, ...(kind !== 'keyword' ? { embeddingProfile: exactProfile, embeddings: [{ chunkId: 'c0', vector: [1, 0] }, { chunkId: 'c1', vector: [0, 1] }, { chunkId: 'c2', vector: [-1, 0] }] } : {}) });
  const request = { index: bundle.index.ref, query: 'alpha', channel: 'keyword' as const, allowedDocumentIds: ['d0', 'd1'], authorizationEpoch: 1, limit: 10 };
  const snapshot: AuthorizationSnapshot = { scope, subjectId: 'alice', groupIds: ['team'], epoch: 1, documents: texts.map((_, i) => ({ documentId: `d${i}`, revision: 1, tombstoned: false, allowedSubjects: [], allowedGroups: i < 2 ? ['team'] : ['private'] })) };
  const context = { corpus, index: bundle.index, principal: { scope, subjectId: 'alice' } };
  return { bundle, request, snapshot, context, exactProfile };
}
async function embedder(profileValue: EmbeddingProfile, vector = [1, 0]): Promise<QueryEmbedder> {
  return { embed: vi.fn(async () => ({ fingerprint: await embeddingFingerprint(profileValue), vector })) };
}

describe('real bounded local search calculations', () => {
  it('builds byte-verified frequencies and computes BM25 from readable chunks only', async () => {
    const { bundle, request } = await fixture(); const provider = await openLocalSearchProvider(bundle);
    const result = await provider.search(request, signal());
    expect(result.status).toBe('ok'); if (result.status !== 'ok') return;
    const expected = Math.log(2) * 2 * 2.2 / (2 + 1.2 * (0.25 + 0.75 * 3 / 2.5));
    expect(result.hits).toEqual([{ chunkId: 'c0', rank: 1, score: expect.closeTo(expected, 12) }]);
    expect((await provider.search({ ...request, query: 'private' }, signal()))).toMatchObject({ status: 'ok', hits: [] });
  });
  it('normalizes fullwidth/case queries, deduplicates terms and treats query syntax as text', async () => {
    const { bundle, request } = await fixture(); const provider = await openLocalSearchProvider(bundle);
    expect(await provider.search({ ...request, query: 'ＡＬＰＨＡ alpha' }, signal())).toEqual(await provider.search(request, signal()));
    expect(await provider.search({ ...request, query: '" OR *' }, signal())).toMatchObject({ hits: [] });
  });
  it('returns empty results without an embedding call when every document is denied', async () => {
    const { bundle, request, exactProfile } = await fixture('hybrid'); const adapter = await embedder(exactProfile); const provider = await openLocalSearchProvider(bundle, adapter);
    expect(await provider.search({ ...request, channel: 'vector', allowedDocumentIds: [] }, signal())).toMatchObject({ hits: [] });
    expect(adapter.embed).not.toHaveBeenCalled();
  });
  it.each(['cosine', 'dot', 'l2'] as const)('computes exact %s order with original raw scores', async metric => {
    const { bundle, request, exactProfile } = await fixture('vector', metric); const provider = await openLocalSearchProvider(bundle, await embedder(exactProfile));
    const result = await provider.search({ ...request, channel: 'vector' }, signal());
    expect(result).toMatchObject({ hits: [{ chunkId: 'c0', score: metric === 'l2' ? -0 : 1 }, { chunkId: 'c1', score: metric === 'l2' ? -Math.sqrt(2) : 0 }] });
  });
  it('requires a configured embedder and the exact query profile', async () => {
    const { bundle, request, exactProfile } = await fixture('hybrid'); const provider = await openLocalSearchProvider(bundle);
    await expect(provider.search({ ...request, channel: 'vector' }, signal())).rejects.toThrow(/configured query embedding/);
    const wrong = await openLocalSearchProvider(bundle, await embedder({ ...exactProfile, modelRevision: 'different' }));
    await expect(wrong.search({ ...request, channel: 'vector' }, signal())).rejects.toThrow(/different profile/);
  });
  it('does not execute queries with stale generation, invalid allowlist, or excessive terms', async () => {
    const { bundle, request } = await fixture(); const provider = await openLocalSearchProvider(bundle);
    await expect(provider.search({ ...request, index: { ...request.index, generationId: 'different' } }, signal())).rejects.toThrow(/pin the loaded/);
    await expect(provider.search({ ...request, allowedDocumentIds: ['other'] }, signal())).rejects.toThrow(/allowlist/);
    await expect(provider.search({ ...request, query: Array.from({ length: 257 }, (_, i) => `term${i}`).join(' ') }, signal())).rejects.toThrow(/256/);
  });
  it('checks cancellation before and after a delayed embedding result', async () => {
    const { bundle, request, exactProfile } = await fixture('hybrid'); const controller = new AbortController();
    const provider = await openLocalSearchProvider(bundle, { embed: async () => { controller.abort(); return { fingerprint: await embeddingFingerprint(exactProfile), vector: [1, 0] }; } });
    await expect(provider.search({ ...request, channel: 'vector' }, controller.signal)).rejects.toThrow();
    await expect(provider.search(request, AbortSignal.abort())).rejects.toThrow();
  });
  it('checks original artifact bytes and token provenance after a malicious re-seal', async () => {
    const { bundle } = await fixture(); const changed = structuredClone(bundle); changed.artifacts[0]!.bytes[0] = 0;
    await expect(openLocalSearchProvider(changed)).rejects.toThrow(/Stored index bytes/);
    const artifact = JSON.parse(new TextDecoder().decode(bundle.artifacts[0]!.bytes)); artifact.rows[0].terms = [['injected', 100]];
    const artifacts = [{ id: 'local-search', bytes: bytes(canonicalize(artifact)) }];
    const index = await sealIndexGeneration({ corpus: bundle.corpus.ref, indexId: 'index', generationId: 'g2', kind: 'keyword', artifacts });
    await expect(openLocalSearchProvider({ corpus: bundle.corpus, index, artifacts })).rejects.toThrow(/original chunk text/);
  });
  it('rejects missing/duplicate/wrong-dimensional embedding inventories', async () => {
    const { bundle } = await fixture(); const base = { corpus: bundle.corpus, indexId: 'index', generationId: 'g2', kind: 'vector' as const, embeddingProfile: profile };
    await expect(buildLocalSearchIndex({ ...base, embeddings: [] })).rejects.toThrow(/one vector per chunk/);
    await expect(buildLocalSearchIndex({ ...base, embeddings: [{ chunkId: 'c0', vector: [1, 0] }, { chunkId: 'c0', vector: [1, 0] }, { chunkId: 'c2', vector: [1, 0] }] })).rejects.toThrow(/exactly/);
    await expect(buildLocalSearchIndex({ ...base, embeddings: ['c0', 'c1', 'c2'].map(chunkId => ({ chunkId, vector: [1] })) })).rejects.toThrow(/length differs/);
  });
  it('owns the opened snapshot after callers mutate bundle bytes', async () => {
    const { bundle, request } = await fixture(); const copy = structuredClone(bundle) as LocalSearchBundle;
    const provider = await openLocalSearchProvider(copy); copy.artifacts[0]!.bytes.fill(0); copy.corpus.chunks[0]!.text = 'changed';
    expect(await provider.search(request, signal())).toMatchObject({ hits: [{ chunkId: 'c0' }] });
  });
});

describe('current-authorization retrieval orchestration', () => {
  it('derives prefilter from current groups and rechecks a revocation after search', async () => {
    const { bundle, context, snapshot } = await fixture(); const provider = await openLocalSearchProvider(bundle);
    let reads = 0; const authority = { readCurrent: async () => ({ ...snapshot, epoch: ++reads, groupIds: reads === 1 ? ['team'] : [] }) };
    const result = await searchCurrentChannel(context, provider, authority, { query: 'alpha', channel: 'keyword', limit: 2 }, signal());
    expect(result).toEqual({ candidates: [], deniedCount: 1, authorizationEpoch: 2 });
  });
  it('returns original text with provenance and rejects a wrong principal snapshot', async () => {
    const { bundle, context, snapshot } = await fixture(); const provider = await openLocalSearchProvider(bundle);
    const result = await searchCurrentChannel(context, provider, { readCurrent: async () => snapshot }, { query: 'alpha', channel: 'keyword', limit: 2 }, signal());
    expect(result.candidates[0]).toMatchObject({ text: 'alpha alpha beta', chunk: { document: { documentId: 'd0' } } });
    await expect(searchCurrentChannel(context, provider, { readCurrent: async () => ({ ...snapshot, subjectId: 'bob' }) }, { query: 'alpha', channel: 'keyword', limit: 2 }, signal())).rejects.toThrow(/another subject/);
  });
});
