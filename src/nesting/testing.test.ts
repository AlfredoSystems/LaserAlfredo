import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { circle, part, rectangle, validateNest } from './testing';
import { DEFAULT_NEST_OPTIONS } from './types';
import type { NestInput, NestPlacement, NestResult } from './types';

/** The layout checker has to catch broken layouts, or the engine tests prove nothing. */
describe('validateNest', () => {
  const input: NestInput = {
    parts: [
      part('a', rectangle(100, 50), { quantity: 2 }),
      part('fixed', rectangle(30, 30), { canRotate: false }),
      part('frame', rectangle(200, 200), { holes: [rectangle(100, 100, 50, 50)] }),
      part('big', rectangle(5000, 10)),
    ],
    options: { ...DEFAULT_NEST_OPTIONS, marginMm: 5, spacingMm: 2, rotationStepDeg: 90, useHoles: true },
    seed: 1,
  };
  const good: NestPlacement[] = [
    { partId: 'a', copy: 0, rotationDeg: 0, dx: 5, dy: 5 },
    { partId: 'a', copy: 1, rotationDeg: 90, dx: 157, dy: 5 }, // turned: spans x 107..157
    { partId: 'fixed', copy: 0, rotationDeg: 0, dx: 5, dy: 57 },
    { partId: 'frame', copy: 0, rotationDeg: 0, dx: 300, dy: 5 },
  ];
  const result = (placements: NestPlacement[], extra: Partial<NestResult> = {}): NestResult => {
    const used = 500;
    return {
      sheets: [{ placements, usedLengthMm: used }],
      unplaced: [{ partId: 'big', count: 1 }],
      placedCount: placements.length,
      utilization: 0.5,
      fitness: 1,
      evaluations: 1,
      ...extra,
    };
  };
  const change = (index: number, patch: Partial<NestPlacement>): NestPlacement[] =>
    good.map((p, i) => (i === index ? { ...p, ...patch } : p));

  it('accepts a correct layout', () => {
    expect(validateNest(input, result(good))).toEqual([]);
  });

  it('accepts a part inside a hole, at exactly the spacing', () => {
    // The hole spans x 350..450; a 30 mm square 2 mm from its left and top edges.
    const inHole = change(2, { dx: 352, dy: 57 });
    expect(validateNest(input, result(inHole))).toEqual([]);
  });

  it('rejects a part in a hole when holes are off', () => {
    const inHole = change(2, { dx: 352, dy: 57 });
    const noHoles = { ...input, options: { ...input.options, useHoles: false } };
    expect(validateNest(noHoles, result(inHole)).join()).toContain('too close');
  });

  it('rejects overlap and gaps under the spacing', () => {
    expect(validateNest(input, result(change(2, { dx: 50, dy: 20 }))).join()).toContain('too close');
    // 1.9 mm below part a instead of 2 mm.
    expect(validateNest(input, result(change(2, { dy: 56.9 }))).join()).toContain('too close');
    // 1.99 mm from the hole's edge.
    expect(validateNest(input, result(change(2, { dx: 351.99, dy: 57 }))).join()).toContain('too close');
  });

  it('rejects a part across the margin', () => {
    expect(validateNest(input, result(change(0, { dx: 4.99 }))).join()).toContain('margin');
    expect(validateNest(input, result(change(3, { dy: 396 }))).join()).toContain('margin');
  });

  it('rejects rotations that are not allowed', () => {
    expect(validateNest(input, result(change(2, { rotationDeg: 90, dx: 35 }))).join()).toContain('may not rotate');
    expect(validateNest(input, result(change(0, { rotationDeg: 45, dx: 60 }))).join()).toContain('not a multiple');
    expect(validateNest(input, result(change(0, { rotationDeg: 360 }))).join()).toContain('not a multiple');
  });

  it('rejects wrong counts', () => {
    expect(validateNest(input, result(change(1, { copy: 0, dx: 700, rotationDeg: 0 }))).join()).toContain('placed twice');
    expect(validateNest(input, result(good.slice(1))).join()).toContain('1 placed + 0 unplaced, wanted 2');
    expect(validateNest(input, result(good, { unplaced: [] })).join()).toContain('big');
    expect(validateNest(input, result(good, { placedCount: 7 })).join()).toContain('placedCount');
    expect(validateNest(input, result(change(1, { copy: 2 }))).join()).toContain('bad copy number');
  });

  it('rejects a wrong used length', () => {
    const wrong: NestResult = { ...result(good), sheets: [{ placements: good, usedLengthMm: 499 }] };
    expect(validateNest(input, wrong).join()).toContain('usedLengthMm');
  });

  it('measures the gap between round parts', () => {
    const discs: NestInput = {
      parts: [part('c', circle(20, 180), { quantity: 2 })],
      options: { ...DEFAULT_NEST_OPTIONS, marginMm: 0, spacingMm: 3 },
      seed: 1,
    };
    const at = (gap: number): NestResult => ({
      sheets: [
        {
          placements: [
            { partId: 'c', copy: 0, rotationDeg: 0, dx: 20, dy: 20 },
            { partId: 'c', copy: 1, rotationDeg: 0, dx: 60 + gap, dy: 20 },
          ],
          usedLengthMm: 80 + gap,
        },
      ],
      unplaced: [],
      placedCount: 2,
      utilization: 0.5,
      fitness: 1,
      evaluations: 1,
    });
    expect(validateNest(discs, at(3))).toEqual([]);
    expect(validateNest(discs, at(2.95)).join()).toContain('too close');
  });
});

describe('createRng', () => {
  it('repeats for the same seed and differs for another', () => {
    const a = createRng(123);
    const b = createRng(123);
    const c = createRng(124);
    const first = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(first);
  });

  it('stays inside its ranges', () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const n = rng.int(7);
      expect(Number.isInteger(n) && n >= 0 && n < 7).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(7);
    expect(rng.int(1)).toBe(0);
    expect(rng.int(0)).toBe(0);
  });

  it('accepts odd seeds', () => {
    for (const seed of [Number.NaN, -5, 1e20, 0.5]) {
      const value = createRng(seed).next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
