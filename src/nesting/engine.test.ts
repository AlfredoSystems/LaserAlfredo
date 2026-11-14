import { describe, expect, it } from 'vitest';
import type { Point } from '../model/types';
import { createNester } from './engine';
import { createRng } from './rng';
import { circle, lShape, part, placedArea, rectangle, validateNest } from './testing';
import { DEFAULT_NEST_OPTIONS } from './types';
import type { NestInput, NestOptions, NestPart, NestResult } from './types';

function options(overrides: Partial<NestOptions> = {}): NestOptions {
  return { ...DEFAULT_NEST_OPTIONS, ...overrides };
}

/** Runs the search for up to `steps` layouts; every result must be a valid, strictly better layout. */
function nest(input: NestInput, steps: number): { results: NestResult[]; best: NestResult; done: boolean } {
  const nester = createNester(input);
  const results: NestResult[] = [];
  for (let i = 0; i < steps && !nester.done; i++) {
    const result = nester.step();
    if (i === 0) expect(result, 'the first step returns a result').not.toBeNull();
    if (result === null) continue;
    expect(validateNest(input, result)).toEqual([]);
    const previous = results[results.length - 1];
    if (previous !== undefined) {
      expect(result.fitness).toBeLessThan(previous.fitness);
      expect(result.evaluations).toBeGreaterThan(previous.evaluations);
    }
    results.push(result);
  }
  const best = results[results.length - 1];
  if (best === undefined) throw new Error('no result');
  return { results, best, done: nester.done };
}

function lastLength(result: NestResult): number {
  return result.sheets[result.sheets.length - 1]?.usedLengthMm ?? 0;
}

/** A blob with a concave bite, about 40 vertices. */
function blob(seed: number, radius: number, vertices = 40): Point[] {
  const rng = createRng(seed);
  const bite = rng.next() * 2 * Math.PI;
  const squash = 0.5 + rng.next() * 0.5;
  const depth = 0.2 + rng.next() * 0.4;
  const points: Point[] = [];
  for (let i = 0; i < vertices; i++) {
    const a = (2 * Math.PI * i) / vertices;
    const dent = 1 - depth * Math.exp(-((Math.atan2(Math.sin(a - bite), Math.cos(a - bite)) / 0.6) ** 2));
    points.push({ x: radius * dent * Math.cos(a), y: radius * squash * dent * Math.sin(a) });
  }
  return points;
}

function roundedRectangle(width: number, height: number, radius: number, segments = 8): Point[] {
  const points: Point[] = [];
  const corners: [number, number, number][] = [
    [width - radius, height - radius, 0],
    [radius, height - radius, 90],
    [radius, radius, 180],
    [width - radius, radius, 270],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = ((start + (90 * i) / segments) * Math.PI) / 180;
      points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
  }
  return points;
}

/** An angle bracket with a filleted inside corner. */
function bracket(width: number, height: number, thickness: number, radius: number, segments = 10): Point[] {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: thickness, y: 0 },
  ];
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI - (Math.PI / 2) * (i / segments);
    points.push({ x: thickness + radius + radius * Math.cos(a), y: height - thickness - radius + radius * Math.sin(a) });
  }
  points.push({ x: width, y: height - thickness }, { x: width, y: height }, { x: 0, y: height });
  return points;
}

/** `count` copies spread over a handful of different shapes, most with about 40 vertices. */
function mixedParts(count: number, seed: number): NestPart[] {
  const rng = createRng(seed);
  const parts: NestPart[] = [];
  const kinds = Math.max(4, Math.min(12, Math.round(count / 5)));
  for (let k = 0; k < kinds; k++) {
    const size = 30 + rng.next() * 90;
    const kind = k % 5;
    const outline =
      kind === 0
        ? blob(seed * 100 + k, size * 0.6)
        : kind === 1
          ? roundedRectangle(size * 1.4, size * 0.7, size * 0.12)
          : kind === 2
            ? bracket(size, size * 1.3, size * 0.3, size * 0.15)
            : kind === 3
              ? circle(size * 0.4, 40)
              : rectangle(size * 1.2, size * 0.5);
    const holes = kind === 1 ? [circle(size * 0.2, 24, size * 0.7, size * 0.35)] : [];
    parts.push(part(`p${k}`, outline, { quantity: 0, holes }));
  }
  for (let i = 0; i < count; i++) {
    const k = i % kinds;
    const entry = parts[k];
    if (entry !== undefined) parts[k] = { ...entry, quantity: entry.quantity + 1 };
  }
  return parts;
}

