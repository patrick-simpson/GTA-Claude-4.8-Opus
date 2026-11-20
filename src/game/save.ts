// The save: one versioned JSON document in localStorage.
//
// What is in it: where Dess is and what she has (money, health, weapons, the
// car she was sitting in, the time of day), which missions are filed, which
// ducks are found, which jumps are landed, how often each job has been done
// (so repeat payouts can taper), the statistics, and the settings.
//
// What is NOT in it: the bridge and the town stages. progress.ts keeps those
// under its own key, because the plan has to know which streets are closed
// before the world is built, long before anything here runs. A new game wipes
// both (see ThingsToDo.newGame).
//
// Nothing here throws. Missing, corrupt or old data becomes a fresh document,
// field by field: a save with one bad number keeps everything else.
//
// `?save=0` in the address neither reads nor writes (screenshots and tests
// that want the first morning every time).

import type { Game } from '../core/game';
import { isWater } from '../world/plan';
import { WEAPONS } from '../ent/weapons';
import { SPECS, type VehicleKind } from '../ent/vehicleSpecs';
import type { Weather } from '../core/api';

const KEY = 'portcalamity.save.v1';
export const SAVE_VERSION = 1;

export type QualityPick = 'auto' | 'low' | 'medium' | 'high';
export interface Settings {
  /** Mouse and stick look speed, 0.3 .. 2.5. */
  sens: number;
  invertY: boolean;
  quality: QualityPick;
  /** A tap or click on the game takes the whole screen. */
  fsTap: boolean;
  reducedMotion: boolean;
  /** Sound (src/audio/), each 0..1: everything; the car radio; engines, effects and the UI; the weather and the town. */
  volMaster: number; volMusic: number; volSfx: number; volAmbience: number;
  /** The station the radio was left on: -1 = off. */
  station: number;
}

export interface Stats {
  /** Meters. */
  driven: number; walked: number;
  cars: number;
  /** m/s. */
  topSpeed: number;
  /** Seconds, and meters, of the best flight. */
  airtime: number; airDist: number;
  booked: number; deaths: number;
  passed: number; failed: number;
  fares: number; tows: number; parcels: number; races: number;
  /** Dollars paid out by missions and jobs. */
  earned: number;
  /** Seconds of play. */
  played: number;
}

export interface SavedPlayer {
  x: number; z: number; h: number;
  health: number; armor: number; money: number;
  hour: number; weather: Weather;
  car: { kind: VehicleKind; color: number; health: number } | null;
  owned: boolean[]; mags: number[]; spare: number[]; slot: number;
}

export interface SaveDoc {
  v: number;
  /** Date.now() of the last write. */
  when: number;
  player: SavedPlayer | null;
  /** Ids of the story missions filed as done. */
  missions: string[];
  /** Indices of the golden ducks found, and of the stunt ramps landed. */
  ducks: number[];
  jumps: number[];
  /** How many times each job has paid out, by key. Payouts taper on these. */
  counts: Record<string, number>;
  /** Best times (seconds, lower is better) and best scores (higher is better), by key. */
  best: Record<string, number>;
  stats: Stats;
  settings: Settings;
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const ints = (v: unknown, max: number): number[] => {
  const out: number[] = [];
  if (Array.isArray(v)) for (const n of v) if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n);
  return out;
};
const table = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v))) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
};

export function freshStats(): Stats {
  return { driven: 0, walked: 0, cars: 0, topSpeed: 0, airtime: 0, airDist: 0, booked: 0, deaths: 0, passed: 0, failed: 0, fares: 0, tows: 0, parcels: 0, races: 0, earned: 0, played: 0 };
}
export function freshSettings(): Settings {
  return { sens: 1, invertY: false, quality: 'auto', fsTap: true, reducedMotion: false, volMaster: 0.8, volMusic: 0.7, volSfx: 0.8, volAmbience: 0.8, station: 0 };
}
function fresh(): SaveDoc {
  return { v: SAVE_VERSION, when: 0, player: null, missions: [], ducks: [], jumps: [], counts: {}, best: {}, stats: freshStats(), settings: freshSettings() };
}

