// Fun queue 2, item 7: the Harbor Line, the town's bus routes (owner's brief: "bus routes you can ride as a passenger").
//
// Everything here is a pure function of the street graph and the shared signal clock, so every screen in a town builds
// the same lines and puts the same bus in the same place without a single message:
//   1. A line is a loop of waypoints; the A* of the street graph joins them; the drive is turned into a lane polyline
//      (the kerb lane, as buses keep to), corners rounded by a cubic through each junction's pad.
//   2. The loop is resampled every STEP metres from the first stop, and a single lap is SIMULATED once at start-up:
//      a bus that accelerates gently, slows for curves, stops at every stop for DWELL seconds, stops at the line for a
//      red (or a yellow it cannot clear) and pauses at stop signs. The lap's clock starts on a multiple of the signal
//      cycle and the period is padded to one, so every lap meets the lamps exactly as the first did.
//   3. The result is a table s(tau) (metres along the loop at lap time tau) and each stop's arrival/departure window.
//      A bus is just (line, k): its lap time is (signalTime - offset_k) mod period, offsets being multiples of the cycle.

import type { StreetGraph } from '../world/streets';
import type { RoadEdge, RoadNode } from '../world/plan';
import { groundAt, setGroundHint } from '../world/plan';
import { SIGNAL_CYCLE } from '../world/signals';
import { railOff } from './streetTraffic';

export interface StopDef { name: string; x: number; z: number; occ?: number }
export interface LineDef { n: number; name: string; short: string; color: string; way: [number, number][]; stops: StopDef[]; buses: number; phase: number }

// The town's own routes. Waypoints are coordinates (the nearest junction is used), so a redrawn street graph keeps them.
export const LINES: LineDef[] = [
  {
    n: 1, name: 'Route 1: Downtown Circulator', short: 'Downtown Circulator', color: '#e4572e', buses: 2, phase: 0,
    way: [[-30, 290], [190, 290], [190, -20], [-30, -20]],
    stops: [
      { name: 'The Landing, Strand Blvd', x: 22, z: 290 },
      { name: 'Bollard Corner, Halyard St', x: 190, z: 130 },
      { name: 'Ledger District, Ledger St', x: 135, z: -20 },
      { name: 'Downtown, Calamity Ave', x: -30, z: 35 },
    ],
  },
  {
    n: 2, name: 'Route 2: Bridge & Back', short: 'Bridge & Back', color: '#1f9d8f', buses: 3, phase: 1,
    way: [[-30, -20], [-30, -1090], [5, -1680], [170, -1618], [170, -1972], [238, -2270], [74, -2066], [78, -1764]],
    stops: [
      { name: 'Ledger District, Calamity Ave', x: -30, z: -70, occ: 1 },
      { name: 'Tepid Falls Landing, Porch St', x: -10, z: -1200 },
      { name: 'Quorum Square, Front St', x: 170, z: -1808 },
      { name: 'The Depot, Front St', x: 170, z: -2124 },
      { name: 'Main St, The Picture House', x: 78, z: -1817 },
    ],
  },
  {
    n: 3, name: 'Route 3: The Long Way', short: 'The Long Way', color: '#2f6fb0', buses: 3, phase: 2,
    way: [[170, -1870], [378, -1629], [454, -1910], [520, -1805], [409, -1768], [170, -1618], [170, -1137], [-590, -1295], [-645, -1530], [-408, -1748], [-295, -2560], [-23, -2062], [5, -1680]],
    stops: [
      { name: 'Quorum Square, Front St', x: 170, z: -1808 },
      { name: 'Lesser Tepid, Upriver Rd', x: 432, z: -1839 },
      { name: 'Birch & Water, the Long Wait', x: 170, z: -1300 },
      { name: 'The Strip, Exit 127', x: -545, z: -1245 },
      { name: 'Dithers College, Chapel Hill Rd', x: -381, z: -2256 },
    ],
  },
];

