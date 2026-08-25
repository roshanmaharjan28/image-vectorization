import { CUSTOM_PRESET_ID, type V2Params, type V2PresetInfo, type VectorizeParams } from '../types';

// Matches v3's VectorizeParamsV3 field defaults in backend/app/v3/params.py.
export const DEFAULT_V3_PARAMS: VectorizeParams = {
  colormode: 'color',
  hierarchical: 'stacked',
  mode: 'spline',
  filterSpeckle: 2,
  colorPrecision: 8,
  layerDifference: 10,
  cornerThreshold: 45,
  lengthThreshold: 3.5,
  spliceThreshold: 30,
};

// Matches /api/vectorize's Form defaults in backend/app/main.py, which preserve
// v1's original hardcoded call (hierarchical="cutout", layer_difference=12).
export const DEFAULT_V1_PARAMS: VectorizeParams = {
  ...DEFAULT_V3_PARAMS,
  hierarchical: 'cutout',
  layerDifference: 12,
};

// Matches VectorizeParamsV2 in backend/app/v2/params.py, trace fields included — v2's trace
// defaults differ from v1's on purpose (it traces an already-flattened raster), so this is a full
// list rather than a spread of DEFAULT_V1_PARAMS.
//
// These values also match the DEFAULT_PRESET_ID preset in backend/app/v2/presets.py, which is what
// lets the initial UI state carry that preset's name honestly. This is a fallback for the initial
// render and for a failed /presets fetch; the preset dropdown itself is served by the backend.
export const DEFAULT_V2_PARAMS: VectorizeParams = {
  colormode: 'color',
  hierarchical: 'stacked',
  mode: 'spline',
  filterSpeckle: 4,
  colorPrecision: 8,
  layerDifference: 16,
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  v2: {
    presetId: 'high-fidelity-photo',
    denoiseStrength: 2,
    colorCount: 64,
    smoothLabels: false,
    minRegionArea: 0,
    minPathArea: 0,
    simplifyTolerance: 0.5,
    maxFitError: 0.5,
    smoothCurves: true,
    smoothCornerAngle: 62,
    snapFillsToPalette: true,
    mergeSameFill: 'adjacent',
    precision: 2,
    seamStrokeWidth: 0,
  },
};

export function defaultParamsFor(apiEndpoint: string): VectorizeParams {
  if (apiEndpoint.includes('/v2/')) return DEFAULT_V2_PARAMS;
  if (apiEndpoint.includes('/v3/')) return DEFAULT_V3_PARAMS;
  return DEFAULT_V1_PARAMS;
}

/** The preset list, straight from the backend that owns it. Field names on the wire are snake_case
 *  (they are the same dataclass the vectorize route takes), so they get mapped here — the one place
 *  that mapping lives, alongside the outbound mapping in appendV2Params below. */
export async function fetchV2Presets(): Promise<V2PresetInfo[]> {
  const response = await fetch('/api/v2/presets');
  if (!response.ok) throw new Error(`Could not load presets (${response.status})`);
  const body = (await response.json()) as { presets: RawPreset[] };
  return body.presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    params: {
      colormode: preset.params.colormode,
      hierarchical: preset.params.hierarchical,
      mode: preset.params.mode,
      filterSpeckle: preset.params.filter_speckle,
      colorPrecision: preset.params.color_precision,
      layerDifference: preset.params.layer_difference,
      cornerThreshold: preset.params.corner_threshold,
      lengthThreshold: preset.params.length_threshold,
      spliceThreshold: preset.params.splice_threshold,
      v2: {
        presetId: preset.id,
        denoiseStrength: preset.params.denoise_strength,
        colorCount: preset.params.n_colors,
        smoothLabels: preset.params.smooth_labels,
        minRegionArea: preset.params.min_region_area,
        minPathArea: preset.params.min_path_area,
        simplifyTolerance: preset.params.simplify_tolerance,
        maxFitError: preset.params.max_fit_error,
        smoothCurves: preset.params.smooth_curves,
        smoothCornerAngle: preset.params.smooth_corner_angle,
        snapFillsToPalette: preset.params.snap_fills_to_palette,
        mergeSameFill: preset.params.merge_same_fill,
        precision: preset.params.precision,
        seamStrokeWidth: preset.params.seam_stroke_width,
      },
    },
  }));
}

interface RawPreset {
  id: string;
  label: string;
  description: string;
  params: {
    colormode: VectorizeParams['colormode'];
    hierarchical: VectorizeParams['hierarchical'];
    mode: VectorizeParams['mode'];
    filter_speckle: number;
    color_precision: number;
    layer_difference: number;
    corner_threshold: number;
    length_threshold: number;
    splice_threshold: number;
    denoise_strength: number;
    n_colors: number;
    smooth_labels: boolean;
    min_region_area: number;
    min_path_area: number;
    simplify_tolerance: number;
    max_fit_error: number;
    smooth_curves: boolean;
    smooth_corner_angle: number;
    snap_fills_to_palette: boolean;
    merge_same_fill: V2Params['mergeSameFill'];
    precision: number;
    seam_stroke_width: number;
  };
}

export function appendVectorizeParams(formData: FormData, params: VectorizeParams) {
  formData.append('colormode', params.colormode);
  formData.append('hierarchical', params.hierarchical);
  formData.append('mode', params.mode);
  formData.append('filter_speckle', String(params.filterSpeckle));
  formData.append('color_precision', String(params.colorPrecision));
  formData.append('layer_difference', String(params.layerDifference));
  formData.append('corner_threshold', String(params.cornerThreshold));
  formData.append('length_threshold', String(params.lengthThreshold));
  formData.append('splice_threshold', String(params.spliceThreshold));
  if (params.v2) appendV2Params(formData, params.v2);
}

// Only ever sent to /api/v2/vectorize — v1 and v3 declare no such form fields.
function appendV2Params(formData: FormData, v2: V2Params) {
  // Sent for the record, not for effect: every field below is also sent explicitly, and explicit
  // fields override the preset's own values on the backend. It keeps the request self-describing
  // (and correct if the backend ever grows a v2 field this client doesn't know to send).
  formData.append('preset', v2.presetId || CUSTOM_PRESET_ID);
  formData.append('denoise_strength', String(v2.denoiseStrength));
  formData.append('n_colors', String(v2.colorCount));
  formData.append('smooth_labels', String(v2.smoothLabels));
  formData.append('min_region_area', String(v2.minRegionArea));
  formData.append('min_path_area', String(v2.minPathArea));
  formData.append('simplify_tolerance', String(v2.simplifyTolerance));
  formData.append('max_fit_error', String(v2.maxFitError));
  formData.append('smooth_curves', String(v2.smoothCurves));
  formData.append('smooth_corner_angle', String(v2.smoothCornerAngle));
  formData.append('snap_fills_to_palette', String(v2.snapFillsToPalette));
  formData.append('merge_same_fill', v2.mergeSameFill);
  formData.append('precision', String(v2.precision));
  formData.append('seam_stroke_width', String(v2.seamStrokeWidth));
}
