import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { ModelError } from '../../apps/runner/src/providers/model-provider.js';
import { RERANK_CONTRACT } from '../../apps/runner/src/providers/rerank-contract.js';
import { RunRagLedger } from '../../apps/runner/src/rag/run-ledger.js';
import { SqliteRagStore } from '../../apps/runner/src/rag/store.js';

/** Real HTTP/SQLite/search and production UI; provider and credential boundaries are explicitly test-only. */
const directory = await mkdtemp(join(tmpdir(), 'studio-reranker-ui-')); const store = new RunStore(join(directory, 'state.sqlite')); const secrets = new Map<string, string>(); let counted = 0; let generated = 0; let embeddings = 0; let outcome: 'reranked' | 'fallback' | 'failed' = 'reranked';
const service = new RunnerService(store, { available: true, async has(id) { return secrets.has(id); }, async get(id) { return secrets.get(id)!; }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } }, directory, {
  async countInputTokens() { counted++; return 10; },
  async generate(request) {
    generated++; const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    if (outcome === 'fallback') throw new ModelError('MODEL_REFUSAL', 'Internal test refusal', 'completed', false, usage);
    return { model: outcome === 'failed' ? 'wrong-model-identity' : request.model, text: JSON.stringify({ items: (request.content as { candidates: { id: string }[] }).candidates.map((item, i) => ({ id: item.id, score: i * 100 })) }), usage };
  },
}, undefined, { async embed() { embeddings++; throw new Error('Embedding must not be called by this keyword-only test'); } });
const server = createLocalServer(service, { bearerToken: 'internal-reranker-ui-test-only', uiDirectory: resolve('apps/runner-ui/dist') }); const { origin } = await server.listen(); const browser = await chromium.launch({ channel: 'chrome' });
function revoke(runId: string) {
  const ledger = new RunRagLedger(join(directory, 'rag', 'operations.sqlite')); const rag = new SqliteRagStore(join(directory, 'rag', 'generations.sqlite'));
  try { const principal = ledger.principal(runId); const current = rag.readCurrent(principal.scope, principal.subjectId); rag.replaceAccess(principal.scope, { expectedEpoch: current.epoch, subjects: [{ subjectId: principal.subjectId, groupIds: [] }], documents: current.documents.map(document => ({ ...document, tombstoned: true })) }); } finally { rag.close(); ledger.close(); }
}
try {
  await service.createProfile({ name: '같은 모델의 대화 연결', model: RERANK_CONTRACT.model, apiKey: 'test-only-not-live' });
  const workflow = createBasicWorkflow('검색 결과 재정렬 화면 검증'); workflow.inputs = { type: 'object', properties: {}, additionalProperties: false }; workflow.modelProfiles = { rank: { kind: 'reranker', requiredFeatures: ['rerank'] } };
  const input = createNode('input'), files = createNode('file_input'), index = createNode('knowledge'), search = createNode('retrieval'), output = createNode('output'); input.id = 'input'; files.id = 'files'; index.id = 'index'; search.id = 'search'; output.id = 'output';
  if (files.type !== 'file_input' || index.type !== 'knowledge' || search.type !== 'retrieval') throw new Error('factory'); files.label = '검색 문서 선택';
  files.config = { mimeTypes: ['text/plain'], maxFiles: 2, maxBytesPerFile: 2048 }; files.inputBindings = { files: { from: 'literal', value: [] } };
  index.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 0 } }; index.inputBindings = { documents: { from: 'node', nodeId: 'files', pointer: '/data', onMissing: 'error' } };
  search.config = { mode: 'keyword', topK: 1, candidateLimit: 2, maxContextTokens: 500, reranker: { modelProfile: 'rank', timeoutMs: 30000, onFailure: 'use_original' } }; search.inputBindings = { query: { from: 'literal', value: '배송' }, index: { from: 'node', nodeId: 'index', pointer: '/data', onMissing: 'error' } };
  // The final context string deliberately omits rerank metadata; the UI must still show actual durable stage evidence.
  output.inputBindings = { result: { from: 'node', nodeId: 'search', pointer: '/data/context', onMissing: 'error' } }; const nodes: Workflow['nodes'] = [input, files, index, search, output];
  const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } }); workflow.entryNodeId = 'input'; workflow.nodes = nodes; workflow.edges = nodes.slice(0, -1).map((node, i) => edge(node.id, nodes[i + 1]!.id));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const failures: string[] = []; page.on('pageerror', error => failures.push(error.message)); await page.goto(origin);
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    const pack = await buildPackage({ workflow, host }); await page.getByLabel('운영 ZIP 파일 선택').setInputFiles({ name: `${host}.zip`, mimeType: 'application/zip', buffer: Buffer.from(pack.bytes) });
    await expect(page.getByRole('combobox', { name: '재정렬 연결 rank', exact: true })).toBeVisible(); await expect(page.getByRole('combobox', { name: '재정렬 연결 rank', exact: true }).locator('option')).toHaveCount(1);
    await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); await expect(page.getByText('rank 모델 연결을 선택하세요.', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'AI 연결 추가하기', exact: true }).click(); await page.getByLabel('연결 이름', { exact: true }).fill('근거를 다시 정렬하는 연결'); await page.getByLabel('연결 종류', { exact: true }).selectOption('reranker');
  await expect(page.getByText(`${RERANK_CONTRACT.model} 고정`, { exact: false })).toBeVisible(); await expect(page.getByLabel('OpenAI 모델 ID', { exact: true })).toHaveCount(0); await page.getByLabel('API 키', { exact: true }).fill('test-only-not-live'); await page.getByRole('button', { name: '연결 저장', exact: true }).click(); await expect(page.getByText('이 PC에 연결을 저장했습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '실행 준비', exact: true }).click(); const profile = service.listProfiles().find(item => item.kind === 'reranker')!; const control = page.getByRole('combobox', { name: '재정렬 연결 rank', exact: true }); await expect(control.locator('option')).toHaveCount(2); await control.selectOption(profile.id);
  await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeEnabled(); assert.equal(counted, 0); assert.equal(generated, 0);
  const evidence = resolve('apps/runner-ui/artifacts'); await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'reranker-connection.png'), fullPage: true });
  for (const state of ['reranked', 'fallback', 'failed'] as const) {
    outcome = state; if (state !== 'reranked') { await page.getByRole('button', { name: '실행 준비', exact: true }).click(); await page.getByRole('button', { name: '준비 상태 확인', exact: true }).click(); await expect(page.getByRole('button', { name: '워크플로 실행', exact: true })).toBeEnabled(); }
    await page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await page.getByRole('heading', { name: '검색 문서 선택', exact: true }).waitFor();
    await page.getByLabel('파일 선택', { exact: true }).setInputFiles([{ name: '배송안내A.txt', mimeType: 'text/plain', buffer: Buffer.from('배송 안내 A의 원문입니다.') }, { name: '배송안내B.txt', mimeType: 'text/plain', buffer: Buffer.from('배송 안내 B의 원문입니다.') }]); await page.getByRole('button', { name: '선택한 파일로 진행', exact: true }).click();
    const title = state === 'reranked' ? '검색 결과를 다시 정렬했습니다' : state === 'fallback' ? '원래 검색 순위를 사용했습니다' : '검색 결과 재정렬을 중단했습니다'; await expect(page.getByText(title, { exact: true })).toBeVisible();
    if (state === 'failed') { await expect(page.getByText('RERANK_MODEL_MISMATCH', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '결과 내려받기', exact: true })).toHaveCount(0); }
    else await expect(page.locator('.result-content')).toContainText('배송 안내');
    if (state === 'fallback') {
      await expect(page.getByText('사유: MODEL_REFUSAL', { exact: true })).toBeVisible(); await page.screenshot({ path: join(evidence, 'reranker-fallback.png'), fullPage: true });
      // The old text is still visible when this new download action begins; the guarded results endpoint must deny it.
      let downloads = 0; const countDownload = () => { downloads++; }; page.on('download', countDownload); revoke(store.listRuns()[0]!.id);
      await page.getByRole('button', { name: '결과 내려받기', exact: true }).click(); await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible();
      await expect(page.locator('.result-content')).toHaveCount(0); assert.equal(downloads, 0); page.off('download', countDownload);
    }
    if (state === 'reranked') {
      let resultRequests = 0; const countResult = (request: { url(): string }) => { if (request.url().endsWith('/results')) resultRequests++; }; page.on('request', countResult);
      const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '결과 내려받기', exact: true }).click(); const download = await downloaded;
      assert.match(await readFile((await download.path())!, 'utf8'), /배송 안내/); assert.equal(resultRequests, 1); page.off('request', countResult);
      const artifactDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '내려받기', exact: true }).first().click();
      assert.match(await readFile((await (await artifactDownload).path())!, 'utf8'), /배송 안내/);
      // Revoke after a genuine allowed status but before the next events request, exercising the API-error cache-clearing path.
      const runId = store.listRuns()[0]!.id; const status = service.status.bind(service); let revoked = false;
      service.status = id => {
        const value = status(id);
        if (id === runId && !revoked) {
          revoke(runId); revoked = true;
        }
        return value;
      };
      await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible({ timeout: 12000 });
      service.status = status; assert.equal(revoked, true);
      await expect(page.locator('.result-content')).toHaveCount(0); await expect(page.getByRole('heading', { name: '작업 파일', exact: true })).toHaveCount(0); await expect(page.getByRole('region', { name: '검색 결과 재정렬 기록', exact: true })).toHaveCount(0); await expect(page.locator('.timeline li')).toHaveCount(0);
      await page.screenshot({ path: join(evidence, 'reranker-disclosure-blocked.png'), fullPage: true });
      // Reopening the run uses the minimal denied status path, without any previous result stored in history state.
      await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: workflow.name }).click();
      await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible(); await expect(page.locator('.result-content')).toHaveCount(0);
    }
  }
  assert.deepEqual(failures, []); assert.equal(counted, 3); assert.equal(generated, 3); assert.equal(embeddings, 0);
  process.stdout.write(JSON.stringify({ outcome: 'confirmed', realProviderRequests: 0, preparationProviderCalls: 0, internalFixtureCounts: { counted, generated, embeddings }, checks: ['three ZIP roles', 'fixed role save', 'same-model chat excluded', 'reranked/fallback/failed durable records', 'completion revocation clears prior UI content', 'minimal denied status on reopening', 'authenticated artifact download', 'fresh result downloads and denial before next poll'], pageErrors: failures.length, evidence }) + '\n');
} finally { await browser.close(); await service.shutdown(); await server.close(); store.close(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-reranker-ui-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); }
