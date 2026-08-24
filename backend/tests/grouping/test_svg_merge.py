from app.grouping.svg_merge import merge_segments

SEG_A = """<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
<path d="M0 0 L1 0 L1 1 L0 1 Z" fill="#ff0000"/>
<path d="M2 2 L3 2 L3 3 L2 3 Z" fill="#ff0000"/>
</svg>"""

SEG_B_EMPTY = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"></svg>'

SEG_C = """<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
<path d="M4 4 L5 4 L5 5 L4 5 Z" fill="#0000ff"/>
</svg>"""


def test_assigns_global_indices_across_segments_in_order():
    merged, infos, ranges = merge_segments(10, 10, [SEG_A, SEG_B_EMPTY, SEG_C])
    assert [p.index for p in infos] == [0, 1, 2]
    assert ranges == [(0, 2), (2, 2), (2, 3)]
    assert 'data-region-index="0"' in merged
    assert 'data-region-index="1"' in merged
    assert 'data-region-index="2"' in merged


def test_empty_segment_contributes_no_paths_but_a_valid_range():
    _, infos, ranges = merge_segments(10, 10, [SEG_B_EMPTY])
    assert infos == []
    assert ranges == [(0, 0)]


def test_fill_and_bbox_are_extracted_per_path():
    _, infos, _ = merge_segments(10, 10, [SEG_A, SEG_C])
    assert infos[0].fill == "#ff0000"
    assert infos[0].bbox == (0.0, 0.0, 1.0, 1.0)
    assert infos[2].fill == "#0000ff"


def test_falls_back_to_a_synthesized_root_tag_when_every_segment_is_pathless():
    merged, infos, ranges = merge_segments(10, 10, [SEG_B_EMPTY, SEG_B_EMPTY])
    assert infos == []
    assert ranges == [(0, 0), (0, 0)]
    assert 'width="10"' in merged
    assert 'height="10"' in merged
    assert merged.strip().endswith("</svg>")
