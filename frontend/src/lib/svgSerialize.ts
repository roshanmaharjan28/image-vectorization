import type { Layer, SvgMeta } from '../types';
import { isIdentityMatrix } from './svgTransform';

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function attrsToString(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');
}

interface MarkupOptions {
  /** Tags the path with data-layer-id so canvas hover can be resolved back to a layer. */
  interactive?: boolean;
}

/** Prepends a layer's editable transform (see types.ts) to its original `transform` attribute, so
 *  moves/scales/rotates made via the gizmo show up in both the exported SVG and layer thumbnails. */
function composedTransformAttr(layer: Layer): string | undefined {
  if (isIdentityMatrix(layer.transform)) return layer.attrs.transform;
  const [a, b, c, d, e, f] = layer.transform;
  const matrix = `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
  return layer.attrs.transform ? `${matrix} ${layer.attrs.transform}` : matrix;
}

/** Renders a layer's original SVG attributes verbatim (d, fill, transform, fill-rule, etc.), with
 *  its editable transform (if any) composed into `transform`. */
export function layerToPathMarkup(layer: Layer, options?: MarkupOptions): string {
  const overrides: Record<string, string> = {};
  if (options?.interactive) {
    overrides['data-layer-id'] = layer.id;
  }
  const transform = composedTransformAttr(layer);
  if (transform) overrides.transform = transform;
  const attrs = { ...layer.attrs, ...overrides };
  return `<path ${attrsToString(attrs)} />`;
}

/**
 * Returns a copy of `layer` recolored to `hex`. Updates both `fill` (read directly by the GL
 * renderer's palette texture) and `attrs.fill` (read by the SVG export/thumbnail markup), and
 * strips any conflicting `fill:` declaration from `attrs.style` — a `style` attribute's fill wins
 * over the `fill` presentation attribute per the SVG/CSS cascade, so leaving a stale one behind
 * would silently keep the old color in the exported file even though the GL view updated.
 */
export function setLayerFill(layer: Layer, hex: string): Layer {
  const attrs: Record<string, string> = { ...layer.attrs, fill: hex };
  if (attrs.style) {
    const stripped = attrs.style.replace(/(?:^|;)\s*fill\s*:\s*[^;]+/gi, '').replace(/^;+\s*/, '').trim();
    if (stripped) attrs.style = stripped;
    else delete attrs.style;
  }
  return { ...layer, fill: hex, attrs };
}

/** Serializes only visible, non-deleted layers, so hidden/deleted layers are excluded from the export. */
export function buildSvgString(meta: SvgMeta, layers: Layer[]): string {
  const paths = layers
    .filter((layer) => layer.visible && !layer.deleted)
    .map((layer) => `  ${layerToPathMarkup(layer)}`)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}" viewBox="${meta.viewBox}">`,
    paths,
    '</svg>',
  ].join('\n');
}
