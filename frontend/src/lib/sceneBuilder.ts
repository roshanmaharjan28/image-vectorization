import type { Layer } from '../types';
import { buildLayerGeometry, type LayerGeometry } from './triangulateLayer';

// Per-layer triangulation is expensive (flattenPathToContours walks the DOM's
// SVGPathElement.getPointAtLength for every subpath) and buildSceneGeometry reruns for the whole
// layer set on every path-edit drag frame (see useCanvasGLScene's geometryVersion). Since a drag
// only ever replaces the edited layer's `attrs` object (see useCanvasPathEditing), every other
// layer's `attrs` reference is stable frame-to-frame — cache each layer's geometry by that
// reference so a drag only re-triangulates the one shape actually changing, instead of the whole
// scene every frame. Entries are dropped automatically once a layer's `attrs` is replaced.
const layerGeometryCache = new WeakMap<Layer['attrs'], LayerGeometry>();

function buildLayerGeometryCached(layer: Layer): LayerGeometry {
  const cached = layerGeometryCache.get(layer.attrs);
  if (cached) return cached;
  const geometry = buildLayerGeometry(layer.attrs.d, layer.attrs.transform);
  layerGeometryCache.set(layer.attrs, geometry);
  return geometry;
}

export interface SceneGeometry {
  positions: Float32Array; // [x, y, x, y, ...] in viewBox space
  layerIndices: Float32Array; // one value per vertex — index into `layers`
  indices: Uint32Array;
  layerCount: number;
  // Outline geometry: one thick-line quad (6 vertices, drawn via drawArrays TRIANGLES — see
  // CanvasGL's outline shader) per contour edge, for every contour of every layer (outer rings
  // and holes alike). Used to draw just the hovered/selected layer's edge, mirroring Canvas.tsx's
  // CSS stroke instead of tinting the whole fill.
  outlinePositions: Float32Array; // this vertex's endpoint, [x, y, ...]
  outlineOther: Float32Array; // the segment's *other* endpoint, [x, y, ...] — lets the vertex shader compute a screen-space normal
  outlineSide: Float32Array; // -1 / +1, which side of the segment this vertex is extruded to
  outlineLayerIndices: Float32Array; // one value per vertex — index into `layers`
  // One [minX, minY, maxX, maxY] per layer, in the same base world space as `positions` (i.e.
  // *before* the layer's editable `transform` is applied) — used by CanvasGL's gizmo to place
  // selection handles without re-triangulating.
  layerBounds: Float32Array;
}

let colorCanvas: HTMLCanvasElement | null = null;
let colorCtx: CanvasRenderingContext2D | null = null;

