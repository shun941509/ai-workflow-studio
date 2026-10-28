import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBasicWorkflow, createNode, type Workflow } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';

const owned: { directory: string; store: RunStore; service: RunnerService }[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-model-requirements-')); const store = new RunStore(join(directory, 'state.sqlite')); let credentialReads = 0;
  const credentials: CredentialStore = { available: false, async get() { credentialReads++; throw new Error('No credential'); }, async has() { credentialReads++; return false; }, async set() { throw new Error('No secret writes'); }, async delete() {} };
  const service = new RunnerService(store, credentials, directory, { async countInputTokens() { throw new Error('No model calls'); }, async generate() { throw new Error('No model calls'); } });
  const item = { directory, store, service }; owned.push(item); return { ...item, reads: () => credentialReads };
}
afterEach(async () => { for (const item of owned.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-model-requirements-')) throw new Error('Unsafe test cleanup'); await rm(target, { recursive: true, force: true }); } });

function pureWorkflow(): Workflow {
  const workflow = createBasicWorkflow();
  const output = workflow.nodes.find(node => node.type === 'output')!; output.config = { format: 'json' };
  workflow.nodes = [workflow.nodes.find(node => node.type === 'input')!, output];
  output.inputBindings = { result: { from: 'workflowInput', pointer: '', onMissing: 'error' } };
  workflow.edges = [{ id: 'direct', from: { nodeId: workflow.entryNodeId, port: 'next' }, to: { nodeId: output.id, port: 'in' } }];
  workflow.outputs = true; workflow.modelProfiles.unusedEmbed = { kind: 'embedding', requiredFeatures: ['embedding'] }; return workflow;
}

/** Actual archives, SQLite plans and execution verify that extra legacy bindings cannot become hidden plan dependencies. */
describe('required connections across import, inspect and start', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('omits unused models and pins only required connections for %s', async host => {
    const item = await fixture(); const workflow = pureWorkflow(); const archive = await buildPackage({ workflow, host });
    const detail = await item.service.importPackage(archive.bytes); expect(detail.modelProfiles).toEqual([]); expect(detail.modelRequirements).toEqual([]);
    expect(await item.service.inspect(detail.packageHandle)).toEqual(detail);
    const modelBindings = { 'text-default': 'removed-chat-profile', unusedEmbed: 'removed-embedding-profile' };
    expect((await item.service.validate(detail.packageHandle, modelBindings)).ready).toBe(true);
    const request = { packageHandle: detail.packageHandle, requestId: 'no-hidden-profile', inputs: { text: '실제 입력' }, modelBindings };
    const run = await item.service.start(request); let status = item.service.status(run.runId);
    for (let attempt = 0; attempt < 100 && ['created', 'running'].includes(status.status); attempt++) { await delay(10); status = item.service.status(run.runId); }
    expect(status.status).toBe('succeeded'); expect(status.result).toEqual({ data: { text: '실제 입력' } });
    const saved = item.store.getExecution(run.runId); expect(saved.modelBindings).toEqual({});
    expect(saved.plan).toMatchObject({ modelProfiles: {}, resolved: { verifiedDependencies: {} } });
    expect(JSON.stringify(saved.plan)).not.toContain('removed-embedding-profile'); expect(item.reads()).toBe(0);
    expect((await item.service.start(request)).runId).toBe(run.runId);
    await expect(item.service.start({ ...request, modelBindings: {} })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('shows the fixed embedding contract but leaves live connection readiness unresolved', async () => {
    const item = await fixture(); const workflow = pureWorkflow(); const knowledge = createNode('knowledge'); if (knowledge.type !== 'knowledge') throw new Error('factory');
    knowledge.config = { operation: 'build', profile: 'local-run-embedding-v1', indexSettings: { kind: 'vector', chunkSize: 2000, chunkOverlap: 200, embeddingProfile: 'embed' } };
    knowledge.inputBindings = { documents: { from: 'literal', value: [] } }; workflow.nodes.splice(1, 0, knowledge);
    workflow.edges = [{ id: 'build', from: { nodeId: workflow.entryNodeId, port: 'next' }, to: { nodeId: knowledge.id, port: 'in' } }, { id: 'finish', from: { nodeId: knowledge.id, port: 'next' }, to: { nodeId: workflow.nodes.find(node => node.type === 'output')!.id, port: 'in' } }];
    workflow.modelProfiles.embed = { kind: 'embedding', requiredFeatures: ['embedding'] };
    const detail = await item.service.importPackage((await buildPackage({ workflow, host: 'codex' })).bytes);
    expect(detail.modelProfiles).toEqual(['embed']); expect(detail.modelRequirements).toEqual([expect.objectContaining({ alias: 'embed', kind: 'embedding', constraint: expect.objectContaining({ model: 'text-embedding-3-small', dimensions: 256 }) })]);
    const readiness = await item.service.validate(detail.packageHandle, {}); expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContainEqual(expect.objectContaining({ code: 'MODEL_PROFILE_REQUIRED' })); expect(item.reads()).toBe(0); expect(item.store.listRuns()).toEqual([]);
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('retains fixed reranker metadata through %s ZIP import and inspect without an account', async host => {
    const item = await fixture(); const workflow = pureWorkflow(); const retrieval = createNode('retrieval'); if (retrieval.type !== 'retrieval') throw new Error('factory');
    retrieval.config = { mode: 'keyword', topK: 3, candidateLimit: 10, maxContextTokens: 2000, reranker: { modelProfile: 'rank', timeoutMs: 30000, onFailure: 'fail' } };
    retrieval.inputBindings = { query: { from: 'literal', value: '자료 검색' }, index: { from: 'workflowInput', pointer: '', onMissing: 'error' } };
    const output = workflow.nodes.find(node => node.type === 'output')!; workflow.nodes.splice(1, 0, retrieval);
    workflow.edges = [{ id: 'search', from: { nodeId: workflow.entryNodeId, port: 'next' }, to: { nodeId: retrieval.id, port: 'in' } }, { id: 'finish', from: { nodeId: retrieval.id, port: 'next' }, to: { nodeId: output.id, port: 'in' } }];
    workflow.modelProfiles.rank = { kind: 'reranker', requiredFeatures: ['rerank'] };
    const detail = await item.service.importPackage((await buildPackage({ workflow, host })).bytes);
    expect(detail.modelProfiles).toEqual(['rank']); expect(detail.modelRequirements).toEqual([{ alias: 'rank', kind: 'reranker', requiredFeatures: ['rerank'], constraint: { contractId: 'openai-responses-rerank-v1', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', maxCandidates: 20, maxInputBytes: 65536, maxOutputTokens: 4096 } }]);
    expect(await item.service.inspect(detail.packageHandle)).toEqual(detail); expect((await item.service.validate(detail.packageHandle, {})).ready).toBe(false);
    expect(item.reads()).toBe(0); expect(item.store.listRuns()).toEqual([]);
  });
});
