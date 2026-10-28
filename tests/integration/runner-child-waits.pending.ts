import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type FlowDefinition, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService, type StartRequest } from '../../apps/runner/src/service.js';
import { RunStore, scopedKey } from '../../apps/runner/src/state/store.js';
import { ModelError, type ModelProvider } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

// Explicit pending suite: excluded from the default suite until the actual R10-A implementation is integrated.
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; provider: ModelProvider; request: StartRequest }
const made: Fixture[] = [];
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const edge = (source: string, target: string, port = 'next'): WorkflowEdge => ({ id: `${source}_${port}_${target}`, from: { nodeId: source, port }, to: { nodeId: target, port: 'in' } });
const from = (id: string) => ({ from: 'node' as const, nodeId: id, pointer: '/data', onMissing: 'error' as const });
function call(id = 'call', flowId = 'child') { const value = node('subworkflow', id); value.config.flowRef = { kind: 'local', flowId }; value.inputBindings.input = { from: 'workflowInput', pointer: '', onMissing: 'error' }; return value; }
function question() { const value = node('form', 'question'); value.config = { mode: 'request', title: '추가 입력', schema }; value.inputBindings.context = from('input'); return value; }
function ai(id: string) { const value = node('ai', id); value.inputBindings.content = { from: 'literal', value: id }; return value; }
function chain(work: WorkflowNode[]): FlowDefinition {
  const input = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = from(work.at(-1)?.id ?? 'input');
  const nodes = [input, ...work, output]; return { inputs: true, outputs: true, entryNodeId: 'input', nodes, edges: nodes.slice(0, -1).map((value, index) => edge(value.id, nodes[index + 1]!.id)) };
}
function project(child = chain([question()]), nested = false): Workflow {
  const workflow = formProject(); workflow.subworkflows = nested ? { child: chain([call('call', 'deep')]), deep: child } : { child };
  if (child.nodes.some(value => value.type === 'ai')) workflow.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } }; return workflow;
}
function reviewFlow(): FlowDefinition {
  const review = node('review', 'question'), accepted = node('transform', 'accepted'), rejected = node('transform', 'rejected'), merge = node('merge', 'merge');
  review.config = { question: '작업 결과가 적절한가요?', responseSchema: schema }; review.inputBindings.value = from('input');
  for (const branch of [accepted, rejected]) { branch.inputBindings.value = from('question'); branch.config = { steps: [{ op: 'pick', options: { keys: ['decision', 'feedback'] } }], resultSchema: true }; }
  merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings = { accepted: { ...from('accepted'), onMissing: 'omit' }, rejected: { ...from('rejected'), onMissing: 'omit' } };
  const result = chain([review, accepted, rejected, merge]); result.edges = [edge('input', 'question'), edge('question', 'accepted', 'accepted'), edge('question', 'rejected', 'rejected'), edge('accepted', 'merge'), edge('rejected', 'merge'), edge('merge', 'output')]; return result;
}
function fileFlow(): FlowDefinition {
  const selection = node('file_input', 'question'), copy = node('file_output', 'copy'); selection.config = { mimeTypes: ['text/plain'], maxFiles: 1, maxBytesPerFile: 1024 }; selection.inputBindings.files = { from: 'literal', value: [] };
  copy.config = { format: 'copy', filename: 'result.txt', outputDirectory: 'outputs' }; copy.inputBindings = { file: { ...from('question'), pointer: '/data/0' } }; return chain([selection, copy]);
}
function formProject(): Workflow {
  const entry = node('input', 'input'), call = node('subworkflow', 'call'), output = node('output', 'output');
  const childInput = node('input', 'input'), question = node('form', 'question'), childOutput = node('output', 'output');
  call.config.flowRef = { kind: 'local', flowId: 'child' }; call.inputBindings.input = { from: 'workflowInput', pointer: '', onMissing: 'error' };
  output.inputBindings.result = { from: 'node', nodeId: call.id, pointer: '/data', onMissing: 'error' };
  question.config = { mode: 'request', title: '하위 작업의 추가 입력', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
  question.inputBindings.context = { from: 'node', nodeId: childInput.id, pointer: '/data', onMissing: 'error' };
  childOutput.inputBindings.result = { from: 'node', nodeId: question.id, pointer: '/data', onMissing: 'error' };
  const edges = (nodes: WorkflowNode[]): FlowDefinition['edges'] => nodes.slice(0, -1).map((value, index) => ({ id: `edge_${index}`, from: { nodeId: value.id, port: 'next' }, to: { nodeId: nodes[index + 1]!.id, port: 'in' } }));
  const childNodes = [childInput, question, childOutput], nodes = [entry, call, output];
  return { ...createBasicWorkflow('하위 사용자 대기'), inputs: true, outputs: true, modelProfiles: {}, entryNodeId: entry.id, nodes, edges: edges(nodes), subworkflows: { child: { inputs: true, outputs: true, entryNodeId: childInput.id, nodes: childNodes, edges: edges(childNodes) } } };
}
const pure: ModelProvider = { async countInputTokens(): Promise<never> { throw new Error('Pure child waits cannot count model input'); }, async generate(): Promise<never> { throw new Error('Pure child waits cannot call a model'); } };
const modelResponse = () => ({ text: 'confirmed test boundary result', usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } });
/** Only provider/secret storage are test boundaries. SQLite, artifacts and service execution remain real. */
async function setup(workflow = formProject(), host: 'codex' | 'claude-code' | 'opencode' = 'codex', provider = pure): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-child-waits-')), store = new RunStore(join(directory, 'state.sqlite'));
  const secrets = new Map<string, string>(); const credentials: CredentialStore = { available: true, async has(id) { return secrets.has(id); }, async get(id) { return secrets.get(id)!; }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, provider), item: Fixture = { directory, store, service, credentials, provider, request: { packageHandle: '', requestId: 'child-wait-request', inputs: { instruction: '응답을 기다리세요' }, modelBindings: {} } }; made.push(item);
  if (Object.keys(workflow.modelProfiles).length) { const profile = await service.createProfile({ name: 'test only', model: 'contract-model', apiKey: 'fixed-test-only-key' }); item.request.modelBindings = Object.fromEntries(Object.keys(workflow.modelProfiles).map(alias => [alias, profile.id])); }
  const built = await buildPackage({ workflow, host }), imported = await service.importPackage(built.bytes); item.request.packageHandle = imported.packageHandle; return item;
}
async function startWaiting(item: Fixture) {
  const readiness = await item.service.validate(item.request.packageHandle, item.request.modelBindings); expect(readiness.issues.filter(issue => issue.severity === 'error')).toEqual([]);
  const run = await item.service.start(item.request); await item.service.waitForIdle(); const status = item.service.status(run.runId); expect(status.status).toBe('waiting'); expect(status.result).toBeNull(); expect(status.waits).toHaveLength(1); return status;
}
async function restart(item: Fixture) {
  await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); const recovered = item.store.recoverInterruptedRuns();
  item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); await item.service.restoreWaitingRuns(); return recovered;
}
function succeededEvents(item: Fixture, runId: string, nodeId: string) { return item.service.events(runId).filter(event => event.type === 'node.status' && (event.payload as { nodeId?: string; status?: string }).nodeId === nodeId && (event.payload as { status?: string }).status === 'succeeded'); }
afterEach(async () => { vi.restoreAllMocks(); for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-child-waits-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true }); } });

