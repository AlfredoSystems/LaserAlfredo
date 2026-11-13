import { useMemo, useState } from 'react';
import { LAYER_PALETTE } from '../model/document';
import { resizeMatrix } from '../model/handles';
import { boundsOfShapes } from '../model/selection';
import { rotation, scaling, translation } from '../model/transform';
import { NumberField } from './NumberField';
import { useAppStore } from './store';

export function TransformPanel() {
  const doc = useAppStore((state) => state.doc);
  const selection = useAppStore((state) => state.selection);
  const transformSelection = useAppStore((state) => state.transformSelection);
  const setSelectionColor = useAppStore((state) => state.setSelectionColor);
  const [lockAspect, setLockAspect] = useState(true);
  const [angle, setAngle] = useState(90);

  const bounds = useMemo(
    () => (selection.size === 0 ? null : boundsOfShapes(doc.shapes, selection)),
    [doc.shapes, selection],
  );
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
          label="X"
          testId="sel-x"
          value={bounds ? bounds.minX : null}
          disabled={disabled}
          onCommit={(x) => bounds && transformSelection(translation(x - bounds.minX, 0))}
        />
        <NumberField
          label="Y"
          testId="sel-y"
          value={bounds ? bounds.minY : null}
          disabled={disabled}
          onCommit={(y) => bounds && transformSelection(translation(0, y - bounds.minY))}
        />
        <NumberField
          label="W"
          testId="sel-w"
          value={width}
          min={0.001}
          disabled={disabled || (width ?? 0) <= 1e-9}
          onCommit={(w) => resize(w, null)}
        />
        <NumberField
          label="H"
          testId="sel-h"
          value={height}
          min={0.001}
          disabled={disabled || (height ?? 0) <= 1e-9}
          onCommit={(h) => resize(null, h)}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={lockAspect} onChange={(event) => setLockAspect(event.target.checked)} />
        Lock aspect ratio
      </label>
      <div className="row">
        <NumberField label="Rotate °" value={angle} min={-360} max={360} onCommit={setAngle} />
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
      <div className="palette" aria-label="Move selection to layer">
        {LAYER_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            style={{ background: color }}
            disabled={disabled}
            title={`Move selection to layer ${color}`}
            aria-label={`Move selection to layer ${color}`}
            onClick={() => setSelectionColor(color)}
          />
        ))}
      </div>
    </section>
  );
}
