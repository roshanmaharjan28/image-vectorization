import io

import cv2
import numpy as np
import vtracer
from PIL import Image

from app.grouping.imageutil import resize_label_map
from app.v2.color_reduce import reduce_colors
from app.v2.preprocess import decode_image, preprocess

from .params import VectorizeParamsV3


def quantize_for_v3(raw: bytes, params: VectorizeParamsV3) -> tuple[np.ndarray, np.ndarray]:
    """Returns (rgba_out, label_map) at the image's original resolution: rgba_out is the exact
    quantized raster the non-grouped path below feeds to vtracer, and label_map is its per-pixel
    color-region id (-1 = excluded), resized back the same way. Grouped requests reuse this so
    each segment's masked vectorize call sees the identical quantized appearance the non-grouped
    output would, instead of quantizing twice."""
    rgba = decode_image(raw)
    orig_h, orig_w = rgba.shape[:2]

    bgr, opaque_mask, scale = preprocess(rgba, params)
    label_map, palette = reduce_colors(bgr, opaque_mask, params)
    quantized_bgr = _apply_palette(bgr, label_map, palette)
    alpha = opaque_mask.astype(np.uint8) * 255

    if scale != 1.0:
        # Nearest-neighbor keeps the quantized flat-color edges hard instead of
        # re-introducing anti-aliased gradients when scaling back to original size.
        quantized_bgr = cv2.resize(quantized_bgr, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
        alpha = cv2.resize(alpha, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
        label_map = resize_label_map(label_map, orig_h, orig_w)

    rgb = cv2.cvtColor(quantized_bgr, cv2.COLOR_BGR2RGB)
    rgba_out = np.dstack([rgb, alpha])
    return rgba_out, label_map


def vectorize_image_v3(raw: bytes, params: VectorizeParamsV3 = VectorizeParamsV3()) -> str:
    """v2's preprocessing + color-reduction stages (denoise, posterize) feed a
    quantized raster into vtracer, which handles region/contour/curve fitting."""
    rgba_out, _label_map = quantize_for_v3(raw, params)
    png_bytes = _encode_png(rgba_out)

    return vtracer.convert_raw_image_to_svg(
        png_bytes,
        img_format="png",
        colormode=params.colormode,
        mode=params.mode,
        hierarchical=params.hierarchical,
        filter_speckle=params.filter_speckle,
        color_precision=params.color_precision,
        layer_difference=params.layer_difference,
        corner_threshold=params.corner_threshold,
        length_threshold=params.length_threshold,
        splice_threshold=params.splice_threshold,
    )


def _apply_palette(
    bgr: np.ndarray, label_map: np.ndarray, palette: list[tuple[int, int, int]]
) -> np.ndarray:
    if not palette:
        return bgr.copy()

    palette_arr = np.array(palette, dtype=np.uint8)
    quantized = bgr.copy()
    valid = label_map >= 0
    quantized[valid] = palette_arr[label_map[valid]]
    return quantized


def _encode_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()
