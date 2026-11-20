// Paperwork: the sounds the Harbor Authority's forms make. A rubber stamp for
// anything stamped, paper for anything handed to her, a beacon pip when the
// Patrol's interest changes, a till of our own for money, and brass for the
// few occasions the Authority considers occasions.
//
// The HUD has no events of its own, so its four public calls (toast, stamp,
// tag, objective) are wrapped here, once, after the first gesture; everything
// else is an event or a number in the save that is watched.

import type { Game } from '../core/game';
import { save } from '../game/save';
import { progress } from '../world/progress';
import type { AudioCore } from './audio';
import { hiss, ping, thud, type Rand } from './sfx';
import { clank } from './world';

/** Equal-tempered pitch of a MIDI note. */
export const hz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** The stamp coming down on a desk: rubber, ink, wood. heavy 0..1. */
export function stampThunk(core: AudioCore, t: number, out: AudioNode, heavy: number, r: Rand): void {
  const k = 0.92 + r() * 0.16;
  thud(core, t, out, (175 - 40 * heavy) * k, 58, 0.75 + 0.2 * heavy, 0.12 + 0.05 * heavy);
  hiss(core, t, out, 'pink', 'lowpass', 1300, 0.6, 0.6, 0.001, 0.045);
  hiss(core, t, out, 'pink', 'bandpass', 235 * k, 6, 1.6, 0.002, 0.13);
  // The handle's own knock, and the kiss of the ink letting go.
  hiss(core, t + 0.004, out, 'white', 'bandpass', 1150 * k, 5, 0.35, 0.0005, 0.02);
  hiss(core, t + 0.1, out, 'white', 'bandpass', 2600, 1.5, 0.05, 0.012, 0.05);
}

/** A sheet handled. long: slid across a desk first (the dossier opening). */
export function paper(core: AudioCore, t: number, out: AudioNode, long: boolean, r: Rand): void {
  let at = t;
  if (long) {
    const b = hiss(core, t, out, 'white', 'bandpass', 3000, 0.8, 0.4, 0.09, 0.26);
    b.frequency.setValueAtTime(2600, t); b.frequency.exponentialRampToValueAtTime(5200, t + 0.3);
    at = t + 0.2;
  }
  const n = 2 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    hiss(core, at, out, 'white', 'bandpass', 3800 + r() * 3200, 0.9, 0.6 * (1 - i * 0.2), 0.004, 0.03 + r() * 0.03);
    at += 0.045 + r() * 0.035;
  }
  hiss(core, t, out, 'pink', 'bandpass', 900, 1, 0.15, 0.01, 0.08);
}

/** One pip of the beacon. */
export function pip(core: AudioCore, t: number, out: AudioNode, f: number, level = 0.4): void {
  ping(core, t, out, f, level, 0.16); ping(core, t, out, f * 2, level * 0.25, 0.09); ping(core, t, out, f * 3.01, level * 0.08, 0.05);
}
/** Heat changing: up climbs (one more pip the hotter it is), down falls, clear falls further and softer. */
export function heatPips(core: AudioCore, t: number, out: AudioNode, from: number, to: number): void {
  if (to > from) { const n = Math.min(4, 1 + to); for (let i = 0; i < n; i++) pip(core, t + i * 0.105, out, hz(84 + i * (i < 2 ? 5 : 3))); }
  else if (to === 0) { pip(core, t, out, hz(84), 0.26); pip(core, t + 0.13, out, hz(79), 0.22); pip(core, t + 0.26, out, hz(72), 0.18); }
  else { pip(core, t, out, hz(89), 0.34); pip(core, t + 0.12, out, hz(84), 0.3); }
}

