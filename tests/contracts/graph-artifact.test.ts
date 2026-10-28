import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import { buildGraphIndex, createCorpusGeneration, createGraphSpan, graphEntityId, openGraphIndex, searchGraphLocal, sealIndexGeneration, GRAPH_ARTIFACT_ID, GRAPH_FORMAT, type AuthorizationSnapshot, type CorpusGeneration, type GraphArtifact, type GraphBundle, type GraphDraft, type GraphEntityInput, type GraphFact, type GraphIdentityEvidence, type GraphLocalRequest, type GraphRelationInput, type GraphSpan } from '@studio/rag-core';

const scope = { tenantId: 'tenant', projectId: 'project' };
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
type Entity = { namespace: string; id: string; version: string | null; label: string };

/** Exact original source spans are assembled as test data; no model quality or external extraction is simulated as production proof. */
async function fixture(options: { entities?: Entity[]; edges?: [number, number][]; alias?: string } = {}) {
  const entities = options.entities ?? [{ namespace: 'acme', id: 'A', version: 'v1', label: '공통' }, { namespace: 'acme', id: 'B', version: 'v1', label: '공통' }, { namespace: 'acme', id: 'C', version: 'v1', label: 'Gamma' }];
  const edges = options.edges ?? [[0, 1], [1, 2], [2, 0]];
  const qualified = (entity: Entity) => `${entity.namespace}/${entity.id}${entity.version === null ? '' : `@${entity.version}`}`;
  const lines = entities.map(entity => `${qualified(entity)} ${entity.label}`); const alias = options.alias ?? 'billing'; const aliasLine = `${qualified(entities[0]!)} alias ${alias}`;
  const texts = [`\uFEFF${[...lines, aliasLine].join('\n')}`, edges.length ? edges.map(([from, to]) => `${qualified(entities[from]!)} depends_on ${qualified(entities[to]!)}`).join('\n') : 'No relations were supplied.', 'The extractor also received this unused source.'];
  const corpus = await createCorpusGeneration({ scope, corpusId: 'corpus', generationId: 'c1', documents: texts.map((text, i) => ({ documentId: `d${i}`, revision: 1, sourceUri: `urn:sample:d${i}`, originalBytes: bytes(text), extractedText: text, extraction: { id: 'utf8', version: '1', options: { preserveBom: true } } })), chunks: texts.map((text, i) => ({ chunkId: `c${i}`, documentId: `d${i}`, start: 0, end: bytes(text).byteLength })) });
  const span = (chunk: number, start: number, end: number): GraphSpan => {
    const quote = texts[chunk]!.slice(start, end); return { chunkId: `c${chunk}`, start: bytes(texts[chunk]!.slice(0, start)).length, end: bytes(texts[chunk]!.slice(0, end)).length, quote, sha256: digest(bytes(quote)) };
  };
  const fact = (chunk: number, value: string, start: number): GraphFact => ({ value, span: span(chunk, start, start + value.length) });
  const identity = (chunk: number, entity: Entity, start: number, assertionEnd = start + qualified(entity).length): GraphIdentityEvidence => ({ namespace: fact(chunk, entity.namespace, start), sourceIdentifier: fact(chunk, entity.id, start + entity.namespace.length + 1), version: entity.version === null ? null : fact(chunk, entity.version, start + entity.namespace.length + entity.id.length + 2), assertion: span(chunk, start, assertionEnd) });
  const inputs = ['c0', 'c1', 'c2'];
  const records: GraphEntityInput[] = entities.map((entity, i) => {
    const start = texts[0]!.indexOf(lines[i]!); return { key: `e${i}`, type: 'service', identity: identity(0, entity, start, start + lines[i]!.length), label: fact(0, entity.label, start + qualified(entity).length + 1), aliases: [], inputChunkIds: inputs };
  });
  const aliasStart = texts[0]!.indexOf(aliasLine); records[0]!.aliases.push({ name: fact(0, alias, aliasStart + qualified(entities[0]!).length + 7), identity: identity(0, entities[0]!, aliasStart), assertion: span(0, aliasStart, aliasStart + aliasLine.length) });
  let next = 0;
  const relations: GraphRelationInput[] = edges.map(([from, to]) => {
    const line = `${qualified(entities[from]!)} depends_on ${qualified(entities[to]!)}`; const start = texts[1]!.indexOf(line, next); next = start + line.length;
    return { from: `e${from}`, to: `e${to}`, type: 'depends_on', inputChunkIds: inputs, evidence: [{ assertion: span(1, start, start + line.length), from: identity(1, entities[from]!, start), to: identity(1, entities[to]!, start + qualified(entities[from]!).length + 12) }] };
  });
  const draft: GraphDraft = { inputChunkIds: inputs, extractionContract: { id: 'test-explicit-contract', version: '1', sha256: digest('test-only-extraction'), entityTypes: ['service'], relationTypes: ['depends_on'] }, entities: records, relations };
  const bundle = await buildGraphIndex({ corpus, indexId: 'graph', generationId: 'g1', draft });
  const snapshot: AuthorizationSnapshot = { scope, subjectId: 'alice', groupIds: ['team'], epoch: 7, documents: texts.map((_, i) => ({ documentId: `d${i}`, revision: 1, tombstoned: false, allowedSubjects: [], allowedGroups: ['team'] })) };
  const request: GraphLocalRequest = { principal: { scope, subjectId: 'alice' }, authorizationSnapshot: snapshot, expectedEpoch: 7, seeds: [{ alias: 'billing' }], direction: 'outgoing', maxHops: 2 };
  return { corpus, draft, bundle, snapshot, request, texts, records, span, build: (changed: GraphDraft) => buildGraphIndex({ corpus, indexId: 'graph', generationId: 'g1', draft: changed }) };
}
async function reseal(bundle: GraphBundle, change: (artifact: GraphArtifact) => void): Promise<GraphBundle> {
  const artifact: GraphArtifact = JSON.parse(new TextDecoder().decode(bundle.artifacts[0]!.bytes)); change(artifact);
  const artifacts = [{ id: GRAPH_ARTIFACT_ID, bytes: bytes(canonicalize(artifact)) }];
  return { corpus: bundle.corpus, artifacts, index: await sealIndexGeneration({ corpus: bundle.corpus.ref, indexId: 'graph', generationId: 'g2', kind: 'graph', artifacts }) };
}

