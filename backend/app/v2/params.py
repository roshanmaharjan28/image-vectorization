from dataclasses import dataclass
from typing import Literal

MergeMode = Literal["none", "adjacent", "all"]


@dataclass(frozen=True)
class VectorizeParamsV2:
    """v2's three stages in one frozen dataclass: preprocess (flatten the raster into clean
    regions), trace (vtracer, same surface v1 exposes), postprocess (repair/simplify the SVG
    vtracer emits).

    These defaults are the "high-fidelity-photo" preset in presets.py, and they are deliberately
    the *least* lossy setting rather than the fewest-layers one. The earlier defaults tried to be
    both and were neither: measured against the source on a dense design sheet (1536x1024, small
    text, a teal/orange wrap over a near-black background) they scored a mean absolute error of
    11.58 where raw v1 scored 7.70, because three separate dials were quietly destroying content:

      - n_colors=16 was far too small a palette; the image's own named brand colour had no entry
        at all and rendered as grey. 64 costs almost nothing in layer count (the count is set by
        spatial fragmentation, not palette size: 32 -> 96 colours moved it 9,063 -> 9,884).
      - min_region_area=32 absorbed the text. After quantizing a grainy photo, ~135,000 connected
        components sit under 32px covering a fifth of the image, and small glyphs are themselves
        only 4-30px components, so this dial cannot tell a speck of grain from a letter.
      - min_path_area=16 punched holes. Absorbing a region in preprocess lets the surrounding
        colour grow over it; dropping its path here just reveals whatever was stacked underneath.

    With those at 64/0/0 the same measurement gives 8.96, at 9,208 paths. Every field is
    request-tunable, and presets.py names the useful corners - reach for `low-fidelity-photo` when
    layer count matters, which scores 10.41 at 24 paths and so beats the old defaults on both
    counts at once.
    """

    # --- preprocess (raster -> flat-colour raster) ---
    # Quantization/denoise run at most max_dimension across; tracing always happens back at the
    # image's own resolution, so this bounds preprocessing cost without costing output detail.
    max_dimension: int = 1600
    min_dimension: int = 64
    alpha_threshold: int = 16
    # Bilateral-filter strength. Edge-preserving on purpose: a Gaussian blur of the source (what
    # the shared quantize/preprocess.py does) softens the very colour boundaries the tracer is
    # about to follow, while a bilateral filter flattens JPEG noise/film grain *inside* regions
    # and leaves the boundaries alone. 0 disables it.
    #
    # This is the one dial that reduces layer count without deleting content: it removes the grain
    # that fragments regions in the first place. 0 -> 2 -> 5 measured 11,475 -> 9,728 -> 8,739
    # paths. Kept low by default because it also rounds off genuinely thin features.
    denoise_strength: int = 2
    # k for the Lab k-means posterization, and the cap on how many distinct colours the output can
    # contain (see snap_fills_to_palette, without which vtracer ignores this entirely). Note this
    # is *not* the main lever on layer count, which is what it looks like: one colour can still be
    # thousands of disjoint regions.
    n_colors: int = 64
    kmeans_sample_cap: int = 20000
    palette_merge_distance: float = 5.0
    # Majority (mode) filter over the label map, to straighten the 1px staircase k-means leaves
    # along region boundaries. Off by default: a 3x3 majority vote erases any feature thinner than
    # about 2px (a 1px stroke has 3 of 9 neighbours as itself, so it loses its own vote), and the
    # postprocess RDP+refit already removes staircases geometrically, without that cost.
    smooth_labels: bool = False
    smooth_labels_ksize: int = 3
    # Connected components smaller than this (px, at processing resolution) are absorbed into
    # their dominant neighbour instead of surviving as their own traced path. 0 = keep everything.
    # See the class docstring: on detailed art this is the most destructive dial available, and it
    # turned out not to buy anything either - reaching a given layer count via cutout plus
    # merge_same_fill="all" instead measured 10.41 against this dial's 14.11 at 24 paths. Kept for
    # callers who want it, but no preset raises it.
    min_region_area: int = 0
    # Read by app.quantize.preprocess-compatible code paths; v2 does its own edge-preserving
    # denoise instead of a Gaussian pre-blur, so this stays off.
    blur_ksize: int = 0

    # --- trace (vtracer, identical surface to v1) ---
    colormode: str = "color"
    # "stacked" reproduces detail better (measured 8.84 vs 9.88 overall, and 17.2 vs 21.1 on text)
    # because its layers overlap and refine each other. "cutout" emits disjoint opaque shapes
    # instead: ~60% fewer paths and half the file size, at that fidelity cost. The choice also
    # decides whether merge_same_fill="all" and min_path_area are safe - see their notes below.
    hierarchical: str = "stacked"
    mode: str = "spline"
    filter_speckle: int = 4
    color_precision: int = 8
    layer_difference: int = 16
    corner_threshold: int = 60
    length_threshold: float = 4.0
    splice_threshold: int = 45

    # --- postprocess (svg -> better svg) ---
    # Drops traced paths whose net area is under this (px^2) - the speckle net behind vtracer's
    # own filter_speckle, which measures clusters in the raster, not final path area.
    #
    # Off by default, and not only for fidelity: this is *safe* in the sense of "the region beneath
    # shows through" only under hierarchical="stacked". Under "cutout" there is nothing beneath, so
    # every drop is a transparent pinhole.
    #
    # If the goal is fewer layers, this is the wrong dial and so is min_region_area: cutout plus
    # merge_same_fill="all" gets one path per colour without deleting anything, and measured better
    # at the same layer count (10.41 against 14.11 for 24 paths). No preset raises either any more.
    min_path_area: float = 0.0
    # Ramer-Douglas-Peucker tolerance in px. Decides which vertices count as *structure* (and so
    # where corners are); how closely the emitted curves follow the contour is max_fit_error's job.
    # Kept above 0.5 on purpose: a 1px raster staircase deviates 0.5px from the line it should
    # collapse to, so a tolerance below that keeps every step as structure - and each step's 90
    # degree turn then reads as a corner, which is how a straight edge ends up as forty segments.
    simplify_tolerance: float = 0.5
    # Refit the contour as cubics (corner-aware) instead of emitting a polygon.
    smooth_curves: bool = True
    # Hard bound (px) on how far an emitted cubic may sit from the flattened contour. The fitter
    # splits a run until it holds, so this is the accuracy dial: raising it buys fewer, longer
    # curves, and lowering it buys fidelity at the cost of anchor points.
    max_fit_error: float = 0.5
    # Turn angle (degrees) above which a vertex is treated as a real corner and kept sharp.
    smooth_corner_angle: float = 62.0
    # Snap every traced fill onto the palette the preprocess stage quantized to. On by default
    # because vtracer does not preserve the palette it is given: handed a raster containing 59
    # distinct flat colours it emitted 5,420 distinct fills (2,675 in cutout mode, and still 1,098
    # at color_precision=4). That silently breaks the guarantee that n_colors bounds the output's
    # colour count, and it defeats merge_same_fill, which can only combine fills that are exactly
    # equal. Snapping brought that document back to 58 fills for 0.2 of measured error.
    snap_fills_to_palette: bool = True
    # "adjacent" merges only consecutive same-fill runs (vtracer emits one colour layer at a
    # time, so these are the disjoint components of a single colour - merging them cannot change
    # what any pixel renders as). "all" merges every same-fill path regardless of stacking
    # position.
    #
    # "all" is what turns snapping into a real layer-count reduction: with fills capped at the
    # palette it collapses a document to one path per colour (9,208 -> 59). Whether that is
    # *correct* depends entirely on hierarchical - under "stacked" those paths overlap and their
    # order carries the image, so collapsing them measured 14.01 against 9.04, whereas under
    # "cutout" the shapes are disjoint. Hence opt-in, and only the cutout presets take it.
    merge_same_fill: MergeMode = "adjacent"
    # Decimal places kept in path data. vtracer emits full float64 repr (17 digits per number).
    precision: int = 2
    # Paints each path's own fill as a hairline stroke, closing the sub-pixel seams that show
    # between adjacent regions in stacked mode. Off by default: the WebGL canvas renders fills
    # only, so a non-zero value makes the downloaded SVG differ from what the editor shows.
    seam_stroke_width: float = 0.0
