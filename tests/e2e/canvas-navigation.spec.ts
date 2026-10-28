import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBasicWorkflow, type Workflow, type WorkflowEdge } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';

async function importFlow(page: Page, count: number) {
  const workflow = createBasicWorkflow(`${count}개 블록 가독성 확인`); const base = workflow.nodes[1]!;
  const middle = Array.from({ length: count - 2 }, (_, index) => ({ ...structuredClone(base), id: `work_${index}`, label: `자료 정리 ${index + 1}`, inputBindings: { content: { from: 'node' as const, nodeId: index ? `work_${index - 1}` : 'start', pointer: index ? '/data' : '/data/text', onMissing: 'error' as const } } }));
  workflow.nodes = [workflow.nodes[0], ...middle, { ...workflow.nodes[2]!, inputBindings: { result: { from: 'node', nodeId: middle.at(-1)!.id, pointer: '/data', onMissing: 'error' } } }] as Workflow['nodes'];
  workflow.edges = workflow.nodes.slice(0, -1).map((node, index): WorkflowEdge => ({ id: `edge_${index}`, from: { nodeId: node.id, port: 'next' }, to: { nodeId: workflow.nodes[index + 1]!.id, port: 'in' } }));
  await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON', exact: true }).fill(JSON.stringify(workflow)); await page.getByRole('button', { name: '내용 적용', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(count); return workflow;
}
async function view(page: Page) { return page.locator('.react-flow__viewport').evaluate(element => { const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; }); }
async function sameView(page: Page, expected: Awaited<ReturnType<typeof view>>) { await expect.poll(async () => { const actual = await view(page); return Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y), Math.abs(actual.zoom - expected.zoom)); }).toBeLessThan(.1); }
async function worldCenter(page: Page) { const native = await view(page); const box = await page.locator('.canvas-area').boundingBox(); return { x: (box!.width / 2 - native.x) / native.zoom, y: (box!.height / 2 - native.y) / native.zoom, zoom: native.zoom }; }
async function readable(page: Page, id: string) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`); const bounds = await node.boundingBox(); const canvas = await page.locator('.canvas-area').boundingBox(); expect(bounds).not.toBeNull(); expect(canvas).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(canvas!.x + 15); expect(bounds!.y).toBeGreaterThanOrEqual(canvas!.y + 100);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width - 15); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height - 55);
  const font = await node.locator('.workflow-node > strong').evaluate(element => parseFloat(getComputedStyle(element).fontSize)); expect(font * (await view(page)).zoom).toBeGreaterThanOrEqual(12.9);
}

/** Interact with visible controls and inspect rendered geometry; no localStorage or React state is injected. */
for (const width of [1280, 1440]) test(`keeps additions readable without forced fit at ${width}px`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.setViewportSize({ width, height: 1000 });
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await importFlow(page, 5);
  await expect(page.getByLabel('캔버스 배율', { exact: true })).toHaveText('100%'); await readable(page, 'start');
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('work_2'); await readable(page, 'work_2');
  await page.screenshot({ path: info.outputPath(`five-nodes-${width}.png`), fullPage: true });
  const positions = await page.locator('.react-flow__node').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute('data-id'), (element as HTMLElement).style.transform])));
  await page.getByRole('button', { name: '캔버스 확대', exact: true }).click(); await expect(page.getByLabel('캔버스 배율', { exact: true })).toHaveText('115%');
  await page.locator('.node-palette .node-ai').click(); await expect(page.locator('.workflow-node')).toHaveCount(6); const addedId = await page.getByRole('combobox', { name: '설정할 블록', exact: true }).inputValue();
  await expect(page.getByLabel('캔버스 배율', { exact: true })).toHaveText('115%'); await readable(page, addedId);
  for (const [id, position] of Object.entries(positions)) expect(await page.locator(`.react-flow__node[data-id="${id}"]`).evaluate(element => (element as HTMLElement).style.transform)).toBe(position);
  const addedView = await view(page); await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(5); await sameView(page, addedView);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(6); await sameView(page, addedView);
  await importFlow(page, 15); await page.getByRole('button', { name: '전체 보기', exact: true }).click(); expect((await view(page)).zoom).toBeLessThan(1);
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('work_12'); await readable(page, 'work_12');
  await page.getByRole('button', { name: '선택 블록 보기', exact: true }).focus(); await page.keyboard.press('Enter'); await readable(page, 'work_12');
  await page.getByRole('button', { name: '전체 보기', exact: true }).click();
  await page.locator('.react-flow__node[data-id="work_11"]').focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('combobox', { name: '설정할 블록', exact: true })).toHaveValue('work_11'); await readable(page, 'work_11');
  await page.getByRole('button', { name: '선택 블록 보기', exact: true }).click(); await readable(page, 'work_11');
  await page.screenshot({ path: info.outputPath(`fifteen-nodes-${width}.png`), fullPage: true }); expect(errors).toEqual([]);
});

test('restores independent flow cameras, preserves Korean names and exports three real host layouts', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('finish'); await page.getByRole('button', { name: '캔버스 확대', exact: true }).click(); const mainView = await view(page);
  await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click(); await page.getByRole('textbox', { name: '새 하위 흐름 이름', exact: true }).fill('근거를 검토하는 흐름'); await page.getByRole('button', { name: '하위 흐름 추가', exact: true }).click();
  const childId = await page.getByRole('combobox', { name: '편집할 흐름', exact: true }).inputValue(); await expect(page.locator('.workflow-node')).toHaveCount(2);
  await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption('output'); await page.getByRole('button', { name: '캔버스 확대', exact: true }).click(); await page.getByRole('button', { name: '캔버스 확대', exact: true }).click(); const childView = await view(page);
  await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click(); await page.getByRole('textbox', { name: '하위 흐름 이름', exact: true }).fill('근거 확인'); await page.getByRole('button', { name: '이름 변경', exact: true }).click(); await sameView(page, childView);
  await page.getByRole('combobox', { name: '편집할 흐름', exact: true }).selectOption('main'); await sameView(page, mainView);
  await page.getByRole('combobox', { name: '편집할 흐름', exact: true }).selectOption(childId); await sameView(page, childView);
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload(); await sameView(page, mainView);
  await page.getByRole('combobox', { name: '편집할 흐름', exact: true }).selectOption(childId); await sameView(page, childView); await expect(page.getByRole('combobox', { name: '편집할 흐름', exact: true }).locator('option:checked')).toHaveText('근거 확인');
  const center = await worldCenter(page); await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => { const current = await worldCenter(page); return Math.max(Math.abs(current.x - center.x), Math.abs(current.y - center.y), Math.abs(current.zoom - center.zoom)); }).toBeLessThan(.1);
  await page.setViewportSize({ width: 1440, height: 1000 }); await sameView(page, childView);
  const layouts: unknown[] = [];
  for (const [host, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode']] as const) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await dialog.getByText(label, { exact: true }).click();
    const event = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const archive = await inspectPackage(new Uint8Array(await readFile((await (await event).path())!)));
    expect(archive.manifest.targetHost).toBe(host); const layout = JSON.parse(new TextDecoder().decode(archive.files.get('editor.json'))); expect(layout.viewport.zoom).toBeCloseTo(mainView.zoom); expect(layout.subflows[childId].viewport.zoom).toBeCloseTo(childView.zoom); expect(layout.subflows[childId].name).toBe('근거 확인'); layouts.push(layout);
  }
  expect(layouts[0]).toEqual(layouts[1]); expect(layouts[1]).toEqual(layouts[2]); expect(errors).toEqual([]);
});

test('keeps deliberate drops and node dragging at the chosen camera and undoes only the position change', async ({ page }) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '캔버스 확대', exact: true }).click();
  const beforeDrop = await worldCenter(page); const canvas = page.locator('.canvas-area');
  await page.locator('.node-palette .node-ai').dragTo(canvas, { targetPosition: { x: 50, y: 130 } }); await expect(page.locator('.workflow-node')).toHaveCount(4);
  // The added-block notice changes canvas height; the persisted world center, not screen translation, must remain stable.
  // clientHeight rounds to whole CSS pixels; a fractional notice height may move the calculated center below half a pixel.
  await expect.poll(async () => { const actual = await worldCenter(page); return Math.max(Math.abs(actual.x - beforeDrop.x), Math.abs(actual.y - beforeDrop.y)); }).toBeLessThan(.5); expect((await view(page)).zoom).toBe(beforeDrop.zoom);
  const afterDrop = await view(page);
  const addedId = await page.getByRole('combobox', { name: '설정할 블록', exact: true }).inputValue(); const added = page.locator(`.react-flow__node[data-id="${addedId}"]`); const original = await added.evaluate(element => (element as HTMLElement).style.transform);
  const box = await added.boundingBox(); expect(box).not.toBeNull(); await page.mouse.move(box!.x + 90, box!.y + 40); await page.mouse.down(); await page.mouse.move(box!.x + 140, box!.y + 80, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => added.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(original); await sameView(page, afterDrop);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await expect(page.locator('.workflow-node')).toHaveCount(4); await expect.poll(() => added.evaluate(element => (element as HTMLElement).style.transform)).toBe(original); await sameView(page, afterDrop);
});
