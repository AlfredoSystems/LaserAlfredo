/** A point in document space. Millimetres, origin top-left, Y increasing downward. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A flattened path as produced by importers and geometry code.
 * A closed path does not repeat its first point at the end.
 */
export interface Polyline {
  readonly points: readonly Point[];
  readonly closed: boolean;
}

/** A polyline with the layer colour it was imported with (lowercase `#rrggbb`). */
export interface ColoredPolyline extends Polyline {
  readonly color: string;
}

/** A document shape: one contour on one layer. Points are in document mm. */
export interface Shape extends ColoredPolyline {
  readonly id: string;
}

export type LayerMode = 'line' | 'fill';

/** Cut settings for every shape of one colour, as in LightBurn. */
export interface Layer {
  readonly color: string;
  readonly mode: LayerMode;
  readonly speedMmS: number;
  readonly maxPowerPct: number;
  readonly minPowerPct: number;
  readonly passes: number;
  /** Full width of the laser cut in mm; 0 turns kerf compensation off. */
  readonly kerfMm: number;
  readonly enabled: boolean;
}

export interface LaserDocument {
  readonly shapes: readonly Shape[];
  readonly layers: readonly Layer[];
}

/** What every importer returns. Coordinates are already mm and Y-down. */
export interface ImportResult {
  readonly paths: readonly ColoredPolyline[];
  /** Human-readable notes about skipped or unsupported content. */
  readonly warnings: readonly string[];
}

/** Axis-aligned bounding box in mm. */
export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
