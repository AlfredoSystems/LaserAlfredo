import { describe, expect, it } from 'vitest';
import type { Point, Polyline } from '../model/types';
import { containmentParents } from './containment';
import { signedArea } from './hit';
import type { OrderedPath } from './order';
import { cutLength, orderForCutting, travelLength } from './order';

const ORIGIN: Point = { x: 0, y: 0 };

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

function line(x0: number, y0: number, x1: number, y1: number): Polyline {
  return {
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
    ],
    closed: false,
  };
}

function sourceOrder(ordered: readonly OrderedPath[]): number[] {
  return ordered.map((p) => p.sourceIndex);
}

/** Checks the hard rule and that every non-empty input appears exactly once with the same points. */
function assertValidOrder(paths: readonly Polyline[], ordered: readonly OrderedPath[]): void {
  const expected = paths.map((p, i) => (p.points.length > 0 ? i : -1)).filter((i) => i >= 0);
  expect([...sourceOrder(ordered)].sort((a, b) => a - b)).toEqual(expected);

  const position = new Map<number, number>();
  ordered.forEach((p, k) => position.set(p.sourceIndex, k));
  const parents = containmentParents(paths);
  for (let i = 0; i < paths.length; i++) {
    const parent = parents[i] ?? -1;
    const own = position.get(i);
    const parentPosition = position.get(parent);
    if (parent < 0 || own === undefined || parentPosition === undefined) continue;
    expect(own).toBeLessThan(parentPosition);
  }

  const key = (p: Point): string => `${p.x},${p.y}`;
  for (const out of ordered) {
    const source = paths[out.sourceIndex];
    expect(out.closed).toBe(source?.closed);
    expect(out.points.map(key).sort()).toEqual((source?.points ?? []).map(key).sort());
  }
}

