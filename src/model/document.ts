import { applyToPoints, type Matrix } from './transform';
import type { ColoredPolyline, LaserDocument, Layer, Shape } from './types';

export const EMPTY_DOCUMENT: LaserDocument = { shapes: [], layers: [] };

/** Colours offered for (re)assigning shapes to layers. */
export const LAYER_PALETTE: readonly string[] = [
  '#000000',
  '#0000ff',
  '#ff0000',
  '#00a000',
  '#d0a000',
  '#ff8000',
  '#00c0c0',
  '#ff00ff',
  '#808080',
  '#8000ff',
];

/** Normalises `#rgb` / `#RRGGBB` to lowercase `#rrggbb`; anything else becomes black. */
export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return '#000000';
}

/** Conservative defaults: a new layer never starts at high power. */
export function defaultLayer(color: string): Layer {
  return {
    color: normalizeColor(color),
    mode: 'line',
    speedMmS: 20,
    maxPowerPct: 30,
    minPowerPct: 20,
    passes: 1,
    enabled: true,
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Keeps existing layers that still have shapes and appends layers for new colours. */
function syncLayers(shapes: readonly Shape[], layers: readonly Layer[]): readonly Layer[] {
  const used = new Set<string>();
  for (const shape of shapes) used.add(shape.color);
  const kept = layers.filter((layer) => used.has(layer.color));
  const known = new Set(kept.map((layer) => layer.color));
  const added: Layer[] = [];
  for (const color of used) {
    if (!known.has(color)) added.push(defaultLayer(color));
  }
  if (added.length === 0 && kept.length === layers.length) return layers;
  return [...kept, ...added];
}

/** Turns importer output into shapes. Paths with fewer than two points are dropped. */
export function shapesFromPaths(paths: readonly ColoredPolyline[], nextId: () => string): Shape[] {
  const shapes: Shape[] = [];
  for (const path of paths) {
    if (path.points.length < 2) continue;
    if (!path.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    shapes.push({
      id: nextId(),
      color: normalizeColor(path.color),
      points: path.points,
      closed: path.closed && path.points.length >= 3,
    });
  }
  return shapes;
}

export function addShapes(doc: LaserDocument, shapes: readonly Shape[]): LaserDocument {
  if (shapes.length === 0) return doc;
  const all = [...doc.shapes, ...shapes];
  return { shapes: all, layers: syncLayers(all, doc.layers) };
}

export function removeShapes(doc: LaserDocument, ids: ReadonlySet<string>): LaserDocument {
  if (ids.size === 0) return doc;
  const shapes = doc.shapes.filter((shape) => !ids.has(shape.id));
  if (shapes.length === doc.shapes.length) return doc;
  return { shapes, layers: syncLayers(shapes, doc.layers) };
}

export function transformShapes(doc: LaserDocument, ids: ReadonlySet<string>, m: Matrix): LaserDocument {
  if (ids.size === 0) return doc;
  const shapes = doc.shapes.map((shape) =>
    ids.has(shape.id) ? { ...shape, points: applyToPoints(m, shape.points) } : shape,
  );
  return { shapes, layers: doc.layers };
}

/** Moves the shapes to the layer of the given colour, creating it if needed. */
export function setShapesColor(doc: LaserDocument, ids: ReadonlySet<string>, color: string): LaserDocument {
  if (ids.size === 0) return doc;
  const target = normalizeColor(color);
  const shapes = doc.shapes.map((shape) =>
    ids.has(shape.id) && shape.color !== target ? { ...shape, color: target } : shape,
  );
  return { shapes, layers: syncLayers(shapes, doc.layers) };
}

export type LayerPatch = Partial<Omit<Layer, 'color'>>;

/** Applies a settings change to one layer, clamping every value to a valid range. */
export function updateLayer(doc: LaserDocument, color: string, patch: LayerPatch): LaserDocument {
  const layers = doc.layers.map((layer) => {
    if (layer.color !== color) return layer;
    const merged = { ...layer, ...patch };
    const maxPowerPct = clamp(merged.maxPowerPct, 0, 100, layer.maxPowerPct);
    return {
      ...merged,
      speedMmS: clamp(merged.speedMmS, 0.1, 2000, layer.speedMmS),
      maxPowerPct,
      minPowerPct: Math.min(maxPowerPct, clamp(merged.minPowerPct, 0, 100, layer.minPowerPct)),
      passes: Math.round(clamp(merged.passes, 1, 100, layer.passes)),
    };
  });
  return { shapes: doc.shapes, layers };
}
