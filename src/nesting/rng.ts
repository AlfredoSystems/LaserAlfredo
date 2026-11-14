/** A seeded random number generator. Same seed, same sequence, on every machine. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). Returns 0 when n is 1 or less. */
  int(n: number): number;
}

/** mulberry32: small, fast and good enough to drive a search. */
export function createRng(seed: number): Rng {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n: number): number {
      return n <= 1 ? 0 : Math.floor(next() * n);
    },
  };
}
