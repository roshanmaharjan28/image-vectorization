# Hierarchical Path Grouping — Implementation Plan

## Context

Vectorized output today is a flat, unordered soup of `<path>` elements — each pipeline (v1/v2/v3) emits paths with no `id`, no semantic relationship between them, and no `<g>` structure. Once a complex image is vectorized into hundreds of paths, understanding "which paths make up this object" or editing/downloading just one visual object is impractical. The user wants paths organized into a hierarchy (groups, nested groups) that mirrors the visual structure of the image, without touching the existing flat-layer editing model that the GPU renderer depends on.

This is explicitly a two-phase effort:
- **Phase 1**: the backend computes a grouping hierarchy automatically (two selectable engines — OpenCV heuristics, or FastSAM instance segmentation), and the frontend displays it as an expandable tree in the layers panel, with per-group SVG download. Ungrouped paths remain visible as ordinary layers.
- **Phase 2**: manual grouping/ungrouping controls in the frontend, layered on top of Phase 1's data model.

Note on deliverable: executing this plan means (1) writing this content into a new repo file, `grouping-proposed-plan.md` at the repo root (matching — and replacing — the file of that name shown as deleted in `git status`; rename during review if a different name/location is preferred), and then (2) immediately building Phase 1 (backend grouping engines + frontend expandable-groups panel) as described below. Phase 2 (manual grouping UI) is deliberately not built in this pass — it's designed for, not implemented, so it can be picked up as its own follow-up.

## Architecture overview

**Grouping applies to v1 and v3 only — v2 is out of scope.** v2 has no path forward here without threading its internal `Region` objects out to a grouping step, which the user does not want built. v1 and v3 both ultimately hand off to vtracer and return an opaque SVG string with no Python-side path list, so **one shared implementation** works generically on the *final SVG string* and serves both pipelines identically — there is no v1-specific or v3-specific grouping code. It:
1. Annotates every `<path>` in the SVG with a stable `data-region-index="N"` attribute (document order) and extracts `{index, fill, bbox}` per path.
2. Runs whichever grouping engine the frontend selected over that path list to produce a **forest** (list of trees) where each node is either a bare leaf (a path index) or a group (with nested children — themselves leaves or groups).
3. Returns `{"svg": <annotated svg>, "groups": <forest> | null}` — additive, opt-in (`grouping=none` default), fully backward compatible. v2's response is untouched (no `grouping` param, no `groups` key, no behavior change).

