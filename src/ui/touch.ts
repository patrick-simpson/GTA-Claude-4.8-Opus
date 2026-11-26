// Touch controls for phones and tablets: a floating stick under the left
// thumb, pedals or JUMP under the right, and look-drag on whatever is left.
//
// Everything is event driven through Pointer Events and feeds the hooks at the
// bottom of core/input.ts; update() only decides which layout is on screen.
// All listeners sit on the #touch root (pointer events bubble from the
// captured key), so there is one code path for every finger.

import './touch.css';
import { kid } from '../core/kid';
import type { Game } from '../core/game';
import type { Action } from '../core/input';
import { isBoatKind, isCycleKind } from '../ent/vehicleSpecs';

// ── Preferences (kept in this browser only: localStorage 'pc.touch', never the game save) ──────────────────────
// Every default is today's layout exactly: normal size, full opacity, right-handed, every button, stick steering,
// gas by thumb, no moved keys. Nothing changes until a player picks something in Settings.

export type TouchSize = 'small' | 'normal' | 'large';
export interface TouchPrefsData {
  size: TouchSize;
  /** Key opacity, 0.4 to 1. */
  opacity: number;
  /** Mirror the thumb clusters (stick to the right, pedals to the left). The pause and top keys stay where the radar is not. */
  left: boolean;
  /** Ids of the buttons the player has hidden. Only the ones in HIDEABLE can be. */
  hide: string[];
  tilt: boolean;
  /** Tilt sensitivity, 0.5 (slow) to 2 (quick). */
  sens: number;
  /** Tilt dead zone in degrees. */
  dead: number;
  /** Cars drive forward on their own; the brake still stops and reverses. */
  auto: boolean;
  /** Dragged buttons: id to [dx, dy] in CSS pixels from where the stylesheet puts them. */
  layout: Record<string, [number, number]>;
}
/** The buttons that can be hidden. Gas, brake, the stick, Jump, Fire, Exit, Get in, Use and Pause cannot: without them the game cannot be played. */
export const HIDEABLE: readonly (readonly [string, string])[] = [
  ['emote', 'Emote'], ['chat', 'Chat'], ['replay', 'Replay'], ['photo', 'Photo'], ['radio', 'Radio'], ['horn', 'Horn'],
  ['cam', 'Camera'], ['hand', 'Handbrake'], ['aim', 'Aim'], ['swap', 'Swap'], ['say', 'Say'],
];
const TSTORE = 'pc.touch';
const DEFAULTS: TouchPrefsData = { size: 'normal', opacity: 1, left: false, hide: [], tilt: false, sens: 1, dead: 4, auto: false, layout: {} };
const SCALE: Record<TouchSize, number> = { small: 0.8, normal: 1, large: 1.2 };
const clampN = (v: unknown, lo: number, hi: number, d: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

class TouchPrefsStore {
  v: TouchPrefsData = { ...DEFAULTS, hide: [], layout: {} };
  private subs: Array<() => void> = [];
  constructor() {
    try {
      const r = JSON.parse(localStorage.getItem(TSTORE) ?? 'null') as Partial<TouchPrefsData> | null;
      if (r && typeof r === 'object') {
        const v = this.v;
        if (r.size === 'small' || r.size === 'large') v.size = r.size;
        v.opacity = clampN(r.opacity, 0.4, 1, 1);
        v.left = r.left === true; v.tilt = r.tilt === true; v.auto = r.auto === true;
        v.sens = clampN(r.sens, 0.5, 2, 1); v.dead = clampN(r.dead, 0, 12, 4);
        if (Array.isArray(r.hide)) v.hide = r.hide.filter((id) => HIDEABLE.some((h) => h[0] === id));
        if (r.layout && typeof r.layout === 'object') for (const [k, p] of Object.entries(r.layout)) {
          if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) v.layout[k] = [clampN(p[0], -2000, 2000, 0), clampN(p[1], -2000, 2000, 0)];
        }
      }
    } catch { /* private mode, or a damaged entry: the defaults stand */ }
  }
  /** Is anything different from the stock layout? */
  get custom(): boolean { return JSON.stringify(this.v) !== JSON.stringify(DEFAULTS); }
  on(fn: () => void): void { this.subs.push(fn); }
  set(patch: Partial<TouchPrefsData>): void {
    Object.assign(this.v, patch);
    this.save();
  }
  /** Save and tell the touch layer. */
  save(): void {
    try {
      if (this.custom) localStorage.setItem(TSTORE, JSON.stringify(this.v)); else localStorage.removeItem(TSTORE);
    } catch { /* storage full or blocked: it works for this visit */ }
    for (const f of this.subs) f();
  }
  shown(id: string): boolean { return !this.v.hide.includes(id); }
  toggleHide(id: string): void {
    const h = this.v.hide;
    this.v.hide = h.includes(id) ? h.filter((x) => x !== id) : [...h, id];
    this.save();
  }
  resetLayout(): void { this.v.layout = {}; this.save(); }
  resetAll(): void { this.v = { ...DEFAULTS, hide: [], layout: {} }; this.save(); }
}
export const touchPrefs = new TouchPrefsStore();
/** Where tilt steering stands: not asked yet, working, refused by the phone, or no sensor on this device. */
export type TiltState = 'idle' | 'wait' | 'ready' | 'denied' | 'none';

