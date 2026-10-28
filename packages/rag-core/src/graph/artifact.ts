import { assertJsonData, parseStrictJson } from '@studio/spec';
import { canonicalize } from 'json-canonicalize';
import { compareId, digest, equal, identifier, immutable, jsonDigest, object, requireCondition, text } from '../common.js';
import { sealIndexGeneration, verifyIndexArtifacts, type CorpusGeneration, type IndexGeneration } from '../corpus.js';
import { GRAPH_ARTIFACT_ID, GRAPH_FORMAT, GRAPH_LIMITS, type GraphArtifact, type GraphBundle, type GraphDraft, type GraphEntity, type GraphIdentity, type GraphRelation, type GraphSpan } from './contracts.js';
import { contains, graphList, graphText, GraphEvidenceValidator, GraphWork, identitySpans, ownGraphCorpus, sameIdentity } from './provenance.js';

const encoder = new TextEncoder();
const verifiedKey = Symbol('verified-graph');
const sorted = (items: readonly string[]): string[] => [...new Set(items)].sort(compareId);
function spans(items: readonly GraphSpan[]): GraphSpan[] { return [...new Map(items.map(item => [canonicalize(item), item])).entries()].sort(([a], [b]) => compareId(a, b)).map(([, value]) => value); }
function strings(value: unknown, maximum: number, minimum: number): string[] { graphList(value, maximum, minimum); for (const item of value) identifier(item); const result = value as string[]; requireCondition(new Set(result).size === result.length, 'GRAPH_DUPLICATE_ID', 'Graph inventory IDs must be unique'); return sorted(result); }

/** Entity equality is exact qualified source identity, never display name, embedding similarity or model confidence. */
export async function graphEntityId(identity: GraphIdentity): Promise<string> {
  object(identity, ['namespace', 'sourceIdentifier', 'version']); graphText(identity.namespace); graphText(identity.sourceIdentifier); if (identity.version !== null) graphText(identity.version);
  return `graph_entity_${await jsonDigest(identity)}`;
}

