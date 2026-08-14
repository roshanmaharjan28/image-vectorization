import type { Stage } from '../types';

interface Props {
  stage: Stage;
  fileName?: string;
  onVectorize: () => void;
  onDownload: () => void;
  onReset: () => void;
  showOriginal: boolean;
  onToggleShowOriginal: () => void;
  showPaths: boolean;
  onToggleShowPaths: () => void;
}

export function Toolbar({
  stage,
  fileName,
  onVectorize,
  onDownload,
  onReset,
  showOriginal,
  onToggleShowOriginal,
  showPaths,
  onToggleShowPaths,
}: Props) {
  return (
    <header className="toolbar">
      <div className="toolbar__brand">Vectorizer</div>
      {fileName && <div className="toolbar__filename">{fileName}</div>}
      <div className="toolbar__actions">
        {stage === 'has-image' && (
          <button type="button" className="btn btn--primary" onClick={onVectorize}>
            Vectorize
          </button>
        )}
        {stage === 'vectorizing' && (
          <button type="button" className="btn btn--primary" disabled>
            Vectorizing…
          </button>
        )}
        {stage === 'vectorized' && (
          <>
            {/* Adobe Image Trace-style "Preview" checkbox: swaps the traced result for the
                original source bitmap without discarding the vectorized layers. */}
            <label className="toolbar__toggle">
              <input type="checkbox" checked={showOriginal} onChange={onToggleShowOriginal} />
              Show original
            </label>
            {/* Adobe Illustrator "Outline" view: every path drawn as a black stroke on a plain
                white page, ignoring fill colors — for checking path quality independent of color. */}
            <label className="toolbar__toggle">
              <input type="checkbox" checked={showPaths} onChange={onToggleShowPaths} />
              Show paths
            </label>
            <button type="button" className="btn" onClick={onDownload}>
              Download SVG
            </button>
          </>
        )}
        {stage !== 'empty' && (
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            Upload new image
          </button>
        )}
      </div>
    </header>
  );
}
