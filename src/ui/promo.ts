// The promo (fun queue item 20): a pre-rendered 60 s trailer, music baked in, played once per promo edition (or on a
// first visit) the moment the title card's first key or tap starts the game: that gesture is what lets the browser
// play sound. Any key or tap skips it. The video ends on a clean plate; the logo and PRESS ANY KEY are laid over it
// here, as HTML, so they stay sharp at any size. "Watch the trailer" in the pause menu plays it again.
//
// It never stands in the way of play: the file is fetched in the background while the title card is up, and if it
// has not loaded enough by the time the game starts, or fails, or the browser refuses to play it, the game simply
// starts (and it is offered again next visit). Phones and small screens get the 720p file.
//
// Files: public/promo/promo_1080.mp4 and promo_720.mp4 (made by tools/promo/, see tools/promo/storyboard.json).
// `?promo=URL` plays another file (testing a cut), `?promo=0` never plays it, `?promo=1` plays it even if seen.

import type { Game } from '../core/game';
import { MUSIC_CREDIT } from '../core/credits';

/** Bump when a new promo is cut: everyone sees it once more. */
export const PROMO_EDITION = 'promo-1';
/** When the music's final hit lands (seconds): the logo card comes up on it (storyboard.json music.hit). */
const HIT = 54.75;
const KEY = 'pc-promo-seen';
/** The longest a first start waits for the trailer to arrive before the game simply goes on. */
const WAIT_MS = 5000;

const CSS = `
.pr-root { position: fixed; inset: 0; z-index: 9000; background: #000; opacity: 0; transition: opacity .35s; display: flex;
  align-items: center; justify-content: center; cursor: none; }
.pr-root.on { opacity: 1; }
.pr-root video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.pr-end { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1.2vmin; opacity: 0; transition: opacity .6s; pointer-events: none; text-align: center; color: var(--bone, #f2e8cf);
  text-shadow: 0 .4vmin 2vmin rgba(0,0,0,.6); }
.pr-end.on { opacity: 1; }
.pr-tab { font: 700 clamp(10px, 1.6vmin, 16px) var(--f-mono, monospace); letter-spacing: .2em; text-transform: uppercase; }
.pr-name { font: 800 clamp(40px, 13vmin, 150px)/.9 var(--f-head, 'Arial Narrow', sans-serif); letter-spacing: .02em; text-transform: uppercase;
  color: var(--bone, #f2e8cf); border: .6vmin solid var(--bone, #f2e8cf); padding: .2em .35em .1em; background: rgba(20,33,61,.55); }
.pr-key { margin-top: 3vmin; font: 700 clamp(14px, 3vmin, 30px) var(--f-head, 'Arial Narrow', sans-serif); letter-spacing: .3em;
  color: var(--mustard, #f0a202); animation: pr-blink 1.1s steps(2, start) infinite; }
.pr-credit { position: absolute; bottom: 2.5vmin; left: 0; right: 0; font: 500 clamp(9px, 1.5vmin, 14px) var(--f-text, sans-serif); opacity: .75; }
.pr-skip { position: absolute; right: 2.5vmin; bottom: 2.5vmin; font: 700 clamp(9px, 1.5vmin, 13px) var(--f-mono, monospace);
  letter-spacing: .15em; color: rgba(242,232,207,.6); text-transform: uppercase; }
.pr-end.on ~ .pr-skip { display: none; }
@keyframes pr-blink { to { visibility: hidden; } }
.mn-btn.pr-menu { margin-left: .5em; }
`;

type Core = { master: GainNode };

export class Promo {
  /** For the tests: plays started, skipped, finished, and why the last chance was passed up. */
  readonly stats = { played: 0, skipped: 0, finished: 0, passed: '' };
  private video: HTMLVideoElement | null = null;
  private root: HTMLElement | null = null;
  private end: HTMLElement | null = null;
  private game: Game | null = null;
  private open = false;
  private wasFrozen = false;
  private gain = 1;
  private readonly param = new URLSearchParams(location.search).get('promo');

  /** The game exists: preload if it will be wanted, and play it when the title card starts the game. */
  attach(game: Game): void {
    this.game = game;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    if (this.wanted()) this.preload();
    game.on('start', () => {
      if (!this.wanted()) return;
      // Still inside the key or tap that started the game: the browser lets the sound play.
      this.play(true);
    });
    this.watchMenu();
  }

  /** Play it now (the menu's "Watch the trailer"). */
  replay(): void { this.play(false); }

  private wanted(): boolean {
    if (this.param === '0') return false;
    // Automated browsers (the test harness) never get it unless asked for: it would hold their frozen clock.
    if (navigator.webdriver && !this.param) return false;
    if (this.param && this.param !== '1') return true;
    if (this.param === '1') return true;
    try { return localStorage.getItem(KEY) !== PROMO_EDITION; } catch { return true; }
  }

