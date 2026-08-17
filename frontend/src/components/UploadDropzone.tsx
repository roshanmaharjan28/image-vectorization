import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { Card } from './ui/card';
import { cn } from '../lib/utils';

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
    <Card
      className={cn(
        'w-105 max-w-[90vw] cursor-pointer items-center border-2 border-dashed border-border py-12 text-center text-muted-foreground ring-0 hover:border-primary hover:text-foreground',
        isDragging && 'border-primary text-foreground',
      )}
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
      <Upload className="mb-3 size-8 text-primary" />
      <p className="mb-1.5 text-base text-foreground">Drop an image here, or click to browse</p>
      <p className="text-sm">PNG, JPG, BMP or GIF</p>
    </Card>
  );
}
