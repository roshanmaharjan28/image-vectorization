# Implementation: v1 and v3

This documents how the v1 (`vtracer`) and v3 (preprocess + `vtracer`) pipelines are actually implemented in the current codebase — both the backend routes and the shared frontend (routing, state machine, params panel, and the WebGL canvas renderer). v2 (the custom OpenCV/bezier pipeline) is out of scope here except where v3 reuses its code directly.

For the original design rationale/decisions, see [plan.md](plan.md); this file describes the as-built code.

## Overview

Both pipelines share one contract: `POST` a multipart image (`image` field, plus tunable form fields) → backend returns `{"svg": "<svg>...</svg>"}` → frontend parses the SVG into a `Layer[]` array (one per `<path>`) → a WebGL canvas renders the composed result and a virtualized sidebar lists the layers with hide/delete.

| | v1 | v3 |
|---|---|---|
| Endpoint | `POST /api/vectorize` | `POST /api/v3/vectorize` |
| Frontend route | `/v1` | `/v3` |
| Backend logic | raw `vtracer.convert_raw_image_to_svg` call on the uploaded bytes | v2's denoise/resize + Lab-space color quantization first, then hands a flat-color re-encoded PNG to `vtracer` |
| Tunable params | vtracer tracing params only | same vtracer tracing params (preprocessing params are hardcoded, not yet exposed in the UI) |

## Backend

### v1 — [`backend/app/main.py`](backend/app/main.py)

`POST /api/vectorize` is defined directly on the FastAPI app (not a sub-router):

- Accepts `image: UploadFile` plus 9 `Form(...)` fields mirroring `vtracer`'s tuning knobs: `colormode`, `hierarchical`, `mode`, `filter_speckle`, `color_precision`, `layer_difference`, `corner_threshold`, `length_threshold`, `splice_threshold` — each with the same default/range as vtracer's own defaults (e.g. `hierarchical` defaults to `"cutout"`, `layer_difference` to `12`), so an unmodified request behaves exactly as the original hardcoded call did before tuning was added.
- `_resolve_format()` determines the image format vtracer needs from the filename extension, falling back to the multipart `content_type`; supports png/jpg/jpeg/bmp/gif. Raises `HTTPException(400)` if neither resolves to a supported format.
- Reads the raw bytes, rejects empty uploads with 400.
- Calls `vtracer.convert_raw_image_to_svg(img_bytes, img_format=fmt, colormode=..., hierarchical=..., mode=..., filter_speckle=..., color_precision=..., layer_difference=..., corner_threshold=..., length_threshold=..., splice_threshold=...)`.
- Any exception during conversion → `HTTPException(500)`.
- Defined as a sync `def` route (not `async def`) so FastAPI runs the CPU-bound Rust call in its thread pool instead of blocking the event loop.
- CORS origins come from the `CORS_ORIGINS` env var (comma-separated, loaded via `python-dotenv`), defaulting to `http://localhost:5173`.
- `main.py` also mounts the v2 and v3 routers (`app.include_router(v2_router, prefix="/api/v2")`, same for v3) and a plain `GET /api/health`.

### v3 — [`backend/app/v3/`](backend/app/v3)

```
backend/app/v3/
  params.py    # VectorizeParamsV3 — v2's preprocess/color-reduction fields + vtracer's tracing fields
  pipeline.py  # decode -> preprocess -> reduce_colors -> quantize -> re-encode PNG -> vtracer
  router.py    # POST /vectorize -> {"svg": svg}, same error contract as v1
```

**[`params.py`](backend/app/v3/params.py)** — `VectorizeParamsV3` frozen dataclass, duck-typed against v2's `preprocess()`/`reduce_colors()` (they only read specific attributes, not the `VectorizeParamsV2` type):
- Preprocessing fields (hardcoded, not exposed in the UI yet): `max_dimension=2000`, `min_dimension=64`, `blur_ksize=3`, `n_colors=64`, `kmeans_sample_cap=20000`, `alpha_threshold=16`, `palette_merge_distance=4.0`.
- vtracer tracing fields (user-tunable from the frontend params panel): `colormode="color"`, `mode="spline"`, `hierarchical="stacked"`, `filter_speckle=2`, `color_precision=8`, `layer_difference=10`, `corner_threshold=45`, `length_threshold=3.5`, `splice_threshold=30`.