/** Cuts a `width` x `height` rectangle into `count` rectangles, so a perfect layout exists. */
function guillotine(seed: number, width: number, height: number, count: number): NestPart[] {
  const rng = createRng(seed);
  const rects = [{ w: width, h: height }];
  while (rects.length < count) {
    rects.sort((a, b) => b.w * b.h - a.w * a.h);
    const r = rects.shift();
    if (r === undefined) break;
    const f = 0.3 + rng.next() * 0.4;
    if (r.w > r.h) rects.push({ w: Math.round(r.w * f), h: r.h }, { w: r.w - Math.round(r.w * f), h: r.h });
    else rects.push({ w: r.w, h: Math.round(r.h * f) }, { w: r.w, h: r.h - Math.round(r.h * f) });
  }
  return rects.map((r, i) => part(`g${i}`, rectangle(r.w, r.h)));
}

describe('createNester: valid layouts', () => {
  it('tiles rectangles perfectly with no spacing and no margin, then stops', () => {
    const input: NestInput = {
      parts: [part('a', rectangle(100, 50), { quantity: 12 })],
      options: options({ sheetWidthMm: 600, sheetHeightMm: 100, marginMm: 0, spacingMm: 0 }),
      seed: 1,
    };
    const { best, done } = nest(input, 50);
    expect(best.sheets).toHaveLength(1);
    expect(best.placedCount).toBe(12);
    expect(best.utilization).toBeCloseTo(1, 9);
    expect(lastLength(best)).toBeCloseTo(600, 6);
    expect(done).toBe(true);
  });

  it('fits rows that match the sheet height exactly, spacing and margin included', () => {
    // 5 + 50 + 2 + 50 + 2 + 50 + 5 = 164: three rows fit with nothing to spare.
    const input: NestInput = {
      parts: [part('a', rectangle(100, 50), { quantity: 6, canRotate: false })],
      options: options({ sheetWidthMm: 1000, sheetHeightMm: 164, marginMm: 5, spacingMm: 2 }),
      seed: 1,
    };
    const { best } = nest(input, 20);
    expect(lastLength(best)).toBeCloseTo(5 + 100 + 2 + 100, 3);
  });

  it('places a part that is exactly as large as the usable sheet', () => {
    const input: NestInput = {
      parts: [part('a', rectangle(990, 590, 37.3, -12.9))],
      options: options(),
      seed: 1,
    };
    const { best, done } = nest(input, 10);
    expect(best.placedCount).toBe(1);
    expect(best.unplaced).toEqual([]);
    expect(done).toBe(true);
  });

  it('interlocks two L shapes tighter than their bounding boxes', () => {
    const input: NestInput = {
      parts: [part('l', lShape(100, 100, 40), { quantity: 2 })],
      options: options({ sheetWidthMm: 400, sheetHeightMm: 100, marginMm: 0, spacingMm: 0 }),
      seed: 3,
    };
    const { best } = nest(input, 60);
    // Side by side they need 200 mm; hooked into each other, 140 mm.
    expect(lastLength(best)).toBeLessThanOrEqual(140 + 1e-6);
  });

  it('packs concave parts with spacing', () => {
    const input: NestInput = {
      parts: [
        part('l', lShape(80, 120, 30), { quantity: 6 }),
        part('t', [
          { x: 0, y: 0 },
          { x: 90, y: 0 },
          { x: 90, y: 30 },
          { x: 60, y: 30 },
          { x: 60, y: 100 },
          { x: 30, y: 100 },
          { x: 30, y: 30 },
          { x: 0, y: 30 },
        ], { quantity: 6 }),
      ],
      options: options({ sheetHeightMm: 300 }),
      seed: 2,
    };
    const { best } = nest(input, 60);
    expect(best.placedCount).toBe(12);
    expect(best.sheets).toHaveLength(1);
  });

  it('packs circles', () => {
    const input: NestInput = {
      parts: [part('c', circle(40, 64), { quantity: 10 }), part('d', circle(15, 32), { quantity: 12 })],
      options: options({ sheetHeightMm: 250 }),
      seed: 1,
    };
    const { best } = nest(input, 40);
    expect(best.placedCount).toBe(22);
  });

  describe('holes', () => {
    const frame = part('frame', rectangle(200, 200), { holes: [rectangle(150, 150, 25, 25)] });
    const small = part('small', rectangle(40, 40), { quantity: 9 });
    const sheet = { sheetWidthMm: 210, sheetHeightMm: 210, marginMm: 5, spacingMm: 2 };

    it('fills holes when allowed', () => {
      const input: NestInput = { parts: [frame, small], options: options({ ...sheet, useHoles: true }), seed: 1 };
      const { best } = nest(input, 40);
      expect(best.sheets).toHaveLength(1);
      expect(best.placedCount).toBe(10);
    });

    it('keeps out of holes when not allowed', () => {
      const input: NestInput = { parts: [frame, small], options: options({ ...sheet, useHoles: false }), seed: 1 };
      const { best } = nest(input, 40);
      expect(best.sheets).toHaveLength(2);
      expect(best.placedCount).toBe(10);
    });

    it('places a part in a hole that fits it exactly, spacing included', () => {
      // The hole is 44 wide: the 40 mm square plus 2 mm spacing on every side.
      const tight = part('tight', rectangle(200, 200), { holes: [rectangle(44, 44, 78, 78)] });
      const input: NestInput = {
        parts: [tight, part('small', rectangle(40, 40))],
        options: options({ ...sheet, useHoles: true }),
        seed: 1,
      };
      const { best } = nest(input, 40);
      expect(best.sheets).toHaveLength(1);
    });

    it('nests three discs inside a ring', () => {
      const ring = part('ring', circle(100, 64, 100, 100), { holes: [circle(70, 64, 100, 100)], canRotate: false });
      const disc = part('disc', circle(30, 48), { quantity: 3, canRotate: false });
      const input: NestInput = {
        parts: [disc, ring],
        options: options({ sheetWidthMm: 215, sheetHeightMm: 215, marginMm: 5, spacingMm: 2, useHoles: true }),
        seed: 5,
      };
      const { best } = nest(input, 150);
      expect(best.sheets).toHaveLength(1);
      expect(best.placedCount).toBe(4);
    });
  });

  it('nests an open path as a thin strip', () => {
    const zigzag: Point[] = [
      { x: 0, y: 0 },
      { x: 40, y: 30 },
      { x: 80, y: 0 },
      { x: 120, y: 30 },
    ];
    const input: NestInput = {
      parts: [
        part('zig', zigzag, { closed: false, quantity: 5 }),
        part('line', [{ x: 0, y: 0 }, { x: 0, y: 100 }], { closed: false, quantity: 3 }),
        part('box', rectangle(60, 60), { quantity: 4 }),
      ],
      options: options({ sheetHeightMm: 200 }),
      seed: 1,
    };
    const { best } = nest(input, 40);
    expect(best.placedCount).toBe(12);
    expect(best.sheets).toHaveLength(1);
    // Open paths have no area of their own.
    expect(placedArea(input, best)).toBeCloseTo(4 * 3600, 3);
  });

  it('overflows onto more sheets', () => {
    // Six 300 x 250 rectangles fill one sheet (3 across, 2 down).
    const input: NestInput = {
      parts: [part('big', rectangle(300, 250), { quantity: 10 })],
      options: options(),
      seed: 1,
    };
    const { best } = nest(input, 30);
    expect(best.sheets).toHaveLength(2);
    expect(best.sheets[0]?.placements).toHaveLength(6);
    expect(best.sheets[1]?.placements).toHaveLength(4);
    expect(best.unplaced).toEqual([]);
    const material = 1000 * 600 + lastLength(best) * 600;
    expect(best.utilization).toBeCloseTo((10 * 300 * 250) / material, 9);
  });

  it('reports a part that is larger than the sheet and nests the rest', () => {
    const input: NestInput = {
      parts: [
        part('huge', rectangle(1200, 700), { quantity: 3 }),
        part('ok', rectangle(100, 100), { quantity: 2 }),
        part('diagonal', rectangle(995, 10), { quantity: 1 }),
      ],
      options: options(),
      seed: 1,
    };
    const { best } = nest(input, 20);
    expect(best.unplaced).toEqual([
      { partId: 'huge', count: 3 },
      { partId: 'diagonal', count: 1 },
    ]);
    expect(best.placedCount).toBe(2);
    expect(best.fitness).toBeGreaterThan(4e9);
  });

  it('reports everything as unplaced when nothing fits', () => {
    const input: NestInput = {
      parts: [part('huge', rectangle(1200, 700), { quantity: 2 })],
      options: options(),
      seed: 1,
    };
    const nester = createNester(input);
    const result = nester.step();
    expect(result?.sheets).toEqual([]);
    expect(result?.unplaced).toEqual([{ partId: 'huge', count: 2 }]);
    expect(result === null ? [] : validateNest(input, result)).toEqual([]);
    expect(nester.done).toBe(true);
    expect(nester.step()).toBeNull();
  });

  describe('rotation', () => {
    const long = part('long', rectangle(800, 100), { quantity: 2 });
    const sheet = { sheetWidthMm: 300, sheetHeightMm: 900 };

    it('leaves parts as drawn with step 0', () => {
      const input: NestInput = { parts: [long], options: options({ ...sheet, rotationStepDeg: 0 }), seed: 1 };
      const { best } = nest(input, 10);
      expect(best.unplaced).toEqual([{ partId: 'long', count: 2 }]);
    });

    it('turns parts that only fit turned with step 90', () => {
      const input: NestInput = { parts: [long], options: options({ ...sheet, rotationStepDeg: 90 }), seed: 1 };
      const { best } = nest(input, 10);
      expect(best.placedCount).toBe(2);
      for (const placement of best.sheets.flatMap((s) => s.placements)) {
        expect([90, 270]).toContain(placement.rotationDeg);
      }
    });

    it('never turns a part that may not rotate', () => {
      const input: NestInput = {
        parts: [{ ...long, canRotate: false }, part('free', rectangle(200, 60), { quantity: 4 })],
        options: options({ ...sheet, rotationStepDeg: 90 }),
        seed: 1,
      };
      const { best } = nest(input, 30);
      expect(best.unplaced).toEqual([{ partId: 'long', count: 2 }]);
      expect(best.placedCount).toBe(4);
    });

    it('uses 45 degree steps where they help', () => {
      // A 400 mm bar only fits a 300 x 300 sheet on the diagonal.
      const input: NestInput = {
        parts: [part('bar', rectangle(400, 10)), part('tri', [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 0, y: 90 }], { quantity: 4 })],
        options: options({ sheetWidthMm: 300, sheetHeightMm: 300, marginMm: 0, spacingMm: 1, rotationStepDeg: 45 }),
        seed: 1,
      };
      const { best } = nest(input, 60);
      expect(best.unplaced).toEqual([]);
      const bar = best.sheets.flatMap((s) => s.placements).find((p) => p.partId === 'bar');
      expect((bar?.rotationDeg ?? 0) % 90).toBe(45);
    });

    it('accepts odd steps', () => {
      for (const rotationStepDeg of [30, 120, 7, 0.5, 400, -90]) {
        const input: NestInput = {
          parts: [part('l', lShape(60, 90, 20), { quantity: 5 })],
          options: options({ sheetWidthMm: 400, sheetHeightMm: 300, rotationStepDeg }),
          seed: 1,
        };
        const { best } = nest(input, 12);
        expect(best.placedCount).toBe(5);
      }
    });
  });

  it('copes with zero spacing, zero margin and parts drawn far from the origin', () => {
    const far = (points: Point[]): Point[] => points.map((p) => ({ x: p.x + 5234.567, y: p.y - 9876.543 }));
    const input: NestInput = {
      parts: [
        part('a', far(lShape(70, 110, 25)), { quantity: 4 }),
        part('b', far(circle(35, 40)), { quantity: 4 }),
        part('c', far(rectangle(120, 45)), { quantity: 4 }),
      ],
      options: options({ sheetWidthMm: 500, sheetHeightMm: 250, marginMm: 0, spacingMm: 0, rotationStepDeg: 45 }),
      seed: 4,
    };
    const { best } = nest(input, 40);
    expect(best.placedCount).toBe(12);
  });

  it('handles a mix of many parts across several sheets', () => {
    const input: NestInput = {
      parts: mixedParts(40, 7),
      options: options({ sheetWidthMm: 300, sheetHeightMm: 300 }),
      seed: 2,
    };
    const { best } = nest(input, 25);
    expect(best.placedCount).toBe(40);
    expect(best.sheets.length).toBeGreaterThan(1);
  });
});

