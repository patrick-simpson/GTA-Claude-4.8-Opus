// The city plan: pure data, no rendering. Everything else (meshes, traffic,
// pedestrians, the minimap, missions) reads the same plan, so they always agree.
//
// Port Calamity is an island. Streets form an uneven grid; a few segments are
// removed to make room for a park, an arena and a container yard.
//
// North of it, across the Budget Gap, is the mainland and the town of Tepid Falls
// (mainland.ts holds its numbers). Its streets are a second grid folded into the
// same nodes, edges and blocks, always AFTER the island's, so every island index
// and every island random number is what it was before the mainland existed.
// Mainland nodes and blocks carry i, j offset by MI0, MJ0; `land` is 1 on them.

import { RNG, clamp, smooth } from '../core/util';
import {
  DECKS, EXTRA_LOTS, LAKE, MAIN_SPLIT_Z, MAIN_Y, MI0, MJ0, MXS, MZS, M_AVE_X, M_AVE_Z, M_EW_NAMES, M_NS_NAMES, RAIL,
  RIVER_HW, STAGE_OF, STAGE_OVERRIDE, coastSD, hillAt, mCell, mainlandTerrain, mhSeg, mvSeg, riverX, waterDist,
  type MainDistrict,
} from './mainland';
import { PD, pardonsStalls } from './pardonsSite';

export type IslandDistrict =
  | 'downtown' | 'midtown' | 'oldtown' | 'suburb' | 'industrial' | 'port' | 'strand' | 'park' | 'arena';
export type District = IslandDistrict | MainDistrict;

export const DISTRICT_NAME: Record<District, string> = {
  downtown: 'Ledger District',
  midtown: 'Tinker Row',
  oldtown: 'Fishbone',
  suburb: 'Gull Heights',
  industrial: 'The Cannery',
  port: 'Dock Seven',
  strand: 'Saltwater Strand',
  park: 'Mercy Park',
  arena: 'Flounder Field',
  mill: 'Loom Row',
  main: 'Lower Main',
  square: 'Quorum Square',
  stacks: 'The Stacks',
  college: 'Dithers Hill',
  yard: 'Sidetrack Yard',
  exits: 'The Exits',
  lake: 'Indecision Township',
  sister: 'Lesser Tepid',
};

/** X of each north-south street and Z of each east-west street (centerlines). */
export const XS = [-600, -480, -360, -250, -140, -30, 80, 190, 310, 440, 580];
export const ZS = [-430, -320, -220, -120, -20, 80, 180, 290, 400];
export const NS_NAMES = ['Anchor Ave', 'Bilge St', 'Capstan St', 'Dogfish St', 'Eel Alley', 'Calamity Ave', 'Gannet St', 'Halyard St', 'Ironbound Ave', 'Jetsam St', 'Keel Row'];
export const EW_NAMES = ['Gull Heights Rd', 'Tern St', 'Osprey St', 'Mercy Ln', 'Ledger St', 'Bollard St', 'Tinplate St', 'Strand Blvd', 'Seawall Dr'];

export const AVE_HW = 10;      // half-width of an avenue (2 lanes each way + parking)
export const ST_HW = 6;        // half-width of a street (1 lane each way + parking)
export const SIDEWALK = 3.5;
export const CURB = 0.16;
export const WATER_Y = -0.8;

const AVE_X = [5, 8];
const AVE_Z = [4, 7];
export const hwX = (i: number): number => (AVE_X.includes(i) ? AVE_HW : ST_HW);
export const hwZ = (j: number): number => (AVE_Z.includes(j) ? AVE_HW : ST_HW);

// Removed street segments. "v:i:j" = the north-south street i between cross streets j and j+1.
const REMOVED = new Set(['v:7:2', 'v:7:3', 'h:6:3', 'h:7:3', 'h:9:7', 'v:1:3']);
const vSeg = (i: number, j: number): boolean =>
  i >= 0 && i < XS.length && j >= 0 && j < ZS.length - 1 && !REMOVED.has(`v:${i}:${j}`);
const hSeg = (i: number, j: number): boolean =>
  i >= 0 && i < XS.length - 1 && j >= 0 && j < ZS.length && !REMOVED.has(`h:${i}:${j}`);

export interface Rect { x0: number; z0: number; x1: number; z1: number }
export interface RoadNode {
  id: number; i: number; j: number; x: number; z: number;
  edges: number[];
  /** Half-size of the intersection box. hx is the east-west extent. */
  hx: number; hz: number;
  hasLight: boolean;
  /** Phase offset in seconds so lights are not all in sync. */
  phase: number;
  /** 0 on the island, 1 on the mainland. */
  land: number;
}
export interface RoadEdge {
  id: number;
  /** Node ids. a -> b runs toward +X (horizontal) or +Z (vertical). */
  a: number; b: number;
  horiz: boolean;
  hw: number;
  /** Driving lanes per direction. */
  lanes: number;
  /** Distance between node centers. */
  len: number;
  name: string;
  /** 0 on the island, 1 on the mainland. */
  land: number;
  /** Unlock stage this street opens at (see mainland.ts STAGE_OF). 0 on the island. */
  stage: number;
  /** Not open to traffic yet: behind construction barriers, or a bridge not finished. progress.ts keeps it. */
  closed: boolean;
  /** The Perpetual Bridge as a street: no road surface of its own, no lamps, no parking. */
  deck?: boolean;
}
export interface Block {
  id: number; i: number; j: number;
  rect: Rect;
  district: District;
  /** Which sides border a real street: [north, east, south, west]. */
  road: [boolean, boolean, boolean, boolean];
  /** 0 on the island, 1 on the mainland. */
  land: number;
  /** Whether the street on each side is an avenue, in the order of `road`. */
  ave: [boolean, boolean, boolean, boolean];
}
export interface Lot {
  rect: Rect; block: number; district: District;
  /** Side facing the street: 0 north (-Z), 1 east (+X), 2 south (+Z), 3 west (-X). */
  face: number;
  interior: boolean;
}
export interface ParkSpot { x: number; z: number; h: number }
export interface Ramp { x: number; z: number; h: number; len: number; width: number; height: number }

