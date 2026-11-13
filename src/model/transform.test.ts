import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  applyToPoint,
  applyToPoints,
  compose,
  determinant,
  rotation,
  scaling,
  translation,
} from './transform';
import type { Matrix } from './transform';
import type { Point } from './types';

function expectPoint(actual: Point, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 10);
  expect(actual.y).toBeCloseTo(y, 10);
}

describe('transform', () => {
  it('identity leaves points alone', () => {
    expect(applyToPoint(IDENTITY, { x: 3, y: -4 })).toEqual({ x: 3, y: -4 });
  });

  it('translates', () => {
    expect(applyToPoint(translation(5, -2), { x: 1, y: 1 })).toEqual({ x: 6, y: -1 });
  });

  it('compose applies the second argument first', () => {
    const scale = scaling(2, 2);
    const move = translation(10, 0);
    // Scale first, then move.
    expectPoint(applyToPoint(compose(move, scale), { x: 1, y: 1 }), 12, 2);
    // Move first, then scale.
    expectPoint(applyToPoint(compose(scale, move), { x: 1, y: 1 }), 22, 2);
  });

  it('compose matches applying the matrices one after the other', () => {
    const first: Matrix = [1.5, 0.2, -0.7, 2, 3, -4];
    const second = rotation(0.6, { x: 2, y: 9 });
    const p = { x: 7, y: -3 };
    const stepwise = applyToPoint(second, applyToPoint(first, p));
    const combined = applyToPoint(compose(second, first), p);
    expectPoint(combined, stepwise.x, stepwise.y);
  });

  it('compose with identity changes nothing', () => {
    const m: Matrix = [1.5, 0.2, -0.7, 2, 3, -4];
    expect(compose(m, IDENTITY)).toEqual(m);
    expect(compose(IDENTITY, m)).toEqual(m);
  });

  it('compose is associative', () => {
    const a = rotation(0.3);
    const b = scaling(2, 0.5, { x: 1, y: 1 });
    const c = translation(-4, 6);
    const left = compose(compose(a, b), c);
    const right = compose(a, compose(b, c));
    for (let i = 0; i < 6; i++) {
      expect(left[i]).toBeCloseTo(right[i] ?? NaN, 10);
    }
  });

  it('rotates about the document origin, clockwise on screen for positive angles', () => {
    // Y points down, so +90 degrees takes +X to +Y.
    expectPoint(applyToPoint(rotation(Math.PI / 2), { x: 1, y: 0 }), 0, 1);
    expectPoint(applyToPoint(rotation(Math.PI / 2), { x: 0, y: 1 }), -1, 0);
  });

  it('rotates about a given origin', () => {
    const origin = { x: 10, y: 20 };
    const m = rotation(Math.PI / 2, origin);
    expectPoint(applyToPoint(m, origin), 10, 20);
    expectPoint(applyToPoint(m, { x: 15, y: 20 }), 10, 25);
    expectPoint(applyToPoint(rotation(Math.PI, origin), { x: 13, y: 24 }), 7, 16);
  });

  it('rotation preserves distance from the origin', () => {
    const origin = { x: -3, y: 8 };
    const p = { x: 4, y: 1 };
    const q = applyToPoint(rotation(1.234, origin), p);
    expect(Math.hypot(q.x - origin.x, q.y - origin.y)).toBeCloseTo(Math.hypot(p.x - origin.x, p.y - origin.y), 10);
  });

  it('scales about the document origin', () => {
    expectPoint(applyToPoint(scaling(2, 3), { x: 4, y: 5 }), 8, 15);
  });

  it('scales about a given origin', () => {
    const origin = { x: 10, y: 10 };
    const m = scaling(2, 0.5, origin);
    expectPoint(applyToPoint(m, origin), 10, 10);
    expectPoint(applyToPoint(m, { x: 12, y: 14 }), 14, 12);
    expectPoint(applyToPoint(m, { x: 0, y: 0 }), -10, 5);
  });

  it('applies to arrays of points', () => {
    expect(applyToPoints(translation(1, 2), [{ x: 0, y: 0 }, { x: 5, y: 5 }])).toEqual([
      { x: 1, y: 2 },
      { x: 6, y: 7 },
    ]);
    expect(applyToPoints(IDENTITY, [])).toEqual([]);
  });

  it('computes the determinant', () => {
    expect(determinant(IDENTITY)).toBe(1);
    expect(determinant(translation(100, -50))).toBe(1);
    expect(determinant(rotation(0.77, { x: 3, y: 4 }))).toBeCloseTo(1, 12);
    expect(determinant(scaling(2, 3))).toBe(6);
    expect(determinant(scaling(-1, 1))).toBe(-1);
    expect(determinant(scaling(0, 5))).toBe(0);
  });

  it('determinant of a composition is the product of determinants', () => {
    const a = scaling(2, -3, { x: 1, y: 2 });
    const b = rotation(0.4);
    expect(determinant(compose(a, b))).toBeCloseTo(determinant(a) * determinant(b), 10);
  });
});
