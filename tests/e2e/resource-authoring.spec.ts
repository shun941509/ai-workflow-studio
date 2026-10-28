import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inspectPackage } from '@studio/package-kit';
import { startResourceUiHarness } from '../fixtures/resource-ui-server';

let app: Awaited<ReturnType<typeof startResourceUiHarness>>;
test.beforeAll(async () => { app = await startResourceUiHarness(); });
test.afterAll(async () => { await app.close(); expect(app.failures).toEqual([]); });
test.beforeEach(({ page }) => { page.on('pageerror', error => console.error(error)); app.calls.length = 0; app.failDetail(false); });
const card = (page: Page, name: string) => page.locator('.resource-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const row = (page: Page, name: string) => page.locator('.picker-resource').filter({ has: page.getByText(name, { exact: true }) });
async function design(page: Page) { await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); const workflow = JSON.parse(await page.getByRole('textbox', { name: '워크플로 JSON' }).inputValue()); await page.getByRole('button', { name: '설계 창 닫기' }).click(); return workflow; }

/** Actual Chrome renders the shipped components. Local HTTP fixtures do not constitute live Auth/RLS validation. */
test('requires explicit MIT authority and resets each new material to private terms', async ({ page }) => {
  const submitted: Record<string, unknown>[] = [];
  // Only account persistence is replaced here. Server-side license validation and ZIP bytes have separate contract tests.
  await page.route('**/api/resources', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    submitted.push(route.request().postDataJSON()); await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.goto(app.url); await page.getByRole('button', { name: '자료 추가', exact: true }).click();
  await expect(page.getByLabel('자료 이용 조건', { exact: true })).toHaveValue('private');
  await page.getByLabel('자료 이름', { exact: true }).fill('원작 업무 지침');
  await page.getByLabel('내용', { exact: true }).fill('입력의 근거와 확인되지 않은 항목을 분리하세요.');
  await page.getByLabel('자료 이용 조건', { exact: true }).selectOption('MIT');
  await page.getByLabel('저작권자', { exact: true }).fill('가상 예제 작성자');
  await page.getByLabel('저작권 연도', { exact: true }).fill('2026');
  await expect(page.getByRole('button', { name: '계정에 저장', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: '이 자료에 MIT 이용 조건을 부여할 권한이 있음을 확인합니다.' }).check();
  await page.getByRole('button', { name: '계정에 저장', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 자료 저장', exact: true })).toHaveCount(0);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.license).toEqual({ id: 'MIT', copyrightHolder: '가상 예제 작성자', copyrightYear: 2026, confirmedAuthority: true });
  await page.getByRole('button', { name: '자료 추가', exact: true }).click();
  await expect(page.getByLabel('자료 이용 조건', { exact: true })).toHaveValue('private');
  await page.getByLabel('자료 이름', { exact: true }).fill('개인 자료'); await page.getByLabel('내용', { exact: true }).fill('개인용 내용입니다.');
  await page.getByRole('button', { name: '계정에 저장', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 자료 저장', exact: true })).toHaveCount(0);
  expect(submitted).toHaveLength(2); expect(submitted[1]).not.toHaveProperty('license');
});

test('loads 123 metadata items only by explicit pages, with no implicit content reads', async ({ page }) => {
  await page.goto(app.url); await expect(page.locator('.resource-card')).toHaveCount(40); expect(app.calls.filter(call => call.path.startsWith('/api/resources/'))).toHaveLength(0);
  await page.getByRole('button', { name: '자료 더 보기', exact: true }).dblclick(); await expect(page.locator('.resource-card')).toHaveCount(80);
  await page.getByRole('button', { name: '자료 더 보기', exact: true }).click(); await expect(page.locator('.resource-card')).toHaveCount(120);
  await page.getByRole('button', { name: '자료 더 보기', exact: true }).click(); await expect(page.locator('.resource-card')).toHaveCount(123); await expect(page.getByRole('button', { name: '자료 더 보기', exact: true })).toHaveCount(0);
  expect(app.calls.map(call => call.path)).toEqual(['/api/resources', '/api/resources?cursor=40', '/api/resources?cursor=80', '/api/resources?cursor=120']);
});
test('uses the selected immutable version despite late detail responses and shows failures', async ({ page }) => {
  const release = app.holdDetail(app.first.detail.version.id);
  try {
    await page.goto(app.url); await card(page, app.first.summary.name).click(); await expect(page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true })).toBeDisabled();
    await page.getByLabel('다운로드할 버전', { exact: true }).selectOption(app.old.detail.version.id); await expect(page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true })).toBeEnabled();
    release(); await expect(page.getByLabel('다운로드할 버전', { exact: true })).toHaveValue(app.old.detail.version.id);
    expect(await page.evaluate(() => Object.hasOwn(window, 'previewExecuted'))).toBe(false); await expect(page.getByText('must-never-render')).toHaveCount(0);
    await page.getByRole('button', { name: '자료 내용 닫기' }).click(); app.failDetail(true); await card(page, app.doc.summary.name).click(); await expect(page.getByRole('alert')).toHaveText('고정 버전의 원본을 확인할 수 없습니다.'); await expect(page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true })).toBeDisabled();
  } finally { release(); }
});
test('downloads original dependency closure and Skill files for all three hosts', async ({ page }, info) => {
  await page.goto(app.url); await card(page, app.first.summary.name).click(); await expect(page.getByText('선택한 버전과 고정된 의존 자료 1개를 포함합니다.')).toBeVisible();
  for (const host of ['codex', 'claude-code', 'opencode']) {
    await page.getByLabel('사용할 AI 도구', { exact: true }).selectOption(host); const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true }).click(); const download = await waiting;
    const imported = await inspectPackage(await readFile((await download.path())!)); expect(imported.manifest.resources).toEqual(app.first.detail.refs); for (const [path, data] of Object.entries(app.first.files)) expect(imported.files.get(path)).toEqual(data);
    const request = app.calls.filter(call => call.path === '/api/resources/export').at(-1)!; expect(request.body.resourceBindings).toEqual(app.first.detail.resourceBindings);
  }
  await page.getByRole('button', { name: '자료 내용 닫기' }).click(); await card(page, app.skill.summary.name).click(); await expect(page.getByText('SKILL.md ·', { exact: false })).toBeVisible(); await expect(page.getByText('복사한 파일 묶음의 정보입니다.', { exact: false })).toBeVisible();
  const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true }).click(); const archive = await inspectPackage(await readFile((await (await waiting).path())!)); expect([...archive.files.keys()].some(path => path.includes('/skills/') && path.endsWith('SKILL.md'))).toBe(true);
  await page.locator('.resource-detail').screenshot({ path: info.outputPath('private-resource-archive.png') });
});
test('cancels pending attachment on block switch and preserves closure through history, save, reopen and ZIP', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${app.url}/editor`); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('tab', { name: '자료·도구', exact: true }).click();
  const release = app.holdDetail(app.first.detail.version.id);
  try {
    await row(page, app.first.summary.name).getByRole('button', { name: '연결', exact: true }).click(); await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('start'); await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('work');
    await expect(row(page, app.first.summary.name).getByRole('button', { name: '연결', exact: true })).toBeEnabled(); release();
  } finally { release(); }
  await row(page, app.first.summary.name).getByRole('button', { name: '연결', exact: true }).click(); await expect(row(page, app.first.summary.name).getByRole('button', { name: '연결됨', exact: true })).toBeDisabled();
  expect((await design(page)).resources).toEqual(app.first.detail.refs); await page.getByRole('button', { name: '실행 취소', exact: true }).click(); expect((await design(page)).resources).toEqual({}); await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(row(page, app.skill.summary.name).getByRole('button', { name: '연결', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '계정에 저장', exact: true }).click(); await expect.poll(() => app.calls.filter(call => call.path === '/api/projects').length).toBe(1); const saved = app.calls.find(call => call.path === '/api/projects')!; expect(saved.body.resourceBindings).toEqual(app.first.detail.resourceBindings);
  for (const host of ['codex', 'claude-code', 'opencode']) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); await page.locator(`input[name="host"][value="${host}"]`).check(); const waiting = page.waitForEvent('download'); await page.getByRole('dialog').getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
    const archive = await inspectPackage(await readFile((await (await waiting).path())!)); expect(archive.workflow!.resources).toEqual(app.first.detail.refs); expect(app.calls.filter(call => call.path === '/api/exports').at(-1)!.body.resourceBindings).toEqual(app.first.detail.resourceBindings);
  }
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('tab', { name: '자료·도구', exact: true }).click(); expect((await design(page)).resources).toEqual(app.first.detail.refs);
  await page.getByRole('button', { name: `${app.first.summary.name} 연결 해제`, exact: true }).click(); expect((await design(page)).resources).toEqual({});
  await page.screenshot({ path: info.outputPath('private-resource-editor.png'), fullPage: true }); expect(errors).toEqual([]);
});
test('loads account bindings/origin and rejects changed dependency JSON without corrupting the draft', async ({ page }) => {
  await page.goto(`${app.url}/editor?project=10000000-0000-4000-8000-000000000999`); await expect(page.locator('.workflow-node')).toHaveCount(3); await expect(page.getByText('복사한 원본 정보', { exact: true })).toBeVisible();
  const previous = await design(page);
  for (const operation of ['replace', 'delete']) {
    const changed = structuredClone(previous); if (operation === 'replace') changed.resources[app.doc.alias].sha256 = 'f'.repeat(64); else delete changed.resources[app.doc.alias];
    await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON' }).fill(JSON.stringify(changed)); await page.getByRole('button', { name: '내용 적용', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('의존 자료'); await page.getByRole('button', { name: '설계 창 닫기' }).click(); expect((await design(page)).resources).toEqual(previous.resources);
  }
});

test('keeps no-configuration honest and caps selectable history at the actual latest 100 versions', async ({ page }) => {
  await page.goto(`${app.url}/?configured=false`); await expect(page.getByRole('button', { name: '자료 추가', exact: true })).toBeDisabled(); await expect(page.getByText('계정 저장 연결을 준비한 뒤 내 자료를 사용할 수 있습니다.', { exact: true })).toBeVisible(); expect(app.calls).toEqual([]);
  app.addVersionHistory(); await page.goto(app.url); await card(page, '자료 6').click(); await expect(page.getByLabel('다운로드할 버전', { exact: true }).locator('option')).toHaveCount(100); await expect(page.getByText('최근 100개 버전을 표시합니다.', { exact: false })).toBeVisible();
  await expect(page.getByRole('option', { name: '버전 1', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '자료 내용 닫기' }).click(); await card(page, '개인 문서 5').click(); await expect(page.locator('.resource-detail pre')).toHaveText('원문 <script>window.previewExecuted=true</script>'); expect(await page.evaluate(() => Object.hasOwn(window, 'previewExecuted'))).toBe(false);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true }).click(); const archive = await inspectPackage(await readFile((await (await pending).path())!)); const material = app.collection.find(item => item.summary.name === '개인 문서 5')!; expect(archive.manifest.resources).toEqual(material.detail.refs);
});

test('moves keyboard focus to the selected detail once and leaves loading/version controls alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto(app.url); await expect(page.locator('.resource-card')).toHaveCount(40);
  const release = app.holdDetail(app.first.detail.version.id);
  try {
    await card(page, app.first.summary.name).focus(); await page.keyboard.press('Enter');
    const heading = page.locator('.resource-detail h2'); await expect(heading).toBeFocused(); await expect(heading).toBeInViewport();
    const bounds = await heading.boundingBox(); expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000); await expect(page.getByLabel('다운로드할 버전', { exact: true })).toBeInViewport();
    const version = page.getByLabel('다운로드할 버전', { exact: true }); await version.focus(); release();
    await expect(page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true })).toBeEnabled(); await expect(version).toBeFocused();
    await version.selectOption(app.old.detail.version.id); await expect(page.getByRole('button', { name: '자료 ZIP 다운로드', exact: true })).toBeEnabled(); await expect(version).toBeFocused();
    // A different explicit card selection moves focus again, including when the previous detail was already open.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await card(page, app.second.summary.name).focus(); await page.keyboard.press('Enter'); await expect(heading).toHaveText(app.second.summary.name); await expect(heading).toBeFocused(); await expect(heading).toBeInViewport();
  } finally { release(); }
});
