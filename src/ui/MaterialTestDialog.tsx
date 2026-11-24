import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { RUIDA_MAX_SPEED_MM_S } from '../drivers/ruida/job';
import { boundsContainsBounds } from '../geometry/bounds';
import { HL1060_BED } from '../model/bed';
import {
  axesConflict,
  buildMaterialTest,
  DEFAULT_MATERIAL_TEST_OPTIONS,
  defaultAxis,
  formatTestValue,
  MAX_TEST_STEPS,
  MIN_TEST_STEPS,
  normalizeMaterialTestOptions,
  type MaterialTest,
  type MaterialTestOptions,
  type TestAxis,
  type TestParameter,
} from '../model/materialTest';
import type { Point } from '../model/types';
import { useJobStore } from './jobStore';
import { NumberField } from './NumberField';
import { BED_BOUNDS, useAppStore } from './store';

/** Where a new test lands: a little in from the bed's top-left corner. */
const TEST_ORIGIN: Point = { x: 10, y: 10 };

interface MaterialTestState {
  readonly open: boolean;
  /** The options last used; kept for the session so the next test starts from them. */
  readonly options: MaterialTestOptions;
  setOpen(open: boolean): void;
  setOptions(patch: Partial<MaterialTestOptions>): void;
}

export const useMaterialTestStore = create<MaterialTestState>((set, get) => ({
  open: false,
  options: DEFAULT_MATERIAL_TEST_OPTIONS,
  setOpen(open) {
    set({ open });
  },
  setOptions(patch) {
    set({ options: normalizeMaterialTestOptions({ ...get().options, ...patch }) });
  },
}));

const PARAMETER_NAMES: Readonly<Record<TestParameter, string>> = {
  speed: 'Speed (mm/s)',
  power: 'Max power (%)',
  passes: 'Passes',
};

const PARAMETER_LIMITS: Readonly<Record<TestParameter, { min: number; max: number; decimals: number }>> = {
  speed: { min: 0.1, max: 2000, decimals: 1 },
  power: { min: 0, max: 100, decimals: 1 },
  passes: { min: 1, max: 100, decimals: 0 },
};

interface AxisFieldsProps {
  readonly title: string;
  readonly testId: string;
  readonly axis: TestAxis;
  readonly onChange: (axis: TestAxis) => void;
}

function AxisFields({ title, testId, axis, onChange }: AxisFieldsProps) {
  const limits = PARAMETER_LIMITS[axis.parameter];
  return (
    <fieldset className="dialog-group">
      <legend>{title}</legend>
      <label className="field">
        <span className="field-label">Vary</span>
        <select
          className="field-select"
          value={axis.parameter}
          data-testid={`${testId}-parameter`}
          onChange={(event) => {
            // A new parameter starts from its own sensible range; the step count stays.
            const parameter = event.target.value as TestParameter;
            onChange({ ...defaultAxis(parameter), steps: axis.steps });
          }}
        >
          {(Object.keys(PARAMETER_NAMES) as TestParameter[]).map((parameter) => (
            <option key={parameter} value={parameter}>
              {PARAMETER_NAMES[parameter]}
            </option>
          ))}
        </select>
      </label>
      <div className="field-grid field-grid-3">
        <NumberField
          label="From"
          testId={`${testId}-from`}
          value={axis.from}
          {...limits}
          onCommit={(from) => onChange({ ...axis, from })}
        />
        <NumberField
          label="To"
          testId={`${testId}-to`}
          value={axis.to}
          {...limits}
          onCommit={(to) => onChange({ ...axis, to })}
        />
        <NumberField
          label="Steps"
          title={`How many values, ${MIN_TEST_STEPS} to ${MAX_TEST_STEPS}`}
          testId={`${testId}-steps`}
          value={axis.steps}
          min={MIN_TEST_STEPS}
          max={MAX_TEST_STEPS}
          decimals={0}
          onCommit={(steps) => onChange({ ...axis, steps })}
        />
      </div>
    </fieldset>
  );
}

interface Assessment {
  readonly test: MaterialTest | null;
  /** Why no test can be created, or null. */
  readonly blocking: string | null;
  /** Things worth knowing that do not stop the test from being created. */
  readonly cautions: readonly string[];
}

