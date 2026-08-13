# Image-to-Vector Prototype (Vtracer + Custom Pipeline + Hybrid)

## Context

The goal is a small Illustrator/Figma-like prototype: a user uploads a raster image, it's displayed on a canvas/artboard, a "Vectorize" action converts it to SVG, and the resulting SVG paths are broken out as individual "layers" in a right-hand sidebar (with per-layer hide/unhide and delete). This is a greenfield project — the working directory (`E:\Code\hivecraft\image-vectorization`) started empty, so the original plan below (v1) defines the initial structure built around the `vtracer` package.

A second pipeline (v2, documented below) was added afterward: a from-scratch, Illustrator "Image Trace"-style pipeline (preprocess → color reduction → region detection → contour extraction → path simplification → bezier fitting → SVG assembly) built with OpenCV and a vendored pure-numpy bezier fitter, instead of the opaque `vtracer` binary.

A third pipeline (v3, documented near the bottom of this file) combines the best of both: v2's controllable preprocessing and color-reduction stages (denoise + posterize) clean up the raster first, then the quantized image is handed to `vtracer` for the actual region/contour/curve-fitting work, instead of v2's custom bezier fitter.

v1, v2, and v3 are all live side by side — v1 at `/api/vectorize` + frontend route `/v1`, v2 at `/api/v2/vectorize` + frontend route `/v2`, v3 at `/api/v3/vectorize` + frontend route `/v3` — so they can be compared directly. v1's and v2's code and behavior are unchanged by the v3 addition.

Decisions confirmed with the user:
- **Backend**: Python + FastAPI, using the `vtracer` PyPI package (wraps the compiled Rust binary — no manual Rust toolchain needed). Environment check confirmed Python 3.12 is available via the `py` launcher, which has prebuilt `vtracer` wheels.
- **Frontend**: React + Vite + TypeScript (fast dev loop, no extra framework weight for a prototype).
- **Layer model**: one layer per SVG `<path>` element, in the order Vtracer emits them (matches raw output, no extra grouping logic).
- **Layer actions for v1**: hide/unhide and delete only. No drag-to-reorder.

## Architecture

```
image-vectorization/
  backend/
    app/
      main.py            # FastAPI app + /api/vectorize route
    requirements.txt      # fastapi, uvicorn[standard], python-multipart, vtracer
  frontend/
    src/
      App.tsx             # top-level layout & state (image, layers, stage)
      components/
        UploadDropzone.tsx
        Toolbar.tsx
        Canvas.tsx
        LayersPanel.tsx
        LayerRow.tsx
      lib/
        svgParse.ts        # SVG string -> {meta, layers[]}
        svgSerialize.ts     # {meta, layers[]} -> SVG string (for canvas + export)
      types.ts
    vite.config.ts          # dev proxy: /api -> http://localhost:8000
    package.json
```

Flow: image upload (frontend, in-memory) → click "Vectorize" → POST the image file to FastAPI `/api/vectorize` → backend calls `vtracer.convert_raw_image_to_svg(bytes, img_format=...)` → returns SVG string → frontend parses it into a `layers[]` array (one per `<path>`) → canvas renders the composed SVG from visible layers → sidebar lists all layers with swatch/hide/delete.

## Backend (`backend/`)

