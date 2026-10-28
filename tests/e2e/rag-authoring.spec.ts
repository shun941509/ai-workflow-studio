import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';

async function select(page: Page, name: string, tab = '기본') { await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption({ label: name }); await page.getByRole('tab', { name: tab, exact: true }).click(); }
async function add(page: Page, type: string, name: string) { await page.locator(`.node-palette .node-${type}`).click(); await page.getByRole('tab', { name: '기본', exact: true }).click(); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill(name); }
async function connect(page: Page, source: string, target: string) { await select(page, source); await page.getByRole('combobox', { name: '다음 작업 연결', exact: true }).selectOption({ label: target }); }
async function bind(page: Page, node: string, field: string, source: string, pointer: string) {
  await select(page, node, '입력·결과'); const button = page.getByRole('button', { name: `${field} 연결`, exact: true }); if (await button.count()) await button.click();
  await page.getByRole('combobox', { name: `${field} 가져올 곳`, exact: true }).selectOption('node'); const control = page.getByRole('combobox', { name: `${field} 결과 블록`, exact: true }); const option = control.locator('option').filter({ hasText: new RegExp(`^${source} ·`) }); await control.selectOption(await option.getAttribute('value') ?? ''); await page.getByRole('textbox', { name: `${field} 값 위치`, exact: true }).fill(pointer);
}

/** Actual controls, persistence and inspected ZIP bytes; no model calls or browser-state injection. */
test('authors vector then hybrid RRF, automatically adds an embedding alias and preserves all three ZIPs', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
  await add(page, 'file_input', '자료 선택'); await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'knowledge', '문서 색인'); await page.getByRole('combobox', { name: '색인 방식', exact: true }).selectOption('vector');
  await expect(page.getByText('벡터·혼합 색인을 만들면 원문 조각을, 검색하면 검색어를 OpenAI로 전송합니다.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '문서 검색용 연결 추가', exact: true }).click(); await expect(page.getByRole('combobox', { name: '문서 검색용 연결', exact: true })).toHaveValue('embedding_default');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.getByRole('combobox', { name: '문서 검색용 연결', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(page.getByRole('combobox', { name: '문서 검색용 연결', exact: true })).toHaveValue('embedding_default');
  await page.getByRole('combobox', { name: '색인 방식', exact: true }).selectOption('hybrid');
  await add(page, 'retrieval', '근거 검색'); await page.getByRole('combobox', { name: '검색 방식', exact: true }).selectOption('vector'); await page.getByRole('combobox', { name: '검색 방식', exact: true }).selectOption('hybrid');
  await page.getByText('혼합 검색 설정', { exact: true }).click(); await page.getByRole('spinbutton', { name: '키워드 후보 수', exact: true }).fill('12'); await page.getByRole('spinbutton', { name: '벡터 후보 수', exact: true }).fill('14'); await page.getByRole('spinbutton', { name: '합친 후보 상한', exact: true }).fill('16'); await page.getByRole('spinbutton', { name: 'RRF 순위 완화값', exact: true }).fill('50');
  await connect(page, '작업할 내용', '자료 선택'); await connect(page, '자료 선택', '문서 색인'); await connect(page, '문서 색인', '근거 검색'); await connect(page, '근거 검색', '결과');
  await bind(page, '문서 색인', '색인에 넣을 문서', '자료 선택', '/data'); await bind(page, '근거 검색', '검색용 색인', '문서 색인', '/data'); await bind(page, '근거 검색', '검색어', '작업할 내용', '/data/text'); await bind(page, '결과', '최종 결과', '근거 검색', '/data/context');
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await select(page, '문서 색인');
  await expect(page.getByRole('combobox', { name: '문서 검색용 연결', exact: true })).toHaveValue('embedding_default'); await expect(page.getByRole('combobox', { name: '색인 방식', exact: true })).toHaveValue('hybrid');
  await select(page, '근거 검색'); await expect(page.getByRole('combobox', { name: '검색 방식', exact: true })).toHaveValue('hybrid');
  for (const [host, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode']] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' });
    await dialog.getByText(label, { exact: true }).click(); const event = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
    const archive = await inspectPackage(new Uint8Array(await readFile((await (await event).path())!))); expect(archive.manifest.targetHost).toBe(host);
    expect(archive.workflow.modelProfiles.embedding_default).toEqual({ kind: 'embedding', requiredFeatures: ['embedding'] });
    expect(archive.workflow.nodes.find(node => node.type === 'knowledge')!.config).toMatchObject({ profile: 'local-run-embedding-v1', indexSettings: { kind: 'hybrid', embeddingProfile: 'embedding_default' } });
    expect(archive.workflow.nodes.find(node => node.type === 'retrieval')!.config).toMatchObject({ mode: 'hybrid', keywordTopK: 12, vectorTopK: 14, candidateLimit: 16, fusion: { method: 'rrf', k: 50 } });
  }
  await select(page, '근거 검색'); await page.getByText('혼합 검색 설정', { exact: true }).click(); await page.screenshot({ path: info.outputPath('rag-rrf-settings.png'), fullPage: true });
  await page.getByRole('combobox', { name: '검색 방식', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('rag-authoring.png'), fullPage: true });
  await select(page, '문서 색인'); await page.getByRole('combobox', { name: '색인 방식', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('rag-index-settings.png'), fullPage: true }); expect(errors).toEqual([]);
});

test('preserves graph settings on import and blocks download instead of silently rewriting the mode', async ({ page }) => {
  const workflow = createBasicWorkflow(); const node = createNode('retrieval'); if (node.type !== 'retrieval') throw new Error('factory'); node.id = 'graph_local'; node.label = '가져온 그래프 검색'; node.config.mode = 'graph_local'; node.config.maxHops = 2; workflow.nodes.push(node);
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON', exact: true }).fill(JSON.stringify(workflow)); await page.getByRole('button', { name: '내용 적용', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await select(page, node.label); await expect(page.getByRole('combobox', { name: '검색 방식', exact: true })).toHaveValue('graph_local'); await expect(page.getByRole('combobox', { name: '검색 방식', exact: true }).locator('option:checked')).toContainText('현재 미지원');
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('combobox', { name: '검색 방식', exact: true })).toHaveValue('graph_local');
  await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); expect(JSON.parse(await page.getByRole('textbox', { name: '워크플로 JSON', exact: true }).inputValue()).nodes.find((item: { id: string }) => item.id === 'graph_local').config.mode).toBe('graph_local');
});
