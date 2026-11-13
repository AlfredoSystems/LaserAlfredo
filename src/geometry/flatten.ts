import type { Point } from '../model/types';
import { distanceToSegment } from './hit';

export const DEFAULT_FLATTEN_TOLERANCE_MM = 0.02;

/** Upper bound on segments produced for one curve, whatever the tolerance. */
const MAX_SEGMENTS = 10000;
/** A full circle never gets fewer segments than this. */
const MIN_CIRCLE_SEGMENTS = 12;
const TWO_PI = Math.PI * 2;
const ANGLE_EPS = 1e-12;
/** Deepest bisection of one initial spline piece (2^12 sub-pieces). */
const MAX_SPLINE_DEPTH = 12;
/**
 * Spline refinement accepts a piece when its sampled deviation is below this
 * fraction of the tolerance, which leaves headroom for the deviation between
 * the samples.
 */
const SPLINE_ACCEPT_FACTOR = 0.75;
const COINCIDENT_EPS = 1e-9;

function saneTolerance(toleranceMm: number): number {
  return Number.isFinite(toleranceMm) && toleranceMm > 0 ? toleranceMm : DEFAULT_FLATTEN_TOLERANCE_MM;
}

function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function num(values: ArrayLike<number>, i: number): number {
  return values[i] ?? 0;
}

function clampCount(n: number): number {
  if (!(n >= 1)) return 1;
  return n > MAX_SEGMENTS ? MAX_SEGMENTS : Math.ceil(n);
}

/** Segments needed so a circular arc of `radius` over `sweep` radians stays within tolerance. */
function arcSegmentCount(radius: number, sweep: number, toleranceMm: number): number {
  const absSweep = Math.abs(sweep);
  if (!(radius > 0) || !(absSweep > 0)) return 1;
  const tol = saneTolerance(toleranceMm);
  let step = TWO_PI / MIN_CIRCLE_SEGMENTS;
  if (tol < radius) step = Math.min(step, 2 * Math.acos(1 - tol / radius));
  if (!(step > 0)) return MAX_SEGMENTS;
  return clampCount(absSweep / step - 1e-9);
}

/** Sweep from `from` to `to` in the given direction; a whole number of turns counts as one full turn. */
function directedSweep(from: number, to: number, counterClockwise: boolean): number {
  const raw = counterClockwise ? to - from : from - to;
  let sweep = raw - TWO_PI * Math.floor(raw / TWO_PI);
  if (sweep < ANGLE_EPS || TWO_PI - sweep < ANGLE_EPS) {
    sweep = Math.abs(raw) > ANGLE_EPS ? TWO_PI : 0;
  }
  return counterClockwise ? sweep : -sweep;
}

/**
 * Circular arc in the plain math convention: point = center + r * (cos a, sin a),
 * with no axis flipping. `counterClockwise: true` sweeps with increasing angle.
 * Equal start and end angles give a zero-length arc (use `flattenCircle` for a
 * full circle); angles that differ by a whole number of turns give a full turn.
 */
