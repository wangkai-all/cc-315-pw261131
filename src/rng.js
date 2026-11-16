/**
 * Small deterministic PRNG helpers. No external dependencies so every backtest
 * and forecast draw can be reproduced from a documented seed.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal with a deterministic stream. */
export function normal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(rand, sigma, meanAdjust = true) {
  const z = normal(rand);
  const mu = meanAdjust ? -(sigma * sigma) / 2 : 0;
  return Math.exp(mu + sigma * z);
}

export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick from a list with deterministic RNG. */
export function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}
