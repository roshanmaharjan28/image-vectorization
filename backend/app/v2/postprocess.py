"""v2's postprocess stage: rewrite the SVG vtracer emits into one that is smaller, smoother, and
made of fewer paths - without re-tracing anything.

vtracer's own roadmap lists path simplification as a missing post-process filter, and its raw
output shows why it is worth adding: every segment is a cubic (straight runs included), every
number carries full float64 repr, each path's position lives in a `transform="translate(...)"`
instead of in its coordinates, there is no viewBox at all, and a noisy source yields a long tail of
sub-pixel paths. Each pass below targets one of those.

Ordering matters and is deliberate:
  1. fold each path's translate() into its coordinates   (makes everything downstream comparable)
  2. drop contours/paths whose area is below the floor    (cheapest first - never simplify a path
                                                           that is about to be discarded)
  3. simplify + refit the survivors                       (the expensive geometry pass)
  4. snap each fill back onto the quantized palette       (must precede the merge, which keys on
                                                           fill equality)
  5. merge same-fill paths                                (needs final geometry to concatenate)
  6. serialize at a fixed precision, rebuild the document (adds the viewBox vtracer omits)

Path identity is not free to throw away: grouping addresses paths by their index in document
order, so every run returns an index map from original index to surviving index, and
`data-region-index` attributes are rewritten to match.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import cv2
import numpy as np

from app.grouping.svg_annotate import extract_fill, extract_path_tags, parse_attrs

from . import pathdata
from .params import VectorizeParamsV2

logger = logging.getLogger(__name__)

# vtracer only ever emits a pure translate here. Anything else (a matrix, a rotation) means the
# coordinates cannot be made absolute by adding an offset, so the path is passed through untouched.
_TRANSLATE_RE = re.compile(r"^\s*translate\(\s*(-?[\d.eE+]+)\s*(?:,|\s)\s*(-?[\d.eE+]+)\s*\)\s*$")

# Attributes v2 re-emits itself; anything else on the source tag (stroke, opacity, class, a
# caller's own data-* attribute) is preserved verbatim so postprocessing stays additive.
_OWNED_ATTRS = {"d", "fill", "transform", "data-region-index", "stroke", "stroke-width"}


@dataclass(frozen=True)
class PostprocessResult:
    svg: str
    # original path index -> index in the rewritten document. Paths dropped for being too small are
    # absent; several original indices can map to one new index when paths were merged.
    index_map: dict[int, int]


@dataclass
class _Path:
    """One path in flight through the stage: either geometry we understood (`subpaths` set) or an
    opaque source tag we refuse to touch (`raw_tag` set)."""

    source_indices: list[int]
    fill: str
    extra: str
    had_region_index: bool
    subpaths: list[tuple[pathdata.Point, list[pathdata.Segment], bool]] | None = None
    raw_tag: str | None = None


def optimize_svg(
    svg: str,
    params: VectorizeParamsV2,
    *,
    width: int,
    height: int,
    palette: list[tuple[int, int, int]] | None = None,
    allow_merge: bool = True,
) -> PostprocessResult:
    """`allow_merge=False` suppresses same-fill merging, which is what grouped requests need: a
    merged path would belong to two segments' groups at once, and there is no honest answer for
    which group owns it.

    `palette` is the BGR palette the preprocess stage quantized to; when given (and
    params.snap_fills_to_palette is on) every traced fill is snapped back onto it. See
    `_snap_fills`."""
    paths: list[_Path] = []
    dropped = 0
    nodes_in = 0
    nodes_out = 0

    # `source_index` is the path's position in the *input* document - the index grouping's leaf
    # refs use - which is why it comes from enumerate() and not from len(paths), a list that stops
    # tracking document order the moment anything is dropped.
    for source_index, tag in enumerate(extract_path_tags(svg)):
        attrs = parse_attrs(tag)
        offset = _translate_offset(attrs.get("transform"))
        contours = pathdata.parse_path_d(attrs.get("d", ""), offset) if offset is not None else None

        fill = extract_fill(attrs)
        extra = _extra_attrs(attrs)
        had_region_index = "data-region-index" in attrs

        if contours is None:
            paths.append(
                _Path(
                    source_indices=[source_index],
                    fill=fill,
                    extra=extra,
                    had_region_index=had_region_index,
                    raw_tag=tag,
                )
            )
            continue

        nodes_in += sum(len(c.points) for c in contours)
        subpaths: list[tuple[pathdata.Point, list[pathdata.Segment], bool]] = []
        for contour in contours:
            if abs(contour.area()) < params.min_path_area:
                continue
            start, segments = pathdata.build_segments(
                contour,
                tolerance=params.simplify_tolerance,
                smooth=params.smooth_curves,
                corner_angle=params.smooth_corner_angle,
                max_error=params.max_fit_error,
            )
            if not segments:
                continue
            nodes_out += len(segments)
            subpaths.append((start, segments, contour.closed))

        if not subpaths:
            dropped += 1
            continue

        paths.append(
            _Path(
                source_indices=[source_index],
                fill=fill,
                extra=extra,
                had_region_index=had_region_index,
                subpaths=subpaths,
            )
        )

    snapped = 0
    if params.snap_fills_to_palette and palette:
        snapped = _snap_fills(paths, palette)

    merged = _merge(paths, params.merge_same_fill if allow_merge else "none")

    body: list[str] = []
    index_map: dict[int, int] = {}
    for new_index, path in enumerate(merged):
        for source_index in path.source_indices:
            index_map[source_index] = new_index
        body.append(_render(path, new_index, params))

    logger.info(
        "v2 postprocess: %d paths -> %d (%d dropped), %d nodes -> %d, %d fills snapped",
        len(paths) + dropped,
        len(merged),
        dropped,
        nodes_in,
        nodes_out,
        snapped,
    )

    header = (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
    )
    return PostprocessResult(svg=header + "\n" + "\n".join(body) + "\n</svg>", index_map=index_map)


def _snap_fills(paths: list[_Path], palette: list[tuple[int, int, int]]) -> int:
    """Replaces each path's fill with the nearest entry of the palette the preprocess stage
    quantized to, and returns how many paths were changed.

    "Nearest" is measured in CIELAB, the same space the quantizer picked the palette in, so it
    matches how different two colours actually look rather than how far apart their bytes are. The
    search runs once per *distinct fill* in the document, not once per path.

    This exists because vtracer does not preserve the palette it is given. Handed a raster with 59
    distinct flat colours it emitted 5,420 distinct fills (2,675 in cutout mode, 1,098 even at
    color_precision=4): its layers carry their own computed colours, not the input's. That voids
    the guarantee the whole preprocess stage was making - that n_colors bounds the output's colour
    count - and it defeats `merge_same_fill`, which can only combine paths whose fills compare
    *exactly* equal, so near-duplicates differing by a single unit never merge.

    Snapping restores it: after this pass a document has at most `len(palette)` distinct fills, so
    merging can collapse each colour's components into a single path. It runs after the drop/refit
    passes (no point snapping a fill that is about to be discarded) and before the merge, which is
    the pass that consumes fill equality.
    """
    if not palette:
        return 0

    fills = {path.fill for path in paths}
    parsed = {fill: rgb for fill in fills if (rgb := _parse_hex(fill)) is not None}
    if not parsed:
        return 0

    # palette is BGR (the quantizer's native order); compare in Lab.
    palette_lab = _to_lab(np.array([[b, g, r] for b, g, r in palette], dtype=np.uint8))
    keys = list(parsed)
    query_lab = _to_lab(np.array([parsed[k][::-1] for k in keys], dtype=np.uint8))

    nearest = np.argmin(
        np.linalg.norm(query_lab[:, None, :] - palette_lab[None, :, :], axis=2), axis=1
    )
    replacement = {
        key: "#%02x%02x%02x" % tuple(int(c) for c in reversed(palette[int(index)]))
        for key, index in zip(keys, nearest)
    }

    changed = 0
    for path in paths:
        # A raw passthrough path keeps whatever it had: its fill may live in a style attribute or
        # be painted by something this stage never parsed, so rewriting `path.fill` alone would
        # not change what renders anyway.
        if path.raw_tag is not None:
            continue
        new_fill = replacement.get(path.fill)
        if new_fill is not None and new_fill != path.fill:
            path.fill = new_fill
            changed += 1
    return changed


def _to_lab(bgr_rows: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr_rows.reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float)


def _parse_hex(fill: str) -> tuple[int, int, int] | None:
    """(r, g, b) for a #rgb / #rrggbb fill, or None for anything else (a named colour, url(#...),
    "none") - those are left exactly as they are rather than guessed at."""
    text = fill.strip()
    if not text.startswith("#"):
        return None
    digits = text[1:]
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    if len(digits) != 6:
        return None
    try:
        return (int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16))
    except ValueError:
        return None


def _merge(paths: list[_Path], mode: str) -> list[_Path]:
    """"adjacent" merges consecutive same-fill paths; "all" merges every same-fill path into its
    first occurrence.

    Adjacency is the safe one, and not by luck: vtracer emits one colour layer at a time, so a run
    of consecutive same-fill paths is the set of disjoint components of a single colour. Combining
    them into one path element cannot change what any pixel renders as, because nothing was stacked
    between them to begin with. "all" reaches across stacking positions and can therefore change
    occlusion, which is why it is not the default.
    """
    if mode == "none" or len(paths) < 2:
        return paths

    out: list[_Path] = []
    by_fill: dict[str, int] = {}
    for path in paths:
        if path.subpaths is None:
            out.append(path)
            by_fill.clear()  # an untouched path may paint anything; stop merging across it
            continue

        target: int | None = None
        if mode == "all":
            target = by_fill.get(path.fill)
        elif out and out[-1].subpaths is not None and out[-1].fill == path.fill:
            target = len(out) - 1

        if target is None:
            by_fill[path.fill] = len(out)
            out.append(path)
        else:
            host = out[target]
            assert host.subpaths is not None
            host.subpaths.extend(path.subpaths)
            host.source_indices.extend(path.source_indices)
            host.had_region_index = host.had_region_index or path.had_region_index
    return out


def _render(path: _Path, new_index: int, params: VectorizeParamsV2) -> str:
    if path.raw_tag is not None:
        return _rewrite_region_index(path.raw_tag, new_index) if path.had_region_index else path.raw_tag

    d = pathdata.serialize(path.subpaths or [], params.precision)
    parts = [f'<path d="{d}"', f'fill="{path.fill}"']
    if params.seam_stroke_width > 0:
        # Painting a path's own fill as a hairline stroke closes the sub-pixel seams that show
        # between adjacent regions in stacked mode, where two traced boundaries meet but neither
        # covers the half-pixel between them.
        parts.append(f'stroke="{path.fill}"')
        parts.append(f'stroke-width="{params.seam_stroke_width:g}"')
    if path.had_region_index:
        parts.append(f'data-region-index="{new_index}"')
    if path.extra:
        parts.append(path.extra)
    return " ".join(parts) + "/>"


def _extra_attrs(attrs: dict[str, str]) -> str:
    return " ".join(f'{name}="{value}"' for name, value in attrs.items() if name not in _OWNED_ATTRS)


def _rewrite_region_index(tag: str, new_index: int) -> str:
    return re.sub(r'data-region-index="\d+"', f'data-region-index="{new_index}"', tag, count=1)


def _translate_offset(transform: str | None) -> pathdata.Point | None:
    """(dx, dy) for an absent or pure-translate transform; None for anything else, meaning the
    path's geometry must be left alone."""
    if not transform:
        return (0.0, 0.0)
    match = _TRANSLATE_RE.match(transform)
    if not match:
        return None
    return (float(match.group(1)), float(match.group(2)))
