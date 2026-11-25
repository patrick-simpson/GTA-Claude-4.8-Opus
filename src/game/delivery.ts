// Delivery Rush (fun queue item 14): parcels from a depot to doors across both towns, against the clock.
//
//   SpeedScan HQ   the loading bay on the curb south of the plaza: ID-card boxes, "RUSH ORDER", lime stink lines
//   Pardon's       the loading dock behind the store in Tepid Falls: mattresses, lawn chairs, an armchair, strapped
//                  on the roof and sticking out of the bed, comically oversized
//
// Stop at a depot in any car and press G: 3 to 6 parcels (vans 6, pickups 5, the rest 3 or 4), each with an address
// and its own ticking deadline. Drop zones are glowing rings at the curb; stop in one, a customer walks out and signs
// with a deadpan line, and the pay is counted at once: a base by distance, a speed bonus while the drop is on time,
// docked for the cargo's condition, multiplied by the combo of on-time drops in a row. Bumps scuff the cargo; a big
// crash throws parcels into the road, where they lie (a ring each) until driven or walked over. A drop more than
// RETURN_AFTER seconds late is returned to sender. When the stack is empty (or the shift is abandoned) a summary card
// shows what happened, and "Best rush" (save.best.rush, money earned in one rush) and "Parcels delivered" are kept.
//
// Delivery points are found from the street graph at the moment the rush starts (plan.edges, both the old grid's
// straight edges and the new graph's polylines, open and not the bridge), so they follow any rebuild of the streets.
// The mainland is used only once the bridge is open (progress.complete), or when the depot itself is over there.
//
// Everything here is this browser's own: in a shared town each player runs their own rush (the job's car is held,
// as the other jobs hold theirs, so the town does not take it back). Kid mode needs nothing: nobody is hurt.
// Takes the floor like the other jobs (ThingsToDo.busy). The lead wires it in src/game/index.ts.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { Blip } from '../ui/hud';
import type { RoadEdge } from '../world/plan';
import { groundAt, isWater, WATER_Y } from '../world/plan';
import { HQ } from '../world/speedscanHQ';
import { PD } from '../world/pardonsSite';
import { progress } from '../world/progress';
import { money } from '../core/util';
import { save } from './save';
import { taper } from './activities';
import { clock, type Markers, type Pt } from './script';

/** Seconds past its deadline before a parcel is returned to sender. */
const RETURN_AFTER = 45;
/** Impacts at or over this speed (m/s) throw parcels out. */
const SPILL_SPEED = 11;

type DepotId = 'speedscan' | 'pardons';
interface Depot { id: DepotId; name: string; short: string; at: Pt; letter: string; land: number }

interface Parcel {
  at: Pt; addr: string; item: string;
  /** Seconds left until due (negative: late). */
  left: number; allot: number;
  /** Straight-line meters from the depot: the base pay grows with it. */
  far: number;
  cond: number;
  state: 'aboard' | 'loose' | 'done' | 'returned';
  /** Where it lies while loose. */
  lx: number; lz: number; mesh: THREE.Object3D | null;
}

interface Customer { p: Person; t: number; from: Pt; to: Pt }

const SS_ITEMS = ['400 blank ID cards', 'a ribbon for a card printer', 'lanyards, 250, lime', 'badge holders (rush)', 'a replacement printhead', '1,000 visitor badges', 'one (1) laminator', 'the overlay film'];
const PD_ITEMS = ['a queen mattress', 'four lawn chairs', 'an armchair, slightly used', 'a mattress, firm', 'a folding cot', 'two lawn chairs and a cooler', 'a loveseat', 'a mattress topper the size of a raft'];
const SS_LINES = [
  'Badges. Finally. We have been recognising each other by smell.',
  'Is this the rush order? It does not look rushed. It looks fine.',
  'Sign here? I will sign as someone else. That is what the badges are for.',
  'Our security guard has been letting everyone in. He will be relieved. Or not.',
  'Lime lanyards. Bold. Nobody will ever lose one. Nobody will ever wear one.',
  'You are faster than the last courier. He is still in the lift.',
];
const PD_LINES = [
  'That mattress has been on the roof of a moving car. I can tell. I respect it.',
  'Four lawn chairs. We have a lawn of one chair. This will be a change.',
  'Pardon\'s says no returns. I said I would never need one. Look at me now.',
  'It fits through the door if we believe in it.',
  'My wife said I would never buy furniture from a salvage store. She was wrong, and also gone.',
  'Leave it on the porch. The porch is where furniture goes to think.',
];
const LATE_LINES = ['It is late, but so am I, in many ways.', 'I had given up. I had moved on. Put it there.', 'The clock says late. I say whatever.'];
const SCUFF_LINES = ['The box is shaped differently from how boxes are.', 'Was it always this colour?', 'It rattles. It was not meant to rattle.'];

/** Carry capacity by kind: vans and pickups carry more. Boats and the bus are not offered. */
function capacity(k: VehicleKind): number {
  if (k === 'van') return 6;
  if (k === 'pickup' || k === 'tow') return 5;
  if (k === 'speedboat' || k === 'jetski' || k === 'bus') return 0;
  if (k === 'sedan' || k === 'cmax' || k === 'taxi' || k === 'cruiser') return 4;
  return 3;
}

