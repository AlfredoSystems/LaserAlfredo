import { describe, expect, it } from 'vitest';
import type { ColoredPolyline, Point, Polyline } from '../model/types';
import { boundsOfPoints } from './bounds';
import { signedArea } from './hit';
import { applyKerf } from './kerf';

function rect(x: number, y: number, w: number, h: number, closed = true): Polyline {
  return {
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    closed,
  };
}

function reversed(path: Polyline): Polyline {
  return { points: [...path.points].reverse(), closed: path.closed };
}

function circle(cx: number, cy: number, r: number, segments: number): Polyline {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return { points, closed: true };
}

function area(path: Polyline | undefined): number {
  return Math.abs(signedArea(path?.points ?? []));
}

function minXOf(path: Polyline | undefined): number {
  return boundsOfPoints(path?.points ?? [])?.minX ?? Number.NaN;
}

function expectBounds(path: Polyline | undefined, minX: number, minY: number, maxX: number, maxY: number): void {
  const b = boundsOfPoints(path?.points ?? []);
  expect(b).not.toBeNull();
  expect(b?.minX).toBeCloseTo(minX, 4);
  expect(b?.minY).toBeCloseTo(minY, 4);
  expect(b?.maxX).toBeCloseTo(maxX, 4);
  expect(b?.maxY).toBeCloseTo(maxY, 4);
}