**[`pipeline.py`](backend/app/v3/pipeline.py)** — `vectorize_image_v3(raw, params)`:
1. `decode_image()` (from `app.v2.preprocess`) decodes the upload to RGBA — more format-tolerant than v1's extension sniffing.
2. `preprocess()` (from `app.v2.preprocess`) denoises (Gaussian blur) and resizes (down for huge, up for tiny), returning `(bgr, opaque_mask, scale)`.
3. `reduce_colors()` (from `app.v2.color_reduce`) runs Lab-space k-means quantization, returning `(label_map, palette)`.
4. `_apply_palette()` paints every pixel with its cluster's palette color, producing a flat-color raster instead of the smoothed-but-continuous-tone image v1 would otherwise trace.
5. The opaque mask becomes the alpha channel.
6. If preprocessing resized the image, both the quantized image and alpha are scaled back to the *original* dimensions with `cv2.INTER_NEAREST` (keeps quantized edges hard, avoids re-introducing anti-aliased gradients).
7. Re-encoded as an in-memory PNG (`_encode_png`, via Pillow).
8. Handed to `vtracer.convert_raw_image_to_svg(png_bytes, img_format="png", colormode=..., mode=..., hierarchical=..., filter_speckle=..., color_precision=..., layer_difference=..., corner_threshold=..., length_threshold=..., splice_threshold=...)`, which performs the actual region/contour/curve-fitting — replacing v2's custom bezier-fitting stages entirely.

Since v3 always produces a fresh in-memory raster, it always hands vtracer `img_format="png"` — no filename/content-type sniffing needed.

**[`router.py`](backend/app/v3/router.py)** — `POST /vectorize` (mounted at `/api/v3/vectorize`): same 9 vtracer `Form(...)` fields as v1 (defaults sourced from `VectorizeParamsV3`), validates the upload is png/jpg/jpeg via `_validate_image_format`, rejects empty uploads with 400, builds a `VectorizeParamsV3` from the request, calls `vectorize_image_v3`. `ValueError` → 400, any other exception → 500 — same error contract as v1.

No new dependencies beyond what v1 (`vtracer`) and v2 (`numpy`, `opencv-python-headless`, `Pillow`) already require — see [`requirements.txt`](backend/requirements.txt).

## Frontend

### Routing — [`App.tsx`](frontend/src/App.tsx)

Thin router shell: `BrowserRouter` + a top nav bar (`NavLink`s) + `Routes`:
- `/v1` → `<VectorizerPage apiEndpoint="/api/vectorize" />`
- `/v2` → `<VectorizerPage apiEndpoint="/api/v2/vectorize" />` (nav link currently commented out, route still reachable directly)
- `/v3` → `<VectorizerPage apiEndpoint="/api/v3/vectorize" />`
- `/` → redirect to `/v1`

### Page state machine — [`pages/VectorizerPage.tsx`](frontend/src/pages/VectorizerPage.tsx)

One component drives all versions, parameterized by `apiEndpoint`:
- `showParams = !apiEndpoint.includes('/v2/')` — v1 and v3 both expose the vtracer tuning panel; v2 doesn't (it has no vtracer call).
- `isV3 = apiEndpoint.includes('/v3/')` — picks the initial params (`DEFAULT_V3_PARAMS` vs `DEFAULT_V1_PARAMS`, see below).
- `stage: 'empty' | 'has-image' | 'vectorizing' | 'vectorized'` drives which UI renders.
- `handleVectorize()`: builds a `FormData` with the image plus (if `showParams`) the tuning fields via `appendVectorizeParams`, `fetch`es `${VITE_API_URL}${apiEndpoint}`, parses the returned SVG with `parseSvgToLayers`, sets `meta`/`layers`/`stage`. Errors are caught and surfaced as a toast, dropping `stage` back to `'has-image'`.
- **Soft-delete**: `handleDeleteLayer` sets `{ visible: false, deleted: true }` instead of removing the array element — exactly as cheap as a visibility toggle and never forces the canvas to rebuild its geometry (see `sceneGeometry` memo below, keyed on layer *set* identity, not per-toggle state).
- `showOriginal` / `showPaths` are mutually-exclusive canvas overlay toggles (Adobe Image Trace "Preview" and Illustrator "Outline" view, respectively) — toggling one clears the other.
- `handleDownload()` serializes only visible+non-deleted layers via `buildSvgString` and triggers a client-side blob download.

