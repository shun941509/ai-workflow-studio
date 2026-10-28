import { RunnerError } from '../errors.js';

export interface TokenizerWork { bytes: number; pieces: number; squaredBytes: number }
/** Static work bounds are checked before synchronous JS BPE. They are not an OS-enforced deadline or cancellation. */
export function inspectTokenizerWork(text: string, pattern: string): TokenizerWork {
  const bytes = Buffer.byteLength(text); let pieces = 0; let squaredBytes = 0;
  if (bytes > 65536) throw new RunnerError('TOKENIZER_WORK_LIMIT', '한 번에 측정할 텍스트의 처리 한도를 초과했습니다.');
  // The pattern is a trusted, pinned tiktoken encoding pattern, never workflow-supplied regular expression code.
  for (const piece of text.matchAll(new RegExp(pattern, 'gu'))) {
    const length = Buffer.byteLength(piece[0]); pieces++; squaredBytes += length * length;
    if (length > 512 || pieces > 8192 || squaredBytes > 262144) throw new RunnerError('TOKENIZER_WORK_LIMIT', '텍스트의 토큰 계산 작업량 한도를 초과했습니다.');
  }
  return { bytes, pieces, squaredBytes };
}

/** Aggregate repeated encodings in one operation, including prefixes already counted in earlier candidate trials. */
export function chargeTokenizerWork(total: TokenizerWork, next: TokenizerWork): void {
  total.bytes += next.bytes; total.pieces += next.pieces; total.squaredBytes += next.squaredBytes;
  if (total.bytes > 262144 || total.pieces > 32768 || total.squaredBytes > 1048576) throw new RunnerError('TOKENIZER_WORK_LIMIT', '누적 토큰 계산 작업량 한도를 초과했습니다.');
}
