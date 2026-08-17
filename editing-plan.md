# Layer editing in CanvasGL: move, scale, rotate, group-select, recolor

## Context

The vectorized SVG is currently read-only in the app: `CanvasGL.tsx` renders layers and supports hover/click-to-select and visibility/delete toggles, but nothing lets the user reposition, resize, rotate, multi-select, or recolor a layer after vectorizing. The user wants an Illustrator/Figma-style editing pass on top of the existing WebGL2 renderer: on-canvas scale/rotate handles, ctrl/shift-click group selection (both in the layers panel and directly on canvas), and a color-swatch picker per layer (recoloring all selected layers at once when several are selected).

The existing renderer is built around a "cheap O(1) per-layer GPU update" philosophy (palette texture texel writes for color/visibility, GPU pick-buffer readback for hit-testing) to stay fast with tens of thousands of layers. The plan below extends that same philosophy to transforms and multi-select, instead of re-triangulating paths on every edit.

## Data model

**`frontend/src/types.ts`**: add `transform: Mat2x3` to `Layer` (import `Mat2x3` from `svgTransform.ts`). This is a *cumulative edit matrix* mapping a layer's existing world-space geometry (post `attrs.transform`, i.e. what's already triangulated) to its current edited position — identity `[1,0,0,1,0,0]` until the user edits it. Base geometry (`d` + `attrs.transform`) is never touched by edits; only this extra matrix changes, so nothing needs re-triangulating.

**`frontend/src/lib/svgTransform.ts`**: export the existing `IDENTITY` and `multiply`; add small composition helpers used by every edit op: `translateMatrix(m, dx, dy)`, `scaleAroundPivot(m, px, py, sx, sy)`, `rotateAroundPivot(m, px, py, radians)` — each builds the incremental matrix and returns `multiply(incremental, m)` (SVG-spec order, same as `parseTransform` already uses).

**`frontend/src/lib/svgParse.ts`**: initialize `transform: [...IDENTITY]` on every parsed `Layer`.

## Rendering: per-layer transform lives on the GPU

Mirrors the existing palette-texture pattern (`buildPalette`/`uploadPalette`/`texSubImage2D`) so editing is O(1) regardless of layer count:

- **`sceneBuilder.ts`**: `buildSceneGeometry` additionally tracks each layer's base-world-space AABB while it already walks triangulation positions, returning `layerBounds: Float32Array` (4 floats/layer: minX,minY,maxX,maxY). Add `buildTransformTexel(layer)` → `{ab: Float32Array(4), ef: Float32Array(4)}` from `layer.transform`, and `buildTransformTextures(layers)` / `buildSelectionArray(layers, selectedIds)` (R8, 0/255) for full rebuilds. Add `normalizeColorToHex(color)` (reuses the existing `parseCssColor` canvas trick) for the color-input UI. Factor a shared `computeGridSize(count, maxTextureSize)` out of `uploadPalette` so palette/transform/selection textures always share identical `paletteWidth`/height layout (same `ivec2(i % w, i / w)` indexing everywhere).

- **`CanvasGL.tsx`** (`GLState`/`initGL`): add two `RGBA32F` textures (`transformABTexture`, `transformEFTexture`, unit 1/2) sampled via `texelFetch` — no filtering/extension needed. Add one `R8` `selectionTexture` (unit 3), sampled only by the outline program.
  - `VERTEX_SHADER` (shared by display+pick programs): before the existing `(a_position - u_vbMin) * u_meetScale + u_meetOffset` line, fetch this vertex's layer's `(a,b,c,d)`/`(e,f)` texels and apply `worldPos = mat2(a,b,c,d) * a_position + (e,f)` first. Both display and pick programs get this fix for free since they share the constant. This is required for pick-buffer hit-testing to stay correct after an edit, not just visuals.
  - `OUTLINE_VERTEX_SHADER`: apply the same per-layer matrix to both `a_position` and `a_other` (same layer, so same matrix) before `toClip`.
  - `OUTLINE_FRAGMENT_SHADER`: replace `u_selectIndex` (single int) with `u_selection` (sampler, texelFetch → 0/1) so multiple layers can be highlighted at once; `u_hoverIndex` stays a single int (hover is always one layer). `renderOutline` drops the `selectIndex` param accordingly.
  - `transformUniforms()` helper gains the two transform-texture sampler uniforms (shared by display/pick/outline); a small `bindPerLayerTextures(gl, state)` binds palette+transformAB+transformEF at the top of `renderDisplay`/`renderPick`/`renderOutline`; `renderOutline` additionally binds the selection texture.
  - The `[layers]` diff effect (already loops changed-by-reference layers to rewrite a palette texel) also writes that layer's transform texel in the same loop — no new effect needed for transform edits. A new/extended effect keyed on `selectedLayerIds` rebuilds+uploads the whole (tiny) selection array on every selection change.
  - The `sceneGeometry`-keyed effect (fresh vectorize) does a full upload of the transform+selection textures alongside the existing palette upload.

