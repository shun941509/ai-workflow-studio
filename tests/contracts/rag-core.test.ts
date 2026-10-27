import { describe, expect, it } from 'vitest';
import {
  agenticUsage, applyRerank, assertIndexCompatibility, authorizeCurrent, beginAgenticRound, buildBoundedContext, buildCitations,
  completeAgenticSession, createAgenticSession, createCorpusGeneration, embeddingFingerprint, filterAuthorized, filterDerivedEvidence,
  fuseRrf, normalizeRankedHits, pauseForClarification, planIndexActivation, reserveAgenticOperation, resumeAfterClarification,
  sealIndexGeneration, settleAgenticOperation, validateEmbeddingVector, verifyCorpusGeneration, verifyIndexArtifacts, verifyIndexGeneration,
  type AuthorizationSnapshot, type EmbeddingProfile, type RetrievalContext, type SearchResponse,
} from '@studio/rag-core';

const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
const profile: EmbeddingProfile = { providerId: 'test-provider', modelId: 'test-embedding', modelRevision: 'immutable-test-revision-1', dimensions: 2, distance: 'cosine', normalization: 'l2', tokenizerRevision: 'test-tokenizer-1', preprocessingRevision: 'verbatim-1', parameters: { encoding: 'float' } };
const bytes = (value: string) => new TextEncoder().encode(value);
const source = (id: string, value: string) => ({ documentId: id, revision: 1, sourceUri: `urn:test:${id}`, originalBytes: bytes(value), extractedText: value, extraction: { id: 'test-text', version: '1', options: {} } });

/** Artifacts/providers are internal deterministic test data, never advertised as a real search index or model. */
async function fixture() {
  const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c1', documents: [source('public', 'alpha beta'), source('private', 'secret text')], chunks: [{ chunkId: 'a1', documentId: 'public', start: 0, end: 5 }, { chunkId: 'a2', documentId: 'public', start: 6, end: 10 }, { chunkId: 'b1', documentId: 'private', start: 0, end: 11 }] });
  const index = await sealIndexGeneration({ corpus: corpus.ref, indexId: 'index', generationId: 'i1', kind: 'hybrid', embeddingProfile: profile, artifacts: [{ id: 'test-index-bytes', bytes: bytes('internal fixture inventory') }] });
  const context: RetrievalContext = { corpus, index, principal: { scope, subjectId: 'alice' } };
  const snapshot: AuthorizationSnapshot = { scope, subjectId: 'alice', groupIds: ['team'], epoch: 1, documents: [{ documentId: 'public', revision: 1, tombstoned: false, allowedSubjects: [], allowedGroups: ['team'] }, { documentId: 'private', revision: 1, tombstoned: false, allowedSubjects: ['bob'], allowedGroups: [] }] };
  const response = (hits: { chunkId: string; rank: number; score?: number }[]): SearchResponse => ({ status: 'ok', index: index.ref, corpus: corpus.ref, hits });
  return { corpus, index, context, snapshot, response };
}

