// In-cab views (fun queue 2, item 43): a dashboard camera for cars, trucks and vans (a handlebar view for bikes and
// scooters), the driver's cab of the Budget Line's locomotive, a window seat in a coach, the Calamity Shuttle's helm,
// and a bus's windscreen. The camera rig (core/camera.ts) asks this module where the eye is and which way the body of
// the vehicle faces; this module also owns the little interior it draws in front of that eye: a wheel that turns with
// the steering, a speedometer and rev counter (a gear that follows the speed), window pillars and a mirror, all in one
// small group per kind that is built the first time it is wanted and is not even visible the rest of the time.
//
// Frame of the group: the origin is the eye; +x to the LEFT, +y up, +z forward; turned with the vehicle's own Euler
// ('YXZ': -pitch, heading, roll) like every body in this game. Nothing here allocates per frame.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { ACC } from '../core/access';
import { MPH, clamp, clamp01, damp } from '../core/util';
import { CUSHION, SEAT_BACK, isBoatKind, type VehicleKind } from '../ent/vehicleSpecs';
import { trains } from '../world/train';
import { COACH_CUSHION, COACH_SEATS } from '../world/coach';
import { DECK } from '../world/ferryBoat';

/** What the group looks like. */
export type Rig = 'car' | 'truck' | 'bus' | 'bike' | 'scooter' | 'loco' | 'ferry' | 'seat';

/** The ids of the passenger seats in sim/rail.ts and sim/ferry.ts (their Seat classes), and of the locomotive's cab. */
const RAIL_SEAT = 9700, FERRY_SEAT = 9701, TRAIN_CAB = 9500;

const CAR_KINDS: readonly VehicleKind[] = ['sedan', 'hatch', 'coupe', 'muscle', 'sports', 'taxi', 'cruiser', 'bolt', 'cmax'];
const TRUCK_KINDS: readonly VehicleKind[] = ['pickup', 'van', 'tow'];

/** Where the camera sits and faces this frame, for the rig. */
export interface Eye {
  x: number; y: number; z: number;
  /** The body's heading, and how far the view starts turned from straight ahead (a window seat looks sideways). */
  h: number; look: number;
  /** Nose up (+) and roll, as the body has them, already eased for the calmer screen; and the body's own. */
  pitch: number; roll: number; bodyPitch: number; bodyRoll: number;
  fov: number;
  /** How far the head is tipped up (+) or down (-) from level (a rider looks down at the road, over the bars). */
  tilt: number;
  /** The vehicle whose own driver must not be drawn (the eye is where the head would be). */
  v: Vehicle | null;
  rig: Rig;
}

interface Profile {
  /** The eye above the seat's cushion, and its lateral share of the seat (1 = at the driver's seat, 0 = on the middle line). */
  up: number; side: number;
  /** Wheel: radius, how far ahead and below the eye, how far its face tilts back from vertical. */
  wr: number; wz: number; wy: number; wt: number;
  /** Dash: how far ahead its far edge is, the height of its top below the eye, the lowest it can get. */
  dz: number; dy: number;
  /** Highest the roof lining is above the eye, at least. */
  roof: number;
  fov: number;
}

const PROFILES: Record<'car' | 'truck' | 'bus' | 'bike' | 'scooter', Profile> = {
  car: { up: 0.62, side: 1, wr: 0.185, wz: 0.58, wy: -0.4, wt: 0.42, dz: 1.3, dy: -0.18, roof: 0.34, fov: 72 },
  truck: { up: 0.72, side: 1, wr: 0.21, wz: 0.64, wy: -0.43, wt: 0.62, dz: 1.55, dy: -0.2, roof: 0.4, fov: 74 },
  bus: { up: 0.72, side: 1, wr: 0.25, wz: 0.74, wy: -0.5, wt: 0.95, dz: 2.0, dy: -0.24, roof: 0.6, fov: 76 },
  bike: { up: 0.76, side: 0, wr: 0, wz: 0.58, wy: -0.55, wt: 0, dz: 0, dy: 0, roof: 0, fov: 80 },
  scooter: { up: 1.5, side: 0, wr: 0, wz: 0.58, wy: -0.55, wt: 0, dz: 0, dy: 0, roof: 0, fov: 80 },
};

/**
 * The cabin of each car as tools/blender/cars.py builds it (z from mid-wheelbase, y up from the road): the cowl (where the
 * screen meets the bonnet), the belt line, how far the seat is raised (seat_e), the lowest roof, the bonnet's height at the
 * cowl and the nose. The driver's head is put where that cabin has it, whatever the car's own seat number says.
 */
