// The mainland, as data: the town of Tepid Falls on the far side of the Budget Gap.
//
// Pure numbers and small functions, no rendering. plan.ts folds the street grid
// below into the one CityPlan every system reads, and calls the height functions
// from groundAt(); ground.ts draws from the same formulas, so wheels touch what
// the eye sees.
//
// The lie of the land (all in meters, north is -Z):
//   - The shore faces the island at about z = -980. A 30 m bluff climbs from the
//     beach to the town plateau at MAIN_Y; the whole town is flat at that height.
//   - The Muddle River runs north to south down the east side (x about 340), with
//     Threadbare Dam and its falls at DAM_Z. Its banks drop from the plateau to
//     the water in about 22 m.
//   - Dithers Hill, the one real hill, stands in the west: a flat top HILL_H above
//     the town with even slopes all round. Chapel Hill Rd goes over it.
//   - West of the Thruway: Afterthought Stream and Lake Indecision.
//   - Across the river, south of a tributary: Lesser Tepid, reached on foot only.

import { smooth } from '../core/util';

export interface MRect { x0: number; z0: number; x1: number; z1: number }

export const TOWN_NAME = 'Tepid Falls';

/**
 * The new streets after real Waterville (streets.ts STREETS_NEW, repeated here: streets.ts imports this file). Unit 4 of
 * tepid-streets.md moves the built things with them: the hill and the college site north-west to Mayflower Hill, the
 * footbridge above the dam, the railway north of downtown. ?streets=old keeps every old place.
 */
const NEW = typeof location === 'undefined' || new URLSearchParams(location.search).get('streets') !== 'old';
/** Height of the town plateau above the island's streets. */
export const MAIN_Y = 5;
/** Where terrainAt()/groundAt() hand over from the island to the mainland: mid-channel, where both sea floors are at full depth. */
export const MAIN_SPLIT_Z = -830;

// ── The street grid ──────────────────────────────────────────────────────────

/** X of each north-south street, west to east, and Z of each east-west street, north to south. */
export const MXS = [-700, -590, -480, -350, -240, -130, -30, 70, 170, 470, 580];
export const MZS = [-2060, -1955, -1840, -1735, -1620, -1505, -1400, -1295, -1180, -1080];
export const M_NS_NAMES = ['The Thruway', 'Offramp Rd', 'Chapel Hill Rd', 'Birch St', 'Porch St', 'Triple St', 'Landing Rd', 'Main St', 'Water St', 'Far Bank Rd', 'Upriver Rd'];
export const M_EW_NAMES = ['Town Line Rd', 'Depot St', 'Sidetrack St', 'Trestle St', 'Spindle St', 'Bobbin St', 'Quorum St', 'Second Thought Ave', 'Shirttail St', 'Front St'];
export const M_AVE_X = [0, 6, 7];
export const M_AVE_Z = [7];
/** Mainland nodes and blocks carry i and j offset by these, so (i, j) names one crossing in the whole world. */
export const MI0 = 32, MJ0 = 32;

export type MainDistrict = 'mill' | 'main' | 'square' | 'stacks' | 'college' | 'yard' | 'exits' | 'lake' | 'sister';

/**
 * Street segments that do not exist. "v:i:j" = north-south street i between cross streets j and j+1.
 * The Thruway meets the town only at its two ends and its two exits (Depot St, Second Thought Ave);
 * nothing but Trestle St crosses the river; the campus keeps only the road over the hill; and the
 * far bank's streets stop at Spindle St, north of the tributary.
 */
const M_REMOVED = new Set([
  'h:0:2', 'h:0:3', 'h:0:4', 'h:0:5', 'h:0:6', 'h:0:8',
  'v:1:2', 'v:1:3', 'v:1:4', 'h:1:3', 'h:1:4', 'h:2:3', 'h:2:4',
  'h:8:0', 'h:8:1', 'h:8:2', 'h:8:4', 'h:8:5', 'h:8:6', 'h:8:7', 'h:8:8', 'h:8:9',
  'v:9:4', 'v:9:5', 'v:9:6', 'v:9:7', 'v:9:8', 'v:10:4', 'v:10:5', 'v:10:6', 'v:10:7', 'v:10:8',
  'h:9:5', 'h:9:6', 'h:9:7', 'h:9:8', 'h:9:9',
  // A little irregularity: a long block in the Stacks, the rail yard's big block, a dead end by the square.
  'v:3:7', 'v:5:1', 'h:4:6',
]);
export const mvSeg = (i: number, j: number): boolean =>
  i >= 0 && i < MXS.length && j >= 0 && j < MZS.length - 1 && !M_REMOVED.has(`v:${i}:${j}`);
