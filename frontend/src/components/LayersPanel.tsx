import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  const orderedLayers = useMemo(
    () => layers.filter((l) => !l.deleted).reverse(),
    [layers],
  );
  const total = orderedLayers.length;

  const listRef = useRef<HTMLDivElement>(null);

  // Only rows within the visible viewport (+ overscan) ever mount. With
  // thousands of layers, mounting every row up front means thousands of
  // simultaneous thumbnail `getBBox()` calls (each a forced layout), which is
  // what caused the freeze/crash on vectorize — this bounds mounted rows to a
  // constant count regardless of total layer count.
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  useEffect(() => {
    if (!selectedLayerId) return;
    const idx = orderedLayers.findIndex((l) => l.id === selectedLayerId);
    if (idx === -1) return;
    virtualizer.scrollToIndex(idx);
  }, [selectedLayerId, orderedLayers, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <aside className="layers-panel">
      <div className="layers-panel__header">
        <span>Layers</span>
        <span className="layers-panel__count">{total}</span>
      </div>
      <div className="layers-panel__list" ref={listRef}>
        {total === 0 && (
          <p className="layers-panel__empty">No layers left. Vectorize an image or undo deletions by re-vectorizing.</p>
        )}
        <div className="layers-panel__scroller" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => {
            const layer = orderedLayers[virtualRow.index];
            return (
              <div
                key={layer.id}
                className="layers-panel__row"
                style={{ top: virtualRow.start, height: virtualRow.size }}
              >
                <LayerRow
                  layer={layer}
                  index={total - virtualRow.index}
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