describe('immutable corpus and index identity', () => {
  it('pins raw bytes, extraction, chunk ranges and frozen copies before awaiting', async () => {
    const document = source('doc', 'original'); const chunk = { chunkId: 'part', documentId: 'doc', start: 0, end: 8 };
    const pending = createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'version', documents: [document], chunks: [chunk] });
    document.originalBytes.fill(0); document.extractedText = 'modified'; chunk.start = 2;
    const result = await pending;
    expect(result.chunks[0]!.text).toBe('original');
    expect(result.documents[0]!.originalSha256).toBe(result.documents[0]!.textSha256);
    expect(Object.isFrozen(result.chunks[0]!.ref.document)).toBe(true);
    await expect(verifyCorpusGeneration(result)).resolves.toBeUndefined();
  });

  it('rejects out-of-source and split UTF-8 chunks', async () => {
    const base = { scope, corpusId: 'corpus', generationId: 'c1', documents: [source('doc', '😀a')] };
    await expect(createCorpusGeneration({ ...base, chunks: [{ chunkId: 'chunk', documentId: 'doc', start: 0, end: 9 }] })).rejects.toThrow(/range/);
    await expect(createCorpusGeneration({ ...base, chunks: [{ chunkId: 'chunk', documentId: 'doc', start: 0, end: 1 }] })).rejects.toThrow(/Unicode|surrogate/i);
  });

  it('preserves Korean/emoji byte ranges against the pinned extraction text', async () => {
    const document = source('doc', '가😀나');
    const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c1', documents: [document], chunks: [{ chunkId: 'emoji', documentId: 'doc', start: 3, end: 7 }] });
    expect(corpus.chunks[0]).toMatchObject({ text: '😀', ref: { location: { encoding: 'utf8', start: 3, end: 7 } } });
    await expect(verifyCorpusGeneration(corpus)).resolves.toBeUndefined();
  });

  it('preserves a UTF-8 BOM at the start of a chunk and the original byte-addressed hash', async () => {
    const document = source('doc', '\uFEFF가\uFEFF나');
    const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c1', documents: [document], chunks: [{ chunkId: 'first', documentId: 'doc', start: 0, end: 6 }, { chunkId: 'second', documentId: 'doc', start: 6, end: 12 }] });
    expect(corpus.chunks.map(chunk => chunk.text)).toEqual(['\uFEFF가', '\uFEFF나']);
    expect(corpus.documents[0]!.originalSha256).toBe(corpus.documents[0]!.textSha256);
    await expect(verifyCorpusGeneration(corpus)).resolves.toBeUndefined();
  });

  it('detects text, provenance and manifest mutation after rehydration', async () => {
    const { corpus, index } = await fixture();
    const corrupted = structuredClone(corpus); corrupted.chunks[0]!.text = 'other';
    await expect(verifyCorpusGeneration(corrupted)).rejects.toThrow(/content\/source\/range/);
    const forgedIndex = structuredClone(index); forgedIndex.artifacts[0]!.sha256 = 'a'.repeat(64);
    await expect(verifyIndexGeneration(forgedIndex)).rejects.toThrow(/pinned hash/);
    const forgedSource = structuredClone(corpus); forgedSource.documents[0]!.sourceUri = 'urn:test:forged';
    await expect(verifyCorpusGeneration(forgedSource)).rejects.toThrow();
  });

  it('does not accept equal dimensions as an embedding compatibility proof', async () => {
    const { corpus, index } = await fixture();
    await expect(assertIndexCompatibility(index, corpus, profile)).resolves.toBeUndefined();
    for (const changed of [{ ...profile, modelRevision: 'revision-2' }, { ...profile, preprocessingRevision: 'trim-1' }, { ...profile, distance: 'dot' as const }, { ...profile, tokenizerRevision: 'tokenizer-2' }]) {
      expect(await embeddingFingerprint(changed)).not.toBe(await embeddingFingerprint(profile));
      await expect(assertIndexCompatibility(index, corpus, changed)).rejects.toThrow(/settings differ/);
    }
    await expect(embeddingFingerprint({ ...profile, parameters: { apiKey: 'internal-not-a-real-key' } })).rejects.toThrow(/credentials/);
  });

  it('validates actual vector dimensions and declared normalization', async () => {
    await expect(validateEmbeddingVector([0.6, 0.8], profile)).resolves.toEqual([0.6, 0.8]);
    await expect(validateEmbeddingVector([1], profile)).rejects.toThrow(/length/);
    await expect(validateEmbeddingVector([0, 0], profile)).rejects.toThrow(/normalization/);
    await expect(validateEmbeddingVector([3, 4], profile)).rejects.toThrow(/normalization/);
  });

  it('requires immutable new generations and an atomic expected-current hash', async () => {
    const { corpus, index } = await fixture();
    const next = await sealIndexGeneration({ corpus: corpus.ref, indexId: 'index', generationId: 'i2', kind: 'keyword', artifacts: [{ id: 'postings', bytes: bytes('new artifact') }] });
    const stored = [{ id: 'postings', bytes: bytes('new artifact') }];
    await expect(planIndexActivation(index.ref, next, index.ref.manifestHash, stored)).resolves.toMatchObject({ next: next.ref });
    await expect(planIndexActivation(index.ref, next, '0'.repeat(64), stored)).rejects.toThrow(/changed before/);
    await expect(planIndexActivation(next.ref, next, next.ref.manifestHash, stored)).rejects.toThrow(/new generation/);
    const differentCorpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c2', documents: [source('public', 'changed')], chunks: [{ chunkId: 'a1', documentId: 'public', start: 0, end: 7 }] });
    await expect(assertIndexCompatibility(index, differentCorpus, profile)).rejects.toThrow(/another corpus generation/);
  });

  it('revalidates actual artifact storage bytes before generation activation', async () => {
    const { index } = await fixture();
    await expect(verifyIndexArtifacts(index, [{ id: 'test-index-bytes', bytes: bytes('internal fixture inventory') }])).resolves.toBeUndefined();
    await expect(verifyIndexArtifacts(index, [{ id: 'test-index-bytes', bytes: bytes('changed inventory') }])).rejects.toThrow(/Stored index bytes/);
    await expect(verifyIndexArtifacts(index, [{ id: 'unlisted', bytes: bytes('internal fixture inventory') }])).rejects.toThrow(/Stored index bytes/);
  });
});

