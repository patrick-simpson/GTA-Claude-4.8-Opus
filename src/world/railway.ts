/**
 * The Budget Line's alignment under the new streets (Fix B of the Tepid Falls audit).
 *
 * The real Waterville line runs north-south beside the Kennebec, not across town: it comes up the Winslow bank, crosses
 * the river by the dam, runs up the west bank past downtown, crosses back to the east bank and runs on to the big yard
 * and out of the north of the map. The waypoints below are OpenStreetMap's railway geometry warped the way the street
 * plan was (scratch/audit/rail_compare.json), smoothed, and nudged where a road already lies on the real line.
 * Nothing here is drawn or simulated: train.ts lays the track and runs the train, ground/mainland builders read the
 * corridor (railNear, RAILWAY.reserved) and the deck rectangles. ?streets=old has no railway here (RAILWAY is null).
 */
import { MAIN_Y, waterDist, type MRect } from './mainland';

const NEW = typeof location === 'undefined' || new URLSearchParams(location.search).get('streets') !== 'old';

/** The main line, south buffer to north buffer. */
const MAIN_WAYPOINTS: [number, number][] = [
  [404, -1032], [440, -1076], [492, -1140], [510, -1185], [500, -1236], [480, -1290], [450, -1345], [412, -1385],
  [372, -1415], [330, -1435], [296, -1455], [270, -1490], [255, -1540], [248, -1585], [240, -1630], [242, -1690],
  [246, -1770], [250, -1850], [268, -1930], [292, -2000], [308, -2080], [314, -2160],
  [312, -2240], [309, -2300], [302, -2350], [296, -2385], [289, -2420], [282, -2455], [276, -2500], [270, -2550], [267, -2600],
  [272, -2650], [278, -2700], [277, -2740], [272, -2790], [271, -2840], [277, -2880], [281, -2902],
];
/** Where the yard lead leaves the main line (the point on the main nearest this). */
const SWITCH_AT: [number, number] = [286, -2432];
/** The depot stands beside the straight west-bank run, at about this z. */
const DEPOT_Z = -1730;

export interface Trestle { s0: number; s1: number }
export interface Railway {
  /** Flat x,z pairs, one per metre of track from the south buffer (s = 0). */
  main: number[];
  /** The yard lead: flat x,z pairs from the point where it leaves the main line (its first point is main[swS]) to its buffer. */
  lead: number[];
  /** Index (metres) on the main line of the switch points. */
  swS: number;
  /** Yard sidings branching off the lead's straight: flat x,z pairs from the lead to a buffer. */
  sidings: number[][];
  /** Deck spans on the main line, in metres from the south buffer: trestles and bridges where the line is over water. */
  trestles: Trestle[];
  /** Walkable deck rectangles under the spans (mainland DECKS-style: the floor is MAIN_Y). */
  decks: MRect[];
  /** Rectangles that keep every lot, tree and lamp off the track and its bed. */
  reserved: MRect[];
  /** The depot: the main line's metre where the passenger train stops, and where the line runs there (x, z, heading). */
  depot: { s: number; x: number; z: number; h: number };
}