// ── Island shape & ground height ─────────────────────────────────────────────

const ISLE_CX = 0, ISLE_CZ = -5, ISLE_HX = 680, ISLE_HZ = 505, ISLE_R = 140;

/** Signed distance to the coastline: negative on land. */
export function islandSD(x: number, z: number): number {
  const px = x - ISLE_CX, pz = z - ISLE_CZ;
  const qx = Math.abs(px) - (ISLE_HX - ISLE_R), qz = Math.abs(pz) - (ISLE_HZ - ISLE_R);
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  const sd = Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - ISLE_R;
  const th = Math.atan2(pz, px);
  return sd + 13 * Math.sin(th * 5 + 1.3) + 8 * Math.sin(th * 11 + 0.4) + 4 * Math.sin(th * 23);
}

// Decks that sit over the water. Height is the walkable surface.
export const PIER: Rect = { x0: -9, z0: 430, x1: 9, z1: 640 };
export const PIER_HEAD: Rect = { x0: -34, z0: 600, x1: 34, z1: 668 };
export const DECK_Y = 0.4;
export const BREAKWATER: Rect = { x0: 640, z0: 249, x1: 905, z1: 263 };
export const LIGHTHOUSE = { x: 905, z: 256, r: 20 };
/** The Perpetual Bridge: climbs north out of town and simply stops. z1 is where the original stub ends. */
export const BRIDGE = { x: XS[5], hw: 10, z0: -445, z1: -760, top: 15 };
/** The spans still to be built: how many, and how long each is. The last one lands on the mainland bluff. */
export const BRIDGE_SPANS = 8, BRIDGE_SPAN = 37;
const BR_STUB = BRIDGE.z0 - BRIDGE.z1, BR_FULL = BR_STUB + BRIDGE_SPANS * BRIDGE_SPAN;
/** Level across the middle of the Gap, then down to the town plateau over the last four spans. */
const BR_DOWN0 = BR_STUB + 4 * BRIDGE_SPAN, BR_DOWN1 = BR_FULL - 10;
let bridgeSpans = 0;
let bridgeEnd = BRIDGE.z1;

/** Height of the bridge deck `a` meters north of its foot, whether or not that part is built yet. */
export function bridgeY(a: number): number {
  if (a <= BR_STUB) return BRIDGE.top * smooth(a / (BR_STUB - 20));
  if (a <= BR_DOWN0) return BRIDGE.top;
  return BRIDGE.top - (BRIDGE.top - MAIN_Y) * smooth((a - BR_DOWN0) / (BR_DOWN1 - BR_DOWN0));
}
/** Z of the north end of what is built. */
export const bridgeEndZ = (): number => bridgeEnd;
export const bridgeBuilt = (): number => bridgeSpans;
/** Length of the built bridge from its foot, meters. */
export const bridgeLen = (): number => BRIDGE.z0 - bridgeEnd;

export const RAMPS: Ramp[] = [
  { x: -120, z: 452, h: Math.PI / 2, len: 9, width: 6, height: 2.6 },     // beach
  { x: 505, z: 345, h: Math.PI, len: 10, width: 7, height: 3 },           // container yard
  { x: 150, z: -150, h: Math.PI / 2, len: 9, width: 6, height: 2.4 },     // over the park pond
  // A low kicker: the lot is 84 m deep, and a full-size ramp put every landing into the shopfronts across Ledger St.
  { x: -540, z: -86, h: 0, len: 8, width: 6, height: 1.6 },               // arena lot
  { x: -430, z: 296.6, h: -Math.PI / 2, len: 10, width: 6, height: 3 },   // cannery: in the roadway, clear of the curb at z 300
  // Far enough down the pier that the tow truck the game starts you in (57 mph here, 40 m of air) clears the end.
  { x: 0, z: 626, h: 0, len: 8, width: 7, height: 2.2 },                  // pier
  { x: XS[5], z: -744, h: Math.PI, len: 14, width: 18, height: 3.4 },     // the end of the bridge
];
export const BRIDGE_RAMP = RAMPS.length - 1;

/**
 * Set how many of the new spans exist (0 = the old stub, BRIDGE_SPANS = finished). The stunt ramp rides
 * the broken end outward and is taken away when the road goes through. Only progress.ts calls this.
 */
