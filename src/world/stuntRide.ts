// Waiver Park's two pieces of track the height map cannot describe, and the trick score (fun queue item 7).
//
// The loop and the wall ride: through vehicle.ts carHooks, the player's car is held to a path while it is on one.
// Speed along the path changes with gravity's share along it, the throttle and a little drag; the car stays on while
// the track can push on it (in the loop: v^2/r has to beat gravity's pull off the track, so about 45 mph at the foot
// is needed; on the wall: 10 m/s). Too slow and it comes off, keeping its velocity and its attitude, to fall as a car
// in the air does, usually onto its roof. A car that rolls back down the loop's first quarter leaves backwards.
//
// Tricks: in the air near the park, W/S flip the car (pitch), A/D roll it, and A/D with the handbrake spin it (the
// car's own yaw, so it lands facing wherever it ends up). The extra attitude is drawn through carHooks.pose about
// the middle of the body; the physics underneath is the ordinary car in the air. On landing it is scored: airtime,
// distance, each flip, roll and half-turn, times how many kinds of trick were in it, times the combo (clean landings
// in a row with under four seconds on the ground between), plus a quarter for landing on four wheels clean. Not
// clean (more than 35 degrees from upright) voids it, dents the car and spins it out. Big scores pay cash. The card
// is the HUD's paperwork style: "TRICK FILED: double barrel roll, 2.4 s air, x3".
//
// Stats (save counts): trickBest (points), trickAir (tenths of a second), loops. Scores are this player's own.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { carHooks } from '../ent/vehicle';
import { groundAt } from './plan';
import { save } from '../game/save';
import { LOOP, PAD, WALL } from './stuntPark';

/** The car's per-axle state (vehicle.ts keeps these public on the object; only this file reaches for them). */
type CarX = Vehicle & {
  yF: number; yR: number; vyF: number; vyR: number; gF: number; gR: number;
  onF: boolean; onR: boolean; lift: number; susp: number; groundRoll: number;
};

/** vehicle.ts's gravity (heavier than real, so jumps land sooner). */
const G = 13;
const TAU = Math.PI * 2;
/** Where a takeoff counts for the trick score: the park and its shore. */
const ZONE = { x0: 572, z0: 258, x1: 720, z1: 500 };
const PIVOT = 0.65;
const FEET = 3.28084;
const MPH = 2.23694;
const COUNT_WORD = ['', '', 'double ', 'triple ', 'quadruple ', 'quintuple '];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _t = new THREE.Vector3(), _u = new THREE.Vector3(), _l = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const ID = new THREE.Quaternion();

interface Ride {
  kind: 'loop' | 'wall';
  /** Path parameter: the loop's angle (0..2pi), or metres along the wall. */
  s: number;
  /** Speed along the path, m/s (negative rolling back). */
  v: number;
  /** Sideways offset kept from the entry (loop), or the x the car came in at (wall). */
  off: number;
  /** Where the car is and its frame, written each step for the pose. */
  pos: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3;
}

export class StuntRide {
  private ride: Ride | null = null;
  /** Extra attitude on top of the car's own, in its frame; and the spin rates the keys build up. */
  private readonly trick = new THREE.Quaternion();
  private wx = 0; wz = 0;
  /** This jump: airborne, from where, and how far round each way. */
  private air = false;
  private airT = 0; private ax = 0; private az = 0;
  private pitchA = 0; private rollA = 0; private yawA = 0;
  private counted = false;
  /** Settling the extra attitude back to none after a landing. */
  private settle = 0;
  private combo = 0; private groundT = 99;
  private card: HTMLElement | null = null;
  private cardT = 0;
  private lastCar: CarX | null = null;
  private loopsThis = 0;

  constructor(private readonly game: Game) {
    carHooks.step = (c, dt) => this.step(c as CarX, dt);
    carHooks.pose = (c, q, p, qw, pw) => this.pose(c as CarX, q, p, qw, pw);
  }

  // ── Track ──────────────────────────────────────────────────────────────────

