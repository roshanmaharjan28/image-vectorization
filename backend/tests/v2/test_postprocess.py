"""Tests for v2's SVG postprocess stage - the document-level pass, as opposed to test_pathdata's
geometry."""

from __future__ import annotations

import re

import pytest

from app.v2.params import VectorizeParamsV2
from app.v2.postprocess import optimize_svg

DEFAULTS = VectorizeParamsV2()


def svg_of(*paths: str, width: int = 100, height: int = 100) -> str:
    """A vtracer-shaped document: no viewBox, per-path translate, full-precision numbers."""
    body = "\n".join(paths)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">\n'
        f"{body}\n</svg>"
    )


def square(x: float, y: float, size: float, fill: str, translate: tuple[float, float] | None = None) -> str:
    d = f"M{x} {y} L{x + size} {y} L{x + size} {y + size} L{x} {y + size} Z"
    transform = f' transform="translate({translate[0]},{translate[1]})"' if translate else ""
    return f'<path d="{d}" fill="{fill}"{transform}/>'


def paths_of(svg: str) -> list[str]:
    return re.findall(r"<path\b[^>]*>", svg)


def fills_of(svg: str) -> list[str]:
    return re.findall(r'fill="([^"]*)"', svg)


def numbers_of(svg: str) -> list[str]:
    return re.findall(r"-?\d*\.?\d+", " ".join(re.findall(r'd="([^"]*)"', svg)))


# --- document rebuild --------------------------------------------------------------------


def test_adds_the_viewbox_vtracer_omits():
    result = optimize_svg(svg_of(square(0, 0, 50, "#ff0000")), DEFAULTS, width=100, height=80)
    assert 'viewBox="0 0 100 80"' in result.svg
    assert 'width="100"' in result.svg and 'height="80"' in result.svg
    assert result.svg.rstrip().endswith("</svg>")


def test_folds_translate_into_coordinates_and_drops_the_attribute():
    result = optimize_svg(
        svg_of(square(0, 0, 40, "#00ff00", translate=(10.0, 20.0))), DEFAULTS, width=100, height=100
    )
    assert "transform=" not in result.svg
    values = [float(n) for n in numbers_of(result.svg)]
    assert min(values) == pytest.approx(10.0)
    assert max(values) == pytest.approx(60.0)


def test_rounds_coordinates_to_the_requested_precision():
    path = '<path d="M0.123456789 0.987654321 L40.111111 0.9 L40.1 40.1 L0.1 40.1 Z" fill="#123456"/>'
    result = optimize_svg(svg_of(path), VectorizeParamsV2(precision=2), width=100, height=100)
    assert all(len(n.split(".")[1]) <= 2 for n in numbers_of(result.svg) if "." in n)


def test_preserves_unrecognised_attributes():
    path = '<path d="M0 0 L40 0 L40 40 L0 40 Z" fill="#abcdef" opacity="0.5" class="keep-me"/>'
    result = optimize_svg(svg_of(path), DEFAULTS, width=100, height=100)
    assert 'opacity="0.5"' in result.svg
    assert 'class="keep-me"' in result.svg


def test_paths_with_an_unsupported_transform_pass_through_untouched():
    path = '<path d="M0 0 L40 0 L40 40 Z" fill="#111111" transform="rotate(30)"/>'
    result = optimize_svg(svg_of(path), DEFAULTS, width=100, height=100)
    assert 'transform="rotate(30)"' in result.svg
    assert result.index_map == {0: 0}


def test_seam_stroke_paints_each_path_with_its_own_fill():
    params = VectorizeParamsV2(seam_stroke_width=0.5)
    result = optimize_svg(svg_of(square(0, 0, 40, "#ABCDEF")), params, width=100, height=100)
    assert 'stroke="#ABCDEF"' in result.svg
    assert 'stroke-width="0.5"' in result.svg


def test_seam_stroke_is_absent_by_default():
    result = optimize_svg(svg_of(square(0, 0, 40, "#ABCDEF")), DEFAULTS, width=100, height=100)
    assert "stroke" not in result.svg


# --- dropping ----------------------------------------------------------------------------