export function setBridgeSpans(n: number): void {
  bridgeSpans = clamp(Math.round(n), 0, BRIDGE_SPANS);
  bridgeEnd = BRIDGE.z1 - bridgeSpans * BRIDGE_SPAN;
  const r = RAMPS[BRIDGE_RAMP], done = bridgeSpans >= BRIDGE_SPANS;
  // Parked far away rather than removed: other files index this list.
  r.x = done ? 99999 : BRIDGE.x;
  r.z = done ? 99999 : bridgeEnd + 16;
}

function rampHeight(x: number, z: number): number {
  let best = 0;
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z;
    // Cheap reject, sized per ramp: a fixed radius cut the top and the edges off the 18 m bridge ramp.
    if (dx * dx + dz * dz > r.len * r.len + r.width * r.width * 0.25 + 1) continue;
    const s = Math.sin(r.h), c = Math.cos(r.h);
    const along = dx * s + dz * c;      // 0 at the low lip, len at the tall end
    const side = dx * -c + dz * s;
    if (along < 0 || along > r.len || Math.abs(side) > r.width / 2) continue;
    best = Math.max(best, (along / r.len) * r.height);
  }
  return best;
}

/** True in the corridor a ramp is used along: 70 m of run-up, 60 m of landing, a little wider than the ramp. */
function inRampLane(x: number, z: number): boolean {
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z, s = Math.sin(r.h), c = Math.cos(r.h);
    const along = dx * s + dz * c;
    if (along > -70 && along < r.len + 60 && Math.abs(dx * -c + dz * s) < r.width / 2 + 2) return true;
  }
  return false;
}

/** Block footprints, filled in by CityPlan, so groundAt() can raise them by a curb. */
const BLOCK_RECTS: Rect[] = [];
/** The same for the mainland's cells: a rect for a block, null for open ground (the river's column, Lesser Tepid). */
const M_RECTS: (Rect | null)[] = [];
const MNJ = MZS.length - 1;

const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/** Height of the natural ground (no decks or ramps), used to build the terrain mesh. */
export function terrainAt(x: number, z: number): number {
  if (z < MAIN_SPLIT_Z) return mainlandTerrain(x, z);
  const sd = islandSD(x, z);
  if (sd < -26) return 0;
  if (sd < 40) return -3.4 * smooth((sd + 26) / 66);
  return -3.4 - Math.min((sd - 40) * 0.06, 6);
}

/** Height of whatever you would stand or drive on at (x, z). */
/** Extra ground laid on top of the plan's (the stunt park's ramps, world/stuntPark.ts); null until something sets it. */
let groundExtra: ((x: number, z: number, base: number) => number) | null = null;
export function setGroundExtra(f: ((x: number, z: number, base: number) => number) | null): void { groundExtra = f; }

export function groundAt(x: number, z: number): number {
  const b = groundBase(x, z);
  return groundExtra === null ? b : groundExtra(x, z, b);
}

function groundBase(x: number, z: number): number {
  // Fast path: the flat city core. City blocks sit one curb-height above the streets.
  if (x > -610 && x < 610 && z > -440 && z < 410) {
    let h = 0;
    if (x > XS[0] && x < XS[XS.length - 1] && z > ZS[0] && z < ZS[ZS.length - 1]) {
      let i = 0, j = 0;
      while (x > XS[i + 1]) i++;
      while (z > ZS[j + 1]) j++;
      const r = BLOCK_RECTS[i * (ZS.length - 1) + j];
      if (r && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) h = CURB;
    }
    return h + rampHeight(x, z);
  }
  if (Math.abs(x - BRIDGE.x) <= BRIDGE.hw && z <= BRIDGE.z0 && z >= bridgeEnd) {
    return bridgeY(BRIDGE.z0 - z) + rampHeight(x, z);
  }
  if (z < MAIN_SPLIT_Z) return mainGroundAt(x, z);
  let deck = -99;
  if (inRect(PIER, x, z)) deck = DECK_Y * clamp((z - PIER.z0) / 10, 0, 1);
  if (inRect(PIER_HEAD, x, z)) deck = DECK_Y;
  if (inRect(BREAKWATER, x, z)) deck = DECK_Y * clamp((x - BREAKWATER.x0) / 12, 0, 1);
  const lx = x - LIGHTHOUSE.x, lz = z - LIGHTHOUSE.z;
  if (lx * lx + lz * lz < LIGHTHOUSE.r * LIGHTHOUSE.r) deck = DECK_Y;
  const t = terrainAt(x, z);
  const base = Math.max(t, deck);
  return base > -0.5 ? Math.max(base, base + rampHeight(x, z)) : base;
}

/**
 * The mainland's share of groundAt(). Inside the street grid it is one cell lookup: the town is flat at
 * MAIN_Y, blocks a curb higher. The only relief there is Dithers Hill, added for the campus cells alone
 * (a rounded-rectangle distance and one smoothstep). Off the grid, and in the river's column, it is the
 * three decks and then the natural terrain, which costs about what the island's beach does.
 */
