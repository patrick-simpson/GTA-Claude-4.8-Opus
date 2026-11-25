// Pardon's Finds, the catalogue (fun queue 2, item 13): 30 rare salvage items hidden in Pardon's Surplus & Salvage,
// a few a day. Pure data and the save, no three.js: the leaderboard, the menu and the store all read it.
//
//   - The ORDER IS THE SAVE: item i is bit i of best['pf.found'] (a plain bitmask, 30 bits). APPEND ONLY.
//   - The day's set is a function of the UTC date alone (dailyIds), so every player in the town sees the same items,
//     each player catalogues their own (personal save), and nothing needs to cross the wire.
//   - Ultra rare items are only on the floor some days (about one day in three).

import { save } from '../game/save';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'ultra';

export interface Find { name: string; rarity: Rarity; /** The one line of paperwork, shown when it is filed and in the ledger. */ line: string }

export const FINDS: readonly Find[] = [
  // Common (0-11)
  { name: 'A single snowshoe', rarity: 'common', line: 'Left foot. Tag reads: "Pair sold separately (never)."' },
  { name: 'Box of mismatched SpeedScan badges', rarity: 'common', line: 'Nine badges, nine different employees, one of them is a goat.' },
  { name: 'Canoe paddle, signed by nobody', rarity: 'common', line: 'Autograph: none. Value: priceless, in that nobody will price it.' },
  { name: 'Lava lamp, no lava', rarity: 'common', line: 'Works perfectly. Glows. Nothing happens. Returns accepted.' },
  { name: '1987 phone book, a town that does not exist', rarity: 'common', line: 'Every listing is "Sheila." Cover says Gnarlwick Falls.' },
  { name: 'Garden gnome, facing southwest', rarity: 'common', line: 'Displeased. Will not say why. Do not turn him.' },
  { name: 'Doorknob assortment, 400 knobs, 0 doors', rarity: 'common', line: 'A lot of doors were hurt in the making of this lot.' },
  { name: 'Singing trout plaque', rarity: 'common', line: 'Batteries not included. Neither is the trout.' },
  { name: 'Traffic cone, signed "Dave"', rarity: 'common', line: 'Dave has been notified. Dave does not care.' },
  { name: 'VHS: Tepid Falls Home Video, Part 6 of 5', rarity: 'common', line: 'Parts 1 to 5 are on another shelf. Possibly another store.' },
  { name: 'Mug: World\'s Okayest Harbor Authority Clerk', rarity: 'common', line: 'Dishwasher safe. Morale-wise, less so.' },
  { name: 'Spare Thruway sign: EXIT 130 and a half', rarity: 'common', line: 'The half exit has been closed since before it opened.' },
  // Uncommon (12-20)
  { name: 'Lighthouse lens, slightly used', rarity: 'uncommon', line: 'Visible from space. Seen from the lot, it is the only thing that is.' },
  { name: 'Moose-antler coat rack', rarity: 'uncommon', line: 'Moose consulted. Moose declined to comment.' },
  { name: 'Perpetual Bridge span bolt, certificate lost', rarity: 'uncommon', line: 'Genuine. Number 7 of "plenty." Hold on tight.' },
  { name: 'Hard hat, size: yes', rarity: 'uncommon', line: 'Fits every head. Protects none. Inspected: once, by a bird.' },
  { name: 'Barometer stuck on "Change"', rarity: 'uncommon', line: 'Accurate for Tepid Falls. It has never once been wrong.' },
  { name: 'Accordion, missing the accord', rarity: 'uncommon', line: 'Plays one note and then argues about it.' },
  { name: 'Inflatable moose, deflated, apologetic', rarity: 'uncommon', line: 'Sorry. Sorry. It keeps saying that, softly, from the box.' },
  { name: 'Fax machine, still warm', rarity: 'uncommon', line: 'Last received: a request to stop faxing it. Sent by itself.' },
  { name: 'Sale sign advertising the sale sign', rarity: 'uncommon', line: 'Reads: "SIGN SALE: SIGNS." Twenty percent off itself.' },
  // Rare (21-25)
  { name: 'Taxidermy duck named Gerald II', rarity: 'rare', line: 'Gerald I is not available for comment. Gerald II is a professional.' },
  { name: 'Snow globe of this store, inside this store', rarity: 'rare', line: 'Contains a smaller store. That store has one too. Do not shake.' },
  { name: 'Fourteen identical keys, none fit', rarity: 'rare', line: 'Ring includes a key to the ring. That one does not fit either.' },
  { name: 'Decoy duck, gold-ish, "not THE duck"', rarity: 'rare', line: 'We checked. We checked again. It is a decoy. It knows.' },
  { name: 'Tide table for Johnson Pond', rarity: 'rare', line: 'Johnson Pond has no tide. The table predicts one anyway, boldly.' },
  // Ultra rare (26-29): only on the floor some days
  { name: 'Sasquatch\'s receipt, 1974', rarity: 'ultra', line: 'Paid cash. Left no forwarding address. Tipped the cashier a boulder.' },
  { name: 'Meteorite, tagged "Aisle 9"', rarity: 'ultra', line: 'Fell from the sky into Aisle 9. Priced to move. It moved.' },
  { name: 'Perpetual Bridge blueprints, scale 1:1, folded', rarity: 'ultra', line: 'Cannot be unfolded without a second bridge. Hence: folded.' },
  { name: 'The Golden Cart', rarity: 'ultra', line: 'All four wheels turn the same way. Management is stunned.' },
];
export const FIND_COUNT = FINDS.length;
export const FIND_PRICE = 2;
export const RARITY_ORDER: readonly Rarity[] = ['common', 'uncommon', 'rare', 'ultra'];
export const RARITY_LABEL: Record<Rarity, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', ultra: 'ULTRA RARE' };

