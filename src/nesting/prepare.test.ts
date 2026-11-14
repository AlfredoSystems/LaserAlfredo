import { EndType, FillRule, JoinType, area, difference, inflatePaths, union } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { applyToPoints, rotation } from '../model/transform';
import type { Point } from '../model/types';
import { allowedRotations, prepare, simplifyPath } from './prepare';
import type { PartRotation, Prepared } from './prepare';
import { createRng } from './rng';
import { circle, lShape, part, rectangle } from './testing';
import { DEFAULT_NEST_OPTIONS } from './types';
import type { NestOptions } from './types';

function options(overrides: Partial<NestOptions> = {}): NestOptions {
  return { ...DEFAULT_NEST_OPTIONS, ...overrides };
}

function absArea(paths: Paths64): number {
  let total = 0;
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      if (a !== undefined && b !== undefined) total += (a.x * b.y - b.x * a.y) / 2;
    }
  }
  return Math.abs(total);
}

/** The true outline at a rotation, in integer units relative to the nest polygon's reference vertex. */
function trueOutline(points: readonly Point[], rot: PartRotation, scale: number): Path64 {
  const turned = applyToPoints(rotation((rot.rotationDeg * Math.PI) / 180), points);
  return turned.map((p) => ({ x: Math.round(p.x * scale - rot.ox), y: Math.round(p.y * scale - rot.oy) }));
}

describe('allowedRotations', () => {
  it('lists the multiples of the step below 360', () => {
    expect(allowedRotations(90, true)).toEqual([0, 90, 180, 270]);
    expect(allowedRotations(45, true)).toHaveLength(8);
    expect(allowedRotations(120, true)).toEqual([0, 120, 240]);
    expect(allowedRotations(100, true)).toEqual([0, 100, 200, 300]);
    expect(allowedRotations(180, true)).toEqual([0, 180]);
  });

  it('allows only the drawn orientation when rotation is off or the step is unusable', () => {
    expect(allowedRotations(90, false)).toEqual([0]);
    expect(allowedRotations(0, true)).toEqual([0]);
    expect(allowedRotations(-90, true)).toEqual([0]);
    expect(allowedRotations(360, true)).toEqual([0]);
    expect(allowedRotations(Number.NaN, true)).toEqual([0]);
    expect(allowedRotations(Infinity, true)).toEqual([0]);
  });

  it('thins out a very fine step but keeps to its multiples', () => {
    const angles = allowedRotations(0.5, true);
    expect(angles.length).toBeLessThanOrEqual(72);
    expect(angles.length).toBeGreaterThan(36);
    for (const angle of angles) {
      expect(angle).toBeLessThan(360);
      expect(Math.abs(angle / 0.5 - Math.round(angle / 0.5))).toBeLessThan(1e-9);
    }
  });
});

describe('simplifyPath', () => {
  it('leaves corners alone and reports no deviation', () => {
    const square: Path64 = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    expect(simplifyPath(square, 100, true)).toEqual({ path: square, deviation: 0 });
  });

  it('drops points within the tolerance and reports how far they were', () => {
    const path: Path64 = [
      { x: 0, y: 0 },
      { x: 500, y: 30 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 500, y: 1200 },
      { x: 0, y: 1000 },
    ];
    const { path: kept, deviation } = simplifyPath(path, 100, true);
    expect(kept).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 500, y: 1200 },
      { x: 0, y: 1000 },
    ]);
    expect(deviation).toBeCloseTo(30, 9);
  });

  it('keeps the ends of an open path', () => {
    const path: Path64 = [
      { x: 0, y: 0 },
      { x: 100, y: 5 },
      { x: 200, y: -5 },
      { x: 300, y: 0 },
    ];
    expect(simplifyPath(path, 10, false).path).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ]);
  });

  it('never strays further than it reports', () => {
    const rng = createRng(4);
    for (let round = 0; round < 50; round++) {
      const path: Path64 = [];
      const count = 5 + rng.int(60);
      for (let i = 0; i < count; i++) {
        const a = (2 * Math.PI * i) / count;
        const r = 5000 + rng.next() * 400;
        path.push({ x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) });
      }
      const { path: kept, deviation } = simplifyPath(path, 300, true);
      expect(deviation).toBeLessThanOrEqual(300);
      // Every original point is within `deviation` of the simplified outline.
      const band = inflatePaths([[...kept, kept[0] as Path64[number]]], deviation + 2, JoinType.Round, EndType.Round, 2, 0.25);
      const outside = difference(
        path.map((p) => [
          { x: p.x - 1, y: p.y - 1 },
          { x: p.x + 1, y: p.y - 1 },
          { x: p.x + 1, y: p.y + 1 },
          { x: p.x - 1, y: p.y + 1 },
        ]),
        band,
        FillRule.NonZero,
      );
      expect(absArea(outside)).toBe(0);
    }
  });
});

