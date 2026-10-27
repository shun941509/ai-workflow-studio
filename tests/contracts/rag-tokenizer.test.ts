import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCorpusGeneration, normalizeRankedHits, sealIndexGeneration } from '@studio/rag-core';
import { buildRunRagContext, countRagContextTokens, encodeRagContextText, RAG_CONTEXT_PREFIX, RAG_CONTEXT_TOKENIZER } from '../../apps/runner/src/rag/context-tokenizer.js';

const runnerRequire = createRequire(new URL('../../apps/runner/package.json', import.meta.url));
const bundledRanks = runnerRequire('js-tiktoken/ranks/o200k_base') as { bpe_ranks: string; pat_str: string; special_tokens: Record<string, number> };
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Build real sealed, normalized references; fictional evidence is kept entirely inside the test. */
async function candidates(texts: readonly string[]) {
  const scope = { tenantId: 'test-tenant', projectId: 'test-project' };
  const corpus = await createCorpusGeneration({
    scope, corpusId: 'corpus', generationId: 'generation',
    documents: texts.map((text, index) => ({ documentId: `document-${index}`, revision: 1, sourceUri: `urn:test:document-${index}`, originalBytes: Buffer.from(text), extractedText: text, extraction: { id: 'test-utf8', version: '1', options: {} } })),
    chunks: texts.map((text, index) => ({ chunkId: `chunk-${index}`, documentId: `document-${index}`, start: 0, end: Buffer.byteLength(text) })),
  });
  const index = await sealIndexGeneration({ corpus: corpus.ref, indexId: 'index', generationId: 'generation', kind: 'keyword', artifacts: [{ id: 'test-index', bytes: Buffer.from('internal token-budget test') }] });
  return normalizeRankedHits({ status: 'ok', index: index.ref, corpus: corpus.ref, hits: texts.map((_, index) => ({ chunkId: `chunk-${index}`, rank: index + 1 })) }, corpus, index, 'keyword');
}

afterEach(() => vi.unstubAllGlobals());

