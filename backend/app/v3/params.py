from dataclasses import dataclass


@dataclass(frozen=True)
class VectorizeParamsV3:
    """Preprocessing/color-reduction defaults shared with v2, plus vtracer
    tracing params shared with v1. The vtracer fields below are user-tunable
    from the frontend params panel; defaults match vtracer's own effective
    defaults so an unmodified request behaves the same as before tuning existed."""

    max_dimension: int = 2000
    min_dimension: int = 64
    blur_ksize: int = 3
    n_colors: int = 64
    kmeans_sample_cap: int = 20000
    alpha_threshold: int = 16
    palette_merge_distance: float = 4.0

    colormode: str = "color"
    mode: str = "spline"
    hierarchical: str = "stacked"
    filter_speckle: int = 2
    color_precision: int = 8
    layer_difference: int = 10
    corner_threshold: int = 45
    length_threshold: float = 3.5
    splice_threshold: int = 30
