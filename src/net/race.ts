// Fun queue item 11: races between players, the wire (the race itself is game/race.ts).
//
// Event frames (protocol.ts, PlayerEvent.Race), relayed unread by the service, on main and on the backup alike: a call
// (who is in so far), a join, the grid with the GO time, one frame per checkpoint passed, a done (time and best lap),
// a call off. Nothing is sent while nobody races. The caller coordinates the start; after GO every racer times and
// reports its own race, so every screen orders the podium by the same numbers.
//
// Records are durable town facts (RACE_FACT_PREFIX + route), written by the HOST only (the service drops anybody
// else's): the host hears every Done frame, its own racer's too, and writes the route's fact when a time beats it.
// The fact names the holder by their name indexes, so a late joiner (the welcome carries every fact) sees who holds it.
// A host page from before races writes no records; everything else still works with it. No service change, still v5.

import type { Game } from '../core/game';
import type { FactValue } from './protocol';
import { BUILT_ROUTE0, RACE_FACT_PREFIX, decodeRace, encodeMsg, encodeRace, type RaceMsg } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { RaceLink, RaceWire, TownRecord } from '../game/race';
import type { Racing } from '../game/race';
import type { TownRaces } from './townRaces';

/** A time faster than this share of par is not believed (a test teleport, a broken page), and not written. */
const FASTEST = 0.3;

interface Rec { lap: number; lapBy: number[]; race: number; raceBy: number[]; laps: number }

export class TownRace implements RaceLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, written: 0 };
  private readonly recs = new Map<number, Rec>();
  private readonly known = new Map<string, string>();
  /** The built races' wire (net/townRaces.ts): routes from BUILT_ROUTE0 are theirs, records and all. */
  custom: TownRaces | null = null;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.racing.link = this;
  }

  private get racing(): Racing { return this.game.todo.racing; }
  private get online(): boolean { return this.conn.status === 'online'; }
  private get host(): boolean { return this.online && this.conn.host === this.conn.id; }

  // ── RaceLink ───────────────────────────────────────────────────────────────

  me(): number { return this.online ? this.conn.id : 0; }
  others(): number[] { return this.online ? [...this.remotes.keys()] : []; }
  nameOf(id: number): string {
    if (id === this.me()) return nameText(myName());
    const r = this.remotes.get(id);
    return r ? r.text : `Player ${id}`;
  }
  posOf(id: number): { x: number; z: number } | null {
    const r = this.remotes.get(id);
    if (!r) return null;
    const v = r.vehicle, b = r.body;
    return v ? { x: v.x, z: v.z } : b ? { x: b.x, z: b.z } : null;
  }
  send(m: RaceWire): void {
    if (!this.online) return;
    const msg: RaceMsg = { id: this.conn.id, ...m };
    if (this.remotes.size) {
      const buf = encodeRace(msg);
      if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
    }
    if (m.kind === 5) this.heard(this.conn.id, msg);
  }
  record(route: number): TownRecord | null {
    if (route >= BUILT_ROUTE0) return this.custom?.record(route) ?? null;
    const r = this.recs.get(route);
    if (!r) return null;
    const nm = (n: number[]): string => n.length >= 2 ? nameText(n) : 'somebody';
    return { lap: r.lap, lapBy: nm(r.lapBy), race: r.race, raceBy: nm(r.raceBy), laps: r.laps };
  }

  // ── In ─────────────────────────────────────────────────────────────────────

  /** An Event frame with the Race code (index.ts). */
  event(buf: ArrayBuffer): void {
    const m = decodeRace(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.racing.got(m.id, m);
    if (m.kind === 5) this.heard(m.id, m);
  }

  /** The welcome's facts (index.ts). */
  welcome(facts: Record<string, FactValue>): void {
    this.recs.clear(); this.known.clear();
    for (const k of Object.keys(facts)) this.fact(k, facts[k]);
  }

  /** A fact (index.ts): only the race keys are ours. */
  fact(k: string, v: FactValue): void {
    if (!k.startsWith(RACE_FACT_PREFIX) || !Array.isArray(v) || v.length < 8) return;
    const route = Number(k.slice(RACE_FACT_PREFIX.length));
    if (!Number.isInteger(route)) return;
    this.known.set(k, JSON.stringify(v));
    const nm = (a: number[]): number[] => a.filter((n) => n >= 0).map((n) => Math.floor(n));
    this.recs.set(route, { lap: v[0] * 100, lapBy: nm(v.slice(1, 4)), race: v[4] * 100, raceBy: nm(v.slice(5, 8)), laps: Number(v[8]) || 1 });
  }

  /** The host: a racer has finished. A better time is written to the town. */
  private heard(id: number, m: RaceMsg): void {
    if (!this.host || m.how !== 1 || !(m.ms > 0)) return;
    if (m.route >= BUILT_ROUTE0) { this.custom?.finished(id, m.route, m.ms, m.laps); return; }
    const r = this.game.todo.jobs.races.find((x) => x.idx === m.route);
    if (!r || m.laps !== r.laps || m.ms < r.par * 1000 * FASTEST) return;
    const name = id === this.conn.id ? [...myName()] : this.remotes.get(id)?.name.slice();
    if (!name) return;
    const old = this.recs.get(m.route), lap = m.lap > 0 ? m.lap : m.ms;
    const rec: Rec = old ? { ...old } : { lap: Infinity, lapBy: [], race: Infinity, raceBy: [], laps: r.laps };
    let better = false;
    if (m.ms < rec.race) { rec.race = m.ms; rec.raceBy = name; better = true; }
    if (lap < rec.lap) { rec.lap = lap; rec.lapBy = name; better = true; }
    if (!better) return;
    const three = (n: number[]): number[] => [n[0] ?? -1, n[1] ?? -1, n[2] ?? -1];
    const v = [Math.round(rec.lap / 100), ...three(rec.lapBy), Math.round(rec.race / 100), ...three(rec.raceBy), r.laps];
    const k = RACE_FACT_PREFIX + m.route, text = encodeMsg({ t: 'fact', k, v });
    if (!this.conn.send(text)) return;
    this.stats.written++;
    this.fact(k, v);
  }

  // ── Comings and goings ─────────────────────────────────────────────────────

  refresh(): void { this.racing.announce(); }
  dropped(id: number): void { this.racing.dropped(id); }
  clear(): void { this.racing.offline(); }

  info(): Record<string, unknown> {
    return { ...this.stats, records: [...this.recs.entries()].map(([k, r]) => ({ route: k, ...this.record(k) })), racing: this.racing.info() };
  }
}
