import type { AuthorizationSnapshot, Citation, Principal } from '../access.js';
import type { CorpusGeneration, CorpusRef, IndexArtifactBytes, IndexGeneration, IndexRef } from '../corpus.js';

/** Versioned data-only graph contracts. Model proposals cannot supply executable handlers, SQL, or ACL grants. */
export const GRAPH_FORMAT = 'studio-explicit-graph-v1' as const;
export const GRAPH_ARTIFACT_ID = 'local-graph' as const;
export const GRAPH_LIMITS = Object.freeze({ chunks: 32, chunkBytes: 20000, corpusBytes: 256 * 1024, artifactBytes: 8 * 1024 * 1024, entities: 256, relations: 1024, aliases: 8, evidencePerRelation: 8, types: 32, inputWork: 20000, visitedEntities: 256, examinedRelations: 4096, paths: 128, searchWork: 20000 });

/** Absolute end-exclusive UTF-8 offsets address the sealed chunk's extracted document, not JS string indices. */
export interface GraphSpan { chunkId: string; start: number; end: number; sha256: string; quote: string }
export interface GraphFact { value: string; span: GraphSpan }
export interface GraphIdentity { namespace: string; sourceIdentifier: string; version: string | null }
export interface GraphIdentityEvidence { namespace: GraphFact; sourceIdentifier: GraphFact; version: GraphFact | null; assertion: GraphSpan }
/** The assertion must contain both the alias and the complete qualified source identity. Semantic entailment remains a model/reviewer concern. */
export interface GraphAlias { name: GraphFact; identity: GraphIdentityEvidence; assertion: GraphSpan }
export interface GraphEntityInput { key: string; type: string; identity: GraphIdentityEvidence; label: GraphFact; aliases: GraphAlias[]; inputChunkIds: string[] }
export interface GraphRelationEvidence { assertion: GraphSpan; from: GraphIdentityEvidence; to: GraphIdentityEvidence }
export interface GraphRelationInput { from: string; to: string; type: string; evidence: GraphRelationEvidence[]; inputChunkIds: string[] }
/** These are trusted caller receipts for the extraction contract and its ENTIRE input, not claims of live model verification. */
export interface GraphExtractionContract { id: string; version: string; sha256: string; entityTypes: string[]; relationTypes: string[] }
export interface GraphDraft { inputChunkIds: string[]; extractionContract: GraphExtractionContract; entities: GraphEntityInput[]; relations: GraphRelationInput[] }
export interface GraphEntity { id: string; type: string; identity: GraphIdentity; labels: string[]; aliases: string[]; evidence: GraphSpan[]; inputChunkIds: string[] }
export interface GraphRelation { id: string; type: string; from: string; to: string; evidence: GraphSpan[]; inputChunkIds: string[] }
/** Original typed extraction records let the loader recompute every compiled identity/edge rather than trust a re-signed graph. */
export interface GraphArtifact { format: typeof GRAPH_FORMAT; corpus: CorpusRef; draft: GraphDraft; entities: GraphEntity[]; relations: GraphRelation[] }
export interface GraphBundle { corpus: CorpusGeneration; index: IndexGeneration; artifacts: IndexArtifactBytes[] }
export type GraphSeed = { entityId: string } | { alias: string; namespace?: string; version?: string | null };
export interface GraphSearchLimits { maxVisitedEntities: number; maxExaminedRelations: number; maxPaths: number; maxWork: number }
export interface GraphLocalRequest { principal: Principal; authorizationSnapshot: AuthorizationSnapshot; expectedEpoch: number; seeds: GraphSeed[]; direction: 'outgoing' | 'incoming' | 'both'; relationTypes?: string[]; maxHops: number; limits?: Partial<GraphSearchLimits> }
export interface GraphPath { seedId: string; targetId: string; entityIds: string[]; steps: { relationId: string; traversal: 'forward' | 'reverse' }[] }
export interface GraphLocalResult { mode: 'graph_local'; index: IndexRef; seedIds: string[]; entities: GraphEntity[]; relations: GraphRelation[]; paths: GraphPath[]; citations: Citation[]; evidenceCitations: { evidence: GraphSpan; citationId: string }[]; authorizationEpoch: number; inputChunkIds: string[]; usage: { visitedEntities: number; examinedRelations: number; paths: number; work: number } }
