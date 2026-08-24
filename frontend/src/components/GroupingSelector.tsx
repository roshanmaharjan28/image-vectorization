import type { GroupingMode } from '../types';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

interface Props {
  value: GroupingMode;
  onChange: (mode: GroupingMode) => void;
  disabled: boolean;
}

const OPTIONS: { label: string; value: GroupingMode }[] = [
  { label: 'None', value: 'none' },
  { label: 'OpenCV', value: 'opencv' },
  { label: 'FastSAM', value: 'fastsam' },
];

// Shown only for v1/v3 (see VectorizerPage.tsx's `showParams`) — the backend has no grouping
// support for v2. Chosen mode is sent as the `grouping` form field on the next vectorize call.
export function GroupingSelector({ value, onChange, disabled }: Props) {
  return (
    <aside className="absolute top-3 right-3 z-10 w-56 rounded-2xl bg-card p-3 shadow-lg shadow-black/30 ring-1 ring-foreground/10">
      <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Grouping</div>
      <ToggleGroup
        value={[value]}
        onValueChange={(next) => {
          if (next.length > 0) onChange(next[0] as GroupingMode);
        }}
        disabled={disabled}
        spacing={0}
        size="sm"
        variant="outline"
        className="w-full"
      >
        {OPTIONS.map((opt) => (
          <ToggleGroupItem key={opt.value} value={opt.value} className="flex-1 text-xs! font-semibold tracking-wide uppercase">
            {opt.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </aside>
  );
}