export function flattenArc(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean,
  toleranceMm: number,
): Point[] {
  if (
    !isFinitePoint(center) ||
    !Number.isFinite(radius) ||
    !Number.isFinite(startAngle) ||
    !Number.isFinite(endAngle)
  ) {
    return [];
  }
  const r = Math.abs(radius);
  const at = (a: number): Point => ({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  const sweep = directedSweep(startAngle, endAngle, counterClockwise);
  const n = arcSegmentCount(r, sweep, toleranceMm);
  const points: Point[] = [at(startAngle)];
  for (let i = 1; i < n; i++) {
    points.push(at(startAngle + (sweep * i) / n));
  }
  points.push(at(endAngle));
  return points;
}

/** Full circle as a closed ring: the first point is not repeated at the end. */
export function flattenCircle(center: Point, radius: number, toleranceMm: number): Point[] {
  if (!isFinitePoint(center) || !Number.isFinite(radius) || radius === 0) return [];
  const r = Math.abs(radius);
  const n = Math.max(MIN_CIRCLE_SEGMENTS, arcSegmentCount(r, TWO_PI, toleranceMm));
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (TWO_PI * i) / n;
    points.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return points;
}

/**
 * DXF ELLIPSE: `majorAxis` is the major-axis endpoint relative to the centre,
 * the minor axis is the major axis rotated +90 degrees and scaled by `axisRatio`,
 * and point(t) = center + major * cos t + minor * sin t. Sweeps with increasing
 * t from `startParam` to `endParam` (a full turn is added when end <= start).
 * A full ellipse returns both its start and end point.
 */
export function flattenEllipse(
  center: Point,
  majorAxis: Point,
  axisRatio: number,
  startParam: number,
  endParam: number,
  toleranceMm: number,
): Point[] {
  if (
    !isFinitePoint(center) ||
    !isFinitePoint(majorAxis) ||
    !Number.isFinite(axisRatio) ||
    !Number.isFinite(startParam) ||
    !Number.isFinite(endParam)
  ) {
    return [];
  }
  const minorX = -majorAxis.y * axisRatio;
  const minorY = majorAxis.x * axisRatio;
  const at = (t: number): Point => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return { x: center.x + majorAxis.x * c + minorX * s, y: center.y + majorAxis.y * c + minorY * s };
  };
  let sweep = endParam - startParam;
  if (sweep <= 0 || sweep > TWO_PI) {
    sweep -= TWO_PI * Math.floor(sweep / TWO_PI);
    if (sweep < ANGLE_EPS) sweep = TWO_PI;
  }
  // An ellipse is an affine image of the unit circle, so the chord error is at
  // most the circle's chord error times the larger semi-axis.
  const major = Math.hypot(majorAxis.x, majorAxis.y);
  const n = arcSegmentCount(Math.max(major, major * Math.abs(axisRatio)), sweep, toleranceMm);
  const points: Point[] = [at(startParam)];
  for (let i = 1; i < n; i++) {
    points.push(at(startParam + (sweep * i) / n));
  }
  points.push(at(startParam + sweep));
  return points;
}

/**
 * DXF LWPOLYLINE bulge segment. `bulge` is the tangent of a quarter of the
 * included angle; positive sweeps with increasing angle (counter-clockwise in a
 * Y-up system). The math is done in the coordinates given, with no flipping.
 */
export function flattenBulge(start: Point, end: Point, bulge: number, toleranceMm: number): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(bulge) || bulge === 0 || !Number.isFinite(chord) || chord === 0) {
    return [start, end];
  }
  const sweep = 4 * Math.atan(bulge);
  // Signed distance from the chord midpoint to the centre along the left normal.
  const offset = (1 - bulge * bulge) / (4 * bulge);
  const cx = (start.x + end.x) / 2 - dy * offset;
  const cy = (start.y + end.y) / 2 + dx * offset;
  const radius = Math.hypot(start.x - cx, start.y - cy);
  if (!Number.isFinite(radius) || !Number.isFinite(cx) || !Number.isFinite(cy)) return [start, end];
  const startAngle = Math.atan2(start.y - cy, start.x - cx);
  const n = arcSegmentCount(radius, sweep, toleranceMm);
  const points: Point[] = [start];
  for (let i = 1; i < n; i++) {
    const a = startAngle + (sweep * i) / n;
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  points.push(end);
  return points;
}

/**
 * Uniform segment count for a polynomial curve on t in [0, 1] whose second
 * derivative is bounded by `maxSecondDerivative`: the chord error of a step h
 * is at most h^2 / 8 * max|B''|.
 */
function curveSegmentCount(maxSecondDerivative: number, toleranceMm: number): number {
  if (!Number.isFinite(maxSecondDerivative)) return MAX_SEGMENTS;
  return clampCount(Math.sqrt(maxSecondDerivative / (8 * saneTolerance(toleranceMm))) - 1e-9);
}

