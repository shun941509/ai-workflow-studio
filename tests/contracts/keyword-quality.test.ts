import { describe, expect, it } from 'vitest';
import { benchmarkKeywordSearch, queryMetrics } from '../../tooling/evaluation/keyword-benchmark';

/** The fixed judgments reveal morphology/semantic misses rather than requiring keyword search to pretend to understand them. */
describe('Korean keyword quality diagnostics', () => {
  it('matches independently calculated graded ranking metrics and separates unanswerable queries', () => {
    expect(queryMetrics(['b', 'a', 'c'], { a: 3, c: 1 }, 3)).toMatchObject({ recall: 1, reciprocalRank: .5 });
    expect(queryMetrics(['b', 'a', 'c'], { a: 3, c: 1 }, 3).ndcg).toBeCloseTo((7 / Math.log2(3) + 1 / 2) / (7 + 1 / Math.log2(3)), 14);
    expect(queryMetrics(['b'], {}, 3)).toEqual({ recall: null, reciprocalRank: null, ndcg: null, falseHit: true });
    expect(queryMetrics([], {}, 3).falseHit).toBe(false);
    expect(() => queryMetrics(['a', 'a'], { a: 3 }, 3)).toThrow();
  });
  it('retrieves exact/normalized terms and reports natural-language and false-hit limitations without changing the judgments', async () => {
    const result = await benchmarkKeywordSearch();
    expect(result.total.queries).toBe(24); expect(result.total.answerable).toBe(20); expect(result.total.unanswerable).toBe(4);
    expect(result.categories.exact!.mrr).toBe(1); expect(result.categories.normalization!.mrr).toBe(1);
    expect(result.categories.morphology!.recall).toBeLessThan(1); expect(result.categories.semantic!.recall).toBeLessThan(1);
    expect(result.categories.unanswerable!.falseHitRate).toBeGreaterThan(0);
    expect(result.queries.find(row => row.id === 'q24')!.falseHit).toBe(true);
    expect(result.externalModelTested).toBe(false); expect(result.releaseEvidence).toBe(false);
  });
});
