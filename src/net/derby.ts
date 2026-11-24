// Fun queue item 13: the demolition derby at Flounder Field, the wire (the derby itself is game/derby.ts).
//
// Event frames (protocol.ts, PlayerEvent.Derby), relayed unread by the service, on main and on the backup alike, as
// races and Hot Pursuit are: a call, a join, the go, the caller's AI cars (poses and dents), each player's own car
// (health, out, hits), the caller's end (the order), a done from each player at the podium, a call off. Nothing is
// sent while nobody plays.
// Records are durable town facts written by the HOST only (the service drops anybody else's): the host hears every Done
// frame, its own player's too, and writes DERBY_FACT_WINS (most derby wins) or DERBY_FACT_HITS (most hits in one derby)
// when it beats the one on file. No service change, still protocol v5.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { FactValue } from './protocol';
import { DERBY_FACT_HITS, DERBY_FACT_WINS, DerbyKind, decodeDerby, encodeDerby, encodeMsg, type DerbyMsg } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { Derby, DerbyLink, DerbyRecord, DerbyWire } from '../game/derby';

interface Rec { n: number; by: number[] }

export class TownDerby implements DerbyLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, written: 0 };
  private wins: Rec | null = null;
  private hits: Rec | null = null;
  private readonly heardDone = new Set<string>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.derby.link = this;
  }

  private get derby(): Derby { return this.game.todo.derby; }
  private get online(): boolean { return this.conn.status === 'online'; }
  private get host(): boolean { return this.online && this.conn.host === this.conn.id; }

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
  vehicleOf(id: number): Vehicle | null { return this.remotes.get(id)?.vehicle ?? null; }
  send(m: DerbyWire): void {
    if (!this.online) return;
    const msg: DerbyMsg = { id: this.conn.id, ...m };
    if (this.remotes.size) {
      const buf = encodeDerby(msg);
      if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
    }
    if (m.kind === DerbyKind.Done) this.heard(this.conn.id, msg);
  }
  record(): DerbyRecord | null {
    if (!this.wins && !this.hits) return null;
    const nm = (r: Rec | null): string => r && r.by.length >= 2 ? nameText(r.by) : 'nobody yet';
    return { wins: this.wins?.n ?? 0, winsBy: nm(this.wins), hits: this.hits?.n ?? 0, hitsBy: nm(this.hits) };
  }

  event(buf: ArrayBuffer): void {
    const m = decodeDerby(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.derby.got(m.id, m);
    if (m.kind === DerbyKind.Done) this.heard(m.id, m);
  }

  welcome(facts: Record<string, FactValue>): void {
    this.wins = this.hits = null;
    for (const k of Object.keys(facts)) this.fact(k, facts[k]);
  }

  fact(k: string, v: FactValue): void {
    if ((k !== DERBY_FACT_WINS && k !== DERBY_FACT_HITS) || !Array.isArray(v) || v.length < 4) return;
    const rec = { n: Number(v[0]) || 0, by: v.slice(1, 4).filter((n) => n >= 0).map((n) => Math.floor(n)) };
    if (k === DERBY_FACT_WINS) this.wins = rec; else this.hits = rec;
  }

  /** The host: a player's derby is over. A better record is written to the town. */
  private heard(id: number, m: DerbyMsg): void {
    if (!this.host) return;
    const key = `${m.caller}.${id}.${m.a}.${m.c}.${m.ms}`;
    if (this.heardDone.has(key)) return;
    this.heardDone.add(key);
    const name = id === this.conn.id ? [...myName()] : this.remotes.get(id)?.name.slice();
    if (!name) return;
    const three = (n: number[]): number[] => [n[0] ?? -1, n[1] ?? -1, n[2] ?? -1];
    const write = (k: string, n: number): void => {
      const v = [n, ...three(name)];
      if (!this.conn.send(encodeMsg({ t: 'fact', k, v }))) return;
      this.stats.written++;
      this.fact(k, v);
    };
    if (m.a > 0 && m.a <= 10000 && m.a > (this.wins?.n ?? 0)) write(DERBY_FACT_WINS, m.a);
    if (m.c > 0 && m.c <= 999 && m.c > (this.hits?.n ?? 0)) write(DERBY_FACT_HITS, m.c);
  }

  refresh(): void { this.derby.announce(); }
  dropped(id: number): void { this.derby.dropped(id); }
  clear(): void { this.derby.offline(); }

  info(): Record<string, unknown> {
    return { ...this.stats, record: this.record() };
  }
}
