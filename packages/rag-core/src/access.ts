import { assertJsonData } from '@studio/spec';
import { assertScope, equal, identifier, immutable, integer, object, requireCondition, validateScope, type AccessScope } from './common.js';
import { verifyCorpusGeneration, verifyIndexGeneration, type ChunkRef, type CorpusGeneration, type IndexGeneration, type IndexRef } from './corpus.js';
import { assertCandidate, type Candidate } from './ranking.js';

export interface Principal { scope: AccessScope; subjectId: string }
export interface DocumentAccess { documentId: string; revision: number; tombstoned: boolean; allowedSubjects: string[]; allowedGroups: string[] }
export interface AuthorizationSnapshot { scope: AccessScope; subjectId: string; groupIds: string[]; epoch: number; documents: DocumentAccess[] }
export interface AccessAuthority {
  /** Membership and document ACL/tombstone state share one current epoch; session-cached groups are insufficient. */
  readCurrent(scope: AccessScope, subjectId: string): Promise<AuthorizationSnapshot>;
}
export interface RetrievalContext { principal: Principal; corpus: CorpusGeneration; index: IndexGeneration }
export interface AuthorizationResult { candidates: readonly Candidate[]; deniedCount: number; authorizationEpoch: number }
export interface Citation { id: string; candidateId: string; index: IndexRef; chunk: ChunkRef; quote: string; authorizationEpoch: number }

/** Derive the search prefilter from current authority, not caller-supplied session groups or document IDs. */
export async function currentSearchAuthorization(context: RetrievalContext, authority: AccessAuthority): Promise<{ allowedDocumentIds: string[]; authorizationEpoch: number }> {
  context = immutable(context);
  await verifyCorpusGeneration(context.corpus); await verifyIndexGeneration(context.index);
  assertScope(context.corpus.ref.scope, context.principal.scope); assertScope(context.index.ref.scope, context.principal.scope);
  requireCondition(equal(context.index.corpus, context.corpus.ref), 'CORPUS_GENERATION_MISMATCH', 'Search authorization requires the pinned corpus');
  const snapshot = immutable(await authority.readCurrent(context.principal.scope, context.principal.subjectId));
  const records = validateAuthorization(context.principal, snapshot);
  return immutable({ allowedDocumentIds: [...new Set(context.corpus.chunks.filter(chunk => readable(chunk.ref, context.principal, snapshot.groupIds, records)).map(chunk => chunk.ref.document.documentId))].sort(), authorizationEpoch: snapshot.epoch });
}

function validateAuthorization(principal: Principal, snapshot: AuthorizationSnapshot): Map<string, DocumentAccess> {
  assertJsonData(principal); assertJsonData(snapshot); object(principal, ['scope', 'subjectId']); object(snapshot, ['scope', 'subjectId', 'groupIds', 'epoch', 'documents']);
  assertScope(snapshot.scope, principal.scope); identifier(principal.subjectId); integer(snapshot.epoch, 1, Number.MAX_SAFE_INTEGER);
  requireCondition(snapshot.subjectId === principal.subjectId, 'SUBJECT_MISMATCH', 'Authorization authority returned another subject');
  requireCondition(Array.isArray(snapshot.groupIds) && snapshot.groupIds.length <= 1000 && new Set(snapshot.groupIds).size === snapshot.groupIds.length && Array.isArray(snapshot.documents) && snapshot.documents.length <= 10000, 'ACL_LIMIT', 'ACL scope exceeds bounded limits');
  for (const group of snapshot.groupIds) identifier(group);
  const records = new Map<string, DocumentAccess>();
  for (const record of snapshot.documents) {
    object(record, ['documentId', 'revision', 'tombstoned', 'allowedSubjects', 'allowedGroups']); identifier(record.documentId); integer(record.revision, 1, Number.MAX_SAFE_INTEGER);
    requireCondition(typeof record.tombstoned === 'boolean' && Array.isArray(record.allowedSubjects) && record.allowedSubjects.length <= 1000 && Array.isArray(record.allowedGroups) && record.allowedGroups.length <= 1000 && !records.has(record.documentId), 'INVALID_ACL_RECORD', 'Invalid/duplicate current document access record');
    for (const subject of [...record.allowedSubjects, ...record.allowedGroups]) identifier(subject);
    records.set(record.documentId, record);
  }
  return records;
}

function readable(ref: ChunkRef, principal: Principal, currentGroups: readonly string[], records: Map<string, DocumentAccess>): boolean {
  assertScope(ref.document.scope, principal.scope);
  const current = records.get(ref.document.documentId);
  return Boolean(current && !current.tombstoned && current.revision === ref.document.revision && (current.allowedSubjects.includes(principal.subjectId) || current.allowedGroups.some(group => currentGroups.includes(group))));
}

