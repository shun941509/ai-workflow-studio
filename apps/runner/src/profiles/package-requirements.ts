import type { Workflow } from '@studio/spec';
import { collectRequirements } from '@studio/workflow-core';
import { EMBEDDING_CONTRACT } from '../providers/embedding-contract.js';
import { RERANK_CONTRACT } from '../providers/rerank-contract.js';
import { AGENTIC_CONTRACT } from '../agentic/contracts.js';

/** Public constraints describe supported roles, never the credential or the private resolved-plan pin. */
export type ModelRequirementConstraint =
  | { contractId: string; provider: 'openai'; model: 'text-embedding-3-small'; dimensions: 256; maxChunks: 128 }
  | { contractId: string; provider: 'openai'; model: 'gpt-5.4-mini-2026-03-17'; maxCandidates: 20; maxInputBytes: 65536; maxOutputTokens: 4096 }
  | { contractId: string; provider: 'openai'; model: 'gpt-5.4-mini-2026-03-17'; maxIndexes: 4; maxInputBytes: 131072; maxOutputTokens: 4096 };

export interface ModelRequirement {
  alias: string;
  kind: 'chat' | 'embedding' | 'reranker' | null;
  requiredFeatures: string[];
  constraint?: ModelRequirementConstraint;
}

/** List referenced declarations in all included flows, without forecasting which conditional branch will execute.
 * Metadata contains no local profile ID, credentials or caller-owned mutable arrays. */
export function packageModelRequirements(workflow: Workflow | undefined): ModelRequirement[] {
  if (!workflow) return [];
  return collectRequirements(workflow).modelProfiles.map(alias => {
    const declaration = Object.hasOwn(workflow.modelProfiles, alias) ? workflow.modelProfiles[alias] : undefined;
    const agentic = [workflow, ...Object.values(workflow.subworkflows)].some(flow => flow?.nodes.some(node => node.type === 'agent' && node.config.strategy === 'agentic_rag' && node.config.modelProfile === alias));
    return {
      alias, kind: declaration?.kind ?? null, requiredFeatures: [...declaration?.requiredFeatures ?? []],
      ...(declaration?.kind === 'embedding' ? { constraint: {
        contractId: EMBEDDING_CONTRACT.id, provider: EMBEDDING_CONTRACT.provider, model: EMBEDDING_CONTRACT.model, dimensions: EMBEDDING_CONTRACT.dimensions, maxChunks: EMBEDDING_CONTRACT.maxChunks,
      } } : declaration?.kind === 'reranker' ? { constraint: {
        contractId: RERANK_CONTRACT.id, provider: RERANK_CONTRACT.provider, model: RERANK_CONTRACT.model,
        maxCandidates: RERANK_CONTRACT.maxCandidates, maxInputBytes: RERANK_CONTRACT.maxInputBytes, maxOutputTokens: RERANK_CONTRACT.maxOutputTokens,
      } } : agentic ? { constraint: { contractId: AGENTIC_CONTRACT.id, provider: AGENTIC_CONTRACT.provider, model: AGENTIC_CONTRACT.model, maxIndexes: AGENTIC_CONTRACT.maxIndexes, maxInputBytes: AGENTIC_CONTRACT.maxInputBytes, maxOutputTokens: AGENTIC_CONTRACT.maxOutputTokens } } : {}),
    };
  });
}