function mainGroundAt(x: number, z: number): number {
  if (x > MXS[0] && x < MXS[MXS.length - 1] && z > MZS[0] && z < MZS[MNJ]) {
    let i = 0, j = 0;
    while (x > MXS[i + 1]) i++;
    while (z > MZS[j + 1]) j++;
    const r = M_RECTS[i * MNJ + j];
    if (r !== null) {
      let h = MAIN_Y;
      if (i <= 2 && j >= 2 && j <= 4) h += hillAt(x, z);
      if (r && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) h += CURB;
      return h;
    }
  }
  for (const d of DECKS) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return MAIN_Y;
  return mainlandTerrain(x, z);
}

/** Height a road, a lamp's light pool or a painted line lies at: the ground without any curb or ramp. */
export function roadY(x: number, z: number): number {
  return z < MAIN_SPLIT_Z ? MAIN_Y + hillAt(x, z) : 0;
}

/** True where the surface is under water deep enough to swim / sink in. */
export const isWater = (x: number, z: number): boolean => groundAt(x, z) < WATER_Y - 0.35;

// ── The plan ─────────────────────────────────────────────────────────────────

function cellDistrict(i: number, j: number): District {
  if ((i === 6 || i === 7) && (j === 2 || j === 3)) return 'park';
  if ((i === 0 || i === 1) && j === 3) return 'arena';
  if (j <= 1) return 'suburb';
  if (i >= 8) return j >= 6 ? 'port' : 'oldtown';
  if (i <= 2) return j >= 5 ? 'industrial' : 'midtown';
  if (j >= 6) return 'strand';
  return 'downtown';
}

const LOT_SIZE: Record<District, [number, number]> = {
  downtown: [50, 26], midtown: [40, 20], oldtown: [30, 15], suburb: [32, 21],
  industrial: [70, 34], port: [80, 40], strand: [44, 20], park: [999, 999], arena: [999, 999],
  mill: [64, 30], main: [40, 20], square: [999, 999], stacks: [28, 14], college: [130, 60],
  yard: [90, 40], exits: [60, 30], lake: [999, 999], sister: [999, 999],
};

const mhwX = (i: number): number => (M_AVE_X.includes(i) ? AVE_HW : ST_HW);
const mhwZ = (j: number): number => (M_AVE_Z.includes(j) ? AVE_HW : ST_HW);
const cellStage = (i: number, j: number): number =>
  i < 0 || j < 0 || i >= MXS.length - 1 || j >= MNJ ? 99 : STAGE_OF[mCell(i, j).d];

export class CityPlan {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  blocks: Block[] = [];
  lots: Lot[] = [];
  parking: ParkSpot[] = [];
  /** node id by grid position, -1 where no intersection exists. */
  private grid: number[][] = [];
  private mgrid: number[][] = [];
  /** block id of each mainland cell, -1 for open ground. */
  private mblock: number[] = [];
  /** The mainland's lots: laid out and tagged with their district, with nothing built on them yet. block is -1 for the sites off the grid. */
  mainlandLots: Lot[] = [];
  /** Curb-side spots on the mainland. Kept apart from `parking`: nothing is parked there until the player is near. */
  mainlandParking: ParkSpot[] = [];
  /** How many of the nodes, edges and blocks are the island's: they come first in each list. */
  readonly isle = { nodes: 0, edges: 0, blocks: 0 };
  /** The Perpetual Bridge as a street, from Gull Heights Rd to Front St. Closed until the last span is in. */
  bridgeEdge = -1;
  /** The streets of one land, for anything that picks a street near the player. */
  private isleEdges: RoadEdge[] = [];
  private mainEdges: RoadEdge[] = [];
  readonly bounds: Rect = { x0: -960, z0: -2330, x1: 1010, z1: 760 };

  constructor(seed = 1887) {
    this.buildGraph();
    this.buildBlocks(new RNG(seed));
    this.buildParking(new RNG(seed + 7));
    this.isle.nodes = this.nodes.length; this.isle.edges = this.edges.length; this.isle.blocks = this.blocks.length;
    this.isleEdges = this.edges.slice();
    this.buildMainland(new RNG(seed + 101));
    this.mainEdges = this.edges.filter((e) => e.land === 1 && !e.deck);
  }

  /** Streets to choose from for somebody standing at z: the island's or the mainland's. */
  landEdges(z: number): readonly RoadEdge[] { return z < MAIN_SPLIT_Z ? this.mainEdges : this.isleEdges; }

  private buildGraph(): void {
    for (let i = 0; i < XS.length; i++) {
      this.grid.push([]);
      for (let j = 0; j < ZS.length; j++) {
        const hasV = vSeg(i, j - 1) || vSeg(i, j);
        const hasH = hSeg(i - 1, j) || hSeg(i, j);
        if (!hasV && !hasH) { this.grid[i].push(-1); continue; }
        const id = this.nodes.length;
        this.grid[i].push(id);
        this.nodes.push({
          id, i, j, x: XS[i], z: ZS[j], edges: [],
          hx: hasV ? hwX(i) : 0, hz: hasH ? hwZ(j) : 0,
          hasLight: false, phase: ((i * 7 + j * 13) % 9) * 2.5, land: 0,
        });
      }
    }
    const add = (a: number, b: number, horiz: boolean, hw: number, name: string): void => {
      const A = this.nodes[a], B = this.nodes[b];
      const id = this.edges.length;
      this.edges.push({ id, a, b, horiz, hw, lanes: hw === AVE_HW ? 2 : 1, len: horiz ? B.x - A.x : B.z - A.z, name, land: 0, stage: 0, closed: false });
      A.edges.push(id); B.edges.push(id);
    };
    for (let i = 0; i < XS.length; i++)
      for (let j = 0; j < ZS.length - 1; j++)
        if (vSeg(i, j)) add(this.grid[i][j], this.grid[i][j + 1], false, hwX(i), NS_NAMES[i]);
    for (let j = 0; j < ZS.length; j++)
      for (let i = 0; i < XS.length - 1; i++)
        if (hSeg(i, j)) add(this.grid[i][j], this.grid[i + 1][j], true, hwZ(j), EW_NAMES[j]);
    for (const n of this.nodes) n.hasLight = n.edges.length >= 3;
  }

