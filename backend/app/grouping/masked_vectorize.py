from __future__ import annotations

import numpy as np
import vtracer

from .imageutil import encode_rgba_png


def vectorize_masked(rgba: np.ndarray, mask: np.ndarray, vtracer_kwargs: dict) -> str:
    """Vectorizes only the pixels inside `mask` — everywhere else is forced fully transparent so
    vtracer traces nothing there, the same alpha-exclusion mechanism the non-grouped v3 pipeline
    already relies on for its own opaque_mask. This is what makes a path's group membership exact
    (it was traced from that mask and nothing else) instead of a post-hoc proxy match."""
    masked = rgba.copy()
    masked[:, :, 3] = np.where(mask, rgba[:, :, 3], 0)
    png_bytes = encode_rgba_png(masked)
    return vtracer.convert_raw_image_to_svg(png_bytes, img_format="png", **vtracer_kwargs)
