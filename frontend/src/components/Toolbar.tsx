import type { Stage } from '../types';

interface Props {
  stage: Stage;
  fileName?: string;
  onVectorize: () => void;
  onDownload: () => void;
  onReset: () => void;
}

export function Toolbar({ stage, fileName, onVectorize, onDownload, onReset }: Props) {
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
          <button type="button" className="btn" onClick={onDownload}>
            Download SVG
          </button>
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
