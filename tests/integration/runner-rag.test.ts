// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createBasicWorkflow, createNode, type Binding, type FileRef, type Workflow, type WorkflowEdge, type WorkflowNode } from '@studio/spec';
import { buildPackage, canonicalDigest } from '@studio/package-kit';
import type { IndexRef } from '@studio/rag-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { RunRagRuntime } from '../../apps/runner/src/rag/run-runtime.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { RUN_KEYWORD_PROFILE, chunkUtf8 } from '../../apps/runner/src/rag/run-contract.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';
import { buildRunRagContext } from '../../apps/runner/src/rag/context-tokenizer.js';

const makeNode = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
const from = (nodeId: string, pointer = '/data'): Binding => ({ from: 'node', nodeId, pointer, onMissing: 'error' });
const utf8 = (value: string) => new TextEncoder().encode(value);
const source = '서울 배송 정책입니다. 배송은 영업일 3일 이내입니다.\n부산 주문도 배송 확인이 가능합니다.';

/** These workflows contain real file-selection/build/search nodes and use no model or packaged fixture result. */
function project(options: { pause?: boolean; noSearch?: boolean } = {}): Workflow {
  const input = makeNode('input', 'input'), files = makeNode('file_input', 'files'), build = makeNode('knowledge', 'build'), open = makeNode('knowledge', 'open'), search = makeNode('retrieval', 'search'), output = makeNode('output', 'output');
  files.config = { mimeTypes: ['text/plain', 'text/markdown', 'application/json', 'application/pdf'], maxFiles: 32, maxBytesPerFile: 3 * 1024 * 1024 }; files.inputBindings = { files: { from: 'literal', value: [] } };
  build.config = { operation: 'build', profile: RUN_KEYWORD_PROFILE, indexSettings: { kind: 'keyword', chunkSize: 100, chunkOverlap: 12 } }; build.inputBindings = { documents: from('files') };
  open.config = { operation: 'open' }; open.inputBindings = { index: from('build') };
  search.config = { mode: 'keyword', topK: 5, maxContextTokens: 300 }; search.inputBindings = { index: from('open'), query: { from: 'literal', value: '배송' } };
  output.inputBindings = { result: from(options.noSearch ? 'open' : 'search') };
  const nodes: Workflow['nodes'] = [input, files, build];
  if (options.pause) { const pause = makeNode('form', 'pause'); pause.config = { mode: 'request', title: '색인 검색 계속', schema: true }; pause.inputBindings = {}; nodes.push(pause); }
  nodes.push(open, ...(options.noSearch ? [] : [search]), output);
  return { ...createBasicWorkflow('실행별 문서 검색'), inputs: true, outputs: true, modelProfiles: {}, entryNodeId: 'input', nodes, edges: nodes.slice(0, -1).map((node, index) => edge(node.id, nodes[index + 1]!.id)) };
}