describe('authoritative ACL, tombstones and citations', () => {
  it('enforces tenant/project identity, subject/group ACL and denied-by-default missing records', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }, { chunkId: 'b1', rank: 2 }]), f.corpus, f.index, 'keyword');
    const result = await filterAuthorized(f.context, candidates, f.snapshot, 1);
    expect(result.candidates.map(item => item.chunk.chunkId)).toEqual(['a1']); expect(result.deniedCount).toBe(1);
    await expect(filterAuthorized({ ...f.context, principal: { ...f.context.principal, scope: { ...scope, tenantId: 'another' } } }, candidates, f.snapshot, 1)).rejects.toThrow(/scope mismatch/);
    const absent = await filterAuthorized(f.context, candidates, { ...f.snapshot, documents: [] }, 1);
    expect(absent.candidates).toHaveLength(0);
  });

  it('denies tombstoned/replaced data even though an old index still contains it', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }]), f.corpus, f.index, 'keyword');
    const deleted = structuredClone(f.snapshot); deleted.epoch = 2; deleted.documents[0]!.tombstoned = true;
    expect((await filterAuthorized(f.context, candidates, deleted, 2)).candidates).toHaveLength(0);
    deleted.documents[0]!.tombstoned = false; deleted.documents[0]!.revision = 2;
    expect((await filterAuthorized(f.context, candidates, deleted, 2)).candidates).toHaveLength(0);
    await expect(filterAuthorized(f.context, candidates, f.snapshot, 2)).rejects.toThrow(/current epoch/);
  });

  it('refreshes authority before citation disclosure and rejects revocation after retrieval', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }]), f.corpus, f.index, 'keyword');
    let current = f.snapshot; let reads = 0;
    const authority = { readCurrent: async () => { reads++; return current; } };
    expect((await authorizeCurrent(f.context, candidates, authority)).candidates).toHaveLength(1);
    const citations = await buildCitations([candidates[0]!.id], f.context, candidates, authority);
    expect(citations[0]).toMatchObject({ quote: 'alpha', index: f.index.ref, chunk: f.corpus.chunks[0]!.ref, authorizationEpoch: 1 });
    current = { ...current, epoch: 2, documents: [] };
    await expect(buildCitations([candidates[0]!.id], f.context, candidates, authority)).rejects.toThrow(/revoked/);
    expect(reads).toBe(3);
    await expect(authorizeCurrent(f.context, candidates, { readCurrent: async () => { throw new Error('authority unavailable'); } })).rejects.toThrow(/unavailable/);
  });

  it('cannot relabel unrelated text as an authorized document or invent a citation ID', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }]), f.corpus, f.index, 'keyword');
    const forged = structuredClone(candidates); forged[0]!.text = 'private text';
    await expect(filterAuthorized(f.context, forged, f.snapshot, 1)).rejects.toThrow(/does not match/);
    await expect(buildCitations(['fabricated'], f.context, candidates, { readCurrent: async () => f.snapshot })).rejects.toThrow(/absent/);
  });

  it('revokes group-derived access immediately without changing the document ACL', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }]), f.corpus, f.index, 'keyword');
    let current = f.snapshot;
    const requests: { tenant: string; subject: string }[] = [];
    const authority = { readCurrent: async (requestedScope: typeof scope, subjectId: string) => { requests.push({ tenant: requestedScope.tenantId, subject: subjectId }); return current; } };
    expect((await authorizeCurrent(f.context, candidates, authority)).candidates).toHaveLength(1);
    current = { ...current, epoch: 2, groupIds: [] };
    expect(current.documents).toBe(f.snapshot.documents);
    expect((await authorizeCurrent(f.context, candidates, authority)).candidates).toHaveLength(0);
    await expect(buildCitations([candidates[0]!.id], f.context, candidates, authority)).rejects.toThrow(/revoked/);
    expect(await filterDerivedEvidence(f.context, [{ id: 'summary', kind: 'summary', text: 'alpha', supportingChunkIds: ['a1'] }], current, 2)).toEqual([]);
    expect(requests).toEqual(Array(3).fill({ tenant: 'tenant-a', subject: 'alice' }));
  });

  it('rejects a mismatched authority subject and refuses session-supplied group membership', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'b1', rank: 1 }]), f.corpus, f.index, 'keyword');
    await expect(authorizeCurrent(f.context, candidates, { readCurrent: async () => ({ ...f.snapshot, subjectId: 'bob' }) })).rejects.toMatchObject({ code: 'SUBJECT_MISMATCH' });
    const staleSessionGroups = { ...f.context, principal: { ...f.context.principal, groupIds: ['team'] } };
    await expect(filterAuthorized(staleSessionGroups, candidates, { ...f.snapshot, groupIds: [] }, 1)).rejects.toThrow(/Unexpected or unsafe/);
  });

  it('denies a whole derived summary when any of its supporting chunks is private', async () => {
    const f = await fixture();
    const result = await filterDerivedEvidence(f.context, [{ id: 'public-summary', kind: 'summary', text: 'alpha', supportingChunkIds: ['a1'] }, { id: 'mixed-summary', kind: 'summary', text: 'mixed facts', supportingChunkIds: ['a1', 'b1'] }], f.snapshot, 1);
    expect(result.map(item => item.id)).toEqual(['public-summary']);
    await expect(filterDerivedEvidence(f.context, [{ id: 'missing', kind: 'relation', text: 'unsupported', supportingChunkIds: ['not-a-chunk'] }], f.snapshot, 1)).rejects.toThrow(/missing source/);
  });
});

