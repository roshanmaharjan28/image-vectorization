# Hierarchical Path Grouping — Plan

## Context

Vectorized output today is a flat, unordered soup of `<path>` elements — each pipeline (v1/v2/v3) emits paths with no `id`, no semantic relationship between them, and no `<g>` structure. Once a complex image is vectorized into hundreds of paths, understanding "which paths make up this object" or editing/downloading just one visual object is impractical. This plan organizes paths into a hierarchy (groups, nested groups) that mirrors the visual structure of the image, without touching the existing flat-layer editing model the GPU renderer depends on.

This is a two-phase effort:
- **Phase 1** (this implementation): the backend computes a grouping hierarchy automatically, with two user-selectable engines — OpenCV heuristics, or FastSAM instance segmentation — and the frontend displays it as an expandable tree in the layers panel, with per-group SVG download. Ungrouped paths remain visible as ordinary layers.
- **Phase 2** (future follow-up): manual grouping/ungrouping controls in the frontend, layered on top of Phase 1's data model.

## Architecture overview

**Grouping applies to v1 and v3 only — v2 is out of scope.** v2 has no path forward here without threading its internal `Region` objects out to a grouping step.

**Segmentation happens *before* vectorization, not after.** The first implementation of this plan vectorized the whole image once, then tried to reconstruct group membership from the flat path list after the fact (bbox-adjacency + color-distance for OpenCV, majority-vote-over-sample-points for FastSAM). That proxy-matching was the weak link — thin/concave shapes could get mis-assigned, and FastSAM's real per-pixel masks were being discarded in favor of a handful of sample points. The revised design instead:
1. Segments the *source raster* into masks — OpenCV: color-quantize (reusing v2/v3's own `color_reduce.py`) then connected-component-label each color, so two same-colored but disjoint regions become two segments; FastSAM: run instance segmentation on the original image and use its masks directly.
2. Vectorizes each mask independently: everywhere outside the mask is forced fully transparent (the same alpha-exclusion vtracer already honors for v3's own `opaque_mask`), so every path vtracer produces for that call belongs to exactly that segment — no proxy needed, membership is exact by construction.
3. Merges the per-segment SVG outputs into one document in segment order, assigning a global `data-region-index` as it goes; a segment's own path indices become its group's leaves, and segments nest into each other by bbox containment (a segment fully enclosing another becomes its parent) — real containment now, since FastSAM/OpenCV masks are real regions rather than a bbox heuristic over already-traced paths.
4. Falls back to one plain, whole-image vectorize call (`groups: null`) whenever segmentation finds nothing to segment, produces a degenerate/too-fragmented mask count, or hits any error — grouping failure never blocks vectorization itself.

Both engines share this same segment → mask → per-segment-vectorize → merge → nest pipeline; only "how do I get the masks" (`opencv_segment.py` / `fastsam_segment.py`) differs. There is still no v1-specific or v3-specific grouping code — v1 and v3 differ only in *which* raster each engine ultimately vectorizes (v1: the raw uploaded image; v3: its own already-quantized raster, reused rather than recomputed) and which vtracer trace params they pass through.

The response shape is unchanged: `{"svg": <merged/annotated svg>, "groups": <forest> | null}` — additive, opt-in (`grouping=none` default, still a zero-cost no-op that never touches the grouping package), fully backward compatible. v2's response is untouched (no `grouping` param, no `groups` key, no behavior change).

**Frontend**: the grouping engine (None/OpenCV/FastSAM) is a user-facing selectable control, shown only for the v1/v3 tabs (mirroring where `ParamsPanel` already appears today), sent as a form field on the vectorize request. `Layer[]` stays exactly as-is (the GPU pipeline's index-addressed render/serialize substrate is untouched). A new, separate `groupTree` forest is layered on top purely for the panel UI: a projection function flattens `(groupTree, layers, collapsedGroupIds)` into virtualized rows, with groups rendered as expandable headers. When `groups` is absent (grouping off, or the v2 tab, which never sends it), the projection degrades to today's exact flat list — zero behavior change for existing usage.

## Schema (canonical — used identically by backend response and frontend types)

```ts
type TreeNode =
  | { type: 'leaf'; index: number }                                   // index into path/Layer document order
  | { type: 'group'; id: string; label: string | null; children: TreeNode[] };
```

- `groups: TreeNode[] | null` on the vectorize response. `null` = grouping not requested. `[]` = engine ran, found nothing groupable.
- A path index absent from every node in the forest is **implicitly ungrouped** — it still exists as a normal path/layer.
- Every `group.id` is globally unique across the whole forest (one counter shared by both engines and every nesting call).
- Invariant enforced server-side (and defensively re-checked client-side): no leaf `index` appears more than once anywhere in the forest.

## Backend

### Package `backend/app/grouping/`
- `schema.py` — `PathInfo{index, fill, bbox}`, `LeafRef`/`GroupNode`/`TreeNode`, `serialize_groups()`.
- `svg_annotate.py` — low-level regex primitives: `extract_path_tags`, `extract_svg_open_tag`, `parse_attrs`, `extract_fill` (mirroring `svgParse.ts`'s fallback), `bbox_from_path_d`, `insert_region_index`.
- `svg_merge.py` — `merge_segments(width, height, segment_svgs) -> (merged_svg, path_infos, segment_ranges)`: concatenates each segment's own vtracer output in order, assigning one global `data-region-index` per path; `segment_ranges[i]` is exactly segment i's group membership.
- `imageutil.py` — `encode_rgba_png`, `mask_bbox`, `resize_label_map` (nearest-neighbor, signed-label-safe).
- `masked_vectorize.py` — `vectorize_masked(rgba, mask, vtracer_kwargs)`: zeroes alpha outside `mask`, calls vtracer once.
- `opencv_segment.py` — `segment_masks(label_map)`: connected-component mask per color label.
- `fastsam_segment.py` — `segment_masks(image_bgr)`: lazy-imports `ultralytics.FastSAM`, returns its instance masks directly; raises `GroupingUnavailableError` if `ultralytics` isn't installed.
- `containment.py` — `SegmentSpan{bbox, leaf_indices}`, `build_segment_forest(spans, params, ids)` (bbox-containment nesting over *segments*, dissolving an empty segment with exactly one nested child instead of wrapping it), plus the shared `IdAllocator` for globally-unique group ids.
- `segmented_pipeline.py` — `build_grouped_svg(image_bytes, grouping, vtracer_kwargs, quantized_source=None)`: the one function both engines and both pipelines route through — decode → get masks → vectorize each mask → merge → nest → validate; returns `None` (caller falls back to a plain vectorize) when there's nothing to segment, too many segments (`MAX_SEGMENTS` cap), or any error.
- `validate.py` — `validate_tree(groups, total_paths)`: no duplicate/out-of-range leaves, no empty groups.
- `router_support.py` — `finalize_vectorize_response(image_bytes, grouping, vtracer_kwargs, plain_vectorize, quantized_source_provider=None)`: the one shared call site both v1 and v3 routers use; maps `GroupingUnavailableError` to HTTP 501.

### Router wiring (v1 and v3 only — v2 untouched)
- Both `backend/app/main.py`'s `vectorize` (v1) and `backend/app/v3/router.py`'s `vectorize_v3` add `grouping: Literal["none","opencv","fastsam"] = Form("none")`, build their own `vtracer_kwargs` dict and a `plain_vectorize()` closure (their pre-existing single-call vectorize path, untouched), and call `finalize_vectorize_response(...)`. v3 additionally passes a `quantized_source_provider()` closure so a grouped request reuses its own already-quantized raster/label-map instead of quantizing twice; v1 has none (it quantizes a disposable copy internally, only when `grouping="opencv"`, purely to derive regions — the raster it actually vectorizes is always the raw upload).
- `backend/app/v2/router.py` / `v2/pipeline.py` are not touched.

### Dependencies
- OpenCV engine needs nothing new (`opencv-python-headless`/`numpy` already present).
- FastSAM engine needs `ultralytics` (pulls in `torch`) — kept in a separate `backend/requirements-fastsam.txt`, imported lazily so the base app never requires it. Missing it at request time returns HTTP 501, not a crash.

## Frontend

- `types.ts` — canonical `TreeNode`/`LeafRef`/`GroupNode` types matching the backend schema exactly.
- `lib/groupTree.ts` — `PanelRow` union + `buildPanelRows(tree, layers, collapsedGroupIds)`, which degrades to today's exact flat list when `tree === null`.
- `VectorizerPage.tsx` — new `groupTree`/`collapsedGroupIds`/`grouping` state; a grouping-engine selector shown alongside `ParamsPanel` (i.e. hidden for v2); batch `handleSetVisibleMany`/`handleDeleteMany`/`handleDownloadGroup` handlers.
- `LayersPanel.tsx` — swaps its flat layer list for `buildPanelRows(...)`, generalizes selection to per-row id sets, renders group headers.
- New `GroupRow.tsx` — expand/collapse chevron, cascading eye/download/trash actions.
- `LayerRow.tsx` — adds a `depth` prop for indentation.

## Phase 2 (not built now) — manual grouping UI

`TreeNode`/`groupTree` carries no UI state (collapse/depth/leafIds are derived, never stored), so Phase 2 is purely additive: a "Group selection" action wrapping selected ids in a new `GroupNode`, and an "Ungroup" action dissolving a group's children into its parent — both pure `TreeNode[] -> TreeNode[]` functions feeding `setGroupTree`, reusing Phase 1's batch visibility/delete setters.

## Verification

- Backend: `backend/tests/grouping/` pytest suite; manual calls to `/api/vectorize` and `/api/v3/vectorize` with `grouping=opencv`/`fastsam`, confirming `groups` is present and non-duplicated, and `/api/v2/vectorize` is unaffected.
- Frontend: `npm run build` and `npm run lint`; manually vectorize with each grouping mode and confirm groups render correctly, cascade correctly, and download correctly, with `grouping=none` matching today's behavior exactly.