  private buildBlocks(rng: RNG): void {
    for (let i = 0; i < XS.length - 1; i++) {
      for (let j = 0; j < ZS.length - 1; j++) {
        const road: [boolean, boolean, boolean, boolean] = [hSeg(i, j), vSeg(i + 1, j), hSeg(i, j + 1), vSeg(i, j)];
        const rect: Rect = {
          x0: XS[i] + (road[3] ? hwX(i) : 0),
          x1: XS[i + 1] - (road[1] ? hwX(i + 1) : 0),
          z0: ZS[j] + (road[0] ? hwZ(j) : 0),
          z1: ZS[j + 1] - (road[2] ? hwZ(j + 1) : 0),
        };
        const district = cellDistrict(i, j);
        const ave: Block['ave'] = [hwZ(j) === AVE_HW, hwX(i + 1) === AVE_HW, hwZ(j + 1) === AVE_HW, hwX(i) === AVE_HW];
        const block: Block = { id: this.blocks.length, i, j, rect, district, road, land: 0, ave };
        this.blocks.push(block);
        BLOCK_RECTS[block.id] = rect;
        if (district === 'park' || district === 'arena') continue;
        const inner: Rect = {
          x0: rect.x0 + (road[3] ? SIDEWALK : 0), x1: rect.x1 - (road[1] ? SIDEWALK : 0),
          z0: rect.z0 + (road[0] ? SIDEWALK : 0), z1: rect.z1 - (road[2] ? SIDEWALK : 0),
        };
        const [maxS, minS] = LOT_SIZE[district];
        const out: Rect[] = [];
        this.split(inner, rng, maxS, minS, out);
        for (const r of out) {
          const d = [r.z0 - inner.z0, inner.x1 - r.x1, inner.z1 - r.z1, r.x0 - inner.x0];
          let face = 0;
          for (let k = 1; k < 4; k++) if (d[k] < d[face] - 0.01 || (Math.abs(d[k] - d[face]) < 0.01 && rng.chance(0.5))) face = k;
          this.lots.push({ rect: r, block: block.id, district, face, interior: d[face] > 1 });
        }
      }
    }
  }

  private split(r: Rect, rng: RNG, maxS: number, minS: number, out: Rect[]): void {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    if ((w <= maxS && d <= maxS) || (w >= d ? w < minS * 2 : d < minS * 2)) { out.push(r); return; }
    if (w >= d) {
      const c = clamp(r.x0 + w * rng.range(0.38, 0.62), r.x0 + minS, r.x1 - minS);
      this.split({ ...r, x1: c }, rng, maxS, minS, out);
      this.split({ ...r, x0: c }, rng, maxS, minS, out);
    } else {
      const c = clamp(r.z0 + d * rng.range(0.38, 0.62), r.z0 + minS, r.z1 - minS);
      this.split({ ...r, z1: c }, rng, maxS, minS, out);
      this.split({ ...r, z0: c }, rng, maxS, minS, out);
    }
  }