describe('versioned graph source and compilation contracts', () => {
  it('builds real immutable entities/edges and stable explicit identities, preserving unused extraction input', async () => {
    const { bundle } = await fixture(); const graph = await openGraphIndex(bundle); const artifact = graph.snapshot().artifact;
    expect(artifact.format).toBe(GRAPH_FORMAT); expect(artifact.entities).toHaveLength(3); expect(artifact.relations).toHaveLength(3);
    expect(artifact.draft.inputChunkIds).toEqual(['c0', 'c1', 'c2']); expect(artifact.entities.filter(entity => entity.labels.includes('공통'))).toHaveLength(2);
    expect(artifact.entities.find(entity => entity.aliases.includes('billing'))!.id).toBe(await graphEntityId({ namespace: 'acme', sourceIdentifier: 'A', version: 'v1' }));
    expect(Object.isFrozen(artifact.entities)).toBe(true);
  });
  it('deterministically rebuilds after input records are reordered', async () => {
    const { draft, bundle, build } = await fixture(); draft.entities.reverse(); draft.relations.reverse(); draft.inputChunkIds.reverse();
    const reversed = await build(draft); expect(reversed.index.ref).toEqual(bundle.index.ref); expect(reversed.artifacts[0]!.bytes).toEqual(bundle.artifacts[0]!.bytes);
  });
  it('merges only equal qualified identities and keeps all independently grounded labels', async () => {
    const { draft, build } = await fixture(); draft.entities.push({ ...structuredClone(draft.entities[0]!), key: 'repeat' });
    const graph = await openGraphIndex(await build(draft)); expect(graph.snapshot().artifact.entities).toHaveLength(3); expect(graph.snapshot().artifact.draft.entities).toHaveLength(4);
  });
  it('separates identical names and source identifiers in different namespaces and versions', async () => {
    const { bundle, request } = await fixture({ entities: [{ namespace: 'one', id: 'A', version: 'v1', label: 'Shared' }, { namespace: 'two', id: 'A', version: 'v1', label: 'Shared' }, { namespace: 'one', id: 'A', version: 'v2', label: 'Shared' }], edges: [] }); const graph = await openGraphIndex(bundle);
    expect(graph.snapshot().artifact.entities).toHaveLength(3);
    await expect(searchGraphLocal(graph, { ...request, seeds: [{ alias: 'Shared' }] })).rejects.toMatchObject({ code: 'GRAPH_SEED_AMBIGUOUS' });
    expect((await searchGraphLocal(graph, { ...request, seeds: [{ alias: 'Shared', namespace: 'one', version: 'v2' }] })).entities[0]!.identity.version).toBe('v2');
  });
  it('keeps missing version distinct from an explicit version without inventing latest', async () => {
    const { bundle, request } = await fixture({ entities: [{ namespace: 'one', id: 'A', version: null, label: 'Shared' }, { namespace: 'one', id: 'A', version: 'v1', label: 'Shared' }], edges: [] }); const graph = await openGraphIndex(bundle);
    expect((await searchGraphLocal(graph, { ...request, seeds: [{ alias: 'Shared', namespace: 'one', version: null }] })).entities[0]!.identity.version).toBeNull();
  });
  it('preserves UTF-8, BOM and document-relative offsets and rejects split Unicode characters', async () => {
    const text = 'prefix\uFEFF한글'; const corpus = await createCorpusGeneration({ scope, corpusId: 'utf8', generationId: 'c', documents: [{ documentId: 'd', revision: 1, originalBytes: bytes(text), extractedText: text, sourceUri: 'urn:sample:utf8', extraction: { id: 'text', version: '1', options: {} } }], chunks: [{ chunkId: 'c', documentId: 'd', start: 6, end: bytes(text).length }] });
    expect(await createGraphSpan(corpus, 'c', 6, 9)).toEqual({ chunkId: 'c', start: 6, end: 9, quote: '\uFEFF', sha256: digest(bytes('\uFEFF')) });
    await expect(createGraphSpan(corpus, 'c', 10, 12)).rejects.toMatchObject({ code: 'GRAPH_SPAN_UTF8' });
  });
  it.each(['quote', 'hash', 'range'] as const)('rejects forged %s evidence even when JSON is well formed', async kind => {
    const { draft, build } = await fixture(); const span = draft.entities[0]!.identity.sourceIdentifier.span;
    if (kind === 'quote') span.quote = 'Z'; else if (kind === 'hash') span.sha256 = '0'.repeat(64); else span.end += 1;
    await expect(build(draft)).rejects.toThrow();
  });
  it('requires identity namespace/version/label within the same asserted source range', async () => {
    const { draft, build } = await fixture(); draft.entities[0]!.identity.assertion = draft.entities[0]!.identity.namespace.span;
    await expect(build(draft)).rejects.toMatchObject({ code: 'GRAPH_ASSERTION_RANGE' });
  });
  it('rejects an alias copied from another identity and an alias span outside its assertion', async () => {
    const first = await fixture(); first.draft.entities[0]!.aliases[0]!.identity = first.draft.entities[1]!.identity;
    await expect(first.build(first.draft)).rejects.toMatchObject({ code: 'GRAPH_IDENTITY_MISMATCH' });
    const second = await fixture(); second.draft.entities[0]!.aliases[0]!.assertion = second.draft.entities[0]!.identity.assertion;
    await expect(second.build(second.draft)).rejects.toMatchObject({ code: 'GRAPH_ASSERTION_RANGE' });
  });
  it('rejects absent endpoints and mismatched endpoint versions even when their quote is valid', async () => {
    const first = await fixture(); first.draft.relations[0]!.to = 'absent'; await expect(first.build(first.draft)).rejects.toMatchObject({ code: 'GRAPH_ENDPOINT' });
    const second = await fixture(); second.draft.relations[0]!.from = 'e1'; await expect(second.build(second.draft)).rejects.toMatchObject({ code: 'GRAPH_IDENTITY_MISMATCH' });
  });
  it('does not allow a relation without both endpoints inside its original assertion', async () => {
    const { draft, build } = await fixture(); draft.relations[0]!.evidence[0]!.assertion = draft.relations[0]!.evidence[0]!.from.assertion;
    await expect(build(draft)).rejects.toMatchObject({ code: 'GRAPH_ASSERTION_RANGE' });
  });
  it('rejects omitted input provenance, unknown source chunks and undeclared types', async () => {
    const first = await fixture(); first.draft.inputChunkIds.pop(); await expect(first.build(first.draft)).rejects.toMatchObject({ code: 'GRAPH_INPUT_INVENTORY' });
    const second = await fixture(); second.draft.entities[0]!.inputChunkIds = ['c1']; await expect(second.build(second.draft)).rejects.toMatchObject({ code: 'GRAPH_EVIDENCE_INPUT' });
    const third = await fixture(); third.draft.relations[0]!.type = 'invented'; await expect(third.build(third.draft)).rejects.toMatchObject({ code: 'GRAPH_RELATION_TYPE' });
  });
  it('rejects one qualified identity assigned conflicting types', async () => {
    const { draft, build } = await fixture(); draft.extractionContract.entityTypes.push('person'); draft.entities.push({ ...structuredClone(draft.entities[0]!), key: 'other', type: 'person' });
    await expect(build(draft)).rejects.toMatchObject({ code: 'GRAPH_IDENTITY_CONFLICT' });
  });
  it('rejects artifact byte damage and compiled edges changed under a new valid outer hash', async () => {
    const { bundle } = await fixture(); const bad = structuredClone(bundle); bad.artifacts[0]!.bytes[0] = 0; await expect(openGraphIndex(bad)).rejects.toMatchObject({ code: 'INDEX_ARTIFACT_MISMATCH' });
    await expect(openGraphIndex(await reseal(bundle, artifact => { artifact.relations[0]!.from = artifact.relations[0]!.to; }))).rejects.toMatchObject({ code: 'GRAPH_COMPILED_MISMATCH' });
  });
  it('rejects forged evidence under a freshly sealed manifest', async () => {
    const { bundle } = await fixture(); const forged = await reseal(bundle, artifact => { artifact.draft.entities[0]!.identity.sourceIdentifier.span.sha256 = '0'.repeat(64); });
    await expect(openGraphIndex(forged)).rejects.toMatchObject({ code: 'GRAPH_SPAN_HASH' });
  });
  it('rejects future formats, extra fields, truncated JSON and foreign corpus pins', async () => {
    const { bundle } = await fixture();
    await expect(openGraphIndex(await reseal(bundle, artifact => { (artifact as { format: string }).format = 'future'; }))).rejects.toMatchObject({ code: 'GRAPH_FORMAT' });
    await expect(openGraphIndex(await reseal(bundle, artifact => { Object.assign(artifact, { handler: 'arbitrary' }); }))).rejects.toThrow();
    await expect(openGraphIndex(await reseal(bundle, artifact => { artifact.corpus.generationId = 'other'; }))).rejects.toMatchObject({ code: 'GRAPH_FORMAT' });
    const artifacts = [{ id: GRAPH_ARTIFACT_ID, bytes: bytes('{') }]; const index = await sealIndexGeneration({ corpus: bundle.corpus.ref, indexId: 'g', generationId: 'g2', kind: 'graph', artifacts });
    await expect(openGraphIndex({ corpus: bundle.corpus, index, artifacts })).rejects.toThrow();
  });
  it('owns a snapshot before asynchronous work and after opening', async () => {
    const { corpus, draft, request } = await fixture(); const pending = buildGraphIndex({ corpus, draft, indexId: 'g', generationId: 'g1' }); draft.entities.length = 0;
    const bundle = await pending; const graph = await openGraphIndex(bundle); bundle.artifacts[0]!.bytes.fill(0);
    expect((await searchGraphLocal(graph, request)).entities).toHaveLength(3);
  });
});

