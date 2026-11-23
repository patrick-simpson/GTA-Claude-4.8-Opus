// The world, heard: beds that crossfade with place and hour, the things that
// happen in them now and then (gulls, a buoy, a train a long way off, the
// church counting the hour), the weather, her own feet, things she knocks over,
// and the residents.
//
// A bed is a small standing graph of noise and slow oscillators: nothing in it
// is scheduled per frame. It is built when its weight first rises above
// nothing and torn down a few seconds after it falls back, so a bed nobody can
// hear costs nothing. Weights are worked out four times a second.

import type { Game } from '../core/game';
import type { PropKind } from '../world/collide';
import { BREAKWATER, BRIDGE, LIGHTHOUSE, PIER, PIER_HEAD, islandSD } from '../world/plan';
import { FOOTBRIDGE, HILL, MAIN_SPLIT_Z, MXS, RAIL, RAIL_TRESTLE, RAIL_Z, ROAD_BRIDGE, SITES, coastSD, hillAt, waterDist } from '../world/mainland';
import type { AudioCore, Bus } from './audio';
import { hiss, ping, thud, type Rand } from './sfx';
import { DUCK } from '../world/duckState';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Beds ─────────────────────────────────────────────────────────────────────

/** Collects what a bed is made of, so it can be stopped again. */
export class Rig {
  readonly src: AudioScheduledSourceNode[] = [];
  constructor(readonly core: AudioCore, readonly out: AudioNode) {}
  /** Looping noise through one filter. Returns its gain, for an LFO to lean on. */
  noise(kind: 'white' | 'pink' | 'brown', type: BiquadFilterType, f: number, q: number, level: number, to: AudioNode = this.out): { g: GainNode; f: BiquadFilterNode } {
    const s = this.core.noiseSrc(kind), b = this.core.filter(type, f, q), g = this.core.gain(level);
    s.connect(b); b.connect(g); g.connect(to);
    this.src.push(s);
    return { g, f: b };
  }
  tone(type: OscillatorType | PeriodicWave, f: number, level: number, lp = 0, to: AudioNode = this.out): { o: OscillatorNode; g: GainNode } {
    const o = this.core.osc(type, f), g = this.core.gain(level);
    if (lp) { const b = this.core.filter('lowpass', lp, 0.7); o.connect(b); b.connect(g); } else o.connect(g);
    g.connect(to); o.start();
    this.src.push(o);
    return { o, g };
  }
  /** A slow oscillator added to a parameter: the parameter swings `depth` either side of where it was set. */
  lfo(f: number, depth: number, p: AudioParam, type: OscillatorType = 'sine'): void {
    const o = this.core.osc(type, f), g = this.core.gain(depth);
    o.connect(g); g.connect(p); o.start();
    this.src.push(o);
  }
}

export type BedBuild = (r: Rig) => void;

