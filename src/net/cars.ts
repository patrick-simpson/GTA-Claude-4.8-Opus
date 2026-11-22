// Multiplayer, stage 2, step 3: the same parked cars for everyone, and taking and leaving cars.
//
// Only in a town on the MAIN service, like the shared traffic (shared.ts). Alone and on the backup nothing here runs
// and nothing is sent: parked cars are each browser's own, as before.
//
// Parked cars. Every browser already parks cars from the same map with the same dice (Game.placeStart), so no car is
// ever sent. What differed was how many (the quality setting thins them out); in a town every browser parks the same
// share of the places (PARKED_TOWN_SHARE), and a car's place in Game.parkSpots is its number. The host's are real,
// simulated cars. A guest's stand where they are as `shared` cars: solid, and not this browser's to push or dent.
// The town then only has to agree on which places are EMPTY: one bit per place, kept by every browser, changed by
// the host alone (World frame, WorldKind.Parked). A parked car that is pushed, dented or struck becomes one of the
// host's standing cars with a number in the traffic frames, on every screen at once and without being redrawn; one
// that is taken, sunk or burnt is just gone from its place. Somebody who arrives later gets the bits whole.
//
// Taking a car. A guest walks to the door of any of the town's cars (driven, left, or parked) and asks the host for
// it (ToHost Take). The host says yes to the first to ask and no to anybody after (ToPlayer Grant), and takes the car
// off its own streets. From then on it is the asker's own car, simulated in that browser and seen by the others
// through that player's State frames, as any player's car is. The host's own player takes a car as in single player;
// whoever of the two gets there first has it. The imaginary driver of a taken traffic car is simply gone, and the
// taker is wanted for it on their own screen, both exactly as in single player.
//
// Leaving a car. Once it has rolled to rest it is handed to the host (ToHost Leave: where, which way, what kind and
// paint, how bent), which stands a car there for the town (Traffic.abandon) and answers with its number (ToPlayer
// Left); the leaver's own copy carries on as that car without being redrawn. The host's own player's car is handed
// over the same way without messages. A player who drops out of town at the wheel leaves the car where the host
// last saw it. Standing cars are in the traffic frames, so a new host inherits them like the rest; the bits for the
// parked cars every browser already has.
//
// The mainland's kerbs (world/progress.ts) are not part of this yet: they stay each browser's own.

