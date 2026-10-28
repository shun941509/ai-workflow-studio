import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createBasicWorkflow, createNode, type Binding, type FileRef, type Workflow, type WorkflowNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';
import { ModelError, type ModelProvider } from '../../apps/runner/src/providers/model-provider.js';
import { WindowsCredentialStore, type CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { createBridge } from '../../apps/runner/src/mcp/bridge.js';

const source = '비공개 배송 근거: 영업일 3일.';
const make = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const from = (nodeId: string, pointer = '/data'): Binding => ({ from: 'node', nodeId, pointer, onMissing: 'error' });
const literal = (value: string | never[]): Binding => ({ from: 'literal', value });
const edge = (a: string, b: string): WorkflowEdge => ({ id: `${a}_${b}`, from: { nodeId: a, port: 'next' }, to: { nodeId: b, port: 'in' } });

/** Actual values pass through transform, child scope, run memory and file output before an optional wait/model call. */
function project(options: { pause?: boolean; ai?: boolean; empty?: boolean } = {}): Workflow {
  const input = make('input', 'input'), files = make('file_input', 'files'), build = make('knowledge', 'build'), search = make('retrieval', 'search'), transform = make('transform', 'transform'), child = make('subworkflow', 'child'), memory = make('memory', 'memory'), file = make('file_output', 'export'), output = make('output', 'output');
  files.config = { mimeTypes: ['text/plain', 'application/pdf'], maxFiles: 100, maxBytesPerFile: 1000000 }; files.inputBindings = { files: literal([]) };
  build.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 0 } }; build.inputBindings = { documents: from('files') };
  search.config = { mode: 'keyword', topK: 3, maxContextTokens: 300 }; search.inputBindings = { index: from('build'), query: literal(options.empty ? 'unmatchedword' : '배송') };
  transform.config = { steps: [{ op: 'pick', options: { keys: ['context'] } }], resultSchema: true }; transform.inputBindings = { value: from('search') };
  const ci = make('input', 'input'), co = make('output', 'output'); co.inputBindings = { result: { from: 'workflowInput', pointer: '/context', onMissing: 'error' } };
  child.config.flowRef = { kind: 'local', flowId: 'pass' }; child.inputBindings = { input: from('transform') };
  memory.config = { operation: 'put', scope: 'run' }; memory.inputBindings = { key: literal('private'), value: from('child') };
  file.config = { format: 'text', filename: 'result.txt', outputDirectory: 'outputs' }; file.inputBindings = { content: from('memory', '/data/value') };
  const nodes: Workflow['nodes'] = [input, files, build, search, transform, child, memory, file];
  if (options.pause) { const pause = make('form', 'pause'); pause.config = { mode: 'request', title: '계속', schema: true }; pause.inputBindings = { context: from('child') }; nodes.push(pause); }
  if (options.ai) { const ai = make('ai', 'ai'); ai.config.modelProfile = 'chat'; ai.inputBindings = { content: from('memory', '/data/value') }; nodes.push(ai); }
  output.inputBindings = { result: from(options.ai ? 'ai' : 'child') }; nodes.push(output);
  return { ...createBasicWorkflow('권한 공개 경계'), inputs: true, outputs: true, entryNodeId: 'input', modelProfiles: options.ai ? { chat: { kind: 'chat', requiredFeatures: ['text'] } } : {}, nodes, edges: nodes.slice(0, -1).map((node, i) => edge(node.id, nodes[i + 1]!.id)), subworkflows: { pass: { entryNodeId: 'input', inputs: true, outputs: true, nodes: [ci, co], edges: [edge('input', 'output')] } } };
}
type Hook = () => void | Promise<void>;
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; server: ReturnType<typeof createLocalServer>; origin: string; bytes: Uint8Array; runId?: string; getHook?: Hook; countHook?: Hook; generateHook?: Hook; counts: number; generations: number; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> }; provider: ModelProvider }
const fixtures: Fixture[] = [];
async function setup(workflow = project(), host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-disclosure-run-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); let item: Fixture;
  const credentials: CredentialStore = { available: true, async get(id) { await item?.getHook?.(); return secrets.get(id)!; }, async has(id) { return secrets.has(id); }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  const provider: ModelProvider = { async countInputTokens() { item.counts++; await item.countHook?.(); return 2; }, async generate() { item.generations++; await item.generateHook?.(); return { text: '확인된 응답', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }; } };
  const service = new RunnerService(store, credentials, directory, provider); const server = createLocalServer(service, { bearerToken: 'disclosure-test-token' }); const { origin } = await server.listen();
  const model = await service.createProfile({ name: 'test', model: 'test-only', apiKey: 'test-no-real-key' }); const built = await buildPackage({ workflow, host }); const imported = await service.importPackage(built.bytes);
  item = { directory, store, service, server, origin, credentials, provider, bytes: built.bytes, counts: 0, generations: 0, request: { packageHandle: imported.packageHandle, requestId: randomUUID(), inputs: {}, modelBindings: workflow.modelProfiles.chat ? { chat: model.id } : {} } }; fixtures.push(item); return item;
}
async function begin(item: Fixture) { const start = await item.service.start(item.request); item.runId = start.runId; await item.service.waitForIdle(); return item.service.status(start.runId); }
async function fill(item: Fixture) { const run = await begin(item); const wait = run.waits[0]!; const file = item.service.uploadWaitFile(run.id, wait.id, 'file', 'private.txt', 'text/plain', new TextEncoder().encode(source)); item.service.respondWait(run.id, wait.id, { requestId: randomUUID(), response: [file] }); await item.service.waitForIdle(); return { run: item.service.status(run.id), file }; }
function access(item: Fixture, action: (db: SqliteRagStore, principal: ReturnType<RunRagLedger['principal']>) => void) { const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite')); const db = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); try { action(db, ledger.principal(item.runId!)); } finally { db.close(); ledger.close(); } }
function revoke(item: Fixture) { access(item, (db, principal) => { const old = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: old.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: old.documents.map(doc => ({ ...doc, tombstoned: true })) }); }); }
async function restart(item: Fixture) { await item.service.shutdown(); await item.server.close(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.store.recoverInterruptedRuns(); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); item.server = createLocalServer(item.service, { bearerToken: 'disclosure-test-token' }); item.origin = (await item.server.listen()).origin; await item.service.restoreWaitingRuns(); }
afterEach(async () => { vi.restoreAllMocks(); for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); if (dirname(resolve(item.directory)) !== resolve(tmpdir()) || !item.directory.includes('studio-disclosure-run-')) throw new Error('unsafe cleanup'); await rm(item.directory, { recursive: true, force: true }); } });