/** The till: wooden keys, and a small bell with two partials that no shop till was ever tuned to. n keys, 1..4; loss: no bell, a drawer shutting instead. */
export function till(core: AudioCore, t: number, out: AudioNode, n: number, loss: boolean, r: Rand): void {
  for (let i = 0; i < n; i++) {
    const at = t + i * 0.062;
    hiss(core, at, out, 'white', 'bandpass', 3100 + r() * 600, 5, 2, 0.0005, 0.012);
    thud(core, at, out, 420, 260, 0.22, 0.02);
  }
  const at = t + n * 0.062;
  if (loss) { thud(core, at, out, 190, 90, 0.3, 0.07); hiss(core, at, out, 'pink', 'bandpass', 520, 4, 0.5, 0.002, 0.06); }
  else { ping(core, at, out, 2489, 0.28, 0.32); ping(core, at, out, 4183, 0.15, 0.2); ping(core, at, out, 6790, 0.04, 0.08); }
}

const brassWave = new WeakMap<AudioCore, PeriodicWave>();
/** The Authority's brass: one note. slide: semitones the pitch sags by over the note (for bad news). */
export function brass(core: AudioCore, t: number, out: AudioNode, midi: number, dur: number, level: number, slide = 0): void {
  let w = brassWave.get(core);
  if (!w) { const h = new Float32Array(18); for (let k = 1; k <= 18; k++) h[k - 1] = 1 / Math.pow(k, 0.9); brassWave.set(core, (w = core.wave(h))); }
  const f = hz(midi), lp = core.filter('lowpass', 600, 1), g = core.gain(0);
  // The tone opens as the note speaks and closes as it dies: that is most of what makes it brass.
  lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(Math.min(5200, f * 6), t + 0.05); lp.frequency.setTargetAtTime(Math.min(3000, f * 3), t + 0.06, 0.2);
  core.gate(g.gain, t, 0.025, level, Math.max(0.03, dur - 0.05), 0.07);
  for (const d of [-4, 5]) {
    const o = core.osc(w, f); o.detune.value = d;
    if (slide) { o.frequency.setValueAtTime(f, t + dur * 0.3); o.frequency.exponentialRampToValueAtTime(f * Math.pow(2, -slide / 12), t + dur); }
    o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
  }
  lp.connect(g); g.connect(out);
}

/** Mission passed: five notes up to the fifth, and the stamp on the last. */
export function passSting(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const s = 0.115;
  brass(core, t, out, 69, s, 0.2); brass(core, t + s, out, 74, s, 0.2); brass(core, t + 2 * s, out, 78, s * 2, 0.22);
  brass(core, t + 4 * s, out, 76, s, 0.2); brass(core, t + 5 * s, out, 81, 0.62, 0.24);
  for (const m of [62, 66, 69]) brass(core, t + 5 * s, out, m, 0.62, 0.1);
  stampThunk(core, t + 5 * s, out, 0.6, r);
  ping(core, t + 5 * s, out, hz(93), 0.05, 0.5);
}

/** Mission failed: three notes down, the last one losing heart, and the form screwed up. */
export function failSting(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  brass(core, t, out, 62, 0.2, 0.2); brass(core, t + 0.22, out, 58, 0.2, 0.2); brass(core, t + 0.44, out, 55, 0.75, 0.22, 1.6);
  brass(core, t + 0.44, out, 49, 0.75, 0.1, 1.6);
  for (let i = 0; i < 7; i++) hiss(core, t + 0.5 + i * 0.06 + r() * 0.03, out, 'white', 'bandpass', 2500 + r() * 3500, 1, 0.1 * (0.5 + r()), 0.004, 0.04 + r() * 0.04);
}

/** A checkpoint, a step done: two glass notes a fifth apart. high: a stunt jump found. */
export function chime(core: AudioCore, t: number, out: AudioNode, high = false): void {
  const m = high ? 93 : 88;
  ping(core, t, out, hz(m), 0.32, 0.34); ping(core, t, out, hz(m) * 2.76, 0.06, 0.12);
  ping(core, t + 0.085, out, hz(m + 7), 0.32, 0.42); ping(core, t + 0.085, out, hz(m + 7) * 2.76, 0.06, 0.14);
  if (high) ping(core, t + 0.17, out, hz(m + 12), 0.28, 0.5);
}

