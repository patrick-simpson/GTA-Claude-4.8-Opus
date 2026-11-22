// Multiplayer, stage 3, step 4: the same broken street furniture for everyone.
//
// Only in a town on the MAIN service. Alone and on the backup nothing here is sent or believed: what a browser knocks
// over is its own business, as before.
//
// What breaks is what a car knocks over (ent/vehicle.ts): hydrants, bins, cones, posts, mailboxes and news boxes at
// any real speed; benches, lamp posts and traffic signals when hit hard enough. Nothing else in the game breaks, and
// nothing that is down ever stands up again.
//
// Who decides. Nobody has to. A car is simulated by exactly one browser (a player's own by theirs, the town's traffic
// by the host), and that browser is the only one on which the car can knock a thing over: on every other screen the
// same car is placed by the network and passes through the furniture untouched. So the browser that saw it fall says
// so, once (protocol.ts, the Prop event), and everybody else knocks theirs over, with the same noise and debris if
// they are near enough to notice. Two browsers cannot disagree, because "down" is the only thing either can say and
// saying it twice changes nothing. An authority would only add a round trip between a car hitting a bin and the bin
// going over on its own driver's screen.
//
// Who remembers. The HOST is the town's memory, as it is for the parked cars: when somebody arrives it sends
// everything that is down, in one World frame of 4 bytes a prop, and those go over quietly on the newcomer's screen.
// Every browser keeps the same list as it hears the events, so whoever is made host next can do the same. The list
// starts from what was already down on the first host's own streets (as with the parked cars, its streets become the
// town's); what a guest knocked over while alone stays down on its own screen and is nobody else's.
//
// A prop is named by where it stands (propKey): the map is the same in every browser, and a browser that never built
// that one (a cheaper setting) simply has nothing to knock over.

