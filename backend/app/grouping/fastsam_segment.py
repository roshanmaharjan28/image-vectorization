from __future__ import annotations

import os
from dataclasses import dataclass, field

import cv2
import numpy as np
from ultralytics import FastSAM

from .containment import ContainmentParams, find_parents
from .imageutil import mask_bbox


@dataclass(frozen=True)
class FastSamParams:
    weights: str = field(default_factory=lambda: os.environ.get("FASTSAM_WEIGHTS_PATH", "FastSAM-s.pt"))
    device: str = "cpu"
    imgsz: int = 1024
    # Flat vector art (logos/text) has far fewer real objects than a photo, but FastSAM's
    # "segment everything" mode still proposes one candidate per glyph counter, highlight, or
    # near-duplicate box around the same shape. A higher conf drops weak/spurious detections, and
    # a much lower iou makes NMS suppress near-duplicate/overlapping boxes far more aggressively
    # (iou is the overlap threshold above which the lower-confidence box is discarded, so lower =
    # stricter deduping) — both cut segment count toward what opencv's color-region segmentation
    # already gets "for free", without changing the per-mask vectorization architecture.
    conf: float = 0.55
    iou: float = 0.5
    min_area: int = 150
    containment: ContainmentParams = field(default_factory=ContainmentParams)


def segment_masks(image_bgr: np.ndarray, params: FastSamParams = FastSamParams()) -> list[np.ndarray]:
    """Runs FastSAM instance segmentation on the original raster and returns each instance's
    boolean mask at the image's own resolution (retina_masks=True upsamples internally, so no
    extra resize step is needed to align a mask with the original-resolution canvas), plus one
    extra mask for whatever pixels no instance covers (see `_resolve_overlaps_and_background`)."""
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
    raw_masks = _merge_nested_masks(raw_masks, params.containment)
    return _resolve_overlaps_and_background(raw_masks, params.min_area)


def _merge_nested_masks(masks: list[np.ndarray], params: ContainmentParams) -> list[np.ndarray]:
    """FastSAM's "segment everything" mode routinely proposes several masks for one real object —
    the whole letter, plus a counter/hole or a sub-stroke inside it — at bounding boxes that
    genuinely nest rather than nearly-duplicate, so NMS's iou threshold can't dedupe them away.
    Left alone, each of those becomes its own separately-vectorized segment (this is what turns a
    ~20-shape logo into 100+ layers). Since each is bbox-contained in a larger sibling, fold it
    into that sibling's mask instead — transitively, up to its outermost ancestor — so a "part"
    detection stops producing its own layer and instead just becomes pixels inside the "whole"
    object's own single vectorize call, traced at whatever fidelity vtracer finds there anyway
    (this is also why a letter's counter/hole disappears as its own layer, matching how the
    ungrouped pipelines already render it as one path with a hole rather than two paths)."""
    if len(masks) <= 1:
        return masks

    bboxes = [mask_bbox(m) or (0.0, 0.0, 0.0, 0.0) for m in masks]
    parent = find_parents(bboxes, params)

    def root_of(i: int) -> int:
        while i in parent:
            i = parent[i]
        return i

    merged: dict[int, np.ndarray] = {}
    for i, mask in enumerate(masks):
        r = root_of(i)
        merged[r] = mask if r not in merged else (merged[r] | mask)
    return list(merged.values())


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