function catmull(w: [number, number][]): number[] {
  const n = w.length, out: number[] = [];
  const P = (i: number): [number, number] => w[Math.max(0, Math.min(n - 1, i))];
  const dist = (a: [number, number], b: [number, number]): number => Math.pow(Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, 0.5);
  for (let i = 0; i < n - 1; i++) {
    // Centripetal Catmull-Rom (alpha 0.5): no loops, no overshoot on uneven spacing.
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const t0 = 0, t1 = t0 + dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
    const steps = Math.max(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    for (let k = 0; k < steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps, c: number[] = [];
      for (let d = 0; d < 2; d++) {
        const a1 = ((t1 - t) * p0[d] + (t - t0) * p1[d]) / (t1 - t0), a2 = ((t2 - t) * p1[d] + (t - t1) * p2[d]) / (t2 - t1), a3 = ((t3 - t) * p2[d] + (t - t2) * p3[d]) / (t3 - t2);
        const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0), b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
        c.push(((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1));
      }
      out.push(c[0], c[1]);
    }
  }
  out.push(w[n - 1][0], w[n - 1][1]);
  return out;
}

/** Resample a polyline to one point per metre. */
function metres(p: number[]): number[] {
  const out: number[] = [p[0], p[1]];
  let acc = 0, px = p[0], pz = p[1];
  for (let k = 2; k < p.length; k += 2) {
    const x = p[k], z = p[k + 1];
    let d = Math.hypot(x - px, z - pz);
    while (acc + d >= 1) {
      const f = (1 - acc) / d;
      px += (x - px) * f; pz += (z - pz) * f; out.push(px, pz);
      d = Math.hypot(x - px, z - pz); acc = 0;
    }
    acc += d; px = x; pz = z;
  }
  return out;
}

function build(): Railway {
  const main = metres(catmull(MAIN_WAYPOINTS)), n = main.length / 2;
  // Switch point and the heading there.
  let swS = 0, bd = 1e9;
  for (let i = 0; i < n; i++) { const d = Math.hypot(main[2 * i] - SWITCH_AT[0], main[2 * i + 1] - SWITCH_AT[1]); if (d < bd) { bd = d; swS = i; } }
  const hd = (i: number): number => { const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2); return Math.atan2(main[2 * b] - main[2 * a], main[2 * b + 1] - main[2 * a + 1]); };
  // The lead: an S off the main to the west (left), 4.8 m across on R 45 curves (the place to derail), then straight and parallel.
  const lead: number[] = [main[2 * swS], main[2 * swS + 1]];
  const R = 45, TH = 0.33, h0 = hd(swS);
  let x = lead[0], z = lead[1];
  const arc = Math.floor(R * TH);
  for (let s = 1; s <= arc; s++) { const th = h0 + (s - 0.5) / R; x += Math.sin(th); z += Math.cos(th); lead.push(x, z); }
  for (let s = 1; s <= arc; s++) { const th = h0 + TH - (s - 0.5) / R; x += Math.sin(th); z += Math.cos(th); lead.push(x, z); }
  const straight0 = lead.length / 2 - 1, ux = Math.sin(h0), uz = Math.cos(h0);
  for (let s = 1; s <= 75; s++) { x += ux; z += uz; lead.push(x, z); }
  // Sidings: branch off the lead's straight further west (4.8 m spacing) by a smooth S, run parallel, end in a buffer.
  const sidings: number[][] = [];
  const nx = Math.cos(h0), nz = -Math.sin(h0);
  const p0x = lead[2 * straight0], p0z = lead[2 * straight0 + 1];
  for (const [t0, off, len] of [[4, 4.8, 70], [14, 9.6, 60]]) {
    const sd: number[] = [];
    for (let s = 0; s <= len; s++) {
      const f = Math.min(1, s / 28), o = off * f * f * (3 - 2 * f), a = t0 + s;
      sd.push(p0x + ux * a + nx * o, p0z + uz * a + nz * o);
    }
    sidings.push(sd);
  }
  // Trestles and bridges: the line's runs over the river's bank slope (and the brook), with a little run-on each side.
  const dil: boolean[] = new Array(n).fill(false), ext = 10;
  for (let i = 0; i < n; i++) if (waterDist(main[2 * i], main[2 * i + 1]) < 14) for (let j = Math.max(0, i - ext); j <= Math.min(n - 1, i + ext); j++) dil[j] = true;
  const trestles: Trestle[] = [];
  for (let i = 0; i < n; i++) if (dil[i]) { let j = i; while (j + 1 < n && dil[j + 1]) j++; trestles.push({ s0: i, s1: j }); i = j; }
  const decks: MRect[] = [];
  for (const t of trestles) for (let s = t.s0; s <= t.s1; s += 3) { const px = main[2 * s], pz = main[2 * s + 1]; decks.push({ x0: px - 2.7, z0: pz - 2.7, x1: px + 2.7, z1: pz + 2.7 }); }
  // The corridor: bounding boxes every 8 m along every track, grown by the bed's half-width and a margin.
  const reserved: MRect[] = [];
  const boxes = (p: number[], from = 0): void => {
    for (let i = from; i < p.length / 2; i += 8) {
      const j = Math.min(p.length / 2 - 1, i + 8), G = 8.5;
      reserved.push({ x0: Math.min(p[2 * i], p[2 * j]) - G, x1: Math.max(p[2 * i], p[2 * j]) + G, z0: Math.min(p[2 * i + 1], p[2 * j + 1]) - G, z1: Math.max(p[2 * i + 1], p[2 * j + 1]) + G });
    }
  };
  boxes(main); boxes(lead, 8); for (const s of sidings) boxes(s);
  // The depot, and the main line's heading there.
  let ds = 0; bd = 1e9;
  for (let i = 0; i < n; i++) { const d = Math.abs(main[2 * i + 1] - DEPOT_Z) + Math.abs(main[2 * i] - 262) * 0.1; if (d < bd) { bd = d; ds = i; } }
  const depot = { s: ds, x: main[2 * ds], z: main[2 * ds + 1], h: hd(ds) };
  return { main, lead, swS, sidings, trestles, decks, reserved, depot };
}

/** The new-streets railway; null under ?streets=old (which keeps its east-west line in mainland.ts RAIL). */
export const RAILWAY: Railway | null = NEW ? build() : null;

// ── Corridor queries ─────────────────────────────────────────────────────────

const CELL = 24;
let grid: Map<number, number[]> | null = null;
function gridOf(): Map<number, number[]> {
  if (grid) return grid;
  const g = new Map<number, number[]>();
  const add = (p: number[]): void => {
    for (let i = 0; i < p.length / 2; i += 2) {
      const k = Math.floor(p[2 * i] / CELL) * 4096 + Math.floor(p[2 * i + 1] / CELL);
      const a = g.get(k); if (a) a.push(p[2 * i], p[2 * i + 1]); else g.set(k, [p[2 * i], p[2 * i + 1]]);
    }
  };
  if (RAILWAY) { add(RAILWAY.main); add(RAILWAY.lead); for (const s of RAILWAY.sidings) add(s); }
  grid = g;
  return g;
}
/** True if (x, z) is within r metres (r up to about 20) of any track (main, lead, sidings) of the new railway. */
export function railNear(x: number, z: number, r: number): boolean {
  if (!RAILWAY) return false;
  const g = gridOf(), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), q = r + 1, r2 = q * q;
  for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
    const a = g.get(i * 4096 + j);
    if (a) for (let k = 0; k < a.length; k += 2) { const dx = a[k] - x, dz = a[k + 1] - z; if (dx * dx + dz * dz < r2) return true; }
  }
  return false;
}
/** True over a trestle or bridge deck of the main line (metal underfoot, no ground). */
export function onRailDeck(x: number, z: number): boolean {
  if (!RAILWAY) return false;
  for (const d of RAILWAY.decks) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return true;
  return false;
}
export const RAIL_DECK_Y = MAIN_Y + 0.15;
