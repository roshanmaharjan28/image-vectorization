from __future__ import annotations

from typing import Callable

import numpy as np
from fastapi import HTTPException

from .exceptions import GroupingUnavailableError
from .schema import GroupingMode, serialize_groups
from .segmented_pipeline import build_grouped_svg


def finalize_vectorize_response(
    *,
    image_bytes: bytes,
    grouping: GroupingMode,
    vtracer_kwargs: dict,
    plain_vectorize: Callable[[], str],
    quantized_source_provider: Callable[[], tuple[np.ndarray, np.ndarray]] | None = None,
) -> dict:
    """Shared by v1's and v3's routers — the entire per-router grouping surface is this one call
    plus the two small closures each router passes in (how to vectorize the whole image plainly,
    and — for v3 only — how to get its already-quantized raster), so neither pipeline carries its
    own copy of the segment-then-vectorize/fallback/501-mapping logic. `grouping="none"` never
    touches the grouping package at all — the default path has no added cost and no output
    change, preserving full backward compatibility."""
    if grouping == "none":
        return {"svg": plain_vectorize(), "groups": None}

    quantized_source = quantized_source_provider() if quantized_source_provider else None
    try:
        result = build_grouped_svg(image_bytes, grouping, vtracer_kwargs, quantized_source=quantized_source)
    except GroupingUnavailableError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc

    if result is None:
        return {"svg": plain_vectorize(), "groups": None}

    svg, groups = result
    return {"svg": svg, "groups": serialize_groups(groups)}