function assess(options: MaterialTestOptions, powerCapPct: number): Assessment {
  let id = 0;
  const test = buildMaterialTest(options, {
    origin: TEST_ORIGIN,
    nextShapeId: () => `preview${++id}`,
    groupId: 'preview',
  });
  if (axesConflict(options) || !test) {
    return {
      test: null,
      blocking: 'Columns and rows vary the same setting. Pick a different one for one of them.',
      cautions: [],
    };
  }
  let blocking: string | null = null;
  const cautions: string[] = [];
  if (!boundsContainsBounds(BED_BOUNDS, test.bounds)) {
    blocking =
      `At ${formatTestValue(test.widthMm)} × ${formatTestValue(test.heightMm)} mm the grid does not fit the ` +
      `${HL1060_BED.widthMm} × ${HL1060_BED.heightMm} mm bed. Use smaller cells, a smaller gap or fewer steps.`;
  }
  const speeds = test.cells.map((cell) => cell.settings?.speedMmS ?? 0);
  if (options.labels) speeds.push(options.labelSpeedMmS);
  const fastest = Math.max(...speeds);
  if (fastest > RUIDA_MAX_SPEED_MM_S) {
    cautions.push(
      `Speeds go up to ${formatTestValue(fastest)} mm/s. The .rd export refuses anything above ` +
        `${RUIDA_MAX_SPEED_MM_S} mm/s, so this test could not be exported.`,
    );
  }
  const strongest = Math.max(...test.cells.map((cell) => cell.settings?.maxPowerPct ?? 0));
  if (strongest > powerCapPct) {
    cautions.push(
      `Power goes up to ${formatTestValue(strongest)} %, but the Job panel's power cap is ` +
        `${formatTestValue(powerCapPct)} %. Every cell above the cap would be cut at ${formatTestValue(powerCapPct)} %, ` +
        'whatever its label says, so the test would be misleading. Raise the cap or lower the power.',
    );
  }
  return { test, blocking, cautions };
}

