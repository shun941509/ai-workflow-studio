// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type FileRef, type WorkflowEdge, type Binding } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
function project(format: 'text' | 'markdown' | 'json' | 'csv' | 'copy' = 'text', content: unknown = '확인된 결과'): Workflow {
  const entry = node('input', 'input'), file = node('file_output', 'file'), output = node('output', 'output');
  file.config = { format, filename: format === 'json' ? '결과.json' : format === 'csv' ? '결과.csv' : format === 'markdown' ? '결과.md' : '결과.txt', outputDirectory: 'outputs' }; file.inputBindings.content = { from: 'literal', value: content } as Binding; output.inputBindings.result = { from: 'node', nodeId: 'file', pointer: '/data', onMissing: 'error' };
  return { ...createBasicWorkflow('파일 검증'), entryNodeId: 'input', inputs: true, outputs: true, modelProfiles: {}, nodes: [entry, file, output], edges: [edge('input', 'file'), edge('file', 'output')] };
}
function fileSelection(): Workflow {
  const definition = project('copy'); const selection = node('file_input', 'selection'); selection.config = { mimeTypes: ['text/plain'], maxFiles: 2, maxBytesPerFile: 1024 }; selection.inputBindings.files = { from: 'literal', value: [] };
  definition.nodes.splice(1, 0, selection); definition.nodes.find((value) => value.type === 'file_output')!.inputBindings = { file: { from: 'node', nodeId: 'selection', pointer: '/data/0', onMissing: 'error' } }; definition.edges = [edge('input', 'selection'), edge('selection', 'file'), edge('file', 'output')]; return definition;
}

interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; server: ReturnType<typeof createLocalServer>; origin: string; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> } }
const fixtures: Fixture[] = [];
const provider = { async countInputTokens(): Promise<never> { throw new Error('Pure workflows cannot request model token counts'); }, async generate(): Promise<never> { throw new Error('File workflows cannot call a model'); } };
async function setup(definition = project(), host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-files-test-')); const store = new RunStore(join(directory, 'state.sqlite'));
  const credentials: CredentialStore = { available: false, async get() { throw new Error('no credential'); }, async set() { throw new Error('no credential'); }, async has() { return false; }, async delete() {} };
  const service = new RunnerService(store, credentials, directory, provider);
  const server = createLocalServer(service, { bearerToken: 'test-only-file-token' }); const { origin } = await server.listen(); const built = await buildPackage({ workflow: definition, host }); const imported = await service.importPackage(built.bytes);
  const item = { directory, store, service, credentials, server, origin, request: { packageHandle: imported.packageHandle, requestId: 'file-run', inputs: {}, modelBindings: {} } }; fixtures.push(item); return item;
}
async function start(item: Fixture) { const run = await item.service.start(item.request); await item.service.waitForIdle(); return item.service.status(run.runId); }
async function browser(item: Fixture) {
  const response = await fetch(`${item.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui', origin: item.origin, 'sec-fetch-site': 'same-origin' }, body: '{}' }); const { csrf } = await response.json() as { csrf: string };
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-studio-csrf': csrf, origin: item.origin, 'sec-fetch-site': 'same-origin' };
}
async function upload(item: Fixture, runId: string, waitId: string, headers: Record<string, string>, text = '선택한 원본', uploadId = 'file-upload', filename = '원본.txt', mimeType = 'text/plain') {
  return fetch(`${item.origin}/api/runs/${runId}/waits/${waitId}/files`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-studio-filename': encodeURIComponent(filename), 'x-studio-mime-type': mimeType, 'x-studio-upload-id': uploadId }, body: text });
}
afterEach(async () => { vi.restoreAllMocks(); for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-files-test-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('managed file output through operating packages', () => {
  it.each(['text', 'markdown', 'json', 'csv'] as const)('creates a real %s file and publishes one immutable SQLite reference', async (format) => {
    const content = format === 'json' ? { answer: 42 } : format === 'csv' ? { columns: ['이름'], rows: [{ 이름: '자료' }] } : '확인된 결과'; const item = await setup(project(format, content)); const result = await start(item);
    expect(result.status).toBe('succeeded'); expect(result.files).toHaveLength(1); const record = result.files[0]!; expect(record.source).toBe('node_output');
    const actual = item.service.readArtifact(result.id, record.reference.id); expect(actual.bytes.length).toBe(record.reference.bytes); expect(new TextDecoder().decode(actual.bytes)).toContain(format === 'json' ? '42' : format === 'csv' ? '자료' : '확인된 결과');
    item.store.registerArtifact(result.id, record); expect(item.service.events(result.id).filter((event) => event.type === 'artifact.registered')).toHaveLength(1);
    await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.service = new RunnerService(item.store, item.credentials, item.directory, provider); expect(item.service.readArtifact(result.id, record.reference.id)).toEqual(actual);
  });

  it('keeps file operations distinct for the same local node inside two child scopes', async () => {
    const definition = project(); const child = { entryNodeId: definition.entryNodeId, inputs: definition.inputs, outputs: definition.outputs, nodes: definition.nodes, edges: definition.edges }; const call = node('loop', 'loop'); call.config = { mode: 'foreach', bodyFlowRef: { kind: 'local', flowId: 'child' }, maxIterations: 2 }; call.inputBindings.items = { from: 'literal', value: [1, 2] }; const entry = node('input', 'input'), output = node('output', 'output'); output.inputBindings.result = { from: 'node', nodeId: 'loop', pointer: '/data', onMissing: 'error' }; definition.nodes = [entry, call, output]; definition.edges = [edge('input', 'loop'), edge('loop', 'output')]; definition.subworkflows.child = child;
    const item = await setup(definition); const result = await start(item); expect(result.status).toBe('succeeded'); expect(result.files).toHaveLength(2); expect(new Set(result.files.map((file) => file.reference.id)).size).toBe(2);
  });

  it('rejects unsupported conversion and arbitrary export folders during readiness', async () => {
    const definition = project(); const output = definition.nodes.find((value) => value.type === 'file_output')!; output.config = { format: 'html', filename: 'result.html', outputDirectory: 'outside' }; const item = await setup(definition); const readiness = await item.service.validate(item.request.packageHandle, {});
    expect(readiness.ready).toBe(false); expect(readiness.issues.map((issue) => issue.code)).toContain('FILE_LOCATION_UNSUPPORTED'); expect(item.service.capabilities).not.toContain('file_output.html@1');
  });

  it('downloads authenticated attachments with safe headers and never follows a cross-run ID', async () => {
    const item = await setup(); const result = await start(item); const reference = result.files[0]!.reference; const path = `${item.origin}/api/runs/${result.id}/artifacts/${reference.id}`;
    expect((await fetch(path)).status).toBe(401); const response = await fetch(path, { headers: await browser(item) }); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/octet-stream'); expect(response.headers.get('content-disposition')).toContain('attachment;'); expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''"); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(await response.text()).toBe('확인된 결과');
    const second = await item.service.start({ ...item.request, requestId: 'second' }); await item.service.waitForIdle(); expect((await fetch(`${item.origin}/api/runs/${second.runId}/artifacts/${reference.id}`, { headers: await browser(item) })).status).toBe(404);
  });
});

describe('explicit local file selection', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP waits for upload, consumes one response, copies exact bytes and completes', async (host) => {
    const item = await setup(fileSelection(), host); const initial = await start(item); expect(initial.status).toBe('waiting'); const wait = initial.waits[0]!; expect(wait.kind).toBe('files'); expect(initial.files).toHaveLength(0);
    const headers = await browser(item); const received = await upload(item, initial.id, wait.id, headers); expect(received.status).toBe(201); const reference = await received.json() as FileRef;
    const repeated = await upload(item, initial.id, wait.id, headers); expect(await repeated.json()).toEqual(reference); expect(item.store.listArtifacts(initial.id)).toHaveLength(1);
    const result = await fetch(`${item.origin}/api/runs/${initial.id}/waits/${wait.id}/responses`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'file-response', response: [reference] }) }); expect(result.status).toBe(202); await item.service.waitForIdle();
    const final = item.service.status(initial.id); expect(final.status).toBe('succeeded'); expect(final.files).toHaveLength(2); expect(item.service.readArtifact(initial.id, final.files[1]!.reference.id).bytes).toEqual(item.service.readArtifact(initial.id, reference.id).bytes); expect(final.usage.modelCalls).toBe(0);
    item.service.respondWait(initial.id, wait.id, { requestId: 'file-response', response: [reference] }); expect(item.store.listArtifacts(initial.id)).toHaveLength(2); expect(item.service.events(initial.id).filter((event) => event.type === 'node.status' && (event.payload as { nodeId?: string; status?: string }).nodeId === 'selection' && (event.payload as { status?: string }).status === 'succeeded')).toHaveLength(1);
  });

  it('rejects MCP bearer and missing CSRF uploads even with browser-like headers', async () => {
    const item = await setup(fileSelection()); const initial = await start(item); const wait = initial.waits[0]!; const headers = await browser(item);
    expect((await upload(item, initial.id, wait.id, { authorization: 'Bearer test-only-file-token', origin: item.origin, 'sec-fetch-site': 'same-origin' })).status).toBe(403);
    expect((await upload(item, initial.id, wait.id, { ...headers, authorization: 'Bearer test-only-file-token' })).status).toBe(403);
    expect((await upload(item, initial.id, wait.id, { cookie: headers.cookie, origin: item.origin, 'sec-fetch-site': 'same-origin' })).status).toBe(401); expect(item.store.listArtifacts(initial.id)).toHaveLength(0);
  });

  it('rejects filtered files, path names, changed idempotent uploads and oversized bodies', async () => {
    const item = await setup(fileSelection()); const initial = await start(item); const wait = initial.waits[0]!; const headers = await browser(item);
    expect((await upload(item, initial.id, wait.id, headers, 'x', 'path', '../secret.txt')).status).toBe(400); expect((await upload(item, initial.id, wait.id, headers, 'x', 'mime', 'a.txt', 'text/html')).status).toBe(400); expect((await upload(item, initial.id, wait.id, headers, 'x'.repeat(1025))).status).toBe(413);
    expect((await upload(item, initial.id, wait.id, headers)).status).toBe(201); const conflict = await upload(item, initial.id, wait.id, headers, 'changed'); expect(conflict.status).toBe(400); expect((await conflict.json()).error.code).toBe('ARTIFACT_OPERATION_CONFLICT'); expect(item.store.listArtifacts(initial.id)).toHaveLength(1);
  });

  it('restores pending file selection and upload bytes after SQLite restart without replaying prior nodes', async () => {
    const item = await setup(fileSelection()); const initial = await start(item); const wait = initial.waits[0]!; const reference = item.service.uploadWaitFile(initial.id, wait.id, 'chosen', 'source.txt', 'text/plain', new TextEncoder().encode('durable'));
    await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); expect(item.store.recoverInterruptedRuns()).toBe(0); item.service = new RunnerService(item.store, item.credentials, item.directory, provider); await item.service.restoreWaitingRuns();
    expect(item.service.status(initial.id).waits[0]!.id).toBe(wait.id); expect(new TextDecoder().decode(item.service.readArtifact(initial.id, reference.id).bytes)).toBe('durable'); item.service.respondWait(initial.id, wait.id, { requestId: 'after-restart', response: [reference] }); await item.service.waitForIdle();
    expect(item.service.status(initial.id).status).toBe('succeeded'); expect(item.service.events(initial.id).filter((event) => event.type === 'node.status' && (event.payload as { nodeId?: string; status?: string }).nodeId === 'input' && (event.payload as { status?: string }).status === 'succeeded')).toHaveLength(1);
  });

  it('rejects forged references and another run upload without losing the pending selection', async () => {
    const item = await setup(fileSelection()); const first = await start(item); const second = await item.service.start({ ...item.request, requestId: 'second' }); await item.service.waitForIdle(); const secondWait = item.service.status(second.runId).waits[0]!;
    const reference = item.service.uploadWaitFile(first.id, first.waits[0]!.id, 'chosen', 'source.txt', 'text/plain', new TextEncoder().encode('real'));
    expect(() => item.service.respondWait(second.runId, secondWait.id, { requestId: 'forged', response: [reference] })).toThrow(); expect(() => item.service.respondWait(first.id, first.waits[0]!.id, { requestId: 'altered', response: [{ ...reference, sha256: 'a'.repeat(64) }] })).toThrow(); expect(item.service.status(first.id).status).toBe('waiting'); expect(item.service.status(second.runId).status).toBe('waiting');
  });

  it('cancels selection and denies later upload or continuation', async () => {
    const item = await setup(fileSelection()); const first = await start(item); const wait = first.waits[0]!; item.service.cancel(first.id);
    expect(() => item.service.uploadWaitFile(first.id, wait.id, 'late', 'source.txt', 'text/plain', new Uint8Array())).toThrow(); expect(item.service.status(first.id).status).toBe('cancelled'); expect(item.store.graphState(first.id).nodes.find((value) => value.nodeId === 'selection')?.status).toBe('cancelled');
  });

  it('expires file selection without uploading or manufacturing a default response', async () => {
    const definition = fileSelection(); definition.nodes.find((value) => value.type === 'file_input')!.execution.waitTtlMs = 1000; const item = await setup(definition); const initial = await start(item); const wait = initial.waits[0]!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(wait.expiresAt) + 1);
    expect(() => item.service.uploadWaitFile(initial.id, wait.id, 'late', 'source.txt', 'text/plain', new Uint8Array())).toThrow(); expect(item.service.status(initial.id)).toMatchObject({ status: 'failed', error: { code: 'WAIT_EXPIRED' }, files: [] });
  });

  it('enforces the upload count and rejects selecting the same reference twice', async () => {
    const item = await setup(fileSelection()); const initial = await start(item); const wait = initial.waits[0]!; const bytes = new TextEncoder().encode('content');
    const first = item.service.uploadWaitFile(initial.id, wait.id, 'first', 'first.txt', 'text/plain', bytes); item.service.uploadWaitFile(initial.id, wait.id, 'second', 'second.txt', 'text/plain', bytes);
    expect(() => item.service.uploadWaitFile(initial.id, wait.id, 'third', 'third.txt', 'text/plain', bytes)).toThrow(); expect(() => item.service.respondWait(initial.id, wait.id, { requestId: 'duplicates', response: [first, first] })).toThrow(); expect(item.store.listArtifacts(initial.id)).toHaveLength(2); expect(item.service.status(initial.id).status).toBe('waiting');
  });
});
