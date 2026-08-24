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

### Backend: three parallel vectorization pipelines

`backend/app/main.py` mounts three independent implementations, each reachable at its own prefix and exercised by its own tab in the frontend nav (`/v1`, `/v2`, `/v3` in `App.tsx`):

- **v1** — `POST /api/vectorize` (defined inline in `main.py`). Raw pass-through to the `vtracer` library with user-tunable trace parameters (colormode, mode, corner/length/splice thresholds, etc.).
- **v2** — `backend/app/v2/`, `POST /api/v2/vectorize`. A from-scratch pipeline that does NOT use vtracer for tracing: `preprocess.py` (resize/denoise/alpha-mask) → `color_reduce.py` (k-means posterization) → `regions.py` (connected-component extraction with holes) → `simplify.py` (Douglas-Peucker) → `bezier_fit.py` (curve fitting) → `svg_build.py` (path/document assembly). No tuning UI exists for it yet; params are hardcoded in `v2/params.py`.
- **v3** — `backend/app/v3/`, `POST /api/v3/vectorize`. A hybrid: reuses v2's `preprocess.py` + `color_reduce.py` to quantize the image, then hands the quantized PNG to vtracer for the actual region/contour/curve tracing (same tunable trace params as v1, see `v3/params.py`).

When changing preprocessing/color-reduction behavior, remember v2 and v3 share those modules (`app/v2/preprocess.py`, `app/v2/color_reduce.py`) — a change there affects both pipelines.

Each pipeline's params are a frozen dataclass (`VectorizeParamsV2`/`V3`) with defaults chosen to match vtracer's own effective defaults, so an un-tuned request behaves the same as before tuning existed.

### Frontend: SVG parsed into an editable layer list, rendered on WebGL

Flow in `pages/VectorizerPage.tsx` (the only page, parameterized by `apiEndpoint` for v1/v2/v3):

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
- Backend param dataclasses are frozen and versioned per pipeline (`VectorizeParamsV2`, `VectorizeParamsV3`) rather than shared/mutated, so tuning one pipeline can't silently affect another.