/** The popup that sets up a material test grid and adds it to the document. */
export function MaterialTestDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const options = useMaterialTestStore((state) => state.options);
  const { setOptions, setOpen } = useMaterialTestStore.getState();
  const powerCapPct = useJobStore((state) => state.maxPowerCapPct);

  useEffect(() => {
    const dialog = dialogRef.current;
    // A modal dialog takes the focus and makes the rest of the page inert.
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const { test, blocking, cautions } = useMemo(() => assess(options, powerCapPct), [options, powerCapPct]);

  const onAxis = (parameter: TestParameter) =>
    options.columns.parameter === parameter || options.rows.parameter === parameter;

  const close = () => dialogRef.current?.close();
  const createTest = () => {
    // Judged again on the options as they are now: a field may have committed on the way to the button.
    const current = useMaterialTestStore.getState().options;
    if (assess(current, useJobStore.getState().maxPowerCapPct).blocking) return;
    if (useAppStore.getState().addMaterialTest(current, TEST_ORIGIN)) close();
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="material-test-title"
      data-testid="material-test-dialog"
      onClose={() => setOpen(false)}
      // Keys pressed in the popup never reach the canvas shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <h2 id="material-test-title" className="dialog-title">
        Material test
      </h2>
      <p className="dialog-intro">
        A grid of squares cut with a different setting in every column and row, to find what works on a material.
      </p>
      <div className="dialog-columns">
        <AxisFields
          title="Columns (across)"
          testId="material-test-columns"
          axis={options.columns}
          onChange={(columns) => setOptions({ columns })}
        />
        <AxisFields
          title="Rows (down)"
          testId="material-test-rows"
          axis={options.rows}
          onChange={(rows) => setOptions({ rows })}
        />
        <fieldset className="dialog-group">
          <legend>Every cell</legend>
          <div className="field-grid field-grid-3">
            <NumberField
              label="Speed mm/s"
              title="Cutting speed of every cell, unless speed is varied"
              testId="material-test-speed"
              value={options.speedMmS}
              {...PARAMETER_LIMITS.speed}
              disabled={onAxis('speed')}
              onCommit={(speedMmS) => setOptions({ speedMmS })}
            />
            <NumberField
              label="Max power %"
              title="Maximum power of every cell, unless power is varied"
              testId="material-test-power"
              value={options.maxPowerPct}
              {...PARAMETER_LIMITS.power}
              disabled={onAxis('power')}
              onCommit={(maxPowerPct) => setOptions({ maxPowerPct })}
            />
            <NumberField
              label="Passes"
              title="How many times every cell is cut, unless passes are varied"
              testId="material-test-passes"
              value={options.passes}
              {...PARAMETER_LIMITS.passes}
              disabled={onAxis('passes')}
              onCommit={(passes) => setOptions({ passes })}
            />
          </div>
          <div className="row">
            <label
              className="check"
              title="On: each cell's min power equals its max power, so the power is the same in corners as on straight runs."
            >
              <input
                type="checkbox"
                checked={options.minPowerPct === null}
                data-testid="material-test-min-same"
                onChange={(event) =>
                  setOptions({ minPowerPct: event.target.checked ? null : Math.min(10, options.maxPowerPct) })
                }
              />
              Min power = max power
            </label>
            <NumberField
              label="Min power %"
              title="Minimum power (used in corners) of every cell. Never above the cell's max power."
              testId="material-test-min-power"
              value={options.minPowerPct}
              {...PARAMETER_LIMITS.power}
              disabled={options.minPowerPct === null}
              onCommit={(minPowerPct) => setOptions({ minPowerPct })}
            />
          </div>
        </fieldset>
        <fieldset className="dialog-group">
          <legend>Layout</legend>
          <div className="field-grid">
            <NumberField
              label="Cell size mm"
              title="Side of each square, 3 to 50 mm"
              testId="material-test-cell"
              value={options.cellSizeMm}
              min={3}
              max={50}
              decimals={1}
              onCommit={(cellSizeMm) => setOptions({ cellSizeMm })}
            />
            <NumberField
              label="Gap mm"
              title="Space between squares, 0 to 20 mm"
              testId="material-test-gap"
              value={options.gapMm}
              min={0}
              max={20}
              decimals={1}
              onCommit={(gapMm) => setOptions({ gapMm })}
            />
          </div>
          <label className="check" title="Engrave each column's and row's value and a title next to the grid">
            <input
              type="checkbox"
              checked={options.labels}
              data-testid="material-test-labels"
              onChange={(event) => setOptions({ labels: event.target.checked })}
            />
            Engrave labels
          </label>
          <div className="field-grid">
            <NumberField
              label="Label speed mm/s"
              testId="material-test-label-speed"
              value={options.labelSpeedMmS}
              {...PARAMETER_LIMITS.speed}
              disabled={!options.labels}
              onCommit={(labelSpeedMmS) => setOptions({ labelSpeedMmS })}
            />
            <NumberField
              label="Label power %"
              testId="material-test-label-power"
              value={options.labelPowerPct}
              {...PARAMETER_LIMITS.power}
              disabled={!options.labels}
              onCommit={(labelPowerPct) => setOptions({ labelPowerPct })}
            />
          </div>
        </fieldset>
      </div>
      <p className="dialog-summary" data-testid="material-test-summary">
        {test
          ? `${formatTestValue(test.widthMm)} × ${formatTestValue(test.heightMm)} mm, ${test.cells.length} cells`
          : 'No grid'}
      </p>
      {/* A fixed height: a message that comes or goes must not move the buttons from under the mouse. */}
      <div className="dialog-messages">
        {blocking && (
          <p className="panel-error" role="alert" data-testid="material-test-warning">
            {blocking}
          </p>
        )}
        {cautions.map((caution) => (
          <p key={caution} className="panel-warning" data-testid="material-test-caution">
            {caution}
          </p>
        ))}
      </div>
      <div className="dialog-buttons">
        <button type="button" data-testid="material-test-cancel" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={blocking !== null}
          data-testid="material-test-create"
          onClick={createTest}
        >
          Create
        </button>
      </div>
    </dialog>
  );
}
