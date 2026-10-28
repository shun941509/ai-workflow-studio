import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';
import { REQUEST_INTENT_PREFIX } from '../../apps/runner-ui/src/request-intent.js';

let directory: string, browser: Browser;
const fixtures: { store: RunStore; service: RunnerService; server: ReturnType<typeof createLocalServer> }[] = [];

/** Bundle the real React app into a test-owned directory; no production build or running server is replaced. */
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-request-recovery-')); const ui = join(directory, 'ui'); await mkdir(ui);
  await build({ stdin: { contents: "import { createRoot } from 'react-dom/client'; import { App } from './App'; createRoot(document.getElementById('root')).render(<App />);", resolveDir: resolve('apps/runner-ui/src'), loader: 'tsx' }, outfile: join(ui, 'app.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(ui, 'index.html'), '<!doctype html><html lang="ko"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  browser = await chromium.launch({ channel: 'chrome' });
}, 30000);
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.service.shutdown(); await item.server.close(); item.store.close(); } });
afterAll(async () => {
  await browser?.close();
  if (directory) { const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-request-recovery-')) throw new Error('Unsafe test cleanup'); await rm(target, { recursive: true, force: true }); }
});

/** Real ZIP, SQLite, HTTP authentication and execution; the test drops only an already accepted HTTP response. */
async function setup() {
  const data = await mkdtemp(join(directory, 'run-')), store = new RunStore(join(data, 'state.sqlite'));
  const service = new RunnerService(store, { available: false, async has() { return false; }, async get(): Promise<never> { throw new Error('No model credentials'); }, async set(): Promise<never> { throw new Error('No model credentials'); }, async delete() {} }, data, { async countInputTokens(): Promise<never> { throw new Error('No model calls'); }, async generate(): Promise<never> { throw new Error('No model calls'); } });
  const workflow = createBasicWorkflow('요청 복구 검증'); const input = createNode('input'), output = createNode('output'); input.id = 'input'; output.id = 'output';
  output.inputBindings.result = { from: 'node', nodeId: input.id, pointer: '/data', onMissing: 'error' };
  Object.assign(workflow, { inputs: { type: 'object', properties: { text: { type: 'string', title: '작업 내용' } }, required: ['text'], additionalProperties: false }, outputs: true, modelProfiles: {}, entryNodeId: input.id, nodes: [input, output], edges: [{ id: 'result', from: { nodeId: input.id, port: 'next' }, to: { nodeId: output.id, port: 'in' } }] });
  await service.importPackage((await buildPackage({ workflow, host: 'codex' })).bytes);
  const server = createLocalServer(service, { bearerToken: 'test-only-request-recovery', uiDirectory: join(directory, 'ui') }); const { origin } = await server.listen(); fixtures.push({ store, service, server });
  const context = await browser.newContext(), page = await context.newPage(); const startupErrors: string[] = []; page.setDefaultTimeout(7000);
  // Keep boot diagnostics bounded and metadata-only: never print request bodies, cookies, CSRF or credentials.
  page.on('pageerror', error => startupErrors.push(`page: ${error.message.slice(0, 1200)}`));
  page.on('console', message => { if (message.type() === 'error') startupErrors.push(`console: ${message.text().slice(0, 1200)}`); });
  page.on('response', response => { if (response.status() >= 400) startupErrors.push(`http: ${new URL(response.url()).pathname} ${response.status()}`); });
  try { await page.goto(origin); await page.getByRole('button', { name: '요청 복구 검증' }).click(); }
  catch (error) { await context.close(); throw new Error(`Runner UI boot failed: ${JSON.stringify(startupErrors.slice(0, 12))}`, { cause: error }); }
  await page.getByLabel('작업 내용').fill('민감한 입력: 저장소에 남기지 않습니다'); await page.getByRole('button', { name: '준비 상태 확인' }).click();
  await page.getByText('연결과 실행 기능이 준비되었습니다.', { exact: false }).waitFor();
  return { store, service, page, context, origin };
}

describe('Runner browser start request recovery', () => {
  it.each(['lost', 'malformed'] as const)('keeps one real run when the accepted response is %s and the edited form is retried', async failure => {
    const item = await setup(); const bodies: string[] = []; let acceptedStatus = 0;
    try {
      await item.page.route('**/api/runs', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        bodies.push(route.request().postData()!);
        if (bodies.length === 1) {
          const response = await route.fetch({ headers: { ...await route.request().allHeaders(), 'sec-fetch-site': 'same-origin' } }); acceptedStatus = response.status();
          if (failure === 'lost') await route.abort('failed'); else await route.fulfill({ status: 202, contentType: 'application/json', body: '{broken' });
        }
        else await route.continue();
      });
      await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await item.page.getByRole('alert').waitFor();
      expect(await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
      await item.page.getByLabel('작업 내용').fill('바뀐 입력은 재시도에 쓰면 안 됩니다');
      const local = await item.page.evaluate(() => Object.entries(localStorage));
      expect(local).toEqual([[REQUEST_INTENT_PREFIX + JSON.parse(bodies[0]!).requestId, 'pending']]);
      await item.page.getByRole('button', { name: '같은 요청으로 재시도', exact: true }).click();
      await item.page.getByRole('heading', { name: '실행 상태와 결과' }).waitFor(); await item.service.waitForIdle();
      expect(acceptedStatus).toBe(202); expect(bodies).toHaveLength(2); expect(item.store.listRuns()).toHaveLength(1);
      expect(bodies[1]).toBe(bodies[0]); expect(item.store.listRuns()[0]!.result).toMatchObject({ data: { text: '민감한 입력: 저장소에 남기지 않습니다' } });
      expect(await item.page.evaluate(() => Object.entries(localStorage))).toEqual([]);
    } finally { await item.context.close(); }
  }, 30000);

  it('finds the accepted run after reload using only its saved UUID and never posts again', async () => {
    const item = await setup(); let posts = 0;
    try {
      await item.page.route('**/api/runs', async route => {
        if (route.request().method() !== 'POST') return route.continue(); posts++;
        await route.fetch({ headers: { ...await route.request().allHeaders(), 'sec-fetch-site': 'same-origin' } }); await route.abort('failed');
      });
      await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await item.page.getByRole('alert').waitFor(); await item.page.reload();
      await item.page.getByRole('heading', { name: '이전 실행을 찾았습니다' }).waitFor(); await item.page.getByRole('button', { name: /이전 실행 열기/ }).click();
      await item.page.getByRole('heading', { name: '실행 상태와 결과' }).waitFor(); expect(posts).toBe(1); expect(item.store.listRuns()).toHaveLength(1);
      expect(await item.page.evaluate(() => Object.entries(localStorage))).toEqual([]);
    } finally { await item.context.close(); }
  }, 30000);

  it('retains not_found across reload and requires an explicit separate execution without reconstructing old input', async () => {
    const item = await setup(); const bodies: string[] = [];
    try {
      await item.page.route('**/api/runs', async route => {
        if (route.request().method() !== 'POST') return route.continue(); bodies.push(route.request().postData()!);
        if (bodies.length === 1) await route.abort('failed'); else await route.continue();
      });
      await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await item.page.getByRole('alert').waitFor(); await item.page.reload();
      await item.page.getByText('원래 입력은 저장하지 않았으므로 조회만 할 수 있습니다.').waitFor();
      await item.page.getByRole('button', { name: '접수 여부 확인', exact: true }).click(); await item.page.getByText(/현재 접수 기록을 찾지 못했습니다/).waitFor();
      expect(item.store.listRuns()).toHaveLength(0); expect(bodies).toHaveLength(1); expect(await item.page.getByRole('button', { name: '같은 요청으로 재시도', exact: true }).count()).toBe(0);
      await item.page.getByRole('button', { name: '요청 복구 검증' }).click(); await item.page.getByLabel('작업 내용').fill('명시적으로 선택한 별도 입력'); await item.page.getByRole('button', { name: '준비 상태 확인' }).click();
      await item.page.getByText('연결과 실행 기능이 준비되었습니다.', { exact: false }).waitFor(); expect(await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
      await item.page.getByLabel('이전 요청이 실행되었을 수 있음을 확인하고 별도 실행 준비').check(); await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
      await item.page.getByRole('heading', { name: '실행 상태와 결과' }).waitFor(); await item.service.waitForIdle();
      expect(bodies).toHaveLength(2); expect(JSON.parse(bodies[1]!).requestId).not.toBe(JSON.parse(bodies[0]!).requestId); expect(item.store.listRuns()).toHaveLength(1);
      expect(item.store.listRuns()[0]!.result).toMatchObject({ data: { text: '명시적으로 선택한 별도 입력' } });
      expect(await item.page.evaluate(() => Object.entries(localStorage))).toEqual([[REQUEST_INTENT_PREFIX + JSON.parse(bodies[0]!).requestId, 'pending']]);
    } finally { await item.context.close(); }
  }, 30000);

  it('never starts an untracked run when browser persistence fails', async () => {
    const item = await setup(); let posts = 0;
    try {
      await item.page.route('**/api/runs', route => { if (route.request().method() === 'POST') posts++; return route.continue(); });
      await item.page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('storage disabled', 'SecurityError'); }; });
      await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await item.page.getByText(/실행 요청 기록을 저장하지 못해 실행을 보내지 않았습니다/).waitFor();
      expect(posts).toBe(0); expect(item.store.listRuns()).toHaveLength(0);
    } finally { await item.context.close(); }
  }, 30000);

  it('keeps the request on lookup failure after reload and does not infer a new execution', async () => {
    const item = await setup(); let posts = 0;
    try {
      await item.page.route('**/api/runs', async route => {
        if (route.request().method() !== 'POST') return route.continue(); posts++;
        await route.fetch({ headers: { ...await route.request().allHeaders(), 'sec-fetch-site': 'same-origin' } }); await route.abort('failed');
      });
      await item.page.getByRole('button', { name: '워크플로 실행', exact: true }).click(); await item.page.getByRole('alert').waitFor();
      await item.page.route('**/api/run-requests/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: '조회 연결을 확인하세요.' } }) }));
      await item.page.reload(); await item.page.getByText('조회 연결을 확인하세요.', { exact: true }).waitFor();
      expect(posts).toBe(1); expect(item.store.listRuns()).toHaveLength(1); expect(await item.page.evaluate(() => Object.entries(localStorage))).toHaveLength(1);
      expect(await item.page.getByRole('button', { name: '같은 요청으로 재시도', exact: true }).count()).toBe(0);
    } finally { await item.context.close(); }
  }, 30000);

  it('ignores two synchronous submit events before the busy state renders', async () => {
    const item = await setup(); let posts = 0;
    try {
      await item.page.route('**/api/runs', route => { if (route.request().method() === 'POST') posts++; return route.continue(); });
      await item.page.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await item.page.getByRole('heading', { name: '실행 상태와 결과' }).waitFor(); await item.service.waitForIdle();
      expect(posts).toBe(1); expect(item.store.listRuns()).toHaveLength(1);
    } finally { await item.context.close(); }
  }, 30000);
});