export const BEDS = {
  /** Swell, wash and foam: two slow LFOs that never line up the same way twice in a minute. */
  surf: (r: Rig): void => {
    r.noise('brown', 'lowpass', 420, 0.6, 0.55);
    const wash = r.noise('pink', 'bandpass', 1300, 0.5, 0.34);
    r.lfo(0.093, 0.2, wash.g.gain); r.lfo(0.137, 0.11, wash.g.gain); r.lfo(0.093, 420, wash.f.frequency);
    const foam = r.noise('white', 'highpass', 3600, 0.5, 0.05);
    r.lfo(0.093, 0.032, foam.g.gain); r.lfo(0.21, 0.014, foam.g.gain);
  },
  /** Water against pilings and hulls. The clanks and the buoy are events. */
  harbour: (r: Rig): void => {
    r.noise('brown', 'lowpass', 260, 0.6, 0.4);
    const lap = r.noise('pink', 'bandpass', 760, 2.2, 0.16);
    r.lfo(0.83, 0.09, lap.g.gain); r.lfo(1.31, 0.06, lap.g.gain); r.lfo(0.27, 180, lap.f.frequency);
    const slap = r.noise('white', 'bandpass', 1900, 1.5, 0.035);
    r.lfo(0.61, 0.03, slap.g.gain);
  },
  /** A city a few streets away in every direction. */
  city: (r: Rig): void => {
    r.noise('brown', 'lowpass', 210, 0.6, 0.85);
    const wash = r.noise('pink', 'bandpass', 620, 0.4, 0.16);
    r.lfo(0.051, 0.06, wash.g.gain); r.lfo(0.113, 0.04, wash.g.gain);
    r.noise('pink', 'bandpass', 2100, 0.6, 0.03);
    // Ventilation on a roof somewhere: two hums that beat.
    r.tone('sine', 118, 0.025); r.tone('sine', 119.3, 0.02);
  },
  /** A field of crickets: two pitches, each a train of pulses gated into chirps. */
  crickets: (r: Rig): void => {
    const one = (f: number, pulse: number, chirp: number, level: number): void => {
      const gate = r.core.gain(0.5), g = r.core.gain(0.5);
      gate.connect(g); g.connect(r.out);
      r.tone('sine', f, level, 0, gate); r.tone('sine', f * 1.031, level * 0.6, 0, gate);
      r.lfo(pulse, 0.5, gate.gain); r.lfo(chirp, 0.5, g.gain);
    };
    one(4250, 61, 2.1, 0.16); one(3720, 47, 1.63, 0.1); one(4870, 71, 2.7, 0.06);
    r.noise('pink', 'bandpass', 5200, 1, 0.012);
  },
  /** The Cannery: mains hum that beats, a compressor breathing, a conveyor. */
  industry: (r: Rig): void => {
    r.noise('brown', 'lowpass', 180, 0.6, 0.6);
    r.tone('sawtooth', 49, 0.22, 190); r.tone('sawtooth', 98.6, 0.09, 320); r.tone('sawtooth', 147.4, 0.03, 500);
    const air = r.noise('white', 'bandpass', 2600, 0.8, 0.035);
    r.lfo(0.37, 0.03, air.g.gain);
    const belt = r.noise('white', 'bandpass', 940, 3, 0.05);
    r.lfo(11.3, 0.04, belt.g.gain);
  },
  /** The dam: water falling a long way, all bands, steady. */
  dam: (r: Rig): void => {
    const a = r.noise('brown', 'lowpass', 900, 0.5, 1.0);
    r.noise('pink', 'bandpass', 1700, 0.4, 0.42);
    r.noise('white', 'highpass', 4200, 0.5, 0.05);
    r.lfo(0.31, 0.05, a.g.gain);
  },
  /** Loom Row: two looms that drift in and out of step over a lineshaft's drone. */
  mill: (r: Rig): void => {
    r.noise('brown', 'lowpass', 150, 0.6, 0.5);
    r.tone('sawtooth', 87, 0.1, 260); r.tone('sawtooth', 43.6, 0.12, 200);
    // gain = 0.5 - 0.5 * saw: full at the top of each cycle, falling to nothing: a shuttle thrown and caught.
    const loom = (f: number, hz: number, level: number): void => {
      const n = r.noise('white', 'bandpass', f, 2.2, level * 0.5);
      r.lfo(hz, -level * 0.5, n.g.gain, 'sawtooth');
    };
    loom(2200, 3.4, 0.5); loom(1650, 4.1, 0.4); loom(3100, 6.8, 0.14);
  },
  /** Wind in pines: a hiss that swells and leans. */
  pines: (r: Rig): void => {
    const a = r.noise('pink', 'bandpass', 2500, 0.6, 0.3);
    r.lfo(0.071, 0.14, a.g.gain); r.lfo(0.19, 0.08, a.g.gain); r.lfo(0.071, 700, a.f.frequency);
    const b = r.noise('white', 'highpass', 6000, 0.5, 0.03);
    r.lfo(0.19, 0.02, b.g.gain);
    r.noise('brown', 'lowpass', 240, 0.6, 0.22);
  },
  rain: (r: Rig): void => {
    const top = r.core.filter('lowpass', 9500, 0.5);
    top.connect(r.out);
    r.noise('white', 'highpass', 2400, 0.5, 0.2, top);
    const body = r.noise('pink', 'bandpass', 950, 0.5, 0.3);
    r.lfo(0.13, 0.05, body.g.gain);
    r.noise('brown', 'lowpass', 320, 0.6, 0.3);
  },
  /** The 3 AM visitor: two low sines that beat, a fifth that wobbles, a shimmer on top. */
  saucer: (r: Rig): void => {
    r.tone('sine', 96, 0.17); r.tone('sine', 99.2, 0.17);
    const mid = r.tone('triangle', 288, 0.07);
    r.lfo(5.5, 7, mid.o.frequency);
    const top = r.tone('sine', 1730, 0.03);
    r.lfo(9, 0.03, top.g.gain); r.lfo(0.4, 60, top.o.frequency);
  },
} satisfies Record<string, BedBuild>;
export type BedName = keyof typeof BEDS;

/** One bed in the game: built on demand, level and pan glided, torn down when it has been silent a while. */
export class Bed {
  private rig: Rig | null = null;
  private g: GainNode | null = null;
  private pan: StereoPannerNode | null = null;
  private quiet = 0;
  level = 0;
  constructor(private readonly core: AudioCore, private readonly build: BedBuild, private readonly dest: AudioNode, private readonly trim = 1, private readonly wet = 0) {}
  /** w 0..1; pan -1..1. dt is the time since the last call. */
  set(w: number, dt: number, pan = 0): void {
    const c = this.core, t = c.now;
    this.level = w;
    if (w > 0.004 && !this.rig) {
      this.g = c.gain(0); this.pan = c.ctx.createStereoPanner();
      this.g.connect(this.pan); this.pan.connect(this.dest);
      if (this.wet) { const s = c.gain(this.wet); this.g.connect(s); s.connect(c.reverbFor(c.busOf(this.dest))); }
      this.rig = new Rig(c, this.g);
      this.build(this.rig);
      this.quiet = 0;
    }
    if (!this.rig || !this.g || !this.pan) return;
    this.g.gain.setTargetAtTime(w * this.trim, t, 0.8);
    this.pan.pan.setTargetAtTime(pan, t, 0.3);
    if (w > 0.004) { this.quiet = 0; return; }
    this.quiet += dt;
    if (this.quiet > 5) {
      for (const s of this.rig.src) { try { s.stop(); } catch { /* never started */ } }
      this.g.disconnect(); this.pan.disconnect();
      this.rig = null; this.g = null; this.pan = null;
    }
  }
}

// ── Things that happen now and then ──────────────────────────────────────────

