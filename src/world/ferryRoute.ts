// Fun queue 2, item 11: the Calamity Shuttle's road and timetable. Pure numbers, no meshes: the route (island harbour to the
// Muddle River landing below Threadbare Dam), the speed along it, and where each ferry is for any minute of the town clock.
//
// The route: Pelican Landing's T-jetty east of the pier, out past the lighthouse, north up the east coast of the island and
// the mainland, round its north-east corner, into the river mouth, then upstream (south) to the wharf below the Main St
// bridge. A ferry docks bow-on to its arrival heading and, leaving, turns round in the turning basin beside the dock
// (a half circle), so the two directions are separate paths; out at sea each keeps to the right of the other.
//
// The clock: the sky's hour (game minutes, one a real second at the normal rate), the way the train reads it. One cycle is
// CYCLE minutes (a divisor of the day, so nothing jumps at midnight): stand at the harbour, sail to the landing, stand,
// sail back. Two ferries run half a cycle apart, so each dock sees a sailing every CYCLE / 2 minutes.

import { riverX } from './mainland';

export type V2 = readonly [number, number];

export const CYCLE = 720;
export const FERRIES = 2;
/** A ferry's number in the state frame's `color` (id << 8 | seat): 140 and 141. Buses use 1..12, the Budget Line's coaches 129 and 130. */
export const FERRY_RIDE_BASE = 140;

export interface Dock {
  name: string;
  /** The board's big word. */
  sign: string;
  sub: string;
  /** Where the ferry's middle stands and which way its bow points while it is in (heading h: forward is (sin h, cos h)). */
  x: number; z: number; h: number;
  /** The deck she steps off onto, and its height. */
  ex: number; ez: number; ey: number;
  /** Where the prompt works: a box, and the part of it that is the dock itself. */
  zone: { x0: number; z0: number; x1: number; z1: number };
}

export const DOCKS: readonly Dock[] = [
  {
    name: 'Pelican Landing', sign: 'PELICAN LANDING', sub: 'Island harbour, east of the pier',
    x: 140, z: 564.2, h: -Math.PI / 2, ex: 142.4, ez: 560, ey: 0.4,
    zone: { x0: 115, z0: 546, x1: 165, z1: 563.2 },
  },
  {
    name: 'Tepid Falls Landing', sign: 'TEPID FALLS LANDING', sub: 'Muddle River, below the dam',
    x: 300.8, z: -1722, h: 0, ex: 295, ez: -1722, ey: 1.0,
    zone: { x0: 276, z0: -1742, x1: 298.6, z1: -1702 },
  },
];

// ── The path ──

const R_TURN = 18;
const pts = (a: V2[]): V2[] => a;
/** Points on a circle of radius r about (cx, cz) from angle a0 to a1 (radians; x = cx + r cos a, z = cz + r sin a). */
function arc(cx: number, cz: number, a0: number, a1: number): V2[] {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12))), out: V2[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push([cx + R_TURN * Math.cos(a), cz + R_TURN * Math.sin(a)]); }
  return out;
}

const D = DOCKS;
// The harbour end. Arrival heads west along the T-jetty's south face; leaving turns left (south) in the basin and heads east.
const H_IN = pts([[230, 625], [205, 592], [182, 574], [165, 565.6], [152, 564.2], [D[0].x, D[0].z]]);
const H_OUT: V2[] = [[D[0].x, D[0].z], [D[0].x - 14, D[0].z], ...arc(D[0].x - 14, D[0].z + R_TURN, -Math.PI / 2, -3 * Math.PI / 2).slice(1), [D[0].x - 14 + 40, D[0].z + 2 * R_TURN + 6]];
// The river end. Arrival heads south to the wharf; leaving turns left (east) in the basin and heads north.
const RX = (z: number): number => riverX(z);
const R_IN = pts([[RX(-1790), -1790], [330, -1762], [310, -1745], [D[1].x, D[1].z - 13], [D[1].x, D[1].z]]);
const R_OUT: V2[] = [[D[1].x, D[1].z], [D[1].x, D[1].z + 14], ...arc(D[1].x + R_TURN, D[1].z + 14, Math.PI, 0).slice(1), [D[1].x + 2 * R_TURN + 1.5, D[1].z - 8], [D[1].x + 2 * R_TURN + 3, -1760], [RX(-1790), -1790]];

