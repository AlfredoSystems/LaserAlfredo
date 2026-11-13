import type { Point, Polyline } from '../model/types';

export const DEFAULT_JOIN_TOLERANCE_MM = 0.01;

/** Grid cell size used when the tolerance is zero. */
const MIN_CELL_MM = 1e-9;

function saneTolerance(toleranceMm: number): number {
  return Number.isFinite(toleranceMm) && toleranceMm > 0 ? toleranceMm : 0;
}

function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function cellKey(ix: number, iy: number): number {
  return Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663);
}

function near(a: Point, b: Point, tolSq: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= tolSq;
}

/**
 * Removes consecutive points closer than the tolerance (keeping the first of
 * each run) and, for closed paths, trailing points that coincide with the
 * first. Non-finite points are dropped.
 */
export function cleanPolyline(points: readonly Point[], closed: boolean, toleranceMm: number): Point[] {
  const tol = saneTolerance(toleranceMm);
  const tolSq = tol * tol;
  const out: Point[] = [];
  let last: Point | undefined;
  for (const p of points) {
    if (!isFinitePoint(p)) continue;
    if (last !== undefined && near(p, last, tolSq)) continue;
    out.push(p);
    last = p;
  }
  if (closed) {
    const first = out[0];
    while (out.length > 1 && first !== undefined) {
      const tail = out[out.length - 1];
      if (tail === undefined || !near(tail, first, tolSq)) break;
      out.pop();
    }
  }
  return out;
}

interface Link {
  readonly seg: number;
  readonly reversed: boolean;
}

/**
 * Joins open paths whose endpoints lie within the tolerance into longer
 * chains, reversing paths as needed. A chain whose two ends meet becomes
 * closed (the duplicated end point is dropped), as does a single open path
 * whose own ends coincide and that has at least 3 distinct points. Closed
 * inputs, and open inputs that join nothing, pass through untouched. `make`
 * builds each joined path from the first input path of its chain. Output order
 * follows the first input path of each chain. Where 3 or more endpoints meet,
 * the nearest unused one wins (ties go to the earlier input).
 */
export function joinPolylines<T extends Polyline>(
  paths: readonly T[],
  toleranceMm: number,
  make: (points: Point[], closed: boolean, source: T) => T,
): T[] {
  const tol = saneTolerance(toleranceMm);
  const tolSq = tol * tol;
  const cell = tol > 0 ? tol : MIN_CELL_MM;
  const count = paths.length;

  // Endpoint id = segment index * 2 + (0 for the start, 1 for the end).
  const endX = new Float64Array(count * 2);
  const endY = new Float64Array(count * 2);
  const joinable = new Uint8Array(count);
  const used = new Uint8Array(count);
  const grid = new Map<number, number[]>();

  const addEndpoint = (id: number, p: Point): void => {
    endX[id] = p.x;
    endY[id] = p.y;
    const key = cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [id]);
    else bucket.push(id);
  };

  for (let i = 0; i < count; i++) {
    const path = paths[i];
    if (path === undefined || path.closed || path.points.length < 2) continue;
    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    if (first === undefined || last === undefined || !isFinitePoint(first) || !isFinitePoint(last)) continue;
    joinable[i] = 1;
    addEndpoint(i * 2, first);
    addEndpoint(i * 2 + 1, last);
  }

  let foundId = -1;
  let foundDistSq = Infinity;
  /** Finds the nearest endpoint of an unused segment within tolerance of (x, y). */
  const findNearest = (x: number, y: number): void => {
    foundId = -1;
    foundDistSq = Infinity;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(cellKey(cx + ox, cy + oy));
        if (bucket === undefined) continue;
        // Compact away endpoints of used segments while scanning.
        let write = 0;
        for (const id of bucket) {
          if (used[id >> 1] === 1) continue;
          bucket[write++] = id;
          const dx = (endX[id] ?? 0) - x;
          const dy = (endY[id] ?? 0) - y;
          const distSq = dx * dx + dy * dy;
          if (distSq > tolSq) continue;
          if (distSq < foundDistSq || (distSq === foundDistSq && id < foundId)) {
            foundId = id;
            foundDistSq = distSq;
          }
        }
        bucket.length = write;
      }
    }
  };

  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const seed = paths[i];
    if (seed === undefined) continue;
    if (joinable[i] !== 1) {
      result.push(seed);
      continue;
    }
    if (used[i] === 1) continue;
    used[i] = 1;

    const tailLinks: Link[] = [];
    const headLinks: Link[] = [];
    let headX = endX[i * 2] ?? 0;
    let headY = endY[i * 2] ?? 0;
    let tailX = endX[i * 2 + 1] ?? 0;
    let tailY = endY[i * 2 + 1] ?? 0;
    let pointCount = seed.points.length;
    let closed = false;

    // Grow the chain at its tail, then at its head.
    for (let side = 0; side < 2 && !closed; side++) {
      const atTail = side === 0;
      for (;;) {
        const x = atTail ? tailX : headX;
        const y = atTail ? tailY : headY;
        findNearest(x, y);
        const gapX = tailX - headX;
        const gapY = tailY - headY;
        const gapSq = gapX * gapX + gapY * gapY;
        // Close the chain when its own other end is at least as near as any candidate.
        if (pointCount >= 4 && gapSq <= tolSq && (foundId < 0 || gapSq <= foundDistSq)) {
          closed = true;
          break;
        }
        if (foundId < 0) break;
        const seg = foundId >> 1;
        const matchedEnd = (foundId & 1) === 1;
        const farId = matchedEnd ? seg * 2 : seg * 2 + 1;
        used[seg] = 1;
        pointCount += (paths[seg]?.points.length ?? 1) - 1;
        if (atTail) {
          tailLinks.push({ seg, reversed: matchedEnd });
          tailX = endX[farId] ?? 0;
          tailY = endY[farId] ?? 0;
        } else {
          headLinks.push({ seg, reversed: !matchedEnd });
          headX = endX[farId] ?? 0;
          headY = endY[farId] ?? 0;
        }
      }
    }

    if (!closed && tailLinks.length === 0 && headLinks.length === 0) {
      result.push(seed);
      continue;
    }

    const links: Link[] = headLinks.reverse();
    links.push({ seg: i, reversed: false });
    for (const link of tailLinks) links.push(link);
    const points: Point[] = [];
    for (const link of links) {
      const source = paths[link.seg]?.points ?? [];
      // Skip the junction point of every path after the first.
      const skip = points.length === 0 ? 0 : 1;
      if (link.reversed) {
        for (let j = source.length - 1 - skip; j >= 0; j--) {
          const p = source[j];
          if (p !== undefined) points.push(p);
        }
      } else {
        for (let j = skip; j < source.length; j++) {
          const p = source[j];
          if (p !== undefined) points.push(p);
        }
      }
    }

    if (closed) {
      const ring = points.slice(0, -1);
      if (cleanPolyline(ring, true, tol).length >= 3) {
        result.push(make(ring, true, seed));
        continue;
      }
      if (links.length === 1) {
        result.push(seed);
        continue;
      }
    }
    result.push(make(points, false, seed));
  }
  return result;
}

