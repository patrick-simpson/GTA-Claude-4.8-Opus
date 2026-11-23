// Moose (world/moose.ts), synthesised: hooves on tarmac or soft ground, the snort, the bull's bellow and a short
// grunt. Like the other one-shots, nothing here knows where anything is: the caller asks AudioCore.place() for an input.

import type { AudioCore } from './audio';

/** One hoof: a dull knock (tarmac gives it a click on top), `k` 0..1 for how hard. */
export function hoof(core: AudioCore, t: number, out: AudioNode, k: number, road: boolean): void {
  const g = core.gain(0), lp = core.filter('lowpass', road ? 2400 : 700, 0.9);
  core.burst('brown', t, 0.12).connect(lp); lp.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5 * k, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  const o = core.osc('sine', road ? 210 : 120), og = core.gain(0);
  o.frequency.setValueAtTime(road ? 240 : 140, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.07);
  o.connect(og); og.connect(out);
  og.gain.setValueAtTime(0, t);
  og.gain.linearRampToValueAtTime(0.35 * k, t + 0.003);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.start(t); o.stop(t + 0.12);
  if (road) {
    const hp = core.filter('bandpass', 3200, 3), cg = core.gain(0);
    core.burst('white', t, 0.03).connect(hp); hp.connect(cg); cg.connect(out);
    cg.gain.setValueAtTime(0.12 * k, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
  }
}

/** A snort: two blasts of breath through a big nose. */
export function snort(core: AudioCore, t: number, out: AudioNode, big = 1): void {
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.32, len = 0.22 + 0.08 * i;
    const bp = core.filter('bandpass', 700 - 120 * i, 1.4), lp = core.filter('lowpass', 2600, 0.7), g = core.gain(0);
    core.burst('pink', at, len + 0.05).connect(bp); bp.connect(lp); lp.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.75 * big, at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, at + len);
  }
}

/**
 * The bull's bellow: a long, nasal, falling groan with a wobble in it. A buzzy saw through two vocal-tract
 * resonances, the pitch climbing a little then sagging away.
 */
export function bellow(core: AudioCore, t: number, out: AudioNode, dur = 1.6, pitch = 1): void {
  const o = core.osc('sawtooth', 120 * pitch), o2 = core.osc('square', 60 * pitch);
  const f = o.frequency;
  f.setValueAtTime(95 * pitch, t);
  f.linearRampToValueAtTime(150 * pitch, t + dur * 0.25);
  f.linearRampToValueAtTime(128 * pitch, t + dur * 0.6);
  f.linearRampToValueAtTime(78 * pitch, t + dur);
  o2.frequency.setValueAtTime(47 * pitch, t);
  o2.frequency.linearRampToValueAtTime(75 * pitch, t + dur * 0.25);
  o2.frequency.linearRampToValueAtTime(39 * pitch, t + dur);
  const vib = core.osc('sine', 6.5), vg = core.gain(5 * pitch);
  vib.connect(vg); vg.connect(f);
  const f1 = core.filter('bandpass', 480, 3), f2 = core.filter('bandpass', 1050, 4), mix = core.gain(0);
  const o2g = core.gain(0.35);
  o.connect(f1); o.connect(f2); o2.connect(o2g); o2g.connect(f1);
  f1.connect(mix); f2.connect(mix); mix.connect(out);
  const p = mix.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(0.9, t + 0.12);
  p.setValueAtTime(0.9, t + dur * 0.55);
  p.linearRampToValueAtTime(0.5, t + dur * 0.85);
  p.linearRampToValueAtTime(0, t + dur);
  for (const x of [o, o2, vib]) { x.start(t); x.stop(t + dur + 0.05); }
}

/** A short low grunt (the cow, the calf at its mother, a bull that has been hit by a car). */
export function grunt(core: AudioCore, t: number, out: AudioNode, pitch = 1): void {
  bellow(core, t, out, 0.38, pitch * 0.9);
}
