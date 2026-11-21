// The town as a Durable Object: a thin Cloudflare wrapper round room.ts (which decides everything
// about seats, relay, host and facts) and budget.ts (which decides when the day's allowance is spent).
// This file owns only what is Cloudflare's: hibernatable sockets, SQLite, the alarm, and the count
// of what Cloudflare bills.
//
// It uses the WebSocket Hibernation API, so:
//  - no setTimeout or setInterval anywhere (they would block hibernation);
//  - memory can vanish whenever the town is quiet for about 10 s. What must survive lives in each
//    socket's attachment (the seat, and that socket's messages not yet stored) or in SQLite (facts,
//    and one row holding the day's count).
//
// What is counted, per UTC day (budget.ts has the limits and the pause line):
//  - doRequests: every fetch from the Worker, every alarm, and every incoming message / 20;
//  - workerRequests: what the Worker says it has answered since it last said (it has no storage);
//  - doGbSeconds: an upper bound, the gaps between events up to AWAKE_GAP_MS each, at 128 MB;
//  - rowsWritten and rowsRead: counted where the SQL is run.
// The count is stored (one row) on every visit from the Worker, whenever somebody leaves, and at most
// once a minute while messages flow; never per message. Between stores each socket's attachment
// carries its own message count (attachments are not billed), so an eviction or a crash loses at
// most 19 messages a socket, plus a minute of the duration estimate and of the fact rows written:
// under 1% of the game's share, against a margin of 20%.

import { DurableObject } from 'cloudflare:workers';
import { CITY_CAP, Close, FULL_RETRY_S, MAIN_PATH, isMainAddress } from '../../src/net/protocol';
import { MAIN_OVERDUE_MS } from './where';
import type { FactValue, FullMsg, RestMsg } from '../../src/net/protocol';
import { AWAKE_GAP_MS, BUDGET_FLUSH_MS, Budget, DO_BILLED_GB, WS_MESSAGES_PER_REQUEST, nextReset } from './budget';
import type { BudgetRow, Counts } from './budget';
import { Room, parseNameParam } from './room';
import type { RoomEnv, RoomSocket, Seat } from './room';

/** What the town answers the Worker when it will not seat somebody. The body says why. Never seen by a browser. */
export const REFUSED_STATUS = 409;

export interface CityEnv {
  /**
   * LOCAL TESTS ONLY, and only ever set with `wrangler dev --var` (wrangler.toml has no [vars], so a
   * deployed service never has it). JSON: replacement daily limits by meter name, and `seats`.
   * Its presence also turns on /__test (a movable clock and a look at the count).
   */
  TEST_BUDGET?: string;
  /** LOCAL TESTS ONLY, same rule: a test public key that replaces the one committed in mainkey.ts. */
  TEST_MAIN_KEY?: string;
}

/** Survives hibernation (stored with the socket). */
interface Attachment extends Seat {
  /** Messages from this socket since the count was last stored. */
  n: number;
}

class Sock implements RoomSocket {
  seat: Seat | null = null;
  n = 0;
  constructor(readonly ws: WebSocket) {}
  send(data: string | ArrayBuffer): void {
    try {
      this.ws.send(data);
    } catch { /* the socket is closing; its close event will tidy up */ }
  }
  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
  store(): void {
    if (!this.seat) return;
    const a: Attachment = { ...this.seat, n: this.n };
    try {
      this.ws.serializeAttachment(a);
    } catch { /* closed */ }
  }
}

const ROW_BUDGET = 0;
const ROW_TEST_CLOCK = 1;
/** Where the main service (the home computer) is: its address, its registration counter and its last heartbeat. */
const ROW_MAIN = 2;
interface MainRow { u: string; n: number; hb: number; }

export class City extends DurableObject<CityEnv> implements RoomEnv {
  private readonly room: Room;
  private readonly budget: Budget;
  private readonly socks = new Map<WebSocket, Sock>();
  private readonly test: boolean;
  /** Test only: ms added to the clock. */
  private shift = 0;
  private lastEvent = 0;
  private main: MainRow | null = null;
  private lastStore: number;

