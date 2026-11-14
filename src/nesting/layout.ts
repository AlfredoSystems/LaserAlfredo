import { FillRule, difference } from 'clipper2-ts';
import type { Path64, Paths64 } from 'clipper2-ts';
import { FIT_EPS } from './prepare';
import type { PartRotation, Prepared } from './prepare';

/**
 * Builds one layout: places the copies one by one, in the given order, each
 * at the best free position of the first sheet that has room.
 */

/**
 * How a position is scored; lower is better. Parts are packed toward x = 0 so
 * that what is left of the sheet is one rectangle on the right.
 * - `length`: least growth of the used length, then left-most, then top-most.
 * - `gravity`: least growth of the used length, then centroid left-most.
 * - `center`: centroid left-most, then top-most.
 * - `sum`: least growth of twice the used length plus the used height.
 */
export const OBJECTIVES = ['length', 'gravity', 'center', 'sum'] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** How many no-fit regions are cut out of the free positions per clipper call (measured: 8–16 is fastest). */
const SUBTRACT_BATCH = 12;

/** One copy to place. */
export interface Gene {
  /** Index into `Prepared.parts`. */
  readonly part: number;
  /** Index into the part's rotations, or -1 to try them all and keep the best. */
  readonly rotation: number;
}

export interface Placed {
  readonly part: number;
  readonly rotation: PartRotation;
  /** Sheet position of the nest polygon's reference vertex, in units. */
  readonly x: number;
  readonly y: number;
}

export interface SheetLayout {
  readonly placed: Placed[];
  /** Right-most and bottom-most true part edges, in units from the sheet origin. */
  usedX: number;
  usedY: number;
}

export interface Layout {
  readonly sheets: SheetLayout[];
  /** For each gene, the sheet it landed on, or -1. */
  readonly sheetOf: Int32Array;
}

/** The positions left free for one rotation by the first `count` parts placed on a sheet. */
interface FreeEntry {
  count: number;
  region: Paths64;
  /** Positions that keep the true part inside the margin. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface SheetState extends SheetLayout {
  /** Free positions by rotation id. */
  readonly free: Map<number, FreeEntry>;
  /** Rotations that found no room; a sheet only gets fuller, so they never will. */
  readonly full: Set<number>;
  /** Sheet area not yet covered by material, to skip sheets that cannot hold a part. */
  freeArea: number;
}

interface Candidate {
  readonly rotation: PartRotation;
  readonly x: number;
  readonly y: number;
  readonly k1: number;
  readonly k2: number;
  readonly k3: number;
}

