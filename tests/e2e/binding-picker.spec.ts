import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { Workflow } from '@studio/spec';

/** These authoring journeys use visible choices only: no JSON Pointer typing, browser storage injection or mocked exports. */
async function select(page: Page, name: string, tab = '기본') {
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption({ label: name });
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
async function add(page: Page, type: string, name: string) {
  await page.locator(`.node-palette .node-${type}`).click(); await page.getByRole('tab', { name: '기본', exact: true }).click();
  await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill(name);
}
async function connect(page: Page, source: string, target: string) {
  await select(page, source); await page.getByRole('combobox', { name: '다음 작업 연결', exact: true }).selectOption({ label: target });
}
async function chooseSource(page: Page, field: string, source: string) {
  const button = page.getByRole('button', { name: `${field} 연결`, exact: true }); if (await button.count()) await button.click();
  await page.getByRole('combobox', { name: `${field} 가져올 곳`, exact: true }).selectOption('node');
  const select = page.getByRole('combobox', { name: `${field} 결과 블록`, exact: true });
  const option = select.locator('option').filter({ hasText: new RegExp(`^${source} ·`) }); await select.selectOption((await option.getAttribute('value'))!);
}
async function chooseValue(page: Page, node: string, field: string, source: string, label: string) {
  await select(page, node, '입력·결과'); await chooseSource(page, field, source);
  await page.getByRole('combobox', { name: `${field} 가져올 값`, exact: true }).selectOption({ label });
}
async function fresh(page: Page) {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
}
async function exportWorkflow(page: Page, host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<Workflow> {
  const labels = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode' };
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: new RegExp(`^${labels[host]}`) }).check();
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  const files = unzipSync(new Uint8Array(await readFile((await (await pending).path())!)));
  expect(JSON.parse(new TextDecoder().decode(files['manifest.json']))).toMatchObject({ purpose: 'production', targetHost: host });
  return JSON.parse(new TextDecoder().decode(files['workflow.json']));
}

test('selects a first file and original text, then exports all three operational packages', async ({ page }, info) => {
  await fresh(page); await add(page, 'file_input', '문서 선택');
  await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'document_extract', '원문 읽기');
  await connect(page, '작업할 내용', '문서 선택'); await connect(page, '문서 선택', '원문 읽기'); await connect(page, '원문 읽기', '결과');
  await chooseValue(page, '원문 읽기', '읽을 문서', '문서 선택', '첫 번째 파일');
  await expect(page.getByRole('textbox', { name: '읽을 문서 값 위치', exact: true })).toHaveValue('/data/0');
  await chooseValue(page, '결과', '최종 결과', '원문 읽기', '원문 텍스트');
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    const flow = await exportWorkflow(page, host); const source = flow.nodes.find(item => item.type === 'file_input')!, extract = flow.nodes.find(item => item.type === 'document_extract')!;
    expect(extract.inputBindings.file).toEqual({ from: 'node', nodeId: source.id, pointer: '/data/0', onMissing: 'error' });
    expect(flow.nodes.find(item => item.type === 'output')!.inputBindings.result).toEqual({ from: 'node', nodeId: extract.id, pointer: '/data/text', onMissing: 'error' });
  }
  await page.screenshot({ path: info.outputPath('original-text-picker.png'), fullPage: true });
});

test('selects document lists, a search index and keyword context without entering paths', async ({ page }, info) => {
  await fresh(page); await add(page, 'file_input', '자료 선택');
  await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'knowledge', '검색 준비'); await add(page, 'retrieval', '근거 찾기');
  await connect(page, '작업할 내용', '자료 선택'); await connect(page, '자료 선택', '검색 준비'); await connect(page, '검색 준비', '근거 찾기'); await connect(page, '근거 찾기', '결과');
  await chooseValue(page, '검색 준비', '색인에 넣을 문서', '자료 선택', '선택한 파일 목록 (전체 결과)');
  await chooseValue(page, '근거 찾기', '검색용 색인', '검색 준비', '검색용 색인 (전체 결과)');
  await chooseValue(page, '근거 찾기', '검색어', '작업할 내용', '입력 항목: text');
  await chooseValue(page, '결과', '최종 결과', '근거 찾기', '검색 문맥');
  await expect(page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true }).locator('option')).toContainText(['전체 결과', '검색 문맥', '인용 근거', '찾은 문서 조각', '사용한 검색용 색인']);
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    const flow = await exportWorkflow(page, host); const search = flow.nodes.find(item => item.type === 'retrieval')!;
    expect(flow.nodes.find(item => item.type === 'knowledge')!.inputBindings.documents).toMatchObject({ pointer: '/data' });
    expect(search.inputBindings).toMatchObject({ index: { pointer: '/data' }, query: { pointer: '/data/text' } });
    expect(flow.nodes.find(item => item.type === 'output')!.inputBindings.result).toEqual({ from: 'node', nodeId: search.id, pointer: '/data/context', onMissing: 'error' });
  }
  await page.screenshot({ path: info.outputPath('search-context-picker.png'), fullPage: true });
});

test('offers declared Agent fields and preserves the old path when a different source is chosen', async ({ page }) => {
  await fresh(page); await add(page, 'agent', '검토 에이전트');
  await page.getByRole('combobox', { name: '에이전트 결과 형식 형식', exact: true }).selectOption('object');
  await page.getByRole('textbox', { name: '에이전트 결과 형식 새 항목 이름', exact: true }).fill('summary'); await page.getByRole('button', { name: '항목 추가', exact: true }).click();
  await chooseValue(page, '검토 에이전트', '에이전트가 할 일', '작업할 내용', '입력 항목: text');
  await chooseValue(page, '결과', '최종 결과', '작업할 내용', '입력 항목: text');
  await page.getByRole('combobox', { name: '최종 결과 값이 없을 때', exact: true }).selectOption('default');
  await page.getByRole('textbox', { name: '최종 결과 대체 값', exact: true }).fill('결과가 없습니다');
  // Switching a producer is not consent to rewrite a user's saved data path or missing-value policy.
  const producer = page.getByRole('combobox', { name: '최종 결과 결과 블록', exact: true });
  await producer.selectOption((await producer.locator('option').filter({ hasText: /^검토 에이전트 ·/ }).getAttribute('value'))!);
  await expect(page.getByRole('textbox', { name: '최종 결과 값 위치', exact: true })).toHaveValue('/data/text');
  await expect(page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true }).locator('option:checked')).toHaveText('직접 지정한 경로 (고급)');
  await page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true }).selectOption({ label: '에이전트 결과 항목: summary' });
  await connect(page, '작업할 내용', '검토 에이전트'); await connect(page, '검토 에이전트', '결과');
  const flow = await exportWorkflow(page);
  expect(flow.nodes.find(item => item.type === 'output')!.inputBindings.result).toMatchObject({ pointer: '/data/result/summary', onMissing: 'default', defaultValue: '결과가 없습니다' });
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload();
  await select(page, '결과', '입력·결과'); await expect(page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true })).toHaveValue('/data/result/summary');
});