describe('real directional graph search and authoritative access boundaries', () => {
  it('uses actual outgoing adjacency and returns one deterministic shortest path plus original source citations', async () => {
    const { bundle, request, texts } = await fixture(); const result = await searchGraphLocal(await openGraphIndex(bundle), request);
    const identify = (id: string) => result.entities.find(entity => entity.id === id)!.identity.sourceIdentifier;
    expect(result.paths.map(path => path.entityIds.map(identify)).sort((a, b) => a.length - b.length)).toEqual([['A', 'B'], ['A', 'B', 'C']]);
    expect(result.paths.flatMap(path => path.steps).every(step => step.traversal === 'forward')).toBe(true);
    expect(result.citations.map(citation => citation.quote)).toEqual(texts.slice(0, 2)); expect(result.inputChunkIds).toEqual(['c0', 'c1', 'c2']);
    for (const item of result.evidenceCitations) { const citation = result.citations.find(c => c.id === item.citationId)!; expect(new TextDecoder().decode(bytes(citation.quote).subarray(item.evidence.start - citation.chunk.location.start, item.evidence.end - citation.chunk.location.start))).toBe(item.evidence.quote); }
  });
  it('reverses traversal explicitly without reversing the underlying relation', async () => {
    const { bundle, request } = await fixture(); const result = await searchGraphLocal(await openGraphIndex(bundle), { ...request, direction: 'incoming', maxHops: 1 });
    expect(result.paths).toHaveLength(1); const path = result.paths[0]!; const relation = result.relations.find(edge => edge.id === path.steps[0]!.relationId)!;
    expect(path.steps[0]!.traversal).toBe('reverse'); expect(relation.to).toBe(path.seedId); expect(relation.from).toBe(path.targetId);
    expect(result.entities.find(entity => entity.id === path.targetId)!.identity.sourceIdentifier).toBe('C');
  });
  it('handles both directions and cycles without claiming all possible paths', async () => {
    const { bundle, request } = await fixture(); const result = await searchGraphLocal(await openGraphIndex(bundle), { ...request, direction: 'both', maxHops: 10 });
    expect(result.entities).toHaveLength(3); expect(result.paths).toHaveLength(2); expect(result.relations).toHaveLength(3); expect(result.usage.examinedRelations).toBe(6);
    expect(result.paths.every(path => new Set(path.entityIds).size === path.entityIds.length)).toBe(true);
  });
  it.each(['tombstone', 'group', 'revision', 'missing'] as const)('denies the whole graph when an unused input has %s changes', async cause => {
    const { bundle, request, snapshot } = await fixture(); const changed = structuredClone(snapshot);
    if (cause === 'tombstone') changed.documents[2]!.tombstoned = true;
    if (cause === 'group') changed.groupIds = [];
    if (cause === 'revision') changed.documents[2]!.revision = 2;
    if (cause === 'missing') changed.documents.pop();
    await expect(searchGraphLocal(await openGraphIndex(bundle), { ...request, authorizationSnapshot: changed })).rejects.toMatchObject({ code: 'GRAPH_ACCESS_DENIED' });
  });
  it('rejects a stale epoch, a spoofed subject and a cross-tenant principal before resolving names', async () => {
    const { bundle, request } = await fixture(); const graph = await openGraphIndex(bundle);
    await expect(searchGraphLocal(graph, { ...request, expectedEpoch: 8 })).rejects.toMatchObject({ code: 'STALE_AUTHORIZATION' });
    await expect(searchGraphLocal(graph, { ...request, principal: { ...request.principal, subjectId: 'bob' } })).rejects.toMatchObject({ code: 'SUBJECT_MISMATCH' });
    await expect(searchGraphLocal(graph, { ...request, principal: { ...request.principal, scope: { ...scope, tenantId: 'other' } } })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  });
  it('does not expose ambiguous seed information before access succeeds', async () => {
    const { bundle, request, snapshot } = await fixture(); const denied = structuredClone(snapshot); denied.documents[2]!.tombstoned = true;
    await expect(searchGraphLocal(await openGraphIndex(bundle), { ...request, seeds: [{ alias: '공통' }], authorizationSnapshot: denied })).rejects.toMatchObject({ code: 'GRAPH_ACCESS_DENIED' });
  });
  it.each([['maxVisitedEntities', 'GRAPH_VISITED_LIMIT'], ['maxExaminedRelations', 'GRAPH_EDGE_LIMIT'], ['maxPaths', 'GRAPH_PATH_LIMIT'], ['maxWork', 'GRAPH_SEARCH_WORK_LIMIT']] as const)('fails closed at %s instead of returning a partial success', async (key, code) => {
    const { bundle, request } = await fixture(); await expect(searchGraphLocal(await openGraphIndex(bundle), { ...request, limits: { [key]: 1 } })).rejects.toMatchObject({ code });
  });
  it('counts real dense adjacency work and bounds cycles independently of hop count', async () => {
    const entities = Array.from({ length: 12 }, (_, i) => ({ namespace: 'dense', id: `n${i}`, version: 'v1', label: `Node${i}` }));
    const edges = entities.flatMap((_, from) => entities.flatMap((_, to): [number, number][] => from === to ? [] : [[from, to]]));
    const { bundle, request } = await fixture({ entities, edges }); const graph = await openGraphIndex(bundle);
    const result = await searchGraphLocal(graph, { ...request, maxHops: 10 }); expect(result.paths).toHaveLength(11); expect(result.usage.examinedRelations).toBe(132);
    await expect(searchGraphLocal(graph, { ...request, maxHops: 10, limits: { maxExaminedRelations: 100 } })).rejects.toMatchObject({ code: 'GRAPH_EDGE_LIMIT' });
  });
  it('rejects unknown/duplicate seeds, filters and arbitrary directions', async () => {
    const { bundle, request } = await fixture(); const graph = await openGraphIndex(bundle);
    await expect(searchGraphLocal(graph, { ...request, seeds: [{ alias: 'invented' }] })).rejects.toMatchObject({ code: 'GRAPH_SEED_NOT_FOUND' });
    await expect(searchGraphLocal(graph, { ...request, seeds: [...request.seeds, ...request.seeds] })).rejects.toMatchObject({ code: 'GRAPH_SEED_DUPLICATE' });
    await expect(searchGraphLocal(graph, { ...request, relationTypes: ['unknown'] })).rejects.toMatchObject({ code: 'GRAPH_RELATION_FILTER' });
    await expect(searchGraphLocal(graph, { ...request, direction: 'invented' as never })).rejects.toMatchObject({ code: 'GRAPH_DIRECTION' });
  });
  it('honors cancellation and rejects overlarge bound overrides', async () => {
    const { bundle, request } = await fixture(); const graph = await openGraphIndex(bundle);
    await expect(searchGraphLocal(graph, request, AbortSignal.abort())).rejects.toThrow();
    await expect(searchGraphLocal(graph, { ...request, limits: { maxWork: 20001 } })).rejects.toThrow();
  });
});
