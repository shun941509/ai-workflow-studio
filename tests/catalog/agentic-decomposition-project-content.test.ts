import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateJsonValue, validateWorkflowShape, type FileRef, type Workflow } from '@studio/spec';
import { buildPackage, inspectPackage, verifyResources } from '@studio/package-kit';
import { analyzeWorkflow, collectRequirements } from '@studio/workflow-core';
import type { Citation } from '@studio/rag-core';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { ModelRequest } from '../../apps/runner/src/providers/model-provider.js';
import { checkCatalog, digestBytes } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const root = resolve(import.meta.dirname, '../..'), catalog = JSON.parse(await readFile(join(root, 'catalog/official/catalog.json'), 'utf8')) as OfficialCatalog;
const entry = catalog.entries.find(value => value.id === 'EP-106')!, folder = join(root, entry.artifact!.rootPath), readme = await readFile(join(folder, 'README.md'), 'utf8');
const parsed = validateWorkflowShape(JSON.parse(await readFile(join(folder, 'workflow.json'), 'utf8'))); if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues));
const workflow = parsed.value, sample = JSON.parse(await readFile(join(folder, 'sample-input.json'), 'utf8')), assets: Record<string, Uint8Array> = {};
for (const file of entry.artifact!.files) if (file.path.startsWith('resources/')) assets[file.path] = await readFile(join(folder, file.path));
const hosts = ['codex', 'claude-code', 'opencode'] as const, sourceNames = ['delivery-policy.md', 'return-policy.md'];
const sources = sourceNames.map(name => assets[`resources/practice/${name}`]!);
const fixtures: { directory: string; store: RunStore; service: RunnerService }[] = [];
type Scenario = 'answered' | 'omitted_part' | 'abstain';
type Evidence = { id: string; text: string };
interface Research { status: string; result: { delivery: { subquestion: string; answer: string }; returns: { subquestion: string; answer: string }; integratedAnswer: string } | null; citations: Citation[]; stopReason: string; usage: { steps: number; rounds: number; queries: number; retrievedChunks: number; contextTokens: number } }

