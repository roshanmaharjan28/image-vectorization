import type { GroupNode, Layer, TreeNode } from '../types';

// Shared by LayerRow.tsx and GroupRow.tsx so indentation lines up exactly between the two.
export const ROW_BASE_PADDING_PX = 16; // matches LayerRow's original `px-4`
export const ROW_INDENT_PX = 16; // per depth level

interface LayerPanelRow {
  kind: 'layer';
  layer: Layer;
  depth: number;
  displayNumber: number; // "Layer N" label — stable regardless of grouping/collapse
}

interface GroupPanelRow {
  kind: 'group';
  id: string;
  label: string;
  depth: number;
  expanded: boolean;
  leafIds: string[]; // every descendant leaf's Layer.id, nested subgroups included
  allVisible: boolean; // AND of every descendant leaf's visibility — drives the eye icon state
}

export type PanelRow = LayerPanelRow | GroupPanelRow;

export function idsForRow(row: PanelRow): string[] {
  return row.kind === 'layer' ? [row.layer.id] : row.leafIds;
}

// Internal, pre-flatten representation: a tree that's been resolved against `layers`, had
// missing/deleted/duplicate leaves and now-empty groups dropped, and had each level's siblings
// sorted so "top of list = topmost/last-painted" holds recursively at every depth.
type CleanLeaf = { kind: 'leaf'; index: number; rank: number };
type CleanGroup = {
  kind: 'group';
  id: string;
  label: string;
  rank: number;
  children: CleanNode[];
  leafIds: string[];
  allVisible: boolean;
};
type CleanNode = CleanLeaf | CleanGroup;

function cleanAndSortNodes(nodes: TreeNode[], layers: Layer[], seen: Set<number>): CleanNode[] {
  const cleaned: CleanNode[] = [];

  for (const node of nodes) {
    if (node.type === 'leaf') {
      const layer = layers[node.index];
      if (!layer || layer.deleted) continue;
      // Defensive re-check of the "no duplicate leaf" invariant — never trusted blindly, even
      // though the backend already enforces it server-side.
      if (seen.has(node.index)) continue;
      seen.add(node.index);
      cleaned.push({ kind: 'leaf', index: node.index, rank: node.index });
      continue;
    }

    const children = cleanAndSortNodes(node.children, layers, seen);
    if (children.length === 0) continue; // an emptied-out group never renders a header row

    const leafIds: string[] = [];
    let allVisible = true;
    for (const child of children) {
      if (child.kind === 'leaf') {
        const leaf = layers[child.index];
        leafIds.push(leaf.id);
        if (!leaf.visible) allVisible = false;
      } else {
        leafIds.push(...child.leafIds);
        if (!child.allVisible) allVisible = false;
      }
    }

    const rank = Math.max(...children.map((c) => c.rank));
    const group = node as GroupNode;
    cleaned.push({
      kind: 'group',
      id: group.id,
      label: group.label ?? 'Group',
      rank,
      children,
      leafIds,
      allVisible,
    });
  }

  cleaned.sort((a, b) => b.rank - a.rank);
  return cleaned;
}

function flattenClean(
  nodes: CleanNode[],
  depth: number,
  collapsedGroupIds: Set<string>,
  displayNumberByIndex: Map<number, number>,
  layers: Layer[],
  out: PanelRow[],
): void {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      out.push({
        kind: 'layer',
        layer: layers[node.index],
        depth,
        displayNumber: displayNumberByIndex.get(node.index) ?? 0,
      });
      continue;
    }

    const expanded = !collapsedGroupIds.has(node.id);
    out.push({
      kind: 'group',
      id: node.id,
      label: node.label,
      depth,
      expanded,
      leafIds: node.leafIds,
      allVisible: node.allVisible,
    });
    if (expanded) {
      flattenClean(node.children, depth + 1, collapsedGroupIds, displayNumberByIndex, layers, out);
    }
  }
}

/** All group ids in the tree, recursively — used to seed "everything collapsed" as the default
 *  panel state right after a vectorize, since `collapsedGroupIds` is empty-set-means-expanded. */
export function collectGroupIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.type === 'leaf') continue;
    ids.push(node.id);
    ids.push(...collectGroupIds(node.children));
  }
  return ids;
}

