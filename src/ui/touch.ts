// Touch controls for phones and tablets: a floating stick under the left
// thumb, pedals or JUMP under the right, and look-drag on whatever is left.
//
// Everything is event driven through Pointer Events and feeds the hooks at the
// bottom of core/input.ts; update() only decides which layout is on screen.
// All listeners sit on the #touch root (pointer events bubble from the
// captured key), so there is one code path for every finger.

import './touch.css';
import type { Game } from '../core/game';
import type { Action } from '../core/input';

/** Stick travel, as a fraction of the base radius, that counts as no input. */
const DEAD = 0.14;
/** Sprint engages at the rim and lets go a little inside it, so a trembling thumb does not flutter. */
const RIM_ON = 0.94, RIM_OFF = 0.8;
/** A thumb may stray this far (px) off a pedal before it counts as having left it. */
const SLOP = 12;

interface Key {
  el: HTMLElement;
  /** Fingers on it right now. Two fingers on one key must not release it when the first lifts. */
  n: number;
  down: () => void;
  up: () => void;
  /** Pedals: a finger may slide from one to the next without lifting. */
  slide: boolean;
  /** FIRE: the thumb holding it also turns the view as it drags, so one thumb aims and shoots. */
  look?: boolean;
  l: number; t: number; r: number; b: number;
}

type Ptr =
  | { kind: 'stick' }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'key'; key: Key | null; slide: boolean; x: number; y: number };

const GLYPH = {
  // Two bars / a pennant for resume.
  pause: '<svg class="t-bars" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2h4v16H4zM12 2h4v16h-4z" fill="currentColor"/></svg>'
    + '<svg class="t-play" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2l12 8-12 8z" fill="currentColor"/></svg>',
  // A brass bulb horn seen from the side.
  horn: '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M3 11h6l9-6v18l-9-6H3z" fill="currentColor"/>'
    + '<path d="M21.5 9.5l4-2.5M22 14h4.5M21.5 18.5l4 2.5" stroke="currentColor" stroke-width="2.2" fill="none"/></svg>',
  // A box camera.
  camera: '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M2 8h6l2-3h8l2 3h6v15H2z" fill="none" stroke="currentColor" stroke-width="2.2"/>'
    + '<rect x="10" y="11" width="8" height="8" fill="currentColor"/></svg>',
};

export class TouchUI {
  private root: HTMLElement;
  private stickZone: HTMLElement;
  private lookZone: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private keys: Key[] = [];
  private byEl = new Map<Element, Key>();
  private getIn!: Key;
  private useKey!: Key;
  private using = false;
  private aimKey!: Key;
  /** AIM is a latch on glass: nobody has a spare thumb to hold it. */
  private aimOn = false;
  private armed = false;
  private ptrs = new Map<number, Ptr>();

  private coarse: boolean;
  private shown = false;
  private paused = false;
  private driving: boolean | null = null;
  private near = false;

  // Stick state: origin of the base and the thumb, in CSS pixels.
  private stickId = -1;
  private ox = 0; private oy = 0;
  private px = 0; private py = 0;
  private radius = 50;
  private sprinting = false;
  private gas = 0; private brake = 0;

  constructor(private game: Game) {
    const root = document.getElementById('touch') ?? document.body.appendChild(document.createElement('div'));
    root.id = 'touch';
    this.root = root;

    this.lookZone = this.div('t-zone t-lookzone');
    this.stickZone = this.div('t-zone t-stickzone');
    this.stick = this.div('t-stick');
    for (const c of ['n', 'e', 's', 'w']) this.stick.appendChild(document.createElement('i')).className = 't-tick ' + c;
    this.knob = this.stick.appendChild(document.createElement('div'));
    this.knob.className = 't-knob';

    const input = game.input;
    const act = (cls: string, box: string, html: string, a: Action): Key =>
      this.key(cls, box, html, () => input.touchDown(a), () => input.touchUp(a));
    const pedals = (): void => input.setTouchPedals(this.gas, this.brake);

    act('t-jump foot', '01', 'Jump', 'jump');
    this.getIn = act('t-getin foot gone', '02', 'Get in', 'enter');

    this.key('t-gas drive', '03', 'Gas', () => { this.gas = 1; pedals(); }, () => { this.gas = 0; pedals(); }, true);
    this.key('t-brake drive', '04', 'Brake', () => { this.brake = 1; pedals(); }, () => { this.brake = 0; pedals(); }, true);
    const hand = act('t-hand drive', '05', 'Hand<br>brake', 'handbrake');
    hand.slide = true;
    act('t-horn drive', '06', GLYPH.horn + '<small>Horn</small>', 'horn');
    act('t-exit drive', '07', 'Exit', 'enter');
    act('t-cam drive', '08', GLYPH.camera + '<small>Camera</small>', 'camera');
    // Weapons: FIRE above JUMP (above the pedals at the wheel), AIM and SWAP beside it. Only when she has something to fire.
    act('t-fire arm', '09', 'Fire', 'fire').look = true;
    this.aimKey = this.key('t-aim arm', '10', 'Aim', () => this.setAim(!this.aimOn), () => { /* a latch: lifting the thumb changes nothing */ });
    act('t-swap arm', '11', 'Swap', 'nextWeapon');
    // Talk, start a job, pay: on the glass only while a prompt that wants it is up (missions and jobs, src/game/).
    this.useKey = act('t-use always gone', '12', 'Use', 'interact');
    act('t-pause always', '', GLYPH.pause, 'pause');

    const card = this.div('t-rotate');
    card.innerHTML = '<b>Turn the phone sideways</b><span>The harbor is wider than it is tall.</span>';

    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    root.addEventListener('pointerup', (e) => this.end(e.pointerId));
    root.addEventListener('pointercancel', (e) => this.end(e.pointerId));
    root.addEventListener('lostpointercapture', (e) => this.end(e.pointerId));
    // A long press must not open the browser's menu over the pedals.
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // A finger that is down when the tab loses focus never sends its pointerup.
    addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => this.releaseAll());

