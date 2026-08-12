import type { Layer, SvgMeta } from '../types';

let nextLayerId = 0;

function extractFill(el: Element): string {
  const fillAttr = el.getAttribute('fill');
  if (fillAttr) return fillAttr;

  const style = el.getAttribute('style');
  if (style) {
    const match = style.match(/fill\s*:\s*([^;]+)/i);
    if (match) return match[1].trim();
  }

  return '#000000';
}

export function parseSvgToLayers(svgString: string): { meta: SvgMeta; layers: Layer[] } {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');

  if (!svgEl || doc.querySelector('parsererror')) {
    throw new Error('Failed to parse the SVG returned by the server');
  }

  const width = svgEl.getAttribute('width') ?? '100';
  const height = svgEl.getAttribute('height') ?? '100';
  const viewBox = svgEl.getAttribute('viewBox') ?? `0 0 ${parseFloat(width)} ${parseFloat(height)}`;

  const layers: Layer[] = Array.from(svgEl.querySelectorAll('path')).map((el) => {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      attrs[attr.name] = attr.value;
    }

    return {
      id: `layer-${nextLayerId++}`,
      fill: extractFill(el),
      attrs,
      visible: true,
    };
  });

  return { meta: { width, height, viewBox }, layers };
}
