// The socket to the message service (server/): connect, be welcomed, reconnect with a growing wait.
// If the service cannot be reached the game is simply single player: nothing here throws, shows or logs anything.
// (The browser itself prints one line in its console for each failed attempt; a page cannot stop that, so the
// attempts are spaced far apart.)

import { PROTOCOL_VERSION, cityUrl, parseServerMsg, type NameIndexes, type ServerMsg, type WelcomeMsg } from './protocol';

/**
 * Where the service lives. EMPTY = multiplayer off: nothing connects and the game is exactly the single player
 * game. Set it to the deployed Worker ('wss://port-calamity-city.<account>.workers.dev') when that exists.
 */
export const SERVICE_URL = '';

/**
 * The URL this visit uses: `?net=ws://127.0.0.1:8787` (a local service only, for testing: a link must not be able
 * to send a visitor to somebody else's server), `?net=0` for off, else SERVICE_URL.
 */
export function serviceUrl(): string {
  let q: string | null = null;
  try { q = new URLSearchParams(location.search).get('net'); } catch { /* no location */ }
  if (q === null) return SERVICE_URL;
  return /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/.test(q) ? q : '';
}

/** off: no service configured. connecting: an attempt is in the air. online: welcomed. waiting: between attempts. */
export type NetStatus = 'off' | 'connecting' | 'online' | 'waiting';

const RETRY_MIN_MS = 2000;
/** Before it has ever worked, each failure costs a line in the browser's console: start slower and grow faster. */
const RETRY_FIRST_MS = 5000;
/** Once it has worked this visit, keep trying fairly often; if it never has, back right off. */
const RETRY_MAX_MS = 30000;
const RETRY_MAX_NEVER_MS = 300000;
/** A socket that opens but is not welcomed within this is dropped. */
const WELCOME_MS = 10000;

export class Connection {
  status: NetStatus = 'off';
  /** Own id while online, else 0. */
  id = 0;
  host = 0;
  city = 0;
  /** Counters since the page loaded, for the tests and the free plan sums. */
  readonly sent = { msgs: 0, bytes: 0 };
  readonly got = { msgs: 0, bytes: 0 };
  attempts = 0;

  onWelcome: (m: WelcomeMsg) => void = () => {};
  onMsg: (m: ServerMsg) => void = () => {};
  onFrame: (buf: ArrayBuffer) => void = () => {};
  /** The socket went away (after having been online). */
  onDown: () => void = () => {};

  private ws: WebSocket | null = null;
  private wait = RETRY_FIRST_MS;
  private timer = 0;
  private everOnline = false;
  private stopped = true;

  constructor(private readonly base: string, private readonly name: () => NameIndexes) {}

  start(): void {
    if (!this.base || !this.stopped) return;
    this.stopped = false;
    this.open();
    // Leaving the page says so at once, rather than after the service notices the silence.
    addEventListener('pagehide', () => { this.stopped = true; this.drop(); });
    addEventListener('pageshow', (e) => { if (e.persisted && this.stopped) { this.stopped = false; this.open(); } });
  }

  private open(): void {
    if (this.stopped || this.ws) return;
    // No network at all: do not even try (a failed attempt is a line in the console).
    if (navigator.onLine === false) { this.retry(); return; }
    this.status = 'connecting';
    this.attempts++;
    let ws: WebSocket;
    try {
      ws = new WebSocket(cityUrl(this.base, this.name()));
    } catch {
      this.retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // A page busy building its first frames can leave the welcome waiting in its queue past the limit: the second,
    // short timer lets anything already queued be read before the socket is given up on.
    let late = window.setTimeout(() => {
      late = window.setTimeout(() => { if (this.ws === ws && this.status !== 'online') this.lost(ws); }, 1500);
    }, WELCOME_MS);
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const d: unknown = e.data;
      this.got.msgs++;
      if (typeof d === 'string') {
        this.got.bytes += d.length;
        const m = parseServerMsg(d);
        if (!m) return;
        if (m.t === 'welcome') {
          if (m.v !== PROTOCOL_VERSION) { this.lost(ws); return; }
          clearTimeout(late);
          this.id = m.id; this.host = m.host; this.city = m.city;
          this.status = 'online';
          this.everOnline = true;
          this.wait = RETRY_MIN_MS;
          this.onWelcome(m);
        } else if (this.status === 'online') {
          if (m.t === 'host') this.host = m.id;
          this.onMsg(m);
        }
      } else if (d instanceof ArrayBuffer) {
        this.got.bytes += d.byteLength;
        if (this.status === 'online') this.onFrame(d);
      }
    };
    ws.onclose = () => { clearTimeout(late); this.lost(ws); };
    // The close that follows does the work; this only keeps the event from being unhandled.
    ws.onerror = () => {};
  }

  private lost(ws: WebSocket): void {
    if (this.ws !== ws) return;
    const was = this.status === 'online';
    this.drop();
    if (was) this.onDown();
    this.retry();
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.id = 0; this.host = 0; this.city = 0;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already gone */ }
    }
    clearTimeout(this.timer);
    this.status = this.base ? 'waiting' : 'off';
  }

  private retry(): void {
    if (this.stopped) return;
    this.status = 'waiting';
    clearTimeout(this.timer);
    // A little randomness, so a service that comes back is not met by everybody at once.
    this.timer = window.setTimeout(() => this.open(), this.wait * (0.8 + Math.random() * 0.4));
    this.wait = this.everOnline ? Math.min(this.wait * 2, RETRY_MAX_MS) : Math.min(this.wait * 3, RETRY_MAX_NEVER_MS);
  }

  /** False when it could not be sent (offline, or the socket is backed up: state is not worth queueing). */
  send(data: ArrayBuffer | Uint8Array | string): boolean {
    const ws = this.ws;
    if (!ws || this.status !== 'online' || ws.readyState !== 1 || ws.bufferedAmount > 16384) return false;
    try { ws.send(data as ArrayBuffer | string); } catch { return false; }
    this.sent.msgs++;
    this.sent.bytes += typeof data === 'string' ? data.length : data.byteLength;
    return true;
  }
}
