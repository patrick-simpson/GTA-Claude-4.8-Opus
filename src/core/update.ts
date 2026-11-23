// "A new edition is in": the build stamps dist/version.json and bakes the same id into the bundle (vite.config.ts).
// The running game asks for the stamp every minute, when the tab comes back, and when the multiplayer socket is
// welcomed again; a different id means the site was republished, so the game is saved, a notice goes up, and the page
// reloads onto the new files. Nothing happens on localhost, the dev server, or with ?noupdate=1.

import { save } from '../game/save';
import type { Game } from './game';

declare const __BUILD_ID__: string | undefined;

const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
const POLL_MS = 60_000;
const NOTICE_MS = 2000;
const KEY = 'pc-update';
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
  const prior = tried();
  if (prior && prior.id === BUILD) { try { sessionStorage.removeItem(KEY); } catch { /* fine */ } }
  let going = false, busy = false;

  const check = async (): Promise<void> => {
    if (going || busy) return;
    busy = true;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const id = String(((await res.json()) as { id?: unknown }).id ?? '');
      if (!id || id === BUILD) return;
      const t = tried();
      if (t && t.id === id && Date.now() - t.at < backoff(t.n)) return;
      going = true;
      try { save.write(); } catch { /* play on */ }
      try { sessionStorage.setItem(KEY, JSON.stringify({ id, n: t && t.id === id ? t.n + 1 : 1, at: Date.now() })); } catch { /* fine */ }
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
