import type { CredentialStore } from '../security/credential-store.js';
import type { ModelProfile } from '../state/store.js';
import { RunStore } from '../state/store.js';
import { ModelError, type ModelProvider, type ModelRequest, type ModelResponse } from './model-provider.js';
import { canonicalDigest } from '@studio/package-kit';
import { ownModelRequest } from './request.js';

/** Malformed or missing usage cannot justify releasing any reserved tokens. */
function validUsage(value: unknown): value is NonNullable<ModelResponse['usage']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as ModelResponse['usage'];
  return [usage!.inputTokens, usage!.outputTokens, usage!.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) && usage!.inputTokens + usage!.outputTokens === usage!.totalTokens;
}

/** A timed-out count is a protected time-budget stop; it still proves that generation was never started. */
function cancelledBeforeGeneration(signal: AbortSignal): ModelError {
  const reason: unknown = signal.reason;
  const timedOut = reason instanceof Error && (reason.name === 'TimeoutError' || 'code' in reason && reason.code === 'BUDGET_EXCEEDED');
  return new ModelError(timedOut ? 'BUDGET_EXCEEDED' : 'MODEL_NOT_STARTED', timedOut ? '모델 입력 확인의 실행 시간 한도를 초과했습니다.' : '생성 요청 전에 실행이 취소되었습니다.', 'not_started');
}

/** All provider calls share atomic usage reservations and the OS credential boundary. */
export class ModelBroker {
  constructor(private readonly store: RunStore, private readonly credentials: CredentialStore, private readonly provider: ModelProvider) {}

  async invoke(runId: string, nodeId: string, profile: ModelProfile, request: Omit<ModelRequest, 'model'>, signal: AbortSignal): Promise<ModelResponse> {
    const { request: fullRequest, requestHash } = ownModelRequest({ ...request, model: profile.model });
    if (signal.aborted) throw cancelledBeforeGeneration(signal);
    const apiKey = await this.credentials.get(profile.credentialRef);
    if (signal.aborted) throw cancelledBeforeGeneration(signal);
    const countId = this.store.beginModelCount(runId, nodeId, requestHash, fullRequest.maxOutputTokens);
    let inputTokens: number;
    try {
      inputTokens = await this.provider.countInputTokens(fullRequest, { apiKey, signal });
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(inputTokens + fullRequest.maxOutputTokens)) throw new ModelError('MODEL_COUNT_INVALID', '입력 토큰 확인 결과가 유효한 정수가 아닙니다.', 'not_started');
    } catch (error) {
      const detail = signal.aborted ? cancelledBeforeGeneration(signal) : error instanceof ModelError ? error : new ModelError('MODEL_COUNT_UNAVAILABLE', '입력 토큰 수를 확인하지 못해 생성 요청을 보내지 않았습니다.', 'not_started');
      this.store.finishModelCount(runId, countId, { code: detail.code });
      throw new ModelError(detail.code, detail.message, 'not_started');
    }
    this.store.finishModelCount(runId, countId, { inputTokens });
    if (signal.aborted) throw cancelledBeforeGeneration(signal);
    if (canonicalDigest(fullRequest) !== requestHash) throw new ModelError('MODEL_REQUEST_CHANGED', '입력 토큰 확인 후 모델 요청이 변경되었습니다.', 'not_started');
    const reservation = this.store.reserveModel(runId, nodeId, inputTokens + fullRequest.maxOutputTokens, { countId, requestHash, inputTokens, maxOutputTokens: fullRequest.maxOutputTokens });
    const settle = (usage: NonNullable<ModelResponse['usage']>) => {
      const accounting = this.store.settleReservation(reservation, usage.totalTokens, { requestHash, expectedInputTokens: inputTokens, actualInputTokens: usage.inputTokens, maxOutputTokens: fullRequest.maxOutputTokens, actualOutputTokens: usage.outputTokens });
      if (accounting?.overrun || accounting?.inputUndercount || accounting?.outputOverrun) throw new ModelError('BUDGET_EXCEEDED', '실제 모델 사용량이 확인한 입력·예약 한도를 초과해 후속 작업을 중단했습니다.', 'completed', false, usage);
    };
    try {
      if (signal.aborted) { this.store.settleReservation(reservation, 0); throw cancelledBeforeGeneration(signal); }
      const result = await this.provider.generate(fullRequest, { apiKey, signal });
      if (!validUsage(result.usage)) throw new ModelError('MODEL_USAGE_UNKNOWN', '완전한 모델 사용량을 확인하지 못했습니다. 예약을 유지하고 후속 작업을 중단합니다.', 'unknown');
      settle(result.usage);
      return result;
    } catch (error) {
      if (error instanceof ModelError && error.outcome === 'not_started') this.store.settleReservation(reservation, 0);
      else if (error instanceof ModelError && error.outcome === 'completed' && validUsage(error.usage)) settle(error.usage);
      else { this.store.settleReservation(reservation, null); throw error instanceof ModelError && error.outcome === 'unknown' ? error : new ModelError('MODEL_USAGE_UNKNOWN', '모델 결과·사용량을 확정하지 못해 예약을 유지했습니다.', 'unknown'); }
      throw error;
    }
  }
}
