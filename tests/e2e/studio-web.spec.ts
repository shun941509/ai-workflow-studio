import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { createBasicWorkflow, createNode } from '@studio/spec';

/** Browser acceptance checks use real authoring/storage/export code; they do not fake model execution. */
test("eight menus and profile navigation preserve the product information architecture", async ({ page }, info) => {
  const crashes: string[] = []; page.on("pageerror", (error) => crashes.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("어떤 일을 AI와 함께 해볼까요?");
  await expect(page.locator(".sidebar nav a")).toHaveCount(8);
  await expect(page.locator(".sidebar nav")).not.toContainText("프로필·설정");
  await expect(page.locator(".profile-link")).toHaveAttribute("href", "/account");
  await page.screenshot({ path: info.outputPath("home.png"), fullPage: true });
  expect(crashes).toEqual([]);
});

test("editor edits, undoes, deletes, reports validation and restores a real browser draft", async ({ page }, info) => {
  const crashes: string[] = []; page.on("pageerror", (error) => crashes.push(error.message));
  await page.goto("/projects/new");
  await expect(page.locator(".workflow-node")).toHaveCount(3);
  await page.getByRole("textbox", { name: "프로젝트 이름" }).fill("실제 브라우저 저장 검증");
  await page.getByRole("textbox", { name: "AI에게 요청할 작업" }).fill("입력 내용을 세 가지 항목으로 요약하세요. 없는 사실을 추가하지 마세요.");
  await page.locator(".node-palette .palette-node.node-ai").click();
  await expect(page.locator(".workflow-node")).toHaveCount(4);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.locator(".workflow-node")).toHaveCount(3);
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await expect(page.locator(".workflow-node")).toHaveCount(4);
  await page.getByRole("button", { name: "선택한 블록 삭제", exact: true }).click();
  await expect(page.locator(".workflow-node")).toHaveCount(3);
  await page.getByRole("button", { name: /준비 상태 확인/ }).click();
  await expect(page.getByText("설계 검사를 통과했습니다")).toBeVisible();
  await expect(page.getByText("이 브라우저에 저장됨", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "내 프로젝트로 돌아가기" }).click();
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "실제 브라우저 저장 검증" }) }).click();
  await expect(page.getByRole("textbox", { name: "프로젝트 이름" })).toHaveValue("실제 브라우저 저장 검증");
  await expect(page.getByRole("textbox", { name: "AI에게 요청할 작업" })).toHaveValue("입력 내용을 세 가지 항목으로 요약하세요. 없는 사실을 추가하지 마세요.");
  await page.screenshot({ path: info.outputPath("editor.png"), fullPage: true });
  expect(crashes).toEqual([]);
});

test("all three operational ZIP downloads contain the actual saved design", async ({ page }) => {
  await page.goto("/projects/new");
  await expect(page.locator(".workflow-node")).toHaveCount(3);
  await page.getByRole("textbox", { name: "프로젝트 이름" }).fill("운영 ZIP 사용 경로 검증");
  for (const [host, label] of [["codex", "Codex"], ["claude-code", "Claude Code"], ["opencode", "OpenCode"]] as const) {
    await page.getByRole("button", { name: "ZIP 다운로드", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "내 도구에서 이어서 실행" });
    await dialog.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "ZIP 다운로드", exact: true }).click();
    const download = await downloaded; const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const files = unzipSync(new Uint8Array(await readFile(filePath!)));
    const decode = (name: string) => new TextDecoder().decode(files[name]);
    const manifest = JSON.parse(decode("manifest.json"));
    expect(manifest.targetHost).toBe(host);
    expect(manifest.purpose).toBe("production");
    expect(files["manifest.sig"]).toBeUndefined();
    expect(JSON.parse(decode("workflow.json")).name).toBe("운영 ZIP 사용 경로 검증");
    expect(Object.keys(files).some((name) => /fixture|verification\.spec|node_modules/.test(name))).toBe(false);
    // Independent byte hashing avoids merely reusing the exporter implementation as its own oracle.
    for (const entry of manifest.files) expect(createHash("sha256").update(files[entry.path]!).digest("hex")).toBe(entry.sha256);
  }
});

