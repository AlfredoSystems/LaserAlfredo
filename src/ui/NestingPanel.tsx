import { useMemo } from 'react';
import { HL1060_BED } from '../model/bed';
import { DEFAULT_PART_SETTING, MAX_PART_QUANTITY } from '../nesting/parts';
import { nestSource, ROTATION_STEPS, useNestStore } from './nestStore';
import { NumberField } from './NumberField';
import { useAppStore } from './store';

/** Rows shown in the part list; a longer list is cut off with a note. */
const MAX_PART_ROWS = 200;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function formatSize(mm: number): string {
  return String(Number(mm.toFixed(1)));
}

export function NestingPanel() {
  const shapes = useAppStore((state) => state.doc.shapes);
  const selection = useAppStore((state) => state.selection);
  const settings = useNestStore((state) => state.settings);
  const options = useNestStore((state) => state.options);
  const runOptions = useNestStore((state) => state.runOptions);
  const status = useNestStore((state) => state.status);
  const error = useNestStore((state) => state.error);
  const result = useNestStore((state) => state.result);
  const evaluations = useNestStore((state) => state.evaluations);
  const sheetIndex = useNestStore((state) => state.sheetIndex);
  const applied = useNestStore((state) => state.applied);
  const exporting = useNestStore((state) => state.exporting);
  const { setQuantity, setCanRotate, setOptions, start, stop, discard, setSheetIndex, applySheet, exportAllSheets } =
    useNestStore.getState();

  const { groups, fromSelection } = useMemo(() => nestSource(shapes, selection), [shapes, selection]);
  const copies = useMemo(() => {
    let total = 0;
    for (const group of groups) total += (settings.get(group.id) ?? DEFAULT_PART_SETTING).quantity;
    return total;
  }, [groups, settings]);

  const running = status === 'running';
  const sheetCount = result?.sheets.length ?? 0;
  const sheet = result?.sheets[sheetIndex];
  const lastSheet = result?.sheets[sheetCount - 1];
  const unplaced = result ? result.unplaced.reduce((sum, entry) => sum + entry.count, 0) : 0;
  const tried = plural(evaluations, 'layout', 'layouts');

  return (
    <section className="panel panel-grow" aria-label="Nesting">
      <h2 className="panel-title">
        Parts <span className="panel-count" data-testid="nest-part-count">{groups.length}</span>
      </h2>
      <p className="panel-empty" data-testid="nest-source">
        {groups.length === 0
          ? 'Import a DXF or SVG to get parts to nest.'
          : fromSelection
            ? `From the selection. Clear it to nest the whole document.`
            : 'From the whole document. Select shapes to nest only those.'}
      </p>
      {groups.length > 0 && (
        <ul className="nest-parts">
          {groups.slice(0, MAX_PART_ROWS).map((group, index) => {
            const setting = settings.get(group.id) ?? DEFAULT_PART_SETTING;
            return (
              <li key={group.id} className="nest-part" data-testid="nest-part">
                <span
                  className="nest-part-size"
                  title={`Part ${index + 1}: ${plural(group.shapeIds.length, 'shape', 'shapes')}${group.closed ? '' : ', open path'}`}
                >
                  {formatSize(group.widthMm)} × {formatSize(group.heightMm)} mm
                </span>
                <NumberField
                  label="Qty"
                  title="Copies to nest. 0 leaves the part out."
                  testId="nest-qty"
                  value={setting.quantity}
                  min={0}
                  max={MAX_PART_QUANTITY}
                  decimals={0}
                  onCommit={(quantity) => setQuantity(group.id, quantity)}
                />
                <label className="check" title="Allow this part to be turned. Off keeps it as drawn (grain direction).">
                  <input
                    type="checkbox"
                    checked={setting.canRotate}
                    data-testid="nest-rotate"
                    aria-label={`Rotate part ${index + 1}`}
                    onChange={(event) => setCanRotate(group.id, event.target.checked)}
                  />
                  Rotate
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {groups.length > MAX_PART_ROWS && (
        <p className="panel-empty">
          {plural(groups.length - MAX_PART_ROWS, 'more part is', 'more parts are')} not listed and keep their settings.
          Select fewer shapes to edit them.
        </p>
      )}

      <h2 className="panel-title">Sheet (mm)</h2>
      <div className="field-grid">
        <NumberField
          label="Width"
          title={`Sheet width in mm, along X. At most the bed width (${HL1060_BED.widthMm} mm).`}
          testId="nest-sheet-w"
          value={options.sheetWidthMm}
          min={10}
          max={HL1060_BED.widthMm}
          decimals={1}
          onCommit={(sheetWidthMm) => setOptions({ sheetWidthMm })}
        />
        <NumberField
          label="Height"
          title={`Sheet height in mm, along Y. At most the bed height (${HL1060_BED.heightMm} mm).`}
          testId="nest-sheet-h"
          value={options.sheetHeightMm}
          min={10}
          max={HL1060_BED.heightMm}
          decimals={1}
          onCommit={(sheetHeightMm) => setOptions({ sheetHeightMm })}
        />
        <NumberField
          label="Margin"
          title="Gap in mm kept clear along every sheet edge"
          testId="nest-margin"
          value={options.marginMm}
          min={0}
          max={100}
          decimals={1}
          onCommit={(marginMm) => setOptions({ marginMm })}
        />
        <NumberField
          label="Spacing"
          title="Smallest gap in mm between two parts"
          testId="nest-spacing"
          value={options.spacingMm}
          min={0}
          max={50}
          decimals={1}
          onCommit={(spacingMm) => setOptions({ spacingMm })}
        />
      </div>
      <label className="field" title="Parts may be turned in multiples of this angle. Smaller steps pack tighter but search longer.">
        <span className="field-label">Rotation step</span>
        <select
          className="field-select"
          value={options.rotationStepDeg}
          data-testid="nest-rotation-step"
          onChange={(event) => setOptions({ rotationStepDeg: Number(event.target.value) })}
        >
          {ROTATION_STEPS.map((step) => (
            <option key={step} value={step}>
              {step === 0 ? 'None' : `${step}°`}
            </option>
          ))}
        </select>
      </label>
      <label className="check" title="Place small parts inside the empty holes of larger ones">
        <input
          type="checkbox"
          checked={options.useHoles}
          data-testid="nest-use-holes"
          onChange={(event) => setOptions({ useHoles: event.target.checked })}
        />
        Fill holes with smaller parts
      </label>

      <div className="row">
        {running ? (
          <button type="button" data-testid="nest-stop" title="Keep the best layout found so far" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={copies === 0}
            data-testid="nest-start"
            title={copies === 0 ? 'There is nothing to nest' : `Nest ${plural(copies, 'copy', 'copies')}`}
            onClick={start}
          >
            {result ? 'Nest again' : 'Start nesting'}
          </button>
        )}
        {result && !running && (
          <button type="button" data-testid="nest-discard" title="Throw the layout away and edit the document again" onClick={discard}>
            Discard
          </button>
        )}
      </div>
      {status !== 'idle' && (
        <p className="panel-empty" data-testid="nest-status">
          {running
            ? result
              ? `Searching for a better layout… ${tried} tried`
              : 'Working out the first layout…'
            : `${status === 'finished' ? 'Finished' : 'Stopped'} · ${tried} tried`}
        </p>
      )}
      {error && (
        <p className="panel-error" data-testid="nest-error">
          {error}
        </p>
      )}

      {result && (
        <>
          <h2 className="panel-title">Result</h2>
          <dl className="stats stats-pairs" data-testid="nest-result">
            <dt>Sheets used</dt>
            <dd data-testid="nest-sheets">{sheetCount}</dd>
            <dt>Utilization</dt>
            <dd
              data-testid="nest-utilization"
              title="Part area over the material used: full sheets, plus the last sheet up to its used length"
            >
              {(result.utilization * 100).toFixed(1)} %
            </dd>
            <dt>{sheetCount > 1 ? 'Last sheet used' : 'Sheet used'}</dt>
            <dd data-testid="nest-used-length" title="From the sheet's left edge to the right-most part">
              {lastSheet ? `${lastSheet.usedLengthMm.toFixed(0)} of ${formatSize(runOptions.sheetWidthMm)} mm` : '–'}
            </dd>
            <dt>Placed</dt>
            <dd data-testid="nest-placed">{plural(result.placedCount, 'part', 'parts')}</dd>
          </dl>
          {unplaced > 0 && (
            <p className="panel-warning" data-testid="nest-unplaced">
              {plural(unplaced, 'part does', 'parts do')} not fit the sheet and {unplaced === 1 ? 'was' : 'were'} left
              out.
            </p>
          )}
          {sheetCount > 1 && (
            <div className="row nest-switcher">
              <button
                type="button"
                disabled={sheetIndex <= 0}
                data-testid="nest-prev"
                aria-label="Previous sheet"
                onClick={() => setSheetIndex(sheetIndex - 1)}
              >
                ‹
              </button>
              <span className="nest-sheet-label" data-testid="nest-sheet-label">
                Sheet {sheetIndex + 1} of {sheetCount}
                {sheet && <span className="nest-sheet-parts"> · {plural(sheet.placements.length, 'part', 'parts')}</span>}
              </span>
              <button
                type="button"
                disabled={sheetIndex >= sheetCount - 1}
                data-testid="nest-next"
                aria-label="Next sheet"
                onClick={() => setSheetIndex(sheetIndex + 1)}
              >
                ›
              </button>
            </div>
          )}
          <button
            type="button"
            className="primary"
            disabled={!sheet || sheet.placements.length === 0 || applied}
            data-testid="nest-apply"
            title="Replace the nested parts in the document with this sheet's layout (one undo step)"
            onClick={applySheet}
          >
            {applied ? 'Applied to document' : 'Apply sheet to document'}
          </button>
          <button
            type="button"
            disabled={sheetCount === 0 || exporting}
            data-testid="nest-export"
            title="Save one Ruida .rd file per sheet, using the layer settings and the job name, power cap and machine zero from the Cut tab"
            onClick={() => void exportAllSheets()}
          >
            {exporting ? 'Exporting…' : sheetCount > 1 ? 'Export all sheets (.rd)' : 'Export sheet (.rd)'}
          </button>
        </>
      )}
    </section>
  );
}