/** Compile only typed evidence-backed records. The entire input inventory is retained even when no fact is extracted. */
async function compile(corpus: CorpusGeneration, value: GraphDraft): Promise<GraphArtifact> {
  assertJsonData(value); object(value, ['inputChunkIds', 'extractionContract', 'entities', 'relations']);
  requireCondition(encoder.encode(JSON.stringify(value)).byteLength <= GRAPH_LIMITS.artifactBytes, 'GRAPH_ARTIFACT_LIMIT', 'Graph draft exceeds 8 MiB');
  const draft = structuredClone(value); const work = new GraphWork(GRAPH_LIMITS.inputWork, 'GRAPH_INPUT_WORK_LIMIT'); const evidence = new GraphEvidenceValidator(corpus, work);
  draft.inputChunkIds = strings(draft.inputChunkIds, GRAPH_LIMITS.chunks, 1);
  requireCondition(equal(draft.inputChunkIds, sorted(corpus.chunks.map(chunk => chunk.ref.chunkId))), 'GRAPH_INPUT_INVENTORY', 'Graph provenance must include every pinned corpus chunk, including unused extraction input');
  const contract = draft.extractionContract; object(contract, ['id', 'version', 'sha256', 'entityTypes', 'relationTypes']); identifier(contract.id); text(contract.version, 64); digest(contract.sha256);
  contract.entityTypes = strings(contract.entityTypes, GRAPH_LIMITS.types, 1); contract.relationTypes = strings(contract.relationTypes, GRAPH_LIMITS.types, 1);
  graphList(draft.entities, GRAPH_LIMITS.entities); graphList(draft.relations, GRAPH_LIMITS.relations);
  const entityMap = new Map<string, GraphEntity>(); const keys = new Map<string, GraphEntity>();
  const inputIds = (ids: string[]) => { const result = strings(ids, GRAPH_LIMITS.chunks, 1); requireCondition(result.every(id => draft.inputChunkIds.includes(id)), 'GRAPH_EVIDENCE_INPUT', 'Extraction record input belongs to another corpus'); return result; };
  for (const record of draft.entities) {
    work.add(); object(record, ['key', 'type', 'identity', 'label', 'aliases', 'inputChunkIds']); identifier(record.key); identifier(record.type);
    requireCondition(!keys.has(record.key) && contract.entityTypes.includes(record.type), 'GRAPH_ENTITY_RECORD', 'Entity extraction key must be unique and type declared');
    record.inputChunkIds = inputIds(record.inputChunkIds); graphList(record.aliases, GRAPH_LIMITS.aliases);
    const identity = await evidence.identity(record.identity, record.inputChunkIds); await evidence.fact(record.label, record.inputChunkIds); contains(record.identity.assertion, record.label.span);
    const id = await graphEntityId(identity); const previous = entityMap.get(id);
    requireCondition(!previous || previous.type === record.type, 'GRAPH_IDENTITY_CONFLICT', 'One qualified source identity cannot have conflicting entity types');
    const support = [...identitySpans(record.identity), record.label.span]; const aliasNames: string[] = [];
    for (const alias of record.aliases) {
      object(alias, ['name', 'identity', 'assertion']); await evidence.span(alias.assertion, record.inputChunkIds); await evidence.fact(alias.name, record.inputChunkIds);
      sameIdentity(await evidence.identity(alias.identity, record.inputChunkIds), identity); contains(alias.assertion, alias.name.span); contains(alias.assertion, alias.identity.assertion);
      support.push(alias.assertion, alias.name.span, ...identitySpans(alias.identity)); aliasNames.push(alias.name.value);
    }
    record.aliases.sort((a, b) => compareId(canonicalize(a), canonicalize(b)));
    const entity: GraphEntity = previous ?? { id, type: record.type, identity, labels: [], aliases: [], evidence: [], inputChunkIds: [] };
    entity.labels = sorted([...entity.labels, record.label.value]); entity.aliases = sorted([...entity.aliases, ...aliasNames]); entity.evidence = spans([...entity.evidence, ...support]); entity.inputChunkIds = sorted([...entity.inputChunkIds, ...record.inputChunkIds]);
    entityMap.set(id, entity); keys.set(record.key, entity);
  }
  const relationMap = new Map<string, GraphRelation>();
  for (const record of draft.relations) {
    work.add(); object(record, ['from', 'to', 'type', 'evidence', 'inputChunkIds']); identifier(record.from); identifier(record.to); identifier(record.type);
    requireCondition(contract.relationTypes.includes(record.type), 'GRAPH_RELATION_TYPE', 'Relation type is absent from the extraction ontology');
    const from = keys.get(record.from); const to = keys.get(record.to); requireCondition(from && to, 'GRAPH_ENDPOINT', 'Relation endpoints must reference extracted entity records');
    record.inputChunkIds = inputIds(record.inputChunkIds); graphList(record.evidence, GRAPH_LIMITS.evidencePerRelation, 1); const support: GraphSpan[] = [];
    for (const assertion of record.evidence) {
      object(assertion, ['assertion', 'from', 'to']); await evidence.span(assertion.assertion, record.inputChunkIds);
      sameIdentity(await evidence.identity(assertion.from, record.inputChunkIds), from.identity); sameIdentity(await evidence.identity(assertion.to, record.inputChunkIds), to.identity);
      contains(assertion.assertion, assertion.from.assertion); contains(assertion.assertion, assertion.to.assertion);
      support.push(assertion.assertion, ...identitySpans(assertion.from), ...identitySpans(assertion.to));
    }
    record.evidence.sort((a, b) => compareId(canonicalize(a), canonicalize(b)));
    const id = `graph_relation_${await jsonDigest({ from: from.id, to: to.id, type: record.type })}`;
    const relation = relationMap.get(id) ?? { id, from: from.id, to: to.id, type: record.type, evidence: [], inputChunkIds: [] };
    relation.evidence = spans([...relation.evidence, ...support]); relation.inputChunkIds = sorted([...relation.inputChunkIds, ...record.inputChunkIds]); relationMap.set(id, relation);
  }
  // Stable compilation ignores extraction record order while preserving every supplied record and exact source span.
  draft.entities.sort((a, b) => compareId(a.key, b.key)); draft.relations.sort((a, b) => compareId(canonicalize(a), canonicalize(b)));
  return immutable({ format: GRAPH_FORMAT, corpus: corpus.ref, draft, entities: [...entityMap.values()].sort((a, b) => compareId(a.id, b.id)), relations: [...relationMap.values()].sort((a, b) => compareId(a.id, b.id)) });
}

