// Unified input: keyboard + mouse, gamepad and touch all feed one action map,
// so the rest of the game never cares which device is in use.
//
// Every gameplay key is a named Action. DEFAULT_KEYS holds the keys a new player gets; a player's own choices
// live in localStorage ('pc.keys', this device only, not the game save) and are applied on top. Code that listens
// for a raw key asks `input.is(e.code, 'photo')` instead of comparing against 'KeyO'.
// A standard-mapping gamepad drives everything: the layout is PAD_BUTTONS and PAD_CHORDS below (hold LB for the
// second layer), panels that are open (addNav) are walked with the d-pad or stick, A and B.

import { clamp } from './util';
import { ACC } from './access';

export type Action =
  | 'enter' | 'jump' | 'fire' | 'aim' | 'reload' | 'nextWeapon' | 'prevWeapon'
  | 'handbrake' | 'horn' | 'radio' | 'pause' | 'map' | 'interact' | 'lookBack' | 'camera' | 'sprint' | 'say' | 'emote' | 'chat'
  | 'forward' | 'back' | 'left' | 'right'
  | 'photo' | 'autopilot' | 'bet' | 'convoy' | 'tutorial' | 'fireworks' | 'replay' | 'spectate' | 'snowball' | 'radar';

/** What the Controls page lists, in order: [action, name, default keys (two slots)]. fire and aim stay on the mouse. */
export const ACTION_LIST: [Action, string, [string, string]][] = [
  ['forward', 'Walk forward / gas', ['KeyW', 'ArrowUp']],
  ['back', 'Walk back / brake', ['KeyS', 'ArrowDown']],
  ['left', 'Left / steer left', ['KeyA', 'ArrowLeft']],
  ['right', 'Right / steer right', ['KeyD', 'ArrowRight']],
  ['sprint', 'Sprint', ['ShiftLeft', 'ShiftRight']],
  ['jump', 'Jump', ['Space', '']],
  ['handbrake', 'Handbrake (Jump also brakes)', ['', '']],
  ['enter', 'Get in or out', ['KeyF', 'Enter']],
  ['interact', 'Use: talk, start a job, pay', ['KeyG', '']],
  ['reload', 'Reload / scoop snow', ['KeyR', '']],
  ['prevWeapon', 'Previous weapon', ['KeyQ', '']],
  ['nextWeapon', 'Next weapon', ['KeyE', '']],
  ['horn', 'Horn', ['KeyH', '']],
  ['radio', 'Radio: next station', ['KeyT', '']],
  ['camera', 'Camera view', ['KeyV', '']],
  ['lookBack', 'Look back', ['KeyC', '']],
  ['say', 'Voice lines (hold)', ['KeyB', '']],
  ['emote', 'Emotes and dances (hold)', ['KeyN', '']],
  ['chat', 'Quick chat and pings (hold)', ['KeyY', '']],
  ['map', 'Map and Places', ['KeyM', 'Tab']],
  ['pause', 'Pause', ['Escape', 'KeyP']],
  ['photo', 'Photo mode', ['KeyO', '']],
  ['replay', 'Replay the last 10 s', ['KeyJ', '']],
  ['autopilot', 'Autopilot', ['KeyI', '']],
  ['bet', 'Bet on a derby', ['KeyZ', '']],
  ['convoy', 'Call a convoy', ['Period', '']],
  ['tutorial', 'Tour: skip a step (hold: end)', ['Comma', '']],
  ['fireworks', 'Light a firework', ['KeyL', '']],
  ['spectate', 'Spectate a player', ['KeyU', '']],
  ['snowball', 'Throw a snowball (holiday)', ['KeyX', '']],
  ['radar', 'Radar: north up or heading up', ['Slash', '']],
];
const ALL_ACTIONS = ACTION_LIST.map((r) => r[0]);
export const DEFAULT_KEYS: Record<string, [string, string]> = {};
for (const [a, , k] of ACTION_LIST) DEFAULT_KEYS[a] = k;