/** A bath duck, squeezed and let go. */
export function duckSqueak(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const f = 640 * (0.92 + r() * 0.16), bp = core.filter('bandpass', 2500, 2), g = core.gain(0), o = core.osc('sawtooth', f);
  o.frequency.setValueAtTime(f * 0.8, t); o.frequency.linearRampToValueAtTime(f * 1.55, t + 0.05); o.frequency.linearRampToValueAtTime(f * 1.2, t + 0.14);
  core.gate(g.gain, t, 0.008, 0.9, 0.1, 0.04);
  o.connect(bp); bp.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2);
  // And the air going back in, an octave up and half as loud.
  const o2 = core.osc('sawtooth', f * 1.5), g2 = core.gain(0), bp2 = core.filter('bandpass', 3400, 3);
  o2.frequency.setValueAtTime(f * 1.5, t + 0.2); o2.frequency.linearRampToValueAtTime(f * 2.3, t + 0.32);
  core.gate(g2.gain, t + 0.2, 0.02, 0.36, 0.08, 0.05);
  o2.connect(bp2); bp2.connect(g2); g2.connect(out); o2.start(t + 0.2); o2.stop(t + 0.4);
}

/** A span of the bridge is in: the full band, briefly. big: the bridge is finished (one more bar of it). */
export function fanfare(core: AudioCore, t: number, out: AudioNode, big: boolean, r: Rand): void {
  const s = 0.15, hits = [65, 70, 74];
  let at = t;
  for (const m of hits) { brass(core, at, out, m, s * 0.9, 0.2); brass(core, at, out, m - 12, s * 0.9, 0.12); thud(core, at, out, 120, 100, 0.3, 0.14); at += s; }
  if (big) { for (const m of [77, 74, 77]) { brass(core, at, out, m, s * 0.9, 0.2); brass(core, at, out, m - 8, s * 0.9, 0.12); at += s; } }
  const hold = big ? 1.5 : 1.0, top = big ? 82 : 77;
  for (const m of [top, top - 3, top - 7, top - 12, top - 19]) brass(core, at, out, m, hold, m === top ? 0.2 : 0.11);
  thud(core, at, out, 118, 98, 0.5, 0.5); thud(core, at + 0.12, out, 118, 98, 0.25, 0.4);
  // A cymbal somebody was told to hit.
  hiss(core, at, out, 'white', 'highpass', 5200, 0.5, 0.1, 0.004, 1.2);
  stampThunk(core, at + hold, out, 1, r);
}

/** Booked: the door, then the paperwork. */
export function booked(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const g = core.gain(0.6); g.connect(out);
  clank(core, t, g, r, 1);
  hiss(core, t, out, 'white', 'bandpass', 330, 20, 5, 0.001, 0.6);
  stampThunk(core, t + 0.45, out, 1, r);
}

// ── The part the game runs ───────────────────────────────────────────────────

const DUCK_X = 0, DUCK_Z = 689;

export class UiSounds {
  private heat = 0;
  private money: number;
  private moneyT = 0; private owed = 0;
  private passed: number; private failed: number; private jumps: number;
  private lastObjective: string | null = null;
  /** Sounds asked for by a wrapped HUD call, played in update so a burst of toasts is one rustle. */
  private wantPaper = 0; private wantStamp = 0; private wantChime = false;

