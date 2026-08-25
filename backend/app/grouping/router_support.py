from __future__ import annotations

from typing import Callable, Protocol

import numpy as np

from .remap import remap_leaf_indices
from .schema import GroupingMode, serialize_groups
from .segmented_pipeline import build_grouped_svg


class SvgPostprocessor(Protocol):
    """A pipeline's own "clean up the traced document" pass (v2's postprocess stage).

    Returns the rewritten SVG plus a map from each original path index to its index in the
    rewritten document, which is what lets a pass that drops or merges paths run on a *grouped*
    response without invalidating the group forest's leaf indices.

    `allow_merge=False` asks the pass not to combine paths at all. Grouped requests pass it,
    because a path merged out of two segments would belong to two groups at once.
    """

    def __call__(self, svg: str, *, allow_merge: bool) -> tuple[str, dict[int, int]]: ...


def finalize_vectorize_response(
    *,
    image_bytes: bytes,
    grouping: GroupingMode,
    vtracer_kwargs: dict,
    plain_vectorize: Callable[[], str],
    quantized_source_provider: Callable[[], tuple[np.ndarray, np.ndarray]] | None = None,
    postprocess: SvgPostprocessor | None = None,
) -> dict:
    """Shared by v1's, v2's and v3's routers — the entire per-router grouping surface is this one
    call plus the small closures each router passes in (how to vectorize the whole image plainly,
    how to get its already-quantized raster, how to postprocess the result), so no pipeline carries
    its own copy of the segment-then-vectorize/fallback/remap logic. `grouping="none"` never
    touches the grouping package at all — the default path has no added cost and no output change,
    preserving full backward compatibility."""
    if grouping == "none":
        return {"svg": _postprocessed(plain_vectorize(), postprocess), "groups": None}

    quantized_source = quantized_source_provider() if quantized_source_provider else None
    result = build_grouped_svg(image_bytes, grouping, vtracer_kwargs, quantized_source=quantized_source)

    if result is None:
        return {"svg": _postprocessed(plain_vectorize(), postprocess), "groups": None}

    svg, groups = result
    if postprocess is not None:
        svg, index_map = postprocess(svg, allow_merge=False)
        groups = remap_leaf_indices(groups, index_map)
    return {"svg": svg, "groups": serialize_groups(groups)}


def _postprocessed(svg: str, postprocess: SvgPostprocessor | None) -> str:
    if postprocess is None:
        return svg
    return postprocess(svg, allow_merge=True)[0]
