import { useMemo, useState } from 'react';
import { LAYER_PALETTE } from '../model/document';
import { resizeMatrix } from '../model/handles';
import { boundsOfShapes } from '../model/selection';
import { rotation, scaling, translation } from '../model/transform';
import type { ShapeCutSettings } from '../model/types';
import { NumberField } from './NumberField';
import { useAppStore } from './store';

function describeSettings(settings: ShapeCutSettings): string {
  const number = (value: number) => String(Number(value.toFixed(1)));
  const min = settings.minPowerPct < settings.maxPowerPct ? ` (min ${number(settings.minPowerPct)} %)` : '';
  return (
    `${number(settings.speedMmS)} mm/s · ${number(settings.maxPowerPct)} %${min} · ` +
    `${settings.passes} ${settings.passes === 1 ? 'pass' : 'passes'}`
  );
}

export function TransformPanel() {
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const transformSelection = useAppStore((state) => state.transformSelection);
  const activeColor = useAppStore((state) => state.activeColor);
  const setActiveColor = useAppStore((state) => state.setActiveColor);
  const [lockAspect, setLockAspect] = useState(true);
  const [angle, setAngle] = useState(90);

  const bounds = useMemo(
    () => (selection.size === 0 ? null : boundsOfShapes(doc.shapes, selection)),
    [doc.shapes, selection],
  );
  /** The own cut settings of the selected shape, when exactly one shape is selected and it has any. */
  const cellSettings = useMemo(() => {
    if (selection.size !== 1) return null;
    return doc.shapes.find((shape) => selection.has(shape.id))?.settings ?? null;
  }, [doc.shapes, selection]);
  const width = bounds ? bounds.maxX - bounds.minX : null;
  const height = bounds ? bounds.maxY - bounds.minY : null;
  const disabled = !bounds;
  const center = bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : null;

  const resize = (nextWidth: number | null, nextHeight: number | null) => {
    if (!bounds || width === null || height === null) return;
    let w = nextWidth ?? width;
    let h = nextHeight ?? height;
    if (lockAspect && width > 1e-9 && height > 1e-9) {
      if (nextWidth !== null) h = (height * nextWidth) / width;
      else if (nextHeight !== null) w = (width * nextHeight) / height;
    }
    transformSelection(resizeMatrix(bounds, w, h));
  };

  return (
    <section className="panel" aria-label="Selection">
      <h2 className="panel-title">
        Selection <span className="panel-count" data-testid="selection-count">{selection.size}</span>
      </h2>
      <div className="field-grid">
        <NumberField
          label="X mm"
          title="Left edge of the selection in mm"
          testId="sel-x"
          value={bounds ? bounds.minX : null}
          disabled={disabled}
          onCommit={(x) => bounds && transformSelection(translation(x - bounds.minX, 0))}
        />
        <NumberField
          label="Y mm"
          title="Top edge of the selection in mm"
          testId="sel-y"
          value={bounds ? bounds.minY : null}
          disabled={disabled}
          onCommit={(y) => bounds && transformSelection(translation(0, y - bounds.minY))}
        />
        <NumberField
          label="W mm"
          title="Width of the selection in mm"
          testId="sel-w"
          value={width}
          min={0.001}
          disabled={disabled || (width ?? 0) <= 1e-9}
          onCommit={(w) => resize(w, null)}
        />
        <NumberField
          label="H mm"
          title="Height of the selection in mm"
          testId="sel-h"
          value={height}
          min={0.001}
          disabled={disabled || (height ?? 0) <= 1e-9}
          onCommit={(h) => resize(null, h)}
        />
      </div>
      {cellSettings && (
        <p
          className="cell-settings"
          data-testid="cell-settings"
          title="This shape is cut with its own settings instead of its layer's. Moving it to another layer drops them."
        >
          Cell: {describeSettings(cellSettings)}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={lockAspect} onChange={(event) => setLockAspect(event.target.checked)} />
        Lock aspect ratio
      </label>
      <div className="row">
        <NumberField label="Rotate °" title="Angle in degrees for the rotate buttons" value={angle} min={-360} max={360} onCommit={setAngle} />
        <button
          type="button"
          disabled={disabled}
          title="Rotate counter-clockwise"
          onClick={() => center && transformSelection(rotation((-angle * Math.PI) / 180, center))}
        >
          ⟲
        </button>
        <button
          type="button"
          disabled={disabled}
          title="Rotate clockwise"
          data-testid="rotate-cw"
          onClick={() => center && transformSelection(rotation((angle * Math.PI) / 180, center))}
        >
          ⟳
        </button>
      </div>
      <div className="row">
        <button
          type="button"
          disabled={disabled}
          title="Mirror left–right"
          onClick={() => center && transformSelection(scaling(-1, 1, center))}
        >
          Flip H
        </button>
        <button
          type="button"
          disabled={disabled}
          title="Mirror top–bottom"
          onClick={() => center && transformSelection(scaling(1, -1, center))}
        >
          Flip V
        </button>
      </div>
      <div className="palette" aria-label="Active layer">
        {LAYER_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch ${color === activeColor ? 'swatch-active' : ''}`}
            style={{ background: color }}
            title="Make this the active layer (imports land here) and move the selection to it"
            aria-label={`Active layer ${color}`}
            aria-pressed={color === activeColor}
            data-testid={`palette-${color.slice(1)}`}
            onClick={() => setActiveColor(color)}
          />
        ))}
      </div>
    </section>
  );
}
