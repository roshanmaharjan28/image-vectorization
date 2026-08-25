"""Geometry tests for v2's path rewriting.

The property that matters is the stated error bound: whatever the fitter emits must stay within
`max_error` of the contour it was given, in *both* directions - the emitted curve may not wander
away from the contour any more than the contour may wander from the curve. A one-directional check
passes happily on a curve that loops out of the shape and back through every sampled point, which
is exactly the failure this stage can produce.
"""

from __future__ import annotations

import math

import pytest

from app.v2 import pathdata
from app.v2.pathdata import Contour, build_segments, parse_path_d, serialize

FIT_KWARGS = dict(tolerance=0.6, smooth=True, corner_angle=62.0, max_error=0.8)


def _sample_segments(start, segments, per_segment: int = 48) -> list[tuple[float, float]]:
    points = [start]
    current = start
    for segment in segments:
        if segment[0] == "L":
            end = (segment[1], segment[2])
            points += [
                (
                    current[0] + (end[0] - current[0]) * i / per_segment,
                    current[1] + (end[1] - current[1]) * i / per_segment,
                )
                for i in range(1, per_segment + 1)
            ]
        else:
            c1, c2, end = (segment[1], segment[2]), (segment[3], segment[4]), (segment[5], segment[6])
            points += [
                pathdata._bezier_at(current, c1, c2, end, i / per_segment)
                for i in range(1, per_segment + 1)
            ]
        current = end
    return points


def _distance_to_polyline(point, polyline, closed: bool) -> float:
    pairs = list(zip(polyline, polyline[1:]))
    if closed:
        pairs.append((polyline[-1], polyline[0]))
    return min(pathdata._point_segment_distance(point, a, b) for a, b in pairs)


def symmetric_error(contour: Contour, start, segments) -> float:
    """Max of both one-sided distances between the contour and the emitted geometry."""
    emitted = _sample_segments(start, segments)
    forward = max(_distance_to_polyline(p, emitted, contour.closed) for p in contour.points)
    backward = max(_distance_to_polyline(p, contour.points, contour.closed) for p in emitted)
    return max(forward, backward)


def _circle(radius: float, samples: int = 200, center=(200.0, 200.0)) -> Contour:
    return Contour(
        points=[
            (
                center[0] + radius * math.cos(2 * math.pi * i / samples),
                center[1] + radius * math.sin(2 * math.pi * i / samples),
            )
            for i in range(samples)
        ],
        closed=True,
    )


# --- parsing -----------------------------------------------------------------------------


def test_parse_folds_translate_into_coordinates():
    """vtracer emits `d` relative to a per-path translate(); the offset has to end up in the
    coordinates, or every path lands at the origin."""
    contours = parse_path_d("M0 0 L10 0 L10 10 L0 10 Z", (5.0, 7.0))
    assert contours is not None and len(contours) == 1
    xs = [x for x, _ in contours[0].points]
    ys = [y for _, y in contours[0].points]
    assert min(xs) == pytest.approx(5.0)
    assert min(ys) == pytest.approx(7.0)
    assert max(xs) == pytest.approx(15.0)
    assert max(ys) == pytest.approx(17.0)


def test_parse_rejects_arcs_and_garbage_rather_than_guessing():
    assert parse_path_d("M0 0 A5 5 0 0 1 10 10") is None
    assert parse_path_d("") is None
    assert parse_path_d("M0 0 L5") is None  # odd argument count


def test_parse_handles_relative_and_shorthand_commands():
    absolute = parse_path_d("M0 0 C5 0 10 5 10 10 C10 15 5 20 0 20 Z")
    relative = parse_path_d("m0 0 c5 0 10 5 10 10 s-5 10 -10 10 z")
    assert absolute is not None and relative is not None
    assert absolute[0].closed and relative[0].closed


def test_parse_splits_subpaths_and_marks_closure():
    contours = parse_path_d("M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30")
    assert contours is not None
    assert [c.closed for c in contours] == [True, False]


def test_implicit_lineto_after_moveto():
    contours = parse_path_d("M0 0 5 0 5 5 Z")
    assert contours is not None
    assert max(x for x, _ in contours[0].points) == pytest.approx(5.0)


def test_area_sign_follows_winding():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert Contour(points=square, closed=True).area() == pytest.approx(100.0)
    assert Contour(points=square[::-1], closed=True).area() == pytest.approx(-100.0)


# --- fitting -----------------------------------------------------------------------------


@pytest.mark.parametrize("radius", [4.0, 20.0, 100.0, 400.0])
def test_circle_fits_within_error_bound_with_few_curves(radius: float):
    contour = _circle(radius)
    start, segments = build_segments(contour, **FIT_KWARGS)
    assert symmetric_error(contour, start, segments) <= FIT_KWARGS["max_error"]
    # A circle is the canonical case for "few segments": four cubics is the textbook answer, and
    # anything above eight means the fitter is splitting when it should not.
    assert len(segments) <= 8


