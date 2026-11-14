import { EndType, FillRule, JoinType, area, difference, inflatePaths, union } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import { applyToPoint, rotation } from '../model/transform';
import type { Point } from '../model/types';
import { boxOf, cleanRing, noFitRegion } from './nfp';
import type { Box, NestPoly } from './nfp';
import type { NestOptions, NestPart } from './types';

/**
 * Part preparation: turns each part, at each allowed rotation, into an
 * integer "nest polygon" that contains the true part grown by half the
 * spacing, and caches the no-fit regions between those polygons.
 */

/** Outlines are simplified to within this distance before nesting. */
const SIMPLIFY_MM = 0.1;
/**
 * An outline that still has more vertices than this is simplified further,
 * doubling the tolerance up to `MAX_SIMPLIFY_MM`: no-fit polygons of very
 * detailed outlines are too slow to stay interactive.
 */
const MAX_VERTICES = 120;
const MAX_SIMPLIFY_MM = 1.6;
/** Half-width of the strip that stands in for a path without area. */
const MIN_STRIP_MM = 0.01;
/** No-fit regions are shrunk by this many integer units (see `noFitRegion`). */
export const FIT_EPS = 2;
/** Most rotations tried per part; a finer step is thinned out to this many. */
const MAX_ROTATIONS = 72;
/**
 * Largest job span in integer units. Differences between coordinates reach
 * about three times this, and clipper multiplies them without BigInt up to
 * roughly 9e7.
 */
const MAX_UNITS = 3e7;
const MITER_LIMIT = 2;

/** A nest polygon in the store. It equals `turn(base, k) - (cx, cy)`. */
interface StoredPoly extends NestPoly {
  readonly id: number;
  /** A polygon that is not a quarter-turn of an earlier one is its own base. */
  readonly baseId: number;
  readonly k: number;
  readonly cx: number;
  readonly cy: number;
}

/** One part in one allowed rotation. All lengths are integer units. */
export interface PartRotation {
  /** Unique across all parts and rotations. */
  readonly rid: number;
  readonly polyId: number;
  readonly rotationDeg: number;
  /**
   * The rotated true geometry, in units, minus this offset gives coordinates
   * relative to the nest polygon's reference vertex.
   */
  readonly ox: number;
  readonly oy: number;
  /** Bounding box of the true outline relative to the reference vertex. */
  readonly tMinX: number;
  readonly tMaxX: number;
  readonly tMinY: number;
  readonly tMaxY: number;
  /** Centroid of the true outline relative to the reference vertex. */
  readonly cx: number;
  readonly cy: number;
}

export interface PreparedPart {
  readonly index: number;
  readonly id: string;
  readonly count: number;
  /** Distinct rotations that fit an empty sheet. Empty: the part cannot be placed. */
  readonly rotations: readonly PartRotation[];
  /** Area of the outline in mm², 0 for an open path. */
  readonly areaMm2: number;
  /** Material the part is sure to cover, in square units; used to skip full sheets. */
  readonly solidArea: number;
}

export interface Prepared {
  /** Integer units per millimetre. */
  readonly scale: number;
  readonly parts: readonly PreparedPart[];
  /** Usable sheet rectangle (inside the margin) in units. */
  readonly sheet: Box;
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
  /** Nest polygon `polyId`, with its reference vertex at the origin. */
  poly(polyId: number): NestPoly;
  /**
   * No-fit region of moving polygon `b` around fixed polygon `a`, loosened
   * by `FIT_EPS`: the positions of the reference vertex of b that make it
   * overlap `a` when the reference vertex of a is at (x, y).
   */
  nfp(a: number, b: number, x?: number, y?: number): Paths64;
  /** The same region without the loosening. */
  exactNfp(a: number, b: number, x?: number, y?: number): Paths64;
  /** Is b, with its reference vertex offset by (dx, dy) from that of a, strictly inside the exact no-fit region? */
  overlaps(a: number, b: number, dx: number, dy: number): boolean;
}

