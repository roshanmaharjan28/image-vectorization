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
}

export type Stage = 'empty' | 'has-image' | 'vectorizing' | 'vectorized';