/** Gamepad (standard mapping), plain buttons. */
export const PAD_BUTTONS: [number, Action, string][] = [
  [0, 'jump', 'A'], [1, 'handbrake', 'B'], [2, 'reload', 'X'], [3, 'enter', 'Y'], [5, 'nextWeapon', 'RB'],
  [9, 'pause', 'Start'], [8, 'map', 'Back'], [10, 'sprint', 'L3'], [11, 'lookBack', 'R3'],
  [12, 'radio', 'D-up'], [13, 'horn', 'D-down'], [14, 'camera', 'D-left'], [15, 'interact', 'D-right'],
];
/** Gamepad with LB held (LB alone, let go, is the previous weapon). 'snowball' is LB + RT. */
export const PAD_CHORDS: [number, Action, string][] = [
  [0, 'photo', 'LB+A'], [1, 'autopilot', 'LB+B'], [2, 'chat', 'LB+X'], [3, 'bet', 'LB+Y'],
  [12, 'convoy', 'LB+D-up'], [13, 'tutorial', 'LB+D-down'], [14, 'replay', 'LB+D-left'], [15, 'fireworks', 'LB+D-right'],
  [8, 'spectate', 'LB+Back'], [10, 'emote', 'LB+L3'], [11, 'say', 'LB+R3'],
];
const PAD_LABEL: Partial<Record<Action, string>> = { fire: 'RT', aim: 'LT', prevWeapon: 'LB', snowball: 'LB+RT', forward: 'RT', back: 'LT', left: 'Left stick', right: 'Left stick' };
for (const [, a, l] of PAD_BUTTONS) PAD_LABEL[a] = l;
for (const [, a, l] of PAD_CHORDS) PAD_LABEL[a] = l;
/** Actions that no Input code reads: their listeners hear a key, so a pad chord sends them a key press. */
const RAW_ACTIONS = new Set<Action>(['photo', 'autopilot', 'bet', 'convoy', 'tutorial', 'fireworks', 'replay', 'spectate', 'snowball']);
/** The letter in a prompt like "[G] Talk" and the action it stands for (so a pad or a rebound key can name it instead). */
const PROMPT_KEYS: Record<string, Action> = {
  G: 'interact', F: 'enter', Z: 'bet', O: 'photo', L: 'fireworks', R: 'reload', X: 'snowball', '.': 'convoy', ',': 'tutorial',
  I: 'autopilot', Y: 'chat', T: 'radio', H: 'horn', J: 'replay', U: 'spectate', B: 'say', N: 'emote', V: 'camera', C: 'lookBack', M: 'map',
};

