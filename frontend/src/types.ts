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

// Mirrors the backend's grouping response schema exactly (see backend/app/grouping/schema.py's
// serialize_node) — no field-name translation between wire format and frontend type.
export interface LeafRef {
  type: 'leaf';
  index: number; // index into the SVG's <path> document order, 1:1 with Layer[] array order
}

export interface GroupNode {
  type: 'group';
  id: string;
  label: string | null;
  children: TreeNode[];
}

export type TreeNode = LeafRef | GroupNode;

// 'none' skips grouping entirely (default, byte-identical to pre-grouping behavior); 'opencv' and
// 'fastsam' select which backend engine computes the `groups` forest.
export type GroupingMode = 'none' | 'opencv' | 'fastsam';

// 'cursor' interacts with canvas elements (select/move/scale/rotate/path-edit); 'hand' only pans
// the canvas, ignoring whatever's under the pointer; 'pen' clicks a layer straight into path-edit
// mode (the same entry point 'cursor' reaches via double-click).
export type Tool = 'cursor' | 'hand' | 'pen';

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
  /** v2's own pre/post-processing stages. Present only for the v2 endpoint — its absence is what
   *  tells ParamsPanel not to render those sections, and appendVectorizeParams not to send the
   *  fields (v1/v3 would reject them). Mirrors backend/app/v2/params.py. */
  v2?: V2Params;
}

// "adjacent" only combines consecutive same-fill paths, which vtracer emits one colour layer at a
// time, so the merge cannot change what any pixel renders as. "all" reaches across stacking
// positions for a lower layer count and can change occlusion. See backend/app/v2/postprocess.py.
export type MergeSameFill = 'none' | 'adjacent' | 'all';

/** One entry of GET /api/v2/presets. The backend serves these rather than the frontend keeping its
 *  own table, so the values the sliders show are the values the backend will actually use.
 *
 *  `params` is a complete VectorizeParams, not just the v2 sub-object: presets set trace fields
 *  too (the flat-colour ones switch to hierarchical="cutout"), and since this client always sends
 *  every field explicitly, a preset that only carried its v2 half would be silently overridden
 *  back to the previous trace settings. */
export interface V2PresetInfo {
  id: string;
  label: string;
  description: string;
  params: VectorizeParams;
}

/** Selected-but-edited state. The backend accepts this id too, where it means "use exactly the
 *  fields I sent" — which is already what the frontend does, since it always sends every field. */
export const CUSTOM_PRESET_ID = 'custom';

export interface V2Params {
  /** Which named preset these values came from, or CUSTOM_PRESET_ID once any control is touched.
   *  Purely a label: every field below is sent explicitly, so this never changes the result. */
  presetId: string;
  // preprocess: raster -> flat-colour regions
  denoiseStrength: number;
  colorCount: number;
  smoothLabels: boolean;
  minRegionArea: number;
  // postprocess: traced svg -> fewer, smoother paths
  minPathArea: number;
  simplifyTolerance: number;
  maxFitError: number;
  smoothCurves: boolean;
  smoothCornerAngle: number;
  /** vtracer does not preserve the palette the preprocess stage chose, so without this the
   *  output's colour count is unbounded regardless of colorCount. See backend postprocess. */
  snapFillsToPalette: boolean;
  mergeSameFill: MergeSameFill;
  precision: number;
  seamStrokeWidth: number;
}
