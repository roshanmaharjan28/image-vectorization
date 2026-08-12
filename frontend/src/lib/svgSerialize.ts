import type { Layer, SvgMeta } from '../types';

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

/** Renders a layer's original SVG attributes verbatim (d, fill, transform, fill-rule, etc.). */
export function layerToPathMarkup(layer: Layer, options?: MarkupOptions): string {
  const overrides: Record<string, string> = {};
  if (options?.interactive) {
    overrides['data-layer-id'] = layer.id;
  }
  const attrs = { ...layer.attrs, ...overrides };
  return `<path ${attrsToString(attrs)} />`;
}

/** CSS rule that highlights a single layer by id, for use inside an inline <style> tag. */
export function layerHighlightRule(layerId: string): string {
  const selector = `path[data-layer-id="${layerId.replace(/"/g, '')}"]`;
  return `${selector}{stroke:#4dabf7;stroke-width:3;stroke-opacity:.9;vector-effect:non-scaling-stroke;}`;
}

/** Serializes only visible layers, so hidden layers are excluded from the export. */
export function buildSvgString(meta: SvgMeta, layers: Layer[]): string {
  const paths = layers
    .filter((layer) => layer.visible)
    .map((layer) => `  ${layerToPathMarkup(layer)}`)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}" viewBox="${meta.viewBox}">`,
    paths,
    '</svg>',
  ].join('\n');
}
