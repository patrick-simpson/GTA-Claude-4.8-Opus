// Wildlife (world/fauna.ts), synthesised and kept quiet: a goose's honk, a gull's cry, the blow of a startled deer and a bear's
// huff. Like the moose's, nothing here knows where anything is: the caller asks AudioCore.place() for an input.

import type { AudioCore } from './audio';

/** Ha-HONK: two short buzzy notes through two throat resonances. */
export function honk(core: AudioCore, t: number, out: AudioNode, pitch = 1): void {
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.17, dur = i ? 0.22 : 0.13;
    const o = core.osc('sawtooth', (i ? 330 : 390) * pitch);
    const f = o.frequency;
    f.setValueAtTime((i ? 300 : 360) * pitch, at);
    f.linearRampToValueAtTime((i ? 430 : 490) * pitch, at + dur * 0.4);
    f.linearRampToValueAtTime((i ? 330 : 320) * pitch, at + dur);
    const f1 = core.filter('bandpass', 820, 3), f2 = core.filter('bandpass', 1600, 4), g = core.gain(0);
    o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.34, at + 0.015);
    g.gain.linearRampToValueAtTime(0.26, at + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, at + dur);
    o.start(at); o.stop(at + dur + 0.03);
  }
}

/** A gull's laugh: a few rising and falling squeals, each a little lower than the one before. */
export function gullCry(core: AudioCore, t: number, out: AudioNode, notes = 3, pitch = 1): void {
  for (let i = 0; i < notes; i++) {
    const at = t + i * 0.3, dur = 0.26 - i * 0.015, k = pitch * (1 - i * 0.05);
    const o = core.osc('triangle', 1700 * k), o2 = core.osc('sawtooth', 1700 * k);
    for (const x of [o, o2]) {
      x.frequency.setValueAtTime(1350 * k, at);
      x.frequency.linearRampToValueAtTime(2350 * k, at + dur * 0.35);
      x.frequency.linearRampToValueAtTime(1550 * k, at + dur);
    }
    const vib = core.osc('sine', 31), vg = core.gain(60);
    vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency);
    const bp = core.filter('bandpass', 2300, 1.6), mix = core.gain(0), o2g = core.gain(0.25);
    o.connect(bp); o2.connect(o2g); o2g.connect(bp); bp.connect(mix); mix.connect(out);
    mix.gain.setValueAtTime(0, at);
    mix.gain.linearRampToValueAtTime(0.2, at + 0.03);
    mix.gain.linearRampToValueAtTime(0.14, at + dur * 0.6);
    mix.gain.linearRampToValueAtTime(0, at + dur);
    for (const x of [o, o2, vib]) { x.start(at); x.stop(at + dur + 0.04); }
  }
}

/** The blow of a startled deer: two sharp breaths through the nose. */
export function deerBlow(core: AudioCore, t: number, out: AudioNode, big = 1): void {
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.3, len = 0.26 - 0.08 * i;
    const bp = core.filter('bandpass', 1700 - 200 * i, 0.9), hp = core.filter('highpass', 500, 0.7), g = core.gain(0);
    core.burst('white', at, len + 0.05).connect(bp); bp.connect(hp); hp.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.5 * big, at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, at + len);
  }
}

/** A bear's huff: a low "woof" of breath with a dropping chest note under it. */
export function bearHuff(core: AudioCore, t: number, out: AudioNode, big = 1): void {
  const lp = core.filter('lowpass', 420, 0.8), g = core.gain(0);
  core.burst('brown', t, 0.55).connect(lp); lp.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.7 * big, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  const o = core.osc('sine', 95), og = core.gain(0);
  o.frequency.setValueAtTime(100, t);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.4);
  o.connect(og); og.connect(out);
  og.gain.setValueAtTime(0, t);
  og.gain.linearRampToValueAtTime(0.5 * big, t + 0.04);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  o.start(t); o.stop(t + 0.5);
}
