import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBasicWorkflow, createNode, type Workflow } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { RunnerService } from '../../apps/runner/src/service';
import { RunStore } from '../../apps/runner/src/state/store';
import { packageModelRequirements } from '../../apps/runner/src/profiles/package-requirements';
import { startResourceUiHarness } from '../fixtures/resource-ui-server';

async function select(page: Page, name: string, tab = '기본') { await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption({ label: name }); await page.getByRole('tab', { name: tab, exact: true }).click(); }
async function add(page: Page, type: string, name: string) { await page.locator(`.node-palette .node-${type}`).click(); await page.getByRole('tab', { name: '기본', exact: true }).click(); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill(name); }
async function connect(page: Page, source: string, target: string) { await select(page, source); await page.getByRole('combobox', { name: '다음 작업 연결', exact: true }).selectOption({ label: target }); }
async function bind(page: Page, target: string, field: string, source: string, pointer: string) {
  await select(page, target, '입력·결과'); const button = page.getByRole('button', { name: `${field} 연결`, exact: true }); if (await button.count()) await button.click();
  await page.getByRole('combobox', { name: `${field} 가져올 곳`, exact: true }).selectOption('node');
  const producer = page.getByRole('combobox', { name: `${field} 결과 블록`, exact: true }); const option = producer.locator('option').filter({ hasText: new RegExp(`^${source} ·`) });
  await producer.selectOption((await option.getAttribute('value'))!); await page.getByRole('textbox', { name: `${field} 값 위치`, exact: true }).fill(pointer);
}
async function design(page: Page): Promise<Workflow> { await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); const value = JSON.parse(await page.getByRole('textbox', { name: '워크플로 JSON' }).inputValue()); await page.getByRole('button', { name: '설계 창 닫기' }).click(); return value; }

