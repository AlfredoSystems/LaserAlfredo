import type { Bounds, Point } from '../model/types';

/** One continuous cut: the laser is on from the first point to the last. */
export interface JobPath {
  readonly points: readonly Point[];
  /** When true the cut returns from the last point to the first. */
  readonly closed: boolean;
}

/** All cuts that share one set of laser settings, already in cutting order. */
export interface JobLayer {
  /** Lowercase `#rrggbb`, used for the preview and the controller's layer colour. */
  readonly color: string;
  readonly speedMmS: number;
  readonly maxPowerPct: number;
  readonly minPowerPct: number;
  /** How many times the whole layer is cut. At least 1. */
  readonly passes: number;
  readonly paths: readonly JobPath[];
}

/**
 * A machine-agnostic job. Millimetres, origin top-left, Y down, absolute
 * coordinates on the bed. Layers run in array order.
 */
export interface Job {
  readonly layers: readonly JobLayer[];
  /** Bounding box of every cut point, or null for an empty job. */
  readonly bounds: Bounds | null;
}
