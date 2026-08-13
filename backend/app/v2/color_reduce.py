import cv2
import numpy as np

from .params import VectorizeParamsV2


def reduce_colors(
    bgr: np.ndarray, opaque_mask: np.ndarray, params: VectorizeParamsV2
) -> tuple[np.ndarray, list[tuple[int, int, int]]]:
    """Returns (label_map, palette). label_map is HxW int32, -1 for pixels
    excluded by opaque_mask. palette[i] is the BGR color for label i, ordered
    by descending pixel count for a deterministic, stable ordering."""
    h, w = bgr.shape[:2]
    label_map = np.full((h, w), -1, dtype=np.int32)

    ys, xs = np.nonzero(opaque_mask)
    if ys.size == 0:
        return label_map, []

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    opaque_lab = lab[ys, xs].astype(np.float32)

    unique_colors = np.unique(opaque_lab, axis=0)
    effective_k = min(params.n_colors, unique_colors.shape[0])

    if effective_k <= 1:
        centers = opaque_lab.mean(axis=0, keepdims=True).astype(np.float32)
        labels_full = np.zeros(ys.size, dtype=np.int32)
    else:
        sample = opaque_lab
        if sample.shape[0] > params.kmeans_sample_cap:
            idx = np.random.default_rng(0).choice(
                sample.shape[0], params.kmeans_sample_cap, replace=False
            )
            sample = sample[idx]

        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _compactness, _sample_labels, centers = cv2.kmeans(
            sample, effective_k, None, criteria, 3, cv2.KMEANS_PP_CENTERS
        )
        # Assign every opaque pixel (not just the k-means sample) to its nearest center.
        dists = np.linalg.norm(opaque_lab[:, None, :] - centers[None, :, :], axis=2)
        labels_full = np.argmin(dists, axis=1).astype(np.int32)

    centers, labels_full = _merge_close_centers(centers, labels_full, params.palette_merge_distance)

    counts = np.bincount(labels_full, minlength=centers.shape[0])
    order = np.argsort(-counts)
    remap = np.empty_like(order)
    remap[order] = np.arange(order.size)

    label_map[ys, xs] = remap[labels_full]
    palette_bgr = _lab_centers_to_bgr(centers[order])

    return label_map, palette_bgr


def _merge_close_centers(
    centers: np.ndarray, labels: np.ndarray, merge_distance: float
) -> tuple[np.ndarray, np.ndarray]:
    """Greedily merges palette centers within merge_distance (Lab space) of each
    other, folding a k-means split of one visual color into a single entry."""
    if centers.shape[0] <= 1:
        return centers, labels

    centers = centers.copy()
    keep = list(range(centers.shape[0]))

    while len(keep) > 1:
        sub_centers = centers[keep]
        dists = np.linalg.norm(sub_centers[:, None, :] - sub_centers[None, :, :], axis=2)
        np.fill_diagonal(dists, np.inf)
        i, j = np.unravel_index(np.argmin(dists), dists.shape)
        if dists[i, j] >= merge_distance:
            break

        a, b = keep[i], keep[j]
        count_a = int(np.sum(labels == a))
        count_b = int(np.sum(labels == b))
        total = count_a + count_b
        if total > 0:
            centers[a] = (centers[a] * count_a + centers[b] * count_b) / total
        labels[labels == b] = a
        keep.remove(b)

    kept_centers = centers[keep]
    old_to_new = {old: new for new, old in enumerate(keep)}
    new_labels = np.array([old_to_new[label] for label in labels], dtype=np.int32)
    return kept_centers, new_labels


def _lab_centers_to_bgr(centers_lab: np.ndarray) -> list[tuple[int, int, int]]:
    lab_uint8 = np.clip(centers_lab, 0, 255).astype(np.uint8).reshape(-1, 1, 3)
    bgr_img = cv2.cvtColor(lab_uint8, cv2.COLOR_LAB2BGR)
    return [tuple(int(c) for c in bgr_img[i, 0]) for i in range(bgr_img.shape[0])]
