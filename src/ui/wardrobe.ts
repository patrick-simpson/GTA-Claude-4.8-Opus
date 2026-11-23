// The Wardrobe: a page of the pause menu where the player picks their own look and their car's (game/looks.ts).
//
//   CHARACTER  body, height and build, skin, face, hair and its colour, facial hair, top, jacket, bottoms, shoes,
//              hat, glasses, bag, each colour from a swatch row
//   GARAGE     paint (factory, solid gloss or metallic, twenty colours), rims, horn: for the car being driven now and
//              every car the player gets into after
//
// While the page is up the menu card moves to the left and the camera turns slowly round the player (or their car)
// on the right: a turntable of the real thing, drawn by the game itself, so what is seen here is exactly what every
// other screen draws. Every change is saved at once and sent to the others (net/index.ts).
//
// On a first visit, a few seconds into play, a small slip offers the page once; it never comes back after an answer.

import './wardrobe.css';
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import {
  BEARD_NAMES, BOTTOM_NAMES, CLOTH_COLORS, CUT_NAMES, FACE_COUNT, FINISH_NAMES, GLASSES_NAMES, HAIR_COLORS, HAT_NAMES,
  HORN_CHOICES, HORN_NAMES, PAINTS, RIM_COLORS, RIM_NAMES, SHOE_NAMES, SKIN_TONES, TOP_NAMES,
  myLook, onMyLook, randomPlayerLook, setMyLook, type PlayerLook,
} from '../game/looks';

const PROMPT_KEY = 'portcalamity.lookprompt.v1';
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
type Key = keyof PlayerLook;

export class Wardrobe {
  /** Which half is showing: the person or the car. */
  side: 'char' | 'car' = 'char';
  private pane: HTMLElement | null = null;
  private active = false;
  private raf = 0;
  private spin = 0;
  private lastT = 0;
  private savedView: Game['view'] = null;
  private readonly view = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private slip: HTMLElement | null = null;

  constructor(private readonly game: Game, private readonly openMenu: () => void) {
    // The Garage goes with the player into every car they drive.
    game.on('enter', (e) => this.dress(e.vehicle));
    onMyLook(() => { const v = this.game.player.vehicle; if (v) this.dress(v); });
    this.watchFirstVisit();
  }

