from dataclasses import dataclass


@dataclass(frozen=True)
class VectorizeParamsV3:
    """Preprocessing/color-reduction defaults shared with v2, plus vtracer
    tracing params shared with v1. No tuning UI yet, matching v1 and v2."""

    max_dimension: int = 2000
    min_dimension: int = 64
    blur_ksize: int = 3
    n_colors: int = 48
    kmeans_sample_cap: int = 20000
    alpha_threshold: int = 16
    palette_merge_distance: float = 4.0

    mode: str = "spline"
    hierarchical: str = "cutout"
    filter_speckle: int = 2
    color_precision: int = 8
    layer_difference: int = 10
    corner_threshold: int = 45
    length_threshold: float = 3.5
    splice_threshold: int = 30
