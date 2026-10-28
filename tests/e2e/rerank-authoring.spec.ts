import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowEdge } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';

/** The visible JSON import supplies a valid no-reranker starting flow; every new setting is authored through real controls. */
function base(): Workflow {
  const workflow = createBasicWorkflow(); const input = createNode('input'), files = createNode('file_input'), index = createNode('knowledge'), search = createNode('retrieval'), output = createNode('output');
  input.id = 'input'; files.id = 'files'; index.id = 'index'; search.id = 'search'; output.id = 'output'; if (files.type !== 'file_input' || index.type !== 'knowledge' || search.type !== 'retrieval') throw new Error('factory');
  files.config = { mimeTypes: ['text/plain'], maxFiles: 2, maxBytesPerFile: 2048 }; files.inputBindings = { files: { from: 'literal', value: [] } };
  index.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 0 } }; index.inputBindings = { documents: { from: 'node', nodeId: 'files', pointer: '/data', onMissing: 'error' } };
  search.inputBindings = { query: { from: 'workflowInput', pointer: '/text', onMissing: 'error' }, index: { from: 'node', nodeId: 'index', pointer: '/data', onMissing: 'error' } }; output.inputBindings = { result: { from: 'node', nodeId: 'search', pointer: '/data/context', onMissing: 'error' } };
  const nodes: Workflow['nodes'] = [input, files, index, search, output]; const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}_${target}`, from: { nodeId: source, port: 'next' }, to: { nodeId: target, port: 'in' } });
  return { ...workflow, entryNodeId: input.id, nodes, edges: nodes.slice(0, -1).map((node, i) => edge(node.id, nodes[i + 1]!.id)) };
}
async function select(page: Page) { await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('search'); await page.getByRole('tab', { name: '기본', exact: true }).click(); }

test('opts into fixed reranking without typing IDs, preserves boundaries and three host ZIPs', async ({ page }, info) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON', exact: true }).fill(JSON.stringify(base())); await page.getByRole('button', { name: '내용 적용', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await select(page);
  await expect(page.getByRole('checkbox', { name: '검색 결과 다시 정렬', exact: true })).not.toBeChecked(); await page.getByRole('checkbox', { name: '검색 결과 다시 정렬', exact: true }).check();
  await page.getByRole('button', { name: '검색 재정렬용 연결 추가', exact: true }).click(); await expect(page.getByRole('combobox', { name: '검색 재정렬용 연결', exact: true })).toHaveValue('reranker_default');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.getByRole('combobox', { name: '검색 재정렬용 연결', exact: true })).toHaveValue(''); await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await page.getByRole('spinbutton', { name: '다시 정렬할 후보 수', exact: true }).fill('21'); await expect(page.getByRole('alert').filter({ hasText: '기존 값은 자동으로 줄이지 않습니다' })).toBeVisible(); await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('spinbutton', { name: '다시 정렬할 후보 수', exact: true })).toHaveValue('21');
  await page.getByRole('spinbutton', { name: '다시 정렬할 후보 수', exact: true }).fill('10'); await page.getByText('재정렬 세부 설정', { exact: true }).click(); await page.getByRole('spinbutton', { name: '재정렬 최대 대기 시간 (밀리초)', exact: true }).fill('45000'); await page.getByRole('combobox', { name: '재정렬 실패 처리', exact: true }).selectOption('use_original');
  await expect(page.getByText('인증·권한·응답 변조·취소·시간·예산·처리 결과 불명은 계속 중단합니다.', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: '검색 방식', exact: true }).selectOption('vector'); await expect(page.getByRole('combobox', { name: '검색 재정렬용 연결', exact: true })).toHaveValue('reranker_default'); await page.getByRole('combobox', { name: '검색 방식', exact: true }).selectOption('keyword');
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await select(page); await expect(page.getByRole('checkbox', { name: '검색 결과 다시 정렬', exact: true })).toBeChecked();
  for (const [host, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode']] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await dialog.getByRole('radio', { name: new RegExp(label) }).check(); const event = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
    const archive = await inspectPackage(new Uint8Array(await readFile((await (await event).path())!))); expect(archive.manifest.targetHost).toBe(host); expect(archive.workflow.modelProfiles.reranker_default).toEqual({ kind: 'reranker', requiredFeatures: ['rerank'] }); expect(archive.workflow.nodes.find(node => node.id === 'search')!.config).toMatchObject({ mode: 'keyword', candidateLimit: 10, reranker: { modelProfile: 'reranker_default', timeoutMs: 45000, onFailure: 'use_original' } });
  }
  await page.getByRole('checkbox', { name: '검색 결과 다시 정렬', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('rerank-settings.png'), fullPage: true }); expect(failures).toEqual([]);
});
