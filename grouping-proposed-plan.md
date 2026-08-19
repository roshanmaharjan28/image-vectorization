# Image Segmentation → Group Layers → Per-Group Export

## Context

Today every vectorized path becomes one flat `Layer` in the sidebar — no matter how complex the source image, the user scrolls a single long list. The ask is to make the layer panel show **groups** (derived from segmenting the source image into recognizable regions) that collapse/expand, so a user can visually navigate a complex vectorization by region instead of by individual path, and — critically — **export just one region's paths as its own standalone SVG** without manually hand-picking every layer that belongs to it.

Through clarifying questions, the following architecture decisions were made:

1. **Grouping basis: ML semantic segmentation** (not color-equality, not backend color-cluster reuse). Groups should reflect recognizable regions of the *source image*, not just "paths that happen to share a fill color."
2. **Pipeline scope: v1 and v3 only.** v2 (the from-scratch region/bezier pipeline) is explicitly out of scope.
3. **Manual control: Auto + manual editing.** Backend-computed groups are a starting point; users can also multi-select layers and Group/Ungroup/rename manually, like Illustrator/Figma.
4. **Export: one selected group → one standalone SVG file.** Not bulk-export-all-groups.

Two sub-plans below (backend, frontend) were designed in parallel by separate planning passes over the actual codebase; file paths and code are grounded in what exists today, not assumed.

---

## Backend: MobileSAM-based segmentation for v1 & v3

**Tool choice: MobileSAM**, not full SAM or FastSAM. Backend today (`backend/requirements.txt`) has zero ML dependencies (`fastapi`, `vtracer`, `numpy`, `opencv-python-headless`, `Pillow`) and runs CPU-only via `uvicorn --reload` on a Windows dev box. MobileSAM's TinyViT checkpoint (~40MB) and ~3s CPU inference keep grouping in the same latency ballpark as vtracer itself, versus full SAM's 375MB–2.4GB checkpoints and much slower CPU inference. It also exposes the same `SamAutomaticMaskGenerator`-style API as SAM, minimizing new code versus FastSAM's different YOLOv8/YOLACT-based pipeline. Both SAM and MobileSAM are Apache-2.0.

Note for the user: SAM-family masks are **class-agnostic regions**, not labeled object categories ("cat", "sky") — group labels will be generic (`"Group 1"`, `"Group 2"`, ordered by mask area), not semantic names, unless a classifier is added later (explicitly out of scope here).

### New shared module: `backend/app/segmentation.py`

Sibling to `app/v2/`, following the existing convention where `v3/pipeline.py` freely imports shared logic from `app/v2/` (e.g. `color_reduce.reduce_colors`).

```python
@dataclass(frozen=True)
class GroupingParams:
    enable_grouping: bool = True
    max_groups: int = 12
    min_mask_area_frac: float = 0.002
    overlap_iou_floor: float = 0.05
    timeout_s: float = 20.0

@dataclass(frozen=True)
class GroupingSummary:
    applied: bool
    reason: str | None
    groups: list[dict]  # [{"id": 0, "label": "Group 1", "path_count": 12}, ...]

def load_model_at_startup() -> None: ...   # called once from FastAPI lifespan
def is_available() -> bool: ...
def group_svg_paths(svg: str, rgb: np.ndarray, params: GroupingParams) -> tuple[str, GroupingSummary | None]: ...
```

**Sequencing — vectorize the whole image first, segment separately, assign paths to masks after. Considered and rejected the reverse (segment first, then vectorize each masked region separately with vtracer), for concrete reasons, not just convenience:**

- **Visual fidelity risk.** vtracer thresholds alpha to a hard binary mask at 128 (confirmed) and already produces clean transparent-background output — so masking a region and re-tracing it in isolation is *technically* possible. But a SAM mask boundary is a semantic boundary, not necessarily aligned to the actual color/edge boundary vtracer would trace if given the whole image at once. Cropping/masking before tracing risks visible seams or slivers at group boundaries — a regression versus today's output. Tracing the whole image once, unchanged, and deriving groups as a pure metadata overlay on top guarantees the rendered SVG stays pixel-identical to today's ungrouped output.
- **Loses whole-image z-order.** vtracer's `hierarchical="stacked"` mode relies on the *entire* image's painter's-algorithm ordering to decide how overlapping color regions stack. Tracing N masked regions independently and re-merging them loses that global ordering — there's no principled way to decide the merged inter-group stacking order from N independent single-region traces.
- **SAM's masks are naturally overlapping/hierarchical**, not a clean partition. Automatic mask generation returns objects *and* their parts simultaneously (e.g. "person" and "person's hat" — low IoU between them since the hat is small, so NMS doesn't collapse them), so cropping-and-tracing both would duplicate the hat's pixels into two separate traced groups. The per-path, post-hoc assignment approach below resolves this for free: each output *path* (not each raw mask) is assigned to whichever single mask it best matches by area, so a hat-shaped path naturally lands in the "hat" group even though the "person" mask also covers those pixels — no separate mask-deduplication/hierarchy-resolution pass needed.
- **Cost**: segment-first would require up to `max_groups + 1` vtracer calls (one per region, plus one for whatever no mask claims) instead of one, with real per-call fixed overhead.

