import { describe, expect, it } from 'vitest';
import type { Point } from '../model/types';
import {
  DEFAULT_FLATTEN_TOLERANCE_MM,
  flattenArc,
  flattenBulge,
  flattenCircle,
  flattenCubic,
  flattenEllipse,
  flattenFitPoints,
  flattenQuadratic,
  flattenSpline,
  flattenSvgArc,
} from './flatten';
import { distanceToPolyline } from './hit';

const TOL = 0.02;
const SLACK = 1e-9;
const SAMPLES = 2000;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function first(points: readonly Point[]): Point {
  return must(points[0]);
}

function last(points: readonly Point[]): Point {
  return must(points[points.length - 1]);
}

function sample(curve: (t: number) => Point, t0: number, t1: number, count = SAMPLES): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= count; i++) out.push(curve(t0 + ((t1 - t0) * i) / count));
  return out;
}

/** Largest distance from any sample of the true curve to the flattened polyline. */
function maxDeviation(truth: readonly Point[], flattened: readonly Point[], closed = false): number {
  let worst = 0;
  for (const p of truth) {
    worst = Math.max(worst, distanceToPolyline(p, { points: flattened, closed }));
  }
  return worst;
}

function expectPointClose(actual: Point, expected: Point, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function expectAllFinite(points: readonly Point[]): void {
  for (const p of points) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  }
}

