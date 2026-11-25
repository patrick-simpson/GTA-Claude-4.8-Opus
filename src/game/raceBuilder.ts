// Fun queue 2, item 18: the street race builder (the map's "Race Builder", ui/raceBuilder.ts).
//
// A built race is 3 to 12 checkpoints on streets (the first is the start line), 1 to 3 laps, and a name picked from lists
// (never typed). It is a BuiltSpec: the name index, the laps, whether it runs back to the start, and the pins as cells of
// BUILT_Q metres (net/protocol.ts). buildSpec() is the one place a spec becomes a race: every pin is snapped to the
// nearest open street (water, closed stages and spots far from any street are refused), every leg is traced along the
// streets (game/nav.ts; an unreachable leg refuses the race), and the result is a RaceDef like the old routes, so the
// race itself (game/race.ts: the lights, the grid, the checkpoints, the podium, the multiplayer call) is reused whole.
// The author's page and every other page run the same function over the same cells, and a spec that comes off the
// network is only ever used through it, so a forged or broken one is simply refused.
//
// Lists: the player's own races (up to 5, kept in this browser), and the town's (net/townRaces.ts: the last 10 published,
// kept by the host as facts). Defs are built lazily, one per frame at most (tick()), and cached by spec.
// Route numbers (for the race frames): the town's are BUILT_ROUTE0 + slot, the player's own BUILT_LOCAL + n (never sent).

import type { Game } from '../core/game';
import { isWater } from '../world/plan';
import type { RoadEdge } from '../world/plan';
import { Navigator } from './nav';
import type { RaceDef } from './activities';
import { save } from './save';
import {
  BUILT_LOCAL, BUILT_MAX_LAPS, BUILT_MAX_PINS, BUILT_MIN_PINS, BUILT_NAME_SIZES, BUILT_NAMES, BUILT_OX, BUILT_OZ, BUILT_Q, BUILT_ROUTE0, BUILT_SLOTS,
  type BuiltSpec,
} from '../net/protocol';

export const MAX_PERSONAL = 5;
/** A built race is at least this long (one lap), meters: no tiny loops to farm cash. */
export const MIN_LAP_M = 500;
const MAX_LAP_M = 12000;
/** Pins closer than this to the one before are refused, meters. */
const MIN_LEG_M = 40;
/** A tap further than this from a street finds none, meters. */
const SNAP_M = 40;
/** Seconds between a player's publishes. */
export const PUBLISH_GAP_S = 60;
/** The par speed, m/s (about 45 km/h: a fair time on city streets). */
const PAR_MS = 11.5;
const LS_KEY = 'pc.races.v1';

const ADJ = ['Soggy', 'Wobbly', 'Reckless', 'Lukewarm', 'Sideways', 'Frantic', 'Honest', 'Squeaky', 'Tepid', 'Overdue', 'Slippery', 'Grumpy', 'Polite', 'Dented', 'Salty', 'Unlicensed'] as const;
const THING = ['Pickle', 'Pelican', 'Waffle', 'Tugboat', 'Mackerel', 'Traffic Cone', 'Doofus', 'Parking Meter', 'Casserole', 'Walrus', 'Lasagna', 'Hubcap', 'Muffin', 'Sardine', 'Trombone', 'Stapler'] as const;
const KIND = ['Dash', 'Derby', 'Scramble', 'Sprint', 'Circuit', 'Run', 'Rally', 'Gauntlet'] as const;
/** The build stops here when the lists and the protocol's sizes disagree. */
const SZ: readonly [typeof ADJ.length, typeof THING.length, typeof KIND.length] = BUILT_NAME_SIZES;
void SZ;

/** A race name from its index (0 .. BUILT_NAMES - 1). */
export function raceNameText(i: number): string {
  const n = Math.max(0, Math.min(BUILT_NAMES - 1, Math.floor(i)));
  return `The ${ADJ[n % 16]} ${THING[Math.floor(n / 16) % 16]} ${KIND[Math.floor(n / 256)]}`;
}

