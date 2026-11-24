// Side work: what there is to do between missions.
//
//   taxi     in a Calamity Cab: pick up, drop off, fare by the length of the route, a tip that melts
//   courier  in a van: four parcels against a clock
//   tow      in a tow truck: hook the marked car and haul it to a yard (a simple rigid tow)
//   races    six named routes with checkpoints and par times, started from a ring at the first corner
//   jumps    every ramp, scored from airtime and distance
//   ducks    thirty golden rubber ducks, hidden over both lands
//
// The first four take the floor (ThingsToDo.busy), so only one runs at a time
// and never during a mission; jumps and ducks are always on. Everything pays
// money and progress points, and repeat payouts taper (see pay()) so that
// nothing here is worth grinding: the tenth fare pays less than the first, a
// race pays in full once and a fraction after.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { BRIDGE_RAMP, PIER_HEAD, RAMPS, WATER_Y, XS, ZS, groundAt, isWater } from '../world/plan';
import type { RoadNode } from '../world/plan';
import { MI0, MJ0, SITES } from '../world/mainland';
import { BUILDING_SITES } from '../world/buildings';
import { progress } from '../world/progress';
import { commonKind } from '../ent/vehicleSpecs';
import { RNG, money } from '../core/util';
import type { Look } from '../core/api';
import { save } from './save';
import { clearOf, clock, type Markers, type Pt } from './script';

const FEET = 3.28084;
export const DUCKS = 30;

/** Money and points for the n-th time a job has paid (n counts from 0). Points fall away faster than money. */
export function taper(n: number): { cash: number; points: number } {
  return { cash: Math.max(0.5, 1 / (1 + n * 0.08)), points: Math.max(0.25, 1 / (1 + n * 0.3)) };
}

/**
 * A race route. laps: how many times round (a loop ends where it starts); par is for the whole race. edges: the street
 * pieces it runs on (a mainland route is offered only once they are open). Races are run by game/race.ts (fun queue
 * item 11: called at the marker, others in town invited, a grid, a countdown, laps, a podium, town records).
 */
export interface RaceDef { name: string; par: number; cps: Pt[]; start: Pt; laps: number; loop: boolean; edges: number[]; idx: number }
// (ml: on the mainland, nodes counted from MI0/MJ0. Append only: a route's index is its town record's fact key.)
// The Tepid Falls Loop: under the new streets (plan.streets) its checkpoints are NEW_LOOP below, round downtown; the old grid
// route still gives its edges, so it opens with the mainland as before.
const RACES: { name: string; par: number; via: [number, number][]; laps?: number; ml?: boolean }[] = [
  { name: 'The Ledger Loop', par: 78, via: [[4, 4], [4, 3], [5, 3], [5, 2], [6, 2], [6, 4], [4, 4]] },
  { name: 'Strand Sprint', par: 64, via: [[0, 7], [3, 7], [6, 7], [9, 7]] },
  { name: 'The Cannery Crawl', par: 98, via: [[1, 5], [1, 7], [2, 7], [2, 8], [0, 8], [0, 5], [1, 5]] },
  { name: 'Gull Heights Hairpins', par: 112, via: [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [4, 2], [4, 0]] },
  { name: 'Dock Seven Dash', par: 115, via: [[8, 4], [10, 4], [10, 6], [9, 6], [9, 8], [8, 8], [8, 4]] },
  { name: 'The Grand Tour', par: 300, via: [[0, 0], [5, 0], [10, 0], [10, 4], [10, 8], [5, 8], [0, 8], [0, 4], [0, 0]] },
  { name: 'Downtown Circuit', par: 105, laps: 2, via: [[3, 3], [6, 3], [6, 5], [3, 5], [3, 3]] },
  { name: 'The Coast Run', par: 100, via: [[0, 4], [0, 8], [5, 8], [10, 8], [10, 5]] },
  { name: 'Tepid Falls Loop', par: 110, laps: 2, ml: true, via: [[5, 4], [7, 4], [7, 7], [5, 7], [5, 4]] },
];

/** Tepid Falls Loop on the new streets: up Main St from Trestle St, east on Applejack St (one-way that way), down Front St, back along Trestle St. */
const NEW_LOOP: Pt[] = [{ x: 70, z: -1640 }, { x: 70, z: -1955 }, { x: 166, z: -1975 }, { x: 170, z: -1625 }, { x: 70, z: -1640 }];

const RAMP_NAMES = ['Low Tide Beach', 'the container yard', 'the park pond', 'the arena lot', 'the cannery', 'Pelican Pier', 'the end of the bridge'];
const JUMP_LINES = [
  'The judges are a gull.', 'Nobody signed for that.', 'Insurance has been informed, and has left the country.',
  'It counts. Nobody can say why.', 'Technically a flight. Technically a landing.', 'The truck would like a word.',
];
const FARE_HELLO = [
  'Gull & Void Insurance, and step on it. I have a claim to deny.', 'Do you know the island? No? Good, neither do I.',
  'Take the scenic route. I am billing someone.', 'I left the oven on. This is unrelated to where we are going.',
  'My last driver went off the pier. Five stars.', 'Drive like the meter is somebody else\'s.',
];
const FARE_BUMP = ['That was my good spine.', 'I felt that in my deposit.', 'Was that a person or a policy?', 'I will be mentioning that in the review.', 'The tip saw that.'];
const FARE_BYE = ['Keep the change. There is no change.', 'I have had worse. I was driving.', 'You should do this for a living. Somebody should.', 'Here. Do not thank me, I resent it.'];

