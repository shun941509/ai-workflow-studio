import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { Workflow } from '@studio/spec';

/** Real visible authoring and exported bytes; no browser state injection or simulated model execution. */
async function select(page: Page, name: string, tab = '기본') {
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption({ label: name }); await page.getByRole('tab', { name: tab, exact: true }).click();
}
async function add(page: Page, type: string, name: string) { await page.locator(`.node-palette .node-${type}`).click(); await page.getByRole('tab', { name: '기본', exact: true }).click(); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill(name); }
async function connect(page: Page, source: string, target: string) { await select(page, source); await page.getByRole('combobox', { name: '다음 작업 연결', exact: true }).selectOption({ label: target }); }
async function bind(page: Page, node: string, field: string, source: string, pointer: string) {
  await select(page, node, '입력·결과'); const button = page.getByRole('button', { name: `${field} 연결`, exact: true }); if (await button.count()) await button.click();
  await page.getByRole('combobox', { name: `${field} 가져올 곳`, exact: true }).selectOption('node');
  const control = page.getByRole('combobox', { name: `${field} 결과 블록`, exact: true }); const option = control.locator('option').filter({ hasText: new RegExp(`^${source} ·`) }); await control.selectOption(await option.getAttribute('value') ?? '');
  await page.getByRole('textbox', { name: `${field} 값 위치`, exact: true }).fill(pointer);
}
async function fresh(page: Page) { await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click(); }
async function exportWorkflow(page: Page): Promise<Workflow> {
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await expect(dialog).toBeVisible();
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const download = await pending;
  const files = unzipSync(new Uint8Array(await readFile((await download.path())!))); return JSON.parse(new TextDecoder().decode(files['workflow.json']));
}

test('authors managed file selection and copy without JSON editing', async ({ page }, info) => {
  await fresh(page); await add(page, 'file_input', '파일 선택');
  await expect(page.getByRole('combobox', { name: '파일을 가져오는 방법' })).toHaveValue('ask'); await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1');
  await add(page, 'file_output', '파일 복사'); await page.getByRole('combobox', { name: '만들 파일 형식' }).selectOption('copy'); await page.getByRole('textbox', { name: '결과 파일 이름' }).fill('선택한문서.txt');
  await connect(page, '작업할 내용', '파일 선택'); await connect(page, '파일 선택', '파일 복사'); await connect(page, '파일 복사', '결과');
  await bind(page, '파일 복사', '복사할 파일', '파일 선택', '/data/0'); await bind(page, '결과', '최종 결과', '파일 복사', '/data');
  await select(page, '결과'); await page.getByRole('combobox', { name: '결과 표시 방식', exact: true }).selectOption('json'); await page.getByRole('combobox', { name: '최종 결과 형식 형식', exact: true }).selectOption('any');
  const result = await exportWorkflow(page); expect(result.nodes.find(node => node.type === 'file_input')!.inputBindings.files).toEqual({ from: 'literal', value: [] });
  expect(result.nodes.find(node => node.type === 'file_output')!.config).toEqual({ format: 'copy', filename: '선택한문서.txt', outputDirectory: 'outputs' });
  await page.screenshot({ path: info.outputPath('file-authoring.png'), fullPage: true });
});

test('authors run memory with explicit key/value and preserves TTL after reload', async ({ page }) => {
  await fresh(page); await add(page, 'memory', '내용 기억'); await page.getByRole('combobox', { name: '기억 작업' }).selectOption('put'); await page.getByRole('spinbutton', { name: '기억 유효기간 (초)' }).fill('120');
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '설정할 블록', exact: true }).locator('option:checked')).toHaveText('내용 기억');
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeEnabled();
  await select(page, '내용 기억', '입력·결과'); await page.getByRole('button', { name: '기억 이름 연결', exact: true }).click(); await page.getByRole('combobox', { name: '기억 이름 가져올 곳', exact: true }).selectOption('literal'); await page.getByRole('textbox', { name: '기억 이름 직접 입력', exact: true }).fill('사용자메모');
  await bind(page, '내용 기억', '검사·처리할 값', '작업할 내용', '/data/text'); await bind(page, '결과', '최종 결과', '내용 기억', '/data/value'); await connect(page, '작업할 내용', '내용 기억'); await connect(page, '내용 기억', '결과');
  const result = await exportWorkflow(page); expect(result.nodes.find(node => node.type === 'memory')!.config).toEqual({ operation: 'put', scope: 'run', ttlMs: 120000 });
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await expect(page).toHaveURL(/\?draft=wf_/);
  await page.reload(); await select(page, '내용 기억'); await expect(page.getByRole('spinbutton', { name: '기억 유효기간 (초)' })).toHaveValue('120');
});

