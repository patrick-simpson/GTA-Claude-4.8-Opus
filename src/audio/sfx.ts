// One-shot recipes. Each is a plain function: (core, start time, where to play
// into, how hard) and nothing else, so the game and the offline lab call the
// very same code. `r` is a 0..1 random source: Math.random in the game (no two
// crashes alike), a seeded one in the lab (the same picture every run).

import type { AudioCore } from './audio';

export type Rand = () => number;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A sine that falls from f0 to f1: the body of every thud, thump and kick in the game. */
export function thud(core: AudioCore, t: number, out: AudioNode, f0: number, f1: number, level: number, seconds: number): void {
  const o = core.osc('sine', f0), g = core.gain(0);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + seconds * 0.7);
  core.env(g.gain, t, 0.004, level, seconds);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + seconds + 0.05);
}

/** Filtered noise with an envelope. Returns the filter so a caller can sweep it. */
export function hiss(core: AudioCore, t: number, out: AudioNode, kind: 'white' | 'pink' | 'brown', type: BiquadFilterType, f: number, q: number, level: number, attack: number, decay: number): BiquadFilterNode {
  const s = core.burst(kind, t, attack + decay + 0.03), b = core.filter(type, f, q), g = core.gain(0);
  core.env(g.gain, t, attack, level, decay);
  s.connect(b); b.connect(g); g.connect(out);
  return b;
}

/** A short ringing partial: glass, bells, pings. */
export function ping(core: AudioCore, t: number, out: AudioNode, f: number, level: number, decay: number, type: OscillatorType = 'sine'): void {
  const o = core.osc(type, f), g = core.gain(0);
  core.env(g.gain, t, 0.002, level, decay);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + decay + 0.05);
}

/**
 * A car hitting something. speed is the closing speed in m/s, heavy 0..1 the weight of what is involved.
 * A low thud, a crunch through a handful of resonances picked fresh every time (so no two are the same),
 * broadband crush, and above about 30 mph glass and a scrape.
 */
export function impact(core: AudioCore, t: number, out: AudioNode, speed: number, heavy: number, r: Rand): void {
  const s = clamp01(speed / 24), lvl = 0.22 + 0.78 * s;
  thud(core, t, out, 95 - 30 * heavy + r() * 20, 36, 0.6 * lvl, 0.16 + 0.2 * s);
  // The crush: all bands at once, shorter than the ring.
  hiss(core, t, out, 'white', 'lowpass', 2200 + 6500 * s, 0.4, 0.55 * lvl, 0.002, 0.08 + 0.18 * s);
  // Sheet metal: resonances between 180 Hz and 4 kHz, each with its own decay.
  const n = 3 + Math.floor(s * 4 + r() * 2);
  const src = core.burst('white', t, 0.5), exc = core.gain(0);
  core.env(exc.gain, t, 0.001, 1, 0.05 + 0.1 * s);
  src.connect(exc);
  for (let i = 0; i < n; i++) {
    const f = 180 * Math.pow(22, r()) * (1 - 0.3 * heavy);
    const b = core.filter('bandpass', f, 6 + r() * 14), g = core.gain(0);
    core.env(g.gain, t + r() * 0.02, 0.002, (0.5 + r() * 0.5) * lvl * 4.5, 0.07 + r() * (0.12 + 0.3 * s));
    exc.connect(b); b.connect(g); g.connect(out);
  }
  if (speed > 13) {
    // Glass: bright partials falling over each other for half a second.
    const k = 5 + Math.floor(r() * 6 * s + 3 * s);
    for (let i = 0; i < k; i++) ping(core, t + 0.02 + r() * r() * 0.45, out, 2600 + r() * 7000, (0.03 + r() * 0.06) * lvl, 0.03 + r() * 0.14);
    hiss(core, t + 0.01, out, 'white', 'highpass', 5000, 0.5, 0.12 * lvl, 0.004, 0.25);
  }
  if (speed > 9) {
    // The scrape after: a band of noise that shudders.
    const b = hiss(core, t + 0.05, out, 'white', 'bandpass', 900 + r() * 1400, 2.5, 0.16 * lvl, 0.03, 0.3 + 0.4 * s);
    b.frequency.setValueAtTime(b.frequency.value, t + 0.05);
    b.frequency.exponentialRampToValueAtTime(b.frequency.value * (0.5 + r() * 0.3), t + 0.5 + 0.4 * s);
  }
}

/** Somebody on the bonnet: flesh on sheet steel, no ring to speak of. */
export function bodyHit(core: AudioCore, t: number, out: AudioNode, speed: number, r: Rand): void {
  const s = clamp01(speed / 20), lvl = 0.3 + 0.6 * s;
  thud(core, t, out, 120 + r() * 30, 50, 0.7 * lvl, 0.12);
  hiss(core, t, out, 'pink', 'lowpass', 900 + 1500 * s, 0.6, 0.5 * lvl, 0.002, 0.07);
  const b = core.filter('bandpass', 260 + r() * 200, 5), g = core.gain(0), src = core.burst('white', t, 0.2);
  core.env(g.gain, t, 0.002, 1.2 * lvl, 0.12);
  src.connect(b); b.connect(g); g.connect(out);
}

