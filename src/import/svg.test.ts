import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ColoredPolyline, Point } from '../model/types';
import { importSvg } from './svg';

const MM_PER_PX = 25.4 / 96;

/** Wraps a body in an svg whose user units are exactly 1 mm. */
function mm(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`;
}

function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8');
}

function extent(path: ColoredPolyline): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = path.points.map((p) => p.x);
  const ys = path.points.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function only(text: string): ColoredPolyline {
  const { paths } = importSvg(text);
  expect(paths).toHaveLength(1);
  const path = paths[0];
  if (path === undefined) throw new Error('expected one path');
  return path;
}

function at(path: ColoredPolyline, index: number): Point {
  const p = path.points.at(index);
  if (p === undefined) throw new Error(`no point ${index}`);
  return p;
}

function expectPoints(path: ColoredPolyline, expected: readonly (readonly [number, number])[]): void {
  expect(path.points).toHaveLength(expected.length);
  expected.forEach(([x, y], i) => {
    expect(at(path, i).x).toBeCloseTo(x, 9);
    expect(at(path, i).y).toBeCloseTo(y, 9);
  });
}

function pathOf(d: string): ColoredPolyline {
  return only(mm(`<path d="${d}"/>`));
}

describe('importSvg path data', () => {
  it('handles M L H V Z in absolute and relative form', () => {
    const path = pathOf('M10 10 L20 10 H30 V20 l5 5 h-5 v-2 z');
    expect(path.closed).toBe(true);
    expectPoints(path, [
      [10, 10],
      [20, 10],
      [30, 10],
      [30, 20],
      [35, 25],
      [30, 25],
      [30, 23],
    ]);
  });

  it('repeats commands implicitly, with moveto continuing as lineto', () => {
    expectPoints(pathOf('M0 0 10 0 10 10'), [
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expectPoints(pathOf('m5 5 5 0 0 5'), [
      [5, 5],
      [10, 5],
      [10, 10],
    ]);
    expectPoints(pathOf('M0 0h5 5v3 3'), [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 3],
      [10, 6],
    ]);
  });

  it('parses compact number syntax and exponents', () => {
    expectPoints(pathOf('M1.5.5-1-2'), [
      [1.5, 0.5],
      [-1, -2],
    ]);
    expectPoints(pathOf('M0,0L1e1,2.5e-1 -.5+3'), [
      [0, 0],
      [10, 0.25],
      [-0.5, 3],
    ]);
  });

  it('flattens absolute and relative cubics', () => {
    for (const d of ['M10 10 C10 20 20 20 20 10', 'M10 10 c0 10 10 10 10 0']) {
      const path = pathOf(d);
      expect(path.closed).toBe(false);
      expect(at(path, 0)).toEqual({ x: 10, y: 10 });
      expect(at(path, -1)).toEqual({ x: 20, y: 10 });
      expect(path.points.length).toBeGreaterThan(8);
      const box = extent(path);
      // The curve peaks at t = 0.5: y = 10 + 0.75 * 10.
      expect(box.maxY).toBeGreaterThan(17.5 - 0.03);
      expect(box.maxY).toBeLessThanOrEqual(17.5 + 1e-9);
      expect(box.minX).toBeCloseTo(10, 9);
      expect(box.maxX).toBeCloseTo(20, 9);
    }
  });

  it('reflects the previous control point for S and s', () => {
    for (const d of ['M0 10 C0 20 10 20 10 10 S20 0 20 10', 'M0 10 c0 10 10 10 10 0 s10 -10 10 0']) {
      const path = pathOf(d);
      expect(at(path, -1)).toEqual({ x: 20, y: 10 });
      const box = extent(path);
      // With the reflected control point (10, 0) the second half dips to y = 2.5;
      // without reflection it would only reach about 5.56.
      expect(box.minY).toBeGreaterThanOrEqual(2.5 - 1e-9);
      expect(box.minY).toBeLessThan(2.5 + 0.03);
      expect(box.maxY).toBeGreaterThan(17.5 - 0.03);
    }
  });

  it('treats S without a preceding cubic as starting at the current point', () => {
    const box = extent(pathOf('M10 10 S20 0 20 10'));
    // Control points (10,10), (20,0): the lowest y is 10 - 40/9.
    expect(box.minY).toBeGreaterThanOrEqual(10 - 40 / 9 - 1e-9);
    expect(box.minY).toBeLessThan(10 - 40 / 9 + 0.03);
  });

  it('flattens Q/q and reflects the control point for T/t', () => {
    for (const d of ['M0 10 Q5 20 10 10 T20 10', 'M0 10 q5 10 10 0 t10 0']) {
      const path = pathOf(d);
      expect(at(path, 0)).toEqual({ x: 0, y: 10 });
      expect(at(path, -1)).toEqual({ x: 20, y: 10 });
      const box = extent(path);
      expect(box.maxY).toBeGreaterThan(15 - 0.03);
      expect(box.maxY).toBeLessThanOrEqual(15 + 1e-9);
      // Reflected control point (15, 0) gives a dip to y = 5.
      expect(box.minY).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(box.minY).toBeLessThan(5 + 0.03);
    }
  });

  it('flattens arcs in both sweep directions', () => {
    const over = pathOf('M10 10 A5 5 0 0 1 20 10');
    expect(at(over, 0)).toEqual({ x: 10, y: 10 });
    expect(at(over, -1)).toEqual({ x: 20, y: 10 });
    expect(extent(over).minY).toBeCloseTo(5, 1);
    expect(extent(over).maxY).toBeCloseTo(10, 9);
    for (const p of over.points) expect(Math.hypot(p.x - 15, p.y - 10)).toBeCloseTo(5, 6);

    const under = pathOf('M10 10 a5 5 0 0 0 10 0');
    expect(extent(under).maxY).toBeCloseTo(15, 1);
    expect(extent(under).minY).toBeCloseTo(10, 9);
  });

  it('reads arc flags written without separators', () => {
    const small = pathOf('M10 10a5 5 0 0110 0');
    expect(at(small, -1)).toEqual({ x: 20, y: 10 });
    expect(extent(small).minY).toBeCloseTo(5, 1);

    const flipped = pathOf('M10 10a5 5 0 1010 0');
    expect(at(flipped, -1)).toEqual({ x: 20, y: 10 });
    expect(extent(flipped).maxY).toBeCloseTo(15, 1);

    // The example from the SVG spec errata: flags "01", then the end point 2,2.
    const spec = pathOf('M0 0a1 1 0 01 2 2');
    expect(at(spec, -1)).toEqual({ x: 2, y: 2 });
    expect(spec.points.length).toBeGreaterThan(4);

    // large-arc = 1 takes the long way round a radius-5 circle through (10,10) and (15,15).
    const large = pathOf('M10 10A5 5 0 1115 15');
    const box = extent(large);
    expect(box.maxX - box.minX).toBeCloseTo(10, 1);
  });

  it('splits subpaths and restarts from the subpath start after Z', () => {
    const { paths } = importSvg(mm('<path d="M0 0 L10 0 L10 10 Z l-5 0 M20 20 L30 20"/>'));
    expect(paths).toHaveLength(3);
    expect(paths.map((p) => p.closed)).toEqual([true, false, false]);
    expectPoints(paths[1] as ColoredPolyline, [
      [0, 0],
      [-5, 0],
    ]);
    expectPoints(paths[2] as ColoredPolyline, [
      [20, 20],
      [30, 20],
    ]);
  });

  it('keeps what parsed before malformed path data and warns', () => {
    const result = importSvg(mm('<path d="M0 0 L10 0 L10 10 X 5 5 L 50 50"/><path d="M0 20 L10 20 L"/><line x1="0" y1="30" x2="5" y2="30"/>'));
    expect(result.paths).toHaveLength(3);
    expectPoints(result.paths[0] as ColoredPolyline, [
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expectPoints(result.paths[1] as ColoredPolyline, [
      [0, 20],
      [10, 20],
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^2 paths have invalid path data/);
  });

  it('ignores a path that does not start with a moveto', () => {
    const result = importSvg(mm('<path d="L10 10 20 20"/><path d=""/><path/>'));
    expect(result.paths).toEqual([]);
    expect(result.warnings[0]).toMatch(/^1 path has invalid path data/);
  });
});

describe('importSvg basic shapes', () => {
  it('imports a plain rect as a closed four-point path', () => {
    const path = only(mm('<rect x="10" y="20" width="30" height="10"/>'));
    expect(path.closed).toBe(true);
    expectPoints(path, [
      [10, 20],
      [40, 20],
      [40, 30],
      [10, 30],
    ]);
  });

  it('rounds rect corners with rx/ry', () => {
    const path = only(mm('<rect x="10" y="20" width="30" height="10" rx="2"/>'));
    expect(path.closed).toBe(true);
    expect(path.points.length).toBeGreaterThan(16);
    expect(extent(path)).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 30 });
    // Every corner is cut: nothing closer to a sharp corner than r * (sqrt(2) - 1).
    for (const [cx, cy] of [
      [10, 20],
      [40, 20],
      [40, 30],
      [10, 30],
    ] as const) {
      for (const p of path.points) expect(Math.hypot(p.x - cx, p.y - cy)).toBeGreaterThan(0.8);
    }
    // Points on the top-left corner lie on a circle of radius 2 around (12, 22).
    const corner = path.points.filter((p) => p.x < 12 && p.y < 22);
    expect(corner.length).toBeGreaterThan(2);
    for (const p of corner) expect(Math.hypot(p.x - 12, p.y - 22)).toBeCloseTo(2, 6);
  });

  it('supports elliptical corners and clamps oversized radii', () => {
    const oval = only(mm('<rect width="30" height="10" rx="5" ry="2"/>'));
    expect(extent(oval)).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 10 });
    expect(oval.points.some((p) => Math.abs(p.x - 5) < 1e-9 && p.y === 0)).toBe(true);
    expect(oval.points.some((p) => p.x === 0 && Math.abs(p.y - 2) < 1e-9)).toBe(true);

    // rx = ry = 50 clamps to 15 x 5, which makes the rect an ellipse.
    const pill = only(mm('<rect width="30" height="10" ry="50"/>'));
    expect(extent(pill)).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 10 });
    for (const p of pill.points) {
      expect(((p.x - 15) / 15) ** 2 + ((p.y - 5) / 5) ** 2).toBeCloseTo(1, 6);
    }
  });

  it('skips rects without a positive size', () => {
    expect(importSvg(mm('<rect width="0" height="10"/><rect width="10"/><rect width="-5" height="5"/>')).paths).toEqual(
      [],
    );
  });

  it('imports a circle as a closed ring within tolerance', () => {
    const path = only(mm('<circle cx="50" cy="40" r="10"/>'));
    expect(path.closed).toBe(true);
    const box = extent(path);
    expect(box.minX).toBeCloseTo(40, 1);
    expect(box.maxX).toBeCloseTo(60, 1);
    expect(box.minY).toBeCloseTo(30, 1);
    expect(box.maxY).toBeCloseTo(50, 1);
    for (const p of path.points) expect(Math.hypot(p.x - 50, p.y - 40)).toBeCloseTo(10, 9);
    expect(at(path, 0)).not.toEqual(at(path, -1));
  });

  it('imports an ellipse as a closed ring', () => {
    const path = only(mm('<ellipse cx="50" cy="40" rx="20" ry="5"/>'));
    expect(path.closed).toBe(true);
    const box = extent(path);
    expect(box.minX).toBeCloseTo(30, 1);
    expect(box.maxX).toBeCloseTo(70, 1);
    expect(box.minY).toBeCloseTo(35, 1);
    expect(box.maxY).toBeCloseTo(45, 1);
    for (const p of path.points) {
      expect(((p.x - 50) / 20) ** 2 + ((p.y - 40) / 5) ** 2).toBeCloseTo(1, 9);
    }
    const first = at(path, 0);
    const last = at(path, -1);
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(0.1);
  });

  it('imports line, polyline and polygon', () => {
    const { paths } = importSvg(
      mm(
        '<line x1="1" y1="2" x2="3" y2="4" stroke="red"/>' +
          '<polyline points="10,10 20,10 20,20" stroke="green"/>' +
          '<polygon points="30 30, 40 30 40,40" stroke="blue"/>',
      ),
    );
    expect(paths).toHaveLength(3);
    const [line, polyline, polygon] = paths as [ColoredPolyline, ColoredPolyline, ColoredPolyline];
    expect(line.closed).toBe(false);
    expectPoints(line, [
      [1, 2],
      [3, 4],
    ]);
    expect(polyline.closed).toBe(false);
    expectPoints(polyline, [
      [10, 10],
      [20, 10],
      [20, 20],
    ]);
    expect(polygon.closed).toBe(true);
    expectPoints(polygon, [
      [30, 30],
      [40, 30],
      [40, 40],
    ]);
  });

  it('drops a dangling coordinate in a points list', () => {
    expectPoints(only(mm('<polyline points="0,0 10,0 10"/>')), [
      [0, 0],
      [10, 0],
    ]);
  });
});

describe('importSvg transforms', () => {
  it('composes nested group transforms', () => {
    const path = only(
      mm('<g transform="translate(10,20)"><g transform="scale(2)"><line x1="1" y1="1" x2="2" y2="1"/></g></g>'),
    );
    expectPoints(path, [
      [12, 22],
      [14, 22],
    ]);
  });

  it('applies a chained list right to left', () => {
    expectPoints(only(mm('<line x1="1" y1="0" x2="2" y2="0" transform="translate(10,0) rotate(90)"/>')), [
      [10, 1],
      [10, 2],
    ]);
    expectPoints(only(mm('<line x1="1" y1="0" x2="2" y2="0" transform="rotate(90),translate(10 0)"/>')), [
      [0, 11],
      [0, 12],
    ]);
  });

  it('rotates about a centre', () => {
    expectPoints(only(mm('<g transform="rotate(90, 10, 10)"><line x1="20" y1="10" x2="30" y2="10"/></g>')), [
      [10, 20],
      [10, 30],
    ]);
  });

  it('applies matrix, non-uniform scale and skews', () => {
    expectPoints(only(mm('<line x1="1" y1="0" x2="0" y2="1" transform="matrix(0 1 -1 0 5 5)"/>')), [
      [5, 6],
      [4, 5],
    ]);
    expectPoints(only(mm('<line x1="1" y1="1" x2="2" y2="2" transform="scale(2, 3)"/>')), [
      [2, 3],
      [4, 6],
    ]);
    expectPoints(only(mm('<line x1="0" y1="10" x2="5" y2="10" transform="skewX(45)"/>')), [
      [10, 10],
      [15, 10],
    ]);
    expectPoints(only(mm('<line x1="10" y1="0" x2="10" y2="5" transform="skewY(45)"/>')), [
      [10, 10],
      [10, 15],
    ]);
  });

  it('applies a transform on the shape inside a transformed group', () => {
    const path = only(
      mm('<g transform="translate(50,50)"><rect width="10" height="4" transform="rotate(90)"/></g>'),
    );
    const box = extent(path);
    expect(box.minX).toBeCloseTo(46, 9);
    expect(box.maxX).toBeCloseTo(50, 9);
    expect(box.minY).toBeCloseTo(50, 9);
    expect(box.maxY).toBeCloseTo(60, 9);
  });

  it('tightens the flatten tolerance by the accumulated scale', () => {
    const path = only(mm('<g transform="scale(10)"><g transform="scale(5)"><circle cx="1" cy="1" r="1"/></g></g>'));
    // Final radius 50 mm: the sagitta of every chord must stay within 0.02 mm.
    path.points.forEach((p, i) => {
      const q = at(path, (i + 1) % path.points.length);
      const sagitta = 50 - Math.hypot((p.x + q.x) / 2 - 50, (p.y + q.y) / 2 - 50);
      expect(sagitta).toBeLessThanOrEqual(0.02 + 1e-9);
    });
    const coarse = importSvg(mm('<circle cx="50" cy="50" r="50"/>'), { flattenToleranceMm: 1 }).paths[0];
    expect(coarse?.points.length).toBeLessThan(path.points.length / 3);
  });

  it('ignores a malformed transform and warns', () => {
    const result = importSvg(mm('<line x1="1" y1="1" x2="2" y2="1" transform="translate(10) bogus(1)"/>'));
    expectPoints(result.paths[0] as ColoredPolyline, [
      [1, 1],
      [2, 1],
    ]);
    expect(result.warnings).toEqual(['Ignored 1 invalid transform']);
  });
});

describe('importSvg use and symbol', () => {
  it('instantiates symbols and plain elements from the fixture', () => {
    const { paths, warnings } = importSvg(fixture('use-symbols.svg'));
    expect(warnings).toEqual([]);
    // Nothing from defs, the unused symbol or the clipPath is drawn directly.
    expect(paths).toHaveLength(3);
    const [tile, slot, scaled] = paths as [ColoredPolyline, ColoredPolyline, ColoredPolyline];
    expect(tile.color).toBe('#ff0000');
    expect(tile.closed).toBe(true);
    expect(extent(tile)).toEqual({ minX: 20, minY: 20, maxX: 40, maxY: 40 });
    expect(slot.color).toBe('#0000ff');
    expect(extent(slot)).toEqual({ minX: 50, minY: 0, maxX: 55, maxY: 2 });
    expect(extent(scaled)).toEqual({ minX: 50, minY: 10, maxX: 60, maxY: 14 });
  });

  it('lets referenced content inherit colour from the use element', () => {
    const path = only(mm('<defs><line id="l" x2="5"/></defs><g stroke="#00f"><use href="#l" y="3"/></g>'));
    expect(path.color).toBe('#0000ff');
    expectPoints(path, [
      [0, 3],
      [5, 3],
    ]);
  });

  it('survives circular and missing references', () => {
    const result = importSvg(
      mm(
        '<g id="a"><line x2="5"/><use href="#b"/></g>' +
          '<g id="b"><use href="#a" y="10"/></g>' +
          '<use href="#nope"/><use href="other.svg#x"/>',
      ),
    );
    // #a is drawn directly and once more through #b; each chain stops at the cycle.
    expect(result.paths.length).toBeGreaterThanOrEqual(2);
    expect(result.paths.length).toBeLessThanOrEqual(4);
    expect(result.warnings).toContain('Skipped 2 use with a missing or external reference');
    expect(result.warnings.some((w) => /circular reference/.test(w))).toBe(true);
  });

  it('stops a self-referencing use', () => {
    const result = importSvg(mm('<use id="u" href="#u"/><line x2="5"/>'));
    expect(result.paths).toHaveLength(1);
    expect(result.warnings).toEqual(['Skipped 1 use with a circular reference']);
  });

  it('places nested svg elements with their own viewBox', () => {
    const path = only(
      mm('<svg x="10" y="20" width="20" height="20" viewBox="0 0 2 2"><line x1="0" y1="1" x2="2" y2="1"/></svg>'),
    );
    expectPoints(path, [
      [10, 30],
      [30, 30],
    ]);
  });
});

describe('importSvg units', () => {
  const line = '<line x1="0" y1="0" x2="200" y2="100"/>';

  it('scales viewBox units to the physical size', () => {
    const path = only(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 200 200">${line}</svg>`);
    expectPoints(path, [
      [0, 0],
      [100, 50],
    ]);
  });

  it('treats user units as 96 dpi px without a viewBox', () => {
    expectPoints(only('<svg xmlns="http://www.w3.org/2000/svg"><line x1="96" y1="0" x2="192" y2="48"/></svg>'), [
      [25.4, 0],
      [50.8, 12.7],
    ]);
    const sized = only('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><line x2="96"/></svg>');
    expect(at(sized, 1).x).toBeCloseTo(96 * MM_PER_PX, 9);
  });

  it('handles inches, cm, pt, pc and px sizes', () => {
    const cases: readonly (readonly [string, string, number])[] = [
      ['2in', '1in', 50.8],
      ['5cm', '2.5cm', 50],
      ['144pt', '72pt', 50.8],
      ['12pc', '6pc', 50.8],
      ['192px', '96px', 50.8],
      ['192', '96', 50.8],
    ];
    for (const [width, height, expected] of cases) {
      const path = only(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 200 100">${line}</svg>`);
      expect(at(path, 1).x).toBeCloseTo(expected, 9);
      expect(at(path, 1).y).toBeCloseTo(expected / 2, 9);
    }
  });

  it('subtracts the viewBox origin', () => {
    const path = only('<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="10 20 100 100"><line x1="10" y1="20" x2="110" y2="120"/></svg>');
    expectPoints(path, [
      [0, 0],
      [50, 50],
    ]);
  });

  it('treats viewBox units as px when width/height are missing or percentages', () => {
    for (const size of ['', 'width="100%" height="100%"']) {
      const path = only(`<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 96 96"><line x2="96" y2="48"/></svg>`);
      expectPoints(path, [
        [0, 0],
        [25.4, 12.7],
      ]);
    }
  });

  it('derives a missing height from the viewBox aspect ratio', () => {
    const path = only('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 200 400"><line x2="200" y2="400"/></svg>');
    expectPoints(path, [
      [0, 0],
      [100, 200],
    ]);
  });

  it('uses a uniform scale when the aspect ratios differ', () => {
    const path = only('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 100"><line x2="100" y2="100"/></svg>');
    const [a, b] = [at(path, 0), at(path, 1)];
    expect(b.x - a.x).toBeCloseTo(50, 9);
    expect(b.y - a.y).toBeCloseTo(50, 9);
  });

  it('accepts units on shape lengths', () => {
    const noViewBox = only('<svg xmlns="http://www.w3.org/2000/svg"><rect x="1in" y="5mm" width="10mm" height="1cm"/></svg>');
    const box = extent(noViewBox);
    expect(box.minX).toBeCloseTo(25.4, 9);
    expect(box.minY).toBeCloseTo(5, 9);
    expect(box.maxX - box.minX).toBeCloseTo(10, 9);
    expect(box.maxY - box.minY).toBeCloseTo(10, 9);

    const circle = only('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="20mm" cy="20mm" r="5mm"/></svg>');
    expect(extent(circle).maxX).toBeCloseTo(25, 9);
  });

  it('resolves percentages against the viewport', () => {
    const path = only(mm('<rect x="10%" y="50%" width="50%" height="25%"/>'));
    expect(extent(path)).toEqual({ minX: 10, minY: 50, maxX: 60, maxY: 75 });
  });
});

