# Path (node) editing for CanvasGL layers

## Context

`CanvasGL.tsx` currently supports a move/scale/rotate gizmo on the selected layer(s) (`useCanvasInteractions.ts` + `computeGizmoState` in `canvasViewTransform.ts`), backed by a GPU-resident per-layer transform matrix (`Layer.transform`) that's applied without re-triangulating (see `canvasGLEngine.ts`'s transform textures). The user wants an Illustrator-style "direct selection" mode: double-clicking a shape should let them drag its actual path anchor points to reshape it (like the reference screenshot — plain draggable dots along the curve), while a single click keeps today's move/scale/rotate gizmo behavior untouched.

This requires three new pieces the codebase doesn't have yet: (1) a way to parse a layer's `attrs.d` path string into draggable anchor points and re-serialize edits back into `d`, (2) a drag interaction for those anchors, and (3) a way to force the WebGL geometry to re-triangulate on a path edit — today `sceneGeometry` in `useCanvasGLScene.ts` is deliberately memoized on `[meta]` only, since ordinary layer edits (move/scale/rotate/recolor/visibility) are handled as O(1) texel writes, not re-triangulation.

## Approach

Anchor-only editing (per screenshot): dragging an anchor moves that point and translates its attached bezier control point(s) by the same delta, so curves stay smooth without exposing separate handle lines. No add/delete node support yet. Exit via Escape or double-clicking empty canvas.

### 1. New lib: `frontend/src/lib/pathEdit.ts`

- Parse a `d` string into subpaths of normalized absolute commands (`M/L/C/Q/A/Z`), expanding relative commands, `H`/`V` into `L`, and `S`/`T` shorthand into `C`/`Q` (standard reflection rule) using a small hand-written tokenizer (no existing parser in the repo to reuse — `pathFlatten.ts` only flattens via the browser's `getPointAtLength`, which doesn't expose control points).
- One editable **anchor** per endpoint-bearing command (M/L/C/Q/A), indexed by `(subpathIndex, commandIndex)`.
- For each anchor, precompute which control-point slots move with it:
  - a C/Q command's *last* control point is "incoming" to its own end anchor.
  - the *next* command's *first* control point (if C/Q) is "outgoing" from this anchor.
- Closed subpaths where the last command's endpoint coincides with the initial `M` (within an epsilon — vtracer commonly emits this) are treated as a single merged seam anchor: moving it updates both the `M` point and the final command's endpoint, so the seam doesn't tear open.
- `serialize(parsed): string` rebuilds a `d` string from the mutated commands (fixed decimal precision to avoid float noise).
- Pure functions, no DOM/React dependency — easy to unit-test mentally by tracing a sample `d`.

### 2. `svgTransform.ts`: add `invertMatrix(m: Mat2x3): Mat2x3`

Standard 2x3 affine inverse (`det = a*d - b*c`). Needed to map a dragged anchor's new world-space position back into the path's local coordinate space (see math below). Also export the `toPage`-style helper currently inlined in `computeGizmoState` (in `canvasViewTransform.ts`) as `worldToPage(view, x, y)` so the new hook can reuse it instead of duplicating the formula.

### 3. New hook: `frontend/src/hooks/useCanvasPathEditing.ts`

