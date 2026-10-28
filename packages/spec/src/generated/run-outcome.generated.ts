/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */

export interface RunOutcome {
  version: 1;
  status: 'unassessed' | 'complete' | 'incomplete';
  reason:
    | 'criteria_missing'
    | 'not_assessed'
    | 'criteria_satisfied'
    | 'criteria_not_satisfied'
    | 'execution_incomplete'
    | 'outcome_record_invalid';
  /**
   * Null only for legacy or invalid records whose pinned plan identity cannot be established; never valid for a complete assessment.
   */
  planHash: string | null;
  criteriaHash: string | null;
  resultHash: string | null;
  assessedAt: string | null;
  /**
   * @minItems 0
   * @maxItems 32
   */
  checks: CompletionCheck[];
}
export interface CompletionCheck {
  criterionId: string;
  label: string;
  kind: 'result_schema' | 'review_accepted' | 'evaluate_passed' | 'agentic_answered' | 'loop_condition_met';
  method: 'json_schema' | 'human_review' | 'rule_evaluation' | 'model_evaluation' | 'agentic_protocol' | 'loop_control';
  status: 'passed' | 'failed' | 'unavailable';
  reason:
    | 'satisfied'
    | 'schema_mismatch'
    | 'criterion_not_executed'
    | 'evidence_unavailable'
    | 'review_rejected'
    | 'evaluation_failed'
    | 'insufficient_evidence'
    | 'conflicting_evidence'
    | 'iteration_limit';
  source: {
    nodeId: string;
    nodeInstanceId: string | null;
    resultHash: string | null;
  };
}