/** Projects a (tree, layers, collapse-state) triple into the flat, virtualizable row list the
 *  layers panel renders. When `tree` is null (grouping off, or a request that never returns
 *  groups), this degrades to exactly today's `layers.filter(!deleted).reverse()` list:
 *  the backward-compatibility guarantee is structural, not incidental. */
export function buildPanelRows(
  tree: TreeNode[] | null,
  layers: Layer[],
  collapsedGroupIds: Set<string>,
): PanelRow[] {
  const displayNumberByIndex = new Map<number, number>();
  let running = 1;
  layers.forEach((layer, index) => {
    if (layer.deleted) return;
    displayNumberByIndex.set(index, running++);
  });

  if (!tree) {
    const rows: PanelRow[] = [];
    for (let index = layers.length - 1; index >= 0; index--) {
      const layer = layers[index];
      if (layer.deleted) continue;
      rows.push({ kind: 'layer', layer, depth: 0, displayNumber: displayNumberByIndex.get(index) ?? 0 });
    }
    return rows;
  }

  const seen = new Set<number>();
  const cleaned = cleanAndSortNodes(tree, layers, seen);

  // Completeness pass: any non-deleted layer the forest didn't cover becomes a bare top-level
  // leaf, so every layer is guaranteed to appear exactly once regardless of backend coverage.
  layers.forEach((layer, index) => {
    if (layer.deleted || seen.has(index)) return;
    cleaned.push({ kind: 'leaf', index, rank: index });
  });
  cleaned.sort((a, b) => b.rank - a.rank);

  const rows: PanelRow[] = [];
  flattenClean(cleaned, 0, collapsedGroupIds, displayNumberByIndex, layers, rows);
  return rows;
}

// Manually-created groups only ever need an id unique within this session's tree — no relation to
// (and no risk of colliding with) whatever id scheme the backend's FastSAM/OpenCV pass used.
let nextManualGroupId = 0;

export function collectLeafIndices(node: TreeNode): number[] {
  return node.type === 'leaf' ? [node.index] : node.children.flatMap(collectLeafIndices);
}

// Pulls every selected leaf out of `nodes` (recursively). A group that's only *partially*
// selected survives with its unselected children, and its selected children are hoisted
// individually into `extracted`. A group that's *fully* selected is hoisted as a single unit
// (unchanged), so grouping a whole existing group together with something else nests it rather
// than flattening it away.
function extractSelected(
  nodes: TreeNode[],
  selected: Set<number>,
): { remaining: TreeNode[]; extracted: TreeNode[] } {
  const remaining: TreeNode[] = [];
  const extracted: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'leaf') {
      (selected.has(node.index) ? extracted : remaining).push(node);
      continue;
    }
    const child = extractSelected(node.children, selected);
    if (child.extracted.length === 0) {
      remaining.push(node);
    } else if (child.remaining.length === 0) {
      extracted.push(node);
    } else {
      remaining.push({ ...node, children: child.remaining });
      extracted.push(...child.extracted);
    }
  }
  return { remaining, extracted };
}

/** Wraps every selected layer (and any wholly-selected existing group) into one new group at the
 *  root of the tree. Returns null if fewer than two distinct selection units end up inside it —
 *  either the caller passed in under two layers, or the selection was exactly one pre-existing
 *  whole group, in which case there's nothing new to group. */
export function groupSelectedLeaves(
  tree: TreeNode[] | null,
  layers: Layer[],
  selectedLayerIds: string[],
): { tree: TreeNode[]; groupId: string } | null {
  const idToIndex = new Map(layers.map((layer, index) => [layer.id, index]));
  const selected = new Set<number>();
  for (const id of selectedLayerIds) {
    const index = idToIndex.get(id);
    if (index !== undefined && !layers[index].deleted) selected.add(index);
  }
  if (selected.size < 2) return null;

  const workingTree = tree ?? layers.map((_, index) => ({ type: 'leaf' as const, index }));
  const { remaining, extracted } = extractSelected(workingTree, selected);
  if (extracted.length < 2) return null;

  nextManualGroupId += 1;
  const groupId = `manual-group-${nextManualGroupId}`;
  const newGroup: GroupNode = {
    type: 'group',
    id: groupId,
    label: `Group ${nextManualGroupId}`,
    children: extracted,
  };
  return { tree: [...remaining, newGroup], groupId };
}

