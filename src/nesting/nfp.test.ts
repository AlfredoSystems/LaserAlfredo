import {
  EndType,
  FillRule,
  JoinType,
  PointInPolygonResult,
  area,
  difference,
  inflatePaths,
  intersect,
  pointInPolygon,
  union,
  xor,
} from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import {
  boxOf,
  cleanRing,
  convolutionCycles,
  insideFitRegion,
  insideFitRegionBySweep,
  minkowskiSumRegion,
  noFitRegion,
  sweepSumRegion,
  translatePaths,
} from './nfp';
import type { NestPoly } from './nfp';
import { createRng } from './rng';
import type { Rng } from './rng';

const UNIT = 10000;

function square(x: number, y: number, w: number, h: number): Path64 {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function totalArea(paths: Paths64): number {
  return paths.reduce((sum, path) => sum + area(path), 0);
}

function positive(path: Path64): Path64 {
  return area(path) < 0 ? [...path].reverse() : path;
}

/** A spiky star; jitter makes it irregular. */
function star(rng: Rng, radius: number, points: number, jitter: number): Path64 {
  const path: Path64 = [];
  for (let i = 0; i < points; i++) {
    const r = (i % 2 === 0 ? radius : radius * 0.5) * (1 + jitter * (rng.next() - 0.5));
    const a = (2 * Math.PI * i) / points;
    path.push({ x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) });
  }
  return path;
}

/** A random rectilinear polygon: lots of parallel edges, the convolution's awkward case. */
function rectilinear(rng: Rng, count: number): Path64 {
  for (;;) {
    const rects: Paths64 = [];
    for (let i = 0; i < count; i++) {
      rects.push(
        square(rng.int(5) * UNIT, rng.int(5) * UNIT, (1 + rng.int(4)) * UNIT, (1 + rng.int(4)) * UNIT),
      );
    }
    const merged = union(rects, FillRule.NonZero).filter((ring) => area(ring) > 0);
    merged.sort((a, b) => area(b) - area(a));
    const ring = merged[0] === undefined ? null : cleanRing(merged[0]);
    if (ring !== null) return ring;
  }
}

/** A smooth blob with a concave bite, like a part with fillets. */
function blob(rng: Rng, radius: number, points: number): Path64 {
  const path: Path64 = [];
  const bite = rng.next() * 2 * Math.PI;
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    const dent = 1 - 0.45 * Math.exp(-((Math.atan2(Math.sin(a - bite), Math.cos(a - bite)) / 0.5) ** 2));
    path.push({ x: Math.round(radius * dent * Math.cos(a)), y: Math.round(radius * 0.7 * dent * Math.sin(a)) });
  }
  return path;
}

function randomShape(rng: Rng, kind: number, size: number): Path64 {
  const raw =
    kind === 0
      ? rectilinear(rng, 2 + rng.int(3))
      : kind === 1
        ? star(rng, size, 6 + 2 * rng.int(8), 0.8)
        : blob(rng, size, 12 + rng.int(30));
  const ring = cleanRing(positive(raw));
  if (ring === null) throw new Error('bad test shape');
  return ring;
}

function poly(outer: Path64, holes: Paths64 = []): NestPoly {
  const negative = holes.map((hole) => (area(hole) > 0 ? [...hole].reverse() : hole));
  return { outer: positive(outer), holes: negative, bounds: boxOf(outer), holeBounds: negative.map(boxOf) };
}

function regionOf(shape: NestPoly): Paths64 {
  return shape.holes.length === 0 ? [shape.outer] : difference([shape.outer], shape.holes, FillRule.NonZero);
}

/** Is the point strictly inside the region (outer rings positive, holes negative)? */
function contains(region: Paths64, x: number, y: number): boolean {
  let depth = 0;
  for (const ring of region) {
    if (pointInPolygon({ x, y }, ring) === PointInPolygonResult.IsOutside) continue;
    depth += area(ring) > 0 ? 1 : -1;
  }
  return depth > 0;
}

