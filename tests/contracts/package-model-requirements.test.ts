import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { packageModelRequirements } from '../../apps/runner/src/profiles/package-requirements.js';

/** Requirements are declarative and conservative across child flows, not a forecast of model calls or account access. */
describe('package model requirement views', () => {
  it('pins only a referenced Agentic chat alias, including child flows, without upgrading ordinary chat', () => {
    const workflow = createBasicWorkflow(); const agent = createNode('agent'); if (agent.type !== 'agent') throw new Error('factory');
    agent.config.strategy = 'agentic_rag'; agent.config.modelProfile = 'planner'; workflow.modelProfiles.planner = { kind: 'chat', requiredFeatures: ['json_schema'] }; workflow.modelProfiles.unusedPlanner = { kind: 'chat', requiredFeatures: ['json_schema'] };
    workflow.subworkflows.child = { entryNodeId: agent.id, inputs: true, outputs: true, nodes: [agent, createNode('output')], edges: [] };
    const requirements = packageModelRequirements(workflow); expect(requirements.find(item => item.alias === 'planner')).toMatchObject({ kind: 'chat', constraint: { contractId: 'openai-agentic-keyword-abstain-v1', model: 'gpt-5.4-mini-2026-03-17', maxIndexes: 4, maxInputBytes: 131072 } });
    expect(requirements.find(item => item.alias === 'text-default')?.constraint).toBeUndefined(); expect(requirements.some(item => item.alias === 'unusedPlanner')).toBe(false);
  });
  it('omits unused declarations and preserves supported kind requirements', () => {
    const workflow = createBasicWorkflow(); workflow.modelProfiles.unused = { kind: 'embedding', requiredFeatures: ['embedding'] };
    expect(packageModelRequirements(workflow)).toEqual([{ alias: 'text-default', kind: 'chat', requiredFeatures: ['text'] }]);
    expect(packageModelRequirements(undefined)).toEqual([]);
  });
  it('includes a referenced embedding declaration in an included child and its fixed constraints', () => {
    const workflow = createBasicWorkflow(); const knowledge = createNode('knowledge'); if (knowledge.type !== 'knowledge') throw new Error('factory');
    knowledge.config = { operation: 'build', profile: 'local-run-embedding-v1', indexSettings: { kind: 'hybrid', chunkSize: 2000, chunkOverlap: 200, embeddingProfile: 'embed' } };
    workflow.modelProfiles.embed = { kind: 'embedding', requiredFeatures: ['embedding'] };
    workflow.subworkflows.child = { entryNodeId: knowledge.id, inputs: true, outputs: true, nodes: [knowledge, createNode('output')], edges: [] };
    const requirement = packageModelRequirements(workflow).find(item => item.alias === 'embed');
    expect(requirement).toMatchObject({ kind: 'embedding', requiredFeatures: ['embedding'], constraint: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 256, maxChunks: 128 } });
    requirement!.requiredFeatures.push('mutated'); expect(workflow.modelProfiles.embed.requiredFeatures).toEqual(['embedding']);
  });
  it('retains a missing declaration as an error-bearing requirement without guessing its kind', () => {
    const workflow = createBasicWorkflow(); workflow.modelProfiles = {};
    expect(packageModelRequirements(workflow)).toEqual([{ alias: 'text-default', kind: null, requiredFeatures: [] }]);
  });
  it('describes a referenced reranker separately from chat without copying internal prompts or pins', () => {
    const workflow = createBasicWorkflow(); const retrieval = createNode('retrieval'); if (retrieval.type !== 'retrieval') throw new Error('factory');
    retrieval.config = { mode: 'keyword', topK: 3, candidateLimit: 10, maxContextTokens: 2000, reranker: { modelProfile: 'rank', timeoutMs: 30000, onFailure: 'fail' } };
    workflow.nodes.splice(1, 0, retrieval); workflow.modelProfiles.rank = { kind: 'reranker', requiredFeatures: ['rerank'] };
    workflow.modelProfiles.unusedRank = { kind: 'reranker', requiredFeatures: ['rerank'] };
    const requirement = packageModelRequirements(workflow).find(item => item.alias === 'rank');
    expect(requirement).toEqual({ alias: 'rank', kind: 'reranker', requiredFeatures: ['rerank'], constraint: { contractId: 'openai-responses-rerank-v1', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', maxCandidates: 20, maxInputBytes: 65536, maxOutputTokens: 4096 } });
    expect(packageModelRequirements(workflow).some(item => item.alias === 'unusedRank')).toBe(false);
    requirement!.constraint!.contractId = 'caller-change'; expect(packageModelRequirements(workflow).find(item => item.alias === 'rank')?.constraint?.contractId).toBe('openai-responses-rerank-v1');
  });
});
