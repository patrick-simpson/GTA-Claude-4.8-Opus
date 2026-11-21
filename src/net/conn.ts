// The socket to the message service (server/): connect, be welcomed, reconnect with a growing wait.
// If the service cannot be reached the game is simply single player: nothing here throws or logs anything.
// (The browser itself prints one line in its console for each failed attempt; a page cannot stop that, so the
// attempts are spaced far apart.)
//
// There may be several addresses for the service, in order of preference: the MAIN one first (a program on a home
// computer, no daily limits), then the BACKUP (the Cloudflare Worker, which rations itself). They are tried in that
// order, the one that last worked first, and when none answers the game is single player until the next round.
//
// The MAIN address is not fixed: the home computer sits behind a free tunnel whose address changes whenever it
// restarts. So the home computer tells the backup where it is, and the game asks the backup ("the lookup", one small
// cacheable GET). To spare the backup, the address learnt is kept in localStorage and tried FIRST on later visits
// without asking anybody; the backup is asked only when there is no remembered address or it did not answer.
// Main is always tried before the backup, and may be used while the backup is resting.
//
// Two answers are not failures, and each has its own patience:
//  - `full`: every seat in town is taken. Ask THE SAME address again in a few minutes (never the next address: a
//    second address would be a second city). The player sees a small "town full" line meanwhile.
//  - `rest`: that address has paused itself until a given time (the backup's daily allowance). It is NOT contacted
//    again before that time plus a random few minutes, not even after a reload (the time is kept in localStorage):
//    every request to it, refused or not, is billed to an account that is not ours to spend.

import {
  BACKUP_HOST, Close, FULL_RETRY_S, MAIN_PATH, PROTOCOL_VERSION, REST_SPREAD_MS, cityUrl, isMainAddress, parseServerMsg,
  type NameIndexes, type ServerMsg, type WelcomeMsg,
} from './protocol';

/**
 * The fixed addresses of the service, in the order to try (the main one is not here: it is looked up). Today that
 * is the backup alone, and it is EMPTY while BACKUP_HOST in protocol.ts is empty: then multiplayer is off, nothing
 * connects, nothing is looked up, and the game is exactly the single player game.
 */
export const SERVICE_URLS: readonly string[] = BACKUP_HOST ? [`wss://${BACKUP_HOST}`] : [];
/** Who to ask where the main service is (MAIN_PATH is added). Empty = nobody, and there is no main. */
export const LOOKUP_URL: string = BACKUP_HOST ? `https://${BACKUP_HOST}` : '';

