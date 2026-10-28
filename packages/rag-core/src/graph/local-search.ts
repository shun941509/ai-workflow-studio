import { compareId, immutable, integer, jsonDigest, object, requireCondition } from '../common.js';
import { filterDerivedEvidence, type Citation } from '../access.js';
import { candidateId } from '../ranking.js';
import { GraphIndex } from './artifact.js';
import { GRAPH_LIMITS, type GraphLocalRequest, type GraphLocalResult, type GraphPath, type GraphRelation, type GraphSearchLimits, type GraphSpan } from './contracts.js';
import { graphList, graphText, GraphWork } from './provenance.js';

const defaults: GraphSearchLimits = Object.freeze({ maxVisitedEntities: GRAPH_LIMITS.visitedEntities, maxExaminedRelations: GRAPH_LIMITS.examinedRelations, maxPaths: GRAPH_LIMITS.paths, maxWork: GRAPH_LIMITS.searchWork });
type Step = { relation: GraphRelation; next: string; traversal: 'forward' | 'reverse' };

/** Directional BFS over real compiled adjacency. Every limit fails explicitly; no partial path set masquerades as complete. */
export async function searchGraphLocal(handle: GraphIndex, request: GraphLocalRequest, signal?: AbortSignal): Promise<GraphLocalResult> {
  signal?.throwIfAborted(); requireCondition(handle instanceof GraphIndex, 'GRAPH_HANDLE', 'Local graph search requires a verified immutable graph handle');
  const owned = immutable(request); object(owned, ['principal', 'authorizationSnapshot', 'expectedEpoch', 'seeds', 'direction', 'relationTypes', 'maxHops', 'limits']);
  graphList(owned.seeds, 8, 1); integer(owned.maxHops, 1, 10); requireCondition(['outgoing', 'incoming', 'both'].includes(owned.direction), 'GRAPH_DIRECTION', 'Unknown graph traversal direction');
  if (owned.limits) object(owned.limits, Object.keys(defaults)); const limits = { ...defaults, ...owned.limits };
  for (const key of Object.keys(defaults) as (keyof GraphSearchLimits)[]) integer(limits[key], 1, defaults[key]);
  const work = new GraphWork(limits.maxWork, 'GRAPH_SEARCH_WORK_LIMIT'); const { corpus, index, artifact } = handle.snapshot();
  // Topology and aliases may depend on every extraction input, even a chunk omitted from final model citations.
  // A trusted caller must supply a fresh authoritative snapshot and recheck its epoch before subsequent disclosure.
  const allowed = await filterDerivedEvidence({ corpus, index, principal: owned.principal }, [{ id: 'whole_graph', kind: 'summary', text: 'graph-input-inventory', supportingChunkIds: artifact.draft.inputChunkIds }], owned.authorizationSnapshot, owned.expectedEpoch);
  requireCondition(allowed.length === 1, 'GRAPH_ACCESS_DENIED', 'Every graph input must remain readable; partial topology filtering is not permitted'); signal?.throwIfAborted();
  const entityMap = new Map(artifact.entities.map(entity => { work.add(); return [entity.id, entity] as const; }));
  const seedIds: string[] = [];
  for (const seed of owned.seeds) {
    object(seed, 'entityId' in seed ? ['entityId'] : ['alias', 'namespace', 'version']); let matches: string[];
    if ('entityId' in seed) { graphText(seed.entityId, 128); matches = entityMap.has(seed.entityId) ? [seed.entityId] : []; }
    else {
      graphText(seed.alias); if (seed.namespace !== undefined) graphText(seed.namespace); if (seed.version !== undefined && seed.version !== null) graphText(seed.version);
      matches = artifact.entities.filter(entity => { work.add(); return (entity.identity.sourceIdentifier === seed.alias || entity.labels.includes(seed.alias) || entity.aliases.includes(seed.alias)) && (seed.namespace === undefined || seed.namespace === entity.identity.namespace) && (seed.version === undefined || seed.version === entity.identity.version); }).map(entity => entity.id);
    }
    requireCondition(matches.length > 0, 'GRAPH_SEED_NOT_FOUND', 'No graph entity has this exact ID/name/alias');
    requireCondition(matches.length === 1, 'GRAPH_SEED_AMBIGUOUS', 'This name identifies multiple namespaces or versions; an explicit qualified seed is required');
    requireCondition(!seedIds.includes(matches[0]!), 'GRAPH_SEED_DUPLICATE', 'Duplicate graph seeds are not silently merged'); seedIds.push(matches[0]!);
  }
  seedIds.sort(compareId);
  let types = artifact.draft.extractionContract.relationTypes;
  if (owned.relationTypes !== undefined) { graphList(owned.relationTypes, GRAPH_LIMITS.types, 1); requireCondition(new Set(owned.relationTypes).size === owned.relationTypes.length && owned.relationTypes.every(type => types.includes(type)), 'GRAPH_RELATION_FILTER', 'Relation filter must contain distinct declared relation types'); types = owned.relationTypes; }
  const adjacency = new Map<string, Step[]>();
  const add = (id: string, step: Step) => { const list = adjacency.get(id) ?? []; list.push(step); adjacency.set(id, list); };
  for (const relation of artifact.relations) {
    work.add(); if (!types.includes(relation.type)) continue;
    if (owned.direction !== 'incoming') add(relation.from, { relation, next: relation.to, traversal: 'forward' });
    if (owned.direction !== 'outgoing') add(relation.to, { relation, next: relation.from, traversal: 'reverse' });
  }
  for (const list of adjacency.values()) list.sort((a, b) => { work.add(); return compareId(a.relation.id, b.relation.id) || compareId(a.traversal, b.traversal); });
  const visited = new Set<string>(); const chosenRelations = new Map<string, GraphRelation>(); const paths: GraphPath[] = []; let examined = 0;
  const visit = (id: string) => { visited.add(id); requireCondition(visited.size <= limits.maxVisitedEntities, 'GRAPH_VISITED_LIMIT', 'Graph traversal exceeds its distinct entity bound'); };
  for (const seedId of seedIds) {
    const reached = new Map<string, GraphPath>([[seedId, { seedId, targetId: seedId, entityIds: [seedId], steps: [] }]]); const queue = [seedId]; visit(seedId);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      work.add(); signal?.throwIfAborted(); const current = reached.get(queue[cursor]!)!; if (current.steps.length === owned.maxHops) continue;
      for (const step of adjacency.get(current.targetId) ?? []) {
        work.add(); examined++; requireCondition(examined <= limits.maxExaminedRelations, 'GRAPH_EDGE_LIMIT', 'Graph traversal exceeds its examined adjacency bound');
        chosenRelations.set(step.relation.id, step.relation); visit(step.next); if (reached.has(step.next)) continue;
        const path: GraphPath = { seedId, targetId: step.next, entityIds: [...current.entityIds, step.next], steps: [...current.steps, { relationId: step.relation.id, traversal: step.traversal }] };
        paths.push(path); requireCondition(paths.length <= limits.maxPaths, 'GRAPH_PATH_LIMIT', 'Graph traversal exceeds its returned shortest-path bound'); reached.set(step.next, path); queue.push(step.next);
      }
    }
  }
  const entities = [...visited].sort(compareId).map(id => entityMap.get(id)!); const relations = [...chosenRelations.values()].sort((a, b) => compareId(a.id, b.id));
  paths.sort((a, b) => compareId(a.seedId, b.seedId) || compareId(a.targetId, b.targetId));
  const supports = new Map<string, GraphSpan>();
  for (const record of [...entities, ...relations]) for (const span of record.evidence) { work.add(); supports.set(`${span.chunkId}:${span.start}:${span.end}:${span.sha256}`, span); }
  const chunks = [...new Set([...supports.values()].map(span => span.chunkId))].sort(compareId); const citations: Citation[] = [];
  for (const chunkId of chunks) {
    work.add(); const chunk = corpus.chunks.find(value => value.ref.chunkId === chunkId)!;
    citations.push({ id: `graph_source_${await jsonDigest({ index: index.ref, chunkId })}`, candidateId: candidateId(index.ref, chunkId), index: index.ref, chunk: chunk.ref, quote: chunk.text, authorizationEpoch: owned.expectedEpoch }); signal?.throwIfAborted();
  }
  const citationsByChunk = new Map(citations.map(citation => [citation.chunk.chunkId, citation.id]));
  return immutable({ mode: 'graph_local', index: index.ref, seedIds, entities, relations, paths, citations, evidenceCitations: [...supports].sort(([a], [b]) => compareId(a, b)).map(([, evidence]) => ({ evidence, citationId: citationsByChunk.get(evidence.chunkId)! })), authorizationEpoch: owned.expectedEpoch, inputChunkIds: artifact.draft.inputChunkIds, usage: { visitedEntities: visited.size, examinedRelations: examined, paths: paths.length, work: work.used } });
}
