import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const fixtures: { root: string; service: RunnerService; store: RunStore }[] = [];
const credentials: CredentialStore = { available: false, async has() { return false; }, async get() { throw new Error('No model credentials allowed'); }, async set() { throw new Error('No model credentials allowed'); }, async delete() {} };
const provider = { async countInputTokens(): Promise<never> { throw new Error('No model measurement allowed'); }, async generate(): Promise<never> { throw new Error('No model generation allowed'); } };
function project(): Workflow {
  const entry = createNode('input'), file = createNode('file_input'), extract = createNode('document_extract'), end = createNode('output');
  if (file.type !== 'file_input') throw new Error('Wrong node');
  entry.id = 'start'; file.id = 'file'; extract.id = 'extract'; end.id = 'end';
  file.config = { mimeTypes: ['text/plain', 'application/pdf'], maxFiles: 1, maxBytesPerFile: 2 * 1024 * 1024 }; file.inputBindings.files = { from: 'literal', value: [] };
  extract.inputBindings.file = { from: 'node', nodeId: 'file', pointer: '/data/0', onMissing: 'error' }; end.inputBindings.result = { from: 'node', nodeId: 'extract', pointer: '/data/text', onMissing: 'error' };
  const nodes = [entry, file, extract, end] as Workflow['nodes'];
  return { ...createBasicWorkflow('문서 원문 읽기'), entryNodeId: 'start', inputs: true, outputs: { type: 'string' }, modelProfiles: {}, nodes, edges: ['start', 'file', 'extract'].map((id, i) => ({ id: `e${i}`, from: { nodeId: id, port: 'next' }, to: { nodeId: nodes[i + 1]!.id, port: 'in' } })) };
}
async function setup(workflow: Workflow, host: 'codex' | 'claude-code' | 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'studio-document-run-')); const store = new RunStore(join(root, 'state.sqlite')); const service = new RunnerService(store, credentials, root, provider); fixtures.push({ root, store, service });
  const built = await buildPackage({ workflow, host }); const imported = await service.importPackage(built.bytes);
  return { service, store, request: { packageHandle: imported.packageHandle, requestId: 'document-run', inputs: {}, modelBindings: {} } };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.shutdown(); fixture.store.close();
    const target = resolve(fixture.root); if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('studio-document-run-')) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

/** All three host packages reach the same real Runner and file store without any model or external service call. */
describe('operational document extraction', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('imports %s ZIP and preserves original text through upload, extraction and final output', async host => {
    const { service, request } = await setup(project(), host); const run = await service.start(request); await service.waitForIdle(); const wait = service.status(run.runId).waits[0]!;
    const text = '\uFEFF원문 😀\r\n변경하지 않기'; const file = service.uploadWaitFile(run.runId, wait.id, 'upload', '문서.txt', 'text/plain', Buffer.from(text));
    service.respondWait(run.runId, wait.id, { requestId: 'selected', response: [file] }); await service.waitForIdle();
    expect(service.status(run.runId)).toMatchObject({ status: 'succeeded', result: { data: text } }); expect(service.readArtifact(run.runId, file.id).bytes).toEqual(Buffer.from(text));
  });
  it('fails explicitly on a selected PDF and cannot pretend to extract it as text', async () => {
    const { service, request } = await setup(project(), 'codex'); const run = await service.start(request); await service.waitForIdle(); const wait = service.status(run.runId).waits[0]!;
    const file = service.uploadWaitFile(run.runId, wait.id, 'upload', '문서.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
    service.respondWait(run.runId, wait.id, { requestId: 'selected', response: [file] }); await service.waitForIdle();
    expect(service.status(run.runId)).toMatchObject({ status: 'failed', error: { code: 'DOCUMENT_FORMAT_UNSUPPORTED' } });
  });
});
