import { useRef } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, RefObject, SetStateAction, WheelEvent as ReactWheelEvent } from 'react';
import type { Layer, Tool } from '../types';
import { ROTATE_CURSOR, clientToWorld, cornerResizeCursor, type GizmoState, type ViewTransform } from '../lib/canvasViewTransform';
import { rotateAroundPivot, scaleAroundPivot, type Mat2x3 } from '../lib/svgTransform';

// Client-space distance a pan drag must exceed before it counts as an actual pan rather than a
// click — below this, mouseup should still fall through to the normal select/deselect click.
const PAN_DRAG_THRESHOLD_PX = 4;

type DragMode = 'pan' | 'move' | 'scale' | 'rotate';

interface DragInfo {
  /** Snapshot of every dragged layer's transform at mousedown — every frame recomputes from this,
   *  not from the previous frame's output, so releasing without net movement is a true no-op and
   *  there's no per-frame drift. Doubles as the "which layers does this drag affect" set. */
  initialTransforms: Map<string, Mat2x3>;
  startWorld: [number, number];
  /** World-space pivot: the opposite corner for a scale drag, the box center for a rotate drag. */
  pivot: [number, number];
  startCorner?: [number, number]; // scale only
  startAngle?: number; // rotate only
}

interface Options {
  view: ViewTransform | null;
  // 'hand' disables every element interaction below (hover, select, move/scale/rotate) — only
  // the wrapper's drag-to-pan stays live, so a hand-tool drag always pans regardless of what's
  // under the pointer.
  tool: Tool;
  layers: Layer[];
  selectedLayerIds: string[];
  onSelectLayer: (ids: string[], mode: 'replace' | 'add' | 'toggle') => void;
  onHoverLayer: (id: string | null) => void;
  onTransformLayers: (next: Layer[]) => void;
  gizmo: GizmoState | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pickLayerIndexAt: (clientX: number, clientY: number) => number;
  // CSS pan/zoom state lives in the CanvasGL component (it also drives the artboard's `transform`
  // style and CanvasGL's GL resolution-scale effect) — this hook only reads/updates it.
  setScale: Dispatch<SetStateAction<number>>;
  offset: { x: number; y: number };
  setOffset: Dispatch<SetStateAction<{ x: number; y: number }>>;
}

/**
 * Owns every pointer interaction on CanvasGL's artboard: wheel-zoom, drag-to-pan, hover/click
 * layer picking, and the on-canvas move/scale/rotate gizmo. Pan and the gizmo drags share a
 * single drag-mode state machine (only one kind of drag can be in flight at once, and the pan
 * handlers on the wrapping div need to know when a gizmo drag elsewhere should take priority),
 * which is why they're bundled in one hook rather than split by feature.
 */