test("invalid input references prevent export and reveal their editable source", async ({ page }) => {
  await page.goto("/projects/new"); await expect(page.locator(".workflow-node")).toHaveCount(3);
  await page.getByRole("tab", { name: "입력·결과" }).click();
  await page.getByText("입력 참조 고급 JSON", { exact: true }).click();
  await page.getByRole("textbox", { name: "입력 참조", exact: true }).fill('{"content":{"from":"node","nodeId":"missing","pointer":"/data","onMissing":"error"}}');
  await page.getByRole("button", { name: "입력 참조 적용" }).click();
  await page.getByRole("button", { name: "ZIP 다운로드", exact: true }).click();
  await expect(page.locator(".validation-panel")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".validation-panel li").first()).toBeVisible();
});

test("canvas drag and connection gestures update the executable graph", async ({ page }) => {
  await page.goto("/projects/new"); await expect(page.locator(".workflow-node")).toHaveCount(3);
  // Drop on empty canvas rather than an existing node's connection handle after fit-view scales the graph.
  await page.locator(".node-palette .palette-node.node-ai").dragTo(page.locator(".canvas-area"), { targetPosition: { x: 240, y: 240 } });
  await expect(page.locator(".workflow-node")).toHaveCount(4);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.locator(".workflow-node")).toHaveCount(3);
  const edge = page.locator('.react-flow__edge[data-id="start_to_work"]');
  await edge.click({ force: true }); await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  const source = page.locator('[aria-label="작업할 내용 다음 작업"]');
  const target = page.locator('[aria-label="AI 작업 실행 입력"]');
  await source.dragTo(target);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByRole("button", { name: /준비 상태 확인/ }).click();
  await expect(page.getByText("설계 검사를 통과했습니다")).toBeVisible();
});

test("export rejects cross-origin and ambiguous JSON requests before building an archive", async ({ request, baseURL }) => {
  const foreign = await request.post("/api/exports", { headers: { Origin: "https://foreign.invalid" }, data: {} });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error.code).toBe("ORIGIN_DENIED");
  const malformed = await request.post("/api/exports", { headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" }, data: '{"host":"codex","host":"opencode"}' });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error.code).toBe("JSON_INVALID");
});

test("account and unpublished examples describe prerequisites without fake records", async ({ page }) => {
  await page.goto("/examples");
  await expect(page.getByRole("heading", { name: "검증된 공식 예제를 준비하고 있습니다" })).toBeVisible();
  await expect(page.getByText("아직 게시된 항목은 없습니다.", { exact: false })).toBeVisible();
  await page.goto("/account"); await expect(page.getByRole("heading", { level: 1 })).toHaveText("프로필·설정");
  await expect(page.getByRole("heading", { name: "저장 위치 안내" })).toBeVisible();
});

test("resource connection stays honest when the account service is not configured", async ({ page }) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('tab', { name: '자료·도구' }).click();
  // This local acceptance environment intentionally has no Supabase project or fabricated account records.
  await expect(page.getByText('계정 연결을 준비한 뒤 저장한 자료를 선택할 수 있습니다.')).toBeVisible();
  await expect(page.locator('.picker-resource')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '프로필·설정에서 확인', exact: true })).toHaveAttribute('href', '/account');
  await page.goto('/resources');
  await expect(page.getByRole('button', { name: '자료 추가', exact: true })).toBeDisabled();
  await expect(page.locator('.resource-card')).toHaveCount(0);
});