/** The wheel angle, in degrees clockwise, from a deviceorientation reading and the screen's rotation; null when the phone lies too flat to tell. */
export function wheelAngle(beta: number, gamma: number, screenAngle: number): number | null {
  const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  // Which way is up, in the phone's own axes (x right, y toward the top edge of a portrait phone).
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b);
  // Then in the screen's axes, which turn with the phone.
  const a = ((Math.round(screenAngle / 90) % 4) + 4) % 4;
  const sx = a === 0 ? ux : a === 1 ? -uy : a === 2 ? -ux : uy;
  const sy = a === 0 ? uy : a === 1 ? ux : a === 2 ? -uy : -ux;
  if (Math.hypot(sx, sy) < 0.3) return null;
  return Math.atan2(-sx, sy) * 180 / Math.PI;
}

/** Stick travel, as a fraction of the base radius, that counts as no input. */
const DEAD = 0.14;
/** Sprint engages at the rim and lets go a little inside it, so a trembling thumb does not flutter. */
const RIM_ON = 0.94, RIM_OFF = 0.8;
/** A thumb may stray this far (px) off a pedal before it counts as having left it. */
const SLOP = 12;

interface Key {
  el: HTMLElement;
  id: string;
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
  | { kind: 'key'; key: Key | null; slide: boolean; x: number; y: number }
  | { kind: 'drag'; key: Key; x: number; y: number; dx: number; dy: number };

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
  private sayKey!: Key;
  private autoKey!: Key;
  private autoOn = false;
  private sayOn = false;
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
  // Preferences at work (touchPrefs): tilt state, the auto-gas flag, edit mode.
  private tiltState: TiltState = 'idle';
  private tiltRaw: number | null = null;
  private tiltZero = 0;
  /** Steering from the tilt, -1 to 1, as of the last reading. */
  private tiltOut = 0;
  private tiltWatch = 0;
  private autoGas = false;
  private editing = false;
  private editDrive = false;
  private bar!: HTMLElement;

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
    const pedals = (): void => this.pedals();

    act('t-jump foot', '01', 'Jump', 'jump').id = 'jump';
    this.getIn = act('t-getin foot gone', '02', 'Get in', 'enter');
    this.getIn.id = 'getin';

