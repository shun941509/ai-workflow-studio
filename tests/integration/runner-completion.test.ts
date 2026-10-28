import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type WorkflowEdge, type Binding, type CompletionCriterion } from '@studio/spec';
import { buildPackage, inspectPackage, canonicalDigest, type TargetHost } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import type { ModelProvider } from '../../apps/runner/src/providers/model-provider.js';

const edge = (from: string, to: string, port = 'next'): WorkflowEdge => ({ id: `${from}_${port}_${to}`, from: { nodeId: from, port }, to: { nodeId: to, port: 'in' } });
const make = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const from = (nodeId: string): Binding => ({ from: 'node', nodeId, pointer: '/data', onMissing: 'error' });
const criteria = (): CompletionCriterion => ({ id: 'ready', label: '필수 내용 확인', kind: 'result_schema', schema: { type: 'object', properties: { ready: { const: true } }, required: ['ready'] } });
function simple(completion = true): Workflow {
  const input = make('input', 'input'), output = make('output', 'output'); output.inputBindings = { result: from('input') };
  return { ...createBasicWorkflow('업무 기준 검증'), inputs: true, outputs: true, entryNodeId: 'input', nodes: [input, output], edges: [edge('input', 'output')], modelProfiles: {}, ...(completion ? { completion: { version: 1, criteria: [criteria()] } } : {}) };
}
function reviews(corrected = false): Workflow {
  const workflow = simple(); const input = workflow.nodes[0]!, output = workflow.nodes[1]!; const middle: WorkflowNode[] = []; const edges: WorkflowEdge[] = []; let prior = 'input';
  for (const id of corrected ? ['first', 'final'] : ['final']) {
    const review = make('review', id), merge = make('merge', `${id}Merge`); review.config.responseSchema = true; review.inputBindings.value = from('input');
    merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = { selected: from(id) };
    middle.push(review, merge); edges.push(edge(prior, id), edge(id, merge.id, 'accepted'), edge(id, merge.id, 'rejected')); prior = merge.id;
  }
  output.inputBindings.result = from(prior); edges.push(edge(prior, 'output')); workflow.nodes = [input, output]; workflow.nodes.splice(1, 0, ...middle); workflow.edges = edges;
  workflow.completion = { version: 1, criteria: [{ id: 'finalReview', label: '최종 사용자 검토', kind: 'review_accepted', nodeId: 'final' }] }; return workflow;
}
function until(condition: boolean): Workflow {
  const workflow = simple(), loop = make('loop', 'loop'); loop.config = { mode: 'until', bodyFlowRef: { kind: 'local', flowId: 'body' }, maxIterations: 2, untilExpression: { literal: condition } }; loop.inputBindings.state = from('input');
  const child = simple(false); child.nodes[1]!.inputBindings.result = { from: 'workflowInput', pointer: '/state', onMissing: 'error' };
  workflow.subworkflows = { body: { inputs: true, outputs: true, entryNodeId: 'input', nodes: child.nodes, edges: child.edges } };
  workflow.nodes.splice(1, 0, loop); workflow.nodes[2]!.inputBindings.result = from('loop'); workflow.edges = [edge('input', 'loop'), edge('loop', 'output')];
  workflow.completion = { version: 1, criteria: [{ id: 'goal', label: '반복 목표 도달', kind: 'loop_condition_met', nodeId: 'loop' }] }; return workflow;
}
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; provider: ModelProvider; calls: number; handle: string }
const made: Fixture[] = [];
/** Real ZIP/SQLite/HTTP are used; any paid model or credential operation fails this local-only fixture. */
async function setup(workflow = simple(), host: TargetHost = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'studio-outcome-test-'));
  const credentials: CredentialStore = { available: false, async get() { throw new Error('No keys'); }, async set() { throw new Error('No keys'); }, async has() { return false; }, async delete() {} };
  const item = { directory, credentials, calls: 0, handle: '' } as Fixture;
  item.provider = { async countInputTokens() { item.calls++; throw new Error('No model calls'); }, async generate() { item.calls++; throw new Error('No model calls'); } };
  item.store = new RunStore(join(directory, 'state.sqlite')); item.service = new RunnerService(item.store, credentials, directory, item.provider); made.push(item);
  const built = await buildPackage({ workflow, host }); const inspected = await inspectPackage(built.bytes);
  expect(inspected.workflow).toEqual(workflow); if (workflow.completion) expect(inspected.manifest.requiredCapabilities).toContain('workflow.completion@1');
  item.handle = (await item.service.importPackage(built.bytes)).packageHandle; return item;
}
async function start(item: Fixture, inputs: unknown = { ready: true }, requestId = 'complete') { const run = await item.service.start({ packageHandle: item.handle, requestId, inputs, modelBindings: {} }); await item.service.waitForIdle(); return item.service.status(run.runId); }
async function restart(item: Fixture) { await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.store.recoverInterruptedRuns(); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); await item.service.restoreWaitingRuns(); }
afterEach(async () => { for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-outcome-test-')) throw new Error('Unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('durable business outcome alongside engine status', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves %s ZIP criteria, original output and one hash-bound assessment after restart', async host => {
    const item = await setup(simple(), host); const run = await start(item); const saved = item.store.getExecution(run.id);
    expect(run).toMatchObject({ status: 'succeeded', result: { data: { ready: true } }, outcome: { status: 'complete', planHash: saved.planHash, criteriaHash: canonicalDigest(simple().completion), resultHash: canonicalDigest(run.result), checks: [{ status: 'passed', source: { nodeId: 'output', nodeInstanceId: `${run.id}:output`, resultHash: canonicalDigest(run.result) } }] } });
    const outcome = run.outcome; expect(item.service.results(run.id).outcome).toEqual(outcome); expect(item.service.listRuns()[0]!.outcome).toEqual(outcome);
    await restart(item); expect(item.service.status(run.id).outcome).toEqual(outcome); expect((await start(item)).id).toBe(run.id); expect(item.service.events(run.id).filter(event => event.type === 'outcome.assessed')).toHaveLength(1); expect(item.calls).toBe(0);
  });
  it('keeps legacy runs unassessed despite generated outcome and passed fields', async () => {
    const item = await setup(simple(false)); const run = await start(item, { outcome: 'complete', passed: true });
    expect(run).toMatchObject({ status: 'succeeded', outcome: { status: 'unassessed', reason: 'criteria_missing', checks: [] } }); expect(item.service.events(run.id).some(event => event.type === 'outcome.assessed')).toBe(false);
  });
  it('preserves a schema-valid engine result while an explicit business criterion fails', async () => {
    const item = await setup(); expect(await start(item, { ready: false, outcome: 'complete' })).toMatchObject({ status: 'succeeded', result: { data: { ready: false, outcome: 'complete' } }, outcome: { status: 'incomplete', checks: [{ reason: 'schema_mismatch' }] } });
  });
  it.each(['accepted', 'rejected'] as const)('records the actual final %s review after a waiting restart', async decision => {
    const item = await setup(reviews()); const waiting = await start(item); expect(waiting.outcome?.status).toBe('unassessed'); const wait = waiting.waits[0]!;
    await restart(item); item.service.respondWait(waiting.id, wait.id, { requestId: 'final-response', response: {}, decision }); await item.service.waitForIdle();
    expect(item.service.status(waiting.id)).toMatchObject({ status: 'succeeded', outcome: { status: decision === 'accepted' ? 'complete' : 'incomplete', checks: [{ method: 'human_review', reason: decision === 'accepted' ? 'satisfied' : 'review_rejected' }] } });
  });
  it('uses a later designated acceptance after an earlier rejection without rewriting that earlier result', async () => {
    const item = await setup(reviews(true)); const waiting = await start(item); item.service.respondWait(waiting.id, waiting.waits[0]!.id, { requestId: 'first', response: {}, decision: 'rejected' }); await item.service.waitForIdle();
    const final = item.service.status(waiting.id).waits[0]!; item.service.respondWait(waiting.id, final.id, { requestId: 'final', response: {}, decision: 'accepted' }); await item.service.waitForIdle();
    const run = item.service.status(waiting.id); expect(run.outcome).toMatchObject({ status: 'complete', checks: [{ source: { nodeId: 'final' } }] }); expect(item.store.graphState(run.id).nodes.find(node => node.nodeId === 'first')?.result).toMatchObject({ data: { decision: 'rejected' } });
  });
  it.each([false, true])('distinguishes until limit from condition satisfaction (%s)', async met => {
    const item = await setup(until(met)); const run = await start(item); expect(run.status).toBe('succeeded'); expect(run.outcome).toMatchObject({ status: met ? 'complete' : 'incomplete', checks: [{ reason: met ? 'satisfied' : 'iteration_limit' }] });
  });
  it('records rules evaluation failure separately from successful execution', async () => {
    const workflow = simple(), evaluate = make('evaluate', 'evaluation'); evaluate.config.passRule = { literal: false }; evaluate.inputBindings.value = from('input'); workflow.nodes.splice(1, 0, evaluate); workflow.edges = [edge('input', 'evaluation'), edge('evaluation', 'output')]; workflow.completion = { version: 1, criteria: [{ id: 'rules', label: '필수 규칙', kind: 'evaluate_passed', nodeId: 'evaluation' }] };
    const run = await start(await setup(workflow)); expect(run).toMatchObject({ status: 'succeeded', outcome: { status: 'incomplete', checks: [{ method: 'rule_evaluation', reason: 'evaluation_failed' }] } });
  });
  it('persists incomplete on waiting cancellation without approving the pending review', async () => {
    const item = await setup(reviews()); const waiting = await start(item); const result = item.service.cancel(waiting.id); expect(result).toMatchObject({ status: 'cancelled', outcome: { status: 'incomplete', reason: 'execution_incomplete' } }); await restart(item); expect(item.service.status(waiting.id).outcome).toEqual(result.outcome);
  });
  it('safely migrates a v12 database and never fabricates an assessment for an old successful run', async () => {
    const item = await setup(simple(false)); const run = await start(item); await item.service.shutdown(); item.store.close();
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.exec('DROP TABLE working_contexts; DROP TABLE run_outcomes; DELETE FROM schema_migrations WHERE version>=13; INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(12,\'2026-10-28T00:00:00.000Z\');'); db.close();
    item.store = new RunStore(join(item.directory, 'state.sqlite')); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider);
    expect(item.service.status(run.id)).toMatchObject({ status: 'succeeded', outcome: { status: 'unassessed', reason: 'criteria_missing' } });
  });
  it('rejects corrupt completed records at read time rather than preserving a green completion badge', async () => {
    const item = await setup(); const run = await start(item); const db = new DatabaseSync(join(item.directory, 'state.sqlite'));
    db.prepare('UPDATE run_outcomes SET body=? WHERE run_id=?').run(JSON.stringify({ ...run.outcome, checks: [] }), run.id); db.close(); expect(item.service.status(run.id).outcome).toMatchObject({ status: 'unassessed', reason: 'outcome_record_invalid' });
  });
  it.each(['criteriaHash', 'criterionId', 'label', 'method', 'sourceNode', 'sourceInstance', 'sourceHash', 'nodeResult'] as const)('withholds a JSON-valid assessment whose %s no longer matches the pinned plan and evidence', async field => {
    const item = await setup(); const run = await start(item); const altered = structuredClone(run.outcome!); const check = altered.checks[0]!;
    if (field === 'criteriaHash') altered.criteriaHash = 'f'.repeat(64);
    else if (field === 'criterionId') check.criterionId = 'other';
    else if (field === 'label') check.label = '다른 업무 조건';
    else if (field === 'method') check.method = 'human_review';
    else if (field === 'sourceNode') check.source.nodeId = 'input';
    else if (field === 'sourceInstance') check.source.nodeInstanceId = `${run.id}:input`;
    else if (field === 'sourceHash') check.source.resultHash = 'f'.repeat(64);
    const db = new DatabaseSync(join(item.directory, 'state.sqlite'));
    if (field === 'nodeResult') db.prepare('UPDATE node_instances SET result=? WHERE run_id=? AND node_id=?').run(JSON.stringify({ data: { ready: false } }), run.id, 'output');
    else db.prepare('UPDATE run_outcomes SET body=? WHERE run_id=?').run(JSON.stringify(altered), run.id);
    db.close(); expect(item.service.status(run.id).outcome).toMatchObject({ status: 'unassessed', reason: 'outcome_record_invalid' }); expect(item.calls).toBe(0);
  });
  it('records expired review waits once and cannot turn a second expiry/cancel into another assessment', async () => {
    const item = await setup(reviews()); const waiting = await start(item); const wait = waiting.waits[0]!;
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('UPDATE waits SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', wait.id); db.close();
    expect(item.store.expireWait(wait.id)).toBe(true); expect(item.store.expireWait(wait.id)).toBe(false); item.service.cancel(waiting.id);
    const outcome = item.service.status(waiting.id).outcome; expect(outcome).toMatchObject({ status: 'incomplete', reason: 'execution_incomplete', checks: [] });
    await restart(item); expect(item.service.status(waiting.id).outcome).toEqual(outcome); expect(item.service.events(waiting.id).filter(event => event.type === 'outcome.assessed')).toHaveLength(1);
  });
  it('keeps an interrupted running execution unassessed and never replays the model to manufacture completion', async () => {
    const item = await setup(); const plan = { workflow: simple() }; const run = item.store.createRun({ requestId: 'interrupt', requestHash: 'interrupt', packageHandle: item.handle, planHash: canonicalDigest(plan), plan, inputs: {}, modelBindings: {}, nodeIds: ['input', 'output'], maxModelCalls: 1, maxTotalTokens: 100 });
    item.store.transitionRun(run.id, 'running'); await restart(item);
    expect(item.service.status(run.id)).toMatchObject({ status: 'attention_required', outcome: { status: 'unassessed', reason: 'not_assessed' } }); expect(item.calls).toBe(0); expect(item.service.events(run.id).some(event => event.type === 'outcome.assessed')).toBe(false);
  });
  it('rolls back the terminal engine update when its assessment cannot commit', async () => {
    const item = await setup(); const workflow = simple(), plan = { workflow }; const planHash = canonicalDigest(plan);
    const run = item.store.createRun({ requestId: 'atomic', requestHash: 'atomic', packageHandle: item.handle, planHash, plan, inputs: {}, modelBindings: {}, nodeIds: ['input', 'output'], maxModelCalls: 1, maxTotalTokens: 100 }); item.store.transitionRun(run.id, 'running'); item.store.transitionNode(run.id, 'output', 'succeeded', { data: { ready: true } });
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.exec("CREATE TRIGGER reject_outcome_update BEFORE UPDATE ON run_outcomes BEGIN SELECT RAISE(ABORT,'test-only rollback'); END;");
    expect(() => item.store.transitionRun(run.id, 'succeeded', { result: { data: { ready: true } } })).toThrow(); expect(item.store.getRun(run.id)).toMatchObject({ status: 'running', result: null, outcome: { status: 'unassessed' } }); expect(item.store.listEvents(run.id).some(event => event.type === 'run.succeeded')).toBe(false); db.exec('DROP TRIGGER reject_outcome_update'); db.close();
  });
  it('returns the same assessment over actual authenticated HTTP and removes it after disclosure denial', async () => {
    const item = await setup(); const run = await start(item); const server = createLocalServer(item.service, { bearerToken: 'test-only-outcome-token' }); const { origin } = await server.listen();
    try {
      const headers = { authorization: 'Bearer test-only-outcome-token' }; const status = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json(); const result = await (await fetch(`${origin}/api/runs/${run.id}/results`, { headers })).json(); expect(result.outcome).toEqual(status.outcome); expect(result.outcome.status).toBe('complete');
      item.store.blockDisclosure(run.id, 'RAG_DISCLOSURE_CHANGED'); const denied = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json(); expect(denied).toMatchObject({ status: 'succeeded', outcome: null, result: null, disclosure: { allowed: false } }); expect(item.service.listRuns()[0]?.outcome).toBeNull(); expect((await fetch(`${origin}/api/runs/${run.id}/results`, { headers })).status).toBe(403);
    } finally { await server.close(); }
  });
});