const gullWave = new WeakMap<AudioCore, PeriodicWave>();
/** A gull: a handful of cries, each a quick rise and a long fall, getting faster and lower. */
export function gull(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  let w = gullWave.get(core);
  if (!w) gullWave.set(core, (w = core.wave([1, 0.7, 0.55, 0.3, 0.22, 0.12, 0.08])));
  const n = 2 + Math.floor(r() * 4), base = 820 + r() * 260;
  const bp = core.filter('bandpass', 2300, 1.6), g = core.gain(0);
  bp.connect(g); g.connect(out);
  let at = t;
  for (let i = 0; i < n; i++) {
    const d = (0.34 - i * 0.035) * (0.8 + r() * 0.4), f = base * (1 - i * 0.035);
    const o = core.osc(w, f), og = core.gain(0);
    o.frequency.setValueAtTime(f * 0.8, at);
    o.frequency.linearRampToValueAtTime(f * 1.45, at + 0.05);
    o.frequency.linearRampToValueAtTime(f, at + d);
    core.gate(og.gain, at, 0.025, 1, d * 0.7, d * 0.3);
    o.connect(og); og.connect(bp);
    // The catch in its throat.
    const rough = core.osc('sine', 64 + r() * 20), rg = core.gain(0.35);
    rough.connect(rg); rg.connect(og.gain);
    o.start(at); o.stop(at + d + 0.05); rough.start(at); rough.stop(at + d + 0.05);
    at += d + 0.05 + r() * 0.05;
  }
  g.gain.setValueAtTime(0.5, t);
  g.gain.setValueAtTime(0.5, at); g.gain.linearRampToValueAtTime(0, at + 0.05);
}

/** A struck bar of bronze or iron: inharmonic partials that die at their own rates. */
export function bell(core: AudioCore, t: number, out: AudioNode, f: number, level: number, seconds: number, ratios: readonly number[], amps: readonly number[]): void {
  for (let i = 0; i < ratios.length; i++) ping(core, t, out, f * ratios[i], level * amps[i], seconds / (1 + i * 0.75));
  hiss(core, t, out, 'white', 'bandpass', f * 3, 1.5, level * 0.25, 0.001, 0.02);
}
const BUOY = [1, 2.76, 5.4, 8.93], BUOY_A = [1, 0.6, 0.35, 0.15];
const CHURCH = [0.5, 1, 1.19, 1.5, 2, 2.51, 3.01, 4.1], CHURCH_A = [0.7, 1, 0.75, 0.4, 0.6, 0.3, 0.2, 0.1];

/** The bell buoy: the sea decides how many times the clapper lands. */
export function bellBuoy(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const n = 1 + Math.floor(r() * 3);
  let at = t;
  for (let i = 0; i < n; i++) { bell(core, at, out, 523 * (1 + (r() - 0.5) * 0.004), 0.3 * (0.6 + r() * 0.4), 1.8, BUOY, BUOY_A); at += 0.35 + r() * 0.8; }
}

/** One stroke of the church bell at Quorum Square. */
export function churchBell(core: AudioCore, t: number, out: AudioNode): void {
  bell(core, t, out, 196, 0.26, 5.5, CHURCH, CHURCH_A);
}

/** Chain on a hull, a crate set down, a hatch: a knock through a few metal resonances. */
export function clank(core: AudioCore, t: number, out: AudioNode, r: Rand, low = 0): void {
  const src = core.burst('white', t, 0.4), exc = core.gain(0);
  core.env(exc.gain, t, 0.001, 1, 0.03);
  src.connect(exc);
  const n = 3 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const b = core.filter('bandpass', (280 + r() * 2100) * (1 - 0.5 * low), 18 + r() * 25), g = core.gain(0);
    core.env(g.gain, t, 0.002, 9 * (0.5 + r() * 0.5), 0.15 + r() * 0.4);
    exc.connect(b); b.connect(g); g.connect(out);
  }
  thud(core, t, out, 140 - 50 * low, 70, 0.25, 0.08);
  if (r() < 0.4) clankTail(core, t + 0.12 + r() * 0.15, out, r);
}
function clankTail(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  hiss(core, t, out, 'white', 'bandpass', 1200 + r() * 1500, 14, 0.5, 0.001, 0.12);
}

/** A small bird: one of three songs, none of them anybody's. */
export function chirp(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const kind = Math.floor(r() * 3), o = core.osc('sine', 3000), g = core.gain(0);
  o.connect(g); g.connect(out);
  let at = t;
  const note = (f0: number, f1: number, d: number, lvl: number): void => {
    o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + d);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lvl, at + Math.min(0.012, d * 0.3));
    g.gain.setValueAtTime(lvl, at + d * 0.7); g.gain.linearRampToValueAtTime(0, at + d);
    at += d;
  };
  const f = 2600 + r() * 1600;
  if (kind === 0) {
    // Tweets: up and over, a few times.
    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) { note(f, f * 1.45, 0.05, 0.16); note(f * 1.45, f * 0.9, 0.07, 0.16); at += 0.06 + r() * 0.05; }
  } else if (kind === 1) {
    // A trill that runs downhill.
    const n = 6 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) { note(f * 1.5 * (1 - i * 0.015), f * 1.4 * (1 - i * 0.015), 0.028, 0.12); at += 0.027; }
  } else {
    // Two whistled notes and a flick.
    note(f * 0.8, f * 0.82, 0.2, 0.14); at += 0.05; note(f * 0.62, f * 0.6, 0.24, 0.14); at += 0.04; note(f * 0.9, f * 1.2, 0.05, 0.1);
  }
  o.start(t); o.stop(at + 0.05);
}