/** Only model/credential boundaries are test doubles. ZIP, uploads, file inspection, SQLite, BM25 and citations are real. */
async function setup(options: { host?: typeof hosts[number]; scenario?: Scenario; registered?: boolean; definition?: Workflow } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ep106-')), store = new RunStore(join(directory, 'state.sqlite')), secrets = new Map<string, string>(), calls = { count: 0, generate: 0 }, requests: ModelRequest[] = [];
  const service = new RunnerService(store, { available: options.registered !== false, async has(id) { return secrets.has(id); }, async get(id) { const value = secrets.get(id); if (!value) throw new Error('No test credential'); return value; }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } }, directory, {
    async countInputTokens() { calls.count++; return 10; },
    async generate(request) {
      calls.generate++; requests.push(request); const evidence = (request.content as { evidence: Evidence[] }).evidence;
      let decision: unknown;
      if (calls.generate === 1) decision = { action: 'search', queries: [{ index: 'i1', query: options.scenario === 'abstain' ? '배송비' : '배송' }, { index: 'i1', query: options.scenario === 'abstain' ? '반품 비용' : '반품' }], resultJson: '', evidenceIds: [] };
      else if (options.scenario === 'abstain') decision = { action: 'abstain', queries: [], resultJson: '', evidenceIds: [] };
      else {
        const delivery = evidence.find(value => value.text.includes('2~4영업일')), returns = evidence.find(value => value.text.includes('14일'));
        if (!delivery || !returns) throw new Error('Actual independent source facts were not retrieved');
        const result = { delivery: { subquestion: '일반 지역 배송 기간은?', answer: '결제가 확정된 다음 영업일부터 2~4영업일입니다.' }, ...(options.scenario === 'omitted_part' ? {} : { returns: { subquestion: '미사용 상품 반품 접수 조건은?', answer: '수령일부터 14일 이내이며 미사용·원래 포장·구성품 보존이 필요합니다.' } }), integratedAnswer: '배송 기간과 반품 접수 조건을 각각 확인해야 하며 특정 주문의 완료를 뜻하지 않습니다.', limitations: ['원작 가상 정책이며 실제 주문 조회나 요청 접수를 하지 않았습니다.'], externalActions: 'none' };
        decision = { action: 'answer', queries: [], resultJson: JSON.stringify(result), evidenceIds: [delivery.id, returns.id] };
      }
      return { model: request.model, text: JSON.stringify(decision), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    },
  });
  fixtures.push({ directory, store, service }); const modelBindings: Record<string, string> = {};
  if (options.registered !== false) modelBindings['project-model'] = (await service.createProfile({ name: 'Test-only Agentic boundary', model: 'gpt-5.4-mini-2026-03-17', apiKey: 'test-only-not-a-live-key' })).id;
  const built = await buildPackage({ workflow: options.definition ?? workflow, resources: assets, host: options.host ?? 'codex' }), imported = await service.importPackage(built.bytes);
  return { directory, store, service, calls, requests, request: { packageHandle: imported.packageHandle, requestId: 'catalog-purpose-check', inputs: sample, modelBindings } };
}
async function run(options: Parameters<typeof setup>[0] & { input?: unknown; bytes?: Uint8Array[] } = {}) {
  const item = await setup(options); const run = await item.service.start({ ...item.request, inputs: options.input ?? sample }); await item.service.waitForIdle(); const wait = item.service.status(run.runId).waits[0]!;
  const refs: FileRef[] = []; for (const [index, bytes] of (options.bytes ?? sources).entries()) refs.push(item.service.uploadWaitFile(run.runId, wait.id, `source-${index}`, sourceNames[index]!, 'text/markdown', bytes));
  item.service.respondWait(run.runId, wait.id, { requestId: 'upload-selected', response: refs }); await item.service.waitForIdle(); return { ...item, refs, run: item.service.status(run.runId) };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.store.close(); if (dirname(resolve(item.directory)) !== resolve(tmpdir()) || !item.directory.includes('studio-ep106-')) throw new Error('unsafe cleanup'); await rm(item.directory, { recursive: true, force: true }); } });

