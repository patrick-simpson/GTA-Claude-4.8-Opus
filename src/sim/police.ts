// Heat and the Harbor Patrol.
//
// Heat is a number of points, 0..5; the whole part is the level the HUD shows
// as beacon pips. A crime only adds points if somebody could have seen it (a
// pedestrian or an officer in range with a clear line), and heat only falls
// while no officer can see the player: a search clock runs, slowly inside a
// shrinking circle round the last place they were seen and at full speed
// outside it, and each time it runs out one level comes off.
//
// Cruisers are ordinary Vehicles driven through `ctl`, like traffic, so they
// can be shunted, blocked and stolen. They are made on the road network out of
// sight, find their way with plan.findPath, and are taken away again only when
// far off or out of sight. Officers on foot are ordinary People.
//
// Multiplayer (src/net/police.ts). Heat is always this browser's own player's. In a shared town the police are one
// set, run by the host: its `others` are the other players as Suspects, each car and officer has a `target`, and the
// one budget of cars is shared among everybody wanted. A guest runs no police of its own: the host's cars and
// officers are in `units` and `cops` marked `shown`, so that heat, witnesses, the light bars and the sirens work as
// alone, and whether they can see the player (and so when she has got away) is judged here. Alone, `others` is empty
// and every target is the player: the code takes the same steps in the same order as before there were Suspects.
//
// What the look of it is (light bars, helicopter, the two frontages) lives in
// policeAir.ts. Sound is milestone 5: the 'siren' event and `status.sirens`
// are there for it to hook.

import type { Game } from '../core/game';
import type { Look, Person, Vehicle } from '../core/api';
import { RNG, TAU, clamp, clamp01, lerp, money } from '../core/util';
import { groundAt, isWater, type RoadNode } from '../world/plan';
import { Beacons, Heli, frontage } from './policeAir';

/** Pursuit cars wanted at each level, before quality scaling. Roadblock pairs come on top from level 3. */
const PURSUERS = [0, 1, 3, 3, 4, 5];
/** Top speed the drivers allow themselves at each level, m/s. A sedan does 42. */
const SPEED_CAP = [14, 36, 42, 47, 54, 58];
/** How far an officer in a car, and one on foot, can recognise the player. */
const SEE_CAR = 95, SEE_FOOT = 70;
/** A bystander has to be this close to count as a witness. */
const WITNESS = 42;
const RUN = 5.6;
const RESPRAY_FEE = 200;

export interface HeatStatus {
  level: number;
  /** An officer (or the helicopter) can see the player right now. */
  seen: boolean;
  /** Nobody has seen the player for a few seconds: the search clock is running. */
  searching: boolean;
  /** Seconds until the next level comes off, at the rate it is running now. */
  timeLeft: number;
  /** The search circle: center (last place seen) and radius. */
  x: number; z: number; radius: number;
  /** Cruisers out, and how many of those have the bar lit. */
  units: number; sirens: number;
  helicopter: boolean;
}

/**
 * Somebody the Patrol may be after. Alone there is one: this browser's own player (id 0). The host of a shared town
 * (src/net/police.ts) has one more for every other player, filled in from what their browsers send.
 */
export interface Suspect {
  id: number;
  x: number; y: number; z: number;
  speed: number; vx: number; vz: number;
  vehicle: Vehicle | null;
  /** Lying in the road, or dead: not shot at, not booked. Never set for this browser's own player. */
  out: boolean;
  level: number;
  /** In a car nobody saw them get into. */
  incognito: boolean;
  /** Where they were last seen, when (game time), and how wide the search is. */
  kx: number; kz: number; lastSeen: number; radius: number;
  hold: number; holdWas: number; holdTold: boolean;
  spawnT: number; blockT: number;
  /** This suspect's share of the one budget of cars, worked out each frame. */
  wantP: number; wantB: number;
  /** Host: nothing this player's browser says about its heat is believed before this (game time): it has just been booked. */
  quiet: number;
}

export function blankSuspect(id: number): Suspect {
  return {
    id, x: 0, y: 0, z: 0, speed: 0, vx: 0, vz: 0, vehicle: null, out: false, level: 0, incognito: false,
    kx: 0, kz: 0, lastSeen: -99, radius: 0, hold: 0, holdWas: 0, holdTold: false, spawnT: 0, blockT: 0, wantP: 0, wantB: 0, quiet: 0,
  };
}

export interface Unit {
  v: Vehicle;
  /** Whom this car is after. */
  target: Suspect;
  /** Multiplayer guest: one of the host's cars, shown here. It is watched (can it see the player?) and lit, never driven. */
  shown: boolean;
  /** Its number in the town's traffic frames (0 when the police are private). */
  wid: number;
  /** Taken over from the last host: seconds left to find out whom it was after. */
  adoptT: number;
  /** Host, after another player: it can see this browser's own (wanted) player all the same. */
  seesMe: boolean;
  role: 'pursue' | 'block';
  /** drive: after the player. park: stopped with the crew out. leave: stood down, driving off. */
  state: 'drive' | 'park' | 'leave';
  path: number[]; pi: number; pathT: number;
  /** Which side of the player this car favours (-1 left, 1 right), so two cars take a side each. */
  side: number;
  crew: Cop[];
  sees: boolean; seeT: number;
  stuck: number; rev: number; jam: number;
  /** Roadblock slot, and whether the junction before it has been reached. */
  sx: number; sz: number; nx: number; nz: number; atNode: boolean;
  /** Seconds this car has been trying to get to its roadblock slot. */
  bT: number;
  /** Search wander point when the player is nowhere to be seen. */
  wx: number; wz: number; wT: number;
  arrived: boolean;
  phase: number;
}

export interface Cop {
  p: Person;
  unit: Unit | null;
  target: Suspect;
  /** Multiplayer guest: one of the host's officers, shown here in a borrowed body. */
  shown: boolean;
  /** Their number in the town's people frames (0 when the police are private). */
  wid: number;
  /** Who last hurt them: 0 this browser's player, otherwise another player's number. */
  by: number;
  /** Host, after another player: they can see this browser's own (wanted) player all the same. */
  seesMe: boolean;
  /** chase the player, guard a roadblock, or go back to the car. */
  mode: 'chase' | 'guard' | 'return';
  sees: boolean; seeT: number;
  fireT: number;
  stuck: number; sideT: number; sideS: number;
  /** Seconds left lying in the road after being run down. */
  down: number;
  dead: boolean;
  gx: number; gz: number;
}

interface Pending { kind: string; x: number; z: number; weight: number; sure?: boolean }

const wrap = (a: number): number => a - Math.round(a / TAU) * TAU;

export class Police {
  readonly tag = 'police';
  readonly status: HeatStatus = { level: 0, seen: false, searching: false, timeLeft: 0, x: 0, z: 0, radius: 0, units: 0, sirens: 0, helicopter: false };
  readonly units: Unit[] = [];
  readonly cops: Cop[] = [];
  /** Counters and timings for the check scripts. */
  readonly stats = {
    ms: 0, max: 0, sum: 0, n: 0,
    crimes: 0, unseen: 0, spawned: 0, recycled: 0, blocks: 0, shots: 0, hits: 0, booked: 0, bookedOthers: 0, resprays: 0, drops: 0, rams: 0, tips: 0,
    /** Seconds from each rise in level to the first cruiser within 40 m: [level, seconds]. */
    arrivals: [] as number[][],
    lastCrime: '',
  };
  /** Sidewalk outside the station, where the booked are let go. */
  readonly station: { x: number; z: number; h: number; name: string };
  /** The respray shop's door, and the patch of road in front of it that counts as driving in. */
  readonly shop: { x: number; z: number; name: string };
  readonly heli: Heli;

  private readonly rng = new RNG(90210);
  private readonly bars: Beacons;
  private readonly pending: Pending[] = [];
  private readonly lastAi = new WeakMap<Vehicle, number>();
  /** This browser's own player. */
  readonly me: Suspect = blankSuspect(0);
  /**
   * Multiplayer (src/net/police.ts). local: private police, as in single player. host: one set of police for the
   * town, run here, after anybody wanted. guest: the host's police are shown here; this browser only works out its
   * own player's heat from what it can see of them.
   */
  mode: 'local' | 'host' | 'guest' = 'local';
  /** Host: the other players in town, wanted or not (they are also eyes that a car must not appear in front of). */
  readonly others: Suspect[] = [];
  /** Host: an officer has hit another player (health off the person, off their car). */
  onHurt: ((id: number, dmg: number, carDmg: number) => void) | null = null;
  /** Host: another player has been held long enough: booked. */
  onBust: ((id: number) => void) | null = null;
  /** Host: something another player did to the Patrol, which only this browser could judge. */
  onCrime: ((id: number, kind: string, x: number, z: number, weight: number) => void) | null = null;
  /** A car has left the Patrol's books (its number in the town's frames is free again). */
  onUnitGone: ((u: Unit) => void) | null = null;
  /** Host: an officer has fired, from the muzzle to where the round went. */
  onShot: ((c: Cop, mx: number, my: number, mz: number, tx: number, ty: number, tz: number) => void) | null = null;
  private points = 0;
  private wrote = 0;
  private get level(): number { return this.me.level; }
  private set level(n: number) { this.me.level = n; }
  private get lastSeen(): number { return this.me.lastSeen; }
  private set lastSeen(t: number) { this.me.lastSeen = t; }
  private get kx(): number { return this.me.kx; }
  private set kx(v: number) { this.me.kx = v; }
  private get kz(): number { return this.me.kz; }
  private set kz(v: number) { this.me.kz = v; }
  /** In a car nobody saw her get into. */
  private get incognito(): boolean { return this.me.incognito; }
  private set incognito(b: boolean) { this.me.incognito = b; }
  private searchT = 0; private searchTotal = 1;
  private tipT = 0;
  /** A unit has got to where she was reported since heat began. Until one has, nobody is searching, so nobody can give up. */
  private onScene = false; private sceneT = 0;
  private raisedAt = 0; private awaiting = false;
  private impactT = 0;
  private shopT = 0; private shopTold = 0;
  private heliT = 0; private heliRest = 0;
  /** Whom the helicopter is out for (null: nobody, it is away or leaving), and whom it was last out for. */
  heliOn: Suspect | null = null;
  private heliLast: Suspect = this.me;
  /** Its crew can see whoever it is out for right now: the lamp is on them. */
  heliTracks = false;
  /** A helicopter taken over from the last host waits this long (seconds) to hear who is wanted before it gives up and goes. */
  private heliGrace = 0;
  /** Guest: where the host's lamp is to rest, as this browser draws things (src/net/police.ts sets it each frame). */
  readonly lampAt = { x: 0, z: 0, track: false };
  private emitT = 0; private lastSirens = -1;
  private frame = 0;
  private readonly tmp = { x: 0, z: 0 };
  private readonly look: Look = { skin: 0xc68e6a, hair: 0x2a2018, top: 0xa9c1d4, bottom: 0x1a2238, shoes: 0x111111, hat: 0xf2e8cf, height: 1.02, build: 1.08 };