/** A door. heavy 0..1 (hatchback .. bus). Opening is the latch then the swing; closing is the swing then the thunk. */
export function door(core: AudioCore, t: number, out: AudioNode, heavy: number, closing: boolean, r: Rand): void {
  const latch = closing ? t + 0.012 : t;
  hiss(core, latch, out, 'white', 'bandpass', 2300 - 900 * heavy + r() * 300, 3, 0.22, 0.001, 0.018);
  hiss(core, latch + 0.03 + r() * 0.01, out, 'white', 'bandpass', 1500 - 500 * heavy, 4, 0.1, 0.001, 0.02);
  if (closing) {
    thud(core, t, out, 150 - 60 * heavy, 55 - 15 * heavy, 0.55 + 0.25 * heavy, 0.11 + 0.08 * heavy);
    hiss(core, t, out, 'pink', 'lowpass', 700 - 250 * heavy, 0.7, 0.4, 0.002, 0.06 + 0.05 * heavy);
    // The cabin's own boom, a beat behind.
    const b = core.filter('bandpass', 210 - 70 * heavy, 7), g = core.gain(0), src = core.burst('pink', t, 0.3);
    core.env(g.gain, t + 0.004, 0.003, 0.9, 0.13);
    src.connect(b); b.connect(g); g.connect(out);
  } else {
    thud(core, t + 0.02, out, 110 - 30 * heavy, 60, 0.18, 0.08);
  }
}

/** The starter: half a second of a small motor labouring, for anything that burns fuel. */
export function starter(core: AudioCore, t: number, out: AudioNode, heavy: number, r: Rand): void {
  const o = core.osc('sawtooth', 150 - 50 * heavy), am = core.osc('square', 11 + r() * 3 - 3 * heavy), amG = core.gain(0.5), g = core.gain(0), lp = core.filter('lowpass', 1400, 1.2);
  const len = 0.42 + 0.2 * heavy;
  o.frequency.setValueAtTime(130 - 40 * heavy, t);
  o.frequency.linearRampToValueAtTime(175 - 50 * heavy, t + len);
  core.gate(g.gain, t, 0.02, 0.28, len, 0.06);
  // The gain rides between 0 and 1 on the square: each compression stroke loads the motor.
  const vca = core.gain(0.5);
  am.connect(amG); amG.connect(vca.gain);
  o.connect(lp); lp.connect(vca); vca.connect(g); g.connect(out);
  o.start(t); am.start(t); o.stop(t + len + 0.1); am.stop(t + len + 0.1);
}

/** An electric car waking up: two soft rising notes of our own. */
export function evReady(core: AudioCore, t: number, out: AudioNode): void {
  ping(core, t, out, 587.3, 0.22, 0.28, 'triangle');
  ping(core, t + 0.13, out, 880, 0.22, 0.4, 'triangle');
}

/** Wheels meeting the road again. hard 0..1. */
export function landing(core: AudioCore, t: number, out: AudioNode, hard: number, heavy: number, r: Rand): void {
  thud(core, t, out, 78 - 20 * heavy, 34, 0.5 + 0.5 * hard, 0.2 + 0.12 * hard);
  hiss(core, t, out, 'brown', 'lowpass', 500 + 900 * hard, 0.6, 0.6 + 0.6 * hard, 0.003, 0.1 + 0.08 * hard);
  // Springs and trim: two small knocks.
  hiss(core, t + 0.05 + r() * 0.03, out, 'white', 'bandpass', 1200 + r() * 600, 5, 0.1 * hard, 0.001, 0.03);
  hiss(core, t + 0.11 + r() * 0.04, out, 'white', 'bandpass', 700 + r() * 300, 5, 0.07 * hard, 0.001, 0.04);
}

/** Something into the water. big: a car or a long fall. */
export function splash(core: AudioCore, t: number, out: AudioNode, big: boolean, r: Rand): void {
  const k = big ? 1 : 0.45, len = big ? 1.1 : 0.5;
  if (big) thud(core, t, out, 70, 30, 0.7, 0.3);
  // The slap, then the wash falling in pitch as the hole closes.
  hiss(core, t, out, 'white', 'lowpass', big ? 3500 : 5000, 0.5, 0.5 * k, 0.004, 0.09);
  const b = hiss(core, t + 0.03, out, 'white', 'bandpass', 2600, 0.7, 0.55 * k, 0.05, len);
  b.frequency.setValueAtTime(2600, t + 0.03);
  b.frequency.exponentialRampToValueAtTime(big ? 500 : 900, t + len);
  // Drops coming back down.
  const n = big ? 14 : 6;
  for (let i = 0; i < n; i++) {
    const at = t + 0.15 + r() * len * 0.9, f = 900 + r() * 2600;
    const o = core.osc('sine', f), g = core.gain(0);
    o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * 1.6, at + 0.04);
    core.env(g.gain, at, 0.002, 0.05 * k * (0.4 + r()), 0.045);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.1);
  }
}

/** A car going under: three seconds of air leaving it. */
export function gurgle(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  const len = 3.2;
  const b = hiss(core, t, out, 'brown', 'lowpass', 420, 1.5, 0.7, 0.4, len);
  b.frequency.setValueAtTime(420, t); b.frequency.linearRampToValueAtTime(160, t + len);
  for (let i = 0; i < 30; i++) {
    const u = r(), at = t + 0.1 + u * u * len + r() * 0.3, f = 140 + r() * 380, d = 0.05 + r() * 0.07;
    const o = core.osc('sine', f), g = core.gain(0);
    o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * (1.5 + r() * 0.6), at + d);
    core.env(g.gain, at, 0.006, 0.22 * (1 - 0.6 * (at - t) / (len + 0.4)) * (0.5 + r() * 0.5), d);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + d + 0.06);
  }
}
