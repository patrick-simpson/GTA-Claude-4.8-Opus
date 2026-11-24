// The business directory, placed: every named place in Tepid Falls (directory.ts, plus the game's own landmarks) given a
// building and a door.
//
// Placement runs at load, against whatever buildings the town has then: the lots the mainland builder stands buildings on
// (mainlandLots), Dithers College's buildings (dithersPlan.ts) and the hand-fixed landmarks below. A business goes to the
// nearest building within SNAP metres of where it stands in the real town, with its door on the street side of that building,
// at the spot nearest the business; further than that it is "unplaced" and left off the map until a building is there (a later
// pass that adds buildings needs no change here). Places on open ground (parks, pitches, car parks) are placed when a street
// is near. Signs: world/shopSigns.ts.

import { CATEGORIES, CATEGORY_NAME, DIRECTORY, type Category } from './directory';
import { mainlandLots } from './mainlandBuildings';
import { CAMPUS_BUILDINGS } from './dithersPlan';
import { CIVIC } from './civicAssets';
import { HQ } from './speedscanHQ';
import { STREETS_NEW } from './streets';
import { groundAt, type CityPlan } from './plan';

export { CATEGORIES, CATEGORY_NAME };
export type { Category };

/** How far from a building a business may stand and still be given it. */
export const SNAP = 30;
/** How close to the door counts as arrived. */
export const ARRIVE = 15;

export interface Place {
  id: number;
  name: string;
  cat: Category;
  /** The door: on the sidewalk side of the building (the spot itself, for open ground). */
  x: number; z: number;
  /** Which way the front faces (unit, outward), and the wall's foot: where the sign is hung. */
  nx: number; nz: number; wx: number; wz: number;
  /** Where the real town had it, kept so a later pass can re-snap. */
  rx: number; rz: number;
  placed: boolean;
  /** Open ground: no building, no sign. */
  open: boolean;
  /** One of the game's own places (Pardon's, the Dead Letter Office, Dithers' halls), not from the street directory. */
  game: boolean;
  /** Hang a blade sign on the wall. */
  sign: boolean;
  /** The building it was snapped to, for the report. */
  at: string;
}

interface Bld { name: string; cx: number; cz: number; kind: 'lot' | 'campus'; x0: number; z0: number; x1: number; z1: number; face: number; w: number; d: number; a: number; pen: number }

const dirOf = (face: number): [number, number] => (face === 0 ? [0, -1] : face === 1 ? [1, 0] : face === 2 ? [0, 1] : [-1, 0]);

/** The game's own landmarks: [name, category, door x, door z, front normal x, z]. Doors are on the street side. */
function landmarks(): [string, Category, number, number, number, number][] {
  const L = CIVIC.ladyNew, d = CIVIC.dlo;
  const out: [string, Category, number, number, number, number][] = [
    ["Pardon's Surplus & Salvage", 'shops', -612, -1160, 0, 1],
    ['Postponement Hall', 'leisure', 131, -1835.2, 0, 1],
    ['The Dead Letter Office', 'civic', d.x - 1.5, d.z0 + d.W / 2, -1, 0],
    ['Our Lady of Perpetual Hesitation', 'worship', L.x + L.tx * 11 + L.nx * 2.5, L.z + L.tz * 11 + L.nz * 2.5, L.nx, L.nz],
    ['The Holding Pattern', 'shops', 50.5, -1850, 1, 0],
    ['Lackwool Mill', 'offices', 207, -1461, -1, 0],
    ['Tepid Falls Depot (Trains, In Principle)', 'civic', 170, -2124.5, 0, 1],
    ['Quorum Square', 'leisure', 131, -1808, 0, 1],
    ['Dithers College', 'schools', -380.8, -2256.1, 0, 1],
    ['SpeedScan Headquarters', 'offices', HQ.x, HQ.z + 18, 0, 1],
    ['Flounder Field Demolition Derby', 'leisure', -476, -70, -1, 0],
  ];
  return out;
}

let CACHE: { plan: CityPlan; places: Place[] } | null = null;