Given all of this, vectorize-then-segment-then-assign is the safer and simpler architecture. The one legitimate optimization worth keeping: vtracer (Rust, releases the GIL) and MobileSAM (torch, releases the GIL during tensor ops) have no data dependency on each other's *input* — only the final assignment step needs both outputs — so they can run **concurrently** in two worker threads (e.g. `concurrent.futures.ThreadPoolExecutor(max_workers=2)`, `as_completed`/`.result()` on both) rather than strictly sequentially, trimming wall-clock latency by roughly the smaller of the two step durations. This is a scheduling detail, not an architecture change: the assignment step still only runs once both are done, and the fallback story (section 5) is unaffected — if segmentation fails while vtracer succeeds, the concurrently-obtained `svg` is still valid and gets returned as-is.

**Which image feeds the segmenter:**
- v1 (`app/main.py`): currently forwards raw bytes straight to vtracer without decoding. Add a decode step reusing `app.v2.preprocess.decode_image(raw)` (already a cross-package import elsewhere in the codebase, not a new precedent).
- v3 (`app/v3/pipeline.py`): use the **original** decoded `rgba` (already in scope near the top of `vectorize_image_v3`), not the posterized `quantized_bgr` — posterization destroys the color/edge detail SAM needs, and `rgba` is free (already computed).
- Coordinate spaces already line up: v3 resizes its quantized raster back to `(orig_w, orig_h)` before calling vtracer, and vtracer traces at input resolution — so in both pipelines the returned SVG's `viewBox` matches the same-resolution array fed to the segmenter. No scale bookkeeping needed.

**Mask-to-path assignment:**
- New helper (same module or `app/svg_raster.py`) flattens each vtracer path's `d` string (expected command set: `M`/`L`/`C`/`Z` only — confirm by inspecting real vtracer output before implementing; raise `NotImplementedError` loudly on anything else rather than silently mis-rasterizing) into polygons, then `cv2.fillPoly`s them into an HxW `{0,1}` buffer (no new rendering dependency; `opencv-python-headless` is already present).
- For each path: rasterize it, compute the fraction of *its own* area covered by each MobileSAM mask (denominator = path area, not IoU, so a small path nested in one big mask still assigns cleanly), assign to the best-covering mask, or to an "ungrouped" bucket (`id: -1`) if nothing clears `overlap_iou_floor`.
- Precompute mask bounding boxes and reject non-overlapping (path, mask) pairs before any pixel-level AND; do the whole computation at a downscaled working resolution (e.g. 512px long side — MobileSAM itself resizes internally to ~1024, so full-res buys nothing) for performance on images with hundreds of paths.

**Response schema — a JSON sidecar alongside the untouched SVG string, not inline `<g>` markup.** Considered wrapping each `<path>` in place with `<g data-group-id="N">` (rewriting via `xml.etree.ElementTree`), but rejected it in favor of returning the vtracer SVG completely unmodified plus a parallel `groups: [{id, label, path_indices}]` list, for concrete reasons:

- **Structurally cannot alter the rendered image.** Since the SVG string is passed through byte-for-byte, there is zero risk of a namespace-prefix bug, attribute-ordering quirk, or accidental reordering from an XML rewrite step — a stronger guarantee than "we wrapped carefully to preserve order," because there's no rewrite to get subtly wrong in the first place.
- **The staleness concern that would normally argue for inline markup doesn't apply here.** Index-based sidecar data only goes stale if something re-reads it *after* the client has reordered/filtered layers. That never happens: the frontend joins `path_indices` → `Layer.groupId` exactly once, immediately on parse, before any user edit. From that point on, everything (recolor, delete, reorder, export) operates on `Layer.groupId`, never on the sidecar's indices again.
- **Simpler backend implementation and lower risk surface** — no ElementTree tree-surgery code, no namespace registration, nothing that can produce malformed SVG.
- **One caveat worth flagging, low-probability but real:** this relies on the backend's path iteration order (used to build `path_indices` in `assign_paths_to_masks`, section 3b) matching the frontend's `querySelectorAll('path')` document order exactly. Both are standard document-order traversals of the same well-formed XML the backend itself produced, so this is low-risk — but the backend must derive `path_indices` from parsing the *same returned SVG string* it iterates for rasterization (not from some other intermediate representation), so there's one single source of truth for "path order" on the backend side.
- **Whether the user-facing exported SVG files contain visible `<g>` groups is a separate, frontend-side decision, independent of this backend↔frontend wire format** — see the frontend plan's note on `buildSvgString` below. Decoupling these means the backend doesn't need to solve "does an externally-opened SVG show its groups" at all.

