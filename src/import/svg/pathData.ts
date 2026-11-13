import { flattenCubic, flattenQuadratic, flattenSvgArc } from '../../geometry/flatten';
import type { Point } from '../../model/types';

/** One subpath of an SVG path, flattened, in the path's own user units. */
export interface SubPath {
  readonly points: Point[];
  readonly closed: boolean;
}

export interface PathDataResult {
  readonly subpaths: SubPath[];
  /** Set when the data was malformed; `subpaths` then holds what parsed before the error. */
  readonly error: string | null;
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

const PARAM_COUNT: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function isSeparator(code: number): boolean {
  // space, tab, LF, FF, CR, comma
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13 || code === 44;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Parses and flattens SVG path data. Handles every command in absolute and
 * relative form, implicit repetition, compact numbers (`1.5.5`, `-1-2`, `1e-3`)
 * and arc flags written without separators. Never throws: on malformed data it
 * returns what was parsed up to the error.
 */
export function parsePathData(d: string, toleranceMm: number): PathDataResult {
  const subpaths: SubPath[] = [];
  const n = d.length;
  let i = 0;
  let cur: Point = { x: 0, y: 0 };
  let start: Point = cur;
  let current: Point[] | null = null;
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let command = '';

  const skip = (): void => {
    while (i < n && isSeparator(d.charCodeAt(i))) i++;
  };
  const readNumber = (): number | null => {
    skip();
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(d);
    if (match === null) return null;
    i = NUMBER.lastIndex;
    return Number(match[0]);
  };
  const readFlag = (): number | null => {
    skip();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') return null;
    i++;
    return ch === '1' ? 1 : 0;
  };
  const flush = (closed: boolean): void => {
    if (current !== null) subpaths.push({ points: current, closed });
    current = null;
  };
  const append = (points: readonly Point[]): void => {
    if (current === null) current = [cur];
    for (let j = 1; j < points.length; j++) {
      const p = points[j];
      if (p !== undefined) current.push(p);
    }
  };
  const lineTo = (p: Point): void => {
    append([cur, p]);
    cur = p;
  };
  const fail = (message: string): PathDataResult => {
    flush(false);
    return { subpaths, error: message };
  };

  for (;;) {
    skip();
    if (i >= n) break;
    if (isLetter(d.charCodeAt(i))) {
      const letter = d[i] ?? '';
      if (PARAM_COUNT[letter.toUpperCase()] === undefined) return fail(`unknown command "${letter}" at ${i}`);
      if (command === '' && letter !== 'M' && letter !== 'm') return fail('path data must start with a moveto');
      command = letter;
      i++;
    } else if (command === '') {
      return fail('path data must start with a moveto');
    } else if (command === 'Z' || command === 'z') {
      return fail(`unexpected character "${d[i] ?? ''}" at ${i}`);
    }

    const upper = command.toUpperCase();
    if (upper === 'Z') {
      flush(true);
      cur = start;
      lastCubic = null;
      lastQuad = null;
      continue;
    }

    const count = PARAM_COUNT[upper] ?? 0;
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      const value = upper === 'A' && (k === 3 || k === 4) ? readFlag() : readNumber();
      if (value === null) return fail(`expected a number at ${i} for "${command}"`);
      args.push(value);
    }
    const arg = (k: number): number => args[k] ?? 0;
    const relative = command !== upper;
    const ox = relative ? cur.x : 0;
    const oy = relative ? cur.y : 0;
    let nextCubic: Point | null = null;
    let nextQuad: Point | null = null;

    switch (upper) {
      case 'M':
        flush(false);
        cur = { x: ox + arg(0), y: oy + arg(1) };
        start = cur;
        // Further coordinate pairs after a moveto are implicit linetos.
        command = relative ? 'l' : 'L';
        break;
      case 'L':
        lineTo({ x: ox + arg(0), y: oy + arg(1) });
        break;
      case 'H':
        lineTo({ x: ox + arg(0), y: cur.y });
        break;
      case 'V':
        lineTo({ x: cur.x, y: oy + arg(0) });
        break;
      case 'C': {
        const p1 = { x: ox + arg(0), y: oy + arg(1) };
        const p2 = { x: ox + arg(2), y: oy + arg(3) };
        const p3 = { x: ox + arg(4), y: oy + arg(5) };
        append(flattenCubic(cur, p1, p2, p3, toleranceMm));
        cur = p3;
        nextCubic = p2;
        break;
      }
      case 'S': {
        const p1: Point = lastCubic === null ? cur : { x: 2 * cur.x - lastCubic.x, y: 2 * cur.y - lastCubic.y };
        const p2 = { x: ox + arg(0), y: oy + arg(1) };
        const p3 = { x: ox + arg(2), y: oy + arg(3) };
        append(flattenCubic(cur, p1, p2, p3, toleranceMm));
        cur = p3;
        nextCubic = p2;
        break;
      }
      case 'Q': {
        const p1 = { x: ox + arg(0), y: oy + arg(1) };
        const p2 = { x: ox + arg(2), y: oy + arg(3) };
        append(flattenQuadratic(cur, p1, p2, toleranceMm));
        cur = p2;
        nextQuad = p1;
        break;
      }
      case 'T': {
        const p1: Point = lastQuad === null ? cur : { x: 2 * cur.x - lastQuad.x, y: 2 * cur.y - lastQuad.y };
        const p2 = { x: ox + arg(0), y: oy + arg(1) };
        append(flattenQuadratic(cur, p1, p2, toleranceMm));
        cur = p2;
        nextQuad = p1;
        break;
      }
      case 'A': {
        const end = { x: ox + arg(5), y: oy + arg(6) };
        append(flattenSvgArc(cur, arg(0), arg(1), arg(2), arg(3) === 1, arg(4) === 1, end, toleranceMm));
        cur = end;
        break;
      }
    }
    lastCubic = nextCubic;
    lastQuad = nextQuad;
  }

  flush(false);
  return { subpaths, error: null };
}
