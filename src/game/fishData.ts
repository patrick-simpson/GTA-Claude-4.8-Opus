// Fishing (fun queue 2, item 15), the data: the spots, the 20 catches, and what this player's save remembers of them.
// Pure data and the save, no three.js: the fishing game (game/fishing.ts), the pause menu's Fish Log (game/fishLog.ts) and
// the town leaderboard (game/leaderboard.ts) all read it.
//
//   - THE ORDER IS THE SAVE. Per catch i (APPEND ONLY): best['fish.b'+i] best weight in ounces, ['fish.n'+i] how many,
//     ['fish.w'+i] a bitmask of the spots (SPOTS order) it has been landed at. Totals: fish.rel (released), fish.sold,
//     fish.cash (dollars earned), fish.max (heaviest real fish, ounces: the leaderboard's "Heaviest catch").
//   - Weights are ounces everywhere inside; words come from weightText.

import { save } from './save';

export type Water = 'sea' | 'river' | 'pond';
export type Bite = 'dawn' | 'dusk' | 'night' | 'day' | 'any';
export type Look = 'fish' | 'eel' | 'boot' | 'ticket' | 'lobster' | 'ring';

export interface Species {
  name: string;
  /** What it looks like in the log (icon): body proportions and colour. */
  look: Look; len: number; tall: number; color: string; belly: string;
  /** Where it lives; the weight range in ounces; how often it takes the hook (relative); dollars per pound (0: nobody buys it). */
  water: Water[]; lo: number; hi: number; w: number; price: number;
  /** When it bites best, and the seasons it is about (summer is spring and summer; the town has three). */
  best: Bite; seasons: ('summer' | 'autumn' | 'winter')[];
  /** Junk is not a fish: no leaderboard weight, and it never fights. */
  junk?: boolean;
  /** The law says put it back. */
  illegal?: boolean;
  /** The log's line, in the town's humour. */
  line: string;
  /** The words for the log before it has been caught. */
  where: string;
}