export const STEP = 2;
const TS = 0.25;
/** Seconds a bus stands at a stop with its doors open (the terminus stands a little longer). */
export const DWELL = 9, DWELL0 = 14;
const HL = 5.25;
const A_ACC = 1.0, A_BRAKE = 1.6, A_HARD = 2.6, A_LAT = 1.9;

export interface Stop {
  /** Index in the line, the name, metres along the loop (the bus's middle at rest), and where it stands. */
  i: number; name: string; s: number; x: number; z: number; h: number;
  /** Unit vector toward the kerb (right of travel), and the street's half width there. */
  rx: number; rz: number; hw: number; edge: number;
  /** How far right of the street's centreline the bus's lane is (so the kerb is hw - lane from the stop). */
  lane: number;
  /** Lap time of arrival and of leaving (the terminus leaves after the period). */
  arr: number; dep: number;
}

export interface Route {
  def: LineDef; ok: boolean; why: string;
  L: number; N: number;
  px: Float32Array; pz: Float32Array; py: Float32Array;
  edges: number[];
  stops: Stop[];
  period: number;
  tab: Float32Array;
  offs: number[];
  /** The signals along the loop: metres to the stop line, the arriving edge, the node (for the tests). */
  lamps: { line: number; edge: number; node: number }[];
  info: { lapSeconds: number; lights: number; signs: number; stops: number; km: number; dwell: number };
}

export type LightFn = (e: RoadEdge, nodeId: number, time: number) => 'green' | 'yellow' | 'red';

interface Jn { node: RoadNode; e: RoadEdge; idx: number; padA: number }

