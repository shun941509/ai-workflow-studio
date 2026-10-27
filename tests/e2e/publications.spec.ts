import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const id = '10000000-0000-4000-8000-000000000001';
const query = 'kind=project&collection=community';
const release = { id, kind: 'project', title: '문서 비교 프로젝트', description: '검수된 공개 메타데이터의 표시 계약을 확인합니다.', artifactSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), official: false, publishedAt: '2026-10-27T01:00:00.123456Z' };

/** No configured external service is contacted. The live local API must accurately report its pending boundary. */
test('four collections preserve official/community scope and show an honest unconfigured state', async ({ page }) => {
  const crashes: string[] = []; page.on('pageerror', (error) => crashes.push(error.message));
  for (const [path, title, kind, collection] of [['/explore/projects', '프로젝트 둘러보기', 'project', 'community'], ['/explore/resources', '도구 및 자료 둘러보기', 'resource', 'community'], ['/examples', '예제 프로젝트', 'project', 'official'], ['/examples/resources', '예제 자료 및 도구', 'resource', 'official']]) {
    const request = page.waitForResponse((response) => response.url().includes('/api/publications?') && new URL(response.url()).searchParams.get('kind') === kind && new URL(response.url()).searchParams.get('collection') === collection);
    await page.goto(path!); expect((await request).status()).toBe(503); await expect(page).toHaveURL(path!); await expect(page).toHaveTitle('AI Workflow Studio'); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: '공개 자료실 연결을 준비하고 있습니다' })).toBeVisible();
    await expect(page.getByRole('link', { name: /자세히 보기/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /다운로드|복사/ })).toHaveCount(0);
  }
  await page.screenshot({ path: join(tmpdir(), 'studio-publications-pending-desktop.png'), fullPage: true }); expect(crashes).toEqual([]);
});

test('search submits a bounded literal query and retry does not manufacture empty success', async ({ page }) => {
  await page.goto('/explore/projects'); await expect(page.getByRole('heading', { name: '공개 자료실 연결을 준비하고 있습니다' })).toBeVisible();
  await page.getByRole('textbox', { name: '공개 항목 제목 검색' }).fill("100%_문서 '");
  const response = page.waitForResponse((value) => new URL(value.url()).searchParams.get('q') === "100%_문서 '"); await page.getByRole('button', { name: '검색', exact: true }).click(); expect((await response).status()).toBe(503);
  await page.getByRole('button', { name: '다시 확인', exact: true }).click(); await expect(page.getByRole('heading', { name: '공개 자료실 연결을 준비하고 있습니다' })).toBeVisible(); await expect(page.getByText('검색 결과가 없습니다')).toHaveCount(0);
});

test('live metadata API validates query/cursor before configuration and never caches failures', async ({ request }) => {
  const pending = await request.get(`/api/publications?${query}`); expect(pending.status()).toBe(503); expect(pending.headers()['cache-control']).toBe('no-store'); expect(await pending.json()).toMatchObject({ error: { code: 'PUBLICATIONS_NOT_CONFIGURED' } });
  for (const suffix of ['&limit=999', '&kind=resource', `&q=${'x'.repeat(101)}`, '&cursor=not-valid', '&cursor=']) { const response = await request.get(`/api/publications?${query}${suffix}`); expect(response.status()).toBe(400); expect(response.headers()['cache-control']).toBe('no-store'); }
  expect((await request.get(`/api/publications/not-a-uuid?${query}`)).status()).toBe(404);
});

test('live report route rejects foreign/missing Origin, oversized JSON and forged reporter identity', async ({ request, baseURL }) => {
  const path = `/api/publications/${id}/reports`; const body = { reason: '구체적인 검토가 필요한 문제를 설명합니다.' };
  for (const origin of [undefined, 'https://unrelated.invalid']) { const response = await request.post(path, { data: body, headers: origin ? { Origin: origin } : {} }); expect(response.status()).toBe(403); expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } }); }
  expect((await request.post(path, { headers: { Origin: baseURL! }, data: { ...body, reporterId: id } })).status()).toBe(400);
  expect((await request.post(path, { headers: { Origin: baseURL! }, data: { reason: 'short' } })).status()).toBe(400);
  expect((await request.post(path, { headers: { Origin: baseURL! }, data: { reason: '😀'.repeat(5) } })).status()).toBe(400);
  expect((await request.post(path, { headers: { Origin: baseURL! }, data: { reason: 'x'.repeat(21000) } })).status()).toBe(413);
  const unavailable = await request.post(path, { headers: { Origin: baseURL! }, data: body }); expect(unavailable.status()).toBe(503); expect((await unavailable.json()).received).toBeUndefined();
});

