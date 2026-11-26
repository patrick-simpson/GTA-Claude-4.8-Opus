// Traffic on the new mainland streets (tepid-streets.md step 2 unit 3): Tepid Falls after real Waterville.
//
// The island keeps its grid drivers (traffic.ts, untouched). On the mainland a driver follows a rail: a lane of a
// polyline edge of plan.streets, travelling a -> b (dir 1) or b -> a (dir -1). At a junction it leaves the lane on a
// path sampled once (a cubic through the pad, or in round a roundabout's circulating lane) and joins a lane of the
// street it chose. How each junction is run:
//   signal      two phases (the approaches nearest the node's first edge's axis, and the rest) on the shared signal
//               clock (signals.ts + game.signalTime, which a town keeps in step), lefts yield to oncoming traffic;
//   stop        a minor road meeting a through road: stop at the line, then go when the pad is empty and nothing on
//               the through road is close; the through road does not stop. Where nothing is a through road (two
//               equal streets), every approach stops and they go in the order they stopped;
//   roundabout  yield to circulating traffic, go round counter-clockwise (right-hand traffic), exit;
//   highway     a ramp meeting the Thruway merges (gives way to the lane it joins); the Thruway never stops;
//               exits are taken from the kerb lane.
// Lane centres follow the paint (streetMeshes.ts). Right of travel along (tx, tz) is (-tz, tx).

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { RNG, TAU, clamp } from '../core/util';
import type { District, RoadEdge, RoadNode } from '../world/plan';
import type { StreetGraph } from '../world/streets';
import { signalState } from '../world/signals';
import { setGroundHint, streetSurface } from '../world/plan';
import { SPECS, type VehicleKind } from '../ent/vehicleSpecs';
import type { Anchor, Driver, RoadPed } from './traffic';
import { StreetSignals } from '../world/streetSignals';
import { season } from '../world/season';
import { VISITOR_PAINT } from '../world/seasonData';
import { roads } from '../world/roadCond';

/** What the rail drivers need from Traffic. */
export interface RailHost {
  readonly game: Game;
  readonly byVeh: Map<Vehicle, Driver>;
  readonly others: readonly Vehicle[];
  /** The town's buses (sim/bus.ts): clock-driven bodies traffic must give way to. */
  readonly transit: readonly Vehicle[];
  readonly drivers: readonly Driver[];
  roadPeds(): readonly RoadPed[];
  unseen(x: number, z: number, near: number, front: number): boolean;
  newWid(): number;
  kindFor(district: District | null, avenue: boolean): VehicleKind;
  fresh(d: Driver): void;
  /** The driver gets out and walks off (after a knock). */
  leaveCar(d: Driver, v: Vehicle): void;
  /** Off the bridge's island end: back to the island's grid driving. */
  toIsland(d: Driver, v: Vehicle): void;
}

/** A driver's place on the mainland streets. */
export interface Rail {
  e: RoadEdge; dir: number;
  /** Lane now (0 next to the centre or the left edge), the one wanted for the next junction, and the habit. */
  lane: number; want: number; home: number;
  /** Meters right of the centreline steered for (eases toward the lane). */
  off: number;
  /** The street after the junction ahead, which way along it, and the turn (radians, right positive). */
  next: RoadEdge; ndir: number; ang: number;
  /** The path through the junction while in it: flat x,z, arc lengths, the segment and the lane it ends in. */
  path: number[] | null; cum: number[]; k: number; pv: number; plane: number; poff: number;
  /** Stop line: 0 rolling, 1 stopped and waiting a turn, 2 may go. */
  stop: number; stopT: number; arrive: number;
  cruise: number; yellow: number; lcCool: number; slowT: number;
  /** Nose to the stop line last frame, to notice the moment it is crossed. */
  prev: number;
}

// Mirrors of streetGround.ts's StreetSurface.padR / islandR (no instance of it is reachable from here).
const padR = (n: RoadNode): number => (n.edges.length === 2 && n.control === 'none' ? n.hx : n.hx + (n.control === 'roundabout' ? 0 : 0.6));
const islandR = (n: RoadNode): number => Math.max(6, n.hx - 9);
const RANK: Record<string, number> = { highway: 4, ramp: 3, arterial: 2, bridge: 2, local: 1 };
const rankOf = (e: RoadEdge): number => RANK[e.kind ?? 'local'] ?? 1;

/** Lane centre, meters right of the centreline for the direction of travel (one-way: right of the line a -> b). */
export function railOff(e: RoadEdge, l: number): number {
  const n = Math.max(1, e.lanes);
  if (e.divided) {
    const hwy = e.kind === 'highway', inner = (hwy ? 0.45 : 1.0) + 0.35, lw = hwy ? 3.6 : 3.4;
    return inner + lw * (l + 0.5);
  }
  if (e.oneWay) { const lw = (2 * e.hw - 0.9) / n; return -(e.hw - 0.45) + lw * (l + 0.5); }
  if (n >= 2) return 1.8 + 3.4 * l;
  return e.hw >= 7 ? 2.0 : 1.75;
}

interface Pt { x: number; z: number; tx: number; tz: number }

export class StreetDrivers {
  readonly stats = { paths: 0, redRuns: 0, stopRuns: 0, rounds: 0, merges: 0, exits: 0, uturns: 0, seated: 0, adopted: 0, toIsland: 0, fromIsland: 0, note: '' };
  readonly signals: StreetSignals;
  private readonly rng = new RNG(52917);
  private readonly main: RoadEdge[];
  /** Approaches waiting at every-way stops, per node, in the order they stopped. */
  private readonly queue = new Map<number, Driver[]>();
  private readonly p0: Pt = { x: 0, z: 0, tx: 0, tz: 1 };
  private readonly p1: Pt = { x: 0, z: 0, tx: 0, tz: 1 };
  /** Signal phase of each approach: [edge id * 2 + (arriving at b ? 1 : 0)] = 1 when it goes with the second phase. */
  private readonly phaseB: Uint8Array;
  /** Approaches that need not stop at a 'stop' node (the through road), same indexing; and nodes where all stop. */
  private readonly through: Uint8Array;
  private readonly allWay = new Set<number>();
  /** Running total of each mainland edge's weight for placing cars: its length, more for the busy roads. */
  private readonly pickW: Float64Array;

