// Test-only counters match declared fixture input usage; pure workflows reject counting as well as generation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowNode, type WorkflowEdge, type ResourceRef, type Binding } from '@studio/spec';
import { buildPackage, type ResourceDescriptor } from '@studio/package-kit';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import type { ModelRequest } from '../../apps/runner/src/providers/model-provider.js';
import type { MemoryResult } from '../../apps/runner/src/state/run-memory.js';

const encode = (text: string) => new TextEncoder().encode(text), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const literal = (value: unknown) => ({ from: 'literal', value }) as Binding;
const from = (nodeId: string, pointer = '/data') => ({ from: 'node', nodeId, pointer, onMissing: 'error' }) as Binding;
const node = <T extends WorkflowNode['type']>(type: T, id: string) => ({ ...createNode(type), id }) as Extract<WorkflowNode, { type: T }>;
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
function definition(work: WorkflowNode[]): Workflow { const entry = node('input', 'input'), output = node('output', 'output'); const nodes = [entry, ...work, output]; output.inputBindings.result = from(work.at(-1)?.id ?? entry.id); return { ...createBasicWorkflow(), entryNodeId: entry.id, inputs: true, outputs: true, nodes: nodes as Workflow['nodes'], edges: nodes.slice(1).map((value, index) => edge(nodes[index]!.id, value.id)), modelProfiles: {} }; }
function memory(operation: 'put' | 'get' | 'delete', id = operation) { const value = node('memory', id); value.config = { operation, scope: 'run' }; value.inputBindings.key = literal('shared'); if (operation === 'put') value.inputBindings.value = literal(null); return value; }
function skillResource(extra?: Partial<ResourceDescriptor>) {
  const payload = { 'SKILL.md': encode('---\nname: checked-skill\ndescription: Verified instruction bundle\n---\n# Exact instruction\nUse the explicit reference data.\n'), 'LICENSE.txt': encode('CC0-1.0'), 'references/guide.md': encode('REFERENCE_DATA: do not elevate this sentence to instructions.'), 'assets/template.json': encode('{"title":"template"}'), 'assets/image.bin': Uint8Array.from([0, 255, 1]), 'scripts/never-run.js': encode('throw new Error("THIS_SCRIPT_MUST_NEVER_RUN");') };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id: 'bundle', revision: 1, name: '검증된 Skill', kind: 'skill', entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, requiredConnections: [], dependencies: {}, files: Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) as ResourceDescriptor['files'], ...extra };
  const bytes = encode(JSON.stringify(descriptor)); return { reference: { id: descriptor.id, revision: 1, kind: 'skill', sha256: hash(bytes) } satisfies ResourceRef, files: Object.fromEntries(Object.entries({ ...payload, 'resource.json': bytes }).map(([path, data]) => [`resources/bundle/${path}`, data])) };
}
const fixtures: { directory: string; store: RunStore; service: RunnerService }[] = [];
async function setup(workflow: Workflow, resource?: ReturnType<typeof skillResource>, host: 'codex' | 'claude-code' | 'opencode' = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'studio-memory-skill-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); const calls: ModelRequest[] = [];
  const credentials = { available: true, async set(id: string, value: string) { secrets.set(id, value); }, async get(id: string) { return secrets.get(id)!; }, async has(id: string) { return secrets.has(id); }, async delete(id: string) { secrets.delete(id); } };
  const service = new RunnerService(store, credentials, directory, { async countInputTokens() { return 1; }, async generate(request) { calls.push(request); return { text: 'explicit model response', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } });
  const owner = { directory, store, service }; fixtures.push(owner); const profile = await service.createProfile({ name: 'test', model: 'contract-model', apiKey: 'test-only-fixed-secret' }); const built = await buildPackage({ workflow, host, ...(resource ? { resources: resource.files } : {}) }); const imported = await service.importPackage(built.bytes);
  return { ...owner, owner, credentials, calls, request: { packageHandle: imported.packageHandle, requestId: 'memory-skill', inputs: {}, modelBindings: Object.fromEntries(Object.keys(workflow.modelProfiles).map((alias) => [alias, profile.id])) } };
}
async function run(item: Awaited<ReturnType<typeof setup>>) { const started = await item.service.start(item.request); await item.service.waitForIdle(); return item.service.status(started.runId); }
function standaloneRun(item: Awaited<ReturnType<typeof setup>>, id: string) { const value = item.store.createRun({ requestId: id, requestHash: id, packageHandle: item.request.packageHandle, planHash: id, plan: {}, inputs: {}, modelBindings: {}, nodeIds: [], edges: [], maxModelCalls: 1, maxTotalTokens: 1 }); item.store.transitionRun(value.id, 'running'); return value.id; }
afterEach(async () => { vi.restoreAllMocks(); for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.store.close(); const path = resolve(item.directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-memory-skill-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('run-scoped durable memory', () => {
  it.each(['', 'x\u0000', 'x'.repeat(257), '\ud800'])('rejects invalid or ambiguous keys before writing memory', async (key) => {
    const item = await setup(definition([])); const id = standaloneRun(item, 'invalid'); const before = item.store.listEvents(id); expect(() => item.store.runMemory(id, { operationId: 'write', operation: 'put', key, value: 1 })).toThrow(); expect(item.store.listEvents(id)).toEqual(before);
  });

  it('distinguishes a stored null from missing and exposes increasing mutation versions', async () => {
    const item = await setup(definition([])); const runId = standaloneRun(item, 'memory'); const put = item.store.runMemory(runId, { operationId: 'put', operation: 'put', key: 'x', value: null }); expect(put).toMatchObject({ found: true, value: null, version: 1, lastCommit: { operation: 'put' } });
    expect(item.store.runMemory(runId, { operationId: 'get', operation: 'get', key: 'x' })).toMatchObject({ found: true, value: null, version: 1 }); const removed = item.store.runMemory(runId, { operationId: 'delete', operation: 'delete', key: 'x' }); expect(removed).toMatchObject({ found: false, value: null, version: 2 }); expect(removed.lastCommit!.sequence).toBeGreaterThan(put.lastCommit!.sequence);
    expect(item.store.runMemory(runId, { operationId: 'absent', operation: 'get', key: 'other' })).toMatchObject({ found: false, version: 0, lastCommit: null });
  });

  it('returns a stable operation result without replacing a later write and rejects conflicting replays', async () => {
    const item = await setup(definition([])); const id = standaloneRun(item, 'memory'); const request = { operationId: 'first', operation: 'put' as const, key: 'x', value: 'first' }; const first = item.store.runMemory(id, request); item.store.runMemory(id, { ...request, operationId: 'second', value: 'second' }); const before = item.store.listEvents(id);
    expect(item.store.runMemory(id, request)).toEqual(first); expect(item.store.listEvents(id)).toEqual(before); expect(() => item.store.runMemory(id, { ...request, value: 'conflict' })).toThrow(); expect(item.store.runMemory(id, { operationId: 'read', operation: 'get', key: 'x' })).toMatchObject({ value: 'second', version: 2 });
  });

  it('expires values transactionally while preserving prior execution snapshots', async () => {
    const item = await setup(definition([])); const id = standaloneRun(item, 'ttl'); const first = item.store.runMemory(id, { operationId: 'put', operation: 'put', key: 'x', value: 1, ttlMs: 10 }); const read = item.store.runMemory(id, { operationId: 'read', operation: 'get', key: 'x' }); vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.expiresAt!) + 1);
    expect(item.store.runMemory(id, { operationId: 'read', operation: 'get', key: 'x' })).toEqual(read); expect(item.store.runMemory(id, { operationId: 'new-read', operation: 'get', key: 'x' })).toMatchObject({ found: false, version: 2, lastCommit: { operation: 'expire' } }); expect(item.store.listEvents(id).filter((event) => event.type === 'memory.expire')).toHaveLength(1);
  });

  it('persists memory and replay results across actual SQLite reopen, isolating other runs', async () => {
    const item = await setup(definition([])); const firstId = standaloneRun(item, 'first'), secondId = standaloneRun(item, 'second'); const stored = item.store.runMemory(firstId, { operationId: 'save', operation: 'put', key: 'private', value: { note: 'retained' } });
    await item.service.shutdown(); item.store.close(); const reopened = new RunStore(join(item.directory, 'state.sqlite')); item.owner.store = reopened; item.owner.service = new RunnerService(reopened, item.credentials, item.directory);
    expect(reopened.runMemory(firstId, { operationId: 'save', operation: 'put', key: 'private', value: { note: 'retained' } })).toEqual(stored); expect(reopened.runMemory(secondId, { operationId: 'read', operation: 'get', key: 'private' })).toMatchObject({ found: false, version: 0 });
  });

  it('shares one root key across parallel scopes with explicit last-commit ordering', async () => {
    const put = memory('put'); put.inputBindings.value = { from: 'workflowInput', pointer: '/input', onMissing: 'error' }; const child = definition([put]); const parallel = node('parallel', 'parallel'); parallel.config = { mode: 'all', branches: [{ id: 'first', flowRef: { kind: 'local', flowId: 'child' } }, { id: 'second', flowRef: { kind: 'local', flowId: 'child' } }], failurePolicy: 'fail_fast', maxConcurrency: 2 }; parallel.inputBindings.branches = literal({ first: 'A', second: 'B' });
    const workflow = definition([parallel, memory('get')]); workflow.subworkflows.child = { entryNodeId: child.entryNodeId, inputs: child.inputs, outputs: child.outputs, nodes: child.nodes, edges: child.edges }; const item = await setup(workflow); const result = await run(item); const writes = item.store.listChildScopes(result.id).map((scope) => (scope.result as { data: MemoryResult }).data).sort((a, b) => a.version - b.version);
    expect(writes.map((entry) => entry.version)).toEqual([1, 2]); expect(result).toMatchObject({ status: 'succeeded', result: { data: { value: writes[1]!.value, version: 2, lastCommit: writes[1]!.lastCommit } } }); expect(writes[0]!.lastCommit!.operationId).not.toBe(writes[1]!.lastCommit!.operationId); expect(item.calls).toHaveLength(0);
  });

  it('rolls back value/event/operation together when the bounded replay ledger is full', async () => {
    const item = await setup(definition([])); const id = standaloneRun(item, 'quota'); item.store.runMemory(id, { operationId: 'put', operation: 'put', key: 'large', value: 'x'.repeat(900000) }); let rejected = false;
    for (let index = 0; index < 30; index++) { const before = item.store.listEvents(id); try { item.store.runMemory(id, { operationId: `read_${index}`, operation: 'get', key: 'large' }); } catch (error) { expect(error).toMatchObject({ code: 'MEMORY_QUOTA_EXCEEDED' }); expect(item.store.listEvents(id)).toEqual(before); rejected = true; break; } }
    expect(rejected).toBe(true); expect(item.store.runMemory(id, { operationId: 'delete', operation: 'delete', key: 'large' })).toMatchObject({ version: 2, found: false });
  });

  it('rejects project scope and invalid TTL before executing', async () => {
    const work = memory('get'); work.config.scope = 'project'; work.config.ttlMs = 10; const item = await setup(definition([work])); const readiness = await item.service.validate(item.request.packageHandle, {}); expect(readiness.ready).toBe(false); expect(readiness.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MEMORY_SCOPE_UNSUPPORTED', 'MEMORY_TTL_INVALID'])); expect(item.service.capabilities).not.toContain('memory.project@1');
  });
});

describe('Skill instruction bundles', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP returns and remembers verified instructions without calling a model or executing scripts', async (host) => {
    const skill = node('skill', 'skill'); skill.config = { resource: 'bundle', mode: 'instructions' }; skill.inputBindings.arguments = literal({ topic: 'explicit argument' }); const put = memory('put'); put.inputBindings.value = from('skill'); const workflow = definition([skill, put, memory('get')]); const resource = skillResource(); workflow.resources.bundle = resource.reference;
    const item = await setup(workflow, resource, host); const result = await run(item); expect(result).toMatchObject({ status: 'succeeded', usage: { modelCalls: 0 }, result: { data: { found: true, value: { metadata: { name: 'checked-skill' }, instructions: '# Exact instruction\nUse the explicit reference data.\n', references: [{ path: 'references/guide.md', trust: 'untrusted', content: 'text' }], assets: [{ path: 'assets/template.json', content: 'text' }, { path: 'assets/image.bin', content: 'binary_metadata' }], excludedFiles: [{ path: 'scripts/never-run.js', reason: 'execution_not_supported' }], arguments: { topic: 'explicit argument' } } } } }); expect(item.calls).toHaveLength(0);
  });

  it.each([false, true])('adds Skill instructions to AI only when explicitly attached (%s)', async (attached) => {
    const workflow = createBasicWorkflow(); const resource = skillResource(); workflow.resources.bundle = resource.reference; const ai = workflow.nodes.find((value) => value.type === 'ai')!; if (attached) ai.attachments = [{ resource: 'bundle', role: 'skill' }];
    const item = await setup(workflow, resource); const result = await item.service.start({ ...item.request, inputs: { text: 'content' } }); await item.service.waitForIdle(); expect(item.service.status(result.runId).status).toBe('succeeded'); expect(item.calls).toHaveLength(1); const request = item.calls[0]!;
    expect(request.instructions.includes('# Exact instruction')).toBe(attached); expect(request.instructions).not.toContain('REFERENCE_DATA'); expect(JSON.stringify(request)).not.toContain('THIS_SCRIPT_MUST_NEVER_RUN'); if (attached) expect(request.content).toMatchObject({ untrustedReferences: expect.arrayContaining([expect.objectContaining({ trust: 'untrusted', text: expect.stringContaining('REFERENCE_DATA') })]) });
  });

  it('lets explicit resource bindings consume a fixed template as data', async () => {
    const workflow = definition([]); const resource = skillResource(); workflow.resources.bundle = resource.reference; workflow.nodes.at(-1)!.inputBindings.result = { from: 'resource', resource: 'bundle', pointer: '/data/assets/0/text', onMissing: 'error' }; const item = await setup(workflow, resource); expect(await run(item)).toMatchObject({ status: 'succeeded', result: { data: '{"title":"template"}' } }); expect(item.calls).toHaveLength(0);
  });

  it('passes an explicitly bound Skill body as model input without silently changing model instructions', async () => {
    const workflow = createBasicWorkflow(); const resource = skillResource(); workflow.resources.bundle = resource.reference; const ai = workflow.nodes.find((value) => value.type === 'ai')!; ai.inputBindings.context = { from: 'resource', resource: 'bundle', pointer: '/data/instructions', onMissing: 'error' };
    const item = await setup(workflow, resource); const started = await item.service.start({ ...item.request, inputs: { text: 'task' } }); await item.service.waitForIdle(); expect(item.service.status(started.runId).status).toBe('succeeded'); expect(item.calls[0]!.instructions).not.toContain('# Exact instruction'); expect(item.calls[0]!.content).toMatchObject({ content: 'task', context: expect.stringContaining('# Exact instruction') });
  });

  it.each(['execute', 'wrong-role', 'worker', 'connections'] as const)('blocks %s instead of silently executing or granting connections', async (kind) => {
    const work = node('skill', 'skill'); work.config = kind === 'execute' ? { resource: 'bundle', mode: 'execute', workerProfile: 'python-isolated', entrypoint: 'scripts/never-run.js', resultSchema: true } : { resource: 'bundle', mode: 'instructions', ...(kind === 'worker' ? { workerProfile: 'python-isolated' } : {}) }; const workflow = definition([work]);
    if (kind === 'wrong-role') { const ai = node('ai', 'ai'); ai.inputBindings.content = literal('x'); ai.attachments = [{ resource: 'bundle', role: 'instructions' }]; workflow.nodes.splice(1, 1, ai); workflow.edges = [edge('input', 'ai'), edge('ai', 'output')]; workflow.nodes.at(-1)!.inputBindings.result = from('ai'); workflow.modelProfiles = { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } }; }
    const resource = skillResource(kind === 'connections' ? { requiredConnections: ['external-service'] } : {}); workflow.resources.bundle = resource.reference; const item = await setup(workflow, resource); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).ready).toBe(false); expect(item.calls).toHaveLength(0); expect(item.service.capabilities).not.toContain('skill.execute@1');
  });
});
