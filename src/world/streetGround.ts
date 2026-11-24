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
import { MAIN_Y, RIVER_HW, hillAt, mainlandTerrain, naturalTerrain, riverX, waterDist } from './mainland';
import type { Overpass, StreetGraph } from './streets';
import type { RoadEdge, RoadNode } from './plan';

export const WALK_W = 3.5, CURB_H = 0.16;
/** Height an overpass carries its road above the one below, and how far each way it takes to climb there. */
export const LIFT_H = 6.6;
const LIFT_R = 95;
/** Steepest a ramp may climb or sink where it meets the Thruway (11%: the Thruway's own steepest, so a ramp can match it). */
const RAMP_SLOPE = 0.11;
const CELL = 16, CX0 = -1040, CZ0 = -3060, CNX = 128;
const GS = 4, GX0 = -1000, GZ0 = -3010, GNX = 512, GNZ = 548;

export interface Bump { s: number; flat: number; h: number }
/** An overpass the surfaces honour: the upper edge's arc position and how long its open span is. */
export interface Passage { o: Overpass; upper: RoadEdge; lower: RoadEdge; s: number; half: number }

const lf = (d: number, flat: number): number => (d <= flat ? 1 : d >= flat + LIFT_R ? 0 : 1 - smooth((d - flat) / LIFT_R));
/** True in the Muddle River's channel (never graded: roads cross it on decks). */
export const inRiver = (x: number, z: number, m = 3): boolean => x > 230 && x < 450 && Math.abs(x - riverX(z)) < RIVER_HW + m;

