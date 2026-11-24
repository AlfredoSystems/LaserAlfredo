import { useMemo } from 'react';
import { countLayerShapes } from '../model/document';
import { MATERIAL_TEST_CELL_COLOR, MATERIAL_TEST_LABEL_COLOR } from '../model/materialTest';
import type { LayerMode } from '../model/types';
import { NumberField } from './NumberField';
import { useAppStore } from './store';

/** What the reserved colours are for, added to their swatch's tooltip. */
const SPECIAL_LAYERS: Readonly<Record<string, string>> = {
  [MATERIAL_TEST_CELL_COLOR]: ' (material test cells)',
  [MATERIAL_TEST_LABEL_COLOR]: ' (material test labels)',
};

export function LayersPanel() {
  const layers = useAppStore((state) => state.doc.layers);
  const shapes = useAppStore((state) => state.doc.shapes);
  const patchLayer = useAppStore((state) => state.patchLayer);
  const selectLayer = useAppStore((state) => state.selectLayer);

  const counts = useMemo(() => countLayerShapes(shapes), [shapes]);

  return (
    <section className="panel panel-grow" aria-label="Layers">
      <h2 className="panel-title">
        Layers <span className="panel-count">{layers.length}</span>
      </h2>
      {layers.length === 0 && <p className="panel-empty">Import a DXF or SVG to get started.</p>}
      <ul className="layers">
        {layers.map((layer) => {
          const count = counts.get(layer.color)?.shapes ?? 0;
          const ownSettings = counts.get(layer.color)?.withSettings ?? 0;
          // Every shape brings its own speed, power and passes: the layer's would do nothing.
          const perShape = count > 0 && ownSettings === count;
          const kerfField = (
            <NumberField
              label="Kerf mm"
              title="Width of the laser cut in mm. Outlines grow and holes shrink by half of it. 0 = off."
              testId="layer-kerf"
              value={layer.kerfMm}
              min={0}
              max={2}
              decimals={3}
              onCommit={(kerfMm) => patchLayer(layer.color, { kerfMm })}
            />
          );
          return (
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
                title={`Select everything on this layer${SPECIAL_LAYERS[layer.color] ?? ''}`}
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
              <span className="layer-count">
                {count} {count === 1 ? 'shape' : 'shapes'}
              </span>
            </div>
            {perShape ? (
              <>
                <p className="layer-note" data-testid="layer-note">
                  Material test — settings are per cell
                </p>
                <div className="field-grid">{kerfField}</div>
              </>
            ) : (
            <div className="field-grid">
              <NumberField
                label="Speed mm/s"
                title="Speed in mm/s"
                value={layer.speedMmS}
                min={0.1}
                max={2000}
                decimals={1}
                onCommit={(speedMmS) => patchLayer(layer.color, { speedMmS })}
              />
              <NumberField
                label="Passes"
                title="How many times the layer is cut"
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
              {kerfField}
            </div>
            )}
            {!perShape && ownSettings > 0 && (
              <p className="layer-note" data-testid="layer-note">
                {ownSettings} {ownSettings === 1 ? 'shape uses its' : 'shapes use their'} own settings
              </p>
            )}
          </li>
          );
        })}
      </ul>
    </section>
  );
}
