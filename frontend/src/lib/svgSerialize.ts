import type { Layer, SvgMeta } from '../types';
import { flattenPathToContours } from './pathFlatten';
import { applyTransform, isIdentityMatrix, parseTransform } from './svgTransform';

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

/** Tight bounding box, in final rendered (viewBox) space, of a set of layers' painted geometry —
 *  i.e. after both each layer's original `transform` attribute and its editable gizmo transform
 *  are applied. Returns null if none of the layers have any paintable geometry. */
function computeLayersBBox(layers: Layer[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const layer of layers) {
    if (!layer.visible || layer.deleted || !layer.attrs.d) continue;
    try {
      const matrix = parseTransform(composedTransformAttr(layer));
      for (const contour of flattenPathToContours(layer.attrs.d)) {
        for (const [x, y] of contour) {
          const [tx, ty] = applyTransform(matrix, x, y);
          if (tx < minX) minX = tx;
          if (tx > maxX) maxX = tx;
          if (ty < minY) minY = ty;
          if (ty > maxY) maxY = ty;
        }
      }
    } catch {
      // Skip paths the DOM can't parse rather than failing the whole export.
    }
  }
  return minX > maxX || minY > maxY ? null : { minX, minY, maxX, maxY };
}

/**
 * Same as buildSvgString, but crops the document down to the tight bounding box of `layers`
 * instead of using the full original canvas — so downloading a group produces just that group,
 * positioned at its own origin, rather than the whole original artwork's dimensions with
 * everything but the group left blank. Falls back to `fallbackMeta` (the full canvas) if the
 * layers have no measurable geometry (e.g. an empty group).
 */
export function buildGroupSvgString(layers: Layer[], fallbackMeta: SvgMeta): string {
  const bbox = computeLayersBBox(layers);
  if (!bbox) return buildSvgString(fallbackMeta, layers);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  const meta: SvgMeta = {
    width: String(width),
    height: String(height),
    viewBox: `${bbox.minX} ${bbox.minY} ${width} ${height}`,
  };
  return buildSvgString(meta, layers);
}