/** Helpers operate the visible forms and download actual server-built bytes; they do not insert browser storage records. */
async function selectBlock(page: Page, label: string, tab = '기본') {
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption({ label });
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
async function addBlock(page: Page, type: string, name: string) {
  await page.locator(`.node-palette .node-${type}`).click();
  await page.getByRole('tab', { name: '기본', exact: true }).click();
  await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill(name);
}
async function connectBlock(page: Page, name: string, port: string, target: string) {
  await selectBlock(page, name);
  await page.getByRole('combobox', { name: `${port} 연결`, exact: true }).selectOption({ label: target });
}
async function inputValue(page: Page, name: string, label: string, source?: string, pointer = '/data') {
  await selectBlock(page, name, '입력·결과');
  const add = page.getByRole('button', { name: `${label} 연결`, exact: true });
  if (await add.count()) await add.click();
  await page.getByRole('combobox', { name: `${label} 가져올 곳`, exact: true }).selectOption(source ? 'node' : 'workflowInput');
  if (source) {
    // Labels include the registry title; choose by the actual option text rather than guessed node ids.
    const select = page.getByRole('combobox', { name: `${label} 결과 블록`, exact: true });
    const option = select.locator('option').filter({ hasText: new RegExp(`^${source} ·`) });
    await select.selectOption(await option.getAttribute('value') ?? '');
  }
  await page.getByRole('textbox', { name: `${label} 값 위치`, exact: true }).fill(source ? pointer : '/text');
}
async function downloadedWorkflow(page: Page) {
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' });
  await expect(dialog).toBeVisible();
  const wait = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  const download = await wait; const path = await download.path();
  const files = unzipSync(new Uint8Array(await readFile(path!)));
  return JSON.parse(new TextDecoder().decode(files['workflow.json']));
}

test('forms author a conditional diamond and active-branch merge without JSON editing', async ({ page }, info) => {
  const crashes: string[] = []; page.on('pageerror', (error) => crashes.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.palette-node')).toHaveCount(20);
  await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
  await addBlock(page, 'condition', '내용 확인');
  await page.getByRole('combobox', { name: '분기 조건 방식', exact: true }).selectOption('eq');
  await page.getByRole('textbox', { name: '분기 조건 2 비교 값', exact: true }).fill('yes');
  for (const [name, template] of [['일치 결과', '일치: {{}}'], ['불일치 결과', '불일치: {{}}']]) {
    await addBlock(page, 'transform', name!);
    await page.getByRole('combobox', { name: '변환 1 방식', exact: true }).selectOption('format');
    await page.getByRole('textbox', { name: '변환 1 문장 템플릿', exact: true }).fill(template!);
    await inputValue(page, name!, '검사·처리할 값');
  }
  await addBlock(page, 'merge', '분기 합류');
  await page.getByRole('combobox', { name: '합치는 방법', exact: true }).selectOption('select');
  await inputValue(page, '내용 확인', '검사·처리할 값');
  await selectBlock(page, '분기 합류', '입력·결과');
  for (const [alias, name] of [['matched', '일치 결과'], ['unmatched', '불일치 결과']]) {
    await page.getByRole('textbox', { name: '합칠 입력 이름', exact: true }).fill(alias!);
    await page.getByRole('button', { name: '합칠 입력 추가', exact: true }).click();
    const select = page.getByRole('combobox', { name: `${alias} 결과 블록`, exact: true });
    await select.selectOption(await select.locator('option').filter({ hasText: new RegExp(`^${name} ·`) }).getAttribute('value') ?? '');
    await expect(page.getByRole('combobox', { name: `${alias} 값이 없을 때`, exact: true })).toHaveValue('omit');
  }
  await inputValue(page, '결과', '최종 결과', '분기 합류');
  for (const [from, port, to] of [['작업할 내용', '다음 작업', '내용 확인'], ['내용 확인', '조건 일치', '일치 결과'], ['내용 확인', '조건 불일치', '불일치 결과'], ['일치 결과', '다음 작업', '분기 합류'], ['불일치 결과', '다음 작업', '분기 합류'], ['분기 합류', '다음 작업', '결과']]) await connectBlock(page, from!, port!, to!);
  await page.getByRole('button', { name: /준비 상태 확인/ }).click();
  await expect(page.getByText('설계 검사를 통과했습니다', { exact: true })).toBeVisible();
  const workflow = await downloadedWorkflow(page);
  expect(workflow.nodes.find((node: { type: string }) => node.type === 'condition').config.expression).toEqual({ op: 'eq', args: [{ var: '/value' }, { literal: 'yes' }] });
  expect(workflow.nodes.find((node: { type: string }) => node.type === 'merge').config).toEqual({ waitFor: 'all_active', combine: 'select', collision: 'error' });
  expect(workflow.edges).toHaveLength(6); expect(crashes).toEqual([]);
  await expect.poll(async () => {
    const canvas = await page.locator('.canvas-area').boundingBox(); if (!canvas) return false;
    for (const node of await page.locator('.workflow-node').all()) { const box = await node.boundingBox(); if (!box || box.x < canvas.x || box.y < canvas.y || box.x + box.width > canvas.x + canvas.width || box.y + box.height > canvas.y + canvas.height) return false; }
    return true;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath('conditional-editor.png'), fullPage: true });
});

test('question and review forms preserve response schemas and both review decisions in ZIP', async ({ page }) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
  await addBlock(page, 'form', '추가 질문');
  await page.getByRole('combobox', { name: '질문 시점', exact: true }).selectOption('request');
  await page.getByRole('textbox', { name: '질문 제목', exact: true }).fill('검토할 제목을 입력해 주세요');
  await page.getByRole('textbox', { name: '사용자 응답 새 항목 이름', exact: true }).fill('title');
  await page.getByRole('button', { name: '항목 추가', exact: true }).click();
  await addBlock(page, 'review', '제목 검토');
  await page.getByRole('textbox', { name: '검토 요청', exact: true }).fill('이 제목을 사용할까요?');
  await inputValue(page, '제목 검토', '검사·처리할 값', '추가 질문', '/data/title');
  await addBlock(page, 'merge', '검토 합류');
  await page.getByRole('combobox', { name: '합치는 방법', exact: true }).selectOption('select');
  await selectBlock(page, '검토 합류', '입력·결과');
  await page.getByRole('textbox', { name: '합칠 입력 이름', exact: true }).fill('reviewed');
  await page.getByRole('button', { name: '합칠 입력 추가', exact: true }).click();
  const reviewed = page.getByRole('combobox', { name: 'reviewed 결과 블록', exact: true });
  await reviewed.selectOption(await reviewed.locator('option').filter({ hasText: '제목 검토 ·' }).getAttribute('value') ?? '');
  await selectBlock(page, '결과');
  await page.getByRole('combobox', { name: '결과 표시 방식', exact: true }).selectOption('json');
  await page.getByRole('combobox', { name: '최종 결과 형식 형식', exact: true }).selectOption('any');
  await inputValue(page, '결과', '최종 결과', '검토 합류');
  for (const [from, port, to] of [['작업할 내용', '다음 작업', '추가 질문'], ['추가 질문', '다음 작업', '제목 검토'], ['제목 검토', '수락', '검토 합류'], ['제목 검토', '반려', '검토 합류'], ['검토 합류', '다음 작업', '결과']]) await connectBlock(page, from!, port!, to!);
  const workflow = await downloadedWorkflow(page);
  expect(workflow.nodes.find((node: { type: string }) => node.type === 'form').config.schema).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false });
  const review = workflow.nodes.find((node: { type: string }) => node.type === 'review');
  expect(workflow.edges.filter((edge: { from: { nodeId: string } }) => edge.from.nodeId === review.id).map((edge: { from: { port: string } }) => edge.from.port).sort()).toEqual(['accepted', 'rejected']);
});

