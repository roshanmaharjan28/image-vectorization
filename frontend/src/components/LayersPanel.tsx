import { useEffect, useMemo, useRef, useState } from 'react';
import type { Layer, SvgMeta } from '../types';
import { LayerRow } from './LayerRow';

interface Props {
  layers: Layer[];
  meta: SvgMeta | null;
  hoveredLayerId: string | null;
  selectedLayerId: string | null;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHoverLayer: (id: string | null) => void;
}

// Must match the rendered height of `.layer-row` in App.css.
const ROW_HEIGHT = 45;
const OVERSCAN = 6;

export function LayersPanel({
  layers,
  meta,
  hoveredLayerId,
  selectedLayerId,
  onToggleVisible,
  onDelete,
  onHoverLayer,
}: Props) {
  const orderedLayers = useMemo(() => [...layers].reverse(), [layers]);
  const total = orderedLayers.length;

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Only rows within the visible viewport (+ overscan) ever mount. With
  // thousands of layers, mounting every row up front means thousands of
  // simultaneous thumbnail `getBBox()` calls (each a forced layout), which is
  // what caused the freeze/crash on vectorize — this bounds mounted rows to a
  // constant count regardless of total layer count.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedLayerId) return;
    const el = listRef.current;
    if (!el) return;
    const idx = orderedLayers.findIndex((l) => l.id === selectedLayerId);
    if (idx === -1) return;
    const rowTop = idx * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < el.scrollTop) {
      el.scrollTop = rowTop;
    } else if (rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowBottom - el.clientHeight;
    }
  }, [selectedLayerId, orderedLayers]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);
  const visibleLayers = orderedLayers.slice(startIndex, endIndex);

  return (
    <aside className="layers-panel">
      <div className="layers-panel__header">
        <span>Layers</span>
        <span className="layers-panel__count">{layers.length}</span>
      </div>
      <div
        className="layers-panel__list"
        ref={listRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {total === 0 && (
          <p className="layers-panel__empty">No layers left. Vectorize an image or undo deletions by re-vectorizing.</p>
        )}
        <div className="layers-panel__scroller" style={{ height: total * ROW_HEIGHT }}>
          {visibleLayers.map((layer, i) => {
            const idx = startIndex + i;
            return (
              <div key={layer.id} className="layers-panel__row" style={{ top: idx * ROW_HEIGHT, height: ROW_HEIGHT }}>
                <LayerRow
                  layer={layer}
                  index={total - idx}
                  meta={meta}
                  isHovered={layer.id === hoveredLayerId}
                  isSelected={layer.id === selectedLayerId}
                  onToggleVisible={onToggleVisible}
                  onDelete={onDelete}
                  onHover={onHoverLayer}
                />
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
