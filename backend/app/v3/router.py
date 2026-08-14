import os
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .params import VectorizeParamsV3
from .pipeline import vectorize_image_v3

router = APIRouter()

_DEFAULTS = VectorizeParamsV3()

_SUPPORTED_FORMATS = {"png", "jpg", "jpeg"}


def _validate_image_format(filename: str | None, content_type: str | None) -> None:
    ext = os.path.splitext(filename or "")[1].lstrip(".").lower()
    if ext in _SUPPORTED_FORMATS:
        return
    if content_type and "/" in content_type:
        sub = content_type.split("/", 1)[1].lower()
        if sub in _SUPPORTED_FORMATS:
            return
    raise HTTPException(status_code=400, detail=f"Unsupported image format: {filename}")


@router.post("/vectorize")
def vectorize_v3(
    image: UploadFile = File(...),
    colormode: Literal["color", "binary"] = Form(_DEFAULTS.colormode),
    hierarchical: Literal["stacked", "cutout"] = Form(_DEFAULTS.hierarchical),
    mode: Literal["spline", "polygon", "none"] = Form(_DEFAULTS.mode),
    filter_speckle: int = Form(_DEFAULTS.filter_speckle, ge=0, le=100),
    color_precision: int = Form(_DEFAULTS.color_precision, ge=1, le=8),
    layer_difference: int = Form(_DEFAULTS.layer_difference, ge=0, le=255),
    corner_threshold: int = Form(_DEFAULTS.corner_threshold, ge=0, le=180),
    length_threshold: float = Form(_DEFAULTS.length_threshold, ge=3.5, le=10),
    splice_threshold: int = Form(_DEFAULTS.splice_threshold, ge=0, le=180),
):
    _validate_image_format(image.filename, image.content_type)

    img_bytes = image.file.read()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    params = VectorizeParamsV3(
        colormode=colormode,
        hierarchical=hierarchical,
        mode=mode,
        filter_speckle=filter_speckle,
        color_precision=color_precision,
        layer_difference=layer_difference,
        corner_threshold=corner_threshold,
        length_threshold=length_threshold,
        splice_threshold=splice_threshold,
    )

    try:
        svg = vectorize_image_v3(img_bytes, params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pipeline or vtracer failure
        raise HTTPException(status_code=500, detail=f"Vectorization failed: {exc}") from exc

    return {"svg": svg}
