import { createBasicWorkflow, validateWorkflowShape, type Workflow } from "@studio/spec";
import { freeGridPosition, normalizeViewport, validPoint, type StoredViewport } from './canvas-navigation';
import { validateResourceState, type ResourceState } from './resource-state';
import type { PrivateResourceDetail } from '../resources/types';

type Positions = Record<string, { x: number; y: number }>;
export type EditorLayout = { schemaVersion: "1.0.0"; positions: Positions; viewport?: StoredViewport; subflows?: Record<string, { positions: Positions; name?: string; viewport?: StoredViewport }> };
export type LocalDraft = ResourceState & { storageVersion: 1; workflow: Workflow; editor: EditorLayout; updatedAt: string; cloud?: { id: string; version: number }; origin?: PrivateResourceDetail['origin'] };
const PREFIX = "studio.draft.v1:";

/** Canvas positions are bounded presentation data and never become executable workflow fields. */
export function normalizeLayout(value: unknown, workflow: Workflow): EditorLayout {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const subflows = record.subflows && typeof record.subflows === 'object' ? record.subflows as Record<string, unknown> : {};
  const viewport = normalizeViewport(record.viewport);
  return { schemaVersion: '1.0.0', positions: normalizePositions(value, workflow.nodes), ...(viewport ? { viewport } : {}), subflows: Object.fromEntries(Object.entries(workflow.subworkflows).filter(([, flow]) => Boolean(flow)).map(([id, flow]) => {
    const stored = subflows[id]; const name = stored && typeof stored === 'object' && 'name' in stored ? stored.name : undefined;
    const view = normalizeViewport(stored && typeof stored === 'object' && 'viewport' in stored ? stored.viewport : undefined);
    return [id, { positions: normalizePositions(stored, flow!.nodes), ...(view ? { viewport: view } : {}), ...(typeof name === 'string' && name.trim() && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? { name } : {}) }];
  })) };
}

/** Each scope normalizes against its own node IDs; obsolete scopes and unbounded coordinates cannot leak across layouts. */
function normalizePositions(value: unknown, nodes: Workflow['nodes']): Positions {
  const source = value && typeof value === "object" && "positions" in value && value.positions && typeof value.positions === "object" ? value.positions as Record<string, unknown> : {};
  const positions: EditorLayout["positions"] = {};
  // Collect every valid saved position first; repairing a missing earlier node must not overlap a later saved one.
  nodes.forEach((node) => {
    const position = source[node.id];
    if (validPoint(position)) positions[node.id] = { x: position.x, y: position.y };
  });
  nodes.forEach(node => { if (!Object.hasOwn(positions, node.id)) positions[node.id] = freeGridPosition(Object.values(positions)); });
  return positions;
}

/** Click-added cards occupy a free grid cell instead of overlapping existing nodes; explicit drag positions stay untouched. */
export function nextNodePosition(positions: EditorLayout['positions']): { x: number; y: number } {
  return freeGridPosition(Object.values(positions));
}

/** Imports reject unrecognized metadata before repair can discard it; the source remains available to the caller. */
export function validateImportedLayout(value: unknown, workflow: Workflow): EditorLayout {
  const fail = () => { throw new Error('가져온 편집기 배치를 보존할 수 없습니다. 지원하지 않거나 잘못된 화면 정보가 있습니다. 원본 파일을 보관해 주세요.'); };
  const record = (candidate: unknown): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) return fail();
    return candidate as Record<string, unknown>;
  };
  const keys = (candidate: Record<string, unknown>, allowed: string[]) => { if (Object.keys(candidate).some(key => !allowed.includes(key))) fail(); };
  const scope = (candidate: unknown, nodeIds: string[], child: boolean) => {
    const item = record(candidate); keys(item, child ? ['positions', 'name', 'viewport'] : ['schemaVersion', 'positions', 'subflows', 'viewport']);
    if (Object.hasOwn(item, 'positions')) for (const [id, raw] of Object.entries(record(item.positions))) { const point = record(raw); keys(point, ['x', 'y']); if (!nodeIds.includes(id) || !validPoint(point)) fail(); }
    if (Object.hasOwn(item, 'viewport')) { const view = record(item.viewport); keys(view, ['center', 'zoom']); keys(record(view.center), ['x', 'y']); if (!normalizeViewport(view)) fail(); }
    if (child && Object.hasOwn(item, 'name') && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || /[\u0000-\u001f\u007f]/.test(item.name))) fail();
    return item;
  };
  const root = scope(value, workflow.nodes.map(node => node.id), false);
  if (Object.hasOwn(root, 'schemaVersion') && root.schemaVersion !== '1.0.0') fail();
  if (Object.hasOwn(root, 'subflows')) for (const [id, child] of Object.entries(record(root.subflows))) { const flow = workflow.subworkflows[id]; if (!Object.hasOwn(workflow.subworkflows, id) || !flow) fail(); scope(child, flow!.nodes.map(node => node.id), true); }
  return normalizeLayout(value, workflow);
}

/** Every new local draft has its own id so separate projects cannot overwrite one template key. */
export function newLocalDraft(): LocalDraft {
  const workflow = createBasicWorkflow("나의 첫 워크플로");
  workflow.id = `wf_${crypto.randomUUID().replaceAll("-", "")}`;
  return { storageVersion: 1, workflow, editor: normalizeLayout({}, workflow), updatedAt: new Date().toISOString() };
}

/** Corrupt or obsolete browser records are ignored rather than trusted as valid workflow definitions. */
export function readLocalDraft(id: string): LocalDraft | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + id); if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("storageVersion" in value) || value.storageVersion !== 1 || !("workflow" in value)) return;
    const parsed = validateWorkflowShape(value.workflow); if (!parsed.valid) return;
    const record = value as Record<string, unknown>;
    const cloud = record.cloud && typeof record.cloud === "object" && "id" in record.cloud && typeof record.cloud.id === "string" && "version" in record.cloud && Number.isInteger(record.cloud.version) ? { id: record.cloud.id, version: Number(record.cloud.version) } : undefined;
    const materials = validateResourceState(parsed.value, record.resourceBindings, record.resourceDependencies);
    const origin = record.origin && typeof record.origin === 'object' && 'source' in record.origin && record.origin.source && typeof record.origin.source === 'object' && !Array.isArray(record.origin.source) && 'copied_at' in record.origin && typeof record.origin.copied_at === 'string' ? record.origin as NonNullable<LocalDraft['origin']> : undefined;
    return { storageVersion: 1, workflow: parsed.value, editor: normalizeLayout(record.editor, parsed.value), updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "", cloud, ...materials, ...(origin ? { origin } : {}) };
  } catch { return; }
}

/** Local persistence is explicitly labeled browser-only; storage quota failures must remain visible. */
export function writeLocalDraft(draft: LocalDraft) { localStorage.setItem(PREFIX + draft.workflow.id, JSON.stringify(draft)); }
export function removeLocalDraft(id: string) { localStorage.removeItem(PREFIX + id); }
export function listLocalDrafts(): LocalDraft[] {
  const records: LocalDraft[] = [];
  for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(PREFIX)) { const draft = readLocalDraft(key.slice(PREFIX.length)); if (draft) records.push(draft); } }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