Response shape (additive, doesn't break the existing `{"svg": str}` contract):
```json
{
  "svg": "<svg>...<path .../>...</svg>",
  "grouping": {
    "applied": true,
    "reason": null,
    "groups": [
      {"id": 0, "label": "Group 1", "path_indices": [0, 1, 4, 7]},
      {"id": -1, "label": "Ungrouped", "path_indices": [2, 3]}
    ]
  }
}
```

**New params, following the frozen-dataclass-params convention:**
- v3 (`app/v3/params.py`): add `grouping: GroupingParams = GroupingParams()` to `VectorizeParamsV3`.
- v3 router (`app/v3/router.py`): matching `Form(...)` args, construct `GroupingParams(...)` inline.
- v1 (`app/main.py`): has no umbrella dataclass today — add flat `Form(...)` grouping args directly to the route, same pattern minus an unrelated umbrella type.

**Fallback (must never turn a working vectorize call into an error):**
- `enable_grouping=False` → return `(svg, None)`, zero cost.
- Model unavailable (failed to load at startup) → return `(svg, GroupingSummary(applied=False, reason="model unavailable", groups=[]))` immediately, no attempt per-request.
- Otherwise run segment→assign→wrap inside try/except with a soft timeout via a 1-worker `ThreadPoolExecutor` + `.result(timeout=...)` (Windows has no `signal.alarm`; the abandoned thread finishes in the background on timeout — acceptable, documented tradeoff for a prototype). Any exception/timeout → log a warning, return the original `svg` unchanged with `applied=False`.
- Both route handlers additionally wrap the *call* to `group_svg_paths` in their own try/except (belt-and-suspenders) and always respond with `{"svg", "grouping"}`.

**Dependencies & packaging:**
- `requirements.txt`: add CPU-index `torch`/`torchvision` (`--index-url https://download.pytorch.org/whl/cpu`, **not** plain PyPI, which serves a multi-GB CUDA wheel on Windows) + MobileSAM (verify current install method at implementation time — historically `pip install git+https://github.com/ChaoningZhang/MobileSAM.git@<pinned-sha>`, prefer a proper PyPI release if one now exists).
- Checkpoint (`mobile_sam.pt`, ~40MB): download-on-first-run into `backend/.cache/models/` (add `.cache/` to `backend/.gitignore`), path overridable via `MOBILE_SAM_CHECKPOINT_PATH` env var (mirrors the existing `CORS_ORIGINS` env-var convention in `main.py`). Do not commit the checkpoint to git.
- Load the model once via a FastAPI `lifespan` context manager at startup, not per-request. `load_model_at_startup()` must catch its own failures (missing deps, failed download) and leave the model singleton `None` so `is_available()` returns `False` and every request takes the zero-cost fallback — the app must keep serving plain vectorization even on a machine that hasn't installed `torch` yet.

**Critical backend files:** `app/segmentation.py` (new), `app/main.py`, `app/v3/pipeline.py`, `app/v3/params.py`, `app/v3/router.py`, `requirements.txt`.

---

## Frontend: Group data model & layer-panel UI

### Data model (`frontend/src/types.ts`)

```ts
export interface Layer {
  id: string;
  fill: string;
  attrs: Record<string, string>;
  visible: boolean;
  deleted: boolean;
  transform: Mat2x3;
  groupId?: string;   // absent = ungrouped, rendered as a bare row exactly as today
}

export interface Group {
  id: string;
  label: string;
  expanded: boolean;
  deleted: boolean;   // soft-delete mirror, consistent with Layer.deleted
}
```

`groups: Group[]` becomes new state in `pages/VectorizerPage.tsx` alongside the existing `layers`/`meta` state (same ownership pattern). Confirmed **zero impact on the WebGL render path**: `lib/sceneBuilder.ts` and `hooks/useCanvasGLScene.ts` only ever index `Layer[]` by flat array position — an unused `groupId` field rides along untouched. **Never physically reorder `layers` for grouping** — paint order stays exactly as today; the panel's visual clustering is a display-only derived view.

### `LayersPanel` tree over the virtualized list

New pure module `frontend/src/lib/groupTree.ts` exporting `buildPanelRows(layers, groups): PanelRow[]`, where `PanelRow` is `{kind:'group-header', group, memberCount}` or `{kind:'layer', layer, groupId?}`. It walks layers in the existing top-first order, emits one header row the first time each live group is encountered, and — only if `group.expanded` — the group's member rows immediately after (gathered from wherever they sit in the underlying flat array, via one O(n) pre-pass bucketing by `groupId`). `LayersPanel.tsx` virtualizes `rows` instead of the raw layer list.

Key details to get right:
- **"Layer N" numbering and the total count badge must be computed from the pre-flatten layer ordering**, not row position — otherwise numbers shift once header rows are interspersed.
- Selection anchor (`lastSelectedIndexRef`) now indexes into `rows`.
- **Group header click** selects all living member ids (`'replace'`); **ctrl/cmd-click** on a header does a clean toggle only when all members are already selected, otherwise unions them in — avoids producing a confusing partial-selection state.
- **Shift-click ranges spanning a collapsed group** pull in that whole group's members for the one row-slot it occupies (a deliberate, confirmable decision — it means a range-select can silently reach members you can't currently see).
- **Clicking one member row inside an expanded group selects just that layer**, not the whole group (keeps today's per-layer recolor/hide/delete flow intact for grouped layers too). This differs from Illustrator/Figma's "click a member selects the group" convention — flagged as an assumption, easy to revisit later if it feels wrong in practice.

`LayerRow.tsx` gets one new optional `nested?: boolean` prop for indentation under an expanded group — no other structural change. New sibling component `frontend/src/components/GroupHeaderRow.tsx`: chevron · member count · editable label (double-click to rename) · Eye/EyeOff (whole-group visibility) · export icon · ungroup icon · delete icon — matching `LayerRow`'s existing icon density.

### Manual Group/Ungroup

- **"Group" button** in the `LayersPanel` header, enabled when `selectedLayerIds.length >= 2`.
- **Ungroup / rename / delete / export** live on each `GroupHeaderRow` directly (unambiguous — "ungroup this group" vs. an ambiguous "ungroup the selection" when a selection spans multiple groups).
- `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` shortcuts via a new global `keydown` listener in `VectorizerPage.tsx` (first of its kind in this app — genuinely new infra, not a reuse of existing patterns), guarded against firing while an `<input>`/rename field is focused.
- **Grouping a selection that already includes grouped layers:** those layers leave their old group and join the new one; if that empties an old group, it's soft-deleted in the same update so no empty header lingers. (Flagged as the natural default — confirm if a different merge behavior is wanted.)
- **Deleting a group** cascades `deleted:true, visible:false` to every member, consistent with the existing single-layer soft-delete convention. Symmetrically, **deleting the last living member of a group** (via the ordinary per-layer delete) must now also soft-delete that now-empty group — a small necessary edit to the existing `handleDeleteLayer`.
- Reset `groups` to `[]` alongside `layers`/`meta` wherever those are already reset (`handleImageSelected`, `handleReset`).
- New tiny helper `frontend/src/lib/groups.ts` with `createGroup(label)`, using an id namespace (`group-manual-N`) distinct from backend-supplied group ids so they can never collide.

### Expand/collapse

Reuse only the **visual convention** from `components/ui/accordion.tsx` (chevron icon swap, open/closed styling) on a plain button in `GroupHeaderRow` — not the `AccordionPrimitive.Root/Item/Panel` machinery itself, since that nests content as literal DOM children of the trigger, incompatible with `@tanstack/react-virtual`'s flat, absolutely-positioned virtual items. Collapse state is just `Group.expanded`, toggled via a plain setter, consumed by `groupTree.ts` to decide whether to emit member rows.

### Per-group export

No signature change needed to `lib/svgSerialize.ts`'s `buildSvgString(meta, layers)` — it already accepts an arbitrary layer subset and filters `visible && !deleted` internally. Add a thin wrapper:

```ts
export function buildGroupSvgString(meta: SvgMeta, layers: Layer[], groupId: string): string {
  return buildSvgString(meta, layers.filter((l) => l.groupId === groupId));
}
```

Keep the original full-canvas `SvgMeta` (width/height/viewBox) so the group's paths stay positioned exactly where they were relative to the whole image — cropping to the group's own bounding box is a possible future enhancement, not required now. Wire `handleExportGroup(groupId)` in `VectorizerPage.tsx` mirroring the existing `handleDownload`'s Blob → object URL → synthetic `<a download>` flow (worth factoring that dance into one small shared helper since it'll now have two call sites).

