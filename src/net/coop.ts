// Fun queue 2, item 23: co-op missions for 2 to 4 players, the wire (the missions themselves are game/coop.ts).
//
// Event frames (protocol.ts, PlayerEvent.Coop = 24), relayed unread by the service, on main and on the backup alike, as
// races, Hot Pursuit and the derby are: a call, a join, the go (the crew), the caller's judgement of the mission (Show),
// the caller's end, a call off. Nothing is sent while nobody plays. Nothing is stored: no town fact key, no record.
// Still protocol v6 and the service untouched.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { decodeCoop, encodeCoop } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { Coop, CoopLink, CoopWire } from '../game/coop';

export class TownCoop implements CoopLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0 };

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.coop.link = this;
  }

  private get coop(): Coop { return this.game.todo.coop; }
  private get online(): boolean { return this.conn.status === 'online'; }

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
  send(m: CoopWire): void {
    if (!this.online || !this.remotes.size) return;
    const buf = encodeCoop({ id: this.conn.id, ...m });
    if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
  }

  event(buf: ArrayBuffer): void {
    const m = decodeCoop(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.coop.got(m.id, m);
  }

  refresh(): void { this.coop.announce(); }
  dropped(id: number): void { this.coop.dropped(id); }
  clear(): void { this.coop.offline(); }

  info(): Record<string, unknown> { return { ...this.stats, coop: this.coop.info() }; }
}
