import { describe, expect, it } from 'vitest';
import type { Point } from '../model/types';
import { distanceToPolyline, distanceToSegment, pointInPolygon, signedArea } from './hit';

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('distanceToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('measures perpendicular distance inside the span', () => {
    expect(distanceToSegment({ x: 4, y: 3 }, a, b)).toBeCloseTo(3, 12);
  });

  it('measures to the nearest endpoint outside the span', () => {
    expect(distanceToSegment({ x: -3, y: 4 }, a, b)).toBeCloseTo(5, 12);
    expect(distanceToSegment({ x: 13, y: -4 }, a, b)).toBeCloseTo(5, 12);
  });

  it('handles a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 12);
  });

  it('is zero on the segment', () => {
    expect(distanceToSegment({ x: 7, y: 0 }, a, b)).toBe(0);
  });
});

describe('distanceToPolyline', () => {
  it('is Infinity for an empty path', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, { points: [], closed: false })).toBe(Infinity);
  });

  it('handles a single point', () => {
    expect(distanceToPolyline({ x: 3, y: 4 }, { points: [{ x: 0, y: 0 }], closed: true })).toBeCloseTo(5, 12);
  });

  it('ignores the closing segment of an open path', () => {
    expect(distanceToPolyline({ x: -1, y: 5 }, { points: square, closed: false })).toBeCloseTo(
      Math.hypot(1, 5),
      12,
    );
  });

  it('includes the closing segment of a closed path', () => {
    expect(distanceToPolyline({ x: -1, y: 5 }, { points: square, closed: true })).toBeCloseTo(1, 12);
  });

  it('finds the nearest of several segments', () => {
    expect(distanceToPolyline({ x: 8, y: 5 }, { points: square, closed: false })).toBeCloseTo(2, 12);
  });
});

describe('pointInPolygon', () => {
  it('detects inside and outside of a square', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: -1 }, square)).toBe(false);
    expect(pointInPolygon({ x: -0.001, y: 5 }, square)).toBe(false);
  });

  it('gives the same answer for either winding', () => {
    const reversed = square.slice().reverse();
    expect(pointInPolygon({ x: 5, y: 5 }, reversed)).toBe(true);
    expect(pointInPolygon({ x: 11, y: 5 }, reversed)).toBe(false);
  });

  it('handles a concave polygon', () => {
    const lShape: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 2, y: 8 }, lShape)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 2 }, lShape)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 8 }, lShape)).toBe(false);
  });

  it('uses the even-odd rule on self-intersecting input', () => {
    // A pentagram: the central pentagon is wound twice, so even-odd excludes it.
    const star: Point[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      star.push({ x: 10 * Math.cos(a), y: 10 * Math.sin(a) });
    }
    expect(pointInPolygon({ x: 0, y: 0 }, star)).toBe(false);
    expect(pointInPolygon({ x: 0, y: -7 }, star)).toBe(true);
  });

  it('returns false for degenerate polygons', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
  });
});

describe('signedArea', () => {
  it('is positive for increasing-angle winding and negative when reversed', () => {
    expect(signedArea(square)).toBeCloseTo(100, 12);
    expect(signedArea(square.slice().reverse())).toBeCloseTo(-100, 12);
  });

  it('computes a triangle', () => {
    expect(signedArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toBeCloseTo(6, 12);
  });

  it('is zero for degenerate input', () => {
    expect(signedArea([])).toBe(0);
    expect(signedArea([{ x: 1, y: 1 }])).toBe(0);
    expect(signedArea([{ x: 1, y: 1 }, { x: 5, y: 5 }])).toBe(0);
  });
});
