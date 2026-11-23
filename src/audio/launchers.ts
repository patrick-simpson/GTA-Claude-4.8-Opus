// Cannons and catapults (world/launchers.ts), synthesised: the fuse's fizz, the wooden creak of a trebuchet arm
// coming over, the thwack of a catapult arm on its stop bar, the whoosh of a person leaving, and the thud of a
// roof being inspected personally. The cannon's BOOM is the fireworks' salute (audio/fireworks.ts fwBoom).
// Like the fireworks, nothing here knows where anything is: the caller asks AudioCore.place() for an input.

import type { AudioCore } from './audio';

/** A lit fuse: crackly high hiss with a ragged level, for `dur` seconds. */
export function fuseHiss(core: AudioCore, t: number, out: AudioNode, dur: number): void {
  const hp = core.filter('highpass', 2600, 0.8), g = core.gain(0);
  core.burst('white', t, dur + 0.1).connect(hp); hp.connect(g); g.connect(out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  const n = Math.max(4, Math.round(dur * 28));
  for (let i = 0; i < n; i++) {
    const at = t + (dur * i) / n;
    p.linearRampToValueAtTime(0.05 + 0.12 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1), at);
  }
  p.linearRampToValueAtTime(0, t + dur + 0.05);
}

/** Timber under load: a slow saw tone wandering in pitch through a narrow resonance, `dur` seconds. */
export function creak(core: AudioCore, t: number, out: AudioNode, dur: number, pitch = 1): void {
  const o = core.osc('sawtooth', 70 * pitch), bp = core.filter('bandpass', 520 * pitch, 5), g = core.gain(0);
  o.frequency.setValueAtTime(70 * pitch, t);
  // Stick-slip: the pitch jumps about in small steps, which is what makes it a creak and not a note.
  const steps = Math.max(3, Math.round(dur * 9));
  for (let i = 1; i <= steps; i++) o.frequency.linearRampToValueAtTime((62 + ((i * 37) % 23) * 2.2) * pitch, t + (dur * i) / steps);
  o.connect(bp); bp.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.32, t + 0.08);
  g.gain.setValueAtTime(0.32, t + dur * 0.8);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.start(t); o.stop(t + dur + 0.05);
}

/** A ratchet being wound: `n` dry clicks over `dur` seconds. */
export function ratchet(core: AudioCore, t: number, out: AudioNode, dur: number, n: number): void {
  const bp = core.filter('bandpass', 2200, 2), g = core.gain(0);
  core.burst('white', t, dur + 0.05).connect(bp); bp.connect(g); g.connect(out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  for (let i = 0; i < n; i++) {
    const at = t + (dur * i) / n;
    p.setValueAtTime(0, at); p.linearRampToValueAtTime(0.5, at + 0.002); p.linearRampToValueAtTime(0, at + 0.018);
  }
}

/** Wood hitting wood hard (the catapult arm on its stop bar), or a body on a roof (soft = true). */
export function thwack(core: AudioCore, t: number, out: AudioNode, soft = false): void {
  const lp = core.filter('lowpass', soft ? 380 : 900, 0.8), g = core.gain(0);
  core.burst('brown', t, 0.3).connect(lp); lp.connect(g); g.connect(out);
  core.env(g.gain, t, 0.002, soft ? 0.9 : 1.2, soft ? 0.22 : 0.16);
  const o = core.osc('sine', soft ? 90 : 160), og = core.gain(0);
  o.frequency.setValueAtTime(soft ? 110 : 190, t); o.frequency.exponentialRampToValueAtTime(soft ? 45 : 80, t + 0.2);
  o.connect(og); og.connect(out);
  core.env(og.gain, t, 0.002, soft ? 0.7 : 0.5, 0.2);
  o.start(t); o.stop(t + 0.3);
}

/** Air parting: a band of noise sweeping down, for a person leaving at speed. */
export function whoosh(core: AudioCore, t: number, out: AudioNode): void {
  const bp = core.filter('bandpass', 1400, 1.2), g = core.gain(0);
  bp.frequency.setValueAtTime(1800, t); bp.frequency.exponentialRampToValueAtTime(380, t + 0.7);
  core.burst('pink', t, 0.8).connect(bp); bp.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.08); g.gain.linearRampToValueAtTime(0, t + 0.75);
}
