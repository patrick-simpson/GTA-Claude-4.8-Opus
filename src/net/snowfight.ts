// Fun queue 2, item 27: team snowball fights, the wire (the fight itself is game/snowfight.ts).
//
// Event frames (protocol.ts, PlayerEvent.Snow = 27), relayed unread by the service on main and on the backup alike, as
// Coop = 24, Convoy = 25 and Store = 26 are: the host's roster and bots, each throw, each hit the host judged, the end.
// Nothing is sent while nobody else is in town. Nothing is stored: no town fact key. Still protocol v6, service untouched.

import type { Game } from '../core/game';
import { decodeSnow, encodeSnow, type SnowMsg } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { SnowFight, SnowLink } from '../game/snowfight';

export class TownSnow implements SnowLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0 };

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.fight.link = this;
  }

  private get fight(): SnowFight { return this.game.todo.snow; }
  private get online(): boolean { return this.conn.status === 'online'; }

  me(): number { return this.online ? this.conn.id : 0; }
  others(): number[] { return this.online ? [...this.remotes.keys()] : []; }
  nameOf(id: number): string {
    if (id === this.me()) return nameText(myName());
    const r = this.remotes.get(id);
    return r ? r.text : `Player ${id}`;
  }
  posOf(id: number): { x: number; y: number; z: number } | null {
    const r = this.remotes.get(id);
    if (!r || !r.seen) return null;
    return { x: r.x, y: r.y, z: r.z };
  }
  /** On foot (a driver cannot be hit by a snowball: the host leaves them out). */
  onFoot(id: number): boolean { const r = this.remotes.get(id); return !!r && !r.kind; }
  send(m: SnowMsg): void {
    if (!this.online || !this.remotes.size) return;
    const buf = encodeSnow(m);
    if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
  }

  event(buf: ArrayBuffer): void {
    const m = decodeSnow(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.fight.got(m.id, m);
  }

  refresh(): void { this.fight.announce(); }
  dropped(id: number): void { this.fight.dropped(id); }
  clear(): void { this.fight.offline(); }

  info(): Record<string, unknown> { return { ...this.stats, snow: this.fight.info() }; }
}
