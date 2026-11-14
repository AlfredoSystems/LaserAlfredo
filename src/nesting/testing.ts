import { EndType, FillRule, JoinType, difference, inflatePaths, intersect, union } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import { applyToPoints } from '../model/transform';
import type { Point } from '../model/types';
import { placementMatrix } from './placement';
import type { NestInput, NestPart, NestResult } from './types';

/**
 * Test support: shape builders and a layout checker that shares no code with
 * the engine. It measures the true part outlines, moved by `placementMatrix`.
 */

const SCALE = 10000;
/** Slack allowed on distances, in mm. */
const EPS_MM = 0.001;

export function rectangle(width: number, height: number, x = 0, y = 0): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function circle(radius: number, segments = 48, cx = 0, cy = 0): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return points;
}

/** An L: a `width` x `height` rectangle with its top-right `width - leg` x `height - leg` corner removed. */
export function lShape(width: number, height: number, leg: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: leg, y: 0 },
    { x: leg, y: height - leg },
    { x: width, y: height - leg },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

export function part(id: string, outline: Point[], extra: Partial<NestPart> = {}): NestPart {
  return { id, outline, closed: true, holes: [], quantity: 1, canRotate: true, ...extra };
}

function toPath(points: readonly Point[]): Path64 {
  return points.map((p) => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));
}

function areaOf(paths: Paths64): number {
  let total = 0;
  for (const path of paths) {
    let sum = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      if (a !== undefined && b !== undefined) sum += a.x * b.y - b.x * a.y;
    }
    total += sum / 2;
  }
  return Math.abs(total) / (SCALE * SCALE);
}