describe('Hybrid rank normalization and rerank boundaries', () => {
  it('deduplicates, normalizes tied/gapped ranks after ACL filtering, and fuses ranks only', async () => {
    const f = await fixture();
    const keyword = await normalizeRankedHits(f.response([{ chunkId: 'b1', rank: 1, score: 9000 }, { chunkId: 'a2', rank: 7, score: 50 }, { chunkId: 'a1', rank: 7, score: -50 }, { chunkId: 'a1', rank: 9, score: -100 }]), f.corpus, f.index, 'keyword');
    const vector = await normalizeRankedHits(f.response([{ chunkId: 'a2', rank: 1, score: 0.7 }, { chunkId: 'a1', rank: 3, score: 0.9 }]), f.corpus, f.index, 'vector');
    const filtered = await filterAuthorized(f.context, keyword, f.snapshot, 1);
    const fused = fuseRrf({ keyword: filtered.candidates, vector }, { k: 60, candidateLimit: 10 });
    expect(fused.map(item => item.chunk.chunkId)).toEqual(['a1', 'a2']);
    expect(fused[0]!.stages.rrf!.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused[0]!.stages.keyword).toEqual({ rank: 1, providerRank: 7, rawScore: -50 });
    expect(fused[0]!.stages.vector!.rawScore).toBe(0.9);
  });

  it('distinguishes an empty successful search from a provider failure or stale generation', async () => {
    const f = await fixture();
    await expect(normalizeRankedHits(f.response([]), f.corpus, f.index, 'keyword')).resolves.toEqual([]);
    await expect(normalizeRankedHits({ status: 'failed', code: 'NETWORK_FAILED' }, f.corpus, f.index, 'keyword')).rejects.toMatchObject({ code: 'SEARCH_PROVIDER_FAILED' });
    await expect(normalizeRankedHits({ status: 'ok', index: { ...f.index.ref, generationId: 'stale' }, corpus: f.corpus.ref, hits: [] }, f.corpus, f.index, 'keyword')).rejects.toThrow(/different index/);
    await expect(normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 0 }]), f.corpus, f.index, 'keyword')).rejects.toThrow(/integer/);
    await expect(normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1, score: 1 }, { chunkId: 'a1', rank: 1, score: 2 }]), f.corpus, f.index, 'keyword')).rejects.toThrow(/contradictory/);
  });

  it('requires a complete rerank permutation and never falls back on injected IDs', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }, { chunkId: 'a2', rank: 2 }]), f.corpus, f.index, 'keyword');
    const options = { expectedFingerprint: 'a'.repeat(64), topK: 2, onFailure: 'use_original' as const };
    const result = applyRerank(candidates, { status: 'ok', fingerprint: options.expectedFingerprint, items: [{ id: candidates[0]!.id, score: 0.1 }, { id: candidates[1]!.id, score: 0.9 }] }, options);
    expect(result.candidates[0]!.chunk.chunkId).toBe('a2'); expect(result.candidates[0]!.stages.reranker!.score).toBe(0.9);
    expect(() => applyRerank(candidates, { status: 'ok', fingerprint: options.expectedFingerprint, items: [{ id: candidates[0]!.id, score: 1 }, { id: 'injected', score: 9 }] }, options)).toThrow(/unknown\/duplicate/);
    expect(() => applyRerank(candidates, { status: 'ok', fingerprint: options.expectedFingerprint, items: [] }, options)).toThrow(/every candidate/);
    expect(applyRerank(candidates, { status: 'failed', code: 'TIMEOUT' }, options)).toMatchObject({ status: 'fallback', failureCode: 'TIMEOUT' });
    expect(() => applyRerank(candidates, { status: 'failed', code: 'TIMEOUT' }, { ...options, onFailure: 'fail' })).toThrow(/not permitted/);
  });

  it('respects actual injected tokenizer counts without truncating a cited chunk', async () => {
    const f = await fixture(); const candidates = await normalizeRankedHits(f.response([{ chunkId: 'a1', rank: 1 }, { chunkId: 'a2', rank: 2 }]), f.corpus, f.index, 'keyword');
    const result = buildBoundedContext(candidates, { maxTokens: 18, prefix: '', tokenizerFingerprint: 'b'.repeat(64) }, value => value.length);
    expect(result.candidates).toHaveLength(1); expect(result.text).toContain('alpha'); expect(result.text).not.toContain('beta'); expect(result.omittedCount).toBe(1);
    expect(() => buildBoundedContext(candidates, { maxTokens: 1, prefix: 'too long', tokenizerFingerprint: 'b'.repeat(64) }, value => value.length)).toThrow(/prefix alone/);
  });
});

