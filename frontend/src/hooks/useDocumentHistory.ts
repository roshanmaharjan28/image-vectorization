import { useCallback, useMemo, useState } from 'react';
import type { SetStateAction } from 'react';
import type { Layer, TreeNode } from '../types';

/** Everything an undo step has to restore: the layer list and the group forest are the whole
 *  editable document, and the selection rides along so undoing a delete re-selects what came
 *  back (Illustrator/Figma behave the same way). */
export interface DocumentState {
  layers: Layer[];
  groupTree: TreeNode[] | null;
  selectedLayerIds: string[];
}

export const EMPTY_DOCUMENT: DocumentState = { layers: [], groupTree: null, selectedLayerIds: [] };

// Snapshots are structurally shared — a mutation replaces the `layers` array but keeps almost
// every Layer object, so one entry costs an array of pointers (a few tens of KB even for the
// ~9k-path documents v2's high-fidelity preset emits), not a deep copy of the document.
const MAX_HISTORY = 100;

interface HistoryState {
  past: DocumentState[];
  present: DocumentState;
  future: DocumentState[];
  /** The document as it stood when the current drag started, or null when no drag is in flight.
   *  Its presence is also what tells `mutate` to stop recording: a move/scale/rotate/path-edit
   *  drag streams a new document every animation frame, and only the pre-drag state is a step
   *  the user would want to come back to. */
  dragBase: DocumentState | null;
  /** Bumped whenever an undo/redo swapped in different path geometry, so the renderer knows it
   *  has to re-triangulate — CanvasGL keys its scene off the layer *set*, not `attrs.d` (see
   *  useCanvasGLScene's sceneGeometry memo), so restoring an edited `d` is otherwise invisible. */
  geometryEpoch: number;
}

function resolve<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === 'function' ? (action as (p: T) => T)(prev) : action;
}

/** Whether two documents differ in anything undoable. Selection is excluded on purpose: it's
 *  carried by a snapshot but never worth a step of its own. */
function documentChanged(a: DocumentState, b: DocumentState): boolean {
  return a.layers !== b.layers || a.groupTree !== b.groupTree;
}

/** True if any layer's path data differs — the one layer field the GL scene can't pick up from
 *  its cheap per-texel diff. Compares `attrs.d` rather than the `attrs` object, since a recolor
 *  replaces `attrs` (see setLayerFill) without touching geometry. */
function pathGeometryChanged(a: Layer[], b: Layer[]): boolean {
  if (a === b) return false;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i].attrs.d !== b[i].attrs.d) return true;
  }
  return false;
}

/**
 * Undo/redo for the editable document (`layers` + `groupTree` + selection), exposed as
 * drop-in replacements for the `useState` setters the page used before — `setLayers`/
 * `setGroupTree` each record a step, `setSelectedLayerIds` doesn't.
 *
 * Two things need explicit help from callers:
 *
 * - **Drags.** A gizmo move/scale/rotate or a path-anchor drag calls its setter once per
 *   animation frame; recording each frame would make Ctrl+Z rewind a drag pixel by pixel.
 *   Bracket the gesture in `beginDrag`/`endDrag` and the whole drag collapses into one step
 *   (and into none at all if the pointer came back to where it started).
 * - **Re-vectorizing / loading a new image.** That's a new document, not an edit, so it goes
 *   through `resetDocument`, which drops both stacks — an undo across a re-vectorize would put
 *   back layers that no longer match the current geometry buffers.
 */
export function useDocumentHistory() {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: EMPTY_DOCUMENT,
    future: [],
    dragBase: null,
    geometryEpoch: 0,
  });

  const mutate = useCallback((apply: (prev: DocumentState) => DocumentState) => {
    setHistory((h) => {
      const present = apply(h.present);
      if (!documentChanged(h.present, present)) return h;
      // Mid-drag frames only move `present` forward; the step itself is pushed by endDrag.
      if (h.dragBase) return { ...h, present };
      return {
        past: [...h.past, h.present].slice(-MAX_HISTORY),
        present,
        future: [],
        dragBase: null,
        geometryEpoch: h.geometryEpoch,
      };
    });
  }, []);

  const setLayers = useCallback(
    (action: SetStateAction<Layer[]>) => mutate((prev) => ({ ...prev, layers: resolve(action, prev.layers) })),
    [mutate],
  );

  const setGroupTree = useCallback(
    (action: SetStateAction<TreeNode[] | null>) => mutate((prev) => ({ ...prev, groupTree: resolve(action, prev.groupTree) })),
    [mutate],
  );

  const setSelectedLayerIds = useCallback((action: SetStateAction<string[]>) => {
    setHistory((h) => {
      const selectedLayerIds = resolve(action, h.present.selectedLayerIds);
      if (selectedLayerIds === h.present.selectedLayerIds) return h;
      return { ...h, present: { ...h.present, selectedLayerIds } };
    });
  }, []);

  const resetDocument = useCallback((document: DocumentState) => {
    setHistory((h) => ({
      past: [],
      present: document,
      future: [],
      dragBase: null,
      // Monotonic across documents: the fresh-vectorize path re-triangulates from `meta` anyway,
      // and never rewinding this keeps it a pure "something changed" signal.
      geometryEpoch: h.geometryEpoch,
    }));
  }, []);

  const beginDrag = useCallback(() => {
    setHistory((h) => (h.dragBase ? h : { ...h, dragBase: h.present }));
  }, []);

  const endDrag = useCallback(() => {
    setHistory((h) => {
      if (!h.dragBase) return h;
      if (!documentChanged(h.dragBase, h.present)) return { ...h, dragBase: null };
      return {
        past: [...h.past, h.dragBase].slice(-MAX_HISTORY),
        present: h.present,
        future: [],
        dragBase: null,
        geometryEpoch: h.geometryEpoch,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      // Refusing mid-drag keeps the stacks honest: the drag's own step hasn't been pushed yet,
      // so undoing here would discard a step the release is still about to record.
      if (h.dragBase || h.past.length === 0) return h;
      const present = h.past[h.past.length - 1];
      return {
        past: h.past.slice(0, -1),
        present,
        future: [h.present, ...h.future].slice(0, MAX_HISTORY),
        dragBase: null,
        geometryEpoch: h.geometryEpoch + (pathGeometryChanged(h.present.layers, present.layers) ? 1 : 0),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.dragBase || h.future.length === 0) return h;
      const present = h.future[0];
      return {
        past: [...h.past, h.present].slice(-MAX_HISTORY),
        present,
        future: h.future.slice(1),
        dragBase: null,
        geometryEpoch: h.geometryEpoch + (pathGeometryChanged(h.present.layers, present.layers) ? 1 : 0),
      };
    });
  }, []);

  return useMemo(
    () => ({
      layers: history.present.layers,
      groupTree: history.present.groupTree,
      selectedLayerIds: history.present.selectedLayerIds,
      geometryEpoch: history.geometryEpoch,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      setLayers,
      setGroupTree,
      setSelectedLayerIds,
      resetDocument,
      beginDrag,
      endDrag,
      undo,
      redo,
    }),
    [history, setLayers, setGroupTree, setSelectedLayerIds, resetDocument, beginDrag, endDrag, undo, redo],
  );
}
