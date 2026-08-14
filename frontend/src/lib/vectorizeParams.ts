import type { VectorizeParams } from '../types';

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
}
