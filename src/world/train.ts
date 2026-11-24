// A train on the tracks (fun queue item 18, with the owner's "It should drive").
//
// The Tepid Falls & Budget Gap ("the Budget Line") runs one train on the mainland's railway (mainland.ts RAIL): a
// freight (road switcher, boxcars, tank cars, flats of pulpwood and lumber, a caboose) most of the day, and once a day a
// short passenger run that stops at the depot. The new streets also get a short spur on the far bank, curving north
// off the main line east of the trestle to a pulpwood landing (the only real curve on the line, and the place to
// derail). ?streets=old runs the same train on the old line, with no spur and no gates (ground.ts draws its crossbucks).
//
// Schedule: where the train is is a pure function of the town clock (sky.hour, which a shared town takes from its
// host) and the date, so every screen shows it in the same place with no messages. The day is cut into four runs of
// six game hours (six real minutes at the default rate): dwell at the west end, run east (the passenger train stops at
// the depot), dwell at the east end, run back. A seeded pick says which run is the passenger train. The consist is only
// swapped while the train stands at the west end and nobody is near it.
//
// Rail motion: the track is a sampled path (1 m steps, height and heading at each); every car stands on two trucks at
// its truck centres, the body on the chord between them, the trucks turned to the rail under them. Couplers carry a
// little slack that runs in and out with acceleration. Headlight and ditch lights (glow sprites, no real lights), a
// five-chime horn blown long-long-short-long for every crossing, wheel clack over the joints, a diesel rumble.
//
// Crossings (new streets): wherever a street of the street graph crosses the line, flashing lights and a gate arm on
// the right of each approach. They come on when the train is near (or standing on the crossing) and drop the arm; while
// they are down, traffic is handed a stop (a row of standing "pedestrians" in the approach lanes, as world/moose.ts does
// it; traffic.ts is not edited). Bells ring at each active crossing.
//
// Solid: cars in its way are thrown aside (damage, spin, impact event); people are run down as ragdolls through the
// walkers' own code (the train's cars are handed to sim/peds.ts as moving vehicles); the player on foot is knocked
// down. In kid mode (core/kid.ts) it passes through people instead.
//
// Riding: F beside the caboose's platform or a loaded flat rides along (Player.ride); F again gets off.
// Driving: F at the locomotive's cab takes the throttle (W/S forward and back, Space brake, H horn, A/D line the spur
// switch ahead). It stays on the rails with real weight (slow to start, long to stop). Taken through the spur's curve
// (or into a buffer stop) far too fast it derails: every car becomes a free body chained to its neighbours, sliding,
// slewing and tipping over. Survivable. When the driver leaves, the train waits; once nobody is near it, the scheduled
// train takes over again. In a shared town the locomotive is sent as the driver's vehicle (kind 'train', like a car);
// other screens move their own consist to it (net/remote.ts calls trainRemote()).
//
// Model: public/models/train.glb from tools/blender/train.py (each kind at three levels of detail, the truck at two).
// Stand-in boxes until it loads. No per-frame instance buffers: every car is its own object, moved by its transform.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Game } from '../core/game';
import type { Vehicle, VehicleControls, WorldPart } from '../core/api';
import type { RoadPed } from '../sim/traffic';
import type { Mover } from '../sim/peds';
import { assets } from '../core/assets';
import { kid } from '../core/kid';
import { groundAt } from './plan';
import { MAIN_Y, RAIL, RAIL_TRESTLE } from './mainland';
import { STREETS_NEW } from './streets';
import { SPECS, type VehicleSpec } from '../ent/vehicleSpecs';
import { bellStroke, clack, dieselGrain, grind, hornNote, hornPattern } from '../audio/train';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

// ── The line ──────────────────────────────────────────────────────────────────

const X0 = RAIL.x0, X1 = RAIL.x1, RZ = RAIL.z;
/** The spur (new streets): leaves the main line here, curves north on this radius, ends at this z. */
const SW_X = 470, SPUR_R = 60, SPUR_END_Z = -2430;
const SPUR = STREETS_NEW;
const DEPOT_X = STREETS_NEW ? 167 : 107;
/** Where the train stands at each end: the tail clear of the last crossing in the west, the head short of one in the east. */
const WEST_TAIL_X = STREETS_NEW ? -575 : X0 + 8;
const EAST_HEAD_X = STREETS_NEW ? 610 : X1 - 8;

interface Path { n: number; x: Float32Array; z: Float32Array; y: Float32Array; h: Float32Array; k: Float32Array; len: number }
interface Crossing { x: number; z: number; s: number; hw: number; dx: number; dz: number; name: string; on: boolean; t: number; arm: number; horned: boolean; bellT: number; lamps: THREE.Mesh[]; arms: THREE.Object3D[]; peds: RoadPed[] }

/** Height of the rail's top: the trestle's deck, flush with a street at a crossing, else on its ballast. */
function railY(x: number, z: number, cross: readonly Crossing[]): number {
  if (x > RAIL_TRESTLE.x0 && x < RAIL_TRESTLE.x1 && Math.abs(z - RZ) < 3) return MAIN_Y + 0.15;
  const g = groundAt(x, z);
  for (const c of cross) if (Math.abs(x - c.x) < c.hw + 3 && Math.abs(z - c.z) < 4) return g + 0.0;
  return g + 0.21;
}

function makePath(pts: number[], cross: readonly Crossing[]): Path {
  const n = pts.length / 2, P: Path = { n, x: new Float32Array(n), z: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n), k: new Float32Array(n), len: n - 1 };
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) { P.x[i] = pts[2 * i]; P.z[i] = pts[2 * i + 1]; raw[i] = railY(P.x[i], P.z[i], cross); }
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = -5; j <= 5; j++) { const q = clamp(i + j, 0, n - 1); s += raw[q]; w++; }
    P.y[i] = s / w;
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    P.h[i] = Math.atan2(P.x[b] - P.x[a], P.z[b] - P.z[a]);
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    let d = P.h[b] - P.h[a];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    P.k[i] = d / Math.max(1, b - a);
  }
  return P;
}

interface PP { x: number; y: number; z: number; h: number; k: number }
function at(P: Path, s: number, o: PP): PP {
  const f0 = clamp(s, 0, P.len - 1e-3), i = Math.floor(f0), f = f0 - i, j = Math.min(i + 1, P.n - 1);
  o.x = P.x[i] + (P.x[j] - P.x[i]) * f; o.z = P.z[i] + (P.z[j] - P.z[i]) * f; o.y = P.y[i] + (P.y[j] - P.y[i]) * f;
  let d = P.h[j] - P.h[i]; d = Math.atan2(Math.sin(d), Math.cos(d));
  o.h = P.h[i] + d * f; o.k = P.k[i];
  // Past either end: straight on along the last heading (a derailed or overrun car is free anyway).
  if (s < 0) { o.x += Math.sin(o.h) * s; o.z += Math.cos(o.h) * s; }
  else if (s > P.len) { const e = s - P.len; o.x += Math.sin(o.h) * e; o.z += Math.cos(o.h) * e; }
  return o;
}

// ── Cars ──────────────────────────────────────────────────────────────────────

type Kind = 'loco' | 'boxcar' | 'tank' | 'flat' | 'caboose' | 'coach';
interface CarSpec { hc: number; tb: number; top: number; tint: number; ride?: { along: number; y: number; what: string }[] }
/** Half length over the couplers, truck centres from the middle, roof height; tools/blender/train.py's numbers. */
const CARS: Record<Kind, CarSpec> = {
  loco: { hc: 10.2, tb: 6.8, top: 4.9, tint: 0x5c1212 },
  boxcar: { hc: 8.2, tb: 5.6, top: 4.8, tint: 0x6b2617 },
  tank: { hc: 7.5, tb: 4.9, top: 4.2, tint: 0x111112 },
  flat: { hc: 8.2, tb: 5.6, top: 1.4, tint: 0x3a3c3e },
  caboose: { hc: 6.1, tb: 3.4, top: 5.5, tint: 0x99190f, ride: [{ along: -4.85, y: 1.38, what: 'the caboose' }, { along: 4.85, y: 1.38, what: 'the caboose' }] },
  coach: { hc: 10.9, tb: 7.6, top: 5.0, tint: 0x21452b },
};
type Load = '' | 'logs' | 'lumber';
const LOAD_TOP: Record<Load, number> = { '': 1.4, logs: 2.45, lumber: 3.5 };

const FREIGHT: [Kind, Load][] = [['loco', ''], ['boxcar', ''], ['tank', ''], ['flat', 'logs'], ['boxcar', ''], ['flat', 'lumber'], ['tank', ''], ['flat', 'logs'], ['boxcar', ''], ['caboose', '']];
const PASSENGER: [Kind, Load][] = [['loco', ''], ['coach', ''], ['coach', '']];

