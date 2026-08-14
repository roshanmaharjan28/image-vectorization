import { useCallback, useState } from 'react';
import { UploadDropzone } from '../components/UploadDropzone';
import { Toolbar } from '../components/Toolbar';
// Canvas.tsx (SVG/DOM renderer) is kept around, just swapped out here — CanvasGL.tsx is an
// experimental WebGL2 renderer, see its file header for how it differs.
// import { Canvas } from '../components/Canvas';
// import { CanvasGL } from '../components/CanvasGL';
import { LayersPanel } from '../components/LayersPanel';
import { ParamsPanel } from '../components/ParamsPanel';
import { parseSvgToLayers } from '../lib/svgParse';
import { buildSvgString } from '../lib/svgSerialize';
import { appendVectorizeParams, DEFAULT_V1_PARAMS, DEFAULT_V3_PARAMS } from '../lib/vectorizeParams';
import type { Layer, Stage, SvgMeta, VectorizeParams } from '../types';
import '../App.css';
import { CanvasGL } from '../components/CanvasGL';

interface VectorizerPageProps {
  apiEndpoint: string;
}

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
  const [error, setError] = useState<string | null>(null);
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [params, setParams] = useState<VectorizeParams>(isV3 ? DEFAULT_V3_PARAMS : DEFAULT_V1_PARAMS);
  // Mutually exclusive canvas overlay modes: original swaps in the source bitmap, paths shows
  // every traced edge in black on white (Illustrator's Outline view) — see CanvasGL.tsx.
  const [showOriginal, setShowOriginal] = useState(false);
  const [showPaths, setShowPaths] = useState(false);

  function handleToggleShowOriginal() {
    setShowOriginal((v) => {
      const next = !v;
      if (next) setShowPaths(false);
      return next;
    });
  }

  function handleToggleShowPaths() {
    setShowPaths((v) => {
      const next = !v;
      if (next) setShowOriginal(false);
      return next;
    });
  }

  function handleImageSelected(file: File) {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(file);
    setImageUrl(URL.createObjectURL(file));
    setMeta(null);
    setLayers([]);
    setError(null);
    setShowOriginal(false);
    setShowPaths(false);
    setStage('has-image');
  }

  async function handleVectorize() {
    if (!imageFile) return;
    setStage('vectorizing');
    setError(null);
    setShowOriginal(false);
    setShowPaths(false);

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
      setError(err instanceof Error ? err.message : 'Vectorization failed');
      setStage('has-image');
    }
  }

  const handleParamsChange = useCallback((patch: Partial<VectorizeParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
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
    setError(null);
    setShowOriginal(false);
    setShowPaths(false);
    setStage('empty');
  }

  if (stage === 'empty') {
    return (
      <div className="app app--empty">
        <UploadDropzone onSelect={handleImageSelected} />
      </div>
    );
  }

  return (
    <div className="app">
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
      />
      <div className="app__body">
        {showParams && (
          <ParamsPanel
            params={params}
            onChange={handleParamsChange}
            onRevectorize={handleVectorize}
            canRevectorize={Boolean(imageFile)}
            isVectorizing={stage === 'vectorizing'}
          />
        )}
        <CanvasGL
          imageUrl={imageUrl}
          meta={meta}
          layers={layers}
          hoveredLayerId={hoveredLayerId}
          onHoverLayer={setHoveredLayerId}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
          showOriginal={showOriginal}
          showPaths={showPaths}
        />
        <LayersPanel
          layers={layers}
          meta={meta}
          hoveredLayerId={hoveredLayerId}
          selectedLayerId={selectedLayerId}
          onToggleVisible={handleToggleVisible}
          onDelete={handleDeleteLayer}
          onHoverLayer={setHoveredLayerId}
        />
      </div>
      {error && <div className="toast toast--error">{error}</div>}
    </div>
  );
}
