import { compose, IDENTITY, rotation, scaling, translation } from '../../model/transform';
import type { Matrix } from '../../model/transform';

/** One CSS pixel (the SVG user unit when there is no viewBox) in millimetres. */
export const MM_PER_PX = 25.4 / 96;

const PX_PER_UNIT: Readonly<Record<string, number>> = {
  '': 1,
  px: 1,
  mm: 96 / 25.4,
  cm: 960 / 25.4,
  q: 24 / 25.4,
  in: 96,
  pt: 96 / 72,
  pc: 16,
  // Font-relative units, assuming the default 16 px font.
  em: 16,
  rem: 16,
  ex: 8,
};

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i;
const NUMBER_GLOBAL = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Absolute units in mm, kept separate so that mm-based documents convert exactly. */
const MM_PER_UNIT: Readonly<Record<string, number>> = {
  '': MM_PER_PX,
  px: MM_PER_PX,
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
};

function parseWithUnits(
  text: string | undefined,
  units: Readonly<Record<string, number>>,
  percentOf: number | null,
): number | null {
  if (text === undefined) return null;
  const match = LENGTH.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '%') return percentOf === null ? null : (value * percentOf) / 100;
  const factor = units[unit];
  return factor === undefined ? null : value * factor;
}

/**
 * Parses an SVG length into px (user units). `percentOf` is what 100% means,
 * or null when percentages cannot be resolved. Returns null for anything
 * missing or unparseable.
 */
export function parseLength(text: string | undefined, percentOf: number | null): number | null {
  return parseWithUnits(text, PX_PER_UNIT, percentOf);
}

/** Parses an absolute length (no percentages or font-relative units) into mm. */
export function parseLengthMm(text: string | undefined): number | null {
  return parseWithUnits(text, MM_PER_UNIT, null);
}

/** Parses a whitespace/comma separated number list; null when it holds anything else. */
export function parseNumberList(text: string): number[] | null {
  const numbers: number[] = [];
  let rest = '';
  let last = 0;
  NUMBER_GLOBAL.lastIndex = 0;
  for (let match = NUMBER_GLOBAL.exec(text); match !== null; match = NUMBER_GLOBAL.exec(text)) {
    rest += text.slice(last, match.index);
    last = NUMBER_GLOBAL.lastIndex;
    numbers.push(Number(match[0]));
  }
  rest += text.slice(last);
  return /^[\s,]*$/.test(rest) ? numbers : null;
}

/** Like `parseNumberList`, but keeps the numbers before the first bad token. */
export function parseNumberListLenient(text: string): number[] {
  const numbers: number[] = [];
  const sticky = /[\s,]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  for (let match = sticky.exec(text); match !== null; match = sticky.exec(text)) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function parseViewBox(text: string | undefined): ViewBox | null {
  if (text === undefined) return null;
  const numbers = parseNumberList(text);
  if (numbers === null || numbers.length !== 4) return null;
  const [x = 0, y = 0, width = 0, height = 0] = numbers;
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

function alignFactor(align: string, axis: 'x' | 'y'): number {
  const match = axis === 'x' ? /^x(Min|Mid|Max)/.exec(align) : /Y(Min|Mid|Max)$/.exec(align);
  if (match === null || match[1] === 'Mid') return 0.5;
  return match[1] === 'Min' ? 0 : 1;
}

/**
 * Matrix that maps a viewBox onto a viewport of `width` x `height` placed at
 * the origin, following `preserveAspectRatio` (default `xMidYMid meet`).
 */
export function fitViewBox(
  viewBox: ViewBox,
  width: number,
  height: number,
  preserveAspectRatio: string | undefined,
): Matrix {
  const sx = width / viewBox.width;
  const sy = height / viewBox.height;
  const parts = (preserveAspectRatio ?? '').trim().split(/\s+/);
  const align = parts[0] === undefined || parts[0] === '' ? 'xMidYMid' : parts[0];
  if (align === 'none') return [sx, 0, 0, sy, -viewBox.x * sx, -viewBox.y * sy];
  const s = parts[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const tx = (width - viewBox.width * s) * alignFactor(align, 'x');
  const ty = (height - viewBox.height * s) * alignFactor(align, 'y');
  return [s, 0, 0, s, tx - viewBox.x * s, ty - viewBox.y * s];
}

const TRANSFORM_ITEM = /[\s,]*([a-zA-Z]+)\s*\(([^)]*)\)/y;

function transformItem(name: string, a: readonly number[]): Matrix | null {
  const at = (k: number): number => a[k] ?? 0;
  const count = a.length;
  switch (name) {
    case 'matrix':
      return count === 6 ? [at(0), at(1), at(2), at(3), at(4), at(5)] : null;
    case 'translate':
      return count === 1 || count === 2 ? translation(at(0), at(1)) : null;
    case 'scale':
      if (count === 1) return scaling(at(0), at(0));
      return count === 2 ? scaling(at(0), at(1)) : null;
    case 'rotate':
      if (count === 1) return rotation((at(0) * Math.PI) / 180);
      return count === 3 ? rotation((at(0) * Math.PI) / 180, { x: at(1), y: at(2) }) : null;
    case 'skewX':
      return count === 1 ? [1, 0, Math.tan((at(0) * Math.PI) / 180), 1, 0, 0] : null;
    case 'skewY':
      return count === 1 ? [1, Math.tan((at(0) * Math.PI) / 180), 0, 1, 0, 0] : null;
    default:
      return null;
  }
}

/**
 * Parses an SVG `transform` attribute. In a list the rightmost transform is
 * applied to the geometry first. Returns null when the list is malformed (the
 * whole attribute is then ignored, as browsers do).
 */
export function parseTransform(text: string | undefined): Matrix | null {
  if (text === undefined) return IDENTITY;
  let matrix: Matrix = IDENTITY;
  let end = 0;
  TRANSFORM_ITEM.lastIndex = 0;
  for (let match = TRANSFORM_ITEM.exec(text); match !== null; match = TRANSFORM_ITEM.exec(text)) {
    end = TRANSFORM_ITEM.lastIndex;
    const args = parseNumberList(match[2] ?? '');
    const item = args === null ? null : transformItem(match[1] ?? '', args);
    if (item === null || !item.every(Number.isFinite)) return null;
    matrix = compose(matrix, item);
  }
  return /^[\s,]*$/.test(text.slice(end)) ? matrix : null;
}

/** Largest factor by which the matrix stretches a length (its largest singular value). */
export function maxScale(m: Matrix): number {
  const [a, b, c, d] = m;
  const sum = a * a + b * b + c * c + d * d;
  const diff = Math.hypot(a * a + b * b - c * c - d * d, 2 * (a * c + b * d));
  return Math.sqrt((sum + diff) / 2);
}
