// The pause menu: a Harbor Authority dossier on the applicant, with tabs.
//
//   MAP       the whole world as a nautical chart: both lands, the bridge as far as it is built, street and
//             district names, who has work, the races and ramps, the ducks already found. Drag, wheel, pinch,
//             arrow keys or the left stick to move about; click, tap, Enter or (A) to set a waypoint, which
//             draws a route on the radar.
//   PROGRESS  the bridge, the town, the missions, the ducks and the jumps, as a filled-in form
//   STATS     what she has done, ending with "Mistakes made: 0*"
//   SETTINGS  look speed, invert Y, quality, full screen on tap, reduced motion sound volumes
//   CONTROLS  keyboard, gamepad, touch
//
// It replaces the M1 pause card (menu.css hides it). Flat paperwork; the only
// animation is opacity and transform.

import { STREETS_NEW } from '../world/streets';
import { trains } from '../world/train';
import './menu.css';
import type { Game } from '../core/game';
import type { ThingsToDo } from '../game/index';
import { DISTRICT_NAME, EW_NAMES, NS_NAMES, RAMPS, XS, ZS, BRIDGE } from '../world/plan';
import type { District } from '../world/plan';
import { BRIDGE_SPANS } from '../world/plan';
import { STAGES, goalOf, progress } from '../world/progress';
import { STAGE_NAMES } from '../world/mainland';
import { money } from '../core/util';
import { DUCKS } from '../game/activities';
import { clock } from '../game/script';
import { save, type QualityPick } from '../game/save';
import { season, type SeasonPick } from '../world/season';
import { holiday, type HolidayPick } from '../world/holiday';
import { autoPresetIfKnown } from '../core/governor';
import { kid } from '../core/kid';
import { VOICE_CREDIT } from '../audio/voices';
import { MAP_CREDIT } from '../core/credits';
import { PEER_COLOR } from '../net/names';
import { PARDONS_AT, PARDONS_RED } from './hud';
import { Wardrobe } from './wardrobe';
import { PlacesPanel } from './places';
import { CAT_COLOR } from '../world/shopSigns';
import type { Place } from '../world/business';
import { boardHtml } from '../game/leaderboard';

const INK = '#14213d', BONE = '#f2e8cf', VERMILION = '#e4572e', MUSTARD = '#f0a202', TEAL = '#2a9d8f';
type VolKey = 'volMaster' | 'volMusic' | 'volSfx' | 'volAmbience';
const TABS = ['Map', 'Progress', 'Stats', 'Settings', 'Controls', 'Wardrobe'] as const;
const RAMP_NAMES = ['Low Tide Beach', 'The container yard', 'The park pond', 'The arena lot', 'The cannery', 'Pelican Pier', 'The end of the bridge'];
const MILE = 1609.344, MPH = 2.23694, FEET = 3.28084;

const CONTROLS: [string, string, string, string][] = [
  ['Move / steer', 'W A S D', 'Left stick', 'Left thumb'],
  ['Look', 'Mouse', 'Right stick', 'Drag the picture'],
  ['Gas / brake', 'W / S', 'RT / LT', 'GAS / BRAKE'],
  ['Sprint', 'Shift', 'L3', 'Push the stick to its edge'],
  ['Jump / handbrake', 'Space', 'A / B', 'JUMP / HAND BRAKE'],
  ['Get in or out', 'F', 'Y', 'GET IN / EXIT'],
  ['Talk, start a job, pay', 'G', 'D-pad right', 'USE'],
  ['Fire / aim', 'LMB / RMB', 'RT / LT', 'FIRE / AIM'],
  ['Switch / reload', 'Q E / R', 'LB RB / X', 'SWAP'],
  ['Horn', 'H', 'D-pad down', 'HORN'],
  ['Emotes, dances, horn tunes', 'Hold N', '', 'EMOTE'],
  ['Quick chat and map pings', 'Hold Y', '', 'CHAT'],
  ['Radio: next station', 'T', 'D-pad up', 'RADIO'],
  ['Camera / look back', 'V / C', 'D-pad left / R3', 'CAMERA'],
  ['Replay the last 10 s', 'J', '', 'REPLAY'],
  ['Photo mode', 'O', '', 'PHOTO'],
  ['Map', 'M or Tab', 'Back', 'Pause, then MAP'],
  ['Pause', 'Esc or P', 'Start', 'Pause key'],
  ['Unstick', 'Hold Backspace', '', ''],
];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const boxes = (n: number, of: number): string => { let s = ''; for (let i = 0; i < of; i++) s += `<i class="${i < n ? 'on' : ''}"></i>`; return `<span class="mn-boxes">${s}</span>`; };