describe('EP-106 original source contract and operational materials', () => {
  it('preserves the approved purpose, core blocks and acceptance without promoting actual-model or host evidence', async () => {
    expect(entry.definition).toEqual({ purpose: '복합 질문을 나눠 검색', blocksAndConnections: '`agent·tool·retrieval·merge` / 등록 검색', inputOutput: '복합 질문 → 통합 답변', acceptanceCriteria: '하위 질문 포함, 검색 한도 준수' });
    expect(entry.state).toBe('implemented'); expect(entry.verificationRecords).toEqual([]); expect(analyzeWorkflow(workflow).filter(value => value.severity === 'error')).toEqual([]); expect(validateJsonValue(workflow.inputs, sample).valid).toBe(true);
    expect(workflow.nodes.map(value => value.type)).toEqual(expect.arrayContaining(entry.blocks)); expect(collectRequirements(workflow).capabilities.every(cap => entry.requiredCapabilities.includes(cap))).toBe(true);
    expect(readme).toContain(entry.definition.acceptanceCriteria); expect(readme).toContain('tool 노드가 모델에게 임의 검색/MCP 권한을 주는 구조가 아닙니다'); expect(readme).toContain('unverified'); expect(readme).toContain('제3자 권리를 부여하지 않습니다');
    expect(workflow.nodes.find(value => value.type === 'agent')!.attachments).toEqual([]); for (const file of entry.artifact!.files) expect(digestBytes(await readFile(join(folder, file.path)))).toBe(file.sha256);
    const spec = JSON.parse(await readFile(join(root, 'tests/catalog/project-specs/EP-106.json'), 'utf8')); expect(spec.sourceContract).toEqual(entry.definition); expect(spec.artifactSha256).toBe(entry.artifact!.sha256); expect(spec.actualModelStatus).toBe('unverified'); expect(Object.values(spec.actualHostsStatus)).toEqual(['unverified', 'unverified', 'unverified']);
    const report = await checkCatalog({ ...catalog, entries: [entry] }, { root, requireCompleteInventory: false }); expect(report.issues).toEqual([]); expect(report.counts.usableProjects).toBe(0); expect(report.counts.publishedProjects).toBe(0);
    for (const id of ['EP-107', 'EP-110']) { expect(catalog.entries.find(value => value.id === id)!.state).toBe('planned'); expect(catalog.entries.find(value => value.id === id)!.artifact).toBeUndefined(); }
  });
  it('contains distinct original documents, immutable descriptors and no production answer or test fixture', () => {
    expect(verifyResources(workflow.resources, new Map(Object.entries(assets))).size).toBe(1); expect(digestBytes(sources[0]!)).not.toBe(digestBytes(sources[1]!)); expect(new TextDecoder().decode(sources[0])).toContain('CLOUD-DELIVERY-1'); expect(new TextDecoder().decode(sources[1])).toContain('CLOUD-RETURN-1');
    expect(entry.artifact!.files.every(file => !/fixture|verification|\.test\.|project-specs|answer\.json/.test(file.path))).toBe(true);
    const modified = new Map(Object.entries(assets)); modified.set('resources/practice/delivery-policy.md', new TextEncoder().encode('tampered')); expect(() => verifyResources(workflow.resources, modified)).toThrow();
  });
  it.each(hosts)('%s downloadable operational ZIP preserves the exact source files and fixed profile requirement', async host => {
    // Rebuild from tracked sources: ignored local download artifacts are convenient outputs, never a hidden CI dependency.
    const zip = await inspectPackage((await buildPackage({ workflow, resources: assets, host })).bytes); expect(zip.workflow).toEqual(workflow); expect(zip.manifest.purpose).toBe('production'); expect(zip.manifest.compatibility.host.verification).toBe('unverified');
    for (const [path, bytes] of Object.entries(assets)) expect(new Uint8Array(zip.files.get(path)!)).toEqual(new Uint8Array(bytes));
    const item = await setup({ host, registered: false }); const detail = await item.service.inspect(item.request.packageHandle); expect(detail.modelRequirements).toMatchObject([{ alias: 'project-model', kind: 'chat', constraint: { contractId: 'openai-agentic-keyword-abstain-v1', model: 'gpt-5.4-mini-2026-03-17' } }]);
    expect((await item.service.validate(item.request.packageHandle, {})).issues.filter(value => value.severity === 'error').map(value => value.code)).toEqual(['MODEL_PROFILE_REQUIRED']); await expect(item.service.start(item.request)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' }); expect(item.store.listRuns()).toHaveLength(0); expect(item.calls).toEqual({ count: 0, generate: 0 });
  });
});

describe('EP-106 actual search and two-question result contract with a test-only model', () => {
  it.each(hosts)('%s ZIP executes two planned searches, integrates different source documents and charges one shared budget', async host => {
    const item = await run({ host }); expect(item.run.status, JSON.stringify(item.run.error)).toBe('succeeded'); const data = (item.run.result as { data: { research: Research; firstFileIntegrity: { file: FileRef; integrity: string }; scopeSearch: { citations: Citation[] } } }).data;
    expect(data.firstFileIntegrity).toEqual({ file: item.refs[0], integrity: 'verified' }); expect(data.scopeSearch.citations.length).toBeGreaterThan(0); expect(data.research.status).toBe('answered'); expect(data.research.result?.delivery.subquestion).toContain('배송'); expect(data.research.result?.returns.subquestion).toContain('반품'); expect(data.research.result?.integratedAnswer).toContain('배송 기간과 반품 접수 조건'); expect(validateJsonValue(workflow.outputs, data).valid).toBe(true);
    expect(new Set(data.research.citations.map(citation => citation.chunk.document.originalSha256))).toEqual(new Set(sources.map(bytes => createHash('sha256').update(bytes).digest('hex'))));
    for (const citation of data.research.citations) { const index = item.refs.findIndex(file => file.id === citation.chunk.document.documentId); expect(index).toBeGreaterThanOrEqual(0); expect(citation.chunk.location.encoding).toBe('utf8'); expect(new TextDecoder().decode(sources[index]!.slice(citation.chunk.location.start, citation.chunk.location.end))).toBe(citation.quote); expect(citation.index.scope.projectId).toBe(item.run.id); }
    expect(item.calls).toEqual({ count: 2, generate: 2 }); expect(item.run.usage).toMatchObject({ modelCalls: 2, consumedTokens: 60, reservedTokens: 0 }); expect(data.research.usage).toMatchObject({ steps: 4, queries: 2, rounds: 1 }); expect(data.research.usage.retrievedChunks).toBeLessThanOrEqual(30); expect(data.research.usage.contextTokens).toBeLessThanOrEqual(6000);
    const journal = item.store.agentic.get(item.run.id, 'research'); expect(journal.session.operations.map(op => op.request.kind)).toEqual(['model', 'query', 'query', 'model']); expect(journal.records.every(record => record.resultHash)).toBe(true); expect(JSON.stringify(item.service.events(item.run.id).filter(event => event.type.startsWith('agentic.')))).not.toContain('가상 구름서가');
  });
  it('rejects an answer that drops the return subquestion instead of claiming that the compound question is complete', async () => {
    const item = await run({ scenario: 'omitted_part' }); expect(item.run.status).toBe('failed'); expect(item.run.error?.code).toBe('AGENTIC_RESULT_INVALID'); expect(item.run.result).toBeNull(); expect(item.calls.generate).toBe(2); expect(item.run.usage.consumedTokens).toBe(60);
  });
  it('related source evidence without fee facts yields an explicit abstention, not invented amounts or a clarification claim', async () => {
    const item = await run({ scenario: 'abstain', input: { question: '배송비와 반품 비용은 각각 정확히 얼마인가요?' } }); expect(item.run.status).toBe('succeeded'); const research = (item.run.result as { data: { research: Research } }).data.research; expect(research).toMatchObject({ status: 'insufficient_evidence', result: null, citations: [], stopReason: 'model_abstained' }); const state = item.store.agentic.get(item.run.id, 'research'); expect(state.evidence.length).toBeGreaterThan(0); expect(state.evidence.some(value => value.citation.quote.includes('금액'))).toBe(true); expect(item.calls.generate).toBe(2);
  });
  it('a missing user question is rejected before file selection or model accounting begins', async () => {
    const item = await setup(); await expect(item.service.start({ ...item.request, inputs: {} })).rejects.toMatchObject({ code: 'INPUT_INVALID' }); expect(item.store.listRuns()).toHaveLength(0); expect(item.calls).toEqual({ count: 0, generate: 0 });
  });
  it('the root model-call cap blocks the second decision while retaining the first call and both actual searches', async () => {
    const bounded = structuredClone(workflow); bounded.policy.limits.maxModelCalls = 1; const item = await run({ definition: bounded }); expect(item.run.status).toBe('blocked'); expect(item.run.error?.code).toBe('BUDGET_EXCEEDED'); expect(item.calls.generate).toBe(1); expect(item.run.usage).toMatchObject({ modelCalls: 1, consumedTokens: 30, reservedTokens: 0 }); expect(item.store.agentic.get(item.run.id, 'research').session.operations.filter(op => op.request.kind === 'query' && op.status === 'settled')).toHaveLength(2);
  });
  it('invalid UTF-8 is rejected before any planned model request', async () => {
    const item = await run({ bytes: [new Uint8Array([0xc3, 0x28]), sources[1]!] }); expect(item.run.status).toBe('failed'); expect(item.run.error?.code).toBe('RAG_TEXT_ENCODING'); expect(item.run.result).toBeNull(); expect(item.calls).toEqual({ count: 0, generate: 0 });
  });
});