function makeRandom(initial: number): () => number {
  let seed = initial;
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('orderForCutting', () => {
  it('returns nothing for empty input', () => {
    expect(orderForCutting([], ORIGIN)).toEqual([]);
  });

  it('skips paths without points', () => {
    const paths: Polyline[] = [{ points: [], closed: false }, rect(0, 0, 5, 5), { points: [], closed: true }];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([1]);
  });

  it('cuts a hole before its outer contour even when the outer is nearer', () => {
    const paths = [rect(0, 0, 100, 100), rect(40, 40, 20, 20)];
    const ordered = orderForCutting(paths, ORIGIN);
    expect(sourceOrder(ordered)).toEqual([1, 0]);
    assertValidOrder(paths, ordered);
  });

  it('cuts 3 nesting levels from the inside out', () => {
    const paths = [rect(0, 0, 100, 100), rect(20, 20, 60, 60), rect(40, 40, 20, 20)];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([2, 1, 0]);
    expect(sourceOrder(orderForCutting([...paths].reverse(), ORIGIN))).toEqual([0, 1, 2]);
  });

  it('cuts open paths inside a contour before the contour', () => {
    const paths = [rect(0, 0, 100, 100), line(30, 30, 70, 70)];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([1, 0]);
  });

  it('finishes each part (holes first) without zig-zagging between parts', () => {
    // Two parts far apart, each with three holes; the input interleaves them.
    const paths = [
      rect(0, 0, 100, 100), // 0: part A
      rect(500, 0, 100, 100), // 1: part B
      rect(10, 10, 10, 10), // 2: hole in A
      rect(510, 10, 10, 10), // 3: hole in B
      rect(45, 45, 10, 10), // 4: hole in A
      rect(545, 45, 10, 10), // 5: hole in B
      rect(80, 80, 10, 10), // 6: hole in A
      rect(580, 80, 10, 10), // 7: hole in B
    ];
    const ordered = orderForCutting(paths, ORIGIN);
    assertValidOrder(paths, ordered);

    const order = sourceOrder(ordered);
    expect(order.slice(0, 3).sort()).toEqual([2, 4, 6]);
    expect(order[3]).toBe(0);
    expect(order.slice(4, 7).sort()).toEqual([3, 5, 7]);
    expect(order[7]).toBe(1);

    const naive = travelLength(paths, ORIGIN);
    const optimised = travelLength(ordered, ORIGIN);
    expect(optimised).toBeLessThan(naive / 3);
    // One trip across to part B plus short hops: less than two crossings.
    expect(optimised).toBeLessThan(1000);
  });

  it('picks the nearest available path first', () => {
    const paths = [rect(200, 0, 10, 10), rect(100, 0, 10, 10), rect(0, 0, 10, 10)];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([2, 1, 0]);
    expect(sourceOrder(orderForCutting(paths, { x: 300, y: 0 }))).toEqual([0, 1, 2]);
  });

  it('reverses an open path when its far end is nearer', () => {
    const path: Polyline = {
      points: [
        { x: 100, y: 0 },
        { x: 50, y: 20 },
        { x: 10, y: 0 },
      ],
      closed: false,
    };
    const [fromOrigin] = orderForCutting([path], ORIGIN);
    expect(fromOrigin?.points).toEqual([
      { x: 10, y: 0 },
      { x: 50, y: 20 },
      { x: 100, y: 0 },
    ]);
    const [fromRight] = orderForCutting([path], { x: 120, y: 0 });
    expect(fromRight?.points).toEqual(path.points);
  });

  it('continues from the exit end of an open path', () => {
    // After the long line the head is at x = 100, so the far square comes next.
    const paths = [line(0, 0, 100, 0), rect(5, 5, 2, 2), rect(101, 0, 2, 2)];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([0, 2, 1]);
  });

  it('rotates a closed ring to its vertex nearest the head and keeps the winding', () => {
    const ring = rect(0, 0, 10, 10);
    const [ordered] = orderForCutting([ring], { x: 12, y: 11 });
    expect(ordered?.points).toEqual([
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(signedArea(ordered?.points ?? [])).toBe(signedArea(ring.points));

    const reversedRing: Polyline = { points: [...ring.points].reverse(), closed: true };
    const [orderedReversed] = orderForCutting([reversedRing], { x: 12, y: 11 });
    expect(orderedReversed?.points).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(signedArea(orderedReversed?.points ?? [])).toBe(signedArea(reversedRing.points));
  });

  it('leaves the head at the entry vertex of a closed path', () => {
    // Entering the big square at (100, 100) leaves the head there, next to path 1.
    const paths = [rect(0, 0, 100, 100), rect(102, 102, 2, 2), rect(-4, -4, 2, 2)];
    const ordered = orderForCutting(paths, { x: 100, y: 101 });
    expect(sourceOrder(ordered)).toEqual([0, 1, 2]);
    expect(ordered[0]?.points[0]).toEqual({ x: 100, y: 100 });
  });

  it('works when the start lies far outside the geometry', () => {
    const paths = [rect(0, 0, 10, 10), rect(50, 0, 10, 10), rect(100, 0, 10, 10)];
    expect(sourceOrder(orderForCutting(paths, { x: 5000, y: -3000 }))).toEqual([2, 1, 0]);
    expect(sourceOrder(orderForCutting(paths, { x: -5000, y: 3000 }))).toEqual([0, 1, 2]);
  });

  it('breaks ties by input order and is deterministic', () => {
    const paths = [rect(10, 0, 5, 5), rect(-15, 0, 5, 5), rect(10, 0, 5, 5)];
    const first = orderForCutting(paths, ORIGIN);
    expect(sourceOrder(first)).toEqual([0, 2, 1]);
    expect(orderForCutting(paths, ORIGIN)).toEqual(first);
  });

  it('handles coincident and single-point paths', () => {
    const dot: Polyline = { points: [{ x: 3, y: 3 }], closed: false };
    const paths = [dot, dot, { points: [{ x: 3, y: 3 }], closed: true }];
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual([0, 1, 2]);
  });

  it('still returns paths with non-finite coordinates', () => {
    const bad: Polyline = {
      points: [
        { x: Number.NaN, y: 0 },
        { x: 5, y: 5 },
      ],
      closed: false,
    };
    const paths = [rect(0, 0, 10, 10), bad];
    expect(sourceOrder(orderForCutting(paths, ORIGIN)).sort()).toEqual([0, 1]);
    expect(sourceOrder(orderForCutting(paths, { x: Number.NaN, y: Number.POSITIVE_INFINITY })).sort()).toEqual([0, 1]);
  });

  it('returns every input exactly once and respects containment on random input', () => {
    const random = makeRandom(987654321);
    const paths: Polyline[] = [];
    for (let i = 0; i < 600; i++) {
      const x = random() * 900;
      const y = random() * 500;
      if (random() < 0.3) paths.push(line(x, y, x + random() * 60 - 30, y + random() * 60 - 30));
      else paths.push(rect(x, y, 1 + random() * 80, 1 + random() * 80));
    }
    const ordered = orderForCutting(paths, ORIGIN);
    expect(ordered).toHaveLength(paths.length);
    assertValidOrder(paths, ordered);
  });

  it('matches a brute-force greedy search', () => {
    const random = makeRandom(2024);
    const paths: Polyline[] = [rect(-10, -10, 1100, 700)];
    for (let i = 0; i < 300; i++) {
      const x = Math.round(random() * 1000);
      const y = Math.round(random() * 600);
      if (i % 3 === 0) paths.push(line(x, y, x + Math.round(random() * 40), y + Math.round(random() * 40)));
      else paths.push(rect(x, y, 1 + Math.round(random() * 5), 1 + Math.round(random() * 5)));
    }
    const parents = containmentParents(paths);
    const pending = paths.map(() => 0);
    for (const parent of parents) if (parent >= 0) pending[parent] = (pending[parent] ?? 0) + 1;
    const done = paths.map(() => false);
    let head = ORIGIN;
    const expected: number[] = [];
    for (let step = 0; step < paths.length; step++) {
      // Lowest path index, then lowest vertex index, wins a tie.
      let best = -1;
      let bestVertex = -1;
      let bestDist = Infinity;
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        if (path === undefined || done[i] === true || (pending[i] ?? 0) > 0) continue;
        for (let v = 0; v < path.points.length; v++) {
          const p = path.points[v];
          if (p === undefined) continue;
          if (!path.closed && v !== 0 && v !== path.points.length - 1) continue;
          const d = (p.x - head.x) ** 2 + (p.y - head.y) ** 2;
          if (d < bestDist) {
            best = i;
            bestVertex = v;
            bestDist = d;
          }
        }
      }
      const path = paths[best];
      if (path === undefined) break;
      done[best] = true;
      expected.push(best);
      const parent = parents[best] ?? -1;
      if (parent >= 0) pending[parent] = (pending[parent] ?? 0) - 1;
      const exitIndex = path.closed ? bestVertex : bestVertex === 0 ? path.points.length - 1 : 0;
      head = path.points[exitIndex] ?? head;
    }
    expect(expected).toHaveLength(paths.length);
    expect(sourceOrder(orderForCutting(paths, ORIGIN))).toEqual(expected);
  });

  it('orders 20k paths in under 2 seconds', () => {
    // 10k parts on a 100 x 100 grid, each an 8-sided outline with a square hole.
    const paths: Polyline[] = [];
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) {
        const cx = i * 10 + 5;
        const cy = j * 6 + 3;
        const outline: Point[] = [];
        for (let k = 0; k < 8; k++) {
          const angle = (k / 8) * Math.PI * 2;
          outline.push({ x: cx + 2.8 * Math.cos(angle), y: cy + 2.8 * Math.sin(angle) });
        }
        paths.push({ points: outline, closed: true });
        paths.push(rect(cx - 0.5, cy - 0.5, 1, 1));
      }
    }
    expect(paths).toHaveLength(20000);
    const t0 = performance.now();
    const ordered = orderForCutting(paths, ORIGIN);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(ordered).toHaveLength(20000);

    const position = new Int32Array(paths.length).fill(-1);
    ordered.forEach((p, k) => {
      position[p.sourceIndex] = k;
    });
    let misordered = 0;
    for (let i = 0; i < paths.length; i += 2) {
      if ((position[i + 1] ?? -1) < 0 || (position[i + 1] ?? 0) > (position[i] ?? 0)) misordered++;
    }
    expect(misordered).toBe(0);
    // The parts sit on a 10 x 6 mm pitch: the average hop must stay around one pitch.
    expect(travelLength(ordered, ORIGIN)).toBeLessThan(20000 * 6);
  });

  it('orders 20k paths inside one large sheet outline in under 2 seconds', () => {
    const paths: Polyline[] = [rect(-5, -5, 1010, 610)];
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 100; j++) paths.push(rect(i * 5, j * 6, 3, 3));
    }
    const t0 = performance.now();
    const ordered = orderForCutting(paths, ORIGIN);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(ordered).toHaveLength(paths.length);
    expect(ordered[ordered.length - 1]?.sourceIndex).toBe(0);
  });
});

