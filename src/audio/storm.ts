// Rare weather (world/tornado.ts, world/flood.ts), synthesised: the town's tornado siren (a mechanical wail that
// rises and falls over twelve seconds), the funnel's roar (brown noise with a howl on top, louder and brighter the
// nearer it is), the rain's hiss, and the radio's alert tones (the two-tone attention signal, 853 and 960 Hz).
// Nothing is built until the first storm asks for it, and everything is stopped again once it is over.

import type { AudioCore } from './audio';

interface Voices {
  stop(): void;
  sirenG: GainNode; siren: OscillatorNode; siren2: OscillatorNode;
  roarG: GainNode; roarLp: BiquadFilterNode; howlG: GainNode; howlBp: BiquadFilterNode;
  rainG: GainNode;
}

export interface StormMix {
  /** 0..1 siren level (far off: it is the town's, not the funnel's). */
  siren: number;
  /** 0..1 how near and loud the funnel is. */
  roar: number;
  /** 0..1 rain hiss. */
  rain: number;
}

export class StormSound {
  private v: Voices | null = null;
  private t = 0;

  constructor(private readonly core: () => AudioCore | null) {}

  update(dt: number, m: StormMix): void {
    const on = m.siren > 0.001 || m.roar > 0.001 || m.rain > 0.001;
    if (!on) { if (this.v) { this.v.stop(); this.v = null; } return; }
    const core = this.core();
    if (!core) return;
    if (!this.v) this.v = this.build(core);
    const v = this.v, now = core.now;
    this.t += dt;
    // The wail: up over five seconds, held, down over six.
    const ph = (this.t % 12) / 12;
    const w = ph < 0.42 ? Math.sin((ph / 0.42) * Math.PI / 2) : ph < 0.5 ? 1 : Math.cos(((ph - 0.5) / 0.5) * Math.PI / 2);
    const f = 260 + 520 * w;
    v.siren.frequency.setTargetAtTime(f, now, 0.08);
    v.siren2.frequency.setTargetAtTime(f * 1.5, now, 0.08);
    v.sirenG.gain.setTargetAtTime(0.07 * m.siren * (0.35 + 0.65 * w), now, 0.15);
    v.roarG.gain.setTargetAtTime(0.55 * m.roar, now, 0.3);
    v.roarLp.frequency.setTargetAtTime(160 + 900 * m.roar * m.roar, now, 0.3);
    v.howlG.gain.setTargetAtTime(0.09 * m.roar * m.roar, now, 0.3);
    v.howlBp.frequency.setTargetAtTime(380 + 260 * Math.sin(this.t * 0.7) + 300 * m.roar, now, 0.2);
    v.rainG.gain.setTargetAtTime(0.12 * m.rain, now, 0.5);
  }

  /** The radio's attention signal: two tones together for `secs`, on the UI bus so it is heard in or out of a car. */
  alert(secs = 3): void {
    const core = this.core();
    if (!core) return;
    const out = core.direct('ui', 0.06), t = core.now + 0.05;
    for (const f of [853, 960]) {
      const o = core.osc('sine', f), g = core.gain(0);
      o.connect(g); g.connect(out);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.02);
      g.gain.setValueAtTime(1, t + secs - 0.05);
      g.gain.linearRampToValueAtTime(0, t + secs);
      o.start(t); o.stop(t + secs + 0.05);
    }
  }

  private build(core: AudioCore): Voices {
    const sirenOut = core.direct('ambience', 1, 0.6);
    const sirenG = core.gain(0), sLp = core.filter('lowpass', 1400, 0.6);
    const siren = core.osc(core.wave([1, 0.5, 0.3, 0.15, 0.08]), 400), siren2 = core.osc('sine', 600);
    const s2g = core.gain(0.25);
    siren.connect(sLp); siren2.connect(s2g); s2g.connect(sLp); sLp.connect(sirenG); sirenG.connect(sirenOut);
    const amb = core.direct('ambience', 1, 0.2);
    const roar = core.noiseSrc('brown'), roarLp = core.filter('lowpass', 200, 0.9), roarG = core.gain(0);
    roar.connect(roarLp); roarLp.connect(roarG); roarG.connect(amb);
    const howl = core.noiseSrc('pink'), howlBp = core.filter('bandpass', 500, 6), howlG = core.gain(0);
    howl.connect(howlBp); howlBp.connect(howlG); howlG.connect(amb);
    const rain = core.noiseSrc('white'), rHp = core.filter('highpass', 1800, 0.5), rLp = core.filter('lowpass', 7000, 0.5), rainG = core.gain(0);
    rain.connect(rHp); rHp.connect(rLp); rLp.connect(rainG); rainG.connect(amb);
    // (noiseSrc() hands its sources over already started.)
    const srcs: AudioScheduledSourceNode[] = [siren, siren2, roar, howl, rain];
    siren.start(); siren2.start();
    return {
      sirenG, siren, siren2, roarG, roarLp, howlG, howlBp, rainG,
      stop: () => {
        const t = core.now;
        for (const g of [sirenG, roarG, howlG, rainG]) g.gain.setTargetAtTime(0, t, 0.3);
        for (const s of srcs) { try { s.stop(t + 1.5); } catch { /* already stopped */ } }
        setTimeout(() => { sirenOut.disconnect(); amb.disconnect(); }, 2000);
      },
    };
  }
}