  constructor(private readonly host: RailHost, readonly G: StreetGraph) {
    this.main = G.edges.slice(G.isle.edges);
    const KW: Record<string, number> = { highway: 1.3, arterial: 1, bridge: 0.6, local: 0.45, ramp: 0.35 };
    this.pickW = new Float64Array(this.main.length);
    let acc = 0;
    this.main.forEach((e, i) => { acc += e.deck ? 0 : e.len * (KW[e.kind ?? 'local'] ?? 0.5); this.pickW[i] = acc; });
    this.phaseB = new Uint8Array(G.edges.length * 2);
    this.through = new Uint8Array(G.edges.length * 2);
    for (let id = G.isle.nodes; id < G.nodes.length; id++) this.classify(G.nodes[id]);
    this.signals = new StreetSignals(host.game, G, (n, e) => this.phaseB[this.ai(e, n.id)] === 1);
  }

  private ai(e: RoadEdge, node: number): number { return e.id * 2 + (e.b === node ? 1 : 0); }

  /** Outward unit direction of e at node n. */
  private outDir(e: RoadEdge, n: number, o: Pt): Pt {
    const atA = e.a === n;
    const p = this.G.pointAt(e, atA ? Math.min(3, e.len * 0.5) : Math.max(0, e.len - 3));
    o.tx = atA ? p.dx : -p.dx; o.tz = atA ? p.dz : -p.dz;
    return o;
  }

