import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { CUSTOM_PRESET_ID, type MergeSameFill, type V2Params, type V2PresetInfo, type VectorizeParams } from '../types';
import { Accordion, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

interface Props {
  params: VectorizeParams;
  onChange: (patch: Partial<VectorizeParams>) => void;
  onRevectorize: () => void;
  canRevectorize: boolean;
  isVectorizing: boolean;
  /** v2 only, from GET /api/v2/presets. Empty until the fetch resolves (or if it failed), which
   *  just means the dropdown offers "Custom" alone — the sliders still work. */
  v2Presets?: V2PresetInfo[];
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

function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="text-xs">
        {label} <span className="text-muted-foreground">({hint})</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} size="sm" />
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="mt-2 mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</div>;
}

// The named starting points from backend/app/v2/presets.py. Picking one overwrites every v2 dial
// with that preset's values; touching any dial afterwards switches the label to "Custom" without
// changing anything (see the onChange wrapper in ParamsPanel).
function PresetField({
  v2,
  presets,
  onSelect,
  disabled,
}: {
  v2: V2Params;
  presets: V2PresetInfo[];
  onSelect: (patch: Partial<VectorizeParams>) => void;
  disabled: boolean;
}) {
  const selected = presets.find((preset) => preset.id === v2.presetId);
  return (
    <div className="mb-4">
      <div className="mb-2 text-xs">Preset</div>
      <select
        value={v2.presetId}
        disabled={disabled}
        onChange={(event) => {
          const picked = presets.find((preset) => preset.id === event.target.value);
          // Spread the whole preset, trace fields included, rather than patching a few dials: a
          // preset is a complete parameter set, so carrying anything over from the previous
          // selection would produce a state that is neither preset while being labelled as one.
          onSelect(picked ? { ...picked.params } : { v2: { ...v2, presetId: CUSTOM_PRESET_ID } });
        }}
        className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs disabled:opacity-50"
      >
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        <option value={CUSTOM_PRESET_ID}>Custom</option>
      </select>
      {selected && <div className="mt-1.5 text-xs text-muted-foreground">{selected.description}</div>}
    </div>
  );
}

// v2's own stages (see backend/app/v2/params.py). Rendered only when `params.v2` exists, i.e. on
// the v2 route — v1 and v3 have no such stages and their endpoints reject the fields.
function V2Sections({
  v2,
  presets,
  onChange,
  onSelectPreset,
  disabled,
}: {
  v2: V2Params;
  presets: V2PresetInfo[];
  onChange: (patch: Partial<V2Params>) => void;
  onSelectPreset: (patch: Partial<VectorizeParams>) => void;
  disabled: boolean;
}) {
  return (
    <>
      <SectionLabel>Preset</SectionLabel>
      <PresetField v2={v2} presets={presets} onSelect={onSelectPreset} disabled={disabled} />

      <SectionLabel>Preprocess</SectionLabel>
      <SliderField
        label="Denoise"
        hint="Edge-preserving"
        value={v2.denoiseStrength}
        min={0}
        max={10}
        step={1}
        onChange={(v) => onChange({ denoiseStrength: v })}
        disabled={disabled}
      />
      <SliderField
        label="Colors"
        hint="Fewer layers"
        value={v2.colorCount}
        min={0}
        max={64}
        step={1}
        onChange={(v) => onChange({ colorCount: v })}
        disabled={disabled}
      />
      <SliderField
        label="Min Region"
        hint="px, absorbed"
        value={v2.minRegionArea}
        min={0}
        max={200}
        step={1}
        onChange={(v) => onChange({ minRegionArea: v })}
        disabled={disabled}
      />
      <SwitchField
        label="Smooth Regions"
        hint="De-staircase"
        checked={v2.smoothLabels}
        onChange={(v) => onChange({ smoothLabels: v })}
        disabled={disabled}
      />

      <SectionLabel>Postprocess</SectionLabel>
      <SliderField
        label="Min Path Area"
        hint="px², dropped"
        value={v2.minPathArea}
        min={0}
        max={200}
        step={1}
        onChange={(v) => onChange({ minPathArea: v })}
        disabled={disabled}
      />
      <SliderField
        label="Simplify"
        hint="px, structure"
        value={v2.simplifyTolerance}
        min={0}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ simplifyTolerance: v })}
        disabled={disabled}
      />
      <SliderField
        label="Fit Error"
        hint="px, max deviation"
        value={v2.maxFitError}
        min={0.1}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ maxFitError: v })}
        disabled={disabled}
      />
      <SwitchField
        label="Smooth Curves"
        hint="Refit as beziers"
        checked={v2.smoothCurves}
        onChange={(v) => onChange({ smoothCurves: v })}
        disabled={disabled}
      />
      <SwitchField
        label="Snap To Palette"
        hint="Caps colour count"
        checked={v2.snapFillsToPalette}
        onChange={(v) => onChange({ snapFillsToPalette: v })}
        disabled={disabled}
      />
      <SliderField
        label="Corner Angle"
        hint="Keep sharp above"
        value={v2.smoothCornerAngle}
        min={0}
        max={180}
        step={1}
        onChange={(v) => onChange({ smoothCornerAngle: v })}
        disabled={disabled}
      />
      <SliderField
        label="Precision"
        hint="Decimals"
        value={v2.precision}
        min={0}
        max={6}
        step={1}
        onChange={(v) => onChange({ precision: v })}
        disabled={disabled}
      />
      <SliderField
        label="Seam Stroke"
        hint="px, closes gaps"
        value={v2.seamStrokeWidth}
        min={0}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ seamStrokeWidth: v })}
        disabled={disabled}
      />
      <div className="mb-2 text-xs">
        Merge Same Fill <span className="text-muted-foreground">(fewer layers)</span>
      </div>
      <SegmentedControl<MergeSameFill>
        value={v2.mergeSameFill}
        options={[
          { label: 'None', value: 'none' },
          { label: 'Adjacent', value: 'adjacent' },
          { label: 'All', value: 'all' },
        ]}
        onChange={(v) => onChange({ mergeSameFill: v })}
        disabled={disabled}
      />
    </>
  );
}

export function ParamsPanel({
  params,
  onChange,
  onRevectorize,
  canRevectorize,
  isVectorizing,
  v2Presets = [],
}: Props) {
  const disabled = isVectorizing;
  const v2 = params.v2;

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

                {v2 && (
                  <V2Sections
                    v2={v2}
                    presets={v2Presets}
                    onSelectPreset={onChange}
                    onChange={(patch) =>
                      onChange({
                        v2: {
                          ...v2,
                          ...patch,
                          // Any patch that isn't itself a preset selection means the dials no
                          // longer describe the named preset, so the label has to drop to Custom.
                          presetId: patch.presetId ?? CUSTOM_PRESET_ID,
                        },
                      })
                    }
                    disabled={disabled}
                  />
                )}
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
