import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { UploadDropzone } from '../components/UploadDropzone';
import { Toolbar } from '../components/Toolbar';
// Canvas.tsx (SVG/DOM renderer) is kept around, just swapped out here — CanvasGL.tsx is an
// experimental WebGL2 renderer, see its file header for how it differs.
// import { Canvas } from '../components/Canvas';
// import { CanvasGL } from '../components/CanvasGL';
import { LayersPanel } from '../components/LayersPanel';
import { ParamsPanel } from '../components/ParamsPanel';
import { GroupingSelector } from '../components/GroupingSelector';
import { parseSvgToLayers } from '../lib/svgParse';
import {
  collectGroupIds,
  computeMoveUpTargets,
  groupSelectedLeaves,
  listGroupOptions,
  moveLeavesToGroup,
  ungroupGroupById,
  ungroupSelectedLeaves,
} from '../lib/groupTree';
import { buildGroupSvgString, buildSvgString, setLayerFill } from '../lib/svgSerialize';
import { appendVectorizeParams, DEFAULT_V1_PARAMS, DEFAULT_V3_PARAMS } from '../lib/vectorizeParams';
import { downloadTextFile } from '../lib/download';
import type { GroupingMode, Layer, Stage, SvgMeta, Tool, TreeNode, VectorizeParams } from '../types';
import '../App.css';
import { CanvasGL } from '../components/CanvasGL';

interface VectorizerPageProps {
  apiEndpoint: string;
}

// The canvas overlay is one of three mutually exclusive states — the plain traced result, the
// original source bitmap ("Preview" in Adobe Image Trace), or the black-on-white path outline
// ("Outline" view in Illustrator) — modeled as a single value instead of two booleans so turning
// one on can't leave the other on too.
type OverlayMode = 'none' | 'original' | 'paths';