/** A real authored ZIP is checked without installing a key or making a provider request. */
async function assertMissingConnection(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-agentic-authoring-')); const store = new RunStore(join(directory, 'state.sqlite')); let calls = 0;
  const unavailable = async (): Promise<never> => { throw new Error('This test has no credential store'); };
  const provider = { async countInputTokens(): Promise<number> { calls++; throw new Error('No model calls authorized'); }, async generate(): Promise<never> { calls++; throw new Error('No model calls authorized'); } };
  const service = new RunnerService(store, { available: false, get: unavailable, has: async () => false, set: unavailable, delete: unavailable }, directory, provider);
  try { const imported = await service.importPackage(bytes); const checked = await service.validate(imported.packageHandle, {}); expect(checked.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MODEL_PROFILE_REQUIRED' })])); expect(calls).toBe(0); }
  finally { await service.shutdown(); store.close(); if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('studio-agentic-authoring-')) throw new Error('Unexpected cleanup target'); await rm(directory, { recursive: true, force: true }); }
}

test('authors keyword Agentic with real forms, preserves undo/history and exports the same definition to three hosts', async ({ page }, info) => {
  const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
  await page.getByRole('textbox', { name: '프로젝트 이름', exact: true }).fill('문서 근거를 찾아 답하는 Agentic');
  await add(page, 'file_input', '원문 선택'); await page.getByRole('spinbutton', { name: '최대 파일 개수' }).fill('1'); await page.getByRole('spinbutton', { name: '파일 하나의 최대 크기 (MiB)' }).fill('2');
  await add(page, 'knowledge', '키워드 색인'); await page.getByRole('combobox', { name: '색인 작업', exact: true }).selectOption('build'); await expect(page.getByRole('combobox', { name: '색인 방식', exact: true })).toHaveValue('keyword');
  await add(page, 'merge', '색인 목록'); await page.getByRole('combobox', { name: '합치는 방법', exact: true }).selectOption('array');
  await select(page, '색인 목록', '입력·결과'); await page.getByRole('textbox', { name: '합칠 입력 이름', exact: true }).fill('current'); await page.getByRole('button', { name: '합칠 입력 추가', exact: true }).click(); await bind(page, '색인 목록', 'current', '키워드 색인', '/data');
  await add(page, 'agent', '근거로 답하기'); const instructions = '질문의 용어를 문서에서 찾아 확인하세요. 근거가 없거나 서로 모순되면 답변을 유보하고, 확인된 원문을 인용하세요.';
  await page.getByRole('textbox', { name: '에이전트 역할과 작업 방법', exact: true }).fill(instructions); await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).selectOption('agentic_rag');
  await expect(page.getByRole('textbox', { name: '에이전트 역할과 작업 방법', exact: true })).toHaveValue(instructions);
  await page.getByRole('button', { name: '검색 에이전트용 모델 프로필 추가', exact: true }).click(); await expect(page.getByRole('combobox', { name: '에이전트 모델 프로필', exact: true })).toHaveValue('agentic_default');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.getByRole('combobox', { name: '에이전트 모델 프로필', exact: true })).toHaveValue('text-default'); await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await page.getByRole('combobox', { name: '답변이 있을 때의 결과 형식 형식', exact: true }).selectOption('string');
  await page.getByText('검색 범위와 한도', { exact: true }).click(); await expect(page.getByRole('spinbutton', { name: '전체 최대 단계', exact: true })).toHaveValue('12');
  await page.getByRole('spinbutton', { name: '전체 최대 단계', exact: true }).fill('33'); await expect(page.locator('.node-inspector').getByRole('status')).toContainText('3~32'); await page.getByRole('spinbutton', { name: '전체 최대 단계', exact: true }).fill('12');
  await bind(page, '근거로 답하기', '에이전트가 할 일', '작업할 내용', '/data/text'); await select(page, '근거로 답하기', '입력·결과'); await page.getByRole('button', { name: '검색용 색인 목록 연결', exact: true }).click(); await expect(page.getByRole('textbox', { name: '검색용 색인 목록 값 위치', exact: true })).toHaveValue('/indexes'); await bind(page, '근거로 답하기', '검색용 색인 목록', '색인 목록', '/data');
  await bind(page, '키워드 색인', '색인에 넣을 문서', '원문 선택', '/data');
  for (const [source, target] of [['작업할 내용', '원문 선택'], ['원문 선택', '키워드 색인'], ['키워드 색인', '색인 목록'], ['색인 목록', '근거로 답하기'], ['근거로 답하기', '결과']]) await connect(page, source!, target!);
  await select(page, '결과'); await page.getByRole('combobox', { name: '결과 표시 방식', exact: true }).selectOption('json'); await page.getByRole('combobox', { name: '최종 결과 형식 형식', exact: true }).selectOption('any'); await bind(page, '결과', '최종 결과', '근거로 답하기', '/data');
  await expect(page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true }).locator('option')).toContainText(['답변 상태·결과·인용 전체', '답변 상태', '에이전트 답변 (유보 시 null)', '답변의 인용 근거', '에이전트 종료 이유', '검색 단계·문맥 사용량']);
  await select(page, '근거로 답하기'); const beforeSwitch = await design(page); await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).selectOption('task');
  await page.getByRole('button', { name: '검색 설정과 색인 입력을 제거하고 전환', exact: true }).click(); await expect(page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true })).toHaveValue('task');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); expect(await design(page)).toEqual(beforeSwitch);
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await select(page, '근거로 답하기');
  await expect(page.getByRole('combobox', { name: '에이전트 모델 프로필', exact: true })).toHaveValue('agentic_default'); await expect(page.getByRole('textbox', { name: '에이전트 역할과 작업 방법', exact: true })).toHaveValue(instructions);
  await page.getByRole('button', { name: /준비 상태 확인/ }).click(); await expect(page.getByText('설계 검사를 통과했습니다', { exact: true })).toBeVisible();
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await dialog.locator(`input[name="host"][value="${host}"]`).check();
    const waiting = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const bytes = await readFile((await (await waiting).path())!); const archive = await inspectPackage(bytes);
    expect(archive.manifest.targetHost).toBe(host); expect(archive.workflow).toEqual(beforeSwitch); expect(archive.manifest.purpose).toBe('production');
    expect(collectRequirements(archive.workflow!).capabilities).toEqual(expect.arrayContaining(['agent.agentic_rag@1', 'agentic_rag.keyword@1', 'agentic_rag.abstain@1']));
    expect(packageModelRequirements(archive.workflow)).toEqual([expect.objectContaining({ alias: 'agentic_default', kind: 'chat', constraint: expect.objectContaining({ contractId: 'openai-agentic-keyword-abstain-v1', model: 'gpt-5.4-mini-2026-03-17' }) })]);
    for (const entry of archive.manifest.files) expect(createHash('sha256').update(archive.files.get(entry.path)!).digest('hex')).toBe(entry.sha256);
    expect([...archive.files.keys()].some(path => /fixture|verification\.spec|node_modules/.test(path))).toBe(false); await assertMissingConnection(bytes);
  }
  await page.getByText('검색 범위와 한도', { exact: true }).click(); await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('agentic-authoring.png'), fullPage: true });
  await page.getByRole('spinbutton', { name: '전체 최대 단계', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('agentic-limits.png'), fullPage: true }); expect(crashes).toEqual([]);
});