export const SPECIES: readonly Species[] = [
  { name: 'Brook trout', look: 'fish', len: 1, tall: 0.8, color: '#6b8f3a', belly: '#e07a3a', water: ['river', 'pond'], lo: 6, hi: 36, w: 9, price: 9, best: 'dawn', seasons: ['summer', 'autumn', 'winter'], where: 'Cold fresh water, early', line: 'Spotted like a bad rumour. Cold-water royalty, and it knows it.' },
  { name: 'Landlocked salmon', look: 'fish', len: 1.1, tall: 0.85, color: '#8aa0b0', belly: '#e8eef2', water: ['pond', 'river'], lo: 20, hi: 130, w: 3, price: 7, best: 'dawn', seasons: ['autumn', 'winter', 'summer'], where: 'Johnson Pond, the river', line: 'A salmon that never left. Relatable.' },
  { name: 'Smallmouth bass', look: 'fish', len: 1, tall: 1, color: '#6a5a2e', belly: '#c9c08a', water: ['river', 'pond'], lo: 14, hi: 90, w: 7, price: 6, best: 'day', seasons: ['summer', 'autumn'], where: 'River and pond, warm days', line: 'Fights like it owes you money.' },
  { name: 'Chain pickerel', look: 'fish', len: 1.3, tall: 0.55, color: '#5d7a3c', belly: '#d8d49a', water: ['pond', 'river'], lo: 16, hi: 100, w: 6, price: 4, best: 'any', seasons: ['summer', 'autumn', 'winter'], where: 'Weedy water', line: 'All teeth, no apologies. Sold as "fish."' },
  { name: 'Yellow perch', look: 'fish', len: 0.8, tall: 1.2, color: '#b5a33a', belly: '#f1e6a0', water: ['pond'], lo: 4, hi: 22, w: 8, price: 5, best: 'day', seasons: ['summer', 'autumn', 'winter'], where: 'Johnson Pond', line: 'Tiny, striped, and extremely sure of itself.' },
  { name: 'White sucker', look: 'fish', len: 1.1, tall: 0.7, color: '#8a8478', belly: '#e0dccc', water: ['river', 'pond'], lo: 10, hi: 56, w: 6, price: 1, best: 'any', seasons: ['summer', 'autumn', 'winter'], where: 'River bottoms', line: 'Honest work, honest face. Nobody has ever been proud of one.' },
  { name: 'Striped bass', look: 'fish', len: 1.25, tall: 0.95, color: '#5f7480', belly: '#dfe6e6', water: ['sea'], lo: 48, hi: 700, w: 4, price: 8, best: 'dusk', seasons: ['summer', 'autumn'], where: 'Salt water, dusk and night', line: 'Maine\'s most photographed fish, mostly by people lying about its size.' },
  { name: 'Mackerel', look: 'fish', len: 1.05, tall: 0.6, color: '#2f6f8a', belly: '#e6eef0', water: ['sea'], lo: 8, hi: 38, w: 10, price: 3, best: 'any', seasons: ['summer', 'autumn'], where: 'Off the pier, summer', line: 'Arrives in schools. Leaves in your cooler.' },
  { name: 'Pollock', look: 'fish', len: 1.1, tall: 0.85, color: '#4a5a3a', belly: '#bfc7b0', water: ['sea'], lo: 20, hi: 260, w: 6, price: 4, best: 'any', seasons: ['summer', 'autumn', 'winter'], where: 'Salt water, any day', line: 'The fish of "whatever is cheapest."' },
  { name: 'Cunner', look: 'fish', len: 0.75, tall: 1.1, color: '#7a5a3a', belly: '#c8a878', water: ['sea'], lo: 3, hi: 14, w: 8, price: 2, best: 'day', seasons: ['summer', 'autumn'], where: 'Around the pilings', line: 'A bait thief with a mouth full of your worm.' },
  { name: 'Haddock', look: 'fish', len: 1.1, tall: 0.9, color: '#6a6a78', belly: '#e8e6e0', water: ['sea'], lo: 24, hi: 140, w: 3, price: 6, best: 'any', seasons: ['autumn', 'winter'], where: 'Salt water, cold months', line: 'Scrod\'s cousin. Scrod is not a species. Do not tell anyone.' },
  { name: 'Alewife', look: 'fish', len: 0.9, tall: 0.8, color: '#9fb0b8', belly: '#f0f4f4', water: ['river'], lo: 4, hi: 12, w: 5, price: 1, best: 'dawn', seasons: ['summer'], where: 'River, in the warm months', line: 'Runs upriver every spring. Runs everywhere, honestly.' },
  { name: 'American eel', look: 'eel', len: 1.5, tall: 0.3, color: '#4a4a2e', belly: '#b8b27a', water: ['river', 'pond'], lo: 12, hi: 70, w: 3, price: 5, best: 'night', seasons: ['summer', 'autumn'], where: 'Dark water, after dark', line: 'Slippery. You may hold it for as long as it lets you.' },
  { name: 'Lobster (illegal, put it back)', look: 'lobster', len: 1, tall: 1, color: '#b3361f', belly: '#e07a5a', water: ['sea'], lo: 16, hi: 72, w: 1.4, price: 0, best: 'night', seasons: ['summer', 'autumn', 'winter'], illegal: true, where: 'The harbour floor', line: 'Hooked, not trapped. Illegal. Marine Patrol has been told by a gull.' },
  { name: 'Rainbow smelt', look: 'fish', len: 0.9, tall: 0.45, color: '#a8c0c8', belly: '#f4f8f8', water: ['sea', 'river'], lo: 2, hi: 6, w: 3.5, price: 3, best: 'any', seasons: ['winter', 'summer'], where: 'Salt and river, winter', line: 'Winter\'s little silver pencil.' },
  { name: 'Lake trout', look: 'fish', len: 1.25, tall: 0.9, color: '#5a6a50', belly: '#d0cfa8', water: ['pond'], lo: 40, hi: 260, w: 1.5, price: 8, best: 'dawn', seasons: ['winter', 'autumn', 'summer'], where: 'Johnson Pond, the deep end', line: 'Deep and cold, like the pond\'s opinion of you.' },
  { name: 'Old boot', look: 'boot', len: 1, tall: 1, color: '#5a3c26', belly: '#3a2616', water: ['sea', 'river', 'pond'], lo: 14, hi: 40, w: 3, price: 0, best: 'any', seasons: ['summer', 'autumn', 'winter'], junk: true, where: 'Anywhere, sadly', line: 'Left foot. Naturally. The right is two towns over, living its best life.' },
  { name: 'Parking ticket', look: 'ticket', len: 1, tall: 1, color: '#e0c24a', belly: '#c8a62a', water: ['sea', 'river', 'pond'], lo: 1, hi: 1, w: 2, price: 0, best: 'any', seasons: ['summer', 'autumn', 'winter'], junk: true, where: 'Anywhere, mysteriously', line: 'Issued 1987, Tepid Falls. Still owed. Fines may apply to the fisher.' },
  { name: 'Class ring, Dithers \'74', look: 'ring', len: 1, tall: 1, color: '#d4a82a', belly: '#4a7ad0', water: ['pond', 'river'], lo: 1, hi: 1, w: 0.7, price: 640, best: 'any', seasons: ['summer', 'autumn', 'winter'], junk: true, where: 'Johnson Pond, mostly', line: 'Engraved "To Sheila." It is always Sheila.' },
  { name: 'Old Tepid', look: 'fish', len: 1.5, tall: 0.62, color: '#3f5a30', belly: '#cfcd8e', water: ['river'], lo: 320, hi: 480, w: 0.55, price: 6, best: 'dusk', seasons: ['summer', 'autumn', 'winter'], where: 'Below Tepid Falls. If it feels like it.', line: 'The legend. Old Tepid has outlived three bridges, two mayors and the old pier. Today it let you hold it. Briefly.' },
];
export const SPECIES_COUNT = SPECIES.length;
export const OLD_TEPID = SPECIES.findIndex((s) => s.name === 'Old Tepid');

