import { describe, expect, it } from 'vitest';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { normalizeLayout, newLocalDraft, validateImportedLayout } from '../../apps/studio-web/src/features/editor/local-drafts';
import { addNamedLocalFlow, editFlowDraft, renameLocalFlow, retainViewports, withFlowViewport } from '../../apps/studio-web/src/features/editor/flow-helpers';
import { initialViewport, normalizeViewport, overviewViewport, placeInViewport, restoreViewport, revealViewport, safeCanvas, storeViewport, type CanvasRect } from '../../apps/studio-web/src/features/editor/canvas-navigation';

const camera = { center: { x: 400, y: 250 }, zoom: 1.15 };
const size = { width: 800, height: 700 };

/** Local repair and external import deliberately have different data-loss contracts. */
describe('bounded canvas metadata', () => {
  it('preserves every existing arbitrary position and fills only missing positions', () => {
    const workflow = createBasicWorkflow(); const saved = { [workflow.nodes[0].id]: { x: -800, y: 900 }, [workflow.nodes[2]!.id]: { x: 70, y: 170 } };
    const result = normalizeLayout({ schemaVersion: '1.0.0', positions: saved, viewport: camera }, workflow);
    for (const [id, value] of Object.entries(saved)) expect(result.positions[id]).toEqual(value);
    expect(result.positions[workflow.nodes[1]!.id]).not.toEqual(saved[workflow.nodes[2]!.id]); expect(result.viewport).toEqual(camera);
  });
  it('uses two columns only for absent positions, without changing graph execution fields', () => {
    const workflow = createBasicWorkflow(); const before = structuredClone(workflow); const layout = normalizeLayout({}, workflow);
    expect(layout.positions[workflow.nodes[0].id]).toEqual({ x: 70, y: 170 });
    expect(layout.positions[workflow.nodes[1]!.id]).toEqual({ x: 390, y: 170 });
    expect(layout.positions[workflow.nodes[2]!.id]).toEqual({ x: 70, y: 430 }); expect(workflow).toEqual(before);
  });
  it('accepts missing layout metadata and legacy positions without requiring viewport migration', () => {
    const workflow = createBasicWorkflow(); expect(validateImportedLayout({}, workflow).viewport).toBeUndefined();
    const layout = normalizeLayout({}, workflow); expect(validateImportedLayout(layout, workflow)).toEqual(layout);
  });
  it.each([
    { schemaVersion: '2.0.0' }, { customLayout: true }, { positions: { unknown: { x: 0, y: 0 } } }, { subflows: { missing: { positions: {} } } },
    { viewport: { x: 0, y: 0, zoom: 1 } }, { viewport: { ...camera, zoom: .2 } }, { viewport: { ...camera, center: { x: Infinity, y: 0 } } },
    { viewport: { ...camera, secret: 'do not silently discard' } }, { positions: [] },
  ])('rejects an external layout that cannot be preserved: %j', value => {
    expect(() => validateImportedLayout(value, createBasicWorkflow())).toThrow(/보존/);
  });
  it('rejects invalid child names/coordinates and repairs only local view data', () => {
    const created = addNamedLocalFlow(newLocalDraft(), '문서 정리');
    for (const child of [{ name: '' }, { name: 'bad\u0000name' }, { positions: { input: { x: 1e7, y: 0 } } }, { positions: { input: { x: 1, y: 2, z: 3 } } }]) expect(() => validateImportedLayout({ subflows: { [created.flowId]: child } }, created.draft.workflow)).toThrow(/보존/);
    expect(normalizeViewport({ ...camera, zoom: Infinity })).toBeUndefined();
    expect(normalizeLayout({ viewport: { ...camera, zoom: Infinity } }, created.draft.workflow).viewport).toBeUndefined();
    const legacyName = ' 기존 이름 '; expect(validateImportedLayout({ subflows: { [created.flowId]: { name: legacyName } } }, created.draft.workflow).subflows![created.flowId]!.name).toBe(legacyName);
  });
  it('isolates duplicate node IDs and retains child camera/name through edits, renaming and document undo', () => {
    const created = addNamedLocalFlow(newLocalDraft(), '문서 정리'); let draft = withFlowViewport(created.draft, 'main', camera);
    const childCamera = { center: { x: -500, y: 800 }, zoom: .8 }; draft = withFlowViewport(draft, created.flowId, childCamera);
    const changed = renameLocalFlow(editFlowDraft(draft, created.flowId, view => ({ ...view, editor: { ...view.editor, positions: { ...view.editor.positions, input: { x: 200, y: 300 } } } })), created.flowId, '근거 확인');
    expect(changed.editor.subflows![created.flowId]!.viewport).toEqual(childCamera); expect(changed.editor.viewport).toEqual(camera);
    const undo = retainViewports(created.draft, changed); expect(undo.editor.viewport).toEqual(camera); expect(undo.editor.subflows![created.flowId]!.viewport).toEqual(childCamera);
    expect(undo.editor.subflows![created.flowId]!.positions).toEqual(created.draft.editor.subflows![created.flowId]!.positions);
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves centered view data and Korean child names in the actual %s ZIP', async host => {
    const created = addNamedLocalFlow(newLocalDraft(), '자료 검토'); const draft = withFlowViewport(withFlowViewport(created.draft, 'main', camera), created.flowId, { center: { x: 50, y: 75 }, zoom: .9 });
    const bytes = await buildPackage({ workflow: draft.workflow, editor: draft.editor, host }); const archive = await inspectPackage(bytes.bytes);
    const layout = JSON.parse(new TextDecoder().decode(archive.files.get('editor.json'))); expect(validateImportedLayout(layout, draft.workflow)).toEqual(draft.editor); expect(archive.workflow).toEqual(draft.workflow);
  });
});

describe('readable camera geometry', () => {
  const cards: CanvasRect[] = Array.from({ length: 15 }, (_, i) => ({ x: i * 320, y: 170, width: 223, height: 160 }));
  it('does not squeeze a long graph on initial opening but allows explicit overview and readable selection', () => {
    expect(initialViewport(cards, cards[0]!, size).zoom).toBe(1); expect(overviewViewport(cards, size).zoom).toBe(.3);
    expect(revealViewport(cards[14]!, size, .3).zoom).toBe(1); expect(revealViewport(cards[14]!, size, 1.3).zoom).toBe(1.3);
  });
  it('restores the same world center after a window size change', () => {
    expect(storeViewport(restoreViewport(camera, size), size)).toEqual(camera);
    const smaller = { width: 500, height: 500 }; expect(storeViewport(restoreViewport(camera, smaller), smaller)).toEqual(camera);
  });
  it('uses a visible unoccupied cell near the current view and never moves occupied cards', () => {
    const view = restoreViewport({ center: { x: 3000, y: -2000 }, zoom: 1 }, size); const point = placeInViewport([], view, size); const safe = safeCanvas(size);
    expect(point.x + view.x).toBeGreaterThanOrEqual(safe.x); expect(point.y + view.y).toBeGreaterThanOrEqual(safe.y);
    const occupied = [{ ...point, width: 223, height: 180 }]; const before = structuredClone(occupied); const next = placeInViewport(occupied, view, size);
    expect(next).not.toEqual(point); expect(occupied).toEqual(before);
  });
});
