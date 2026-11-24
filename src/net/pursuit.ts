// Fun queue item 12: Hot Pursuit, the wire (the round itself is game/pursuit.ts).
//
// Event frames (protocol.ts, PlayerEvent.Pursuit), relayed unread by the service, on main and on the backup alike, as
// races are: a call, a join, the go (the cop, everybody in, the times), the cop's siren, a wanted player's BUSTED bar
// and bust, a done from each player at the end, a call off. Nothing is sent while nobody plays.
// Records are durable town facts written by the HOST only (the service drops anybody else's): the host hears every Done
// frame, its own player's too, and writes PURSUIT_FACT_BUSTS (most busts in a round) or PURSUIT_FACT_ESCAPE (longest time
// on the run as wanted) when a round beats it. No service change, still protocol v5.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { FactValue } from './protocol';
import { PURSUIT_FACT_BUSTS, PURSUIT_FACT_ESCAPE, PursuitKind, decodePursuit, encodeMsg, encodePursuit, type PursuitMsg } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { Pursuit, PursuitLink, PursuitRecord, PursuitWire } from '../game/pursuit';

interface Rec { n: number; by: number[] }

export class TownPursuit implements PursuitLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, written: 0 };
  private busts: Rec | null = null;
  private escape: Rec | null = null;
  /** The round each player's Done was heard for (host): one record write per player per round. */
  private readonly heardDone = new Set<string>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.pursuit.link = this;
  }

  private get pursuit(): Pursuit { return this.game.todo.pursuit; }
  private get online(): boolean { return this.conn.status === 'online'; }
  private get host(): boolean { return this.online && this.conn.host === this.conn.id; }

  // ── PursuitLink ────────────────────────────────────────────────────────────

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
  send(m: PursuitWire): void {
    if (!this.online) return;
    const msg: PursuitMsg = { id: this.conn.id, ...m };
    if (this.remotes.size) {
      const buf = encodePursuit(msg);
      if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
    }
    if (m.kind === PursuitKind.Done) this.heard(this.conn.id, msg);
  }
  record(): PursuitRecord | null {
    if (!this.busts && !this.escape) return null;
    const nm = (r: Rec | null): string => r && r.by.length >= 2 ? nameText(r.by) : 'nobody yet';
    return { busts: this.busts?.n ?? 0, bustsBy: nm(this.busts), escape: this.escape?.n ?? 0, escapeBy: nm(this.escape) };
  }

  // ── In ─────────────────────────────────────────────────────────────────────

  event(buf: ArrayBuffer): void {
    const m = decodePursuit(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.pursuit.got(m.id, m);
    if (m.kind === PursuitKind.Done) this.heard(m.id, m);
  }

  welcome(facts: Record<string, FactValue>): void {
    this.busts = this.escape = null;
    for (const k of Object.keys(facts)) this.fact(k, facts[k]);
  }

  fact(k: string, v: FactValue): void {
    if ((k !== PURSUIT_FACT_BUSTS && k !== PURSUIT_FACT_ESCAPE) || !Array.isArray(v) || v.length < 4) return;
    const rec = { n: Number(v[0]) || 0, by: v.slice(1, 4).filter((n) => n >= 0).map((n) => Math.floor(n)) };
    if (k === PURSUIT_FACT_BUSTS) this.busts = rec; else this.escape = rec;
  }

  /** The host: a player's round is over. A better one is written to the town. */
  private heard(id: number, m: PursuitMsg): void {
    if (!this.host) return;
    const key = `${m.caller}.${id}.${m.a}.${m.b}.${m.ms}`;
    if (this.heardDone.has(key)) return;
    this.heardDone.add(key);
    const name = id === this.conn.id ? [...myName()] : this.remotes.get(id)?.name.slice();
    if (!name) return;
    const three = (n: number[]): number[] => [n[0] ?? -1, n[1] ?? -1, n[2] ?? -1];
    let k = '', n = 0;
    if (m.a === 1 && m.b > 0 && m.b > (this.busts?.n ?? 0)) { k = PURSUIT_FACT_BUSTS; n = m.b; }
    else if (m.a !== 1 && m.ms > 0 && Math.round(m.ms / 1000) > (this.escape?.n ?? 0) && m.ms <= 3600_000) { k = PURSUIT_FACT_ESCAPE; n = Math.round(m.ms / 1000); }
    if (!k) return;
    const v = [n, ...three(name)];
    if (!this.conn.send(encodeMsg({ t: 'fact', k, v }))) return;
    this.stats.written++;
    this.fact(k, v);
  }

  // ── Comings and goings ─────────────────────────────────────────────────────

  refresh(): void { this.pursuit.announce(); }
  dropped(id: number): void { this.pursuit.dropped(id); }
  clear(): void { this.pursuit.offline(); }

  info(): Record<string, unknown> {
    return { ...this.stats, record: this.record(), pursuit: this.pursuit.info() };
  }
}
