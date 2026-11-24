import { describe, expect, it } from 'vitest';
import { boundsOfPoints } from '../geometry/bounds';
import { LAYER_PALETTE, normalizeColor } from './document';
import { unitOf } from './groups';
import {
  axesConflict,
  axisValues,
  buildMaterialTest,
  clampTestSteps,
  DEFAULT_MATERIAL_TEST_OPTIONS,
  defaultAxis,
  formatTestValue,
  MATERIAL_TEST_CELL_COLOR,
  MATERIAL_TEST_LABEL_COLOR,
  normalizeMaterialTestOptions,
  type MaterialTest,
  type MaterialTestOptions,
  type TestParameter,
} from './materialTest';
import { boundsOfShapes } from './selection';
import type { Bounds } from './types';

const DEFAULTS = DEFAULT_MATERIAL_TEST_OPTIONS;

function build(options: Partial<MaterialTestOptions> = {}, origin = { x: 10, y: 10 }): MaterialTest {
  let n = 0;
  const test = buildMaterialTest({ ...DEFAULTS, ...options }, { origin, nextShapeId: () => `t${++n}`, groupId: 'g1' });
  if (!test) throw new Error('no test was built');
  return test;
}

/** True when the boxes share more than an edge. */
function overlap(a: Bounds, b: Bounds): boolean {
  const eps = 1e-9;
  return a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minY < b.maxY - eps && b.minY < a.maxY - eps;
}

/** True when `inner` lies within `outer`. */
function inside(inner: Bounds, outer: Bounds): boolean {
  const eps = 1e-9;
  return inner.minX >= outer.minX - eps && inner.maxX <= outer.maxX + eps && inner.minY >= outer.minY - eps && inner.maxY <= outer.maxY + eps;
}

