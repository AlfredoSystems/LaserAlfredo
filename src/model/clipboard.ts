import { isInScope, remapGroupIds, shapeGroups, withGroups, type GroupPath } from './groups';
import { boundsOfShapes } from './selection';
import { applyToPoints, translation } from './transform';
import type { Point, Shape } from './types';

/** How far a paste without a target point lands from the copied shapes, per paste, in mm. */
export const PASTE_OFFSET_MM = 10;

/**
 * The shapes to put on the clipboard: those with the given ids, in document
 * order. Shapes copied from inside a scope lose that scope from their group
 * path, so the clipboard holds them as if they were at top level.
 */
export function copyShapes(shapes: readonly Shape[], ids: ReadonlySet<string>, scope: GroupPath): Shape[] {
  const copied: Shape[] = [];
  for (const shape of shapes) {
    if (!ids.has(shape.id)) continue;
    copied.push(
      scope.length > 0 && isInScope(shape, scope) ? withGroups(shape, shapeGroups(shape).slice(scope.length)) : shape,
    );
  }
  return copied;
}

/** Where pasted shapes go: centred on a point, or shifted from where they were copied. */
export type PasteTarget =
  | { readonly kind: 'center'; readonly point: Point }
  | { readonly kind: 'offset'; readonly dx: number; readonly dy: number };

export interface PasteOptions {
  /** The scope being pasted into; the pasted shapes join it. */
  readonly scope: GroupPath;
  readonly target: PasteTarget;
  readonly nextShapeId: () => string;
  readonly nextGroupId: () => string;
}

/**
 * New shapes for a paste: fresh shape ids, fresh group ids with the same
 * nesting, the scope put in front of every group path, and all of them moved
 * together to the target. Colours are kept. Nothing is clamped to the bed.
 */
export function pasteShapes(copied: readonly Shape[], options: PasteOptions): Shape[] {
  if (copied.length === 0) return [];
  const { scope, target } = options;
  let dx = 0;
  let dy = 0;
  if (target.kind === 'offset') {
    dx = target.dx;
    dy = target.dy;
  } else {
    const bounds = boundsOfShapes(copied);
    if (bounds) {
      dx = target.point.x - (bounds.minX + bounds.maxX) / 2;
      dy = target.point.y - (bounds.minY + bounds.maxY) / 2;
    }
  }
  const m = translation(dx, dy);
  return remapGroupIds(copied, options.nextGroupId).map((shape) => {
    const moved: Shape = { ...shape, id: options.nextShapeId(), points: applyToPoints(m, shape.points) };
    return scope.length > 0 ? withGroups(moved, [...scope, ...shapeGroups(moved)]) : moved;
  });
}
