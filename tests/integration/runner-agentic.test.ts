import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createBasicWorkflow, createNode, type Binding, type Workflow, type WorkflowNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { AGENTIC_CAPABILITIES, AGENTIC_CONTRACT } from '../../apps/runner/src/agentic/contracts.js';
import { ModelError, type ModelRequest, type ModelResponse } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';

const made: Fixture[] = [];
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const from = (nodeId: string): Binding => ({ from: 'node', nodeId, pointer: '/data', onMissing: 'error' });
const edge = (a: string, b: string): WorkflowEdge => ({ id: `${a}_${b}`, from: { nodeId: a, port: 'next' }, to: { nodeId: b, port: 'in' } });
function definition(pause = false): Workflow {
  const input = node('input', 'input'), file = node('file_input', 'files'), build = node('knowledge', 'build'), indexes = node('merge', 'indexes'), agent = node('agent', 'agent'), output = node('output', 'output');
  file.inputBindings = { files: { from: 'literal', value: [] } }; file.config = { mimeTypes: ['text/plain'], maxFiles: 2, maxBytesPerFile: 100000 };
  build.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 100, chunkOverlap: 0 } }; build.inputBindings = { documents: from('files') };
  indexes.config = { waitFor: 'all_active', combine: 'array', collision: 'error' }; indexes.inputBindings = { current: from('build') };
  agent.config = { strategy: 'agentic_rag', modelProfile: 'planner', instructions: '주어진 근거에 따라 답하세요.', toolAllowlist: [], maxSteps: 12, resultSchema: { type: 'string' }, retrievalPolicy: { maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000, onInsufficient: 'abstain' } }; agent.inputBindings = { task: { from: 'literal', value: '배송 기한을 알려주세요.' }, indexes: from('indexes') };
  const nodes: Workflow['nodes'] = [input, file, build, indexes]; if (pause) { const wait = node('form', 'pause'); wait.config = { mode: 'request', title: '계속', schema: true }; nodes.push(wait); } nodes.push(agent, output); output.inputBindings = { result: from('agent') };
  return { ...createBasicWorkflow('실제 제한된 Agentic RAG'), inputs: true, outputs: true, nodes, entryNodeId: 'input', edges: nodes.slice(0, -1).map((n, i) => edge(n.id, nodes[i + 1]!.id)), modelProfiles: { planner: { kind: 'chat', requiredFeatures: ['json_schema'] } } };
}