function polylineLength(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = must(points[i - 1]);
    const b = must(points[i]);
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function circlePoint(c: Point, r: number, a: number): Point {
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

describe('flattenArc', () => {
  const c = { x: 100, y: 50 };

  it('has the documented default tolerance', () => {
    expect(DEFAULT_FLATTEN_TOLERANCE_MM).toBe(0.02);
  });

  it('sweeps counter-clockwise with increasing angle', () => {
    const pts = flattenArc(c, 40, 0, Math.PI / 2, true, TOL);
    expectPointClose(first(pts), { x: 140, y: 50 });
    expectPointClose(last(pts), { x: 100, y: 90 });
    const truth = sample((a) => circlePoint(c, 40, a), 0, Math.PI / 2);
    expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
    expect(polylineLength(pts)).toBeCloseTo(40 * (Math.PI / 2), 1);
  });

  it('sweeps clockwise the long way round', () => {
    const pts = flattenArc(c, 40, 0, Math.PI / 2, false, TOL);
    expectPointClose(first(pts), { x: 140, y: 50 });
    expectPointClose(last(pts), { x: 100, y: 90 });
    const truth = sample((a) => circlePoint(c, 40, a), 0, -1.5 * Math.PI);
    expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
    expect(polylineLength(pts)).toBeCloseTo(40 * 1.5 * Math.PI, 1);
    // Second point has a negative angle: it went clockwise.
    expect(must(pts[1]).y).toBeLessThan(50);
  });

  it('wraps across the angle seam', () => {
    const start = (350 * Math.PI) / 180;
    const end = (10 * Math.PI) / 180;
    const pts = flattenArc(c, 10, start, end, true, TOL);
    expect(polylineLength(pts)).toBeCloseTo((10 * 20 * Math.PI) / 180, 2);
    const truth = sample((a) => circlePoint(c, 10, a), start, start + (20 * Math.PI) / 180);
    expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('keeps every vertex on the circle', () => {
    for (const p of flattenArc(c, 123.4, 1, 5, true, TOL)) {
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(123.4, 9);
    }
  });

  it('respects tight and loose tolerances', () => {
    for (const tol of [0.001, 0.02, 0.5]) {
      const pts = flattenArc(c, 300, 0.3, 4, true, tol);
      const truth = sample((a) => circlePoint(c, 300, a), 0.3, 4, 20000);
      expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(tol + SLACK);
    }
    // A looser tolerance needs fewer points.
    expect(flattenArc(c, 300, 0.3, 4, true, 0.5).length).toBeLessThan(flattenArc(c, 300, 0.3, 4, true, 0.001).length);
  });

  it('is not wastefully dense', () => {
    // r = 50, tol = 0.02 needs about 56 segments for a half circle.
    const pts = flattenArc(c, 50, 0, Math.PI, true, TOL);
    expect(pts.length).toBeLessThan(70);
    expect(pts.length).toBeGreaterThan(50);
  });

  it('gives a zero-length arc for equal angles and a full turn for a 2 pi difference', () => {
    const zero = flattenArc(c, 10, 1, 1, true, TOL);
    expect(zero).toHaveLength(2);
    expectPointClose(first(zero), last(zero));
    const full = flattenArc(c, 10, 0, 2 * Math.PI, true, TOL);
    expect(full.length).toBeGreaterThan(12);
    expect(polylineLength(full)).toBeCloseTo(20 * Math.PI, 0);
  });

  it('guards degenerate input', () => {
    expect(flattenArc(c, NaN, 0, 1, true, TOL)).toEqual([]);
    expect(flattenArc(c, 10, NaN, 1, true, TOL)).toEqual([]);
    expect(flattenArc({ x: NaN, y: 0 }, 10, 0, 1, true, TOL)).toEqual([]);
    expect(flattenArc(c, 0, 0, 1, true, TOL)).toEqual([c, c]);
    expectAllFinite(flattenArc(c, 10, 0, 1, true, NaN));
    expectAllFinite(flattenArc(c, 10, 0, 1, true, 0));
    expectAllFinite(flattenArc(c, 10, 0, 1, true, -1));
  });

  it('caps the segment count', () => {
    const pts = flattenArc(c, 1e9, 0, 6, true, 1e-9);
    expect(pts.length).toBeLessThanOrEqual(10001);
    expect(pts.length).toBeGreaterThan(1000);
  });

  it('uses at least 12 segments per full turn however loose the tolerance', () => {
    expect(flattenArc(c, 0.01, 0, Math.PI, true, 5).length).toBeGreaterThanOrEqual(7);
  });
});

describe('flattenCircle', () => {
  const c = { x: -20, y: 30 };

  it('returns a ring without repeating the first point', () => {
    const pts = flattenCircle(c, 25, TOL);
    expect(Math.hypot(first(pts).x - last(pts).x, first(pts).y - last(pts).y)).toBeGreaterThan(0.1);
    const truth = sample((a) => circlePoint(c, 25, a), 0, 2 * Math.PI);
    expect(maxDeviation(truth, pts, true)).toBeLessThanOrEqual(TOL + SLACK);
    for (const p of pts) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(25, 9);
  });

  it('never has fewer than 12 segments', () => {
    expect(flattenCircle(c, 0.001, 1).length).toBe(12);
    expect(flattenCircle(c, 0.5, 100).length).toBe(12);
  });

  it('guards degenerate input', () => {
    expect(flattenCircle(c, 0, TOL)).toEqual([]);
    expect(flattenCircle(c, NaN, TOL)).toEqual([]);
    expect(flattenCircle(c, Infinity, TOL)).toEqual([]);
    expect(flattenCircle(c, 1e12, 1e-12).length).toBeLessThanOrEqual(10000);
    expect(flattenCircle(c, -5, TOL).length).toBeGreaterThanOrEqual(12);
  });
});

describe('flattenEllipse', () => {
  const c = { x: 10, y: -5 };
  const major = { x: 30, y: 40 }; // length 50, rotated
  const ratio = 0.4;
  const truthAt = (t: number): Point => ({
    x: c.x + major.x * Math.cos(t) + -major.y * ratio * Math.sin(t),
    y: c.y + major.y * Math.cos(t) + major.x * ratio * Math.sin(t),
  });

  it('flattens a partial ellipse within tolerance', () => {
    const pts = flattenEllipse(c, major, ratio, 0.5, 4, TOL);
    expectPointClose(first(pts), truthAt(0.5));
    expectPointClose(last(pts), truthAt(4));
    expect(maxDeviation(sample(truthAt, 0.5, 4, 5000), pts)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('returns start and end points for a full ellipse', () => {
    const pts = flattenEllipse(c, major, ratio, 0, 2 * Math.PI, TOL);
    expectPointClose(first(pts), { x: 40, y: 35 });
    expectPointClose(last(pts), { x: 40, y: 35 });
    expect(maxDeviation(sample(truthAt, 0, 2 * Math.PI, 5000), pts)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('adds a full turn when end <= start', () => {
    const pts = flattenEllipse(c, major, ratio, 5, 1, TOL);
    expectPointClose(first(pts), truthAt(5));
    expectPointClose(last(pts), truthAt(1));
    expect(maxDeviation(sample(truthAt, 5, 1 + 2 * Math.PI, 5000), pts)).toBeLessThanOrEqual(TOL + SLACK);
    // Equal params mean the whole ellipse.
    const whole = flattenEllipse(c, major, ratio, 1, 1, TOL);
    expect(maxDeviation(sample(truthAt, 0, 2 * Math.PI, 5000), whole)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('puts the minor axis at +90 degrees from the major axis', () => {
    const pts = flattenEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5, 0, Math.PI / 2, TOL);
    expectPointClose(first(pts), { x: 10, y: 0 });
    expectPointClose(last(pts), { x: 0, y: 5 });
  });

  it('matches a circle when the ratio is 1', () => {
    const pts = flattenEllipse(c, { x: 20, y: 0 }, 1, 0, Math.PI, TOL);
    for (const p of pts) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(20, 9);
  });

  it('guards degenerate input', () => {
    expect(flattenEllipse(c, { x: NaN, y: 0 }, 1, 0, 1, TOL)).toEqual([]);
    expect(flattenEllipse(c, major, NaN, 0, 1, TOL)).toEqual([]);
    expectAllFinite(flattenEllipse(c, { x: 0, y: 0 }, 0.5, 0, 6, TOL));
    expectAllFinite(flattenEllipse(c, major, 0, 0, 6, TOL));
    expect(flattenEllipse(c, { x: 1e9, y: 0 }, 1, 0, 6, 1e-9).length).toBeLessThanOrEqual(10001);
  });
});

describe('flattenBulge', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('returns the chord for a zero bulge', () => {
    expect(flattenBulge(a, b, 0, TOL)).toEqual([a, b]);
  });

  it('makes a semicircle for bulge 1, to the right of travel', () => {
    const pts = flattenBulge(a, b, 1, TOL);
    expect(first(pts)).toEqual(a);
    expect(last(pts)).toEqual(b);
    for (const p of pts) {
      expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 9);
      expect(p.y).toBeLessThanOrEqual(1e-9);
    }
    // Increasing angle from 180 to 360 degrees passes through (5, -5).
    const truth = sample((t) => circlePoint({ x: 5, y: 0 }, 5, t), Math.PI, 2 * Math.PI);
    expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
    expect(polylineLength(pts)).toBeCloseTo(5 * Math.PI, 1);
  });

  it('mirrors for bulge -1', () => {
    const pts = flattenBulge(a, b, -1, TOL);
    expect(first(pts)).toEqual(a);
    expect(last(pts)).toEqual(b);
    for (const p of pts) {
      expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
    }
    const truth = sample((t) => circlePoint({ x: 5, y: 0 }, 5, t), Math.PI, 0);
    expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('makes a quarter arc for bulge tan(pi/8)', () => {
    const bulge = Math.tan(Math.PI / 8);
    const r = 10 / Math.SQRT2;
    const pos = flattenBulge(a, b, bulge, TOL);
    for (const p of pos) expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(r, 9);
    expect(polylineLength(pos)).toBeCloseTo((r * Math.PI) / 2, 1);
    const truthPos = sample((t) => circlePoint({ x: 5, y: 5 }, r, t), -0.75 * Math.PI, -0.25 * Math.PI);
    expect(maxDeviation(truthPos, pos)).toBeLessThanOrEqual(TOL + SLACK);

    const neg = flattenBulge(a, b, -bulge, TOL);
    for (const p of neg) expect(Math.hypot(p.x - 5, p.y + 5)).toBeCloseTo(r, 9);
    const truthNeg = sample((t) => circlePoint({ x: 5, y: -5 }, r, t), 0.75 * Math.PI, 0.25 * Math.PI);
    expect(maxDeviation(truthNeg, neg)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('handles a bulge above 1 (more than a semicircle)', () => {
    const bulge = Math.tan((3 * Math.PI) / 8); // 270 degree arc
    const r = 10 / Math.SQRT2;
    const pts = flattenBulge(a, b, bulge, TOL);
    for (const p of pts) expect(Math.hypot(p.x - 5, p.y + 5)).toBeCloseTo(r, 9);
    expect(polylineLength(pts)).toBeCloseTo(r * 1.5 * Math.PI, 1);
  });

  it('works for an arbitrary chord direction', () => {
    const s = { x: 3, y: 7 };
    const e = { x: -4, y: 12 };
    const pts = flattenBulge(s, e, 0.5, TOL);
    expect(first(pts)).toEqual(s);
    expect(last(pts)).toEqual(e);
    // The arc bulges to the right of the direction of travel.
    const chord = Math.hypot(e.x - s.x, e.y - s.y);
    const mid = must(pts[Math.floor(pts.length / 2)]);
    const cross = (e.x - s.x) * (mid.y - s.y) - (e.y - s.y) * (mid.x - s.x);
    expect(cross).toBeLessThan(0);
    // The highest vertex is within the chord tolerance of the true sagitta (bulge * chord / 2).
    const trueSagitta = (0.5 * chord) / 2;
    const sagitta = Math.max(...pts.map((p) => Math.abs((e.x - s.x) * (p.y - s.y) - (e.y - s.y) * (p.x - s.x)) / chord));
    expect(sagitta).toBeLessThanOrEqual(trueSagitta + SLACK);
    expect(sagitta).toBeGreaterThanOrEqual(trueSagitta - TOL);
    // All vertices lie on the circle through the endpoints and the apex.
    const radius = (chord * (1 + 0.25)) / (4 * 0.5);
    const nx = (e.y - s.y) / chord;
    const ny = -(e.x - s.x) / chord;
    const centre = {
      x: (s.x + e.x) / 2 + nx * (trueSagitta - radius),
      y: (s.y + e.y) / 2 + ny * (trueSagitta - radius),
    };
    for (const p of pts) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(radius, 9);
  });

  it('guards degenerate input', () => {
    expect(flattenBulge(a, a, 1, TOL)).toEqual([a, a]);
    expect(flattenBulge(a, b, NaN, TOL)).toEqual([a, b]);
    expectAllFinite(flattenBulge(a, b, 1e-12, TOL));
    expectAllFinite(flattenBulge(a, b, 1e12, TOL));
    expect(flattenBulge(a, b, 1e12, 1e-9).length).toBeLessThanOrEqual(10001);
  });
});

describe('bezier flatteners', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 40, y: 120 };
  const p2 = { x: 160, y: -80 };
  const p3 = { x: 200, y: 30 };

  const quadAt = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    };
  };
  const cubicAt = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };

  it('flattens a quadratic within tolerance', () => {
    for (const tol of [0.005, TOL, 0.3]) {
      const pts = flattenQuadratic(p0, p1, p2, tol);
      expect(first(pts)).toEqual(p0);
      expect(last(pts)).toEqual(p2);
      expect(maxDeviation(sample(quadAt, 0, 1, 5000), pts)).toBeLessThanOrEqual(tol + SLACK);
    }
  });

  it('flattens a cubic within tolerance', () => {
    for (const tol of [0.005, TOL, 0.3]) {
      const pts = flattenCubic(p0, p1, p2, p3, tol);
      expect(first(pts)).toEqual(p0);
      expect(last(pts)).toEqual(p3);
      expect(maxDeviation(sample(cubicAt, 0, 1, 5000), pts)).toBeLessThanOrEqual(tol + SLACK);
    }
  });

  it('returns a single segment for straight curves', () => {
    expect(flattenQuadratic(p0, { x: 5, y: 5 }, { x: 10, y: 10 }, TOL)).toEqual([p0, { x: 10, y: 10 }]);
    expect(flattenCubic(p0, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, TOL)).toEqual([p0, { x: 30, y: 0 }]);
  });

  it('keeps point counts reasonable', () => {
    expect(flattenCubic(p0, p1, p2, p3, TOL).length).toBeLessThan(400);
    expect(flattenQuadratic(p0, p1, p2, TOL).length).toBeLessThan(200);
  });

  it('guards degenerate input', () => {
    expect(flattenCubic(p0, { x: NaN, y: 0 }, p2, p3, TOL)).toEqual([p0, p3]);
    expect(flattenQuadratic(p0, { x: 0, y: Infinity }, p2, TOL)).toEqual([p0, p2]);
    expect(flattenCubic(p0, p0, p0, p0, TOL)).toEqual([p0, p0]);
    expect(flattenCubic(p0, { x: 1e12, y: 1e12 }, p2, p3, 1e-9).length).toBeLessThanOrEqual(10001);
    expectAllFinite(flattenCubic(p0, p1, p2, p3, NaN));
  });
});

describe('flattenSvgArc', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 10, y: 10 };

  // For a radius-10 arc from (0,0) to (10,10) the two candidate centres are
  // (10,0) and (0,10). "Sweep" means increasing angle in the given coordinates.
  const cases = [
    { largeArc: false, sweep: true, center: { x: 0, y: 10 }, from: -Math.PI / 2, delta: Math.PI / 2 },
    { largeArc: false, sweep: false, center: { x: 10, y: 0 }, from: Math.PI, delta: -Math.PI / 2 },
    { largeArc: true, sweep: true, center: { x: 10, y: 0 }, from: Math.PI, delta: 1.5 * Math.PI },
    { largeArc: true, sweep: false, center: { x: 0, y: 10 }, from: -Math.PI / 2, delta: -1.5 * Math.PI },
  ];

  for (const c of cases) {
    it(`handles largeArc=${String(c.largeArc)} sweep=${String(c.sweep)}`, () => {
      const pts = flattenSvgArc(start, 10, 10, 0, c.largeArc, c.sweep, end, TOL);
      expect(first(pts)).toEqual(start);
      expect(last(pts)).toEqual(end);
      for (const p of pts) expect(Math.hypot(p.x - c.center.x, p.y - c.center.y)).toBeCloseTo(10, 9);
      const truth = sample((t) => circlePoint(c.center, 10, t), c.from, c.from + c.delta);
      expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(TOL + SLACK);
      expect(polylineLength(pts)).toBeCloseTo(10 * Math.abs(c.delta), 1);
    });
  }

  it('flattens a rotated elliptical arc within tolerance', () => {
    const center = { x: 50, y: 20 };
    const rx = 30;
    const ry = 12;
    const phiDeg = 30;
    const phi = (phiDeg * Math.PI) / 180;
    const at = (t: number): Point => ({
      x: center.x + Math.cos(phi) * rx * Math.cos(t) - Math.sin(phi) * ry * Math.sin(t),
      y: center.y + Math.sin(phi) * rx * Math.cos(t) + Math.cos(phi) * ry * Math.sin(t),
    });
    // 0.4 -> 2.0 is a small increasing sweep; 0.4 -> 2.0 - 2 pi is the large decreasing one.
    const small = flattenSvgArc(at(0.4), rx, ry, phiDeg, false, true, at(2.0), TOL);
    expect(maxDeviation(sample(at, 0.4, 2.0, 5000), small)).toBeLessThanOrEqual(TOL + SLACK);
    expect(maxDeviation(small, sample(at, 0.4, 2.0, 5000))).toBeLessThanOrEqual(TOL + SLACK);

    const large = flattenSvgArc(at(0.4), rx, ry, phiDeg, true, false, at(2.0), TOL);
    const largeTruth = sample(at, 0.4, 2.0 - 2 * Math.PI, 5000);
    expect(maxDeviation(largeTruth, large)).toBeLessThanOrEqual(TOL + SLACK);
    expect(maxDeviation(large, largeTruth)).toBeLessThanOrEqual(TOL + SLACK);
  });

  it('scales up radii that are too small to span the endpoints', () => {
    const pts = flattenSvgArc({ x: 0, y: 0 }, 5, 5, 0, false, true, { x: 20, y: 0 }, TOL);
    for (const p of pts) expect(Math.hypot(p.x - 10, p.y)).toBeCloseTo(10, 9);
    expect(polylineLength(pts)).toBeCloseTo(10 * Math.PI, 1);
    // Increasing angle from 180 degrees goes through negative y.
    for (const p of pts) expect(p.y).toBeLessThanOrEqual(1e-9);
    const other = flattenSvgArc({ x: 0, y: 0 }, 5, 5, 0, false, false, { x: 20, y: 0 }, TOL);
    for (const p of other) expect(p.y).toBeGreaterThanOrEqual(-1e-9);
  });

  it('scales up elliptical radii keeping their proportion', () => {
    const pts = flattenSvgArc({ x: 0, y: 0 }, 2, 1, 0, false, true, { x: 20, y: 0 }, TOL);
    // Scaled to rx = 10, ry = 5 about (10, 0).
    for (const p of pts) {
      expect(((p.x - 10) / 10) ** 2 + (p.y / 5) ** 2).toBeCloseTo(1, 9);
    }
  });

  it('treats negative radii as positive', () => {
    const a = flattenSvgArc(start, -10, -10, 0, false, true, end, TOL);
    const b = flattenSvgArc(start, 10, 10, 0, false, true, end, TOL);
    expect(a).toEqual(b);
  });

  it('returns a straight line for zero radii or coincident endpoints', () => {
    expect(flattenSvgArc(start, 0, 10, 0, false, true, end, TOL)).toEqual([start, end]);
    expect(flattenSvgArc(start, 10, 0, 0, true, true, end, TOL)).toEqual([start, end]);
    expect(flattenSvgArc(start, 10, 10, 0, true, true, start, TOL)).toEqual([start, start]);
    expect(flattenSvgArc(start, NaN, 10, 0, true, true, end, TOL)).toEqual([start, end]);
    expectAllFinite(flattenSvgArc(start, 10, 10, NaN, true, true, end, TOL));
  });
});

describe('flattenSpline', () => {
  const w = Math.SQRT1_2;
  // Unit-square-cornered rational quadratic circle of radius 50 about (60, 40).
  const r = 50;
  const cx = 60;
  const cy = 40;
  const nurbsCircle = {
    degree: 2,
    controlPoints: [
      { x: cx + r, y: cy },
      { x: cx + r, y: cy + r },
      { x: cx, y: cy + r },
      { x: cx - r, y: cy + r },
      { x: cx - r, y: cy },
      { x: cx - r, y: cy - r },
      { x: cx, y: cy - r },
      { x: cx + r, y: cy - r },
      { x: cx + r, y: cy },
    ],
    knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
    weights: [1, w, 1, w, 1, w, 1, w, 1],
  };

  it('evaluates a rational quadratic NURBS circle exactly and within tolerance', () => {
    for (const tol of [0.002, TOL, 0.2]) {
      const pts = flattenSpline(nurbsCircle, tol);
      expectPointClose(first(pts), { x: cx + r, y: cy });
      expectPointClose(last(pts), { x: cx + r, y: cy });
      for (const p of pts) expect(Math.hypot(p.x - cx, p.y - cy)).toBeCloseTo(r, 9);
      // Every vertex is on the circle, so the chord error is each segment's sagitta.
      let worst = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = must(pts[i - 1]);
        const b = must(pts[i]);
        const half = Math.hypot(b.x - a.x, b.y - a.y) / 2;
        worst = Math.max(worst, r - Math.sqrt(r * r - half * half));
      }
      expect(worst).toBeLessThanOrEqual(tol + SLACK);
      const truth = sample((t) => circlePoint({ x: cx, y: cy }, r, t), 0, 2 * Math.PI, 4000);
      expect(maxDeviation(truth, pts)).toBeLessThanOrEqual(tol + SLACK);
    }
  });

  it('is not wastefully dense on the NURBS circle', () => {
    // The ideal count at r = 50, tol = 0.02 is about 111 segments.
    expect(flattenSpline(nurbsCircle, TOL).length).toBeLessThan(450);
  });

  it('goes the wrong way without the weights (so weights are really used)', () => {
    const pts = flattenSpline({ ...nurbsCircle, weights: undefined }, TOL);
    const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(1);
  });

  it('matches a cubic bezier for a single clamped span', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 40, y: 120 };
    const p2 = { x: 160, y: -80 };
    const p3 = { x: 200, y: 30 };
    const pts = flattenSpline({ degree: 3, controlPoints: [p0, p1, p2, p3], knots: [0, 0, 0, 0, 1, 1, 1, 1] }, TOL);
    expectPointClose(first(pts), p0);
    expectPointClose(last(pts), p3);
    const reference = flattenCubic(p0, p1, p2, p3, 0.0005);
    expect(maxDeviation(reference, pts)).toBeLessThanOrEqual(TOL + SLACK);
    expect(maxDeviation(pts, reference)).toBeLessThanOrEqual(0.001);
  });

  it('handles a multi-span non-uniform cubic B-spline', () => {
    const controlPoints = [
      { x: 0, y: 0 },
      { x: 10, y: 30 },
      { x: 30, y: 35 },
      { x: 50, y: 0 },
      { x: 70, y: -20 },
      { x: 90, y: 10 },
      { x: 100, y: 0 },
    ];
    const knots = [0, 0, 0, 0, 1, 2.5, 3, 7, 7, 7, 7];
    const coarse = flattenSpline({ degree: 3, controlPoints, knots }, TOL);
    const fine = flattenSpline({ degree: 3, controlPoints, knots }, 0.0002);
    expectPointClose(first(coarse), { x: 0, y: 0 });
    expectPointClose(last(coarse), { x: 100, y: 0 });
    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(maxDeviation(fine, coarse)).toBeLessThanOrEqual(TOL + SLACK);
    // Scaling the knot vector does not change the curve.
    const scaled = flattenSpline({ degree: 3, controlPoints, knots: knots.map((k) => k * 10 + 5) }, TOL);
    expect(scaled).toHaveLength(coarse.length);
    scaled.forEach((p, i) => expectPointClose(p, must(coarse[i]), 7));
  });

  it('evaluates only the valid domain of an unclamped knot vector', () => {
    // Uniform quadratic B-spline: starts at the midpoint of the first leg.
    const pts = flattenSpline(
      {
        degree: 2,
        controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        knots: [0, 1, 2, 3, 4, 5, 6],
      },
      TOL,
    );
    expectPointClose(first(pts), { x: 5, y: 0 });
    expectPointClose(last(pts), { x: 5, y: 10 });
  });

  it('falls back to a clamped uniform knot vector when knots are missing or wrong', () => {
    const controlPoints = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }, { x: 60, y: -10 }];
    const expected = flattenSpline({ degree: 3, controlPoints, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1] }, TOL);
    for (const knots of [[], [0, 1, 2], [0, 0, 0, 0, 0.5, 1, 1, 1, NaN], [0, 0, 0, 0, 2, 1, 1, 1, 1]]) {
      const pts = flattenSpline({ degree: 3, controlPoints, knots }, TOL);
      expect(pts).toHaveLength(expected.length);
      pts.forEach((p, i) => expectPointClose(p, must(expected[i])));
    }
    expectPointClose(first(expected), { x: 0, y: 0 });
    expectPointClose(last(expected), { x: 60, y: -10 });
  });

  it('builds a periodic curve when closed and knots are missing', () => {
    const controlPoints = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const pts = flattenSpline({ degree: 3, controlPoints, knots: [], closed: true }, TOL);
    expect(pts.length).toBeGreaterThan(8);
    expectPointClose(first(pts), last(pts));
    // The periodic curve stays inside the control polygon and is symmetric about its centre.
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(20);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(20);
    }
    const radii = pts.map((p) => Math.hypot(p.x - 10, p.y - 10));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1.5);
  });

  it('never throws on bad data and returns the control polygon as a last resort', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 5, y: 5 };
    const c = { x: 10, y: 0 };
    expect(flattenSpline({ degree: 3, controlPoints: [], knots: [] }, TOL)).toEqual([]);
    expect(flattenSpline({ degree: 3, controlPoints: [a], knots: [] }, TOL)).toEqual([a]);
    // Degree is reduced to fit two control points: a straight line.
    const line = flattenSpline({ degree: 3, controlPoints: [a, b], knots: [] }, TOL);
    expectPointClose(first(line), a);
    expectPointClose(last(line), b);
    expect(maxDeviation(line, [a, b])).toBeLessThan(1e-9);
    // Bad degrees.
    for (const degree of [NaN, 0, -2, 99, Infinity]) {
      const pts = flattenSpline({ degree, controlPoints: [a, b, c], knots: [] }, TOL);
      expectAllFinite(pts);
      expectPointClose(first(pts), a);
      expectPointClose(last(pts), c);
    }
    // Non-finite control points are dropped.
    const dropped = flattenSpline({ degree: 2, controlPoints: [a, { x: NaN, y: 1 }, b, c], knots: [0, 0, 0, 0.5, 1, 1, 1] }, TOL);
    expectAllFinite(dropped);
    expectPointClose(first(dropped), a);
    expectPointClose(last(dropped), c);
    // Invalid weights are ignored.
    expectAllFinite(flattenSpline({ degree: 2, controlPoints: [a, b, c], knots: [0, 0, 0, 1, 1, 1], weights: [1, 0, 1] }, TOL));
    expectAllFinite(flattenSpline({ degree: 2, controlPoints: [a, b, c], knots: [0, 0, 0, 1, 1, 1], weights: [1, NaN] }, TOL));
    expectAllFinite(flattenSpline({ degree: 2, controlPoints: [a, b, c], knots: [0, 0, 0, 1, 1, 1] }, NaN));
    // Overflowing coordinates fall back to the control polygon.
    const huge = [a, { x: 1e308, y: 1e308 }, { x: -1e308, y: 1e308 }, c];
    expect(flattenSpline({ degree: 3, controlPoints: huge, knots: [0, 0, 0, 0, 1, 1, 1, 1], weights: [1, 1e300, 1e300, 1] }, TOL)).toEqual(huge);
  });

  it('bounds the output size for an absurd tolerance', () => {
    const pts = flattenSpline(nurbsCircle, 1e-12);
    expect(pts.length).toBeLessThanOrEqual(10000 + 8 * 2 + 1);
  });
});