export const mhSeg = (i: number, j: number): boolean =>
  i >= 0 && i < MXS.length - 1 && j >= 0 && j < MZS.length && !M_REMOVED.has(`h:${i}:${j}`);

/** District of grid cell (i, j), and whether it is a paved block (false: open ground, river or far-bank meadow). */
export function mCell(i: number, j: number): { d: MainDistrict; block: boolean } {
  if (i === 8) return { d: j >= 3 ? 'mill' : 'yard', block: false };
  if (i === 9) return j <= 3 ? { d: 'stacks', block: true } : { d: 'sister', block: false };
  if (i <= 2 && j >= 2 && j <= 4) return { d: 'college', block: true };
  if (i === 0) return { d: 'exits', block: true };
  if (j <= 1) return { d: i >= 3 ? 'yard' : 'exits', block: true };
  if (i === 6 && j === 5) return { d: 'square', block: true };
  if (i === 7) return { d: j >= 4 ? 'mill' : 'main', block: true };
  if (i >= 5) return { d: 'main', block: true };
  return { d: 'stacks', block: true };
}

/**
 * Unlock stage of each district: 1 the riverfront mills, 2 downtown, 3 the hill, 4 the Thruway and the lake.
 * A street opens with the earlier of the two districts it runs between.
 */
export const STAGE_OF: Record<MainDistrict, number> = {
  mill: 1, sister: 1, main: 2, square: 2, yard: 2, college: 3, stacks: 3, exits: 4, lake: 4,
};
export const STAGE_NAMES = ['The Landing', 'Loom Row', 'Lower Main', 'Dithers Hill', 'The Exits and Lake Indecision'];
/** Streets whose stage is set by hand: Front St from the landing to Water St opens with the bridge. */
export const STAGE_OVERRIDE: Record<string, number> = { 'h:6:9': 0, 'h:7:9': 0 };

// ── Coast, river, stream, lake ───────────────────────────────────────────────

/** The coast is a rounded box with a wobble, like the island's. Only its south, east and west shores are ever reached. */
export const COAST = { cx: 20, cz: -1978, hx: 930, hz: 1000, r: 180 };

/** Signed distance to the mainland's sea coast: negative on land. */
export function coastSD(x: number, z: number): number {
  const px = x - COAST.cx, pz = z - COAST.cz;
  const qx = Math.abs(px) - (COAST.hx - COAST.r), qz = Math.abs(pz) - (COAST.hz - COAST.r);
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  const sd = Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - COAST.r;
  const th = Math.atan2(pz, px);
  return sd + 10 * Math.sin(th * 4 + 0.7) + 6 * Math.sin(th * 9 + 2.1) + 3 * Math.sin(th * 17);
}

/** The Muddle River: X of its centerline at a given Z, and its half-width at the waterline. */
export const riverX = (z: number): number => 340 + 30 * Math.sin((z + 1100) / 210);
export const RIVER_HW = 36;
/** Threadbare Dam crosses the river here. Upstream is the mill pond; the falls face south. */
export const DAM_Z = -1570;
/** Height of the mill pond's surface above the dam. Everything below the dam, the stream and the lake are at sea level. */
export const POND_Y = 0.4;
/** Height of the water's surface at a point on the mainland (the pond, or sea level). For swimming and sinking code to adopt. */
export const waterLevelAt = (x: number, z: number): number =>
  z < DAM_Z && x > 230 && x < 450 && Math.abs(x - riverX(z)) < RIVER_HW + 8 ? POND_Y : -0.8;
/** The tributary (Sidle Brook) that cuts Lesser Tepid off from the far bank's streets: Z of its centerline at X. */
export const tribZ = (x: number): number => -1530 + 14 * Math.sin((x - 400) / 160);
export const TRIB_HW = 12;
/** Afterthought Stream, from Lake Indecision down to the Gap. */
export const streamX = (z: number): number => -800 + 22 * Math.sin((z + 1000) / 130);
export const STREAM_HW = 7;
export const STREAM_Z0 = -2020;
export const LAKE = { x: -830, z: -2110, a: 95, b: 140 };

