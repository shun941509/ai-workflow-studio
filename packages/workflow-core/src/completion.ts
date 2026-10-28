import { validateCompletionDeclaration, validateJsonValue, type Workflow, type WorkflowNode, type ValidationIssue, type RunOutcome, type CompletionCheck } from '@studio/spec';

export interface CompletionNodeEvidence {
  nodeId: string;
  nodeInstanceId: string;
  status: string;
  result: unknown;
  resultHash: string | null;
}
export type CompletionAssessment = Pick<RunOutcome, 'status' | 'reason' | 'checks'>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Evidence references identify root nodes and their real protocol, never a similarly named node in a child flow. */
export function validateCompletionSemantics(workflow: Workflow): ValidationIssue[] {
  if (!workflow.completion) return [];
  const checked = validateCompletionDeclaration(workflow.completion); if (!checked.valid) return checked.issues;
  const issues: ValidationIssue[] = [];
  for (const [index, criterion] of checked.value.criteria.entries()) {
    if (criterion.kind === 'result_schema') continue;
    const node = workflow.nodes.find(item => item.id === criterion.nodeId);
    const valid = node && (criterion.kind === 'review_accepted' ? node.type === 'review' : criterion.kind === 'evaluate_passed' ? node.type === 'evaluate' : criterion.kind === 'agentic_answered' ? node.type === 'agent' && node.config.strategy === 'agentic_rag' : node.type === 'loop' && node.config.mode === 'until');
    if (!valid) issues.push({ severity: 'error', stage: 'completion', code: 'COMPLETION_SOURCE_INVALID', message: '완료 기준은 해당 종류의 루트 블록을 최종 근거로 지정해야 합니다.', nodeId: criterion.nodeId, instancePath: `/completion/criteria/${index}/nodeId` });
  }
  return issues;
}

function method(kind: CompletionCheck['kind'], node: WorkflowNode | undefined): CompletionCheck['method'] {
  return kind === 'result_schema' ? 'json_schema' : kind === 'review_accepted' ? 'human_review' : kind === 'evaluate_passed' ? node?.type === 'evaluate' && node.config.mode === 'model' ? 'model_evaluation' : 'rule_evaluation' : kind === 'agentic_answered' ? 'agentic_protocol' : 'loop_control';
}

/** Pure assessment consumes trusted Runner evidence; it never calls a model, executes code, or changes engine status. */
export function evaluateCompletion(workflow: Workflow, executionStatus: string, evidence: readonly CompletionNodeEvidence[]): CompletionAssessment {
  if (!workflow.completion) return { status: 'unassessed', reason: 'criteria_missing', checks: [] };
  if (validateCompletionSemantics(workflow).length) throw new Error('COMPLETION_INVALID');
  if (executionStatus !== 'succeeded') return ['failed', 'blocked', 'cancelled'].includes(executionStatus)
    ? { status: 'incomplete', reason: 'execution_incomplete', checks: [] }
    : { status: 'unassessed', reason: 'not_assessed', checks: [] };
  const outputNode = workflow.nodes.find(node => node.type === 'output'); if (!outputNode) throw new Error('COMPLETION_OUTPUT_MISSING');
  const checks: CompletionCheck[] = workflow.completion.criteria.map(criterion => {
    const nodeId = criterion.kind === 'result_schema' ? outputNode.id : criterion.nodeId;
    const node = workflow.nodes.find(item => item.id === nodeId); const matches = evidence.filter(item => item.nodeId === nodeId); const record = matches.length === 1 ? matches[0] : undefined;
    const base = { criterionId: criterion.id, label: criterion.label, kind: criterion.kind, method: method(criterion.kind, node), source: { nodeId, nodeInstanceId: record?.nodeInstanceId ?? null, resultHash: record?.resultHash ?? null } };
    const result = (status: CompletionCheck['status'], reason: CompletionCheck['reason']): CompletionCheck => ({ ...base, status, reason });
    if (!record || record.status !== 'succeeded') return result('unavailable', 'criterion_not_executed');
    if (!record.nodeInstanceId || !record.resultHash || !/^[a-f0-9]{64}$/.test(record.resultHash) || !object(record.result) || !Object.hasOwn(record.result, 'data')) return result('unavailable', 'evidence_unavailable');
    const data = record.result.data;
    if (criterion.kind === 'result_schema') return validateJsonValue(criterion.schema, data).valid ? result('passed', 'satisfied') : result('failed', 'schema_mismatch');
    if (!object(data)) return result('unavailable', 'evidence_unavailable');
    if (criterion.kind === 'review_accepted') return data.decision === 'accepted' ? result('passed', 'satisfied') : data.decision === 'rejected' ? result('failed', 'review_rejected') : result('unavailable', 'evidence_unavailable');
    if (criterion.kind === 'evaluate_passed') return data.passed === true ? result('passed', 'satisfied') : data.passed === false ? result('failed', 'evaluation_failed') : result('unavailable', 'evidence_unavailable');
    if (criterion.kind === 'agentic_answered') return data.status === 'answered' ? result('passed', 'satisfied') : data.status === 'insufficient_evidence' ? result('failed', 'insufficient_evidence') : data.status === 'conflicting_evidence' ? result('failed', 'conflicting_evidence') : result('unavailable', 'evidence_unavailable');
    return data.reason === 'condition_met' ? result('passed', 'satisfied') : data.reason === 'max_iterations' ? result('failed', 'iteration_limit') : result('unavailable', 'evidence_unavailable');
  });
  const passed = checks.every(check => check.status === 'passed');
  return { status: passed ? 'complete' : 'incomplete', reason: passed ? 'criteria_satisfied' : 'criteria_not_satisfied', checks };
}
