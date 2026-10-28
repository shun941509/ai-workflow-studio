import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createBasicWorkflow, createNode, type Workflow } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

/** Exercises the actual production UI, strict CSP, HTTP, SQLite and three ZIP adapters without model or key access. */
const directory = await mkdtemp(join(tmpdir(), 'studio-outcome-ui-'));
const store = new RunStore(join(directory, 'state.sqlite')); let calls = 0;
const service = new RunnerService(store, { available: false, async has() { return false; }, async get() { throw new Error('No keys'); }, async set() { throw new Error('No keys'); }, async delete() {} }, directory, {
  async countInputTokens() { calls++; throw new Error('No provider calls'); }, async generate() { calls++; throw new Error('No provider calls'); },
});
const server = createLocalServer(service, { bearerToken: 'test-only-outcome-browser-token', uiDirectory: resolve('apps/runner-ui/dist') });
const { origin } = await server.listen(); const browser = await chromium.launch({ channel: 'chrome' });
try {
  const runs: { name: string; id: string; label: string }[] = [];
  for (const [index, host] of (['codex', 'claude-code', 'opencode'] as const).entries()) {
    const name = ['명시 기준을 충족한 결과', '조건을 보완해야 하는 결과', '기준 없는 기존 설계'][index]!;
    const input = createNode('input'), output = createNode('output'); input.id = 'input'; output.id = 'output'; output.inputBindings = { result: { from: 'node', nodeId: 'input', pointer: '/data', onMissing: 'error' } };
    const workflow: Workflow = { ...createBasicWorkflow(name), inputs: true, outputs: true, entryNodeId: 'input', modelProfiles: {}, nodes: [input, output], edges: [{ id: 'input_output', from: { nodeId: 'input', port: 'next' }, to: { nodeId: 'output', port: 'in' } }] };
    if (index < 2) workflow.completion = { version: 1, criteria: [{ id: 'ready', label: '필수 내용이 준비됨', kind: 'result_schema', schema: { type: 'object', properties: { ready: { const: true } }, required: ['ready'] } }] };
    const { packageHandle } = await service.importPackage((await buildPackage({ workflow, host })).bytes);
    const run = await service.start({ packageHandle, requestId: `outcome-${host}`, inputs: { ready: index !== 1, outcome: 'complete' }, modelBindings: {} }); await service.waitForIdle();
    assert.equal(service.status(run.runId).status, 'succeeded'); runs.push({ name, id: run.runId, label: ['업무 기준 충족', '업무 기준 미충족', '업무 완료 미평가'][index]! });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const evidence = resolve('artifacts/ui/runner-completion'); await mkdir(evidence, { recursive: true });
  await page.goto(origin); await expect(page.getByText('Runner 연결됨', { exact: true })).toBeVisible();
  for (const run of runs) {
    await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: run.name }).click();
    await expect(page.locator('.run-summary').getByText('실행 완료', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: run.label, exact: true })).toBeVisible();
    await expect(page.locator('.result-content')).toContainText('"outcome": "complete"');
    if (run.label === '업무 기준 충족') {
      await page.getByText('판정 근거 확인', { exact: true }).click(); await expect(page.getByRole('region', { name: '업무 완료 판단' })).toContainText(`${run.id}:output`);
      await page.screenshot({ path: join(evidence, 'criteria-met.png'), fullPage: true });
      // A fresh download denial clears the assessment as well as result/event caches before the next periodic poll.
      store.blockDisclosure(run.id, 'RAG_DISCLOSURE_CHANGED'); let downloads = 0; const download = () => { downloads++; }; page.on('download', download);
      await page.getByRole('button', { name: '결과 내려받기', exact: true }).click();
      await expect(page.getByText('자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다.', { exact: false })).toBeVisible();
      await expect(page.getByRole('region', { name: '업무 완료 판단' })).toHaveCount(0); await expect(page.locator('.result-content')).toHaveCount(0); assert.equal(downloads, 0); page.off('download', download);
      await page.screenshot({ path: join(evidence, 'assessment-withheld.png'), fullPage: true });
      await page.getByRole('button', { name: '실행 기록', exact: true }).click(); await page.getByRole('button').filter({ hasText: run.name }).click(); await expect(page.getByRole('region', { name: '업무 완료 판단' })).toHaveCount(0);
    } else if (run.label === '업무 기준 미충족') await expect(page.getByRole('region', { name: '업무 완료 판단' })).toContainText('명시한 결과 조건을 충족하지 못했습니다.');
    else await expect(page.getByRole('region', { name: '업무 완료 판단' })).toContainText('명시한 완료 기준이 없습니다.');
  }
  assert.equal(calls, 0); assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ status: 'confirmed', checks: ['strict CSP production UI', 'three ZIP adapters', 'engine success separate from criteria assessment', 'hash-bound evidence view', 'legacy remains unassessed', 'denial clears current and reopened assessment'], providerRequests: calls, pageErrors: errors.length, evidence }) + '\n');
} finally {
  await browser.close(); await service.shutdown(); await server.close(); store.close();
  // Cleanup is limited to the verified fresh test directory; the production UI build and evidence remain available.
  const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-outcome-ui-')) throw new Error('Unsafe cleanup'); await rm(target, { recursive: true, force: true });
}
