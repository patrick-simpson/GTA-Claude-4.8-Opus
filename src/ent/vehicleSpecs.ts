// The vehicle roster. All names and shapes are our own: Port Calamity's cars
// come from makers nobody has heard of, because they do not exist.
//
// Dimensions are overall, in meters. The physics (ent/vehicle.ts) reads the
// handling numbers; the body shapes (ent/vehicleModels.ts) read the dimensions.

export type VehicleKind =
  | 'sedan' | 'hatch' | 'coupe' | 'muscle' | 'sports' | 'pickup'
  | 'van' | 'taxi' | 'tow' | 'bus' | 'cruiser';

export interface VehicleSpec {
  kind: VehicleKind;
  /** Shown on the HUD when you get in. */
  name: string;
  length: number; width: number; height: number;
  /** Axle to axle, and the distance between left and right wheel centers. */
  wheelbase: number; track: number;
  wheelR: number; wheelW: number;
  /** kg. Heavier vehicles win collisions. */
  mass: number;
  /** m/s. */
  topSpeed: number;
  /** m/s^2 off the line; it tapers to nothing at top speed. */
  accel: number;
  /** m/s^2. */
  brake: number;
  /** How fast sideways speed dies, 1/s. Higher is stickier. */
  grip: number;
  /** Largest steering angle at walking pace, radians. It narrows with speed. */
  steer: number;
  /** Rear-drive cars step the tail out under power. */
  drive: 'rwd' | 'fwd';
  /** Factory paint options (hex). */
  colors: number[];
  /** Relative frequency among parked cars and traffic. 0 = never appears on its own. */
  common: number;
}

// The palette from PLAN.md, plus a few sun-faded neighbors.
const BONE = 0xf2e8cf, VERMILION = 0xe4572e, MUSTARD = 0xf0a202, TEAL = 0x2a9d8f, NAVY = 0x14213d;
const BRICK = 0x9c4a3c, SAGE = 0x8a9a6b, CHARCOAL = 0x2b2d33, FOG = 0xb9c4c2, SKY = 0x7fb0bd, TERRA = 0xc9774f, PLUM = 0x5b3a4a;

export const SPECS: Record<VehicleKind, VehicleSpec> = {
  sedan: {
    kind: 'sedan', name: 'Marlin Brougham',
    length: 4.7, width: 1.85, height: 1.45, wheelbase: 2.8, track: 1.58, wheelR: 0.33, wheelW: 0.22,
    mass: 1450, topSpeed: 42, accel: 6.2, brake: 13, grip: 7, steer: 0.6, drive: 'fwd',
    colors: [BONE, FOG, CHARCOAL, SAGE, BRICK, SKY, NAVY], common: 10,
  },
  hatch: {
    kind: 'hatch', name: 'Pip 3-Door',
    length: 3.8, width: 1.7, height: 1.5, wheelbase: 2.45, track: 1.46, wheelR: 0.3, wheelW: 0.2,
    mass: 1050, topSpeed: 37, accel: 5.8, brake: 13, grip: 7.6, steer: 0.64, drive: 'fwd',
    colors: [MUSTARD, TEAL, VERMILION, BONE, SKY, TERRA], common: 8,
  },
  coupe: {
    kind: 'coupe', name: 'Sandpiper GT',
    length: 4.4, width: 1.8, height: 1.32, wheelbase: 2.65, track: 1.55, wheelR: 0.33, wheelW: 0.24,
    mass: 1300, topSpeed: 50, accel: 8, brake: 14, grip: 8, steer: 0.58, drive: 'rwd',
    colors: [VERMILION, NAVY, BONE, TEAL, CHARCOAL], common: 5,
  },
  muscle: {
    kind: 'muscle', name: 'Brawler Eight',
    length: 4.95, width: 1.92, height: 1.35, wheelbase: 2.9, track: 1.6, wheelR: 0.35, wheelW: 0.28,
    mass: 1650, topSpeed: 54, accel: 9.5, brake: 12.5, grip: 6, steer: 0.56, drive: 'rwd',
    colors: [MUSTARD, VERMILION, CHARCOAL, PLUM, TEAL], common: 3,
  },
  sports: {
    kind: 'sports', name: 'Cormorant RS',
    length: 4.35, width: 1.95, height: 1.18, wheelbase: 2.6, track: 1.66, wheelR: 0.34, wheelW: 0.3,
    mass: 1350, topSpeed: 64, accel: 11.5, brake: 16, grip: 9.5, steer: 0.54, drive: 'rwd',
    colors: [VERMILION, MUSTARD, BONE, NAVY, TEAL], common: 1.5,
  },
  pickup: {
    kind: 'pickup', name: 'Dockhand',
    length: 5.3, width: 1.95, height: 1.85, wheelbase: 3.3, track: 1.66, wheelR: 0.4, wheelW: 0.27,
    mass: 2000, topSpeed: 38, accel: 5.5, brake: 11.5, grip: 6, steer: 0.58, drive: 'rwd',
    colors: [BRICK, SAGE, FOG, NAVY, TERRA, BONE], common: 6,
  },
  van: {
    kind: 'van', name: 'Breadbox',
    length: 5.2, width: 2.0, height: 2.3, wheelbase: 3.2, track: 1.7, wheelR: 0.36, wheelW: 0.24,
    mass: 2300, topSpeed: 33, accel: 4.2, brake: 10.5, grip: 5.5, steer: 0.58, drive: 'fwd',
    colors: [BONE, FOG, TEAL, MUSTARD, BRICK], common: 5,
  },
  taxi: {
    kind: 'taxi', name: 'Calamity Cab',
    length: 4.8, width: 1.85, height: 1.5, wheelbase: 2.85, track: 1.58, wheelR: 0.33, wheelW: 0.22,
    mass: 1500, topSpeed: 44, accel: 6.6, brake: 13, grip: 7, steer: 0.62, drive: 'rwd',
    colors: [MUSTARD], common: 4,
  },
  tow: {
    kind: 'tow', name: 'Mule Wrecker',
    length: 6.2, width: 2.2, height: 2.4, wheelbase: 3.8, track: 1.84, wheelR: 0.46, wheelW: 0.3,
    mass: 4200, topSpeed: 31, accel: 4.6, brake: 10, grip: 5.6, steer: 0.6, drive: 'rwd',
    colors: [VERMILION, TEAL, MUSTARD], common: 0.6,
  },
  bus: {
    kind: 'bus', name: 'Harbor Line No. 7',
    length: 10.5, width: 2.5, height: 3.1, wheelbase: 5.6, track: 2.1, wheelR: 0.5, wheelW: 0.32,
    mass: 9500, topSpeed: 27, accel: 2.8, brake: 8.5, grip: 5, steer: 0.66, drive: 'rwd',
    colors: [TEAL, BONE], common: 0.8,
  },
  cruiser: {
    kind: 'cruiser', name: 'Harbor Patrol Interceptor',
    length: 4.9, width: 1.9, height: 1.48, wheelbase: 2.9, track: 1.6, wheelR: 0.34, wheelW: 0.25,
    mass: 1750, topSpeed: 58, accel: 9, brake: 15, grip: 8.5, steer: 0.6, drive: 'rwd',
    colors: [NAVY], common: 0,
  },
};

export const KINDS = Object.keys(SPECS) as VehicleKind[];

/** Pick a kind weighted by how common it is. `r` is a random number in 0..1. */
export function commonKind(r: number): VehicleKind {
  let total = 0;
  for (const k of KINDS) total += SPECS[k].common;
  let t = r * total;
  for (const k of KINDS) { t -= SPECS[k].common; if (t <= 0) return k; }
  return 'sedan';
}
