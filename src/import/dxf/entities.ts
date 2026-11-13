import {
  flattenArc,
  flattenBulge,
  flattenCircle,
  flattenEllipse,
  flattenFitPoints,
  flattenSpline,
} from '../../geometry/flatten';
import type { Point } from '../../model/types';
import type { RawEntity } from './parse';

/**
 * Turns one raw DXF entity into flattened paths in the entity's own
 * coordinates (DXF units, Y up). Placement, mirroring, unit conversion and the
 * Y flip all happen later, in `index.ts`.
 */

export interface LocalPath {
  readonly points: Point[];
  readonly closed: boolean;
}

/** Properties every entity can carry. */
export interface EntityCommon {
  readonly layer: string;
  /** Group 62, or undefined when absent (which means BYLAYER). */
  readonly aci: number | undefined;
  /** Group 420. */
  readonly trueColor: number | undefined;
  readonly paperSpace: boolean;
  /** Extrusion direction points down the Z axis: the entity's X axis is mirrored. */
  readonly mirrored: boolean;
  /** Extrusion direction is not along Z at all: the entity lies in a tilted plane. */
  readonly tilted: boolean;
}

export interface InsertParams {
  readonly blockName: string;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationRad: number;
  readonly columns: number;
  readonly rows: number;
  readonly columnSpacing: number;
  readonly rowSpacing: number;
}

const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const EXTRUSION_EPS = 1e-6;
const FULL_TURN_EPS = 1e-9;

// POLYLINE flags (group 70).
const POLYLINE_CLOSED = 1;
const POLYLINE_3D_MESH = 16;
const POLYLINE_POLYFACE = 64;
// VERTEX flags (group 70).
const VERTEX_SPLINE_FRAME = 16;
// SPLINE flags (group 70).
const SPLINE_CLOSED = 1;
const SPLINE_PERIODIC = 2;

function numberAt(entity: RawEntity, index: number): number {
  const value = entity.values[index];
  return typeof value === 'number' ? value : Number.NaN;
}

function stringAt(entity: RawEntity, index: number): string {
  const value = entity.values[index];
  return typeof value === 'string' ? value : String(value ?? '');
}

/** First value of each requested group code, or the fallback where the code is absent. */
function firstNumbers(entity: RawEntity, wanted: readonly number[], fallbacks: readonly number[]): number[] {
  const result = fallbacks.slice();
  const found = wanted.map(() => false);
  const codes = entity.codes;
  for (let i = 0; i < codes.length; i++) {
    const slot = wanted.indexOf(codes[i] ?? -1);
    if (slot < 0 || found[slot] === true) continue;
    found[slot] = true;
    result[slot] = numberAt(entity, i);
  }
  return result;
}

export function readCommon(entity: RawEntity): EntityCommon {
  let layer: string | undefined;
  let aci: number | undefined;
  let trueColor: number | undefined;
  let paperSpace = false;
  let extX: number | undefined;
  let extY: number | undefined;
  let extZ: number | undefined;
  const codes = entity.codes;
  for (let i = 0; i < codes.length; i++) {
    switch (codes[i]) {
      case 8:
        layer ??= stringAt(entity, i);
        break;
      case 62:
        aci ??= numberAt(entity, i);
        break;
      case 420:
        trueColor ??= numberAt(entity, i);
        break;
      case 67:
        if (numberAt(entity, i) === 1) paperSpace = true;
        break;
      case 210:
        extX ??= numberAt(entity, i);
        break;
      case 220:
        extY ??= numberAt(entity, i);
        break;
      case 230:
        extZ ??= numberAt(entity, i);
        break;
      default:
        break;
    }
  }
  const tilted = Math.abs(extX ?? 0) > EXTRUSION_EPS || Math.abs(extY ?? 0) > EXTRUSION_EPS;
  return {
    layer: layer ?? '0',
    aci: aci !== undefined && Number.isFinite(aci) ? aci : undefined,
    trueColor: trueColor !== undefined && Number.isFinite(trueColor) ? trueColor : undefined,
    paperSpace,
    mirrored: !tilted && (extZ ?? 1) < 0,
    tilted,
  };
}

