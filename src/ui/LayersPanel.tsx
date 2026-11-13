import { useMemo } from 'react';
import type { LayerMode } from '../model/types';
import { NumberField } from './NumberField';
import { useAppStore } from './store';

export function LayersPanel() {
  const layers = useAppStore((state) => state.doc.layers);
  const shapes = useAppStore((state) => state.doc.shapes);
  const patchLayer = useAppStore((state) => state.patchLayer);
  const selectLayer = useAppStore((state) => state.selectLayer);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const shape of shapes) map.set(shape.color, (map.get(shape.color) ?? 0) + 1);
    return map;
  }, [shapes]);

  return (
    <section className="panel panel-grow" aria-label="Layers">
      <h2 className="panel-title">
        Layers <span className="panel-count">{layers.length}</span>
      </h2>
      {layers.length === 0 && <p className="panel-empty">Import a DXF or SVG to get started.</p>}
      <ul className="layers">
        {layers.map((layer) => (
          <li key={layer.color} className="layer" data-testid="layer-row">
            <div className="layer-head">
              <input
                type="checkbox"
                checked={layer.enabled}
                title="Output this layer"
                aria-label={`Output layer ${layer.color}`}
                onChange={(event) => patchLayer(layer.color, { enabled: event.target.checked })}
              />
              <button
                type="button"
                className="swatch"
                style={{ background: layer.color }}
                title="Select everything on this layer"
                aria-label={`Select layer ${layer.color}`}
                onClick={() => selectLayer(layer.color)}
              />
              <select
                value={layer.mode}
                aria-label="Mode"
                onChange={(event) => patchLayer(layer.color, { mode: event.target.value as LayerMode })}
              >
                <option value="line">Line</option>
                <option value="fill">Fill</option>
              </select>
              <span className="layer-count">{counts.get(layer.color) ?? 0} shapes</span>
            </div>
            <div className="field-grid">
              <NumberField
                label="Speed"
                title="Speed in mm/s"
                value={layer.speedMmS}
                min={0.1}
                max={2000}
                decimals={1}
                onCommit={(speedMmS) => patchLayer(layer.color, { speedMmS })}
              />
              <NumberField
                label="Passes"
                value={layer.passes}
                min={1}
                max={100}
                decimals={0}
                onCommit={(passes) => patchLayer(layer.color, { passes })}
              />
              <NumberField
                label="Max %"
                title="Maximum power %"
                testId="layer-max-power"
                value={layer.maxPowerPct}
                min={0}
                max={100}
                decimals={1}
                onCommit={(maxPowerPct) => patchLayer(layer.color, { maxPowerPct })}
              />
              <NumberField
                label="Min %"
                title="Minimum power % (used in corners)"
                value={layer.minPowerPct}
                min={0}
                max={100}
                decimals={1}
                onCommit={(minPowerPct) => patchLayer(layer.color, { minPowerPct })}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