/** A region stored compactly: each ring as x0, y0, x1, y1, ... */
interface PackedRegion {
  readonly rings: Int32Array[];
  /** True for outer rings, false for holes. */
  readonly outer: boolean[];
}

/** A no-fit region as a stored region turned by k quarter turns, then shifted. */
interface Resolved {
  readonly region: PackedRegion;
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

function pack(paths: Paths64): PackedRegion {
  const rings: Int32Array[] = [];
  const outer: boolean[] = [];
  for (const path of paths) {
    const ring = new Int32Array(path.length * 2);
    path.forEach((p, i) => {
      ring[2 * i] = p.x;
      ring[2 * i + 1] = p.y;
    });
    rings.push(ring);
    outer.push(area(path) > 0);
  }
  return { rings, outer };
}

function unpack(found: Resolved, x: number, y: number): Paths64 {
  const tx = found.tx + x;
  const ty = found.ty + y;
  const k = found.k;
  return found.region.rings.map((ring) => {
    const path: Path64 = new Array<Path64[number]>(ring.length / 2);
    for (let i = 0; i < path.length; i++) {
      const px = ring[2 * i] as number;
      const py = ring[2 * i + 1] as number;
      path[i] =
        k === 0
          ? { x: px + tx, y: py + ty }
          : k === 1
            ? { x: tx - py, y: px + ty }
            : k === 2
              ? { x: tx - px, y: ty - py }
              : { x: py + tx, y: ty - px };
    }
    return path;
  });
}

/** Where a point lies relative to a ring: 1 inside, 0 on the boundary, -1 outside. */
function locate(ring: Int32Array, x: number, y: number): number {
  const n = ring.length / 2;
  let inside = false;
  let ax = ring[2 * n - 2] as number;
  let ay = ring[2 * n - 1] as number;
  for (let i = 0; i < n; i++) {
    const bx = ring[2 * i] as number;
    const by = ring[2 * i + 1] as number;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) {
      return 0;
    }
    if (ay > y !== by > y && (by > ay ? cross > 0 : cross < 0)) inside = !inside;
    ax = bx;
    ay = by;
  }
  return inside ? 1 : -1;
}

function quarterTurn(x: number, y: number, k: number): { x: number; y: number } {
  switch (((k % 4) + 4) % 4) {
    case 1:
      return { x: -y, y: x };
    case 2:
      return { x: -x, y: -y };
    case 3:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

function turnPaths(paths: Paths64, k: number): Paths64 {
  return paths.map((path) => path.map((p) => quarterTurn(p.x, p.y, k)));
}

function distToSegmentSq(p: Path64[number], a: Path64[number], b: Path64[number]): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const len = abx * abx + aby * aby;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len));
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  return dx * dx + dy * dy;
}

/**
 * Ramer–Douglas–Peucker. Returns the kept points and how far the original
 * strays from the result, so the caller can grow the result by that much.
 */
