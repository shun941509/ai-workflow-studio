import { validateCompletionDeclaration, type Workflow, type WorkflowNode } from '@studio/spec';
import { applyWorkingContextPreset, validateAgenticRag, validateExpression, validateWorkingContextSemantics } from '@studio/workflow-core';

export type AuthoredCompletionCriterion = NonNullable<Workflow['completion']>['criteria'][number];
type CompletionCriterion = AuthoredCompletionCriterion;
export type CompletionKind = CompletionCriterion['kind'];
export const COMPLETION_LABELS: Record<CompletionKind, string> = {
  result_schema: '최종 결과 형식 확인', review_accepted: '사용자 검토 수락', evaluate_passed: '규칙 검사 통과', agentic_answered: '검색 에이전트가 근거로 답변', loop_condition_met: '반복 종료 조건 충족',
};
export type CompletionEdit =
  | { type: 'enable' } | { type: 'disable' }
  | { type: 'add'; kind: CompletionKind; nodeId?: string; label: string }
  | { type: 'replace'; id: string; criterion: CompletionCriterion }
  | { type: 'remove'; id: string }
  | { type: 'checks-and-review'; evaluationId: string; reviewId: string };
export interface CompletionSource { id: string; label: string; kind: Exclude<CompletionKind, 'result_schema'> }

/** Existing root nodes supply evidence. This list never creates nodes, repairs modes, traverses children or grants capability. */
export function completionSources(workflow: Workflow): CompletionSource[] {
  const unique = new Map<string, number>(); for (const node of workflow.nodes) unique.set(node.id, (unique.get(node.id) ?? 0) + 1);
  return workflow.nodes.flatMap(node => {
    if (unique.get(node.id) !== 1) return [];
    const kind = supportedKind(node, workflow); return kind ? [{ id: node.id, label: node.label, kind }] : [];
  });
}
function supportedKind(node: WorkflowNode, workflow: Workflow): CompletionSource['kind'] | undefined {
  try {
    if (node.type === 'review') return 'review_accepted';
    // The current operational editor exposes rules evaluation; imported model evaluation stays untouched and unavailable here.
    if (node.type === 'evaluate' && node.config.mode === 'rules' && node.config.rules?.length) { validateExpression(node.config.passRule); for (const rule of node.config.rules) validateExpression(rule.expression); return 'evaluate_passed'; }
    if (node.type === 'agent' && node.config.strategy === 'agentic_rag') { validateAgenticRag(node); return 'agentic_answered'; }
    if (node.type === 'loop' && node.config.mode === 'until' && node.config.bodyFlowRef.kind === 'local' && workflow.subworkflows[node.config.bodyFlowRef.flowId] && node.config.untilExpression) { validateExpression(node.config.untilExpression); return 'loop_condition_met'; }
  } catch { /* Unsupported mode/configuration remains visible as a reference problem, never silently normalized. */ }
  return undefined;
}

/** Keep stale imported/deleted references visible until a user explicitly replaces or removes the criterion. */
export function completionReferenceIssues(workflow: Workflow): { id: string; message: string }[] {
  const sources = completionSources(workflow);
  return (workflow.completion?.criteria ?? []).flatMap(criterion => criterion.kind !== 'result_schema' && !sources.some(source => source.id === criterion.nodeId && source.kind === criterion.kind)
    ? [{ id: criterion.id, message: `확인 필요: ${criterion.nodeId}. 기본 흐름의 블록이 없거나 현재 지원하는 검사 방식이 아닙니다. 블록을 다시 선택하거나 이 기준을 제거하세요.` }] : []);
}
function nextId(criteria: readonly CompletionCriterion[]) { let index = 1; while (criteria.some(criterion => criterion.id === `criterion_${index}`)) index++; return `criterion_${index}`; }
function newCriterion(workflow: Workflow, criteria: readonly CompletionCriterion[], kind: CompletionKind, label: string, nodeId?: string): CompletionCriterion {
  if (kind === 'result_schema') return { id: nextId(criteria), label, kind, schema: structuredClone(workflow.outputs) };
  if (!nodeId || !completionSources(workflow).some(source => source.id === nodeId && source.kind === kind)) throw new Error('기본 흐름에서 지원하는 검사 블록을 먼저 선택하세요.');
  return { id: nextId(criteria), label, kind, nodeId };
}