test('retains unsupported clarification imports and blocks export without silently changing them to abstain', async ({ page }) => {
  const workflow = createBasicWorkflow(); const node = createNode('agent'); if (node.type !== 'agent') throw new Error('factory');
  node.id = 'unsupported_agent'; node.label = '추가 질문 원본'; node.config.strategy = 'agentic_rag'; node.config.maxSteps = 12; node.config.retrievalPolicy = { maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000, onInsufficient: 'ask', clarificationFlowRef: { kind: 'local', flowId: 'questions' } }; workflow.nodes.push(node);
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON' }).fill(JSON.stringify(workflow)); await page.getByRole('button', { name: '내용 적용', exact: true }).click();
  await select(page, node.label); await expect(page.locator('.node-inspector').getByRole('status')).toContainText('추가 질문'); await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await design(page)).nodes.find(item => item.id === node.id)!.config).toEqual(node.config);
});

test('cancels an in-flight attachment when undo changes the same selected agent strategy and keeps task attachment behavior', async ({ page }) => {
  // The shared harness replaces only account HTTP transport; all rendered editor/closure code is the product implementation.
  const app = await startResourceUiHarness(); const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
  try {
    await page.goto(`${app.url}/editor`); await expect(page.locator('.workflow-node')).toHaveCount(3); await add(page, 'agent', '자료 전환 검사');
    await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).selectOption('agentic_rag'); await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).selectOption('task'); await page.getByRole('button', { name: '검색 설정과 색인 입력을 제거하고 전환', exact: true }).click();
    await page.getByRole('tab', { name: '자료·도구', exact: true }).click(); const resource = page.locator('.picker-resource').filter({ has: page.getByText(app.first.summary.name, { exact: true }) }); const release = app.holdDetail(app.first.detail.version.id);
    try { await resource.getByRole('button', { name: '연결', exact: true }).click(); await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.getByText('검색 에이전트는 직접 자료 첨부를 지원하지 않습니다.', { exact: false })).toBeVisible(); release(); }
    finally { release(); }
    expect((await design(page)).resources).toEqual({}); expect((await design(page)).nodes.find(item => item.label === '자료 전환 검사')!.attachments).toEqual([]);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await resource.getByRole('button', { name: '연결', exact: true }).click(); await expect(resource.getByRole('button', { name: '연결됨', exact: true })).toBeDisabled();
    const attached = await design(page); expect(attached.resources).toEqual(app.first.detail.refs);
    await page.getByRole('tab', { name: '기본', exact: true }).click(); await page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true }).selectOption('agentic_rag'); await expect(page.getByRole('alert')).toContainText('연결을 먼저 해제'); await expect(page.getByRole('combobox', { name: '에이전트 실행 방식', exact: true })).toHaveValue('task'); expect(await design(page)).toEqual(attached);
    expect(crashes).toEqual([]); expect(app.failures).toEqual([]);
  } finally { await app.close(); }
});
