// Multiplayer, stage 3, step 1: the same people on the street.
//
// On the MAIN service the host's browser simulates the town's pedestrians exactly as a single player game does, but
// keeps them round EVERY player out of the one cast (sim/peds.ts, "one cast, kept round every player"), and tells the
// others where they are (protocol.ts, WorldKind.People). A guest stops walking a crowd of its own and shows the
// host's, in the bodies of its own cast, so it never draws more people than its own single player game would.
//
// What travels. A person's number, place, the way they go, their speed and their pose: 8 bytes. The LOOK is not sent:
// it is made from the number (townLook), the same on every screen. A record goes only when the person is no longer
// where the last record says they would be by now, so a pavement of people walking straight costs very little and
// somebody standing still costs nothing until the next whole frame (every PEOPLE_WHOLE_MS).
// Showing. A guest carries each person on from their last record along their heading, and eases what is drawn onto
// that: no buffer of old frames, so a fall is seen as soon as it is heard of.
//
// A guest's hand in it. Its own car against a shown person, its fists and its bullets are judged on ITS screen (it
// is the one who can see whether they met), shown there at once as a first guess, and told to the host in 8 bytes;
// the host applies them to the real person and everybody, the guest included, then sees what the host decided.
// A shot, a blast or a crash on a guest's screen is told to the host the same way, and the host's people run.
// The host's people also see every player: they step out of the way of the other players' cars and are frightened
// by them exactly as by the host's own (sim/peds.ts; only the knock itself is left to the driver's browser).
//
// Changing hands. A new host takes over the people it was showing where they stand, with their numbers, so the rest
// of the town sees the same people carry on. A browser that drops to single player or to the backup does the same
// and has a private crowd again. Only on the main service: on the backup nothing here is ever sent.
// A guest whose host says nothing about people (an older page) keeps its private crowd.

