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
}

export type Stage = 'empty' | 'has-image' | 'vectorizing' | 'vectorized';
