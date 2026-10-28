import { describe, expect, it } from 'vitest';
import { eligibleProfiles, packageConnectionProblems, profileKindName, ReadinessIdentity } from '../../apps/runner-ui/src/model-connections';
import type { ModelRequirement, PackageDetail, Profile } from '../../apps/runner-ui/src/types';

const embedding: ModelRequirement = { alias: 'documents', kind: 'embedding', requiredFeatures: ['embedding'], constraint: { contractId: 'openai-small-256-cl100k-v1', provider: 'openai', model: 'text-embedding-3-small', dimensions: 256, maxChunks: 128 } };
const profiles: Profile[] = [
  { id: 'old', name: '기존', provider: 'openai', model: 'chat' },
  { id: 'chat', name: '대화', provider: 'openai', model: 'chat', kind: 'chat' },
  { id: 'embedding', name: '문서', provider: 'openai', model: 'text-embedding-3-small', kind: 'embedding' },
  { id: 'other', name: '다른 임베딩', provider: 'openai', model: 'other', kind: 'embedding' },
  { id: 'reranker', name: '재순위', provider: 'openai', model: 'judge', kind: 'reranker' },
];
const detail = (): PackageDetail => ({ packageHandle: 'pkg_test', name: '시험', trust: 'unsigned', warnings: [], inputs: {}, modelProfiles: ['documents'], modelRequirements: [structuredClone(embedding)], materials: [] });

/** These client guards supplement the service; no model response or successful run is fabricated. */
describe('Runner model selection', () => {
  it('matches kind/provider/model and accepts only missing legacy kind as chat', () => {
    expect(eligibleProfiles(embedding, profiles).map(item => item.id)).toEqual(['embedding']);
    expect(eligibleProfiles({ alias: 'task', kind: 'chat', requiredFeatures: [] }, profiles).map(item => item.id)).toEqual(['old', 'chat']);
    expect(profileKindName(profiles[4]!)).toBe('검색 결과 재정렬');
  });
  it('has no selection for undeclared or unsupported requirements', () => {
    for (const kind of [null, 'reranker'] as const) { const requirement = { ...embedding, kind }; expect(eligibleProfiles(requirement, profiles)).toEqual([]); expect(packageConnectionProblems({ ...detail(), modelRequirements: [requirement] })).toHaveLength(1); }
  });
  it('fails closed on missing metadata, alias mismatch, duplicate aliases and changed embedding contract', () => {
    const missing = detail(); delete (missing as Partial<PackageDetail>).modelRequirements; expect(packageConnectionProblems(missing)).toHaveLength(1);
    expect(packageConnectionProblems({ ...detail(), modelProfiles: ['unused'] })).toHaveLength(1);
    expect(packageConnectionProblems({ ...detail(), modelProfiles: ['documents', 'documents'], modelRequirements: [embedding, embedding] })).toHaveLength(1);
    const changed = detail(); Object.assign(changed.modelRequirements[0]!.constraint!, { dimensions: 512 }); expect(packageConnectionProblems(changed)).toHaveLength(1);
    expect(packageConnectionProblems(detail())).toEqual([]);
  });
  it('does not demand unused model declarations and supports zero required aliases', () => { expect(packageConnectionProblems({ ...detail(), modelProfiles: [], modelRequirements: [] })).toEqual([]); });
  it('Agentic constraints match only explicit fixed chat profiles and fail closed on unknown contracts', () => {
    const requirement: ModelRequirement = { alias: 'planner', kind: 'chat', requiredFeatures: ['json_schema'], constraint: { contractId: 'openai-agentic-keyword-abstain-v1', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', maxIndexes: 4, maxInputBytes: 131072, maxOutputTokens: 4096 } };
    const available: Profile[] = [...profiles, { id: 'fixed', name: '고정', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', kind: 'chat' }, { id: 'ranking', name: '다른 역할', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', kind: 'reranker' }];
    expect(eligibleProfiles(requirement, available).map(item => item.id)).toEqual(['fixed']); const changed = structuredClone(requirement); changed.constraint!.contractId = 'future-contract'; expect(eligibleProfiles(changed, available)).toEqual([]);
    expect(eligibleProfiles({ alias: 'ordinary', kind: 'chat', requiredFeatures: [] }, available).map(item => item.id)).toEqual(['old', 'chat', 'fixed']);
  });
  it('rejects an earlier ready response after a binding edit or another request, including edit-away-and-back', async () => {
    const identity = new ReadinessIdentity(); const old = identity.invalidate(); let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; }).then(() => identity.matches(old));
    identity.invalidate(); identity.invalidate(); finish(); expect(await response).toBe(false);
    const current = identity.invalidate(); expect(identity.matches(current)).toBe(true); identity.invalidate(); expect(identity.matches(current)).toBe(false);
  });
});