describe('importSvg colours', () => {
  const shape = (attrs: string): string => `<line x2="5" ${attrs}/>`;
  const colorOf = (body: string): string => only(mm(body)).color;

  it('reads stroke from a presentation attribute in every supported notation', () => {
    expect(colorOf(shape('stroke="#f00"'))).toBe('#ff0000');
    expect(colorOf(shape('stroke="#00FF7f"'))).toBe('#00ff7f');
    expect(colorOf(shape('stroke="rgb(0, 128, 255)"'))).toBe('#0080ff');
    expect(colorOf(shape('stroke="rgb(100%, 0%, 50%)"'))).toBe('#ff0080');
    expect(colorOf(shape('stroke="rgba(0,0,255,0.5)"'))).toBe('#0000ff');
    expect(colorOf(shape('stroke="Blue"'))).toBe('#0000ff');
    expect(colorOf(shape('stroke="orange"'))).toBe('#ffa500');
    expect(colorOf(shape('stroke="cyan"'))).toBe('#00ffff');
    expect(colorOf(shape('stroke="magenta"'))).toBe('#ff00ff');
    expect(colorOf(shape('stroke="green"'))).toBe('#008000');
    expect(colorOf(shape('stroke="lime"'))).toBe('#00ff00');
  });

  it('reads stroke from an inline style, which beats the attribute', () => {
    expect(colorOf(shape('style="fill:none; stroke: #00ff00 ;stroke-width:1"'))).toBe('#00ff00');
    expect(colorOf(shape('stroke="#ff0000" style="stroke:#0000ff"'))).toBe('#0000ff');
  });

  it('inherits colour from ancestor groups', () => {
    expect(colorOf(`<g stroke="#0000ff"><g>${shape('')}</g></g>`)).toBe('#0000ff');
    expect(colorOf(`<g style="stroke:red"><g stroke="lime">${shape('')}</g></g>`)).toBe('#00ff00');
    expect(colorOf(`<g fill="#123456">${shape('')}</g>`)).toBe('#123456');
    expect(colorOf(`<g stroke="#0000ff">${shape('stroke="inherit"')}</g>`)).toBe('#0000ff');
  });

  it('resolves classes, element selectors and selector lists from style blocks', () => {
    const css = '<style>/* laser */ .cls-1{fill:none;stroke:#f00} .cls-2, .cls-3 { stroke: #00f; } polyline{stroke:#0f0}</style>';
    const colors = (body: string): string[] => importSvg(mm(css + body)).paths.map((p) => p.color);
    expect(colors('<line class="cls-1" x2="5"/>')).toEqual(['#ff0000']);
    expect(colors('<line class="other cls-3" x2="5"/>')).toEqual(['#0000ff']);
    expect(colors('<line class="cls-2" x2="5"/>')).toEqual(['#0000ff']);
    expect(colors('<polyline points="0,2 5,2"/>')).toEqual(['#00ff00']);
    // A class rule is more specific than an element rule, whatever the order.
    expect(colors('<polyline class="cls-2" points="0,3 5,3"/>')).toEqual(['#0000ff']);
    expect(colors('<line x2="5"/>')).toEqual(['#000000']);
    // Paths come out grouped by colour, in order of first appearance.
    expect(
      colors('<line class="cls-1" x2="5"/><polyline points="0,2 5,2"/><line class="cls-1" y1="4" x2="5" y2="4"/>'),
    ).toEqual(['#ff0000', '#ff0000', '#00ff00']);
  });

  it('reads CDATA style blocks placed inside defs, with class on a group', () => {
    const body =
      '<defs><style type="text/css"><![CDATA[ .cut { stroke: #ff0000; fill: none } #mark { stroke: #0000ff } ]]></style></defs>' +
      '<g class="cut"><line x2="5"/><line id="mark" y1="2" x2="5" y2="2"/></g>';
    expect(importSvg(mm(body)).paths.map((p) => p.color)).toEqual(['#ff0000', '#0000ff']);
  });

  it('lets a style rule override a presentation attribute', () => {
    expect(colorOf(`<style>.a{stroke:#00f}</style>${shape('class="a" stroke="#f00"')}`)).toBe('#0000ff');
  });

  it('uses the fill colour when there is no stroke', () => {
    expect(colorOf('<rect width="5" height="5" fill="#ffa500"/>')).toBe('#ffa500');
    expect(colorOf('<rect width="5" height="5" fill="#00f" stroke="none"/>')).toBe('#0000ff');
    expect(colorOf('<rect width="5" height="5" style="fill:rgb(255,0,0);stroke:none"/>')).toBe('#ff0000');
  });

  it('prefers stroke over fill', () => {
    expect(colorOf('<rect width="5" height="5" fill="#00f" stroke="#f00"/>')).toBe('#ff0000');
  });

  it('falls back to black', () => {
    expect(colorOf(shape(''))).toBe('#000000');
    expect(colorOf(shape('stroke="none" fill="none"'))).toBe('#000000');
    expect(colorOf(shape('stroke="currentColor"'))).toBe('#000000');
    expect(colorOf(shape('stroke="url(#gradient)"'))).toBe('#000000');
    expect(colorOf(shape('stroke="notacolour"'))).toBe('#000000');
  });

  it('turns white and near-white into black', () => {
    expect(colorOf(shape('stroke="#fff"'))).toBe('#000000');
    expect(colorOf(shape('stroke="white"'))).toBe('#000000');
    expect(colorOf(shape('stroke="#FEFEFE"'))).toBe('#000000');
    expect(colorOf(shape('stroke="rgb(250,250,250)"'))).toBe('#000000');
    expect(colorOf(shape('stroke="#ffff00"'))).toBe('#ffff00');
  });
});

