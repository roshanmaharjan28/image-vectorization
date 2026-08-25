import { Download, Eye, EyeOff, FolderInput, Group, PenLine, Trash2, Ungroup } from 'lucide-react';
import type { GroupOption } from '../lib/groupTree';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from './ui/context-menu';

interface Props {
  visible: boolean;
  onToggleVisible: () => void;
  onDownload: () => void;
  downloadLabel: string;
  onDelete: () => void;
  deleteLabel: string;
  /** Omitted entirely for a group row — editing a single path only makes sense for one layer. */
  onEditPath?: () => void;
  showGroupSelection: boolean;
  onGroupSelected: () => void;
  /** True only for a group row — dissolves this specific group regardless of selection. */
  showUngroup: boolean;
  onUngroup: () => void;
  moveTargets: GroupOption[];
  onMoveTo: (targetGroupId: string) => void;
}

/** The `<ContextMenuContent>` shared by LayerRow, GroupRow, and CanvasGL's on-canvas right-click —
 *  same action set everywhere (edit path/hide/download/group/ungroup/move to/delete), just wired
 *  to whichever single layer or group the menu was opened on. */
export function LayerContextMenuItems({
  visible,
  onToggleVisible,
  onDownload,
  downloadLabel,
  onDelete,
  deleteLabel,
  onEditPath,
  showGroupSelection,
  onGroupSelected,
  showUngroup,
  onUngroup,
  moveTargets,
  onMoveTo,
}: Props) {
  return (
    <ContextMenuContent>
      {onEditPath && (
        <ContextMenuItem onClick={onEditPath}>
          <PenLine />
          Edit path
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={onToggleVisible}>
        {visible ? <EyeOff /> : <Eye />}
        {visible ? 'Hide' : 'Unhide'}
      </ContextMenuItem>
      <ContextMenuItem onClick={onDownload}>
        <Download />
        {downloadLabel}
      </ContextMenuItem>
      {(showGroupSelection || showUngroup || moveTargets.length > 0) && <ContextMenuSeparator />}
      {showGroupSelection && (
        <ContextMenuItem onClick={onGroupSelected}>
          <Group />
          Group selection
        </ContextMenuItem>
      )}
      {showUngroup && (
        <ContextMenuItem onClick={onUngroup}>
          <Ungroup />
          Ungroup
        </ContextMenuItem>
      )}
      {moveTargets.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput />
            Move to
          </ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent>
              {moveTargets.map((target) => (
                <ContextMenuItem
                  key={target.id}
                  style={{ paddingLeft: 12 + target.depth * 12 }}
                  onClick={() => onMoveTo(target.id)}
                >
                  {target.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        {deleteLabel}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