export function useCanvasInteractions({
  view,
  tool,
  layers,
  selectedLayerIds,
  onSelectLayer,
  onHoverLayer,
  onTransformLayers,
  gizmo,
  canvasRef,
  pickLayerIndexAt,
  setScale,
  offset,
  setOffset,
}: Options) {
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  // Raw client-space mousedown position for the current pan drag, used only to measure whether
  // the pointer actually moved (see PAN_DRAG_THRESHOLD_PX) — separate from dragOrigin, which is
  // pre-offset for directly computing the artboard's translate.
  const panStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const panMovedRef = useRef(false);
  // Lets the pinned drag cursor (resize/rotate) win over `.canvas`'s own stylesheet cursor rule,
  // which otherwise takes precedence over anything set on document.body for any pointer position
  // inside the canvas (see handleGizmoHandleMouseDown).
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rafPickPending = useRef(false);

  // Gizmo drag state (move/scale/rotate), plus the pan drag above. A ref, not state, since a
  // drag's every-frame updates flow through `layers`/onTransformLayers (which already re-renders
  // the canvas) rather than a separate imperative path.
  const dragModeRef = useRef<DragMode | null>(null);
  const dragInfoRef = useRef<DragInfo | null>(null);
  const rafDragPending = useRef(false);
  // A move-drag starts from a mousedown on the canvas itself, so the browser also fires a click
  // on mouseup — suppressed once so it doesn't collapse a just-dragged group selection down to
  // whichever single shape happened to be under the pointer.
  const suppressNextClickRef = useRef(false);

  function updateHoverAt(clientX: number, clientY: number) {
    const idx = pickLayerIndexAt(clientX, clientY);
    onHoverLayer(idx >= 0 ? layers[idx]?.id ?? null : null);
  }

  function schedulePickAt(clientX: number, clientY: number) {
    if (rafPickPending.current) return;
    rafPickPending.current = true;
    requestAnimationFrame(() => {
      rafPickPending.current = false;
      updateHoverAt(clientX, clientY);
    });
  }

  function handleWheel(e: ReactWheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setScale((s) => Math.min(8, Math.max(0.1, s + delta * s)));
    // Zoom is anchored to the artboard's center, not the cursor, so the artwork shifts beneath a
    // stationary pointer on every tick — re-pick at the same client position (deferred a frame so
    // the DOM has the updated CSS transform) so the hover highlight follows what's actually under
    // the cursor instead of whatever was there before this tick.
    schedulePickAt(e.clientX, e.clientY);
  }

  function handleWrapperMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    dragModeRef.current = 'pan';
    dragOrigin.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    panStartClientRef.current = { x: e.clientX, y: e.clientY };
    panMovedRef.current = false;
  }

  function applyDrag(mode: 'move' | 'scale' | 'rotate', clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const info = dragInfoRef.current;
    if (!canvas || !view || !info) return;
    const [wx, wy] = clientToWorld(canvas, view, clientX, clientY);

    let nextMatrix: (m: Mat2x3) => Mat2x3;
    if (mode === 'move') {
      const dx = wx - info.startWorld[0];
      const dy = wy - info.startWorld[1];
      nextMatrix = (m) => [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
    } else if (mode === 'scale' && info.startCorner) {
      const [px, py] = info.pivot;
      const dxs = info.startCorner[0] - px;
      const dys = info.startCorner[1] - py;
      // Floors the ratio's magnitude so dragging a corner through/past the pivot can't collapse a
      // layer to zero size or silently flip it — it just stays pinned near-flat instead.
      const ratio = (current: number, start: number) => {
        if (Math.abs(start) < 1e-6) return 1;
        const r = current / start;
        return Math.abs(r) < 0.02 ? (r < 0 ? -0.02 : 0.02) : r;
      };
      const sx = ratio(wx - px, dxs);
      const sy = ratio(wy - py, dys);
      nextMatrix = (m) => scaleAroundPivot(m, px, py, sx, sy);
    } else if (mode === 'rotate' && info.startAngle !== undefined) {
      const [px, py] = info.pivot;
      const dTheta = Math.atan2(wy - py, wx - px) - info.startAngle;
      nextMatrix = (m) => rotateAroundPivot(m, px, py, dTheta);
    } else {
      return;
    }

    const next = layers.map((layer) => {
      const initial = info.initialTransforms.get(layer.id);
      return initial ? { ...layer, transform: nextMatrix(initial) } : layer;
    });
    onTransformLayers(next);
  }

  function handleWrapperMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    const mode = dragModeRef.current;
    if (mode === 'pan') {
      if (!dragOrigin.current) return;
      if (!panMovedRef.current && panStartClientRef.current) {
        const dx = e.clientX - panStartClientRef.current.x;
        const dy = e.clientY - panStartClientRef.current.y;
        if (Math.hypot(dx, dy) > PAN_DRAG_THRESHOLD_PX) panMovedRef.current = true;
      }
      setOffset({ x: e.clientX - dragOrigin.current.x, y: e.clientY - dragOrigin.current.y });
      return;
    }
    if (mode && dragInfoRef.current) {
      if (rafDragPending.current) return;
      rafDragPending.current = true;
      const { clientX, clientY } = e;
      requestAnimationFrame(() => {
        rafDragPending.current = false;
        applyDrag(mode, clientX, clientY);
      });
    }
  }

  function stopDrag() {
    const mode = dragModeRef.current;
    if (mode === 'move' || mode === 'scale' || mode === 'rotate' || (mode === 'pan' && panMovedRef.current)) {
      suppressNextClickRef.current = true;
    }
    dragModeRef.current = null;
    dragOrigin.current = null;
    dragInfoRef.current = null;
    panStartClientRef.current = null;
    panMovedRef.current = false;
    if (wrapperRef.current) wrapperRef.current.style.cursor = '';
  }

  function snapshotInitialTransforms(): Map<string, Mat2x3> {
    const snapshot = new Map<string, Mat2x3>();
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    for (const id of selectedLayerIds) {
      const layer = byId.get(id);
      if (layer) snapshot.set(id, layer.transform);
    }
    return snapshot;
  }

  function handleGizmoHandleMouseDown(e: ReactMouseEvent<SVGCircleElement>, mode: 'scale' | 'rotate', cornerIndex?: number) {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    if (tool !== 'cursor' || !canvas || !view || !gizmo) return;
    const startWorld = clientToWorld(canvas, view, e.clientX, e.clientY);
    const initialTransforms = snapshotInitialTransforms();
    if (mode === 'scale' && cornerIndex !== undefined) {
      const oppositeIndex = (cornerIndex + 2) % 4;
      dragInfoRef.current = {
        initialTransforms,
        startWorld,
        pivot: gizmo.worldCorners[oppositeIndex],
        startCorner: gizmo.worldCorners[cornerIndex],
      };
      // Pin the resize cursor on the wrapper itself (not document.body) for the whole drag —
      // `.canvas` has its own stylesheet cursor rule, which wins over anything set on an
      // ancestor for any pointer position inside it, so the moment the pointer strays off the
      // (tiny) handle circle it would otherwise fall back to the canvas's grab/grabbing pan
      // cursor, even mid-drag.
      if (wrapperRef.current) wrapperRef.current.style.cursor = cornerResizeCursor(gizmo, cornerIndex);
    } else {
      const pivot = gizmo.center;
      dragInfoRef.current = {
        initialTransforms,
        startWorld,
        pivot,
        startAngle: Math.atan2(startWorld[1] - pivot[1], startWorld[0] - pivot[0]),
      };
      if (wrapperRef.current) wrapperRef.current.style.cursor = ROTATE_CURSOR;
    }
    dragModeRef.current = mode;
  }

  function handleCanvasMouseDown(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (tool !== 'cursor') return;
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const idx = pickLayerIndexAt(e.clientX, e.clientY);
    const id = idx >= 0 ? (layers[idx]?.id ?? null) : null;
    if (!id || !selectedLayerIds.includes(id)) return;

    e.stopPropagation();
    const startWorld = clientToWorld(canvas, view, e.clientX, e.clientY);
    dragInfoRef.current = {
      initialTransforms: snapshotInitialTransforms(),
      startWorld,
      pivot: startWorld,
    };
    dragModeRef.current = 'move';
  }

  function handleCanvasMouseMove(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (tool !== 'cursor') return;
    schedulePickAt(e.clientX, e.clientY);
  }

  function handleCanvasClick(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (tool !== 'cursor') return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    const idx = pickLayerIndexAt(e.clientX, e.clientY);
    const id = idx >= 0 ? (layers[idx]?.id ?? null) : null;
    if (!id) {
      onSelectLayer([], 'replace');
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      onSelectLayer([id], 'toggle');
    } else {
      onSelectLayer([id], 'replace');
    }
  }

  return {
    wrapperRef,
    wrapperHandlers: {
      onWheel: handleWheel,
      onMouseDown: handleWrapperMouseDown,
      onMouseMove: handleWrapperMouseMove,
      onMouseUp: stopDrag,
      onMouseLeave: stopDrag,
    },
    canvasHandlers: {
      onMouseDown: handleCanvasMouseDown,
      onMouseMove: handleCanvasMouseMove,
      onMouseLeave: () => onHoverLayer(null),
      onClick: handleCanvasClick,
    },
    handleGizmoHandleMouseDown,
    // Exposed so the pen tool's click-to-path-edit handler can also skip the click that follows a
    // real pan drag — stopDrag() already flips this on mouseup, handleCanvasClick just happens to
    // be the only consumer today.
    suppressNextClickRef,
  };
}
