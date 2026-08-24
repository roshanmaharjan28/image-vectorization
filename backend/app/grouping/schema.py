from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union

GroupingMode = Literal["none", "opencv", "fastsam"]

BBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class PathInfo:
    index: int
    fill: str
    bbox: BBox | None  # (min_x, min_y, max_x, max_y); None if `d` couldn't be parsed


@dataclass
class LeafRef:
    index: int


@dataclass
class GroupNode:
    id: str
    children: "list[TreeNode]"
    label: str | None = None


TreeNode = Union[LeafRef, GroupNode]


def serialize_node(node: TreeNode) -> dict:
    if isinstance(node, LeafRef):
        return {"type": "leaf", "index": node.index}
    return {
        "type": "group",
        "id": node.id,
        "label": node.label,
        "children": [serialize_node(child) for child in node.children],
    }


def serialize_groups(groups: list[TreeNode] | None) -> list[dict] | None:
    if groups is None:
        return None
    return [serialize_node(node) for node in groups]
