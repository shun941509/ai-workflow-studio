import { describe, expect, it } from 'vitest';
import { eligibleProfiles, requirementProblem, RERANK_MODEL } from '../../apps/runner-ui/src/model-connections';
import { rerankStatuses } from '../../apps/runner-ui/src/rerank-status';
import type { EventRecord, ModelRequirement, Profile } from '../../apps/runner-ui/src/types';

const requirement: ModelRequirement = { alias: 'rank', kind: 'reranker', requiredFeatures: ['rerank'], constraint: { contractId: 'openai-responses-rerank-v1', provider: 'openai', model: RERANK_MODEL, maxCandidates: 20, maxInputBytes: 65536, maxOutputTokens: 4096 } };
const event = (status: unknown, failureCode?: string): EventRecord => ({ sequence: 1, createdAt: '2026-10-28T00:00:00Z', type: 'rag.rerank', payload: { nodeId: 'search', status, failureCode } });

/** Metadata and stage evidence are deliberately separate: a ready connection is never proof of model quality. */
describe('reranker UI contract', () => {
  it('selects only exact reranker kind and pinned model, never same-model chat or legacy profiles', () => {
    const profiles: Profile[] = [undefined, 'chat', 'embedding', 'reranker'].map((kind, index) => ({ id: String(index), name: '연결', provider: 'openai', model: RERANK_MODEL, kind: kind as Profile['kind'] }));
    expect(eligibleProfiles(requirement, profiles).map(item => item.id)).toEqual(['3']); expect(requirementProblem(requirement)).toBeUndefined();
    for (const patch of [{ model: 'gpt-5.4-mini' }, { maxCandidates: 21 }, { maxInputBytes: 65537 }, { maxOutputTokens: 4095 }, { contractId: 'unknown' }]) expect(requirementProblem({ ...requirement, constraint: { ...requirement.constraint!, ...patch } as ModelRequirement['constraint'] })).toBeDefined();
    expect(requirementProblem({ ...requirement, constraint: undefined })).toBeDefined();
  });
  it('reports fallback, empty, failed and unknown distinctly without reading or displaying raw provider bodies', () => {
    const values = rerankStatuses([event('reranked'), event('fallback', 'MODEL_REFUSAL'), event('skipped_empty'), event('failed', 'RERANK_RESULT_INVALID'), event('future_state', '<script>secret-body</script>')]);
    expect(values.map(value => value.state)).toEqual(['reranked', 'fallback', 'skipped_empty', 'failed', 'unknown']); expect(values[1]!.title).toBe('원래 검색 순위를 사용했습니다'); expect(values[1]!.description).toContain('점수는 없습니다'); expect(values[1]!.failureCode).toBe('MODEL_REFUSAL'); expect(values[4]!.failureCode).toBeUndefined(); expect(JSON.stringify(values)).not.toContain('secret-body');
    expect(rerankStatuses([{ ...event('succeeded'), type: 'run.succeeded' }])).toEqual([]);
  });
});
