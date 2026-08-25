"""v2's preprocess stage: turn an arbitrary raster into a flat-colour one whose regions are
already the regions we want traced.

The premise is that most of what makes vtracer output bad - hundreds of near-duplicate layers,
speckle paths, jagged boundaries - is decided before the tracer runs. A photo or a JPEG-compressed
logo has thousands of distinct colours and noisy, anti-aliased edges; vtracer faithfully traces all
of it. So each step here removes a specific category of input the tracer would otherwise turn into
paths:

  1. resize (shared with app/quantize)  - bounds preprocessing cost, nothing else
  2. bilateral denoise                  - kills in-region noise (JPEG blocks, grain, dithering)
                                          without softening the boundaries between regions
  3. Lab k-means posterize (shared)     - collapses anti-aliasing fringes and gradients into a
                                          small palette, which is what caps the layer count
  4. majority filter on the label map   - straightens the 1px staircase along boundaries
  5. small-region absorption            - removes regions too small to be worth a path at all

Tracing then happens back at the image's own resolution, so none of this costs output detail.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from app.grouping.imageutil import encode_rgba_png, resize_label_map
from app.quantize.color_reduce import apply_palette, reduce_colors
from app.quantize.preprocess import decode_image, preprocess

from .params import VectorizeParamsV2

logger = logging.getLogger(__name__)

_K3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))


@dataclass(frozen=True)
class PreparedRaster:
    """The flat-colour raster handed to vtracer, at the source image's own resolution.

    `label_map` is the same raster expressed as per-pixel colour-region ids (-1 = transparent),
    which is what opencv grouping segments on - so a grouped v2 request derives its groups from
    the exact regions that were traced, and never quantizes twice.

    `palette` is that label map's BGR colour table (empty when quantization was skipped). The
    postprocess stage needs it because vtracer does not preserve the palette it is handed - see
    postprocess._snap_fills.
    """

    png: bytes
    rgba: np.ndarray
    label_map: np.ndarray
    width: int
    height: int
    palette: list[tuple[int, int, int]]


def prepare(raw: bytes, params: VectorizeParamsV2) -> PreparedRaster:
    rgba = decode_image(raw)
    orig_h, orig_w = rgba.shape[:2]

    # Reuses the shared resize/alpha-threshold step with its Gaussian pre-blur disabled
    # (params.blur_ksize == 0), because v2 wants an edge-preserving filter instead.
    bgr, opaque_mask, _scale = preprocess(rgba, params)
    bgr = denoise(bgr, params.denoise_strength)

    palette: list[tuple[int, int, int]] = []
    if params.n_colors >= 2:
        label_map, palette = reduce_colors(bgr, opaque_mask, params)
        if params.smooth_labels:
            label_map = smooth_label_map(label_map, params.smooth_labels_ksize)
        if params.min_region_area > 0:
            label_map = absorb_small_regions(label_map, params.min_region_area)
        flat_bgr = apply_palette(bgr, label_map, palette)
    else:
        # n_colors < 2 disables posterization entirely (the "what does v2 look like without the
        # quantizer" baseline). The label map still has to exist for grouping, so it degenerates
        # to one region covering everything opaque.
        label_map = np.where(opaque_mask, 0, -1).astype(np.int32)
        flat_bgr = bgr

    alpha = opaque_mask.astype(np.uint8) * 255

    if flat_bgr.shape[:2] != (orig_h, orig_w):
        # Nearest-neighbour on the way back up: anything interpolating would re-introduce the
        # anti-aliased boundary pixels this stage exists to remove.
        flat_bgr = cv2.resize(flat_bgr, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
        alpha = cv2.resize(alpha, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
        label_map = resize_label_map(label_map, orig_h, orig_w)

    rgba_out = np.dstack([cv2.cvtColor(flat_bgr, cv2.COLOR_BGR2RGB), alpha])
    return PreparedRaster(
        png=encode_rgba_png(rgba_out),
        rgba=rgba_out,
        label_map=label_map,
        width=orig_w,
        height=orig_h,
        palette=palette,
    )


def denoise(bgr: np.ndarray, strength: int) -> np.ndarray:
    """Edge-preserving smoothing. A bilateral filter averages only over neighbours that are
    already a similar colour, so it flattens noise inside a region while leaving the step across
    a region boundary intact - the opposite of a Gaussian blur, which would smear the very edges
    the tracer is about to follow."""
    if strength <= 0:
        return bgr
    sigma = float(strength)
    diameter = 5 if max(bgr.shape[:2]) < 900 else 7
    return cv2.bilateralFilter(bgr, diameter, sigmaColor=14.0 * sigma, sigmaSpace=7.0 * sigma)


def smooth_label_map(label_map: np.ndarray, ksize: int) -> np.ndarray:
    """Majority (mode) filter over region ids: each pixel takes whichever label is most common in
    its neighbourhood, ties going to the label it already had.

    This is the cheapest available fix for the 1px staircase k-means leaves along a boundary. Doing
    it on labels rather than on colours matters: a colour-space filter would invent intermediate
    colours, which is exactly what would spawn new layers.
    """
    ksize = max(3, ksize | 1)
    labels = np.unique(label_map)
    labels = labels[labels >= 0]
    if labels.size <= 1:
        return label_map

    best_count = np.zeros(label_map.shape, dtype=np.float32)
    best_label = np.full(label_map.shape, -1, dtype=np.int32)
    own_count = np.zeros(label_map.shape, dtype=np.float32)

    for label in labels:
        member = (label_map == label).astype(np.float32)
        counts = cv2.boxFilter(
            member, -1, (ksize, ksize), normalize=False, borderType=cv2.BORDER_REPLICATE
        )
        winning = counts > best_count
        best_count[winning] = counts[winning]
        best_label[winning] = label
        own_count[member > 0] = counts[member > 0]

    flip = (best_count > own_count) & (label_map >= 0) & (best_label >= 0)
    smoothed = np.where(flip, best_label, label_map)
    return smoothed.astype(np.int32)


def absorb_small_regions(label_map: np.ndarray, min_area: int) -> np.ndarray:
    """Reassigns every connected region smaller than `min_area` px to whichever label dominates
    its immediate border, so the tracer never sees it as a region of its own.

    This is upstream of - not a duplicate of - vtracer's `filter_speckle`: dropping a speckle here
    means the surrounding colour grows to cover it, whereas dropping it at trace time can leave a
    hole for whatever is stacked underneath to show through.
    """
    out = label_map.copy()
    height, width = out.shape
    labels = np.unique(out)
    labels = labels[labels >= 0]
    absorbed = 0

    for label in labels:
        mask = (out == label).astype(np.uint8)
        count, components, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8, cv2.CV_32S)
        for index in range(1, count):
            if stats[index, cv2.CC_STAT_AREA] >= min_area:
                continue
            x, y, w, h = (int(v) for v in stats[index, :4])
            pad = 2
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(width, x + w + pad), min(height, y + h + pad)

            # `window` is a view into `out`, so writing through it updates the label map in place.
            window = out[y0:y1, x0:x1]
            region = components[y0:y1, x0:x1] == index
            ring = cv2.dilate(region.astype(np.uint8), _K3, iterations=pad).astype(bool) & ~region
            neighbours = window[ring]
            neighbours = neighbours[(neighbours >= 0) & (neighbours != label)]
            if neighbours.size == 0:
                continue
            values, counts = np.unique(neighbours, return_counts=True)
            window[region] = int(values[int(np.argmax(counts))])
            absorbed += 1

    if absorbed:
        logger.debug("v2 preprocess absorbed %d small regions (< %d px)", absorbed, min_area)
    return out
