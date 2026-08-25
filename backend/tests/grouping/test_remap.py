from __future__ import annotations

from app.grouping.remap import remap_leaf_indices
from app.grouping.schema import GroupNode, LeafRef


def test_leaves_are_translated_through_the_map():
    tree = [GroupNode(id="g0", children=[LeafRef(index=3), LeafRef(index=7)], label="a")]
    remapped = remap_leaf_indices(tree, {3: 0, 7: 1})
    assert [leaf.index for leaf in remapped[0].children] == [0, 1]
    assert remapped[0].id == "g0" and remapped[0].label == "a"


def test_dropped_paths_disappear_from_the_tree():
    tree = [GroupNode(id="g0", children=[LeafRef(index=0), LeafRef(index=1)])]
    remapped = remap_leaf_indices(tree, {1: 0})
    assert [leaf.index for leaf in remapped[0].children] == [0]


def test_merged_paths_collapse_to_one_leaf():
    """Several source paths merging into one means several leaves claim one index; the tree's
    invariant is that an index appears exactly once, so only the first survives."""
    tree = [GroupNode(id="g0", children=[LeafRef(index=0), LeafRef(index=1), LeafRef(index=2)])]
    remapped = remap_leaf_indices(tree, {0: 0, 1: 0, 2: 1})
    assert [leaf.index for leaf in remapped[0].children] == [0, 1]


def test_duplicate_indices_across_sibling_groups_resolve_to_the_first():
    tree = [
        GroupNode(id="g0", children=[LeafRef(index=0)]),
        GroupNode(id="g1", children=[LeafRef(index=1), LeafRef(index=2)]),
    ]
    remapped = remap_leaf_indices(tree, {0: 0, 1: 0, 2: 1})
    assert len(remapped) == 2
    assert [leaf.index for leaf in remapped[0].children] == [0]
    assert [leaf.index for leaf in remapped[1].children] == [1]


def test_groups_left_empty_are_pruned_at_every_depth():
    tree = [
        GroupNode(
            id="outer",
            children=[GroupNode(id="inner", children=[LeafRef(index=5)]), LeafRef(index=6)],
        )
    ]
    assert remap_leaf_indices(tree, {6: 0})[0].children[0].index == 0
    assert remap_leaf_indices(tree, {}) == []


def test_nesting_and_labels_survive():
    tree = [
        GroupNode(
            id="outer",
            label="outer label",
            children=[GroupNode(id="inner", label="inner label", children=[LeafRef(index=9)])],
        )
    ]
    remapped = remap_leaf_indices(tree, {9: 4})
    assert remapped[0].label == "outer label"
    assert remapped[0].children[0].label == "inner label"
    assert remapped[0].children[0].children[0].index == 4


def test_top_level_leaves_are_handled_too():
    assert [n.index for n in remap_leaf_indices([LeafRef(index=2)], {2: 0})] == [0]


def test_empty_forest():
    assert remap_leaf_indices([], {0: 0}) == []