// Roughly where each duck is hidden; snapped at start-up to the nearest clear, dry, walkable spot.
const DUCK_ISLAND: [number, number][] = [
  [0, 662], [26, 640], [888, 256], [760, 256], [-200, 446], [250, 444], [-545, -60], [150, -172], [252, -70], [522, 332],
  [340, 252], [-12, -447], [-560, -402], [300, -470], [-650, 100], [640, -100], [-380, 277.5], [-428, 90], [-195, -52], [-131.5, 127],
  [-18.5, 11], [66, -70],
];

/**
 * A fare's look from a small seed, the same in every browser (multiplayer, net/jobs.ts: the others are shown the fare
 * waiting at the kerb as the same person).
 */
export function riderLook(game: Game, seed: number): Look {
  return game.people.randomLook(new RNG(((seed & 0xff) + 1) * 2654435761 ^ 0x51f15eed), true);
}

/** What the others in a shared town are shown of a job (net/jobs.ts reads it; the runner's browser is the authority). */
export interface JobView {
  job: '' | 'taxi' | 'courier' | 'tow';
  /** taxi: the fare waiting at the kerb (null once aboard or between fares), the seed of their look, and whether one rides in the cab. */
  rider: Person | null; riderSeed: number; aboard: boolean;
  /** courier: parcels still in the van, of how many. */
  parcels: number; total: number;
  /** tow: the car to be towed (a held car), and whether it is on the hook. */
  towed: Vehicle | null; hooked: boolean;
}

export class Activities {
  /** Multiplayer (net/jobs.ts): true in a shared town on the main service, where a fare's look is made from a seed. */
  shared: (() => boolean) | null = null;
  private riderSeed = 0;
  private parcelsTotal = 0;
  private readonly viewRec: JobView = { job: '', rider: null, riderSeed: 0, aboard: false, parcels: 0, total: 0, towed: null, hooked: false };
  prompt: string | null = null;
  target: Pt | null = null;
  readonly ducks: Pt[] = [];
  readonly races: RaceDef[] = [];
  /** The two yards a tow can end at. */
  readonly yards: { at: Pt; name: string }[] = [];
  /** Which job has the floor ('taxi' | 'courier' | 'tow' | 'race'), else ''. */
  job = '';

  private readonly duckMesh: THREE.Group[] = [];
  private t = 0;
  private awayT = 0;
  // taxi
  private phase = 0;
  private rider: Person | null = null;
  private dest: Pt | null = null;
  private fare = 0; private tip = 0; private tip0 = 0; private parT = 0; private rideT = 0;
  // courier
  private drops: Pt[] = [];
  private clockT = 0; private haul = 0;
  // tow
  private towed: Vehicle | null = null; private hooked = false; private yard: { at: Pt; name: string } | null = null;
  /** The cab, van or truck the job is being done in: the job's own while it runs (Vehicle.held; net/held.ts). */
  private ride: Vehicle | null = null;
  // race
  private race: RaceDef | null = null; private cpI = 0;
  // jumps
  private airV: Vehicle | null = null; private airT = 0; private airX = 0; private airZ = 0; private airRamp = -1;
  private lines = 0;

