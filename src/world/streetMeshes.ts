// The new street plan's ground meshes (tepid-streets.md step 2, unit 2), drawn along streets.ts's polylines on the
// heights streetGround.ts gives the physics: carriageways (the island's street and avenue textures where the road
// is the same shape, bare asphalt with painted lines where it is not), junction pads, roundabouts with their
// islands, sidewalks and curbs with the corners between them, crosswalks and stop lines, medians and the
// Thruway's barrier, overpasses (parapets, walls down to the ground, the open span over the road below with its
// abutments), Trestle St's bridge over the river (any road over the channel gets a deck on piers) and culvert
// headwalls where a road's fill crosses a stream.
//
// Everything is merged into one Batch per material; ground.ts makes the meshes (the same road materials as the
// island, so snow, rain and night treat them alike).

import type { Game } from '../core/game';
import { Batch } from './batch';
import { clamp } from '../core/util';
import { MARKS, TILE_M } from './textures';
import type { CityMaterials } from './materials';
import { CURB_H, StreetSurface, WALK_W, inRiver } from './streetGround';
import { mainlandTerrain } from './mainland';
import type { RoadEdge, RoadNode } from './plan';

const PAINT = 0xefe9da, YEL = 0xe0b13a, STONE = 0xd6cfbe, CONC = 0xc4bdab, DARK = 0x16181a;
type V = [number, number, number];
const UP: V = [0, 1, 0], DOWN: V = [0, -1, 0];

interface Smp { e?: RoadEdge; s: number; x: number; z: number; rx: number; rz: number; dx: number; dz: number; lift: number }

/** Batches the caller turns into meshes: one per material. */
export interface StreetBatches {
  street: Batch; avenue: Batch; asphalt: Batch; marks: Batch; sidewalk: Batch; grass: Batch; curb: Batch; concrete: Batch;
  /** Lamp spots along the streets: x, z and the heading the arm points (toward the road). */
  lamps: [number, number, number][];
}

/** Quad a-b-c-d facing `want` (flipped if it does not), UVs as Batch.quad. */
function quad(b: Batch, a: V, bb: V, c: V, d: V, hex: number, u0: number, v0: number, u1: number, v1: number, want: V, shade = 1): void {
  const e1x = bb[0] - a[0], e1y = bb[1] - a[1], e1z = bb[2] - a[2], e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  if (nx * want[0] + ny * want[1] + nz * want[2] >= 0) b.quad(a[0], a[1], a[2], bb[0], bb[1], bb[2], c[0], c[1], c[2], d[0], d[1], d[2], hex, u0, v0, u1, v1, shade);
  else b.quad(bb[0], bb[1], bb[2], a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2], hex, u1, v0, u0, v1, shade);
}

/** Upward triangle with its own UVs (Batch.tri gives fixed ones: they are patched). */
function triUV(b: Batch, a: V, bb: V, c: V, hex: number, ua: [number, number], ub: [number, number], uc: [number, number]): void {
  const ny = (bb[2] - a[2]) * (c[0] - a[0]) - (bb[0] - a[0]) * (c[2] - a[2]);
  if (ny < 0) { b.tri(a[0], a[1], a[2], c[0], c[1], c[2], bb[0], bb[1], bb[2], hex); b.uv.splice(b.uv.length - 6, 6, ua[0], ua[1], uc[0], uc[1], ub[0], ub[1]); }
  else { b.tri(a[0], a[1], a[2], bb[0], bb[1], bb[2], c[0], c[1], c[2], hex); b.uv.splice(b.uv.length - 6, 6, ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]); }
}