export class Menu {
  open = false;
  tab = 0;
  private readonly root: HTMLElement;
  private readonly panes: HTMLElement[] = [];
  private readonly tabBtns: HTMLElement[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly confirmEl: HTMLElement;
  // The chart view: world point at the middle of the canvas, and CSS pixels per meter.
  private cx = 0; private cz = -700; private k = 0.2;
  private fitted = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = 0; private pinch = 0;
  private cross = false;
  private sea = '';
  private raf = 0;
  private padPrev: boolean[] = [];
  private padT = 0;
  private readonly labels: { text: string; x: number; z: number; vert: boolean }[] = [];
  private readonly districts: { text: string; x: number; z: number }[] = [];
  /** The Wardrobe page (ui/wardrobe.ts): the player's own look and car. */
  readonly wardrobe: Wardrobe;
  /** The Places panel on the map (ui/places.ts). */
  private readonly placesPanel: PlacesPanel;

  constructor(private readonly game: Game, private readonly todo: ThingsToDo) {
    const root = document.createElement('div');
    root.id = 'menu';
    root.innerHTML = `
<div class="mn-card">
  <div class="mn-hd"><span class="mn-lbl">Harbor Authority of Port Calamity</span><span class="mn-lbl">Dossier M-4 · MARLOWE, O. · Paused</span></div>
  <div class="mn-tabs" role="tablist">${TABS.map((t, i) => `<button type="button" class="mn-tab" role="tab" data-tab="${i}"><small>${i + 1}</small>${t}</button>`).join('')}</div>
  <div class="mn-body">
    <section class="mn-pane mn-map"><canvas></canvas>
      <div class="mn-maphelp mn-lbl">Drag to move · wheel or pinch to zoom · click to set a waypoint · click it again to clear</div>
    </section>
    <section class="mn-pane mn-scroll"></section>
    <section class="mn-pane mn-scroll"></section>
    <section class="mn-pane mn-scroll"></section>
    <section class="mn-pane mn-scroll"></section>
    <section class="mn-pane mn-scroll mn-wd"></section>
  </div>
  <div class="mn-ft"><button type="button" class="mn-btn mn-resume">Resume</button><span class="mn-or">or press Esc</span><button type="button" class="mn-btn mn-new">New game</button></div>
</div>
<div class="mn-confirm">
  <div class="mn-slip">
    <div class="mn-lbl">Form X-0 · Request to shred</div>
    <div class="mn-confirm-t">NEW GAME?</div>
    <p>This shreds the whole file: money, weapons, missions, ducks, jumps, statistics, and <b>every span of the bridge</b>. Tepid Falls closes again. Settings are kept. It cannot be undone.</p>
    <div class="mn-confirm-ft"><button type="button" class="mn-btn mn-keep">Keep my file</button><button type="button" class="mn-btn mn-shred">Shred it all</button></div>
  </div>
</div>`;
    document.body.appendChild(root);
    this.root = root;
    this.panes = Array.from(root.querySelectorAll<HTMLElement>('.mn-pane'));
    this.tabBtns = Array.from(root.querySelectorAll<HTMLElement>('.mn-tab'));
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.confirmEl = root.querySelector('.mn-confirm') as HTMLElement;
    this.buildLabels();
    this.wardrobe = new Wardrobe(game, () => { this.tab = TABS.indexOf('Wardrobe'); game.setPaused(true); });

    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement, tab = t.closest<HTMLElement>('.mn-tab');
      if (tab) { this.setTab(Number(tab.dataset.tab)); return; }
      if (t.closest('.mn-resume')) { this.resume(); return; }
      if (t.closest('.mn-new')) { this.confirmEl.classList.add('on'); (root.querySelector('.mn-keep') as HTMLElement).focus(); return; }
      if (t.closest('.mn-keep')) { this.confirmEl.classList.remove('on'); return; }
      if (t.closest('.mn-shred')) { this.confirmEl.classList.remove('on'); todo.newGame(); this.resume(); return; }
      const set = t.closest<HTMLElement>('[data-set]');
      if (set) this.onSetting(set);
    });
    root.addEventListener('input', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-set]'); if (t) this.onSetting(t); });
    addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('resize', () => { if (this.open) { this.fitted = false; this.drawMap(); } });
    this.bindMap();
    this.placesPanel = new PlacesPanel(root.querySelector('.mn-map') as HTMLElement, game, todo, {
      focus: (x, z, k) => { this.fit0(); this.k = Math.max(this.k, k); this.clampView(); this.cx = x; this.cz = z; this.clampView(); this.cross = false; },
      redraw: () => this.drawMap(),
    });
    game.on('pause', (e) => { if (e.on) this.show(); else this.hide(); });
  }

  // ── Opening and closing ────────────────────────────────────────────────────

  private show(): void {
    this.open = true;
    this.root.classList.add('on');
    this.root.classList.toggle('touch', this.game.input.touch);
    this.confirmEl.classList.remove('on');
    this.setTab(this.tab);
    const loop = (): void => { if (!this.open) return; this.raf = requestAnimationFrame(loop); this.pollPad(); };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  private hide(): void {
    this.open = false;
    this.root.classList.remove('on', 'wd');
    this.wardrobe.hide();
    cancelAnimationFrame(this.raf);
  }

  private resume(): void {
    this.game.setPaused(false);
    if (!this.game.input.touch) this.game.input.lock();
  }

  setTab(i: number): void {
    this.tab = (i + TABS.length) % TABS.length;
    this.tabBtns.forEach((b, k) => { b.classList.toggle('on', k === this.tab); b.setAttribute('aria-selected', String(k === this.tab)); });
    this.panes.forEach((p, k) => p.classList.toggle('on', k === this.tab));
    const wd = this.tab === TABS.indexOf('Wardrobe');
    this.root.classList.toggle('wd', wd && this.open);
    if (!this.open) return;
    if (!wd) this.wardrobe.hide();
    if (wd) this.wardrobe.show(this.panes[this.tab]);
    else if (this.tab === 0) { if (!this.fitted) this.fit(); this.drawMap(); this.placesPanel.refresh(); }
    else if (this.tab === 1) this.panes[1].innerHTML = this.progressHtml();
    else if (this.tab === 2) this.panes[2].innerHTML = this.statsHtml();
    else if (this.tab === 3) this.panes[3].innerHTML = this.settingsHtml();
    else if (this.tab === 4) this.panes[4].innerHTML = this.controlsHtml();
  }

  // ── Keys and pad ───────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (this.confirmEl.classList.contains('on')) { if (e.code === 'Escape') { this.confirmEl.classList.remove('on'); e.stopImmediatePropagation(); } return; }
    const d = /^Digit([1-5])$/.exec(e.code);
    if (d) { this.setTab(Number(d[1]) - 1); return; }
    if (e.code === 'BracketLeft') { this.setTab(this.tab - 1); return; }
    if (e.code === 'BracketRight') { this.setTab(this.tab + 1); return; }
    if (this.tab !== 0) return;
    const step = 60 / this.k / 4;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': this.cx -= step; break;
      case 'ArrowRight': case 'KeyD': this.cx += step; break;
      case 'ArrowUp': case 'KeyW': this.cz -= step; break;
      case 'ArrowDown': case 'KeyS': this.cz += step; break;
      case 'Equal': case 'NumpadAdd': this.zoom(1.25); break;
      case 'Minus': case 'NumpadSubtract': this.zoom(0.8); break;
      case 'Enter': case 'Space': this.setWay(this.cx, this.cz); break;
      case 'Backspace': case 'Delete': this.todo.waypoint = null; break;
      default: return;
    }
    e.preventDefault();
    this.cross = true;
    this.drawMap();
  }

  private pollPad(): void {
    let pad: Gamepad | null = null;
    for (const p of navigator.getGamepads ? navigator.getGamepads() : []) if (p && p.connected) { pad = p; break; }
    if (!pad) return;
    const b = pad.buttons.map((x) => x.pressed), hit = (i: number): boolean => !!b[i] && !this.padPrev[i];
    const confirming = this.confirmEl.classList.contains('on');
    if (confirming) {
      if (hit(1)) this.confirmEl.classList.remove('on');
      if (hit(0)) (document.activeElement as HTMLElement | null)?.click?.();
      if (hit(14) || hit(15)) { const a = this.root.querySelector('.mn-keep') as HTMLElement, s = this.root.querySelector('.mn-shred') as HTMLElement; (document.activeElement === a ? s : a).focus(); }
    } else {
      if (hit(4)) this.setTab(this.tab - 1);
      if (hit(5)) this.setTab(this.tab + 1);
      if (hit(1)) this.resume();
      if (this.tab === 0) {
        const ax = Math.abs(pad.axes[0]) > 0.2 ? pad.axes[0] : 0, az = Math.abs(pad.axes[1]) > 0.2 ? pad.axes[1] : 0;
        const zin = pad.buttons[7]?.value ?? 0, zout = pad.buttons[6]?.value ?? 0;
        if (ax || az || zin > 0.1 || zout > 0.1) {
          this.cx += (ax * 9) / this.k; this.cz += (az * 9) / this.k;
          this.zoom(1 + (zin - zout) * 0.03);
          this.cross = true;
          this.drawMap();
        }
        if (hit(0)) { this.setWay(this.cx, this.cz); this.cross = true; this.drawMap(); }
        if (hit(2)) { this.todo.waypoint = null; this.drawMap(); }
      } else {
        // Up and down walk the controls on the page; left and right change the one in hand; A presses it.
        const els = Array.from(this.panes[this.tab].querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')).concat(Array.from(this.root.querySelectorAll<HTMLElement>('.mn-ft .mn-btn')));
        const at = els.indexOf(document.activeElement as HTMLElement);
        const now = performance.now();
        if ((hit(12) || hit(13)) && els.length) els[(at + (hit(13) ? 1 : els.length - 1) + (at < 0 && hit(12) ? 1 : 0)) % els.length].focus();
        const el = document.activeElement as HTMLInputElement | null;
        if (el && el.tagName === 'INPUT' && (b[14] || b[15]) && now - this.padT > 90) {
          this.padT = now;
          el.value = String(Number(el.value) + (b[15] ? 1 : -1) * Number(el.step || 1));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (hit(0) && el && el.tagName === 'BUTTON') el.click();
        const sc = this.panes[this.tab];
        if (Math.abs(pad.axes[3] ?? 0) > 0.25) sc.scrollTop += (pad.axes[3] ?? 0) * 14;
      }
    }
    this.padPrev = b;
  }

  // ── MAP ────────────────────────────────────────────────────────────────────

  private buildLabels(): void {
    const plan = this.game.plan;
    for (let i = 0; i < XS.length; i++) this.labels.push({ text: NS_NAMES[i], x: XS[i], z: (ZS[4] + ZS[5]) / 2 + (i % 2 ? 100 : 0), vert: true });
    for (let j = 0; j < ZS.length; j++) this.labels.push({ text: EW_NAMES[j], x: (XS[2] + XS[3]) / 2 + (j % 2 ? 240 : 0), z: ZS[j], vert: false });
    // The mainland: each street name once, on its longest stretch.
    const best = new Map<string, { len: number; x: number; z: number; vert: boolean }>();
    const S = plan.streets;
    if (S) {
      // New streets: the midpoint of the longest stretch, running up the page if it runs mostly north-south.
      for (const e of S.edges.slice(S.isle.edges)) {
        if (e.deck || !e.pts || e.kind === 'ramp') continue;
        const old = best.get(e.name);
        if (old && e.len <= old.len) continue;
        const m = S.pointAt(e, e.len / 2);
        best.set(e.name, { len: e.len, x: m.x, z: m.z, vert: Math.abs(m.dz) > Math.abs(m.dx) });
      }
    } else for (const e of plan.edges) {
      if (e.land !== 1 || e.deck) continue;
      const a = plan.nodes[e.a], b = plan.nodes[e.b], old = best.get(e.name);
      if (!old || e.len > old.len) best.set(e.name, { len: e.len, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, vert: !e.horiz });
    }
    for (const [text, v] of best) this.labels.push({ text, x: v.x, z: v.z, vert: v.vert });
    const sum = new Map<District, { x: number; z: number; n: number }>();
    for (const b of plan.streets ? plan.blocks.slice(0, plan.isle.blocks) : plan.blocks) {
      const s = sum.get(b.district) ?? { x: 0, z: 0, n: 0 };
      s.x += (b.rect.x0 + b.rect.x1) / 2; s.z += (b.rect.z0 + b.rect.z1) / 2; s.n++;
      sum.set(b.district, s);
    }
    for (const [d, s] of sum) this.districts.push({ text: DISTRICT_NAME[d], x: s.x / s.n, z: s.z / s.n });
    // New mainland: a district's name sits on its biggest block, so it lands on its own ground.
    if (plan.streets) {
      const big = new Map<string, { a: number; x: number; z: number }>();
      for (const b of plan.streets.blocks) {
        if (b.open || !b.district) continue;
        const o = big.get(b.district);
        if (!o || b.area > o.a) big.set(b.district, { a: b.area, x: b.cx, z: b.cz });
      }
      for (const [d, v] of big) this.districts.push({ text: DISTRICT_NAME[d as District], x: v.x, z: v.z });
    }
  }

  private size(): { w: number; h: number; dpr: number } {
    const c = this.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth || 600, h = c.clientHeight || 400;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    return { w, h, dpr };
  }

  /** Start on the player with a few blocks round her; the whole world is two notches of the wheel out. */
  private fit(): void {
    const { w, h } = this.size(), p = this.game.player;
    this.fitted = true;
    this.k = Math.min(w, h) / 1500;
    this.cx = p.x; this.cz = p.z;
    this.clampView();
  }

  /** The map has been sized once, whichever way it was first opened. */
  private fit0(): void { if (!this.fitted) this.fit(); }

  /** The business marker under a point of the map, if any (markers show from a middling zoom). */
  private placeAt(px: number, py: number): Place | null {
    if (this.k < 0.42) return null;
    const { w, h } = this.size();
    let best: Place | null = null, bd = 13;
    for (const b of this.placesPanel.all()) {
      const d = Math.hypot(w / 2 + (b.x - this.cx) * this.k - px, h / 2 + (b.z - this.cz) * this.k - py);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private clampView(): void {
    const b = this.game.plan.bounds, { w, h } = this.size();
    this.k = Math.max(Math.min(w / (b.x1 - b.x0), h / (b.z1 - b.z0)) * 0.94, Math.min(3, this.k));
    // Never more than a margin of open paper: pulled all the way out, the world sits in the middle.
    const hx = w / 2 / this.k - 60 / this.k, hz = h / 2 / this.k - 60 / this.k;
    this.cx = b.x1 - b.x0 <= hx * 2 ? (b.x0 + b.x1) / 2 : Math.max(b.x0 + hx, Math.min(b.x1 - hx, this.cx));
    this.cz = b.z1 - b.z0 <= hz * 2 ? (b.z0 + b.z1) / 2 : Math.max(b.z0 + hz, Math.min(b.z1 - hz, this.cz));
  }

  private zoom(f: number, px?: number, py?: number): void {
    const { w, h } = this.size();
    const ax = px ?? w / 2, ay = py ?? h / 2;
    const wx = this.cx + (ax - w / 2) / this.k, wz = this.cz + (ay - h / 2) / this.k;
    this.k *= f;
    this.clampView();
    this.cx = wx - (ax - w / 2) / this.k; this.cz = wz - (ay - h / 2) / this.k;
    this.clampView();
  }

  private setWay(x: number, z: number): void {
    const w = this.todo.waypoint;
    // A second press on the mark takes it away.
    if (w && Math.hypot(w.x - x, w.z - z) * this.k < 16) { this.todo.waypoint = null; return; }
    this.todo.waypoint = { x, z };
  }

  private bindMap(): void {
    const c = this.canvas;
    const pos = (e: PointerEvent): { x: number; y: number } => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, pos(e)); this.dragMoved = 0; this.pinch = 0; });
    c.addEventListener('pointermove', (e) => {
      const old = this.pointers.get(e.pointerId);
      if (!old) return;
      const now = pos(e);
      this.pointers.set(e.pointerId, now);
      const pts = Array.from(this.pointers.values());
      if (pts.length >= 2) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pinch > 0 && d > 0) this.zoom(d / this.pinch, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        this.pinch = d; this.dragMoved = 99;
      } else {
        this.cx -= (now.x - old.x) / this.k; this.cz -= (now.y - old.y) / this.k;
        this.dragMoved += Math.abs(now.x - old.x) + Math.abs(now.y - old.y);
        this.clampView();
      }
      this.cross = false;
      this.drawMap();
    });
    const up = (e: PointerEvent): void => {
      const at = this.pointers.get(e.pointerId);
      if (!at) return;
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
      if (e.type === 'pointerup' && this.dragMoved < 7 && this.pointers.size === 0) {
        const { w, h } = this.size();
        const hit = this.placeAt(at.x, at.y);
        if (hit) this.placesPanel.pick(hit);
        else this.setWay(this.cx + (at.x - w / 2) / this.k, this.cz + (at.y - h / 2) / this.k);
        this.drawMap();
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); const r = c.getBoundingClientRect(); this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top); this.drawMap(); }, { passive: false });
  }

  private drawMap(): void {
    if (!this.open || this.tab !== 0) return;
    const g = this.game, plan = g.plan, todo = this.todo, c = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    const { w, h, dpr } = this.size(), k = this.k;
    const X = (x: number): number => w / 2 + (x - this.cx) * k, Z = (z: number): number => h / 2 + (z - this.cz) * k;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ch = g.hud.chart();
    // Open water beyond the chart's edge is the chart's own sea colour, read off its corner once.
    if (!this.sea) { const d = (ch.img.getContext('2d') as CanvasRenderingContext2D).getImageData(2, 2, 1, 1).data; this.sea = `rgb(${d[0]},${d[1]},${d[2]})`; }
    c.fillStyle = this.sea;
    c.fillRect(0, 0, w, h);
    c.imageSmoothingQuality = 'high';
    c.drawImage(ch.img, X(ch.x0), Z(ch.z0), (ch.img.width / ch.s) * k, (ch.img.height / ch.s) * k);

    const text = (s: string, x: number, y: number, px: number, color: string, halo = true, font = '"IBM Plex Mono", monospace', weight = 600): void => {
      c.font = `${weight} ${px}px ${font}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      if (halo) { c.lineWidth = Math.max(2.5, px * 0.3); c.strokeStyle = 'rgba(242,232,207,0.88)'; c.lineJoin = 'round'; c.strokeText(s, x, y); }
      c.fillStyle = color;
      c.fillText(s, x, y);
    };

    // Waters and lands, in the big quiet lettering of a chart.
    const big = Math.max(11, Math.min(34, 46 * k * 3));
    text('C A L A M I T Y   S O U N D', X(-560), Z(600), big * 0.62, 'rgba(20,33,61,0.5)', false, '"Barlow Semi Condensed", sans-serif', 500);
    text('T H E   B U D G E T   G A P', X(330), Z(-800), big * 0.62, 'rgba(20,33,61,0.5)', false, '"Barlow Semi Condensed", sans-serif', 500);
    if (k < 0.24) {
      text('PORT CALAMITY', X(0), Z(-5), big, 'rgba(20,33,61,0.42)', false, '"Big Shoulders Display", sans-serif', 900);
      text('TEPID FALLS', X(-60), Z(-1560), big, 'rgba(20,33,61,0.42)', false, '"Big Shoulders Display", sans-serif', 900);
    }
    // The bridge's own label: kept clear of the hint strip (top left) and the chart's edges, on a small plaque,
    // drawn after the district names, which stand clear of it.
    let plaque: { x0: number; x1: number; y0: number; y1: number } | null = null;
    if (!progress.complete && k < 1) {
      c.font = '600 11px "IBM Plex Mono", monospace';
      const bt = `THE PERPETUAL BRIDGE · ${progress.spans} of ${BRIDGE_SPANS} spans`, bw = c.measureText(bt).width / 2 + 8;
      const bx = Math.max(bw, Math.min(w - bw, X(BRIDGE.x) + 120)), by = Math.max(56, Math.min(h - 64, Z(BRIDGE.z0 - 60)));
      plaque = { x0: bx - bw, x1: bx + bw, y0: by - 10, y1: by + 10 };
    }
    // Every badge the chart will carry, so a district name can stand clear of them.
    const marks: { x: number; z: number }[] = [g.player];
    for (let i = 0; i < RAMPS.length; i++) { if (i === RAMPS.length - 1 && progress.complete) continue; marks.push(RAMPS[i]); }
    for (const rc of todo.jobs.races) marks.push(rc.start);
    for (const y of todo.jobs.yards) marks.push(y.at);
    for (const s of todo.shops.list) marks.push(s.at);
    if (!todo.busy) for (const o of todo.missions.offers()) marks.push(todo.missions.givers[o.giver].at);
    if (k >= 0.24) {
      const mr = Math.max(7, Math.min(11, 8 + k * 3)) * 1.3 + 2;
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = plaque ? [plaque] : [];
      for (const d of this.districts) {
        const px = Math.max(9, Math.min(20, 30 * k)), label = d.text.toUpperCase();
        c.font = `600 ${px}px "IBM Plex Mono", monospace`;
        const hw = c.measureText(label).width / 2 + 2, hh = px / 2 + 2, x = X(d.x);
        const hit = (y: number): boolean => marks.some((m) => {
          const bx = X(m.x), by = Z(m.z), nx = Math.max(x - hw, Math.min(bx, x + hw)), ny = Math.max(y - hh, Math.min(by, y + hh));
          return Math.hypot(bx - nx, by - ny) < mr;
        }) || placed.some((r) => x + hw > r.x0 && x - hw < r.x1 && y + hh > r.y0 && y - hh < r.y1);
        let y = Z(d.z);
        for (const dy of [0, -1, 1, -2, 2, -3, 3]) { const ty = Z(d.z) + dy * (mr + hh) * 0.9; if (!hit(ty)) { y = ty; break; } }
        placed.push({ x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh });
        text(label, x, y, px, 'rgba(20,33,61,0.8)');
      }
    }
    if (plaque) {
      c.fillStyle = BONE; c.strokeStyle = INK; c.lineWidth = 1.5;
      c.fillRect(plaque.x0, plaque.y0, plaque.x1 - plaque.x0, plaque.y1 - plaque.y0); c.strokeRect(plaque.x0, plaque.y0, plaque.x1 - plaque.x0, plaque.y1 - plaque.y0);
      text(`THE PERPETUAL BRIDGE · ${progress.spans} of ${BRIDGE_SPANS} spans`, (plaque.x0 + plaque.x1) / 2, (plaque.y0 + plaque.y1) / 2, 11, INK, false);
    }
    if (k >= 0.55) {
      const px = Math.max(9, Math.min(15, 13 * k));
      for (const l of this.labels) {
        const x = X(l.x), y = Z(l.z);
        if (x < -80 || y < -80 || x > w + 80 || y > h + 80) continue;
        if (!l.vert) { text(l.text, x, y, px, INK, true, '"Barlow Semi Condensed", sans-serif', 600); continue; }
        c.save(); c.translate(x, y); c.rotate(-Math.PI / 2);
        text(l.text, 0, 0, px, INK, true, '"Barlow Semi Condensed", sans-serif', 600);
        c.restore();
      }
    }

    // The way to the waypoint, along the streets.
    const p = g.player, way = todo.waypoint, goal = todo.missions.target ?? todo.jobs.target;
    // The line is game/nav.ts's own (the streets, as the radar draws them), not a second guess.
    const rt = g.hud.nav.route;
    if ((way ?? goal) && rt && rt.length >= 4) {
      c.beginPath(); c.moveTo(X(rt[0]), Z(rt[1]));
      for (let i = 2; i < rt.length; i += 2) c.lineTo(X(rt[i]), Z(rt[i + 1]));
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.strokeStyle = INK; c.lineWidth = 6; c.stroke();
      c.strokeStyle = MUSTARD; c.lineWidth = 3.5; c.stroke();
    }

    const r = Math.max(7, Math.min(11, 8 + k * 3));
    const badge = (x: number, z: number, fill: string, label: string, diamond = false, fg = INK): void => {
      const px = X(x), py = Z(z);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) return;
      c.beginPath();
      if (diamond) { c.moveTo(px, py - r * 1.25); c.lineTo(px + r * 1.25, py); c.lineTo(px, py + r * 1.25); c.lineTo(px - r * 1.25, py); c.closePath(); } else c.arc(px, py, r, 0, Math.PI * 2);
      c.fillStyle = fill; c.fill();
      c.strokeStyle = INK; c.lineWidth = 2; c.stroke();
      if (label) text(label, px, py + 0.5, r * 1.35, fg, false, '"Big Shoulders Display", sans-serif', 900);
    };
    // Ducks found: small gold dots. The ones still out there are nobody's business.
    for (const i of save.data.ducks) { const d = todo.jobs.ducks[i]; if (!d) continue; c.beginPath(); c.arc(X(d.x), Z(d.z), 3.5, 0, Math.PI * 2); c.fillStyle = '#f6c21a'; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke(); }
    for (let i = 0; i < RAMPS.length; i++) { if (i === RAMPS.length - 1 && progress.complete) continue; badge(RAMPS[i].x, RAMPS[i].z, save.data.jumps.includes(i) ? MUSTARD : BONE, 'J'); }
    for (const rc of todo.jobs.races) badge(rc.start.x, rc.start.z, TEAL, 'R', false, BONE);
    for (const y of todo.jobs.yards) badge(y.at.x, y.at.z, BONE, 'Y');
    for (const s of todo.shops.list) badge(s.at.x, s.at.z, BONE, s.letter);
    if (progress.complete) {
      // Pardon's Surplus & Salvage: a red badge at the entrance, its name beside it.
      badge(PARDONS_AT.x, PARDONS_AT.z, PARDONS_RED, 'P', false, BONE);
      const px = Math.max(10, Math.min(14, 11 + k * 3));
      c.font = `700 ${px}px "IBM Plex Mono", monospace`;
      const tw = c.measureText("PARDON'S SURPLUS & SALVAGE").width;
      text("PARDON'S SURPLUS & SALVAGE", X(PARDONS_AT.x) + r + 6 + tw / 2, Z(PARDONS_AT.z), px, PARDONS_RED, true, '"IBM Plex Mono", monospace', 700);
    }
    // Businesses (world/business.ts): a dot in the kind's colour from a middling zoom, the name beside it close in.
    if (k >= 0.42) {
      const dr = Math.max(3, Math.min(6.5, 2.4 + k * 2.4)), lab = k >= 1, lp = Math.max(9, Math.min(12.5, 7.5 + k * 2.5));
      const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
      c.font = `600 ${lp}px "Barlow Semi Condensed", sans-serif`;
      for (const b of this.placesPanel.all()) {
        const px = X(b.x), py = Z(b.z);
        if (px < -10 || py < -10 || px > w + 10 || py > h + 10) continue;
        const on = todo.dest === b;
        c.beginPath(); c.arc(px, py, on ? dr + 2 : dr, 0, Math.PI * 2); c.fillStyle = CAT_COLOR[b.cat]; c.fill(); c.strokeStyle = INK; c.lineWidth = on ? 2.2 : 1.2; c.stroke();
        if (!lab && !on) continue;
        const tw = c.measureText(b.name).width / 2 + 3, ty = py - dr - lp * 0.8;
        const bx = { x0: px - tw, x1: px + tw, y0: ty - lp * 0.6, y1: ty + lp * 0.6 };
        if (!on && boxes.some((o) => bx.x0 < o.x1 && bx.x1 > o.x0 && bx.y0 < o.y1 && bx.y1 > o.y0)) continue;
        boxes.push(bx);
        text(b.name, px, ty, lp, INK, true, '"Barlow Semi Condensed", sans-serif', 700);
      }
    }
    if (!todo.busy) for (const o of todo.missions.offers()) { const gv = todo.missions.givers[o.giver]; badge(gv.at.x, gv.at.z, VERMILION, gv.letter, false, BONE); }
    if (goal) badge(goal.x, goal.z, MUSTARD, '', true);
    if (way) badge(way.x, way.z, MUSTARD, '', true);
    // Safe chat pings (game/chat.ts): a violet diamond with a bang and the sender's made-up name under it.
    for (const pg of this.game.hud.nav.pings ?? []) { badge(pg.x, pg.z, PEER_COLOR, '!', true, BONE); text(pg.who, X(pg.x), Z(pg.z) + r + 12, 10, INK, true); }

    // Other players (multiplayer): a violet dot with the made-up name beside it. Nothing when not connected.
    for (const o of g.net.peers) {
      const px = X(o.x), py = Z(o.z);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      c.beginPath(); c.arc(px, py, 6, 0, Math.PI * 2); c.fillStyle = PEER_COLOR; c.fill();
      c.strokeStyle = BONE; c.lineWidth = 2; c.stroke(); c.strokeStyle = INK; c.lineWidth = 1; c.beginPath(); c.arc(px, py, 7.2, 0, Math.PI * 2); c.stroke();
      text(o.text, px, py - 14, 11, INK);
    }

    // The train (world/train.ts), when there is one: a small square at its cab.
    const trn = trains.cur;
    if (STREETS_NEW && trn && (trn.cab.x !== 0 || trn.cab.z !== 0)) {
      const tx = X(trn.cab.x), ty = Z(trn.cab.z);
      if (tx > -20 && ty > -20 && tx < w + 20 && ty < h + 20) {
        c.fillStyle = BONE; c.strokeStyle = INK; c.lineWidth = 2; c.beginPath(); c.rect(tx - 6, ty - 6, 12, 12); c.fill(); c.stroke();
        c.fillStyle = INK; c.beginPath(); c.arc(tx, ty, 2.4, 0, Math.PI * 2); c.fill();
      }
    }

    // Dess.
    c.save(); c.translate(X(p.x), Z(p.z)); c.rotate(Math.PI - p.h);
    const a = 11;
    c.beginPath(); c.moveTo(0, -a); c.lineTo(a * 0.7, a * 0.78); c.lineTo(0, a * 0.36); c.lineTo(-a * 0.7, a * 0.78); c.closePath();
    c.strokeStyle = BONE; c.lineWidth = 4; c.stroke(); c.fillStyle = VERMILION; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke();
    c.restore();

    if (this.cross) { c.strokeStyle = INK; c.lineWidth = 1.5; c.beginPath(); c.moveTo(w / 2 - 12, h / 2); c.lineTo(w / 2 + 12, h / 2); c.moveTo(w / 2, h / 2 - 12); c.lineTo(w / 2, h / 2 + 12); c.stroke(); }

    // Title block, scale bar and north, as on any chart.
    const bar = [50, 100, 200, 500, 1000].find((m) => m * k > 70) ?? 1000;
    c.fillStyle = BONE; c.strokeStyle = INK; c.lineWidth = 2;
    c.fillRect(10, h - 44, bar * k + 20, 34); c.strokeRect(10, h - 44, bar * k + 20, 34);
    c.fillStyle = INK; c.fillRect(20, h - 22, bar * k, 4); c.fillRect(20, h - 28, 2, 12); c.fillRect(20 + bar * k - 2, h - 28, 2, 12);
    text(`${Math.round(bar * FEET / 10) * 10} ft`, 20 + (bar * k) / 2, h - 33, 10, INK, false);
    c.fillStyle = BONE; c.beginPath(); c.arc(w - 30, 32, 19, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = INK; c.beginPath(); c.moveTo(w - 30, 17); c.lineTo(w - 24, 34); c.lineTo(w - 36, 34); c.closePath(); c.fill();
    text('N', w - 30, 42, 10, INK, false);
    const legend = 'CHART No. 4 · NOT FOR NAVIGATION    ● work   R race   J jump   Y yard   ◆ waypoint';
    c.font = '600 10px "IBM Plex Mono", monospace';
    const lw = c.measureText(legend).width + 16;
    if (lw < w - bar * k - 60) { c.fillStyle = BONE; c.fillRect(w - lw - 10, h - 32, lw, 22); c.strokeRect(w - lw - 10, h - 32, lw, 22); text(legend, w - lw / 2 - 10, h - 21, 10, INK, false); }
  }

  // ── PROGRESS ───────────────────────────────────────────────────────────────

  private progressHtml(): string {
    const todo = this.todo, d = save.data, goal = progress.goal();
    // In a shared town (net/town.ts) the bridge on the screen is the town's; the player's own is kept apart and saved.
    const town = progress.mine !== null, own = progress.own();
    const ownLine = (): string => {
      const g = goalOf(own);
      return `${own.spans} of ${BRIDGE_SPANS} spans${own.stage ? `, ${esc(STAGE_NAMES[own.stage] ?? `stage ${own.stage}`)} open` : ''}${g ? ` · ${g.kind === 'bridge' ? `span ${g.n}` : esc(STAGE_NAMES[g.n] ?? `stage ${g.n}`)}: ${Math.floor(own.bank)} of ${g.cost} points` : ''}`;
    };
    const row = (label: string, value: string): string => `<div class="mn-row"><span class="mn-lbl">${label}</span><span>${value}</span></div>`;
    const ms = todo.missions.missions.map((m, i) => {
      const done = d.missions.includes(m.id), open = todo.missions.open(m);
      const giver = todo.missions.givers[m.giver];
      return `<div class="mn-check ${done ? 'done' : open ? 'open' : ''}"><i>${done ? '✕' : ''}</i><span>${String(i + 1).padStart(2, '0')}</span><b>${done || open ? esc(m.title) : 'Not yet on file'}</b><em>${done ? `${money(m.reward)} · ${m.points} pts` : open ? `See ${esc(giver.name)} (${giver.letter})` : m.stage ? `Tepid Falls, stage ${m.stage}` : ''}</em></div>`;
    }).join('');
    const jumps = RAMP_NAMES.map((n, i) => `<div class="mn-check ${d.jumps.includes(i) ? 'done' : 'open'}"><i>${d.jumps.includes(i) ? '✕' : ''}</i><b>${n}</b><em>${d.best['jump:' + i] !== undefined ? `best ${d.best['jump:' + i]} pts` : ''}</em></div>`).join('');
    const races = todo.jobs.races.map((r) => { const b = d.best['race:' + r.name]; return `<div class="mn-check ${b !== undefined && b <= r.par ? 'done' : 'open'}"><i>${b !== undefined && b <= r.par ? '✕' : ''}</i><b>${esc(r.name)}</b><em>par ${clock(r.par)}${b !== undefined ? ` · best ${clock(b)}` : ''}</em></div>`; }).join('');
    const stages = Array.from({ length: STAGES }, (_, i) => `<div class="mn-check ${progress.stage > i ? 'done' : ''}"><i>${progress.stage > i ? '✕' : ''}</i><b>${esc(STAGE_NAMES[i + 1] ?? `Stage ${i + 1}`)}</b></div>`).join('');
    return `
<div class="mn-form">
  <div class="mn-sec">
    <h3>Section A · ${town ? 'The Perpetual Bridge (the town\'s)' : 'The Perpetual Bridge'}</h3>
    ${row(town ? 'The town\'s spans' : 'Spans bolted down', `${boxes(progress.spans, BRIDGE_SPANS)} ${progress.spans} of ${BRIDGE_SPANS}`)}
    ${goal ? row(town ? 'The town\'s fund' : 'In hand', `${esc(goal.label)}: ${Math.floor(goal.have)} of ${goal.cost} points<span class="mn-bar"><i style="transform:scaleX(${Math.min(1, goal.have / goal.cost).toFixed(3)})"></i></span>`) : row(town ? 'The town\'s fund' : 'In hand', 'Nothing. Everything is open.')}
    ${town ? row('Your own', ownLine()) : ''}
    ${row(town ? 'Your points to date' : 'Points to date', Math.floor(progress.total).toLocaleString('en-US'))}
    <h3>Section B · Tepid Falls</h3>
    ${stages}
  </div>
  <div class="mn-sec">
    <h3>Section C · Business concluded (${d.missions.length} of ${todo.missions.missions.length})</h3>
    ${ms}
  </div>
  <div class="mn-sec">
    <h3>Section D · Golden ducks</h3>
    ${row('Recovered', `${boxes(d.ducks.length, DUCKS)} ${d.ducks.length} of ${DUCKS}`)}
    <h3>Section E · Stunt jumps (${d.jumps.length} of ${RAMPS.length})</h3>
    ${jumps}
    <h3>Section F · Races under par</h3>
    ${races}
    <h3>Section G · Odd jobs</h3>
    ${row('Fares carried', String(d.stats.fares))}${row('Cars towed', String(d.stats.tows))}${row('Parcels delivered', String(d.stats.parcels))}${row('Best rush', d.best.rush !== undefined ? money(d.best.rush) : '—')}
  </div>
</div>`;
  }

  // ── STATS ──────────────────────────────────────────────────────────────────

  private statsHtml(): string {
    const s = save.data.stats, g = this.game, p = g.player;
    const row = (label: string, value: string): string => `<div class="mn-row"><span class="mn-lbl">${label}</span><span>${value}</span></div>`;
    const hrs = Math.floor(s.played / 3600), mins = Math.floor((s.played % 3600) / 60);
    return `
<div class="mn-form mn-two">
  <div class="mn-sec">
    <h3>Form S-1 · Applicant's record</h3>
    ${row('Location', `${esc(g.plan.placeName(p.x, p.z))}, ${esc(g.plan.streetAt(p.x, p.z))}`)}
    ${row('Cash on hand', money(p.money))}
    ${row('Earned, all sources', money(s.earned))}
    ${row('Time on the clock', `${hrs} h ${String(mins).padStart(2, '0')} min`)}
    ${row('Distance driven', `${(s.driven / MILE).toFixed(1)} mi`)}
    ${row('Distance walked', `${(s.walked / MILE).toFixed(1)} mi`)}
    ${row('Cars borrowed', String(s.cars))}
    ${row('Top speed, alleged', `${Math.round(s.topSpeed * MPH)} mph`)}
  </div>
  <div class="mn-sec">
    <h3>Form S-2 · Incidents</h3>
    ${row('Airtime record', s.airtime > 0 ? `${s.airtime.toFixed(1)} s · ${Math.round(s.airDist * FEET)} ft` : 'None filed')}
    ${row('Times booked', String(s.booked))}
    ${kid.on ? '' : row('Times clocked out', String(s.deaths))}
    ${row('Missions filed', String(s.passed))}
    ${row('Missions, second attempts', String(s.failed))}
    ${row('Fares · tows · parcels', `${s.fares} · ${s.tows} · ${s.parcels}`)}
    ${row('Races under par', String(s.races))}
    ${row('Pedestrians given flying lessons', String(save.count('ragFlights')))}
    ${row('Longest unscheduled flight', save.count('ragFar') > 0 ? `${Math.round(save.count('ragFar') * FEET)} ft` : 'None filed')}
    ${row('Times used as a hood ornament', String(save.count('ragSelf')))}
    ${row('Furthest launch', save.count('launchFar') > 0 ? `${Math.round(save.count('launchFar') * FEET)} ft` : 'None filed')}
    ${row('Bullseyes', String(save.count('launchBulls')))}
    ${row('Times fired from a cannon', String(save.count('launchFired')))}
    ${row('Best trick score', save.count('trickBest') > 0 ? `${save.count('trickBest').toLocaleString('en-US')} pts` : 'None filed')}
    ${row('Longest airtime (Waiver Park)', save.count('trickAir') > 0 ? `${(save.count('trickAir') / 10).toFixed(1)} s` : 'None filed')}
    ${row('Loops completed', String(save.count('loops')))}
    ${row('Moose encountered', String(save.count('moose')))}
    <div class="mn-row mn-mistakes"><span class="mn-lbl">Mistakes made</span><span>0*</span></div>
    <p class="mn-note">* As reported by the applicant. Anything typed is not counted.</p>
  </div>
  ${boardHtml(this.game)}
</div>`;
  }

  // ── SETTINGS ───────────────────────────────────────────────────────────────

  private settingsHtml(): string {
    const s = save.data.settings;
    const tog = (key: string, on: boolean): string => `<button type="button" class="mn-tog ${on ? 'on' : ''}" data-set="${key}" aria-pressed="${on}"><i></i>${on ? 'On' : 'Off'}</button>`;
    const q = (['auto', 'low', 'medium', 'high'] as QualityPick[]).map((v) => `<button type="button" class="mn-seg ${s.quality === v ? 'on' : ''}" data-set="quality" data-v="${v}">${v}</button>`).join('');
    const seasons = (['auto', 'autumn', 'winter', 'summer'] as SeasonPick[]).map((v) => `<button type="button" class="mn-seg ${season.shown === v ? 'on' : ''}" data-set="season" data-v="${v}">${v}</button>`).join('');
    const running = this.game.quality.name, gov = this.game.gov;
    // Auto and a fixed preset swap while running; only a different preset has to rebuild the world.
    const want = s.quality === 'auto' ? autoPresetIfKnown() : s.quality;
    const stale = !gov.forced && want !== null && want !== running;
    const at = gov.steps[gov.step];
    const how = gov.forced ? `Running at <b>${running}</b> because the address says so (?q=); the setting applies without it.`
      : !gov.enabled ? `Running at <b>${running}</b>, fixed.`
      : `Auto is running <b>${running}</b>${gov.step ? `, eased to step ${gov.step} of ${gov.steps.length - 1} (${at.name}),` : ' in full'} and adjusts itself to keep the frames smooth.${gov.demoted ? ` This machine has trouble with ${running}: next time it starts at ${gov.demoted}.` : ''}`;
    const vol = (label: string, key: VolKey): string => `<div class="mn-row"><span class="mn-lbl">${label}</span><span><input type="range" min="0" max="1" step="0.05" value="${s[key]}" data-set="${key}"><b class="mn-val">${Math.round(s[key] * 100)}</b></span></div>`;
    return `
<div class="mn-form mn-two">
  <div class="mn-sec">
    <h3>Form C-2 · Preferences</h3>
    <div class="mn-row"><span class="mn-lbl">Look speed</span><span><input type="range" min="0.3" max="2.5" step="0.1" value="${s.sens}" data-set="sens"><b class="mn-val">${s.sens.toFixed(1)}×</b></span></div>
    <div class="mn-row"><span class="mn-lbl">Invert Y</span><span>${tog('invertY', s.invertY)}</span></div>
    <div class="mn-row"><span class="mn-lbl">Full screen on tap</span><span>${tog('fsTap', s.fsTap)}</span></div>
    <div class="mn-row"><span class="mn-lbl">Reduced motion</span><span>${tog('reducedMotion', s.reducedMotion)}</span></div>
    <div class="mn-row"><span class="mn-lbl">Kid friendly</span><span>${tog('kid', kid.on)}</span></div>
    <p class="mn-note">Kid friendly: no weapons, and nobody gets hurt; knocked over is as bad as it gets. ${this.game.net.status === 'off' ? 'Saved in this browser.' : 'In town it is for everybody there, and anybody can flip it.'}</p>
    <div class="mn-row"><span class="mn-lbl">Automatic replays</span><span>${tog('autoReplay', this.game.cam.replay.auto)}</span></div>
    <div class="mn-row"><span class="mn-lbl">Quality</span><span class="mn-segs">${q}</span></div>
    <div class="mn-row"><span class="mn-lbl">Season</span><span class="mn-segs">${seasons}</span></div>
    <div class="mn-row"><span class="mn-lbl">Holiday decorations</span><span class="mn-segs">${(['auto', 'on', 'off'] as HolidayPick[]).map((v) => `<button type="button" class="mn-seg ${holiday.shown === v ? 'on' : ''}" data-set="holiday" data-v="${v}">${v}</button>`).join('')}</span></div>
    ${this.nameRow()}
    <p class="mn-note">${how}${stale ? ` A change of preset rebuilds the world, so <b>${want}</b> takes effect when the page is reloaded: <button type="button" class="mn-link" data-set="reload">save and reload now</button>` : ''}</p>
    <p class="mn-note">${VOICE_CREDIT}</p>
    <p class="mn-note">${MAP_CREDIT}</p>
  </div>
  <div class="mn-sec">
    <h3>Form C-3 · Sound</h3>
    ${vol('Master', 'volMaster')}
    ${vol('Radio', 'volMusic')}
    ${vol('Effects', 'volSfx')}
    ${vol('Weather and town', 'volAmbience')}
    <p class="mn-note">The Harbor Authority has approved noise, within reason. T changes the station at the wheel.</p>
  </div>
</div>`;
  }

  /** The made-up multiplayer name and the button that re-rolls it. Only when a service is configured. */
  private nameRow(): string {
    const n = this.game.net;
    if (n.status === 'off') return '';
    // Safe chat (game/chat.ts): who else is in town, each with a mute button. A muted player's bubbles, log lines, pings and shouts are not shown here.
    const others = n.peers.map((r) => `<div class="mn-row"><span class="mn-lbl">${esc(r.text)}</span><span><button type="button" class="mn-link" data-set="mute" data-id="${r.id}">${n.chat.muted(r.id) ? 'muted &middot; unmute' : 'mute'}</button></span></div>`).join('');
    return `<div class="mn-row"><span class="mn-lbl">Town name</span><span><button type="button" class="mn-link mn-name" data-set="newname" title="Get a new made-up name"><b>${esc(n.name)}</b> &middot; new name</button></span></div>${others ? `<div class="mn-row"><span class="mn-lbl">In town (Y is quick chat)</span><span></span></div>${others}` : ''}`;
  }

  private onSetting(el: HTMLElement): void {
    const s = save.data.settings, key = el.dataset.set;
    if (key === 'mute') { const id = Number(el.dataset.id); this.game.net.chat.mute(id, !this.game.net.chat.muted(id)); this.panes[3].innerHTML = this.settingsHtml(); return; }
    if (key === 'newname') { const b = el.querySelector('b'); const nm = this.game.net.reroll(); if (b) b.textContent = nm; return; }
    if (key === 'reload') { this.todo.saveNow(); location.reload(); return; }
    if (key === 'sens') {
      s.sens = Math.max(0.3, Math.min(2.5, Number((el as HTMLInputElement).value) || 1));
      const v = el.parentElement?.querySelector('.mn-val');
      if (v) v.textContent = `${s.sens.toFixed(1)}×`;
    } else if (key === 'volMaster' || key === 'volMusic' || key === 'volSfx' || key === 'volAmbience') {
      s[key] = Math.max(0, Math.min(1, Number((el as HTMLInputElement).value) || 0));
      const v = el.parentElement?.querySelector('.mn-val');
      if (v) v.textContent = String(Math.round(s[key] * 100));
      this.game.audio?.applySettings(key);
    } else if (key === 'quality') { s.quality = (el.dataset.v as QualityPick) ?? 'auto'; this.game.gov.setPick(s.quality); }
    else if (key === 'season') { const v = el.dataset.v; s.season = v === 'autumn' || v === 'winter' || v === 'summer' ? v : 'auto'; season.choose(s.season); }
    else if (key === 'holiday') { const v = el.dataset.v; holiday.choose(v === 'on' || v === 'off' ? v : 'auto'); }
    else if (key === 'invertY' || key === 'fsTap' || key === 'reducedMotion') s[key] = !s[key];
    else if (key === 'autoReplay') this.game.cam.replay.setAuto(!this.game.cam.replay.auto);
    else if (key === 'kid') kid.flip(!kid.on);
    else return;
    this.todo.applySettings();
    save.write();
    // The slider keeps the pointer; everything else is redrawn with its new state.
    if (key !== 'sens' && !key.startsWith('vol')) { this.panes[3].innerHTML = this.settingsHtml(); (this.panes[3].querySelector(`[data-set="${key}"]${key === 'quality' ? `[data-v="${s.quality}"]` : key === 'season' ? `[data-v="${season.shown}"]` : key === 'holiday' ? `[data-v="${holiday.shown}"]` : ''}`) as HTMLElement | null)?.focus(); }
  }

  // ── CONTROLS ───────────────────────────────────────────────────────────────

  private controlsHtml(): string {
    const rows = CONTROLS.map(([what, key, pad, touch]) => `<tr><th>${what}</th><td>${key}</td><td>${pad}</td><td>${touch}</td></tr>`).join('');
    return `
<div class="mn-form">
  <div class="mn-sec mn-wide">
    <h3>Form K-1 · Attached: quick reference</h3>
    <table class="mn-keys"><thead><tr><th></th><th>Keyboard</th><th>Gamepad</th><th>Touch</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="mn-note">In this dossier: 1 to 5 or [ ] change tabs (LB / RB on a pad); on the map, arrows move, + and − zoom, Enter sets a waypoint.</p>
  </div>
</div>`;
  }
}