  constructor(
    private readonly game: Game,
    private readonly markers: Markers,
    private readonly isFree: () => boolean,
    private readonly setBusy: (id: string | null) => void,
  ) {
    const plan = game.plan;
    RACES.forEach((r, idx) => {
      const cps: Pt[] = [], edges: number[] = [];
      let ok = true;
      const at = (i: number, j: number): RoadNode | null => plan.nodeAt(r.ml ? i + MI0 : i, r.ml ? j + MJ0 : j);
      for (let k = 0; k < r.via.length; k++) {
        const [i, j] = r.via[k], n = at(i, j);
        if (!n) { ok = false; break; }
        cps.push({ x: n.x, z: n.z });
        // The street pieces between this corner and the next, one block at a time.
        const nx = r.via[k + 1];
        if (!nx) continue;
        for (let a = i, b = j; a !== nx[0] || b !== nx[1];) {
          const a2 = a + Math.sign(nx[0] - a), b2 = b + Math.sign(nx[1] - b), A = at(a, b), B = at(a2, b2);
          const e = A && B ? A.edges.find((id) => { const ed = plan.edges[id]; return (ed.a === A.id && ed.b === B.id) || (ed.a === B.id && ed.b === A.id); }) : undefined;
          if (e === undefined) { ok = false; break; }
          edges.push(e); a = a2; b = b2;
        }
      }
      if (!ok || cps.length < 3) return;
      if (r.ml && plan.streets) {
        // The new streets: the loop's checkpoints, and the pieces of the new graph between them (so it opens with its own streets).
        const sg = plan.streets;
        cps.length = 0; cps.push(...NEW_LOOP.map((p) => ({ ...p }))); edges.length = 0;
        for (let k = 0; k + 1 < NEW_LOOP.length; k++) {
          const na = sg.nearestNode(NEW_LOOP[k].x, NEW_LOOP[k].z), nb = sg.nearestNode(NEW_LOOP[k + 1].x, NEW_LOOP[k + 1].z), path = sg.findPath(na.id, nb.id, 9);
          for (let i = 0; i + 1 < path.length; i++) {
            const id = sg.nodes[path[i]].edges.find((q) => { const ed = sg.edges[q]; return (ed.a === path[i] && ed.b === path[i + 1]) || (ed.a === path[i + 1] && ed.b === path[i]); });
            if (id !== undefined && !edges.includes(id)) edges.push(id);
          }
        }
      }
      const loop = Math.hypot(cps[0].x - cps[cps.length - 1].x, cps[0].z - cps[cps.length - 1].z) < 1;
      this.races.push({ name: r.name, par: r.ml && plan.streets ? 92 : r.par, start: cps[0], cps: cps.slice(1), laps: loop ? r.laps ?? 1 : 1, loop, edges, idx });
    });
    const m = BUILDING_SITES.marlowe, d = BUILDING_SITES.dockOffice;
    this.yards.push({ at: { x: m ? m.x : -396.7, z: (m ? m.z : 275.9) + 8 }, name: 'Marlowe Towing, Strand Blvd' });
    this.yards.push({ at: { x: (d ? d.x : 327) - 10, z: d ? d.z : 247.6 }, name: 'the Harbor Authority pound, Dock Seven' });

    const rough: [number, number][] = [
      ...DUCK_ISLAND,
      [SITES.landing.x + 20, SITES.landing.z + 6], [SITES.square.x + 4, SITES.square.z + 4], [SITES.dam.x - 30, SITES.dam.z + 30],
      [SITES.hilltop.x + 6, SITES.hilltop.z + 6], [SITES.lake.x, SITES.lake.z], [SITES.footbridgeEast.x + 14, SITES.footbridgeEast.z + 6],
      [150, -1992], [-688, -2046],
    ];
    for (const [x, z] of rough.slice(0, DUCKS)) this.ducks.push(this.clearSpot(x, z));
    this.buildDucks();

    game.on('impact', (e) => {
      if (this.job !== 'taxi' || this.phase !== 1 || e.speed < 4) return;
      if (e.vehicle.driver !== 'player' && e.other?.driver !== 'player') return;
      this.tip = Math.max(0, this.tip - this.tip0 * 0.2);
      game.hud.subtitle('FARE', FARE_BUMP[this.lines++ % FARE_BUMP.length], 3);
    });
    game.on('booked', () => this.stop('The Harbor Patrol has ended your shift for you.'));
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  /** Is a person-sized circle at (x, z) on dry ground and clear of every wall and prop? */
  clear(x: number, z: number): boolean {
    const g = groundAt(x, z), col = this.game.col;
    if (isWater(x, z) || g < WATER_Y + 0.5) return false;
    if (col.pointBlocked(x, z, g + 0.4) || col.pointBlocked(x, z, g + 1.4)) return false;
    const p = { x, z };
    return !col.resolveCircle(p, 0.8, g);
  }

  /** The nearest clear spot to (x, z), searched outward in rings. */
  private clearSpot(x: number, z: number): Pt {
    if (this.clear(x, z)) return { x, z };
    for (let r = 1.5; r < 220; r += 1.5) {
      const n = Math.max(8, Math.round(r * 2.2));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (this.clear(px, pz)) return { x: +px.toFixed(2), z: +pz.toFixed(2) };
      }
    }
    return { x, z };
  }

  /** Pay for a job: tapered by how often it has paid before. Returns what was actually paid. */
  private pay(key: string, cash: number, points: number): { cash: number; points: number } {
    const k = taper(save.count(key));
    save.bump(key);
    const c = Math.round(cash * k.cash), p = Math.round(points * k.points);
    this.game.player.money += c;
    save.credit(c);
    save.data.stats.earned += c;
    progress.add(p);
    return { cash: c, points: p };
  }