describe('importSvg visibility and unsupported content', () => {
  it('skips display:none from attributes, styles and ancestors', () => {
    const { paths, warnings } = importSvg(
      mm(
        '<line x2="1" display="none"/>' +
          '<line x2="2" style="display:none"/>' +
          '<g display="none"><line x2="3"/><text>hidden</text></g>' +
          '<style>.off{display:none}</style><line class="off" x2="4"/>' +
          '<line y1="9" x2="5" y2="9"/>',
      ),
    );
    expect(paths).toHaveLength(1);
    expect(at(paths[0] as ColoredPolyline, 1)).toEqual({ x: 5, y: 9 });
    expect(warnings).toEqual([]);
  });

  it('skips visibility:hidden but honours a visible descendant', () => {
    const { paths } = importSvg(
      mm(
        '<g visibility="hidden"><line x2="1"/><line y1="5" x2="2" y2="5" visibility="visible"/></g>' +
          '<line x2="3" style="visibility:hidden"/>',
      ),
    );
    expect(paths).toHaveLength(1);
    expect(at(paths[0] as ColoredPolyline, 1)).toEqual({ x: 2, y: 5 });
  });

  it('summarises unsupported elements once per type', () => {
    const { paths, warnings } = importSvg(
      mm(
        '<text x="1" y="1">one <tspan>two</tspan></text><g><text>three</text></g>' +
          '<image href="a.png" width="5" height="5"/>' +
          '<foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
          '<title>t</title><desc>d</desc><metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>' +
          '<line x2="5"/>',
      ),
    );
    expect(paths).toHaveLength(1);
    expect(warnings).toEqual(['Skipped 2 text', 'Skipped 1 image', 'Skipped 1 foreignObject']);
  });

  it('does not draw defs, clipPath, mask, pattern, marker or symbol contents', () => {
    const body = ['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol']
      .map((tag) => `<${tag}><rect width="5" height="5"/></${tag}>`)
      .join('');
    expect(importSvg(mm(body))).toEqual({ paths: [], warnings: [] });
  });
});

