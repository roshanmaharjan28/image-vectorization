import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import type { VectorizeParams } from '../types';
import { Accordion, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Slider } from './ui/slider';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

interface Props {
  params: VectorizeParams;
  onChange: (patch: Partial<VectorizeParams>) => void;
  onRevectorize: () => void;
  canRevectorize: boolean;
  isVectorizing: boolean;
}

interface Option<T extends string> {
  label: string;
  value: T;
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        if (next.length > 0) onChange(next[0] as T);
      }}
      disabled={disabled}
      spacing={0}
      size={"sm"}
      variant="outline"
      className="mb-3.5 w-full"
    >
      {options.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value} className="flex-1 text-xs! font-semibold tracking-wide uppercase">
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 text-xs">
        {label} <span className="text-muted-foreground">({hint})</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="w-6.5 shrink-0 text-right text-sm text-muted-foreground">{value}</span>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          disabled={disabled}
          onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        />
      </div>
    </div>
  );
}

export function ParamsPanel({ params, onChange, onRevectorize, canRevectorize, isVectorizing }: Props) {
  const disabled = isVectorizing;

  return (
    <aside className="absolute top-3 left-3 z-10 flex max-h-[calc(100%-1.5rem)] w-72 flex-col">
      <Accordion
        defaultValue={['vectorize-settings']}
        className="flex flex-col gap-0 overflow-hidden rounded-2xl border-0 bg-card shadow-lg shadow-black/30 ring-1 ring-foreground/10 has-[[data-open]]:min-h-0 has-[[data-open]]:flex-1"
      >
        <AccordionItem
          value="vectorize-settings"
          className="flex flex-col border-0 bg-transparent data-open:min-h-0 data-open:flex-1 data-open:bg-transparent"
        >
          <AccordionTrigger className="shrink-0 p-4 pb-3.5 text-sm! items-center font-semibold tracking-wide hover:no-underline">
            Vectorize Settings
          </AccordionTrigger>
          <AccordionPrimitive.Panel className="flex min-h-0 flex-1 flex-col overflow-hidden data-closed:hidden">
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 pb-4">
                <div className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Clustering</div>
                <SegmentedControl
                  value={params.colormode}
                  options={[
                    { label: 'B/W', value: 'binary' },
                    { label: 'Color', value: 'color' },
                  ]}
                  onChange={(v) => onChange({ colormode: v })}
                  disabled={disabled}
                />
                <SegmentedControl
                  value={params.hierarchical}
                  options={[
                    { label: 'Cutout', value: 'cutout' },
                    { label: 'Stacked', value: 'stacked' },
                  ]}
                  onChange={(v) => onChange({ hierarchical: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Filter Speckle"
                  hint="Cleaner"
                  value={params.filterSpeckle}
                  min={0}
                  max={50}
                  step={1}
                  onChange={(v) => onChange({ filterSpeckle: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Color Precision"
                  hint="More accurate"
                  value={params.colorPrecision}
                  min={1}
                  max={8}
                  step={1}
                  onChange={(v) => onChange({ colorPrecision: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Gradient Step"
                  hint="Less layers"
                  value={params.layerDifference}
                  min={0}
                  max={255}
                  step={1}
                  onChange={(v) => onChange({ layerDifference: v })}
                  disabled={disabled}
                />

                <div className="mt-2 mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Curve Fitting</div>
                <SegmentedControl
                  value={params.mode}
                  options={[
                    { label: 'Pixel', value: 'none' },
                    { label: 'Polygon', value: 'polygon' },
                    { label: 'Spline', value: 'spline' },
                  ]}
                  onChange={(v) => onChange({ mode: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Corner Threshold"
                  hint="Smoother"
                  value={params.cornerThreshold}
                  min={0}
                  max={180}
                  step={1}
                  onChange={(v) => onChange({ cornerThreshold: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Segment Length"
                  hint="More coarse"
                  value={params.lengthThreshold}
                  min={3.5}
                  max={10}
                  step={0.5}
                  onChange={(v) => onChange({ lengthThreshold: v })}
                  disabled={disabled}
                />
                <SliderField
                  label="Splice Threshold"
                  hint="Less accurate"
                  value={params.spliceThreshold}
                  min={0}
                  max={180}
                  step={1}
                  onChange={(v) => onChange({ spliceThreshold: v })}
                  disabled={disabled}
                />
              </div>
            </ScrollArea>
            <div className="shrink-0 p-4 pt-3">
              <Button
                size="lg"
                className="w-full rounded-xl"
                onClick={onRevectorize}
                disabled={disabled || !canRevectorize}
              >
                {isVectorizing ? 'Vectorizing…' : 'Re-vectorize'}
              </Button>
            </div>
          </AccordionPrimitive.Panel>
        </AccordionItem>
      </Accordion>
    </aside>
  );
}
