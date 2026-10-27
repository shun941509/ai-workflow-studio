import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createBasicWorkflow, createNode, type WorkflowEdge } from '@studio/spec';
import { buildPackage } from '@studio/package-kit';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import { createLocalServer } from '../../apps/runner/src/local-api/server.js';

/** Standalone production-UI check: build runner-ui first, then run this file with the pinned Node/tsx runtime. */
const directory = await mkdtemp(join(tmpdir(), 'studio-files-ui-')); const store = new RunStore(join(directory, 'state.sqlite'));
const service = new RunnerService(store, { available: false, async has() { return false; }, async get() { throw new Error('No model account in this pure-file UI test'); }, async set() { throw new Error('No model account in this pure-file UI test'); }, async delete() {} }, directory);
const server = createLocalServer(service, { bearerToken: 'internal-ui-test-only', uiDirectory: resolve('apps/runner-ui/dist') }); const { origin } = await server.listen();
const browser = await chromium.launch();
try {
  const workflow = createBasicWorkflow('파일 선택과 복사 검증'); workflow.inputs = { type: 'object', properties: {}, additionalProperties: false }; workflow.outputs = true; workflow.modelProfiles = {};
  const entry = createNode('input'), files = createNode('file_input'), copy = createNode('file_output'), output = createNode('output'); entry.id = 'input'; files.id = 'files'; copy.id = 'copy'; output.id = 'output';
  if (files.type !== 'file_input' || copy.type !== 'file_output') throw new Error('Factory type mismatch');
  files.label = '작업 파일 선택'; files.config = { mimeTypes: ['text/plain'], maxFiles: 1, maxBytesPerFile: 1024 }; files.inputBindings.files = { from: 'literal', value: [] };
  copy.config = { format: 'copy', filename: '복사.txt', outputDirectory: 'outputs' }; copy.inputBindings.file = { from: 'node', nodeId: files.id, pointer: '/data/0', onMissing: 'error' }; output.inputBindings.result = { from: 'node', nodeId: copy.id, pointer: '/data', onMissing: 'error' };
  const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
  workflow.entryNodeId = entry.id; workflow.nodes = [entry, files, copy, output]; workflow.edges = [edge(entry.id, files.id), edge(files.id, copy.id), edge(copy.id, output.id)];
  const built = await buildPackage({ workflow, host: 'codex' }); const page = await browser.newPage(); const failures: string[] = []; page.on('pageerror', (error) => failures.push(error.message)); await page.goto(origin);
  await page.getByLabel('운영 ZIP 파일 선택').setInputFiles({ name: '파일-검증.zip', mimeType: 'application/zip', buffer: Buffer.from(built.bytes) });
  await page.getByRole('button', { name: '준비 상태 확인' }).click(); await page.getByText('연결과 실행 기능이 준비되었습니다.', { exact: false }).waitFor(); await page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
  await page.getByRole('heading', { name: '작업 파일 선택' }).waitFor(); const bytes = Buffer.from('사용자가 선택한 검증 파일\n', 'utf8');
  await page.getByLabel('파일 선택', { exact: true }).setInputFiles({ name: '원본.txt', mimeType: 'text/plain', buffer: bytes }); await page.getByRole('button', { name: '선택한 파일로 진행' }).click(); await page.getByText('완료', { exact: true }).first().waitFor();
  const row = page.getByRole('listitem').filter({ has: page.getByText('복사.txt', { exact: true }) }); const downloadPromise = page.waitForEvent('download'); await row.getByRole('button', { name: '내려받기' }).click(); const download = await downloadPromise; assert.equal(download.suggestedFilename(), '복사.txt'); assert.deepEqual(await readFile((await download.path())!), bytes); assert.deepEqual(failures, []); assert.ok(!(await page.locator('body').innerText()).includes('undefined'));
  const evidence = resolve('apps/runner-ui/artifacts/file-flow.png'); await mkdir(dirname(evidence), { recursive: true }); await page.screenshot({ path: evidence, fullPage: true });
  process.stdout.write(JSON.stringify({ outcome: 'confirmed', flow: 'production UI import → readiness → run → explicit upload → exact-byte download', pageErrors: failures.length, evidence }) + '\n');
} finally {
  await browser.close(); await service.shutdown(); await server.close(); store.close();
  const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !target.includes('studio-files-ui-')) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true });
}
