from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image

from .schema import BBox


def encode_rgba_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


def mask_bbox(mask: np.ndarray) -> BBox | None:
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    return (float(xs.min()), float(ys.min()), float(xs.max()) + 1.0, float(ys.max()) + 1.0)


def resize_label_map(label_map: np.ndarray, height: int, width: int) -> np.ndarray:
    """Nearest-neighbor resize for an integer label map (-1 = excluded/transparent), shifted into
    an unsigned range first since cv2.resize doesn't reliably support signed 32-bit input."""
    shifted = (label_map + 1).astype(np.uint16)
    resized = cv2.resize(shifted, (width, height), interpolation=cv2.INTER_NEAREST)
    return resized.astype(np.int32) - 1