const kerbOff = (G: StreetGraph, e: RoadEdge): number => (e.id < G.isle.edges ? (e.lanes === 2 ? 5.2 : 1.75) : railOff(e, Math.max(1, e.lanes) - 1));
const cruiseOf = (G: StreetGraph, e: RoadEdge): number => (e.id < G.isle.edges ? 9.5 : e.kind === 'local' ? 9 : 12);
const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const q3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Build a line's route and timetable. */
export function buildRoute(G: StreetGraph, def: LineDef, light: LightFn): Route {
  const bad = (why: string): Route => ({
    def, ok: false, why, L: 0, N: 0, px: new Float32Array(0), pz: new Float32Array(0), py: new Float32Array(0), edges: [], stops: [], period: 0, tab: new Float32Array(0), offs: [], lamps: [],
    info: { lapSeconds: 0, lights: 0, signs: 0, stops: 0, km: 0, dwell: 0 },
  });
  // ── The drive: nodes, then edges ──
  const ids = def.way.map(([x, z]) => G.nearestNode(x, z).id);
  const seq: number[] = [ids[0]];
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i], b = ids[(i + 1) % ids.length];
    if (a === b) continue;
    const p = G.findPath(a, b, 99);
    if (p.length < 2) return bad(`no way from ${a} to ${b}`);
    for (let k = 1; k < p.length; k++) seq.push(p[k]);
  }
  if (seq[seq.length - 1] !== seq[0]) return bad('not a loop');
  seq.pop();
  const K = seq.length;
  const trav: { e: RoadEdge; dir: number; from: number; to: number }[] = [];
  for (let i = 0; i < K; i++) {
    const A = G.nodes[seq[i]], B = seq[(i + 1) % K];
    let best: RoadEdge | null = null;
    for (const id of A.edges) { const e = G.edges[id]; if (G.other(e, A.id) === B && G.canLeave(e, A.id) && (!best || e.len < best.len)) best = e; }
    if (!best) return bad(`no edge ${A.id}-${B}`);
    trav.push({ e: best, dir: best.a === A.id ? 1 : -1, from: A.id, to: B });
  }
  // ── The lane polyline with rounded junctions ──
  const rx: number[] = [], rz: number[] = [], rv: number[] = [], re: number[] = [];
  const jn: Jn[] = [];
  const padOf = (n: RoadNode, e: RoadEdge, nx: RoadEdge, turn: number): number => {
    if (n.edges.length <= 2 || Math.abs(turn) < 0.12) return 0;
    return Math.min(Math.max(6, n.hx + 4), e.len * 0.45, nx.len * 0.45);
  };
  interface Q { x: number; z: number; tx: number; tz: number }
  const tangent = (t: { e: RoadEdge; dir: number }, s: number, o: Q): void => {
    const p = G.pointAt(t.e, t.dir > 0 ? s : t.e.len - s), tx = p.dx * t.dir, tz = p.dz * t.dir, off = kerbOff(G, t.e);
    o.x = p.x - tz * off; o.z = p.z + tx * off; o.tx = tx; o.tz = tz;
  };
  const turnOf = (a: Q, b: Q): number => Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz);
  const P0: Q = { x: 0, z: 0, tx: 0, tz: 0 }, P1: Q = { x: 0, z: 0, tx: 0, tz: 0 };
  for (let k = 0; k < K; k++) {
    const t = trav[k], nt = trav[(k + 1) % K], pt = trav[(k + K - 1) % K];
    const nodeEnd = G.nodes[t.to], nodeStart = G.nodes[t.from];
    tangent(t, Math.max(0, t.e.len - 3), P0); tangent(nt, Math.min(3, nt.e.len), P1);
    const turnEnd = turnOf(P0, P1);
    tangent(pt, Math.max(0, pt.e.len - 3), P0); tangent(t, Math.min(3, t.e.len), P1);
    const turnStart = turnOf(P0, P1);
    const padS = padOf(nodeStart, pt.e, t.e, turnStart), padE = padOf(nodeEnd, t.e, nt.e, turnEnd);
    const s0 = padS, s1 = Math.max(s0 + 1, t.e.len - padE);
    const cr = cruiseOf(G, t.e);
    const n = Math.max(2, Math.ceil((s1 - s0) / 3));
    for (let i = 0; i <= n; i++) { tangent(t, s0 + (s1 - s0) * i / n, P0); rx.push(P0.x); rz.push(P0.z); rv.push(cr); re.push(t.e.id); }
    jn.push({ node: nodeEnd, e: t.e, idx: rx.length - 1, padA: padE });
    // The junction: a cubic from the end of this lane to the start of the next.
    tangent(t, s1, P0);
    tangent(nt, Math.min(padE, nt.e.len - 1), P1);
    const d = Math.hypot(P1.x - P0.x, P1.z - P0.z), c = d * 0.5;
    if (d > 1.2) {
      const m = Math.max(2, Math.ceil(d / 2.5));
      const ax = P0.x + P0.tx * c, az = P0.z + P0.tz * c, bx = P1.x - P1.tx * c, bz = P1.z - P1.tz * c;
      for (let i = 1; i < m; i++) {
        const u = i / m, w = 1 - u;
        rx.push(w * w * w * P0.x + 3 * w * w * u * ax + 3 * w * u * u * bx + u * u * u * P1.x);
        rz.push(w * w * w * P0.z + 3 * w * w * u * az + 3 * w * u * u * bz + u * u * u * P1.z);
        rv.push(Math.min(cr, cruiseOf(G, nt.e))); re.push(t.e.id);
      }
    }
  }
  const M = rx.length;
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) cum[i + 1] = cum[i] + Math.hypot(rx[(i + 1) % M] - rx[i], rz[(i + 1) % M] - rz[i]);
  const Lraw = cum[M];
  // Where a point lies on the raw loop (arc), for stop hints; occ picks among the separate passes.
  const projAll = (x: number, z: number): { arc: number; d: number }[] => {
    const out: { arc: number; d: number }[] = [];
    let run: { arc: number; d: number } | null = null, lastI = -9;
    for (let i = 0; i < M; i++) {
      const ax = rx[i], az = rz[i], bx = rx[(i + 1) % M], bz = rz[(i + 1) % M], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(ax + dx * u - x, az + dz * u - z), arc = cum[i] + u * Math.sqrt(l2);
      if (d < 70) {
        if (run && i - lastI <= 3) { if (d < run.d) { run.arc = arc; run.d = d; } } else { run = { arc, d }; out.push(run); }
        lastI = i;
      }
    }
    return out;
  };
  const rawStops: { def: StopDef; arc: number }[] = [];
  for (const sd of def.stops) {
    const c = projAll(sd.x, sd.z);
    if (!c.length) return bad(`stop ${sd.name} is off the route`);
    const pick = c[Math.min(sd.occ ?? 0, c.length - 1)];
    rawStops.push({ def: sd, arc: pick.arc });
  }
  const s0 = rawStops[0].arc;
  const shift = (a: number): number => ((a - s0) % Lraw + Lraw) % Lraw;
  rawStops.sort((a, b) => shift(a.arc) - shift(b.arc));
  // ── Resample from the first stop, uniformly ──
  const N = Math.round(Lraw / STEP), L = N * STEP;
  const px = new Float32Array(N + 1), pz = new Float32Array(N + 1), py = new Float32Array(N + 1);
  const vcr = new Float64Array(N + 1);
  const eid = new Int32Array(N + 1);
  let seg = 0;
  setGroundHint(0);
  for (let i = 0; i <= N; i++) {
    const a = (s0 + i * Lraw / N) % Lraw;
    if (i === 0 || cum[seg] > a) seg = 0;
    while (seg < M - 1 && cum[seg + 1] <= a) seg++;
    const u = (a - cum[seg]) / (cum[seg + 1] - cum[seg] || 1), j = (seg + 1) % M;
    px[i] = rx[seg] + (rx[j] - rx[seg]) * u; pz[i] = rz[seg] + (rz[j] - rz[seg]) * u;
    vcr[i] = Math.min(rv[seg], rv[j]); eid[i] = re[seg];
    py[i] = groundAt(px[i], pz[i]);
    setGroundHint(py[i]);
  }
  px[N] = px[0]; pz[N] = pz[0]; py[N] = py[0];
  const heading = (i: number): number => { const a = Math.max(0, i - 1), b = Math.min(N, i + 1); return Math.atan2(px[b] - px[a], pz[b] - pz[a]); };
  // ── Speed limit from curvature, stops, and the comfortable brake ──
  const kap = new Float64Array(N + 1);
  for (let i = 1; i < N; i++) kap[i] = Math.abs(wrap(Math.atan2(px[i + 1] - px[i], pz[i + 1] - pz[i]) - Math.atan2(px[i] - px[i - 1], pz[i] - pz[i - 1]))) / STEP;
  const vlim = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    let k = 0;
    for (let j = Math.max(1, i - 4); j <= Math.min(N - 1, i + 4); j++) k = Math.max(k, kap[j]);
    vlim[i] = q3(Math.min(vcr[i], k > 1e-4 ? Math.max(2.4, Math.sqrt(A_LAT / k)) : 99));
  }
  const stopS = rawStops.map((r) => shift(r.arc));
  const stops: Stop[] = [];
  for (let j = 0; j < stopS.length; j++) {
    const idx = Math.round(stopS[j] / STEP), s = idx * STEP, h = heading(idx);
    const e = G.edges[eid[idx]];
    // Right of travel: (-tz, tx) with t = (sin h, cos h).
    stops.push({ i: j, name: rawStops[j].def.name, s, x: px[idx], z: pz[idx], h, rx: -Math.cos(h), rz: Math.sin(h), hw: e ? e.hw : 6, edge: e ? e.id : -1, lane: e ? kerbOff(G, e) : 2, arr: 0, dep: 0 });
    vlim[idx] = 0;
  }
  vlim[0] = 0; vlim[N] = 0;
  // Signals and stop signs along the loop, by the arc of their lines.
  interface Sig { line: number; e: RoadEdge; node: RoadNode; kind: 'light' | 'stop' }
  const sigs: Sig[] = [];
  let lights = 0, signs = 0;
  for (const j of jn) {
    const node = j.node, e = j.e;
    const entry = node.edges.length <= 2 && node.control === 'none' ? 0 : Math.max(node.hx + 1.8, 7);
    const arcNode = ((cum[j.idx] + j.padA - s0) % Lraw + Lraw) % Lraw;
    const line = arcNode - entry;
    const ln = line < 0 ? line + Lraw : line;
    if (node.control === 'signal') { sigs.push({ line: ln, e, node, kind: 'light' }); lights++; }
    else if (node.control === 'stop' && e.kind !== 'arterial' && e.kind !== 'bridge' && e.kind !== 'highway') { sigs.push({ line: ln, e, node, kind: 'stop' }); signs++; }
    else if (node.control === 'roundabout') {
      const a = arcNode / STEP;
      for (let i = Math.max(0, Math.round(a - 9)); i <= Math.min(N, Math.round(a + 9)); i++) vlim[i] = Math.min(vlim[i], 5.5);
    }
  }
  sigs.sort((a, b) => a.line - b.line);
  for (let i = N - 1; i >= 0; i--) vlim[i] = q3(Math.min(vlim[i], Math.sqrt(vlim[i + 1] * vlim[i + 1] + 2 * A_BRAKE * STEP)));
  const lim = (s: number): number => { const f = Math.max(0, Math.min(N - 1e-6, s / STEP)), i = Math.floor(f); return vlim[i] + (vlim[i + 1] - vlim[i]) * (f - i); };
  // ── One lap, simulated ──
  const DT = 0.05;
  const tab: number[] = [];
  let t = 0, s = 0, v = 0, dwellUntil = DWELL0, nextStop = 1, nextSig = 0, served = -1, moved = false, tEnd = -1, nTab = 0;
  const arrT: number[] = new Array(stops.length).fill(0), depT: number[] = new Array(stops.length).fill(0);
  depT[0] = DWELL0;
  const stopsAt = stopS.map((x) => Math.round(x / STEP) * STEP);
  const record = (): void => { while (nTab * TS <= t + 1e-9) { tab.push(s); nTab++; } };
  record();
  for (let guard = 0; guard < 400000; guard++) {
    t += DT;
    if (t >= dwellUntil) {
      // (A bus standing at a stop looks a little ahead: the limit at the stop itself is zero.)
      let vt = lim(s + (v < 0.8 ? 0.8 : 0));
      while (nextSig < sigs.length && sigs[nextSig].line + 2 < s) nextSig++;
      for (let q = nextSig; q < sigs.length && sigs[q].line < s + 90; q++) {
        const sg = sigs[q], d = sg.line - HL - 0.8 - s;
        if (d < -0.6) continue;
        if (sg.kind === 'light') {
          const now = light(sg.e, sg.node.id, t);
          let stopIt = now !== 'green';
          if (!stopIt) {
            const ta = t + Math.max(0, d + HL) / Math.max(v, 3);
            if (light(sg.e, sg.node.id, ta) !== 'green' && d + HL > v * v / (2 * 2.5) + 1) stopIt = true;
          }
          if (stopIt && d + HL < v * v / (2 * A_HARD) && now !== 'red') stopIt = false;
          if (stopIt) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * A_BRAKE * Math.max(0, d - 0.2))));
        } else if (served !== q) {
          // A stop sign is a rolling stop for a bus with the right of way it has (and a full stop would add minutes to a lap).
          vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * A_BRAKE * Math.max(0, d - 0.2))) + 2.6);
          if (d < 0.8) served = q;
        }
      }
      if (t >= dwellUntil) {
        if (v < vt) v = Math.min(v + A_ACC * DT, vt); else v = Math.max(v - A_HARD * DT, vt);
        if (v > 0.05) moved = true;
        s += v * DT;
        const target = nextStop < stops.length ? stopsAt[nextStop] : L;
        if (s >= target - 0.2 || (target - s < 1.2 && v < 0.6)) {
          s = target; v = 0;
          if (nextStop < stops.length) { arrT[nextStop] = t; dwellUntil = t + DWELL; depT[nextStop] = dwellUntil; nextStop++; }
          else { tEnd = t; record(); break; }
        }
      }
    }
    record();
  }
  if (tEnd < 0 || !moved) return bad('lap did not finish');
  const period = SIGNAL_CYCLE * Math.ceil((tEnd + 3) / SIGNAL_CYCLE);
  while (nTab * TS <= period + TS) { tab.push(L); nTab++; }
  arrT[0] = tEnd; depT[0] = period + DWELL0;
  for (let j = 0; j < stops.length; j++) { stops[j].arr = q3(arrT[j]); stops[j].dep = q3(depT[j]); }
  const offs: number[] = [];
  for (let k = 0; k < def.buses; k++) offs.push(SIGNAL_CYCLE * Math.round((k * period / def.buses) / SIGNAL_CYCLE) + SIGNAL_CYCLE * def.phase * 7);
  const edges = [...new Set(trav.map((x) => x.e.id))];
  return {
    def, ok: true, why: '', L, N, px, pz, py, edges, stops, period, tab: Float32Array.from(tab), offs,
    lamps: sigs.filter((q) => q.kind === 'light').map((q) => ({ line: q.line, edge: q.e.id, node: q.node.id })),
    info: { lapSeconds: period, lights, signs, stops: stops.length, km: +(L / 1000).toFixed(2), dwell: DWELL },
  };
}

