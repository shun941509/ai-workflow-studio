'use client';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Workflow } from '@studio/spec';
import type { LocalDraft } from './local-drafts';
import { flowPositions, flowViewport, withFlowViewport } from './flow-helpers';
import { CARD_SIZE, initialViewport, MAX_ZOOM, MIN_ZOOM, normalizeViewport, overviewViewport, placeInViewport, restoreViewport, revealViewport, safeCanvas, storeViewport, type CanvasRect, type CanvasSize, type CanvasViewport } from './canvas-navigation';

type Options = { draft: LocalDraft; flowId: string; workflow: Workflow; selected?: string; loaded: boolean; initialized: boolean; measurements: Record<string, { width: number; height: number }>; setDraft: Dispatch<SetStateAction<LocalDraft>> };

/** Camera changes have their own lifecycle. Content edits and node counts never trigger an implicit whole-graph fit. */
export function useCanvasNavigation(options: Options) {
  const flow = useReactFlow(); const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 }); const [zoom, setZoom] = useState(1); const [requestVersion, setRequestVersion] = useState(0);
  const initializedScope = useRef(''); const pending = useRef<{ key: string; nodeId: string; force: boolean } | undefined>(undefined);
  const latest = useRef(options); latest.current = options;
  const key = `${options.draft.workflow.id}:${options.flowId}`; const keyRef = useRef(key); keyRef.current = key;
  const sizeRef = useRef(size); sizeRef.current = size;
  const getRects = useCallback((): Array<CanvasRect & { id: string }> => {
    const current = latest.current; const positions = flowPositions(current.draft.editor, current.flowId);
    return current.workflow.nodes.map(node => ({ id: node.id, ...(positions[node.id] ?? { x: 0, y: 0 }), ...(current.measurements[node.id] ?? CARD_SIZE) }));
  }, []);
  const save = useCallback((view: CanvasViewport) => {
    if (initializedScope.current !== keyRef.current || !sizeRef.current.width) return;
    const current = latest.current; const stored = normalizeViewport(storeViewport(view, sizeRef.current)); if (!stored) return;
    current.setDraft(draft => draft.workflow.id === current.draft.workflow.id ? withFlowViewport(draft, current.flowId, stored) : draft);
  }, []);
  const apply = useCallback((view: CanvasViewport) => { void flow.setViewport(view); setZoom(view.zoom); save(view); }, [flow, save]);

  useEffect(() => {
    if (!options.loaded || !options.initialized || !size.width || !size.height || options.workflow.nodes.some(node => !options.measurements[node.id])) return;
    const rects = getRects(); const request = pending.current?.key === key ? pending.current : undefined;
    const requested = request ? rects.find(rect => rect.id === request.nodeId) : undefined;
    if (initializedScope.current !== key) {
      initializedScope.current = key;
      const stored = flowViewport(options.draft.editor, options.flowId); const preferred = rects.find(rect => rect.id === options.selected) ?? rects.find(rect => rect.id === options.workflow.entryNodeId) ?? rects[0]!;
      apply(requested ? revealViewport(requested, size, 1) : stored ? restoreViewport(stored, size) : initialViewport(rects, preferred, size));
      if (requested) pending.current = undefined;
    } else if (requested) {
      const view = flow.getViewport(); const safe = safeCanvas(size);
      const visible = requested.x * view.zoom + view.x >= safe.x && requested.y * view.zoom + view.y >= safe.y && (requested.x + requested.width) * view.zoom + view.x <= safe.x + safe.width && (requested.y + requested.height) * view.zoom + view.y <= safe.y + safe.height;
      if (request?.force || !visible || view.zoom < 1) apply(revealViewport(requested, size, view.zoom));
      pending.current = undefined;
    }
  }, [options.loaded, options.initialized, options.measurements, options.workflow, options.draft.editor, options.flowId, options.selected, size, key, requestVersion, getRects, apply, flow]);

  useEffect(() => {
    const element = canvasRef.current; if (!element || !options.loaded) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }; const previous = sizeRef.current;
      if (next.width === previous.width && next.height === previous.height) return;
      const stored = previous.width && previous.height && initializedScope.current === keyRef.current ? storeViewport(flow.getViewport(), previous) : undefined;
      sizeRef.current = next; setSize(next);
      // Resizing retains the same world center; it never changes any card position or zoom level.
      if (stored && next.width && next.height) apply(restoreViewport(stored, next));
    };
    update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, [options.loaded, apply, flow]);

  const reveal = (flowId: string, nodeId: string, force = true) => { pending.current = { key: `${latest.current.draft.workflow.id}:${flowId}`, nodeId, force }; setRequestVersion(value => value + 1); };
  return {
    canvasRef, zoom, reveal,
    cancelReveal: () => { pending.current = undefined; },
    remember: () => save(flow.getViewport()),
    onMove: (_event: unknown, view: CanvasViewport) => { if (keyRef.current === key) setZoom(view.zoom); },
    onMoveEnd: (_event: unknown, view: CanvasViewport) => { if (keyRef.current === key) save(view); },
    overview: () => apply(overviewViewport(getRects(), sizeRef.current)),
    changeZoom: (delta: number) => { const stored = storeViewport(flow.getViewport(), sizeRef.current); apply(restoreViewport({ ...stored, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((stored.zoom + delta) * 100) / 100)) }, sizeRef.current)); },
    addPosition: () => { const current = flow.getViewport(); const stored = storeViewport(current, sizeRef.current); return placeInViewport(getRects(), restoreViewport({ ...stored, zoom: Math.max(1, current.zoom) }, sizeRef.current), sizeRef.current); },
  };
}
