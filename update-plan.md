# Add a v2 Vectorization Pipeline (Illustrator-style Image Trace)

## Context

The current pipeline (`/api/vectorize`) is a thin wrapper around the `vtracer` binary — it works, but it's a black box: no visibility into or control over how colors are reduced, regions are detected, or curves are fit. The user wants a second, from-scratch pipeline that mirrors Adobe Illustrator's "Image Trace" stages (preprocess → color reduction → region detection → contour extraction → path simplification → bezier fitting → SVG assembly), giving a controllable, inspectable alternative built with standard, well-understood algorithms rather than an opaque Rust binary.

This must be additive: v1 (`/api/vectorize`) keeps working exactly as-is. v2 lives at its own backend route and its own frontend URL, so both can be compared side by side. Confirmed with the user:
- Backend: new route, v1 untouched.
- Frontend: real URL routes `/v1` and `/v2` (adding `react-router-dom`), not just an in-app toggle.
- v2 UI shows only the final vectorized SVG (same layer-sidebar UX as v1) — no intermediate-stage debug view in this pass.

## Backend: `backend/app/v2/` pipeline

New self-contained subpackage, fully decoupled from `vtracer` (no shared imports), mounted at `/api/v2/vectorize` via a new `APIRouter` included from `main.py`. `main.py`'s existing `/api/vectorize` and `/api/health` routes are not modified — only one new line is added (`app.include_router(v2_router, prefix="/api/v2")`) plus the import.

```
backend/app/v2/
  __init__.py
  params.py       # VectorizeParamsV2 frozen dataclass — all tunable defaults in one place
  preprocess.py    # stage 1: PIL decode -> RGBA, resize (down for huge / up for tiny), alpha mask, blur
  color_reduce.py   # stage 2: Lab-space cv2.kmeans quantization -> (label_map, palette)
  regions.py        # stage 3+4: per-color connected components + cv2.findContours(RETR_CCOMP) for outer+hole contours
  simplify.py       # stage 5: cv2.approxPolyDP (Douglas-Peucker), epsilon scaled by contour perimeter
  bezier_fit.py     # stage 6: vendored pure-numpy Schneider cubic-bezier fit (closed-loop variant)
  svg_build.py      # stage 7: bezier segments -> path "d" string -> full <svg> document
  pipeline.py       # orchestrates all 7 stages, rescales coords back to original image size
  router.py         # POST /vectorize -> {"svg": svg}, same 400/500 error contract as v1
```