- `requirements.txt`: `fastapi`, `uvicorn[standard]`, `python-multipart`, `vtracer`.
- `app/main.py`:
  - FastAPI app with CORS enabled for the Vite dev origin (`http://localhost:5173`).
  - `POST /api/vectorize`: accepts `UploadFile` (multipart field `image`), reads bytes, determines format from filename extension/content-type (png/jpg/jpeg/bmp/gif), calls `vtracer.convert_raw_image_to_svg(img_bytes, img_format=fmt)` with default parameters (no tuning UI in v1 — defaults are Vtracer's own preset), returns `{"svg": "<svg>...</svg>"}`.
  - Defined as a regular (sync) `def` route so FastAPI runs the CPU-bound conversion in its thread pool instead of blocking the event loop.
  - Wrap the conversion in try/except, returning HTTP 400 with an error message on unsupported format or conversion failure.

## Frontend (`frontend/`)

- Scaffold with `npm create vite@latest frontend -- --template react-ts`.
- **`types.ts`**: `Layer { id: string; d: string; fill: string; attrs: Record<string,string>; visible: boolean }`, `SvgMeta { width, height, viewBox }`.
- **`lib/svgParse.ts`**: `parseSvgToLayers(svgString): { meta: SvgMeta, layers: Layer[] }` — uses `DOMParser` to parse the SVG, reads `width`/`height`/`viewBox` off the root `<svg>`, iterates direct child shape elements (Vtracer emits `<path>`), extracts `d` and fill color (from the `fill` attribute or inline `style="fill:..."`), assigns a sequential id.
- **`lib/svgSerialize.ts`**: `buildSvgString(meta, layers): string` — serializes only `visible` layers back into a full `<svg>` string (used for the "Download SVG" export, so hidden layers are excluded from the export; deleted layers are already gone from the array).
- **`App.tsx`**: owns state — `stage: 'empty' | 'has-image' | 'vectorizing' | 'vectorized'`, `imageFile`, `imageUrl` (object URL for preview), `meta`, `layers`. Renders `UploadDropzone` when `stage === 'empty'`, otherwise `Toolbar` + `Canvas` + `LayersPanel` in a 3-pane layout (canvas center, sidebar right, toolbar top).
- **`components/UploadDropzone.tsx`**: click-to-browse and drag-and-drop image upload; validates it's an image file; sets `imageFile`/`imageUrl` and `stage = 'has-image'`.
- **`components/Toolbar.tsx`**: shows "Vectorize" button while `stage === 'has-image'` (disabled + spinner while `'vectorizing'`); shows "Download SVG" and "Upload new image" once `stage === 'vectorized'`.
- **`components/Canvas.tsx`**: artboard-style center pane (checkered background, image/SVG centered and scaled to fit). Before vectorization, renders the raw uploaded `<img>`. After vectorization, renders an inline `<svg>` built from the current visible layers (recomputed from `layers` state on every change, so hide/delete reflect immediately). Minimal pan/zoom: mouse wheel to scale, drag to pan (local component state, CSS transform) — no extra dependency needed.
- **`components/LayersPanel.tsx`** + **`LayerRow.tsx`**: right sidebar listing `layers` (reverse of draw order so the topmost/last-drawn path appears at the top of the list, matching Illustrator convention). Each row: color swatch (`fill`), index label, eye-icon toggle (flips `visible`), trash icon (removes the layer from the array). Panel shows a layer count and an empty state if all layers are deleted.
- **`vite.config.ts`**: dev server proxy `'/api'` → `http://localhost:8000` so the frontend can call `fetch('/api/vectorize', ...)` without CORS friction in dev.

## Verification

1. Backend: `cd backend`, create venv, `pip install -r requirements.txt`, `uvicorn app.main:app --reload --port 8000`. Confirm it starts without error (watch for `vtracer` import/wheel issues on Python 3.12).
2. Frontend: `cd frontend`, `npm install`, `npm run dev`. Open the printed local URL in the browser.
3. Manual pass through the golden path:
   - Upload a PNG/JPG — confirm it renders centered on the canvas.
   - Click "Vectorize" — confirm a loading state, then the canvas swaps to the rendered SVG and the sidebar populates with one row per traced path (count roughly matches the number of `<path>` elements returned by the backend — check via browser devtools network response).
   - Toggle a layer's visibility — confirm the shape disappears/reappears on the canvas.
   - Delete a layer — confirm it's removed from both the sidebar and the canvas.
   - Click "Download SVG" — confirm the downloaded file only contains currently-visible layers and opens correctly in a browser/image viewer.
   - Click "Upload new image" — confirm state resets cleanly to the empty upload screen.
4. Edge cases: upload a non-image file (rejected with a message), upload a large image (check conversion time / UI doesn't freeze), and simulate a backend error (e.g. stop the backend) to confirm the frontend shows an error instead of hanging.

## v2 Pipeline (Custom Illustrator-style Image Trace)

Additive, fully decoupled from `vtracer` — mounted at `POST /api/v2/vectorize`, same request/response contract as v1 (`{"image": <file>}` in, `{"svg": "<svg>...</svg>"}` out), so the frontend's existing `svgParse.ts`/`Layer` model needs no changes.

```
backend/app/v2/
  params.py       # VectorizeParamsV2 frozen dataclass — hardcoded defaults, no tuning UI yet
  preprocess.py    # stage 1: PIL decode -> RGBA, resize (down for huge / up for tiny), alpha mask, gaussian blur
  color_reduce.py   # stage 2: Lab-space cv2.kmeans color quantization -> (label_map, palette)
  regions.py        # stage 3+4: per-color connected components + cv2.findContours(RETR_CCOMP) for outer+hole contours
  simplify.py       # stage 5: cv2.approxPolyDP (Douglas-Peucker), epsilon scaled by contour perimeter
  bezier_fit.py     # stage 6: vendored pure-numpy Schneider cubic-bezier fit (Graphics Gems 1990), closed-loop variant
  svg_build.py      # stage 7: bezier segments -> path "d" string -> full <svg> document
  pipeline.py       # orchestrates all 7 stages, rescales fitted coordinates back to the original image's dimensions
  router.py         # POST /vectorize -> {"svg": svg}, same 400/500 error contract as v1
```

`main.py` wiring is a single addition: `app.include_router(v2_router, prefix="/api/v2")` — v1's `/api/vectorize` and `/api/health` are untouched.

Key design decisions:
- **Color reduction**: `cv2.kmeans` in Lab space (perceptually meaningful clustering vs. raw RGB/BGR). `effective_k = min(n_colors, num_unique_colors)` guards the case where the image has fewer distinct colors than requested clusters; near-duplicate palette centers are merged post-clustering (`palette_merge_distance`).
- **Regions/contours**: `cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)` per palette color. `RETR_CCOMP`'s 2-level hierarchy gives outer boundary + holes for free; a same-colored "island" inside a hole is automatically re-emitted as its own top-level contour (its own region/path) with no special-case code. Dense boundaries (`CHAIN_APPROX_NONE`) are used so Douglas-Peucker is the only real simplification pass.
- **Bezier fitting**: vendored pure-numpy port of Schneider's piecewise cubic-fitting algorithm (the same algorithm behind Potrace/Inkscape), adapted for closed loops via a central-difference tangent at the seam point. Chosen over the `bezier` PyPI package (curve algebra, not fitting, sometimes needs a compiled `libbezier`) and `scipy.interpolate.splprep` (B-splines, not cubic bezier control points, drags in scipy for one call). Zero Windows-wheel risk, consistent with why `vtracer` was chosen for v1.
- **SVG assembly**: one `<path>` per top-level contour/region, `fill="#rrggbb"` + `fill-rule="evenodd"` (handles nested outer/hole loops correctly regardless of OpenCV's winding direction).
- **Original-size contract**: internal resize is rescaled back out before emitting the SVG, so `width`/`height`/`viewBox` always match the uploaded image's original dimensions.
- **Params**: `VectorizeParamsV2` (`n_colors=12`, `blur_ksize=3`, `min_region_area_px=12`, `simplify_epsilon_frac=0.0025`, `bezier_max_error=2.0`, `alpha_threshold=16`, etc.) — hardcoded defaults, structured so a future tuning UI is a drop-in.
- **Edge cases handled**: fully transparent image → empty `<svg>` (no paths, no crash); single/near-single-color image → k-means skipped, flat fill; tiny images → upscaled before tracing; huge images → downscaled + k-means input subsampled; corrupt upload → `ValueError` → HTTP 400 (same contract as v1).

`requirements.txt` additions: `numpy`, `opencv-python-headless` (prebuilt Windows wheels, headless since this is a server with no GUI bindings needed; covers blur/kmeans/contours/approxPolyDP in one dependency), `Pillow` (was already present transitively via vtracer, now imported directly by v2 code so it's declared explicitly).

## v3 Pipeline (Hybrid: Custom Preprocess + vtracer Tracing)

Additive, mounted at `POST /api/v3/vectorize`, same request/response contract as v1/v2. Reuses v2's `preprocess()` and `reduce_colors()` directly (`from app.v2.preprocess import ...`, `from app.v2.color_reduce import ...`) rather than duplicating them — those two stages only depend on cv2/numpy/PIL, not on any of v2's bezier-fitting code, so importing them from v3 is plain reuse, not a layering violation.

```
backend/app/v3/
  params.py    # VectorizeParamsV3 — v2's preprocess/color-reduction fields + vtracer's tracing fields
  pipeline.py   # decode -> preprocess -> reduce_colors -> quantize -> re-encode PNG -> vtracer.convert_raw_image_to_svg
  router.py    # POST /vectorize -> {"svg": svg}, same 400/500 error contract as v1/v2
```

Flow: `decode_image()` and `preprocess()` (v2) denoise (Gaussian blur) and resize the image; `reduce_colors()` (v2) quantizes it to a small Lab-space palette (`label_map`, `palette`); `_apply_palette()` paints each pixel with its cluster's palette color, producing a flat-color raster instead of the smoothed-but-still-continuous-tone image v1 would otherwise trace; the opaque mask becomes the alpha channel; if preprocessing resized the image, it's scaled back to the original dimensions with `INTER_NEAREST` (keeps quantized edges hard, avoids re-introducing anti-aliased gradients); the result is re-encoded as a PNG in memory and handed to `vtracer.convert_raw_image_to_svg(..., img_format="png")`, which performs the actual region/contour/curve-fitting work — replacing v2's custom `regions.py`/`simplify.py`/`bezier_fit.py`/`svg_build.py` stages entirely.

Key design decisions:
- **Why quantize before vtracer**: `vtracer`'s own color reduction runs on the raw image; feeding it an already-flat, denoised, small-palette image typically yields cleaner region boundaries and fewer stray speckle paths than tracing the original directly (v1), while avoiding the need for a custom contour/bezier implementation (v2).
- **Always re-encode as PNG**: since the pipeline always produces a fresh in-memory raster (not the original upload bytes), it always hands vtracer `img_format="png"` — no need for v1's filename/content-type format sniffing (`_resolve_format`). Decoding the upload itself goes through v2's PIL-based `decode_image()`, which is more format-tolerant than extension sniffing.
- **`VectorizeParamsV3`**: duck-typed against v2's `preprocess()`/`reduce_colors()` (which only read specific attributes, not `VectorizeParamsV2` by type) — combines v2's preprocessing fields (`max_dimension`, `min_dimension`, `blur_ksize`, `n_colors`, `kmeans_sample_cap`, `alpha_threshold`, `palette_merge_distance`) with vtracer's tracing fields (`mode="spline"`, `filter_speckle`, `color_precision`, `layer_difference`, `corner_threshold`, `length_threshold`, `splice_threshold`).
- **Tuned for detail** (2026-08-13): defaults were pushed past both v1's and vtracer's own defaults to keep more visual fidelity — `max_dimension=2000` (was 1600, less downscale loss on large uploads), `n_colors=48` (was 32, finer color separation), `palette_merge_distance=4.0` (was 6.0, merges fewer near-duplicate colors), `filter_speckle=2` (was 4, keeps smaller regions instead of discarding them as noise), `layer_difference=10` (was 18, vs. vtracer's own default 16 — more stacking layers retained), plus three new vtracer fields set below their defaults for less path simplification: `corner_threshold=45` (default 60, more corners preserved instead of smoothed into curves), `length_threshold=3.5` (default 4.0, the minimum of vtracer's allowed `[3.5, 10]` range — least aggressive segment simplification), `splice_threshold=30` (default 45, finer spline segment splicing). `color_precision=8` (vtracer's max) is unchanged from the original v3 default. Tradeoff: more colors/layers/corners means more paths and larger SVGs, and lower `filter_speckle` means more small-artifact regions survive — this trades output size/cleanliness for fidelity.
- **No new dependencies**: v3 only reuses `numpy`/`opencv-python-headless`/`Pillow` (already added for v2) and `vtracer` (already present for v1) — no `requirements.txt` changes.
- **Edge cases handled**: same guarantees as v2's preprocessing (fully transparent → 0 paths, no crash; solid color → flat single-region output; tiny/huge images → resized then rescaled back) since v3 shares that code path; vtracer then traces whatever flat raster it's handed.

### v3 Verification

1. `POST /api/v3/vectorize` with a sample image — confirm `{"svg": "..."}` containing `vtracer`-generated `<path>` elements (identifiable by the `<!-- Generator: visioncortex VTracer ... -->` comment), with root `<svg>` `width`/`height` matching the source image's original dimensions.
2. Confirm `/api/vectorize` (v1) and `/api/v2/vectorize` (v2) are both unaffected (regression check).
3. Frontend: visit `/v3` — same UX as `/v1`/`/v2`, hitting the new endpoint, layers populate and hide/delete work identically.
4. Edge cases against v3: solid-color image, tiny (32×32) image, fully transparent image, and a large (4000×3000) image — confirmed no crashes; output `<svg>` dimensions matched the original in every case (e.g. large image scaled down for processing then correctly rescaled back to `4000×3000` before being handed to vtracer).

## Frontend Routing (v1 / v2 / v3)

`react-router-dom` was added so v1, v2, and v3 are real, bookmarkable URLs rather than an in-app toggle:

- **`frontend/src/pages/VectorizerPage.tsx`**: the original `App.tsx` state machine (stage, imageFile, meta, layers, hover/select, the `fetch`-based vectorize call, Toolbar/Canvas/LayersPanel layout), extracted as a component parameterized by a single new prop `apiEndpoint: string`. The fetch call became `` fetch(`${apiUrl}${apiEndpoint}`, ...) `` instead of a hardcoded path. `Toolbar`, `Canvas`, `LayersPanel`, `LayerRow`, `UploadDropzone` are reused unmodified — they were already pure/prop-driven.
- **`frontend/src/App.tsx`**: now a thin router shell — `BrowserRouter` + a small top nav bar (`NavLink`s to `/v1`, `/v2`, and `/v3` with active-tab styling) + `Routes`: `/v1` → `<VectorizerPage apiEndpoint="/api/vectorize" />`, `/v2` → `<VectorizerPage apiEndpoint="/api/v2/vectorize" />`, `/v3` → `<VectorizerPage apiEndpoint="/api/v3/vectorize" />`, `/` → redirect to `/v1`.
- `vite.config.ts`'s dev proxy (`/api` → `localhost:8000`) needed no changes — it prefix-matches `/api/v2/*` and `/api/v3/*` too.
- `App.css`: the old `.app` height rule (`100vh`) moved up to a new `.app-shell` wrapper (so the nav bar + page share the viewport height correctly); `.app` itself now takes `height: 100%` of its slot inside `.app-shell__body`. New `.version-nav*` classes style the nav bar.

### v2 Verification

1. `POST /api/v2/vectorize` with a sample image — confirm `{"svg": "..."}` with one or more `<path fill="#..." fill-rule="evenodd" d="...">` elements, and root `<svg>` `width`/`height` matching the source image.
2. Confirm `/api/vectorize` (v1) is unaffected (regression check).
3. Frontend: visit `/v1` (identical to the original app) and `/v2` (same UX, hitting the new endpoint).
4. Edge cases against v2: solid-color image, tiny (e.g. 32x32) image, fully transparent image, and a large (e.g. 4000px) image — confirm no crashes and reasonable output/timing.