### Params — [`types.ts`](frontend/src/types.ts), [`lib/vectorizeParams.ts`](frontend/src/lib/vectorizeParams.ts), [`components/ParamsPanel.tsx`](frontend/src/components/ParamsPanel.tsx)

`VectorizeParams` covers the 9 vtracer-facing fields shared by v1 and v3 (preprocessing fields aren't exposed yet, since there's no UI control for them). Two default sets:
- `DEFAULT_V3_PARAMS` mirrors `VectorizeParamsV3`'s Python defaults.
- `DEFAULT_V1_PARAMS` = `{ ...DEFAULT_V3_PARAMS, hierarchical: 'cutout', layerDifference: 12 }`, matching v1's original hardcoded call.

`appendVectorizeParams(formData, params)` appends all 9 fields as form fields with the exact names the backend `Form(...)` params expect (snake_case).

`ParamsPanel` renders two sections — **Clustering** (colormode B/W↔Color, hierarchical Cutout↔Stacked segmented controls, plus Filter Speckle / Color Precision / Gradient Step sliders) and **Curve Fitting** (mode Pixel/Polygon/Spline, plus Corner Threshold / Segment Length / Splice Threshold sliders) — and a "Re-vectorize" button that re-runs `handleVectorize` with the current panel values. Disabled while `stage === 'vectorizing'`.

### SVG → Layer parsing — [`lib/svgParse.ts`](frontend/src/lib/svgParse.ts) / [`lib/svgSerialize.ts`](frontend/src/lib/svgSerialize.ts)

`parseSvgToLayers` walks every `<path>` in the returned SVG (both v1 and v3 emit one `<path>` per vtracer region), capturing all attributes verbatim (`attrs`) plus a resolved `fill` (from the `fill` attribute or an inline `style="fill:..."`) and a sequential id. `buildSvgString`/`layerToPathMarkup` re-serialize a layer's original attributes unmodified (so the exported SVG round-trips vtracer's output exactly for surviving layers).

### Canvas rendering — [`components/CanvasGL.tsx`](frontend/src/components/CanvasGL.tsx)

The active renderer is a WebGL2 canvas (the older DOM/SVG renderer, `Canvas.tsx`, still exists in the tree but is commented out of `VectorizerPage.tsx` in favor of this one). Rationale and mechanics:

- **Geometry**: [`lib/sceneBuilder.ts`](frontend/src/lib/sceneBuilder.ts) triangulates every layer's path *once per vectorize* (memoized on `meta`, not on every layer mutation) into one shared VBO/IBO — a single `drawElements` call renders the whole scene regardless of layer count.
  - [`lib/pathFlatten.ts`](frontend/src/lib/pathFlatten.ts) flattens a path's `d` string into polygon contours by delegating curve math to the browser's own `SVGPathElement.getTotalLength`/`getPointAtLength` on a detached element (no hand-rolled bezier/arc math), sampling roughly every 4px (`SAMPLE_SPACING_PX`, clamped to 6–64 samples per subpath).
  - [`lib/svgTransform.ts`](frontend/src/lib/svgTransform.ts) parses each path's `transform` attribute (vtracer emits `translate(tx,ty)` on every path) into a 2×3 affine matrix and applies it to the flattened points — the DOM/SVG renderer gets this for free from the browser, but the GL path needs it applied manually.
  - [`lib/triangulateLayer.ts`](frontend/src/lib/triangulateLayer.ts) groups a path's raw subpath contours into outer/hole shapes by nesting-depth parity (resolving nonzero/evenodd fill regions from unordered subpaths) and triangulates each outer+holes group with `earcut`. Also returns the raw contours so `sceneBuilder` can build outline/stroke geometry (a thick-line quad per contour edge) without re-flattening.