  private loopAt(s: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(LOOP.x + LOOP.r * Math.sin(s), PAD + LOOP.r - LOOP.r * Math.cos(s), LOOP.z + LOOP.shift * s / TAU + off);
  }

  /** The wall ride's blend in and out (0 on the floor, 1 on the face), from metres along it. */
  private wallB(s: number): number {
    const a = Math.min(1, Math.max(0, s / 7)), b = Math.min(1, Math.max(0, (WALL.len - s) / 7));
    return a * a * (3 - 2 * a) * b * b * (3 - 2 * b);
  }
  private wallAt(s: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    const b = this.wallB(s), phi = b * Math.PI / 2, R = 1.2, xc = WALL.x - R;
    const x = xc + R * Math.sin(phi) + (off - xc) * (1 - b);
    const y = PAD + R - R * Math.cos(phi) + 2.6 * b * Math.sin(Math.PI * s / WALL.len);
    return out.set(x, y, WALL.z0 - s);
  }

  /** Fill r.pos, r.fwd, r.up for the ride's current s. */
  private frame(r: Ride): void {
    if (r.kind === 'loop') {
      this.loopAt(r.s, r.off, r.pos);
      r.fwd.set(Math.cos(r.s), Math.sin(r.s), LOOP.shift / (TAU * LOOP.r)).normalize();
      r.up.set(-Math.sin(r.s), Math.cos(r.s), 0);
    } else {
      this.wallAt(r.s, r.off, r.pos);
      this.wallAt(r.s + 0.1, r.off, _v);
      r.fwd.copy(_v).sub(r.pos).normalize();
      const phi = this.wallB(r.s) * Math.PI / 2;
      r.up.set(-Math.sin(phi), Math.cos(phi), 0);
    }
    r.up.addScaledVector(r.fwd, -r.up.dot(r.fwd)).normalize();
  }

  private step(c: CarX, dt: number): boolean {
    this.lastCar = c;
    const r = this.ride;
    if (r) return this.rideStep(c, r, dt);
    if (!c.onGround || c.sunk) { this.airStep(c, dt); return false; }
    const sh = Math.sin(c.h), ch = Math.cos(c.h), vf = c.vx * sh + c.vz * ch;
    // The loop's foot, heading east.
    if (Math.abs(c.x - LOOP.x) < 0.9 && Math.abs(c.z - LOOP.z) < 1.6 && sh > 0.8 && vf > 3) {
      this.start(c, 'loop', 0, vf, Math.max(-1.2, Math.min(1.2, c.z - LOOP.z)));
      return true;
    }
    // The wall: along the east fence heading north, near enough and quick enough.
    if (c.x > 655 && c.x < 659 && c.z < WALL.z0 + 1 && c.z > WALL.z0 - 4 && ch < -0.9 && vf > 12) {
      this.start(c, 'wall', WALL.z0 - c.z, vf, c.x);
      return true;
    }
    return false;
  }

  private start(c: CarX, kind: 'loop' | 'wall', s: number, v: number, off: number): void {
    const r: Ride = { kind, s, v, off, pos: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3() };
    this.ride = r;
    c.h = kind === 'loop' ? Math.PI / 2 : Math.PI;
    c.yawRate = 0;
    this.frame(r);
  }