describe('travelLength', () => {
  it('is zero for no paths', () => {
    expect(travelLength([], ORIGIN)).toBe(0);
  });

  it('adds the approach and the hops between exit and next entry', () => {
    const paths = [line(3, 4, 10, 4), rect(10, 10, 5, 5), line(10, 20, 0, 20)];
    // 5 to reach (3,4); (10,4) -> (10,10) = 6; closed exits at its first point (10,10) -> (10,20) = 10.
    expect(travelLength(paths, ORIGIN)).toBeCloseTo(21, 12);
  });

  it('skips paths without points', () => {
    const paths = [line(3, 4, 10, 4), { points: [], closed: false }, line(10, 10, 0, 0)];
    expect(travelLength(paths, ORIGIN)).toBeCloseTo(11, 12);
  });
});

describe('cutLength', () => {
  it('measures an open path', () => {
    expect(cutLength({ points: rect(0, 0, 4, 3).points, closed: false })).toBeCloseTo(11, 12);
  });

  it('includes the closing segment of a closed path', () => {
    expect(cutLength(rect(0, 0, 4, 3))).toBeCloseTo(14, 12);
  });

  it('is zero for empty and single-point paths', () => {
    expect(cutLength({ points: [], closed: true })).toBe(0);
    expect(cutLength({ points: [{ x: 1, y: 1 }], closed: true })).toBe(0);
  });
});