export function flattenLine(entity: RawEntity): LocalPath[] {
  const [x1, y1, x2, y2] = firstNumbers(entity, [10, 20, 11, 21], [Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
  return [
    {
      points: [
        { x: x1 ?? Number.NaN, y: y1 ?? Number.NaN },
        { x: x2 ?? Number.NaN, y: y2 ?? Number.NaN },
      ],
      closed: false,
    },
  ];
}

export function flattenArcEntity(entity: RawEntity, toleranceLocal: number): LocalPath[] {
  const [cx, cy, radius, startDeg, endDeg] = firstNumbers(
    entity,
    [10, 20, 40, 50, 51],
    [Number.NaN, Number.NaN, Number.NaN, 0, 360],
  );
  const points = flattenArc(
    { x: cx ?? Number.NaN, y: cy ?? Number.NaN },
    radius ?? Number.NaN,
    (startDeg ?? 0) * DEG_TO_RAD,
    (endDeg ?? 360) * DEG_TO_RAD,
    true,
    toleranceLocal,
  );
  return [{ points, closed: false }];
}

export function flattenCircleEntity(entity: RawEntity, toleranceLocal: number): LocalPath[] {
  const [cx, cy, radius] = firstNumbers(entity, [10, 20, 40], [Number.NaN, Number.NaN, Number.NaN]);
  const points = flattenCircle({ x: cx ?? Number.NaN, y: cy ?? Number.NaN }, radius ?? Number.NaN, toleranceLocal);
  return [{ points, closed: true }];
}

/**
 * ELLIPSE centre and major axis are world coordinates; the extrusion direction
 * only decides which way the minor axis points, so a mirrored ellipse just
 * gets its axis ratio negated.
 */
export function flattenEllipseEntity(entity: RawEntity, mirrored: boolean, toleranceLocal: number): LocalPath[] {
  const [cx, cy, mx, my, ratio, start, end] = firstNumbers(
    entity,
    [10, 20, 11, 21, 40, 41, 42],
    [Number.NaN, Number.NaN, Number.NaN, Number.NaN, 1, 0, TWO_PI],
  );
  const startParam = start ?? 0;
  const endParam = end ?? TWO_PI;
  const signedRatio = mirrored ? -(ratio ?? 1) : (ratio ?? 1);
  const points = flattenEllipse(
    { x: cx ?? Number.NaN, y: cy ?? Number.NaN },
    { x: mx ?? Number.NaN, y: my ?? Number.NaN },
    signedRatio,
    startParam,
    endParam,
    toleranceLocal,
  );
  const raw = endParam - startParam;
  const sweep = raw - TWO_PI * Math.floor(raw / TWO_PI);
  const full = sweep < FULL_TURN_EPS || TWO_PI - sweep < FULL_TURN_EPS;
  if (full && points.length > 3) {
    points.pop();
    return [{ points, closed: true }];
  }
  return [{ points, closed: false }];
}

/** Vertices joined by straight or bulged segments, shared by LWPOLYLINE and POLYLINE. */
function buildPolyline(
  xs: readonly number[],
  ys: readonly number[],
  bulges: readonly number[],
  closed: boolean,
  toleranceLocal: number,
): LocalPath[] {
  const count = xs.length;
  if (count < 2) return [];
  const vertex = (i: number): Point => ({ x: xs[i] ?? Number.NaN, y: ys[i] ?? Number.NaN });
  const points: Point[] = [vertex(0)];
  const segments = closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const end = vertex((i + 1) % count);
    const bulge = bulges[i] ?? 0;
    if (bulge === 0 || !Number.isFinite(bulge)) {
      points.push(end);
      continue;
    }
    const arc = flattenBulge(vertex(i), end, bulge, toleranceLocal);
    for (let j = 1; j < arc.length; j++) {
      const p = arc[j];
      if (p !== undefined) points.push(p);
    }
  }
  // The closing segment ends on the first vertex again.
  if (closed) points.pop();
  return [{ points, closed }];
}

export function flattenLwPolyline(entity: RawEntity, toleranceLocal: number): LocalPath[] {
  const xs: number[] = [];
  const ys: number[] = [];
  const bulges: number[] = [];
  let flags = 0;
  const codes = entity.codes;
  for (let i = 0; i < codes.length; i++) {
    const last = xs.length - 1;
    switch (codes[i]) {
      case 10:
        xs.push(numberAt(entity, i));
        ys.push(Number.NaN);
        bulges.push(0);
        break;
      case 20:
        if (last >= 0) ys[last] = numberAt(entity, i);
        break;
      case 42:
        if (last >= 0) bulges[last] = numberAt(entity, i);
        break;
      case 70:
        flags = numberAt(entity, i);
        break;
      default:
        break;
    }
  }
  return buildPolyline(xs, ys, bulges, (flags & POLYLINE_CLOSED) !== 0, toleranceLocal);
}

/** True for the POLYLINE variants that are surfaces rather than outlines. */
export function isPolylineMesh(entity: RawEntity): boolean {
  const [flags] = firstNumbers(entity, [70], [0]);
  return ((flags ?? 0) & (POLYLINE_3D_MESH | POLYLINE_POLYFACE)) !== 0;
}

/** Old-style 2D POLYLINE (a 3D polyline is projected onto the XY plane). */
export function flattenPolyline(entity: RawEntity, toleranceLocal: number): LocalPath[] {
  const [flags] = firstNumbers(entity, [70], [0]);
  const xs: number[] = [];
  const ys: number[] = [];
  const bulges: number[] = [];
  for (const vertex of entity.vertices) {
    const [x, y, bulge, vertexFlags] = firstNumbers(vertex, [10, 20, 42, 70], [Number.NaN, Number.NaN, 0, 0]);
    // Control points of a spline-fit polyline are not on the curve.
    if (((vertexFlags ?? 0) & VERTEX_SPLINE_FRAME) !== 0) continue;
    xs.push(x ?? Number.NaN);
    ys.push(y ?? Number.NaN);
    bulges.push(bulge ?? 0);
  }
  return buildPolyline(xs, ys, bulges, ((flags ?? 0) & POLYLINE_CLOSED) !== 0, toleranceLocal);
}

export function flattenSplineEntity(entity: RawEntity, toleranceLocal: number): LocalPath[] {
  const controlPoints: { x: number; y: number }[] = [];
  const fitPoints: { x: number; y: number }[] = [];
  const knots: number[] = [];
  const weights: number[] = [];
  let flags = 0;
  let degree = 3;
  const codes = entity.codes;
  for (let i = 0; i < codes.length; i++) {
    switch (codes[i]) {
      case 10:
        controlPoints.push({ x: numberAt(entity, i), y: Number.NaN });
        break;
      case 20: {
        const last = controlPoints[controlPoints.length - 1];
        if (last !== undefined) last.y = numberAt(entity, i);
        break;
      }
      case 11:
        fitPoints.push({ x: numberAt(entity, i), y: Number.NaN });
        break;
      case 21: {
        const last = fitPoints[fitPoints.length - 1];
        if (last !== undefined) last.y = numberAt(entity, i);
        break;
      }
      case 40:
        knots.push(numberAt(entity, i));
        break;
      case 41:
        weights.push(numberAt(entity, i));
        break;
      case 70:
        flags = numberAt(entity, i);
        break;
      case 71:
        degree = numberAt(entity, i);
        break;
      default:
        break;
    }
  }
  const closedFlag = (flags & (SPLINE_CLOSED | SPLINE_PERIODIC)) !== 0;

  let points: Point[];
  if (controlPoints.length >= 2) {
    points = flattenSpline(
      {
        degree,
        controlPoints,
        knots,
        ...(weights.length === controlPoints.length ? { weights } : {}),
        closed: closedFlag,
      },
      toleranceLocal,
    );
  } else if (fitPoints.length >= 2) {
    points = flattenFitPoints(fitPoints, closedFlag, toleranceLocal);
  } else {
    return [];
  }

  // The flatteners return both ends; a closed curve ends where it started.
  const first = points[0];
  const last = points[points.length - 1];
  if (
    closedFlag &&
    points.length > 3 &&
    first !== undefined &&
    last !== undefined &&
    Math.hypot(first.x - last.x, first.y - last.y) <= toleranceLocal
  ) {
    points.pop();
    return [{ points, closed: true }];
  }
  return [{ points, closed: false }];
}

export function readInsert(entity: RawEntity): InsertParams {
  let blockName = '';
  const codes = entity.codes;
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === 2) {
      blockName = stringAt(entity, i);
      break;
    }
  }
  const [x, y, scaleX, scaleY, rotationDeg, columns, rows, columnSpacing, rowSpacing] = firstNumbers(
    entity,
    [10, 20, 41, 42, 50, 70, 71, 44, 45],
    [0, 0, 1, 1, 0, 1, 1, 0, 0],
  );
  const count = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  return {
    blockName,
    x: x ?? 0,
    y: y ?? 0,
    scaleX: scaleX ?? 1,
    scaleY: scaleY ?? 1,
    rotationRad: (rotationDeg ?? 0) * DEG_TO_RAD,
    columns: count(columns),
    rows: count(rows),
    columnSpacing: columnSpacing ?? 0,
    rowSpacing: rowSpacing ?? 0,
  };
}
