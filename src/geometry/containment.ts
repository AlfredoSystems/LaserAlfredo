import type { Bounds, Point, Polyline } from '../model/types';
import { boundsContainsBounds, boundsOfPoints } from './bounds';
import { distanceToPolyline, pointInPolygon, signedArea } from './hit';

/** A vertex closer than this to a candidate's boundary cannot decide containment. */
const BOUNDARY_EPS_MM = 1e-6;

/** How many vertices are tried before giving up on a path that hugs a candidate's boundary. */
const MAX_PROBES = 16;

const MIN_LEVEL = -10;

function cellKey(ix: number, iy: number): number {
  return Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663);
}

function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * True when a representative vertex of `points` lies inside `container` by the
 * even-odd rule. Vertices on the container's boundary are skipped; a path whose
 * probed vertices all lie on the boundary is not contained.
 */
function isInside(points: readonly Point[], container: Polyline): boolean {
  const count = points.length;
  const step = Math.max(1, Math.floor(count / MAX_PROBES));
  for (let i = 0, probes = 0; i < count && probes < MAX_PROBES; i += step) {
    const p = points[i];
    if (p === undefined || !isFinitePoint(p)) continue;
    probes++;
    if (distanceToPolyline(p, container) <= BOUNDARY_EPS_MM) continue;
    return pointInPolygon(p, container.points);
  }
  return false;
}

/**
 * For each path, the index of its immediate container: the smallest-area
 * closed path that strictly contains it, or -1. Open paths can be contained
 * but never contain. A container always has a strictly larger area than a
 * closed path it contains, so identical duplicates never contain each other
 * and the result is always a forest.
 *
 * Containment is decided from the bounding boxes plus one representative
 * vertex, so paths that cross each other give an arbitrary (but stable) answer.
 */
export function containmentParents(paths: readonly Polyline[]): number[] {
  const count = paths.length;
  const bounds: (Bounds | null)[] = new Array<Bounds | null>(count).fill(null);
  /** Area a container must exceed: the path's own area, or -1 for open paths. */
  const ownArea = new Float64Array(count);
  /** Area as a container, 0 when the path cannot contain anything. */
  const area = new Float64Array(count);

  // Containers are indexed in a pyramid of grids: each goes into the level
  // whose cell size is at least its larger dimension, so it covers at most
  // 2 x 2 cells, and a point query reads one cell per level.
  const levels = new Map<number, Map<number, number[]>>();

  for (let i = 0; i < count; i++) {
    const path = paths[i];
    if (path === undefined) continue;
    const b = boundsOfPoints(path.points);
    bounds[i] = b;
    ownArea[i] = -1;
    if (b === null || !path.closed) continue;
    const a = path.points.length >= 3 ? Math.abs(signedArea(path.points)) : 0;
    ownArea[i] = a;
    if (!(a > 0) || !Number.isFinite(a)) continue;
    area[i] = a;

    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const level = Math.max(MIN_LEVEL, Math.ceil(Math.log2(size)));
    const cell = 2 ** level;
    let cells = levels.get(level);
    if (cells === undefined) {
      cells = new Map<number, number[]>();
      levels.set(level, cells);
    }
    const x0 = Math.floor(b.minX / cell);
    const x1 = Math.floor(b.maxX / cell);
    const y0 = Math.floor(b.minY / cell);
    const y1 = Math.floor(b.maxY / cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = cellKey(ix, iy);
        const bucket = cells.get(key);
        if (bucket === undefined) cells.set(key, [i]);
        else bucket.push(i);
      }
    }
  }

  const byArea = (p: number, q: number): number => (area[p] ?? 0) - (area[q] ?? 0) || p - q;
  const levelList = [...levels.entries()].sort((p, q) => p[0] - q[0]);
  for (const [, cells] of levelList) {
    for (const bucket of cells.values()) bucket.sort(byArea);
  }

  const parents = new Array<number>(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const path = paths[i];
    const b = bounds[i];
    if (path === undefined || b === null || b === undefined) continue;
    const own = ownArea[i] ?? -1;
    let best = -1;
    let bestArea = Infinity;
    for (const [level, cells] of levelList) {
      const cell = 2 ** level;
      const bucket = cells.get(cellKey(Math.floor(b.minX / cell), Math.floor(b.minY / cell)));
      if (bucket === undefined) continue;
      for (const j of bucket) {
        const a = area[j] ?? 0;
        if (!(a > own)) continue;
        // Buckets are sorted by area, so nothing further on can beat the best.
        if (a >= bestArea) break;
        const candidate = paths[j];
        const cb = bounds[j];
        if (candidate === undefined || cb === null || cb === undefined) continue;
        if (!boundsContainsBounds(cb, b)) continue;
        if (!isInside(path.points, candidate)) continue;
        best = j;
        bestArea = a;
        break;
      }
    }
    parents[i] = best;
  }
  return parents;
}

/** Nesting depth of each path, counting only closed ancestors (0 = outermost). */
export function containmentDepths(paths: readonly Polyline[]): number[] {
  const parents = containmentParents(paths);
  const depths = new Array<number>(parents.length).fill(-1);
  const chain: number[] = [];
  for (let i = 0; i < parents.length; i++) {
    // Walk up to the first ancestor with a known depth, then fill back down.
    let cur = i;
    while (cur >= 0 && depths[cur] === -1) {
      chain.push(cur);
      cur = parents[cur] ?? -1;
    }
    let depth = cur >= 0 ? (depths[cur] ?? 0) + 1 : 0;
    for (let k = chain.length - 1; k >= 0; k--) {
      const index = chain[k];
      if (index !== undefined) depths[index] = depth++;
    }
    chain.length = 0;
  }
  return depths;
}
