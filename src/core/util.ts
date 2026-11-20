// Shared math helpers and conventions.
//
// World conventions (everything in the game relies on these):
//   * Units are meters and seconds. Y is up.
//   * East = +X, South = +Z, North = -Z.
//   * A heading `h` is a rotation about Y. Forward = (sin h, 0, cos h).
//     Facing +Z, the +X axis is on your LEFT, so Right = (-cos h, 0, sin h)
//     and turning right DEcreases the heading.

export const TAU = Math.PI * 2;
export const MPH = 2.23694; // m/s -> mph

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const sign = (v: number): number => (v < 0 ? -1 : 1);

/** Frame-rate independent exponential approach of `a` toward `b`. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  a + (b - a) * (1 - Math.exp(-lambda * dt));

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Shortest signed rotation that takes heading `from` to heading `to`. */
export const angleDiff = (from: number, to: number): number => wrapAngle(to - from);
export const dampAngle = (a: number, b: number, lambda: number, dt: number): number =>
  a + angleDiff(a, b) * (1 - Math.exp(-lambda * dt));

/** Heading whose forward vector points along (dx, dz). */
export const headingOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};
export const dist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.sqrt(dist2(ax, az, bx, bz));

/** Small deterministic PRNG so the city is identical on every load. */
export class RNG {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  sign(): number { return this.next() < 0.5 ? -1 : 1; }
}

/** Cheap hash-based value noise in 2D, range 0..1. */
export function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise2(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = smooth(x - xi), fz = smooth(z - zi);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}

export const money = (n: number): string => '$' + Math.floor(n).toLocaleString('en-US');

/** Ambient non-gameplay randomness (effects, barks). Gameplay layout uses RNG. */
export const rand = (a = 1, b?: number): number =>
  b === undefined ? Math.random() * a : a + Math.random() * (b - a);
export const pickRand = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ── Instance buffers ─────────────────────────────────────────────────────────
// Sending a buffer to the GPU costs far more than its bytes on the laptop GPUs this game is tuned on (M6 measured
// 50 to 300 microseconds each, 5 to 10 ms a frame for the hundred the game used to send), so anything that refills
// an instance buffer writes through putChanged() and only calls sendRange() (core/flip.ts) when a value really changed.

/** Copy `len` values from `src[from..]` to `dst[at..]`; true if any of them was different from what was there. */
export function putChanged(dst: Float32Array, at: number, src: Float32Array, from: number, len: number): boolean {
  let ch = false;
  for (let j = 0; j < len; j++) { const v = src[from + j]; if (dst[at + j] !== v) { dst[at + j] = v; ch = true; } }
  return ch;
}