const provider = { async countInputTokens(): Promise<never> { throw new Error('Pure workflows cannot request model token counts'); }, async generate(): Promise<never> { throw new Error('RAG keyword workflows must not call a model'); } };
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; server: ReturnType<typeof createLocalServer>; origin: string; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> } }
const fixtures: Fixture[] = [];
async function setup(definition = project(), host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-rag-run-')); const store = new RunStore(join(directory, 'state.sqlite'));
  const credentials: CredentialStore = { available: false, async get() { throw new Error('no credentials'); }, async set() { throw new Error('no credentials'); }, async has() { return false; }, async delete() {} };
  const service = new RunnerService(store, credentials, directory, provider);
  const server = createLocalServer(service, { bearerToken: 'test-rag-token' }); const { origin } = await server.listen();
  const built = await buildPackage({ workflow: definition, host }); const imported = await service.importPackage(built.bytes);
  const item = { directory, store, service, credentials, server, origin, request: { packageHandle: imported.packageHandle, requestId: `request_${randomUUID()}`, inputs: {}, modelBindings: {} } }; fixtures.push(item); return item;
}
async function start(item: Fixture) { const run = await item.service.start(item.request); await item.service.waitForIdle(); return item.service.status(run.runId); }
async function browser(item: Fixture) {
  const response = await fetch(`${item.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin: item.origin, 'sec-fetch-site': 'same-origin' }, body: '{}' });
  const body = await response.json() as { csrf: string }; return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-studio-csrf': body.csrf, origin: item.origin, 'sec-fetch-site': 'same-origin' };
}
async function upload(item: Fixture, runId: string, waitId: string, bytes = utf8(source), filename = '정책.txt', mimeType = 'text/plain'): Promise<FileRef> {
  const response = await fetch(`${item.origin}/api/runs/${runId}/waits/${waitId}/files`, { method: 'POST', headers: { ...await browser(item), 'content-type': 'application/octet-stream', 'x-studio-filename': encodeURIComponent(filename), 'x-studio-mime-type': mimeType, 'x-studio-upload-id': canonicalDigest(filename) }, body: bytes });
  expect(response.status).toBe(201); return await response.json() as FileRef;
}
async function select(item: Fixture, runId: string, waitId: string, references: FileRef[]) { item.service.respondWait(runId, waitId, { requestId: 'selection-response', response: references }); await item.service.waitForIdle(); return item.service.status(runId); }
function indexOf(item: Fixture, runId: string): IndexRef { return (item.store.graphState(runId).nodes.find(node => node.nodeId === 'build')!.result as { data: IndexRef }).data; }
function runtime(item: Fixture) {
  return new RunRagRuntime(join(item.directory, 'rag'), (runId, value) => { const file = item.service.readArtifact(runId, (value as FileRef).id); if (canonicalDigest(file.reference) !== canonicalDigest(value)) throw new Error('forged reference'); return file; }, buildRunRagContext);
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-rag-run-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); }
});

describe('real managed files to run-local keyword search', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s production ZIP builds and searches actual uploaded UTF-8 bytes without a model', async host => {
    const item = await setup(project(), host); expect((await item.service.validate(item.request.packageHandle, {})).ready).toBe(true);
    expect(existsSync(join(item.directory, 'rag'))).toBe(false); const waiting = await start(item); expect(waiting.status).toBe('waiting'); expect(existsSync(join(item.directory, 'rag'))).toBe(false);
    const wait = waiting.waits[0]!; const reference = await upload(item, waiting.id, wait.id); const completed = await select(item, waiting.id, wait.id, [reference]);
    expect(completed.status).toBe('succeeded'); expect(completed.usage.modelCalls).toBe(0);
    const data = (completed.result as { data: { context: string; citations: { quote: string; chunk: { document: { originalSha256: string }; location: { encoding: string; start: number; end: number } } }[]; contextBudget: { tokenCount: number; tokenizerFingerprint: string } } }).data;
    expect(data.context).toContain('배송'); expect(data.citations.length).toBeGreaterThan(0); expect(data.contextBudget.tokenCount).toBeLessThanOrEqual(300); expect(data.contextBudget.tokenizerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const citation of data.citations) { expect(citation.chunk.document.originalSha256).toBe(reference.sha256); expect(citation.chunk.location.encoding).toBe('utf8'); expect(utf8(citation.quote)).toEqual(utf8(source).slice(citation.chunk.location.start, citation.chunk.location.end)); }
    const ref = indexOf(item, completed.id); expect(ref.scope.projectId).toBe(completed.id); expect(ref.scope.tenantId).toMatch(/^installation_/); expect(ref.scope.projectId).not.toBe(project().id);
    const repeat = await item.service.start(item.request); expect(repeat.runId).toBe(completed.id); expect(item.service.status(completed.id).usage.modelCalls).toBe(0);
  });

  it('preserves Markdown/JSON original bytes including a UTF-8 BOM and real Unicode chunk boundaries', async () => {
    const item = await setup(); const waiting = await start(item); const wait = waiting.waits[0]!;
    const markdown = '\uFEFF# 배송\n한글😀 배송 안내입니다.'; const json = '{"배송":"서울 배송 확인"}';
    const files = [await upload(item, waiting.id, wait.id, utf8(markdown), '정책.md', 'text/markdown'), await upload(item, waiting.id, wait.id, utf8(json), '설정.json', 'application/json')];
    const completed = await select(item, waiting.id, wait.id, files); expect(completed.status, JSON.stringify(completed.error)).toBe('succeeded');
    const store = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite'));
    try { const ref = indexOf(item, completed.id); const bundle = await store.loadGeneration(ref.scope, ref); expect(bundle.corpus.chunks.map(chunk => chunk.text)).toContain(markdown); expect(bundle.corpus.chunks.map(chunk => chunk.text)).toContain(json); } finally { store.close(); }
    const bytes = utf8('가😀'.repeat(100)); for (const range of chunkUtf8(bytes, 100, 99)) expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(range.start, range.end))).not.toThrow();
  });

  it.each([
    { bytes: new Uint8Array([0xc3, 0x28]), name: 'bad.txt', mime: 'text/plain', code: 'RAG_TEXT_ENCODING' },
    { bytes: utf8('binary\u0000data'), name: 'bad.txt', mime: 'text/plain', code: 'RAG_TEXT_ENCODING' },
    { bytes: utf8('{"x":1,"x":2}'), name: 'bad.json', mime: 'application/json', code: 'RAG_JSON_INVALID' },
    { bytes: utf8('%PDF-1.7'), name: 'document.pdf', mime: 'application/pdf', code: 'RAG_FILE_FORMAT_UNSUPPORTED' },
  ])('rejects unsupported or invalid source bytes: $code', async entry => {
    const item = await setup(); const waiting = await start(item); const wait = waiting.waits[0]!; const file = await upload(item, waiting.id, wait.id, entry.bytes, entry.name, entry.mime); const completed = await select(item, waiting.id, wait.id, [file]);
    expect(completed.status).toBe('failed'); expect(completed.error?.code).toBe(entry.code); expect(item.store.graphState(completed.id).nodes.find(node => node.nodeId === 'search')?.status).toBe('blocked');
  });

  it('restores a completed build at a durable human wait and never automatically restarts search', async () => {
    const item = await setup(project({ pause: true })); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); const paused = await select(item, waiting.id, waiting.waits[0]!.id, [file]);
    expect(paused.status).toBe('waiting'); const ref = indexOf(item, paused.id); const prompt = paused.waits.find(wait => wait.nodeId === 'pause')!;
    await item.service.shutdown(); await item.server.close(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); expect(item.store.recoverInterruptedRuns()).toBe(0);
    item.service = new RunnerService(item.store, item.credentials, item.directory, provider, buildRunRagContext); item.server = createLocalServer(item.service, { bearerToken: 'test-rag-token' }); item.origin = (await item.server.listen()).origin; await item.service.restoreWaitingRuns();
    expect(item.service.status(paused.id).status).toBe('waiting'); expect(indexOf(item, paused.id)).toEqual(ref); expect(item.store.graphState(paused.id).nodes.find(node => node.nodeId === 'search')?.status).toBe('pending');
    item.service.respondWait(paused.id, prompt.id, { requestId: 'continue', response: true }); await item.service.waitForIdle(); expect(item.service.status(paused.id).status).toBe('succeeded');
    const raw = new DatabaseSync(join(item.directory, 'rag', 'operations.sqlite')); try { expect(raw.prepare("SELECT COUNT(*) AS count FROM operations WHERE kind='build'").get()?.count).toBe(1); } finally { raw.close(); }
  });

  it('rejects a prior run index even when workflow IDs and package contents are identical', async () => {
    const item = await setup(); const first = await start(item); const file = await upload(item, first.id, first.waits[0]!.id); const done = await select(item, first.id, first.waits[0]!.id, [file]); const ref = indexOf(item, done.id);
    const definition = project({ noSearch: true }); definition.nodes = definition.nodes.filter(node => ['input', 'open', 'output'].includes(node.id)) as Workflow['nodes']; const open = definition.nodes.find(node => node.id === 'open')!; open.inputBindings.index = { from: 'workflowInput', pointer: '/index', onMissing: 'error' }; definition.edges = [edge('input', 'open'), edge('open', 'output')];
    const imported = await item.service.importPackage((await buildPackage({ workflow: definition, host: 'codex' })).bytes); const second = await item.service.start({ ...item.request, packageHandle: imported.packageHandle, requestId: 'other-run', inputs: { index: ref } }); await item.service.waitForIdle();
    expect(item.service.status(second.runId)).toMatchObject({ status: 'failed', error: { code: 'RAG_RUN_SCOPE_DENIED' } });
  });

  it('refuses another run file and an altered current-run FileRef instead of trusting its relative path', async () => {
    const item = await setup(); const first = await start(item); const file = await upload(item, first.id, first.waits[0]!.id); await select(item, first.id, first.waits[0]!.id, [file]);
    const definition = project({ noSearch: true }); definition.nodes = definition.nodes.filter(node => node.id !== 'files') as Workflow['nodes']; definition.nodes.find(node => node.id === 'build')!.inputBindings.documents = { from: 'workflowInput', pointer: '/documents', onMissing: 'error' }; definition.edges = [edge('input', 'build'), edge('build', 'open'), edge('open', 'output')];
    const imported = await item.service.importPackage((await buildPackage({ workflow: definition, host: 'codex' })).bytes); const second = await item.service.start({ ...item.request, packageHandle: imported.packageHandle, requestId: 'borrow-file', inputs: { documents: [file] } }); await item.service.waitForIdle(); expect(item.service.status(second.runId).status).toBe('failed');
    const other = await setup(project({ noSearch: true })); const current = await start(other); const chosen = await upload(other, current.id, current.waits[0]!.id); const local = runtime(other);
    try { await expect(local.execute(current.id, 'forged', project().nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>, { documents: [{ ...chosen, relativePath: 'C:/private.txt' }] }, { signal: new AbortController().signal, checkpoint() {} })).rejects.toThrow(); } finally { local.close(); }
  });

  it('rejects a context budget smaller than the fixed prefix before creating a run', async () => {
    const definition = project(); (definition.nodes.find(node => node.id === 'search')! as Extract<WorkflowNode, { type: 'retrieval' }>).config.maxContextTokens = 1;
    const item = await setup(definition); const readiness = await item.service.validate(item.request.packageHandle, {});
    expect(readiness.ready).toBe(false); expect(readiness.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RAG_MODE_UNSUPPORTED' })]));
    await expect(item.service.start(item.request)).rejects.toThrow(expect.objectContaining({ code: 'WORKFLOW_NOT_READY' }));
    expect(item.store.listRuns()).toEqual([]);
  });
});

describe('RAG operation identity, current authorization and protected stops', () => {
  it('keeps repeated build identity stable, rejects changed intent and does not cache revoked search text', async () => {
    const item = await setup(); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); const local = runtime(item); const execution = { signal: new AbortController().signal, checkpoint() {} };
    const build = project().nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>;
    try {
      const result = await local.execute(waiting.id, 'internal-build', build, { documents: [file] }, execution); const ref = result.data as IndexRef;
      expect(await local.execute(waiting.id, 'internal-build', build, { documents: [file] }, execution)).toEqual(result);
      const changed = structuredClone(build); changed.config.indexSettings!.chunkOverlap = 0; await expect(local.execute(waiting.id, 'internal-build', changed, { documents: [file] }, execution)).rejects.toMatchObject({ code: 'RAG_OPERATION_CONFLICT' });
      const search = project().nodes.find(node => node.id === 'search')! as Extract<WorkflowNode, { type: 'retrieval' }>;
      expect((await local.execute(waiting.id, 'internal-search', search, { index: ref, query: '배송' }, execution)).text).toContain('배송');
      const authority = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite'));
      try { const principal = ledger.principal(waiting.id); const snapshot = authority.readCurrent(principal.scope, principal.subjectId); authority.replaceAccess(principal.scope, { expectedEpoch: snapshot.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: [] }); } finally { authority.close(); ledger.close(); }
      const revoked = await local.execute(waiting.id, 'internal-search', search, { index: ref, query: '배송' }, execution); expect((revoked.data as { candidates: unknown[] }).candidates).toEqual([]); expect(revoked.text).not.toContain(source);
      expect(await local.execute(waiting.id, 'internal-build', build, { documents: [file] }, execution)).toEqual(result);
    } finally { local.close(); }
  });

  it('does not re-register a revoked run reader while building another index', async () => {
    const item = await setup(); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); const local = runtime(item); const execution = { signal: new AbortController().signal, checkpoint() {} }; const build = project().nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>;
    try {
      await local.execute(waiting.id, 'first', build, { documents: [file] }, execution); const authority = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite'));
      try { const principal = ledger.principal(waiting.id); const snapshot = authority.readCurrent(principal.scope, principal.subjectId); authority.replaceAccess(principal.scope, { expectedEpoch: snapshot.epoch, subjects: [], documents: snapshot.documents }); await expect(local.execute(waiting.id, 'second', build, { documents: [file] }, execution)).rejects.toMatchObject({ code: 'RAG_ACCESS_REVOKED' }); expect(authority.hasCurrentSubject(principal.scope, principal.subjectId)).toBe(false); } finally { authority.close(); ledger.close(); }
    } finally { local.close(); }
  });

  it('persists cumulative build quotas and blocks an uncertain operation instead of replaying it after restart', async () => {
    const item = await setup(); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); let local = runtime(item); const execution = { signal: new AbortController().signal, checkpoint() {} }; const build = project().nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>;
    try {
      for (let count = 0; count < 4; count++) await local.execute(waiting.id, `build-${count}`, build, { documents: [file] }, execution);
      local.close(); local = runtime(item); await expect(local.execute(waiting.id, 'fifth', build, { documents: [file] }, execution)).rejects.toMatchObject({ code: 'RAG_BUDGET_EXCEEDED' });
    } finally { local.close(); }
    const raw = new DatabaseSync(join(item.directory, 'rag', 'operations.sqlite')); try { raw.exec("UPDATE operations SET state='pending' WHERE kind='build'"); } finally { raw.close(); }
    const restarted = runtime(item); try { await expect(restarted.execute(waiting.id, 'build-0', build, { documents: [file] }, execution)).rejects.toMatchObject({ code: 'RAG_RECONCILIATION_REQUIRED' }); } finally { restarted.close(); }
  });

  it('cancels real chunk processing before any generation can activate', async () => {
    const item = await setup(); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id, utf8('배송 '.repeat(3000))); const local = runtime(item); const controller = new AbortController();
    try { const pending = local.execute(waiting.id, 'cancel', project().nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>, { documents: [file] }, { signal: controller.signal, checkpoint() {} }); controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'RUN_CANCELLED' }); const raw = new DatabaseSync(join(item.directory, 'rag', 'generations.sqlite')); try { expect(raw.prepare('SELECT COUNT(*) AS count FROM rag_active').get()?.count).toBe(0); } finally { raw.close(); } } finally { local.close(); }
  });

  it('moves an uncertain durable intent to attention_required without an automatic replay', async () => {
    const definition = project(); const item = await setup(definition); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); const build = definition.nodes.find(node => node.id === 'build')!;
    const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite'));
    try { ledger.reserve(waiting.id, `op_${canonicalDigest({ runId: waiting.id, nodeInstanceId: 'build', kind: 'build' })}`, canonicalDigest({ config: build.config, input: { documents: [file] } }), 'build', file.bytes, 1); } finally { ledger.close(); }
    const done = await select(item, waiting.id, waiting.waits[0]!.id, [file]); expect(done).toMatchObject({ status: 'attention_required', error: { code: 'RAG_RECONCILIATION_REQUIRED' } });
    const duplicate = await item.service.start(item.request); expect(duplicate).toEqual({ runId: done.id, status: 'attention_required' });
    const raw = new DatabaseSync(join(item.directory, 'rag', 'generations.sqlite')); try { expect(raw.prepare('SELECT COUNT(*) AS count FROM rag_indexes').get()?.count).toBe(0); } finally { raw.close(); }
  });

  it('denies an activated generation if journal completion failed between the two databases', async () => {
    const item = await setup(); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id); runtime(item).close();
    const raw = new DatabaseSync(join(item.directory, 'rag', 'operations.sqlite'));
    try { raw.exec("CREATE TRIGGER test_completion_failure BEFORE UPDATE ON operations WHEN NEW.state='completed' AND NEW.kind='build' BEGIN SELECT RAISE(ABORT,'injected journal write failure'); END;"); } finally { raw.close(); }
    const done = await select(item, waiting.id, waiting.waits[0]!.id, [file]); expect(done).toMatchObject({ status: 'attention_required', error: { code: 'RAG_RECONCILIATION_REQUIRED' } });
    const ledger = new RunRagLedger(join(item.directory, 'rag', 'operations.sqlite')); const store = new SqliteRagStore(join(item.directory, 'rag', 'generations.sqlite')); const local = runtime(item);
    try {
      const principal = ledger.principal(waiting.id); const operationId = `op_${canonicalDigest({ runId: waiting.id, nodeInstanceId: 'build', kind: 'build' })}`; const active = store.getActiveIndex(principal.scope, `index_${canonicalDigest({ operationId })}`)!; expect(active).not.toBeNull();
      const open = project().nodes.find(node => node.id === 'open')! as Extract<WorkflowNode, { type: 'knowledge' }>;
      await expect(local.execute(waiting.id, 'unpublished', open, { index: active.ref }, { signal: new AbortController().signal, checkpoint() {} })).rejects.toMatchObject({ code: 'RAG_INDEX_NOT_OWNED' });
    } finally { local.close(); store.close(); ledger.close(); }
  });

  it('fails an expired budget before staging or invoking a model', async () => {
    const definition = project(); const build = definition.nodes.find(node => node.id === 'build')!; build.execution.timeoutMs = 1;
    const item = await setup(definition); const waiting = await start(item); const file = await upload(item, waiting.id, waiting.waits[0]!.id, utf8('배송 '.repeat(3000))); const done = await select(item, waiting.id, waiting.waits[0]!.id, [file]);
    expect(done.status).toBe('blocked'); expect(done.error?.code).toBe('BUDGET_EXCEEDED'); expect(done.usage.modelCalls).toBe(0);
  });

  it('rejects unimplemented knowledge and retrieval modes in preflight', async () => {
    for (const mode of ['update', 'delete', 'vector', 'wrong-profile', 'filters', 'web'] as const) {
      const definition = project(); const build = definition.nodes.find(node => node.id === 'build')! as Extract<WorkflowNode, { type: 'knowledge' }>; const search = definition.nodes.find(node => node.id === 'search')! as Extract<WorkflowNode, { type: 'retrieval' }>;
      if (mode === 'update') build.config.operation = 'update'; else if (mode === 'delete') { build.config = { operation: 'delete' }; build.inputBindings = { index: { from: 'workflowInput', pointer: '/index', onMissing: 'error' } }; } else if (mode === 'vector') build.config.indexSettings!.kind = 'vector'; else if (mode === 'wrong-profile') build.config.profile = 'external'; else if (mode === 'filters') search.inputBindings.filters = { from: 'literal', value: {} }; else search.config = { mode: 'web', topK: 5, maxContextTokens: 100, allowedOrigins: ['https://example.com'] };
      const item = await setup(definition); const validation = await item.service.validate(item.request.packageHandle, {}); expect(validation.ready).toBe(false); expect(validation.issues.some(issue => issue.code === 'RAG_MODE_UNSUPPORTED' || issue.code === 'CAPABILITY_MISSING')).toBe(true); expect(existsSync(join(item.directory, 'rag'))).toBe(false);
    }
  });
});