/** A car's body as the walkers (sim/peds.ts) and the ride code see it: enough of a Vehicle. */
class Body {
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0;
  vx = 0; vy = 0; vz = 0; yawRate = 0;
  hl: number; readonly hw = 1.55;
  driver: 'ai' = 'ai';
  get speed(): number { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }
  constructor(hl: number) { this.hl = hl; }
}

interface Car {
  kind: Kind; load: Load; spec: CarSpec;
  obj: THREE.Group; body: THREE.Object3D; trucks: THREE.Object3D[];
  /** Middle of the car along the path (on the rails). */
  s: number; slack: number;
  b: Body;
  // Free body (derailed).
  rr: number; pr: number; joint: number;
}

/** A seat on the train for Player.ride: where the sitter stands, moved with the car every frame. */
class Perch implements Partial<Vehicle> {
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0; vx = 0; vy = 0; vz = 0; yawRate = 0;
  readonly hl = 0.6; readonly hw = 0.6; readonly id = 9600;
  readonly spec: VehicleSpec = SPECS.train;
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null; color = 0; health = 100; onGround = true; airTime = 0; slip = 0; lights = false; sunk = false; held = true;
  get speed(): number { return Math.hypot(this.vx, this.vz); }
  doorPos(side: -1 | 1, out: { x: number; z: number }): void {
    const off = -side * 2.4;
    out.x = this.x + Math.cos(this.h) * off; out.z = this.z - Math.sin(this.h) * off;
  }
}

/** The locomotive's cab as a Vehicle: the player sits in it like any car (ent/player.ts), the chase camera follows it, the network sends it. */
export class TrainCab implements Vehicle {
  readonly id = 9500;
  readonly spec: VehicleSpec = SPECS.train;
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0;
  vx = 0; vy = 0; vz = 0; yawRate = 0;
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null;
  color = 0x5c1212; health = 100; onGround = true; airTime = 0; slip = 0; lights = true; sunk = false;
  held = true;
  readonly hl = 10; readonly hw = 1.55; readonly seatX = 0;
  get speed(): number { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }
  doorPos(side: -1 | 1, out: { x: number; z: number }): void {
    // At the cab's steps, a stride out from the walkway.
    const s = Math.sin(this.h), c = Math.cos(this.h), off = -side * (this.hw + 0.7), along = 4.1;
    out.x = this.x + c * off + s * along; out.z = this.z - s * off + c * along;
  }
}

type Mode = 'sched' | 'driven' | 'remote' | 'parked' | 'derail';

/** Who has the train: world/train.ts sets this; ent/player.ts and net/remote.ts ask it. */
export const trains: { cur: Train | null } = { cur: null };

