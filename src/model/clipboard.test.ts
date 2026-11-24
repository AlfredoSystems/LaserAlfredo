import { describe, expect, it } from 'vitest';
import { copyShapes, PASTE_OFFSET_MM, pasteShapes, type PasteOptions } from './clipboard';
import { TOP_LEVEL, unitOf } from './groups';
import { boundsOfShapes } from './selection';
import type { Shape } from './types';

/** A 10 mm square at (x, 0). */
function square(id: string, x: number, color: string, groups?: readonly string[]): Shape {
  const shape: Shape = {
    id,
    color,
    closed: true,
    points: [
      { x, y: 0 },
      { x: x + 10, y: 0 },
      { x: x + 10, y: 10 },
      { x, y: 10 },
    ],
  };
  return groups ? { ...shape, groups } : shape;
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function options(patch: Partial<PasteOptions> = {}): PasteOptions {
  return {
    scope: TOP_LEVEL,
    target: { kind: 'offset', dx: PASTE_OFFSET_MM, dy: PASTE_OFFSET_MM },
    nextShapeId: counter('p'),
    nextGroupId: counter('n'),
    ...patch,
  };
}

const shapes: readonly Shape[] = [
  square('a', 0, '#ff0000', ['A']),
  square('b', 20, '#0000ff', ['A', 'B']),
  square('c', 40, '#0000ff', ['A', 'B']),
  square('e', 80, '#000000'),
];
const ids = (...list: string[]) => new Set(list);

describe('copyShapes', () => {
  it('copies the selected shapes in document order', () => {
    const copied = copyShapes(shapes, ids('e', 'a'), TOP_LEVEL);
    expect(copied.map((shape) => shape.id)).toEqual(['a', 'e']);
    expect(copied[0]).toBe(shapes[0]);
    expect(copyShapes(shapes, ids(), TOP_LEVEL)).toEqual([]);
  });

  it('strips the scope it was copied from', () => {
    const copied = copyShapes(shapes, ids('a', 'b', 'c'), ['A']);
    expect(copied.map((shape) => shape.groups)).toEqual([undefined, ['B'], ['B']]);
    expect('groups' in (copied[0] ?? {})).toBe(false);
    expect(copyShapes(shapes, ids('b'), ['A', 'B']).map((shape) => shape.groups)).toEqual([undefined]);
    // The document's shapes are untouched.
    expect(shapes[1]?.groups).toEqual(['A', 'B']);
  });
});

describe('pasteShapes', () => {
  it('gives fresh shape and group ids and keeps colours and nesting', () => {
    const pasted = pasteShapes(shapes, options());
    expect(pasted.map((shape) => shape.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(pasted.map((shape) => shape.color)).toEqual(['#ff0000', '#0000ff', '#0000ff', '#000000']);
    expect(pasted.map((shape) => shape.groups)).toEqual([['n1'], ['n1', 'n2'], ['n1', 'n2'], undefined]);
    expect(pasted.every((shape) => shape.closed)).toBe(true);
    // Together with the originals, the copy is a unit of its own.
    const all = [...shapes, ...pasted];
    expect(unitOf(all, 'p2', TOP_LEVEL)).toEqual(['p1', 'p2', 'p3']);
    expect(unitOf(all, 'b', TOP_LEVEL)).toEqual(['a', 'b', 'c']);
  });

  it('moves by an offset', () => {
    const pasted = pasteShapes(shapes, options({ target: { kind: 'offset', dx: 10, dy: 20 } }));
    expect(boundsOfShapes(pasted)).toEqual({ minX: 10, minY: 20, maxX: 100, maxY: 30 });
    expect(pasted[1]?.points[0]).toEqual({ x: 30, y: 20 });
    // The clipboard itself is not moved, so the next paste starts from the same place.
    expect(shapes[1]?.points[0]).toEqual({ x: 20, y: 0 });
  });

  it('centres the bounding box of all pasted shapes on a point', () => {
    const pasted = pasteShapes(shapes, options({ target: { kind: 'center', point: { x: 500, y: 300 } } }));
    expect(boundsOfShapes(pasted)).toEqual({ minX: 455, minY: 295, maxX: 545, maxY: 305 });
    // Shapes keep their places relative to each other.
    expect(pasted[3]?.points[0]).toEqual({ x: 535, y: 295 });
  });

  it('does not clamp to the bed', () => {
    const pasted = pasteShapes(shapes, options({ target: { kind: 'center', point: { x: 0, y: 0 } } }));
    expect(boundsOfShapes(pasted)).toEqual({ minX: -45, minY: -5, maxX: 45, maxY: 5 });
  });

  it('joins the scope it is pasted into', () => {
    const pasted = pasteShapes(shapes, options({ scope: ['X', 'Y'] }));
    expect(pasted.map((shape) => shape.groups)).toEqual([
      ['X', 'Y', 'n1'],
      ['X', 'Y', 'n1', 'n2'],
      ['X', 'Y', 'n1', 'n2'],
      ['X', 'Y'],
    ]);
  });

  it('round-trips inside a scope: copies land next to the originals in the same group', () => {
    const copied = copyShapes(shapes, ids('b', 'c'), ['A']);
    const pasted = pasteShapes(copied, options({ scope: ['A'] }));
    expect(pasted.map((shape) => shape.groups)).toEqual([
      ['A', 'n1'],
      ['A', 'n1'],
    ]);
    const all = [...shapes, ...pasted];
    expect(unitOf(all, 'p1', ['A'])).toEqual(['p1', 'p2']);
    expect(unitOf(all, 'p1', TOP_LEVEL)).toEqual(['a', 'b', 'c', 'p1', 'p2']);
  });

  it('pastes the same clipboard twice without sharing groups', () => {
    const nextShapeId = counter('p');
    const nextGroupId = counter('n');
    const first = pasteShapes(shapes, options({ nextShapeId, nextGroupId }));
    const second = pasteShapes(shapes, options({ nextShapeId, nextGroupId }));
    expect(first[0]?.groups).toEqual(['n1']);
    expect(second[0]?.groups).toEqual(['n3']);
    expect(second.map((shape) => shape.id)).toEqual(['p5', 'p6', 'p7', 'p8']);
  });

  it('pastes nothing from an empty clipboard', () => {
    expect(pasteShapes([], options())).toEqual([]);
  });
});