describe('importSvg joining', () => {
  it('joins near-coincident separate paths into one closed path', () => {
    const path = only(
      mm(
        '<line x1="0" y1="0" x2="10" y2="0"/>' +
          '<path d="M10.004 0.003 L10 10"/>' +
          '<polyline points="0.002,0.001 10.003,10.002"/>',
      ),
    );
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(3);
  });

  it('respects the join tolerance option', () => {
    const body = '<line x1="0" y1="0" x2="10" y2="0"/><line x1="10.5" y1="0" x2="20" y2="0"/>';
    expect(importSvg(mm(body)).paths).toHaveLength(2);
    expect(importSvg(mm(body), { joinToleranceMm: 1 }).paths).toHaveLength(1);
  });

  it('never joins across colours', () => {
    const { paths } = importSvg(
      mm('<line x1="0" y1="0" x2="10" y2="0" stroke="red"/><line x1="10" y1="0" x2="10" y2="10" stroke="blue"/>'),
    );
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.color)).toEqual(['#ff0000', '#0000ff']);
  });

  it('removes duplicate paths of the same colour', () => {
    const body = '<rect width="10" height="10"/><rect width="10" height="10"/><path d="M0 0H10V10H0Z" stroke="red"/>';
    const { paths } = importSvg(mm(body));
    expect(paths.map((p) => p.color)).toEqual(['#000000', '#ff0000']);
  });

  it('closes a path whose last point returns to its start', () => {
    const path = only(mm('<path d="M0 0 L10 0 L10 10 L0 0"/>'));
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(3);
  });

  it('drops degenerate paths', () => {
    expect(importSvg(mm('<path d="M5 5"/><path d="M5 5 Z"/><line x1="1" y1="1" x2="1" y2="1"/><polyline points="3,3"/>')).paths).toEqual([]);
  });
});