export function simplifyPath(points: Path64, tolerance: number, closed: boolean): { path: Path64; deviation: number } {
  const n = points.length;
  if (n <= (closed ? 4 : 2)) return { path: points, deviation: 0 };
  const work = closed ? [...points, points[0] as Path64[number]] : points;
  const keep = new Uint8Array(work.length);
  const ranges: [number, number][] = [];
  if (closed) {
    // Split the ring at the vertex farthest from the first one.
    const first = work[0] as Path64[number];
    let far = 1;
    let farDist = -1;
    for (let i = 1; i < n; i++) {
      const p = work[i] as Path64[number];
      const d = (p.x - first.x) * (p.x - first.x) + (p.y - first.y) * (p.y - first.y);
      if (d > farDist) {
        farDist = d;
        far = i;
      }
    }
    keep[0] = 1;
    keep[far] = 1;
    keep[n] = 1;
    ranges.push([0, far], [far, n]);
  } else {
    keep[0] = 1;
    keep[n - 1] = 1;
    ranges.push([0, n - 1]);
  }
  const tolSq = tolerance * tolerance;
  let worst = 0;
  while (ranges.length > 0) {
    const range = ranges.pop();
    if (range === undefined) break;
    const [from, to] = range;
    if (to - from < 2) continue;
    const a = work[from] as Path64[number];
    const b = work[to] as Path64[number];
    let index = -1;
    let max = -1;
    for (let i = from + 1; i < to; i++) {
      const d = distToSegmentSq(work[i] as Path64[number], a, b);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (max > tolSq) {
      keep[index] = 1;
      ranges.push([from, index], [index, to]);
    } else if (max > worst) {
      worst = max;
    }
  }
  const path: Path64 = [];
  const last = closed ? n : work.length;
  for (let i = 0; i < last; i++) {
    if (keep[i] === 1) path.push(work[i] as Path64[number]);
  }
  return { path, deviation: Math.sqrt(worst) };
}

function convexHull(points: Path64): Path64 {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Path64[number], a: Path64[number], b: Path64[number]): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (list: Path64): Path64 => {
    const chain: Path64 = [];
    for (const p of list) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (a === undefined || b === undefined || cross(a, b, p) > 0) break;
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build(sorted.reverse())];
}

function absArea(paths: Paths64): number {
  let total = 0;
  for (const path of paths) total += area(path);
  return Math.abs(total);
}

/** The positive rings of a region; the holes are dropped. */
function outerRings(region: Paths64): Paths64 {
  return region.filter((ring) => area(ring) > 0);
}

interface IntPath {
  readonly path: Path64;
  /** True when a coordinate had to be rounded onto the integer grid. */
  readonly rounded: boolean;
}

function toInt(points: readonly Point[], scale: number): IntPath {
  const path: Path64 = [];
  let rounded = false;
  for (const p of points) {
    const fx = p.x * scale;
    const fy = p.y * scale;
    const x = Math.round(fx);
    const y = Math.round(fy);
    if (Math.abs(fx - x) > 1e-4 || Math.abs(fy - y) > 1e-4) rounded = true;
    const last = path[path.length - 1];
    if (last !== undefined && last.x === x && last.y === y) continue;
    path.push({ x, y });
  }
  return { path, rounded };
}

/** Simplifies to the base tolerance, and further while the outline stays too detailed. */
function simplifyForNesting(points: Path64, closed: boolean, scale: number): { path: Path64; deviation: number } {
  let tolerance = SIMPLIFY_MM * scale;
  let result = simplifyPath(points, tolerance, closed);
  while (result.path.length > MAX_VERTICES && tolerance * 2 <= MAX_SIMPLIFY_MM * scale + 1e-9) {
    tolerance *= 2;
    result = simplifyPath(points, tolerance, closed);
  }
  return result;
}

/**
 * The solid nest outline of a path: one simple ring that contains every point
 * within `grow` of the simplified path's region (or of the path itself when
 * it is open or has no area). Null when there is nothing to build from.
 */
function solidOutline(input: Path64, closed: boolean, grow: number, minStrip: number): Path64 | null {
  if (input.length === 0) return null;
  let region: Paths64 = [];
  const fill = closed && input.length >= 3 ? union([input], FillRule.NonZero) : [];
  if (absArea(fill) > 0) {
    region = grow > 0 ? inflatePaths(fill, grow, JoinType.Miter, EndType.Polygon, MITER_LIMIT) : fill;
  } else {
    // No area: nest a thin strip around the path.
    const path = closed && input.length >= 2 ? [...input, input[0] as Path64[number]] : input;
    region = inflatePaths([path], Math.max(grow, minStrip), JoinType.Miter, EndType.Square, MITER_LIMIT);
  }
  let rings = outerRings(union(region, FillRule.NonZero));
  if (rings.length > 1) {
    // Pieces that only touch (a figure of eight): fuse them with a little extra growth.
    rings = outerRings(
      union(inflatePaths(rings, minStrip, JoinType.Miter, EndType.Polygon, MITER_LIMIT), FillRule.NonZero),
    );
  }
  let ring: Path64 | null = null;
  if (rings.length === 1 && rings[0] !== undefined) ring = cleanRing(rings[0]);
  if (ring === null && rings.length > 0) ring = cleanRing(convexHull(rings.flat()));
  if (ring === null) return null;
  return area(ring) < 0 ? ring.reverse() : ring;
}