    this.key('t-gas drive', '03', 'Gas', () => { this.gas = 1; pedals(); }, () => { this.gas = 0; pedals(); }, true).id = 'gas';
    this.key('t-brake drive', '04', 'Brake', () => { this.brake = 1; pedals(); }, () => { this.brake = 0; pedals(); }, true).id = 'brake';
    const hand = act('t-hand drive', '05', 'Hand<br>brake', 'handbrake');
    hand.slide = true; hand.id = 'hand';
    act('t-horn drive', '06', GLYPH.horn + '<small>Horn</small>', 'horn').id = 'horn';
    act('t-exit drive', '07', 'Exit', 'enter').id = 'exit';
    act('t-cam drive', '08', GLYPH.camera + '<small>Camera</small>', 'camera').id = 'cam';
    // The radio dial, over the horn: one tap, one station on (src/audio/radio.ts). Placed here, not in touch.css, beside its only use.
    const radio = act('t-radio drive', '12', 'Radio', 'radio');
    radio.id = 'radio';
    radio.el.style.cssText = 'inset-inline-end:calc(var(--sr) + var(--u) * 3 + var(--g) * 2);bottom:calc(var(--sb) + var(--u) * 2.1 + var(--g));width:calc(var(--u) * 1.3);height:var(--u);font-size:calc(var(--u) * 0.27);';
    // Weapons: FIRE above JUMP (above the pedals at the wheel), AIM and SWAP beside it. Only when she has something to fire.
    const fire = act('t-fire arm', '09', 'Fire', 'fire');
    fire.look = true; fire.id = 'fire';
    this.aimKey = this.key('t-aim arm', '10', 'Aim', () => this.setAim(!this.aimOn), () => { /* a latch: lifting the thumb changes nothing */ });
    this.aimKey.id = 'aim';
    act('t-swap arm', '11', 'Swap', 'nextWeapon').id = 'swap';
    // Talk, start a job, pay: on the glass only while a prompt that wants it is up (missions and jobs, src/game/).
    this.useKey = act('t-use always gone', '12', 'Use', 'interact');
    this.useKey.id = 'use';
    // Say: a wave and a few fixed lines, one per press, only while somebody else is in town (src/net/).
    this.sayKey = act('t-say gone', '', 'Say', 'say');
    this.sayKey.id = 'say';
    act('t-pause always top', '', GLYPH.pause, 'pause').id = 'pause';
    // Emotes and horn tunes (game/emotes.ts): one tap opens the wheel, a tap on a choice plays it. Under PHOTO.
    const emote = act('t-emote always top', '', 'Emote', 'emote');
    emote.id = 'emote';
    emote.el.style.cssText = 'right:var(--sr);top:calc(var(--st) + var(--pw) + var(--mh) * 2 + 3 * var(--g));width:var(--pw);height:var(--mh);font-size:calc(10px * var(--km));letter-spacing:0;';
    // Quick chat (game/chat.ts): one tap or a long press opens the wheel. Beside EMOTE.
    const chat = act('t-chat always top', '', 'Chat', 'chat');
    chat.id = 'chat';
    chat.el.style.cssText = 'right:calc(var(--sr) + var(--pw) + var(--g));top:calc(var(--st) + var(--pw) + var(--mh) * 2 + 3 * var(--g));width:var(--pw);height:var(--mh);font-size:calc(10px * var(--km));letter-spacing:0;';
    // Replay the last ten seconds (fx/replay.ts): a small key under pause, styled here beside its only use.
    const replay = this.key('t-replay always top', '', 'Replay', () => game.cam.replay.rewatch(), () => { /* one press, one replay */ });
    replay.id = 'replay';
    replay.el.style.cssText = 'right:var(--sr);top:calc(var(--st) + var(--pw) + var(--g));width:var(--pw);height:var(--mh);font-size:calc(10px * var(--km));letter-spacing:0;';
    // Photo mode (fx/photo.ts), under REPLAY.
    const photo = this.key('t-photo always top', '', 'Photo', () => game.photo.toggle(), () => { /* one press */ });
    photo.id = 'photo';
    photo.el.style.cssText = 'right:var(--sr);top:calc(var(--st) + var(--pw) + var(--mh) + 2 * var(--g));width:var(--pw);height:var(--mh);font-size:calc(10px * var(--km));letter-spacing:0;';

    // "Drive me there" (game/autopilot.ts): under the street banner, only at the wheel with a route set and nothing forbidding it. While it drives, the chip's Cancel (or any pedal) is the way out.
    this.autoKey = this.key('t-auto drive top', '', 'Drive me<br>there', () => game.todo.autopilot.toggle(), () => { /* one press */ });
    this.autoKey.el.style.cssText = 'left:50%;margin-left:-44px;top:calc(var(--st) + 74px);width:88px;height:40px;font-size:10px;line-height:1.05;letter-spacing:0;text-align:center;display:none;';