export function flattenQuadratic(p0: Point, p1: Point, p2: Point, toleranceMm: number): Point[] {
  if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p2)) {
    return [p0, p2].filter(isFinitePoint);
  }
  const ddx = p0.x - 2 * p1.x + p2.x;
  const ddy = p0.y - 2 * p1.y + p2.y;
  const n = curveSegmentCount(2 * Math.hypot(ddx, ddy), toleranceMm);
  const points: Point[] = [p0];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    points.push({ x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y });
  }
  points.push(p2);
  return points;
}

export function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, toleranceMm: number): Point[] {
  if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p2) || !isFinitePoint(p3)) {
    return [p0, p3].filter(isFinitePoint);
  }
  const d1 = Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y);
  const d2 = Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y);
  const n = curveSegmentCount(6 * Math.max(d1, d2), toleranceMm);
  const points: Point[] = [p0];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  points.push(p3);
  return points;
}

/**
 * SVG path `A` command, using the endpoint-to-centre conversion from the SVG
 * spec (including scaling up radii that are too small). A zero radius or
 * coincident endpoints give a straight line.
 */
export function flattenSvgArc(
  start: Point,
  rx: number,
  ry: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  end: Point,
  toleranceMm: number,
): Point[] {
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  if (
    !isFinitePoint(start) ||
    !isFinitePoint(end) ||
    !Number.isFinite(radiusX) ||
    !Number.isFinite(radiusY) ||
    radiusX === 0 ||
    radiusY === 0 ||
    (start.x === end.x && start.y === end.y)
  ) {
    return [start, end];
  }
  const phi = Number.isFinite(xAxisRotationDeg) ? (xAxisRotationDeg * Math.PI) / 180 : 0;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const halfDx = (start.x - end.x) / 2;
  const halfDy = (start.y - end.y) / 2;
  const x1p = cosPhi * halfDx + sinPhi * halfDy;
  const y1p = -sinPhi * halfDx + cosPhi * halfDy;

  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }
  const rx2 = radiusX * radiusX;
  const ry2 = radiusY * radiusY;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  if (!(denominator > 0)) return [start, end];
  const coefficient =
    Math.sqrt(Math.max(0, (rx2 * ry2 - denominator) / denominator)) * (largeArc !== sweep ? 1 : -1);
  const cxp = (coefficient * radiusX * y1p) / radiusY;
  const cyp = (-coefficient * radiusY * x1p) / radiusX;
  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const theta1 = Math.atan2((y1p - cyp) / radiusY, (x1p - cxp) / radiusX);
  const theta2 = Math.atan2((-y1p - cyp) / radiusY, (-x1p - cxp) / radiusX);
  let delta = theta2 - theta1;
  if (sweep && delta < 0) delta += TWO_PI;
  else if (!sweep && delta > 0) delta -= TWO_PI;
  if (!Number.isFinite(delta) || !Number.isFinite(cx) || !Number.isFinite(cy)) return [start, end];

  const n = arcSegmentCount(Math.max(radiusX, radiusY), delta, toleranceMm);
  const points: Point[] = [start];
  for (let i = 1; i < n; i++) {
    const t = theta1 + (delta * i) / n;
    const ex = radiusX * Math.cos(t);
    const ey = radiusY * Math.sin(t);
    points.push({ x: cx + cosPhi * ex - sinPhi * ey, y: cy + sinPhi * ex + cosPhi * ey });
  }
  points.push(end);
  return points;
}

function clampedUniformKnots(count: number, degree: number): number[] {
  const knots: number[] = [];
  const spans = count - degree;
  for (let i = 0; i < count + degree + 1; i++) {
    if (i <= degree) knots.push(0);
    else if (i >= count) knots.push(1);
    else knots.push((i - degree) / spans);
  }
  return knots;
}

function knotsAreValid(knots: readonly number[], count: number, degree: number): boolean {
  if (knots.length !== count + degree + 1) return false;
  let prev = -Infinity;
  for (const k of knots) {
    if (!Number.isFinite(k) || k < prev) return false;
    prev = k;
  }
  return num(knots, degree) < num(knots, count);
}

