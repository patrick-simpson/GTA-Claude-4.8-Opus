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
import type { Junction } from './streetGround';
import { mainlandTerrain } from './mainland';
import type { RoadEdge } from './plan';

const PAINT = 0xefe9da, YEL = 0xe0b13a, STONE = 0xd6cfbe, CONC = 0xc4bdab, DARK = 0x16181a, STEEL = 0xa7acb0, APRON = 0xc9a892;
type V = [number, number, number];
const UP: V = [0, 1, 0], DOWN: V = [0, -1, 0];

interface Smp { e?: RoadEdge; j?: Junction; s: number; x: number; z: number; rx: number; rz: number; dx: number; dz: number; lift: number }

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
  /** Phones (the governor's lean preset) get the plain versions: no rail posts or backs, no signs, coarser rings. */
  const simple = mats.quality.lean === true;
  const wu = (p: V, t: number): [number, number] => [p[0] / t, p[2] / t];
  /** An upward quad a-b-c-d with world-space UVs (the asphalt and sidewalk textures tile by position, so pieces join without a seam). */
  const wquad = (b: Batch, a: V, bb: V, c: V, d: V, t: number): void => {
    triUV(b, a, bb, c, 0xffffff, wu(a, t), wu(bb, t), wu(c, t));
    triUV(b, a, c, d, 0xffffff, wu(a, t), wu(c, t), wu(d, t));
  };
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
    const j = s < S.mouth(e, false) - 0.01 ? S.juncs.get(e.a) : s > e.len - S.mouth(e, true) + 0.01 ? S.juncs.get(e.b) : undefined;
    return { e: e.kind === 'ramp' ? e : undefined, j, s, x, z, rx: -dz * m, rz: dx * m, dx, dz, lift: S.liftAt(e, s) };
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
    return [x, S.flat(x, z) + (m.j ? S.juncH(m.j, x, z) : m.e ? S.surfLift(m.e, m.s, x, z) : m.lift) + dy, z];
  };
  /** A floor band from t0 to t1 (u across from u0 to u1, v along at s / vt). */
  const band = (b: Batch, sm: Smp[], t0: number, t1: number, dy: number, hex: number, u0: number, u1: number, vt: number, want = UP): void => {
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1];
      quad(b, P(m, t0, dy), P(m, t1, dy), P(n, t1, dy), P(n, t0, dy), hex, u0, m.s / vt, u1, n.s / vt, want);
    }
  };
  /** A painted line along the road at t (width w), solid or dashed. */
  const line = (e: RoadEdge, s0: number, s1: number, t: number, w: number, hex: number, dash: boolean, dy = 0.03, skip?: (x: number, z: number) => boolean): void => {
    if (s1 - s0 < 0.3) return;
    const runs: [number, number][] = [];
    if (dash) for (let s = s0 + 1; s + 3 <= s1; s += 9) runs.push([s, s + 3]); else runs.push([s0, s1]);
    for (const [a, c] of runs) {
      const sm = samples(e, a, c, skip ? 2.5 : 6);
      for (let i = 0; i + 1 < sm.length; i++) {
        const m = sm[i], n = sm[i + 1], r = dash ? R.line : R.solid;
        if (skip && (skip(m.x + m.rx * t, m.z + m.rz * t) || skip(n.x + n.rx * t, n.z + n.rz * t))) continue;
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
  const rail = (sm0: Smp[], t0: number, t1: number, h: number, bot: (m: Smp, p: V) => number, hard: boolean, e?: RoadEdge, steel = false): void => {
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
    if (steel) {
      // A W-beam guard rail: the beam's faces and top, a post every other sample.
      const side = Math.abs(t0) < Math.abs(t1) ? -1 : 1, tin = side < 0 ? t0 : t1, tout = side < 0 ? t1 : t0;
      wall(B.curb, sm, tin, bot, top, Math.sign(tin) * -1, STEEL, 0.95);
      band(B.curb, sm, t0, t1, h, STEEL, 0, 1, 1);
      if (!simple) {
        wall(B.curb, sm, tout, bot, top, Math.sign(tin), STEEL, 0.7);
        for (let i = 0; i < sm.length; i += 2) { const p = P(sm[i], (t0 + t1) / 2, 0); B.curb.box(p[0], p[1] - 0.1, p[2], 0.13, bot(sm[i], p) - p[1] + 0.12, 0.16, 0x7b8084, Math.atan2(sm[i].dx, sm[i].dz), 4, 0.8); }
      }
    } else {
      wall(B.concrete, sm, t0, bot, top, -1, CONC, 0.8);
      wall(B.concrete, sm, t1, bot, top, 1, CONC, 0.9);
      band(B.concrete, sm, t0, t1, h, CONC, 0, 1, 1);
    }
    if (!hard) return;
    const tc = (t0 + t1) / 2, sz = Math.max(0.5, t1 - t0);
    for (let i = 0; i + 1 < sm.length; i++) {
      const m = sm[i], n = sm[i + 1], L = n.s - m.s, k = Math.max(1, Math.ceil(L / 1.4));
      for (let j = 0; j < k; j++) {
        const f = (j + 0.5) / k, x = m.x + (n.x - m.x) * f + (m.rx + (n.rx - m.rx) * f) * tc, z = m.z + (n.z - m.z) * f + (m.rz + (n.rz - m.rz) * f) * tc;
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
      for (const [a, c] of merged) {
        if (b === B.asphalt) wquad(b, P(m, a, 0.02), P(m, c, 0.02), P(n, c, 0.02), P(n, a, 0.02), TILE_M.asphalt);
        else quad(b, P(m, a, 0.02), P(m, c, 0.02), P(n, c, 0.02), P(n, a, 0.02), hex, U(a), m.s / vt, U(c), n.s / vt, UP);
      }
      fm = fn;
    }
  };

  for (const e of S.edges) {
    const t0 = S.mouth(e, false), t1 = S.end(e) < e.len ? S.end(e) : e.len - S.mouth(e, true);
    if (t1 - t0 < 0.5) continue;
    const sm = samples(e, t0, t1, 6);
    // Where the road runs straight on through a node (a join, the Thruway past a ramp) its paint and median carry through.
    // Elsewhere it runs to the junction's rim as the crosswalks and stop lines expect, not just to the kerb returns' ends.
    const whole = S.end(e) >= e.len;
    const l0 = S.through(e, false) ? 0 : Math.min(t0, S.trim(e, false)), l1 = !whole ? t1 : S.through(e, true) ? e.len : Math.max(t1, e.len - S.trim(e, true));
    const ja = S.juncs.get(e.a), jb = S.juncs.get(e.b);
    const onArm = (x: number, z: number): boolean => {
      for (const j of [ja, jb]) if (j && (x - j.n.x) ** 2 + (z - j.n.z) ** 2 < j.r * j.r) for (const a of j.arms) if (a.e !== e && g.project(a.e, x, z).d < a.hw + 0.4) return true;
      return false;
    };
    /** A line the whole way; `edge` lines stop where another road's lanes join in the through stretch. */
    const through = (t: number, w: number, hex: number, dash: boolean, edge: boolean): void => {
      void edge;
      if (dash) { line(e, t0 + 2, t1 - 2, t, w, hex, true); if (S.through(e, false)) line(e, l0 + 0.5, t0 + 2, t, w, hex, true); if (whole && S.through(e, true)) line(e, t1 - 2, l1 - 0.5, t, w, hex, true); return; }
      line(e, l0, t0, t, w, hex, false, 0.03, onArm); line(e, t0, t1, t, w, hex, false); line(e, t1, l1, t, w, hex, false, 0.03, onArm);
    };
    const hw = e.hw, plain = e.divided || e.oneWay || e.kind === 'highway' || e.kind === 'ramp';
    // A house street carries no paint: the double yellow and the edge lines are for the roads that go somewhere.
    const bare = !plain && e.kind === 'local' && e.lanes < 2;
    if (bare) bandRoad(e, B.asphalt, sm, hw, 0xffffff, -hw / TILE_M.asphalt, hw / TILE_M.asphalt, TILE_M.asphalt);
    else if (!plain) bandRoad(e, e.lanes >= 2 ? B.avenue : B.street, sm, hw, 0xffffff, 0, 1, e.lanes >= 2 ? TILE_M.avenue : TILE_M.street);
    else bandRoad(e, B.asphalt, sm, hw, 0xffffff, -hw / TILE_M.asphalt, hw / TILE_M.asphalt, TILE_M.asphalt);

    if (plain && e.divided) {
      const hwy = e.kind === 'highway', mh = hwy ? 0.45 : 1.0, lw = hwy ? 3.6 : 3.4, inner = mh + 0.35;
      const outer = Math.min(inner + lw * e.lanes, hw - 0.5);
      for (const sg of [-1, 1]) {
        through(sg * inner, 0.15, YEL, false, false);
        for (let k = 1; k < e.lanes; k++) through(sg * (inner + lw * k), 0.13, PAINT, true, false);
        through(sg * outer, 0.15, PAINT, false, true);
      }
      // The median: the Thruway's concrete barrier, a curbed strip of grass on the boulevards.
      const join = (atB: boolean): boolean => S.through(e, atB) && (atB ? jb : ja)?.arms.length === 2;
      const m0 = join(false) ? 0 : Math.min(t0, S.trim(e, false)) + (hwy ? 2 : 7), m1 = !whole ? t1 - 7 : join(true) ? e.len : Math.max(t1, e.len - S.trim(e, true)) - (hwy ? 2 : 7);
      if (m1 - m0 > (hwy ? 4 : 14)) {
        const mm = samples(e, m0, m1, 5);
        if (hwy) rail(mm, -0.3, 0.3, 0.85, (_m, p) => p[1] - 0.1, true);
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
      through(-(hw - 0.45), 0.15, YEL, false, true);
      through(hw - 0.45, 0.15, PAINT, false, true);
      const lw = (2 * hw - 0.9) / Math.max(1, e.lanes);
      for (let k = 1; k < e.lanes; k++) through(-(hw - 0.45) + lw * k, 0.13, PAINT, true, false);
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
      const T = TILE_M.sidewalk;
      // Not where another road's asphalt lies (a street merging at a shallow angle, the next junction's corner): the strip stops and starts again.
      const paved = (m: Smp, t: number): boolean => { const x = m.x + m.rx * t, z = m.z + m.rz * t, pr = S.probe(x, z); return pr.kind === 'road' && pr.h < S.flat(x, z) + m.lift + 1; };
      for (const sg of [-1, 1]) {
        const a = sg * hw, c = sg * (hw + WALK_W);
        const free = (m: Smp): boolean => !paved(m, sg * (hw + 0.4)) && !paved(m, sg * (hw + WALK_W - 0.4)) && !paved(m, sg * (hw + WALK_W / 2));
        const base = samples(e, w0, w1, 6), ws: Smp[] = [], ok: boolean[] = [];
        for (let i = 0; i < base.length; i++) {
          ws.push(base[i]); ok.push(free(base[i]));
          if (i + 1 < base.length && base[i + 1].s - base[i].s > 1.6 && (!ok[ok.length - 1] || !free(base[i + 1]))) {
            const k = Math.ceil((base[i + 1].s - base[i].s) / 1.5);
            for (let q = 1; q < k; q++) { const m = sampleAt(e, base[i].s + ((base[i + 1].s - base[i].s) * q) / k); ws.push(m); ok.push(free(m)); }
          }
        }
        let run: Smp[] = [];
        const flushW = (): void => {
          if (run.length >= 2) {
            for (let i = 0; i + 1 < run.length; i++) wquad(B.sidewalk, P(run[i], a, CURB_H), P(run[i], c, CURB_H), P(run[i + 1], c, CURB_H), P(run[i + 1], a, CURB_H), T);
            wall(B.curb, run, a, (_m, p) => p[1] - 0.05, (_m, p) => p[1] + CURB_H, -sg, STONE, 0.78);
            wall(B.curb, run, c, (_m, p) => Math.min(p[1] - 0.25, mainlandTerrain(p[0], p[2]) - 0.1), (_m, p) => p[1] + CURB_H, sg, STONE, 0.7);
          }
          run = [];
        };
        for (let i = 0; i < ws.length; i++) { if (ok[i]) run.push(ws[i]); else flushW(); }
        flushW();
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

  const JP = (j: Junction, x: number, z: number, dy: number): V => [x, S.flat(x, z) + S.juncH(j, x, z) + dy, z];
  const TA = TILE_M.asphalt, TW = TILE_M.sidewalk;
  for (const n of S.nodes) {
    if (n.edges.length === 0) continue;
    const r = S.padR(n), j = S.juncs.get(n.id);
    const rb = n.control === 'roundabout', N = simple ? 16 : 28;
    const ring = (rad: number, dy: number, k: number): V => {
      const a = (k / N) * Math.PI * 2, x = n.x + Math.cos(a) * rad, z = n.z + Math.sin(a) * rad;
      return [x, S.flat(x, z) + S.padH(n, x, z) + dy, z];
    };
    if (!j) {
      // A dead end: a round end to the road.
      const c0 = ring(0, 0.025, 0);
      for (let k = 0; k < N; k++) { const a = ring(r, 0.025, k), b = ring(r, 0.025, k + 1); triUV(B.asphalt, c0, a, b, 0xffffff, wu(c0, TA), wu(a, TA), wu(b, TA)); }
      continue;
    }
    // The asphalt: one polygon out to every arm's mouth, a fan from the node (from the island's edge on a roundabout), in rings
    // where the ground under it is not one plane (a pad on a grade, the hill).
    const p = j.poly, L = p.length / 2, ri = rb ? S.islandR(n) : 0;
    const at = (x: number, z: number, f: number): V => {
      const d = Math.hypot(x - n.x, z - n.z) || 1, g0 = Math.min(1, ri / d), k = g0 + (1 - g0) * f;
      return JP(j, n.x + (x - n.x) * k, n.z + (z - n.z) * k, 0.025);
    };
    let rings = rb ? 2 : 1;
    if (!rb) {
      const o = at(n.x, n.z, 0);
      for (let i = 0; i < L && rings === 1; i++) {
        const q = at(p[2 * i], p[2 * i + 1], 1), mid = at(p[2 * i], p[2 * i + 1], 0.5);
        if (Math.abs(mid[1] - (o[1] + q[1]) / 2) > 0.02) rings = 3;
      }
    }
    for (let i = 0; i < L; i++) {
      const ax = p[2 * i], az = p[2 * i + 1], bx = p[(2 * i + 2) % (2 * L)], bz = p[(2 * i + 3) % (2 * L)];
      const sl = Math.hypot(bx - ax, bz - az);
      if (sl < 0.02) continue;
      const segs = rings > 1 ? Math.max(1, Math.ceil(sl / 4)) : 1;
      for (let q = 0; q < segs; q++) {
        const x0 = ax + ((bx - ax) * q) / segs, z0 = az + ((bz - az) * q) / segs, x1 = ax + ((bx - ax) * (q + 1)) / segs, z1 = az + ((bz - az) * (q + 1)) / segs;
        for (let k = 0; k < rings; k++) {
          const a0 = at(x0, z0, k / rings), b0 = at(x1, z1, k / rings), a1 = at(x0, z0, (k + 1) / rings), b1 = at(x1, z1, (k + 1) / rings);
          if (k === 0 && !rb) triUV(B.asphalt, a0, a1, b1, 0xffffff, wu(a0, TA), wu(a1, TA), wu(b1, TA));
          else wquad(B.asphalt, a0, a1, b1, b0, TA);
        }
      }
    }
    // The corners: the sidewalk wraps round each kerb return, with its kerb face and the wall at its back.
    for (const co of j.strips) {
      const K = co.kerb, Bk = co.back;
      for (let i = 0; i + 3 < K.length; i += 2) {
        const k0 = JP(j, K[i], K[i + 1], CURB_H), k1 = JP(j, K[i + 2], K[i + 3], CURB_H), b0 = JP(j, Bk[i], Bk[i + 1], CURB_H), b1 = JP(j, Bk[i + 2], Bk[i + 3], CURB_H);
        const kl = Math.hypot(k1[0] - k0[0], k1[2] - k0[2]), bl = Math.hypot(b1[0] - b0[0], b1[2] - b0[2]);
        if (kl < 0.02 && bl < 0.02) continue;
        triUV(B.sidewalk, k0, b0, b1, 0xffffff, wu(k0, TW), wu(b0, TW), wu(b1, TW));
        triUV(B.sidewalk, k0, b1, k1, 0xffffff, wu(k0, TW), wu(b1, TW), wu(k1, TW));
        const mx = (k0[0] + k1[0]) / 2, mz = (k0[2] + k1[2]) / 2, ox = (b0[0] + b1[0]) / 2 - mx, oz = (b0[2] + b1[2]) / 2 - mz;
        if (kl > 0.02) quad(B.curb, [k0[0], k0[1] - CURB_H - 0.05, k0[2]], [k1[0], k1[1] - CURB_H - 0.05, k1[2]], k1, k0, STONE, 0, 0, 1, 1, [-ox, 0, -oz], 0.78);
        if (bl > 0.02) {
          const lo0 = Math.min(b0[1] - CURB_H - 0.25, mainlandTerrain(b0[0], b0[2]) - 0.1), lo1 = Math.min(b1[1] - CURB_H - 0.25, mainlandTerrain(b1[0], b1[2]) - 0.1);
          quad(B.curb, [b0[0], lo0, b0[2]], [b1[0], lo1, b1[2]], b1, b0, STONE, 0, 0, 1, 1, [ox, 0, oz], 0.7);
        }
      }
    }
    if (rb) {
      // The island: a kerb, grass rising to a low mound, a truck apron round it and its edge line.
      const rr = S.islandRings(n), top = (rad: number, k: number): V => ring(rad, S.islandH(n, rad), k);
      for (let k = 0; k < N; k++) {
        const ia = ring(ri, 0, k), ib = ring(ri, 0, k + 1), ta = top(ri, k), tb = top(ri, k + 1);
        quad(B.curb, ia, ib, tb, ta, STONE, 0, 0, 1, 1, [ia[0] - n.x, 0, ia[2] - n.z], 0.8);
        for (let q = 0; q + 1 < rr.length; q++) {
          const a0 = top(rr[q], k), b0 = top(rr[q], k + 1), a1 = top(rr[q + 1], k), b1 = top(rr[q + 1], k + 1);
          if (q === 0) triUV(B.grass, a0, a1, b1, 0xffffff, wu(a0, TILE_M.grass), wu(a1, TILE_M.grass), wu(b1, TILE_M.grass));
          else wquad(B.grass, a0, a1, b1, b0, TILE_M.grass);
        }
        const w = Math.min(1.6, (r - ri) * 0.2);
        quad(B.concrete, ring(ri, 0.04, k), ring(ri, 0.04, k + 1), ring(ri + w, 0.04, k + 1), ring(ri + w, 0.04, k), APRON, 0, 0, 1, 1, UP);
        quad(B.marks, ring(ri + w, 0.05, k), ring(ri + w, 0.05, k + 1), ring(ri + w + 0.15, 0.05, k + 1), ring(ri + w + 0.15, 0.05, k), PAINT, 0, R.solid.v0, 0.1, R.solid.v1, UP);
        quad(B.marks, ring(r - 0.55, 0.05, k), ring(r - 0.55, 0.05, k + 1), ring(r - 0.4, 0.05, k + 1), ring(r - 0.4, 0.05, k), PAINT, 0, R.solid.v0, 0.1, R.solid.v1, UP);
      }
      for (const a of j.arms) {
        // A give-way line of blocks across each way in, and a chevron board on the island facing it.
        const e = a.e, dir = a.atB ? -1 : 1, s = a.atB ? e.len - a.m : a.m, hw = e.hw;
        if (!(e.oneWay && !a.atB)) {
          const lo = e.oneWay ? -hw + 0.4 : a.atB ? (e.divided ? 1.1 : 0.2) : -hw + 0.4, hi = e.oneWay ? hw - 0.4 : a.atB ? hw - 0.4 : e.divided ? -1.1 : -0.2;
          const m = sampleAt(e, Math.min(s + dir * 0.4, s + dir * 0.9)), k = sampleAt(e, Math.max(s + dir * 0.4, s + dir * 0.9));
          for (let t = lo; t + 0.6 <= hi; t += 1.1) quad(B.marks, P(m, t, 0.045), P(k, t, 0.045), P(k, t + 0.6, 0.045), P(m, t + 0.6, 0.045), PAINT, 0, R.solid.v0, 0.1, R.solid.v1, UP);
        }
        if (simple) continue;
        const cx = n.x + a.ox * (ri - 1.3), cz = n.z + a.oz * (ri - 1.3), y = S.flat(cx, cz) + S.padH(n, cx, cz) + S.islandH(n, ri - 1.3);
        const rx = a.oz, rz = -a.ox, W = 1.5, fx = cx + a.ox * 0.06, fz = cz + a.oz * 0.06;
        const bp = (u: number, v: number, f = 0): V => [(f ? fx : cx) + rx * u, y + v, (f ? fz : cz) + rz * u];
        quad(B.curb, bp(-W, 0.75), bp(W, 0.75), bp(W, 1.45), bp(-W, 1.45), 0x1b1c1e, 0, 0, 1, 1, [a.ox, 0, a.oz], 1);
        quad(B.curb, bp(-W, 0.75), bp(W, 0.75), bp(W, 1.45), bp(-W, 1.45), 0x55595c, 0, 0, 1, 1, [-a.ox, 0, -a.oz], 0.8);
        for (const u of [-W + 0.15, W - 0.15]) B.curb.box(cx + rx * u, y - 0.2, cz + rz * u, 0.1, 0.95, 0.1, 0x7b8084, 0, 4, 0.8);
        for (let q = 0; q < 4; q++) {
          const u0 = -W + 0.2 + q * 0.7, d = 0.3, t = 0.26;
          quad(B.curb, bp(u0, 1.38, 1), bp(u0 + t, 1.38, 1), bp(u0 + d + t, 1.1, 1), bp(u0 + d, 1.1, 1), YEL, 0, 0, 1, 1, [a.ox, 0, a.oz], 1);
          quad(B.curb, bp(u0 + d, 1.1, 1), bp(u0 + d + t, 1.1, 1), bp(u0 + t, 0.82, 1), bp(u0, 0.82, 1), YEL, 0, 0, 1, 1, [a.ox, 0, a.oz], 1);
        }
      }
      continue;
    }
    if (j.arms.length >= 3 && n.id % 3 === 0) {
      const mx = n.x + r * 0.3, mz = n.z - r * 0.2, y = JP(j, mx, mz, 0.04)[1];
      quad(B.marks, [mx - 0.5, y, mz - 0.5], [mx + 0.5, y, mz - 0.5], [mx + 0.5, y, mz + 0.5], [mx - 0.5, y, mz + 0.5], 0xffffff, R.manhole.u0, R.manhole.v0, R.manhole.u1, R.manhole.v1, UP);
    }
    if (n.control !== 'signal' && n.control !== 'stop') continue;
    // Crosswalks and stop lines, where the traffic and the signals expect them (a fixed distance back from the node).
    const partner = (a: typeof j.arms[0]): boolean => j.arms.some((b) => b !== a && (b.e.road ?? b.e.name) === (a.e.road ?? a.e.name) && a.ox * b.ox + a.oz * b.oz < -0.8);
    const minor = j.arms.some((a) => !partner(a));
    for (const a of j.arms) {
      const e = a.e, atB = a.atB, dir = atB ? -1 : 1, hw = e.hw, s = atB ? e.len - a.t : a.t;
      if (!a.wk || e.len - a.t - S.trim(e, !atB) < 9) continue;
      if (n.control === 'signal') {
        const m = sampleAt(e, Math.min(s, s + dir * 3)), k = sampleAt(e, Math.max(s, s + dir * 3)), w = hw + 0.5;
        quad(B.marks, P(m, -w, 0.04), P(m, w, 0.04), P(k, w, 0.04), P(k, -w, 0.04), PAINT, -w / tm, R.cross.v0, w / tm, R.cross.v1, UP);
      } else if (minor && partner(a)) continue;
      // Inbound traffic: on the left of a -> b near a, on the right near b. A one-way street only arrives at b.
      if (e.oneWay && !atB) continue;
      const sl = s + dir * (n.control === 'signal' ? 3.6 : 0.8), m = sampleAt(e, Math.min(sl, sl + dir * 0.5)), k = sampleAt(e, Math.max(sl, sl + dir * 0.5));
      const lo = e.oneWay ? -hw + 0.3 : atB ? (e.divided ? 1.1 : 0.2) : -hw + 0.3, hi = e.oneWay ? hw - 0.3 : atB ? hw - 0.3 : e.divided ? -1.1 : -0.2;
      quad(B.marks, P(m, lo, 0.04), P(k, lo, 0.04), P(k, hi, 0.04), P(m, hi, 0.04), PAINT, 0, R.stop.v0, (hi - lo) / tm, R.stop.v1, UP);
    }
  }

  // ── Gores ──────────────────────────────────────────────────────────────────

  // Where a ramp parts from the Thruway at the Thruway's own height, the wedge between their edge lines is hatched with chevron
  // bars and paved out to the nose (each road's own strip stops at its width).
  const hwys = S.edges.filter((e) => e.kind === 'highway');
  const lineT = (e: RoadEdge): number => (e.divided ? Math.min(0.8 + 3.6 * e.lanes, e.hw - 0.5) : e.hw - 0.45);
  for (const e of S.edges) {
    if (e.kind !== 'ramp') continue;
    let prev: [V, V] | null = null, k = 0;
    for (let s = 1; s < e.len - 1; s += 1.1, k++) {
      const m = sampleAt(e, s);
      let best: { o: RoadEdge; s: number; d: number } | null = null;
      for (const o of hwys) { const pr = g.project(o, m.x, m.z); if (pr.s > 0.5 && pr.s < o.len - 0.5 && pr.d < o.hw + e.hw + 3 && (!best || pr.d < best.d)) best = { o, s: pr.s, d: pr.d }; }
      if (!best) { prev = null; continue; }
      const o = best.o, mo = sampleAt(o, best.s);
      // The ramp's side toward the Thruway, the Thruway's side toward the ramp.
      const sr = (mo.x - m.x) * m.rx + (mo.z - m.z) * m.rz > 0 ? 1 : -1, so = (m.x - mo.x) * mo.rx + (m.z - mo.z) * mo.rz > 0 ? 1 : -1;
      const pa = P(m, sr * (e.hw - 0.45), 0.045), pr = g.project(o, pa[0], pa[2]);
      const w = pr.d - lineT(o), kg = pr.d - o.hw - 0.45;
      if (Math.abs(m.dx * mo.dx + m.dz * mo.dz) < 0.8 || w < 0.35 || kg > 1.25 || Math.abs(m.lift - S.liftAt(o, pr.s)) > 0.25 || pr.s < 2 || pr.s > o.len - 2) { prev = null; continue; }
      const m2 = sampleAt(o, pr.s), ka = P(m, sr * (e.hw - 0.05), 0.02), kc = P(m2, so * (o.hw - 0.05), 0.02);
      if (prev && kg > -0.1) wquad(B.asphalt, prev[0], prev[1], kc, ka, TA);
      prev = [ka, kc];
      if (k % 3 !== 0) continue;
      const fwd = m.dx * mo.dx + m.dz * mo.dz > 0 ? 1 : -1, n2 = sampleAt(e, Math.min(e.len, s + 0.5)), o1 = sampleAt(o, clamp(pr.s + fwd * 1.4, 0, o.len)), o2 = sampleAt(o, clamp(pr.s + fwd * 1.9, 0, o.len));
      quad(B.marks, pa, P(n2, sr * (e.hw - 0.45), 0.045), P(o2, so * lineT(o), 0.045), P(o1, so * lineT(o), 0.045), PAINT, 0, R.solid.v0, 0.1, R.solid.v1, UP);
    }
  }

  // ── The Thruway's and the ramps' shoulders and guard rails ───────────────────

  for (const e of S.edges) {
    if (e.kind !== 'highway' && e.kind !== 'ramp') continue;
    const t0 = S.mouth(e, false) + 3, t1 = e.len - S.mouth(e, true) - 3;
    if (t1 - t0 < 8) continue;
    const sm = samples(e, t0, t1, 4);
    for (const sg of [-1, 1]) {
      const ti = sg * (e.hw + 0.62), to = sg * (e.hw + 0.76);
      // At grade only (a raised stretch has its parapets), and clear of every other road and junction.
      const free = (m: Smp): boolean => m.lift <= 0.25 && S.clearOf(m.x + m.rx * to, m.z + m.rz * to, e, 3.5);
      let run: Smp[] = [];
      const flushG = (): void => {
        if (run.length >= 3) {
          for (let i = 0; i + 1 < run.length; i++) wquad(B.asphalt, P(run[i], sg * (e.hw - 0.05), 0.02), P(run[i], sg * (e.hw + 0.6), 0.02), P(run[i + 1], sg * (e.hw + 0.6), 0.02), P(run[i + 1], sg * (e.hw - 0.05), 0.02), TA);
          rail(run, Math.min(ti, to), Math.max(ti, to), 0.74, (_m, q) => q[1] + 0.42, true, undefined, true);
        }
        run = [];
      };
      for (const m of sm) { if (free(m)) run.push(m); else flushG(); }
      flushG();
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
          band(B.concrete, run, -W, W, -1.3, 0x55534d, 0, 1, 1, DOWN);
          // Plate girders under the deck: the span reads as a bridge from below, not as a pale slab against the sky.
          for (const f of simple ? [] : [-0.75, -0.25, 0.25, 0.75]) {
            for (const sd of [-1, 1]) wall(B.concrete, run, f * W + sd * 0.15, (_m, p) => p[1] - 2.1, (_m, p) => p[1] - 1.3, sd, 0x4b4f52, sd > 0 ? 0.8 : 0.65);
            band(B.concrete, run, f * W - 0.15, f * W + 0.15, -2.1, 0x3d4043, 0, 1, 1, DOWN);
          }
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
      // The deck's edge is a plate girder: weathered steel, not more concrete.
      for (const sg of [-1, 1]) wall(B.concrete, sm, sg * W, base, (_m, p) => p[1] + CURB_H, sg, 0x4b4f52, 0.8);
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
