import { assertJsonData } from '@studio/spec';
import { digest, equal, identifier, immutable, integer, object, requireCondition, sha256, text } from '../common.js';
import { verifyCorpusGeneration, type ChunkRecord, type CorpusGeneration } from '../corpus.js';
import { GRAPH_LIMITS, type GraphFact, type GraphIdentity, type GraphIdentityEvidence, type GraphSpan } from './contracts.js';

/** Per-open work accounting bounds synchronous validation too; AbortSignal alone cannot preempt a busy JS loop. */
export class GraphWork {
  used = 0;
  constructor(readonly maximum: number, readonly code: string) {}
  add(amount = 1): void { this.used += amount; requireCondition(this.used <= this.maximum, this.code, 'Graph work exceeds the declared operation bound'); }
}

/** All inputs are owned before hashing. This bound precedes the existing broader corpus verifier. */
export async function ownGraphCorpus(value: CorpusGeneration): Promise<CorpusGeneration> {
  assertJsonData(value); object(value, ['formatVersion', 'ref', 'documents', 'chunks']);
  requireCondition(Array.isArray(value.chunks) && value.chunks.length > 0 && value.chunks.length <= GRAPH_LIMITS.chunks && Array.isArray(value.documents) && value.documents.length <= GRAPH_LIMITS.chunks, 'GRAPH_CORPUS_LIMIT', 'Graph corpus permits 1..32 chunks and at most 32 source documents');
  let total = 0;
  for (const chunk of value.chunks) { text(chunk.text, GRAPH_LIMITS.chunkBytes); const size = new TextEncoder().encode(chunk.text).byteLength; total += size; requireCondition(size <= GRAPH_LIMITS.chunkBytes && total <= GRAPH_LIMITS.corpusBytes, 'GRAPH_CORPUS_LIMIT', 'Graph input permits at most 20000 bytes per chunk and 256 KiB of chunk text'); }
  const corpus = immutable(value); await verifyCorpusGeneration(corpus);
  requireCondition(corpus.documents.every(document => corpus.chunks.some(chunk => chunk.ref.document.documentId === document.documentId)), 'GRAPH_CORPUS_INVENTORY', 'Every graph source document must have a pinned input chunk');
  return corpus;
}

export function graphText(value: unknown, maximum = 256): asserts value is string {
  text(value, maximum); requireCondition(value === value.normalize('NFC') && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'GRAPH_TEXT', 'Graph names and identity components require exact NFC text without surrounding whitespace/control characters');
}
export function graphList(value: unknown, maximum: number, minimum = 0): asserts value is unknown[] { requireCondition(Array.isArray(value) && value.length >= minimum && value.length <= maximum, 'GRAPH_INVENTORY_LIMIT', 'Graph inventory exceeds its bounded cardinality'); }

/** Span bytes are checked against an immutable corpus, including Unicode boundaries and embedded BOM preservation. */
export class GraphEvidenceValidator {
  readonly chunks: Map<string, ChunkRecord>;
  readonly bytes: Map<string, Uint8Array>;
  readonly #verified = new Map<string, string>();
  constructor(corpus: CorpusGeneration, readonly work: GraphWork) { this.chunks = new Map(corpus.chunks.map(chunk => [chunk.ref.chunkId, chunk])); this.bytes = new Map(corpus.chunks.map(chunk => [chunk.ref.chunkId, new TextEncoder().encode(chunk.text)])); }
  async span(value: GraphSpan, inputs: readonly string[]): Promise<void> {
    this.work.add(); object(value, ['chunkId', 'start', 'end', 'sha256', 'quote']); identifier(value.chunkId); digest(value.sha256); text(value.quote, GRAPH_LIMITS.chunkBytes);
    const chunk = this.chunks.get(value.chunkId); requireCondition(chunk && inputs.includes(value.chunkId), 'GRAPH_EVIDENCE_INPUT', 'Graph evidence must come from the recorded complete extraction input');
    integer(value.start, chunk.ref.location.start, chunk.ref.location.end - 1); integer(value.end, value.start + 1, chunk.ref.location.end);
    const raw = this.bytes.get(value.chunkId)!.subarray(value.start - chunk.ref.location.start, value.end - chunk.ref.location.start);
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
    catch { requireCondition(false, 'GRAPH_SPAN_UTF8', 'Graph evidence splits a UTF-8 character'); }
    requireCondition(decoded === value.quote, 'GRAPH_SPAN_TEXT', 'Graph evidence quote differs from original pinned UTF-8 bytes');
    const key = `${value.chunkId}:${value.start}:${value.end}`;
    let hash = this.#verified.get(key); if (!hash) { hash = await sha256(raw); this.#verified.set(key, hash); }
    requireCondition(value.sha256 === hash, 'GRAPH_SPAN_HASH', 'Graph evidence SHA-256 differs from original bytes');
  }
  async fact(value: GraphFact, inputs: readonly string[]): Promise<void> { object(value, ['value', 'span']); graphText(value.value); await this.span(value.span, inputs); requireCondition(value.value === value.span.quote, 'GRAPH_FACT_TEXT', 'Identity/name fact must quote its entire exact source value'); }
  async identity(value: GraphIdentityEvidence, inputs: readonly string[]): Promise<GraphIdentity> {
    object(value, ['namespace', 'sourceIdentifier', 'version', 'assertion']); await this.span(value.assertion, inputs);
    for (const fact of [value.namespace, value.sourceIdentifier, ...(value.version === null ? [] : [value.version])]) { await this.fact(fact, inputs); contains(value.assertion, fact.span); }
    return { namespace: value.namespace.value, sourceIdentifier: value.sourceIdentifier.value, version: value.version?.value ?? null };
  }
}
export function contains(outer: GraphSpan, inner: GraphSpan): void { requireCondition(outer.chunkId === inner.chunkId && outer.start <= inner.start && outer.end >= inner.end, 'GRAPH_ASSERTION_RANGE', 'An assertion must contain the exact qualified identity/name spans in the same chunk'); }
export function identitySpans(value: GraphIdentityEvidence): GraphSpan[] { return [value.assertion, value.namespace.span, value.sourceIdentifier.span, ...(value.version ? [value.version.span] : [])]; }
export function sameIdentity(actual: GraphIdentity, expected: GraphIdentity): void { requireCondition(equal(actual, expected), 'GRAPH_IDENTITY_MISMATCH', 'Qualified namespace/source identifier/version do not identify the selected entity'); }

/** Convenience for trusted extraction adapters; it never finds/guesses a quote or repairs invalid byte offsets. */
export async function createGraphSpan(corpusValue: CorpusGeneration, chunkId: string, start: number, end: number): Promise<GraphSpan> {
  const corpus = await ownGraphCorpus(corpusValue); identifier(chunkId); const chunk = corpus.chunks.find(item => item.ref.chunkId === chunkId); requireCondition(chunk, 'GRAPH_UNKNOWN_CHUNK', 'Graph evidence chunk is absent from the pinned corpus');
  integer(start, chunk.ref.location.start, chunk.ref.location.end - 1); integer(end, start + 1, chunk.ref.location.end);
  const raw = new TextEncoder().encode(chunk.text).subarray(start - chunk.ref.location.start, end - chunk.ref.location.start);
  let quote: string; try { quote = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { requireCondition(false, 'GRAPH_SPAN_UTF8', 'Graph evidence splits a UTF-8 character'); }
  return immutable({ chunkId, start, end, quote, sha256: await sha256(raw) });
}