/**
 * How far off the centre line a drop ring sits: the middle of the curb-side lane, clear of the parked cars at the curb
 * and of the sidewalk (hw is the street's half width, curb to curb on the old grid).
 */
const laneOff = (hw: number): number => Math.max(1.5, Math.min(hw - 3.2, hw * 0.55));

/** A point on an edge, `s` meters from its node a, with the unit direction of travel there. */
function edgeAt(nodes: readonly { x: number; z: number }[], e: RoadEdge, s: number): { x: number; z: number; tx: number; tz: number } {
  const p = e.pts, c = e.cum;
  if (p && c && p.length >= 4) {
    let k = 0;
    while (k < c.length - 2 && c[k + 1] < s) k++;
    const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
    const seg = Math.max(1e-3, c[k + 1] - c[k]), f = Math.min(1, Math.max(0, (s - c[k]) / seg)), L = Math.hypot(bx - ax, bz - az) || 1;
    return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, tx: (bx - ax) / L, tz: (bz - az) / L };
  }
  const A = nodes[e.a];
  return e.horiz ? { x: A.x + s, z: A.z, tx: 1, tz: 0 } : { x: A.x, z: A.z + s, tx: 0, tz: 1 };
}

export class Delivery {
  prompt: string | null = null;
  target: Pt | null = null;
  /** The depot of the rush in hand, or null when there is none. */
  depot: Depot | null = null;

