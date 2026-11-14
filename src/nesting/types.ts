import type { Point } from '../model/types';

/** One distinct part to nest. Plain data, so it can cross the worker boundary. */
export interface NestPart {
  readonly id: string;
  /**
   * Outer boundary in mm, wherever the part sits in the document. A closed
   * outline does not repeat its first point. An open outline (`closed` false)
   * is a loose path that is nested as a thin strip around itself.
   */
  readonly outline: readonly Point[];
  readonly closed: boolean;
  /** Empty holes of the part that smaller parts may be placed in. */
  readonly holes: readonly (readonly Point[])[];
  /** How many copies to place. Zero or less means the part is skipped. */
  readonly quantity: number;
  /** False pins the part to its drawn orientation (grain, mirrored stock). */
  readonly canRotate: boolean;
}

export interface NestOptions {
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
  /** Gap kept clear along every sheet edge. */
  readonly marginMm: number;
  /** Smallest gap between two parts. */
  readonly spacingMm: number;
  /** Parts may turn in multiples of this. 0 means no rotation. */
  readonly rotationStepDeg: number;
  /** Allow small parts inside the holes of larger ones. */
  readonly useHoles: boolean;
}

/**
 * Where one copy of a part goes. A source point p (document mm) lands at
 * `rotate(p, rotationDeg about (0, 0)) + (dx, dy)` in sheet coordinates, whose
 * origin is the sheet's top-left corner. See `placementMatrix`.
 */
export interface NestPlacement {
  readonly partId: string;
  /** 0-based copy number of this part. */
  readonly copy: number;
  readonly rotationDeg: number;
  readonly dx: number;
  readonly dy: number;
}

export interface NestSheet {
  readonly placements: readonly NestPlacement[];
  /** Distance from the sheet's left edge to the right-most part edge. */
  readonly usedLengthMm: number;
}

export interface NestUnplaced {
  readonly partId: string;
  readonly count: number;
}

export interface NestResult {
  readonly sheets: readonly NestSheet[];
  /** Copies that fit no sheet in any allowed rotation. */
  readonly unplaced: readonly NestUnplaced[];
  readonly placedCount: number;
  /**
   * Part area divided by the material used, 0–1. Material used is every full
   * sheet before the last plus the last sheet up to its used length.
   */
  readonly utilization: number;
  /** Lower is better. Comparable between runs on the same input. */
  readonly fitness: number;
  /** Layouts tried so far by the search that produced this result. */
  readonly evaluations: number;
}

export interface NestInput {
  readonly parts: readonly NestPart[];
  readonly options: NestOptions;
  /** Seed for the search's random numbers. Same input and seed, same results. */
  readonly seed: number;
}

export const DEFAULT_NEST_OPTIONS: NestOptions = {
  sheetWidthMm: 1000,
  sheetHeightMm: 600,
  marginMm: 5,
  spacingMm: 2,
  rotationStepDeg: 90,
  useHoles: true,
};
