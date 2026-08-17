import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layer, SvgMeta } from '../types';
import { buildPalette, buildPaletteTexel, buildSceneGeometry, buildTransformTexel } from '../lib/sceneBuilder';
import {
  type GLState,
  OUTLINE_WIDTH_CSS_PX,
  initGL,
  pickAt,
  renderPick,
  renderScene,
  resizeCanvasAndPickBuffer,
  resolutionScaleFor,
  uploadGeometry,
  uploadPalette,
  uploadSelection,
  uploadTransformTextures,
} from '../lib/canvasGLEngine';
import { computeViewTransform } from '../lib/canvasViewTransform';

interface Options {
  meta: SvgMeta | null;
  layers: Layer[];
  hoveredLayerId: string | null;
  selectedLayerIds: string[];
  showPaths: boolean;
  /** Current CSS zoom (see CanvasGL's pan/zoom state) — drives the backing-store resolution. */
  zoom: number;
  /** Bumped by useCanvasPathEditing on every path-edit drag frame to force sceneGeometry to
   *  re-triangulate — see that hook's class comment for why this can't just watch `layers`. */
  geometryVersion: number;
}

/**
 * Owns the WebGL2 context/scene lifecycle for CanvasGL: initializing the GL program on mount,
 * uploading geometry/palette/transform textures whenever the layer *set* changes (a fresh
 * vectorize), diffing per-layer visibility/color/transform edits into O(1) texel writes, and
 * re-rendering on hover/select/zoom changes. Kept out of the component so CanvasGL itself only
 * has to wire refs/state together and render JSX — see canvasGLEngine.ts for the underlying pure
 * GL calls this hook sequences.
 */
export function useCanvasGLScene({ meta, layers, hoveredLayerId, selectedLayerIds, showPaths, zoom, geometryVersion }: Options) {
  const [glUnsupported, setGlUnsupported] = useState(false);
  // Every edge is drawn blue right after a fresh vectorize, until the user clicks a path or
  // clicks anywhere else — mirrors a hover/select outline but for all layers at once.
  const [allHighlighted, setAllHighlighted] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GLState | null>(null);
  const layerIndexMapRef = useRef<Map<string, number>>(new Map());
  const layerBoundsRef = useRef<Float32Array>(new Float32Array());
  const layersBaselineRef = useRef<Layer[] | null>(null);
  // Tracks the resolutionScale currently baked into the canvas/pick-buffer backing store, so the
  // hover/select and visibility effects (which don't resize anything themselves) can compute the
  // matching outline line width without recomputing resolutionScaleFor(zoom) — which could
  // otherwise briefly disagree with the buffer's actual resolution mid zoom-debounce.
  const resolutionScaleRef = useRef(resolutionScaleFor(1));

  const isVectorized = meta !== null;

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
  // pathsMarkup memo. `geometryVersion` is the deliberate exception: a path-edit drag
  // (useCanvasPathEditing) changes a layer's actual `attrs.d`, which does need re-triangulating.
  const sceneGeometry = useMemo(() => buildSceneGeometry(layers), [meta, geometryVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const resolutionScale = resolutionScaleFor(zoom);
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
    // Only a fresh layer *set* (a new vectorize, i.e. `meta` itself changing) should retrigger this
    // full reset (canvas resize, full texture re-uploads, the all-highlighted preview) — hover/
    // select/visibility/transform are handled by the cheaper effects below, same split as
    // Canvas.tsx. Deliberately keyed on `meta` rather than `sceneGeometry`: a path-edit drag also
    // changes `sceneGeometry` (see its memo above) but must NOT re-run any of this — see the
    // lightweight geometryVersion-only effect right below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Lightweight counterpart to the effect above, for path-edit drags: re-uploads just the
  // triangulated geometry and redraws, without touching the canvas size, the palette/transform/
  // selection textures (unaffected by a path edit), or the all-highlighted preview state.
  useEffect(() => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas || !meta || geometryVersion === 0) return;
    uploadGeometry(state, sceneGeometry);
    layerBoundsRef.current = sceneGeometry.layerBounds;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryVersion]);

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
  // scaling the artboard doesn't have to stretch too few source pixels — without this, both the
  // fill and the hover/select outline go soft past 1x zoom, since the backing store was sized
  // once at DPR and then just blown up visually. Debounced to the trailing edge of a zoom gesture
  // via setTimeout (not requestAnimationFrame): wheel events during a real scroll/pinch gesture
  // routinely have gaps longer than one frame, so an rAF-based "cancel and reschedule" fires on
  // almost every tick instead of just the end of the gesture — reallocating the canvas + pick
  // texture and doing a full re-render each time, which gets increasingly expensive as the
  // backing store grows toward the max zoom resolution. A real time-based debounce only does that
  // work once the zoom gesture actually pauses.
  useEffect(() => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas || !meta) return;
    const timeoutId = setTimeout(() => {
      const resolutionScale = resolutionScaleFor(zoom);
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
  }, [zoom]);

  const pickLayerIndexAt = useCallback((clientX: number, clientY: number): number => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return -1;
    return pickAt(state, canvas, clientX, clientY);
  }, []);

  return {
    canvasRef,
    glUnsupported,
    allHighlighted,
    sceneGeometry,
    layerIndexMapRef,
    layerBoundsRef,
    pickLayerIndexAt,
  };
}
