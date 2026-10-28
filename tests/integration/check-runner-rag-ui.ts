import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createBasicWorkflow, createNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

/** Real production UI + local HTTP/SQLite, with explicitly test-only credential storage and fail-on-call providers. */
const directory = await mkdtemp(join(tmpdir(), 'studio-rag-ui-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); let calls = 0;
const failCall = async (): Promise<never> => { calls++; throw new Error('No provider call is allowed during import/connection/preparation UI tests'); };
const service = new RunnerService(store, { available: true, async has(key) { return secrets.has(key); }, async get(key) { return secrets.get(key)!; }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } }, directory, { countInputTokens: failCall, generate: failCall }, undefined, { embed: failCall });
const server = createLocalServer(service, { bearerToken: 'internal-rag-ui-test-only', uiDirectory: resolve('apps/runner-ui/dist') }); const { origin } = await server.listen(); const browser = await chromium.launch({ channel: 'chrome' });
try {
  await service.createProfile({ name: '기존 대화 연결', model: 'gpt-5.4-mini-2026-03-17', apiKey: 'test-only-not-a-live-key' });
  const workflow = createBasicWorkflow('문서 임베딩 연결 검증'); workflow.outputs = true;
  workflow.modelProfiles.embedding_default = { kind: 'embedding', requiredFeatures: ['embedding'] };
  const entry = createNode('input'), files = createNode('file_input'), index = createNode('knowledge'), output = createNode('output'); entry.id = 'input'; files.id = 'files'; index.id = 'index'; output.id = 'output';
  if (files.type !== 'file_input' || index.type !== 'knowledge') throw new Error('factory');
  files.config = { mimeTypes: ['text/plain'], maxFiles: 1, maxBytesPerFile: 1024 }; files.inputBindings.files = { from: 'literal', value: [] };
  index.config = { operation: 'build', profile: 'local-run-embedding-v1', indexSettings: { kind: 'vector', chunkSize: 1000, chunkOverlap: 100, embeddingProfile: 'embedding_default' } };
  index.inputBindings.documents = { from: 'node', nodeId: 'files', pointer: '/data', onMissing: 'error' }; output.inputBindings.result = { from: 'node', nodeId: 'index', pointer: '/data', onMissing: 'error' };
  const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
  workflow.entryNodeId = entry.id; workflow.nodes = [entry, files, index, output]; workflow.edges = [edge('input', 'files'), edge('files', 'index'), edge('index', 'output')];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const failures: string[] = []; page.on('pageerror', error => failures.push(error.message)); await page.goto(origin);
  // All three real ZIPs expose only referenced embedding aliases, although an unused chat declaration is retained.
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    const built = await buildPackage({ workflow, host });
    await page.getByLabel('운영 ZIP 파일 선택').setInputFiles({ name: `${host}.zip`, mimeType: 'application/zip', buffer: Buffer.from(built.bytes) });
    await expect(page.getByRole('heading', { name: workflow.name, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '임베딩 연결 embedding_default', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /대화·작업 연결/ })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '임베딩 연결 embedding_default', exact: true }).locator('option')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '준비 상태 확인', exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click();
  await expect(page.getByText('embedding_default 모델 연결을 선택하세요.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeDisabled();
  const missingEvidence = resolve('apps/runner-ui/artifacts/rag-connection-required.png'); await mkdir(dirname(missingEvidence), { recursive: true }); await page.screenshot({ path: missingEvidence, fullPage: true }); assert.equal(calls, 0);
  const input = page.locator('form textarea'); await input.fill('화면 이동 후에도 보존할 질문');
  await page.getByRole('button', { name: 'AI 연결 추가하기', exact: true }).click();
  await page.getByLabel('연결 이름', { exact: true }).fill('문서 검색용 연결'); await page.getByLabel('OpenAI 모델 ID', { exact: true }).fill('작성 중인 대화 모델');
  await page.getByLabel('연결 종류', { exact: true }).selectOption('embedding'); await expect(page.getByText('text-embedding-3-small · 256차원 고정', { exact: false })).toBeVisible();
  await page.getByLabel('연결 종류', { exact: true }).selectOption('chat'); await expect(page.getByLabel('OpenAI 모델 ID', { exact: true })).toHaveValue('작성 중인 대화 모델');
  await page.getByLabel('연결 종류', { exact: true }).selectOption('embedding'); await page.getByLabel('API 키', { exact: true }).fill('test-only-not-a-live-key'); await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect(page.getByText('이 PC에 연결을 저장했습니다.', { exact: true })).toBeVisible(); await expect(page.getByLabel('API 키', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '실행 준비', exact: true }).click(); await expect(input).toHaveValue('화면 이동 후에도 보존할 질문');
  const control = page.getByRole('combobox', { name: '임베딩 연결 embedding_default', exact: true }); await expect(control.locator('option')).toHaveCount(2);
  const profile = service.listProfiles().find(item => item.kind === 'embedding')!; await control.selectOption(profile.id);
  // Delay the genuine service result at a test-only timing seam; browser cookie/Origin/CSRF checks stay intact.
  const validate = service.validate.bind(service); let release!: () => void; let fetched!: (ready: boolean) => void; const held = new Promise<void>(resolve => { release = resolve; }); const requested = new Promise<boolean>(resolve => { fetched = resolve; });
  service.validate = async (...args) => { const response = await validate(...args); fetched(response.ready); await held; return response; };
  await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); const wasReady = await requested; await control.selectOption(''); await control.selectOption(profile.id); release(); assert.equal(wasReady, true);
  await expect(page.getByRole('button', { name: '준비 상태 확인', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeDisabled();
  await expect(page.getByText('연결과 실행 기능이 준비되었습니다.', { exact: false })).toHaveCount(0); service.validate = validate;
  await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AI 연결', exact: true }).click(); await page.getByRole('button', { name: '실행 준비', exact: true }).click();
  await expect(control).toHaveValue(profile.id); await expect(input).toHaveValue('화면 이동 후에도 보존할 질문'); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeEnabled();
  assert.equal(calls, 0); assert.equal(store.listRuns().length, 0); assert.deepEqual(failures, []);
  const evidence = resolve('apps/runner-ui/artifacts/rag-connections.png'); await mkdir(dirname(evidence), { recursive: true }); await page.screenshot({ path: evidence, fullPage: true });
  process.stdout.write(JSON.stringify({ outcome: 'confirmed', checks: ['three host imports', 'required aliases only', 'kind filtering', 'missing credential readiness', 'fixed embedding save', 'typed chat field preserved', 'package/input/binding preserved', 'stale ready rejected', 'fresh readiness'], modelCalls: calls, runsStarted: 0, pageErrors: failures.length, evidence, missingEvidence }) + '\n');
} finally {
  await browser.close(); await service.shutdown(); await server.close(); store.close(); const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-rag-ui-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true });
}
