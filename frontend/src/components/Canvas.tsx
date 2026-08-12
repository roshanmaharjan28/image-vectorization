import { useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import type { Layer, SvgMeta } from '../types';
import { layerToPathMarkup } from '../lib/svgSerialize';

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
              dangerouslySetInnerHTML={{
                __html: layers
                  .filter((layer) => layer.visible)
                  .map((layer) =>
                    layerToPathMarkup(layer, {
                      interactive: true,
                      highlighted: layer.id === hoveredLayerId || layer.id === selectedLayerId,
                    }),
                  )
                  .join(''),
              }}
            />
          ) : (
            imageUrl && <img src={imageUrl} alt="Uploaded artwork" className="canvas__surface canvas__image" />
          )}
        </div>
      </div>
    </div>
  );
}
