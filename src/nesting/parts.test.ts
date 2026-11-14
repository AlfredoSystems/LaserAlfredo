import { describe, expect, it } from 'vitest';
import { boundsOfPoints } from '../geometry/bounds';
import type { Shape } from '../model/types';
import { clampQuantity, findParts, partSources, sheetShapes, toNestParts } from './parts';
import type { NestSheet } from './types';

function rect(id: string, x: number, y: number, w: number, h: number, color = '#000000'): Shape {
  return {
    id,
    color,
    closed: true,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

function line(id: string, x1: number, y1: number, x2: number, y2: number, color = '#000000'): Shape {
  return {
    id,
    color,
    closed: false,
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
  };
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('findParts', () => {
  it('returns nothing for an empty document', () => {
    expect(findParts([])).toEqual([]);
  });

  it('makes one part per top-level contour, in document order', () => {
    const parts = findParts([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 30, 5)]);
    expect(parts.map((part) => part.id)).toEqual(['a', 'b']);
    expect(parts.map((part) => part.shapeIds)).toEqual([['a'], ['b']]);
    expect(parts[1]).toMatchObject({ closed: true, holes: [], widthMm: 30, heightMm: 5 });
  });

  it('keeps holes with their part and lists empty holes as usable', () => {
    const hole = rect('hole', 10, 10, 20, 20);
    const outer = rect('outer', 0, 0, 100, 100);
    const parts = findParts([hole, outer]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.id).toBe('outer');
    expect(parts[0]?.shapeIds).toEqual(['outer', 'hole']);
    expect(parts[0]?.outline).toEqual(outer.points);
    expect(parts[0]?.holes).toEqual([hole.points]);
  });

  it('moves nested islands with the outer part and does not offer their hole for filling', () => {
    const shapes = [
      rect('outer', 0, 0, 100, 100),
      rect('hole', 10, 10, 50, 50),
      rect('island', 20, 20, 20, 20),
      rect('island-hole', 25, 25, 5, 5),
      rect('empty-hole', 70, 70, 20, 20),
    ];
    const parts = findParts(shapes);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.shapeIds).toEqual(['outer', 'hole', 'island', 'island-hole', 'empty-hole']);
    // Only the direct, empty hole is usable: 'hole' has an island in it, and
    // 'island-hole' is not directly inside the outline.
    expect(parts[0]?.holes).toEqual([shapes[4]?.points]);
  });

  it('does not offer a hole that has an open mark inside it', () => {
    const parts = findParts([rect('outer', 0, 0, 100, 100), rect('hole', 10, 10, 50, 50), line('mark', 20, 20, 40, 40)]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.shapeIds).toEqual(['outer', 'hole', 'mark']);
    expect(parts[0]?.holes).toEqual([]);
  });

  it('attaches open shapes inside a contour to that part', () => {
    const parts = findParts([line('mark', 10, 10, 40, 10), rect('outer', 0, 0, 50, 50), rect('other', 100, 0, 10, 10)]);
    expect(parts.map((part) => part.id)).toEqual(['outer', 'other']);
    expect(parts[0]?.shapeIds).toEqual(['outer', 'mark']);
    expect(parts[0]?.holes).toEqual([]);
  });

  it('makes a top-level open shape its own open part', () => {
    const parts = findParts([rect('outer', 0, 0, 50, 50), line('loose', 100, 0, 130, 40)]);
    expect(parts.map((part) => part.id)).toEqual(['outer', 'loose']);
    expect(parts[1]).toMatchObject({ closed: false, shapeIds: ['loose'], holes: [], widthMm: 30, heightMm: 40 });
  });

  it('never lets an open shape contain anything', () => {
    const open: Shape = { ...rect('open', 0, 0, 100, 100), closed: false };
    const parts = findParts([open, rect('inside', 10, 10, 10, 10)]);
    expect(parts.map((part) => part.id)).toEqual(['open', 'inside']);
  });

  it('keeps identical duplicates as separate parts', () => {
    const parts = findParts([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)]);
    expect(parts.map((part) => part.shapeIds)).toEqual([['a'], ['b']]);
  });
});

