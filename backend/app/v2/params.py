from dataclasses import dataclass


@dataclass(frozen=True)
class VectorizeParamsV2:
    """Tunable defaults for the v2 pipeline. No tuning UI yet - these are hardcoded
    entry points a future request-driven config could override without a rewrite."""

    max_dimension: int = 1600
    min_dimension: int = 64
    blur_ksize: int = 3
    n_colors: int = 12
    kmeans_sample_cap: int = 20000
    min_region_area_px: int = 12
    simplify_epsilon_frac: float = 0.0025
    bezier_max_error: float = 2.0
    alpha_threshold: int = 16
    palette_merge_distance: float = 6.0
