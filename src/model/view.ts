import type { Bounds, Point } from './types';

/** Maps document mm to canvas CSS pixels: screen = mm * scale + offset. */
export interface View {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export const MIN_VIEW_SCALE = 0.02;
export const MAX_VIEW_SCALE = 2000;

export function toScreen(view: View, p: Point): Point {
  return { x: p.x * view.scale + view.offsetX, y: p.y * view.scale + view.offsetY };
}

export function toDocument(view: View, p: Point): Point {
  return { x: (p.x - view.offsetX) / view.scale, y: (p.y - view.offsetY) / view.scale };
}

/** Zooms by `factor`, keeping the document point under `screenPoint` fixed. */
export function zoomAt(view: View, screenPoint: Point, factor: number): View {
  const scale = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, view.scale * factor));
  const doc = toDocument(view, screenPoint);
  return { scale, offsetX: screenPoint.x - doc.x * scale, offsetY: screenPoint.y - doc.y * scale };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

/** A view that centres `bounds` in a viewport of the given pixel size. */
export function fitBounds(bounds: Bounds, viewportWidth: number, viewportHeight: number, paddingPx = 40): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const availableW = Math.max(viewportWidth - 2 * paddingPx, 10);
  const availableH = Math.max(viewportHeight - 2 * paddingPx, 10);
  const scale = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, Math.min(availableW / w, availableH / h)));
  return {
    scale,
    offsetX: viewportWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    offsetY: viewportHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
  };
}