const hornWave = new WeakMap<AudioCore, PeriodicWave>();
/** A freight a long way down the line: long, long, short, long, on four reeds nobody tuned to each other. */
export function trainHorn(core: AudioCore, t: number, out: AudioNode): number {
  let w = hornWave.get(core);
  if (!w) { const h = new Float32Array(20); for (let k = 1; k <= 20; k++) h[k - 1] = 1 / Math.pow(k, 0.8); hornWave.set(core, (w = core.wave(h))); }
  const lp = core.filter('lowpass', 1900, 0.6), g = core.gain(0);
  lp.connect(g); g.connect(out);
  const blasts = [1.5, 1.5, 0.45, 2.4];
  let at = t;
  for (const d of blasts) {
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.3, at + 0.09);
    g.gain.setValueAtTime(0.3, at + d); g.gain.linearRampToValueAtTime(0, at + d + 0.28);
    at += d + 0.75;
  }
  for (const f of [233.1, 311.1, 370, 466.2]) {
    const o = core.osc(w, f), og = core.gain(0.25);
    let a = t;
    // The pitch sags as each blast runs out of air.
    for (const d of blasts) { o.frequency.setValueAtTime(f * 0.985, a); o.frequency.linearRampToValueAtTime(f, a + 0.12); o.frequency.setValueAtTime(f, a + d); o.frequency.linearRampToValueAtTime(f * 0.96, a + d + 0.28); a += d + 0.75; }
    o.connect(og); og.connect(lp); o.start(t); o.stop(at);
  }
  return at - t;
}

/** The crossing on Main St: two bells that take turns. */
export function crossingBell(core: AudioCore, t: number, out: AudioNode, seconds: number): void {
  for (let i = 0, at = t; at < t + seconds; i++, at += 0.31) {
    const f = i % 2 ? 1180 : 1320, lvl = 0.16 * Math.min(1, (t + seconds - at) / 1.5 + 0.2);
    ping(core, at, out, f, lvl, 0.26); ping(core, at, out, f * 2.71, lvl * 0.4, 0.12);
  }
}

/** Thunder some way off: several rolls on top of each other, and a crack first if it was close. near 0..1. */
export function thunder(core: AudioCore, t: number, out: AudioNode, near: number, r: Rand): void {
  if (near > 0.5) hiss(core, t, out, 'white', 'lowpass', 2600, 0.5, 0.5 * near, 0.004, 0.22);
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const at = t + (near > 0.5 ? 0.05 : 0.2) + i * (0.35 + r() * 0.7);
    const b = hiss(core, at, out, 'brown', 'lowpass', 170 + r() * 240 + 260 * near, 0.6, (0.9 - i * 0.12) * (0.5 + 0.5 * near), 0.12 + r() * 0.3, 1.4 + r() * 2.2);
    b.frequency.setValueAtTime(b.frequency.value, at); b.frequency.exponentialRampToValueAtTime(80, at + 3);
  }
  thud(core, t + 0.25, out, 52, 26, 0.5 * near + 0.15, 1.6);
}

/** The lighthouse's foghorn: a long note that drops to a grunt. */
export function foghorn(core: AudioCore, t: number, out: AudioNode): void {
  const lp = core.filter('lowpass', 520, 1.1), g = core.gain(0);
  lp.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.42, t + 0.3);
  g.gain.setValueAtTime(0.42, t + 3.1); g.gain.linearRampToValueAtTime(0, t + 3.6);
  for (const [f, lvl] of [[110, 0.6], [110.7, 0.4], [165.3, 0.25]] as const) {
    const o = core.osc('sawtooth', f), og = core.gain(lvl);
    o.frequency.setValueAtTime(f, t + 2.1); o.frequency.exponentialRampToValueAtTime(f * 0.79, t + 2.3);
    o.connect(og); og.connect(lp); o.start(t); o.stop(t + 3.7);
  }
}

export type Surface = 'concrete' | 'wood' | 'sand' | 'grass' | 'metal' | 'water';
/** One footfall. hard: 1 walking, up to 2 for a landing. */
export function footstep(core: AudioCore, t: number, out: AudioNode, s: Surface, hard: number, r: Rand): void {
  const v = (0.75 + r() * 0.5) * hard, k = 0.85 + r() * 0.3;
  if (s === 'concrete') {
    thud(core, t, out, 115 * k, 58, 0.34 * v, 0.06);
    hiss(core, t, out, 'white', 'bandpass', 1700 * k, 1.2, 0.42 * v, 0.002, 0.035);
    hiss(core, t + 0.05 + r() * 0.02, out, 'white', 'bandpass', 3100 * k, 1.5, 0.08 * v, 0.004, 0.03);
  } else if (s === 'wood') {
    thud(core, t, out, 150 * k, 85, 0.3 * v, 0.09);
    hiss(core, t, out, 'pink', 'bandpass', 410 * k, 7, 0.9 * v, 0.002, 0.09);
    hiss(core, t, out, 'white', 'bandpass', 1300 * k, 2, 0.05 * v, 0.002, 0.03);
  } else if (s === 'sand') {
    hiss(core, t, out, 'pink', 'lowpass', 1300 * k, 0.6, 0.3 * v, 0.012, 0.12);
    hiss(core, t + 0.02, out, 'white', 'bandpass', 2700 * k, 0.8, 0.05 * v, 0.02, 0.09);
  } else if (s === 'grass') {
    hiss(core, t, out, 'white', 'bandpass', 3300 * k, 0.8, 0.16 * v, 0.008, 0.07);
    hiss(core, t, out, 'pink', 'lowpass', 500, 0.6, 0.36 * v, 0.006, 0.06);
  } else if (s === 'metal') {
    thud(core, t, out, 130 * k, 70, 0.2 * v, 0.07);
    hiss(core, t, out, 'white', 'bandpass', 870 * k, 14, 0.9 * v, 0.002, 0.16);
    hiss(core, t, out, 'white', 'bandpass', 2300 * k, 20, 0.35 * v, 0.002, 0.1);
  } else {
    const b = hiss(core, t, out, 'white', 'bandpass', 1500 * k, 0.7, 0.38 * v, 0.012, 0.2);
    b.frequency.setValueAtTime(1500 * k, t); b.frequency.exponentialRampToValueAtTime(700, t + 0.2);
    ping(core, t + 0.08 + r() * 0.08, out, 1100 + r() * 1500, 0.03 * v, 0.04);
  }
}

