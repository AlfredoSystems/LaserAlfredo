import { shapesInRect } from './selection';
import type { Bounds, LaserDocument, Shape } from './types';

/**
 * A scope is the path of groups the user has entered, outermost first. The
 * empty path is the top level.
 *
 * Within a scope only the shapes whose `groups` start with the scope are
 * reachable. They are selected in units: a unit is one shape that sits
 * directly in the scope, or all the shapes that share the same group one
 * level below it.
 */
export type GroupPath = readonly string[];

export const TOP_LEVEL: GroupPath = [];

const NO_GROUPS: readonly string[] = [];

export function shapeGroups(shape: Shape): readonly string[] {
  return shape.groups ?? NO_GROUPS;
}

/** The shape with the given group path. An empty path leaves the property out. */
export function withGroups(shape: Shape, groups: readonly string[]): Shape {
  if (groups.length > 0) return { ...shape, groups };
  if (shape.groups === undefined) return shape;
  const { groups: dropped, ...rest } = shape;
  void dropped;
  return rest;
}

function startsWith(groups: readonly string[], scope: GroupPath): boolean {
  if (groups.length < scope.length) return false;
  for (let i = 0; i < scope.length; i++) if (groups[i] !== scope[i]) return false;
  return true;
}

export function isInScope(shape: Shape, scope: GroupPath): boolean {
  return scope.length === 0 || startsWith(shapeGroups(shape), scope);
}

/** The shapes that can be picked in the scope. At top level that is the same array. */
export function reachableShapes(shapes: readonly Shape[], scope: GroupPath): readonly Shape[] {
  return scope.length === 0 ? shapes : shapes.filter((shape) => isInScope(shape, scope));
}

/** The group that makes the shape's unit in the scope; undefined when the shape is a unit by itself. */
function unitGroup(shape: Shape, scope: GroupPath): string | undefined {
  return shapeGroups(shape)[scope.length];
}

/** Ids of the unit the shape belongs to in the scope. Empty when the shape is unknown or out of scope. */
export function unitOf(shapes: readonly Shape[], shapeId: string, scope: GroupPath): string[] {
  const shape = shapes.find((each) => each.id === shapeId);
  if (!shape || !isInScope(shape, scope)) return [];
  const group = unitGroup(shape, scope);
  if (group === undefined) return [shape.id];
  return shapes.filter((each) => isInScope(each, scope) && unitGroup(each, scope) === group).map((each) => each.id);
}

/**
 * Grows a set of shape ids to whole units of the scope. Ids of shapes that
 * are unknown or out of scope are dropped.
 */
export function expandToUnits(shapes: readonly Shape[], ids: ReadonlySet<string>, scope: GroupPath): Set<string> {
  const result = new Set<string>();
  if (ids.size === 0) return result;
  const groups = new Set<string>();
  for (const shape of shapes) {
    if (!ids.has(shape.id) || !isInScope(shape, scope)) continue;
    const group = unitGroup(shape, scope);
    if (group === undefined) result.add(shape.id);
    else groups.add(group);
  }
  if (groups.size === 0) return result;
  for (const shape of shapes) {
    if (!isInScope(shape, scope)) continue;
    const group = unitGroup(shape, scope);
    if (group !== undefined && groups.has(group)) result.add(shape.id);
  }
  return result;
}

/** How many units of the scope the ids touch. */
export function countUnits(shapes: readonly Shape[], ids: ReadonlySet<string>, scope: GroupPath): number {
  if (ids.size === 0) return 0;
  const groups = new Set<string>();
  let singles = 0;
  for (const shape of shapes) {
    if (!ids.has(shape.id) || !isInScope(shape, scope)) continue;
    const group = unitGroup(shape, scope);
    if (group === undefined) singles += 1;
    else groups.add(group);
  }
  return singles + groups.size;
}

/** Every shape reachable in the scope. */
export function scopeShapeIds(shapes: readonly Shape[], scope: GroupPath): string[] {
  return reachableShapes(shapes, scope).map((shape) => shape.id);
}

/**
 * Marquee selection by units. `enclose` takes a unit only when every one of
 * its shapes is inside the rectangle; `cross` takes it when any of its shapes
 * is inside or touched.
 */