/** How far in from the water a bank reaches the plateau. */
const BANK = 22;

/** Meters to the nearest fresh water's edge: positive on dry land, negative in the water. Huge when nowhere near any. */
export function waterDist(x: number, z: number): number {
  let d = 1e9;
  if (x > 230 && x < 450) d = Math.abs(x - riverX(z)) - RIVER_HW;
  if (x > 300 && z > -1600 && z < -1470 && x > riverX(z) - 10) d = Math.min(d, Math.abs(z - tribZ(x)) - TRIB_HW);
  if (x < -740) {
    if (x > -860 && z > STREAM_Z0) d = Math.min(d, Math.abs(x - streamX(z)) - STREAM_HW);
    if (z < -1930) {
      const ex = (x - LAKE.x) / LAKE.a, ez = (z - LAKE.z) / LAKE.b;
      d = Math.min(d, (Math.sqrt(ex * ex + ez * ez) - 1) * LAKE.a);
    }
  }
  return d;
}

/** Signed distance to any water, salt or fresh: negative on land. The chart and the sea shader draw from this. */
export function mainlandSD(x: number, z: number): number {
  return Math.max(coastSD(x, z), -waterDist(x, z));
}

// ── Dithers Hill ─────────────────────────────────────────────────────────────

/** The hill's footprint (a rounded rectangle), its height over the town, and the width of the slope all round. */
export const HILL = NEW ? { x0: -625, x1: -315, z0: -2568, z1: -2272, h: 12, band: 100 } : { x0: -680, x1: -370, z0: -1820, z1: -1525, h: 12, band: 100 };
const HCX = (HILL.x0 + HILL.x1) / 2, HCZ = (HILL.z0 + HILL.z1) / 2;
const HHX = (HILL.x1 - HILL.x0) / 2, HHZ = (HILL.z1 - HILL.z0) / 2;

/**
 * Height of Dithers Hill above the plateau: 0 outside its footprint, HILL.h on the flat top.
 * The slope is one smoothstep across the band: 18% at its steepest, and no crease anywhere for a mesh to cut across.
 */
export function hillAt(x: number, z: number): number {
  if (x <= HILL.x0 || x >= HILL.x1 || z <= HILL.z0 || z >= HILL.z1) return 0;
  const R = HILL.band;
  const qx = Math.abs(x - HCX) - (HHX - R), qz = Math.abs(z - HCZ) - (HHZ - R);
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  const d = R - Math.sqrt(ox * ox + oz * oz) - Math.min(Math.max(qx, qz), 0);
  if (d <= 0) return 0;
  if (d >= R) return HILL.h;
  return HILL.h * smooth(d / R);
}

// ── Decks over the river ─────────────────────────────────────────────────────

/** Trestle St's road bridge, the Exact Change Footbridge, and the railway trestle. All level with the town. */
export const ROAD_BRIDGE: MRect = { x0: 176, x1: 464, z0: MZS[3] - 6, z1: MZS[3] + 6 };
/** New streets: the real Two Cent Bridge is above the dam at Temple St (Pocket Change St), so the footbridge spans the pond there. */
export const FOOTBRIDGE_Z = NEW ? -1890 : -1345;
// (its east anchor lands just short of Upriver Rd, which hugs the far bank there)
const FBX = NEW ? 271 : 250;
export const FOOTBRIDGE: MRect = { x0: FBX, x1: FBX + 126, z0: FOOTBRIDGE_Z - 1.4, z1: FOOTBRIDGE_Z + 1.4 };
/** New streets: the line runs just north of downtown, clear of Front St, crossing the river where it bends east. */
export const RAIL_Z = NEW ? -2150 : -1897;
const RTX = NEW ? 305 : 294;
export const RAIL_TRESTLE: MRect = { x0: RTX, x1: RTX + 128, z0: RAIL_Z - 2.2, z1: RAIL_Z + 2.2 };
/** The railway: one track east-west across the north of town, from the buffer stop by the Thruway to the far bank. */
export const RAIL = { z: RAIL_Z, x0: NEW ? -640 : -660, x1: 640, hw: 9 };
/** New streets: no old road bridge (Trestle St crosses at z -1635 on its own deck, streetMeshes.ts), so no walkable floor where it was. */
export const DECKS: MRect[] = NEW ? [FOOTBRIDGE, RAIL_TRESTLE] : [ROAD_BRIDGE, FOOTBRIDGE, RAIL_TRESTLE];

