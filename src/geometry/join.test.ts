import { describe, expect, it } from 'vitest';
import type { ColoredPolyline, Point, Polyline } from '../model/types';
import { signedArea } from './hit';
import { DEFAULT_JOIN_TOLERANCE_MM, cleanPolyline, joinPolylines, removeDuplicatePolylines } from './join';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function line(x1: number, y1: number, x2: number, y2: number): Polyline {
  return { points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false };
}

function make(points: Point[], closed: boolean): Polyline {
  return { points, closed };
}

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = must(out[i]);
    out[i] = must(out[j]);
    out[j] = a;
  }
  return out;
}

describe('cleanPolyline', () => {
  it('removes consecutive near-duplicates', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.004, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.009 },
      { x: 10, y: 10 },
    ];
    expect(cleanPolyline(pts, false, 0.01)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('keeps points further apart than the tolerance', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.02, y: 0 }, { x: 0.04, y: 0 }];
    expect(cleanPolyline(pts, false, 0.01)).toEqual(pts);
  });

  it('drops a closing point that repeats the first, only for closed paths', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0.001, y: 0.001 }];
    expect(cleanPolyline(pts, true, 0.01)).toEqual(pts.slice(0, 3));
    expect(cleanPolyline(pts, false, 0.01)).toEqual(pts);
  });

  it('removes exact duplicates with zero tolerance', () => {
    const pts = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 1 }];
    expect(cleanPolyline(pts, true, 0)).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
  });

  it('handles empty, single-point and non-finite input', () => {
    expect(cleanPolyline([], true, 0.01)).toEqual([]);
    expect(cleanPolyline([{ x: 1, y: 1 }], true, 0.01)).toEqual([{ x: 1, y: 1 }]);
    expect(cleanPolyline([{ x: 1, y: 1 }, { x: 1, y: 1 }], true, 0.01)).toEqual([{ x: 1, y: 1 }]);
    expect(cleanPolyline([{ x: 1, y: 1 }, { x: NaN, y: 1 }, { x: 2, y: 2 }], false, 0.01)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });
});