**Separate, optional enhancement worth doing while touching this code:** since the backend now returns a plain, ungrouped SVG (per the JSON-sidecar decision above), have `buildSvgString` (the *full*, whole-canvas "Download SVG" export only — not `buildGroupSvgString`, whose paths already all share one group by construction) wrap each path in a `<g id="group-N">` per group when `Layer.groupId` values are present. This is what makes the user-facing exported file itself show real group structure if reopened in Illustrator/Inkscape — a property worth having regardless of how the backend and frontend privately communicate grouping, and cleanly decoupled from that internal wire-format choice.

### `svgParse.ts` changes

Since the backend response no longer embeds any grouping markup in the SVG itself, group data flows through the JSON sidecar exclusively. Add one new entry point that wraps the existing parser:

```ts
export function parseSvgResponseToLayers(data: {
  svg: string;
  grouping?: { groups: Array<{ id: number | string; label: string; path_indices: number[] }> };
}): { meta: SvgMeta; layers: Layer[]; groups: Group[] } {
  const parsed = parseSvgToLayers(data.svg); // unchanged — still a flat querySelectorAll('path')
  if (!data.grouping) return parsed;
  const groups: Group[] = data.grouping.groups
    .filter((g) => g.id !== -1) // "Ungrouped" bucket isn't a real Group — those layers just get no groupId
    .map((g) => ({ id: String(g.id), label: g.label, expanded: true, deleted: false }));
  const layers = parsed.layers.map((layer, i) => {
    const owner = data.grouping!.groups.find((g) => g.id !== -1 && g.path_indices.includes(i));
    return owner ? { ...layer, groupId: String(owner.id) } : layer;
  });
  return { meta: parsed.meta, layers, groups };
}
```