## Selection: single id → multi-id, both surfaces

Replace `selectedLayerId: string | null` with `selectedLayerIds: string[]` end-to-end (`VectorizerPage`, `CanvasGL`, `LayersPanel`, `LayerRow`), and change the selection callback shape to `onSelectLayer(ids: string[], mode: 'replace' | 'add' | 'toggle')` so `VectorizerPage`'s handler stays a dumb reducer:

```
replace → ids
add     → union(prev, ids)          // shift-range in the panel
toggle  → xor each id in prev       // ctrl/shift-click on canvas, ctrl-click in panel
```

- **`LayersPanel.tsx`**: track `lastSelectedIndexRef`; plain click → `replace [id]`, ctrl/cmd-click → `toggle [id]`, shift-click → `add` the visual range between `lastSelectedIndexRef` and the clicked row (using its existing `orderedLayers`). `isSelected` becomes `selectedLayerIds.has(layer.id)` (pass a `Set<string>` down for O(1) lookups against thousands of rows).
- **`CanvasGL.tsx`**: click resolves a layer id via the existing `pickAt`; plain click → `replace`, ctrl/shift-click → `toggle` (no spatial "range" concept on canvas); clicking empty canvas → `replace []`.

## Gizmo: on-canvas scale + rotate handles

Rendered as an `<svg class="canvas__gizmo">` overlay, sibling to the GL `<canvas>` inside `.canvas__page`, same `viewBox="0 0 {view.width} {view.height}"` as the content box `computeViewTransform` already produces — so it pans/zooms for free via the parent `.canvas__artboard`'s CSS transform, no extra math. Hidden when selection is empty or `showOriginal` is on.

- Per selected layer, transform its 4 base-AABB corners (from `sceneGeometry.layerBounds`) by its current `layer.transform`, then through the same `(pos - vbMin)*scale + offset` mapping used for rendering, to get page-space points.
- **Single layer selected**: draw those 4 (possibly rotated) points as the selection quad, in order — naturally shows an oriented box after a rotate.
- **Multiple layers selected**: take the axis-aligned min/max over *all* selected layers' transformed corners and draw that rect (standard multi-select behavior; documented simplification — no oriented group box).
- Handles: a `<circle>` at each of the 4 corners (scale) and one above the top-center edge (rotate), radius `HANDLE_RADIUS_PX / scale` so they stay a constant screen size across zoom (same trick `OUTLINE_WIDTH_CSS_PX` already uses). Each handle's `onMouseDown` starts a drag mode; the rest of the overlay has `pointer-events: none` so clicks pass through to the canvas.

**Drag handling** (`CanvasGL.tsx`, extends the existing pan `dragOrigin`/`handleMouseMove` machinery with a `dragMode: 'pan' | 'move' | 'scale' | 'rotate'` ref):

