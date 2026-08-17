import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { UploadDropzone } from '../components/UploadDropzone';
import { Toolbar } from '../components/Toolbar';
// Canvas.tsx (SVG/DOM renderer) is kept around, just swapped out here — CanvasGL.tsx is an
// experimental WebGL2 renderer, see its file header for how it differs.
// import { Canvas } from '../components/Canvas';
// import { CanvasGL } from '../components/CanvasGL';
import { LayersPanel } from '../components/LayersPanel';
import { ParamsPanel } from '../components/ParamsPanel';
import { parseSvgToLayers } from '../lib/svgParse';
import { buildSvgString, setLayerFill } from '../lib/svgSerialize';
import { appendVectorizeParams, DEFAULT_V1_PARAMS, DEFAULT_V3_PARAMS } from '../lib/vectorizeParams';
import type { Layer, Stage, SvgMeta, Tool, VectorizeParams } from '../types';
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
  // v1 (raw vtracer call) and v3 (preprocess + vtracer) both expose tunable
  // vtracer params; v2 doesn't use vtracer at all.
  const showParams = !apiEndpoint.includes('/v2/');
  const isV3 = apiEndpoint.includes('/v3/');
  const [stage, setStage] = useState<Stage>('empty');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<SvgMeta | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  const [params, setParams] = useState<VectorizeParams>(isV3 ? DEFAULT_V3_PARAMS : DEFAULT_V1_PARAMS);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('none');
  const [tool, setTool] = useState<Tool>('cursor');

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
      if (showParams) appendVectorizeParams(formData, params);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}${apiEndpoint}`, { method: 'POST', body: formData });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Request failed with status ${res.status}`);
      }

      const data: { svg: string } = await res.json();
      const parsed = parseSvgToLayers(data.svg);
      setMeta(parsed.meta);
      setLayers(parsed.layers);
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

  function handleDownload() {
    if (!meta) return;
    const svgString = buildSvgString(meta, layers);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${imageFile?.name.replace(/\.[^.]+$/, '') || 'vectorized'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleReset() {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(null);
    setImageUrl(null);
    setMeta(null);
    setLayers([]);
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
          />
          {showParams && (
            <ParamsPanel
              params={params}
              onChange={handleParamsChange}
              onRevectorize={handleVectorize}
              canRevectorize={Boolean(imageFile)}
              isVectorizing={stage === 'vectorizing'}
            />
          )}
        </div>
        <LayersPanel
          layers={layers}
          meta={meta}
          hoveredLayerId={hoveredLayerId}
          selectedLayerIds={selectedLayerIds}
          onToggleVisible={handleToggleVisible}
          onDelete={handleDeleteLayer}
          onHoverLayer={setHoveredLayerId}
          onSelectLayer={handleSelectLayer}
          onChangeColor={handleChangeColor}
        />
      </div>
    </div>
  );
}
