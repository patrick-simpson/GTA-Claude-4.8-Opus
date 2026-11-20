// The engine room: buses, the limiter, the reverb send, where the listener is,
// and the handful of helpers every sound in src/audio/ is built from.
//
// Nothing here knows about the game. `AudioCore` takes any BaseAudioContext, so
// the very same graph renders on an OfflineAudioContext: that is how the sound
// is checked without ears (scratch/audio/lab.ts measures and draws it).
//
//   engine ─┐
//   sfx ────┤                              ┌─ reverb (four damped combs) ─┐
//   ambience┼─ world (shut while paused) ──┴──────────────────────────────┴─┐
//   music ──┘                                                               ├─ master ─ limiter ─ soft clip ─ out
//   ui ─────────────────────────────────────────────────────────────────────┘
//
// Everything is synthesized: there is not one audio file in the game.

export type Bus = 'engine' | 'sfx' | 'ambience' | 'music' | 'ui';
export const BUSES: readonly Bus[] = ['engine', 'sfx', 'ambience', 'music', 'ui'];

/** What the menu's sliders hold, each 0..1. `sfx` drives the engine, effects and UI buses together. */
export interface Volumes { master: number; music: number; sfx: number; ambience: number }

/** How loud each class sits before the player touches a slider. Tuned from the level tables in scratch/audio. */
const TRIM: Record<Bus, number> = { engine: 0.55, sfx: 0.8, ambience: 0.6, music: 0.5, ui: 1 };

export const SOUND_SPEED = 343;

/** A place for a one-shot to play into, already attenuated and panned for where it is. */
export interface Spot { in: AudioNode; /** 0..1 loudness after distance. */ g: number; /** Seconds the sound takes to arrive. */ lag: number; d: number }

export interface PlaceOpts { bus?: Bus; /** Distance (m) at which the sound is at full level. */ ref?: number; /** Beyond this it is not played at all. */ max?: number; /** 0..1 share sent to the reverb. */ wet?: number }

