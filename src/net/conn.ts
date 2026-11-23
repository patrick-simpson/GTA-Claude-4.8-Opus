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
// Everybody must end up in ONE town whenever main is alive, so three things keep a browser off the backup:
//  - patience: time limits count only time in which the page could have noticed an answer (a page building its first
//    frames can sit on an answer for seconds), and a main that refuses at once is asked a second time;
//  - the backup's own answer `main`: "main is alive at this address, go there". The browser does, and comes back
//    saying so (TRIED_MAIN_PARAM) only if main did not answer, and is then seated on the backup;
//  - migration: while online on the backup, main is tried quietly in the background every couple of minutes with a
//    second socket (which costs the backup nothing). When main welcomes it, that socket becomes THE socket: the game
//    is told the old one went down and that it has been welcomed, exactly as after any reconnect.
//
// Two answers are not failures, and each has its own patience:
//  - `full`: every seat in town is taken. Ask THE SAME address again in a few minutes (never the next address: a
//    second address would be a second city). The player sees a small "town full" line meanwhile.
//  - `rest`: that address has paused itself until a given time (the backup's daily allowance). It is NOT contacted
//    again before that time plus a random few minutes, not even after a reload (the time is kept in localStorage):
//    every request to it, refused or not, is billed to an account that is not ours to spend.