  constructor(private readonly game: Game) {
    const plan = game.plan;
    this.bars = new Beacons(game);
    this.heli = new Heli(game);

    // Harbor Patrol Station No. 1: the south sidewalk of the block north of Ledger St, between Dogfish St and Eel Alley.
    const st = plan.sidewalkPoint(3, 3, 2, 0.5);
    this.station = { x: st.x, z: st.z, h: st.h, name: `Harbor Patrol Station No. 1, ${plan.streetAt(st.x, st.z + 6)}` };
    frontage(game, st.x, st.z, 0, -1, 'HARBOR PATROL', 'STATION No. 1  ·  LOST PROPERTY ROUND THE BACK', '#f2e8cf', '#14213d', false);
    // Fresh Coat: a garage frontage on the north side of a Cannery block, facing Bollard St.
    const sh = plan.sidewalkPoint(1, 5, 0, 0.42);
    this.shop = { x: sh.x, z: sh.z - 5.4, name: `Fresh Coat, ${plan.streetAt(sh.x, sh.z - 6)}` };
    frontage(game, sh.x, sh.z, 0, 1, 'FRESH COAT', 'RESPRAYS WHILE YOU PANIC  ·  NO QUESTIONS', '#14213d', '#f0a202', true);

    game.on('pedHit', (e) => { if (e.byPlayer) this.pending.push({ kind: 'pedHit', x: e.x, z: e.z, weight: e.speed > 9 ? 1.2 : 1 }); });
    game.on('crime', (e) => this.pending.push({ kind: e.kind, x: e.x, z: e.z, weight: e.weight }));
    game.on('impact', (e) => {
      const o = e.other;
      if (!o || e.speed < 4 || this.impactT > 0) return;
      const mine = e.vehicle.driver === 'player' ? e.vehicle : o.driver === 'player' ? o : null;
      if (!mine) return;
      const them = mine === o ? e.vehicle : o;
      if (them.driver !== 'ai') return;
      // A cruiser that rams her has not been wronged: it counts only when she was the one doing the hitting.
      if (this.unitOf(them)) {
        this.stats.rams++;
        if (Math.abs(mine.speed) < Math.abs(them.speed) + 2) return;
        this.pending.push({ kind: 'hitCruiser', x: e.x, z: e.z, weight: 0.5 });
      } else this.pending.push({ kind: 'crash', x: e.x, z: e.z, weight: e.speed > 12 ? 0.5 : 0.34 });
      this.impactT = 1.2;
    });
    game.on('enter', (e) => {
      const v = e.vehicle, t = this.lastAi.get(v);
      // Somebody was driving it a moment ago: that is a car taken, not a car found.
      if (t !== undefined && game.time - t < 0.5) this.pending.push({ kind: this.unitOf(v) ? 'tookCruiser' : 'carjack', x: v.x, z: v.z, weight: 1 });
      this.incognito = this.level > 0 && game.time - this.lastSeen > 1.5;
    });
    game.on('exit', () => { this.incognito = false; });
    // (Host: an officer another player hurt, then this one finished, is on this one's sheet.)
    game.on('personHit', (e) => { if (this.mode === 'host') for (const c of this.cops) if (c.p === e.person) c.by = e.by ?? 0; });
  }

  private unitOf(v: Vehicle): Unit | null {
    for (const u of this.units) if (u.v === v) return u;
    return null;
  }

  // ── Seeing ─────────────────────────────────────────────────────────────────

  /** Can somebody at (x, y, z) make the player out? In a car nobody saw her take, only from close up. */
  private canSee(s: Suspect, x: number, y: number, z: number, range: number): boolean {
    if (s.incognito) range = 16;
    const dx = s.x - x, dz = s.z - z;
    if (dx * dx + dz * dz > range * range) return false;
    return this.game.col.lineOfSight(x, y, z, s.x, s.y + 1.1, s.z);
  }

  /** This browser's player as the Patrol's code reads them, once a frame. */
  private snap(): void {
    const pl = this.game.player, m = this.me, pv = pl.vehicle;
    m.x = pl.x; m.y = pl.y; m.z = pl.z; m.speed = pl.speed; m.vehicle = pv;
    m.vx = pv ? pv.vx : 0; m.vz = pv ? pv.vz : 0;
  }

  /** Meters from (x, z) to the nearest player: this browser's, or (host) anybody's. */
  private nearest(x: number, z: number): number {
    const pl = this.game.player;
    let d = Math.hypot(x - pl.x, z - pl.z);
    for (const o of this.others) d = Math.min(d, Math.hypot(x - o.x, z - o.z));
    return d;
  }

  /** Nothing between the camera and a point at car height, so making or removing something there would show. */
  private inView(x: number, z: number): boolean {
    const g = this.game, c = g.camera.position;
    if (g.col.lineOfSight(c.x, Math.max(c.y, 1.5), c.z, x, 1.3, z)) return true;
    const pl = g.player;
    if (g.col.lineOfSight(pl.x, pl.y + 1.5, pl.z, x, 1.3, z)) return true;
    // (Host: the other players have eyes too. Their cameras are not known: where they stand is near enough.)
    for (const o of this.others) if (Math.hypot(o.x - x, o.z - z) < 320 && g.col.lineOfSight(o.x, o.y + 1.5, o.z, x, 1.3, z)) return true;
    return false;
  }

  private witnessed(c: Pending): boolean {
    const g = this.game, col = g.col, me = g.player.person;
    for (const p of g.people.list) {
      if (p === me || !p.visible || p.pose === 'down') continue;
      const dx = p.x - c.x, dz = p.z - c.z;
      if (dx * dx + dz * dz > WITNESS * WITNESS) continue;
      if (col.lineOfSight(p.x, p.y + 1.6, p.z, c.x, groundAt(c.x, c.z) + 1.2, c.z)) return true;
    }
    for (const u of this.units) {
      if (u.state === 'leave') continue;
      const dx = u.v.x - c.x, dz = u.v.z - c.z;
      if (dx * dx + dz * dz < SEE_CAR * SEE_CAR && col.lineOfSight(u.v.x, u.v.y + 1.3, u.v.z, c.x, groundAt(c.x, c.z) + 1.2, c.z)) return true;
    }
    return this.heli.onStation && col.lineOfSight(this.heli.x, this.heli.y, this.heli.z, c.x, groundAt(c.x, c.z) + 1.2, c.z);
  }

  // ── Heat ───────────────────────────────────────────────────────────────────

  private searchLen(level: number): number { return 14 + 4 * level; }

  private setLevel(n: number): void {
    const g = this.game;
    n = clamp(Math.floor(n), 0, 5);
    if (n > this.level) {
      this.raisedAt = g.time; this.awaiting = true;
      this.lastSeen = g.time; this.kx = g.player.x; this.kz = g.player.z;
      this.me.spawnT = Math.min(this.me.spawnT, this.level === 0 ? 2 : 0.6);
      if (this.level === 0) { this.onScene = false; this.sceneT = 40; }
    }
    this.level = n;
    this.searchTotal = this.searchT = this.searchLen(n);
    g.player.heat = this.wrote = n;
    if (n === 0) { this.incognito = false; this.me.hold = 0; }
  }

