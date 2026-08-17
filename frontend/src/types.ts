import type { Mat2x3 } from './lib/svgTransform';

export interface SvgMeta {
  width: string;
  height: string;
  viewBox: string;
}

export interface Layer {
  id: string;
  fill: string;
  attrs: Record<string, string>;
  visible: boolean;
  /** Soft-deleted layers stay in the array (so Canvas never has to rebuild its
   *  path list) but are hidden via CSS and excluded from the panel/export. */
  deleted: boolean;
  /** Cumulative user-edit matrix (move/scale/rotate), applied on top of the already-triangulated
   *  base geometry (`attrs.d` + `attrs.transform`) — identity until the user edits this layer. See
   *  CanvasGL.tsx's per-layer transform texture for how this is applied without re-triangulating. */
  transform: Mat2x3;
}

export type Stage = 'empty' | 'has-image' | 'vectorizing' | 'vectorized';

// vtracer-facing params, shared by v1 (raw vtracer call) and v3 (preprocess +
// vtracer — see backend/app/v3/params.py, whose preprocessing fields aren't
// exposed here since there's no UI control for them yet).
export interface VectorizeParams {
  colormode: 'color' | 'binary';
  hierarchical: 'stacked' | 'cutout';
  mode: 'spline' | 'polygon' | 'none';
  filterSpeckle: number;
  colorPrecision: number;
  layerDifference: number;
  cornerThreshold: number;
  lengthThreshold: number;
  spliceThreshold: number;
}
