from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .containment import ContainmentParams


@dataclass(frozen=True)
class OpenCvSegmentParams:
    min_area: int = 24
    containment: ContainmentParams = field(default_factory=ContainmentParams)


def segment_masks(label_map: np.ndarray, params: OpenCvSegmentParams = OpenCvSegmentParams()) -> list[np.ndarray]:
    """One boolean mask per connected component within each color-quantized label (`label_map`
    as produced by app.v2.color_reduce.reduce_colors; -1 = excluded/transparent). Splitting by
    connected component — not just by color — means two same-colored but disjoint regions (e.g. a
    shape's two separate highlights) become two segments, not one, which is what lets vectorizing
    them independently produce correctly separated groups."""
    masks: list[np.ndarray] = []
    for label_idx in np.unique(label_map):
        if label_idx < 0:
            continue
        color_mask = (label_map == label_idx).astype(np.uint8)
        num_components, comp_labels = cv2.connectedComponents(color_mask, connectivity=8)
        for comp in range(1, num_components):
            m = comp_labels == comp
            if int(m.sum()) < params.min_area:
                continue
            masks.append(m)
    return masks