export const cellX = (x: number): number => Math.max(0, Math.min(2047, Math.round((x - BUILT_OX) / BUILT_Q)));
export const cellZ = (z: number): number => Math.max(0, Math.min(2047, Math.round((z - BUILT_OZ) / BUILT_Q)));
export const cellPoint = (ix: number, iz: number): { x: number; z: number } => ({ x: BUILT_OX + ix * BUILT_Q, z: BUILT_OZ + iz * BUILT_Q });
export const specKey = (s: BuiltSpec): string => `${s.laps}${s.back ? 'b' : 'o'}${s.name}:${s.cells.join('.')}`;
const hash3 = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 4096).toString(16).toUpperCase().padStart(3, '0');
};

export interface Built { def: RaceDef; poly: number[]; length: number; pins: { x: number; z: number }[] }

/** One entry of the town's list (net/townRaces.ts): slot -1 is one only heard this session (not kept by the host). */
export interface TownEntry { slot: number; spec: BuiltSpec; by: number[] | null; best: number; bestBy: number[] | null; key: string }
/** What the network gives the builder (net/townRaces.ts). */
export interface BuilderLink {
  entries(): TownEntry[];
  /** Null when sent, else why not. */
  publish(spec: BuiltSpec): string | null;
  online(): boolean;
}

/** The street nearest a tap, as a point on its centreline; or why not. */
export function snapPoint(game: Game, x: number, z: number): { x: number; z: number } | string {
  const plan = game.plan, G = plan.streets;
  let edge: RoadEdge, d: number, px: number, pz: number;
  if (G) {
    const r = G.nearestEdge(x, z);
    edge = r.edge; d = r.d;
    const q = G.pointAt(edge, r.s); px = q.x; pz = q.z;
  } else {
    const r = plan.nearestEdge(x, z);
    edge = r.edge; d = r.d;
    const A = plan.nodes[edge.a];
    px = edge.horiz ? A.x + r.s : A.x; pz = edge.horiz ? A.z : A.z + r.s;
  }
  if (isWater(x, z) && !(edge.deck && d < 14)) return 'That is water. Pick a spot on a street.';
  if (d > SNAP_M) return 'No street near there. Tap closer to a road.';
  if (edge.closed) return 'That street is closed for now.';
  return { x: px, z: pz };
}

export class RaceBuilder {
  link: BuilderLink | null = null;
  /** The player's own races, newest last. */
  personal: BuiltSpec[] = [];
  /** Bumps whenever the lists or the built races change (the panel redraws on it). */
  rev = 0;
  readonly stats = { built: 0, refused: 0, published: 0 };
  private readonly nav = new Navigator();
  private readonly cache = new Map<string, Built | string>();
  private all_: RaceDef[] = [];
  private allRev = -1; private allBase = -1;
  private lastPublish = -1e9;

