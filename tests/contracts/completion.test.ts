import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, validateCompletionDeclaration, validateRunOutcome, validateWorkflowShape, type Workflow, type CompletionCriterion, type RunOutcome } from '@studio/spec';
import { analyzeWorkflow, collectRequirements, evaluateCompletion, validateCompletionSemantics, type CompletionNodeEvidence } from '@studio/workflow-core';
import { canonicalDigest } from '@studio/package-kit';

const criterion = (kind: CompletionCriterion['kind'], nodeId = 'target'): CompletionCriterion => kind === 'result_schema' ? { id: 'check', label: '최종 내용', kind, schema: { type: 'string', minLength: 3 } } : { id: 'check', label: '최종 근거', kind, nodeId };
function project(check = criterion('result_schema')): Workflow { const workflow = createBasicWorkflow(); workflow.completion = { version: 1, criteria: [check] }; return workflow; }
function evidence(nodeId: string, data: unknown, status = 'succeeded'): CompletionNodeEvidence { const result = { data }; return { nodeId, nodeInstanceId: `run:${nodeId}`, status, result, resultHash: canonicalDigest(result) }; }
function target(kind: CompletionCriterion['kind']) { const workflow = project(criterion(kind)); const node = { ...createNode(kind === 'review_accepted' ? 'review' : kind === 'evaluate_passed' ? 'evaluate' : kind === 'agentic_answered' ? 'agent' : 'loop'), id: 'target' }; if (node.type === 'agent') node.config.strategy = 'agentic_rag'; if (node.type === 'loop') node.config.mode = 'until'; workflow.nodes.splice(1, 0, node); return workflow; }

