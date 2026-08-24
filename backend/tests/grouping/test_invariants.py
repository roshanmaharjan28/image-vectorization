import random

import numpy as np
import pytest

from app.grouping.containment import ContainmentParams, IdAllocator, SegmentSpan, build_segment_forest
from app.grouping.opencv_segment import OpenCvSegmentParams, segment_masks
from app.grouping.validate import validate_tree


def _random_spans(rng: random.Random, n: int) -> list[SegmentSpan]:
    spans = []
    next_index = 0
    for _ in range(n):
        x0 = rng.uniform(0, 500)
        y0 = rng.uniform(0, 500)
        w = rng.uniform(0, 40)
        h = rng.uniform(0, 40)
        count = rng.randint(0, 3)
        indices = list(range(next_index, next_index + count))
        next_index += count
        spans.append(SegmentSpan(bbox=(x0, y0, x0 + w, y0 + h), leaf_indices=indices))
    return spans, next_index


@pytest.mark.parametrize("seed", range(50))
def test_random_segment_sets_never_violate_invariants(seed: int):
    rng = random.Random(seed)
    n = rng.randint(0, 60)
    spans, total_paths = _random_spans(rng, n)
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    # Must not raise — no duplicate/out-of-range leaf, no empty group.
    validate_tree(forest, total_paths=total_paths)


def test_empty_input_returns_empty_forest():
    assert build_segment_forest([], ContainmentParams(), IdAllocator()) == []


def test_opencv_segment_masks_splits_disjoint_same_color_regions():
    label_map = np.full((10, 10), -1, dtype=np.int32)
    label_map[1:3, 1:3] = 0
    label_map[7:9, 7:9] = 0  # same label, disjoint from the first block
    label_map[1:3, 7:9] = 1

    masks = segment_masks(label_map, OpenCvSegmentParams(min_area=1))
    assert len(masks) == 3  # two components of label 0, one of label 1
    total_true_pixels = sum(int(m.sum()) for m in masks)
    assert total_true_pixels == 4 + 4 + 4


def test_opencv_segment_masks_ignores_excluded_pixels():
    label_map = np.full((5, 5), -1, dtype=np.int32)
    assert segment_masks(label_map) == []


def test_opencv_segment_masks_drops_components_below_min_area():
    label_map = np.full((10, 10), -1, dtype=np.int32)
    label_map[0, 0] = 0  # a single-pixel speck
    assert segment_masks(label_map, OpenCvSegmentParams(min_area=2)) == []
