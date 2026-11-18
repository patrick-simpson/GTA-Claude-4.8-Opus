// The city plan: pure data, no rendering. Everything else (meshes, traffic,
// pedestrians, the minimap, missions) reads the same plan, so they always agree.
//
// Port Calamity is an island. Streets form an uneven grid; a few segments are
// removed to make room for a park, an arena and a container yard.

import { RNG, clamp, smooth } from '../core/util';

export type District =
  | 'downtown' | 'midtown' | 'oldtown' | 'suburb' | 'industrial' | 'port' | 'strand' | 'park' | 'arena';

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
}
export interface Block {
  id: number; i: number; j: number;
  rect: Rect;
  district: District;
  /** Which sides border a real street: [north, east, south, west]. */
  road: [boolean, boolean, boolean, boolean];
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
/** The Perpetual Bridge: climbs north out of town and simply stops. */
export const BRIDGE = { x: XS[5], hw: 10, z0: -445, z1: -760, top: 15 };

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

const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/** Height of the natural ground (no decks or ramps), used to build the terrain mesh. */
export function terrainAt(x: number, z: number): number {
  const sd = islandSD(x, z);
  if (sd < -26) return 0;
  if (sd < 40) return -3.4 * smooth((sd + 26) / 66);
  return -3.4 - Math.min((sd - 40) * 0.06, 6);
}

/** Height of whatever you would stand or drive on at (x, z). */
export function groundAt(x: number, z: number): number {
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
  if (Math.abs(x - BRIDGE.x) <= BRIDGE.hw && z <= BRIDGE.z0 && z >= BRIDGE.z1) {
    return BRIDGE.top * smooth((BRIDGE.z0 - z) / (BRIDGE.z0 - BRIDGE.z1 - 20)) + rampHeight(x, z);
  }
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
};

export class CityPlan {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  blocks: Block[] = [];
  lots: Lot[] = [];
  parking: ParkSpot[] = [];
  /** node id by grid position, -1 where no intersection exists. */
  private grid: number[][] = [];
  readonly bounds: Rect = { x0: -960, z0: -900, x1: 1010, z1: 760 };

  constructor(seed = 1887) {
    this.buildGraph();
    this.buildBlocks(new RNG(seed));
    this.buildParking(new RNG(seed + 7));
  }

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
          hasLight: false, phase: ((i * 7 + j * 13) % 9) * 2.5,
        });
      }
    }
    const add = (a: number, b: number, horiz: boolean, hw: number, name: string): void => {
      const A = this.nodes[a], B = this.nodes[b];
      const id = this.edges.length;
      this.edges.push({ id, a, b, horiz, hw, lanes: hw === AVE_HW ? 2 : 1, len: horiz ? B.x - A.x : B.z - A.z, name });
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
        const block: Block = { id: this.blocks.length, i, j, rect, district, road };
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
    const id = this.grid[i]?.[j];
    return id === undefined || id < 0 ? null : this.nodes[id];
  }

  /** Other end of an edge. */
  other(e: RoadEdge, nodeId: number): number { return e.a === nodeId ? e.b : e.a; }

  /** District under a point, or null outside the street grid. */
  districtAt(x: number, z: number): District | null {
    if (x < XS[0] - 8 || x > XS[XS.length - 1] + 8 || z < ZS[0] - 8 || z > ZS[ZS.length - 1] + 8) return null;
    let i = 0, j = 0;
    while (i < XS.length - 2 && x > XS[i + 1]) i++;
    while (j < ZS.length - 2 && z > ZS[j + 1]) j++;
    return cellDistrict(i, j);
  }

  /** Name of a place for the HUD, including spots off the grid. */
  placeName(x: number, z: number): string {
    const d = this.districtAt(x, z);
    if (d) return DISTRICT_NAME[d];
    if (Math.abs(x - BRIDGE.x) < 14 && z < BRIDGE.z0) return 'The Perpetual Bridge';
    if (z > 425 && Math.abs(x) < 40) return 'Pelican Pier';
    if (x > 630 && Math.abs(z - 256) < 30) return 'Last Light Breakwater';
    if (isWater(x, z)) return 'Calamity Sound';
    return z > 300 ? 'Low Tide Beach' : 'The Shoreline';
  }

  /** Nearest street name to a point. */
  streetAt(x: number, z: number): string {
    let best = '', bd = 1e9;
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
        if (closed[nb]) continue;
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
    const b = this.blocks[i * (ZS.length - 1) + j];
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