const CAB: Partial<Record<VehicleKind, { cw: number; belt: number; e: number; roof: number; hc: number; nose: number }>> = {
  sedan: { cw: 0.84, belt: 0.935, e: 0, roof: 1.415, hc: 0.955, nose: 2.3 },
  hatch: { cw: 0.72, belt: 0.96, e: 0.025, roof: 1.455, hc: 0.98, nose: 1.945 },
  coupe: { cw: 0.62, belt: 0.9, e: -0.035, roof: 1.27, hc: 0.915, nose: 2.225 },
  muscle: { cw: 0.55, belt: 0.93, e: -0.005, roof: 1.3, hc: 0.95, nose: 2.4 },
  sports: { cw: 1.05, belt: 0.86, e: -0.16, roof: 1.12, hc: 0.88, nose: 2.3 },
  pickup: { cw: 1.02, belt: 1.24, e: 0.305, roof: 1.8, hc: 1.26, nose: 2.6 },
  van: { cw: 1.8, belt: 1.22, e: 0.25, roof: 2.22, hc: 1.22, nose: 2.52 },
  taxi: { cw: 0.84, belt: 0.935, e: 0, roof: 1.375, hc: 0.955, nose: 2.35 },
  tow: { cw: 1.25, belt: 1.5, e: 0.45, roof: 2.0, hc: 1.52, nose: 2.9 },
  bus: { cw: 4.88, belt: 1.4, e: 0.29, roof: 2.86, hc: 1.42, nose: 5.1 },
  cruiser: { cw: 0.84, belt: 0.935, e: 0, roof: 1.355, hc: 0.955, nose: 2.32 },
  bolt: { cw: 1.24, belt: 1.01, e: 0.075, roof: 1.5, hc: 1.085, nose: 2.14 },
  cmax: { cw: 1.18, belt: 0.95, e: 0.12, roof: 1.52, hc: 0.995, nose: 2.224 },
};

/** The driver's eye in the car's own frame (x left, y up, z forward): [x, y, z]. */
function carEye(v: Vehicle, out: number[]): void {
  const c = CAB[v.spec.kind]!;
  const sx = 0.37 * (v.spec.width / 2) / 0.917;
  out[0] = sx;
  out[1] = Math.min(1.2 + c.e, c.roof - 0.085 - 0.13);
  out[2] = c.cw - 0.98;
}
const EYE = [0, 0, 0];

// Scratch objects, made once.
const E = new THREE.Euler(0, 0, 0, 'YXZ');
const V = new THREE.Vector3();
const DOOR = { x: 0, z: 0 };
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// world/snowCover.ts would lay snow on the top of the dash: userData.noSnow, and a program key of its own, because a program
// is shared by every material with the same key and the snow term is decided when it is first built.
const dark = (c: number, extra = 0): THREE.MeshLambertMaterial => {
  const m = new THREE.MeshLambertMaterial({ color: c, emissive: extra, userData: { noSnow: true } });
  m.customProgramCacheKey = () => 'cabview-lambert';
  return m;
};
const basic = (c: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });

const MAT = {
  trim: dark(0x44464c, 0x1c1c20),
  top: dark(0x585a62, 0x26272c),
  lining: basic(0x5f5c53),
  wheel: dark(0x34353a, 0x19191c),
  metal: dark(0x70757a, 0x1c1e1f),
  desk: dark(0x3a3b3d, 0x101011),
  red: basic(0xc83a2a),
  cream: dark(0xcfc6a8, 0x28251c),
  glove: dark(0x1d2a3a, 0x080b0f),
  skin: dark(0xc99b79, 0x2a1f18),
  steel: dark(0x8b9094, 0x22282b),
};

/** A box with its middle at (x, y, z). */
function box(parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.frustumCulled = false; m.matrixAutoUpdate = true;
  parent.add(m);
  return m;
}
/** A round bar between two points. */
function bar(parent: THREE.Object3D, mat: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): THREE.Mesh {
  V.set(bx - ax, by - ay, bz - az);
  const len = V.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.quaternion.setFromUnitVectors(Y_AXIS, V.normalize());
  m.frustumCulled = false;
  parent.add(m);
  return m;
}
/** A square-section pillar between two points. */
function post(parent: THREE.Object3D, mat: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): THREE.Mesh {
  V.set(bx - ax, by - ay, bz - az);
  const len = V.length();
  const m = new THREE.Mesh(new THREE.BoxGeometry(t, len, t), mat);
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.quaternion.setFromUnitVectors(Y_AXIS, V.normalize());
  m.frustumCulled = false;
  parent.add(m);
  return m;
}

// ── Dial faces ───────────────────────────────────────────────────────────────

const faces = new Map<string, THREE.CanvasTexture>();

