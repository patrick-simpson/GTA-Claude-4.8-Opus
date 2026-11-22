// Traffic: the cars with somebody (imaginary) at the wheel.
//
// Every car here is an ordinary Vehicle driven through the same `ctl` the
// player writes, so it can be shunted, blocked and stolen like any other. A
// driver knows the street it is on, the junction it is heading for, the street
// it will take from there and the lane it wants; everything else (who is in
// front, what the light says, whether the far side of the junction has room) is
// looked up fresh each frame from a short list of nearby vehicles.
//
// Lanes are measured in meters to the right of the street's centerline:
// streets have one each way at 1.75, avenues two at 1.8 and 5.2, matching the
// paint. Cars stop with the nose 5.6 m short of the junction box, which is
// behind the stop line and leaves the crosswalk (0.9 to 3.9 m out) to walkers.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { RNG, TAU, clamp } from '../core/util';
import { RAMPS, type District, type RoadEdge, type RoadNode } from '../world/plan';
import { SPECS, commonKind, type VehicleKind } from '../ent/vehicleSpecs';

/** The most left and pushed cars the town keeps wherever they stand; past this the ones nobody can see are towed. */
const KEPT_MAX = 40;
/** Head count at full density. */
const CARS = 24;
/** Nose to junction box when stopped at the line. */
const LINE = 5.6;
/** Gap kept to a stopped car, bumper to bumper. */
const GAP = 2.2;

/**
 * A turn starts this far before the junction box and ends as far beyond it. The box alone is too
 * small a circle for a van (a right turn inside it is a 4 m radius); with the run-in the tightest
 * part of the curve is about 6 m, and it still clears the kerb at the corner by a meter.
 */
const turnExt = (kind: number): number => (kind === 1 ? 4.5 : kind === -1 ? 2 : 0.5);

/** Somebody on foot in the roadway, as the drivers see them. */
export interface RoadPed { x: number; z: number; vx: number; vz: number }

/** A cubic curve through a junction: in at 0, out at 3, with 1 and 2 as the handles. */
interface Turn { x0: number; z0: number; x1: number; z1: number; x2: number; z2: number; x3: number; z3: number; u: number; vmax: number }

interface Driver {
  v: Vehicle | null;
  e: RoadEdge;
  /** The junction being driven toward, and the street to take from it. */
  to: RoadNode;
  next: RoadEdge;
  /** -1 left, 0 straight on, 1 right at `to`. */
  turnKind: number;
  /** Lane now (0 is next to the centerline), the lane it would rather be in, and the one it cruises in by habit. */
  lane: number; wantLane: number; home: number;
  /** Meters right of the centerline it is steering for; eases toward the lane, so a lane change is a drift, not a jump. */
  off: number;
  /** The curve through the junction, while in it. */
  turn: Turn | null;
  cruise: number;
  /** Vehicles close enough to matter, refreshed a few times a second. */
  near: Vehicle[]; nearT: number;
  /** Stopped for a reason the car behind should respect (a light, a yield, a queue): nobody overtakes a queue. */
  legit: boolean;
  /** Seconds held up by something that is not a light, a honk in progress, and the pause before the next one. */
  wait: number; honk: number; honkCool: number;
  /** Going round an obstruction on the wrong side: where (along the street) it is safe to come back, and where the obstruction starts. */
  passing: boolean; passEnd: number; passAt: number; passOff: number;
  lcCool: number;
  /** Seconds of squeezing past at a crawl with only real contact counting: the deadlock breaker. */
  bold: number;
  stuck: number; back: number; backCool: number; jams: number;
  /** Seconds stationary other than at a light or in its queue, and seconds stationary for any reason at all. */
  still: number; halt: number;
  /** After a knock: seconds left of making off at speed, or of pulling up before the driver gets out. */
  panic: number; bail: number;
  swerve: number; swerveT: number;
  /** Nose-to-line distance last frame, to notice the moment the line is crossed. */
  prevStop: number;
  slowT: number;
  /** What was decided about the yellow ahead: 0 nothing yet, 1 stopping, 2 going through. */
  yellow: number;
  /** What it is waiting for, for the soak test's notes. */
  why: string;
  /** Multiplayer: the car's number on the wire (1..255, 0 without a car), and which anchor it is nearest. */
  wid: number; anchor: number;
}

/**
 * Somebody the streets are kept busy around. Alone, that is this browser's player. A multiplayer host keeps traffic
 * round every player in town (src/net/shared.ts fills `Traffic.extra`), out of the one budget of cars.
 */
export interface Anchor {
  x: number; z: number;
  /** Where they look from and which way, as near as is known: nothing appears or vanishes in front of it. */
  cx: number; cz: number; yaw: number;
  /** Just arrived or jumped: their street is filled at once, in plain view. */
  jumped: boolean;
  /** Cars nearer to them than to anybody else (counted each frame). */
  n: number;
}

/**
 * Is (x, z) a fair place to make something appear or vanish? Between `near` and `far`
 * from the player, and either behind the camera or at least `front` away from it (0 = anywhere).
 */
export function spawnOk(g: Game, x: number, z: number, near: number, far: number, front: number): boolean {
  const pl = g.player;
  const dx = x - pl.x, dz = z - pl.z, d2 = dx * dx + dz * dz;
  if (d2 < near * near || d2 > far * far) return false;
  if (front <= 0) return true;
  const cam = g.camera.position, yaw = g.cam.yaw;
  const cx = x - cam.x, cz = z - cam.z;
  return cx * Math.sin(yaw) + cz * Math.cos(yaw) < 0 || cx * cx + cz * cz > front * front;
}

const laneOff = (e: RoadEdge, lane: number): number => (e.lanes === 2 ? (lane === 0 ? 1.8 : 5.2) : 1.75);

export class Traffic {
  readonly drivers: Driver[] = [];
  /** Counters for the soak test: lights run, AI-on-AI knocks, cars given up on. */
  readonly stats = { redRuns: 0, aiHits: 0, removedStuck: 0, bails: 0, panics: 0, passes: 0, honks: 0, swerves: 0, note: '' };
  /** A hit driver has stopped and got out: (the car, where they stand). Ambient points this at the pedestrians. */
  onBail: ((v: Vehicle, x: number, z: number) => void) | null = null;

  // ── Multiplayer (src/net/shared.ts) ──
  /** The other players in town, when this browser is the host. Empty otherwise. */
  extra: Anchor[] = [];
  /** Their cars, which the drivers here must see (they are drawn only, so not in vehicles.list), and those of them on foot. */
  others: readonly Vehicle[] = [];
  walkers: readonly RoadPed[] = [];
  /** The host's traffic is shown instead: nothing is spawned or driven here. */
  guest = false;
  private readonly own: Anchor = { x: 0, z: 0, cx: 0, cz: 0, yaw: 0, jumped: false, n: 0 };
  private anchors: Anchor[] = [this.own];
  private readonly allPeds: RoadPed[] = [];
  private readonly widUsed = new Uint8Array(256);
  private lastWid = 0;
  private readonly orphanWid = new Map<Vehicle, number>();
  /** Standing cars that are the town's to keep (a player left it, or it was a parked car): not tidied away for being far off. */
  private readonly kept = new Set<Vehicle>();
  private balanceT = 0;

