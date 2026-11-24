// Owed items (Nov 24): the wire for shared fireworks you light yourself (fx/fireworks.ts, key L) and for the loose duck
// being pushed (world/duckLoose.ts). Event frames only (PlayerEvent.Fireworks 19 and Duck 20, protocol.ts), relayed
// unread by the service on main and backup alike: still protocol v5, no service change. Nothing is sent alone in town.
//
// Fireworks: the one who lights it sends the shell (kind, spot, height, colours); every screen flies the same shell
// at the same place. The light-it-yourself volley is not repeated by the receiver (no box is spent, no toast).
// Duck: the HOST owns where the duck has been pushed to. A guest's boat or car that shoves it applies the shove on its
// own screen at once and sends a Push; the host applies the same shove and sends State frames; every guest eases its
// duck onto the host's. A new host simply carries on from what its screen has been showing.

import type { Game } from '../core/game';
import type { Fireworks, ShellType } from '../fx/fireworks';
import type { DuckLoose } from '../world/duckLoose';
import { DuckSub, PlayerEvent, decodeDuck, decodeFirework, encodeDuck, encodeFirework } from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';

/** The shell types in the order the wire numbers them (fx/fireworks.ts TYPES). */
const WIRE_TYPES: ShellType[] = ['peony', 'chrys', 'willow', 'palm', 'crossette', 'ring', 'heart', 'strobe', 'crackle', 'glitter', 'salute'];
/** A player may have this many shells in the air from this wire per second (a box has six). */
const SHELLS_PER_S = 6;

export class TownExtras {
  readonly stats = { fwSent: 0, fwGot: 0, duckStateSent: 0, duckStateGot: 0, duckPushSent: 0, duckPushGot: 0, duckHomeSent: 0, duckHomeGot: 0 };
  private readonly fwRate = new Map<number, { t: number; n: number }>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {}

  private get online(): boolean { return this.conn.status === 'online'; }
  /** Somebody else is in town to tell. */
  private get others(): boolean { return this.online && this.remotes.size > 0; }
  /** This browser is the town's host and somebody is here. */
  get hosting(): boolean { return this.others && this.conn.host === this.conn.id; }
  /** In a shared town and not the host: the host's word on the duck wins. */
  get guest(): boolean { return this.others && this.conn.host !== this.conn.id; }
  get shared(): boolean { return this.others; }

  // ── Fireworks ──────────────────────────────────────────────────────────────

  /** This player has lit a shell (fx/fireworks.ts lightOne). */
  fireworks(type: ShellType, x: number, y: number, z: number, h: number, c1: number, c2: number, scale: number): void {
    if (!this.others) return;
    const ti = WIRE_TYPES.indexOf(type);
    if (ti < 0) return;
    if (this.conn.send(encodeFirework({ type: ti, x, y, z, h, c1, c2, scale }))) this.stats.fwSent++;
  }

  private firework(buf: ArrayBuffer): void {
    const m = decodeFirework(buf);
    if (!m || !this.remotes.has(m.id)) return;
    const now = performance.now(), r = this.fwRate.get(m.id) ?? { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    this.fwRate.set(m.id, r);
    if (++r.n > SHELLS_PER_S) return;
    const fw = (this.game as unknown as { fireworks?: Fireworks }).fireworks;
    const type = WIRE_TYPES[m.type];
    if (!fw || !type) return;
    this.stats.fwGot++;
    fw.launch(type, m.x, m.y, m.z, m.h, m.c1, m.c2, m.scale || 0.6, true);
  }

  // ── The duck ───────────────────────────────────────────────────────────────

  private get duck(): DuckLoose | null { return (this.game as unknown as { duckLoose?: DuckLoose }).duckLoose ?? null; }

  /** The host: where the duck is pushed to (offsets from its path, velocity, spin, heading offset). */
  duckState(seed: number, v: number[]): void {
    if (!this.hosting) return;
    if (this.conn.send(encodeDuck(DuckSub.State, seed, v))) this.stats.duckStateSent++;
  }
  /** A guest: its vehicle has shoved the duck by this much. */
  duckPush(seed: number, v: number[]): void {
    if (!this.guest) return;
    if (this.conn.send(encodeDuck(DuckSub.Push, seed, v))) this.stats.duckPushSent++;
  }
  /** Whoever pushed it into the ring. */
  duckHome(seed: number): void {
    if (!this.others) return;
    if (this.conn.send(encodeDuck(DuckSub.Home, seed))) this.stats.duckHomeSent++;
  }

  private duckEvent(buf: ArrayBuffer): void {
    const m = decodeDuck(buf), duck = this.duck;
    if (!m || !duck || !this.remotes.has(m.id)) return;
    if (m.sub === DuckSub.State) {
      // (Only the host's word counts.)
      if (m.id !== this.conn.host) return;
      this.stats.duckStateGot++;
      duck.netState(m.seed, m.a, m.b, m.c, m.d, m.e, m.f);
    } else if (m.sub === DuckSub.Push) {
      if (this.conn.host !== this.conn.id) return;
      this.stats.duckPushGot++;
      duck.netPush(m.seed, m.a, m.b, m.c, m.d, m.e);
    } else {
      this.stats.duckHomeGot++;
      duck.netHome(m.seed);
    }
  }

  /** An Event frame with one of this file's codes (index.ts). */
  event(buf: ArrayBuffer): void {
    const code = new Uint8Array(buf)[2];
    if (code === PlayerEvent.Fireworks) this.firework(buf); else if (code === PlayerEvent.Duck) this.duckEvent(buf);
  }

  /** Somebody left town. */
  dropped(id: number): void { this.fwRate.delete(id); }

  info(): Record<string, unknown> { return { ...this.stats, shared: this.shared, hosting: this.hosting }; }
}