/** The middle line from the harbour to the river, in the direction harbour -> river. */
const CENTER: V2[] = (() => {
  const c: V2[] = [
    [230, 625], [330, 650], [520, 662], [760, 656], [950, 575], [1040, 400], [1062, 100], [1060, -400], [1060, -1000],
    [1058, -1800], [1060, -2500], [1048, -2860], [1000, -3030], [900, -3125], [750, -3170], [590, -3175], [460, -3150],
    [385, -3100], [352, -3040],
  ];
  for (let z = -2990; z < -1795; z += 40) c.push([RX(z), z]);
  c.push([RX(-1790), -1790]);
  return c;
})();

/** Dense points through a rough polyline (centripetal Catmull-Rom). */
function spline(a: V2[], step: number): [number, number][] {
  const out: [number, number][] = [];
  const P = (i: number): V2 => a[Math.max(0, Math.min(a.length - 1, i))];
  for (let i = 0; i < a.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (u0: number, u1: number, u2: number, u3: number): number => 0.5 * (2 * u1 + (-u0 + u2) * t + (2 * u0 - 5 * u1 + 4 * u2 - u3) * t2 + (-u0 + 3 * u1 - 3 * u2 + u3) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([a[a.length - 1][0], a[a.length - 1][1]]);
  return out;
}

/** The middle line offset to the right of its direction of travel by `lane`, easing to nothing within FADE of either end. */
function lane(a: V2[], lanem: number, reverse: boolean): V2[] {
  const n = a.length, out: V2[] = [];
  const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]));
  const L = cum[n - 1], FADE = 260;
  for (let i = 0; i < n; i++) {
    const p = a[Math.max(0, i - 1)], q = a[Math.min(n - 1, i + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (reverse) { dx = -dx; dz = -dz; }
    const k = Math.max(0, Math.min(1, Math.min(cum[i], L - cum[i]) / FADE)), s = k * k * (3 - 2 * k) * lanem;
    out.push([a[i][0] + -dz * s, a[i][1] + dx * s]);
  }
  return reverse ? out.reverse() : out;
}

export interface Path {
  n: number; ds: number; len: number;
  x: Float32Array; z: Float32Array; h: Float32Array;
  /** Seconds (game minutes) to reach each sample from the start. */
  t: Float64Array;
  total: number;
}

const DS = 2;

function build(a: V2[], vmax: number): Path {
  const d = spline(a, 4);
  // Resample evenly.
  const cum = [0]; for (let i = 1; i < d.length; i++) cum.push(cum[i - 1] + Math.hypot(d[i][0] - d[i - 1][0], d[i][1] - d[i - 1][1]));
  const len = cum[cum.length - 1], n = Math.floor(len / DS) + 1;
  const x = new Float32Array(n), z = new Float32Array(n), h = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(len, i * DS);
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    x[i] = d[j][0] + (d[j + 1][0] - d[j][0]) * f; z[i] = d[j][1] + (d[j + 1][1] - d[j][1]) * f;
  }
  // Heading from the points a few either side; kept continuous.
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, i - 3), q = Math.min(n - 1, i + 3);
    let a0 = Math.atan2(x[q] - x[p], z[q] - z[p]);
    if (i > 0) { while (a0 - prev > Math.PI) a0 -= 2 * Math.PI; while (a0 - prev < -Math.PI) a0 += 2 * Math.PI; }
    h[i] = a0; prev = a0;
  }
  // Speed: the cruise, slower in the river, slower in the turns; then no more than it can gain or shed along the way.
  const v = new Float64Array(n), ACC = 1.6, DEC = 1.4, ALAT = 2.4;
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, i - 5), q = Math.min(n - 1, i + 5);
    const kappa = Math.abs(h[q] - h[p]) / ((q - p) * DS);
    const river = z[i] > -3010 && x[i] < 480;
    v[i] = Math.min(river ? Math.min(vmax, 20) : vmax, Math.sqrt(ALAT / Math.max(kappa, 1e-4)));
  }
  v[0] = 0; v[n - 1] = 0;
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * ACC * DS));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * DEC * DS));
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + 2 * DS / (Math.max(v[i - 1], 0.4) + Math.max(v[i], 0.4));
  return { n, ds: DS, len, x, z, h, t, total: t[n - 1] };
}

export interface Plan { ab: Path; ba: Path; vmax: number; dwell: number; length: number }

