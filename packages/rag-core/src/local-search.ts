import { assertJsonData, parseStrictJson } from '@studio/spec';
import { canonicalize } from 'json-canonicalize';
import { compareId, equal, identifier, immutable, integer, object, requireCondition, text } from './common.js';
import { embeddingFingerprint, sealIndexGeneration, validateEmbeddingVector, verifyCorpusGeneration, verifyIndexArtifacts, type CorpusGeneration, type EmbeddingProfile, type IndexArtifactBytes, type IndexGeneration } from './corpus.js';
import type { SearchProvider, SearchResponse } from './ranking.js';

/** A bounded, portable exact-search format; it does not generate embeddings or claim ANN-scale capacity. */
export const LOCAL_SEARCH_FORMAT = 'studio-bm25-exact-v1';
const ARTIFACT_ID = 'local-search';
const TOKENIZER = 'nfkc-lower-unicode-words-v1';
const MAX_COMPONENTS = 32768;
interface SearchRow { chunkId: string; documentId: string; length: number; terms: [string, number][]; vector?: number[] }
interface LocalArtifact { format: typeof LOCAL_SEARCH_FORMAT; tokenizer: typeof TOKENIZER; k1: 1.2; b: 0.75; rows: SearchRow[] }
export interface ChunkEmbedding { chunkId: string; vector: number[] }
export interface LocalSearchBundle { corpus: CorpusGeneration; index: IndexGeneration; artifacts: IndexArtifactBytes[] }
export interface QueryEmbedder {
  /** The adapter accounts for real calls separately; only query text is disclosed, never corpus contents. */
  embed(query: string, profile: EmbeddingProfile, signal: AbortSignal): Promise<{ fingerprint: string; vector: number[] }>;
}

function termsOf(value: string): string[] {
  // Versioned Unicode word splitting is deterministic for the pinned runtime; Korean morphology is not inferred.
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}
function rowOf(chunk: CorpusGeneration['chunks'][number]): SearchRow {
  const counts = new Map<string, number>(); const tokens = termsOf(chunk.text);
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return { chunkId: chunk.ref.chunkId, documentId: chunk.ref.document.documentId, length: tokens.length, terms: [...counts].sort((a, b) => compareId(a[0], b[0])) };
}
function checkAbort(signal: AbortSignal): void { signal.throwIfAborted(); }

/** Build real frequency/vector bytes from a verified corpus; supplied vectors are never labeled model-verified. */
export async function buildLocalSearchIndex(input: {
  corpus: CorpusGeneration; indexId: string; generationId: string; kind: 'keyword' | 'vector' | 'hybrid';
  embeddingProfile?: EmbeddingProfile; embeddings?: ChunkEmbedding[];
}): Promise<LocalSearchBundle> {
  object(input, ['corpus', 'indexId', 'generationId', 'kind', 'embeddingProfile', 'embeddings']);
  const owned = immutable(input); await verifyCorpusGeneration(owned.corpus);
  requireCondition(['keyword', 'vector', 'hybrid'].includes(owned.kind) && owned.corpus.chunks.length <= 1000, 'LOCAL_INDEX_LIMIT', 'Exact local search permits at most 1000 chunks');
  const needsVectors = owned.kind !== 'keyword';
  requireCondition(needsVectors ? owned.embeddingProfile && Array.isArray(owned.embeddings) : !owned.embeddingProfile && !owned.embeddings, 'LOCAL_EMBEDDING_CONFIG', 'Keyword indexes omit embeddings; vector/hybrid indexes require every actual vector');
  const embeddings = new Map<string, readonly number[]>();
  if (needsVectors) {
    requireCondition(owned.embeddings!.length === owned.corpus.chunks.length && owned.embeddingProfile!.dimensions * owned.corpus.chunks.length <= MAX_COMPONENTS, 'LOCAL_VECTOR_LIMIT', 'Exact JSON index permits 32768 total vector components and one vector per chunk');
    for (const item of owned.embeddings!) {
      object(item, ['chunkId', 'vector']); identifier(item.chunkId);
      requireCondition(!embeddings.has(item.chunkId) && owned.corpus.chunks.some(chunk => chunk.ref.chunkId === item.chunkId), 'LOCAL_VECTOR_INVENTORY', 'Embedding chunk IDs must match the corpus exactly');
      embeddings.set(item.chunkId, await validateEmbeddingVector(item.vector, owned.embeddingProfile!));
    }
  }
  const artifact: LocalArtifact = { format: LOCAL_SEARCH_FORMAT, tokenizer: TOKENIZER, k1: 1.2, b: 0.75, rows: owned.corpus.chunks.map(chunk => ({ ...rowOf(chunk), ...(needsVectors ? { vector: [...embeddings.get(chunk.ref.chunkId)!] } : {}) })) };
  const encoded = canonicalize(artifact);
  // The same strict parser used for loading is a build-time complexity/byte limit, not just a reader check.
  parseStrictJson(encoded);
  const artifacts = [{ id: ARTIFACT_ID, bytes: new TextEncoder().encode(encoded) }];
  const index = await sealIndexGeneration({ corpus: owned.corpus.ref, indexId: owned.indexId, generationId: owned.generationId, kind: owned.kind, ...(owned.embeddingProfile ? { embeddingProfile: owned.embeddingProfile } : {}), artifacts });
  return { corpus: owned.corpus, index, artifacts };
}