describe('createNester: degenerate input', () => {
  const weird: [string, NestPart[]][] = [
    ['no parts', []],
    ['quantity 0', [part('a', rectangle(10, 10), { quantity: 0 })]],
    ['negative and fractional quantities', [
      part('a', rectangle(10, 10), { quantity: -3 }),
      part('b', rectangle(10, 10), { quantity: 2.7 }),
      part('c', rectangle(10, 10), { quantity: Number.NaN }),
    ]],
    ['empty outline', [part('a', [], { quantity: 2 }), part('b', rectangle(10, 10))]],
    ['one point', [part('a', [{ x: 5, y: 5 }], { quantity: 2 })]],
    ['two points', [part('a', [{ x: 0, y: 0 }, { x: 30, y: 10 }], { quantity: 2 })]],
    ['all points equal', [part('a', [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], { quantity: 2 })]],
    ['collinear points', [part('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], { quantity: 2 })]],
    ['repeated points', [part('a', [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 },
    ], { quantity: 3 })]],
    ['tiny slivers', [
      part('a', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0.0001 }], { quantity: 2 }),
      part('b', [{ x: 0, y: 0 }, { x: 0.00001, y: 0 }, { x: 0.00001, y: 0.00001 }, { x: 0, y: 0.00001 }], { quantity: 2 }),
      part('c', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 25, y: 0.0005 }, { x: 0, y: 20 }], { quantity: 2 }),
    ]],
    ['clockwise and counter-clockwise', [
      part('cw', lShape(60, 80, 20), { quantity: 2 }),
      part('ccw', [...lShape(60, 80, 20)].reverse(), { quantity: 2 }),
    ]],
    ['self-crossing outline', [
      part('bow', [{ x: 0, y: 0 }, { x: 60, y: 60 }, { x: 60, y: 0 }, { x: 0, y: 60 }], { quantity: 3 }),
      part('eight', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 80 }, { x: 40, y: 80 }, { x: 40, y: 40 }, { x: 0, y: 40 }], { quantity: 2 }),
    ]],
    ['points that are not numbers', [
      part('a', [{ x: 0, y: 0 }, { x: Number.NaN, y: 3 }, { x: 40, y: 0 }, { x: 40, y: Infinity }, { x: 40, y: 30 }, { x: 0, y: 30 }], { quantity: 2 }),
      part('b', [{ x: Number.NaN, y: Number.NaN }]),
    ]],
    ['odd holes', [
      part('a', rectangle(100, 100), {
        quantity: 2,
        holes: [
          [],
          [{ x: 10, y: 10 }],
          rectangle(30, 30, 90, 90), // pokes out of the part
          rectangle(300, 300, -100, -100), // swallows the part
          rectangle(20, 20, 20, 20),
          rectangle(20, 20, 30, 30), // overlaps the previous hole
          [{ x: 60, y: 60 }, { x: Number.NaN, y: 0 }, { x: 80, y: 60 }, { x: 80, y: 80 }],
        ],
      }),
      part('b', rectangle(8, 8), { quantity: 6 }),
    ]],
    ['a hole that cuts the part in two', [
      part('a', rectangle(100, 40), { holes: [rectangle(20, 60, 40, -10)] }),
      part('b', rectangle(15, 15), { quantity: 4 }),
    ]],
    ['open path with holes and closed part with two points', [
      part('a', [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], { closed: false, holes: [rectangle(5, 5, 45, 10)] }),
      part('b', [{ x: 0, y: 0 }, { x: 50, y: 50 }], { closed: true }),
    ]],
  ];

  for (const [name, parts] of weird) {
    it(`survives ${name}`, () => {
      for (const useHoles of [true, false]) {
        const input: NestInput = {
          parts,
          options: options({ sheetWidthMm: 300, sheetHeightMm: 200, useHoles, rotationStepDeg: 90 }),
          seed: 9,
        };
        const nester = createNester(input);
        let returned = 0;
        for (let i = 0; i < 25 && !nester.done; i++) {
          const result = nester.step();
          if (i === 0) expect(result).not.toBeNull();
          if (result === null) continue;
          returned += 1;
          expect(validateNest(input, result)).toEqual([]);
        }
        expect(returned).toBeGreaterThan(0);
      }
    });
  }

  it('reports parts without usable geometry as unplaced', () => {
    const input: NestInput = {
      parts: [part('empty', [], { quantity: 2 }), part('nan', [{ x: Number.NaN, y: 0 }]), part('ok', rectangle(10, 10))],
      options: options(),
      seed: 1,
    };
    const { best } = nest(input, 5);
    expect(best.unplaced).toEqual([
      { partId: 'empty', count: 2 },
      { partId: 'nan', count: 1 },
    ]);
    expect(best.placedCount).toBe(1);
  });

  it('returns an empty result for an empty job and is done', () => {
    const nester = createNester({ parts: [], options: options(), seed: 1 });
    expect(nester.done).toBe(false);
    expect(nester.step()).toEqual({
      sheets: [],
      unplaced: [],
      placedCount: 0,
      utilization: 0,
      fitness: 0,
      evaluations: 0,
    });
    expect(nester.done).toBe(true);
    expect(nester.step()).toBeNull();
  });

  it('survives unusable options', () => {
    const bad: Partial<NestOptions>[] = [
      { sheetWidthMm: 0 },
      { sheetHeightMm: -5 },
      { sheetWidthMm: Number.NaN },
      { sheetWidthMm: Infinity },
      { marginMm: 400 },
      { marginMm: -5 },
      { marginMm: Number.NaN },
      { spacingMm: -1 },
      { spacingMm: Number.NaN },
      { spacingMm: 5000 },
      { rotationStepDeg: Number.NaN },
      { rotationStepDeg: Infinity },
      { sheetWidthMm: 1e9, sheetHeightMm: 1e9 },
    ];
    for (const override of bad) {
      const nester = createNester({
        parts: [part('a', rectangle(50, 30), { quantity: 3 }), part('b', circle(20), { quantity: 2 })],
        options: options(override),
        seed: 1,
      });
      for (let i = 0; i < 10 && !nester.done; i++) {
        const result = nester.step();
        if (i === 0) expect(result).not.toBeNull();
        if (result !== null) {
          expect(Number.isFinite(result.fitness)).toBe(true);
          expect(result.placedCount + result.unplaced.reduce((sum, u) => sum + u.count, 0)).toBe(5);
        }
      }
    }
  });

  it('keeps the true part off the margin even when half the spacing is wider than the margin', () => {
    const input: NestInput = {
      parts: [part('a', rectangle(60, 40), { quantity: 6, canRotate: false }), part('c', circle(25), { quantity: 3 })],
      options: options({ sheetWidthMm: 400, sheetHeightMm: 200, marginMm: 1, spacingMm: 10 }),
      seed: 1,
    };
    const { best } = nest(input, 20);
    expect(best.placedCount).toBe(9);
    const xs = best.sheets.flatMap((s) => s.placements.filter((p) => p.partId === 'a')).map((p) => p.dx);
    // A rectangle sits right on the margin line, not half a spacing away from it.
    expect(Math.min(...xs)).toBeCloseTo(1, 6);
  });
});

