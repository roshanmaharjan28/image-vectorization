from __future__ import annotations

from .schema import PathInfo
from .svg_annotate import (
    bbox_from_path_d,
    extract_fill,
    extract_path_tags,
    extract_svg_open_tag,
    insert_region_index,
    parse_attrs,
)


def merge_segments(
    width: int, height: int, segment_svgs: list[str]
) -> tuple[str, list[PathInfo], list[tuple[int, int]]]:
    """Concatenates each segment's own vtracer output into one document, in segment order,
    assigning every path a single global `data-region-index`. `segment_svgs[i]` is the raw
    vtracer SVG produced by vectorizing segment i's masked image (it may contain zero paths, e.g.
    a mask too small for vtracer to trace anything). Returns (merged_svg, path_infos,
    segment_ranges) where segment_ranges[i] = (start, end) is the half-open range of global
    indices segment i contributed — which is exactly that segment's group membership, with no
    proxy matching needed."""
    open_tag = None
    for svg in segment_svgs:
        open_tag = extract_svg_open_tag(svg)
        if open_tag:
            break
    if open_tag is None:
        open_tag = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'

    counter = 0
    infos: list[PathInfo] = []
    ranges: list[tuple[int, int]] = []
    body_parts: list[str] = []

    for svg in segment_svgs:
        start = counter
        for tag in extract_path_tags(svg):
            attrs = parse_attrs(tag)
            fill = extract_fill(attrs)
            bbox = bbox_from_path_d(attrs.get("d"))
            infos.append(PathInfo(index=counter, fill=fill, bbox=bbox))
            body_parts.append(insert_region_index(tag, counter))
            counter += 1
        ranges.append((start, counter))

    merged = open_tag + "\n" + "\n".join(body_parts) + "\n</svg>"
    return merged, infos, ranges
