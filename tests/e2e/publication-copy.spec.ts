import { expect, test, type Page } from '@playwright/test';

const id = '10000000-0000-4000-8000-000000000001', projectId = '60000000-0000-4000-8000-000000000006';
const receipt = { importId: '50000000-0000-4000-8000-000000000005', projectId, resources: [{ alias: 'original_documents', resourceId: '70000000-0000-4000-8000-000000000007', versionId: '80000000-0000-4000-8000-000000000008', revision: 1 }] };
async function metadata(page: Page, kind: 'project' | 'resource' = 'project') {
  await page.route(`**/api/publications/${id}?**`, route => route.fulfill({ json: { item: { id, kind, title: '복사 가능한 공개 원작', description: '내부 복사 화면 시험', artifactSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), official: false, publishedAt: '2026-10-28T00:00:00.000Z' } } }));
}
const copyPanel = (page: Page) => page.getByRole('region', { name: '내 계정으로 복사', exact: true });

test('shows an account project link only after the atomic copy receipt', async ({ page }) => {
  await metadata(page); let requests = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/publications/${id}/copy`, async route => { requests++; const body = route.request().postDataJSON(); expect(Object.keys(body)).toEqual(['requestId']); expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/); await gate; await route.fulfill({ json: { receipt } }); });
  await page.goto(`/explore/projects/${id}`); const panel = copyPanel(page); await panel.getByRole('button', { name: '내 프로젝트로 복사', exact: true }).click();
  try { const busy = panel.getByRole('button', { name: '원본 확인·복사 중…', exact: true }); await expect(busy).toBeDisabled(); await busy.dispatchEvent('click'); await expect(panel.getByRole('link', { name: '복사한 프로젝트 열기' })).toHaveCount(0); expect(requests).toBe(1); }
  finally { release(); }
  await expect(panel.getByRole('link', { name: '복사한 프로젝트 열기' })).toHaveAttribute('href', `/projects/${projectId}/edit`);
});

test('adds a materials receipt without fabricating a project', async ({ page }) => {
  await metadata(page, 'resource'); await page.route(`**/api/publications/${id}/copy`, route => route.fulfill({ json: { receipt: { ...receipt, projectId: null } } }));
  await page.goto(`/explore/resources/${id}`); const panel = copyPanel(page); await panel.getByRole('button', { name: '내 도구 및 자료에 추가', exact: true }).click();
  await expect(panel.getByText('도구 및 자료 1개를 내 계정에 추가했습니다.')).toBeVisible(); await expect(panel.getByRole('link', { name: '내 도구 및 자료 열기' })).toHaveAttribute('href', '/resources');
});

test('retains the same retry ID across an uncertain response and page reload', async ({ page }) => {
  await metadata(page); const ids: string[] = [];
  await page.route(`**/api/publications/${id}/copy`, async route => { ids.push(route.request().postDataJSON().requestId); if (ids.length === 1) await route.abort('failed'); else await route.fulfill({ json: { receipt } }); });
  await page.goto(`/explore/projects/${id}`); await copyPanel(page).getByRole('button', { name: '내 프로젝트로 복사', exact: true }).click(); await expect(copyPanel(page).getByRole('alert')).toBeVisible();
  await page.reload(); await copyPanel(page).getByRole('button', { name: '같은 복사 요청 다시 확인', exact: true }).click(); await expect(copyPanel(page).getByRole('link', { name: '복사한 프로젝트 열기' })).toBeVisible(); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
});

for (const terminal of [false, true]) test(`uses ${terminal ? 'a new' : 'the same'} request only when failure state permits it`, async ({ page }) => {
  await metadata(page); const ids: string[] = [];
  await page.route(`**/api/publications/${id}/copy`, route => { ids.push(route.request().postDataJSON().requestId); return route.fulfill(ids.length === 1 ? { status: terminal ? 409 : 503, json: { error: { code: terminal ? 'COPY_SOURCE_CHANGED' : 'COPY_RETRYABLE', message: '복사 결과를 다시 확인해 주세요.', ...(terminal ? { issues: { requestEnded: true } } : {}) } } } : { json: { receipt } }); });
  await page.goto(`/explore/projects/${id}`); const panel = copyPanel(page); await panel.getByRole('button', { name: '내 프로젝트로 복사', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: terminal ? '내 프로젝트로 복사' : '같은 복사 요청 다시 확인', exact: true }).click(); await expect(panel.getByRole('link', { name: '복사한 프로젝트 열기' })).toBeVisible(); expect(ids).toHaveLength(2); expect(ids[0] === ids[1]).toBe(!terminal);
});

test('shows authentication failure without a copied record', async ({ page }) => {
  await metadata(page); await page.route(`**/api/publications/${id}/copy`, route => route.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } } }));
  await page.goto(`/explore/projects/${id}`); const panel = copyPanel(page); await panel.getByRole('button', { name: '내 프로젝트로 복사', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('로그인이 필요합니다.'); await expect(panel.getByRole('link', { name: '프로필·설정에서 로그인' })).toBeVisible(); await expect(panel.getByRole('link', { name: '복사한 프로젝트 열기' })).toHaveCount(0);
});

test('rejects a malformed successful response and keeps the original retry ID', async ({ page }) => {
  await metadata(page); await page.route(`**/api/publications/${id}/copy`, route => route.fulfill({ json: { receipt: { ...receipt, projectId: 'https://evil.invalid' } } }));
  await page.goto(`/explore/projects/${id}`); const panel = copyPanel(page); await panel.getByRole('button', { name: '내 프로젝트로 복사', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('저장 완료 정보를 확인하지 못했습니다.'); await expect(panel.getByRole('link', { name: '복사한 프로젝트 열기' })).toHaveCount(0); await expect(panel.getByRole('button', { name: '같은 복사 요청 다시 확인' })).toBeVisible();
});