export class StreetSurface {
  /** Mainland edges with a surface (the island bridge's landing stub included, limited by sMax). */
  readonly edges: RoadEdge[] = [];
  readonly nodes: RoadNode[] = [];
  /** Lift of each node above the plateau, by graph node id. */
  readonly lift: Float32Array;
  readonly passes: Passage[] = [];
  private readonly bumps = new Map<number, Bump[]>();
  /** Per-ramp lift samples, 1 m apart (solveRamps). */
  private readonly rampLift = new Map<number, Float32Array>();
  private readonly fixed: Uint8Array;
  private readonly maxLift = new Map<number, number>();
  private readonly sMax = new Map<number, number>();
  private readonly segCells = new Map<number, number[]>();
  private readonly padCells = new Map<number, number[]>();
  private readonly w = new Float32Array(GNX * GNZ);

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
    this.index();
    this.grade();
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
    const h = this.liftBase(e, s), t = this.rampLift.get(e.id);
    if (!t) return h;
    const f = clamp(s, 0, t.length - 1), i = Math.min(t.length - 2, Math.floor(f)), u = f - i;
    return Math.max(h, t[i] * (1 - u) + t[i + 1] * u);
  }

  /**
   * An exit ramp runs alongside (often on top of) the Thruway for its last stretch, and the Thruway is lifted where it
   * crosses something: a ramp left at grade ended in a cliff against the raised carriageway (traffic stopped at the foot
   * of it, Nov 24). Every ramp takes the Thruway's height wherever they share a carriageway, and climbs or sinks to it at
   * no more than RAMP_SLOPE, ahead of the meeting and after it. A fixed end stays at the street's level.
   */
  private solveRamps(): void {
    const g = this.g, hwys = this.edges.filter((e) => e.kind === 'highway');
    for (const e of this.edges) {
      if (e.kind !== 'ramp') continue;
      const n = Math.ceil(e.len) + 2, T = new Float32Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        const s = Math.min(i, e.len), q = g.pointAt(e, s);
        let h = this.liftBase(e, s);
        for (const o of hwys) {
          const pr = g.project(o, q.x, q.z);
          if (pr.d < o.hw + e.hw - 0.5 && pr.s > 0.5 && pr.s < o.len - 0.5) h = Math.max(h, this.liftBase(o, pr.s));
        }
        T[i] = h; if (h > 0.05) any = true;
      }
      if (!any) continue;
      const L = T.slice();
      for (let i = 1; i < n; i++) L[i] = Math.max(L[i], L[i - 1] - RAMP_SLOPE);
      for (let i = n - 2; i >= 0; i--) L[i] = Math.max(L[i], L[i + 1] - RAMP_SLOPE);
      // A fixed end meets its street at grade: pin it, and let the climb start there (the slope bound is kept by taking the lower).
      if (this.fixed[e.a]) for (let i = 0; i < n; i++) L[i] = Math.min(L[i], i * RAMP_SLOPE);
      if (this.fixed[e.b]) for (let i = 0; i < n; i++) L[i] = Math.min(L[i], Math.max(0, e.len - i) * RAMP_SLOPE);
      this.rampLift.set(e.id, L);
    }
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
    const take = (h: number): void => {
      lo = Math.min(lo, h);
      if (h <= hint + 2 && h > best) best = h;
      hi = Math.max(hi, h);
    };
    if (pads) {
      for (const id of pads) {
        const n = this.g.nodes[id], d2 = (x - n.x) ** 2 + (z - n.z) ** 2, r = this.padR(n);
        if (d2 > r * r) continue;
        if (n.control === 'roundabout' && d2 < this.islandR(n) ** 2) return { kind: 'walk', h: fl + CURB_H * 2 };
        take(fl + this.lift[id]);
      }
    }
    let walk = false;
    const segs = this.segCells.get(key);
    if (segs) {
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
        const d = Math.sqrt(d2);
        if (d <= e.hw + (wk ? 0 : 0.6)) take(fl + this.liftAt(e, s));
        else if (wk && s >= this.trim(e, false) && s <= e.len - this.trim(e, true)) walk = true;
      }
    }
    // A sidewalk under an overpass is still a sidewalk: it only loses to a road at its own level.
    if (walk && lo > fl + 1) take(fl + CURB_H);
    if (lo !== Infinity) return { kind: 'road', h: hint === -Infinity ? lo : best > -Infinity ? best : lo };
    if (walk) return { kind: 'walk', h: fl + CURB_H };
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

  /** True within `m` m of any road's paved edge or sidewalk (for planting and props to keep clear). */
  nearRoad(x: number, z: number, m: number): boolean {
    for (const dx of [-m, 0, m]) for (const dz of [-m, 0, m]) if (this.probe(x + dx, z + dz).kind !== null) return true;
    return false;
  }

  // ── Grading ─────────────────────────────────────────────────────────────────

  private grade(): void {
    const w = this.w, F = 22;
    const stamp = (x: number, z: number, C: number): void => {
      const R = C + F;
      const i0 = Math.max(0, Math.floor((x - R - GX0) / GS)), i1 = Math.min(GNX - 1, Math.ceil((x + R - GX0) / GS));
      const j0 = Math.max(0, Math.floor((z - R - GZ0) / GS)), j1 = Math.min(GNZ - 1, Math.ceil((z + R - GZ0) / GS));
      for (let j = j0; j <= j1; j++) {
        const pz = GZ0 + j * GS;
        for (let i = i0; i <= i1; i++) {
          const px = GX0 + i * GS, d = Math.hypot(px - x, pz - z);
          if (d >= R) continue;
          const v = d <= C ? 1 : 1 - smooth((d - C) / F), c = j * GNX + i;
          if (v > w[c]) w[c] = v;
        }
      }
    };
    for (const e of this.edges) {
      const C = e.hw + (this.walks(e) ? WALK_W : 1) + 3, end = this.end(e);
      for (let s = 0; s <= end; s += 3) { const p = this.g.pointAt(e, s); stamp(p.x, p.z, C); }
    }
    for (const n of this.nodes) if (n.edges.length) stamp(n.x, n.z, this.padR(n) + 4);
    // The river's channel stays open.
    for (let j = 0; j < GNZ; j++) for (let i = 0; i < GNX; i++) if (inRiver(GX0 + i * GS, GZ0 + j * GS)) w[j * GNX + i] = 0;
  }

  /** Terrain after grading: natural ground pulled up toward the plateau near roads. */
  graded(x: number, z: number, nat: number): number {
    const fx = (x - GX0) / GS, fz = (z - GZ0) / GS;
    if (fx < 0 || fz < 0 || fx >= GNX - 1 || fz >= GNZ - 1) return nat;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, c = j * GNX + i, w = this.w;
    const k = (w[c] * (1 - u) + w[c + 1] * u) * (1 - v) + (w[c + GNX] * (1 - u) + w[c + GNX + 1] * u) * v;
    if (k <= 0) return nat;
    const fl = this.flat(x, z);
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
