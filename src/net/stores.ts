// Fun queue 2, item 25: player-run shops, the wire (the shops themselves are game/stores.ts).
//
// Event frames (protocol.ts, PlayerEvent.Store = 26), relayed unread by the service on main and on the backup alike, as
// Coop = 24 and Convoy = 25 are: the owner's word (name and shelves), a close, a customer's Buy, the owner's Sold or Deny.
// Nothing is sent while nobody else is in town. Nothing is stored: no town fact key, no record. Still protocol v6, service untouched.

import type { Game } from '../core/game';
import { decodeStore, encodeStore, type StoreMsg } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { myName, nameText } from './names';
import type { Stores, StoreLink } from '../game/stores';

export class TownStores implements StoreLink {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0 };

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    this.store.link = this;
  }

  private get store(): Stores { return this.game.todo.stores; }
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
  send(m: Omit<StoreMsg, 'id'>): void {
    if (!this.online || !this.remotes.size) return;
    const buf = encodeStore({ id: this.conn.id, ...m });
    if (this.conn.send(buf)) { this.stats.sent++; this.stats.bytesSent += buf.byteLength; }
  }

  event(buf: ArrayBuffer): void {
    const m = decodeStore(buf);
    if (!m || !this.online || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    this.store.got(m.id, m);
  }

  refresh(): void { this.store.announce(); }
  dropped(id: number): void { this.store.dropped(id); }
  clear(): void { this.store.offline(); }

  info(): Record<string, unknown> { return { ...this.stats, stores: this.store.info() }; }
}
