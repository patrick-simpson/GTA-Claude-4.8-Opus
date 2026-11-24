// The train (world/train.ts), synthesised: the locomotive's five-chime air horn, the crossing bell, the diesel's
// rumble in short overlapping grains, and the wheels' clack over the rail joints. Like the other one-shots, nothing
// here knows where anything is: the caller asks AudioCore.place() for an input.

import type { AudioCore } from './audio';

/** The chord of a five-chime horn (a minor-sixth-ish cluster, as North American road locomotives carry). */
const CHIME = [311, 370, 415, 494, 622];

/**
 * One horn note from t for `len` seconds (Infinity: until stop() is called). Returns stop(at).
 * Sawtooth reeds through a resonant low-pass, a breathy attack and a short droop when the air is cut.
 */
export function hornNote(core: AudioCore, t: number, out: AudioNode, len: number, level = 1): (at: number) => void {
  const g = core.gain(0), lp = core.filter('lowpass', 1900, 1.2);
  lp.connect(g); g.connect(out);
  const oscs: OscillatorNode[] = [];
  for (let i = 0; i < CHIME.length; i++) {
    const o = core.osc('sawtooth', CHIME[i] * (1 + (i - 2) * 0.0015));
    const og = core.gain(0.16);
    o.frequency.setValueAtTime(CHIME[i] * 0.94, t);
    o.frequency.linearRampToValueAtTime(CHIME[i], t + 0.12);
    o.connect(og); og.connect(lp); o.start(t); oscs.push(o);
  }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55 * level, t + 0.09);
  g.gain.linearRampToValueAtTime(0.42 * level, t + 0.4);
  let stopped = false;
  const stop = (at: number): void => {
    if (stopped) return;
    stopped = true;
    const s = Math.max(at, t + 0.15);
    g.gain.cancelScheduledValues(s);
    g.gain.setValueAtTime(0.42 * level, s);
    g.gain.exponentialRampToValueAtTime(0.001, s + 0.22);
    for (const o of oscs) { o.frequency.setValueAtTime(o.frequency.value, s); o.frequency.linearRampToValueAtTime(o.frequency.value * 0.93, s + 0.2); o.stop(s + 0.25); }
  };
  if (Number.isFinite(len)) stop(t + len);
  return stop;
}

/** The crossing pattern: long, long, short, long. Returns how long it lasts. */
export function hornPattern(core: AudioCore, t: number, out: AudioNode): number {
  const parts: [number, number][] = [[0, 1.5], [1.85, 1.5], [3.7, 0.55], [4.6, 2.6]];
  for (const [at, len] of parts) hornNote(core, t + at, out, len);
  return 7.2;
}

/** One stroke of a crossing bell: a bright clang with inharmonic partials. */
export function bellStroke(core: AudioCore, t: number, out: AudioNode, k = 1): void {
  const parts: [number, number, number][] = [[1180, 0.3, 0.35], [2650, 0.16, 0.18], [3920, 0.08, 0.1], [610, 0.12, 0.5]];
  for (const [f, a, d] of parts) {
    const o = core.osc('sine', f), g = core.gain(0);
    o.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a * k, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.start(t); o.stop(t + d + 0.05);
  }
}

/** A grain of diesel: 0.42 s of a low firing note and filtered noise, faded in and out so grains overlap seamlessly. notch 0..1 is the throttle. */
export function dieselGrain(core: AudioCore, t: number, out: AudioNode, notch: number, k = 1): void {
  const f = 34 + notch * 26, len = 0.42;
  const g = core.gain(0), lp = core.filter('lowpass', 240 + notch * 520, 0.8);
  lp.connect(g); g.connect(out);
  for (const [mul, a] of [[1, 0.5], [2, 0.32], [3.02, 0.14]] as const) {
    const o = core.osc('sawtooth', f * mul), og = core.gain(a);
    o.connect(og); og.connect(lp); o.start(t); o.stop(t + len + 0.02);
  }
  core.burst('brown', t, len).connect(lp);
  const lvl = (0.32 + 0.4 * notch) * k;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(lvl, t + 0.12);
  g.gain.setValueAtTime(lvl, t + len - 0.12);
  g.gain.linearRampToValueAtTime(0, t + len);
}

/** Two wheels over a rail joint: clack-clack, `gap` seconds apart. */
export function clack(core: AudioCore, t: number, out: AudioNode, gap: number, k = 1): void {
  for (let i = 0; i < 2; i++) {
    const at = t + i * gap, g = core.gain(0), bp = core.filter('bandpass', 900, 1.6);
    core.burst('white', at, 0.05).connect(bp); bp.connect(g); g.connect(out);
    g.gain.setValueAtTime(0.4 * k, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.045);
    const o = core.osc('sine', 150), og = core.gain(0);
    o.connect(og); og.connect(out);
    og.gain.setValueAtTime(0.3 * k, at);
    og.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
    o.start(at); o.stop(at + 0.08);
  }
}

/** Steel on gravel and steel on steel: a derailment, for `len` seconds. */
export function grind(core: AudioCore, t: number, out: AudioNode, len: number): void {
  const g = core.gain(0), bp = core.filter('bandpass', 1700, 0.9), lp = core.filter('lowpass', 500, 0.7);
  core.burst('white', t, len).connect(bp); bp.connect(g);
  core.burst('brown', t, len).connect(lp); lp.connect(g);
  g.connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.9, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
}