function better(a: Candidate, b: Candidate | null): boolean {
  if (b === null) return true;
  if (a.k1 !== b.k1) return a.k1 < b.k1;
  if (a.k2 !== b.k2) return a.k2 < b.k2;
  return a.k3 < b.k3;
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Path64 {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

export function buildLayout(prepared: Prepared, genes: readonly Gene[], objective: Objective): Layout {
  const { sheet } = prepared;
  const sheetArea = Math.max(0, sheet.maxX - sheet.minX) * Math.max(0, sheet.maxY - sheet.minY);
  const sheets: SheetState[] = [];
  const sheetOf = new Int32Array(genes.length).fill(-1);

  const score = (state: SheetState, rotation: PartRotation, x: number, y: number): Candidate => {
    const left = x + rotation.tMinX;
    const top = y + rotation.tMinY;
    const right = Math.max(state.usedX, x + rotation.tMaxX);
    const bottom = Math.max(state.usedY, y + rotation.tMaxY);
    switch (objective) {
      case 'gravity':
        return { rotation, x, y, k1: right, k2: x + rotation.cx, k3: y + rotation.cy };
      case 'center':
        return { rotation, x, y, k1: x + rotation.cx, k2: y + rotation.cy, k3: 0 };
      case 'sum':
        return { rotation, x, y, k1: 2 * right + bottom, k2: left, k3: top };
      default:
        return { rotation, x, y, k1: right, k2: left, k3: top };
    }
  };

  /** The free positions of one rotation on one sheet, possibly not yet cut by the latest parts. */
  const entryOf = (state: SheetState, rotation: PartRotation): FreeEntry | null => {
    let entry = state.free.get(rotation.rid);
    if (entry !== undefined) return entry;
    // Positions of the reference vertex that keep the true part inside the margin.
    const lowX = sheet.minX - rotation.tMinX;
    const highX = sheet.maxX - rotation.tMaxX;
    const lowY = sheet.minY - rotation.tMinY;
    const highY = sheet.maxY - rotation.tMaxY;
    if (lowX > highX + 2e-6 || lowY > highY + 2e-6) return null;
    let minX = Math.ceil(lowX - 1e-6);
    let maxX = Math.floor(highX + 1e-6);
    let minY = Math.ceil(lowY - 1e-6);
    let maxY = Math.floor(highY + 1e-6);
    // Less than one unit of play: take the nearest grid position; the result pins it exactly.
    if (minX > maxX) minX = maxX = Math.round((lowX + highX) / 2);
    if (minY > maxY) minY = maxY = Math.round((lowY + highY) / 2);
    entry = {
      count: 0,
      // Widened by the fit tolerance so that an exact fit against the sheet edge survives.
      region: [rect(minX - FIT_EPS, minY - FIT_EPS, maxX + FIT_EPS, maxY + FIT_EPS)],
      minX,
      minY,
      maxX,
      maxY,
    };
    state.free.set(rotation.rid, entry);
    return entry;
  };

  /** Cuts the no-fit regions of the parts placed since the last visit out of the free positions. */
  const refresh = (state: SheetState, rotation: PartRotation, entry: FreeEntry): void => {
    if (entry.count === state.placed.length) return;
    let added: Paths64 = [];
    for (let i = entry.count; i < state.placed.length; i++) {
      const other = state.placed[i];
      if (other === undefined) continue;
      for (const path of prepared.nfp(other.rotation.polyId, rotation.polyId, other.x, other.y)) added.push(path);
      // Neighbouring no-fit regions overlap heavily. Cutting them out a batch at a
      // time keeps clipper from resolving every crossing between all of them.
      if ((i - entry.count) % SUBTRACT_BATCH === SUBTRACT_BATCH - 1) {
        entry.region = difference(entry.region, added, FillRule.NonZero);
        added = [];
      }
    }
    if (added.length > 0) entry.region = difference(entry.region, added, FillRule.NonZero);
    entry.count = state.placed.length;
  };

  /** The best corner of the free positions. Every scoring rule is at its best on a corner. */
  const scan = (state: SheetState, rotation: PartRotation, entry: FreeEntry): Candidate | null => {
    let best: Candidate | null = null;
    for (const path of entry.region) {
      for (const p of path) {
        const x = p.x < entry.minX ? entry.minX : p.x > entry.maxX ? entry.maxX : p.x;
        const y = p.y < entry.minY ? entry.minY : p.y > entry.maxY ? entry.maxY : p.y;
        const candidate = score(state, rotation, x, y);
        if (better(candidate, best)) best = candidate;
      }
    }
    return best;
  };

  /** The best position for a part on one sheet over the given rotations, or null when it has no room. */
  const find = (state: SheetState, rotations: readonly PartRotation[]): Candidate | null => {
    let best: Candidate | null = null;
    for (const rotation of rotations) {
      if (state.full.has(rotation.rid)) continue;
      const entry = entryOf(state, rotation);
      if (entry !== null) refresh(state, rotation, entry);
      const candidate = entry === null ? null : scan(state, rotation, entry);
      if (candidate === null) state.full.add(rotation.rid);
      else if (better(candidate, best)) best = candidate;
    }
    return best;
  };

  /**
   * The free positions are loosened by the fit tolerance, so a chosen corner
   * usually sits a hair inside its neighbours. This moves it to the best grid
   * position nearby that the exact no-fit regions allow. When there is none,
   * the fit really does depend on the tolerance and the corner is kept.
   */
  const snap = (state: SheetState, chosen: Candidate): Candidate => {
    const entry = state.free.get(chosen.rotation.rid);
    if (entry === undefined || state.placed.length === 0) return chosen;
    const reach = 2 * FIT_EPS;
    const moving = chosen.rotation.polyId;
    const mine = prepared.poly(moving).bounds;
    const near: Placed[] = [];
    for (const other of state.placed) {
      const theirs = prepared.poly(other.rotation.polyId).bounds;
      if (
        chosen.x + reach < other.x + theirs.minX - mine.maxX ||
        chosen.x - reach > other.x + theirs.maxX - mine.minX ||
        chosen.y + reach < other.y + theirs.minY - mine.maxY ||
        chosen.y - reach > other.y + theirs.maxY - mine.minY
      ) {
        continue;
      }
      near.push(other);
    }
    const blocked = (x: number, y: number): boolean =>
      near.some((other) => prepared.overlaps(other.rotation.polyId, moving, x - other.x, y - other.y));
    let best: Candidate | null = null;
    // Straight and mitred edges move by exactly the tolerance, so try those offsets first.
    for (const stride of [FIT_EPS, 1]) {
      for (let dx = -reach; dx <= reach; dx += stride) {
        const x = chosen.x + dx;
        if (x < entry.minX || x > entry.maxX) continue;
        for (let dy = -reach; dy <= reach; dy += stride) {
          const y = chosen.y + dy;
          if (y < entry.minY || y > entry.maxY) continue;
          const candidate = score(state, chosen.rotation, x, y);
          if (better(candidate, best) && !blocked(x, y)) best = candidate;
        }
      }
      if (best !== null) return best;
    }
    return chosen;
  };

  const commit = (state: SheetState, gene: Gene, chosen: Candidate, solidArea: number): void => {
    const candidate = snap(state, chosen);
    state.placed.push({ part: gene.part, rotation: candidate.rotation, x: candidate.x, y: candidate.y });
    state.usedX = Math.max(state.usedX, candidate.x + candidate.rotation.tMaxX);
    state.usedY = Math.max(state.usedY, candidate.y + candidate.rotation.tMaxY);
    state.freeArea -= solidArea;
  };

  for (let g = 0; g < genes.length; g++) {
    const gene = genes[g];
    if (gene === undefined) continue;
    const part = prepared.parts[gene.part];
    if (part === undefined || part.rotations.length === 0) continue;
    const fixed = gene.rotation >= 0 ? part.rotations[gene.rotation % part.rotations.length] : undefined;
    const rotations = fixed !== undefined ? [fixed] : part.rotations;
    let done = false;
    for (let s = 0; s < sheets.length && !done; s++) {
      const state = sheets[s];
      if (state === undefined || part.solidArea > state.freeArea * (1 + 1e-9)) continue;
      const best = find(state, rotations);
      if (best !== null) {
        commit(state, gene, best, part.solidArea);
        sheetOf[g] = s;
        done = true;
      }
    }
    if (done) continue;
    const state: SheetState = {
      placed: [],
      usedX: 0,
      usedY: 0,
      free: new Map(),
      full: new Set(),
      freeArea: sheetArea,
    };
    const best = find(state, rotations);
    if (best === null) continue;
    sheets.push(state);
    commit(state, gene, best, part.solidArea);
    sheetOf[g] = sheets.length - 1;
  }
  return { sheets, sheetOf };
}
