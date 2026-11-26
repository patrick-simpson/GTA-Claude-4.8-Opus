// What a tyre is rolling on (fun queue 2, item 46): one pure-ish lookup from a place and the weather to a surface, and the
// table of what each surface sounds like. audio/vehicles.ts reads it for her own car (eight times a second) and for the few
// nearest other cars; tools/audio/surface.mjs tests it.
//
// The ground itself comes from the same places the footsteps use (the street plan's probe, the districts, the shore) and the
// weather from the same state the physics reads: snow lying (Sky.slick), plowed and salted lanes and black ice and puddles
// (world/roadCond.ts), mud season (Vehicles.mud), rain (Sky.wet). Nothing here is saved, sent or drawn.

import type { Game } from '../core/game';
import { BREAKWATER, BRIDGE, PIER, PIER_HEAD, bridgeEndZ, islandSD, streetSurface } from '../world/plan';
import { FOOTBRIDGE, MAIN_SPLIT_Z, RAIL_TRESTLE, ROAD_BRIDGE, coastSD } from '../world/mainland';
import { roads } from '../world/roadCond';

export const ASPHALT = 0, COBBLE = 1, GRAVEL = 2, GRASS = 3, DECK = 4, SNOW = 5, ICE = 6, SAND = 7, PIER_WOOD = 8, MUD = 9;
export const SURFACES = ['asphalt', 'cobble', 'gravel', 'grass', 'deck', 'snow', 'ice', 'sand', 'pier', 'mud'] as const;
export const N_SURF = SURFACES.length;

/** The answer of one lookup. Reused: a caller keeps one and passes it in. */
export interface Sample {
  kind: number;
  /** 0..1 how wet the ground is (rain, brine on a salted lane). */
  wet: number;
  /** Standing in a puddle that lies in the lane. */
  puddle: boolean;
}
export const newSample = (): Sample => ({ kind: ASPHALT, wet: 0, puddle: false });

/** What one surface sounds like. Levels are 0..1 multipliers on the layers in Rolling; hard = rain makes it hiss. */
export interface SurfaceSound {
  /** Low roar, its low-pass at rest and per m/s. */
  roar: number; roarF: number; roarK: number;
  /** Tread hiss (a band of pink noise) and where the band sits. */
  hiss: number; hissF: number;
  /** Rhythmic thump: level, band, and pulses per metre travelled (cobbles, plank and deck joints). */
  thump: number; thumpF: number; thumpPerM: number;
  /** Granular crunch (gravel, snow): level, the high-pass, and how fast the grains pop. */
  grit: number; gritF: number; gritRate: number;
  /** The sound of sliding when the tyres let go, and its band. Surfaces that cannot squeal slide instead. */
  slide: number; slideF: number;
  /** 0..1 how much of the rubber squeal is allowed. */
  squeal: number;
  /** 1 when rain wets it into a hiss (hard surfaces), less for the soft ones. */
  hard: number;
  /** How loud it is at a distance for a car that is not hers (0..1). */
  far: number; farF: number;
}

export const SURF_SOUND: readonly SurfaceSound[] = [
  // asphalt: a smooth hum.
  { roar: 1, roarF: 110, roarK: 16, hiss: 1, hissF: 1100, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0, gritF: 2000, gritRate: 20, slide: 0, slideF: 1500, squeal: 1, hard: 1, far: 0.9, farF: 700 },
  // cobbles: a low thrum at the stones' pace, a rougher roar, a softer squeal.
  { roar: 1.35, roarF: 150, roarK: 14, hiss: 0.6, hissF: 900, thump: 0.8, thumpF: 130, thumpPerM: 1.7, grit: 0.1, gritF: 1500, gritRate: 30, slide: 0.15, slideF: 1200, squeal: 0.55, hard: 0.9, far: 1, farF: 520 },
  // gravel: a crunch, little roar, no squeal; a scrape when it slides.
  { roar: 0.65, roarF: 100, roarK: 12, hiss: 0.15, hissF: 1800, thump: 0, thumpF: 150, thumpPerM: 0, grit: 1, gritF: 1700, gritRate: 55, slide: 0.55, slideF: 1500, squeal: 0, hard: 0.2, far: 0.8, farF: 1500 },
  // grass and dirt: a soft rumble and swish, a slither not a squeal.
  { roar: 0.85, roarF: 85, roarK: 10, hiss: 0.3, hissF: 700, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0.2, gritF: 900, gritRate: 25, slide: 0.65, slideF: 800, squeal: 0, hard: 0.05, far: 0.45, farF: 360 },
  // bridge deck: a hollow rumble and a joint clunk every few metres, an airy rattle over the top.
  { roar: 0.8, roarF: 100, roarK: 14, hiss: 0.5, hissF: 1900, thump: 1, thumpF: 210, thumpPerM: 0.16, grit: 0.12, gritF: 3000, gritRate: 38, slide: 0, slideF: 1500, squeal: 0.9, hard: 1, far: 0.9, farF: 900 },
  // snow: a muffled crunch, a squeak, almost no roar; a long whisper when it slides.
  { roar: 0.2, roarF: 80, roarK: 8, hiss: 0.08, hissF: 2600, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0.85, gritF: 2600, gritRate: 14, slide: 0.8, slideF: 1100, squeal: 0, hard: 0, far: 0.45, farF: 1900 },
  // ice: the road goes almost silent; the slide is a thin, low, scary hush.
  { roar: 0.04, roarF: 70, roarK: 4, hiss: 0.04, hissF: 3000, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0.03, gritF: 3500, gritRate: 8, slide: 1.1, slideF: 520, squeal: 0, hard: 0, far: 0.08, farF: 2200 },
  // sand: a hush, a low drag, a slither.
  { roar: 0.4, roarF: 75, roarK: 8, hiss: 0.55, hissF: 2300, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0.25, gritF: 2800, gritRate: 22, slide: 0.55, slideF: 2000, squeal: 0, hard: 0, far: 0.3, farF: 2100 },
  // wooden pier: planks clattering under the wheels.
  { roar: 0.55, roarF: 130, roarK: 10, hiss: 0.3, hissF: 1500, thump: 1, thumpF: 180, thumpPerM: 1.4, grit: 0.2, gritF: 2200, gritRate: 28, slide: 0.1, slideF: 1500, squeal: 0.5, hard: 0.6, far: 0.85, farF: 600 },
  // mud: a squelch and a suck, a wet slither.
  { roar: 0.5, roarF: 90, roarK: 8, hiss: 0.55, hissF: 520, thump: 0, thumpF: 150, thumpPerM: 0, grit: 0.25, gritF: 700, gritRate: 18, slide: 0.95, slideF: 650, squeal: 0, hard: 0, far: 0.55, farF: 420 },
];