/** A round dial from 0 to `max` over 270 degrees: ticks, numbers every `step`, a red zone from `red` (0 for none). */
function dialFace(label: string, max: number, step: number, red: number, unit: string): THREE.CanvasTexture {
  const key = `${label}${max}${step}${red}${unit}`;
  let t = faces.get(key);
  if (t) return t;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d0f12'; g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#8b9094'; g.lineWidth = 5; g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.stroke();
  const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
  const at = (v: number): number => a0 + span * (v / max);
  if (red > 0) { g.strokeStyle = '#d0402e'; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 104, at(red), at(max)); g.stroke(); }
  g.fillStyle = '#f2ead0'; g.strokeStyle = '#f2ead0'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 26px sans-serif';
  const minor = step / 2;
  for (let v = 0; v <= max + 0.001; v += minor) {
    const a = at(v), major = Math.abs(v / step - Math.round(v / step)) < 0.01;
    const r0 = major ? 90 : 100, r1 = 114;
    g.lineWidth = major ? 4 : 2;
    g.beginPath(); g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0); g.lineTo(128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1); g.stroke();
    if (major) g.fillText(String(Math.round(v)), 128 + Math.cos(a) * 68, 128 + Math.sin(a) * 68);
  }
  g.font = '600 20px sans-serif'; g.fillStyle = '#b9b4a0';
  g.fillText(label, 128, 178); g.font = '500 16px sans-serif'; g.fillText(unit, 128, 202);
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  faces.set(key, t);
  return t;
}

/** A small readout whose text is redrawn only when it changes. */
class Readout {
  readonly tex: THREE.CanvasTexture;
  private readonly g: CanvasRenderingContext2D;
  private shown = '';
  constructor(w: number, h: number, private readonly font: string, private readonly color: string, private readonly bg: string) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    this.g = c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.set(' ');
  }
  set(s: string): void {
    if (s === this.shown) return;
    this.shown = s;
    const g = this.g, c = g.canvas;
    g.fillStyle = this.bg; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = this.color; g.font = this.font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s, c.width / 2, c.height / 2 + 2);
    this.tex.needsUpdate = true;
  }
}

/** What a built group lets the frame code move. */
interface Parts {
  root: THREE.Group;
  /** Steering wheel (spins about its own axis) or handlebar (turns about the vertical). */
  steer: THREE.Object3D | null;
  steerGain: number;
  needle: THREE.Object3D | null;
  tach: THREE.Object3D | null;
  gearOut: Readout | null;
  speedOut: Readout | null;
  /** Needle sweep: radians at full scale and the speed it is full at. */
  dialMax: number;
  /** The bonnet, in the car's own paint. */
  hood: THREE.MeshLambertMaterial | null;
  shown: number;
}

export class CabView {
  readonly eye: Eye = { x: 0, y: 0, z: 0, h: 0, look: 0, pitch: 0, roll: 0, bodyPitch: 0, bodyRoll: 0, fov: 70, tilt: 0, v: null, rig: 'car' };
  /** The vehicle the camera is in the cab of (while it is), so the occupants can leave its driver out. */
  inside: Vehicle | null = null;
  private readonly parts = new Map<string, Parts>();
  private cur: Parts | null = null;
  private curKey = '';
  private rpm = 0.14;
  private lastGear = '';
  /** The train whose locomotive is not drawn, for the cab view. */
  private shellOff: import('../world/train').Train | null = null;

  constructor(private readonly game: Game) {}

  // ── Which views a vehicle has ──

  /** The rig a vehicle has for the player to sit in (stage 1), or null. A passenger only has them on a bus, a train or a ferry. */
  rigOf(v: Vehicle | null): Rig | null {
    if (!v) return null;
    const p = this.game.player, k = v.spec.kind, id = v.id;
    if (id === RAIL_SEAT) return trains.cur && trains.cur.kind === 'passenger' ? 'loco' : null;
    if (id === FERRY_SEAT) return this.game.ferry?.rider ? 'ferry' : null;
    if (id === TRAIN_CAB) return p.vehicle === v ? 'loco' : null;
    if (id >= 9000 && id < 9500) return null;
    if (isBoatKind(k) || k === 'train') return null;
    if (p.vehicle !== v && !(p.riding === v && k === 'bus')) return null;
    if (k === 'bike') return 'bike';
    if (k === 'scooter') return 'scooter';
    if (k === 'bus') return 'bus';
    if (TRUCK_KINDS.includes(k)) return 'truck';
    if (CAR_KINDS.includes(k)) return 'car';
    return null;
  }

  /** How many in-cab views the camera key steps through for this vehicle: 0 none, 2 for a train rider (the cab, then the window seat). */
  stages(v: Vehicle | null): number {
    if (!v) return 0;
    if (v.id === RAIL_SEAT) return this.rigOf(v) ? 2 : 0;
    return this.rigOf(v) ? 1 : 0;
  }

  /** The toast that names stage `s` of v's views. */
  name(v: Vehicle, s: number): string {
    const r = this.rigOf(v);
    if (v.id === RAIL_SEAT) return s === 1 ? 'Driver\'s cab' : 'Window seat';
    if (r === 'ferry') return 'Ferry helm';
    if (r === 'loco') return 'Driver\'s cab';
    if (r === 'bus') return 'Windscreen view';
    if (r === 'bike' || r === 'scooter') return 'Handlebar view';
    return 'Dashboard view';
  }

  // ── The eye ──

