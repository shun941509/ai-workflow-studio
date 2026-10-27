import { assertJsonData } from '@studio/spec';
import { compareId, digest, equal, identifier, immutable, integer, object, RagContractError, requireCondition } from './common.js';
import { validateIndexRef, verifyCorpusGeneration, verifyIndexGeneration, type ChunkRef, type CorpusGeneration, type CorpusRef, type IndexGeneration, type IndexRef } from './corpus.js';

export type SearchChannel = 'keyword' | 'vector';
export interface RawSearchHit { chunkId: string; rank: number; score?: number }
export type SearchResponse = { status: 'ok'; index: IndexRef; corpus: CorpusRef; hits: RawSearchHit[] } | { status: 'failed'; code: string };
export interface ChannelScore { rank: number; providerRank: number; rawScore?: number }
export interface Candidate {
  id: string; index: IndexRef; chunk: ChunkRef; text: string; rank: number;
  stages: { keyword?: ChannelScore; vector?: ChannelScore; rrf?: { score: number; k: number }; reranker?: { score: number; fingerprint: string } };
}
export interface SearchProvider {
  /** The adapter must enforce the supplied current document allowlist during actual search. */
  search(request: { index: IndexRef; query: string; channel: SearchChannel; allowedDocumentIds: string[]; authorizationEpoch: number; limit: number }, signal: AbortSignal): Promise<SearchResponse>;
}

export function candidateId(index: IndexRef, chunkId: string): string {
  validateIndexRef(index); identifier(chunkId);
  return `${index.indexId}/${index.generationId}/${index.manifestHash}/${chunkId}`;
}

/** Provider text/IDs are not trusted as provenance: resolve each hit from the pinned corpus inventory. */
export async function normalizeRankedHits(response: SearchResponse, corpus: CorpusGeneration, index: IndexGeneration, channel: SearchChannel): Promise<Readonly<Candidate[]>> {
  response = immutable(response); corpus = immutable(corpus); index = immutable(index);
  await verifyCorpusGeneration(corpus); await verifyIndexGeneration(index);
  assertJsonData(response);
  if (response.status === 'failed') { object(response, ['status', 'code']); identifier(response.code); throw new RagContractError('SEARCH_PROVIDER_FAILED', `Search provider failed: ${response.code}`); }
  object(response, ['status', 'index', 'corpus', 'hits']);
  requireCondition(response.status === 'ok' && equal(response.index, index.ref) && equal(response.corpus, corpus.ref) && equal(index.corpus, corpus.ref), 'SEARCH_GENERATION_MISMATCH', 'Search response belongs to a different index/corpus generation');
  requireCondition((channel === 'keyword' && ['keyword', 'hybrid'].includes(index.kind)) || (channel === 'vector' && ['vector', 'hybrid'].includes(index.kind)), 'SEARCH_CHANNEL', 'Search channel is incompatible with this index');
  requireCondition(Array.isArray(response.hits) && response.hits.length <= 10000, 'SEARCH_LIMIT', 'Search response exceeds its bounded hit limit');
  const inventory = new Map(corpus.chunks.map(chunk => [chunk.ref.chunkId, chunk]));
  const best = new Map<string, RawSearchHit>();
  for (const hit of response.hits) {
    object(hit, ['chunkId', 'rank', 'score']); identifier(hit.chunkId); integer(hit.rank, 1, 1_000_000_000);
    requireCondition(hit.score === undefined || Number.isFinite(hit.score), 'SEARCH_SCORE', 'Provider score must be finite');
    requireCondition(inventory.has(hit.chunkId), 'UNKNOWN_CHUNK', 'Search returned a chunk absent from this corpus');
    const previous = best.get(hit.chunkId);
    if (previous?.rank === hit.rank) requireCondition(previous.score === hit.score, 'AMBIGUOUS_RANK', 'Duplicate best-rank hit has contradictory scores');
    if (!previous || previous.rank > hit.rank) best.set(hit.chunkId, hit);
  }
  const ordered = [...best.values()].sort((a, b) => a.rank - b.rank || compareId(candidateId(index.ref, a.chunkId), candidateId(index.ref, b.chunkId)));
  return immutable(ordered.map((hit, offset) => {
    const chunk = inventory.get(hit.chunkId)!;
    return { id: candidateId(index.ref, hit.chunkId), index: index.ref, chunk: chunk.ref, text: chunk.text, rank: offset + 1, stages: { [channel]: { rank: offset + 1, providerRank: hit.rank, ...(hit.score !== undefined ? { rawScore: hit.score } : {}) } } };
  }));
}

