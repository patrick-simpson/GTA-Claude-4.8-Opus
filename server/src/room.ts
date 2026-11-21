// The room: everything the message service decides. Seats, presence, relay, host choice, durable
// facts, validation and the rate caps.
//
// NO Cloudflare types and no globals here beyond plain JavaScript: sockets, storage and the clock
// arrive through the three small interfaces below, so the same file serves the Durable Object in
// city.ts today and a Node program (the `ws` package, a JSON file) later, unchanged. It imports the
// protocol and nothing else.
//
// The room starts no timers of its own. Everything timed is checked lazily when a message arrives,
// except a burst of fact writes followed by silence, for which it asks the wrapper to call wake().

import {
  CITY_CAP, Close, FACT_FLUSH_MS, FACT_MAX_KEYS, Frame, HOST_MIN_TENURE_MS, HOST_SLOW_MS, HOST_STALL_MS,
  HOST_TAKEOVER_RATIO, MAX_HOST_FRAME_BYTES, MAX_PLAYER_FRAME_BYTES, MAX_TEXT_CHARS, PERF_CANNOT_HOST_MS,
  PERF_UNKNOWN_MS, PING_TEXT, PONG_TEXT, PROTOCOL_VERSION, RATE_BURST, RATE_PER_SECOND,
  isValidName, parseClientMsg,
} from '../../src/net/protocol.ts';
import type { FactValue, NameIndexes, PlayerEntry, ServerMsg, WelcomeMsg } from '../../src/net/protocol.ts';

/** How often, at most, the host is re-examined. */
const HOST_CHECK_MS = 500;

/** One player's connection, as the room sees it. Both methods must never throw. */
export interface RoomSocket {
  send(data: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
}

/** What the room wants remembered about a seat if the wrapper can lose its memory (hibernation). */
export interface Seat {
  id: number;
  name: NameIndexes;
  /** Reported frame time in ms; 0 = not reported yet. */
  ms: number;
  host: boolean;
}

/** The world outside the room. */
export interface RoomEnv {
  /** Wall clock, ms since 1970. */
  now(): number;
  /** Every stored fact. Called once, the first time facts are needed. */
  loadFacts(): Record<string, FactValue>;
  /** Store these facts (insert or replace). */
  saveFacts(rows: [string, FactValue][]): void;
  /** Call room.wake() at about this time (ms since 1970). One pending call is enough. */
  wakeAt(at: number): void;
  /** A seat changed. A wrapper that never loses its memory may do nothing. */
  saveSeat(sock: RoomSocket, seat: Seat): void;
}

/** "3.17.20" to [3, 17, 20]; null for anything else. */
export function parseNameParam(s: string | null): NameIndexes | null {
  if (!s || s.length > 11 || !/^\d{1,3}(\.\d{1,3}){1,2}$/.test(s)) return null;
  const name = s.split('.').map(Number);
  return isValidName(name) ? name : null;
}

interface Conn extends Seat {
  sock: RoomSocket;
  /** When anything last arrived from this player. */
  seen: number;
  /** Rate limit token bucket. */
  tokens: number;
  tokensAt: number;
}

export class Room {
  private conns = new Map<RoomSocket, Conn>();
  private byId = new Map<number, Conn>();
  private host: Conn | null = null;
  private hostSince: number;
  private lastHostCheck = 0;
  private lastId = 0;

  private facts: Record<string, FactValue> | null = null;
  private dirty = new Set<string>();
  private lastFlush = 0;
  private wakeAsked = false;

  // (Fields, not constructor shorthand: Node can then run this file as it is, by stripping the types.)
  private readonly env: RoomEnv;
  readonly seats: number;

  constructor(env: RoomEnv, seats: number = CITY_CAP) {
    this.env = env;
    this.seats = seats;
    this.hostSince = env.now();
  }

  /** Players seated. */
  get size(): number {
    return this.conns.size;
  }
  get full(): boolean {
    return this.conns.size >= this.seats;
  }

  /** After the wrapper lost its memory: put a still-connected player back in their seat. */
  restore(sock: RoomSocket, seat: Seat): void {
    const now = this.env.now();
    const c: Conn = { ...seat, sock, seen: now, tokens: RATE_BURST, tokensAt: now };
    this.conns.set(sock, c);
    this.byId.set(c.id, c);
    if (c.host) this.host = c;
    if (c.id > this.lastId) this.lastId = c.id;
  }

  // ---- joining ----

