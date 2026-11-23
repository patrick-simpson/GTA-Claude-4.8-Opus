// Ragdolls: what happens to a person a car has just met.
//
// Owner, Nov 23: "ragdoll physics when you get hit by a car, make it funny if possible."
//
// The body is one rigid trunk (mass, a real inertia tensor, a quaternion, angular velocity) with
// limbs hung off it in joint space: every limb channel the animation code already has (arm swing,
// abduct, elbow; leg swing, abduct, knee, ankle; spine and head) is a damped spring with hard limits,
// so a knee only bends backwards and an elbow only one way, whatever the flight does. Hands, knees,
// feet, head, shoulders, chest and pelvis are contact spheres placed from those channels; each one
// that meets the ground (a plane fitted under the body, so slopes tip it) gets a proper impulse with
// restitution and friction, which is what makes a landing bounce, roll and scrub to a stop. Walls
// (the city's boxes) bounce the trunk back with a kick of spin; water floats it.
//
// While it flies the limbs chase a flail (windmilling arms, pedalling legs); once down they chase a
// limp sprawl, and impacts knock them about. When it has come to rest the trunk is eased onto its
// back or front into exactly the frame of the 'down' pose, and the body is handed back to the
// animation code, which blends from the ragdoll's limbs to its own and gets them up from there.
//
// Cheap: at most a handful at once and only near the camera (the rest keep the old canned fall),
// fixed 1/60 s steps, and update() returns before doing anything when nobody is in the air.
// Nothing here owns a GPU buffer: the bones go through the crowd texture character.ts already sends.
//
// Funny, in the house deadpan: floaty exaggerated flights, a cartoon spin, flailing, the
// occasional absurd outcome (sat on a bench, filed in a bin, bounced off the giant duck), a dust-off
// after getting up (character.ts), the odd pun toast, and numbers for the menu's incident form.

