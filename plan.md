# Image-to-Vector Prototype (Vtracer)

## Context

The goal is a small Illustrator/Figma-like prototype: a user uploads a raster image, it's displayed on a canvas/artboard, a "Vectorize" action converts it to SVG via Vtracer, and the resulting SVG paths are broken out as individual "layers" in a right-hand sidebar (with per-layer hide/unhide and delete). This is a greenfield project — the working directory (`E:\Code\hivecraft\image-vectorization`) is currently empty, so this plan defines the full initial structure.

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