  /** The player's paint, finish, rims and horn on a car they have just got into (or are in). */
  dress(v: Vehicle): void {
    const l = myLook();
    if (l.finish > 0) { v.color = l.paint; v.finish = l.finish; }
    else if (v.finish) v.finish = 0;
    v.rims = l.rims;
    v.hornKind = HORN_CHOICES[l.horn] ?? null;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  /** Called by the menu when the Wardrobe tab is shown. */
  show(pane: HTMLElement): void {
    if (this.pane !== pane) {
      this.pane = pane;
      pane.addEventListener('click', (e) => this.onClick(e));
      pane.addEventListener('input', (e) => this.onInput(e));
    }
    this.render();
    if (!this.active) {
      this.active = true;
      this.savedView = this.game.view;
      this.game.view = this.view;
      this.lastT = performance.now();
      const loop = (t: number): void => { if (!this.active) return; this.raf = requestAnimationFrame(loop); this.turn(t); };
      this.raf = requestAnimationFrame(loop);
      this.turn(this.lastT);
    }
  }

  /** Called by the menu when another tab is shown or the menu closes. */
  hide(): void {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    if (this.game.view === this.view) this.game.view = this.savedView;
    this.savedView = null;
  }

  private render(): void {
    const pane = this.pane;
    if (!pane) return;
    const top = pane.scrollTop;
    pane.innerHTML = this.side === 'char' ? this.charHtml() : this.carHtml();
    pane.scrollTop = top;
  }

  private segs(k: Key, names: readonly string[], cur: number, off = (_i: number): boolean => false): string {
    return `<span class="mn-segs wd-segs">${names.map((n, i) => `<button type="button" class="mn-seg ${cur === i ? 'on' : ''}" data-k="${k}" data-v="${i}"${off(i) ? ' disabled' : ''}>${n}</button>`).join('')}</span>`;
  }

  private swatches(k: Key, cols: readonly number[], cur: number, plusNone = false): string {
    const none = plusNone ? `<button type="button" class="wd-sw wd-none ${cur === 0 ? 'on' : ''}" data-k="${k}" data-v="0" title="None"></button>` : '';
    return `<span class="wd-sws">${none}${cols.map((c, i) => {
      const v = plusNone ? i + 1 : i;
      return `<button type="button" class="wd-sw ${cur === v ? 'on' : ''}" style="--c:${hex(c)}" data-k="${k}" data-v="${v}" title="${hex(c)}"></button>`;
    }).join('')}</span>`;
  }

  private row(label: string, body: string): string { return `<div class="mn-row wd-row"><span class="mn-lbl">${label}</span>${body}</div>`; }

  private head(): string {
    return `<div class="wd-top"><span class="mn-segs"><button type="button" class="mn-seg ${this.side === 'char' ? 'on' : ''}" data-side="char">Character</button><button type="button" class="mn-seg ${this.side === 'car' ? 'on' : ''}" data-side="car">Garage</button></span>
      <button type="button" class="mn-link" data-act="random">Surprise me</button></div>`;
  }

  private charHtml(): string {
    const l = myLook();
    const onePiece = l.top === 3 || l.top === 4;
    return `${this.head()}
<div class="mn-sec wd-sec">
  <h3>Form W-1 · Who you are</h3>
  ${this.row('Body', this.segs('body', ['Feminine', 'Masculine'], l.body))}
  ${this.row('Height', `<span><input type="range" min="0" max="255" step="1" value="${l.height}" data-k="height"><b class="mn-val">${(1.75 * (0.9 + 0.2 * l.height / 255)).toFixed(2)} m</b></span>`)}
  ${this.row('Build', `<span><input type="range" min="0" max="255" step="1" value="${l.build}" data-k="build"><b class="mn-val">${Math.round(100 * (0.9 + 0.25 * l.build / 255))}%</b></span>`)}
  ${this.row('Skin', this.swatches('skin', SKIN_TONES, l.skin))}
  ${this.row('Face', this.segs('face', Array.from({ length: FACE_COUNT }, (_, i) => String(i + 1)), l.face))}
  ${this.row('Hair', this.segs('cut', CUT_NAMES, l.cut))}
  ${this.row('Hair colour', this.swatches('hair', HAIR_COLORS, l.hair))}
  ${this.row('Facial hair', this.segs('beard', BEARD_NAMES, l.beard))}
</div>
<div class="mn-sec wd-sec">
  <h3>Form W-2 · What you wear</h3>
  ${this.row('Top', this.segs('top', TOP_NAMES, l.top))}
  ${this.row('Top colour', this.swatches('topColor', CLOTH_COLORS, l.topColor))}
  ${this.row(onePiece ? 'Jacket <em>(not over this)</em>' : 'Jacket <em>(open, over a tee)</em>', this.swatches('jacket', CLOTH_COLORS, onePiece ? 0 : l.jacket, true))}
  ${this.row('Bottoms', this.segs('bottom', BOTTOM_NAMES, l.bottom, () => onePiece))}
  ${this.row('Bottoms colour', this.swatches('bottomColor', CLOTH_COLORS, l.bottomColor))}
  ${this.row('Shoes', this.segs('shoes', SHOE_NAMES, l.shoes))}
  ${this.row('Shoe colour', this.swatches('shoeColor', CLOTH_COLORS, l.shoeColor))}
  ${this.row('Hat', this.segs('hat', HAT_NAMES, l.hat))}
  ${l.hat ? this.row('Hat colour', this.swatches('hatColor', CLOTH_COLORS, l.hatColor)) : ''}
  ${this.row('Glasses', this.segs('glasses', GLASSES_NAMES, l.glasses))}
  ${this.row('Bag', this.segs('bag', ['No', 'Yes'], l.bag))}
  <p class="mn-note">Saved in this browser. In town everybody sees you exactly like this.</p>
</div>`;
  }

  private carHtml(): string {
    const l = myLook(), v = this.game.player.vehicle;
    return `${this.head()}
<div class="mn-sec wd-sec">
  <h3>Form W-3 · Your car</h3>
  ${this.row('Paint', this.segs('finish', FINISH_NAMES, l.finish))}
  ${l.finish ? this.row('Colour', `<span class="wd-sws">${PAINTS.map((c) => `<button type="button" class="wd-sw wd-paint ${l.paint === c ? 'on' : ''}" style="--c:${hex(c)}" data-k="paint" data-v="${c}" title="${hex(c)}"></button>`).join('')}</span>`) : ''}
  ${this.row('Rims', `<span class="wd-sws">${RIM_COLORS.map((c, i) => `<button type="button" class="wd-sw wd-rim ${l.rims === i ? 'on' : ''}" style="--c:${hex(c)}" data-k="rims" data-v="${i}" title="${RIM_NAMES[i]}"></button>`).join('')}</span><b class="mn-val wd-name">${RIM_NAMES[l.rims]}</b>`)}
  ${this.row('Horn', this.segs('horn', HORN_NAMES, l.horn))}
  <p class="mn-note">${v ? 'On the car you are driving now, and' : 'Not in a car now. It goes on'} every car you get into from here on. ${l.finish ? '' : 'Factory paint keeps each car its own colour.'} The others in town see the same paint and rims, and hear the same horn.</p>
</div>`;
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const side = t.closest<HTMLElement>('[data-side]');
    if (side) { this.side = side.dataset.side === 'car' ? 'car' : 'char'; this.render(); return; }
    if (t.closest('[data-act="random"]')) {
      const old = myLook(), r = randomPlayerLook();
      // The Garage page rolls the car; the Character page the person.
      const l: PlayerLook = this.side === 'car'
        ? { ...old, finish: 1 + Math.floor(Math.random() * 2), paint: PAINTS[Math.floor(Math.random() * PAINTS.length)], rims: Math.floor(Math.random() * RIM_COLORS.length) }
        : { ...r, finish: old.finish, paint: old.paint, rims: old.rims, horn: old.horn };
      this.set(l);
      return;
    }
    const b = t.closest<HTMLElement>('button[data-k]');
    if (b) this.change(b.dataset.k as Key, Number(b.dataset.v));
  }

  private onInput(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-k]');
    if (!t) return;
    const l = { ...myLook(), [t.dataset.k as Key]: Number(t.value), picked: true };
    setMyLook(l);
    // Only the number beside the slider: a full redraw would drop the slider out from under the pointer.
    const out = t.parentElement?.querySelector('.mn-val');
    if (out) out.textContent = t.dataset.k === 'height' ? `${(1.75 * (0.9 + 0.2 * l.height / 255)).toFixed(2)} m` : `${Math.round(100 * (0.9 + 0.25 * l.build / 255))}%`;
  }