  private depots: Depot[] | null = null;
  private parcels: Parcel[] = [];
  private ride: Vehicle | null = null;
  private awayT = 0;
  private clockT = 0;
  private combo = 0; private bestCombo = 0;
  private paid = 0; private points = 0; private onTime = 0;
  private cashK = 1; private ptsK = 1;
  private hitCool = 0;
  private lines = 0;
  private customers: Customer[] = [];
  // The load on the car, and its materials.
  private load: THREE.Group | null = null;
  private loadFor: Vehicle | null = null;
  private loadItems: THREE.Object3D[] = [];
  private mats: Record<string, THREE.Material> | null = null;
  private geos: Record<string, THREE.BufferGeometry> | null = null;
  private card: HTMLDivElement | null = null; private cardT = 0;
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly game: Game,
    private readonly markers: Markers,
    private readonly isFree: () => boolean,
    private readonly setBusy: (id: string | null) => void,
  ) {
    game.on('impact', (ev) => {
      const r = this.ride;
      if (!this.depot || !r || (ev.vehicle !== r && ev.other !== r) || ev.speed < 4 || this.hitCool > 0) return;
      this.hitCool = 0.5;
      this.bump(ev.speed);
    });
    game.on('booked', () => this.stop('The Harbor Patrol has signed for everything. The rush is over.'));
  }

  // ── Depots ─────────────────────────────────────────────────────────────────

  /** Both depots as points a car can stop at, worked out from the street graph the first time they are wanted. */
  private depotList(): Depot[] {
    if (this.depots) return this.depots;
    const plan = this.game.plan;
    // SpeedScan: the curb on the street south of the plaza, at the east end (the plaza's monument sign is at the west).
    const ss = this.curbNear(HQ.x + 22, HQ.z + 44, HQ.x + 22, HQ.z);
    // Pardon's: the loading annex on the back wall (store frame x 54..80, three roll-up doors), dock-high, facing
    // away from the avenue. A truck stands about 7 m off the doors; if a street runs close behind, its curb is used.
    const ax = PD.XE - 67, az = PD.ZF + PD.SD + 2.6 + 7;
    const ne = plan.nearestEdge(ax, az);
    const pd = ne.d < 14 ? this.curbNear(ax, az, ax, PD.ZF) : { x: ax, z: az };
    this.depots = [
      { id: 'speedscan', name: 'the SpeedScan HQ loading bay', short: 'SpeedScan', at: ss, letter: 'S', land: 0 },
      { id: 'pardons', name: 'the loading dock behind Pardon\'s', short: 'Pardon\'s', at: pd, letter: 'P', land: 1 },
    ];
    return this.depots;
  }

  /** The point in the curb lane of the street nearest (x, z), on the side toward (tx, tz). */
  private curbNear(x: number, z: number, tx: number, tz: number): Pt {
    const plan = this.game.plan, ne = plan.nearestEdge(x, z), q = edgeAt(plan.nodes, ne.edge, ne.s);
    const nx = -q.tz, nz = q.tx, side = (tx - q.x) * nx + (tz - q.z) * nz >= 0 ? 1 : -1, o = laneOff(ne.edge.hw);
    return { x: +(q.x + nx * side * o).toFixed(2), z: +(q.z + nz * side * o).toFixed(2) };
  }

  /** Is the mainland open to deliveries? */
  private mainlandOpen(): boolean { return progress.complete; }

  private depotOpen(d: Depot): boolean {
    return d.land === 0 || this.mainlandOpen() || this.game.player.z < -900;
  }

  // ── Radar and markers ──────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    if (this.depot) {
      for (const p of this.parcels) {
        if (p.state === 'aboard') out.push({ x: p.at.x, z: p.at.z, kind: 'goal' });
        else if (p.state === 'loose') out.push({ x: p.lx, z: p.lz, kind: 'goal', label: '!' });
      }
      return;
    }
    if (!this.isFree()) return;
    for (const d of this.depotList()) if (this.depotOpen(d)) out.push({ x: d.at.x, z: d.at.z, kind: 'job', label: d.letter });
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle;
    this.prompt = null;
    this.hitCool = Math.max(0, this.hitCool - dt);
    this.tickCustomers(dt);
    this.tickCard(dt);
    if (!this.depot) { this.target = null; this.syncLoad(null); if (this.isFree()) this.offer(v); return; }
    if (!(p.health > 0)) { this.finish('Shift over. Mercy General does not accept parcels.'); return; }
    this.clockT += dt;
    // Out of the car: a grace period, then the rush is off. Any car will do; the load moves with her.
    if (!v || capacity(v.spec.kind) === 0) {
      this.awayT += dt;
      this.syncLoad(null);
      this.pickUpLoose(p.x, p.z, 1.8);
      if (this.awayT > 25) { this.finish('Off the clock. The parcels have been left to fend for themselves.'); return; }
      this.timers(dt);
      g.hud.objective(this.parcels.some((q) => q.state === 'loose') ? 'Pick up the parcels in the road, then get back in a car.' : 'Get back in a car, or the rush is off.');
      this.marks();
      return;
    }
    this.awayT = 0;
    this.hold(v);
    this.syncLoad(v);
    this.pickUpLoose(v.x, v.z, v.hl + 1.8);
    if (this.timers(dt)) return;
    this.marks();
    // A drop: stopped at the ring.
    for (const q of this.parcels) {
      if (q.state === 'done' || q.state === 'returned') continue;
      if (Math.hypot(v.x - q.at.x, v.z - q.at.z) > 7.5 || Math.abs(v.speed) > 2.5) continue;
      if (q.state === 'loose') { g.hud.objective(`That parcel is lying in the road on ${g.plan.streetAt(q.lx, q.lz)}. Fetch it first.`); return; }
      this.deliver(q, v);
      break;
    }
    const left = this.parcels.filter((q) => q.state === 'aboard' || q.state === 'loose');
    if (!left.length) { this.finish(); return; }
    const t = this.nextDrop();
    if (t) {
      g.hud.objective(`${this.depot.short} rush: ${left.length} left. Next: ${t.addr}, ${t.item}.${this.combo > 1 ? ` Combo x${this.combo}.` : ''}`);
      g.hud.timer(t.left >= 0 ? 'Due in' : 'LATE by', clock(Math.abs(t.left)), t.left < 15);
    }
  }

  /** Count every parcel's clock down; return the late ones. True if the rush ended here. */
  private timers(dt: number): boolean {
    const g = this.game;
    for (const q of this.parcels) {
      if (q.state !== 'aboard' && q.state !== 'loose') continue;
      q.left -= dt;
      if (q.left < -RETURN_AFTER) {
        q.state = 'returned';
        if (q.mesh) { q.mesh.removeFromParent(); q.mesh = null; }
        this.combo = 0;
        g.hud.toast(`${q.addr}: returned to sender. The customer has moved on emotionally.`, 4);
      }
    }
    if (!this.parcels.some((q) => q.state === 'aboard' || q.state === 'loose')) { this.finish(); return true; }
    return false;
  }

  private marks(): void {
    const t = this.nextDrop();
    this.target = t ? (t.state === 'loose' ? { x: t.lx, z: t.lz } : t.at) : null;
    for (const q of this.parcels) {
      if (q.state === 'aboard') this.markers.put(q.at.x, q.at.z, q === t ? 'goal' : 'job', 5, q === t ? 26 : 16);
      else if (q.state === 'loose') this.markers.put(q.lx, q.lz, 'item', 2.2, 8);
    }
  }

  /** The parcel to show the way to: a loose one close by first, else the aboard one due soonest. */
  private nextDrop(): Parcel | null {
    const p = this.game.player;
    let best: Parcel | null = null, bk = Infinity;
    for (const q of this.parcels) {
      if (q.state === 'loose') { const d = Math.hypot(p.x - q.lx, p.z - q.lz); if (d < 80 && d - 1e4 < bk) { best = q; bk = d - 1e4; } }
      else if (q.state === 'aboard' && q.left < bk) { best = q; bk = q.left; }
    }
    return best;
  }

  /** Nothing running: offer a rush at a depot. */
  private offer(v: Vehicle | null): void {
    const g = this.game, p = g.player;
    if (!v || p.speed > 3 || p.heat > 0) return;
    const cap = capacity(v.spec.kind);
    if (!cap) return;
    for (const d of this.depotList()) {
      if (!this.depotOpen(d)) continue;
      const dd = Math.hypot(v.x - d.at.x, v.z - d.at.z);
      if (dd > 120) continue;
      this.markers.put(d.at.x, d.at.z, 'job', 6, 20);
      if (dd > 9) continue;
      this.prompt = d.id === 'speedscan' ? `[G] SpeedScan RUSH ORDER: load ${cap} boxes` : `[G] Pardon's delivery: strap on ${cap} loads`;
      if (g.input.eat('interact')) this.start(d.id);
      return;
    }
  }

  /** Start a rush from a depot (the prompt does this; so do the tests). The player must be in a car at the wheel. */
  start(id: DepotId): boolean {
    const g = this.game, p = g.player, v = p.vehicle;
    if (this.depot || !this.isFree() || !v) return false;
    const cap = capacity(v.spec.kind);
    const d = this.depotList().find((q) => q.id === id);
    if (!cap || !d) return false;
    const n = Math.max(3, Math.min(cap, 3 + Math.floor(Math.random() * (cap - 2))));
    const pts = this.pickDrops(d, n);
    if (pts.length < 2) { g.hud.toast('Nothing to deliver today. The depot has delivered itself somewhere.', 4); return false; }
    // Deadlines: each drop's clock is the road distance of a sensible route to it (nearest first), at a brisk pace.
    const plan = g.plan;
    let from: Pt = d.at, acc = 8;
    const order = pts.slice(), seq: Pt[] = [];
    while (order.length) {
      let bi = 0;
      for (let k = 1; k < order.length; k++) if (Math.hypot(order[k].x - from.x, order[k].z - from.z) < Math.hypot(order[bi].x - from.x, order[bi].z - from.z)) bi = k;
      seq.push(order.splice(bi, 1)[0]); from = seq[seq.length - 1];
    }
    from = d.at;
    const items = d.id === 'speedscan' ? SS_ITEMS : PD_ITEMS;
    this.parcels = seq.map((at, k) => {
      const ids = plan.findPath(plan.nearestNode(from.x, from.z).id, plan.nearestNode(at.x, at.z).id);
      let len = Math.hypot(at.x - from.x, at.z - from.z);
      if (ids.length > 1) { len = 0; for (let i = 1; i < ids.length; i++) len += Math.hypot(plan.nodes[ids[i]].x - plan.nodes[ids[i - 1]].x, plan.nodes[ids[i]].z - plan.nodes[ids[i - 1]].z); }
      acc += len / 10.5 + 12;
      from = at;
      const num = 3 + Math.floor(Math.random() * 196);
      return { at, addr: `${num} ${plan.streetAt(at.x, at.z)}`, item: items[(k + Math.floor(Math.random() * items.length)) % items.length], left: Math.round(acc), allot: Math.round(acc), far: Math.hypot(at.x - d.at.x, at.z - d.at.z), cond: 100, state: 'aboard' as const, lx: 0, lz: 0, mesh: null };
    });
    const k = taper(save.count('rush'));
    this.cashK = k.cash; this.ptsK = k.points;
    this.depot = d; this.clockT = 0; this.combo = 0; this.bestCombo = 0; this.paid = 0; this.points = 0; this.onTime = 0; this.awayT = 0;
    this.hold(v);
    this.setBusy('rush');
    this.closeCard();
    g.hud.stamp(d.id === 'speedscan' ? 'RUSH ORDER' : 'PARDON\'S DELIVERS', `${this.parcels.length} drops · any order · each on its own clock · mind the cargo`);
    return true;
  }

  /** n delivery points at the curb of open streets, 120 m or more from the depot and 60 m from each other. */
  private pickDrops(d: Depot, n: number): Pt[] {
    const plan = this.game.plan, lands = this.mainlandOpen() ? [0, 1] : [d.land];
    // The new mainland streets (plan.streets) replace the old grid's mainland edges; the island's come first in both lists.
    const sg = plan.streets, edges = (sg ?? plan).edges;
    const pool: RoadEdge[] = [];
    for (const e of edges) {
      if (e.closed || e.deck || e.len < 50 || !lands.includes(e.land)) continue;
      if (e.kind && /bridge|highway|freeway|ramp|interstate|thruway/i.test(String(e.kind))) continue;
      pool.push(e);
    }
    const out: Pt[] = [];
    // With both lands open, about a third of the stack goes across the water.
    const wantOther = lands.length > 1 ? Math.max(1, Math.round(n / 3)) : 0;
    let other = 0;
    for (let tries = 0; tries < 400 && out.length < n && pool.length; tries++) {
      const e = pool[Math.floor(Math.random() * pool.length)];
      const across = e.land !== d.land;
      if (across && other >= wantOther) continue;
      if (!across && out.length - other >= n - wantOther && other < wantOther) continue;
      const s = 22 + Math.random() * (e.len - 44), q = sg && e.id >= sg.isle.edges ? (() => { const c = sg.pointAt(e, s); return { x: c.x, z: c.z, tx: c.dx, tz: c.dz }; })() : edgeAt(plan.nodes, e, s), side = Math.random() < 0.5 ? -1 : 1, o = laneOff(e.hw);
      const x = q.x - q.tz * side * o, z = q.z + q.tx * side * o;
      const dd = Math.hypot(x - d.at.x, z - d.at.z);
      if (dd < 120 || (!across && dd > 900)) continue;
      if (isWater(x, z) || groundAt(x, z) < WATER_Y + 0.4) continue;
      if (out.some((o2) => Math.hypot(o2.x - x, o2.z - z) < 60)) continue;
      out.push({ x: +x.toFixed(2), z: +z.toFixed(2) });
      if (across) other++;
    }
    return out;
  }

  /** The car the rush is in: held while it runs (net/held.ts keeps it this player's in a shared town). */
  private hold(v: Vehicle | null): void {
    if (this.ride === v) return;
    if (this.ride) this.ride.held = false;
    this.ride = v;
    if (v) v.held = true;
  }

  // ── Drops, bumps, spills ───────────────────────────────────────────────────

  private deliver(q: Parcel, v: Vehicle): void {
    const g = this.game, d = this.depot as Depot, hud = g.hud;
    const late = q.left < 0;
    q.state = 'done';
    if (late) this.combo = 0; else { this.combo++; this.onTime++; this.bestCombo = Math.max(this.bestCombo, this.combo); }
    const base = (d.id === 'pardons' ? 40 : 30) + q.far * 0.05;
    const bonus = late ? 0 : base * 0.6 * Math.max(0, q.left / q.allot);
    const dmg = 0.35 + 0.65 * q.cond / 100;
    const mult = late ? 0.5 : 1 + 0.2 * Math.min(5, this.combo - 1);
    const cash = Math.round((base + bonus) * dmg * mult * this.cashK), pts = Math.round(9 * this.ptsK);
    const pl = g.player;
    pl.money += cash; save.credit(cash); save.data.stats.earned += cash; save.data.stats.parcels++;
    progress.add(pts);
    this.paid += cash; this.points += pts;
    const bits = [`${money(cash)}`];
    if (!late && bonus >= 1) bits.push(`speed +${money(bonus * dmg * this.cashK)}`);
    if (q.cond < 95) bits.push(`cargo ${Math.round(q.cond)}%`);
    if (this.combo > 1) bits.push(`combo x${this.combo}`);
    if (late) bits.push('late, half pay');
    hud.toast(`Signed for at ${q.addr}. ${bits.join(' · ')}`, 4.5);
    g.emit('moment', { kind: 'delivery' });
    const pool = late ? LATE_LINES : q.cond < 60 ? SCUFF_LINES : d.id === 'speedscan' ? SS_LINES : PD_LINES;
    hud.subtitle('CUSTOMER', pool[this.lines++ % pool.length], 4.5);
    this.customer(q.at, v);
  }

  /** A knock: everything aboard is scuffed; a big one throws parcels into the road. */
  private bump(speed: number): void {
    const g = this.game, r = this.ride;
    const aboard = this.parcels.filter((q) => q.state === 'aboard');
    for (const q of aboard) q.cond = Math.max(0, q.cond - (speed - 3) * 2.4);
    if (speed < SPILL_SPEED || !r || !aboard.length) return;
    const n = Math.min(aboard.length, speed > 18 ? 2 : 1);
    for (let k = 0; k < n; k++) {
      const q = aboard[aboard.length - 1 - k], a = Math.random() * Math.PI * 2, rr = r.hl + 2 + Math.random() * 3;
      q.state = 'loose'; q.cond = Math.max(0, q.cond - 12);
      q.lx = r.x + Math.cos(a) * rr; q.lz = r.z + Math.sin(a) * rr;
      if (isWater(q.lx, q.lz)) { q.lx = r.x; q.lz = r.z; }
      q.mesh = this.looseMesh(q.lx, q.lz);
    }
    this.combo = 0;
    g.hud.toast(n > 1 ? 'Two parcels have left the vehicle. They are in the road now. Fetch them.' : 'A parcel has left the vehicle. It is in the road. Fetch it.', 4);
  }

  private pickUpLoose(x: number, z: number, reach: number): void {
    for (const q of this.parcels) {
      if (q.state !== 'loose' || Math.hypot(x - q.lx, z - q.lz) > reach) continue;
      q.state = 'aboard';
      if (q.mesh) { q.mesh.removeFromParent(); q.mesh = null; }
      this.game.hud.toast('Parcel back aboard. Slightly flatter.', 2.5);
    }
  }

  // ── The customer at the door ───────────────────────────────────────────────

  private customer(at: Pt, v: Vehicle): void {
    const g = this.game;
    // From the sidewalk side (away from the street's middle, i.e. away from the car's other side) to beside the car.
    const ne = g.plan.nearestEdge(at.x, at.z), q = edgeAt(g.plan.nodes, ne.edge, ne.s);
    let ox = at.x - q.x, oz = at.z - q.z;
    const L = Math.hypot(ox, oz) || 1; ox /= L; oz /= L;
    const back = Math.max(v.hw + 2.5, ne.edge.hw + 1.2 - ne.d);
    const from = { x: v.x + ox * back, z: v.z + oz * back }, to = { x: v.x + ox * (v.hw + 0.9), z: v.z + oz * (v.hw + 0.9) };
    if (this.customers.length > 2) { const c = this.customers.shift() as Customer; g.people.remove(c.p); }
    const p = g.people.spawn(from.x, from.z, Math.atan2(to.x - from.x, to.z - from.z));
    p.pose = 'walk'; p.speed = 1.4;
    this.customers.push({ p, t: 0, from, to });
  }

  private tickCustomers(dt: number): void {
    const g = this.game;
    for (let i = this.customers.length - 1; i >= 0; i--) {
      const c = this.customers[i], p = c.p;
      c.t += dt;
      // 0..2.6 s walk out, 2.6..5 s stand and sign, 5..7.6 s walk back, then gone.
      let f: number;
      if (c.t < 2.6) { f = c.t / 2.6; p.pose = 'walk'; p.speed = 1.4; p.h = Math.atan2(c.to.x - c.from.x, c.to.z - c.from.z); }
      else if (c.t < 5) { f = 1; p.pose = 'stand'; p.speed = 0; }
      else if (c.t < 7.6) { f = 1 - (c.t - 5) / 2.6; p.pose = 'walk'; p.speed = 1.4; p.h = Math.atan2(c.from.x - c.to.x, c.from.z - c.to.z); }
      else { g.people.remove(p); this.customers.splice(i, 1); continue; }
      p.x = c.from.x + (c.to.x - c.from.x) * f; p.z = c.from.z + (c.to.z - c.from.z) * f;
      p.y = groundAt(p.x, p.z);
    }
  }

  // ── The end of the rush ────────────────────────────────────────────────────

  /** End the rush with no card (booked, a new game). */
  stop(why?: string): void {
    if (!this.depot) return;
    this.finish(why, false);
  }

  private finish(why?: string, card = true): void {
    const g = this.game, d = this.depot;
    if (!d) return;
    const done = this.parcels.filter((q) => q.state === 'done').length, total = this.parcels.length;
    const conds = this.parcels.filter((q) => q.state === 'done').map((q) => q.cond);
    const cond = conds.length ? Math.round(conds.reduce((a, b) => a + b, 0) / conds.length) : 0;
    for (const q of this.parcels) if (q.mesh) { q.mesh.removeFromParent(); q.mesh = null; }
    if (done) save.bump('rush');
    // A clean sweep, everything on time, earns a little extra.
    let sweep = 0;
    if (done === total && this.onTime === total) {
      sweep = Math.round((40 + 15 * total) * this.cashK);
      g.player.money += sweep; save.credit(sweep); save.data.stats.earned += sweep; this.paid += sweep;
    }
    const record = done > 0 && save.record('rush', this.paid, false);
    const time = this.clockT, combo = this.bestCombo, onTime = this.onTime, paid = this.paid, pts = this.points;
    this.parcels = []; this.depot = null; this.target = null; this.combo = 0;
    this.hold(null);
    this.syncLoad(null);
    g.hud.objective(null); g.hud.timer(null);
    if (why) g.hud.toast(why, 5);
    this.setBusy(null);
    if (!card) return;
    this.showCard(d, [
      ['Parcels delivered', `${done} of ${total}`], ['On time', String(onTime)], ['Best combo', combo > 1 ? `x${combo}` : '—'],
      ['Cargo condition', done ? `${cond}%` : '—'], ['Shift time', clock(time)], ...(sweep ? [['Clean sweep', `+${money(sweep)}`] as [string, string]] : []),
      ['Paid', `${money(paid)} · ${pts} toward the bridge`], ['Best rush', `${money(save.data.best.rush ?? paid)}${record ? ' · NEW' : ''}`],
    ], done === total && onTime === total ? 'ALL ON TIME' : done === total ? 'ALL DELIVERED' : done ? 'SHIFT OVER' : 'NOTHING SIGNED FOR');
  }

  private showCard(d: Depot, rows: [string, string][], title: string): void {
    this.closeCard();
    const el = document.createElement('div');
    el.className = 'rush-card';
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;width:min(30em,92vw);max-height:86vh;overflow:auto;box-sizing:border-box;'
      + 'padding:1em 1.3em 1.1em;background:var(--bone,#f2e8cf);color:var(--ink,#14213d);font:500 clamp(11px,1.5vw,15px)/1.3 var(--f-body,system-ui),sans-serif;'
      + 'box-shadow:0 0.6em 2.4em rgba(20,33,61,0.45);border-top:0.45em solid ' + (d.id === 'speedscan' ? '#7ccf2a' : 'var(--vermilion,#e4572e)') + ';cursor:pointer;pointer-events:auto;';
    const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    el.innerHTML = `<div style="display:flex;justify-content:space-between;font:600 0.8em var(--f-mono,monospace);letter-spacing:0.08em;text-transform:uppercase;opacity:0.7">`
      + `<span>${d.id === 'speedscan' ? 'SpeedScan · rush order manifest' : 'Pardon\'s Surplus &amp; Salvage · delivery slip'}</span><span>Delivery Rush</span></div>`
      + `<div style="font:900 3.1em/0.95 var(--f-head,'Arial Narrow'),sans-serif;letter-spacing:0.02em;margin:0.2em 0 0.35em">${esc(title)}</div>`
      + rows.map(([a, b]) => `<div style="display:flex;justify-content:space-between;gap:1em;padding:0.32em 0;border-top:1px solid rgba(20,33,61,0.25)"><span style="opacity:0.72">${esc(a)}</span><b style="font:600 1.05em var(--f-mono,monospace);text-align:right">${esc(b)}</b></div>`).join('')
      + `<div style="margin-top:0.6em;font-size:0.82em;opacity:0.6">Tap or press G to close.</div>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closeCard(); });
    document.body.appendChild(el);
    this.card = el; this.cardT = 12;
  }

  private tickCard(dt: number): void {
    if (!this.card) return;
    this.cardT -= dt;
    if (this.cardT <= 0 || (this.cardT < 11.5 && this.game.input.eat('interact'))) this.closeCard();
  }

  private closeCard(): void { if (this.card) { this.card.remove(); this.card = null; } }

  // ── The load on the car ────────────────────────────────────────────────────

  private kit(): { m: Record<string, THREE.Material>; g: Record<string, THREE.BufferGeometry> } {
    if (this.mats && this.geos) return { m: this.mats, g: this.geos };
    const tex = (w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): THREE.CanvasTexture => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      draw(c.getContext('2d') as CanvasRenderingContext2D);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
    };
    // The SpeedScan box: kraft board, the lime wordmark, a red RUSH ORDER stamp, the stink lines.
    const ssTex = tex(256, 128, (x) => {
      x.fillStyle = '#b98d5a'; x.fillRect(0, 0, 256, 128);
      for (let i = 0; i < 600; i++) { x.fillStyle = `rgba(80,50,20,${Math.random() * 0.08})`; x.fillRect(Math.random() * 256, Math.random() * 128, 2, 1); }
      x.fillStyle = 'rgba(60,40,20,0.35)'; x.fillRect(118, 0, 20, 128);
      x.strokeStyle = '#6fd12b'; x.lineWidth = 3;
      for (let k = 0; k < 3; k++) { x.beginPath(); for (let i = 0; i <= 20; i++) { const yy = 10 + i * 1.6, xx = 22 + k * 9 + Math.sin(i * 0.8 + k) * 3; if (i) x.lineTo(xx, yy); else x.moveTo(xx, yy); } x.stroke(); }
      x.fillStyle = '#14213d'; x.font = 'bold 30px Arial, sans-serif'; x.fillText('Speed', 52, 48); x.fillStyle = '#4cae1c'; x.fillText('Scan', 136, 48);
      x.save(); x.translate(128, 92); x.rotate(-0.08);
      x.strokeStyle = '#d2342a'; x.lineWidth = 4; x.strokeRect(-92, -20, 184, 38);
      x.fillStyle = '#d2342a'; x.font = 'bold 26px Arial, sans-serif'; x.textAlign = 'center'; x.fillText('RUSH ORDER', 0, 9); x.restore();
    });
    const mattTex = tex(128, 128, (x) => {
      x.fillStyle = '#f4f1ea'; x.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 128; i += 16) { x.fillStyle = '#9fb7d4'; x.fillRect(i, 0, 5, 128); }
      x.fillStyle = 'rgba(0,0,0,0.06)'; for (let i = 8; i < 128; i += 16) for (let j = 8; j < 128; j += 16) x.fillRect(i - 1, j - 1, 3, 3);
    });
    const m: Record<string, THREE.Material> = {
      ss: new THREE.MeshStandardMaterial({ map: ssTex, roughness: 0.92 }),
      kraft: new THREE.MeshStandardMaterial({ color: 0xb98d5a, roughness: 0.95 }),
      matt: new THREE.MeshStandardMaterial({ map: mattTex, roughness: 0.85 }),
      alu: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.35, metalness: 0.8 }),
      web: new THREE.MeshStandardMaterial({ color: 0x2f8f5b, roughness: 0.7 }),
      chair: new THREE.MeshStandardMaterial({ color: 0x8a4f3a, roughness: 0.8 }),
      strap: new THREE.MeshStandardMaterial({ color: 0xe0a21b, roughness: 0.6 }),
    };
    const g: Record<string, THREE.BufferGeometry> = { box: new THREE.BoxGeometry(1, 1, 1) };
    this.mats = m; this.geos = g;
    return { m, g };
  }

  private part(parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const me = new THREE.Mesh((this.geos as Record<string, THREE.BufferGeometry>).box, mat);
    me.scale.set(sx, sy, sz); me.position.set(x, y, z); me.rotation.set(rx, ry, rz);
    me.castShadow = true;
    parent.add(me);
    return me;
  }

  /** One load item as a group, its origin on the bottom middle. */
  private item(kind: 'ss' | 'mattress' | 'lawn' | 'armchair'): THREE.Group {
    const { m } = this.kit(), grp = new THREE.Group();
    if (kind === 'ss') {
      // The label is on the four sides; the top is plain board, taped.
      const me = new THREE.Mesh((this.geos as Record<string, THREE.BufferGeometry>).box, [m.ss, m.ss, m.kraft, m.kraft, m.ss, m.ss]);
      me.scale.set(0.62, 0.42, 0.5); me.position.y = 0.21; me.castShadow = true; grp.add(me);
    } else if (kind === 'mattress') {
      this.part(grp, m.matt, 1.62, 0.24, 2.15, 0, 0.12, 0);
      this.part(grp, m.strap, 1.7, 0.03, 0.06, 0, 0.245, 0.5);
      this.part(grp, m.strap, 1.7, 0.03, 0.06, 0, 0.245, -0.5);
    } else if (kind === 'lawn') {
      // A folding lawn chair, open, tipped back so its legs stick up and out.
      const c = new THREE.Group(); c.rotation.x = -1.0; grp.add(c);
      this.part(c, m.alu, 0.05, 0.05, 0.6, -0.27, 0.05, 0); this.part(c, m.alu, 0.05, 0.05, 0.6, 0.27, 0.05, 0);
      this.part(c, m.web, 0.52, 0.02, 0.55, 0, 0.07, 0);
      this.part(c, m.alu, 0.05, 0.7, 0.05, -0.27, 0.38, -0.3); this.part(c, m.alu, 0.05, 0.7, 0.05, 0.27, 0.38, -0.3);
      this.part(c, m.web, 0.52, 0.6, 0.02, 0, 0.42, -0.3);
      this.part(c, m.alu, 0.05, 0.45, 0.05, -0.27, -0.18, 0.28); this.part(c, m.alu, 0.05, 0.45, 0.05, 0.27, -0.18, 0.28);
      c.position.y = 0.42;
    } else {
      this.part(grp, m.chair, 0.86, 0.42, 0.8, 0, 0.21, 0);
      this.part(grp, m.chair, 0.86, 0.62, 0.2, 0, 0.62, -0.32, -0.15);
      this.part(grp, m.chair, 0.16, 0.3, 0.8, -0.38, 0.55, 0); this.part(grp, m.chair, 0.16, 0.3, 0.8, 0.38, 0.55, 0);
    }
    return grp;
  }

  /** Build the load for this car and this depot: where each parcel rides. Item k shows while k parcels or more are aboard. */
  private buildLoad(v: Vehicle, d: Depot): void {
    if (this.load) { this.load.removeFromParent(); }
    const grp = new THREE.Group(), sp = v.spec, H = sp.height, L = sp.length, k = sp.kind;
    const bed = k === 'pickup' || k === 'tow';
    const items: THREE.Object3D[] = [];
    const n = this.parcels.length;
    for (let i = 0; i < n; i++) {
      let it: THREE.Group;
      if (d.id === 'speedscan') {
        it = this.item('ss');
        if (bed) it.position.set((i % 2 ? 0.36 : -0.36), 0.95 + Math.floor(i / 4) * 0.42, -L * 0.28 - (Math.floor(i / 2) % 2) * 0.55);
        else it.position.set((i % 2 ? 0.34 : -0.34), H + 0.05 + Math.floor(i / 2) * 0.42, -0.1 - (Math.floor(i / 2) % 2) * 0.1);
        it.rotation.y = (i * 0.37) % 0.3 - 0.15;
      } else {
        // Pardon's: the first parcel is the mattress on top of everything; then lawn chairs and an armchair.
        const kind = i === 0 ? 'mattress' : i === 3 ? 'armchair' : 'lawn';
        it = this.item(kind);
        // On a car the mattress lies on the roof; on a pickup it lies across the bed rails and hangs out past the tailgate.
        if (kind === 'mattress') it.position.set(0, bed ? 1.22 : H - 0.04, bed ? -L * 0.36 : 0.05);
        else if (kind === 'armchair') { it.position.set(0, bed ? 1.46 : H + 0.2, bed ? -L * 0.33 : -0.1); it.rotation.y = Math.PI; }
        else {
          const s = i % 2 ? 1 : -1;
          // Lawn chairs: off the back, legs out past the tailgate (or the boot lid), and one sideways out of the window.
          if (bed || i < 3) { it.position.set(s * 0.45, bed ? (n > 0 ? 1.5 : 1.0) : H * 0.62, -L * 0.5 + (bed ? 0.25 : 0.1)); it.rotation.y = Math.PI + s * 0.25; }
          else { it.position.set(s * (sp.width * 0.5 + 0.1), H * 0.7, -0.2); it.rotation.set(0, s * Math.PI / 2, s * 0.3); }
        }
      }
      grp.add(it);
      items.push(it);
    }
    // Rush order: the last item added goes first, so the stack shrinks from the top.
    this.loadItems = items.reverse();
    this.game.scene.add(grp);
    this.load = grp; this.loadFor = v;
  }

  /** Keep the load on the car (or take it off). */
  private syncLoad(v: Vehicle | null): void {
    const d = this.depot;
    if (!v || !d) { if (this.load) this.load.visible = false; if (!d && this.load) { this.load.removeFromParent(); this.load = null; this.loadFor = null; } return; }
    if (this.loadFor !== v || !this.load) this.buildLoad(v, d);
    const grp = this.load as THREE.Group;
    grp.visible = true;
    const aboard = this.parcels.filter((q) => q.state === 'aboard').length;
    // The items still showing are the first `aboard` of the list in load order (the top ones go first).
    const its = this.loadItems, nShow = aboard;
    for (let i = 0; i < its.length; i++) its[i].visible = i >= its.length - nShow;
    this.e.set(-v.pitch, v.h, v.roll);
    grp.quaternion.setFromEuler(this.e);
    grp.position.set(v.x, v.y, v.z);
  }

  private looseMesh(x: number, z: number): THREE.Object3D {
    const d = this.depot, it = this.item(d && d.id === 'pardons' ? 'lawn' : 'ss');
    it.position.set(x, groundAt(x, z) + 0.02, z);
    it.rotation.y = Math.random() * 6.28;
    this.game.scene.add(it);
    return it;
  }

  /** For the tests and the lead: the rush in hand. */
  info(): { depot: string | null; parcels: { x: number; z: number; addr: string; left: number; cond: number; state: string }[]; combo: number; paid: number; depots: { id: string; x: number; z: number }[] } {
    return {
      depot: this.depot?.id ?? null, combo: this.combo, paid: this.paid,
      parcels: this.parcels.map((q) => ({ x: q.state === 'loose' ? q.lx : q.at.x, z: q.state === 'loose' ? q.lz : q.at.z, addr: q.addr, left: +q.left.toFixed(1), cond: Math.round(q.cond), state: q.state })),
      depots: this.depotList().map((d) => ({ id: d.id, x: d.at.x, z: d.at.z })),
    };
  }
}
