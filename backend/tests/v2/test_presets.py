import dataclasses
import re

from fastapi.testclient import TestClient

from app.main import app
from app.v2.params import VectorizeParamsV2
from app.v2.presets import CUSTOM_ID, DEFAULT_PRESET_ID, PRESETS, get_preset

from .test_router_integration import _fixture_png, _post

client = TestClient(app)

FILL_RE = re.compile(r'fill="([^"]+)"')
DECIMALS_RE = re.compile(r"\d+\.(\d+)")


def _max_decimals(svg: str) -> int:
    return max((len(match) for match in DECIMALS_RE.findall(svg)), default=0)


def test_preset_ids_are_unique_and_resolvable():
    ids = [preset.id for preset in PRESETS]
    assert len(ids) == len(set(ids))
    for preset_id in ids:
        assert get_preset(preset_id) is not None


def test_custom_and_unknown_ids_resolve_to_no_preset():
    # Both mean "the caller's own field values decide", which is what lets the frontend send
    # preset=custom alongside a full set of explicit fields.
    assert get_preset(CUSTOM_ID) is None
    assert get_preset("no-such-preset") is None


def test_default_preset_id_names_a_real_preset():
    assert get_preset(DEFAULT_PRESET_ID) is not None


def test_every_preset_is_a_complete_parameter_set():
    """A preset is a whole VectorizeParamsV2, not a patch - that is what makes reading one tell you
    every value it implies, and what makes selecting one in the UI fully determine the result."""
    for preset in PRESETS:
        assert isinstance(preset.params, VectorizeParamsV2)
        assert preset.label and preset.description


def test_presets_that_drop_paths_also_absorb_regions():
    """Regression guard on a real defect: dropping a small path in postprocess is not the same as
    absorbing a small region in preprocess. Absorbing lets the surrounding colour grow over the
    speck; dropping the path leaves whatever is stacked underneath showing through a hole. A preset
    with a high min_path_area and no min_region_area punches those holes, which measured *worse*
    than doing neither."""
    for preset in PRESETS:
        if preset.params.min_path_area > 4:
            assert preset.params.min_region_area > 0, preset.id


def test_endpoint_serves_every_preset_with_params_named_as_the_route_takes_them():
    """The frontend maps these field names straight onto the vectorize form fields, so a rename on
    one side without the other would silently stop applying the preset."""
    res = client.get("/api/v2/presets")
    assert res.status_code == 200
    body = res.json()

    served = {preset["id"]: preset for preset in body["presets"]}
    assert served.keys() == {preset.id for preset in PRESETS}

    field_names = {field.name for field in dataclasses.fields(VectorizeParamsV2)}
    for preset in body["presets"]:
        assert set(preset["params"]) == field_names
        assert preset["label"] and preset["description"]
    assert set(body["default"]) == field_names


def test_three_colors_preset_actually_limits_the_palette():
    res = _post({"preset": "3-colors"})
    assert res.status_code == 200
    fills = set(FILL_RE.findall(res.json()["svg"]))
    assert 0 < len(fills) <= 3, fills


def test_explicit_fields_override_the_preset():
    """The whole reason every form field defaults to None: a preset supplies the base, and only
    fields the caller actually sent replace it.

    Asserted on `precision` (the 3-colors preset sets 1) rather than on something like n_colors,
    because the fixture only contains three colours - a palette override would be unobservable in
    the output and the test would pass either way."""
    plain = _post({"preset": "3-colors"})
    overridden = _post({"preset": "3-colors", "precision": "4"})
    assert plain.status_code == overridden.status_code == 200

    assert _max_decimals(plain.json()["svg"]) <= 1
    assert _max_decimals(overridden.json()["svg"]) > 1


def test_unknown_preset_is_a_client_error():
    res = _post({"preset": "not-a-preset"})
    assert res.status_code == 400
    assert "not-a-preset" in res.json()["detail"]


def test_custom_preset_matches_sending_no_preset_at_all():
    with_custom = _post({"preset": CUSTOM_ID, "n_colors": "6"}).json()["svg"]
    without = _post({"n_colors": "6"}).json()["svg"]
    assert with_custom == without


def test_omitting_a_field_leaves_the_dataclass_default_untouched():
    """Sending nothing must behave exactly as VectorizeParamsV2() does, now that every field's Form
    default is None rather than the value itself."""
    res = client.post(
        "/api/v2/vectorize",
        files={"image": ("f.png", _fixture_png(), "image/png")},
        data={},
    )
    assert res.status_code == 200
    explicit = _post(
        {
            "n_colors": str(VectorizeParamsV2().n_colors),
            "denoise_strength": str(VectorizeParamsV2().denoise_strength),
            "min_region_area": str(VectorizeParamsV2().min_region_area),
            "min_path_area": str(VectorizeParamsV2().min_path_area),
        }
    )
    assert explicit.status_code == 200
    assert res.json()["svg"] == explicit.json()["svg"]


def test_default_preset_is_exactly_the_dataclass_defaults():
    """The frontend keeps a static DEFAULT_V2_PARAMS mirror for its first render and labels it with
    DEFAULT_PRESET_ID. That label is only honest while the two agree, and a plain
    VectorizeParamsV2() request has to land on the same preset the UI claims is selected."""
    default = get_preset(DEFAULT_PRESET_ID)
    assert default is not None
    assert default.params == VectorizeParamsV2()
