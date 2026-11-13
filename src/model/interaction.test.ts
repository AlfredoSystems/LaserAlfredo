import { describe, expect, it } from 'vitest';
import { handlePosition, resizeMatrix, rotateDragMatrix, scaleDragMatrix } from './handles';
import { boundsOfShapes, pickShape, shapesInRect } from './selection';
import { applyToPoint, IDENTITY } from './transform';
import type { Bounds, Shape } from './types';
import { fitBounds, toDocument, toScreen, zoomAt } from './view';

const rect = (id: string, x: number, y: number, w: number, h: number, closed = true): Shape => ({
  id,
  color: '#000000',
  closed,
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
});

const box: Bounds = { minX: 10, minY: 20, maxX: 110, maxY: 70 };

function expectPoint(actual: { x: number; y: number }, x: number, y: number) {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
}

describe('selection', () => {
  const shapes = [rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10), rect('open', 40, 0, 10, 10, false)];

  it('computes bounds of all or some shapes', () => {
    expect(boundsOfShapes(shapes)).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 10 });
    expect(boundsOfShapes(shapes, new Set(['b']))).toEqual({ minX: 20, minY: 0, maxX: 30, maxY: 10 });
    expect(boundsOfShapes(shapes, new Set())).toBeNull();
  });

  it('picks by outline, not interior', () => {
    expect(pickShape(shapes, { x: 5, y: 0.4 }, 0.5)?.id).toBe('a');
    expect(pickShape(shapes, { x: 5, y: 5 }, 0.5)).toBeNull();
    expect(pickShape(shapes, { x: 30.3, y: 5 }, 0.5)?.id).toBe('b');
  });

  it('ignores the missing closing edge of an open path', () => {
    expect(pickShape(shapes, { x: 40, y: 5 }, 0.5)).toBeNull();
    expect(pickShape(shapes, { x: 50, y: 5 }, 0.5)?.id).toBe('open');
  });

  it('prefers the topmost shape when outlines overlap', () => {
    const stacked = [rect('bottom', 0, 0, 10, 10), rect('top', 0, 0, 10, 10)];
    expect(pickShape(stacked, { x: 5, y: 0 }, 0.5)?.id).toBe('top');
  });

  it('marquee enclose needs the whole shape, cross needs a touch', () => {
    const area: Bounds = { minX: -1, minY: -1, maxX: 25, maxY: 11 };
    expect(shapesInRect(shapes, area, 'enclose').map((s) => s.id)).toEqual(['a']);
    expect(shapesInRect(shapes, area, 'cross').map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('cross marquee inside a closed shape does not select it', () => {
    const inside: Bounds = { minX: 3, minY: 3, maxX: 6, maxY: 6 };
    expect(shapesInRect(shapes, inside, 'cross')).toEqual([]);
  });

  it('cross marquee catches an edge passing through without a vertex inside', () => {
    const strip: Bounds = { minX: 4, minY: -2, maxX: 6, maxY: 2 };
    expect(shapesInRect(shapes, strip, 'cross').map((s) => s.id)).toEqual(['a']);
  });
});

describe('scaleDragMatrix', () => {
  it('scales from the opposite corner and keeps aspect when uniform', () => {
    const m = scaleDragMatrix(box, 'se', { x: 210, y: 70 }, { uniform: true, fromCenter: false });
    expectPoint(applyToPoint(m, { x: 10, y: 20 }), 10, 20);
    expectPoint(applyToPoint(m, { x: 110, y: 70 }), 210, 120);
  });

  it('scales axes independently when not uniform', () => {
    const m = scaleDragMatrix(box, 'se', { x: 210, y: 45 }, { uniform: false, fromCenter: false });
    expectPoint(applyToPoint(m, { x: 110, y: 70 }), 210, 45);
  });

  it('side handles change one axis only', () => {
    const m = scaleDragMatrix(box, 'w', { x: -40, y: 999 }, { uniform: true, fromCenter: false });
    expectPoint(applyToPoint(m, { x: 10, y: 20 }), -40, 20);
    expectPoint(applyToPoint(m, { x: 110, y: 70 }), 110, 70);
  });

  it('scales about the centre on request', () => {
    const m = scaleDragMatrix(box, 'e', { x: 160, y: 0 }, { uniform: false, fromCenter: true });
    expectPoint(applyToPoint(m, { x: 110, y: 45 }), 160, 45);
    expectPoint(applyToPoint(m, { x: 10, y: 45 }), -40, 45);
  });

  it('never collapses to zero size or produces NaN', () => {
    const m = scaleDragMatrix(box, 'se', { x: 10, y: 20 }, { uniform: true, fromCenter: false });
    expect(m.every(Number.isFinite)).toBe(true);
    expect(m[0]).not.toBe(0);
    expect(m[3]).not.toBe(0);
  });

  it('handles a zero-height selection (a horizontal line)', () => {
    const flat: Bounds = { minX: 0, minY: 5, maxX: 100, maxY: 5 };
    const m = scaleDragMatrix(flat, 'se', { x: 200, y: 50 }, { uniform: true, fromCenter: false });
    expect(m.every(Number.isFinite)).toBe(true);
    expectPoint(applyToPoint(m, { x: 100, y: 5 }), 200, 5);
  });

  it('returns identity when the handle has not moved', () => {
    expect(scaleDragMatrix(box, 'se', handlePosition(box, 'se'), { uniform: true, fromCenter: false })).toBe(IDENTITY);
  });
});

describe('rotateDragMatrix and resizeMatrix', () => {
  it('rotates by the swept angle, clockwise on screen for a downward drag', () => {
    const m = rotateDragMatrix({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 });
    expectPoint(applyToPoint(m, { x: 10, y: 0 }), 0, 10);
  });

  it('snaps to the given step', () => {
    const step = Math.PI / 12;
    const m = rotateDragMatrix({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3.2 }, step);
    const p = applyToPoint(m, { x: 10, y: 0 });
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(step, 9);
  });

  it('resizes to an exact size from the top-left corner', () => {
    const m = resizeMatrix(box, 50, 100);
    expectPoint(applyToPoint(m, { x: 10, y: 20 }), 10, 20);
    expectPoint(applyToPoint(m, { x: 110, y: 70 }), 60, 120);
  });

  it('leaves a flat dimension alone', () => {
    const flat: Bounds = { minX: 0, minY: 5, maxX: 100, maxY: 5 };
    const m = resizeMatrix(flat, 50, 30);
    expectPoint(applyToPoint(m, { x: 100, y: 5 }), 50, 5);
  });
});

describe('view', () => {
  it('round-trips between screen and document', () => {
    const view = { scale: 2.5, offsetX: 30, offsetY: -12 };
    expectPoint(toDocument(view, toScreen(view, { x: 123, y: 45 })), 123, 45);
  });

  it('zooms about the cursor', () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    const cursor = { x: 200, y: 100 };
    const before = toDocument(view, cursor);
    const zoomed = zoomAt(view, cursor, 3);
    expect(zoomed.scale).toBe(3);
    expectPoint(toDocument(zoomed, cursor), before.x, before.y);
  });

  it('clamps the zoom range', () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    expect(zoomAt(view, { x: 0, y: 0 }, 1e9).scale).toBeLessThanOrEqual(2000);
    expect(zoomAt(view, { x: 0, y: 0 }, 1e-9).scale).toBeGreaterThan(0);
  });

  it('fits bounds centred inside the viewport with padding', () => {
    const view = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 600 }, 1080, 680, 40);
    expect(view.scale).toBeCloseTo(1, 9);
    expectPoint(toScreen(view, { x: 500, y: 300 }), 540, 340);
  });

  it('survives a zero-size target and a tiny viewport', () => {
    const view = fitBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 0, 0);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
  });
});