const inRect = (x: number, z: number, r: { x0: number; z0: number; x1: number; z1: number }, m = 0): boolean => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;

/** The ground under (x, z) with no weather on it: asphalt, cobble, gravel, grass, deck, sand or pier. */
export function groundKind(g: Game, x: number, z: number): number {
  if (Math.abs(x - BRIDGE.x) <= BRIDGE.hw && z <= BRIDGE.z0 + 4 && z >= bridgeEndZ()) return DECK;
  if (z < MAIN_SPLIT_Z) {
    if (inRect(x, z, FOOTBRIDGE, 0.8)) return PIER_WOOD;
    if (inRect(x, z, RAIL_TRESTLE) || inRect(x, z, ROAD_BRIDGE)) return DECK;
    const d = g.plan.districtAt(x, z);
    const surf = streetSurface();
    const paved = surf ? surf.probe(x, z).kind !== null : d !== null && d !== 'lake' && d !== 'college' && d !== 'sister';
    if (paved) return d === 'mill' ? COBBLE : ASPHALT;
    if (d === 'yard') return GRAVEL;
    return coastSD(x, z) > -25 ? SAND : GRASS;
  }
  if (inRect(x, z, PIER) || inRect(x, z, PIER_HEAD)) return PIER_WOOD;
  if (inRect(x, z, BREAKWATER, 3)) return ASPHALT;
  const d = g.plan.districtAt(x, z);
  if (d === 'park') return GRASS;
  if (d === 'oldtown') return COBBLE;
  if (d === 'strand' || d === null) return islandSD(x, z) > -40 ? SAND : d === null ? GRASS : ASPHALT;
  return ASPHALT;
}

/**
 * What a tyre at (x, z) rolls on right now, in `o`. Weather: snow lying hides the ground except in plowed and salted lanes;
 * black ice takes the bridge and the patches; mud season turns turf and gravel to mud; rain wets, and puddles in the lanes.
 */
export function detect(g: Game, x: number, z: number, o: Sample = newSample()): Sample {
  let k = groundKind(g, x, z);
  const hard = k === ASPHALT || k === COBBLE || k === DECK || k === PIER_WOOD;
  let wet = roads.wet, puddle = false;
  const mk = roads.markAt(x, z);
  if (mk === 2) wet = Math.max(wet, 0.55);
  else if (mk === 1) wet = Math.max(wet, 0.25);
  if (hard && roads.active) {
    // sample() writes the physics' own result fields: read what we need and put them back.
    const sg = roads.grip, sk = roads.snowK, sp = roads.puddle, si = roads.onIce;
    roads.sample(x, z);
    const ice = roads.onIce, pud = roads.puddle >= 0;
    roads.grip = sg; roads.snowK = sk; roads.puddle = sp; roads.onIce = si;
    if (ice) { o.kind = ICE; o.wet = 0; o.puddle = false; return o; }
    puddle = pud;
  }
  if (g.sky.slick > 0.15 && mk === 0) k = SNOW;
  else if ((k === GRASS || k === GRAVEL) && g.vehicles.mud > 0.5) k = MUD;
  if (k === SNOW || k === ICE) wet = 0;
  else if (SURF_SOUND[k].hard < 0.5) wet *= 0.5;
  o.kind = k; o.wet = wet; o.puddle = puddle && k !== SNOW;
  return o;
}
