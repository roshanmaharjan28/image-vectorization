import { memo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight, Download, Eye, EyeOff, Trash2 } from 'lucide-react';
import { ROW_BASE_PADDING_PX, ROW_INDENT_PX } from '../lib/groupTree';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

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
}: Props) {
  return (
    <div
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
      <span className="flex-1 truncate text-sm font-medium">{label}</span>
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
    </div>
  );
});