export function unitsInRect(
  shapes: readonly Shape[],
  rect: Bounds,
  mode: 'enclose' | 'cross',
  scope: GroupPath,
): string[] {
  const reachable = reachableShapes(shapes, scope);
  const hit = new Set(shapesInRect(reachable, rect, mode).map((shape) => shape.id));
  if (hit.size === 0) return [];
  const expanded = expandToUnits(reachable, hit, scope);
  if (mode === 'cross') return [...expanded];
  // A unit with a shape that was not enclosed is left out as a whole.
  const partial = new Set<string>();
  for (const shape of reachable) {
    const group = unitGroup(shape, scope);
    if (group !== undefined && expanded.has(shape.id) && !hit.has(shape.id)) partial.add(group);
  }
  if (partial.size === 0) return [...expanded];
  return reachable
    .filter((shape) => {
      if (!expanded.has(shape.id)) return false;
      const group = unitGroup(shape, scope);
      return group === undefined || !partial.has(group);
    })
    .map((shape) => shape.id);
}

/** Grouping needs at least two units: one shape, or one group, is not grouped again. */
export function canGroup(shapes: readonly Shape[], ids: ReadonlySet<string>, scope: GroupPath): boolean {
  return countUnits(shapes, ids, scope) >= 2;
}

/** True when a selected shape is in a group of the scope. */
export function canUngroup(shapes: readonly Shape[], ids: ReadonlySet<string>, scope: GroupPath): boolean {
  if (ids.size === 0) return false;
  return shapes.some((shape) => ids.has(shape.id) && isInScope(shape, scope) && unitGroup(shape, scope) !== undefined);
}

/**
 * Makes one new group, directly in the scope, of the units the ids touch.
 * Groups among them become its children. The selection is first grown to
 * whole units, so a group is never split. Nothing changes unless there are at
 * least two units.
 */
export function groupShapes(
  doc: LaserDocument,
  ids: ReadonlySet<string>,
  scope: GroupPath,
  newGroupId: string,
): LaserDocument {
  if (!canGroup(doc.shapes, ids, scope)) return doc;
  const members = expandToUnits(doc.shapes, ids, scope);
  const shapes = doc.shapes.map((shape) => {
    if (!members.has(shape.id)) return shape;
    const groups = shapeGroups(shape);
    return withGroups(shape, [...groups.slice(0, scope.length), newGroupId, ...groups.slice(scope.length)]);
  });
  return { shapes, layers: doc.layers };
}

/**
 * Takes the given shapes out of the group they are in directly below the
 * scope. One level only: groups nested inside it stay. Shapes that are not
 * in such a group, or are out of scope, are left alone.
 */
export function ungroupShapes(doc: LaserDocument, ids: ReadonlySet<string>, scope: GroupPath): LaserDocument {
  if (!canUngroup(doc.shapes, ids, scope)) return doc;
  const shapes = doc.shapes.map((shape) => {
    if (!ids.has(shape.id) || !isInScope(shape, scope)) return shape;
    const groups = shapeGroups(shape);
    if (groups.length <= scope.length) return shape;
    return withGroups(shape, [...groups.slice(0, scope.length), ...groups.slice(scope.length + 1)]);
  });
  return { shapes, layers: doc.layers };
}

/** True while at least one shape is still inside the scope. The top level always exists. */
export function scopeExists(shapes: readonly Shape[], scope: GroupPath): boolean {
  return scope.length === 0 || shapes.some((shape) => startsWith(shapeGroups(shape), scope));
}

/** The deepest part of the scope that still exists. Returns the same path when all of it does. */
export function existingScope(shapes: readonly Shape[], scope: GroupPath): GroupPath {
  for (let depth = scope.length; depth > 0; depth--) {
    const candidate = depth === scope.length ? scope : scope.slice(0, depth);
    if (scopeExists(shapes, candidate)) return candidate;
  }
  return scope.length === 0 ? scope : TOP_LEVEL;
}

/**
 * The scope one level deeper that holds the shape, or null when the shape is
 * not in a group of the current scope (there is nothing to enter).
 */
export function scopeEntering(shapes: readonly Shape[], shapeId: string, scope: GroupPath): GroupPath | null {
  const shape = shapes.find((each) => each.id === shapeId);
  if (!shape || !isInScope(shape, scope)) return null;
  const group = unitGroup(shape, scope);
  return group === undefined ? null : [...scope, group];
}

/**
 * Gives every group id used by the shapes a fresh id, the same one wherever
 * it occurs, so copies keep their nesting but share no group with the
 * originals. Ungrouped shapes are returned as they are.
 */
export function remapGroupIds(shapes: readonly Shape[], nextGroupId: () => string): Shape[] {
  const fresh = new Map<string, string>();
  return shapes.map((shape) => {
    const groups = shapeGroups(shape);
    if (groups.length === 0) return shape;
    const mapped = groups.map((id) => {
      let next = fresh.get(id);
      if (next === undefined) {
        next = nextGroupId();
        fresh.set(id, next);
      }
      return next;
    });
    return { ...shape, groups: mapped };
  });
}