  private rideStep(c: CarX, r: Ride, dt: number): boolean {
    const ctl = c.ctl, acc = c.driver ? (ctl.accel > 0 ? ctl.accel * 4.5 : ctl.accel * 7) : 0;
    r.v += (-G * r.fwd.y + acc - 0.003 * r.v * Math.abs(r.v)) * dt;
    if (r.kind === 'loop') {
      r.s += (r.v / LOOP.r) * dt;
      if (r.s <= 0) { this.leave(c, r, true); return true; }
      if (r.s >= TAU) { r.s = TAU; this.frame(r); this.leave(c, r, true); this.loopDone(c); return true; }
      // Pressed onto the track by what it takes to turn the car round, minus gravity pulling it off.
      const press = r.v * r.v / LOOP.r + G * Math.cos(r.s);
      this.frame(r);
      if (press < 0 && r.s > 0.3) { this.leave(c, r, false); return true; }
    } else {
      r.s += r.v * dt;
      if (r.s >= WALL.len || r.s < 0) { r.s = Math.min(WALL.len, Math.max(0, r.s)); this.frame(r); this.leave(c, r, true); if (r.s >= WALL.len) this.wallDone(); return true; }
      this.frame(r);
      if (r.v < 10 && this.wallB(r.s) > 0.6) { this.leave(c, r, false); return true; }
    }
    // Write the car where the track says, moving along it.
    c.x = r.pos.x; c.y = r.pos.y; c.z = r.pos.z;
    c.vx = r.fwd.x * r.v; c.vy = r.fwd.y * r.v; c.vz = r.fwd.z * r.v;
    c.yF = c.yR = c.y; c.vyF = c.vyR = c.vy; c.gF = c.gR = c.y;
    c.onF = c.onR = true; c.onGround = true; c.airTime = 0;
    c.pitch = 0; c.roll = 0; c.groundRoll = 0; c.lift = 0; c.slip = 0; c.yawRate = 0;
    return true;
  }

  /**
   * Off the track: at the end (on the floor again, rolling on) or because it was too slow (in the air, keeping its
   * attitude as the extra trick turn, so the fall looks like what it is).
   */
  private leave(c: CarX, r: Ride, onFloor: boolean): void {
    this.ride = null;
    const v = r.v;
    if (onFloor && (r.kind === 'wall' || r.s <= 0 || r.s >= TAU)) {
      const back = v < 0;
      c.x = r.pos.x; c.z = r.pos.z;
      const g = groundAt(c.x, c.z);
      c.y = c.yF = c.yR = c.gF = c.gR = g;
      c.vyF = c.vyR = c.vy = 0;
      _v.set(r.fwd.x, 0, r.fwd.z).normalize();
      c.vx = _v.x * v; c.vz = _v.z * v;
      if (!back) c.h = Math.atan2(_v.x, _v.z);
      c.onF = c.onR = c.onGround = true; c.airTime = 0;
      this.trick.identity();
      return;
    }
    // Falling off: ballistic from here, the car's frame kept as the extra attitude.
    c.x = r.pos.x; c.y = r.pos.y; c.z = r.pos.z;
    c.vx = r.fwd.x * v - r.up.x * 1.5; c.vz = r.fwd.z * v - r.up.z * 1.5;
    c.vy = c.vyF = c.vyR = r.fwd.y * v - r.up.y * 1.5;
    c.yF = c.yR = c.y;
    c.onF = c.onR = c.onGround = false; c.airTime = 0.01; c.pitch = 0; c.groundRoll = 0;
    this.rideQuat(c, r, _q);
    _e.set(0, c.h, 0); _q2.setFromEuler(_e).invert();
    this.trick.copy(_q2.multiply(_q));
    this.beginAir(c);
    this.counted = false;
    this.hud(r.kind === 'loop' ? 'OFF THE LOOP' : 'OFF THE WALL', r.kind === 'loop' ? 'insufficient speed, sufficient altitude' : 'payment missed', '', 2.5);
  }

  private rideQuat(c: CarX, r: Ride, out: THREE.Quaternion): THREE.Quaternion {
    // The model faces +z with +x on its left: columns left, up, forward.
    _l.crossVectors(r.up, r.fwd).normalize();
    _m.makeBasis(_l, r.up, r.fwd);
    void c;
    return out.setFromRotationMatrix(_m);
  }

  // ── Air ────────────────────────────────────────────────────────────────────

  private beginAir(c: CarX): void {
    this.air = true; this.airT = 0; this.ax = c.x; this.az = c.z;
    this.pitchA = 0; this.rollA = 0; this.yawA = 0; this.wx = 0; this.wz = 0;
    this.counted = c.x > ZONE.x0 && c.x < ZONE.x1 && c.z > ZONE.z0 && c.z < ZONE.z1;
    // A key already held at the lip (the throttle, the steering) is not a trick until it has been let go once.
    this.armP = c.ctl.accel === 0; this.armS = c.ctl.steer === 0 && !c.ctl.handbrake;
  }
  private armP = false; private armS = false;

