from app.grouping.svg_annotate import (
    bbox_from_path_d,
    extract_fill,
    extract_path_tags,
    extract_svg_open_tag,
    insert_region_index,
    parse_attrs,
)

SAMPLE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
  <path d="M0 0 L1 0 L1 1 L0 1 Z" fill="#ff0000" />
  <path d="M2 2 L3 2 L3 3 L2 3 Z" style="fill:#00ff00" />
  <path d="M4 4 L5 4 L5 5 L4 5 Z"/>
</svg>"""


def test_extracts_every_path_tag_in_document_order():
    tags = extract_path_tags(SAMPLE_SVG)
    assert len(tags) == 3
    assert 'fill="#ff0000"' in tags[0]
    assert 'style="fill:#00ff00"' in tags[1]


def test_extracts_the_svg_open_tag():
    tag = extract_svg_open_tag(SAMPLE_SVG)
    assert tag is not None
    assert tag.startswith('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"')
    assert tag.endswith(">")
    assert "<path" not in tag


def test_extract_svg_open_tag_returns_none_when_absent():
    assert extract_svg_open_tag("<path d=\"M0 0 Z\"/>") is None


def test_extracts_fill_from_attribute_and_style_and_falls_back():
    tags = extract_path_tags(SAMPLE_SVG)
    fills = [extract_fill(parse_attrs(tag)) for tag in tags]
    assert fills == ["#ff0000", "#00ff00", "#000000"]


def test_extracts_bbox_from_path_d():
    tags = extract_path_tags(SAMPLE_SVG)
    bboxes = [bbox_from_path_d(parse_attrs(tag).get("d")) for tag in tags]
    assert bboxes[0] == (0.0, 0.0, 1.0, 1.0)
    assert bboxes[1] == (2.0, 2.0, 3.0, 3.0)


def test_unsupported_command_yields_no_bbox():
    assert bbox_from_path_d("M0 0 a5 5 0 0 1 5 5 Z") is None


def test_insert_region_index_handles_self_closing_and_open_tags():
    assert insert_region_index('<path d="M0 0Z"/>', 3) == '<path d="M0 0Z" data-region-index="3" />'
    assert insert_region_index('<path d="M0 0Z">', 3) == '<path d="M0 0Z" data-region-index="3">'
