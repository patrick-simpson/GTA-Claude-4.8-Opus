// Cloud save (fun queue 2, item 41): the save follows you between a phone and a laptop.
//
// Off until the player turns it on (Settings > Form C-6): until then this file does nothing and sends nothing.
// On, it keeps the same document the game keeps in localStorage (src/game/save.ts) and the bridge progress
// (src/world/progress.ts) in a small cloud copy, kept on the message service's Worker (server/src/saves.ts: POST /save).
// Nothing is stored there but the game's own document under a random secret this browser made; no names, no
// accounts. A second device joins the same copy with a one-time code (Settings on the first device shows it, the
// second types it in); a device can leave again (Unlink), and the last one out deletes the copy.
//
// This file imports nothing heavy on purpose: src/main.ts runs `cloud.early()` BEFORE the game's big script is
// fetched, so a newer cloud save can be put into localStorage before the game reads it (no second load). It works on
// the raw localStorage text of the two keys and never needs the save module.
//
// How it decides (rev is the cloud copy's change counter, `when` the save's own time stamp):
//   - we remember the rev we last synced (st.rev) and the save's `when` as of then (st.wh);
//   - local changed = the save's `when` is later than st.wh; cloud changed = the cloud's rev is not st.rev;
//   - only one changed: the other side takes it (up: a put that must match the rev; down: put into localStorage,
//     and a reload if the game is already running); neither: nothing; both: a choice, "this device" or "the cloud".
//   - first sync of a device (never linked): if this device has no progress at all it takes the cloud's silently.
// It never blocks the game: a 2.5 s wait before the game loads at most, then it carries on in the background.
// Offline: writes just stay "later than st.wh" and go up at the next tick that finds the service (retry 1, 2, 4 ... 15 min).
// The settings block is never taken from the cloud (a phone's low quality must not follow you to a laptop).

import { BACKUP_HOST } from '../net/protocol';

const SAVE_KEY = 'portcalamity.save.v1';
const PROG_KEY = 'portcalamity.progress.v1';
const KEY = 'pc.cloud';
const NOTE_KEY = 'pc.cloud.note';
/** The newest save document version this build can read (src/game/save.ts SAVE_VERSION). A newer one is left alone, not applied. */
const MAX_V = 1;
const TICK_MS = 15_000;
const MIN_GAP_MS = 90_000;
const BOOT_WAIT_MS = 2500;
const CALL_TIMEOUT_MS = 8000;
const KEEPALIVE_MAX = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface State {
  on: boolean;
  /** This device's secret (43 URL-safe letters), made here, never sent in a URL, never shown. */
  k: string;
  /** The cloud copy's rev at the last sync, and the save's `when` that went with it. */
  rev: number; wh: number;
  /** A short signature of the save's progress (money, missions, ducks, jumps, job counts, records, shop) as of the last sync: see sig(). */
  sg: string;
  /** When the last successful sync finished (ms). */
  last: number;
  /** A last-moment upload sent while the page was closing, whose answer may not have been read: what it will have made. */
  exp?: { rev: number; wh: number; sg: string };
}

type SyncResult = 'same' | 'pushed' | 'applied' | 'kept' | 'later';
export type CloudState = 'off' | 'ok' | 'waiting' | 'offline' | 'busy' | 'toobig' | 'newer';
interface Reply { s: number; j: Record<string, unknown> }
type Doc = Record<string, unknown>;
interface Cloud { rev: number; at: number; devices: number; doc: { save: Doc; progress?: Doc } }

const obj = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

/** The service this visit talks to over HTTP, or null. Test only: `?net=ws://127.0.0.1:PORT` (LOCAL only) names a local one; `?net=0` is none. */
function base(): string | null {
  let q: string | null = null, saveOff = false;
  try { const sp = new URLSearchParams(location.search); q = sp.get('net'); saveOff = sp.get('save') === '0'; } catch { return null; }
  if (saveOff) return null;
  if (q !== null) {
    for (const u of q.split(',')) { const m = /^ws(:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)\/?$/.exec(u); if (m) return 'http' + m[1]; }
    return null;
  }
  return BACKUP_HOST ? `https://${BACKUP_HOST}` : null;
}