Owns:
- `editingLayerId: string | null` state.
- A memoized parse of the editing layer's `attrs.d` (via `pathEdit.ts`) — recomputed when `editingLayerId` or that layer's `attrs.d` changes.
- Anchor positions projected to **page space** for rendering: `pathLocal -> worldSpace` via `multiply(layer.transform, parseTransform(layer.attrs.transform))` (same composition order `buildLayerGeometry`/the GPU shader already use: `attrs.transform` bakes in first, `layer.transform` applies on top), then `worldToPage(view, ...)`.
- `enterPathEdit(layerId)` / `exitPathEdit()`.
- `handleAnchorMouseDown(e, anchorRef)`: `stopPropagation()`/`preventDefault()` (same pattern as `handleGizmoHandleMouseDown`), snapshots the anchor's (and its attached controls') starting **world** positions plus the starting mouse world position (via the existing `clientToWorld`), and the drag-invariant inverse matrix (`invertMatrix` of the composed path-local→world matrix above).
- Its own `onWrapperMouseMove` / `onWrapperMouseUp`, rAF-throttled like `useCanvasInteractions.applyDrag`: on each tick, compute `worldDelta = mouseWorldNow - mouseWorldStart`, add it to each snapshot world position, invert back to path-local via the precomputed inverse matrix, write the new coordinates into the parsed command list, `serialize()` a new `d`, and call `onTransformLayers` with that one layer's `attrs.d` replaced (same `Layer[]` replace shape `onTransformLayers` already expects — no prop changes needed there).
- Also bumps a `geometryVersion` counter (see below) on every committed frame so the GL geometry re-triangulates live during the drag, matching how scale/rotate already redraw every rAF tick.
- A `useEffect` global `keydown` listener: `Escape` calls `exitPathEdit()`.
- A safety effect: if the editing layer becomes deleted/missing from `layers`, clear `editingLayerId`.

### 4. `useCanvasGLScene.ts`: accept `geometryVersion` and depend on it

Change:
```ts
const sceneGeometry = useMemo(() => buildSceneGeometry(layers), [meta]); // current
```
to include a new `geometryVersion` option in the memo deps (`[meta, geometryVersion]`), keeping the existing eslint-disable comment/rationale but noting the new deliberate trigger. `geometryVersion` is bumped only by path edits — every other layer mutation keeps going through the existing cheap per-texel diff effect, unaffected.

### 5. `CanvasGL.tsx`: wire it together

- Instantiate `useCanvasPathEditing`, passing it to `useCanvasGLScene` (`geometryVersion`) and getting back `editingLayerId`, `pathAnchorsPage`, handlers.
- Add `onDoubleClick` on the `<canvas>`: pick the layer under the cursor (`pickLayerIndexAt`, already exposed); if hit, `enterPathEdit(id)`; if empty and currently editing, `exitPathEdit()`.
- When `editingLayerId` is set, render a new overlay `<svg className="canvas__path-edit">` (same positioning pattern as `canvas__gizmo`) with one `<circle className="canvas__path-anchor">` per anchor, `onMouseDown={handleAnchorMouseDown}` — **instead of** the existing gizmo overlay (so scale/rotate handles disappear while editing that layer; a plain click-select elsewhere still gets the normal gizmo since `editingLayerId` is independent of `selectedLayerIds`).
- Compose the wrapper's `onMouseMove`/`onMouseUp` to call both `useCanvasInteractions`'s handlers and the new hook's handlers (anchor mousedown already stops propagation, so the two drag state machines never fire simultaneously).
- New CSS in `App.css`, mirroring `.canvas__gizmo-handle`: `.canvas__path-edit { position:absolute; inset:0; pointer-events:none; overflow:visible; }` and `.canvas__path-anchor { fill:#fff; stroke:#4dabf7; stroke-width:1.5; vector-effect:non-scaling-stroke; pointer-events:all; cursor:move; }`.

## Known limitation (called out, not solved in v1)

Arc (`A`) command endpoints are draggable but only their endpoint coordinate is updated — `rx/ry/rotation` aren't recomputed, so dragging an arc's anchor can visibly distort that segment. Vtracer's actual output (spline/polygon modes) only emits `M/L/C/Z`, so this shouldn't come up in practice; noting it so it's not a silent surprise if some other source SVG has arcs.

## Verification

1. `npm run dev` in `frontend/`, open the app in the Browser pane, upload an image, vectorize it.
2. Single-click a shape → confirm the existing move/scale/rotate gizmo still works exactly as before (regression check).
3. Double-click a shape → confirm the gizmo box disappears and anchor dots appear along its outline (matching the reference screenshot).
4. Drag an anchor → confirm the fill updates live (re-triangulation working) and the curve stays smooth (attached control points followed the anchor).
5. Press Escape → confirm it exits back to normal selection (gizmo reappears on click).
6. Double-click empty canvas while editing → confirm it also exits.
7. Export/download the SVG (existing toolbar action) after an edit → confirm the exported `d` reflects the reshaped path.
8. Check the browser console for errors during the above, and `read_console_messages` / a screenshot as proof.