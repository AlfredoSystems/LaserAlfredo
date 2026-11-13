import { useState } from 'react';

interface NumberFieldProps {
  readonly label: string;
  readonly value: number | null;
  readonly onCommit: (value: number) => void;
  readonly decimals?: number;
  readonly min?: number;
  readonly max?: number;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly title?: string;
}

function format(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '';
  // Trim trailing zeros, and avoid "-0".
  const text = String(Number(value.toFixed(decimals)));
  return text === '-0' ? '0' : text;
}

/** Numeric input that commits on Enter or blur and reverts on Escape or invalid text. */
export function NumberField({
  label,
  value,
  onCommit,
  decimals = 2,
  min,
  max,
  disabled,
  testId,
  title,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? format(value, decimals);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(',', '.'));
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(parsed)) return;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    if (value === null || format(clamped, decimals) !== format(value, decimals)) onCommit(clamped);
  };

  return (
    <label className="field" title={title}>
      <span className="field-label">{label}</span>
      <input
        className="field-input"
        type="text"
        inputMode="decimal"
        value={shown}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.select();
          } else if (event.key === 'Escape') {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        onFocus={(event) => event.currentTarget.select()}
      />
    </label>
  );
}