  private heatStep(dt: number, seen: boolean): void {
    const g = this.game, pl = g.player, s = this.status;
    // Somebody else moved the pips (a cheat, a test hook, the hospital): take their word for it.
    if (pl.heat !== this.wrote) { this.points = clamp(pl.heat, 0, 5); this.setLevel(this.points); }

    for (const c of this.pending) {
      if (!c.sure && !this.witnessed(c)) { this.stats.unseen++; continue; }
      this.stats.crimes++;
      this.stats.lastCrime = c.kind;
      // One crime is never worth more than one level, however lurid.
      this.points = Math.min(5, Math.min(this.points + c.weight, this.level + 1.99));
      this.lastSeen = g.time; this.kx = c.x; this.kz = c.z;
      this.searchT = this.searchTotal;
      if (Math.floor(this.points) > this.level) this.setLevel(this.points);
    }
    this.pending.length = 0;

    if (seen) {
      this.lastSeen = g.time; this.kx = pl.x; this.kz = pl.z;
      this.searchT = this.searchTotal;
      this.incognito = false;
    }
    const lvl = this.level;
    const quiet = g.time - this.lastSeen;
    // The public phones it in: for a quarter of a minute after the Patrol last had her, anyone on the
    // pavement who can see her keeps the last known position fresh. It does not stop the search clock.
    if (lvl > 0 && !seen && !this.incognito && quiet < 15 && (this.tipT -= dt) <= 0) {
      this.tipT = 0.5;
      const me = pl.person;
      for (const p of g.people.list) {
        if (p === me || !p.visible || p.pose === 'down') continue;
        const dx = p.x - pl.x, dz = p.z - pl.z;
        if (dx * dx + dz * dz > 38 * 38 || !g.col.lineOfSight(p.x, p.y + 1.6, p.z, pl.x, pl.y + 1.1, pl.z)) continue;
        // Called in with a guess at where she is headed, since she will be past by the time anyone looks.
        const pv = pl.vehicle;
        this.kx = pl.x + (pv ? pv.vx : 0); this.kz = pl.z + (pv ? pv.vz : 0);
        this.stats.tips++;
        break;
      }
    }
    if (!this.onScene) {
      // Forty seconds is the longest the clock waits for a car that cannot get through.
      if (seen || (this.sceneT -= dt) <= 0) this.onScene = true;
      else for (const u of this.units) if (u.state === 'drive' && Math.abs(u.v.x - this.kx) + Math.abs(u.v.z - this.kz) < 70) this.onScene = true;
    }
    s.searching = lvl > 0 && quiet > 3 && this.onScene;
    const r0 = 100 + 25 * lvl;
    this.me.radius = s.radius = lvl > 0 ? lerp(r0 * 0.4, r0, clamp01(this.searchT / this.searchTotal)) : 0;
    let rate = 0;
    if (s.searching) {
      const dx = pl.x - this.kx, dz = pl.z - this.kz;
      rate = dx * dx + dz * dz < s.radius * s.radius ? 0.4 : 1;
      if (this.incognito) rate *= 1.7;
      this.searchT -= dt * rate;
      if (this.searchT <= 0) {
        this.stats.drops++;
        this.points = lvl - 1;
        this.setLevel(lvl - 1);
        if (lvl - 1 === 0) g.hud.toast('The Harbor Patrol has lost interest. For now.', 4);
      }
    } else if (lvl === 0 && this.points > 0) this.points = Math.max(0, this.points - dt / 45);
    else if (lvl > 0) this.points = Math.max(lvl, this.points - dt / 30);

    s.level = this.level; s.seen = seen; s.timeLeft = rate > 0 ? this.searchT / rate : 0;
    s.x = this.kx; s.z = this.kz;
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  /** What a suspect would have after them alone, as in single player. */
  private need(s: Suspect, role: 'pursue' | 'block'): number {
    const lvl = s.level, q = 0.5 + 0.5 * clamp(this.game.quality.density, 0, 1);
    if (role === 'block') return lvl >= 3 ? 2 : 0;
    return lvl > 0 ? Math.max(1, Math.round(PURSUERS[lvl] * q)) : 0;
  }

  /** The most cars the Patrol ever has out: what one player at the top level gets. A whole town shares it. */
  budget(): number {
    const q = 0.5 + 0.5 * clamp(this.game.quality.density, 0, 1);
    return Math.max(1, Math.round(PURSUERS[5] * q)) + 2;
  }

  /** Share the one budget among everybody wanted. Alone, everybody is one player, and they get all they need. */
  private share(): void {
    const me = this.me, all = this.others;
    let total = 0;
    me.wantP = this.need(me, 'pursue'); me.wantB = this.need(me, 'block');
    total += me.wantP + me.wantB;
    for (const o of all) { o.wantP = this.need(o, 'pursue'); o.wantB = this.need(o, 'block'); total += o.wantP + o.wantB; }
    const cap = this.budget();
    if (total <= cap) return;
    // Too many wanted at once. The roadblocks go first; then a car at a time from whoever has the most, down to one
    // each; past that the least wanted go without.
    const each = (fn: (o: Suspect) => void): void => { fn(me); for (const o of all) fn(o); };
    each((o) => { if (total > cap) { total -= o.wantB; o.wantB = 0; } });
    while (total > cap) {
      let top: Suspect | null = null;
      each((o) => { if (o.wantP > 1 && (!top || o.wantP > top.wantP)) top = o; });
      if (!top) break;
      (top as Suspect).wantP--; total--;
    }
    while (total > cap) {
      let low: Suspect | null = null;
      each((o) => { if (o.wantP > 0 && (!low || o.level < low.level)) low = o; });
      if (!low) break;
      (low as Suspect).wantP = 0; total--;
    }
  }

  private wanted(role: 'pursue' | 'block', s: Suspect): number { return role === 'block' ? s.wantB : s.wantP; }

  private count(role: 'pursue' | 'block', s: Suspect): number {
    let n = 0;
    for (const u of this.units) if (u.role === role && u.state !== 'leave' && u.target === s) n++;
    return n;
  }

  private addUnit(x: number, z: number, h: number, role: 'pursue' | 'block', target: Suspect): Unit {
    const v = this.game.vehicles.spawn('cruiser', x, z, h);
    v.driver = 'ai';
    const u: Unit = {
      v, target, shown: false, wid: 0, adoptT: 0, seesMe: false, role, state: 'drive', path: [], pi: 0, pathT: 0, side: this.units.length % 2 ? 1 : -1, crew: [],
      sees: false, seeT: this.rng.next() * 0.2, stuck: 0, rev: 0, jam: 0, sx: 0, sz: 0, nx: 0, nz: 0, atNode: false, bT: 0,
      wx: 0, wz: 0, wT: 0, arrived: false, phase: this.rng.next(),
    };
    this.units.push(u);
    this.stats.spawned++;
    return u;
  }

  /** A stretch of road to appear on: out of sight, well clear of the player, nothing parked on it. */
  private spawnPursuer(pl: Suspect): boolean {
    const g = this.game, plan = g.plan, rng = this.rng, pv = pl.vehicle;
    for (let k = 0; k < 12; k++) {
      const e = rng.pick(plan.edges), A = plan.nodes[e.a], B = plan.nodes[e.b];
      const s = e.len * rng.range(0.3, 0.7);
      const cx = e.horiz ? A.x + s : A.x, cz = e.horiz ? A.z : A.z + s;
      const d = Math.hypot(cx - pl.x, cz - pl.z);
      if (d < 120 || d > 280) continue;
      // Ahead of a car on the move for preference: one that starts behind a fast driver never arrives.
      if (k < 6 && pv && pl.speed > 8 && (cx - pl.x) * pl.vx + (cz - pl.z) * pl.vz < 0) continue;
      // Face the end of the street nearer the player, in the right-hand lane for that direction.
      const toB = Math.hypot(B.x - pl.x, B.z - pl.z) < Math.hypot(A.x - pl.x, A.z - pl.z);
      const sg = toB ? 1 : -1, dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
      const x = cx - dz * 1.8, z = cz + dx * 1.8;
      if (isWater(x, z) || this.inView(x, z) || g.vehicles.nearest(x, z, 9)) continue;
      this.addUnit(x, z, Math.atan2(dx, dz), 'pursue', pl);
      return true;
    }
    return false;
  }

  /**
   * A roadblock on the street she is driving along: at the mouth of a junction two or more
   * blocks on. The two cars come out of the cross street from either side, so nothing appears
   * on the road she is looking down.
   */
  private planBlock(pl: Suspect): boolean {
    const g = this.game, plan = g.plan, pv = pl.vehicle;
    if (!pv || pl.speed < 11) return false;
    const ne = plan.nearestEdge(pl.x, pl.z), e = ne.edge;
    if (ne.d > e.hw) return false;
    const along = e.horiz ? pl.vx : pl.vz;
    if (Math.abs(along) < 9) return false;
    const sg = along > 0 ? 1 : -1, dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    let node = plan.nodes[sg > 0 ? e.b : e.a], edge = e;
    // Straight on, junction by junction, until one is far enough ahead to be reached in time.
    let site: RoadNode | null = null;
    for (let k = 0; k < 4; k++) {
      const dist = (node.x - pl.x) * dx + (node.z - pl.z) * dz;
      if (dist > 150 + pl.speed * 2.5) { site = node; break; }
      let next = null;
      for (const id of node.edges) { const c = plan.edges[id]; if (c !== edge && c.horiz === e.horiz) next = c; }
      if (!next) break;
      edge = next; node = plan.nodes[plan.other(next, node.id)];
    }
    if (!site) return false;
    const half = e.horiz ? site.hx : site.hz;
    const cx = site.x - dx * (half + 3.5), cz = site.z - dz * (half + 3.5);
    const lat = edge.hw * 0.42;
    // Where each car can come from: up to 70 m down the cross street, either side.
    const made: Unit[] = [];
    for (const side of [-1, 1]) {
      // Unit vector along the cross street, pointing away from the junction on this side.
      const ox = -dz * side, oz = dx * side;
      let ok = false;
      for (const id of site.edges) {
        const c = plan.edges[id];
        if (c.horiz === e.horiz) continue;
        const far = plan.nodes[plan.other(c, site.id)];
        if ((far.x - site.x) * ox + (far.z - site.z) * oz > 0) ok = true;
      }
      if (!ok) continue;
      const back = 48 + made.length * 4;
      // Driving toward the junction: heading is (-ox, -oz); keep right of the centerline.
      const hx = -ox, hz = -oz;
      const x = site.x + ox * back - hz * 1.8, z = site.z + oz * back + hx * 1.8;
      if (this.inView(x, z) || g.vehicles.nearest(x, z, 8)) continue;
      const u = this.addUnit(x, z, Math.atan2(hx, hz), 'block', pl);
      u.sx = cx + ox * lat; u.sz = cz + oz * lat; u.nx = site.x + ox * 3; u.nz = site.z + oz * 3;
      made.push(u);
    }
    if (made.length === 0) return false;
    this.stats.blocks++;
    if (pl === this.me) g.emit('roadblock', { x: cx, z: cz });
    return true;
  }

  private dispatch(dt: number): void {
    this.share();
    const me = this.me, all = this.others;
    for (const u of this.units) {
      if (u.adoptT > 0) {
        // Taken over from the last host: after whoever is wanted and nearest, once their browsers have said so.
        u.adoptT -= dt;
        let best: Suspect | null = null, bd = 1e9;
        for (let i = -1; i < all.length; i++) {
          const o = i < 0 ? me : all[i], d = Math.hypot(o.x - u.v.x, o.z - u.v.z);
          if (o.level > 0 && this.count('pursue', o) < o.wantP + o.wantB && d < bd) { bd = d; best = o; }
        }
        if (best) { u.target = best; u.adoptT = 0; u.role = 'pursue'; for (const c of u.crew) c.target = best; }
        else if (u.adoptT <= 0) { u.adoptT = 0; u.target = me; }
      } else if (u.target !== me && all.indexOf(u.target) < 0) {
        // Whoever it was after has left town.
        u.target = me;
        for (const c of u.crew) c.target = me;
        if (u.state !== 'leave') { u.role = 'pursue'; this.standDown(u); }
      }
    }
    {
      for (const c of this.cops) {
        if (c.shown) continue;
        if (c.target !== me && all.indexOf(c.target) < 0) { c.target = me; c.mode = 'return'; }
        if (c.unit || c.dead || c.target.level > 0) continue;
        // On foot with no car and nobody to chase (their car was taken, or the last host knew whom they were after): whoever is wanted and near.
        for (let i = -1; i < all.length; i++) {
          const o = i < 0 ? me : all[i];
          if (o.level > 0 && Math.hypot(o.x - c.p.x, o.z - c.p.z) < 90) { c.target = o; c.mode = 'chase'; break; }
        }
      }
    }
    this.dispatchFor(me, dt);
    for (const o of all) this.dispatchFor(o, dt);
  }

  private dispatchFor(pl: Suspect, dt: number): void {
    pl.spawnT -= dt; pl.blockT -= dt;
    const wantP = this.wanted('pursue', pl);
    let haveP = this.count('pursue', pl);
    // Too many for the level it has come down to: the furthest go home first.
    while (haveP > wantP) {
      let far: Unit | null = null, fd = -1;
      for (const u of this.units) {
        if (u.role !== 'pursue' || u.state === 'leave' || u.target !== pl || u.adoptT > 0) continue;
        const d = Math.hypot(u.v.x - pl.x, u.v.z - pl.z);
        if (d > fd) { fd = d; far = u; }
      }
      if (!far) break;
      this.standDown(far); haveP--;
    }
    if (haveP < wantP && pl.spawnT <= 0) {
      if (this.spawnPursuer(pl)) pl.spawnT = pl.level >= 4 ? 1.2 : 2.2; else pl.spawnT = 0.25;
    }
    if (pl.level < 3 || pl.wantB === 0) { for (const u of this.units) if (u.role === 'block' && u.state !== 'leave' && u.target === pl) this.dissolve(u); }
    else if (this.count('block', pl) === 0 && pl.blockT <= 0) pl.blockT = this.planBlock(pl) ? 30 : 1.5;
  }

  private standDown(u: Unit): void {
    if (u.state === 'leave') return;
    for (const c of u.crew) c.mode = 'return';
    u.state = u.crew.length ? 'park' : 'leave';
    u.role = 'pursue';
    u.path.length = 0; u.pi = 0; u.wT = 0;
    if (u.state === 'leave') u.arrived = true;
  }

  /** A roadblock she has gone past or never came to: the crew gets back in and joins the chase, or goes home. */
  private dissolve(u: Unit): void {
    for (const c of u.crew) c.mode = 'return';
    u.role = 'pursue';
    if (this.count('pursue', u.target) > this.wanted('pursue', u.target)) this.standDown(u);
  }

  private removeUnit(u: Unit, takeCar: boolean): void {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    for (const c of u.crew) c.unit = null;
    this.onUnitGone?.(u);
    if (takeCar) { this.game.vehicles.remove(u.v); this.stats.recycled++; }
  }

  // ── Driving ────────────────────────────────────────────────────────────────

  /** Point the car at (tx, tz) and hold `want` m/s, going round whatever is in the way except `target`. */
  private steer(u: Unit, tx: number, tz: number, want: number, dt: number, target: Vehicle | null): void {
    const v = u.v, ctl = v.ctl, sp = v.speed;
    const err = wrap(Math.atan2(tx - v.x, tz - v.z) - v.h);
    ctl.horn = false; ctl.handbrake = false;
    if (u.rev > 0) {
      // Backing out of a wedge, tail swung so the nose comes round to where it wants to go.
      u.rev -= dt;
      ctl.accel = -1; ctl.steer = clamp(err * 3, -1, 1);
      return;
    }
    let steer = clamp(-err * 2.4, -1, 1);
    want *= 1 - 0.55 * Math.min(1, Math.abs(err) * 1.1);
    const sh = Math.sin(v.h), ch = Math.cos(v.h);
    const reach = 7 + Math.abs(sp) * 0.9;
    const careless = u.target.level >= 4;
    for (const o of this.game.vehicles.list) {
      if (o === v || o === target) continue;
      const rx = o.x - v.x, rz = o.z - v.z;
      if (rx > reach || rx < -reach || rz > reach || rz < -reach) continue;
      const ahead = rx * sh + rz * ch;
      if (ahead < 1 || ahead > reach) continue;
      const lat = -rx * ch + rz * sh;
      const room = v.hw + Math.max(o.hw, Math.abs(Math.sin(o.h - v.h)) * o.hl) + 0.5;
      if (Math.abs(lat) > room) continue;
      // Round it on whichever side it is not; ease off if it is close and slower.
      steer = clamp(steer + (lat >= 0 ? -1 : 1) * (careless ? 0.5 : 0.75) * (1 - Math.abs(lat) / (room + 1)), -1, 1);
      const theirs = o.vx * sh + o.vz * ch;
      if (ahead < 5 + Math.abs(sp) * 0.45) want = Math.min(want, Math.max(theirs + (careless ? 9 : 3), careless ? 10 : 4));
    }
    ctl.steer = steer;
    const dv = want - sp;
    ctl.accel = dv > 0 ? Math.min(1, dv * 0.5 + 0.1) : dv < -1 ? Math.max(-1, dv * 0.4) : 0;
    if (want < 0.3 && Math.abs(sp) < 1) { ctl.accel = 0; ctl.handbrake = true; }

    if (want > 3 && Math.abs(sp) < 0.9) u.stuck += dt; else u.stuck = Math.max(0, u.stuck - dt * 2);
    if (u.stuck > 1.1) { u.stuck = 0; u.rev = 1.3; u.jam += 1; }
    if (Math.abs(sp) > 6) u.jam = Math.max(0, u.jam - dt * 0.3);
  }

  /** The junction this car is pointed at on the street it is on. */
  private nodeAhead(v: Vehicle): number {
    const plan = this.game.plan, ne = plan.nearestEdge(v.x, v.z), e = ne.edge;
    const f = e.horiz ? Math.sin(v.h) : Math.cos(v.h);
    return f >= 0 ? e.b : e.a;
  }

  /** Drive the streets to (gx, gz): junction to junction on the right of the road, slowing for the corners. */
  private route(u: Unit, gx: number, gz: number, vmax: number, dt: number): void {
    const plan = this.game.plan, v = u.v;
    if ((u.pathT -= dt) <= 0 || u.path.length === 0) {
      u.pathT = 1.4;
      const head = u.pi < u.path.length ? u.path[u.pi] : this.nodeAhead(v);
      // Finish at whichever end of the goal's street is the shorter way round, so the last leg runs along a road.
      const ge = plan.nearestEdge(gx, gz).edge, A = plan.nodes[ge.a], B = plan.nodes[ge.b];
      const viaA = Math.hypot(A.x - v.x, A.z - v.z) + Math.hypot(A.x - gx, A.z - gz);
      const viaB = Math.hypot(B.x - v.x, B.z - v.z) + Math.hypot(B.x - gx, B.z - gz);
      u.path = plan.findPath(head, viaA < viaB ? ge.a : ge.b);
      u.pi = 0;
      // The way there doubles straight back along this street: turn round here, not at the far corner.
      if (u.path.length > 1) {
        const ce = plan.nearestEdge(v.x, v.z).edge, H = plan.nodes[head];
        const behind = ce.a === head ? ce.b : ce.b === head ? ce.a : -1;
        if (behind === u.path[1] && Math.abs(H.x - v.x) + Math.abs(H.z - v.z) > 30) u.pi = 1;
      }
    }
    let N = plan.nodes[u.path[Math.min(u.pi, u.path.length - 1)]];
    for (let guard = 0; guard < 3 && u.pi < u.path.length; guard++) {
      N = plan.nodes[u.path[u.pi]];
      const dx = N.x - v.x, dz = N.z - v.z;
      const horiz = Math.abs(dx) > Math.abs(dz);
      if (Math.abs(horiz ? dx : dz) < (horiz ? N.hx : N.hz) + 2.5) { u.pi++; continue; }
      const ax = horiz ? Math.sign(dx) : 0, az = horiz ? 0 : Math.sign(dz);
      const along = dx * ax + dz * az, half = horiz ? N.hx : N.hz;
      // The width of the road being driven is the junction's size the other way.
      const two = (horiz ? N.hz : N.hx) >= 10;
      const off = two ? (u.side > 0 ? 5.2 : 1.8) : 1.75;
      const L = Math.min(clamp(7 + Math.abs(v.speed) * 0.55, 8, 24), along);
      const tx = horiz ? v.x + ax * L : N.x - az * off, tz = horiz ? N.z + ax * off : v.z + az * L;
      // What comes after this junction decides how fast to arrive at it.
      let vc = vmax;
      if (u.pi + 1 < u.path.length) {
        const M = plan.nodes[u.path[u.pi + 1]];
        const straight = horiz ? Math.abs(M.z - N.z) < 1 && Math.sign(M.x - N.x) === ax : Math.abs(M.x - N.x) < 1 && Math.sign(M.z - N.z) === az;
        if (!straight) vc = u.target.level >= 4 ? 12.5 : 10;
      } else vc = 13;
      const want = Math.min(vmax, Math.sqrt(vc * vc + 2 * 6.5 * Math.max(0, along - half - 5)));
      this.steer(u, tx, tz, want, dt, null);
      return;
    }
    const d = Math.hypot(gx - v.x, gz - v.z);
    this.steer(u, gx, gz, Math.min(vmax, 4 + d * 0.5), dt, null);
  }

  private driveUnit(u: Unit, dt: number): void {
    const g = this.game, pl = u.target, v = u.v, lvl = pl.level;
    const dx = pl.x - v.x, dz = pl.z - v.z, d = Math.hypot(dx, dz);
    if ((u.seeT -= dt) <= 0) {
      u.seeT = 0.2;
      u.sees = lvl > 0 && this.canSee(pl, v.x, v.y + 1.3, v.z, SEE_CAR);
      // (Host: a car after somebody else has eyes for this browser's own player too, as it has on every guest's screen.)
      u.seesMe = pl !== this.me && this.me.level > 0 && this.canSee(this.me, v.x, v.y + 1.3, v.z, SEE_CAR);
    }
    // (A guest: the host drives it. All this browser wants to know is whether it can see the player.)
    if (u.shown) return;
    if (u.adoptT > 0 && u.state === 'drive') { v.ctl.accel = 0; v.ctl.horn = false; return; }
    if (this.awaiting && pl === this.me && d < 40 && u.state === 'drive') { this.awaiting = false; this.stats.arrivals.push([lvl, +(g.time - this.raisedAt).toFixed(1)]); }

    if (u.state === 'park') {
      v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.handbrake = true;
      if (u.crew.length === 0) u.state = lvl > 0 && this.count('pursue', pl) <= this.wanted('pursue', pl) ? 'drive' : 'leave';
      else if (u.role === 'block') {
        // Past it, or gone another way: no point standing in the road.
        const stale = d > 230 || (!u.sees && d > 90 && g.time - pl.lastSeen > 8);
        if (stale) this.dissolve(u);
      }
      return;
    }
    if (u.state === 'leave') {
      // Nothing to see here: off at an unhurried pace to somewhere far from her.
      if ((u.wT -= dt) <= 0) {
        u.wT = 20;
        const a = Math.atan2(v.x - pl.x, v.z - pl.z) + this.rng.range(-0.6, 0.6);
        const n = g.plan.nearestNode(v.x + Math.sin(a) * 420, v.z + Math.cos(a) * 420);
        u.wx = n.x; u.wz = n.z; u.pathT = 0;
      }
      this.route(u, u.wx, u.wz, 13, dt);
      return;
    }
    const cap = SPEED_CAP[lvl];
    if (u.role === 'block') {
      // A roadblock that cannot be set in time is no roadblock: something in the way, or she went elsewhere.
      // Without this two cars nose to nose at a junction mouth would sit there for good.
      u.bT += dt;
      if (u.bT > (u.atNode ? 26 : 18) || d > 300) { this.dissolve(u); u.path.length = 0; return; }
      if (!u.atNode) {
        if (Math.hypot(u.nx - v.x, u.nz - v.z) < 7) { u.atNode = true; u.bT = 18; }
        this.steer(u, u.nx, u.nz, 17, dt, null);
      } else {
        const ds = Math.hypot(u.sx - v.x, u.sz - v.z);
        this.steer(u, u.sx, u.sz, Math.min(7, 1.5 + ds * 0.7), dt, null);
        // Near enough is across the lanes; a car that has been shuffling for a few seconds stops where it is.
        if (ds < 2.6 || (ds < 7 && (u.jam > 0 || u.bT > 22))) this.deploy(u, 'guard');
      }
      return;
    }

    const pv = pl.vehicle;
    const slow = pl.speed < 2.5;
    if (u.sees && d < 80) {
      u.path.length = 0; u.pi = 0;
      if (slow || !pv) {
        // On foot, or sitting still: pull up short and get out.
        if (d < (pv ? 12 : 14)) {
          v.ctl.accel = Math.abs(v.speed) > 1 ? -1 : 0; v.ctl.steer = 0; v.ctl.handbrake = Math.abs(v.speed) < 3;
          if (Math.abs(v.speed) < 3.5) this.deploy(u, 'chase');
        } else this.steer(u, pl.x, pl.z, Math.min(cap, Math.sqrt(12 * Math.max(0.5, d - 15))), dt, pv);
        return;
      }
      const ps = Math.sin(pv.h), pc = Math.cos(pv.h);
      // Her forward and right, and where this car is in those terms.
      const along = -(dx * ps + dz * pc), lat = -(-dx * pc + dz * ps);
      const side = Math.abs(lat) > 1.2 ? Math.sign(lat) : u.side;
      const psp = pl.speed;
      let tx: number, tz: number, want: number;
      if (lvl === 1) {
        // Draw level, then ease across her nose and slow: a box, not a blow.
        if (along > 4) { tx = pl.x + ps * (along + 6) - pc * side * 1.2; tz = pl.z + pc * (along + 6) + ps * side * 1.2; want = Math.max(0, psp - 5); }
        else { tx = pl.x + ps * 9 - pc * side * 3.1; tz = pl.z + pc * 9 + ps * side * 3.1; want = psp + clamp((6 - along) * 0.9, 1, 12); }
      } else if (lvl === 2) {
        // The rear quarter: alongside the back wheel, then turn in.
        if (d > 7 || along > 1) { tx = pl.x - ps * 1.5 - pc * side * 2.4; tz = pl.z - pc * 1.5 + ps * side * 2.4; }
        else { tx = pl.x + ps * 2.5; tz = pl.z + pc * 2.5; }
        want = psp + clamp(d * 0.6, 4, 14);
      } else {
        // Where she will be, flat out.
        const lead = clamp(d / Math.max(10, Math.abs(v.speed)), 0, 1.1);
        tx = pl.x + pl.vx * lead; tz = pl.z + pl.vz * lead;
        want = cap;
      }
      this.steer(u, tx, tz, Math.min(cap, want), dt, pv);
      return;
    }
    // Not in sight: to where she was last seen, then round the streets near it.
    const kd = Math.hypot(pl.kx - v.x, pl.kz - v.z);
    if (kd > 28 && !u.arrived) { this.route(u, pl.kx, pl.kz, cap, dt); return; }
    if (g.time - pl.lastSeen < 1.5) { u.arrived = false; this.route(u, pl.kx, pl.kz, cap, dt); return; }
    u.arrived = true;
    if ((u.wT -= dt) <= 0 || Math.hypot(u.wx - v.x, u.wz - v.z) < 16) {
      u.wT = 14;
      const a = this.rng.range(0, TAU), r = this.rng.range(30, Math.max(60, pl.radius));
      const n = g.plan.nearestNode(pl.kx + Math.sin(a) * r, pl.kz + Math.cos(a) * r);
      u.wx = n.x; u.wz = n.z; u.pathT = 0;
    }
    if (g.time - pl.lastSeen < 3) u.arrived = false;
    this.route(u, u.wx, u.wz, Math.min(cap, 16), dt);
  }

  /** The crew gets out. Two a car; one on the light preset. */
  private deploy(u: Unit, mode: 'chase' | 'guard'): void {
    const g = this.game, v = u.v;
    u.state = 'park';
    v.ctl.accel = 0; v.ctl.handbrake = true;
    const n = g.quality.density < 0.6 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const d = this.tmp;
      v.doorPos(k === 0 ? -1 : 1, d);
      if (g.col.pointBlocked(d.x, d.z, groundAt(d.x, d.z) + 1) || isWater(d.x, d.z)) continue;
      const look = { ...this.look, skin: [0xc68e6a, 0x8d5a3b, 0xe2b594, 0x6b4630][this.rng.int(0, 3)], height: this.rng.range(0.97, 1.06) };
      const p = g.people.spawn(d.x, d.z, v.h, look);
      const c: Cop = { p, unit: u, target: u.target, shown: false, wid: 0, by: 0, seesMe: false, mode, sees: false, seeT: 0, fireT: this.rng.range(0.8, 1.6), stuck: 0, sideT: 0, sideS: 1, down: 0, dead: false, gx: d.x + (d.x - v.x) * 0.5, gz: d.z + (d.z - v.z) * 0.5 };
      u.crew.push(c);
      this.cops.push(c);
    }
    if (u.crew.length === 0) u.state = 'drive';
  }