interface Canonical {
  readonly outer: Path64;
  readonly holes: Paths64;
  readonly refX: number;
  readonly refY: number;
  readonly key: string;
}

function startAtLowest(ring: Path64): Path64 {
  let best = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i];
    const b = ring[best];
    if (p === undefined || b === undefined) continue;
    if (p.x < b.x || (p.x === b.x && p.y < b.y)) best = i;
  }
  return [...ring.slice(best), ...ring.slice(0, best)];
}

/** Moves the polygon so its lowest (x, then y) outer vertex is the origin and builds a key that is equal for congruent polygons. */
function canonical(outer: Path64, holes: Paths64): Canonical {
  const ring = startAtLowest(outer);
  const ref = ring[0] ?? { x: 0, y: 0 };
  const move = (path: Path64): Path64 => path.map((p) => ({ x: p.x - ref.x, y: p.y - ref.y }));
  const text = (path: Path64): string => path.map((p) => `${p.x},${p.y}`).join(' ');
  const movedHoles = holes.map((hole) => move(startAtLowest(hole)));
  const keyed = movedHoles.map((hole) => ({ hole, key: text(hole) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const movedOuter = move(ring);
  return {
    outer: movedOuter,
    holes: keyed.map((entry) => entry.hole),
    refX: ref.x,
    refY: ref.y,
    key: `${text(movedOuter)}|${keyed.map((entry) => entry.key).join('|')}`,
  };
}

/**
 * The nest polygon of one part: its outline (mm, already rotated, near the
 * origin) simplified and grown by `half` units, with the usable part of each
 * hole cut out. Null when the outline has no usable geometry.
 */
function nestShape(
  outline: readonly Point[],
  isClosed: boolean,
  holes: readonly (readonly Point[])[],
  half: number,
  scale: number,
): Canonical | null {
  const minStrip = Math.max(1, MIN_STRIP_MM * scale);
  const raw = toInt(outline, scale);
  const closed = isClosed && raw.path.length >= 3;
  const simple = simplifyForNesting(raw.path, closed, scale);
  const outer = solidOutline(simple.path, closed, half + simple.deviation + (raw.rounded ? 1 : 0), minStrip);
  if (outer === null) return null;
  const free: Paths64 = [];
  if (closed) {
    for (const hole of holes) {
      const rawHole = toInt(hole, scale);
      if (rawHole.path.length < 3) continue;
      const simpleHole = simplifyForNesting(rawHole.path, true, scale);
      const fill = union([simpleHole.path], FillRule.NonZero);
      const shrinkBy = half + simpleHole.deviation + (rawHole.rounded ? 1 : 0);
      const inner = shrinkBy > 0 ? inflatePaths(fill, -shrinkBy, JoinType.Miter, EndType.Polygon, MITER_LIMIT) : fill;
      for (const ring of inner) free.push(ring);
    }
  }
  if (free.length > 0) {
    const cut = difference([outer], union(free, FillRule.NonZero), FillRule.NonZero);
    const outers = cut.filter((ring) => area(ring) > 0);
    const cleanOuter = outers.length === 1 && outers[0] !== undefined ? cleanRing(outers[0]) : null;
    // A hole that cuts the part in two is ignored: the solid outline is always safe.
    if (cleanOuter !== null) {
      const pockets: Paths64 = [];
      for (const ring of cut) {
        if (area(ring) >= 0) continue;
        const clean = cleanRing(ring);
        if (clean !== null) pockets.push(clean);
      }
      return canonical(cleanOuter, pockets);
    }
  }
  return canonical(outer, []);
}

interface Family {
  readonly polyId: number;
  /** Local rotated geometry in units, minus this, is relative to the reference vertex. */
  readonly ox: number;
  readonly oy: number;
}

function finitePoints(points: readonly Point[]): Point[] {
  return points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function shoelace(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Area centroid of a closed outline; the middle of the bounding box when it has no area. */
function centroidOf(points: readonly Point[], closed: boolean): Point {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    const w = a.x * b.y - b.x * a.y;
    twiceArea += w;
    cx += (a.x + b.x) * w;
    cy += (a.y + b.y) * w;
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }
  if (points.length === 0) return { x: 0, y: 0 };
  const middle = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  if (!closed || Math.abs(twiceArea) < 1e-9) return middle;
  const centre = { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
  // A self-crossing outline can throw the centroid anywhere; keep it inside the box.
  return centre.x >= minX && centre.x <= maxX && centre.y >= minY && centre.y <= maxY ? centre : middle;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The angles a part may be turned to, in degrees. */
export function allowedRotations(stepDeg: number, canRotate: boolean): number[] {
  if (!canRotate || !Number.isFinite(stepDeg) || stepDeg <= 0 || stepDeg >= 360) return [0];
  const total = Math.ceil(360 / stepDeg - 1e-9);
  const stride = Math.max(1, Math.ceil(total / MAX_ROTATIONS));
  const angles: number[] = [];
  for (let i = 0; i < total; i += stride) angles.push(i * stepDeg);
  return angles;
}

export function prepare(parts: readonly NestPart[], options: NestOptions): Prepared {
  const sheetWidthMm = positive(options.sheetWidthMm);
  const sheetHeightMm = positive(options.sheetHeightMm);
  const marginMm = positive(options.marginMm);
  const spacingMm = positive(options.spacingMm);

  const outlines = parts.map((part) => finitePoints(part.outline));
  // Each part is worked on near the origin, whatever its place in the document.
  const anchors = outlines.map((points) => {
    let x = Infinity;
    let y = Infinity;
    for (const p of points) {
      if (p.x < x) x = p.x;
      if (p.y < y) y = p.y;
    }
    return points.length > 0 ? { x, y } : { x: 0, y: 0 };
  });
  let span = Math.max(sheetWidthMm, sheetHeightMm);
  outlines.forEach((points, i) => {
    const anchor = anchors[i];
    if (anchor === undefined) return;
    for (const p of points) span = Math.max(span, Math.hypot(p.x - anchor.x, p.y - anchor.y));
  });
  let scale = 10000;
  while (scale > 1 && (span + spacingMm + 1) * scale > MAX_UNITS) scale /= 10;
  const usable = (span + spacingMm + 1) * scale <= MAX_UNITS;

  const polys: StoredPoly[] = [];
  const byKey = new Map<string, number>();
  const turnCache = new Map<number, { id: number; cx: number; cy: number }>();

  const store = (shape: Canonical, baseId: number | null, k: number, cx: number, cy: number): number => {
    const id = polys.length;
    polys.push({
      id,
      outer: shape.outer,
      holes: shape.holes,
      bounds: boxOf(shape.outer),
      holeBounds: shape.holes.map(boxOf),
      baseId: baseId ?? id,
      k,
      cx,
      cy,
    });
    byKey.set(shape.key, id);
    return id;
  };

  const getPoly = (id: number): StoredPoly => {
    const poly = polys[id];
    if (poly === undefined) throw new Error(`nesting: unknown polygon ${id}`);
    return poly;
  };

  /** Polygon `id` turned by k quarter turns: result = turn(source, k) - (cx, cy). */
  const turned = (id: number, k: number): { id: number; cx: number; cy: number } => {
    const quarter = ((k % 4) + 4) % 4;
    if (quarter === 0) return { id, cx: 0, cy: 0 };
    const cacheKey = id * 4 + quarter;
    const cached = turnCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const source = getPoly(id);
    const shape = canonical(
      source.outer.map((p) => quarterTurn(p.x, p.y, quarter)),
      turnPaths(source.holes, quarter),
    );
    let target = byKey.get(shape.key);
    if (target === undefined) {
      const shift = quarterTurn(source.cx, source.cy, quarter);
      const totalK = (source.k + quarter) % 4;
      target =
        totalK === 0
          ? store(shape, null, 0, 0, 0)
          : store(shape, source.baseId, totalK, shift.x + shape.refX, shift.y + shape.refY);
    }
    const result = { id: target, cx: shape.refX, cy: shape.refY };
    turnCache.set(cacheKey, result);
    return result;
  };

  /**
   * No-fit regions are computed once per pair of base polygons and stored
   * packed. Every other pair is one of those, turned and shifted.
   */
  const noFit = (eps: number): ((a: number, b: number) => Resolved) => {
    const cache = new Map<number, Resolved>();
    const get = (a: number, b: number): Resolved => {
      const cacheKey = a * 1048576 + b;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const pa = getPoly(a);
      const pb = getPoly(b);
      let result: Resolved;
      if (pa.k !== 0) {
        // Turn the pair back so the fixed polygon is its base; the region turns with them.
        const back = turned(b, -pa.k);
        const inner = get(pa.baseId, back.id);
        const shift = quarterTurn(inner.tx - back.cx, inner.ty - back.cy, pa.k);
        result = { region: inner.region, k: (inner.k + pa.k) % 4, tx: shift.x - pa.cx, ty: shift.y - pa.cy };
      } else if (pb.k === 0 && b < a) {
        // b overlaps a at offset t exactly when a overlaps b at offset -t.
        const inner = get(b, a);
        result = { region: inner.region, k: (inner.k + 2) % 4, tx: -inner.tx, ty: -inner.ty };
      } else {
        result = { region: pack(noFitRegion(pa, pb, eps)), k: 0, tx: 0, ty: 0 };
      }
      cache.set(cacheKey, result);
      return result;
    };
    return get;
  };
  const loose = noFit(FIT_EPS);
  const exact = noFit(0);

  const families = new Map<string, Family | null>();

  /** Builds the nest polygon of part `index` turned by `baseDeg` (0 up to 90). */
  const family = (index: number, baseDeg: number): Family | null => {
    const key = `${index}:${baseDeg.toFixed(9)}`;
    const cached = families.get(key);
    if (cached !== undefined) return cached;
    const part = parts[index];
    const points = outlines[index];
    const anchor = anchors[index];
    let result: Family | null = null;
    if (part !== undefined && points !== undefined && anchor !== undefined && points.length > 0) {
      const turn = rotation((baseDeg * Math.PI) / 180);
      const local = (list: readonly Point[]): Point[] =>
        list.map((p) => applyToPoint(turn, { x: p.x - anchor.x, y: p.y - anchor.y }));
      let shape: Canonical | null = null;
      try {
        shape = nestShape(
          local(points),
          part.closed,
          options.useHoles ? part.holes.map((hole) => local(finitePoints(hole))) : [],
          (spacingMm / 2) * scale,
          scale,
        );
      } catch {
        // Geometry clipper cannot digest: the part is reported as unplaced.
        shape = null;
      }
      if (shape !== null) {
        const id = byKey.get(shape.key) ?? store(shape, null, 0, 0, 0);
        result = { polyId: id, ox: shape.refX, oy: shape.refY };
      }
    }
    families.set(key, result);
    return result;
  };

  const sheet: Box = {
    minX: marginMm * scale,
    minY: marginMm * scale,
    maxX: (sheetWidthMm - marginMm) * scale,
    maxY: (sheetHeightMm - marginMm) * scale,
  };
  // Lets a part exactly as large as the usable sheet through despite float noise.
  const slack = 1e-6;

  let nextRid = 0;
  const prepared: PreparedPart[] = parts.map((part, index) => {
    const count = Number.isFinite(part.quantity) ? Math.max(0, Math.floor(part.quantity)) : 0;
    const points = outlines[index] ?? [];
    const anchor = anchors[index] ?? { x: 0, y: 0 };
    const rotations: PartRotation[] = [];
    const closedArea = part.closed && points.length >= 3 ? shoelace(points) : 0;
    let holeArea = 0;
    if (options.useHoles) for (const hole of part.holes) holeArea += shoelace(finitePoints(hole));
    const centroid = centroidOf(points, part.closed);
    if (count > 0 && usable && points.length > 0) {
      const seen = new Set<number>();
      for (const deg of allowedRotations(options.rotationStepDeg, part.canRotate)) {
        const quarters = Math.floor(deg / 90 + 1e-9);
        const base = family(index, deg - quarters * 90);
        if (base === null) continue;
        const turnedPoly = turned(base.polyId, quarters);
        if (seen.has(turnedPoly.id)) continue;
        // Offsets: local geometry turned by `deg`, in units, relative to the reference vertex.
        const baseOffset = quarterTurn(base.ox, base.oy, quarters);
        const localOx = baseOffset.x + turnedPoly.cx;
        const localOy = baseOffset.y + turnedPoly.cy;
        const turn = rotation((deg * Math.PI) / 180);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const centre = applyToPoint(turn, { x: centroid.x - anchor.x, y: centroid.y - anchor.y });
        for (const p of points) {
          const q = applyToPoint(turn, { x: p.x - anchor.x, y: p.y - anchor.y });
          if (q.x < minX) minX = q.x;
          if (q.y < minY) minY = q.y;
          if (q.x > maxX) maxX = q.x;
          if (q.y > maxY) maxY = q.y;
        }
        const fits =
          (maxX - minX) * scale <= sheet.maxX - sheet.minX + slack &&
          (maxY - minY) * scale <= sheet.maxY - sheet.minY + slack;
        if (!fits) continue;
        seen.add(turnedPoly.id);
        const anchorTurned = applyToPoint(turn, anchor);
        rotations.push({
          rid: nextRid++,
          polyId: turnedPoly.id,
          rotationDeg: deg,
          ox: anchorTurned.x * scale + localOx,
          oy: anchorTurned.y * scale + localOy,
          tMinX: minX * scale - localOx,
          tMaxX: maxX * scale - localOx,
          tMinY: minY * scale - localOy,
          tMaxY: maxY * scale - localOy,
          cx: centre.x * scale - localOx,
          cy: centre.y * scale - localOy,
        });
      }
    }
    return {
      index,
      id: part.id,
      count,
      rotations,
      areaMm2: closedArea,
      solidArea: Math.max(0, closedArea - holeArea) * scale * scale,
    };
  });

  return {
    scale,
    parts: prepared,
    sheet,
    sheetWidthMm,
    sheetHeightMm,
    poly: getPoly,
    nfp: (a, b, x = 0, y = 0) => unpack(loose(a, b), x, y),
    exactNfp: (a, b, x = 0, y = 0) => unpack(exact(a, b), x, y),
    overlaps: (a, b, dx, dy) => {
      const found = exact(a, b);
      // Into the frame of the stored region.
      const p = quarterTurn(dx - found.tx, dy - found.ty, -found.k);
      let depth = 0;
      for (let i = 0; i < found.region.rings.length; i++) {
        const ring = found.region.rings[i];
        if (ring === undefined) continue;
        const where = locate(ring, p.x, p.y);
        // Touching is allowed; only the inside of the region overlaps.
        if (where === 0) return false;
        if (where > 0) depth += found.region.outer[i] === true ? 1 : -1;
      }
      return depth > 0;
    },
  };
}
