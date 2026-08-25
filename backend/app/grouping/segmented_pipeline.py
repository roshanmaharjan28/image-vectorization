from __future__ import annotations

import logging

import cv2
import numpy as np

from app.quantize.color_reduce import reduce_colors
from app.quantize.params import QuantizeParams
from app.quantize.preprocess import decode_image, preprocess

from . import fastsam_segment, opencv_segment
from .containment import IdAllocator, SegmentSpan, build_segment_forest
from .imageutil import mask_bbox, resize_label_map
from .masked_vectorize import vectorize_masked
from .schema import GroupingMode, GroupNode, TreeNode
from .svg_merge import merge_segments
from .validate import validate_tree

logger = logging.getLogger(__name__)

# Bounds the worst case number of per-segment vtracer subprocess calls a single request can
# trigger. Exceeding it just means "too fragmented to be worth grouping" — the caller falls
# back to one plain, ungrouped vectorize call, the same outcome as finding zero segments.
MAX_SEGMENTS = 150

# FastSAM's mask boundary rarely lands pixel-exactly on a glyph/shape's true (anti-aliased) edge
# the way opencv's color-derived masks do, so vectorizing each mask independently traces a thin
# sliver of edge pixels caught between the two boundaries as its own tiny path — multiplying a
# single real shape into several. vtracer's own speckle filter is the right tool for exactly this
# (small, spurious regions), but its default (2px) is tuned for whole-image tracing and is far too
# low to catch an elongated boundary sliver. This floor is applied only to fastsam's per-segment
# calls — opencv's masks already align with real color edges and don't need it.
FASTSAM_MIN_FILTER_SPECKLE = 16


def build_grouped_svg(
    image_bytes: bytes,
    grouping: GroupingMode,
    vtracer_kwargs: dict,
    *,
    quantized_source: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[str, list[TreeNode]] | None:
    """Segments the source image *before* vectorizing — rather than vectorizing the whole image
    once and grouping the resulting flat path list after the fact — so each path's group
    membership falls out of which masked region it was traced from, instead of a lossy post-hoc
    proxy match. Returns None when segmentation found nothing worth grouping (a flat single-color
    image, or a degenerate/too-fragmented result); the caller should fall back to a plain,
    ungrouped vectorize call — this is a normal, expected outcome, not an error.

    `quantized_source`, when provided, is a pipeline's own already-quantized (rgba, label_map)
    pair (see v3/pipeline.py's quantize_for_v3) so a grouped v3 request reuses the exact same
    quantized appearance the non-grouped path would vectorize, instead of quantizing twice. When
    omitted (v1, which has no quantization step of its own), the raw decoded image is vectorized
    directly, and opencv segmentation quantizes a disposable copy purely to derive regions."""
    rgba = decode_image(image_bytes)

    if quantized_source is not None:
        vectorize_rgba, label_map = quantized_source
    else:
        vectorize_rgba, label_map = rgba, None

    if grouping == "opencv":
        if label_map is None:
            label_map = _quantize_for_segmentation(rgba)
        masks = opencv_segment.segment_masks(label_map)
        containment_params = opencv_segment.OpenCvSegmentParams().containment
    elif grouping == "fastsam":
        image_bgr = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if image_bgr is None:
            raise ValueError("could not decode image bytes for fastsam grouping")
        masks = fastsam_segment.segment_masks(image_bgr)
        containment_params = fastsam_segment.FastSamParams().containment
        # vtracer_kwargs = {
        #     **vtracer_kwargs,
        #     "filter_speckle": max(vtracer_kwargs.get("filter_speckle", 0), FASTSAM_MIN_FILTER_SPECKLE),
        # }
    else:
        raise ValueError(f"unknown grouping mode: {grouping!r}")

    if not masks or len(masks) > MAX_SEGMENTS:
        if len(masks) > MAX_SEGMENTS:
            logger.info(
                "grouping=%s produced %d segments (> %d cap); falling back to ungrouped",
                grouping,
                len(masks),
                MAX_SEGMENTS,
            )
        return None

    try:
        segment_svgs = [vectorize_masked(vectorize_rgba, mask, vtracer_kwargs) for mask in masks]
        h, w = vectorize_rgba.shape[:2]
        merged_svg, path_infos, ranges = merge_segments(w, h, segment_svgs)

        ids = IdAllocator()
        spans = [
            SegmentSpan(bbox=mask_bbox(mask) or (0.0, 0.0, 0.0, 0.0), leaf_indices=list(range(start, end)))
            for mask, (start, end) in zip(masks, ranges)
        ]
        forest = build_segment_forest(spans, containment_params, ids)
        validate_tree(forest, total_paths=len(path_infos))
    except Exception:
        logger.exception("grouping failed (mode=%s); degrading to ungrouped", grouping)
        return None

    # Bare top-level leaves (a segment that never nested with anything) add nothing over letting
    # the frontend's own completeness pass surface them as ordinary ungrouped layers — this is
    # what makes `groups=[]` (as opposed to None) mean "segmentation ran, nothing to actually
    # group", exactly as documented on the wire schema.
    top_level_groups = [node for node in forest if isinstance(node, GroupNode)]
    return merged_svg, top_level_groups


def _quantize_for_segmentation(rgba: np.ndarray) -> np.ndarray:
    """v1 has no color-quantization step of its own; for opencv segmentation only (never for
    what actually gets vectorized) this runs the shared app/quantize preprocessing+posterization on
    a disposable copy purely to derive discrete color regions, then resizes the resulting labels
    back to the original resolution so they align with the raw image v1 vectorizes.

    v2 and v3 skip this: both hand in their own already-quantized label map (see each router's
    `quantized_source_provider`), so their groups describe the regions they actually traced."""
    params = QuantizeParams()
    bgr, opaque_mask, scale = preprocess(rgba, params)
    label_map, _palette = reduce_colors(bgr, opaque_mask, params)
    if scale != 1.0:
        h, w = rgba.shape[:2]
        label_map = resize_label_map(label_map, h, w)
    return label_map