  // ── Officers on foot ───────────────────────────────────────────────────────

  private removeCop(c: Cop): void {
    const i = this.cops.indexOf(c);
    if (i >= 0) this.cops.splice(i, 1);
    if (c.unit) { const k = c.unit.crew.indexOf(c); if (k >= 0) c.unit.crew.splice(k, 1); }
    this.game.people.remove(c.p);
  }

  private walk(c: Cop, tx: number, tz: number, speed: number, dt: number): void {
    const g = this.game, p = c.p;
    let dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { p.pose = 'stand'; p.speed = 0; return; }
    dx /= d; dz /= d;
    if (c.sideT > 0) {
      // Round the corner of whatever it is rather than leaning on it.
      c.sideT -= dt;
      const ox = dx; dx = dx * 0.25 - dz * c.sideS; dz = dz * 0.25 + ox * c.sideS;
      const n = Math.hypot(dx, dz); dx /= n; dz /= n;
    }
    // Shoulder room among themselves.
    for (const o of this.cops) {
      if (o === c) continue;
      const ox = p.x - o.p.x, oz = p.z - o.p.z, od = ox * ox + oz * oz;
      if (od < 0.8 && od > 1e-4) { dx += ox * 0.9; dz += oz * 0.9; }
    }
    const step = Math.min(d, speed * dt);
    const t = this.tmp;
    t.x = p.x + dx * step; t.z = p.z + dz * step;
    if (isWater(t.x, t.z)) { c.sideT = 0.8; c.sideS = -c.sideS; p.pose = 'stand'; p.speed = 0; return; }
    const y = groundAt(t.x, t.z);
    g.col.resolveCircle(t, 0.35, y);
    const car = g.vehicles.resolveCircle(t, 0.35, y);
    if (car && car.driver === 'player' && Math.abs(car.speed) > 6 && c.down <= 0) {
      // Run down by the suspect. It goes in the report.
      c.down = 6; p.pose = 'down'; p.speed = 0; p.health = Math.max(1, p.health - 40);
      this.pending.push({ kind: 'officerDown', x: p.x, z: p.z, weight: 1.5 });
      return;
    }
    const moved = Math.hypot(t.x - p.x, t.z - p.z);
    if (moved < step * 0.35) { if ((c.stuck += dt) > 0.35) { c.stuck = 0; c.sideT = 0.9; c.sideS = this.rng.sign(); } } else c.stuck = 0;
    if (moved > 1e-4) p.h = Math.atan2(t.x - p.x, t.z - p.z);
    p.x = t.x; p.z = t.z; p.y = groundAt(t.x, t.z);
    p.speed = moved / Math.max(dt, 1e-4);
    p.pose = p.speed > 3 ? 'run' : p.speed > 0.3 ? 'walk' : 'stand';
  }

