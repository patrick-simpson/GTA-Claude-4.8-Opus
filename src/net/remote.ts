// Somebody else in town, drawn from the state frames their browser sends (about ten a second, and none at all
// while they stand still). Drawn only: nothing here collides with anything.
//
// Smoothing: every frame arrives stamped with the sender's clock. The picture shows where they were INTERP_MS ago,
// between the two frames either side of that moment, so an uneven network still gives even motion. When the next
// frame is late the last one is carried on along its velocity, for EXTRAP_MS at most. A jump too large to be
// driving is taken at once instead of being slid through walls.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Look, Person, Pose, Vehicle } from '../core/api';
import { RNG, angleDiff, clamp } from '../core/util';
import { KINDS, SPECS, type VehicleKind } from '../ent/vehicleSpecs';
import { POSES, PlayerFlag, PlayerMode, type PlayerState } from './protocol';
import { nameText } from './names';

/** How far in the past the others are shown, ms. A little over one send interval, so there is nearly always a frame on each side. */
export const INTERP_MS = 130;
/** The longest a late frame is covered for by carrying on along the last velocity, ms. */
export const EXTRAP_MS = 150;
/** Frames further apart than this are a pause, not motion: the move between them takes MOVE_MS, not the whole pause. */
const GAP_MS = 450;
const MOVE_MS = 100;
const KEEP = 12;
/** Labels: full strength to here, gone by there (meters from the camera). */
const LABEL_NEAR = 45, LABEL_FAR = 60;

interface Sample {
  /** Receiver's clock, ms. */
  t: number;
  x: number; y: number; z: number; yaw: number;
  vx: number; vz: number;
  pitch: number; roll: number; steer: number;
  mode: number; pose: number; flags: number; vehicle: number; color: number;
}

const blank = (): Sample => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, pitch: 0, roll: 0, steer: 0, mode: 0, pose: 0, flags: 0, vehicle: 0, color: 0 });

/** The same person in every browser: the look is made from the id and the name alone. */
function lookFor(game: Game, id: number, name: readonly number[]): Look {
  let seed = 0x9e3779b1 ^ Math.imul(id, 2654435761);
  for (const n of name) seed = Math.imul(seed ^ (n + 1), 0x85ebca6b) ^ (seed >>> 13);
  return game.people.randomLook(new RNG(seed >>> 0 || 1), true);
}

// ── The name tag ─────────────────────────────────────────────────────────────

const TAG_FONT = '600 44px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
const TAG_H = 72;

/** A bone slip with ink type and a vermilion rule, like the rest of the paperwork. Returns its width over its height. */
function drawTag(cv: HTMLCanvasElement, text: string): number {
  let g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.font = TAG_FONT;
  const w = Math.ceil(g.measureText(text).width) + 44;
  cv.width = w; cv.height = TAG_H;
  g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#14213d';
  g.fillRect(0, 0, w, TAG_H);
  g.fillStyle = '#f2e8cf';
  g.fillRect(4, 4, w - 8, TAG_H - 8);
  g.fillStyle = '#e4572e';
  g.fillRect(4, 4, w - 8, 7);
  g.font = TAG_FONT;
  g.fillStyle = '#14213d';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, TAG_H / 2 + 6);
  return w / TAG_H;
}

export class Remote {
  /** Smoothed, as drawn this frame. */
  x = 0; y = 0; z = 0; h = 0;
  speed = 0;
  mode = 0;
  pose: Pose = 'stand';
  /** The kind of car they are driving, or null on foot. */
  kind: VehicleKind | null = null;
  color = 0;
  /** State frames received. */
  frames = 0;
  /** True once a frame has arrived: until then there is nothing to draw. */
  seen = false;
  labelShown = false;
  text: string;

  private person: Person | null = null;
  private car: Vehicle | null = null;
  private readonly label: THREE.Sprite;
  private readonly tagCv = document.createElement('canvas');
  private readonly tagTex: THREE.CanvasTexture;
  private tagAspect = 3;

  private readonly buf: Sample[] = [];
  /** Sender's clock unwrapped (it sends 16 bits), and the smallest (arrival - sender time) seen lately. */
  private sendT = 0;
  private lastArrive = -1;
  private offset = 0;
  private readonly cur = blank();
  /** Height of the tag over (x, y, z), and whether a first position has been drawn. */
  private top = 2;
  private placed = false;

