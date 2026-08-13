from fastapi import APIRouter, File, HTTPException, UploadFile

from .pipeline import vectorize_image_v2

router = APIRouter()


@router.post("/vectorize")
def vectorize_v2(image: UploadFile = File(...)):
    img_bytes = image.file.read()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        svg = vectorize_image_v2(img_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pipeline stage failure
        raise HTTPException(status_code=500, detail=f"Vectorization failed: {exc}") from exc

    return {"svg": svg}