describe('bounded Agentic reservation ledger', () => {
  async function session() { const f = await fixture(); return { f, session: beginAgenticRound(createAgenticSession({ id: 'session', scope, allowedIndexes: [f.index.ref], allowedTools: ['lookup'], limits: { maxRounds: 2, maxQueriesPerRound: 1, maxRetrievedChunks: 4, maxContextTokens: 20, maxSteps: 3 } })) }; }
  it('reserves before a call, supports identical operation retries and rejects conflicting IDs', async () => {
    const base = await session(); const request = { operationId: 'query-1', kind: 'query' as const, index: base.f.index.ref, maxChunks: 3, maxContextTokens: 15 };
    const reserved = reserveAgenticOperation(base.session, request);
    expect(agenticUsage(reserved)).toMatchObject({ rounds: 1, queries: 1, steps: 1, retrievedChunks: 3, contextTokens: 15 });
    expect(reserveAgenticOperation(reserved, request).revision).toBe(reserved.revision);
    expect(() => reserveAgenticOperation(reserved, { ...request, maxChunks: 2 })).toThrow(/different reservation/);
    expect(() => reserveAgenticOperation(reserved, { ...request, operationId: 'query-2' })).toThrow(/budget/);
  });

  it('retains unknown reservations and keeps usage through clarification/resume/new rounds', async () => {
    const base = await session(); const reserved = reserveAgenticOperation(base.session, { operationId: 'query-1', kind: 'query', index: base.f.index.ref, maxChunks: 3, maxContextTokens: 15 });
    const unknown = settleAgenticOperation(reserved, 'query-1', { status: 'unknown' });
    const resumed = resumeAfterClarification(pauseForClarification(unknown));
    expect(agenticUsage(resumed)).toEqual(agenticUsage(unknown));
    const nextRound = beginAgenticRound(resumed);
    expect(() => reserveAgenticOperation(nextRound, { operationId: 'query-2', kind: 'query', index: base.f.index.ref, maxChunks: 2, maxContextTokens: 6 })).toThrow(/budget/);
    expect(() => completeAgenticSession(nextRound)).toThrow(/reconciliation/);
    const reconciled = settleAgenticOperation(nextRound, 'query-1', { status: 'confirmed', actualChunks: 1, actualContextTokens: 5 });
    expect(agenticUsage(reconciled)).toMatchObject({ retrievedChunks: 1, contextTokens: 5, queries: 1, steps: 1 });
    expect(() => settleAgenticOperation(reconciled, 'query-1', { status: 'confirmed', actualChunks: 0, actualContextTokens: 0 })).toThrow(/cannot be changed/);
    expect(completeAgenticSession(reconciled).phase).toBe('completed');
  });

  it('rejects unlisted tools, generation drift and exceeding returned-data reservations', async () => {
    const base = await session();
    expect(() => reserveAgenticOperation(base.session, { operationId: 'tool', kind: 'tool', toolId: 'shell', maxChunks: 0, maxContextTokens: 0 })).toThrow(/unlisted tool/);
    expect(() => reserveAgenticOperation(base.session, { operationId: 'query', kind: 'query', index: { ...base.f.index.ref, generationId: 'new' }, maxChunks: 1, maxContextTokens: 1 })).toThrow(/unlisted generation/);
    const reserved = reserveAgenticOperation(base.session, { operationId: 'query', kind: 'query', index: base.f.index.ref, maxChunks: 1, maxContextTokens: 2 });
    expect(() => settleAgenticOperation(reserved, 'query', { status: 'confirmed', actualChunks: 2, actualContextTokens: 2 })).toThrow(/integer/);
    expect(() => beginAgenticRound(beginAgenticRound(reserved))).toThrow(/exhausted/);
  });
});
