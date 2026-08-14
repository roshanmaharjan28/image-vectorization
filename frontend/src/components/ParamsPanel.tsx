import type { VectorizeParams } from '../types';

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
    <div className="params-panel__segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`params-panel__segment${value === opt.value ? ' params-panel__segment--active' : ''}`}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
        >
          {opt.label}
        </button>
      ))}
    </div>
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
    <div className="params-panel__field">
      <div className="params-panel__field-label">
        {label} <span className="params-panel__field-hint">({hint})</span>
      </div>
      <div className="params-panel__slider-row">
        <span className="params-panel__slider-value">{value}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

export function ParamsPanel({ params, onChange, onRevectorize, canRevectorize, isVectorizing }: Props) {
  const disabled = isVectorizing;

  return (
    <aside className="params-panel">
      <div className="params-panel__header">Vectorize Settings</div>
      <div className="params-panel__body">
        <div className="params-panel__section-title">Clustering</div>
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

        <div className="params-panel__section-title">Curve Fitting</div>
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
      <button
        type="button"
        className="btn btn--primary params-panel__apply"
        onClick={onRevectorize}
        disabled={disabled || !canRevectorize}
      >
        {isVectorizing ? 'Vectorizing…' : 'Re-vectorize'}
      </button>
    </aside>
  );
}
