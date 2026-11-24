// Tepid Falls' new street graph (tepid-streets.md step 2): angled and curved roads after real Waterville.
//
// Pure data, no rendering. Built from streetData.ts (the traced plan) unless the page has ?streets=old;
// CityPlan keeps it as `plan.streets` beside the old grid until the last unit makes it the default.
//
// The graph
//   nodes / edges   the island's grid FIRST, with the same ids as CityPlan's (multiplayer and saves key on
//                   them; island edges are the very same objects, island nodes are copies whose edge lists
//                   hold this graph's bridge id), then the mainland: polyline edges between junction nodes,
//                   then The Perpetual Bridge last (deck, mainland end = a).
//   RoadEdge.pts    flat x,z centreline from node a to node b (both ends included), cum = arc length at
//                   each point, len = cum[last]. Grid edges have no pts: edgePts() makes one of two points.
//   oneWay          traffic only a -> b. divided: a median (draw two carriageways). kind: highway | arterial
//                   | local | ramp | bridge. road: id of the plan road it was cut from.
//   RoadNode        control: signal | stop | roundabout | end | none; ring = roundabout radius (the node
//                   sits at the centre and its edges' polylines run in to the centre); hx = hz = the radius
//                   of the junction pad.
//   overpasses      grade-separated crossings: NOT nodes. upper = the highway or ramp edge.
//   blocks          the faces of the planar road map (overpasses split for this only), as polygons of road
//                   centrelines, with district and stage (the lowest stage of the roads around it).
//   lots            oriented frontage lots inside blocks, facing their street, clear of every road.
//   parking         curb-side spots along locals and arterials.

import { RNG, clamp } from '../core/util';
import { MAIN_SPLIT_Z, coastSD, riverX, waterDist, type MainDistrict } from './mainland';
import { PD } from './pardonsSite';
import { PLAN_JUNCTIONS, PLAN_ROADS, PLAN_ROUNDABOUTS, PLAN_SIGNALS, type RoadKind } from './streetData';
import type { ParkSpot, RoadEdge, RoadNode } from './plan';

/**
 * The new graph is the default since step 2 unit 2 (owner: rebuild the live map in place, glitches and all);
 * ?streets=old brings back the old mainland grid until the rebuild is done.
 */
export const STREETS_NEW = typeof location === 'undefined' || new URLSearchParams(location.search).get('streets') !== 'old';

export type NodeControl = 'signal' | 'stop' | 'roundabout' | 'end' | 'none';
export type EdgeKind = RoadKind | 'bridge';

export interface Overpass { x: number; z: number; upper: number; lower: number }
export interface StreetBlock {
  id: number;
  /** Polygon of road centrelines, flat x,z, counter-clockwise in (x, z) (positive shoelace area). */
  poly: number[];
  /** Edge id of each polygon side (side k runs from point k to k+1), -1 where an overpass split it. */
  sides: number[];
  area: number; cx: number; cz: number;
  x0: number; z0: number; x1: number; z1: number;
  district: MainDistrict | null;
  stage: number;
  /** Mostly water or beach: nothing gets built. */
  open: boolean;
}
export interface StreetLot {
  /** Centre, frontage width (along the street), depth, and heading the front faces (0 = +Z, as ParkSpot.h). */
  cx: number; cz: number; w: number; d: number; h: number;
  block: number; edge: number; district: MainDistrict; stage: number;
}

// Local copies of plan.ts's street sizes (no value import: plan.ts imports this file).
const AVE_HW = 10, ST_HW = 6, SIDEWALK = 3.5;

/** Half-width of the paved road for a plan road. */
export function roadHW(kind: EdgeKind, lanes: number, oneWay: boolean, divided: boolean): number {
  if (kind === 'highway') return 12;
  if (kind === 'ramp') return 4.5;
  if (kind === 'bridge') return 10;
  if (lanes >= 2) return divided ? 11 : AVE_HW;
  if (oneWay) return 5;
  return kind === 'arterial' ? (divided ? 7.5 : 7) : ST_HW;
}

const LOT_SIZE: Record<MainDistrict, [number, number]> = {
  mill: [40, 30], main: [22, 24], square: [0, 0], stacks: [16, 22], college: [40, 40],
  yard: [40, 36], exits: [36, 36], lake: [30, 30], sister: [20, 26],
};

interface P { x: number; z: number }

function projSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { t: number; x: number; z: number; d2: number } {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  const x = ax + dx * t, z = az + dz * t;
  return { t, x, z, d2: (px - x) * (px - x) + (pz - z) * (pz - z) };
}

function segX(a: P, b: P, c: P, d: P): { t: number; u: number } | null {
  const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qz = c.z - a.z;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

const hyp = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);

