import type { Layer, SvgMeta } from '../types';
import { applyTransform } from './svgTransform';
import type { ViewTransform } from './canvasGLEngine';

export type { ViewTransform };

/** SVG's default "xMidYMid meet" fit: uniform-scale the viewBox into the width/height box, centered. */
export function computeViewTransform(meta: SvgMeta): ViewTransform {
  const width = parseFloat(meta.width) || 1;
  const height = parseFloat(meta.height) || 1;
  const parts = (meta.viewBox || `0 0 ${width} ${height}`).trim().split(/[\s,]+/).map(Number);
  const [vbMinX, vbMinY, vbW, vbH] = [parts[0] || 0, parts[1] || 0, parts[2] || width, parts[3] || height];
  const scale = Math.min(width / vbW, height / vbH) || 1;
  return {
    width,
    height,
    vbMinX,
    vbMinY,
    scale,
    offsetX: (width - vbW * scale) / 2,
    offsetY: (height - vbH * scale) / 2,
  };
}

/** Inverse of computeViewTransform's mapping: a client (pointer) position -> viewBox/world coordinates. */
export function clientToWorld(canvas: HTMLCanvasElement, view: ViewTransform, clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const fracX = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
  const fracY = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
  const pageX = fracX * view.width;
  const pageY = fracY * view.height;
  return [(pageX - view.offsetX) / view.scale + view.vbMinX, (pageY - view.offsetY) / view.scale + view.vbMinY];
}

export interface GizmoState {
  /** The 4 box corners (TL, TR, BR, BL) driving both handle placement and scale/rotate math —
   *  the layer's own (possibly rotated) corners for a single selection, or the axis-aligned union
   *  of every selected layer's corners for a group selection. */
  worldCorners: [number, number][];
  pageCorners: [number, number][];
  center: [number, number]; // world space, rotate pivot
  rotateOriginPage: [number, number]; // top-edge midpoint, page space
  rotateDirPage: [number, number]; // unit vector pointing "up" from the box, page space
}

/**
 * Resize-cursor for a gizmo corner handle, based on that corner's actual on-screen direction from
 * the box center rather than its fixed TL/TR/BR/BL identity — a rotated box (single-layer
 * selection can carry a rotate transform) rotates which cursor belongs on which corner right
 * along with it, same as Figma/Illustrator.
 */
export function cornerResizeCursor(gizmo: GizmoState, index: number): string {
  const corner = gizmo.pageCorners[index];
  const opposite = gizmo.pageCorners[(index + 2) % 4];
  const cx = (corner[0] + opposite[0]) / 2;
  const cy = (corner[1] + opposite[1]) / 2;
  const angle = (((Math.atan2(corner[1] - cy, corner[0] - cx) * 180) / Math.PI) % 180 + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  if (angle < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

const ROTATE_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'>" +
  "<path d='M10 3a7 7 0 1 0 6.32 4' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round'/>" +
  "<path d='M10 3a7 7 0 1 0 6.32 4' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round'/>" +
  "<path d='M16.8 3.2 17.3 7.3 13.4 5.9Z' fill='black' stroke='white' stroke-width='0.6'/>" +
  '</svg>';

/** Custom circular-arrow cursor for the gizmo's rotate handle, both at rest and pinned for the
 *  whole duration of a rotate drag (see handleGizmoHandleMouseDown in useCanvasInteractions). */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_CURSOR_SVG)}") 10 10, grab`;

/**
 * Derives the gizmo's box + handle positions from the current selection's world-space bounds
 * (sceneGeometry.layerBounds, transformed by each layer's current `transform`) — pure geometry,
 * no GL or React involved.
 */
export function computeGizmoState(
  view: ViewTransform | null,
  selectedLayerIds: string[],
  layers: Layer[],
  layerIndexMap: Map<string, number>,
  layerBounds: Float32Array,
): GizmoState | null {
  if (!view || selectedLayerIds.length === 0) return null;

  const perLayerWorldCorners: [number, number][][] = [];
  for (const id of selectedLayerIds) {
    const idx = layerIndexMap.get(id);
    const layer = idx !== undefined ? layers[idx] : undefined;
    if (!layer || idx === undefined || idx * 4 + 3 >= layerBounds.length) continue;
    const minX = layerBounds[idx * 4];
    const minY = layerBounds[idx * 4 + 1];
    const maxX = layerBounds[idx * 4 + 2];
    const maxY = layerBounds[idx * 4 + 3];
    const base: [number, number][] = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
    perLayerWorldCorners.push(base.map(([x, y]) => applyTransform(layer.transform, x, y)));
  }
  if (perLayerWorldCorners.length === 0) return null;

  let worldCorners: [number, number][];
  if (perLayerWorldCorners.length === 1) {
    worldCorners = perLayerWorldCorners[0];
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corners of perLayerWorldCorners) {
      for (const [x, y] of corners) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    worldCorners = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
  }

  const toPage = (x: number, y: number): [number, number] => [
    (x - view.vbMinX) * view.scale + view.offsetX,
    (y - view.vbMinY) * view.scale + view.offsetY,
  ];
  const pageCorners = worldCorners.map(([x, y]) => toPage(x, y));
  const center: [number, number] = [
    (worldCorners[0][0] + worldCorners[2][0]) / 2,
    (worldCorners[0][1] + worldCorners[2][1]) / 2,
  ];
  const topMidPage = toPage((worldCorners[0][0] + worldCorners[1][0]) / 2, (worldCorners[0][1] + worldCorners[1][1]) / 2);
  const centerPage = toPage(center[0], center[1]);
  let dirX = topMidPage[0] - centerPage[0];
  let dirY = topMidPage[1] - centerPage[1];
  const len = Math.hypot(dirX, dirY) || 1;
  dirX /= len;
  dirY /= len;

  return {
    worldCorners,
    pageCorners,
    center,
    rotateOriginPage: topMidPage,
    rotateDirPage: [dirX, dirY],
  };
}
