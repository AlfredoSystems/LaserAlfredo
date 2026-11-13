import { describe, expect, it } from 'vitest';
import type { Polyline } from '../model/types';
import { containmentDepths, containmentParents } from './containment';

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

/** A "C" opening to the right: 30 x 30 outline with a 20 x 10 notch cut into its right side. */
const cShape: Polyline = {
  points: [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 20 },
    { x: 30, y: 20 },
    { x: 30, y: 30 },
    { x: 0, y: 30 },
  ],
  closed: true,
};

function assertForest(parents: readonly number[]): void {
  for (let i = 0; i < parents.length; i++) {
    let cur = parents[i] ?? -1;
    let steps = 0;
    while (cur >= 0) {
      expect(cur).not.toBe(i);
      expect(++steps).toBeLessThanOrEqual(parents.length);
      cur = parents[cur] ?? -1;
    }
  }
}

describe('containmentParents', () => {
  it('returns an empty array for no paths', () => {
    expect(containmentParents([])).toEqual([]);
    expect(containmentDepths([])).toEqual([]);
  });

  it('finds the immediate container in squares nested 3 deep', () => {
    const paths = [rect(40, 40, 20, 20), rect(0, 0, 100, 100), rect(20, 20, 60, 60)];
    expect(containmentParents(paths)).toEqual([2, -1, 1]);
    expect(containmentDepths(paths)).toEqual([2, 0, 1]);
  });

  it('does not depend on input order or winding', () => {
    const paths = [rect(0, 0, 100, 100), reversed(rect(20, 20, 60, 60)), rect(40, 40, 20, 20)];
    expect(containmentParents(paths)).toEqual([-1, 0, 1]);
    expect(containmentParents([...paths].reverse())).toEqual([1, 2, -1]);
  });

  it('gives siblings the same parent and no relation to each other', () => {
    const paths = [rect(0, 0, 100, 50), rect(10, 10, 20, 20), rect(60, 10, 20, 20), rect(200, 0, 10, 10)];
    expect(containmentParents(paths)).toEqual([-1, 0, 0, -1]);
    expect(containmentDepths(paths)).toEqual([0, 1, 1, 0]);
  });

  it('lets an open path be contained but never contain', () => {
    const openBig = rect(0, 0, 100, 100, false);
    const line: Polyline = {
      points: [
        { x: 45, y: 50 },
        { x: 55, y: 50 },
      ],
      closed: false,
    };
    const paths = [openBig, rect(40, 40, 20, 20), line];
    expect(containmentParents(paths)).toEqual([-1, -1, 1]);
    expect(containmentDepths(paths)).toEqual([0, 0, 1]);
  });

  it('never lets identical duplicates contain each other', () => {
    const paths = [
      rect(0, 0, 100, 100),
      rect(20, 20, 30, 30),
      rect(20, 20, 30, 30),
      reversed(rect(20, 20, 30, 30)),
      rect(0, 0, 100, 100),
      rect(25, 25, 5, 5),
    ];
    const parents = containmentParents(paths);
    assertForest(parents);
    expect(parents[0]).toBe(-1);
    expect(parents[4]).toBe(-1);
    for (const i of [1, 2, 3]) expect([0, 4]).toContain(parents[i]);
    expect([1, 2, 3]).toContain(parents[5]);
    expect(containmentDepths(paths)).toEqual([0, 1, 1, 1, 0, 2]);
  });

  it('rejects a shape that is inside the bounding box of a concave shape but outside the shape', () => {
    const inNotch = rect(15, 12, 10, 6);
    const inBody = rect(2, 12, 6, 6);
    expect(containmentParents([cShape, inNotch, inBody])).toEqual([-1, -1, 0]);
  });

  it('tries other vertices when the first one lies on the container boundary', () => {
    const outer = rect(0, 0, 100, 100);
    // First vertex sits exactly on the outer's left edge; the rest is inside.
    const touching: Polyline = {
      points: [
        { x: 0, y: 50 },
        { x: 20, y: 40 },
        { x: 20, y: 60 },
      ],
      closed: true,
    };
    // First vertex touches the outer from outside; the rest is outside.
    const outside: Polyline = {
      points: [
        { x: 100, y: 50 },
        { x: 120, y: 40 },
        { x: 120, y: 60 },
      ],
      closed: true,
    };
    expect(containmentParents([outer, touching, outside])).toEqual([-1, 0, -1]);
  });

  it('does not treat a contour inscribed on its container boundary as contained', () => {
    // Every vertex of the diamond lies on the square's boundary.
    const diamond: Polyline = {
      points: [
        { x: 50, y: 0 },
        { x: 100, y: 50 },
        { x: 50, y: 100 },
        { x: 0, y: 50 },
      ],
      closed: true,
    };
    expect(containmentParents([rect(0, 0, 100, 100), diamond])).toEqual([-1, -1]);
  });

  it('picks the smallest of several containers', () => {
    // A long thin container and a big square both contain the dot.
    const thin = rect(10, 49, 400, 2);
    const big = rect(0, 0, 500, 500);
    const dot = rect(200, 49.5, 1, 1);
    expect(containmentParents([big, thin, dot])).toEqual([-1, 0, 1]);
  });

  it('ignores empty and degenerate paths', () => {
    const empty: Polyline = { points: [], closed: true };
    const twoPoint: Polyline = {
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      closed: true,
    };
    const nan: Polyline = { points: [{ x: Number.NaN, y: 0 }], closed: false };
    const parents = containmentParents([empty, twoPoint, rect(10, 10, 5, 5), nan]);
    expect(parents).toEqual([-1, -1, -1, -1]);
  });

  it('always returns a forest on overlapping random rectangles', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const paths: Polyline[] = [];
    for (let i = 0; i < 400; i++) {
      paths.push(rect(random() * 100, random() * 100, 1 + random() * 40, 1 + random() * 40, random() > 0.1));
    }
    const parents = containmentParents(paths);
    assertForest(parents);
    for (let i = 0; i < parents.length; i++) {
      const parent = parents[i] ?? -1;
      if (parent >= 0) expect(paths[parent]?.closed).toBe(true);
    }
  });

  it('handles 20k paths quickly', () => {
    const paths: Polyline[] = [rect(-5, -5, 1010, 1010)];
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) {
        paths.push(rect(i * 10, j * 10, 8, 8));
        paths.push(rect(i * 10 + 2, j * 10 + 2, 3, 3));
      }
    }
    const t0 = performance.now();
    const parents = containmentParents(paths);
    const elapsed = performance.now() - t0;
    expect(parents[0]).toBe(-1);
    for (let k = 1; k < paths.length; k += 2) {
      expect(parents[k]).toBe(0);
      expect(parents[k + 1]).toBe(k);
    }
    expect(elapsed).toBeLessThan(2000);
  });
});
