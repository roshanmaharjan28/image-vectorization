import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import type { Layer, SvgMeta } from '../types';
import { layerToPathMarkup } from '../lib/svgSerialize';

// Static — content never changes, so React never touches this <style> tag
// after mount. Hover/select/hidden state is applied by toggling a
// class/attribute directly on the affected <path> node(s) instead (see the
// effects below): rewriting a <style> tag's text forces the browser to
// re-match every selector against the whole document, which is O(total
// layers) and was the actual source of lag on every single hover event with
// tens of thousands of paths — even without ever hiding or deleting anything.
const CANVAS_STYLE =
  'path[data-hidden="true"]{display:none;}' +
  'path.layer-hover,path.layer-selected{stroke:#4dabf7;stroke-width:3;stroke-opacity:.9;vector-effect:non-scaling-stroke;}';

interface Props {
  imageUrl: string | null;
  meta: SvgMeta | null;
  layers: Layer[];
  hoveredLayerId: string | null;
  onHoverLayer: (id: string | null) => void;
  selectedLayerId: string | null;
  onSelectLayer: (id: string | null) => void;
}

export function Canvas({
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
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const gRef = useRef<SVGGElement>(null);
  const pathMapRef = useRef<Map<string, SVGPathElement>>(new Map());
  const hoveredElRef = useRef<SVGPathElement | null>(null);
  const selectedElRef = useRef<SVGPathElement | null>(null);
  const layersBaselineRef = useRef<Layer[] | null>(null);

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

  function layerIdFromEvent(e: MouseEvent<SVGSVGElement>): string | null {
    const target = e.target as SVGElement;
    return target.getAttribute?.('data-layer-id') ?? null;
  }

  function handlePathMouseOver(e: MouseEvent<SVGSVGElement>) {
    const id = layerIdFromEvent(e);
    if (id) onHoverLayer(id);
  }

  function handlePathMouseOut(e: MouseEvent<SVGSVGElement>) {
    if (layerIdFromEvent(e)) onHoverLayer(null);
  }

  function handlePathClick(e: MouseEvent<SVGSVGElement>) {
    onSelectLayer(layerIdFromEvent(e));
  }

  const isVectorized = meta !== null;

  // The layer *set* (ids/attrs/order) only ever changes when a new image is
  // vectorized — visibility toggles and deletes are pure flag flips on
  // existing layer objects (see VectorizerPage's handlers). So this is keyed
  // on `meta` (which changes exactly when a fresh layer set is loaded), not on
  // `layers` — otherwise every single toggle/delete would re-serialize all N
  // path strings (including their large `d` attributes) and re-run the DOM
  // write below, tearing down and recreating every SVG path node. With tens
  // of thousands of layers that rebuild is the dominant source of lag.
  const pathsMarkup = useMemo(
    () => layers.map((layer) => layerToPathMarkup(layer, { interactive: true })).join(''),
    [meta],
  );

  // Writes pathsMarkup into the <g> imperatively, exactly once per fresh
  // vectorize, instead of via React's dangerouslySetInnerHTML prop. React's
  // diffing for that prop does not reliably skip the DOM write just because
  // the `__html` string value is unchanged across renders — in practice it
  // still resets the <g>'s innerHTML (destroying and recreating every <path>
  // node) on renders triggered by unrelated state like hover. Setting
  // innerHTML by hand here means it only ever runs when pathsMarkup itself
  // changes, fully decoupling the 38,000-node DOM tree from hover/select
  // re-renders.
  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    g.innerHTML = pathsMarkup;
    const map = new Map<string, SVGPathElement>();
    g.querySelectorAll<SVGPathElement>('path[data-layer-id]').forEach((el) => {
      const id = el.getAttribute('data-layer-id');
      if (id) map.set(id, el);
    });
    pathMapRef.current = map;
    hoveredElRef.current = null;
    selectedElRef.current = null;
    layersBaselineRef.current = null;
  }, [pathsMarkup]);

  // Hover highlight is applied by toggling a class on just the affected
  // node(s) — O(1) regardless of layer count, unlike rewriting a <style> rule
  // list (which forces the browser to re-match selectors across every node).
  useEffect(() => {
    hoveredElRef.current?.classList.remove('layer-hover');
    const el = hoveredLayerId ? (pathMapRef.current.get(hoveredLayerId) ?? null) : null;
    el?.classList.add('layer-hover');
    hoveredElRef.current = el;
  }, [hoveredLayerId, pathsMarkup]);

  useEffect(() => {
    selectedElRef.current?.classList.remove('layer-selected');
    const el = selectedLayerId ? (pathMapRef.current.get(selectedLayerId) ?? null) : null;
    el?.classList.add('layer-selected');
    selectedElRef.current = el;
  }, [selectedLayerId, pathsMarkup]);

  // Visibility/deletion is applied by toggling data-hidden directly on the
  // node(s) whose layer object reference actually changed (map/filter give
  // every untouched layer the same reference, so this diff is cheap), rather
  // than recomputing a full CSS rule list on every toggle.
  useEffect(() => {
    const baseline = layersBaselineRef.current;
    if (!baseline || baseline.length !== layers.length) {
      layersBaselineRef.current = layers;
      return;
    }
    for (let i = 0; i < layers.length; i++) {
      if (layers[i] === baseline[i]) continue;
      const layer = layers[i];
      const el = pathMapRef.current.get(layer.id);
      if (!el) continue;
      if (!layer.visible || layer.deleted) {
        el.setAttribute('data-hidden', 'true');
      } else {
        el.removeAttribute('data-hidden');
      }
    }
    layersBaselineRef.current = layers;
  }, [layers]);

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
            <svg
              className="canvas__surface"
              width={meta.width}
              height={meta.height}
              viewBox={meta.viewBox}
              onMouseOver={handlePathMouseOver}
              onMouseOut={handlePathMouseOut}
              onMouseLeave={() => onHoverLayer(null)}
              onClick={handlePathClick}
            >
              <style>{CANVAS_STYLE}</style>
              <g ref={gRef} />
            </svg>
          ) : (
            imageUrl && <img src={imageUrl} alt="Uploaded artwork" className="canvas__surface canvas__image" />
          )}
        </div>
      </div>
    </div>
  );
}
