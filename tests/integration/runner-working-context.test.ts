import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBasicWorkflow, createNode, type Workflow, type WorkDefinition, type ResourceRef } from '@studio/spec';
import { applyWorkingContextPreset, workingTaskContext } from '@studio/workflow-core';
import { buildPackage, canonicalDigest, createTextResource, type ResourceDescriptor, type TargetHost } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { ModelError, type ModelRequest, type ModelResponse } from '../../apps/runner/src/providers/model-provider.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

const encode = (value: string) => new TextEncoder().encode(value);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function definition(): WorkDefinition { return { version: 1, id: 'working', revision: 1, card: { id: 'card', title: '업무 카드', purpose: '원문 정리' }, role: { id: 'role', title: '작성 담당', responsibility: '없는 사실을 만들지 않음' }, task: { id: 'task', title: '초안', goal: '선택 자료로 작성', criterionIds: ['text'], assets: [], skills: [] }, harness: { context: ['start'], perform: ['work'], accept: ['finish'], deliver: ['finish'], selectedContext: [] } }; }
function example(agent = false) {
  const workflow = createBasicWorkflow('고정 업무 문맥'); workflow.inputs = true; workflow.outputs = true; workflow.workDefinition = definition(); workflow.completion = { version: 1, criteria: [{ id: 'text', label: '결과 있음', kind: 'result_schema', schema: true }] };
  const files: Record<string, Uint8Array> = {};
  for (const [alias, kind, text] of [['guide', 'instruction', 'SELECTED-INSTRUCTION-ONLY'], ['template', 'document', 'REFERENCE-DATA-NOT-INSTRUCTIONS'], ['excluded', 'instruction', 'NEVER-SEND-EXCLUDED-ASSET']] as const) {
    const resource = createTextResource({ id: alias, revision: 2, kind, name: alias, text }); workflow.resources[alias] = resource.reference; Object.assign(files, resource.files);
    workflow.workDefinition.task.assets.push({ alias, kind, usage: kind === 'instruction' ? 'instructions' : 'template', purpose: `${alias} purpose`, required: alias !== 'excluded' });
  }
  const payload = { 'SKILL.md': encode('---\nname: working-context-test\ndescription: Apply explicit source rules without running scripts.\n---\nSELECTED-SKILL-INSTRUCTIONS'), 'LICENSE.txt': encode('LICENSE-NOT-MODEL-INPUT'), 'references/example.md': encode('SELECTED-SKILL-REFERENCE'), 'assets/template.json': encode('{"selected":"SKILL-TEMPLATE"}'), 'assets/binary.bin': new Uint8Array([0, 255]), 'scripts/code.py': encode('NEVER-EXECUTE-OR-SEND-SCRIPT') };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id: 'source-skill', revision: 3, kind: 'skill', name: '명시 지침', entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [], files: Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) as ResourceDescriptor['files'] };
  const descriptorBytes = encode(JSON.stringify(descriptor)); workflow.resources.procedure = { kind: 'skill', id: descriptor.id, revision: descriptor.revision, sha256: hash(descriptorBytes) } satisfies ResourceRef;
  for (const [path, bytes] of Object.entries({ ...payload, 'resource.json': descriptorBytes })) files[`resources/procedure/${path}`] = bytes;
  workflow.workDefinition.task.skills = [{ alias: 'procedure', kind: 'skill', usage: 'instructions', purpose: '고정 절차', required: true }]; workflow.workDefinition.harness.selectedContext = ['guide', 'template', 'procedure'];
  const work = workflow.nodes.find(node => node.id === 'work')!; work.inputBindings = { content: { from: 'workflowInput', pointer: '', onMissing: 'error' }, context: { from: 'literal', value: { sourceText: 'USER-REQUEST-CONTEXT' } } };
  if (agent) { const node = createNode('agent'); if (node.type !== 'agent') throw new Error('factory'); node.id = 'work'; node.config.strategy = 'task'; node.config.maxSteps = 1; node.config.modelProfile = 'text-default'; node.config.resultSchema = { type: 'string' }; node.inputBindings = { task: work.inputBindings.content!, context: work.inputBindings.context! }; workflow.nodes[workflow.nodes.indexOf(work)] = node; }
  return { workflow: applyWorkingContextPreset(workflow), files };
}
interface Fixture { directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; count: ModelRequest[]; generate: ModelRequest[]; gets: number; request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> }; workflow: Workflow; provider: { countInputTokens(request: ModelRequest): Promise<number>; generate(request: ModelRequest): Promise<ModelResponse> }; hook?: (phase: 'count' | 'generate', request: ModelRequest) => void | Promise<void> }
const made: Fixture[] = [];
/** Provider and key storage are internal test boundaries; archive verification, scheduler, SQLite and HTTP remain real. */
async function setup(host: TargetHost = 'codex', agent = false, maxBytes?: number) {
  const { workflow, files } = example(agent); if (maxBytes) workflow.workDefinition!.harness.workingContext!.maxBytes = maxBytes;
  const directory = await mkdtemp(join(tmpdir(), 'studio-working-context-')); const secrets = new Map<string, string>(); const item = { directory, count: [], generate: [], gets: 0, workflow } as unknown as Fixture;
  item.credentials = { available: true, async has(id) { return secrets.has(id); }, async get(id) { item.gets++; return secrets.get(id)!; }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } };
  item.provider = { async countInputTokens(request) { item.count.push(request); await item.hook?.('count', request); return 5; }, async generate(request) { item.generate.push(request); await item.hook?.('generate', request); return { model: request.model, text: agent ? '{"resultJson":"\\"작성 결과\\""}' : '작성 결과', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } }; } };
  item.store = new RunStore(join(directory, 'state.sqlite')); item.service = new RunnerService(item.store, item.credentials, directory, item.provider); made.push(item);
  const profile = await item.service.createProfile({ name: 'Local test connection', model: 'contract-model', apiKey: 'test-only-no-live-key' });
  const imported = await item.service.importPackage((await buildPackage({ workflow, resources: files, host })).bytes);
  item.request = { packageHandle: imported.packageHandle, requestId: `context-${host}`, inputs: 'USER-CONTENT', modelBindings: { 'text-default': profile.id } }; return item;
}
async function run(item: Fixture) { const started = await item.service.start(item.request); await item.service.waitForIdle(); return item.service.status(started.runId); }
async function reopen(item: Fixture) { await item.service.shutdown(); item.store.close(); item.store = new RunStore(join(item.directory, 'state.sqlite')); item.store.recoverInterruptedRuns(); item.service = new RunnerService(item.store, item.credentials, item.directory, item.provider); }
afterEach(async () => { for (const item of made.splice(0)) { await item.service.shutdown(); item.store.close(); const target = resolve(item.directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-working-context-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true }); } });

