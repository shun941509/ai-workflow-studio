import { ModelError, type ModelProvider, type ModelRequest, type ModelResponse } from './model-provider.js';
import { parseStrictJson } from '@studio/spec';
import { serializeOpenAIRequest } from './request.js';

/** Bounded, strict UTF-8 responses reject ambiguous JSON instead of guessing a count or refund amount. */
async function responseObject(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('response too large'); } chunks.push(item.value); }
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid response'); return value as Record<string, unknown>;
}

/** Fixed provider origin prevents a model profile from turning credentials into an SSRF payload. */
export class OpenAIResponsesProvider implements ModelProvider {
  async countInputTokens(request: ModelRequest, context: { apiKey: string; signal: AbortSignal }): Promise<number> {
    const { countBody } = serializeOpenAIRequest(request);
    if (context.signal.aborted) throw new ModelError('MODEL_COUNT_CANCELLED', '입력 토큰 확인이 취소되었습니다. 생성 요청은 보내지 않았습니다.', 'not_started');
    let response: Response;
    try { response = await fetch('https://api.openai.com/v1/responses/input_tokens', { method: 'POST', headers: { authorization: `Bearer ${context.apiKey}`, 'content-type': 'application/json' }, body: countBody, signal: context.signal, redirect: 'error' }); }
    catch { throw new ModelError('MODEL_COUNT_UNAVAILABLE', '입력 토큰 수를 확인하지 못해 생성 요청을 보내지 않았습니다.', 'not_started'); }
    if (!response.ok) { await response.body?.cancel(); throw new ModelError(response.status === 401 || response.status === 403 ? 'MODEL_COUNT_AUTH_FAILED' : 'MODEL_COUNT_REJECTED', '입력 토큰 확인 요청을 처리하지 못했습니다. 모델 설정·권한을 확인하세요.', 'not_started'); }
    try {
      const value = await responseObject(response, 65536);
      if (value.object !== 'response.input_tokens' || !Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0) throw new Error('invalid count');
      return Number(value.input_tokens);
    } catch { throw new ModelError('MODEL_COUNT_INVALID', '유효한 입력 토큰 수를 받지 못해 생성 요청을 보내지 않았습니다.', 'not_started'); }
  }

  async generate(request: ModelRequest, context: { apiKey: string; signal: AbortSignal }): Promise<ModelResponse> {
    const { generationBody } = serializeOpenAIRequest(request);
    if (context.signal.aborted) throw new ModelError('MODEL_NOT_STARTED', '생성 요청 전 실행이 취소되었습니다.', 'not_started');
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { authorization: `Bearer ${context.apiKey}`, 'content-type': 'application/json' },
        body: generationBody, signal: context.signal, redirect: 'error',
      });
    } catch {
      throw new ModelError(context.signal.aborted ? 'MODEL_INTERRUPTED' : 'MODEL_NETWORK_ERROR', '모델 호출 결과를 확인하지 못했습니다.', 'unknown');
    }
    if (!response.ok) {
      // Raw upstream bodies can contain submitted material; only fixed messages cross this boundary.
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new ModelError('MODEL_AUTH_FAILED', '모델 인증정보와 사용 권한을 확인하세요.', 'not_started');
      if (response.status === 429) throw new ModelError('RATE_LIMITED', '모델 사용량 제한에 도달했습니다.', 'not_started', true);
      if (response.status >= 400 && response.status < 500) throw new ModelError('MODEL_REQUEST_REJECTED', '모델이 요청 설정을 받아들이지 않았습니다.', 'not_started');
      throw new ModelError('MODEL_UPSTREAM_ERROR', '모델 서비스 결과를 확인하지 못했습니다.', 'unknown');
    }
    let value: Record<string, unknown>;
    try {
      value = await responseObject(response, 16 * 1024 * 1024);
    } catch { throw new ModelError('MODEL_RESPONSE_INVALID', '모델 응답을 해석하지 못했습니다.', 'unknown'); }
    const rawUsage = value.usage as Record<string, unknown> | undefined;
    const numbers = [rawUsage?.input_tokens, rawUsage?.output_tokens, rawUsage?.total_tokens];
    const usage = numbers.every((number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)
      && Number(numbers[0]) + Number(numbers[1]) === numbers[2]
      ? { inputTokens: numbers[0] as number, outputTokens: numbers[1] as number, totalTokens: numbers[2] as number }
      : null;
    if (value.status !== 'completed') {
      const terminal = ['incomplete', 'failed', 'cancelled'].includes(String(value.status));
      throw new ModelError('MODEL_INCOMPLETE', '모델이 완전한 결과를 반환하지 않았습니다.', terminal ? 'completed' : 'unknown', false, terminal ? usage : null);
    }
    const text: string[] = [];
    for (const message of Array.isArray(value.output) ? value.output : []) {
      if (!message || typeof message !== 'object') continue;
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'refusal') throw new ModelError('MODEL_REFUSAL', '모델이 이 요청의 처리를 거절했습니다.', 'completed', false, usage);
        if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
      }
    }
    if (!text.length) throw new ModelError('MODEL_OUTPUT_MISSING', '모델이 텍스트 결과를 반환하지 않았습니다.', 'completed', false, usage);
    return { text: text.join('\n'), usage, responseId: typeof value.id === 'string' ? value.id : undefined, model: typeof value.model === 'string' ? value.model : undefined };
  }
}