export function VectorizerPage({ apiEndpoint }: VectorizerPageProps) {
  const isV3 = apiEndpoint.includes('/v3/');
  const [stage, setStage] = useState<Stage>('empty');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<SvgMeta | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [groupTree, setGroupTree] = useState<TreeNode[] | null>(null);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<GroupingMode>('none');
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  const [params, setParams] = useState<VectorizeParams>(isV3 ? DEFAULT_V3_PARAMS : DEFAULT_V1_PARAMS);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('none');
  const [tool, setTool] = useState<Tool>('cursor');
  // Set by a LayersPanel row's "Edit path" context menu action — CanvasGL consumes it (entering
  // path-edit for that layer) and immediately clears it via handleEditPathRequestHandled.
  const [editPathRequestId, setEditPathRequestId] = useState<string | null>(null);
  const groupOptions = useMemo(() => listGroupOptions(groupTree, layers), [groupTree, layers]);
  const moveUpTargets = useMemo(() => computeMoveUpTargets(groupTree, layers), [groupTree, layers]);

  function handleToggleShowOriginal() {
    setOverlayMode((mode) => (mode === 'original' ? 'none' : 'original'));
  }

  function handleToggleShowPaths() {
    setOverlayMode((mode) => (mode === 'paths' ? 'none' : 'paths'));
  }

  function handleImageSelected(file: File) {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(file);
    setImageUrl(URL.createObjectURL(file));
    setMeta(null);
    setLayers([]);
    setGroupTree(null);
    setCollapsedGroupIds(new Set());
    setOverlayMode('none');
    setStage('has-image');
  }

  async function handleVectorize() {
    if (!imageFile) return;
    setStage('vectorizing');
    setOverlayMode('none');

    try {
      const formData = new FormData();
      formData.append('image', imageFile);
      appendVectorizeParams(formData, params);
      formData.append('grouping', grouping);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}${apiEndpoint}`, { method: 'POST', body: formData });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Request failed with status ${res.status}`);
      }

      const data: { svg: string; groups?: TreeNode[] | null } = await res.json();
      const parsed = parseSvgToLayers(data.svg);
      setMeta(parsed.meta);
      setLayers(parsed.layers);
      setGroupTree(data.groups ?? null);
      // Groups start collapsed rather than expanded, so a freshly vectorized image opens on the
      // grouped overview instead of one giant flat/expanded layer list.
      setCollapsedGroupIds(data.groups ? new Set(collectGroupIds(data.groups)) : new Set());
      setStage('vectorized');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Vectorization failed');
      setStage('has-image');
    }
  }

  const handleParamsChange = useCallback((patch: Partial<VectorizeParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelectLayer = useCallback((ids: string[], mode: 'replace' | 'add' | 'toggle') => {
    setSelectedLayerIds((prev) => {
      if (mode === 'replace') return ids;
      if (mode === 'add') return Array.from(new Set([...prev, ...ids]));
      const next = new Set(prev);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return Array.from(next);
    });
  }, []);

  // Recolors every selected layer at once when the edited swatch belongs to a multi-layer
  // selection, otherwise just the one layer whose swatch was clicked.
  const handleChangeColor = useCallback(
    (id: string, hex: string) => {
      setLayers((prev) => {
        const targets = selectedLayerIds.length > 1 && selectedLayerIds.includes(id) ? new Set(selectedLayerIds) : new Set([id]);
        return prev.map((layer) => (targets.has(layer.id) ? setLayerFill(layer, hex) : layer));
      });
    },
    [selectedLayerIds],
  );

  // Full-array replace from CanvasGL's gizmo drag (move/scale/rotate) — same shape as any other
  // layer edit, so it flows through the existing per-layer diff effects in CanvasGL.
  const handleTransformLayers = useCallback((next: Layer[]) => {
    setLayers(next);
  }, []);

  const handleToggleVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  // Soft-delete: flips a flag instead of shrinking the array, so it's exactly
  // as cheap as toggling visibility and never forces Canvas to rebuild its
  // path list (see Canvas.tsx's pathsMarkup memo).
  const handleDeleteLayer = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: false, deleted: true } : l)));
  }, []);

  // Batch versions of the two setters above, used by a group row's eye/trash actions (which
  // cascade to every descendant leaf, nested subgroups included) — also reusable unchanged by a
  // future manual multi-select "hide/delete selection" action.
  const handleSetVisibleMany = useCallback((ids: string[], visible: boolean) => {
    setLayers((prev) => {
      const idSet = new Set(ids);
      return prev.map((l) => (idSet.has(l.id) ? { ...l, visible } : l));
    });
  }, []);

  const handleDeleteMany = useCallback((ids: string[]) => {
    setLayers((prev) => {
      const idSet = new Set(ids);
      return prev.map((l) => (idSet.has(l.id) ? { ...l, visible: false, deleted: true } : l));
    });
  }, []);

  // Lets the Delete/Backspace key do the same thing as the trash icon for whatever's currently
  // selected. Skipped while a text field (group rename, color hex, etc.) has focus, so deleting a
  // character in one of those inputs doesn't also delete the selected layers.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (selectedLayerIds.length === 0) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      handleDeleteMany(selectedLayerIds);
      setSelectedLayerIds([]);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedLayerIds, handleDeleteMany]);

  const handleToggleGroupCollapsed = useCallback((id: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Wraps the current selection in a new group (Ctrl/Cmd+G or the panel's Group button). A no-op
  // (with a toast) when the selection doesn't amount to at least two distinct groupable units.
  const handleGroupSelected = useCallback(() => {
    if (selectedLayerIds.length === 0) return;
    const result = groupSelectedLeaves(groupTree, layers, selectedLayerIds);
    if (!result) {
      toast.error('Select at least 2 layers to group');
      return;
    }
    setGroupTree(result.tree);
  }, [groupTree, layers, selectedLayerIds]);

  // Dissolves whichever selected group(s) are fully covered by the selection (Ctrl/Cmd+Shift+G or
  // the panel's Ungroup button).
  const handleUngroupSelected = useCallback(() => {
    if (selectedLayerIds.length === 0) return;
    const next = ungroupSelectedLeaves(groupTree, layers, selectedLayerIds);
    if (!next) {
      toast.error('Select a group to ungroup');
      return;
    }
    setGroupTree(next);
  }, [groupTree, layers, selectedLayerIds]);

  // Dissolves one specific group regardless of the current selection — used by a group row's
  // "Ungroup" context menu action, as opposed to handleUngroupSelected above (Ctrl+Shift+G/panel
  // button), which only ever acts on whatever's currently selected.
  const handleUngroupGroup = useCallback(
    (groupId: string) => {
      const next = ungroupGroupById(groupTree, groupId);
      if (next) setGroupTree(next);
    },
    [groupTree],
  );

  // "Move to" context menu action — moves a layer or whole group into an existing target group,
  // independent of the current selection.
  const handleMoveToGroup = useCallback(
    (leafIds: string[], targetGroupId: string) => {
      const next = moveLeavesToGroup(groupTree, layers, leafIds, targetGroupId);
      if (next) setGroupTree(next);
    },
    [groupTree, layers],
  );

  // "Edit path" context menu action (panel or canvas) always switches to the cursor tool first —
  // path-edit anchors don't render under the hand tool (see CanvasGL), so this guarantees they're
  // visible regardless of which tool was active when the action was invoked.
  const handleRequestEditPath = useCallback((id: string) => {
    setTool('cursor');
    setEditPathRequestId(id);
  }, []);

  const handleEditPathRequestHandled = useCallback(() => {
    setEditPathRequestId(null);
  }, []);

  // Ctrl/Cmd+G groups the selection, Ctrl/Cmd+Shift+G ungroups it — same convention as
  // Illustrator/Figma/Sketch. Skipped while a text field has focus, same guard as Delete below.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'g' || !(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) handleUngroupSelected();
      else handleGroupSelected();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleGroupSelected, handleUngroupSelected]);

  const handleRenameGroup = useCallback((id: string, label: string) => {
    setGroupTree((prev) => {
      if (!prev) return prev;
      function renameIn(nodes: TreeNode[]): TreeNode[] {
        return nodes.map((node) => {
          if (node.type === 'leaf') return node;
          if (node.id === id) return { ...node, label };
          return { ...node, children: renameIn(node.children) };
        });
      }
      return renameIn(prev);
    });
  }, []);

  function handleDownload() {
    if (!meta) return;
    const svgString = buildSvgString(meta, layers);
    downloadTextFile(svgString, `${imageFile?.name.replace(/\.[^.]+$/, '') || 'vectorized'}.svg`);
  }

  const handleDownloadGroup = useCallback(
    (leafIds: string[], label: string) => {
      if (!meta) return;
      const idSet = new Set(leafIds);
      const subset = layers.filter((l) => idSet.has(l.id));
      const svgString = buildGroupSvgString(subset, meta);
      downloadTextFile(svgString, `${label.replace(/[^\w-]+/g, '_') || 'group'}.svg`);
    },
    [meta, layers],
  );

  function handleReset() {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(null);
    setImageUrl(null);
    setMeta(null);
    setLayers([]);
    setGroupTree(null);
    setCollapsedGroupIds(new Set());
    setOverlayMode('none');
    setStage('empty');
  }

  if (stage === 'empty') {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <UploadDropzone onSelect={handleImageSelected} />
      </div>
    );
  }

  const showOriginal = overlayMode === 'original';
  const showPaths = overlayMode === 'paths';

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        stage={stage}
        fileName={imageFile?.name}
        onVectorize={handleVectorize}
        onDownload={handleDownload}
        onReset={handleReset}
        showOriginal={showOriginal}
        onToggleShowOriginal={handleToggleShowOriginal}
        showPaths={showPaths}
        onToggleShowPaths={handleToggleShowPaths}
        tool={tool}
        onToolChange={setTool}
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 flex-1">
          <CanvasGL
            imageUrl={imageUrl}
            meta={meta}
            layers={layers}
            hoveredLayerId={hoveredLayerId}
            onHoverLayer={setHoveredLayerId}
            selectedLayerIds={selectedLayerIds}
            onSelectLayer={handleSelectLayer}
            onTransformLayers={handleTransformLayers}
            showOriginal={showOriginal}
            showPaths={showPaths}
            tool={tool}
            requestEditLayerId={editPathRequestId}
            onEditPathRequestHandled={handleEditPathRequestHandled}
            onSetVisibleMany={handleSetVisibleMany}
            onDeleteMany={handleDeleteMany}
            onDownloadLayers={handleDownloadGroup}
            onGroupSelected={handleGroupSelected}
            groupOptions={groupOptions}
            onMoveToGroup={handleMoveToGroup}
            moveUpTargets={moveUpTargets.leafTargets}
          />
          <GroupingSelector value={grouping} onChange={setGrouping} disabled={stage === 'vectorizing'} />
          <ParamsPanel
            params={params}
            onChange={handleParamsChange}
            onRevectorize={handleVectorize}
            canRevectorize={Boolean(imageFile)}
            isVectorizing={stage === 'vectorizing'}
          />
        </div>
        <LayersPanel
          layers={layers}
          meta={meta}
          groupTree={groupTree}
          collapsedGroupIds={collapsedGroupIds}
          hoveredLayerId={hoveredLayerId}
          selectedLayerIds={selectedLayerIds}
          onToggleVisible={handleToggleVisible}
          onDelete={handleDeleteLayer}
          onHoverLayer={setHoveredLayerId}
          onSelectLayer={handleSelectLayer}
          onChangeColor={handleChangeColor}
          onToggleGroupCollapsed={handleToggleGroupCollapsed}
          onRenameGroup={handleRenameGroup}
          onGroupSelected={handleGroupSelected}
          onUngroupSelected={handleUngroupSelected}
          onSetVisibleMany={handleSetVisibleMany}
          onDeleteMany={handleDeleteMany}
          onDownloadGroup={handleDownloadGroup}
          onUngroupGroup={handleUngroupGroup}
          onMoveToGroup={handleMoveToGroup}
          onRequestEditPath={handleRequestEditPath}
        />
      </div>
    </div>
  );
}