function weightsAreValid(weights: readonly number[] | undefined, count: number): weights is readonly number[] {
  if (weights === undefined || weights.length !== count) return false;
  return weights.every((w) => Number.isFinite(w) && w > 0);
}

/**
 * NURBS curve by de Boor evaluation (rational when valid weights are given)
 * over the knot domain [knots[degree], knots[controlPoints.length]]. Missing or
 * inconsistent knots fall back to a clamped uniform knot vector, or to a
 * periodic uniform one when `closed` is set. With valid knots the curve is
 * evaluated as given and `closed` has no effect. The result always includes
 * both the start and end point (they coincide for a closed curve); the caller
 * decides closure. Never throws: bad data yields the control polygon.
 */
export function flattenSpline(
  input: {
    degree: number;
    controlPoints: readonly Point[];
    knots: readonly number[];
    weights?: readonly number[];
    closed?: boolean;
  },
  toleranceMm: number,
): Point[] {
  const rawControl = Array.isArray(input.controlPoints) ? (input.controlPoints as readonly Point[]) : [];
  let control = rawControl.filter(isFinitePoint);
  const allFinite = control.length === rawControl.length;
  const fallback = (): Point[] => {
    const polygon = control.slice();
    const first = polygon[0];
    if (input.closed === true && polygon.length > 2 && first !== undefined) polygon.push(first);
    return polygon;
  };
  if (control.length < 2) return fallback();

  const originalCount = control.length;
  let degree =
    Number.isFinite(input.degree) && input.degree >= 1 ? Math.floor(input.degree) : Math.min(3, originalCount - 1);
  if (degree > originalCount - 1) degree = originalCount - 1;

  let weights: readonly number[] | null =
    allFinite && weightsAreValid(input.weights, originalCount) ? input.weights : null;
  let knots: readonly number[];
  const givenKnots: readonly number[] = Array.isArray(input.knots) ? (input.knots as readonly number[]) : [];
  if (allFinite && knotsAreValid(givenKnots, originalCount, degree)) {
    knots = givenKnots;
  } else if (input.closed === true && originalCount > degree) {
    // Periodic uniform B-spline: wrap the first `degree` control points.
    control = control.concat(control.slice(0, degree));
    if (weights !== null) weights = weights.concat(weights.slice(0, degree));
    const periodic: number[] = [];
    for (let i = 0; i < control.length + degree + 1; i++) periodic.push(i);
    knots = periodic;
  } else {
    knots = clampedUniformKnots(originalCount, degree);
  }

  const count = control.length;
  const hx = new Float64Array(count);
  const hy = new Float64Array(count);
  const hw = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const p = control[i];
    if (p === undefined) continue;
    const w = weights === null ? 1 : num(weights, i);
    hx[i] = p.x * w;
    hy[i] = p.y * w;
    hw[i] = w;
  }
  const dx = new Float64Array(degree + 1);
  const dy = new Float64Array(degree + 1);
  const dw = new Float64Array(degree + 1);

  /** de Boor in homogeneous coordinates; `u` must lie in knot span `k`. */
  const evaluate = (k: number, u: number): Point => {
    for (let j = 0; j <= degree; j++) {
      const i = j + k - degree;
      dx[j] = num(hx, i);
      dy[j] = num(hy, i);
      dw[j] = num(hw, i);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = j + k - degree;
        const low = num(knots, i);
        const span = num(knots, i + degree - r + 1) - low;
        const alpha = span > 0 ? (u - low) / span : 0;
        dx[j] = (1 - alpha) * num(dx, j - 1) + alpha * num(dx, j);
        dy[j] = (1 - alpha) * num(dy, j - 1) + alpha * num(dy, j);
        dw[j] = (1 - alpha) * num(dw, j - 1) + alpha * num(dw, j);
      }
    }
    const w = num(dw, degree);
    return { x: num(dx, degree) / w, y: num(dy, degree) / w };
  };

  const limit = saneTolerance(toleranceMm) * SPLINE_ACCEPT_FACTOR;
  let budget = MAX_SEGMENTS;
  const out: Point[] = [];

  const refine = (k: number, ua: number, pa: Point, ub: number, pb: Point, depth: number): void => {
    if (depth < MAX_SPLINE_DEPTH && budget > 0) {
      const um = (ua + ub) / 2;
      const pm = evaluate(k, um);
      const deviation = Math.max(
        distanceToSegment(pm, pa, pb),
        distanceToSegment(evaluate(k, (ua + um) / 2), pa, pb),
        distanceToSegment(evaluate(k, (um + ub) / 2), pa, pb),
      );
      // A NaN deviation falls through and is caught by the final finite check.
      if (deviation > limit) {
        budget -= 1;
        refine(k, ua, pa, um, pm, depth + 1);
        refine(k, um, pm, ub, pb, depth + 1);
        return;
      }
    }
    out.push(pb);
  };

  const pieces = Math.max(2, degree);
  for (let k = degree; k < count; k++) {
    const u0 = num(knots, k);
    const u1 = num(knots, k + 1);
    if (!(u1 > u0)) continue;
    let ua = u0;
    let pa = evaluate(k, u0);
    if (out.length === 0) out.push(pa);
    for (let i = 1; i <= pieces; i++) {
      const ub = i === pieces ? u1 : u0 + ((u1 - u0) * i) / pieces;
      const pb = evaluate(k, ub);
      refine(k, ua, pa, ub, pb, 0);
      ua = ub;
      pa = pb;
    }
  }

  if (out.length < 2 || !out.every(isFinitePoint)) return fallback();
  return out;
}