@pytest.mark.parametrize("max_error", [0.2, 0.5, 1.0, 2.0])
def test_error_bound_is_honoured_at_every_setting(max_error: float):
    contour = _circle(150.0)
    start, segments = build_segments(contour, **{**FIT_KWARGS, "max_error": max_error})
    assert symmetric_error(contour, start, segments) <= max_error


def test_tighter_bound_never_costs_accuracy_or_buys_fewer_segments():
    contour = _circle(150.0)
    loose = build_segments(contour, **{**FIT_KWARGS, "max_error": 2.0})
    tight = build_segments(contour, **{**FIT_KWARGS, "max_error": 0.2})
    assert len(tight[1]) >= len(loose[1])
    assert symmetric_error(contour, *tight) <= symmetric_error(contour, *loose)


def test_right_angles_survive_as_straight_lines():
    """An axis-aligned rectangle has to come back out as four lines - no rounded corners, no
    curves standing in for straight edges."""
    contour = parse_path_d("M0 0 C10 0 20 0 30 0 C30 10 30 20 30 30 C20 30 10 30 0 30 C0 20 0 10 0 0 Z")
    assert contour is not None
    start, segments = build_segments(contour[0], **FIT_KWARGS)
    assert [s[0] for s in segments] == ["L", "L", "L", "L"]
    assert symmetric_error(contour[0], start, segments) == pytest.approx(0.0, abs=1e-6)


def test_concave_corners_survive():
    ell = []
    for a, b in [
        ((0, 0), (60, 0)), ((60, 0), (60, 20)), ((60, 20), (20, 20)),
        ((20, 20), (20, 60)), ((20, 60), (0, 60)), ((0, 60), (0, 0)),
    ]:
        steps = int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) * 2)
        ell += [
            (a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)
            for i in range(steps)
        ]
    contour = Contour(points=[(float(x), float(y)) for x, y in ell], closed=True)
    start, segments = build_segments(contour, **FIT_KWARGS)
    assert len(segments) == 6
    assert symmetric_error(contour, start, segments) == pytest.approx(0.0, abs=1e-6)


def test_long_straight_edges_do_not_let_curves_bulge_out_of_shape():
    """A run made of one arc plus a long straight edge is where a sampled error check gets fooled:
    the edge contributes two vertices, so a curve can bulge far outside the shape between them and
    still measure as a good fit. Flattening samples straight runs to prevent exactly that."""
    d = ["M160 10"]
    for cx, cy, a0 in [
        (160, 40, -math.pi / 2), (160, 160, 0.0), (40, 160, math.pi / 2), (40, 40, math.pi),
    ]:
        d += [
            f"L{cx + 30 * math.cos(a0 + t * math.pi / 40):.4f} {cy + 30 * math.sin(a0 + t * math.pi / 40):.4f}"
            for t in range(21)
        ]
    d.append("Z")
    contours = parse_path_d(" ".join(d))
    assert contours is not None
    start, segments = build_segments(contours[0], **FIT_KWARGS)
    assert symmetric_error(contours[0], start, segments) <= FIT_KWARGS["max_error"]


def test_polygon_mode_emits_only_lines():
    contour = _circle(50.0)
    _start, segments = build_segments(contour, **{**FIT_KWARGS, "smooth": False})
    assert segments
    assert {s[0] for s in segments} == {"L"}


def test_degenerate_contours_emit_nothing_instead_of_raising():
    assert build_segments(Contour(points=[], closed=False), **FIT_KWARGS)[1] == []
    assert build_segments(Contour(points=[(1.0, 1.0)], closed=True), **FIT_KWARGS)[1] == []
    collapsed = Contour(points=[(5.0, 5.0)] * 4, closed=True)
    assert build_segments(collapsed, **FIT_KWARGS)[1] == []


# --- serialization -----------------------------------------------------------------------


def test_serialize_rounds_elides_repeated_commands_and_closes_with_z():
    start = (1.239, 2.0)
    segments = [("L", 10.0, 2.0), ("L", 10.0, 12.0), ("L", 1.239, 2.0)]
    d = serialize([(start, segments, True)], 2)
    assert d == "M1.24 2 L10 2 10 12 Z"


def test_serialize_keeps_a_curve_that_closes_the_subpath():
    start = (0.0, 0.0)
    segments = [("C", 1.0, 2.0, 3.0, 4.0, 0.0, 0.0)]
    assert serialize([(start, segments, True)], 1) == "M0 0 C1 2 3 4 0 0 Z"


def test_serialized_output_reparses_to_the_same_shape():
    contour = _circle(80.0)
    start, segments = build_segments(contour, **FIT_KWARGS)
    reparsed = parse_path_d(serialize([(start, segments, True)], 3))
    assert reparsed is not None and len(reparsed) == 1
    assert reparsed[0].area() == pytest.approx(contour.area(), rel=0.02)


def test_serialize_skips_empty_subpaths():
    assert serialize([((0.0, 0.0), [], True)], 2) == ""
