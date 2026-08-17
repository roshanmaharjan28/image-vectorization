import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import type { Layer, SvgMeta } from '../types';
import {
  buildPalette,
  buildPaletteTexel,
  buildSceneGeometry,
  buildSelectionArray,
  buildTransformArrays,
  buildTransformTexel,
  type SceneGeometry,
} from '../lib/sceneBuilder';
import { createProgram, createShader, requireUniformLocation } from '../lib/glUtils';
import {
  applyTransform,
  rotateAroundPivot,
  scaleAroundPivot,
  type Mat2x3,
} from '../lib/svgTransform';

interface Props {
  imageUrl: string | null;
  meta: SvgMeta | null;
  layers: Layer[];
  hoveredLayerId: string | null;
  onHoverLayer: (id: string | null) => void;
  selectedLayerIds: string[];
  // 'replace' swaps the whole selection, 'add' unions ids in (shift-range in the layers panel),
  // 'toggle' xors each id (ctrl/shift-click, on canvas or in the panel).
  onSelectLayer: (ids: string[], mode: 'replace' | 'add' | 'toggle') => void;
  // Called with a full replacement `layers` array whenever the on-canvas gizmo moves/scales/
  // rotates the current selection — a plain `setLayers`, same shape as any other layer edit.
  onTransformLayers: (next: Layer[]) => void;
  // Adobe Image Trace-style "Preview" checkbox: overlays the original source bitmap on top of
  // the traced result instead of replacing it, so the GL canvas (and its context/geometry) stays
  // mounted and toggling back is instant.
  showOriginal: boolean;
  // Adobe Illustrator "Outline" view: renders every path as a black stroke on a white page
  // instead of its fill color — see renderScene/renderPathsBackground below.
  showPaths: boolean;
}

// Capped at 2x — sharp enough on retina without paying for absurd backing-store sizes on 3x/4x
// panels, since (unlike the SVG version) this canvas rasterizes once and CSS just scales the
// resulting bitmap for pan/zoom instead of re-rendering vectors at every zoom level.
const DPR = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

const HIGHLIGHT_RGB = [0.302, 0.671, 0.973]; // #4dabf7, same accent as Canvas.tsx's hover/select stroke
const PATHS_OUTLINE_RGB = [0, 0, 0]; // black, for the Illustrator-style "show paths" outline view

// Gizmo handle sizing, in constant screen pixels (divided by the current CSS zoom `scale` at
// render time so handles don't visually balloon/shrink as the user zooms — same trick as
// OUTLINE_WIDTH_CSS_PX below).
const HANDLE_RADIUS_PX = 5;
const ROTATE_HANDLE_OFFSET_PX = 22;

