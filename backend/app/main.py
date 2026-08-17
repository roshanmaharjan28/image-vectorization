import os
from typing import Literal

import vtracer
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.v2.router import router as v2_router
from app.v3.router import router as v3_router

load_dotenv()

app = FastAPI(title="Image Vectorization API")
app.include_router(v2_router, prefix="/api/v2")
app.include_router(v3_router, prefix="/api/v3")

cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPPORTED_FORMATS = {"png", "jpg", "jpeg", "bmp", "gif"}


def _resolve_format(filename: str, content_type: str | None) -> str:
    ext = os.path.splitext(filename or "")[1].lstrip(".").lower()
    if ext in SUPPORTED_FORMATS:
        return "jpg" if ext == "jpeg" else ext
    if content_type and "/" in content_type:
        sub = content_type.split("/", 1)[1].lower()
        if sub in SUPPORTED_FORMATS:
            return "jpg" if sub == "jpeg" else sub
    raise HTTPException(status_code=400, detail=f"Unsupported image format: {filename}")


@app.post("/api/vectorize")
def vectorize(
    image: UploadFile = File(...),
    colormode: Literal["color", "binary"] = Form("color"),
    hierarchical: Literal["stacked", "cutout"] = Form("stacked"),
    mode: Literal["spline", "polygon", "none"] = Form("spline"),
    filter_speckle: int = Form(2, ge=0, le=100),
    color_precision: int = Form(8, ge=1, le=8),
    layer_difference: int = Form(12, ge=0, le=255),
    corner_threshold: int = Form(45, ge=0, le=180),
    length_threshold: float = Form(3.5, ge=3.5, le=10),
    splice_threshold: int = Form(30, ge=0, le=180),
):
    img_format = _resolve_format(image.filename, image.content_type)
    img_bytes = image.file.read()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        svg = vtracer.convert_raw_image_to_svg(
            img_bytes,
            img_format=img_format,
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
    except Exception as exc:  # vtracer raises plain exceptions on decode/trace failure
        raise HTTPException(status_code=500, detail=f"Vectorization failed: {exc}") from exc

    return {"svg": svg}


@app.get("/api/health")
def health():
    return {"status": "ok"}
