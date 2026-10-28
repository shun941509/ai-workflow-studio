import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createBasicWorkflow, createNode, type FileRef, type Workflow, type WorkflowNode } from '@studio/spec';
import { buildPackage, canonicalDigest } from '@studio/package-kit';
import { collectRequirements, createResolvedPlan } from '@studio/workflow-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { ArtifactStore } from '../../apps/runner/src/artifacts/store.js';
import { builtinToolPins } from '../../apps/runner/src/tools/builtin-registry.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const fixtures: { directory: string; store: RunStore; service: RunnerService }[] = [];
const provider = { async countInputTokens(): Promise<never> { throw new Error('No model counting for builtin files'); }, async generate(): Promise<never> { throw new Error('No model calls for builtin files'); } };
const credentials: CredentialStore = { available: false, async has() { return false; }, async get(): Promise<never> { throw new Error('No credentials'); }, async set(): Promise<never> { throw new Error('No credentials'); }, async delete() {} };
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;

/** A real namespace merge wraps the selected FileRef as {file}; no runtime-only test input converter is used. */
function project(ids: string[] = ['file.inspect', 'document.read_utf8'], prompt = false, upload = true): Workflow {
  const entry = node('input', 'entry'), selection = node('file_input', 'selection'), args = prompt ? node('form', 'args') : node('merge', 'args'), output = node('output', 'output');
  selection.config = { mimeTypes: ['text/plain', 'text/markdown', 'application/json', 'application/pdf'], maxFiles: 1, maxBytesPerFile: 2 * 1024 * 1024 }; selection.inputBindings.files = { from: 'literal', value: [] };
  if (args.type === 'form') args.config = { mode: 'request', title: '도구 인수 확인', schema: true };
  else { args.config = { waitFor: 'all_active', combine: 'object', collision: 'namespace' }; args.inputBindings.file = { from: 'node', nodeId: 'selection', pointer: '/data/0', onMissing: 'error' }; }
  const tools = ids.map((id, index) => { const tool = node('tool', `tool_${index}`); tool.config.tool = { kind: 'builtin', id, version: 1 }; tool.inputBindings.arguments = { from: 'node', nodeId: 'args', pointer: '/data', onMissing: 'error' }; return tool; });
  output.inputBindings.result = { from: 'node', nodeId: tools.at(-1)!.id, pointer: '/data', onMissing: 'error' };
  const nodes: Workflow['nodes'] = [entry, args, ...tools, output]; if (upload) nodes.splice(1, 0, selection);
  return { ...createBasicWorkflow('등록된 파일 읽기 도구'), entryNodeId: entry.id, inputs: true, outputs: true, modelProfiles: {}, nodes, edges: nodes.slice(0, -1).map((value, index) => ({ id: `e${index}`, from: { nodeId: value.id, port: 'next' }, to: { nodeId: nodes[index + 1]!.id, port: 'in' } })) };
}
async function setup(workflow = project(), host: 'codex' | 'claude-code' | 'opencode' = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'studio-builtin-run-')); const store = new RunStore(join(directory, 'state.db')); const service = new RunnerService(store, credentials, directory, provider); const item = { directory, store, service }; fixtures.push(item);
  const built = await buildPackage({ workflow, host }); const imported = await service.importPackage(built.bytes);
  return { ...item, workflow, request: { packageHandle: imported.packageHandle, requestId: 'builtin-run', inputs: {}, modelBindings: {} } };
}
async function begin(item: Awaited<ReturnType<typeof setup>>) { const run = await item.service.start(item.request); await item.service.waitForIdle(); return run.runId; }
async function selectFile(item: Awaited<ReturnType<typeof setup>>, runId: string, text = '\uFEFF실제 원문 😀\r\n보존', filename = '자료.txt', mime = 'text/plain') {
  const wait = item.service.status(runId).waits.find(value => value.kind === 'files')!;
  const file = item.service.uploadWaitFile(runId, wait.id, 'upload', filename, mime, Buffer.from(text));
  item.service.respondWait(runId, wait.id, { requestId: 'selected', response: [file] }); await item.service.waitForIdle(); return file;
}
async function answer(item: Awaited<ReturnType<typeof setup>>, runId: string, argumentsValue: unknown) {
  const wait = item.service.status(runId).waits.find(value => value.kind === 'input')!;
  item.service.respondWait(runId, wait.id, { requestId: 'arguments', response: argumentsValue }); await item.service.waitForIdle(); return item.service.status(runId);
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-builtin-run-')) throw new Error('Unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('read-only builtin tools through operational packages', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('executes both tools using real bytes from the %s ZIP flow', async host => {
    const item = await setup(project(), host), id = await begin(item), text = '\uFEFF원문 😀\r\n그대로'; const file = await selectFile(item, id, text); const status = item.service.status(id);
    expect(status).toMatchObject({ status: 'succeeded', usage: { modelCalls: 0, consumedTokens: 0 }, result: { data: { text, extraction: 'verbatim_utf8', locations: [{ file, textSha256: createHash('sha256').update(text).digest('hex'), location: { encoding: 'utf8', start: 0, end: Buffer.byteLength(text) } }] } } });
    expect(item.store.graphState(id).nodes.find(value => value.nodeId === 'tool_0')!.result).toEqual({ data: { file, integrity: 'verified' } });
    expect(status.files).toHaveLength(1); expect(item.service.readArtifact(id, file.id).bytes).toEqual(Buffer.from(text));
    expect(item.store.getExecution(id).plan).toMatchObject({ resolved: { verifiedDependencies: { builtinTools: builtinToolPins(item.workflow) } } });
    expect(collectRequirements(item.workflow).capabilities).toEqual(expect.arrayContaining(['node.tool@1', 'tool.builtin.file.inspect@1', 'tool.builtin.document.read_utf8@1']));
  });
  it.each(['file.delete', 'not-registered'])('rejects unsupported builtin %s during readiness', async toolId => {
    const item = await setup(project([toolId])); const readiness = await item.service.validate(item.request.packageHandle, {});
    expect(readiness.ready).toBe(false); expect(readiness.issues.some(issue => issue.code === 'BUILTIN_TOOL_UNSUPPORTED')).toBe(true); await expect(item.service.start(item.request)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' }); expect(item.store.listRuns()).toHaveLength(0);
  });
  it('blocks an unknown tool version even when node.tool is installed', async () => {
    const workflow = project(['file.inspect']); const tool = workflow.nodes.find(value => value.type === 'tool')!; if (tool.type !== 'tool' || tool.config.tool.kind !== 'builtin') throw new Error('Fixture'); tool.config.tool.version = 2;
    const item = await setup(workflow); expect((await item.service.validate(item.request.packageHandle, {})).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CAPABILITY_MISSING' })]));
  });
  it('rejects forged current-run references and OS/URL/effects argument additions', async () => {
    for (const change of ['hash', 'path', 'effects'] as const) {
      const item = await setup(project(['file.inspect'], true)); const id = await begin(item); const file = await selectFile(item, id);
      const value = change === 'hash' ? { file: { ...file, sha256: '0'.repeat(64) } } : change === 'path' ? { file, path: 'C:/private', url: 'https://example.invalid' } : { file, effects: [], classification: 'read_only' };
      const status = await answer(item, id, value); expect(status.status).toBe('failed'); expect(status.error?.code).toBe(change === 'hash' ? 'ARTIFACT_REFERENCE_INVALID' : 'BUILTIN_ARGUMENTS_INVALID'); expect(status.files).toHaveLength(1);
    }
  });
  it('denies a genuine reference owned by a different run', async () => {
    const first = await setup(project(['file.inspect'])); const firstId = await begin(first), file = await selectFile(first, firstId);
    const workflow = project(['file.inspect'], true, false); const imported = await first.service.importPackage((await buildPackage({ workflow, host: 'codex' })).bytes);
    const second = { ...first, workflow, request: { ...first.request, packageHandle: imported.packageHandle, requestId: 'another-run-same-service' } }; const secondId = await begin(second); const status = await answer(second, secondId, { file });
    expect(status.status).toBe('failed'); expect(status.files).toHaveLength(0); expect(second.store.graphState(secondId).nodes.find(value => value.nodeId === 'tool_0')!.result).toBeNull();
  });
  it('requires durable current-run registration even for intact files in the private artifact store', async () => {
    const item = await setup(project(['file.inspect'], true, false)), id = await begin(item);
    // This test creates an unregistered staging artifact; the production API cannot supply this callback or register it by argument.
    const files = new ArtifactStore(join(item.directory, 'artifacts')); const file = files.put(id, { operationId: 'unregistered', filename: 'hidden.txt', mimeType: 'text/plain', bytes: Buffer.from('not registered') });
    const status = await answer(item, id, { file }); expect(status.status).toBe('failed'); expect(status.files).toHaveLength(0);
  });
  it('detects original-byte tampering before a supposedly read-only inspection can succeed', async () => {
    const item = await setup(project(['file.inspect'], true)), id = await begin(item), file = await selectFile(item, id);
    const path = resolve(item.directory, 'artifacts', `run_${createHash('sha256').update(id).digest('hex')}`, file.id, 'data');
    if (!path.startsWith(resolve(item.directory) + sep)) throw new Error('Unsafe test mutation'); await writeFile(path, Buffer.from('changed bytes'));
    const status = await answer(item, id, { file }); expect(status.status).toBe('failed'); expect(status.error?.code).toBe('ARTIFACT_INTEGRITY');
  });
  it('keeps unsupported PDF explicit while allowing real metadata inspection', async () => {
    const item = await setup(), id = await begin(item); await selectFile(item, id, '%PDF-1.7', '문서.pdf', 'application/pdf');
    expect(item.service.status(id)).toMatchObject({ status: 'failed', error: { code: 'DOCUMENT_FORMAT_UNSUPPORTED' } }); expect(item.store.graphState(id).nodes.find(value => value.nodeId === 'tool_0')!.status).toBe('succeeded');
  });
  it('honors node budgets and cancellation before any tool result is released', async () => {
    const workflow = project(['file.inspect']); workflow.policy.limits.maxNodeInstances = 3; const item = await setup(workflow), id = await begin(item); await selectFile(item, id);
    expect(item.service.status(id)).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    const other = await setup(project(['file.inspect'])), otherId = await begin(other); other.service.cancel(otherId); await other.service.waitForIdle();
    expect(other.service.status(otherId).status).toBe('cancelled'); expect(other.store.graphState(otherId).nodes.find(value => value.nodeId === 'tool_0')!.result).toBeNull();
  });
  it('restores a pending file wait and executes the pinned tools only after the user responds', async () => {
    const item = await setup(), id = await begin(item); await item.service.shutdown(); item.store.close();
    const store = new RunStore(join(item.directory, 'state.db')), service = new RunnerService(store, credentials, item.directory, provider); Object.assign(fixtures.find(value => value.directory === item.directory)!, { store, service }); Object.assign(item, { store, service });
    store.recoverInterruptedRuns(); await service.restoreWaitingRuns(); expect(service.status(id).status).toBe('waiting');
    await selectFile(item, id); expect(service.status(id).status).toBe('succeeded'); expect(service.events(id).filter(event => event.type === 'attempt.started' && (event.payload as { nodeId?: string }).nodeId === 'tool_0')).toHaveLength(1);
  });
  it('rejects a previous release contract before consuming a resumed response', async () => {
    const item = await setup(project(['file.inspect'], true, false)), id = await begin(item), wait = item.service.status(id).waits[0]!;
    const saved = item.store.getExecution(id), plan = structuredClone(saved.plan) as { resolved: { verifiedDependencies: Record<string, unknown> }; workflow: Workflow; modelProfiles: Record<string, unknown> };
    const oldPins = structuredClone(builtinToolPins(item.workflow)); oldPins['file.inspect@1'] = { ...oldPins['file.inspect@1']!, contractHash: 'f'.repeat(64) };
    const previous = { ...plan, resolved: await createResolvedPlan(item.workflow, { ...plan.resolved.verifiedDependencies, builtinTools: oldPins }, { modelProfiles: {} }) }; const hash = canonicalDigest(previous);
    await item.service.shutdown(); item.store.close();
    // Simulate a consistent plan written by an older release, rather than bypassing the outer plan hash check.
    const db = new DatabaseSync(join(item.directory, 'state.db')); db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO plans(hash,body) VALUES(?,?)').run(hash, JSON.stringify(previous)); db.prepare('UPDATE runs SET plan_hash=? WHERE id=?').run(hash, id); db.prepare('UPDATE waits SET plan_hash=? WHERE id=?').run(hash, wait.id); db.exec('COMMIT'); db.close();
    const store = new RunStore(join(item.directory, 'state.db')), service = new RunnerService(store, credentials, item.directory, provider); Object.assign(fixtures.find(value => value.directory === item.directory)!, { store, service });
    service.respondWait(id, wait.id, { requestId: 'old-response', response: {} }); await service.waitForIdle();
    expect(service.status(id)).toMatchObject({ status: 'failed', error: { code: 'BUILTIN_TOOL_CHANGED' } }); expect(store.getWait(wait.id).state).toBe('responded');
    expect(store.graphState(id).nodes.find(value => value.nodeId === 'tool_0')!.result).toBeNull();
  });
  it('retains completed tool results while interrupted tool attempts remain attention-required without replay', async () => {
    const item = await setup(project(['file.inspect'])), id = await begin(item); const file = await selectFile(item, id); const saved = item.store.getExecution(id);
    const interrupted = item.store.createRun({ requestId: 'interrupted', requestHash: 'interrupted', packageHandle: item.request.packageHandle, planHash: saved.planHash, plan: saved.plan, inputs: {}, modelBindings: {}, nodeIds: item.workflow.nodes.map(value => value.id), edges: item.workflow.edges, maxModelCalls: 1, maxTotalTokens: 1000 });
    item.store.transitionRun(interrupted.id, 'running'); item.store.transitionNode(interrupted.id, 'tool_0', 'running'); item.store.beginAttempt(interrupted.id, 'tool_0');
    await item.service.shutdown(); item.store.close(); const store = new RunStore(join(item.directory, 'state.db')), service = new RunnerService(store, credentials, item.directory, provider); Object.assign(fixtures.find(value => value.directory === item.directory)!, { store, service });
    store.recoverInterruptedRuns(); await service.restoreWaitingRuns(); await service.waitForIdle();
    expect(store.getRun(interrupted.id).status).toBe('attention_required'); expect(store.graphState(interrupted.id).nodes.find(value => value.nodeId === 'tool_0')!.status).toBe('reconciling');
    expect(store.graphState(id).nodes.find(value => value.nodeId === 'tool_0')!.result).toEqual({ data: { file, integrity: 'verified' } });
    expect(service.events(interrupted.id).filter(event => event.type === 'attempt.started')).toHaveLength(1);
  });
});
