import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import type { Layer, SvgMeta } from '../types';
import { buildPalette, buildPaletteTexel, buildSceneGeometry, type SceneGeometry } from '../lib/sceneBuilder';
import { createProgram, createShader, requireUniformLocation } from '../lib/glUtils';

interface Props {
  imageUrl: string | null;
  meta: SvgMeta | null;
  layers: Layer[];
  hoveredLayerId: string | null;
  onHoverLayer: (id: string | null) => void;
  selectedLayerId: string | null;
  onSelectLayer: (id: string | null) => void;
}

// Capped at 2x — sharp enough on retina without paying for absurd backing-store sizes on 3x/4x
// panels, since (unlike the SVG version) this canvas rasterizes once and CSS just scales the
// resulting bitmap for pan/zoom instead of re-rendering vectors at every zoom level.
const DPR = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

const HIGHLIGHT_RGB = [0.302, 0.671, 0.973]; // #4dabf7, same accent as Canvas.tsx's hover/select stroke

// Shared between the display and pick programs so a single VAO's attribute bindings (explicit
// `layout(location=...)`) are valid for both, regardless of link order.
const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_layerIndex;
uniform vec2 u_vbMin;
uniform float u_meetScale;
uniform vec2 u_meetOffset;
uniform vec2 u_contentSize;
flat out int v_layerIndex;
void main() {
  vec2 p = (a_position - u_vbMin) * u_meetScale + u_meetOffset;
  vec2 clip = vec2(p.x / u_contentSize.x * 2.0 - 1.0, 1.0 - p.y / u_contentSize.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_layerIndex = int(a_layerIndex + 0.5);
}`;

// Samples fill color + visibility from a 1-texel-per-layer palette texture (so toggling one
// layer's visibility is an O(1) texSubImage2D, not a rebuild). Hover/select no longer tints the
// fill here — see OUTLINE_FRAGMENT_SHADER, which draws just the edge, matching Canvas.tsx's CSS
// stroke highlight instead of tinting the whole shape.
const DISPLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
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
flat out int v_layerIndex;
vec2 toClip(vec2 world) {
  vec2 p = (world - u_vbMin) * u_meetScale + u_meetOffset;
  return vec2(p.x / u_contentSize.x * 2.0 - 1.0, 1.0 - p.y / u_contentSize.y * 2.0);
}
void main() {
  vec2 clipHere = toClip(a_position);
  vec2 clipOther = toClip(a_other);
  vec2 dir = normalize(clipOther - clipHere);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 offset = normal * (a_side * u_lineWidthPx * 0.5) * (2.0 / u_viewportPx);
  gl_Position = vec4(clipHere + offset, 0.0, 1.0);
  v_layerIndex = int(a_layerIndex + 0.5);
}`;

// Only lets fragments belonging to the hovered/selected layer through — same discard-by-index
// trick as the pick shader, but for drawing rather than reading back.
const OUTLINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in int v_layerIndex;
uniform sampler2D u_palette;
uniform int u_paletteWidth;
uniform int u_hoverIndex;
uniform int u_selectIndex;
out vec4 outColor;
void main() {
  if (v_layerIndex != u_hoverIndex && v_layerIndex != u_selectIndex) discard;
  vec4 c = texelFetch(u_palette, ivec2(v_layerIndex % u_paletteWidth, v_layerIndex / u_paletteWidth), 0);
  if (c.a < 0.5) discard;
  outColor = vec4(${HIGHLIGHT_RGB.join(', ')}, 1.0);
}`;

// Matches Canvas.tsx's `stroke-width:3` CSS px, scaled to the canvas's backing-store resolution.
const OUTLINE_WIDTH_PX = 3 * DPR;

// Encodes (layerIndex + 1) into RGB8 so a single-pixel readback resolves hover/click hit-testing
// in O(1) regardless of layer count — the GL analogue of Canvas.tsx's data-layer-id lookup.
const PICK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
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
    selectIndex: WebGLUniformLocation;
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
      selectIndex: requireUniformLocation(gl, outlineProgram, 'u_selectIndex'),
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

// Laid out as a width-capped 2D grid (row-major by layer index), not a single layerCount-wide
// row — a 1-row texture silently fails to allocate once layerCount exceeds this GPU's
// MAX_TEXTURE_SIZE, and an incomplete texture samples as opaque black (the bug this avoids).
function uploadPalette(state: GLState, palette: Uint8Array, layerCount: number) {
  const { gl } = state;
  const count = Math.max(1, layerCount);
  const width = Math.min(count, state.maxTextureSize);
  const height = Math.ceil(count / width);
  let data = palette;
  if (width * height !== count) {
    data = new Uint8Array(width * height * 4);
    data.set(palette);
  }
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  state.paletteWidth = width;
}

function resizeCanvasAndPickBuffer(state: GLState, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number) {
  const { gl } = state;
  const width = Math.max(1, Math.round(cssWidth * DPR));
  const height = Math.max(1, Math.round(cssHeight * DPR));
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
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.bindVertexArray(state.vao);
  gl.drawElements(gl.TRIANGLES, state.indexCount, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
}

// Draws only the hovered/selected layer's edge on top of the already-rendered fill — call this
// right after renderDisplay, into the same default framebuffer, so it composites over the fill.
function renderOutline(state: GLState, view: ViewTransform, hoverIndex: number, selectIndex: number) {
  const { gl } = state;
  if (state.outlineVertexCount === 0 || (hoverIndex < 0 && selectIndex < 0)) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.useProgram(state.outlineProgram);
  setTransformUniforms(gl, state.outlineUniforms, view, state.paletteWidth);
  gl.uniform2f(state.outlineUniforms.viewportPx, gl.canvas.width, gl.canvas.height);
  gl.uniform1f(state.outlineUniforms.lineWidthPx, OUTLINE_WIDTH_PX);
  gl.uniform1i(state.outlineUniforms.hoverIndex, hoverIndex);
  gl.uniform1i(state.outlineUniforms.selectIndex, selectIndex);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
  gl.bindVertexArray(state.outlineVao);
  gl.drawArrays(gl.TRIANGLES, 0, state.outlineVertexCount);
  gl.bindVertexArray(null);
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.paletteTexture);
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

/**
 * Experimental WebGL2 twin of Canvas.tsx: triangulates every layer's path once per vectorize into
 * a single VBO/IBO (one draw call for the whole scene, whatever the layer count), looks up fill
 * color from a 1-texel-per-layer palette texture (so a visibility toggle is an O(1)
 * texSubImage2D), and resolves hover/click via a GPU color-id pick buffer instead of DOM events —
 * see pickAt above. Pan/zoom stays a CSS transform on the same .canvas__artboard wrapper Canvas.tsx
 * uses, so panning/zooming never re-triggers a GL render at all.
 */
export function CanvasGL({
  imageUrl,
  meta,
  layers,
  hoveredLayerId,
  onHoverLayer,
  selectedLayerId,
  onSelectLayer,
}: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [glUnsupported, setGlUnsupported] = useState(false);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GLState | null>(null);
  const layerIndexMapRef = useRef<Map<string, number>>(new Map());
  const layersBaselineRef = useRef<Layer[] | null>(null);
  const rafPickPending = useRef(false);

  const isVectorized = meta !== null;

  function handleWheel(e: WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setScale((s) => Math.min(8, Math.max(0.1, s + delta * s)));
  }

  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    dragOrigin.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
    if (!dragOrigin.current) return;
    setOffset({ x: e.clientX - dragOrigin.current.x, y: e.clientY - dragOrigin.current.y });
  }

  function stopDrag() {
    dragOrigin.current = null;
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
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    const idx = pickAt(state, canvas, e.clientX, e.clientY);
    onSelectLayer(idx >= 0 ? layers[idx]?.id ?? null : null);
  }

  // The GL context dies with the <canvas> element whenever we switch back to the plain-<img>
  // branch (or unmount) — drop the stale handle so the next mount reinitializes from scratch.
  useEffect(() => {
    return () => {
      glStateRef.current = null;
    };
  }, [isVectorized]);

  // Triangulating every layer's path is only worth redoing when the layer *set* changes — a
  // fresh vectorize — not on every visibility toggle. Mirrors Canvas.tsx's pathsMarkup memo.
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
    resizeCanvasAndPickBuffer(state, canvas, view.width, view.height);
    uploadGeometry(state, sceneGeometry);
    uploadPalette(state, buildPalette(layers), layers.length);

    const idMap = new Map<string, number>();
    layers.forEach((layer, i) => idMap.set(layer.id, i));
    layerIndexMapRef.current = idMap;
    layersBaselineRef.current = null;

    const hoverIndex = hoveredLayerId ? idMap.get(hoveredLayerId) ?? -1 : -1;
    const selectIndex = selectedLayerId ? idMap.get(selectedLayerId) ?? -1 : -1;
    renderDisplay(state, view);
    renderOutline(state, view, hoverIndex, selectIndex);
    renderPick(state, view);
    // Only the fresh layer *set* (sceneGeometry) should retrigger the full GPU upload — hover/
    // select/visibility are handled by the cheaper effects below, same split as Canvas.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneGeometry]);

  // Visibility/deletion diff — identical shape to Canvas.tsx's data-hidden effect, but writes a
  // single palette texel via texSubImage2D instead of toggling a DOM attribute.
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
    }
    layersBaselineRef.current = layers;

    if (changed) {
      const view = computeViewTransform(meta);
      const hoverIndex = hoveredLayerId ? layerIndexMapRef.current.get(hoveredLayerId) ?? -1 : -1;
      const selectIndex = selectedLayerId ? layerIndexMapRef.current.get(selectedLayerId) ?? -1 : -1;
      renderDisplay(state, view);
      renderOutline(state, view, hoverIndex, selectIndex);
      renderPick(state, view);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers]);

  // Hover/select are pure uniform changes — redraw the display + outline passes only; the pick
  // buffer's contents don't depend on which layer is currently hovered/selected.
  useEffect(() => {
    const state = glStateRef.current;
    if (!state || !meta) return;
    const view = computeViewTransform(meta);
    const hoverIndex = hoveredLayerId ? layerIndexMapRef.current.get(hoveredLayerId) ?? -1 : -1;
    const selectIndex = selectedLayerId ? layerIndexMapRef.current.get(selectedLayerId) ?? -1 : -1;
    renderDisplay(state, view);
    renderOutline(state, view, hoverIndex, selectIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredLayerId, selectedLayerId, sceneGeometry]);

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
              <canvas
                ref={canvasRef}
                className="canvas__surface"
                onMouseMove={handleCanvasMouseMove}
                onMouseLeave={() => onHoverLayer(null)}
                onClick={handleCanvasClick}
              />
            )
          ) : (
            imageUrl && <img src={imageUrl} alt="Uploaded artwork" className="canvas__surface canvas__image" />
          )}
        </div>
      </div>
    </div>
  );
}