    // Edit layout: a bar with the two views, Reset and Done, only while she is arranging the keys.
    this.bar = this.div('t-editbar');
    this.bar.innerHTML = '<b>Drag the keys</b><button type="button" data-e="view">In a car</button><button type="button" data-e="reset">Reset layout</button><button type="button" data-e="done">Done</button>';

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

    touchPrefs.on(() => this.applyPrefs());
    this.applyPrefs();
    // A saved tilt choice starts listening again where no permission is needed (everywhere but iOS); iOS asks again on the next press of the switch.
    if (touchPrefs.v.tilt) this.listenTilt();
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  /** Put the saved choices on the glass: size, opacity, hand, hidden keys, moved keys. Cheap; runs on a change only. */
  private applyPrefs(): void {
    const p = touchPrefs.v, r = this.root;
    const ks = SCALE[p.size];
    const set = (k: string, v: string): void => { if (v) r.style.setProperty(k, v); else r.style.removeProperty(k); };
    // Normal leaves every variable unset, so the stylesheet's own values stand untouched.
    set('--ks', p.size === 'normal' ? '' : String(ks));
    set('--km', p.size === 'small' ? '0.8' : '');
    set('--ko', p.opacity < 1 ? String(p.opacity) : '');
    r.classList.toggle('lefty', p.left);
    r.classList.toggle('big', p.size === 'large');
    r.classList.toggle('custom', touchPrefs.custom);
    r.classList.toggle('tilt', p.tilt && this.tiltState === 'ready');
    for (const k of this.keys) {
      const hidden = p.hide.includes(k.id);
      if (hidden !== k.el.classList.contains('hid')) {
        k.el.classList.toggle('hid', hidden);
        if (hidden) this.dropKey(k);
      }
      const o = p.layout[k.id];
      k.el.style.translate = o ? `${o[0]}px ${o[1]}px` : '';
    }
    if (p.tilt && this.tiltState === 'idle') this.listenTilt();
    if (!p.tilt && this.tiltWatch) this.stopTilt();
    if (!p.auto && this.autoGas) { this.autoGas = false; this.pedals(); }
    r.classList.toggle('auto', p.auto);
  }

  private pedals(): void {
    // Auto-accelerate: with it on, an untouched gas is a held gas, and the brake takes it back (so a brake press stops the car and, held, reverses it).
    const g = this.autoGas && this.brake === 0 ? 1 : this.gas;
    this.game.input.setTouchPedals(g, this.brake);
  }

  // ── Tilt ───────────────────────────────────────────────────────────────────

  get tilt(): TiltState { return this.tiltState; }
  /** The wheel angle now, degrees clockwise from the calibrated hold (for the menu and tests), or null. */
  get tiltAngle(): number | null { return this.tiltRaw === null ? null : this.tiltRaw - this.tiltZero; }

