import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { ModelError, type ModelRequest } from './model-provider.js';

/** Clone/freeze before any credential/network await so nested schemas/content cannot change between counting and generation. */
export function ownModelRequest(input: ModelRequest): { request: ModelRequest; requestHash: string } {
  try {
    assertJsonData(input);
    if (Object.keys(input).filter(key => key !== 'reasoning').sort().join(',') !== 'content,instructions,maxOutputTokens,model,responseFormat' || typeof input.model !== 'string' || !input.model || input.model.length > 120 || typeof input.instructions !== 'string' || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 200000 || !input.responseFormat || !['text', 'json'].includes(input.responseFormat.mode)) throw new Error('Invalid request');
    if (input.reasoning !== undefined && (!input.reasoning || Object.keys(input.reasoning).join(',') !== 'effort' || input.reasoning.effort !== 'none')) throw new Error('Invalid reasoning');
    const expected = input.responseFormat.mode === 'text' ? 'mode' : 'mode,schema';
    if (Object.keys(input.responseFormat).sort().join(',') !== expected) throw new Error('Invalid response format');
    const request = structuredClone(input);
    const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
    freeze(request); return { request, requestHash: canonicalDigest(request) };
  } catch { throw new ModelError('MODEL_REQUEST_INVALID', '모델 요청의 형식·크기를 확인하세요.', 'not_started'); }
}

/** Only shared input-affecting fields enter count; generation-only flags are added afterward. */
export function serializeOpenAIRequest(input: ModelRequest): { countBody: string; generationBody: string; requestHash: string } {
  const { request, requestHash } = ownModelRequest(input);
  const shared = { model: request.model, instructions: request.instructions, input: typeof request.content === 'string' ? request.content : JSON.stringify(request.content), ...(request.reasoning ? { reasoning: request.reasoning } : {}), ...(request.responseFormat.mode === 'json' ? { text: { format: { type: 'json_schema', name: 'workflow_result', strict: true, schema: request.responseFormat.schema } } } : {}) };
  return { countBody: JSON.stringify(shared), generationBody: JSON.stringify({ ...shared, max_output_tokens: request.maxOutputTokens, store: false }), requestHash };
}
