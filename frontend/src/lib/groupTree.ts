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

/** Projects a (tree, layers, collapse-state) triple into the flat, virtualizable row list the
 *  layers panel renders. When `tree` is null (grouping off, or a pipeline — v2 — that never
 *  returns groups), this degrades to exactly today's `layers.filter(!deleted).reverse()` list:
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
