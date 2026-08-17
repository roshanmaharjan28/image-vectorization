import { memo, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import type { Layer, SvgMeta } from '../types';
import { layerToPathMarkup } from '../lib/svgSerialize';
import { normalizeColorToHex } from '../lib/sceneBuilder';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

interface Props {
  layer: Layer;
  index: number;
  meta: SvgMeta | null;
  isHovered: boolean;
  isSelected: boolean;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHover: (id: string | null) => void;
  onRowClick: (id: string, e: ReactMouseEvent) => void;
  onChangeColor: (id: string, hex: string) => void;
}

export const LayerRow = memo(function LayerRow({
  layer,
  index,
  meta,
  isHovered,
  isSelected,
  onToggleVisible,
  onDelete,
  onHover,
  onRowClick,
  onChangeColor,
}: Props) {
  const thumbRef = useRef<SVGSVGElement>(null);
  const [thumbViewBox, setThumbViewBox] = useState<string | null>(null);

  useEffect(() => {
    if (!meta) return;
    const path = thumbRef.current?.querySelector('path');
    if (!path) return;
    try {
      const bbox = path.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const pad = Math.max(bbox.width, bbox.height) * 0.08;
        setThumbViewBox(`${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
      } else {
        setThumbViewBox(meta.viewBox);
      }
    } catch {
      setThumbViewBox(meta.viewBox);
    }
  }, [layer, meta]);

  return (
    <div
      className={cn(
        'box-border flex h-full items-center gap-2.5 border-b border-border px-4',
        !layer.visible && 'opacity-45',
        isHovered && 'bg-muted',
        isSelected && 'bg-muted shadow-[inset_3px_0_0_var(--primary)]',
      )}
      onMouseEnter={() => onHover(layer.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => onRowClick(layer.id, e)}
    >
      <input
        type="color"
        className="size-4.5 shrink-0 cursor-pointer rounded-xs border border-border bg-none p-0 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
        title="Change layer color"
        value={normalizeColorToHex(layer.fill)}
        onChange={(e) => onChangeColor(layer.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
      {meta ? (
        <svg
          ref={thumbRef}
          className="size-7 shrink-0 rounded-xs border border-border bg-[#f2f2f2]"
          viewBox={thumbViewBox ?? meta.viewBox}
          preserveAspectRatio="xMidYMid meet"
          dangerouslySetInnerHTML={{ __html: layerToPathMarkup(layer) }}
        />
      ) : (
        <span className="size-7 shrink-0 rounded-xs border border-border" style={{ backgroundColor: layer.fill }} />
      )}
      <span className="flex-1 truncate text-sm">Layer {index}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        title={layer.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible(layer.id);
        }}
      >
        {layer.visible ? <Eye /> : <EyeOff />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-destructive"
        title="Delete layer"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(layer.id);
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
});