  private fire(c: Cop, d: number): void {
    const g = this.game, pl = c.target, p = c.p, lvl = pl.level;
    c.fireT = this.rng.range(1.1, 1.9) * (lvl >= 5 ? 0.7 : lvl === 4 ? 0.85 : 1);
    const dx = (pl.x - p.x) / d, dz = (pl.z - p.z) / d;
    const mx = p.x + dx * 0.55, my = p.y + 1.38, mz = p.z + dz * 0.55;
    let chance = lerp(0.5, 0.06, clamp01((d - 6) / 40));
    if (pl.speed > 5) chance *= 0.55;
    if (pl.vehicle) chance *= 0.7;
    const hit = this.rng.chance(chance);
    const ty = pl.y + (pl.vehicle ? 0.9 : 1.25);
    // A miss goes wide and on past her; a hit stops at her.
    const wide = hit ? 0 : this.rng.sign() * this.rng.range(0.7, 2.2), over = hit ? 0 : this.rng.range(4, 14);
    const to = { x: pl.x - dz * wide + dx * over, y: ty + (hit ? 0 : this.rng.range(-0.5, 0.8)), z: pl.z + dx * wide + dz * over };
    g.fx.emitters.muzzleFlash(mx, my, mz, dx, 0, dz);
    g.fx.emitters.tracer({ x: mx, y: my, z: mz }, to);
    this.stats.shots++;
    g.emit('gunshot', { x: mx, z: mz, by: 'patrol' });
    if (this.mode === 'host') this.onShot?.(c, mx, my, mz, to.x, to.y, to.z);
    if (!hit) return;
    this.stats.hits++;
    // Falls off with range; a car body takes most of it.
    const dmg = Math.round(lerp(9, 4, clamp01(d / 45)));
    if (pl !== this.me) {
      // Another player: their own browser takes it off them, by the same sums.
      this.onHurt?.(pl.id, pl.vehicle ? dmg * 0.4 : dmg, pl.vehicle ? dmg * 0.6 : 0);
      return;
    }
    this.hurtMe(pl.vehicle ? dmg * 0.4 : dmg, pl.vehicle ? dmg * 0.6 : 0);
  }

