import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBasicWorkflow, createNode, type Workflow, type WorkflowEdge } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';

async function design(page: Page): Promise<Workflow> { await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); const value = JSON.parse(await page.getByRole('textbox', { name: '워크플로 JSON' }).inputValue()); await page.getByRole('button', { name: '설계 창 닫기' }).click(); return value; }
async function settings(page: Page) { await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click(); return page.getByRole('region', { name: '업무 완료 기준', exact: true }); }
async function importDesign(page: Page, workflow: Workflow) { await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON' }).fill(JSON.stringify(workflow)); await page.getByRole('button', { name: '내용 적용', exact: true }).click(); }
function reviewFlow() {
  const workflow = createBasicWorkflow(), check = createNode('evaluate'), review = createNode('review'), merge = createNode('merge'); if (check.type !== 'evaluate' || review.type !== 'review' || merge.type !== 'merge') throw new Error('factory');
  const from = (nodeId: string) => ({ from: 'node' as const, nodeId, pointer: '/data', onMissing: 'error' as const });
  const edge = (a: string, b: string, port = 'next'): WorkflowEdge => ({ id: `${a}_${port}_${b}`, from: { nodeId: a, port }, to: { nodeId: b, port: 'in' } });
  check.id = 'check'; check.label = '내용 규칙 확인'; check.inputBindings.value = from('work'); review.id = 'review'; review.label = '원문 검토'; review.inputBindings.value = from('work'); review.config.responseSchema = true;
  merge.id = 'merge'; merge.config = { waitFor: 'all_active', combine: 'select', collision: 'error' }; merge.inputBindings.selected = from('review'); workflow.nodes.splice(2, 0, check, review, merge); workflow.nodes.find(node => node.type === 'output')!.inputBindings.result = from('merge'); workflow.outputs = true;
  workflow.edges = [edge('start', 'work'), edge('work', 'check'), edge('check', 'review'), edge('review', 'merge', 'accepted'), edge('review', 'merge', 'rejected'), edge('merge', 'finish')]; return workflow;
}

test('explicitly edits result acceptance, restores history/reopen, and preserves all three actual operating ZIPs', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); const original = await design(page); expect(original.completion).toBeUndefined();
  const panel = await settings(page); await expect(panel).toContainText('업무 완료 미평가'); await panel.getByRole('button', { name: '결과 형식 기준으로 시작', exact: true }).click();
  const label = panel.getByRole('textbox', { name: '완료 기준 1 설명', exact: true }); await label.fill('비어 있지 않은 요약'); await label.press('Tab');
  await panel.getByRole('spinbutton', { name: '완료 기준 1 결과 형식 최소', exact: true }).fill('8');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(panel.getByRole('spinbutton', { name: '완료 기준 1 결과 형식 최소', exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(panel.getByRole('spinbutton', { name: '완료 기준 1 결과 형식 최소', exact: true })).toHaveValue('8');
  const authored = await design(page); expect(authored.nodes).toEqual(original.nodes); expect(authored.outputs).toEqual(original.outputs); expect(authored.completion!.criteria[0]).toMatchObject({ label: '비어 있지 않은 요약', schema: { type: 'string', minLength: 8 } });
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await settings(page); await expect(label).toHaveValue('비어 있지 않은 요약'); expect((await design(page)).completion).toEqual(authored.completion);
  await page.getByRole('button', { name: /준비 상태 확인/ }).click(); await expect(page.getByText('설계 검사를 통과했습니다', { exact: true })).toBeVisible();
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await dialog.locator(`input[name="host"][value="${host}"]`).check();
    const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const bytes = await readFile((await (await download).path())!); const archive = await inspectPackage(bytes);
    expect(archive.workflow!.completion).toEqual(authored.completion); expect(archive.manifest.requiredCapabilities).toContain('workflow.completion@1'); expect(archive.manifest.compatibility.host.verification).toBe('unverified');
  }
  await settings(page); await panel.getByRole('heading', { name: '업무 완료 기준', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('completion-authoring.png'), fullPage: true }); expect(errors).toEqual([]);
});

test('connects existing checks/review without modifying their conditions and keeps completion main-only', async ({ page }) => {
  const workflow = reviewFlow(); await importDesign(page, workflow); const panel = await settings(page);
  await panel.getByRole('button', { name: '결과 형식 기준으로 시작', exact: true }).click(); await panel.getByText('기존 규칙 검사·사용자 검토 함께 연결', { exact: true }).click();
  await panel.getByRole('combobox', { name: '함께 연결할 규칙 검사', exact: true }).selectOption('check'); await panel.getByRole('combobox', { name: '함께 연결할 사용자 검토', exact: true }).selectOption('review'); await panel.getByRole('button', { name: '선택한 검사·검토를 기준에 연결', exact: true }).click();
  const applied = await design(page); expect(applied.completion!.criteria.map(criterion => criterion.kind)).toEqual(['result_schema', 'evaluate_passed', 'review_accepted']); expect(applied.nodes).toEqual(workflow.nodes); expect(applied.edges).toEqual(workflow.edges);
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('review'); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill('이름 변경한 검토'); await settings(page);
  await expect(panel.getByRole('combobox', { name: '완료 기준 3 확인 블록', exact: true }).locator('option')).toContainText(['이름 변경한 검토 · review']);
  await page.getByRole('textbox', { name: '새 하위 흐름 이름', exact: true }).fill('내용 정리'); await page.getByRole('button', { name: '하위 흐름 추가', exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(page.getByText('업무 완료 기준은 기본 흐름 설정에서만 편집합니다.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '편집할 흐름', exact: true }).selectOption('main'); await settings(page); expect((await design(page)).completion).toEqual(applied.completion);
});

test('keeps stale references visible and repairs them explicitly instead of choosing a different block automatically', async ({ page }) => {
  const workflow = reviewFlow(); workflow.completion = { version: 1, criteria: [{ id: 'old_review', label: '기존 최종 검토', kind: 'review_accepted', nodeId: 'removed_review' }] };
  await importDesign(page, workflow); const panel = await settings(page); await expect(panel.getByRole('status')).toContainText('확인 필요: removed_review');
  expect((await design(page)).completion).toEqual(workflow.completion); await panel.getByRole('combobox', { name: '완료 기준 1 확인 블록', exact: true }).selectOption('review'); await expect(panel.getByRole('status')).toHaveCount(0);
  await panel.getByRole('button', { name: '완료 기준 1 삭제', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('마지막 기준');
  await panel.getByRole('button', { name: '완료 기준 해제', exact: true }).click(); await panel.getByRole('button', { name: '해제 취소', exact: true }).click(); expect((await design(page)).completion).toBeDefined();
  await panel.getByRole('button', { name: '완료 기준 해제', exact: true }).click(); await panel.getByRole('button', { name: '판정을 해제하고 미평가로 저장', exact: true }).click(); expect((await design(page)).completion).toBeUndefined();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); expect((await design(page)).completion!.criteria[0]).toMatchObject({ nodeId: 'review' });
});