    const mq = matchMedia('(pointer: coarse)');
    this.coarse = mq.matches;
    mq.addEventListener('change', () => { this.coarse = mq.matches; });
  }

  private div(cls: string): HTMLElement {
    const el = this.root.appendChild(document.createElement('div'));
    el.className = cls;
    return el;
  }

  private key(cls: string, box: string, html: string, down: () => void, up: () => void, slide = false): Key {
    const el = this.div('t-key ' + cls);
    el.innerHTML = html;
    if (box) el.dataset.box = box;
    const k: Key = { el, n: 0, down, up, slide, l: 0, t: 0, r: 0, b: 0 };
    this.keys.push(k);
    this.byEl.set(el, k);
    return k;
  }

  // ── Pointers ───────────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    if (!this.shown || this.ptrs.has(e.pointerId)) return;
    const target = e.target as Element;
    const keyEl = target.closest('.t-key');
    const key = keyEl ? this.byEl.get(keyEl) : undefined;
    let p: Ptr | null = null;
    if (key) {
      if (key.slide) this.measurePedals();
      p = { kind: 'key', key, slide: key.slide, x: e.clientX, y: e.clientY };
      this.press(key);
    } else if (target === this.stickZone) {
      // One stick, one thumb: a second finger in the zone is ignored.
      if (this.stickId < 0) { p = { kind: 'stick' }; this.stickStart(e); }
    } else if (target === this.lookZone) {
      p = { kind: 'look', x: e.clientX, y: e.clientY };
    }
    if (!p) return;
    this.ptrs.set(e.pointerId, p);
    // Capture keeps the moves coming when the finger wanders off the element;
    // preventDefault stops the browser inventing mouse events from the touch.
    try { (target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    if (p.kind === 'look') {
      this.game.input.addLook(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX; p.y = e.clientY;
    } else if (p.kind === 'stick') {
      this.px = e.clientX; this.py = e.clientY;
      this.stickApply();
    } else if (p.key && p.key.look) {
      this.game.input.addLook(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX; p.y = e.clientY;
    } else if (p.slide) {
      const cur = p.key;
      if (cur && this.inside(cur, e.clientX, e.clientY, SLOP)) return;
      let next: Key | null = null;
      for (const k of this.keys) if (k.slide && k !== cur && this.inside(k, e.clientX, e.clientY, 0)) { next = k; break; }
      if (next === cur) return;
      // Press the new pedal before letting go of the old, so sliding from gas
      // to brake never passes through a frame with neither.
      if (next) this.press(next);
      if (cur) this.release(cur);
      p.key = next;
    }
  }

  private end(id: number): void {
    const p = this.ptrs.get(id);
    if (!p) return;
    this.ptrs.delete(id);
    if (p.kind === 'key') { if (p.key) this.release(p.key); }
    else if (p.kind === 'stick') this.stickEnd();
  }

  private press(k: Key): void {
    if (k.n++ === 0) { k.el.classList.add('on'); k.down(); }
  }
  private release(k: Key): void {
    if (k.n > 0 && --k.n === 0) { k.el.classList.remove('on'); k.up(); }
  }
  private drop(k: Key): void {
    if (k.n > 0) { k.n = 0; k.el.classList.remove('on'); k.up(); }
  }

  /** Pedal rectangles are read once per touch, not per move: layout reads are not free on a phone. */
  private measurePedals(): void {
    for (const k of this.keys) {
      if (!k.slide) continue;
      const r = k.el.getBoundingClientRect();
      k.l = r.left; k.t = r.top; k.r = r.right; k.b = r.bottom;
    }
  }
  private inside(k: Key, x: number, y: number, slop: number): boolean {
    return x >= k.l - slop && x <= k.r + slop && y >= k.t - slop && y <= k.b + slop;
  }

  // ── Stick ──────────────────────────────────────────────────────────────────

  private stickStart(e: PointerEvent): void {
    this.stickId = e.pointerId;
    this.radius = this.stick.offsetWidth / 2 || 50;
    this.px = e.clientX; this.py = e.clientY;
    // Keep the whole base on the glass even when the thumb lands in the corner.
    const r = this.radius + 4;
    this.ox = Math.min(Math.max(e.clientX, r), innerWidth - r);
    this.oy = Math.min(Math.max(e.clientY, r), innerHeight - r);
    this.stick.classList.add('live');
    this.stickApply();
  }

  private stickApply(): void {
    const R = this.radius;
    let dx = this.px - this.ox, dy = this.py - this.oy;
    let d = Math.hypot(dx, dy);
    if (d > R) {
      // Drag the base along behind the thumb: reversing direction then takes
      // one radius of travel, not however far the thumb had drifted.
      const k = (d - R) / d;
      this.ox += dx * k; this.oy += dy * k;
      dx -= dx * k; dy -= dy * k;
      d = R;
    }
    const input = this.game.input;
    let rim = false;
    if (this.driving) {
      // Steering reads sideways travel only, so a thumb resting high or low on the base still steers true.
      const m = Math.abs(dx) / R;
      const t = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD);
      // Soft around the middle: small corrections at speed matter more than full lock.
      input.setTouchMove(Math.sign(dx) * t * (0.45 + 0.55 * t), 0);
    } else {
      const m = d / R;
      const t = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD);
      const out = d > 0 ? t * (0.4 + 0.6 * t) / d : 0;
      // Screen up is forward.
      input.setTouchMove(dx * out, -dy * out);
      rim = m >= (this.sprinting ? RIM_OFF : RIM_ON);
    }
    this.setSprint(rim);
    const s = this.stick.style;
    s.left = this.ox + 'px'; s.top = this.oy + 'px';
    this.knob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
  }

  private setAim(on: boolean): void {
    if (on === this.aimOn) return;
    this.aimOn = on;
    this.aimKey.el.classList.toggle('held', on);
    if (on) this.game.input.touchDown('aim'); else this.game.input.touchUp('aim');
  }

  private setSprint(on: boolean): void {
    if (on === this.sprinting) return;
    this.sprinting = on;
    this.stick.classList.toggle('rim', on);
    if (on) this.game.input.touchDown('sprint'); else this.game.input.touchUp('sprint');
  }

  private stickEnd(): void {
    this.stickId = -1;
    this.setSprint(false);
    this.game.input.setTouchMove(0, 0);
    this.stick.classList.remove('live');
    const s = this.stick.style;
    s.left = ''; s.top = '';
    this.knob.style.transform = '';
  }

  // ── Releasing ──────────────────────────────────────────────────────────────

  /** Let go of every key. `hard` also drops the stick and look fingers (focus lost, controls hidden). */
  private releaseAll(hard = true): void {
    for (const k of this.keys) this.drop(k);
    this.gas = 0; this.brake = 0;
    this.game.input.setTouchPedals(0, 0);
    if (hard) {
      this.ptrs.clear();
      if (this.stickId >= 0 || this.sprinting) this.stickEnd();
      return;
    }
    for (const [id, p] of this.ptrs) if (p.kind === 'key') this.ptrs.delete(id);
    if (this.stickId >= 0) {
      // The thumb that ran to the car is still down. Re-centre the stick under
      // it instead of making it lift: the old push must not become steering.
      this.ox = this.px; this.oy = this.py;
      this.stickApply();
    }
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(_dt: number): void {
    const g = this.game;
    const st = g.state;
    const show = (this.coarse || g.input.touch) && (st === 'play' || st === 'paused');
    if (show !== this.shown) {
      this.shown = show;
      this.root.classList.toggle('show', show);
      if (!show) { this.releaseAll(); this.setAim(false); }
    }
    if (!show) return;

    const paused = st === 'paused';
    if (paused !== this.paused) {
      this.paused = paused;
      this.root.classList.toggle('paused', paused);
      // The press that paused has already been read; nothing may stay held under the menu.
      if (paused) this.releaseAll();
    }

    const player = g.player;
    const driving = player.vehicle !== null;
    if (driving !== this.driving) {
      this.driving = driving;
      this.root.classList.toggle('drive', driving);
      this.root.classList.toggle('foot', !driving);
      this.releaseAll(false);
    }

    // The weapon keys are on the glass once she owns anything beyond her hands.
    const own = player.weapons.owned;
    const armed = own[1] || own[2] || own[3] || own[4];
    if (armed !== this.armed) {
      this.armed = armed;
      this.root.classList.toggle('armed', armed);
    }
    if (this.aimOn && (!armed || driving || paused || !player.canFight)) this.setAim(false);
    const near = !driving && player.nearVehicle !== null;
    if (near !== this.near) {
      this.near = near;
      this.getIn.el.classList.toggle('gone', !near);
      if (!near) this.dropKey(this.getIn);
    }
    const using = !paused && this.game.hud.prompting;
    if (using !== this.using) {
      this.using = using;
      this.useKey.el.classList.toggle('gone', !using);
      if (!using) this.dropKey(this.useKey);
    }
  }

  /** Release one key and forget the fingers on it (it has just left the screen). */
  private dropKey(k: Key): void {
    this.drop(k);
    for (const [id, p] of this.ptrs) if (p.kind === 'key' && p.key === k) this.ptrs.delete(id);
  }
}
