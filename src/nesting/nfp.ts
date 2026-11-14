import { EndType, FillRule, JoinType, area, difference, inflatePaths, minkowskiSum, union } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';

/**
 * No-fit polygons on integer coordinates.
 *
 * The Minkowski sum of two simple polygons is built from their convolution
 * (Guibas, Ramshaw and Stolfi 1983): a set of closed cycles whose winding
 * number is non-zero exactly on the sum. The cycles are traced here and
 * clipper2 resolves them with a non-zero union. For ordinary parts the number
 * of cycle segments is close to n + m instead of the n * m quads of the
 * boundary-sweep construction, which makes this the hot path's fast path.
 */

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A polygon to nest: one simple outer ring and the pockets inside it. */
export interface NestPoly {
  /** Positive orientation (clipper's `area` > 0), no collinear vertices. */
  readonly outer: Path64;
  /** Free pockets, negative orientation. */
  readonly holes: Paths64;
  readonly bounds: Box;
  readonly holeBounds: readonly Box[];
}

const MITER_LIMIT = 2;

export function boxOf(path: Path64): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function negatePath(path: Path64): Path64 {
  const out: Path64 = new Array<Path64[number]>(path.length);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p !== undefined) out[i] = { x: -p.x, y: -p.y };
  }
  return out;
}

export function translatePaths(paths: Paths64, dx: number, dy: number): Paths64 {
  const out: Paths64 = new Array<Path64>(paths.length);
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path === undefined) continue;
    const moved: Path64 = new Array<Path64[number]>(path.length);
    for (let j = 0; j < path.length; j++) {
      const p = path[j];
      if (p !== undefined) moved[j] = { x: p.x + dx, y: p.y + dy };
    }
    out[i] = moved;
  }
  return out;
}

/**
 * Drops repeated points and vertices that do not turn (collinear points and
 * zero-width spikes). Returns null when fewer than three vertices remain.
 */
export function cleanRing(path: Path64): Path64 | null {
  let ring: Path64 = [];
  for (const p of path) {
    const last = ring[ring.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) continue;
    ring.push({ x: p.x, y: p.y });
  }
  for (;;) {
    const n = ring.length;
    if (n < 3) return null;
    const next: Path64 = [];
    for (let i = 0; i < n; i++) {
      const a = ring[(i + n - 1) % n];
      const b = ring[i];
      const c = ring[(i + 1) % n];
      if (a === undefined || b === undefined || c === undefined) continue;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross !== 0) next.push(b);
    }
    if (next.length === n) return ring;
    ring = next;
  }
}

/**
 * Is direction d inside the turn a vertex makes from direction a (incoming
 * edge) to direction b (outgoing edge)? `turn` is cross(a, b), never zero.
 * Ties, where d is parallel to a or b, are settled by `includeIncoming`.
 */
function inTurn(
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  turn: number,
  includeIncoming: boolean,
): boolean {
  const ad = ax * dy - ay * dx;
  if (ad === 0 && ax * dx + ay * dy > 0) return includeIncoming;
  const db = dx * by - dy * bx;
  if (db === 0 && bx * dx + by * dy > 0) return !includeIncoming;
  return turn > 0 ? ad > 0 && db > 0 : ad < 0 && db < 0;
}

/**
 * Convolution cycles of two rings. Each ring must be free of repeated and
 * non-turning vertices (see `cleanRing`). The winding number of the cycles at
 * a point t counts how the rings' regions meet when one is offset by t: with
 * two positively oriented rings it is non-zero exactly on their Minkowski sum.
 *
 * A segment `edge of P + vertex of Q` belongs to the convolution when the
 * edge's direction lies inside the turn Q makes at that vertex, and it runs
 * backwards when that turn is a right turn; the same holds with P and Q
 * swapped. Parallel edges are tie-broken as if Q were rotated by a vanishing
 * angle, which keeps every state's in- and out-degree equal.
 *
 * Returns null if the segments do not close into cycles (never seen, but the
 * caller has an exact fallback).
 */