/** A candidate cannot re-label private text with an authorized chunk reference. */
export function assertCandidate(candidate: Candidate, corpus: CorpusGeneration, index: IndexGeneration): void {
  assertJsonData(candidate); object(candidate, ['id', 'index', 'chunk', 'text', 'rank', 'stages']); integer(candidate.rank, 1, 10000);
  requireCondition(equal(candidate.index, index.ref) && equal(index.corpus, corpus.ref), 'CANDIDATE_GENERATION_MISMATCH', 'Candidate index/corpus mismatch');
  const chunk = corpus.chunks.find(item => item.ref.chunkId === candidate.chunk.chunkId);
  requireCondition(chunk && equal(chunk.ref, candidate.chunk) && chunk.text === candidate.text && candidate.id === candidateId(index.ref, chunk.ref.chunkId), 'PROVENANCE_MISMATCH', 'Candidate text/reference does not match the sealed corpus');
}

/** RRF combines ranks only. BM25, vector similarity and reranker scores retain their distinct fields. */
export function fuseRrf(lists: { keyword: readonly Candidate[]; vector: readonly Candidate[] }, options: { k: number; candidateLimit: number }): Readonly<Candidate[]> {
  assertJsonData(lists); object(lists, ['keyword', 'vector']); object(options, ['k', 'candidateLimit']); integer(options.k, 1, 1000); integer(options.candidateLimit, 1, 1000);
  const combined = new Map<string, Candidate>();
  let commonIndex: IndexRef | undefined;
  for (const channel of ['keyword', 'vector'] as const) {
    requireCondition(Array.isArray(lists[channel]) && lists[channel].length <= 1000, 'FUSION_LIMIT', 'Each fusion channel permits at most 1000 normalized candidates');
    const seen = new Set<string>();
    for (const [offset, candidate] of lists[channel].entries()) {
      if (commonIndex) requireCondition(equal(commonIndex, candidate.index), 'FUSION_GENERATION_MISMATCH', 'Fusion cannot combine different index generations'); else commonIndex = candidate.index;
      requireCondition(candidate.rank === offset + 1 && candidate.stages[channel]?.rank === candidate.rank && Object.keys(candidate.stages).length === 1 && candidate.id === candidateId(candidate.index, candidate.chunk.chunkId) && !seen.has(candidate.id), 'UNNORMALIZED_RANK', 'Fusion requires unique contiguous one-based channel ranks');
      seen.add(candidate.id);
      const previous = combined.get(candidate.id);
      if (previous) {
        requireCondition(equal(previous.index, candidate.index) && equal(previous.chunk, candidate.chunk) && previous.text === candidate.text, 'PROVENANCE_MISMATCH', 'Same candidate identity has inconsistent evidence');
        previous.stages[channel] = candidate.stages[channel];
        previous.stages.rrf!.score += 1 / (options.k + candidate.rank);
      } else combined.set(candidate.id, structuredClone({ ...candidate, stages: { [channel]: candidate.stages[channel], rrf: { score: 1 / (options.k + candidate.rank), k: options.k } } }));
    }
  }
  const ordered = [...combined.values()].sort((a, b) => b.stages.rrf!.score - a.stages.rrf!.score || compareId(a.id, b.id));
  return immutable(ordered.slice(0, options.candidateLimit).map((candidate, offset) => ({ ...candidate, rank: offset + 1 })));
}

export type RerankResponse = { status: 'ok'; fingerprint: string; items: { id: string; score: number }[] } | { status: 'failed'; code: string };
export interface Reranker { rerank(request: { query: string; candidates: readonly Candidate[]; fingerprint: string }, signal: AbortSignal): Promise<RerankResponse> }