/** One arm through the water. */
export function swimStroke(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const b = hiss(core, t, out, 'white', 'bandpass', 1200, 0.7, 0.2, 0.08, 0.35);
  b.frequency.setValueAtTime(1300 + r() * 300, t); b.frequency.exponentialRampToValueAtTime(600, t + 0.4);
  hiss(core, t, out, 'brown', 'lowpass', 300, 0.7, 0.3, 0.05, 0.25);
  for (let i = 0; i < 3; i++) ping(core, t + 0.12 + r() * 0.3, out, 900 + r() * 2000, 0.03, 0.04);
}

/** Street furniture giving way. speed in m/s. The hydrant goes on hissing: that is the geyser. */
export function propBreak(core: AudioCore, t: number, out: AudioNode, kind: PropKind, speed: number, r: Rand): void {
  const s = clamp01(speed / 20), lvl = 0.45 + 0.55 * s;
  const res = (f: number, q: number, level: number, decay: number, at = t): void => { hiss(core, at, out, 'white', 'bandpass', f, q, level * lvl, 0.001, decay); };
  if (kind === 'hydrant') {
    thud(core, t, out, 120, 50, 0.6 * lvl, 0.14);
    res(640 + r() * 80, 22, 4, 0.35); res(1730 + r() * 200, 28, 2.4, 0.25);
    // The main lets go: a roar that comes up fast and takes seven seconds to be turned off.
    const a = hiss(core, t + 0.08, out, 'white', 'highpass', 1500, 0.5, 0.26, 0.18, 12);
    a.frequency.setValueAtTime(900, t + 0.08); a.frequency.exponentialRampToValueAtTime(2200, t + 0.5);
    hiss(core, t + 0.08, out, 'pink', 'bandpass', 800, 0.5, 0.4, 0.25, 11);
    // What goes up comes down on the road.
    hiss(core, t + 0.9, out, 'pink', 'lowpass', 2400, 0.5, 0.22, 0.6, 11);
  } else if (kind === 'lamp' || kind === 'signal' || kind === 'post') {
    const big = kind === 'post' ? 0.5 : 1;
    thud(core, t, out, 100, 45, 0.5 * lvl * big, 0.15);
    res(310 + r() * 60, 26, 5 * big, 0.6); res(820 + r() * 150, 30, 3 * big, 0.45); res(2150 + r() * 400, 30, 1.6 * big, 0.3);
    // It lands a moment later.
    res(380 + r() * 80, 18, 3.5 * big, 0.4, t + 0.5 + r() * 0.2);
    thud(core, t + 0.5, out, 90, 45, 0.3 * lvl * big, 0.12);
    if (kind !== 'post') for (let i = 0; i < 7; i++) ping(core, t + 0.5 + r() * r() * 0.4, out, 2800 + r() * 6500, 0.05 * lvl, 0.03 + r() * 0.1);
  } else if (kind === 'bin' || kind === 'mailbox') {
    // A hollow steel box, and for the bin what was in it.
    thud(core, t, out, 170, 70, 0.5 * lvl, 0.12);
    res(240 + r() * 60, 9, 3.4, 0.22); res(560 + r() * 160, 12, 2.4, 0.2); res(1300 + r() * 500, 14, 1.2, 0.14);
    for (let i = 1; i < 4; i++) res(300 + r() * 900, 10, 2 / i, 0.12, t + i * (0.14 + r() * 0.1));
    if (kind === 'bin') hiss(core, t + 0.05, out, 'white', 'bandpass', 3000, 0.7, 0.1 * lvl, 0.03, 0.5);
  } else if (kind === 'bench' || kind === 'tree') {
    // Wood: a crack with no ring to it, splinters after.
    thud(core, t, out, 190, 80, 0.5 * lvl, 0.08);
    hiss(core, t, out, 'white', 'bandpass', 1100 + r() * 500, 1.6, 0.6 * lvl, 0.001, 0.05);
    for (let i = 0; i < 4; i++) hiss(core, t + 0.03 + r() * 0.25, out, 'white', 'bandpass', 900 + r() * 2200, 3, 0.25 * lvl * r(), 0.001, 0.03);
    if (kind === 'tree') hiss(core, t + 0.1, out, 'white', 'bandpass', 4200, 0.6, 0.16 * lvl, 0.15, 0.9);
  } else {
    // A cone: plastic, hollow, gone.
    thud(core, t, out, 260, 120, 0.35 * lvl, 0.07);
    hiss(core, t, out, 'pink', 'bandpass', 520, 4, 0.9 * lvl, 0.002, 0.07);
    hiss(core, t + 0.25 + r() * 0.1, out, 'pink', 'bandpass', 600, 4, 0.4 * lvl, 0.002, 0.06);
  }
}

const duckWave = new WeakMap<AudioCore, PeriodicWave>();
/**
 * The giant duck. A squeaky toy scaled up to the size of a house: the reed an octave and a half down, the squeak
 * still riding on top, a sub under it, and then the long wheeze of it filling with air again.
 */
