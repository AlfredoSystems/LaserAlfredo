import { OBJECTIVES } from './layout';
import type { Gene, Layout, Objective } from './layout';
import type { Prepared } from './prepare';
import type { Rng } from './rng';

/**
 * The search over layouts: which copy goes first, how each copy is turned and
 * how positions are scored. A steady-state genetic algorithm that proposes
 * one candidate at a time, so every engine step is one layout.
 */

export interface Genome {
  /** Copy indices in placement order. */
  readonly order: Int32Array;
  /** Per copy index: rotation index, or -1 for "best of all rotations". */
  readonly rotation: Int16Array;
  readonly objective: number;
}

interface Individual {
  readonly genome: Genome;
  readonly fitness: number;
  /** Positions in `order` worth moving earlier: the copies that set the result's length. */
  readonly critical: readonly number[];
}

export interface Search {
  /** The next layout to try, or null when every layout has been tried. */
  next(): Genome | null;
  /** Reports how the genome returned by `next` turned out. */
  report(genome: Genome, fitness: number, layout: Layout): void;
  genes(genome: Genome): Gene[];
  objective(genome: Genome): Objective;
  /** Part index of each copy. */
  readonly copyPart: Int32Array;
}

const POPULATION = 16;
/** Search spaces up to this size are walked completely, after which the search ends. */
const ENUMERATE_LIMIT = 3000;
const SEEN_LIMIT = 200000;

