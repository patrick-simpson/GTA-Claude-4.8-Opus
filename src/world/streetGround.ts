// The ground under the new street plan (tepid-streets.md step 2, unit 2): what you stand and drive on
// along streets.ts's polyline roads, without any rendering (streetMeshes.ts draws the same shapes).
//
//   heights    a road lies at the plateau (MAIN_Y plus Dithers Hill) plus its lift: the Thruway and the ramps rise
//              over the roads they cross (overpasses), solved once per node and blended along each edge. Sidewalks
//              are a curb higher; a roundabout's island is a raised disc. Everywhere else is the terrain.
//   grading    the terrain is pulled up to the plateau under and beside every road (a 4 m weight raster), so no road
//              floats over the bluff, a riverbank or a stream; Afterthought Stream and Sidle Brook run through culverts
//              under the fill. The Muddle River's channel is never filled: roads over it are bridge decks.
//   lookups    a 16 m grid of road segments and junction pads, so groundAt() tests a handful of segments.
//   overpass   where an upper road crosses over a lower one, the height depends on where you are coming from:
//              groundAt() takes a hint (the caller's own height) and picks the surface just below it.

import { clamp, smooth } from '../core/util';
import { lookoutW } from './dithersPond';
import { MAIN_Y, RIVER_HW, hillAt, mainlandTerrain, naturalTerrain, riverX, waterDist } from './mainland';
import type { Overpass, StreetGraph } from './streets';
import type { RoadEdge, RoadNode } from './plan';

export const WALK_W = 3.5, CURB_H = 0.16;
/** Steepest a ramp is allowed to climb or sink where it has to reach the Thruway's height (the Thruway's own steepest is 11%). */
const RAMP_GRADE = 0.08;
/** Height an overpass carries its road above the one below, and how far each way it takes to climb there. */
export const LIFT_H = 6.6;
const LIFT_R = 95;
const CELL = 16, CX0 = -1040, CZ0 = -3060, CNX = 128;
const GS = 4, GX0 = -1000, GZ0 = -3010, GNX = 512, GNZ = 548;

export interface Bump { s: number; flat: number; h: number }
/** An overpass the surfaces honour: the upper edge's arc position and how long its open span is. */
export interface Passage { o: Overpass; upper: RoadEdge; lower: RoadEdge; s: number; half: number }
/** One road's end at a junction: `m` is its mouth (arc distance from the node where the road's own strip begins). */
export interface JArm { e: RoadEdge; atB: boolean; i: number; ang: number; ox: number; oz: number; bx: number; bz: number; hw: number; t: number; m: number; wk: boolean; thru: boolean }
/**
 * The kerb between two neighbouring arms: `kerb` runs from arm a's mouth round the corner to arm c's mouth (flat x,z), `back`
 * is the back of the sidewalk, point for point. `walk`: a raised sidewalk fills the strip between them. `fillet`: a rounded
 * return of radius r (else a straight join or the outside of a bend).
 */