test('mobile detail pending state is readable and returns to the actual collection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const crashes: string[] = []; page.on('pageerror', (error) => crashes.push(error.message));
  await page.goto(`/examples/resources/${id}`); await expect(page.getByRole('heading', { name: '항목을 확인할 수 없습니다' })).toBeVisible(); await expect(page.getByRole('button', { name: '신고 접수' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: join(tmpdir(), 'studio-publications-pending-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: '목록으로 돌아가기' }).click(); await expect(page).toHaveURL('/examples/resources'); expect(crashes).toEqual([]);
});

/** Transport fixtures test rendering only; actual publication authorization and search execute in discovery.test.ts. */
test('metadata cards paginate without rendering HTML and disappear after a fresh withdrawal response', async ({ page }) => {
  let withdrawn = false; const seen: string[] = [];
  await page.route('**/api/publications?**', (route) => { const url = new URL(route.request().url()); seen.push(url.searchParams.get('cursor') ?? 'first'); return route.fulfill({ contentType: 'application/json', body: JSON.stringify(withdrawn ? { items: [], nextCursor: null } : { items: [{ ...release, title: '<img src=x onerror=alert(1)> 공개 제목' }], nextCursor: url.searchParams.has('cursor') ? null : 'test-transport-cursor' }) }); });
  await page.goto('/explore/projects'); await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)> 공개 제목', exact: true })).toBeVisible(); await expect(page.locator('main img')).toHaveCount(0);
  await page.getByRole('button', { name: '다음', exact: true }).click(); await expect(page.getByText('2 페이지')).toBeVisible(); expect(seen).toContain('test-transport-cursor');
  withdrawn = true; await page.getByRole('button', { name: '공개 목록 새로고침' }).click(); await expect(page.getByText('아직 공개된 항목이 없습니다')).toBeVisible(); await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)> 공개 제목', exact: true })).toHaveCount(0);
});

test('detail report presents authentication errors and never shows a false receipt', async ({ page }) => {
  await page.route(`**/api/publications/${id}?**`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: release }) }));
  await page.route(`**/api/publications/${id}/reports`, async (route) => { expect(route.request().postDataJSON()).toEqual({ reason: '검토할 부분을 구체적으로 설명합니다.' }); await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } }) }); });
  await page.goto(`/explore/projects/${id}`); await expect(page.getByRole('heading', { name: release.title, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /복사|다운로드/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: '신고 사유' }).fill('짧음'); await expect(page.getByRole('button', { name: '신고 접수', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '신고 사유' }).fill('검토할 부분을 구체적으로 설명합니다.'); await page.getByRole('button', { name: '신고 접수', exact: true }).click();
  await expect(page.getByRole('link', { name: '프로필·설정에서 로그인' })).toBeVisible(); await expect(page.getByText('신고를 접수했습니다.', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'studio-publications-report-error.png'), fullPage: true });
});

test('network failures clear previous public metadata and offer a real retry', async ({ page }) => {
  let fail = false; await page.route('**/api/publications?**', (route) => fail ? route.abort('failed') : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [release], nextCursor: null }) }));
  await page.goto('/explore/projects'); await expect(page.getByRole('heading', { name: release.title, exact: true })).toBeVisible(); fail = true; await page.getByRole('button', { name: '공개 목록 새로고침' }).click();
  await expect(page.getByRole('heading', { name: '공개 목록을 확인하지 못했습니다' })).toBeVisible(); await expect(page.getByRole('heading', { name: release.title, exact: true })).toHaveCount(0); fail = false; await page.getByRole('button', { name: '다시 확인' }).click(); await expect(page.getByRole('heading', { name: release.title, exact: true })).toBeVisible();
});
