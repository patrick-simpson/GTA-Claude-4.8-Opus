// One city: a Durable Object that relays messages between up to CITY_CAP players, knows who is
// present, chooses the host, and keeps the city's durable facts.
//
// It uses the WebSocket Hibernation API, so:
//  - no setTimeout or setInterval anywhere (they would block hibernation); everything timed is
//    checked lazily when a message arrives, except the deferred fact flush, which uses an alarm;
//  - anything that must survive hibernation lives in each socket's attachment (id, name, frame
//    time, host flag) or in SQLite (facts). Everything else is rebuilt in the constructor.

import { DurableObject } from 'cloudflare:workers';
import {
  CITY_CAP, Close, FACT_FLUSH_MS, FACT_MAX_KEYS, Frame, HOST_MIN_TENURE_MS, HOST_SLOW_MS, HOST_STALL_MS,
  HOST_TAKEOVER_RATIO, MAX_HOST_FRAME_BYTES, MAX_PLAYER_FRAME_BYTES, MAX_TEXT_CHARS, PERF_CANNOT_HOST_MS,
  PERF_UNKNOWN_MS, PING_TEXT, PONG_TEXT, PROTOCOL_VERSION, RATE_BURST, RATE_PER_SECOND,
  isValidName, parseClientMsg,
} from '../../src/net/protocol';
import type { FactValue, NameIndexes, PlayerEntry, ServerMsg, WelcomeMsg } from '../../src/net/protocol';

/** What the city answers the Worker when it has no room. Never seen by a browser. */
export const CITY_FULL_STATUS = 409;
/** How often, at most, the host is re-examined. */
const HOST_CHECK_MS = 500;

/** "3.17.20" to [3, 17, 20]; null for anything else. */
export function parseNameParam(s: string | null): NameIndexes | null {
  if (!s || s.length > 11 || !/^\d{1,3}(\.\d{1,3}){1,2}$/.test(s)) return null;
  const name = s.split('.').map(Number);
  return isValidName(name) ? name : null;
}

/** Survives hibernation (stored with the socket). */
interface Attachment {
  id: number;
  name: NameIndexes;
  /** Reported frame time in ms; 0 = not reported yet. */
  ms: number;
  host: boolean;
}

/** In memory only. */
interface Conn extends Attachment {
  ws: WebSocket;
  /** When anything last arrived from this player. */
  seen: number;
  /** Rate limit token bucket. */
  tokens: number;
  tokensAt: number;
}

export class City extends DurableObject<object> {
  private conns = new Map<WebSocket, Conn>();
  private byId = new Map<number, Conn>();
  private host: Conn | null = null;
  private hostSince = 0;
  private lastHostCheck = 0;
  private lastId = 0;

