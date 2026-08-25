from __future__ import annotations

import re

from .schema import BBox

# Matches one <path ...> or <path ... /> tag, or the document's opening <svg ...> tag. Safe as a
# non-XML regex splice/scan because no pipeline in this codebase ever emits nested markup inside
# a <path>, and every attribute value is double-quoted (so a literal '>' can only appear inside
# an attribute value if it were unescaped, which none of our emitters do).
PATH_TAG_RE = re.compile(r"<path\b[^>]*/?>", re.IGNORECASE)
SVG_OPEN_TAG_RE = re.compile(r"<svg\b[^>]*>", re.IGNORECASE)
_ATTR_RE = re.compile(r'([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"')
_STYLE_FILL_RE = re.compile(r"fill\s*:\s*([^;]+)")

# One path-data token: a command letter followed by its (possibly empty) numeric argument run.
_D_TOKEN_RE = re.compile(r"([MLCQZmlcqz])([^MLCQZmlcqz]*)")
_NUM_RE = re.compile(r"-?\d*\.?\d+(?:[eE][-+]?\d+)?")

# vtracer and v2's postprocess serializer both emit absolute M/L/C/Q/Z only. Any other command (arcs,
# relative moves, shorthand curves) falls outside what `bbox_from_path_d` below can safely
# measure, so such paths are excluded from bbox-based nesting (never from the SVG itself, and
# never from receiving a data-region-index).


def extract_path_tags(svg: str) -> list[str]:
    """Every top-level <path ...> or <path ... /> tag, in document order."""
    return PATH_TAG_RE.findall(svg)


def extract_svg_open_tag(svg: str) -> str | None:
    """The document's opening <svg ...> tag, or None if the string has no <svg> element."""
    match = SVG_OPEN_TAG_RE.search(svg)
    return match.group(0) if match else None


def parse_attrs(tag: str) -> dict[str, str]:
    return {match.group(1): match.group(2) for match in _ATTR_RE.finditer(tag)}


def extract_fill(attrs: dict[str, str]) -> str:
    """Mirrors frontend/src/lib/svgParse.ts's extractFill fallback order exactly."""
    fill = attrs.get("fill")
    if fill:
        return fill
    style = attrs.get("style")
    if style:
        match = _STYLE_FILL_RE.search(style)
        if match:
            return match.group(1).strip()
    return "#000000"


def bbox_from_path_d(d: str | None) -> BBox | None:
    """A conservative control-point-envelope bbox (not the true tight curve bbox) — sufficient
    for the containment heuristic that consumes it. Returns None for any `d` using a command
    this parser doesn't understand, rather than guessing."""
    if not d:
        return None
    for letter in d:
        if letter.isalpha() and letter not in "MLCQZ":
            return None

    xs: list[float] = []
    ys: list[float] = []
    for _cmd, rest in _D_TOKEN_RE.findall(d):
        nums = [float(n) for n in _NUM_RE.findall(rest)]
        if not nums:
            continue
        if len(nums) % 2 != 0:
            return None
        xs.extend(nums[0::2])
        ys.extend(nums[1::2])

    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def insert_region_index(tag: str, index: int) -> str:
    """Returns `tag` with a `data-region-index="index"` attribute spliced in before its closing
    `>`/`/>`. The frontend's parseSvgToLayers already copies every attribute into Layer.attrs, so
    this new attribute reaches the frontend for free."""
    insertion = f' data-region-index="{index}"'
    stripped = tag.rstrip()
    if stripped.endswith("/>"):
        return stripped[:-2].rstrip() + insertion + " />"
    return stripped[:-1].rstrip() + insertion + ">"
