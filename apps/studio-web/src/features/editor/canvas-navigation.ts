/** Presentation-only geometry: these values never change execution edges, node IDs or workflow inputs. */
export type Point = { x: number; y: number };
export type CanvasSize = { width: number; height: number };
export type CanvasRect = Point & CanvasSize;
export type CanvasViewport = Point & { zoom: number };
export type StoredViewport = { center: Point; zoom: number };
export const CARD_SIZE = { width: 223, height: 180 };
export const MIN_ZOOM = .3;
export const MAX_ZOOM = 1.5;

export function validPoint(value: unknown): value is Point {
  return !!value && typeof value === 'object' && 'x' in value && 'y' in value && typeof value.x === 'number' && typeof value.y === 'number' && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) <= 1e6 && Math.abs(value.y) <= 1e6;
}
export function normalizeViewport(value: unknown): StoredViewport | undefined {
  if (!value || typeof value !== 'object' || !('center' in value) || !validPoint(value.center) || !('zoom' in value) || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom < MIN_ZOOM || value.zoom > MAX_ZOOM) return;
  return { center: { x: value.center.x, y: value.center.y }, zoom: value.zoom };
}

/** World centers survive a different monitor/window size; native screen translations do not. */
export function storeViewport(view: CanvasViewport, size: CanvasSize): StoredViewport {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return { center: { x: round((size.width / 2 - view.x) / view.zoom), y: round((size.height / 2 - view.y) / view.zoom) }, zoom: Math.round(view.zoom * 1e6) / 1e6 };
}
export function restoreViewport(view: StoredViewport, size: CanvasSize): CanvasViewport {
  return { x: size.width / 2 - view.center.x * view.zoom, y: size.height / 2 - view.center.y * view.zoom, zoom: view.zoom };
}

/** Reserve caption/toolbar and bottom guidance space rather than fitting cards behind controls. */
export function safeCanvas(size: CanvasSize): CanvasRect {
  return { x: 24, y: 106, width: Math.max(80, size.width - 48), height: Math.max(80, size.height - 180) };
}
function bounds(rects: CanvasRect[]): CanvasRect {
  const x = Math.min(...rects.map(rect => rect.x)); const y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}
function centered(rect: CanvasRect, size: CanvasSize, zoom: number): CanvasViewport {
  const safe = safeCanvas(size);
  return { x: safe.x + safe.width / 2 - (rect.x + rect.width / 2) * zoom, y: rect.height * zoom > safe.height ? safe.y - rect.y * zoom : safe.y + safe.height / 2 - (rect.y + rect.height / 2) * zoom, zoom };
}
export function revealViewport(rect: CanvasRect, size: CanvasSize, currentZoom: number): CanvasViewport {
  return centered(rect, size, Math.min(MAX_ZOOM, Math.max(1, currentZoom)));
}
export function overviewViewport(rects: CanvasRect[], size: CanvasSize): CanvasViewport {
  if (!rects.length) return { x: 24, y: 106, zoom: 1 };
  const box = bounds(rects); const safe = safeCanvas(size);
  return centered(box, size, Math.min(1, Math.max(MIN_ZOOM, Math.min(safe.width / Math.max(1, box.width + 32), safe.height / Math.max(1, box.height + 32)))));
}
/** Initial opening may fit a small graph; a large graph opens at a readable entry instead of tiny labels. */
export function initialViewport(rects: CanvasRect[], preferred: CanvasRect, size: CanvasSize): CanvasViewport {
  const overview = overviewViewport(rects, size);
  return overview.zoom >= .85 ? overview : revealViewport(preferred, size, 1);
}

function overlaps(a: CanvasRect, b: CanvasRect, gap = 24): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
/** No valid existing position moves. Missing/new positions fill a deterministic two-column grid. */
export function freeGridPosition(positions: Point[]): Point {
  for (let i = 0; i <= positions.length * 12 + 12; i++) {
    const candidate = { x: 70 + i % 2 * 320, y: 170 + Math.floor(i / 2) * 260 };
    if (positions.every(point => !overlaps({ ...candidate, ...CARD_SIZE }, { ...point, width: 256, height: 220 }))) return candidate;
  }
  return { x: 70, y: Math.max(170, ...positions.map(point => point.y)) + 300 };
}

/** Search visible cells first, then a bounded neighborhood. The caller reveals an off-screen fallback explicitly. */
export function placeInViewport(rects: CanvasRect[], view: CanvasViewport, size: CanvasSize): Point {
  const safe = safeCanvas(size); const box = { x: (safe.x - view.x) / view.zoom, y: (safe.y - view.y) / view.zoom, width: safe.width / view.zoom, height: safe.height / view.zoom };
  const center = { x: box.x + box.width / 2 - CARD_SIZE.width / 2, y: box.y + box.height / 2 - CARD_SIZE.height / 2 };
  const candidates: Point[] = [];
  for (let row = -8; row <= 8; row++) for (let column = -8; column <= 8; column++) candidates.push({ x: center.x + column * 270, y: center.y + row * 230 });
  const inside = (point: Point) => point.x >= box.x && point.y >= box.y && point.x + CARD_SIZE.width <= box.x + box.width && point.y + CARD_SIZE.height <= box.y + box.height;
  candidates.sort((a, b) => Number(inside(b)) - Number(inside(a)) || Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
  return candidates.find(point => validPoint(point) && rects.every(rect => !overlaps({ ...point, ...CARD_SIZE }, rect))) ?? freeGridPosition(rects);
}
