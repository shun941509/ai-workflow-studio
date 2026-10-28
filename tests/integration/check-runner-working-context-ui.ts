import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createBasicWorkflow } from '@studio/spec';
import { applyWorkingContextPreset } from '@studio/workflow-core';
import { buildPackage, createTextResource } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { ModelError, type ModelRequest } from '../../apps/runner/src/providers/model-provider.js';

type Mode = 'confirmed' | 'count-failed' | 'unknown' | 'pending';
/** The only fabricated boundary is test-local model/key I/O; production UI, HTTP, CSP, archive and SQLite state are real. */
const directory = await mkdtemp(join(tmpdir(), 'studio-context-ui-')), secrets = new Map<string, string>();
const store = new RunStore(join(directory, 'state.sqlite')); let counts = 0, generations = 0;
let releasePending!: () => void; const pending = new Promise<void>(resolve => { releasePending = resolve; });
function mode(request: ModelRequest): Mode { const value = (request.content as { content: string }).content; if (!['confirmed', 'count-failed', 'unknown', 'pending'].includes(value)) throw new Error('Unexpected test input'); return value as Mode; }
const service = new RunnerService(store, { available: true, async has(id) { return secrets.has(id); }, async get(id) { return secrets.get(id)!; }, async set(id, value) { secrets.set(id, value); }, async delete(id) { secrets.delete(id); } }, directory, {
  async countInputTokens(request) { counts++; const current = mode(request); if (current === 'pending') await pending; if (current === 'count-failed' || current === 'pending') throw new ModelError('MODEL_COUNT_UNAVAILABLE', 'Test-only counting failure', 'not_started'); return 5; },
  async generate(request) { generations++; if (mode(request) === 'unknown') throw new ModelError('MODEL_NETWORK_ERROR', 'Test-only response unknown', 'unknown'); return { text: '검토할 초안', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } }; },
});
const server = createLocalServer(service, { bearerToken: 'test-only-context-browser', uiDirectory: resolve('apps/runner-ui/dist') });
const { origin } = await server.listen(), browser = await chromium.launch({ channel: 'chrome' });
try {
  const profile = await service.createProfile({ name: 'test-only-local-profile', model: 'contract-model', apiKey: 'test-only-no-live-key' });
  const runs: { id: string; name: string; mode: Mode }[] = [];
  for (const [index, current] of (['confirmed', 'count-failed', 'unknown', 'pending'] as const).entries()) {
    const workflow = createBasicWorkflow(`문맥 기록 ${current}`); workflow.inputs = true; workflow.outputs = true;
    workflow.completion = { version: 1, criteria: [{ id: 'text', label: '결과 형식 확인', kind: 'result_schema', schema: { type: 'string' } }] };
    workflow.workDefinition = { version: 1, id: 'context-browser', revision: 1, card: { id: 'card', title: '초안 업무', purpose: '검토할 초안 준비' }, role: { id: 'role', title: '작성 담당', responsibility: '근거 없는 사실을 추가하지 않음' }, task: { id: 'task', title: '초안 작성', goal: '고정 자료 참고', criterionIds: ['text'], assets: [], skills: [] }, harness: { context: ['start'], perform: ['work'], accept: ['finish'], deliver: ['finish'], selectedContext: ['guide'] } };
    const resources: Record<string, Uint8Array> = {};
    for (const alias of ['guide', 'excluded'] as const) {
      const resource = createTextResource({ id: alias, revision: 2, kind: 'instruction', name: alias, text: alias === 'guide' ? 'PRIVATE-INSTRUCTION-BODY-DO-NOT-RENDER' : 'PRIVATE-EXCLUDED-BODY-DO-NOT-RENDER' });
      workflow.resources[alias] = resource.reference; Object.assign(resources, resource.files);
      workflow.workDefinition.task.assets.push({ alias, kind: 'instruction', usage: 'instructions', purpose: alias === 'guide' ? '선택한 판단 지침' : '이번 요청에서 제외한 지침', required: alias === 'guide' });
    }
    const work = workflow.nodes.find(node => node.id === 'work')!; work.inputBindings.content = { from: 'node', nodeId: 'start', pointer: '/data', onMissing: 'error' }; work.inputBindings.context = { from: 'literal', value: { sourceText: 'PRIVATE-USER-SOURCE-DO-NOT-RENDER' } };
    const { packageHandle } = await service.importPackage((await buildPackage({ workflow: applyWorkingContextPreset(workflow), resources, host: (['codex', 'claude-code', 'opencode'] as const)[index % 3]! })).bytes);
    const started = await service.start({ packageHandle, requestId: `context-browser-${current}`, inputs: current, modelBindings: { 'text-default': profile.id } });
    if (current !== 'pending') await service.waitForIdle();
    else await expect.poll(() => service.status(started.runId).workingContexts.length).toBe(1);
    runs.push({ id: started.runId, name: workflow.name, mode: current });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } }), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const evidence = resolve('artifacts/ui/runner-working-context'); await mkdir(evidence, { recursive: true });
  const response = await page.goto(origin); assert.ok(response?.headers()['content-security-policy']); assert.ok(!response.headers()['content-security-policy']?.includes('unsafe-eval'));
  await expect(page.getByText('Runner 연결됨', { exact: true })).toBeVisible();
  for (const run of [...runs].reverse()) {
    await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: run.name }).click();
    const card = page.getByRole('region', { name: '업무 문맥 기록' }); await expect(card.getByRole('heading', { name: '업무 문맥과 전달 상태', exact: true })).toBeVisible();
    await expect(card).toContainText('선택 자료 1개 · 제외 자료 1개'); await expect(card).toContainText('업무 완료를 보장하지 않습니다.');
    const expected = { confirmed: '생성 응답·사용량 확인', 'count-failed': '계량 실패', unknown: '생성 결과 확인 불가', pending: '계량 호출 의도 기록' }[run.mode];
    await expect(card).toContainText(expected); if (run.mode === 'pending' || run.mode === 'count-failed') await expect(card).toContainText('생성 시작 전');
    await card.getByText('자료와 요청 근거 확인', { exact: true }).click();
    await card.getByText('선택 · guide · 버전 2', { exact: true }).click(); await card.getByText('제외 · excluded · 버전 2', { exact: true }).click();
    const record = service.status(run.id).workingContexts[0]!; await expect(card).toContainText(record.manifest.requestHash); await expect(card).toContainText(record.manifest.assets[0]!.sha256);
    await expect(card).toContainText('문맥에 포함'); await expect(card).toContainText('이용 조건은 모델 문맥에서 제외'); await expect(card).toContainText('이 요청의 문맥에 선택하지 않음');
    for (const forbidden of ['PRIVATE-INSTRUCTION-BODY', 'PRIVATE-EXCLUDED-BODY', 'PRIVATE-USER-SOURCE', 'test-only-no-live-key']) assert.ok(!(await page.locator('body').textContent())?.includes(forbidden));
    await page.screenshot({ path: join(evidence, `${run.mode}.png`), fullPage: true });
    if (run.mode === 'confirmed') {
      await page.setViewportSize({ width: 407, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: join(evidence, 'narrow.png'), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1060 });
      // A late fresh-download denial must remove context metadata, result and actions, then stay hidden after history/reopen.
      store.blockDisclosure(run.id, 'RAG_DISCLOSURE_CHANGED'); let downloads = 0; page.on('download', () => { downloads++; });
      await page.getByRole('button', { name: '결과 내려받기', exact: true }).click();
      await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible();
      await expect(card).toHaveCount(0); await expect(page.getByRole('button', { name: '결과 내려받기', exact: true })).toHaveCount(0); assert.equal(downloads, 0);
      await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: run.name }).click(); await expect(card).toHaveCount(0);
      await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible();
      assert.ok(!(await page.locator('body').textContent())?.includes(record.manifest.requestHash)); await page.screenshot({ path: join(evidence, 'withheld.png'), fullPage: true });
    }
  }
  // Revocation while the user only watches the polling page must clear the same metadata without a download action.
  const watching = runs.find(run => run.mode === 'unknown')!;
  await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: watching.name }).click();
  await expect(page.getByRole('region', { name: '업무 문맥 기록' })).toBeVisible(); store.blockDisclosure(watching.id, 'RAG_DISCLOSURE_CHANGED');
  await expect(page.getByRole('region', { name: '업무 문맥 기록' })).toHaveCount(0, { timeout: 10000 });
  releasePending(); await service.waitForIdle(); assert.equal(counts, 4); assert.equal(generations, 2); assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ status: 'confirmed', checks: ['strict CSP production UI', 'real manifests from three ZIP adapters', 'count intent distinct from delivery', 'count failure and unknown generation', 'confirmed response distinct from business quality', 'selected/excluded version/hash/files', 'no original bodies or keys', 'download denial, poll denial and reopened cache removal'], liveModelRequests: 0, testBoundaryCounts: counts, testBoundaryGenerations: generations, pageErrors: errors.length, evidence }) + '\n');
} finally {
  releasePending(); await browser.close(); await service.shutdown(); await server.close(); store.close();
  const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-context-ui-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true });
}
