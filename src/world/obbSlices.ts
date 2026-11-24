/**
 * Collision for a rotated rectangle. collide.ts holds only axis-aligned boxes, so a building set at an angle is
 * cut into narrow slices across its long side, and each slice is the biggest axis box that fits INSIDE the true
 * footprint (never the bounds of the slice, which stuck out into the road). The gap left under a slanted edge is
 * at most slope x width, about half a metre.
 */
export type SliceCb = (x0: number, z0: number, x1: number, z1: number) => void;

/** Corners c = [x0,z0, x1,z1, x2,z2, x3,z3] in order around the rectangle. */
export function obbSlices(c: ArrayLike<number>, cb: SliceCb, width = 1): void {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < 8; i += 2) { minX = Math.min(minX, c[i]); maxX = Math.max(maxX, c[i]); minZ = Math.min(minZ, c[i + 1]); maxZ = Math.max(maxZ, c[i + 1]); }
  if (maxX - minX < 1e-3 || maxZ - minZ < 1e-3) return;
  // Axis-aligned (to within a hair): one box.
  const ex = Math.abs(c[2] - c[0]) + Math.abs(c[6] - c[4]), ez = Math.abs(c[3] - c[1]) + Math.abs(c[7] - c[5]);
  if (Math.min(ex, ez) < 0.04 * (ex + ez)) { cb(minX, minZ, maxX, maxZ); return; }
  // Slice along the axis the long edge leans toward.
  const l01 = Math.hypot(c[2] - c[0], c[3] - c[1]), l12 = Math.hypot(c[4] - c[2], c[5] - c[3]);
  const lx = l01 >= l12 ? c[2] - c[0] : c[4] - c[2], lz = l01 >= l12 ? c[3] - c[1] : c[5] - c[3];
  const alongX = Math.abs(lx) >= Math.abs(lz);
  const P: number[] = alongX ? Array.from(c).slice(0, 8) : [c[1], c[0], c[3], c[2], c[5], c[4], c[7], c[6]];
  const a0 = alongX ? minX : minZ, a1 = alongX ? maxX : maxZ;
  /** Range of the second coordinate where the vertical line u = a meets the polygon. */
  const span = (a: number): [number, number] => {
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) % 8, ux = P[i], uz = P[i + 1], vx = P[j], vz = P[j + 1];
      if ((ux - a) * (vx - a) > 0) continue;
      const t = vx === ux ? 0 : (a - ux) / (vx - ux), z = uz + (vz - uz) * t;
      lo = Math.min(lo, z); hi = Math.max(hi, z);
      if (vx === ux) { lo = Math.min(lo, vz); hi = Math.max(hi, vz); }
    }
    return [lo, hi];
  };
  const n = Math.min(90, Math.max(1, Math.ceil((a1 - a0) / width)));
  for (let i = 0; i < n; i++) {
    const s = a0 + ((a1 - a0) * i) / n, e = a0 + ((a1 - a0) * (i + 1)) / n;
    const A = span(s), B = span(e);
    const lo = Math.max(A[0], B[0]), hi = Math.min(A[1], B[1]);
    if (!(hi - lo > 0.05) || A[0] > 1e8 || B[0] > 1e8) continue;
    if (alongX) cb(s, lo, e, hi); else cb(lo, s, hi, e);
  }
}