def test_drops_paths_below_the_area_floor_and_keeps_the_rest():
    result = optimize_svg(
        svg_of(square(0, 0, 40, "#ff0000"), square(50, 50, 1, "#00ff00")),
        VectorizeParamsV2(min_path_area=16.0),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 1
    assert fills_of(result.svg) == ["#ff0000"]
    assert result.index_map == {0: 0}  # the speck is absent, not remapped


def test_min_path_area_zero_keeps_specks():
    result = optimize_svg(
        svg_of(square(0, 0, 40, "#ff0000"), square(50, 50, 2, "#00ff00")),
        VectorizeParamsV2(min_path_area=0.0),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 2


def test_a_speck_subpath_is_dropped_without_dropping_its_path():
    path = (
        '<path d="M0 0 L40 0 L40 40 L0 40 Z M90 90 L91 90 L91 91 L90 91 Z" fill="#ff0000"/>'
    )
    result = optimize_svg(svg_of(path), VectorizeParamsV2(min_path_area=16.0), width=100, height=100)
    assert len(paths_of(result.svg)) == 1
    assert max(float(n) for n in numbers_of(result.svg)) == pytest.approx(40.0)


def test_document_with_no_usable_paths_still_produces_a_valid_svg():
    # min_path_area is explicit rather than taken from DEFAULTS: the point here is what happens
    # when the floor drops every path, not what the current default floor happens to be (it is 0,
    # which drops nothing).
    result = optimize_svg(
        svg_of(square(0, 0, 1, "#ff0000")),
        VectorizeParamsV2(min_path_area=16.0),
        width=10,
        height=10,
    )
    assert result.svg.startswith("<svg")
    assert paths_of(result.svg) == []
    assert result.index_map == {}


def test_empty_document():
    result = optimize_svg("<svg></svg>", DEFAULTS, width=10, height=10)
    assert "</svg>" in result.svg
    assert result.index_map == {}


# --- merging -----------------------------------------------------------------------------


def test_adjacent_merge_combines_consecutive_same_fill_paths():
    result = optimize_svg(
        svg_of(
            square(0, 0, 30, "#ff0000"),
            square(40, 0, 30, "#ff0000"),
            square(0, 40, 30, "#0000ff"),
        ),
        VectorizeParamsV2(merge_same_fill="adjacent"),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 2
    assert result.index_map == {0: 0, 1: 0, 2: 1}
    assert result.svg.count("M") == 3  # two subpaths in the merged path, one in the other


def test_adjacent_merge_will_not_reach_across_a_different_fill():
    """Merging across a path stacked between two same-fill paths could change what covers what."""
    result = optimize_svg(
        svg_of(
            square(0, 0, 30, "#ff0000"),
            square(10, 10, 30, "#0000ff"),
            square(40, 40, 30, "#ff0000"),
        ),
        VectorizeParamsV2(merge_same_fill="adjacent"),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 3
    assert result.index_map == {0: 0, 1: 1, 2: 2}


def test_merge_all_does_reach_across_and_lands_on_the_first_occurrence():
    result = optimize_svg(
        svg_of(
            square(0, 0, 30, "#ff0000"),
            square(10, 10, 30, "#0000ff"),
            square(40, 40, 30, "#ff0000"),
        ),
        VectorizeParamsV2(merge_same_fill="all"),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 2
    assert result.index_map == {0: 0, 1: 1, 2: 0}
    assert fills_of(result.svg) == ["#ff0000", "#0000ff"]


def test_merge_none_keeps_every_path():
    result = optimize_svg(
        svg_of(square(0, 0, 30, "#ff0000"), square(40, 0, 30, "#ff0000")),
        VectorizeParamsV2(merge_same_fill="none"),
        width=100,
        height=100,
    )
    assert len(paths_of(result.svg)) == 2
    assert result.index_map == {0: 0, 1: 1}


def test_allow_merge_false_overrides_the_param():
    result = optimize_svg(
        svg_of(square(0, 0, 30, "#ff0000"), square(40, 0, 30, "#ff0000")),
        VectorizeParamsV2(merge_same_fill="all"),
        width=100,
        height=100,
        allow_merge=False,
    )
    assert len(paths_of(result.svg)) == 2


def test_merge_reads_fill_from_style_the_same_way_the_frontend_does():
    paths = (
        '<path d="M0 0 L30 0 L30 30 L0 30 Z" style="fill:#ff0000"/>',
        '<path d="M40 0 L70 0 L70 30 L40 30 Z" fill="#ff0000"/>',
    )
    result = optimize_svg(svg_of(*paths), VectorizeParamsV2(merge_same_fill="adjacent"), width=100, height=100)
    assert len(paths_of(result.svg)) == 1


# --- index map / region indices ----------------------------------------------------------


def test_region_indices_are_rewritten_to_match_the_new_order():
    paths = (
        f'<path d="M0 0 L1 0 L1 1 L0 1 Z" fill="#ff0000" data-region-index="0"/>',  # dropped speck
        f'<path d="M0 0 L40 0 L40 40 L0 40 Z" fill="#00ff00" data-region-index="1"/>',
        f'<path d="M50 50 L90 50 L90 90 L50 90 Z" fill="#0000ff" data-region-index="2"/>',
    )
    result = optimize_svg(svg_of(*paths), VectorizeParamsV2(min_path_area=16.0), width=100, height=100)
    assert result.index_map == {1: 0, 2: 1}
    assert re.findall(r'data-region-index="(\d+)"', result.svg) == ["0", "1"]


def test_index_map_covers_every_surviving_source_path():
    result = optimize_svg(
        svg_of(*[square(i * 10, 0, 8, f"#00000{i}") for i in range(6)]), DEFAULTS, width=100, height=100
    )
    assert set(result.index_map) == set(range(6))
    assert set(result.index_map.values()) == set(range(len(paths_of(result.svg))))