/** X of the Thruway at z (south of its north bend), for the district map. */
const THRU = PLAN_ROADS.find((r) => r.kind === 'highway')!.pts;
export function thruwayX(z: number): number {
  for (let k = 0; k + 3 < THRU.length; k += 2) {
    const z0 = THRU[k + 1], z1 = THRU[k + 3];
    if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return THRU[k] + ((z - z0) / (z1 - z0)) * (THRU[k + 2] - THRU[k]);
  }
  return z > -1500 ? THRU[THRU.length - 2] : -700;
}

/** District of a point under the new plan, or null for water and beach. */
export function streetDistrict(x: number, z: number): MainDistrict | null {
  if (coastSD(x, z) > -20 || waterDist(x, z) < 0) return null;
  if (x > riverX(z)) return 'sister';
  if (z < -2700) return 'exits';
  if (x < thruwayX(z) - 15) return 'lake';
  if (z > -1500 && x < -430) return 'exits';
  if (Math.hypot(x - 20, z + 1768) < 50) return 'square';
  if (x > 100 && z > -1630) return 'mill';
  if (x > -90 && x < 260 && z <= -1600 && z > -2110) return 'main';
  if (z <= -2110) return x >= 120 ? 'yard' : x < -150 ? 'college' : 'main';
  return 'stacks';
}

export class StreetGraph {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  overpasses: Overpass[] = [];
  blocks: StreetBlock[] = [];
  lots: StreetLot[] = [];
  parking: ParkSpot[] = [];
  /** How many nodes and edges are the island's (they come first, same ids as CityPlan's). */
  readonly isle = { nodes: 0, edges: 0 };
  bridgeEdge = -1;
  /** The node where the bridge lands (Landing Rd's south end). */
  landingNode = -1;
  /** Plan road id -> its edge ids, in drawing order. */
  readonly roadEdges = new Map<string, number[]>();
  private mainEdges: RoadEdge[] = [];
  private isleEdges: RoadEdge[] = [];
  private bbox: Float32Array = new Float32Array(0);

