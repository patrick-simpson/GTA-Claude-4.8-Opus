// Fun queue 2, item 24: convoys, the wire (the convoy itself is game/convoy.ts).
//
// Event frames (protocol.ts, PlayerEvent.Convoy = 25), relayed unread by the service on main and on the backup alike, as
// Coop = 24 is: the leader's word (destination and members), a join, a leave, a hand-over, the arrival, the end. Nothing
// is sent while nobody else is in town. Nothing is stored: no town fact key, no record. Still protocol v6, service untouched.

import type { Game } from '../core/game';
import { decodeConvoy, encodeConvoy } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { Convoy, ConvoyLink, ConvoyWire } from '../game/convoy';

export class TownConvoy implements ConvoyLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0 };

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.convoy.link = this;
  }

  private get convoy(): Convoy { return this.game.todo.convoy; }
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
  send(m: ConvoyWire): void {
    if (!this.online || !this.remotes.size) return;
    const buf = encodeConvoy({ id: this.conn.id, ...m });
    if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
  }

  event(buf: ArrayBuffer): void {
    const m = decodeConvoy(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.convoy.got(m.id, m);
  }

  refresh(): void { this.convoy.announce(); }
  dropped(id: number): void { this.convoy.dropped(id); }
  clear(): void { this.convoy.offline(); }

  info(): Record<string, unknown> { return { ...this.stats, convoy: this.convoy.info() }; }
}
