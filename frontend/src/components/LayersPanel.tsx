import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Group, Ungroup } from 'lucide-react';
import type { Layer, SvgMeta, TreeNode } from '../types';
import { buildPanelRows, idsForRow, listGroupOptions } from '../lib/groupTree';
import { LayerRow } from './LayerRow';
import { GroupRow } from './GroupRow';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

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
  onRenameGroup: (id: string, label: string) => void;
  onGroupSelected: () => void;
  onUngroupSelected: () => void;
  onUngroupGroup: (groupId: string) => void;
  onMoveToGroup: (leafIds: string[], targetGroupId: string) => void;
  onRequestEditPath: (id: string) => void;
}

// Must match the rendered height of both LayerRow.tsx and GroupRow.tsx.
const ROW_HEIGHT = 45;
const OVERSCAN = 6;

const DEFAULT_PANEL_WIDTH = 260; // matches the old fixed `w-65`
const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 480;

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
  onRenameGroup,
  onGroupSelected,
  onUngroupSelected,
  onUngroupGroup,
  onMoveToGroup,
  onRequestEditPath,
}: Props) {
  const rows = useMemo(
    () => buildPanelRows(groupTree, layers, collapsedGroupIds),
    [groupTree, layers, collapsedGroupIds],
  );
  const totalLayerCount = useMemo(() => layers.filter((l) => !l.deleted).length, [layers]);
  const selectedIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const groupOptions = useMemo(() => listGroupOptions(groupTree, layers), [groupTree, layers]);
  // Whether every currently-selected layer is visible — used by a row's context menu so
  // Hide/Unhide reflects (and toggles) the whole selection, not just the row that was
  // right-clicked, when the click landed inside a multi-selection.
  const selectionAllVisible = useMemo(() => {
    const layerMap = new Map(layers.map((l) => [l.id, l] as const));
    return selectedLayerIds.every((id) => layerMap.get(id)?.visible ?? true);
  }, [layers, selectedLayerIds]);

  // Shift-click range anchor — the index (in `rows`) of the last plain/ctrl click, extended (not
  // reset) by subsequent shift-clicks so repeated shift-clicks keep growing the same range,
  // matching standard file-list selection behavior.
  const lastSelectedIndexRef = useRef<number | null>(null);
  // A row clicked inside this panel is by definition already visible, so the scroll-into-view
  // effect below (which exists for selections driven from *outside* the panel, e.g. clicking a
  // layer on the canvas) should skip the next selectedLayerIds change it sees.
  const skipNextScrollRef = useRef(false);

  function handleRowClick(rowIndex: number, e: ReactMouseEvent) {
    const row = rows[rowIndex];
    if (!row) return;
    skipNextScrollRef.current = true;
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

  // Which group row (if any) is currently showing a rename input, driven by GroupRow's
  // double-click and this panel's F2 handler below.
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  function handleGroupStartRename(id: string) {
    setEditingGroupId(id);
  }

  function handleGroupRenameCommit(id: string, label: string) {
    setEditingGroupId(null);
    const trimmed = label.trim();
    if (trimmed) onRenameGroup(id, trimmed);
  }

  function handleGroupRenameCancel() {
    setEditingGroupId(null);
  }

  // F2 renames the fully-selected group, mirroring Explorer/VS Code's "rename selected item"
  // shortcut. Skipped while an input/textarea already has focus so it doesn't hijack typing
  // elsewhere in the app.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'F2') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      const groupRow = rows.find(
        (row) => row.kind === 'group' && row.leafIds.length > 0 && row.leafIds.every((id) => selectedIdSet.has(id)),
      );
      if (!groupRow || groupRow.kind !== 'group') return;
      e.preventDefault();
      setEditingGroupId(groupRow.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rows, selectedIdSet]);

  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  // Drag-resize via pointer capture rather than document-level listeners — the handle keeps
  // receiving move/up events even once the cursor leaves it, without needing an effect teardown.
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null);

  function handleResizeStart(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    resizeStartRef.current = { pointerX: e.clientX, width: panelWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    // Panel is docked on the right, so dragging left (negative clientX delta) should grow it.
    const nextWidth = start.width + (start.pointerX - e.clientX);
    setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, nextWidth)));
  }

  function handleResizeEnd(e: ReactPointerEvent<HTMLDivElement>) {
    resizeStartRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
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

  // Read via a ref rather than a dependency: `rows` gets a new reference on every layer mutation
  // (hide/delete/expand), and this effect must fire only on an actual selection change, not on
  // every unrelated row rebuild (which was previously yanking the scroll position on those
  // actions).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }
    const lastId = selectedLayerIds[selectedLayerIds.length - 1];
    if (!lastId) return;
    const idx = rowsRef.current.findIndex((row) =>
      row.kind === 'layer' ? row.layer.id === lastId : row.leafIds.includes(lastId),
    );
    if (idx === -1) return;
    virtualizer.scrollToIndex(idx, { align: 'auto' });
  }, [selectedLayerIds, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize layers panel"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        className="absolute top-0 -left-0.5 z-10 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-primary/40 active:bg-primary/60"
      />
      <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        <span>Layers</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="Group selection (Ctrl+G)"
            disabled={selectedLayerIds.length < 2}
            onClick={onGroupSelected}
          >
            <Group />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="Ungroup selection (Ctrl+Shift+G)"
            disabled={selectedLayerIds.length === 0}
            onClick={onUngroupSelected}
          >
            <Ungroup />
          </Button>
          <Badge variant="secondary">{totalLayerCount}</Badge>
        </div>
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
                    onDownload={onDownloadGroup}
                    onRequestEditPath={onRequestEditPath}
                    canGroupSelection={selectedLayerIds.length >= 2 && selectedIdSet.has(row.layer.id)}
                    onGroupSelected={onGroupSelected}
                    groupOptions={groupOptions}
                    onMoveTo={onMoveToGroup}
                    selectedLayerIds={selectedLayerIds}
                    selectionAllVisible={selectionAllVisible}
                    onSetVisibleMany={onSetVisibleMany}
                    onDeleteMany={onDeleteMany}
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
                    isEditing={row.id === editingGroupId}
                    onStartRename={handleGroupStartRename}
                    onRenameCommit={handleGroupRenameCommit}
                    onRenameCancel={handleGroupRenameCancel}
                    canGroupSelection={
                      selectedLayerIds.length >= 2 && row.leafIds.length > 0 && row.leafIds.every((id) => selectedIdSet.has(id))
                    }
                    onGroupSelected={onGroupSelected}
                    onUngroup={onUngroupGroup}
                    groupOptions={groupOptions}
                    onMoveTo={onMoveToGroup}
                    selectedLayerIds={selectedLayerIds}
                    selectionAllVisible={selectionAllVisible}
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
