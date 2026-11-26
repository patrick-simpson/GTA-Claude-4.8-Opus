// Fun queue 2, item 49: progress unlocks. What there is to find, and what finding it earns. Pure data and small
// helpers; game/unlocks.ts does the watching and ui/unlocksPage.ts the page.
//
// PLACES: named districts (the plan's own placeName), and a few spots (the dam, the pond lookout, the promenade,
// the three stations, the two ferry landings). Finding one is walking or driving through it; saved as best['ex.<id>'] = 1.
//
// UNLOCKS: only ever ADD options. A milestone is read from counters the save already keeps (so an old save is granted
// what it has earned at once); an unlock is saved as best['un.<id>'] = 1. Cars are called to your side from the
// Unlocks page; outfits and paints appear in the Wardrobe; stations appear on the dial.

import { save } from './save';
import { STREETS_NEW } from '../world/streets';
import { DOCKS } from '../world/ferryRoute';
import { STATIONS } from '../world/railway';
import { LOOKOUT } from '../world/dithersPond';
import { DAM_Z, LAKE } from '../world/mainland';
import { BRIDGE } from '../world/plan';
import { speciesCaught } from './fishData';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { PlayerLook } from './looks';

export interface PlaceDef {
  id: string; name: string;
  /** Matched against plan.placeName(x, z). */
  area?: string;
  /** Or: within r metres of this point. */
  at?: { x: number; z: number; r: number };
  hint: string;
  /** Only under the new streets (the mainland, its landmarks and the ferry). */
  newOnly: boolean;
  /** Where the map puts its marker when the place has no blocks of its own to fog. */
  pin?: { x: number; z: number };
}

const A = (name: string, hint: string, newOnly = false, pin?: { x: number; z: number }): PlaceDef => ({ id: 'a.' + name.toLowerCase().replace(/[^a-z0-9]+/g, ''), name, area: name, hint, newOnly, pin });
const S = (id: string, name: string, x: number, z: number, r: number, hint: string): PlaceDef => ({ id: 's.' + id, name, at: { x, z, r }, hint, newOnly: true });

/** Every place there is to find. The Millpond Promenade's yard is game/project.ts SITE; the dam is the Muddle River's. */
let DEFS: PlaceDef[] | null = null;
export function placeDefs(): PlaceDef[] { return DEFS ?? (DEFS = buildPlaces()); }
function buildPlaces(): PlaceDef[] {
  const out: PlaceDef[] = [
    A('Ledger District', 'Downtown on the island'), A('Tinker Row', 'Midtown, the workshops'), A('Fishbone', 'The old town by the water'),
    A('Gull Heights', 'The island suburb'), A('The Cannery', 'Industrial, by the yard'), A('Dock Seven', 'The container port'),
    A('Saltwater Strand', 'The strand, along the shore'), A('Mercy Park', 'The park with the pond'), A('Flounder Field', 'The arena and the stunt park'),
    A('Pelican Pier', 'The long pier at the south end', false, { x: 0, z: 490 }), A('Last Light Breakwater', 'The breakwater, east of the harbour', false, { x: 690, z: 256 }),
    A('Low Tide Beach', 'The beach past the pier'), A('The Perpetual Bridge', 'The bridge that climbs north out of town', false, { x: BRIDGE.x, z: (BRIDGE.z0 + BRIDGE.z1) / 2 }),
  ];
  if (!STREETS_NEW) return out;
  out.push(
    A('Loom Row', 'The old mill street in Tepid Falls', true), A('Lower Main', 'Main Street, Tepid Falls', true), A('Quorum Square', 'The square with the bandstand', true),
    A('The Stacks', 'Tepid Falls, the tall brick blocks', true), A('Dithers Hill', 'The college on the hill', true), A('Sidetrack Yard', 'Beside the railway yard', true),
    A('The Exits', 'Out by the Thruway ramps', true), A('Indecision Township', 'The country west of the lake', true), A('Lesser Tepid', 'The village across the river', true),
    A('Tepid Landing', 'The river landing', true, { x: DOCKS[1].x, z: DOCKS[1].z }), A('Lake Indecision', 'The south shore of the lake', true, { x: LAKE.x, z: LAKE.z + LAKE.b - 4 }),
    S('dam', 'Threadbare Dam', 316, DAM_Z, 45, 'The dam and its falls on the Muddle River'),
    S('lookout', 'Johnson Pond lookout', LOOKOUT.x, LOOKOUT.z, 26, 'The gravel lookout on Cherry Tree St'),
    S('promenade', 'Millpond Promenade', 248, -1932, 48, 'The pond bank behind Quorum Square'),
    S('ferry1', 'Pelican Landing', DOCKS[0].x, DOCKS[0].z, 30, 'The island ferry landing'),
    S('ferry2', 'River Landing', DOCKS[1].x, DOCKS[1].z, 30, 'The Tepid Falls ferry landing'),
  );
  for (const [i, st] of STATIONS.entries()) out.push(S('st' + i, st.name, st.x, st.z, 32, 'A Budget Line station'));
  return out;
}

