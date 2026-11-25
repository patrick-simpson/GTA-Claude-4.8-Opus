// Fast travel: the Calamity Courtesy Cab (owner, Nov 24: "Add fast travel. Prioritize it.").
//
// From the big map's Places panel (ui/places.ts): any place in the directory, any landmark, a map marker, a waypoint
// or one of the hub stops gets a "Travel there" button. The cab books the transfer on Form FT-1: a short fade, a
// paperwork card, a hold of about a second under black while the destination is warmed (the town is one scene, so
// "streamed" is a matter of the GPU having seen the view: geometry and textures upload on their first draw, and the
// shader scan (core/warmup.ts) is asked to run at once), then the fade back in at the business's door. A driver's car
// comes too, put on the nearest lane of the nearest open street facing along it; a passenger in it goes with it (the
// driver's car is the authority, net/ride.ts), and on foot she arrives on foot.
//
// Rules (all shown on the button): no cab for the wanted (heat above 0), during a mission, job or race (todo.busy),
// from the water, in the air, mid-ragdoll, as a passenger, in a boat or on the train, to a street the bridge stage has
// not opened, or to where she already is. The fare is $5 and $1 for every 100 m, capped at $60; kid mode rides free.
//
// Other screens: her person and car simply jump (net/remote.ts already takes a far move at once), and PlayerEvent.Cab
// (22) makes the taxi-drop puff where they vanished and where they appear.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { ThingsToDo } from './index';
import type { Place } from '../world/business';
import { groundAt, isWater, type RoadEdge } from '../world/plan';
import { MAIN_SPLIT_Z } from '../world/mainland';
import { railOff } from '../sim/streetTraffic';
import { isBoatKind } from '../ent/vehicleSpecs';
import { trains } from '../world/train';
import { kid } from '../core/kid';
import { money } from '../core/util';
import { CabCard } from '../ui/travel';

/** Where to go: a place's door and which way the front faces (nx, nz both 0: no front). */
export interface Dest { name: string; x: number; z: number; nx: number; nz: number; }

export const FARE_BASE = 5;
export const FARE_PER_100M = 1;
export const FARE_CAP = 60;
/** Closer than this, the cab does not bother. */
export const TOO_NEAR = 25;
/** Seconds: the fade out, the least held under black, the most held, the fade in. */
const OUT = 0.4, HOLD_MIN = 0.85, HOLD_MAX = 3, IN = 0.45;
/** Game ticks under black before the fade in (frames drawn at the destination, so its buffers and textures are uploaded). */
const HOLD_FRAMES = 10;
/** A frame this quick (ms), this many in a row, with no shader compile in flight, ends the hold. */
const CALM_MS = 34, CALM_TICKS = 8;
const KEY = 'pc-cab-recent';

/** The hub stops, in the cab company's order. Doors are resolved at the destination like any other. */
export function hubs(game: Game): Dest[] {
  const plan = game.plan;
  const land = plan.sidewalkPoint(5, 6, 2, 0.45);
  const down = plan.sidewalkPoint(5, 4, 2, 0.5);
  const D = (name: string, x: number, z: number, nx = 0, nz = 0): Dest => ({ name, x, z, nx, nz });
  return [
    D('The Island Landing, Strand Blvd', land.x, land.z, 0, 1),
    D('Downtown Port Calamity, Ledger District', down.x, down.z, 0, 1),
    D('Tepid Falls Depot (Trains, In Principle)', 170, -2124.5, 0, 1),
    D('Quorum Square', 131, -1808, 0, 1),
    D('Dithers College', -380.8, -2256.1, 0, 1),
    D("Pardon's Surplus & Salvage", -612, -1160, 0, 1),
    D('SpeedScan Headquarters', 3, -1700, 0, 1),
    D('The Stunt Park, Flounder Field', -540, -108, 0, 1),
  ];
}

export const asDest = (p: Place): Dest => ({ name: p.name, x: p.x, z: p.z, nx: p.nx, nz: p.nz });

export interface Status { ok: boolean; fare: number; why: string }

interface Arrival { foot: { x: number; z: number; h: number }; car: { x: number; z: number; h: number; edge: number; off: number } | null }

const sq = (n: number): number => n * n;