import type { Game } from '../core/game';
import { kid } from '../core/kid';
import type { Look, Person } from '../core/api';
import { RNG, angleDiff, dampAngle } from '../core/util';
import { Ambient } from '../sim/ambient';
import type { Peds, Walker } from '../sim/peds';
import { groundAt } from '../world/plan';
import {
  BANG_HZ, OFFICER_WID0, PEOPLE_HEADER_BYTES, PEOPLE_HZ, PEOPLE_MAX, PEOPLE_WHOLE_MS, PED_ASK_BYTES, PED_BYTES, PED_GONE, PED_HEALTH_SHIFT, PED_POSES, PedFlag, ToHostKind,
  blankPed, decodeBang, decodePedHurt, decodePedKnock, decodePeople, encodeBang, encodePedHurt, encodePedKnock, encodePeople, frameSender, pedHealthBits, quantPed,
  type PedRec, type PeopleFrame,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { SharedTraffic } from './shared';

const SEND_MS = 1000 / PEOPLE_HZ;
/** The longest a person is carried on from one record, seconds. Longer than a whole frame takes to come round. */
const EXTRAP_S = 4;
/** A person this far from where their last record puts them gets a new one. Meters. */
const DEVIATE = 0.3;
/** People further than this from every player are not sent at all. Meters. */
const SEND_FAR = 250;
/** A guest that hears nothing about people for this long has a host that does not send them: private crowd. */
const STALE_MS = 6000;
/** What is drawn closes on where the person is at this rate (1/s); further off than SNAP it is simply put there. */
const EASE = 12, SNAP = 4;
/** A first guess at a fall is held this long for the host to confirm. */
const GUESS_MS = 900;
/** As sim/peds.ts: a car faster than this knocks a person down. */
const KNOCK = 2.2;
const POSE_DOWN = PED_POSES.indexOf('down'), POSE_RUN = PED_POSES.indexOf('run'), POSE_SIT = PED_POSES.indexOf('sit');

const looks = new Map<number, Look>();
/** The Harbor Patrol's uniform (as sim/police.ts dresses its officers), on a body that goes with the number. */
const SKINS = [0xc68e6a, 0x8d5a3b, 0xe2b594, 0x6b4630];
/** The look of person `wid`: the same in every browser, made from the number alone. Officers wear the uniform. */
export function townLook(game: Game, wid: number): Look {
  let l = looks.get(wid);
  if (l) return l;
  if (wid >= OFFICER_WID0) l = { skin: SKINS[wid & 3], hair: 0x2a2018, top: 0xa9c1d4, bottom: 0x1a2238, shoes: 0x111111, hat: 0xf2e8cf, height: 0.97 + ((wid >> 2) & 7) * 0.012, build: 1.08 };
  else l = game.people.randomLook(new RNG((Math.imul(wid, 2654435761) ^ 0x51ed270b) >>> 0 || 1), true);
  looks.set(wid, l);
  return l;
}

/**
 * People the town must see who are not of the crowd: the police's officers (stage 3, step 2; police.ts). They travel
 * in the same frames, numbered from OFFICER_WID0 up.
 */
export interface PeopleOwner {
  /** Host: every such person, for the frame being built. hard: down and not getting up. */
  each(fn: (wid: number, p: Person, hard: boolean) => void): void;
  /** Host: another player (their number) has punched or shot one, or run one down. */
  hurt(wid: number, by: number, dmg: number, dx: number, dz: number, fist: boolean, shove: number): void;
  struck(wid: number, by: number, speed: number): void;
  /** This browser was showing one and now simulates the town (or is alone): they carry on from where they stand. */
  takeOver(wid: number, x: number, z: number, h: number, down: boolean, health: number): void;
}

/** One of the host's people, as known here. */
interface Shown {
  wid: number;
  /** The last record, and when it came (this browser's clock, ms). */
  x: number; z: number; h: number; speed: number; flags: number; at: number;
  /** Whose body they are drawn in: one of this browser's own cast, or null when it has none to spare. */
  w: Walker | null;
  /** Where they are drawn. */
  cx: number; cz: number;
  seq: number;
  /** A first guess at a fall (this browser's car, fist or bullet): until when, and the slide. */
  guess: number; gvx: number; gvz: number;
  hitAt: number;
}

interface Sent { rec: PedRec; at: number; seq: number }

export class TownPeople {
  /** local: a private crowd (alone, the backup, or a host that sends none). host: simulating for the town. guest: showing the host's. */
  mode: 'local' | 'host' | 'guest' = 'local';
  readonly stats = {
    framesSent: 0, bytesSent: 0, wholeSent: 0, recsSent: 0, framesGot: 0, bytesGot: 0, takeovers: 0, adopted: 0, carried: 0,
    knocksSent: 0, hurtsSent: 0, bangsSent: 0, askBytesSent: 0, knocksGot: 0, knocksDone: 0, hurtsGot: 0, hurtsDone: 0, bangsGot: 0, bangsDone: 0,
  };

  private readonly peds: Peds | null;
  // Host.
  private sendAt = 0;
  private wholeAt = 0;
  private force = true;
  private sendSeq = 0;
  private readonly sent = new Map<number, Sent>();
  private readonly recs: PedRec[] = [];
  private readonly scratch = blankPed();
  private readonly out = new Uint8Array(PEOPLE_HEADER_BYTES + PEOPLE_MAX * PED_BYTES);
  // Guest.
  private readonly shown = new Map<number, Shown>();
  private readonly byBody = new Map<Person, Shown>();
  private readonly free: Walker[] = [];
  private readonly inFrame: PeopleFrame = { whole: false, n: 0, recs: [] };
  private seq = 0;
  private gotAt = 0;
  private from = 0;
  private shareAt = 0;
  /** This browser was the host a moment ago and its walkers still carry the town's numbers. */
  private carry = false;
  private bang: { x: number; z: number; r: number } | null = null;
  private bangAt = 0;
  /** How fast this browser's game is running against the clock on the wall (1 = full speed; less when frames are slow). */
  private rate = 1;
  private lastNow = 0;
  /** The police's officers (police.ts). */
  police: PeopleOwner | null = null;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic) {
    const amb = game.systems.find((s): s is Ambient => s instanceof Ambient);
    const peds = this.peds = amb ? amb.peds : null;
    if (!peds) return;
    peds.onAlarm = (x, z, r) => {
      // The loudest of what has happened since the last report.
      if (!this.bang || r > this.bang.r) this.bang = { x, z, r };
    };
    peds.onHurt = (p, dmg, dx, dz, fist, shove) => this.hurt(p, dmg, dx, dz, fist, shove);
  }

  /** Somebody has just arrived and knows nothing: the next frame is a whole one. */
  refresh(): void { this.force = true; }

  // ── Who simulates ──────────────────────────────────────────────────────────

  private sync(now: number): void {
    const sm = this.shared.mode;
    if (sm === 'host') {
      if (this.mode !== 'host') this.becomeHost();
    } else if (sm === 'guest') {
      // No longer the host, still in town: carry on walking them here until the new host is heard from.
      if (this.mode === 'host') { this.mode = 'local'; this.carry = true; this.sent.clear(); }
      else if (this.mode === 'guest' && (now - this.gotAt > STALE_MS || this.from !== this.conn.host && now - this.gotAt > 1500)) this.toLocal();
    } else {
      if (this.mode === 'guest') this.toLocal();
      else if (this.mode === 'host') { this.mode = 'local'; this.sent.clear(); }
      this.carry = false;
    }
  }

  private becomeHost(): void {
    const peds = this.peds as Peds;
    if (this.mode === 'guest') this.takeOver();
    peds.number((wid) => townLook(this.game, wid));
    this.mode = 'host';
    this.carry = false;
    this.force = true; this.sendAt = 0;
    this.sent.clear();
  }

  /** From showing the host's people to walking them here, each from where they stand. */
  private takeOver(): void {
    const peds = this.peds as Peds;
    peds.resume();
    peds.unnumber();
    for (const s of this.shown.values()) {
      const w = s.w, pose = s.flags & 7;
      if (s.wid >= OFFICER_WID0) {
        // Not one of the crowd: the body goes back to the cast, and the police stand an officer of their own there.
        if (w) w.p.visible = false;
        this.police?.takeOver(s.wid, s.cx, s.cz, s.h, pose === POSE_DOWN, ((s.flags >> PED_HEALTH_SHIFT) & 7) * 100 / 7);
        continue;
      }
      if (!w) continue;
      peds.takeOver(w, s.wid, pose === POSE_DOWN || s.guess > 0, (s.flags & PedFlag.Hard) !== 0, pose === POSE_RUN);
      this.stats.adopted++;
    }
    for (const w of this.free) w.p.visible = false;
    this.shown.clear(); this.byBody.clear(); this.free.length = 0;
    this.bang = null;
    this.stats.takeovers++;
  }

  private toLocal(): void {
    if (this.mode === 'guest') { this.takeOver(); this.carry = true; }
    this.mode = 'local';
  }

  private toGuest(now: number): void {
    const peds = this.peds as Peds, free = this.free;
    free.length = 0;
    const kept: Walker[] = [];
    peds.lend(this.carry ? (w) => { if (w.wid) kept.push(w); } : null);
    for (const w of peds.walkers) {
      if (kept.indexOf(w) >= 0) continue;
      w.p.visible = false;
      free.push(w);
    }
    // A host that has handed over: its people stay where they stand, under the same numbers.
    for (const w of kept) {
      const p = w.p, pose = Math.max(0, (PED_POSES as readonly string[]).indexOf(p.pose));
      const s: Shown = { wid: w.wid, x: p.x, z: p.z, h: p.h, speed: 0, flags: pose | (pedHealthBits(p.health) << PED_HEALTH_SHIFT), at: now, w, cx: p.x, cz: p.z, seq: 0, guess: 0, gvx: 0, gvz: 0, hitAt: 0 };
      this.shown.set(s.wid, s);
      this.byBody.set(p, s);
      this.stats.carried++;
    }
    this.carry = false;
    this.sent.clear();
    this.mode = 'guest';
  }

  // ── Host: the frames ───────────────────────────────────────────────────────

  private far2(x: number, z: number): number {
    const pl = this.game.player;
    let dx = x - pl.x, dz = z - pl.z, d2 = dx * dx + dz * dz;
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      dx = x - r.x; dz = z - r.z;
      d2 = Math.min(d2, dx * dx + dz * dz);
    }
    return d2;
  }

  private send(now: number): void {
    const peds = this.peds as Peds, sent = this.sent, recs = this.recs, r = this.scratch, seq = ++this.sendSeq;
    const whole = this.force || now - this.wholeAt >= PEOPLE_WHOLE_MS;
    let n = 0;
    const one = (wid: number, p: Person, vx: number, vz: number, hard: boolean): void => {
      if (n >= PEOPLE_MAX || this.far2(p.x, p.z) > SEND_FAR * SEND_FAR) return;
      const pose = Math.max(0, (PED_POSES as readonly string[]).indexOf(p.pose));
      const vel = Math.hypot(vx, vz);
      // Lying in the road they slide; on their feet the stride is what the body shows.
      const sp = pose === POSE_DOWN ? vel : pose === 0 || pose === POSE_SIT ? 0 : p.speed;
      r.id = wid; r.x = p.x; r.z = p.z;
      // A slow host's people cover less ground a second than their stride says: what is sent is what the clock on the wall will show.
      r.speed = sp < 0.15 ? 0 : sp * this.rate;
      r.h = r.speed > 0 && vel > 0.3 ? Math.atan2(vx, vz) : p.h;
      r.flags = pose | (p.bench ? PedFlag.Bench : 0) | (hard ? PedFlag.Hard : 0) | (pedHealthBits(p.health) << PED_HEALTH_SHIFT);
      quantPed(r);
      let s = sent.get(r.id), go = whole || !s;
      if (s && !go) {
        const b = s.rec, age = Math.min((now - s.at) / 1000, EXTRAP_S);
        const ex = b.x + Math.sin(b.h) * b.speed * age, ez = b.z + Math.cos(b.h) * b.speed * age;
        const turn = Math.abs(angleDiff(b.h, r.h));
        go = b.flags !== r.flags || Math.hypot(ex - r.x, ez - r.z) > DEVIATE || (b.speed === 0) !== (r.speed === 0)
          || Math.abs(b.speed - r.speed) > 0.7 || turn > (r.speed > 0 ? 0.5 : 0.2);
      }
      if (!s) sent.set(r.id, s = { rec: blankPed(), at: now, seq });
      s.seq = seq;
      if (go) {
        Object.assign(s.rec, r); s.at = now;
        Object.assign(recs[n] ?? (recs[n] = blankPed()), r);
        n++;
      }
    };
    for (const w of peds.walkers) if (w.active && w.wid) one(w.wid, w.p, w.vx, w.vz, w.hard);
    // The officers: they go the way they face.
    this.police?.each((wid, p, hard) => one(wid, p, Math.sin(p.h) * p.speed, Math.cos(p.h) * p.speed, hard));
    // Gone from the street: said once (a whole frame says it by leaving them out).
    for (const [id, s] of sent) {
      if (s.seq === seq) continue;
      sent.delete(id);
      if (whole || n >= PEOPLE_MAX) continue;
      const g = recs[n] ?? (recs[n] = blankPed());
      g.id = id; g.x = s.rec.x; g.z = s.rec.z; g.h = 0; g.speed = 0; g.flags = PED_GONE;
      n++;
    }
    if (n === 0 && !whole) return;
    const len = encodePeople(whole, recs, n, this.out);
    if (this.conn.send(this.out.subarray(0, len))) {
      this.stats.framesSent++; this.stats.bytesSent += len; this.stats.recsSent += n;
      if (whole) { this.force = false; this.wholeAt = now; this.stats.wholeSent++; }
    } else if (!whole) this.force = true;
  }

  /** Host: a ToHost frame about people. Returns whether it was one. */
  toHost(buf: ArrayBuffer): boolean {
    if (buf.byteLength < PED_ASK_BYTES) return false;
    const what = new Uint8Array(buf, 2, 1)[0];
    if (what !== ToHostKind.PedKnock && what !== ToHostKind.PedHurt && what !== ToHostKind.Bang) return false;
    const peds = this.peds;
    if (this.mode !== 'host' || !peds) return true;
    const r = this.remotes.get(frameSender(buf));
    if (!r || !r.seen) return true;
    if (what === ToHostKind.PedKnock) {
      const k = decodePedKnock(buf);
      if (!k) return true;
      this.stats.knocksGot++;
      if (k.ped >= OFFICER_WID0) { if (r.vehicle && Math.hypot(k.vx, k.vz) <= 80) this.police?.struck(k.ped, r.id, Math.hypot(k.vx, k.vz)); return true; }
      const w = peds.byWid(k.ped);
      // Somebody near the person, in a car, at a speed a car can do.
      if (!w || !r.vehicle || Math.hypot(w.p.x - r.x, w.p.z - r.z) > 30 || Math.hypot(k.vx, k.vz) > 80) return true;
      if (peds.struck(k.ped, k.vx, k.vz)) this.stats.knocksDone++;
    } else if (what === ToHostKind.PedHurt) {
      const k = decodePedHurt(buf);
      if (!k) return true;
      this.stats.hurtsGot++;
      if (k.ped >= OFFICER_WID0) { this.police?.hurt(k.ped, r.id, k.damage, Math.sin(k.h), Math.cos(k.h), k.fist, k.shove); return true; }
      const w = peds.byWid(k.ped);
      if (!w || Math.hypot(w.p.x - r.x, w.p.z - r.z) > (k.fist ? 8 : 200)) return true;
      this.game.player.weapons.hurtPerson(w.p, k.damage, Math.sin(k.h), Math.cos(k.h), k.fist, k.shove);
      this.stats.hurtsDone++;
    } else {
      const k = decodeBang(buf);
      if (!k) return true;
      this.stats.bangsGot++;
      if (Math.hypot(k.x - r.x, k.z - r.z) > 120 || k.r > 60) return true;
      peds.alarm(k.x, k.z, k.r);
      this.stats.bangsDone++;
    }
    return true;
  }

  // ── Guest: the host's people ───────────────────────────────────────────────

  /** A World frame of people. now: this browser's clock, ms. */
  frame(buf: ArrayBuffer, now: number): void {
    const from = frameSender(buf);
    if (!this.peds || this.shared.mode !== 'guest' || from !== this.conn.host) return;
    const f = this.inFrame;
    if (!decodePeople(buf, f)) return;
    this.stats.framesGot++; this.stats.bytesGot += buf.byteLength;
    if (this.mode !== 'guest') this.toGuest(now);
    this.gotAt = now; this.from = from;
    const seq = ++this.seq;
    for (let i = 0; i < f.n; i++) {
      const r = f.recs[i];
      if (r.id === 0) continue;
      let s = this.shown.get(r.id);
      if ((r.flags & 7) === PED_GONE) { if (s) this.unshow(s); continue; }
      if (!s) {
        s = { wid: r.id, x: r.x, z: r.z, h: r.h, speed: 0, flags: 0, at: now, w: null, cx: r.x, cz: r.z, seq, guess: 0, gvx: 0, gvz: 0, hitAt: 0 };
        this.shown.set(r.id, s);
        this.bind(s);
      }
      s.x = r.x; s.z = r.z; s.h = r.h; s.speed = r.speed; s.flags = r.flags; s.at = now; s.seq = seq;
    }
    if (f.whole) for (const s of this.shown.values()) if (s.seq !== seq) this.unshow(s);
  }

  /** Give a shown person one of this browser's bodies, if there is one to spare. */
  private bind(s: Shown): void {
    const w = this.free.pop();
    if (!w) return;
    const p = w.p, look = townLook(this.game, s.wid);
    s.w = w;
    if (p.look !== look) p.look = look;
    p.x = s.cx; p.z = s.cz; p.y = groundAt(p.x, p.z); p.h = s.h; p.speed = 0; p.pose = 'stand'; p.bench = false;
    p.visible = true;
    this.byBody.set(p, s);
  }

  private unbind(s: Shown): void {
    const w = s.w;
    if (!w) return;
    w.p.visible = false; w.p.bench = false;
    this.byBody.delete(w.p);
    this.free.push(w);
    s.w = null;
  }

  private unshow(s: Shown): void {
    this.unbind(s);
    this.shown.delete(s.wid);
  }

  /** More people in town than this browser has bodies: the nearest are the ones drawn. */
  private share(): void {
    const pl = this.game.player;
    let near: Shown | null = null, nd = Infinity, far: Shown | null = null, fd = -1;
    for (const s of this.shown.values()) {
      const d2 = (s.cx - pl.x) * (s.cx - pl.x) + (s.cz - pl.z) * (s.cz - pl.z);
      if (s.w) { if (d2 > fd) { fd = d2; far = s; } } else if (d2 < nd) { nd = d2; near = s; }
    }
    if (!near) return;
    if (this.free.length === 0 && far && Math.sqrt(fd) > Math.sqrt(nd) + 10) this.unbind(far);
    this.bind(near);
  }

  /** Guest: this player has punched or shot one of the shown people. The host decides; this is the first guess. */
  private hurt(p: Person, dmg: number, dx: number, dz: number, fist: boolean, shove: number): boolean {
    const s = this.byBody.get(p), out = p.health <= 0;
    if (!s || this.mode !== 'guest') return out;
    if (this.conn.send(encodePedHurt(s.wid, dmg, Math.atan2(dx, dz), fist, shove))) { this.stats.hurtsSent++; this.stats.askBytesSent += PED_ASK_BYTES; }
    // (An officer stays on their feet until there is nothing left of them.)
    if (out || (s.wid < OFFICER_WID0 && (p.health <= 60 || fist))) {
      s.guess = performance.now() + GUESS_MS;
      s.gvx = dx * 2.2 * shove; s.gvz = dz * 2.2 * shove;
      p.pose = 'down'; p.speed = 0; p.h = Math.atan2(dx, dz);
    }
    return out;
  }

  private place(s: Shown, w: Walker, now: number, dt: number): void {
    const p = w.p, pose = s.flags & 7, age = Math.min((now - s.at) / 1000, EXTRAP_S);
    // A ragdoll (ent/ragdoll.ts) has the body until it lands; then the host's position is eased to as usual.
    const rags = this.game.people.rag;
    if (rags.flying(p)) { s.cx = p.x; s.cz = p.z; return; }
    if (pose === POSE_DOWN && p.pose !== 'down' && s.guess === 0 && s.speed > 2.5) {
      // Run down on the host's screen (the host flies its own ragdoll): the same knock here, from the car speed the slide implies.
      const k = s.speed / 0.85;
      if (rags.hitByCar(p, Math.sin(s.h) * k, Math.cos(s.h) * k, { silly: false })) { s.cx = p.x; s.cz = p.z; return; }
    }
    let tx = s.x + Math.sin(s.h) * s.speed * age, tz = s.z + Math.cos(s.h) * s.speed * age;
    if (s.guess > 0) {
      // Knocked down on this screen and not yet on the host's: lying where the blow left them.
      if (pose === POSE_DOWN || now > s.guess) s.guess = 0;
      else {
        const sp = Math.hypot(s.gvx, s.gvz);
        if (sp > 0.05) { const k = Math.max(0, sp - 7 * dt) / sp; s.gvx *= k; s.gvz *= k; s.cx += s.gvx * dt; s.cz += s.gvz * dt; }
        p.x = s.cx; p.z = s.cz; p.y = groundAt(p.x, p.z); p.pose = 'down'; p.speed = 0; p.bench = false;
        return;
      }
    }
    const ex = tx - s.cx, ez = tz - s.cz;
    if (ex * ex + ez * ez > SNAP * SNAP) { s.cx = tx; s.cz = tz; }
    else { const k = 1 - Math.exp(-EASE * dt); s.cx += ex * k; s.cz += ez * k; }
    tx = s.cx; tz = s.cz;
    const bench = (s.flags & PedFlag.Bench) !== 0;
    p.x = tx; p.z = tz; p.y = groundAt(tx, tz) + (bench ? 0.42 : 0);
    p.bench = bench;
    p.pose = PED_POSES[pose] ?? 'stand';
    p.speed = s.speed;
    p.h = pose === POSE_DOWN ? s.h : dampAngle(p.h, s.h, 9, dt);
    p.health = ((s.flags >> PED_HEALTH_SHIFT) & 7) * 100 / 7;
  }

  /** Guest: has this player's car just run into them? Shown here at once, and the host is told. */
  private carHit(s: Shown, w: Walker, now: number): void {
    const v = this.game.player.vehicle;
    if (!v || now < s.hitAt || kid.on) return;
    const sp = Math.hypot(v.vx, v.vz);
    if (sp <= KNOCK) return;
    const p = w.p, dx = p.x - v.x, dz = p.z - v.z;
    if (dx > 12 || dx < -12 || dz > 12 || dz < -12 || Math.abs(v.y - p.y) >= 1.5) return;
    const sh = Math.sin(v.h), ch = Math.cos(v.h);
    if (Math.abs(dx * sh + dz * ch) >= v.hl + 0.3 || Math.abs(-dx * ch + dz * sh) >= v.hw + 0.3) return;
    s.hitAt = now + 1200;
    if (this.conn.send(encodePedKnock(s.wid, v.vx, v.vz))) { this.stats.knocksSent++; this.stats.askBytesSent += PED_ASK_BYTES; }
    // An officer: the host decides whether that was hard enough to put them down, and what it costs.
    if (s.wid >= OFFICER_WID0) return;
    if ((s.flags & 7) !== POSE_DOWN) {
      s.guess = now + GUESS_MS;
      s.gvx = v.vx * 0.85; s.gvz = v.vz * 0.85;
      p.pose = 'down'; p.speed = 0; p.h = Math.atan2(v.vx, v.vz);
      this.game.people.rag.hitByCar(p, v.vx, v.vz, { by: 'player', silly: false, onDone: () => { s.gvx = s.gvz = 0; s.cx = p.x; s.cz = p.z; } });
    }
    this.game.emit('pedHit', { x: p.x, z: p.z, speed: sp, byPlayer: true });
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number, dt: number): void {
    if (!this.peds) return;
    const wall = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (wall > 0.001 && wall < 1 && dt > 0) this.rate += (Math.min(1, dt / wall) - this.rate) * 0.2;
    this.sync(now);
    if (this.mode === 'host') {
      if (now - this.sendAt >= SEND_MS - 4) { this.sendAt = now; this.send(now); }
    } else if (this.mode === 'guest') {
      for (const s of this.shown.values()) {
        const w = s.w;
        if (!w) {
          // Carried on unseen, so that if a body comes free they appear where they are.
          const age = Math.min((now - s.at) / 1000, EXTRAP_S);
          s.cx = s.x + Math.sin(s.h) * s.speed * age; s.cz = s.z + Math.cos(s.h) * s.speed * age;
          continue;
        }
        this.place(s, w, now, dt);
        this.carHit(s, w, now);
      }
      if (now - this.shareAt > 500) { this.shareAt = now; if (this.shown.size > (this.peds.walkers.length - this.free.length)) this.share(); }
      const b = this.bang;
      if (b && now - this.bangAt >= 1000 / BANG_HZ) {
        this.bang = null; this.bangAt = now;
        if (this.conn.send(encodeBang(b.x, b.z, Math.min(60, b.r)))) { this.stats.bangsSent++; this.stats.askBytesSent += PED_ASK_BYTES; }
      }
    } else this.bang = null;
  }

  /** Guest: every officer being shown, and the body they are drawn in (null when there is none to spare). */
  eachOfficer(fn: (wid: number, body: Person | null) => void): void {
    if (this.mode !== 'guest') return;
    for (const s of this.shown.values()) if (s.wid >= OFFICER_WID0) fn(s.wid, s.w ? s.w.p : null);
  }

  /** For the tests (window.__game.net().people). */
  info(): Record<string, unknown> {
    const r2 = (v: number): number => +v.toFixed(2), peds = this.peds;
    const people: Record<string, unknown>[] = [];
    const key = (l: Look): string => JSON.stringify(l);
    let unbodied = 0;
    if (this.mode === 'guest') {
      for (const s of this.shown.values()) {
        const w = s.w;
        // (The officers are the police's to list: net().police.officers.)
        if (s.wid >= OFFICER_WID0) continue;
        if (!w) { unbodied++; continue; }
        const p = w.p;
        people.push({ id: s.wid, x: r2(p.x), z: r2(p.z), h: r2(p.h), pose: p.pose, hard: (s.flags & PedFlag.Hard) !== 0, health: Math.round(p.health), guess: s.guess > 0, look: key(p.look) });
      }
    } else if (peds) {
      for (const w of peds.walkers) {
        if (!w.active) continue;
        const p = w.p;
        people.push({ id: w.wid, x: r2(p.x), z: r2(p.z), h: r2(p.h), pose: p.pose, hard: w.hard, health: Math.round(p.health), flee: r2(Math.max(0, w.flee)), look: key(p.look) });
      }
    }
    return { mode: this.mode, ...this.stats, rate: r2(this.rate), cast: peds ? peds.walkers.length : 0, unbodied, people };
  }
}