  constructor(private readonly game: Game) {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as unknown;
      if (Array.isArray(raw)) for (const o of raw.slice(0, MAX_PERSONAL)) { const s = this.clean(o); if (s) this.personal.push(s); }
    } catch { /* none kept */ }
  }

  /** A spec from stored or received data, or null: counts, bounds and the name index only (the streets are buildSpec's). */
  clean(o: unknown): BuiltSpec | null {
    const v = o as Partial<BuiltSpec> | null;
    if (!v || !Array.isArray(v.cells) || typeof v.name !== 'number' || typeof v.laps !== 'number') return null;
    const n = v.cells.length / 2;
    if (!Number.isInteger(n) || n < BUILT_MIN_PINS || n > BUILT_MAX_PINS) return null;
    if (!Number.isInteger(v.name) || v.name < 0 || v.name >= BUILT_NAMES || !Number.isInteger(v.laps) || v.laps < 1 || v.laps > BUILT_MAX_LAPS) return null;
    for (const c of v.cells) if (!Number.isInteger(c) || c < 0 || c > 2047) return null;
    return { name: v.name, laps: v.laps, back: v.laps > 1 || !!v.back, cells: v.cells.slice() };
  }

  private store(): void {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.personal)); } catch { /* storage refused: they stay for this visit */ }
  }

  // ── Building ───────────────────────────────────────────────────────────────

  /** The race a spec makes, or why it cannot be one. Cached: the same spec is worked out once. */
  build(spec: BuiltSpec): Built | string {
    const key = specKey(spec), hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const r = this.work(spec);
    this.cache.set(key, r);
    if (typeof r === 'string') this.stats.refused++; else this.stats.built++;
    return r;
  }
  /** Only what is already worked out. */
  peek(spec: BuiltSpec): Built | string | undefined { return this.cache.get(specKey(spec)); }

  private work(spec: BuiltSpec): Built | string {
    const s = this.clean(spec);
    if (!s) return 'Not a race.';
    const g = this.game, n = s.cells.length / 2;
    const pins: { x: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      const q = cellPoint(s.cells[2 * i], s.cells[2 * i + 1]), r = snapPoint(g, q.x, q.z);
      if (typeof r === 'string') return `Checkpoint ${i + 1}: ${r}`;
      pins.push(r);
    }
    for (let i = 1; i < n; i++) if (Math.hypot(pins[i].x - pins[i - 1].x, pins[i].z - pins[i - 1].z) < MIN_LEG_M) return `Checkpoints ${i} and ${i + 1} are too close together.`;
    const poly: number[] = [], edges: number[] = [];
    let length = 0;
    const legs = s.back ? n : n - 1;
    for (let i = 0; i < legs; i++) {
      const a = pins[i], b = pins[(i + 1) % n];
      const t = this.nav.trace(g.plan, a.x, a.z, b.x, b.z);
      if (!t || t.total < 1) return `No drivable way from checkpoint ${i + 1} to ${(i + 1) % n + 1}. It may be across water or behind a closed street.`;
      for (let k = 0; k < t.poly.length; k += 2) if (!poly.length || k > 0) poly.push(t.poly[k], t.poly[k + 1]);
      for (const e of t.edges) if (!edges.includes(e)) edges.push(e);
      length += t.total;
    }
    if (length < MIN_LAP_M) return `Too short: a lap needs at least ${MIN_LAP_M} m of road, this has ${Math.round(length)} m.`;
    if (length > MAX_LAP_M) return 'Too long for one lap.';
    let dx = 0, dz = 0;
    for (let k = 2; k < poly.length; k += 2) { dx = poly[k] - poly[0]; dz = poly[k + 1] - poly[1]; if (Math.hypot(dx, dz) > 6) break; }
    const dl = Math.hypot(dx, dz) || 1;
    const name = `${raceNameText(s.name)} (${hash3(specKey(s))})`;
    const cps = pins.slice(1).map((p) => ({ x: p.x, z: p.z }));
    if (s.back) cps.push({ x: pins[0].x, z: pins[0].z });
    const def: RaceDef = {
      name, par: Math.max(20, Math.round((length * s.laps) / PAR_MS)), start: { x: pins[0].x, z: pins[0].z }, cps, laps: s.laps, loop: s.back, edges, idx: 0,
      dir: { x: dx / dl, z: dz / dl },
    };
    return { def, poly, length, pins };
  }

  /** Per frame: work out one waiting race (the player's own first, then the town's). */
  tick(): void {
    for (const s of this.personal) if (this.cache.get(specKey(s)) === undefined) { this.build(s); this.rev++; return; }
    for (const e of this.link?.entries() ?? []) if (this.cache.get(specKey(e.spec)) === undefined) { this.build(e.spec); this.rev++; return; }
  }
  /** The town's list changed (net/townRaces.ts). */
  changed(): void { this.rev++; }

  /** `base` (the old routes) then every built race that works, as RaceDefs with their route numbers. A cached list. */
  all(base: RaceDef[]): RaceDef[] {
    if (this.allRev === this.rev && this.allBase === base.length) return this.all_;
    const out = base.slice();
    const seen = new Set<string>();
    for (const e of this.link?.entries() ?? []) {
      if (e.slot < 0 || e.slot >= BUILT_SLOTS) continue;
      const b = this.peek(e.spec);
      if (!b || typeof b === 'string') continue;
      seen.add(specKey(e.spec));
      out.push({ ...b.def, idx: BUILT_ROUTE0 + e.slot });
    }
    this.personal.forEach((s, i) => {
      const b = this.peek(s);
      // (One already in the town's list is run from there, with its town route number.)
      if (b && typeof b !== 'string' && !seen.has(specKey(s))) out.push({ ...b.def, idx: BUILT_LOCAL + i });
    });
    this.all_ = out; this.allRev = this.rev; this.allBase = base.length;
    return out;
  }

  /** The route a town entry or a personal race would run as: a published race keeps its town route number. */
  defOf(spec: BuiltSpec): RaceDef | null {
    const b = this.peek(spec);
    if (!b || typeof b === 'string') return null;
    const key = specKey(spec), t = (this.link?.entries() ?? []).find((e) => e.slot >= 0 && specKey(e.spec) === key);
    if (t) return { ...b.def, idx: BUILT_ROUTE0 + t.slot };
    const i = this.personal.findIndex((s) => specKey(s) === key);
    return { ...b.def, idx: i >= 0 ? BUILT_LOCAL + i : BUILT_LOCAL + MAX_PERSONAL };
  }

  // ── The player's list ──────────────────────────────────────────────────────

  /** Save a race to the player's list; null when saved, else why not. */
  addPersonal(spec: BuiltSpec): string | null {
    const s = this.clean(spec);
    if (!s) return 'Not a race.';
    if (this.personal.length >= MAX_PERSONAL) return `You can keep ${MAX_PERSONAL} races. Delete one first.`;
    const b = this.build(s);
    if (typeof b === 'string') return b;
    if (this.personal.some((p) => specKey(p) === specKey(s))) return 'You already saved this one.';
    this.personal.push(s);
    this.store(); this.rev++;
    return null;
  }
  removePersonal(i: number): void { if (i >= 0 && i < this.personal.length) { this.personal.splice(i, 1); this.store(); this.rev++; } }

  /** Share a saved race with the town; null when sent, else why not. */
  publish(spec: BuiltSpec): string | null {
    if (!this.link || !this.link.online()) return 'Join the town to publish. You are playing alone.';
    const now = performance.now();
    if (now - this.lastPublish < PUBLISH_GAP_S * 1000) return `Wait ${Math.ceil((PUBLISH_GAP_S * 1000 - (now - this.lastPublish)) / 1000)} s before publishing again.`;
    const b = this.build(spec);
    if (typeof b === 'string') return b;
    const why = this.link.publish(spec);
    if (why) return why;
    this.lastPublish = now; this.stats.published++;
    return null;
  }
  published(spec: BuiltSpec): boolean { const k = specKey(spec); return (this.link?.entries() ?? []).some((e) => e.slot >= 0 && specKey(e.spec) === k); }

  /** This player's best time on a race, seconds, or undefined. */
  best(def: RaceDef): number | undefined { return save.data.best['race:' + def.name]; }

  /** Show the way to a race's start line (the map's "Drive it" and "Call a race"): the waypoint, then the menu closes. */
  goTo(def: RaceDef): void {
    const t = this.game.todo;
    t.dest = null;
    t.waypoint = { x: def.start.x, z: def.start.z };
  }

  info(): Record<string, unknown> {
    return { ...this.stats, personal: this.personal.length, town: (this.link?.entries() ?? []).length, defs: this.all_.length, rev: this.rev };
  }
}
