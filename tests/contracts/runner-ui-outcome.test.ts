import { expect, it } from 'vitest';
import { presentOutcome, checkMethods } from '../../apps/runner-ui/src/outcome-presentation';
import { withoutRunContent } from '../../apps/runner-ui/src/run-disclosure';
import { statusNames, type Run } from '../../apps/runner-ui/src/types';

/** UI interpretation is conservative for old servers and cannot turn generated text into a verified badge. */
it('calls engine success execution-complete while absent or forged outcomes remain unassessed', () => {
  expect(statusNames.succeeded).toBe('실행 완료');
  for (const value of [undefined, null, { status: 'complete' }, 'complete']) expect(presentOutcome(value, 'succeeded').label).toBe('업무 완료 미평가');
});
it('clears assessment labels and hashes with other sensitive run content on disclosure changes', () => {
  const run = { id: 'run', packageHandle: 'package', status: 'succeeded', createdAt: '', error: null, result: {}, outcome: { label: 'private acceptance', criteriaHash: 'private hash' }, usage: { modelCalls: 0, consumedTokens: 0, reservedTokens: 0 }, disclosure: { allowed: false } } as unknown as Run;
  const safe = withoutRunContent(run); expect(safe.outcome).toBeNull(); expect(JSON.stringify(safe)).not.toContain('private'); expect(run.outcome).not.toBeNull();
});
it('makes model evaluation visibly distinct from a rule or human review', () => {
  expect(checkMethods.model_evaluation).toContain('모델'); expect(checkMethods.model_evaluation).not.toBe(checkMethods.rule_evaluation); expect(checkMethods.human_review).toContain('사용자');
});