- **Fill color / visibility**: a 1-texel-per-layer RGBA8 "palette" texture (`buildPalette`/`buildPaletteTexel` in `sceneBuilder.ts`) — alpha encodes visible(255)/hidden(0). Toggling a layer's visibility is an O(1) `texSubImage2D` write to one texel, not a geometry rebuild. Laid out as a width-capped 2D grid (not a single row) so layer counts beyond `MAX_TEXTURE_SIZE` don't silently fail to allocate.
- **Hover/select**: resolved via a GPU color-ID pick pass (`renderPick`/`pickAt`) — a separate framebuffer render where each fragment's color encodes `layerIndex + 1`, read back with a single-pixel `readPixels` on mouse move/click. The visible highlight is a separate outline draw pass (`OUTLINE_VERTEX_SHADER`/`OUTLINE_FRAGMENT_SHADER`) that extrudes each contour edge into a constant-screen-pixel-width quad (the GL analogue of `vector-effect:non-scaling-stroke`), discarding fragments that don't belong to the hovered/selected (or, right after a fresh vectorize, *any*) layer.
- **`showOriginal`**: overlays the original uploaded `<img>` on top of the same mounted canvas (doesn't unmount/remount the GL context).
- **`showPaths`**: clears to an opaque white background and draws only the outline pass for every layer in black, instead of the filled display pass — Illustrator's "Outline" view.
- **Pan/zoom**: a CSS `transform: scale()/translate()` on the artboard wrapper — the canvas rasterizes once per geometry/visibility change; panning/zooming never retriggers a GL render. The backing-store resolution does track zoom (debounced 120ms after the gesture settles, capped at 4× on top of device pixel ratio) so the raster doesn't go soft when CSS stretches it past 1×.
- Falls back to a "WebGL2 is not supported" message if `getContext('webgl2')` fails.

### Layers sidebar — [`components/LayersPanel.tsx`](frontend/src/components/LayersPanel.tsx) / [`components/LayerRow.tsx`](frontend/src/components/LayerRow.tsx)

Virtualized with `@tanstack/react-virtual` (`ROW_HEIGHT = 45`, `OVERSCAN = 6`) — only rows in the viewport mount, since mounting every row for a large layer count meant thousands of simultaneous thumbnail `getBBox()` calls (each a forced layout), which previously froze/crashed the tab on vectorize. Rows are listed in reverse draw order (topmost/last-drawn path first, matching Illustrator convention) with deleted layers filtered out. Each `LayerRow` renders a small inline `<svg>` thumbnail (its own path, auto-framed to the path's bounding box via `getBBox()`) plus visibility/delete buttons.

## Deployment / configuration

- **Backend env**: `CORS_ORIGINS` (comma-separated allowed origins) — see [`backend/.env.example`](backend/.env.example).
- **Frontend env**: `VITE_API_URL` — base URL for API calls; empty string uses the Vite dev proxy — see [`frontend/.env.example`](frontend/.env.example).
- **Dev proxy**: [`vite.config.ts`](frontend/vite.config.ts) proxies `/api` → `http://localhost:8000` (prefix-matches `/api/v2/*` and `/api/v3/*` too).
- **Vercel** ([`vercel.json`](frontend/vercel.json)): SPA rewrite (`/(.*)` → `/index.html`) so client-side routes like `/v1`/`/v3` resolve correctly on a hard refresh/direct link.

## Running locally

```bash
cd backend
py -m venv venv
./venv/Scripts/pip install -r requirements.txt
./venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend
npm install
npm run dev
```

Visit the printed local URL, then `/v1` or `/v3` to compare pipelines directly.
