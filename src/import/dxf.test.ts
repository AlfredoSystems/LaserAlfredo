import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boundsOfPolylines } from '../geometry/bounds';
import { distanceToPolyline } from '../geometry/hit';
import type { ColoredPolyline, Point } from '../model/types';
import { importDxf } from './dxf';

/**
 * The Y flip mirrors about the bounding box of the flattened geometry, which
 * can fall short of a curve's true extreme by up to the flatten tolerance
 * (0.02 mm). Positions that depend on such a box are checked with this slack.
 */
const CURVE_SLACK = 0.025;

function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8');
}

/** Wraps entity groups (one string per line) in a minimal ENTITIES-only DXF. */
function dxfFromGroups(lines: readonly (string | number)[]): string {
  return `0\nSECTION\n2\nENTITIES\n${lines.map(String).join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

function dxfOf(...lines: (string | number)[]): string {
  return dxfFromGroups(lines);
}

function line(x1: number, y1: number, x2: number, y2: number, aci?: number): (string | number)[] {
  const color = aci === undefined ? [] : [62, aci];
  return [0, 'LINE', 8, '0', ...color, 10, x1, 20, y1, 11, x2, 21, y2];
}

function at(path: ColoredPolyline, index: number): Point {
  const p = path.points.at(index);
  if (p === undefined) throw new Error(`path has no point ${index}`);
  return p;
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const first = items[0];
  if (first === undefined) throw new Error('expected one item');
  return first;
}

function expectPoint(p: Point, x: number, y: number, eps = 1e-9): void {
  expect(Math.hypot(p.x - x, p.y - y), `(${p.x}, ${p.y}) should be (${x}, ${y})`).toBeLessThanOrEqual(eps);
}

/** The path passes within `eps` of the point (on a vertex or along a segment). */
function expectPassesThrough(path: ColoredPolyline, x: number, y: number, eps = 0.03): void {
  expect(distanceToPolyline({ x, y }, path), `path should pass through (${x}, ${y})`).toBeLessThanOrEqual(eps);
}

/** The path's vertices are exactly these points, in any order and direction. */
function expectVertices(path: ColoredPolyline, expected: readonly [number, number][], eps = 1e-9): void {
  expect(path.points).toHaveLength(expected.length);
  for (const [x, y] of expected) {
    const nearest = Math.min(...path.points.map((p) => Math.hypot(p.x - x, p.y - y)));
    expect(nearest, `missing vertex (${x}, ${y})`).toBeLessThanOrEqual(eps);
  }
}

function centroid(path: ColoredPolyline): Point {
  let x = 0;
  let y = 0;
  for (const p of path.points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / path.points.length, y: y / path.points.length };
}

function pathAtX(paths: readonly ColoredPolyline[], x: number): ColoredPolyline {
  return only(paths.filter((path) => path.points.some((p) => Math.abs(p.x - x) < 1e-6)));
}

function byColor(paths: readonly ColoredPolyline[], color: string): ColoredPolyline {
  return only(paths.filter((path) => path.color === color));
}

describe('importDxf: joining messy input', () => {
  it('joins 4 shuffled, reversed LINEs with 0.005 mm gaps into one closed square', () => {
    const result = importDxf(fixture('square-gaps.dxf'));
    const square = only(result.paths);
    expect(square.closed).toBe(true);
    expectVertices(
      square,
      [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
      ],
      0.0075,
    );
    expect(result.warnings).toEqual([]);
  });

  it('leaves the gaps open when the join tolerance is smaller than them', () => {
    const result = importDxf(fixture('square-gaps.dxf'), { joinToleranceMm: 0.001 });
    expect(result.paths).toHaveLength(4);
    expect(result.paths.every((path) => !path.closed)).toBe(true);
  });

  it('removes duplicate overlapping lines and zero-length lines', () => {
    const result = importDxf(fixture('duplicates.dxf'));
    const path = only(result.paths);
    expect(path.closed).toBe(false);
    expectVertices(
      path,
      [
        [0, 5],
        [10, 5],
        [10, 0],
      ],
      0.003,
    );
  });

  it('joins ARCs and LINEs into one closed slot', () => {
    const result = importDxf(fixture('slot.dxf'));
    const slot = only(result.paths);
    expect(slot.closed).toBe(true);
    const bounds = boundsOfPolylines([slot]);
    expect(bounds?.minX).toBeCloseTo(0, 1);
    expect(bounds?.maxX).toBeCloseTo(30, 1);
    expect(bounds?.minY).toBeCloseTo(0, 1);
    expect(bounds?.maxY).toBeCloseTo(10, 1);
    expectPassesThrough(slot, 0, 5);
    expectPassesThrough(slot, 30, 5);
    expectPassesThrough(slot, 15, 0);
    expectPassesThrough(slot, 15, 10);
    // The round ends really are round: 45 degrees along the right-hand arc.
    expectPassesThrough(slot, 25 + 5 * Math.SQRT1_2, 5 + 5 * Math.SQRT1_2);
  });

  it('never joins paths of different colours', () => {
    const touching = dxfOf(...line(0, 0, 10, 0, 1), ...line(10, 0, 10, 10, 5));
    const result = importDxf(touching);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.map((path) => path.color).sort()).toEqual(['#0000ff', '#ff0000']);

    const sameColor = importDxf(dxfOf(...line(0, 0, 10, 0, 1), ...line(10, 0, 10, 10, 1)));
    expect(sameColor.paths).toHaveLength(1);
  });

  it('drops coordinates that are not numbers', () => {
    const result = importDxf(dxfOf(0, 'LINE', 8, '0', 10, 'abc', 20, 0, 11, 5, 21, 5, ...line(0, 0, 10, 0)));
    const path = only(result.paths);
    expect(path.points).toHaveLength(2);
  });
});

describe('importDxf: entities', () => {
  it('flattens LWPOLYLINE bulges on the correct side after the Y flip', () => {
    const result = importDxf(fixture('lwpolyline-bulge.dxf'));
    expect(result.paths).toHaveLength(2);

    // In CAD the box sits on y = 0 and its top edge bulges up to y = 15. On
    // screen (Y down) the bulge must still be at the top: y = 0.
    const box = only(result.paths.filter((path) => path.closed));
    expectPassesThrough(box, 0, 15, CURVE_SLACK);
    expectPassesThrough(box, 10, 15, CURVE_SLACK);
    expectPassesThrough(box, 10, 5, CURVE_SLACK);
    expectPassesThrough(box, 0, 5, CURVE_SLACK);
    expectPassesThrough(box, 5, 0);
    expectPassesThrough(box, 5 + 5 * Math.SQRT1_2, 5 - 5 * Math.SQRT1_2);
    const boxBounds = boundsOfPolylines([box]);
    expect(boxBounds?.minY).toBeCloseTo(0, 1);
    expect(boxBounds?.maxY).toBeCloseTo(15, 1);
    // Every arc point lies on the circle of radius 5 around (5, 5).
    for (const p of box.points.filter((q) => q.y < 5 - CURVE_SLACK)) {
      expect(Math.abs(Math.hypot(p.x - 5, p.y - 5) - 5)).toBeLessThanOrEqual(CURVE_SLACK);
    }

    // Negative bulge of 0.5 on a 10 mm chord: 2.5 mm high, bulging up in CAD.
    const open = only(result.paths.filter((path) => !path.closed));
    expectPoint(at(open, 0), 20, 15, CURVE_SLACK);
    expectPoint(at(open, -1), 30, 15, CURVE_SLACK);
    expectPassesThrough(open, 25, 12.5);
    expect(Math.min(...open.points.map((p) => p.y))).toBeGreaterThan(12.5 - CURVE_SLACK);
  });

  it('imports a CIRCLE as a closed ring within the flatten tolerance', () => {
    const result = importDxf(fixture('circle.dxf'));
    const circle = only(result.paths);
    expect(circle.closed).toBe(true);
    expect(circle.color).toBe('#ff0000');
    expect(circle.points.length).toBeGreaterThanOrEqual(12);
    const centre = centroid(circle);
    expectPoint(centre, 50, 30, CURVE_SLACK);
    circle.points.forEach((p, i) => {
      expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(10, 9);
      const next = at(circle, (i + 1) % circle.points.length);
      const sagitta = 10 - Math.hypot((p.x + next.x) / 2 - centre.x, (p.y + next.y) / 2 - centre.y);
      expect(sagitta).toBeLessThanOrEqual(0.02 + 1e-9);
    });
  });

  it('honours the flatten tolerance option', () => {
    const coarse = only(importDxf(fixture('circle.dxf'), { flattenToleranceMm: 0.5 }).paths);
    const fine = only(importDxf(fixture('circle.dxf'), { flattenToleranceMm: 0.001 }).paths);
    expect(fine.points.length).toBeGreaterThan(coarse.points.length * 4);
  });

  it('imports full and partial ELLIPSEs', () => {
    const result = importDxf(fixture('ellipses.dxf'));
    expect(result.paths).toHaveLength(2);

    const full = byColor(result.paths, '#000000');
    expect(full.closed).toBe(true);
    const fullCentre = centroid(full);
    expectPoint(fullCentre, 0, 0, CURVE_SLACK);
    for (const p of full.points) {
      expect(((p.x - fullCentre.x) / 20) ** 2 + ((p.y - fullCentre.y) / 10) ** 2).toBeCloseTo(1, 9);
    }
    const fullBounds = boundsOfPolylines([full]);
    expect(fullBounds?.minX).toBeCloseTo(-20, 1);
    expect(fullBounds?.maxX).toBeCloseTo(20, 1);
    expect(fullBounds?.minY).toBeCloseTo(-10, 1);
    expect(fullBounds?.maxY).toBeCloseTo(10, 1);

    // Quarter ellipse: in CAD from the top of the major axis (60, 10) to the
    // left (55, 0); on screen the top is at y = -10.
    const quarter = byColor(result.paths, '#0000ff');
    expect(quarter.closed).toBe(false);
    expectPoint(at(quarter, 0), 60, -10, CURVE_SLACK);
    expectPoint(at(quarter, -1), 55, 0, CURVE_SLACK);
    expectPassesThrough(quarter, 60 - 5 * Math.SQRT1_2, -10 * Math.SQRT1_2);
    for (const p of quarter.points) {
      expect(((p.x - 60) / 5) ** 2 + (p.y / 10) ** 2).toBeCloseTo(1, 2);
      expect(p.x).toBeLessThanOrEqual(60 + 1e-9);
      expect(p.y).toBeLessThanOrEqual(CURVE_SLACK);
    }
  });

  it('imports SPLINEs with knots, weights and fit points', () => {
    const result = importDxf(fixture('splines.dxf'));
    expect(result.paths).toHaveLength(4);

    // Rational quadratic with weights (1, sqrt(1/2), 1) is an exact quarter
    // circle of radius 10; without the weights it would be a parabola.
    const rational = byColor(result.paths, '#ff0000');
    expect(rational.closed).toBe(false);
    expectPoint(at(rational, 0), 10, 10);
    expectPoint(at(rational, -1), 0, 0);
    expect(rational.points.length).toBeGreaterThan(8);
    for (const p of rational.points) {
      expect(Math.hypot(p.x, p.y - 10)).toBeCloseTo(10, 6);
    }

    // Clamped cubic = one Bezier segment; its midpoint is (25, 7.5) in CAD.
    const cubic = byColor(result.paths, '#00ff00');
    expect(cubic.closed).toBe(false);
    expectPoint(at(cubic, 0), 20, 10);
    expectPoint(at(cubic, -1), 30, 10);
    expectPassesThrough(cubic, 25, 2.5);

    const fit = byColor(result.paths, '#0000ff');
    expect(fit.closed).toBe(false);
    expectPoint(at(fit, 0), 40, 10);
    expectPoint(at(fit, -1), 50, 10);
    expectPassesThrough(fit, 45, 5);
    expect(fit.points.length).toBeGreaterThan(3);

    const closedFit = byColor(result.paths, '#ff00ff');
    expect(closedFit.closed).toBe(true);
    expectPassesThrough(closedFit, 60, 7);
    expectPassesThrough(closedFit, 70, 7);
    expectPassesThrough(closedFit, 70, 3);
    expectPassesThrough(closedFit, 60, 3);
    const first = at(closedFit, 0);
    const last = at(closedFit, -1);
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(1e-6);
  });

  it('mirrors entities whose extrusion direction is (0, 0, -1)', () => {
    const result = importDxf(fixture('extrusion.dxf'));
    expect(result.paths).toHaveLength(4);
    expect(result.warnings).toEqual([]);

    const arc = pathAtX(result.paths, 5);
    expect(arc.closed).toBe(false);
    expectPoint(at(arc, 0), 5, 2.5, CURVE_SLACK);
    expectPoint(at(arc, -1), 10, -2.5, CURVE_SLACK);
    expectPassesThrough(arc, 10 - 5 * Math.SQRT1_2, 2.5 - 5 * Math.SQRT1_2);

    const circle = only(result.paths.filter((path) => path.closed));
    expectPoint(centroid(circle), 30, 2.5, CURVE_SLACK);

    const polyline = pathAtX(result.paths, 40);
    expectPoint(at(polyline, 0), 40, 2.5, CURVE_SLACK);
    expectPoint(at(polyline, -1), 50, 2.5, CURVE_SLACK);
    expectPassesThrough(polyline, 45, -2.5);

    const ellipse = pathAtX(result.paths, 75);
    expectPoint(at(ellipse, 0), 75, 2.5, CURVE_SLACK);
    expectPoint(at(ellipse, -1), 70, 5, CURVE_SLACK);
  });

  it('reads an R12-style file with only an ENTITIES section', () => {
    const result = importDxf(fixture('r12-minimal.dxf'));
    expect(result.warnings).toEqual([]);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((path) => path.closed && path.color === '#000000')).toBe(true);

    // Old-style POLYLINE / VERTEX / SEQEND with a bulged top edge.
    const outline = only(result.paths.filter((path) => path.points.some((p) => p.x === 0)));
    expectPassesThrough(outline, 0, 35, CURVE_SLACK);
    expectPassesThrough(outline, 30, 35, CURVE_SLACK);
    expectPassesThrough(outline, 30, 15, CURVE_SLACK);
    expectPassesThrough(outline, 0, 15, CURVE_SLACK);
    expectPassesThrough(outline, 15, 0);
    expect(boundsOfPolylines([outline])?.minY).toBeCloseTo(0, 1);

    const hole = only(result.paths.filter((path) => path !== outline));
    const holeCentre = centroid(hole);
    expectPoint(holeCentre, 15, 25, CURVE_SLACK);
    for (const p of hole.points) expect(Math.hypot(p.x - holeCentre.x, p.y - holeCentre.y)).toBeCloseTo(3, 9);
  });

  it('does not hang or lose entities when a POLYLINE has no SEQEND', () => {
    const result = importDxf(
      dxfOf(
        ...[0, 'POLYLINE', 8, '0', 66, 1, 70, 0],
        ...[0, 'VERTEX', 8, '0', 10, 0, 20, 0],
        ...[0, 'VERTEX', 8, '0', 10, 10, 20, 0],
        // No SEQEND here.
        ...line(50, 0, 60, 0),
      ),
    );
    expect(result.paths).toHaveLength(2);
  });
});

describe('importDxf: blocks', () => {
  it('places nested blocks with base point, rotation, mirroring and non-uniform scale', () => {
    const result = importDxf(fixture('blocks.dxf'));
    expect(result.warnings).toEqual([]);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((path) => path.closed)).toBe(true);

    const rotated = pathAtX(result.paths, 116);
    expectVertices(rotated, [
      [120, 54],
      [120, 50],
      [116, 54],
    ]);
    const mirrored = pathAtX(result.paths, 92);
    expectVertices(mirrored, [
      [100, 54],
      [92, 54],
      [100, 50],
    ]);
  });

  it('tightens the flatten tolerance by the insert scale', () => {
    const ellipse = only(importDxf(fixture('block-scale.dxf')).paths);
    expect(ellipse.closed).toBe(true);
    // A unit circle flattened at 0.02 would get about 16 segments.
    expect(ellipse.points.length).toBeGreaterThan(90);
    ellipse.points.forEach((p, i) => {
      const next = at(ellipse, (i + 1) % ellipse.points.length);
      const mx = (p.x + next.x) / 2;
      const my = (p.y + next.y) / 2;
      const shortfall = (1 - Math.hypot(mx / 40, my / 20)) * 40;
      expect(shortfall).toBeLessThanOrEqual(0.02 + 1e-9);
    });
    const bounds = boundsOfPolylines([ellipse]);
    expect(bounds?.maxX).toBeCloseTo(40, 9);
    expect(bounds?.minY).toBeCloseTo(-20, 1);
  });

  it('expands INSERT row/column arrays, rotated with the insert', () => {
    const result = importDxf(fixture('insert-array.dxf'));
    expect(result.paths).toHaveLength(8);
    expect(result.paths.every((path) => path.closed)).toBe(true);
    const centres = result.paths.map(centroid);
    const expected: [number, number][] = [
      [10, 15],
      [15, 15],
      [20, 15],
      [10, 11],
      [15, 11],
      [20, 11],
      [50, 15],
      [50, 10],
    ];
    for (const [x, y] of expected) {
      const nearest = Math.min(...centres.map((c) => Math.hypot(c.x - x, c.y - y)));
      expect(nearest, `missing circle at (${x}, ${y})`).toBeLessThanOrEqual(CURVE_SLACK);
    }
  });

  it('survives blocks that insert each other and INSERTs of missing blocks', () => {
    const result = importDxf(fixture('block-cycle.dxf'));
    const path = only(result.paths);
    expectVertices(path, [
      [0, 5],
      [10, 0],
    ]);
    expect(result.warnings.some((w) => w.includes('insert themselves') && w.includes('"A"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('missing blocks') && w.includes('"NOPE"'))).toBe(true);
  });
});

describe('importDxf: units, colours, orientation', () => {
  it('converts inches to millimetres and says so', () => {
    const result = importDxf(fixture('inches.dxf'));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('inches');
    expect(result.warnings[0]).toContain('25.4');
    expect(result.paths).toHaveLength(2);

    const corner = only(result.paths.filter((path) => !path.closed));
    expectVertices(corner, [
      [0, 50.8],
      [25.4, 50.8],
      [25.4, 0],
    ]);
    const circle = only(result.paths.filter((path) => path.closed));
    const centre = centroid(circle);
    expectPoint(centre, 76.2, 25.4, CURVE_SLACK);
    for (const p of circle.points) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(12.7, 9);
  });

  it('treats missing and unitless $INSUNITS as millimetres without a warning', () => {
    expect(importDxf(fixture('square-gaps.dxf')).warnings).toEqual([]);
    expect(importDxf(fixture('l-shape.dxf')).warnings).toEqual([]);
  });

  it('warns about unit codes it does not know', () => {
    const text = fixture('inches.dxf').replace(/\r\n/g, '\n').replace('$INSUNITS\n70\n1\n', '$INSUNITS\n70\n99\n');
    expect(text).toContain('$INSUNITS\n70\n99\n');
    const result = importDxf(text);
    expect(result.warnings.some((w) => w.includes('$INSUNITS 99'))).toBe(true);
    expectVertices(only(result.paths.filter((path) => !path.closed)), [
      [0, 2],
      [1, 2],
      [1, 0],
    ]);
  });

  it('resolves ACI, true colour, BYLAYER and BYBLOCK colours', () => {
    const result = importDxf(fixture('colors.dxf'));
    const expected: [number, string, string][] = [
      [10, '#ff0000', 'BYLAYER on a red layer'],
      [20, '#00ff00', 'explicit ACI 3'],
      [30, '#ff6600', 'true colour wins over ACI'],
      [40, '#123456', 'BYLAYER on a layer with a true colour (name differs in case)'],
      [50, '#0000ff', 'layer that is switched off (negative colour)'],
      [60, '#000000', 'ACI 7 layer'],
      [70, '#000000', 'ACI 255 is white'],
      [80, '#000000', 'layer missing from the table'],
      [90, '#000000', 'BYBLOCK outside any block'],
      [95, '#000000', 'white true colour'],
      [100, '#ff00ff', 'BYBLOCK takes the INSERT colour'],
      [110, '#ff0000', 'BYLAYER on layer 0 in a block takes the INSERT layer'],
      [120, '#123456', 'BYLAYER on another layer in a block'],
      [130, '#00ffff', 'explicit ACI in a block'],
    ];
    expect(result.paths).toHaveLength(expected.length);
    for (const [x, color, why] of expected) {
      expect(pathAtX(result.paths, x).color, why).toBe(color);
    }
    for (const path of result.paths) expect(path.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps an asymmetric L upright (Y-up CAD to Y-down document)', () => {
    const result = importDxf(fixture('l-shape.dxf'));
    const shape = only(result.paths);
    expect(shape.closed).toBe(true);
    // Stem on the left with its top at y = 0; foot along the bottom (large y)
    // pointing right. The bounding box is where it was in the file.
    expect(shape.points).toEqual([
      { x: 0, y: 30 },
      { x: 20, y: 30 },
      { x: 20, y: 25 },
      { x: 5, y: 25 },
      { x: 5, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});

describe('importDxf: unsupported and broken input', () => {
  it('skips unsupported entities and reports one warning per type', () => {
    const result = importDxf(fixture('unsupported.dxf'));
    const path = only(result.paths);
    expectVertices(path, [
      [0, 30],
      [40, 0],
    ]);
    expect([...result.warnings].sort()).toEqual(
      [
        'Skipped 3 TEXT',
        'Skipped 1 MTEXT',
        'Skipped 2 POINT',
        'Skipped 1 DIMENSION',
        'Skipped 1 HATCH',
        'Skipped 1 3DFACE',
        'Skipped 1 POLYLINE (3D mesh)',
        'Skipped 1 paper-space entities',
      ].sort(),
    );
  });

  it('returns no paths and a warning for an empty drawing', () => {
    const result = importDxf(dxfOf());
    expect(result.paths).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('throws a readable error for text that is not DXF', () => {
    expect(() => importDxf('hello\nthis is not a drawing\n<svg></svg>\n')).toThrow(/DXF/);
    expect(() => importDxf('')).toThrow(/DXF/);
    expect(() => importDxf('AutoCAD Binary DXF\r\n\u001a\u0000')).toThrow(/Binary DXF/);
  });

  it('still imports a file that lost its EOF marker', () => {
    const text = fixture('l-shape.dxf').replace(/\r\n/g, '\n').replace(/0\nENDSEC\n0\nEOF\n?$/, '');
    expect(text).not.toContain('EOF');
    const result = importDxf(text);
    expect(only(result.paths).points).toHaveLength(6);
    expect(result.warnings.some((w) => w.includes('EOF'))).toBe(true);
  });

  it('handles Windows line endings', () => {
    const text = fixture('slot.dxf').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    expect(only(importDxf(text).paths).closed).toBe(true);
  });
});

describe('importDxf: large files', () => {
  it('imports 50,000 LINEs forming 12,500 squares in a couple of seconds', () => {
    const lines: (string | number)[] = [];
    for (let i = 0; i < 12500; i++) {
      const x = (i % 125) * 8;
      const y = Math.floor(i / 125) * 8;
      lines.push(
        ...line(x, y, x + 5, y),
        ...line(x + 5, y + 5, x + 5, y),
        ...line(x + 5, y + 5, x, y + 5),
        ...line(x, y, x, y + 5),
      );
    }
    const text = dxfFromGroups(lines);
    const started = performance.now();
    const result = importDxf(text);
    const elapsedMs = performance.now() - started;
    expect(result.paths).toHaveLength(12500);
    expect(result.paths.every((path) => path.closed && path.points.length === 4)).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