describe('importSvg fixtures', () => {
  it('imports an Inkscape-style file in mm with a layer transform', () => {
    const { paths, warnings } = importSvg(fixture('inkscape-plate.svg'));
    expect(warnings).toEqual(['Skipped 1 text']);
    expect(paths).toHaveLength(3);
    const [rect, circle, curve] = paths as [ColoredPolyline, ColoredPolyline, ColoredPolyline];

    expect(rect.color).toBe('#ff0000');
    expect(rect.closed).toBe(true);
    expect(extent(rect)).toEqual({ minX: 15, minY: 10, maxX: 55, maxY: 40 });

    expect(circle.color).toBe('#0000ff');
    expect(circle.closed).toBe(true);
    for (const p of circle.points) expect(Math.hypot(p.x - 35, p.y - 25)).toBeCloseTo(5, 9);

    expect(curve.color).toBe('#000000');
    expect(curve.closed).toBe(false);
    expect(at(curve, 0)).toEqual({ x: 60, y: 10 });
    expect(at(curve, -1)).toEqual({ x: 70, y: 10 });
    expect(extent(curve).maxY).toBeCloseTo(17.5, 1);
  });

  it('imports an Illustrator-style file with style classes and px units', () => {
    const { paths, warnings } = importSvg(fixture('illustrator-classes.svg'));
    expect(warnings).toEqual([]);
    expect(paths).toHaveLength(3);
    const [rect, triangle, mark] = paths as [ColoredPolyline, ColoredPolyline, ColoredPolyline];

    expect(rect.color).toBe('#ff0000');
    expect(rect.closed).toBe(true);
    const box = extent(rect);
    expect(box.minX).toBeCloseTo(2.54, 9);
    expect(box.minY).toBeCloseTo(2.54, 9);
    expect(box.maxX - box.minX).toBeCloseTo(25.4, 9);
    expect(box.maxY - box.minY).toBeCloseTo(12.7, 9);

    expect(triangle.color).toBe('#0000ff');
    expect(triangle.closed).toBe(true);
    expect(triangle.points).toHaveLength(3);
    expect(at(triangle, 2).x).toBeCloseTo(144 * MM_PER_PX, 9);
    expect(at(triangle, 2).y).toBeCloseTo(58 * MM_PER_PX, 9);

    // The line and the path that continues it are joined into one open path.
    expect(mark.color).toBe('#00ff00');
    expect(mark.closed).toBe(false);
    expect(extent(mark).minX).toBeCloseTo(0, 9);
    expect(extent(mark).maxX).toBeCloseTo(50.8, 9);
    expect(extent(mark).minY).toBeCloseTo(25.4, 9);
    expect(extent(mark).maxY).toBeCloseTo(25.4, 9);
  });
});

describe('importSvg errors and edge cases', () => {
  it('throws a readable error for text that is not XML', () => {
    expect(() => importSvg('this is not an svg file')).toThrow(/Not a valid SVG file/);
    expect(() => importSvg('')).toThrow(/Not a valid SVG file/);
    expect(() => importSvg('<svg><g></svg>')).toThrow(/Not a valid SVG file/);
    expect(() => importSvg('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n')).toThrow(Error);
  });

  it('throws when there is no svg root', () => {
    expect(() => importSvg('<html><body/></html>')).toThrow(/no <svg> root/);
  });

  it('returns an empty result for an empty drawing', () => {
    expect(importSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual({ paths: [], warnings: [] });
    expect(importSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual({ paths: [], warnings: [] });
  });

  it('accepts a BOM, an XML declaration, a doctype and a prefixed root', () => {
    const text =
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">' +
      '<svg:line x2="5"/></svg:svg>';
    expectPoints(only(text), [
      [0, 0],
      [5, 0],
    ]);
  });

  it('skips non-finite coordinates', () => {
    const path = only(mm('<path d="M0 0 L1e999 5 L10 0 L10 10"/>'));
    expectPoints(path, [
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });
});
