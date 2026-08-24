from app.grouping.containment import ContainmentParams, IdAllocator, SegmentSpan, build_segment_forest
from app.grouping.schema import GroupNode, LeafRef


def test_flat_siblings_stay_as_bare_leaves():
    spans = [
        SegmentSpan(bbox=(0, 0, 10, 10), leaf_indices=[0]),
        SegmentSpan(bbox=(20, 20, 30, 30), leaf_indices=[1]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert forest == [LeafRef(index=0), LeafRef(index=1)]


def test_concentric_segments_nest_by_smallest_enclosing_parent():
    # segment 0 is the biggest, fully containing 1, which fully contains 2.
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[0]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[1]),
        SegmentSpan(bbox=(20, 20, 80, 80), leaf_indices=[2]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert len(forest) == 1
    root = forest[0]
    assert isinstance(root, GroupNode)
    assert LeafRef(index=0) in root.children
    nested = [c for c in root.children if isinstance(c, GroupNode)]
    assert len(nested) == 1
    assert LeafRef(index=1) in nested[0].children


def test_multi_path_segment_keeps_its_paths_flat_alongside_nested_children():
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[0, 1]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[2]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert len(forest) == 1
    root = forest[0]
    assert isinstance(root, GroupNode)
    assert LeafRef(index=0) in root.children
    assert LeafRef(index=1) in root.children
    assert LeafRef(index=2) in root.children


def test_empty_segment_with_one_nested_child_is_dissolved_not_wrapped():
    # segment 0 produced zero paths of its own but geometrically contains segment 1.
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[0]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert forest == [LeafRef(index=0)]


def test_completely_empty_segment_is_dropped():
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[]),
        SegmentSpan(bbox=(200, 200, 210, 210), leaf_indices=[0]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert forest == [LeafRef(index=0)]


def test_no_duplicate_index_across_forest():
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[0]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[1]),
        SegmentSpan(bbox=(20, 20, 80, 80), leaf_indices=[2]),
        SegmentSpan(bbox=(200, 200, 210, 210), leaf_indices=[3]),
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())

    seen = []

    def walk(node):
        if isinstance(node, LeafRef):
            seen.append(node.index)
        else:
            for child in node.children:
                walk(child)

    for node in forest:
        walk(node)

    assert sorted(seen) == [0, 1, 2, 3]
    assert len(seen) == len(set(seen))


def test_group_ids_are_globally_unique_across_multiple_calls():
    ids = IdAllocator()
    spans_a = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[0]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[1]),
    ]
    spans_b = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[2]),
        SegmentSpan(bbox=(10, 10, 90, 90), leaf_indices=[3]),
    ]
    forest_a = build_segment_forest(spans_a, ContainmentParams(), ids)
    forest_b = build_segment_forest(spans_b, ContainmentParams(), ids)

    def collect_ids(node, out):
        if isinstance(node, GroupNode):
            out.append(node.id)
            for child in node.children:
                collect_ids(child, out)

    all_ids: list[str] = []
    for node in forest_a + forest_b:
        collect_ids(node, all_ids)

    assert len(all_ids) == len(set(all_ids))


def test_zero_area_bbox_never_contains_or_is_contained():
    spans = [
        SegmentSpan(bbox=(0, 0, 100, 100), leaf_indices=[0]),
        SegmentSpan(bbox=(5, 5, 5, 5), leaf_indices=[1]),  # degenerate/zero-area
    ]
    forest = build_segment_forest(spans, ContainmentParams(), IdAllocator())
    assert sorted(forest, key=lambda n: n.index) == [LeafRef(index=0), LeafRef(index=1)]