/** Metres along the loop at lap time tau (seconds, 0..period). */
export function sAt(r: Route, tau: number): number {
  const f = Math.max(0, tau) / TS, i = Math.min(r.tab.length - 2, Math.floor(f));
  return r.tab[i] + (r.tab[i + 1] - r.tab[i]) * (f - i);
}

export interface Pose { x: number; y: number; z: number; h: number; pitch: number; steer: number; speed: number; s: number; tau: number }

/** Where a bus is at lap time tau. */
export function poseAt(r: Route, tau: number, o: Pose): Pose {
  const s = sAt(r, tau), s2 = sAt(r, tau + TS), sp = (s2 - s) / TS;
  const f = (((s % r.L) + r.L) % r.L) / STEP, i = Math.min(r.N - 1, Math.floor(f)), u = f - i;
  o.x = r.px[i] + (r.px[i + 1] - r.px[i]) * u;
  o.z = r.pz[i] + (r.pz[i + 1] - r.pz[i]) * u;
  o.y = r.py[i] + (r.py[i + 1] - r.py[i]) * u;
  const a = Math.max(0, i - 1), b = Math.min(r.N, i + 2);
  const h0 = Math.atan2(r.px[b] - r.px[a], r.pz[b] - r.pz[a]);
  const a2 = Math.max(0, i - 2), b2 = Math.min(r.N, i + 3), h1 = Math.atan2(r.px[b2] - r.px[a2], r.pz[b2] - r.pz[a2]);
  o.h = h0;
  o.steer = Math.max(-1, Math.min(1, -wrap(h1 - h0) * 1.6));
  o.pitch = Math.atan2(r.py[Math.min(r.N, i + 2)] - r.py[Math.max(0, i - 1)], STEP * 3);
  o.speed = sp; o.s = s; o.tau = tau;
  return o;
}

/** Lap time of bus k at shared clock T. */
export function lapTime(r: Route, k: number, T: number): number {
  const p = r.period;
  return (((T - r.offs[k]) % p) + p) % p;
}

/** Is a bus at lap time tau standing at stop j (doors open)? Returns seconds left, or -1. */
export function standing(r: Route, j: number, tau: number): number {
  const st = r.stops[j], p = r.period;
  for (const t of [tau, tau + p]) if (t >= st.arr + 0.3 && t < st.dep - 1.2) return st.dep - t;
  return -1;
}

/** Seconds until bus k reaches stop j (0 while it stands there). */
export function untilStop(r: Route, k: number, j: number, T: number): number {
  const tau = lapTime(r, k, T), st = r.stops[j], p = r.period;
  if (standing(r, j, tau) >= 0) return 0;
  return (((st.arr - tau) % p) + p) % p;
}