test('authors a single task agent with typed result and explicit input', async ({ page }) => {
  await fresh(page); await add(page, 'agent', '문서 검토자'); await page.getByRole('textbox', { name: '에이전트 역할과 작업 방법' }).fill('제공한 문서를 검토하고 없는 정보는 미확인으로 남기세요.'); await page.getByRole('combobox', { name: '에이전트 결과 형식 형식', exact: true }).selectOption('string');
  await bind(page, '문서 검토자', '에이전트가 할 일', '작업할 내용', '/data/text'); await bind(page, '결과', '최종 결과', '문서 검토자', '/data/result'); await connect(page, '작업할 내용', '문서 검토자'); await connect(page, '문서 검토자', '결과');
  const result = await exportWorkflow(page); expect(result.nodes.find(node => node.type === 'agent')!.config).toMatchObject({ strategy: 'task', maxSteps: 1, toolAllowlist: [], resultSchema: { type: 'string' } });
});

test('authors file-to-text extraction with an explicit document reference', async ({ page }) => {
  await fresh(page); await add(page, 'file_input', '문서 선택'); await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'document_extract', '원문 읽기'); await expect(page.getByText('UTF-8 문서 원문 읽기', { exact: true })).toBeVisible();
  await connect(page, '작업할 내용', '문서 선택'); await connect(page, '문서 선택', '원문 읽기'); await connect(page, '원문 읽기', '결과');
  await bind(page, '원문 읽기', '읽을 문서', '문서 선택', '/data/0'); await bind(page, '결과', '최종 결과', '원문 읽기', '/data/text');
  const result = await exportWorkflow(page); expect(result.nodes.find(node => node.type === 'document_extract')!.config).toEqual({ mode: 'text' });
});

test('authors a bounded keyword index and retrieval using the operational forms', async ({ page }, info) => {
  await fresh(page); await add(page, 'file_input', '자료 선택'); await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'knowledge', '검색 준비'); await expect(page.getByRole('combobox', { name: '색인 작업' })).toHaveValue('build'); await page.getByText('문서 나누기 설정', { exact: true }).click(); await page.getByRole('spinbutton', { name: '조각 크기 (UTF-8 바이트)', exact: true }).fill('1000'); await page.getByRole('spinbutton', { name: '조각 겹침 (UTF-8 바이트)', exact: true }).fill('100');
  await add(page, 'retrieval', '근거 찾기'); await page.getByRole('spinbutton', { name: '최대 검색 결과 수' }).fill('3'); await page.getByRole('spinbutton', { name: '문맥 최대 분량 (토큰)' }).fill('1000');
  await connect(page, '작업할 내용', '자료 선택'); await connect(page, '자료 선택', '검색 준비'); await connect(page, '검색 준비', '근거 찾기'); await connect(page, '근거 찾기', '결과');
  await bind(page, '검색 준비', '색인에 넣을 문서', '자료 선택', '/data'); await bind(page, '근거 찾기', '검색용 색인', '검색 준비', '/data'); await bind(page, '근거 찾기', '검색어', '작업할 내용', '/data/text'); await bind(page, '결과', '최종 결과', '근거 찾기', '/data/context');
  const result = await exportWorkflow(page); expect(result.nodes.find(node => node.type === 'knowledge')!.config).toEqual({ operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 1000, chunkOverlap: 100 } });
  expect(result.nodes.find(node => node.type === 'retrieval')!.config).toEqual({ mode: 'keyword', topK: 3, maxContextTokens: 1000 }); await select(page, '근거 찾기'); await page.screenshot({ path: info.outputPath('keyword-authoring.png'), fullPage: true });
});
