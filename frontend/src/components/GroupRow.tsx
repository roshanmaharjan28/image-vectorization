import { memo, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight, Download, Eye, EyeOff, Trash2 } from 'lucide-react';
import {
  ROW_BASE_PADDING_PX,
  ROW_INDENT_PX,
  filterMoveTargets,
  moveUpTargetLabel,
  type GroupOption,
} from '../lib/groupTree';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import { ContextMenu, ContextMenuPortal, ContextMenuTrigger } from './ui/context-menu';
import { LayerContextMenuItems } from './LayerContextMenuItems';

interface Props {
  id: string;
  label: string;
  depth: number;
  rowIndex: number;
  expanded: boolean;
  memberCount: number;
  allVisible: boolean;
  isSelected: boolean;
  onToggleExpand: (id: string) => void;
  onSetVisible: (leafIds: string[], visible: boolean) => void;
  onDelete: (leafIds: string[]) => void;
  onDownload: (leafIds: string[], label: string) => void;
  onRowClick: (rowIndex: number, e: ReactMouseEvent) => void;
  leafIds: string[];
  isEditing: boolean;
  onStartRename: (id: string) => void;
  onRenameCommit: (id: string, label: string) => void;
  onRenameCancel: () => void;
  canGroupSelection: boolean;
  onGroupSelected: () => void;
  onUngroup: (groupId: string) => void;
  groupOptions: GroupOption[];
  onMoveTo: (leafIds: string[], targetGroupId: string) => void;
  /** This group's "move up a level" target id (a real group, or the root sentinel), keyed by
   *  group id — absent if the group is already at the top level. */
  moveUpTargets: Map<string, string>;
  selectedLayerIds: string[];
  selectionAllVisible: boolean;
}

export const GroupRow = memo(function GroupRow({
  id,
  label,
  depth,
  rowIndex,
  expanded,
  memberCount,
  allVisible,
  isSelected,
  onToggleExpand,
  onSetVisible,
  onDelete,
  onDownload,
  onRowClick,
  leafIds,
  isEditing,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  canGroupSelection,
  onGroupSelected,
  onUngroup,
  groupOptions,
  onMoveTo,
  moveUpTargets,
  selectedLayerIds,
  selectionAllVisible,
}: Props) {
  // A right-click inside an existing multi-selection acts on the whole selection, not just this
  // group's own members — mirrors the same rule in LayerRow.
  const isMultiSelected = isSelected && selectedLayerIds.length > 1;
  const menuTargetIds = isMultiSelected ? selectedLayerIds : leafIds;
  const menuVisible = isMultiSelected ? selectionAllVisible : allVisible;
  const moveTargets = filterMoveTargets(groupOptions, menuTargetIds);
  // Keyed by this group's own id (not its member leaves) — mirrors LayerRow, skipped when the
  // right-click acts on a broader multi-selection instead of this specific group.
  const moveUpId = isMultiSelected ? undefined : moveUpTargets.get(id);
  const moveUpTarget = moveUpId ? { id: moveUpId, label: moveUpTargetLabel(moveUpId, groupOptions) } : null;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  function commitRename() {
    onRenameCommit(id, inputRef.current?.value ?? label);
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRenameCancel();
    }
  }

  return (
    <ContextMenu>
    <ContextMenuTrigger
      className={cn(
        'box-border flex h-full items-center gap-2.5 border-b border-border pr-4',
        isSelected && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]',
      )}
      style={{ paddingLeft: ROW_BASE_PADDING_PX + depth * ROW_INDENT_PX }}
      onClick={(e) => onRowClick(rowIndex, e)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={expanded ? 'Collapse group' : 'Expand group'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand(id);
        }}
      >
        <ChevronRight className={cn('transition-transform', expanded && 'rotate-90')} />
      </Button>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={label}
          autoFocus
          className="min-w-0 flex-1 rounded-sm border border-primary bg-background px-1 py-0.5 text-sm font-medium outline-none"
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={handleInputKeyDown}
        />
      ) : (
        <span
          className="flex-1 truncate text-sm font-medium"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartRename(id);
          }}
        >
          {label}
        </span>
      )}
      <Badge variant="secondary" className="shrink-0">
        {memberCount}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        title={allVisible ? 'Hide group' : 'Show group'}
        onClick={(e) => {
          e.stopPropagation();
          onSetVisible(leafIds, !allVisible);
        }}
      >
        {allVisible ? <Eye /> : <EyeOff />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        title="Download group as SVG"
        onClick={(e) => {
          e.stopPropagation();
          onDownload(leafIds, label);
        }}
      >
        <Download />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-destructive"
        title="Delete group"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(leafIds);
        }}
      >
        <Trash2 />
      </Button>
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <LayerContextMenuItems
        visible={menuVisible}
        onToggleVisible={() => onSetVisible(menuTargetIds, !menuVisible)}
        onDownload={() => onDownload(menuTargetIds, isMultiSelected ? `${menuTargetIds.length} layers` : label)}
        downloadLabel={isMultiSelected ? `Download ${menuTargetIds.length} layers` : 'Download group'}
        onDelete={() => onDelete(menuTargetIds)}
        deleteLabel={isMultiSelected ? `Delete ${menuTargetIds.length} layers` : 'Delete group'}
        showGroupSelection={canGroupSelection}
        onGroupSelected={onGroupSelected}
        showUngroup={!isMultiSelected}
        onUngroup={() => onUngroup(id)}
        moveTargets={moveTargets}
        onMoveTo={(targetGroupId) => onMoveTo(menuTargetIds, targetGroupId)}
        moveUpTarget={moveUpTarget}
      />
    </ContextMenuPortal>
    </ContextMenu>
  );
});
