// Unified input: keyboard + mouse, gamepad and touch all feed one action map,
// so the rest of the game never cares which device is in use.

import { clamp } from './util';

export type Action =
  | 'enter' | 'jump' | 'fire' | 'aim' | 'reload' | 'nextWeapon' | 'prevWeapon'
  | 'handbrake' | 'horn' | 'radio' | 'pause' | 'map' | 'interact' | 'lookBack' | 'camera' | 'sprint' | 'say' | 'emote';

const KEYMAP: Record<string, Action> = {
  KeyF: 'enter', Enter: 'enter',
  Space: 'jump',
  KeyR: 'reload',
  KeyQ: 'prevWeapon', KeyE: 'nextWeapon',
  KeyH: 'horn',
  KeyT: 'radio',
  Escape: 'pause', KeyP: 'pause',
  KeyM: 'map', Tab: 'map',
  KeyG: 'interact',
  KeyC: 'lookBack',
  KeyV: 'camera',
  KeyB: 'say',
  KeyN: 'emote',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
};

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
  pointerLocked = false;
  sensitivity = 1;
  invertY = false;
  /** Every key code typed this frame, for cheat-code style easter eggs. */
  typed: string[] = [];
  /** How many keys have ever been typed. The list above is capped, so its length stops changing once it is full. */
  typedN = 0;

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

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => { this.keys.clear(); this.held.clear(); });
    canvas.addEventListener('mousedown', (e) => {
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
    addEventListener('touchstart', () => { this.touch = true; document.body.classList.add('touch'); }, { passive: true, once: false });
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

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) { if (KEYMAP[e.code] || e.code.startsWith('Arrow')) e.preventDefault(); return; }
    if (down) { this.typed.push(e.code); this.typedN++; if (this.typed.length > 32) this.typed.shift(); }
    if (down) this.keys.add(e.code); else this.keys.delete(e.code);
    const a = KEYMAP[e.code];
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
  down(a: Action): boolean { return this.enabled && (this.held.has(a) || this.padHeld.has(a) || this.touchHeld.has(a)); }
  /** Went down this frame. */
  hit(a: Action): boolean { return this.enabled && this.pressed.has(a); }
  /** Consume a press so nothing else reacts to it this frame. */
  eat(a: Action): boolean { const h = this.hit(a); this.pressed.delete(a); return h; }

  /** Call once per frame before game logic. */
  poll(): void {
    let x = 0, y = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;

    // Touch
    x += this.touchMove.x; y += this.touchMove.y;
    if (this.gas || this.brakeAxis) y = this.gas - this.brakeAxis;

    // Gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const prevPad = this.padHeld;
    this.padHeld = new Set();
    this.padTrig = 0; this.padStickY = 0; this.padActive = false;
    for (const p of pads) {
      if (!p || !p.connected || p.mapping !== 'standard') continue;
      const dz = (v: number) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
      const lx = dz(p.axes[0] ?? 0), ly = dz(p.axes[1] ?? 0);
      const rx = dz(p.axes[2] ?? 0), ry = dz(p.axes[3] ?? 0);
      const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0;
      x += lx;
      this.padTrig = rt - lt;
      this.padStickY = -ly;
      y += -ly;
      this.lookX += rx * 0.045 * this.sensitivity;
      this.lookY += ry * 0.03 * this.sensitivity * (this.invertY ? -1 : 1);
      const map: [number, Action][] = [
        [0, 'jump'], [1, 'handbrake'], [2, 'reload'], [3, 'enter'], [4, 'prevWeapon'], [5, 'nextWeapon'],
        [9, 'pause'], [8, 'map'], [10, 'sprint'], [11, 'lookBack'], [12, 'radio'], [13, 'horn'], [14, 'camera'], [15, 'interact'],
      ];
      for (const [i, a] of map) if (p.buttons[i]?.pressed) this.padHeld.add(a);
      if (rt > 0.3) this.padHeld.add('fire');
      if (lt > 0.3) this.padHeld.add('aim');
      this.padActive = true;
      break;
    }
    for (const a of this.padHeld) if (!prevPad.has(a)) this.pressed.add(a);

    this.moveX = this.enabled ? clamp(x, -1, 1) : 0;
    this.moveY = this.enabled ? clamp(y, -1, 1) : 0;
    if (!this.enabled) { this.lookX = 0; this.lookY = 0; }
  }
  /** Gamepad triggers as a single accelerate(+)/brake(-) axis, used when driving. */
  padTrig = 0;
  padStickY = 0;
  padActive = false;

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