export function duckHonk(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  let w = duckWave.get(core);
  if (!w) { const h = new Float32Array(30); for (let k = 1; k <= 30; k++) h[k - 1] = 1 / Math.pow(k, 0.45); duckWave.set(core, (w = core.wave(h))); }
  const f = 158 * (0.96 + r() * 0.08), d = 0.62;
  const o = core.osc(w, f), sub = core.osc('sine', f / 2), sq = core.osc('sine', f * 12);
  const bend = (p: AudioParam, m: number): void => {
    p.setValueAtTime(f * m * 0.72, t); p.linearRampToValueAtTime(f * m * 1.5, t + 0.07);
    p.linearRampToValueAtTime(f * m * 1.32, t + d * 0.6); p.linearRampToValueAtTime(f * m * 1.05, t + d);
  };
  bend(o.frequency, 1); bend(sub.frequency, 0.5); bend(sq.frequency, 12);
  const f1 = core.filter('bandpass', 880, 2.6), f2 = core.filter('bandpass', 2350, 3.5), g = core.gain(0), dry = core.gain(0.12);
  o.connect(f1); o.connect(f2); o.connect(dry); f1.connect(g); f2.connect(g); dry.connect(g);
  const sg = core.gain(0), qg = core.gain(0);
  sub.connect(sg); sq.connect(qg);
  core.gate(g.gain, t, 0.02, 1.15, d - 0.08, 0.08);
  core.gate(sg.gain, t, 0.03, 0.32, d - 0.1, 0.1);
  core.gate(qg.gain, t, 0.01, 0.07, d - 0.2, 0.15);
  g.connect(out); sg.connect(out); qg.connect(out);
  for (const x of [o, sub, sq]) { x.start(t); x.stop(t + d + 0.1); }
  // Breathing back in: a wheeze that climbs.
  const a = hiss(core, t + d + 0.06, out, 'pink', 'bandpass', 700, 3, 0.9, 0.12, 0.7);
  a.frequency.setValueAtTime(600, t + d + 0.06); a.frequency.exponentialRampToValueAtTime(1700, t + d + 0.75);
  const wo = core.osc('triangle', 300), wg = core.gain(0);
  wo.frequency.setValueAtTime(290, t + d + 0.06); wo.frequency.exponentialRampToValueAtTime(455, t + d + 0.7);
  core.gate(wg.gain, t + d + 0.06, 0.15, 0.08, 0.45, 0.2);
  wo.connect(wg); wg.connect(out); wo.start(t + d); wo.stop(t + d + 0.9);
}

/** Gerald: three rude syllables. */
export function squawk(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const bp = core.filter('bandpass', 2500, 2.2), g = core.gain(0.5);
  bp.connect(g); g.connect(out);
  let at = t;
  for (let i = 0; i < 3; i++) {
    const d = 0.15 + r() * 0.06, f = (640 - i * 45) * (0.95 + r() * 0.1);
    const o = core.osc('sawtooth', f), og = core.gain(0), rough = core.osc('sawtooth', 83 + r() * 20), rg = core.gain(0.8);
    o.frequency.setValueAtTime(f * 1.2, at); o.frequency.linearRampToValueAtTime(f * 0.8, at + d);
    core.gate(og.gain, at, 0.012, 1, d * 0.7, d * 0.3);
    rough.connect(rg); rg.connect(og.gain); o.connect(og); og.connect(bp);
    o.start(at); o.stop(at + d + 0.05); rough.start(at); rough.stop(at + d + 0.05);
    hiss(core, at, bp, 'white', 'bandpass', 3000, 1, 0.25, 0.01, d);
    at += d + 0.07;
  }
}

// ── The part the game runs ───────────────────────────────────────────────────

// The giant duck can be out on the water (world/duckLoose.ts): wherever it is now.
const rectDist = (x: number, z: number, r: { x0: number; z0: number; x1: number; z1: number }): number =>
  Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));

export class WorldSounds {
  private readonly out: GainNode;
  private readonly beds: Record<BedName, Bed>;
  private readonly w: Record<BedName, number> = { surf: 0, harbour: 0, city: 0, crickets: 0, industry: 0, dam: 0, mill: 0, pines: 0, rain: 0, saucer: 0 };
  private readonly pans: Partial<Record<BedName, number>> = {};
  private scanT = 0;
  private birds = 0; private gulls = 0; private docks = 0; private rail = 0; private storm = 0; private fog = 0;
  private gullT = 4; private birdT = 3; private buoyT = 6; private clankT = 9; private trainT = 50; private thunderT = 14; private fogT = 6;
  private hour = -1;
  private stride = 0; private pose = 'stand'; private strokeT = 0; private airT = 0;
  private inland = false;

  constructor(private readonly core: AudioCore, private readonly game: Game) {
    this.out = core.gain(1);
    this.out.connect(core.bus.ambience);
    const mk = (n: BedName, trim: number, wet = 0): Bed => new Bed(core, BEDS[n], this.out, trim, wet);
    this.beds = {
      surf: mk('surf', 0.9), harbour: mk('harbour', 0.8), city: mk('city', 0.7), crickets: mk('crickets', 0.8), industry: mk('industry', 0.7),
      dam: mk('dam', 1), mill: mk('mill', 0.8), pines: mk('pines', 0.8), rain: mk('rain', 1), saucer: mk('saucer', 0.9, 0.3),
    };
    const r = Math.random;
    game.on('propBreak', (e) => {
      const p = e.prop;
      if (!core.claim(p.kind === 'hydrant' ? 'hydrant' : 'prop', p.kind === 'hydrant' ? 2 : 4, p.kind === 'hydrant' ? 6 : 0.12)) return;
      const sp = core.place(p.x, 1, p.z, { ref: 8, max: 160, wet: 0.2 });
      if (sp) propBreak(core, core.now + sp.lag, sp.in, p.kind, Math.hypot(e.vx, e.vz), r);
    });
    game.on('duck', (e) => {
      // The small ducks she collects use the same event; theirs is in ui.ts.
      if (Math.hypot(e.x - DUCK.x, e.z - DUCK.z) > 3 || !core.claim('duck', 1, 1.2)) return;
      const sp = core.place(e.x, 6, e.z, { ref: 45, max: 600, wet: 0.6 });
      if (sp) duckHonk(core, core.now + sp.lag, sp.in, r);
    });
  }