describe('joinPolylines', () => {
  it('has the documented default tolerance', () => {
    expect(DEFAULT_JOIN_TOLERANCE_MM).toBe(0.01);
  });

  it('joins a shuffled, partly reversed square with 0.005 mm gaps into one closed path', () => {
    const lines = [
      line(10, 10.005, 0.005, 10), // third side
      line(10, 10, 10.005, 0), // second side, reversed
      line(0, 0, 10, 0), // first side
      line(0, 0.005, 0, 10), // fourth side, reversed
    ];
    const joined = joinPolylines(lines, 0.01, make);
    expect(joined).toHaveLength(1);
    const path = must(joined[0]);
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(4);
    expect(Math.abs(signedArea(path.points))).toBeCloseTo(100, 0);
    // Every corner is present, within the gap size.
    for (const corner of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]) {
      expect(path.points.some((p) => Math.hypot(p.x - corner.x, p.y - corner.y) <= 0.0051)).toBe(true);
    }
  });

  it('gives the same square whatever the input order and direction', () => {
    const sides = [line(0, 0, 10, 0), line(10.005, 0, 10, 10), line(10, 10.005, 0.005, 10), line(0, 10, 0, 0.005)];
    const random = lcg(7);
    for (let round = 0; round < 20; round++) {
      const input = shuffle(sides, random).map((s) =>
        random() < 0.5 ? s : { points: s.points.slice().reverse(), closed: false },
      );
      const joined = joinPolylines(input, 0.01, make);
      expect(joined).toHaveLength(1);
      expect(must(joined[0]).closed).toBe(true);
      expect(must(joined[0]).points).toHaveLength(4);
      expect(Math.abs(signedArea(must(joined[0]).points))).toBeCloseTo(100, 0);
    }
  });

  it('does not join beyond the tolerance', () => {
    const lines = [line(0, 0, 10, 0), line(10.02, 0, 20, 0)];
    const joined = joinPolylines(lines, 0.01, make);
    expect(joined).toHaveLength(2);
    expect(joined[0]).toBe(lines[0]);
    expect(joined[1]).toBe(lines[1]);
    // The same lines join with a looser tolerance.
    const loose = joinPolylines(lines, 0.05, make);
    expect(loose).toHaveLength(1);
    expect(must(loose[0]).closed).toBe(false);
    expect(must(loose[0]).points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
  });

  it('joins across a grid cell boundary', () => {
    // 9.996 and 10.004 fall in different cells of a 0.01 mm grid.
    const joined = joinPolylines([line(0, 0, 9.996, 9.996), line(10.004, 9.996, 20, 0)], 0.01, make);
    expect(joined).toHaveLength(1);
    expect(must(joined[0]).points).toHaveLength(3);
  });

  it('joins an open chain, reversing paths as needed, in the direction of its first path', () => {
    const joined = joinPolylines(
      [line(10, 0, 20, 0), line(30, 0, 20, 0), line(10, 0, 0, 0), line(30, 0, 40, 5)],
      0.01,
      make,
    );
    expect(joined).toHaveLength(1);
    expect(must(joined[0]).closed).toBe(false);
    expect(must(joined[0]).points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 40, y: 5 },
    ]);
  });

  it('keeps interior points of multi-point paths', () => {
    const a: Polyline = { points: [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 }], closed: false };
    const b: Polyline = { points: [{ x: 20, y: 0 }, { x: 15, y: -1 }, { x: 10, y: 0 }], closed: false };
    const joined = joinPolylines([a, b], 0.01, make);
    expect(must(joined[0]).points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 1 },
      { x: 10, y: 0 },
      { x: 15, y: -1 },
      { x: 20, y: 0 },
    ]);
  });

  it('resolves a T-junction into one chain plus one leftover', () => {
    const lines = [line(0, 0, 10, 0), line(10, 0, 20, 0), line(10, 0, 10, 10)];
    const joined = joinPolylines(lines, 0.01, make);
    expect(joined).toHaveLength(2);
    const total = joined.reduce((sum, p) => sum + p.points.length, 0);
    expect(total).toBe(5);
    expect(joined.every((p) => !p.closed)).toBe(true);
    // Deterministic: ties go to the earlier input, the leftover passes through untouched.
    expect(must(joined[0]).points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
    expect(joined[1]).toBe(lines[2]);
  });

  it('picks the nearest candidate at a crowded junction', () => {
    const lines = [line(0, 0, 10, 0), line(10.008, 0, 20, 5), line(10.002, 0, 20, -5)];
    const joined = joinPolylines(lines, 0.01, make);
    expect(joined).toHaveLength(2);
    expect(must(joined[0]).points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: -5 }]);
    expect(joined[1]).toBe(lines[1]);
  });

  it('passes closed paths through untouched and never joins to them', () => {
    const ring: Polyline = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true };
    const stub = line(0, 0, -5, -5);
    const joined = joinPolylines([ring, stub], 0.01, make);
    expect(joined).toHaveLength(2);
    expect(joined[0]).toBe(ring);
    expect(joined[1]).toBe(stub);
  });

  it('closes an open path whose own ends coincide', () => {
    const open: Polyline = {
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0.003, y: 0.003 }],
      closed: false,
    };
    const joined = joinPolylines([open], 0.01, make);
    expect(joined).toHaveLength(1);
    expect(must(joined[0]).closed).toBe(true);
    expect(must(joined[0]).points).toEqual(open.points.slice(0, 3));
  });

  it('does not close a path with fewer than 3 distinct points', () => {
    const backAndForth: Polyline = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }], closed: false };
    const tiny = line(0, 50, 0.004, 50);
    const doubled: Polyline = {
      points: [{ x: 0, y: 80 }, { x: 10, y: 80 }, { x: 10, y: 80.001 }, { x: 0, y: 80 }],
      closed: false,
    };
    const joined = joinPolylines([backAndForth, tiny, doubled], 0.01, make);
    expect(joined).toHaveLength(3);
    expect(joined.every((p) => !p.closed)).toBe(true);
    expect(joined[0]).toBe(backAndForth);
    expect(joined[1]).toBe(tiny);
    expect(joined[2]).toBe(doubled);
  });

  it('does not close two overlapping lines into a ring', () => {
    const joined = joinPolylines([line(0, 0, 10, 0), line(10, 0, 0, 0)], 0.01, make);
    expect(joined.every((p) => !p.closed)).toBe(true);
    expect(joined.reduce((sum, p) => sum + p.points.length, 0)).toBeGreaterThanOrEqual(3);
  });

  it('builds outputs with make from the first path of each chain, in input order', () => {
    const paths: ColoredPolyline[] = [
      { ...line(100, 0, 110, 0), color: '#ff0000' },
      { ...line(0, 0, 10, 0), color: '#00ff00' },
      { points: [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 55, y: 60 }], closed: true, color: '#0000ff' },
      { ...line(120, 0, 110, 0), color: '#111111' },
      { ...line(10, 0, 10, 10), color: '#222222' },
    ];
    const joined = joinPolylines(paths, 0.01, (points, closed, source) => ({ points, closed, color: source.color }));
    expect(joined.map((p) => p.color)).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    expect(must(joined[0]).points).toEqual([{ x: 100, y: 0 }, { x: 110, y: 0 }, { x: 120, y: 0 }]);
    expect(must(joined[1]).points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(joined[2]).toBe(paths[2]);
  });

  it('passes degenerate paths through', () => {
    const empty: Polyline = { points: [], closed: false };
    const single: Polyline = { points: [{ x: 0, y: 0 }], closed: false };
    const bad: Polyline = { points: [{ x: NaN, y: 0 }, { x: 0, y: 0 }], closed: false };
    const good = line(0, 0, 5, 5);
    const joined = joinPolylines([empty, single, bad, good], 0.01, make);
    expect(joined).toEqual([empty, single, bad, good]);
    expect(joinPolylines([], 0.01, make)).toEqual([]);
  });

  it('joins only exact matches with zero tolerance', () => {
    const joined = joinPolylines([line(0, 0, 10, 0), line(10, 0, 20, 0), line(20.0001, 0, 30, 0)], 0, make);
    expect(joined).toHaveLength(2);
    expect(must(joined[0]).points).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const lines = [line(0, 0, 10, 0), line(20, 0, 10, 0)];
    const snapshot = JSON.stringify(lines);
    joinPolylines(lines, 0.01, make);
    expect(JSON.stringify(lines)).toBe(snapshot);
  });

  it('joins 20k shuffled segments quickly', () => {
    const random = lcg(42);
    const segments: Polyline[] = [];
    const squares = 5000;
    for (let s = 0; s < squares; s++) {
      const x = (s % 100) * 10;
      const y = Math.floor(s / 100) * 10;
      const corners = [
        { x, y },
        { x: x + 6, y },
        { x: x + 6, y: y + 6 },
        { x, y: y + 6 },
      ];
      for (let i = 0; i < 4; i++) {
        const a = must(corners[i]);
        const b = must(corners[(i + 1) % 4]);
        // Jitter the endpoints by up to 0.003 mm so they only nearly coincide.
        const ja = { x: a.x + (random() - 0.5) * 0.006, y: a.y + (random() - 0.5) * 0.006 };
        const jb = { x: b.x + (random() - 0.5) * 0.006, y: b.y + (random() - 0.5) * 0.006 };
        segments.push({ points: random() < 0.5 ? [ja, jb] : [jb, ja], closed: false });
      }
    }
    const input = shuffle(segments, random);
    expect(input).toHaveLength(20000);
    const started = performance.now();
    const joined = joinPolylines(input, 0.01, make);
    const elapsed = performance.now() - started;
    expect(joined).toHaveLength(squares);
    for (const path of joined) {
      expect(path.closed).toBe(true);
      expect(path.points).toHaveLength(4);
    }
    expect(elapsed).toBeLessThan(2000);
  });

  it('joins one 20k-segment chain quickly', () => {
    const random = lcg(99);
    const segments: Polyline[] = [];
    for (let i = 0; i < 20000; i++) {
      const a = { x: i * 0.5, y: Math.sin(i / 50) * 20 };
      const b = { x: (i + 1) * 0.5, y: Math.sin((i + 1) / 50) * 20 };
      segments.push({ points: random() < 0.5 ? [a, b] : [b, a], closed: false });
    }
    const started = performance.now();
    const joined = joinPolylines(shuffle(segments, random), 0.01, make);
    const elapsed = performance.now() - started;
    expect(joined).toHaveLength(1);
    expect(must(joined[0]).closed).toBe(false);
    expect(must(joined[0]).points).toHaveLength(20001);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('removeDuplicatePolylines', () => {
  it('drops a forward duplicate within tolerance and keeps the first', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0.004, 0, 10, 0.004);
    expect(removeDuplicatePolylines([a, b], 0.01)).toEqual([a]);
    expect(removeDuplicatePolylines([a, b], 0.01)[0]).toBe(a);
  });

  it('drops a reversed duplicate', () => {
    const a = line(0, 0, 10, 0);
    const b = line(10, 0, 0, 0);
    expect(removeDuplicatePolylines([a, b], 0.01)).toEqual([a]);
  });

  it('drops reversed multi-point open duplicates', () => {
    const a: Polyline = { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }, { x: 20, y: 3 }], closed: false };
    const b: Polyline = { points: a.points.slice().reverse(), closed: false };
    expect(removeDuplicatePolylines([a, b, a], 0.01)).toEqual([a]);
  });

  it('keeps paths that differ by more than the tolerance', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0, 0, 10, 0.02);
    const c = line(0, 0, 10.5, 0);
    expect(removeDuplicatePolylines([a, b, c], 0.01)).toEqual([a, b, c]);
  });

  it('drops closed duplicates with any cyclic start, forward or reversed', () => {
    const ring: Polyline = {
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 7 }, { x: 5, y: 12 }, { x: -2, y: 6 }],
      closed: true,
    };
    const rotated: Polyline = { points: [...ring.points.slice(2), ...ring.points.slice(0, 2)], closed: true };
    const reversed: Polyline = { points: ring.points.slice().reverse(), closed: true };
    const reversedRotated: Polyline = {
      points: [...reversed.points.slice(3), ...reversed.points.slice(0, 3)],
      closed: true,
    };
    const jittered: Polyline = { points: rotated.points.map((p) => ({ x: p.x + 0.003, y: p.y - 0.003 })), closed: true };
    expect(removeDuplicatePolylines([ring, rotated, reversed, reversedRotated, jittered], 0.01)).toEqual([ring]);
  });

  it('does not treat a cyclic shift of an open path as a duplicate', () => {
    const a: Polyline = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: false };
    const b: Polyline = { points: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }], closed: false };
    expect(removeDuplicatePolylines([a, b], 0.01)).toEqual([a, b]);
  });

  it('distinguishes open from closed and different point counts', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const open: Polyline = { points: pts, closed: false };
    const closed: Polyline = { points: pts, closed: true };
    const longer: Polyline = { points: [...pts, { x: 0, y: 10 }], closed: false };
    expect(removeDuplicatePolylines([open, closed, longer], 0.01)).toEqual([open, closed, longer]);
  });

  it('keeps distinct paths that share a centroid', () => {
    // Crossing diagonals and concentric squares all have the same centroid.
    const a = line(0, 0, 10, 10);
    const b = line(0, 10, 10, 0);
    const c = line(2, 2, 8, 8);
    expect(removeDuplicatePolylines([a, b, c, b], 0.01)).toEqual([a, b, c]);
  });

  it('finds duplicates across a grid cell boundary', () => {
    const a = line(0, 0, 19.992, 0); // centroid x = 9.996
    const b = line(0.008, 0, 20, 0); // centroid x = 10.004
    expect(removeDuplicatePolylines([a, b], 0.01)).toEqual([a]);
  });

  it('keeps extra fields and input order', () => {
    const paths: ColoredPolyline[] = [
      { ...line(0, 0, 10, 0), color: '#ff0000' },
      { ...line(5, 5, 6, 6), color: '#00ff00' },
      { ...line(10, 0, 0, 0), color: '#0000ff' },
    ];
    expect(removeDuplicatePolylines(paths, 0.01).map((p) => p.color)).toEqual(['#ff0000', '#00ff00']);
  });

  it('handles empty input, empty paths and zero tolerance', () => {
    expect(removeDuplicatePolylines([], 0.01)).toEqual([]);
    const empty: Polyline = { points: [], closed: false };
    expect(removeDuplicatePolylines([empty, empty], 0.01)).toEqual([empty, empty]);
    const a = line(0, 0, 10, 0);
    expect(removeDuplicatePolylines([a, line(10, 0, 0, 0), line(0, 0, 10, 0.0001)], 0)).toHaveLength(2);
  });

  it('dedupes 20k lines quickly', () => {
    const random = lcg(5);
    const lines: Polyline[] = [];
    for (let i = 0; i < 10000; i++) {
      const l = line(random() * 1000, random() * 600, random() * 1000, random() * 600);
      lines.push(l);
      lines.push(random() < 0.5 ? l : { points: l.points.slice().reverse(), closed: false });
    }
    const started = performance.now();
    const unique = removeDuplicatePolylines(shuffle(lines, random), 0.01);
    const elapsed = performance.now() - started;
    expect(unique).toHaveLength(10000);
    expect(elapsed).toBeLessThan(2000);
  });
});