describe('prepare', () => {
  it('picks a scale that fits the job', () => {
    expect(prepare([], options()).scale).toBe(10000);
    expect(prepare([], options({ sheetWidthMm: 12000, sheetHeightMm: 3000 })).scale).toBe(1000);
  });

  it('gives a square one rotation, a rectangle two and an L four', () => {
    const prepared = prepare(
      [part('sq', rectangle(50, 50)), part('re', rectangle(80, 30)), part('l', lShape(60, 90, 20))],
      options(),
    );
    expect(prepared.parts.map((p) => p.rotations.map((r) => r.rotationDeg))).toEqual([[0], [0, 90], [0, 90, 180, 270]]);
  });

  it('shares one nest polygon between congruent parts wherever they are drawn', () => {
    const prepared = prepare(
      [
        part('a', rectangle(80, 30)),
        part('b', rectangle(80, 30, 500, -200)),
        part('c', rectangle(30, 80, 7, 7)),
        part('d', [...rectangle(80, 30)].reverse()),
      ],
      options(),
    );
    const [a, b, c, d] = prepared.parts.map((p) => p.rotations.map((r) => r.polyId));
    expect(b).toEqual(a);
    expect(d).toEqual(a);
    // The upright rectangle is the lying one turned by 90 degrees.
    expect(c).toEqual([a?.[1], a?.[0]]);
  });

  it('keeps only the rotations that fit the sheet', () => {
    const prepared = prepare(
      [part('long', rectangle(800, 100)), part('huge', rectangle(800, 800)), part('none', rectangle(10, 10), { quantity: 0 })],
      options({ sheetWidthMm: 300, sheetHeightMm: 900 }),
    );
    expect(prepared.parts[0]?.rotations.map((r) => r.rotationDeg)).toEqual([90]);
    expect(prepared.parts[1]?.rotations).toEqual([]);
    expect(prepared.parts[2]?.count).toBe(0);
  });

  it('reports outline areas and the bounding box of the true part', () => {
    const prepared = prepare([part('l', lShape(60, 90, 20), { canRotate: false })], options({ spacingMm: 6 }));
    const only = prepared.parts[0];
    const rot = only?.rotations[0];
    expect(only?.areaMm2).toBeCloseTo(20 * 90 + 40 * 20, 9);
    expect((rot?.tMaxX ?? 0) - (rot?.tMinX ?? 0)).toBeCloseTo(60 * prepared.scale, 6);
    expect((rot?.tMaxY ?? 0) - (rot?.tMinY ?? 0)).toBeCloseTo(90 * prepared.scale, 6);
    // The nest polygon is the part grown by half the spacing on every side.
    const bounds = prepared.poly(rot?.polyId ?? 0).bounds;
    expect(bounds.maxX - bounds.minX).toBe(66 * prepared.scale);
    expect(bounds.maxY - bounds.minY).toBe(96 * prepared.scale);
  });

  it('builds nest polygons that contain the true part grown by half the spacing, at every rotation', () => {
    const spacingMm = 3;
    const shapes: Point[][] = [
      lShape(60, 90, 20),
      circle(37.123, 90, 11.1, -3.3),
      [
        { x: 0, y: 0 },
        { x: 100.37, y: 12.11 },
        { x: 60.5, y: 30.2 },
        { x: 90.01, y: 80.77 },
        { x: 20.3, y: 45.6 },
      ],
    ];
    const prepared = prepare(
      shapes.map((outline, i) => part(`s${i}`, outline)),
      options({ spacingMm, rotationStepDeg: 30 }),
    );
    const half = (spacingMm / 2) * prepared.scale;
    shapes.forEach((outline, i) => {
      const rotations = prepared.parts[i]?.rotations ?? [];
      expect(rotations.length).toBeGreaterThanOrEqual(i === 1 ? 1 : 12);
      for (const rot of rotations) {
        const nest = [prepared.poly(rot.polyId).outer];
        const truth = union([trueOutline(outline, rot, prepared.scale)], FillRule.NonZero);
        // Contains the true part grown by half the spacing (2 units of slack for rounding to the grid).
        const grown = inflatePaths(truth, half - 2, JoinType.Round, EndType.Polygon, 2, 0.25);
        expect(absArea(difference(grown, nest, FillRule.NonZero)), `${i} at ${rot.rotationDeg}`).toBe(0);
        // And is not wastefully large: at most the simplification tolerance (0.1 mm) more, plus mitred corners.
        const loose = inflatePaths(truth, half + 0.11 * prepared.scale, JoinType.Miter, EndType.Polygon, 4);
        expect(absArea(difference(nest, loose, FillRule.NonZero)), `${i} at ${rot.rotationDeg}`).toBe(0);
      }
    });
  });

  it('shrinks holes by half the spacing and drops the ones that vanish', () => {
    const frame = part('frame', rectangle(200, 200), {
      holes: [rectangle(100, 100, 50, 50), rectangle(3, 3, 10, 10)],
      canRotate: false,
    });
    const small = part('small', rectangle(20, 20), { canRotate: false });
    const withHoles = prepare([frame, small], options({ spacingMm: 4, useHoles: true }));
    const without = prepare([frame, small], options({ spacingMm: 4, useHoles: false }));
    const pockets = (prepared: Prepared): Paths64 => {
      const a = prepared.parts[0]?.rotations[0];
      const b = prepared.parts[1]?.rotations[0];
      if (a === undefined || b === undefined) throw new Error('missing rotation');
      return prepared.exactNfp(a.polyId, b.polyId).filter((ring) => area(ring) < 0);
    };
    expect(pockets(without)).toEqual([]);
    const found = pockets(withHoles);
    // One pocket: the 100 mm hole less 2 mm on each side holds the 24 mm nest square with 72 mm of play.
    expect(found).toHaveLength(1);
    expect(absArea(found)).toBe((72 * withHoles.scale) ** 2);
    expect(withHoles.parts[0]?.solidArea).toBeLessThan(without.parts[0]?.solidArea ?? 0);
  });

  it('relates the no-fit regions of turned parts by turning them', () => {
    // Every pair of rotations must give the region a direct overlap test would.
    const prepared = prepare(
      [part('l', lShape(60, 90, 20)), part('t', [{ x: 0, y: 0 }, { x: 70, y: 10 }, { x: 20, y: 50 }])],
      options({ spacingMm: 0, rotationStepDeg: 90 }),
    );
    const [l, t] = prepared.parts;
    if (l === undefined || t === undefined) throw new Error('missing part');
    const outlines = [lShape(60, 90, 20), [{ x: 0, y: 0 }, { x: 70, y: 10 }, { x: 20, y: 50 }]];
    const all = [...l.rotations.map((r) => ({ r, outline: outlines[0] as Point[] })), ...t.rotations.map((r) => ({ r, outline: outlines[1] as Point[] }))];
    expect(all).toHaveLength(8);
    for (const fixed of all) {
      for (const moving of all) {
        const region = prepared.exactNfp(fixed.r.polyId, moving.r.polyId);
        const a = trueOutline(fixed.outline, fixed.r, prepared.scale);
        const b = trueOutline(moving.outline, moving.r, prepared.scale);
        // Brute force: b at offset t overlaps a exactly when t = p - q for points p of a and q of b.
        const mirrored = b.map((p) => ({ x: -p.x, y: -p.y }));
        const expected = bruteSum(a, mirrored);
        expect(absArea(difference(region, expected, FillRule.NonZero)) + absArea(difference(expected, region, FillRule.NonZero))).toBeLessThan(
          absArea(expected) * 1e-6,
        );
      }
    }
  });
});