function finite(points: readonly Point[]): Point[] {
  return points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** The material of a placed part grown by `growMm` (shrunk when negative), with round corners. */
function grownMaterial(source: NestPart, outline: Point[], holes: Point[][], useHoles: boolean, growMm: number): Paths64 {
  const grow = growMm * SCALE;
  const arc = 0.0005 * SCALE;
  if (!source.closed || outline.length < 3) {
    if (outline.length === 0) return [];
    return inflatePaths([toPath(outline)], Math.max(grow, 1), JoinType.Round, EndType.Round, 2, arc);
  }
  let material = union([toPath(outline)], FillRule.NonZero);
  if (useHoles && holes.length > 0) {
    const cut = union(
      holes.filter((hole) => hole.length >= 3).map(toPath),
      FillRule.NonZero,
    );
    material = difference(material, cut, FillRule.NonZero);
  }
  if (material.length === 0) {
    return inflatePaths([toPath(outline)], Math.max(grow, 1), JoinType.Round, EndType.Round, 2, arc);
  }
  return grow === 0 ? material : inflatePaths(material, grow, JoinType.Round, EndType.Polygon, 2, arc);
}

/** Returns every rule the result breaks; an empty list means the layout is valid. */
export function validateNest(input: NestInput, result: NestResult): string[] {
  const errors: string[] = [];
  const { options } = input;
  const byId = new Map(input.parts.map((p) => [p.id, p]));
  const wanted = (p: NestPart): number => (Number.isFinite(p.quantity) ? Math.max(0, Math.floor(p.quantity)) : 0);

  // (c) Every copy is placed exactly once or reported as unplaced.
  const placedCopies = new Map<string, Set<number>>();
  let placedTotal = 0;
  for (const sheet of result.sheets) {
    for (const placement of sheet.placements) {
      placedTotal += 1;
      const source = byId.get(placement.partId);
      if (source === undefined) {
        errors.push(`unknown part ${placement.partId}`);
        continue;
      }
      const copies = placedCopies.get(placement.partId) ?? new Set<number>();
      placedCopies.set(placement.partId, copies);
      if (copies.has(placement.copy)) errors.push(`${placement.partId} copy ${placement.copy} placed twice`);
      if (!Number.isInteger(placement.copy) || placement.copy < 0 || placement.copy >= wanted(source)) {
        errors.push(`${placement.partId} has bad copy number ${placement.copy}`);
      }
      copies.add(placement.copy);

      // (d) Only allowed rotations.
      const step = source.canRotate && options.rotationStepDeg > 0 ? options.rotationStepDeg : 0;
      const turn = placement.rotationDeg;
      if (step === 0) {
        if (turn !== 0) errors.push(`${placement.partId} turned by ${turn} but may not rotate`);
      } else {
        const multiple = turn / step;
        if (turn < 0 || turn >= 360 || Math.abs(multiple - Math.round(multiple)) > 1e-9) {
          errors.push(`${placement.partId} turned by ${turn}, not a multiple of ${step}`);
        }
      }
    }
  }
  const unplaced = new Map<string, number>();
  for (const entry of result.unplaced) {
    if (unplaced.has(entry.partId)) errors.push(`${entry.partId} listed as unplaced twice`);
    unplaced.set(entry.partId, entry.count);
    if (entry.count <= 0) errors.push(`${entry.partId} unplaced count ${entry.count}`);
  }
  for (const source of input.parts) {
    const placed = placedCopies.get(source.id)?.size ?? 0;
    const missing = unplaced.get(source.id) ?? 0;
    if (placed + missing !== wanted(source)) {
      errors.push(`${source.id}: ${placed} placed + ${missing} unplaced, wanted ${wanted(source)}`);
    }
  }
  if (result.placedCount !== placedTotal) errors.push(`placedCount ${result.placedCount}, counted ${placedTotal}`);
  if (!Number.isFinite(result.fitness)) errors.push('fitness is not finite');
  if (!(result.utilization >= 0 && result.utilization <= 1)) errors.push(`utilization ${result.utilization}`);

  const half = options.spacingMm / 2 - EPS_MM;
  result.sheets.forEach((sheet, s) => {
    if (sheet.placements.length === 0) errors.push(`sheet ${s} is empty`);
    const grown: { name: string; paths: Paths64; minX: number; minY: number; maxX: number; maxY: number }[] = [];
    let right = 0;
    for (const placement of sheet.placements) {
      const source = byId.get(placement.partId);
      if (source === undefined) continue;
      const matrix = placementMatrix(placement);
      const outline = applyToPoints(matrix, finite(source.outline));
      const holes = source.holes.map((hole) => applyToPoints(matrix, finite(hole)));
      const name = `${placement.partId}#${placement.copy}`;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of outline) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      // (a) Inside the margin.
      const m = options.marginMm;
      if (
        minX < m - 1e-6 ||
        minY < m - 1e-6 ||
        maxX > options.sheetWidthMm - m + 1e-6 ||
        maxY > options.sheetHeightMm - m + 1e-6
      ) {
        errors.push(`sheet ${s}: ${name} crosses the margin (${minX}, ${minY}, ${maxX}, ${maxY})`);
      }
      right = Math.max(right, maxX);
      grown.push({
        name,
        paths: grownMaterial(source, outline, holes, options.useHoles, half),
        minX: minX - options.spacingMm,
        minY: minY - options.spacingMm,
        maxX: maxX + options.spacingMm,
        maxY: maxY + options.spacingMm,
      });
    }
    if (Math.abs(right - sheet.usedLengthMm) > 1e-6) {
      errors.push(`sheet ${s}: usedLengthMm ${sheet.usedLengthMm}, measured ${right}`);
    }
    // (b) No two parts closer than the spacing.
    for (let i = 0; i < grown.length; i++) {
      for (let j = i + 1; j < grown.length; j++) {
        const a = grown[i];
        const b = grown[j];
        if (a === undefined || b === undefined) continue;
        if (a.minX > b.maxX || b.minX > a.maxX || a.minY > b.maxY || b.minY > a.maxY) continue;
        const overlap = areaOf(intersect(a.paths, b.paths, FillRule.NonZero));
        if (overlap > 1e-6) errors.push(`sheet ${s}: ${a.name} and ${b.name} are too close (overlap ${overlap} mm²)`);
      }
    }
  });
  return errors;
}

/** Sum of the outline areas of the placed parts, in mm². */
export function placedArea(input: NestInput, result: NestResult): number {
  const byId = new Map(input.parts.map((p) => [p.id, p]));
  let total = 0;
  for (const sheet of result.sheets) {
    for (const placement of sheet.placements) {
      const source = byId.get(placement.partId);
      if (source !== undefined && source.closed) total += areaOf([toPath(finite(source.outline))]);
    }
  }
  return total;
}