export interface JCorner { a: JArm; c: JArm; gap: number; walk: boolean; fillet: boolean; r: number; ua: number; uc: number; kerb: number[]; back: number[] }
/** A strip of raised sidewalk in a junction, between a kerb line and the line at its back (point for point). */
export interface JStrip { kerb: number[]; back: number[] }
/** A junction's shape: `poly` is the asphalt's outline (the corners' kerbs end to end; the mouths close it), filled as a fan from the node. */
export interface Junction { n: RoadNode; r: number; poly: number[]; arms: JArm[]; corners: JCorner[]; strips: JStrip[] }
/** Mound in a roundabout's island: height over the island's kerb at the fractions MOUND_F of its radius. */
const MOUND_F = [0, 0.3, 0.6, 0.86, 1], MOUND_H = [1.15, 1.0, 0.52, 0.08, 0];
const inTri = (x: number, z: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean => {
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz), d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const lf = (d: number, flat: number): number => (d <= flat ? 1 : d >= flat + LIFT_R ? 0 : 1 - smooth((d - flat) / LIFT_R));
/** True in the Muddle River's channel (never graded: roads cross it on decks). */
export const inRiver = (x: number, z: number, m = 3): boolean => x > 230 && x < 450 && Math.abs(x - riverX(z)) < RIVER_HW + m;

export class StreetSurface {
  /** Mainland edges with a surface (the island bridge's landing stub included, limited by sMax). */
  readonly edges: RoadEdge[] = [];
  readonly nodes: RoadNode[] = [];
  /** Lift of each node above the plateau, by graph node id. */
  readonly lift: Float32Array;
  /** Height of each junction pad above the plateau: the node's lift; a roundabout on a grade (the Thruway's last stretch at exit 130) is raised to the highest road meeting it at the rim (else a cliff). */
  readonly padLift: Float32Array;
  /** Tilt of each junction pad (m of rise per m east / south of the node): a pad on a grade is a plane through where its roads meet the rim, not a step. */
  readonly padGx: Float32Array;
  readonly padGz: Float32Array;
  readonly passes: Passage[] = [];
  private readonly bumps = new Map<number, Bump[]>();
  /** Per-ramp lift samples, 1 m apart (solveRamps). */
  private readonly rampLift = new Map<number, Float32Array>();
  /** A hill road's vertical profile above the plateau, 1 m apart (solveProfiles). */
  private readonly prof = new Map<number, Float32Array>();
  private readonly fixed: Uint8Array;
  private readonly maxLift = new Map<number, number>();
  private readonly sMax = new Map<number, number>();
  /** Trim at each end of each surface edge (by index into `edges`): the pad owns the ground inside it. */
  private trimA = new Float32Array(0);
  private trimB = new Float32Array(0);
  private readonly segCells = new Map<number, number[]>();
  private readonly padCells = new Map<number, number[]>();
  /** Junction shapes (every node where two or more roads meet), by node id and by lookup cell. */
  readonly juncs = new Map<number, Junction>();
  private readonly juncCells = new Map<number, Junction[]>();
  private mouthA = new Float32Array(0);
  private mouthB = new Float32Array(0);
  private readonly edgeIdx = new Map<number, number>();
  private readonly w = new Float32Array(GNX * GNZ);
  /** Height the grading target stands above the plateau (a hill road's fill), same grid as w. */
  private readonly lw = new Float32Array(GNX * GNZ);
  private readonly ld = new Float32Array(GNX * GNZ).fill(1e9);

  constructor(readonly g: StreetGraph, landingStubZ: number) {
    for (let k = g.isle.edges; k < g.edges.length; k++) {
      const e = g.edges[k];
      if (e.land !== 1) continue;
      if (e.deck) {
        // The island bridge: only the stretch from the landing node to where the bridge's own deck begins.
        const A = g.nodes[e.a], stub = landingStubZ - A.z;
        if (stub <= 0.5) continue;
        this.sMax.set(e.id, stub);
      }
      this.edges.push(e);
    }
    for (let k = g.isle.nodes; k < g.nodes.length; k++) this.nodes.push(g.nodes[k]);
    this.lift = new Float32Array(g.nodes.length);
    this.fixed = new Uint8Array(g.nodes.length);
    this.solveLift();
    this.solveRamps();
    for (const e of this.edges) {
      let m = 0;
      for (let s = 0; s <= e.len; s += 4) m = Math.max(m, this.liftAt(e, s));
      this.maxLift.set(e.id, Math.max(m, this.liftAt(e, e.len)));
    }
    this.solveProfiles();
    this.padLift = Float32Array.from(this.lift);
    this.padGx = new Float32Array(g.nodes.length);
    this.padGz = new Float32Array(g.nodes.length);
    for (const n of this.nodes) if (n.edges.length > 0) this.fitPad(n);
    this.fitShared();
    // The ramps' rims take the pads' heights, and the pads are fitted again to the roads that result.
    this.rampLift.clear();
    this.solveRamps(true);
    this.padLift.set(this.lift); this.padGx.fill(0); this.padGz.fill(0);
    for (const n of this.nodes) if (n.edges.length > 0) this.fitPad(n);
    this.fitShared();
    this.index();
    this.buildJunctions();
    this.clipStrips();
    this.grade();
  }

  // ── Junction shapes ─────────────────────────────────────────────────────────

  /** Where a road's own strip (carriageway, sidewalks, paint) begins: beyond the junction's kerb returns. */
  mouth(e: RoadEdge, atB: boolean): number {
    const i = this.edgeIdx.get(e.id);
    return i === undefined ? this.trim(e, atB) : atB ? this.mouthB[i] : this.mouthA[i];
  }
  /** True where a road runs straight on through a node with nothing to stop it (a join in one road, the Thruway past a ramp): its lines carry through. */
  through(e: RoadEdge, atB: boolean): boolean {
    const j = this.juncs.get(atB ? e.b : e.a);
    return j ? j.arms.some((a) => a.e === e && a.atB === atB && a.thru) : false;
  }

  /** A point on arm a's kerb line (side +1: toward growing angle), u metres out from the node, `off` from the centreline. */
  kerbPt(a: JArm, side: number, u: number, off = a.hw): [number, number] {
    const s = clamp(a.atB ? a.e.len - u : u, 0, a.e.len), q = this.g.pointAt(a.e, s), k = (a.atB ? -1 : 1) * side * off;
    return [q.x - q.dz * k, q.z + q.dx * k];
  }

  private buildJunctions(): void {
    const g = this.g, TAU = Math.PI * 2;
    this.edges.forEach((e, i) => this.edgeIdx.set(e.id, i));
    this.mouthA = Float32Array.from(this.trimA); this.mouthB = Float32Array.from(this.trimB);
    const fast = (e: RoadEdge): boolean => e.kind === 'highway' || e.kind === 'ramp';
    for (const n of this.nodes) {
      const arms: JArm[] = [], seen = new Set<number>();
      for (const id of n.edges) {
        const e = g.edges[id], i = this.edgeIdx.get(id);
        if (i === undefined) continue;
        for (const atB of e.a === e.b ? [false, true] : [e.b === n.id]) {
          if (seen.has(id * 2 + (atB ? 1 : 0))) continue;
          seen.add(id * 2 + (atB ? 1 : 0));
          const t = atB ? this.trimB[i] : this.trimA[i], q = g.pointAt(e, clamp(atB ? e.len - t : t, 0, e.len)), sg = atB ? -1 : 1;
          const ox = q.dx * sg, oz = q.dz * sg;
          arms.push({ e, atB, i, ang: Math.atan2(oz, ox), ox, oz, bx: q.x - ox * t, bz: q.z - oz * t, hw: e.hw, t, m: t, wk: this.walks(e), thru: false });
        }
      }
      if (arms.length < 2) continue;
      arms.sort((a, b) => a.ang - b.ang);
      const rb = n.control === 'roundabout', ctl = n.control === 'signal' || n.control === 'stop', R = this.padR(n);
      if (!rb) {
        for (const a of arms) {
          const p = arms.find((b) => b !== a && b.e.kind === a.e.kind && b.e.divided === a.e.divided && b.e.lanes === a.e.lanes && a.ox * b.ox + a.oz * b.oz < -0.94);
          // A plain join, or the Thruway past slip ramps (every other arm leaves along it): nothing crosses, so the paint runs on.
          a.thru = !!p && ((arms.length === 2 && !ctl) || (fast(a.e) && arms.every((o) => o === a || o === p || Math.max(o.ox * a.ox + o.oz * a.oz, o.ox * p.ox + o.oz * p.oz) > 0.82)));
        }
      }
      const half = (a: JArm): number => Math.max(a.t, Math.min(this.end(a.e), a.e.len) / 2 - 0.3);
      // First the returns' sizes (they set each arm's mouth), then the kerb lines.
      const cs: (JCorner & { X: [number, number]; bis: [number, number] })[] = [];
      for (let k = 0; k < arms.length; k++) {
        const a = arms[k], c = arms[(k + 1) % arms.length];
        let gap = c.ang - a.ang;
        if (gap <= 1e-6) gap += TAU;
        const co = { a, c, gap, walk: a.wk && c.wk && (rb || gap > 2.88), fillet: false, r: 0, ua: a.t, uc: c.t, kerb: [] as number[], back: [] as number[], X: [0, 0] as [number, number], bis: [0, 0] as [number, number] };
        cs.push(co);
        if (rb || gap < 0.44 || gap > 2.88) continue;
        // Kerb lines: a's on its +side, c's on its -side; they cross at X.
        const pax = a.bx - a.oz * a.hw, paz = a.bz + a.ox * a.hw, pcx = c.bx + c.oz * c.hw, pcz = c.bz - c.ox * c.hw;
        const det = a.ox * c.oz - a.oz * c.ox, dx = pcx - pax, dz = pcz - paz;
        const uX = (dx * c.oz - dz * c.ox) / det, vX = (dx * a.oz - dz * a.ox) / det;
        const tmax = Math.min(9, half(a) - uX, half(c) - vX), th = Math.tan(gap / 2);
        if (tmax < 0.8 || uX < -2 || vX < -2) continue;
        const want = ctl ? 3.5 : fast(a.e) || fast(c.e) ? 8 : a.e.kind === 'arterial' && c.e.kind === 'arterial' ? 6.5 : a.e.kind === 'arterial' || c.e.kind === 'arterial' ? 5.5 : 4.5;
        co.r = Math.min(want, tmax * th); co.fillet = true; co.walk = a.wk && c.wk;
        co.X = [pax + a.ox * uX, paz + a.oz * uX];
        const bl = Math.hypot(a.ox + c.ox, a.oz + c.oz) || 1;
        co.bis = [(a.ox + c.ox) / bl, (a.oz + c.oz) / bl];
        if (n.control === 'signal') {
          // The signal for arm c stands on this corner (streetSignals.ts: 1.2 m back from the rim, 0.9 m off the kerb line): the
          // return is tightened until the pole is on the sidewalk, not in the asphalt.
          const back = R + 1.2, px = c.bx + c.ox * back + c.oz * (c.hw + 0.9), pz = c.bz + c.oz * back - c.ox * (c.hw + 0.9), sh = Math.sin(gap / 2);
          for (let k = 0; k < 9 && co.r > 0.7; k++) {
            const cx = co.X[0] + co.bis[0] * (co.r / sh), cz = co.X[1] + co.bis[1] * (co.r / sh);
            if (back >= vX + co.r / th - 0.1 || Math.hypot(px - cx, pz - cz) <= co.r - 0.35) break;
            co.r = Math.max(0.7, co.r * 0.8);
          }
        }
        co.ua = uX + co.r / th; co.uc = vX + co.r / th;
        a.m = Math.max(a.m, co.ua); c.m = Math.max(c.m, co.uc);
      }
      const poly: number[] = [];
      let far = R;
      for (const co of cs) {
        const { a, c, gap } = co, K = co.kerb, B = co.back;
        const put = (p: [number, number], q: [number, number]): void => { K.push(p[0], p[1]); B.push(q[0], q[1]); };
        put(this.kerbPt(a, 1, a.m), this.kerbPt(a, 1, a.m, a.hw + WALK_W));
        if (rb) {
          const a0 = a.ang + Math.asin(Math.min(1, a.hw / R)), a1 = a.ang + gap - Math.asin(Math.min(1, c.hw / R));
          const N = a1 > a0 ? Math.max(1, Math.ceil((a1 - a0) / 0.2244)) : 0;
          for (let i = 0; i <= N && a1 > a0; i++) { const t = a0 + ((a1 - a0) * i) / N, cx = Math.cos(t), sz = Math.sin(t); put([n.x + cx * R, n.z + sz * R], [n.x + cx * (R + WALK_W), n.z + sz * (R + WALK_W)]); }
        } else if (co.fillet) {
          const sh = Math.sin(gap / 2), th = Math.tan(gap / 2), r = co.r, T = r / th, [bx, bz] = co.bis;
          const cx = co.X[0] + bx * (r / sh), cz = co.X[1] + bz * (r / sh);
          const ta: [number, number] = [co.X[0] + a.ox * T, co.X[1] + a.oz * T], tc: [number, number] = [co.X[0] + c.ox * T, co.X[1] + c.oz * T];
          const rbk = r - WALK_W, xb: [number, number] = [co.X[0] + bx * (WALK_W / sh), co.X[1] + bz * (WALK_W / sh)];
          const a0 = Math.atan2(ta[1] - cz, ta[0] - cx);
          let da = Math.atan2(tc[1] - cz, tc[0] - cx) - a0;
          while (da > Math.PI) da -= TAU;
          while (da < -Math.PI) da += TAU;
          const N = Math.max(2, Math.ceil(Math.abs(da) / 0.3));
          for (let i = 0; i <= N; i++) {
            const t = a0 + (da * i) / N, ux = Math.cos(t), uz = Math.sin(t);
            put([cx + ux * r, cz + uz * r], rbk > 0.25 ? [cx + ux * rbk, cz + uz * rbk] : xb);
          }
        } else if (gap > 2.88) {
          // Straight on, or the outside of a bend: round the node at the roads' own half-widths.
          const sw = gap - Math.PI, N = sw > 0.09 ? Math.max(1, Math.ceil(sw / 0.35)) : -1;
          for (let i = 0; i <= N; i++) {
            const f = i / Math.max(1, N), t = a.ang + Math.PI / 2 + sw * f, hw = a.hw + (c.hw - a.hw) * f, cx = Math.cos(t), sz = Math.sin(t);
            put([n.x + cx * hw, n.z + sz * hw], [n.x + cx * (hw + WALK_W), n.z + sz * (hw + WALK_W)]);
          }
        }
        put(this.kerbPt(c, -1, c.m), this.kerbPt(c, -1, c.m, c.hw + WALK_W));
        for (let i = 0; i < K.length; i += 2) { poly.push(K[i], K[i + 1]); far = Math.max(far, Math.hypot(B[i] - n.x, B[i + 1] - n.z), Math.hypot(K[i] - n.x, K[i + 1] - n.z)); }
      }
      for (const a of arms) { if (a.atB) this.mouthB[a.i] = a.m; else this.mouthA[a.i] = a.m; }
      const j: Junction = { n, r: far + 0.5, poly, arms, corners: cs, strips: [] };
      this.juncs.set(n.id, j);
      for (const co of cs) {
        if (co.walk) { j.strips.push(co); continue; }
        // A road with a sidewalk keeps it up to the return where its neighbour has none to join (a ramp, the Thruway).
        for (const [arm, side, u0] of [[co.a, 1, co.ua], [co.c, -1, co.uc]] as [JArm, number, number][]) {
          if (!arm.wk || arm.m - u0 < 0.5) continue;
          const K: number[] = [], Bk: number[] = [], N = Math.ceil((arm.m - u0) / 2.5);
          for (let i = N; i >= 0; i--) {
            const u = u0 + ((arm.m - u0) * i) / N, k = this.kerbPt(arm, side, u, arm.hw + 0.02), b = this.kerbPt(arm, side, u, arm.hw + WALK_W);
            // From the mouth inward, as far as it stays off the junction's asphalt and the other roads' lanes.
            if (this.inJunc(j, (k[0] * 3 + b[0]) / 4, (k[1] * 3 + b[1]) / 4) || arms.some((o) => o.e !== arm.e && (g.project(o.e, k[0], k[1]).d < o.hw + 0.3 || g.project(o.e, b[0], b[1]).d < o.hw + 0.3))) break;
            K.push(k[0], k[1]); Bk.push(b[0], b[1]);
          }
          if (K.length >= 4) j.strips.push({ kerb: K, back: Bk });
        }
      }
      for (let cx = Math.floor((n.x - j.r - CX0) / CELL); cx <= Math.floor((n.x + j.r - CX0) / CELL); cx++) {
        for (let cz = Math.floor((n.z - j.r - CZ0) / CELL); cz <= Math.floor((n.z + j.r - CZ0) / CELL); cz++) {
          const key = this.cellKey(cx, cz);
          let a = this.juncCells.get(key);
          if (!a) { a = []; this.juncCells.set(key, a); }
          a.push(j);
        }
      }
    }
  }

  /** A junction's sidewalk strips stop where another road's asphalt lies (the next junction's corner, a street passing close by). */
  private clipStrips(): void {
    const paved = (x: number, z: number): boolean => {
      const key = this.cellKey(Math.floor((x - CX0) / CELL), Math.floor((z - CZ0) / CELL));
      for (const j of this.juncCells.get(key) ?? []) if ((x - j.n.x) ** 2 + (z - j.n.z) ** 2 < j.r * j.r && this.inJunc(j, x, z)) return true;
      for (const code of this.segCells.get(key) ?? []) {
        const o = this.edges[code >> 10], k = code & 1023, p = this.g.edgePts(o);
        const ax = p[2 * k], az = p[2 * k + 1], dx = p[2 * k + 2] - ax, dz = p[2 * k + 3] - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
        if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (o.hw - 0.15) ** 2 && (this.maxLift.get(o.id) ?? 0) < 0.3) return true;
      }
      return false;
    };
    for (const j of this.juncs.values()) {
      const out: JStrip[] = [];
      for (const st of j.strips) {
        const K = st.kerb, B = st.back;
        let k2: number[] = [], b2: number[] = [];
        const flush = (): void => { if (k2.length >= 4) out.push({ kerb: k2, back: b2 }); k2 = []; b2 = []; };
        for (let i = 0; i + 3 < K.length; i += 2) {
          const kx = (K[i] + K[i + 2]) / 2, kz = (K[i + 1] + K[i + 3]) / 2, bx = (B[i] + B[i + 2]) / 2, bz = (B[i + 1] + B[i + 3]) / 2;
          if (paved(kx * 0.85 + bx * 0.15, kz * 0.85 + bz * 0.15) || paved((kx + bx) / 2, (kz + bz) / 2) || paved(kx * 0.15 + bx * 0.85, kz * 0.15 + bz * 0.85)) { flush(); continue; }
          if (!k2.length) { k2.push(K[i], K[i + 1]); b2.push(B[i], B[i + 1]); }
          k2.push(K[i + 2], K[i + 3]); b2.push(B[i + 2], B[i + 3]);
        }
        flush();
      }
      j.strips = out;
    }
  }

  /** True on a junction's asphalt (the fan the mesh draws). */
  inJunc(j: Junction, x: number, z: number): boolean {
    const p = j.poly, n = j.n, L = p.length;
    for (let i = 0; i < L; i += 2) if (inTri(x, z, n.x, n.z, p[i], p[i + 1], p[(i + 2) % L], p[(i + 3) % L])) return true;
    return false;
  }
  /** True on a junction's corner sidewalk (the strip between a corner's kerb and its back). */
  private inCorner(co: JStrip, x: number, z: number): boolean {
    const K = co.kerb, B = co.back;
    for (let i = 0; i + 3 < K.length; i += 2) {
      if (inTri(x, z, K[i], K[i + 1], B[i], B[i + 1], B[i + 2], B[i + 3]) || inTri(x, z, K[i], K[i + 1], B[i + 2], B[i + 3], K[i + 2], K[i + 3])) return true;
    }
    return false;
  }
  /** Height above the plateau anywhere on a junction: the pad's plane inside its rim, the nearest road's own height beyond it. */
  juncH(j: Junction, x: number, z: number): number {
    const n = j.n, r = this.padR(n);
    if ((x - n.x) ** 2 + (z - n.z) ** 2 <= (r + (n.control === 'roundabout' ? 0.8 : 0.02)) ** 2) return this.padH(n, x, z);
    let bd = Infinity, h = this.padH(n, x, z);
    for (const a of j.arms) {
      const pr = this.g.project(a.e, x, z), d = pr.d - a.hw;
      if (d < bd) { bd = d; h = a.e.kind === 'ramp' ? this.surfLift(a.e, pr.s, x, z) : this.liftAt(a.e, pr.s); }
    }
    return h;
  }
  /** Height of a roundabout's island above its pad, d metres from the centre: a kerb, then a planted mound. */
  islandH(n: RoadNode, d: number): number {
    const f = clamp(d / Math.max(1, this.islandR(n) - 0.8), 0, 1);
    let k = 0;
    while (k < MOUND_F.length - 2 && MOUND_F[k + 1] < f) k++;
    return CURB_H * 2 + MOUND_H[k] + ((MOUND_H[k + 1] - MOUND_H[k]) * (f - MOUND_F[k])) / (MOUND_F[k + 1] - MOUND_F[k]);
  }
  /** Radii of the island's rings (the mesh draws these, so it and islandH agree). */
  islandRings(n: RoadNode): number[] { const r = this.islandR(n); return [...MOUND_F.map((f) => f * Math.max(1, r - 0.8)), r]; }

/**
   * A pad sits on a plane fitted (least squares, a little ridge on the tilt) to the heights its roads have where they meet
   * the rim, so a junction on a grade (the Thruway's exit roundabouts and the exits' signals) has no step at any mouth.
   */
  private fitPad(n: RoadNode): void {
    const g = this.g, pts: [number, number, number][] = [];
    for (const id of n.edges) {
      const e = g.edges[id];
      if (!this.edges.includes(e)) continue;
      const atB = e.b === n.id && e.a !== n.id, s = clamp(atB ? e.len - this.trim(e, true) : this.trim(e, false), 0, e.len), q = g.pointAt(e, s);
      // The rim is a line across the road's width, all at one height: three points hold the pad level across it.
      const v = this.liftAt(e, s);
      // The Thruway's own deck is the surface at its junctions (its ramps meet it and follow it): its rim counts three times over.
      for (let w = 0; w < (e.kind === 'highway' ? 3 : 1); w++) for (const k of [-0.8, 0, 0.8]) pts.push([q.x - q.dz * k * e.hw - n.x, q.z + q.dx * k * e.hw - n.z, v]);
    }
    if (pts.length === 0) return;
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
    if (hi - lo < 0.02 && Math.abs(hi - this.lift[n.id]) < 0.02) return;
    const x = this.plane(pts);
    if (x) { this.padLift[n.id] = x[0]; this.padGx[n.id] = x[1]; this.padGz[n.id] = x[2]; }
  }

  /** Least-squares plane (L0, gx, gz) through points [dx, dz, height] (a little ridge on the tilt), or null if degenerate. */
  private plane(pts: [number, number, number][]): [number, number, number] | null {
    // Normal equations for (L0, gx, gz), then Gaussian elimination.
    const mu = 2, A = [[0, 0, 0], [0, mu, 0], [0, 0, mu]], b = [0, 0, 0];
    for (const [dx, dz, v] of pts) {
      const r = [1, dx, dz];
      for (let i = 0; i < 3; i++) { b[i] += r[i] * v; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; }
    }
    for (let i = 0; i < 3; i++) {
      let m = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[m][i])) m = k;
      [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
      if (Math.abs(A[i][i]) < 1e-9) return null;
      for (let k = i + 1; k < 3; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let v = b[i]; for (let j = i + 1; j < 3; j++) v -= A[i][j] * x[j]; x[i] = v / A[i][i]; }
    return [x[0], x[1], x[2]];
  }

  /**
   * Pads on the Thruway that overlap (exit 130's two ramp junctions are 7.6 m apart, their rims 12.6 m out) would otherwise be
   * two planes at different heights and tilts over the same asphalt: a car on the overlap steps between them, and a ramp's rim
   * sits a few tenths off the deck. Each such cluster shares one plane, fitted to every rim of every road in it.
   */
  private fitShared(): void {
    const g = this.g, hn = this.nodes.filter((n) => n.edges.some((id) => g.edges[id].kind === 'highway' && this.edges.includes(g.edges[id])));
    const seen = new Set<number>();
    for (const n0 of hn) {
      if (seen.has(n0.id)) continue;
      const cl = [n0]; seen.add(n0.id);
      for (let i = 0; i < cl.length; i++) for (const m of hn) if (!seen.has(m.id) && Math.hypot(m.x - cl[i].x, m.z - cl[i].z) < this.padR(m) + this.padR(cl[i])) { seen.add(m.id); cl.push(m); }
      if (cl.length < 2) continue;
      const cx = cl.reduce((a, n) => a + n.x, 0) / cl.length, cz = cl.reduce((a, n) => a + n.z, 0) / cl.length, pts: [number, number, number][] = [], done = new Set<string>();
      for (const n of cl) for (const id of n.edges) {
        const e = g.edges[id];
        // (A road lying wholly inside the cluster has no rim of its own: the shared pad is its surface.)
        if (!this.edges.includes(e) || (cl.includes(g.nodes[e.a]) && cl.includes(g.nodes[e.b]))) continue;
        const atB = e.b === n.id && e.a !== n.id, s = clamp(atB ? e.len - this.trim(e, true) : this.trim(e, false), 0, e.len), q = g.pointAt(e, s), key = id + (atB ? 'b' : 'a');
        if (done.has(key)) continue;
        done.add(key);
        const v = this.liftAt(e, s);
        for (let w = 0; w < (e.kind === 'highway' ? 3 : 1); w++) for (const k of [-0.8, 0, 0.8]) pts.push([q.x - q.dz * k * e.hw - cx, q.z + q.dx * k * e.hw - cz, v]);
      }
      const x = this.plane(pts);
      if (!x) continue;
      for (const n of cl) { this.padLift[n.id] = x[0] + x[1] * (n.x - cx) + x[2] * (n.z - cz); this.padGx[n.id] = x[1]; this.padGz[n.id] = x[2]; }
    }
  }

  /** Height of a node's pad above the plateau at (x, z). */
  padH(n: RoadNode, x: number, z: number): number {
    return this.padLift[n.id] + this.padGx[n.id] * (x - n.x) + this.padGz[n.id] * (z - n.z);
  }

  // ── Shapes ──────────────────────────────────────────────────────────────────

  /** Whether an edge has sidewalks (streets do; the Thruway, ramps and raised roads do not). */
  walks(e: RoadEdge): boolean {
    return (e.kind === 'local' || e.kind === 'arterial' || e.deck === true) && (this.maxLift.get(e.id) ?? 0) < 0.3;
  }
  raised(e: RoadEdge): boolean { return (this.maxLift.get(e.id) ?? 0) >= 0.3; }
  /** Usable arc length of an edge (the island bridge's stub is short). */
  end(e: RoadEdge): number { return this.sMax.get(e.id) ?? e.len; }
  /** Radius of a node's junction pad. Bends of one road (two edges, no control) get the road's own width. */
  padR(n: RoadNode): number {
    if (n.edges.length === 2 && n.control === 'none') return n.hx;
    return n.hx + (n.control === 'roundabout' ? 0 : 0.6);
  }
  /** Where a road's surface starts drawing away from its node (the pad covers the rest). */
  trim(e: RoadEdge, atB: boolean): number {
    const n = this.g.nodes[atB ? e.b : e.a];
    if (e.deck && !atB) return 0;
    if (n.id < this.g.isle.nodes) return 0;
    return n.edges.length <= 1 ? 0 : this.padR(n) - 0.4;
  }
  /** Island radius of a roundabout node. */
  islandR(n: RoadNode): number { return Math.max(6, n.hx - 9); }

  /** Height of the plateau at a point: where a road at grade lies. */
  flat(x: number, z: number): number { return MAIN_Y + hillAt(x, z); }

  /** Lift above the plateau at distance s along an edge (a ramp also follows the Thruway where it hugs it: solveRamps). */
  liftAt(e: RoadEdge, s: number): number {
    const t = this.rampLift.get(e.id), pf = this.prof.get(e.id);
    const at = (a: Float32Array): number => { const f = clamp(s, 0, a.length - 1), i = Math.min(a.length - 2, Math.floor(f)), u = f - i; return a[i] * (1 - u) + a[i + 1] * u; };
    return (t ? at(t) : this.liftBase(e, s)) + (pf ? at(pf) : 0);
  }

  /**
   * An exit ramp runs alongside (often on top of) the Thruway for its last stretch, and the Thruway is lifted where it
   * crosses something. Wherever a ramp's carriageway overlaps or touches a highway's and runs the same way, the ramp takes
   * the highway's height exactly (one surface, no step, no second mesh at a different height). Between those runs and the
   * street end of the ramp (held at the street's grade, flat into its pad) the profile is a cubic: grade is continuous, so
   * no kinks, and it climbs or sinks no faster than it must. `rampReport` keeps each ramp's steepest grade and its worst
   * change of grade per 5 m, for the tests.
   */
  readonly rampReport: { id: number; maxGrade: number; maxKink: number }[] = [];
  private solveRamps(pad = false): void {
    this.rampReport.length = 0;
    const g = this.g, hwys = this.edges.filter((e) => e.kind === 'highway');
    for (const e of this.edges) {
      if (e.kind !== 'ramp') continue;
      const n = Math.ceil(e.len) + 2, V = new Float32Array(n), pin = new Uint8Array(n);
      const ta = this.trim(e, false), tb = this.trim(e, true);
      let any = false;
      const rim0 = Math.min(n - 1, Math.round(ta)), rim1 = Math.max(0, Math.min(n - 1, Math.round(e.len - tb)));
      for (let i = rim0; i <= rim1; i++) {
        const s = Math.min(i, e.len), q = g.pointAt(e, s);
        let h = -1;
        for (const o of hwys) {
          const pr = g.project(o, q.x, q.z);
          if (pr.d >= o.hw + e.hw - 0.3 || pr.s <= 0.5 || pr.s >= o.len - 0.5) continue;
          const d1 = g.pointAt(o, pr.s);
          // Only roads running the same way share a surface; a crossing is an overpass.
          if (Math.abs(q.dx * d1.dx + q.dz * d1.dz) < 0.85 && !this.leaves(e, o, i)) continue;
          h = Math.max(h, this.liftBase(o, pr.s));
        }
        if (h >= 0) { V[i] = h; pin[i] = 1; if (h > 0.05) any = true; }
      }
      const i0 = Math.min(n - 1, Math.round(ta)), i1 = Math.max(0, Math.min(n - 1, Math.round(e.len - tb)));
      // A street's end is held at the street's grade (the Thruway may pass overhead: the ramp has to climb to it); a Thruway node's end takes the height there.
      for (const [i, node] of [[i0, e.a], [i1, e.b]] as [number, number][]) {
        if (this.fixed[node] || !pin[i] || pad) {
          const q = g.pointAt(e, clamp(i, 0, e.len));
          // Second round: the rim meets the pad as it was fitted to the first round's roads.
          V[i] = pad ? Math.max(0, this.padH(g.nodes[node], q.x, q.z)) : this.liftBase(e, clamp(i, 0, e.len));
          pin[i] = 2; if (V[i] > 0.05) any = true;
        }
      }
      if (!any) continue;
      // Where the highway is higher or lower than the ramp can reach at RAMP_GRADE from its rim (or from the next pinned stretch),
      // the shared stretch starts later: only the part of the carriageway truly on the highway has to match it.
      for (const fwd of [true, false]) {
        let prev = fwd ? i0 : i1;
        for (let i = fwd ? i0 + 1 : i1 - 1; fwd ? i <= i1 : i >= i0; i += fwd ? 1 : -1) {
          if (pin[i] !== 1) { if (pin[i] === 2) prev = i; continue; }
          if (Math.abs(V[i] - V[prev]) <= RAMP_GRADE * Math.abs(i - prev)) prev = i; else pin[i] = 0;
        }
      }
      // Inside the pad the ramp is flat at its rim height.
      for (let i = 0; i < i0; i++) if (!pin[i]) { V[i] = V[i0]; pin[i] = 3; }
      for (let i = n - 1; i > i1; i--) if (!pin[i]) { V[i] = V[i1]; pin[i] = 3; }
      // Slope at a pin: along a run of pins its own trend; a lone end pin (a street's grade) is flat.
      const slopeAt = (i: number): number => {
        if (pin[i] === 2 || pin[i] === 3) { const j = i === i0 ? i0 + 1 : i1 - 1; return j >= 0 && j < n && pin[j] === 1 ? (V[j] - V[i]) / (j - i) : 0; }
        let a = i, b = i;
        while (a > 0 && i - a < 4 && pin[a - 1] === 1) a--;
        while (b < n - 1 && b - i < 4 && pin[b + 1] === 1) b++;
        return b > a ? (V[b] - V[a]) / (b - a) : 0;
      };
      let last = -1;
      for (let i = 0; i < n; i++) {
        if (!pin[i]) continue;
        if (last >= 0 && i - last > 1) {
          const L = i - last, v0 = V[last], v1 = V[i], m0 = slopeAt(last) * L, m1 = slopeAt(i) * L;
          for (let k = 1; k < L; k++) {
            const t = k / L, t2 = t * t, t3 = t2 * t;
            V[last + k] = (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1;
          }
        }
        last = i;
      }
      for (let i = 0; i < n; i++) V[i] = Math.max(0, V[i]);
      let mg = 0, mk = 0;
      for (let i = 1; i < n; i++) mg = Math.max(mg, Math.abs(V[i] - V[i - 1]));
      for (let i = 5; i < n; i++) mk = Math.max(mk, Math.abs((V[i] - V[i - 5]) / 5 - (V[i - 5] - V[Math.max(0, i - 10)]) / 5));
      this.rampReport.push({ id: e.id, maxGrade: mg, maxKink: mk });
      this.rampLift.set(e.id, V);
    }
  }

  /**
   * A street over a steep hill face follows the ground, grade and all (Chapel Hill Rd climbed 15%). Its profile is the ground's
   * upper envelope, smoothed: valleys are bridged by fill (the terrain is graded up to it, see grade()), crests are kept, and
   * each end meets its street at the ground's own height. Only streets over the grade limit get one.
   */
  private solveProfiles(): void {
    for (const e of this.edges) {
      if (e.kind === 'ramp' || e.kind === 'highway' || e.deck || (this.maxLift.get(e.id) ?? 0) >= 0.3) continue;
      const n = Math.ceil(e.len) + 2, f = new Float32Array(n);
      let steep = 0;
      for (let i = 0; i < n; i++) { const q = this.g.pointAt(e, Math.min(i, e.len)); f[i] = this.flat(q.x, q.z) + this.liftAt(e, Math.min(i, e.len)); if (i) steep = Math.max(steep, Math.abs(f[i] - f[i - 1])); }
      if (steep < 0.1) continue;
      const env = new Float32Array(n), H = new Float32Array(n), W1 = 14, W2 = 22;
      for (let i = 0; i < n; i++) { let m = -1e9; for (let k = Math.max(0, i - W1); k <= Math.min(n - 1, i + W1); k++) m = Math.max(m, f[k]); env[i] = m; }
      for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = Math.max(0, i - W2); k <= Math.min(n - 1, i + W2); k++) { a += env[k]; c++; } H[i] = Math.max(f[i], a / c); }
      // Back to the ground's own height at the ends (the pads sit on it).
      const out = new Float32Array(n), ta = this.trim(e, false) + 6, tb = this.trim(e, true) + 6;
      for (let i = 0; i < n; i++) out[i] = (H[i] - f[i]) * smooth(clamp((i - ta) / 24, 0, 1)) * smooth(clamp((e.len - i - tb) / 24, 0, 1));
      this.prof.set(e.id, out);
    }
  }

  private hwysList: RoadEdge[] | null = null;
  private readonly nearBuf = new Map<number, [number, number]>();
  /**
   * Height above the plateau of edge e's surface at arc s, at the actual point (x, z). A ramp's own profile is constant across
   * its width, but the Thruway it lies on is not (its height follows ITS arc, which runs at an angle to the ramp's), so where
   * a ramp's carriageway is on the Thruway's the two are one surface: the Thruway's height, blended in over 1.5 m at the edge.
   * Both the mesh and groundAt use this, so they agree.
   */
  surfLift(e: RoadEdge, s: number, x: number, z: number): number {
    const h = this.liftAt(e, s);
    if (e.kind !== 'ramp') return h;
    const hw = this.hwysList ?? (this.hwysList = this.edges.filter((o) => o.kind === 'highway'));
    const q = this.g.pointAt(e, clamp(s, 0, e.len));
    for (const o of hw) {
      const pr = this.g.project(o, x, z);
      // (The highway's own surface reaches 0.6 m past its half-width: the ramp holds its height there, then eases off over 1.5 m.)
      if (pr.d >= o.hw + 2.1 || pr.s <= 0.5 || pr.s >= o.len - 0.5) continue;
      const d1 = this.g.pointAt(o, pr.s);
      if (Math.abs(q.dx * d1.dx + q.dz * d1.dz) < 0.85 && !this.leaves(e, o, s)) continue;
      const ho = this.liftBase(o, pr.s);
      if (Math.abs(ho - h) > 0.8) continue;
      return h + (ho - h) * smooth(clamp((o.hw + 2.1 - pr.d) / 1.5, 0, 1));
    }
    return h;
  }

  /**
   * True within 30 m of the node where ramp e starts (or ends) on the end of highway o: there it turns away from the highway (at
   * the Thruway's cut end it even doubles back) while still on its carriageway, so it is one surface with it whatever its heading.
   */
  private leaves(e: RoadEdge, o: RoadEdge, s: number): boolean {
    return ((o.a === e.a || o.b === e.a) && s < 30) || ((o.a === e.b || o.b === e.b) && s > e.len - 30);
  }

  private liftBase(e: RoadEdge, s: number): number {
    // Each end's lift dies away along the edge (by the far end when that end is held at grade).
    const La = this.lift[e.a], Lb = this.lift[e.b], L = Math.max(e.len, 1e-3);
    const Ra = this.fixed[e.b] ? Math.min(LIFT_R, L) : LIFT_R, Rb = this.fixed[e.a] ? Math.min(LIFT_R, L) : LIFT_R;
    let h = Math.max(La > 0 ? La * (1 - smooth(clamp(s / Ra, 0, 1))) : 0, Lb > 0 ? Lb * (1 - smooth(clamp((L - s) / Rb, 0, 1))) : 0);
    const bs = this.bumps.get(e.id);
    if (bs) {
      for (const b of bs) {
        let v = b.h * lf(Math.abs(s - b.s), b.flat);
        if (this.fixed[e.a]) v *= smooth(s / 30);
        if (this.fixed[e.b]) v *= smooth((e.len - s) / 30);
        h = Math.max(h, v);
      }
    }
    return h;
  }

  // ── Overpasses ──────────────────────────────────────────────────────────────

  private solveLift(): void {
    const g = this.g;
    const dirAt = (e: RoadEdge, s: number): [number, number] => { const p = g.pointAt(e, s); return [p.dx, p.dz]; };
    const fast = (e: RoadEdge): boolean => e.kind === 'highway' || e.kind === 'ramp';
    for (const o of g.overpasses) {
      const U = g.edges[o.upper], L = g.edges[o.lower];
      if (!U || !L) continue;
      const su = g.project(U, o.x, o.z).s, sl = g.project(L, o.x, o.z).s;
      const [ux, uz] = dirAt(U, su), [lx, lz] = dirAt(L, sl);
      const sin = Math.abs(ux * lz - uz * lx);
      // A shallow "crossing" is two traced roads running side by side (a ramp hugging the Thruway): no bridge.
      if (sin < 0.42) continue;
      const half = (L.hw + WALK_W + 1.5) / sin + U.hw * Math.sqrt(Math.max(0, 1 - sin * sin)) / sin;
      this.passes.push({ o, upper: U, lower: L, s: su, half });
    }
    // The lower roads stay at grade, end to end; so does every junction with a street (ramps climb from there).
    for (const p of this.passes) {
      for (const id of g.roadEdges.get(p.lower.road ?? '') ?? [p.lower.id]) { const e = g.edges[id]; this.fixed[e.a] = 1; this.fixed[e.b] = 1; }
    }
    for (const n of this.nodes) if (n.edges.some((id) => !fast(g.edges[id]))) this.fixed[n.id] = 1;
    for (const p of this.passes) {
      const flat = p.half + 4;
      const list = this.bumps.get(p.upper.id) ?? [];
      list.push({ s: p.s, flat, h: LIFT_H });
      this.bumps.set(p.upper.id, list);
      // Distance along the fast roads from the crossing to every node (Dijkstra; a hundred nodes).
      const dist = new Map<number, number>([[p.upper.a, p.s], [p.upper.b, p.upper.len - p.s]]);
      const open = [p.upper.a, p.upper.b], done = new Set<number>();
      while (open.length) {
        let bi = 0;
        for (let k = 1; k < open.length; k++) if (dist.get(open[k])! < dist.get(open[bi])!) bi = k;
        const cur = open.splice(bi, 1)[0];
        if (done.has(cur)) continue;
        done.add(cur);
        const d = dist.get(cur)!;
        if (this.fixed[cur]) continue;
        this.lift[cur] = Math.max(this.lift[cur], LIFT_H * lf(d, flat));
        if (d > flat + LIFT_R) continue;
        for (const id of g.nodes[cur].edges) {
          const e = g.edges[id];
          if (!fast(e) || e === p.upper) continue;
          const nb = g.other(e, cur), nd = d + e.len;
          if (nd < (dist.get(nb) ?? Infinity)) { dist.set(nb, nd); open.push(nb); }
        }
      }
    }
  }

  // ── Lookup grid ─────────────────────────────────────────────────────────────

  private cellKey(cx: number, cz: number): number { return cz * CNX + cx; }

  private index(): void {
    this.trimA = Float32Array.from(this.edges, (e) => this.trim(e, false));
    this.trimB = Float32Array.from(this.edges, (e) => this.trim(e, true));
    this.edges.forEach((e, i) => {
      const p = this.g.edgePts(e), r = e.hw + WALK_W + 1;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const x0 = Math.min(p[k], p[k + 2]) - r, x1 = Math.max(p[k], p[k + 2]) + r;
        const z0 = Math.min(p[k + 1], p[k + 3]) - r, z1 = Math.max(p[k + 1], p[k + 3]) + r;
        for (let cx = Math.floor((x0 - CX0) / CELL); cx <= Math.floor((x1 - CX0) / CELL); cx++) {
          for (let cz = Math.floor((z0 - CZ0) / CELL); cz <= Math.floor((z1 - CZ0) / CELL); cz++) {
            const key = this.cellKey(cx, cz);
            let a = this.segCells.get(key);
            if (!a) { a = []; this.segCells.set(key, a); }
            a.push(i * 1024 + k / 2);
          }
        }
      }
    });
    for (const n of this.nodes) {
      if (n.edges.length === 0) continue;
      const r = this.padR(n);
      for (let cx = Math.floor((n.x - r - CX0) / CELL); cx <= Math.floor((n.x + r - CX0) / CELL); cx++) {
        for (let cz = Math.floor((n.z - r - CZ0) / CELL); cz <= Math.floor((n.z + r - CZ0) / CELL); cz++) {
          const key = this.cellKey(cx, cz);
          let a = this.padCells.get(key);
          if (!a) { a = []; this.padCells.set(key, a); }
          a.push(n.id);
        }
      }
    }
  }

  /**
   * What lies at (x, z): 'road' (height of the road surface), 'walk' (a sidewalk or an island, a curb up) or null.
   * hint: the asker's own height, to choose between an overpass and the road under it (lowest without one).
   */
  probe(x: number, z: number, hint = -Infinity): { kind: 'road' | 'walk' | null; h: number } {
    const key = this.cellKey(Math.floor((x - CX0) / CELL), Math.floor((z - CZ0) / CELL));
    const fl = this.flat(x, z);
    const pads = this.padCells.get(key);
    let lo = Infinity, hi = -Infinity, best = -Infinity;
    // The surface the asker is on: of those within a 2 m step up, the nearest its own height (not the highest: where a ramp and
    // the Thruway overlap at different heights, a car on the ramp stays on the ramp).
    const take = (h: number): void => {
      lo = Math.min(lo, h);
      if (h <= hint + 2 && (best === -Infinity || Math.abs(h - hint) < Math.abs(best - hint))) best = h;
      hi = Math.max(hi, h);
    };
    let padHit = false;
    if (pads) {
      for (const id of pads) {
        const n = this.g.nodes[id], d2 = (x - n.x) ** 2 + (z - n.z) ** 2, r = this.padR(n);
        if (d2 > r * r) continue;
        // The pad is the junction's asphalt: where the rim pokes past a kerb, the kerb wins.
        const jn = this.juncs.get(id);
        if (jn && !this.inJunc(jn, x, z)) continue;
        padHit = true;
        if (n.control === 'roundabout' && d2 < this.islandR(n) ** 2) return { kind: 'walk', h: fl + this.padH(n, x, z) + this.islandH(n, Math.sqrt(d2)) };
        take(fl + this.padH(n, x, z));
      }
    }
    let walk = false, walkL = 0;
    const segs = this.segCells.get(key);
    if (segs) {
      // One surface per road: the nearest of its segments (on the inside of a bend a road is within reach of two stretches
      // of itself, at heights a few tenths apart on a ramp).
      const near = this.nearBuf; near.clear();
      for (const code of segs) {
        const e = this.edges[code >> 10], k = code & 1023, p = this.g.edgePts(e), cum = e.cum ?? [0, e.len];
        const ax = p[2 * k], az = p[2 * k + 1], bx = p[2 * k + 2], bz = p[2 * k + 3];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
        const qx = ax + dx * t - x, qz = az + dz * t - z, d2 = qx * qx + qz * qz;
        const wk = this.walks(e), lim = e.hw + (wk ? WALK_W : 0.6);
        if (d2 > lim * lim) continue;
        const s = cum[k] + t * (cum[k + 1] - cum[k]);
        if (s > this.end(e) + 0.5) continue;
        // The pad owns the ground inside its rim (the mesh starts the carriageway there).
        if (padHit && (s < this.trimA[code >> 10] - 0.7 || s > e.len - this.trimB[code >> 10] + 0.7)) continue;
        const d = Math.sqrt(d2);
        if (d <= e.hw + (wk ? 0 : 0.6)) { const prev = near.get(code >> 10); if (!prev || d < prev[0]) near.set(code >> 10, [d, s]); }
        else if (wk && s >= this.mouthA[code >> 10] && s <= e.len - this.mouthB[code >> 10]) { walk = true; walkL = this.prof.has(e.id) ? this.liftAt(e, s) : 0; }
      }
      for (const [ei, [, s]] of near) {
        const e = this.edges[ei];
        take(fl + (e.kind === 'ramp' ? this.surfLift(e, s, x, z) : this.liftAt(e, s)));
      }
    }
    // Off every carriageway and pad: a junction's rounded corner is asphalt outside the roads' own widths, and its sidewalk wraps round it.
    if (lo === Infinity || lo > fl + 1) {
      const js = this.juncCells.get(key);
      if (js) {
        let on = false;
        for (const j of js) {
          if ((x - j.n.x) ** 2 + (z - j.n.z) ** 2 > j.r * j.r || !this.inJunc(j, x, z)) continue;
          const h = this.juncH(j, x, z);
          // Under an overpass the junction below is the ground; a junction up at the span's own height is the span.
          if (lo === Infinity || h < lo - fl - 1) take(fl + h);
          on = true;
          break;
        }
        if (!on && !walk) {
          for (const j of js) {
            if (walk || (x - j.n.x) ** 2 + (z - j.n.z) ** 2 > j.r * j.r) continue;
            for (const st of j.strips) if (this.inCorner(st, x, z)) { walk = true; walkL = this.juncH(j, x, z); break; }
          }
        }
      }
    }
    // A sidewalk under an overpass is still a sidewalk: it only loses to a road at its own level.
    if (walk && lo !== Infinity && lo > fl + 1) take(fl + walkL + CURB_H);
    if (lo !== Infinity) return { kind: 'road', h: hint === -Infinity ? lo : best > -Infinity ? best : lo };
    if (walk) return { kind: 'walk', h: fl + walkL + CURB_H };
    void hi;
    return { kind: null, h: 0 };
  }

  /** groundAt() for the mainland under the new plan. */
  groundAt(x: number, z: number, hint = -Infinity): number {
    const p = this.probe(x, z, hint);
    return p.kind === null ? mainlandTerrain(x, z) : p.h;
  }

  /** True when (x, z) is on another road's carriageway than `e`, or on a junction pad where three or more roads meet. */
  covered(x: number, z: number, e: RoadEdge): boolean {
    const key = this.cellKey(Math.floor((x - CX0) / CELL), Math.floor((z - CZ0) / CELL));
    for (const id of this.padCells.get(key) ?? []) {
      const n = this.g.nodes[id], r = this.padR(n);
      if (n.edges.length >= 3 && (x - n.x) ** 2 + (z - n.z) ** 2 < r * r) return true;
    }
    // A junction's asphalt reaches past the roads' own widths at its kerb returns: nothing is planted or stood there either.
    for (const j of this.juncCells.get(key) ?? []) if ((x - j.n.x) ** 2 + (z - j.n.z) ** 2 < j.r * j.r && this.inJunc(j, x, z)) return true;
    for (const code of this.segCells.get(key) ?? []) {
      const o = this.edges[code >> 10];
      if (o === e) continue;
      const k = code & 1023, p = this.g.edgePts(o);
      const ax = p[2 * k], az = p[2 * k + 1], dx = p[2 * k + 2] - ax, dz = p[2 * k + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (o.hw - 0.2) ** 2) return true;
    }
    return false;
  }

  /** True when no other road's carriageway comes within m metres (up to 4) of (x, z), and no junction reaches it. */
  clearOf(x: number, z: number, e: RoadEdge, m: number): boolean {
    const key = this.cellKey(Math.floor((x - CX0) / CELL), Math.floor((z - CZ0) / CELL));
    for (const j of this.juncCells.get(key) ?? []) if ((x - j.n.x) ** 2 + (z - j.n.z) ** 2 < (j.r + m) ** 2) return false;
    for (const code of this.segCells.get(key) ?? []) {
      const o = this.edges[code >> 10];
      if (o === e) continue;
      const k = code & 1023, p = this.g.edgePts(o);
      const ax = p[2 * k], az = p[2 * k + 1], dx = p[2 * k + 2] - ax, dz = p[2 * k + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (o.hw + m) ** 2) return false;
    }
    return true;
  }

  /** Which road keeps a surface two roads share: the faster kind, then the wider, then the lower id. */
  rank(e: RoadEdge): number {
    return (e.kind === 'highway' ? 4 : e.kind === 'ramp' ? 3 : e.kind === 'arterial' ? 2 : 1) * 1e4 + e.hw * 100 - e.id * 0.01;
  }

  /** True when (x, z) lies on the carriageway of a road that outranks `e` at about the same height (the mesh of `e` is clipped there). */
  outranked(x: number, z: number, e: RoadEdge, y: number): boolean {
    const key = this.cellKey(Math.floor((x - CX0) / CELL), Math.floor((z - CZ0) / CELL)), re = this.rank(e);
    for (const code of this.segCells.get(key) ?? []) {
      const o = this.edges[code >> 10];
      if (o === e || this.rank(o) <= re) continue;
      const k = code & 1023, p = this.g.edgePts(o), cum = o.cum ?? [0, o.len];
      const ax = p[2 * k], az = p[2 * k + 1], dx = p[2 * k + 2] - ax, dz = p[2 * k + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 >= (o.hw - 0.03) ** 2) continue;
      const so = cum[k] + t * (cum[k + 1] - cum[k]);
      if (so < this.trim(o, false) || so > this.end(o) || so > o.len - this.trim(o, true)) continue;
      if (Math.abs(this.liftAt(o, so) - y) < 0.4) return true;
    }
    return false;
  }

  /** True within `m` m of any road's paved edge or sidewalk (for planting and props to keep clear). */
  nearRoad(x: number, z: number, m: number): boolean {
    for (const dx of [-m, 0, m]) for (const dz of [-m, 0, m]) if (this.probe(x + dx, z + dz).kind !== null) return true;
    return false;
  }

  // ── Grading ─────────────────────────────────────────────────────────────────

  private grade(): void {
    const w = this.w, F = 22;
    const stamp = (x: number, z: number, C: number, L = 0): void => {
      const R = C + F;
      const i0 = Math.max(0, Math.floor((x - R - GX0) / GS)), i1 = Math.min(GNX - 1, Math.ceil((x + R - GX0) / GS));
      const j0 = Math.max(0, Math.floor((z - R - GZ0) / GS)), j1 = Math.min(GNZ - 1, Math.ceil((z + R - GZ0) / GS));
      for (let j = j0; j <= j1; j++) {
        const pz = GZ0 + j * GS;
        for (let i = i0; i <= i1; i++) {
          const px = GX0 + i * GS, d = Math.hypot(px - x, pz - z);
          if (d >= R) continue;
          const v = d <= C ? 1 : 1 - smooth((d - C) / F), c = j * GNX + i;
          if (v > w[c] || (v === w[c] && d < this.ld[c])) { w[c] = v; this.lw[c] = L; this.ld[c] = d; }
        }
      }
    };
    for (const e of this.edges) {
      const C = e.hw + (this.walks(e) ? WALK_W : 1) + 3, end = this.end(e);
      const pf = this.prof.has(e.id);
      for (let s = 0; s <= end; s += pf ? 1.5 : 3) { const p = this.g.pointAt(e, s); stamp(p.x, p.z, C, pf ? this.liftAt(e, s) : 0); }
    }
    for (const n of this.nodes) if (n.edges.length) stamp(n.x, n.z, this.padR(n) + 4);
    // The river's channel stays open.
    for (let j = 0; j < GNZ; j++) for (let i = 0; i < GNX; i++) if (inRiver(GX0 + i * GS, GZ0 + j * GS)) w[j * GNX + i] = 0;
  }

  /** Terrain after grading: natural ground pulled up toward the plateau near roads. */
  graded(x: number, z: number, nat: number): number {
    const fx = (x - GX0) / GS, fz = (z - GZ0) / GS;
    if (fx < 0 || fz < 0 || fx >= GNX - 1 || fz >= GNZ - 1) return nat;
    if (lookoutW(x, z) > 0.001) return nat; // Johnson Pond's lookout is shaped on purpose: the road's fill must not raise it back
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, c = j * GNX + i, w = this.w;
    const k = (w[c] * (1 - u) + w[c + 1] * u) * (1 - v) + (w[c + GNX] * (1 - u) + w[c + GNX + 1] * u) * v;
    if (k <= 0) return nat;
    const L = (this.lw[c] * (1 - u) + this.lw[c + 1] * u) * (1 - v) + (this.lw[c + GNX] * (1 - u) + this.lw[c + GNX + 1] * u) * v;
    const fl = this.flat(x, z) + L;
    return fl > nat ? nat + (fl - nat) * k : nat;
  }

  /** Spots where a road's fill crosses a stream (not the river): x, z, edge, s. For culverts. */
  culverts(): { x: number; z: number; e: RoadEdge; s: number }[] {
    const out: { x: number; z: number; e: RoadEdge; s: number }[] = [];
    for (const e of this.edges) {
      let run: number[] = [];
      const flush = (): void => {
        if (run.length) { const s = run[Math.floor(run.length / 2)], p = this.g.pointAt(e, s); out.push({ x: p.x, z: p.z, e, s }); }
        run = [];
      };
      for (let s = 0; s <= this.end(e); s += 2) {
        const p = this.g.pointAt(e, s);
        if (!inRiver(p.x, p.z, 10) && waterDist(p.x, p.z) < 0 && naturalTerrain(p.x, p.z) < 1) run.push(s); else flush();
      }
      flush();
    }
    return out;
  }
}
