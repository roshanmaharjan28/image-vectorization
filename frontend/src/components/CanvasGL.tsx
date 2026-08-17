import { useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Layer, SvgMeta, Tool } from '../types';
import { ROTATE_CURSOR, computeGizmoState, computeViewTransform, cornerResizeCursor } from '../lib/canvasViewTransform';
import { useCanvasGLScene } from '../hooks/useCanvasGLScene';
import { useCanvasInteractions } from '../hooks/useCanvasInteractions';
import { useCanvasPathEditing } from '../hooks/useCanvasPathEditing';

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
  // instead of its fill color — see useCanvasGLScene/canvasGLEngine's renderScene.
  showPaths: boolean;
  // 'cursor' selects/moves/scales/rotates/path-edits elements as usual; 'hand' turns every drag
  // into a pan and disables hover/selection/gizmo/path-edit entirely.
  tool: Tool;
}

// Gizmo handle sizing, in constant screen pixels (divided by the current CSS zoom `scale` at
// render time so handles don't visually balloon/shrink as the user zooms).
const HANDLE_RADIUS_PX = 5;
const ROTATE_HANDLE_OFFSET_PX = 22;

/**
 * Experimental WebGL2 twin of Canvas.tsx: triangulates every layer's path once per vectorize into
 * a single VBO/IBO (one draw call for the whole scene, whatever the layer count), looks up fill
 * color from a 1-texel-per-layer palette texture (so a visibility toggle is an O(1)
 * texSubImage2D), and resolves hover/click via a GPU color-id pick buffer instead of DOM events.
 * Pan/zoom stays a CSS transform on the same .canvas__artboard wrapper Canvas.tsx uses, so
 * panning/zooming never re-triggers a GL render at all. Move/scale/rotate edits are likewise
 * GPU-resident (see canvasGLEngine.ts's transform textures) rather than re-triangulating.
 *
 * This component only wires state together and renders JSX — the actual WebGL calls live in
 * lib/canvasGLEngine.ts + hooks/useCanvasGLScene.ts, and pointer/drag handling lives in
 * hooks/useCanvasInteractions.ts.
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
  tool,
}: Props) {
  // CSS pan/zoom for the artboard wrapper — lives here (rather than inside a hook) since it's
  // needed both by useCanvasGLScene (to pick the GL backing-store resolution) and by the JSX
  // transform below, and useCanvasInteractions only needs to read/update it.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Bumped by useCanvasPathEditing on every path-edit drag frame to force a re-triangulation —
  // owned here (rather than by either hook) since useCanvasGLScene needs it as an input while
  // useCanvasPathEditing needs useCanvasGLScene's canvasRef/pickLayerIndexAt as its own input.
  const [geometryVersion, setGeometryVersion] = useState(0);

  const isVectorized = meta !== null;
  const view = meta ? computeViewTransform(meta) : null;

  const { canvasRef, glUnsupported, sceneGeometry, layerIndexMapRef, layerBoundsRef, pickLayerIndexAt } = useCanvasGLScene({
    meta,
    layers,
    hoveredLayerId,
    selectedLayerIds,
    showPaths,
    zoom: scale,
    geometryVersion,
  });

  const { editingLayerId, pathAnchors, exitPathEdit, handleCanvasDoubleClick, handleAnchorMouseDown, pathEditingWrapperHandlers } =
    useCanvasPathEditing({
      view,
      layers,
      onTransformLayers,
      canvasRef,
      pickLayerIndexAt,
      onPathEdited: () => setGeometryVersion((v) => v + 1),
    });

  const gizmo = useMemo(
    () => computeGizmoState(view, selectedLayerIds, layers, layerIndexMapRef.current, layerBoundsRef.current),
    // sceneGeometry is deliberately included: layerBoundsRef only updates when it changes, so the
    // gizmo box must be recomputed then too, not just on layers/selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, selectedLayerIds, meta, sceneGeometry],
  );

  const { wrapperRef, wrapperHandlers, canvasHandlers, handleGizmoHandleMouseDown, suppressNextClickRef } = useCanvasInteractions({
    view,
    tool,
    layers,
    selectedLayerIds,
    onSelectLayer,
    onHoverLayer,
    onTransformLayers,
    gizmo,
    canvasRef,
    pickLayerIndexAt,
    setScale,
    offset,
    setOffset,
  });

  // Pen tool: a plain click reaches the same path-edit entry point 'cursor' reaches via
  // double-click. Guarded by suppressNextClickRef so a pan drag (which still ends in a click,
  // since mousedown/mouseup land on the same canvas element) doesn't also toggle path-edit.
  function handlePenClick(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    handleCanvasDoubleClick(e);
  }

  // Cursor tool: a plain click anywhere else — the black page background or another path — should
  // drop out of path-edit mode, same as Escape. Skipped when this click is the tail end of a real
  // pan/gizmo drag (suppressNextClickRef), same guard canvasHandlers.onClick uses for selection.
  function handleCursorClick(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (editingLayerId && !suppressNextClickRef.current) exitPathEdit();
    canvasHandlers.onClick(e);
  }

  // The dark area outside the artboard page belongs to the wrapper div, not the <canvas> element,
  // so a click out there never reaches handleCursorClick above — handle the same exit here. Guarded
  // to the wrapper itself (not a bubbled click from the canvas/svg children, which handleCursorClick
  // and suppressNextClickRef already resolved) so a post-drag click isn't double-processed.
  function handleWrapperClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (editingLayerId) exitPathEdit();
  }

  const rotateHandlePage: [number, number] | null = gizmo
    ? [
        gizmo.rotateOriginPage[0] + gizmo.rotateDirPage[0] * (ROTATE_HANDLE_OFFSET_PX / scale),
        gizmo.rotateOriginPage[1] + gizmo.rotateDirPage[1] * (ROTATE_HANDLE_OFFSET_PX / scale),
      ]
    : null;

  // A path-edit anchor drag shares the same wrapper element as the pan/gizmo drags, but is its own
  // independent state machine (handleAnchorMouseDown always stops propagation, so the two never
  // fire for the same gesture) — compose both hooks' handlers rather than threading edit state
  // through useCanvasInteractions.
  const combinedWrapperHandlers = {
    ...wrapperHandlers,
    onClick: handleWrapperClick,
    onMouseMove: (e: ReactMouseEvent<HTMLDivElement>) => {
      wrapperHandlers.onMouseMove(e);
      pathEditingWrapperHandlers.onMouseMove(e);
    },
    onMouseUp: () => {
      wrapperHandlers.onMouseUp();
      pathEditingWrapperHandlers.onMouseUp();
    },
    onMouseLeave: () => {
      wrapperHandlers.onMouseLeave();
      pathEditingWrapperHandlers.onMouseUp();
    },
  };

  return (
    <div
      className={`canvas${tool === 'hand' ? ' canvas--hand' : ''}${tool === 'pen' ? ' canvas--pen' : ''}`}
      ref={wrapperRef}
      {...combinedWrapperHandlers}
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
                  {...canvasHandlers}
                  onClick={tool === 'pen' ? handlePenClick : tool === 'cursor' ? handleCursorClick : canvasHandlers.onClick}
                  onDoubleClick={tool === 'cursor' ? handleCanvasDoubleClick : undefined}
                />
                {showOriginal && imageUrl && (
                  <img
                    src={imageUrl}
                    alt="Original artwork"
                    className="canvas__surface canvas__image canvas__bitmap-overlay"
                  />
                )}
                {tool !== 'hand' && editingLayerId && pathAnchors && !showOriginal && view && (
                  <svg
                    className="canvas__path-edit"
                    width={view.width}
                    height={view.height}
                    viewBox={`0 0 ${view.width} ${view.height}`}
                  >
                    {pathAnchors.map(({ anchor, page }) => (
                      <circle
                        key={anchor.id}
                        className="canvas__path-anchor"
                        cx={page[0]}
                        cy={page[1]}
                        r={HANDLE_RADIUS_PX / scale}
                        onMouseDown={(e) => handleAnchorMouseDown(e, anchor)}
                      />
                    ))}
                  </svg>
                )}
                {tool === 'cursor' && gizmo && rotateHandlePage && !showOriginal && view && !editingLayerId && (
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
                      style={{ cursor: ROTATE_CURSOR }}
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
