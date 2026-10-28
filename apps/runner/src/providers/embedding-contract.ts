import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import type { EmbeddingProfile } from '@studio/rag-core';
import { RunnerError } from '../errors.js';
import type { ModelProfile } from '../state/store.js';
import { chargeTokenizerWork, inspectTokenizerWork } from './tokenizer-work.js';

/** Closed embedding contract; the provider alias does not promise an immutable upstream weights snapshot. */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const EMBEDDING_CONTRACT = Object.freeze({
  id: 'openai-small-256-cl100k-v1', provider: 'openai', model: 'text-embedding-3-small', dimensions: 256,
  normalization: 'l2', distance: 'cosine', maxChunks: 128, maxBatchInputs: 16, maxInputReservation: 8192, maxBatchReservation: 32768, maxTokenizerPieceBytes: 512,
  tokenizer: Object.freeze({ encoding: 'cl100k_base', package: 'js-tiktoken', version: '1.0.21', fingerprint: sha(JSON.stringify({ ranks: cl100k.bpe_ranks, pattern: cl100k.pat_str, specials: Object.entries(cl100k.special_tokens).sort(), policy: 'ordinary-specials-verbatim-v1' })) }),
  reservationRule: 'max-local-bpe-utf8-bytes-plus64-per-input-v1',
});
export const EMBEDDING_CONTRACT_HASH = canonicalDigest(EMBEDDING_CONTRACT);
let tokenizer: Tiktoken | undefined;

/** This local measurement is deliberately distinct from actual provider billing and the Responses count API. */
export function measureEmbeddingInputs(input: readonly string[]): { localTokens: number; reservedTokens: number; inputCount: number; tokenizerFingerprint: string; reservationRule: string } {
  assertJsonData(input);
  if (!Array.isArray(input) || !input.length || input.length > EMBEDDING_CONTRACT.maxBatchInputs) throw new RunnerError('EMBEDDING_BATCH_LIMIT', '임베딩 배치는 1~16개의 입력을 받습니다.');
  tokenizer ??= new Tiktoken(cl100k);
  let localTokens = 0; let reservedTokens = 0;
  const work = { bytes: 0, pieces: 0, squaredBytes: 0 };
  for (const value of input) {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 8192) throw new RunnerError('EMBEDDING_INPUT_LIMIT', '임베딩 입력이 비어 있거나 지원 크기를 초과했습니다.');
    // The pure JS BPE merge is expensive on one long repeated regex piece. Bound that work before encoding,
    // instead of blocking cancellation/event-loop progress for an unbounded tokenization operation.
    try { chargeTokenizerWork(work, inspectTokenizerWork(value, cl100k.pat_str)); }
    catch { throw new RunnerError('EMBEDDING_TOKENIZER_LIMIT', '입력의 토큰 계산 작업량 한도를 초과했습니다.'); }
    const count = tokenizer.encode(value, [], []).length; const reserved = Math.max(count, Buffer.byteLength(value)) + 64;
    if (!count || reserved > EMBEDDING_CONTRACT.maxInputReservation) throw new RunnerError('EMBEDDING_INPUT_LIMIT', '임베딩 입력의 보수적 예약 한도를 초과했습니다.');
    localTokens += count; reservedTokens += reserved;
  }
  if (reservedTokens > EMBEDDING_CONTRACT.maxBatchReservation) throw new RunnerError('EMBEDDING_BATCH_LIMIT', '임베딩 배치의 보수적 예약 한도를 초과했습니다.');
  return { localTokens, reservedTokens, inputCount: input.length, tokenizerFingerprint: EMBEDDING_CONTRACT.tokenizer.fingerprint, reservationRule: EMBEDDING_CONTRACT.reservationRule };
}

/** Validate every chunk before any external request, then form deterministic bounded batches. */
export function embeddingBatches(input: readonly string[]): string[][] {
  if (!input.length || input.length > EMBEDDING_CONTRACT.maxChunks) throw new RunnerError('EMBEDDING_CHUNK_LIMIT', '벡터 색인은 1~128개 청크를 지원합니다.');
  // Preflight the whole build before the first synchronous encoding, not only each later API batch.
  const work = { bytes: 0, pieces: 0, squaredBytes: 0 };
  try { for (const value of input) { assertJsonData(value); if (typeof value !== 'string') throw new Error('string'); chargeTokenizerWork(work, inspectTokenizerWork(value, cl100k.pat_str)); } }
  catch { throw new RunnerError('EMBEDDING_TOKENIZER_LIMIT', '전체 청크의 토큰 계산 작업량 한도를 초과했습니다.'); }
  const counts = input.map(value => measureEmbeddingInputs([value])); const result: string[][] = []; let batch: string[] = []; let tokens = 0;
  for (const [offset, value] of input.entries()) {
    if (batch.length === EMBEDDING_CONTRACT.maxBatchInputs || tokens + counts[offset]!.reservedTokens > EMBEDDING_CONTRACT.maxBatchReservation) { result.push(batch); batch = []; tokens = 0; }
    batch.push(value); tokens += counts[offset]!.reservedTokens;
  }
  if (batch.length) result.push(batch); return result;
}

/** Alias/profile identity is nonsecret and pinned in the generation; unknown models never inherit this contract. */
export function embeddingProfile(profile: ModelProfile, alias: string): EmbeddingProfile {
  if (profile.kind !== 'embedding' || profile.provider !== 'openai' || profile.model !== EMBEDDING_CONTRACT.model || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new RunnerError('EMBEDDING_PROFILE_UNSUPPORTED', '고정된 OpenAI 임베딩 모델 연결이 필요합니다.');
  return { providerId: 'openai', modelId: profile.model, modelRevision: 'unversioned-provider-alias', dimensions: 256, distance: 'cosine', normalization: 'l2', tokenizerRevision: EMBEDDING_CONTRACT.tokenizer.fingerprint, preprocessingRevision: 'verbatim-utf8-l2-v1', parameters: { contractHash: EMBEDDING_CONTRACT_HASH, bindingAlias: alias, profileId: profile.id, encoding_format: 'float' } };
}
