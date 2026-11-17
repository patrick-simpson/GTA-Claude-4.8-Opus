// The contracts between subsystems. Every subsystem class `implements` its
// interface here and talks to the others only through `game.<subsystem>`, so
// each file can be written, replaced or tested without reading the rest.
//
// Read src/core/util.ts first for the world conventions (meters, Y up,
// East = +X, South = +Z, heading h: forward = (sin h, 0, cos h),
// right = (-cos h, 0, sin h), turning right DEcreases h, models face +Z).

import type * as THREE from 'three';
import type { Prop } from '../world/collide';
import type { RNG } from './util';
import type { VehicleKind, VehicleSpec } from '../ent/vehicleSpecs';

export type Weather = 'clear' | 'overcast' | 'fog' | 'rain';
export type GameState = 'loading' | 'title' | 'play' | 'paused';

export interface Quality {
  name: 'low' | 'medium' | 'high';
  /** Upper limit for renderer.setPixelRatio. */
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  /** Shadow map edge in texels. */
  shadowSize: number;
  /** Where the fog swallows the world, in meters. The camera far plane sits beyond it. */
  drawDist: number;
  /** 0..1 multiplier for optional dressing: trees, street furniture, parked cars. */
  density: number;
}

// ── World ────────────────────────────────────────────────────────────────────

/** One builder's share of the world: whatever it needs done per frame or at nightfall. */
export interface WorldPart {
  update?(dt: number): void;
  /** n: 0 = full day, 1 = full night. Called only when the value moves, not every frame. */
  setNight?(n: number): void;
}

export type Signal = 'green' | 'yellow' | 'red';

export interface WorldApi {
  setNight(n: number): void;
  update(dt: number): void;
  /** Colour shown to traffic arriving at intersection `nodeId` along an east-west (`horiz`) or north-south street. */
  signal(nodeId: number, horiz: boolean): Signal;
}

// ── Sky ──────────────────────────────────────────────────────────────────────