const KEY = 'pf.found';
const popcount = (n: number): number => { let c = 0; for (let i = 0; i < FIND_COUNT; i++) if (n & (1 << i)) c++; return c; };

export const foundMask = (): number => save.data.best[KEY] ?? 0;
export const hasFound = (i: number): boolean => (foundMask() & (1 << i)) !== 0;
export const findsCatalogued = (): number => popcount(foundMask());
export function markFound(i: number): number {
  const m = foundMask() | (1 << i);
  save.data.best[KEY] = m;
  save.write();
  return popcount(m);
}

// ── The day ─────────────────────────────────────────────────────────────────

let dayOverride: string | null = null;
/** Test and demo hook: pretend it is another UTC date ('2026-11-26'); null for the real one. */
export function setFindsDay(d: string | null): void { dayOverride = d; }
/** The shared day: the real UTC date, as 'YYYY-MM-DD'. */
export function findsDay(): string { return dayOverride ?? new Date().toISOString().slice(0, 10); }

function seedOf(day: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < day.length; i++) h = Math.imul(h ^ day.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
/** Small seeded generator (mulberry32). */
export function dayRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WEIGHT: Record<Rarity, number> = { common: 6, uncommon: 3, rare: 1.2, ultra: 0 };

/** The day's finds, by item index: 3 to 5 of them, one an ultra rare on about a day in three. */
export function dailyIds(day: string = findsDay()): { ids: number[]; ultra: boolean } {
  const r = dayRng(seedOf(day) ^ 0x5eed);
  const n = 3 + Math.floor(r() * 3);
  const ultraDay = r() < 0.34;
  const ids: number[] = [];
  if (ultraDay) {
    const ultras = FINDS.map((f, i) => (f.rarity === 'ultra' ? i : -1)).filter((i) => i >= 0);
    ids.push(ultras[Math.floor(r() * ultras.length)]);
  }
  while (ids.length < n) {
    const pool = FINDS.map((f, i) => ({ i, w: ids.includes(i) ? 0 : WEIGHT[f.rarity] })).filter((q) => q.w > 0);
    let t = r() * pool.reduce((s, q) => s + q.w, 0);
    let pick = pool[pool.length - 1].i;
    for (const q of pool) { t -= q.w; if (t <= 0) { pick = q.i; break; } }
    ids.push(pick);
  }
  return { ids, ultra: ultraDay };
}
