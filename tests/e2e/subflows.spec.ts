import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBasicWorkflow, createNode } from '@studio/spec';
import { inspectPackage } from '@studio/package-kit';
import { addLocalFlow } from '../../apps/studio-web/src/features/editor/flow-helpers';

async function select(page: Page, id: string, tab = '기본') { await page.getByRole('combobox', { name: '설정할 블록', exact: true }).selectOption(id); await page.getByRole('tab', { name: tab, exact: true }).click(); }
async function settings(page: Page) { await page.getByRole('button', { name: '흐름 설정·추가', exact: true }).click(); }
async function addFlow(page: Page, name: string) { await settings(page); await page.getByRole('textbox', { name: '새 하위 흐름 이름', exact: true }).fill(name); await page.getByRole('button', { name: '하위 흐름 추가', exact: true }).click(); await expect(page.getByRole('combobox', { name: '편집할 흐름' })).toHaveValue(name); }
async function connect(page: Page, id: string, target: string) { await select(page, id); await page.getByRole('combobox', { name: '다음 작업 연결', exact: true }).selectOption(target); }

/** Korean display names survive persistence and ZIP export without renaming any executable FlowRef. */
test('names and renames a child in Korean without exposing internal identifiers as form requirements', async ({ page }) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await settings(page);
  await page.getByRole('textbox', { name: '새 하위 흐름 이름', exact: true }).fill('문서 정리');
  await page.getByRole('button', { name: '하위 흐름 추가', exact: true }).click();
  const childId = await page.getByRole('combobox', { name: '편집할 흐름' }).inputValue(); expect(childId).toMatch(/^flow_[a-f0-9]{32}$/);
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('main');
  await page.locator('.node-palette .node-subworkflow').click(); const callId = await page.getByRole('combobox', { name: '설정할 블록', exact: true }).inputValue();
  await expect(page.getByRole('combobox', { name: '호출할 하위 흐름' }).locator('option:checked')).toHaveText('문서 정리');
  await page.getByRole('tab', { name: '입력·결과', exact: true }).click(); await page.getByRole('button', { name: '하위 흐름에 전달할 값 연결', exact: true }).click();
  await connect(page, 'work', callId); await connect(page, callId, 'finish');
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption(childId); await settings(page);
  await page.getByRole('textbox', { name: '하위 흐름 이름', exact: true }).fill('결과 검토'); await page.getByRole('button', { name: '이름 변경', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '편집할 흐름' }).locator('option:checked')).toHaveText('결과 검토');
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload();
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('main'); await select(page, callId);
  await expect(page.getByRole('combobox', { name: '호출할 하위 흐름' }).locator('option:checked')).toHaveText('결과 검토');
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' });
  const event = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click();
  const archive = await inspectPackage(new Uint8Array(await readFile((await (await event).path())!)));
  expect(archive.workflow.nodes.find(node => node.id === callId)!.config).toEqual({ flowRef: { kind: 'local', flowId: childId } });
  expect(JSON.parse(new TextDecoder().decode(archive.files.get('editor.json'))).subflows[childId].name).toBe('결과 검토');
});

/** Actual Chrome interactions produce real ZIPs; data is only imported through the product's visible JSON form. */
test('authors typed child contracts and bindings, reopens the draft and preserves three host ZIPs', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await page.getByRole('button', { name: '선택한 블록 삭제', exact: true }).click();
  await addFlow(page, 'details');
  for (const label of ['하위 흐름 입력', '하위 흐름 결과']) {
    await page.getByRole('combobox', { name: `${label} 형식`, exact: true }).selectOption('object');
    await page.getByRole('textbox', { name: `${label} 새 항목 이름`, exact: true }).fill('text');
    await page.locator('fieldset.schema-form').filter({ has: page.locator('legend', { hasText: new RegExp(`^${label}$`) }) }).getByRole('button', { name: '항목 추가', exact: true }).click();
  }
  await select(page, 'input'); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill('하위 입력');
  // Drag an actual canvas node so the emitted editor.json demonstrates a child-specific layout.
  const card = page.locator('.react-flow__node[data-id="input"]'); const box = await card.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 70, box!.y + 55); await page.mouse.down(); await page.mouse.move(box!.x + 105, box!.y + 95, { steps: 8 }); await page.mouse.up();
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('main');
  await page.locator('.node-palette .node-subworkflow').click(); const callId = await page.getByRole('combobox', { name: '설정할 블록', exact: true }).inputValue();
  await expect(page.getByRole('combobox', { name: '호출할 하위 흐름' })).toHaveValue('details');
  await page.getByRole('tab', { name: '입력·결과', exact: true }).click(); await page.getByRole('button', { name: '하위 흐름에 전달할 값 연결', exact: true }).click();
  await page.getByRole('combobox', { name: '하위 흐름에 전달할 값 가져올 값', exact: true }).selectOption('');
  await connect(page, 'start', callId); await connect(page, callId, 'finish');
  await select(page, 'finish', '입력·결과'); await page.getByRole('combobox', { name: '최종 결과 결과 블록', exact: true }).selectOption(callId);
  await page.getByRole('combobox', { name: '최종 결과 가져올 값', exact: true }).selectOption('/data/text');
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('details'); await settings(page);
  await expect(page.getByRole('button', { name: '이 하위 흐름 삭제', exact: true })).toBeDisabled();
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible(); await page.reload();
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('details'); await select(page, 'input');
  await expect(page.getByRole('textbox', { name: '블록 이름', exact: true })).toHaveValue('하위 입력');
  await expect(page.getByRole('combobox', { name: '하위 흐름 입력 형식', exact: true })).toHaveValue('object');
  for (const [host, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode']]) {
    await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '내 도구에서 이어서 실행' }); await expect(dialog).toBeVisible(); await dialog.getByRole('radio', { name: new RegExp(label!) }).check();
    const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); const download = await downloaded;
    const archive = await inspectPackage(new Uint8Array(await readFile((await download.path())!))); expect(download.suggestedFilename()).toContain(host);
    expect(archive.workflow.subworkflows.details!.inputs).toMatchObject({ type: 'object', required: ['text'] });
    expect(archive.workflow.nodes.find(node => node.id === callId)!.inputBindings.input).toEqual({ from: 'workflowInput', pointer: '', onMissing: 'error' });
    expect(archive.workflow.nodes.find(node => node.id === 'finish')!.inputBindings.result).toMatchObject({ nodeId: callId, pointer: '/data/text' });
    const layout = JSON.parse(new TextDecoder().decode(archive.files.get('editor.json'))); expect(layout.subflows.details.positions.input).not.toEqual({ x: 70, y: 170 }); expect(layout.positions).toHaveProperty('start');
  }
  await page.screenshot({ path: info.outputPath('subflow-desktop.png'), fullPage: true }); expect(errors).toEqual([]);
});