const STORE = 'pc.keys';
const NAMES: Record<string, string> = {
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Backspace: 'Backspace', Delete: 'Del', CapsLock: 'Caps',
};
/** A key code as the player knows it: KeyZ is Z, Digit4 is 4, Period is a full stop. */
export function keyLabel(code: string): string {
  if (!code) return '';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
/** Keys that cannot be bound: the number row (weapons, tabs and menus read it), modifiers other than Shift and Ctrl, F keys, the mouse buttons. */
export function bindable(code: string): boolean {
  return !!code && !/^(Digit|Numpad[0-9]|F[0-9]{1,2}$|Meta|Alt|OS|Context|PrintScreen|ContextMenu)/.test(code) && !code.startsWith('Backspace') && code !== 'Delete';
}

const FOCUSABLE = 'button, [data-a], [data-act], input:not([type=hidden]), select, a[href], [role=button]';
let styled = false;
function ringStyle(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const st = document.createElement('style');
  st.textContent = '.padfocus{outline:3px solid #f0a202 !important;outline-offset:2px;box-shadow:0 0 0 5px rgba(240,162,2,.28) !important}';
  document.head.appendChild(st);
}

export class Input {
  /** Movement / steering. x: +1 = right. y: +1 = forward / accelerate. */
  moveX = 0;
  moveY = 0;
  /** Camera look deltas accumulated this frame (radians-ish, already scaled). */
  lookX = 0;
  lookY = 0;
  /** Scroll wheel steps this frame (weapon switching). */
  wheel = 0;
  /** True when the last input came from a touch screen. */
  touch = false;
  /** What was used last: a keyboard or mouse, a gamepad or the touch screen. Prompts name keys for it. */
  device: 'key' | 'pad' | 'touch' = 'key';
  pointerLocked = false;
  sensitivity = 1;
  invertY = false;
  /** Every key code typed this frame, for cheat-code style easter eggs. */
  typed: string[] = [];
  /** How many keys have ever been typed. The list above is capped, so its length stops changing once it is full. */
  typedN = 0;
  /** Set by photo mode while it is open: the pad then drives its camera (rawPad) and A snaps, B leaves, Y hides the panel. */
  padModal: 'photo' | null = null;
  /** The pad's sticks, always filled in (left x, left y up, right x, right y down, RB, LB, L3), for modes that read them themselves. */
  readonly rawPad = { lx: 0, ly: 0, rx: 0, ry: 0, up: false, down: false, fast: false };

  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private keys = new Set<string>();
  private canvas: HTMLElement;
  private padHeld = new Set<Action>();
  private touchMove = { x: 0, y: 0 };
  private touchHeld = new Set<Action>();
  private gas = 0;
  private brakeAxis = 0;
  private enabled = true;
  // Rebinding: what each action's two slots hold, and the code the other way.
  private bound: Record<string, [string, string]> = {};
  private lookup = new Map<string, Action>();
  // Pad bookkeeping.
  private padPrev: boolean[] = [];
  private chordHeld = new Set<Action>();
  private lbChorded = false;
  private navRoots: HTMLElement[] = [];
  private navT = 0;
  private navDir = '';
  private navWas = false;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    this.loadBindings();
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => { this.keys.clear(); this.held.clear(); });
    canvas.addEventListener('mousedown', (e) => {
      this.device = this.touch ? 'touch' : 'key';
      if (this.touch) return;
      if (!this.pointerLocked) { this.lock(); return; }
      if (e.button === 0) this.press('fire');
      if (e.button === 2) this.press('aim');
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held.delete('fire');
      if (e.button === 2) this.held.delete('aim');
    });
    addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      // Guard against the huge bogus deltas some browsers emit on lock.
      const dx = clamp(e.movementX, -250, 250), dy = clamp(e.movementY, -250, 250);
      this.lookX += dx * 0.0024 * this.sensitivity;
      this.lookY += dy * 0.0024 * this.sensitivity * (this.invertY ? -1 : 1);
    });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) { this.held.delete('fire'); this.held.delete('aim'); }
    });
    addEventListener('touchstart', () => { this.touch = true; this.device = 'touch'; document.body.classList.add('touch'); }, { passive: true, once: false });
  }

  lock(): void {
    if (this.touch || this.pointerLocked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => { /* user gesture required; ignore */ });
    } catch { /* not supported */ }
  }
  unlock(): void { if (document.pointerLockElement) document.exitPointerLock(); }

  setEnabled(on: boolean): void {
    this.enabled = on;
    // Presses are dropped when switching on as well: the key that dismissed the title card
    // (Enter, more often than not) is otherwise still waiting here and puts her in the truck.
    this.pressed.clear();
    if (!on) { this.held.clear(); this.keys.clear(); }
  }

  // ── Bindings ───────────────────────────────────────────────────────────────

  private loadBindings(): void {
    let saved: Record<string, unknown> = {};
    try { const raw = localStorage.getItem(STORE); if (raw) saved = JSON.parse(raw) as Record<string, unknown>; } catch { /* no storage, or damaged */ }
    this.bound = {};
    for (const a of ALL_ACTIONS) {
      const d = DEFAULT_KEYS[a], s = saved[a];
      this.bound[a] = Array.isArray(s) && s.length === 2 && s.every((c) => typeof c === 'string') ? [s[0] as string, s[1] as string] : [d[0], d[1]];
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.lookup.clear();
    for (const a of ALL_ACTIONS) for (const c of this.bound[a]) if (c) this.lookup.set(c, a);
  }

  private saveBindings(): void {
    const out: Record<string, [string, string]> = {};
    for (const a of ALL_ACTIONS) { const d = DEFAULT_KEYS[a], b = this.bound[a]; if (b[0] !== d[0] || b[1] !== d[1]) out[a] = [b[0], b[1]]; }
    try { if (Object.keys(out).length) localStorage.setItem(STORE, JSON.stringify(out)); else localStorage.removeItem(STORE); } catch { /* no storage */ }
  }

  /** The two keys now bound to an action ('' for an empty slot). */
  keysOf(a: Action): [string, string] { const b = this.bound[a] ?? ['', '']; return [b[0], b[1]]; }
  /** Is this key code (a KeyboardEvent.code) bound to that action? */
  is(code: string, a: Action): boolean { return this.lookup.get(code) === a; }
  /** The action a key code is bound to, if any. */
  actionOf(code: string): Action | null { return this.lookup.get(code) ?? null; }
  /** Is the action's key down right now? (for modes that read raw keys themselves). */
  keyDown(a: Action): boolean { for (const c of this.bound[a] ?? []) if (c && this.keys.has(c)) return true; return false; }

  /**
   * Bind a key to one slot of an action. A key already in use elsewhere is swapped: the other action takes the key this slot held
   * (or loses it if the slot was empty). Returns the action that was swapped with, if any. A false slot code clears the slot.
   */
  setKey(a: Action, slot: 0 | 1, code: string): Action | null {
    if (code && !bindable(code)) return null;
    const mine = this.bound[a], old = mine[slot];
    let swapped: Action | null = null;
    const other = code ? this.lookup.get(code) : undefined;
    if (other) {
      const ob = this.bound[other], at = ob[0] === code ? 0 : 1;
      if (other === a && at === slot) return null;
      // The other slot gets the key this one held (maybe nothing); the same action just trades its two keys.
      ob[at] = old;
      if (other !== a) swapped = other;
    }
    mine[slot] = code;
    this.rebuild();
    this.saveBindings();
    return swapped;
  }
  resetKeys(): void {
    for (const a of ALL_ACTIONS) this.bound[a] = [DEFAULT_KEYS[a][0], DEFAULT_KEYS[a][1]];
    this.rebuild();
    this.saveBindings();
  }
  /** True when anything differs from the defaults. */
  customised(): boolean { return ALL_ACTIONS.some((a) => this.bound[a][0] !== DEFAULT_KEYS[a][0] || this.bound[a][1] !== DEFAULT_KEYS[a][1]); }

  /** What to call the action's button for the device in use: "G" at a keyboard, "D-right" on a pad. Empty if nothing is bound. */
  label(a: Action, dev: 'key' | 'pad' | 'touch' = this.device): string {
    if (dev === 'pad') return PAD_LABEL[a] ?? '';
    const k = this.bound[a]?.[0] || this.bound[a]?.[1] || '';
    return keyLabel(k);
  }
  /** A prompt line with its bracketed key letters ("[G] Talk") said the way this player's device says them. */
  relabel(text: string): string {
    if (this.device === 'touch' || (this.device === 'key' && !this.customised())) return text;
    return text.replace(/\[([A-Z.,])\]/g, (m, k: string) => {
      const a = PROMPT_KEYS[k];
      if (!a) return m;
      const l = this.label(a);
      return l ? `[${l}]` : m;
    });
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent, down: boolean): void {
    // Typing in a text box (the cloud save code in Settings) is not the game's.
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    // A key sent by a pad chord (see padChord): the pad's own code already handled it.
    if ((e as unknown as { __pad?: boolean }).__pad) return;
    if (down) this.device = 'key';
    if (e.repeat) { if (this.lookup.has(e.code) || e.code.startsWith('Arrow')) e.preventDefault(); return; }
    if (down) { this.typed.push(e.code); this.typedN++; if (this.typed.length > 32) this.typed.shift(); }
    if (down) this.keys.add(e.code); else this.keys.delete(e.code);
    const a = this.lookup.get(e.code);
    if (a) {
      if (down) this.press(a); else this.held.delete(a);
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    if (down && e.code.startsWith('Digit')) this.digit = Number(e.code.slice(5));
  }
  /** Number key pressed this frame (1-9) or -1. */
  digit = -1;

  private press(a: Action): void { this.held.add(a); this.pressed.add(a); }

  /** Held right now. */
  down(a: Action): boolean {
    if (!this.enabled) return false;
    // Settings > Accessibility > Sprint and aim: press once to switch on, again to switch off.
    if (a === 'sprint' && ACC.toggle) return this.latchSprint;
    if (a === 'aim' && ACC.toggle) return this.latchAim;
    return this.held.has(a) || this.padHeld.has(a) || this.touchHeld.has(a);
  }
  private latchSprint = false; private latchAim = false;
  /** Went down this frame. */
  hit(a: Action): boolean { return this.enabled && this.pressed.has(a); }
  /** Consume a press so nothing else reacts to it this frame. */
  eat(a: Action): boolean { const h = this.hit(a); this.pressed.delete(a); return h; }

  /** Call once per frame before game logic. */
  poll(): void {
    let x = 0, y = 0;
    if (this.keyDown('left')) x -= 1;
    if (this.keyDown('right')) x += 1;
    if (this.keyDown('forward')) y += 1;
    if (this.keyDown('back')) y -= 1;

    // Touch
    x += this.touchMove.x; y += this.touchMove.y;
    if (this.gas || this.brakeAxis) y = this.gas - this.brakeAxis;

    // Gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const prevPad = this.padHeld;
    this.padHeld = new Set();
    this.padTrig = 0; this.padStickY = 0; this.padActive = false;
    const r = this.rawPad;
    r.lx = 0; r.ly = 0; r.rx = 0; r.ry = 0; r.up = false; r.down = false; r.fast = false;
    for (const p of pads) {
      if (!p || !p.connected || p.mapping !== 'standard') continue;
      const dz = (v: number) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
      const lx = dz(p.axes[0] ?? 0), ly = dz(p.axes[1] ?? 0);
      const rx = dz(p.axes[2] ?? 0), ry = dz(p.axes[3] ?? 0);
      const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0;
      const b = p.buttons.map((q) => !!q.pressed);
      b[6] = lt > 0.3 || b[6]; b[7] = rt > 0.3 || b[7];
      const edge = (i: number): boolean => !!b[i] && !this.padPrev[i];
      if (b.some((v) => v) || Math.abs(lx) > 0.5 || Math.abs(ly) > 0.5 || Math.abs(rx) > 0.5 || Math.abs(ry) > 0.5) this.device = 'pad';
      r.lx = lx; r.ly = ly; r.rx = rx; r.ry = ry; r.up = !!b[5]; r.down = !!b[4]; r.fast = !!b[10];
      this.padActive = true;
      // An open panel owns the pad: it moves a focus ring, A presses, B closes.
      const panel = this.navActive();
      if (panel) { this.navTick(panel, p, b, edge); this.padPrev = b; this.navWas = true; break; }
      if (this.navWas) { this.navWas = false; this.navClear(); }
      if (this.padModal === 'photo') {
        if (edge(0)) this.sendKey('Enter');
        if (edge(1)) this.sendKey('Escape');
        if (edge(3)) this.sendKey('KeyH');
        this.padPrev = b;
        break;
      }
      // Input switched off (a title or timing card, a dialogue): A is Enter and B is Escape, whatever is up listens for those.
      if (!this.enabled) { if (edge(0)) this.sendKey('Enter'); if (edge(1)) this.sendKey('Escape'); this.padPrev = b; break; }
      x += lx;
      this.padTrig = rt - lt;
      this.padStickY = -ly;
      y += -ly;
      this.lookX += rx * 0.045 * this.sensitivity;
      this.lookY += ry * 0.03 * this.sensitivity * (this.invertY ? -1 : 1);
      const lb = !!b[4];
      if (lb) {
        // Second layer: LB plus a button. LB on its own, let go, is the previous weapon.
        if (edge(4)) this.lbChorded = false;
        const now = new Set<Action>();
        for (const [i, a] of PAD_CHORDS) if (b[i]) now.add(a);
        if (b[7]) now.add('snowball');
        if (now.size) this.lbChorded = true;
        for (const a of now) { if (RAW_ACTIONS.has(a)) { if (!this.chordHeld.has(a)) this.padChord(a, true); } else this.padHeld.add(a); }
        for (const a of this.chordHeld) if (!now.has(a)) this.padChord(a, false);
        this.chordHeld = now;
      } else {
        if (this.chordHeld.size) { for (const a of this.chordHeld) this.padChord(a, false); this.chordHeld = new Set(); }
        if (this.padPrev[4] && !this.lbChorded) this.pressed.add('prevWeapon');
        for (const [i, a] of PAD_BUTTONS) if (b[i]) this.padHeld.add(a);
        if (rt > 0.3) this.padHeld.add('fire');
        if (lt > 0.3) this.padHeld.add('aim');
      }
      this.padPrev = b;
      break;
    }
    if (!this.padActive) { this.padPrev = []; if (this.navWas) { this.navWas = false; this.navClear(); } }
    for (const a of this.padHeld) if (!prevPad.has(a)) this.pressed.add(a);
    if (ACC.toggle && this.enabled) {
      if (this.pressed.has('sprint')) this.latchSprint = !this.latchSprint;
      if (this.pressed.has('aim')) this.latchAim = !this.latchAim;
    } else { this.latchSprint = false; this.latchAim = false; }

    this.moveX = this.enabled ? clamp(x, -1, 1) : 0;
    this.moveY = this.enabled ? clamp(y, -1, 1) : 0;
    if (!this.enabled) { this.lookX = 0; this.lookY = 0; }
  }
  /** Gamepad triggers as a single accelerate(+)/brake(-) axis, used when driving. */
  padTrig = 0;
  padStickY = 0;
  padActive = false;

  /** A chord went down or up: actions only a key listener hears get a key down on press and a key up on release (so the tour key's tap and hold work). */
  private padChord(a: Action, down: boolean): void {
    if (!RAW_ACTIONS.has(a)) return;
    const c = this.bound[a][0] || this.bound[a][1];
    if (c) this.sendKey(c, down ? 'down' : 'up');
  }
  /** Send a key press (down, then up unless asked for only one half) to the window as if typed. Flagged so Input itself ignores it. */
  private sendKey(code: string, mode: 'tap' | 'down' | 'up' = 'tap'): void {
    const mk = (type: string): void => {
      const ev = new KeyboardEvent(type, { code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, bubbles: true, cancelable: true });
      Object.defineProperty(ev, '__pad', { value: true });
      dispatchEvent(ev);
    };
    if (mode !== 'down') { if (mode === 'tap') mk('keydown'); mk('keyup'); } else mk('keydown');
  }

  // ── Panels: d-pad and stick walk a focus ring ──────────────────────────────

  /** Register a modal panel's root element: while it has class "on" the pad moves a focus ring in it (the d-pad or stick), A presses, B sends Escape. */
  addNav(el: HTMLElement): void { ringStyle(); this.navRoots.push(el); }
  private navActive(): HTMLElement | null {
    for (let i = this.navRoots.length - 1; i >= 0; i--) if (this.navRoots[i].classList.contains('on')) return this.navRoots[i];
    return null;
  }
  private focusables(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0);
  }
  private navClear(): void { document.querySelectorAll('.padfocus').forEach((e) => e.classList.remove('padfocus')); }
  private navFocus(el: HTMLElement): void {
    this.navClear();
    el.classList.add('padfocus');
    try { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); } catch { /* detached */ }
  }
  private navTick(root: HTMLElement, p: Gamepad, b: boolean[], edge: (i: number) => boolean): void {
    this.padTrig = 0; this.padStickY = 0;
    const els = this.focusables(root);
    let cur = els.find((e) => e.classList.contains('padfocus'));
    if (!cur) { if (els.length) { cur = els[0]; this.navFocus(cur); } }
    const now = performance.now();
    let dir = '';
    if (b[12]) dir = 'u'; else if (b[13]) dir = 'd'; else if (b[14]) dir = 'l'; else if (b[15]) dir = 'r';
    else {
      const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
      if (Math.abs(ay) > 0.6 && Math.abs(ay) >= Math.abs(ax)) dir = ay < 0 ? 'u' : 'd';
      else if (Math.abs(ax) > 0.6) dir = ax < 0 ? 'l' : 'r';
    }
    if (!dir) this.navDir = '';
    else if (dir !== this.navDir || now - this.navT > 240) {
      const first = dir !== this.navDir;
      if (first || now - this.navT > 240) {
        this.navDir = dir; this.navT = now;
        if (cur) this.navStep(els, cur, dir);
      }
    }
    if (edge(0)) {
      const f = els.find((e) => e.classList.contains('padfocus'));
      if (f) f.click(); else this.sendKey('Enter');
    }
    if (edge(1)) this.sendKey('Escape');
  }
  private navStep(els: HTMLElement[], cur: HTMLElement, dir: string): void {
    const c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    const vx = dir === 'l' ? -1 : dir === 'r' ? 1 : 0, vy = dir === 'u' ? -1 : dir === 'd' ? 1 : 0;
    let best: HTMLElement | null = null, bs = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      const along = dx * vx + dy * vy, across = Math.abs(vx ? dy : dx);
      if (along < 2) continue;
      const s = along + across * 2.2;
      if (s < bs) { bs = s; best = e; }
    }
    if (!best) {
      // Nothing that way: a list reads in order, so down and right step on, up and left step back.
      const i = els.indexOf(cur), j = i + (vx + vy);
      if (j >= 0 && j < els.length) best = els[j];
    }
    if (best) this.navFocus(best);
  }

  /** Buzz the pad (a crash). Quietly nothing where the pad has no motors or the browser has no API. */
  rumble(strength: number, ms = 180): void {
    if (this.device !== 'pad') return;
    for (const p of navigator.getGamepads ? navigator.getGamepads() : []) {
      const v = p && (p as unknown as { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }).vibrationActuator;
      if (p && p.connected && v && v.playEffect) { v.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strength, 0, 1), weakMagnitude: clamp(strength * 0.7, 0, 1) }).catch(() => { /* not allowed */ }); break; }
    }
  }

  /** Call at the very end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.lookX = 0; this.lookY = 0; this.wheel = 0; this.digit = -1;
  }

  // ── Touch hooks (driven by ui/touch.ts) ────────────────────────────────────
  setTouchMove(x: number, y: number): void { this.touchMove.x = x; this.touchMove.y = y; }
  setTouchPedals(gas: number, brake: number): void { this.gas = gas; this.brakeAxis = brake; }
  addLook(dx: number, dy: number): void {
    this.lookX += dx * 0.0052 * this.sensitivity;
    this.lookY += dy * 0.0052 * this.sensitivity * (this.invertY ? -1 : 1);
  }
  touchDown(a: Action): void { if (!this.touchHeld.has(a)) this.pressed.add(a); this.touchHeld.add(a); }
  touchUp(a: Action): void { this.touchHeld.delete(a); }
}