export function convolutionCycles(p: Path64, q: Path64): Paths64 | null {
  const n = p.length;
  const m = q.length;
  if (n < 3 || m < 3) return null;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const qx = new Float64Array(m);
  const qy = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const v = p[i];
    if (v === undefined) return null;
    px[i] = v.x;
    py[i] = v.y;
  }
  for (let j = 0; j < m; j++) {
    const v = q[j];
    if (v === undefined) return null;
    qx[j] = v.x;
    qy[j] = v.y;
  }
  // Edge i runs from vertex i to vertex i + 1.
  const pdx = new Float64Array(n);
  const pdy = new Float64Array(n);
  const qdx = new Float64Array(m);
  const qdy = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const k = i + 1 === n ? 0 : i + 1;
    pdx[i] = (px[k] as number) - (px[i] as number);
    pdy[i] = (py[k] as number) - (py[i] as number);
  }
  for (let j = 0; j < m; j++) {
    const k = j + 1 === m ? 0 : j + 1;
    qdx[j] = (qx[k] as number) - (qx[j] as number);
    qdy[j] = (qy[k] as number) - (qy[j] as number);
  }
  const pTurn = new Float64Array(n);
  const qTurn = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const h = i === 0 ? n - 1 : i - 1;
    pTurn[i] = (pdx[h] as number) * (pdy[i] as number) - (pdy[h] as number) * (pdx[i] as number);
    if (pTurn[i] === 0) return null;
  }
  for (let j = 0; j < m; j++) {
    const h = j === 0 ? m - 1 : j - 1;
    qTurn[j] = (qdx[h] as number) * (qdy[j] as number) - (qdy[h] as number) * (qdx[j] as number);
    if (qTurn[j] === 0) return null;
  }

  // State (i, j) stands for the point p[i] + q[j]. Up to four segments leave it.
  const states = n * m;
  const outs = new Int32Array(states * 4);
  const outCount = new Uint8Array(states);
  const inCount = new Uint8Array(states);
  const link = (from: number, to: number): void => {
    const used = outCount[from] as number;
    outs[from * 4 + used] = to;
    outCount[from] = used + 1;
    inCount[to] = (inCount[to] as number) + 1;
  };
  for (let i = 0; i < n; i++) {
    const ih = i === 0 ? n - 1 : i - 1;
    const in1 = i + 1 === n ? 0 : i + 1;
    const ax = pdx[ih] as number;
    const ay = pdy[ih] as number;
    const bx = pdx[i] as number;
    const by = pdy[i] as number;
    const tp = pTurn[i] as number;
    for (let j = 0; j < m; j++) {
      const jh = j === 0 ? m - 1 : j - 1;
      const jn1 = j + 1 === m ? 0 : j + 1;
      const cx = qdx[jh] as number;
      const cy = qdy[jh] as number;
      const ex = qdx[j] as number;
      const ey = qdy[j] as number;
      const tq = qTurn[j] as number;
      const s = i * m + j;
      // Edge i of P carried by vertex j of Q.
      if (inTurn(bx, by, cx, cy, ex, ey, tq, tq > 0)) {
        const t = in1 * m + j;
        if (tq > 0) link(s, t);
        else link(t, s);
      }
      // Edge j of Q carried by vertex i of P.
      if (inTurn(ex, ey, ax, ay, bx, by, tp, tp < 0)) {
        const t = i * m + jn1;
        if (tp > 0) link(s, t);
        else link(t, s);
      }
    }
  }
  for (let s = 0; s < states; s++) {
    if (outCount[s] !== inCount[s]) return null;
  }
  const cycles: Paths64 = [];
  for (let start = 0; start < states; start++) {
    while ((outCount[start] as number) > 0) {
      const cycle: Path64 = [];
      let s = start;
      do {
        const i = Math.floor(s / m);
        const j = s - i * m;
        cycle.push({ x: (px[i] as number) + (qx[j] as number), y: (py[i] as number) + (qy[j] as number) });
        const left = outCount[s] as number;
        if (left === 0) return null;
        outCount[s] = left - 1;
        s = outs[s * 4 + left - 1] as number;
      } while (s !== start);
      if (cycle.length >= 3) cycles.push(cycle);
    }
  }
  return cycles;
}

function translated(path: Path64, dx: number, dy: number): Path64 {
  return path.map((v) => ({ x: v.x + dx, y: v.y + dy }));
}

/**
 * Minkowski sum of two simple polygons, as a region: every p + q with p in P
 * and q in Q. Either winding is accepted for the inputs.
 */
export function minkowskiSumRegion(p: Path64, q: Path64): Paths64 {
  const pp = area(p) < 0 ? [...p].reverse() : p;
  const qq = area(q) < 0 ? [...q].reverse() : q;
  const cycles = convolutionCycles(pp, qq);
  if (cycles !== null) return union(cycles, FillRule.NonZero);
  return sweepSumRegion(pp, qq);
}

/**
 * The same sum by brute force: the sweep of one boundary along the other,
 * plus each polygon carried by one vertex of the other. Two connected regions
 * overlap only if their boundaries cross or one holds a boundary vertex of
 * the other, so these three terms cover the whole sum. Slow (n * m quads) but
 * free of the convolution's preconditions; also the reference in the tests.
 */
export function sweepSumRegion(p: Path64, q: Path64): Paths64 {
  const p0 = p[0];
  const q0 = q[0];
  if (p0 === undefined || q0 === undefined) return [];
  const pieces: Paths64 = [...minkowskiSum(q, p, true), translated(p, q0.x, q0.y), translated(q, p0.x, p0.y)];
  return union(pieces, FillRule.NonZero);
}