export interface SkyApi {
  /** Game clock in hours, 0..24. Writable: tests and cheats set it directly. */
  hour: number;
  /** Game hours per real second. Default 1/60, a full day every 24 minutes. */
  rate: number;
  /** 0 in full daylight, 1 in full night, smooth through dusk and dawn. */
  readonly night: number;
  /** Unit vector from the ground toward the key light: the sun by day, the moon at night. */
  readonly lightDir: THREE.Vector3;
  readonly weather: Weather;
  /** 0 dry .. 1 soaked. Rises in rain and dries slowly afterwards. */
  readonly wet: number;
  setWeather(w: Weather, instant?: boolean): void;
  /** Advance the clock; move lights, fog, dome and shadow box (centered on game.cam.focus). */
  update(dt: number): void;
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

export interface VehicleControls {
  /** +1 full throttle forward .. -1 brake, then reverse once stopped. */
  accel: number;
  /** -1 full left .. +1 full right. */
  steer: number;
  handbrake: boolean;
  horn: boolean;
}

export interface Vehicle {
  readonly id: number;
  readonly spec: VehicleSpec;
  /** Position of the middle of the car at road level (y = height under the wheels when grounded). */
  x: number; y: number; z: number;
  h: number; pitch: number; roll: number;
  /** World-space velocity, m/s. */
  vx: number; vy: number; vz: number;
  yawRate: number;
  /** Signed speed along the car's nose, m/s. Negative in reverse. */
  readonly speed: number;
  /** Written every frame by whoever is driving. Left alone, the car coasts to a stop. */
  ctl: VehicleControls;
  driver: 'player' | 'ai' | null;
  /** Paint colour (hex). */
  color: number;
  /** 100 = showroom. Milestone 3 sets fire to anything under 20. */
  health: number;
  onGround: boolean;
  /** Seconds since the wheels left the ground (0 while grounded). */
  airTime: number;
  /** 0..1, how hard the tires are sliding. Sound, smoke and skid marks read this later. */
  slip: number;
  /** Head and tail lights. The vehicle code switches them on at night when someone is driving. */
  lights: boolean;
  /** True once it has gone into deep water; it sinks and is removed shortly after. */
  sunk: boolean;
  /** Half length and half width of the collision box, meters. */
  readonly hl: number; readonly hw: number;
  /** Where a person stands to use a door. side: -1 = left (driver), +1 = right. */
  doorPos(side: -1 | 1, out: { x: number; z: number }): void;
}

export interface VehiclesApi {
  readonly list: readonly Vehicle[];
  spawn(kind: VehicleKind, x: number, z: number, h: number, color?: number): Vehicle;
  remove(v: Vehicle): void;
  nearest(x: number, z: number, maxDist: number, pred?: (v: Vehicle) => boolean): Vehicle | null;
  /** Push a standing circle (a person at foot height y) out of every car body. Returns the car touched, if any. */
  resolveCircle(p: { x: number; z: number }, r: number, y: number): Vehicle | null;
  /** Physics for every awake vehicle (sub-stepped at 1/120 s), then sync the instanced meshes. */
  update(dt: number): void;
}

// ── People ───────────────────────────────────────────────────────────────────

export type Pose = 'stand' | 'walk' | 'run' | 'jump' | 'fall' | 'swim' | 'down' | 'sit';

export interface Look {
  skin: number; hair: number; top: number; bottom: number; shoes: number;
  /** Hat colour, or null for bare-headed. */
  hat: number | null;
  /** Overall scale, about 0.92 .. 1.08. */
  height: number;
  /** Shoulder/hip width multiplier, about 0.9 .. 1.15. */
  build: number;
}

export interface Person {
  readonly id: number;
  /** Feet position. */
  x: number; y: number; z: number;
  h: number;
  /** Set by whoever controls the person; the renderer notices changes and blends between poses itself. */
  pose: Pose;
  /** Horizontal speed in m/s. Drives the stride rate. */
  speed: number;
  look: Look;
  visible: boolean;
  health: number;
}

export interface PeopleApi {
  readonly list: readonly Person[];
  spawn(x: number, z: number, h: number, look?: Look): Person;
  remove(p: Person): void;
  randomLook(rng?: RNG): Look;
  /** Advance the animation of everyone visible and write the instance matrices. Moves nobody. */
  update(dt: number): void;
}

// ── Player ───────────────────────────────────────────────────────────────────

export interface PlayerApi {
  readonly person: Person;
  /** The vehicle being driven, or null on foot. */
  readonly vehicle: Vehicle | null;
  /** Where the player is, whether on foot or at the wheel. */
  readonly x: number; readonly y: number; readonly z: number; readonly h: number;
  /** Ground speed in m/s (never negative). */
  readonly speed: number;
  health: number; armor: number; money: number;
  /** Police attention, 0..5. Milestone 3 drives it; the HUD already shows it. */
  heat: number;
  readonly swimming: boolean;
  /** A vehicle close enough to get into right now (for the HUD hint), else null. */
  readonly nearVehicle: Vehicle | null;
  teleport(x: number, z: number, h?: number): void;
  enter(v: Vehicle, instant?: boolean): void;
  exit(): void;
  /** Read the input and move the person, or write the driven vehicle's controls. Runs before vehicles.update. */
  update(dt: number): void;
}

// ── Camera ───────────────────────────────────────────────────────────────────

export interface CameraApi {
  /** Heading the camera looks along (same convention as entity headings). On-foot movement is relative to it. */
  yaw: number;
  /** Radians above (+) or below (-) level. */
  pitch: number;
  /** Smoothed point of interest in world space. The sun's shadow box centers on it. */
  readonly focus: THREE.Vector3;
  shake(amount: number): void;
  /** Jump straight to the ideal spot: after a teleport, on spawn, when the game starts. */
  snap(): void;
  update(dt: number): void;
}

// ── HUD ──────────────────────────────────────────────────────────────────────

export interface HudApi {
  /** Small notice, paperwork style. */
  toast(text: string, seconds?: number): void;
  /** Large stamped lettering: district names, "CLOCKED OUT". */
  stamp(title: string, sub?: string): void;
  /** Contextual key hint from another system, or null to clear. */
  prompt(text: string | null): void;
  /** Objective strip (missions use it from milestone 4), or null to hide. */
  objective(text: string | null): void;
  update(dt: number): void;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Things that happen once and that several systems care about. `game.on(name, fn)` / `game.emit(name, data)`. */
export interface GameEvents {
  /** A vehicle hit something hard. speed = closing speed in m/s. */
  impact: { vehicle: Vehicle; speed: number; other: Vehicle | null; x: number; z: number };
  enter: { vehicle: Vehicle };
  exit: { vehicle: Vehicle };
  propBreak: { prop: Prop; vx: number; vz: number };
  splash: { x: number; z: number; big: boolean };
  /** The giant rubber duck in the harbor has been bumped. It honks. */
  duck: { x: number; z: number };
  start: Record<string, never>;
  pause: { on: boolean };
}