/** Real ZIP, SQLite and executor. No skip/expected-failure wrapper disguises unsupported execution as a passing feature. */
describe('R10-A pending child waits', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('single form wait from %s ZIP resumes its parent only after the user response', async host => {
    const item = await setup(formProject(), host); const readiness = await item.service.validate(item.request.packageHandle, {});
    expect(readiness.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const started = await item.service.start(item.request); await item.service.waitForIdle(); const waiting = item.service.status(started.runId);
    expect(waiting.status).toBe('waiting'); expect(waiting.result).toBeNull(); expect(waiting.waits).toHaveLength(1);
    expect(waiting.childScopes[0]!.status).toBe('waiting');
    item.service.respondWait(started.runId, waiting.waits[0]!.id, { requestId: 'child-answer', response: { answer: '확인했습니다' } }); await item.service.waitForIdle();
    expect(item.service.status(started.runId)).toMatchObject({ status: 'succeeded', result: { data: { answer: '확인했습니다' } }, usage: { modelCalls: 0, consumedTokens: 0, reservedTokens: 0 } });
  });

  it('nested form wait retains exact scopes despite repeated local node IDs', async () => {
    const item = await setup(project(chain([question()]), true)), waiting = await startWaiting(item), scopes = item.store.listChildScopes(waiting.id), wait = waiting.waits[0]!;
    expect(scopes.map(scope => scope.depth).sort()).toEqual([1, 2]); expect(scopes.every(scope => scope.status === 'waiting')).toBe(true); expect(wait.nodeId).toBe(`${scopes.find(scope => scope.depth === 2)!.id}/question`); expect(wait.nodeInstanceId).toBe(`${waiting.id}:${wait.nodeId}`);
    expect(waiting.nodes).toContainEqual({ nodeId: 'call', status: 'waiting_children' });
    item.service.respondWait(waiting.id, wait.id, { requestId: 'nested-answer', response: { answer: '중첩 답변' } }); await item.service.waitForIdle();
    expect(item.service.status(waiting.id)).toMatchObject({ status: 'succeeded', result: { data: { answer: '중첩 답변' } } }); expect(item.store.listChildScopes(waiting.id).map(scope => scope.id)).toEqual(scopes.map(scope => scope.id));
    for (const scope of scopes) expect(succeededEvents(item, waiting.id, `${scope.id}/input`)).toHaveLength(1); expect(succeededEvents(item, waiting.id, 'call')).toHaveLength(1);
  });

  it.each([false, true])('review acceptance/rejection remain business decisions with nested=%s', async nested => {
    for (const decision of ['accepted', 'rejected'] as const) {
      const item = await setup(project(reviewFlow(), nested)), waiting = await startWaiting(item), wait = waiting.waits[0]!, scopeId = wait.nodeId.split('/')[0]!;
      expect(wait.kind).toBe('review'); item.service.respondWait(waiting.id, wait.id, { requestId: 'review-answer', decision, response: { answer: '검토 의견' } }); await item.service.waitForIdle();
      const final = item.service.status(waiting.id); expect(final).toMatchObject({ status: 'succeeded', result: { data: { decision, feedback: { answer: '검토 의견' } } } });
      expect(item.store.graphState(waiting.id, scopeId).nodes).toContainEqual({ nodeId: decision === 'accepted' ? 'rejected' : 'accepted', status: 'skipped', result: null }); expect(final.result).not.toHaveProperty('effects');
    }
  });

  it.each((['codex', 'claude-code', 'opencode'] as const).flatMap(host => [false, true].map(nested => ({ host, nested }))))('$host file wait (nested=$nested) uploads and copies exact managed bytes', async ({ host, nested }) => {
    const item = await setup(project(fileFlow(), nested), host), waiting = await startWaiting(item), wait = waiting.waits[0]!, bytes = new TextEncoder().encode('원본 UTF-8 bytes\n');
    expect(wait.kind).toBe('files'); const reference = item.service.uploadWaitFile(waiting.id, wait.id, 'upload', 'source.txt', 'text/plain', bytes);
    expect(item.service.uploadWaitFile(waiting.id, wait.id, 'upload', 'source.txt', 'text/plain', bytes)).toEqual(reference);
    item.service.respondWait(waiting.id, wait.id, { requestId: 'file-answer', response: [reference] }); await item.service.waitForIdle(); const final = item.service.status(waiting.id);
    expect(final.status).toBe('succeeded'); expect(final.files).toHaveLength(2); expect(final.usage.modelCalls).toBe(0);
    for (const file of final.files) expect(Buffer.from(item.service.readArtifact(waiting.id, file.reference.id).bytes)).toEqual(Buffer.from(bytes)); expect(succeededEvents(item, waiting.id, wait.nodeId)).toHaveLength(1);
  });

  it('rejects changed references and cross-wait/cross-run uploads with matching local node IDs', async () => {
    const workflow = project(fileFlow()); Object.assign(workflow, chain([call('first'), call('second')])); const item = await setup(workflow), first = await startWaiting(item), firstWait = first.waits[0]!;
    const reference = item.service.uploadWaitFile(first.id, firstWait.id, 'first', 'source.txt', 'text/plain', new TextEncoder().encode('owned bytes'));
    expect(() => item.service.respondWait(first.id, firstWait.id, { requestId: 'tampered', response: [{ ...reference, sha256: '0'.repeat(64) }] })).toThrow();
    item.service.respondWait(first.id, firstWait.id, { requestId: 'first-answer', response: [reference] }); await item.service.waitForIdle(); const secondWait = item.service.status(first.id).waits[0]!;
    expect(secondWait.id).not.toBe(firstWait.id); expect(secondWait.nodeId).not.toBe(firstWait.nodeId); expect(secondWait.nodeId.endsWith('/question')).toBe(true);
    expect(() => item.service.respondWait(first.id, secondWait.id, { requestId: 'wrong-wait', response: [reference] })).toThrow();
    const other = await item.service.start({ ...item.request, requestId: 'other-run' }); await item.service.waitForIdle(); const otherWait = item.service.status(other.runId).waits[0]!;
    expect(() => item.service.respondWait(other.runId, otherWait.id, { requestId: 'wrong-run', response: [reference] })).toThrow(); expect(item.store.getWait(secondWait.id).state).toBe('pending'); expect(item.store.getWait(otherWait.id).state).toBe('pending');
  });

  it('deduplicates identical responses and rejects conflicting IDs or payloads', async () => {
    const item = await setup(), waiting = await startWaiting(item), wait = waiting.waits[0]!, reply = { requestId: 'same-response', response: { answer: '한 번만' } };
    const answers = await Promise.all([0, 1].map(() => Promise.resolve().then(() => item.service.respondWait(waiting.id, wait.id, reply)))); expect(answers[0]!.waitId).toBe(answers[1]!.waitId);
    expect(() => item.service.respondWait(waiting.id, wait.id, { ...reply, response: { answer: '변경' } })).toThrow(); expect(() => item.service.respondWait(waiting.id, wait.id, { ...reply, requestId: 'new-response' })).toThrow();
    await item.service.waitForIdle(); expect(item.store.getWait(wait.id).state).toBe('consumed'); expect(item.service.respondWait(waiting.id, wait.id, reply).state).toBe('consumed'); expect(succeededEvents(item, waiting.id, 'call')).toHaveLength(1);
  });

  it('rejects invalid answers and supplied scope/actor fields without consuming the wait', async () => {
    const item = await setup(), waiting = await startWaiting(item), wait = waiting.waits[0]!;
    for (const body of [{ requestId: 'invalid', response: { answer: 7 } }, { requestId: 'scope', response: { answer: 'yes' }, scopeId: 'main' }, { requestId: 'actor', response: { answer: 'yes' }, actor: 'administrator' }]) expect(() => item.service.respondWait(waiting.id, wait.id, body)).toThrow();
    expect(item.store.getWait(wait.id).state).toBe('pending'); expect(item.service.status(waiting.id).status).toBe('waiting');
  });

  it.each(['form', 'files'] as const)('cancels nested %s waiting and rejects later continuation', async kind => {
    const item = await setup(project(kind === 'files' ? fileFlow() : chain([question()]), true)), waiting = await startWaiting(item), wait = waiting.waits[0]!;
    expect(item.service.cancel(waiting.id).status).toBe('cancelled'); expect(item.store.getWait(wait.id).state).toBe('cancelled'); expect(item.store.listChildScopes(waiting.id).every(scope => scope.status === 'cancelled')).toBe(true);
    expect(() => item.service.respondWait(waiting.id, wait.id, { requestId: 'late', response: kind === 'files' ? [] : { answer: 'late' } })).toThrow();
    if (kind === 'files') expect(() => item.service.uploadWaitFile(waiting.id, wait.id, 'late', 'source.txt', 'text/plain', new Uint8Array())).toThrow();
    await restart(item); await item.service.waitForIdle(); expect(item.service.status(waiting.id)).toMatchObject({ status: 'cancelled', result: null });
  });

  it('expires nested waiting without auto-answering or leaving parents runnable', async () => {
    const item = await setup(project(chain([question()]), true)), waiting = await startWaiting(item), wait = waiting.waits[0]!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(wait.expiresAt) + 1); expect(item.store.expireWait(wait.id)).toBe(true);
    expect(item.service.status(waiting.id)).toMatchObject({ status: 'failed', result: null, error: { code: 'WAIT_EXPIRED' } }); expect(item.store.getWait(wait.id).state).toBe('expired');
    expect(item.store.listChildScopes(waiting.id).every(scope => !['running', 'waiting'].includes(scope.status))).toBe(true); expect(() => item.service.respondWait(waiting.id, wait.id, { requestId: 'late', response: { answer: 'late' } })).toThrow();
  });

  it.each([false, true])('reopens a pending or committed answer (committed=%s) without replaying earlier model work', async committed => {
    let calls = 0; const item = await setup(project(chain([ai('before'), question()]), true), 'codex', { async countInputTokens() { return 4; }, async generate() { calls++; return modelResponse(); } });
    const waiting = await startWaiting(item), wait = waiting.waits[0]!, scopeIds = waiting.childScopes.map(scope => scope.id), usage = waiting.usage;
    expect(calls).toBe(1); if (committed) item.store.acceptWaitResponse(waiting.id, wait.id, 'saved-answer', { answer: '저장된 답변' });
    expect(await restart(item)).toBe(0); await item.service.waitForIdle(); expect(calls).toBe(1);
    if (!committed) { const restored = item.service.status(waiting.id); expect(restored.waits[0]).toMatchObject({ id: wait.id, expiresAt: wait.expiresAt, nodeInstanceId: wait.nodeInstanceId }); expect(restored.usage).toEqual(usage); item.service.respondWait(waiting.id, wait.id, { requestId: 'restored-answer', response: { answer: '저장된 답변' } }); await item.service.waitForIdle(); }
    expect(item.service.status(waiting.id)).toMatchObject({ status: 'succeeded', result: { data: { answer: '저장된 답변' } }, usage }); expect(item.store.listChildScopes(waiting.id).map(scope => scope.id)).toEqual(scopeIds); expect(calls).toBe(1);
  });

  it('reopens an uploaded child file wait with original bytes and scope', async () => {
    const item = await setup(project(fileFlow(), true)), waiting = await startWaiting(item), wait = waiting.waits[0]!, bytes = new TextEncoder().encode('재시작 원본');
    const reference = item.service.uploadWaitFile(waiting.id, wait.id, 'saved-file', 'source.txt', 'text/plain', bytes); expect(await restart(item)).toBe(0);
    expect(item.service.status(waiting.id).waits[0]).toMatchObject({ id: wait.id, nodeId: wait.nodeId }); expect(Buffer.from(item.service.readArtifact(waiting.id, reference.id).bytes)).toEqual(Buffer.from(bytes));
    item.service.respondWait(waiting.id, wait.id, { requestId: 'after-restart', response: [reference] }); await item.service.waitForIdle(); expect(item.service.status(waiting.id).status).toBe('succeeded'); expect(succeededEvents(item, waiting.id, wait.nodeId)).toHaveLength(1);
  });

  it('excludes human waiting from root and nested parent timeout across restart', async () => {
    const workflow = project(chain([question()]), true); workflow.policy.limits.maxActiveMs = 1000; workflow.nodes.find(value => value.type === 'subworkflow')!.execution.timeoutMs = 1000; workflow.subworkflows.child!.nodes.find(value => value.type === 'subworkflow')!.execution.timeoutMs = 1000;
    const item = await setup(workflow), waiting = await startWaiting(item), wait = waiting.waits[0]!; await delay(1150); expect(item.service.status(waiting.id).activeMs).toBe(waiting.activeMs);
    expect(await restart(item)).toBe(0); item.service.respondWait(waiting.id, wait.id, { requestId: 'after-human-pause', response: { answer: '계속' } }); await item.service.waitForIdle();
    const final = item.service.status(waiting.id); expect(final.status).toBe('succeeded'); expect(final.activeMs).toBeLessThan(1000); expect(final.activeMs).toBeGreaterThanOrEqual(waiting.activeMs);
  });

  it('gives resumed counting only the parent timeout remaining after prior active work', async () => {
    let counts = 0, calls = 0; const workflow = project(chain([ai('before'), question(), ai('after')])); workflow.nodes.find(value => value.type === 'subworkflow')!.execution.timeoutMs = 1000;
    const item = await setup(workflow, 'codex', { async countInputTokens(_request, context) { counts++; await delay(650, undefined, { signal: context.signal }); return 4; }, async generate() { calls++; return modelResponse(); } });
    const waiting = await startWaiting(item); expect(calls).toBe(1); expect(await restart(item)).toBe(0);
    item.service.respondWait(waiting.id, waiting.waits[0]!.id, { requestId: 'remaining-budget', response: { answer: '계속' } }); await item.service.waitForIdle();
    expect(counts).toBe(2); expect(calls).toBe(1); expect(item.service.status(waiting.id)).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { modelCalls: 1, consumedTokens: 8, reservedTokens: 0 } });
  });

  it.each(['calls', 'tokens'] as const)('preserves root shared %s budget after a child response', async budget => {
    let calls = 0; const workflow = project(chain([ai('before'), question(), ai('after')])); if (budget === 'calls') workflow.policy.limits.maxModelCalls = 1; else workflow.policy.limits.maxTotalTokens = 1030;
    const item = await setup(workflow, 'codex', { async countInputTokens() { return 4; }, async generate() { calls++; return modelResponse(); } }), waiting = await startWaiting(item);
    item.service.respondWait(waiting.id, waiting.waits[0]!.id, { requestId: 'budget-response', response: { answer: '계속' } }); await item.service.waitForIdle(); expect(calls).toBe(1);
    expect(item.service.status(waiting.id)).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, usage: { modelCalls: 1, consumedTokens: 8, reservedTokens: 0 } });
  });

  it('does not charge existing node instances twice on resume', async () => {
    const workflow = project(); workflow.policy.limits.maxNodeInstances = 6; const item = await setup(workflow), waiting = await startWaiting(item);
    item.service.respondWait(waiting.id, waiting.waits[0]!.id, { requestId: 'exact-node-budget', response: { answer: '계속' } }); await item.service.waitForIdle(); expect(item.service.status(waiting.id).status).toBe('succeeded');
    expect(item.store.graphState(waiting.id).nodes).toHaveLength(3); expect(item.store.graphState(waiting.id, waiting.childScopes[0]!.id).nodes).toHaveLength(3);
  });

  it.each([false, true])('preserves unknown leaf reservations without replay after restart (cancel=%s)', async cancel => {
    let calls = 0, entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    const item = await setup(project(chain([question(), ai('after')]), true), 'codex', { async countInputTokens() { return 4; }, async generate(_request, context) { calls++; entered(); if (cancel) await new Promise<void>(done => { if (context.signal.aborted) done(); else context.signal.addEventListener('abort', () => done(), { once: true }); }); throw new ModelError('MODEL_NETWORK_ERROR', 'Sent request outcome is unknown', 'unknown'); } });
    const waiting = await startWaiting(item), wait = waiting.waits[0]!; item.service.respondWait(waiting.id, wait.id, { requestId: 'continue-to-unknown', response: { answer: '계속' } }); await started; if (cancel) item.service.cancel(waiting.id); await item.service.waitForIdle();
    const final = item.service.status(waiting.id); expect(final.status).toBe('attention_required'); expect(final.result).toBeNull(); expect(final.usage.reservedTokens).toBeGreaterThan(0); expect(calls).toBe(1);
    await restart(item); await item.service.waitForIdle(); expect(item.service.status(waiting.id)).toMatchObject({ status: 'attention_required', usage: final.usage }); expect(calls).toBe(1);
  });

  it('does not treat an interrupted leaf under waiting_children as a safe user wait', async () => {
    const workflow = project(chain([ai('after')])); let calls = 0; const item = await setup(workflow, 'codex', { async countInputTokens() { return 4; }, async generate() { calls++; return modelResponse(); } });
    // This fixture models a durable interrupted operation, without killing a real provider process or sending paid traffic.
    const run = item.store.createRun({ requestId: 'interrupted', requestHash: 'interrupted', packageHandle: item.request.packageHandle, planHash: 'c'.repeat(64), plan: {}, inputs: {}, modelBindings: {}, nodeIds: ['call'], edges: [], maxModelCalls: 10, maxTotalTokens: 10000 }); item.store.transitionRun(run.id, 'running');
    const scope = item.store.createChildScope({ runId: run.id, parentScopeId: 'main', ownerNodeId: 'call', key: 'call', flowId: 'child', depth: 1, flow: workflow.subworkflows.child!, input: {} }); const leaf = scopedKey(scope.id, 'after');
    item.store.transitionNode(run.id, 'call', 'waiting_children'); item.store.transitionNode(run.id, leaf, 'running'); item.store.beginAttempt(run.id, leaf); item.store.reserveModel(run.id, leaf, 1028);
    expect(await restart(item)).toBe(1); await item.service.waitForIdle(); expect(item.service.status(run.id)).toMatchObject({ status: 'attention_required', result: null, usage: { modelCalls: 1, consumedTokens: 0, reservedTokens: 1028 } }); expect(item.store.getChildScope(scope.id).status).toBe('attention_required'); expect(calls).toBe(0);
  });

  it('answers nested waiting through the cookie/CSRF route and refuses the MCP bearer', async () => {
    const item = await setup(project(chain([question()]), true)), waiting = await startWaiting(item), wait = waiting.waits[0]!, server = createLocalServer(item.service, { bearerToken: 'test-only-child-token' }); const { origin } = await server.listen();
    try {
      const path = `${origin}/api/runs/${waiting.id}/waits/${wait.id}/responses`, body = JSON.stringify({ requestId: 'browser-answer', response: { answer: '사용자 답변' } });
      expect((await fetch(path, { method: 'POST', headers: { authorization: 'Bearer test-only-child-token', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body })).status).toBe(403);
      const bootstrap = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-studio-client': 'local-ui', 'content-type': 'application/json' }, body: '{}' }); const { csrf } = await bootstrap.json() as { csrf: string }; const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
      expect((await fetch(path, { method: 'POST', headers: { cookie, 'x-studio-csrf': csrf, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body })).status).toBe(202); await item.service.waitForIdle(); expect(item.service.status(waiting.id).status).toBe('succeeded');
    } finally { await server.close(); }
  });

  it('keeps an indirect parallel-to-wait call blocked until the separate R10-B implementation', async () => {
    const workflow = project(chain([question()]), true), parallel = node('parallel', 'parallel'); parallel.config.branches = [{ id: 'one', flowRef: { kind: 'local', flowId: 'child' } }]; parallel.inputBindings.branches = { from: 'literal', value: { one: {} } }; Object.assign(workflow, chain([parallel]));
    const item = await setup(workflow), readiness = await item.service.validate(item.request.packageHandle, {}); expect(readiness.ready).toBe(false); expect(readiness.issues.map(issue => issue.code)).toContain('CHILD_WAIT_CALLER_UNSUPPORTED');
    await expect(item.service.start(item.request)).rejects.toThrow(); expect(item.store.listRuns()).toHaveLength(0);
  });
});
