import { useCallback, useState } from 'react';
import { UploadDropzone } from '../components/UploadDropzone';
import { Toolbar } from '../components/Toolbar';
import { Canvas } from '../components/Canvas';
import { LayersPanel } from '../components/LayersPanel';
import { parseSvgToLayers } from '../lib/svgParse';
import { buildSvgString } from '../lib/svgSerialize';
import type { Layer, Stage, SvgMeta } from '../types';
import '../App.css';

interface VectorizerPageProps {
  apiEndpoint: string;
}

export function VectorizerPage({ apiEndpoint }: VectorizerPageProps) {
  const [stage, setStage] = useState<Stage>('empty');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<SvgMeta | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);

  function handleImageSelected(file: File) {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(file);
    setImageUrl(URL.createObjectURL(file));
    setMeta(null);
    setLayers([]);
    setError(null);
    setStage('has-image');
  }

  async function handleVectorize() {
    if (!imageFile) return;
    setStage('vectorizing');
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', imageFile);
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

  const handleToggleVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  const handleDeleteLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
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
      />
      <div className="app__body">
        <Canvas
          imageUrl={imageUrl}
          meta={meta}
          layers={layers}
          hoveredLayerId={hoveredLayerId}
          onHoverLayer={setHoveredLayerId}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
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