  private airStep(c: CarX, dt: number): void {
    if (!this.air) { if (c.sunk) return; this.beginAir(c); }
    if (c.sunk) return;
    this.airT += dt;
    if (!this.counted) return;
    const c0 = c.ctl;
    if (c0.accel === 0) this.armP = true;
    if (c0.steer === 0 && !c0.handbrake) this.armS = true;
    const ctl = { accel: this.armP ? c0.accel : 0, steer: this.armS ? c0.steer : 0, handbrake: this.armS && c0.handbrake };
    const K = 10, MAX = 7.5;
    if (ctl.handbrake) {
      c.yawRate = Math.max(-MAX, Math.min(MAX, c.yawRate - ctl.steer * K * dt));
      this.wx *= Math.exp(-1.5 * dt); this.wz *= Math.exp(-1.5 * dt);
    } else {
      this.wx = Math.max(-MAX, Math.min(MAX, this.wx + ctl.accel * K * dt));
      this.wz = Math.max(-MAX, Math.min(MAX, this.wz + ctl.steer * K * dt));
      if (ctl.accel === 0) this.wx *= Math.exp(-3 * dt);
      if (ctl.steer === 0) this.wz *= Math.exp(-3 * dt);
    }
    // Hands off and nearly upright: the car finds its wheels (whole turns are all upright to a quaternion).
    if (ctl.accel === 0 && ctl.steer === 0 && Math.abs(this.trick.w) > Math.cos(0.35)) this.trick.slerp(ID, Math.min(1, dt * 3));
    this.pitchA += this.wx * dt; this.rollA += this.wz * dt; this.yawA += c.yawRate * dt;
    _e.set(this.wx * dt, 0, this.wz * dt, 'XYZ');
    _q.setFromEuler(_e);
    this.trick.multiply(_q).normalize();
    _e.order = 'YXZ';
  }

  /** Called every frame: notice landings and splashdowns, and keep the live card up while airborne. */
  update(dt: number): void {
    const p = this.game.player, c = (p.vehicle ?? null) as CarX | null;
    if (this.cardT > 0) { this.cardT -= dt; if (this.cardT <= 0 && this.card) this.card.classList.remove('on'); }
    if (this.settle > 0) {
      this.settle = Math.max(0, this.settle - dt);
      this.trick.slerp(ID, Math.min(1, dt * 9));
      if (this.settle === 0) this.trick.identity();
    }
    if (!c || c !== this.lastCar) {
      if (this.ride && this.lastCar) this.ride = null;
      if (!c) { this.air = false; this.trick.identity(); }
      this.lastCar = c;
      return;
    }
    if (this.ride) return;
    if (this.air) {
      if (c.sunk) { this.land(c, true); return; }
      if (c.onGround) { this.land(c, false); return; }
      if (this.counted && this.airT > 0.45) this.live();
    } else {
      this.groundT += dt;
      if (this.groundT > 4 && this.combo > 0) this.combo = 0;
    }
  }

  private names(): { list: string[]; kinds: number; pts: number } {
    const list: string[] = [];
    let kinds = 0, pts = 0;
    const flips = Math.floor((Math.abs(this.pitchA) + 0.8) / TAU);
    const rolls = Math.floor((Math.abs(this.rollA) + 0.8) / TAU);
    const halves = Math.floor((Math.abs(this.yawA) + 0.5) / Math.PI);
    if (flips > 0) { kinds++; pts += 600 * flips; list.push((COUNT_WORD[flips] ?? `${flips}x `) + (this.pitchA > 0 ? 'front flip' : 'backflip')); }
    if (rolls > 0) { kinds++; pts += 450 * rolls; list.push((COUNT_WORD[rolls] ?? `${rolls}x `) + 'barrel roll'); }
    if (halves > 0) { kinds++; pts += 150 * halves; list.push(`${halves * 180} spin`); }
    return { list, kinds, pts };
  }

