import { canonicalDigest } from '@studio/package-kit';
import { applyRerank, type Candidate, type RerankResponse } from '@studio/rag-core';
import type { ModelBroker } from '../providers/model-broker.js';
import { ModelError, type ModelResponse } from '../providers/model-provider.js';
import { decodeRerank, prepareRerank, rerankProfile, RERANK_CONTRACT_HASH } from '../providers/rerank-contract.js';
import type { RunStore } from '../state/store.js';
import { RunnerError, objectValue } from '../errors.js';
import { interruption } from '../execution/concurrency.js';

export interface RerankDetail { status: 'reranked' | 'fallback' | 'skipped_empty'; fingerprint: string; inventoryHash: string; candidateCount: number; failureCode?: string }
export interface RunReranker {
  rerank(runId: string, nodeId: string, alias: string, query: string, candidates: readonly Candidate[], options: { topK: number; timeoutMs: number; onFailure: 'fail' | 'use_original' }, signal: AbortSignal, authorize: () => void): Promise<{ candidates: readonly Candidate[]; detail: RerankDetail }>;
}

/** Only this explicit role can invoke the Responses broker with a reranker profile. No chat-to-reranker promotion. */
export class RunRerankSession implements RunReranker {
  constructor(private readonly store: RunStore, private readonly broker: ModelBroker) {}

  assertPlan(planValue: unknown): void {
    const plan = objectValue(planValue);
    for (const [alias, value] of Object.entries(objectValue(plan.modelProfiles))) {
      const pinned = objectValue(value); if (pinned.kind !== 'reranker') continue;
      const contract = objectValue(objectValue(plan.resolved).verifiedDependencies).rerankerContract;
      if (canonicalDigest(contract ?? null) !== RERANK_CONTRACT_HASH || canonicalDigest(pinned) !== canonicalDigest(rerankProfile(this.store.getProfile(String(pinned.id)), alias))) throw new RunnerError('RERANK_PLAN_CHANGED', '실행에 고정한 재순위 모델·계약이 변경되었습니다.');
    }
  }

  private profile(runId: string, alias: string) {
    const saved = this.store.getExecution(runId); const plan = objectValue(saved.plan);
    if (canonicalDigest(plan) !== saved.planHash) throw new RunnerError('PLAN_CHANGED', '고정한 실행 계획이 변경되었습니다.');
    this.assertPlan(plan); const pinned = objectValue(objectValue(plan.modelProfiles)[alias]);
    if (pinned.kind !== 'reranker') throw new RunnerError('RERANK_PROFILE_UNSUPPORTED', '실행에 고정한 재순위용 모델 연결이 필요합니다.');
    return this.store.getProfile(String(pinned.id));
  }

  async rerank(runId: string, nodeId: string, alias: string, query: string, candidates: readonly Candidate[], options: { topK: number; timeoutMs: number; onFailure: 'fail' | 'use_original' }, parent: AbortSignal, authorize: () => void) {
    const profile = this.profile(runId, alias); const fingerprint = canonicalDigest(rerankProfile(profile, alias));
    const inventoryHash = canonicalDigest([...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(candidate => ({ id: candidate.id, sha256: candidate.chunk.sha256 })));
    if (!candidates.length) {
      authorize(); const detail: RerankDetail = { status: 'skipped_empty', fingerprint, inventoryHash, candidateCount: 0 };
      this.store.recordRerank(runId, nodeId, { ...detail, ranks: [] }); return { candidates, detail };
    }
    const prepared = prepareRerank(query, candidates);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(options.timeoutMs)]);
    const beforeDispatch = () => { if (signal.aborted) throw interruption(signal); this.profile(runId, alias); authorize(); };
    let response: RerankResponse;
    try {
      let output: ModelResponse | undefined;
      try {
        output = await this.broker.invoke(runId, nodeId, profile, prepared.request, signal, { purpose: 'reranker', beforeDispatch });
      } catch (error) {
        if (signal.aborted) throw error; // A dispatched timeout may still be billable; never turn it into a successful fallback.
        const safeFailure = error instanceof ModelError && (error.outcome === 'not_started' && ['RATE_LIMITED', 'MODEL_COUNT_UNAVAILABLE'].includes(error.code) || error.outcome === 'completed' && error.code === 'MODEL_REFUSAL' && error.usage !== null);
        if (!safeFailure || options.onFailure !== 'use_original') throw error;
        response = { status: 'failed', code: error.code };
      }
      if (signal.aborted) throw interruption(signal);
      if (output) response = decodeRerank(output, prepared, fingerprint);
      // Recheck the entire disclosed inventory, not just the selected top K, after the asynchronous model boundary.
      beforeDispatch();
      const ranked = applyRerank(candidates, response!, { expectedFingerprint: fingerprint, topK: options.topK, onFailure: options.onFailure });
      const detail: RerankDetail = { status: ranked.status, fingerprint, inventoryHash, candidateCount: candidates.length, ...(ranked.failureCode ? { failureCode: ranked.failureCode } : {}) };
      this.store.recordRerank(runId, nodeId, { ...detail, ranks: candidates.map(candidate => ({ id: candidate.id, before: candidate.rank, after: ranked.candidates.find(item => item.id === candidate.id)?.rank ?? null, ...(response!.status === 'ok' ? { score: response!.items.find(item => item.id === candidate.id)!.score } : {}) })) });
      return { candidates: ranked.candidates, detail };
    } catch (error) {
      try { this.store.recordRerank(runId, nodeId, { status: 'failed', fingerprint, inventoryHash, failureCode: error instanceof ModelError || error instanceof RunnerError ? error.code : 'RERANK_FAILED', ranks: candidates.map(candidate => ({ id: candidate.id, before: candidate.rank, after: null })) }); }
      catch { throw new RunnerError('RAG_RECONCILIATION_REQUIRED', '재순위 중단 기록을 확정하지 못했습니다. 자동 재실행하지 않습니다.'); }
      // A retrieval attempt can already include a paid embedding. No enclosing node retry may repeat that work.
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, error.outcome, false, error.usage);
      throw error;
    }
  }
}
