import io

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from .params import VectorizeParamsV2


def decode_image(raw: bytes) -> np.ndarray:
    """Decode arbitrary uploaded bytes into an RGBA uint8 array (H, W, 4)."""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"Could not decode image: {exc}") from exc

    return np.array(img.convert("RGBA"), dtype=np.uint8)


def preprocess(rgba: np.ndarray, params: VectorizeParamsV2) -> tuple[np.ndarray, np.ndarray, float]:
    """Returns (bgr, opaque_mask, scale) at processing resolution.

    scale = processing_dim / original_dim; callers divide fitted coordinates by
    scale to map back onto the original image's dimensions.
    """
    h, w = rgba.shape[:2]
    long_side = max(h, w)
    short_side = min(h, w)

    scale = 1.0
    if long_side > params.max_dimension:
        scale = params.max_dimension / long_side
    elif short_side < params.min_dimension:
        scale = params.min_dimension / short_side

    alpha_original = rgba[:, :, 3]

    if scale != 1.0:
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
        rgb_resized = cv2.resize(rgba[:, :, :3], (new_w, new_h), interpolation=interp)
        # Alpha is resized separately with nearest-neighbor so downscaling/upscaling
        # never invents semi-opaque boundary pixels along the transparency mask.
        alpha_resized = cv2.resize(alpha_original, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
    else:
        rgb_resized = rgba[:, :, :3]
        alpha_resized = alpha_original

    opaque_mask = alpha_resized > params.alpha_threshold
    bgr = cv2.cvtColor(rgb_resized, cv2.COLOR_RGB2BGR)

    if params.blur_ksize and params.blur_ksize > 1:
        ksize = params.blur_ksize | 1  # cv2 requires an odd kernel size
        bgr = cv2.GaussianBlur(bgr, (ksize, ksize), 0)

    return bgr, opaque_mask, scale