  constructor(private readonly game: Game, readonly id: number, public name: number[]) {
    this.text = nameText(name);
    this.tagTex = new THREE.CanvasTexture(this.tagCv);
    this.tagTex.colorSpace = THREE.SRGBColorSpace;
    this.tagTex.generateMipmaps = true;
    this.tagTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tagTex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    this.label = new THREE.Sprite(mat);
    this.label.name = 'net_label';
    this.label.visible = false;
    this.label.renderOrder = 20;
    game.scene.add(this.label);
    this.paintTag();
    // The HUD's face may not have arrived when the first player does.
    try { void document.fonts.load(TAG_FONT).then(() => this.paintTag(), () => {}); } catch { /* no font loading API */ }
  }

  private paintTag(): void {
    this.tagAspect = drawTag(this.tagCv, this.text);
    this.tagTex.needsUpdate = true;
  }

  rename(name: number[]): void {
    this.name = name;
    this.text = nameText(name);
    this.paintTag();
    // A new name is a new person: same rule as on every other screen.
    if (this.person) { this.game.people.remove(this.person); this.person = null; }
  }

  /** A state frame from this player. now: this browser's clock, ms. */
  push(s: PlayerState, now: number): void {
    // Unwrap the sender's 16 bit clock with the time that passed here, then keep the smallest lag seen: a frame that
    // was held up on the way is placed where it belongs instead of where it arrived.
    if (this.lastArrive < 0 || now - this.lastArrive > 20000) {
      this.sendT = s.t; this.offset = now - s.t;
    } else {
      const guess = this.sendT + (now - this.lastArrive);
      let t = guess - ((guess - s.t) % 65536 + 65536) % 65536;
      if (guess - t > 32768) t += 65536;
      // Out of order or a duplicate: the newer one is already in.
      if (t <= this.sendT) return;
      this.sendT = t;
      // The lag estimate may only creep up, so one fast frame does not make every later one look late for ever.
      this.offset = Math.min(this.offset + 0.02 * (now - this.lastArrive), now - t);
    }
    this.lastArrive = now;
    this.frames++;

    const buf = this.buf, t = this.sendT + this.offset;
    const prev = buf.length ? buf[buf.length - 1] : null;
    if (prev) {
      const d = Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z), dt = Math.max(0.05, (t - prev.t) / 1000);
      const sp = Math.max(Math.hypot(s.vx, s.vz), Math.hypot(prev.vx, prev.vz));
      // Further than their speed explains (a teleport, a respawn): take it at once.
      if (d > 6 + sp * Math.min(dt, 1) * 2) buf.length = 0;
      else if (t - prev.t > GAP_MS) {
        // They stood still (nothing is sent then) and have set off again: the move starts now, not back then.
        const hold = buf.length >= KEEP ? (buf.shift() as Sample) : blank();
        Object.assign(hold, prev);
        hold.t = t - MOVE_MS; hold.vx = 0; hold.vz = 0;
        buf.push(hold);
      }
    }
    const a = buf.length >= KEEP ? (buf.shift() as Sample) : blank();
    a.t = t; a.x = s.x; a.y = s.y; a.z = s.z; a.yaw = s.yaw; a.vx = s.vx; a.vz = s.vz;
    a.pitch = s.pitch; a.roll = s.roll; a.steer = s.steer;
    a.mode = s.mode; a.pose = s.pose; a.flags = s.flags; a.vehicle = s.vehicle; a.color = s.color;
    buf.push(a);
    this.seen = true;
  }

  /** Where they are at `now - INTERP_MS`, into this.cur. */
  private sample(now: number): void {
    const buf = this.buf, c = this.cur, rt = now - INTERP_MS, n = buf.length;
    const last = buf[n - 1];
    if (rt >= last.t) {
      Object.assign(c, last);
      const k = Math.min(rt - last.t, EXTRAP_MS) / 1000;
      c.x += last.vx * k; c.z += last.vz * k;
      return;
    }
    let i = n - 2;
    while (i > 0 && buf[i].t > rt) i--;
    const a = buf[Math.max(i, 0)], b = buf[Math.max(i, 0) + 1] ?? a;
    if (rt <= a.t || b === a) { Object.assign(c, a); return; }
    const k = (rt - a.t) / (b.t - a.t);
    // What they are (on foot, in which car) is the earlier frame's until the later one is reached.
    Object.assign(c, k < 0.5 ? a : b);
    c.x = a.x + (b.x - a.x) * k; c.y = a.y + (b.y - a.y) * k; c.z = a.z + (b.z - a.z) * k;
    c.yaw = a.yaw + angleDiff(a.yaw, b.yaw) * k;
    c.vx = a.vx + (b.vx - a.vx) * k; c.vz = a.vz + (b.vz - a.vz) * k;
    c.pitch = a.pitch + (b.pitch - a.pitch) * k; c.roll = a.roll + (b.roll - a.roll) * k;
    c.steer = a.steer + (b.steer - a.steer) * k;
  }

  /** Once a frame: smooth, then put the person or the car and the name tag where they belong. */
  update(now: number, dt: number, eye: THREE.Vector3, night: number): void {
    if (!this.seen || !this.buf.length) return;
    // The people and the cars were drawn earlier in this step, from what the last one left here (game.systems run
    // after them). The tag goes where they were drawn, not where they will be next, or it runs ahead of its owner.
    if (this.placed) this.tag(eye, night);
    this.sample(now);
    const c = this.cur, g = this.game;
    this.x = c.x; this.y = c.y; this.z = c.z; this.h = c.yaw;
    this.mode = c.mode;
    this.pose = POSES[c.pose] ?? 'stand';
    const kind = c.mode === PlayerMode.Driving && c.vehicle > 0 ? KINDS[c.vehicle - 1] ?? null : null;
    this.kind = kind;
    this.color = c.color;
    const fwd = c.vx * Math.sin(c.yaw) + c.vz * Math.cos(c.yaw);
    this.speed = kind ? fwd : Math.hypot(c.vx, c.vz);

    if (!this.person) this.person = g.people.spawn(c.x, c.z, c.yaw, lookFor(g, this.id, this.name));
    const per = this.person;
    let top: number;
    if (kind) {
      if (this.car && this.car.spec.kind !== kind) { g.vehicles.unghost(this.car); this.car = null; }
      if (!this.car) this.car = g.vehicles.ghost(kind, c.color);
      const car = this.car;
      car.color = c.color;
      g.vehicles.ghostPose(car, c.x, c.y, c.z, c.yaw, c.pitch, c.roll, c.steer, fwd,
        (c.flags & PlayerFlag.Braking) !== 0, (c.flags & PlayerFlag.Reversing) !== 0, dt);
      // As with the player's own car: hidden rather than sat inside (the roof of the lowest car is below a cap).
      per.visible = false;
      per.x = c.x; per.y = c.y; per.z = c.z; per.h = c.yaw; per.pose = 'sit'; per.speed = 0;
      top = SPECS[kind].height + 0.3;
    } else {
      if (this.car) { g.vehicles.unghost(this.car); this.car = null; }
      per.visible = true;
      per.x = c.x; per.y = c.y; per.z = c.z; per.h = c.yaw;
      per.pose = this.pose;
      per.bench = (c.flags & PlayerFlag.Bench) !== 0;
      per.speed = this.speed;
      // (A swimmer treads water upright with the feet far below the surface, so the head is where it would be standing.)
      top = this.pose === 'down' ? 0.9 : this.pose === 'sit' ? 1.6 : 1.82 * per.look.height + 0.3;
    }

    this.top = top;
    if (!this.placed) { this.placed = true; this.tag(eye, night); }
  }

  /** The tag keeps about the same size on screen until it is far off, then shrinks and fades. */
  private tag(eye: THREE.Vector3, night: number): void {
    const lab = this.label, top = this.top, d = Math.hypot(this.x - eye.x, this.y + top - eye.y, this.z - eye.z);
    const fade = clamp((LABEL_FAR - d) / (LABEL_FAR - LABEL_NEAR), 0, 1);
    this.labelShown = lab.visible = fade > 0.01 && d > 1.2;
    if (lab.visible) {
      const hgt = clamp(d * 0.04, 0.16, 1.25);
      lab.scale.set(hgt * this.tagAspect, hgt, 1);
      lab.position.set(this.x, this.y + top + hgt * 0.5, this.z);
      const mat = lab.material as THREE.SpriteMaterial;
      mat.opacity = fade;
      // Bone paper at full strength glares under the night exposure and the bloom until the type cannot be read.
      mat.color.setScalar(1 - 0.62 * night);
    }
  }

  /** They left: take everything out of the scene. */
  dispose(): void {
    const g = this.game;
    if (this.person) { g.people.remove(this.person); this.person = null; }
    if (this.car) { g.vehicles.unghost(this.car); this.car = null; }
    g.scene.remove(this.label);
    this.tagTex.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
    this.buf.length = 0;
    this.seen = false; this.placed = false;
  }
}