import type { Game } from '../core/game';
import type { Prop } from '../world/collide';
import {
  PROPS_HEADER_BYTES, PROPS_MAX, PROP_BYTES, PROP_EVENT_MAX, PROP_MS,
  decodeProp, decodeProps, encodeProp, encodeProps, frameSender, propKey, propKeyX, propKeyZ,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { SharedTraffic } from './shared';

/** A guest's car knocks things over where the guest is: a prop further than this from where they are shown is not theirs to report. Meters. */
const REACH = 90;
/** A place on the wire is rounded to 5 cm; a browser whose furniture stands a hair off still finds its own within this. Meters. */
const NEAR = 0.3;

export class TownProps {
  readonly stats = {
    /** Events sent and their bytes; the props in them. */
    sent: 0, bytesSent: 0, propsSent: 0,
    /** Events heard; props knocked over here because of them; props named that are not on this browser's map. */
    got: 0, felled: 0, unknown: 0, refused: 0,
    /** Host: whole lists sent to newcomers, and their bytes. Guest: lists heard, and the props that went down quietly for them. */
    listsSent: 0, listBytesSent: 0, listsGot: 0, listFelled: 0,
  };

  /** Every prop that is down on this browser, oldest first, by its place. */
  private readonly down: number[] = [];
  private readonly isDown = new Set<number>();
  /** Knocked over by this browser's own cars since the last event, and the way the first of them was hit. */
  private readonly fresh: number[] = [];
  private fvx = 0;
  private fvz = 0;
  private sentAt = 0;
  /** A break being made here because another browser said so: not to be told back. */
  private applying = false;
  /** Somebody has arrived: the host owes the town's list. */
  private force = false;
  private readonly out = new Uint8Array(PROPS_HEADER_BYTES + PROPS_MAX * PROP_BYTES);
  private found: Prop | null = null;
  private foundD = 0;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic) {
    game.on('propBreak', (e) => this.broke(e.prop, e.vx, e.vz));
  }

  /** In a town whose props are shared, with somebody to tell. */
  private get on(): boolean { return this.shared.town && this.conn.status === 'online' && this.remotes.size > 0; }

  /** Somebody has just arrived (index.ts). */
  refresh(): void { this.force = true; }

  private note(k: number): void {
    if (this.isDown.has(k)) return;
    this.isDown.add(k);
    this.down.push(k);
  }

  /** Something has gone over on this browser, whoever's doing it was. */
  private broke(p: Prop, vx: number, vz: number): void {
    const k = propKey(p.x, p.z);
    this.note(k);
    if (this.applying || !this.on) return;
    if (this.fresh.length === 0) { this.fvx = vx; this.fvz = vz; }
    this.fresh.push(k);
  }

  /** The prop of this browser's that stands at that place, if it is still standing and is one that breaks. */
  private at(k: number): Prop | null {
    const x = propKeyX(k), z = propKeyZ(k);
    this.found = null; this.foundD = NEAR;
    this.game.col.forProps(x, z, NEAR, (p) => {
      if (!p.breakable && !p.hard) return;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < this.foundD) { this.foundD = d; this.found = p; }
    });
    return this.found;
  }

  /** Knock over what stands at that place. Returns whether anything did. */
  private fell(k: number, vx: number, vz: number, quiet: boolean): boolean {
    if (this.isDown.has(k)) return false;
    const p = this.at(k);
    this.note(k);
    if (!p) { this.stats.unknown++; return false; }
    this.note(propKey(p.x, p.z));
    this.applying = true;
    try { this.game.col.breakProp(p, vx, vz, quiet); } finally { this.applying = false; }
    return true;
  }

  /** An Event frame: another browser's car has knocked things over. */
  event(buf: ArrayBuffer): void {
    const m = decodeProp(buf);
    if (!m || !this.shared.town) return;
    const r = this.remotes.get(m.id), st = this.stats;
    if (!r) return;
    st.got++;
    const host = m.id === this.conn.host;
    for (const k of m.keys) {
      // The host's traffic may be anywhere in town. A guest's car is where the guest is.
      if (!host && (!r.seen || Math.hypot(propKeyX(k) - r.x, propKeyZ(k) - r.z) > REACH)) { st.refused++; continue; }
      if (this.fell(k, m.vx, m.vz, false)) st.felled++;
    }
  }

  /** A World frame from the host: everything that is down in town, for somebody who was not there. */
  world(buf: ArrayBuffer): void {
    if (this.shared.mode !== 'guest' || frameSender(buf) !== this.conn.host) return;
    const keys = decodeProps(buf);
    if (!keys) return;
    this.stats.listsGot++;
    for (const k of keys) if (this.fell(k, 0, 0, true)) this.stats.listFelled++;
  }

  update(now: number): void {
    const fresh = this.fresh, st = this.stats;
    if (!this.on) { fresh.length = 0; return; }
    if (fresh.length > 0 && now - this.sentAt >= PROP_MS - 4) {
      const n = Math.min(fresh.length, PROP_EVENT_MAX);
      const buf = encodeProp(fresh, n, this.fvx, this.fvz);
      // (Sent or not, they are not kept: a prop nobody could be told of is in the list the next newcomer gets.)
      if (this.conn.send(buf)) { st.sent++; st.bytesSent += buf.byteLength; st.propsSent += n; }
      fresh.splice(0, n);
      this.sentAt = now;
    }
    if (this.force && this.shared.mode === 'host') {
      this.force = false;
      const down = this.down, n = Math.min(down.length, PROPS_MAX);
      // Nothing down in town: nothing to say.
      if (n === 0) return;
      const from = down.length - n, out = this.out;
      const len = encodeProps(from > 0 ? down.slice(from) : down, n, out);
      if (this.conn.send(out.subarray(0, len))) { st.listsSent++; st.listBytesSent += len; }
      else this.force = true;
    }
  }

  /** For the tests (window.__game.net().props). */
  info(): Record<string, unknown> {
    return { on: this.on, down: this.down.length, owed: this.force, ...this.stats };
  }

  /** For the tests: is the prop at (x, z) down here? Null when this browser has none there. */
  isDownAt(x: number, z: number): boolean | null {
    const k = propKey(x, z);
    if (this.isDown.has(k)) return true;
    return this.at(k) ? false : null;
  }
}