  /** A round from an officer has found this browser's player (here, or on the host's say so). */
  hurtMe(dmg: number, carDmg: number): void {
    const g = this.game, pl = g.player, v = pl.vehicle;
    if (v && carDmg > 0) v.health = Math.max(0, v.health - carDmg);
    pl.damage(dmg);
    g.cam.shake(0.15);
  }

  /** Something done to the Patrol goes on somebody's sheet: this browser's player's, or (host) another player's. */
  private blame(by: number, kind: string, x: number, z: number, weight: number): void {
    if (by === 0) this.pending.push({ kind, x, z, weight });
    else this.onCrime?.(by, kind, x, z, weight);
  }

  private copStep(c: Cop, dt: number): boolean {
    const g = this.game, pl = c.target, p = c.p, lvl = pl.level, u = c.unit;
    const dx = pl.x - p.x, dz = pl.z - p.z, d = Math.hypot(dx, dz) || 0.01;
    if (c.shown) {
      // A guest: the host walks them. Can they see the player, and have they a hand on her shoulder?
      const up = p.visible && p.pose !== 'down' && p.health > 0;
      if ((c.seeT -= dt) <= 0) { c.seeT = 0.25; c.sees = up && lvl > 0 && this.canSee(pl, p.x, p.y + 1.6, p.z, SEE_FOOT); }
      if (!up) c.sees = false;
      if (lvl > 0 && lvl < 3 && c.sees && pl.speed < 2.2 && d < (pl.vehicle ? pl.vehicle.hw + 2.2 : 2.1)) pl.hold += dt;
      return true;
    }
    if (p.health <= 0) {
      // Put down by the weapons code. Lies there until nobody is looking.
      if (!c.dead) {
        c.dead = true; c.down = 0; c.sees = false;
        this.blame(c.by, 'officerDown', p.x, p.z, 2);
        // Nobody is coming back to the car for this one: let it go without waiting.
        if (u) { const k = u.crew.indexOf(c); if (k >= 0) u.crew.splice(k, 1); c.unit = null; }
      }
      p.pose = 'down'; p.speed = 0;
      if ((d > 60 || lvl === 0) && !this.inView(p.x, p.z)) { this.removeCop(c); return false; }
      return true;
    }
    if (c.down > 0) {
      // Winded, not watching: whatever they saw a moment ago does not count while they are on the ground.
      c.sees = false; p.pose = 'down'; p.speed = 0;
      if ((c.down -= dt) <= 0) { c.down = 0; p.pose = 'stand'; c.seeT = 0; }
      return true;
    }
    if ((c.seeT -= dt) <= 0) {
      c.seeT = 0.25; c.sees = lvl > 0 && this.canSee(pl, p.x, p.y + 1.6, p.z, SEE_FOOT);
      c.seesMe = pl !== this.me && this.me.level > 0 && this.canSee(this.me, p.x, p.y + 1.6, p.z, SEE_FOOT);
    }

    // Back to the car when there is nothing left to do on foot.
    const fled = !!pl.vehicle && pl.speed > 6 && d > 28;
    if (c.mode !== 'return' && (lvl === 0 || fled || d > 75 || (c.mode === 'chase' && !c.sees && g.time - pl.lastSeen > 12))) c.mode = 'return';
    if (c.mode === 'return') {
      if (!u || u.v.driver !== 'ai') {
        // No car to go back to. Walk off; vanish once round a corner.
        if ((d > 70 || lvl === 0) && !this.inView(p.x, p.z)) { this.removeCop(c); return false; }
        if (lvl > 0 && c.sees && d < 40) c.mode = 'chase';
        else { p.pose = 'stand'; p.speed = 0; }
        return true;
      }
      if (lvl > 0 && c.sees && !fled && d < 30) { c.mode = u.role === 'block' ? 'guard' : 'chase'; return true; }
      const cd = Math.hypot(u.v.x - p.x, u.v.z - p.z);
      if (cd < u.v.hw + 1.5) { this.removeCop(c); return false; }
      this.walk(c, u.v.x, u.v.z, RUN, dt);
      return true;
    }

    const armed = lvl >= 3;
    if (c.mode === 'guard') {
      // Beside the car, facing up the road; on foot after anyone who gets close.
      if (!pl.vehicle && c.sees && d < 22) c.mode = 'chase';
      else if (Math.hypot(c.gx - p.x, c.gz - p.z) > 0.6) this.walk(c, c.gx, c.gz, 2.2, dt);
      else { p.pose = 'stand'; p.speed = 0; if (c.sees) p.h = Math.atan2(dx, dz); }
    } else if (c.sees) {
      const stop = armed ? 13 : pl.vehicle ? pl.vehicle.hw + 1.2 : 1.3;
      if (d > stop) this.walk(c, pl.x, pl.z, RUN, dt);
      else { p.pose = 'stand'; p.speed = 0; p.h = Math.atan2(dx, dz); }
    } else if (Math.hypot(pl.kx - p.x, pl.kz - p.z) > 2) this.walk(c, pl.kx, pl.kz, RUN * 0.8, dt);
    else { p.pose = 'stand'; p.speed = 0; }

    if (armed && c.sees && d < 46 && !pl.out && (c.fireT -= dt) <= 0) {
      if (p.pose !== 'run') p.h = Math.atan2(dx, dz);
      this.fire(c, d);
    }
    // Close enough to put a hand on her shoulder, and she is not going anywhere.
    if (!armed && lvl > 0 && c.sees && !pl.out && pl.speed < 2.2 && d < (pl.vehicle ? pl.vehicle.hw + 2.2 : 2.1)) pl.hold += dt;
    return true;
  }

