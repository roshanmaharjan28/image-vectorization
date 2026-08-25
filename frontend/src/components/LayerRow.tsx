import { memo, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import type { Layer, SvgMeta } from '../types';
import { layerToPathMarkup } from '../lib/svgSerialize';
import { normalizeColorToHex } from '../lib/sceneBuilder';
import { ROW_BASE_PADDING_PX, ROW_INDENT_PX, filterMoveTargets, type GroupOption } from '../lib/groupTree';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { ContextMenu, ContextMenuPortal, ContextMenuTrigger } from './ui/context-menu';
import { LayerContextMenuItems } from './LayerContextMenuItems';

interface Props {
  layer: Layer;
  index: number;
  depth: number;
  rowIndex: number;
  meta: SvgMeta | null;
  isHovered: boolean;
  isSelected: boolean;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHover: (id: string | null) => void;
  onRowClick: (rowIndex: number, e: ReactMouseEvent) => void;
  onChangeColor: (id: string, hex: string) => void;
  onDownload: (leafIds: string[], label: string) => void;
  onRequestEditPath: (id: string) => void;
  canGroupSelection: boolean;
  onGroupSelected: () => void;
  groupOptions: GroupOption[];
  onMoveTo: (leafIds: string[], targetGroupId: string) => void;
  selectedLayerIds: string[];
  selectionAllVisible: boolean;
  onSetVisibleMany: (ids: string[], visible: boolean) => void;
  onDeleteMany: (ids: string[]) => void;
}

export const LayerRow = memo(function LayerRow({
  layer,
  index,
  depth,
  rowIndex,
  meta,
  isHovered,
  isSelected,
  onToggleVisible,
  onDelete,
  onHover,
  onRowClick,
  onChangeColor,
  onDownload,
  onRequestEditPath,
  canGroupSelection,
  onGroupSelected,
  groupOptions,
  onMoveTo,
  selectedLayerIds,
  selectionAllVisible,
  onSetVisibleMany,
  onDeleteMany,
}: Props) {
  const thumbRef = useRef<SVGSVGElement>(null);
  // A right-click inside an existing multi-selection acts on the whole selection, matching
  // conventional file-list context-menu behavior; right-clicking outside it acts on just this row.
  const isMultiSelected = isSelected && selectedLayerIds.length > 1;
  const menuTargetIds = isMultiSelected ? selectedLayerIds : [layer.id];
  const menuVisible = isMultiSelected ? selectionAllVisible : layer.visible;
  const moveTargets = filterMoveTargets(groupOptions, menuTargetIds);
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
    <ContextMenu>
    <ContextMenuTrigger
      className={cn(
        'box-border flex h-full items-center gap-2.5 border-b border-border pr-4',
        !layer.visible && 'opacity-45',
        isHovered && 'bg-muted',
        isSelected && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]',
      )}
      style={{ paddingLeft: ROW_BASE_PADDING_PX + depth * ROW_INDENT_PX }}
      onMouseEnter={() => onHover(layer.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => onRowClick(rowIndex, e)}
    >
      <input
        type="color"
        className="size-4.5 shrink-0 cursor-pointer rounded-xs border border-border bg-none p-0 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
        title="Change layer color"
        value={normalizeColorToHex(layer.fill)}
        onChange={(e) => onChangeColor(layer.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
      {meta ? (
        <svg
          ref={thumbRef}
          className="size-7 shrink-0 rounded-xs border border-border bg-[#f2f2f2]"
          viewBox={thumbViewBox ?? meta.viewBox}
          preserveAspectRatio="xMidYMid meet"
          dangerouslySetInnerHTML={{ __html: layerToPathMarkup(layer) }}
        />
      ) : (
        <span className="size-7 shrink-0 rounded-xs border border-border" style={{ backgroundColor: layer.fill }} />
      )}
      <span className="flex-1 truncate text-sm">Layer {index}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        title={layer.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible(layer.id);
        }}
      >
        {layer.visible ? <Eye /> : <EyeOff />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-destructive"
        title="Delete layer"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(layer.id);
        }}
      >
        <Trash2 />
      </Button>
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <LayerContextMenuItems
        visible={menuVisible}
        onToggleVisible={() => (isMultiSelected ? onSetVisibleMany(menuTargetIds, !menuVisible) : onToggleVisible(layer.id))}
        onDownload={() => onDownload(menuTargetIds, isMultiSelected ? `${menuTargetIds.length} layers` : `Layer ${index}`)}
        downloadLabel={isMultiSelected ? `Download ${menuTargetIds.length} layers` : 'Download layer'}
        onDelete={() => (isMultiSelected ? onDeleteMany(menuTargetIds) : onDelete(layer.id))}
        deleteLabel={isMultiSelected ? `Delete ${menuTargetIds.length} layers` : 'Delete layer'}
        onEditPath={() => onRequestEditPath(layer.id)}
        showGroupSelection={canGroupSelection}
        onGroupSelected={onGroupSelected}
        showUngroup={false}
        onUngroup={() => {}}
        moveTargets={moveTargets}
        onMoveTo={(targetGroupId) => onMoveTo(menuTargetIds, targetGroupId)}
      />
    </ContextMenuPortal>
    </ContextMenu>
  );
});
