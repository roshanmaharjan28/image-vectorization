import os

import vtracer
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Image Vectorization API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
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
def vectorize(image: UploadFile = File(...)):
    img_format = _resolve_format(image.filename, image.content_type)
    img_bytes = image.file.read()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        svg = vtracer.convert_raw_image_to_svg(img_bytes, img_format=img_format)
    except Exception as exc:  # vtracer raises plain exceptions on decode/trace failure
        raise HTTPException(status_code=500, detail=f"Vectorization failed: {exc}") from exc

    return {"svg": svg}


@app.get("/api/health")
def health():
    return {"status": "ok"}