/** The test provider is absent: these checks operate only on explicit criteria and durable protocol evidence. */
describe('declared business completion contracts', () => {
  it('keeps every legacy execution unassessed, including fabricated model completion fields', () => {
    const workflow = createBasicWorkflow();
    for (const status of ['succeeded', 'failed', 'blocked', 'cancelled', 'attention_required']) expect(evaluateCompletion(workflow, status, [evidence('output', { outcome: 'complete', passed: true })])).toEqual({ status: 'unassessed', reason: 'criteria_missing', checks: [] });
  });
  it('requires all 1..32 criteria with unique IDs and bounded real UTF-8 bytes', () => {
    expect(validateCompletionDeclaration({ version: 1, criteria: [] }).valid).toBe(false);
    expect(validateCompletionDeclaration({ version: 1, criteria: Array(33).fill(criterion('result_schema')) }).valid).toBe(false);
    expect(validateCompletionDeclaration({ version: 1, criteria: [criterion('result_schema'), criterion('result_schema')] }).valid).toBe(false);
    expect(validateCompletionDeclaration({ version: 1, criteria: [criterion('result_schema')], mode: 'any' }).valid).toBe(false);
    const value = { version: 1, criteria: [{ ...criterion('result_schema'), schema: { const: '한'.repeat(90000) } }] };
    expect(JSON.stringify(value).length).toBeLessThan(262144); expect(validateCompletionDeclaration(value).valid).toBe(false);
  });
  it('rejects unsupported result schemas before execution and pins the new capability only when declared', () => {
    const workflow = project({ id: 'check', label: '조건', kind: 'result_schema', schema: { pattern: '.*' } }); expect(validateWorkflowShape(workflow).valid).toBe(false);
    expect(collectRequirements(project()).capabilities).toContain('workflow.completion@1'); expect(collectRequirements(createBasicWorkflow()).capabilities).not.toContain('workflow.completion@1');
  });
  it.each(['review_accepted', 'evaluate_passed', 'agentic_answered', 'loop_condition_met'] as const)('requires an exact root %s protocol, not a child or arbitrary AI result', kind => {
    const workflow = project(criterion(kind, 'ai'));
    expect(validateCompletionSemantics(workflow)[0]?.code).toBe('COMPLETION_SOURCE_INVALID');
    expect(analyzeWorkflow(workflow).some(issue => issue.code === 'COMPLETION_SOURCE_INVALID')).toBe(true);
    const matching = target(kind); expect(validateCompletionSemantics(matching)).toEqual([]);
    matching.completion!.criteria = [criterion(kind, 'child/target')]; expect(validateCompletionSemantics(matching).length).toBeGreaterThan(0);
  });
  it('requires final result criteria separately from the output type, without changing source values', () => {
    const workflow = project(); const outputId = workflow.nodes.find(node => node.type === 'output')!.id;
    const records = [evidence(outputId, '완성된 내용')]; const snapshot = JSON.stringify({ workflow, records });
    expect(evaluateCompletion(workflow, 'succeeded', records)).toMatchObject({ status: 'complete', checks: [{ status: 'passed', method: 'json_schema' }] });
    expect(evaluateCompletion(workflow, 'succeeded', [evidence(outputId, '')])).toMatchObject({ status: 'incomplete', checks: [{ reason: 'schema_mismatch' }] });
    expect(JSON.stringify({ workflow, records })).toBe(snapshot);
  });
  it.each([
    ['review_accepted', { decision: 'rejected' }, 'review_rejected'],
    ['evaluate_passed', { passed: false }, 'evaluation_failed'],
    ['agentic_answered', { status: 'insufficient_evidence', outcome: 'complete' }, 'insufficient_evidence'],
    ['agentic_answered', { status: 'conflicting_evidence' }, 'conflicting_evidence'],
    ['loop_condition_met', { reason: 'max_iterations' }, 'iteration_limit'],
  ] as const)('does not call a normal %s terminal value business complete', (kind, data, reason) => {
    expect(evaluateCompletion(target(kind), 'succeeded', [evidence('target', data)])).toMatchObject({ status: 'incomplete', checks: [{ status: 'failed', reason }] });
  });
  it('reports unexecuted, missing and ambiguous final evidence without treating inactive nodes as success', () => {
    const workflow = target('review_accepted');
    for (const records of [[], [evidence('target', { decision: 'accepted' }, 'skipped')], [evidence('target', {})], [evidence('target', { decision: 'accepted' }), evidence('target', { decision: 'accepted' })]]) expect(evaluateCompletion(workflow, 'succeeded', records)).toMatchObject({ status: 'incomplete', checks: [{ status: 'unavailable' }] });
  });
  it('uses the declared final review after correction rather than permanently vetoing an earlier rejection', () => {
    expect(evaluateCompletion(target('review_accepted'), 'succeeded', [evidence('earlier', { decision: 'rejected' }), evidence('target', { decision: 'accepted' })])).toMatchObject({ status: 'complete' });
  });
  it('exposes rule and model evaluation evidence methods separately', () => {
    const workflow = target('evaluate_passed'); const evaluate = workflow.nodes.find(node => node.type === 'evaluate')!;
    expect(evaluateCompletion(workflow, 'succeeded', [evidence('target', { passed: true })]).checks[0]?.method).toBe('rule_evaluation');
    evaluate.config.mode = 'model'; expect(evaluateCompletion(workflow, 'succeeded', [evidence('target', { passed: true })]).checks[0]?.method).toBe('model_evaluation');
  });
  it('never assesses an unfinished or unknown execution as complete', () => {
    for (const state of ['created', 'running', 'waiting', 'attention_required']) expect(evaluateCompletion(project(), state, []).status).toBe('unassessed');
    for (const state of ['failed', 'blocked', 'cancelled']) expect(evaluateCompletion(project(), state, [])).toMatchObject({ status: 'incomplete', reason: 'execution_incomplete' });
  });
  it('rejects empty successful outcome records and missing pinned identities', () => {
    const value: RunOutcome = { version: 1, status: 'complete', reason: 'criteria_satisfied', planHash: 'a'.repeat(64), criteriaHash: 'b'.repeat(64), resultHash: 'c'.repeat(64), assessedAt: '2026-10-28T00:00:00.000Z', checks: [] };
    expect(validateRunOutcome(value).valid).toBe(false);
    const workflow = project(); value.checks = evaluateCompletion(workflow, 'succeeded', [evidence(workflow.nodes.find(node => node.type === 'output')!.id, '완성 내용')]).checks;
    expect(validateRunOutcome(value).valid).toBe(true); expect(validateRunOutcome({ ...value, planHash: null }).valid).toBe(false);
    expect(validateRunOutcome({ ...value, status: 'incomplete', reason: 'criteria_not_satisfied' }).valid).toBe(false);
    expect(validateRunOutcome({ ...value, checks: value.checks.map(check => ({ ...check, method: 'human_review' })) }).valid).toBe(false);
    expect(validateRunOutcome({ ...value, status: 'unassessed', reason: 'execution_incomplete', checks: [], assessedAt: null, resultHash: null }).valid).toBe(false);
  });
});
