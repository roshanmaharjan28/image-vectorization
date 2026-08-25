"""Tests for the palette-snapping pass in v2's postprocess stage.

The pass exists because vtracer does not preserve the palette it is handed: given a raster with 59
distinct flat colours it emitted 5,420 distinct fills. That breaks the guarantee that `n_colors`
bounds the output's colour count, and it defeats `merge_same_fill`, which can only combine fills
that compare exactly equal.
"""

from __future__ import annotations

import dataclasses

from app.v2.params import VectorizeParamsV2
from app.v2.postprocess import optimize_svg

from .test_postprocess import fills_of, paths_of, square, svg_of

# BGR, the order the quantizer's palette uses.
RED_GREEN_BLUE = [(0, 0, 255), (0, 255, 0), (255, 0, 0)]

BASE = VectorizeParamsV2(min_path_area=0.0, simplify_tolerance=0.0)


def _run(svg: str, *, palette=RED_GREEN_BLUE, **overrides):
    return optimize_svg(
        svg,
        dataclasses.replace(BASE, **overrides),
        width=100,
        height=100,
        palette=palette,
    )


def test_a_near_palette_fill_snaps_onto_the_palette_entry():
    result = _run(svg_of(square(0, 0, 40, "#fe0102")))
    assert fills_of(result.svg) == ["#ff0000"]


def test_each_fill_snaps_to_its_own_nearest_entry():
    result = _run(
        svg_of(
            square(0, 0, 10, "#f80303"),
            square(20, 0, 10, "#03f803"),
            square(40, 0, 10, "#0303f8"),
        )
    )
    assert fills_of(result.svg) == ["#ff0000", "#00ff00", "#0000ff"]


def test_distinct_fills_never_exceed_the_palette():
    """The actual guarantee: whatever vtracer emitted, the document ends up with at most one fill
    per palette entry."""
    many = svg_of(
        *(
            square((i % 10) * 9, (i // 10) * 9, 8, "#%02x%02x%02x" % (250 - i, i, 4 + i))
            for i in range(40)
        )
    )
    result = _run(many)
    assert len(set(fills_of(result.svg))) <= len(RED_GREEN_BLUE)


def test_snapping_off_leaves_fills_untouched():
    result = _run(svg_of(square(0, 0, 40, "#fe0102")), snap_fills_to_palette=False)
    assert fills_of(result.svg) == ["#fe0102"]


def test_no_palette_leaves_fills_untouched():
    """A request with n_colors < 2 skips quantization, so there is no palette to snap onto - the
    pass has to be a no-op rather than guessing at one."""
    result = _run(svg_of(square(0, 0, 40, "#fe0102")), palette=[])
    assert fills_of(result.svg) == ["#fe0102"]


def test_non_hex_fills_are_left_alone():
    """A named colour, a gradient reference or "none" is not something to snap - v2 has no way to
    know what colour it resolves to, so it passes through rather than being guessed at."""
    result = _run(
        svg_of(
            '<path d="M0 0 L40 0 L40 40 L0 40 Z" fill="none"/>',
            '<path d="M50 0 L90 0 L90 40 L50 40 Z" fill="url(#grad)"/>',
        )
    )
    assert set(fills_of(result.svg)) == {"none", "url(#grad)"}


def test_snapping_is_what_lets_merge_all_collapse_a_document_per_colour():
    """The layer-count payoff. These five squares are three colours that differ by a unit or two,
    so before snapping every one is its own fill and nothing merges; after, there is one path per
    palette entry."""
    doc = svg_of(
        square(0, 0, 8, "#ff0000"),
        square(10, 0, 8, "#fe0101"),
        square(20, 0, 8, "#00ff00"),
        square(30, 0, 8, "#01fe01"),
        square(40, 0, 8, "#0000fe"),
    )

    unsnapped = _run(doc, snap_fills_to_palette=False, merge_same_fill="all")
    assert len(paths_of(unsnapped.svg)) == 5

    snapped = _run(doc, snap_fills_to_palette=True, merge_same_fill="all")
    assert len(paths_of(snapped.svg)) == 3
    assert set(fills_of(snapped.svg)) == {"#ff0000", "#00ff00", "#0000ff"}


def test_merged_paths_still_map_every_source_index():
    """Grouping addresses paths by document index, so collapsing five paths into three has to leave
    all five original indices pointing at whichever path absorbed them."""
    doc = svg_of(
        square(0, 0, 8, "#ff0000"),
        square(10, 0, 8, "#fe0101"),
        square(20, 0, 8, "#00ff00"),
        square(30, 0, 8, "#01fe01"),
        square(40, 0, 8, "#0000fe"),
    )
    result = _run(doc, merge_same_fill="all")

    assert set(result.index_map) == {0, 1, 2, 3, 4}
    assert set(result.index_map.values()) == {0, 1, 2}
    # the two reds landed on one path, as did the two greens
    assert result.index_map[0] == result.index_map[1]
    assert result.index_map[2] == result.index_map[3]


def test_snapping_runs_before_the_area_floor_can_be_confused_by_it():
    """Ordering guard: a path dropped for being too small must not first be snapped and merged into
    a survivor, which would keep its geometry alive under another path's fill."""
    doc = svg_of(square(0, 0, 40, "#fe0102"), square(90, 90, 1, "#ff0001"))
    result = _run(doc, min_path_area=16.0, merge_same_fill="all")

    assert len(paths_of(result.svg)) == 1
    assert 1 not in result.index_map
