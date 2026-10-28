import outcomeShape from './generated/run-outcome-validator.generated.cjs';
import type { RunOutcome } from './generated/run-outcome.generated.js';
import { assertJsonData } from './strict-json.js';
import type { ValidationIssue, ValidationResult } from './validation.js';

// The JSON Schema-generated shape has no runtime compilation or eval, including under the Runner's strict CSP.
const issue = (code: string, message: string): ValidationIssue => ({ severity: 'error', stage: 'completion', code, message, instancePath: '/completion' });
/** Stored or transported assessments cannot claim completion with empty checks or inconsistent evidence metadata. */
export function validateRunOutcome(value: unknown): ValidationResult<RunOutcome> {
  try {
    assertJsonData(value);
    if (!outcomeShape(value)) throw new Error('업무 판정 기록 형식이 올바르지 않습니다.');
    const outcome = value as RunOutcome; const ids = new Set<string>();
    for (const check of outcome.checks) {
      if (ids.has(check.criterionId)) throw new Error('중복된 완료 기준 판정입니다.');
      ids.add(check.criterionId);
      if ((check.status === 'passed') !== (check.reason === 'satisfied')) throw new Error('완료 기준 상태와 사유가 다릅니다.');
      if (check.status === 'passed' && (!check.source.nodeInstanceId || !check.source.resultHash)) throw new Error('통과 판정에는 고정 실행 근거가 필요합니다.');
      const methods = check.kind === 'result_schema' ? ['json_schema'] : check.kind === 'review_accepted' ? ['human_review'] : check.kind === 'evaluate_passed' ? ['rule_evaluation', 'model_evaluation'] : check.kind === 'agentic_answered' ? ['agentic_protocol'] : ['loop_control'];
      if (!methods.includes(check.method)) throw new Error('완료 기준 종류와 판정 방법이 다릅니다.');
    }
    if (outcome.status === 'complete' && (outcome.reason !== 'criteria_satisfied' || !outcome.planHash || !outcome.criteriaHash || !outcome.resultHash || !outcome.assessedAt || !outcome.checks.length || outcome.checks.some(check => check.status !== 'passed'))) throw new Error('모든 명시 기준과 고정 결과가 있어야 업무 기준 충족을 기록할 수 있습니다.');
    if (outcome.status !== 'complete' && outcome.reason === 'criteria_satisfied') throw new Error('업무 판정과 완료 사유가 다릅니다.');
    if (outcome.status === 'unassessed' && (outcome.checks.length || outcome.assessedAt !== null || outcome.resultHash !== null || !['criteria_missing', 'not_assessed', 'outcome_record_invalid'].includes(outcome.reason))) throw new Error('미평가 기록에 판정 결과를 넣을 수 없습니다.');
    if (outcome.reason === 'not_assessed' && !outcome.criteriaHash) throw new Error('판정 전 기록에는 선언된 기준이 필요합니다.');
    if (outcome.status === 'incomplete' && (!outcome.planHash || !outcome.criteriaHash || !outcome.assessedAt || !['criteria_not_satisfied', 'execution_incomplete'].includes(outcome.reason))) throw new Error('미완료 판정에는 선언된 기준과 판정 시각이 필요합니다.');
    if (outcome.reason === 'criteria_not_satisfied' && (!outcome.checks.length || outcome.checks.every(check => check.status === 'passed'))) throw new Error('기준 미충족 판정에는 충족하지 못한 기준이 필요합니다.');
    if (outcome.reason === 'execution_incomplete' && outcome.checks.length) throw new Error('실행 미완료 상태에서는 최종 기준을 평가하지 않습니다.');
    if (outcome.reason === 'criteria_missing' && (outcome.criteriaHash !== null || outcome.status !== 'unassessed')) throw new Error('기준 없는 실행은 미평가로 남아야 합니다.');
    return { valid: true, value: outcome, issues: [] };
  } catch (error) { return { valid: false, issues: [issue('OUTCOME_INVALID', error instanceof Error ? error.message : '업무 판정 기록을 확인할 수 없습니다.')] }; }
}