/** Tokenizer is injected and fingerprinted. Whole chunks are retained; a source quote is never silently truncated. */
export function buildBoundedContext(candidates: readonly Candidate[], options: { maxTokens: number; prefix: string; tokenizerFingerprint: string }, countTokens: (text: string) => number): { text: string; candidates: readonly Candidate[]; tokenCount: number; tokenizerFingerprint: string; omittedCount: number } {
  assertJsonData(candidates); object(options, ['maxTokens', 'prefix', 'tokenizerFingerprint']); integer(options.maxTokens, 1, 200000); digest(options.tokenizerFingerprint);
  requireCondition(typeof options.prefix === 'string' && options.prefix.length <= 65536 && candidates.length <= 1000, 'CONTEXT_LIMIT', 'Context input exceeds bounds'); assertJsonData(options.prefix);
  let context = options.prefix; let tokenCount = countTokens(context); integer(tokenCount, 0, Number.MAX_SAFE_INTEGER);
  requireCondition(tokenCount <= options.maxTokens, 'CONTEXT_BUDGET_EXCEEDED', 'Prompt prefix alone exceeds the context budget');
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    const next = `${context}\n[source-${selected.length + 1}]\n${candidate.text}\n`;
    const tokens = countTokens(next); integer(tokens, 1, Number.MAX_SAFE_INTEGER);
    if (tokens > options.maxTokens) break;
    context = next; tokenCount = tokens; selected.push(candidate);
  }
  return immutable({ text: context, candidates: selected, tokenCount, tokenizerFingerprint: options.tokenizerFingerprint, omittedCount: candidates.length - selected.length });
}

/** Provider failures may explicitly fall back; malformed/injected IDs never trigger a silent fallback. */
export function applyRerank(candidates: readonly Candidate[], response: RerankResponse, options: { expectedFingerprint: string; topK: number; onFailure: 'fail' | 'use_original' }): { status: 'reranked' | 'fallback'; candidates: readonly Candidate[]; failureCode?: string } {
  assertJsonData(candidates); assertJsonData(response); object(options, ['expectedFingerprint', 'topK', 'onFailure']); digest(options.expectedFingerprint); integer(options.topK, 1, 100);
  requireCondition(['fail', 'use_original'].includes(options.onFailure) && candidates.length <= 1000 && new Set(candidates.map(candidate => candidate.id)).size === candidates.length, 'RERANK_INPUT', 'Invalid rerank policy/candidate inventory');
  if (response.status === 'failed') {
    object(response, ['status', 'code']); identifier(response.code);
    requireCondition(options.onFailure === 'use_original', 'RERANK_FAILED', 'Reranker failed and fallback is not permitted');
    return immutable({ status: 'fallback', candidates: candidates.slice(0, options.topK), failureCode: response.code });
  }
  object(response, ['status', 'fingerprint', 'items']); requireCondition(response.status === 'ok' && response.fingerprint === options.expectedFingerprint, 'RERANK_PROFILE_MISMATCH', 'Reranker identity differs from the resolved profile');
  requireCondition(Array.isArray(response.items) && response.items.length === candidates.length, 'INCOMPLETE_RERANK', 'Reranker must return every candidate exactly once');
  const inventory = new Map(candidates.map(candidate => [candidate.id, candidate])); const seen = new Set<string>();
  for (const item of response.items) {
    object(item, ['id', 'score']); requireCondition(inventory.has(item.id) && !seen.has(item.id) && Number.isFinite(item.score), 'INVALID_RERANK_RESULT', 'Reranker returned unknown/duplicate ID or non-finite score'); seen.add(item.id);
  }
  const ordered = [...response.items].sort((a, b) => b.score - a.score || compareId(a.id, b.id));
  return immutable({ status: 'reranked', candidates: ordered.slice(0, options.topK).map((item, offset) => { const candidate = inventory.get(item.id)!; return { ...candidate, rank: offset + 1, stages: { ...candidate.stages, reranker: { score: item.score, fingerprint: response.fingerprint } } }; }) });
}
