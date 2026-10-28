import { canonicalDigest } from '@studio/package-kit';
import type { CredentialStore } from '../security/credential-store.js';
import { RunStore, type ModelProfile } from '../state/store.js';
import { ModelError } from './model-provider.js';
import { checkedEmbeddingVectors, type EmbeddingProvider, type EmbeddingRequest } from './embedding-provider.js';
import { EMBEDDING_CONTRACT, EMBEDDING_CONTRACT_HASH, measureEmbeddingInputs } from './embedding-contract.js';
import { assertBrokerDisclosure } from '../provenance/run-disclosure.js';

/** Embeddings reserve the same atomic run budget as Responses, but record conservative local measurement separately. */
export class EmbeddingBroker {
  constructor(private readonly store: RunStore, private readonly credentials: CredentialStore, private readonly provider: EmbeddingProvider, private readonly authorizeDisclosure?: (runId: string) => void) {}
  async invoke(runId: string, nodeId: string, profile: ModelProfile, input: readonly string[], signal: AbortSignal): Promise<number[][]> {
    if (profile.kind !== 'embedding' || profile.provider !== 'openai' || profile.model !== EMBEDDING_CONTRACT.model) throw new ModelError('EMBEDDING_PROFILE_UNSUPPORTED', '지원하는 임베딩 연결이 필요합니다.', 'not_started');
    const request: EmbeddingRequest = Object.freeze({ model: profile.model, dimensions: 256, input: Object.freeze([...input]) });
    const measurement = measureEmbeddingInputs(request.input); const requestHash = canonicalDigest(request);
    if (signal.aborted) throw new ModelError('EMBEDDING_NOT_STARTED', '임베딩 요청 전에 취소되었습니다.', 'not_started');
    const apiKey = await this.credentials.get(profile.credentialRef);
    if (signal.aborted) throw new ModelError('EMBEDDING_NOT_STARTED', '임베딩 요청 전에 취소되었습니다.', 'not_started');
    assertBrokerDisclosure(this.store, runId, this.authorizeDisclosure);
    const reservation = this.store.reserveModel(runId, nodeId, measurement.reservedTokens, undefined, { ...measurement, requestHash, contractHash: EMBEDDING_CONTRACT_HASH });
    // A security failure before dispatch proves zero generation usage; never convert it to an unknown provider result.
    try { assertBrokerDisclosure(this.store, runId, this.authorizeDisclosure); }
    catch (error) { this.store.settleReservation(reservation, 0); throw error; }
    try {
      if (signal.aborted) throw new ModelError('EMBEDDING_NOT_STARTED', '임베딩 요청 전에 취소되었습니다.', 'not_started');
      const result = await this.provider.embed(request, { apiKey, signal });
      const usage = result.usage;
      if (!usage || ![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) || usage.outputTokens !== 0 || usage.inputTokens !== usage.totalTokens) throw new ModelError('EMBEDDING_USAGE_UNKNOWN', '임베딩 사용량을 확정하지 못해 예약을 유지합니다.', 'unknown');
      const vectors = checkedEmbeddingVectors(result.vectors, request.input.length);
      const accounting = this.store.settleReservation(reservation, usage.totalTokens);
      if (accounting?.overrun) throw new ModelError('BUDGET_EXCEEDED', '임베딩 실측 사용량이 예약을 초과해 후속 작업을 중단했습니다.', 'completed', false, usage);
      if (result.model !== request.model || canonicalDigest(request) !== requestHash) throw new ModelError('EMBEDDING_PROFILE_MISMATCH', '임베딩 모델·요청 계약이 변경되었습니다.', 'completed', false, usage);
      if (signal.aborted) throw new ModelError('EMBEDDING_INTERRUPTED', '임베딩 응답 뒤 실행이 중단되었습니다.', 'completed', false, usage);
      return vectors;
    } catch (error) {
      if (error instanceof ModelError && error.outcome === 'not_started') this.store.settleReservation(reservation, 0);
      else if (!(error instanceof ModelError && error.outcome === 'completed')) this.store.settleReservation(reservation, null);
      // Never mark a transient failure retryable: the enclosing RAG operation may already have paid earlier batches.
      throw error instanceof ModelError ? new ModelError(error.code, error.message, error.outcome, false, error.usage) : new ModelError('EMBEDDING_RESULT_UNKNOWN', '임베딩 처리 결과를 확인하지 못했습니다.', 'unknown');
    }
  }
}