// Dissolves every group in `nodes` whose entire leaf membership is selected, splicing its
// children into its former parent in its place. Only one nesting level disappears per matching
// group — a nested subgroup that isn't itself fully selected is left intact.
function ungroupIn(nodes: TreeNode[], selected: Set<number>): { nodes: TreeNode[]; changed: boolean } {
  const result: TreeNode[] = [];
  let changed = false;
  for (const node of nodes) {
    if (node.type === 'leaf') {
      result.push(node);
      continue;
    }
    const leafIndices = collectLeafIndices(node);
    const fullySelected = leafIndices.length > 0 && leafIndices.every((index) => selected.has(index));
    if (fullySelected) {
      result.push(...node.children);
      changed = true;
      continue;
    }
    const child = ungroupIn(node.children, selected);
    if (child.changed) {
      result.push({ ...node, children: child.nodes });
      changed = true;
    } else {
      result.push(node);
    }
  }
  return { nodes: result, changed };
}

/** Dissolves whichever selected group(s) are fully covered by the current selection. Returns null
 *  if nothing in the tree qualifies (e.g. the selection doesn't fully cover any single group). */
export function ungroupSelectedLeaves(
  tree: TreeNode[] | null,
  layers: Layer[],
  selectedLayerIds: string[],
): TreeNode[] | null {
  if (!tree) return null;
  const idToIndex = new Map(layers.map((layer, index) => [layer.id, index]));
  const selected = new Set<number>();
  for (const id of selectedLayerIds) {
    const index = idToIndex.get(id);
    if (index !== undefined) selected.add(index);
  }
  if (selected.size === 0) return null;

  const { nodes, changed } = ungroupIn(tree, selected);
  return changed ? nodes : null;
}

/** Dissolves one specific group (by id) wherever it appears in the tree, splicing its children
 *  into its former parent's position — independent of the current selection, unlike
 *  ungroupSelectedLeaves above. Used by a group row's context menu "Ungroup" action. */
export function ungroupGroupById(tree: TreeNode[] | null, groupId: string): TreeNode[] | null {
  if (!tree) return null;

  function walk(nodes: TreeNode[]): { nodes: TreeNode[]; changed: boolean } {
    const result: TreeNode[] = [];
    let changed = false;
    for (const node of nodes) {
      if (node.type === 'leaf') {
        result.push(node);
        continue;
      }
      if (node.id === groupId) {
        result.push(...node.children);
        changed = true;
        continue;
      }
      const child = walk(node.children);
      if (child.changed) {
        result.push({ ...node, children: child.nodes });
        changed = true;
      } else {
        result.push(node);
      }
    }
    return { nodes: result, changed };
  }

  const { nodes, changed } = walk(tree);
  return changed ? nodes : null;
}

export interface GroupOption {
  id: string;
  label: string;
  depth: number;
  leafIds: string[];
}

/** Flat list of every group in the tree (regardless of collapse state), each carrying its own
 *  resolved leaf Layer ids — feeds a context menu's "Move to" submenu, and (via
 *  filterMoveTargets) keeps a group from being offered as a target inside itself. */
export function listGroupOptions(tree: TreeNode[] | null, layers: Layer[]): GroupOption[] {
  if (!tree) return [];
  const out: GroupOption[] = [];

  function walk(nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      if (node.type === 'leaf') continue;
      const leafIds = collectLeafIndices(node)
        .map((index) => layers[index])
        .filter((layer): layer is Layer => Boolean(layer) && !layer.deleted)
        .map((layer) => layer.id);
      out.push({ id: node.id, label: node.label ?? 'Group', depth, leafIds });
      walk(node.children, depth + 1);
    }
  }

  walk(tree, 0);
  return out;
}

// Sentinel target id for "move to root" — distinct from any real group id (those come from the
// backend or nextManualGroupId above), so moveLeavesToGroup can tell the two apart.
export const ROOT_MOVE_TARGET_ID = '__root__';