  /** A street corner on the player's side of the water, between `lo` and `hi` meters off by road. Null if the town has none. */
  private corner(from: Pt, lo: number, hi: number): { at: Pt; len: number } | null {
    const plan = this.game.plan.streets ?? this.game.plan, a = plan.nearestNode(from.x, from.z);
    const pool: RoadNode[] = [];
    for (const n of plan.nodes) {
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d >= lo && d <= hi && n.land === a.land && n.edges.some((e) => !plan.edges[e].closed && !plan.edges[e].deck)) pool.push(n);
    }
    for (let tries = 0; tries < 12 && pool.length; tries++) {
      const n = pool[Math.floor(Math.random() * pool.length)];
      const ids = plan.findPath(a.id, n.id);
      if (ids.length < 2) continue;
      let len = 0;
      for (let k = 1; k < ids.length; k++) len += Math.hypot(plan.nodes[ids[k]].x - plan.nodes[ids[k - 1]].x, plan.nodes[ids[k]].z - plan.nodes[ids[k - 1]].z);
      const sx = Math.random() < 0.5 ? -1 : 1, sz = Math.random() < 0.5 ? -1 : 1;
      return { at: { x: n.x + sx * (n.hx + 1.8), z: n.z + sz * (n.hz + 1.8) }, len };
    }
    return null;
  }

  private begin(job: string): void {
    this.job = job; this.awayT = 0;
    // A race is run in whatever she happens to be driving; the other three are done in one vehicle, which is the job's.
    if (job !== 'race') this.hold(this.game.player.vehicle);
    this.setBusy(job);
  }

  /** The job's vehicle changes (or, with null, the job lets go of it). */
  private hold(v: Vehicle | null): void {
    if (this.ride === v) return;
    if (this.ride) this.ride.held = false;
    this.ride = v;
    if (v) v.held = true;
  }

  /** End whatever job is running, with a word about why. */
  stop(why?: string): void {
    if (!this.job) return;
    const g = this.game;
    if (this.rider) { g.people.remove(this.rider); this.rider = null; }
    this.hold(null);
    if (this.towed) this.towed.held = false;
    if (this.towed && g.vehicles.list.includes(this.towed) && g.player.vehicle !== this.towed) {
      if (this.job === 'tow' && !this.hooked) g.vehicles.remove(this.towed);
    }
    this.towed = null; this.hooked = false; this.race = null; this.drops = []; this.dest = null;
    this.job = ''; this.target = null;
    g.hud.objective(null); g.hud.timer(null);
    if (why) g.hud.toast(why, 5);
    this.setBusy(null);
  }

  /** What the others are shown of the job running here (net/jobs.ts). The object is reused. */
  view(): JobView {
    const w = this.viewRec, j = this.job;
    w.job = j === 'taxi' || j === 'courier' || j === 'tow' ? j : '';
    w.rider = j === 'taxi' ? this.rider : null; w.riderSeed = this.riderSeed; w.aboard = j === 'taxi' && this.phase === 1;
    w.parcels = j === 'courier' ? this.drops.length : 0; w.total = j === 'courier' ? this.parcelsTotal : 0;
    w.towed = j === 'tow' ? this.towed : null; w.hooked = j === 'tow' && this.hooked;
    return w;
  }

  blips(out: Blip[]): void {
    if (this.job) {
      if (this.job === 'courier') for (const d of this.drops) out.push({ x: d.x, z: d.z, kind: 'goal' });
      else if (this.target) out.push({ x: this.target.x, z: this.target.z, kind: 'goal' });
      return;
    }
    // (Race starts are game/race.ts's.)
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle;
    this.prompt = null;
    this.t += dt;
    this.tickDucks(dt);
    this.tickJumps(v);
    if (!this.job) { this.target = null; if (this.isFree()) this.offer(v); return; }
    if (!(p.health > 0)) { this.stop('Shift over. Mercy General does not validate fares.'); return; }
    // Out of the vehicle the job needs: a short grace, then it is off.
    const need = this.job === 'taxi' ? 'taxi' : this.job === 'courier' ? 'van' : this.job === 'tow' ? 'tow' : '';
    if (!v || (need && v.spec.kind !== need)) {
      this.awayT += dt;
      if (this.awayT > (this.job === 'race' ? 8 : 20)) { this.stop(this.job === 'race' ? 'Race abandoned. The route has been told.' : 'Off the clock.'); return; }
      g.hud.objective(need ? `Get back in the ${need === 'tow' ? 'tow truck' : need === 'taxi' ? 'cab' : 'van'}, or the job is off.` : 'Get back in a vehicle, or the race is off.');
      return;
    }
    this.awayT = 0;
    // (Another cab will do as well as the one the shift began in: the job is in this one now.)
    if (need) this.hold(v);
    if (this.job === 'taxi') this.tickTaxi(dt, v);
    else if (this.job === 'courier') this.tickCourier(dt, v);
    else if (this.job === 'tow') this.tickTow(dt, v);
    else if (this.job === 'race') this.tickRace(dt);
  }

  /** Nothing is running: what could be started from where she is. */
  private offer(v: Vehicle | null): void {
    const g = this.game, p = g.player;
    // (Race starts: game/race.ts, which runs before this and has the key at a race marker.)
    void p;
    if (!v || p.speed > 3 || p.heat > 0) return;
    const k = v.spec.kind;
    if (k === 'taxi') { this.prompt = '[G] Take fares in the cab'; if (g.input.eat('interact')) this.startJob('taxi'); }
    else if (k === 'van') { this.prompt = '[G] Start a courier run in the van'; if (g.input.eat('interact')) this.startJob('courier'); }
    else if (k === 'tow') { this.prompt = '[G] Take a towing job'; if (g.input.eat('interact')) this.startJob('tow'); }
  }

  /** Start a job by name (the prompt does this; so do the tests). The player must already be in the right vehicle. */
  startJob(job: 'taxi' | 'courier' | 'tow'): boolean {
    const g = this.game, p = g.player, v = p.vehicle;
    if (this.job || !this.isFree() || !v) return false;
    if (job === 'taxi') {
      if (v.spec.kind !== 'taxi') return false;
      this.begin('taxi');
      if (!this.nextFare()) { this.stop('Nobody wants a cab out here.'); return false; }
      g.hud.toast('On the clock. Fares pay by the length of the route; the tip melts while you dawdle.', 6);
    } else if (job === 'courier') {
      if (v.spec.kind !== 'van') return false;
      const drops: Pt[] = [];
      let len = 0, from: Pt = { x: p.x, z: p.z };
      for (let k = 0; k < 4; k++) { const c = this.corner(from, 140, 420); if (!c) break; drops.push(c.at); len += c.len; from = c.at; }
      if (drops.length < 2) { g.hud.toast('No parcels today. The depot has lost the depot.', 4); return false; }
      this.begin('courier');
      this.drops = drops; this.haul = len; this.parcelsTotal = drops.length;
      this.clockT = len / 8 + 18 * drops.length + 15;
      g.hud.toast(`${drops.length} parcels, any order. Stop at each ring.`, 5);
    } else {
      if (v.spec.kind !== 'tow') return false;
      // (In a shared town a place where this browser is only shown a car is not free to tow from: clearOf says so.)
      const spots = this.towSpots(p.x, p.z);
      if (!spots.length) { g.hud.toast('Nothing to tow. Everyone has parked legally, which is suspicious.', 4); return false; }
      const s = spots[Math.floor(Math.random() * spots.length)];
      const own = (o: Vehicle): boolean => o.driver === null && o !== v && !o.shared && !o.held;
      for (let c = g.vehicles.nearest(s.x, s.z, 5, own); c; c = g.vehicles.nearest(s.x, s.z, 5, own)) g.vehicles.remove(c);
      this.begin('tow');
      this.towed = g.vehicles.spawn(commonKind(Math.random()), s.x, s.z, s.h, 0x8a9a6b);
      this.towed.held = true;
      this.hooked = false;
      // The farther yard, so there is a haul in it. On the mainland the pound is "the landing".
      const yards = p.z < -900 ? [{ at: { x: SITES.landing.x, z: SITES.landing.z - 20 }, name: 'the lot at Tepid Landing' }] : this.yards;
      this.yard = yards.slice().sort((a, b) => Math.hypot(b.at.x - s.x, b.at.z - s.z) - Math.hypot(a.at.x - s.x, a.at.z - s.z))[0];
      g.hud.toast(`One ${this.towed.spec.name}, parked "creatively" on ${g.plan.streetAt(s.x, s.z)}.`, 5);
    }
    return true;
  }

  /** Kerb places a car to tow may stand in: 160 to 520 m from (x, z), and (in a shared town) none where this browser is only shown a car (clearOf). */
  private towSpots(x: number, z: number): { x: number; z: number; h: number }[] {
    const g = this.game;
    return (z < -900 ? (g.plan.streets ? g.plan.streets.parking : g.plan.mainlandParking) : g.plan.parking).filter((s) => { const d = Math.hypot(s.x - x, s.z - z); return d > 160 && d < 520 && clearOf(g, s, s.h) === s; });
  }

  /**
   * Multiplayer (net/jobs.ts): another player started a tow in the same moment and their car to tow stands where
   * this one does (neither browser had been shown the other's yet). The car not yet hooked moves to another free
   * place, so the town never has two cars in one. False when there is nowhere else (it stays; the toast says so).
   */
  reparkTowed(): boolean {
    const g = this.game, c = this.towed, p = g.player;
    if (this.job !== 'tow' || !c || this.hooked || c.removed) return false;
    const spots = this.towSpots(p.x, p.z).filter((s) => Math.hypot(s.x - c.x, s.z - c.z) > 6);
    if (!spots.length) return false;
    const s = spots[Math.floor(Math.random() * spots.length)];
    const own = (o: Vehicle): boolean => o.driver === null && o !== c && o !== p.vehicle && !o.shared && !o.held;
    for (let o = g.vehicles.nearest(s.x, s.z, 5, own); o; o = g.vehicles.nearest(s.x, s.z, 5, own)) g.vehicles.remove(o);
    c.x = s.x; c.z = s.z; c.h = s.h; c.vx = 0; c.vz = 0;
    g.vehicles.wake(c);
    const yards = p.z < -900 ? [{ at: { x: SITES.landing.x, z: SITES.landing.z - 20 }, name: 'the lot at Tepid Landing' }] : this.yards;
    this.yard = yards.slice().sort((a, b) => Math.hypot(b.at.x - s.x, b.at.z - s.z) - Math.hypot(a.at.x - s.x, a.at.z - s.z))[0];
    g.hud.toast(`Somebody else got that one. Yours is on ${g.plan.streetAt(s.x, s.z)}.`, 5);
    return true;
  }

  // ── Taxi ───────────────────────────────────────────────────────────────────

  private nextFare(): boolean {
    const g = this.game, p = g.player;
    const c = this.corner({ x: p.x, z: p.z }, 90, 360);
    if (!c) return false;
    this.phase = 0; this.dest = c.at;
    // (In a shared town the fare's look comes from a seed the others are told, so they draw the same person.)
    this.riderSeed = Math.floor(Math.random() * 256);
    this.rider = g.people.spawn(c.at.x, c.at.z, Math.atan2(p.x - c.at.x, p.z - c.at.z), this.shared?.() ? riderLook(g, this.riderSeed) : undefined);
    this.rider.pose = 'stand';
    return true;
  }

  private tickTaxi(dt: number, v: Vehicle): void {
    const g = this.game, p = g.player, hud = g.hud, d = this.dest as Pt;
    this.target = d;
    this.markers.put(d.x, d.z, 'job', 6, 26);
    const here = Math.hypot(p.x - d.x, p.z - d.z) < 9 && Math.abs(v.speed) < 2;
    if (this.phase === 0) {
      hud.objective(`Pick up the fare on ${g.plan.streetAt(d.x, d.z)}. Stop beside them.`);
      hud.timer(null);
      if (!here) return;
      if (this.rider) { g.people.remove(this.rider); this.rider = null; }
      const c = this.corner(d, 280, 900);
      if (!c) { this.stop('The fare changed their mind. So did the town.'); return; }
      this.dest = c.at; this.phase = 1;
      this.fare = Math.round(18 + c.len * 0.2);
      this.tip0 = this.tip = Math.round(this.fare * 0.6);
      this.parT = c.len / 10 + 14; this.rideT = 0;
      hud.subtitle('FARE', FARE_HELLO[this.lines++ % FARE_HELLO.length], 4.5);
      return;
    }
    this.rideT += dt;
    // The tip holds for the par time, then melts to nothing over as long again.
    if (this.rideT > this.parT) this.tip = Math.max(0, this.tip - (this.tip0 / this.parT) * dt);
    hud.objective(`Take the fare to ${g.plan.placeName(d.x, d.z)}, ${g.plan.streetAt(d.x, d.z)}. Fare ${money(this.fare)}.`);
    hud.timer('Tip', money(this.tip), this.tip < this.tip0 * 0.4);
    if (!here) return;
    const paid = this.pay('taxi', this.fare + this.tip, 14);
    save.data.stats.fares++;
    hud.subtitle('FARE', FARE_BYE[this.lines++ % FARE_BYE.length], 4);
    hud.toast(`Fare ${save.data.stats.fares}: ${money(paid.cash)} with the tip, ${paid.points} toward the bridge.`, 5);
    hud.timer(null);
    if (!this.nextFare()) this.stop('That was the last fare in town.');
  }

  // ── Courier ────────────────────────────────────────────────────────────────

  private tickCourier(dt: number, v: Vehicle): void {
    const g = this.game, p = g.player, hud = g.hud;
    this.clockT -= dt;
    if (this.clockT <= 0) { hud.stamp('PAST DUE', 'The parcels have been returned to sender. You are the sender.'); this.stop(); return; }
    hud.timer('Parcels due in', clock(this.clockT), this.clockT < 15);
    let best: Pt | null = null, bd = Infinity;
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const d = this.drops[k], dd = Math.hypot(p.x - d.x, p.z - d.z);
      if (dd < 9 && Math.abs(v.speed) < 2.5) { this.drops.splice(k, 1); hud.toast(`Parcel signed for. ${this.drops.length} to go.`, 3); continue; }
      this.markers.put(d.x, d.z, 'job', 5, 22);
      if (dd < bd) { bd = dd; best = d; }
    }
    this.target = best;
    hud.objective(`Deliver the parcels: ${this.drops.length} left. Stop at each ring.`);
    if (this.drops.length) return;
    const paid = this.pay('courier', 110 + this.haul * 0.14, 36);
    save.data.stats.parcels += 4;
    hud.stamp('DELIVERED', `${money(paid.cash)} · ${paid.points} toward the bridge · ${clock(this.clockT)} to spare`);
    this.stop();
  }

  // ── Towing ─────────────────────────────────────────────────────────────────

  private tickTow(dt: number, v: Vehicle): void {
    const g = this.game, hud = g.hud, c = this.towed, y = this.yard;
    if (!c || !y || c.wreck || c.sunk || !g.vehicles.list.includes(c)) { if (c) c.held = false; this.towed = null; hud.stamp('WRITTEN OFF', 'There is nothing left to tow. The owner will be thrilled.'); this.stop(); return; }
    if (!this.hooked) {
      this.target = { x: c.x, z: c.z };
      this.markers.put(c.x, c.z, 'job', 4, 22);
      hud.objective(`Tow job: the ${c.spec.name} on ${g.plan.streetAt(c.x, c.z)}. Stop the truck right beside it.`);
      if (Math.hypot(v.x - c.x, v.z - c.z) < v.hl + c.hl + 4.5 && Math.abs(v.speed) < 2) {
        this.hooked = true;
        hud.toast(`Hooked. Haul it to ${y.name}.`, 5);
      }
      return;
    }
    // A rigid tow: the car rides straight behind the truck as if on a bar, a hand's width off the bed. A hinged
    // tow was tried first; in a tight turn the car's corner met the truck's and the two fought each other to a stop.
    const back = v.hl + c.hl + 0.7, sh = Math.sin(v.h), ch = Math.cos(v.h);
    c.h = v.h;
    c.x = v.x - sh * back; c.z = v.z - ch * back;
    c.y = v.y; c.vx = v.vx; c.vz = v.vz; c.vy = 0; c.yawRate = 0; c.roll = 0; c.pitch = 0;
    this.target = y.at;
    this.markers.put(y.at.x, y.at.z, 'job', 9, 30);
    hud.objective(`Haul the ${c.spec.name} to ${y.name}.`);
    if (Math.hypot(v.x - y.at.x, v.z - y.at.z) < 11 && Math.abs(v.speed) < 2) {
      const paid = this.pay('tow', 160 + Math.hypot(c.x - v.x, c.z - v.z) * 0 + 60, 40);
      save.data.stats.tows++;
      c.vx = c.vz = 0;
      g.vehicles.remove(c);
      this.towed = null;
      hud.stamp('IMPOUNDED', `${money(paid.cash)} · ${paid.points} toward the bridge · tow No. ${save.data.stats.tows}`);
      this.stop();
    }
    void dt;
  }

  // ── Races ──────────────────────────────────────────────────────────────────

  startRace(r: RaceDef): boolean {
    if (this.job || !this.isFree() || !this.game.player.vehicle) return false;
    this.begin('race');
    this.race = r; this.cpI = 0; this.clockT = 0;
    this.game.hud.stamp(r.name.toUpperCase(), `Par ${clock(r.par)} · ${r.cps.length} checkpoints · go`);
    return true;
  }

  private tickRace(dt: number): void {
    const g = this.game, p = g.player, hud = g.hud, r = this.race as RaceDef;
    this.clockT += dt;
    const c = r.cps[this.cpI], n = r.cps[this.cpI + 1];
    this.target = c;
    this.markers.put(c.x, c.z, 'goal', 11, 40);
    if (n) this.markers.put(n.x, n.z, 'item', 6, 14);
    hud.objective(`${r.name}: checkpoint ${this.cpI + 1} of ${r.cps.length}.`);
    hud.timer(`Par ${clock(r.par)}`, clock(this.clockT), this.clockT > r.par);
    if (Math.hypot(p.x - c.x, p.z - c.z) > 11) return;
    if (++this.cpI < r.cps.length) return;
    const time = this.clockT, key = 'race:' + r.name, record = save.record(key, +time.toFixed(1), true);
    if (time <= r.par) {
      const paid = this.pay(key, 320, 90);
      save.data.stats.races++;
      hud.stamp('UNDER PAR', `${r.name} · ${clock(time)} · ${money(paid.cash)} · ${paid.points} toward the bridge${record ? ' · a record' : ''}`);
    } else hud.stamp('OVER PAR', `${r.name} · ${clock(time)} against ${clock(r.par)} · the route is unimpressed`);
    this.stop();
  }

  // ── Stunt jumps ────────────────────────────────────────────────────────────

  /** How many ramps there are to land (the one at the end of the bridge goes when the bridge is finished). */
  get ramps(): number { return RAMPS.length; }

  private tickJumps(v: Vehicle | null): void {
    const was = this.airV;
    if (v !== was) {
      // Thrown clear as it went under: the jump still counts, the Sound being a kind of landing.
      if (was && was.sunk && this.airT > 0) this.landed(was);
      this.airV = v; this.airT = 0;
    }
    if (!v) return;
    if (v.sunk) { if (this.airT > 0) this.landed(v); this.airT = 0; return; }
    if (!v.onGround) {
      if (this.airT === 0) {
        this.airX = v.x; this.airZ = v.z; this.airRamp = -1;
        for (let i = 0; i < RAMPS.length; i++) {
          if (i === BRIDGE_RAMP && progress.complete) continue;
          const r = RAMPS[i];
          if (Math.hypot(v.x - r.x, v.z - r.z) < r.len + 9) this.airRamp = i;
        }
      }
      this.airT = Math.max(this.airT, v.airTime, 0.001);
      return;
    }
    if (this.airT > 0) this.landed(v);
    this.airT = 0;
  }

  private landed(v: Vehicle): void {
    const t = this.airT, i = this.airRamp;
    if (t < 0.7 || i < 0) return;
    const dist = Math.hypot(v.x - this.airX, v.z - this.airZ), score = Math.round(t * 100 + dist * 4);
    const first = !save.data.jumps.includes(i), record = save.record('jump:' + i, score, false);
    const hud = this.game.hud, line = v.sunk ? 'The landing has been filed under "water".' : JUMP_LINES[this.lines++ % JUMP_LINES.length];
    if (first) {
      save.data.jumps.push(i);
      const paid = this.pay('jump:' + i, 200, 60);
      hud.toast(`Stunt jump ${save.data.jumps.length} of ${RAMPS.length}, ${RAMP_NAMES[i] ?? 'somewhere'}: ${t.toFixed(1)} s, ${Math.round(dist * FEET)} ft, ${score} points. ${money(paid.cash)}. ${line}`, 7);
    } else if (record) {
      const paid = this.pay('jump:' + i, 60, 15);
      hud.toast(`${RAMP_NAMES[i]}: ${score} points, a new best. ${money(paid.cash)}. ${line}`, 6);
    }
  }

  // ── Ducks ──────────────────────────────────────────────────────────────────

  private buildDucks(): void {
    const gold = new THREE.MeshStandardMaterial({ color: 0xf6c21a, emissive: 0x7a5200, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.65 });
    const beak = new THREE.MeshStandardMaterial({ color: 0xe4572e, roughness: 0.5 });
    const eye = new THREE.MeshBasicMaterial({ color: 0x14213d });
    const body = new THREE.SphereGeometry(0.3, 16, 12), head = new THREE.SphereGeometry(0.19, 14, 10), bill = new THREE.ConeGeometry(0.08, 0.2, 10), dot = new THREE.SphereGeometry(0.03, 6, 6);
    bill.rotateX(Math.PI / 2);
    for (let i = 0; i < this.ducks.length; i++) {
      const d = this.ducks[i], grp = new THREE.Group();
      const b = new THREE.Mesh(body, gold); b.scale.set(1, 0.78, 1.25); b.position.y = 0.24;
      const tail = new THREE.Mesh(head, gold); tail.scale.set(0.6, 0.5, 0.7); tail.position.set(0, 0.36, -0.34);
      const h = new THREE.Mesh(head, gold); h.position.set(0, 0.56, 0.2);
      const k = new THREE.Mesh(bill, beak); k.scale.set(1.5, 0.7, 1); k.position.set(0, 0.53, 0.42);
      const e1 = new THREE.Mesh(dot, eye); e1.position.set(0.09, 0.62, 0.35);
      const e2 = new THREE.Mesh(dot, eye); e2.position.set(-0.09, 0.62, 0.35);
      grp.add(b, tail, h, k, e1, e2);
      for (const m of [b, tail, h]) m.castShadow = true;
      grp.position.set(d.x, groundAt(d.x, d.z), d.z);
      grp.rotation.y = i * 1.7;
      grp.visible = !save.data.ducks.includes(i);
      this.game.scene.add(grp);
      this.duckMesh.push(grp);
    }
    void PIER_HEAD; void XS; void ZS;
  }

  /** Put every duck back (a new game). */
  resetDucks(): void { for (let i = 0; i < this.duckMesh.length; i++) this.duckMesh[i].visible = !save.data.ducks.includes(i); }

  private tickDucks(dt: number): void {
    const g = this.game, p = g.player, reach = p.vehicle ? 3.2 : 1.7;
    const still = document.body.classList.contains('reduced-motion');
    for (let i = 0; i < this.ducks.length; i++) {
      const m = this.duckMesh[i];
      if (!m.visible) continue;
      const d = this.ducks[i], dd = Math.hypot(p.x - d.x, p.z - d.z);
      if (dd > 140) continue;
      if (!still) { m.rotation.y += dt * 1.6; m.position.y = groundAt(d.x, d.z) + 0.12 + Math.sin(this.t * 2.2 + i) * 0.07; }
      if (dd > reach) continue;
      m.visible = false;
      save.data.ducks.push(i);
      const n = save.data.ducks.length;
      p.money += 50; save.credit(50); save.data.stats.earned += 50;
      progress.add(25);
      g.emit('duck', { x: d.x, z: d.z });
      if (n === 10 || n === 20 || n === DUCKS) {
        const cash = n === 10 ? 500 : n === 20 ? 1000 : 2500, pts = n === 10 ? 150 : n === 20 ? 300 : 600;
        p.money += cash; save.credit(cash); save.data.stats.earned += cash;
        progress.add(pts);
        g.hud.stamp(n === DUCKS ? 'ALL THIRTY DUCKS' : `${n} DUCKS`, `${money(cash)} · ${pts} toward the bridge · ${n === DUCKS ? 'the Harbor Authority has no form for this' : 'they are watching you now'}`);
      } else g.hud.toast(`Golden duck ${n} of ${DUCKS}. $50. It squeaks with authority.`, 5);
    }
  }

  /** For the tests: what the job in hand wants. */
  want(): { job: string; at: Pt | null; phase: number; hooked: boolean; drops: Pt[] } {
    return { job: this.job, at: this.target, phase: this.phase, hooked: this.hooked, drops: this.drops.slice() };
  }
}
