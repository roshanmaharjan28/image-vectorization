from __future__ import annotations

from .schema import GroupNode, LeafRef, TreeNode


def validate_tree(groups: list[TreeNode], total_paths: int) -> None:
    """Raises on any duplicate/out-of-range leaf index or empty group. Does NOT require every
    index to be referenced — ungrouped paths are expected and allowed."""
    seen: set[int] = set()

    def walk(node: TreeNode) -> None:
        if isinstance(node, LeafRef):
            if not (0 <= node.index < total_paths):
                raise ValueError(f"leaf index {node.index} out of range [0, {total_paths})")
            if node.index in seen:
                raise ValueError(f"leaf index {node.index} referenced more than once")
            seen.add(node.index)
        elif isinstance(node, GroupNode):
            if not node.children:
                raise ValueError(f"group {node.id!r} has no children")
            for child in node.children:
                walk(child)
        else:
            raise TypeError(f"unknown tree node type: {node!r}")

    for root in groups:
        walk(root)
