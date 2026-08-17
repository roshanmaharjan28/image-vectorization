import { Download, Hand, Loader2, MousePointer2, PenTool, Upload, Wand2 } from 'lucide-react';
import type { Stage, Tool } from '../types';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

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
  tool: Tool;
  onToolChange: (tool: Tool) => void;
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
  tool,
  onToolChange,
}: Props) {
  return (
    <header className="relative flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
      <div className="font-heading font-semibold tracking-wide">Vectorizer</div>
      {fileName && <div className="truncate text-sm text-muted-foreground">{fileName}</div>}
      {stage !== 'empty' && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <ToggleGroup
            value={[tool]}
            onValueChange={(next) => {
              if (next.length > 0) onToolChange(next[0] as Tool);
            }}
            spacing={0}
            size="sm"
            variant="outline"
          >
            <ToggleGroupItem value="cursor" aria-label="Selection tool">
              <MousePointer2 />
            </ToggleGroupItem>
            <ToggleGroupItem value="hand" aria-label="Hand tool">
              <Hand />
            </ToggleGroupItem>
            <ToggleGroupItem value="pen" aria-label="Pen tool">
              <PenTool />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}
      <div className="ml-auto flex items-center gap-3">
        {stage === 'has-image' && (
          <Button size="sm" className="text-sm!" onClick={onVectorize}>
            <Wand2 />
            Vectorize
          </Button>
        )}
        {stage === 'vectorizing' && (
          <Button size="sm" className="text-sm!" disabled>
            <Loader2 className="animate-spin" />
            Vectorizing…
          </Button>
        )}
        {stage === 'vectorized' && (
          <>
            {/* Adobe Image Trace-style "Preview" toggle: swaps the traced result for the
                original source bitmap without discarding the vectorized layers. */}
            <div className="flex items-center gap-2">
              <Switch id="show-original" checked={showOriginal} onCheckedChange={onToggleShowOriginal} />
              <Label htmlFor="show-original" className="cursor-pointer text-muted-foreground">
                Show original
              </Label>
            </div>
            {/* Adobe Illustrator "Outline" view: every path drawn as a black stroke on a plain
                white page, ignoring fill colors — for checking path quality independent of color. */}
            <div className="flex items-center gap-2">
              <Switch id="show-paths" checked={showPaths} onCheckedChange={onToggleShowPaths} />
              <Label htmlFor="show-paths" className="cursor-pointer text-muted-foreground">
                Show paths
              </Label>
            </div>
            <Separator orientation="vertical" className="h-6" />
            <Button size="sm" className="text-sm!" variant="outline" onClick={onDownload}>
              <Download />
              Download SVG
            </Button>
          </>
        )}
        {stage !== 'empty' && (
          <Button size="sm" className="text-sm!" variant="ghost" onClick={onReset}>
            <Upload />
            Upload new image
          </Button>
        )}
      </div>
    </header>
  );
}