// A small deterministic generator for the noise buffers and anything else that must render the same twice.
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const smooth = (t: number): number => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export class AudioCore {
  readonly bus: Record<Bus, GainNode>;
  readonly world: GainNode;
  readonly master: GainNode;
  /** Input of the reverb. One-shots get a send through place(); beds connect their own. */
  readonly reverb: GainNode;
  /** Two seconds of white, four of pink, four of brown: every hiss, roar and rumble loops one of these. */
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly rate: number;

  // The listener (the camera): position, its right-hand vector on the ground plane, and velocity for Doppler.
  lx = 0; ly = 0; lz = 0; rx = 1; rz = 0; lvx = 0; lvz = 0;

  /** One-shots refused by the voice limiter since the start, for the tests. */
  dropped = 0;
  /** One-shots started. */
  played = 0;

  private readonly combFb: GainNode[] = [];
  private readonly combLp: BiquadFilterNode[] = [];
  private readonly revOut: GainNode;
  private readonly voices = new Map<string, Float64Array>();
  private readonly vol: Volumes = { master: 0.8, music: 0.7, sfx: 0.8, ambience: 0.8 };

  constructor(readonly ctx: BaseAudioContext) {
    const c = ctx;
    this.rate = c.sampleRate;
    this.white = this.noise(2, 0, 11);
    this.pink = this.noise(4, 1, 23);
    this.brown = this.noise(4, 2, 37);

    // Master, then a gentle limiter, then a soft clip that only bends the last 2 dB: nothing reaches the output above 1.
    this.master = c.createGain();
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -9; lim.knee.value = 9; lim.ratio.value = 10; lim.attack.value = 0.003; lim.release.value = 0.22;
    // Chromium's compressor adds make-up gain for its own curve (about +4 dB at these settings); take it back out.
    const post = c.createGain(); post.gain.value = 0.85;
    const clip = c.createWaveShaper();
    const N = 1025, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x), k = 0.8;
      // Straight up to 0.8, then a tanh shoulder that lands at 0.97.
      curve[i] = Math.sign(x) * (a < k ? a : k + 0.17 * Math.tanh((a - k) / 0.17));
    }
    clip.curve = curve;
    this.master.connect(lim); lim.connect(post); post.connect(clip); clip.connect(c.destination);

    this.world = c.createGain();
    this.world.connect(this.master);
    const bus = {} as Record<Bus, GainNode>;
    for (const b of BUSES) {
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(b === 'ui' ? this.master : this.world);
      bus[b] = g;
    }
    this.bus = bus;

    // The reverb: a pre-delay into four combs with a low-pass in each loop, spread left and right. About the price of
    // a dozen biquads, and it is the same four combs for a street (short, bright) and for open water (long, dark).
    this.reverb = c.createGain();
    this.revOut = c.createGain(); this.revOut.gain.value = 0.5;
    this.revOut.connect(this.world);
    const pre = c.createDelay(0.1); pre.delayTime.value = 0.023;
    this.reverb.connect(pre);
    const times = [0.0437, 0.0571, 0.0683, 0.0797];
    for (let i = 0; i < times.length; i++) {
      const d = c.createDelay(0.2); d.delayTime.value = times[i];
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.3;
      const fb = c.createGain(); fb.gain.value = 0.7;
      const pan = c.createStereoPanner(); pan.pan.value = i % 2 ? 0.7 : -0.7;
      pre.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d);
      lp.connect(pan); pan.connect(this.revOut);
      this.combFb.push(fb); this.combLp.push(lp);
    }
    this.setVolumes(this.vol, true);
  }

  get now(): number { return this.ctx.currentTime; }

  /** Looping noise with the seam cross-faded away, so a four-second loop never ticks. kind: 0 white, 1 pink, 2 brown. */
  private noise(seconds: number, kind: 0 | 1 | 2, seed: number): AudioBuffer {
    const n = Math.floor(seconds * this.rate), fade = 2048;
    const buf = this.ctx.createBuffer(1, n, this.rate), d = buf.getChannelData(0);
    const r = mulberry(seed), raw = new Float32Array(n + fade);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n + fade; i++) {
      const w = r() * 2 - 1;
      if (kind === 0) raw[i] = w;
      else if (kind === 1) {
        // Paul Kellet's economy pink filter.
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        raw[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      } else {
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last * 3.5;
      }
    }
    for (let i = 0; i < n; i++) d[i] = raw[i];
    // The samples that would have followed the end are blended over the start: the wrap is continuous.
    for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = raw[i] * k + raw[n + i] * (1 - k); }
    return buf;
  }

  /** Slider values, 0..1. They glide: a dragged slider never zippers. */
  setVolumes(v: Volumes, instant = false): void {
    const t = this.ctx.currentTime, tc = instant ? 0.001 : 0.05;
    const sq = (x: number): number => { x = clamp(x, 0, 1); return x * x; };
    this.vol.master = v.master; this.vol.music = v.music; this.vol.sfx = v.sfx; this.vol.ambience = v.ambience;
    const set = (p: AudioParam, x: number): void => { if (instant) p.setValueAtTime(x, t); else p.setTargetAtTime(x, t, tc); };
    set(this.master.gain, sq(v.master));
    set(this.bus.engine.gain, sq(v.sfx) * TRIM.engine);
    set(this.bus.sfx.gain, sq(v.sfx) * TRIM.sfx);
    set(this.bus.ui.gain, sq(v.sfx) * TRIM.ui);
    set(this.bus.ambience.gain, sq(v.ambience) * TRIM.ambience);
    set(this.bus.music.gain, sq(v.music) * TRIM.music);
  }

  /** Shut or open everything but the UI (the pause card still rustles). */
  setWorld(on: boolean): void {
    this.world.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.03);
  }

  /** 0 = a street between buildings, 1 = open water or the hill: longer, darker tail. */
  setSpace(open: number): void {
    const t = this.ctx.currentTime, o = clamp(open, 0, 1);
    for (let i = 0; i < this.combFb.length; i++) {
      this.combFb[i].gain.setTargetAtTime(0.66 + 0.2 * o, t, 0.4);
      this.combLp[i].frequency.setTargetAtTime(3400 - 1700 * o, t, 0.4);
    }
  }

  setListener(x: number, y: number, z: number, rx: number, rz: number, vx: number, vz: number): void {
    this.lx = x; this.ly = y; this.lz = z; this.lvx = vx; this.lvz = vz;
    const m = Math.hypot(rx, rz) || 1;
    this.rx = rx / m; this.rz = rz / m;
  }

  /** Loudness 0..1 at the listener for a source at (x, y, z): full inside `ref`, inverse beyond it, faded to nothing by `max`. */
  gainAt(x: number, y: number, z: number, ref: number, max: number): number {
    const d = Math.hypot(x - this.lx, y - this.ly, z - this.lz);
    if (d >= max) return 0;
    return (d <= ref ? 1 : ref / d) * (1 - smooth((d - max * 0.6) / (max * 0.4)));
  }
  /** -1 hard left .. +1 hard right. Sounds on top of the listener sit in the middle. */
  panAt(x: number, z: number): number {
    const dx = x - this.lx, dz = z - this.lz, d = Math.hypot(dx, dz);
    if (d < 0.5) return 0;
    return clamp(((dx * this.rx + dz * this.rz) / d) * 0.85 * smooth(d / 5), -1, 1);
  }
  /** Pitch ratio for a source moving at (vx, vz): mild on purpose (half the real effect), and never extreme. */
  doppler(x: number, z: number, vx: number, vz: number): number {
    const dx = x - this.lx, dz = z - this.lz, d = Math.hypot(dx, dz);
    if (d < 1) return 1;
    // Closing speed: positive when the two are approaching.
    const close = -((vx - this.lvx) * dx + (vz - this.lvz) * dz) / d;
    return clamp(1 + (close * 0.5) / SOUND_SPEED, 0.88, 1.12);
  }

  /**
   * The voice limiter. Each class of one-shot has a few slots; a sound that finds none is simply not played
   * (the ones already ringing are the ones the ear is on). Returns false when the caller should stay silent.
   */
  claim(kind: string, cap: number, seconds: number): boolean {
    let a = this.voices.get(kind);
    if (!a) this.voices.set(kind, (a = new Float64Array(cap)));
    const t = this.ctx.currentTime;
    for (let i = 0; i < a.length; i++) if (a[i] <= t) { a[i] = t + seconds; this.played++; return true; }
    this.dropped++;
    return false;
  }

  /** An input for a one-shot at a point in the world: distance, pan, air absorption and a reverb send, or null if nobody could hear it. */
  place(x: number, y: number, z: number, o: PlaceOpts = {}): Spot | null {
    const ref = o.ref ?? 8, max = o.max ?? 220;
    const g = this.gainAt(x, y, z, ref, max);
    if (g < 0.004) return null;
    const c = this.ctx, d = Math.hypot(x - this.lx, y - this.ly, z - this.lz);
    const gain = c.createGain(); gain.gain.value = g;
    const pan = c.createStereoPanner(); pan.pan.value = this.panAt(x, z);
    let head: AudioNode = gain;
    if (d > 40) {
      // Distance takes the top off first.
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
      lp.frequency.value = clamp(16000 * (40 / d), 900, 16000);
      lp.connect(gain); head = lp;
    }
    gain.connect(pan); pan.connect(this.bus[o.bus ?? 'sfx']);
    const wet = o.wet ?? 0.25;
    if (wet > 0) {
      // The tail holds up better than the direct sound: far-off bangs are mostly echo.
      const send = c.createGain(); send.gain.value = wet * (0.5 + 0.5 * Math.min(1, d / 60)) / Math.max(g, 0.25) * g;
      gain.connect(send); send.connect(this.reverb);
    }
    return { in: head, g, lag: d / SOUND_SPEED, d };
  }

  /** An input for a sound with no position (the player's own car, the UI). */
  direct(bus: Bus, level = 1, wet = 0): AudioNode {
    const g = this.ctx.createGain(); g.gain.value = level;
    g.connect(this.bus[bus]);
    if (wet > 0) { const s = this.ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(this.reverb); }
    return g;
  }

  // ── Building blocks ────────────────────────────────────────────────────────

  gain(v = 1): GainNode { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  filter(type: BiquadFilterType, f: number, q = 0.7, gainDb = 0): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gainDb;
    return b;
  }

  osc(type: OscillatorType | PeriodicWave, f: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType; else o.setPeriodicWave(type as PeriodicWave);
    o.frequency.value = f;
    return o;
  }

  /** A wave from harmonic amplitudes (index 0 = the fundamental). Normalised by the browser to peak 1. */
  wave(harm: ArrayLike<number>, phase?: ArrayLike<number>): PeriodicWave {
    const n = harm.length + 1, re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const p = phase ? phase[i - 1] : 0;
      re[i] = harm[i - 1] * Math.sin(p); im[i] = harm[i - 1] * Math.cos(p);
    }
    return this.ctx.createPeriodicWave(re, im);
  }

  /** A looping noise source, started at a random point in the buffer so two of them never correlate. Not yet connected. */
  noiseSrc(kind: 'white' | 'pink' | 'brown', rate = 1, offset = -1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this[kind]; s.loop = true; s.playbackRate.value = rate;
    this.noiseAt = offset >= 0 ? offset : (this.noiseAt * 1.618 + 0.37) % 1;
    s.start(0, this.noiseAt * (s.buffer.duration - 0.1));
    return s;
  }
  private noiseAt = 0.21;

  /** A burst of noise for a one-shot: starts at t, stops itself after `seconds`. */
  burst(kind: 'white' | 'pink' | 'brown', t: number, seconds: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this[kind]; s.loop = true; s.playbackRate.value = rate;
    this.noiseAt = (this.noiseAt * 1.618 + 0.37) % 1;
    s.start(t, this.noiseAt * (s.buffer.duration - 0.1));
    s.stop(t + seconds + 0.02);
    return s;
  }

  /** Attack to `peak` in `a` seconds from silence, then an exponential fall to nothing by t + a + d. Click-free at both ends. */
  env(p: AudioParam, t: number, a: number, peak: number, d: number): void {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + Math.max(a, 0.0015));
    // setTargetAtTime reaches 1/400 of the peak after six time constants; a short linear ramp finishes the job.
    // (A ramp straight after a setTarget would cut the curve short in Chromium, so the curve's own end value is pinned first.)
    const t1 = t + Math.max(a, 0.0015);
    p.setTargetAtTime(0, t1, d / 6);
    p.setValueAtTime(peak * Math.exp(-6), t1 + d);
    p.linearRampToValueAtTime(0, t1 + d + 0.01);
  }

  /** Attack, hold at `peak` until t + hold, release in r seconds. */
  gate(p: AudioParam, t: number, a: number, peak: number, hold: number, r: number): void {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setValueAtTime(peak, t + Math.max(a, hold));
    p.linearRampToValueAtTime(0, t + Math.max(a, hold) + r);
  }
}
