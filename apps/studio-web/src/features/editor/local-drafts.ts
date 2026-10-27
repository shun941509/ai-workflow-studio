import { createBasicWorkflow, validateWorkflowShape, type Workflow } from "@studio/spec";

export type EditorLayout = { schemaVersion: "1.0.0"; positions: Record<string, { x: number; y: number }> };
export type LocalDraft = { storageVersion: 1; workflow: Workflow; editor: EditorLayout; updatedAt: string; cloud?: { id: string; version: number } };
const PREFIX = "studio.draft.v1:";

/** Canvas positions are bounded presentation data and never become executable workflow fields. */
export function normalizeLayout(value: unknown, workflow: Workflow): EditorLayout {
  const source = value && typeof value === "object" && "positions" in value && value.positions && typeof value.positions === "object" ? value.positions as Record<string, unknown> : {};
  const positions: EditorLayout["positions"] = {};
  workflow.nodes.forEach((node, index) => {
    const position = source[node.id];
    positions[node.id] = position && typeof position === "object" && "x" in position && "y" in position && typeof position.x === "number" && typeof position.y === "number" && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) <= 1e6 && Math.abs(position.y) <= 1e6 ? { x: position.x, y: position.y } : { x: 70 + index * 300, y: 170 };
  });
  return { schemaVersion: "1.0.0", positions };
}

/** Click-added cards occupy a free grid cell instead of overlapping existing nodes; explicit drag positions stay untouched. */
export function nextNodePosition(positions: EditorLayout['positions']): { x: number; y: number } {
  const occupied = Object.values(positions);
  for (let index = 0; index <= occupied.length * 9 + 9; index++) {
    const candidate = { x: 70 + index % 3 * 320, y: 170 + Math.floor(index / 3) * 300 };
    if (!occupied.some((position) => Math.abs(position.x - candidate.x) < 280 && Math.abs(position.y - candidate.y) < 250)) return candidate;
  }
  return { x: 70, y: Math.max(170, ...occupied.map((position) => position.y)) + 300 };
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
    return { storageVersion: 1, workflow: parsed.value, editor: normalizeLayout(record.editor, parsed.value), updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "", cloud };
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