// ── Height of the natural ground ─────────────────────────────────────────────

/** Height of the mainland's natural ground: beach, bluff, plateau, riverbanks and the hill. No curbs, no decks. */
/**
 * The new street plan (streetGround.ts) grades the ground under and beside its roads: when set, every caller of
 * mainlandTerrain() gets the graded height. naturalTerrain() is the ground before that.
 */
let terrainGrade: ((x: number, z: number, natural: number) => number) | null = null;
export function setTerrainGrade(f: ((x: number, z: number, natural: number) => number) | null): void { terrainGrade = f; }

export function mainlandTerrain(x: number, z: number): number {
  const h = naturalTerrain(x, z);
  return terrainGrade === null ? h : terrainGrade(x, z, h);
}

export function naturalTerrain(x: number, z: number): number {
  // The town itself: flat, or the hill. Nothing else reaches in here, so skip the coast's arctangent.
  if (z < -1072 && z > -2068 && ((x > -712 && x < 178) || (x > 462 && x < 588 && z < -1612))) {
    return MAIN_Y + hillAt(x, z);
  }
  const sd = coastSD(x, z);
  let h: number;
  if (sd > -26) {
    // The island's own beach profile, so the waterline and the foam sit at the same distance from "the coast".
    h = sd < 40 ? -3.4 * smooth((sd + 26) / 66) : -3.4 - Math.min((sd - 40) * 0.06, 6);
  } else h = sd > -56 ? MAIN_Y * smooth((-26 - sd) / 30) : MAIN_Y;
  // New streets: the hill stands north of the flat town box above.
  if (NEW && h >= MAIN_Y - 0.01) h += hillAt(x, z);
  if (h > -3.4) {
    const d = waterDist(x, z);
    if (d < BANK) h = Math.min(h, d <= -10 ? -3.4 : MAIN_Y - (MAIN_Y + 3.4) * smooth((BANK - d) / (BANK + 10)));
  }
  return h;
}

// ── Sites part 2 builds on ───────────────────────────────────────────────────

/** Lots that are not part of a street block: the mill site on the river side of Water St, and Lesser Tepid. face: 0 N, 1 E, 2 S, 3 W. */
export const EXTRA_LOTS: { rect: MRect; district: MainDistrict; face: number; name: string }[] = [
  { rect: { x0: 180, z0: -1565, x1: 248, z1: -1470 }, district: 'mill', face: 3, name: 'Threadbare Mill No. 1 (beside the dam)' },
  { rect: { x0: 180, z0: -1470, x1: 248, z1: -1356 }, district: 'mill', face: 3, name: 'Threadbare Mill No. 2' },
  { rect: { x0: 180, z0: -1334, x1: 248, z1: -1200 }, district: 'mill', face: 3, name: 'Threadbare storehouse and yard' },
  { rect: { x0: 380, z0: -1478, x1: 440, z1: -1425 }, district: 'sister', face: 2, name: 'The blockhouse (Fort Reluctance)' },
  ...[0, 1, 2, 3, 4, 5].flatMap((k) => [
    { rect: { x0: 392 + k * 42, z0: -1400, x1: 430 + k * 42, z1: -1350 }, district: 'sister' as MainDistrict, face: 2, name: 'Lesser Tepid house lot' },
    { rect: { x0: 392 + k * 42, z0: -1340, x1: 430 + k * 42, z1: -1290 }, district: 'sister' as MainDistrict, face: 0, name: 'Lesser Tepid house lot' },
  ]),
];

/** Named points for the report, the radar and part 2. */
export const SITES = {
  landing: { x: -30, z: -1056 },
  fundBox: { x: -45, z: -439.5 },
  townBox: { x: -30 + 13.5, z: -1066 },
  dam: { x: 316, z: DAM_Z },
  footbridgeWest: { x: FOOTBRIDGE.x0, z: FOOTBRIDGE_Z },
  footbridgeEast: { x: FOOTBRIDGE.x1, z: FOOTBRIDGE_Z },
  square: NEW ? { x: 131, z: -1807 } : { x: 20, z: -1452 },
  hilltop: { x: HCX, z: HCZ },
  lake: { x: LAKE.x, z: LAKE.z },
};
