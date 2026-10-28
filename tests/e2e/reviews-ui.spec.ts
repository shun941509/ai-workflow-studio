import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewDetail } from '../../apps/studio-web/src/features/reviews/types';

const id = '10000000-0000-4000-8000-000000000001'; const hash = 'a'.repeat(64); const timestamp = '2026-10-28T00:00:00.000Z';
/** Transport fixtures exercise rendering/interaction only; live Auth/RLS/scan authority is tested in PostgreSQL, not faked in product. */
function fixture(): ReviewDetail {
  return { submission: { id, kind: 'project', status: 'scanned', created_at: timestamp }, scan: { artifact_sha256: hash, manifest_sha256: 'b'.repeat(64), passed: true, created_at: timestamp, evidence: { reportSha256: 'c'.repeat(64), sourceSnapshotSha256: 'd'.repeat(64), scannerVersion: '1.0.0', policy: { id: 'static-policy', version: '1.0.0', sha256: 'e'.repeat(64) }, checks: Object.fromEntries(['archive', 'source', 'files', 'secrets', 'capabilities', 'dependencies', 'rights', 'staticRisks'].map((key) => [key, 'passed'])), findings: [] } }, review: null, readiness: { status: 'scanned', artifactSha256: hash, reportSha256: 'c'.repeat(64), canApprove: true, canReject: true, rights: { state: 'active', expiresAt: '2036-10-28T00:00:00.000Z', checkedAt: timestamp }, blockedReasons: [], published: false }, notice: 'Static evidence only', publicationAvailable: false };
}
function completed(value: ReviewDetail, decision: 'approved' | 'rejected', reason: string): ReviewDetail { return { ...value, submission: { ...value.submission, status: decision }, readiness: { ...value.readiness, status: decision, canApprove: false, canReject: false, blockedReasons: ['NOT_AWAITING_REVIEW'] }, review: { artifact_sha256: value.scan!.artifact_sha256, decision, reason, created_at: timestamp } }; }
async function fillDecision(page: Page, reason = '고정 파일과 검사 결과 및 남은 제한을 확인했습니다.') { await page.getByRole('textbox', { name: '구체적인 검수 사유' }).fill(reason); await page.getByRole('checkbox', { name: /표시된 ZIP SHA-256/ }).check(); }

test('unconfigured administrator route shows preparation and keeps the ordinary eight menus', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message)); await page.goto('/admin/reviews');
  await expect(page).toHaveTitle('AI Workflow Studio'); await expect(page.getByRole('heading', { name: '관리자 검수', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: '관리자 서비스 연결을 준비하고 있습니다' })).toBeVisible();
  await expect(page.locator('.sidebar nav a')).toHaveCount(8); await expect(page.locator('.sidebar nav')).not.toContainText('관리자'); await expect(page.getByText('현재 상태의 제출 항목이 없습니다')).toHaveCount(0);
  await page.getByRole('button', { name: '다시 확인' }).click(); await expect(page.getByRole('heading', { name: '관리자 서비스 연결을 준비하고 있습니다' })).toBeVisible(); await page.screenshot({ path: join(tmpdir(), 'studio-reviews-pending.png'), fullPage: true }); expect(errors).toEqual([]);
});

for (const [status, title] of [[401, '로그인이 필요합니다'], [403, '검수 권한이 필요합니다']] as const) test(`administrator UI handles real HTTP ${status} status without privileged controls`, async ({ page }) => {
  await page.route('**/api/admin/reviews?**', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: status === 401 ? 'AUTH_REQUIRED' : 'REVIEW_ROLE_REQUIRED', message: title } }) })); await page.goto('/admin/reviews'); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /승인 기록|반려 기록/ })).toHaveCount(0);
  if (status === 401) await expect(page.getByRole('link', { name: '프로필·설정에서 로그인' })).toHaveAttribute('href', '/account');
});

test('queue status filter and cursor send exact bounded API parameters', async ({ page }) => {
  const seen: URL[] = []; await page.route('**/api/admin/reviews?**', (route) => { const url = new URL(route.request().url()); seen.push(url); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ ...fixture().submission, status: url.searchParams.get('status') }], next: url.searchParams.has('before') ? null : { before: timestamp, id } }) }); });
  await page.goto('/admin/reviews'); await expect(page.getByRole('link', { name: /프로젝트 검수/ })).toBeVisible(); await page.getByRole('button', { name: '다음', exact: true }).click(); await expect(page.getByText('2 페이지')).toBeVisible(); expect(seen.at(-1)!.searchParams.get('id')).toBe(id);
  await page.getByRole('combobox', { name: '검수 상태', exact: true }).selectOption('changes_requested'); await expect(page.getByText('1 페이지')).toBeVisible(); expect(seen.at(-1)!.searchParams.has('before')).toBe(false); expect(seen.at(-1)!.searchParams.get('status')).toBe('changes_requested');
});

