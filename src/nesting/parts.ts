import { boundsOfPoints } from '../geometry/bounds';
import { containmentParents } from '../geometry/containment';
import { applyToPoints } from '../model/transform';
import type { Point, Shape } from '../model/types';
import { placementMatrix } from './placement';
import type { NestPart, NestSheet } from './types';

/** Document shapes that are cut out, and move, as one piece. */
export interface PartGroup {
  /** The outer shape's id, so the part keeps its identity while the document is unchanged. */
  readonly id: string;
  /** The outer shape first, then everything inside it in document order. */
  readonly shapeIds: readonly string[];
  readonly outline: readonly Point[];
  /** False for a loose open path that belongs to no closed contour. */
  readonly closed: boolean;
  /** Closed shapes directly inside the outline with nothing inside them. */
  readonly holes: readonly (readonly Point[])[];
  /** Size of the outline's bounding box. */
  readonly widthMm: number;
  readonly heightMm: number;
}

/** What the user chose for one part. */
export interface PartSetting {
  readonly quantity: number;
  readonly canRotate: boolean;
}

export const DEFAULT_PART_SETTING: PartSetting = { quantity: 1, canRotate: true };

export const MAX_PART_QUANTITY = 999;

/** Whole copies between 0 and the maximum; anything unusable counts as 0. */
export function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.min(MAX_PART_QUANTITY, Math.max(0, Math.round(quantity)));
}

/**
 * Groups shapes into parts: every top-level shape becomes a part and takes
 * along all the shapes inside it (holes, marks, islands inside holes). Parts
 * come out in document order of their outer shapes.
 */
export function findParts(shapes: readonly Shape[]): PartGroup[] {
  const parents = containmentParents(shapes);
  const childCount = new Array<number>(shapes.length).fill(0);
  for (const parent of parents) {
    if (parent >= 0) childCount[parent] = (childCount[parent] ?? 0) + 1;
  }

  // Root (top-level ancestor) of every shape. Parents form a forest.
  const roots = new Array<number>(shapes.length).fill(-1);
  const chain: number[] = [];
  for (let i = 0; i < shapes.length; i++) {
    let cur = i;
    while (roots[cur] === -1 && (parents[cur] ?? -1) >= 0) {
      chain.push(cur);
      cur = parents[cur] ?? -1;
    }
    const root = roots[cur] === -1 ? cur : (roots[cur] ?? cur);
    roots[cur] = root;
    for (const index of chain) roots[index] = root;
    chain.length = 0;
  }

  const members = new Map<number, { ids: string[]; holes: (readonly Point[])[] }>();
  for (let i = 0; i < shapes.length; i++) {
    if (roots[i] === i) members.set(i, { ids: [], holes: [] });
  }
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    const root = roots[i] ?? i;
    const group = members.get(root);
    if (!shape || !group || root === i) continue;
    group.ids.push(shape.id);
    if (shape.closed && parents[i] === root && childCount[i] === 0) group.holes.push(shape.points);
  }

  const parts: PartGroup[] = [];
  for (const [index, group] of members) {
    const outer = shapes[index];
    if (!outer) continue;
    const bounds = boundsOfPoints(outer.points);
    parts.push({
      id: outer.id,
      shapeIds: [outer.id, ...group.ids],
      outline: outer.points,
      closed: outer.closed,
      holes: group.holes,
      widthMm: bounds ? bounds.maxX - bounds.minX : 0,
      heightMm: bounds ? bounds.maxY - bounds.minY : 0,
    });
  }
  return parts;
}

/** The nesting engine's input for the groups. Parts with a quantity of 0 are left out. */
export function toNestParts(
  groups: readonly PartGroup[],
  settingFor: (partId: string) => PartSetting | undefined,
): NestPart[] {
  const parts: NestPart[] = [];
  for (const group of groups) {
    const setting = settingFor(group.id) ?? DEFAULT_PART_SETTING;
    const quantity = clampQuantity(setting.quantity);
    if (quantity === 0) continue;
    parts.push({
      id: group.id,
      outline: group.outline,
      closed: group.closed,
      holes: group.holes,
      quantity,
      canRotate: setting.canRotate,
    });
  }
  return parts;
}

/** Each group's shapes, keyed by part id, in the order of `shapeIds`. */
export function partSources(groups: readonly PartGroup[], shapes: readonly Shape[]): Map<string, readonly Shape[]> {
  const byId = new Map<string, Shape>();
  for (const shape of shapes) byId.set(shape.id, shape);
  const sources = new Map<string, readonly Shape[]>();
  for (const group of groups) {
    const members: Shape[] = [];
    for (const id of group.shapeIds) {
      const shape = byId.get(id);
      if (shape) members.push(shape);
    }
    sources.set(group.id, members);
  }
  return sources;
}

/**
 * The shapes of one nested sheet, in sheet coordinates: a copy of the part's
 * source shapes for every placement. Placements of unknown parts are skipped.
 */
export function sheetShapes(
  sheet: NestSheet,
  sources: ReadonlyMap<string, readonly Shape[]>,
  nextId: () => string,
): Shape[] {
  const shapes: Shape[] = [];
  for (const placement of sheet.placements) {
    const source = sources.get(placement.partId);
    if (!source) continue;
    const m = placementMatrix(placement);
    for (const shape of source) {
      shapes.push({ id: nextId(), color: shape.color, closed: shape.closed, points: applyToPoints(m, shape.points) });
    }
  }
  return shapes;
}