  private facts: Record<string, FactValue> | null = null;
  private dirty = new Set<string>();
  private lastFlush = 0;
  private alarmSet = false;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    // A lone player can check the line without waking (or billing) the city.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    // Waking from hibernation: rebuild the in-memory picture from the sockets still attached.
    const now = Date.now();
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      const c: Conn = { ...a, ws, seen: now, tokens: RATE_BURST, tokensAt: now };
      this.conns.set(ws, c);
      this.byId.set(c.id, c);
      if (c.host) this.host = c;
      if (c.id > this.lastId) this.lastId = c.id;
    }
    this.hostSince = now;
  }

  // ---- joining ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = parseNameParam(url.searchParams.get('name'));
    if (request.headers.get('Upgrade') !== 'websocket' || !name) return new Response(null, { status: 400 });
    if (this.conns.size >= CITY_CAP) return new Response(null, { status: CITY_FULL_STATUS });

    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);

    const now = Date.now();
    const c: Conn = { id: this.newId(), name, ms: 0, host: false, ws, seen: now, tokens: RATE_BURST, tokensAt: now };
    this.conns.set(ws, c);
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
      t: 'welcome', v: PROTOCOL_VERSION, id: c.id, city: Number(url.searchParams.get('city')) || 1,
      host: this.host.id, players, facts: this.loadFacts(), now,
    };
    this.send(c, JSON.stringify(welcome));
    this.broadcast({ t: 'join', id: c.id, name }, c);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Ids go round 1..255 so an id is not reused the moment its owner leaves. */
  private newId(): number {
    let id = this.lastId;
    do id = (id % 255) + 1; while (this.byId.has(id));
    this.lastId = id;
    return id;
  }

  private save(c: Conn): void {
    const a: Attachment = { id: c.id, name: c.name, ms: c.ms, host: c.host };
    c.ws.serializeAttachment(a);
  }

  // ---- messages ----

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const c = this.conns.get(ws);
    if (!c) return;
    const now = Date.now();

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
        for (const p of this.conns.values()) if (p !== c) this.send(p, message);
      } else if (kind === Frame.World) {
        // From someone who is not (or is no longer) the host: dropped, not punished; the job may have just moved.
        if (c === this.host && len >= 2) {
          u8[1] = c.id;
          for (const p of this.conns.values()) if (p !== c) this.send(p, message);
        }
      } else if (kind === Frame.ToHost) {
        if (len > MAX_PLAYER_FRAME_BYTES) return this.kick(c, Close.TooBig, 'too big');
        if (len < 2) return this.kick(c, Close.BadMessage, 'short');
        u8[1] = c.id;
        if (this.host && this.host !== c) this.send(this.host, message);
      } else if (kind === Frame.ToPlayer) {
        if (c === this.host && len >= 2) {
          const target = this.byId.get(u8[1]);
          u8[1] = c.id;
          if (target && target !== c) this.send(target, message);
        }
      } else if (kind === Frame.Keepalive) {
        if (len > 1) return this.kick(c, Close.BadMessage, 'bad keepalive');
      } else {
        return this.kick(c, Close.BadMessage, 'unknown frame');
      }
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

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      // Reply to the Close frame (1005 and 1006 are not codes that may be sent).
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch { /* already closed */ }
    this.drop(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws);
  }

  private kick(c: Conn, code: number, reason: string): void {
    try {
      c.ws.close(code, reason);
    } catch { /* already closed */ }
    this.drop(c.ws);
  }

  private drop(ws: WebSocket): void {
    const c = this.conns.get(ws);
    if (!c) return;
    this.conns.delete(ws);
    this.byId.delete(c.id);
    this.broadcast({ t: 'leave', id: c.id }, null);
    const now = Date.now();
    if (this.host === c) {
      this.host = null;
      this.checkHost(now);
    }
    if (this.dirty.size > 0) this.flushFacts(now);
  }

  private send(c: Conn, data: string | ArrayBuffer): void {
    try {
      c.ws.send(data);
    } catch { /* the socket is closing; its close event will tidy up */ }
  }

  private broadcast(m: ServerMsg, except: Conn | null): void {
    const text = JSON.stringify(m);
    for (const p of this.conns.values()) if (p !== except) this.send(p, text);
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
      const rank = City.score(p) + (stalled ? 1e6 : 0) + p.id * 1e-6;
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
    const hostMs = City.score(host);
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
      if (this.conns.has(old.ws)) this.save(old);
    }
    next.host = true;
    this.save(next);
    this.host = next;
    this.hostSince = now;
    this.broadcast({ t: 'host', id: next.id }, null);
  }

  // ---- durable facts ----

  private loadFacts(): Record<string, FactValue> {
    if (this.facts) return this.facts;
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS facts (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const facts: Record<string, FactValue> = {};
    for (const row of sql.exec('SELECT k, v FROM facts')) {
      try {
        facts[String(row.k)] = JSON.parse(String(row.v)) as FactValue;
      } catch { /* skip a damaged row */ }
    }
    this.facts = facts;
    return facts;
  }

  private writeFact(k: string, v: FactValue, from: Conn, now: number): void {
    const facts = this.loadFacts();
    if (!(k in facts) && Object.keys(facts).length >= FACT_MAX_KEYS) return;
    facts[k] = v;
    this.dirty.add(k);
    this.broadcast({ t: 'fact', k, v }, from);
    // Stored at once when writes are spaced out; a burst is stored at most every FACT_FLUSH_MS
    // (rows written are a free plan budget). The alarm covers a burst followed by silence.
    if (now - this.lastFlush >= FACT_FLUSH_MS) this.flushFacts(now);
    else if (!this.alarmSet) {
      this.alarmSet = true;
      void this.ctx.storage.setAlarm(this.lastFlush + FACT_FLUSH_MS);
    }
  }

  private flushFacts(now: number): void {
    const facts = this.loadFacts();
    const sql = this.ctx.storage.sql;
    for (const k of this.dirty) sql.exec('INSERT OR REPLACE INTO facts (k, v) VALUES (?, ?)', k, JSON.stringify(facts[k]));
    this.dirty.clear();
    this.lastFlush = now;
  }

  alarm(): void {
    this.alarmSet = false;
    if (this.dirty.size > 0) this.flushFacts(Date.now());
  }
}