import type { Game } from '../core/game';
import type { ParkedSpot, Vehicle } from '../core/api';
import { angleDiff } from '../core/util';
import { KINDS, SPECS, type VehicleKind } from '../ent/vehicleSpecs';
import {
  CAR_HIT_HZ, CarClass, GRANT_BYTES, LEAVE_BYTES, LEFT_BYTES, PARKED_CHANGE_BYTES, PARKED_HEADER_BYTES, PARKED_MAX_CHANGES, PARKED_REFRESH_MS,
  PARKED_TOWN_SHARE, PARK_HIT_BYTES, TAKE_BYTES, TRAFFIC_DAMAGE_SHIFT, ToHostKind, ToPlayerKind, TrafficFlag, WorldKind, Frame,
  blankTrafficCar, damageStep, decodeGrant, decodeLeave, decodeLeft, decodeParkHit, decodeTake, encodeGrant, encodeLeave, encodeLeft, encodeParkHit,
  encodeTake, frameSender, type TrafficCar,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { SharedTraffic } from './shared';

/** A parked car further than this from its place (meters, |dx| + |dz|), or turned more than that (radians), has been moved. */
const MOVED = 0.15, TURNED = 0.03;
/** How long an asker waits at the door for the host's answer, ms. */
const ASK_MS = 2500;
/** A car that was granted, and that the player has not been heading for or sitting in for this long, is handed back, ms. */
const UNUSED_MS = 1000;
/** A left car is handed over once it stands still, or after this long rolling, ms. */
const ROLL_MS = 5000;
/** How long the leaver waits for the host's number before keeping the car as a private one, ms. */
const LEFT_MS = 3000;
/** The host stands a left car only once its driver is seen on foot, or after this, ms: two solid cars in one place fight. */
const GHOST_MS = 800;
/** Somebody who dropped out at the wheel: how long this browser waits to find out it is the host, ms. */
const STRAY_MS = 3000;
/** An asker must be this near the car, as the host sees them (they are shown a little in the past). Meters. */
const TAKE_REACH = 16;
const HIT_MS = 1000 / CAR_HIT_HZ;
const HIT_MIN = 0.3;
const HIT_REACH = 25;

type Mode = 'local' | 'host' | 'guest';
interface Pending { v: Vehicle; cls: number; n: number; at: number; refused: boolean }
interface Handed { id: number; token: number; car: TrafficCar; health: number; at: number }
interface Stray { id: number; kind: VehicleKind; color: number; x: number; z: number; h: number; at: number }

export class TownCars {
  readonly stats = {
    /** Parked frames and bytes sent (host) and received (guest). */
    parkedSent: 0, parkedBytesSent: 0, parkedGot: 0, parkedBytesGot: 0,
    /** Guest: cars asked for, granted, refused, and bytes of asking. Host: asked of it, given, refused, and bytes of answers. */
    asks: 0, grants: 0, refusals: 0, askBytes: 0, asked: 0, given: 0, refused: 0, answerBytes: 0,
    /** Cars handed to the host on getting out, and numbers received for them; host: cars stood for a leaver, and for somebody who dropped out. */
    leaves: 0, lefts: 0, leaveBytes: 0, stood: 0, strays: 0,
    parkHitsSent: 0, parkHitsDone: 0,
  };

  private readonly spots: ParkedSpot[];
  /** 1 = the place is empty for the town. Kept by every browser in town; only the host changes it. */
  private readonly gone: Uint8Array;
  private readonly spotOf = new Map<Vehicle, number>();
  private readonly localShare: number;
  // Host.
  /** The last few places emptied here and why, for the tests. */
  private readonly lost: string[] = [];
  private modeAt = 0;
  private readonly changes: number[] = [];
  private force = true;
  private fullAt = 0;
  private readonly out: Uint8Array;
  private readonly handed: Handed[] = [];
  private readonly strays: Stray[] = [];
  private readonly hitFrom = new Map<number, number>();
  // Guest.
  private pending: Pending | null = null;
  private granted: { v: Vehicle; at: number } | null = null;
  private readonly lefts = new Map<number, { v: Vehicle; at: number }>();
  private tok = 0;
  private readonly struck = new Map<number, { vx: number; vz: number; rx: number; rz: number }>();
  private hitAt = 0;
  private slice = 0;
  // Anybody in town.
  private readonly rolling: { v: Vehicle; at: number }[] = [];
  private readonly rec = blankTrafficCar();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic) {
    const spots = this.spots = game.parkSpots;
    this.gone = new Uint8Array(spots.length);
    this.out = new Uint8Array(PARKED_HEADER_BYTES + PARKED_MAX_CHANGES * PARKED_CHANGE_BYTES + Math.ceil(spots.length / 8));
    this.localShare = 0.55 * game.quality.density;
    for (let i = 0; i < spots.length; i++) { const v = spots[i].v; if (v) this.spotOf.set(v, i); }
    shared.onMode = (was, now) => this.changed(was, now);
    shared.onTick = (now) => this.tick(now);
    shared.onWorld = (buf) => this.world(buf);
    shared.onAsk = (buf, now) => this.asked(buf, now);
    shared.onOtherHit = (b, cvx, cvz, rx, rz) => {
      const i = this.spotOf.get(b);
      if (i === undefined) return;
      const h = this.struck.get(i);
      if (h) { h.vx += cvx; h.vz += cvz; h.rx = rx; h.rz = rz; } else this.struck.set(i, { vx: cvx, vz: cvz, rx, rz });
    };
    game.takeShared = (v) => this.ask(v);
    game.on('exit', (e) => this.exited(e.vehicle));
  }

  /** Somebody has just arrived: the next Parked frame carries every place. */
  refresh(): void { this.force = true; }

  private town(s: ParkedSpot): boolean { return s.roll < PARKED_TOWN_SHARE; }

  private atHome(s: ParkedSpot, v: Vehicle): boolean {
    return !v.removed && !v.sunk && !v.wreck && v.driver === null && v.health >= 100
      && Math.abs(v.x - s.x) + Math.abs(v.z - s.z) < MOVED && Math.abs(angleDiff(v.h, s.h)) < TURNED;
  }

  private put(i: number): Vehicle {
    const s = this.spots[i], v = this.game.vehicles.spawn(s.kind, s.x, s.z, s.h, s.color);
    s.v = v;
    this.spotOf.set(v, i);
    return v;
  }

  private unspot(i: number): void {
    const s = this.spots[i];
    if (s.v) this.spotOf.delete(s.v);
    s.v = null;
  }

  // ── Changing between alone, host and guest ──────────────────────────────────

  private changed(was: Mode, now: Mode): void {
    const vs = this.game.vehicles, spots = this.spots, gone = this.gone, tr = this.shared.sim;
    this.modeAt = performance.now();
    this.pending = null; this.granted = null;
    this.struck.clear(); this.hitFrom.clear();
    this.changes.length = 0;
    this.handed.length = 0;
    if (now === 'guest') {
      if (was === 'host') {
        // Still in town: the places stay as they are, and the cars in them are the new host's to push.
        for (const s of spots) if (s.v) vs.setShared(s.v, true);
        return;
      }
      // Into a town: every place as the town has it. Until the host's bits arrive that is "nothing has been touched".
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        let v = s.v;
        gone[i] = 0;
        if (v && !this.atHome(s, v)) {
          // Moved or driven while alone: that was another town. (The car this player is sitting in stays, as a private one.)
          this.unspot(i);
          if (v.driver !== 'player' && !v.removed) vs.remove(v);
          v = null;
        }
        if (this.town(s)) vs.setShared(v ?? this.put(i), true);
        else if (v) { this.unspot(i); vs.remove(v); }
      }
      return;
    }
    if (was === 'guest') {
      // This browser's to simulate again: host of the town, or alone.
      for (const s of spots) if (s.v) { vs.setShared(s.v, false); vs.park(s.v); }
      // (A car handed over and not yet numbered stays here as a private one.)
      for (const l of this.lefts.values()) if (!l.v.removed) vs.setShared(l.v, false);
      this.lefts.clear();
      this.force = now === 'host';
      return;
    }
    if (now !== 'host') return;
    // Alone until now, and somebody has arrived: this browser's streets are the town's.
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i], v = s.v;
      gone[i] = 0;
      if (!this.town(s)) { if (v && this.atHome(s, v)) { this.unspot(i); vs.remove(v); } continue; }
      if (v && this.atHome(s, v)) continue;
      if (v) {
        this.unspot(i);
        if (tr && !v.removed && !v.sunk && !v.wreck && v.driver === null) tr.abandon(v);
        gone[i] = 1;
      } else if (s.roll < this.localShare) gone[i] = 1;
      // (A place this browser's quality setting had left empty.)
      else this.put(i);
    }
    this.force = true;
  }

  // ── Host ───────────────────────────────────────────────────────────────────

  private lose(i: number, wid: number, why: string): void {
    const l = this.lost;
    if (l.length >= 8) l.shift();
    l.push(`${i} ${why}`);
    this.gone[i] = 1;
    this.unspot(i);
    this.changes.push(i, wid);
  }

  /** Just before each traffic frame: what has happened to the parked cars, told first. */
  private tick(now: number): void {
    const spots = this.spots, gone = this.gone, tr = this.shared.sim;
    if (!tr) return;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i], v = s.v;
      if (gone[i] || !v) continue;
      if (v.removed || v.sunk || v.wreck || v.driver !== null) { this.lose(i, 0, v.driver !== null ? 'driven' : v.sunk ? 'sunk' : v.wreck ? 'burnt' : 'towed'); continue; }
      if (v.health < 100 || Math.abs(v.x - s.x) + Math.abs(v.z - s.z) >= MOVED || Math.abs(angleDiff(v.h, s.h)) >= TURNED) {
        // Pushed or dented: one of the standing cars now, with a number in the traffic frames. (No number free: later.)
        const w = tr.abandon(v);
        if (w) {
          // For the tests: how far, how bent, and the nearest other car (who could have done it).
          let by = '', bd = 1e9;
          for (const o of this.game.vehicles.list) { const d = Math.hypot(o.x - v.x, o.z - v.z); if (o !== v && d < bd) { bd = d; by = `${o.spec.kind}/${o.driver ?? 'nobody'}/${Math.hypot(o.vx, o.vz).toFixed(1)}m/s`; } }
          this.lose(i, w, `${v.health < 100 ? 'dented' : 'pushed'} ${(Math.abs(v.x - s.x) + Math.abs(v.z - s.z)).toFixed(2)}m turned ${angleDiff(v.h, s.h).toFixed(3)} health ${v.health.toFixed(1)} nearest ${by} at ${bd.toFixed(1)}m mode-age ${((now - this.modeAt) / 1000).toFixed(1)}s`);
        }
      }
    }
    const ch = this.changes, full = this.force || now - this.fullAt >= PARKED_REFRESH_MS;
    if (ch.length === 0 && !full) return;
    const out = this.out, n = Math.min(ch.length / 2, PARKED_MAX_CHANGES);
    out[0] = Frame.World; out[1] = 0; out[2] = WorldKind.Parked; out[3] = n;
    let o = PARKED_HEADER_BYTES;
    for (let k = 0; k < n; k++) { const p = ch[k * 2]; out[o++] = p & 0xff; out[o++] = p >> 8; out[o++] = ch[k * 2 + 1]; }
    if (full) {
      const bytes = Math.ceil(spots.length / 8);
      out.fill(0, o, o + bytes);
      for (let i = 0; i < spots.length; i++) if (gone[i]) out[o + (i >> 3)] |= 1 << (i & 7);
      o += bytes;
    }
    if (!this.conn.send(out.subarray(0, o))) return;
    ch.splice(0, n * 2);
    if (full) { this.force = false; this.fullAt = now; }
    this.stats.parkedSent++; this.stats.parkedBytesSent += o;
  }

  /** A ToHost frame that is not a knock on a traffic car. */
  private asked(buf: ArrayBuffer, now: number): void {
    const tr = this.shared.sim, vs = this.game.vehicles;
    if (this.shared.mode !== 'host' || !tr || buf.byteLength < 3) return;
    const what = new Uint8Array(buf, 2, 1)[0];
    if (what === ToHostKind.ParkHit) {
      const h = decodeParkHit(buf);
      if (!h) return;
      const r = this.remotes.get(h.id), s = this.spots[h.car];
      if (!r || !r.seen || !s || this.gone[h.car] || !s.v || now - (this.hitFrom.get(h.id) ?? -1e9) < HIT_MS * 0.5) return;
      const sp = Math.hypot(h.vx, h.vz);
      if (!(sp >= HIT_MIN) || sp > 80 || Math.hypot(s.x - r.x, s.z - r.z) > HIT_REACH) return;
      this.hitFrom.set(h.id, now);
      vs.knock(s.v, r.vehicle, h.vx, h.vz, h.rx, h.rz);
      this.stats.parkHitsDone++;
      return;
    }
    if (what === ToHostKind.Take) {
      const a = decodeTake(buf);
      if (!a) return;
      this.stats.asked++;
      const r = this.remotes.get(a.id);
      let ok = false, health = 100;
      // Somebody known, on foot, and near enough to have a hand on the door.
      if (r && r.seen && !r.vehicle) {
        if (a.cls === CarClass.Traffic) {
          // (One of the traffic's, or a cruiser of the Patrol's: its crew is on foot from here on.)
          const v = this.shared.findCar(a.car);
          if (v && Math.hypot(v.x - r.x, v.z - r.z) < TAKE_REACH) {
            health = v.health;
            if (!this.shared.police?.give(v)) tr.give(v);
            vs.remove(v);
            ok = true;
          }
        } else if (a.cls === CarClass.Parked) {
          const s = this.spots[a.car];
          if (s && !this.gone[a.car] && this.town(s) && Math.hypot(s.x - r.x, s.z - r.z) < TAKE_REACH && (!s.v || s.v.driver === null)) {
            const v = s.v;
            this.lose(a.car, 0, 'taken');
            if (v) { health = v.health; vs.remove(v); }
            ok = true;
          }
        }
      }
      // The answer goes before anything else is said about the car: the asker's copy must be its own by then.
      this.conn.send(encodeGrant(a.id, a.cls, a.car, ok, health));
      this.stats.answerBytes += GRANT_BYTES;
      if (ok) this.stats.given++; else this.stats.refused++;
      return;
    }
    if (what === ToHostKind.Leave) {
      const l = decodeLeave(buf);
      if (!l || !KINDS[l.car.kind] || this.handed.length > 32) return;
      const r = this.remotes.get(l.id);
      if (!r || !r.seen || Math.hypot(l.car.x - r.x, l.car.z - r.z) > 60) return;
      this.handed.push({ id: l.id, token: l.token, car: l.car, health: l.health, at: now });
    }
  }

  /** A car for the town where somebody left one. Returns its number in the traffic frames, 0 when there is none to give. */
  private stand(kind: VehicleKind, color: number, x: number, z: number, h: number, health: number): number {
    const tr = this.shared.sim, vs = this.game.vehicles;
    if (!tr) return 0;
    const v = vs.spawn(kind, x, z, h, color);
    v.health = Math.max(0, Math.min(100, health));
    const w = tr.abandon(v);
    if (!w) vs.remove(v);
    // (On the leaver's screen it may have been pressed into a car that could not give way there. Here it can.)
    else vs.wake(v);
    return w;
  }

  /** Somebody has left town (index.ts). At the wheel: the car stays where it was last seen. */
  dropped(r: Remote, now: number): void {
    if (!this.shared.town || !r.seen || !r.kind || !r.vehicle) return;
    if (this.handed.some((l) => l.id === r.id)) return;
    this.strays.push({ id: r.id, kind: r.kind, color: r.color, x: r.x, z: r.z, h: r.h, at: now });
  }

  // ── Guest ──────────────────────────────────────────────────────────────────

  /** The host says a place is empty. wid: the number its car carries on with in the traffic frames, or 0. */
  private vanish(i: number, wid: number): void {
    if (this.gone[i]) return;
    this.gone[i] = 1;
    const v = this.spots[i].v, vs = this.game.vehicles;
    this.unspot(i);
    if (!v || v.removed) return;
    if (this.pending && this.pending.v === v) this.pending.refused = true;
    // (Only a test hook puts this player in a car without asking for it.)
    if (v.driver === 'player') { vs.setShared(v, false); return; }
    if (wid && this.shared.adoptShown(wid, v)) return;
    vs.remove(v);
  }

  /** A World frame from the host that is not traffic. */
  private world(buf: ArrayBuffer): void {
    const u8 = new Uint8Array(buf), len = u8.length;
    if (len < PARKED_HEADER_BYTES || u8[2] !== WorldKind.Parked) return;
    const n = u8[3];
    let o = PARKED_HEADER_BYTES;
    if (o + n * PARKED_CHANGE_BYTES > len) return;
    this.stats.parkedGot++; this.stats.parkedBytesGot += len;
    const spots = this.spots, gone = this.gone;
    for (let k = 0; k < n; k++, o += PARKED_CHANGE_BYTES) {
      const i = u8[o] | (u8[o + 1] << 8);
      if (i < spots.length) this.vanish(i, u8[o + 2]);
    }
    if (len - o < Math.ceil(spots.length / 8)) return;
    for (let i = 0; i < spots.length; i++) {
      const bit = (u8[o + (i >> 3)] >> (i & 7)) & 1;
      if (bit && !gone[i]) this.vanish(i, 0);
      else if (!bit && gone[i]) {
        // Back in its place (a host that knows better than the last one).
        gone[i] = 0;
        if (this.town(spots[i]) && !spots[i].v) this.game.vehicles.setShared(this.put(i), true);
      }
    }
  }

  /** The player is at the door of a car that is the town's (Game.takeShared). */
  private ask(v: Vehicle): 'wait' | 'no' {
    if (this.shared.mode !== 'guest') return 'no';
    const now = performance.now(), p = this.pending;
    if (p && p.v === v) {
      if (p.refused || now - p.at > ASK_MS) { this.pending = null; return 'no'; }
      return 'wait';
    }
    // Just got out of it, and the host has not numbered it yet.
    for (const l of this.lefts.values()) if (l.v === v) return 'wait';
    const wid = this.shared.widOf(v), i = wid ? -1 : this.spotOf.get(v) ?? -1;
    if (!wid && i < 0) return 'no';
    const cls = wid ? CarClass.Traffic : CarClass.Parked, n = wid || i;
    if (!this.conn.send(encodeTake(cls, n))) return 'no';
    this.stats.asks++; this.stats.askBytes += TAKE_BYTES;
    this.pending = { v, cls, n, at: now, refused: false };
    return 'wait';
  }

  /** A ToPlayer frame (index.ts): the host's answer to an ask, or the number of a car this player left. */
  toPlayer(buf: ArrayBuffer, now: number): void {
    if (this.shared.mode !== 'guest' || frameSender(buf) !== this.conn.host || buf.byteLength < 3) return;
    const what = new Uint8Array(buf, 2, 1)[0], vs = this.game.vehicles;
    if (what === ToPlayerKind.Grant) {
      const g = decodeGrant(buf);
      if (!g) return;
      const p = this.pending, mine = !!p && p.cls === g.cls && p.n === g.car;
      if (!g.ok) { this.stats.refusals++; if (mine && p) p.refused = true; return; }
      const v = mine && p ? p.v : g.cls === CarClass.Traffic ? this.shared.carOf(g.car) : this.spots[g.car]?.v ?? null;
      if (mine) this.pending = null;
      if (!v || v.removed) return;
      if (g.cls === CarClass.Traffic) this.shared.claim(v);
      else if (g.car < this.spots.length) { this.gone[g.car] = 1; this.unspot(g.car); }
      // This browser's own car from here on, from where it stands, as bent as the host had it.
      vs.setShared(v, false);
      v.health = g.health;
      v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.horn = false; v.ctl.handbrake = true;
      this.stats.grants++;
      // The player gets in on the next frame (Player.toDoor). If they have walked off instead, it goes back.
      this.granted = { v, at: now };
      return;
    }
    if (what === ToPlayerKind.Left) {
      const m = decodeLeft(buf);
      const l = m ? this.lefts.get(m.token) : undefined;
      if (!m || !l) return;
      this.lefts.delete(m.token);
      this.stats.lefts++;
      const v = l.v;
      if (v.removed) return;
      if (m.car === 0) { vs.setShared(v, false); return; }
      // The same car carries on, placed by the host's frames now. (Already shown under that number: one is enough.)
      if (!this.shared.adoptShown(m.car, v)) vs.remove(v);
    }
  }

  // ── Getting out ────────────────────────────────────────────────────────────

  private exited(v: Vehicle): void {
    if (!this.shared.town || v.removed || v.sunk || v.wreck) return;
    if (this.granted && this.granted.v === v) this.granted = null;
    if (!this.rolling.some((r) => r.v === v)) this.rolling.push({ v, at: performance.now() });
  }

  /** The car this player left has come to rest: it is the town's now. */
  private hand(v: Vehicle, now: number): void {
    const sh = this.shared, tr = sh.sim, mode = sh.mode;
    if (!sh.town || !tr) return;
    // Host, or alone in town for now: it is already on the streets the town will be shown.
    if (mode !== 'guest') { tr.abandon(v); return; }
    const r = this.rec, colors = v.spec.colors;
    r.id = 0;
    r.kind = KINDS.indexOf(v.spec.kind); r.paint = Math.max(0, colors.indexOf(v.color));
    r.x = v.x; r.y = v.y; r.z = v.z; r.yaw = v.h; r.speed = 0; r.steer = 0; r.pitch = v.pitch; r.roll = v.roll;
    r.flags = TrafficFlag.Driverless | (damageStep(v.health) << TRAFFIC_DAMAGE_SHIFT);
    const token = this.tok = (this.tok + 1) & 0xff;
    if (!this.conn.send(encodeLeave(token, r, v.health))) return;
    this.stats.leaves++; this.stats.leaveBytes += LEAVE_BYTES;
    // It is not this browser's to push about any more.
    this.game.vehicles.setShared(v, true);
    this.lefts.set(token, { v, at: now });
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number): void {
    const sh = this.shared, mode = sh.mode, vs = this.game.vehicles;
    // Cars this player got out of: handed over once they stand still.
    const ro = this.rolling;
    for (let k = ro.length - 1; k >= 0; k--) {
      const { v, at } = ro[k];
      if (!sh.town || v.removed || v.sunk || v.wreck || v.driver !== null) { ro.splice(k, 1); continue; }
      if (Math.abs(v.speed) < 0.3 || now - at > ROLL_MS) { ro.splice(k, 1); this.hand(v, now); }
    }
    if (mode === 'guest') {
      const g = this.granted;
      if (g) {
        if (g.v.driver === 'player' || g.v.removed) this.granted = null;
        else if (this.game.player.goingTo === g.v) g.at = now;
        else if (now - g.at > UNUSED_MS) { this.granted = null; g.v.driver = null; this.exited(g.v); }
      }
      for (const [t, l] of this.lefts) if (now - l.at > LEFT_MS) {
        // No answer (an older host, or the host changed in that moment): it stays here as a private car, as before this step.
        this.lefts.delete(t);
        if (!l.v.removed) vs.setShared(l.v, false);
      }
      // A parked car here is the host's to dent; whatever this browser's own guns did to it is undone a few at a time.
      const spots = this.spots;
      for (let k = 0; k < 24 && spots.length > 0; k++) {
        const v = spots[this.slice = (this.slice + 1) % spots.length].v;
        if (v && v.health < 100 && !v.wreck) v.health = 100;
      }
      this.report(now);
      // (Somebody dropped out at the wheel: if this browser turns out to be the new host, their car is its to stand.)
      const st = this.strays;
      for (let k = st.length - 1; k >= 0; k--) if (now - st[k].at > STRAY_MS) st.splice(k, 1);
      return;
    }
    if (mode !== 'host' && !sh.town) { this.strays.length = 0; return; }
    // Cars handed over by players who got out.
    const ha = this.handed;
    for (let k = 0; k < ha.length; k++) {
      const l = ha[k], r = this.remotes.get(l.id);
      if (r && r.vehicle && now - l.at < GHOST_MS) continue;
      ha.splice(k--, 1);
      const kind = KINDS[l.car.kind], colors = SPECS[kind].colors;
      const w = this.stand(kind, colors[l.car.paint] ?? colors[0], l.car.x, l.car.z, l.car.yaw, l.health);
      if (w) this.stats.stood++;
      if (r) { this.conn.send(encodeLeft(l.id, l.token, w)); this.stats.answerBytes += LEFT_BYTES; }
    }
    // And by players who dropped out at the wheel.
    const st = this.strays;
    for (let k = st.length - 1; k >= 0; k--) {
      const s = st[k];
      st.splice(k, 1);
      if (now - s.at > STRAY_MS) continue;
      if (this.stand(s.kind, s.color, s.x, s.z, s.h, 100)) this.stats.strays++;
    }
  }

  /** Guest: tell the host what this browser's car has just done to a parked car. */
  private report(now: number): void {
    const st = this.struck;
    if (st.size === 0 || now - this.hitAt < HIT_MS - 4) return;
    for (const [i, h] of st) {
      st.delete(i);
      if (Math.hypot(h.vx, h.vz) < HIT_MIN) continue;
      if (this.conn.send(encodeParkHit(i, h.vx, h.vz, h.rx, h.rz))) { this.stats.parkHitsSent++; this.stats.askBytes += PARK_HIT_BYTES; }
      this.hitAt = now;
      return;
    }
  }

  // ── For the tests ──────────────────────────────────────────────────────────

  /** window.__game.net().cars: counts only. */
  info(): Record<string, unknown> {
    let town = 0, here = 0, empty = 0;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (this.town(s)) town++;
      if (s.v) here++;
      if (this.gone[i]) empty++;
    }
    return { places: this.spots.length, town, here, empty, waiting: this.pending !== null, handing: this.lefts.size + this.rolling.length, lost: this.lost.join(', '), ...this.stats };
  }

  /** Every parked car this browser has in its place: [number, kind, colour, x, z, heading, shared?]. */
  list(): (number | string | boolean)[][] {
    const out: (number | string | boolean)[][] = [];
    for (let i = 0; i < this.spots.length; i++) {
      const v = this.spots[i].v;
      if (v && !v.removed) out.push([i, v.spec.kind, v.color, +v.x.toFixed(2), +v.z.toFixed(2), +v.h.toFixed(3), !!v.shared]);
    }
    return out;
  }

  /** The places the town counts as empty. */
  empties(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.gone.length; i++) if (this.gone[i]) out.push(i);
    return out;
  }
}