test('exact hash confirmation records one decision and clearly separates approval from publication', async ({ page }) => {
  let current = fixture(); let writes = 0; await page.route(`**/api/admin/reviews/${id}`, async (route) => {
    if (route.request().method() === 'POST') { writes++; const body = route.request().postDataJSON(); expect(body.artifactSha256).toBe(hash); expect(Object.keys(body).sort()).toEqual(['artifactSha256', 'decision', 'reason']); current = completed(current, 'approved', body.reason); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: true, decision: 'approved', artifactSha256: hash, published: false }) }); }
    else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) });
  });
  await page.goto(`/admin/reviews/${id}`); await expect(page.getByTestId('review-artifact-hash')).toHaveText(hash); await expect(page.getByRole('button', { name: '승인 기록', exact: true })).toBeDisabled(); await fillDecision(page);
  // Two immediate native clicks exercise the synchronous in-flight guard, not only the later disabled render.
  await page.getByRole('button', { name: '승인 기록', exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: '이미 저장된 검수 결정' })).toBeVisible(); expect(writes).toBe(1); await expect(page.getByText('승인 결정을 저장했습니다. 서명하거나 게시하지 않았습니다.')).toBeVisible(); await expect(page.getByRole('button', { name: /서명|게시/ })).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'studio-reviews-approved.png'), fullPage: true });
});

for (const state of ['revoked', 'expired'] as const) test(`${state} rights disable approval while allowing an explicit rejection`, async ({ page }) => {
  let current = fixture(); current.readiness.canApprove = false; current.readiness.rights.state = state; current.readiness.blockedReasons = [`RIGHTS_${state.toUpperCase()}`];
  await page.route(`**/api/admin/reviews/${id}`, async (route) => { if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); expect(body.decision).toBe('rejected'); current = completed(current, 'rejected', body.reason); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: true, decision: 'rejected', published: false }) }); } else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) }); });
  await page.goto(`/admin/reviews/${id}`); await expect(page.getByText(state === 'revoked' ? '검증 권한 취소됨' : '권리 근거 만료', { exact: true })).toBeVisible(); await fillDecision(page, '현재 유효한 권리 근거를 다시 준비해야 합니다.'); await expect(page.getByRole('button', { name: '승인 기록', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '반려 기록', exact: true }).click(); await expect(page.getByRole('heading', { name: '이미 저장된 검수 결정' })).toBeVisible();
});

test('competing review refreshes the current record and renders reason text without executing HTML', async ({ page }) => {
  let current = fixture(); const otherReason = '<img src=x onerror=alert(1)> 다른 검수자가 기록한 사유';
  await page.route(`**/api/admin/reviews/${id}`, async (route) => { if (route.request().method() === 'POST') { current = completed(current, 'rejected', otherReason); await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'REVIEW_CONFLICT', message: '상태 변경' } }) }); } else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) }); });
  await page.goto(`/admin/reviews/${id}`); await fillDecision(page); await page.getByRole('button', { name: '승인 기록', exact: true }).click(); await expect(page.getByText(otherReason, { exact: true })).toBeVisible(); await expect(page.locator('main img')).toHaveCount(0); await expect(page.getByRole('main').getByRole('alert')).toContainText('다른 검수 또는 상태 변경'); await expect(page.getByRole('button', { name: '승인 기록', exact: true })).toHaveCount(0); await expect(page.getByText('승인 결정을 저장했습니다.', { exact: false })).toHaveCount(0);
});

test('changed artifact information resets draft reason/confirmation and requires a new review', async ({ page }) => {
  let current = fixture(); await page.route(`**/api/admin/reviews/${id}`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) })); await page.goto(`/admin/reviews/${id}`); await fillDecision(page);
  current = structuredClone(current); current.scan!.artifact_sha256 = 'f'.repeat(64); current.readiness.artifactSha256 = 'f'.repeat(64); current.scan!.evidence!.reportSha256 = '1'.repeat(64); current.readiness.reportSha256 = '1'.repeat(64);
  await page.getByRole('button', { name: '검수 상태 새로고침' }).click(); await expect(page.getByTestId('review-artifact-hash')).toHaveText('f'.repeat(64)); await expect(page.getByRole('checkbox', { name: /표시된 ZIP SHA-256/ })).not.toBeChecked(); await expect(page.getByRole('textbox', { name: '구체적인 검수 사유' })).toHaveValue(''); await expect(page.getByRole('button', { name: '승인 기록', exact: true })).toBeDisabled();
});

test('mobile blocked report stays readable with no approval controls or file execution preview', async ({ page }) => {
  const current = fixture(); current.submission.status = 'changes_requested'; current.readiness.status = 'changes_requested'; current.readiness.canApprove = false; current.readiness.canReject = false; current.readiness.rights.state = 'unverified'; current.readiness.blockedReasons = ['NOT_AWAITING_REVIEW', 'SCAN_INCOMPLETE_OR_INCONSISTENT', 'RIGHTS_UNVERIFIED']; current.scan!.evidence!.checks.files = 'unverified'; current.scan!.evidence!.findings = [{ check: 'files', code: 'EXECUTABLE_CONTENT_UNVERIFIED', status: 'unverified', path: 'resources/example/scripts/task.js' }];
  await page.route(`**/api/admin/reviews/${id}`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) })); await page.setViewportSize({ width: 390, height: 844 }); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message)); await page.goto(`/admin/reviews/${id}`); await expect(page.getByText('EXECUTABLE_CONTENT_UNVERIFIED', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: /승인 기록|반려 기록/ })).toHaveCount(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]); await page.screenshot({ path: join(tmpdir(), 'studio-reviews-blocked-mobile.png'), fullPage: true });
});