/** net/remote.ts: another player is driving the train (their state frame says kind 'train'). */
export function trainRemote(id: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, speed: number): void {
  trains.cur?.remotePose(id, x, y, z, yaw, pitch, roll, speed);
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/** Game minutes per run (6 game hours); four runs a day. */
const RUN = 360;
interface Leg { t0: number; t1: number; s0: number; s1: number; vmax: number; a: number; b: number }

function legPos(L: Leg, t: number): { s: number; v: number } {
  const d = L.s1 - L.s0, D = Math.abs(d), sg = Math.sign(d) || 1;
  if (D < 1e-3) return { s: L.s0, v: 0 };
  let vm = L.vmax;
  if (vm * vm / (2 * L.a) + vm * vm / (2 * L.b) > D) vm = Math.sqrt(2 * D * L.a * L.b / (L.a + L.b));
  const tA = vm / L.a, tB = vm / L.b, dA = vm * tA / 2, dB = vm * tB / 2, tC = (D - dA - dB) / vm, T = tA + tC + tB;
  const u = clamp(t - L.t0, 0, T);
  let x: number, v: number;
  if (u < tA) { x = L.a * u * u / 2; v = L.a * u; }
  else if (u < tA + tC) { x = dA + vm * (u - tA); v = vm; }
  else { const w = T - u; x = D - L.b * w * w / 2; v = L.b * w; }
  return { s: L.s0 + sg * x, v: sg * v };
}
function legTime(D: number, vmax: number, a: number, b: number): number {
  let vm = vmax;
  if (vm * vm / (2 * a) + vm * vm / (2 * b) > D) vm = Math.sqrt(2 * D * a * b / (a + b));
  return vm / a + vm / b + (D - vm * vm / (2 * a) - vm * vm / (2 * b)) / vm;
}

/** One run of the given consist length: legs in game minutes from the start of the run. */
function plan(trainLen: number, passenger: boolean): Leg[] {
  const sW = WEST_TAIL_X - X0 + trainLen, sE = EAST_HEAD_X - X0;
  const vmax = passenger ? 15 : 12, a = passenger ? 0.5 : 0.35, b = passenger ? 0.6 : 0.45;
  const stops = passenger ? [DEPOT_X - X0 + (trainLen + CARS.loco.hc * 2) / 2] : [];
  const out: [number, number][] = [];
  const legs: { s0: number; s1: number }[] = [];
  const east = [sW, ...stops, sE], west = [sE, ...stops.slice().reverse(), sW];
  for (const seq of [east, west]) for (let i = 0; i + 1 < seq.length; i++) legs.push({ s0: seq[i], s1: seq[i + 1] });
  const DWELL_DEPOT = 30;
  let moving = 0;
  for (const l of legs) moving += legTime(Math.abs(l.s1 - l.s0), vmax, a, b);
  const depotDwell = stops.length * 2 * DWELL_DEPOT;
  const endDwell = Math.max(10, (RUN - moving - depotDwell) / 2);
  const res: Leg[] = [];
  let t = endDwell / 2;
  res.push({ t0: 0, t1: t, s0: sW, s1: sW, vmax, a, b });
  legs.forEach((l, i) => {
    const T = legTime(Math.abs(l.s1 - l.s0), vmax, a, b);
    res.push({ t0: t, t1: t + T, s0: l.s0, s1: l.s1, vmax, a, b }); t += T;
    const atEnd = Math.abs(l.s1 - sE) < 1;
    const dw = atEnd ? endDwell : Math.abs(l.s1 - sW) < 1 ? 0 : DWELL_DEPOT;
    if (dw > 0) { res.push({ t0: t, t1: t + dw, s0: l.s1, s1: l.s1, vmax, a, b }); t += dw; }
    void i;
  });
  res.push({ t0: t, t1: Math.max(RUN, t), s0: sW, s1: sW, vmax, a, b });
  void out;
  return res;
}

function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── The train ────────────────────────────────────────────────────────────────

const LIMIT_LAT = 3.0;   // m/s^2 sideways before the flanges climb the rail
const STEP = 1 / 60;

export class Train implements WorldPart {
  readonly main: Path;
  readonly spur: Path | null;
  readonly cross: Crossing[] = [];
  readonly cab = new TrainCab();
  private readonly perch = new Perch();
  private perchCar: Car | null = null; private perchAlong = 0; private perchY = 0;
  private readonly root = new THREE.Group();
  private cars: Car[] = [];
  private consist: 'freight' | 'passenger' | '' = '';
  mode: Mode = 'sched';
  /** Head of the train (front coupler of the locomotive) along the path, and speed along it (+ = toward the far end). */
  s = 0; v = 0;
  pathId = 0;
  /** Spur switch: false = main, true = spur. Only the driver throws it. */
  switchSpur = false;
  private acc = 0;
  private lastV = 0;
  private parkedT = 0;
  private remote: { id: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number; speed: number; t: number } | null = null;
  private named: Map<string, THREE.Object3D> | null = null;
  private readonly low: boolean;
  private readonly pp: PP = { x: 0, y: 0, z: 0, h: 0, k: 0 };
  private readonly pq: PP = { x: 0, y: 0, z: 0, h: 0, k: 0 };
  private readonly movers: Mover[] = [];
  private readonly mergedM: Mover[] = [];
  private readonly mergedP: RoadPed[] = [];
  private readonly stopPeds: RoadPed[] = [];
  private patched = false;
  private readonly lampOn: THREE.MeshBasicMaterial; private readonly lampOff: THREE.MeshBasicMaterial;
  private lampMats: THREE.MeshBasicMaterial[] = [];
  private readonly glow: THREE.Sprite[] = [];
  private night = 0;
  private hitCool = new WeakMap<object, number>();
  private hornStop: ((at: number) => void) | null = null;
  private grainT = 0; private hornLeadT = 0;
  private promptOn = false; private promptT = 0;
  private settleT = 0;
  readonly stats = { hits: 0, peds: 0, derails: 0, loaded: false, horns: 0 };

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.low = game.quality.name === 'low';
    trains.cur = this;
    // Crossings first: the rail's height at each depends on them.
    if (STREETS_NEW) this.findCrossings();
    const mp: number[] = [];
    for (let x = X0; x <= X1 + 1e-6; x += 1) mp.push(x, RZ);
    this.main = makePath(mp, this.cross);
    if (SPUR) {
      const sp: number[] = [];
      for (let x = X0; x <= SW_X + 1e-6; x += 1) sp.push(x, RZ);
      const steps = Math.floor((Math.PI / 2) * SPUR_R);
      for (let j = 1; j <= steps; j++) { const th = j / SPUR_R; sp.push(SW_X + SPUR_R * Math.sin(th), RZ - SPUR_R + SPUR_R * Math.cos(th)); }
      const ex = SW_X + SPUR_R;
      let z = sp[sp.length - 1] - 1;
      sp.push(ex, z);
      while (z > SPUR_END_Z) { z -= 1; sp.push(ex, z); }
      this.spur = makePath(sp, this.cross);
    } else this.spur = null;
    for (const c of this.cross) c.s = c.x - X0;

    this.lampOn = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.35, 0.2), toneMapped: true });
    this.lampOff = new THREE.MeshBasicMaterial({ color: 0x2a0a08 });
    parent.add(this.root);
    this.buildTrackExtras(parent);
    if (STREETS_NEW) this.buildCrossings(parent);
    this.buildGlow();
    this.setConsist(this.wantConsist().kind);
    this.schedule();
    this.place(0);
    void this.load();
  }

  // ── Building ──────────────────────────────────────────────────────────────

  private findCrossings(): void {
    const st = (this.game.plan as unknown as { streets?: { edges: { id: number; name: string; hw: number; deck?: boolean }[]; edgePts(e: unknown): number[] } }).streets;
    if (!st) return;
    for (const e of st.edges) {
      if (e.deck) continue;
      const p = st.edgePts(e);
      for (let k = 0; k + 3 < p.length; k += 2) {
        const az = p[k + 1], bz = p[k + 3];
        if ((az - RZ) * (bz - RZ) > 0 || az === bz) continue;
        const t = (RZ - az) / (bz - az), x = p[k] + (p[k + 2] - p[k]) * t;
        if (x < X0 + 2 || x > X1 - 2) continue;
        if (x > RAIL_TRESTLE.x0 - 2 && x < RAIL_TRESTLE.x1 + 2) continue;
        const dl = Math.hypot(p[k + 2] - p[k], bz - az) || 1;
        this.cross.push({ x, z: RZ, s: 0, hw: e.hw, dx: (p[k + 2] - p[k]) / dl, dz: (bz - az) / dl, name: e.name, on: false, t: 0, arm: 1, horned: false, bellT: 0, lamps: [], arms: [], peds: [] });
      }
    }
  }

  /** The spur's track (ties, rails, ballast), its switch stand, the buffer stop and the pulpwood landing at its end. */
  private buildTrackExtras(parent: THREE.Group): void {
    const P = this.spur;
    if (!P) return;
    const geo = new Boxes();
    const s0 = SW_X - X0 - 2;
    for (let s = s0; s < P.len - 1; s += 2) {
      const p = at(P, s + 1, this.pp), g = groundAt(p.x, p.z);
      geo.box(p.x, g + 0.03, p.z, 3.4, 0.24, 2.05, p.h, 0x7d776c);
      geo.box(p.x, p.y - 0.13, p.z, 2.5, 0.1, 0.26, p.h, 0x5a4636);
      for (const sg of [-1, 1]) {
        const ox = Math.cos(p.h) * 0.72 * sg, oz = -Math.sin(p.h) * 0.72 * sg;
        geo.box(p.x + ox, p.y - 0.04, p.z + oz, 0.08, 0.1, 2.02, p.h, 0x54585e);
      }
    }
    // Buffer stop and the landing.
    const e = at(P, P.len - 1, this.pp), g = groundAt(e.x, e.z);
    geo.box(e.x, g + 0.55, e.z - 1.5, 2.6, 1.1, 0.5, 0, 0xe4572e);
    this.game.col.addBoxC(e.x, e.z - 1.5, 2.6, 0.6, g + 1.1, g - 0.5);
    for (let i = 0; i < 4; i++) {
      const px = e.x + (i % 2 ? 9 : -9), pz = e.z + 14 + Math.floor(i / 2) * 16;
      for (let r = 0; r < 3; r++) geo.box(px, g + 0.45 + r * 0.8, pz, 3.2 - r * 0.6, 0.8, 12, 0, r % 2 ? 0x8a6a48 : 0x76583a);
      this.game.col.addBoxC(px, pz, 3.2, 12, g + 2.4, g - 0.5);
    }
    // The switch stand beside the points, its target turned to show the route.
    const w = at(this.main, SW_X - X0, this.pp), gw = groundAt(w.x, w.z + 3);
    geo.box(w.x, gw + 0.6, w.z + 2.6, 0.12, 1.2, 0.12, 0, 0x2b2d30);
    this.switchTarget = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.04), new THREE.MeshStandardMaterial({ color: 0x2e8b3a, roughness: 0.6 }));
    this.switchTarget.position.set(w.x, gw + 1.35, w.z + 2.6);
    parent.add(this.switchTarget);
    const mesh = new THREE.Mesh(geo.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  private switchTarget: THREE.Mesh | null = null;

  /** Masts, crossbucks, lamps and gate arms at every crossing. Static parts in one mesh; lamps and arms per crossing. */
  private buildCrossings(parent: THREE.Group): void {
    const geo = new Boxes(), col = this.game.col;
    const stripe = (() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 4;
      const x = c.getContext('2d')!;
      for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#f4f1ea' : '#c8211b'; x.fillRect(i * 8, 0, 8, 4); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const armMat = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 });
    const lampGeo = new THREE.CircleGeometry(0.17, 12);
    for (const c of this.cross) {
      const lampsA: THREE.BufferGeometry[] = [], lampsB: THREE.BufferGeometry[] = [];
      for (const sg of [-1, 1]) {
        // Traffic on this side of the line moves toward it along -sg * (dx, dz) (dz is never zero: no street runs along the track).
        const fdx = -sg * c.dx * Math.sign(c.dz || 1), fdz = -sg * c.dz * Math.sign(c.dz || 1);
        // fdx, fdz: heading of traffic approaching from the side where z - RZ has the sign of sg... recomputed below to be sure.
        let hx = fdx, hz = fdz;
        if (Math.sign(-hz) !== Math.sign(sg)) { hx = -hx; hz = -hz; }
        // (Traffic north of the line, sg = -1, heads south: +z. South of it, sg = +1, heads north: -z.)
        const along = Math.min(14, 5.6 / Math.max(0.3, Math.abs(hz)));
        const rx = -hz, rz = hx;           // its right
        const bx = c.x - hx * along, bz = c.z - hz * along;   // point on the road centre before the line
        const mx = bx + rx * (c.hw + 1.3), mz = bz + rz * (c.hw + 1.3), g = groundAt(mx, mz);
        const face = Math.atan2(-hx, -hz);  // the mast's face looks at the traffic
        geo.box(mx, g + 2.1, mz, 0.16, 4.2, 0.16, 0, 0xd8d8d2);
        geo.box(mx, g + 0.25, mz, 0.6, 0.5, 0.6, 0, 0x8c8c86);
        // Crossbuck: two crossed boards facing the traffic.
        for (const r of [Math.PI / 4, -Math.PI / 4]) geo.boxR(mx - hx * 0.1, g + 3.85, mz - hz * 0.1, 1.5, 0.22, 0.04, face, r, 0xf2efe6);
        // Lamp cross-arm, hoods, the bell, the gate's counterweight box.
        geo.boxR(mx - hx * 0.12, g + 3.0, mz - hz * 0.12, 1.3, 0.12, 0.08, face, 0, 0x1a1a1a);
        for (const o of [-0.5, 0.5]) geo.boxR(mx - hx * 0.15 + rx * o * Math.sign(1), g + 3.0, mz - hz * 0.15 + rz * o, 0.5, 0.5, 0.06, face, 0, 0x101010);
        geo.box(mx, g + 4.35, mz, 0.3, 0.2, 0.3, 0, 0x202020);
        geo.box(mx + hx * 0.4, g + 1.1, mz + hz * 0.4, 0.5, 1.4, 0.5, 0, 0x2a2a2a);
        for (let i = 0; i < 2; i++) {
          const lg = lampGeo.clone();
          lg.rotateY(face); lg.translate(mx - hx * 0.19 + rx * (i ? 0.5 : -0.5), g + 3.0, mz - hz * 0.19 + rz * (i ? 0.5 : -0.5));
          (i ? lampsB : lampsA).push(lg);
        }
        col.addProp(mx, mz, 0.16, g + 4.2, 'post', true);
        // Gate arm: pivots at the mast, reaches over the approach lanes.
        const pivot = new THREE.Group();
        pivot.position.set(mx + hx * 0.4, g + 1.15, mz + hz * 0.4);
        const ax = -rx, az = -rz;
        pivot.rotation.y = Math.atan2(-az, ax);
        const lift = new THREE.Group(); pivot.add(lift);
        const L = c.hw + 0.9;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(L, 0.13, 0.1), armMat);
        arm.position.x = L / 2 + 0.2;
        lift.add(arm);
        parent.add(pivot);
        c.arms.push(lift);
        // Where traffic waits while the arm is down: the approach lanes, short of the arm.
        for (const f of c.hw > 8 ? [0.3, 0.72] : [0.45]) c.peds.push({ x: bx - hx * 2.5 + rx * c.hw * f, z: bz - hz * 2.5 + rz * c.hw * f, vx: 0, vz: 0 });
      }
      for (const set of [lampsA, lampsB]) {
        const m = new THREE.Mesh(merge(set), this.lampOff);
        parent.add(m); c.lamps.push(m);
      }
    }
    const mesh = new THREE.Mesh(geo.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
    mesh.castShadow = !this.low;
    parent.add(mesh);
  }

  private buildGlow(): void {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d')!, gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,250,235,1)'); gr.addColorStop(0.25, 'rgba(255,240,200,0.55)'); gr.addColorStop(1, 'rgba(255,230,180,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
      const sp = new THREE.Sprite(m);
      sp.renderOrder = 2;
      this.root.add(sp); this.glow.push(sp);
    }
  }

  private setConsist(kind: 'freight' | 'passenger'): void {
    if (kind === this.consist) return;
    this.consist = kind;
    for (const c of this.cars) this.root.remove(c.obj);
    const list = kind === 'freight' ? FREIGHT : PASSENGER;
    this.cars = list.map(([k, load]) => {
      const spec = CARS[k], obj = new THREE.Group(), body = new THREE.Group();
      obj.add(body);
      const trucks = [new THREE.Group(), new THREE.Group()];
      for (const t of trucks) obj.add(t);
      const car: Car = { kind: k, load, spec, obj, body, trucks, s: 0, slack: 0, b: new Body(spec.hc - 0.4), rr: 0, pr: 0, joint: 0 };
      this.dress(car);
      this.root.add(obj);
      return car;
    });
  }

  /** Stand-ins, or the Blender model once it is in. */
  private dress(c: Car): void {
    c.body.clear(); for (const t of c.trucks) t.clear();
    const N = this.named;
    if (!N) {
      const top = LOAD_TOP[c.load] > c.spec.top ? LOAD_TOP[c.load] : c.spec.top;
      const m = new THREE.Mesh(new THREE.BoxGeometry(3, top - 1, c.spec.hc * 2 - 0.8), new THREE.MeshStandardMaterial({ color: c.spec.tint, roughness: 0.7 }));
      m.position.y = (top + 1) / 2;
      c.body.add(m);
      return;
    }
    const lod = (name: string, d: number[], into: THREE.Object3D): void => {
      const L = new THREE.LOD();
      d.forEach((dist, i) => {
        const src = N.get(`${name}_LOD${i}`);
        if (src && dist >= 0) L.addLevel(src.clone(), dist);
      });
      into.add(L);
    };
    const dists = this.low ? [-1, 0, 110] : [0, 75, 230];
    lod(c.kind, dists, c.body);
    if (c.load) {
      const g = new THREE.Group(); g.position.y = 1.29; c.body.add(g);
      lod(c.load, this.low ? [-1, 0] : [0, 70], g);
    }
    for (const t of c.trucks) {
      const L = new THREE.LOD();
      const t0 = N.get('truck_LOD0'), t1 = N.get('truck_LOD1');
      if (t0 && !this.low) L.addLevel(t0.clone(), 0);
      if (t1) L.addLevel(t1.clone(), this.low ? 0 : 55);
      L.addLevel(new THREE.Object3D(), this.low ? 90 : 260);
      t.add(L);
    }
  }

  private async load(): Promise<void> {
    try {
      const buf = await assets.bytes("models/train.glb"); if (!buf) throw new Error("no train.glb");
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      const named = new Map<string, THREE.Object3D>();
      const env = (this.game.world.mats.flat as THREE.MeshStandardMaterial).envMap ?? null;
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = !this.low; m.receiveShadow = !this.low;
          const fix = (src: THREE.Material): THREE.Material => {
            const sm = src as THREE.MeshStandardMaterial;
            if (sm.name === 'lamp') {
              const lm = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.6, 1.6, 1.6) });
              lm.name = 'lamp'; this.lampMats.push(lm); return lm;
            }
            sm.vertexColors = true;
            if (sm.name === 'glass') { sm.roughness = 0.08; sm.metalness = 0.2; }
            sm.envMap = env;
            return sm;
          };
          m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material);
        }
      });
      for (const ch of gltf.scene.children) named.set(ch.name, ch);
      this.named = named;
      for (const c of this.cars) this.dress(c);
      this.stats.loaded = true;
    } catch (e) {
      console.warn('models/train.glb did not load; the train stays as stand-ins', e);
    }
  }

  // ── Schedule ──────────────────────────────────────────────────────────────

  private trainLen(): number { let L = 0; for (const c of this.cars) L += c.spec.hc * 2; return L; }

  private clock(): { run: number; u: number; day: number } {
    const m = ((this.game.sky?.hour ?? 8) * 60) % 1440;
    const d = new Date(), day = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const run = Math.floor(m / RUN);
    return { run, u: m - run * RUN, day };
  }

  private wantConsist(): { kind: 'freight' | 'passenger' } {
    const c = this.clock();
    const pick = Math.floor(hash(c.day, 77) * 4);
    return { kind: c.run === pick ? 'passenger' : 'freight' };
  }

  private plans = new Map<string, Leg[]>();
  /** The scheduled head position and speed now (m/s along the main line). */
  private schedule(): void {
    const c = this.clock(), want = this.wantConsist().kind;
    // Swap consists only while it stands at the west end with nobody near enough to see it happen.
    if (want !== this.consist) {
      const pl = this.game.player, far = !pl || (this.mode === 'sched' && this.nearest(pl.x, pl.z) > 320 && Math.hypot(pl.x - WEST_TAIL_X, pl.z - RZ) > 260);
      const atWest = c.u < 30 || c.u > RUN - 30;
      // (A screen whose clock only just synced may have the wrong consist mid-run: swapped as soon as nobody is near it.)
      if (((atWest || far) && far) || this.cars.length === 0) this.setConsist(want);
    }
    const key = this.consist, L = this.trainLen();
    let legs = this.plans.get(key);
    if (!legs) { legs = plan(L, key === 'passenger'); this.plans.set(key, legs); }
    const rate = (this.game.sky?.rate ?? 1 / 60) * 60;   // game minutes per real second
    let s = legs[0].s0, v = 0;
    for (const leg of legs) {
      if (c.u >= leg.t0 && c.u < leg.t1) { const r = legPos(leg, c.u); s = r.s; v = r.v * rate; break; }
      if (c.u >= leg.t1) s = leg.s1;
    }
    this.s = s; this.v = v; this.pathId = 0;
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game;
    if (!this.patched && g.systems.length) this.patch();
    this.night = g.sky?.night ?? 0;
    const pl = g.player;
    const driving = pl.vehicle === this.cab;
    if (driving && this.mode !== 'driven' && this.mode !== 'derail') { this.mode = 'driven'; this.cab.ctl.accel = 0; }
    const rem = this.remote && g.time - this.remote.t < 1.5 ? this.remote : null;
    if (!driving && rem && this.mode !== 'derail') this.mode = 'remote';
    if (this.mode === 'driven' && !driving) { this.mode = 'parked'; this.parkedT = 0; }
    if (this.mode === 'remote' && !rem) { this.mode = 'parked'; this.parkedT = 0; }

    this.acc = Math.min(this.acc + dt, 0.1);
    let n = 0;
    while (this.acc >= STEP && n < 6) { this.acc -= STEP; n++; this.step(STEP, rem); }
    if (this.mode === 'derail' || this.mode === 'parked') {
      // Nobody at the controls: once nobody is near it, the scheduled train takes over again.
      const near = this.nearest(pl.x, pl.z);
      const away = !driving && pl.riding !== this.perch;
      if (away) this.parkedT += dt;
      if (away && (near > 230 || (this.parkedT > 45 && near > 90))) this.rerail();
    }
    this.place(dt);
    this.crossings(dt);
    this.collide();
    this.rides(dt);
    this.drivenUi(dt, driving);
    this.sounds(dt);
  }

  private nearest(x: number, z: number): number {
    let d = Infinity;
    for (const c of this.cars) d = Math.min(d, Math.hypot(c.b.x - x, c.b.z - z));
    return d;
  }

  private rerail(): void {
    this.mode = 'sched'; this.parkedT = 0; this.switchSpur = false;
    for (const c of this.cars) { c.b.roll = c.b.pitch = 0; c.rr = c.pr = 0; c.b.vy = 0; }
    this.schedule();
  }

  private path(): Path { return this.pathId === 1 && this.spur ? this.spur : this.main; }

  private step(dt: number, rem: { x: number; z: number; speed: number; roll: number; pitch: number } | null): void {
    if (this.mode === 'sched') { this.schedule(); this.layout(dt); return; }
    if (this.mode === 'derail') { this.freeStep(dt); return; }
    if (this.mode === 'remote' && rem) {
      // Another player drives: move our consist to their locomotive's place on the rails.
      const pr = this.project(rem.x, rem.z);
      if (Math.abs(rem.roll) > 0.35 || Math.abs(rem.pitch) > 0.35 || pr.d > 3) { this.derail(); return; }
      this.pathId = pr.id;
      const target = pr.s + CARS.loco.hc;
      const err = target - this.s;
      this.v = rem.speed + clamp(err, -6, 6) * 1.5;
      if (Math.abs(err) > 40) { this.s = target; }
      else this.s += this.v * dt;
      this.layout(dt);
      return;
    }
    // Driven, or parked (brakes on).
    const c = this.cab.ctl, v = this.v, driven = this.mode === 'driven';
    const T = driven ? clamp(c.accel, -1, 1) : 0;
    const tract = T * Math.min(0.45, 6.5 / Math.max(1, Math.abs(v)));
    const brake = (!driven || c.handbrake ? 1.0 : 0) * Math.sign(v);
    const resist = (0.015 + 0.00025 * v * v) * Math.sign(v);
    let a = tract - resist;
    const nv0 = v + a * dt;
    let nv = nv0;
    if (brake !== 0) { const b = 1.0 * dt; nv = Math.abs(nv0) <= b ? 0 : nv0 - Math.sign(nv0) * b; }
    if (Math.abs(nv) < 0.02 && T === 0) nv = 0;
    a = (nv - v) / dt;
    this.v = nv;
    this.s += nv * dt;
    // Throw the switch for the route ahead while the whole train is short of the points.
    const swS = SW_X - X0;
    if (this.spur && this.s < swS) this.pathId = this.switchSpur ? 1 : 0;
    const P = this.path(), L = this.trainLen();
    // Buffer stops at the ends of the line.
    const over = this.s > P.len - 1.5 ? this.s - (P.len - 1.5) : this.s - L < 1.5 ? this.s - L - 1.5 : 0;
    if (over !== 0) {
      if (Math.abs(this.v) > 5.5) { this.derail(); return; }
      if (Math.abs(this.v) > 1) this.thud(Math.abs(this.v));
      this.s -= over; this.v = 0;
    }
    // Too fast for the curve under any car: over the rail it goes.
    for (const car of this.cars) {
      const k = Math.abs(at(P, car.s, this.pp).k);
      if (this.v * this.v * k > LIMIT_LAT) { this.derail(); return; }
    }
    void a;
    this.layout(dt);
  }

  /** Where a point is on the line: path, distance along it, and how far off it lies. */
  private project(x: number, z: number): { id: number; s: number; d: number } {
    let best = { id: 0, s: clamp(x - X0, 0, this.main.len), d: Math.abs(z - RZ) };
    const P = this.spur;
    if (P && x > SW_X - 5 && z < RZ - 2) {
      const i0 = Math.floor(SW_X - X0);
      for (let i = i0; i < P.n; i++) {
        const d = Math.hypot(P.x[i] - x, P.z[i] - z);
        if (d < best.d) best = { id: 1, s: i, d };
      }
    }
    return best;
  }

  /** Every car on the rails behind the head, with its slack. */
  private layout(dt: number): void {
    const accel = dt > 0 ? (this.v - this.lastV) / dt : 0;
    this.lastV = this.v;
    let off = 0;
    this.cars.forEach((c, j) => {
      const want = j === 0 ? 0 : clamp(-accel * 0.5, -0.12, 0.12) * j * 0.6;
      c.slack += (want - c.slack) * Math.min(1, dt * 5 / (1 + j * 0.35));
      c.s = this.s - off - c.spec.hc + c.slack;
      off += c.spec.hc * 2;
    });
  }

  // ── Derailment ────────────────────────────────────────────────────────────

  derail(): void {
    if (this.mode === 'derail') return;
    const g = this.game, P = this.path(), v = this.v;
    this.mode = 'derail'; this.parkedT = 0; this.settleT = 0;
    this.stats.derails++;
    // Start from where every car is now, moving as it was, flung to the outside of whatever curve it was on.
    this.place(0);
    this.cars.forEach((c, j) => {
      const p = at(P, c.s, this.pp), b = c.b;
      const out = -Math.sign(p.k || (j % 2 ? 1 : -1));
      const rx = Math.cos(p.h), rz = -Math.sin(p.h);   // the car's right
      const kick = Math.abs(v) * (0.2 + Math.random() * 0.25) * (Math.abs(p.k) > 0.002 ? 1 : 0.6);
      b.vx = Math.sin(p.h) * v + rx * out * kick * (j % 2 && Math.abs(p.k) < 0.002 ? -1 : 1);
      b.vz = Math.cos(p.h) * v + rz * out * kick * (j % 2 && Math.abs(p.k) < 0.002 ? -1 : 1);
      b.vy = 1 + Math.random() * 2.5;
      b.yawRate = rnd(-0.5, 0.5) * Math.abs(v) / 8;
      c.rr = out * rnd(0.4, 1.4) * Math.min(1, Math.abs(v) / 15);
      c.pr = rnd(-0.2, 0.2);
    });
    g.cam.shake(0.9);
    g.hud.stamp('DERAILED', 'The Budget Line regrets nothing.');
    const core = g.audio?.core, h = this.cars[0].b;
    const sp = core?.place(h.x, h.y + 1, h.z, { ref: 30, max: 900, wet: 0.4 });
    if (core && sp) grind(core, core.now + sp.lag, sp.in, 4.5);
    g.emit('impact', { vehicle: this.cab, speed: Math.max(12, Math.abs(v)), other: null, x: h.x, z: h.z });
  }

  private freeStep(dt: number): void {
    const g = this.game;
    let moving = 0;
    for (const c of this.cars) {
      const b = c.b;
      b.vy -= 9.81 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      b.h += b.yawRate * dt;
      b.roll += c.rr * dt; b.pitch += c.pr * dt;
      const gr = groundAt(b.x, b.z);
      if (b.y <= gr) {
        b.y = gr;
        if (b.vy < -2) { g.cam.shake(Math.min(0.5, -b.vy / 20)); }
        b.vy = Math.max(0, -b.vy * 0.15);
        const sp = Math.hypot(b.vx, b.vz), mu = Math.abs(b.roll) > 0.6 ? 6.5 : 4.5;
        const k = sp > 1e-3 ? Math.max(0, sp - mu * dt) / sp : 0;
        b.vx *= k; b.vz *= k;
        b.yawRate *= Math.max(0, 1 - 2.5 * dt);
        if (sp > 3 && Math.random() < 0.5) {
          g.fx?.emitters.sparks(b.x + rnd(-1.5, 1.5), b.y + 0.4, b.z + rnd(-3, 3), -b.vx / sp, 0.6, -b.vz / sp, 2, 6);
          if (Math.random() < 0.3) g.fx?.emitters.dust(b.x, b.y + 0.3, b.z, b.vx * 0.3, b.vz * 0.3, 1, false);
        }
        // Tipping: past a certain lean it goes all the way over and lies on its side.
        const lim = Math.PI / 2 * 0.97;
        if (Math.abs(b.roll) > 0.3) c.rr += Math.sign(b.roll) * 3.2 * dt;
        else c.rr *= Math.max(0, 1 - 6 * dt), b.roll *= Math.max(0, 1 - 3 * dt);
        if (Math.abs(b.roll) >= lim) { b.roll = Math.sign(b.roll) * lim; c.rr = 0; }
        c.pr *= Math.max(0, 1 - 5 * dt); b.pitch *= Math.max(0, 1 - 4 * dt);
      }
      moving += Math.hypot(b.vx, b.vz) + Math.abs(c.rr) + Math.abs(b.vy);
    }
    // Couplers: a chain. Neighbours may not part further than their couplers allow, nor pass through each other.
    for (let it = 0; it < 2; it++) for (let j = 0; j + 1 < this.cars.length; j++) {
      const A = this.cars[j], B = this.cars[j + 1];
      const ax = A.b.x - Math.sin(A.b.h) * A.spec.hc, az = A.b.z - Math.cos(A.b.h) * A.spec.hc;
      const bx = B.b.x + Math.sin(B.b.h) * B.spec.hc, bz = B.b.z + Math.cos(B.b.h) * B.spec.hc;
      const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
      if (d > 0.6) {
        const k = (d - 0.6) / d * 0.5;
        A.b.x += dx * k; A.b.z += dz * k; B.b.x -= dx * k; B.b.z -= dz * k;
        const rvx = (B.b.vx - A.b.vx) * 0.5, rvz = (B.b.vz - A.b.vz) * 0.5;
        A.b.vx += rvx * 0.1; A.b.vz += rvz * 0.1; B.b.vx -= rvx * 0.1; B.b.vz -= rvz * 0.1;
      }
      const cx = B.b.x - A.b.x, cz = B.b.z - A.b.z, cd = Math.hypot(cx, cz), mn = (A.spec.hc + B.spec.hc) * 0.55;
      if (cd < mn && cd > 1e-3) {
        const k = (mn - cd) / cd * 0.5;
        A.b.x -= cx * k; A.b.z -= cz * k; B.b.x += cx * k; B.b.z += cz * k;
      }
    }
    this.settleT = moving < 0.4 ? this.settleT + dt : 0;
    if (this.settleT > 1 && this.v !== 0) { this.v = 0; if (this.game.player.vehicle === this.cab) this.game.hud.toast('Off the rails and at rest. F to climb out of the cab.', 5); }
  }

  private thud(sp: number): void {
    this.game.cam.shake(Math.min(0.5, sp / 12));
    this.game.hud.toast('Buffer stop. The end of the line, literally.', 3);
  }

  // ── Placing ───────────────────────────────────────────────────────────────

  private place(dt: number): void {
    const free = this.mode === 'derail';
    const P = this.path(), A = this.pp, B = this.pq;
    for (const c of this.cars) {
      const b = c.b;
      if (!free) {
        at(P, c.s + c.spec.tb, A); at(P, c.s - c.spec.tb, B);
        const nx = (A.x + B.x) / 2, nz = (A.z + B.z) / 2;
        if (dt > 0) { b.vx = (nx - b.x) / dt; b.vz = (nz - b.z) / dt; if (Math.hypot(b.vx, b.vz) > 60) b.vx = b.vz = 0; }
        else { b.vx = Math.sin(A.h) * this.v; b.vz = Math.cos(A.h) * this.v; }
        b.x = nx; b.z = nz; b.y = (A.y + B.y) / 2;
        b.h = Math.atan2(A.x - B.x, A.z - B.z);
        b.pitch = Math.atan2(A.y - B.y, c.spec.tb * 2);
        b.roll = 0;
        c.obj.position.set(0, 0, 0); c.obj.rotation.set(0, 0, 0);
        c.body.position.set(b.x, b.y, b.z);
        c.body.rotation.set(-b.pitch, b.h, 0, 'YXZ');
        c.trucks[0].position.set(A.x, A.y, A.z); c.trucks[0].rotation.set(0, A.h, 0);
        c.trucks[1].position.set(B.x, B.y, B.z); c.trucks[1].rotation.set(0, B.h, 0);
      } else {
        c.body.position.set(b.x, b.y, b.z);
        c.body.rotation.set(-b.pitch, b.h, b.roll, 'YXZ');
        for (let i = 0; i < 2; i++) {
          const t = c.trucks[i], o = (i ? -1 : 1) * c.spec.tb;
          t.position.set(0, 0, o).applyEuler(c.body.rotation).add(c.body.position);
          t.rotation.copy(c.body.rotation);
        }
      }
    }
    // The cab follows the locomotive.
    const L = this.cars[0]?.b, cab = this.cab;
    if (L) {
      cab.x = L.x; cab.y = L.y; cab.z = L.z; cab.h = L.h; cab.pitch = L.pitch; cab.roll = L.roll;
      cab.vx = L.vx; cab.vz = L.vz; cab.vy = 0;
      cab.onGround = true;
    }
    // Headlights at the locomotive's front, ditch lights flashing by the crossings.
    if (L && this.glow.length) {
      const lc = this.cars[0].body, f = new THREE.Vector3();
      const flash = this.cross.some((c) => c.on && Math.abs(c.s - this.s) < 260) && Math.abs(this.v) > 0.5;
      const ph = Math.floor(this.game.time * 2.6) % 2;
      const k = 0.45 + this.night * 1.1;
      const spots: [number, number, number, number][] = [[0, 3.52, 9.25, 1.6], [1.25, 1.57, 9.85, 0.9], [-1.25, 1.57, 9.85, 0.9]];
      spots.forEach(([x, y, z, sz], i) => {
        const sp = this.glow[i];
        f.set(x, y, z).applyEuler(lc.rotation).add(lc.position);
        sp.position.copy(f);
        const on = i === 0 || !flash || ph === i - 1;
        const s = (on ? sz : 0.0001) * (0.8 + this.night * 1.8);
        sp.scale.set(s, s, s);
        (sp.material as THREE.SpriteMaterial).opacity = Math.min(1, k);
      });
    }
    for (const m of this.lampMats) m.color.setScalar(1.2 + this.night * 2.2);
    if (this.switchTarget) this.switchTarget.rotation.y = this.switchSpur ? Math.PI / 2 : 0, (this.switchTarget.material as THREE.MeshStandardMaterial).color.setHex(this.switchSpur ? 0xe0a020 : 0x2e8b3a);
    // Far away: nothing of it is drawn.
    const cam = this.game.camera.position;
    const vis = this.nearest(cam.x, cam.z) < (this.game.quality.drawDist ?? 900) + 150;
    this.root.visible = vis;
  }

  // ── Crossings ─────────────────────────────────────────────────────────────

  private crossings(dt: number): void {
    const head = this.s, tail = this.s - this.trainLen(), v = this.v, offMain = this.pathId === 1 && head > SW_X - X0;
    const stops = this.stopPeds;
    stops.length = 0;
    const core = this.game.audio?.core, lis = this.game.camera.position;
    for (const c of this.cross) {
      let d = c.s > head ? c.s - head : c.s < tail ? tail - c.s : 0;
      if (offMain && c.s > SW_X - X0) d = Infinity;
      if (this.mode === 'derail') d = Math.abs(c.x - this.cars[0].b.x) < 30 ? 0 : Infinity;
      const toward = (c.s > head && v > 0.3) || (c.s < tail && v < -0.3);
      const on = d < c.hw + 4 || (toward && d < 35 + Math.abs(v) * 24);
      if (on !== c.on) { c.on = on; c.t = 0; if (!on) c.horned = false; }
      c.t += dt;
      // Arm: down 4 s after the lights start, up 2 s after they stop.
      const want = c.on && c.t > 3 ? 0 : !c.on && c.t > 1.5 ? 1 : c.arm;
      c.arm += clamp(want - c.arm, -dt / 5, dt / 5) * (want > c.arm ? 1.6 : 1);
      for (const a of c.arms) a.rotation.z = c.arm * Math.PI / 2 * 0.97;
      const ph = Math.floor(this.game.time * 1.9) % 2;
      c.lamps[0].material = c.on && ph === 0 ? this.lampOn : this.lampOff;
      c.lamps[1].material = c.on && ph === 1 ? this.lampOn : this.lampOff;
      if (c.on || c.arm < 0.9) for (const p of c.peds) stops.push(p);
      // The bell, while the lights flash.
      if (c.on && core) {
        c.bellT -= dt;
        if (c.bellT <= 0) {
          c.bellT = 0.52;
          if (Math.hypot(lis.x - c.x, lis.z - c.z) < 260 && core.claim('trainbell', 4, 0.4)) {
            const sp = core.place(c.x, MAIN_Y + 4, c.z, { ref: 10, max: 260, wet: 0.2 });
            if (sp) bellStroke(core, core.now + sp.lag, sp.in, 0.8);
          }
        }
      }
      // The scheduled train blows for the crossing: two long, one short, one long, ending as the engine reaches it.
      if (this.mode === 'sched' && toward && !c.horned && d < Math.abs(v) * 9 + 15 && d > 10) {
        c.horned = true;
        this.blow();
      }
    }
  }

  private leadEnd(): { x: number; y: number; z: number } {
    const c = this.v >= 0 ? this.cars[0] : this.cars[this.cars.length - 1];
    return c ? c.b : { x: 0, y: 0, z: 0 };
  }

  private blow(): void {
    const core = this.game.audio?.core;
    if (!core || this.hornLeadT > 0) return;
    const e = this.leadEnd();
    const sp = core.place(e.x, e.y + 4.5, e.z, { ref: 40, max: 1600, wet: 0.35 });
    if (!sp) return;
    this.stats.horns++;
    this.hornLeadT = hornPattern(core, core.now + sp.lag, sp.in);
  }

  // ── Solid ─────────────────────────────────────────────────────────────────

  private collide(): void {
    const g = this.game, now = g.time;
    const near = (x: number, z: number, r: number): boolean => {
      for (const c of this.cars) if (Math.abs(c.b.x - x) < c.spec.hc + r && Math.abs(c.b.z - z) < c.spec.hc + r) return true;
      return false;
    };
    // Cars.
    for (const v of g.vehicles.list) {
      if (v.removed || v.sunk || v.shared || !near(v.x, v.z, 6)) continue;
      for (const c of this.cars) {
        const b = c.b;
        if (v.y > b.y + Math.max(c.spec.top, LOAD_TOP[c.load]) || v.y < b.y - 2) continue;
        const hit = obb(b.x, b.z, b.h, c.spec.hc - 0.3, 1.55, v.x, v.z, v.h, v.hl, v.hw);
        if (!hit) continue;
        v.x += hit.nx * hit.d; v.z += hit.nz * hit.d;
        const rvx = v.vx - b.vx, rvz = v.vz - b.vz, vn = rvx * hit.nx + rvz * hit.nz;
        const tsp = Math.hypot(b.vx, b.vz);
        if (vn < 0) { v.vx -= vn * hit.nx * 1.3; v.vz -= vn * hit.nz * 1.3; }
        if (tsp > 2 && -vn > 1.5 && (this.hitCool.get(v) ?? -9) < now - 0.6) {
          this.hitCool.set(v, now);
          const sp = Math.max(tsp, -vn);
          v.vx += b.vx * 0.35 + hit.nx * (2 + sp * 0.35); v.vz += b.vz * 0.35 + hit.nz * (2 + sp * 0.35);
          v.vy = Math.max(v.vy, 1.5 + sp * 0.18); v.onGround = false;
          v.yawRate += rnd(-1, 1) * sp * 0.12;
          v.health = Math.max(0, v.health - Math.min(85, 10 + sp * 4.5));
          this.stats.hits++;
          g.emit('impact', { vehicle: v, speed: sp, other: null, x: v.x - hit.nx * v.hw, z: v.z - hit.nz * v.hw });
          if (this.mode === 'driven') this.v *= 0.97;
          if (v === g.player.vehicle) g.hud.toast(pick(['The train always wins.', 'You lost an argument with 900 tons.', 'Right of way: the train. Always the train.']), 3.5);
        }
      }
    }
    // The player on foot.
    const pl = g.player;
    if (!pl.vehicle && pl.riding !== this.perch && !kid.on && near(pl.person.x, pl.person.z, 2)) {
      const per = pl.person;
      for (const c of this.cars) {
        const b = c.b;
        if (per.y > b.y + Math.max(c.spec.top, LOAD_TOP[c.load]) + 0.2 || per.y < b.y - 1.5) continue;
        const hit = obb(b.x, b.z, b.h, c.spec.hc - 0.3, 1.55, per.x, per.z, 0, 0.3, 0.3);
        if (!hit) continue;
        const tsp = Math.hypot(b.vx, b.vz);
        if (tsp > 1.5 && !pl.ragdolled && (this.hitCool.get(per) ?? -9) < now - 1.5) {
          this.hitCool.set(per, now);
          pl.hurt(Math.min(70, 8 + tsp * 3.5), { x: b.x, z: b.z });
          pl.knockDown(b.vx * 1.1 + hit.nx * (3 + tsp * 0.3), b.vz * 1.1 + hit.nz * (3 + tsp * 0.3), 3 + tsp * 0.15, { vx: b.vx * 1.2 + hit.nx * 4, vz: b.vz * 1.2 + hit.nz * 4 });
          g.hud.toast(pick(['Flattened, politely, by the Budget Line.', 'The train did not see you. The train does not look.', 'Lesson learned: the tracks are for trains.']), 3.5);
        } else if (!pl.ragdolled) { per.x += hit.nx * hit.d; per.z += hit.nz * hit.d; }
      }
    }
    // Walkers: the train's cars go to sim/peds.ts as moving vehicles (patch()); it knocks them down in its own way.
    this.movers.length = 0;
    for (const c of this.cars) {
      const b = c.b, sp = Math.hypot(b.vx, b.vz);
      if (sp < 0.6) continue;
      this.movers.push({ v: b as unknown as Vehicle, sh: Math.sin(b.h), ch: Math.cos(b.h), sp, ghost: false });
    }
  }

  /** Once: the walkers and the traffic get the train's cars and the crossings' stops along with their own. */
  private patch(): void {
    this.patched = true;
    const amb = this.game.systems.find((s) => (s as { traffic?: unknown }).traffic) as unknown as
      { peds: { update(dt: number, m: readonly Mover[], jumped: boolean): void }; traffic: { update(dt: number, peds: readonly RoadPed[], jumped: boolean): void } } | undefined;
    if (!amb) return;
    const pd = amb.peds, porig = pd.update.bind(pd);
    pd.update = (dt: number, m: readonly Mover[], jumped: boolean): void => {
      if (this.movers.length === 0) { porig(dt, m, jumped); return; }
      const all = this.mergedM; all.length = 0;
      for (const x of m) all.push(x);
      for (const x of this.movers) all.push(x);
      porig(dt, all, jumped);
    };
    const tr = amb.traffic, torig = tr.update.bind(tr);
    tr.update = (dt: number, peds: readonly RoadPed[], jumped: boolean): void => {
      if (this.stopPeds.length === 0) { torig(dt, peds, jumped); return; }
      const all = this.mergedP; all.length = 0;
      for (const p of peds) all.push(p);
      for (const p of this.stopPeds) all.push(p);
      torig(dt, all, jumped);
    };
  }

  // ── Riding and the cab ────────────────────────────────────────────────────

  /** ent/player.ts: the cab, if a person at (x, y, z) is within reach of the locomotive and it is free to take. */
  nearCab(x: number, y: number, z: number, reach: number): Vehicle | null {
    if (this.mode === 'remote' || this.cab.driver) return null;
    const L = this.cars[0];
    if (!L || L.kind !== 'loco' || Math.abs(L.b.y - y) > 3) return null;
    const hit = obb(L.b.x, L.b.z, L.b.h, L.spec.hc + reach, 1.55 + reach, x, z, 0, 0.01, 0.01);
    return hit ? this.cab : null;
  }
  isCab(v: Vehicle | null | undefined): boolean { return v === this.cab; }

  private rides(dt: number): void {
    const g = this.game, pl = g.player, per = pl.person;
    if (pl.riding === this.perch && this.perchCar) {
      // Stand where the perch is, a frame ahead (the person is drawn before the train moves).
      const c = this.perchCar, b = c.b, f = new THREE.Vector3(0, this.perchY, this.perchAlong).applyEuler(c.body.rotation);
      const P = this.perch;
      P.x = b.x + f.x; P.y = b.y + f.y; P.z = b.z + f.z; P.h = b.h + (this.perchAlong < 0 ? Math.PI : 0) + 0.0;
      P.vx = b.vx; P.vz = b.vz; P.pitch = b.pitch; P.roll = b.roll;
      per.x = P.x + b.vx * dt; per.y = P.y; per.z = P.z + b.vz * dt; per.h = P.h;
      per.pose = 'stand'; per.bench = false; per.speed = 0; per.visible = true;
      if (this.mode === 'derail' && Math.abs(b.roll) > 0.5) pl.exit();
      return;
    }
    // On foot beside a perch: offer it.
    if (pl.vehicle || pl.riding || pl.ragdolled || pl.swimming || pl.nearVehicle) { this.clearPrompt(); return; }
    let best: { c: Car; along: number; y: number; what: string } | null = null, bd = 2.6;
    if (this.mode !== 'derail' && this.nearest(per.x, per.z) < 20) {
      for (const c of this.cars) {
        const spots = c.spec.ride ?? (c.load ? [{ along: 0, y: LOAD_TOP[c.load] + 0.05, what: c.load === 'logs' ? 'the pulpwood' : 'the lumber' }] : []);
        for (const s of spots) {
          const x = c.b.x + Math.sin(c.b.h) * s.along, z = c.b.z + Math.cos(c.b.h) * s.along;
          const d = c.spec.ride ? Math.hypot(per.x - x, per.z - z) - 1.3 : Math.max(0, Math.abs((per.x - c.b.x) * Math.sin(c.b.h) + (per.z - c.b.z) * Math.cos(c.b.h)) - c.spec.hc + 0.5, Math.abs((per.x - c.b.x) * Math.cos(c.b.h) - (per.z - c.b.z) * Math.sin(c.b.h)) - 1.6);
          if (d < bd) { bd = d; best = { c, along: s.along, y: s.y, what: s.what }; }
        }
      }
    }
    if (!best || Math.hypot(best.c.b.vx, best.c.b.vz) > 9) { this.clearPrompt(); return; }
    g.hud.prompt(`F  Ride on ${best.what}`); this.promptOn = true;
    if (g.input.hit('enter')) {
      g.input.eat('enter');
      this.perchCar = best.c; this.perchAlong = best.along; this.perchY = best.y;
      this.clearPrompt();
      const P = this.perch, b = best.c.b;
      P.x = b.x; P.z = b.z; P.y = b.y + best.y; P.h = b.h;
      pl.ride(P as unknown as Vehicle);
      g.hud.toast(best.c.kind === 'caboose' ? 'Riding the caboose. F to step off (mind the speed).' : 'Riding the load. Hold on to nothing. F to jump off.', 4);
    }
  }

  private clearPrompt(): void { if (this.promptOn) { this.game.hud.prompt(null); this.promptOn = false; } }

  private drivenUi(dt: number, driving: boolean): void {
    const g = this.game;
    if (!driving) { if (this.promptT > 0) { this.promptT = 0; g.hud.prompt(null); } if (this.hornStop) { this.hornStop(g.audio?.core?.now ?? 0); this.hornStop = null; } return; }
    const c = this.cab.ctl;
    // A/D line the spur switch while the train is short of the points.
    if (this.spur && this.s < SW_X - X0) {
      if (c.steer < -0.5 && !this.switchSpur) { this.switchSpur = true; g.hud.toast('Switch lined for the pulpwood spur (tight curve: keep it under 25 mph).', 3); }
      if (c.steer > 0.5 && this.switchSpur) { this.switchSpur = false; g.hud.toast('Switch lined for the main line.', 2.5); }
    }
    this.promptT -= dt;
    if (this.promptT <= 0) {
      this.promptT = 0.5;
      const mph = Math.round(Math.abs(this.v) * 2.237);
      const sw = this.spur ? (this.s < SW_X - X0 ? ` · A/D switch: ${this.switchSpur ? 'SPUR' : 'MAIN'}` : this.pathId === 1 ? ' · on the spur' : '') : '';
      g.hud.prompt(this.mode === 'derail' ? 'F  Climb out' : `W/S throttle · Space brake · H horn${sw} · ${mph} mph`);
    }
    // The horn, for as long as it is held.
    const core = g.audio?.core;
    if (core) {
      if (c.horn && !this.hornStop) {
        const sp = core.place(this.cab.x, this.cab.y + 4.5, this.cab.z, { ref: 40, max: 1600, wet: 0.3 });
        if (sp) this.hornStop = hornNote(core, core.now + sp.lag, sp.in, Infinity, 0.8);
      } else if (!c.horn && this.hornStop) { this.hornStop(core.now); this.hornStop = null; }
    }
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  private sounds(dt: number): void {
    const core = this.game.audio?.core;
    if (this.hornLeadT > 0) this.hornLeadT -= dt;
    if (!core || this.mode === 'derail') return;
    const L = this.cars[0]?.b;
    if (!L) return;
    const lis = this.game.camera.position;
    // The diesel, in overlapping grains placed where the locomotive is.
    this.grainT -= dt;
    if (this.grainT <= 0 && Math.hypot(lis.x - L.x, lis.z - L.z) < 500) {
      this.grainT = 0.3;
      const notch = this.mode === 'driven' ? Math.abs(this.cab.ctl.accel) : clamp(Math.abs(this.v) / 12, 0.1, 0.8);
      const sp = core.place(L.x, L.y + 3, L.z, { ref: 14, max: 500, wet: 0.15 });
      if (sp) dieselGrain(core, core.now + sp.lag, sp.in, notch, 0.9);
    }
    // The wheels over each rail joint (every 12 m), for the cars near enough to hear.
    if (Math.abs(this.v) > 1.5) {
      for (const c of this.cars) {
        const j = Math.floor((c.s + c.spec.tb) / 12);
        if (j !== c.joint) {
          c.joint = j;
          if (Math.hypot(lis.x - c.b.x, lis.z - c.b.z) < 70 && core.claim('trainclack', 6, 0.2)) {
            const sp = core.place(c.b.x, c.b.y + 0.5, c.b.z, { ref: 6, max: 90, wet: 0.1 });
            if (sp) clack(core, core.now + sp.lag, sp.in, Math.min(0.5, 2.6 / Math.abs(this.v)), 0.7);
          }
        }
      }
    }
  }

  // ── Multiplayer ───────────────────────────────────────────────────────────

  remotePose(id: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, speed: number): void {
    if (this.game.player.vehicle === this.cab) return;
    this.remote = { id, x, y, z, yaw, pitch, roll, speed, t: this.game.time };
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    return {
      mode: this.mode, consist: this.consist, cars: this.cars.length, s: +this.s.toFixed(1), v: +this.v.toFixed(2), path: this.pathId,
      x: +(this.cars[0]?.b.x ?? 0).toFixed(1), z: +(this.cars[0]?.b.z ?? 0).toFixed(1), crossings: this.cross.length,
      active: this.cross.filter((c) => c.on).map((c) => c.name), ...this.stats,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pick<T>(a: readonly T[]): T { return a[Math.floor(Math.random() * a.length)]; }

/** Overlap of two boxes on the ground (centre, heading, half length, half width): push for B out of A, or null. */
function obb(ax: number, az: number, ah: number, al: number, aw: number, bx: number, bz: number, bh: number, bl: number, bw: number): { nx: number; nz: number; d: number } | null {
  const axes = [Math.sin(ah), Math.cos(ah), Math.cos(ah), -Math.sin(ah), Math.sin(bh), Math.cos(bh), Math.cos(bh), -Math.sin(bh)];
  const fa = [axes[0], axes[1]], ra = [axes[2], axes[3]], fb = [axes[4], axes[5]], rb = [axes[6], axes[7]];
  const dx = bx - ax, dz = bz - az;
  let best = Infinity, nx = 0, nz = 0;
  for (let i = 0; i < 4; i++) {
    const ux = axes[i * 2], uz = axes[i * 2 + 1];
    const rA = al * Math.abs(fa[0] * ux + fa[1] * uz) + aw * Math.abs(ra[0] * ux + ra[1] * uz);
    const rB = bl * Math.abs(fb[0] * ux + fb[1] * uz) + bw * Math.abs(rb[0] * ux + rb[1] * uz);
    const d = dx * ux + dz * uz, o = rA + rB - Math.abs(d);
    if (o <= 0) return null;
    // Prefer pushing sideways off the track: the long axis only wins by a clear margin.
    const w = i === 1 ? o * 0.8 : o;
    if (w < best) { best = w; const sg = d < 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; }
  }
  // Recompute the true depth on the chosen axis.
  const rA = al * Math.abs(fa[0] * nx + fa[1] * nz) + aw * Math.abs(ra[0] * nx + ra[1] * nz);
  const rB = bl * Math.abs(fb[0] * nx + fb[1] * nz) + bw * Math.abs(rb[0] * nx + rb[1] * nz);
  return { nx, nz, d: Math.max(0, rA + rB - Math.abs(dx * nx + dz * nz)) };
}

/** Boxes merged into one vertex-coloured geometry. */
class Boxes {
  private pos: number[] = []; private nor: number[] = []; private col: number[] = [];
  private static readonly unit = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  private readonly m = new THREE.Matrix4(); private readonly q = new THREE.Quaternion(); private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v = new THREE.Vector3(); private readonly n = new THREE.Vector3(); private readonly nm = new THREE.Matrix3();
  private readonly c = new THREE.Color();
  box(x: number, y: number, z: number, w: number, h: number, d: number, yaw: number, hex: number): void { this.boxR(x, y, z, w, h, d, yaw, 0, hex); }
  /** w along the local x, h up, d along the local z; turned by yaw, then rolled by r about the local z (for crossbucks). */
  boxR(x: number, y: number, z: number, w: number, h: number, d: number, yaw: number, r: number, hex: number): void {
    this.e.set(0, yaw, r); this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(x, y, z), this.q, new THREE.Vector3(w, h, d));
    this.nm.getNormalMatrix(this.m);
    const P = Boxes.unit.attributes.position, N = Boxes.unit.attributes.normal;
    this.c.setHex(hex).convertSRGBToLinear();
    for (let i = 0; i < P.count; i++) {
      this.v.fromBufferAttribute(P, i).applyMatrix4(this.m); this.pos.push(this.v.x, this.v.y, this.v.z);
      this.n.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize(); this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

void TAU;
