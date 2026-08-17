import type { Layer } from '../types';
import {
  buildSelectionArray,
  buildTransformArrays,
  type SceneGeometry,
} from './sceneBuilder';
import { createProgram, createShader, requireUniformLocation } from './glUtils';

// Capped at 2x — sharp enough on retina without paying for absurd backing-store sizes on 3x/4x
// panels, since (unlike the SVG version) this canvas rasterizes once and CSS just scales the
// resulting bitmap for pan/zoom instead of re-rendering vectors at every zoom level.
export const DPR = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

export const HIGHLIGHT_RGB = [0.302, 0.671, 0.973]; // #4dabf7, same accent as Canvas.tsx's hover/select stroke
export const PATHS_OUTLINE_RGB = [0, 0, 0]; // black, for the Illustrator-style "show paths" outline view

// Thinner than Canvas.tsx's `stroke-width:3` CSS px — a hairline reads clearer against the fill
// than a thick one. Converted to backing-store pixels via the current resolutionScale (see
// resolutionScaleFor) wherever it's used, not a fixed constant, since the backing-store
// resolution itself now tracks zoom (see resolutionScaleFor below).
export const OUTLINE_WIDTH_CSS_PX = 1.25;

// The canvas rasterizes once and CSS `transform: scale()` handles pan/zoom (see CanvasGL's class
// comment) — but a backing store fixed at DPR goes soft the moment CSS stretches it past 1x zoom,
// for both the fill and the hover/select outline. Raising the backing-store resolution to track
// the current zoom keeps the raster sharp, same as an SVG re-rasterizing at its displayed size.
// Capped at 4x on top of DPR so extreme zoom can't allocate an unbounded GPU texture.
const MAX_ZOOM_RESOLUTION = 4;

export function resolutionScaleFor(zoom: number) {
  return DPR * Math.min(Math.max(zoom, 1), MAX_ZOOM_RESOLUTION);
}

export interface ViewTransform {
  width: number;
  height: number;
  vbMinX: number;
  vbMinY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

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

export interface GLState {
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

export function initGL(canvas: HTMLCanvasElement): GLState | null {
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

export function uploadGeometry(state: GLState, geometry: SceneGeometry) {
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
export function uploadPalette(state: GLState, palette: Uint8Array, layerCount: number) {
  const { gl } = state;
  const { width, height } = computeGridSize(layerCount, state.maxTextureSize);
  const data = padUint8ToLength(palette, width * height * 4);
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  state.paletteWidth = width;
}

/** Full rebuild of the per-layer edit-transform textures — see buildTransformArrays. */
export function uploadTransformTextures(state: GLState, layers: Layer[]) {
  const { gl } = state;
  const { width, height } = computeGridSize(layers.length, state.maxTextureSize);
  const { ab, ef } = buildTransformArrays(layers);
  gl.bindTexture(gl.TEXTURE_2D, state.transformABTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padToLength(ab, width * height * 4));
  gl.bindTexture(gl.TEXTURE_2D, state.transformEFTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, padToLength(ef, width * height * 4));
}

/** Full rebuild of the group-selection mask texture — cheap even for tens of thousands of layers. */
export function uploadSelection(state: GLState, layers: Layer[], selectedIds: ReadonlySet<string>) {
  const { gl } = state;
  const { width, height } = computeGridSize(layers.length, state.maxTextureSize);
  const selection = buildSelectionArray(layers, selectedIds);
  gl.bindTexture(gl.TEXTURE_2D, state.selectionTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, padUint8ToLength(selection, width * height));
}

export function resizeCanvasAndPickBuffer(
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
export function renderScene(
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

export function renderPick(state: GLState, view: ViewTransform) {
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

export function pickAt(state: GLState, canvas: HTMLCanvasElement, clientX: number, clientY: number): number {
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
