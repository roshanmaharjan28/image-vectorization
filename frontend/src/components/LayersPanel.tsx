import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Layer, SvgMeta, TreeNode } from '../types';
import { buildPanelRows, idsForRow } from '../lib/groupTree';
import { LayerRow } from './LayerRow';
import { GroupRow } from './GroupRow';
import { Badge } from './ui/badge';

interface Props {
  layers: Layer[];
  meta: SvgMeta | null;
  groupTree: TreeNode[] | null;
  collapsedGroupIds: Set<string>;
  hoveredLayerId: string | null;
  selectedLayerIds: string[];
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHoverLayer: (id: string | null) => void;
  // 'replace' swaps the whole selection (plain click), 'add' unions ids in (shift-range), 'toggle'
  // xors a single id (ctrl/cmd-click) — mirrors CanvasGL's onSelectLayer.
  onSelectLayer: (ids: string[], mode: 'replace' | 'add' | 'toggle') => void;
  onChangeColor: (id: string, hex: string) => void;
  onToggleGroupCollapsed: (id: string) => void;
  onSetVisibleMany: (ids: string[], visible: boolean) => void;
  onDeleteMany: (ids: string[]) => void;
  onDownloadGroup: (leafIds: string[], label: string) => void;
}

// Must match the rendered height of both LayerRow.tsx and GroupRow.tsx.
const ROW_HEIGHT = 45;
const OVERSCAN = 6;

export function LayersPanel({
  layers,
  meta,
  groupTree,
  collapsedGroupIds,
  hoveredLayerId,
  selectedLayerIds,
  onToggleVisible,
  onDelete,
  onHoverLayer,
  onSelectLayer,
  onChangeColor,
  onToggleGroupCollapsed,
  onSetVisibleMany,
  onDeleteMany,
  onDownloadGroup,
}: Props) {
  const rows = useMemo(
    () => buildPanelRows(groupTree, layers, collapsedGroupIds),
    [groupTree, layers, collapsedGroupIds],
  );
  const totalLayerCount = useMemo(() => layers.filter((l) => !l.deleted).length, [layers]);
  const selectedIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);

  // Shift-click range anchor — the index (in `rows`) of the last plain/ctrl click, extended (not
  // reset) by subsequent shift-clicks so repeated shift-clicks keep growing the same range,
  // matching standard file-list selection behavior.
  const lastSelectedIndexRef = useRef<number | null>(null);

  function handleRowClick(rowIndex: number, e: ReactMouseEvent) {
    const row = rows[rowIndex];
    if (!row) return;
    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      const anchor = lastSelectedIndexRef.current;
      const [start, end] = anchor < rowIndex ? [anchor, rowIndex] : [rowIndex, anchor];
      onSelectLayer(rows.slice(start, end + 1).flatMap(idsForRow), 'add');
      return;
    }
    lastSelectedIndexRef.current = rowIndex;
    if (e.ctrlKey || e.metaKey) {
      onSelectLayer(idsForRow(row), 'toggle');
    } else {
      onSelectLayer(idsForRow(row), 'replace');
    }
  }

  const listRef = useRef<HTMLDivElement>(null);

  // Only rows within the visible viewport (+ overscan) ever mount. With
  // thousands of layers, mounting every row up front means thousands of
  // simultaneous thumbnail `getBBox()` calls (each a forced layout), which is
  // what caused the freeze/crash on vectorize — this bounds mounted rows to a
  // constant count regardless of total layer count.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  useEffect(() => {
    const lastId = selectedLayerIds[selectedLayerIds.length - 1];
    if (!lastId) return;
    const idx = rows.findIndex((row) => (row.kind === 'layer' ? row.layer.id === lastId : row.leafIds.includes(lastId)));
    if (idx === -1) return;
    virtualizer.scrollToIndex(idx);
  }, [selectedLayerIds, rows, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <aside className="flex w-65 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        <span>Layers</span>
        <Badge variant="secondary">{totalLayerCount}</Badge>
      </div>
      <div className="relative flex-1 overflow-y-auto" ref={listRef}>
        {rows.length === 0 && (
          <p className="p-4 text-sm leading-relaxed text-muted-foreground">
            No layers left. Vectorize an image or undo deletions by re-vectorizing.
          </p>
        )}
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            const key = row.kind === 'layer' ? row.layer.id : row.id;
            return (
              <div
                key={key}
                className="absolute right-0 left-0 box-border"
                style={{ top: virtualRow.start, height: virtualRow.size }}
              >
                {row.kind === 'layer' ? (
                  <LayerRow
                    layer={row.layer}
                    index={row.displayNumber}
                    depth={row.depth}
                    rowIndex={virtualRow.index}
                    meta={meta}
                    isHovered={row.layer.id === hoveredLayerId}
                    isSelected={selectedIdSet.has(row.layer.id)}
                    onToggleVisible={onToggleVisible}
                    onDelete={onDelete}
                    onHover={onHoverLayer}
                    onRowClick={handleRowClick}
                    onChangeColor={onChangeColor}
                  />
                ) : (
                  <GroupRow
                    id={row.id}
                    label={row.label}
                    depth={row.depth}
                    rowIndex={virtualRow.index}
                    expanded={row.expanded}
                    memberCount={row.leafIds.length}
                    allVisible={row.allVisible}
                    isSelected={row.leafIds.length > 0 && row.leafIds.every((id) => selectedIdSet.has(id))}
                    leafIds={row.leafIds}
                    onToggleExpand={onToggleGroupCollapsed}
                    onSetVisible={onSetVisibleMany}
                    onDelete={onDeleteMany}
                    onDownload={onDownloadGroup}
                    onRowClick={handleRowClick}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