  /** Seats the player and sends the welcome. False (and nothing sent) when the town is full or the name is bad. */
  join(sock: RoomSocket, name: NameIndexes): boolean {
    if (this.full || !isValidName(name) || this.conns.has(sock)) return false;
    const now = this.env.now();
    const c: Conn = { id: this.newId(), name, ms: 0, host: false, sock, seen: now, tokens: RATE_BURST, tokensAt: now };
    this.conns.set(sock, c);
    this.byId.set(c.id, c);
    if (!this.host) {
      this.host = c;
      c.host = true;
      this.hostSince = now;
    }
    this.save(c);

    const players: PlayerEntry[] = [];
    for (const p of this.conns.values()) players.push([p.id, ...p.name]);
    const welcome: WelcomeMsg = {
      t: 'welcome', v: PROTOCOL_VERSION, id: c.id, city: 1, host: this.host.id, players, facts: this.loadFacts(), now,
    };
    sock.send(JSON.stringify(welcome));
    this.broadcast({ t: 'join', id: c.id, name }, c);
    return true;
  }

  /** Ids go round 1..255 so an id is not reused the moment its owner leaves. */
  private newId(): number {
    let id = this.lastId;
    do id = (id % 255) + 1; while (this.byId.has(id));
    this.lastId = id;
    return id;
  }

  private save(c: Conn): void {
    this.env.saveSeat(c.sock, { id: c.id, name: c.name, ms: c.ms, host: c.host });
  }

  // ---- messages ----