  /** Gerald has done something (the HUD says so). */
  gerald(): void {
    const c = this.core;
    if (c.claim('gerald', 1, 0.8)) squawk(c, c.now + 0.05, this.spot(0.5, 0.4, 'sfx'), Math.random);
  }

  /** Somewhere to play an event with no exact place: a level, a random pan, a share of reverb. */
  private spot(level: number, wet: number, bus: Bus = 'ambience', pan = (Math.random() * 2 - 1) * 0.8): AudioNode {
    const c = this.core, g = c.gain(level), p = c.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p); p.connect(bus === 'ambience' ? this.out : c.bus[bus]);
    if (wet > 0) { const s = c.gain(wet); g.connect(s); s.connect(c.reverbFor(bus)); }
    return g;
  }

  surfaceAt(x: number, z: number): Surface {
    if (rectDist(x, z, PIER) === 0 || rectDist(x, z, PIER_HEAD) === 0) return 'wood';
    if (rectDist(x, z, BREAKWATER) < 4) return 'concrete';
    if (z < MAIN_SPLIT_Z) {
      if (rectDist(x, z, FOOTBRIDGE) === 0) return 'wood';
      if (rectDist(x, z, RAIL_TRESTLE) === 0 || rectDist(x, z, ROAD_BRIDGE) === 0) return 'metal';
      const d = this.game.plan.districtAt(x, z);
      if (d === null) return coastSD(x, z) > -25 ? 'sand' : 'grass';
      return d === 'lake' || d === 'college' || d === 'sister' ? 'grass' : 'concrete';
    }
    if (Math.abs(x - BRIDGE.x) < BRIDGE.hw && z < BRIDGE.z0) return 'metal';
    const d = this.game.plan.districtAt(x, z);
    if (d === 'park') return 'grass';
    if (d === 'strand' || d === null) return islandSD(x, z) > -40 ? 'sand' : d === null ? 'grass' : 'concrete';
    return 'concrete';
  }

  /** Where she is, what time it is, what the sky is doing: every bed's weight, four times a second. */
  private scan(): void {
    const g = this.game, p = g.player, x = p.x, z = p.z, w = this.w, c = this.core;
    const day = 1 - g.sky.night, main = z < MAIN_SPLIT_Z;
    const d = g.plan.districtAt(x, z);
    this.inland = main;
    // Salt water: loudest on the shoreline, gone a couple of streets in.
    const sd = main ? coastSD(x, z) : islandSD(x, z);
    w.surf = sd > -10 ? 1 - 0.4 * clamp01((sd + 10) / 300) : clamp01(1 + (sd + 10) / 150);
    const pier = Math.min(rectDist(x, z, PIER), rectDist(x, z, PIER_HEAD), rectDist(x, z, BREAKWATER));
    this.docks = Math.max(d === 'port' ? 1 : 0, clamp01(1 - pier / 170));
    const fresh = main ? clamp01(1 - Math.max(0, waterDist(x, z)) / 60) : 0;
    w.harbour = Math.max(this.docks, fresh * 0.6);
    this.gulls = day * Math.max(w.surf, this.docks) * (main ? 0.4 : 1);
    w.city = d === 'downtown' ? 1 : d === 'midtown' || d === 'arena' ? 0.8 : d === 'oldtown' || d === 'port' ? 0.5 : d === 'main' || d === 'square' || d === 'stacks' ? 0.45 : d === 'suburb' || d === 'strand' || d === 'park' ? 0.15 : main ? 0.08 : 0.1;
    const leafy = d === 'suburb' || d === 'park' ? 1 : d === 'lake' || d === 'college' || d === 'sister' || d === 'exits' ? 1 : d === 'strand' ? 0.3 : main && d === null ? 0.8 : d === 'square' || d === 'main' ? 0.3 : 0;
    const dry = g.sky.weather === 'rain' ? 0.15 : 1;
    this.birds = leafy * day * dry;
    w.crickets = leafy * g.sky.night * dry;
    w.industry = d === 'industrial' ? 1 : d === 'yard' ? 0.6 : d === 'port' ? 0.35 : 0;
    w.dam = c.gainAt(SITES.dam.x, 3, SITES.dam.z, 45, 520);
    this.pans.dam = c.panAt(SITES.dam.x, SITES.dam.z) * 0.6;
    const mill = rectDist(x, z, { x0: 180, z0: -1565, x1: 248, z1: -1200 });
    w.mill = main ? Math.max(d === 'mill' ? 0.6 : 0, clamp01(1 - mill / 120)) * (0.35 + 0.65 * day) : 0;
    w.pines = main ? Math.max(clamp01(hillAt(x, z) / (HILL.h * 0.6)), d === 'college' ? 0.6 : d === 'lake' ? 0.5 : 0) : 0;
    this.storm = g.sky.weather === 'rain' ? 1 : 0;
    w.rain = this.storm;
    this.fog = g.sky.weather === 'fog' ? 1 : 0;
    this.rail = main ? 1 : 0;
    const hr = g.sky.hour;
    w.saucer = hr >= 3 && hr < 3 + 25 / 60 ? c.gainAt(LIGHTHOUSE.x, 30, LIGHTHOUSE.z, 30, 420) : 0;
    this.pans.saucer = c.panAt(LIGHTHOUSE.x, LIGHTHOUSE.z);
  }

  update(dt: number): void {
    const c = this.core, g = this.game, t = c.now, p = g.player, r = Math.random;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25;
      this.scan();
      // Windows up: the town is still there, a little further off.
      this.out.gain.setTargetAtTime(p.vehicle ? 0.7 : 1, t, 0.3);
      let k: BedName;
      for (k in this.beds) this.beds[k].set(this.w[k], 0.25, this.pans[k] ?? 0);
    }

    // ── Now and then ──
    if (this.gulls > 0.05 && (this.gullT -= dt * (0.4 + this.gulls)) <= 0) {
      this.gullT = 4 + r() * 9;
      if (c.claim('gull', 2, 1.2)) gull(c, t + 0.05, this.spot(0.1 + 0.22 * this.gulls * r(), 0.5), r);
    }
    if (this.birds > 0.05 && (this.birdT -= dt * this.birds) <= 0) {
      this.birdT = 0.7 + r() * 3.2;
      if (c.claim('bird', 3, 0.5)) chirp(c, t + 0.05, this.spot(0.25 + 0.6 * r(), 0.35), r);
    }
    if (this.docks > 0.1) {
      if ((this.buoyT -= dt) <= 0) {
        this.buoyT = 5 + r() * 9;
        const bx = p.x > 320 ? BREAKWATER.x0 : 70, bz = p.x > 320 ? BREAKWATER.z1 + 40 : 700;
        const sp = c.place(bx, 0, bz, { bus: 'ambience', ref: 30, max: 520, wet: 0.5 });
        if (sp && c.claim('buoy', 2, 1)) bellBuoy(c, t + 0.05, sp.in, r);
      }
      if ((this.clankT -= dt * this.docks) <= 0) {
        this.clankT = 6 + r() * 14;
        if (c.claim('clank', 2, 0.4)) clank(c, t + 0.05, this.spot(0.25 + 0.35 * r(), 0.6), r, r());
      }
    } else if (this.w.industry > 0.3 && (this.clankT -= dt) <= 0) {
      this.clankT = 5 + r() * 12;
      if (c.claim('clank', 2, 0.4)) clank(c, t + 0.05, this.spot(0.25 + 0.3 * r(), 0.6), r, 0.5 + 0.5 * r());
    }
    if (this.rail > 0 && (this.trainT -= dt) <= 0) {
      this.trainT = 80 + r() * 110;
      // Somewhere down the line, east or west, and then the crossing if she is near enough to hear it.
      const tx = Math.max(RAIL.x0, Math.min(RAIL.x1, p.x + (r() < 0.5 ? -1 : 1) * (350 + r() * 250)));
      const sp = c.place(tx, 4, RAIL_Z, { bus: 'ambience', ref: 140, max: 2400, wet: 0.7 });
      if (sp && c.claim('train', 1, 9)) {
        const len = trainHorn(c, t + 0.1, sp.in);
        const cr = c.place(MXS[7], 4, RAIL_Z, { bus: 'ambience', ref: 14, max: 420, wet: 0.3 });
        if (cr) crossingBell(c, t + 1, cr.in, len + 4);
      }
    }
    if (this.storm > 0 && (this.thunderT -= dt) <= 0) {
      this.thunderT = 18 + r() * 45;
      const near = r() * r();
      if (c.claim('thunder', 2, 4)) thunder(c, t + 0.1, this.spot(0.5 + 0.4 * near, 0.5, 'ambience', (r() * 2 - 1) * 0.5), near, r);
    }
    if (this.fog > 0 && (this.fogT -= dt) <= 0) {
      this.fogT = 24;
      const sp = c.place(LIGHTHOUSE.x, 25, LIGHTHOUSE.z, { bus: 'ambience', ref: 260, max: 3200, wet: 0.7 });
      if (sp && c.claim('foghorn', 1, 4)) foghorn(c, t + 0.1 + Math.min(1.5, sp.lag), sp.in);
    }
    // The church at Quorum Square counts the hour, for anyone on that side of the water.
    const hr = Math.floor(g.sky.hour);
    if (hr !== this.hour) {
      const first = this.hour < 0;
      this.hour = hr;
      const sp = first ? null : c.place(SITES.square.x, 20, SITES.square.z, { bus: 'ambience', ref: 90, max: 1300, wet: 0.6 });
      if (sp && c.claim('church', 1, 6)) for (let i = 0, n = hr % 12 || 12; i < n; i++) churchBell(c, t + 0.2 + sp.lag + i * 2.3, sp.in);
    }

    // ── Her own feet ──
    const pose = p.person.pose;
    if (!p.vehicle) {
      if (pose === 'walk' || pose === 'run') {
        this.stride += p.speed * dt;
        const len = pose === 'run' ? 1.15 : 0.74;
        if (this.stride >= len) {
          this.stride = 0;
          if (c.claim('step', 3, 0.05)) footstep(c, t, c.direct('sfx', pose === 'run' ? 0.75 : 0.55, 0.08), this.surfaceAt(p.x, p.z), 1, r);
        }
      } else if (pose === 'swim') {
        if ((this.strokeT -= dt * (0.4 + Math.min(1, p.speed / 2))) <= 0) { this.strokeT = 0.62; if (c.claim('step', 3, 0.05)) swimStroke(c, t, c.direct('sfx', 0.6, 0.15), r); }
      }
      const air = pose === 'jump' || pose === 'fall';
      if (air && this.pose !== 'jump' && this.pose !== 'fall' && pose === 'jump') hiss(c, t, c.direct('sfx', 0.5), 'white', 'bandpass', 1900, 1, 0.14, 0.004, 0.06);
      if (air) this.airT += dt;
      else {
        if (this.airT > 0.12 && pose !== 'swim' && c.claim('step', 3, 0.05)) footstep(c, t, c.direct('sfx', 0.8, 0.1), this.surfaceAt(p.x, p.z), Math.min(2.2, 1.3 + this.airT), r);
        this.airT = 0;
      }
    } else { this.stride = 0; this.airT = 0; }
    this.pose = pose;
  }
}
