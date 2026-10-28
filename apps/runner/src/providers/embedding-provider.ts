import { assertJsonData, parseStrictJson } from '@studio/spec';
import { ModelError, type ModelResponse } from './model-provider.js';
import { EMBEDDING_CONTRACT, measureEmbeddingInputs } from './embedding-contract.js';

export interface EmbeddingRequest { model: string; dimensions: number; input: readonly string[] }
export interface EmbeddingResponse { model: string; vectors: number[][]; usage: ModelResponse['usage'] }
export interface EmbeddingProvider { embed(request: EmbeddingRequest, context: { apiKey: string; signal: AbortSignal }): Promise<EmbeddingResponse> }

/** Strict cardinality/dimensionality is checked for network and injected adapters alike, before any index is sealed. */
export function checkedEmbeddingVectors(value: unknown, count: number): number[][] {
  assertJsonData(value);
  if (!Array.isArray(value) || value.length !== count) throw new ModelError('EMBEDDING_RESULT_INVALID', '임베딩 결과 개수가 입력과 다릅니다.', 'unknown');
  return value.map(vector => {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_CONTRACT.dimensions || vector.some(number => typeof number !== 'number' || !Number.isFinite(number))) throw new ModelError('EMBEDDING_RESULT_INVALID', '임베딩 벡터 차원·값이 고정 계약과 다릅니다.', 'unknown');
    const norm = vector.reduce((acc, number) => Math.hypot(acc, number), 0);
    if (!Number.isFinite(norm) || norm === 0) throw new ModelError('EMBEDDING_RESULT_INVALID', '임베딩 벡터를 정규화할 수 없습니다.', 'unknown');
    return vector.map(number => number / norm);
  });
}

/** A fixed endpoint, bounded body and no redirects prevent profile-driven credential exfiltration or unbounded responses. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  async embed(request: EmbeddingRequest, context: { apiKey: string; signal: AbortSignal }): Promise<EmbeddingResponse> {
    assertJsonData(request); measureEmbeddingInputs(request.input);
    if (request.model !== EMBEDDING_CONTRACT.model || request.dimensions !== 256 || Object.keys(request).some(key => !['model', 'dimensions', 'input'].includes(key))) throw new ModelError('EMBEDDING_PROFILE_UNSUPPORTED', '지원하지 않는 임베딩 요청입니다.', 'not_started');
    if (context.signal.aborted) throw new ModelError('EMBEDDING_NOT_STARTED', '임베딩 요청 전에 취소되었습니다.', 'not_started');
    const body = JSON.stringify({ model: request.model, dimensions: request.dimensions, input: request.input, encoding_format: 'float' });
    let response: Response;
    try { response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { authorization: `Bearer ${context.apiKey}`, 'content-type': 'application/json' }, body, signal: context.signal, redirect: 'error' }); }
    catch { throw new ModelError('EMBEDDING_RESULT_UNKNOWN', '임베딩 요청의 처리 결과를 확인하지 못했습니다.', 'unknown'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 400 && response.status < 500) throw new ModelError(response.status === 429 ? 'EMBEDDING_RATE_LIMITED' : 'EMBEDDING_REQUEST_REJECTED', '임베딩 요청이 거절되었습니다. 자동 재시도하지 않습니다.', 'not_started');
      throw new ModelError('EMBEDDING_RESULT_UNKNOWN', '임베딩 서비스의 처리 결과를 확인하지 못했습니다.', 'unknown');
    }
    try {
      const reader = response.body?.getReader(); if (!reader) throw new Error('missing body');
      let size = 0; const chunks: Uint8Array[] = [];
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 512 * 1024) { await reader.cancel(); throw new Error('size'); } chunks.push(part.value); }
      const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as Record<string, unknown>;
      if (!value || value.object !== 'list' || value.model !== request.model || !Array.isArray(value.data) || value.data.length !== request.input.length) throw new Error('shape');
      const vectors: unknown[] = new Array(request.input.length); const seen = new Set<number>();
      for (const entry of value.data as Record<string, unknown>[]) {
        if (!entry || entry.object !== 'embedding' || !Number.isSafeInteger(entry.index) || Number(entry.index) < 0 || Number(entry.index) >= request.input.length || seen.has(Number(entry.index))) throw new Error('index');
        seen.add(Number(entry.index)); vectors[Number(entry.index)] = entry.embedding;
      }
      const raw = value.usage as Record<string, unknown> | undefined;
      const valid = raw && Number.isSafeInteger(raw.prompt_tokens) && Number(raw.prompt_tokens) >= 0 && raw.prompt_tokens === raw.total_tokens;
      return { model: request.model, vectors: checkedEmbeddingVectors(vectors, request.input.length), usage: valid ? { inputTokens: Number(raw.prompt_tokens), outputTokens: 0, totalTokens: Number(raw.total_tokens) } : null };
    } catch { throw new ModelError('EMBEDDING_RESPONSE_INVALID', '완전한 임베딩 결과를 확인하지 못했습니다. 예약을 유지합니다.', 'unknown'); }
  }
}