const LOCAL_URL = /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * The addresses this visit uses: `?net=ws://127.0.0.1:8787` (LOCAL services only, for testing: a link must not be
 * able to send a visitor to somebody else's server; several may be given, separated by commas, to test the order),
 * `?net=0` for off, else SERVICE_URLS and LOOKUP_URL.
 * Test only, and read ONLY alongside `?net=` (so no link can change what a visitor's browser does to the real service):
 *  - `&netretry=5` shortens the wait after "town full";
 *  - `&netmain=http://127.0.0.1:8796` names a LOCAL stand-in for the lookup. What it answers may then be a local
 *    address too (http://127.0.0.1:<port>); the real lookup may only ever name https://<name>.trycloudflare.com.
 */
export function servicePlan(): { urls: string[]; fullRetryS: number; lookup: string } {
  let q: string | null = null, r: string | null = null, m: string | null = null;
  try {
    const sp = new URLSearchParams(location.search);
    q = sp.get('net'); r = sp.get('netretry'); m = sp.get('netmain');
  } catch { /* no location */ }
  if (q === null) return { urls: SERVICE_URLS.filter((u) => /^wss?:\/\//.test(u)), fullRetryS: 0, lookup: LOOKUP_URL };
  const urls = q.split(',').filter((u) => LOCAL_URL.test(u));
  const lookup = m !== null && LOCAL_HTTP.test(m) ? m : '';
  const n = Number(r);
  return { urls, fullRetryS: (urls.length > 0 || lookup) && r !== null && n >= 1 && n <= 600 ? n : 0, lookup };
}

/**
 * off: no service configured. connecting: an attempt is in the air. online: welcomed. waiting: between attempts.
 * full: the town is full; asking again in a few minutes. resting: the service has paused until a known time.
 */
export type NetStatus = 'off' | 'connecting' | 'online' | 'waiting' | 'full' | 'resting';

const RETRY_MIN_MS = 2000;
/** Before it has ever worked, each failure costs a line in the browser's console: start slower and grow faster. */
const RETRY_FIRST_MS = 5000;
/** Once it has worked this visit, keep trying fairly often; if it never has, back right off. */
const RETRY_MAX_MS = 30000;
const RETRY_MAX_NEVER_MS = 300000;
/** While one address is resting, the others are asked no more often than this. */
const RETRY_RESTING_MS = 60000;
/** A session at least this long counts as having worked: the next reconnect is quick. */
const ONLINE_SETTLED_MS = 20000;
/** A socket that opens but is not welcomed within this is dropped. */
const WELCOME_MS = 10000;
/** "Town full": never ask again sooner than this, whatever the hint says; and up to this much extra, at random. */
const FULL_RETRY_MIN_S = 30;
const FULL_SPREAD = 0.25;
/** A resume time further away than this is not believed (the limits reset daily). */
const REST_MAX_MS = 25 * 3600 * 1000;
/** The address that last worked is tried first for this long; after that the list is taken from the top again. */
const REMEMBER_MS = 30 * 60 * 1000;
const KEY_OK = 'pc.net.ok';
const KEY_REST = 'pc.net.rest';
/** The main address last learnt: { u, t }. Tried first on the next visit, without asking the backup. */
const KEY_MAIN = 'pc.net.main';
/** When the backup was last asked where main is: { t }. */
const KEY_LOOKUP = 'pc.net.lookup';
/** The lookup is abandoned after this long. */
const LOOKUP_TIMEOUT_MS = 6000;
/** The backup is asked where main is no more often than this (its answer may be cached for as long anyway)... */
const LOOKUP_GAP_MS = 60_000;
/** ...and, while it is resting, no more often than this: it is meant to be left alone, but main may have come back. */
const LOOKUP_GAP_RESTING_MS = 30 * 60_000;
/** With a local stand-in (tests). */
const LOOKUP_GAP_LOCAL_MS = 1000;

function load<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : null; } catch { return null; }
}
function store(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private browsing: it lasts for this visit */ }
}
function forget(key: string): void {
  try { localStorage.removeItem(key); } catch { /* nothing was kept */ }
}

/** One address's pause: when it resumes, and when this browser may ask again (a little later). Both on this browser's clock. */
interface Rest { resume: number; ask: number; }

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
  /** Which address is in use, or was last tried (an index into the list); -1 before any. */
  service = -1;
  /** While status is 'full': the size of the town, and when the next ask is due (this browser's clock, ms). */
  seats = 0;
  retryAt = 0;
  /** Which home is in use, or was last tried. */
  home: 'main' | 'backup' | '' = '';
  /** Times the backup was asked where main is, since the page loaded. */
  lookups = 0;

  onWelcome: (m: WelcomeMsg) => void = () => {};
  onMsg: (m: ServerMsg) => void = () => {};
  onFrame: (buf: ArrayBuffer) => void = () => {};
  /** The socket went away (after having been online). */
  onDown: () => void = () => {};
  /** The status changed (for the notices). */
  onChange: () => void = () => {};

  private readonly urls: string[];
  private readonly name: () => NameIndexes;
  private readonly fullRetryS: number;
  /** Per address: its pause, if it has declared one that is not over. */
  private readonly rests: (Rest | null)[];
  /** Addresses still to try in this round. */
  private queue: number[] = [];
  private ws: WebSocket | null = null;
  private wait = RETRY_FIRST_MS;
  private timer = 0;
  private everOnline = false;
  private onlineAt = 0;
  private stopped = true;
  /** Who to ask where main is; '' = there is no main, and `urls` is the whole list. Otherwise urls[0] is main's slot. */
  private readonly lookup: string;
  private readonly lookupLocal: boolean;
  /** The backup has been asked in this round. */
  private asked = false;
  /** Bumped whenever an answer still in the air must be ignored. */
  private lookSeq = 0;
  /** The main address that just failed (as learnt, https), so the same answer is not tried twice in a round. */
  private failedMain = '';

  constructor(urls: readonly string[], name: () => NameIndexes, fullRetryS = 0, lookup = '') {
    this.lookup = lookup;
    this.lookupLocal = LOCAL_HTTP.test(lookup);
    // Main's slot is first, and empty until an address is remembered or learnt.
    this.urls = lookup ? ['', ...urls] : urls.slice();
    this.name = name;
    this.fullRetryS = fullRetryS;
    // A pause declared on an earlier visit still holds: a reload must not ask a resting service anything.
    const saved = load<Record<string, Rest>>(KEY_REST) ?? {};
    const now = Date.now();
    this.rests = this.urls.map((u) => {
      const r = saved[u];
      return r && typeof r.ask === 'number' && typeof r.resume === 'number' && r.ask > now && r.ask - now < REST_MAX_MS + REST_SPREAD_MS ? { resume: r.resume, ask: r.ask } : null;
    });
  }

  /** When the resting service resumes (this browser's clock, ms since 1970); 0 when none is resting. */
  get resumeAt(): number {
    let t = 0;
    for (const r of this.rests) if (r && (t === 0 || r.resume < t)) t = r.resume;
    return t;
  }
  /** When this browser will next ask a resting service; 0 when none is resting. */
  get restUntil(): number {
    let t = 0;
    for (const r of this.rests) if (r && (t === 0 || r.ask < t)) t = r.ask;
    return t;
  }

  start(): void {
    if (this.urls.length === 0 || !this.stopped) return;
    this.stopped = false;
    this.round();
    // Leaving the page says so at once, rather than after the service notices the silence.
    addEventListener('pagehide', () => { this.stopped = true; this.lookSeq++; this.drop(); });
    addEventListener('pageshow', (e) => { if (e.persisted && this.stopped) { this.stopped = false; this.round(); } });
  }

  private set(status: NetStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onChange();
  }

  /** A new round: every address that is not resting, the one that last worked first, then in order. */
  private round(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.timer);
    const now = Date.now();
    this.queue = [];
    this.lookSeq++;
    this.asked = false;
    this.failedMain = '';
    if (this.lookup) {
      // The main address remembered from an earlier visit (or an earlier round) is tried without asking anybody.
      const m = load<{ u: string }>(KEY_MAIN);
      this.urls[0] = (m && this.mainWs(m.u)) || '';
      this.rests[0] = null;
    }
    for (let i = 0; i < this.urls.length; i++) {
      const r = this.rests[i];
      if (r && r.ask <= now) this.rests[i] = null;
      if (!this.rests[i]) this.queue.push(i);
    }
    // Main always goes first. Among the fixed addresses, the one that last worked does.
    const top = this.lookup ? 1 : 0;
    const ok = load<{ u: string; t: number }>(KEY_OK);
    const first = ok && now - ok.t < REMEMBER_MS && now >= ok.t ? this.queue.indexOf(this.urls.indexOf(ok.u, top)) : -1;
    if (first > top) this.queue.splice(top, 0, ...this.queue.splice(first, 1));
    this.next();
  }

  /** An address the lookup may name, as a socket address; null for anything else. */
  private mainWs(u: unknown): string | null {
    if (isMainAddress(u)) return 'wss' + u.slice(5);
    // A local stand-in for the lookup (tests) may name a local service.
    if (this.lookupLocal && typeof u === 'string' && LOCAL_HTTP.test(u)) return 'ws' + u.slice(4);
    return null;
  }

  /** Ask the backup where main is, then carry on: with main if the answer is new and usable, else with the next address. */
  private ask(): void {
    this.asked = true;
    const now = Date.now();
    const last = load<{ t: number }>(KEY_LOOKUP);
    const gap = this.lookupLocal ? LOOKUP_GAP_LOCAL_MS : this.restUntil > 0 ? LOOKUP_GAP_RESTING_MS : LOOKUP_GAP_MS;
    if ((last && now >= last.t && now - last.t < gap) || navigator.onLine === false) { this.next(); return; }
    store(KEY_LOOKUP, { t: now });
    this.lookups++;
    this.service = 0;
    this.home = 'main';
    if (this.restUntil === 0) this.set('connecting');
    const seq = ++this.lookSeq;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), LOOKUP_TIMEOUT_MS);
    fetch(this.lookup + MAIN_PATH, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then((res) => (res.ok ? res.json() : null))
      .then((v: unknown) => (v && typeof v === 'object' ? (v as { u?: unknown }).u : null), () => null)
      .then((u) => {
        clearTimeout(timer);
        if (seq !== this.lookSeq || this.stopped || this.ws) return;
        const ws = this.mainWs(u);
        if (!ws || u === this.failedMain) { this.next(); return; }
        store(KEY_MAIN, { u, t: Date.now() });
        this.urls[0] = ws;
        this.open(0);
      });
  }

  /** The next address of the round, or (none left) single player until the next round. */
  private next(): void {
    if (this.stopped || this.ws) return;
    const i = this.queue.shift();
    if (i === undefined) { this.idle(); return; }
    // No network at all: do not even try (a failed attempt is a line in the console).
    if (navigator.onLine === false) { this.queue = []; this.idle(); return; }
    // Main's slot with nothing remembered: ask the backup where main is.
    if (this.lookup && i === 0 && !this.urls[0]) { this.ask(); return; }
    this.open(i);
  }

  /** Nothing answered. Wait: for the growing retry time, and never past the moment a resting address may be asked again. */
  private idle(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const now = Date.now(), ask = this.restUntil;
    const others = this.rests.some((r) => !r);
    let wait = this.wait * (0.8 + Math.random() * 0.4);
    if (ask > 0) {
      wait = others ? Math.max(wait, RETRY_RESTING_MS) : Infinity;
      wait = Math.min(wait, ask - now + 250);
    }
    // A little randomness, so a service that comes back is not met by everybody at once.
    this.timer = window.setTimeout(() => this.round(), Math.max(250, Math.min(wait, 0x7fffffff)));
    this.wait = this.everOnline && ask === 0 ? Math.min(this.wait * 2, RETRY_MAX_MS) : Math.min(this.wait * 3, RETRY_MAX_NEVER_MS);
    this.set(ask > 0 ? 'resting' : 'waiting');
  }

  /** `quiet`: asking again after "town full", which must not take the notice down while the answer is awaited. */
  private open(i: number, quiet = false): void {
    // Nor does a background attempt at another address take the "resting" notice down.
    if (!quiet && this.restUntil === 0) this.set('connecting');
    this.attempts++;
    this.service = i;
    this.home = this.lookup && i === 0 ? 'main' : 'backup';
    let ws: WebSocket;
    try {
      ws = new WebSocket(cityUrl(this.urls[i], this.name()));
    } catch {
      this.next();
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
          this.everOnline = true;
          this.onlineAt = Date.now();
          this.queue = [];
          store(KEY_OK, { u: this.urls[i], t: Date.now() });
          this.set('online');
          this.onWelcome(m);
        } else if (m.t === 'full') {
          clearTimeout(late);
          this.full(i, m.retry, m.seats);
        } else if (m.t === 'rest') {
          clearTimeout(late);
          this.rest(i, m.until, m.now);
        } else if (this.status === 'online') {
          if (m.t === 'host') this.host = m.id;
          this.onMsg(m);
        }
      } else if (d instanceof ArrayBuffer) {
        this.got.bytes += d.byteLength;
        if (this.status === 'online') this.onFrame(d);
      }
    };
    ws.onclose = (e) => {
      clearTimeout(late);
      // The message normally arrives first; the close code alone says the same thing, without the details.
      if (this.ws === ws && e.code === Close.Full) this.full(i, FULL_RETRY_S, 0);
      else if (this.ws === ws && e.code === Close.Rest) this.rest(i, 0, 0);
      else this.lost(ws);
    };
    // The close that follows does the work; this only keeps the event from being unhandled.
    ws.onerror = () => {};
  }

  /** Town full: single player, and ask this same address again later. */
  private full(i: number, hintS: number, seats: number): void {
    const was = this.status === 'online';
    this.drop();
    if (was) this.onDown();
    if (this.stopped) return;
    const hint = Number.isFinite(hintS) && hintS > 0 ? Math.min(hintS, 3600) : FULL_RETRY_S;
    const s = this.fullRetryS > 0 ? this.fullRetryS : Math.max(FULL_RETRY_MIN_S, hint);
    const ms = s * 1000 * (1 + Math.random() * FULL_SPREAD);
    this.queue = [];
    this.seats = seats > 0 ? seats : this.seats;
    this.retryAt = Date.now() + ms;
    this.timer = window.setTimeout(() => {
      if (this.stopped || this.ws) return;
      if (navigator.onLine === false) { this.idle(); return; }
      // If it has gone away altogether by then, the ordinary round takes over.
      this.open(i, true);
    }, ms);
    this.wait = RETRY_FIRST_MS;
    this.set('full');
  }

  /** That address is resting until `until` (its clock, with `now` to compare). No contact before then, plus a spread. */
  private rest(i: number, until: number, now: number): void {
    const was = this.status === 'online';
    let left = Number.isFinite(until) && Number.isFinite(now) ? until - now : 0;
    // A nonsense time: treat it as a short pause rather than as none (asking again at once is the one wrong answer).
    if (!(left > 0) || left > REST_MAX_MS) left = RETRY_RESTING_MS;
    const resume = Date.now() + left;
    this.rests[i] = { resume, ask: resume + Math.random() * REST_SPREAD_MS };
    const saved: Record<string, Rest> = {};
    this.urls.forEach((u, k) => { const r = this.rests[k]; if (r) saved[u] = r; });
    store(KEY_REST, saved);
    this.drop();
    if (was) this.onDown();
    this.onChange();
    // Any address left in this round is still tried (there is none when the backup, the last, is the one resting).
    this.next();
  }

  private lost(ws: WebSocket): void {
    if (this.ws !== ws) return;
    const was = this.status === 'online';
    const main = this.lookup !== '' && this.service === 0;
    this.drop();
    if (!was) {
      if (main) {
        // The address did not answer: it is forgotten (its tunnel has probably restarted under a new one), and the
        // backup is asked once this round where main is now.
        const m = load<{ u: string }>(KEY_MAIN);
        this.failedMain = m && typeof m.u === 'string' ? m.u : '';
        forget(KEY_MAIN);
        this.urls[0] = '';
        if (!this.asked) { this.ask(); return; }
      }
      this.next();
      return;
    }
    this.onDown();
    // Back soon after a real session; a service that welcomes and drops at once is asked less and less often.
    if (Date.now() - this.onlineAt >= ONLINE_SETTLED_MS) this.wait = RETRY_MIN_MS;
    this.queue = [];
    this.idle();
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
    this.set(this.urls.length === 0 ? 'off' : this.restUntil > 0 ? 'resting' : 'waiting');
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