/**
 * Every offset t that puts `shape + t` completely inside the simple polygon
 * `pocket`, loosened by `eps` so that an exact fit survives as a sliver.
 *
 * The pocket ring is walked as the boundary of its complement (negative
 * orientation). The convolution with the mirrored shape then has winding
 * number -1 exactly where the shape misses the complement altogether, 0 where
 * it pokes out once and more where it pokes out several times, so the answer
 * is the negative-winding region.
 */
export function insideFitRegion(pocket: Path64, shape: Path64, eps: number): Paths64 {
  let hole = area(pocket) > 0 ? [...pocket].reverse() : pocket;
  if (eps > 0) {
    const grown = inflatePaths([hole], eps, JoinType.Miter, EndType.Polygon, MITER_LIMIT);
    const ring = grown.length === 1 && grown[0] !== undefined ? cleanRing(grown[0]) : null;
    if (ring !== null) hole = area(ring) > 0 ? ring.reverse() : ring;
  }
  const pb = boxOf(hole);
  const sb = boxOf(shape);
  if (sb.maxX - sb.minX > pb.maxX - pb.minX || sb.maxY - sb.minY > pb.maxY - pb.minY) return [];
  const solid = area(shape) < 0 ? [...shape].reverse() : shape;
  const mirrored = negatePath(solid);
  const cycles = convolutionCycles(hole, mirrored);
  if (cycles !== null) return union(cycles, FillRule.Negative);
  // Brute force: the shape's first vertex is inside and the boundaries do not cross.
  const first = solid[0];
  if (first === undefined) return [];
  return difference([translated(hole, -first.x, -first.y)], minkowskiSum(mirrored, hole, true), FillRule.NonZero);
}

/** The same region by brute force, for the tests. */
export function insideFitRegionBySweep(pocket: Path64, shape: Path64): Paths64 {
  const first = shape[0];
  if (first === undefined) return [];
  return difference(
    [translated(pocket, -first.x, -first.y)],
    minkowskiSum(negatePath(shape), pocket, true),
    FillRule.NonZero,
  );
}

function fitsInside(inner: Box, outer: Box, eps: number): boolean {
  return (
    inner.maxX - inner.minX <= outer.maxX - outer.minX + 2 * eps &&
    inner.maxY - inner.minY <= outer.maxY - outer.minY + 2 * eps
  );
}

/**
 * The no-fit region of `b` around `a`: every offset t at which `b + t`
 * overlaps `a`. Its outline is the classic no-fit polygon; its holes are the
 * offsets that drop `b` into a concavity or a hole of `a` (or `a` into a hole
 * of `b`).
 *
 * With `eps` above zero the fixed polygon is first shrunk, and its holes
 * widened, by that much, so two parts that should only touch may overlap by
 * up to about `2 * eps`. Without that tolerance a slot exactly as wide as
 * the part has no area and would be lost.
 */
export function noFitRegion(a: NestPoly, b: NestPoly, eps: number): Paths64 {
  const mirrored = negatePath(b.outer);
  let solid: Paths64;
  if (eps > 0) {
    const pieces: Paths64 = [];
    for (const ring of inflatePaths([a.outer], -eps, JoinType.Miter, EndType.Polygon, MITER_LIMIT)) {
      const clean = cleanRing(ring);
      if (clean === null) continue;
      for (const path of minkowskiSumRegion(clean, mirrored)) pieces.push(path);
    }
    solid = pieces;
    // A neck thinner than the tolerance splits the polygon; its pieces' sums overlap.
    if (pieces.filter((ring) => area(ring) > 0).length > 1) solid = union(pieces, FillRule.NonZero);
  } else {
    solid = minkowskiSumRegion(a.outer, mirrored);
  }
  const pockets: Paths64 = [];
  for (let i = 0; i < a.holes.length; i++) {
    const hole = a.holes[i];
    const box = a.holeBounds[i];
    if (hole === undefined || box === undefined || !fitsInside(b.bounds, box, eps)) continue;
    for (const path of insideFitRegion(hole, b.outer, eps)) pockets.push(path);
  }
  for (let i = 0; i < b.holes.length; i++) {
    const hole = b.holes[i];
    const box = b.holeBounds[i];
    if (hole === undefined || box === undefined || !fitsInside(a.bounds, box, eps)) continue;
    // `a + s` inside the hole of `b` means `b` sits at offset -s around `a`.
    for (const path of insideFitRegion(hole, a.outer, eps)) pockets.push(negatePath(path));
  }
  return pockets.length === 0 ? solid : difference(solid, pockets, FillRule.NonZero);
}
