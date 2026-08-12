import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';

interface Props {
  onSelect: (file: File) => void;
}

export function UploadDropzone({ onSelect }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file && file.type.startsWith('image/')) {
      onSelect(file);
    }
  }

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/bmp,image/gif"
        hidden
        onChange={(e: ChangeEvent<HTMLInputElement>) => handleFiles(e.target.files)}
      />
      <div className="dropzone__icon">+</div>
      <p className="dropzone__title">Drop an image here, or click to browse</p>
      <p className="dropzone__hint">PNG, JPG, BMP or GIF</p>
    </div>
  );
}