  private live(): void {
    const n = this.names();
    const part = (a: number): string => { const f = (Math.abs(a) % TAU) / TAU; const k = Math.round(f * 4); return k > 0 && k < 4 ? `${k}/4` : ''; };
    const extra = [part(this.pitchA) && `${part(this.pitchA)} flip`, part(this.rollA) && `${part(this.rollA)} roll`].filter(Boolean).join(' · ');
    this.hud('AIRBORNE', `${this.airT.toFixed(1)} s${n.list.length ? ' · ' + n.list.join(' + ') : ''}`, (extra ? extra + ' · ' : '') + (this.combo > 0 ? `combo x${this.combo + 1}` : 'W/S flip · A/D roll · SPACE+A/D spin'), 0.3, true);
  }

  private land(c: CarX, splash: boolean): void {
    this.air = false;
    this.groundT = 0;
    const t = this.airT;
    if (!this.counted || (t < 0.5 && Math.abs(this.pitchA) < 3 && Math.abs(this.rollA) < 3 && Math.abs(this.yawA) < 2.5)) { this.settle = 0.4; return; }
    _u.set(0, 1, 0).applyQuaternion(this.trick);
    const clean = !splash && _u.y > Math.cos(0.61);
    const dist = Math.hypot(c.x - this.ax, c.z - this.az);
    const n = this.names();
    this.settle = clean ? 0.2 : 0.5;
    if (!clean && !splash) {
      // Roof, side or nose: void, a dent, and the spin that comes with it.
      this.combo = 0;
      c.health = Math.max(5, c.health - 12);
      c.yawRate += (Math.random() < 0.5 ? -1 : 1) * 4;
      c.vx *= 0.55; c.vz *= 0.55;
      const what = _u.y < -0.3 ? 'landed on the roof' : _u.y < 0.5 ? 'landed on its side' : 'landed on two wheels and a prayer';
      this.hud('TRICK VOID', `${n.list.length ? n.list.join(' + ') + ', ' : ''}${t.toFixed(1)} s air`, `${what} · no points awarded`, 4);
      return;
    }
    const mult = Math.max(1, n.kinds) + this.combo;
    const base = 150 * t + 3 * dist + n.pts;
    const total = Math.round(base * mult * (clean ? 1.25 : 1) / 10) * 10;
    const cash = total >= 500 ? Math.min(1000, Math.floor(total / 50)) : 0;
    if (cash > 0) this.game.player.money += cash;
    const best = total > save.count('trickBest');
    if (best) save.data.counts.trickBest = total;
    if (Math.round(t * 10) > save.count('trickAir')) save.data.counts.trickAir = Math.round(t * 10);
    const name = n.list.length ? n.list.join(' + ') : 'straight air';
    const title = splash ? 'SPLASHDOWN FILED' : 'TRICK FILED';
    const sub = `${name}, ${t.toFixed(1)} s air, ${Math.round(dist * FEET)} ft, x${mult}`;
    const foot = `${total.toLocaleString('en-US')} pts${clean ? ' · clean landing +25%' : ' · the Sound accepts no landing bonus'}${cash ? ` · $${cash}` : ''}${best ? ' · NEW BEST' : ''}`;
    this.hud(title, sub, foot, 4.5);
    if (clean && n.kinds > 0) this.combo = Math.min(7, this.combo + 1);
  }

  private loopDone(c: CarX): void {
    const n = save.bump('loops');
    this.loopsThis++;
    const mult = 1 + this.combo;
    const total = 1000 * mult;
    this.game.player.money += 20;
    if (total > save.count('trickBest')) save.data.counts.trickBest = total;
    this.hud('LOOP FILED', `1 loop, ${Math.round(Math.abs(c.vx) * MPH)} mph out, x${mult}`, `${total.toLocaleString('en-US')} pts · $20 · loops on file: ${n}`, 4);
    this.combo = Math.min(7, this.combo + 1); this.groundT = 0;
  }

  private wallDone(): void {
    const mult = 1 + this.combo, total = 800 * mult;
    this.game.player.money += 15;
    if (total > save.count('trickBest')) save.data.counts.trickBest = total;
    this.hud('WALL RIDE FILED', `${Math.round(WALL.len * FEET)} ft on the Wall of Debt, x${mult}`, `${total.toLocaleString('en-US')} pts · $15 · payments current`, 4);
    this.combo = Math.min(7, this.combo + 1); this.groundT = 0;
  }