  private readonly rng = new RNG(60312);
  private readonly byVeh = new Map<Vehicle, Driver>();
  /** Usable lanes per direction of each street: [edge * 2 + (toward b ? 1 : 0)]. A stunt ramp in the roadway takes the outer one. */
  private readonly nLane: Uint8Array;
  /** Cars their drivers walked away from. Ordinary parked cars now, tidied up once far behind. */
  private readonly orphans: Vehicle[] = [];
  private peds: readonly RoadPed[] = [];
  private frame = 0;
  /** The soak test switches this on to have each driver note what it is waiting for. */
  debug = false;

  constructor(private readonly game: Game) {
    const plan = game.plan, rng = this.rng;
    this.nLane = new Uint8Array(plan.edges.length * 2);
    for (const e of plan.edges) {
      let f = e.lanes, b = e.lanes;
      const A = plan.nodes[e.a];
      if (e.lanes === 2) for (const r of RAMPS) {
        const s = e.horiz ? r.x - A.x : r.z - A.z;
        if (s < -12 || s > e.len + 12) continue;
        // Meters to the right of someone travelling a -> b.
        const lat = e.horiz ? r.z - A.z : -(r.x - A.x);
        if (lat > 3 && lat < e.hw + 2) f = 1; else if (lat < -3 && lat > -e.hw - 2) b = 1;
      }
      this.nLane[e.id * 2 + 1] = f; this.nLane[e.id * 2] = b;
    }
    const n = Math.round(CARS * clamp(game.quality.density, 0.4, 1));
    for (let i = 0; i < n; i++) {
      const d: Driver = {
        v: null, e: plan.edges[0], to: plan.nodes[0], next: plan.edges[0], turnKind: 0,
        lane: 0, wantLane: 0, home: rng.chance(0.65) ? 1 : 0, off: 1.75, turn: null, cruise: 10,
        near: [], nearT: 0, legit: false, wait: 0, honk: 0, honkCool: 0,
        passing: false, passEnd: 0, passAt: 0, passOff: 0, lcCool: 0, bold: 0,
        stuck: 0, back: 0, backCool: 0, jams: 0, still: 0, halt: 0, panic: 0, bail: 0, swerve: 0, swerveT: 0, prevStop: 99, slowT: 0, yellow: 0, why: '',
        wid: 0, anchor: 0,
      };
      this.drivers.push(d);
    }
    this.look();
    for (const d of this.drivers) if (this.active() < this.target()) for (let k = 0; k < 60 && !d.v; k++) this.seat(d, this.own, 18, 165, 0);

    game.on('impact', (ev) => {
      const a = this.byVeh.get(ev.vehicle), b = ev.other ? this.byVeh.get(ev.other) : undefined;
      if (a && b) { this.stats.aiHits++; return; }
      const d = a ?? b;
      // A wall is the driver's own fault; only somebody else's car is worth a reaction.
      if (!d || !ev.other || ev.speed < 3 || d.bail > 0 || d.panic > 0) return;
      if (this.rng.chance(0.5)) { d.bail = 3; this.stats.bails++; } else { d.panic = 10; this.stats.panics++; }
    });
  }

  /** How many cars the hour calls for: the streets empty out at night. */
  private target(): number {
    return Math.max(3, Math.round(this.drivers.length * (1 - 0.45 * this.game.sky.night)));
  }

  private active(): number {
    let n = 0;
    for (const d of this.drivers) if (d.v) n++;
    return n;
  }

  /** Where this browser's own player is and looks from. */
  private look(): void {
    const g = this.game, pl = g.player, a = this.own;
    a.x = pl.x; a.z = pl.z;
    // (The camera rig is built after the first cars are placed.)
    const cam = g.camera.position, rig = g.cam as Game['cam'] | undefined;
    a.cx = cam.x; a.cz = cam.z; a.yaw = rig ? rig.yaw : 0;
  }

  /**
   * Is (x, z) a fair place for something to appear or vanish, whoever is in town? At least `near` from everybody,
   * and for each of them either behind their view or at least `front` from it (0 = anywhere).
   */
  private unseen(x: number, z: number, near: number, front: number): boolean {
    for (const a of this.anchors) {
      const dx = x - a.x, dz = z - a.z;
      if (dx * dx + dz * dz < near * near) return false;
      if (front <= 0) continue;
      const cx = x - a.cx, cz = z - a.cz;
      if (cx * Math.sin(a.yaw) + cz * Math.cos(a.yaw) >= 0 && cx * cx + cz * cz <= front * front) return false;
    }
    return true;
  }

  update(dt: number, peds: readonly RoadPed[], jumped: boolean): void {
    const g = this.game;
    this.peds = peds;
    if (this.walkers.length > 0) {
      const all = this.allPeds;
      all.length = 0;
      for (const p of peds) all.push(p);
      for (const p of this.walkers) all.push(p);
      this.peds = all;
    }
    this.frame++;
    this.look();
    this.own.jumped = jumped;
    const anchors = this.anchors;
    anchors.length = 1;
    if (!this.guest) for (const a of this.extra) anchors.push(a);
    const many = anchors.length > 1;

    if (!this.guest) {
      let active = 0;
      for (const a of anchors) a.n = 0;
      for (const d of this.drivers) {
        const v = d.v;
        if (!v) continue;
        active++;
        // Whose car is it: the nearest player's.
        let best = 0, bd = Infinity;
        if (many) for (let i = 0; i < anchors.length; i++) {
          const a = anchors[i], dx = v.x - a.x, dz = v.z - a.z, d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = i; }
        }
        d.anchor = best;
        anchors[best].n++;
      }
      const target = this.target();
      // One budget of cars, shared out between everybody in town.
      const share = Math.ceil(target / anchors.length);

      for (const d of this.drivers) {
        let v = d.v;
        // Stolen or drowned: it is somebody else's car now, and an ordinary one.
        if (v && (v.driver !== 'ai' || v.sunk)) { anchors[d.anchor].n--; this.release(d); v = null; active--; }
        if (v) {
          const a = anchors[d.anchor], dx = v.x - a.x, dz = v.z - a.z, far = dx * dx + dz * dz > 185 * 185;
          // Hopelessly wedged cars are swapped for fresh ones, but never while anyone can see.
          const hopeless = (d.jams > 2 || d.still > 30 || d.halt > 45) && this.unseen(v.x, v.z, 45, 110);
          if (far || hopeless) {
            if (hopeless && !far) this.stats.removedStuck++;
            a.n--;
            this.release(d); g.vehicles.remove(v); v = null; active--;
          }
        }
        if (!v) {
          if (active >= target) continue;
          // For whoever has the fewest (alone, that is the player).
          let a = anchors[0];
          if (many) for (const b of anchors) if (b.n < a.n) a = b;
          if (a.n >= share) continue;
          if (a.jumped) for (let k = 0; k < 60 && !d.v; k++) this.seat(d, a, 25, 160, 0);
          else for (let k = 0; k < 3 && !d.v; k++) this.seat(d, a, 70, 165, 120);
          if (d.v) { active++; a.n++; d.anchor = anchors.indexOf(a); }
          continue;
        }
        this.drive(d, v, dt);
      }
      if (many && (this.balanceT -= dt) <= 0) { this.balanceT = 0.2; this.balance(share); }
    }