  /** The files to try, best first: VP9 WebM where the browser plays it (smaller), then H.264 MP4 (plays everywhere). */
  private sources(): string[] {
    if (this.param && this.param !== '0' && this.param !== '1') return [this.param];
    const small = matchMedia('(pointer: coarse)').matches || Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1) < 1600;
    const base = `${import.meta.env.BASE_URL}promo/promo_${small ? 720 : 1080}`;
    const probe = document.createElement('video');
    return [...(probe.canPlayType('video/webm; codecs="vp9, opus"') ? [`${base}.webm`] : []), `${base}.mp4`];
  }

  private preload(): HTMLVideoElement {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    const list = this.sources();
    v.src = list.shift() ?? '';
    // A file that fails hands over to the next; when none is left the trailer is passed up (and the game plays on).
    v.addEventListener('error', () => {
      const next = list.shift();
      if (next && !this.open) { v.src = next; v.load(); return; }
      this.stats.passed = `the file failed to load (${v.error?.code ?? '?'} ${v.error?.message ?? ''} ${v.currentSrc})`;
      this.close(false);
    });
    v.load();
    this.video = v;
    return v;
  }

  private play(first: boolean): void {
    if (this.open || !this.game) return;
    const v = this.preload();
    if (v.error) { this.stats.passed = `the file failed to load (${v.error?.code ?? '?'} ${v.error?.message ?? ''} ${v.currentSrc})`; return; }
    // Not enough of it here yet (on a first visit the game's own downloads share the line): a black screen for at most
    // WAIT_MS while it arrives, which any key or tap skips like the trailer itself; then it plays or is passed up
    // (and offered again next visit). The tap has given the page its user activation, so the sound may start later.
    const ready = v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    this.build(v);
    this.open = true;
    this.wasFrozen = this.game.frozen;
    this.game.frozen = true;
    this.duck(true);
    v.muted = false;
    requestAnimationFrame(() => this.root?.classList.add('on'));
    const go = (): void => {
      if (!this.open) return;
      v.currentTime = 0;
      this.stats.played++;
      v.play().catch(() => { this.stats.passed = 'the browser would not play it'; this.close(false); });
    };
    if (ready) { go(); return; }
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; this.stats.passed = `not loaded in time (readyState ${v.readyState})`; this.close(false); }, first ? WAIT_MS : WAIT_MS * 3);
    v.addEventListener('canplay', () => { if (done) return; done = true; clearTimeout(t); go(); }, { once: true });
  }

  private build(v: HTMLVideoElement): void {
    if (this.root) { this.root.style.display = ''; this.end?.classList.remove('on'); return; }
    const r = document.createElement('div');
    r.className = 'pr-root';
    r.innerHTML = `<div class="pr-end"><div class="pr-tab">Harbor Authority of Port Calamity</div><div class="pr-name">Port Calamity</div>
      <div class="pr-key">PRESS ANY KEY</div><div class="pr-credit"></div></div><div class="pr-skip">Any key to skip</div>`;
    r.insertBefore(v, r.firstChild);
    (r.querySelector('.pr-credit') as HTMLElement).textContent = MUSIC_CREDIT;
    this.end = r.querySelector('.pr-end');
    v.addEventListener('timeupdate', () => { if (v.currentTime >= HIT) this.end?.classList.add('on'); });
    // The last frame stays up under the card until a key: the video ends on the clean plate by design.
    v.addEventListener('ended', () => { this.end?.classList.add('on'); this.stats.finished++; });
    document.body.appendChild(r);
    this.root = r;
    // Any key or tap ends it. Taken at the window before anything else, so the skip key does nothing in the game.
    const skip = (e: Event): void => {
      if (!this.open) return;
      if (e instanceof KeyboardEvent && (e.ctrlKey || e.metaKey || e.altKey || /^(F\d+|Tab|Meta|Control|Alt|Shift|CapsLock)/.test(e.key))) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!this.video?.ended && (this.video?.currentTime ?? 0) < HIT) this.stats.skipped++;
      this.close(this.stats.played > 0);
    };
    addEventListener('keydown', skip, true);
    addEventListener('pointerdown', skip, true);
  }

  private close(seen: boolean): void {
    if (seen) { try { localStorage.setItem(KEY, PROMO_EDITION); } catch { /* private window */ } }
    if (!this.open) return;
    this.open = false;
    const v = this.video, r = this.root;
    if (this.game) this.game.frozen = this.wasFrozen;
    this.duck(false);
    r?.classList.remove('on');
    setTimeout(() => { if (!this.open) { v?.pause(); if (r) r.style.display = 'none'; } }, 380);
  }

  /** The game's own sound goes quiet under the trailer and comes back after. */
  private duck(on: boolean): void {
    const core = (this.game as unknown as { audio?: { core?: Core } } | null)?.audio?.core;
    if (!core) return;
    const g = core.master.gain, t = core.master.context.currentTime;
    if (on) this.gain = g.value;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(on ? 0 : this.gain, t, 0.12);
  }

  /** The pause menu's footer gets a "Watch the trailer" button, added whenever the menu is built. */
  private watchMenu(): void {
    const add = (): void => {
      const ft = document.querySelector('.mn-ft');
      if (!ft || ft.querySelector('.pr-menu')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mn-btn pr-menu';
      b.textContent = 'Watch the trailer';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.replay(); });
      ft.appendChild(b);
    };
    // The menu is built when the game first pauses; look for its footer then (not on every change to the page).
    this.game?.on('pause', () => setTimeout(add, 0));
    add();
  }
}

export const promo = new Promo();