Key design decisions:
- **Color reduction**: `cv2.kmeans` in Lab color space (perceptually meaningful clustering vs. raw RGB). `effective_k = min(n_colors, num_unique_colors)` guards the degenerate case where the image has fewer distinct colors than requested clusters; near-duplicate palette entries are merged post-clustering.
- **Region/contour extraction**: `cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)` per palette color — `RETR_CCOMP`'s 2-level hierarchy gives outer boundary + holes for free, and a same-colored "island" inside a hole is automatically re-emitted as its own top-level contour (its own region/path), with no special-case code needed. Dense (`CHAIN_APPROX_NONE`) boundaries are used so Douglas-Peucker (stage 5) does the one real simplification pass, rather than compounding with OpenCV's own lossy `CHAIN_APPROX_SIMPLE`.
- **Bezier fitting**: vendored, pure-numpy port of Schneider's piecewise cubic-fitting algorithm (Graphics Gems 1990 — the same algorithm behind Potrace/Inkscape curve fitting), adapted for closed loops. Chosen over the `bezier` PyPI package (that's for curve algebra, not fitting, and some releases need a compiled `libbezier`) and over `scipy.interpolate.splprep` (B-splines, not cubic Bezier control points, and pulls in scipy for one call). Pure Python/numpy means zero Windows-wheel risk — consistent with why `vtracer` was chosen for v1 in the first place.
- **SVG assembly**: one `<path>` per top-level contour (region), `fill="#rrggbb"` + `fill-rule="evenodd"` (evenodd handles nested loops correctly regardless of OpenCV's winding direction, so there's no need to fix up winding order). This one-path-per-region output shape is already fully compatible with the frontend's existing `svgParse.ts`/`Layer` model — no frontend parsing changes needed.
- **Original-size contract**: internal resize (upscale tiny images for enough curve-fitting resolution, downscale huge images to bound k-means/contour cost) is rescaled back out before emitting the SVG, so `width`/`height`/`viewBox` always match the uploaded image's original dimensions, matching v1's contract.
- **Params**: `VectorizeParamsV2` dataclass with hardcoded defaults (`n_colors=12`, `blur_ksize=3`, `min_region_area_px=12`, `simplify_epsilon_frac=0.0025`, `bezier_max_error=2.0`, etc.) passed explicitly through the pipeline — no tuning UI now (matches v1's decision), but structured so a future tuning UI is a drop-in.
- **Edge cases handled**: fully transparent image → empty `<svg>` (no paths, no crash); single/near-single-color image → k-means skipped, flat fill; tiny images → upscaled before tracing; huge images → downscaled + k-means input subsampled; corrupt upload → `ValueError` → HTTP 400 (same contract as v1).

`requirements.txt` additions: `numpy`, `opencv-python-headless` (prebuilt Windows wheels, no GUI bindings needed on a server, covers blur/kmeans/contours/approxPolyDP in one dependency), `Pillow` (already present transitively via vtracer, but now imported directly by v2 code so it must be declared explicitly rather than relying on an indirect dependency).

## Frontend: `/v1` and `/v2` routes

- Add `react-router-dom` to `frontend/package.json`.
- Extract the current `App.tsx` state machine (stage, imageFile, meta, layers, hover/select, `handleVectorize` fetch logic, and the Toolbar/Canvas/LayersPanel layout) into `frontend/src/pages/VectorizerPage.tsx`, parameterized by a single new prop: `apiEndpoint: string` (e.g. `/api/vectorize` vs `/api/v2/vectorize`). The `fetch` call changes from a hardcoded `` `${apiUrl}/api/vectorize` `` to `` `${apiUrl}${apiEndpoint}` ``. No other logic changes — `Toolbar`, `Canvas`, `LayersPanel`, `LayerRow`, `UploadDropzone` are reused unmodified since they're already pure/prop-driven.
- `App.tsx` becomes a thin router shell: wraps `<BrowserRouter>`, renders a small top nav bar (`Link`/`NavLink` to `/v1` and `/v2`, active-tab styling), and defines `<Routes>`: `/v1` → `<VectorizerPage apiEndpoint="/api/vectorize" />`, `/v2` → `<VectorizerPage apiEndpoint="/api/v2/vectorize" />`, `/` → redirect to `/v1`.
- No change needed to `vite.config.ts`'s dev proxy (`/api` → `localhost:8000` already prefix-matches `/api/v2/*`) or to `types.ts`/`svgParse.ts`/`svgSerialize.ts` (v2's SVG output shape matches what they already expect).

## Docs

Update `plan.md` in the repo root to document the v2 pipeline architecture (mirroring this plan's backend/frontend sections) alongside the existing v1 documentation, so the file stays the single source of truth for the project's architecture.

## Verification

1. Backend: `cd backend`, `./venv/Scripts/pip install -r requirements.txt` (installs numpy/opencv-python-headless/Pillow), start `uvicorn app.main:app --reload --port 8000`, confirm no import errors and `/api/health` still responds.
2. `POST /api/v2/vectorize` with a sample PNG/JPG (via curl or the frontend) — confirm `{"svg": "..."}` comes back, contains one or more `<path fill="#..." fill-rule="evenodd" d="...">` elements, and the root `<svg>` `width`/`height` match the source image.
3. Confirm `/api/vectorize` (v1) still behaves identically (unchanged code path) — regression check.
4. Frontend: `npm install` (pulls in `react-router-dom`), `npm run dev`. Visit `/v1` — confirm it behaves exactly like the current app (upload → vectorize → layers sidebar → download). Visit `/v2` — same golden-path flow, hitting the new endpoint, with the OpenCV/Bezier-based output populating the same layer sidebar.
5. Edge cases against v2: a solid-color image, a tiny (e.g. 32x32) image, an image with transparency, and a large (e.g. 4000px) image — confirm no crashes and reasonable output/timing for each.