export const placeKey = (id: string): string => 'ex.' + id;
export const found = (id: string): boolean => save.data.best[placeKey(id)] === 1;
export const unlockKey = (id: string): string => 'un.' + id;
export const isUnlocked = (id: string): boolean => save.data.best[unlockKey(id)] === 1;

// ── What a milestone can read ──

const cnt = (k: string): number => save.data.counts[k] ?? save.data.best[k] ?? 0;
/** Counters, all read from what the save already keeps. */
export interface Tally { places: number; placesAll: number; stations: number; races: number; plow: number; finds: number; derbyWins: number; photos: number; college: number; species: number; has(id: string): boolean }
export function tally(): Tally {
  const defs = placeDefs();
  return {
    places: defs.filter((p) => found(p.id)).length, placesAll: defs.length,
    stations: defs.filter((p) => p.id.startsWith('s.st') && found(p.id)).length,
    races: save.data.stats.races, plow: cnt('plow'), finds: cnt('fd.found'), derbyWins: cnt('derbyWins'), photos: cnt('ph.win'), college: cnt('sem.runs'),
    species: speciesCaught(),
    has: (id) => found(id),
  };
}

export type UnlockKind = 'car' | 'outfit' | 'paint' | 'station';
export const KIND_NAME: Record<UnlockKind, string> = { car: 'Rides', outfit: 'Outfits', paint: 'Car paints', station: 'Radio' };

export interface UnlockDef {
  id: string; kind: UnlockKind; name: string;
  /** What to do, in the page's words. */
  hint: string;
  /** Progress toward it: have and goal (have >= goal earns it). */
  prog(t: Tally): [number, number];
  /** Is it possible in this world at all? */
  ok?: () => boolean;
  /** What you get, for the Unlocks page. */
  note: string;
  car?: { kind: VehicleKind; color: number };
  paint?: number;
  /** Look fields an outfit sets (the body, skin, face, hair stay yours). */
  outfit?: Partial<PlayerLook>;
  /** The dial place of a station is found by its call in audio/radio.ts. */
  station?: string;
}

const one = (b: boolean): [number, number] => [b ? 1 : 0, 1];