  /** Tepid Falls: the same structures as the island's, appended after them. */
  private buildMainland(rng: RNG): void {
    const NX = MXS.length, NZ = MZS.length, n0 = this.nodes.length, e0 = this.edges.length;
    for (let i = 0; i < NX; i++) {
      this.mgrid.push([]);
      for (let j = 0; j < NZ; j++) {
        const hasV = mvSeg(i, j - 1) || mvSeg(i, j);
        const hasH = mhSeg(i - 1, j) || mhSeg(i, j);
        if (!hasV && !hasH) { this.mgrid[i].push(-1); continue; }
        const id = this.nodes.length;
        this.mgrid[i].push(id);
        this.nodes.push({
          id, i: i + MI0, j: j + MJ0, x: MXS[i], z: MZS[j], edges: [],
          hx: hasV ? mhwX(i) : 0, hz: hasH ? mhwZ(j) : 0,
          hasLight: false, phase: ((i * 5 + j * 11) % 9) * 2.5, land: 1,
        });
      }
    }
    const add = (a: number, b: number, horiz: boolean, hw: number, name: string, stage: number): void => {
      const A = this.nodes[a], B = this.nodes[b];
      const id = this.edges.length;
      this.edges.push({ id, a, b, horiz, hw, lanes: hw === AVE_HW ? 2 : 1, len: horiz ? B.x - A.x : B.z - A.z, name, land: 1, stage, closed: true });
      A.edges.push(id); B.edges.push(id);
    };
    for (let i = 0; i < NX; i++)
      for (let j = 0; j < NZ - 1; j++)
        if (mvSeg(i, j)) add(this.mgrid[i][j], this.mgrid[i][j + 1], false, mhwX(i), M_NS_NAMES[i], STAGE_OVERRIDE[`v:${i}:${j}`] ?? Math.min(cellStage(i - 1, j), cellStage(i, j)));
    for (let j = 0; j < NZ; j++)
      for (let i = 0; i < NX - 1; i++)
        if (mhSeg(i, j)) add(this.mgrid[i][j], this.mgrid[i + 1][j], true, mhwZ(j), M_EW_NAMES[j], STAGE_OVERRIDE[`h:${i}:${j}`] ?? Math.min(cellStage(i, j - 1), cellStage(i, j)));
    for (let k = n0; k < this.nodes.length; k++) this.nodes[k].hasLight = this.nodes[k].edges.length >= 3;

    // The bridge, as one long street between the two grids. Edges run toward +Z, so a is the mainland end.
    const south = this.grid[5][0], north = this.mgrid[6][NZ - 1];
    this.bridgeEdge = this.edges.length;
    this.edges.push({
      id: this.bridgeEdge, a: north, b: south, horiz: false, hw: BRIDGE.hw, lanes: 2,
      len: this.nodes[south].z - this.nodes[north].z, name: 'The Perpetual Bridge', land: 1, stage: 0, closed: true, deck: true,
    });
    this.nodes[north].edges.push(this.bridgeEdge); this.nodes[south].edges.push(this.bridgeEdge);

    for (let i = 0; i < NX - 1; i++) {
      for (let j = 0; j < NZ - 1; j++) {
        const cell = mCell(i, j);
        if (!cell.block) { M_RECTS[i * MNJ + j] = null; this.mblock.push(-1); continue; }
        const road: [boolean, boolean, boolean, boolean] = [mhSeg(i, j), mvSeg(i + 1, j), mhSeg(i, j + 1), mvSeg(i, j)];
        const rect: Rect = {
          x0: MXS[i] + (road[3] ? mhwX(i) : 0),
          x1: MXS[i + 1] - (road[1] ? mhwX(i + 1) : 0),
          z0: MZS[j] + (road[0] ? mhwZ(j) : 0),
          z1: MZS[j + 1] - (road[2] ? mhwZ(j + 1) : 0),
        };
        const ave: Block['ave'] = [mhwZ(j) === AVE_HW, mhwX(i + 1) === AVE_HW, mhwZ(j + 1) === AVE_HW, mhwX(i) === AVE_HW];
        const block: Block = { id: this.blocks.length, i: i + MI0, j: j + MJ0, rect, district: cell.d, road, land: 1, ave };
        this.blocks.push(block);
        this.mblock.push(block.id);
        M_RECTS[i * MNJ + j] = rect;
        // Pardon's (pardonsStore.ts) has the exits block by Second Thought Ave: no lots for the other builders there.
        if (cell.d === 'square' || PD.CELLS.some(([a, b]) => a === i && b === j)) continue;
        const inner: Rect = {
          x0: rect.x0 + (road[3] ? SIDEWALK : 0), x1: rect.x1 - (road[1] ? SIDEWALK : 0),
          z0: rect.z0 + (road[0] ? SIDEWALK : 0), z1: rect.z1 - (road[2] ? SIDEWALK : 0),
        };
        // The railway crosses its row of blocks: lots are laid out either side of the track bed, never on it.
        const parts: Rect[] = inner.z0 < RAIL.z && inner.z1 > RAIL.z && inner.x1 > RAIL.x0
          ? [{ ...inner, z1: RAIL.z - RAIL.hw }, { ...inner, z0: RAIL.z + RAIL.hw }] : [inner];
        const [maxS, minS] = LOT_SIZE[cell.d];
        for (const part of parts) {
          const out: Rect[] = [];
          this.split(part, rng, maxS, minS, out);
          for (const r of out) {
            const d = [r.z0 - inner.z0, inner.x1 - r.x1, inner.z1 - r.z1, r.x0 - inner.x0];
            let face = -1;
            // Face the nearest side that has a street; a lot with none is an interior one.
            for (let k = 0; k < 4; k++) if (road[k] && (face < 0 || d[k] < d[face] - 0.01)) face = k;
            if (face < 0) face = 0;
            this.mainlandLots.push({ rect: r, block: block.id, district: cell.d, face, interior: !road[face] || d[face] > 1 });
          }
        }
      }
    }
    for (const s of pardonsStalls()) this.mainlandParking.push(s);
    for (const x of EXTRA_LOTS) this.mainlandLots.push({ rect: x.rect, block: -1, district: x.district, face: x.face, interior: false });

    const prng = new RNG(8842);
    for (let k = e0; k < this.edges.length; k++) {
      const e = this.edges[k];
      if (e.deck) continue;
      const A = this.nodes[e.a], B = this.nodes[e.b];
      const off = e.hw - 1.35;
      const start = (e.horiz ? A.hx : A.hz) + 14, end = e.len - (e.horiz ? B.hx : B.hz) - 14;
      for (let s = start; s < end; s += 6.6) {
        for (const side of [-1, 1]) {
          if (!prng.chance(0.2)) continue;
          const x = e.horiz ? A.x + s : A.x - side * off, z = e.horiz ? A.z + side * off : A.z + s;
          // Nobody parks on a bridge, on the tracks, or on the steep of the hill.
          if (Math.abs(waterDist(x, z)) < 40 || Math.abs(z - RAIL.z) < 12) continue;
          const hh = hillAt(x, z);
          if (hh > 0.3 && hh < 11.7) continue;
          if (e.horiz) this.mainlandParking.push({ x, z, h: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
          else this.mainlandParking.push({ x, z, h: side > 0 ? 0 : Math.PI });
        }
      }
    }
  }

  private buildParking(rng: RNG): void {
    for (const e of this.edges) {
      const A = this.nodes[e.a], B = this.nodes[e.b];
      const off = e.hw - 1.35;
      const start = (e.horiz ? A.hx : A.hz) + 14, end = e.len - (e.horiz ? B.hx : B.hz) - 14;
      for (let s = start; s < end; s += 6.6) {
        for (const side of [-1, 1]) {
          if (!rng.chance(0.2)) continue;
          // Nobody parks in the run-up to a stunt ramp, or where the car comes down.
          if (inRampLane(e.horiz ? A.x + s : A.x - side * off, e.horiz ? A.z + side * off : A.z + s)) continue;
          // side +1 = the lane travelling a->b (which keeps to the right of travel).
          // Travelling +X the right-hand side is +Z; travelling +Z it is -X.
          if (e.horiz) this.parking.push({ x: A.x + s, z: A.z + side * off, h: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
          else this.parking.push({ x: A.x - side * off, z: A.z + s, h: side > 0 ? 0 : Math.PI });
        }
      }
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  nodeAt(i: number, j: number): RoadNode | null {
    const id = i >= MI0 ? this.mgrid[i - MI0]?.[j - MJ0] : this.grid[i]?.[j];
    return id === undefined || id < 0 ? null : this.nodes[id];
  }

  /** The block in grid cell (i, j) of either land, or null: off the grid, or open ground. */
  blockAt(i: number, j: number): Block | null {
    if (i >= MI0) {
      const mi = i - MI0, mj = j - MJ0;
      if (mi < 0 || mj < 0 || mi >= MXS.length - 1 || mj >= MNJ) return null;
      const id = this.mblock[mi * MNJ + mj];
      return id < 0 ? null : this.blocks[id];
    }
    if (i < 0 || j < 0 || i >= XS.length - 1 || j >= ZS.length - 1) return null;
    return this.blocks[i * (ZS.length - 1) + j];
  }

  /** The block whose grid cell holds the point, clamped to the edge cells of whichever land it is on. */
  blockAtPoint(x: number, z: number): Block | null {
    let i = 0, j = 0;
    if (z < MAIN_SPLIT_Z) {
      while (i < MXS.length - 2 && x > MXS[i + 1]) i++;
      while (j < MNJ - 1 && z > MZS[j + 1]) j++;
      return this.blockAt(i + MI0, j + MJ0);
    }
    while (i < XS.length - 2 && x > XS[i + 1]) i++;
    while (j < ZS.length - 2 && z > ZS[j + 1]) j++;
    return this.blockAt(i, j);
  }

  /** Other end of an edge. */
  other(e: RoadEdge, nodeId: number): number { return e.a === nodeId ? e.b : e.a; }

  /** District under a point, or null outside the street grid. */
  districtAt(x: number, z: number): District | null {
    if (z < MAIN_SPLIT_Z) {
      if (x >= MXS[0] - 12 && x <= MXS[MXS.length - 1] + 8 && z >= MZS[0] - 8 && z <= MZS[MNJ] + 8) {
        let i = 0, j = 0;
        while (i < MXS.length - 2 && x > MXS[i + 1]) i++;
        while (j < MNJ - 1 && z > MZS[j + 1]) j++;
        return mCell(i, j).d;
      }
      // Off the grid: water and beach belong to nobody; dry land is the far bank or the countryside.
      if (coastSD(x, z) > -20 || waterDist(x, z) < 0) return null;
      if (x > riverX(z) && z > -1560) return 'sister';
      // The strip between Front St and the bluff is the landing, named by placeName().
      return z > MZS[MNJ] ? null : 'lake';
    }
    if (x < XS[0] - 8 || x > XS[XS.length - 1] + 8 || z < ZS[0] - 8 || z > ZS[ZS.length - 1] + 8) return null;
    let i = 0, j = 0;
    while (i < XS.length - 2 && x > XS[i + 1]) i++;
    while (j < ZS.length - 2 && z > ZS[j + 1]) j++;
    return cellDistrict(i, j);
  }

  /** Name of a place for the HUD, including spots off the grid. */
  placeName(x: number, z: number): string {
    const d = this.districtAt(x, z);
    if (Math.abs(x - BRIDGE.x) < 14 && z < BRIDGE.z0 && z > bridgeEnd - 2) return 'The Perpetual Bridge';
    if (d) return DISTRICT_NAME[d];
    if (z < MAIN_SPLIT_Z) {
      const w = waterDist(x, z);
      if (w < 3) {
        if (x < -740) return z < -1960 && Math.abs(x - LAKE.x) < 110 ? 'Lake Indecision' : 'Afterthought Stream';
        return Math.abs(x - riverX(z)) < RIVER_HW + 4 ? 'The Muddle River' : 'Sidle Brook';
      }
      if (isWater(x, z)) return 'The Budget Gap';
      return z > MZS[MNJ] ? 'Tepid Landing' : 'The Far Shore';
    }
    if (z > 425 && Math.abs(x) < 40) return 'Pelican Pier';
    if (x > 630 && Math.abs(z - 256) < 30) return 'Last Light Breakwater';
    if (isWater(x, z)) return 'Calamity Sound';
    return z > 300 ? 'Low Tide Beach' : 'The Shoreline';
  }

  /** Nearest street name to a point. */
  streetAt(x: number, z: number): string {
    let best = '', bd = 1e9;
    if (z < MAIN_SPLIT_Z) {
      // Only streets that exist beside the point: this grid has long gaps (the campus, the river).
      for (const e of this.mainEdges) {
        const A = this.nodes[e.a];
        const s = clamp(e.horiz ? x - A.x : z - A.z, 0, e.len);
        const d = Math.abs(e.horiz ? x - A.x - s : x - A.x) + Math.abs(e.horiz ? z - A.z : z - A.z - s);
        if (d < bd) { bd = d; best = e.name; }
      }
      return best;
    }
    for (let i = 0; i < XS.length; i++) { const d = Math.abs(x - XS[i]); if (d < bd) { bd = d; best = NS_NAMES[i]; } }
    for (let j = 0; j < ZS.length; j++) { const d = Math.abs(z - ZS[j]); if (d < bd) { bd = d; best = EW_NAMES[j]; } }
    return best;
  }

  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0], bd = Infinity;
    for (const n of this.nodes) {
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** Closest point on any street centerline. Returns the edge and distance along it from node a. */
  nearestEdge(x: number, z: number): { edge: RoadEdge; s: number; d: number } {
    let best = this.edges[0], bs = 0, bd = Infinity;
    for (const e of this.edges) {
      const A = this.nodes[e.a];
      const s = clamp(e.horiz ? x - A.x : z - A.z, 0, e.len);
      const px = e.horiz ? A.x + s : A.x, pz = e.horiz ? A.z : A.z + s;
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; best = e; bs = s; }
    }
    return { edge: best, s: bs, d: Math.sqrt(bd) };
  }

  /** Shortest route between two intersections (A*). Returns node ids including both ends. */
  findPath(from: number, to: number): number[] {
    if (from === to) return [from];
    const N = this.nodes.length;
    const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const T = this.nodes[to];
    const open: number[] = [from];
    g[from] = 0;
    const hcost = (id: number): number => Math.abs(this.nodes[id].x - T.x) + Math.abs(this.nodes[id].z - T.z);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (g[open[k]] + hcost(open[k]) < g[open[bi]] + hcost(open[bi])) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur === to) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      for (const eid of this.nodes[cur].edges) {
        const e = this.edges[eid], nb = this.other(e, cur);
        if (closed[nb] || e.closed) continue;
        const ng = g[cur] + e.len / (e.lanes === 2 ? 1.15 : 1);
        if (ng < g[nb]) { g[nb] = ng; came[nb] = cur; open.push(nb); }
      }
    }
    const path: number[] = [];
    for (let c = to; c !== -1; c = came[c]) { path.push(c); if (c === from) break; }
    if (path[path.length - 1] !== from) return [from];
    return path.reverse();
  }

  /** A point on the sidewalk of block (i, j), a fraction `t` along one of its sides. */
  sidewalkPoint(i: number, j: number, side: number, t = 0.5): { x: number; z: number; h: number } {
    const b = this.blockAt(i, j) ?? this.blocks[0];
    const r = b.rect, m = SIDEWALK * 0.5;
    switch (side) {
      case 0: return { x: r.x0 + (r.x1 - r.x0) * t, z: r.z0 + m, h: Math.PI };
      case 1: return { x: r.x1 - m, z: r.z0 + (r.z1 - r.z0) * t, h: Math.PI / 2 };
      case 2: return { x: r.x0 + (r.x1 - r.x0) * t, z: r.z1 - m, h: 0 };
      default: return { x: r.x0 + m, z: r.z0 + (r.z1 - r.z0) * t, h: -Math.PI / 2 };
    }
  }

  /** A point in the driving lane next to a block's sidewalk: handy for spawning vehicles. */
  curbPoint(i: number, j: number, side: number, t = 0.5): { x: number; z: number; h: number } {
    const p = this.sidewalkPoint(i, j, side, t);
    const o = SIDEWALK * 0.5 + 1.4;
    switch (side) {
      // Parked facing the direction of travel on that side of the street.
      case 0: return { x: p.x, z: p.z - o, h: Math.PI / 2 };
      case 1: return { x: p.x + o, z: p.z, h: 0 };
      case 2: return { x: p.x, z: p.z + o, h: -Math.PI / 2 };
      default: return { x: p.x - o, z: p.z, h: Math.PI };
    }
  }
}