describe('fixed local o200k_base measurement', () => {
  // These integer sequences were published by the upstream Python tiktoken implementation,
  // independently of this adapter: https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken
  it.each([
    ['antidisestablishmentarianism', [493, 129901, 376, 160388, 21203, 2367]],
    ['2 + 2 = 4', [17, 659, 220, 17, 314, 220, 19]],
    ['お誕生日おめでとう', [8930, 9697, 243, 128225, 8930, 17693, 4344, 48669]],
  ] as const)('matches the published independent oracle for %s', (text, expected) => {
    expect(encodeRagContextText(text)).toEqual(expected);
    expect(countRagContextTokens(text)).toBe(expected.length);
  });

  // Local regression captures augment the independent oracle; these are not model usage records.
  it.each([
    ['안녕하세요, 세계!', [14307, 171731, 11, 75755, 0]],
    ['가😀나', [4081, 84083, 7663]],
    ['👨‍👩‍👧‍👦', [28823, 101, 2524, 28823, 102, 2524, 28823, 100, 2524, 28823, 99]],
    ['line\r\nline\n', [1137, 370, 1137, 198]],
  ] as const)('keeps Unicode and line endings verbatim for %s', (text, expected) => {
    expect(encodeRagContextText(text)).toEqual(expected);
    expect(countRagContextTokens(text)).toBe(expected.length);
  });

  it('does not normalize composed and decomposed Korean into the same source', () => {
    expect(encodeRagContextText('가')).toEqual([4081]);
    expect(encodeRagContextText('가')).toEqual([157, 226, 222, 157, 227, 94]);
    expect(encodeRagContextText('')).toEqual([]);
    expect(countRagContextTokens('')).toBe(0);
  });

  it.each([
    ['<|endoftext|>', [27, 91, 419, 1440, 919, 91, 29]],
    ['<|endofprompt|>', [27, 91, 419, 1440, 82467, 91, 29]],
  ] as const)('encodes %s as ordinary text without activation or rejection', (text, expected) => {
    expect(encodeRagContextText(text)).toEqual(expected);
    expect(encodeRagContextText(text)).not.toContain(bundledRanks.special_tokens[text]);
    expect(countRagContextTokens(`앞 ${text} 뒤`)).toBeGreaterThan(expected.length);
  });

  it('rejects malformed Unicode and oversized inputs before tokenizing', () => {
    expect(() => countRagContextTokens('\ud800')).toThrow(/surrogate/);
    expect(() => countRagContextTokens('\udc00')).toThrow(/surrogate/);
    expect(() => countRagContextTokens('a'.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MiB/);
    expect(() => countRagContextTokens('가'.repeat(700_000))).toThrow(/2 MiB/);
    expect(() => countRagContextTokens(123 as unknown as string)).toThrow(/string/);
  });

  it('pins the installed implementation, complete ranks, pattern, and literal-special policy', () => {
    const packageFile = resolve(dirname(runnerRequire.resolve('js-tiktoken/lite')), '..', 'package.json');
    const installed = JSON.parse(readFileSync(packageFile, 'utf8')) as { name: string; version: string };
    expect(installed).toMatchObject({ name: RAG_CONTEXT_TOKENIZER.packageName, version: RAG_CONTEXT_TOKENIZER.packageVersion });
    expect(RAG_CONTEXT_TOKENIZER).toEqual({
      encoding: 'o200k_base', packageName: 'js-tiktoken', packageVersion: '1.0.21', specialTokenPolicy: 'ordinary-text',
      ranksSha256: '46095c39ad133184da5315ac91dd491f39901e6d89a05f58f24717fd7cbf0523',
      patternSha256: '6f88fcc3dd53c515d0835648c274a7df6e686598d0f3d4981319b524ed55ddd2',
      tokenizerFingerprint: '3fc5357b5aef06067489ec0d64f921516f39da2302d5554355cff6b73f44d77d',
    });
    expect(sha256(bundledRanks.bpe_ranks)).toBe(RAG_CONTEXT_TOKENIZER.ranksSha256);
    expect(sha256(bundledRanks.pat_str)).toBe(RAG_CONTEXT_TOKENIZER.patternSha256);
    expect(Object.isFrozen(RAG_CONTEXT_TOKENIZER)).toBe(true);
  });

  it('counts with outbound fetch unavailable', () => {
    const fetch = vi.fn(() => { throw new Error('network is unavailable'); });
    vi.stubGlobal('fetch', fetch);
    expect(encodeRagContextText('hello world')).toEqual([24912, 2375]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('whole-chunk retrieval context budget', () => {
  it('charges the fixed prefix even when search returns no candidates', () => {
    const result = buildRunRagContext([], 20);
    expect(result).toEqual({ text: RAG_CONTEXT_PREFIX, candidates: [], tokenCount: 20, tokenizerFingerprint: RAG_CONTEXT_TOKENIZER.tokenizerFingerprint, omittedCount: 0, encoding: 'o200k_base' });
    expect(() => buildRunRagContext([], 19)).toThrow(/prefix alone/);
  });

  it('accepts an exact full-context token boundary and omits the whole next chunk below it', async () => {
    const input = await candidates(['첫 번째 원문 😀', '둘째 원문 <|endoftext|> 끝']);
    const exactText = `${RAG_CONTEXT_PREFIX}\n[source-1]\n${input[0]!.text}\n\n[source-2]\n${input[1]!.text}\n`;
    const exactCount = countRagContextTokens(exactText);
    const exact = buildRunRagContext(input, exactCount);
    expect(exact.text).toBe(exactText);
    expect(exact.tokenCount).toBe(exactCount);
    expect(exact.candidates).toEqual(input);
    expect(exact.omittedCount).toBe(0);
    const below = buildRunRagContext(input, exactCount - 1);
    expect(below.candidates).toEqual([input[0]]);
    expect(below.text).toBe(`${RAG_CONTEXT_PREFIX}\n[source-1]\n${input[0]!.text}\n`);
    expect(below.text).not.toContain(input[1]!.text);
    expect(below.omittedCount).toBe(1);
    expect(below.tokenCount).toBe(countRagContextTokens(below.text));
  });

  it('does not truncate or skip a higher-ranked chunk to fill the budget with lower-ranked text', async () => {
    const input = await candidates(['긴 문서를 잘라서 인용하면 안 됩니다. '.repeat(12), '짧음']);
    const result = buildRunRagContext(input, countRagContextTokens(`${RAG_CONTEXT_PREFIX}\n[source-1]\n짧음\n`));
    expect(result.candidates).toEqual([]);
    expect(result.text).toBe(RAG_CONTEXT_PREFIX);
    expect(result.omittedCount).toBe(2);
  });

  it('never exceeds any integer budget around all source boundaries', async () => {
    const input = await candidates(['첫 근거 😀', '다음 근거는 원문 그대로입니다.', '마지막 <|endofprompt|>']);
    const full = buildRunRagContext(input, 200_000);
    for (let budget = 20; budget <= full.tokenCount + 2; budget++) {
      const result = buildRunRagContext(input, budget);
      expect(result.tokenCount).toBeLessThanOrEqual(budget);
      expect(result.tokenCount).toBe(countRagContextTokens(result.text));
      expect(result.candidates).toEqual(input.slice(0, result.candidates.length));
      expect(result.omittedCount).toBe(input.length - result.candidates.length);
    }
  });

  it('returns immutable source snapshots and rejects invalid budget values', async () => {
    const input = await candidates(['근거']);
    const result = buildRunRagContext(input, 100);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.candidates[0]!.chunk.document)).toBe(true);
    for (const invalid of [0, -1, 20.5, 200001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildRunRagContext(input, invalid)).toThrow(/integer/);
    }
  });
});
