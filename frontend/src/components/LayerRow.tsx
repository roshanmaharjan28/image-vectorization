import { memo, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Layer, SvgMeta } from '../types';
import { layerToPathMarkup } from '../lib/svgSerialize';
import { normalizeColorToHex } from '../lib/sceneBuilder';

interface Props {
  layer: Layer;
  index: number;
  meta: SvgMeta | null;
  isHovered: boolean;
  isSelected: boolean;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHover: (id: string | null) => void;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onChangeColor: (id: string, hex: string) => void;
}

export const LayerRow = memo(function LayerRow({
  layer,
  index,
  meta,
  isHovered,
  isSelected,
  onToggleVisible,
  onDelete,
  onHover,
  onRowClick,
  onChangeColor,
}: Props) {
  const thumbRef = useRef<SVGSVGElement>(null);
  const [thumbViewBox, setThumbViewBox] = useState<string | null>(null);

  useEffect(() => {
    if (!meta) return;
    const path = thumbRef.current?.querySelector('path');
    if (!path) return;
    try {
      const bbox = path.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const pad = Math.max(bbox.width, bbox.height) * 0.08;
        setThumbViewBox(`${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
      } else {
        setThumbViewBox(meta.viewBox);
      }
    } catch {
      setThumbViewBox(meta.viewBox);
    }
  }, [layer, meta]);

  return (
    <div
      className={`layer-row${layer.visible ? '' : ' layer-row--hidden'}${isHovered ? ' layer-row--hovered' : ''}${isSelected ? ' layer-row--selected' : ''}`}
      onMouseEnter={() => onHover(layer.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => onRowClick(layer.id, e)}
    >
      <input
        type="color"
        className="layer-row__color-input"
        title="Change layer color"
        value={normalizeColorToHex(layer.fill)}
        onChange={(e) => onChangeColor(layer.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
      {meta ? (
        <svg
          ref={thumbRef}
          className="layer-row__thumb"
          viewBox={thumbViewBox ?? meta.viewBox}
          preserveAspectRatio="xMidYMid meet"
          dangerouslySetInnerHTML={{ __html: layerToPathMarkup(layer) }}
        />
      ) : (
        <span className="layer-row__swatch" style={{ backgroundColor: layer.fill }} />
      )}
      <span className="layer-row__label">Layer {index}</span>
      <button
        type="button"
        className="layer-row__action"
        title={layer.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible(layer.id);
        }}
      >
        {layer.visible ? '👁' : '—'}
      </button>
      <button
        type="button"
        className="layer-row__action layer-row__action--danger"
        title="Delete layer"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(layer.id);
        }}
      >
        🗑
      </button>
    </div>
  );
});
