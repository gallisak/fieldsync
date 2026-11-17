/** A small seeded generator: the same seed always yields the same sequence of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 … n-1 */
export const int = (rng: () => number, n: number): number => Math.floor(rng() * n);
export const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[int(rng, xs.length)];
export const chance = (rng: () => number, p: number): boolean => rng() < p;
export const uuidFrom = (rng: () => number): string =>
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => int(rng, 16).toString(16));