function newSecret(): string {
  const u = new Uint8Array(32);
  crypto.getRandomValues(u);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What a person typed, made into a code (upper case, spaces and dashes dropped), or null. */
export function cleanCode(v: string): string | null {
  const c = v.toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

function readLocal(): { doc: Doc | null; when: number } {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { doc: null, when: 0 };
    const d = obj(JSON.parse(raw));
    return { doc: d, when: typeof d.when === 'number' && Number.isFinite(d.when) ? d.when : 0 };
  } catch { return { doc: null, when: 0 }; }
}
/** The save's time stamp without parsing the whole document (it is the second key written). */
function localWhen(): number {
  try { const raw = localStorage.getItem(SAVE_KEY); const m = raw ? /"when":(\d+)/.exec(raw.slice(0, 80)) : null; return m ? Number(m[1]) : 0; } catch { return 0; }
}
/**
 * What counts as the player's own progress in a save document, as a short string. The document is rewritten whenever the game
 * saves (where she stands, the hour, the distance driven), so its time stamp says little; this does not move unless she earned
 * or spent something, filed a mission, found a duck, landed a jump, did a job, set a record or changed her shop.
 */
export function sig(d: Doc | null): string {
  if (!d) return '';
  const p = obj(d.player), st = obj(d.stats);
  const text = JSON.stringify([p.money, p.owned, d.missions, d.ducks, d.jumps, d.counts, d.best, d.shop, st.earned]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36) + '.' + text.length.toString(36);
}
function hasProgress(d: Doc | null): boolean {
  if (!d) return false;
  const st = obj(d.stats);
  return d.player != null || (typeof st.played === 'number' && st.played > 5) || (Array.isArray(d.missions) && d.missions.length > 0);
}
function brief(d: Doc, at: number): string {
  const st = obj(d.stats), p = obj(d.player);
  const mins = typeof st.played === 'number' ? Math.round(st.played / 60) : 0;
  const played = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min played` : `${mins} min played`;
  const money = typeof p.money === 'number' ? ` · $${Math.round(p.money).toLocaleString('en-US')}` : '';
  const jobs = Array.isArray(d.missions) && d.missions.length ? ` · ${d.missions.length} mission${d.missions.length === 1 ? '' : 's'}` : '';
  let when = '';
  try { when = new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { /* odd locale */ }
  return `${played}${money}${jobs}${when ? '\nsaved ' + when : ''}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

class CloudSave {
  private st: State = { on: false, k: '', rev: 0, wh: 0, sg: '', last: 0 };
  /** True while a cloud document is being put into localStorage and the page is about to reload: the game's own writes must not undo it. */
  applying = false;
  /** The game is running (or the boot wait ran out): a newer cloud save then needs a reload, not just a write. */
  private live = false;
  /** The look before the game loaded went through, so the game need not look again. */
  private looked = false;
  private chain: Promise<unknown> = Promise.resolve();
  private nextTry = 0;
  private fails = 0;
  private lastPush = 0;
  private ticker = 0;
  private listeners = new Set<() => void>();
  private _state: CloudState = 'off';
  /** A code made on this device: shown in Settings until it dies. */
  code: { c: string; exp: number } | null = null;
  /** The result of the last thing the player asked for, for the Settings page. */
  msg = '';
  /** How many devices share the copy, as the service last said. */
  devices = 0;

  constructor() {
    try {
      const v = obj(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
      if (typeof v.k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.k)) {
        this.st = { on: v.on === true, k: v.k, rev: Math.max(0, Math.floor(Number(v.rev)) || 0), wh: Math.max(0, Number(v.wh) || 0), sg: typeof v.sg === 'string' ? v.sg.slice(0, 40) : '', last: Math.max(0, Number(v.last) || 0) };
        const e = obj(v.exp);
        if (typeof e.rev === 'number' && typeof e.wh === 'number') this.st.exp = { rev: e.rev, wh: e.wh, sg: typeof e.sg === 'string' ? e.sg : '' };
      }
    } catch { /* storage refused: it stays off */ }
    this.startTicker();
  }

  /** Is there a service to talk to (a configured address, and saving not switched off)? */
  get available(): boolean { return base() !== null; }
  get on(): boolean { return this.st.on && this.st.k !== '' && this.available; }
  get lastSync(): number { return this.st.last; }
  get state(): CloudState { return this.on ? this._state : 'off'; }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const f of this.listeners) { try { f(); } catch { /* a listener's trouble is its own */ } } }
  private setState(s: CloudState): void { if (this._state !== s) { this._state = s; this.emit(); } }

  private persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.st)); } catch { /* play on */ }
  }
  private startTicker(): void {
    if (this.ticker || typeof window === 'undefined') return;
    this.ticker = window.setInterval(() => this.tick(), TICK_MS);
    addEventListener('online', () => { this.nextTry = 0; this.lastPush = 0; this.fails = 0; this.tick(); });
  }
  /** A tick: if the save has been written since the last sync, and it is time, send it. */
  private tick(): void {
    if (!this.on || this.applying) return;
    const now = Date.now();
    if (now < this.nextTry || now - this.lastPush < MIN_GAP_MS) return;
    if (localWhen() > this.st.wh) void this.quickPush();
  }
  /** The usual upload: just put (one request); only when the cloud copy has moved on does it look, and settle it. */
  private quickPush(): Promise<void> {
    return this.queue(async () => {
      if (!this.on || this.applying) return;
      if ((await this.push(false)) === 'conflict') await this.syncBody(false);
    });
  }

  // ---- the wire ----

  private async call(op: string, extra: Record<string, unknown> = {}, keepalive = false): Promise<Reply | null> {
    const b = base();
    if (!b || !this.st.k) return null;
    const body = JSON.stringify({ op, k: this.st.k, ...extra });
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl && !keepalive ? window.setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS) : 0;
    try {
      const r = await fetch(b + '/save', { method: 'POST', headers: { 'content-type': 'text/plain' }, body, cache: 'no-store', credentials: 'omit', keepalive: keepalive && body.length < KEEPALIVE_MAX, signal: ctl?.signal });
      let j: Doc = {};
      try { j = obj(await r.json()); } catch { /* not JSON: an error page */ }
      return { s: r.status, j };
    } catch { return null; } finally { if (t) clearTimeout(t); }
  }

  private async get(): Promise<{ cloud: Cloud | null; err: Reply | null }> {
    const r = await this.call('get');
    if (!r) return { cloud: null, err: null };
    if (r.s === 200 && r.j.ok === 1) {
      const d = obj(r.j.doc);
      if (typeof r.j.rev === 'number' && typeof r.j.at === 'number' && d.save && typeof d.save === 'object') {
        return { cloud: { rev: r.j.rev, at: r.j.at, devices: typeof r.j.devices === 'number' ? r.j.devices : 1, doc: { save: obj(d.save), progress: d.progress ? obj(d.progress) : undefined } }, err: null };
      }
    }
    return { cloud: null, err: r };
  }

  /** Every operation goes through here one at a time. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private blob(): { save: Doc; progress?: Doc; when: number } | null {
    const { doc, when } = readLocal();
    if (!doc) return null;
    if (typeof doc.v === 'number' && doc.v > MAX_V) return null;
    let progress: Doc | undefined;
    try { const p = localStorage.getItem(PROG_KEY); if (p) progress = obj(JSON.parse(p)); } catch { /* none */ }
    return { save: doc, progress, when };
  }

  /** Put the local document up. Returns 'ok', 'conflict' (the rev moved), or 'later' (try again). */
  private async push(force: boolean, keepalive = false): Promise<'ok' | 'conflict' | 'later'> {
    const b = this.blob();
    if (!b) return 'ok';
    const doc: Doc = { save: b.save };
    if (b.progress) doc.progress = b.progress;
    // The service refuses more than 64 KB (and would only be told so): do not send it.
    if (JSON.stringify(doc).length > 64 * 1024) { this.setState('toobig'); this.nextTry = Date.now() + 3_600_000; return 'later'; }
    this.lastPush = Date.now();
    const mine = sig(b.save);
    if (keepalive) { this.st.exp = { rev: this.st.rev + 1, wh: b.when, sg: mine }; this.persist(); }
    let r = await this.call('put', { base: this.st.rev, at: b.when, doc, force }, keepalive);
    if (r && r.s === 404 && this.st.rev > 0) {
      // The service has no record of this device (its data was lost): start the copy again from here.
      this.st.rev = 0;
      r = await this.call('put', { base: 0, at: b.when, doc, force: false }, keepalive);
    }
    if (!r) { this.backoff(); this.setState('offline'); return 'later'; }
    if (r.s === 200 && typeof r.j.rev === 'number') {
      this.st.rev = r.j.rev; this.st.wh = b.when; this.st.sg = mine; this.st.last = Date.now(); delete this.st.exp;
      this.persist(); this.fails = 0; this.nextTry = 0; this.setState('ok');
      return 'ok';
    }
    delete this.st.exp; this.persist();
    if (r.s === 409) return 'conflict';
    if (r.s === 413) { this.setState('toobig'); this.nextTry = Date.now() + 3_600_000; return 'later'; }
    this.backoff();
    this.setState(r.s === 429 || r.s === 503 ? 'busy' : 'waiting');
    return 'later';
  }
  private backoff(): void {
    this.fails++;
    this.nextTry = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(this.fails - 1, 4));
  }

  // ---- deciding ----

  /** Bring this device and the cloud copy into line (see the file's head). Returns what happened. */
  sync(interactive: boolean): Promise<SyncResult> {
    return this.queue(() => this.syncBody(interactive));
  }
  private async syncBody(interactive: boolean): Promise<SyncResult> {
    {
      if (!this.on) return 'later';
      const { cloud, err } = await this.get();
      if (!cloud) {
        if (!err) { this.backoff(); this.setState('offline'); return 'later'; }
        if (err.s === 404) { this.st.rev = 0; const p = await this.push(false); return p === 'ok' ? 'pushed' : 'later'; }
        this.backoff(); this.setState(err.s === 429 || err.s === 503 ? 'busy' : 'waiting');
        return 'later';
      }
      this.devices = cloud.devices;
      const v = cloud.doc.save.v;
      if (typeof v === 'number' && v > MAX_V) { this.setState('newer'); return 'later'; }
      // A last-moment upload whose answer was lost: if the cloud holds exactly what it would have made, it is ours.
      if (this.st.exp && cloud.rev === this.st.exp.rev && cloud.at === this.st.exp.wh) { this.st.rev = cloud.rev; this.st.wh = this.st.exp.wh; this.st.sg = this.st.exp.sg; }
      delete this.st.exp;
      const local = readLocal();
      const touched = local.when > this.st.wh;
      const cloudChanged = cloud.rev !== this.st.rev;
      if (!cloudChanged && !touched) { this.st.last = Date.now(); this.persist(); this.fails = 0; this.setState('ok'); return 'same'; }
      if (!cloudChanged) { this.st.rev = cloud.rev; const p = await this.push(false); return p === 'ok' ? 'pushed' : 'later'; }
      // The cloud moved on. This side only counts as changed when the player's own progress differs from the last sync
      // (the game rewrites the document just by being open, so being touched alone is not a change); a device that has
      // never held a save, or has none, just takes the cloud's.
      if (!hasProgress(local.doc) || sig(local.doc) === this.st.sg || sig(local.doc) === sig(cloud.doc.save)) { this.apply(cloud, local.doc); return 'applied'; }
      if (!hasProgress(cloud.doc.save)) { this.st.rev = cloud.rev; const p = await this.push(true); return p === 'ok' ? 'pushed' : 'later'; }
      // Both sides hold progress the other does not: the player chooses.
      void interactive;
      const pick = await this.ask(local.doc as Doc, local.when, cloud.doc.save, cloud.at);
      if (pick === 'cloud') { this.apply(cloud, local.doc); return 'applied'; }
      this.st.rev = cloud.rev;
      const p = await this.push(true);
      return p === 'ok' ? 'kept' : 'later';
    }
  }

  /** Put the cloud's document into localStorage (this device's own settings stay), and reload if the game is running. */
  private apply(c: Cloud, local: Doc | null): void {
    const doc = { ...c.doc.save };
    const mine = local ? obj(local.settings) : null;
    if (mine && Object.keys(mine).length) doc.settings = mine;
    this.applying = true;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(doc));
      if (c.doc.progress) localStorage.setItem(PROG_KEY, JSON.stringify(c.doc.progress));
      sessionStorage.setItem(NOTE_KEY, '1');
    } catch { this.applying = false; return; }
    this.st.rev = c.rev;
    this.st.wh = typeof doc.when === 'number' ? doc.when : 0;
    this.st.sg = sig(doc);
    this.st.last = Date.now(); this.fails = 0;
    this.persist();
    this.setState('ok');
    if (this.live) { try { location.reload(); } catch { /* the next visit loads it */ } return; }
    this.applying = false;
  }

  /** The choice, when both sides changed. A small card over whatever is on screen. */
  private ask(local: Doc, localAt: number, cloud: Doc, cloudAt: number): Promise<'local' | 'cloud'> {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') { resolve('local'); return; }
      const style = document.createElement('style');
      style.textContent = `.pc-cloud-ask{position:fixed;inset:0;z-index:99999;background:rgba(20,33,61,.82);display:flex;align-items:center;justify-content:center;padding:16px;font-family:var(--f-text,'Arial Narrow',sans-serif);color:#14213d}
.pc-cloud-ask .card{background:#f2e8cf;border:3px solid #14213d;max-width:520px;width:100%;padding:18px 20px;box-shadow:6px 6px 0 #14213d}
.pc-cloud-ask h2{margin:0 0 6px;font-family:var(--f-head,'Arial Narrow',sans-serif);font-size:26px;letter-spacing:.02em;text-transform:uppercase}
.pc-cloud-ask p{margin:0 0 12px;font-size:17px;line-height:1.3}
.pc-cloud-ask .opt{display:block;width:100%;text-align:left;margin:0 0 10px;padding:10px 12px;background:#fff8e6;border:2px solid #14213d;font:inherit;font-size:17px;color:inherit;cursor:pointer;white-space:pre-line}
.pc-cloud-ask .opt:hover,.pc-cloud-ask .opt:focus{background:#f0a202;outline:none}
.pc-cloud-ask .opt b{display:block;font-family:var(--f-head,'Arial Narrow',sans-serif);font-size:20px;text-transform:uppercase;letter-spacing:.03em}`;
      const root = document.createElement('div');
      root.className = 'pc-cloud-ask';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      const card = document.createElement('div');
      card.className = 'card';
      const h = document.createElement('h2'); h.textContent = 'Two different saves';
      const p = document.createElement('p'); p.textContent = 'This device and the cloud both have new progress since they last matched. Which one do you want to keep? The other is replaced.';
      card.append(h, p);
      const done = (pick: 'local' | 'cloud'): void => { root.remove(); style.remove(); resolve(pick); };
      const opt = (title: string, text: string, pick: 'local' | 'cloud'): HTMLButtonElement => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
        const t = document.createElement('b'); t.textContent = title;
        b.append(t, document.createTextNode(text));
        b.addEventListener('click', () => done(pick));
        return b;
      };
      const a = opt("Use this device's progress", brief(local, localAt), 'local');
      const c = opt("Use the cloud's progress", brief(cloud, cloudAt), 'cloud');
      card.append(a, c);
      root.append(card);
      document.head.append(style);
      document.body.append(root);
      a.focus();
    });
  }

  // ---- the page load ----

  /**
   * Before the game is loaded: if cloud save is on, look once (waiting up to 2.5 s) and settle it, so that a newer
   * cloud save is already in localStorage when the game reads it. Never throws; resolves in every case.
   */
  early(): Promise<void> {
    if (!this.on) return Promise.resolve();
    const work = this.sync(false).catch(() => 'later' as const);
    return new Promise((resolve) => {
      const t = window.setTimeout(() => { this.live = true; resolve(); }, BOOT_WAIT_MS);
      void work.then((r) => { clearTimeout(t); this.looked = r !== 'later'; resolve(); });
    });
  }

  /** The game is up: from here a cloud save arriving means a reload. Also shows the one-line note after a load from the cloud. */
  attach(): string | null {
    this.live = true;
    let note: string | null = null;
    try { if (sessionStorage.getItem(NOTE_KEY)) { sessionStorage.removeItem(NOTE_KEY); note = 'Cloud save: your progress from your other device is loaded.'; } } catch { /* none */ }
    // One look now (the page loaded before it was on, or the early wait ran out), then the ticker keeps it.
    if (this.on && !this.looked) void this.sync(false);
    return note;
  }

  /** The tab is going away or hidden: send what is new, in the way that survives the page closing. */
  flush(): void {
    if (!this.on || this.applying || localWhen() <= this.st.wh) return;
    if (Date.now() - this.lastPush < 5000) return;
    void this.queue(async () => { if (this.on && !this.applying && localWhen() > this.st.wh) await this.push(false, true); });
  }

  // ---- what the Settings page does ----

  async setOn(on: boolean): Promise<void> {
    this.msg = '';
    if (!on) { this.st.on = false; this.persist(); this.code = null; this.emit(); return; }
    if (!this.available) { this.msg = 'The town service is not reachable from here, so cloud save is not available.'; this.emit(); return; }
    if (!this.st.k) this.st.k = newSecret();
    this.st.on = true;
    this.persist();
    this.setState('waiting');
    const r = await this.sync(true);
    this.msg = r === 'later' ? 'Cloud save is on. It could not reach the service just now and will sync when it can.' : r === 'applied' ? 'Loaded the cloud copy.' : 'Cloud save is on.';
    this.emit();
  }

  syncNow(): Promise<void> {
    this.msg = '';
    return this.sync(true).then((r) => { this.msg = r === 'later' ? 'Could not reach the service. It will keep trying.' : ''; this.emit(); });
  }

  /** A one-time code for another device (ten minutes). */
  async makeCode(): Promise<void> {
    this.msg = '';
    if (!this.on) return;
    // The copy has to exist before a second device can join it.
    if (this.st.rev === 0) { const r = await this.sync(true); if (r === 'later') { this.msg = 'Could not reach the service. Try again in a moment.'; this.emit(); return; } }
    const r = await this.queue(() => this.call('link'));
    if (!r) this.msg = 'Could not reach the service. Try again in a moment.';
    else if (r.s === 200 && typeof r.j.code === 'string') this.code = { c: r.j.code, exp: Date.now() + (typeof r.j.ttl === 'number' ? r.j.ttl : 600) * 1000 };
    else if (r.s === 429) this.msg = 'Too many codes just now. Wait a few minutes.';
    else if (r.s === 409) this.msg = 'The most devices are already linked.';
    else this.msg = 'Could not make a code.';
    this.emit();
  }

  /** Join the copy a code from another device names. */
  async useCode(text: string): Promise<boolean> {
    this.msg = '';
    const code = cleanCode(text);
    if (!code) { this.msg = 'A code is 8 letters and numbers, like K7M2-QX9P.'; this.emit(); return false; }
    if (!this.available) { this.msg = 'The town service is not reachable from here.'; this.emit(); return false; }
    if (!this.st.k) this.st.k = newSecret();
    const r = await this.queue(() => this.call('claim', { code }));
    if (!r) { this.msg = 'Could not reach the service. Try again in a moment.'; this.emit(); return false; }
    if (r.s === 200 && r.j.ok === 1) {
      this.st.on = true; this.st.rev = 0; this.st.wh = 0; this.st.sg = ''; delete this.st.exp; this.persist();
      this.code = null; this.setState('waiting'); this.emit();
      const o = await this.sync(true);
      this.msg = o === 'later' ? 'Linked. It could not read the copy just now and will sync when it can.' : 'Linked. This device now shares that cloud save.';
      this.emit();
      return true;
    }
    this.msg = r.s === 429 ? 'Too many tries. Wait a few minutes and ask for a fresh code.'
      : r.s === 409 ? 'That save already has the most devices linked.'
      : 'That code is not right, or it has expired or been used. Make a new one on the other device.';
    this.emit();
    return false;
  }

  /** Leave the shared copy: this device keeps its progress, the cloud forgets this device (the last one out deletes the copy). */
  async unlink(): Promise<boolean> {
    this.msg = '';
    if (!this.st.k) return true;
    const r = await this.queue(() => this.call('unlink'));
    if (!r || r.s !== 200 || r.j.ok !== 1) { this.msg = 'Could not reach the service, so nothing was changed. Try again in a moment.'; this.emit(); return false; }
    this.st = { on: false, k: '', rev: 0, wh: 0, sg: '', last: 0 };
    this.persist(); this.code = null; this.devices = 0; this._state = 'off';
    this.msg = 'Unlinked. This device keeps its progress; the cloud copy no longer knows it.';
    this.emit();
    return true;
  }

  /** One line for the Settings page. */
  statusLine(): string {
    if (!this.available) return 'Not available here.';
    if (!this.on) return 'Off. Nothing is sent anywhere.';
    const last = this.st.last ? `Last synced ${ago(this.st.last)}` : 'Not synced yet';
    const dev = this.devices > 1 ? ` · shared by ${this.devices} devices` : '';
    switch (this._state) {
      case 'offline': return `${last}${dev}. Offline: it will sync when it can.`;
      case 'busy': return `${last}${dev}. The service is busy; it will try again.`;
      case 'toobig': return `${last}${dev}. This save is too big for the cloud.`;
      case 'newer': return `${last}${dev}. The cloud copy is from a newer version of the game; update this page.`;
      case 'waiting': return `${last}${dev}. Syncing...`;
      default: return `${last}${dev}.`;
    }
  }
}

export const cloud = new CloudSave();
