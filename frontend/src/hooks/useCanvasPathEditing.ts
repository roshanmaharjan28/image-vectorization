import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { Layer } from '../types';
import { clientToWorld, worldToPage, type ViewTransform } from '../lib/canvasViewTransform';
import { applyTransform, invertMatrix, multiply, parseTransform, type Mat2x3 } from '../lib/svgTransform';
import { applyAnchorEdit, getAnchors, parsePath, serializePath, type AnchorInfo, type ParsedPath } from '../lib/pathEdit';
import type { Point } from '../lib/pathFlatten';

interface Options {
  view: ViewTransform | null;
  layers: Layer[];
  onTransformLayers: (next: Layer[]) => void;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pickLayerIndexAt: (clientX: number, clientY: number) => number;
  // Bumps CanvasGL's geometryVersion counter (fed into useCanvasGLScene) on every drag frame — a
  // callback rather than state owned by this hook so CanvasGL can pass geometryVersion into
  // useCanvasGLScene without a circular hook dependency (useCanvasGLScene hands back the
  // canvasRef/pickLayerIndexAt this hook itself needs).
  onPathEdited: () => void;
}

export interface PathAnchorRender {
  anchor: AnchorInfo;
  page: Point;
}

interface DragState {
  layerId: string;
  anchor: AnchorInfo;
  // Snapshot taken at mousedown; every frame recomputes the edit from this, not from the previous
  // frame's output, so it can't drift — same principle as useCanvasInteractions' gizmo drags.
  originalParsed: ParsedPath;
  fromWorld: Mat2x3;
  startMouseWorld: Point;
  startAnchorWorld: Point;
  startControlWorlds: Point[];
}

/**
 * Owns Illustrator-style "direct selection" path editing for CanvasGL: double-clicking a layer
 * enters node-edit mode for just that shape, rendering its path's anchor points (see pathEdit.ts)
 * as draggable circles instead of the usual move/scale/rotate gizmo. Dragging an anchor translates
 * it plus its attached bezier control points and writes a new `attrs.d` back through
 * `onTransformLayers` — the same full-array-replace shape the gizmo drags already use, so it flows
 * through the same per-layer diff effects in useCanvasGLScene.
 *
 * Editing a path changes its actual geometry, unlike a move/scale/rotate (which only ever touches
 * the GPU-resident `layer.transform` texture) — so every drag frame also calls `onPathEdited`,
 * which CanvasGL wires to bump a `geometryVersion` counter fed into useCanvasGLScene's
 * sceneGeometry memo deps to force a re-triangulation (that memo is otherwise keyed on `meta`
 * alone). Same cadence as the gizmo's rAF-throttled redraws, for live feedback while dragging.
 */
export function useCanvasPathEditing({ view, layers, onTransformLayers, canvasRef, pickLayerIndexAt, onPathEdited }: Options) {
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafPending = useRef(false);

  const editingLayer = editingLayerId ? (layers.find((l) => l.id === editingLayerId && !l.deleted) ?? null) : null;

  // Defensive cleanup if the layer being edited gets deleted/removed out from under us.
  useEffect(() => {
    if (editingLayerId && !editingLayer) setEditingLayerId(null);
  }, [editingLayerId, editingLayer]);

  useEffect(() => {
    if (!editingLayerId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setEditingLayerId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingLayerId]);

  const parsedPath = useMemo(() => (editingLayer ? parsePath(editingLayer.attrs.d ?? '') : null), [editingLayer]);
  const anchors = useMemo(() => (parsedPath ? getAnchors(parsedPath) : []), [parsedPath]);

  // path-local -> world: attrs.transform (vtracer's baked-in translate) applies first, then the
  // layer's own editable transform on top — the same composition buildLayerGeometry (triangulation)
  // and the GPU vertex shader (canvasGLEngine.ts) already use for this layer's fill.
  const toWorld: Mat2x3 | null = useMemo(() => {
    if (!editingLayer) return null;
    return multiply(editingLayer.transform, parseTransform(editingLayer.attrs.transform));
  }, [editingLayer]);

  const pathAnchors: PathAnchorRender[] | null = useMemo(() => {
    if (!view || !toWorld) return null;
    return anchors.map((anchor) => {
      const [wx, wy] = applyTransform(toWorld, anchor.point[0], anchor.point[1]);
      return { anchor, page: worldToPage(view, wx, wy) };
    });
  }, [anchors, toWorld, view]);

  function enterPathEdit(layerId: string) {
    setEditingLayerId(layerId);
  }

  function exitPathEdit() {
    setEditingLayerId(null);
    dragRef.current = null;
  }

  function handleCanvasDoubleClick(e: ReactMouseEvent<HTMLCanvasElement>) {
    const idx = pickLayerIndexAt(e.clientX, e.clientY);
    const id = idx >= 0 ? (layers[idx]?.id ?? null) : null;
    if (id) enterPathEdit(id);
    else if (editingLayerId) exitPathEdit();
  }

  function handleAnchorMouseDown(e: ReactMouseEvent<SVGCircleElement>, anchor: AnchorInfo) {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || !view || !editingLayer || !parsedPath || !toWorld) return;
    const fromWorld = invertMatrix(toWorld);
    const startAnchorWorld = applyTransform(toWorld, anchor.point[0], anchor.point[1]);
    const startControlWorlds = anchor.controlPoints.map(([x, y]) => applyTransform(toWorld, x, y));
    const startMouseWorld = clientToWorld(canvas, view, e.clientX, e.clientY);
    dragRef.current = {
      layerId: editingLayer.id,
      anchor,
      originalParsed: parsedPath,
      fromWorld,
      startMouseWorld,
      startAnchorWorld,
      startControlWorlds,
    };
  }

  function applyAnchorDrag(clientX: number, clientY: number) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas || !view) return;
    const [mx, my] = clientToWorld(canvas, view, clientX, clientY);
    const dx = mx - drag.startMouseWorld[0];
    const dy = my - drag.startMouseWorld[1];

    const newAnchorLocal = applyTransform(drag.fromWorld, drag.startAnchorWorld[0] + dx, drag.startAnchorWorld[1] + dy);
    const newControlLocals = drag.startControlWorlds.map(([wx, wy]) => applyTransform(drag.fromWorld, wx + dx, wy + dy));

    const edited = applyAnchorEdit(drag.originalParsed, drag.anchor, newAnchorLocal, newControlLocals);
    const newD = serializePath(edited);
    onTransformLayers(layers.map((l) => (l.id === drag.layerId ? { ...l, attrs: { ...l.attrs, d: newD } } : l)));
    onPathEdited();
  }

  function handleWrapperMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    if (!dragRef.current || rafPending.current) return;
    rafPending.current = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      rafPending.current = false;
      applyAnchorDrag(clientX, clientY);
    });
  }

  function handleWrapperMouseUp() {
    dragRef.current = null;
  }

  return {
    editingLayerId,
    pathAnchors,
    exitPathEdit,
    handleCanvasDoubleClick,
    handleAnchorMouseDown,
    pathEditingWrapperHandlers: {
      onMouseMove: handleWrapperMouseMove,
      onMouseUp: handleWrapperMouseUp,
    },
  };
}
