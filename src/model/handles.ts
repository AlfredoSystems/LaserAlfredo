import { IDENTITY, rotation, scaling, type Matrix } from './transform';
import type { Bounds, Point } from './types';

export type ScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const SCALE_HANDLES: readonly ScaleHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** -1 / 0 / +1 position of a handle along each axis of the selection box. */
function handleSigns(handle: ScaleHandle): { sx: -1 | 0 | 1; sy: -1 | 0 | 1 } {
  return {
    sx: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    sy: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0,
  };
}

function along(min: number, max: number, sign: -1 | 0 | 1): number {
  return sign < 0 ? min : sign > 0 ? max : (min + max) / 2;
}

export function handlePosition(bounds: Bounds, handle: ScaleHandle): Point {
  const { sx, sy } = handleSigns(handle);
  return { x: along(bounds.minX, bounds.maxX, sx), y: along(bounds.minY, bounds.maxY, sy) };
}

export interface ScaleDragOptions {
  /** Keep the aspect ratio (corner handles only). */
  readonly uniform: boolean;
  /** Scale about the centre instead of the opposite handle. */
  readonly fromCenter: boolean;
}

const MIN_SCALE = 1e-6;

function axisFactor(pointer: number, anchor: number, grabbed: number): number {
  const span = grabbed - anchor;
  if (Math.abs(span) < 1e-9) return 1;
  const factor = (pointer - anchor) / span;
  if (!Number.isFinite(factor)) return 1;
  // Never collapse the selection to zero size.
  return Math.abs(factor) < MIN_SCALE ? MIN_SCALE : factor;
}

/** Matrix for dragging a scale handle of `bounds` to `pointer`. */
export function scaleDragMatrix(
  bounds: Bounds,
  handle: ScaleHandle,
  pointer: Point,
  options: ScaleDragOptions,
): Matrix {
  const { sx, sy } = handleSigns(handle);
  const grabbed = handlePosition(bounds, handle);
  const center: Point = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  const anchor: Point = options.fromCenter
    ? center
    : { x: along(bounds.minX, bounds.maxX, sx === 0 ? 0 : sx === 1 ? -1 : 1), y: along(bounds.minY, bounds.maxY, sy === 0 ? 0 : sy === 1 ? -1 : 1) };

  let fx = sx === 0 ? 1 : axisFactor(pointer.x, anchor.x, grabbed.x);
  let fy = sy === 0 ? 1 : axisFactor(pointer.y, anchor.y, grabbed.y);

  if (options.uniform && sx !== 0 && sy !== 0) {
    const widthFlat = Math.abs(grabbed.x - anchor.x) < 1e-9;
    const heightFlat = Math.abs(grabbed.y - anchor.y) < 1e-9;
    const f = widthFlat ? fy : heightFlat ? fx : Math.abs(fx) >= Math.abs(fy) ? fx : fy;
    fx = f;
    fy = f;
  }
  if (fx === 1 && fy === 1) return IDENTITY;
  return scaling(fx, fy, anchor);
}

/** Matrix for dragging the rotate handle from `start` to `pointer` around `center`. */
export function rotateDragMatrix(center: Point, start: Point, pointer: Point, snapRadians = 0): Matrix {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(pointer.y - center.y, pointer.x - center.x);
  let angle = a1 - a0;
  if (snapRadians > 0) angle = Math.round(angle / snapRadians) * snapRadians;
  return angle === 0 ? IDENTITY : rotation(angle, center);
}

/**
 * Matrix that resizes `bounds` to the given size, keeping its top-left corner.
 * A dimension that is currently zero (a straight line) is left alone.
 */
export function resizeMatrix(bounds: Bounds, widthMm: number, heightMm: number): Matrix {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const fx = w > 1e-9 && widthMm > 0 ? widthMm / w : 1;
  const fy = h > 1e-9 && heightMm > 0 ? heightMm / h : 1;
  return scaling(fx, fy, { x: bounds.minX, y: bounds.minY });
}
