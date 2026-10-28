import { canonicalDigest } from '@studio/package-kit';
import type { EmbeddingProfile } from '@studio/rag-core';
import { RunnerError, objectValue } from '../errors.js';
import type { RunStore } from '../state/store.js';
import type { EmbeddingBroker } from '../providers/embedding-broker.js';
import { embeddingProfile, EMBEDDING_CONTRACT, EMBEDDING_CONTRACT_HASH } from '../providers/embedding-contract.js';

export interface RunEmbeddings {
  profile(runId: string, alias: string): EmbeddingProfile;
  embed(runId: string, nodeId: string, profile: EmbeddingProfile, input: readonly string[], signal: AbortSignal): Promise<number[][]>;
}

/** Saved plan pins contain no credentials; the current DPAPI reference is resolved only at the broker boundary. */
export class RunEmbeddingSession implements RunEmbeddings {
  constructor(private readonly store: RunStore, private readonly broker: EmbeddingBroker) {}
  assertPlan(planValue: unknown): void {
    const plan = objectValue(planValue); const profiles = objectValue(plan.modelProfiles);
    for (const [alias, value] of Object.entries(profiles)) {
      const pinned = objectValue(value); if (pinned.kind !== 'embedding') continue;
      const contract = objectValue(objectValue(plan.resolved).verifiedDependencies).embeddingContract;
      if (canonicalDigest(contract ?? null) !== EMBEDDING_CONTRACT_HASH) throw new RunnerError('EMBEDDING_PLAN_CHANGED', '고정한 임베딩 계약이 현재 Runner와 다릅니다.');
      const current = this.store.getProfile(String(pinned.id));
      const expected = { id: current.id, provider: current.provider, model: current.model, kind: 'embedding', embedding: embeddingProfile(current, alias) };
      if (canonicalDigest(pinned) !== canonicalDigest(expected)) throw new RunnerError('EMBEDDING_PLAN_CHANGED', '고정한 임베딩 모델 연결이 변경되었습니다.');
    }
  }
  profile(runId: string, alias: string): EmbeddingProfile {
    const saved = this.store.getExecution(runId); const plan = objectValue(saved.plan);
    if (canonicalDigest(plan) !== saved.planHash) throw new RunnerError('PLAN_CHANGED', '고정한 실행 계획이 변경되었습니다.');
    this.assertPlan(plan); const pinned = objectValue(objectValue(plan.modelProfiles)[alias]);
    if (pinned.kind !== 'embedding') throw new RunnerError('EMBEDDING_PROFILE_UNSUPPORTED', '색인에 고정된 임베딩 연결이 필요합니다.');
    return embeddingProfile(this.store.getProfile(String(pinned.id)), alias);
  }
  async embed(runId: string, nodeId: string, profile: EmbeddingProfile, input: readonly string[], signal: AbortSignal): Promise<number[][]> {
    const current = this.profile(runId, String(profile.parameters.bindingAlias));
    if (canonicalDigest(current) !== canonicalDigest(profile) || current.dimensions !== EMBEDDING_CONTRACT.dimensions) throw new RunnerError('EMBEDDING_PROFILE_MISMATCH', '검색 임베딩 계약이 색인을 만든 계약과 다릅니다.');
    return this.broker.invoke(runId, nodeId, this.store.getProfile(String(current.parameters.profileId)), input, signal);
  }
}
