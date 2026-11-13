import type { RuidaOrigin } from '../drivers/ruida/job';
import { useJobStore } from './jobStore';
import { NumberField } from './NumberField';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

function formatLength(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
}

export function JobPanel() {
  const status = useJobStore((state) => state.status);
  const built = useJobStore((state) => state.built);
  const error = useJobStore((state) => state.error);
  const preview = useJobStore((state) => state.preview);
  const fraction = useJobStore((state) => state.fraction);
  const maxPowerCapPct = useJobStore((state) => state.maxPowerCapPct);
  const fileName = useJobStore((state) => state.fileName);
  const exporting = useJobStore((state) => state.exporting);
  const origin = useJobStore((state) => state.origin);
  const { setPreview, setFraction, setMaxPowerCap, setFileName, setOrigin, exportRd } = useJobStore.getState();

  const estimate = built?.estimate;
  const hasCuts = (estimate?.pathCount ?? 0) > 0;
  const blocked = !built || !hasCuts || built.problem !== null;

  return (
    <section className="panel" aria-label="Job">
      <h2 className="panel-title">
        Job <span className="panel-count">{status === 'computing' ? 'updating…' : ''}</span>
      </h2>
      {!built && status !== 'computing' && <p className="panel-empty">{error ?? 'No shapes to cut yet.'}</p>}
      {built && estimate && (
        <dl className="stats" data-testid="job-stats">
          <dt>Cut</dt>
          <dd data-testid="job-cut">{formatLength(estimate.cutMm)}</dd>
          <dt>Travel</dt>
          <dd>{formatLength(estimate.travelMm)}</dd>
          <dt>Time</dt>
          <dd data-testid="job-time" title="Distance over speed; ignores acceleration, so real jobs run a little longer">
            ≈ {formatDuration(estimate.seconds)}
          </dd>
          <dt>Paths</dt>
          <dd>{estimate.pathCount}</dd>
        </dl>
      )}
      {built?.problem && hasCuts && (
        <p className="panel-error" data-testid="job-problem">
          {built.problem}
        </p>
      )}
      {built?.warnings.map((warning) => (
        <p key={warning} className="panel-warning">
          {warning}
        </p>
      ))}
      <div className="row">
        <button
          type="button"
          disabled={!built || !hasCuts}
          aria-pressed={preview}
          className={preview ? 'primary' : ''}
          data-testid="preview-toggle"
          title="Show the cutting order and travel moves"
          onClick={() => setPreview(!preview)}
        >
          {preview ? 'Close preview' : 'Preview'}
        </button>
      </div>
      {preview && (
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(fraction * 1000)}
          aria-label="Preview progress"
          data-testid="preview-slider"
          onChange={(event) => setFraction(Number(event.target.value) / 1000)}
        />
      )}
      <div className="field-grid">
        <NumberField
          label="Power cap %"
          title="No layer is ever exported above this power"
          testId="power-cap"
          value={maxPowerCapPct}
          min={0}
          max={100}
          decimals={1}
          onCommit={setMaxPowerCap}
        />
        <label className="field" title="File name for the export">
          <span className="field-label">Name</span>
          <input
            className="field-input field-text"
            type="text"
            value={fileName}
            maxLength={32}
            data-testid="job-name"
            onChange={(event) => setFileName(event.target.value)}
          />
        </label>
      </div>
      <label className="field" title="The bed corner your machine homes to. A wrong choice gives a mirrored cut.">
        <span className="field-label">Machine zero</span>
        <select
          className="field-select"
          value={origin}
          data-testid="job-origin"
          onChange={(event) => setOrigin(event.target.value as RuidaOrigin)}
        >
          <option value="top-left">Rear left</option>
          <option value="top-right">Rear right</option>
          <option value="bottom-left">Front left</option>
          <option value="bottom-right">Front right</option>
        </select>
      </label>
      <p className="panel-warning">
        The .rd output has not been tested on a machine yet. Follow the first-run checks in docs/ruida-protocol.md.
      </p>
      <button
        type="button"
        className="primary"
        disabled={blocked || exporting || status === 'computing'}
        data-testid="export-rd"
        title="Save a Ruida .rd file to copy to a USB stick"
        onClick={() => void exportRd()}
      >
        {exporting ? 'Exporting…' : 'Export .rd'}
      </button>
    </section>
  );
}