  private classify(n: RoadNode): void {
    const G = this.G;
    if (n.edges.length < 2) return;
    // Signal phases: along the first (highest ranked) edge's axis, or across it.
    let ref = G.edges[n.edges[0]];
    for (const id of n.edges) if (rankOf(G.edges[id]) > rankOf(ref)) ref = G.edges[id];
    const r = this.outDir(ref, n.id, this.p0), rx = r.tx, rz = r.tz;
    for (const id of n.edges) {
      const o = this.outDir(G.edges[id], n.id, this.p1);
      this.phaseB[this.ai(G.edges[id], n.id)] = Math.abs(o.tx * rx + o.tz * rz) < 0.7071 ? 1 : 0;
    }
    // Through roads: a road with two edges here. The best ranked of them has the right of way.
    const count = new Map<string, number>();
    for (const id of n.edges) { const k = G.edges[id].road ?? G.edges[id].name; count.set(k, (count.get(k) ?? 0) + 1); }
    let top = 0;
    for (const id of n.edges) { const e = G.edges[id]; if ((count.get(e.road ?? e.name) ?? 0) >= 2) top = Math.max(top, rankOf(e)); }
    let minor = false;
    for (const id of n.edges) { const e = G.edges[id]; if (!((count.get(e.road ?? e.name) ?? 0) >= 2 && rankOf(e) === top)) minor = true; }
    // The Thruway always goes on; a junction of two equal streets has nobody with the right of way.
    for (const id of n.edges) {
      const e = G.edges[id];
      const thr = e.kind === 'highway' || (top > 0 && minor && (count.get(e.road ?? e.name) ?? 0) >= 2 && rankOf(e) === top);
      this.through[this.ai(e, n.id)] = thr ? 1 : 0;
    }
    if (n.control === 'stop' && (top === 0 || !minor)) {
      // Two roads of one name crossing a third of the same rank, or a plain four-way: everybody stops.
      if (!n.edges.some((id) => G.edges[id].kind === 'highway')) this.allWay.add(n.id);
    }
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  private endNode(e: RoadEdge, dir: number): RoadNode { return this.G.nodes[dir > 0 ? e.b : e.a]; }

  /** Point on the lane `off` m right of travel, s m from the start of travel. */
  private lanePt(e: RoadEdge, dir: number, s: number, off: number, o: Pt): Pt {
    const p = this.G.pointAt(e, dir > 0 ? s : e.len - s), tx = p.dx * dir, tz = p.dz * dir;
    o.x = p.x - tz * off; o.z = p.z + tx * off; o.tx = tx; o.tz = tz;
    return o;
  }

  /** Where a car leaves its lane for the junction (distance of its centre from the node). 0 at a plain bend. */
  private entry(n: RoadNode): number {
    if (n.edges.length === 2 && n.control === 'none') return 0;
    if (n.edges.length <= 1) return 3;
    return padR(n) + 1.2;
  }

  private lanes(e: RoadEdge): number { return Math.max(1, e.lanes); }

  /** The street to take at the end of the rail. */
  private choose(r: Rail, long: boolean): void {
    const G = this.G, e = r.e, n = this.endNode(e, r.dir), rng = this.rng;
    const tin = this.outDir(e, n.id, this.p0), ix = -tin.tx, iz = -tin.tz;
    let best: RoadEdge | null = null, bdir = 1, bang = 0, top = 0;
    // Failing all else (a one-way street into a hairpin, the Thruway's stub at the map's edge): the least sharp way on.
    let alt: RoadEdge | null = null, adir = 1, aang = 0;
    for (const id of n.edges) {
      const c = G.edges[id];
      if (c === e || c.closed || !G.canLeave(c, n.id)) continue;
      const o = this.outDir(c, n.id, this.p1);
      const ang = Math.atan2(ix * o.tz - iz * o.tx, ix * o.tx + iz * o.tz);
      if (!alt || Math.abs(ang) < Math.abs(aang)) { alt = c; adir = c.a === n.id ? 1 : -1; aang = ang; }
      if (Math.abs(ang) > 2.55) continue;
      // From the Thruway only off to the right, and onto it only going the way the ramp points.
      if (e.kind === 'highway' && c.kind !== 'highway' && ang < 0.02) continue;
      if (e.kind === 'ramp' && c.kind === 'highway' && Math.abs(ang) > 1.75) continue;
      const far = G.nodes[G.other(c, n.id)];
      let k: number;
      if (e.kind === 'highway') k = (0.25 + rng.next()) * (c.kind === 'highway' ? 1.4 : 1);
      else if (e.kind === 'ramp' && c.kind === 'highway') k = (0.25 + rng.next()) * (ang > -0.3 ? 3 : 0.3);
      else {
        k = (0.25 + rng.next()) * (Math.abs(ang) < 0.5 ? 2.2 : 1);
        if (c.kind === 'arterial' || c.kind === 'bridge') k *= 1.4;
      }
      // Toward a dead end (a street's end, or the Thruway's stub north of exit 130): hardly ever.
      if (far.edges.length <= 1 || !this.onward(c, far)) k *= 0.03;
      if (long && c.kind === 'local') k *= 0.3;
      if (k > top) { top = k; best = c; bdir = c.a === n.id ? 1 : -1; bang = ang; }
    }
    if (!best && alt && (e.oneWay || Math.abs(aang) < 2.9)) { best = alt; bdir = adir; bang = aang; }
    if (!best) { best = e; bdir = -r.dir; bang = Math.PI; }
    r.next = best; r.ndir = bdir; r.ang = bang;
    const nl = this.lanes(e);
    r.want = bang > 0.5 || (e.kind === 'highway' && best.kind !== 'highway') ? nl - 1 : bang < -0.5 ? 0 : Math.min(r.home, nl - 1);
  }

  /** Can a car arriving at `far` along c carry on without turning round? */
  private onward(c: RoadEdge, far: RoadNode): boolean {
    const G = this.G, tin = this.outDir(c, far.id, this.p1), ix = -tin.tx, iz = -tin.tz;
    for (const id of far.edges) {
      const o = G.edges[id];
      if (o === c || !G.canLeave(o, far.id)) continue;
      const d = this.outDir(o, far.id, this.p1);
      if (Math.abs(Math.atan2(ix * d.tz - iz * d.tx, ix * d.tx + iz * d.tz)) < 2.55) return true;
    }
    return false;
  }

  /** The cruising speed for a kind of road. */
  private cruiseFor(e: RoadEdge, v: Vehicle): number {
    const rng = this.rng, top = SPECS[v.spec.kind].topSpeed;
    const k = e.kind;
    let c = k === 'highway' ? Math.min(rng.range(21, 26), top * 0.7)
      : k === 'ramp' ? Math.min(rng.range(13, 16), top * 0.6)
        : k === 'arterial' || k === 'bridge' ? Math.min(rng.range(11.5, 14), top * 0.55)
          : Math.min(rng.range(8.5, 11), top * 0.5);
    if (v.spec.kind === 'bus') c = Math.min(c, k === 'highway' ? 18 : 9.5);
    // Item 34: a visitor's bright paint in the fall is a leaf-peeper, crawling along looking at the trees.
    if (k !== 'highway' && season.phase === 'fall' && VISITOR_PAINT.indexOf(v.color) >= 0) c *= 0.62;
    return c;
  }

  // ── Placing cars ───────────────────────────────────────────────────────────

  private fresh(lane: number, e: RoadEdge, dir: number): Rail {
    return {
      e, dir, lane, want: lane, home: this.rng.chance(0.6) ? 1 : 0, off: railOff(e, lane), next: e, ndir: dir, ang: 0,
      path: null, cum: [], k: 0, pv: 99, plane: 0, poff: 0, stop: 0, stopT: 0, arrive: 0, cruise: 10, yellow: 0, lcCool: 0, slowT: 0, prev: 99,
    };
  }

  /** Try one random spot on an open mainland street near the anchor; on success a new car is driving there. */
  seat(d: Driver, a: Anchor, near: number, far: number, front: number): boolean {
    const host = this.host, g = host.game, rng = this.rng;
    // A point picked by length (the arterials and the Thruway count for more), so cars spread as the roads do.
    const w = rng.next() * this.pickW[this.pickW.length - 1];
    let lo = 0, hi = this.pickW.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.pickW[m] < w) lo = m + 1; else hi = m; }
    const e = this.main[lo];
    if (e.closed || e.deck) return false;
    const dir = e.oneWay ? 1 : rng.chance(0.5) ? 1 : -1;
    const from = this.endNode(e, -dir), to = this.endNode(e, dir);
    const s0 = this.entry(from) + 10, s1 = e.len - this.entry(to) - 14;
    if (s1 <= s0) return false;
    const s = rng.range(s0, s1), nl = this.lanes(e);
    const p = this.lanePt(e, dir, s, 0, this.p0);
    if ((p.x - a.x) ** 2 + (p.z - a.z) ** 2 > far * far) return false;
    const kind = host.kindFor(this.G.districtAt(p.x, p.z), nl >= 2 && e.kind !== 'highway');
    const lane = kind === 'bus' ? nl - 1 : rng.int(0, nl - 1), off = railOff(e, lane);
    const x = p.x - p.tz * off, z = p.z + p.tx * off;
    if (!host.unseen(x, z, near, front)) return false;
    const clear = (o: Vehicle): boolean => {
      const ox = o.x - x, oz = o.z - z;
      return !(Math.abs(ox * p.tx + oz * p.tz) < 14 + o.hl && Math.abs(-ox * p.tz + oz * p.tx) < 2.4);
    };
    for (const o of g.vehicles.list) if (!clear(o)) return false;
    for (const o of host.others) if (!clear(o)) return false;
    for (const o of host.transit) if (!clear(o)) return false;
    // On an overpass (the Thruway over Second Thought Ave and Main St) the ground under the point is the road below
    // unless the spawn says which level it means: cars seated there stood at the foot of the embankment, unable to move.
    const S = streetSurface();
    if (S) setGroundHint(S.flat(x, z) + S.liftAt(e, s) + 0.3);
    // Fun queue 2, item 34: visitors in bright paints in high summer, slow leaf-peepers in the fall (no dice in the other seasons).
    const ph = season.phase, vis = (ph === 'summer' || ph === 'fall') && (kind === 'sedan' || kind === 'hatch' || kind === 'van' || kind === 'coupe') && rng.chance(ph === 'summer' ? 0.34 : 0.22);
    const v = g.vehicles.spawn(kind, x, z, Math.atan2(p.tx, p.tz), vis ? VISITOR_PAINT[rng.int(0, VISITOR_PAINT.length - 1)] : undefined);
    if (S) setGroundHint();
    v.driver = 'ai';
    d.v = v; d.wid = host.newWid();
    host.byVeh.set(v, d);
    const r = this.fresh(lane, e, dir);
    r.cruise = this.cruiseFor(e, v);
    d.r = r;
    // (Before choose(), which reuses the scratch point p.)
    v.vx = p.tx * r.cruise * 0.7; v.vz = p.tz * r.cruise * 0.7;
    this.choose(r, v.hl > 3.2);
    host.fresh(d);
    this.stats.seated++;
    return true;
  }

  /** A car already standing on the street (the last host's): find its rail from where it is and which way it points. */
  place(d: Driver, v: Vehicle): boolean {
    const G = this.G;
    const near = G.nearestEdge(v.x, v.z, (e) => e.id >= G.isle.edges && !e.closed);
    const e = near.edge;
    if (near.d > e.hw + 2) return false;
    const p = G.pointAt(e, near.s), sh = Math.sin(v.h), ch = Math.cos(v.h);
    let dir = sh * p.dx + ch * p.dz >= 0 ? 1 : -1;
    if (e.oneWay) dir = 1;
    const tx = p.dx * dir, tz = p.dz * dir, lat = -(v.x - p.x) * tz + (v.z - p.z) * tx;
    let lane = 0;
    for (let l = 1; l < this.lanes(e); l++) if (Math.abs(lat - railOff(e, l)) < Math.abs(lat - railOff(e, lane))) lane = l;
    const r = this.fresh(lane, e, dir);
    r.off = clamp(lat, -e.hw + 0.8, e.hw - 0.8);
    r.cruise = this.cruiseFor(e, v);
    d.r = r;
    this.choose(r, v.hl > 3.2);
    this.stats.adopted++;
    return true;
  }

  /** An island car driving onto the bridge (northbound): it takes the bridge's rail. */
  fromBridge(d: Driver, v: Vehicle): void {
    const e = this.G.edges[this.G.bridgeEdge], r = this.fresh(Math.min(d.lane, 1), e, -1);
    r.off = d.off;
    r.cruise = this.cruiseFor(e, v);
    d.r = r;
    this.choose(r, v.hl > 3.2);
    this.stats.fromIsland++;
  }

  forget(d: Driver): void {
    if (!d.r) return;
    const q = this.queue.get(this.endNode(d.r.e, d.r.dir).id);
    if (q) { const i = q.indexOf(d); if (i >= 0) q.splice(i, 1); }
    d.r = null;
  }

  // ── The junction ───────────────────────────────────────────────────────────

  /** Sample a cubic from p0 (heading t0) to p3 (heading t3) into out. */
  private cubic(out: number[], a: Pt, b: Pt, hl: number): void {
    const x1 = a.x + a.tx * hl, z1 = a.z + a.tz * hl, x2 = b.x - b.tx * hl, z2 = b.z - b.tz * hl;
    const n = 10;
    for (let i = out.length ? 1 : 0; i <= n; i++) {
      const u = i / n, w = 1 - u, k0 = w * w * w, k1 = 3 * w * w * u, k2 = 3 * w * u * u, k3 = u * u * u;
      out.push(k0 * a.x + k1 * x1 + k2 * x2 + k3 * b.x, k0 * a.z + k1 * z1 + k2 * z2 + k3 * b.z);
    }
  }

  /** Lay the path from the lane into the street chosen. */
  private enter(d: Driver, r: Rail, v: Vehicle): void {
    const n = this.endNode(r.e, r.dir), c = r.next, cn = this.lanes(c);
    const ent = this.entry(n);
    const a = this.lanePt(r.e, r.dir, Math.max(0, r.e.len - ent), r.off, this.p0);
    let lane: number;
    if (r.e.kind === 'ramp' && c.kind === 'highway') lane = cn - 1;
    else lane = r.ang > 0.5 ? (v.hl > 3.2 && cn > 1 ? cn - 2 : cn - 1) : r.ang < -0.5 ? 0 : Math.min(r.lane, cn - 1);
    const off = railOff(c, lane);
    const b = this.lanePt(c, r.ndir, Math.min(ent, c.len * 0.5), off, this.p1);
    const out: number[] = [];
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    if (n.control === 'roundabout') {
      const rc = (islandR(n) + n.hx) / 2;
      const ta = Math.atan2(a.z - n.z, a.x - n.x) - 0.5, tb = Math.atan2(b.z - n.z, b.x - n.x) + 0.5;
      let span = ta - tb;
      span = ((span % TAU) + TAU) % TAU;
      if (span < 0.25) this.cubic(out, a, b, dist * 0.39);
      else {
        const A: Pt = { x: n.x + Math.cos(ta) * rc, z: n.z + Math.sin(ta) * rc, tx: Math.sin(ta), tz: -Math.cos(ta) };
        const B: Pt = { x: n.x + Math.cos(ta - span) * rc, z: n.z + Math.sin(ta - span) * rc, tx: Math.sin(ta - span), tz: -Math.cos(ta - span) };
        this.cubic(out, a, A, Math.hypot(A.x - a.x, A.z - a.z) * 0.39);
        const steps = Math.max(2, Math.ceil(span / 0.18));
        for (let i = 1; i < steps; i++) { const t = ta - (span * i) / steps; out.push(n.x + Math.cos(t) * rc, n.z + Math.sin(t) * rc); }
        out.push(B.x, B.z);
        const tail: number[] = [B.x, B.z];
        this.cubic(tail, B, b, Math.hypot(b.x - B.x, b.z - B.z) * 0.39);
        for (let i = 2; i < tail.length; i++) out.push(tail[i]);
      }
      this.stats.rounds++;
    } else if (Math.abs(r.ang) > 2.5) {
      // Turning round at a dead end: a wide teardrop.
      this.cubic(out, a, b, 9);
      this.stats.uturns++;
    } else this.cubic(out, a, b, dist * 0.39);
    if (r.e.kind === 'ramp' && c.kind === 'highway') this.stats.merges++;
    if (r.e.kind === 'highway' && c.kind === 'ramp') this.stats.exits++;
    // Arc lengths, and the speed the tightest bend allows.
    const cum = [0];
    let turn = 0, ph = NaN;
    for (let i = 2; i < out.length; i += 2) {
      const dx = out[i] - out[i - 2], dz = out[i + 1] - out[i - 1], L = Math.hypot(dx, dz);
      cum.push(cum[cum.length - 1] + L);
      const h = Math.atan2(dx, dz);
      if (L > 0.05) { if (!Number.isNaN(ph)) { let dh = h - ph; dh -= Math.round(dh / TAU) * TAU; turn += Math.abs(dh); } ph = h; }
    }
    const len = cum[cum.length - 1];
    const R = len / Math.max(turn, 0.01);
    r.path = out; r.cum = cum; r.k = 0; r.plane = lane; r.poff = off;
    r.pv = clamp(Math.sqrt(2.4 * R), 3.2, 30) * (v.hl > 3.2 ? 0.85 : 1) * (1 - 0.5 * roads.ai);
    this.unqueue(d, n.id);
    r.stop = 0; r.stopT = 0; r.yellow = 0; r.prev = 99;
    this.stats.paths++;
  }

  private unqueue(d: Driver, node: number): void {
    const q = this.queue.get(node);
    if (q) { const i = q.indexOf(d); if (i >= 0) q.splice(i, 1); }
  }

  /** What drivers arriving along `e` at node `nodeId` see, `ahead` seconds from now (for people crossing that road's mouth). */
  lightFor(e: RoadEdge, nodeId: number, ahead = 0): 'green' | 'yellow' | 'red' {
    return signalState(this.G.nodes[nodeId], this.phaseB[this.ai(e, nodeId)] === 1, this.host.game.signalTime + ahead);
  }

  /** What drivers arriving along `e` at node `nodeId` see at the given signal-clock time (the bus timetable, sim/busRoutes.ts). */
  lightAt(e: RoadEdge, nodeId: number, time: number): 'green' | 'yellow' | 'red' {
    return signalState(this.G.nodes[nodeId], this.phaseB[this.ai(e, nodeId)] === 1, time);
  }

  private sig(n: RoadNode, e: RoadEdge): 'green' | 'yellow' | 'red' {
    return signalState(n, this.phaseB[this.ai(e, n.id)] === 1, this.host.game.signalTime);
  }

  /** Must a car arriving at n along e stop at the line? */
  mustStop(n: RoadNode, e: RoadEdge): boolean {
    if (n.control !== 'stop' || e.kind === 'ramp') return false;
    return this.allWay.has(n.id) || this.through[this.ai(e, n.id)] === 0;
  }

  /** Something in the junction's pad (other than v), moving or not. */
  padBusy(n: RoadNode, v: Vehicle, near: readonly Vehicle[], r2: number): boolean {
    for (const o of near) {
      if (o === v) continue;
      const dx = o.x - n.x, dz = o.z - n.z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /**
   * Traffic coming at the junction that v must let by: within `eta` seconds of the pad and not on v's own approach.
   * oncoming: only what comes from straight ahead (a left turn's gap). sameWay: only what heads along (hx, hz) (a merge).
   */
  coming(n: RoadNode, v: Vehicle, near: readonly Vehicle[], ix: number, iz: number, eta: number, mode: 0 | 1 | 2, hx = 0, hz = 0): boolean {
    const R = padR(n);
    for (const o of near) {
      if (o === v) continue;
      const rx = o.x - n.x, rz = o.z - n.z, dist = Math.hypot(rx, rz);
      if (dist < 0.5 || dist > 90) continue;
      const ux = rx / dist, uz = rz / dist;
      // On v's own approach (behind it or in its queue): (ix, iz) points into the node, so its approach is at -(ix, iz).
      if (-(ux * ix + uz * iz) > 0.9) continue;
      if (mode === 1 && ux * ix + uz * iz < 0.6) continue;
      if (mode === 2 && Math.sin(o.h) * hx + Math.cos(o.h) * hz < 0.6) continue;
      const close = -(o.vx * ux + o.vz * uz);
      if (dist < R + 1) { if (mode !== 2 && Math.hypot(o.vx, o.vz) > 0.5) return true; if (mode === 2) return true; continue; }
      if (close > 1.5 && (dist - R) / close < eta) return true;
    }
    return false;
  }

  /** Circulating traffic about to pass a roundabout entry at angle ta. */
  circling(n: RoadNode, v: Vehicle, near: readonly Vehicle[], ta: number): boolean {
    const r0 = islandR(n) - 1, r1 = n.hx + 2;
    for (const o of near) {
      if (o === v) continue;
      const rx = o.x - n.x, rz = o.z - n.z, dist = Math.hypot(rx, rz);
      if (dist < r0 || dist > r1) continue;
      // Upstream of the entry: circulation runs toward smaller angles, so a larger angle is still to come.
      let da = Math.atan2(rz, rx) - ta;
      da = ((da % TAU) + TAU) % TAU;
      if (da < 1.5 || (da > TAU - 0.35 && dist < n.hx - 1)) return true;
    }
    return false;
  }

  // ── Driving ────────────────────────────────────────────────────────────────

  drive(d: Driver, v: Vehicle, dt: number, depth = 0): void {
    const host = this.host, g = host.game, ctl = v.ctl, r = d.r!;
    if ((d.nearT -= dt) <= 0) {
      d.nearT = 0.22 + (v.id % 5) * 0.012;
      d.near.length = 0;
      const R = 70 + Math.abs(v.speed) * 1.5;
      for (const o of g.vehicles.list) {
        if (o === v) continue;
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox < R && ox > -R && oz < R && oz > -R) d.near.push(o);
      }
      for (const o of host.others) {
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox < R && ox > -R && oz < R && oz > -R) d.near.push(o);
      }
      for (const o of host.transit) {
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox < R && ox > -R && oz < R && oz > -R) d.near.push(o);
      }
    }
    const sp = v.speed, sh = Math.sin(v.h), ch = Math.cos(v.h), long = v.hl > 3.2;
    let cx: number, cz: number, want = r.cruise, hold = false, stopD = 99;
    const slick = roads.ai;

    if (r.path) {
      // ── Through the junction ──
      const p = r.path, cum = r.cum, last = cum.length - 1;
      for (;;) {
        if (r.k >= last - 1) break;
        const ax = p[2 * r.k], az = p[2 * r.k + 1], bx = p[2 * r.k + 2], bz = p[2 * r.k + 3];
        const sx = bx - ax, sz = bz - az, t = ((v.x - ax) * sx + (v.z - az) * sz) / (sx * sx + sz * sz || 1);
        if (t > 1) r.k++; else break;
      }
      const ax = p[2 * r.k], az = p[2 * r.k + 1], bx = p[2 * r.k + 2], bz = p[2 * r.k + 3];
      const sx = bx - ax, sz = bz - az, sl = Math.hypot(sx, sz) || 1;
      const t = clamp(((v.x - ax) * sx + (v.z - az) * sz) / (sl * sl), 0, 1);
      const u = cum[r.k] + t * sl;
      if (u >= cum[last] - 0.6 || (r.k >= last - 1 && t >= 0.98)) {
        // Out the far side: onto the new street's lane.
        r.e = r.next; r.dir = r.ndir; r.lane = r.plane; r.off = r.poff; r.path = null;
        if (r.e.kind !== 'highway' || r.cruise < 18) r.cruise = this.cruiseFor(r.e, v);
        this.choose(r, long);
      } else {
        const L = clamp(2.4 + 0.45 * Math.abs(sp), 3.2, 9), aim = u + L;
        let j = r.k;
        while (j < last - 1 && cum[j + 1] < aim) j++;
        const q0x = p[2 * j], q0z = p[2 * j + 1], q1x = p[2 * j + 2], q1z = p[2 * j + 3];
        const seg = cum[j + 1] - cum[j];
        if (aim >= cum[last]) {
          // Off the end: carry on up the lane beyond it.
          const e2 = this.lanePt(r.next, r.ndir, Math.min(r.next.len, this.entry(this.endNode(r.next, -r.ndir)) + (aim - cum[last]) + 0.5), r.poff, this.p0);
          cx = e2.x; cz = e2.z;
        } else {
          const tt = seg > 0 ? (aim - cum[j]) / seg : 0;
          cx = q0x + (q1x - q0x) * tt; cz = q0z + (q1z - q0z) * tt;
        }
        want = Math.min(want, r.pv);
      }
    }
    if (!r.path) {
      // ── Along the lane ──
      const e = r.e, n = this.endNode(e, r.dir), ent = this.entry(n);
      const pr = this.G.project(e, v.x, v.z), s = r.dir > 0 ? pr.s : e.len - pr.s;
      // The island end of the bridge: back to the grid.
      if (e.deck && r.dir > 0 && s > e.len * 0.5) { host.toIsland(d, v); this.stats.toIsland++; return; }
      if (s > e.len - ent - 0.01) {
        if (ent === 0) {
          // A plain bend between two edges: straight onto the next one, same lane.
          r.e = r.next; r.dir = r.ndir; r.lane = Math.min(r.lane, this.lanes(r.e) - 1);
          this.choose(r, long);
        } else this.enter(d, r, v);
        if (depth < 3) { this.drive(d, v, dt, depth + 1); return; }
        v.ctl.accel = 0;
        return;
      }
      const nl = this.lanes(e);
      // The nose stops at the stop line: behind the crosswalk at a signal (streetMeshes.ts), just short of the pad elsewhere.
      stopD = e.len - (n.control === 'signal' ? padR(n) + 3.4 : ent - 0.2) - v.hl - s;
      // Lane changes: for the turn ahead, or round a slow car on a road with room.
      if (r.lcCool > 0) r.lcCool -= dt;
      if (r.lane > nl - 1) r.lane = nl - 1;
      if (r.lane !== r.want && r.lcCool <= 0 && stopD > 18) {
        const to = clamp(r.want, r.lane - 1, r.lane + 1);
        if (this.laneClear(d, v, railOff(e, to) - railOff(e, r.lane), sp)) { r.lane = to; r.lcCool = 2.5; }
      } else if (r.slowT > 3 && nl >= 2 && stopD > 60 && r.lcCool <= 0) {
        const to = r.lane > 0 ? r.lane - 1 : r.lane + 1;
        if (this.laneClear(d, v, railOff(e, to) - railOff(e, r.lane), sp)) { r.lane = to; r.home = to; r.lcCool = 6; r.slowT = 0; d.wait = 0; }
      }
      const tOff = railOff(e, r.lane);
      const drift = clamp(0.3 + Math.abs(sp) * 0.18, 0.3, 1.9) * dt;
      r.off += clamp(tOff - r.off, -drift, drift);
      const look = clamp(3.5 + 0.5 * Math.abs(sp), 4.5, 16);
      const a = this.lanePt(e, r.dir, Math.min(e.len, s + look), r.off, this.p0);
      cx = a.x; cz = a.z;
      // Pushed or slid well out of the lane: slow right down while steering back.
      const lp = this.lanePt(e, r.dir, s, r.off, this.p1), lerr = Math.abs(-(v.x - lp.x) * lp.tz + (v.z - lp.z) * lp.tx);
      if (lerr > 2.5) want = Math.min(want, Math.max(2.5, 9 - lerr));
      // Bends in the road: the speed the curve ahead allows.
      const w = Math.max(14, Math.abs(sp) * 1.6);
      const t0 = this.lanePt(e, r.dir, Math.min(e.len, s + 2), 0, this.p1), t0x = t0.tx, t0z = t0.tz;
      const t1 = this.lanePt(e, r.dir, Math.min(e.len, s + 2 + w), 0, this.p1);
      const bend = Math.acos(clamp(t0x * t1.tx + t0z * t1.tz, -1, 1));
      if (bend > 0.05) want = Math.min(want, Math.max(4 - 2 * slick, Math.sqrt((2.6 - 1.4 * slick) * w / bend)));

      // ── The junction ahead ──
      if (ent > 0 && stopD < 60) {
        const turning = Math.abs(r.ang) > 0.5;
        if (turning || n.control === 'roundabout') {
          const vt = n.control === 'roundabout' ? 6.5 : r.ang > 0.5 ? 5 : 6.5;
          want = Math.min(want, vt * (long ? 0.85 : 1) * (1 - 0.4 * slick) + Math.max(0, stopD) * (0.4 - 0.2 * slick));
        }
        const tin = this.outDir(e, n.id, this.p1), ix = -tin.tx, iz = -tin.tz;
        if (n.control === 'signal') {
          const sg = this.sig(n, e);
          if (sg === 'green') r.yellow = 0;
          else if (sg === 'yellow' && r.yellow === 0) r.yellow = stopD > sp * sp / 11 + 0.5 ? 1 : 2;
          if (sg === 'red' || (sg === 'yellow' && r.yellow === 1)) hold = true;
          else if (r.ang < -0.5 && stopD < 10 && this.coming(n, v, d.near, ix, iz, 4.5, 1)) hold = true;
        } else if (n.control === 'roundabout') {
          if (stopD < 12) {
            const ta = Math.atan2(a.z - n.z, a.x - n.x);
            if (this.circling(n, v, d.near, ta)) hold = true;
          }
        } else if (e.kind === 'ramp' && r.next.kind === 'highway') {
          // Merging: the lane it joins must have a gap.
          if (stopD < 25) {
            const o = this.outDir(r.next, n.id, this.p1);
            if (this.coming(n, v, d.near, ix, iz, 3.2, 2, o.tx, o.tz)) hold = true;
          }
        } else if (this.mustStop(n, e)) {
          if (stopD < 30) want = Math.min(want, 2 + Math.sqrt(3.5 * Math.max(0, stopD)));
          if (r.stop === 0) {
            hold = true;
            if (stopD < 2.2 && Math.abs(sp) < 0.6) {
              r.stopT += dt;
              if (r.stopT > 0.5) {
                r.stop = 1; r.arrive = g.time; r.stopT = 0;
                let q = this.queue.get(n.id);
                if (!q) this.queue.set(n.id, (q = []));
                if (!q.includes(d)) q.push(d);
              }
            }
          } else if (r.stop === 1) {
            hold = true;
            r.stopT += dt;
            const q = this.queue.get(n.id) ?? [];
            // Tidy the queue: only drivers still waiting at this node count.
            for (let i = q.length - 1; i >= 0; i--) {
              const o = q[i];
              if (!o.v || !o.r || o.r.stop !== 1 || this.endNode(o.r.e, o.r.dir) !== n || o.r.path) q.splice(i, 1);
            }
            const first = q.length === 0 || q[0] === d || r.stopT > 7;
            const R = padR(n), busy = this.padBusy(n, v, d.near, (R - 0.5) * (R - 0.5));
            const allWay = this.allWay.has(n.id);
            const traffic = !allWay && r.stopT < 14 && this.coming(n, v, d.near, ix, iz, 4.2, 0);
            if ((first && !busy && !traffic) || r.stopT > 22) { r.stop = 2; hold = false; }
          }
        } else if (this.through[this.ai(e, n.id)] === 1 && r.ang < -0.5 && stopD < 10) {
          // Turning left off a through road: wait for a gap in the oncoming lanes.
          if (this.coming(n, v, d.near, ix, iz, 4.5, 1)) hold = true;
        }
        // Never into the pad without room on the far side.
        if (!hold && stopD < 8) {
          const b = this.lanePt(r.next, r.ndir, Math.min(r.next.len, this.entry(n) + 4), railOff(r.next, Math.min(this.lanes(r.next) - 1, r.ang > 0.5 ? this.lanes(r.next) - 1 : r.ang < -0.5 ? 0 : r.lane)), this.p1);
          for (const o of d.near) {
            if (o === v) continue;
            const ox = o.x - b.x, oz = o.z - b.z;
            const al = ox * b.tx + oz * b.tz, la = -ox * b.tz + oz * b.tx;
            if (al > -3 && al < v.hl + o.hl + 2 && Math.abs(la) < 2 && o.vx * b.tx + o.vz * b.tz < 1.5) { hold = true; break; }
          }
        }
        if (hold) want = Math.min(want, stopD < 0.6 ? 0 : Math.sqrt((4.4 - 2.4 * slick) * stopD));
        // For the record, the moment the nose crosses the line: against a red, or at a stop line without stopping.
        if (r.prev > -0.9 && stopD <= -0.9 && d.panic <= 0 && d.bold <= 0) {
          if (n.control === 'signal' && this.sig(n, e) === 'red') { this.stats.redRuns++; this.stats.note += `red n${n.id} e${e.id} sp${sp.toFixed(1)} y${r.yellow};`; }
          if (this.mustStop(n, e) && r.stop !== 2) { this.stats.stopRuns++; this.stats.note += `stop n${n.id} e${e.id} st${r.stop};`; }
        }
      }
      r.prev = stopD;
    }
    this.follow(d, v, dt, cx!, cz!, want, hold, stopD, slick, sh, ch);
  }

  /** Is the lane `delta` m to the side clear along the car? */
  private laneClear(d: Driver, v: Vehicle, delta: number, sp: number): boolean {
    const sh = Math.sin(v.h), ch = Math.cos(v.h);
    for (const o of d.near) {
      if (o === v) continue;
      const ox = o.x - v.x, oz = o.z - v.z, al = ox * sh + oz * ch, la = -ox * ch + oz * sh;
      if (al < -10 - Math.abs(sp) * 0.7 - o.hl || al > 14 + Math.abs(sp) * 0.7 + o.hl) continue;
      if (Math.abs(la - delta) < 1 + Math.max(o.hw, 0.9)) return false;
    }
    return true;
  }

  /** Cars and people in the way, being held up, and the controls. */
  private follow(d: Driver, v: Vehicle, dt: number, cx: number, cz: number, want: number, hold: boolean, stopD: number, slick: number, sh: number, ch: number): void {
    const host = this.host, g = host.game, ctl = v.ctl, r = d.r!, sp = v.speed;
    let err = Math.atan2(cx - v.x, cz - v.z) - v.h;
    err -= Math.round(err / TAU) * TAU;
    const panic = d.panic > 0;
    if (panic) { d.panic -= dt; want = Math.max(want, Math.min(r.cruise * 1.5, v.spec.topSpeed * 0.75)); }
    want *= 1 - 0.55 * Math.min(1, Math.abs(err) * 1.2);
    if (slick > 0) want *= 1 - 0.35 * slick;

    const bold = d.bold > 0;
    if (bold) { d.bold -= dt; want = Math.min(want, 1.6); }
    const margin = bold ? -0.2 : 0.35, keep = bold ? 0.5 : 2.2;
    let blocked = false, blocker: Vehicle | null = null, blockLegit = false, leadSlow = false, onFoot = false, headOn = false;
    const reach = 44 + Math.max(0, sp) * 1.4;
    // In a turn the nose is not where the car is going: judge across the line to the aim point.
    const ax = cx - v.x, az = cz - v.z, al = Math.hypot(ax, az) || 1;
    const fx = r.path ? ax / al : sh, fz = r.path ? az / al : ch;
    for (const o of d.near) {
      // A car on the overpass is no obstacle to one on the road under it (and the other way round).
      if (Math.abs(o.y - v.y) > 3) continue;
      const ox = o.x - v.x, oz = o.z - v.z;
      const lf = ox * fx + oz * fz;
      if (lf <= 0 || lf > reach) continue;
      const lat = -ox * fz + oz * fx;
      const hd = fx * Math.sin(o.h) + fz * Math.cos(o.h), c = Math.abs(hd), sn = Math.sqrt(Math.max(0, 1 - c * c));
      const oF = o.vx * fx + o.vz * fz;
      const rch = o.hw * c + o.hl * sn;
      const band = hd < -0.5 && oF < -1 ? v.hw + rch + 0.15 : v.hw + rch + margin;
      if (Math.abs(lat) > band) continue;
      const gap = lf - v.hl - (o.hl * c + o.hw * sn);
      const of = Math.max(0, oF), room = Math.max(0, gap - keep);
      let lim = Math.min(Math.sqrt(5 * room) + of, Math.max(0, of + (gap - keep - (0.8 + 0.9 * slick) * Math.max(0, sp)) * 0.9));
      if (gap < keep && of < 1) lim = 0;
      if (lim < want) {
        want = lim;
        if (lim < r.cruise - 2.5 && of < r.cruise - 3) leadSlow = true;
        if (lim < 0.6) {
          blocked = true; blocker = o; headOn = hd < -0.5 && gap < 8;
          const od = host.byVeh.get(o);
          blockLegit = od !== undefined && hd > 0.5 && (od.legit || oF > 1.5);
        }
      }
    }
    const pl = g.player, peds = host.roadPeds(), reachP = 7 + Math.max(0, sp) * 1.9;
    const np = peds.length + (pl.vehicle ? 0 : 1);
    for (let i = 0; i < np; i++) {
      let ox: number, oz: number, pvx = 0, pvz = 0;
      if (i < peds.length) { const p = peds[i]; ox = p.x - v.x; oz = p.z - v.z; pvx = p.vx; pvz = p.vz; }
      else { if (Math.abs(pl.y - v.y) > 2) continue; ox = pl.x - v.x; oz = pl.z - v.z; }
      if (ox > 40 || ox < -40 || oz > 40 || oz < -40) continue;
      const lf = ox * fx + oz * fz - v.hl, lat = -ox * fz + oz * fx;
      if (lf < -1 || lf > reachP) continue;
      const lat2 = lat + (-pvx * fz + pvz * fx) * 1.2, w = v.hw + (bold ? 0.35 : 0.9);
      if (Math.abs(lat) > w && Math.abs(lat2) > w && lat * lat2 > 0) continue;
      const lim = lf < 2.6 ? 0 : Math.sqrt(5 * (lf - 2.6));
      if (lim < want) { want = lim; if (lim < 0.6) { blocked = true; blocker = null; blockLegit = false; headOn = false; onFoot = i < peds.length; } }
    }

    const halted = want < 0.6 && Math.abs(sp) < 1;
    const atLine = hold && halted && stopD < 4;
    d.legit = atLine || (blocked && (blockLegit || onFoot));
    d.wait = halted && blocked && !blockLegit ? d.wait + dt : Math.max(0, d.wait - dt * 3);
    r.slowT = leadSlow && !blocked ? r.slowT + dt : 0;
    d.still = Math.abs(sp) < 0.3 && !d.legit ? d.still + dt : 0;
    d.halt = Math.abs(sp) < 0.3 ? d.halt + dt : 0;
    d.why = blocked ? (blocker ? blocker.spec.kind : onFoot ? 'ped' : 'player') : hold ? 'hold' : '';
    if (d.honkCool > 0) d.honkCool -= dt;
    if (d.honk > 0) d.honk -= dt;
    if (d.wait > (onFoot ? 7 : 2.5) && d.honkCool <= 0) { d.honk = 0.45; d.honkCool = 6; }
    ctl.horn = d.honk > 0;
    if (d.wait > 11 && !bold) {
      const od = blocker ? host.byVeh.get(blocker) : undefined;
      if (!od || od.bold <= 0) { d.bold = 4; d.wait = 5; }
    }
    if (d.bail > 0) {
      d.bail -= dt;
      want = 0;
      if (Math.abs(sp) < 0.5 || d.bail <= 0) { host.leaveCar(d, v); return; }
    }
    if (want > 1.5 && Math.abs(sp) < 0.4) d.stuck += dt; else if (Math.abs(sp) > 1.5) d.stuck = 0;
    let steer = clamp(-err * 1.9, -1, 1);
    if (d.backCool > 0) d.backCool -= dt;
    // Nose to nose with somebody (one of them out of its lane): both give a little room and try again.
    const standoff = headOn && d.wait > 3 && d.backCool <= 0 && d.back <= 0;
    if (d.stuck > 4 || standoff) {
      if (!standoff) d.jams++;
      d.stuck = 0;
      let gap = 99;
      for (const o of d.near) {
        const ox = o.x - v.x, oz = o.z - v.z, lf = ox * sh + oz * ch;
        if (lf >= 0 || lf < -(v.hl + o.hl + 6) || Math.abs(-ox * ch + oz * sh) > v.hw + o.hw + 0.4) continue;
        gap = Math.min(gap, -lf - v.hl - o.hl);
      }
      if (gap > 1.2) { d.back = 1.2; d.backCool = 5; }
    }
    if (d.back > 0) { d.back -= dt; ctl.accel = -0.7; ctl.steer = -steer; ctl.handbrake = false; return; }
    if (Math.abs(err) > 1.2 && sp < 3) steer = Math.sign(-err);
    ctl.steer = steer;
    if (want < 0.25 && sp < 0.8) { ctl.accel = 0; ctl.handbrake = true; return; }
    ctl.handbrake = false;
    const dv = want - sp;
    // (On snow a gentler foot both ways: wheelspin and locked wheels are how cars end up on the sidewalk.)
    ctl.accel = dv > 0 ? Math.min(1 - 0.5 * slick, dv * 0.45 + 0.08) : dv < -0.7 && sp > 0.5 ? Math.max(-1 + 0.4 * slick, dv * 0.5) : 0;
  }

  /** Every frame, for host and guests alike: the signal lamps. */
  update(): void { this.signals.update(); }
}