  /** hold(seconds): keep the context awake that long even though the game is paused. gerald(): the gull has been at it. */
  constructor(private readonly core: AudioCore, private readonly game: Game, private readonly hold: (s: number) => void, gerald: () => void) {
    const r = Math.random, st = save.data.stats;
    this.money = game.player.money; this.passed = st.passed; this.failed = st.failed; this.jumps = save.data.jumps.length;
    this.heat = Math.round(game.player.heat);

    const hud = game.hud;
    const toast = hud.toast.bind(hud), stamp = hud.stamp.bind(hud), tag = hud.tag.bind(hud), objective = hud.objective.bind(hud);
    hud.toast = (text: string, seconds?: number): void => { this.wantPaper = 1; if (text.includes('Gerald')) gerald(); toast(text, seconds); };
    hud.stamp = (title: string, sub?: string): void => { this.wantStamp = Math.max(this.wantStamp, 0.5); stamp(title, sub); };
    hud.tag = (title: string, sub?: string, seconds?: number): void => { this.wantStamp = Math.max(this.wantStamp, 0.2); tag(title, sub, seconds); };
    hud.objective = (text: string | null): void => {
      if (text !== this.lastObjective) { if (text !== null && this.lastObjective !== null) this.wantChime = true; this.lastObjective = text; }
      objective(text);
    };

    game.on('pause', (e) => { this.hold(0.6); if (this.core.claim('paper', 2, 0.15)) paper(core, core.now + 0.02, this.out(0.9), e.on, r); });
    game.on('start', () => { stampThunk(core, core.now + 0.02, this.out(0.8), 0.5, r); });
    game.on('heat', (e) => {
      const lv = Math.round(e.level);
      if (lv === this.heat) return;
      if (core.claim('pip', 1, 0.3)) heatPips(core, core.now + 0.02, this.out(0.8), this.heat, lv);
      this.heat = lv;
    });
    game.on('duck', (e) => {
      if (Math.hypot(e.x - DUCK_X, e.z - DUCK_Z) <= 3) return;
      duckSqueak(core, core.now + 0.02, this.out(0.8), r);
      chime(core, core.now + 0.35, this.out(0.6));
    });
    game.on('booked', () => { booked(core, core.now + 0.1, this.out(0.8), r); });
    progress.onChange((what) => {
      if (this.core.ctx.state !== 'running' || !core.claim('fanfare', 1, 2.5)) return;
      fanfare(core, core.now + 0.15, this.out(0.8, 0.2), what === 'bridge' && progress.complete, r);
    });
  }

  private out(level: number, wet = 0.06): AudioNode { return this.core.direct('ui', level, wet); }

  /** A slider moved: a pip through the bus it governs, so the hand can hear what it is doing. */
  tick(key: string): void {
    const c = this.core;
    this.hold(0.5);
    if (!c.claim('tick', 2, 0.07)) return;
    const bus = key === 'volMusic' ? 'music' : key === 'volAmbience' ? 'ambience' : 'ui';
    pip(c, c.now + 0.02, c.direct(bus, 0.9), hz(key === 'volMaster' ? 81 : key === 'volMusic' ? 84 : key === 'volSfx' ? 86 : 79));
  }

  update(dt: number): void {
    const c = this.core, t = c.now + 0.01, g = this.game, r = Math.random, st = save.data.stats;
    if (this.wantStamp > 0) { if (c.claim('stamp', 2, 0.12)) stampThunk(c, t, this.out(0.85), this.wantStamp, r); this.wantStamp = 0; this.wantPaper = 0; }
    if (this.wantPaper > 0) { if (c.claim('paper', 2, 0.15)) paper(c, t, this.out(0.9), false, r); this.wantPaper = 0; }
    if (this.wantChime) { this.wantChime = false; if (c.claim('chime', 1, 0.25)) chime(c, t, this.out(0.8)); }
    // Money: a change is rung up a moment later, so a fare paid in three lumps is one sale.
    const m = g.player.money;
    if (m !== this.money) { this.owed += m - this.money; this.money = m; if (this.moneyT <= 0) this.moneyT = 0.12; }
    if (this.moneyT > 0 && (this.moneyT -= dt) <= 0) {
      const a = Math.abs(this.owed);
      if (a >= 1 && c.claim('till', 2, 0.25)) till(c, t, this.out(0.8), a < 20 ? 1 : a < 150 ? 2 : a < 1000 ? 3 : 4, this.owed < 0, r);
      this.owed = 0;
    }
    if (st.passed !== this.passed) { if (st.passed > this.passed) passSting(c, t + 0.1, this.out(0.9, 0.15), r); this.passed = st.passed; }
    if (st.failed !== this.failed) { if (st.failed > this.failed) failSting(c, t + 0.1, this.out(0.9, 0.15), r); this.failed = st.failed; }
    const j = save.data.jumps.length;
    if (j !== this.jumps) { if (j > this.jumps) chime(c, t, this.out(0.8), true); this.jumps = j; }
  }
}