  /**
   * Work out where the eye is, in `this.eye`, for stage s of v. False if there is nothing to look from (the train went away).
   * Roll and pitch are the body's; the calmer screen takes most of them out.
   */
  place(v: Vehicle, s: number, dt: number): boolean {
    const e = this.eye, rig = s === 2 && v.id === RAIL_SEAT ? 'seat' : this.rigOf(v);
    if (!rig) return false;
    const calm = ACC.calm ? 0.3 : 1;
    let x = v.x, y = v.y, z = v.z, h = v.h, pitch = v.pitch, roll = v.roll, lx = 0, ly = 0, lz = 0, look = 0, fov = 72;
    const live = v as unknown as { pitchV?: number; rollV?: number };
    pitch += live.pitchV ?? 0; roll += live.rollV ?? 0;
    if (rig === 'loco') {
      const T = trains.cur;
      if (v.id === RAIL_SEAT) {
        if (!T) return false;
        const c = T.cab; x = c.x; y = c.y; z = c.z; h = c.h; pitch = c.pitch; roll = c.roll;
      }
      // The engineer's seat behind the front windows, on the right, up where the glass is.
      lx = -0.7; ly = 3.95; lz = 3.9; fov = 70;
    } else if (rig === 'seat') {
      // Coach: the seat's own place, looking out of the window on its side.
      const R = this.game.rail.rider, T = trains.cur;
      if (!R || !T) return false;
      const b = T.coach(R.coach);
      if (!b) return false;
      x = b.x; y = b.y; z = b.z; h = b.h; pitch = b.pitch; roll = b.roll;
      const st = COACH_SEATS[R.seat];
      lx = st[0]; lz = st[1]; ly = COACH_CUSHION + 0.74; fov = 68;
      look = (st[0] >= 0 ? 1 : -1) * 1.15;
    } else if (rig === 'ferry') {
      const R = this.game.ferry.rider, f = R ? this.game.ferry.ferries[R.ferry] : null;
      if (!f) return false;
      x = f.x; y = f.y; z = f.z; h = f.h; pitch = f.pitch; roll = f.roll;
      lx = 0.5; ly = DECK + 1.42; lz = 3.0; fov = 70;
    } else {
      const P = PROFILES[rig];
      if (CAB[v.spec.kind]) {
        carEye(v, EYE);
        lx = EYE[0]; ly = EYE[1]; lz = EYE[2];
      } else {
        // A cycle: level with the driver's door, as ent/occupants.ts has the rider, on the saddle or the deck.
        v.doorPos(1, DOOR);
        const sn = Math.sin(v.h), cs = Math.cos(v.h);
        lz = (DOOR.x - v.x) * sn + (DOOR.z - v.z) * cs - (SEAT_BACK[v.spec.kind] ?? 0);
        lx = P.side * (v.seatX ?? 0.37);
        ly = CUSHION[v.spec.kind] + P.up;
      }
      fov = P.fov;
    }
    // The body's tilt, eased for a calm screen; the eye goes where that tilt puts it.
    E.set(-pitch * calm, h, roll * calm, 'YXZ');
    V.set(lx, ly, lz).applyEuler(E);
    e.x = x + V.x; e.y = y + V.y; e.z = z + V.z;
    e.h = h; e.look = look; e.pitch = pitch * calm; e.roll = roll * calm; e.bodyPitch = pitch; e.bodyRoll = roll; e.fov = fov; e.tilt = rig === 'scooter' ? -0.22 : rig === 'bike' ? -0.17 : 0; e.v = v; e.rig = rig;
    this.rpmFrame(v, dt);
    // The locomotive's shell is solid, windows painted on: it is not drawn while the camera is in its cab.
    const shell = rig === 'loco' && trains.cur;
    if (shell !== this.shellOff) { if (this.shellOff) this.shellOff.cabHide(false); this.shellOff = shell || null; if (shell) shell.cabHide(true); }
    return true;
  }

  private rpmFrame(v: Vehicle, dt: number): void {
    const sp = Math.abs(v.speed), top = Math.max(v.spec.topSpeed, 5);
    const f = clamp01(sp / top), n = 5;
    const g = Math.min(n, 1 + Math.floor(f * n * 0.999));
    const u = f * n - (g - 1);
    const want = (g === 1 ? 0.14 + 0.5 * clamp01(u) : 0.3 + 0.38 * clamp01(u)) + Math.max(0, v.ctl.accel) * 0.07 * (sp < top * 0.05 ? 3 : 1);
    this.rpm = damp(this.rpm, clamp(want, 0.12, 0.98), 9, dt);
    this.lastGear = v.speed < -0.6 ? 'R' : sp < 0.4 && v.ctl.accel <= 0.05 ? 'P' : String(g);
  }

  // ── The interior ──