/** Whatever was in storage, made into a document that can be trusted. Exported for the tests. */
export function sanitize(raw: unknown): SaveDoc {
  const d = fresh(), r = obj(raw);
  // A document from a later version is somebody else's: start clean rather than guess. Older ones are read field by field.
  if (typeof r.v === 'number' && r.v > SAVE_VERSION) return d;
  d.when = num(r.when, 0, 0);
  const p = obj(r.player);
  if (typeof p.x === 'number' && typeof p.z === 'number' && Number.isFinite(p.x) && Number.isFinite(p.z)) {
    const n = WEAPONS.length, c = obj(p.car);
    const arr = (v: unknown, f: (x: unknown, i: number) => number | boolean): (number | boolean)[] =>
      Array.from({ length: n }, (_, i) => f(Array.isArray(v) ? v[i] : undefined, i));
    const wx = p.weather;
    d.player = {
      x: p.x, z: p.z, h: num(p.h, 0),
      health: num(p.health, 100, 1, 100), armor: num(p.armor, 0, 0, 100), money: num(p.money, 0, -1e7, 1e9),
      hour: num(p.hour, 8, 0, 24), weather: wx === 'overcast' || wx === 'fog' || wx === 'rain' ? wx : 'clear',
      car: typeof c.kind === 'string' && c.kind in SPECS
        ? { kind: c.kind as VehicleKind, color: num(c.color, 0xe4572e, 0, 0xffffff), health: num(c.health, 100, 25, 100) } : null,
      owned: arr(p.owned, (x, i) => i === 0 || x === true) as boolean[],
      mags: arr(p.mags, (x, i) => num(x, 0, 0, WEAPONS[i].mag)) as number[],
      spare: arr(p.spare, (x, i) => num(x, 0, 0, WEAPONS[i].reserve)) as number[],
      slot: Math.floor(num(p.slot, 0, 0, n - 1)),
    };
  }
  if (Array.isArray(r.missions)) for (const m of r.missions) if (typeof m === 'string' && m.length < 40 && !d.missions.includes(m)) d.missions.push(m);
  d.ducks = ints(r.ducks, 64);
  d.jumps = ints(r.jumps, 64);
  d.counts = table(r.counts);
  d.best = table(r.best);
  const s = obj(r.stats), ds = d.stats as unknown as Record<string, number>;
  for (const k of Object.keys(ds)) ds[k] = num(s[k], 0, 0);
  const t = obj(r.settings);
  d.settings.sens = num(t.sens, 1, 0.3, 2.5);
  d.settings.invertY = bool(t.invertY, false);
  d.settings.quality = t.quality === 'low' || t.quality === 'medium' || t.quality === 'high' ? t.quality : 'auto';
  d.settings.fsTap = bool(t.fsTap, true);
  d.settings.reducedMotion = bool(t.reducedMotion, false);
  d.settings.volMaster = num(t.volMaster, 0.8, 0, 1);
  d.settings.volMusic = num(t.volMusic, 0.7, 0, 1);
  d.settings.volSfx = num(t.volSfx, 0.8, 0, 1);
  d.settings.volAmbience = num(t.volAmbience, 0.8, 0, 1);
  d.settings.station = Math.round(num(t.station, 0, -1, 5));
  return d;
}

class SaveStore {
  data: SaveDoc = fresh();
  /** False with `?save=0`: nothing is read and nothing is written. */
  readonly enabled: boolean;
  /** While a mission or a job is running, the player block is left as it was when it began: a reload puts her back where she took it. */
  hold = false;
  /** How many times the document has been written this visit, for the tests. */
  writes = 0;

  constructor() {
    let on = true;
    try { on = new URLSearchParams(location.search).get('save') !== '0'; } catch { /* no address */ }
    this.enabled = on;
    this.load();
  }

