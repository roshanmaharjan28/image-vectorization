"""Keeps a group forest valid when a postprocess stage rewrites the path list underneath it.

Leaves address paths by index in document order, so any pass that drops or merges paths (v2's
postprocess) invalidates every index after the first change. Rather than forbidding such passes on
grouped requests, this translates the forest through the index map they report.
"""

from __future__ import annotations

from .schema import GroupNode, LeafRef, TreeNode


def remap_leaf_indices(nodes: list[TreeNode], index_map: dict[int, int]) -> list[TreeNode]:
    """Rebuilds `nodes` with each leaf's index translated through `index_map`.

    A leaf whose path was dropped disappears. When several original paths were merged into one,
    the leaves collapse onto a single index and only the first occurrence in the walk survives -
    the tree's core invariant is that every index appears exactly once, and the frontend's
    completeness pass relies on it. Groups left empty are pruned, so a group whose every path was
    dropped does not linger as an empty row.
    """
    seen: set[int] = set()

    def walk(node: TreeNode) -> TreeNode | None:
        if isinstance(node, LeafRef):
            new_index = index_map.get(node.index)
            if new_index is None or new_index in seen:
                return None
            seen.add(new_index)
            return LeafRef(index=new_index)

        children = [child for child in (walk(c) for c in node.children) if child is not None]
        if not children:
            return None
        return GroupNode(id=node.id, children=children, label=node.label)

    return [node for node in (walk(n) for n in nodes) if node is not None]
