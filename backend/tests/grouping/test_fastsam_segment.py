import numpy as np

from app.grouping.fastsam_segment import _resolve_overlaps_and_background


def _mask(shape, y0, y1, x0, x1):
    m = np.zeros(shape, dtype=bool)
    m[y0:y1, x0:x1] = True
    return m


def test_overlapping_instances_become_pairwise_disjoint():
    shape = (50, 50)
    big = _mask(shape, 5, 40, 5, 40)
    small = _mask(shape, 20, 30, 20, 30)  # fully inside `big`

    masks = _resolve_overlaps_and_background([big, small], min_area=1)

    for i in range(len(masks)):
        for j in range(i + 1, len(masks)):
            assert not (masks[i] & masks[j]).any()


def test_smallest_mask_keeps_its_full_shape_on_overlap():
    shape = (50, 50)
    big = _mask(shape, 5, 40, 5, 40)
    small = _mask(shape, 20, 30, 20, 30)

    masks = _resolve_overlaps_and_background([big, small], min_area=1)
    # `small` is returned in its original position (index 1) since it's the last of the two
    # detections, but it must be untouched — nothing should have carved pixels out of it.
    resolved_small = masks[[m.sum() for m in masks].index(int(small.sum()))]
    assert np.array_equal(resolved_small, small)


def test_uncovered_pixels_become_a_background_segment():
    shape = (50, 50)
    instance = _mask(shape, 10, 20, 10, 20)

    masks = _resolve_overlaps_and_background([instance], min_area=1)

    union = np.zeros(shape, dtype=bool)
    for m in masks:
        union |= m
    assert union.all()  # every pixel, including the untouched background, is now covered


def test_background_segment_is_placed_first_so_it_renders_at_the_bottom():
    shape = (50, 50)
    instance = _mask(shape, 10, 20, 10, 20)

    masks = _resolve_overlaps_and_background([instance], min_area=1)

    assert len(masks) == 2
    assert masks[0].sum() > masks[1].sum()  # background is the larger, leftover region


def test_degenerate_segments_below_min_area_are_dropped():
    shape = (10, 10)
    speck = _mask(shape, 0, 1, 0, 1)  # single pixel

    masks = _resolve_overlaps_and_background([speck], min_area=2)

    # the speck itself is dropped, but the (now much larger) background still survives
    assert len(masks) == 1
    assert masks[0].sum() == shape[0] * shape[1] - 1


def test_empty_input_returns_empty_list():
    assert _resolve_overlaps_and_background([], min_area=24) == []