  load(): void {
    if (!this.enabled) return;
    try { this.data = sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { this.data = fresh(); }
  }

  write(): void {
    if (!this.enabled) return;
    this.data.when = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); this.writes++; } catch { /* storage full or refused: play on */ }
  }

  /** A new game: everything but the settings. */
  wipe(): void {
    const settings = this.data.settings;
    this.data = fresh();
    this.data.settings = settings;
    this.write();
  }

  /** Cash paid out while the player block is held: add it to the held copy, or a reload in mid-shift would keep the tally and lose the money. */
  credit(cash: number): void { if (this.hold && this.data.player) this.data.player.money += cash; }

  /** How many times a job has paid, and one more. */
  count(key: string): number { return this.data.counts[key] ?? 0; }
  bump(key: string): number { return (this.data.counts[key] = this.count(key) + 1); }
  /** Keep the lower (times) or the higher (scores) of the record and `v`. True if `v` is the new record. */
  record(key: string, v: number, lowerWins: boolean): boolean {
    const old = this.data.best[key];
    if (old !== undefined && (lowerWins ? old <= v : old >= v)) return false;
    this.data.best[key] = v;
    return true;
  }
}

export const save = new SaveStore();

/** The quality the player chose in the menu, or null for "let the game decide". Game.pickQuality asks before anything is built. */
export function savedQuality(): 'low' | 'medium' | 'high' | null {
  const q = save.data.settings.quality;
  return q === 'auto' ? null : q;
}

/** Copy the live player into the document. Skipped while held, or while she is down. */
export function capture(game: Game): void {
  if (save.hold) return;
  const p = game.player, w = p.weapons, v = p.vehicle;
  if (!(p.health > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
  save.data.player = {
    x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: +p.h.toFixed(3),
    health: Math.ceil(p.health), armor: Math.ceil(p.armor), money: Math.round(p.money * 100) / 100,
    hour: +game.sky.hour.toFixed(3), weather: game.sky.weather,
    car: v && !v.wreck && !v.sunk ? { kind: v.spec.kind, color: v.color, health: Math.round(v.health) } : null,
    owned: w.owned.slice(), mags: w.mags.slice(), spare: w.spare.slice(), slot: w.slot,
  };
}

/** Put the saved player back into the world. Returns false when there was nothing (or nothing usable) to restore. */
export function restore(game: Game): boolean {
  const s = save.data.player, b = game.plan.bounds;
  if (!s) return false;
  const p = game.player, w = p.weapons;
  p.money = s.money; p.health = s.health; p.armor = s.armor;
  p.person.health = s.health;
  for (let i = 1; i < WEAPONS.length; i++) { w.owned[i] = s.owned[i]; w.mags[i] = s.mags[i]; w.spare[i] = s.spare[i]; }
  if (w.owned[s.slot]) w.select(s.slot);
  game.sky.hour = s.hour;
  game.sky.setWeather(s.weather, true);
  // Somewhere that no longer makes sense (off the chart, or out at sea): keep what she has, start her from home.
  if (s.x < b.x0 || s.x > b.x1 || s.z < b.z0 || s.z > b.z1 || isWater(s.x, s.z)) return true;
  p.teleport(s.x, s.z, s.h);
  if (s.car) {
    // The car she saved in may be one the world parks there anyway (the tow truck on the first morning): use it, do not stack a second on top.
    const kind = s.car.kind;
    let v = game.vehicles.nearest(s.x, s.z, 3, (c) => c.spec.kind === kind && c.driver === null && !c.wreck);
    if (!v) {
      for (let c = game.vehicles.nearest(s.x, s.z, 5, (o) => o.driver === null); c; c = game.vehicles.nearest(s.x, s.z, 5, (o) => o.driver === null)) game.vehicles.remove(c);
      v = game.vehicles.spawn(kind, s.x, s.z, s.h, s.car.color);
    }
    v.health = s.car.health;
    p.enter(v, true);
  }
  return true;
}