/** Missing/revoked/deleted/replaced records deny access even when the sealed old index still contains them. */
export async function filterAuthorized(context: RetrievalContext, candidates: readonly Candidate[], snapshot: AuthorizationSnapshot, expectedEpoch: number): Promise<AuthorizationResult> {
  context = immutable(context); candidates = immutable(candidates); snapshot = immutable(snapshot);
  await verifyCorpusGeneration(context.corpus); await verifyIndexGeneration(context.index);
  const records = validateAuthorization(context.principal, snapshot); integer(expectedEpoch, 1, Number.MAX_SAFE_INTEGER);
  requireCondition(snapshot.epoch === expectedEpoch, 'STALE_AUTHORIZATION', 'Authorization snapshot is not the required current epoch');
  assertScope(context.corpus.ref.scope, context.principal.scope); assertScope(context.index.ref.scope, context.principal.scope);
  requireCondition(equal(context.index.corpus, context.corpus.ref), 'CORPUS_GENERATION_MISMATCH', 'Authorization cannot cross corpus generations');
  requireCondition(candidates.length <= 1000, 'CANDIDATE_LIMIT', 'Too many candidates');
  const allowed: Candidate[] = [];
  for (const candidate of candidates) { assertCandidate(candidate, context.corpus, context.index); if (readable(candidate.chunk, context.principal, snapshot.groupIds, records)) allowed.push(candidate); }
  const normalized = allowed.map((candidate, offset) => {
    const channel = Object.keys(candidate.stages).length === 1 ? (candidate.stages.keyword ? 'keyword' : candidate.stages.vector ? 'vector' : undefined) : undefined;
    return { ...candidate, rank: offset + 1, stages: channel ? { [channel]: { ...candidate.stages[channel]!, rank: offset + 1 } } : candidate.stages };
  });
  return immutable({ candidates: normalized, deniedCount: candidates.length - allowed.length, authorizationEpoch: snapshot.epoch });
}

/** No process-global cache: callers repeat this before reranker disclosure and before final answer disclosure. */
export async function authorizeCurrent(context: RetrievalContext, candidates: readonly Candidate[], authority: AccessAuthority): Promise<AuthorizationResult> {
  const ownedContext = immutable(context); const ownedCandidates = immutable(candidates);
  const snapshot = await authority.readCurrent(ownedContext.principal.scope, ownedContext.principal.subjectId);
  return filterAuthorized(ownedContext, ownedCandidates, snapshot, snapshot.epoch);
}

/** Every selected source must still be authorized; partial redaction cannot silently validate an existing answer. */
export async function buildCitations(candidateIds: readonly string[], context: RetrievalContext, candidates: readonly Candidate[], authority: AccessAuthority): Promise<readonly Citation[]> {
  requireCondition(candidateIds.length > 0 && candidateIds.length <= 100 && new Set(candidateIds).size === candidateIds.length, 'CITATIONS_REQUIRED', 'Answer citations must be nonempty and unique');
  const selected = candidateIds.map(id => { const found = candidates.find(candidate => candidate.id === id); requireCondition(found, 'UNKNOWN_CITATION', 'Answer cites evidence absent from retrieval results'); return found; });
  const authorization = await authorizeCurrent(context, selected, authority);
  requireCondition(authorization.deniedCount === 0, 'EVIDENCE_REVOKED', 'Answer evidence was deleted, replaced, or access was revoked');
  return immutable(authorization.candidates.map((candidate, offset) => ({ id: `source-${offset + 1}`, candidateId: candidate.id, index: candidate.index, chunk: candidate.chunk, quote: candidate.text, authorizationEpoch: authorization.authorizationEpoch })));
}

export interface DerivedEvidence { id: string; kind: 'entity' | 'relation' | 'community' | 'summary'; text: string; supportingChunkIds: string[] }

/** A derived graph summary is denied as a whole if any supporting source is no longer readable. */
export async function filterDerivedEvidence(context: RetrievalContext, evidence: readonly DerivedEvidence[], snapshot: AuthorizationSnapshot, expectedEpoch: number): Promise<readonly DerivedEvidence[]> {
  context = immutable(context); evidence = immutable(evidence); snapshot = immutable(snapshot);
  await verifyCorpusGeneration(context.corpus); await verifyIndexGeneration(context.index);
  const records = validateAuthorization(context.principal, snapshot);
  requireCondition(snapshot.epoch === expectedEpoch, 'STALE_AUTHORIZATION', 'Derived evidence requires current authorization');
  assertScope(context.corpus.ref.scope, context.principal.scope); assertScope(context.index.ref.scope, context.principal.scope);
  requireCondition(equal(context.index.corpus, context.corpus.ref), 'CORPUS_GENERATION_MISMATCH', 'Derived evidence belongs to another corpus generation');
  assertJsonData(evidence); requireCondition(evidence.length <= 1000, 'EVIDENCE_LIMIT', 'Too many derived items');
  const seen = new Set<string>();
  return immutable(evidence.filter(item => {
    object(item, ['id', 'kind', 'text', 'supportingChunkIds']); identifier(item.id);
    requireCondition(!seen.has(item.id) && ['entity', 'relation', 'community', 'summary'].includes(item.kind) && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 65536 && Array.isArray(item.supportingChunkIds) && item.supportingChunkIds.length > 0 && item.supportingChunkIds.length <= 1000, 'UNGROUNDED_EVIDENCE', 'Derived evidence requires bounded unique identity and source chunks'); seen.add(item.id);
    return item.supportingChunkIds.map(id => { const chunk = context.corpus.chunks.find(candidate => candidate.ref.chunkId === id); requireCondition(chunk, 'UNKNOWN_CHUNK', 'Derived evidence references a missing source'); return chunk.ref; }).every(ref => readable(ref, context.principal, snapshot.groupIds, records));
  }));
}
