// Sound, as one system in game.systems (milestone 5).
//
// There is no AudioContext until the first key, click or touch: browsers will
// not start one sooner, and before that this file does nothing at all. After
// it, the context is suspended whenever nothing should be heard (paused, tab
// hidden, master at zero), so a silent game costs nothing.
//
// The parts: audio.ts (buses, limiter, reverb, listener), then one file per
// step of the brief. Each part is built on the AudioCore and is told what the
// game is doing; none of them reads the DOM.

import type { Game } from '../core/game';
import { save } from '../game/save';
import { AudioCore } from './audio';
import { VehicleSounds } from './vehicles';
import { WorldSounds } from './world';
import { TroubleSounds } from './trouble';
import { UiSounds } from './ui';
import { Radio } from './radio';

export interface AudioPart { update(dt: number): void }

export class GameAudio {
  /** Null until the first gesture. */
  core: AudioCore | null = null;
  ctx: AudioContext | null = null;
  /** `?audio=0`: never make a sound, never make a context. */
  readonly enabled: boolean;
  /** Milliseconds spent in update() over the last frames, smoothed (for the report). */
  cost = 0;
  /** The longest single update() so far, in milliseconds: the one that would show as a hitch. Tests zero it. */
  costMax = 0;

  private parts: AudioPart[] = [];
  /** The parts by name, once built (null before the first gesture). */
  cars: VehicleSounds | null = null;
  world: WorldSounds | null = null;
  trouble: TroubleSounds | null = null;
  ui: UiSounds | null = null;
  radio: Radio | null = null;
  private paused = false;
  private sleepAt = 0;
  private sleepTimer = 0;
  private px = 0; private pz = 0; private vx = 0; private vz = 0;
  private readonly unlock = (): void => this.wake();

  constructor(private readonly game: Game) {
    let on = true;
    try { on = new URLSearchParams(location.search).get('audio') !== '0'; } catch { /* no address */ }
    this.enabled = on && typeof AudioContext !== 'undefined';
    if (!this.enabled) return;
    for (const ev of ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const) addEventListener(ev, this.unlock, { capture: true, passive: true });
    game.on('pause', (e) => { this.paused = e.on; this.sync(); });
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** A gesture happened: make the context if there is none, and start it if it should be running. */
  private wake(): void {
    if (!this.ctx) {
      try { this.ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { return; }
      this.core = new AudioCore(this.ctx);
      this.build(this.core);
      this.applySettings();
      this.core.setWorld(!this.paused);
    }
    this.sync();
    if (this.ctx.state === 'running') for (const ev of ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const) removeEventListener(ev, this.unlock, { capture: true });
  }

  /** Everything that makes sound is made here, once, after the first gesture. */
  private build(core: AudioCore): void {
    const g = this.game;
    const cars = new VehicleSounds(core, g);
    const world = new WorldSounds(core, g);
    const trouble = new TroubleSounds(core, g);
    const ui = new UiSounds(core, g, (s) => this.hold(s), () => world.gerald());
    const radio = new Radio(core, g);
    this.cars = cars; this.world = world; this.trouble = trouble; this.ui = ui; this.radio = radio;
    this.parts = [cars, world, trouble, ui, radio];
    // She may already be at the wheel (a restored save, or a first key press that was the throttle).
    const v = g.player.vehicle;
    if (v) { cars.engine.setKind(v.spec.kind); cars.engine.start(); }
  }

  /** True when nothing could be heard: no context, or the master slider at zero. */
  get silent(): boolean { return !this.core || save.data.settings.volMaster <= 0; }

  /** Read the sliders from the save. Called by the menu as they move. */
  applySettings(key?: string): void {
    const s = save.data.settings;
    this.core?.setVolumes({ master: s.volMaster, music: s.volMusic, sfx: s.volSfx, ambience: s.volAmbience });
    this.sync();
    if (key && this.ctx && s.volMaster > 0) this.ui?.tick(key);
  }

  /** Run or suspend the context to match the state of the game. */
  private sync(): void {
    const ctx = this.ctx, core = this.core;
    if (!ctx || !core) return;
    const hidden = document.visibilityState === 'hidden';
    const muted = save.data.settings.volMaster <= 0;
    core.setWorld(!this.paused);
    clearTimeout(this.sleepTimer);
    if (hidden || muted) { void ctx.suspend(); return; }
    if (!this.paused) { void ctx.resume(); return; }
    // Paused: the world fades in a tenth of a second, then the context sleeps unless the menu has just made a noise.
    const wait = Math.max(180, (this.sleepAt - performance.now()));
    this.sleepTimer = window.setTimeout(() => { if (this.paused && this.ctx) void this.ctx.suspend(); }, wait);
  }

  /** A UI sound wants to be heard for `seconds` even though the game is paused. */
  hold(seconds: number): void {
    if (!this.ctx || !this.paused || save.data.settings.volMaster <= 0 || document.visibilityState === 'hidden') return;
    this.sleepAt = performance.now() + seconds * 1000 + 150;
    void this.ctx.resume();
    this.sync();
  }

  update(dt: number): void {
    const core = this.core;
    // The dial turns (and is remembered) even in the moment before the context has woken.
    this.radio?.keys();
    if (!core || !this.ctx || this.ctx.state !== 'running') return;
    const t0 = performance.now();
    // The listener is the camera. Its velocity is for Doppler; a teleport is not a velocity.
    const cam = this.game.camera, e = cam.matrixWorld.elements, p = cam.position;
    if (dt > 0) {
      const vx = (p.x - this.px) / dt, vz = (p.z - this.pz) / dt;
      if (Math.hypot(vx, vz) > 120) { this.vx = 0; this.vz = 0; } else { this.vx += (vx - this.vx) * 0.2; this.vz += (vz - this.vz) * 0.2; }
    }
    this.px = p.x; this.pz = p.z;
    core.setListener(p.x, p.y, p.z, e[0], e[2], this.vx, this.vz);
    for (const part of this.parts) part.update(dt);
    const ms = performance.now() - t0;
    this.cost += (ms - this.cost) * 0.05;
    if (ms > this.costMax) this.costMax = ms;
  }
}