  /** Show the interior for this frame's eye, moved to it and turned with the body; builds it the first time. */
  show(v: Vehicle): void {
    const e = this.eye;
    const key = e.rig === 'car' || e.rig === 'truck' || e.rig === 'bus' ? `${e.rig}:${v.spec.kind}` : e.rig;
    if (key !== this.curKey) {
      if (this.cur) this.cur.root.visible = false;
      this.curKey = key;
      this.cur = e.rig === 'seat' ? null : this.parts.get(key) ?? this.build(key, e.rig, v);
      if (this.cur) this.cur.root.visible = true;
    }
    const c = this.cur;
    if (!c) return;
    const r = c.root;
    r.position.set(e.x, e.y, e.z);
    // The group turns with the body in full (the camera follows only part of it, which is what makes the dash sway).
    const k = ACC.calm ? 0.3 : 1;
    E.set(-e.bodyPitch * k, e.h, e.bodyRoll * k, 'YXZ');
    r.quaternion.setFromEuler(E);
    this.dials(c, v);
  }

  /** Turn the interior off or on (the camera rig does while a replay has the lens). */
  setVisible(on: boolean): void { if (this.cur) this.cur.root.visible = on; }

  hide(): void {
    if (this.shellOff) { this.shellOff.cabHide(false); this.shellOff = null; }
    if (this.inside) (this.inside as unknown as { cab?: boolean }).cab = false;
    if (this.cur) this.cur.root.visible = false;
    this.curKey = '';
    this.cur = null;
    this.inside = null;
  }

  private dials(c: Parts, v: Vehicle): void {
    const sp = v.speed;
    const steer = (v as unknown as { steerPos?: number }).steerPos ?? v.ctl.steer;
    if (c.steer) {
      if (c.steerGain > 0) c.steer.rotation.z = -clamp(steer, -1, 1) * c.steerGain;
      else c.steer.rotation.y = clamp(steer, -1, 1) * c.steerGain;
    }
    const mph = Math.abs(sp) * MPH;
    if (c.needle) c.needle.rotation.z = -clamp01(mph / c.dialMax) * Math.PI * 1.5;
    if (c.tach) c.tach.rotation.z = -clamp01(this.rpm) * Math.PI * 1.5;
    if (c.hood && c.shown !== v.color) { c.shown = v.color; c.hood.color.setHex(v.color).multiplyScalar(0.82); }
    if (c.gearOut) c.gearOut.set(this.lastGear);
    if (c.speedOut) c.speedOut.set(String(Math.round(mph)));
  }

  // ── Building ──

