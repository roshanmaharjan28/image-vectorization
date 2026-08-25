import os
from dataclasses import replace
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.grouping.router_support import finalize_vectorize_response

from .params import VectorizeParamsV2
from .pipeline import postprocess, prepare, trace, trace_kwargs
from .presets import PRESETS, get_preset

router = APIRouter()

_DEFAULTS = VectorizeParamsV2()

_SUPPORTED_FORMATS = {"png", "jpg", "jpeg", "bmp", "gif"}


def _validate_image_format(filename: str | None, content_type: str | None) -> None:
    ext = os.path.splitext(filename or "")[1].lstrip(".").lower()
    if ext in _SUPPORTED_FORMATS:
        return
    if content_type and "/" in content_type:
        sub = content_type.split("/", 1)[1].lower()
        if sub in _SUPPORTED_FORMATS:
            return
    raise HTTPException(status_code=400, detail=f"Unsupported image format: {filename}")


@router.get("/presets")
def list_presets_v2():
    """The named presets and the full parameter set each one implies.

    Served rather than duplicated in the frontend so the values shown in the UI controls are
    provably the values this router would use - a mirrored copy would drift the first time either
    side was retuned.
    """
    return {
        "default": vars(_DEFAULTS),
        "presets": [
            {
                "id": preset.id,
                "label": preset.label,
                "description": preset.description,
                "params": vars(preset.params),
            }
            for preset in PRESETS
        ],
    }


@router.post("/vectorize")
def vectorize_v2(
    image: UploadFile = File(...),
    # Every parameter below defaults to None rather than to its value, so "not sent" is
    # distinguishable from "sent, equal to the default". That distinction is what lets `preset`
    # supply a complete base that only explicitly-sent fields override - with plain defaults, a
    # preset could never set any field whose default a client happened to also be sending.
    preset: str | None = Form(None),
    # --- trace (same surface as v1) ---
    colormode: Literal["color", "binary"] | None = Form(None),
    hierarchical: Literal["stacked", "cutout"] | None = Form(None),
    mode: Literal["spline", "polygon", "none"] | None = Form(None),
    filter_speckle: int | None = Form(None, ge=0, le=100),
    color_precision: int | None = Form(None, ge=1, le=8),
    layer_difference: int | None = Form(None, ge=0, le=255),
    corner_threshold: int | None = Form(None, ge=0, le=180),
    length_threshold: float | None = Form(None, ge=3.5, le=10),
    splice_threshold: int | None = Form(None, ge=0, le=180),
    # --- preprocess ---
    denoise_strength: int | None = Form(None, ge=0, le=10),
    n_colors: int | None = Form(None, ge=0, le=256),
    smooth_labels: bool | None = Form(None),
    min_region_area: int | None = Form(None, ge=0, le=500),
    # --- postprocess ---
    min_path_area: float | None = Form(None, ge=0, le=500),
    simplify_tolerance: float | None = Form(None, ge=0, le=5),
    max_fit_error: float | None = Form(None, ge=0.05, le=5),
    smooth_curves: bool | None = Form(None),
    smooth_corner_angle: float | None = Form(None, ge=0, le=180),
    snap_fills_to_palette: bool | None = Form(None),
    merge_same_fill: Literal["none", "adjacent", "all"] | None = Form(None),
    precision: int | None = Form(None, ge=0, le=6),
    seam_stroke_width: float | None = Form(None, ge=0, le=3),
    grouping: Literal["none", "opencv", "fastsam"] = Form("none"),
):
    _validate_image_format(image.filename, image.content_type)

    img_bytes = image.file.read()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    named = get_preset(preset) if preset else None
    if preset and named is None and preset != "custom":
        raise HTTPException(status_code=400, detail=f"Unknown preset: {preset}")

    overrides = {
        "colormode": colormode,
        "hierarchical": hierarchical,
        "mode": mode,
        "filter_speckle": filter_speckle,
        "color_precision": color_precision,
        "layer_difference": layer_difference,
        "corner_threshold": corner_threshold,
        "length_threshold": length_threshold,
        "splice_threshold": splice_threshold,
        "denoise_strength": denoise_strength,
        "n_colors": n_colors,
        "smooth_labels": smooth_labels,
        "min_region_area": min_region_area,
        "min_path_area": min_path_area,
        "simplify_tolerance": simplify_tolerance,
        "max_fit_error": max_fit_error,
        "smooth_curves": smooth_curves,
        "smooth_corner_angle": smooth_corner_angle,
        "snap_fills_to_palette": snap_fills_to_palette,
        "merge_same_fill": merge_same_fill,
        "precision": precision,
        "seam_stroke_width": seam_stroke_width,
    }
    params = replace(
        named.params if named else _DEFAULTS,
        **{key: value for key, value in overrides.items() if value is not None},
    )

    try:
        # Prepared once and shared: the plain trace, opencv grouping's segmentation, and the
        # postprocess pass all read the same flat raster / label map, so nothing is quantized
        # twice and a grouped response describes the same regions an ungrouped one would.
        prepared = prepare(img_bytes, params)

        def plain_vectorize() -> str:
            return trace(prepared, params)

        def quantized_source_provider():
            return prepared.rgba, prepared.label_map

        def postprocess_svg(svg: str, *, allow_merge: bool):
            result = postprocess(svg, prepared, params, allow_merge=allow_merge)
            return result.svg, result.index_map

        return finalize_vectorize_response(
            image_bytes=img_bytes,
            grouping=grouping,
            vtracer_kwargs=trace_kwargs(params),
            plain_vectorize=plain_vectorize,
            quantized_source_provider=quantized_source_provider,
            postprocess=postprocess_svg,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pipeline or vtracer failure
        raise HTTPException(status_code=500, detail=f"Vectorization failed: {exc}") from exc
