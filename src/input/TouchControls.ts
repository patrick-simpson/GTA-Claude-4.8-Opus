import type { ControlState } from '../types';

const JOYSTICK_RADIUS = 54; // pixels

type ActionMode = 'enter' | 'exit' | 'inactive';

export class TouchControls {
  private state: ControlState = {
    joystickX:     0,
    joystickY:     0,
    throttle:      0,
    brake:         0,
    actionPressed: false,
  };

  // Touch tracking
  private joystickTouchId: number | null = null;
  private joystickOriginX = 0;
  private joystickOriginY = 0;

  private gasActive    = false;
  private brakeActive  = false;

  // DOM refs
  private readonly knob:      HTMLElement;
  private readonly btnGas:    HTMLElement;
  private readonly btnBrake:  HTMLElement;
  private readonly btnAction: HTMLElement;

  // Keyboard state
  private keys = new Set<string>();

  // Cleanup
  private readonly _cleanups: (() => void)[] = [];

  constructor() {
    this.knob      = document.getElementById('joystick-knob')!;
    this.btnGas    = document.getElementById('btn-gas')!;
    this.btnBrake  = document.getElementById('btn-brake')!;
    this.btnAction = document.getElementById('btn-action')!;

    this._setupJoystick();
    this._setupButtons();
    this._setupKeyboard();
  }

  // ── Joystick ──────────────────────────────────────────────────────────────
  private _setupJoystick(): void {
    const zone = document.getElementById('joystick-zone')!;

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      if (this.joystickTouchId !== null) return;
      const t = e.changedTouches[0];
      this.joystickTouchId = t.identifier;
      const rect = zone.getBoundingClientRect();
      this.joystickOriginX = rect.left + rect.width  / 2;
      this.joystickOriginY = rect.top  + rect.height / 2;
      this._updateJoystick(t.clientX, t.clientY);
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === this.joystickTouchId) {
          this._updateJoystick(t.clientX, t.clientY);
        }
      }
    };

    const onEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.joystickTouchId) {
          this.joystickTouchId = null;
          this.state.joystickX = 0;
          this.state.joystickY = 0;
          this.knob.style.transform = 'translate(-50%, -50%)';
        }
      }
    };

    zone.addEventListener('touchstart',  onStart, { passive: false });
    zone.addEventListener('touchmove',   onMove,  { passive: false });
    zone.addEventListener('touchend',    onEnd,   { passive: false });
    zone.addEventListener('touchcancel', onEnd,   { passive: false });

    this._cleanups.push(() => {
      zone.removeEventListener('touchstart',  onStart);
      zone.removeEventListener('touchmove',   onMove);
      zone.removeEventListener('touchend',    onEnd);
      zone.removeEventListener('touchcancel', onEnd);
    });
  }

  private _updateJoystick(cx: number, cy: number): void {
    const dx = cx - this.joystickOriginX;
    const dy = cy - this.joystickOriginY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const clamped = Math.min(len, JOYSTICK_RADIUS);
    const nx = len > 0 ? dx / len : 0;
    const ny = len > 0 ? dy / len : 0;

    this.state.joystickX = nx * (clamped / JOYSTICK_RADIUS);
    this.state.joystickY = ny * (clamped / JOYSTICK_RADIUS);

    // Move knob visually
    const kx = nx * clamped;
    const ky = ny * clamped;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
  }

  // ── Action / Gas / Brake buttons ─────────────────────────────────────────
  private _setupButtons(): void {
    this._makeHoldButton(this.btnGas, () => { this.gasActive   = true; },
                                     () => { this.gasActive   = false; });
    this._makeHoldButton(this.btnBrake, () => { this.brakeActive = true; },
                                       () => { this.brakeActive = false; });

    const onActionStart = (e: Event) => {
      e.preventDefault();
      this.state.actionPressed = true;
    };
    this.btnAction.addEventListener('touchstart', onActionStart, { passive: false });
    this.btnAction.addEventListener('mousedown',  onActionStart);
    this._cleanups.push(() => {
      this.btnAction.removeEventListener('touchstart', onActionStart);
      this.btnAction.removeEventListener('mousedown',  onActionStart);
    });
  }

  private _makeHoldButton(
    el: HTMLElement,
    down: () => void,
    up: () => void
  ): void {
    const onDown = (e: Event) => { e.preventDefault(); down(); el.classList.add('pressed'); };
    const onUp   = ()         => { up(); el.classList.remove('pressed'); };

    el.addEventListener('touchstart',  onDown, { passive: false });
    el.addEventListener('touchend',    onUp,   { passive: false });
    el.addEventListener('touchcancel', onUp,   { passive: false });
    el.addEventListener('mousedown',   onDown);
    el.addEventListener('mouseup',     onUp);
    el.addEventListener('mouseleave',  onUp);

    this._cleanups.push(() => {
      el.removeEventListener('touchstart',  onDown);
      el.removeEventListener('touchend',    onUp);
      el.removeEventListener('touchcancel', onUp);
      el.removeEventListener('mousedown',   onDown);
      el.removeEventListener('mouseup',     onUp);
      el.removeEventListener('mouseleave',  onUp);
    });
  }

  // ── Keyboard (desktop) ────────────────────────────────────────────────────
  private _setupKeyboard(): void {
    const onDown = (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'KeyE' || e.code === 'Enter') {
        this.state.actionPressed = true;
      }
      // Prevent arrow-key page scroll
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup',   onUp);
    this._cleanups.push(() => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup',   onUp);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  getState(): ControlState {
    // Merge keyboard into state
    const kb = this.keys;

    // Joystick axis (keyboard overrides)
    let jx = this.state.joystickX;
    let jy = this.state.joystickY;
    if (kb.has('ArrowLeft')  || kb.has('KeyA')) jx = -1;
    if (kb.has('ArrowRight') || kb.has('KeyD')) jx =  1;
    if (kb.has('ArrowUp')    || kb.has('KeyW')) jy = -1;
    if (kb.has('ArrowDown')  || kb.has('KeyS')) jy =  1;

    const throttle = (this.gasActive   || kb.has('ArrowUp')   || kb.has('KeyW')) ? 1 : 0;
    const brake    = (this.brakeActive || kb.has('ArrowDown')  || kb.has('KeyS') || kb.has('Space')) ? 1 : 0;

    return {
      joystickX:     jx,
      joystickY:     jy,
      throttle,
      brake,
      actionPressed: this.state.actionPressed,
    };
  }

  /** Call once per frame after consuming actionPressed. */
  clearAction(): void {
    this.state.actionPressed = false;
  }

  /** Update the action button visual state. */
  setActionMode(mode: ActionMode): void {
    this.btnAction.textContent = mode === 'exit' ? 'EXIT' : 'ENTER';
    if (mode === 'inactive') {
      this.btnAction.classList.add('inactive');
    } else {
      this.btnAction.classList.remove('inactive');
    }
  }

  dispose(): void {
    for (const fn of this._cleanups) fn();
  }
}
