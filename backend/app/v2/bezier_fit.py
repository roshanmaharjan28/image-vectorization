"""Pure numpy port of Philip J. Schneider's piecewise cubic bezier curve
fitting algorithm (Graphics Gems, 1990) - the same algorithm underlying
Potrace's and Inkscape's curve fitting - adapted to fit CLOSED polygon loops.

No compiled/native dependency: this is deliberate, to avoid any Windows-wheel
build-toolchain risk (the same reasoning that led to using vtracer for v1
instead of hand-rolling a Rust curve fitter)."""

import numpy as np

_MAX_REPARAM_ITERATIONS = 4


def _normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    if norm < 1e-12:
        return np.zeros_like(v)
    return v / norm


def _q(ctrl, t: float) -> np.ndarray:
    return (
        (1 - t) ** 3 * ctrl[0]
        + 3 * (1 - t) ** 2 * t * ctrl[1]
        + 3 * (1 - t) * t ** 2 * ctrl[2]
        + t ** 3 * ctrl[3]
    )


def _q_prime(ctrl, t: float) -> np.ndarray:
    return (
        3 * (1 - t) ** 2 * (ctrl[1] - ctrl[0])
        + 6 * (1 - t) * t * (ctrl[2] - ctrl[1])
        + 3 * t ** 2 * (ctrl[3] - ctrl[2])
    )


def _q_prime_prime(ctrl, t: float) -> np.ndarray:
    return 6 * (1 - t) * (ctrl[2] - 2 * ctrl[1] + ctrl[0]) + 6 * t * (ctrl[3] - 2 * ctrl[2] + ctrl[1])


def _chord_length_parameterize(points: np.ndarray) -> np.ndarray:
    u = np.zeros(len(points))
    for i in range(1, len(points)):
        u[i] = u[i - 1] + np.linalg.norm(points[i] - points[i - 1])
    total = u[-1]
    if total < 1e-12:
        return np.linspace(0.0, 1.0, len(points))
    return u / total


def _generate_bezier(points: np.ndarray, params: np.ndarray, left_tangent: np.ndarray, right_tangent: np.ndarray):
    p0, p3 = points[0], points[-1]

    a = np.zeros((len(params), 2, 2))
    for i, u in enumerate(params):
        a[i][0] = left_tangent * 3 * (1 - u) ** 2 * u
        a[i][1] = right_tangent * 3 * (1 - u) * u ** 2

    c = np.zeros((2, 2))
    x = np.zeros(2)
    for i, u in enumerate(params):
        c[0][0] += np.dot(a[i][0], a[i][0])
        c[0][1] += np.dot(a[i][0], a[i][1])
        c[1][0] = c[0][1]
        c[1][1] += np.dot(a[i][1], a[i][1])

        shortcut = ((1 - u) ** 3 + 3 * (1 - u) ** 2 * u) * p0 + (3 * (1 - u) * u ** 2 + u ** 3) * p3
        tmp = points[i] - shortcut
        x[0] += np.dot(a[i][0], tmp)
        x[1] += np.dot(a[i][1], tmp)

    det_c0_c1 = c[0][0] * c[1][1] - c[1][0] * c[0][1]
    det_c0_x = c[0][0] * x[1] - c[1][0] * x[0]
    det_x_c1 = x[0] * c[1][1] - x[1] * c[0][1]

    alpha_l = 0.0 if abs(det_c0_c1) < 1e-12 else det_x_c1 / det_c0_c1
    alpha_r = 0.0 if abs(det_c0_c1) < 1e-12 else det_c0_x / det_c0_c1

    seg_length = np.linalg.norm(p0 - p3)
    epsilon = 1e-6 * max(seg_length, 1e-6)
    if alpha_l < epsilon or alpha_r < epsilon:
        alpha_l = alpha_r = seg_length / 3.0

    return [p0, p0 + left_tangent * alpha_l, p3 + right_tangent * alpha_r, p3]


def _compute_max_error(points: np.ndarray, bez, params: np.ndarray):
    max_dist = 0.0
    split_point = len(points) // 2
    for i, (point, u) in enumerate(zip(points, params)):
        dist = float(np.sum((_q(bez, u) - point) ** 2))
        if dist > max_dist:
            max_dist = dist
            split_point = i
    return max_dist, split_point


def _reparameterize(bez, points: np.ndarray, params: np.ndarray) -> np.ndarray:
    new_params = np.empty_like(params)
    for i, (point, u) in enumerate(zip(points, params)):
        qu = _q(bez, u)
        qprime_u = _q_prime(bez, u)
        qprimeprime_u = _q_prime_prime(bez, u)
        numerator = np.dot(qu - point, qprime_u)
        denominator = np.dot(qprime_u, qprime_u) + np.dot(qu - point, qprimeprime_u)
        new_params[i] = u if abs(denominator) < 1e-12 else u - numerator / denominator
    return new_params


def _fit_cubic(points: np.ndarray, left_tangent: np.ndarray, right_tangent: np.ndarray, max_error: float) -> list:
    if len(points) == 2:
        dist = np.linalg.norm(points[0] - points[1]) / 3.0
        bez = [points[0], points[0] + left_tangent * dist, points[1] + right_tangent * dist, points[1]]
        return [bez]

    params = _chord_length_parameterize(points)
    bez = _generate_bezier(points, params, left_tangent, right_tangent)
    max_dist, split_point = _compute_max_error(points, bez, params)

    if max_dist < max_error:
        return [bez]

    if max_dist < max_error ** 2:
        for _ in range(_MAX_REPARAM_ITERATIONS):
            params = _reparameterize(bez, points, params)
            bez = _generate_bezier(points, params, left_tangent, right_tangent)
            max_dist, split_point = _compute_max_error(points, bez, params)
            if max_dist < max_error:
                return [bez]

    split_point = min(max(split_point, 1), len(points) - 2)
    center_tangent = _normalize(points[split_point - 1] - points[split_point + 1])
    left = _fit_cubic(points[: split_point + 1], left_tangent, center_tangent, max_error)
    right = _fit_cubic(points[split_point:], -center_tangent, right_tangent, max_error)
    return left + right


def fit_curve_closed(points: np.ndarray, max_error: float) -> list:
    """points: Nx2, treated as a CLOSED loop (points[-1] wraps to points[0]).
    Returns a list of 4x2 arrays [P0,P1,P2,P3] (cubic bezier control points);
    consecutive segments share endpoints (segment[i][3] == segment[i+1][0]),
    together tracing one closed loop back to points[0]."""
    points = np.asarray(points, dtype=np.float64)
    n = len(points)
    if n < 3:
        return []

    seq = np.vstack([points, points[0:1]])

    # Central-difference tangent at the shared seam point, so the curve is
    # smooth (matched incoming/outgoing direction) where the loop closes.
    seam_tangent = _normalize(points[1] - points[-1])
    left_tangent = seam_tangent
    right_tangent = -seam_tangent

    segments = _fit_cubic(seq, left_tangent, right_tangent, max_error)
    return [np.array(seg) for seg in segments]