  /**
   * isleNodes/isleEdges: CityPlan's island lists (only the first isleEdgeCount edges are used).
   * bridgeIsland: id of the island node at the bridge's foot.
   */
  constructor(isleNodes: readonly RoadNode[], isleEdges: readonly RoadEdge[], bridgeIsland: number, seed = 1988) {
    const ne = isleEdges.length;
    for (const n of isleNodes) this.nodes.push({ ...n, edges: n.edges.filter((id) => id < ne), control: n.hasLight ? 'signal' : n.edges.length >= 3 ? 'stop' : 'none' });
    for (const e of isleEdges) this.edges.push(e);
    this.isle.nodes = this.nodes.length; this.isle.edges = this.edges.length;
    this.isleEdges = this.edges.slice();
    this.buildMainland();
    this.addBridge(bridgeIsland);
    this.mainEdges = this.edges.filter((e) => e.land === 1 && !e.deck);
    this.bbox = new Float32Array(this.edges.length * 4);
    this.edges.forEach((e, i) => {
      const p = this.edgePts(e);
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); z0 = Math.min(z0, p[k + 1]); z1 = Math.max(z1, p[k + 1]); }
      this.bbox.set([x0 - e.hw, z0 - e.hw, x1 + e.hw, z1 + e.hw], i * 4);
    });
    this.buildBlocks();
    this.buildLots(new RNG(seed));
    this.buildParking(new RNG(seed + 3));
  }

  // ── Building ────────────────────────────────────────────────────────────────

  private buildMainland(): void {
    const SNAP = 8, REUSE = 3, MERGE = 1.5;
    const roads = PLAN_ROADS;
    const P: P[][] = roads.map((r) => { const o: P[] = []; for (let k = 0; k < r.pts.length; k += 2) o.push({ x: r.pts[k], z: r.pts[k + 1] }); return o; });

    // A. Snap each road end onto the road it meets (T junctions and ends joined to ends), sharing the vertex object.
    for (let r = 0; r < P.length; r++) {
      for (const end of [0, 1]) {
        const pl = P[r], ei = end ? pl.length - 1 : 0, e = pl[ei];
        let bq = -1, bi = -1, bd = SNAP * SNAP, bx = 0, bz = 0;
        for (let q = 0; q < P.length; q++) {
          if (q === r) continue;
          const Q = P[q];
          for (let i = 0; i + 1 < Q.length; i++) {
            const pr = projSeg(e.x, e.z, Q[i].x, Q[i].z, Q[i + 1].x, Q[i + 1].z);
            if (pr.d2 < bd) { bd = pr.d2; bq = q; bi = i; bx = pr.x; bz = pr.z; }
          }
        }
        if (bq < 0) continue;
        const Q = P[bq], at = { x: bx, z: bz };
        let vi = -1, vd = REUSE;
        for (const k of [bi, bi + 1]) { const d = hyp(Q[k], at); if (d < vd) { vd = d; vi = k; } }
        if (vi < 0) { Q.splice(bi + 1, 0, at); vi = bi + 1; }
        pl[ei] = Q[vi];
      }
    }

    // B. Crossings: at grade they become shared vertices; a highway, or a ramp away from a listed junction, passes over.
    const nearJ = (x: number, z: number, over: boolean, r: number): boolean =>
      PLAN_JUNCTIONS.some((j) => (j.control === 'overpass') === over && Math.hypot(j.x - x, j.z - z) < r);
    const ins: { road: number; seg: number; t: number; v: P }[] = [];
    const overs: { x: number; z: number; upperRoad: number; lowerRoad: number }[] = [];
    const nearVert = (pl: P[], x: number, z: number, r: number): P | null => {
      for (const v of pl) if (Math.hypot(v.x - x, v.z - z) < r) return v;
      return null;
    };
    for (let r = 0; r < P.length; r++) {
      for (let q = r + 1; q < P.length; q++) {
        const R = P[r], Q = P[q];
        for (let i = 0; i + 1 < R.length; i++) {
          for (let j = 0; j + 1 < Q.length; j++) {
            const hit = segX(R[i], R[i + 1], Q[j], Q[j + 1]);
            if (!hit) continue;
            const x = R[i].x + (R[i + 1].x - R[i].x) * hit.t, z = R[i].z + (R[i + 1].z - R[i].z) * hit.t;
            const vr = nearVert(R, x, z, 1), vq = nearVert(Q, x, z, 1);
            if (vr && vr === vq) continue;  // already joined
            const rk = roads[r].kind, qk = roads[q].kind;
            let over = rk === 'highway' || qk === 'highway' || ((rk === 'ramp' || qk === 'ramp') && !nearJ(x, z, false, 10));
            if (nearJ(x, z, true, 15)) over = true;
            if (over) {
              if (!overs.some((o) => Math.hypot(o.x - x, o.z - z) < 2)) {
                const rUp = rk === 'highway' || (rk === 'ramp' && qk !== 'highway');
                overs.push({ x, z, upperRoad: rUp ? r : q, lowerRoad: rUp ? q : r });
              }
              continue;
            }
            const v = vr ?? vq ?? { x, z };
            if (v !== vr && !ins.some((s) => s.road === r && hyp(s.v, v) < 0.5)) ins.push({ road: r, seg: i, t: hit.t, v });
            if (v !== vq && !ins.some((s) => s.road === q && hyp(s.v, v) < 0.5)) ins.push({ road: q, seg: j, t: hit.u, v });
          }
        }
      }
    }
    ins.sort((a, b) => a.road - b.road || b.seg - a.seg || b.t - a.t);
    for (const s of ins) P[s.road].splice(s.seg + 1, 0, s.v);

    // C. Nodes: road ends and vertices shared by two roads, merged within MERGE m; roundabouts take everything near their ring.
    const uses = new Map<P, number>();
    for (const pl of P) for (const v of new Set(pl)) uses.set(v, (uses.get(v) ?? 0) + 1);
    const nodeOf = new Map<P, number>();
    const n0 = this.nodes.length;
    const newNode = (x: number, z: number): number => {
      const id = this.nodes.length;
      this.nodes.push({ id, i: -1, j: -1, x, z, edges: [], hx: 0, hz: 0, hasLight: false, phase: (id % 9) * 2.5, land: 1, control: 'none' });
      return id;
    };
    const rounds = PLAN_ROUNDABOUTS.map((rb) => { const id = newNode(rb.x, rb.z); this.nodes[id].control = 'roundabout'; this.nodes[id].ring = rb.r; return { ...rb, id }; });
    const cnt = new Map<number, number>();
    for (const pl of P) {
      pl.forEach((v, k) => {
        if (nodeOf.has(v) || !(k === 0 || k === pl.length - 1 || (uses.get(v) ?? 0) > 1)) return;
        const rb = rounds.find((o) => Math.hypot(o.x - v.x, o.z - v.z) < o.r + 12);
        if (rb) { nodeOf.set(v, rb.id); return; }
        for (let id = n0 + rounds.length; id < this.nodes.length; id++) {
          const n = this.nodes[id], c = cnt.get(id) ?? 1;
          if (Math.hypot(n.x - v.x, n.z - v.z) < MERGE) {
            n.x = (n.x * c + v.x) / (c + 1); n.z = (n.z * c + v.z) / (c + 1); cnt.set(id, c + 1);
            nodeOf.set(v, id); return;
          }
        }
        nodeOf.set(v, newNode(v.x, v.z));
      });
    }

    // D. Edges: each road cut at its node vertices.
    roads.forEach((road, r) => {
      const pl = P[r], ids: number[] = [];
      let start = 0;
      for (let k = 1; k < pl.length; k++) {
        if (!nodeOf.has(pl[k])) continue;
        const a = nodeOf.get(pl[start])!, b = nodeOf.get(pl[k])!;
        const pts: number[] = [];
        for (let m = start; m <= k; m++) pts.push(pl[m].x, pl[m].z);
        start = k;
        this.fitEnds(pts, a, b);
        const len = polyLen(pts);
        if (a === b) {
          // A loop: drop the bit inside a roundabout, split anything longer at its middle so a !== b.
          if (len < 2 * (this.nodes[a].ring ?? 0) + 8) continue;
          const half = splitAt(pts, len / 2), mid = newNode(half[0][half[0].length - 2], half[0][half[0].length - 1]);
          ids.push(this.addEdge(road, a, mid, half[0]), this.addEdge(road, mid, b, half[1]));
          continue;
        }
        ids.push(this.addEdge(road, a, b, pts));
      }
      this.roadEdges.set(road.id, ids);
    });

    for (const o of overs) {
      const pick = (road: number): number => {
        let best = -1, bd = Infinity;
        for (const id of this.roadEdges.get(roads[road].id) ?? []) { const d = this.project(this.edges[id], o.x, o.z).d; if (d < bd) { bd = d; best = id; } }
        return best;
      };
      this.overpasses.push({ x: o.x, z: o.z, upper: pick(o.upperRoad), lower: pick(o.lowerRoad) });
    }

    // E. Junction control and pad size.
    for (let id = n0; id < this.nodes.length; id++) {
      const n = this.nodes[id], deg = n.edges.length;
      let hw = 0;
      for (const eid of n.edges) hw = Math.max(hw, this.edges[eid].hw);
      if (n.control === 'roundabout') { n.hx = n.hz = (n.ring ?? 13) + hw; continue; }
      n.hx = n.hz = hw;
      const names = new Set(n.edges.map((eid) => this.edges[eid].name));
      const j = PLAN_JUNCTIONS.find((q) => q.control !== 'overpass' && Math.hypot(q.x - n.x, q.z - n.z) < (deg >= 3 ? 15 : 6));
      if (deg <= 1) n.control = 'end';
      else if (j && (deg >= 3 || names.size > 1)) n.control = j.control === 'signal' ? 'signal' : 'stop';
      else n.control = deg >= 3 ? 'stop' : 'none';
      n.hasLight = n.control === 'signal';
    }
    // F. Real signals (the audit: Main/Tarnish/Bobbin and the like sat stop-controlled): an OSM-signalled junction that joins an
    //    arterial and has no ramp or highway becomes a signal, unless another signal is already within 30 m.
    const sig = this.nodes.filter((n, id) => id >= n0 && n.control === 'signal');
    for (let id = n0; id < this.nodes.length; id++) {
      const n = this.nodes[id];
      if (n.control !== 'stop' || n.edges.length < 3) continue;
      const es = n.edges.map((eid) => this.edges[eid]);
      if (es.some((e) => e.kind === 'ramp' || e.kind === 'highway') || !es.some((e) => e.kind === 'arterial')) continue;
      let near = false;
      for (let k = 0; k < PLAN_SIGNALS.length; k += 2) if (Math.hypot(PLAN_SIGNALS[k] - n.x, PLAN_SIGNALS[k + 1] - n.z) < 22) { near = true; break; }
      if (es.filter((e) => e.kind === 'arterial').length >= 3) near = true;
      if (!near || sig.some((o) => Math.hypot(o.x - n.x, o.z - n.z) < 30)) continue;
      n.control = 'signal'; n.hasLight = true; sig.push(n);
    }
  }

  /** Make a polyline start and end exactly at its nodes (into the centre for a roundabout). */
  private fitEnds(pts: number[], a: number, b: number): void {
    const A = this.nodes[a], B = this.nodes[b];
    if (A.control === 'roundabout') pts.unshift(A.x, A.z); else { pts[0] = A.x; pts[1] = A.z; }
    if (B.control === 'roundabout') pts.push(B.x, B.z); else { pts[pts.length - 2] = B.x; pts[pts.length - 1] = B.z; }
  }

  private addEdge(road: (typeof PLAN_ROADS)[number], a: number, b: number, pts: number[]): number {
    const id = this.edges.length, cum = cumLen(pts);
    const hw = roadHW(road.kind, road.lanes, road.oneWay, road.divided);
    this.edges.push({
      id, a, b, horiz: false, hw, lanes: road.lanes, len: cum[cum.length - 1], name: road.name, land: 1, stage: road.stage,
      closed: true, pts, cum, oneWay: road.oneWay, divided: road.divided, kind: road.kind, road: road.id,
    });
    this.nodes[a].edges.push(id); this.nodes[b].edges.push(id);
    return id;
  }

  private addBridge(islandNode: number): void {
    let land = -1, bd = Infinity;
    for (let id = this.isle.nodes; id < this.nodes.length; id++) {
      const n = this.nodes[id], d = Math.hypot(n.x + 30, n.z + 1072);
      if (d < bd) { bd = d; land = id; }
    }
    this.landingNode = land;
    const A = this.nodes[land], B = this.nodes[islandNode], pts = [A.x, A.z, B.x, B.z];
    this.bridgeEdge = this.edges.length;
    this.edges.push({
      id: this.bridgeEdge, a: land, b: islandNode, horiz: false, hw: 10, lanes: 2, len: B.z - A.z, name: 'The Perpetual Bridge',
      land: 1, stage: 0, closed: true, deck: true, pts, cum: cumLen(pts), kind: 'bridge', road: 'bridge',
    });
    A.edges.push(this.bridgeEdge); B.edges.push(this.bridgeEdge);
    if (A.control === 'end') A.control = 'none';
  }

  /** Blocks: faces of the planar map of mainland centrelines (overpasses split here only). */
  private buildBlocks(): void {
    const key = (x: number, z: number): string => `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const vx: number[] = [], vz: number[] = [], vid = new Map<string, number>();
    const V = (x: number, z: number): number => {
      const k = key(x, z);
      let id = vid.get(k);
      if (id === undefined) { id = vx.length; vid.set(k, id); vx.push(x); vz.push(z); }
      return id;
    };
    const adj: number[][] = [];
    const sideEdge = new Map<string, number>();
    const link = (u: number, v: number, e: number): void => {
      if (u === v) return;
      while (adj.length <= Math.max(u, v)) adj.push([]);
      if (adj[u].includes(v)) return;
      adj[u].push(v); adj[v].push(u);
      sideEdge.set(`${u}>${v}`, e); sideEdge.set(`${v}>${u}`, e);
    };
    for (const e of this.mainEdges) {
      const p = e.pts!.slice();
      // Overpass points split both roads here, so the faces close.
      for (const o of this.overpasses) {
        for (let k = 0; k + 3 < p.length; k += 2) {
          const pr = projSeg(o.x, o.z, p[k], p[k + 1], p[k + 2], p[k + 3]);
          if (pr.d2 < 0.25 && pr.t > 1e-4 && pr.t < 1 - 1e-4) { p.splice(k + 2, 0, o.x, o.z); break; }
        }
      }
      for (let k = 0; k + 3 < p.length; k += 2) link(V(p[k], p[k + 1]), V(p[k + 2], p[k + 3]), e.id);
    }
    // Neighbours sorted by angle; the next half-edge after u->v is v->w with w the neighbour just clockwise of u.
    const sorted = adj.map((ns, v) => ns.slice().sort((a, b) => Math.atan2(vz[a] - vz[v], vx[a] - vx[v]) - Math.atan2(vz[b] - vz[v], vx[b] - vx[v])));
    const used = new Set<string>();
    const faces: { ring: number[]; area: number }[] = [];
    for (let u = 0; u < sorted.length; u++) {
      for (const v0 of sorted[u]) {
        if (used.has(`${u}>${v0}`)) continue;
        const ring: number[] = [];
        let a = u, b = v0, guard = 0;
        while (!used.has(`${a}>${b}`) && guard++ < 20000) {
          used.add(`${a}>${b}`); ring.push(a);
          const ns = sorted[b], k = ns.indexOf(a);
          const w = ns[(k - 1 + ns.length) % ns.length];
          a = b; b = w;
        }
        let area = 0;
        for (let k = 0; k < ring.length; k++) { const p = ring[k], q = ring[(k + 1) % ring.length]; area += vx[p] * vz[q] - vx[q] * vz[p]; }
        faces.push({ ring, area: area / 2 });
      }
    }
    // Bounded faces share one orientation; the biggest face of all is an outer one and has the other.
    let big = faces[0];
    for (const f of faces) if (Math.abs(f.area) > Math.abs(big.area)) big = f;
    const S = big ? -Math.sign(big.area) : 1;
    for (const f of faces) {
      if (Math.sign(f.area) !== S || Math.abs(f.area) < 300) continue;
      const ring = S > 0 ? f.ring : f.ring.slice().reverse();
      const poly: number[] = [], sides: number[] = [];
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, cx = 0, cz = 0, A2 = 0;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k], q = ring[(k + 1) % ring.length];
        poly.push(vx[p], vz[p]);
        sides.push(sideEdge.get(`${p}>${q}`) ?? -1);
        x0 = Math.min(x0, vx[p]); x1 = Math.max(x1, vx[p]); z0 = Math.min(z0, vz[p]); z1 = Math.max(z1, vz[p]);
        const c = vx[p] * vz[q] - vx[q] * vz[p];
        A2 += c; cx += (vx[p] + vx[q]) * c; cz += (vz[p] + vz[q]) * c;
      }
      cx /= 3 * A2; cz /= 3 * A2;
      if (!pointInPoly(poly, cx, cz)) { cx = (x0 + x1) / 2; cz = (z0 + z1) / 2; }
      let stage = 9;
      for (const s of sides) if (s >= 0) stage = Math.min(stage, this.edges[s].stage);
      const district = streetDistrict(cx, cz);
      this.blocks.push({ id: this.blocks.length, poly, sides, area: Math.abs(f.area), cx, cz, x0, z0, x1, z1, district, stage, open: district === null });
    }
  }

  /** True when (x, z) is at least `margin` m clear of every mainland road's paved edge. */
  clearOfRoads(x: number, z: number, margin: number): boolean {
    for (const e of this.mainEdges) {
      const b = e.id * 4;
      if (x < this.bbox[b] - margin || x > this.bbox[b + 2] + margin || z < this.bbox[b + 1] - margin || z > this.bbox[b + 3] + margin) continue;
      const p = e.pts!, lim = (e.hw + margin) * (e.hw + margin);
      for (let k = 0; k + 3 < p.length; k += 2) if (projSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]).d2 < lim) return false;
    }
    return true;
  }

  private buildLots(rng: RNG): void {
    const pd = { x0: PD.LOT.x0 - 6, x1: PD.LOT.x1 + 6, z0: PD.LOT.z0 - 6, z1: -1090 };
    for (const blk of this.blocks) {
      if (blk.open || !blk.district || blk.district === 'square') continue;
      const [W, D] = LOT_SIZE[blk.district];
      const mine: StreetLot[] = [];
      const n = blk.poly.length / 2;
      for (let k = 0; k < n; k++) {
        const eid = blk.sides[k];
        if (eid < 0) continue;
        const e = this.edges[eid];
        if (e.kind === 'highway' || e.kind === 'ramp') continue;
        const ax = blk.poly[2 * k], az = blk.poly[2 * k + 1], bx = blk.poly[(2 * k + 2) % (2 * n)], bz = blk.poly[(2 * k + 3) % (2 * n)];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < W) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        // Counter-clockwise ring: the inside is to the left of travel, (-uz, ux).
        const nx = -uz, nz = ux;
        const w = W * rng.range(0.85, 1.15), d = D * rng.range(0.9, 1.1);
        const off = e.hw + SIDEWALK + d / 2 + 0.6;
        for (let s = w / 2 + 2; s + w / 2 + 2 <= L; s += w + 0.8) {
          const cx = ax + ux * s + nx * off, cz = az + uz * s + nz * off;
          // The district of the lot's own spot: the big faces between arterials span several.
          const ld = streetDistrict(cx, cz);
          if (!ld || ld === 'square') continue;
          const lot: StreetLot = { cx, cz, w, d, h: Math.atan2(-nx, -nz), block: blk.id, edge: eid, district: ld, stage: blk.stage };
          const cs = lotCorners(lot);
          let ok = pointInPoly(blk.poly, cx, cz) && waterDist(cx, cz) > 8 + d / 2 && coastSD(cx, cz) < -40;
          if (ok && cx > pd.x0 && cx < pd.x1 && cz > pd.z0 && cz < pd.z1) ok = false;
          for (let c = 0; ok && c < 8; c += 2) ok = pointInPoly(blk.poly, cs[c], cs[c + 1]) && this.clearOfRoads(cs[c], cs[c + 1], SIDEWALK);
          if (ok) ok = this.clearOfRoads(cx, cz, SIDEWALK);
          for (const o of mine) if (ok && obbOverlap(lot, o)) ok = false;
          if (ok) { mine.push(lot); this.lots.push(lot); }
        }
      }
    }
  }

  private buildParking(rng: RNG): void {
    for (const e of this.mainEdges) {
      if (e.kind !== 'local' && e.kind !== 'arterial') continue;
      if (e.divided && e.lanes >= 2) continue;
      const A = this.nodes[e.a], B = this.nodes[e.b], off = e.hw - 1.35;
      for (let s = A.hx + 14; s < e.len - B.hx - 14; s += 6.6) {
        for (const side of [-1, 1]) {
          if (!rng.chance(0.2)) continue;
          if (e.oneWay && side < 0) continue;
          const p = this.pointAt(e, s);
          // Right of a -> b travel is (-dz, dx).
          const x = p.x - p.dz * off * side, z = p.z + p.dx * off * side;
          if (Math.abs(waterDist(x, z)) < 40) continue;
          // Never in another street's lane or a junction's pad (curved roads run close together).
          if (!this.clearOfOthers(x, z, 1.3, e.id)) continue;
          this.parking.push({ x, z, h: side > 0 ? Math.atan2(p.dx, p.dz) : Math.atan2(-p.dx, -p.dz) });
        }
      }
    }
    this.buildLotParking();
  }

  /** True when (x, z) is clear by `margin` of every mainland road but `own`, and of every junction pad. */
  clearOfOthers(x: number, z: number, margin: number, own: number): boolean {
    for (const n of this.nodes) {
      if (n.id < this.isle.nodes || (n.edges.length < 3 && !n.ring)) continue;
      if (Math.abs(n.x - x) > 40 || Math.abs(n.z - z) > 40) continue;
      const r = Math.max(n.hx, n.hz, n.ring ?? 0) + margin + 1.5;
      if ((n.x - x) ** 2 + (n.z - z) ** 2 < r * r) return false;
    }
    for (const e of this.mainEdges) {
      if (e.id === own) continue;
      const b = e.id * 4;
      if (x < this.bbox[b] - margin || x > this.bbox[b + 2] + margin || z < this.bbox[b + 1] - margin || z > this.bbox[b + 3] + margin) continue;
      const p = e.pts!, lim = (e.hw + margin) * (e.hw + margin);
      for (let k = 0; k + 3 < p.length; k += 2) if (projSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]).d2 < lim) return false;
    }
    return true;
  }

  /**
   * The Holding Pattern's stalls (mainlandBuildings.ts holdingPatternWest paints them): on each tarmac strip between the lanes
   * and Dutch Elm St, a stall in every 2.75 m row at the strip's west end and, on wide strips, its east end, nose out to the
   * edge. A car needs its whole footprint clear of every road. Appended last, so no earlier spot or roll moves.
   */
  private buildLotParking(): void {
    const R = { x0: 15, z0: -1935, x1: 48, z1: -1772 };
    const ok = (x: number, z: number): boolean => this.clearOfRoads(x, z, 1.2);
    for (let z = Math.ceil(R.z0 / 2.75) * 2.75 + 1.4; z < R.z1 - 2; z += 2.75) {
      let run = -1;
      for (let x = R.x0; x <= R.x1 + 0.01; x += 0.5) {
        const inside = x < R.x1 && ok(x, z - 1.1) && ok(x, z + 1.1);
        if (inside && run < 0) run = x;
        if ((!inside || x >= R.x1) && run >= 0) {
          const xa = run, xb = x;
          run = -1;
          if (xb - xa < 5.6) continue;
          // A stall on every other row, so the lot is half empty like a real one.
          if (Math.round(z / 2.75) % 2) continue;
          this.parking.push({ x: xa + 2.8, z, h: -Math.PI / 2 });
          if (xb - xa >= 11.4 && Math.round(z / 2.75) % 4 === 0) this.parking.push({ x: xb - 2.8, z, h: Math.PI / 2 });
        }
      }
    }
  }

  // ── Queries (the same shape as CityPlan's, so callers can take either) ─────

  /** Polyline of any edge, flat x,z from a to b. Grid edges get their two node points. */
  edgePts(e: RoadEdge): number[] {
    if (e.pts) return e.pts;
    const A = this.nodes[e.a], B = this.nodes[e.b];
    return [A.x, A.z, B.x, B.z];
  }

  /** Point and unit direction (toward b) at distance s from node a. */
  pointAt(e: RoadEdge, s: number): { x: number; z: number; dx: number; dz: number } {
    const p = this.edgePts(e), cum = e.cum ?? [0, e.len];
    s = clamp(s, 0, e.len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const L = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / L;
    const ax = p[2 * lo], az = p[2 * lo + 1], bx = p[2 * hi], bz = p[2 * hi + 1];
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / dl, dz: (bz - az) / dl };
  }

  /** Distance along the edge of the closest centreline point, and how far away it is. */
  project(e: RoadEdge, x: number, z: number): { s: number; d: number } {
    const p = this.edgePts(e), cum = e.cum ?? [0, e.len];
    let bs = 0, bd = Infinity;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const pr = projSeg(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]);
      if (pr.d2 < bd) { bd = pr.d2; bs = cum[k / 2] + pr.t * (cum[k / 2 + 1] - cum[k / 2]); }
    }
    return { s: bs, d: Math.sqrt(bd) };
  }

  other(e: RoadEdge, nodeId: number): number { return e.a === nodeId ? e.b : e.a; }
  /** Whether traffic may drive along e leaving node `from`. */
  canLeave(e: RoadEdge, from: number): boolean { return !e.oneWay || e.a === from; }
  landEdges(z: number): readonly RoadEdge[] { return z < MAIN_SPLIT_Z ? this.mainEdges : this.isleEdges; }

  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0], bd = Infinity;
    for (const n of this.nodes) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }

  /** Closest point on any centreline (both lands): the edge, distance along it from a, and distance away. */
  nearestEdge(x: number, z: number, filter?: (e: RoadEdge) => boolean): { edge: RoadEdge; s: number; d: number } {
    let best = this.edges[0], bs = 0, bd = Infinity;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i], b = i * 4;
      // Reject by box first: the distance to the box is a lower bound.
      const ox = Math.max(this.bbox[b] - x, 0, x - this.bbox[b + 2]), oz = Math.max(this.bbox[b + 1] - z, 0, z - this.bbox[b + 3]);
      if (ox * ox + oz * oz > bd * bd || (filter && !filter(e))) continue;
      const r = this.project(e, x, z);
      if (r.d < bd) { bd = r.d; best = e; bs = r.s; }
    }
    return { edge: best, s: bs, d: bd };
  }

  /**
   * Shortest drive between two nodes (A*), honouring one-way streets. Node ids, both ends included; [from]
   * when there is no way. stage: route over every edge open at that stage (bridge included) instead of `closed`.
   */
  findPath(from: number, to: number, stage?: number): number[] {
    if (from === to) return [from];
    const N = this.nodes.length, T = this.nodes[to];
    const g = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const h = (id: number): number => Math.hypot(this.nodes[id].x - T.x, this.nodes[id].z - T.z) / 1.84;
    const open: number[] = [from];
    g[from] = 0;
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (g[open[k]] + h(open[k]) < g[open[bi]] + h(open[bi])) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur === to) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      for (const eid of this.nodes[cur].edges) {
        const e = this.edges[eid], nb = this.other(e, cur);
        if (closed[nb] || !this.canLeave(e, cur)) continue;
        if (stage === undefined ? e.closed : e.stage > stage) continue;
        const ng = g[cur] + e.len / (e.lanes >= 2 ? 1.15 : 1) / (e.kind === 'highway' ? 1.6 : 1);
        if (ng < g[nb]) { g[nb] = ng; came[nb] = cur; open.push(nb); }
      }
    }
    const path: number[] = [];
    for (let c = to; c !== -1; c = came[c]) { path.push(c); if (c === from) break; }
    return path[path.length - 1] === from ? path.reverse() : [from];
  }

  /** Open every mainland edge of stage <= s (and the bridge when it is finished). For progress.ts to adopt. */
  openTo(s: number, bridgeDone: boolean): void {
    for (let k = this.isle.edges; k < this.edges.length; k++) {
      const e = this.edges[k];
      e.closed = e.deck ? !bridgeDone : e.stage > s;
    }
  }

  streetAt(x: number, z: number): string { return this.nearestEdge(x, z, (e) => !e.deck).edge.name; }
  districtAt(x: number, z: number): MainDistrict | null { return streetDistrict(x, z); }

  /** The block whose polygon holds the point, or null. */
  blockAtPoint(x: number, z: number): StreetBlock | null {
    for (const b of this.blocks) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInPoly(b.poly, x, z)) return b;
    return null;
  }
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

export function cumLen(pts: number[]): number[] {
  const c = [0];
  for (let k = 2; k < pts.length; k += 2) c.push(c[c.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]));
  return c;
}
const polyLen = (pts: number[]): number => { const c = cumLen(pts); return c[c.length - 1]; };

/** Cut a polyline at arc length s into two (the cut point ends one and starts the other). */
function splitAt(pts: number[], s: number): [number[], number[]] {
  const c = cumLen(pts);
  let k = 1;
  while (k < c.length - 1 && c[k] < s) k++;
  const t = (s - c[k - 1]) / (c[k] - c[k - 1] || 1);
  const x = pts[2 * k - 2] + (pts[2 * k] - pts[2 * k - 2]) * t, z = pts[2 * k - 1] + (pts[2 * k + 1] - pts[2 * k - 1]) * t;
  return [[...pts.slice(0, 2 * k), x, z], [x, z, ...pts.slice(2 * k)]];
}

export function pointInPoly(poly: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], zi = poly[i + 1], xj = poly[j], zj = poly[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Corners of a lot, flat x,z. */
export function lotCorners(l: StreetLot): number[] {
  // Front faces heading h: forward (sin h, cos h); the frontage runs across it.
  const fx = Math.sin(l.h), fz = Math.cos(l.h), rx = fz, rz = -fx, hw = l.w / 2, hd = l.d / 2;
  return [
    l.cx + fx * hd + rx * hw, l.cz + fz * hd + rz * hw, l.cx + fx * hd - rx * hw, l.cz + fz * hd - rz * hw,
    l.cx - fx * hd - rx * hw, l.cz - fz * hd - rz * hw, l.cx - fx * hd + rx * hw, l.cz - fz * hd + rz * hw,
  ];
}

function obbOverlap(a: StreetLot, b: StreetLot): boolean {
  const ca = lotCorners(a), cb = lotCorners(b);
  for (const l of [a, b]) {
    for (const [ax, az] of [[Math.sin(l.h), Math.cos(l.h)], [Math.cos(l.h), -Math.sin(l.h)]]) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let k = 0; k < 8; k += 2) {
        const pa = ca[k] * ax + ca[k + 1] * az, pb = cb[k] * ax + cb[k + 1] * az;
        a0 = Math.min(a0, pa); a1 = Math.max(a1, pa); b0 = Math.min(b0, pb); b1 = Math.max(b1, pb);
      }
      if (a1 <= b0 + 0.3 || b1 <= a0 + 0.3) return false;
    }
  }
  return true;
}