describe('cleanRing', () => {
  it('drops repeated and collinear points', () => {
    const ring = cleanRing([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(ring).toEqual(square(0, 0, 10, 10));
  });

  it('removes a zero-width spike', () => {
    const ring = cleanRing([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(ring).toEqual(square(0, 0, 10, 10));
  });

  it('rejects a ring without area', () => {
    expect(
      cleanRing([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ]),
    ).toBeNull();
  });
});

describe('convolutionCycles', () => {
  it('gives the plain Minkowski sum for two convex polygons', () => {
    const sum = minkowskiSumRegion(square(0, 0, 10, 20), square(0, 0, 3, 4));
    expect(sum).toHaveLength(1);
    expect(totalArea(sum)).toBe(13 * 24);
    expect(boxOf(sum[0] ?? [])).toEqual({ minX: 0, minY: 0, maxX: 13, maxY: 24 });
  });

  it('matches the brute-force sweep on random concave, spiky and rectilinear polygons', () => {
    const rng = createRng(7);
    let fallbacks = 0;
    for (let i = 0; i < 400; i++) {
      const a = randomShape(rng, i % 3, 50 * UNIT);
      const b = randomShape(rng, (i + rng.int(3)) % 3, 20 * UNIT);
      const cycles = convolutionCycles(a, b);
      if (cycles === null) {
        fallbacks += 1;
        continue;
      }
      const fast = union(cycles, FillRule.NonZero);
      const slow = sweepSumRegion(a, b);
      const off = xor(fast, slow, FillRule.NonZero).reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      // Only the rounding of intersection points may differ: slivers under a unit wide.
      expect(off / totalArea(slow)).toBeLessThan(1e-5);
      // The winding number is never negative, so no region can cancel out.
      expect(totalArea(union(cycles, FillRule.Positive))).toBe(totalArea(fast));
    }
    expect(fallbacks).toBe(0);
  });

  it('refuses rings with vertices that do not turn', () => {
    const withCollinear: Path64 = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(convolutionCycles(withCollinear, square(0, 0, 3, 3))).toBeNull();
    // The region function falls back to the sweep and still gets it right.
    expect(totalArea(minkowskiSumRegion(withCollinear, square(0, 0, 3, 3)))).toBe(13 * 13);
  });

  it('stays close to linear in size for smooth concave shapes', () => {
    const rng = createRng(3);
    const a = cleanRing(positive(blob(rng, 50 * UNIT, 100)));
    const b = cleanRing(positive(blob(rng, 30 * UNIT, 100)));
    if (a === null || b === null) throw new Error('bad test shape');
    const cycles = convolutionCycles(a, b) ?? [];
    const segments = cycles.reduce((sum, cycle) => sum + cycle.length, 0);
    expect(segments).toBeGreaterThan(0);
    expect(segments).toBeLessThan(6 * (a.length + b.length));
  });
});

describe('insideFitRegion', () => {
  it('is the inner rectangle for a rectangle in a rectangle', () => {
    const fit = insideFitRegion(square(0, 0, 1000, 800), square(0, 0, 300, 200), 0);
    expect(fit).toHaveLength(1);
    expect(boxOf(fit[0] ?? [])).toEqual({ minX: 0, minY: 0, maxX: 700, maxY: 600 });
  });

  it('is empty when the shape is too big', () => {
    expect(insideFitRegion(square(0, 0, 1000, 800), square(0, 0, 300, 900), 0)).toEqual([]);
    // Fits the bounding box of the pocket, but not the pocket itself.
    const lPocket: Path64 = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 600 },
      { x: 1000, y: 600 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    expect(totalArea(insideFitRegion(lPocket, square(0, 0, 500, 500), 0))).toBe(0);
  });

  it('rejects a bar that sticks out of a C-shaped pocket on both sides', () => {
    // The bar bridges the two arms of the C: it pokes out twice, never fits.
    const cPocket: Path64 = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 300 },
      { x: 300, y: 300 },
      { x: 300, y: 700 },
      { x: 1000, y: 700 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const bar = square(0, 0, 100, 900);
    const fit = insideFitRegion(cPocket, bar, 0);
    expect(fit).toHaveLength(1);
    // Only the spine of the C is tall enough.
    expect(boxOf(fit[0] ?? [])).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
  });

  it('keeps an exact fit alive when given a tolerance', () => {
    expect(totalArea(insideFitRegion(square(0, 0, 300, 200), square(0, 0, 300, 200), 0))).toBe(0);
    const fit = insideFitRegion(square(0, 0, 300, 200), square(0, 0, 300, 200), 2);
    expect(fit).toHaveLength(1);
    expect(boxOf(fit[0] ?? [])).toEqual({ minX: -2, minY: -2, maxX: 2, maxY: 2 });
  });

  it('matches the brute-force sweep on random shapes', () => {
    const rng = createRng(11);
    let nonEmpty = 0;
    for (let i = 0; i < 200; i++) {
      const pocket = randomShape(rng, i % 3, 60 * UNIT);
      const moving = randomShape(rng, 2, (4 + rng.int(12)) * UNIT);
      const first = moving[0] ?? { x: 0, y: 0 };
      const shape = moving.map((p) => ({ x: p.x - first.x, y: p.y - first.y }));
      const fast = insideFitRegion(pocket, shape, 0);
      const slow = insideFitRegionBySweep(pocket, shape);
      const off = xor(fast, slow, FillRule.NonZero).reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      expect(off / Math.abs(area(pocket))).toBeLessThan(1e-5);
      if (totalArea(slow) > 0) nonEmpty += 1;
    }
    expect(nonEmpty).toBeGreaterThan(50);
  });
});

describe('noFitRegion', () => {
  /** Checks the region against direct overlap tests at a grid of offsets. */
  function checkBySampling(a: NestPoly, b: NestPoly, fixedStep: number): { inside: number; outside: number } {
    // Without a fixed step, about 30 samples across the larger side.
    const span = Math.max(a.bounds.maxX - a.bounds.minX + b.bounds.maxX - b.bounds.minX, 1);
    const step = fixedStep > 0 ? fixedStep : Math.ceil(span / 30) + 1;
    const region = noFitRegion(a, b, 0);
    const material = regionOf(a);
    const moving = regionOf(b);
    const margin = 3;
    const fat = inflatePaths(moving, margin, JoinType.Round, EndType.Polygon);
    const thin = inflatePaths(moving, -margin, JoinType.Round, EndType.Polygon);
    let inside = 0;
    let outside = 0;
    const minX = a.bounds.minX - b.bounds.maxX - step;
    const maxX = a.bounds.maxX - b.bounds.minX + step;
    const minY = a.bounds.minY - b.bounds.maxY - step;
    const maxY = a.bounds.maxY - b.bounds.minY + step;
    for (let x = minX; x <= maxX; x += step) {
      for (let y = minY; y <= maxY; y += step) {
        const clear = totalArea(intersect(material, translatePaths(fat, x, y), FillRule.NonZero)) === 0;
        const overlapping = totalArea(intersect(material, translatePaths(thin, x, y), FillRule.NonZero)) > 0;
        if (clear) {
          expect(contains(region, x, y), `offset ${x},${y} is free`).toBe(false);
          outside += 1;
        } else if (overlapping) {
          expect(contains(region, x, y), `offset ${x},${y} overlaps`).toBe(true);
          inside += 1;
        }
      }
    }
    return { inside, outside };
  }

  it('is a rectangle for two rectangles', () => {
    const region = noFitRegion(poly(square(0, 0, 100, 60)), poly(square(0, 0, 30, 20)), 0);
    expect(region).toHaveLength(1);
    expect(boxOf(region[0] ?? [])).toEqual({ minX: -30, minY: -20, maxX: 100, maxY: 60 });
  });

  it('covers the offsets where the fixed part lies wholly inside the moving one', () => {
    // A boundary sweep alone would leave a false hole here.
    const region = noFitRegion(poly(square(0, 0, 10, 10)), poly(square(0, 0, 100, 100)), 0);
    expect(region).toHaveLength(1);
    expect(contains(region, -50, -50)).toBe(true);
  });

  it('agrees with direct overlap tests for concave parts', () => {
    const rng = createRng(5);
    for (let i = 0; i < 6; i++) {
      const a = poly(randomShape(rng, i % 3, 40 * UNIT));
      const b = poly(randomShape(rng, (i + 1) % 3, 25 * UNIT));
      const first = b.outer[0] ?? { x: 0, y: 0 };
      const moved = poly(b.outer.map((p) => ({ x: p.x - first.x, y: p.y - first.y })));
      const counts = checkBySampling(a, moved, 0);
      expect(counts.inside).toBeGreaterThan(10);
      expect(counts.outside).toBeGreaterThan(10);
    }
  });

  it('leaves a pocket where the moving part drops into a hole', () => {
    const frame = poly(square(0, 0, 1000, 1000), [square(200, 200, 600, 600)]);
    const small = poly(square(0, 0, 100, 100));
    const region = noFitRegion(frame, small, 0);
    expect(contains(region, 450, 450)).toBe(false);
    expect(contains(region, 150, 450)).toBe(true);
    const counts = checkBySampling(frame, small, 53);
    expect(counts.inside).toBeGreaterThan(50);
    expect(counts.outside).toBeGreaterThan(50);
  });

  it('leaves a pocket where the fixed part ends up inside a hole of the moving part', () => {
    const small = poly(square(0, 0, 100, 100));
    const hole = square(200, 200, 600, 600);
    const frame = poly(square(0, 0, 1000, 1000), [hole]);
    const region = noFitRegion(small, frame, 0);
    // Frame at (-450, -450) puts the small square in the middle of its hole.
    expect(contains(region, -450, -450)).toBe(false);
    expect(contains(region, -150, -450)).toBe(true);
    const counts = checkBySampling(small, frame, 53);
    expect(counts.inside).toBeGreaterThan(50);
    expect(counts.outside).toBeGreaterThan(50);
  });

  it('keeps a part too big for the hole out of it', () => {
    const frame = poly(square(0, 0, 1000, 1000), [square(200, 200, 600, 600)]);
    const region = noFitRegion(frame, poly(square(0, 0, 700, 100)), 0);
    expect(region).toHaveLength(1);
  });

  it('finds the pocket inside an enclosed concavity', () => {
    // A C whose mouth (100 wide) is too narrow for the 150 square, with room inside.
    const c: Path64 = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 450 },
      { x: 900, y: 450 },
      { x: 900, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 900 },
      { x: 900, y: 900 },
      { x: 900, y: 550 },
      { x: 1000, y: 550 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const region = noFitRegion(poly(c), poly(square(0, 0, 150, 150)), 0);
    expect(region.some((ring) => area(ring) < 0)).toBe(true);
    expect(contains(region, 400, 400)).toBe(false);
    expect(contains(region, 800, 425)).toBe(true);
  });

  it('with a tolerance, opens a slot that fits exactly', () => {
    // Two walls 100 apart and a part exactly 100 wide.
    const u: Path64 = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 200 },
      { x: 150, y: 200 },
      { x: 150, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 250 },
      { x: 0, y: 250 },
    ];
    const moving = poly(square(0, 0, 100, 50));
    expect(contains(noFitRegion(poly(u), moving, 0), 50, 100)).toBe(true);
    const loose = noFitRegion(poly(u), moving, 2);
    // The slot survives as a sliver 4 units wide around x = 50.
    expect(contains(loose, 50, 100)).toBe(false);
    expect(contains(loose, 45, 100)).toBe(true);
    expect(contains(loose, 55, 100)).toBe(true);
  });
});