describe('run-wide RAG disclosure fences', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP denies result/event/file/list/cancel publication after copied data loses access', async host => {
    const item = await setup(project(), host); const { run, file } = await fill(item); expect(run.status, JSON.stringify(run.error)).toBe('succeeded'); expect(JSON.stringify(run.result)).toContain(source); expect(run.childScopes).toHaveLength(1); expect(run.files).toHaveLength(2); revoke(item);
    const status = item.service.status(run.id); expect(status).toMatchObject({ status: 'succeeded', result: null, disclosure: { allowed: false, code: 'RAG_DISCLOSURE_CHANGED' }, nodes: [], edges: [], waits: [], childScopes: [], files: [] });
    for (const endpoint of [`/api/runs/${run.id}/results`, `/api/runs/${run.id}/events`, `/api/runs/${run.id}/artifacts/${file.id}`, `/api/runs/${run.id}/artifacts/${run.files[1]!.reference.id}`]) { const response = await fetch(item.origin + endpoint, { headers: { authorization: 'Bearer disclosure-test-token' } }); expect(response.status).toBe(403); expect(await response.text()).not.toContain(source); }
    const history = await fetch(`${item.origin}/api/runs`, { headers: { authorization: 'Bearer disclosure-test-token' } }); expect(await history.json()).toMatchObject([{ result: null, disclosure: { allowed: false } }]); expect(item.service.cancel(run.id).result).toBeNull();
    await restart(item); expect(item.service.status(run.id).disclosure.allowed).toBe(false); expect(item.counts).toBe(0);
  });
  it.each(['credentials', 'count', 'generate'] as const)('checks current epoch around a normal chat call: %s', async point => {
    const item = await setup(project({ ai: true })); const hook = () => revoke(item); if (point === 'credentials') item.getHook = hook; else if (point === 'count') item.countHook = hook; else item.generateHook = hook;
    const { run } = await fill(item); expect(run.status).toBe('blocked'); expect(run.disclosure).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_CHANGED' }); expect(item.counts).toBe(point === 'credentials' ? 0 : 1); expect(item.generations).toBe(point === 'generate' ? 1 : 0); expect(run.usage).toMatchObject({ reservedTokens: 0, consumedTokens: point === 'generate' ? 4 : 0 });
  });
  it('preserves an unknown paid result when cancellation and revocation happen after dispatch', async () => {
    const item = await setup(project({ ai: true })); item.generateHook = () => { revoke(item); item.service.cancel(item.runId!); throw new ModelError('MODEL_NETWORK_ERROR', 'unknown', 'unknown'); };
    const { run } = await fill(item); expect(run.status).toBe('attention_required'); expect(run.disclosure.allowed).toBe(false); expect(run.usage.reservedTokens).toBeGreaterThan(0); const held = run.usage.reservedTokens; await restart(item); expect(item.service.status(run.id).usage.reservedTokens).toBe(held); expect(item.generations).toBe(1);
  });
  it('group withdrawal between count and generation blocks even when every document ACL stays identical', async () => {
    const item = await setup(project({ ai: true })); const waiting = await begin(item); const wait = waiting.waits[0]!; const file = item.service.uploadWaitFile(waiting.id, wait.id, 'source', 'source.txt', 'text/plain', new TextEncoder().encode(source));
    // The trusted authority exists before first observation, so initial registration must preserve its group-only grant.
    access(item, (db, principal) => { db.createScope(principal.scope); db.replaceAccess(principal.scope, { expectedEpoch: 1, subjects: [{ subjectId: principal.subjectId, groupIds: ['team'] }], documents: [{ documentId: file.id, revision: 1, tombstoned: false, allowedSubjects: [], allowedGroups: ['team'] }] }); });
    item.countHook = () => access(item, (db, principal) => { const old = db.readCurrent(principal.scope, principal.subjectId); db.replaceAccess(principal.scope, { expectedEpoch: old.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: old.documents }); expect(db.readCurrent(principal.scope, principal.subjectId).documents).toEqual(old.documents); });
    item.service.respondWait(waiting.id, wait.id, { requestId: randomUUID(), response: [file] }); await item.service.waitForIdle(); expect(item.service.status(waiting.id)).toMatchObject({ status: 'blocked', disclosure: { allowed: false } }); expect(item.counts).toBe(1); expect(item.generations).toBe(0);
  });
  it.each(['subject', 'unselected_tombstone'] as const)('preexisting %s denial never becomes an accepted first baseline', async mode => {
    const item = await setup(); const run = await begin(item); const wait = run.waits[0]!; const file = item.service.uploadWaitFile(run.id, wait.id, 'source', 'source.txt', 'text/plain', new TextEncoder().encode(source)); const unselected = item.service.uploadWaitFile(run.id, wait.id, 'other', 'other.pdf', 'application/pdf', new Uint8Array([0]));
    access(item, (db, principal) => { db.createScope(principal.scope); db.replaceAccess(principal.scope, { expectedEpoch: 1, subjects: mode === 'subject' ? [] : [{ subjectId: principal.subjectId, groupIds: [] }], documents: [{ documentId: unselected.id, revision: 1, tombstoned: true, allowedSubjects: [principal.subjectId], allowedGroups: [] }] }); });
    item.service.respondWait(run.id, wait.id, { requestId: 'selection', response: [file] }); await item.service.waitForIdle(); expect(item.service.status(run.id)).toMatchObject({ status: 'blocked', result: null, disclosure: { allowed: false, code: 'RAG_DISCLOSURE_CHANGED' } }); expect(() => item.service.readArtifact(run.id, file.id)).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_CHANGED' })); access(item, (db, principal) => expect(db.readCurrent(principal.scope, principal.subjectId).documents.find(doc => doc.documentId === unselected.id)?.tombstoned ?? true).toBe(true));
  });
  it('a model inside a local child uses the same root epoch rather than its own node identity', async () => {
    const workflow = project(); workflow.modelProfiles = { chat: { kind: 'chat', requiredFeatures: ['text'] } }; const ai = make('ai', 'nested'); ai.config.modelProfile = 'chat'; ai.inputBindings = { content: { from: 'workflowInput', pointer: '/context', onMissing: 'error' } }; const child = workflow.subworkflows.pass!; child.nodes.splice(1, 0, ai); child.nodes[2]!.inputBindings = { result: from('nested') }; child.edges = [edge('input', 'nested'), edge('nested', 'output')];
    const item = await setup(workflow); item.countHook = () => revoke(item); const { run } = await fill(item); expect(run.status).toBe('blocked'); expect(run.disclosure.allowed).toBe(false); expect(item.counts).toBe(1); expect(item.generations).toBe(0); expect(item.store.listChildScopes(run.id)).toHaveLength(1);
  });
  it('empty search still seals disclosure and a wait cannot publish or consume context after revocation', async () => {
    const item = await setup(project({ pause: true, empty: true })); const { run } = await fill(item); expect(run.status).toBe('waiting'); expect(item.store.getDisclosureState(run.id).state).toBe('pinned'); const wait = run.waits.find(value => value.nodeId === 'pause')!;
    revoke(item); expect(() => item.service.respondWait(run.id, wait.id, { requestId: 'denied', response: {} })).toThrow(expect.objectContaining({ code: 'RAG_DISCLOSURE_CHANGED' })); expect(item.store.getWait(wait.id).state).toBe('pending'); expect(item.service.status(run.id).waits).toEqual([]); await restart(item); expect(item.store.getWait(wait.id).state).toBe('pending'); expect(item.service.status(run.id).result).toBeNull();
  });
  it('does not retroactively authorize a legacy RAG result with absent disclosure metadata', async () => {
    const item = await setup(); const { run } = await fill(item); const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare('DELETE FROM run_disclosure WHERE run_id=?').run(run.id); db.close();
    expect(item.service.status(run.id)).toMatchObject({ result: null, disclosure: { allowed: false, code: 'RAG_DISCLOSURE_STATE_REQUIRED' } }); expect(() => item.service.results(run.id)).toThrow(expect.objectContaining({ status: 409 }));
  });
  it('a missing authority database after restart denies publication without creating a replacement', async () => {
    const item = await setup(); const { run } = await fill(item); await item.service.shutdown(); await item.server.close(); item.store.close(); await rename(join(item.directory, 'rag', 'generations.sqlite'), join(item.directory, 'rag', 'removed.sqlite'));
    item.store = new RunStore(join(item.directory, 'state.sqlite')); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); item.server = createLocalServer(item.service, { bearerToken: 'disclosure-test-token' }); item.origin = (await item.server.listen()).origin;
    expect(item.service.status(run.id).disclosure).toMatchObject({ allowed: false, code: 'RAG_DISCLOSURE_UNAVAILABLE' }); expect(existsSync(join(item.directory, 'rag', 'generations.sqlite'))).toBe(false);
  });
  it('large metadata inventory does not consume the 32-file/8MiB index limit or decode nonselected PDFs', async () => {
    const item = await setup(); const run = await begin(item); const wait = run.waits[0]!; const file = item.service.uploadWaitFile(run.id, wait.id, 'text', 'source.txt', 'text/plain', new TextEncoder().encode(source));
    for (let i = 0; i < 40; i++) item.service.uploadWaitFile(run.id, wait.id, `binary${i}`, `not-indexed${i}.pdf`, 'application/pdf', new Uint8Array(220000));
    item.service.respondWait(run.id, wait.id, { requestId: 'selection', response: [file] }); await item.service.waitForIdle(); expect(item.service.status(run.id).status).toBe('succeeded'); access(item, (db, principal) => expect(db.readCurrent(principal.scope, principal.subjectId).documents).toHaveLength(41));
  }, 60000);
  it('cannot add a newly created file to an index after the first pin', async () => {
    const workflow = project(); const build = make('knowledge', 'second'); build.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 0 } }; build.inputBindings = { documents: from('export', '/files') }; workflow.nodes.splice(-1, 0, build); workflow.edges = workflow.nodes.slice(0, -1).map((node, i) => edge(node.id, workflow.nodes[i + 1]!.id));
    const item = await setup(workflow); const { run } = await fill(item); expect(run.status).toBe('blocked'); expect(run.error?.code).toBe('RAG_DISCLOSURE_SEALED'); expect(item.store.getDisclosureState(run.id).state).toBe('pinned');
  });
  it('MCP status/cancel remain safe while results/events deny body access through the actual loopback server', async () => {
    const item = await setup(); const { run } = await fill(item); const directory = join(item.directory, 'package'); const pack = await inspectPackage(item.bytes);
    for (const [path, bytes] of pack.files) { const target = resolve(directory, path); if (!target.startsWith(resolve(directory) + '\\')) throw new Error('unsafe extraction'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    await writeFile(join(item.directory, 'discovery.json'), JSON.stringify({ instanceId: 'test', port: Number(new URL(item.origin).port), credentialRef: 'runner_bridge' })); vi.spyOn(WindowsCredentialStore.prototype, 'get').mockResolvedValue('disclosure-test-token');
    const bridge = await createBridge(directory, item.directory); type Transport = Parameters<typeof bridge.connect>[0]; const messages: Record<string, unknown>[] = []; let id = 0; const transport: Transport = { async start() {}, async close() {}, async send(message) { messages.push(message as unknown as Record<string, unknown>); } };
    const call = async (method: string, params: Record<string, unknown>) => { const request = ++id; transport.onmessage!({ jsonrpc: '2.0', id: request, method, params }); await vi.waitFor(() => expect(messages.some(message => message.id === request)).toBe(true)); return messages.find(message => message.id === request)!.result as { isError?: boolean; content: { text: string }[] }; };
    try { await bridge.connect(transport); await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); revoke(item); for (const name of ['studio.status', 'studio.cancel', 'studio.results', 'studio.events']) { const result = await call('tools/call', { name, arguments: { runId: run.id } }); expect(JSON.stringify(result)).not.toContain(source); if (name === 'studio.results' || name === 'studio.events') expect(result.isError).toBe(true); else expect(JSON.parse(result.content[0]!.text)).toMatchObject({ result: null, disclosure: { allowed: false } }); } } finally { await bridge.close(); }
  });
});
