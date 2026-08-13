const SVG_NS = 'http://www.w3.org/2000/svg';

const MIN_SAMPLES = 6;
const MAX_SAMPLES = 64;
const SAMPLE_SPACING_PX = 4;

export type Point = [number, number];

function createDetachedPath(d: string): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', d);
  return el;
}

/** Splits a `d` string into its M/m-delimited subpaths, each kept as its own moveto + commands. */
function splitSubpaths(d: string): string[] {
  const matches = d.match(/[Mm][^Mm]*/g);
  return matches ?? [d];
}

/**
 * Flattens an SVG path `d` string into polygon contours (one per subpath) by delegating curve
 * math to the browser's own SVGPathElement.getPointAtLength — far more robust than hand-rolling
 * bezier/arc flattening, and works on a detached element (no DOM attach needed).
 */
export function flattenPathToContours(d: string): Point[][] {
  const contours: Point[][] = [];

  for (const sub of splitSubpaths(d)) {
    const el = createDetachedPath(sub);
    let length: number;
    try {
      length = el.getTotalLength();
    } catch {
      continue;
    }
    if (!Number.isFinite(length) || length <= 0) continue;

    const sampleCount = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(length / SAMPLE_SPACING_PX)));
    const points: Point[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const pt = el.getPointAtLength((length * i) / sampleCount);
      points.push([pt.x, pt.y]);
    }

    const deduped = points.filter(
      (p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-3,
    );
    if (deduped.length >= 3) contours.push(deduped);
  }

  return contours;
}