- New `clientToWorld(view, canvas, clientX, clientY)` (inverse of `computeViewTransform`'s mapping, using `getBoundingClientRect` like `pickAt` does) to turn pointer events into viewBox-space coordinates.
- Mousedown on the inner `<canvas>`: if the pick hits a layer already in the selection, start a **move** drag (`e.stopPropagation()` so the wrapper's pan-drag doesn't also engage); otherwise fall through to today's behavior (pan-drag + click-to-select).
- On drag start, snapshot `initialTransforms: Map<id, Mat2x3>` for every selected layer plus the relevant pivot (opposite corner for scale, box center for rotate) — later frames always recompute from this snapshot (not from the previous frame's output) so releasing without net movement is a true no-op and there's no per-frame drift.
- Per mousemove (rAF-throttled the same way the existing hover-pick handler already coalesces, via a ref flag):
  - **move**: `next = [a,b,c,d, e0+dx, f0+dy]` per layer.
  - **scale**: `sx,sy` from `(pointerWorld - pivot) / (dragStartCorner - pivot)`; `next = multiply(scaleAroundPivot(pivot, sx, sy), initial)` per layer.
  - **rotate**: `dTheta` from the change in `atan2(pointerWorld - pivot)`; `next = multiply(rotateAroundPivot(pivot, dTheta), initial)` per layer.
  - Call `onTransformLayers(nextLayers)` — a full-array replace, same shape as any other `setLayers` call, so it flows through the existing `[layers]` diff effect (which now also writes transform texels, see above) with no separate "commit" step needed.

## Color editing

- **`svgSerialize.ts`**: add `setLayerFill(layer, hex): Layer` — sets `layer.fill` and `attrs.fill`, and additionally patches (or strips) any `fill:` declaration inside `attrs.style` if present, since an SVG `style` attribute wins over the `fill` presentation attribute and would otherwise silently keep the old color in the exported file/thumbnail even though the GL view (which reads `layer.fill` directly) shows the new one.
- **`svgSerialize.ts`**: `layerToPathMarkup` composes `layer.transform` into the rendered `transform` attribute when it's non-identity (`matrix(a b c d e f) {originalTransform}`), so both the exported SVG *and* `LayerRow`'s thumbnail preview correctly reflect edits (today they only render `attrs` verbatim).
- **`LayerRow.tsx`**: add a small color-swatch button (current `layer.fill`, normalized via `normalizeColorToHex`) that opens a native `<input type="color">`; `onChange` calls `onChangeColor(id, hex)`.
- **`VectorizerPage.tsx`**: `handleChangeColor(id, hex)` — if `id` is part of a multi-layer `selectedLayerIds`, apply `setLayerFill` to every selected layer; otherwise just to `id`.

## Wiring changes in `VectorizerPage.tsx`

- `selectedLayerId` state → `selectedLayerIds: string[]`; reset to `[]` at the same points the single id is reset today (new upload, revectorize, reset).
- `handleSelectLayer(ids, mode)` per the reducer above.
- `handleChangeColor(id, hex)` per above.
- `onTransformLayers(nextLayers: Layer[])` → `setLayers(nextLayers)` directly (CanvasGL computes the full next array itself).
- Pass the new props through to `CanvasGL` and `LayersPanel`.

## Styling (`App.css`)

Add `.canvas__gizmo` (absolute, inset 0, `pointer-events: none` on the root, `pointer-events: all` on handles), handle circle styling (accent fill, white stroke, grab/pointer cursors per mode), and a small swatch-button style in the layer row for the new color input trigger.

## Verification

- Typecheck/build: run the frontend's existing build script (check `frontend/package.json`) to confirm the shader/type changes compile.
- Manual pass via the dev server preview: vectorize a sample image, then:
  - Click a layer → gizmo appears; drag a corner → scales; drag the top handle → rotates; drag the body → moves.
  - Ctrl-click a second shape on canvas, and separately shift-click a range in the layers panel → gizmo becomes the group union box; dragging a corner scales both around the shared pivot.
  - Change a swatch with one layer selected (recolors just that layer) and with multiple selected (recolors all of them); confirm the layer-row thumbnail updates.
  - Zoom/pan while a selection is active → gizmo stays aligned and handle size stays visually constant.
  - Download the SVG and confirm the exported `<path>` elements carry the composed `transform`/`fill` reflecting the edits.