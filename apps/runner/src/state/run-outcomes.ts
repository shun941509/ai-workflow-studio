import type { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '@studio/package-kit';
import { parseStrictJson, validateCompletionDeclaration, validateRunOutcome, validateWorkflowShape, type RunOutcome } from '@studio/spec';
import { evaluateCompletion } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';

/** Additive v13 storage: old executions are not re-evaluated or promoted when the database is opened. */
export const RUN_OUTCOME_MIGRATION = `CREATE TABLE IF NOT EXISTS run_outcomes(run_id TEXT PRIMARY KEY REFERENCES runs(id),version INTEGER NOT NULL CHECK(version=1),body TEXT NOT NULL);`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digestOrNull = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

function unassessed(planHash: unknown, criteriaHash: string | null, reason: RunOutcome['reason']): RunOutcome {
  return { version: 1, status: 'unassessed', reason, planHash: digestOrNull(planHash), criteriaHash, resultHash: null, assessedAt: null, checks: [] };
}

/** Only the validated immutable plan supplies criteria; a result object's outcome/complete fields have no authority. */
function plannedOutcome(plan: unknown, planHash: unknown): RunOutcome {
  if (!object(plan) || !object(plan.workflow) || !Object.hasOwn(plan.workflow, 'completion')) return unassessed(planHash, null, 'criteria_missing');
  const checked = validateCompletionDeclaration(plan.workflow.completion);
  if (!checked.valid || !digestOrNull(planHash) || canonicalDigest(plan) !== planHash) return unassessed(planHash, null, 'outcome_record_invalid');
  return unassessed(planHash, canonicalDigest(checked.value), 'not_assessed');
}

/** Root keys have no slash; repeated local IDs in child scopes cannot impersonate designated final evidence. */
function rootEvidence(db: DatabaseSync, runId: string) {
  const records = db.prepare("SELECT id,node_id,status,result FROM node_instances WHERE run_id=? AND instr(node_id,'/')=0").all(runId) as Row[];
  return records.map(record => { const result = record.result === null ? null : parseStrictJson(String(record.result)); return { nodeId: String(record.node_id), nodeInstanceId: String(record.id), status: String(record.status), result, resultHash: result === null ? null : canonicalDigest(result) }; });
}

/** Called inside run creation's transaction; it records no assessment and performs no model/provider work. */
export function initializeRunOutcome(db: DatabaseSync, runId: string, plan: unknown, planHash: string): void {
  db.prepare('INSERT INTO run_outcomes(run_id,version,body) VALUES(?,1,?)').run(runId, JSON.stringify(plannedOutcome(plan, planHash)));
}

/** A missing/corrupt record safely reads as unassessed; successful legacy engine status never implies business success. */
export function readRunOutcome(db: DatabaseSync, runId: string, run: { planHash: string; status: string; result: unknown }): RunOutcome {
  const invalid = () => unassessed(run.planHash, null, 'outcome_record_invalid');
  try {
    const row = db.prepare('SELECT version,body FROM run_outcomes WHERE run_id=?').get(runId) as Row | undefined;
    const saved = db.prepare('SELECT body FROM plans WHERE hash=?').get(run.planHash) as Row | undefined;
    if (!saved) return invalid();
    const plan = parseStrictJson(String(saved.body)); const expected = plannedOutcome(plan, run.planHash);
    if (!row) return expected;
    if (row.version !== 1) return invalid();
    const checked = validateRunOutcome(parseStrictJson(String(row.body))); if (!checked.valid) return invalid();
    const outcome = checked.value;
    if (outcome.planHash !== expected.planHash || outcome.criteriaHash !== expected.criteriaHash) return invalid();
    if (outcome.status === 'unassessed') return canonicalDigest(outcome) === canonicalDigest(expected) ? outcome : invalid();
    if (!expected.criteriaHash || !object(plan) || !['succeeded', 'failed', 'blocked', 'cancelled'].includes(run.status)) return invalid();
    if (outcome.resultHash !== (run.result === null ? null : canonicalDigest(run.result))) return invalid();
    const workflow = validateWorkflowShape(plan.workflow); if (!workflow.valid) return invalid();
    // Only an existing assessment is checked. Recheck fixed JSON/protocol evidence, with no provider calls or legacy promotion.
    // This binds IDs/order/labels/methods and node instance/result hashes, not just the final run result hash.
    const assessment = evaluateCompletion(workflow.value, run.status, rootEvidence(db, runId));
    if (canonicalDigest(assessment) !== canonicalDigest({ status: outcome.status, reason: outcome.reason, checks: outcome.checks })) return invalid();
    return outcome;
  } catch { return invalid(); }
}

/** The caller owns BEGIN/COMMIT: engine terminal state, assessment, pinned evidence, and event commit together. */
export function finalizeRunOutcome(db: DatabaseSync, runId: string, event: (type: string, payload: unknown) => void): void {
  const row = db.prepare('SELECT r.status,r.result,r.plan_hash,p.body FROM runs r JOIN plans p ON p.hash=r.plan_hash WHERE r.id=?').get(runId) as Row | undefined;
  if (!row || !['succeeded', 'failed', 'blocked', 'cancelled'].includes(String(row.status))) return;
  const plan = parseStrictJson(String(row.body)); const base = plannedOutcome(plan, row.plan_hash);
  if (!base.criteriaHash) return;
  if (!object(plan)) throw new RunnerError('OUTCOME_PLAN_INVALID', '업무 판정의 고정 계획을 확인하지 못했습니다.');
  const workflow = validateWorkflowShape(plan.workflow); if (!workflow.valid) throw new RunnerError('OUTCOME_PLAN_INVALID', '업무 판정의 고정 설계를 확인하지 못했습니다.');
  const assessment = evaluateCompletion(workflow.value, String(row.status), rootEvidence(db, runId));
  const result = row.result === null ? null : parseStrictJson(String(row.result));
  const outcome: RunOutcome = { ...base, ...assessment, resultHash: result === null ? null : canonicalDigest(result), assessedAt: assessment.status === 'unassessed' ? null : new Date().toISOString() };
  const checked = validateRunOutcome(outcome); if (!checked.valid) throw new RunnerError('OUTCOME_INVALID', '업무 판정 결과를 기록하지 못했습니다.');
  db.prepare('INSERT INTO run_outcomes(run_id,version,body) VALUES(?,1,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(runId, JSON.stringify(outcome));
  event('outcome.assessed', { status: outcome.status, reason: outcome.reason, criteriaHash: outcome.criteriaHash, resultHash: outcome.resultHash });
}
