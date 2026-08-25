"""Named starting points for v2, in the spirit of Illustrator's Image Trace presets.

v2 has three stages and ~20 dials, and the useful settings are strongly correlated, so exposing the
dials individually (which is all v2 had) means every user has to rediscover those correlations, and
no single default can suit both a flat logo and a dense photographic composite. The dials stay, and
these presets name the useful corners.

Each preset is a complete VectorizeParamsV2, not a patch, so a preset fully determines the result
and reading one tells you every value it implies. The frontend fetches the list from
GET /api/v2/presets rather than keeping its own copy, so the values in the UI sliders are always
the values the backend will actually use.

Numbers quoted below are mean absolute error against the source (0 = identical) and final path
count, measured by rendering each output in a browser and differencing it against the 1536x1024
design sheet in samples/ - small text, a teal/orange vehicle wrap over a near-black background.
References on that image: raw v1 scores 7.70 at 19,957 paths, and v2's pre-retune defaults scored
11.58 at 2,769.

Reading the fidelity numbers: pixel error rewards reproducing the source exactly, including its
JPEG grain, which is most of why v1 still leads on it. It also badly under-weights the failure the
old defaults actually had - rendering the wrap's teal as grey costs little error over a small area
while being the most visible thing wrong with the output - so treat these as a regression guard,
not as a ranking of how good each preset looks.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .params import VectorizeParamsV2

# The shared base. Only the fields a preset actually cares about are overridden below, so anything
# absent from every preset (the resize bounds, the k-means internals) is defined exactly once.
_BASE = VectorizeParamsV2()


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    description: str
    params: VectorizeParamsV2


# error 8.96, 9,208 paths. The defaults; see VectorizeParamsV2's docstring for why every dial that
# would delete content sits at 0.
_HIGH_FIDELITY = replace(_BASE)


# The few-layers profile, shared by every preset below. Two decisions carry it, both measured:
#
#   - Layer count comes from `cutout` + `merge_same_fill="all"`, which collapses the document to one
#     path per palette colour. Under cutout that merge is free - the shapes are disjoint, so
#     reordering them changes nothing, and 24 merged paths scored 14.11 against 14.12 for the same
#     settings leaving 2,467 unmerged. (Under `stacked` the same merge is destructive, 14.01 against
#     9.04, because there the paths overlap and their order carries the image.)
#   - Layer count does *not* come from absorbing regions or dropping paths. That was the previous
#     approach here and it was simply worse: at the same 24 paths, absorption on scored 14.11 and
#     absorption off scored 10.41. `min_region_area` and `min_path_area` therefore stay at 0, and
#     the palette is the only thing that varies between the presets below.
#
# Curve fitting is loosened (0.8 / 1.0 against the default 0.5 / 0.5) and precision dropped to 1
# decimal, which costs little once the image is this posterised and roughly halves the file size.
_FEW_LAYERS = replace(
    _BASE,
    hierarchical="cutout",
    merge_same_fill="all",
    denoise_strength=3,
    simplify_tolerance=0.8,
    max_fit_error=1.0,
    precision=1,
)


PRESETS: tuple[Preset, ...] = (
    Preset(
        id="high-fidelity-photo",
        label="High Fidelity Photo",
        description="Large palette, nothing absorbed or dropped. Most faithful, most layers.",
        params=_HIGH_FIDELITY,
    ),
    Preset(
        # error 10.41, 24 paths - better than the old defaults on both counts at once.
        id="low-fidelity-photo",
        label="Low Fidelity Photo",
        description="One layer per colour. Fewest layers for a still-photographic result.",
        params=replace(_FEW_LAYERS, n_colors=24),
    ),
    Preset(
        id="16-colors",
        label="16 Colors",
        description="Posterised to 16 flat colours, one layer each.",
        params=replace(_FEW_LAYERS, n_colors=16),
    ),
    Preset(
        id="6-colors",
        label="6 Colors",
        description="Posterised to 6 flat colours, one layer each.",
        params=replace(_FEW_LAYERS, n_colors=6),
    ),
    Preset(
        id="3-colors",
        label="3 Colors",
        description="Posterised to 3 flat colours, one layer each.",
        params=replace(_FEW_LAYERS, n_colors=3),
    ),
)

_BY_ID = {preset.id: preset for preset in PRESETS}

# The id the frontend uses for "the sliders no longer match any preset". It is accepted on the wire
# so a client can round-trip whatever it has selected, and means "use exactly the fields I sent".
CUSTOM_ID = "custom"

DEFAULT_PRESET_ID = "high-fidelity-photo"


def get_preset(preset_id: str) -> Preset | None:
    """The named preset, or None for `custom` / an unknown id - both of which mean the caller's
    own field values (falling back to VectorizeParamsV2's defaults) decide the result."""
    return _BY_ID.get(preset_id)


def preset_ids() -> list[str]:
    return [preset.id for preset in PRESETS] + [CUSTOM_ID]
