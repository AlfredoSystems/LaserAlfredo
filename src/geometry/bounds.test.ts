import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  boundsContainsBounds,
  boundsContainsPoint,
  boundsHeight,
  boundsIntersect,
  boundsOfPoints,
  boundsOfPolylines,
  boundsWidth,
  unionBounds,
} from './bounds';

describe('boundsOfPoints', () => {
  it('returns null for no points', () => {
    expect(boundsOfPoints([])).toBeNull();
  });

  it('covers all points', () => {
    expect(
      boundsOfPoints([
        { x: 3, y: -2 },
        { x: -1, y: 7 },
        { x: 2, y: 2 },
      ]),
    ).toEqual({ minX: -1, minY: -2, maxX: 3, maxY: 7 });
  });

  it('handles a single point', () => {
    expect(boundsOfPoints([{ x: 5, y: 6 }])).toEqual({ minX: 5, minY: 6, maxX: 5, maxY: 6 });
  });

  it('ignores non-finite points', () => {
    expect(
      boundsOfPoints([
        { x: NaN, y: 1 },
        { x: 1, y: 2 },
        { x: Infinity, y: 0 },
      ]),
    ).toEqual({ minX: 1, minY: 2, maxX: 1, maxY: 2 });
    expect(boundsOfPoints([{ x: NaN, y: NaN }])).toBeNull();
  });
});

describe('unionBounds', () => {
  const a = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
  const b = { minX: 1, minY: -3, maxX: 5, maxY: 1 };

  it('handles nulls', () => {
    expect(unionBounds(null, null)).toBeNull();
    expect(unionBounds(a, null)).toEqual(a);
    expect(unionBounds(null, b)).toEqual(b);
  });

  it('covers both boxes', () => {
    expect(unionBounds(a, b)).toEqual({ minX: 0, minY: -3, maxX: 5, maxY: 2 });
  });
});

describe('boundsOfPolylines', () => {
  it('returns null for no paths or only empty paths', () => {
    expect(boundsOfPolylines([])).toBeNull();
    expect(boundsOfPolylines([{ points: [], closed: false }])).toBeNull();
  });

  it('covers every path', () => {
    expect(
      boundsOfPolylines([
        { points: [{ x: 0, y: 0 }, { x: 10, y: 5 }], closed: false },
        { points: [], closed: false },
        { points: [{ x: -4, y: 20 }], closed: true },
      ]),
    ).toEqual({ minX: -4, minY: 0, maxX: 10, maxY: 20 });
  });
});

describe('bounds helpers', () => {
  const b = { minX: 10, minY: 20, maxX: 40, maxY: 100 };

  it('computes centre, width and height', () => {
    expect(boundsCenter(b)).toEqual({ x: 25, y: 60 });
    expect(boundsWidth(b)).toBe(30);
    expect(boundsHeight(b)).toBe(80);
  });

  it('tests point containment, edges included', () => {
    expect(boundsContainsPoint(b, { x: 25, y: 60 })).toBe(true);
    expect(boundsContainsPoint(b, { x: 10, y: 100 })).toBe(true);
    expect(boundsContainsPoint(b, { x: 9.99, y: 60 })).toBe(false);
    expect(boundsContainsPoint(b, { x: 25, y: 100.01 })).toBe(false);
  });

  it('tests intersection', () => {
    expect(boundsIntersect(b, { minX: 30, minY: 90, maxX: 50, maxY: 120 })).toBe(true);
    expect(boundsIntersect(b, { minX: 40, minY: 100, maxX: 50, maxY: 120 })).toBe(true);
    expect(boundsIntersect(b, { minX: 41, minY: 20, maxX: 50, maxY: 100 })).toBe(false);
    expect(boundsIntersect(b, { minX: 10, minY: 0, maxX: 40, maxY: 19 })).toBe(false);
    expect(boundsIntersect(b, { minX: 15, minY: 30, maxX: 20, maxY: 40 })).toBe(true);
  });

  it('tests box containment', () => {
    expect(boundsContainsBounds(b, { minX: 15, minY: 30, maxX: 20, maxY: 40 })).toBe(true);
    expect(boundsContainsBounds(b, b)).toBe(true);
    expect(boundsContainsBounds(b, { minX: 15, minY: 30, maxX: 41, maxY: 40 })).toBe(false);
    expect(boundsContainsBounds({ minX: 15, minY: 30, maxX: 20, maxY: 40 }, b)).toBe(false);
  });
});