  /** Multiplayer guest: the host's officers have held this browser's player long enough. */
  bookMe(): void { if (this.level > 0) this.book(); }

  private book(): void {
    const g = this.game, pl = g.player, lvl = this.level;
    const fine = Math.min(pl.money, 60 + 90 * lvl);
    this.stats.booked++;
    pl.money -= fine;
    g.emit('booked', { fine, confiscate: true });
    // She is leaving the scene, so the scene can be struck: nobody is there to watch it go.
    // (In a shared town somebody may be: there the cars that were after her drive off instead.)
    if (this.mode === 'local') this.clear();
    else { this.heli.dismiss(); for (const u of this.units) if (!u.shown && u.target === this.me) this.standDown(u); }
    this.points = 0; this.setLevel(0);
    pl.teleport(this.station.x, this.station.z, this.station.h);
    g.cam.snap();
    g.hud.stamp('BOOKED', fine > 0 ? `Fined ${money(fine)} and let go` : 'Nothing to fine. Let go anyway');
    g.hud.toast(`${this.station.name}. The Harbor Patrol kept your hardware and wished you a law-abiding afternoon.`, 6);
  }

  /** Take every unit and officer off the map at once. Only for moments the player cannot see: an arrest, a death. */
  clear(): void {
    for (const c of this.cops.slice()) if (!c.shown) this.removeCop(c);
    for (const u of this.units.slice()) if (!u.shown) this.removeUnit(u, u.v.driver === 'ai');
    this.heli.dismiss();
  }

  // ── The helicopter ─────────────────────────────────────────────────────────

  /**
   * Whom it is out for, and whether it is called or sent home. Alone that is this browser's player at four pips.
   * The host of a shared town has ONE helicopter for everybody: it stays with the player it is on for as long as
   * they are at four pips (it does not flit between two), and otherwise goes to the most wanted, the nearer to it
   * of two alike. Its minute on station and its refuelling are the one helicopter's, whoever it is over.
   */
  private heliCall(dt: number): void {
    const heli = this.heli, me = this.me;
    let t = this.heliOn;
    if (t && (t.level < 4 || (t !== me && this.others.indexOf(t) < 0))) t = null;
    if (!t) {
      let best = -1e9;
      const ask = (s: Suspect): void => {
        if (s.level < 4) return;
        const score = s.level * 1e5 - (heli.present ? Math.hypot(s.x - heli.x, s.z - heli.z) : 0);
        if (score > best) { best = score; t = s; }
      };
      ask(me);
      for (const o of this.others) ask(o);
    }
    this.heliOn = t;
    if (t) { this.heliLast = t; this.heliGrace = 0; }
    // (Whoever it was over has left town: it flies off from where they were.)
    else if (this.heliLast.id > 0 && this.others.indexOf(this.heliLast) < 0) this.heliLast = this.heliPlace(this.heliLast.x, this.heliLast.z);
    if (this.heliGrace > 0) this.heliGrace -= dt;
    if (t && this.heliRest <= 0) { if (!heli.present) this.heliT = 80; heli.summon(t.x, t.z); }
    else if (this.heliGrace <= 0 || this.heliRest > 0) heli.dismiss();
    if (this.heliRest > 0) this.heliRest -= dt;
    if (heli.onStation && (this.heliT -= dt) <= 0) this.heliRest = 35;
  }

  /** Multiplayer: who runs the police has changed (src/net/police.ts). `now`: performance.now(). */
  heliMode(was: 'local' | 'host' | 'guest', mode: 'local' | 'host' | 'guest', now: number): void {
    const heli = this.heli;
    this.heliOn = null; this.heliTracks = false;
    if (mode === 'guest') { this.heliLast = this.me; this.lampAt.x = heli.spotX; this.lampAt.z = heli.spotZ; this.lampAt.track = false; heli.lend(now); return; }
    if (was === 'guest' && heli.present) {
      // The helicopter shown here is this browser's to fly now. Whom it was after is not known yet: it holds its
      // circle (or its course) for a moment while the wanted say so, then carries on or goes home.
      heli.takeOver();
      this.heliLast = this.heliPlace(heli.midX, heli.midZ);
      this.heliT = 80; this.heliRest = 0; this.heliGrace = mode === 'host' ? 4 : 0;
    } else {
      heli.takeOver();
      // (Host no longer, and alone: if it was over somebody else, it leaves from there.)
      if (this.heliLast.id > 0) this.heliLast = this.heliPlace(this.heliLast.x, this.heliLast.z);
    }
  }

  /** A place for the helicopter to hold or to leave from, when there is nobody there to follow (id -1: nobody). */
  private heliPlace(x: number, z: number): Suspect {
    const m = blankSuspect(-1);
    m.x = m.kx = x; m.z = m.kz = z;
    return m;
  }

  // ── Multiplayer (src/net/police.ts) ─────────────────────────────────────────

  private blankUnit(v: Vehicle, wid: number): Unit {
    return {
      v, target: this.me, shown: false, wid, adoptT: 0, seesMe: false, role: 'pursue', state: 'drive', path: [], pi: 0, pathT: 0, side: this.units.length % 2 ? 1 : -1, crew: [],
      sees: false, seeT: 0, stuck: 0, rev: 0, jam: 0, sx: 0, sz: 0, nx: 0, nz: 0, atNode: false, bT: 0,
      wx: 0, wz: 0, wT: 0, arrived: false, phase: (wid * 0.37) % 1,
    };
  }

  /** Guest: one of the host's cruisers, on duty, is on this browser's street. */
  showUnit(v: Vehicle, wid: number): Unit {
    const u = this.blankUnit(v, wid);
    u.shown = true;
    this.units.push(u);
    return u;
  }

  /** Guest: an officer of the host's is being drawn in this body. */
  showCop(p: Person, wid: number): Cop {
    const c: Cop = { p, unit: null, target: this.me, shown: true, wid, by: 0, seesMe: false, mode: 'chase', sees: false, seeT: 0, fireT: 1, stuck: 0, sideT: 0, sideS: 1, down: 0, dead: false, gx: p.x, gz: p.z };
    this.cops.push(c);
    return c;
  }

  /** Forget a shown car or officer (the car and the body are somebody else's to take away). */
  unshow(x: Unit | Cop): void {
    if ('v' in x) { const i = this.units.indexOf(x); if (i >= 0) this.units.splice(i, 1); }
    else { const i = this.cops.indexOf(x); if (i >= 0) this.cops.splice(i, 1); }
  }