  /** One field of the look changed. */
  change(k: Key, v: number): void {
    const l: PlayerLook = { ...myLook(), [k]: v };
    if (k === 'top' && (v === 3 || v === 4)) l.jacket = 0;
    if (k === 'finish' && v > 0 && l.paint === 0) l.paint = PAINTS[5];
    this.set(l);
  }

  private set(l: PlayerLook): void {
    l.picked = true;
    setMyLook(l);
    this.render();
  }

  // ── The turntable ──────────────────────────────────────────────────────────

  private turn(t: number): void {
    const g = this.game, dt = Math.min(0.1, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    this.spin += dt * 0.45;
    const v = g.player.seated;
    const car = this.side === 'car' && v ? v : v && !g.player.person.visible ? v : null;
    const per = g.player.person;
    const cx = car ? car.x : per.x, cy = car ? car.y : per.y, cz = car ? car.z : per.z;
    const h = car ? car.h : per.h;
    // Close on a person (head to toe in frame), farther and higher on a car.
    const d = car ? car.spec.length * 1.25 + 2.5 : 3.3 * (per.look.height || 1);
    const up = car ? 0.9 : 0.98 * (per.look.height || 1);
    const a = h + 0.5 + this.spin;
    const sx = Math.sin(a), sz = Math.cos(a);
    this.view.pos.set(cx + sx * d, cy + up + (car ? 1.6 : 0.25), cz + sz * d);
    // The card covers the left of the screen: aim to the left of the subject so it stands in the open right part.
    const wide = innerWidth > innerHeight * 1.1 ? 1 : 0;
    const shift = wide * d * 0.42;
    this.view.target.set(cx - sz * shift, cy + up, cz + sx * shift);
    // Paused, nothing else redraws them: the look may have just changed.
    g.vehicles.update(0);
    g.occupants.place();
    g.people.update(0);
  }

  // ── First visit ───────────────────────────────────────────────────────────

  private watchFirstVisit(): void {
    let asked = false;
    try { asked = localStorage.getItem(PROMPT_KEY) === '1'; } catch { asked = true; }
    const force = new URLSearchParams(location.search).get('wprompt') === '1';
    if (!force && (asked || myLook().picked || navigator.webdriver)) return;
    const poll = setInterval(() => {
      if (this.game.state !== 'play') return;
      clearInterval(poll);
      setTimeout(() => this.offer(), force ? 500 : 6000);
    }, 1000);
  }

  private offer(): void {
    if (this.slip || this.game.state !== 'play') return;
    const s = this.slip = document.createElement('div');
    s.className = 'wd-slip';
    s.innerHTML = `<div class="mn-lbl">Form W-0 · Optional</div><b>This is how the town sees you.</b>
      <span>Change your face, hair, clothes and car in the Wardrobe. You can always find it in the pause menu.</span>
      <div><button type="button" class="wd-go">Open the Wardrobe</button><button type="button" class="wd-later">Keep this look</button></div>`;
    document.body.appendChild(s);
    const done = (): void => { try { localStorage.setItem(PROMPT_KEY, '1'); } catch { /* asked again next time */ } s.remove(); };
    s.querySelector('.wd-go')?.addEventListener('click', () => { done(); this.side = 'char'; this.openMenu(); });
    s.querySelector('.wd-later')?.addEventListener('click', done);
    setTimeout(() => { if (s.isConnected) s.classList.add('wd-fade'); }, 14000);
    setTimeout(() => { if (s.isConnected) s.remove(); }, 15000);
  }
}
