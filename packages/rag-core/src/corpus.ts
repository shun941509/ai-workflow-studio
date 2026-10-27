import { assertJsonData, type JsonValue } from '@studio/spec';
import { assertScope, compareId, digest, equal, identifier, immutable, integer, jsonDigest, object, RagContractError, requireCondition, sha256, text, validateScope, type AccessScope } from './common.js';

/** Internal RAG records follow P1: offsets address UTF-8 bytes of textSha256, end-exclusive. */
export interface DocumentRef { scope: AccessScope; documentId: string; revision: number; originalSha256: string; textSha256: string; sourceUri: string; extractionFingerprint: string }
export interface ChunkRef { document: DocumentRef; chunkId: string; sha256: string; location: { encoding: 'utf8'; start: number; end: number } }
export interface ChunkRecord { ref: ChunkRef; text: string }
export interface CorpusRef { scope: AccessScope; corpusId: string; generationId: string; manifestHash: string }
export interface CorpusGeneration { formatVersion: '1.0.0'; ref: CorpusRef; documents: DocumentRef[]; chunks: ChunkRecord[] }
export interface DocumentInput { documentId: string; revision: number; sourceUri: string; originalBytes: Uint8Array; extractedText: string; extraction: { id: string; version: string; options: JsonValue } }
export interface ChunkInput { chunkId: string; documentId: string; start: number; end: number }
export interface EmbeddingProfile { providerId: string; modelId: string; modelRevision: string; dimensions: number; distance: 'cosine' | 'dot' | 'l2'; normalization: 'none' | 'l2'; tokenizerRevision: string; preprocessingRevision: string; parameters: Record<string, JsonValue> }
export interface IndexRef { scope: AccessScope; indexId: string; generationId: string; formatVersion: '1.0.0'; manifestHash: string }
export interface IndexGeneration { ref: IndexRef; corpus: CorpusRef; kind: 'keyword' | 'vector' | 'hybrid' | 'graph'; embedding?: { profile: EmbeddingProfile; fingerprint: string }; artifacts: { id: string; sha256: string; size: number }[] }
export interface IndexArtifactBytes { id: string; bytes: Uint8Array }