function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function matchesFrom(a: readonly Point[], b: readonly Point[], offset: number, step: 1 | -1, tolSq: number): boolean {
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = b[(((offset + step * i) % n) + n) % n];
    if (p === undefined || q === undefined || !near(p, q, tolSq)) return false;
  }
  return true;
}

function samePath(a: Polyline, b: Polyline, tolSq: number): boolean {
  const n = a.points.length;
  if (a.closed !== b.closed || n !== b.points.length) return false;
  if (!a.closed) {
    return matchesFrom(a.points, b.points, 0, 1, tolSq) || matchesFrom(a.points, b.points, n - 1, -1, tolSq);
  }
  const first = a.points[0];
  if (first === undefined) return false;
  for (let k = 0; k < n; k++) {
    const q = b.points[k];
    if (q === undefined || !near(first, q, tolSq)) continue;
    if (matchesFrom(a.points, b.points, k, 1, tolSq) || matchesFrom(a.points, b.points, k, -1, tolSq)) return true;
  }
  return false;
}

/**
 * Drops paths that duplicate an earlier path: the same point sequence within
 * the tolerance, forward or reversed, and for closed paths from any cyclic
 * start. Candidates are found by hashing each path's centroid (which does not
 * depend on direction or start point) and then verified point by point.
 */
export function removeDuplicatePolylines<T extends Polyline>(paths: readonly T[], toleranceMm: number): T[] {
  const tol = saneTolerance(toleranceMm);
  const tolSq = tol * tol;
  const cell = tol > 0 ? tol : MIN_CELL_MM;
  const grid = new Map<number, T[]>();
  const result: T[] = [];
  for (const path of paths) {
    if (path.points.length === 0) {
      result.push(path);
      continue;
    }
    const c = centroid(path.points);
    if (!isFinitePoint(c)) {
      result.push(path);
      continue;
    }
    const cx = Math.floor(c.x / cell);
    const cy = Math.floor(c.y / cell);
    let duplicate = false;
    for (let ox = -1; ox <= 1 && !duplicate; ox++) {
      for (let oy = -1; oy <= 1 && !duplicate; oy++) {
        const bucket = grid.get(cellKey(cx + ox, cy + oy));
        if (bucket === undefined) continue;
        for (const kept of bucket) {
          if (samePath(path, kept, tolSq)) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) continue;
    result.push(path);
    const key = cellKey(cx, cy);
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [path]);
    else bucket.push(path);
  }
  return result;
}
