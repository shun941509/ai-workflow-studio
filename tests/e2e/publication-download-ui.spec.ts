import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deliveryArtifact } from '../helpers/publication-delivery';

const id = '10000000-0000-4000-8000-000000000001';
const release = { id, kind: 'project', title: '원본 ZIP 전달 확인', description: '내부 HTTP 경계 시험입니다.', artifactSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), official: false, publishedAt: '2026-10-27T00:00:00.000Z' };

/** Transport responses are internal fixtures; real ZIP/signature verification lives in separate server/database suites. */
for (const host of ['codex', 'claude-code', 'opencode'] as const) test(`downloads the exact displayed ${host} ZIP after completion`, async ({ page }) => {
  const item = await deliveryArtifact({ host });
  await page.route(`**/api/publications/${id}?**`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: { ...release, artifactSha256: item.report.artifactSha256, manifestSha256: item.report.manifestSha256 } }) }));
  await page.route(`**/api/publications/${id}/download`, route => route.fulfill({ contentType: 'application/zip', headers: { 'Content-Disposition': `attachment; filename="workflow-${id}-${host}.zip"`, 'Cache-Control': 'no-store' }, body: Buffer.from(item.bytes) }));
  await page.goto(`/explore/projects/${id}`); const event = page.waitForEvent('download'); await page.getByRole('button', { name: '운영 ZIP 다운로드', exact: true }).click(); const download = await event;
  expect(download.suggestedFilename()).toBe(`workflow-${id}-${host}.zip`); expect(await readFile((await download.path())!)).toEqual(Buffer.from(item.bytes));
  await expect(page.getByText('원본 ZIP을 브라우저 다운로드로 전달했습니다.', { exact: false })).toBeVisible();
});

for (const status of [401, 404, 503]) test(`shows HTTP ${status} without claiming a download`, async ({ page }) => {
  await page.route(`**/api/publications/${id}?**`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: release }) }));
  await page.route(`**/api/publications/${id}/download`, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { message: status === 401 ? '로그인이 필요합니다.' : '현재 내려받을 수 있는 공개 파일이 없습니다.' } }) }));
  let downloads = 0; page.on('download', () => downloads++); await page.goto(`/explore/projects/${id}`); await page.getByRole('button', { name: '운영 ZIP 다운로드', exact: true }).click();
  await expect(page.locator('section[aria-label="공개 ZIP 다운로드"] [role="alert"]')).toBeVisible();
  if (status === 401) await expect(page.getByRole('link', { name: '프로필·설정에서 로그인' })).toBeVisible();
  expect(downloads).toBe(0); await expect(page.getByText('원본 ZIP을 브라우저 다운로드로 전달했습니다.', { exact: false })).toHaveCount(0);
});

test('rejects changed bytes and suppresses duplicate clicks while verifying', async ({ page }) => {
  const item = await deliveryArtifact(); let calls = 0;
  // Hold the response until the busy state has been observed; fixed delays race a loaded browser.
  let releaseResponse!: () => void; const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route(`**/api/publications/${id}?**`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: release }) }));
  await page.route(`**/api/publications/${id}/download`, async route => { calls++; await responseGate; await route.fulfill({ contentType: 'application/zip', headers: { 'Content-Disposition': `attachment; filename="workflow-${id}-codex.zip"` }, body: Buffer.from(item.bytes) }); });
  let downloads = 0; page.on('download', () => downloads++); await page.goto(`/explore/projects/${id}`); const button = page.getByRole('button', { name: '운영 ZIP 다운로드', exact: true }); await button.click();
  try { const busy = page.getByRole('button', { name: '공개 파일 확인 중…', exact: true }); await expect(busy).toBeDisabled(); await busy.dispatchEvent('click'); expect(calls).toBe(1); }
  finally { releaseResponse(); }
  await expect(page.getByText('받은 파일이 화면의 공개 버전과 다릅니다.', { exact: false })).toBeVisible(); expect(calls).toBe(1); expect(downloads).toBe(0);
});