The join happens exactly once, right here, immediately after the fetch resolves — `path_indices` are never read again afterward; everything downstream operates on `Layer.groupId`. `parseSvgToLayers` itself is unchanged (still a flat parse, no `<g>`-awareness needed since the backend never emits any); `Layer.id` assignment via the existing monotonic counter is unaffected.

Ripple: `VectorizerPage.tsx`'s `handleVectorize` swaps its `parseSvgToLayers(data.svg)` call for `parseSvgResponseToLayers(data)` and adds `setGroups(parsed.groups)` alongside the existing `setMeta`/`setLayers`.

**Critical frontend files:** `types.ts`, `lib/svgParse.ts`, `lib/svgSerialize.ts`, `lib/groupTree.ts` (new), `components/GroupHeaderRow.tsx` (new), `components/LayersPanel.tsx`, `components/LayerRow.tsx`, `pages/VectorizerPage.tsx`.

---

## Out of scope (for this pass)

- v2 pipeline grouping (explicitly excluded by the user).
- Semantic *labels* for groups (e.g. "cat", "logo") — MobileSAM gives class-agnostic regions only; labels are generic ("Group 1", "Group 2").
- Cropping a group's export to its own bounding box (exports keep full canvas dimensions).
- A right-click context menu for group actions (direct icon buttons on the header row cover this instead; `@base-ui/react`'s `Menu` module is already a dependency if this is wanted later).
- Group-level gizmo transforms (move/scale/rotate a whole group at once via the canvas) — grouping here is a panel/export concern only; canvas interactions are unaffected.

## Verification

1. **Backend**: `POST /api/vectorize` (v1) and `POST /api/v3/vectorize` on a multi-region test image (e.g. a simple illustration with 2–3 clearly separated subjects) with `enable_grouping=true`; confirm the response's `grouping.groups` lists multiple sensible groups whose `path_indices` partition (plus one "Ungrouped" bucket) the full path list with no duplicates, and confirm the returned `svg` string is byte-identical to what the same request produces with `enable_grouping=false` — since grouping is now pure sidecar metadata, the rendered image must be completely unaffected by turning it on. Also test a forced model-unavailable case (e.g. rename the checkpoint) to confirm the fallback returns a valid SVG with `grouping.applied=false` rather than a 500.
2. **Frontend**: run `npm run dev`, upload a multi-region image on the v1 and v3 tabs, confirm the layers panel shows collapsed groups with correct member counts, expand a group and verify individual layer rows appear with correct numbering, multi-select 2+ ungrouped layers and use "Group" to create a manual group, rename it, toggle its visibility, then use its export icon and confirm the downloaded SVG contains only that group's paths at the correct position. Delete a group and confirm all members disappear from the canvas (soft-deleted, not visually present) exactly like today's single-layer delete.