describe('actual fixed working context consumption', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('%s ZIP delivers selected bytes once and binds the frozen count/generate request to durable provenance', async host => {
    const item = await setup(host); expect((await item.service.validate(item.request.packageHandle, item.request.modelBindings)).ready).toBe(true); expect(item.count).toHaveLength(0); expect(item.generate).toHaveLength(0);
    const result = await run(item); expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); expect(result.workingContexts).toHaveLength(1); const record = result.workingContexts[0]!;
    expect(item.count[0]).toBe(item.generate[0]); expect(Object.isFrozen(item.count[0]!.content)).toBe(true); expect(record).toMatchObject({ countState: 'confirmed', generationState: 'response_confirmed', manifest: { requestHash: canonicalDigest(item.generate[0]), selectionScope: 'task_fixed_attachments' } });
    expect(item.generate[0]!.content).toMatchObject({ context: { businessTask: workingTaskContext(item.workflow), request: { sourceText: 'USER-REQUEST-CONTEXT' } }, untrustedReferences: expect.arrayContaining([expect.objectContaining({ resource: 'template', trust: 'untrusted', text: 'REFERENCE-DATA-NOT-INSTRUCTIONS' })]) });
    expect(item.generate[0]!.instructions).toContain('SELECTED-INSTRUCTION-ONLY'); expect(item.generate[0]!.instructions).toContain('SELECTED-SKILL-INSTRUCTIONS'); expect(item.generate[0]!.instructions).not.toContain('REFERENCE-DATA-NOT-INSTRUCTIONS');
    for (const forbidden of ['NEVER-SEND-EXCLUDED-ASSET', 'NEVER-EXECUTE-OR-SEND-SCRIPT', 'LICENSE-NOT-MODEL-INPUT']) expect(JSON.stringify(item.generate[0])).not.toContain(forbidden);
    expect(record.manifest.assets.find(asset => asset.alias === 'excluded')).toMatchObject({ selected: false, reason: 'not_selected', revision: 2 });
    expect(record.manifest.assets.find(asset => asset.alias === 'procedure')!.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/code.py', selected: false, reason: 'execution_not_supported' }), expect.objectContaining({ path: 'assets/binary.bin', reason: 'binary_metadata_only' }), expect.objectContaining({ path: 'LICENSE.txt', reason: 'license_not_context' }), expect.objectContaining({ path: 'references/example.md', selected: true })]));
    expect(JSON.stringify(record)).not.toContain('SELECTED-INSTRUCTION-ONLY'); expect(JSON.stringify(record)).not.toContain('USER-REQUEST-CONTEXT'); expect(record.countId).not.toBeNull(); expect(record.reservationId).not.toBeNull();
    expect(item.service.results(result.id).workingContexts).toEqual(result.workingContexts); await reopen(item); expect(item.service.status(result.id).workingContexts).toEqual(result.workingContexts); expect((await item.service.start(item.request)).runId).toBe(result.id); expect(item.generate).toHaveLength(1);
  });
  it('supports the existing single-step task agent without creating tools, grants or new instructions from business metadata', async () => {
    const item = await setup('codex', true); const result = await run(item); expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); expect(result.workingContextCount).toBe(1); expect(item.generate[0]).not.toHaveProperty('tools'); expect(item.generate[0]!.instructions).not.toContain('선택 자료로 작성');
  });
  it('blocks an oversized final request before credential access or either provider call', async () => {
    const item = await setup('codex', false, 1024); const result = await run(item); expect(result).toMatchObject({ status: 'failed', error: { code: 'WORK_CONTEXT_SIZE_LIMIT' }, workingContexts: [] }); expect(item.gets).toBe(0); expect(item.count).toHaveLength(0); expect(item.generate).toHaveLength(0);
  });
  it('records count failure without claiming generation or provider acceptance', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'count') throw new ModelError('MODEL_COUNT_UNAVAILABLE', 'Internal count failure', 'not_started'); }; const result = await run(item);
    expect(result).toMatchObject({ status: 'failed', workingContexts: [{ countState: 'failed', generationState: 'not_started', reservationId: null }] }); expect(item.generate).toHaveLength(0);
  });
  it('keeps unknown generation usage and provenance across restart without replay', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'generate') throw new ModelError('MODEL_NETWORK_ERROR', 'Internal unknown response', 'unknown'); }; const result = await run(item);
    expect(result).toMatchObject({ status: 'attention_required', workingContexts: [{ countState: 'confirmed', generationState: 'unknown' }] }); expect(result.usage.reservedTokens).toBeGreaterThan(0); await reopen(item); expect(item.service.status(result.id).workingContexts).toEqual(result.workingContexts); expect(item.generate).toHaveLength(1);
  });
  it('stops after count-time cancellation and records no generation intent', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'count') item.service.cancel(item.store.listRuns()[0]!.id); }; const result = await run(item);
    expect(result).toMatchObject({ status: 'cancelled', workingContexts: [{ countState: 'confirmed', generationState: 'not_started', reservationId: null }] }); expect(item.generate).toHaveLength(0);
  });
  it('allows exact repeated preparation but rejects changed metadata within the same actual attempt', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'count') { const current = item.service.status(item.store.listRuns()[0]!.id).workingContexts[0]!; expect(item.store.workingContexts.prepare(current.manifest)).toBe(current.id); expect(() => item.store.workingContexts.prepare({ ...current.manifest, requestHash: 'f'.repeat(64) })).toThrow(); } }; const result = await run(item); expect(result.status).toBe('succeeded'); expect(item.service.events(result.id).filter(event => event.type === 'context.prepared')).toHaveLength(1);
  });
  it('marks in-flight durable intents unknown on startup and never reconstructs a request from the manifest', async () => {
    const item = await setup(); const result = await run(item); const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare("UPDATE runs SET status='running' WHERE id=?").run(result.id); db.prepare("UPDATE working_contexts SET generation_state='invocation_intent' WHERE run_id=?").run(result.id); db.prepare("DELETE FROM events WHERE run_id=? AND type='context.generation' AND json_extract(payload,'$.state')='response_confirmed'").run(result.id); db.close(); await reopen(item);
    expect(item.service.status(result.id)).toMatchObject({ status: 'attention_required', workingContexts: [{ generationState: 'unknown' }] }); expect(item.generate).toHaveLength(1);
  });
  it('withholds manifests from status and results after disclosure denial over authenticated HTTP', async () => {
    const item = await setup(); const result = await run(item); const server = createLocalServer(item.service, { bearerToken: 'test-only-context-http' }); const { origin } = await server.listen();
    try { const headers = { authorization: 'Bearer test-only-context-http' }; expect((await (await fetch(`${origin}/api/runs/${result.id}/results`, { headers })).json()).workingContextCount).toBe(1); item.store.blockDisclosure(result.id, 'RAG_DISCLOSURE_CHANGED'); const denied = await (await fetch(`${origin}/api/runs/${result.id}`, { headers })).json(); expect(denied).toMatchObject({ workingContexts: [], workingContextCount: 0, outcome: null }); expect((await fetch(`${origin}/api/runs/${result.id}/results`, { headers })).status).toBe(403); } finally { await server.close(); }
  });
  it.each(['extraField', 'workDefinitionHash', 'filePin', 'contextHash', 'countId', 'reservationId'] as const)('rejects %s record corruption against independent plan/node/model evidence', async field => {
    const item = await setup(); const result = await run(item), record = result.workingContexts[0]!; const manifest = structuredClone(record.manifest);
    const db = new DatabaseSync(join(item.directory, 'state.sqlite'));
    if (field === 'countId') db.prepare('UPDATE working_contexts SET count_id=? WHERE id=?').run('count_unknown', record.id);
    else if (field === 'reservationId') db.prepare('UPDATE working_contexts SET reservation_id=NULL WHERE id=?').run(record.id);
    else {
      if (field === 'extraField') Object.assign(manifest, { privateInput: 'must-never-expose' });
      if (field === 'workDefinitionHash') manifest.workDefinitionHash = 'f'.repeat(64);
      if (field === 'filePin') manifest.assets[0]!.files[0]!.sha256 = 'f'.repeat(64);
      if (field === 'contextHash') manifest.contextResultHash = 'f'.repeat(64);
      db.prepare('UPDATE working_contexts SET manifest=?,manifest_hash=? WHERE id=?').run(JSON.stringify(manifest), canonicalDigest(manifest), record.id);
    }
    db.close(); expect(() => item.service.status(result.id)).toThrow(); expect(item.generate).toHaveLength(1);
  });
  it('does not dispatch generation when its durable intent cannot commit', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'count') { const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.exec("CREATE TRIGGER reject_context_intent BEFORE UPDATE ON working_contexts WHEN NEW.generation_state='invocation_intent' BEGIN SELECT RAISE(ABORT,'test-only intent failure'); END;"); db.close(); } }; const result = await run(item);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'WORK_CONTEXT_RECORD_FAILED' }, usage: { reservedTokens: 0 } }); expect(item.generate).toHaveLength(0); expect(result.workingContexts[0]!.generationState).toBe('not_started');
  });
  it('retains attention-required after a confirmed response whose context journal cannot commit', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'generate') { const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.exec("CREATE TRIGGER reject_context_result BEFORE UPDATE ON working_contexts WHEN NEW.generation_state='response_confirmed' BEGIN SELECT RAISE(ABORT,'test-only result journal failure'); END;"); db.close(); } }; const result = await run(item);
    expect(result).toMatchObject({ status: 'attention_required', error: { code: 'WORK_CONTEXT_RECORD_UNKNOWN' }, usage: { consumedTokens: 8, reservedTokens: 0 }, workingContexts: [{ generationState: 'unknown' }] }); await reopen(item); expect((await item.service.start(item.request)).runId).toBe(result.id); expect(item.generate).toHaveLength(1);
  });
  it('cannot promote a refunded, undispatched generation to response-confirmed by editing only the row', async () => {
    const item = await setup(); item.hook = phase => { if (phase === 'generate') throw new ModelError('MODEL_REQUEST_REJECTED', 'Internal pre-start rejection', 'not_started'); }; const result = await run(item); expect(result.workingContexts[0]!.generationState).toBe('not_started'); expect(result.usage.reservedTokens).toBe(0);
    const db = new DatabaseSync(join(item.directory, 'state.sqlite')); db.prepare("UPDATE working_contexts SET generation_state='response_confirmed' WHERE run_id=?").run(result.id); db.close(); expect(() => item.service.status(result.id)).toThrow();
  });
});