// Shared between the display and pick programs so a single VAO's attribute bindings (explicit
// `layout(location=...)`) are valid for both, regardless of link order.
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_layerIndex;
uniform vec2 u_vbMin;
uniform float u_meetScale;
uniform vec2 u_meetOffset;
uniform vec2 u_contentSize;
uniform sampler2D u_transformAB;
uniform sampler2D u_transformEF;
uniform int u_paletteWidth;
flat out int v_layerIndex;
void main() {
  int layerIndex = int(a_layerIndex + 0.5);
  ivec2 texCoord = ivec2(layerIndex % u_paletteWidth, layerIndex / u_paletteWidth);
  vec4 ab = texelFetch(u_transformAB, texCoord, 0);
  vec4 ef = texelFetch(u_transformEF, texCoord, 0);
  vec2 world = mat2(ab.x, ab.y, ab.z, ab.w) * a_position + ef.xy;
  vec2 p = (world - u_vbMin) * u_meetScale + u_meetOffset;
  vec2 clip = vec2(p.x / u_contentSize.x * 2.0 - 1.0, 1.0 - p.y / u_contentSize.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_layerIndex = layerIndex;
}`;

// Samples fill color + visibility from a 1-texel-per-layer palette texture (so toggling one
// layer's visibility is an O(1) texSubImage2D, not a rebuild). Hover/select no longer tints the
// fill here — see OUTLINE_FRAGMENT_SHADER, which draws just the edge, matching Canvas.tsx's CSS
// stroke highlight instead of tinting the whole shape.
const DISPLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in int v_layerIndex;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
out vec4 outColor;
void main() {
  vec4 c = texelFetch(u_palette, ivec2(v_layerIndex % u_paletteWidth, v_layerIndex / u_paletteWidth), 0);
  if (c.a < 0.5) discard;
  outColor = vec4(c.rgb, 1.0);
}`;

// Extrudes each outline segment into a constant-screen-pixel-width quad (a_side is -1/+1, a_other
// is the segment's opposite endpoint) — the WebGL analogue of Canvas.tsx's
// `vector-effect:non-scaling-stroke`, since gl.lineWidth is clamped to 1px on most GPUs/browsers.
const OUTLINE_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_other;
layout(location = 2) in float a_side;
layout(location = 3) in float a_layerIndex;
uniform vec2 u_vbMin;
uniform float u_meetScale;
uniform vec2 u_meetOffset;
uniform vec2 u_contentSize;
uniform vec2 u_viewportPx;
uniform float u_lineWidthPx;
uniform sampler2D u_transformAB;
uniform sampler2D u_transformEF;
uniform int u_paletteWidth;
flat out int v_layerIndex;
vec2 toClip(vec2 world) {
  vec2 p = (world - u_vbMin) * u_meetScale + u_meetOffset;
  return vec2(p.x / u_contentSize.x * 2.0 - 1.0, 1.0 - p.y / u_contentSize.y * 2.0);
}
void main() {
  int layerIndex = int(a_layerIndex + 0.5);
  ivec2 texCoord = ivec2(layerIndex % u_paletteWidth, layerIndex / u_paletteWidth);
  vec4 ab = texelFetch(u_transformAB, texCoord, 0);
  vec4 ef = texelFetch(u_transformEF, texCoord, 0);
  mat2 m = mat2(ab.x, ab.y, ab.z, ab.w);
  vec2 clipHere = toClip(m * a_position + ef.xy);
  vec2 clipOther = toClip(m * a_other + ef.xy);
  vec2 dir = normalize(clipOther - clipHere);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 offset = normal * (a_side * u_lineWidthPx * 0.5) * (2.0 / u_viewportPx);
  gl_Position = vec4(clipHere + offset, 0.0, 1.0);
  v_layerIndex = layerIndex;
}`;

// Only lets fragments belonging to the hovered layer or a selected layer through. Selection is a
// per-layer texture (0/1 per layer, see buildSelectionArray) rather than a single index, so any
// number of layers can be highlighted at once for group selection — same discard-by-lookup trick
// as the pick shader, but for drawing rather than reading back.
const OUTLINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in int v_layerIndex;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
uniform int u_hoverIndex;
uniform sampler2D u_selection;
uniform int u_highlightAll;
uniform vec3 u_outlineColor;
out vec4 outColor;
void main() {
  ivec2 coord = ivec2(v_layerIndex % u_paletteWidth, v_layerIndex / u_paletteWidth);
  float selected = texelFetch(u_selection, coord, 0).r;
  if (u_highlightAll == 0 && v_layerIndex != u_hoverIndex && selected < 0.5) discard;
  vec4 c = texelFetch(u_palette, coord, 0);
  if (c.a < 0.5) discard;
  outColor = vec4(u_outlineColor, 1.0);
}`;

// Thinner than Canvas.tsx's `stroke-width:3` CSS px — a hairline reads clearer against the fill
// than a thick one. Converted to backing-store pixels via the current resolutionScale (see
// resolutionScaleFor) wherever it's used, not a fixed constant, since the backing-store
// resolution itself now tracks zoom (see resolutionScaleFor below).
const OUTLINE_WIDTH_CSS_PX = 1.25;

// The canvas rasterizes once and CSS `transform: scale()` handles pan/zoom (see the class comment
// on CanvasGL) — but a backing store fixed at DPR goes soft the moment CSS stretches it past 1x
// zoom, for both the fill and the hover/select outline. Raising the backing-store resolution to
// track the current zoom keeps the raster sharp, same as an SVG re-rasterizing at its displayed
// size. Capped at 4x on top of DPR so extreme zoom can't allocate an unbounded GPU texture.
const MAX_ZOOM_RESOLUTION = 4;

function resolutionScaleFor(zoom: number) {
  return DPR * Math.min(Math.max(zoom, 1), MAX_ZOOM_RESOLUTION);
}

// Encodes (layerIndex + 1) into RGB8 so a single-pixel readback resolves hover/click hit-testing
// in O(1) regardless of layer count — the GL analogue of Canvas.tsx's data-layer-id lookup.
const PICK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in int v_layerIndex;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
out vec4 outColor;
void main() {
  vec4 c = texelFetch(u_palette, ivec2(v_layerIndex % u_paletteWidth, v_layerIndex / u_paletteWidth), 0);
  if (c.a < 0.5) discard;
  int id = v_layerIndex + 1;
  outColor = vec4(
    float(id & 255) / 255.0,
    float((id >> 8) & 255) / 255.0,
    float((id >> 16) & 255) / 255.0,
    1.0
  );
}`;

interface TransformUniforms {
  vbMin: WebGLUniformLocation;
  meetScale: WebGLUniformLocation;
  meetOffset: WebGLUniformLocation;
  contentSize: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  paletteWidth: WebGLUniformLocation;
  transformAB: WebGLUniformLocation;
  transformEF: WebGLUniformLocation;
}

interface GLState {
  gl: WebGL2RenderingContext;
  displayProgram: WebGLProgram;
  pickProgram: WebGLProgram;
  outlineProgram: WebGLProgram;
  vao: WebGLVertexArrayObject;
  positionBuffer: WebGLBuffer;
  layerIndexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  outlineVao: WebGLVertexArrayObject;
  outlinePositionBuffer: WebGLBuffer;
  outlineOtherBuffer: WebGLBuffer;
  outlineSideBuffer: WebGLBuffer;
  outlineLayerIndexBuffer: WebGLBuffer;
  outlineVertexCount: number;
  paletteTexture: WebGLTexture;
  // (a,b,c,d) / (e,f,0,0) per-layer edit-transform matrices, sampled by the vertex shaders so a
  // move/scale/rotate is an O(1) texel write instead of a re-triangulation — see types.ts's
  // Layer.transform and svgTransform.ts's Mat2x3.
  transformABTexture: WebGLTexture;
  transformEFTexture: WebGLTexture;
  // 0/1 per-layer selection mask sampled by the outline fragment shader, so any number of layers
  // can be highlighted at once (group selection) without a per-layer draw call.
  selectionTexture: WebGLTexture;
  paletteWidth: number;
  maxTextureSize: number;
  pickFbo: WebGLFramebuffer;
  pickTexture: WebGLTexture;
  pickWidth: number;
  pickHeight: number;
  displayUniforms: TransformUniforms;
  pickUniforms: TransformUniforms;
  outlineUniforms: TransformUniforms & {
    viewportPx: WebGLUniformLocation;
    lineWidthPx: WebGLUniformLocation;
    hoverIndex: WebGLUniformLocation;
    selection: WebGLUniformLocation;
    highlightAll: WebGLUniformLocation;
    outlineColor: WebGLUniformLocation;
  };
}

interface ViewTransform {
  width: number;
  height: number;
  vbMinX: number;
  vbMinY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** SVG's default "xMidYMid meet" fit: uniform-scale the viewBox into the width/height box, centered. */
function computeViewTransform(meta: SvgMeta): ViewTransform {
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

/**
 * Resize-cursor for a gizmo corner handle, based on that corner's actual on-screen direction from
 * the box center rather than its fixed TL/TR/BR/BL identity — a rotated box (single-layer
 * selection can carry a rotate transform, see GizmoState) rotates which cursor belongs on which
 * corner right along with it, same as Figma/Illustrator.
 */
function cornerResizeCursor(gizmo: GizmoState, index: number): string {
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

/** Inverse of computeViewTransform's mapping: a client (pointer) position -> viewBox/world coordinates. */
function clientToWorld(canvas: HTMLCanvasElement, view: ViewTransform, clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const fracX = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
  const fracY = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
  const pageX = fracX * view.width;
  const pageY = fracY * view.height;
  return [(pageX - view.offsetX) / view.scale + view.vbMinX, (pageY - view.offsetY) / view.scale + view.vbMinY];
}

function initGL(canvas: HTMLCanvasElement): GLState | null {
  // alpha:true (the default) so hidden layers and any uncovered canvas area stay transparent —
  // matching Canvas.tsx, where the checkered page pattern shows through unpainted SVG regions —
  // instead of compositing as opaque black.
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) return null;

  const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const displayProgram = createProgram(gl, vs, createShader(gl, gl.FRAGMENT_SHADER, DISPLAY_FRAGMENT_SHADER));
  const pickProgram = createProgram(gl, vs, createShader(gl, gl.FRAGMENT_SHADER, PICK_FRAGMENT_SHADER));
  const outlineProgram = createProgram(
    gl,
    createShader(gl, gl.VERTEX_SHADER, OUTLINE_VERTEX_SHADER),
    createShader(gl, gl.FRAGMENT_SHADER, OUTLINE_FRAGMENT_SHADER),
  );

  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const layerIndexBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (!vao || !positionBuffer || !layerIndexBuffer || !indexBuffer) return null;

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, layerIndexBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bindVertexArray(null);

  const outlineVao = gl.createVertexArray();
  const outlinePositionBuffer = gl.createBuffer();
  const outlineOtherBuffer = gl.createBuffer();
  const outlineSideBuffer = gl.createBuffer();
  const outlineLayerIndexBuffer = gl.createBuffer();
  if (!outlineVao || !outlinePositionBuffer || !outlineOtherBuffer || !outlineSideBuffer || !outlineLayerIndexBuffer) {
    return null;
  }

  gl.bindVertexArray(outlineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlinePositionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlineOtherBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlineSideBuffer);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlineLayerIndexBuffer);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const paletteTexture = gl.createTexture();
  if (!paletteTexture) return null;
  gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const transformABTexture = gl.createTexture();
  const transformEFTexture = gl.createTexture();
  const selectionTexture = gl.createTexture();
  if (!transformABTexture || !transformEFTexture || !selectionTexture) return null;
  for (const tex of [transformABTexture, transformEFTexture, selectionTexture]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  const pickTexture = gl.createTexture();
  const pickFbo = gl.createFramebuffer();
  if (!pickTexture || !pickFbo) return null;
  gl.bindTexture(gl.TEXTURE_2D, pickTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTexture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return {
    gl,
    displayProgram,
    pickProgram,
    outlineProgram,
    vao,
    positionBuffer,
    layerIndexBuffer,
    indexBuffer,
    indexCount: 0,
    outlineVao,
    outlinePositionBuffer,
    outlineOtherBuffer,
    outlineSideBuffer,
    outlineLayerIndexBuffer,
    outlineVertexCount: 0,
    paletteTexture,
    transformABTexture,
    transformEFTexture,
    selectionTexture,
    paletteWidth: 0,
    // 2D textures are capped at this size on both axes — a one-row-per-layer palette silently
    // fails to allocate (and samples as opaque black) once layerCount exceeds it on this GPU.
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    pickFbo,
    pickTexture,
    pickWidth: 0,
    pickHeight: 0,
    displayUniforms: transformUniforms(gl, displayProgram),
    pickUniforms: transformUniforms(gl, pickProgram),
    outlineUniforms: {
      ...transformUniforms(gl, outlineProgram),
      viewportPx: requireUniformLocation(gl, outlineProgram, 'u_viewportPx'),
      lineWidthPx: requireUniformLocation(gl, outlineProgram, 'u_lineWidthPx'),
      hoverIndex: requireUniformLocation(gl, outlineProgram, 'u_hoverIndex'),
      selection: requireUniformLocation(gl, outlineProgram, 'u_selection'),
      highlightAll: requireUniformLocation(gl, outlineProgram, 'u_highlightAll'),
      outlineColor: requireUniformLocation(gl, outlineProgram, 'u_outlineColor'),
    },
  };
}

function transformUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): TransformUniforms {
  return {
    vbMin: requireUniformLocation(gl, program, 'u_vbMin'),
    meetScale: requireUniformLocation(gl, program, 'u_meetScale'),
    meetOffset: requireUniformLocation(gl, program, 'u_meetOffset'),
    contentSize: requireUniformLocation(gl, program, 'u_contentSize'),
    palette: requireUniformLocation(gl, program, 'u_palette'),
    paletteWidth: requireUniformLocation(gl, program, 'u_paletteWidth'),
    transformAB: requireUniformLocation(gl, program, 'u_transformAB'),
    transformEF: requireUniformLocation(gl, program, 'u_transformEF'),
  };
}

function uploadGeometry(state: GLState, geometry: SceneGeometry) {
  const { gl } = state;
  gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.layerIndexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.layerIndices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  state.indexCount = geometry.indices.length;

  gl.bindBuffer(gl.ARRAY_BUFFER, state.outlinePositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.outlinePositions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.outlineOtherBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.outlineOther, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.outlineSideBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.outlineSide, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.outlineLayerIndexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.outlineLayerIndices, gl.STATIC_DRAW);
  state.outlineVertexCount = geometry.outlinePositions.length / 2;
}

// Shared by the palette, transform, and selection textures so a given layer index always resolves
// to the same texel coordinate in all of them — see PICK_FRAGMENT_SHADER et al.'s
// `ivec2(i % width, i / width)` addressing.
function computeGridSize(count: number, maxTextureSize: number): { width: number; height: number } {
  const c = Math.max(1, count);
  const width = Math.min(c, maxTextureSize);
  const height = Math.ceil(c / width);
  return { width, height };
}

function padToLength(data: Float32Array, length: number): Float32Array {
  if (data.length === length) return data;
  const out = new Float32Array(length);
  out.set(data);
  return out;
}

function padUint8ToLength(data: Uint8Array, length: number): Uint8Array {
  if (data.length === length) return data;
  const out = new Uint8Array(length);
  out.set(data);
  return out;
}

// Laid out as a width-capped 2D grid (row-major by layer index), not a single layerCount-wide
// row — a 1-row texture silently fails to allocate once layerCount exceeds this GPU's
// MAX_TEXTURE_SIZE, and an incomplete texture samples as opaque black (the bug this avoids).
function uploadPalette(state: GLState, palette: Uint8Array, layerCount: number) {
  const { gl } = state;
  const { width, height } = computeGridSize(layerCount, state.maxTextureSize);
  const data = padUint8ToLength(palette, width * height * 4);
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  state.paletteWidth = width;
}

/** Full rebuild of the per-layer edit-transform textures — see buildTransformArrays. */
function uploadTransformTextures(state: GLState, layers: Layer[]) {
  const { gl } = state;
  const { width, height } = computeGridSize(layers.length, state.maxTextureSize);
  const { ab, ef } = buildTransformArrays(layers);
  gl.bindTexture(gl.TEXTURE_2D, state.transformABTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padToLength(ab, width * height * 4));
  gl.bindTexture(gl.TEXTURE_2D, state.transformEFTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padToLength(ef, width * height * 4));
}

/** Full rebuild of the group-selection mask texture — cheap even for tens of thousands of layers. */
function uploadSelection(state: GLState, layers: Layer[], selectedIds: ReadonlySet<string>) {
  const { gl } = state;
  const { width, height } = computeGridSize(layers.length, state.maxTextureSize);
  const selection = buildSelectionArray(layers, selectedIds);
  gl.bindTexture(gl.TEXTURE_2D, state.selectionTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, padUint8ToLength(selection, width * height));
}

function resizeCanvasAndPickBuffer(
  state: GLState,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  resolutionScale: number,
) {
  const { gl } = state;
  // Clamped to maxTextureSize since the pick texture attached below is a real GL texture (unlike
  // the default drawing buffer) and silently fails to allocate past that size on this GPU.
  const width = Math.min(state.maxTextureSize, Math.max(1, Math.round(cssWidth * resolutionScale)));
  const height = Math.min(state.maxTextureSize, Math.max(1, Math.round(cssHeight * resolutionScale)));
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  gl.bindTexture(gl.TEXTURE_2D, state.pickTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  state.pickWidth = width;
  state.pickHeight = height;
}

function setTransformUniforms(gl: WebGL2RenderingContext, u: TransformUniforms, view: ViewTransform, paletteWidth: number) {
  gl.uniform2f(u.vbMin, view.vbMinX, view.vbMinY);
  gl.uniform1f(u.meetScale, view.scale);
  gl.uniform2f(u.meetOffset, view.offsetX, view.offsetY);
  gl.uniform2f(u.contentSize, view.width, view.height);
  gl.uniform1i(u.palette, 0);
  gl.uniform1i(u.paletteWidth, paletteWidth);
  gl.uniform1i(u.transformAB, 1);
  gl.uniform1i(u.transformEF, 2);
}

/** Binds the palette + per-layer transform textures to units 0/1/2 — every draw call needs all three. */
function bindPerLayerTextures(gl: WebGL2RenderingContext, state: GLState) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, state.transformABTexture);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, state.transformEFTexture);
}

function renderDisplay(state: GLState, view: ViewTransform) {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (state.indexCount === 0) return;

  gl.useProgram(state.displayProgram);
  setTransformUniforms(gl, state.displayUniforms, view, state.paletteWidth);
  bindPerLayerTextures(gl, state);
  gl.bindVertexArray(state.vao);
  gl.drawElements(gl.TRIANGLES, state.indexCount, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
}

// Draws only the hovered/selected layers' edges on top of the already-rendered fill — call this
// right after renderDisplay, into the same default framebuffer, so it composites over the fill.
// When highlightAll is set, every layer's edge is drawn instead (used right after a fresh
// vectorize, before the user has clicked anything, and for the "show paths" outline view).
function renderOutline(
  state: GLState,
  view: ViewTransform,
  hoverIndex: number,
  hasSelection: boolean,
  highlightAll: boolean,
  color: number[],
  lineWidthPx: number,
) {
  const { gl } = state;
  if (state.outlineVertexCount === 0 || (!highlightAll && hoverIndex < 0 && !hasSelection)) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.useProgram(state.outlineProgram);
  setTransformUniforms(gl, state.outlineUniforms, view, state.paletteWidth);
  gl.uniform2f(state.outlineUniforms.viewportPx, gl.canvas.width, gl.canvas.height);
  gl.uniform1f(state.outlineUniforms.lineWidthPx, lineWidthPx);
  gl.uniform1i(state.outlineUniforms.hoverIndex, hoverIndex);
  gl.uniform1i(state.outlineUniforms.highlightAll, highlightAll ? 1 : 0);
  gl.uniform3f(state.outlineUniforms.outlineColor, color[0], color[1], color[2]);
  bindPerLayerTextures(gl, state);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, state.selectionTexture);
  gl.uniform1i(state.outlineUniforms.selection, 3);
  gl.bindVertexArray(state.outlineVao);
  gl.drawArrays(gl.TRIANGLES, 0, state.outlineVertexCount);
  gl.bindVertexArray(null);
}

// Clears the canvas to an opaque white page instead of drawing the fill pass — the backdrop for
// the "show paths" outline view, where only edges (drawn separately, in black) should be visible.
function renderPathsBackground(state: GLState) {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.clearColor(1, 1, 1, 1);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

// Picks between the normal colored-fill view and the black-on-white outline view, and layers a
// blue hover/select highlight on top either way.
function renderScene(
  state: GLState,
  view: ViewTransform,
  hoverIndex: number,
  hasSelection: boolean,
  highlightAll: boolean,
  showPaths: boolean,
  lineWidthPx: number,
) {
  if (showPaths) {
    renderPathsBackground(state);
    renderOutline(state, view, -1, false, true, PATHS_OUTLINE_RGB, lineWidthPx);
    if (hoverIndex >= 0 || hasSelection) {
      renderOutline(state, view, hoverIndex, hasSelection, false, HIGHLIGHT_RGB, lineWidthPx);
    }
  } else {
    renderDisplay(state, view);
    renderOutline(state, view, hoverIndex, hasSelection, highlightAll, HIGHLIGHT_RGB, lineWidthPx);
  }
}

function renderPick(state: GLState, view: ViewTransform) {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.pickFbo);
  gl.viewport(0, 0, state.pickWidth, state.pickHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (state.indexCount > 0) {
    gl.useProgram(state.pickProgram);
    setTransformUniforms(gl, state.pickUniforms, view, state.paletteWidth);
    bindPerLayerTextures(gl, state);
    gl.bindVertexArray(state.vao);
    gl.drawElements(gl.TRIANGLES, state.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function pickAt(state: GLState, canvas: HTMLCanvasElement, clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return -1;
  const fracX = (clientX - rect.left) / rect.width;
  const fracY = (clientY - rect.top) / rect.height;
  if (fracX < 0 || fracX > 1 || fracY < 0 || fracY > 1) return -1;

  const px = Math.min(state.pickWidth - 1, Math.max(0, Math.floor(fracX * state.pickWidth)));
  const py = Math.min(state.pickHeight - 1, Math.max(0, Math.floor((1 - fracY) * state.pickHeight)));

  const { gl } = state;
  const buf = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.pickFbo);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const id = buf[0] | (buf[1] << 8) | (buf[2] << 16);
  return id === 0 ? -1 : id - 1;
}

type DragMode = 'pan' | 'move' | 'scale' | 'rotate';

interface DragInfo {
  /** Snapshot of every dragged layer's transform at mousedown — every frame recomputes from this,
   *  not from the previous frame's output, so releasing without net movement is a true no-op and
   *  there's no per-frame drift. Doubles as the "which layers does this drag affect" set. */
  initialTransforms: Map<string, Mat2x3>;
  startWorld: [number, number];
  /** World-space pivot: the opposite corner for a scale drag, the box center for a rotate drag. */
  pivot: [number, number];
  startCorner?: [number, number]; // scale only
  startAngle?: number; // rotate only
}

interface GizmoState {
  /** The 4 box corners (TL, TR, BR, BL) driving both handle placement and scale/rotate math —
   *  the layer's own (possibly rotated) corners for a single selection, or the axis-aligned union
   *  of every selected layer's corners for a group selection (see CanvasGL's plan doc). */
  worldCorners: [number, number][];
  pageCorners: [number, number][];
  center: [number, number]; // world space, rotate pivot
  rotateOriginPage: [number, number]; // top-edge midpoint, page space
  rotateDirPage: [number, number]; // unit vector pointing "up" from the box, page space
}

/**
 * Experimental WebGL2 twin of Canvas.tsx: triangulates every layer's path once per vectorize into
 * a single VBO/IBO (one draw call for the whole scene, whatever the layer count), looks up fill
 * color from a 1-texel-per-layer palette texture (so a visibility toggle is an O(1)
 * texSubImage2D), and resolves hover/click via a GPU color-id pick buffer instead of DOM events —
 * see pickAt above. Pan/zoom stays a CSS transform on the same .canvas__artboard wrapper Canvas.tsx
 * uses, so panning/zooming never re-triggers a GL render at all. Move/scale/rotate edits are
 * likewise GPU-resident (see the transform textures above) rather than re-triangulating.
 */
export function CanvasGL({
  imageUrl,
  meta,
  layers,
  hoveredLayerId,
  onHoverLayer,
  selectedLayerIds,
  onSelectLayer,
  onTransformLayers,
  showOriginal,
  showPaths,
}: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [glUnsupported, setGlUnsupported] = useState(false);
  // Every edge is drawn blue right after a fresh vectorize, until the user clicks a path or
  // clicks anywhere else — mirrors a hover/select outline but for all layers at once.
  const [allHighlighted, setAllHighlighted] = useState(true);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GLState | null>(null);
  const layerIndexMapRef = useRef<Map<string, number>>(new Map());
  const layerBoundsRef = useRef<Float32Array>(new Float32Array());
  const layersBaselineRef = useRef<Layer[] | null>(null);
  const rafPickPending = useRef(false);
  // Tracks the resolutionScale currently baked into the canvas/pick-buffer backing store, so the
  // hover/select and visibility effects (which don't resize anything themselves) can compute the
  // matching outline line width without recomputing resolutionScaleFor(scale) — which could
  // otherwise briefly disagree with the buffer's actual resolution mid zoom-debounce.
  const resolutionScaleRef = useRef(DPR);

  // Gizmo drag state (move/scale/rotate), plus the existing pan drag above. A ref, not state,
  // since a drag's every-frame updates flow through `layers`/onTransformLayers (which already
  // re-renders this component) rather than a separate imperative path.
  const dragModeRef = useRef<DragMode | null>(null);
  const dragInfoRef = useRef<DragInfo | null>(null);
  const rafDragPending = useRef(false);
  // A move-drag starts from a mousedown on the canvas itself, so the browser also fires a click
  // on mouseup — suppressed once so it doesn't collapse a just-dragged group selection down to
  // whichever single shape happened to be under the pointer.
  const suppressNextClickRef = useRef(false);

  const isVectorized = meta !== null;
  const view = meta ? computeViewTransform(meta) : null;

  function handleWheel(e: WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setScale((s) => Math.min(8, Math.max(0.1, s + delta * s)));
  }

  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    dragModeRef.current = 'pan';
    dragOrigin.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }

  function applyDrag(mode: 'move' | 'scale' | 'rotate', clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const info = dragInfoRef.current;
    if (!canvas || !view || !info) return;
    const [wx, wy] = clientToWorld(canvas, view, clientX, clientY);

    let nextMatrix: (m: Mat2x3) => Mat2x3;
    if (mode === 'move') {
      const dx = wx - info.startWorld[0];
      const dy = wy - info.startWorld[1];
      nextMatrix = (m) => [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
    } else if (mode === 'scale' && info.startCorner) {
      const [px, py] = info.pivot;
      const dxs = info.startCorner[0] - px;
      const dys = info.startCorner[1] - py;
      // Floors the ratio's magnitude so dragging a corner through/past the pivot can't collapse a
      // layer to zero size or silently flip it — it just stays pinned near-flat instead.
      const ratio = (current: number, start: number) => {
        if (Math.abs(start) < 1e-6) return 1;
        const r = current / start;
        return Math.abs(r) < 0.02 ? (r < 0 ? -0.02 : 0.02) : r;
      };
      const sx = ratio(wx - px, dxs);
      const sy = ratio(wy - py, dys);
      nextMatrix = (m) => scaleAroundPivot(m, px, py, sx, sy);
    } else if (mode === 'rotate' && info.startAngle !== undefined) {
      const [px, py] = info.pivot;
      const dTheta = Math.atan2(wy - py, wx - px) - info.startAngle;
      nextMatrix = (m) => rotateAroundPivot(m, px, py, dTheta);
    } else {
      return;
    }

    const next = layers.map((layer) => {
      const initial = info.initialTransforms.get(layer.id);
      return initial ? { ...layer, transform: nextMatrix(initial) } : layer;
    });
    onTransformLayers(next);
  }

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
    const mode = dragModeRef.current;
    if (mode === 'pan') {
      if (!dragOrigin.current) return;
      setOffset({ x: e.clientX - dragOrigin.current.x, y: e.clientY - dragOrigin.current.y });
      return;
    }
    if (mode && dragInfoRef.current) {
      if (rafDragPending.current) return;
      rafDragPending.current = true;
      const { clientX, clientY } = e;
      requestAnimationFrame(() => {
        rafDragPending.current = false;
        applyDrag(mode, clientX, clientY);
      });
    }
  }

  function stopDrag() {
    if (dragModeRef.current === 'move' || dragModeRef.current === 'scale' || dragModeRef.current === 'rotate') {
      suppressNextClickRef.current = true;
    }
    dragModeRef.current = null;
    dragOrigin.current = null;
    dragInfoRef.current = null;
    document.body.style.cursor = '';
  }

  function snapshotInitialTransforms(): Map<string, Mat2x3> {
    const snapshot = new Map<string, Mat2x3>();
    for (const id of selectedLayerIds) {
      const idx = layerIndexMapRef.current.get(id);
      if (idx !== undefined && layers[idx]) snapshot.set(id, layers[idx].transform);
    }
    return snapshot;
  }

  function handleGizmoHandleMouseDown(e: MouseEvent<SVGCircleElement>, mode: 'scale' | 'rotate', cornerIndex?: number) {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || !view || !gizmo) return;
    const startWorld = clientToWorld(canvas, view, e.clientX, e.clientY);
    const initialTransforms = snapshotInitialTransforms();
    if (mode === 'scale' && cornerIndex !== undefined) {
      const oppositeIndex = (cornerIndex + 2) % 4;
      dragInfoRef.current = {
        initialTransforms,
        startWorld,
        pivot: gizmo.worldCorners[oppositeIndex],
        startCorner: gizmo.worldCorners[cornerIndex],
      };
      // Pin the resize cursor for the whole drag — otherwise the moment the pointer strays off
      // the (tiny) handle circle it falls back to whatever the ancestor's cursor is (e.g. the
      // canvas's grab/grabbing pan cursor), even mid-drag.
      document.body.style.cursor = cornerResizeCursor(gizmo, cornerIndex);
    } else {
      const pivot = gizmo.center;
      dragInfoRef.current = {
        initialTransforms,
        startWorld,
        pivot,
        startAngle: Math.atan2(startWorld[1] - pivot[1], startWorld[0] - pivot[0]),
      };
      document.body.style.cursor = 'grabbing';
    }
    dragModeRef.current = mode;
  }

  function handleCanvasMouseDown(e: MouseEvent<HTMLCanvasElement>) {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas || !view) return;
    const idx = pickAt(state, canvas, e.clientX, e.clientY);
    const id = idx >= 0 ? (layers[idx]?.id ?? null) : null;
    if (!id || !selectedLayerIds.includes(id)) return;

    e.stopPropagation();
    const startWorld = clientToWorld(canvas, view, e.clientX, e.clientY);
    dragInfoRef.current = {
      initialTransforms: snapshotInitialTransforms(),
      startWorld,
      pivot: startWorld,
    };
    dragModeRef.current = 'move';
  }

  function handleCanvasMouseMove(e: MouseEvent<HTMLCanvasElement>) {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas || rafPickPending.current) return;
    rafPickPending.current = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      rafPickPending.current = false;
      const idx = pickAt(state, canvas, clientX, clientY);
      onHoverLayer(idx >= 0 ? layers[idx]?.id ?? null : null);
    });
  }

  function handleCanvasClick(e: MouseEvent<HTMLCanvasElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    const idx = pickAt(state, canvas, e.clientX, e.clientY);
    const id = idx >= 0 ? (layers[idx]?.id ?? null) : null;
    if (!id) {
      onSelectLayer([], 'replace');
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      onSelectLayer([id], 'toggle');
    } else {
      onSelectLayer([id], 'replace');
    }
  }

  // The GL context dies with the <canvas> element whenever we switch back to the plain-<img>
  // branch (or unmount) — drop the stale handle so the next mount reinitializes from scratch.
  useEffect(() => {
    return () => {
      glStateRef.current = null;
    };
  }, [isVectorized]);

  // Any click anywhere — a path, empty canvas, or outside the canvas entirely — ends the
  // post-vectorize all-highlighted preview.
  useEffect(() => {
    function handleGlobalClick() {
      setAllHighlighted(false);
    }
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  }, []);

  // Triangulating every layer's path is only worth redoing when the layer *set* changes — a
  // fresh vectorize — not on every visibility/transform/color toggle. Mirrors Canvas.tsx's
  // pathsMarkup memo.
  const sceneGeometry = useMemo(() => buildSceneGeometry(layers), [meta]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) return;

    if (!glStateRef.current) {
      glStateRef.current = initGL(canvas);
      if (!glStateRef.current) {
        setGlUnsupported(true);
        return;
      }
    }
    const state = glStateRef.current;
    const view = computeViewTransform(meta);
    const resolutionScale = resolutionScaleFor(scale);
    resolutionScaleRef.current = resolutionScale;
    resizeCanvasAndPickBuffer(state, canvas, view.width, view.height, resolutionScale);
    uploadGeometry(state, sceneGeometry);
    uploadPalette(state, buildPalette(layers), layers.length);
    uploadTransformTextures(state, layers);
    uploadSelection(state, layers, new Set(selectedLayerIds));
    layerBoundsRef.current = sceneGeometry.layerBounds;

    const idMap = new Map<string, number>();
    layers.forEach((layer, i) => idMap.set(layer.id, i));
    layerIndexMapRef.current = idMap;
    layersBaselineRef.current = null;
    setAllHighlighted(true);

    const hoverIndex = hoveredLayerId ? idMap.get(hoveredLayerId) ?? -1 : -1;
    renderScene(state, view, hoverIndex, selectedLayerIds.length > 0, true, showPaths, OUTLINE_WIDTH_CSS_PX * resolutionScale);
    renderPick(state, view);
    // Only the fresh layer *set* (sceneGeometry) should retrigger the full GPU upload — hover/
    // select/visibility/transform are handled by the cheaper effects below, same split as
    // Canvas.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneGeometry]);

  // Visibility/color/transform diff — identical shape to Canvas.tsx's data-hidden effect, but
  // writes a single palette + transform texel via texSubImage2D instead of toggling a DOM
  // attribute (or re-triangulating).
  useEffect(() => {
    const state = glStateRef.current;
    if (!state || !meta) return;
    const baseline = layersBaselineRef.current;
    if (!baseline || baseline.length !== layers.length) {
      layersBaselineRef.current = layers;
      return;
    }

    let changed = false;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i] === baseline[i]) continue;
      changed = true;
      const { gl } = state;
      const x = i % state.paletteWidth;
      const y = Math.floor(i / state.paletteWidth);
      gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buildPaletteTexel(layers[i]));
      const { ab, ef } = buildTransformTexel(layers[i]);
      gl.bindTexture(gl.TEXTURE_2D, state.transformABTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.FLOAT, ab);
      gl.bindTexture(gl.TEXTURE_2D, state.transformEFTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.FLOAT, ef);
    }
    layersBaselineRef.current = layers;

    if (changed) {
      const view = computeViewTransform(meta);
      const hoverIndex = hoveredLayerId ? layerIndexMapRef.current.get(hoveredLayerId) ?? -1 : -1;
      renderScene(
        state,
        view,
        hoverIndex,
        selectedLayerIds.length > 0,
        allHighlighted,
        showPaths,
        OUTLINE_WIDTH_CSS_PX * resolutionScaleRef.current,
      );
      renderPick(state, view);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers]);

  // Hover/select are pure uniform + selection-texture changes — redraw the display + outline
  // passes only; the pick buffer's contents don't depend on which layer(s) are currently
  // hovered/selected.
  useEffect(() => {
    const state = glStateRef.current;
    if (!state || !meta) return;
    uploadSelection(state, layers, new Set(selectedLayerIds));
    const view = computeViewTransform(meta);
    const hoverIndex = hoveredLayerId ? layerIndexMapRef.current.get(hoveredLayerId) ?? -1 : -1;
    renderScene(
      state,
      view,
      hoverIndex,
      selectedLayerIds.length > 0,
      allHighlighted,
      showPaths,
      OUTLINE_WIDTH_CSS_PX * resolutionScaleRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredLayerId, selectedLayerIds, sceneGeometry, allHighlighted, showPaths]);

  // Re-rasterizes the canvas and pick buffer at a resolution matching the current zoom so CSS-
  // scaling the artboard (via `transform: scale()` in the JSX below) doesn't have to stretch too
  // few source pixels — without this, both the fill and the hover/select outline go soft past 1x
  // zoom, since the backing store was sized once at DPR and then just blown up visually. Debounced
  // to the trailing edge of a zoom gesture via setTimeout (not requestAnimationFrame): wheel events
  // during a real scroll/pinch gesture routinely have gaps longer than one frame, so an rAF-based
  // "cancel and reschedule" fires on almost every tick instead of just the end of the gesture —
  // reallocating the canvas + pick texture and doing a full re-render each time, which gets
  // increasingly expensive as the backing store grows toward MAX_ZOOM_RESOLUTION. A real time-based
  // debounce only does that work once the zoom gesture actually pauses.
  useEffect(() => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas || !meta) return;
    const timeoutId = setTimeout(() => {
      const resolutionScale = resolutionScaleFor(scale);
      if (Math.abs(resolutionScale - resolutionScaleRef.current) < 0.01) return;
      resolutionScaleRef.current = resolutionScale;
      const view = computeViewTransform(meta);
      resizeCanvasAndPickBuffer(state, canvas, view.width, view.height, resolutionScale);
      const hoverIndex = hoveredLayerId ? layerIndexMapRef.current.get(hoveredLayerId) ?? -1 : -1;
      renderScene(
        state,
        view,
        hoverIndex,
        selectedLayerIds.length > 0,
        allHighlighted,
        showPaths,
        OUTLINE_WIDTH_CSS_PX * resolutionScale,
      );
      renderPick(state, view);
    }, 120);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // Derives the gizmo's box + handle positions from the current selection's world-space bounds
  // (sceneGeometry.layerBounds, transformed by each layer's current `transform`) — pure JS/SVG,
  // no GL involved. Deliberately independent of `scale`/`offset` (pan/zoom): the gizmo overlay is
  // a sibling of the GL canvas inside the same CSS-scaled artboard, so it pans/zooms for free.
  const gizmo = useMemo<GizmoState | null>(() => {
    if (!view || selectedLayerIds.length === 0) return null;
    const bounds = layerBoundsRef.current;
    const perLayerWorldCorners: [number, number][][] = [];
    for (const id of selectedLayerIds) {
      const idx = layerIndexMapRef.current.get(id);
      const layer = idx !== undefined ? layers[idx] : undefined;
      if (!layer || idx === undefined || idx * 4 + 3 >= bounds.length) continue;
      const minX = bounds[idx * 4];
      const minY = bounds[idx * 4 + 1];
      const maxX = bounds[idx * 4 + 2];
      const maxY = bounds[idx * 4 + 3];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, selectedLayerIds, meta, sceneGeometry]);

  const rotateHandlePage: [number, number] | null = gizmo
    ? [
        gizmo.rotateOriginPage[0] + gizmo.rotateDirPage[0] * (ROTATE_HANDLE_OFFSET_PX / scale),
        gizmo.rotateOriginPage[1] + gizmo.rotateDirPage[1] * (ROTATE_HANDLE_OFFSET_PX / scale),
      ]
    : null;

  return (
    <div
      className="canvas"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
    >
      <div
        className="canvas__artboard"
        style={{
          transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
        }}
      >
        <div className="canvas__page">
          {isVectorized && meta ? (
            glUnsupported ? (
              <div className="canvas__surface canvas__gl-error">WebGL2 is not supported in this browser.</div>
            ) : (
              <>
                <canvas
                  ref={canvasRef}
                  className="canvas__surface"
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={() => onHoverLayer(null)}
                  onClick={handleCanvasClick}
                />
                {showOriginal && imageUrl && (
                  <img
                    src={imageUrl}
                    alt="Original artwork"
                    className="canvas__surface canvas__image canvas__bitmap-overlay"
                  />
                )}
                {gizmo && rotateHandlePage && !showOriginal && view && (
                  <svg
                    className="canvas__gizmo"
                    width={view.width}
                    height={view.height}
                    viewBox={`0 0 ${view.width} ${view.height}`}
                  >
                    <polygon
                      className="canvas__gizmo-box"
                      points={gizmo.pageCorners.map(([x, y]) => `${x},${y}`).join(' ')}
                    />
                    <line
                      className="canvas__gizmo-rotate-connector"
                      x1={gizmo.rotateOriginPage[0]}
                      y1={gizmo.rotateOriginPage[1]}
                      x2={rotateHandlePage[0]}
                      y2={rotateHandlePage[1]}
                    />
                    {gizmo.pageCorners.map(([x, y], i) => (
                      <circle
                        key={i}
                        className="canvas__gizmo-handle canvas__gizmo-handle--scale"
                        cx={x}
                        cy={y}
                        r={HANDLE_RADIUS_PX / scale}
                        style={{ cursor: cornerResizeCursor(gizmo, i) }}
                        onMouseDown={(e) => handleGizmoHandleMouseDown(e, 'scale', i)}
                      />
                    ))}
                    <circle
                      className="canvas__gizmo-handle canvas__gizmo-handle--rotate"
                      cx={rotateHandlePage[0]}
                      cy={rotateHandlePage[1]}
                      r={HANDLE_RADIUS_PX / scale}
                      onMouseDown={(e) => handleGizmoHandleMouseDown(e, 'rotate')}
                    />
                  </svg>
                )}
              </>
            )
          ) : (
            imageUrl && <img src={imageUrl} alt="Uploaded artwork" className="canvas__surface canvas__image" />
          )}
        </div>
      </div>
    </div>
  );
}
