"""The same image and the same parameters must produce the same SVG.

This was not true: cv2.kmeans's KMEANS_PP_CENTERS initialisation draws from OpenCV's process-global
RNG, which nothing seeded, so every call posterized to a slightly different palette. Three runs of
one preset over one file produced three different documents, and on one measurement the difference
was worth 2.7 of mean absolute error - enough that re-vectorizing could visibly worsen the result
for no reason, and enough to make any A/B of a parameter change meaningless.
"""

from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from app.main import app
from app.v2.pipeline import vectorize_image_v2
from app.v2.presets import PRESETS, get_preset

from .test_router_integration import _fixture_png

client = TestClient(app)


def _digest(svg: str) -> str:
    return hashlib.sha256(svg.encode()).hexdigest()


def test_repeated_pipeline_calls_agree():
    image = _fixture_png()
    params = get_preset("low-fidelity-photo").params
    digests = {_digest(vectorize_image_v2(image, params)) for _ in range(3)}
    assert len(digests) == 1


def test_repeated_requests_agree_for_every_preset():
    """Via the route, so the check covers whatever the router does around the pipeline too."""
    image = _fixture_png()
    for preset in PRESETS:
        digests = set()
        for _ in range(2):
            res = client.post(
                "/api/v2/vectorize",
                files={"image": ("f.png", image, "image/png")},
                data={"preset": preset.id},
            )
            assert res.status_code == 200
            digests.add(_digest(res.json()["svg"]))
        assert len(digests) == 1, preset.id


def test_v1_and_v3_are_deterministic_too():
    """The seeding lives in the shared quantizer, so v3 (which uses it) and v1's grouping mode get
    the same guarantee - v3's output was equally arbitrary per-run before."""
    image = _fixture_png()
    for path in ("/api/vectorize", "/api/v3/vectorize"):
        digests = set()
        for _ in range(2):
            res = client.post(path, files={"image": ("f.png", image, "image/png")}, data={})
            assert res.status_code == 200
            digests.add(_digest(res.json()["svg"]))
        assert len(digests) == 1, path