function sourceUri(value: string): void {
  text(value, 2048);
  const parsed = new URL(value);
  requireCondition(['https:', 'urn:', 'resource:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'UNSAFE_SOURCE_URI', 'Source URI must be non-secret https, urn, or resource locator without credentials/query/fragment');
}

/** Raw bytes and extracted text are hashed independently; no parser accuracy or source ownership is fabricated. */
export async function createCorpusGeneration(input: { scope: AccessScope; corpusId: string; generationId: string; documents: DocumentInput[]; chunks: ChunkInput[] }): Promise<Readonly<CorpusGeneration>> {
  object(input, ['scope', 'corpusId', 'generationId', 'documents', 'chunks']); validateScope(input.scope); identifier(input.corpusId); identifier(input.generationId);
  requireCondition(Array.isArray(input.documents) && input.documents.length > 0 && input.documents.length <= 1000 && Array.isArray(input.chunks) && input.chunks.length > 0 && input.chunks.length <= 10000, 'CORPUS_LIMIT', 'Corpus requires bounded nonempty documents and chunks');
  const scope = immutable(input.scope); const corpusId = input.corpusId; const generationId = input.generationId;
  let totalInputBytes = 0;
  // Copy every input before the first await, including the raw byte arrays.
  const documents = input.documents.map(document => {
    object(document, ['documentId', 'revision', 'sourceUri', 'originalBytes', 'extractedText', 'extraction']); identifier(document.documentId); integer(document.revision, 1, Number.MAX_SAFE_INTEGER); sourceUri(document.sourceUri);
    requireCondition(document.originalBytes instanceof Uint8Array && document.originalBytes.byteLength <= 128 * 1024 * 1024, 'DOCUMENT_BYTES', 'Expected at most 128MiB source bytes');
    text(document.extractedText, 8 * 1024 * 1024); object(document.extraction, ['id', 'version', 'options']); identifier(document.extraction.id); text(document.extraction.version); assertJsonData(document.extraction.options);
    totalInputBytes += document.originalBytes.byteLength + new TextEncoder().encode(document.extractedText).byteLength;
    requireCondition(totalInputBytes <= 128 * 1024 * 1024, 'CORPUS_LIMIT', 'Pure in-memory corpus sealing permits at most 128MiB input');
    return { ...document, extraction: immutable(document.extraction), originalBytes: new Uint8Array(document.originalBytes) };
  });
  const chunks = immutable(input.chunks);
  requireCondition(new Set(documents.map(document => document.documentId)).size === documents.length, 'DUPLICATE_DOCUMENT', 'One revision per document is permitted in a generation');
  const references = new Map<string, DocumentRef>();
  for (const document of documents) references.set(document.documentId, { scope, documentId: document.documentId, revision: document.revision, originalSha256: await sha256(document.originalBytes), textSha256: await sha256(new TextEncoder().encode(document.extractedText)), sourceUri: document.sourceUri, extractionFingerprint: await jsonDigest(document.extraction) });
  const records: ChunkRecord[] = []; const ids = new Set<string>();
  for (const chunk of chunks) {
    object(chunk, ['chunkId', 'documentId', 'start', 'end']); identifier(chunk.chunkId); identifier(chunk.documentId); integer(chunk.start, 0, Number.MAX_SAFE_INTEGER); integer(chunk.end, chunk.start + 1, Number.MAX_SAFE_INTEGER);
    requireCondition(!ids.has(chunk.chunkId), 'DUPLICATE_CHUNK', 'Chunk ID must be unique within a generation'); ids.add(chunk.chunkId);
    const document = documents.find(item => item.documentId === chunk.documentId); requireCondition(document, 'INVALID_CHUNK_RANGE', 'Chunk range must belong to a corpus document');
    const extractedBytes = new TextEncoder().encode(document.extractedText);
    requireCondition(chunk.end <= extractedBytes.byteLength, 'INVALID_CHUNK_RANGE', 'Chunk byte range exceeds the extracted text');
    let content: string;
    // A BOM inside a byte-addressed extraction is content; stripping it would invalidate provenance.
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(extractedBytes.subarray(chunk.start, chunk.end)); }
    catch { throw new RagContractError('INVALID_CHUNK_RANGE', 'Chunk byte range splits a UTF-8 Unicode character'); }
    text(content, 65536);
    records.push({ ref: { document: references.get(chunk.documentId)!, chunkId: chunk.chunkId, sha256: await sha256(new TextEncoder().encode(content)), location: { encoding: 'utf8', start: chunk.start, end: chunk.end } }, text: content });
  }
  const body = { formatVersion: '1.0.0' as const, scope, corpusId, generationId, documents: [...references.values()].sort((a, b) => compareId(a.documentId, b.documentId)), chunks: records.sort((a, b) => compareId(a.ref.chunkId, b.ref.chunkId)) };
  return immutable({ formatVersion: body.formatVersion, ref: { scope, corpusId, generationId, manifestHash: await jsonDigest(body) }, documents: body.documents, chunks: body.chunks });
}

/** Every identity-affecting embedding setting is included, not merely dimensions or a mutable model alias. */
export async function embeddingFingerprint(profile: EmbeddingProfile): Promise<string> {
  object(profile, ['providerId', 'modelId', 'modelRevision', 'dimensions', 'distance', 'normalization', 'tokenizerRevision', 'preprocessingRevision', 'parameters']);
  identifier(profile.providerId); text(profile.modelId); text(profile.modelRevision); integer(profile.dimensions, 1, 65536); text(profile.tokenizerRevision); text(profile.preprocessingRevision);
  requireCondition(['cosine', 'dot', 'l2'].includes(profile.distance) && ['none', 'l2'].includes(profile.normalization), 'EMBEDDING_PROFILE', 'Unsupported embedding metric or normalization');
  assertJsonData(profile.parameters); object(profile.parameters, Object.keys(profile.parameters));
  const scan = (value: unknown): void => { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { requireCondition(!/^(?:secret|password|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|credentials?)$/i.test(key), 'SECRET_IN_PROFILE', 'Embedding identity must not contain credentials'); scan(item); } };
  scan(profile.parameters); return jsonDigest(profile);
}

/** Sealing verifies artifact byte identities, not a search engine's correctness or GraphRAG completion. */
export async function sealIndexGeneration(input: { corpus: CorpusRef; indexId: string; generationId: string; kind: IndexGeneration['kind']; embeddingProfile?: EmbeddingProfile; artifacts: IndexArtifactBytes[] }): Promise<Readonly<IndexGeneration>> {
  object(input, ['corpus', 'indexId', 'generationId', 'kind', 'embeddingProfile', 'artifacts']); validateCorpusRef(input.corpus); identifier(input.indexId); identifier(input.generationId);
  requireCondition(['keyword', 'vector', 'hybrid', 'graph'].includes(input.kind), 'INDEX_KIND', 'Unknown index kind');
  requireCondition(Array.isArray(input.artifacts) && input.artifacts.length > 0 && input.artifacts.length <= 1000, 'ARTIFACT_REQUIRED', 'A sealed index must contain actual builder artifacts');
  requireCondition(!['vector', 'hybrid'].includes(input.kind) || input.embeddingProfile, 'EMBEDDING_REQUIRED', 'Vector/hybrid indexes require exact embedding identity');
  const corpus = immutable(input.corpus); const indexId = input.indexId; const generationId = input.generationId; const kind = input.kind;
  const profile = input.embeddingProfile ? immutable(input.embeddingProfile) : undefined;
  const bytes = copyIndexArtifacts(input.artifacts);
  requireCondition(new Set(bytes.map(artifact => artifact.id)).size === bytes.length, 'DUPLICATE_ARTIFACT', 'Duplicate artifact ID');
  const artifacts = await Promise.all(bytes.map(async artifact => ({ id: artifact.id, sha256: await sha256(artifact.bytes), size: artifact.bytes.byteLength })));
  artifacts.sort((a, b) => compareId(a.id, b.id));
  const body = { corpus, indexId, generationId, kind, artifacts, ...(profile ? { embedding: { profile, fingerprint: await embeddingFingerprint(profile) } } : {}) };
  return immutable({ ref: { scope: corpus.scope, indexId, generationId, formatVersion: '1.0.0', manifestHash: await jsonDigest(body) }, corpus, kind, artifacts, ...(body.embedding ? { embedding: body.embedding } : {}) });
}

function copyIndexArtifacts(artifacts: readonly IndexArtifactBytes[]): IndexArtifactBytes[] {
  requireCondition(Array.isArray(artifacts) && artifacts.length > 0 && artifacts.length <= 1000, 'ARTIFACT_REQUIRED', 'Index artifacts must be bounded and nonempty');
  let total = 0;
  return artifacts.map(artifact => {
    object(artifact, ['id', 'bytes']); identifier(artifact.id); requireCondition(artifact.bytes instanceof Uint8Array && artifact.bytes.byteLength > 0, 'INDEX_ARTIFACT', 'Index artifact requires actual bytes'); total += artifact.bytes.byteLength;
    requireCondition(total <= 128 * 1024 * 1024, 'INDEX_ARTIFACT_LIMIT', 'In-memory artifact verification permits at most 128MiB');
    return { id: artifact.id, bytes: new Uint8Array(artifact.bytes) };
  });
}

/** Re-read storage bytes through the adapter before activation/loading; metadata alone is not byte verification. */
export async function verifyIndexArtifacts(index: IndexGeneration, artifacts: readonly IndexArtifactBytes[]): Promise<void> {
  const ownedIndex = immutable(index); const ownedArtifacts = copyIndexArtifacts(artifacts); await verifyIndexGeneration(ownedIndex);
  requireCondition(ownedArtifacts.length === ownedIndex.artifacts.length && new Set(ownedArtifacts.map(artifact => artifact.id)).size === ownedArtifacts.length, 'INDEX_INVENTORY_MISMATCH', 'Index artifact inventory is incomplete or duplicated');
  for (const artifact of ownedArtifacts) {
    const expected = ownedIndex.artifacts.find(item => item.id === artifact.id);
    requireCondition(expected && expected.size === artifact.bytes.byteLength && expected.sha256 === await sha256(artifact.bytes), 'INDEX_ARTIFACT_MISMATCH', 'Stored index bytes differ from the sealed inventory');
  }
}

export function validateCorpusRef(ref: CorpusRef): void { object(ref, ['scope', 'corpusId', 'generationId', 'manifestHash']); validateScope(ref.scope); identifier(ref.corpusId); identifier(ref.generationId); digest(ref.manifestHash); }
export function validateIndexRef(ref: IndexRef): void { object(ref, ['scope', 'indexId', 'generationId', 'formatVersion', 'manifestHash']); validateScope(ref.scope); identifier(ref.indexId); identifier(ref.generationId); digest(ref.manifestHash); requireCondition(ref.formatVersion === '1.0.0', 'INDEX_FORMAT', 'Unsupported index format'); }

/** Rehydrated records are untrusted until their own content, inventory and manifest hashes agree. */
export async function verifyCorpusGeneration(corpus: CorpusGeneration): Promise<void> {
  assertJsonData(corpus); object(corpus, ['formatVersion', 'ref', 'documents', 'chunks']); validateCorpusRef(corpus.ref);
  requireCondition(corpus.formatVersion === '1.0.0' && Array.isArray(corpus.documents) && corpus.documents.length > 0 && corpus.documents.length <= 1000 && Array.isArray(corpus.chunks) && corpus.chunks.length > 0 && corpus.chunks.length <= 10000, 'INVALID_CORPUS', 'Invalid corpus inventory');
  const owned = immutable(corpus); const documents = new Map<string, DocumentRef>();
  for (const document of owned.documents) {
    object(document, ['scope', 'documentId', 'revision', 'originalSha256', 'textSha256', 'sourceUri', 'extractionFingerprint']); assertScope(document.scope, owned.ref.scope); identifier(document.documentId); integer(document.revision, 1, Number.MAX_SAFE_INTEGER);
    digest(document.originalSha256); digest(document.textSha256); digest(document.extractionFingerprint); sourceUri(document.sourceUri);
    requireCondition(!documents.has(document.documentId), 'DUPLICATE_DOCUMENT', 'Duplicate corpus document'); documents.set(document.documentId, document);
  }
  const ids = new Set<string>();
  for (const chunk of owned.chunks) {
    object(chunk, ['ref', 'text']); object(chunk.ref, ['document', 'chunkId', 'sha256', 'location']); identifier(chunk.ref.chunkId); digest(chunk.ref.sha256); text(chunk.text, 65536); object(chunk.ref.location, ['encoding', 'start', 'end']); integer(chunk.ref.location.start, 0, Number.MAX_SAFE_INTEGER); integer(chunk.ref.location.end, chunk.ref.location.start + 1, Number.MAX_SAFE_INTEGER);
    requireCondition(chunk.ref.location.encoding === 'utf8' && !ids.has(chunk.ref.chunkId) && equal(documents.get(chunk.ref.document.documentId), chunk.ref.document) && chunk.ref.location.end - chunk.ref.location.start === new TextEncoder().encode(chunk.text).byteLength && chunk.ref.sha256 === await sha256(new TextEncoder().encode(chunk.text)), 'PROVENANCE_MISMATCH', 'Corpus chunk content/source/range does not match its declared reference'); ids.add(chunk.ref.chunkId);
  }
  const body = { formatVersion: owned.formatVersion, scope: owned.ref.scope, corpusId: owned.ref.corpusId, generationId: owned.ref.generationId, documents: owned.documents, chunks: owned.chunks };
  requireCondition(owned.ref.manifestHash === await jsonDigest(body), 'CORPUS_MANIFEST_MISMATCH', 'Corpus inventory does not match its pinned hash');
}

export async function verifyIndexGeneration(index: IndexGeneration): Promise<void> {
  assertJsonData(index); object(index, ['ref', 'corpus', 'kind', 'embedding', 'artifacts']); validateIndexRef(index.ref); validateCorpusRef(index.corpus); assertScope(index.ref.scope, index.corpus.scope);
  requireCondition(['keyword', 'vector', 'hybrid', 'graph'].includes(index.kind) && Array.isArray(index.artifacts) && index.artifacts.length > 0 && index.artifacts.length <= 1000, 'INVALID_INDEX', 'Invalid sealed index');
  const owned = immutable(index); const ids = new Set<string>();
  for (const artifact of owned.artifacts) { object(artifact, ['id', 'sha256', 'size']); identifier(artifact.id); digest(artifact.sha256); integer(artifact.size, 1, 128 * 1024 * 1024); requireCondition(!ids.has(artifact.id), 'DUPLICATE_ARTIFACT', 'Duplicate index artifact'); ids.add(artifact.id); }
  if (owned.embedding) { object(owned.embedding, ['profile', 'fingerprint']); requireCondition(owned.embedding.fingerprint === await embeddingFingerprint(owned.embedding.profile), 'EMBEDDING_MISMATCH', 'Index embedding metadata has changed'); }
  else requireCondition(!['vector', 'hybrid'].includes(owned.kind), 'EMBEDDING_REQUIRED', 'Index requires an embedding profile');
  const body = { corpus: owned.corpus, indexId: owned.ref.indexId, generationId: owned.ref.generationId, kind: owned.kind, artifacts: owned.artifacts, ...(owned.embedding ? { embedding: owned.embedding } : {}) };
  requireCondition(owned.ref.manifestHash === await jsonDigest(body), 'INDEX_MANIFEST_MISMATCH', 'Index metadata differs from its pinned hash');
}

/** Storage must apply this compare-and-swap plan atomically; a pure function cannot activate a database row. */
export async function planIndexActivation(current: IndexRef | null, candidate: IndexGeneration, expectedCurrentHash: string | null, storedArtifacts: readonly IndexArtifactBytes[]): Promise<{ expectedManifestHash: string | null; next: IndexRef }> {
  current = current ? immutable(current) : null; candidate = immutable(candidate);
  await verifyIndexArtifacts(candidate, storedArtifacts);
  validateIndexRef(candidate.ref);
  if (current) { validateIndexRef(current); assertScope(current.scope, candidate.ref.scope); requireCondition(current.indexId === candidate.ref.indexId && current.generationId !== candidate.ref.generationId, 'GENERATION_REUSE', 'Activation must replace the same index with a new generation'); }
  requireCondition((current?.manifestHash ?? null) === expectedCurrentHash, 'ACTIVATION_CONFLICT', 'Current generation changed before activation');
  return immutable({ expectedManifestHash: expectedCurrentHash, next: candidate.ref });
}

export async function assertIndexCompatibility(index: IndexGeneration, corpus: CorpusGeneration, queryProfile?: EmbeddingProfile): Promise<void> {
  index = immutable(index); corpus = immutable(corpus); queryProfile = queryProfile ? immutable(queryProfile) : undefined;
  await verifyIndexGeneration(index); await verifyCorpusGeneration(corpus);
  validateIndexRef(index.ref); validateCorpusRef(corpus.ref); assertScope(index.ref.scope, corpus.ref.scope);
  requireCondition(equal(index.corpus, corpus.ref), 'CORPUS_GENERATION_MISMATCH', 'Index is pinned to another corpus generation');
  if (index.embedding) {
    requireCondition(queryProfile, 'EMBEDDING_REQUIRED', 'Query embedding identity is required');
    requireCondition(index.embedding.fingerprint === await embeddingFingerprint(queryProfile) && index.embedding.fingerprint === await embeddingFingerprint(index.embedding.profile), 'EMBEDDING_MISMATCH', 'Embedding provider/model revision/settings differ from this index');
  } else requireCondition(!queryProfile && index.kind !== 'vector' && index.kind !== 'hybrid', 'EMBEDDING_MISMATCH', 'Embedding query is incompatible with this index');
}

/** Validate an actual embedding against declared dimensionality/normalization without inventing vectors. */
export async function validateEmbeddingVector(vector: readonly number[], profile: EmbeddingProfile): Promise<readonly number[]> {
  const owned = immutable(vector); const identity = immutable(profile); await embeddingFingerprint(identity);
  requireCondition(Array.isArray(owned) && owned.length === identity.dimensions, 'EMBEDDING_DIMENSIONS', 'Embedding length differs from the exact profile');
  let norm = 0;
  for (const component of owned) { requireCondition(typeof component === 'number' && Number.isFinite(component), 'EMBEDDING_VALUE', 'Embedding contains non-finite or nonnumeric data'); norm = Math.hypot(norm, component); }
  requireCondition(Number.isFinite(norm) && (identity.distance !== 'cosine' || norm > 0) && (identity.normalization !== 'l2' || Math.abs(norm - 1) <= 1e-5), 'EMBEDDING_NORMALIZATION', 'Embedding normalization does not match its profile');
  return owned;
}