function makePlan(): Plan {
  const flat = (...parts: V2[][]): V2[] => { const o: V2[] = []; for (const p of parts) for (const q of p) { const l = o[o.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.5) o.push(q); } return o; };
  const LANE = 7;
  const out = lane(CENTER, LANE, false), back = lane(CENTER, LANE, true);
  // AB: from the harbour berth, round the basin, out along the right-hand lane, and in to the wharf.
  const abPts = flat(H_OUT, out.slice(0), R_IN.slice(1));
  // BA: from the wharf, round the basin, down the lane back (CENTER reversed), and in to the harbour berth.
  const baPts = flat(R_OUT, back.slice(0), H_IN.slice(1));
  let best: Plan | null = null;
  for (let V = 24; V <= 44; V += 1) {
    const ab = build(abPts, V), ba = build(baPts, V), dwell = (CYCLE - ab.total - ba.total) / 2;
    best = { ab, ba, vmax: V, dwell, length: (ab.len + ba.len) / 2 };
    if (dwell >= 38) break;
  }
  return best!;
}

let plan: Plan | null = null;
export const ferryPlan = (): Plan => (plan ??= makePlan());

// ── Where a ferry is ──

export interface FerryPose {
  x: number; z: number; h: number;
  /** Speed along the path, m/s (0 standing). */
  v: number;
  /** 0 standing at a dock, 1 sailing. */
  state: 0 | 1;
  /** The dock index while standing, else -1; and which way the leg goes (1: to the river landing, -1: back to the harbour). */
  dock: number; dir: 1 | -1;
  /** Minutes until it leaves (standing) or arrives (sailing). */
  left: number;
  /** The leg's progress 0..1. */
  frac: number;
}

const wrap = (m: number): number => ((m % CYCLE) + CYCLE) % CYCLE;

/** Ferry i's phase in its cycle at town-clock minute m. */
export const cycleAt = (m: number, i: number): number => wrap(m + i * (CYCLE / FERRIES));

function sample(p: Path, tau: number, out: FerryPose): void {
  tau = Math.max(0, Math.min(p.total, tau));
  let lo = 0, hi = p.n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.t[mid] <= tau) lo = mid; else hi = mid; }
  const dt = Math.max(1e-6, p.t[hi] - p.t[lo]), f = Math.max(0, Math.min(1, (tau - p.t[lo]) / dt));
  out.x = p.x[lo] + (p.x[hi] - p.x[lo]) * f; out.z = p.z[lo] + (p.z[hi] - p.z[lo]) * f;
  out.h = p.h[lo] + (p.h[hi] - p.h[lo]) * f;
  out.v = p.ds / dt;
  out.frac = tau / p.total;
}

export function ferryPose(m: number, i: number, out: FerryPose): FerryPose {
  const P = ferryPlan(), u = cycleAt(m, i), d = P.dwell, ab = P.ab, ba = P.ba;
  if (u < d) {
    sample(ba, ba.total, out); out.v = 0; out.state = 0; out.dock = 0; out.dir = 1; out.left = d - u; out.frac = 0;
  } else if (u < d + ab.total) {
    sample(ab, u - d, out); out.state = 1; out.dock = -1; out.dir = 1; out.left = d + ab.total - u;
  } else if (u < 2 * d + ab.total) {
    sample(ab, ab.total, out); out.v = 0; out.state = 0; out.dock = 1; out.dir = -1; out.left = 2 * d + ab.total - u; out.frac = 0;
  } else {
    sample(ba, u - 2 * d - ab.total, out); out.state = 1; out.dock = -1; out.dir = -1; out.left = CYCLE - u;
  }
  return out;
}

/** Minutes from now until ferry i is next standing at `dock` (0 if it is now), and how long it stays. */
export function untilDock(m: number, i: number, dock: number): { eta: number; stay: number } {
  const P = ferryPlan(), u = cycleAt(m, i), d = P.dwell;
  const s0 = dock === 0 ? 0 : d + P.ab.total, s1 = s0 + d;
  if (u >= s0 && u < s1) return { eta: 0, stay: s1 - u };
  return { eta: wrap(s0 - u), stay: d };
}

/** The town-clock minutes of day at which a ferry leaves `dock`, for the timetable boards: sorted, within a day. */
export function departures(dock: number): number[] {
  const P = ferryPlan(), d = P.dwell, out: number[] = [];
  for (let i = 0; i < FERRIES; i++) {
    // Leaves when its cycle phase is s1 (the end of its stay).
    const s1 = (dock === 0 ? 0 : d + P.ab.total) + d, off = (i * CYCLE) / FERRIES;
    for (let day = 0; day < 1440 / CYCLE; day++) out.push(wrap(s1 - off) + day * CYCLE);
  }
  return out.sort((a, b) => a - b);
}