/** For every leaf and group node in `tree`, the id of the node one level up from its *current*
 *  immediate parent — i.e. where "move up a level" should land it: a real group id if its parent
 *  is itself nested, ROOT_MOVE_TARGET_ID if its parent already sits at the top level, or no entry
 *  at all if the node has no parent to move out of (it's already at the top level). Feeds the
 *  context menu's pinned "Move to Root" / "Move to Parent Group" shortcut, which is otherwise just
 *  a `moveLeavesToGroup`/`moveLeavesToRoot` call to whichever id this map gives back. */
export function computeMoveUpTargets(
  tree: TreeNode[] | null,
  layers: Layer[],
): { leafTargets: Map<string, string>; groupTargets: Map<string, string> } {
  const leafTargets = new Map<string, string>();
  const groupTargets = new Map<string, string>();
  if (!tree) return { leafTargets, groupTargets };

  function targetFor(ancestorGroupIds: string[]): string | null {
    if (ancestorGroupIds.length === 0) return null;
    return ancestorGroupIds.length === 1 ? ROOT_MOVE_TARGET_ID : ancestorGroupIds[ancestorGroupIds.length - 2];
  }

  function walk(nodes: TreeNode[], ancestorGroupIds: string[]) {
    for (const node of nodes) {
      if (node.type === 'leaf') {
        const layer = layers[node.index];
        if (!layer || layer.deleted) continue;
        const target = targetFor(ancestorGroupIds);
        if (target) leafTargets.set(layer.id, target);
        continue;
      }
      const target = targetFor(ancestorGroupIds);
      if (target) groupTargets.set(node.id, target);
      walk(node.children, [...ancestorGroupIds, node.id]);
    }
  }

  walk(tree, []);
  return { leafTargets, groupTargets };
}

/** Human label for a "move up" shortcut target — "Move to Root" for the sentinel, otherwise the
 *  destination group's own name (falling back to a generic label if it's gone missing). */
export function moveUpTargetLabel(targetId: string, groupOptions: GroupOption[]): string {
  if (targetId === ROOT_MOVE_TARGET_ID) return 'Move to Root';
  const group = groupOptions.find((option) => option.id === targetId);
  return group ? `Move to "${group.label}"` : 'Move to Parent Group';
}

/** Removes from `options` any group that `leafIds` already fully constitutes — the row's own
 *  group (if it is one) and any of its nested subgroups — so a "Move to" submenu never offers to
 *  move a group into itself or one of its own descendants. An emptied-out group (no leaves left)
 *  is never excluded by this check, since "every id of an empty set" is vacuously true. */
export function filterMoveTargets(options: GroupOption[], leafIds: string[]): GroupOption[] {
  const leafSet = new Set(leafIds);
  return options.filter((option) => option.leafIds.length === 0 || !option.leafIds.every((id) => leafSet.has(id)));
}

/** Moves `leafIds` (and, if they wholly constitute an existing group, that group as a single
 *  nested unit) out of wherever they currently sit in the tree and appends them as children of
 *  `targetGroupId` — or, if `targetGroupId` is `ROOT_MOVE_TARGET_ID`, straight to the top level of
 *  the tree. Returns null if nothing was selected, or if `targetGroupId` can't be found after
 *  removal (e.g. a stale id from a since-dissolved group). */
export function moveLeavesToGroup(
  tree: TreeNode[] | null,
  layers: Layer[],
  leafIds: string[],
  targetGroupId: string,
): TreeNode[] | null {
  const idToIndex = new Map(layers.map((layer, index) => [layer.id, index]));
  const selected = new Set<number>();
  for (const id of leafIds) {
    const index = idToIndex.get(id);
    if (index !== undefined && !layers[index].deleted) selected.add(index);
  }
  if (selected.size === 0) return null;

  const workingTree = tree ?? layers.map((_, index) => ({ type: 'leaf' as const, index }));
  const { remaining, extracted } = extractSelected(workingTree, selected);
  if (extracted.length === 0) return null;

  if (targetGroupId === ROOT_MOVE_TARGET_ID) return [...remaining, ...extracted];

  let inserted = false;
  function insertInto(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((node) => {
      if (node.type === 'leaf') return node;
      if (node.id === targetGroupId) {
        inserted = true;
        return { ...node, children: [...node.children, ...extracted] };
      }
      return { ...node, children: insertInto(node.children) };
    });
  }

  const nextTree = insertInto(remaining);
  return inserted ? nextTree : null;
}