import {
  BACKUP_HOST, BOT_PARAM, Close, FRAME_HEADER_BYTES, Frame, MAX_BUNDLE_BYTES, FULL_RETRY_S, MAIN_PATH, PROTOCOL_VERSION, REST_SPREAD_MS, cityUrl, isMainAddress, parseServerMsg,
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
/** A service on this computer (tests, and the mini PC's host bot). */
export const LOCAL_SERVICE = LOCAL_URL;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * The addresses this visit uses: `?net=ws://127.0.0.1:8787` (LOCAL services only, for testing: a link must not be
 * able to send a visitor to somebody else's server; several may be given, separated by commas, to test the order),
 * `?net=0` for off, else SERVICE_URLS and LOOKUP_URL.
 * Test only, and read ONLY alongside `?net=` (so no link can change what a visitor's browser does to the real service):
 *  - `&netretry=5` shortens the wait after "town full";
 *  - `&netmain=http://127.0.0.1:8796` names a LOCAL stand-in for the lookup. What it answers may then be a local
 *    address too (http://127.0.0.1:<port>); the real lookup may only ever name https://<name>.trycloudflare.com.
 *  - `&netprobe=3` shortens the wait between background tries of main while on the backup (seconds).
 */
export function servicePlan(): { urls: string[]; fullRetryS: number; lookup: string; probeS: number } {
  let q: string | null = null, r: string | null = null, m: string | null = null, p: string | null = null;
  try {
    const sp = new URLSearchParams(location.search);
    q = sp.get('net'); r = sp.get('netretry'); m = sp.get('netmain'); p = sp.get('netprobe');
  } catch { /* no location */ }
  if (q === null) return { urls: SERVICE_URLS.filter((u) => /^wss?:\/\//.test(u)), fullRetryS: 0, lookup: LOOKUP_URL, probeS: 0 };
  const urls = q.split(',').filter((u) => LOCAL_URL.test(u));
  const lookup = urls.length > 0 && m !== null && LOCAL_HTTP.test(m) ? m : '';
  const n = Number(r), k = Number(p);
  return {
    urls, fullRetryS: (urls.length > 0 || lookup) && r !== null && n >= 1 && n <= 600 ? n : 0, lookup,
    probeS: lookup && p !== null && k >= 1 && k <= 600 ? k : 0,
  };
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
/** A socket that opens but is not welcomed within this is dropped (counted patiently, see `patient`). */
const WELCOME_MS = 10000;
/** The same for main, which has the backup behind it: a dead main must not hold the player up for long. */
const MAIN_WELCOME_MS = 8000;
/** Main gets a second try in a round when the first failed within MAIN_QUICK_MS (refused, not silent), after this wait. */
const MAIN_AGAIN_MS = 1500;
const MAIN_QUICK_MS = 4000;
/** While online on the backup: main is tried in the background this often, plus up to PROBE_SPREAD of it at random. */
const PROBE_MS = 120_000;
const PROBE_SPREAD = 0.25;
/**
 * ...and when the address is unknown or did not answer, the backup is asked where main is no more often than this
 * per browser. Each ask is a billed request: 8 players on the backup all day are 8 x 144 = 1,152 a day.
 */
const PROBE_LOOKUP_GAP_MS = 10 * 60_000;
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
/** The lookup is abandoned after this long (counted patiently, see `patient`). */
const LOOKUP_TIMEOUT_MS = 8000;
/** The backup is asked where main is no more often than this (its answer may be cached for as long anyway)... */
const LOOKUP_GAP_MS = 60_000;
/** ...and, while it is resting, no more often than this: it is meant to be left alone, but main may have come back. */
const LOOKUP_GAP_RESTING_MS = 30 * 60_000;
/** With a local stand-in (tests). */
const LOOKUP_GAP_LOCAL_MS = 1000;

/**
 * A time limit that a busy page cannot use up. A plain setTimeout measures the clock, and a page that spends six
 * seconds building its first frames finds the limit already passed when it finally looks, with the answer it was
 * waiting for sitting unread behind the timer. (Seen on the live site: the lookup had answered, the 6 s limit fired
 * first, and that browser went to the backup while its neighbour went to main.) This one counts short ticks instead:
 * a stall of any length costs one tick, and between two ticks everything already queued gets its turn. On an idle
 * page it is exactly `ms`; it never runs past three times `ms` by the clock (a hidden tab's timers are slowed).
 * Returns the cancel.
 */
const TICK_MS = 250;
function patient(ms: number, fn: () => void): () => void {
  const end = Date.now() + ms * 3;
  let left = Math.ceil(ms / TICK_MS), id = 0, off = false;
  const tick = (): void => {
    if (off) return;
    if (--left <= 0 || Date.now() >= end) { off = true; fn(); } else id = window.setTimeout(tick, TICK_MS);
  };
  id = window.setTimeout(tick, TICK_MS);
  return () => { off = true; clearTimeout(id); };
}

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
  /** msgs: messages that went down the socket; frames: the binary frames in them (a bundle carries several). */
  readonly sent = { msgs: 0, bytes: 0, frames: 0, bundles: 0 };
  /**
   * The service takes Frame.Bundle (its welcome said b: 1): binary frames sent during a game frame wait here and go
   * as one message at flush() (Net calls it at the end of every frame and from its half-second pump).
   */
  private bundles = false;
  private readonly pend: Uint8Array[] = [];
  private pendBytes = 0;
  /** The host bot's pass (server/home/hostbot.ts), '' for everybody else. Sent with the join; the service is then main. */
  bot = '';
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
  /** Since the page loaded: background tries of main while on the backup, moves to main that came of them, and times the backup said "go to main". */
  probes = 0;
  moves = 0;
  redirects = 0;

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
  /** This round: main was tried and did not answer; main has had its second try; the backup has said "go to main". */
  private mainFailed = false;
  private mainAgain = false;
  private sentToMain = false;
  private openedAt = 0;
  /** The main address last heard of (https, as learnt), kept even after it failed: the background tries start with it. */
  private lastMain = '';
  private readonly probeMs: number;
  private probeTimer = 0;
  /** The background socket to main and the cancel of its time limit, while a try is in the air. */
  private probeWs: WebSocket | null = null;
  private probeOff: (() => void) | null = null;
  /** Main said it is resting: no background try before this (this browser's clock). */
  private probeRest = 0;

  constructor(urls: readonly string[], name: () => NameIndexes, fullRetryS = 0, lookup = '', probeS = 0) {
    this.probeMs = probeS > 0 ? probeS * 1000 : PROBE_MS;
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
    this.mainFailed = this.mainAgain = this.sentToMain = false;
    if (this.lookup) {
      // The main address remembered from an earlier visit (or an earlier round) is tried without asking anybody.
      const m = load<{ u: string }>(KEY_MAIN);
      this.urls[0] = (m && this.mainWs(m.u)) || '';
      if (this.urls[0] && m) this.lastMain = m.u;
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
    this.fetchMain().then((u) => {
      if (seq !== this.lookSeq || this.stopped || this.ws) return;
      const ws = this.mainWs(u);
      if (!ws || u === this.failedMain) { this.next(); return; }
      store(KEY_MAIN, { u, t: Date.now() });
      this.lastMain = u as string;
      this.urls[0] = ws;
      this.open(0);
    });
  }

  /** One GET to the lookup: whatever it names (to be checked by mainWs), or null. Never rejects. */
  private fetchMain(): Promise<unknown> {
    const ctl = new AbortController();
    const off = patient(LOOKUP_TIMEOUT_MS, () => ctl.abort());
    return fetch(this.lookup + MAIN_PATH, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then((res) => (res.ok ? res.json() : null))
      .then((v: unknown) => { off(); return v && typeof v === 'object' ? (v as { u?: unknown }).u : null; }, () => { off(); return null; });
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
    const main = (this.lookup !== '' && i === 0) || this.bot !== '';
    this.home = main ? 'main' : 'backup';
    this.openedAt = Date.now();
    let ws: WebSocket;
    try {
      // The backup is told when main has been tried in this round and did not answer, so that it seats this browser.
      ws = new WebSocket(cityUrl(this.urls[i], this.name(), !main && (this.mainFailed || this.sentToMain)) + (this.bot ? `&${BOT_PARAM}=${encodeURIComponent(this.bot)}` : ''));
    } catch {
      this.next();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // A page busy building its first frames can leave the welcome waiting in its queue: the limit is counted patiently.
    const off = patient(main ? MAIN_WELCOME_MS : WELCOME_MS, () => { if (this.ws === ws && this.status !== 'online') this.lost(ws); });
    this.wire(ws, i, off);
  }

  /** The handlers of THE socket (also given to a background socket at the moment it is adopted). */
  private wire(ws: WebSocket, i: number, off: () => void): void {
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
          off();
          this.id = m.id; this.host = m.host; this.city = m.city;
          this.bundles = m.b === 1; this.pend.length = 0; this.pendBytes = 0;
          this.everOnline = true;
          this.onlineAt = Date.now();
          this.queue = [];
          store(KEY_OK, { u: this.urls[i], t: Date.now() });
          this.set('online');
          this.onWelcome(m);
          this.watchMain();
        } else if (m.t === 'main') {
          off();
          this.toMain(i, m.u);
        } else if (m.t === 'full') {
          off();
          this.full(i, m.retry, m.seats);
        } else if (m.t === 'rest') {
          off();
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
      off();
      // The message normally arrives first; the close code alone says the same thing, without the details.
      if (this.ws === ws && e.code === Close.Full) this.full(i, FULL_RETRY_S, 0);
      else if (this.ws === ws && e.code === Close.Rest) this.rest(i, 0, 0);
      else if (this.ws === ws && e.code === Close.Main) this.toMain(i, null);
      else this.lost(ws);
    };
    // The close that follows does the work; this only keeps the event from being unhandled.
    ws.onerror = () => {};
  }

  /**
   * The backup said: main is alive at `u`, go there. Main is tried now, and this address again after it, flagged, if
   * main does not answer. Once a round: a second "go to main" is a lost socket and nothing more.
   */
  private toMain(i: number, u: unknown): void {
    const was = this.status === 'online';
    const again = this.sentToMain;
    this.drop();
    if (was) this.onDown();
    if (this.stopped) return;
    this.redirects++;
    this.sentToMain = true;
    if (again) { this.next(); return; }
    this.queue.unshift(i);
    const ws = this.lookup && i !== 0 ? this.mainWs(u) : null;
    if (!ws || u === this.failedMain) { this.next(); return; }
    store(KEY_MAIN, { u, t: Date.now() });
    this.lastMain = u as string;
    this.urls[0] = ws;
    this.rests[0] = null;
    // The backup has just said where main is: it is not asked again in this round.
    this.asked = true;
    this.lookSeq++;
    this.open(0);
  }

  // ---- while online on the backup: look for main in the background, and move over when it answers ----

  /** Arrange the next background try of main, if this is the backup and there is a main to look for. */
  private watchMain(): void {
    clearTimeout(this.probeTimer);
    if (this.stopped || !this.lookup || this.status !== 'online' || this.service === 0) return;
    this.probeTimer = window.setTimeout(() => this.probe(), this.probeMs * (1 + Math.random() * PROBE_SPREAD));
  }

  private endProbe(): void {
    clearTimeout(this.probeTimer);
    this.probeOff?.();
    this.probeOff = null;
    const ws = this.probeWs;
    this.probeWs = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already gone */ }
    }
  }

  /** One background try: the address last heard of; when there is none, or it does not answer, the lookup (rarely). */
  private probe(asked = false): void {
    if (this.stopped || !this.lookup || this.status !== 'online' || this.service === 0 || this.probeWs) return;
    const now = Date.now();
    // Not while main has said it is resting, and not without a network (a failed try is a line in the console).
    if (now < this.probeRest || navigator.onLine === false) { this.watchMain(); return; }
    const url = this.lastMain ? this.mainWs(this.lastMain) : null;
    if (!url) { this.probeAsk(asked); return; }
    let ws: WebSocket;
    try {
      ws = new WebSocket(cityUrl(url, this.name()));
    } catch {
      this.watchMain();
      return;
    }
    this.probes++;
    ws.binaryType = 'arraybuffer';
    this.probeWs = ws;
    const failed = (): void => {
      if (this.probeWs !== ws) return;
      this.endProbe();
      this.probeAsk(asked);
    };
    this.probeOff = patient(MAIN_WELCOME_MS, failed);
    ws.onmessage = (e) => {
      if (this.probeWs !== ws || typeof e.data !== 'string') return;
      const m = parseServerMsg(e.data);
      if (!m) return;
      if (m.t === 'welcome' && m.v === PROTOCOL_VERSION) this.adopt(ws, url, m);
      else if (m.t === 'full') { this.endProbe(); this.watchMain(); }   // main is full: stay where we are
      else if (m.t === 'rest') {
        const left = m.until - m.now;
        this.probeRest = Date.now() + (left > 0 && left <= REST_MAX_MS ? left : RETRY_RESTING_MS) + Math.random() * REST_SPREAD_MS;
        this.endProbe();
        this.watchMain();
      } else failed();
    };
    ws.onclose = (e) => {
      if (this.probeWs !== ws) return;
      if (e.code === Close.Full || e.code === Close.Rest) { this.endProbe(); this.watchMain(); } else failed();
    };
    ws.onerror = () => {};
  }

  /** Main is unknown or did not answer: ask the lookup where it is, seldom, and try at once what it names if that is new. */
  private probeAsk(asked: boolean): void {
    const now = Date.now();
    const last = load<{ t: number }>(KEY_LOOKUP);
    const gap = this.lookupLocal ? Math.min(PROBE_LOOKUP_GAP_MS, this.probeMs) : PROBE_LOOKUP_GAP_MS;
    if (asked || (last && now >= last.t && now - last.t < gap) || navigator.onLine === false) { this.watchMain(); return; }
    store(KEY_LOOKUP, { t: now });
    this.lookups++;
    const seq = ++this.lookSeq;
    this.fetchMain().then((u) => {
      if (seq !== this.lookSeq || this.stopped || this.status !== 'online' || this.service === 0) return;
      // The backup knows of no main at all: the old address is not tried any more, only the lookup, until it names one.
      if (!this.mainWs(u)) { this.lastMain = ''; this.watchMain(); return; }
      if (u === this.lastMain) { this.watchMain(); return; }
      this.lastMain = u as string;
      this.probe(true);
    });
  }

  /** Main welcomed the background socket: it becomes THE socket. The game hears "down", then "welcome", as after any reconnect. */
  private adopt(ws: WebSocket, url: string, m: WelcomeMsg): void {
    this.probeOff?.();
    this.probeOff = null;
    this.probeWs = null;
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* already gone */ }
    }
    clearTimeout(this.timer);
    this.id = 0; this.host = 0; this.city = 0;
    this.onDown();
    this.ws = ws;
    this.urls[0] = url;
    this.rests[0] = null;
    this.service = 0;
    this.home = 'main';
    this.moves++;
    this.id = m.id; this.host = m.host; this.city = m.city;
    this.bundles = m.b === 1; this.pend.length = 0; this.pendBytes = 0;
    this.onlineAt = Date.now();
    this.queue = [];
    store(KEY_MAIN, { u: this.lastMain, t: Date.now() });
    store(KEY_OK, { u: url, t: Date.now() });
    this.wire(ws, 0, () => {});
    this.onChange();
    this.onWelcome(m);
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
        // Refused at once (not silence): one more try shortly, before anything is concluded. A tunnel that is up
        // while the program behind it restarts answers like this for a few seconds.
        if (!this.mainAgain && Date.now() - this.openedAt < MAIN_QUICK_MS && this.urls[0]) {
          this.mainAgain = true;
          if (this.restUntil === 0) this.set('connecting');
          this.timer = window.setTimeout(() => { if (!this.stopped && !this.ws) this.open(0, true); }, MAIN_AGAIN_MS);
          return;
        }
        this.mainFailed = true;
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
    this.endProbe();
    this.set(this.urls.length === 0 ? 'off' : this.restUntil > 0 ? 'resting' : 'waiting');
  }

  /** False when it could not be sent (offline, or the socket is backed up: state is not worth queueing). */
  send(data: ArrayBuffer | Uint8Array | string): boolean {
    const ws = this.ws;
    if (!ws || this.status !== 'online' || ws.readyState !== 1 || ws.bufferedAmount > 16384) return false;
    if (typeof data !== 'string') {
      this.sent.frames++;
      // Batched: copied (callers reuse their buffers), sent at the next flush. A keepalive alone needs no company.
      if (this.bundles && data.byteLength > 1) {
        const n = data.byteLength;
        if (this.pendBytes + n + 2 > MAX_BUNDLE_BYTES - FRAME_HEADER_BYTES) this.flush();
        const src = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.pend.push(src.slice());
        this.pendBytes += n + 2;
        return true;
      }
    } else this.flush(); // (in order: what was batched goes first)
    return this.raw(data);
  }

  /** Everything batched since the last flush, as one message (or as itself, when it is only one). */
  flush(): void {
    const pend = this.pend, k = pend.length;
    if (k === 0) return;
    let out: Uint8Array;
    if (k === 1) out = pend[0];
    else {
      out = new Uint8Array(FRAME_HEADER_BYTES + this.pendBytes);
      out[0] = Frame.Bundle;
      let o = FRAME_HEADER_BYTES;
      for (const f of pend) {
        out[o] = f.byteLength & 0xff; out[o + 1] = f.byteLength >> 8;
        out.set(f, o + 2);
        o += 2 + f.byteLength;
      }
      this.sent.bundles++;
    }
    pend.length = 0; this.pendBytes = 0;
    this.raw(out);
  }

  private raw(data: ArrayBuffer | Uint8Array | string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(data as ArrayBuffer | string); } catch { return false; }
    this.sent.msgs++;
    this.sent.bytes += typeof data === 'string' ? data.length : data.byteLength;
    return true;
  }
}