  // ── Pose ───────────────────────────────────────────────────────────────────

  private pose(c: CarX, q: THREE.Quaternion, p: THREE.Vector3, qw: THREE.Quaternion, pw: THREE.Vector3): void {
    const r = this.ride;
    if (r) {
      this.rideQuat(c, r, q);
      qw.copy(q);
      p.copy(r.pos).addScaledVector(r.up, -c.susp);
      pw.copy(r.pos);
      return;
    }
    if (this.trick.w > 0.99999 || this.trick.w < -0.99999) return;
    // Turn about a point in the middle of the body, not its feet.
    for (const [qq, pp] of [[q, p], [qw, pw]] as const) {
      _w.set(0, PIVOT, 0).applyQuaternion(qq).add(pp);
      qq.multiply(this.trick);
      _t.set(0, PIVOT, 0).applyQuaternion(qq);
      pp.copy(_w).sub(_t);
    }
  }

  // ── Card ───────────────────────────────────────────────────────────────────

  private hud(kicker: string, line: string, foot: string, secs: number, live = false): void {
    if (!this.card) {
      const root = document.getElementById('hud') ?? document.body;
      const st = document.createElement('style');
      st.textContent = `
.sp-card{position:absolute;left:50%;top:15%;transform:translateX(-50%) rotate(-1.2deg) scale(.96);opacity:0;pointer-events:none;
  background:var(--bone,#f2e8cf);color:var(--ink,#14213d);border:3px solid var(--ink,#14213d);box-shadow:4px 4px 0 var(--ink,#14213d);
  padding:.45em .9em .5em;min-width:min(22em,80vw);max-width:92vw;text-align:center;transition:opacity .15s,transform .15s;z-index:5}
.sp-card.on{opacity:1;transform:translateX(-50%) rotate(-1.2deg) scale(1)}
.sp-card.live{transform:translateX(-50%) rotate(0deg) scale(.9)}
.sp-k{font:600 clamp(9px,1.1vw,12px) var(--f-mono,monospace);letter-spacing:.12em;border-bottom:2px solid var(--vermilion,#e4572e);padding-bottom:.2em;display:flex;justify-content:space-between;gap:1em}
.sp-t{font:800 clamp(20px,3.6vw,46px)/1.05 var(--f-head,'Arial Narrow',sans-serif);color:var(--vermilion,#e4572e);text-transform:uppercase;margin-top:.12em}
.sp-d{font:600 clamp(13px,1.8vw,22px)/1.2 var(--f-text,sans-serif)}
.sp-s{font:500 clamp(10px,1.2vw,14px) var(--f-mono,monospace);margin-top:.2em;opacity:.85;text-transform:uppercase}`;
      document.head.appendChild(st);
      const el = document.createElement('div');
      el.className = 'sp-card';
      el.innerHTML = '<div class="sp-k"><span>FORM T-7 · TRICK REPORT</span><span>WAIVER PARK</span></div><div class="sp-t"></div><div class="sp-d"></div><div class="sp-s"></div>';
      root.appendChild(el);
      this.card = el;
    }
    const el = this.card;
    (el.children[1] as HTMLElement).textContent = kicker;
    (el.children[2] as HTMLElement).textContent = line;
    (el.children[3] as HTMLElement).textContent = foot;
    el.classList.toggle('live', live);
    el.classList.add('on');
    this.cardT = Math.max(live ? 0 : this.cardT, secs);
  }

  /** For tests: the ride in progress, if any, and this jump's numbers. */
  info(): Record<string, unknown> {
    return { ride: this.ride ? { kind: this.ride.kind, s: +this.ride.s.toFixed(2), v: +this.ride.v.toFixed(1) } : null,
      air: this.air, airT: +this.airT.toFixed(2), pitchA: +this.pitchA.toFixed(2), rollA: +this.rollA.toFixed(2), yawA: +this.yawA.toFixed(2), combo: this.combo, loops: this.loopsThis };
  }
}