/** Resolves any CSS color string to RGB bytes via a 1x1 canvas, sidestepping the need to hand-roll a CSS color parser. */
function parseCssColor(color: string): [number, number, number] {
  if (!colorCtx) {
    colorCanvas = document.createElement('canvas');
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = colorCtx!;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return [data[0], data[1], data[2]];
}

/** A layer with fill:none renders nothing in SVG and shouldn't be drawn or pickable in GL either. */
function isPaintedLayer(layer: Layer): boolean {
  return layer.fill.trim().toLowerCase() !== 'none';
}

export function isLayerVisible(layer: Layer): boolean {
  return layer.visible && !layer.deleted && isPaintedLayer(layer);
}

/**
 * Triangulates every layer's path once (keyed on `meta`/layer-set identity by the caller, same
 * as Canvas.tsx's pathsMarkup) and packs the whole scene into a handful of typed arrays for a
 * single VBO/IBO — one draw call for the entire layer set, however many thousands of layers.
 */
export function buildSceneGeometry(layers: Layer[]): SceneGeometry {
  const positions: number[] = [];
  const layerIndices: number[] = [];
  const indices: number[] = [];
  const outlinePositions: number[] = [];
  const outlineOther: number[] = [];
  const outlineSide: number[] = [];
  const outlineLayerIndices: number[] = [];
  const layerBounds: number[] = [];

  for (let i = 0; i < layers.length; i++) {
    const { triangulation, contours } = buildLayerGeometryCached(layers[i]);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      for (const [x, y] of contour) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    layerBounds.push(minX > maxX ? 0 : minX, minY > maxY ? 0 : minY, minX > maxX ? 0 : maxX, minY > maxY ? 0 : maxY);

    if (triangulation.positions.length > 0) {
      const base = positions.length / 2;
      for (const t of triangulation.indices) indices.push(base + t);
      for (let v = 0; v < triangulation.positions.length; v += 2) {
        positions.push(triangulation.positions[v], triangulation.positions[v + 1]);
        layerIndices.push(i);
      }
    }

    for (const contour of contours) {
      const n = contour.length;
      if (n < 2) continue;
      for (let j = 0; j < n; j++) {
        const [ax, ay] = contour[j];
        const [bx, by] = contour[(j + 1) % n];
        // Two triangles (a+n, a-n, b-n) and (a+n, b-n, b+n) forming the segment's thick-line quad
        // — see the outline vertex shader in CanvasGL.tsx for how side/other resolve to a normal.
        const verts: Array<[number, number, number, number, number]> = [
          [ax, ay, bx, by, 1],
          [ax, ay, bx, by, -1],
          [bx, by, ax, ay, 1],
          [ax, ay, bx, by, 1],
          [bx, by, ax, ay, 1],
          [bx, by, ax, ay, -1],
        ];
        for (const [px, py, ox, oy, side] of verts) {
          outlinePositions.push(px, py);
          outlineOther.push(ox, oy);
          outlineSide.push(side);
          outlineLayerIndices.push(i);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    layerIndices: new Float32Array(layerIndices),
    indices: new Uint32Array(indices),
    layerCount: layers.length,
    outlinePositions: new Float32Array(outlinePositions),
    outlineOther: new Float32Array(outlineOther),
    outlineSide: new Float32Array(outlineSide),
    outlineLayerIndices: new Float32Array(outlineLayerIndices),
    layerBounds: new Float32Array(layerBounds),
  };
}

/** RGBA8 palette texel for one layer: RGB = fill color, A = visible (255) / hidden (0). */
export function buildPaletteTexel(layer: Layer): Uint8Array {
  const [r, g, b] = parseCssColor(layer.fill);
  return new Uint8Array([r, g, b, isLayerVisible(layer) ? 255 : 0]);
}

/** RGBA8 palette texture data, one texel per layer — see buildPaletteTexel. */
export function buildPalette(layers: Layer[]): Uint8Array {
  const palette = new Uint8Array(Math.max(1, layers.length) * 4);
  for (let i = 0; i < layers.length; i++) {
    palette.set(buildPaletteTexel(layers[i]), i * 4);
  }
  return palette;
}

/** Normalizes any CSS color string (hex, named, rgb(), ...) to `#rrggbb`, for the native color-input UI. */
export function normalizeColorToHex(color: string): string {
  const [r, g, b] = parseCssColor(color);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * The two RGBA32F texels (a,b,c,d) and (e,f,0,0) encoding a layer's editable transform matrix —
 * see CanvasGL.tsx's per-layer transform textures, sampled per-vertex to move/scale/rotate a
 * layer without re-triangulating its path.
 */
export function buildTransformTexel(layer: Layer): { ab: Float32Array; ef: Float32Array } {
  const [a, b, c, d, e, f] = layer.transform;
  return { ab: new Float32Array([a, b, c, d]), ef: new Float32Array([e, f, 0, 0]) };
}

/** Flat (one texel per layer, pre-grid-layout) transform texture data for a full re-upload — see buildTransformTexel. */
export function buildTransformArrays(layers: Layer[]): { ab: Float32Array; ef: Float32Array } {
  const count = Math.max(1, layers.length);
  const ab = new Float32Array(count * 4);
  const ef = new Float32Array(count * 4);
  for (let i = 0; i < layers.length; i++) {
    const texel = buildTransformTexel(layers[i]);
    ab.set(texel.ab, i * 4);
    ef.set(texel.ef, i * 4);
  }
  return { ab, ef };
}

/** Flat (one texel per layer) R8 selection mask: 255 where the layer id is in `selectedIds`, else 0. */
export function buildSelectionArray(layers: Layer[], selectedIds: ReadonlySet<string>): Uint8Array {
  const selection = new Uint8Array(Math.max(1, layers.length));
  for (let i = 0; i < layers.length; i++) {
    selection[i] = selectedIds.has(layers[i].id) ? 255 : 0;
  }
  return selection;
}
