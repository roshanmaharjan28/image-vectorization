import type { Layer } from '../types';
import { buildLayerGeometry } from './triangulateLayer';

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

  for (let i = 0; i < layers.length; i++) {
    const { triangulation, contours } = buildLayerGeometry(layers[i].attrs.d, layers[i].attrs.transform);
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
