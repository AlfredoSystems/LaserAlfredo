import { boundsContainsBounds, boundsIntersect, boundsOfPoints, unionBounds } from '../geometry/bounds';
import { distanceToPolyline } from '../geometry/hit';
import type { Bounds, Point, Shape } from './types';

const boundsCache = new WeakMap<Shape, Bounds | null>();

/** Bounding box of a shape. Cached per shape object (shapes are immutable). */
export function shapeBounds(shape: Shape): Bounds | null {
  let bounds = boundsCache.get(shape);
  if (bounds === undefined) {
    bounds = boundsOfPoints(shape.points);
    boundsCache.set(shape, bounds);
  }
  return bounds;
}

export function boundsOfShapes(shapes: readonly Shape[], ids?: ReadonlySet<string>): Bounds | null {
  let result: Bounds | null = null;
  for (const shape of shapes) {
    if (ids && !ids.has(shape.id)) continue;
    result = unionBounds(result, shapeBounds(shape));
  }
  return result;
}

/** The topmost shape whose outline passes within `toleranceMm` of the point. */
export function pickShape(shapes: readonly Shape[], p: Point, toleranceMm: number): Shape | null {
  let best: Shape | null = null;
  let bestDistance = toleranceMm;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (!shape) continue;
    const b = shapeBounds(shape);
    if (!b) continue;
    if (
      p.x < b.minX - toleranceMm ||
      p.x > b.maxX + toleranceMm ||
      p.y < b.minY - toleranceMm ||
      p.y > b.maxY + toleranceMm
    ) {
      continue;
    }
    const distance = distanceToPolyline(p, shape);
    if (distance < bestDistance || (best === null && distance <= toleranceMm)) {
      best = shape;
      bestDistance = distance;
    }
  }
  return best;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function outlineTouchesRect(shape: Shape, rect: Bounds): boolean {
  const { points } = shape;
  const inside = (p: Point) => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY;
  if (points.some(inside)) return true;
  const corners: Point[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
  const count = shape.closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    for (let k = 0; k < 4; k++) {
      const c = corners[k];
      const d = corners[(k + 1) % 4];
      if (c && d && segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Marquee selection. `enclose` picks shapes entirely inside the rectangle;
 * `cross` also picks shapes whose outline touches it.
 */
export function shapesInRect(shapes: readonly Shape[], rect: Bounds, mode: 'enclose' | 'cross'): Shape[] {
  const result: Shape[] = [];
  for (const shape of shapes) {
    const b = shapeBounds(shape);
    if (!b) continue;
    if (boundsContainsBounds(rect, b)) {
      result.push(shape);
    } else if (mode === 'cross' && boundsIntersect(rect, b) && outlineTouchesRect(shape, rect)) {
      result.push(shape);
    }
  }
  return result;
}
