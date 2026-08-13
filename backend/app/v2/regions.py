from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Region:
    color_bgr: tuple[int, int, int]
    outer: np.ndarray  # Nx2 int32, dense boundary
    holes: list = field(default_factory=list)  # list[np.ndarray], each Nx2 int32


def extract_regions(
    label_map: np.ndarray, palette: list[tuple[int, int, int]], min_area: int
) -> list[Region]:
    """Per palette color, finds connected components and their outer + hole
    contours via RETR_CCOMP's 2-level hierarchy. A same-colored island inside a
    hole is automatically re-emitted by OpenCV as its own top-level contour, so
    it naturally becomes its own separate Region with no special-case code."""
    regions: list[Region] = []

    for label_idx, color in enumerate(palette):
        mask = (label_map == label_idx).astype(np.uint8) * 255
        if not mask.any():
            continue

        # CHAIN_APPROX_NONE keeps the dense per-pixel boundary: the simplify
        # stage (Douglas-Peucker) should be the only lossy polygon reduction.
        contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        if hierarchy is None:
            continue
        hierarchy = hierarchy[0]  # (N, 4): [next, prev, first_child, parent]

        for i, contour in enumerate(contours):
            parent = hierarchy[i][3]
            if parent != -1:
                continue  # this is a hole; collected below via its parent

            if cv2.contourArea(contour) < min_area:
                continue

            outer_pts = contour.reshape(-1, 2)
            holes = []
            child = hierarchy[i][2]
            while child != -1:
                if cv2.contourArea(contours[child]) >= min_area:
                    holes.append(contours[child].reshape(-1, 2))
                child = hierarchy[child][0]

            regions.append(Region(color_bgr=color, outer=outer_pts, holes=holes))

    return regions
