// Riding together (owner, Nov 23): a player on foot beside a car another player is driving presses the get-in key and
// takes a free passenger seat ("Ride with <name>"). Players' own cars only (not the town's traffic or parked cars), on
// either service. Single player: nothing here does anything (nobody to ride with).
//
// Who decides what:
//  - The DRIVER's browser is the car's authority, as it always was: it moves the car, and it says who sits where (a
//    Seats event, sent when that changes). Getting out of the car, wrecking it or a hard crash empties the list, with
//    the reason, and the passengers' browsers put them out (thrown, for the last two).
//  - The PASSENGER's browser sends a Ride event on getting in and out, and while seated its State frames say so (mode
//    Passenger, `vehicle` = the driver's id, `color` = the seat), for anybody who arrives later. While seated it sends a
//    state frame only when that changes: where the passenger is follows from the car, so a passenger costs keepalives.
//  - Every screen draws a passenger in their seat in the car as THAT screen draws it, in the same step, so the two move
//    together however the car is smoothed. The passenger's own screen follows the driver's car the same way (the
//    chase camera on it, free look, a drive-by out of the window with the weapons already there, their own radio).
//  - Safe endings: the driver leaving town, their car not shown for a moment, the connection dropping or a reconnect all
//    stand the passenger beside the car at walking pace. A refused Ride (the seats are full) does the same.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { PASSENGER_SEATS } from '../ent/vehicleSpecs';
import { seatSpot } from '../ent/occupants';
import { PlayerEvent, PlayerMode, RIDE_OUT, SeatsWhy, decodeRide, decodeSeats, encodeRide, encodeSeats } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';

/** Gap between a player and a car body at which "Ride with" is offered, meters (the same reach as a door). */
const REACH = 3.2;
/** A passenger whose driver has not listed them this long after the Ride went is out (refused, or nobody answered), ms. */
const ANSWER_MS = 3000;
/** A Seats list that left the driver before the Ride arrived may not list them: one this soon after the Ride is not a refusal, ms. */
const GRACE_MS = 1000;
/** The driver's car not drawn here this long: out beside where it was, ms. */
const GONE_MS = 700;
/** Hit this hard (m/s closing), the driver's car throws its passengers out. */
const THROW_IMPACT = 17;
/** A rider the driver heard of whose own frames have not said "passenger of mine" this long is dropped, ms. */
const STALE_MS = 2500;

/** Where seat i of car v is now (ent/occupants.ts): the point on the cushion under the sitter's hips, as a seated Person stands. */
export { seatSpot };

interface Mine { driver: number; seat: number; at: number; seen: number; answered: boolean; listedAt: number }

