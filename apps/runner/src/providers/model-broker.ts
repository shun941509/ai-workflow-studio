import type { CredentialStore } from '../security/credential-store.js';
import type { ModelProfile } from '../state/store.js';
import { RunStore } from '../state/store.js';
import { ModelError, type ModelProvider, type ModelRequest, type ModelResponse } from './model-provider.js';
import { canonicalDigest } from '@studio/package-kit';
import { ownModelRequest } from './request.js';
import { assertBrokerDisclosure } from '../provenance/run-disclosure.js';
import type { WorkingContextAudit } from '../context/working-context.js';

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
  constructor(private readonly store: RunStore, private readonly credentials: CredentialStore, private readonly provider: ModelProvider, private readonly authorizeDisclosure?: (runId: string) => void) {}

  async invoke(runId: string, nodeId: string, profile: ModelProfile, request: Omit<ModelRequest, 'model'>, signal: AbortSignal, guard?: { purpose: 'reranker'; beforeDispatch(stage: 'count' | 'generate'): void }, context?: WorkingContextAudit): Promise<ModelResponse> {
    if ((profile.kind ?? 'chat') !== (guard?.purpose ?? 'chat')) throw new ModelError('MODEL_CAPABILITY_MISSING', '모델 연결의 종류와 실행 목적이 일치하지 않습니다.', 'not_started');
    const { request: fullRequest, requestHash } = ownModelRequest({ ...request, model: profile.model });
    if (signal.aborted) throw cancelledBeforeGeneration(signal);
    // This is the exact owned/frozen request used by both count and generate, before credentials are loaded.
    // Key ordering does not alter UTF-8 byte count; JSON.stringify and canonical JSON use the same string/number encoding here.
    context?.verify(fullRequest);
    const contextId = context ? this.store.workingContexts.prepare({ ...context.draft, requestHash, requestBytes: Buffer.byteLength(JSON.stringify(fullRequest), 'utf8'), model: profile.model, provider: profile.provider }) : undefined;
    const apiKey = await this.credentials.get(profile.credentialRef);
    if (signal.aborted) throw cancelledBeforeGeneration(signal);
    // Trusted synchronous checks run after credential awaits and directly before each disclosure. Workflow data cannot supply these callbacks.
    assertBrokerDisclosure(this.store, runId, this.authorizeDisclosure);
    if (guard && guard.beforeDispatch('count') !== undefined) throw new ModelError('MODEL_GUARD_INVALID', '전송 권한 검사는 동기적으로 완료되어야 합니다.', 'not_started');
    const countId = this.store.beginModelCount(runId, nodeId, requestHash, fullRequest.maxOutputTokens, contextId);
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
    try {
      if (signal.aborted) throw cancelledBeforeGeneration(signal);
      assertBrokerDisclosure(this.store, runId, this.authorizeDisclosure);
      if (guard && guard.beforeDispatch('generate') !== undefined) throw new ModelError('MODEL_GUARD_INVALID', '전송 권한 검사는 동기적으로 완료되어야 합니다.', 'not_started');
    } catch (error) {
      // Authorization failures here prove generate has not started. Preserve their original security error, not a fallback-eligible provider error.
      this.store.settleReservation(reservation, 0); throw error;
    }
    const settle = (usage: NonNullable<ModelResponse['usage']>) => {
      const accounting = this.store.settleReservation(reservation, usage.totalTokens, { requestHash, expectedInputTokens: inputTokens, actualInputTokens: usage.inputTokens, maxOutputTokens: fullRequest.maxOutputTokens, actualOutputTokens: usage.outputTokens });
      if (accounting?.overrun || accounting?.inputUndercount || accounting?.outputOverrun) throw new ModelError('BUDGET_EXCEEDED', '실제 모델 사용량이 확인한 입력·예약 한도를 초과해 후속 작업을 중단했습니다.', 'completed', false, usage);
    };
    let contextGenerationStarted = false;
    try {
      if (signal.aborted) { this.store.settleReservation(reservation, 0); throw cancelledBeforeGeneration(signal); }
      if (contextId) {
        try { this.store.workingContexts.generation(contextId, 'invocation_intent'); contextGenerationStarted = true; }
        catch { throw new ModelError('WORK_CONTEXT_RECORD_FAILED', '전송 시도 기록을 남기지 못해 생성 요청을 보내지 않았습니다.', 'not_started'); }
      }
      const result = await this.provider.generate(fullRequest, { apiKey, signal });
      if (!validUsage(result.usage)) throw new ModelError('MODEL_USAGE_UNKNOWN', '완전한 모델 사용량을 확인하지 못했습니다. 예약을 유지하고 후속 작업을 중단합니다.', 'unknown');
      settle(result.usage);
      if (contextId) {
        try { this.store.workingContexts.generation(contextId, 'response_confirmed'); contextGenerationStarted = false; }
        catch { throw new ModelError('WORK_CONTEXT_RECORD_UNKNOWN', '공급자 응답 뒤 문맥 기록을 확정하지 못했습니다. 자동 재호출하지 않습니다.', 'unknown'); }
      }
      return result;
    } catch (error) {
      // Confirmation concerns the provider boundary/usage only; handler schema validation and business acceptance happen later.
      if (contextId && contextGenerationStarted) {
        try { this.store.workingContexts.generation(contextId, error instanceof ModelError ? error.outcome === 'not_started' ? 'not_started' : error.outcome === 'completed' ? 'failed_confirmed' : 'unknown' : 'unknown', error instanceof ModelError ? error.code : 'MODEL_USAGE_UNKNOWN'); }
        catch { /* The earlier durable intent remains unconfirmed; a failed journal write never authorizes replay. */ }
      }
      if (error instanceof ModelError && error.outcome === 'not_started') this.store.settleReservation(reservation, 0);
      else if (error instanceof ModelError && error.outcome === 'completed' && validUsage(error.usage)) settle(error.usage);
      else { this.store.settleReservation(reservation, null); throw error instanceof ModelError && error.outcome === 'unknown' ? error : new ModelError('MODEL_USAGE_UNKNOWN', '모델 결과·사용량을 확정하지 못해 예약을 유지했습니다.', 'unknown'); }
      throw error;
    }
  }
}