/** A handle owns verified immutable data; it is not a serialization format or a cross-process trust token. */
export class GraphIndex {
  readonly #state: { corpus: CorpusGeneration; index: IndexGeneration; artifact: GraphArtifact };
  constructor(key: symbol, state: { corpus: CorpusGeneration; index: IndexGeneration; artifact: GraphArtifact }) { requireCondition(key === verifiedKey, 'GRAPH_HANDLE', 'Graph handles must be created by openGraphIndex'); this.#state = immutable(state); Object.freeze(this); }
  snapshot(): Readonly<{ corpus: CorpusGeneration; index: IndexGeneration; artifact: GraphArtifact }> { return this.#state; }
}

/** Seal actual graph artifact bytes; no vector/keyword artifact is relabeled as a graph. */
export async function buildGraphIndex(input: { corpus: CorpusGeneration; indexId: string; generationId: string; draft: GraphDraft }): Promise<GraphBundle> {
  object(input, ['corpus', 'indexId', 'generationId', 'draft']); identifier(input.indexId); identifier(input.generationId);
  const indexId = input.indexId; const generationId = input.generationId; const draft = immutable(input.draft); const corpus = await ownGraphCorpus(input.corpus);
  const artifact = await compile(corpus, draft); const bytes = encoder.encode(canonicalize(artifact)); requireCondition(bytes.byteLength <= GRAPH_LIMITS.artifactBytes, 'GRAPH_ARTIFACT_LIMIT', 'Compiled graph artifact exceeds 8 MiB');
  const artifacts = [{ id: GRAPH_ARTIFACT_ID, bytes }]; const index = await sealIndexGeneration({ corpus: corpus.ref, indexId, generationId, kind: 'graph', artifacts });
  return { corpus, index, artifacts };
}

/** Byte hash, corpus pin, format and recomputed adjacency all agree before a graph can be queried. */
export async function openGraphIndex(value: GraphBundle): Promise<GraphIndex> {
  object(value, ['corpus', 'index', 'artifacts']); const index = immutable(value.index);
  requireCondition(index.kind === 'graph' && index.embedding === undefined, 'GRAPH_INDEX_KIND', 'This explicit graph format does not accept embeddings or another index kind');
  requireCondition(Array.isArray(value.artifacts) && value.artifacts.length === 1, 'GRAPH_ARTIFACT_INVENTORY', 'Explicit graph requires exactly one graph artifact');
  const raw = value.artifacts[0]!; object(raw, ['id', 'bytes']); requireCondition(raw.id === GRAPH_ARTIFACT_ID && raw.bytes instanceof Uint8Array && raw.bytes.byteLength > 0 && raw.bytes.byteLength <= GRAPH_LIMITS.artifactBytes, 'GRAPH_ARTIFACT_LIMIT', 'Graph artifact ID/byte size is invalid');
  const artifacts = [{ id: raw.id, bytes: new Uint8Array(raw.bytes) }]; const corpus = await ownGraphCorpus(value.corpus);
  await verifyIndexArtifacts(index, artifacts); requireCondition(equal(index.corpus, corpus.ref), 'GRAPH_CORPUS_MISMATCH', 'Graph index belongs to another corpus generation');
  let decoded: string; try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(artifacts[0]!.bytes); } catch { requireCondition(false, 'GRAPH_ARTIFACT_UTF8', 'Graph artifact is not UTF-8'); }
  const artifact = parseStrictJson(decoded!) as unknown as GraphArtifact; object(artifact, ['format', 'corpus', 'draft', 'entities', 'relations']);
  requireCondition(artifact.format === GRAPH_FORMAT && equal(artifact.corpus, corpus.ref), 'GRAPH_FORMAT', 'Unsupported graph format or corpus generation');
  const rebuilt = await compile(corpus, artifact.draft); requireCondition(equal(artifact, rebuilt), 'GRAPH_COMPILED_MISMATCH', 'Stored graph identity, adjacency or provenance differs from its verified source records');
  return new GraphIndex(verifiedKey, { corpus, index, artifact: rebuilt });
}