import * as THREE from 'three';
import type { Person } from '../core/api';
import type { Game } from '../core/game';
import { clamp, hash2, pickRand } from '../core/util';
import { groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { CH, HIP, NCH, ragAttach, ragDetach, ragPose } from './character';

const STEP = 1 / 60;
/** A little floatier than the real thing: the flight should be readable, and long enough to enjoy. */
const GRAV = 9.81 * 0.8;
const MASS = 70;
const INV_M = 1 / MASS;
/** Inverse inertia in the body frame: X (left) is the somersault axis, Y the spine, Z front to back. Light, for a lively spin. */
const IB = [1 / 7.5, 1 / 1.6, 1 / 7];
/** The centre of mass sits this far up the spine from the pelvis joint. */
const COM_Y = 0.14;
/** Half the body's thickness: lying, the pelvis rests this high (the 'down' pose's own number). */
const LIE = 0.115;
const THIGH = 0.42, SHIN = 0.4, ARM = 0.5;
const REST_SPEED = 0.5, REST_SPIN = 1.2;
/** Duck in the harbour (world/landmarks.ts). */
const DUCK_X = 0, DUCK_Z = 689, DUCK_R = 10, DUCK_TOP = 8.5;

const {
  LEAN, TWIST, SROLL, HYAW, HPITCH, HROLL, ASW, AAB, AEL, LSW, LAB, LKN, LFT,
} = CH;

/** Joint limits: [channel, low, high]. Elbows and knees one way only, nothing past what a body does. */
const LIMITS: [number, number, number][] = [
  [LEAN, -0.45, 0.8], [TWIST, -0.6, 0.6], [SROLL, -0.4, 0.4],
  [HYAW, -1.1, 1.1], [HPITCH, -0.6, 0.7], [HROLL, -0.5, 0.5],
];
for (const k of [0, 3]) LIMITS.push([ASW + k, -0.9, 3.1], [AAB + k, -0.15, 2.6], [AEL + k, 0, 2.2]);
for (const k of [0, 4]) LIMITS.push([LSW + k, -0.55, 1.9], [LAB + k, -0.1, 0.85], [LKN + k, 0, 2.2], [LFT + k, -0.5, 0.8]);

export type RagLanding = 'ground' | 'water' | 'bench' | 'bin' | 'duck';

export interface RagResult {
  /** Feet position and heading, as the 'down' pose (or the bench) wants them. */
  x: number; y: number; z: number; h: number;
  /** +1 face down, -1 face up. */
  face: number;
  landed: RagLanding;
  /** Sat on a bench or climbed out of a bin: already upright, get on with the day. */
  up: boolean;
  /** Horizontal distance from launch, m. */
  dist: number;
}

export interface RagOpts {
  /** Who did it: 'player' counts for the stats and the toasts. */
  by?: 'player' | 'other';
  /** Called once, when the body is handed back. */
  onDone?: (r: RagResult) => void;
  /** Allow a bench / bin / duck ending (people whose owner can cope with it). Default true. */
  silly?: boolean;
  /** Ignore the camera-distance rule (the player, whose flight the camera is following anyway). */
  always?: boolean;
}

interface Rag {
  p: Person;
  // Centre of mass, its velocity, orientation and angular velocity (world).
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  q: THREE.Quaternion;
  wx: number; wy: number; wz: number;
  ch: Float32Array; chv: Float32Array;
  /** The root frame handed to the renderer: pelvis position, orientation, scale. */
  m: Float64Array;
  k: number;
  t: number; air: number; still: number;
  /** 0 flying, 1 easing onto the ground, 2 holding an absurd pose (bench, bin). */
  phase: number; phaseT: number;
  q0: THREE.Quaternion; q1: THREE.Quaternion;
  face: number; h: number; py0: number; py1: number;
  wet: boolean; ducked: boolean;
  landed: RagLanding;
  sx: number; sz: number;
  seat: { x: number; z: number; y: number } | null;
  opts: RagOpts;
  seed: number;
  /** Multiplayer: driven from the network, not simulated here. */
  remote: boolean;
}

// Scratch.
const R = new Float64Array(9);
const PT = new Float64Array(3);
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const TMP = { x: 0, z: 0 };

const PUNS = [
  'Pedestrian upgraded to frequent flyer.',
  'Right of way: disputed. Altitude: considerable.',
  'Crosswalk etiquette has been reviewed.',
  'A short flight. No snacks were served.',
  'Witnesses describe the landing as "committed".',
  'Gravity remains undefeated.',
  'Jaywalking fine waived in light of the air miles.',
  'Hood ornament, briefly.',
  'That one will be talked about at dinner.',
  'Airborne without a permit.',
];
const BENCH = ['Took a seat. Did not ask.', 'Landed on a bench. Pretends it was the plan.', 'A seat, found the hard way.'];
const BIN = ['Filed under general waste.', 'Recycling will not accept this.', 'Into the bin. Out of the bin. Nobody saw anything.'];
const DUCK = ['The duck has been consulted.', 'Boing.', 'Bounced off the duck. The duck is unmoved.'];
const SELF = ['Dess has been briefly airborne.', 'A flight Dess did not book.', 'Dess: bonnet ornament, then lawn ornament.'];

export class Ragdolls {
  private readonly list: Rag[] = [];
  private acc = 0;
  private toastCool = 0;
  /** Landed by this browser's player's car, this visit (for tools). */
  readonly stats = { flights: 0, far: 0, bench: 0, bin: 0, duck: 0 };

  constructor(private readonly game: Game) {}

  get count(): number { return this.list.length; }
  get max(): number { return this.game.quality.name === 'low' ? 2 : 5; }

  /** True while this person's body belongs to a ragdoll: whoever controls them leaves x, y, z and pose alone. */
  flying(p: Person): boolean {
    for (const r of this.list) if (r.p === p) return true;
    return false;
  }

  /** Is there room, and are they near enough the camera to be worth it? */
  canTake(p: Person, always = false): boolean {
    if (this.flying(p)) return true;
    if (this.list.length >= this.max || !p.visible) return false;
    if (always) return true;
    const g = this.game, eye = g.view ? g.view.pos : g.camera.position;
    const near = g.quality.name === 'low' ? 30 : 60;
    const dx = p.x - eye.x, dz = p.z - eye.z;
    return dx * dx + dz * dz < near * near;
  }

  /**
   * Run down by something moving at (cvx, cvz). False when there is no room (the caller keeps its old fall).
   * Slow knocks topple, fast ones go over the bonnet with a somersault and a cartoon spin.
   */
  hitByCar(p: Person, cvx: number, cvz: number, opts: RagOpts = {}): boolean {
    const sp = Math.hypot(cvx, cvz);
    if (sp < 0.5) return false;
    const dx = cvx / sp, dz = cvz / sp;
    const fast = sp > 12;
    const s = hash2(p.id, this.stats.flights + Math.floor(this.game.time * 7)) < 0.5 ? -1 : 1;
    const vh = sp * (fast ? 0.62 : 0.85) + 1.2;
    const vy = Math.min(14, 1.4 + sp * 0.34);
    // Legs swept forward, head left behind: the somersault is back over the bonnet. (d x up.)
    const flip = 2.2 + sp * 0.42;
    const spin = s * (1.2 + sp * 0.28);
    return this.launch(p, dx * vh, vy, dz * vh, -dz * flip, spin, dx * flip, opts) && this.funnyStart(p, sp, opts);
  }

  /** Any other throw: out of a car, a blast. Velocity, and a tumble made up from it. */
  throwOut(p: Person, vx: number, vy: number, vz: number, opts: RagOpts = {}): boolean {
    const sp = Math.hypot(vx, vz) || 1;
    const t = 1 + sp * 0.3;
    return this.launch(p, vx, vy, vz, (-vz / sp) * t, (hash2(p.id, sp) - 0.5) * 6, (vx / sp) * t, opts);
  }

  private funnyStart(p: Person, sp: number, opts: RagOpts): boolean {
    const g = this.game;
    if (opts.by === 'player') {
      this.stats.flights++;
      g.todo?.save.bump('ragFlights');
      if (sp > 13 && this.toastCool <= 0 && Math.random() < 0.3) { g.hud.toast(pickRand(PUNS), 3.5); this.toastCool = 25; }
    }
    if (p === g.player.person) {
      g.todo?.save.bump('ragSelf');
      if (sp > 13 && this.toastCool <= 0 && Math.random() < 0.35) { g.hud.toast(pickRand(SELF), 3.5); this.toastCool = 25; }
    }
    return true;
  }

  launch(p: Person, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, opts: RagOpts = {}): boolean {
    let r = this.list.find((o) => o.p === p);
    if (!r) {
      if (!this.canTake(p, opts.always)) return false;
      const k = p.look.height || 1;
      r = {
        p, x: p.x, y: p.y + (HIP + COM_Y) * k, z: p.z, vx: 0, vy: 0, vz: 0,
        q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.h),
        wx: 0, wy: 0, wz: 0,
        ch: new Float32Array(NCH), chv: new Float32Array(NCH), m: new Float64Array(16), k,
        t: 0, air: 0, still: 0, phase: 0, phaseT: 0, q0: new THREE.Quaternion(), q1: new THREE.Quaternion(),
        face: -1, h: 0, py0: 0, py1: 0, wet: false, ducked: false, landed: 'ground', sx: p.x, sz: p.z, seat: null,
        opts, seed: p.id * 7 + Math.floor(this.game.time * 13), remote: false,
      };
      ragPose(p, r.ch);
      this.list.push(r);
      this.frame(r);
      ragAttach(p, r.m, r.ch);
    } else {
      // Hit again in the air: the new knock adds, and the newest owner hears about the landing.
      r.phase = 0; r.still = 0; r.opts = { ...r.opts, ...opts };
    }
    r.vx += vx; r.vy = Math.max(r.vy, 0) + vy; r.vz += vz;
    r.wx += wx; r.wy += wy; r.wz += wz;
    p.pose = 'down'; p.speed = 0; p.bench = false;
    return true;
  }

  /** Let go of somebody without a landing (they were removed, or their owner took them back). */
  drop(p: Person): void {
    const i = this.list.findIndex((o) => o.p === p);
    if (i < 0) return;
    const r = this.list[i];
    this.list.splice(i, 1);
    if (r.phase === 0) { this.beginSettle(r, groundAt(r.x, r.z)); r.q.copy(r.q1); }
    if (r.phase === 2) { p.visible = true; p.bench = false; return; }
    this.settleFrame(r);
    ragDetach(p, r.face, r.ch);
  }

  // ── Multiplayer: a body shown from somebody else's simulation ───────────────

  /** Start (or keep) showing a remote ragdoll on this person. No physics: setRemote() moves it. */
  remote(p: Person): boolean {
    let r = this.list.find((o) => o.p === p);
    if (r) return true;
    if (!this.launch(p, 0, 0, 0, 0, 0, 0, { silly: false, always: true })) return false;
    r = this.list[this.list.length - 1];
    r.remote = true;
    return true;
  }

  /** Remote pose: centre of mass, orientation, a few limb angles; smoothed toward. */
  setRemote(p: Person, x: number, y: number, z: number, q: THREE.Quaternion, limbs: ArrayLike<number> | null, dt: number): void {
    const r = this.list.find((o) => o.p === p);
    if (!r) return;
    const a = 1 - Math.exp(-14 * dt);
    if (Math.abs(r.x - x) + Math.abs(r.y - y) + Math.abs(r.z - z) > 8) { r.x = x; r.y = y; r.z = z; r.q.copy(q); }
    else { r.x += (x - r.x) * a; r.y += (y - r.y) * a; r.z += (z - r.z) * a; r.q.slerp(q, a); }
    if (limbs) for (let i = 0; i < NET_LIMBS.length && i < limbs.length; i++) r.ch[NET_LIMBS[i]] += (limbs[i] - r.ch[NET_LIMBS[i]]) * a;
    else this.limbs(r, dt, true);
    r.t += dt;
    this.frame(r);
  }

  /** What the network sends of a body this browser simulates: com xyz, quaternion xyzw, NET_LIMBS angles. */
  sample(p: Person, out: Float32Array): boolean {
    const r = this.list.find((o) => o.p === p);
    if (!r || r.remote) return false;
    out[0] = r.x; out[1] = r.y; out[2] = r.z;
    out[3] = r.q.x; out[4] = r.q.y; out[5] = r.q.z; out[6] = r.q.w;
    for (let i = 0; i < NET_LIMBS.length; i++) out[7 + i] = r.ch[NET_LIMBS[i]];
    return true;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.toastCool > 0) this.toastCool -= dt;
    if (this.list.length === 0) { this.acc = 0; return; }
    this.acc = Math.min(this.acc + dt, STEP * 4);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const r = this.list[i];
        if (r.remote) continue;
        if (!r.p.visible && r.phase !== 2) { this.list.splice(i, 1); ragDetach(r.p, r.face, r.ch); continue; }
        if (this.step(r)) { this.list.splice(i, 1); this.finish(r); }
      }
    }
    for (const r of this.list) if (!r.remote) this.frame(r);
  }

  /** One fixed step. True when finished. */
  private step(r: Rag, dt = STEP): boolean {
    const g = this.game;
    r.t += dt;
    if (r.phase === 2) {
      // Holding an absurd pose: sat on the bench, or in the bin.
      r.phaseT += dt;
      const p = r.p;
      if (r.landed === 'bench' && r.seat) { p.x = r.seat.x; p.y = r.seat.y; p.z = r.seat.z; p.pose = 'sit'; p.bench = true; }
      return r.phaseT > (r.landed === 'bin' ? 2.2 : 3.2);
    }
    if (r.phase === 1) {
      // Easing onto back or front, into the 'down' pose's own frame.
      r.phaseT += dt;
      const u = Math.min(1, r.phaseT / 0.4), e = u * u * (3 - 2 * u);
      r.q.slerpQuaternions(r.q0, r.q1, e);
      this.limbs(r, dt, true);
      const py = r.py0 + (r.py1 - r.py0) * e;
      r.y = py + this.comUp(r);
      return u >= 1;
    }

    // Gravity, air, water.
    r.vy -= GRAV * dt;
    const air = Math.exp(-0.05 * dt);
    r.vx *= air; r.vy *= air; r.vz *= air;
    const wl = waterLevelAt(r.x, r.z), floor = groundAt(r.x, r.z);
    if (floor < wl - 0.4 && r.y < wl + 0.15) {
      const sub = clamp((wl + 0.15 - r.y) / 0.45, 0, 1);
      if (!r.wet) {
        r.wet = true;
        const big = r.vy < -6;
        g.emit('splash', { x: r.x, z: r.z, big });
        g.fx?.emitters.splash(r.x, r.z, big);
      }
      r.vy += GRAV * 1.7 * sub * dt;
      const d = Math.exp(-2.8 * sub * dt), dw = Math.exp(-3.5 * sub * dt);
      r.vx *= d; r.vy *= d; r.vz *= d; r.wx *= dw; r.wy *= dw; r.wz *= dw;
    }

    // Integrate.
    r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    const wl2 = r.wx * r.wx + r.wy * r.wy + r.wz * r.wz;
    if (wl2 > 1e-8) {
      // dq = 0.5 * (w, 0) * q
      const q = r.q, hx = 0.5 * dt * r.wx, hy = 0.5 * dt * r.wy, hz = 0.5 * dt * r.wz;
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      q.set(
        qx + hx * qw + hy * qz - hz * qy,
        qy - hx * qz + hy * qw + hz * qx,
        qz + hx * qy - hy * qx + hz * qw,
        qw - hx * qx - hy * qy - hz * qz,
      ).normalize();
    }
    const wa = Math.exp(-0.25 * dt);
    r.wx *= wa; r.wy *= wa; r.wz *= wa;
    rot(r.q);

    // The duck.
    if (r.opts.silly !== false && !r.ducked) {
      const dx = r.x - DUCK_X, dz = r.z - DUCK_Z, d2 = dx * dx + dz * dz;
      if (d2 < DUCK_R * DUCK_R && r.y < DUCK_TOP + 1) {
        const l = Math.sqrt(d2) || 1;
        r.ducked = true;
        r.vx = (dx / l) * 7; r.vz = (dz / l) * 7; r.vy = 9;
        r.wy += 8; r.wx += 4;
        g.emit('duck', { x: r.x, z: r.z });
        g.hud.toast(pickRand(DUCK), 3);
        r.landed = 'duck'; this.stats.duck++;
      }
    }

    // Walls: the city's boxes push the trunk out; what was heading into them comes back with a spin.
    TMP.x = r.x; TMP.z = r.z;
    if (g.col.resolveCircle(TMP, 0.3, r.y - 0.4)) {
      let nx = TMP.x - r.x, nz = TMP.z - r.z;
      const l = Math.hypot(nx, nz);
      if (l > 1e-5) {
        nx /= l; nz /= l;
        const vn = r.vx * nx + r.vz * nz;
        if (vn < 0) {
          r.vx -= 1.45 * vn * nx; r.vz -= 1.45 * vn * nz;
          r.wx += nz * vn * 0.9; r.wz -= nx * vn * 0.9; r.wy += (hash2(r.seed, r.t) - 0.5) * vn * 1.5;
          this.kick(r, -vn * 0.25);
          if (-vn > 5) g.fx?.emitters.dust(r.x, r.y, r.z, nx * 2, nz * 2, 0.8, false);
        }
      }
      r.x = TMP.x; r.z = TMP.z;
    }

    // Ground: a plane under the body, so a slope tips it as it lands.
    const ga = groundAt(r.x + 0.5, r.z), gb = groundAt(r.x, r.z + 0.5);
    const sx = (ga - floor) * 2, sz = (gb - floor) * 2;
    let ny = 1 / Math.sqrt(1 + sx * sx + sz * sz);
    const nx = -sx * ny, nz = -sz * ny;
    ny = ny > 0.2 ? ny : 0.2;
    let contact = false, deepest = 0, hard = 0;
    const n = this.points(r);
    for (let i = 0; i < n; i++) {
      const lx = PTS[i * 4], ly = PTS[i * 4 + 1], lz = PTS[i * 4 + 2], rad = PTS[i * 4 + 3];
      // r = R * local (relative to the centre of mass), scaled
      const k = r.k;
      const rx = (R[0] * lx + R[3] * ly + R[6] * lz) * k;
      const ry = (R[1] * lx + R[4] * ly + R[7] * lz) * k;
      const rz = (R[2] * lx + R[5] * ly + R[8] * lz) * k;
      const px = r.x + rx, py = r.y + ry, pz = r.z + rz;
      const gh = floor + sx * (px - r.x) + sz * (pz - r.z);
      const pen = (gh + rad - py) * ny;
      if (pen <= 0) continue;
      contact = true;
      if (pen > deepest) deepest = pen;
      // Velocity of the point.
      const vpx = r.vx + r.wy * rz - r.wz * ry;
      const vpy = r.vy + r.wz * rx - r.wx * rz;
      const vpz = r.vz + r.wx * ry - r.wy * rx;
      const vn = vpx * nx + vpy * ny + vpz * nz;
      if (vn >= 0) continue;
      // Effective mass along the normal.
      const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
      invI(cx, cy, cz);
      const denom = INV_M + cx * PT[0] + cy * PT[1] + cz * PT[2];
      // Bouncy at speed, dead at a crawl, so it does come to rest.
      const e = vn < -4 ? 0.32 : vn < -1.5 ? 0.15 : 0;
      const j = -(1 + e) * vn / denom;
      this.impulse(r, rx, ry, rz, nx * j, ny * j, nz * j);
      if (-vn > hard) hard = -vn;
      // Friction.
      let tx = vpx - vn * nx, ty = vpy - vn * ny, tz = vpz - vn * nz;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-4) {
        tx /= tl; ty /= tl; tz /= tl;
        const ex = ry * tz - rz * ty, ey = rz * tx - rx * tz, ez = rx * ty - ry * tx;
        invI(ex, ey, ez);
        const dt2 = INV_M + ex * PT[0] + ey * PT[1] + ez * PT[2];
        const jt = Math.min(tl / dt2, (r.wet ? 0.2 : 0.65) * j);
        this.impulse(r, rx, ry, rz, -tx * jt, -ty * jt, -tz * jt);
      }
    }
    if (deepest > 0) { r.x += nx * deepest * 0.8; r.y += ny * deepest * 0.8; r.z += nz * deepest * 0.8; }
    if (contact) {
      r.air = 0;
      // Rolling resistance and scrub.
      const rr = Math.exp(-1.6 * dt), sc = Math.exp(-0.6 * dt);
      r.wx *= rr; r.wy *= rr; r.wz *= rr; r.vx *= sc; r.vz *= sc;
      // Nearly stopped: no endless rocking on a curved back.
      const slow = r.vx * r.vx + r.vy * r.vy + r.vz * r.vz;
      if (slow < 2.5) { const d = Math.exp(-4.5 * dt); r.wx *= d; r.wy *= d; r.wz *= d; r.vx *= d; r.vz *= d; }
      if (hard > 3) {
        this.kick(r, hard * 0.18);
        if (hard > 5) { g.fx?.emitters.dust(r.x, floor + 0.1, r.z, r.vx * 0.3, r.vz * 0.3, Math.min(1, hard / 12), false); g.cam?.shake?.(r.p === g.player.person ? Math.min(0.5, hard / 30) : 0); }
      }
    } else r.air += dt;

    // Benches and bins: the absurd endings.
    // (A bin is solid and pushes the body off: anywhere close and low enough is in.)
    if (r.opts.silly !== false && r.y - floor < 1.9 && r.t > 0.3 && !r.wet) {
      let found: { x: number; z: number; kind: string } | null = null;
      g.col.forProps(r.x, r.z, 1.3, (pr) => {
        if (found || !pr.alive) return;
        const d = Math.hypot(pr.x - r.x, pr.z - r.z);
        if ((pr.kind === 'bench' && r.vy < 0 && d < 0.9) || (pr.kind === 'bin' && d < 1.25)) found = pr;
      });
      const f = found as { x: number; z: number; kind: string } | null;
      if (f) return this.absurd(r, f.kind === 'bench' ? 'bench' : 'bin', f.x, f.z, floor);
    }

    this.limbs(r, dt, contact || r.wet);

    // At rest: ease onto back or front.
    const v2 = r.vx * r.vx + r.vy * r.vy + r.vz * r.vz, w2 = r.wx * r.wx + r.wy * r.wy + r.wz * r.wz;
    if ((contact || r.wet) && v2 < REST_SPEED * REST_SPEED && w2 < REST_SPIN * REST_SPIN) r.still += dt; else r.still = 0;
    if (r.still > 0.25 || r.t > 6.5 || (r.wet && r.t > 2.5 && v2 < 1)) this.beginSettle(r, r.wet ? wl : floor);
    // Fell out of the world: give up.
    if (r.y < floor - 3 && !r.wet) { r.y = floor + 0.5; this.beginSettle(r, floor); }
    return false;
  }

  private absurd(r: Rag, kind: 'bench' | 'bin', x: number, z: number, floor: number): boolean {
    const g = this.game;
    r.landed = kind; r.phase = 2; r.phaseT = 0;
    const p = r.p;
    // Unhook the body from the ragdoll now: the renderer shows the pose (sat) or nothing (bin).
    ragDetach(p, -1, r.ch);
    if (kind === 'bench') {
      // Facing away from the road, sat on the seat point.
      r.seat = { x, z, y: floor + 0.45 };
      p.h = Math.atan2(r.vx, r.vz) + Math.PI;
      p.pose = 'sit'; p.bench = true; p.x = x; p.y = r.seat.y; p.z = z;
      this.stats.bench++;
      g.hud.toast(pickRand(BENCH), 3);
    } else {
      p.x = x + 0.6; p.z = z; p.y = floor;
      p.visible = false;
      this.stats.bin++;
      g.emit('splash', { x, z, big: false });
      g.hud.toast(pickRand(BIN), 3);
    }
    return false;
  }

  /** Done: hand the body back. */
  private finish(r: Rag): void {
    const p = r.p;
    if (r.phase === 2) {
      // Out of the bin, or up off the bench: upright already.
      if (r.landed === 'bin') { p.visible = true; p.pose = 'stand'; }
      else { p.pose = 'stand'; p.bench = false; p.y = groundAt(p.x, p.z); }
      r.opts.onDone?.({ x: p.x, y: p.y, z: p.z, h: p.h, face: -1, landed: r.landed, up: true, dist: Math.hypot(p.x - r.sx, p.z - r.sz) });
      return;
    }
    this.settleFrame(r);
    const dist = Math.hypot(p.x - r.sx, p.z - r.sz);
    if (r.opts.by === 'player' && dist > this.stats.far) {
      this.stats.far = dist;
      const save = this.game.todo?.save;
      if (save && dist > save.count('ragFar')) save.data.counts.ragFar = Math.round(dist);
    }
    ragDetach(p, r.face, r.ch);
    r.opts.onDone?.({ x: p.x, y: p.y, z: p.z, h: p.h, face: r.face, landed: r.wet ? 'water' : r.landed === 'duck' ? 'duck' : 'ground', up: false, dist });
  }

  private beginSettle(r: Rag, floor: number): void {
    if (r.phase !== 0) return;
    rot(r.q);
    // Chest axis up = lying on the back.
    const face = R[7] >= 0 ? -1 : 1;
    const hx = R[3], hz = R[5];
    const h = face < 0 ? Math.atan2(-hx, -hz) : Math.atan2(hx, hz);
    r.face = face; r.h = h;
    r.q0.copy(r.q);
    _e.set(face * Math.PI / 2, h, 0, 'YXZ');
    r.q1.setFromEuler(_e);
    if (r.q0.dot(r.q1) < 0) r.q1.set(-r.q1.x, -r.q1.y, -r.q1.z, -r.q1.w);
    r.py0 = r.y - this.comUp(r);
    r.py1 = (r.wet ? floor - 0.25 : floor) + LIE * r.k;
    r.phase = 1; r.phaseT = 0;
    r.vx = r.vy = r.vz = 0; r.wx = r.wy = r.wz = 0;
  }

  /** Where the feet go for the 'down' pose that matches the settled trunk. */
  private settleFrame(r: Rag): void {
    const p = r.p, k = r.k;
    _e.set(r.face * Math.PI / 2, r.h, 0, 'YXZ');
    _q.setFromEuler(_e);
    // pelvis = feet + Rdown * (0, HIP, -face * LIE) * k
    const pel = this.pelvis(r), ex = pel[0], ey = pel[1], ez = pel[2];
    rot(_q);
    const ly = HIP, lz = -r.face * LIE;
    p.x = ex - (R[3] * ly + R[6] * lz) * k;
    p.y = ey - (R[4] * ly + R[7] * lz) * k;
    p.z = ez - (R[5] * ly + R[8] * lz) * k;
    p.h = r.h;
  }

  /** Height of the centre of mass above the pelvis joint, along world up, for the current orientation. */
  private comUp(r: Rag): number {
    rot(r.q);
    return R[4] * COM_Y * r.k;
  }

  private pelvis(r: Rag): Float64Array {
    rot(r.q);
    const c = COM_Y * r.k;
    PT[0] = r.x - R[3] * c; PT[1] = r.y - R[4] * c; PT[2] = r.z - R[5] * c;
    return PT;
  }

  /** The root frame for the renderer, and the person's position for everyone else (camera, culling). */
  private frame(r: Rag): void {
    const pel = this.pelvis(r), m = r.m, k = r.k;
    m[0] = R[0] * k; m[1] = R[1] * k; m[2] = R[2] * k; m[3] = 0;
    m[4] = R[3] * k; m[5] = R[4] * k; m[6] = R[5] * k; m[7] = 0;
    m[8] = R[6] * k; m[9] = R[7] * k; m[10] = R[8] * k; m[11] = 0;
    m[12] = pel[0]; m[13] = pel[1]; m[14] = pel[2]; m[15] = 1;
    const p = r.p;
    if (r.phase !== 2) { p.x = pel[0]; p.z = pel[2]; p.y = pel[1] - 0.5 * k; }
  }

  private impulse(r: Rag, rx: number, ry: number, rz: number, jx: number, jy: number, jz: number): void {
    r.vx += jx * INV_M; r.vy += jy * INV_M; r.vz += jz * INV_M;
    invI(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
    r.wx += PT[0]; r.wy += PT[1]; r.wz += PT[2];
  }

  /** A knock shakes the limbs about. */
  private kick(r: Rag, amount: number): void {
    const a = Math.min(amount, 4);
    for (const [c] of LIMITS) r.chv[c] += (hash2(r.seed + c, r.t * 31) - 0.5) * a * 6;
  }

  /** Limb springs: a flail in the air, a sprawl on the ground. */
  private limbs(r: Rag, dt: number, down: boolean): void {
    const ch = r.ch, v = r.chv, T = r.t, s = r.seed;
    const flail = down ? 0 : Math.min(1, r.air * 4 + 0.3);
    const kS = down ? 22 : 70, cD = down ? 5 : 9;
    // Spinning about the spine flings the arms out.
    rot(r.q);
    const twist = Math.abs(R[3] * r.wx + R[4] * r.wy + R[5] * r.wz);
    for (const [c, lo, hi] of LIMITS) {
      let tgt = 0;
      const i = c >= LSW ? ((c - LSW) / 4) | 0 : c >= ASW ? ((c - ASW) / 3) | 0 : 0;
      const ph = i * Math.PI;
      const h = hash2(s, c);
      switch (c - (c >= LSW ? i * 4 : c >= ASW ? i * 3 : 0)) {
        case ASW: tgt = flail ? 1.3 + 1.5 * Math.sin(T * 11 + ph) : 0.2 + 0.9 * h; break;
        case AAB: tgt = flail ? 1.5 + 0.6 * Math.sin(T * 7 + ph) + Math.min(0.6, twist * 0.06) : 0.8 + 0.9 * h; break;
        case AEL: tgt = flail ? 0.7 + 0.5 * Math.sin(T * 9 + ph) : 0.25 + 0.4 * h; break;
        case LSW: tgt = flail ? 0.6 + 0.8 * Math.sin(T * 10 + ph) : 0.1 + 0.35 * h; break;
        case LAB: tgt = flail ? 0.35 : 0.2 + 0.3 * h; break;
        case LKN: tgt = flail ? 0.9 + 0.7 * Math.sin(T * 10 + ph + 1) : 0.1 + 0.5 * h; break;
        case LFT: tgt = flail ? 0.3 : 0.25; break;
        case LEAN: tgt = flail ? -0.2 : 0; break;
        case HPITCH: tgt = flail ? -0.35 : 0.1 * (h - 0.5); break;
        case HYAW: tgt = flail ? 0.3 * Math.sin(T * 5) : (h - 0.5) * 1.4; break;
        case HROLL: tgt = flail ? 0 : (h - 0.5) * 0.8; break;
        default: tgt = 0;
      }
      v[c] += (kS * (tgt - ch[c]) - cD * v[c]) * dt;
      let x = ch[c] + v[c] * dt;
      if (x < lo) { x = lo; if (v[c] < 0) v[c] *= -0.3; } else if (x > hi) { x = hi; if (v[c] > 0) v[c] *= -0.3; }
      ch[c] = x;
    }
  }

  /** Contact spheres in the body frame, relative to the centre of mass: x, y, z, radius. Returns how many. */
  private points(r: Rag): number {
    const c = r.ch;
    let n = 0;
    const put = (x: number, y: number, z: number, rad: number): void => { PTS[n * 4] = x; PTS[n * 4 + 1] = y - COM_Y; PTS[n * 4 + 2] = z; PTS[n * 4 + 3] = rad; n++; };
    put(0, 0, 0, 0.13);
    put(0, 0.4, 0, 0.15);
    put(0, 0.74, 0.03, 0.11);
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      // Leg: swing about X, then abduct about Z.
      const sw = c[LSW + i * 4], ab = s * c[LAB + i * 4], kn = c[LKN + i * 4];
      const sa = Math.sin(ab), ca = Math.cos(ab);
      const hx = s * 0.092;
      let cy = -Math.cos(sw), cz = Math.sin(sw);
      const kx = hx - cy * sa * THIGH, ky = cy * ca * THIGH, kz = cz * THIGH;
      put(kx, ky, kz, 0.07);
      cy = -Math.cos(sw - kn); cz = Math.sin(sw - kn);
      put(kx - cy * sa * SHIN, ky + cy * ca * SHIN, kz + cz * SHIN, 0.07);
      // Arm: abduct about Z, then swing about X.
      const as = c[ASW + i * 3], aa = s * c[AAB + i * 3];
      const shx = s * 0.19, shy = 0.47;
      put(shx, shy, 0, 0.08);
      const ca2 = Math.cos(aa);
      put(shx + Math.sin(aa) * ARM, shy - ca2 * Math.cos(as) * ARM, ca2 * Math.sin(as) * ARM, 0.06);
    }
    return n;
  }
}