    // One abandoned car looked at per frame is plenty.
    const o = this.orphans;
    if (o.length > 0) {
      const i = this.frame % o.length, v = o[i];
      const gone = v.sunk || v.driver !== null || g.vehicles.list.indexOf(v) < 0;
      let d2 = Infinity;
      for (const a of anchors) { const dx = v.x - a.x, dz = v.z - a.z; d2 = Math.min(d2, dx * dx + dz * dz); }
      if (gone) { o.splice(i, 1); this.dropOrphan(v); }
      // (A car a player left stays for the town, unless there are a great many of them.)
      else if (this.kept.has(v) ? this.kept.size > KEPT_MAX && this.unseen(v.x, v.z, 60, 130) : d2 > 230 * 230 || (o.length - this.kept.size > 6 && this.unseen(v.x, v.z, 60, 130))) {
        o.splice(i, 1); this.dropOrphan(v); g.vehicles.remove(v);
      }
    }
  }

  /**
   * Somebody in town has fewer cars than their share while somebody else has more, and the budget is spent: take one
   * that nobody can see from the busiest streets. Its driver is free again, and the next frame seats it where it is wanted.
   */
  private balance(share: number): void {
    const anchors = this.anchors;
    let poor = 0, rich = 0;
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].n < anchors[poor].n) poor = i;
      if (anchors[i].n > anchors[rich].n) rich = i;
    }
    if (anchors[poor].n >= share - 1 || anchors[rich].n <= share) return;
    for (const d of this.drivers) {
      const v = d.v;
      if (!v || d.anchor !== rich || !this.unseen(v.x, v.z, 60, 110)) continue;
      anchors[rich].n--;
      this.release(d); this.game.vehicles.remove(v);
      return;
    }
  }

  // ── Multiplayer: numbers on the wire, and handing the cars over ──────────────

  /** A number no car here is using; they go round, so one is not reused the moment its car has gone. */
  private newWid(): number {
    let id = this.lastWid;
    for (let k = 0; k < 255; k++) {
      id = (id % 255) + 1;
      if (!this.widUsed[id]) break;
    }
    this.lastWid = id;
    this.widUsed[id] = 1;
    return id;
  }

  private dropOrphan(v: Vehicle): void {
    const w = this.orphanWid.get(v);
    if (w !== undefined) { this.widUsed[w] = 0; this.orphanWid.delete(v); }
    this.kept.delete(v);
  }

  /**
   * A car that is on the street with nobody in it becomes one of the town's standing cars, with a number of its own:
   * a player has got out of it, or it was parked and has been pushed. Returns the number, or 0 when there is none left.
   */
  abandon(v: Vehicle): number {
    const had = this.orphanWid.get(v);
    if (had !== undefined) return had;
    let free = false;
    for (let id = 1; id < 256 && !free; id++) free = !this.widUsed[id];
    if (!free) return 0;
    const w = this.newWid();
    if (this.orphans.indexOf(v) < 0) this.orphans.push(v);
    this.orphanWid.set(v, w);
    this.kept.add(v);
    return w;
  }

  /** The shared car with this number, if there is one. */
  find(wid: number): Vehicle | null {
    let car: Vehicle | null = null;
    this.eachShared((w, v) => { if (w === wid) car = v; });
    return car;
  }

  /** Another player is taking this car: let go of it (its driver, its number). The caller takes it off the street. */
  give(v: Vehicle): void {
    const d = this.byVeh.get(v);
    if (d) { this.release(d); return; }
    const i = this.orphans.indexOf(v);
    if (i >= 0) { this.orphans.splice(i, 1); this.dropOrphan(v); }
  }

  /** Every car the rest of the town should see: those being driven, then those their drivers walked away from. */
  eachShared(fn: (wid: number, v: Vehicle, driverless: boolean) => void): void {
    for (const d of this.drivers) if (d.v && d.v.driver === 'ai' && !d.v.sunk) fn(d.wid, d.v, false);
    for (const v of this.orphans) {
      const w = this.orphanWid.get(v);
      if (w !== undefined && v.driver === null && !v.sunk && !v.wreck) fn(w, v, true);
    }
  }

  /** Stop driving: every car is let go of (not removed) and reported, with its number. Another browser has the wheel now. */
  handOver(fn: (wid: number, v: Vehicle, driverless: boolean) => void): void {
    this.eachShared(fn);
    for (const d of this.drivers) if (d.v) this.release(d);
    const o = this.orphans;
    for (let i = o.length - 1; i >= 0; i--) if (this.orphanWid.has(o[i])) { this.dropOrphan(o[i]); o.splice(i, 1); }
    this.guest = true;
  }

  /** Stop driving and take every car off the street: the host's are about to be shown instead. */
  clearCars(): void {
    for (const d of this.drivers) {
      const v = d.v;
      if (!v) continue;
      this.release(d);
      this.game.vehicles.remove(v);
    }
    this.guest = true;
  }

  /**
   * Take the wheel of a car that is already on the street (it was the last host's): find the lane it is in from where
   * it stands and which way it points. False when it cannot be placed or there is nobody free to drive it.
   */
  adopt(v: Vehicle, wid: number, driverless: boolean): boolean {
    if (this.widUsed[wid]) return false;
    if (driverless) {
      v.driver = null;
      this.orphans.push(v);
      this.orphanWid.set(v, wid);
      this.widUsed[wid] = 1;
      this.kept.add(v);
      return true;
    }
    let d: Driver | null = null;
    for (const c of this.drivers) if (!c.v) { d = c; break; }
    if (!d) return false;
    const plan = this.game.plan, sh = Math.sin(v.h), ch = Math.cos(v.h);
    let best: RoadEdge | null = null, bestFwd = true, bestLat = 0, top = 7;
    for (const e of plan.landEdges(v.z)) {
      if (e.closed) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const along = e.horiz ? v.x - A.x : v.z - A.z;
      if (along < -8 || along > e.len + 8) continue;
      // Meters to the right of someone travelling a -> b.
      const lat0 = e.horiz ? v.z - A.z : -(v.x - A.x);
      if (Math.abs(lat0) > e.hw + 1.5) continue;
      const dot = e.horiz ? sh : ch;
      // Square across the street (half way round a corner): whichever side it is on is its side.
      const fwd = Math.abs(dot) > 0.3 ? dot > 0 : lat0 > 0;
      const lat = fwd ? lat0 : -lat0, to = fwd ? B : A, s = fwd ? along : e.len - along;
      const nl = this.lanes(e, to);
      let miss = Infinity;
      for (let l = 0; l < nl; l++) miss = Math.min(miss, Math.abs(lat - laneOff(e, l)));
      // Past the stop line it is leaving this street, not on it: the street it is turning into is the better fit.
      const leaving = s > e.len - (e.horiz ? to.hx : to.hz) - 1;
      const score = miss + (1 - Math.abs(dot)) * 6 + (lat < -0.5 ? 3 : 0) + (leaving ? 5 : 0) + (along < 0 || along > e.len ? 2 : 0);
      if (score < top) { top = score; best = e; bestFwd = fwd; bestLat = lat; }
    }
    if (!best) return false;
    const e = best, to = plan.nodes[bestFwd ? e.b : e.a], nl = this.lanes(e, to);
    let lane = 0;
    for (let l = 1; l < nl; l++) if (Math.abs(bestLat - laneOff(e, l)) < Math.abs(bestLat - laneOff(e, lane))) lane = l;
    const rng = this.rng, kind = v.spec.kind;
    v.driver = 'ai';
    d.v = v; d.e = e; d.to = to; d.lane = lane; d.turn = null;
    // From where it is: the lane is eased back into, not jumped to.
    d.off = clamp(bestLat, 0.6, e.hw - 0.8);
    d.wid = wid; this.widUsed[wid] = 1;
    this.byVeh.set(v, d);
    d.next = this.pick(d, e, to);
    this.plan(d);
    d.cruise = Math.min(rng.range(8.5, 12.5) * (e.lanes === 2 ? 1.1 : 1), SPECS[kind].topSpeed * 0.5);
    if (kind === 'bus') d.cruise = Math.min(d.cruise, 8.5);
    this.fresh(d);
    return true;
  }

  /** Back from showing somebody else's traffic to driving this browser's own. */
  resume(): void { this.guest = false; }

  private fresh(d: Driver): void {
    d.near.length = 0; d.nearT = 0;
    d.legit = d.passing = false;
    d.wait = d.honk = d.honkCool = d.lcCool = d.bold = d.stuck = d.back = d.backCool = d.jams = d.still = d.halt = d.panic = d.bail = d.swerveT = d.slowT = 0;
    d.prevStop = 99; d.yellow = 0;
  }

  private release(d: Driver): void {
    if (d.v) { this.byVeh.delete(d.v); d.v.ctl.horn = false; }
    d.v = null;
    if (d.wid) { this.widUsed[d.wid] = 0; d.wid = 0; }
  }

  // ── Routes ─────────────────────────────────────────────────────────────────

  private lanes(e: RoadEdge, to: RoadNode): number {
    return this.nLane[e.id * 2 + (this.game.plan.nodes[e.b] === to ? 1 : 0)];
  }

  /** -1 left, 0 straight, 1 right, 2 back the way it came: arriving at `at` along `e` and leaving along `n`. */
  private turnOf(e: RoadEdge, at: RoadNode, n: RoadEdge): number {
    if (n === e) return 2;
    if (n.horiz === e.horiz) return 0;
    const plan = this.game.plan;
    const sg = plan.nodes[e.b] === at ? 1 : -1, dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    const ng = n.a === at.id ? 1 : -1, nx = n.horiz ? ng : 0, nz = n.horiz ? 0 : ng;
    // Travelling along (dx, dz), the right-hand side is (-dz, dx).
    return nx * -dz + nz * dx > 0 ? 1 : -1;
  }

  /** The street to take on arriving at `at` along `e`: usually straight on. Long vehicles avoid tight rights and side streets. */
  private pick(d: Driver, e: RoadEdge, at: RoadNode): RoadEdge {
    const plan = this.game.plan, long = d.v !== null && d.v.hl > 3.2;
    let best = e, top = 0;
    for (const id of at.edges) {
      if (id === e.id) continue;
      const c = plan.edges[id];
      // Behind construction barriers, or a bridge with no far end. (No dice drawn for it: the island's traffic rolls as it always did.)
      if (c.closed) continue;
      let k = (c.horiz === e.horiz ? 2.2 : 1) * (0.2 + this.rng.next());
      if (long) {
        if (c.lanes === 2) k *= 5;
        if (this.turnOf(e, at, c) === 1) k *= c.lanes === 2 ? 0.5 : 0.1;
      }
      if (k > top) { top = k; best = c; }
    }
    return best;
  }

  /** After choosing `next`: which way that is, and so which lane to be in when the junction comes. */
  private plan(d: Driver): void {
    d.turnKind = this.turnOf(d.e, d.to, d.next);
    const n = this.lanes(d.e, d.to);
    d.wantLane = d.turnKind === -1 ? 0 : d.turnKind === 1 ? n - 1 : Math.min(d.home, n - 1);
    if (d.lane > n - 1) d.lane = n - 1;
  }

  private kindFor(district: District | null, avenue: boolean): VehicleKind {
    const rng = this.rng, r = rng.next();
    if (avenue && r < 0.11) {
      let buses = 0;
      for (const d of this.drivers) if (d.v && d.v.spec.kind === 'bus') buses++;
      if (buses < 2) return 'bus';
    }
    const cabs = district === 'downtown' || district === 'strand' ? 0.3 : district === 'industrial' || district === 'port' ? 0.03 : 0.1;
    if (r < 0.11 + cabs) return 'taxi';
    if (district === 'industrial' || district === 'port') {
      const w = rng.next();
      if (w < 0.38) return 'pickup';
      if (w < 0.7) return 'van';
      if (w < 0.76) return 'tow';
    }
    // The everyday mix, less the ones with a job to do: no cruisers until there are police to drive them.
    for (let k = 0; k < 6; k++) {
      const kind = commonKind(rng.next());
      if (kind !== 'bus' && kind !== 'cruiser' && kind !== 'taxi' && kind !== 'tow') return kind;
    }
    return 'sedan';
  }

  /** Try one random spot in a lane; on success a new car is driving there. */
  private seat(d: Driver, a: Anchor, near: number, far: number, front: number): boolean {
    const g = this.game, plan = g.plan, rng = this.rng;
    // The streets of the land the player is on: a pick from the whole world would land out of range most of the time.
    const e = rng.pick(plan.landEdges(a.z)), fwd = rng.chance(0.5);
    if (e.closed) return false;
    // The avenues carry the traffic; the side streets get what is left.
    if (e.lanes === 1 && rng.chance(0.4)) return false;
    const from = plan.nodes[fwd ? e.a : e.b], to = plan.nodes[fwd ? e.b : e.a];
    const s0 = (e.horiz ? from.hx : from.hz) + 12, s1 = e.len - (e.horiz ? to.hx : to.hz) - 16;
    if (s1 <= s0) return false;
    const s = rng.range(s0, s1), sg = fwd ? 1 : -1;
    const dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    const nl = this.lanes(e, to);
    const kind = this.kindFor(plan.districtAt(from.x + dx * s, from.z + dz * s), e.lanes === 2);
    // The bus keeps to the kerb lane, as buses do.
    const lane = kind === 'bus' ? nl - 1 : rng.int(0, nl - 1), off = laneOff(e, lane);
    const x = from.x + dx * s - dz * off, z = from.z + dz * s + dx * off;
    if ((x - a.x) * (x - a.x) + (z - a.z) * (z - a.z) > far * far || !this.unseen(x, z, near, front)) return false;
    for (const o of g.vehicles.list) {
      const ox = o.x - x, oz = o.z - z;
      if (Math.abs(ox * dx + oz * dz) < 13 + o.hl && Math.abs(-ox * dz + oz * dx) < 2.3) return false;
    }
    for (const o of this.others) {
      const ox = o.x - x, oz = o.z - z;
      if (Math.abs(ox * dx + oz * dz) < 13 + o.hl && Math.abs(-ox * dz + oz * dx) < 2.3) return false;
    }
    const v = g.vehicles.spawn(kind, x, z, Math.atan2(dx, dz));
    v.driver = 'ai';
    d.v = v; d.e = e; d.to = to; d.lane = lane; d.off = off; d.turn = null;
    d.wid = this.newWid();
    this.byVeh.set(v, d);
    d.next = this.pick(d, e, to);
    this.plan(d);
    d.cruise = Math.min(rng.range(8.5, 12.5) * (e.lanes === 2 ? 1.1 : 1), SPECS[kind].topSpeed * 0.5);
    if (kind === 'bus') d.cruise = Math.min(d.cruise, 8.5);
    this.fresh(d);
    // Already rolling, so a street does not fill with cars pulling away at once.
    v.vx = dx * d.cruise * 0.7; v.vz = dz * d.cruise * 0.7;
    return true;
  }

  // ── Driving ────────────────────────────────────────────────────────────────

  /** Is the lane `off` meters right of the centerline empty between a0 and a1 along the street (measured from `from`)? */
  private laneClear(d: Driver, v: Vehicle, from: RoadNode, dx: number, dz: number, off: number, a0: number, a1: number, ignore: Vehicle | null): boolean {
    for (const o of d.near) {
      if (o === v || o === ignore) continue;
      const rx = o.x - from.x, rz = o.z - from.z, a = rx * dx + rz * dz;
      if (a < a0 - o.hl || a > a1 + o.hl) continue;
      if (Math.abs(-rx * dz + rz * dx - off) < 1 + Math.max(o.hw, 0.9)) return false;
    }
    return true;
  }

  /** Clear road behind the tail, in meters (99 when there is nobody there). */
  private rearGap(d: Driver, v: Vehicle, sh: number, ch: number): number {
    let gap = 99;
    for (const o of d.near) {
      const ox = o.x - v.x, oz = o.z - v.z, lf = ox * sh + oz * ch;
      if (lf >= 0 || lf < -(v.hl + o.hl + 6) || Math.abs(-ox * ch + oz * sh) > v.hw + o.hw + 0.4) continue;
      gap = Math.min(gap, -lf - v.hl - o.hl);
    }
    return gap;
  }

  /** Crossing into the junction: set up the curve to the lane of the street being taken, and choose the one after. */
  private enterNode(d: Driver, v: Vehicle): void {
    const plan = this.game.plan, n = d.to, old = d.e, nx = d.next;
    const sg = plan.nodes[old.b] === n ? 1 : -1, dx = old.horiz ? sg : 0, dz = old.horiz ? 0 : sg;
    const nto = plan.nodes[plan.other(nx, n.id)];
    const ng = plan.nodes[nx.b] === nto ? 1 : -1, ndx = nx.horiz ? ng : 0, ndz = nx.horiz ? 0 : ng;
    const kind = d.turnKind, nl = this.lanes(nx, nto);
    // A right turn takes the kerb lane, except for long vehicles, which need the room of the inner one.
    const lane = kind === 1 ? (v.hl > 3.2 ? 0 : nl - 1) : kind === -1 ? 0 : Math.min(d.lane, nl - 1);
    if (kind === 2) d.jams = 9;
    if (kind === 1 || kind === -1) {
      const ext = turnExt(kind), h0 = (old.horiz ? n.hx : n.hz) + ext, h1 = (nx.horiz ? n.hx : n.hz) + ext, o1 = laneOff(nx, lane);
      const x0 = n.x - dx * h0 - dz * d.off, z0 = n.z - dz * h0 + dx * d.off;
      const x3 = n.x + ndx * h1 - ndz * o1, z3 = n.z + ndz * h1 + ndx * o1;
      // The two lane lines meet at a corner; how far each end of the curve is from it.
      const a = Math.abs(old.horiz ? x3 - x0 : z3 - z0), b = Math.abs(old.horiz ? z3 - z0 : x3 - x0);
      // A right turn is a quarter circle. A left turn has short handles, so it cuts across early:
      // two cars turning left from opposite sides then pass in front of each other instead of meeting in the middle.
      const k = kind === 1 ? 0.55 : 0.3, r = Math.min(a, b) * (kind === 1 ? 1 : 0.6);
      d.turn = {
        x0, z0, x1: x0 + dx * a * k, z1: z0 + dz * a * k, x2: x3 - ndx * b * k, z2: z3 - ndz * b * k, x3, z3,
        u: 0, vmax: clamp(Math.sqrt(2.3 * r), 2.6, 7) * (v.hl > 3.2 ? 0.8 : 1),
      };
      d.off = o1;
    } else d.turn = null;
    d.e = nx; d.to = nto; d.lane = lane;
    d.passing = false;
    d.prevStop = 99; d.yellow = 0;
    d.next = this.pick(d, nx, nto);
    this.plan(d);
  }

  private drive(d: Driver, v: Vehicle, dt: number): void {
    const g = this.game, plan = g.plan, ctl = v.ctl;
    let e = d.e, to = d.to;
    let fwd = plan.nodes[e.b] === to;
    let from = plan.nodes[fwd ? e.a : e.b];
    let sg = fwd ? 1 : -1, dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    let s = (v.x - from.x) * dx + (v.z - from.z) * dz;
    if (s > e.len - (e.horiz ? to.hx : to.hz) - turnExt(d.turnKind)) {
      this.enterNode(d, v);
      from = to; e = d.e; to = d.to;
      fwd = plan.nodes[e.b] === to;
      sg = fwd ? 1 : -1; dx = e.horiz ? sg : 0; dz = e.horiz ? 0 : sg;
      s = (v.x - from.x) * dx + (v.z - from.z) * dz;
    }
    const endHalf = e.horiz ? to.hx : to.hz, startHalf = e.horiz ? from.hx : from.hz;
    const sp = v.speed, sh = Math.sin(v.h), ch = Math.cos(v.h);
    const long = v.hl > 3.2, nl = this.lanes(e, to);

    if ((d.nearT -= dt) <= 0) {
      d.nearT = 0.22 + (v.id % 5) * 0.012;
      d.near.length = 0;
      for (const o of g.vehicles.list) {
        if (o === v) continue;
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox < 62 && ox > -62 && oz < 62 && oz > -62) d.near.push(o);
      }
      // The other players' cars: not this browser's to simulate, but very much in the way.
      for (const o of this.others) {
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox < 62 && ox > -62 && oz < 62 && oz > -62) d.near.push(o);
      }
    }
    // Distance from the nose to where it would stop for the junction.
    const stop = e.len - endHalf - LINE - v.hl - s;

    // ── Lane keeping ──
    if (d.lcCool > 0) d.lcCool -= dt;
    if (!d.turn && !d.passing) {
      if (d.lane !== d.wantLane && d.lcCool <= 0) {
        if (stop > 20) {
          if (this.laneClear(d, v, from, dx, dz, laneOff(e, d.wantLane), s - 9 - sp * 0.6, s + 13 + sp * 0.6, null)) { d.lane = d.wantLane; d.lcCool = 3; }
        } else if (d.turnKind !== 0 && stop > 4) {
          // Never made it across to the lane for the turn: go straight on instead, if the street does.
          for (const id of to.edges) {
            const c = plan.edges[id];
            if (c !== e && c.horiz === e.horiz && !c.closed) { d.next = c; this.plan(d); d.wantLane = d.lane; break; }
          }
        }
      }
    }
    const myLat = -(v.x - from.x) * dz + (v.z - from.z) * dx;
    let tOff = laneOff(e, Math.min(d.lane, nl - 1));
    if (d.passing) {
      tOff = d.passOff;
      const alongside = s + v.hl > d.passAt - 1;
      if (s > d.passEnd) d.passing = false;
      // Something coming the other way: stay put if not yet out of the lane; once out, get it over with (they will wait).
      else if (!alongside && Math.abs(myLat - laneOff(e, 0)) < 0.8 && Math.abs(sh * dx + ch * dz) > 0.99 && !this.laneClear(d, v, from, dx, dz, d.passOff, s + 2, s + 32, null)) { d.passing = false; d.lcCool = 4; }
    }
    const drift = clamp(0.3 + Math.abs(sp) * 0.22, 0.3, 1.7) * dt;
    d.off += clamp(tOff - d.off, -drift, drift);

    // ── Where to steer ──
    const look = clamp(3 + 0.5 * Math.abs(sp), 4.5, 11);
    let cx: number, cz: number;
    const t = d.turn;
    if (t) {
      const L = clamp(2.2 + 0.45 * Math.abs(sp), 3, 7);
      let bx = 0, bz = 0;
      for (;;) {
        const u = t.u, w = 1 - u;
        const k0 = w * w * w, k1 = 3 * w * w * u, k2 = 3 * w * u * u, k3 = u * u * u;
        bx = k0 * t.x0 + k1 * t.x1 + k2 * t.x2 + k3 * t.x3; bz = k0 * t.z0 + k1 * t.z1 + k2 * t.z2 + k3 * t.z3;
        if (u >= 1 || (bx - v.x) * (bx - v.x) + (bz - v.z) * (bz - v.z) > L * L) break;
        t.u = Math.min(1, u + 0.04);
      }
      cx = bx; cz = bz;
      if (t.u >= 1) {
        // Off the end of the curve: carry the aim point on up the lane.
        const rest = L - Math.hypot(bx - v.x, bz - v.z);
        if (rest > 0) { cx += dx * rest; cz += dz * rest; }
        if (s > startHalf + 1.5) d.turn = null;
      }
    } else {
      const st = Math.max(s + look, startHalf + 2);
      cx = from.x + dx * st - dz * d.off; cz = from.z + dz * st + dx * d.off;
    }
    let err = Math.atan2(cx - v.x, cz - v.z) - v.h;
    err -= Math.round(err / TAU) * TAU;

    const panic = d.panic > 0;
    if (panic) d.panic -= dt;
    let want = (panic ? Math.min(d.cruise * 1.7, v.spec.topSpeed * 0.75) : d.cruise) * (1 - 0.62 * Math.min(1, Math.abs(err) * 1.3));
    if (t) want = Math.min(want, t.vmax);
    if (d.passing) want = Math.min(want, 7);

    // ── The junction ahead ──
    let hold = false;
    const kind = d.turnKind;
    if (stop > -1.2 && !t) {
      if (kind !== 0) want = Math.min(want, (kind === 1 ? 3.4 : 4.6) * (long ? 0.8 : 1) + Math.max(0, stop + LINE) * 0.35);
      if (stop < 50) {
        if (to.hasLight) {
          const sig = g.world.signal(to.id, e.horiz);
          // A yellow too close to stop for is driven through. Decided once, at the first sight of it:
          // asked again every frame, a car braking for the line talks itself out of stopping just short of it.
          if (sig === 'green') d.yellow = 0;
          else if (sig === 'yellow' && d.yellow === 0) d.yellow = stop > sp * sp / 11 + 0.5 ? 1 : 2;
          if (sig === 'red' || d.yellow === 1) hold = true;
        } else if (to.edges.length > 2 && stop < 14) {
          // No signal: whoever is coming from the right goes first.
          for (const o of d.near) {
            const rx = o.x - to.x, rz = o.z - to.z, r = -rx * dz + rz * dx, a = rx * dx + rz * dz;
            if (r > 3 && r < 22 && Math.abs(a) < 9 && o.vx * dz - o.vz * dx > 1.5) { hold = true; break; }
          }
        }
        if (!hold && stop < 9) {
          const n = d.next, nto = plan.nodes[plan.other(n, to.id)];
          const ng = plan.nodes[n.b] === nto ? 1 : -1, ndx = n.horiz ? ng : 0, ndz = n.horiz ? 0 : ng;
          const nh = n.horiz ? to.hx : to.hz, room = nh + 2 * v.hl + 3.5;
          for (const o of d.near) {
            if (o === v) continue;
            const rx = o.x - to.x, rz = o.z - to.z;
            const a = rx * ndx + rz * ndz, r = -rx * ndz + rz * ndx;
            // Never block the box: no going in until there is room to come out the far side.
            if (kind !== 2 && a > nh - 1 && a - o.hl < room && r > -0.3 && r < n.hw - 2 && o.vx * ndx + o.vz * ndz < 1.5) {
              if (kind !== 0 || Math.abs(r - d.off) < 2.2) { hold = true; break; }
            }
            // Turning left across the oncoming lanes: wait for a gap.
            if (kind === -1) {
              const oa = rx * dx + rz * dz, or = -rx * dz + rz * dx, ov = -(o.vx * dx + o.vz * dz);
              if (or < 0.5 && or > -e.hw - 1 && oa > -endHalf - 2 && oa < endHalf + 34) {
                if (ov > 2 && (oa + endHalf) / ov < 5.5) { hold = true; break; }
                // Or waiting at its own line to come straight across: it was there first.
                const od = this.byVeh.get(o);
                if (od && od.turnKind !== -1 && od.to === to && oa < endHalf + 13 && -(Math.sin(o.h) * dx + Math.cos(o.h) * dz) > 0.7) { hold = true; break; }
              }
            }
          }
        }
        if (hold) want = Math.min(want, stop < 0.7 ? 0 : Math.sqrt(4.6 * stop));
      }
    }
    // The instant the nose crosses the line, for the record: was it red?
    if (d.prevStop > -0.9 && stop <= -0.9 && to.hasLight && g.world.signal(to.id, e.horiz) === 'red') {
      this.stats.redRuns++;
      this.stats.note += `red ${v.spec.kind} sp=${sp.toFixed(1)} prev=${d.prevStop.toFixed(2)} stop=${stop.toFixed(2)} kind=${kind} hold=${hold} bold=${d.bold > 0} back=${d.back > 0} sw=${d.swerveT > 0} panic=${d.panic > 0}; `;
    }
    d.prevStop = t ? 99 : stop;

    // ── Who is in the way ──
    const bold = d.bold > 0;
    if (bold) { d.bold -= dt; want = Math.min(want, 1.6); }
    // Part-way into another lane (a pass, a lane change), the thing being gone round may be crept right up to:
    // held at the usual distance, a car stopped behind an obstacle has no room to swing out past it.
    const out = !t && (d.passing || Math.abs(myLat - tOff) > 0.8);
    const margin = bold ? -0.2 : 0.4, keep = bold ? 0.5 : out ? 0.7 : GAP, keepP = bold || out ? 0.9 : 2.6;
    let blocker: Vehicle | null = null, blockLegit = false, blockX = 0, blockZ = 0, blockHl = 0.6, blocked = false, emergency = 0;
    let leadSlow = false, onFoot = false, headOn = false;
    for (const o of d.near) {
      const ox = o.x - v.x, oz = o.z - v.z;
      const lf = ox * sh + oz * ch;
      if (lf <= 0 || lf > 44) continue;
      const lat = -ox * ch + oz * sh;
      const hd = sh * Math.sin(o.h) + ch * Math.cos(o.h), c = Math.abs(hd), sn = Math.sqrt(Math.max(0, 1 - c * c));
      const oF = o.vx * sh + o.vz * ch;
      // The other car's reach along and across this one's nose, whichever way it is turned.
      const reach = o.hw * c + o.hl * sn;
      // Something coming the other way in its own lane is passing, not stopping: it needs clearance and no more.
      const band = hd < -0.5 && oF < -1 ? v.hw + reach + 0.15 : v.hw + reach + margin;
      if (Math.abs(lat) > band) continue;
      const gap = lf - v.hl - (o.hl * c + o.hw * sn);
      if (gap > 32) continue;
      // Nose to nose with something in this lane (somebody overtaking, mostly): stop well short and leave it room to tuck back in.
      // (In this lane: its middle is on this side of the centerline, or near enough. A car waiting in its own lane opposite does not count.)
      const facing = !t && !out && hd < -0.8 && oF < 1 && -(o.x - from.x) * dz + (o.z - from.z) * dx > -0.5, kp = facing ? 15 : keep;
      const of = Math.max(0, oF), room = Math.max(0, gap - kp);
      // Follow distance grows with speed: 0.7 s of headway on top of the standing gap.
      let lim = Math.min(Math.sqrt(5 * room) + of, Math.max(0, of + (gap - kp - 0.7 * sp) * 0.9));
      if (gap < kp && of < 1) lim = 0;
      const closing = sp - oF;
      // Cut off: something suddenly close and much slower. Stand on the brake and lean away from it.
      if (gap < 8 && closing > 3 && closing * closing / (2 * Math.max(gap - 0.5, 0.3)) > 5.5) emergency = lat >= 0 ? -1 : 1;
      if (lim < want) {
        want = lim;
        if (lim < cruiseSlow(d.cruise) && of < d.cruise - 3) leadSlow = true;
        if (lim < 0.6) {
          blocked = true; blocker = o; blockX = o.x; blockZ = o.z; blockHl = o.hl * c + o.hw * sn; headOn = facing && gap < 7;
          const od = this.byVeh.get(o);
          // A queue is only a queue if it faces the same way: two cars nose to nose are a standoff, not a line.
          blockLegit = od !== undefined && hd > 0.5 && (od.legit || oF > 1.5);
        }
      }
    }
    // People: the player on foot and anyone walking, standing or lying in the road.
    const pl = g.player, reachP = 7 + sp * 1.9;
    const np = this.peds.length + (pl.vehicle ? 0 : 1);
    for (let i = 0; i < np; i++) {
      let ox: number, oz: number, pvx = 0, pvz = 0;
      if (i < this.peds.length) { const p = this.peds[i]; ox = p.x - v.x; oz = p.z - v.z; pvx = p.vx; pvz = p.vz; }
      else { if (Math.abs(pl.y - v.y) > 2) continue; ox = pl.x - v.x; oz = pl.z - v.z; }
      if (ox > 40 || ox < -40 || oz > 40 || oz < -40) continue;
      let lf = ox * sh + oz * ch - v.hl, lat = -ox * ch + oz * sh;
      // In a turn the nose is not where the car is going: look along the line to the aim point as well.
      if (t && (lf < -1 || Math.abs(lat) > v.hw + 1)) {
        const ax = cx - v.x, az = cz - v.z, al = Math.hypot(ax, az) || 1;
        lf = (ox * ax + oz * az) / al - v.hl; lat = (-ox * az + oz * ax) / al;
      }
      if (lf < -1 || lf > reachP) continue;
      // Where they will be across the nose in a second or so, if they keep walking.
      const lat2 = lat + (-pvx * ch + pvz * sh) * 1.2, w = v.hw + (bold ? 0.35 : 0.9);
      if (Math.abs(lat) > w && Math.abs(lat2) > w && lat * lat2 > 0) continue;
      const lim = lf < keepP ? 0 : Math.sqrt(5 * (lf - keepP));
      if (lim < want) {
        want = lim;
        if (lim < 0.6) { blocked = true; blocker = null; blockLegit = false; blockX = v.x + ox; blockZ = v.z + oz; blockHl = 0.6; onFoot = i < this.peds.length; }
      }
    }

    // ── Held up ──
    const halted = want < 0.6 && sp < 1;
    // Only at the line itself is the light the reason for standing still.
    const atLine = hold && halted && stop < 4;
    // Waiting for somebody to finish crossing is as good a reason as a light: the cars behind sit tight too.
    d.legit = atLine || (blocked && (blockLegit || onFoot));
    d.wait = halted && blocked && !blockLegit ? d.wait + dt : Math.max(0, d.wait - dt * 3);
    d.slowT = leadSlow && !blocked ? d.slowT + dt : 0;
    d.still = Math.abs(sp) < 0.3 && !d.legit ? d.still + dt : 0;
    d.halt = Math.abs(sp) < 0.3 ? d.halt + dt : 0;
    if (this.debug) d.why = blocked ? (blocker ? blocker.spec.kind + (blocker.driver ?? '-') : onFoot ? 'ped' : 'player') + `@${blockX.toFixed(0)},${blockZ.toFixed(0)}` : hold ? 'hold' : '';
    if (d.honkCool > 0) d.honkCool -= dt;
    if (d.honk > 0) d.honk -= dt;
    // People crossing get patience; a car sitting in the lane gets the horn.
    if (d.wait > (onFoot ? 7 : 2) && d.honkCool <= 0) { d.honk = 0.45; d.honkCool = 5.5; this.stats.honks++; }
    ctl.horn = d.honk > 0;
    const bAlong = (blockX - from.x) * dx + (blockZ - from.z) * dz;
    if (!t && !d.passing && d.lcCool <= 0 && s > startHalf + 10 && ((d.wait > (onFoot ? 8 : 3.5) && blocked) || (d.slowT > 3 && nl === 2 && stop > 30))) {
      if (nl === 2) {
        // An avenue: move over if the other lane has room.
        const other = 1 - Math.min(d.lane, 1);
        if (this.laneClear(d, v, from, dx, dz, laneOff(e, other), s - 9 - sp * 0.6, s + 15 + sp, blocker)) {
          d.lane = other; d.lcCool = 7; d.wait = 0; d.slowT = 0; this.stats.passes++;
        }
      } else if (blocked && stop > 30 && bAlong < e.len - endHalf - 22
        // (and with somewhere to come back in: a second car stopped beyond the first is a queue, not an obstruction)
        && this.laneClear(d, v, from, dx, dz, laneOff(e, 0), bAlong + blockHl + 1.5, bAlong + blockHl + 2 * v.hl + 7, blocker)
        && this.laneClear(d, v, from, dx, dz, -laneOff(e, 0), s - 2, Math.min(s + 62, e.len - endHalf - 1), blocker)) {
        // A street: out round it on the wrong side, but only with a long clear view of the oncoming lane.
        d.passing = true; d.passOff = -laneOff(e, 0); d.passAt = bAlong - blockHl; d.passEnd = bAlong + blockHl + v.hl + 1.5;
        d.wait = 0; this.stats.passes++;
      }
    }
    // Two cars each waiting for the other would wait all day. One of them (the lower number) edges
    // through at a crawl, stopping for real contact only; nobody is pushed through anybody.
    if (d.wait > 11 && !bold) {
      const od = blocker ? this.byVeh.get(blocker) : undefined;
      if (!od || od.bold <= 0) { d.bold = 4; d.wait = 5; }
    }

    // After a knock: pull up, and the driver gets out and leaves it.
    if (d.bail > 0) {
      d.bail -= dt;
      want = 0;
      if (Math.abs(sp) < 0.5 || d.bail <= 0) {
        ctl.accel = 0; ctl.steer = 0; ctl.handbrake = true; ctl.horn = false;
        v.driver = null;
        const door = { x: v.x, z: v.z };
        v.doorPos(-1, door);
        this.orphans.push(v);
        // It keeps its number: the rest of the town goes on seeing the same car, standing.
        const w = d.wid;
        d.wid = 0;
        if (w) this.orphanWid.set(v, w);
        this.release(d);
        this.onBail?.(v, door.x, door.z);
        return;
      }
    }

    // Pinned on something the lane logic knows nothing about: back off and try again, if there is room behind.
    if (want > 1.5 && Math.abs(sp) < 0.4) d.stuck += dt; else if (Math.abs(sp) > 1.5) d.stuck = 0;
    // Stopped askew with its nose at a parked car (after a swerve, say): there is no steering out of that standing still.
    const askew = blocked && blocker !== null && blocker.driver === null && d.wait > 1.5 && Math.abs(err) > 0.1 && d.back <= 0;
    // Or meaning to go round something it has stopped right behind: it needs room to swing out.
    const boxedIn = blocked && halted && !blockLegit && !t && d.back <= 0
      // ... or nose to nose with somebody who needs the room to get back into their own lane.
      && ((Math.abs(myLat - tOff) > 1 && d.wait > 1.2) || (headOn && d.wait > 4));
    // One step back, then a fair try at going forward: backing off again at once walks the car backwards up the street.
    if (d.backCool > 0) d.backCool -= dt;
    if (d.stuck > 4 || ((askew || boxedIn) && d.backCool <= 0)) {
      if (d.stuck > 4) d.jams++;
      d.stuck = 0;
      if (this.rearGap(d, v, sh, ch) > 1.2) { d.back = d.stuck > 4 ? 1.3 : 1; d.backCool = 5; if (askew || boxedIn) d.wait = 0; }
    }
    let steer = clamp(-err * 1.9, -1, 1);
    if (d.back > 0) {
      d.back -= dt;
      // As far back as there is room for, and no further.
      if (this.rearGap(d, v, sh, ch) < 0.6) d.back = 0;
      else { ctl.accel = -0.7; ctl.steer = -steer; ctl.handbrake = false; return; }
    }
    if (emergency !== 0 && sp > 3) {
      if (d.swerveT <= 0) this.stats.swerves++;
      d.swerve = emergency; d.swerveT = 0.35;
    }
    if (d.swerveT > 0) {
      d.swerveT -= dt;
      steer = clamp(steer + d.swerve * 0.2, -1, 1);
      ctl.steer = steer; ctl.handbrake = false; ctl.accel = sp > 0.5 ? -1 : 0;
      return;
    }
    ctl.steer = steer;
    if (want < 0.25 && sp < 0.8) { ctl.accel = 0; ctl.handbrake = true; return; }
    ctl.handbrake = false;
    const dv = want - sp;
    // Negative accel is the brake only while rolling forward; at rest it would select reverse.
    ctl.accel = dv > 0 ? Math.min(1, dv * 0.45 + 0.08) : dv < -0.7 && sp > 0.5 ? Math.max(-1, dv * 0.5) : 0;
  }
}

/** Below this a driver counts the car in front as dawdling. */
const cruiseSlow = (cruise: number): number => cruise - 2.5;