test('isolates duplicate local ids and keeps add/delete/edit in one undo history', async ({ page }, info) => {
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3); await addFlow(page, 'first'); await addFlow(page, 'second');
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('first'); await select(page, 'input'); await page.getByRole('textbox', { name: '블록 이름', exact: true }).fill('첫 흐름 입력');
  await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('second'); await select(page, 'input'); await expect(page.getByRole('textbox', { name: '블록 이름', exact: true })).not.toHaveValue('첫 흐름 입력');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('first'); await select(page, 'input'); await expect(page.getByRole('textbox', { name: '블록 이름', exact: true })).not.toHaveValue('첫 흐름 입력');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click(); await expect(page.getByRole('textbox', { name: '블록 이름', exact: true })).toHaveValue('첫 흐름 입력');
  await settings(page); await page.getByRole('button', { name: '이 하위 흐름 삭제', exact: true }).click(); await expect(page.getByRole('combobox', { name: '편집할 흐름' })).toHaveValue('main');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click(); await page.getByRole('combobox', { name: '편집할 흐름' }).selectOption('first'); await select(page, 'input'); await expect(page.getByRole('textbox', { name: '블록 이름', exact: true })).toHaveValue('첫 흐름 입력');
  await page.setViewportSize({ width: 390, height: 844 }); await settings(page); await expect(page.getByRole('textbox', { name: '새 하위 흐름 이름', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('subflow-narrow.png'), fullPage: true });
});

test('imports child definitions but blocks hidden waits and navigates to their exact scope', async ({ page }) => {
  const workflow = addLocalFlow(createBasicWorkflow(), 'hidden'); const review = createNode('review'); review.id = 'work'; workflow.subworkflows.hidden!.nodes.push(review);
  await page.goto('/projects/new'); await expect(page.locator('.workflow-node')).toHaveCount(3);
  await page.getByRole('button', { name: '설계 JSON 보기·가져오기', exact: true }).click(); await page.getByRole('textbox', { name: '워크플로 JSON', exact: true }).fill(JSON.stringify(workflow)); await page.getByRole('button', { name: '내용 적용', exact: true }).click();
  await page.getByRole('button', { name: 'ZIP 다운로드', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.validation-panel').getByRole('button', { name: /하위 흐름에서는 사용자 응답/ }).click();
  await expect(page.getByRole('combobox', { name: '편집할 흐름' })).toHaveValue('hidden'); await expect(page.getByRole('combobox', { name: '설정할 블록', exact: true })).toHaveValue('work');
  await expect(page.getByRole('tabpanel').getByText('사용자 검토', { exact: true })).toBeVisible();
  // The server gate independently rejects a structurally valid hidden child wait even if the browser is bypassed.
  const hiddenWait = addLocalFlow(createBasicWorkflow(), 'waiting'); const question = createNode('form'); question.id = 'question'; question.config = { mode: 'request', title: '답변', schema: true };
  const child = hiddenWait.subworkflows.waiting!; child.nodes.splice(1, 0, question); child.edges = [{ id: 'one', from: { nodeId: 'input', port: 'next' }, to: { nodeId: 'question', port: 'in' } }, { id: 'two', from: { nodeId: 'question', port: 'next' }, to: { nodeId: 'output', port: 'in' } }];
  const response = await page.request.post('/api/exports', { headers: { Origin: new URL(page.url()).origin }, data: { workflow: hiddenWait, editor: {}, host: 'codex' } });
  expect(response.status()).toBe(422); expect((await response.json()).error.code).toBe('CAPABILITY_NOT_READY');
});
