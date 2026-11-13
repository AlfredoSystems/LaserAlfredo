import type { Point } from './types';

/**
 * 2D affine matrix [a, b, c, d, e, f]:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * (the same layout as SVG and canvas matrices).
 */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Returns the matrix that applies `first`, then `second`. */
export function compose(second: Matrix, first: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy];
}

/** Scale by (sx, sy) keeping `origin` fixed. */
export function scaling(sx: number, sy: number, origin: Point = { x: 0, y: 0 }): Matrix {
  return [sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y];
}

/**
 * Rotate by `radians` keeping `origin` fixed. Positive angles turn clockwise
 * on screen because Y points down.
 */
export function rotation(radians: number, origin: Point = { x: 0, y: 0 }): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos,
    sin,
    -sin,
    cos,
    origin.x - cos * origin.x + sin * origin.y,
    origin.y - sin * origin.x - cos * origin.y,
  ];
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function applyToPoints(m: Matrix, points: readonly Point[]): Point[] {
  return points.map((p) => applyToPoint(m, p));
}

/** Determinant; negative when the matrix mirrors. */
export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2];
}
