import type { Point, Polyline } from '../model/types';
import { containmentParents } from './containment';

export interface OrderedPath {
  readonly points: readonly Point[];
  readonly closed: boolean;
  /** Index of this path in the input array. */
  readonly sourceIndex: number;
}

/** Upper limit on grid cells, to bound memory on huge inputs. */
const MAX_GRID_CELLS = 1 << 18;

function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Puts the paths in cutting order. Every non-empty path is returned exactly
 * once. A closed path is cut only after everything it contains (see
 * `containmentParents`), so parts don't drop before their holes are cut.
 * Within that rule travel is minimised greedily: the nearest available path
 * is cut next. Open paths may be reversed to enter at their nearer end; closed
 * paths are rotated to start (and end) at their vertex nearest the head, with
 * the winding direction kept. Ties go to the lower input index.
 *
 * Paths without a usable entry point (non-finite coordinates) are emitted
 * first, unchanged and in input order, and do not move the head.
 */
export function orderForCutting(paths: readonly Polyline[], start: Point): OrderedPath[] {
  const count = paths.length;
  const result: OrderedPath[] = [];
  const parents = containmentParents(paths);
  const done = new Uint8Array(count);
  /** Number of not-yet-cut children. A path is available when this is 0. */
  const pending = new Int32Array(count);

  // Entry points: both ends of an open path, every finite vertex of a closed one.
  let entryCount = 0;
  let routable = 0;
  for (let i = 0; i < count; i++) {
    const path = paths[i];
    const first = path?.points[0];
    if (path === undefined || first === undefined) {
      done[i] = 1;
      continue;
    }
    let entries = 0;
    if (path.closed) {
      for (const p of path.points) if (isFinitePoint(p)) entries++;
    } else {
      const last = path.points[path.points.length - 1];
      if (last !== undefined && isFinitePoint(first) && isFinitePoint(last)) {
        entries = path.points.length > 1 ? 2 : 1;
      }
    }
    if (entries === 0) {
      done[i] = 1;
      result.push({ points: path.points, closed: path.closed, sourceIndex: i });
      continue;
    }
    entryCount += entries;
    routable++;
    const parent = parents[i] ?? -1;
    if (parent >= 0) pending[parent] = (pending[parent] ?? 0) + 1;
  }
  if (routable === 0) return result;

  const entryX = new Float64Array(entryCount);
  const entryY = new Float64Array(entryCount);
  const entryPath = new Int32Array(entryCount);
  const entryVertex = new Int32Array(entryCount);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let next = 0;
  const addEntry = (pathIndex: number, vertex: number, p: Point): void => {
    entryX[next] = p.x;
    entryY[next] = p.y;
    entryPath[next] = pathIndex;
    entryVertex[next] = vertex;
    next++;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (let i = 0; i < count; i++) {
    const path = paths[i];
    if (path === undefined || done[i] === 1) continue;
    const points = path.points;
    if (path.closed) {
      for (let v = 0; v < points.length; v++) {
        const p = points[v];
        if (p !== undefined && isFinitePoint(p)) addEntry(i, v, p);
      }
    } else {
      const first = points[0];
      const last = points[points.length - 1];
      if (first !== undefined) addEntry(i, 0, first);
      if (last !== undefined && points.length > 1) addEntry(i, points.length - 1, last);
    }
  }

  // Uniform grid over the entry points, stored as one flat array with a
  // segment per cell (counting sort). Entries of finished paths are swapped
  // out of their segment as they are met.
  const width = maxX - minX;
  const height = maxY - minY;
  const targetCells = clamp(entryCount, 1, MAX_GRID_CELLS);
  let cell = Math.sqrt((width * height) / targetCells);
  if (!(cell > 0)) cell = Math.max(width, height) / targetCells;
  if (!(cell > 0) || !Number.isFinite(cell)) cell = 1;
  const cols = Math.floor(width / cell) + 1;
  const rows = Math.floor(height / cell) + 1;
  const cellOf = (x: number, y: number): number =>
    clamp(Math.floor((y - minY) / cell), 0, rows - 1) * cols + clamp(Math.floor((x - minX) / cell), 0, cols - 1);

  const cellStart = new Int32Array(cols * rows + 1);
  for (let e = 0; e < entryCount; e++) {
    const c = cellOf(entryX[e] ?? 0, entryY[e] ?? 0) + 1;
    cellStart[c] = (cellStart[c] ?? 0) + 1;
  }
  for (let c = 1; c <= cols * rows; c++) cellStart[c] = (cellStart[c] ?? 0) + (cellStart[c - 1] ?? 0);
  const cellLength = new Int32Array(cols * rows);
  const items = new Int32Array(entryCount);
  for (let e = 0; e < entryCount; e++) {
    const c = cellOf(entryX[e] ?? 0, entryY[e] ?? 0);
    const length = cellLength[c] ?? 0;
    items[(cellStart[c] ?? 0) + length] = e;
    cellLength[c] = length + 1;
  }

  let headX = Number.isFinite(start.x) ? start.x : 0;
  let headY = Number.isFinite(start.y) ? start.y : 0;
  let bestEntry = -1;
  let bestDistSq = Infinity;

  const scanCell = (c: number): void => {
    const base = cellStart[c] ?? 0;
    let length = cellLength[c] ?? 0;
    let i = 0;
    while (i < length) {
      const e = items[base + i] ?? 0;
      const pathIndex = entryPath[e] ?? 0;
      if (done[pathIndex] === 1) {
        length--;
        items[base + i] = items[base + length] ?? 0;
        continue;
      }
      i++;
      if ((pending[pathIndex] ?? 0) > 0) continue;
      const dx = (entryX[e] ?? 0) - headX;
      const dy = (entryY[e] ?? 0) - headY;
      const distSq = dx * dx + dy * dy;
      if (distSq > bestDistSq) continue;
      if (distSq === bestDistSq) {
        // Scan order is arbitrary, so ties are settled by input position.
        const bestPath = entryPath[bestEntry] ?? 0;
        if (pathIndex > bestPath) continue;
        if (pathIndex === bestPath && (entryVertex[e] ?? 0) > (entryVertex[bestEntry] ?? 0)) continue;
      }
      bestEntry = e;
      bestDistSq = distSq;
    }
    cellLength[c] = length;
  };

  /** Finds the nearest entry point of an available path, searching outward ring by ring. */
  const findNearest = (): void => {
    bestEntry = -1;
    bestDistSq = Infinity;
    // A head outside the grid is treated as its nearest point on the grid,
    // which never overestimates the distance to anything inside.
    const cx = clamp(Math.floor((headX - minX) / cell), 0, cols - 1);
    const cy = clamp(Math.floor((headY - minY) / cell), 0, rows - 1);
    const maxRing = Math.max(cx, cols - 1 - cx, cy, rows - 1 - cy);
    for (let r = 0; r <= maxRing; r++) {
      // Every cell of ring r is at least (r - 1) cells away from the head.
      const reach = (r - 1) * cell;
      if (bestEntry >= 0 && reach > 0 && bestDistSq < reach * reach) break;
      const y0 = Math.max(0, cy - r);
      const y1 = Math.min(rows - 1, cy + r);
      const x0 = Math.max(0, cx - r);
      const x1 = Math.min(cols - 1, cx + r);
      for (let y = y0; y <= y1; y++) {
        const row = y * cols;
        if (y === cy - r || y === cy + r) {
          for (let x = x0; x <= x1; x++) scanCell(row + x);
        } else {
          if (cx - r >= 0) scanCell(row + cx - r);
          if (cx + r < cols) scanCell(row + cx + r);
        }
      }
    }
  };

  const finish = (pathIndex: number): void => {
    done[pathIndex] = 1;
    const parent = parents[pathIndex] ?? -1;
    if (parent >= 0) pending[parent] = (pending[parent] ?? 0) - 1;
  };

  for (let step = 0; step < routable; step++) {
    findNearest();
    if (bestEntry < 0) break;
    const pathIndex = entryPath[bestEntry] ?? 0;
    const vertex = entryVertex[bestEntry] ?? 0;
    const path = paths[pathIndex];
    if (path === undefined) break;
    const points = path.points;
    let ordered: readonly Point[] = points;
    if (path.closed) {
      if (vertex > 0) ordered = [...points.slice(vertex), ...points.slice(0, vertex)];
      headX = entryX[bestEntry] ?? headX;
      headY = entryY[bestEntry] ?? headY;
    } else {
      if (vertex > 0) ordered = [...points].reverse();
      const exit = ordered[ordered.length - 1];
      if (exit !== undefined) {
        headX = exit.x;
        headY = exit.y;
      }
    }
    result.push({ points: ordered, closed: path.closed, sourceIndex: pathIndex });
    finish(pathIndex);
  }

  // Unreachable for a containment forest; kept so no path can ever be lost.
  for (let i = 0; i < count; i++) {
    const path = paths[i];
    if (path === undefined || done[i] === 1) continue;
    result.push({ points: path.points, closed: path.closed, sourceIndex: i });
  }
  return result;
}

/**
 * Total laser-off distance: from `start` to the first path's first point, then
 * from each path's exit (last point when open, first point when closed) to the
 * next path's first point. Paths without points are skipped.
 */
export function travelLength(
  ordered: readonly { readonly points: readonly Point[]; readonly closed: boolean }[],
  start: Point,
): number {
  let head = start;
  let total = 0;
  for (const path of ordered) {
    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    if (first === undefined || last === undefined) continue;
    total += Math.hypot(first.x - head.x, first.y - head.y);
    head = path.closed ? first : last;
  }
  return total;
}

/** Length of the path, including the closing segment when it is closed. */
export function cutLength(path: { readonly points: readonly Point[]; readonly closed: boolean }): number {
  const points = path.points;
  const first = points[0];
  if (first === undefined) return 0;
  let total = 0;
  let prev = first;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    if (cur === undefined) continue;
    total += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  if (path.closed) total += Math.hypot(first.x - prev.x, first.y - prev.y);
  return total;
}
