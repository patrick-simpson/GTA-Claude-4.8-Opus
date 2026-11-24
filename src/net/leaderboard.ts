// Fun queue item 15: the town leaderboard, the wire (the board itself is game/leaderboard.ts).
//
// THE BOARD is durable town facts written by the HOST only (the service drops anybody else's), so a late joiner gets
// it in the welcome and it outlives everybody leaving: BOARD_FACT_PREFIX + n for n = 0..3, each holding three
// categories (game/leaderboard.ts CATEGORIES, in order) of five entries, best first, 15 numbers. An entry is one number:
// name * 2^30 + value, where name = first + 64 * second + 4096 * (third + 1) (the made-up name's indexes, net/names.ts)
// and value is a whole number in the category's units (below 2^30); 0 is an empty place. Four keys in all, well
// inside the service's FACT_MAX_KEYS. Race times are not kept here: the race records (net/race.ts, `race.<n>`) are read.
//
// AN OFFER is a ToHost frame (8 bytes): 0 Frame.ToHost  1 id  2 BOARD_TOHOST_KIND  3 category u8  4 value u32 (LE).
// A browser offers its own best when it would make the town's top five; the host checks the category, that the value
// is whole, positive and under the category's ceiling, takes the name from who sent it (nobody can file under another
// name), keeps one place per name, and writes the category's fact when its five change. The host's own offers go
// straight in. Sent: nothing while nothing changes; at most one offer per category per change of the player's best.
//
// OLDER PAGES: a host of an older page hands the unknown ToHost kind to its car code, which ignores it, so nothing is
// written and the board simply stays as it was; an older guest never reads the board facts. The service passes the
// frames and facts unread: NO service change (Worker or mini PC), still the same protocol version.
//
// Wiring: no line in net/index.ts. The board (game/leaderboard.ts) builds this with the Net's connection and players
// and chains itself onto the connection's welcome, message and frame callbacks, after the Net's own.

import type { Game } from '../core/game';
import type { Connection } from './conn';
import type { Remote } from './remote';
import { Frame, encodeMsg, type FactValue, type ServerMsg, type WelcomeMsg } from './protocol';
import { myName, nameText } from './names';
import { CATEGORIES, type BoardLink, type BoardRow, type Leaderboard } from '../game/leaderboard';

export const BOARD_FACT_PREFIX = 'board.';
/** Not in protocol.ts's ToHostKind (kept clear of it: those count up from 1). */
export const BOARD_TOHOST_KIND = 200;
const PER_FACT = 3, PLACES = 5;
/** (A function: this module and game/leaderboard.ts import each other.) */
const facts = (): number => Math.ceil(CATEGORIES.length / PER_FACT);
const V = 2 ** 30;

interface Entry { name: number[]; v: number }

export function packName(n: readonly number[]): number { return (n[0] & 63) + 64 * (n[1] & 63) + 4096 * ((n.length > 2 && n[2] >= 0 ? n[2] : -1) + 1); }
export function unpackName(p: number): number[] {
  const a = p % 64, b = Math.floor(p / 64) % 64, c = Math.floor(p / 4096) - 1;
  return c >= 0 ? [a, b, c] : [a, b];
}