/** A real local child receives only the parent-built index list; root run identity and budgets remain unchanged. */
function nestedDefinition(): Workflow {
  const workflow = definition(); const agent = workflow.nodes.find(n => n.type === 'agent')!; const input = node('input', 'child_input'), output = node('output', 'child_output');
  agent.inputBindings.indexes = { from: 'workflowInput', pointer: '/data', onMissing: 'error' }; output.inputBindings = { result: from('agent') };
  workflow.subworkflows.research = { entryNodeId: input.id, inputs: true, outputs: true, nodes: [input, agent, output], edges: [edge(input.id, agent.id), edge(agent.id, output.id)] };
  const call = node('subworkflow', 'call'); call.config = { flowRef: { kind: 'local', flowId: 'research' } }; call.inputBindings = { input: { from: 'node', nodeId: 'indexes', pointer: '', onMissing: 'error' } };
  workflow.nodes.splice(workflow.nodes.findIndex(n => n.type === 'agent'), 1, call); workflow.nodes.find(n => n.type === 'output')!.inputBindings = { result: from('call') }; workflow.edges = workflow.nodes.slice(0, -1).map((n, i) => edge(n.id, workflow.nodes[i + 1]!.id)); return workflow;
}
type Decision = { action: string; queries: { index: string; query: string }[]; resultJson: string; evidenceIds: string[] };
const search = (query = '배송', index = 'i1'): Decision => ({ action: 'search', queries: [{ index, query }], resultJson: '', evidenceIds: [] });
const abstain = (): Decision => ({ action: 'abstain', queries: [], resultJson: '', evidenceIds: [] });
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; requests: ModelRequest[]; counts: number; hook?: (stage: 'count' | 'generate') => void | Promise<void>; response?: (request: ModelRequest, call: number) => Decision | ModelResponse; runId?: string; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> } }
async function fixture(workflow = definition(), host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-agentic-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); let item: Fixture;
  const credentials: CredentialStore = { available: true, async get(id) { return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const provider = { async countInputTokens() { item.counts++; await item.hook?.('count'); return 5; }, async generate(request: ModelRequest) { item.requests.push(request); await item.hook?.('generate'); const evidence = (request.content as { evidence: { id: string }[] }).evidence; const response = item.response?.(request, item.requests.length) ?? (evidence.length ? { action: 'answer', queries: [], resultJson: JSON.stringify('영업일 3일'), evidenceIds: [evidence[0]!.id] } : search()); return 'text' in response ? response : { model: request.model, text: JSON.stringify(response), usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } }; } };
  const service = new RunnerService(store, credentials, directory, provider);
  const profile = await service.createProfile({ name: 'Agentic test', model: AGENTIC_CONTRACT.model, apiKey: 'test-only-no-live-key' }); const pack = await buildPackage({ workflow, host }); const imported = await service.importPackage(pack.bytes);
  item = { directory, store, service, credentials, requests: [], counts: 0, request: { packageHandle: imported.packageHandle, requestId: randomUUID(), inputs: {}, modelBindings: { planner: profile.id } } }; made.push(item); return item;
}
async function start(item: Fixture, source = '배송 안내: 영업일 3일 이내입니다.') {
  const run = await item.service.start(item.request); item.runId = run.runId; await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
  const file = item.service.uploadWaitFile(run.runId, wait.id, 'source', 'policy.txt', 'text/plain', new TextEncoder().encode(source)); item.service.respondWait(run.runId, wait.id, { requestId: 'selected', response: [file] }); await item.service.waitForIdle(); return item.service.status(run.runId);
}
function revoke(item: Fixture) { const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite')); const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); try { const principal = ledger.principal(item.runId!); const old = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: old.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: old.documents.map(doc => ({ ...doc, tombstoned: true })) }); } finally { ledger.close(); db.close(); } }
afterEach(async () => { for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); if (dirname(resolve(item.directory)) !== resolve(tmpdir()) || !item.directory.includes('studio-agentic-')) throw new Error('unsafe cleanup'); await rm(item.directory, { recursive: true, force: true }); } });

