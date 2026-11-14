import { buildLayout } from './layout';
import type { Layout } from './layout';
import { prepare } from './prepare';
import type { Prepared } from './prepare';
import { createRng } from './rng';
import { createSearch } from './search';
import type { Search } from './search';
import type { NestInput, NestPlacement, NestResult, NestSheet, NestUnplaced } from './types';

export interface Nester {
  /**
   * Tries one more layout. Returns a result when it beats every earlier one
   * (the first call always returns one), otherwise null.
   */
  step(): NestResult | null;
  /** True once more steps cannot find anything better. */
  readonly done: boolean;
}

/** Fitness weights: any unplaced copy outweighs any number of sheets, a sheet outweighs any length. */
const UNPLACED_WEIGHT = 1e9;
const SHEET_WEIGHT = 1e4;
const LENGTH_WEIGHT = 1e3;

function clamp(value: number, low: number, high: number): number {
  if (low > high) return (low + high) / 2;
  return value < low ? low : value > high ? high : value;
}

/**
 * Irregular-shape nesting. Each step builds one complete layout with no-fit
 * polygons (see `docs/nesting.md`) and a genetic search picks what to try
 * next. Deterministic for a given input and seed.
 */
export function createNester(input: NestInput): Nester {
  let done = false;
  let prepared: Prepared | null = null;
  let search: Search | null = null;
  let unplaced: NestUnplaced[] = [];
  let unplacedCount = 0;
  let evaluations = 0;
  let bestFitness = Infinity;

  const emptyResult = (): NestResult => ({
    sheets: [],
    unplaced,
    placedCount: 0,
    utilization: 0,
    fitness: unplacedCount * UNPLACED_WEIGHT,
    evaluations,
  });

  const fitnessOf = (data: Prepared, layout: Layout): number => {
    const last = layout.sheets[layout.sheets.length - 1];
    if (last === undefined) return unplacedCount * UNPLACED_WEIGHT;
    const width = data.sheetWidthMm * data.scale;
    let rightSum = 0;
    for (const placed of last.placed) rightSum += placed.x + placed.rotation.tMaxX;
    const tiebreak = last.placed.length > 0 && width > 0 ? rightSum / (last.placed.length * width) : 0;
    return (
      unplacedCount * UNPLACED_WEIGHT +
      layout.sheets.length * SHEET_WEIGHT +
      (width > 0 ? last.usedX / width : 0) * LENGTH_WEIGHT +
      tiebreak
    );
  };

  const resultOf = (data: Prepared, layout: Layout, fitness: number): NestResult => {
    const { scale, sheet } = data;
    const nextCopy = new Map<number, number>();
    let area = 0;
    let placedCount = 0;
    const sheets: NestSheet[] = layout.sheets.map((state) => {
      const placements: NestPlacement[] = [];
      let used = 0;
      for (const placed of state.placed) {
        const part = data.parts[placed.part];
        if (part === undefined) continue;
        const rot = placed.rotation;
        // Pin the true bounding box inside the margin; this moves a part by less than one unit.
        const x = clamp(placed.x, sheet.minX - rot.tMinX, sheet.maxX - rot.tMaxX);
        const y = clamp(placed.y, sheet.minY - rot.tMinY, sheet.maxY - rot.tMaxY);
        const copy = nextCopy.get(placed.part) ?? 0;
        nextCopy.set(placed.part, copy + 1);
        placements.push({
          partId: part.id,
          copy,
          rotationDeg: rot.rotationDeg,
          dx: (x - rot.ox) / scale,
          dy: (y - rot.oy) / scale,
        });
        used = Math.max(used, (x + rot.tMaxX) / scale);
        area += part.areaMm2;
        placedCount += 1;
      }
      return { placements, usedLengthMm: used };
    });
    const last = sheets[sheets.length - 1];
    const material =
      last === undefined
        ? 0
        : ((sheets.length - 1) * data.sheetWidthMm + last.usedLengthMm) * data.sheetHeightMm;
    return {
      sheets,
      unplaced,
      placedCount,
      utilization: material > 0 ? Math.min(1, area / material) : 0,
      fitness,
      evaluations,
    };
  };

  return {
    get done() {
      return done;
    },
    step() {
      if (done) return null;
      const first = prepared === null;
      if (prepared === null) {
        prepared = prepare(input.parts, input.options);
        search = createSearch(prepared, createRng(input.seed));
        unplaced = prepared.parts
          .filter((part) => part.count > 0 && part.rotations.length === 0)
          .map((part) => ({ partId: part.id, count: part.count }));
        unplacedCount = unplaced.reduce((sum, entry) => sum + entry.count, 0);
      }
      const genome = search === null ? null : search.next();
      if (search === null || genome === null) {
        done = true;
        return first ? emptyResult() : null;
      }
      const layout = buildLayout(prepared, search.genes(genome), search.objective(genome));
      evaluations += 1;
      const fitness = fitnessOf(prepared, layout);
      search.report(genome, fitness, layout);
      if (fitness < bestFitness - 1e-9) {
        bestFitness = fitness;
        const result = resultOf(prepared, layout, fitness);
        // No waste at all: nothing can beat this.
        if (result.utilization >= 1 - 1e-9) done = true;
        return result;
      }
      return null;
    },
  };
}
