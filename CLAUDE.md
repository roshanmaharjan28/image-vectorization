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

There is no test suite in either project currently — don't invent test commands.

The `.claude/launch.json` config runs both servers for browser-preview purposes (names `frontend` and `backend`).

## Architecture

### Backend: two parallel vectorization pipelines

`backend/app/main.py` mounts two independent implementations, each reachable at its own prefix and exercised by its own tab in the frontend nav (`/v1`, `/v3` in `App.tsx`):

- **v1** — `POST /api/vectorize` (defined inline in `main.py`). Raw pass-through to the `vtracer` library with user-tunable trace parameters (colormode, mode, corner/length/splice thresholds, etc.).
- **v3** — `backend/app/v3/`, `POST /api/v3/vectorize`. A hybrid: reuses `app/quantize/preprocess.py` + `app/quantize/color_reduce.py` to quantize the image, then hands the quantized PNG to vtracer for the actual region/contour/curve tracing (same tunable trace params as v1, see `v3/params.py`).

`backend/app/quantize/` (formerly the v2 pipeline, now removed) holds shared quantization utilities used by v3 and by v1's `grouping=opencv` mode (`app/grouping/segmented_pipeline.py`): `preprocess.py` (resize/denoise/alpha-mask), `color_reduce.py` (k-means posterization), and `params.py` (`QuantizeParams`, the frozen dataclass those two read their settings from). There is no `/api/v2/vectorize` route or standalone pipeline anymore — don't re-add one without checking what already imports these modules.

Each stage's params are a frozen dataclass (`QuantizeParams` for the shared quantization step, `VectorizeParamsV3` for v3's vtracer trace step) with defaults chosen to match vtracer's own effective defaults, so an un-tuned request behaves the same as before tuning existed.

### Grouping: segmenting the source image into a layer/group tree

`grouping` (`'none' | 'opencv' | 'fastsam'`, `GroupingMode` in both `backend/app/grouping/schema.py` and frontend `types.ts`) is a form field on v1's and v3's vectorize requests. Both routers hand it to the one shared entry point, `app/grouping/router_support.py`'s `finalize_vectorize_response` — `grouping="none"` skips the grouping package entirely, so the default path has no added cost and byte-identical output to before grouping existed.

`app/grouping/segmented_pipeline.py`'s `build_grouped_svg` segments the *source image* before vectorizing (not the flat path list after), so each path's group membership falls out of which mask it was traced from rather than a lossy post-hoc match: `opencv_segment.py` derives masks from connected components within the color-quantized `label_map` (reusing `app/quantize/preprocess.py` + `color_reduce.py`, quantizing a disposable copy for v1 since it has none of its own); `fastsam_segment.py` runs Ultralytics FastSAM instance segmentation on the raw raster instead. Either way, each mask is vectorized independently (`masked_vectorize.py`) and the per-segment SVGs are recombined (`svg_merge.py`) into one document; `containment.py` turns each mask's bbox into a nesting forest (a mask inside another's bbox becomes its child group) that becomes the response's `groups` tree. Segmentation that finds nothing worth grouping, or blows past `MAX_SEGMENTS` (150), returns `None` and the caller silently falls back to one plain ungrouped vectorize call — an expected outcome, not an error.

FastSAM depends on `ultralytics`, currently commented out of `backend/requirements.txt` — `grouping=fastsam` will fail at import time until it's reinstalled and a `FastSAM-s.pt` weights file is available (path configurable via `FASTSAM_WEIGHTS_PATH`).

On the frontend, `lib/groupTree.ts` turns the backend's `TreeNode[]` (or `null`, for `grouping=none`) plus the flat `Layer[]` into the `LayersPanel`'s row list, and owns all tree mutation: manual group/ungroup from a multi-select, per-row "move to group" / "move up a level" (via context menus in `LayerContextMenuItems.tsx`), and a completeness pass that guarantees every non-deleted layer appears exactly once even if the backend's coverage is partial. Manual groups get a client-only `manual-group-N` id and coexist in the same tree shape as backend-derived ones. Rectangular marquee selection lives in `hooks/useCanvasInteractions.ts` (hit-tested against the WebGL scene, not the DOM).

### Frontend: SVG parsed into an editable layer list, rendered on WebGL

Flow in `pages/VectorizerPage.tsx` (the only page, parameterized by `apiEndpoint` for v1/v3):

1. Upload → POST to the selected pipeline's endpoint → get back one `<svg>` string.
2. `lib/svgParse.ts` parses that string into `SvgMeta` (width/height/viewBox) + a flat `Layer[]` (one per top-level path/shape, each with `id`, `fill`, `attrs` incl. `d`, `visible`, `deleted`, and a cumulative edit `transform` matrix).
3. All further editing (visibility, delete, recolor, move/scale/rotate, node/path editing) mutates that `Layer[]` in React state — never re-parses the SVG.
4. `lib/svgSerialize.ts` turns `SvgMeta` + `Layer[]` back into an SVG string for download.

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
- `OverlayMode` in `VectorizerPage.tsx` (`'none' | 'original' | 'paths'`) is likewise one value instead of two booleans, since "show original" and "show paths outline" are mutually exclusive overlays.
- Backend param dataclasses are frozen and versioned per pipeline (`VectorizeParamsV2`, `VectorizeParamsV3`) rather than shared/mutated, so tuning one stage can't silently affect another.
