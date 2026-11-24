import { ClipperOffset, EndType, JoinType } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import type { Point, Polyline } from '../model/types';
import { containmentDepths } from './containment';

/** clipper2-ts works on integers: 1 unit = 0.0001 mm. */
const SCALE = 10000;

/** Largest deviation of a rounded corner from a true arc. */
const ARC_TOLERANCE_MM = 0.01;

const MITER_LIMIT = 2;

function toClipperPath(points: readonly Point[]): Path64 | null {
  const out: Path64 = [];
  for (const p of points) {
    const x = Math.round(p.x * SCALE);
    const y = Math.round(p.y * SCALE);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
    out.push({ x, y });
  }
  return out;
}

/**
 * Offsets one closed contour by `deltaMm` (positive grows, negative shrinks,
 * whatever its winding). Returns null when the contour cannot be offset.
 */
function offsetContour(points: readonly Point[], deltaMm: number): Point[][] | null {
  const path = toClipperPath(points);
  if (path === null) return null;
  const solution: Paths64 = [];
  try {
    const offsetter = new ClipperOffset(MITER_LIMIT, ARC_TOLERANCE_MM * SCALE);
    offsetter.addPath(path, JoinType.Round, EndType.Polygon);
    offsetter.execute(deltaMm * SCALE, solution);
  } catch {
    return null;
  }
  const result: Point[][] = [];
  for (const ring of solution) {
    if (ring.length < 3) continue;
    result.push(ring.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE })));
  }
  return result;
}

/**
 * Kerf compensation. `kerfMm` is the full width of the laser cut; every closed
 * contour is offset by half of it so the finished part keeps its drawn size.
 * Outer contours (even containment depth) grow, holes (odd depth) shrink,
 * whatever the winding of the input. Convex corners of a grown contour are
 * rounded.
 *
 * Output keeps the input order, with the offset result replacing its source:
 * a contour that splits yields several polylines in a row, and a hole that
 * collapses to nothing is dropped. Open paths, closed paths with fewer than 3
 * points and contours that cannot be offset pass through unchanged. A kerf
 * that is zero, negative or not finite returns the input paths unchanged.
 * Whatever else a path carries besides its points is kept on its result.
 */
export function applyKerf<T extends Polyline>(paths: readonly T[], kerfMm: number): T[] {
  if (!Number.isFinite(kerfMm) || kerfMm <= 0) return [...paths];
  const half = kerfMm / 2;
  const depths = containmentDepths(paths);
  const result: T[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path === undefined) continue;
    if (!path.closed || path.points.length < 3) {
      result.push(path);
      continue;
    }
    const isHole = (depths[i] ?? 0) % 2 === 1;
    const rings = offsetContour(path.points, isHole ? -half : half);
    if (rings === null || (rings.length === 0 && !isHole)) {
      result.push(path);
      continue;
    }
    for (const points of rings) result.push({ ...path, points, closed: true });
  }
  return result;
}