  constructor(ctx: DurableObjectState, env: CityEnv) {
    super(ctx, env);
    let cfg: Partial<Counts> & { seats?: number } = {};
    try {
      if (env.TEST_BUDGET) cfg = JSON.parse(env.TEST_BUDGET) as typeof cfg;
    } catch { /* not JSON: no overrides */ }
    this.test = !!env.TEST_BUDGET;

    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS facts (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS meter (k INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    let stored: BudgetRow | null = null;
    let read = 0;
    for (const row of sql.exec('SELECT k, v FROM meter')) {
      read++;
      try {
        if (row.k === ROW_BUDGET) stored = JSON.parse(String(row.v)) as BudgetRow;
        else if (row.k === ROW_TEST_CLOCK && this.test) this.shift = Number(row.v) || 0;
        else if (row.k === ROW_MAIN) this.main = JSON.parse(String(row.v)) as MainRow;
      } catch { /* a damaged row: start the day from zero */ }
    }
    const now = this.now();
    this.budget = new Budget(now, cfg, stored);
    this.budget.add('rowsRead', read);
    this.lastStore = now;

    // Waking from hibernation: seat everybody still connected, and take up the messages they had
    // sent since the count was last stored.
    this.room = new Room(this, Math.max(1, Math.min(CITY_CAP, Math.floor(cfg.seats ?? CITY_CAP))));
    let unstored = 0;
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      const s = new Sock(ws);
      s.seat = { id: a.id, name: a.name, ms: a.ms, host: a.host };
      s.n = a.n || 0;
      unstored += s.n;
      this.socks.set(ws, s);
      this.room.restore(s, s.seat);
    }
    this.budget.add('doRequests', unstored / WS_MESSAGES_PER_REQUEST);
  }

  // ---- what the room asks of its surroundings (RoomEnv) ----

  now(): number {
    return Date.now() + this.shift;
  }

  loadFacts(): Record<string, FactValue> {
    const facts: Record<string, FactValue> = {};
    let read = 0;
    for (const row of this.ctx.storage.sql.exec('SELECT k, v FROM facts')) {
      read++;
      try {
        facts[String(row.k)] = JSON.parse(String(row.v)) as FactValue;
      } catch { /* skip a damaged row */ }
    }
    this.budget.add('rowsRead', read);
    return facts;
  }

  saveFacts(rows: [string, FactValue][]): void {
    const sql = this.ctx.storage.sql;
    for (const [k, v] of rows) sql.exec('INSERT OR REPLACE INTO facts (k, v) VALUES (?, ?)', k, JSON.stringify(v));
    this.budget.add('rowsWritten', rows.length);
  }

  wakeAt(at: number): void {
    // The alarm runs on the real clock.
    void this.ctx.storage.setAlarm(at - this.shift);
    this.budget.add('rowsWritten', 1);
  }

  saveSeat(sock: RoomSocket, seat: Seat): void {
    const s = sock as Sock;
    s.seat = seat;
    s.store();
  }

  // ---- the count ----

  /** Every event starts here: the day may have changed, and the object has been awake since the last event. */
  private touch(): number {
    const now = this.now();
    this.budget.roll(now);
    const gap = this.lastEvent > 0 ? Math.min(Math.max(0, now - this.lastEvent), AWAKE_GAP_MS) : AWAKE_GAP_MS;
    this.budget.add('doGbSeconds', (gap / 1000) * DO_BILLED_GB);
    this.lastEvent = now;
    return now;
  }

  /** One row. After it, the sockets' own counts start again from zero. */
  private store(now: number): void {
    this.lastStore = now;
    if (!this.budget.dirty) return;
    this.budget.add('rowsWritten', 1);
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meter (k, v) VALUES (?, ?)', ROW_BUDGET, JSON.stringify(this.budget.row()));
    this.budget.dirty = false;
    for (const s of this.socks.values()) {
      if (s.n > 0) {
        s.n = 0;
        s.store();
      }
    }
  }

  private restMsg(now: number): RestMsg {
    return { t: 'rest', until: nextReset(now), now };
  }

  /** After anything that counted: past the line, everybody is told and sent home; otherwise store now and then. */
  private settle(now: number): void {
    if (this.budget.spent()) {
      if (this.room.size > 0) {
        this.room.closeAll(this.restMsg(now), Close.Rest, 'resting');
        this.socks.clear();
        this.store(now);
      } else if (now - this.lastStore >= BUDGET_FLUSH_MS) this.store(now);
    } else if (now - this.lastStore >= BUDGET_FLUSH_MS) this.store(now);
  }

  // ---- from the Worker ----

  async fetch(request: Request): Promise<Response> {
    const now = this.touch();
    const url = new URL(request.url);
    this.budget.add('doRequests', 1);
    // The Worker's own requests since it last reported (it has nowhere to keep a count).
    const w = Number(url.searchParams.get('w'));
    if (Number.isFinite(w) && w > 0) this.budget.add('workerRequests', Math.min(Math.floor(w), 1_000_000));
    // Stored at once: a visit from the Worker is rare (a join, or a refusal it could not answer from memory), it
    // may be the only event before this object is put to sleep, and what it reports exists nowhere else.
    this.store(now);

    if (url.pathname === '/__test') {
      if (!this.test) return new Response(null, { status: 404 });
      const add = Number(url.searchParams.get('add'));
      if (Number.isFinite(add) && add !== 0) {
        this.shift += add;
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meter (k, v) VALUES (?, ?)', ROW_TEST_CLOCK, String(this.shift));
        this.lastEvent = 0;
        this.budget.roll(this.now());
      }
      const t = this.now();
      return Response.json({ now: t, day: this.budget.day, used: this.budget.used, lines: this.budget.lines, spent: this.budget.spent(), seats: this.room.seats, size: this.room.size, until: nextReset(t) });
    }

    if (url.pathname === MAIN_PATH) {
      // Where the main service is. Answered even while resting: the game may still use main then.
      if (request.method === 'POST') {
        let m: { u?: unknown; n?: unknown } = {};
        try {
          m = await request.json();
        } catch { /* refused below */ }
        // The Worker has checked the signature, the clock and the address. The counter is checked here, where it is stored.
        if (!isMainAddress(m.u) || !Number.isSafeInteger(m.n) || (this.main && (m.n as number) <= this.main.n)) return new Response(null, { status: 409 });
        this.main = { u: m.u, n: m.n as number, hb: now };
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meter (k, v) VALUES (?, ?)', ROW_MAIN, JSON.stringify(this.main));
        this.budget.add('rowsWritten', 1);
        return new Response(null, { status: 204 });
      }
      // A heartbeat long overdue: the address is forgotten (the counter is kept, so an old registration cannot bring it back).
      const live = this.main && now - this.main.hb <= MAIN_OVERDUE_MS;
      return Response.json({ u: live ? this.main!.u : null, hb: this.main?.hb ?? 0, n: this.main?.n ?? 0 });
    }

    const report = url.pathname === '/count';
    const name = report ? null : parseNameParam(url.searchParams.get('name'));
    if (!report && (request.headers.get('Upgrade') !== 'websocket' || !name)) return new Response(null, { status: 400 });

    this.settle(now);
    if (this.budget.spent()) return Response.json(this.restMsg(now), { status: REFUSED_STATUS });
    if (report || !name) return new Response(null, { status: 204 });
    if (this.room.full) {
      const full: FullMsg = { t: 'full', retry: FULL_RETRY_S, seats: this.room.seats };
      return Response.json(full, { status: REFUSED_STATUS });
    }

    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    const s = new Sock(ws);
    this.socks.set(ws, s);
    this.room.join(s, name);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- from the players ----

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const now = this.touch();
    this.budget.add('doRequests', 1 / WS_MESSAGES_PER_REQUEST);
    const s = this.socks.get(ws);
    if (s) {
      // Every 20th message (one billed request) the socket's own count is put where an eviction cannot lose it.
      if (++s.n % WS_MESSAGES_PER_REQUEST === 0) s.store();
      this.room.message(s, message);
    }
    this.settle(now);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const now = this.touch();
    try {
      // Reply to the Close frame (1005 and 1006 are not codes that may be sent).
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch { /* already closed */ }
    this.gone(ws, now);
  }

  webSocketError(ws: WebSocket): void {
    this.gone(ws, this.touch());
  }

  private gone(ws: WebSocket, now: number): void {
    const s = this.socks.get(ws);
    if (s) {
      this.socks.delete(ws);
      this.room.leave(s);
    }
    // The town may be about to fall silent: store the count while it is certainly still in memory.
    this.store(now);
    this.settle(now);
  }

  alarm(): void {
    const now = this.touch();
    this.budget.add('doRequests', 1);
    this.room.wake();
    this.settle(now);
  }
}
