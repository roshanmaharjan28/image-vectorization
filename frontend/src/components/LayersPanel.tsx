import type { Layer, SvgMeta } from '../types';
import { LayerRow } from './LayerRow';

interface Props {
  layers: Layer[];
  meta: SvgMeta | null;
  hoveredLayerId: string | null;
  selectedLayerId: string | null;
  onToggleVisible: (id: string) => void;
  onDelete: (id: string) => void;
  onHoverLayer: (id: string | null) => void;
}

export function LayersPanel({
  layers,
  meta,
  hoveredLayerId,
  selectedLayerId,
  onToggleVisible,
  onDelete,
  onHoverLayer,
}: Props) {
  const orderedLayers = [...layers].reverse();

  return (
    <aside className="layers-panel">
      <div className="layers-panel__header">
        <span>Layers</span>
        <span className="layers-panel__count">{layers.length}</span>
      </div>
      <div className="layers-panel__list">
        {orderedLayers.length === 0 && (
          <p className="layers-panel__empty">No layers left. Vectorize an image or undo deletions by re-vectorizing.</p>
        )}
        {orderedLayers.map((layer, i) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            index={orderedLayers.length - i}
            meta={meta}
            isHovered={layer.id === hoveredLayerId}
            isSelected={layer.id === selectedLayerId}
            onToggleVisible={onToggleVisible}
            onDelete={onDelete}
            onHover={onHoverLayer}
          />
        ))}
      </div>
    </aside>
  );
}
