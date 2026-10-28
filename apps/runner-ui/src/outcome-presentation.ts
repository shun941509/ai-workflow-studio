import { validateRunOutcome } from '@studio/spec/browser';
import type { RunOutcome, CompletionCheck } from '@studio/spec';

export const outcomeLabels = { unassessed: '업무 완료 미평가', complete: '업무 기준 충족', incomplete: '업무 기준 미충족' } as const;
export const checkMethods: Record<CompletionCheck['method'], string> = { json_schema: '명시한 결과 조건 검사', human_review: '사용자 최종 검토', rule_evaluation: '규칙 평가', model_evaluation: '모델 평가 제안과 판정 규칙', agentic_protocol: '근거 검색 답변 상태', loop_control: '반복 종료 조건' };
export const checkReasons: Record<CompletionCheck['reason'], string> = { satisfied: '기준을 충족했습니다.', schema_mismatch: '명시한 결과 조건을 충족하지 못했습니다.', criterion_not_executed: '지정한 최종 근거 블록이 실행되지 않았거나 완료되지 않았습니다.', evidence_unavailable: '판정에 필요한 실행 근거를 확인할 수 없습니다.', review_rejected: '지정한 최종 사용자 검토에서 반려했습니다.', evaluation_failed: '지정한 평가 기준을 통과하지 못했습니다.', insufficient_evidence: '답변할 근거가 부족합니다.', conflicting_evidence: '근거가 충돌하여 답변을 확정하지 못했습니다.', iteration_limit: '목표 조건에 도달하기 전에 반복 한도에 도달했습니다.' };

/** Old servers, missing records, and malformed payloads never borrow the engine's success badge as business approval. */
export function presentOutcome(value: unknown, executionStatus: string): { label: string; description: string; outcome: RunOutcome | null } {
  const checked = validateRunOutcome(value);
  if (!checked.valid || checked.value.status === 'complete' && executionStatus !== 'succeeded') return { label: outcomeLabels.unassessed, description: '업무 완료 판정 기록을 확인할 수 없습니다. 실행 완료만으로 업무 달성을 판단하지 않습니다.', outcome: null };
  const outcome = checked.value;
  const description = outcome.status === 'complete' ? '이 설계에 명시한 모든 완료 기준을 충족했습니다. 아래 검사 방법과 결과를 확인하세요.' : outcome.status === 'incomplete' ? outcome.reason === 'execution_incomplete' ? '실행이 끝까지 완료되지 않아 업무 기준을 충족하지 못했습니다.' : '충족하지 못했거나 확인할 수 없는 기준이 있습니다. 결과를 확인한 뒤 필요한 부분을 보완하세요.' : outcome.reason === 'criteria_missing' ? '이 설계에는 명시한 완료 기준이 없습니다. 결과의 업무 적합성은 별도로 확인하세요.' : outcome.reason === 'outcome_record_invalid' ? '판정 기록을 확인할 수 없어 업무 완료로 표시하지 않습니다.' : '실행이 진행 중이거나 아직 최종 업무 기준을 평가하지 않았습니다.';
  return { label: outcomeLabels[outcome.status], description, outcome };
}