export class Cab {
  /** The transfer in hand: phase 1 fading out, 2 held under black, 3 fading back in; 0 none. */
  phase = 0;
  private t = 0;
  private ticks = 0;
  private dest: Dest | null = null;
  private from = '';
  private fare = 0;
  private moved = false;
  private cabAt = 0;
  /** Real time of the last tick under black, and how many in a row were quick with no compile in flight. */
  private lastNow = 0;
  private calm = 0;
  readonly card: CabCard;
  /** For the tests: the last arrival, and what happened. */
  last: (Arrival & { dest: string; fare: number; held: number; ok: boolean }) | null = null;
  readonly stats = { rides: 0, paid: 0, refused: 0 };
  /** For the tests (and the menu): the kid switch, and the hub stops, without importing modules by URL. */
  readonly kid = kid;
  hubs(): Dest[] { return hubs(this.game); }
  /** The ground and the water under her feet, from the world's own functions: for the tests. */
  ground(x: number, z: number): { gy: number; water: boolean } { return { gy: groundAt(x, z), water: isWater(x, z) }; }
  recent: Dest[] = [];

  constructor(private readonly game: Game, private readonly todo: ThingsToDo) {
    this.card = new CabCard();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      if (Array.isArray(raw)) this.recent = raw.filter((d) => d && typeof d.name === 'string' && Number.isFinite(d.x) && Number.isFinite(d.z)).slice(0, 3).map((d) => ({ name: String(d.name).slice(0, 80), x: +d.x, z: +d.z, nx: +d.nx || 0, nz: +d.nz || 0 }));
    } catch { /* no storage */ }
  }

  get active(): boolean { return this.phase !== 0; }

  fareTo(d: Dest): number {
    if (kid.on) return 0;
    const p = this.game.player;
    return Math.min(FARE_CAP, FARE_BASE + Math.floor((Math.hypot(d.x - p.x, d.z - p.z) * FARE_PER_100M) / 100));
  }

  /** The street nearest the destination, on the island (the old grid) or the mainland (plan.streets); closed ones do not count. */
  open(d: Dest): boolean {
    const plan = this.game.plan;
    if (d.z < MAIN_SPLIT_Z) {
      const G = plan.streets;
      if (!G) {
        const e = plan.nearestEdge(d.x, d.z).edge;
        return !e.closed;
      }
      const ne = G.nearestEdge(d.x, d.z, (e) => !e.deck);
      return !ne.edge.closed;
    }
    return !plan.nearestEdge(d.x, d.z).edge.closed;
  }

  /** Whether she can take the cab to d right now, what it would cost, and, if not, the reason (it is the button's label). */
  status(d: Dest): Status {
    const g = this.game, p = g.player, fare = this.fareTo(d);
    const no = (why: string): Status => ({ ok: false, fare, why });
    if (this.active) return no('A transfer is already in progress.');
    if (g.state !== 'play' && g.state !== 'paused') return no('Not now.');
    if (!(p.health > 0)) return no('The cab company does not serve the deceased.');
    if (p.heat > 0) return no('The cab company does not serve fugitives.');
    if (this.todo.busy !== null) return no('Not during a mission, job or race. Finish or abandon it first.');
    if (p.riding) return no('You are a passenger: ask your driver.');
    if (p.swimming || p.veil > 0) return no('The cab will not pick up from the water.');
    if (g.people.rag?.flying(p.person)) return no('The cab will not take anybody mid-ragdoll.');
    const v = p.vehicle;
    if (v) {
      if (isBoatKind(v.spec.kind) || trains.cur?.isCab(v)) return no('The cab does not take boats or trains.');
      if (v.sunk || v.wreck || (!v.onGround && v.airTime > 0.25)) return no('The cab will not take you from the air.');
      if (v.lent || v.held) return no('That car is on loan for a job: the cab will not take it.');
    } else if (p.person.pose === 'jump' || p.person.pose === 'fall' || p.person.y - groundAt(p.x, p.z) > 0.8) return no('The cab will not take you from the air.');
    if (Math.hypot(d.x - p.x, d.z - p.z) < TOO_NEAR) return no('You are already there.');
    if (!this.open(d)) return no('No road there yet: the cab company has not been told it opened.');
    if (fare > p.money) return no(`Fare ${money(fare)}: you have ${money(p.money)}.`);
    return { ok: true, fare, why: '' };
  }

  /** Button label for d: the fare, free, or why not. */
  label(d: Dest): { text: string; ok: boolean } {
    const s = this.status(d);
    if (!s.ok) return { text: s.why, ok: false };
    return { text: s.fare === 0 ? 'Travel there, free' : `Travel there, ${money(s.fare)}`, ok: true };
  }

  /** Book the transfer. Returns the refusal, or '' when the cab is on its way. A paused game is resumed first. */
  go(d: Dest): string {
    const s = this.status(d);
    if (!s.ok) { this.stats.refused++; this.game.hud.toast(s.why, 5); return s.why; }
    const g = this.game;
    this.dest = d; this.fare = s.fare; this.from = g.plan.placeName(g.player.x, g.player.z) + ', ' + g.plan.streetAt(g.player.x, g.player.z);
    this.phase = 1; this.t = 0; this.ticks = 0; this.moved = false; this.cabAt = 0; this.calm = 0; this.lastNow = 0;
    g.input.setEnabled(false);
    if (g.state === 'paused') { g.setPaused(false); if (!g.input.touch) g.input.lock(); g.input.setEnabled(false); }
    this.card.open(this.from, d.name, s.fare);
    this.puff(g.player.x, g.player.y, g.player.z);
    g.net.cab(0);
    return '';
  }

  /** The nearest safe spot on foot: the door itself, else the nearest clear ground. Null when there is none within 30 m. */
  private footSpot(d: Dest): { x: number; z: number; h: number } | null {
    const g = this.game, col = g.col;
    const clear = (x: number, z: number): boolean => {
      const gy = groundAt(x, z);
      if (isWater(x, z) || col.pointBlocked(x, z, gy + 0.9)) return false;
      const q = { x, z };
      col.resolveCircle(q, 0.45, gy + 0.5);
      if (sq(q.x - x) + sq(q.z - z) > 0.0225) return false;
      q.x = x; q.z = z;
      return !g.vehicles.resolveCircle(q, 0.45, gy) && sq(q.x - x) + sq(q.z - z) < 0.0225;
    };
    const face = (x: number, z: number): number => (d.nx || d.nz ? Math.atan2(-d.nx, -d.nz) : Math.atan2(d.x - x, d.z - z) || 0);
    if (clear(d.x, d.z)) return { x: d.x, z: d.z, h: face(d.x, d.z) };
    for (let r = 1.5; r <= 30; r += 1.5) {
      const n = Math.max(8, Math.round(r * 3));
      let best: { x: number; z: number; h: number } | null = null, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, x = d.x + Math.sin(a) * r, z = d.z + Math.cos(a) * r;
        // The side the front faces is the street's.
        const dd = r + (d.nx || d.nz ? 0.5 * (1 - (Math.sin(a) * d.nx + Math.cos(a) * d.nz)) : 0);
        if (dd < bd && clear(x, z)) { bd = dd; best = { x, z, h: face(x, z) }; }
      }
      if (best) return best;
    }
    return null;
  }

  /** A lane of the nearest open street to the destination, facing along it, clear of other cars and of junctions. */
  private lanePose(d: Dest): Arrival['car'] {
    const g = this.game, plan = g.plan, G = plan.streets;
    const list = g.vehicles.list;
    let edge: RoadEdge, s: number, px: number, pz: number, tx: number, tz: number, len: number, off = 0, dirSign = 1;
    const at = (e: RoadEdge, ss: number): { x: number; z: number; dx: number; dz: number } => {
      if (G && d.z < MAIN_SPLIT_Z) return G.pointAt(e, ss);
      const A = plan.nodes[e.a];
      return e.horiz ? { x: A.x + ss, z: A.z, dx: 1, dz: 0 } : { x: A.x, z: A.z + ss, dx: 0, dz: 1 };
    };
    if (G && d.z < MAIN_SPLIT_Z) {
      const ne = G.nearestEdge(d.x, d.z, (e) => !e.deck && !e.closed);
      edge = ne.edge; s = G.project(edge, d.x, d.z).s;
    } else {
      const ne = plan.nearestEdge(d.x, d.z);
      edge = ne.edge; s = ne.s;
    }
    if (edge.closed) return null;
    len = edge.len;
    const p0 = at(edge, s);
    // Which side of the street the door is on decides the direction of travel and so the lane (right-hand traffic).
    const side = (d.x - p0.x) * -p0.dz + (d.z - p0.z) * p0.dx;
    dirSign = edge.oneWay ? 1 : side >= 0 ? 1 : -1;
    const lateral = Math.abs(side);
    const grid = !(G && d.z < MAIN_SPLIT_Z);
    const lanes = Math.max(1, edge.lanes);
    let lane = 0;
    if (!grid) { for (let l = 1; l < lanes; l++) if (Math.abs(lateral - railOff(edge, l)) < Math.abs(lateral - railOff(edge, lane))) lane = l; off = railOff(edge, lane); }
    else { const lo = (l: number): number => (edge.lanes === 2 ? (l === 0 ? 1.8 : 5.2) : 1.75); for (let l = 1; l < lanes; l++) if (Math.abs(lateral - lo(l)) < Math.abs(lateral - lo(lane))) lane = l; off = lo(lane); }
    const margin = len > 44 ? 16 : len / 2;
    const tries = [0, 7, -7, 14, -14, 21, -21, 28, -28];
    for (const dt of tries) {
      const ss = Math.max(margin, Math.min(len - margin, s + dt));
      const p = at(edge, ss);
      tx = p.dx * dirSign; tz = p.dz * dirSign;
      px = p.x - tz * off; pz = p.z + tx * off;
      let free = true;
      for (const v of list) if (v !== g.player.vehicle && sq(v.x - px) + sq(v.z - pz) < 36) { free = false; break; }
      if (free && !g.col.pointBlocked(px, pz, groundAt(px, pz) + 0.6) && !isWater(px, pz)) return { x: px, z: pz, h: Math.atan2(tx, tz), edge: edge.id, off };
    }
    return null;
  }

  /** Where she will stand, and her car: what the move will do. Exposed for the tests. */
  arrival(d: Dest): Arrival | null {
    const foot = this.footSpot(d);
    const car = this.game.player.vehicle ? this.lanePose(d) : null;
    if (!foot && !car) return null;
    return { foot: foot ?? { x: car!.x, z: car!.z, h: car!.h }, car };
  }

  private puff(x: number, y: number, z: number): void {
    const e = this.game.fx.emitters;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, s = 1.4 + Math.random() * 1.6;
      e.dust(x + Math.sin(a) * 0.8, y + 0.2, z + Math.cos(a) * 0.8, Math.sin(a) * s, Math.cos(a) * s, 0.7, false);
    }
    e.sparks(x, y + 1, z, 0, 1, 0, 8, 4);
  }

  /** The move itself, under black: the fare, the person and the car. */
  private move(): void {
    const g = this.game, p = g.player, d = this.dest as Dest;
    const a = this.arrival(d);
    if (!a) { this.last = { foot: { x: p.x, z: p.z, h: p.h }, car: null, dest: d.name, fare: 0, held: 0, ok: false }; g.hud.toast('The cab could not find a safe kerb there. No charge.', 5); return; }
    p.money -= this.fare;
    this.stats.rides++; this.stats.paid += this.fare;
    const v = p.vehicle;
    if (v && a.car) {
      v.x = a.car.x; v.z = a.car.z; v.h = a.car.h;
      (g.vehicles as unknown as { park(c: Vehicle): void }).park(v);
      g.cam.snap();
    } else {
      if (v) p.exit();
      p.teleport(a.foot.x, a.foot.z, a.foot.h);
      g.cam.yaw = a.foot.h;
      g.cam.snap();
    }
    // Her waypoint, if it was this place, is done with.
    const todo = this.todo;
    if (todo.waypoint && Math.hypot(todo.waypoint.x - d.x, todo.waypoint.z - d.z) < 40) todo.go(null);
    g.warmup.flush();
    this.last = { ...a, dest: d.name, fare: this.fare, held: 0, ok: true };
    this.remember(d);
    this.moved = true;
    this.cabAt = performance.now();
  }

  private remember(d: Dest): void {
    this.recent = [d, ...this.recent.filter((r) => r.name !== d.name)].slice(0, 3);
    try { localStorage.setItem(KEY, JSON.stringify(this.recent)); } catch { /* no storage */ }
  }

  update(dt: number): void {
    // The arrival puff goes out a moment after the move, so the others' copy of her has jumped by then.
    if (this.cabAt && performance.now() - this.cabAt > 250) { this.cabAt = 0; this.game.net.cab(1); }
    if (!this.phase) return;
    const g = this.game;
    this.t += dt; this.ticks++;
    if (this.phase === 1) {
      this.card.fade(Math.min(1, this.t / OUT));
      if (this.t >= OUT) { this.phase = 2; this.t = 0; this.ticks = 0; this.move(); }
    } else if (this.phase === 2) {
      this.card.fade(1);
      // Ready when frames have been drawn here, the shader scan has nothing in flight and the last few frames were quick:
      // whatever was going to hitch has done so under black. Never longer than HOLD_MAX.
      const now = performance.now();
      if (this.lastNow && g.warmup.idle && now - this.lastNow < CALM_MS) this.calm++; else this.calm = 0;
      this.lastNow = now;
      if ((this.ticks >= HOLD_FRAMES && this.t >= HOLD_MIN && this.calm >= CALM_TICKS) || this.t >= HOLD_MAX) {
        if (this.last) this.last.held = this.t;
        this.phase = 3; this.t = 0;
        if (this.moved && this.last?.ok) { const p = g.player; this.puff(p.x, p.y, p.z); g.hud.toast(this.fare === 0 ? 'Transfer complete. Kid mode rides free.' : `Transfer complete. Fare ${money(this.fare)} charged to your file.`, 5); }
      }
    } else {
      this.card.fade(Math.max(0, 1 - this.t / IN), true);
      if (this.t >= IN) {
        this.phase = 0;
        this.card.close();
        g.input.setEnabled(true);
        this.dest = null;
      }
    }
  }
}
