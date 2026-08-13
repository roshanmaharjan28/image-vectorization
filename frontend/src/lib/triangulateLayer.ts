import earcut from 'earcut';
import { flattenPathToContours, type Point } from './pathFlatten';
import { applyTransform, parseTransform } from './svgTransform';

export interface LayerTriangulation {
  /** Flat [x, y, x, y, ...] vertex positions in the SVG's viewBox coordinate space. */
  positions: number[];
  /** Triangle indices into `positions` (grouped in threes). */
  indices: number[];
}

const EMPTY: LayerTriangulation = { positions: [], indices: [] };

function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function flattenRings(rings: Point[][]): { vertices: number[]; holeIndices: number[] } {
  const vertices: number[] = [];
  const holeIndices: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(vertices.length / 2);
    for (const [x, y] of rings[r]) vertices.push(x, y);
  }
  return { vertices, holeIndices };
}

/**
 * Groups a path's raw subpath contours into outer/hole shapes by nesting-depth parity (depth
 * 0, 2, 4... are solid outers; 1, 3, 5... are holes owned by their nearest enclosing ancestor —
 * the standard way to resolve nonzero/evenodd fill regions from unordered subpaths), then
 * triangulates each outer+holes group with earcut.
 */
function triangulateContours(contours: Point[][]): LayerTriangulation {
  const n = contours.length;
  if (n === 0) return EMPTY;
  if (n === 1) {
    const flat = contours[0].flat();
    return { positions: flat, indices: earcut(flat) };
  }

  const depth = contours.map((c, i) => {
    let d = 0;
    for (let j = 0; j < n; j++) {
      if (j !== i && pointInPolygon(c[0], contours[j])) d++;
    }
    return d;
  });

  const parent = contours.map((c, i) => {
    let best = -1;
    let bestDepth = -1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (depth[j] > bestDepth && pointInPolygon(c[0], contours[j])) {
        best = j;
        bestDepth = depth[j];
      }
    }
    return best;
  });

  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue; // holes are consumed by their parent's group below
    const holes = contours.filter((_, j) => parent[j] === i && depth[j] % 2 === 1);
    const { vertices, holeIndices } = flattenRings([contours[i], ...holes]);
    const tris = earcut(vertices, holeIndices.length ? holeIndices : null);
    const base = positions.length / 2;
    for (const t of tris) indices.push(base + t);
    positions.push(...vertices);
  }

  return { positions, indices };
}

/**
 * Flattens a path's `d` attribute and triangulates it, ready for a WebGL fill draw call. Applies
 * the path's `transform` attribute (vtracer emits `translate(tx,ty)` on every path) to the
 * flattened points before triangulating, since — unlike the DOM/SVG renderer — nothing else here
 * would otherwise honor it.
 */
export function triangulateLayerPath(d: string | undefined, transform?: string): LayerTriangulation {
  if (!d) return EMPTY;
  try {
    const contours = flattenPathToContours(d);
    if (transform) {
      const matrix = parseTransform(transform);
      for (const contour of contours) {
        for (let i = 0; i < contour.length; i++) {
          contour[i] = applyTransform(matrix, contour[i][0], contour[i][1]);
        }
      }
    }
    return triangulateContours(contours);
  } catch {
    return EMPTY;
  }
}