test('resource read exposes its pin selection and blocks a missing account material instead of inventing text', async ({ page }) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await addBlock(page, 'resource', '원문 읽기');
  await expect(page.getByRole('combobox', { name: '읽을 자료', exact: true })).toHaveValue('pending-resource');
  await page.getByRole('tab', { name: '자료·도구', exact: true }).click();
  await expect(page.getByText('계정 연결을 준비한 뒤 저장한 자료를 선택할 수 있습니다.')).toBeVisible();
  await expect(page.locator('.picker-resource')).toHaveCount(0);
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  await expect(page.locator('.validation-panel')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('운영 ZIP을 내려받았습니다.', { exact: false })).toHaveCount(0);
});

test('classification, protection, evaluation and recovery forms retain typed settings after restoring a draft', async ({ page }) => {
  const crashes: string[] = []; page.on('pageerror', (error) => crashes.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('textbox', { name: '프로젝트 이름', exact: true }).fill('설정 복원 확인');
  await addBlock(page, 'classify', '문의 분류');
  await page.getByRole('textbox', { name: '분류 1 이름', exact: true }).fill('support');
  await page.getByRole('textbox', { name: '분류 1 기준', exact: true }).fill('사용법 문의');
  await page.getByRole('button', { name: '분류 추가', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'support 연결', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '분류 불가 연결', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'support 연결', exact: true }).selectOption({ label: '결과' });
  await page.getByRole('textbox', { name: '분류 1 이름', exact: true }).fill('renamed');
  await page.getByRole('button', { name: '사용하지 않는 연결 제거', exact: true }).click();
  await expect(page.getByRole('button', { name: '사용하지 않는 연결 제거', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '분류 1 이름', exact: true }).fill('support');
  await addBlock(page, 'guardrail', '허용 문구 검사');
  await page.getByRole('combobox', { name: '보호 규칙 1 종류', exact: true }).selectOption('allowed_values');
  await page.getByRole('textbox', { name: '허용 값 1', exact: true }).fill('안내');
  await addBlock(page, 'evaluate', '내용 평가');
  await page.getByRole('combobox', { name: '평가 1 방식', exact: true }).selectOption('exists');
  await page.getByRole('textbox', { name: '평가 1 1 값 위치', exact: true }).fill('/value/title');
  await addBlock(page, 'error', '업무 복구');
  await page.getByRole('combobox', { name: '업무 오류 처리 방식', exact: true }).selectOption('recover');
  await page.getByRole('tab', { name: '입력·결과', exact: true }).click();
  await page.getByRole('button', { name: '대체 결과 연결', exact: true }).click();
  await page.getByRole('combobox', { name: '대체 결과 가져올 곳', exact: true }).selectOption('literal');
  await page.getByRole('textbox', { name: '대체 결과 직접 입력', exact: true }).fill('확인 후 다시 요청해 주세요');
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '내 프로젝트로 돌아가기' }).click();
  await page.getByRole('link').filter({ has: page.getByRole('heading', { name: '설정 복원 확인' }) }).click();
  await selectBlock(page, '문의 분류');
  await expect(page.getByRole('textbox', { name: '분류 1 이름', exact: true })).toHaveValue('support');
  await selectBlock(page, '허용 문구 검사');
  await expect(page.getByRole('textbox', { name: '허용 값 1', exact: true })).toHaveValue('안내');
  await selectBlock(page, '업무 복구', '입력·결과');
  await expect(page.getByRole('textbox', { name: '대체 결과 직접 입력', exact: true })).toHaveValue('확인 후 다시 요청해 주세요');
  expect(crashes).toEqual([]);
});

