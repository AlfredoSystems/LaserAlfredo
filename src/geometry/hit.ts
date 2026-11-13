import type { Point, Polyline } from '../model/types';

/** Shortest distance from `p` to the segment a-b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (!(lengthSq > 0)) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Shortest distance from `p` to the path, including the closing segment of a
 * closed path. Infinity when the path has no points.
 */
export function distanceToPolyline(p: Point, path: Polyline): number {
  const points = path.points;
  const first = points[0];
  if (first === undefined) return Infinity;
  let best = Math.hypot(p.x - first.x, p.y - first.y);
  let prev = first;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    if (cur === undefined) continue;
    const d = distanceToSegment(p, prev, cur);
    if (d < best) best = d;
    prev = cur;
  }
  if (path.closed && points.length > 2) {
    const d = distanceToSegment(p, prev, first);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd point-in-polygon test. The polygon is implicitly closed. */
export function pointInPolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false;
  let prev = points[points.length - 1];
  if (prev === undefined) return false;
  for (const cur of points) {
    if (cur.y > p.y !== prev.y > p.y) {
      const xCross = cur.x + ((p.y - cur.y) * (prev.x - cur.x)) / (prev.y - cur.y);
      if (p.x < xCross) inside = !inside;
    }
    prev = cur;
  }
  return inside;
}

/**
 * Shoelace area of the implicitly closed polygon. Positive when the points
 * run counter-clockwise in a Y-up system, which is clockwise on screen in the
 * document's Y-down system.
 */
export function signedArea(points: readonly Point[]): number {
  let prev = points[points.length - 1];
  if (prev === undefined) return 0;
  let sum = 0;
  for (const cur of points) {
    sum += prev.x * cur.y - cur.x * prev.y;
    prev = cur;
  }
  return sum / 2;
}
