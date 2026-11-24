// Johnson Pond at Dithers College (new streets only), as numbers: its shoreline, its water level, and the basin the
// hillside is cut and banked into to hold it. Pure functions, no rendering: mainland.ts folds the basin into the natural
// ground (so the terrain mesh, the physics and everything draped on groundAt() agree), ground.ts draws the terrain
// patch, the water, the reeds and the stones, and dithersCampus.ts keeps its paths out of it.
//
// The traced outline (dithersPlan.ts CAMPUS_POND) lay across Cherry Tree St and ran from the foot of the hill to its
// top, 9 m of fall: no level sheet of water fits that. This outline is the same pond pulled back 12 m from the road and
// 11 m from the halls and kept to the bench of the slope; the hill is cut on the uphill side and banked up on the road
// side to one rim.
import { smooth } from '../core/util';

/** Shoreline corners before rounding (x, z pairs, clockwise seen from above with north up). */
const RAW = [
  -561, -2462, -565, -2470, -566, -2479, -563, -2486, -557, -2491, -550, -2496, -544, -2501.5, -538, -2506, -530, -2512.5,
  -523.5, -2518.5, -516.5, -2523, -510, -2524, -506.5, -2520.5, -507, -2513, -509.5, -2504, -512, -2495, -519, -2487.5,
  -529, -2482.5, -537, -2476, -543, -2467, -549, -2460, -555, -2458.5,
];
/** Corner cutting, twice: the corners above become a smooth closed curve. */
function round(p: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    out.push(p[i] * 0.75 + p[j] * 0.25, p[i + 1] * 0.75 + p[j + 1] * 0.25, p[i] * 0.25 + p[j] * 0.75, p[i + 1] * 0.25 + p[j + 1] * 0.75);
  }
  return out;
}
/** The shoreline: where the still water meets the bank. */
export const POND_SHORE: number[] = round(round(RAW));
/** Height of the water's surface. */
export const POND_LEVEL = 11.2;
/** How far outside the shore the ground is reshaped. */
export const POND_BANK = 17;
/** Everything the basin touches lies inside this box. Its sides are on the terrain mesh's 8 m lattice (ground.ts mainTerrain), which draws the inside finer. */
export const POND_BOX = { x0: -584, z0: -2544, x1: -488, z1: -2440 };

/**
 * The lookout: a gravel pad on a low knoll between Cherry Tree St's sidewalk and the water, a metre above the walk so
 * a standing player looks over the bank to the pond (the road's own sidewalk stands higher than a driver's eye, and the
 * hill hides the water from it).
 * dithersProps.ts puts a bench and a railing on it.
 */
export const LOOKOUT = { x: -570.5, z: -2475, hx: 2, hz: 4, blend: 6, y: 11.6 };
/** How much of the knoll stands at (x, z): 1 on the flat pad, 0 beyond the blend. */
export function lookoutW(x: number, z: number): number {
  const L = LOOKOUT, d = Math.hypot(Math.max(Math.abs(x - L.x) - L.hx, 0), Math.max(Math.abs(z - L.z) - L.hz, 0));
  return 1 - smooth(d / L.blend);
}

/** Signed distance to the shoreline: negative in the water. */
export function pondSD(x: number, z: number): number {
  const p = POND_SHORE;
  let d2 = 1e18, inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const qx = ax + dx * t - x, qz = az + dz * t - z;
    d2 = Math.min(d2, qx * qx + qz * qz);
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
  }
  return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
}

/** The ground with the basin in it, given the hillside's own height there: bed, a rim a hand above the water, and the bank out to POND_BANK. */
function shaped(sd: number, nat: number): number {
  // The rim and two metres of bank stand a hand above the water whatever the hill does; inside, the bed shelves away.
  if (sd < 2) return POND_LEVEL + 0.3 - 2.4 * smooth((2 - sd) / 11);
  if (sd >= POND_BANK) return nat;
  return POND_LEVEL + 0.3 + (nat - POND_LEVEL - 0.3) * smooth((sd - 2) / (POND_BANK - 2));
}

// The basin is kept as a 2 m lattice of differences from the bare hill, built on first use. ground.ts draws the same
// lattice, so what is stood on is what is seen.
export const POND_STEP = 2;
const NX = (POND_BOX.x1 - POND_BOX.x0) / POND_STEP, NZ = (POND_BOX.z1 - POND_BOX.z0) / POND_STEP;
let delta: Float32Array | null = null;
let sdGrid: Float32Array | null = null;

function distances(): Float32Array {
  if (sdGrid) return sdGrid;
  sdGrid = new Float32Array((NX + 1) * (NZ + 1));
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) sdGrid[j * (NX + 1) + i] = pondSD(POND_BOX.x0 + i * POND_STEP, POND_BOX.z0 + j * POND_STEP);
  return sdGrid;
}

const lookoutLift = (x: number, z: number, g: number, sd: number): number => g + lookoutW(x, z) * smooth(sd / 2) * (LOOKOUT.y - g);

function build(hill: (x: number, z: number) => number): void {
  const sds = distances();
  delta = new Float32Array((NX + 1) * (NZ + 1));
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) {
    const x = POND_BOX.x0 + i * POND_STEP, z = POND_BOX.z0 + j * POND_STEP, sd = sds[j * (NX + 1) + i], nat = hill(x, z);
    // Nothing changes on the box's own edge, whatever the numbers say.
    delta[j * (NX + 1) + i] = i === 0 || j === 0 || i === NX || j === NZ ? 0 : lookoutLift(x, z, shaped(sd, nat), sd) - nat;
  }
}

const lerp2 = (g: Float32Array, x: number, z: number): number => {
  const fx = (x - POND_BOX.x0) / POND_STEP, fz = (z - POND_BOX.z0) / POND_STEP;
  const i = Math.min(NX - 1, Math.max(0, Math.floor(fx))), j = Math.min(NZ - 1, Math.max(0, Math.floor(fz))), u = fx - i, v = fz - j, c = j * (NX + 1) + i;
  return (g[c] * (1 - u) + g[c + 1] * u) * (1 - v) + (g[c + NX + 1] * (1 - u) + g[c + NX + 2] * u) * v;
};

export const inPondBox = (x: number, z: number): boolean => x > POND_BOX.x0 && x < POND_BOX.x1 && z > POND_BOX.z0 && z < POND_BOX.z1;

/** What the basin adds to (or cuts from) the bare hillside at (x, z); 0 outside the box. `hill` is the ground without it. */
export function pondDelta(x: number, z: number, hill: (x: number, z: number) => number): number {
  if (!inPondBox(x, z)) return 0;
  if (!delta) build(hill);
  return lerp2(delta!, x, z);
}

/** Distance to the shore from the lattice (smooth, cheap): negative in the water, large outside the box. */
export function pondNear(x: number, z: number): number {
  if (!inPondBox(x, z)) return 1e9;
  return lerp2(distances(), x, z);
}
