import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Layer, SvgMeta } from '../types';
import { LayerRow } from './LayerRow';
import { Badge } from './ui/badge';

interface Props {
  layers: Layer[];
  meta: SvgMeta | null;
  hoveredLayerId: string | null;
  selectedLayerIds: string[];
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHoverLayer: (id: string | null) => void;
  // 'replace' swaps the whole selection (plain click), 'add' unions ids in (shift-range), 'toggle'
  // xors a single id (ctrl/cmd-click) — mirrors CanvasGL's onSelectLayer.
  onSelectLayer: (ids: string[], mode: 'replace' | 'add' | 'toggle') => void;
  onChangeColor: (id: string, hex: string) => void;
}

// Must match the rendered height of the row in LayerRow.tsx.
const ROW_HEIGHT = 45;
const OVERSCAN = 6;

export function LayersPanel({
  layers,
  meta,
  hoveredLayerId,
  selectedLayerIds,
  onToggleVisible,
  onDelete,
  onHoverLayer,
  onSelectLayer,
  onChangeColor,
}: Props) {
  const orderedLayers = useMemo(
    () => layers.filter((l) => !l.deleted).reverse(),
    [layers],
  );
  const total = orderedLayers.length;
  const selectedIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);

  // Shift-click range anchor — the index (in `orderedLayers`) of the last plain/ctrl click,
  // extended (not reset) by subsequent shift-clicks so repeated shift-clicks keep growing the same
  // range, matching standard file-list selection behavior.
  const lastSelectedIndexRef = useRef<number | null>(null);

  function handleRowClick(id: string, e: ReactMouseEvent) {
    const idx = orderedLayers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      const anchor = lastSelectedIndexRef.current;
      const [start, end] = anchor < idx ? [anchor, idx] : [idx, anchor];
      onSelectLayer(orderedLayers.slice(start, end + 1).map((l) => l.id), 'add');
      return;
    }
    lastSelectedIndexRef.current = idx;
    if (e.ctrlKey || e.metaKey) {
      onSelectLayer([id], 'toggle');
    } else {
      onSelectLayer([id], 'replace');
    }
  }

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
    const lastId = selectedLayerIds[selectedLayerIds.length - 1];
    if (!lastId) return;
    const idx = orderedLayers.findIndex((l) => l.id === lastId);
    if (idx === -1) return;
    virtualizer.scrollToIndex(idx);
  }, [selectedLayerIds, orderedLayers, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <aside className="flex w-65 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        <span>Layers</span>
        <Badge variant="secondary">{total}</Badge>
      </div>
      <div className="relative flex-1 overflow-y-auto" ref={listRef}>
        {total === 0 && (
          <p className="p-4 text-sm leading-relaxed text-muted-foreground">
            No layers left. Vectorize an image or undo deletions by re-vectorizing.
          </p>
        )}
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => {
            const layer = orderedLayers[virtualRow.index];
            return (
              <div
                key={layer.id}
                className="absolute right-0 left-0 box-border"
                style={{ top: virtualRow.start, height: virtualRow.size }}
              >
                <LayerRow
                  layer={layer}
                  index={total - virtualRow.index}
                  meta={meta}
                  isHovered={layer.id === hoveredLayerId}
                  isSelected={selectedIdSet.has(layer.id)}
                  onToggleVisible={onToggleVisible}
                  onDelete={onDelete}
                  onHover={onHoverLayer}
                  onRowClick={handleRowClick}
                  onChangeColor={onChangeColor}
                />
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
