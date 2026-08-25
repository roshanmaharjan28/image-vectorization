"""v2 = preprocess -> vtracer -> postprocess.

v1 hands the user's raster straight to vtracer and returns whatever comes back. v3 puts the shared
quantizer in front of it. v2 is the version that owns *both* ends: it flattens the raster into the
regions it wants traced (preprocess.py) and then repairs the document vtracer produces
(postprocess.py). The tracer in the middle is the same library with the same tunables v1 exposes.

The three steps are separate entry points rather than one function because the router has to
interleave them with grouping: the raster is prepared once, and grouping vectorizes it per segment
(reusing the same flat raster and label map, never quantizing twice), after which the same
postprocess pass runs over whichever SVG - plain or merged - came out.
"""

from __future__ import annotations

import vtracer

from .params import VectorizeParamsV2
from .postprocess import PostprocessResult, optimize_svg
from .preprocess import PreparedRaster, prepare

__all__ = [
    "PreparedRaster",
    "PostprocessResult",
    "prepare",
    "trace_kwargs",
    "trace",
    "postprocess",
    "vectorize_image_v2",
]


def trace_kwargs(params: VectorizeParamsV2) -> dict:
    """The vtracer call's keyword arguments. Also handed to the grouping package, so a grouped
    request traces each segment exactly the way the plain path traces the whole image."""
    return dict(
        colormode=params.colormode,
        hierarchical=params.hierarchical,
        mode=params.mode,
        filter_speckle=params.filter_speckle,
        color_precision=params.color_precision,
        layer_difference=params.layer_difference,
        corner_threshold=params.corner_threshold,
        length_threshold=params.length_threshold,
        splice_threshold=params.splice_threshold,
    )


def trace(prepared: PreparedRaster, params: VectorizeParamsV2) -> str:
    """Raw vtracer output for the prepared raster - not yet postprocessed."""
    return vtracer.convert_raw_image_to_svg(prepared.png, img_format="png", **trace_kwargs(params))


def postprocess(
    svg: str,
    prepared: PreparedRaster,
    params: VectorizeParamsV2,
    *,
    allow_merge: bool = True,
) -> PostprocessResult:
    return optimize_svg(
        svg,
        params,
        width=prepared.width,
        height=prepared.height,
        palette=prepared.palette,
        allow_merge=allow_merge,
    )


def vectorize_image_v2(raw: bytes, params: VectorizeParamsV2 = VectorizeParamsV2()) -> str:
    """The whole pipeline in one call, for callers with no grouping to interleave (tests, scripts,
    anything comparing v2 against v1/v3 on the same input)."""
    prepared = prepare(raw, params)
    return postprocess(trace(prepared, params), prepared, params).svg
