"""Tests for v2's raster preprocessing.

Each stage claims to remove one category of input the tracer would otherwise turn into paths, so
each test feeds in that category and checks it is gone - not that the pixels match some golden
image.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.v2.params import VectorizeParamsV2
from app.v2.preprocess import absorb_small_regions, denoise, prepare, smooth_label_map


def _png(array: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array).save(buf, format="PNG")
    return buf.getvalue()


def _noisy_two_tone(width=120, height=90, seed=3) -> bytes:
    rgb = np.zeros((height, width, 3), dtype=np.uint8)
    rgb[:, : width // 2] = (200, 40, 40)
    rgb[:, width // 2 :] = (40, 60, 200)
    rng = np.random.default_rng(seed)
    noisy = rgb.astype(np.int16) + rng.integers(-18, 19, rgb.shape, dtype=np.int16)
    return _png(np.clip(noisy, 0, 255).astype(np.uint8))


def test_quantization_collapses_noise_to_a_small_palette():
    raw = _noisy_two_tone()
    prepared = prepare(raw, VectorizeParamsV2())
    colours = np.unique(prepared.rgba[:, :, :3].reshape(-1, 3), axis=0)
    assert len(colours) <= 16
    # And the two halves are still two different colours - flattening must not flatten the image.
    left = prepared.rgba[:, 20, :3]
    right = prepared.rgba[:, -20, :3]
    assert not np.array_equal(np.unique(left, axis=0), np.unique(right, axis=0))


def test_prepared_raster_keeps_source_dimensions():
    raw = _noisy_two_tone(width=137, height=91)
    prepared = prepare(raw, VectorizeParamsV2())
    assert (prepared.width, prepared.height) == (137, 91)
    assert prepared.rgba.shape == (91, 137, 4)
    assert prepared.label_map.shape == (91, 137)


def test_oversized_image_is_processed_small_but_returned_full_size():
    raw = _png(np.full((60, 300, 3), 128, dtype=np.uint8))
    prepared = prepare(raw, VectorizeParamsV2(max_dimension=100))
    assert (prepared.width, prepared.height) == (300, 60)
    assert prepared.label_map.shape == (60, 300)


def test_transparent_pixels_stay_transparent_and_unlabelled():
    rgba = np.zeros((40, 40, 4), dtype=np.uint8)
    rgba[:, :, :3] = (10, 200, 90)
    rgba[:20, :, 3] = 255
    prepared = prepare(_png(rgba), VectorizeParamsV2())
    assert prepared.rgba[:20, :, 3].min() == 255
    assert prepared.rgba[20:, :, 3].max() == 0
    assert (prepared.label_map[20:] == -1).all()
    assert (prepared.label_map[:20] >= 0).all()


def test_n_colors_below_two_skips_posterization():
    raw = _noisy_two_tone()
    prepared = prepare(raw, VectorizeParamsV2(n_colors=0))
    colours = np.unique(prepared.rgba[:, :, :3].reshape(-1, 3), axis=0)
    assert len(colours) > 16
    assert (prepared.label_map == 0).all()


def test_denoise_preserves_the_edge_it_smooths_across():
    image = np.zeros((40, 40, 3), dtype=np.uint8)
    image[:, :20] = 30
    image[:, 20:] = 220
    rng = np.random.default_rng(1)
    noisy = np.clip(image.astype(np.int16) + rng.integers(-25, 26, image.shape, dtype=np.int16), 0, 255)
    noisy = noisy.astype(np.uint8)

    filtered = denoise(noisy, strength=6)

    # Noise inside each flat region drops...
    assert filtered[:, 2:18].std() < noisy[:, 2:18].std()
    # ...while the step across the boundary survives, which a Gaussian blur would not manage.
    assert int(filtered[:, 22:].mean()) - int(filtered[:, :18].mean()) > 150


def test_denoise_strength_zero_is_a_passthrough():
    image = np.full((10, 10, 3), 77, dtype=np.uint8)
    image[5, 5] = 0
    assert np.array_equal(denoise(image, 0), image)


def test_smooth_label_map_straightens_a_staircase_boundary():
    labels = np.zeros((20, 20), dtype=np.int32)
    for row in range(20):
        labels[row, 10 + (row % 2) :] = 1  # 1px staircase down the middle

    smoothed = smooth_label_map(labels, 3)

    def transitions(array: np.ndarray) -> int:
        return int(sum((array[r] != array[r + 1]).sum() for r in range(array.shape[0] - 1)))

    assert transitions(smoothed) < transitions(labels)
    assert set(np.unique(smoothed)) <= {0, 1}


def test_smooth_label_map_leaves_transparent_pixels_excluded():
    labels = np.full((10, 10), -1, dtype=np.int32)
    labels[2:8, 2:8] = 1
    labels[4, 4] = 0
    smoothed = smooth_label_map(labels, 3)
    assert (smoothed[labels < 0] == -1).all()


def test_absorb_small_regions_removes_specks_and_keeps_real_regions():
    labels = np.zeros((60, 60), dtype=np.int32)
    labels[10:50, 10:50] = 1  # a real region
    labels[5, 5] = 2  # a 1px speck
    labels[30, 30] = 3  # a speck inside the real region

    absorbed = absorb_small_regions(labels, min_area=16)

    assert 2 not in np.unique(absorbed)
    assert 3 not in np.unique(absorbed)
    assert absorbed[5, 5] == 0
    assert absorbed[30, 30] == 1
    assert (absorbed[20:40, 20:40] == 1).all()


def test_absorb_small_regions_keeps_a_speck_with_no_neighbour_to_join():
    labels = np.full((10, 10), -1, dtype=np.int32)
    labels[5, 5] = 7  # lone opaque pixel surrounded by transparency
    absorbed = absorb_small_regions(labels, min_area=16)
    assert absorbed[5, 5] == 7


def test_min_region_area_zero_absorbs_nothing():
    raw = _noisy_two_tone()
    params = VectorizeParamsV2(min_region_area=0, smooth_labels=False)
    prepared = prepare(raw, params)
    assert prepared.label_map.max() >= 0


def test_undecodable_bytes_raise_valueerror():
    with pytest.raises(ValueError):
        prepare(b"definitely not an image", VectorizeParamsV2())
