import numpy as np

from .bezier_fit import fit_curve_closed
from .color_reduce import reduce_colors
from .params import VectorizeParamsV2
from .preprocess import decode_image, preprocess
from .regions import extract_regions
from .simplify import simplify_polygon
from .svg_build import build_region_path, build_svg_document, segments_to_path_d


def vectorize_image_v2(raw: bytes, params: VectorizeParamsV2 = VectorizeParamsV2()) -> str:
    rgba = decode_image(raw)
    orig_h, orig_w = rgba.shape[:2]

    bgr, opaque_mask, scale = preprocess(rgba, params)
    label_map, palette = reduce_colors(bgr, opaque_mask, params)
    regions = extract_regions(label_map, palette, params.min_region_area_px)

    path_elements = []
    for region in regions:
        outer = simplify_polygon(region.outer, params.simplify_epsilon_frac)
        if len(outer) < 3:
            continue

        holes = [simplify_polygon(h, params.simplify_epsilon_frac) for h in region.holes]
        holes = [h for h in holes if len(h) >= 3]

        outer_curve = fit_curve_closed(outer.astype(np.float64), params.bezier_max_error)
        if not outer_curve:
            continue

        hole_curves = [fit_curve_closed(h.astype(np.float64), params.bezier_max_error) for h in holes]
        hole_curves = [hc for hc in hole_curves if hc]

        # Rescale from processing resolution back to the original image's
        # dimensions, so the emitted SVG's viewBox matches the upload as-is.
        outer_curve = [seg / scale for seg in outer_curve]
        hole_curves = [[seg / scale for seg in hc] for hc in hole_curves]

        d = segments_to_path_d([outer_curve, *hole_curves])
        path_elements.append(build_region_path(d, region.color_bgr))

    return build_svg_document(orig_w, orig_h, path_elements)