describe('flattenFitPoints', () => {
  const fit = [
    { x: 0, y: 0 },
    { x: 10, y: 15 },
    { x: 30, y: 12 },
    { x: 35, y: -5 },
    { x: 60, y: 0 },
  ];

  function expectContains(points: readonly Point[], target: Point): void {
    const hit = points.some((p) => Math.hypot(p.x - target.x, p.y - target.y) < 1e-9);
    expect(hit).toBe(true);
  }

  it('passes through every fit point of an open curve', () => {
    const pts = flattenFitPoints(fit, false, TOL);
    expect(first(pts)).toEqual(fit[0]);
    expect(last(pts)).toEqual(fit[4]);
    for (const f of fit) expectContains(pts, f);
    expect(pts.length).toBeGreaterThan(20);
    expectAllFinite(pts);
  });

  it('is smooth: no sharp corners at the fit points', () => {
    const pts = flattenFitPoints(fit, false, 0.001);
    let worstTurn = 0;
    for (let i = 2; i < pts.length; i++) {
      const a = must(pts[i - 2]);
      const b = must(pts[i - 1]);
      const c = must(pts[i]);
      const turn = Math.abs(
        Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)),
      );
      worstTurn = Math.max(worstTurn, turn);
    }
    expect(worstTurn).toBeLessThan(0.1);
  });

  it('refines with a tighter tolerance and stays within the looser one', () => {
    const coarse = flattenFitPoints(fit, false, 0.1);
    const fine = flattenFitPoints(fit, false, 0.0005);
    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(maxDeviation(fine, coarse)).toBeLessThanOrEqual(0.1 + SLACK);
  });

  it('closes the loop and returns to the first point', () => {
    const pts = flattenFitPoints(fit, true, TOL);
    expect(first(pts)).toEqual(fit[0]);
    expect(last(pts)).toEqual(fit[0]);
    for (const f of fit) expectContains(pts, f);
    // The same loop given with the first point repeated at the end.
    const repeated = flattenFitPoints([...fit, { x: 0, y: 0 }], true, TOL);
    expect(repeated).toEqual(pts);
  });

  it('approximates a circle from fit points on it', () => {
    const ring: Point[] = [];
    for (let i = 0; i < 16; i++) ring.push(circlePoint({ x: 0, y: 0 }, 20, (i * Math.PI) / 8));
    const pts = flattenFitPoints(ring, true, 0.005);
    for (const p of pts) expect(Math.abs(Math.hypot(p.x, p.y) - 20)).toBeLessThan(0.05);
  });

  it('handles degenerate input', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 4, y: 6 };
    expect(flattenFitPoints([], false, TOL)).toEqual([]);
    expect(flattenFitPoints([a], true, TOL)).toEqual([a]);
    expect(flattenFitPoints([a, b], false, TOL)).toEqual([a, b]);
    expect(flattenFitPoints([a, b], true, TOL)).toEqual([a, b]);
    expect(flattenFitPoints([a, a, a], false, TOL)).toEqual([a]);
    expect(flattenFitPoints([a, { x: NaN, y: 0 }, b], false, TOL)).toEqual([a, b]);
    // Collinear points give a straight line.
    const straight = flattenFitPoints([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 }], false, TOL);
    for (const p of straight) expect(Math.abs(p.y)).toBeLessThan(1e-9);
    expectAllFinite(flattenFitPoints(fit, false, NaN));
  });
});