/** Minkowski sum of two small polygons by summing triangles of one with the other's hull pieces. */
function bruteSum(a: Path64, b: Path64): Paths64 {
  // Sum of every edge of a with every edge of b, plus each polygon at each vertex of the other.
  const pieces: Paths64 = [];
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    if (a0 === undefined || a1 === undefined) continue;
    pieces.push(b.map((p) => ({ x: p.x + a0.x, y: p.y + a0.y })));
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (b0 === undefined || b1 === undefined) continue;
      pieces.push([
        { x: a0.x + b0.x, y: a0.y + b0.y },
        { x: a1.x + b0.x, y: a1.y + b0.y },
        { x: a1.x + b1.x, y: a1.y + b1.y },
        { x: a0.x + b1.x, y: a0.y + b1.y },
      ]);
    }
  }
  for (const q of b) pieces.push(a.map((p) => ({ x: p.x + q.x, y: p.y + q.y })));
  // Quads may wind either way: orient them all the same before the union.
  const oriented = pieces.map((piece) => {
    let twice = 0;
    for (let i = 0; i < piece.length; i++) {
      const p = piece[i];
      const q = piece[(i + 1) % piece.length];
      if (p !== undefined && q !== undefined) twice += p.x * q.y - q.x * p.y;
    }
    return twice < 0 ? [...piece].reverse() : piece;
  });
  return union(oriented, FillRule.NonZero);
}
