// Fun queue 2, item 18: races the players build, the wire (the builder itself is game/raceBuilder.ts).
//
// PUBLISH: a player sends one Event frame (PlayerEvent.Built, 23: name index, laps, checkpoints as quantised cells; layout
// in protocol.ts). Everybody present gets it; the HOST checks it (counts, bounds, the name index, every pin on an open
// street, every leg drivable: RaceBuilder.build), rate limits it, and keeps the last BUILT_SLOTS (10) in durable facts,
// BUILT_KEYS (5) keys of 16 numbers, so a late joiner sees them in the welcome and they outlive everybody leaving. A guest
// that hears a publish and has no fact for it yet holds it for this session only ("heard"), so with a host page from
// before this feature the race is still there for whoever was present. Nothing typed ever travels: a name is an index.
//
// THE TOWN BEST of a published race is in its slot's fact. The race itself is net/race.ts: a built race is route
// BUILT_ROUTE0 + slot, the call, the grid, the checkpoints and the Done frames are the old ones unchanged, and when a racer
// finishes the host (which hears every Done) writes this slot's best if it is a better time, under the racer's name.
// Facts used: 5 keys (rb.0 .. rb.4), on top of the 4 board, 9 race, 2 pursuit, 2 derby and 5 others: 27 of the 32.
// No service change, still protocol v6.

import type { Game } from '../core/game';
import type { Connection } from './conn';
import type { Remote } from './remote';
import {
  BUILT_FACT_PREFIX, BUILT_KEYS, BUILT_ROUTE0, BUILT_SLOTS, decodeBuilt, encodeBuilt, encodeMsg, packBuiltCells, packBuiltHead, unpackBuilt,
  type BuiltSpec, type FactValue,
} from './protocol';
import { myName, nameText } from './names';
import { packName, unpackName } from './leaderboard';
import { specKey, type BuilderLink, type TownEntry } from '../game/raceBuilder';
import type { TownRecord } from '../game/race';

/** A time faster than this share of par (par is the route at about 41 km/h) is not believed (a test teleport, a broken page), and not written: 0.15 is over 270 km/h. */
const FASTEST = 0.15;
/** The most one player may publish: once per this long (the host; the sender keeps a longer gap itself). */
const HOST_GAP_MS = 30000;
/** And the town at most this many in a minute. */
const TOWN_PER_MIN = 6;
const HEARD_MAX = 10;

interface Slot { spec: BuiltSpec; pub: number; seq: number; best: number }

