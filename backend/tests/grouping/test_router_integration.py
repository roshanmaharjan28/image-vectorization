import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import app

client = TestClient(app)


def _fixture_png_bytes() -> bytes:
    img = Image.new("RGB", (64, 64), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([4, 4, 20, 20], fill=(255, 0, 0))
    draw.rectangle([40, 40, 56, 56], fill=(0, 0, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _upload(path: str, grouping: str):
    files = {"image": ("fixture.png", _fixture_png_bytes(), "image/png")}
    data = {"grouping": grouping}
    return client.post(path, files=files, data=data)


@pytest.mark.parametrize("path", ["/api/vectorize", "/api/v3/vectorize"])
def test_grouping_opencv_returns_groups_and_annotated_svg(path: str):
    res = _upload(path, "opencv")
    assert res.status_code == 200
    body = res.json()
    assert "svg" in body
    assert "groups" in body
    assert "data-region-index=" in body["svg"]

    if body["groups"]:
        seen: set[int] = set()

        def walk(node):
            if node["type"] == "leaf":
                assert node["index"] not in seen
                seen.add(node["index"])
            else:
                assert node["children"]
                for child in node["children"]:
                    walk(child)

        for node in body["groups"]:
            walk(node)


@pytest.mark.parametrize("path", ["/api/vectorize", "/api/v3/vectorize"])
def test_grouping_none_omits_groups_key_value(path: str):
    res = _upload(path, "none")
    assert res.status_code == 200
    body = res.json()
    assert body.get("groups") is None
    assert "data-region-index=" not in body["svg"]