export class TownRide {
  readonly stats = { rides: 0, outs: 0, thrown: 0, refused: 0, gone: 0, seatsSent: 0, seatsGot: 0, ridesSent: 0, ridesGot: 0 };
  /** This player as a passenger: whose car, which seat. Null on foot or at a wheel. */
  private cur: Mine | null = null;
  /** This player as a driver: who sits where in the car (passenger id to seat), when each was last heard of, and the car. */
  private readonly riders = new Map<number, number>();
  private readonly heard = new Map<number, number>();
  private myCar: Vehicle | null = null;
  private dirty = false;
  /** Each driver's last Seats list as heard here (driver id to [passenger, seat] pairs). */
  private readonly lists = new Map<number, [number, number][]>();
  private prompting = false;
  private nearId = 0;
  private readonly at = { x: 0, y: 0, z: 0 };

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    game.on('impact', (e) => {
      const v = this.myCar;
      if (v && this.riders.size && (e.vehicle === v || e.other === v) && e.speed > THROW_IMPACT) this.empty(SeatsWhy.Thrown);
    });
  }

  private get online(): boolean { return this.conn.status === 'online'; }
  /** The driver and seat this player rides in, or null. */
  get riding(): { driver: number; seat: number } | null { return this.cur ? { driver: this.cur.driver, seat: this.cur.seat } : null; }

  /** Somebody arrived: they know nothing of who sits in this driver's car. */
  refresh(): void { if (this.riders.size) this.dirty = true; }

  // ── Messages ───────────────────────────────────────────────────────────────

  /** A Ride or Seats event (index.ts). */
  event(buf: ArrayBuffer): void {
    const code = buf.byteLength > 2 ? new Uint8Array(buf)[2] : 0;
    const now = performance.now();
    if (code === PlayerEvent.Ride) {
      const m = decodeRide(buf);
      if (!m || !this.remotes.has(m.id)) return;
      this.stats.ridesGot++;
      if (m.driver !== this.conn.id) return;
      if (m.seat === RIDE_OUT) { if (this.riders.delete(m.id)) this.dirty = true; this.heard.delete(m.id); return; }
      this.take(m.id, m.seat, now);
      // (Answered even when nothing changed, or refused: the asker is waiting for a list.)
      this.dirty = true;
      return;
    }
    if (code !== PlayerEvent.Seats) return;
    const m = decodeSeats(buf);
    if (!m || !this.remotes.has(m.id)) return;
    this.stats.seatsGot++;
    this.lists.set(m.id, m.list);
    const c = this.cur;
    if (!c || c.driver !== m.id) return;
    const mine = m.list.find((e) => e[0] === this.conn.id);
    if (mine) { c.answered = true; c.listedAt = now; if (mine[1] !== c.seat) { c.seat = mine[1]; } return; }
    if (m.why === SeatsWhy.Thrown) { this.out('thrown'); return; }
    if (m.why === SeatsWhy.Out) { this.out('out'); return; }
    // Seated, without this player: refused, unless it left the driver before the Ride got there.
    if (now - c.at > GRACE_MS) { this.stats.refused++; this.out('safe'); }
  }

  /** Driver: seat a passenger (the seat asked for if free, else the first free one, else nobody). */
  private take(id: number, want: number, now: number): void {
    const v = this.myCar ?? this.game.player.vehicle;
    if (!v || v.wreck || v.sunk) return;
    const seats = PASSENGER_SEATS[v.spec.kind].length;
    this.heard.set(id, now);
    const had = this.riders.get(id);
    if (had !== undefined && had < seats) return;
    const used = new Set(this.riders.values());
    let seat = want < seats && !used.has(want) ? want : -1;
    for (let i = 0; seat < 0 && i < seats; i++) if (!used.has(i)) seat = i;
    if (seat >= 0) { this.riders.set(id, seat); this.dirty = true; }
  }

  /** Driver: everybody out (the driver got out, the car is wrecked, a hard crash). */
  private empty(why: number): void {
    if (!this.riders.size) return;
    this.riders.clear(); this.heard.clear();
    this.sendSeats(why);
  }

  private sendSeats(why: number): void {
    this.dirty = false;
    if (!this.online || this.remotes.size === 0) return;
    if (this.conn.send(encodeSeats(why, [...this.riders.entries()]))) this.stats.seatsSent++;
  }

  // ── This player as a passenger ─────────────────────────────────────────────

  /** How many seats of driver d's car (v) are taken, as this screen knows it. */
  private taken(d: number, v: Vehicle): Set<number> {
    const t = new Set<number>(), n = PASSENGER_SEATS[v.spec.kind].length;
    for (const [pid, s] of this.lists.get(d) ?? []) if (pid !== this.conn.id && s < n) t.add(s);
    for (const r of this.remotes.values()) if (r.mode === PlayerMode.Passenger && r.rideOf === d && r.rideSeat < n) t.add(r.rideSeat);
    return t;
  }

  /** The car of another player within reach with a seat free, and whose it is. */
  private near(): Remote | null {
    const g = this.game, p = g.player, per = p.person;
    if (g.state !== 'play' || p.vehicle || p.riding || p.swimming || p.health <= 0 || p.goingTo) return null;
    let best: Remote | null = null, bd = REACH;
    for (const r of this.remotes.values()) {
      const v = r.vehicle;
      if (!v || r.mode !== PlayerMode.Driving || v.wreck || v.sunk || r.paused) continue;
      const dx = per.x - v.x, dz = per.z - v.z, far = REACH + v.hl + v.hw;
      if (dx * dx + dz * dz > far * far || Math.abs(v.y - per.y) > 2.5) continue;
      const s = Math.sin(v.h), c = Math.cos(v.h);
      const along = Math.abs(dx * s + dz * c) - v.hl, across = Math.abs(dz * s - dx * c) - v.hw;
      const d = Math.hypot(Math.max(along, 0), Math.max(across, 0));
      if (d >= bd) continue;
      if (this.taken(r.id, v).size >= PASSENGER_SEATS[v.spec.kind].length) continue;
      bd = d; best = r;
    }
    return best;
  }

  /** Into a free seat of r's car: the one nearest this player. */
  private board(r: Remote, now: number): void {
    const g = this.game, p = g.player, v = r.vehicle;
    if (!v) return;
    const used = this.taken(r.id, v), n = PASSENGER_SEATS[v.spec.kind].length;
    let seat = -1, bd = 1e9;
    for (let i = 0; i < n; i++) {
      if (used.has(i) || !seatSpot(v, i, this.at)) continue;
      const d = Math.hypot(this.at.x - p.person.x, this.at.z - p.person.z);
      if (d < bd) { bd = d; seat = i; }
    }
    if (seat < 0) return;
    if (!this.conn.send(encodeRide(r.id, seat))) return;
    this.stats.ridesSent++; this.stats.rides++;
    p.ride(v);
    this.cur = { driver: r.id, seat, at: now, seen: now, answered: false, listedAt: 0 };
    g.hud.toast(`Riding with ${r.text}. F to get out.`, 3);
  }

  /** Out of the car: 'safe' beside it at walking pace, 'out' as from any car (a bail-out at speed), 'thrown' in a heap. */
  private out(how: 'safe' | 'out' | 'thrown'): void {
    const c = this.cur, p = this.game.player;
    this.cur = null;
    if (!c) return;
    const v = p.riding;
    if (v) {
      const vx = v.vx, vz = v.vz, x = v.x, z = v.z;
      p.exit(how === 'safe');
      if (how === 'thrown') {
        this.stats.thrown++;
        const per = p.person, dx = per.x - x, dz = per.z - z, l = Math.hypot(dx, dz) || 1;
        p.damage(6);
        p.knockDown(vx * 0.6 + dx / l * 4, vz * 0.6 + dz / l * 4, 3);
      }
    }
    this.stats.outs++;
    if (this.online && this.remotes.has(c.driver) && this.conn.send(encodeRide(c.driver, RIDE_OUT))) this.stats.ridesSent++;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /** After the others have been placed this step (index.ts): seats, prompts, and the driver's list. */
  update(now: number): void {
    const g = this.game, p = g.player;
    // ── As a driver ──
    const v = p.vehicle;
    if (v !== this.myCar) {
      // Out of the car (or into another): whoever sat in the old one is out.
      if (this.riders.size) this.empty(SeatsWhy.Out);
      this.myCar = v;
    }
    if (v && this.riders.size) {
      if (v.wreck || v.sunk) this.empty(SeatsWhy.Thrown);
      else for (const [id] of this.riders) {
        const r = this.remotes.get(id);
        if (r && r.mode === PlayerMode.Passenger && r.rideOf === this.conn.id) this.heard.set(id, now);
        if (!r || now - (this.heard.get(id) ?? 0) > STALE_MS) { this.riders.delete(id); this.heard.delete(id); this.dirty = true; }
      }
    }
    if (v) for (const r of this.remotes.values()) {
      // Somebody whose frames say they sit in this car, and who is not listed (this driver reloaded): seat them.
      if (r.mode === PlayerMode.Passenger && r.rideOf === this.conn.id && !this.riders.has(r.id)) this.take(r.id, r.rideSeat, now);
    }
    if (this.dirty) this.sendSeats(SeatsWhy.Seated);

    // ── As a passenger ──
    const c = this.cur;
    if (c && !p.riding) {
      // F (Player.exit), a teleport, a reset, death: she is out already; the driver is told.
      this.cur = null;
      this.stats.outs++;
      if (this.online && this.remotes.has(c.driver) && this.conn.send(encodeRide(c.driver, RIDE_OUT))) this.stats.ridesSent++;
    } else if (c) {
      const r = this.remotes.get(c.driver), car = r && r.mode === PlayerMode.Driving ? r.vehicle : null;
      if (!r) { this.stats.gone++; this.out('safe'); }
      else if (car && car.wreck) this.out('thrown');
      else if (car) {
        c.seen = now;
        if (p.riding !== car) p.ride(car);   // (their car drawn afresh: a new ghost)
        if (seatSpot(car, c.seat, this.at)) { const per = p.person; per.x = this.at.x; per.y = this.at.y; per.z = this.at.z; per.h = car.h; per.pose = 'sit'; per.bench = true; per.speed = 0; }
        if (!c.answered && now - c.at > ANSWER_MS) { this.stats.refused++; this.out('safe'); }
        else if (c.answered && now - c.listedAt > GRACE_MS) {
          const l = this.lists.get(c.driver);
          if (l && !l.some((e) => e[0] === this.conn.id)) { this.stats.refused++; this.out('safe'); }
        }
      } else if (now - c.seen > GONE_MS) { this.stats.gone++; this.out('safe'); }
    }

    // ── The offer ──
    const r = this.cur ? null : this.near();
    p.rideNear = r ? r.vehicle : null;
    if (r && (r.id !== this.nearId || !this.prompting)) { g.hud.prompt(`[F] Ride with ${r.text}`); this.prompting = true; }
    else if (!r && this.prompting) { g.hud.prompt(null); this.prompting = false; }
    this.nearId = r ? r.id : 0;
    if (r && g.input.hit('enter')) { g.input.eat('enter'); p.rideNear = null; if (this.prompting) { g.hud.prompt(null); this.prompting = false; } this.board(r, now); }

    // ── The others who ride, drawn in their seats ──
    this.seatOthers();
  }

  /** The others who ride, drawn in their seats (here, and again by ent/occupants.ts in the step the cars are drawn). */
  seatOthers(): void {
    const p = this.game.player;
    for (const o of this.remotes.values()) {
      const body = o.body;
      if (!body || o.mode !== PlayerMode.Passenger) continue;
      const d = o.rideOf, car = d === this.conn.id ? p.vehicle : this.remotes.get(d)?.vehicle ?? null;
      const seat = d === this.conn.id ? this.riders.get(o.id) ?? o.rideSeat : o.rideSeat;
      if (!car || !seatSpot(car, seat, this.at)) { body.visible = false; continue; }
      body.visible = true;
      body.x = this.at.x; body.y = this.at.y; body.z = this.at.z; body.h = car.h;
      body.pose = 'sit'; body.bench = true; body.speed = 0;
      o.x = this.at.x; o.y = this.at.y; o.z = this.at.z; o.h = car.h;
    }
  }

  /** Somebody left town (index.ts, before their remote goes). */
  dropped(id: number): void {
    if (this.cur && this.cur.driver === id) { this.stats.gone++; this.out('safe'); }
    if (this.riders.delete(id)) { this.heard.delete(id); this.dirty = true; }
    this.lists.delete(id);
  }

  /** Out of town altogether (the connection dropped, or a fresh welcome): a passenger is stood beside the car. */
  clear(): void {
    if (this.cur) { this.stats.gone++; this.out('safe'); }
    this.riders.clear(); this.heard.clear(); this.lists.clear();
    this.game.player.rideNear = null;
    if (this.prompting) { this.game.hud.prompt(null); this.prompting = false; }
  }

  /** For the tests (window.__game.net().ride). */
  info(): Record<string, unknown> {
    return {
      ...this.stats,
      riding: this.riding,
      offer: this.nearId || 0,
      riders: [...this.riders.entries()],
      lists: [...this.lists.entries()],
    };
  }
}