  /** Forget everything shown. */
  dropShown(): void {
    for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].shown) this.units.splice(i, 1);
    for (let i = this.cops.length - 1; i >= 0; i--) if (this.cops[i].shown) this.cops.splice(i, 1);
  }

  /**
   * A cruiser the last host was driving is this browser's to drive now, from where it stands. Whom it was after is
   * not known yet: it coasts for a moment while the wanted say so (dispatch), then carries on or goes home.
   */
  adoptUnit(v: Vehicle, wid: number): Unit {
    let u = this.unitOf(v);
    if (!u) { u = this.blankUnit(v, wid); this.units.push(u); }
    u.shown = false; u.wid = wid; u.adoptT = 4; u.state = 'drive'; u.role = 'pursue'; u.target = this.me;
    u.path.length = 0; u.pi = 0; u.sees = false;
    v.driver = 'ai';
    return u;
  }

  /** The same for an officer on foot: one of this browser's own people from here on. */
  adoptCop(wid: number, x: number, z: number, h: number, down: boolean, health: number): Cop {
    const g = this.game;
    const p = g.people.spawn(x, z, h, { ...this.look });
    p.health = health;
    // (Somebody who was already dead under the last host is nobody's new crime here.)
    const c: Cop = { p, unit: null, target: this.me, shown: false, wid, by: 0, seesMe: false, mode: 'chase', sees: false, seeT: 0, fireT: 1.5, stuck: 0, sideT: 0, sideS: 1, down: down && health > 0 ? 3 : 0, dead: health <= 0, gx: x, gz: z };
    if (down || c.dead) p.pose = 'down';
    if (c.dead) { this.cops.push(c); return c; }
    // Their car is the nearest one standing: it waits for them.
    let best: Unit | null = null, bd = 30;
    for (const u of this.units) {
      const d = Math.hypot(u.v.x - x, u.v.z - z);
      if (!u.shown && d < bd && Math.abs(u.v.speed) < 2.5 && u.crew.length < 2) { bd = d; best = u; }
    }
    if (best) { best.crew.push(c); best.state = 'park'; c.unit = best; }
    this.cops.push(c);
    return c;
  }

  /** No longer the host: let go of every car (they stay on the street; `fn` is told of each) and take the officers off it. */
  handOver(fn: (u: Unit) => void): void {
    for (const c of this.cops.slice()) if (!c.shown) this.removeCop(c);
    for (const u of this.units.slice()) {
      if (u.shown) continue;
      this.removeUnit(u, false);
      if (!u.v.removed && !u.v.sunk && u.v.driver === 'ai') fn(u);
    }
  }

  /** Host: another player is taking this cruiser (by its number). The caller takes it off the street. */
  giveUnit(v: Vehicle): boolean {
    const u = this.unitOf(v);
    if (!u || u.shown) return false;
    this.removeUnit(u, false);
    return true;
  }

  /** Host: another player (`by`) has punched or shot an officer. */
  copHurt(wid: number, by: number, dmg: number, dx: number, dz: number, fist: boolean, shove: number): boolean {
    for (const c of this.cops) {
      if (c.wid !== wid || c.shown || c.dead) continue;
      this.game.player.weapons.hurtPerson(c.p, dmg, dx, dz, fist, shove);
      c.by = by;
      return true;
    }
    return false;
  }

  /** Host: another player's car has run into an officer at `speed` m/s (their browser saw it). */
  copStruck(wid: number, by: number, speed: number): boolean {
    for (const c of this.cops) {
      if (c.wid !== wid || c.shown || c.dead || c.down > 0 || !(speed > 6)) continue;
      const p = c.p;
      c.down = 6; p.pose = 'down'; p.speed = 0; p.health = Math.max(1, p.health - 40);
      this.blame(by, 'officerDown', p.x, p.z, 1.5);
      return true;
    }
    return false;
  }

  /** Guest: the host says this browser's player did something to the Patrol. An officer was there: it counts. */
  credit(kind: string, x: number, z: number, weight: number): void {
    this.pending.push({ kind, x, z, weight, sure: true });
  }

  // ── Fresh Coat ─────────────────────────────────────────────────────────────

  private respray(dt: number): void {
    const g = this.game, pl = g.player, v = pl.vehicle, s = this.shop;
    this.shopTold -= dt;
    if (!v || this.level === 0 || Math.abs(pl.x - s.x) > 5.5 || Math.abs(pl.z - s.z) > 4.5 || pl.speed > 3) { this.shopT = 0; return; }
    const tell = (text: string): void => { if (this.shopTold <= 0) { this.shopTold = 5; g.hud.toast(text, 4); } };
    if (g.time - this.lastSeen < 2.5) { this.shopT = 0; tell('Fresh Coat keeps the shutter down while the Patrol is watching.'); return; }
    if (pl.money < RESPRAY_FEE) { this.shopT = 0; tell(`Fresh Coat wants ${money(RESPRAY_FEE)}. You do not have ${money(RESPRAY_FEE)}.`); return; }
    if ((this.shopT += dt) < 0.9) return;
    this.shopT = 0;
    const palette = [0xf2e8cf, 0xe4572e, 0xf0a202, 0x2a9d8f, 0x9c4a3c, 0x8a9a6b, 0x7fb0bd, 0x5b3a4a, 0xc9774f, 0x2b2d33];
    let color = v.color;
    for (let k = 0; k < 8 && color === v.color; k++) color = this.rng.pick(palette);
    v.color = color;
    v.health = Math.max(v.health, 60);
    pl.money -= RESPRAY_FEE;
    this.stats.resprays++;
    this.points = 0; this.setLevel(0);
    g.emit('respray', { vehicle: v, color, fee: RESPRAY_FEE });
    g.hud.toast(`Fresh Coat: ${money(RESPRAY_FEE)}. New colour, same driver, no questions.`, 5);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.game, pl = g.player, s = this.status, me = this.me;
    this.snap();
    this.frame++;
    this.impactT -= dt;
    for (const v of g.vehicles.list) if (v.driver === 'ai') this.lastAi.set(v, g.time);

    // The helicopter: called at level 4, on station a minute or so at a time, then away to refuel.
    // (A guest is shown the host's: it flies nothing, and only asks whether that one can see its own player.)
    const heli = this.heli, guest = this.mode === 'guest';
    if (!guest) this.heliCall(dt);
    // It sees her when its lamp is on her and nothing is between: under an awning of buildings she is only a guess.
    const lampOn = Math.hypot(heli.spotX - pl.x, heli.spotZ - pl.z) < 9;
    const heliSees = heli.present && heli.onStation && this.level > 0 && !this.incognito && (guest || this.heliRest <= 0)
      && g.col.lineOfSight(heli.x, heli.y, heli.z, pl.x, pl.y + 1.1, pl.z);
    if (guest) heli.follow(dt, this.lampAt.x, this.lampAt.z, this.lampAt.track);
    else {
      // Out for another player (host): the crew's eyes are on them, by the same rule.
      const t = this.heliOn, to = this.heliLast;
      this.heliTracks = !t || t === me ? heliSees && !!t
        : heli.onStation && !t.incognito && this.heliRest <= 0 && g.col.lineOfSight(heli.x, heli.y, heli.z, t.x, t.y + 1.1, t.z);
      heli.update(dt, to.x, to.z, t ? this.heliTracks : heliSees, to.kx, to.kz);
    }

    let seen = heliSees && lampOn;
    // (Any car or officer that can see her counts, whoever it is after: on a guest's screen and on the host's alike.)
    for (const u of this.units) if ((u.target === me ? u.sees : u.seesMe) && u.state !== 'leave') seen = true;
    for (const c of this.cops) if ((c.target === me ? c.sees : c.seesMe) && !c.dead && c.down <= 0) seen = true;
    if (this.level === 0) seen = false;
    this.heatStep(dt, seen);
    if (this.mode !== 'guest') this.dispatch(dt);

    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i], v = u.v;
      if (u.shown) { this.driveUnit(u, dt); continue; }
      if (v.sunk || g.vehicles.list.indexOf(v) < 0) { this.removeUnit(u, false); continue; }
      // Taken from under them: an ordinary car now, and hers.
      if (v.driver !== 'ai') { this.removeUnit(u, false); continue; }
      const d = this.others.length ? this.nearest(v.x, v.z) : Math.hypot(v.x - pl.x, v.z - pl.z);
      const idle = u.state === 'leave' || u.jam >= 4;
      // Half a kilometer off, the crew standing about beside it is not worth keeping either.
      if (d > 520) for (const c of u.crew.slice()) this.removeCop(c);
      if (u.crew.length === 0 && (d > 520 || (d > (idle ? 110 : 360) && !this.inView(v.x, v.z)))) { this.removeUnit(u, true); continue; }
      this.driveUnit(u, dt);
    }

    me.holdWas = me.hold;
    for (const o of this.others) o.holdWas = o.hold;
    for (let i = this.cops.length - 1; i >= 0; i--) this.copStep(this.cops[i], dt);
    if (me.hold > me.holdWas) {
      if (!me.holdTold) { me.holdTold = true; g.hud.toast('Harbor Patrol: stay exactly that still.', 2.5); }
      // Several officers do not book her several times as fast.
      me.hold = Math.min(me.hold, me.holdWas + dt);
      // (A guest is booked when the host says so: here the count only earns the warning above.)
      if (this.mode === 'guest') me.hold = Math.min(me.hold, 1.6);
      else if (me.hold > 1.6) { me.hold = 0; me.holdTold = false; this.book(); }
    } else { me.hold = Math.max(0, me.hold - dt * 1.5); if (me.hold === 0) me.holdTold = false; }
    for (const o of this.others) {
      if (o.hold > o.holdWas) {
        o.hold = Math.min(o.hold, o.holdWas + dt);
        if (o.hold > 1.6) {
          // Booked. Their own browser does the fine, the confiscating and the walk home; here the chase is simply over.
          o.hold = 0; o.level = 0; o.quiet = g.time + 4;
          this.stats.bookedOthers++;
          this.onBust?.(o.id);
        }
      } else o.hold = Math.max(0, o.hold - dt * 1.5);
    }

    this.respray(dt);

    // Light bars, and what sound will want to know.
    let sirens = 0;
    this.bars.begin();
    for (const u of this.units) {
      if (u.state === 'leave') continue;
      sirens++;
      const v = u.v, sh = Math.sin(v.h), ch = Math.cos(v.h);
      this.bars.bar(v.x - sh * 0.15, v.y + v.spec.height + 0.14, v.z - ch * 0.15, v.h, u.phase);
    }
    this.bars.end();
    s.units = this.units.length; s.sirens = sirens; s.helicopter = heli.present;
    if (sirens !== this.lastSirens) { this.lastSirens = sirens; g.emit('siren', { on: sirens > 0, units: sirens }); }
    if ((this.emitT -= dt) <= 0) {
      this.emitT = 0.25;
      g.emit('heat', { level: s.level, seen: s.seen, searching: s.searching, timeLeft: s.timeLeft, x: s.x, z: s.z, radius: s.radius });
    }

    const st = this.stats, ms = performance.now() - t0;
    st.ms = ms; st.sum += ms; st.n++;
    if (ms > st.max) st.max = ms;
  }
}