describe('createNester: search', () => {
  const input: NestInput = { parts: mixedParts(24, 3), options: options({ sheetHeightMm: 300 }), seed: 42 };

  it('is deterministic for a given seed', () => {
    const run = (seed: number): (NestResult | null)[] => {
      const nester = createNester({ ...input, seed });
      const out: (NestResult | null)[] = [];
      for (let i = 0; i < 40; i++) out.push(nester.step());
      return out;
    };
    const first = run(42);
    expect(run(42)).toEqual(first);
    // The opening layouts do not depend on the seed; the search after them does.
    const other = run(43);
    expect(other[0]).toEqual(first[0]);
    expect(other).not.toEqual(first);
  });

  it('only returns strictly better layouts and counts every layout tried', () => {
    const nester = createNester(input);
    let last = Infinity;
    let returned = 0;
    for (let i = 0; i < 80; i++) {
      const result = nester.step();
      if (result === null) continue;
      returned += 1;
      expect(result.fitness).toBeLessThan(last);
      expect(result.evaluations).toBe(i + 1);
      last = result.fitness;
    }
    expect(returned).toBeGreaterThan(1);
  });

  it('ranks unplaced copies over sheets over length', () => {
    const one = nest({ parts: [part('a', rectangle(300, 250), { quantity: 6 })], options: options(), seed: 1 }, 5).best;
    const two = nest({ parts: [part('a', rectangle(300, 250), { quantity: 7 })], options: options(), seed: 1 }, 5).best;
    const missing = nest(
      { parts: [part('a', rectangle(300, 250), { quantity: 1 }), part('x', rectangle(2000, 10))], options: options(), seed: 1 },
      5,
    ).best;
    expect(one.sheets).toHaveLength(1);
    expect(two.sheets).toHaveLength(2);
    expect(one.fitness).toBeLessThan(two.fitness);
    expect(two.fitness).toBeLessThan(missing.fitness);
  });

  it('is done after one layout when there is nothing to choose', () => {
    const nester = createNester({
      parts: [part('a', lShape(60, 80, 20), { canRotate: false })],
      options: options(),
      seed: 1,
    });
    expect(nester.step()).not.toBeNull();
    expect(nester.step()).toBeNull();
    expect(nester.done).toBe(true);
  });

  it('walks a small search space completely and then stops', () => {
    const small: NestInput = {
      parts: [part('a', lShape(60, 80, 20), { quantity: 2 }), part('b', rectangle(50, 30))],
      options: options({ sheetWidthMm: 300, sheetHeightMm: 120, rotationStepDeg: 180 }),
      seed: 1,
    };
    const { done, best } = nest(small, 5000);
    expect(done).toBe(true);
    expect(best.evaluations).toBeLessThan(5000);
    // Another seed walks the same space in another order and ends on the same length.
    expect(lastLength(nest({ ...small, seed: 2 }, 5000).best)).toBeCloseTo(lastLength(best), 6);
  });

  it('keeps going on a large search space', () => {
    const nester = createNester(input);
    for (let i = 0; i < 30; i++) nester.step();
    expect(nester.done).toBe(false);
  });
});