describe('axisValues', () => {
  it('spaces values evenly from the first to the last, both included', () => {
    expect(axisValues({ parameter: 'speed', from: 10, to: 50, steps: 5 })).toEqual([10, 20, 30, 40, 50]);
    expect(axisValues({ parameter: 'power', from: 10, to: 100, steps: 10 })).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('runs downward when from is the larger value', () => {
    expect(axisValues({ parameter: 'power', from: 80, to: 20, steps: 4 })).toEqual([80, 60, 40, 20]);
  });

  it('rounds speed and power to one decimal', () => {
    expect(axisValues({ parameter: 'speed', from: 10, to: 50, steps: 4 })).toEqual([10, 23.3, 36.7, 50]);
  });

  it('rounds passes to whole numbers', () => {
    expect(axisValues({ parameter: 'passes', from: 1, to: 5, steps: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(axisValues({ parameter: 'passes', from: 1, to: 4, steps: 6 })).toEqual([1, 2, 2, 3, 3, 4]);
    expect(axisValues({ parameter: 'passes', from: 1.4, to: 3.6, steps: 4 })).toEqual([1, 2, 3, 4]);
  });

  it('repeats the value when from and to are equal', () => {
    expect(axisValues({ parameter: 'speed', from: 30, to: 30, steps: 4 })).toEqual([30, 30, 30, 30]);
  });

  it('limits the step count to whole numbers from 4 to 10', () => {
    const count = (steps: number) => axisValues({ parameter: 'speed', from: 10, to: 50, steps }).length;
    expect([1, 3, 4, 5, 10, 11, 500].map(count)).toEqual([4, 4, 4, 5, 10, 10, 10]);
    expect([-2, 0, 4.4, 4.6, 9.5, Number.NaN, Infinity].map(clampTestSteps)).toEqual([4, 4, 4, 5, 10, 5, 5]);
  });

  it('keeps values inside the range of their setting', () => {
    expect(axisValues({ parameter: 'power', from: -20, to: 150, steps: 4 })).toEqual([0, 33.3, 66.7, 100]);
    expect(axisValues({ parameter: 'speed', from: 0, to: 9000, steps: 4 })[0]).toBe(0.1);
    expect(axisValues({ parameter: 'speed', from: 0, to: 9000, steps: 4 })[3]).toBe(2000);
    expect(axisValues({ parameter: 'passes', from: 0, to: 400, steps: 4 })).toEqual([1, 34, 67, 100]);
  });
});

describe('normalizeMaterialTestOptions', () => {
  it('leaves the defaults as they are, and they are conservative', () => {
    expect(normalizeMaterialTestOptions(DEFAULTS)).toEqual(DEFAULTS);
    expect(DEFAULTS.columns).toEqual({ parameter: 'speed', from: 10, to: 50, steps: 5 });
    expect(DEFAULTS.rows).toEqual({ parameter: 'power', from: 10, to: 50, steps: 5 });
    expect(DEFAULTS.passes).toBe(1);
    expect(DEFAULTS.labelPowerPct).toBeLessThanOrEqual(15);
    expect(defaultAxis('passes')).toEqual({ parameter: 'passes', from: 1, to: 5, steps: 5 });
  });

  it('clamps every value to its range', () => {
    const options = normalizeMaterialTestOptions({
      columns: { parameter: 'speed', from: -5, to: 5000, steps: 99 },
      rows: { parameter: 'passes', from: 0.2, to: 2.5, steps: 1 },
      cellSizeMm: 1,
      gapMm: -4,
      speedMmS: 0,
      maxPowerPct: 140,
      minPowerPct: -3,
      passes: 0,
      labels: true,
      labelSpeedMmS: 99999,
      labelPowerPct: -1,
    });
    expect(options).toEqual({
      columns: { parameter: 'speed', from: 0.1, to: 2000, steps: 10 },
      rows: { parameter: 'passes', from: 1, to: 3, steps: 4 },
      cellSizeMm: 3,
      gapMm: 0,
      speedMmS: 0.1,
      maxPowerPct: 100,
      minPowerPct: 0,
      passes: 1,
      labels: true,
      labelSpeedMmS: 2000,
      labelPowerPct: 0,
    });
    expect(normalizeMaterialTestOptions({ ...DEFAULTS, cellSizeMm: 80, gapMm: 50 })).toMatchObject({ cellSizeMm: 50, gapMm: 20 });
  });

  it('replaces values that are not numbers by the defaults', () => {
    const options = normalizeMaterialTestOptions({
      ...DEFAULTS,
      columns: { parameter: 'speed', from: Number.NaN, to: Infinity, steps: Number.NaN },
      cellSizeMm: Number.NaN,
      minPowerPct: Number.NaN,
    });
    expect(options.columns).toEqual({ parameter: 'speed', from: 10, to: 50, steps: 5 });
    expect(options.cellSizeMm).toBe(10);
    expect(options.minPowerPct).toBeNull();
  });
});

describe('formatTestValue', () => {
  it('writes numbers without needless decimals', () => {
    expect([10, 12.5, 33.333, 100, 0.1, 2000, 7.04].map(formatTestValue)).toEqual(['10', '12.5', '33.3', '100', '0.1', '2000', '7']);
  });
});

describe('buildMaterialTest', () => {
  it('uses reserved layer colours that are valid and not in the palette', () => {
    for (const color of [MATERIAL_TEST_CELL_COLOR, MATERIAL_TEST_LABEL_COLOR]) {
      expect(normalizeColor(color)).toBe(color);
      expect(LAYER_PALETTE).not.toContain(color);
    }
    expect(MATERIAL_TEST_CELL_COLOR).not.toBe(MATERIAL_TEST_LABEL_COLOR);
  });

  it('makes one closed square per combination, row by row, at the cell pitch', () => {
    const test = build({ labels: false }, { x: 100, y: 50 });
    expect(test.cells).toHaveLength(25);
    expect(test.shapes).toEqual(test.cells);
    test.cells.forEach((cell, index) => {
      const column = index % 5;
      const row = Math.floor(index / 5);
      expect(cell.closed).toBe(true);
      expect(cell.color).toBe(MATERIAL_TEST_CELL_COLOR);
      expect(cell.points).toHaveLength(4);
      expect(boundsOfPoints(cell.points)).toEqual({
        minX: 100 + column * 13,
        minY: 50 + row * 13,
        maxX: 110 + column * 13,
        maxY: 60 + row * 13,
      });
    });
    expect(test.bounds).toEqual({ minX: 100, minY: 50, maxX: 162, maxY: 112 });
    expect([test.widthMm, test.heightMm]).toEqual([62, 62]);
  });

  it('gives every cell its column and row value and the fixed ones', () => {
    const test = build();
    expect(test.columnValues).toEqual([10, 20, 30, 40, 50]);
    expect(test.rowValues).toEqual([10, 20, 30, 40, 50]);
    test.cells.forEach((cell, index) => {
      const speed = test.columnValues[index % 5];
      const power = test.rowValues[Math.floor(index / 5)];
      expect(cell.settings).toEqual({ speedMmS: speed, maxPowerPct: power, minPowerPct: power, passes: 1 });
    });
  });

  it('puts either setting on either axis', () => {
    const test = build({
      columns: { parameter: 'passes', from: 1, to: 4, steps: 4 },
      rows: { parameter: 'speed', from: 100, to: 20, steps: 5 },
      maxPowerPct: 45,
    });
    expect(test.cells).toHaveLength(20);
    expect(test.cells[0]?.settings).toEqual({ speedMmS: 100, maxPowerPct: 45, minPowerPct: 45, passes: 1 });
    expect(test.cells[3]?.settings).toEqual({ speedMmS: 100, maxPowerPct: 45, minPowerPct: 45, passes: 4 });
    expect(test.cells[19]?.settings).toEqual({ speedMmS: 20, maxPowerPct: 45, minPowerPct: 45, passes: 4 });
  });

  it('uses a fixed min power, lowered to the max power of a cell where needed', () => {
    const test = build({ minPowerPct: 25 });
    expect(test.cells.map((cell) => cell.settings?.minPowerPct).filter((_, index) => index % 5 === 0)).toEqual([10, 20, 25, 25, 25]);
    for (const cell of test.cells) {
      expect(cell.settings?.minPowerPct).toBeLessThanOrEqual(cell.settings?.maxPowerPct ?? -1);
    }
  });

  it('returns no test when both axes vary the same setting', () => {
    const options = { ...DEFAULTS, rows: defaultAxis('speed') };
    expect(axesConflict(options)).toBe(true);
    expect(axesConflict(DEFAULTS)).toBe(false);
    expect(buildMaterialTest(options, { origin: { x: 0, y: 0 }, nextShapeId: () => 'x', groupId: 'g' })).toBeNull();
  });

  it('puts labels and cells in one group, with unique ids, labels first', () => {
    const test = build();
    expect(new Set(test.shapes.map((shape) => shape.id)).size).toBe(test.shapes.length);
    for (const shape of test.shapes) expect(shape.groups).toEqual(['g1']);
    const first = test.shapes[0];
    expect(unitOf(test.shapes, first?.id ?? '', [])).toHaveLength(test.shapes.length);
    const labelShapes = test.shapes.filter((shape) => shape.color === MATERIAL_TEST_LABEL_COLOR);
    expect(test.shapes).toEqual([...labelShapes, ...test.cells]);
    expect(labelShapes.length).toBeGreaterThan(0);
    for (const shape of labelShapes) {
      expect(shape.closed).toBe(false);
      expect(shape.settings).toBeUndefined();
    }
  });

  it('places the top-left corner of everything exactly at the origin and reports the size', () => {
    for (const origin of [{ x: 10, y: 10 }, { x: 250.5, y: 99 }]) {
      const test = build({}, origin);
      const bounds = boundsOfShapes(test.shapes);
      expect(bounds?.minX).toBeCloseTo(origin.x, 9);
      expect(bounds?.minY).toBeCloseTo(origin.y, 9);
      expect(test.bounds.minX).toBeCloseTo(bounds?.minX ?? NaN, 9);
      expect(test.bounds.maxX).toBeCloseTo(bounds?.maxX ?? NaN, 9);
      expect(test.bounds.maxY).toBeCloseTo(bounds?.maxY ?? NaN, 9);
      expect(test.widthMm).toBeCloseTo((bounds?.maxX ?? 0) - origin.x, 9);
      expect(test.heightMm).toBeCloseTo((bounds?.maxY ?? 0) - origin.y, 9);
    }
    // Moving the origin moves everything and changes nothing else.
    const a = build({}, { x: 0, y: 0 });
    const b = build({}, { x: 40, y: 7 });
    expect(b.widthMm).toBeCloseTo(a.widthMm, 9);
    expect(b.shapes[5]?.points[0]?.x).toBeCloseTo((a.shapes[5]?.points[0]?.x ?? 0) + 40, 9);
  });

  it('labels every column, every row and the fixed values', () => {
    const test = build();
    const texts = (kind: string) => test.labels.filter((label) => label.kind === kind).map((label) => label.text);
    expect(texts('column')).toEqual(['10', '20', '30', '40', '50']);
    expect(texts('row')).toEqual(['10', '20', '30', '40', '50']);
    expect(texts('title').join('  ')).toBe('SPEED MM/S ACROSS  POWER % DOWN  PASSES 1');

    const other = build({
      columns: { parameter: 'passes', from: 1, to: 4, steps: 4 },
      rows: { parameter: 'power', from: 12.5, to: 50, steps: 4 },
      speedMmS: 35,
      minPowerPct: 8,
    });
    const title = other.labels.filter((label) => label.kind === 'title').map((label) => label.text).join('  ');
    expect(title).toBe('PASSES ACROSS  POWER % DOWN  SPEED 35 MM/S  MIN POWER 8 %');
    expect(other.labels.filter((label) => label.kind === 'row').map((label) => label.text)).toEqual(['12.5', '25', '37.5', '50']);
  });

  it('sets column labels above their column and row labels left of their row', () => {
    const test = build();
    const columns = test.labels.filter((label) => label.kind === 'column');
    const rows = test.labels.filter((label) => label.kind === 'row');
    const grid = boundsOfShapes(test.cells);
    if (!grid) throw new Error('no cells');
    columns.forEach((label, index) => {
      const cell = boundsOfPoints(test.cells[index]?.points ?? []);
      // Centred on the column, give or take the blank part of a glyph box (a 1 is narrower than its box).
      const offCentre = (label.bounds.minX + label.bounds.maxX) / 2 - ((cell?.minX ?? 0) + (cell?.maxX ?? 0)) / 2;
      expect(Math.abs(offCentre)).toBeLessThan(0.5);
      expect(label.bounds.maxY).toBeLessThan(grid.minY);
    });
    rows.forEach((label, index) => {
      const cell = boundsOfPoints(test.cells[index * 5]?.points ?? []);
      expect((label.bounds.minY + label.bounds.maxY) / 2).toBeCloseTo(((cell?.minY ?? 0) + (cell?.maxY ?? 0)) / 2, 9);
      expect(label.bounds.maxX).toBeLessThan(grid.minX);
    });
    for (const label of test.labels.filter((each) => each.kind === 'title')) {
      expect(label.bounds.maxY).toBeLessThan(Math.min(...columns.map((column) => column.bounds.minY)));
    }
  });

  it('carries the label settings for the label layer', () => {
    expect(build({ labelSpeedMmS: 150, labelPowerPct: 9 }).layers).toEqual([
      { color: MATERIAL_TEST_LABEL_COLOR, patch: { speedMmS: 150, maxPowerPct: 9, minPowerPct: 9, passes: 1 } },
    ]);
  });

  it('keeps labels clear of the cells and of each other for every allowed size', () => {
    const ranges: Record<TestParameter, readonly (readonly [number, number])[]> = {
      speed: [
        [10, 50],
        [100, 999],
        [0.1, 2000],
        [1666.6, 1777.7],
      ],
      power: [
        [10, 50],
        [100, 12.5],
        [33.3, 66.6],
      ],
      passes: [
        [1, 5],
        [100, 91],
      ],
    };
    const parameters: TestParameter[] = ['speed', 'power', 'passes'];
    let checked = 0;
    const problems: string[] = [];
    for (const columnParameter of parameters) {
      for (const rowParameter of parameters) {
        if (columnParameter === rowParameter) continue;
        for (const [columnFrom, columnTo] of ranges[columnParameter]) {
          for (const [rowFrom, rowTo] of ranges[rowParameter]) {
            for (const steps of [4, 10]) {
              for (const cellSizeMm of [3, 10, 50]) {
                for (const gapMm of [0, 3, 20]) {
                  for (const minPowerPct of [null, 12.5]) {
                    const options: Partial<MaterialTestOptions> = {
                      columns: { parameter: columnParameter, from: columnFrom, to: columnTo, steps },
                      rows: { parameter: rowParameter, from: rowFrom, to: rowTo, steps: 14 - steps },
                      cellSizeMm,
                      gapMm,
                      minPowerPct,
                      speedMmS: 1234.5,
                      maxPowerPct: 100,
                      passes: 100,
                    };
                    const test = build(options);
                    const where = JSON.stringify(options);
                    const fail = (what: string) => problems.push(`${what}: ${where}`);
                    const cells = test.cells.map((cell) => boundsOfPoints(cell.points));
                    const titles = test.labels.filter((label) => label.kind === 'title').length;
                    if (titles < 1 || test.labels.length !== 14 + titles) fail('label count');
                    test.labels.forEach((label, index) => {
                      const b = label.bounds;
                      if (!(b.maxX - b.minX > 0) || !(b.maxY - b.minY > 0)) fail(`empty label ${label.text}`);
                      if (!inside(b, test.bounds)) fail(`label ${label.text} outside the overall box`);
                      if (cells.some((cell) => cell === null || overlap(b, cell))) fail(`label ${label.text} on a cell`);
                      for (let other = index + 1; other < test.labels.length; other++) {
                        const second = test.labels[other];
                        if (!second || overlap(b, second.bounds)) fail(`labels ${label.text} and ${second?.text} overlap`);
                      }
                    });
                    // Neighbouring column labels are a character apart, so two numbers never read as one.
                    const columnLabels = test.labels.filter((label) => label.kind === 'column');
                    for (let i = 1; i < columnLabels.length; i++) {
                      const left = columnLabels[i - 1]?.bounds;
                      const right = columnLabels[i]?.bounds;
                      if (!left || !right) continue;
                      const character = Math.min(left.maxY - left.minY, right.maxX - right.minX, left.maxX - left.minX);
                      if (right.minX - left.maxX < character * 0.99) fail(`column labels ${i} too close`);
                    }
                    // Every stroke of a label lies inside one of the label boxes, and is finite.
                    for (const shape of test.shapes) {
                      if (shape.color !== MATERIAL_TEST_LABEL_COLOR) continue;
                      const b = boundsOfPoints(shape.points);
                      if (b === null || !test.labels.some((label) => inside(b, label.bounds))) fail('stray stroke');
                      if (!shape.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) fail('non-finite stroke');
                    }
                    checked += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(500);
  });

  it('keeps labels readable: never smaller than 1.2 mm, upright columns when they do not fit flat', () => {
    // 10 × 10 with 3 mm cells and three-digit values.
    const tight = build({
      columns: { parameter: 'speed', from: 100, to: 999, steps: 10 },
      rows: { parameter: 'power', from: 100, to: 10, steps: 10 },
      cellSizeMm: 3,
      gapMm: 0,
    });
    expect(tight.cells).toHaveLength(100);
    for (const label of tight.labels) {
      const size = Math.min(label.bounds.maxX - label.bounds.minX, label.bounds.maxY - label.bounds.minY);
      expect(size).toBeGreaterThanOrEqual(1.2);
    }
    // Three digits do not fit a 3 mm column lying flat, so they stand upright: taller than wide.
    for (const label of tight.labels.filter((each) => each.kind === 'column')) {
      expect(label.bounds.maxY - label.bounds.minY).toBeGreaterThan(label.bounds.maxX - label.bounds.minX);
    }
    // With room they lie flat.
    for (const label of build().labels.filter((each) => each.kind === 'column')) {
      expect(label.bounds.maxX - label.bounds.minX).toBeGreaterThan(label.bounds.maxY - label.bounds.minY);
    }
  });

  it('turns upright labels a quarter turn without mirroring them', () => {
    const tight = build({
      columns: { parameter: 'speed', from: 111, to: 999, steps: 4 },
      cellSizeMm: 3,
      gapMm: 0,
    });
    const label = tight.labels.find((each) => each.kind === 'column');
    if (!label) throw new Error('no column label');
    // "111": the first stroke of a 1 is its flag and stem. Reading upward, the
    // stem runs from the top of the glyph (left on the page) to its baseline
    // (right on the page), and the next digit sits further UP the page.
    const strokes = tight.shapes.filter((shape) => {
      const b = boundsOfPoints(shape.points);
      return b !== null && b.minX >= label.bounds.minX - 1e-9 && b.maxX <= label.bounds.maxX + 1e-9 && b.maxY <= label.bounds.maxY + 1e-9 && b.minY >= label.bounds.minY - 1e-9;
    });
    expect(strokes).toHaveLength(6);
    const stem = strokes[0]?.points ?? [];
    const last = stem[stem.length - 1];
    const before = stem[stem.length - 2];
    expect(last?.x).toBeGreaterThan(before?.x ?? Infinity);
    expect(last?.y).toBeCloseTo(before?.y ?? NaN, 9);
    const secondStem = strokes[2]?.points ?? [];
    expect(secondStem[1]?.y).toBeLessThan(before?.y ?? -Infinity);
  });

  it('leaves the labels out when they are switched off', () => {
    const test = build({ labels: false });
    expect(test.labels).toEqual([]);
    expect(test.shapes.every((shape) => shape.color === MATERIAL_TEST_CELL_COLOR)).toBe(true);
  });
});