describe('applyKerf', () => {
  it('grows an outer square by half the kerf on every side', () => {
    const result = applyKerf([rect(0, 0, 10, 10)], 0.2);
    expect(result).toHaveLength(1);
    expect(result[0]?.closed).toBe(true);
    expectBounds(result[0], -0.1, -0.1, 10.1, 10.1);
    const b = boundsOfPoints(result[0]?.points ?? []);
    expect((b?.maxX ?? 0) - (b?.minX ?? 0)).toBeCloseTo(10.2, 9);
    expect((b?.maxY ?? 0) - (b?.minY ?? 0)).toBeCloseTo(10.2, 9);
    // Corners are rounded with radius 0.1, so the area is just under the exact rounded square.
    const exact = 100 + 4 * 10 * 0.1 + Math.PI * 0.1 * 0.1;
    expect(area(result[0])).toBeGreaterThan(exact - 0.01);
    expect(area(result[0])).toBeLessThanOrEqual(exact + 1e-6);
  });

  it('shrinks a hole by half the kerf on every side', () => {
    const result = applyKerf([rect(0, 0, 100, 100), rect(40, 40, 20, 20)], 0.2);
    expect(result).toHaveLength(2);
    expectBounds(result[0], -0.1, -0.1, 100.1, 100.1);
    expectBounds(result[1], 40.1, 40.1, 59.9, 59.9);
    expect(area(result[1])).toBeCloseTo(19.8 * 19.8, 4);
  });

  it('gives the same result for clockwise and counter-clockwise input', () => {
    const outer = rect(0, 0, 100, 100);
    const hole = rect(40, 40, 20, 20);
    const round = circle(20, 20, 8, 48);
    const forward = applyKerf([outer, hole, round], 0.3);
    const backward = applyKerf([reversed(outer), reversed(hole), reversed(round)], 0.3);
    const mixed = applyKerf([outer, reversed(hole), round], 0.3);
    expect(forward).toHaveLength(3);
    for (const other of [backward, mixed]) {
      expect(other).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(area(other[i])).toBeCloseTo(area(forward[i]), 6);
        const a = boundsOfPoints(forward[i]?.points ?? []);
        const b = boundsOfPoints(other[i]?.points ?? []);
        expect(b?.minX).toBeCloseTo(a?.minX ?? Number.NaN, 6);
        expect(b?.minY).toBeCloseTo(a?.minY ?? Number.NaN, 6);
        expect(b?.maxX).toBeCloseTo(a?.maxX ?? Number.NaN, 6);
        expect(b?.maxY).toBeCloseTo(a?.maxY ?? Number.NaN, 6);
      }
    }
    expect(area(forward[0])).toBeGreaterThan(area(outer));
    expect(area(forward[1])).toBeLessThan(area(hole));
    expect(area(forward[2])).toBeLessThan(area(round));
  });

  it('grows an island inside a hole again', () => {
    const paths = [rect(40, 40, 20, 20), rect(0, 0, 100, 100), rect(20, 20, 60, 60)];
    const result = applyKerf(paths, 0.2);
    expect(result).toHaveLength(3);
    expectBounds(result[0], 39.9, 39.9, 60.1, 60.1);
    expectBounds(result[1], -0.1, -0.1, 100.1, 100.1);
    expectBounds(result[2], 20.1, 20.1, 79.9, 79.9);
  });

  it('drops a hole that collapses', () => {
    const paths = [rect(0, 0, 100, 100), rect(50, 50, 0.15, 5), rect(10, 10, 5, 5)];
    const result = applyKerf(paths, 0.2);
    expect(result).toHaveLength(2);
    expectBounds(result[0], -0.1, -0.1, 100.1, 100.1);
    expectBounds(result[1], 10.1, 10.1, 14.9, 14.9);
  });

  it('splits a hole that pinches off into several polylines, in place', () => {
    // A dumbbell hole: two 4 x 10 lobes joined by a 0.2 mm wide neck.
    const dumbbell: Polyline = {
      points: [
        { x: 10, y: 10 },
        { x: 14, y: 10 },
        { x: 14, y: 14.9 },
        { x: 16, y: 14.9 },
        { x: 16, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 20 },
        { x: 16, y: 20 },
        { x: 16, y: 15.1 },
        { x: 14, y: 15.1 },
        { x: 14, y: 20 },
        { x: 10, y: 20 },
      ],
      closed: true,
    };
    const result = applyKerf([rect(0, 0, 100, 100), dumbbell, rect(200, 0, 10, 10)], 0.4);
    expect(result).toHaveLength(4);
    expectBounds(result[0], -0.2, -0.2, 100.2, 100.2);
    const lobes = [result[1], result[2]].sort((a, b) => minXOf(a) - minXOf(b));
    // Each lobe keeps a small cusp where the neck was: the beam centre can reach
    // in between the two neck corners until it is 0.2 mm from both.
    const cusp = Math.sqrt(0.2 * 0.2 - 0.1 * 0.1);
    const left = boundsOfPoints(lobes[0]?.points ?? []);
    const right = boundsOfPoints(lobes[1]?.points ?? []);
    expect(left?.minX).toBeCloseTo(10.2, 4);
    expect(left?.minY).toBeCloseTo(10.2, 4);
    expect(left?.maxY).toBeCloseTo(19.8, 4);
    expect(Math.abs((left?.maxX ?? 0) - (14 - cusp))).toBeLessThan(0.011);
    expect(right?.maxX).toBeCloseTo(19.8, 4);
    expect(right?.minY).toBeCloseTo(10.2, 4);
    expect(right?.maxY).toBeCloseTo(19.8, 4);
    expect(Math.abs((right?.minX ?? 0) - (16 + cusp))).toBeLessThan(0.011);
    expect(area(lobes[0])).toBeGreaterThan(3.6 * 9.6 - 0.01);
    expect(area(lobes[0])).toBeLessThan(3.6 * 9.6 + 0.01);
    expectBounds(result[3], 199.8, -0.2, 210.2, 10.2);
  });

  it('leaves open paths untouched', () => {
    const open = rect(0, 0, 100, 100, false);
    const inner: Polyline = {
      points: [
        { x: 45, y: 45 },
        { x: 55, y: 55 },
      ],
      closed: false,
    };
    const result = applyKerf([open, rect(40, 40, 20, 20), inner], 0.2);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(open);
    expect(result[2]).toBe(inner);
    // The open outline around the square does not turn the square into a hole.
    expectBounds(result[1], 39.9, 39.9, 60.1, 60.1);
  });

  it('returns the same paths for a zero, negative or non-finite kerf', () => {
    const paths = [rect(0, 0, 10, 10), rect(2, 2, 3, 3), rect(20, 0, 5, 5, false)];
    for (const kerf of [0, -0.2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = applyKerf(paths, kerf);
      expect(result).toHaveLength(paths.length);
      result.forEach((p, i) => expect(p).toBe(paths[i]));
    }
  });

  it('returns an empty array for no paths', () => {
    expect(applyKerf([], 0.2)).toEqual([]);
  });

  it('offsets a circle polygon to the expected area', () => {
    const r = 20;
    const kerf = 0.3;
    const outer = applyKerf([circle(50, 50, r, 720)], kerf);
    expect(outer).toHaveLength(1);
    const outerExpected = Math.PI * (r + kerf / 2) ** 2;
    expect(Math.abs(area(outer[0]) - outerExpected) / outerExpected).toBeLessThan(0.001);
    expectBounds(outer[0], 50 - r - kerf / 2, 50 - r - kerf / 2, 50 + r + kerf / 2, 50 + r + kerf / 2);

    const withHole = applyKerf([rect(0, 0, 100, 100), circle(50, 50, r, 720)], kerf);
    expect(withHole).toHaveLength(2);
    const holeExpected = Math.PI * (r - kerf / 2) ** 2;
    expect(Math.abs(area(withHole[1]) - holeExpected) / holeExpected).toBeLessThan(0.001);
  });

  it('keeps every offset vertex close to the true offset distance', () => {
    const r = 10;
    const [grown] = applyKerf([circle(0, 0, r, 360)], 0.2);
    expect(grown?.points.length ?? 0).toBeGreaterThan(100);
    for (const p of grown?.points ?? []) {
      expect(Math.abs(Math.hypot(p.x, p.y) - (r + 0.1))).toBeLessThan(0.001);
    }
  });

  it('does not repeat the first point of a closed result', () => {
    for (const path of applyKerf([rect(0, 0, 100, 100), rect(40, 40, 20, 20), circle(20, 20, 5, 32)], 0.2)) {
      const first = path.points[0];
      const last = path.points[path.points.length - 1];
      expect(path.points.length).toBeGreaterThanOrEqual(3);
      expect(first).not.toEqual(last);
    }
  });

  it('keeps extra properties of the source path', () => {
    const colored: ColoredPolyline = { ...rect(0, 0, 10, 10), color: '#ff0000' };
    const [result] = applyKerf([colored], 0.2);
    expect(result).toMatchObject({ color: '#ff0000', closed: true });
  });

  it('does not throw on self-intersecting or degenerate input', () => {
    const bowTie: Polyline = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };
    const twoPoint: Polyline = {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      closed: true,
    };
    const flat: Polyline = {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
      closed: true,
    };
    const nan: Polyline = {
      points: [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 5 },
        { x: 5, y: 5 },
      ],
      closed: true,
    };
    const empty: Polyline = { points: [], closed: true };
    let result: Polyline[] = [];
    expect(() => {
      result = applyKerf([bowTie, twoPoint, flat, nan, empty], 0.2);
    }).not.toThrow();
    expect(result.length).toBeGreaterThanOrEqual(5);
    expect(result).toContain(twoPoint);
    expect(result).toContain(nan);
    expect(result).toContain(empty);
    for (const path of result) {
      if (path === nan) continue;
      for (const p of path.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