test('export route rejects unsupported model-evaluation modes even when called without the editor', async ({ request, baseURL }) => {
  const workflow = createBasicWorkflow(); const evaluation = createNode('evaluate');
  if (evaluation.type !== 'evaluate') throw new Error('wrong node');
  evaluation.id = 'work'; evaluation.inputBindings = { value: { from: 'node', nodeId: 'start', pointer: '/data/text', onMissing: 'error' } };
  evaluation.config = { mode: 'model', modelProfile: 'text-default', instructions: '입력 평가', resultSchema: true, passRule: { literal: true } };
  workflow.nodes[1] = evaluation;
  const response = await request.post('/api/exports', { headers: { Origin: new URL(baseURL!).origin }, data: { host: 'codex', workflow, editor: {} } });
  expect(response.status()).toBe(422);
  expect((await response.json()).error.code).toBe('CAPABILITY_NOT_READY');
});

test('malformed nested transform JSON remains repairable and cannot crash the editor', async ({ page }) => {
  const crashes: string[] = []; page.on('pageerror', (error) => crashes.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await addBlock(page, 'transform', '목록 변환');
  await page.locator('summary').filter({ hasText: '블록 설정 고급 JSON' }).click();
  await page.getByRole('textbox', { name: '블록 설정 고급 JSON', exact: true }).fill('{"steps":[{"op":"map","options":{"steps":[null]}}],"resultSchema":true}');
  await page.getByRole('button', { name: 'JSON 적용', exact: true }).click();
  await expect(page.getByText('목록 안의 변환 설정을 확인해야 합니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '목록 변환 설정 다시 만들기', exact: true }).click();
  await expect(page.getByText('목록 안의 변환 설정을 확인해야 합니다.', { exact: true })).toHaveCount(0);
  expect(crashes).toEqual([]);
});