export interface Spot {
  id: string; name: string;
  /** The standing area: a circle (m). */
  x: number; z: number; r: number;
  water: Water;
  /** Which way the water lies from the middle (radians, forward = (sin, cos)): where the sign points and the hint says. */
  face: number;
  /** Who is more likely to bite here (multipliers by species name); the dam's pool is where Old Tepid lives. */
  luck?: Record<string, number>;
  /** The sign's own spot, beside the area's middle. */
  note: string;
}

/** The fishing spots. The ORDER IS THE SAVE (bit i of fish.w*). APPEND ONLY. */
export const SPOTS: readonly Spot[] = [
  { id: 'pier', name: 'Pelican Pier', x: 0, z: 652, r: 20, water: 'sea', face: 0, luck: { Mackerel: 2, Cunner: 2, 'Striped bass': 1.5 }, note: 'End of the pier. Gulls included.' },
  { id: 'break', name: 'Last Light Breakwater', x: 860, z: 256, r: 40, water: 'sea', face: Math.PI, luck: { Pollock: 2, Haddock: 2, 'Lobster (illegal, put it back)': 2, 'Striped bass': 1.4 }, note: 'Deep water, long walk.' },
  { id: 'dam', name: 'Below Tepid Falls', x: 278, z: -1600, r: 14, water: 'river', face: Math.PI / 2, luck: { 'Old Tepid': 4, 'Smallmouth bass': 2, 'Brook trout': 1.6, 'Landlocked salmon': 1.6 }, note: 'The pool under the dam. Old Tepid lives here, or so they say.' },
  { id: 'bank', name: 'River Walk bank', x: 310, z: -1850, r: 14, water: 'river', face: Math.PI / 2, luck: { 'White sucker': 1.5, 'American eel': 1.5, 'Old Tepid': 1.2 }, note: 'Quiet bank by the river walk.' },
  { id: 'pond', name: 'Johnson Pond lookout', x: -570.5, z: -2475, r: 9, water: 'pond', face: Math.PI / 2, luck: { 'Yellow perch': 2, 'Chain pickerel': 1.6, 'Lake trout': 1.6, 'Class ring, Dithers \'74': 3 }, note: 'Dithers College\'s own pond. Nobody has checked the permit.' },
  { id: 'pelican', name: 'Pelican Landing jetty', x: 140, z: 518, r: 10, water: 'sea', face: Math.PI / 2, luck: { Cunner: 2, Mackerel: 1.4 }, note: 'Out on the jetty, between ferries.' },
  { id: 'tfland', name: 'Tepid Falls Landing', x: 289, z: -1693, r: 9, water: 'river', face: Math.PI / 2, luck: { 'Rainbow smelt': 1.6, Alewife: 2 }, note: 'Between ferries, a fishing spot.' },
];

// ── Words ───────────────────────────────────────────────────────────────────

export function weightText(oz: number): string {
  const o = Math.round(oz);
  if (o < 16) return `${o} oz`;
  const lb = Math.floor(o / 16), r = o % 16;
  return r ? `${lb} lb ${r} oz` : `${lb} lb`;
}

/** Dollars the dockside honor box pays: 0 for what nobody buys (the lobster is released by law, the junk is "recycled" for a dollar). */
export function valueOf(i: number, oz: number): number {
  const s = SPECIES[i];
  if (s.illegal) return 0;
  if (s.junk) return s.name === 'Old boot' ? 1 : Math.round((oz / 16) * s.price);
  return Math.max(1, Math.round((oz / 16) * s.price));
}

// ── The save ────────────────────────────────────────────────────────────────

const B = (): Record<string, number> => save.data.best;
export const bestOz = (i: number): number => B()['fish.b' + i] ?? 0;
export const caughtN = (i: number): number => B()['fish.n' + i] ?? 0;
export const spotsOf = (i: number): number => B()['fish.w' + i] ?? 0;
export const speciesCaught = (): number => SPECIES.reduce((n, _s, i) => n + (caughtN(i) > 0 ? 1 : 0), 0);
export const heaviest = (): number => B()['fish.max'] ?? 0;
export const stat = (k: 'rel' | 'sold' | 'cash'): number => B()['fish.' + k] ?? 0;
export const bump = (k: 'rel' | 'sold' | 'cash', by = 1): void => { B()['fish.' + k] = stat(k) + by; save.write(); };

/** File a landed catch (whatever happens to it next). Returns what is new about it. */
export function fileCatch(i: number, oz: number, spot: number): { newSpecies: boolean; best: boolean; heaviest: boolean } {
  const b = B(), s = SPECIES[i], first = caughtN(i) === 0, rec = oz > bestOz(i);
  b['fish.n' + i] = caughtN(i) + 1;
  if (rec) b['fish.b' + i] = Math.round(oz);
  b['fish.w' + i] = spotsOf(i) | (1 << spot);
  let hv = false;
  if (!s.junk && oz > heaviest()) { b['fish.max'] = Math.round(oz); hv = true; }
  save.write();
  return { newSpecies: first, best: rec && !first, heaviest: hv };
}

export function spotNames(mask: number): string[] { return SPOTS.filter((_s, k) => mask & (1 << k)).map((s) => s.name); }