export class TownRaces implements BuilderLink {
  readonly stats = { sent: 0, got: 0, accepted: 0, refused: 0, limited: 0, written: 0, bests: 0, heard: 0 };
  private readonly raw: number[][] = Array.from({ length: BUILT_KEYS }, () => new Array<number>(16).fill(0));
  private slots: (Slot | null)[] = new Array<Slot | null>(BUILT_SLOTS).fill(null);
  private heard: { spec: BuiltSpec; by: number[] }[] = [];
  private head = 0;
  private list: TownEntry[] | null = null;
  private readonly lastBy = new Map<number, number>();
  private readonly recent: number[] = [];
  /** Why the last refusals (for the tests). */
  lastWhy = '';

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.builder.link = this;
  }

  private get builder() { return this.game.todo.raceBuilder; }
  private get host(): boolean { return this.online() && this.conn.host === this.conn.id; }
  online(): boolean { return this.conn.status === 'online'; }

  // ── BuilderLink ────────────────────────────────────────────────────────────

  entries(): TownEntry[] {
    if (this.list) return this.list;
    const age = (s: Slot): number => (this.head - s.seq + 255) % 255;
    const out: TownEntry[] = [];
    const keys = new Set<string>();
    this.slots.map((s, slot) => ({ s, slot })).filter((o): o is { s: Slot; slot: number } => !!o.s).sort((a, b) => age(a.s) - age(b.s)).forEach(({ s, slot }) => {
      const key = specKey(s.spec); keys.add(key);
      out.push({ slot, spec: s.spec, by: unpackName(s.pub), best: s.best >= 262144 ? Math.floor(s.best / 262144) : 0, bestBy: s.best >= 262144 ? unpackName(s.best % 262144) : null, key });
    });
    for (const h of this.heard.slice().reverse()) {
      const key = specKey(h.spec);
      if (!keys.has(key)) out.push({ slot: -1, spec: h.spec, by: h.by, best: 0, bestBy: null, key });
    }
    return (this.list = out);
  }

  publish(spec: BuiltSpec): string | null {
    if (!this.online()) return 'Join the town to publish. You are playing alone.';
    if (this.host) { const why = this.accept(this.conn.id, spec, [...myName()]); if (why) return why; this.stats.sent++; return null; }
    if (!this.conn.send(encodeBuilt(spec))) return 'The town did not take it. Try again in a moment.';
    this.stats.sent++;
    return null;
  }

  /** The town's best on a built route (net/race.ts record()). */
  record(route: number): TownRecord | null {
    const e = this.slots[route - BUILT_ROUTE0];
    if (!e || e.best < 262144) return null;
    return { race: Math.floor(e.best / 262144) * 100, raceBy: nameText(unpackName(e.best % 262144)), lap: 0, lapBy: '', laps: e.spec.laps };
  }

  // ── In ─────────────────────────────────────────────────────────────────────

  /** An Event frame with the Built code (index.ts). */
  event(buf: ArrayBuffer): void {
    const m = decodeBuilt(buf);
    const from = m ? this.remotes.get(m.id) : undefined;
    if (!m || !from || !this.online()) { if (!m) this.stats.refused++; return; }
    this.stats.got++;
    const spec = this.builder.clean(m);
    if (!spec) { this.stats.refused++; return; }
    if (this.host) { this.accept(m.id, spec, from.name.slice()); return; }
    // A guest: held for this session only if the host does not keep it (its fact replaces this).
    const now = performance.now();
    if (now - (this.lastBy.get(m.id) ?? -1e9) < HOST_GAP_MS) { this.stats.limited++; return; }
    this.lastBy.set(m.id, now);
    const key = specKey(spec);
    if (this.slots.some((s) => s && specKey(s.spec) === key) || this.heard.some((h) => specKey(h.spec) === key)) return;
    const b = this.builder.build(spec);
    if (typeof b === 'string') { this.stats.refused++; this.lastWhy = b; return; }
    this.heard.push({ spec, by: from.name.slice() });
    if (this.heard.length > HEARD_MAX) this.heard.shift();
    this.stats.heard++;
    this.list = null; this.builder.changed();
  }

  /** The welcome's facts (index.ts). */
  welcome(facts: Record<string, FactValue>): void {
    for (const r of this.raw) r.fill(0);
    this.slots.fill(null); this.heard = []; this.list = null;
    for (const k of Object.keys(facts)) this.fact(k, facts[k]);
    this.builder.changed();
  }

  /** A fact (index.ts): only the rb.n keys are ours. */
  fact(k: string, v: FactValue): void {
    if (!k.startsWith(BUILT_FACT_PREFIX) || !Array.isArray(v) || v.length !== 16) return;
    const n = Number(k.slice(BUILT_FACT_PREFIX.length));
    if (!Number.isInteger(n) || n < 0 || n >= BUILT_KEYS) return;
    this.raw[n] = v.slice();
    for (let h = 0; h < 2; h++) {
      const u = unpackBuilt(v, h * 8);
      this.slots[n * 2 + h] = u ? { spec: u.spec, pub: u.pub, seq: u.seq, best: u.best } : null;
    }
    this.headFrom();
    const keys = new Set(this.slots.filter((s): s is Slot => !!s).map((s) => specKey(s.spec)));
    this.heard = this.heard.filter((h) => !keys.has(specKey(h.spec)));
    this.list = null; this.builder.changed();
  }

  /** The newest seq: the one every other is within 10 behind (a ring of 255). */
  private headFrom(): void {
    const seqs = this.slots.filter((s): s is Slot => !!s).map((s) => s.seq);
    this.head = 0;
    for (const s of seqs) if (seqs.every((o) => (s - o + 255) % 255 < BUILT_SLOTS)) { this.head = s; break; }
  }

  dropped(id: number): void { this.lastBy.delete(id); }
  clear(): void { this.heard = []; this.list = null; this.builder.changed(); }

  // ── The host's ─────────────────────────────────────────────────────────────

  /** The host: a publish from `id` (its own included). Null when kept, else why not. */
  private accept(id: number, spec: BuiltSpec, name: number[]): string | null {
    const now = performance.now();
    const refuse = (why: string, limited = false): string => { if (limited) this.stats.limited++; else this.stats.refused++; this.lastWhy = why; return why; };
    if (now - (this.lastBy.get(id) ?? -1e9) < HOST_GAP_MS) return refuse('Too many publishes. Wait a little.', true);
    while (this.recent.length && now - this.recent[0] > 60000) this.recent.shift();
    if (this.recent.length >= TOWN_PER_MIN) return refuse('The town is busy with races. Try again in a minute.', true);
    const b = this.builder.build(spec);
    if (typeof b === 'string') return refuse(b);
    this.lastBy.set(id, now);
    const key = specKey(spec);
    if (this.slots.some((s) => s && specKey(s.spec) === key)) return null;
    this.recent.push(now);
    // The slot: an empty one, else the oldest.
    let slot = this.slots.findIndex((s) => !s);
    if (slot < 0) { let worst = -1; this.slots.forEach((s, i) => { const a = (this.head - (s as Slot).seq + 255) % 255; if (a > worst) { worst = a; slot = i; } }); }
    const seq = (this.head % 255) + 1;
    this.slots[slot] = { spec, pub: packName(name), seq, best: 0 };
    this.head = seq;
    this.write(slot);
    this.stats.accepted++;
    this.list = null; this.builder.changed();
    return null;
  }

  private write(slot: number): void {
    const k = slot >> 1, h = slot & 1, s = this.slots[slot], v = this.raw[k].slice();
    const cells = s ? [packBuiltHead(s.spec, s.pub, s.seq), s.best, ...packBuiltCells(s.spec.cells)] : new Array<number>(8).fill(0);
    for (let i = 0; i < 8; i++) v[h * 8 + i] = cells[i];
    this.raw[k] = v;
    if (this.conn.send(encodeMsg({ t: 'fact', k: BUILT_FACT_PREFIX + k, v }))) this.stats.written++;
  }

  /** The host (net/race.ts): a racer has finished a built race. A better time becomes the town's best. */
  finished(id: number, route: number, ms: number, laps: number): void {
    const slot = route - BUILT_ROUTE0, e = this.slots[slot];
    if (!this.host || !e || e.spec.laps !== laps || !(ms > 0)) return;
    const def = this.game.todo.racing.def(route);
    if (!def || ms < def.par * 1000 * FASTEST) return;
    const name = id === this.conn.id ? [...myName()] : this.remotes.get(id)?.name.slice();
    if (!name) return;
    const tenths = Math.round(ms / 100);
    if (e.best >= 262144 && tenths >= Math.floor(e.best / 262144)) return;
    e.best = packName(name) + 262144 * tenths;
    this.stats.bests++;
    this.write(slot);
    this.list = null; this.builder.changed();
  }

  info(): Record<string, unknown> {
    return { ...this.stats, head: this.head, why: this.lastWhy, slots: this.slots.map((s) => (s ? { name: s.spec.name, laps: s.spec.laps, pins: s.spec.cells.length / 2, best: Math.floor(s.best / 262144) } : null)), heard: this.heard.length };
  }
}
