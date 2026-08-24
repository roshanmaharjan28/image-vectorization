from __future__ import annotations

import os
from dataclasses import dataclass, field

import cv2
import numpy as np

from .containment import ContainmentParams
from .exceptions import GroupingUnavailableError


@dataclass(frozen=True)
class FastSamParams:
    weights: str = field(default_factory=lambda: os.environ.get("FASTSAM_WEIGHTS_PATH", "FastSAM-s.pt"))
    device: str = "cpu"
    imgsz: int = 1024
    conf: float = 0.4
    iou: float = 0.9
    min_area: int = 24
    containment: ContainmentParams = field(default_factory=ContainmentParams)


def segment_masks(image_bgr: np.ndarray, params: FastSamParams = FastSamParams()) -> list[np.ndarray]:
    """Runs FastSAM instance segmentation on the original raster and returns each instance's
    boolean mask at the image's own resolution (retina_masks=True upsamples internally, so no
    extra resize step is needed to align a mask with the original-resolution canvas), plus one
    extra mask for whatever pixels no instance covers (see `_resolve_overlaps_and_background`)."""
    try:
        from ultralytics import FastSAM
    except ImportError as exc:
        raise GroupingUnavailableError(
            "fastsam grouping requires the 'ultralytics' package (and torch) to be installed "
            "(pip install -r requirements-fastsam.txt)"
        ) from exc

    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    model = FastSAM(params.weights)
    results = model(
        image_rgb,
        device=params.device,
        retina_masks=True,
        imgsz=params.imgsz,
        conf=params.conf,
        iou=params.iou,
        verbose=False,
    )
    if not results or results[0].masks is None:
        return []
    raw_masks = [mask.astype(bool) for mask in results[0].masks.data.cpu().numpy()]
    return _resolve_overlaps_and_background(raw_masks, params.min_area)


def _resolve_overlaps_and_background(raw_masks: list[np.ndarray], min_area: int) -> list[np.ndarray]:
    """Unlike opencv's connected-component masks, FastSAM's instance masks are neither disjoint
    nor exhaustive: two detections routinely overlap (a nested/near-duplicate object, since
    iou=0.9 only suppresses near-identical boxes), and FastSAM only masks pixels it recognizes as
    some object — it never emits a catch-all mask for the background. Left as-is, every
    overlapping pixel gets vectorized once per mask (surfacing as visually duplicate/stacked
    layers) and every pixel outside every mask never gets vectorized at all (the background
    silently missing from the output). Fix both: give each overlapping pixel to the smallest
    (most specific) mask that claims it, then add one extra segment for whatever remains
    unclaimed so the background is always vectorized too."""
    if not raw_masks:
        return []

    order = sorted(range(len(raw_masks)), key=lambda i: raw_masks[i].sum())
    claimed = np.zeros_like(raw_masks[0])
    disjoint: list[np.ndarray] = [None] * len(raw_masks)  # type: ignore[list-item]
    for i in order:
        disjoint[i] = raw_masks[i] & ~claimed
        claimed = claimed | raw_masks[i]

    masks = [m for m in disjoint if int(m.sum()) >= min_area]

    background = ~claimed
    if int(background.sum()) >= min_area:
        masks.insert(0, background)  # painted first/bottom, under every detected instance

    return masks
