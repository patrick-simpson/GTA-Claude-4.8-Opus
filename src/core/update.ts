// "A new edition is in": the build stamps dist/version.json and bakes the same id into the bundle (vite.config.ts).
// The running game asks for the stamp every minute, when the tab comes back, and when the multiplayer socket is
// welcomed again; a different id means the site was republished, so the game is saved, a notice goes up, and the page
// reloads onto the new files. Nothing happens on localhost, the dev server, or with ?noupdate=1.
//
// GitHub Pages' CDN ignores query strings and different edges can answer with different (older) stamps for a while,
// so a stamp is trusted only when the SAME new id comes back twice in a row, the second time at least 30 s after the
// first (a re-check is scheduled for that). An id this browser has already run, or saw before this page loaded, is
// never a reason to reload: that is an old edition served by a lagging edge.
//
// After the reload (and the first time a returning player opens a build this browser has not run), a big "WHAT'S NEW"
// card shows this build's title and notes, baked in from its commit message (vite.config.ts). Once per build, never on
// a first visit, gone on a click, tap, Esc or after 20 s.

import { save } from '../game/save';
import type { Game } from './game';

declare const __BUILD_ID__: string | undefined;
declare const __BUILD_NEWS__: { title: string; notes: string } | undefined;

const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
const NEWS: { title: string; notes: string } = typeof __BUILD_NEWS__ === 'object' && __BUILD_NEWS__ ? __BUILD_NEWS__ : { title: '', notes: '' };
const POLL_MS = 60_000;
/** The "what's new" card goes by itself after this long. */
const NEWS_MS = 20_000;
/** The build whose card this browser has shown (never twice). */
const NEWS_KEY = 'pc-news';
/** The save's key (game/save.ts): a browser with a save has played before. */
const SAVE_KEY = 'portcalamity.save.v1';
/** A new id must be seen again at least this long after it was first seen. */
const CONFIRM_MS = 30_000;
const NOTICE_MS = 2000;
const KEY = 'pc-update';
/** Ids this browser has run (localStorage, newest last, a few kept). */
const SEEN_KEY = 'pc-builds';
const SEEN_MAX = 12;
/** Wait before the next reload attempt for the same stamp (the CDN can lag): 15 s, doubling, up to 4 min. */
const backoff = (n: number): number => Math.min(240_000, 15_000 * 2 ** Math.max(0, n - 1));

interface Tried { id: string; n: number; at: number }

function wanted(): boolean {
  if (!BUILD) return false;
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '' || h.endsWith('.local')) return false;
    if (new URLSearchParams(location.search).get('noupdate') === '1') return false;
  } catch { return false; }
  return true;
}

function tried(): Tried | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Tried | null; } catch { return null; }
}

/** The ids seen before this page loaded (this build is then added to the stored list), and whether this browser has played before. */
function rememberBuild(): { before: Set<string>; returning: boolean } {
  let list: string[] = [];
  let stored = false;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    stored = raw !== null;
    const v = JSON.parse(raw ?? '[]') as unknown;
    if (Array.isArray(v)) list = v.filter((x): x is string => typeof x === 'string');
  } catch { /* fine */ }
  // (A player from before this list existed has a save; a first visit has neither.)
  let returning = list.length > 0;
  if (!stored) { try { returning = localStorage.getItem(SAVE_KEY) !== null; } catch { /* fine */ } }
  const before = new Set(list);
  try {
    const next = list.filter((x) => x !== BUILD);
    next.push(BUILD);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next.slice(-SEEN_MAX)));
  } catch { /* fine */ }
  return { before, returning };
}