/** Load only exact, verified artifact bytes and recheck token provenance, even for a re-signed malicious index. */
export async function openLocalSearchProvider(bundle: LocalSearchBundle, embedder?: QueryEmbedder): Promise<SearchProvider> {
  object(bundle, ['corpus', 'index', 'artifacts']);
  const corpus = immutable(bundle.corpus); const index = immutable(bundle.index);
  requireCondition(Array.isArray(bundle.artifacts) && bundle.artifacts.length === 1, 'LOCAL_INDEX_FORMAT', 'Expected exactly one local search artifact');
  const artifacts = bundle.artifacts.map(item => {
    object(item, ['id', 'bytes']); requireCondition(item.bytes instanceof Uint8Array && item.bytes.byteLength <= 8 * 1024 * 1024, 'LOCAL_INDEX_LIMIT', 'Local artifact must contain at most 8 MiB of real bytes');
    return { id: item.id, bytes: new Uint8Array(item.bytes) };
  });
  await verifyCorpusGeneration(corpus); await verifyIndexArtifacts(index, artifacts);
  requireCondition(equal(index.corpus, corpus.ref) && ['keyword', 'vector', 'hybrid'].includes(index.kind) && artifacts.length === 1 && artifacts[0]!.id === ARTIFACT_ID, 'LOCAL_INDEX_FORMAT', 'Expected the exact local artifact and pinned corpus generation');
  const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(artifacts[0]!.bytes));
  object(parsed, ['format', 'tokenizer', 'k1', 'b', 'rows']); const artifact = parsed as LocalArtifact;
  requireCondition(artifact.format === LOCAL_SEARCH_FORMAT && artifact.tokenizer === TOKENIZER && artifact.k1 === 1.2 && artifact.b === 0.75 && Array.isArray(artifact.rows) && artifact.rows.length === corpus.chunks.length && artifact.rows.length <= 1000, 'LOCAL_INDEX_FORMAT', 'Unknown local algorithm, tokenizer, or inventory');
  const needsVectors = index.kind !== 'keyword';
  requireCondition(needsVectors ? index.embedding && index.embedding.profile.dimensions * artifact.rows.length <= MAX_COMPONENTS : !index.embedding, 'LOCAL_VECTOR_LIMIT', 'Incompatible local embedding inventory');
  for (const [offset, row] of artifact.rows.entries()) {
    object(row, ['chunkId', 'documentId', 'length', 'terms', 'vector']);
    const { vector, ...keyword } = row;
    requireCondition(equal(keyword, rowOf(corpus.chunks[offset]!)), 'LOCAL_TERM_PROVENANCE', 'Local terms do not match the sealed original chunk text');
    if (needsVectors) await validateEmbeddingVector(vector!, index.embedding!.profile);
    else requireCondition(vector === undefined, 'LOCAL_VECTOR_INVENTORY', 'Keyword-only index contains undeclared vectors');
  }
  const rows = immutable(artifact.rows); const documentIds = new Set(corpus.documents.map(item => item.documentId));
  return {
    async search(rawRequest, signal): Promise<SearchResponse> {
      checkAbort(signal); assertJsonData(rawRequest); object(rawRequest, ['index', 'query', 'channel', 'allowedDocumentIds', 'authorizationEpoch', 'limit']);
      const request = immutable(rawRequest); text(request.query, 8192); integer(request.authorizationEpoch, 1, Number.MAX_SAFE_INTEGER); integer(request.limit, 1, 1000);
      requireCondition(equal(request.index, index.ref), 'SEARCH_GENERATION_MISMATCH', 'Query must pin the loaded generation');
      requireCondition(Array.isArray(request.allowedDocumentIds) && request.allowedDocumentIds.length <= 1000 && new Set(request.allowedDocumentIds).size === request.allowedDocumentIds.length && request.allowedDocumentIds.every(id => documentIds.has(id)), 'SEARCH_ALLOWLIST', 'Search requires a bounded current document allowlist');
      requireCondition(request.channel === 'keyword' && ['keyword', 'hybrid'].includes(index.kind) || request.channel === 'vector' && ['vector', 'hybrid'].includes(index.kind), 'SEARCH_CHANNEL', 'Index does not implement this search channel');
      const allowed = new Set(request.allowedDocumentIds); const readableRows = rows.filter(row => allowed.has(row.documentId));
      const scores: { chunkId: string; score: number }[] = [];
      if (readableRows.length === 0) return { status: 'ok', index: index.ref, corpus: corpus.ref, hits: [] };
      if (request.channel === 'keyword') {
        const queryTerms = new Set(termsOf(request.query)); requireCondition(queryTerms.size <= 256, 'SEARCH_QUERY_LIMIT', 'Query permits at most 256 distinct terms');
        // Statistics use only readable chunks: inaccessible text cannot influence ranks or corpus-frequency scores.
        const averageLength = readableRows.reduce((sum, row) => sum + row.length, 0) / readableRows.length;
        const frequencies = new Map<string, number>();
        for (const row of readableRows) for (const [term] of row.terms) if (queryTerms.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        for (const row of readableRows) {
          checkAbort(signal); let score = 0;
          for (const [term, frequency] of row.terms) if (queryTerms.has(term)) {
            const idf = Math.log(1 + (readableRows.length - frequencies.get(term)! + 0.5) / (frequencies.get(term)! + 0.5));
            score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * row.length / averageLength));
          }
          if (score > 0) scores.push({ chunkId: row.chunkId, score });
        }
      } else {
        requireCondition(embedder, 'QUERY_EMBEDDER_REQUIRED', 'A real, explicitly configured query embedding adapter is required');
        const profile = index.embedding!.profile; const embedded = await embedder.embed(request.query, profile, signal); checkAbort(signal);
        object(embedded, ['fingerprint', 'vector']); const ownedEmbedding = immutable(embedded);
        requireCondition(ownedEmbedding.fingerprint === await embeddingFingerprint(profile), 'EMBEDDING_MISMATCH', 'Query embedding adapter returned a different profile');
        const query = await validateEmbeddingVector(ownedEmbedding.vector, profile); checkAbort(signal);
        for (const row of readableRows) { checkAbort(signal); scores.push({ chunkId: row.chunkId, score: vectorScore(query, row.vector!, profile.distance) }); }
      }
      scores.sort((a, b) => b.score - a.score || compareId(a.chunkId, b.chunkId)); checkAbort(signal);
      return immutable({ status: 'ok', index: index.ref, corpus: corpus.ref, hits: scores.slice(0, request.limit).map((hit, offset) => ({ ...hit, rank: offset + 1 })) });
    },
  };
}

function vectorScore(query: readonly number[], document: readonly number[], metric: EmbeddingProfile['distance']): number {
  let score = 0;
  if (metric === 'cosine') {
    let queryNorm = 0; let documentNorm = 0;
    for (let i = 0; i < query.length; i++) { queryNorm = Math.hypot(queryNorm, query[i]!); documentNorm = Math.hypot(documentNorm, document[i]!); }
    for (let i = 0; i < query.length; i++) score += query[i]! / queryNorm * (document[i]! / documentNorm);
    score = Math.max(-1, Math.min(1, score));
  } else if (metric === 'l2') {
    for (let i = 0; i < query.length; i++) score = Math.hypot(score, query[i]! - document[i]!);
    score = -score; // A larger score always ranks first, so exact Euclidean distance is negated.
  } else for (let i = 0; i < query.length; i++) score += query[i]! * document[i]!;
  requireCondition(Number.isFinite(score), 'SEARCH_SCORE_OVERFLOW', 'Vector arithmetic exceeds the supported finite numeric range'); return score;
}
