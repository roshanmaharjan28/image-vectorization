"""Path-data geometry for v2's postprocess stage: parse a `d` string down to one flat
representation (polyline contours), clean it up, and re-emit it as compact path data.

Everything here is pure geometry over plain floats - no numpy, no SVG-document awareness - so it
can be reasoned about and tested on its own. postprocess.py owns the document-level work
(attributes, merging, rebuilding the file).

Why flatten-then-refit rather than editing vtracer's curves in place: vtracer emits *every* segment
as a cubic (straight runs included), and there is no local edit that turns "12 cubics tracing a
staircase" into "one smooth curve". So the pipeline is:

    flatten to a polyline  ->  RDP to find the structure  ->  fit cubics through the dense points

The middle step decides *where the corners are* (a staircase collapses to one straight run; a real
corner survives), and the last step decides *how many curves it takes* to follow the original
points within a stated error. Splitting the job that way is what keeps a smooth arc down to one or
two cubics while still holding a hard corner sharp.

The fitter is the standard least-squares-with-fixed-tangents fit plus recursive splitting at the
worst point (Schneider's algorithm): every emitted curve is within `max_error` px of the flattened
contour, and no more curves are emitted than that bound requires. Simply refitting one cubic per
surviving RDP vertex, the obvious alternative, has no error bound in either direction - it emits
dozens of segments for a smooth arc and can still miss the shape.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

Point = tuple[float, float]

# One emitted segment: ("L", x, y) or ("C", x1, y1, x2, y2, x, y). Absolute, like everything v2
# emits - the frontend's path editor and the grouping bbox parser both read absolute M/L/C/Q/Z.
Segment = tuple

# Spacing used when sampling a cubic into a polyline. Half a pixel: fine enough that the fitter's
# error bound, not the sampling, decides the final accuracy.
FLATTEN_STEP_PX = 0.5
MAX_CURVE_SAMPLES = 24
# Long straight segments get sampled too, coarsely. Not for accuracy - a line needs no samples to
# be reproduced - but because the fitter only measures error *at input vertices*: give it a run
# that is one corner plus a 150px edge holding two vertices, and a curve that bulges far outside
# the shape mid-edge still passes the error check. The inserted points are exactly collinear, so
# the simplify pass discards them again and they cost nothing in the output.
LINE_STEP_PX = 2.0
MAX_LINE_SAMPLES = 512
# Recursion limit for the fit-and-split. Reached only by pathological contours; hitting it emits a
# slightly-over-tolerance curve rather than looping.
MAX_FIT_DEPTH = 12
# Newton-Raphson passes over a run's parameters before giving up and splitting it. Three is the
# usual recommendation: the step converges fast, and a run that is still out of tolerance after
# three passes genuinely needs to be two curves.
REPARAM_ITERATIONS = 3

_TOKEN_RE = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)")
_NUM_RE = re.compile(r"[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?")
_ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}


@dataclass
class Contour:
    """A flattened subpath: polyline vertices with no repeated closing vertex."""

    points: list[Point]
    closed: bool

    def area(self) -> float:
        """Signed shoelace area (positive = counter-clockwise in SVG's y-down space)."""
        pts = self.points
        n = len(pts)
        if n < 3:
            return 0.0
        total = 0.0
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            total += x0 * y1 - x1 * y0
        return total / 2.0


def parse_path_d(d: str, offset: Point = (0.0, 0.0)) -> list[Contour] | None:
    """Flattens `d` into contours, translated by `offset` (vtracer puts each path's position in a
    `transform="translate(...)"` and emits `d` relative to it; folding that in here is what lets
    the rest of the pipeline treat coordinates as absolute).

    Returns None - meaning "don't touch this path" - for anything this parser can't represent
    losslessly as a polyline: elliptical arcs, or malformed data. Callers pass such paths through
    verbatim rather than guessing.
    """
    if not d:
        return None

    ox, oy = offset
    contours: list[Contour] = []
    current: list[Point] = []
    cx = cy = 0.0
    sx = sy = 0.0
    last_ctrl: Point | None = None
    prev_type = ""

    def close_current(closed: bool) -> None:
        nonlocal current
        if len(current) >= 2:
            deduped = _dedupe(current)
            if len(deduped) >= 2:
                contours.append(Contour(points=deduped, closed=closed))
        current = []

    for letter, raw in _TOKEN_RE.findall(d):
        upper = letter.upper()
        rel = letter.islower()

        if upper == "Z":
            close_current(True)
            cx, cy = sx, sy
            prev_type = "Z"
            last_ctrl = None
            continue

        if upper == "A":
            return None

        arity = _ARITY.get(upper)
        if arity is None:
            return None

        nums = [float(n) for n in _NUM_RE.findall(raw)]
        if not nums or len(nums) % arity != 0:
            return None

        for i in range(0, len(nums), arity):
            args = nums[i : i + arity]
            # A moveto's 2nd+ coordinate pair is an implicit lineto (SVG spec).
            eff = "L" if upper == "M" and i > 0 else upper

            if eff == "M":
                close_current(False)
                cx = cx + args[0] if rel else args[0]
                cy = cy + args[1] if rel else args[1]
                sx, sy = cx, cy
                current = [(cx + ox, cy + oy)]
                last_ctrl = None
            elif eff in ("L", "H", "V"):
                if eff == "H":
                    cx = cx + args[0] if rel else args[0]
                elif eff == "V":
                    cy = cy + args[0] if rel else args[0]
                else:
                    cx = cx + args[0] if rel else args[0]
                    cy = cy + args[1] if rel else args[1]
                current.extend(_flatten_line(current[-1] if current else (cx + ox, cy + oy), (cx + ox, cy + oy)))
                last_ctrl = None
            elif eff in ("C", "S"):
                if eff == "C":
                    x1 = cx + args[0] if rel else args[0]
                    y1 = cy + args[1] if rel else args[1]
                    x2 = cx + args[2] if rel else args[2]
                    y2 = cy + args[3] if rel else args[3]
                    ex = cx + args[4] if rel else args[4]
                    ey = cy + args[5] if rel else args[5]
                else:
                    # S reflects the previous curve's trailing control point through the current
                    # point; with no previous curve the control point is the current point.
                    if last_ctrl is not None and prev_type in ("C", "S"):
                        x1, y1 = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                    else:
                        x1, y1 = cx, cy
                    x2 = cx + args[0] if rel else args[0]
                    y2 = cy + args[1] if rel else args[1]
                    ex = cx + args[2] if rel else args[2]
                    ey = cy + args[3] if rel else args[3]
                current.extend(
                    _flatten_cubic(
                        (cx + ox, cy + oy),
                        (x1 + ox, y1 + oy),
                        (x2 + ox, y2 + oy),
                        (ex + ox, ey + oy),
                    )
                )
                last_ctrl = (x2, y2)
                cx, cy = ex, ey
            elif eff in ("Q", "T"):
                if eff == "Q":
                    qx = cx + args[0] if rel else args[0]
                    qy = cy + args[1] if rel else args[1]
                    ex = cx + args[2] if rel else args[2]
                    ey = cy + args[3] if rel else args[3]
                else:
                    if last_ctrl is not None and prev_type in ("Q", "T"):
                        qx, qy = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                    else:
                        qx, qy = cx, cy
                    ex = cx + args[0] if rel else args[0]
                    ey = cy + args[1] if rel else args[1]
                # Exact quadratic -> cubic elevation, then flatten as a cubic.
                c1 = (cx + 2.0 / 3.0 * (qx - cx), cy + 2.0 / 3.0 * (qy - cy))
                c2 = (ex + 2.0 / 3.0 * (qx - ex), ey + 2.0 / 3.0 * (qy - ey))
                current.extend(
                    _flatten_cubic(
                        (cx + ox, cy + oy),
                        (c1[0] + ox, c1[1] + oy),
                        (c2[0] + ox, c2[1] + oy),
                        (ex + ox, ey + oy),
                    )
                )
                last_ctrl = (qx, qy)
                cx, cy = ex, ey
            prev_type = eff

    close_current(False)
    return contours


def build_segments(
    contour: Contour,
    *,
    tolerance: float,
    smooth: bool,
    corner_angle: float,
    max_error: float,
    straight_eps: float = 0.02,
) -> tuple[Point, list[Segment]]:
    """Turns a flattened contour into (start_point, segments).

    `tolerance` is the RDP distance that decides which vertices count as structure; `corner_angle`
    is the turn (degrees) above which a surviving vertex is a real corner and stays sharp;
    `max_error` bounds how far an emitted cubic may sit from the flattened contour. With
    `smooth=False` the kept vertices are emitted as a polygon and `max_error` is unused.

    The returned start point is not necessarily `contour.points[0]`: a closed contour is re-cut to
    begin at its first corner, so the seam between the last and first segment lands on a vertex
    that was going to be sharp anyway.
    """
    dense = contour.points
    if len(dense) < 2:
        return (dense[0] if dense else (0.0, 0.0)), []

    kept = _structure_indices(dense, contour.closed, tolerance)
    if len(kept) < 2:
        return dense[0], []

    if not smooth:
        points = [dense[i] for i in kept]
        tail = points[1:] + ([points[0]] if contour.closed else [])
        return points[0], [("L", x, y) for x, y in tail]

    corner_flags = _corner_flags([dense[i] for i in kept], contour.closed, corner_angle)
    corners = [kept[i] for i, flag in enumerate(corner_flags) if flag]

    if not contour.closed:
        boundaries = sorted({kept[0], *corners, kept[-1]})
        segments: list[Segment] = []
        for a, b in zip(boundaries, boundaries[1:]):
            segments.extend(_fit_run(dense[a : b + 1], max_error, straight_eps, closed_seam=False))
        return dense[boundaries[0]], segments

    if not corners:
        # No corner anywhere: fit the whole ring as one run whose two ends share a tangent, so the
        # seam is as smooth as any other point on the curve.
        ring = dense + [dense[0]]
        return dense[0], _fit_run(ring, max_error, straight_eps, closed_seam=True)

    segments = []
    for a, b in zip(corners, corners[1:] + corners[:1]):
        run = _wrap_slice(dense, a, b)
        segments.extend(_fit_run(run, max_error, straight_eps, closed_seam=False))
    return dense[corners[0]], segments


def serialize(paths: list[tuple[Point, list[Segment], bool]], precision: int) -> str:
    """Emits `d` for a whole path element: a list of (start_point, segments, closed) subpaths.

    Repeated command letters are elided (SVG's implicit-repetition rule), and a closed subpath
    whose last segment is a straight run back to its start drops that L in favour of Z.
    """
    out: list[str] = []
    for start, segments, closed in paths:
        if not segments:
            continue
        emit = list(segments)
        if (
            closed
            and emit[-1][0] == "L"
            and _close_enough((emit[-1][1], emit[-1][2]), start, 10.0**-precision)
        ):
            emit.pop()
        if not emit:
            continue
        out.append(f"M{_fmt(start[0], precision)} {_fmt(start[1], precision)}")
        prev_cmd = "M"
        for seg in emit:
            cmd, coords = seg[0], seg[1:]
            nums = " ".join(_fmt(v, precision) for v in coords)
            out.append(nums if cmd == prev_cmd else f"{cmd}{nums}")
            prev_cmd = cmd
        if closed:
            out.append("Z")
            prev_cmd = "Z"
    return " ".join(out)


# --- flattening --------------------------------------------------------------------------


def _dedupe(points: list[Point]) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if not out or _dist2(out[-1], p) > 1e-12:
            out.append(p)
    if len(out) > 2 and _dist2(out[0], out[-1]) <= 1e-12:
        out.pop()
    return out


def _flatten_cubic(p0: Point, p1: Point, p2: Point, p3: Point) -> list[Point]:
    """Samples a cubic at roughly FLATTEN_STEP_PX spacing, excluding p0 (already emitted)."""
    hull = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
    steps = int(min(MAX_CURVE_SAMPLES, max(1, math.ceil(hull / FLATTEN_STEP_PX))))
    out: list[Point] = []
    for i in range(1, steps + 1):
        out.append(_bezier_at(p0, p1, p2, p3, i / steps))
    return out


def _flatten_line(start: Point, end: Point) -> list[Point]:
    """Samples a straight run at roughly LINE_STEP_PX spacing, excluding `start`. See
    LINE_STEP_PX for why a line gets sampled at all."""
    length = math.dist(start, end)
    steps = int(min(MAX_LINE_SAMPLES, max(1, math.ceil(length / LINE_STEP_PX))))
    return [
        (start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps)
        for i in range(1, steps + 1)
    ]


def _bezier_at(p0: Point, p1: Point, p2: Point, p3: Point, t: float) -> Point:
    mt = 1.0 - t
    a = mt * mt * mt
    b = 3 * mt * mt * t
    c = 3 * mt * t * t
    e = t * t * t
    return (
        a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
    )


# --- structure: which vertices matter ----------------------------------------------------


def _structure_indices(dense: list[Point], closed: bool, tolerance: float) -> list[int]:
    """Indices into `dense` of the vertices RDP keeps, ascending."""
    n = len(dense)
    if tolerance <= 0 or n < 4:
        return list(range(n))

    if not closed:
        return _rdp_indices(dense, tolerance, 0, n - 1)

    # A closed ring has no natural endpoints to anchor RDP on, so pin two far-apart vertices (the
    # extreme point plus whatever is farthest from it) and simplify the two arcs between them.
    # Without this the ring's arbitrary start vertex would always survive, and a badly placed one
    # distorts the result.
    anchor = max(range(n), key=lambda i: dense[i][0] * dense[i][0] + dense[i][1] * dense[i][1])
    rotated = dense[anchor:] + dense[:anchor]
    far = max(range(1, n), key=lambda i: _dist2(rotated[0], rotated[i]))
    first = _rdp_indices(rotated, tolerance, 0, far)
    second = _rdp_indices(rotated + [rotated[0]], tolerance, far, n)
    kept_rotated = sorted({*first, *(i % n for i in second)})
    kept = sorted((i + anchor) % n for i in kept_rotated)
    return kept if len(kept) >= 3 else list(range(n))


def _rdp_indices(points: list[Point], tolerance: float, start: int, end: int) -> list[int]:
    keep = {start, end}
    stack = [(start, end)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        worst = -1.0
        worst_i = -1
        for i in range(lo + 1, hi):
            dist = _point_segment_distance(points[i], points[lo], points[hi])
            if dist > worst:
                worst = dist
                worst_i = i
        if worst > tolerance:
            keep.add(worst_i)
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    return sorted(keep)


def _point_segment_distance(p: Point, a: Point, b: Point) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 <= 1e-18:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.dist(p, (ax + t * dx, ay + t * dy))


def _corner_flags(points: list[Point], closed: bool, corner_angle: float) -> list[bool]:
    n = len(points)
    flags = [False] * n
    threshold = math.radians(max(0.0, min(180.0, corner_angle)))
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            continue
        prev = points[i - 1] if i > 0 else points[-1]
        nxt = points[(i + 1) % n]
        v1 = (points[i][0] - prev[0], points[i][1] - prev[1])
        v2 = (nxt[0] - points[i][0], nxt[1] - points[i][1])
        n1 = math.hypot(*v1)
        n2 = math.hypot(*v2)
        if n1 < 1e-9 or n2 < 1e-9:
            continue
        cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
        if math.acos(cos) > threshold:
            flags[i] = True
    return flags


def _wrap_slice(points: list[Point], a: int, b: int) -> list[Point]:
    """The run from index `a` forward to index `b`, wrapping (and covering the whole ring when
    a == b, which is the single-corner case)."""
    if a < b:
        return points[a : b + 1]
    return points[a:] + points[: b + 1]


# --- fitting -----------------------------------------------------------------------------


def _fit_run(
    run: list[Point], max_error: float, straight_eps: float, *, closed_seam: bool
) -> list[Segment]:
    """Fits one run of dense points with as few cubics as `max_error` allows.

    `closed_seam` is for a corner-free closed ring fitted end-to-end: the tangent at both ends is
    taken across the seam so the join is smooth, instead of from the run's own first/last pair,
    which would put a kink there.
    """
    points = _dedupe_run(run)
    n = len(points)
    if n < 2:
        return []
    if n == 2:
        return [("L", points[1][0], points[1][1])]

    if closed_seam:
        through = _unit((points[1][0] - points[-2][0], points[1][1] - points[-2][1]))
        t_start = through
        t_end = (-through[0], -through[1])
    else:
        t_start = _end_tangent(points)
        t_end = _end_tangent(points[::-1])

    return _fit_cubic(points, t_start, t_end, max_error, straight_eps, 0)


def _end_tangent(points: list[Point]) -> Point:
    """Outward tangent at points[0], from the three-point one-sided difference
    (-3p0 + 4p1 - p2) / 2.

    The obvious estimate - the direction to the next point - is off by half the turn between them,
    which sounds negligible and is not: on a contour sampled every few px, that bias tilts the
    fitted curve enough to cost about a pixel of accuracy near the ends, and the fitter then splits
    the run to compensate. This estimate is second-order accurate, so a quarter-circle arc fits in
    one cubic instead of three.
    """
    if len(points) >= 3:
        estimate = (
            -3.0 * points[0][0] + 4.0 * points[1][0] - points[2][0],
            -3.0 * points[0][1] + 4.0 * points[1][1] - points[2][1],
        )
        unit = _unit(estimate)
        if unit != (0.0, 0.0):
            return unit
    return _unit((points[1][0] - points[0][0], points[1][1] - points[0][1]))


def _fit_cubic(
    points: list[Point],
    t_start: Point,
    t_end: Point,
    max_error: float,
    straight_eps: float,
    depth: int,
) -> list[Segment]:
    n = len(points)
    if n < 2:
        return []
    if n == 2:
        return [("L", points[1][0], points[1][1])]

    p0, p3 = points[0], points[-1]
    params = _chord_params(points)
    c1, c2 = _control_points(points, params, p0, p3, t_start, t_end)
    worst, worst_i = _max_error(points, params, p0, c1, c2, p3)

    # Chord-length parameters are only a guess at where each point sits along the curve, and the
    # mismatch shows up as error concentrated near the run's ends - which would make the split
    # below cut off a sliver instead of halving the run, cascading into far more segments than the
    # shape needs. Pulling each parameter onto its closest point (Newton-Raphson) turns the
    # measurement into an honest geometric one, so both the accept/reject decision and the split
    # location are made on the real error.
    for _ in range(REPARAM_ITERATIONS):
        if worst <= max_error:
            break
        params = _reparameterize(points, params, p0, c1, c2, p3)
        c1, c2 = _control_points(points, params, p0, p3, t_start, t_end)
        worst, worst_i = _max_error(points, params, p0, c1, c2, p3)

    if worst <= max_error or depth >= MAX_FIT_DEPTH or n <= 3:
        chord1 = (p0[0] + (p3[0] - p0[0]) / 3.0, p0[1] + (p3[1] - p0[1]) / 3.0)
        chord2 = (p0[0] + 2.0 * (p3[0] - p0[0]) / 3.0, p0[1] + 2.0 * (p3[1] - p0[1]) / 3.0)
        if math.dist(c1, chord1) <= straight_eps and math.dist(c2, chord2) <= straight_eps:
            return [("L", p3[0], p3[1])]
        return [("C", c1[0], c1[1], c2[0], c2[1], p3[0], p3[1])]

    # Split at the worst point and refit both halves, sharing a centred tangent so the two curves
    # meet smoothly there.
    mid = _unit(
        (points[worst_i + 1][0] - points[worst_i - 1][0], points[worst_i + 1][1] - points[worst_i - 1][1])
    )
    left = _fit_cubic(
        points[: worst_i + 1], t_start, (-mid[0], -mid[1]), max_error, straight_eps, depth + 1
    )
    right = _fit_cubic(points[worst_i:], mid, t_end, max_error, straight_eps, depth + 1)
    return left + right


def _control_points(
    points: list[Point],
    params: list[float],
    p0: Point,
    p3: Point,
    t_start: Point,
    t_end: Point,
) -> tuple[Point, Point]:
    alpha1, alpha2 = _solve_alphas(points, params, p0, p3, t_start, t_end)
    return (
        (p0[0] + t_start[0] * alpha1, p0[1] + t_start[1] * alpha1),
        (p3[0] + t_end[0] * alpha2, p3[1] + t_end[1] * alpha2),
    )


def _max_error(
    points: list[Point], params: list[float], p0: Point, c1: Point, c2: Point, p3: Point
) -> tuple[float, int]:
    """Worst point-to-curve distance and where it happens. The index is clamped to the interior so
    a split always leaves at least two points on each side."""
    worst = -1.0
    worst_i = max(1, len(points) // 2)
    for i in range(1, len(points) - 1):
        dist = math.dist(_bezier_at(p0, c1, c2, p3, params[i]), points[i])
        if dist > worst:
            worst = dist
            worst_i = i
    return worst, min(max(worst_i, 1), len(points) - 2)


def _reparameterize(
    points: list[Point], params: list[float], p0: Point, c1: Point, c2: Point, p3: Point
) -> list[float]:
    """One Newton-Raphson step per point towards the parameter whose curve position is closest to
    it: the root of (Q(u) - p) . Q'(u) = 0."""
    updated: list[float] = []
    for point, u in zip(points, params):
        q = _bezier_at(p0, c1, c2, p3, u)
        d1 = _bezier_derivative(p0, c1, c2, p3, u)
        d2 = _bezier_second_derivative(p0, c1, c2, p3, u)
        dx, dy = q[0] - point[0], q[1] - point[1]
        numerator = dx * d1[0] + dy * d1[1]
        denominator = dx * d2[0] + dy * d2[1] + d1[0] * d1[0] + d1[1] * d1[1]
        if abs(denominator) < 1e-12:
            updated.append(u)
            continue
        updated.append(min(1.0, max(0.0, u - numerator / denominator)))
    updated[0] = 0.0
    updated[-1] = 1.0
    return updated


def _bezier_derivative(p0: Point, c1: Point, c2: Point, p3: Point, u: float) -> Point:
    mt = 1.0 - u
    return (
        3.0 * ((c1[0] - p0[0]) * mt * mt + 2.0 * (c2[0] - c1[0]) * mt * u + (p3[0] - c2[0]) * u * u),
        3.0 * ((c1[1] - p0[1]) * mt * mt + 2.0 * (c2[1] - c1[1]) * mt * u + (p3[1] - c2[1]) * u * u),
    )


def _bezier_second_derivative(p0: Point, c1: Point, c2: Point, p3: Point, u: float) -> Point:
    mt = 1.0 - u
    return (
        6.0 * ((c2[0] - 2.0 * c1[0] + p0[0]) * mt + (p3[0] - 2.0 * c2[0] + c1[0]) * u),
        6.0 * ((c2[1] - 2.0 * c1[1] + p0[1]) * mt + (p3[1] - 2.0 * c2[1] + c1[1]) * u),
    )


def _solve_alphas(
    points: list[Point],
    params: list[float],
    p0: Point,
    p3: Point,
    t_start: Point,
    t_end: Point,
) -> tuple[float, float]:
    """Least-squares tangent magnitudes for a cubic pinned at p0/p3 with fixed tangent
    directions - the 2x2 normal equations from the standard curve-fitting formulation."""
    c11 = c12 = c22 = x1 = x2 = 0.0
    for point, u in zip(points, params):
        mt = 1.0 - u
        b1 = 3.0 * u * mt * mt
        b2 = 3.0 * u * u * mt
        b0 = mt * mt * mt
        b3 = u * u * u
        a1 = (t_start[0] * b1, t_start[1] * b1)
        a2 = (t_end[0] * b2, t_end[1] * b2)
        base = (
            p0[0] * (b0 + b1) + p3[0] * (b2 + b3),
            p0[1] * (b0 + b1) + p3[1] * (b2 + b3),
        )
        rx, ry = point[0] - base[0], point[1] - base[1]
        c11 += a1[0] * a1[0] + a1[1] * a1[1]
        c12 += a1[0] * a2[0] + a1[1] * a2[1]
        c22 += a2[0] * a2[0] + a2[1] * a2[1]
        x1 += a1[0] * rx + a1[1] * ry
        x2 += a2[0] * rx + a2[1] * ry

    det = c11 * c22 - c12 * c12
    chord = math.dist(p0, p3)
    if abs(det) < 1e-12:
        fallback = chord / 3.0
        return fallback, fallback

    alpha1 = (c22 * x1 - c12 * x2) / det
    alpha2 = (c11 * x2 - c12 * x1) / det
    # A negative magnitude folds the curve back on itself, and an oversized one lets it bulge or
    # loop well outside the contour while still passing close to every sampled point - which the
    # error check, being sampled, would not catch. Anything past 1.5x the chord is past what a
    # genuine arc needs (a semicircle wants 0.67x), so an out-of-range solve falls back to the
    # chord default: a worse fit, which the caller then splits, rather than a wrong shape.
    limit = chord * 1.5 + 1e-9
    if not (0.0 <= alpha1 <= limit) or not (0.0 <= alpha2 <= limit):
        fallback = chord / 3.0
        return fallback, fallback
    return alpha1, alpha2


def _chord_params(points: list[Point]) -> list[float]:
    """Chord-length parameterization of the run over [0, 1]."""
    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.dist(a, b))
    total = cumulative[-1]
    if total <= 1e-12:
        span = max(1, len(points) - 1)
        return [i / span for i in range(len(points))]
    return [value / total for value in cumulative]


def _dedupe_run(points: list[Point]) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if not out or _dist2(out[-1], p) > 1e-18:
            out.append(p)
    return out


# --- small helpers -----------------------------------------------------------------------


def _unit(v: Point) -> Point:
    length = math.hypot(v[0], v[1])
    if length < 1e-12:
        return (0.0, 0.0)
    return (v[0] / length, v[1] / length)


def _dist2(a: Point, b: Point) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _close_enough(a: Point, b: Point, eps: float) -> bool:
    return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps


def _fmt(value: float, precision: int) -> str:
    text = f"{value:.{max(0, precision)}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0", "-") else text