/**
 * Smooth curve through every fit point (centripetal Catmull-Rom), for DXF
 * splines that only carry fit points. A closed curve returns to its first
 * point, so the result includes both the start and end point; the caller
 * decides closure.
 */
export function flattenFitPoints(fitPoints: readonly Point[], closed: boolean, toleranceMm: number): Point[] {
  const pts: Point[] = [];
  for (const p of fitPoints) {
    if (!isFinitePoint(p)) continue;
    const last = pts[pts.length - 1];
    if (last !== undefined && Math.hypot(p.x - last.x, p.y - last.y) <= COINCIDENT_EPS) continue;
    pts.push(p);
  }
  const loop = closed;
  if (loop && pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (
      first !== undefined &&
      last !== undefined &&
      Math.hypot(first.x - last.x, first.y - last.y) <= COINCIDENT_EPS
    ) {
      pts.pop();
    }
  }
  const count = pts.length;
  if (count < 3) return pts;

  const get = (i: number): Point | undefined => (loop ? pts[((i % count) + count) % count] : pts[i]);
  const out: Point[] = [];
  const segments = loop ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const p1 = get(i);
    const p2 = get(i + 1);
    if (p1 === undefined || p2 === undefined) continue;
    // Open ends use a reflected neighbour, which gives a straight-ish run-out.
    const p0 = get(i - 1) ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = get(i + 2) ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d3 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const s1 = Math.sqrt(d1);
    const s2 = Math.sqrt(d2);
    const s3 = Math.sqrt(d3);
    // Centripetal Catmull-Rom segment expressed as a cubic Bezier.
    let b1 = p1;
    if (d1 > 0) {
      const k = 3 * s1 * (s1 + s2);
      const m = 2 * d1 + 3 * s1 * s2 + d2;
      b1 = { x: (d1 * p2.x - d2 * p0.x + m * p1.x) / k, y: (d1 * p2.y - d2 * p0.y + m * p1.y) / k };
    }
    let b2 = p2;
    if (d3 > 0) {
      const k = 3 * s3 * (s3 + s2);
      const m = 2 * d3 + 3 * s3 * s2 + d2;
      b2 = { x: (d3 * p1.x - d2 * p3.x + m * p2.x) / k, y: (d3 * p1.y - d2 * p3.y + m * p2.y) / k };
    }
    const piece = flattenCubic(p1, b1, b2, p2, toleranceMm);
    for (let j = out.length === 0 ? 0 : 1; j < piece.length; j++) {
      const p = piece[j];
      if (p !== undefined) out.push(p);
    }
  }
  return out;
}