/** Cloth palette indexes (game/looks.ts CLOTH_COLORS): 12 orange, 13 vermilion, 5 navy, 2 black, 10 forest, 9 sage, 18 sand, 3 charcoal, 1 white, 11 amber. A jacket is an index + 1. */
export const UNLOCKS: UnlockDef[] = [
  { id: 'st.dithers', kind: 'station', name: 'Dithers 91.7', hint: 'Drive up to Dithers Hill, the college.', note: 'Student radio, mostly live. On the dial after the last station.', station: 'Dithers 91.7', prog: (t) => one(t.has('a.dithershill')), ok: () => STREETS_NEW },
  { id: 'st.dam', kind: 'station', name: 'Dam Country 1280', hint: 'Visit Threadbare Dam.', note: 'Hay, grain and gravel, from a little tower by the falls.', station: 'Dam Country 1280', prog: (t) => one(t.has('s.dam')), ok: () => STREETS_NEW },
  { id: 'car.cmax', kind: 'car', name: 'C-Max, kept ready', hint: 'Step onto all three Budget Line platforms.', note: 'The graphite wagon that waits at the kerb downtown: now it comes when called.', car: { kind: 'cmax', color: 0x474a48 }, prog: (t) => [t.stations, 3], ok: () => STREETS_NEW },
  { id: 'car.trophy', kind: 'car', name: 'Trophy Brawler', hint: 'Finish 5 races.', note: 'The Brawler Eight in trophy gold.', car: { kind: 'muscle', color: 0xd8a630 }, prog: (t) => [t.races, 5] },
  { id: 'car.plow', kind: 'car', name: 'Marlowe\'s yard pickup', hint: 'Finish one snow job (plow or salt).', note: 'A Dockhand in plow yellow, for the next snowfall.', car: { kind: 'pickup', color: 0xf2c94c }, prog: (t) => [t.plow, 1] },
  { id: 'car.night', kind: 'car', name: 'Night Runner', hint: 'Find 20 lost ducks and receipts.', note: 'The sports car in near-black, for after dark.', car: { kind: 'sports', color: 0x15171c }, prog: (t) => [t.finds, 20] },
  { id: 'paint.crimson', kind: 'paint', name: 'Campus crimson', hint: 'Finish a Dithers College mission.', note: 'A garage paint colour.', paint: 0xa4243b, prog: (t) => [t.college, 1] },
  { id: 'paint.millpond', kind: 'paint', name: 'Millpond green', hint: 'Walk into the Millpond Promenade.', note: 'A garage paint colour.', paint: 0x3f8f6b, prog: (t) => one(t.has('s.promenade')), ok: () => STREETS_NEW },
  { id: 'paint.gold', kind: 'paint', name: 'Derby gold', hint: 'Win a demolition derby.', note: 'A garage paint colour.', paint: 0xd8a630, prog: (t) => [t.derbyWins, 1] },
  { id: 'paint.pearl', kind: 'paint', name: 'Snow pearl', hint: 'Land 3 photo challenges.', note: 'A garage paint colour.', paint: 0xf4f6fb, prog: (t) => [t.photos, 3] },
  { id: 'paint.survey', kind: 'paint', name: 'Surveyor orange', hint: 'Find most of the places on the map.', note: 'A garage paint colour.', paint: 0xff6a1f, prog: (t) => [t.places, Math.ceil(t.placesAll * 0.6)] },
  { id: 'out.explorer', kind: 'outfit', name: 'Explorer\'s vest', hint: 'Find 10 places.', note: 'Sand jacket over a white tee, a cap, boots.', outfit: { top: 0, topColor: 1, jacket: 19, bottom: 0, bottomColor: 3, shoes: 1, shoeColor: 19, hat: 1, hatColor: 18 }, prog: (t) => [t.places, 10] },
  { id: 'out.crew', kind: 'outfit', name: 'Plow crew', hint: 'Finish 3 snow jobs.', note: 'Orange work jacket, a beanie, boots.', outfit: { top: 0, topColor: 3, jacket: 13, bottom: 0, bottomColor: 2, shoes: 1, shoeColor: 2, hat: 3, hatColor: 12 }, prog: (t) => [t.plow, 3] },
  { id: 'out.racer', kind: 'outfit', name: 'Racing coveralls', hint: 'Finish 3 races.', note: 'Red coveralls and a cap turned backwards.', outfit: { top: 4, topColor: 13, jacket: 0, bottom: 0, bottomColor: 2, shoes: 0, shoeColor: 1, hat: 2, hatColor: 2 }, prog: (t) => [t.races, 3] },
  { id: 'out.scholar', kind: 'outfit', name: 'College blazer', hint: 'Finish 3 Dithers College missions.', note: 'A navy blazer over a white shirt, glasses.', outfit: { top: 1, topColor: 1, jacket: 6, bottom: 0, bottomColor: 3, shoes: 1, shoeColor: 19, hat: 0, glasses: 2 }, prog: (t) => [t.college, 3] },
  { id: 'out.angler', kind: 'outfit', name: 'Angler\'s hoodie', hint: 'Land 4 kinds of fish.', note: 'A forest hoodie, a brimmed hat, boots.', outfit: { top: 2, topColor: 10, jacket: 0, bottom: 1, bottomColor: 6, shoes: 1, shoeColor: 19, hat: 4, hatColor: 9 }, prog: (t) => [t.species, 4] },
  { id: 'out.shutter', kind: 'outfit', name: 'Photographer\'s kit', hint: 'Land a photo challenge.', note: 'A black jacket, a camera bag, a cap.', outfit: { top: 1, topColor: 7, jacket: 3, bottom: 1, bottomColor: 3, shoes: 0, shoeColor: 2, hat: 1, hatColor: 2, bag: 1 }, prog: (t) => [t.photos, 1] },
];

export const unlockById = (id: string): UnlockDef | undefined => UNLOCKS.find((u) => u.id === id);
/** The unlocks that exist in this world. */
export const available = (): UnlockDef[] => UNLOCKS.filter((u) => !u.ok || u.ok());

/** The garage paints that were earned, in the order of the list. */
export function extraPaints(): { id: string; name: string; color: number; on: boolean }[] {
  return available().filter((u) => u.paint !== undefined).map((u) => ({ id: u.id, name: u.name, color: u.paint as number, on: isUnlocked(u.id) }));
}
/** The outfits, earned or not. */
export function outfits(): { id: string; name: string; hint: string; on: boolean; look: Partial<PlayerLook> }[] {
  return available().filter((u) => u.outfit).map((u) => ({ id: u.id, name: u.name, hint: u.hint, on: isUnlocked(u.id), look: u.outfit as Partial<PlayerLook> }));
}