  /**
   * Turn tilt steering on. Must be called from a press (iOS asks for motion permission only then). Resolves to the new state:
   * 'ready' (readings are coming in), 'denied' (iOS said no) or 'none' (this device has no sensor; the stick stays).
   */
  async enableTilt(): Promise<TiltState> {
    const DOE = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!DOE) { this.tiltState = 'none'; return 'none'; }
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') { this.tiltState = 'denied'; return 'denied'; }
      } catch { this.tiltState = 'denied'; return 'denied'; }
    }
    this.tiltRaw = null;
    this.listenTilt();
    this.tiltState = 'wait';
    // A phone with a sensor reports within a moment; a desktop sends one empty reading or none: say so and keep the stick.
    await new Promise<void>((res) => setTimeout(res, 900));
    if (this.tiltRaw === null && (this.tiltState as TiltState) === 'wait') this.tiltState = 'none';
    this.applyPrefs();
    return this.tiltState;
  }

  private onTilt = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null || e.beta === undefined || e.gamma === undefined) return;
    const a = screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
    const w = wheelAngle(e.beta, e.gamma, a);
    if (w === null) return;
    if (this.tiltRaw === null) this.tiltZero = w;   // the first reading is her natural hold
    this.tiltRaw = w;
    if (this.tiltState === 'wait') { this.tiltState = 'ready'; this.applyPrefs(); }
  };

  private listenTilt(): void {
    if (this.tiltWatch) return;
    this.tiltWatch = 1;
    this.tiltState = 'wait';
    addEventListener('deviceorientation', this.onTilt);
  }

  private stopTilt(): void {
    removeEventListener('deviceorientation', this.onTilt);
    this.tiltWatch = 0; this.tiltState = 'idle'; this.tiltRaw = null; this.tiltOut = 0;
    this.stick.classList.remove('tilting');
    if (this.stickId < 0) { this.game.input.setTouchMove(0, 0); this.knob.style.transform = ''; }
    this.root.classList.remove('tilt');
  }

  /** Make the way the phone is held now the straight-ahead. */
  calibrate(): void { if (this.tiltRaw !== null) this.tiltZero = this.tiltRaw; }

  /** The tilt as steering, -1 to 1. */
  private tiltSteer(): number {
    if (this.tiltRaw === null) return 0;
    let d = this.tiltRaw - this.tiltZero;
    d = ((d + 540) % 360) - 180;
    const p = touchPrefs.v;
    const max = 38 / p.sens;                 // degrees of wheel turn for full lock
    const m = Math.abs(d);
    if (m <= p.dead) return 0;
    const t = Math.min(1, (m - p.dead) / Math.max(4, max - p.dead));
    return Math.sign(d) * t * (0.45 + 0.55 * t);
  }

  // ── Edit layout ────────────────────────────────────────────────────────────

  /** Let the player drag the keys to new places. The game runs on; the bar has Done and Reset layout. */
  beginEdit(): void {
    this.editing = true;
    this.editDrive = this.game.player.vehicle !== null;
    this.releaseAll();
    this.setEditClasses();
  }
  private endEdit(): void {
    this.editing = false;
    this.root.classList.remove('edit', 'armed');
    this.driving = null; this.armed = false;   // update() puts the real layout back
  }
  private setEditClasses(): void {
    const r = this.root;
    r.classList.add('edit', 'armed');
    r.classList.toggle('drive', this.editDrive);
    r.classList.toggle('foot', !this.editDrive);
    (this.bar.querySelector('[data-e="view"]') as HTMLElement).textContent = this.editDrive ? 'On foot' : 'In a car';
  }
  private editBar(b: HTMLElement): void {
    const what = b.dataset.e;
    if (what === 'view') { this.editDrive = !this.editDrive; this.setEditClasses(); }
    else if (what === 'reset') touchPrefs.resetLayout();
    else if (what === 'done') this.endEdit();
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
    const k: Key = { el, id: '', n: 0, down, up, slide, l: 0, t: 0, r: 0, b: 0 };
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
    if (this.editing) {
      // Arranging: a key is dragged, never pressed; the bar's buttons act at once.
      const btn = target.closest<HTMLElement>('.t-editbar button');
      if (btn) { this.editBar(btn); e.preventDefault(); return; }
      if (!key || key.id === 'pause') return;
      const o = touchPrefs.v.layout[key.id] ?? [0, 0];
      p = { kind: 'drag', key, x: e.clientX, y: e.clientY, dx: o[0], dy: o[1] };
      this.ptrs.set(e.pointerId, p);
      try { (target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      e.preventDefault();
      return;
    }
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
    if (p.kind === 'drag') {
      const nx = p.dx + e.clientX - p.x, ny = p.dy + e.clientY - p.y;
      // Keep the key on the glass: it may not leave any edge.
      const r = p.key.el.getBoundingClientRect();
      const o = touchPrefs.v.layout[p.key.id];
      const bx = r.left - (o?.[0] ?? 0), by = r.top - (o?.[1] ?? 0);   // where it sits with no offset
      const cx = Math.round(Math.min(innerWidth - r.width - bx - 4, Math.max(4 - bx, nx)));
      const cy = Math.round(Math.min(innerHeight - r.height - by - 4, Math.max(4 - by, ny)));
      touchPrefs.v.layout[p.key.id] = [cx, cy];
      p.key.el.style.translate = `${cx}px ${cy}px`;
    } else if (p.kind === 'look') {
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
    if (p.kind === 'drag') touchPrefs.save();
    else if (p.kind === 'key') { if (p.key) this.release(p.key); }
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
    this.pedals();
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
    if (this.editing) { this.setEditClasses(); return; }
    const driving = player.seated !== null;
    if (driving !== this.driving) {
      this.driving = driving;
      this.root.classList.toggle('drive', driving);
      this.root.classList.toggle('foot', !driving);
      this.releaseAll(false);
    }

    // The weapon keys are on the glass once she owns anything beyond her hands.
    const own = player.weapons.owned;
    // (Kid-friendly mode, core/kid.ts: nothing to fire, so no FIRE, AIM or SWAP.)
    const armed = !kid.on && (own[1] || own[2] || own[3] || own[4]);
    if (armed !== this.armed) {
      this.armed = armed;
      this.root.classList.toggle('armed', armed);
    }
    if (this.aimOn && (!armed || driving || paused || !player.canFight)) this.setAim(false);
    this.updateDriveAids(driving, paused);
    const near = !driving && (player.nearVehicle !== null || player.rideNear !== null);
    if (near !== this.near) {
      this.near = near;
      this.getIn.el.classList.toggle('gone', !near);
      if (!near) this.dropKey(this.getIn);
    }
    const auto = driving && !paused && g.todo.autopilot.offer;
    if (auto !== this.autoOn) {
      this.autoOn = auto;
      this.autoKey.el.style.display = auto ? '' : 'none';
      if (!auto) this.dropKey(this.autoKey);
    }
    const talk = !paused && g.net.canSay;
    if (talk !== this.sayOn) {
      this.sayOn = talk;
      this.sayKey.el.classList.toggle('gone', !talk);
      if (!talk) this.dropKey(this.sayKey);
    }
    const using = !paused && this.game.hud.prompting;
    if (using !== this.using) {
      this.using = using;
      this.useKey.el.classList.toggle('gone', !using);
      if (!using) this.dropKey(this.useKey);
    }
  }

  /** Auto-accelerate and tilt steering, once a frame. Both are about the wheel of a car she is driving; neither runs under the menu. */
  private updateDriveAids(driving: boolean, paused: boolean): void {
    const g = this.game, p = touchPrefs.v, v = g.player.vehicle;
    // Cars only. A boat would sail off the dock, a bike or scooter has no brake to hold, a train is a train: gas by thumb there.
    const car = driving && v !== null && v.driver === 'player' && !v.sunk && !isBoatKind(v.spec.kind) && !isCycleKind(v.spec.kind) && v.spec.kind !== 'train';
    // Autopilot ends at the first pedal or wheel input, so the aids stand aside while it drives.
    const ap = g.todo.autopilot.active;
    const auto = p.auto && car && !paused && !ap;
    if (auto !== this.autoGas) { this.autoGas = auto; this.root.classList.toggle('autogas', auto); this.pedals(); }
    const tilting = p.tilt && this.tiltState === 'ready' && car && !paused && !ap;
    if (tilting) {
      this.tiltOut = this.tiltSteer();
      // A thumb on the stick steers instead; lift it and the tilt takes the wheel back.
      if (this.stickId < 0) {
        g.input.setTouchMove(this.tiltOut, 0);
        this.knob.style.transform = `translate(${(this.tiltOut * this.stick.offsetWidth * 0.32).toFixed(1)}px,0)`;
      }
      this.stick.classList.add('tilting');
    } else if (this.stick.classList.contains('tilting')) {
      this.stick.classList.remove('tilting');
      this.tiltOut = 0;
      if (this.stickId < 0) { g.input.setTouchMove(0, 0); this.knob.style.transform = ''; }
    }
  }

  /** Release one key and forget the fingers on it (it has just left the screen). */
  private dropKey(k: Key): void {
    this.drop(k);
    for (const [id, p] of this.ptrs) if (p.kind === 'key' && p.key === k) this.ptrs.delete(id);
  }
}