export function createSearch(prepared: Prepared, rng: Rng): Search {
  const copies: number[] = [];
  for (const part of prepared.parts) {
    if (part.rotations.length === 0) continue;
    for (let i = 0; i < part.count; i++) copies.push(part.index);
  }
  const n = copies.length;
  const copyPart = Int32Array.from(copies);
  const rotationCount = (copy: number): number => prepared.parts[copyPart[copy] ?? 0]?.rotations.length ?? 1;
  const anyRotation = copies.some((_, copy) => rotationCount(copy) > 1);
  // With a single copy every scoring rule picks the same corner.
  const objectives = n > 1 ? OBJECTIVES.length : 1;

  // Size of the search space, counting identical copies once.
  let space = objectives;
  {
    let placed = 0;
    for (const part of prepared.parts) {
      if (part.rotations.length === 0) continue;
      const options = part.rotations.length > 1 ? part.rotations.length + 1 : 1;
      for (let i = 1; i <= part.count; i++) {
        placed += 1;
        space = (space * placed * options) / i;
        if (space > 1e15) space = 1e15;
      }
    }
  }

  /**
   * A 52-bit hash of what the genome means: identical copies are
   * interchangeable and a part with one rotation has nothing to choose.
   */
  const signature = (genome: Genome): number => {
    let h1 = 0x811c9dc5 ^ genome.objective;
    let h2 = 0x9e3779b9;
    for (const copy of genome.order) {
      const rot = rotationCount(copy) > 1 ? (genome.rotation[copy] ?? -1) : 0;
      const token = (copyPart[copy] ?? 0) * 131 + rot + 1;
      h1 = Math.imul(h1 ^ token, 0x01000193);
      h2 = Math.imul(h2 + token, 0x85ebca6b);
      h2 ^= h2 >>> 13;
    }
    return (h1 >>> 0) * 0x100000 + ((h2 >>> 0) & 0xfffff);
  };

  const seen = new Set<number>();
  const population: Individual[] = [];

  const sizeOf = (copy: number): { area: number; width: number; height: number } => {
    const part = prepared.parts[copyPart[copy] ?? 0];
    const rot = part?.rotations[0];
    if (part === undefined || rot === undefined) return { area: 0, width: 0, height: 0 };
    const width = rot.tMaxX - rot.tMinX;
    const height = rot.tMaxY - rot.tMinY;
    // Open paths have no area of their own; their bounding box stands in.
    return { area: part.areaMm2 > 0 ? part.areaMm2 * prepared.scale * prepared.scale : width * height * 0.5, width, height };
  };
  const sizes = copies.map((_, copy) => sizeOf(copy));
  const sortedBy = (value: (copy: number) => number): Int32Array => {
    const order = copies.map((_, copy) => copy);
    order.sort((a, b) => value(b) - value(a) || a - b);
    return Int32Array.from(order);
  };
  const shuffled = (): Int32Array => {
    const order = Int32Array.from(copies.map((_, copy) => copy));
    for (let i = n - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const a = order[i] ?? 0;
      order[i] = order[j] ?? 0;
      order[j] = a;
    }
    return order;
  };
  const allAuto = (): Int16Array => new Int16Array(n).fill(-1);
  const byArea = sortedBy((copy) => sizes[copy]?.area ?? 0);

  // Opening moves: cheap first, then the strongest rules of thumb.
  const openings: Genome[] = [{ order: byArea, rotation: new Int16Array(n), objective: 0 }];
  for (let objective = 0; objective < objectives; objective++) {
    openings.push({ order: byArea, rotation: allAuto(), objective });
  }
  openings.push(
    { order: sortedBy((copy) => Math.max(sizes[copy]?.width ?? 0, sizes[copy]?.height ?? 0)), rotation: allAuto(), objective: 0 },
    { order: sortedBy((copy) => sizes[copy]?.height ?? 0), rotation: allAuto(), objective: 0 },
    { order: sortedBy((copy) => sizes[copy]?.width ?? 0), rotation: allAuto(), objective: 0 },
  );
  let opening = 0;

  let enumeration: Genome[] | null = null;
  let enumerated = 0;

  /** Every distinct genome, for small search spaces. */
  const enumerate = (): Genome[] => {
    const all: Genome[] = [];
    const remaining = new Map<number, number[]>();
    copies.forEach((part, copy) => {
      const list = remaining.get(part);
      if (list === undefined) remaining.set(part, [copy]);
      else list.push(copy);
    });
    const partIds = [...remaining.keys()];
    const order = new Int32Array(n);
    const rotation = new Int16Array(n);
    const walk = (depth: number): void => {
      if (depth === n) {
        for (let objective = 0; objective < objectives; objective++) {
          all.push({ order: order.slice(), rotation: rotation.slice(), objective });
        }
        return;
      }
      for (const part of partIds) {
        const list = remaining.get(part);
        const copy = list?.pop();
        if (list === undefined || copy === undefined) continue;
        order[depth] = copy;
        const count = rotationCount(copy);
        for (let rot = count > 1 ? -1 : 0; rot < count; rot++) {
          rotation[copy] = rot;
          walk(depth + 1);
        }
        list.push(copy);
      }
    };
    walk(0);
    for (let i = all.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const a = all[i];
      const b = all[j];
      if (a !== undefined && b !== undefined) {
        all[i] = b;
        all[j] = a;
      }
    }
    return all;
  };

  const pick = (): Individual | undefined => {
    const a = rng.int(population.length);
    const b = rng.int(population.length);
    // The population is sorted, best first.
    return population[Math.min(a, b)];
  };

  const mutate = (order: Int32Array, rotation: Int16Array, objective: number, critical: readonly number[]): number => {
    const roll = rng.next();
    const move = (from: number, to: number): void => {
      const copy = order[from] ?? 0;
      if (from < to) order.copyWithin(from, from + 1, to + 1);
      else order.copyWithin(to + 1, to, from);
      order[to] = copy;
    };
    if (roll < 0.05 && objectives > 1) {
      return (objective + 1 + rng.int(objectives - 1)) % objectives;
    }
    if (roll < 0.25 && anyRotation) {
      for (let tries = 0; tries < 8; tries++) {
        const copy = rng.int(n);
        const count = rotationCount(copy);
        if (count <= 1) continue;
        const current = rotation[copy] ?? -1;
        let value = current;
        while (value === current) value = rng.int(count + 1) - 1;
        rotation[copy] = value;
        break;
      }
      return objective;
    }
    if (n < 2) return objective;
    if (roll < 0.45 && critical.length > 0) {
      // Give a copy that sets the length an earlier, better pick of positions.
      const from = critical[rng.int(critical.length)] ?? 0;
      if (from > 0) move(from, rng.int(from));
      return objective;
    }
    if (roll < 0.7) {
      const a = rng.int(n);
      let b = rng.int(n);
      for (let tries = 0; tries < 6 && copyPart[order[a] ?? 0] === copyPart[order[b] ?? 0]; tries++) b = rng.int(n);
      const copy = order[a] ?? 0;
      order[a] = order[b] ?? 0;
      order[b] = copy;
      return objective;
    }
    if (roll < 0.93) {
      move(rng.int(n), rng.int(n));
      return objective;
    }
    let a = rng.int(n);
    let b = rng.int(n);
    if (a > b) [a, b] = [b, a];
    order.subarray(a, b + 1).reverse();
    return objective;
  };

  /** Order crossover: a slice of one parent, the rest in the other parent's order. */
  const crossover = (a: Genome, b: Genome): Genome => {
    let from = rng.int(n);
    let to = rng.int(n);
    if (from > to) [from, to] = [to, from];
    const order = new Int32Array(n);
    const used = new Uint8Array(n);
    for (let i = from; i <= to; i++) {
      const copy = a.order[i] ?? 0;
      order[i] = copy;
      used[copy] = 1;
    }
    let write = 0;
    for (const copy of b.order) {
      if (used[copy] === 1) continue;
      if (write === from) write = to + 1;
      order[write++] = copy;
    }
    const rotation = new Int16Array(n);
    for (let copy = 0; copy < n; copy++) {
      rotation[copy] = (rng.next() < 0.5 ? a.rotation[copy] : b.rotation[copy]) ?? -1;
    }
    return { order, rotation, objective: rng.next() < 0.5 ? a.objective : b.objective };
  };

  const propose = (): Genome => {
    const parent = pick();
    if (parent === undefined) return { order: shuffled(), rotation: allAuto(), objective: 0 };
    const roll = rng.next();
    if (roll < 0.04) return { order: shuffled(), rotation: allAuto(), objective: rng.int(objectives) };
    let base = parent.genome;
    let critical = parent.critical;
    if (roll < 0.3 && population.length > 1) {
      const other = pick();
      if (other !== undefined && other !== parent) {
        base = crossover(parent.genome, other.genome);
        critical = [];
        if (rng.next() < 0.5) return base;
      }
    }
    const order = base.order.slice();
    const rotation = base.rotation.slice();
    let objective = base.objective;
    do {
      objective = mutate(order, rotation, objective, critical);
      critical = [];
    } while (rng.next() < 0.35);
    return { order, rotation, objective };
  };

  const remember = (genome: Genome): boolean => {
    const key = signature(genome);
    if (seen.has(key)) return false;
    if (seen.size < SEEN_LIMIT) seen.add(key);
    return true;
  };

  return {
    copyPart,
    next() {
      if (n === 0) return null;
      while (opening < openings.length) {
        const genome = openings[opening++];
        if (genome !== undefined && remember(genome)) return genome;
      }
      if (space <= ENUMERATE_LIMIT) {
        enumeration ??= enumerate();
        while (enumerated < enumeration.length) {
          const genome = enumeration[enumerated++];
          if (genome !== undefined && remember(genome)) return genome;
        }
        return null;
      }
      for (let tries = 0; tries < 100; tries++) {
        const genome = propose();
        if (remember(genome)) return genome;
      }
      // Everything nearby has been tried: jump somewhere new.
      const genome: Genome = { order: shuffled(), rotation: allAuto(), objective: rng.int(objectives) };
      remember(genome);
      return genome;
    },
    report(genome, fitness, layout) {
      const worst = population[population.length - 1];
      if (population.length >= POPULATION && worst !== undefined && fitness >= worst.fitness) return;
      // The copies on the last sheet, or failing that the ones farthest right, hold the result back.
      const critical: number[] = [];
      const lastSheet = layout.sheets.length - 1;
      const last = layout.sheets[lastSheet];
      if (last !== undefined) {
        let seenOnLast = 0;
        for (let g = 0; g < layout.sheetOf.length; g++) {
          if (layout.sheetOf[g] !== lastSheet) continue;
          const placed = last.placed[seenOnLast++];
          if (placed === undefined) continue;
          const right = placed.x + placed.rotation.tMaxX;
          if (layout.sheets.length > 1 || right >= last.usedX * 0.9) critical.push(g);
        }
      }
      let at = population.findIndex((other) => fitness < other.fitness);
      if (at < 0) at = population.length;
      population.splice(at, 0, { genome, fitness, critical });
      if (population.length > POPULATION) population.pop();
    },
    genes(genome) {
      const genes: Gene[] = [];
      for (const copy of genome.order) {
        genes.push({ part: copyPart[copy] ?? 0, rotation: genome.rotation[copy] ?? -1 });
      }
      return genes;
    },
    objective(genome) {
      return OBJECTIVES[genome.objective] ?? 'length';
    },
  };
}