  message(sock: RoomSocket, message: string | ArrayBuffer): void {
    const c = this.conns.get(sock);
    if (!c) return;
    const now = this.env.now();

    // Rate limit: a token bucket per connection.
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.tokensAt) * RATE_PER_SECOND) / 1000) - 1;
    c.tokensAt = now;
    if (c.tokens < 0) return this.kick(c, Close.TooFast, 'too fast');
    c.seen = now;

    if (typeof message !== 'string') {
      const len = message.byteLength;
      if (len === 0) return this.kick(c, Close.BadMessage, 'empty');
      if (len > MAX_HOST_FRAME_BYTES) return this.kick(c, Close.TooBig, 'too big');
      const u8 = new Uint8Array(message);
      const kind = u8[0];
      if (kind === Frame.State || kind === Frame.Event) {
        if (len > MAX_PLAYER_FRAME_BYTES) return this.kick(c, Close.TooBig, 'too big');
        if (len < 2) return this.kick(c, Close.BadMessage, 'short');
        u8[1] = c.id;
        for (const p of this.conns.values()) if (p !== c) p.sock.send(message);
      } else if (kind === Frame.World) {
        // From someone who is not (or is no longer) the host: dropped, not punished; the job may have just moved.
        if (c === this.host && len >= 2) {
          u8[1] = c.id;
          for (const p of this.conns.values()) if (p !== c) p.sock.send(message);
        }
      } else if (kind === Frame.ToHost) {
        if (len > MAX_PLAYER_FRAME_BYTES) return this.kick(c, Close.TooBig, 'too big');
        if (len < 2) return this.kick(c, Close.BadMessage, 'short');
        u8[1] = c.id;
        if (this.host && this.host !== c) this.host.sock.send(message);
      } else if (kind === Frame.ToPlayer) {
        if (c === this.host && len >= 2) {
          const target = this.byId.get(u8[1]);
          u8[1] = c.id;
          if (target && target !== c) target.sock.send(message);
        }
      } else if (kind === Frame.Keepalive) {
        if (len > 1) return this.kick(c, Close.BadMessage, 'bad keepalive');
      } else {
        return this.kick(c, Close.BadMessage, 'unknown frame');
      }
    } else if (message === PING_TEXT) {
      c.sock.send(PONG_TEXT);
    } else {
      if (message.length > MAX_TEXT_CHARS) return this.kick(c, Close.TooBig, 'too big');
      const m = parseClientMsg(message);
      if (!m) return this.kick(c, Close.BadMessage, 'bad message');
      if (m.t === 'perf') {
        c.ms = m.ms;
        this.save(c);
        this.lastHostCheck = 0; // look at the host now
      } else if (m.t === 'name') {
        c.name = m.name;
        this.save(c);
        this.broadcast({ t: 'name', id: c.id, name: m.name }, c);
      } else if (m.t === 'fact') {
        if (c === this.host) this.writeFact(m.k, m.v, c, now);
      }
    }

    if (now - this.lastHostCheck >= HOST_CHECK_MS) this.checkHost(now);
    if (this.dirty.size > 0 && now - this.lastFlush >= FACT_FLUSH_MS) this.flushFacts(now);
  }

  /** The socket closed or failed. The wrapper has already dealt with the socket itself. */
  leave(sock: RoomSocket): void {
    const c = this.conns.get(sock);
    if (!c) return;
    this.conns.delete(sock);
    this.byId.delete(c.id);
    this.broadcast({ t: 'leave', id: c.id }, null);
    const now = this.env.now();
    if (this.host === c) {
      this.host = null;
      this.checkHost(now);
    }
    if (this.dirty.size > 0) this.flushFacts(now);
  }

  /** The time asked for with wakeAt() has come. */
  wake(): void {
    this.wakeAsked = false;
    if (this.dirty.size > 0) this.flushFacts(this.env.now());
  }

  /** Everybody out: one last message each, then closed. Facts are stored first. */
  closeAll(last: ServerMsg, code: number, reason: string): void {
    if (this.dirty.size > 0) this.flushFacts(this.env.now());
    const text = JSON.stringify(last);
    for (const c of this.conns.values()) {
      c.sock.send(text);
      c.sock.close(code, reason);
    }
    this.conns.clear();
    this.byId.clear();
    this.host = null;
  }

  private kick(c: Conn, code: number, reason: string): void {
    c.sock.close(code, reason);
    this.leave(c.sock);
  }

  private broadcast(m: ServerMsg, except: Conn | null): void {
    const text = JSON.stringify(m);
    for (const p of this.conns.values()) if (p !== except) p.sock.send(text);
  }

  // ---- host choice ----

  /** Frame time used for ranking; players who have not reported rank as PERF_UNKNOWN_MS. */
  private static score(c: Conn): number {
    return c.ms > 0 ? c.ms : PERF_UNKNOWN_MS;
  }

  /** Best candidate other than `except`: lowest frame time, lowest id on a tie. Live players before stalled ones. */
  private best(now: number, except: Conn | null, liveOnly: boolean): Conn | null {
    let pick: Conn | null = null;
    let pickRank = Infinity;
    for (const p of this.conns.values()) {
      if (p === except) continue;
      const stalled = now - p.seen > HOST_STALL_MS;
      if (stalled && liveOnly) continue;
      const rank = Room.score(p) + (stalled ? 1e6 : 0) + p.id * 1e-6;
      if (rank < pickRank) {
        pick = p;
        pickRank = rank;
      }
    }
    return pick;
  }

  private checkHost(now: number): void {
    this.lastHostCheck = now;
    const host = this.host;
    if (!host) {
      const next = this.best(now, null, false);
      if (next) this.setHost(next, now);
      return;
    }
    if (this.conns.size < 2) return;
    // Stalled: nothing from the host for a few seconds. Move the job to a live player at once.
    if (now - host.seen > HOST_STALL_MS) {
      const next = this.best(now, host, true);
      if (next) this.setHost(next, now);
      return;
    }
    // Struggling: slow, and someone who has reported is clearly faster, and the host has had its turn.
    const hostMs = Room.score(host);
    if (hostMs > HOST_SLOW_MS && now - this.hostSince >= HOST_MIN_TENURE_MS) {
      const next = this.best(now, host, true);
      if (next && next.ms > 0 && next.ms < PERF_CANNOT_HOST_MS && next.ms <= hostMs * HOST_TAKEOVER_RATIO) this.setHost(next, now);
    }
  }

  private setHost(next: Conn, now: number): void {
    const old = this.host;
    if (old === next) return;
    if (old) {
      old.host = false;
      if (this.conns.has(old.sock)) this.save(old);
    }
    next.host = true;
    this.save(next);
    this.host = next;
    this.hostSince = now;
    this.broadcast({ t: 'host', id: next.id }, null);
  }

  // ---- durable facts ----

  private loadFacts(): Record<string, FactValue> {
    return (this.facts ??= this.env.loadFacts());
  }

  private writeFact(k: string, v: FactValue, from: Conn, now: number): void {
    const facts = this.loadFacts();
    if (!(k in facts) && Object.keys(facts).length >= FACT_MAX_KEYS) return;
    facts[k] = v;
    this.dirty.add(k);
    this.broadcast({ t: 'fact', k, v }, from);
    // Stored at once when writes are spaced out; a burst is stored at most every FACT_FLUSH_MS
    // (storage writes are rationed). The wake covers a burst followed by silence.
    if (now - this.lastFlush >= FACT_FLUSH_MS) this.flushFacts(now);
    else if (!this.wakeAsked) {
      this.wakeAsked = true;
      this.env.wakeAt(this.lastFlush + FACT_FLUSH_MS);
    }
  }

  private flushFacts(now: number): void {
    const facts = this.loadFacts();
    const rows: [string, FactValue][] = [];
    for (const k of this.dirty) rows.push([k, facts[k]]);
    this.dirty.clear();
    this.lastFlush = now;
    if (rows.length > 0) this.env.saveFacts(rows);
  }
}
