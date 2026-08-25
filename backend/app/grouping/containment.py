from __future__ import annotations

import math
from dataclasses import dataclass, field

from .schema import BBox, GroupNode, LeafRef, TreeNode


@dataclass(frozen=True)
class ContainmentParams:
    area_ratio: float = 1.3  # container's bbox area must be >= this many times the contained one
    overlap_frac: float = 0.85  # fraction of the contained bbox's area that must sit inside


class IdAllocator:
    """A single shared counter so every group id — whether created for a top-level segment or a
    nested containment group, by either engine, in one grouping call — is globally unique.
    Frontend collapse-state and React keys are keyed by this id, so a collision would make
    unrelated groups collapse together."""

    def __init__(self, prefix: str = "grp"):
        self._prefix = prefix
        self._n = 0

    def next(self) -> str:
        self._n += 1
        return f"{self._prefix}{self._n}"


def _area(bbox: BBox) -> float:
    x0, y0, x1, y1 = bbox
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def _intersection_area(a: BBox, b: BBox) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def _contains(container: BBox, contained: BBox, params: ContainmentParams) -> bool:
    container_area = _area(container)
    contained_area = _area(contained)
    if container_area <= 0 or contained_area <= 0:
        return False
    if container_area < contained_area * params.area_ratio:
        return False
    return _intersection_area(container, contained) / contained_area >= params.overlap_frac


@dataclass(frozen=True)
class SegmentSpan:
    """One vectorized segment: `bbox` is used purely for containment nesting against sibling
    segments (e.g. a FastSAM mask fully inside another), and `leaf_indices` are the
    (already globally-numbered) path indices that segment's own masked vectorize call
    produced, in document order."""

    bbox: BBox
    leaf_indices: list[int] = field(default_factory=list)


def find_parents(bboxes: list[BBox], params: ContainmentParams) -> dict[int, int]:
    """For each bbox, finds the smallest-area *other* bbox that contains it (per `_contains`) and
    returns `{child_index: parent_index}` for every bbox that has one. Shared by
    `build_segment_forest` (nesting already-final segments into a display tree) and
    `fastsam_segment`'s pre-vectorize merge step (folding same-object sub-detections into their
    top-level container before they ever become separate segments) — area strictly decreases
    along any parent chain, so a chain built from this map can never cycle."""
    n = len(bboxes)
    parent: dict[int, int] = {}
    for j in range(n):
        best_parent: int | None = None
        best_area = math.inf
        for i in range(n):
            if i == j:
                continue
            if _contains(bboxes[i], bboxes[j], params):
                area_i = _area(bboxes[i])
                if area_i < best_area:
                    best_area = area_i
                    best_parent = i
        if best_parent is not None:
            parent[j] = best_parent
    return parent


def build_segment_forest(
    spans: list[SegmentSpan], params: ContainmentParams, ids: IdAllocator
) -> list[TreeNode]:
    """Nests segments by bbox containment: each segment's parent is the smallest-area sibling
    bbox that contains it — area strictly decreases along any parent chain, so this can never
    cycle and never places a segment in more than one spot. A segment's own paths sit as flat
    leaf siblings alongside any nested child segments. A segment with no leaves of its own and
    exactly one nested child is dissolved (its child is promoted in its place instead of being
    wrapped in a redundant single-child group); a segment that ends up with neither leaves nor
    children (its mask produced zero paths and it had no sub-segments) is dropped entirely."""
    n = len(spans)
    parent = find_parents([s.bbox for s in spans], params)

    children_of: dict[int, list[int]] = {}
    for child, container in parent.items():
        children_of.setdefault(container, []).append(child)

    def build(i: int) -> TreeNode | None:
        own_leaves: list[TreeNode] = [LeafRef(index=idx) for idx in spans[i].leaf_indices]
        child_nodes = [node for k in sorted(children_of.get(i, [])) if (node := build(k)) is not None]
        combined = own_leaves + child_nodes
        if not combined:
            return None
        if len(combined) == 1:
            return combined[0]
        return GroupNode(id=ids.next(), children=combined)

    roots = sorted(i for i in range(n) if i not in parent)
    forest: list[TreeNode] = []
    for root in roots:
        node = build(root)
        if node is not None:
            forest.append(node)
    return forest