describe('toNestParts', () => {
  const groups = findParts([
    rect('outer', 0, 0, 100, 100),
    rect('hole', 10, 10, 20, 20),
    rect('b', 200, 0, 10, 10),
    line('c', 300, 0, 310, 10),
  ]);

  it('defaults to one rotatable copy of each part', () => {
    const parts = toNestParts(groups, () => undefined);
    expect(parts.map((part) => [part.id, part.quantity, part.canRotate, part.closed])).toEqual([
      ['outer', 1, true, true],
      ['b', 1, true, true],
      ['c', 1, true, false],
    ]);
    expect(parts[0]?.outline).toEqual(groups[0]?.outline);
    expect(parts[0]?.holes).toHaveLength(1);
  });

  it('applies quantities and rotation locks, and drops parts with no copies', () => {
    const settings = new Map([
      ['outer', { quantity: 3, canRotate: false }],
      ['b', { quantity: 0, canRotate: true }],
      ['c', { quantity: 2.4, canRotate: true }],
    ]);
    const parts = toNestParts(groups, (id) => settings.get(id));
    expect(parts.map((part) => [part.id, part.quantity, part.canRotate])).toEqual([
      ['outer', 3, false],
      ['c', 2, true],
    ]);
  });

  it('clamps quantities to whole numbers from 0 to 999', () => {
    expect(clampQuantity(-4)).toBe(0);
    expect(clampQuantity(2.5)).toBe(3);
    expect(clampQuantity(5000)).toBe(999);
    expect(clampQuantity(Number.NaN)).toBe(0);
    expect(clampQuantity(Infinity)).toBe(0);
  });
});

describe('sheetShapes', () => {
  const shapes = [rect('outer', 10, 20, 40, 20, '#0000ff'), line('mark', 15, 25, 30, 25, '#ff0000'), rect('b', 200, 0, 10, 10)];
  const groups = findParts(shapes);
  const sources = partSources(groups, shapes);

  it('collects the source shapes of each part', () => {
    expect([...sources.keys()]).toEqual(['outer', 'b']);
    expect(sources.get('outer')?.map((shape) => shape.id)).toEqual(['outer', 'mark']);
  });

  it('copies every shape of a part once per placement, keeping colour and closed flag', () => {
    const sheet: NestSheet = {
      usedLengthMm: 0,
      placements: [
        { partId: 'outer', copy: 0, rotationDeg: 0, dx: -10, dy: -20 },
        { partId: 'outer', copy: 1, rotationDeg: 0, dx: 90, dy: -20 },
        { partId: 'b', copy: 0, rotationDeg: 0, dx: 0, dy: 100 },
      ],
    };
    const placed = sheetShapes(sheet, sources, counter('n'));
    expect(placed.map((shape) => shape.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(placed.map((shape) => [shape.color, shape.closed])).toEqual([
      ['#0000ff', true],
      ['#ff0000', false],
      ['#0000ff', true],
      ['#ff0000', false],
      ['#000000', true],
    ]);
    expect(boundsOfPoints(placed[0]?.points ?? [])).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 20 });
    expect(placed[1]?.points).toEqual([
      { x: 5, y: 5 },
      { x: 20, y: 5 },
    ]);
    expect(boundsOfPoints(placed[2]?.points ?? [])).toEqual({ minX: 100, minY: 0, maxX: 140, maxY: 20 });
    expect(boundsOfPoints(placed[4]?.points ?? [])).toEqual({ minX: 200, minY: 100, maxX: 210, maxY: 110 });
    // The sources are left untouched.
    expect(shapes[0]?.points[0]).toEqual({ x: 10, y: 20 });
  });

  it('rotates about the origin before translating', () => {
    // 90° turns (x, y) into (-y, x) with Y down, so the 40 × 20 part at
    // (10, 20) lands on x -40…-20, y 10…50 before the shift.
    const sheet: NestSheet = {
      usedLengthMm: 0,
      placements: [{ partId: 'outer', copy: 0, rotationDeg: 90, dx: 45, dy: -5 }],
    };
    const placed = sheetShapes(sheet, sources, counter('n'));
    const bounds = boundsOfPoints(placed[0]?.points ?? []);
    expect(bounds?.minX).toBeCloseTo(5, 9);
    expect(bounds?.maxX).toBeCloseTo(25, 9);
    expect(bounds?.minY).toBeCloseTo(5, 9);
    expect(bounds?.maxY).toBeCloseTo(45, 9);
    const first = placed[0]?.points[0];
    expect(first?.x).toBeCloseTo(25, 9);
    expect(first?.y).toBeCloseTo(5, 9);
    // The mark keeps its place relative to the outline.
    expect(placed[1]?.points[0]?.x).toBeCloseTo(20, 9);
    expect(placed[1]?.points[0]?.y).toBeCloseTo(10, 9);
  });

  it('skips placements of parts it has no shapes for', () => {
    const sheet: NestSheet = {
      usedLengthMm: 0,
      placements: [{ partId: 'missing', copy: 0, rotationDeg: 0, dx: 0, dy: 0 }],
    };
    expect(sheetShapes(sheet, sources, counter('n'))).toEqual([]);
  });
});
