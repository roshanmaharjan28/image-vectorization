import cv2
import numpy as np


def simplify_polygon(points: np.ndarray, epsilon_frac: float) -> np.ndarray:
    """Douglas-Peucker simplification (cv2.approxPolyDP), epsilon scaled by the
    contour's own perimeter so it adapts to the shape's size. Falls back to the
    original points if simplification would degenerate the polygon below a
    triangle."""
    points = np.asarray(points, dtype=np.int32).reshape(-1, 1, 2)
    if points.shape[0] < 3:
        return points.reshape(-1, 2)

    perimeter = cv2.arcLength(points, closed=True)
    epsilon = max(epsilon_frac * perimeter, 0.0)
    simplified = cv2.approxPolyDP(points, epsilon, closed=True).reshape(-1, 2)

    if simplified.shape[0] > 1:
        keep = np.ones(simplified.shape[0], dtype=bool)
        keep[1:] = np.any(simplified[1:] != simplified[:-1], axis=1)
        simplified = simplified[keep]

    if simplified.shape[0] < 3:
        return points.reshape(-1, 2)

    return simplified
