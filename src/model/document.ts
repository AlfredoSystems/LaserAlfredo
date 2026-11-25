import { applyToPoints, type Matrix } from './transform';
import type { ColoredPolyline, LaserDocument, Layer, Shape, ShapeCutSettings } from './types';

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

/** The palette colour closest (in RGB) to the given colour. */
export function nearestPaletteColor(color: string): string {
  const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r, g, b] = rgb(normalizeColor(color));
  let best = LAYER_PALETTE[0] ?? '#000000';
  let bestDistance = Infinity;
  for (const candidate of LAYER_PALETTE) {
    const [cr, cg, cb] = rgb(candidate);
    const distance = ((r ?? 0) - (cr ?? 0)) ** 2 + ((g ?? 0) - (cg ?? 0)) ** 2 + ((b ?? 0) - (cb ?? 0)) ** 2;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
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
    kerfMm: 0,
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

/** A path that may already say which groups its shape belongs to. */
export type GroupedPath = ColoredPolyline & { readonly groups?: readonly string[] };

/**
 * Turns importer output into shapes. Paths with fewer than two points are
 * dropped. Group membership, when a path carries any, is kept.
 */
export function shapesFromPaths(paths: readonly GroupedPath[], nextId: () => string): Shape[] {
  const shapes: Shape[] = [];
  for (const path of paths) {
    if (path.points.length < 2) continue;
    if (!path.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    shapes.push({
      id: nextId(),
      color: normalizeColor(path.color),
      points: path.points,
      closed: path.closed && path.points.length >= 3,
      ...(path.groups && path.groups.length > 0 ? { groups: path.groups } : {}),
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

/**
 * Moves the shapes to the layer of the given colour, creating it if needed.
 * A shape that changes layer loses its own cut settings and uses the new
 * layer's; a shape that already has the colour is left as it is.
 */
export function setShapesColor(doc: LaserDocument, ids: ReadonlySet<string>, color: string): LaserDocument {
  if (ids.size === 0) return doc;
  const target = normalizeColor(color);
  const shapes = doc.shapes.map((shape) => {
    if (!ids.has(shape.id) || shape.color === target) return shape;
    const { settings: dropped, ...rest } = shape;
    void dropped;
    return { ...rest, color: target };
  });
  return { shapes, layers: syncLayers(shapes, doc.layers) };
}

/**
 * Cut settings brought into the ranges a layer allows: speed 0.1–2000 mm/s,
 * power 0–100 %, min power no higher than max, whole passes 1–100. A value
 * that is not a finite number is replaced by the fallback's.
 */
export function clampCutSettings(settings: ShapeCutSettings, fallback: ShapeCutSettings): ShapeCutSettings {
  const maxPowerPct = clamp(settings.maxPowerPct, 0, 100, fallback.maxPowerPct);
  return {
    speedMmS: clamp(settings.speedMmS, 0.1, 2000, fallback.speedMmS),
    maxPowerPct,
    minPowerPct: Math.min(maxPowerPct, clamp(settings.minPowerPct, 0, 100, fallback.minPowerPct)),
    passes: Math.round(clamp(settings.passes, 1, 100, fallback.passes)),
  };
}

/** How many shapes a layer has, and how many of them carry their own cut settings. */
export interface LayerShapeCount {
  readonly shapes: number;
  readonly withSettings: number;
}

export function countLayerShapes(shapes: readonly Shape[]): Map<string, LayerShapeCount> {
  const counts = new Map<string, { shapes: number; withSettings: number }>();
  for (const shape of shapes) {
    let entry = counts.get(shape.color);
    if (!entry) {
      entry = { shapes: 0, withSettings: 0 };
      counts.set(shape.color, entry);
    }
    entry.shapes += 1;
    if (shape.settings) entry.withSettings += 1;
  }
  return counts;
}

export type LayerPatch = Partial<Omit<Layer, 'color'>>;

/** Applies a settings change to one layer, clamping every value to a valid range. */
export function updateLayer(doc: LaserDocument, color: string, patch: LayerPatch): LaserDocument {
  const layers = doc.layers.map((layer) => {
    if (layer.color !== color) return layer;
    const merged = { ...layer, ...patch };
    return {
      ...merged,
      ...clampCutSettings(merged, layer),
      kerfMm: clamp(merged.kerfMm, 0, 2, layer.kerfMm),
    };
  });
  return { shapes: doc.shapes, layers };
}

/** Settings to give one layer colour when shapes are added. */
export interface LayerSetup {
  readonly color: string;
  readonly patch: LayerPatch;
}

/**
 * Adds the shapes and, in the same step, sets the given layers' settings: a
 * layer the shapes create starts from the defaults with the patch applied,
 * one that already exists is updated. A setup for a colour that no shape
 * uses changes nothing.
 */
export function addShapesWithLayers(
  doc: LaserDocument,
  shapes: readonly Shape[],
  setups: readonly LayerSetup[],
): LaserDocument {
  let next = addShapes(doc, shapes);
  if (next === doc) return doc;
  for (const setup of setups) next = updateLayer(next, normalizeColor(setup.color), setup.patch);
  return next;
}
