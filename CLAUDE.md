# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A prototype for uploading a raster image, vectorizing it into an SVG, and editing the resulting paths as layers (select/hide/delete/recolor/transform/node-edit) on a canvas. FastAPI backend does the vectorization; React frontend does the editing UI.

## Commands

**Backend** (from `backend/`):
```bash
py -m venv venv
./venv/Scripts/pip install -r requirements.txt
./venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

**Frontend** (from `frontend/`):
```bash
npm install
npm run dev        # Vite dev server on :5173, proxies /api to :8000 (see vite.config.ts)
npm run build       # tsc -b && vite build
npm run lint        # oxlint
```

The backend has a pytest suite (`backend/tests/`, covering the grouping package and v2's geometry/postprocess/router):

```bash
cd backend && ./venv/Scripts/python.exe -m pytest tests -q
```

The frontend has no test suite — don't invent test commands for it.

The `.claude/launch.json` config runs both servers for browser-preview purposes (names `frontend` and `backend`).

## Architecture

### Backend: three parallel vectorization pipelines

`backend/app/main.py` mounts three independent implementations, each reachable at its own prefix and exercised by its own tab in the frontend nav (`/v1`, `/v2`, `/v3` in `App.tsx`). All three trace with the same `vtracer` library and expose the same trace params; they differ in what happens on either side of it:

- **v1** — `POST /api/vectorize` (defined inline in `main.py`). Raw pass-through to `vtracer` with user-tunable trace parameters (colormode, mode, corner/length/splice thresholds, etc.). Whatever vtracer returns is what the client gets.
- **v2** — `backend/app/v2/`, `POST /api/v2/vectorize`. Owns *both* ends: it flattens the raster into the regions it wants traced, then rewrites the document vtracer produces. See "v2" below.
- **v3** — `backend/app/v3/`, `POST /api/v3/vectorize`. A hybrid: reuses `app/quantize/preprocess.py` + `app/quantize/color_reduce.py` to quantize the image, then hands the quantized PNG to vtracer for the actual region/contour/curve tracing (same tunable trace params as v1, see `v3/params.py`).

`backend/app/quantize/` holds shared quantization utilities used by v2, v3, and v1's `grouping=opencv` mode (`app/grouping/segmented_pipeline.py`): `preprocess.py` (resize/alpha-mask/optional blur), `color_reduce.py` (k-means posterization plus `apply_palette`), and `params.py` (`QuantizeParams`, the frozen dataclass v3 and the grouping fallback read their settings from — v2 passes its own `VectorizeParamsV2`, which is duck-typed by field name).

`color_reduce.py` calls `cv2.setRNGSeed(0)` before every `cv2.kmeans`. That is load-bearing, not hygiene: `KMEANS_PP_CENTERS` seeds itself from OpenCV's process-global RNG, so without it the same image and the same parameters posterized to a different palette on every call — three runs of one preset over one file gave three different documents, and the spread was worth ~2.7 of mean absolute error. Unpinned, "Re-vectorize" could visibly worsen a result for no reason and no parameter comparison meant anything. It is process-global state rather than a per-call seed (OpenCV offers no other handle), so concurrent kmeans calls on other threads can still interleave.

Each stage's params are a frozen dataclass per pipeline (`QuantizeParams`, `VectorizeParamsV2`, `VectorizeParamsV3`) rather than shared, so tuning one pipeline can't silently affect another. v1's and v3's defaults match vtracer's own effective defaults, so an un-tuned request there behaves the same as before tuning existed; v2's are tuned for its own goal (fewer, cleaner layers) instead.

### v2: preprocess → vtracer → postprocess

v2 exists because most of what makes raw vtracer output unusable is decided outside the tracer. A noisy or photographic source has thousands of distinct colours and anti-aliased edges, and vtracer faithfully traces all of it — hundreds of near-duplicate layers, speckle paths, full-float64 coordinates, and no viewBox. v2's two extra stages each remove a specific category of that.

`app/v2/preprocess.py` (`prepare`) produces the flat-colour raster handed to vtracer, at the source image's own resolution (so none of it costs output detail — `max_dimension` bounds only the analysis, not the trace):

1. resize + alpha threshold — reuses `app/quantize/preprocess.py` with its Gaussian pre-blur disabled
2. `denoise` — bilateral filter: flattens in-region noise (JPEG blocks, grain, dithering) *without* softening the boundaries the tracer is about to follow, which a Gaussian blur would
3. `reduce_colors` (shared) — Lab k-means posterize. This bounds the output's *colour* count, but only in combination with `snap_fills_to_palette` below, and it is not the main lever on layer count (one colour is still thousands of disjoint regions)
4. `smooth_label_map` — majority filter over region ids, straightening the 1px staircase along boundaries. Deliberately on labels, not colours: a colour-space filter would invent intermediate colours, spawning new layers. **Off by default** — a 3×3 majority vote erases anything thinner than ~2px (a 1px stroke has 3 of 9 neighbours as itself, so it loses its own vote), and the postprocess RDP+refit removes staircases geometrically without that cost
5. `absorb_small_regions` — regions under `min_region_area` join their dominant neighbour. Upstream of vtracer's `filter_speckle`, and not a duplicate of it: absorbing here means the surrounding colour grows to cover the speck, whereas dropping it at trace time can leave a hole. **Off by default**, because on detailed art it is the most destructive dial available: after quantizing a grainy photo ~135,000 connected components sit under 32px covering a fifth of the image, and small text glyphs are themselves only 4–30px components, so no threshold distinguishes a speck of grain from a letter

`app/v2/postprocess.py` (`optimize_svg`) then rewrites the traced document: folds each path's `transform="translate(...)"` into its coordinates, drops paths under `min_path_area`, re-fits the geometry (below), snaps fills to the palette, merges same-fill paths, rounds to `precision` decimals, and rebuilds the file *with* a viewBox. Stage order is deliberate — dropping before fitting means never simplifying a path that is about to be discarded, and snapping before merging because the merge keys on fill equality.

**vtracer does not preserve the palette it is handed**, which is the single most surprising thing about this pipeline. Given a raster containing exactly 59 distinct flat colours it emitted 5,420 distinct fills (2,675 in `cutout` mode, and still 1,098 at `color_precision=4`): its layers carry their own computed colours. That silently voided the guarantee the whole preprocess stage was making, and it defeated `merge_same_fill`, which can only combine fills that compare *exactly* equal — so near-duplicates differing by one unit never merged. `_snap_fills` fixes it by snapping every fill onto the nearest palette entry in Lab, which brought that document back to 58 fills at a cost of 0.2 in measured error. It is also what makes the layer count controllable at all: with fills capped at the palette, `merge_same_fill="all"` collapses a document to one path per colour (9,208 → 59).

`app/v2/pathdata.py` is the geometry, and the part most worth understanding before changing it. Each path is flattened to a polyline, RDP finds its *structure* (which vertices matter, hence where the corners are), and cubics are then fitted through the dense points with a hard error bound (`max_fit_error`) using least-squares-with-fixed-tangents plus recursive splitting — Schneider's algorithm. Three details there are load-bearing, each having produced a real defect when absent:

- **Newton-Raphson reparameterization** before deciding to split. Chord-length parameters concentrate apparent error near a run's ends, so splitting on them cuts off slivers and cascades: a circle came out as 10 segments instead of 4.
- **Second-order end tangents** (`_end_tangent`). "Direction to the next point" is biased by half the turn between them, which tilts the fit enough to cost ~1px and provoke needless splits.
- **Straight runs get sampled too** (`LINE_STEP_PX`). The error check only measures *at input vertices*, so a run of one corner plus a long two-vertex edge lets a curve bulge far outside the shape and still pass. The inserted points are collinear, so RDP discards them again for free.

The two accuracy dials are separate on purpose: `simplify_tolerance` is the noise filter (keep it above 0.5, since a 1px staircase deviates 0.5px from the line it should collapse to — below that, every step reads as a corner) and `max_fit_error` bounds how far an emitted curve may sit from the contour. `tests/v2/test_pathdata.py` asserts that bound *symmetrically*; a one-directional check passes happily on a curve that loops out of the shape and back through every sampled point.

`merge_same_fill="adjacent"` (the default) merges only consecutive same-fill paths. That is the safe one and not by luck: vtracer emits one colour layer at a time, so a consecutive run of one fill is the disjoint components of a single colour, with nothing stacked between them — merging cannot change what any pixel renders as. `"all"` reaches across stacking positions for a much lower layer count, and whether that is *correct* depends entirely on `hierarchical`: under `stacked` those paths overlap and their order carries the image, so collapsing them measured 14.01 against 9.04, whereas under `cutout` the shapes are disjoint. Hence opt-in, and only the cutout presets take it.

#### Presets, and why the defaults changed

`app/v2/presets.py` names the useful corners of the parameter space (Illustrator's Image Trace presets are the model): `high-fidelity-photo`, `low-fidelity-photo`, `16-colors`, `6-colors`, `3-colors`. Each is a complete `VectorizeParamsV2` rather than a patch, so reading one tells you every value it implies and selecting one fully determines the result. `GET /api/v2/presets` serves them and the frontend fetches that list instead of keeping its own copy — a mirrored table would drift the first time either side was retuned. On the wire, every v2 form field defaults to `None` so "not sent" is distinguishable from "sent, equal to the default"; that is what lets `preset` supply a base that only explicitly-sent fields override.

Presets rather than defaults are the right answer because no single setting suits both a flat logo and a dense photographic composite, and v2's original defaults tried to be both. Measured against `samples/`'s design sheet (1536×1024, small text, a teal/orange wrap over near-black) they scored 11.58 mean absolute error where raw v1 scored 7.70, because `n_colors=16` starved the palette (the image's own named brand colour got no entry and rendered grey), `min_region_area=32` absorbed the text, and `min_path_area=16` punched holes. The retuned defaults (= `high-fidelity-photo`) score 8.96 at 9,208 paths; `low-fidelity-photo` scores 10.41 at **24 paths** — better than the old defaults on both counts at once.

The two presets get their layer counts from opposite ends, and the interesting finding is which end works. All the low-layer presets share one profile (`_FEW_LAYERS`) that reaches a low count via `cutout` + `merge_same_fill="all"` — one path per palette colour — and leaves `min_region_area`/`min_path_area` at 0. Deleting content to reduce layers, which is what the old defaults did, is simply worse: at the *same* 24 paths, absorption on scored 14.11 and absorption off 10.41. The merge itself is free under cutout (14.11 against 14.12 for 24 vs 2,467 paths) precisely because those shapes are disjoint.

Those numbers come from rendering each output in a browser and differencing it against the source. Three caveats if you re-measure. A hand-rolled Python rasteriser overstated the error by 1–3 against Chrome's renderer. Pixel error rewards reproducing JPEG grain, which is most of why v1 still leads on it. And it badly under-weights the defect the old defaults actually had — rendering the teal as grey costs little error over a small area while being the most visible thing wrong with the image — so treat the numbers as a regression guard, not a ranking of how good each preset looks.

### Grouping: segmenting the source image into a layer/group tree

`grouping` (`'none' | 'opencv' | 'fastsam'`, `GroupingMode` in both `backend/app/grouping/schema.py` and frontend `types.ts`) is a form field on every pipeline's vectorize request. All three routers hand it to the one shared entry point, `app/grouping/router_support.py`'s `finalize_vectorize_response` — `grouping="none"` skips the grouping package entirely, so the default path has no added cost and byte-identical output to before grouping existed.

`finalize_vectorize_response` also takes an optional `postprocess` hook (`SvgPostprocessor`), which only v2 passes. Because leaves address paths by index in document order, a pass that drops or merges paths would invalidate the whole forest — so the hook returns an index map alongside the rewritten SVG, and `app/grouping/remap.py`'s `remap_leaf_indices` translates the tree through it (dropping vanished leaves, collapsing merged ones onto one index, pruning groups left empty) while `data-region-index` attributes are rewritten to match. Grouped requests also call the hook with `allow_merge=False`: a path merged out of two segments would belong to two groups at once, and there is no honest answer for which owns it.

`app/grouping/segmented_pipeline.py`'s `build_grouped_svg` segments the *source image* before vectorizing (not the flat path list after), so each path's group membership falls out of which mask it was traced from rather than a lossy post-hoc match: `opencv_segment.py` derives masks from connected components within the color-quantized `label_map` (reusing `app/quantize/preprocess.py` + `color_reduce.py`, quantizing a disposable copy for v1 since it has none of its own); `fastsam_segment.py` runs Ultralytics FastSAM instance segmentation on the raw raster instead. Either way, each mask is vectorized independently (`masked_vectorize.py`) and the per-segment SVGs are recombined (`svg_merge.py`) into one document; `containment.py` turns each mask's bbox into a nesting forest (a mask inside another's bbox becomes its child group) that becomes the response's `groups` tree. Segmentation that finds nothing worth grouping, or blows past `MAX_SEGMENTS` (150), returns `None` and the caller silently falls back to one plain ungrouped vectorize call — an expected outcome, not an error.

FastSAM depends on `ultralytics`, currently commented out of `backend/requirements.txt` — `grouping=fastsam` will fail at import time until it's reinstalled and a `FastSAM-s.pt` weights file is available (path configurable via `FASTSAM_WEIGHTS_PATH`).

On the frontend, `lib/groupTree.ts` turns the backend's `TreeNode[]` (or `null`, for `grouping=none`) plus the flat `Layer[]` into the `LayersPanel`'s row list, and owns all tree mutation: manual group/ungroup from a multi-select, per-row "move to group" / "move up a level" (via context menus in `LayerContextMenuItems.tsx`), and a completeness pass that guarantees every non-deleted layer appears exactly once even if the backend's coverage is partial. Manual groups get a client-only `manual-group-N` id and coexist in the same tree shape as backend-derived ones. Rectangular marquee selection lives in `hooks/useCanvasInteractions.ts` (hit-tested against the WebGL scene, not the DOM).

### Frontend: SVG parsed into an editable layer list, rendered on WebGL

Flow in `pages/VectorizerPage.tsx` (the only page, parameterized by `apiEndpoint` for v1/v2/v3 — `lib/vectorizeParams.ts`'s `defaultParamsFor` picks that endpoint's defaults, and only v2's carry the `v2` sub-object of pre/post-processing params, whose presence is what makes `ParamsPanel` render those sections and `appendVectorizeParams` send those fields). On the v2 route it also fetches the preset list once and hands it to `ParamsPanel`; a `V2PresetInfo`'s `params` is a *whole* `VectorizeParams`, trace fields included, because the flat-colour presets switch `hierarchical` to `cutout` and this client always sends every field explicitly — a preset carrying only its v2 half would be overridden straight back:

1. Upload → POST to the selected pipeline's endpoint → get back one `<svg>` string.
2. `lib/svgParse.ts` parses that string into `SvgMeta` (width/height/viewBox) + a flat `Layer[]` (one per top-level path/shape, each with `id`, `fill`, `attrs` incl. `d`, `visible`, `deleted`, and a cumulative edit `transform` matrix).
3. All further editing (visibility, delete, recolor, move/scale/rotate, node/path editing) mutates that `Layer[]` in React state — never re-parses the SVG.
4. `lib/svgSerialize.ts` turns `SvgMeta` + `Layer[]` back into an SVG string for download.

**Undo/redo**: the editable document isn't plain `useState` — `hooks/useDocumentHistory.ts` holds `layers` + `groupTree` + `selectedLayerIds` as one snapshot behind past/present/future stacks (Ctrl/Cmd+Z, Ctrl+Y or Ctrl/Cmd+Shift+Z), and hands `VectorizerPage` setters shaped exactly like the `useState` ones it replaced. What it records is the interesting part:

- `setLayers`/`setGroupTree` each record a step; `setSelectedLayerIds` records none. A snapshot still *carries* the selection, so undoing a delete re-selects what came back.
- A gizmo or path-anchor drag calls its setter once per animation frame, so both interaction hooks bracket the gesture with `onTransformStart`/`onTransformEnd` (→ `beginDrag`/`endDrag`): intermediate frames move `present` without pushing, and the release pushes the pre-drag state once — or nothing at all, if the pointer came back to where it started. Undo is refused while a drag is open, since the step it would discard hasn't been pushed yet.
- A re-vectorize goes through `resetDocument`, which clears both stacks: layer ids are unique per parse, so an undo across it would restore layers the current GL buffers know nothing about.
- Undoing a *path edit* is the one case the renderer can't see by itself — `useCanvasGLScene` triangulates per layer set, not per `d` — so the hook counts a `geometryEpoch` whenever an undo/redo swapped in different path geometry, and CanvasGL adds it to its own path-edit counter to force the same re-triangulation a live drag does.

Snapshots are structurally shared (a mutation replaces the `layers` array but keeps almost every `Layer` object), which is what makes a 100-step history affordable on v2's ~9k-path documents. `collapsedGroupIds` is deliberately outside the history — it's view state, not document state.

**Rendering**: `components/CanvasGL.tsx` is the active renderer — a WebGL2 canvas that triangulates every layer's path once per vectorize into a single VBO/IBO (one draw call regardless of layer count), looks up each layer's fill from a palette texture (so toggling visibility is an O(1) texture update), and resolves hover/click via a GPU color-id pick buffer instead of DOM hit-testing. Pan/zoom is a CSS transform on the artboard wrapper, so it never triggers a GL re-render. Move/scale/rotate edits are applied via per-layer GPU transform textures rather than re-triangulating.

`components/Canvas.tsx` is an older SVG/DOM-based renderer kept in the tree but currently unused (swapped out in `VectorizerPage.tsx`) — don't assume it's on the render path.

CanvasGL itself only wires state together; the real logic is split across:
- `lib/canvasGLEngine.ts` — raw WebGL2 setup, shaders, draw calls.
- `lib/sceneBuilder.ts` — builds the triangulated geometry/transform arrays from `Layer[]`.
- `hooks/useCanvasGLScene.ts` — owns the GL context/canvas ref and re-triangulation lifecycle.
- `hooks/useCanvasInteractions.ts` — pointer/drag handling (pan, select, gizmo move/scale/rotate).
- `hooks/useCanvasPathEditing.ts` + `lib/pathEdit.ts` — per-anchor node editing of a single layer's `d` string (parses path commands, exposes draggable anchors/control points, re-serializes).

`lib/canvasViewTransform.ts` computes the shared view transform (viewBox → screen) and gizmo hit-testing used by both the interactions and path-editing hooks.

### UI components

`components/ui/` is shadcn/base-ui-generated primitives (button, slider, accordion, etc.) — treat as generated/vendored, prefer composing them over editing internals. Feature components (`Toolbar`, `LayersPanel`, `LayerRow`, `ParamsPanel`, `UploadDropzone`) live directly under `components/`.

`Tool` (`types.ts`) is a three-way mode — `cursor` (select/move/scale/rotate/path-edit), `hand` (pan-only, ignores hit-testing), `pen` (click-to-enter path-edit directly) — modeled as one string union rather than independent booleans since the modes are mutually exclusive.

### Conventions worth preserving

- Soft-delete: removing a layer sets `deleted: true` + `visible: false` rather than removing it from the array, so the layer list identity is stable and downstream memoization (triangulation, palette texture) doesn't have to rebuild.
- Document mutations go through `useDocumentHistory`'s setters rather than local `useState`, so every new edit action is undoable by construction; a new streaming (per-frame) edit only has to bracket itself with `beginDrag`/`endDrag`.
- `OverlayMode` in `VectorizerPage.tsx` (`'none' | 'original' | 'paths'`) is likewise one value instead of two booleans, since "show original" and "show paths outline" are mutually exclusive overlays.
- Backend param dataclasses are frozen and versioned per pipeline (`VectorizeParamsV2`, `VectorizeParamsV3`) rather than shared/mutated, so tuning one stage can't silently affect another.
