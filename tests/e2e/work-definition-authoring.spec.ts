import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inspectPackage } from '@studio/package-kit';
import type { Workflow } from '@studio/spec';

async function design(page: Page): Promise<Workflow> {
  await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click();
  const value = JSON.parse(await page.getByRole('textbox', { name: '워크플로 JSON' }).inputValue());
  await page.getByRole('button', { name: '설계 창 닫기', exact: true }).click(); return value;
}

/** Real browser edits/exports preserve one document and history; no external account or model is simulated. */
test('authors one business task, compiles and undoes context, then reopens and exports three operational ZIPs', async ({ page }, info) => {
  const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click();
  await expect(page.getByRole('button', { name: '업무 정의 추가', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '결과 형식 기준으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '업무 정의 추가', exact: true }).click();
  await page.getByRole('textbox', { name: '업무 파트너 이름', exact: true }).fill('문서 정리 파트너');
  await page.getByRole('textbox', { name: '맡을 책임과 목적', exact: true }).fill('사용자가 준 원문만 요약합니다.');
  await page.getByRole('textbox', { name: '검토할 결과와 업무 목표', exact: true }).fill('근거와 확인하지 못한 내용을 구분한 요약을 검토합니다.');
  await page.getByRole('button', { name: '문맥 구성 적용', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  const compiled = await design(page); expect(compiled.workDefinition?.harness.workingContext?.bindings).toHaveLength(1);
  expect(compiled.workDefinition!.card.purpose).toBe('사용자가 준 원문만 요약합니다.');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(3);
  expect((await design(page)).workDefinition?.harness.workingContext).toBeUndefined();
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(4);
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem(`studio.draft.v1:${id}`) ?? '{}').workflow?.workDefinition?.harness?.workingContext?.version, compiled.id)).toBe(1);
  await page.reload(); await expect(page.locator('.workflow-node')).toHaveCount(4);
  expect(await design(page)).toEqual(compiled);
  await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '업무 파트너 이름', exact: true })).toHaveValue('문서 정리 파트너');
  await page.getByRole('textbox', { name: '업무 파트너 이름', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('business-workflow.png'), fullPage: true });
  for (const host of ['codex', 'claude-code', 'opencode'] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' });
    await dialog.locator(`input[value="${host}"]`).check();
    const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
    const file = await downloaded, path = await file.path(); expect(path).toBeTruthy();
    const inspected = await inspectPackage(new Uint8Array(await readFile(path!)));
    expect(inspected.workflow).toEqual(compiled); expect(inspected.manifest.requiredCapabilities).toContain('workflow.working_context@1');
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: '다운로드 창 닫기' }).click();
  }
  await page.getByRole('button', { name: '문맥 묶기 해제', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('button', { name: '업무 정의 해제', exact: true }).click();
  expect((await design(page)).workDefinition).toBeUndefined(); expect(crashes).toEqual([]);
});