/** Every place the town has, placed or not. Cheap to call again: it is cached per plan; `again` re-snaps against the buildings as they stand now. */
export function places(plan: CityPlan, again = false): Place[] {
  if (CACHE && CACHE.plan === plan && !again) return CACHE.places;
  const out: Place[] = [];
  const G = plan.streets;
  if (!STREETS_NEW || !G) { CACHE = { plan, places: out }; return out; }

  // The buildings there are.
  const blds: Bld[] = [];
  for (const l of mainlandLots(plan)) {
    const r = l.rect, [fx, fz] = dirOf(l.face);
    void fx; void fz;
    blds.push({ name: 'lot', kind: 'lot', cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, face: l.face, w: r.x1 - r.x0, d: r.z1 - r.z0, a: 0, pen: l.district === 'stacks' ? 10 : 0 });
  }
  const campus: Bld[] = [];
  for (const [, , , name, rr] of CAMPUS_BUILDINGS) {
    if (rr.length < 5) continue;
    let r = 0; // the biggest rectangle carries the door
    for (let i = 5; i + 4 < rr.length; i += 5) if (rr[i + 2] * rr[i + 3] > rr[r + 2] * rr[r + 3]) r = i;
    campus.push({ name, kind: 'campus', cx: rr[r], cz: rr[r + 1], x0: 0, z0: 0, x1: 0, z1: 0, face: 0, w: rr[r + 2], d: rr[r + 3], a: rr[r + 4], pen: 0 });
  }
  const cdist = (b: Bld, x: number, z: number): number => {
    const c = Math.cos(b.a), s = Math.sin(b.a), dx = x - b.cx, dz = z - b.cz;
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    return Math.hypot(Math.max(Math.abs(lx) - b.w / 2, 0), Math.max(Math.abs(lz) - b.d / 2, 0));
  };
  /** Door of a campus building: where the line from its centre to the nearest street leaves it, 2.5 m out. */
  const campusDoor = (b: Bld): { x: number; z: number; nx: number; nz: number; wx: number; wz: number } => {
    const ne = G.nearestEdge(b.cx, b.cz), p = G.pointAt(ne.edge, ne.s);
    const c = Math.cos(b.a), s = Math.sin(b.a), dx = p.x - b.cx, dz = p.z - b.cz;
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    let ux = lx, uz = lz;
    if (Math.abs(lx) / (b.w / 2) > Math.abs(lz) / (b.d / 2)) { ux = Math.sign(lx); uz = 0; } else { ux = 0; uz = Math.sign(lz) || 1; }
    // Along the chosen face: as far toward the street as the face goes.
    const ax = ux ? ux * b.w / 2 : Math.max(-b.w / 2 + 2, Math.min(b.w / 2 - 2, lx));
    const az = uz ? uz * b.d / 2 : Math.max(-b.d / 2 + 2, Math.min(b.d / 2 - 2, lz));
    const W = (x: number, z: number): [number, number] => [b.cx + x * c - z * s, b.cz + x * s + z * c];
    const [wx, wz] = W(ax, az), [ox, oz] = W(ax + ux * 2.5, az + uz * 2.5), [ex, ez] = W(ux, uz);
    return { x: ox, z: oz, nx: ex - b.cx, nz: ez - b.cz, wx, wz };
  };

  let id = 0;
  const push = (p: Omit<Place, 'id'>): void => { out.push({ ...p, id: id++ }); };

  // The game's own places, hand-fixed doors.
  for (const [name, cat, x, z, nx, nz] of landmarks()) push({ name, cat, x, z, nx, nz, wx: x - nx * 2.5, wz: z - nz * 2.5, rx: x, rz: z, placed: true, open: false, game: true, sign: false, at: 'landmark' });
  const have = new Set(out.map((p) => p.name));
  // Dithers' own halls and houses.
  for (const b of campus) {
    if (have.has(b.name)) continue;
    const d = campusDoor(b);
    push({ name: b.name, cat: 'schools', x: d.x, z: d.z, nx: d.nx, nz: d.nz, wx: d.wx, wz: d.wz, rx: b.cx, rz: b.cz, placed: true, open: false, game: true, sign: false, at: b.name });
  }

  // The street directory.
  const near = (x: number, z: number): { b: Bld | null; d: number } => {
    let best: Bld | null = null, bd = SNAP + 1;
    for (const b of blds) {
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1), d = Math.hypot(dx, dz) + b.pen;
      if (d < bd) { bd = d; best = b; }
    }
    for (const b of campus) { const d = cdist(b, x, z); if (d < bd) { bd = d; best = b; } }
    return { b: best, d: bd };
  };
  for (const [name, ci, x, z, open] of DIRECTORY) {
    const cat = CATEGORIES[ci];
    const base = { name, cat, rx: x, rz: z, open: open === 1, game: false };
    if (open) {
      // Open ground: placed where it stands, if a street is near enough to get to it.
      const ne = G.nearestEdge(x, z);
      push({ ...base, x, z, nx: 0, nz: 0, wx: x, wz: z, placed: ne.d <= 55, sign: false, at: 'open ground' });
      continue;
    }
    const { b } = near(x, z);
    if (!b) { push({ ...base, x, z, nx: 0, nz: 1, wx: x, wz: z, placed: false, sign: false, at: '' }); continue; }
    if (b.kind === 'campus') {
      const d = campusDoor(b);
      push({ ...base, x: d.x, z: d.z, nx: d.nx, nz: d.nz, wx: d.wx, wz: d.wz, placed: true, sign: true, at: b.name });
      continue;
    }
    const [nx, nz] = dirOf(b.face);
    // Door along the frontage at the business's own position, kept clear of the corners.
    let dx: number, dz: number, wx: number, wz: number;
    if (b.face === 0 || b.face === 2) {
      const along = Math.max(b.x0 + Math.min(2.5, b.w / 2), Math.min(b.x1 - Math.min(2.5, b.w / 2), x));
      const front = b.face === 0 ? b.z0 : b.z1;
      wx = along; wz = front; dx = along; dz = front + nz * 2.5;
    } else {
      const along = Math.max(b.z0 + Math.min(2.5, b.d / 2), Math.min(b.z1 - Math.min(2.5, b.d / 2), z));
      const front = b.face === 1 ? b.x1 : b.x0;
      wx = front; wz = along; dx = front + nx * 2.5; dz = along;
    }
    push({ ...base, x: dx, z: dz, nx, nz, wx, wz, placed: true, sign: true, at: 'lot' });
  }
  void groundAt;
  CACHE = { plan, places: out };
  return out;
}

/** Search: every word typed must appear in the name or category, in any order. */
export function findPlaces(list: readonly Place[], query: string, cat: Category | null): Place[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((p) => p.placed && (!cat || p.cat === cat) && words.every((w) => p.name.toLowerCase().includes(w) || CATEGORY_NAME[p.cat].toLowerCase().includes(w)));
}