/** "WHAT'S NEW": a big card over the game, from this build's own commit message (vite.config.ts). */
function whatsNew(): void {
  const title = NEWS.title.trim();
  if (!title) return;
  const el = document.createElement('div');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', "What's new");
  el.className = 'pc-news';
  el.style.cssText = 'position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(20,33,61,.82);padding:16px;box-sizing:border-box;cursor:pointer;';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(36em,100%);max-height:calc(100% - 8px);overflow:auto;box-sizing:border-box;'
    + 'background:var(--bone,#f2e8cf);color:var(--ink,#14213d);border:3px double var(--ink,#14213d);'
    + 'box-shadow:0 0 0 6px var(--bone,#f2e8cf),0 18px 50px rgba(0,0,0,.5);padding:clamp(16px,4vw,30px) clamp(16px,4.5vw,36px);';
  const head = document.createElement('div');
  head.textContent = "WHAT'S NEW";
  head.style.cssText = 'font:700 clamp(13px,3.4vw,16px) var(--f-mono,monospace);letter-spacing:.22em;color:var(--red,#c1121f);'
    + 'border-bottom:2px solid var(--ink,#14213d);padding-bottom:8px;margin-bottom:14px;';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font:700 clamp(21px,5.4vw,32px)/1.15 var(--f-head,sans-serif);text-transform:uppercase;letter-spacing:.03em;margin-bottom:12px;';
  card.append(head, h);
  for (const para of NEWS.notes.split(/\n\s*\n/)) {
    const t = para.replace(/\s*\n\s*/g, ' ').trim();
    if (!t) continue;
    const p = document.createElement('p');
    p.textContent = t;
    p.style.cssText = 'margin:0 0 10px;font:400 clamp(15px,3.9vw,18px)/1.45 var(--f-body,Georgia,serif);';
    card.append(p);
  }
  const foot = document.createElement('div');
  foot.textContent = 'Tap, click or press Esc to carry on';
  foot.style.cssText = 'margin-top:14px;font:700 12px var(--f-mono,monospace);letter-spacing:.14em;text-transform:uppercase;opacity:.7;';
  card.append(foot);
  el.append(card);
  let timer = 0;
  const close = (e?: Event): void => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    clearTimeout(timer);
    el.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(e); };
  el.addEventListener('pointerdown', close);
  window.addEventListener('keydown', onKey, true);
  timer = window.setTimeout(close, NEWS_MS);
  document.body.append(el);
}

function notice(): void {
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(20,33,61,.94);color:var(--bone,#f2e8cf);text-align:center;padding:24px;';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:30em;border:3px double var(--bone,#f2e8cf);padding:28px 32px;background:rgba(242,232,207,.06);';
  const head = document.createElement('div');
  head.textContent = 'NOTICE OF NEW EDITION';
  head.style.cssText = "font:700 15px var(--f-mono,monospace);letter-spacing:.18em;color:var(--mustard,#f0a202);margin-bottom:14px;";
  const body = document.createElement('div');
  body.textContent = 'New edition of Port Calamity is in. Refiling you now.';
  body.style.cssText = "font:700 clamp(22px,5vw,34px) var(--f-head,sans-serif);text-transform:uppercase;letter-spacing:.04em;";
  card.append(head, body);
  el.append(card);
  document.body.append(el);
}

export function watchForUpdates(game: Game): void {
  if (!wanted()) return;
  const { before: old, returning } = rememberBuild();
  // A returning player on a build this browser has not run before (after an update reload, or back after a while):
  // the card, once per build. Never on a first visit.
  if (returning && !old.has(BUILD)) {
    let shown = '';
    try { shown = localStorage.getItem(NEWS_KEY) ?? ''; } catch { /* fine */ }
    if (shown !== BUILD) {
      try { localStorage.setItem(NEWS_KEY, BUILD); } catch { /* fine */ }
      whatsNew();
    }
  }
  old.add(BUILD);
  const prior = tried();
  if (prior && prior.id === BUILD) { try { sessionStorage.removeItem(KEY); } catch { /* fine */ } }
  let going = false, busy = false;
  /** A new id seen once and waiting to be seen again. */
  let pending: { id: string; at: number } | null = null;
  let recheck = 0;

  const check = async (): Promise<void> => {
    if (going || busy) return;
    busy = true;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const id = String(((await res.json()) as { id?: unknown }).id ?? '');
      if (!id || old.has(id)) { pending = null; return; }
      const now = Date.now();
      if (!pending || pending.id !== id) {
        // First sighting (or a different one than last time): look again in 30 s.
        pending = { id, at: now };
        clearTimeout(recheck);
        recheck = window.setTimeout(() => { void check(); }, CONFIRM_MS + 500);
        return;
      }
      if (now - pending.at < CONFIRM_MS) return;
      const t = tried();
      if (t && t.id === id && now - t.at < backoff(t.n)) return;
      going = true;
      try { save.write(); } catch { /* play on */ }
      try { sessionStorage.setItem(KEY, JSON.stringify({ id, n: t && t.id === id ? t.n + 1 : 1, at: now })); } catch { /* fine */ }
      notice();
      setTimeout(() => {
        // A fresh address makes the browser ask for index.html again (and so for the new hashed scripts).
        const u = new URL(location.href);
        u.searchParams.set('v', id);
        location.replace(u.toString());
      }, NOTICE_MS);
    } catch { /* offline: try again next time */ } finally { busy = false; }
  };

  setInterval(() => { void check(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  const conn = game.net?.conn;
  if (conn) {
    const was = conn.onWelcome;
    conn.onWelcome = (m) => { was(m); void check(); };
  }
  void check();
}