describe('bounded actual Agentic RAG', () => {
  it.each(['answered', 'insufficient_evidence', 'conflicting_evidence'] as const)('assesses the explicit final Agentic %s protocol and withholds it after actual ACL revocation', async status => {
    const workflow = definition(); workflow.completion = { version: 1, criteria: [{ id: 'grounded', label: '최종 근거 답변', kind: 'agentic_answered', nodeId: 'agent' }] };
    const item = await fixture(workflow);
    if (status === 'insufficient_evidence') item.response = abstain;
    if (status === 'conflicting_evidence') item.response = (request, call) => call === 1 ? search() : { action: 'conflict', queries: [], resultJson: '', evidenceIds: (request.content as { evidence: { id: string }[] }).evidence.slice(0, 2).map(entry => entry.id) };
    const run = await start(item, '배송 안내: 영업일 3일. '.repeat(15));
    expect(run).toMatchObject({ status: 'succeeded', result: { data: { status } }, outcome: { status: status === 'answered' ? 'complete' : 'incomplete', checks: [{ method: 'agentic_protocol', reason: status === 'answered' ? 'satisfied' : status }] } });
    // This is the real RAG ACL mutation path, not a fabricated service denial or a generated outcome property.
    revoke(item); expect(item.service.status(run.id)).toMatchObject({ outcome: null, result: null, disclosure: { allowed: false } }); expect(() => item.service.results(run.id)).toThrow();
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP plans, searches real UTF-8 bytes and answers with verified evidence', async host => {
    const item = await fixture(definition(), host); expect(item.service.capabilities).toEqual(expect.arrayContaining([...AGENTIC_CAPABILITIES])); expect(item.service.capabilities).not.toContain('agentic_rag.ask@1'); const ready = await item.service.validate(item.request.packageHandle, item.request.modelBindings); expect(ready.issues).toEqual([]); const run = await start(item);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(run.result).toMatchObject({ data: { status: 'answered', result: '영업일 3일', usage: { steps: 3, queries: 1, rounds: 1 } } }); expect(run.usage).toMatchObject({ modelCalls: 2, consumedTokens: 30, reservedTokens: 0 });
    const state = item.store.agentic.get(run.id, 'agent'); expect(state.evidence[0]!.citation.quote).toContain('배송'); expect(state.evidence[0]!.citation.chunk.location.encoding).toBe('utf8'); expect(state.records).toHaveLength(3); expect(state.records.every(record => record.resultHash)).toBe(true);
    expect(JSON.stringify(item.service.events(run.id).filter(event => event.type.startsWith('agentic.')))).not.toContain('배송'); expect((await item.service.start(item.request)).runId).toBe(run.id); expect(item.requests).toHaveLength(2);
    const detail = await item.service.inspect(item.request.packageHandle); expect(detail.modelRequirements[0]).toMatchObject({ kind: 'chat', constraint: { contractId: AGENTIC_CONTRACT.id, model: AGENTIC_CONTRACT.model } });
  });
  it('rewrites an empty first query and keeps cumulative rounds, steps, chunks and context', async () => {
    const item = await fixture(); item.response = (request, call) => call === 1 ? search('없음') : call === 2 ? search('배송') : { action: 'answer', queries: [], resultJson: '"정책"', evidenceIds: [(request.content as { evidence: { id: string }[] }).evidence[0]!.id] };
    const run = await start(item); expect(run.result).toMatchObject({ data: { status: 'answered', usage: { rounds: 2, steps: 5, queries: 2 } } }); expect(item.store.agentic.get(run.id, 'agent').session.operations.filter(op => op.request.kind === 'query')[0]!.actualChunks).toBe(0);
  });
  it('deduplicates stable evidence when two real keyword queries reverse the same chunks while charging both searches', async () => {
    const item = await fixture(); item.response = (request, call) => call === 1 ? search('alpha') : call === 2 ? search('beta') : { action: 'answer', queries: [], resultJson: '"verified"', evidenceIds: (request.content as { evidence: { id: string }[] }).evidence.map(value => value.id) };
    const first = 'alpha '.repeat(12) + 'beta '.repeat(2) + 'x '.repeat(9); const second = 'alpha '.repeat(2) + 'beta '.repeat(12) + 'x '.repeat(14); expect(Buffer.byteLength(first)).toBe(100); expect(Buffer.byteLength(second)).toBe(100);
    const run = await start(item, first + second); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); const state = item.store.agentic.get(run.id, 'agent'); expect(state.evidence).toHaveLength(2); expect(state.evidence.every(value => value.citation.id === value.id)).toBe(true); expect(state.session.operations.filter(op => op.request.kind === 'query').map(op => op.actualChunks)).toEqual([2, 2]); expect(run.usage).toMatchObject({ modelCalls: 3, consumedTokens: 45, reservedTokens: 0 });
  });
  it('budget exhaustion is a bounded insufficient result, not a replay or invented answer', async () => {
    const workflow = definition(); const agent = workflow.nodes.find(n => n.type === 'agent')!; agent.config.maxSteps = 3; const item = await fixture(workflow); item.response = () => search('없는단어'); const run = await start(item);
    expect(run.result).toMatchObject({ data: { status: 'insufficient_evidence', result: null, stopReason: 'max_steps', usage: { steps: 3 } } }); expect(item.requests).toHaveLength(2);
  });
  it.each(['foreign_index', 'invented_evidence', 'unsupported_action', 'wrong_model', 'bad_result'] as const)('fails closed for %s', async invalid => {
    const item = await fixture(); item.response = (request, call) => {
      if (invalid === 'foreign_index') return search('배송', 'outside'); if (invalid === 'unsupported_action') return { ...abstain(), action: 'clarify' };
      if (invalid === 'wrong_model') return { model: 'other', text: JSON.stringify(abstain()), usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } };
      if (call === 1) return search(); return { action: 'answer', queries: [], resultJson: invalid === 'bad_result' ? '{}' : '"answer"', evidenceIds: invalid === 'invented_evidence' ? ['fake'] : [(request.content as { evidence: { id: string }[] }).evidence[0]!.id] };
    }; const run = await start(item); expect(run.status).toBe('failed'); expect(run.result).toBeNull(); expect(run.error?.code).toMatch(/^AGENTIC_/); expect(item.store.agentic.get(run.id, 'agent').status).toBe('failed');
  });
  it('holds unknown model usage and an unknown step across reopening without autostart', async () => {
    const item = await fixture(); item.response = () => ({ model: AGENTIC_CONTRACT.model, text: '{}', usage: null }); const run = await start(item); expect(run.status).toBe('attention_required'); expect(run.usage.reservedTokens).toBeGreaterThan(0); expect(item.store.agentic.get(run.id, 'agent').session.operations[0]!.status).toBe('unknown');
    await item.service.shutdown(); const reopened = new RunStore(join(item.directory, 'state.sqlite')); try { reopened.recoverInterruptedRuns(); expect(reopened.agentic.get(run.id, 'agent').status).toBe('attention_required'); expect(reopened.getRun(run.id).usage.reservedTokens).toBe(run.usage.reservedTokens); } finally { reopened.close(); } expect(item.requests).toHaveLength(1);
  });
  it.each(['count', 'generate'] as const)('epoch revocation during %s prevents later disclosure', async stage => {
    const item = await fixture(); item.hook = point => { if (point === stage) revoke(item); }; const run = await start(item); expect(run.disclosure.allowed).toBe(false); expect(run.result).toBeNull(); expect(item.requests).toHaveLength(stage === 'count' ? 0 : 1); expect(run.usage.reservedTokens).toBe(0);
  });
  it('count failure sends no generate and leaves a durable failed session', async () => {
    const item = await fixture(); item.hook = stage => { if (stage === 'count') throw new ModelError('MODEL_COUNT_UNAVAILABLE', 'test', 'not_started'); }; const run = await start(item); expect(run.status).toBe('failed'); expect(run.usage.modelCalls).toBe(0); expect(item.requests).toHaveLength(0); expect(item.store.agentic.get(run.id, 'agent').status).toBe('failed');
  });
  it('the shared run model-call budget stops a later decision after an already paid plan and local search', async () => {
    const workflow = definition(); workflow.policy.limits.maxModelCalls = 1; const item = await fixture(workflow); const run = await start(item); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('BUDGET_EXCEEDED'); expect(item.requests).toHaveLength(1); expect(run.usage).toMatchObject({ modelCalls: 1, consumedTokens: 15, reservedTokens: 0 });
  });
  it('a foreign run generation in the indexes binding is rejected before any model count', async () => {
    const first = await fixture(); const completed = await start(first); const foreign = (first.store.graphState(completed.id).nodes.find(n => n.nodeId === 'build')!.result as { data: unknown }).data;
    const workflow = definition(); workflow.nodes.find(n => n.type === 'agent')!.inputBindings.indexes = { from: 'workflowInput', pointer: '/indexes', onMissing: 'error' }; const second = await fixture(workflow); second.request.inputs = { indexes: [foreign] }; const run = await start(second); expect(run.status).toBe('failed'); expect(run.error?.code).toBe('RAG_RUN_SCOPE_DENIED'); expect(second.counts).toBe(0);
  });
  it('an explicit abstention succeeds without inventing evidence or performing a search', async () => {
    const item = await fixture(); item.response = abstain; const run = await start(item); expect(run.result).toMatchObject({ data: { status: 'insufficient_evidence', result: null, citations: [], usage: { steps: 1, queries: 0 } } });
  });
  it('conflict output preserves two verified evidence references without fabricating a resolved answer', async () => {
    const item = await fixture(); item.response = (request, call) => call === 1 ? search() : { action: 'conflict', queries: [], resultJson: '', evidenceIds: (request.content as { evidence: { id: string }[] }).evidence.slice(0, 2).map(item => item.id) };
    const run = await start(item, '배송 안내: 영업일 3일. '.repeat(15)); expect(run.result).toMatchObject({ data: { status: 'conflicting_evidence', result: null } }); expect((run.result as { data: { citations: unknown[] } }).data.citations).toHaveLength(2);
  });
  it('post-dispatch unknown cancellation takes precedence over cancellation and is never refunded', async () => {
    const item = await fixture(); item.hook = stage => { if (stage === 'generate') { item.service.cancel(item.runId!); throw new ModelError('MODEL_NETWORK_ERROR', 'unknown', 'unknown'); } }; const run = await start(item); expect(run.status).toBe('attention_required'); expect(run.usage.reservedTokens).toBeGreaterThan(0); expect(item.store.agentic.get(run.id, 'agent').status).toBe('attention_required');
  });
  it.each(['count', 'generate'] as const)('a confirmed cancellation during %s stops without creating an unknown paid outcome', async point => {
    const item = await fixture(); item.hook = stage => { if (stage === point) item.service.cancel(item.runId!); }; const run = await start(item); expect(run.status).toBe('cancelled'); expect(run.usage.reservedTokens).toBe(0); expect(run.usage.consumedTokens).toBe(point === 'count' ? 0 : 15); expect(item.requests).toHaveLength(point === 'count' ? 0 : 1); expect(item.store.agentic.get(run.id, 'agent').status).toBe('cancelled');
  });
  it('a local child shares the root generation, model budget and scoped durable Agentic identity', async () => {
    const item = await fixture(nestedDefinition()); const run = await start(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(run.usage.modelCalls).toBe(2); const child = item.store.listChildScopes(run.id)[0]!; expect(child.status).toBe('succeeded'); expect(item.store.agentic.get(run.id, `${child.id}/agent`).session.scope.projectId).toBe(run.id);
  });
  it('an uncertain Agentic journal remains attention_required through a child scope without replaying a confirmed paid call', async () => {
    const item = await fixture(nestedDefinition()); vi.spyOn(item.store.agentic, 'settle').mockImplementationOnce(() => { throw new Error('storage result uncertain'); }); const run = await start(item); expect(run.status).toBe('attention_required'); expect(run.error?.code).toBe('AGENTIC_RECONCILIATION_REQUIRED'); expect(item.store.listChildScopes(run.id)[0]!.status).toBe('attention_required'); expect(run.usage).toMatchObject({ modelCalls: 1, consumedTokens: 15, reservedTokens: 0 }); expect(item.requests).toHaveLength(1);
  });
  it('round and per-round query limits are enforced before dispatching additional local searches', async () => {
    const rounds = definition(); rounds.nodes.find(n => n.type === 'agent')!.config.retrievalPolicy!.maxRounds = 1; const first = await fixture(rounds); first.response = () => search('없는단어'); const run = await start(first); expect(run.result).toMatchObject({ data: { stopReason: 'max_rounds', usage: { rounds: 1, queries: 1 } } });
    const queries = definition(); queries.nodes.find(n => n.type === 'agent')!.config.retrievalPolicy!.maxQueriesPerRound = 1; const second = await fixture(queries); second.response = () => ({ ...search(), queries: [{ index: 'i1', query: '배송' }, { index: 'i1', query: '일정' }] }); const denied = await start(second); expect(denied.error?.code).toBe('AGENTIC_QUERY_LIMIT'); expect(second.store.agentic.get(denied.id, 'agent').session.round).toBe(0);
  });
  it('a model profile changed during a normal human wait cannot start an Agentic decision', async () => {
    const item = await fixture(definition(true)); const run = await start(item); const wait = run.waits.find(w => w.nodeId === 'pause')!; const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('UPDATE profiles SET model=? WHERE id=?').run('other', item.request.modelBindings.planner!); db.close();
    item.service.respondWait(run.id, wait.id, { requestId: 'resume', response: {} }); await item.service.waitForIdle(); expect(item.service.status(run.id).status).toBe('failed'); expect(item.requests).toHaveLength(0);
  });
  it('rejects ask, tool expansion, automatic retries and nonmatching chat profiles during readiness', async () => {
    const item = await fixture(); const other = await item.service.createProfile({ name: 'other', model: 'other-model', apiKey: 'test' }); expect((await item.service.validate(item.request.packageHandle, { planner: other.id })).ready).toBe(false);
    for (const mutation of ['ask', 'retry', 'steps'] as const) { const workflow = definition(); const agent = workflow.nodes.find(n => n.type === 'agent')!; if (mutation === 'ask') agent.config.retrievalPolicy!.onInsufficient = 'ask'; if (mutation === 'retry') agent.execution.retry.maxAttempts = 2; if (mutation === 'steps') agent.config.maxSteps = 33;
      if (mutation === 'ask') { agent.config.retrievalPolicy!.clarificationFlowRef = { kind: 'local', flowId: 'clarify' }; workflow.subworkflows.clarify = { entryNodeId: 'input', inputs: true, outputs: true, nodes: [node('input', 'input'), { ...node('output', 'output'), inputBindings: { result: { from: 'literal', value: null } } }], edges: [edge('input', 'output')] }; }
      const pkg = await item.service.importPackage((await buildPackage({ workflow, host: 'codex' })).bytes); expect((await item.service.validate(pkg.packageHandle, item.request.modelBindings)).ready).toBe(false);
    } expect(item.counts).toBe(0);
  });
});