describe('createNester: quality', () => {
  it('tiles a strip of equal rectangles to at least 90 %', () => {
    const input: NestInput = {
      parts: [part('a', rectangle(120, 80), { quantity: 12 })],
      options: options({ sheetWidthMm: 1000, sheetHeightMm: 240, marginMm: 0, spacingMm: 0 }),
      seed: 1,
    };
    const { best } = nest(input, 20);
    expect(best.utilization).toBeGreaterThanOrEqual(0.9);
  });

  it('gets close to a perfect cut of 25 different rectangles', () => {
    // The parts were cut from a 400 x 600 block, so 400 mm is possible.
    const input: NestInput = {
      parts: guillotine(5, 400, 600, 25),
      options: options({ marginMm: 0, spacingMm: 0 }),
      seed: 1,
    };
    const { results, best } = nest(input, 400);
    expect(best.sheets).toHaveLength(1);
    expect(best.utilization).toBeGreaterThanOrEqual(0.91);
    // The search has to earn part of that: the opening layout is clearly worse.
    expect(lastLength(best)).toBeLessThan(lastLength(results[0] as NestResult) - 10);
  });

  it('improves a mixed job well beyond the first layout', () => {
    const input: NestInput = { parts: mixedParts(30, 3), options: options(), seed: 1 };
    const { results, best } = nest(input, 150);
    const first = results[0] as NestResult;
    expect(best.sheets).toHaveLength(1);
    expect(lastLength(best)).toBeLessThan(lastLength(first) * 0.85);
    expect(best.utilization).toBeGreaterThan(0.72);
  });
});

describe('createNester: speed', () => {
  it('shows a first layout of 60 mixed parts quickly and keeps a steady pace', () => {
    const input: NestInput = { parts: mixedParts(60, 1), options: options(), seed: 1 };
    const nester = createNester(input);
    const start = performance.now();
    const first = nester.step();
    const firstMs = performance.now() - start;
    expect(first?.placedCount).toBe(60);
    // Measured at about 20 ms; the limit leaves room for a slow CI machine.
    expect(firstMs).toBeLessThan(1000);
    const more = performance.now();
    for (let i = 0; i < 10; i++) nester.step();
    // Measured at about 25 ms per layout once the no-fit polygons are cached.
    expect((performance.now() - more) / 10).toBeLessThan(500);
  });
});
