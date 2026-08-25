from __future__ import annotations

import io
import re

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import app

client = TestClient(app)

ENDPOINT = "/api/v2/vectorize"


def _fixture_png(noisy: bool = True) -> bytes:
    img = Image.new("RGB", (96, 96), "white")
    draw = ImageDraw.Draw(img)
    draw.ellipse([6, 6, 44, 44], fill=(220, 30, 40))
    draw.rectangle([52, 52, 90, 90], fill=(20, 70, 200))
    if noisy:
        rng = np.random.default_rng(11)
        arr = np.asarray(img).astype(np.int16) + rng.integers(-16, 17, (96, 96, 3), dtype=np.int16)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _post(data: dict | None = None, *, filename: str = "fixture.png", content_type: str = "image/png"):
    files = {"image": (filename, _fixture_png(), content_type)}
    return client.post(ENDPOINT, files=files, data=data or {})


def _paths(svg: str) -> list[str]:
    return re.findall(r"<path\b[^>]*>", svg)


def test_defaults_return_a_clean_svg_without_groups():
    res = _post()
    assert res.status_code == 200
    body = res.json()
    assert body["groups"] is None
    svg = body["svg"]
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")
    assert 'viewBox="0 0 96 96"' in svg
    assert "transform=" not in svg  # translates folded into the coordinates
    assert _paths(svg)


def test_output_is_far_smaller_than_the_raw_tracer_on_the_same_image():
    """The whole point of v2: a noisy source should not come back as hundreds of paths."""
    v1 = client.post("/api/vectorize", files={"image": ("f.png", _fixture_png(), "image/png")}, data={})
    v2 = _post()
    assert v1.status_code == 200 and v2.status_code == 200
    assert len(_paths(v2.json()["svg"])) < len(_paths(v1.json()["svg"]))
    assert len(v2.json()["svg"]) < len(v1.json()["svg"])


def test_every_postprocess_stage_is_request_tunable():
    res = _post(
        {
            "denoise_strength": "0",
            "n_colors": "4",
            "smooth_labels": "false",
            "min_region_area": "0",
            "min_path_area": "0",
            "simplify_tolerance": "0",
            "max_fit_error": "0.2",
            "smooth_curves": "false",
            "smooth_corner_angle": "30",
            "merge_same_fill": "none",
            "precision": "4",
            "seam_stroke_width": "0.4",
        }
    )
    assert res.status_code == 200
    svg = res.json()["svg"]
    assert "stroke-width=\"0.4\"" in svg
    # smooth_curves=false means a polygon: no cubics anywhere.
    assert not re.search(r'd="[^"]*C', svg)


def test_polygon_mode_and_merge_all_are_accepted():
    res = _post({"mode": "polygon", "merge_same_fill": "all", "precision": "0"})
    assert res.status_code == 200
    assert _paths(res.json()["svg"])


@pytest.mark.parametrize(
    "data",
    [
        {"n_colors": "999"},
        {"precision": "-1"},
        {"simplify_tolerance": "-5"},
        {"merge_same_fill": "sometimes"},
        {"max_fit_error": "0"},
    ],
)
def test_out_of_range_params_are_rejected(data: dict):
    assert _post(data).status_code == 422


def test_unsupported_format_is_rejected():
    res = client.post(
        ENDPOINT, files={"image": ("fixture.tiff", b"\x00\x01", "image/tiff")}, data={}
    )
    assert res.status_code == 400


def test_empty_upload_is_rejected():
    res = client.post(ENDPOINT, files={"image": ("fixture.png", b"", "image/png")}, data={})
    assert res.status_code == 400
    assert "empty" in res.json()["detail"].lower()


def test_undecodable_image_is_a_client_error_not_a_500():
    res = client.post(
        ENDPOINT, files={"image": ("fixture.png", b"not really a png", "image/png")}, data={}
    )
    assert res.status_code == 400


def test_grouping_returns_a_forest_whose_indices_match_the_postprocessed_svg():
    """Postprocessing renumbers paths, so the group forest and the `data-region-index` attributes
    have to be remapped in step with it - a stale index would address the wrong layer."""
    res = _post({"grouping": "opencv"})
    assert res.status_code == 200
    body = res.json()
    svg = body["svg"]

    if body["groups"] is None:  # segmentation found nothing to group: a documented outcome
        assert "data-region-index" not in svg
        return

    indices_in_svg = [int(v) for v in re.findall(r'data-region-index="(\d+)"', svg)]
    assert indices_in_svg == sorted(indices_in_svg)
    assert len(indices_in_svg) == len(_paths(svg))
    assert indices_in_svg == list(range(len(_paths(svg))))

    seen: set[int] = set()

    def walk(node: dict) -> None:
        if node["type"] == "leaf":
            assert node["index"] not in seen, "an index may appear only once in the forest"
            assert node["index"] in indices_in_svg
            seen.add(node["index"])
        else:
            assert node["children"], "empty groups should have been pruned"
            for child in node["children"]:
                walk(child)

    for node in body["groups"]:
        walk(node)


def test_grouped_requests_do_not_merge_paths_away():
    """Merging is suppressed when grouping is on: a path merged out of two segments would belong to
    two groups at once."""
    ungrouped = _post({"merge_same_fill": "all"}).json()["svg"]
    grouped = _post({"merge_same_fill": "all", "grouping": "opencv"}).json()["svg"]
    if "data-region-index" in grouped:
        assert len(_paths(grouped)) >= len(_paths(ungrouped))


def test_v1_and_v3_are_unaffected_by_the_shared_postprocess_hook():
    """v1 and v3 pass no postprocessor, so their responses must keep vtracer's own shape -
    translate attributes and all."""
    for path in ("/api/vectorize", "/api/v3/vectorize"):
        res = client.post(path, files={"image": ("f.png", _fixture_png(), "image/png")}, data={})
        assert res.status_code == 200
        assert "transform=" in res.json()["svg"]
