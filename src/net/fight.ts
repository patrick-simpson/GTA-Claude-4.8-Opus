// Multiplayer, stage 3, step 3: weapons between players.
//
// A shot is an event, not state: while nobody fires, nothing in this file sends a byte.
//
// Seeing. Whatever this player's weapon does (ent/weapons.ts tells this file through WeaponsNet) is gathered for a
// tenth of a second and sent as ONE Event frame (protocol.ts, Fire): the weapon, where each drawn round went and what
// it met. The others draw the flash at the muzzle of the shooter as they are shown them, the line, and the mark where
// it landed, and hear the right report. A punch is the same event with bare hands. Which weapon somebody has RAISED
// rides in three spare bits of the state frames they send anyway, so it is in their hand before they fire. A rocket
// is one event when it leaves (the others fly a picture of it by the same sums) and one when it goes off (Blast).
//
// Hurting each other. Every browser is the judge of its own player and of the car they drive. A round or a fist that
// finds another player on the shooter's screen is a CLAIM in the same Fire event; the browser of the player named
// applies it, if it could be true: the shooter is shown within that weapon's reach of them, and it is no more than
// that weapon can do in the time since their last claim. The claim names no place of its own: where the shot came
// from is where the shooter's own state frames put them, so there is nothing to forge. The player hit then says how
// much health they have left (Vital), which is how the shooter and everybody else see that it counted; the same
// event says "dead" and "back on my feet". Being run over needs no message at all: another player's car is solid on
// the victim's screen and moving at its real speed, and the single player rule for a car hitting her does the rest.
//
// The town's things. A guest's bullets and fists on the host's people were already told to the host (people.ts,
// PedHurt); its bullets on the host's cars are told the same way here (CarShot), and the host takes the health off
// the real car. A blast is counted once: the browser it went off on tells everybody, each browser takes what it does
// to its own player and car, and the host alone takes what it does to the town's cars and people (Weapons.explode).
//
// Heat is each player's own, as since step 2: the shooter's own browser raises it by the single player rules, from
// its own gunfire and its own hits. Another player is a person like any other to the Patrol: shooting or punching
// one is the same crime as doing it to a pedestrian, and like any crime it counts only if somebody saw.
//
// On the backup the events travel too (they go between the players' browsers and need no host), so shots are seen
// and players can hurt each other there; the cars and people round them stay private, as everything else does there.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { clamp, damp } from '../core/util';
import type { Aimable } from '../ent/character';
import { CAR_SHARE, ROCKET_G, WEAPONS, makeGun, makeRocket, type WeaponsNet } from '../ent/weapons';
import { WATER_Y, groundAt } from '../world/plan';
import {
  CarClass, FIRE_HZ, FIRE_MAX_HITS, FIRE_MAX_SHOTS, HELD_MASK, HELD_SHIFT, HitFlag, PlayerEvent, ShotEnd, ToHostKind, VITAL_HZ,
  decodeBlast, decodeCarShot, decodeFire, decodeRocket, decodeVital, encodeBlast, encodeCarShot, encodeFire, encodeRocket, encodeVital,
  type FireHit, type FireShot,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { SharedTraffic } from './shared';
import type { TownCars } from './cars';

const FIRE_MS = 1000 / FIRE_HZ;
/** How long a weapon stays up after its last round, as on the shooter's own screen. ms. */
const RAISE_MS = 800;
const PUNCH_MS = 320;
/** The others are shown a little in the past and both may be moving: this much further than the weapon reaches is still believed. Meters. */
const GUN_SLACK = 15, FIST_SLACK = 4;
/** A claim may carry what its weapon does in this long (two frames of it may arrive together), and a little over. Seconds. */
const CLAIM_S = 0.25, CLAIM_OVER = 1.25;
/** A blast further than this from the guest who reports it did not come from their rocket (it flies six seconds at most). Meters. */
const BLAST_REACH = 320;
/** No blast is bigger than a car going up, with room for rounding. */
const BLAST_MAX_R = 12, BLAST_MAX_DMG = 160;
/** A kill is somebody's if they hurt the player within this long of the end. ms. */
const KILL_MS = 6000;

interface Arm {
  /** The weapon last fired, until when it is still up (this browser's clock, ms), and how far the arm is raised. */
  slot: number; until: number; k: number;
  /** The way the last round left, radians above level. */
  pitch: number;
  punchAt: number;
  guns: (THREE.Group | null)[];
  /** Which model is in the hand now (0 = none), for the tests. */
  shown: number;
}
interface Flight { mesh: THREE.Mesh; live: boolean; from: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
interface Budget { left: number; at: number }

export class TownFight implements WeaponsNet {
  readonly stats = {
    /** Fire events sent, their bytes, the rounds and the claims in them. */
    firesSent: 0, fireBytesSent: 0, shotsSent: 0, claimsSent: 0, swingsSent: 0,
    firesGot: 0, shotsDrawn: 0, swingsSeen: 0,
    /** Claims on this player: heard, applied, refused (and why the last one was), and the health they took. */
    claimsGot: 0, claimsDone: 0, claimsRefused: 0, damageTaken: 0, carDamageTaken: 0,
    rocketsSent: 0, rocketsGot: 0, blastsSent: 0, blastsGot: 0, blastsDone: 0,
    vitalsSent: 0, vitalsGot: 0, deaths: 0, kills: 0,
    /** Stage 3, step 4. Blasts sent that named another player as the cause, and blasts heard that named this one. */
    blamesSent: 0, blamesGot: 0,
    /** Bullets on the town's cars: told to the host (guest), and heard and applied (host). */
    carShotsSent: 0, carShotsGot: 0, carShotsDone: 0,
    /** Stage 4, step 5. Rounds that met a paused player here (not claimed); blasts that went off while this player was paused. */
    pausedSpared: 0, pausedBlasts: 0,
    /** Every byte this file has sent. */
    bytesSent: 0,
  };
  lastRefusal = '';
  /** The last blast this browser set off (from 0) or heard of (from = whose), for the tests. */
  readonly lastBlast = { from: -1, x: 0, y: 0, z: 0 };

  // What this player's weapon has done since the last Fire event.
  private slot = 0;
  private readonly shots: FireShot[] = [];
  private nShots = 0;
  private readonly hits: FireHit[] = [];
  private swung = false;
  private fireAt = 0;
  private readonly carShots = new Map<number, number>();
  // This player's own health, as the others have been told.
  private wasDead = false;
  private vitalDue = false;
  private vitalAt = 0;
  private hurtBy = 0;
  private hurtAt = -1e9;
  // The others.
  private readonly arms = new Map<number, Arm>();
  private readonly bodies = new Map<Person, Remote>();
  private readonly carList: Vehicle[] = [];
  private readonly carOf = new Map<Vehicle, Remote>();
  private readonly flights: Flight[] = [];
  private readonly budgets = new Map<number, Budget>();
  private readonly carBudgets = new Map<number, Budget>();
  private readonly blastBudgets = new Map<number, Budget>();
  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };
  private readonly v3 = new THREE.Vector3();

  /** The other players' held cars as drawn here (held.ts), set by index.ts. */
  held: { list(): readonly Vehicle[]; has(v: Vehicle): boolean } | null = null;
  /** Stage 4, step 5 (crew.ts): a round of this player's on a starter's car, claimed if this player is on their crew. */
  crewHit: ((v: Vehicle, dmg: number) => boolean) | null = null;
  /** Stage 4, step 5 (crew.ts): is this player on this browser's crew? Their blasts then hurt its held cars. */
  crewMate: ((id: number) => boolean) | null = null;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic, private readonly parked: TownCars) {}

  private get on(): boolean { return this.conn.status === 'online' && this.remotes.size > 0; }

  private send(buf: ArrayBuffer): boolean {
    if (!this.conn.send(buf)) return false;
    this.stats.bytesSent += buf.byteLength;
    return true;
  }

  // ── What the weapons ask and tell (WeaponsNet) ──────────────────────────────

  cars(): readonly Vehicle[] { return this.carList; }

  isPlayer(p: Person): boolean { return this.bodies.has(p); }

  hurtsHeld(from: number): boolean { return from !== 0 && !!this.crewMate?.(from); }

  hostsTown(): boolean { return this.shared.mode === 'host'; }

  nobodyNear(x: number, z: number, r: number): boolean {
    // (Only the host's cars are anybody else's to see: a guest's private wreck is tidied by its own rule.)
    if (this.shared.mode !== 'host') return true;
    for (const o of this.remotes.values()) if (o.seen && Math.hypot(o.x - x, o.z - z) < r) return false;
    return true;
  }

  private claim(target: number, dmg: number, dx: number, dz: number, flags: number): void {
    const h = Math.atan2(dx, dz);
    for (const k of this.hits) if (k.target === target && k.flags === flags) { k.damage += dmg; k.h = h; return; }
    this.hits.push({ target, damage: dmg, h, flags });
  }

  hitPlayer(p: Person, dmg: number, dx: number, dz: number, fist: boolean): boolean {
    const r = this.bodies.get(p);
    if (!r) return false;
    if (fist) this.slot = 0;
    // (In their pause menu: the round stops at them and nothing is claimed. Their own browser would refuse it anyway.)
    if (r.paused) { this.stats.pausedSpared++; return true; }
    this.claim(r.id, dmg, dx, dz, fist ? HitFlag.Fist : 0);
    return true;
  }

  hitCar(v: Vehicle, dmg: number): boolean {
    const r = this.carOf.get(v);
    if (r) { if (r.paused) { this.stats.pausedSpared++; return true; } this.claim(r.id, dmg, 0, 1, HitFlag.Car); return true; }
    // A car a script is holding for another player: theirs to count. On their crew (crew.ts) the round is a claim on it,
    // which their browser judges; anybody else's rounds do nothing to it.
    if (this.held?.has(v)) { this.crewHit?.(v, dmg); return true; }
    if (!v.shared) return false;
    // One of the town's, shown here: the host counts its health. By its number in the traffic frames, or by its place at the kerb.
    const wid = this.shared.widOf(v), place = wid ? -1 : this.parked.placeOf(v);
    if (wid || place >= 0) {
      const key = wid ? wid : 0x10000 | place;
      this.carShots.set(key, (this.carShots.get(key) ?? 0) + dmg);
    }
    return true;
  }

  shot(slot: number, end: number, x: number, y: number, z: number): void {
    // (A different weapon inside one tenth of a second: what was gathered goes first.)
    if (slot !== this.slot && (this.nShots > 0 || this.hits.length > 0)) this.flush(performance.now(), true);
    this.slot = slot;
    if (this.nShots >= FIRE_MAX_SHOTS) return;
    const s = this.shots[this.nShots] ?? (this.shots[this.nShots] = { end: 0, x: 0, y: 0, z: 0 });
    s.end = end; s.x = x; s.y = y; s.z = z;
    this.nShots++;
  }

  swing(): void {
    if (this.nShots > 0) this.flush(performance.now(), true);
    this.slot = 0;
    this.swung = true;
  }

  rocket(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    if (this.send(encodeRocket(x, y, z, vx, vy, vz))) this.stats.rocketsSent++;
  }

  blast(x: number, y: number, z: number, radius: number, damage: number, by: number): void {
    if (this.send(encodeBlast(x, y, z, radius, damage, by))) this.stats.blastsSent++;
    if (by) this.stats.blamesSent++;
    const l = this.lastBlast;
    l.from = 0; l.x = x; l.y = y; l.z = z;
  }

  /** Send what has been gathered: at most FIRE_HZ times a second. */
  private flush(now: number, force = false): void {
    if (!force && now - this.fireAt < FIRE_MS - 4) return;
    const st = this.stats;
    if (this.nShots > 0 || this.hits.length > 0 || this.swung) {
      const nh = Math.min(this.hits.length, FIRE_MAX_HITS);
      const buf = encodeFire(this.slot, this.shots, this.nShots, this.hits, nh);
      if (this.send(buf)) {
        st.firesSent++; st.fireBytesSent += buf.byteLength; st.shotsSent += this.nShots; st.claimsSent += nh;
        if (this.swung) st.swingsSent++;
      }
      // (Sent or not: a round nobody could be told of is not worth telling late.)
      this.nShots = 0; this.swung = false;
      this.hits.splice(0, nh);
      this.fireAt = now;
    }
    if (this.carShots.size > 0) {
      let n = 0;
      for (const [key, dmg] of this.carShots) {
        this.carShots.delete(key);
        const cls = key & 0x10000 ? CarClass.Parked : CarClass.Traffic;
        if (this.send(encodeCarShot(cls, key & 0xffff, dmg))) st.carShotsSent++;
        if (++n >= 3) break;
      }
      this.fireAt = now;
    }
  }

  // ── What the others have done ───────────────────────────────────────────────

  /** An Event frame with one of this step's codes. now: this browser's clock, ms. */
  event(code: number, buf: ArrayBuffer, now: number): void {
    if (code === PlayerEvent.Fire) this.fire(buf, now);
    else if (code === PlayerEvent.Rocket) this.launched(buf);
    else if (code === PlayerEvent.Blast) this.blasted(buf, now);
    else if (code === PlayerEvent.Vital) this.vital(buf);
  }

  private arm(id: number): Arm {
    let a = this.arms.get(id);
    if (!a) this.arms.set(id, a = { slot: 0, until: 0, k: 0, pitch: 0, punchAt: -1e9, guns: [], shown: 0 });
    return a;
  }

  /** Where the muzzle of `r`'s weapon is, as they are shown here, for a round going to (tx, ty, tz): into this.a. Returns how steeply it left. */
  private muzzle(r: Remote, len: number, tx: number, ty: number, tz: number): number {
    const m = this.a, car = r.vehicle;
    if (car) {
      // Out of the window on the side the round went.
      const s = Math.sin(car.h), c = Math.cos(car.h);
      const side = (tx - car.x) * -c + (tz - car.z) * s > 0 ? 1 : -1;
      m.x = car.x - c * side * (car.hw + 0.12); m.z = car.z + s * side * (car.hw + 0.12);
      m.y = car.y + Math.min(1.05, car.spec.height * 0.72);
      return 0;
    }
    const body = r.body, H = body ? body.look.height : 1, s = Math.sin(r.h), c = Math.cos(r.h);
    // Right shoulder, then an arm's length along the shot (as ent/weapons.ts holds it).
    const sx = r.x - c * 0.17, sy = r.y + 1.4 * H, sz = r.z + s * 0.17;
    let dx = tx - sx, dy = ty - sy, dz = tz - sz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const reach = Math.min(0.5 * H + len, l * 0.5);
    m.x = sx + dx * reach; m.y = sy + dy * reach; m.z = sz + dz * reach;
    return Math.asin(clamp(dy, -1, 1));
  }

  private fire(buf: ArrayBuffer, now: number): void {
    const m = decodeFire(buf), g = this.game;
    if (!m) return;
    const r = this.remotes.get(m.id), w = WEAPONS[m.slot];
    if (!r || !r.seen || !w) return;
    this.stats.firesGot++;
    const arm = this.arm(r.id), fx = g.fx.emitters;
    arm.slot = m.slot;
    if (m.slot === 0) { arm.punchAt = now; this.stats.swingsSeen++; }
    else if (m.shots.length > 0) arm.until = now + RAISE_MS;
    const from = this.a, to = this.b;
    for (const s of m.shots) {
      arm.pitch = this.muzzle(r, w.len, s.x, s.y, s.z);
      let dx = s.x - from.x, dy = s.y - from.y, dz = s.z - from.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      to.x = s.x; to.y = s.y; to.z = s.z;
      fx.muzzleFlash(from.x, from.y, from.z, dx, dy, dz);
      fx.tracer(from, to);
      // The mark it left. The face it struck is not sent: one turned back at the shooter is near enough to draw.
      if (s.end === ShotEnd.Wall) fx.bulletImpact(s.x, s.y, s.z, -dx, -dy, -dz);
      else if (s.end === ShotEnd.Ground) { fx.bulletImpact(s.x, s.y, s.z, 0, 1, 0); fx.dust(s.x, s.y, s.z, 0, 0, 0.7, false); }
      else if (s.end === ShotEnd.Water) fx.splash(s.x, s.z, false);
      else if (s.end === ShotEnd.Car) fx.sparks(s.x, s.y, s.z, -dx, -dy + 0.4, -dz, 5, 5);
      else if (s.end === ShotEnd.Body) fx.dust(s.x, s.y, s.z, dx, dz, 0.6, false);
      this.stats.shotsDrawn++;
    }
    if (m.shots.length > 0) g.emit('gunshot', { x: from.x, z: from.z, by: 'player', id: w.id });
    for (const h of m.hits) if (h.target === this.conn.id) this.claimed(r, m.slot, h, now);
  }

  private refuse(why: string): void { this.stats.claimsRefused++; this.lastRefusal = why; }

  /** Another player says their round or fist found this one. This browser decides. */
  private claimed(r: Remote, slot: number, h: FireHit, now: number): void {
    const p = this.game.player, w = WEAPONS[slot], st = this.stats;
    st.claimsGot++;
    const fist = (h.flags & HitFlag.Fist) !== 0, car = (h.flags & HitFlag.Car) !== 0;
    // (A rocket has no rounds that find people: it goes off, and that is a Blast.)
    if (w.id === 'launcher' || fist !== (slot === 0) || (fist && car)) return this.refuse('no such blow');
    if (p.health <= 0) return this.refuse('already down');
    // In the pause menu nobody can touch her (stage 4, step 5); the moment she is back, they can.
    if (this.game.state === 'paused') return this.refuse('paused');
    // Where it came from is where their own frames put them: within that weapon's reach of here?
    const d = Math.hypot(r.x - p.x, r.z - p.z);
    if (d > w.range + (fist ? FIST_SLACK : GUN_SLACK)) return this.refuse(`out of reach: ${d.toFixed(0)} m for the ${w.id}`);
    // No more than that weapon can do in the time since their last claim.
    const one = w.damage * Math.max(1, w.pellets), rate = one * w.rpm / 60 * CLAIM_OVER, cap = Math.max(one, rate * CLAIM_S) * CLAIM_OVER;
    let b = this.budgets.get(r.id);
    if (!b) this.budgets.set(r.id, b = { left: cap, at: now });
    b.left = Math.min(cap, b.left + rate * Math.max(0, now - b.at) / 1000);
    b.at = now;
    // (What strikes a car was scaled down for the car on the way: the budget is in rounds.)
    const asked = car ? h.damage / CAR_SHARE : h.damage, full = Math.min(asked, b.left);
    if (!(full > 0.5)) return this.refuse('faster than that weapon fires');
    if (car) {
      const v = p.vehicle;
      if (!v) return this.refuse('not in a car');
      b.left -= full;
      v.health = Math.max(0, v.health - full * CAR_SHARE);
      // (If it burns for this, the blast is theirs.)
      p.weapons.blameCar(v, r.id);
      st.carDamageTaken += full * CAR_SHARE;
    } else {
      if (p.vehicle) return this.refuse('in a car');
      b.left -= full;
      this.b.x = r.x; this.b.y = r.y; this.b.z = r.z;
      p.hurt(full, this.b);
      // A fist puts her on the ground for a moment, as it does anybody.
      if (fist) p.knockDown(Math.sin(h.h) * 2.2, Math.cos(h.h) * 2.2, 0);
      st.damageTaken += full;
      this.hurtBy = r.id; this.hurtAt = now;
      this.vitalDue = true;
    }
    st.claimsDone++;
  }

  private launched(buf: ArrayBuffer): void {
    const m = decodeRocket(buf);
    if (!m) return;
    const r = this.remotes.get(m.id);
    // Somebody seen, from near where they are shown, at a speed a rocket has.
    if (!r || !r.seen || Math.hypot(m.x - r.x, m.z - r.z) > 30 || Math.hypot(m.vx, m.vy, m.vz) > 70) return;
    this.stats.rocketsGot++;
    let f = this.flights.find((o) => !o.live);
    if (!f) {
      if (this.flights.length >= 8) return;
      const mesh = makeRocket();
      this.game.scene.add(mesh);
      this.flights.push(f = { mesh, live: false, from: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 });
    }
    f.live = true; f.from = m.id; f.t = 0;
    f.x = m.x; f.y = m.y; f.z = m.z; f.vx = m.vx; f.vy = m.vy; f.vz = m.vz;
    f.mesh.position.set(f.x, f.y, f.z);
    f.mesh.visible = true;
    const a = this.arm(r.id);
    a.slot = 4; a.until = performance.now() + RAISE_MS;
    const sp = Math.hypot(m.vx, m.vy, m.vz) || 1;
    this.game.fx.emitters.muzzleFlash(m.x, m.y, m.z, m.vx / sp, m.vy / sp, m.vz / sp);
    this.game.emit('gunshot', { x: m.x, z: m.z, by: 'player', id: 'launcher' });
  }

  private blasted(buf: ArrayBuffer, now: number): void {
    const m = decodeBlast(buf);
    if (!m) return;
    const r = this.remotes.get(m.id), st = this.stats;
    if (!r) return;
    st.blastsGot++;
    // The rocket it was, if it was one: its picture ends here, wherever this browser had flown it to.
    let first: Flight | null = null;
    for (const f of this.flights) if (f.live && f.from === m.id && (!first || f.t > first.t)) first = f;
    if (first) { first.live = false; first.mesh.visible = false; }
    if (m.radius > BLAST_MAX_R || m.damage > BLAST_MAX_DMG || m.radius <= 0) return;
    // The host's may be anywhere in town (its cars burn round every player). A guest's is its own rocket or its own car.
    if (m.id !== this.conn.host && r.seen && Math.hypot(m.x - r.x, m.z - r.z) > BLAST_REACH) return;
    // No more of them than one player can set off: four at once, then one every half second.
    let b = this.blastBudgets.get(m.id);
    if (!b) this.blastBudgets.set(m.id, b = { left: 4, at: now });
    b.left = Math.min(4, b.left + Math.max(0, now - b.at) / 500);
    b.at = now;
    if (b.left < 1) return;
    b.left -= 1;
    st.blastsDone++;
    const l = this.lastBlast;
    l.from = m.id; l.x = m.x; l.y = m.y; l.z = m.z;
    // Drawn here; this browser's own player and car take their share; the town's cars and people, only if this is the host.
    const hp = this.game.player.health;
    if (this.game.state === 'paused') st.pausedBlasts++;
    this.game.player.weapons.explode(m.x, m.y, m.z, m.radius, m.damage, false, m.id);
    if (this.game.player.health < hp) { this.hurtBy = m.id; this.hurtAt = now; this.vitalDue = true; }
    // The car that went up there was set alight by this player's rounds: their crime, as alone, if anybody saw.
    if (m.by === this.conn.id) { st.blamesGot++; this.game.player.weapons.blamed(m.x, m.z); }
  }

  private vital(buf: ArrayBuffer): void {
    const m = decodeVital(buf);
    if (!m) return;
    const r = this.remotes.get(m.id), g = this.game;
    if (!r) return;
    this.stats.vitalsGot++;
    r.health = m.health;
    if (m.health <= 0 && !r.dead) {
      r.dead = true; r.deaths++;
      const mine = m.by === this.conn.id;
      if (mine) this.stats.kills++;
      r.killedBy = m.by;
      if (r.seen && g.state === 'play') g.hud.toast(mine ? `You clocked ${r.text} out. Mercy General has been told.` : `${r.text} clocked out.`, 4);
    } else if (m.health > 0 && r.dead) { r.dead = false; r.respawns++; }
  }

  /** Host: a ToHost frame about bullets on one of the town's cars. Returns whether it was one. */
  toHost(buf: ArrayBuffer, now: number): boolean {
    if (buf.byteLength < 3 || new Uint8Array(buf, 2, 1)[0] !== ToHostKind.CarShot) return false;
    const m = decodeCarShot(buf), st = this.stats;
    if (!m || this.shared.mode !== 'host') return true;
    st.carShotsGot++;
    const r = this.remotes.get(m.id);
    if (!r || !r.seen) return true;
    const v = m.cls === CarClass.Traffic ? this.shared.findCar(m.car) : m.cls === CarClass.Parked ? this.parked.parkedAt(m.car) : null;
    // A car there is, within a gun's reach of whoever says they shot it.
    if (!v || v.wreck || Math.hypot(v.x - r.x, v.z - r.z) > 140 + GUN_SLACK) return true;
    // No faster than the quickest weapon takes health off a car (the shotgun's eight at once, the stapler's twelve a second).
    const rate = 60 * CLAIM_OVER, cap = 40;
    let b = this.carBudgets.get(m.id);
    if (!b) this.carBudgets.set(m.id, b = { left: cap, at: now });
    b.left = Math.min(cap, b.left + rate * Math.max(0, now - b.at) / 1000);
    b.at = now;
    const dmg = Math.min(m.damage, b.left);
    if (!(dmg > 0)) return true;
    b.left -= dmg;
    // (Under 20 its engine burns and it goes up, by the host's own single player rules; that is a Blast for everybody,
    // and it names whoever's rounds these were.)
    v.health = Math.max(0, v.health - dmg);
    this.game.player.weapons.blameCar(v, m.id);
    st.carShotsDone++;
    return true;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number, dt: number): void {
    const g = this.game, p = g.player, on = this.on;
    // Who the others are, for the weapons' own questions.
    const bodies = this.bodies, cars = this.carList, carOf = this.carOf;
    bodies.clear(); carOf.clear(); cars.length = 0;
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      const b = r.body, v = r.vehicle;
      if (b) bodies.set(b, r);
      if (v) { cars.push(v); carOf.set(v, r); }
    }
    // (And the cars their scripts have standing about: shown here, so they stop a round and burn when their owner says.)
    if (this.held) for (const v of this.held.list()) cars.push(v);
    p.weapons.net = on ? this : null;
    if (!on) {
      this.nShots = 0; this.hits.length = 0; this.swung = false; this.carShots.clear();
      this.vitalDue = false;
      this.wasDead = p.health <= 0;
    } else {
      this.flush(now);
      // This player's own health, told when another player took some of it, at the end, and on getting up again.
      const hp = p.health;
      if (hp <= 0 && !this.wasDead) {
        this.wasDead = true; this.vitalDue = false;
        this.stats.deaths++;
        if (this.send(encodeVital(0, now - this.hurtAt < KILL_MS ? this.hurtBy : 0))) { this.stats.vitalsSent++; this.vitalAt = now; }
      } else if (hp > 0 && this.wasDead) {
        this.wasDead = false; this.vitalDue = false;
        if (this.send(encodeVital(hp, 0))) { this.stats.vitalsSent++; this.vitalAt = now; }
      } else if (this.vitalDue && hp > 0 && now - this.vitalAt >= 1000 / VITAL_HZ) {
        this.vitalDue = false;
        if (this.send(encodeVital(hp, this.hurtBy))) { this.stats.vitalsSent++; this.vitalAt = now; }
      }
    }
    for (const [id, a] of this.arms) {
      const r = this.remotes.get(id);
      if (!r) { this.dropArm(a); this.arms.delete(id); continue; }
      this.pose(r, a, now, dt);
    }
    // (Somebody who has only ever raised a weapon, never fired: their arm starts here.)
    for (const r of this.remotes.values()) if (r.seen && (r.flags & HELD_MASK) !== 0 && !this.arms.has(r.id)) this.arm(r.id);
    this.fly(dt);
  }

  /** The weapon in another player's hand, and the arm that holds it. */
  private pose(r: Remote, a: Arm, now: number, dt: number): void {
    const body = r.body as (Person & Partial<Aimable>) | null;
    const held = (r.flags & HELD_MASK) >> HELD_SHIFT;
    const slot = held > 0 && held < WEAPONS.length ? held : now < a.until ? a.slot : 0;
    const foot = !!body && r.kind === null && body.visible && body.pose !== 'down' && body.pose !== 'swim';
    const up = foot && slot > 0;
    a.k = damp(a.k, up ? 1 : 0, up ? 16 : 9, dt);
    for (let i = 1; i < a.guns.length; i++) { const o = a.guns[i]; if (o && i !== slot) o.visible = false; }
    a.shown = 0;
    if (!body) return;
    let k = a.k, pitch = now < a.until ? a.pitch : 0, two = slot > 0 && !WEAPONS[slot].oneHand;
    const pt = (now - a.punchAt) / PUNCH_MS;
    if (pt >= 0 && pt < 1 && foot) {
      // A jab: out fast, back slower (as on the puncher's own screen).
      k = pt < 0.3 ? pt / 0.3 : 1 - (pt - 0.3) / 0.7;
      two = false; pitch = 0.05;
    }
    body.aim = foot ? k : 0; body.aimPitch = pitch; body.aimTwo = two;
    if (!up || a.k <= 0.35) return;
    let gun = a.guns[slot];
    if (gun === undefined) {
      gun = a.guns[slot] = makeGun(WEAPONS[slot].id);
      if (gun) this.game.scene.add(gun);
    }
    if (!gun) return;
    // Held as ent/weapons.ts holds the player's own: from the right shoulder, an arm's length along the aim.
    const w = WEAPONS[slot], H = body.look.height, s = Math.sin(body.h), c = Math.cos(body.h), cp = Math.cos(pitch);
    const dx = s * cp, dy = Math.sin(pitch), dz = c * cp, reach = 0.5 * H + w.len;
    const mx = body.x - c * 0.17 + dx * reach, my = body.y + 1.4 * H + dy * reach, mz = body.z + s * 0.17 + dz * reach;
    gun.visible = true;
    gun.position.set(mx - dx * w.len, my - dy * w.len - 0.02, mz - dz * w.len);
    this.v3.set(mx + dx, my + dy, mz + dz);
    gun.lookAt(this.v3);
    a.shown = slot;
  }

  /** The others' rockets: a picture flown by the launcher's own sums until its Blast arrives. */
  private fly(dt: number): void {
    for (const f of this.flights) {
      if (!f.live) continue;
      f.t += dt;
      f.vy -= ROCKET_G * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      // Past where it must have gone off (the ground, the sea, its six seconds): the Blast will say where.
      if (f.t > 6.5 || f.y < Math.max(groundAt(f.x, f.z), WATER_Y) - 0.5) { f.live = false; f.mesh.visible = false; continue; }
      const sp = Math.hypot(f.vx, f.vy, f.vz) || 1, dx = f.vx / sp, dy = f.vy / sp, dz = f.vz / sp;
      f.mesh.position.set(f.x, f.y, f.z);
      this.v3.set(f.x + dx, f.y + dy, f.z + dz);
      f.mesh.lookAt(this.v3);
      this.game.fx.emitters.tireSmoke(f.x - dx * 0.4, f.y - dy * 0.4, f.z - dz * 0.4, 0, 0, 0.7);
    }
  }

  private dropArm(a: Arm): void {
    for (const o of a.guns) if (o) this.game.scene.remove(o);
    a.guns.length = 0;
  }

  /** Somebody has left town (index.ts), or everybody has. */
  dropped(id: number): void {
    const a = this.arms.get(id);
    if (a) { this.dropArm(a); this.arms.delete(id); }
    this.budgets.delete(id); this.carBudgets.delete(id); this.blastBudgets.delete(id);
    for (const f of this.flights) if (f.live && f.from === id) { f.live = false; f.mesh.visible = false; }
  }
  clear(): void {
    for (const id of [...this.arms.keys()]) this.dropped(id);
    for (const f of this.flights) { f.live = false; f.mesh.visible = false; }
    this.budgets.clear(); this.carBudgets.clear(); this.blastBudgets.clear();
  }

  /** For the tests (window.__game.net().fight). */
  info(): Record<string, unknown> {
    const p = this.game.player, r2 = (v: number): number => +v.toFixed(2);
    return {
      ...this.stats, lastRefusal: this.lastRefusal, on: this.on, lastBlast: { ...this.lastBlast },
      // This player's own: health, and the weapon the others are shown in their hand (0 = none).
      health: r2(p.health), raised: p.weapons.raised,
      // Every fire burning on this screen (ent/weapons.ts): told = under a car this browser is only shown.
      burns: p.weapons.burnInfo(), blasts: p.weapons.stats.blasts, crimes: p.weapons.stats.crimes,
      // The others: the weapon drawn in their hand here (0 = none), how far the arm is up, and the health they last told of.
      arms: [...this.remotes.values()].map((r) => { const a = this.arms.get(r.id); return { id: r.id, gun: a ? a.shown : 0, arm: a ? r2(a.k) : 0, held: (r.flags & HELD_MASK) >> HELD_SHIFT, health: r2(r.health), dead: r.dead, deaths: r.deaths, respawns: r.respawns, killedBy: r.killedBy }; }),
      rockets: this.flights.filter((f) => f.live).map((f) => ({ from: f.from, x: r2(f.x), y: r2(f.y), z: r2(f.z) })),
    };
  }
}