/** A user edit updates acceptance and its business references in one immutable snapshot. Execution data is never rewritten. */
export function applyCompletionEdit(workflow: Workflow, edit: CompletionEdit, flowId = 'main'): Workflow {
  if (flowId !== 'main') throw new Error('완료 기준은 기본 흐름 설정에서만 편집할 수 있습니다.');
  if (workflow.workDefinition?.harness.workingContext) {
    const issues = validateWorkingContextSemantics(workflow); if (issues.length) throw new Error(`기존 업무 문맥 연결을 먼저 확인하세요. ${issues[0]!.message}`);
  }
  if (edit.type === 'disable') {
    if (workflow.workDefinition) throw new Error('업무 정의가 있는 프로젝트는 완료 기준을 해제할 수 없습니다.');
    const next = { ...workflow }; delete next.completion; return next;
  }
  let criteria: CompletionCriterion[] = structuredClone(workflow.completion?.criteria ?? []);
  if (edit.type === 'enable') {
    if (workflow.completion) throw new Error('완료 기준이 이미 사용 중입니다.');
    criteria = [newCriterion(workflow, [], 'result_schema', COMPLETION_LABELS.result_schema)];
  } else if (edit.type === 'add') {
    if (!workflow.completion) throw new Error('완료 기준 사용을 먼저 선택하세요.');
    criteria.push(newCriterion(workflow, criteria, edit.kind, edit.label, edit.nodeId));
  } else if (edit.type === 'replace') {
    if (!criteria.some(criterion => criterion.id === edit.id) || edit.criterion.id !== edit.id) throw new Error('원래 기준 ID를 유지해 편집하세요.');
    criteria = criteria.map(criterion => criterion.id === edit.id ? structuredClone(edit.criterion) : criterion);
  } else if (edit.type === 'remove') {
    if (!criteria.some(criterion => criterion.id === edit.id)) throw new Error('제거할 기준을 찾을 수 없습니다.');
    if (criteria.length === 1) throw new Error(workflow.workDefinition ? '업무 정의에는 최소 하나의 완료 기준이 필요합니다.' : '마지막 기준은 삭제할 수 없습니다. 판정 자체를 없애려면 완료 기준 해제를 선택하세요.');
    criteria = criteria.filter(criterion => criterion.id !== edit.id);
  } else {
    const sources = completionSources(workflow), evaluation = sources.find(source => source.id === edit.evaluationId && source.kind === 'evaluate_passed'), review = sources.find(source => source.id === edit.reviewId && source.kind === 'review_accepted');
    if (!evaluation || !review) throw new Error('기존 규칙 검사와 사용자 검토 블록을 각각 선택하세요.');
    const before = criteria.length;
    for (const source of [evaluation, review]) if (!criteria.some(criterion => criterion.kind === source.kind && criterion.nodeId === source.id)) criteria.push(newCriterion(workflow, criteria, source.kind, `${source.label} ${source.kind === 'evaluate_passed' ? '통과' : '수락'}`.slice(0, 200), source.id));
    if (before === criteria.length) throw new Error('선택한 검사와 검토는 이미 완료 기준에 연결되어 있습니다.');
  }
  const checked = validateCompletionDeclaration({ version: 1, criteria });
  if (!checked.valid) throw new Error(checked.issues.map(issue => issue.message).join('\n'));
  const next: Workflow = { ...workflow, completion: checked.value };
  // Several stale references must be repairable one by one. Preserve unchanged invalid references for
  // visible diagnostics/export rejection, while forbidding a newly selected missing/unsupported target.
  for (const issue of completionReferenceIssues(next)) {
    const before = workflow.completion?.criteria.find(criterion => criterion.id === issue.id), after = next.completion!.criteria.find(criterion => criterion.id === issue.id)!;
    if (!before || before.kind === 'result_schema' || after.kind === 'result_schema' || before.kind !== after.kind || before.nodeId !== after.nodeId) throw new Error(issue.message);
  }
  if (workflow.workDefinition) {
    const output = workflow.nodes.filter(node => node.type === 'output');
    if (output.length !== 1) throw new Error('업무 정의의 완료 기준에는 고유한 기본 흐름 결과 블록이 필요합니다.');
    const accept = [...new Set(checked.value.criteria.map(criterion => criterion.kind === 'result_schema' ? output[0]!.id : criterion.nodeId))];
    next.workDefinition = { ...workflow.workDefinition, task: { ...workflow.workDefinition.task, criterionIds: [checked.value.criteria[0]!.id, ...checked.value.criteria.slice(1).map(criterion => criterion.id)] }, harness: { ...workflow.workDefinition.harness, accept } };
  }
  // Only the previously validated generated businessTask literal is refreshed; request, opaque instructions,
  // execution conditions, bindings and limits stay unchanged. No working-context preset is introduced implicitly.
  return next.workDefinition?.harness.workingContext ? applyWorkingContextPreset(next, next.workDefinition.harness.workingContext.maxBytes) : next;
}