  private build(key: string, rig: Rig, v: Vehicle): Parts {
    const root = new THREE.Group();
    root.frustumCulled = false;
    root.renderOrder = 5;
    const parts: Parts = { root, steer: null, steerGain: 1.6, needle: null, tach: null, gearOut: null, speedOut: null, dialMax: 120, hood: null, shown: -1 };
    if (rig === 'car' || rig === 'truck' || rig === 'bus') this.buildDash(parts, rig, v);
    else if (rig === 'bike' || rig === 'scooter') this.buildBars(parts, rig);
    else if (rig === 'loco') this.buildCab(parts);
    else if (rig === 'ferry') this.buildHelm(parts);
    root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.layers.set(0); });
    root.visible = false;
    this.game.scene.add(root);
    this.parts.set(key, parts);
    return parts;
  }

  private dial(parts: Parts, x: number, y: number, z: number, d: number, face: THREE.CanvasTexture, tilt: number): THREE.Object3D {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.rotation.set(tilt, Math.PI, 0);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(d / 2, 32), new THREE.MeshBasicMaterial({ map: face }));
    disc.frustumCulled = false;
    pivot.add(disc);
    // The needle: a thin red wedge in a group that turns about the dial's centre (rotation.z).
    const needle = new THREE.Group();
    needle.rotation.z = 0;
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(d * 0.03, d * 0.4), MAT.red);
    blade.position.set(0, d * 0.2, 0.002); blade.frustumCulled = false;
    // Start at the lower left (225 degrees): the blade, drawn pointing up, is turned a quarter and a half to point there.
    const arm = new THREE.Group();
    arm.rotation.z = Math.PI * 0.75;
    arm.add(blade);
    const hub = new THREE.Mesh(new THREE.CircleGeometry(d * 0.045, 12), MAT.metal);
    hub.position.z = 0.003; hub.frustumCulled = false;
    needle.add(arm); needle.add(hub);
    pivot.add(needle);
    parts.root.add(pivot);
    return needle;
  }

  private buildDash(parts: Parts, rig: 'car' | 'truck' | 'bus', v: Vehicle): void {
    const P0 = PROFILES[rig], r = parts.root;
    const cab = CAB[v.spec.kind]!;
    carEye(v, EYE);
    const sx = EYE[0];                                // the driver's offset from the middle line (+ left)
    const half = v.spec.width / 2 - 0.05;
    const mid = -sx;                                  // the middle line, seen from the eye
    // The cabin as the model has it: the dash top at its belt line, the roof lining over the head, the screen's foot at the cowl.
    const dy = clamp(cab.belt + 0.035 - EYE[1], -0.32, -0.1);
    const P: Profile = { ...P0, dy, wy: dy - 0.2 - (rig === 'car' ? 0 : 0.03) };
    const gap = clamp(cab.roof - 0.085 - EYE[1], 0.22, 1.4);
    // The top of the windscreen: about 26 degrees up.
    const zh = clamp(gap / Math.tan(0.45), 0.55, 2.4);
    const dz = Math.max(cab.cw - EYE[2] + 0.1, P.wz + 0.5);
    const wide = half * 2;

    // Dash: a block across the car whose top is level with the cowl; a hump in front of the driver carries the dials.
    const z0 = P.wz + 0.16;
    box(r, MAT.top, mid, P.dy - 0.2, (z0 + dz) / 2, wide - 0.1, 0.4, dz - z0);
    // The top face sloping a little toward the glass, and a pale seam where the glovebox lid is.
    const slope = box(r, MAT.trim, mid, P.dy + 0.002, (z0 + dz) / 2, wide - 0.12, 0.012, dz - z0 - 0.04);
    slope.rotation.x = -0.04;
    box(r, MAT.lining, mid - wide * 0.22, P.dy - 0.25, z0 - 0.002, wide * 0.36, 0.006, 0.004);
    // The bonnet beyond the windscreen's foot, in the car's paint (set every frame by dials()), with the cowl strip before it.
    const hm = dark(0x888888, 0x151515);
    parts.hood = hm;
    // (No longer than the car is: against a wall, the bonnet must not poke through it.)
    v.doorPos(1, DOOR);
    
    const hl = clamp(cab.nose - cab.cw - 0.3, 0.3, 2.2);
    const bonnet = box(r, hm, mid, cab.hc - EYE[1] - 0.02, dz + 0.1 + hl / 2, wide * 0.86, 0.02, hl);
    bonnet.rotation.x = 0.06;
    box(r, MAT.trim, mid, P.dy - 0.005, dz + 0.04, wide - 0.12, 0.03, 0.14);
    // The instrument hump and its hood, standing up out of the dash in front of the driver.
    const cz = z0 + 0.14;
    const hood = box(r, MAT.trim, 0, P.dy + 0.095, cz - 0.02, 0.5, 0.022, 0.3);
    hood.rotation.x = -0.05;
    for (const sd of [-1, 1]) box(r, MAT.trim, sd * 0.255, P.dy + 0.03, cz - 0.02, 0.022, 0.14, 0.3);
    // Dials on the hump's rear face, which looks at the driver.
    const d = rig === 'car' ? 0.155 : 0.17;
    const faceZ = z0 - 0.004, faceY = P.dy + 0.03;
    const maxMph = Math.max(40, Math.ceil(v.spec.topSpeed * MPH * 1.1 / 20) * 20);
    parts.dialMax = maxMph;
    parts.needle = this.dial(parts, -0.1, faceY, faceZ, d, dialFace('MPH', maxMph, maxMph > 100 ? 20 : 10, 0, ''), 0.25);
    parts.tach = this.dial(parts, 0.1, faceY, faceZ, d, dialFace('RPM x1000', 8, 1, 6.5, ''), 0.25);
    // The gear letter between and under the dials.
    const gear = new Readout(64, 64, '700 48px sans-serif', '#f2ead0', '#0d0f12');
    parts.gearOut = gear;
    const gm = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.035), new THREE.MeshBasicMaterial({ map: gear.tex }));
    gm.position.set(0, faceY, faceZ - 0.004); gm.rotation.set(0.25, Math.PI, 0); gm.frustumCulled = false;
    r.add(gm);

    // The wheel: a ring with three spokes, on a column, tilted back toward the driver; it turns about its own axis.
    const pivot = new THREE.Group();
    pivot.position.set(0, P.wy, P.wz);
    pivot.rotation.set(P.wt, Math.PI, 0);
    const turn = new THREE.Group();
    pivot.add(turn);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(P.wr, rig === 'car' ? 0.017 : 0.02, 10, 40), MAT.wheel);
    turn.add(ring);
    for (const a of [Math.PI / 2 + 0.0, Math.PI * 1.17, -Math.PI * 0.17]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, P.wr * 0.92, 0.012), MAT.wheel);
      sp.position.set(Math.cos(a) * P.wr * 0.46, Math.sin(a) * P.wr * 0.46, 0);
      sp.rotation.z = a - Math.PI / 2;
      turn.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.045, 18), MAT.wheel);
    hub.rotation.x = Math.PI / 2; turn.add(hub);
    // A top marker so the turn can be read.
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.026, 0.02), MAT.cream);
    mark.position.set(0, P.wr, 0); turn.add(mark);
    r.add(pivot);
    parts.steer = turn; parts.steerGain = rig === 'car' ? 1.7 : 1.5;
    // The column going down into the dash.
    bar(r, MAT.trim, 0, P.wy - 0.02, P.wz + 0.03, 0, P.dy - 0.2, dz * 0.62, 0.032);

    // Window frame: A-pillars from the dash corners up to the corners of the roof header, the header, the roof lining.
    const px0 = mid + half - 0.02, px1 = mid - half + 0.02;
    const hx0 = mid + half - 0.2, hx1 = mid - half + 0.2;
    const topY = gap;
    post(r, MAT.trim, px0, P.dy, dz, hx0, topY, zh, 0.085);
    post(r, MAT.trim, px1, P.dy, dz, hx1, topY, zh, 0.085);
    box(r, MAT.trim, mid, topY - 0.015, zh, hx0 - hx1, 0.09, 0.06);
    // The headliner: a flat panel over the front seats and a sun visor on the driver's side.
    const lining = box(r, MAT.lining, mid, topY + 0.01, zh / 2 - 0.15, wide - 0.1, 0.02, zh + 0.5);
    lining.position.y = topY + 0.01;
    // Door tops either side, at the sill: the line the side window sits on.
    const sill = P.dy + 0.0;
    box(r, MAT.trim, mid + half, sill - 0.2, 0.0, 0.1, 0.42, 1.6);
    box(r, MAT.trim, mid - half, sill - 0.2, 0.0, 0.1, 0.42, 1.6);
    // The rear-view mirror: a dark case with a pale glass on a short stem from the header.
    const mir = box(r, MAT.trim, mid + 0.04, topY - 0.15, zh - 0.1, 0.19, 0.055, 0.025);
    mir.rotation.y = 0.12;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.04), new THREE.MeshBasicMaterial({ color: 0x7f9aa8 }));
    glass.position.set(mid + 0.04, topY - 0.15, zh - 0.1 - 0.014);
    glass.rotation.y = Math.PI + 0.12; glass.frustumCulled = false;
    r.add(glass);
    bar(r, MAT.trim, mid + 0.02, topY - 0.01, zh - 0.02, mid + 0.04, topY - 0.13, zh - 0.1, 0.01);
  }

  private buildBars(parts: Parts, rig: 'bike' | 'scooter'): void {
    const P = PROFILES[rig], r = parts.root;
    const g = new THREE.Group();
    g.position.set(0, P.wy, P.wz);
    const w = rig === 'bike' ? 0.29 : 0.24;
    // The bar, grips, levers and the stem down to the fork.
    bar(g, MAT.steel, -w, 0, 0, w, 0, 0, 0.011);
    for (const s of [-1, 1]) {
      bar(g, MAT.trim, s * (w - 0.01), 0, 0.0, s * (w + 0.1), 0, 0.0, 0.017);
      // A glove on each grip, and a sleeve running back toward the shoulder.
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.055, 0.1), MAT.glove);
      hand.position.set(s * (w + 0.015), 0.012, -0.015); hand.frustumCulled = false; g.add(hand);
      const fing = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.02, 0.07), MAT.glove);
      fing.position.set(s * (w + 0.015), -0.02, 0.02); g.add(fing);
      bar(g, MAT.glove, s * (w + 0.02), 0.03, -0.07, s * (w + 0.12), 0.1, -0.55, 0.036);
    }
    for (const s of [-1, 1]) bar(g, MAT.steel, s * (w - 0.08), 0.015, 0.03, s * (w - 0.05), 0.045, 0.1, 0.007);
    bar(g, MAT.steel, 0, 0, 0, 0, rig === 'bike' ? -0.3 : -0.7, rig === 'bike' ? 0.12 : 0.08, 0.016);
    if (rig === 'bike') {
      // The front wheel's top and a mudguard, just in view below.
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.018, 8, 36), MAT.wheel);
      tyre.rotation.y = Math.PI / 2; tyre.position.set(0, -0.78, 0.5); tyre.frustumCulled = false; r.add(tyre);
    } else {
      // A little display on the stem: the speed in big figures.
      const out = new Readout(128, 64, '700 52px sans-serif', '#9be7a5', '#0b1411');
      parts.speedOut = out;
      const pan = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicMaterial({ map: out.tex }));
      pan.position.set(0, 0.034, 0.0); pan.rotation.set(0.7, Math.PI, 0); pan.frustumCulled = false; g.add(pan);
      box(g, MAT.trim, 0, 0.026, 0.014, 0.12, 0.06, 0.03).rotation.x = 0.7;
    }
    r.add(g);
    parts.steer = g; parts.steerGain = -0.5;
    parts.dialMax = 60;
  }

  private buildCab(parts: Parts): void {
    const r = parts.root;
    // The engineer sits at x = -0.7 of the cab (model), so the cab's middle line is 0.7 to the eye's left.
    const zf = 1.75, sill = -0.52, head = 0.39, roof = 0.77;
    const cx = 0.7;
    // The cab's walls: painted a dull green-cream inside, over a dark floor.
    const wall = dark(0x6b7260, 0x2b3027);
    // Front wall below and above the window, in the cab's maroon and cream, and the posts between the panes.
    box(r, wall, cx, sill - 0.5, zf, 3.0, 1.0, 0.1);
    box(r, wall, cx, (head + roof) / 2 + 0.1, zf, 3.0, roof - head + 0.2, 0.1);
    for (const px of [-0.78, 0.72, cx + 1.5 - 0.0]) box(r, wall, px, (sill + head) / 2, zf, px === 0.72 ? 0.39 : 0.25, head - sill, 0.1);
    // The short bonnet ahead (the shell itself is not drawn), in the loco's maroon with a cream band and the yellow pilot.
    const maroon = dark(0x6a1c18, 0x1f0807), cream = dark(0xd9cfaa, 0x2a2618), yellow = dark(0xd9b92a, 0x30280a);
    box(r, maroon, cx, sill + 0.3 - 1.4, zf + 1.85, 2.3, 2.1, 3.5).position.y = -0.23 - 1.05;
    box(r, cream, cx, -0.23 - 1.65, zf + 1.85, 2.34, 0.3, 3.5);
    box(r, yellow, cx, -0.23 - 2.0, zf + 3.7, 3.0, 0.5, 0.3);
    // Side walls with their windows, the roof and the floor.
    for (const s of [-1, 1]) {
      const x = cx + s * 1.5;
      box(r, wall, x, sill - 0.55, 0.3, 0.1, 1.1, 3.6);
      box(r, wall, x, (head + roof) / 2 + 0.1, 0.3, 0.1, roof - head + 0.2, 3.6);
      for (const z of [-1.2, 0.2, 1.7]) box(r, wall, x, (sill + head) / 2, z, 0.1, head - sill, 0.2);
    }
    box(r, MAT.lining, cx, roof + 0.05, 0.3, 3.0, 0.08, 3.6);
    box(r, MAT.desk, cx, -1.7, 0.3, 3.0, 0.1, 3.6);
    // The desk: a slab under the glass with the controls stand in front of the engineer.
    box(r, MAT.desk, cx, sill - 0.04, 1.3, 2.9, 0.07, 0.95);
    const stand = box(r, MAT.trim, 0, sill + 0.02, 1.0, 0.56, 0.1, 0.5);
    stand.rotation.x = 0;
    // Throttle and brake handles on the stand, a horn pull, and two gauges on a panel tipped toward the eye.
    bar(r, MAT.metal, -0.1, sill + 0.06, 0.95, -0.1, sill + 0.24, 1.0, 0.014);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), MAT.red); knob.position.set(-0.1, sill + 0.255, 1.01); r.add(knob);
    bar(r, MAT.metal, 0.12, sill + 0.06, 0.95, 0.12, sill + 0.2, 0.9, 0.012);
    const kn2 = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), MAT.cream); kn2.position.set(0.12, sill + 0.21, 0.895); r.add(kn2);
    const maxMph = 70;
    parts.dialMax = maxMph;
    parts.needle = this.dial(parts, -0.01, sill + 0.17, 1.22, 0.2, dialFace('MPH', maxMph, 10, 0, ''), 0.5);
    parts.tach = this.dial(parts, 0.27, sill + 0.17, 1.24, 0.17, dialFace('AIR', 8, 1, 6.5, ''), 0.5);
    box(r, MAT.trim, 0.12, sill + 0.13, 1.28, 0.62, 0.2, 0.04).rotation.x = 0.5;
    parts.steer = null;
  }

  private buildHelm(parts: Parts): void {
    const r = parts.root;
    // The Shuttle's wheelhouse from the helm: sill at the console, header, the centre post and the corner posts.
    const zf = 1.1, sill = -0.4, head = 0.5, roof = 0.62;
    const ex = 0.5;                                       // the eye is this far left of the boat's middle line
    box(r, MAT.cream, -ex, sill - 0.8, zf, 2.84, 1.6, 0.08);
    box(r, MAT.cream, -ex, (head + roof) / 2 + 0.05, zf, 2.84, roof - head + 0.1, 0.08);
    for (const px of [1.3 - ex, -ex, -1.3 - ex]) box(r, MAT.cream, px, (sill + head) / 2, zf, px === -ex ? 0.1 : 0.14, head - sill, 0.1);
    for (const s of [-1, 1]) {
      const x = s * 1.38 - ex;
      box(r, MAT.cream, x, sill - 0.9, 0.0, 0.08, 1.8, 3.4);
      box(r, MAT.cream, x, (head + roof) / 2 + 0.05, 0.0, 0.08, roof - head + 0.1, 3.4);
    }
    box(r, MAT.lining, -ex, roof + 0.06, 0.0, 2.8, 0.1, 3.4);
    // The console and the wheel stand are in the boat model; here the helm wheel itself.
    const turn = new THREE.Group();
    const piv = new THREE.Group(); piv.position.set(0, sill - 0.12, 0.7); piv.rotation.set(0.9, Math.PI, 0); piv.add(turn);
    turn.add(new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.016, 8, 32), MAT.wheel));
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 4;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.34, 0.012), MAT.wheel); sp.rotation.z = a; turn.add(sp);
    }
    r.add(piv);
    parts.steer = null;
  }
}