export class TownBoard implements BoardLink {
  readonly stats = { offersSent: 0, offersGot: 0, refused: 0, written: 0, factsGot: 0 };
  private readonly tops: Entry[][] = CATEGORIES.map(() => []);
  private welcomed = false;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly board: Leaderboard) {
    const c = conn, w = c.onWelcome, m = c.onMsg, f = c.onFrame, d = c.onDown;
    c.onWelcome = (x) => { w(x); this.welcome(x); };
    c.onMsg = (x) => { m(x); this.msg(x); };
    c.onFrame = (b) => { if (!this.toHost(b)) f(b); };
    c.onDown = () => { d(); this.down(); };
    board.link = this;
  }

  private get online(): boolean { return this.conn.status === 'online'; }
  private get host(): boolean { return this.online && this.conn.host === this.conn.id; }

  // ── BoardLink ──────────────────────────────────────────────────────────────

  inTown(): boolean { return this.online && this.welcomed; }

  top(cat: number): BoardRow[] {
    const mine = packName(myName());
    return (this.tops[cat] ?? []).map((e) => ({ name: nameText(e.name), v: e.v, me: packName(e.name) === mine }));
  }

  race(route: number): { race: number; raceBy: string; lap: number; lapBy: string } | null { return this.game.todo.racing.link?.record(route) ?? null; }

  offer(cat: number, v: number): void {
    if (!this.inTown()) return;
    if (this.host) { this.take(myName(), cat, v); return; }
    const buf = new ArrayBuffer(8), d = new DataView(buf);
    d.setUint8(0, Frame.ToHost); d.setUint8(1, this.conn.id & 0xff); d.setUint8(2, BOARD_TOHOST_KIND);
    d.setUint8(3, cat); d.setUint32(4, Math.round(v), true);
    if (this.conn.send(buf)) this.stats.offersSent++;
  }

  // ── In ─────────────────────────────────────────────────────────────────────

  private welcome(m: WelcomeMsg): void {
    for (const t of this.tops) t.length = 0;
    for (const k of Object.keys(m.facts)) this.fact(k, m.facts[k]);
    this.welcomed = true;
    this.board.changed();
  }

  private msg(m: ServerMsg): void {
    if (m.t !== 'fact') return;
    if (this.fact(m.k, m.v)) { this.stats.factsGot++; this.board.changed(); }
  }

  private down(): void {
    this.welcomed = false;
    for (const t of this.tops) t.length = 0;
    this.board.changed();
  }

  /** True: the fact was the board's. (The race records are read from net/race.ts when the board is drawn.) */
  private fact(k: string, v: FactValue): boolean {
    if (!k.startsWith(BOARD_FACT_PREFIX) || !Array.isArray(v)) return false;
    const n = Number(k.slice(BOARD_FACT_PREFIX.length));
    if (!Number.isInteger(n) || n < 0 || n >= facts()) return false;
    for (let j = 0; j < PER_FACT; j++) {
      const cat = n * PER_FACT + j;
      if (cat >= CATEGORIES.length) break;
      const list: Entry[] = [];
      for (let i = 0; i < PLACES; i++) {
        const x = Number(v[j * PLACES + i]) || 0;
        if (!(x > 0)) continue;
        const val = x % V, name = Math.floor(x / V);
        if (val > 0) list.push({ name: unpackName(name), v: val });
      }
      list.sort((a, b) => b.v - a.v);
      this.tops[cat] = list;
    }
    return true;
  }

  /** A ToHost frame: true when it was an offer (whether or not it was taken). */
  private toHost(buf: ArrayBuffer): boolean {
    if (buf.byteLength !== 8) return false;
    const d = new DataView(buf);
    if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== BOARD_TOHOST_KIND) return false;
    const id = d.getUint8(1), r = this.remotes.get(id);
    if (!this.host || !r) return true;
    this.stats.offersGot++;
    this.take(r.name.slice(), d.getUint8(3), d.getUint32(4, true));
    return true;
  }

  /** The host: somebody's best in a category. Believable and good enough: it goes into the town's five. */
  private take(name: number[], cat: number, v: number): void {
    const c = CATEGORIES[cat];
    if (!c || !Number.isInteger(v) || v <= 0 || v > c.max || v >= V || name.length < 2) { this.stats.refused++; return; }
    const who = packName(name), list = this.tops[cat].slice(), at = list.findIndex((e) => packName(e.name) === who);
    if (at >= 0) { if (list[at].v >= v) return; list.splice(at, 1); }
    list.push({ name: unpackName(who), v });
    list.sort((a, b) => b.v - a.v);
    if (list.length > PLACES) list.length = PLACES;
    if (!list.some((e) => packName(e.name) === who)) return;
    this.tops[cat] = list;
    this.write(Math.floor(cat / PER_FACT));
    this.board.changed();
  }

  private write(n: number): void {
    const v: number[] = [];
    for (let j = 0; j < PER_FACT; j++) {
      const list = this.tops[n * PER_FACT + j] ?? [];
      for (let i = 0; i < PLACES; i++) { const e = list[i]; v.push(e ? packName(e.name) * V + e.v : 0); }
    }
    if (this.conn.send(encodeMsg({ t: 'fact', k: BOARD_FACT_PREFIX + n, v }))) this.stats.written++;
  }

  info(): Record<string, unknown> {
    return { ...this.stats, inTown: this.inTown(), host: this.host, tops: this.tops.map((t, i) => [CATEGORIES[i].key, ...t.map((e) => `${nameText(e.name)}=${e.v}`)]) };
  }
}