**Frontend**: the grouping engine (None/OpenCV/FastSAM) is a **user-facing selectable control**, shown only for the v1/v3 tabs (mirroring where `ParamsPanel` already appears today), sent as a form field on the vectorize request. `Layer[]` stays exactly as-is (the GPU pipeline's index-addressed render/serialize substrate is untouched). A new, separate `groupTree` forest is layered on top purely for the panel UI: a projection function flattens `(groupTree, layers, collapsedGroupIds)` into virtualized rows, with groups rendered as expandable headers. When `groups` is absent (grouping off, or the v2 tab, which never sends it), the projection degrades to today's exact flat list — zero behavior change for existing usage.

## Schema (canonical — used identically by backend response and frontend types)

```ts
type TreeNode =
  | { type: 'leaf'; index: number }                                   // index into path/Layer document order
  | { type: 'group'; id: string; label: string | null; children: TreeNode[] };
```

- `groups: TreeNode[] | null` on the vectorize response. `null` = grouping not requested. `[]` = engine ran, found nothing groupable.
- A path index absent from every node in the forest is **implicitly ungrouped** — it still exists as a normal path/layer (satisfies "return layers which are not grouped too").
- **Every `group.id` must be globally unique across the whole forest** (single counter shared by both engines and every nesting call) — the frontend keys React rows and collapse-state (`collapsedGroupIds: Set<string>`) by this id; a collision would cause unrelated groups to collapse together.
- Invariant enforced server-side (and defensively re-checked client-side): no leaf `index` appears more than once anywhere in the forest.

## Backend plan

### New package `backend/app/grouping/`
- `schema.py` — `PathInfo{index, fill, bbox}`, `LeafRef`/`GroupNode`/`TreeNode`, `serialize_groups()`.
- `svg_annotate.py` — `annotate_and_extract(svg) -> (annotated_svg, list[PathInfo])`. Regex-splices `data-region-index="N"` onto each `<path ...>` tag in document order (safe because no pipeline emits nested markup inside a `<path>` or non-double-quoted attrs); extracts `fill` (mirrors `svgParse.ts`'s `extractFill` fallback logic exactly) and a control-point-envelope `bbox` parsed from the `d` attribute.
- `colorutil.py` — `color_distance(fill_a, fill_b)`, treating unparseable fills (named colors, `none`, gradients) as maximally distant so they never spuriously merge a component.
- `unionfind.py` — small disjoint-set + `components(n, edges)`.
- `containment.py` — `build_containment_forest(indices, bbox_of, params)`: each node's parent is the *smallest-area* bbox that contains it above an overlap/area-ratio threshold (strictly decreasing area along any chain ⇒ no cycles, and each index nests exactly once ⇒ no duplicates). Shared by both engines for nesting.
- `opencv_group.py` — `group(paths: list[PathInfo], params) -> list[TreeNode]`: builds an adjacency graph purely from bbox-gap distance (vs. a fraction of the SVG diagonal) plus a `color_distance <= threshold` filter (prevents a shared outline color from swallowing everything into one giant group), unions into connected components via `unionfind`, then nests each component (size ≥ 2) via `build_containment_forest`. Singleton components are left unwrapped (naturally satisfies "ungrouped paths coexist"). One implementation, no per-pipeline branching — v1 and v3 both hand it the same `PathInfo` shape extracted from their SVG string.
- `fastsam_group.py` — `group(paths, image_bgr, params)`: lazy `from ultralytics import FastSAM` **inside the function** (never at module import time, so choosing `opencv` never requires torch installed); runs FastSAM on the *original* raster to get instance masks; assigns each path to a mask by majority vote over 5 sample points (bbox center + quartiles — a pragmatic proxy since neither pipeline retains a true fill mask to rasterize); masks with ≥2 assigned paths become groups, nested via the same `build_containment_forest` (FastSAM masks are flat, so nesting is entirely delegated to the shared containment heuristic). Raises `GroupingUnavailableError` on `ImportError`.
- `validate.py` — `validate_tree(groups, total_paths)`: raises on any duplicate/out-of-range leaf index or empty group; does **not** require full coverage (ungrouped paths are expected).
- `service.py` — `build_groups(svg, grouping, *, image_bytes=None) -> (svg, groups|None)`: dispatches by mode; `"none"` is a zero-cost no-op (never even parses); on any algorithm exception, logs and degrades to `groups=None` while still returning the (harmless) annotated SVG — grouping failure must never break vectorization itself; `GroupingUnavailableError` propagates so the router can map it to HTTP 501. **This one function is the entire shared surface between v1 and v3** — neither pipeline gets its own copy of the dispatch/error-mapping logic.

### Router wiring (v1 and v3 only — v2 untouched)
- New tiny shared helper, `backend/app/grouping/router_support.py::finalize_vectorize_response(svg: str, grouping: str, image_bytes: bytes) -> dict`: calls `build_groups`, maps `GroupingUnavailableError` → `HTTPException(501, ...)`, returns `{"svg": svg, "groups": serialize_groups(groups)}`. **Both** [main.py](backend/app/main.py:46)'s `vectorize` (v1) and [v3/router.py](backend/app/v3/router.py)'s `vectorize_v3` add the same `grouping: Literal["none","opencv","fastsam"] = Form("none")` parameter and call this one helper after their existing `svg = ...` line — this is the "shared logic instead of duplicating" requirement satisfied concretely: the only per-router code is the one new `Form(...)` parameter declaration and a single call to `finalize_vectorize_response`.
- **[v2/router.py](backend/app/v2/router.py) and [v2/pipeline.py](backend/app/v2/pipeline.py) are not touched at all** — no `grouping` param, no `RegionShape`, no response change. v2's `/api/v2/vectorize` keeps returning exactly `{"svg": svg}` as it does today.
- FastSAM always runs on the original uploaded bytes (`image_bytes`), not any internally-quantized raster — irrelevant for v2 now that it's out of scope, but still true for v3.

### Dependencies
- `opencv-python-headless`/`numpy` already in [requirements.txt](backend/requirements.txt) — covers the opencv engine.
- New `backend/requirements-fastsam.txt` (`ultralytics`, pulling in `torch`) — optional install; base app runs and serves `grouping=opencv`/`none` with zero new dependencies. `grouping=fastsam` on a server without it installed returns a clear 501, not a crash.

### Tests (new `backend/tests/grouping/`, new `pytest` dep)
- `test_svg_annotate.py` — index/order/idempotency on synthetic SVG strings.
- `test_containment.py` / `test_unionfind.py` — nesting/component correctness on synthetic bbox fixtures.
- `test_invariants.py` — seeded-random `PathInfo` fixtures through `opencv_group.group`, asserting `validate_tree` passes across many seeds (regression net for "no duplicates").
- `test_router_integration.py` — `TestClient` hitting `/api/vectorize` (v1) and `/api/v3/vectorize` with `grouping=opencv` on a small generated fixture image; a `grouping=fastsam` test skipped via `pytest.importorskip("ultralytics")`, plus an always-run test asserting the 501 path when `ultralytics` is absent. A quick regression check that `/api/v2/vectorize` still returns exactly `{"svg": ...}` with no `groups` key and rejects an unexpected `grouping` form field the same way it always has (ignored, since v2's route signature never declares it).

## Frontend plan

### Types ([types.ts](frontend/src/types.ts))
Add the canonical `TreeNode`/`LeafRef`/`GroupNode` types (matching the backend schema exactly — `type`/`index`/`id`/`label`/`children`, no field-name translation needed).

### New `frontend/src/lib/groupTree.ts`
- `PanelRow = { kind: 'layer'; layer: Layer; depth: number; displayNumber: number } | { kind: 'group'; id: string; label: string; depth: number; expanded: boolean; leafIds: string[]; allVisible: boolean }`.
- `buildPanelRows(tree: TreeNode[] | null, layers: Layer[], collapsedGroupIds: Set<string>): PanelRow[]`, composed of:
  - `cleanAndSortTree` — resolves each leaf's `index` against `layers`, drops missing/deleted/duplicate-seen leaves (defensive re-check of the "no duplicates" invariant, independent of the backend's own guarantee), drops now-empty groups, computes each group's `leafIds` bottom-up (so nested subgroups' leaves flow to ancestors automatically — this is what makes group visibility/delete/download cascade correctly through nesting), and sorts every sibling list by descending "rank" (a leaf's rank is its array index; a group's rank is its topmost member's) — this is what reproduces the existing "top of list = topmost/last-painted" convention recursively at every depth.
  - A **top-level completeness pass**: any non-deleted layer index not covered by the forest is synthesized as a bare top-level leaf row — guarantees every layer appears exactly once regardless of what the backend did or didn't cover.
  - `flattenClean` — depth-first walk respecting `collapsedGroupIds`, emitting one `PanelRow` per visible node.
  - When `tree === null`, the whole function short-circuits to exactly today's `layers.filter(!deleted).reverse()` list — this is the backward-compatibility guarantee, made structural rather than incidental.

### [VectorizerPage.tsx](frontend/src/pages/VectorizerPage.tsx)
- New state: `groupTree: TreeNode[] | null`, `collapsedGroupIds: Set<string>`, `grouping: 'none' | 'opencv' | 'fastsam'` (new — the algorithm selector, defaults `'none'`).
- New control gated behind the existing `showParams` boolean ([VectorizerPage.tsx:31](frontend/src/pages/VectorizerPage.tsx:31)) — i.e. shown for v1/v3 exactly where `ParamsPanel` already shows, hidden for v2, matching backend scope exactly: a small segmented control (reusing the existing `SegmentedControl` pattern from [ParamsPanel.tsx](frontend/src/components/ParamsPanel.tsx:34)) offering None/OpenCV/FastSAM — **this is the user-facing selectable control** the two backend engines are wired up for. Rendered in `VectorizerPage.tsx` alongside `ParamsPanel`.
- `handleVectorize` ([VectorizerPage.tsx:62](frontend/src/pages/VectorizerPage.tsx:62)): `if (showParams) formData.append('grouping', grouping)` (mirroring the existing `if (showParams) appendVectorizeParams(...)` line — v2 requests never send it); widen the response type to `{ svg: string; groups?: TreeNode[] | null }`; after `setLayers(parsed.layers)`, call `setGroupTree(data.groups ?? null)` and reset `collapsedGroupIds`. For v2, `data.groups` is simply absent, so `groupTree` is always `null` and the panel behaves exactly as today.
- Reset `groupTree`/`collapsedGroupIds` everywhere `layers`/`meta` are already reset (`handleImageSelected`, `handleReset`).
- New handlers: `handleToggleGroupCollapsed(id)`; `handleSetVisibleMany(ids, visible)` and `handleDeleteMany(ids)` (batch versions of the existing per-layer setters, same `prev.map` shape — used by group-level eye/trash actions, and reusable unchanged by Phase 2's manual multi-select actions); `handleDownloadGroup(leafIds, label)` — filters `layers` down to `leafIds` and calls the *existing* `buildSvgString`/download-blob logic (factor the existing blob→anchor→click dance out of `handleDownload` into a tiny shared `downloadTextFile` helper in a new `frontend/src/lib/download.ts`, used by both).

### [LayersPanel.tsx](frontend/src/components/LayersPanel.tsx)
- Swap the current `orderedLayers` computation for `rows = buildPanelRows(groupTree, layers, collapsedGroupIds)`; virtualizer `count` becomes `rows.length`. Keep the header's total-layer badge computed independently from `layers` (not `rows.length`, so a collapsed group doesn't shrink the displayed total).
- Generalize click/shift-click/ctrl-click selection from "one layer id" to "the row's `idsForRow`" (a `layer` row → `[layer.id]`; a `group` row → its full `leafIds`) — shift-range selection sums `idsForRow` over the row range. This means **clicking a group row selects all its members**, which the existing multi-select drag/transform machinery in [useCanvasInteractions.ts](frontend/src/hooks/useCanvasInteractions.ts) already handles unchanged (no GPU/canvas changes needed).
- Render loop branches per row: existing `LayerRow` (now taking a `depth` prop for indentation) for `kind: 'layer'`; new `GroupRow` for `kind: 'group'`.

### New `frontend/src/components/GroupRow.tsx`
Same row height as `LayerRow` (virtualizer requires fixed-size rows) — chevron (expand/collapse), indented label, member-count badge, an eye icon reflecting `allVisible` (click cascades via `onSetVisibleMany`), a download icon (new, calls `onDownloadGroup`), and a trash icon (cascades via `onDeleteMany`).

### [LayerRow.tsx](frontend/src/components/LayerRow.tsx)
Minimal: add a `depth` prop driving left-padding indentation; no other behavior change — a leaf inside an expanded group keeps its normal single-layer click/select/recolor/delete behavior.

## Phase 2 (separate follow-up, not built now) — manual grouping UI

Design constraint already satisfied by Phase 1's data model: `TreeNode`/`groupTree` carries no UI state (collapse/depth/leafIds are all *derived*, never stored on the tree), so Phase 2 is purely additive:
- "Group selection" toolbar/context action (enabled when ≥2 layers or groups selected): extract the selected ids out of wherever they currently sit in `groupTree` (including out of other groups) and wrap them in a new `GroupNode` inserted at the position of the topmost selected item.
- "Ungroup" action on a group row: splice its children up into its parent's position (dissolve).
- Both operate as pure `TreeNode[] -> TreeNode[]` functions in `groupTree.ts`, feeding a plain `setGroupTree` — no other file needs to change. The batch visibility/delete setters from Phase 1 are reused as-is.
- Out of scope for Phase 2 per the user's own framing: drag-and-drop reordering between groups (natural future extension, not requested).

## Verification

- Backend: run the new `backend/tests/grouping/` suite (`pytest`), plus a manual `curl`/Swagger UI (`/docs`) call to `/api/vectorize` and `/api/v3/vectorize` with `grouping=opencv` on a sample image, confirming `groups` is present, non-duplicated, and the SVG's paths carry `data-region-index`. A `grouping=fastsam` call without `ultralytics` installed should return HTTP 501 with a clear message; with it installed (`pip install -r requirements-fastsam.txt`), confirm groups come back based on real instance masks. Also confirm `/api/v2/vectorize` still returns exactly `{"svg": ...}`, unaffected.
- Frontend: `npm run build` (tsc + vite) and `npm run lint` (oxlint) must pass. Manually vectorize an image with each grouping mode via the running dev server and confirm in-browser: groups render as expandable rows with correct indentation and no duplicate/missing layers (cross-check the fully-expanded row count against `layers.filter(!deleted).length`), group eye/trash cascade correctly through nested subgroups, "download group" produces a standalone SVG containing only that subtree, and `grouping=none` (today's default) renders byte-identical panel behavior to pre-change.