/** Limb channels sent over the network, in this order. */
export const NET_LIMBS = [ASW, AAB, AEL, ASW + 3, AAB + 3, AEL + 3, LSW, LKN, LSW + 4, LKN + 4] as const; // = protocol RAG_LIMBS
/** Floats in one sample(): com xyz, quaternion xyzw, then NET_LIMBS. */
export const NET_RAG = 7 + NET_LIMBS.length;

const PTS = new Float64Array(4 * 16);

/** R = rotation matrix of q, column-major 3x3. */
function rot(q: THREE.Quaternion): void {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  R[0] = 1 - (yy + zz); R[1] = xy + wz; R[2] = xz - wy;
  R[3] = xy - wz; R[4] = 1 - (xx + zz); R[5] = yz + wx;
  R[6] = xz + wy; R[7] = yz - wx; R[8] = 1 - (xx + yy);
}

/** PT = R * IB * R^T * v (world inverse inertia), using R as last set by rot(). */
function invI(vx: number, vy: number, vz: number): void {
  const a = (R[0] * vx + R[1] * vy + R[2] * vz) * IB[0];
  const b = (R[3] * vx + R[4] * vy + R[5] * vz) * IB[1];
  const c = (R[6] * vx + R[7] * vy + R[8] * vz) * IB[2];
  PT[0] = R[0] * a + R[3] * b + R[6] * c;
  PT[1] = R[1] * a + R[4] * b + R[7] * c;
  PT[2] = R[2] * a + R[5] * b + R[8] * c;
}