export function buildStreetMeshes(S: StreetSurface, mats: CityMaterials, col: Game['col']): StreetBatches {
  const g = S.g;
  const B: StreetBatches = {
    street: new Batch(), avenue: new Batch(), asphalt: new Batch(), marks: new Batch(), sidewalk: new Batch(),
    grass: new Batch(), curb: new Batch(), concrete: new Batch(), lamps: [],
  };
  const tm = MARKS.tileM;
  const R = {
    line: mats.tex.marks.rect('line'), solid: mats.tex.marks.rect('solid'), cross: mats.tex.marks.rect('crosswalk'),
    stop: mats.tex.marks.rect('stopline'), arrow: mats.tex.marks.rect('arrow'), manhole: mats.tex.marks.rect('manhole'),
  };

  // ── Sampling along an edge ─────────────────────────────────────────────────

  const sampleAt = (e: RoadEdge, s: number): Smp => {
    const p = g.edgePts(e), cum = e.cum ?? [0, e.len];
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const L = cum[k + 1] - cum[k] || 1, t = clamp((s - cum[k]) / L, 0, 1);
    const x = p[2 * k] + (p[2 * k + 2] - p[2 * k]) * t, z = p[2 * k + 1] + (p[2 * k + 3] - p[2 * k + 1]) * t;
    let dx = (p[2 * k + 2] - p[2 * k]) / L, dz = (p[2 * k + 3] - p[2 * k + 1]) / L, m = 1;
    // At a bend, the mitre: the average direction, the offsets stretched to keep the road its width.
    let ox = 0, oz = 0, have = false;
    if (t > 0.999 && k + 2 < cum.length) { const L2 = cum[k + 2] - cum[k + 1] || 1; ox = (p[2 * k + 4] - p[2 * k + 2]) / L2; oz = (p[2 * k + 5] - p[2 * k + 3]) / L2; have = true; }
    else if (t < 0.001 && k > 0) { const L0 = cum[k] - cum[k - 1] || 1; ox = (p[2 * k] - p[2 * k - 2]) / L0; oz = (p[2 * k + 1] - p[2 * k - 1]) / L0; have = true; }
    if (have) {
      const ax = dx + ox, az = dz + oz, al = Math.hypot(ax, az);
      if (al > 1e-3) { const nx = ax / al, nz = az / al; m = 1 / Math.max(0.55, nx * dx + nz * dz); dx = nx; dz = nz; }
    }
    return { e: e.kind === 'ramp' ? e : undefined, s, x, z, rx: -dz * m, rz: dx * m, dx, dz, lift: S.liftAt(e, s) };
  };
  const samples = (e: RoadEdge, s0: number, s1: number, step = 6): Smp[] => {
    const cum = e.cum ?? [0, e.len];
    if (s1 - s0 < 0.05) return [];
    const ss: number[] = [s0];
    for (let k = 1; k < cum.length - 1; k++) if (cum[k] > s0 + 0.05 && cum[k] < s1 - 0.05) ss.push(cum[k]);
    ss.push(s1);
    const out: Smp[] = [];
    for (let i = 0; i + 1 < ss.length; i++) {
      const n = Math.max(1, Math.ceil((ss[i + 1] - ss[i]) / step));
      for (let j = 0; j < n; j++) out.push(sampleAt(e, ss[i] + ((ss[i + 1] - ss[i]) * j) / n));
    }
    out.push(sampleAt(e, s1));
    return out;
  };
  const P = (m: Smp, t: number, dy: number): V => {
    const x = m.x + m.rx * t, z = m.z + m.rz * t;
    return [x, S.flat(x, z) + (m.e ? S.surfLift(m.e, m.s, x, z) : m.lift) + dy, z];
  };
  /** A floor band from t0 to t1 (u across from u0 to u1, v along at s / vt). */
  const band = (b: Batch, sm: Smp[], t0: number, t1: number, dy: number, hex: number, u0: number, u1: number, vt: number, want = UP): void => {
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1];
      quad(b, P(m, t0, dy), P(m, t1, dy), P(n, t1, dy), P(n, t0, dy), hex, u0, m.s / vt, u1, n.s / vt, want);
    }
  };
  /** A painted line along the road at t (width w), solid or dashed. */
  const line = (e: RoadEdge, s0: number, s1: number, t: number, w: number, hex: number, dash: boolean, dy = 0.03): void => {
    const runs: [number, number][] = [];
    if (dash) for (let s = s0 + 1; s + 3 <= s1; s += 9) runs.push([s, s + 3]); else runs.push([s0, s1]);
    for (const [a, c] of runs) {
      const sm = samples(e, a, c, 6);
      for (let i = 0; i + 1 < sm.length; i++) {
        const m = sm[i], n = sm[i + 1], r = dash ? R.line : R.solid;
        quad(B.marks, P(m, t - w / 2, dy), P(n, t - w / 2, dy), P(n, t + w / 2, dy), P(m, t + w / 2, dy), hex, m.s / tm, r.v0, n.s / tm, r.v1, UP);
      }
    }
  };
  /** An upright face along the road at t, from bot(m) to top(m) (heights), facing side (+1 right, -1 left). */
  const wall = (b: Batch, sm: Smp[], t: number, bot: (m: Smp, p: V) => number, top: (m: Smp, p: V) => number, side: number, hex: number, shade = 0.85): void => {
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1], pm = P(m, t, 0), pn = P(n, t, 0);
      const want: V = [m.rx * side, 0, m.rz * side];
      quad(b, [pm[0], bot(m, pm), pm[2]], [pn[0], bot(n, pn), pn[2]], [pn[0], top(n, pn), pn[2]], [pm[0], top(m, pm), pm[2]], hex, 0, 0, 1, 1, want, shade);
    }
  };
  /** A low wall (barrier or parapet) as a box along the road from t0 to t1, top `h` above the road; collision too. */
  const rail = (sm0: Smp[], t0: number, t1: number, h: number, bot: (m: Smp, p: V) => number, hard: boolean, e?: RoadEdge): void => {
    // Broken wherever it would stand on another road (a ramp merging, a junction): drawn in the runs between.
    if (e) {
      const tc = (t0 + t1) / 2;
      let cur: Smp[] = [];
      for (const m of sm0) {
        if (S.covered(m.x + m.rx * tc, m.z + m.rz * tc, e)) { if (cur.length >= 2) rail(cur, t0, t1, h, bot, hard); cur = []; } else cur.push(m);
      }
      if (cur.length >= 2) rail(cur, t0, t1, h, bot, hard);
      return;
    }
    const sm = sm0;
    const top = (m: Smp, p: V): number => p[1] + h;
    wall(B.concrete, sm, t0, bot, top, -1, CONC, 0.8);
    wall(B.concrete, sm, t1, bot, top, 1, CONC, 0.9);
    band(B.concrete, sm, t0, t1, h, CONC, 0, 1, 1);
    if (!hard) return;
    const tc = (t0 + t1) / 2, sz = Math.max(0.5, t1 - t0);
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1], L = n.s - m.s, k = Math.max(1, Math.ceil(L / 1.4));
      for (let j = 0; j < k; j++) {
        const f = (j + 0.5) / k, x = m.x + (n.x - m.x) * f + m.rx * tc, z = m.z + (n.z - m.z) * f + m.rz * tc;
        const y = S.flat(x, z) + m.lift + (n.lift - m.lift) * f;
        col.addBoxC(x, z, sz + 0.5, sz + 0.5, y + h, bot(m, [x, y, z]) - 0.3);
      }
    }
  };
  const ground = (_m: Smp, p: V): number => mainlandTerrain(p[0], p[2]) - 0.4;

  // ── Carriageways and their paint ──────────────────────────────────────────

  /**
   * The carriageway of e from -hw to hw. Where it lies on a road that outranks it (a side street merging at a shallow angle
   * runs on the major road's surface for a stretch) only the part off that road is drawn: one surface wins, no two coplanar
   * meshes fighting for the pixels. The edge of the clipped part follows samples 1.5 m apart.
   */
  const bandRoad = (e: RoadEdge, b: Batch, sm: Smp[], hw: number, hex: number, u0: number, u1: number, vt: number): void => {
    const cov = (m: Smp, t: number): boolean => S.outranked(m.x + m.rx * t, m.z + m.rz * t, e, m.lift);
    const probe = (m: Smp): boolean => cov(m, -hw * 0.9) || cov(m, 0) || cov(m, hw * 0.9) || cov(m, -hw * 0.45) || cov(m, hw * 0.45);
    // Subdivide the stretches where the road is under another.
    const fine: Smp[] = [sm[0]];
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1], mid = sampleAt(e, (m.s + n.s) / 2);
      if (n.s - m.s > 1.6 && (probe(m) || probe(n) || probe(mid))) {
        const k = Math.ceil((n.s - m.s) / 1.5);
        for (let j = 1; j < k; j++) fine.push(sampleAt(e, m.s + ((n.s - m.s) * j) / k));
      }
      fine.push(n);
    }
    const free = (m: Smp): [number, number][] => {
      const out: [number, number][] = [];
      let a: number | null = null;
      const N = Math.ceil((2 * hw) / 0.5);
      for (let i = 0; i <= N; i++) {
        const t = -hw + (2 * hw * i) / N, c = i > 0 && i < N && cov(m, t);
        if (!c && a === null) a = t;
        if (c && a !== null) { out.push([a, -hw + (2 * hw * (i - 1)) / N]); a = null; }
      }
      if (a !== null) out.push([a, hw]);
      return out.filter(([x, y]) => y - x > 0.05);
    };
    const U = (t: number): number => u0 + ((t + hw) / (2 * hw)) * (u1 - u0);
    let fm = free(fine[0]);
    for (let i = 0; i + 1 < fine.length; i++) {
      const m = fine[i], n = fine[i + 1], fn = free(n);
      const all = [...fm, ...fn].sort((p, q) => p[0] - q[0]), merged: [number, number][] = [];
      for (const r of all) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1] + 0.01) l[1] = Math.max(l[1], r[1]); else merged.push([r[0], r[1]]); }
      for (const [a, c] of merged) quad(b, P(m, a, 0.02), P(m, c, 0.02), P(n, c, 0.02), P(n, a, 0.02), hex, U(a), m.s / vt, U(c), n.s / vt, UP);
      fm = fn;
    }
  };

  for (const e of S.edges) {
    const t0 = S.trim(e, false), t1 = S.end(e) < e.len ? S.end(e) : e.len - S.trim(e, true);
    if (t1 - t0 < 0.5) continue;
    const sm = samples(e, Math.max(0, t0 - 0.6), Math.min(S.end(e), t1 + 0.6), 6);
    const hw = e.hw, plain = e.divided || e.oneWay || e.kind === 'highway' || e.kind === 'ramp';
    if (!plain) bandRoad(e, e.lanes >= 2 ? B.avenue : B.street, sm, hw, 0xffffff, 0, 1, e.lanes >= 2 ? TILE_M.avenue : TILE_M.street);
    else bandRoad(e, B.asphalt, sm, hw, 0xffffff, -hw / TILE_M.asphalt, hw / TILE_M.asphalt, TILE_M.asphalt);

    if (plain && e.divided) {
      const hwy = e.kind === 'highway', mh = hwy ? 0.45 : 1.0, lw = hwy ? 3.6 : 3.4, inner = mh + 0.35;
      const outer = Math.min(inner + lw * e.lanes, hw - 0.5);
      for (const sg of [-1, 1]) {
        line(e, t0, t1, sg * inner, 0.15, YEL, false);
        for (let k = 1; k < e.lanes; k++) line(e, t0 + 2, t1 - 2, sg * (inner + lw * k), 0.13, PAINT, true);
        line(e, t0, t1, sg * outer, 0.15, PAINT, false);
      }
      // The median: the Thruway's concrete barrier, a curbed strip of grass on the boulevards.
      const m0 = t0 + (hwy ? 2 : 7), m1 = t1 - (hwy ? 2 : 7);
      if (m1 - m0 > 4) {
        const mm = samples(e, m0, m1, 5);
        if (hwy) rail(mm, -0.3, 0.3, 0.85, (_m, p) => p[1] - 0.1, true, e);
        else {
          // Over the river the strip is concrete (a bridge has no soil for grass).
          const over = (m: Smp): boolean => inRiver(m.x, m.z, 30) && mainlandTerrain(m.x, m.z) < S.flat(m.x, m.z) - 1.0;
          let run: Smp[] = [], rb = false;
          const flushM = (): void => {
            if (run.length >= 2) {
              if (rb) band(B.concrete, run, -mh, mh, CURB_H + 0.02, CONC, 0, 1, 1);
              else band(B.grass, run, -mh, mh, CURB_H + 0.02, 0xffffff, -mh / TILE_M.grass, mh / TILE_M.grass, TILE_M.grass);
            }
          };
          for (const m of mm) {
            const o = over(m);
            if (run.length && o !== rb) { const last = run[run.length - 1]; flushM(); run = [last]; }
            rb = o; run.push(m);
          }
          flushM();
          for (const sg of [-1, 1]) wall(B.curb, mm, sg * mh, (_m, p) => p[1], (_m, p) => p[1] + CURB_H + 0.02, sg, STONE, 0.8);
        }
      }
    } else if (plain) {
      // One-way: edge lines (yellow on the left), lane lines, and an arrow every forty-odd metres.
      line(e, t0, t1, -(hw - 0.45), 0.15, YEL, false);
      line(e, t0, t1, hw - 0.45, 0.15, PAINT, false);
      const lw = (2 * hw - 0.9) / Math.max(1, e.lanes);
      for (let k = 1; k < e.lanes; k++) line(e, t0 + 2, t1 - 2, -(hw - 0.45) + lw * k, 0.13, PAINT, true);
      for (let s = t0 + 12; s + 4 < t1 - 8; s += 44) {
        for (let k = 0; k < Math.max(1, e.lanes); k++) {
          const tc = -(hw - 0.45) + lw * (k + 0.5), m = sampleAt(e, s), n = sampleAt(e, s + 3.4);
          quad(B.marks, P(m, tc - 0.7, 0.035), P(m, tc + 0.7, 0.035), P(n, tc + 0.7, 0.035), P(n, tc - 0.7, 0.035), PAINT, R.arrow.u0, R.arrow.v0, R.arrow.u1, R.arrow.v1, UP);
        }
      }
    }

    // Sidewalks with their curbs, both sides; lamps along them.
    if (S.walks(e)) {
      const w0 = t0, w1 = t1;
      const ws = samples(e, w0, w1, 6);
      const T = TILE_M.sidewalk;
      for (const sg of [-1, 1]) {
        const a = sg * hw, c = sg * (hw + WALK_W);
        band(B.sidewalk, ws, Math.min(a, c), Math.max(a, c), CURB_H, 0xffffff, Math.min(a, c) / T, Math.max(a, c) / T, T);
        wall(B.curb, ws, a, (_m, p) => p[1] - 0.05, (_m, p) => p[1] + CURB_H, -sg, STONE, 0.78);
        wall(B.curb, ws, c, (_m, p) => Math.min(p[1] - 0.25, mainlandTerrain(p[0], p[2]) - 0.1), (_m, p) => p[1] + CURB_H, sg, STONE, 0.7);
      }
      for (let s = w0 + 8, k = e.id; s < w1 - 8; s += 34, k++) {
        const m = sampleAt(e, s), sg = k % 2 ? 1 : -1, off = sg * (hw + 0.65);
        const lx = m.x + m.rx * off, lz = m.z + m.rz * off;
        // Not where another road runs or merges (a side street's lanes, a junction's pad).
        if (S.covered(lx, lz, e) || S.covered(lx - m.rx * sg * 0.5, lz - m.rz * sg * 0.5, e)) continue;
        B.lamps.push([lx, lz, Math.atan2(-m.rx * sg, -m.rz * sg)]);
      }
    }
  }

  // ── Junctions ──────────────────────────────────────────────────────────────

  const out = (e: RoadEdge, n: RoadNode): { m: Smp; ox: number; oz: number; s: number } => {
    const atB = e.b === n.id && !(e.a === n.id), s = atB ? e.len - S.trim(e, true) : S.trim(e, false), m = sampleAt(e, clamp(s, 0, e.len));
    return { m, ox: atB ? -m.dx : m.dx, oz: atB ? -m.dz : m.dz, s };
  };
  const wu = (p: V, t: number): [number, number] => [p[0] / t, p[2] / t];
  for (const n of S.nodes) {
    if (n.edges.length === 0) continue;
    const r = S.padR(n), N = 28;
    const ring = (rad: number, dy: number, k: number): V => {
      const a = (k / N) * Math.PI * 2, x = n.x + Math.cos(a) * rad, z = n.z + Math.sin(a) * rad;
      return [x, S.flat(x, z) + S.padH(n, x, z) + dy, z];
    };
    const T = TILE_M.asphalt;
    if (n.control === 'roundabout') {
      const ri = S.islandR(n);
      for (let k = 0; k < N; k++) {
        const a = ring(ri, 0.03, k), b = ring(ri, 0.03, k + 1), c = ring(r, 0.03, k + 1), d = ring(r, 0.03, k);
        triUV(B.asphalt, a, b, c, 0xffffff, wu(a, T), wu(b, T), wu(c, T));
        triUV(B.asphalt, a, c, d, 0xffffff, wu(a, T), wu(c, T), wu(d, T));
        // The island: a curb ring and a grass top.
        const ia = ring(ri, 0, k), ib = ring(ri, 0, k + 1), top = 2 * CURB_H;
        quad(B.curb, ia, ib, [ib[0], ib[1] + top, ib[2]], [ia[0], ia[1] + top, ia[2]], STONE, 0, 0, 1, 1, [ia[0] - n.x, 0, ia[2] - n.z], 0.8);
        const ca = ring(0, top, 0), ga = ring(ri, top, k), gb = ring(ri, top, k + 1);
        triUV(B.grass, ca, ga, gb, 0xffffff, wu(ca, TILE_M.grass), wu(ga, TILE_M.grass), wu(gb, TILE_M.grass));
        // Lines: the island's edge, and a dashed give-way line round the outside.
        const la = ring(ri + 0.35, 0.05, k), lb = ring(ri + 0.35, 0.05, k + 1), lc = ring(ri + 0.5, 0.05, k + 1), ld = ring(ri + 0.5, 0.05, k);
        quad(B.marks, la, lb, lc, ld, PAINT, 0, R.solid.v0, 0.1, R.solid.v1, UP);
      }
      continue;
    }
    // A plain pad (a disc) under the junction, a manhole now and then.
    const c0 = ring(0, 0.025, 0);
    for (let k = 0; k < N; k++) {
      const a = ring(r, 0.025, k), b = ring(r, 0.025, k + 1);
      triUV(B.asphalt, c0, a, b, 0xffffff, wu(c0, T), wu(a, T), wu(b, T));
    }
    if (n.edges.length >= 3 && n.id % 3 === 0) {
      const mx = n.x + r * 0.3, mz = n.z - r * 0.2, y = S.flat(mx, mz) + S.padH(n, mx, mz) + 0.04;
      quad(B.marks, [mx - 0.5, y, mz - 0.5], [mx + 0.5, y, mz - 0.5], [mx + 0.5, y, mz + 0.5], [mx - 0.5, y, mz + 0.5], 0xffffff, R.manhole.u0, R.manhole.v0, R.manhole.u1, R.manhole.v1, UP);
    }
    if (n.edges.length < 2) continue;
    const ends = n.edges.map((id) => g.edges[id]).filter((e) => S.edges.includes(e)).map((e) => ({ e, ...out(e, n), ang: 0 }));
    for (const q of ends) q.ang = Math.atan2(q.oz, q.ox);
    ends.sort((a, b) => a.ang - b.ang);
    // Corners between neighbouring sidewalks, and crosswalks / stop lines on each street into a controlled junction.
    for (let i = 0; i < ends.length; i++) {
      const A = ends[i], C = ends[(i + 1) % ends.length];
      if (ends.length < 2 || A === C) break;
      let gap = C.ang - A.ang;
      if (gap <= 0) gap += Math.PI * 2;
      if (!S.walks(A.e) || !S.walks(C.e) || gap > (200 * Math.PI) / 180) continue;
      // Each road's kerb on the side facing into the gap: by the gap's bisector (the other road's direction is no guide when the gap is a straight 180 degrees, a T's far side, and put a raised strip across a side road's mouth).
      const bx = Math.cos(A.ang + gap / 2), bz = Math.sin(A.ang + gap / 2);
      const sa = A.m.rx * bx + A.m.rz * bz > 0 ? 1 : -1, sc = C.m.rx * bx + C.m.rz * bz > 0 ? 1 : -1;
      const KA = P(A.m, sa * A.e.hw, CURB_H), OA = P(A.m, sa * (A.e.hw + WALK_W), CURB_H);
      const KC = P(C.m, sc * C.e.hw, CURB_H), OC = P(C.m, sc * (C.e.hw + WALK_W), CURB_H);
      if (Math.hypot(KA[0] - KC[0], KA[2] - KC[2]) > 40) continue;
      const Tw = TILE_M.sidewalk;
      triUV(B.sidewalk, KA, OA, OC, 0xffffff, wu(KA, Tw), wu(OA, Tw), wu(OC, Tw));
      triUV(B.sidewalk, KA, OC, KC, 0xffffff, wu(KA, Tw), wu(OC, Tw), wu(KC, Tw));
      const kb: V = [KA[0], KA[1] - CURB_H - 0.05, KA[2]], kd: V = [KC[0], KC[1] - CURB_H - 0.05, KC[2]];
      quad(B.curb, kb, kd, KC, KA, STONE, 0, 0, 1, 1, [n.x - (KA[0] + KC[0]) / 2, 0, n.z - (KA[2] + KC[2]) / 2], 0.78);
    }
    if (n.control !== 'signal' && n.control !== 'stop') continue;
    for (const q of ends) {
      const e = q.e;
      if (!S.walks(e)) continue;
      const atB = e.b === n.id, dir = atB ? -1 : 1, hw = e.hw;
      if (n.control === 'signal') {
        const s0 = q.s, s1 = q.s + dir * 3;
        const m = sampleAt(e, Math.min(s0, s1)), k = sampleAt(e, Math.max(s0, s1));
        quad(B.marks, P(m, -hw, 0.04), P(m, hw, 0.04), P(k, hw, 0.04), P(k, -hw, 0.04), PAINT, -hw / tm, R.cross.v0, hw / tm, R.cross.v1, UP);
      }
      // Inbound traffic: on the left of a -> b near a, on the right near b. A one-way street only arrives at b.
      if (e.oneWay && !atB) continue;
      const sl = q.s + dir * (n.control === 'signal' ? 3.6 : 0.8), m = sampleAt(e, Math.min(sl, sl + dir * 0.5)), k = sampleAt(e, Math.max(sl, sl + dir * 0.5));
      const lo = e.oneWay ? -hw + 0.3 : atB ? (e.divided ? 1.1 : 0.2) : -hw + 0.3, hi = e.oneWay ? hw - 0.3 : atB ? hw - 0.3 : e.divided ? -1.1 : -0.2;
      quad(B.marks, P(m, lo, 0.04), P(k, lo, 0.04), P(k, hi, 0.04), P(m, hi, 0.04), PAINT, 0, R.stop.v0, (hi - lo) / tm, R.stop.v1, UP);
    }
  }

  // ── Overpasses ─────────────────────────────────────────────────────────────

  for (const e of S.edges) {
    if (!S.raised(e)) continue;
    const mine = S.passes.filter((p) => p.upper === e);
    const inPass = (s: number): boolean => mine.some((p) => Math.abs(s - p.s) < p.half);
    // Runs of the edge that are up (lift over 0.25 m), split into embankment and open span.
    const sm = samples(e, 0, e.len, 3);
    let run: Smp[] = [], runPass = false;
    const flush = (): void => {
      if (run.length >= 2) {
        const W = e.hw + 0.5;
        if (runPass) {
          // The open span: deck edge, underside and parapets; walls close the embankment either side.
          const under = (_m: Smp, p: V): number => p[1] - 1.3;
          for (const sg of [-1, 1]) rail(run, sg > 0 ? e.hw : -W, sg > 0 ? W : -e.hw, 1.0, under, true, e);
          band(B.concrete, run, -W, W, -1.3, CONC, 0, 1, 1, DOWN);
          for (const m of [run[0], run[run.length - 1]]) {
            const a = P(m, -W, 0), b = P(m, W, 0);
            const ga = mainlandTerrain(a[0], a[2]) - 0.3, gb = mainlandTerrain(b[0], b[2]) - 0.3;
            const face: V = m === run[0] ? [m.dx, 0, m.dz] : [-m.dx, 0, -m.dz];
            quad(B.concrete, [a[0], ga, a[2]], [b[0], gb, b[2]], [b[0], b[1] - 1.3, b[2]], [a[0], a[1] - 1.3, a[2]], CONC, 0, 0, 1, 1, face, 0.75);
          }
        } else {
          for (const sg of [-1, 1]) rail(run, sg > 0 ? e.hw : -W, sg > 0 ? W : -e.hw, 1.0, ground, true, e);
        }
      }
      run = [];
    };
    for (const m of sm) {
      const up = m.lift > 0.25, ps = inPass(m.s);
      if (!up || ps !== runPass) { if (run.length) { const last = run[run.length - 1]; flush(); if (up) run.push(last); } }
      runPass = ps;
      if (up) run.push(m);
    }
    flush();
  }
  // Piers in the median of a divided road under a span.
  for (const p of S.passes) {
    if (!p.lower.divided) continue;
    const s = g.project(p.lower, p.o.x, p.o.z).s, m = sampleAt(p.lower, s), top = S.flat(m.x, m.z) + S.liftAt(p.upper, p.s) - 1.3;
    for (const k of [-0.6, 0, 0.6]) {
      const um = sampleAt(p.upper, p.s), x = m.x + um.rx * k * p.upper.hw, z = m.z + um.rz * k * p.upper.hw;
      const pm = g.project(p.lower, x, z);
      if (pm.d > 1.5) continue;
      B.concrete.box(x, S.flat(x, z) + CURB_H, z, 1.1, top - S.flat(x, z) - CURB_H, 1.1, CONC, Math.atan2(um.dx, um.dz), 4, 0.85);
      col.addBoxC(x, z, 1.1, 1.1, top, S.flat(x, z) - 0.5);
    }
  }

  // ── Bridges over the river ─────────────────────────────────────────────────

  for (const e of S.edges) {
    const end = S.end(e);
    const spans: [number, number][] = [];
    let a = -1;
    for (let s = 0; s <= end + 0.01; s += 2) {
      const m = sampleAt(e, Math.min(s, end)), low = inRiver(m.x, m.z, 30) && mainlandTerrain(m.x, m.z) < S.flat(m.x, m.z) - 1.0;
      if (low && a < 0) a = s;
      if (!low && a >= 0) { spans.push([a, s]); a = -1; }
    }
    if (a >= 0) spans.push([a, end]);
    const W = e.hw + (S.walks(e) ? WALK_W : 0.6) + 0.3;
    for (const [s0, s1] of spans) {
      const x0 = Math.max(0, s0 - 3), x1 = Math.min(end, s1 + 3);
      const sm = samples(e, x0, x1, 4);
      band(B.concrete, sm, -W, W, -1.2, CONC, 0, 1, 1, DOWN);
      // Parapets, kept out of the mouths of the junctions at either end.
      const p0 = Math.max(x0, S.trim(e, false)), p1 = Math.min(x1, e.len - S.trim(e, true));
      const ps = samples(e, p0, p1, 3);
      const base = (_m: Smp, p: V): number => p[1] - 1.2;
      if (ps.length >= 2) for (const sg of [-1, 1]) rail(ps, sg > 0 ? W - 0.4 : -W, sg > 0 ? W : -W + 0.4, 1.15, base, true, e);
      for (const sg of [-1, 1]) wall(B.concrete, sm, sg * W, base, (_m, p) => p[1] + CURB_H, sg, CONC, 0.8);
      for (let s = s0 + 8; s < s1 - 4; s += 24) {
        const m = sampleAt(e, s);
        for (const k of [-0.55, 0.55]) {
          const x = m.x + m.rx * k * e.hw, z = m.z + m.rz * k * e.hw, top = S.flat(x, z) - 1.2;
          B.concrete.box(x, -6, z, 1.6, top + 6, 1.6, CONC, Math.atan2(m.dx, m.dz), 4, 0.85);
          col.addBoxC(x, z, 1.6, 1.6, top, -6);
        }
      }
    }
  }

  // ── Culverts where a road's fill crosses a stream ──────────────────────────

  for (const c of S.culverts()) {
    const m = sampleAt(c.e, c.s), off = c.e.hw + WALK_W + 15;
    for (const sg of [-1, 1]) {
      const x = c.x + m.rx * sg * off, z = c.z + m.rz * sg * off, h = Math.atan2(m.dx, m.dz);
      B.concrete.box(x, -2.5, z, 1.0, 5.6, 18, CONC, h, 5, 0.85);
      // The mouth: a dark arch on the outer face.
      const fx = m.rx * sg, fz = m.rz * sg, px = x + fx * 0.52, pz = z + fz * 0.52, ax = m.dx * 3.5, az = m.dz * 3.5;
      quad(B.concrete, [px - ax, -0.9, pz - az], [px + ax, -0.9, pz + az], [px + ax, 2.0, pz + az], [px - ax, 2.0, pz - az], DARK, 0, 0, 1, 1, [fx, 0, fz], 1);
    }
  }

  return B;
}
