// Fireworks, synthesised: the thump of a mortar, the whistle of some shells on the way up, the boom of the burst and
// the crackle of the crackling stars. Nothing here knows where anything is: fx/fireworks.ts asks AudioCore.place()
// for an input at the burst (distance, pan, air absorption, reverb) and schedules these at now + the sound's lag,
// so a burst across the bay is seen first and heard a few seconds later, dull and echoing.

import type { AudioCore } from './audio';

/** The mortar: a short low thump with a breathy top, the shell leaving the tube. */
export function fwLift(core: AudioCore, t: number, out: AudioNode, whistle: boolean): void {
  const lp = core.filter('lowpass', 260, 0.9), g = core.gain(0);
  core.burst('brown', t, 0.35).connect(lp); lp.connect(g); g.connect(out);
  core.env(g.gain, t, 0.004, 0.9, 0.3);
  const bp = core.filter('bandpass', 900, 0.8), g2 = core.gain(0);
  core.burst('pink', t, 0.2).connect(bp); bp.connect(g2); g2.connect(out);
  core.env(g2.gain, t, 0.002, 0.25, 0.15);
  if (whistle) {
    // A rising-then-falling whistle that runs for most of the climb.
    const o = core.osc('sine', 900), w = core.gain(0);
    o.frequency.setValueAtTime(900, t + 0.05);
    o.frequency.linearRampToValueAtTime(2600, t + 1.2);
    o.frequency.linearRampToValueAtTime(1900, t + 2.6);
    o.connect(w); w.connect(out);
    w.gain.setValueAtTime(0, t);
    w.gain.linearRampToValueAtTime(0.05, t + 0.25);
    w.gain.setValueAtTime(0.05, t + 2.2);
    w.gain.linearRampToValueAtTime(0, t + 2.7);
    o.start(t); o.stop(t + 2.8);
  }
}

/** The burst. size 0.5 (a backyard cake) .. 1.6 (a finale salute). Far off the top is already gone (place() filters it). */
export function fwBoom(core: AudioCore, t: number, out: AudioNode, size: number): void {
  // The body: brown noise through a low filter, a fast attack and a long fall that the reverb carries on.
  const lp = core.filter('lowpass', 150 + 70 * size, 0.7), g = core.gain(0);
  core.burst('brown', t, 1.2 + size).connect(lp); lp.connect(g); g.connect(out);
  core.env(g.gain, t, 0.006, 1.1 * size, 0.9 + 0.7 * size);
  // The chest thump: a sine that drops in pitch.
  const o = core.osc('sine', 75), og = core.gain(0);
  o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
  o.connect(og); og.connect(out);
  core.env(og.gain, t, 0.004, 0.8 * size, 0.45);
  o.start(t); o.stop(t + 0.6);
  // The crack on top.
  const bp = core.filter('bandpass', 1500, 0.6), cg = core.gain(0);
  core.burst('white', t, 0.12).connect(bp); bp.connect(cg); cg.connect(out);
  core.env(cg.gain, t, 0.001, 0.6 * size, 0.09);
}

/** Crackling stars: one noise source and one gain stepped through `n` sharp spikes over `dur` seconds. */
export function fwCrackle(core: AudioCore, t: number, out: AudioNode, dur: number, n: number, rnd: () => number): void {
  const hp = core.filter('highpass', 1800, 0.7), g = core.gain(0);
  core.burst('white', t, dur + 0.1).connect(hp); hp.connect(g); g.connect(out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  let at = t;
  for (let i = 0; i < n; i++) {
    at = t + dur * (i / n) + rnd() * dur / n * 0.9;
    const v = 0.15 + rnd() * 0.45;
    p.setValueAtTime(0, at);
    p.linearRampToValueAtTime(v, at + 0.0015);
    p.linearRampToValueAtTime(0, at + 0.012 + rnd() * 0.01);
  }
}
