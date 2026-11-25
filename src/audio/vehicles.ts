// Everything a vehicle sounds like.
//
// The engine is not a recording pitched up and down: each kind has a wave
// built from the harmonics of its own firing order, played at the engine's
// cycle frequency (rpm / 120), with two slightly detuned copies for the beat
// between banks, a low-pass that opens with the throttle, intake noise that
// follows the firing pulses, and for the diesels an injector clatter. The rpm
// comes from a virtual gearbox: the physics has none, so this file keeps one
// (gear, shift pause, idle, limiter, free revving in the air) purely for the ear.
//
// The 2017 Bolt has no engine to synthesize: a motor whine that follows speed
// and torque, the low-speed pedestrian warning hum, and tyres doing the rest.

import { HORN_CHOICES } from '../game/looks';
import type { Vehicle } from '../core/api';
import type { Game } from '../core/game';
import { isBoatKind, type VehicleKind } from '../ent/vehicleSpecs';
import type { Remote } from '../net/remote';
import { mulberry, type AudioCore } from './audio';
import * as sfx from './sfx';

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface EngineSpec {
  /** Cylinders: the firing harmonic of the cycle. 0 = electric. */
  cyl: number;
  idle: number; redline: number;
  /** Share of the car's top speed reached at the redline in each gear. */
  gears: number[];
  /** Seconds off the throttle for a shift. */
  shift: number;
  /** Rolloff of the firing harmonics (lower = brighter), level of the half-firing orders, of the cycle's low orders, of everything else. */
  p: number; half: number; low: number; odd: number;
  /** Low-pass ceiling in Hz at full throttle and redline. */
  bright: number;
  /** Intake and exhaust noise, 0..1, and injector clatter, 0..1. */
  breath: number; clatter: number;
  /** Detune between the two copies of the wave: the lump. */
  beat: number;
  level: number;
}

const FIVE = [0.25, 0.42, 0.6, 0.8, 1], FOUR = [0.3, 0.5, 0.72, 1], SIX = [0.2, 0.33, 0.47, 0.62, 0.8, 1];
export const ENGINES: Record<VehicleKind, EngineSpec> = {
  // A buzzy three: the firing harmonics barely roll off, and the 1.5-order rocking thrum is loud.
  hatch: { cyl: 3, idle: 880, redline: 6300, gears: FIVE, shift: 0.26, p: 0.55, half: 0.1, low: 0.3, odd: 0.1, bright: 5200, breath: 0.35, clatter: 0, beat: 0.003, level: 0.8 },
  // Smooth fours: almost nothing but the firing order.
  sedan: { cyl: 4, idle: 760, redline: 6000, gears: FIVE, shift: 0.3, p: 1.05, half: 0.1, low: 0.04, odd: 0.02, bright: 3600, breath: 0.3, clatter: 0, beat: 0.0012, level: 0.8 },
  taxi: { cyl: 4, idle: 720, redline: 5600, gears: FOUR, shift: 0.34, p: 1.0, half: 0.16, low: 0.07, odd: 0.04, bright: 3300, breath: 0.4, clatter: 0.08, beat: 0.003, level: 0.8 },
  coupe: { cyl: 4, idle: 850, redline: 7000, gears: FIVE, shift: 0.2, p: 0.8, half: 0.14, low: 0.05, odd: 0.03, bright: 5000, breath: 0.45, clatter: 0, beat: 0.002, level: 0.85 },
  // A lumpy cross-plane V8: half and quarter orders nearly as loud as the firing, and a wide beat.
  muscle: { cyl: 8, idle: 680, redline: 5800, gears: FOUR, shift: 0.3, p: 0.95, half: 0.75, low: 0.4, odd: 0.16, bright: 4200, breath: 0.6, clatter: 0, beat: 0.011, level: 1 },
  // A flat six that screams: slow rolloff, a high redline, close ratios.
  sports: { cyl: 6, idle: 980, redline: 8600, gears: SIX, shift: 0.12, p: 0.5, half: 0.22, low: 0.03, odd: 0.02, bright: 9000, breath: 0.5, clatter: 0, beat: 0.0015, level: 0.95 },
  // Diesels: low redlines, half orders, and the clatter.
  pickup: { cyl: 6, idle: 700, redline: 4200, gears: FIVE, shift: 0.38, p: 1.0, half: 0.4, low: 0.2, odd: 0.1, bright: 2600, breath: 0.5, clatter: 0.5, beat: 0.005, level: 0.9 },
  van: { cyl: 4, idle: 800, redline: 4300, gears: FIVE, shift: 0.42, p: 0.9, half: 0.35, low: 0.18, odd: 0.1, bright: 2800, breath: 0.4, clatter: 0.7, beat: 0.004, level: 0.85 },
  tow: { cyl: 6, idle: 640, redline: 3200, gears: FIVE, shift: 0.5, p: 0.95, half: 0.5, low: 0.3, odd: 0.14, bright: 2200, breath: 0.6, clatter: 0.85, beat: 0.006, level: 1 },
  bus: { cyl: 6, idle: 580, redline: 2600, gears: FOUR, shift: 0.7, p: 1.0, half: 0.45, low: 0.35, odd: 0.12, bright: 1800, breath: 0.7, clatter: 0.6, beat: 0.005, level: 1 },
  // A hard V8: the same eight, tighter and brighter, less lope.
  cruiser: { cyl: 8, idle: 760, redline: 6400, gears: FIVE, shift: 0.18, p: 0.7, half: 0.4, low: 0.14, odd: 0.07, bright: 6000, breath: 0.6, clatter: 0, beat: 0.005, level: 1 },
  bolt: { cyl: 0, idle: 0, redline: 9000, gears: [1], shift: 0, p: 1, half: 0, low: 0, odd: 0, bright: 6000, breath: 0, clatter: 0, beat: 0, level: 0.5 },
  // The C-Max: a hybrid's quiet two-litre four behind plenty of lagging. Soft shifts, no clatter, never loud.
  cmax: { cyl: 4, idle: 760, redline: 4800, gears: FIVE, shift: 0.5, p: 0.9, half: 0.3, low: 0.14, odd: 0.07, bright: 2400, breath: 0.35, clatter: 0, beat: 0.003, level: 0.6 },
  // Boats (ent/boat.ts) have no gearbox: one gear, and the propeller slips (Boat.slip) so the revs run ahead of the hull
  // pulling away and race when it leaves the water. The runabout's outboard is a V6 with a wet, throaty exhaust; the
  // jet ski a buzzy, bright twin.
  speedboat: { cyl: 6, idle: 720, redline: 6000, gears: [1.08], shift: 0, p: 0.75, half: 0.45, low: 0.25, odd: 0.1, bright: 3200, breath: 0.7, clatter: 0, beat: 0.007, level: 1 },
  jetski: { cyl: 2, idle: 1300, redline: 7800, gears: [1.05], shift: 0, p: 0.45, half: 0.3, low: 0.35, odd: 0.15, bright: 6500, breath: 0.6, clatter: 0, beat: 0.004, level: 0.85 },
  // The rental cycles: the bicycle is silent (the tyres and the chain are the street's business); the scooter's motor is a faint whine.
  bike: { cyl: 2, idle: 1500, redline: 2400, gears: [1], shift: 0, p: 0.3, half: 0.1, low: 0.1, odd: 0.1, bright: 6000, breath: 0.2, clatter: 0, beat: 0.002, level: 0 },
  scooter: { cyl: 2, idle: 1700, redline: 4200, gears: [1], shift: 0, p: 0.3, half: 0.1, low: 0.1, odd: 0.2, bright: 6500, breath: 0.2, clatter: 0, beat: 0.002, level: 0.14 },
  train: { cyl: 16, idle: 330, redline: 900, gears: [1], shift: 0, p: 0.5, half: 0.4, low: 0.8, odd: 0.1, bright: 1200, breath: 0.2, clatter: 0, beat: 0.01, level: 0 },
};

const HARMONICS = 56;
const waves = new WeakMap<AudioCore, Map<string, PeriodicWave>>();
/** The wave of one engine cycle for a kind (cached per context). */
export function engineWave(core: AudioCore, kind: VehicleKind): PeriodicWave {
  let m = waves.get(core);
  if (!m) waves.set(core, (m = new Map()));
  let w = m.get(kind);
  if (w) return w;
  const e = ENGINES[kind], harm = new Float32Array(HARMONICS), ph = new Float32Array(HARMONICS), r = mulberry(kind.length * 977 + kind.charCodeAt(0) * 13 + kind.charCodeAt(1));
  if (e.cyl === 0) { harm[0] = 1; harm[1] = 0.12; harm[2] = 0.3; harm[5] = 0.08; }
  else {
    for (let k = 1; k <= HARMONICS; k++) {
      let a: number;
      if (k % e.cyl === 0) a = 1 / Math.pow(k / e.cyl, e.p);
      else if ((k * 2) % e.cyl === 0) a = e.half / Math.pow(Math.max(1, (k * 2) / e.cyl), 0.6);
      else if (k < e.cyl) a = e.low * (0.6 + 0.4 * r());
      else a = e.odd * (0.4 + 0.6 * r()) / Math.pow(k / e.cyl, 0.5);
      harm[k - 1] = a;
      // Scattered phases: the same spectrum with far less crest than a pulse train, so it can sit louder without poking the limiter.
      ph[k - 1] = r() * Math.PI * 2;
    }
  }
  w = core.wave(harm, ph);
  m.set(kind, w);
  return w;
}

/** What an engine voice needs to know about its car this frame. */
export interface DriveState { speed: number; top: number; accel: number; handbrake: boolean; onGround: boolean; slip: number }

/** The player's engine: the full model. One of these exists and is re-voiced when she changes cars. */
export class EngineVoice {
  rpm = 0;
  gear = 0;
  /** 0..1 how much fuel is going in after the gearbox and limiter have had their say (for the lab's log). */
  load = 0;
  kind: VehicleKind = 'sedan';
  private e: EngineSpec = ENGINES.sedan;
  private shiftT = 0;
  private on = false;
  private limitT = 0;
  private readonly a: OscillatorNode; private readonly b: OscillatorNode;
  private readonly ga: GainNode; private readonly gb: GainNode;
  private readonly lp: BiquadFilterNode; private readonly body: BiquadFilterNode;
  private readonly vca: GainNode;
  private readonly breathBp: BiquadFilterNode; private readonly breathG: GainNode; private readonly breathAm: GainNode;
  private readonly clatG: GainNode; private readonly clatAm: GainNode;

  constructor(private readonly core: AudioCore, out: AudioNode) {
    const c = core;
    this.a = c.osc('sine', 10); this.b = c.osc('sine', 10);
    this.ga = c.gain(0.5); this.gb = c.gain(0.5);
    this.lp = c.filter('lowpass', 800, 0.8);
    // The exhaust and the body it hangs from: a broad hump the harmonics pass through as the revs rise.
    this.body = c.filter('peaking', 220, 0.9, 6);
    this.vca = c.gain(0);
    this.a.connect(this.ga); this.b.connect(this.gb); this.ga.connect(this.lp); this.gb.connect(this.lp);
    this.lp.connect(this.body); this.body.connect(this.vca); this.vca.connect(out);
    // Intake and exhaust breath: pink noise in a band above the firing frequency, chopped by the wave itself.
    const n = c.noiseSrc('pink');
    this.breathBp = c.filter('bandpass', 400, 0.8);
    this.breathG = c.gain(0); this.breathAm = c.gain(0);
    n.connect(this.breathBp); this.breathBp.connect(this.breathG); this.breathG.connect(this.vca);
    this.a.connect(this.breathAm); this.breathAm.connect(this.breathG.gain);
    // Diesel clatter: a bright band of white noise that only exists on the pulses.
    const w = c.noiseSrc('white'), cb = c.filter('bandpass', 2900, 1.4);
    this.clatG = c.gain(0); this.clatAm = c.gain(0);
    w.connect(cb); cb.connect(this.clatG); this.clatG.connect(this.vca);
    this.a.connect(this.clatAm); this.clatAm.connect(this.clatG.gain);
    this.a.start(); this.b.start();
  }

  setKind(kind: VehicleKind): void {
    this.kind = kind; this.e = ENGINES[kind];
    const w = engineWave(this.core, kind);
    this.a.setPeriodicWave(w); this.b.setPeriodicWave(w);
    this.gear = 0; this.shiftT = 0;
  }

  /** Turn the key. The revs start low and climb to idle, which is the catch after the starter. */
  start(): void { this.on = true; this.rpm = this.e.cyl ? this.e.idle * 0.35 : 0; this.gear = 0; }
  stop(): void { this.on = false; }

  update(s: DriveState, dt: number): void {
    const e = this.e, t = this.core.now, tc = 0.03;
    if (!this.on) {
      this.rpm += (0 - this.rpm) * Math.min(1, dt * 5); this.load = 0;
      this.vca.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    const spd = Math.abs(s.speed), fwd = s.speed > -0.5;
    let thr = clamp01(fwd ? s.accel : -s.accel);
    // Standing on the brake and the throttle direction at once is just braking.
    if ((fwd && s.accel < 0) || (!fwd && s.accel > 0)) thr = 0;

    if (e.cyl === 0) {
      // Electric: pitch is road speed and nothing else; loudness is torque, in either direction (regen whines too).
      const regen = thr === 0 && spd > 2 ? 0.45 : 0, tq = Math.max(thr, regen, Math.abs(s.accel) > 0.1 && spd < 1 ? 0.3 : 0);
      this.rpm = spd / s.top * e.redline; this.load = tq;
      const whine = 170 + spd * 58;
      this.a.frequency.setTargetAtTime(whine, t, tc);
      this.ga.gain.setTargetAtTime(0.5, t, tc);
      // The pedestrian warning: a soft two-note hum below about 20 mph that rises a little with speed and is gone by 9 m/s.
      const avas = clamp01(1 - spd / 9) * (spd > 0.15 || tq > 0 ? 1 : 0.45);
      this.b.frequency.setTargetAtTime(146 * (1 + spd * 0.045), t, tc);
      this.gb.gain.setTargetAtTime(1.6 * avas, t, 0.1);
      this.lp.frequency.setTargetAtTime(2200 + spd * 120, t, tc);
      this.body.gain.setTargetAtTime(0, t, tc);
      this.breathG.gain.setTargetAtTime(0, t, tc); this.breathAm.gain.setTargetAtTime(0, t, tc);
      this.clatG.gain.setTargetAtTime(0, t, tc); this.clatAm.gain.setTargetAtTime(0, t, tc);
      this.vca.gain.setTargetAtTime(e.level * (0.1 + 0.2 * tq * (0.4 + 0.6 * clamp01(spd / 20)) + 0.1 * avas), t, 0.05);
      return;
    }

    // ── The gearbox ──
    const n = e.gears.length;
    const frac = (g: number): number => spd / (s.top * e.gears[g]);
    this.shiftT -= dt;
    if (this.shiftT <= 0 && s.onGround && fwd) {
      // Shift late when her foot is down, early when it is not.
      if (this.gear < n - 1 && frac(this.gear) > 0.56 + 0.4 * thr) { this.gear++; this.shiftT = e.shift; }
      else if (this.gear > 0 && frac(this.gear - 1) < 0.42 + 0.3 * thr) { this.gear--; this.shiftT = e.shift * 0.55; }
    }
    if (!fwd) this.gear = 0;
    const shifting = this.shiftT > 0;
    let rf = clamp01(frac(this.gear));
    // Pulling away, the clutch slips: the revs sit above what the road speed would give.
    if (this.gear === 0 && thr > 0) rf = Math.max(rf, (0.22 + 0.2 * thr) * thr);
    // Wheels spinning or off the ground, or held on the handbrake: the engine is free to run to the limiter.
    const free = !s.onGround || (s.slip > 0.45 && thr > 0.4 && this.gear <= 1) || (s.handbrake && spd < 3);
    if (free) rf = Math.max(rf, rf + (1.02 - rf) * thr);
    const target = e.idle + (e.redline - e.idle) * clamp01(rf);
    const rise = target > this.rpm;
    this.rpm += (target - this.rpm) * Math.min(1, dt * (shifting ? 7 : rise ? (free ? 6 : 10) : 4.5));

    // The limiter: at the redline with the throttle open, fuel is cut a dozen times a second.
    let cut = false;
    if (this.rpm > e.redline * 0.985 && thr > 0.3) { this.limitT += dt * 13; cut = this.limitT % 1 < 0.5; } else this.limitT = 0;
    const load = shifting || cut ? 0 : thr;
    this.load = load;
    const rn = clamp01((this.rpm - e.idle) / (e.redline - e.idle));
    // Engine braking: closed throttle at speed is quieter and darker, but not silent.
    const over = load === 0 && rn > 0.15 ? 1 : 0;

    const f0 = Math.max(2, this.rpm / 120);
    this.a.frequency.setTargetAtTime(f0, t, tc);
    this.b.frequency.setTargetAtTime(f0 * (1 + e.beat), t, tc);
    this.ga.gain.setTargetAtTime(0.5, t, tc); this.gb.gain.setTargetAtTime(0.5, t, tc);
    const fire = f0 * e.cyl;
    this.lp.frequency.setTargetAtTime(Math.min(e.bright, 260 + fire * 2.2 + e.bright * (0.1 + 0.9 * load) * (0.25 + 0.75 * rn)), t, cut ? 0.008 : tc);
    this.body.frequency.setTargetAtTime(160 + 180 * rn, t, tc);
    this.body.gain.setTargetAtTime(6, t, tc);
    this.breathBp.frequency.setTargetAtTime(clamp(fire * 3.2, 250, 3200), t, tc);
    const br = e.breath * (0.12 + 0.88 * load) * (0.3 + 0.7 * rn) * 0.9;
    this.breathG.gain.setTargetAtTime(br, t, tc); this.breathAm.gain.setTargetAtTime(br * 0.8, t, tc);
    const cl = e.clatter * (0.5 + 0.5 * load) * (1 - 0.5 * rn) * 0.28;
    this.clatG.gain.setTargetAtTime(cl, t, tc); this.clatAm.gain.setTargetAtTime(cl, t, tc);
    const lvl = e.level * (0.3 + 0.3 * rn + 0.4 * load * (0.5 + 0.5 * rn) - 0.1 * over) * 0.62;
    this.vca.gain.setTargetAtTime(lvl, t, cut ? 0.006 : shifting ? 0.02 : 0.04);
  }
}

/** The rpm a car of this kind would be doing at this speed, with no gearbox state to keep: for the cars she is not in. */
function rpmAt(e: EngineSpec, speed: number, top: number): number {
  if (e.cyl === 0) return 0;
  const spd = Math.abs(speed);
  for (let g = 0; g < e.gears.length; g++) {
    const f = spd / (top * e.gears[g]);
    if (f < 0.72 || g === e.gears.length - 1) return e.idle + (e.redline - e.idle) * clamp01(Math.max(f, g === 0 ? 0.06 : 0));
  }
  return e.idle;
}

/** A cheap engine for somebody else's car: one wave, one filter, placed in the world, with a little Doppler. */
class FarEngine {
  v: Vehicle | null = null;
  private readonly o: OscillatorNode; private readonly lp: BiquadFilterNode; private readonly g: GainNode; private readonly pan: StereoPannerNode;
  private kind: VehicleKind | null = null;
  constructor(private readonly core: AudioCore) {
    this.o = core.osc('sine', 20); this.lp = core.filter('lowpass', 900, 0.7); this.g = core.gain(0);
    this.pan = core.ctx.createStereoPanner();
    this.o.connect(this.lp); this.lp.connect(this.g); this.g.connect(this.pan); this.pan.connect(core.bus.engine);
    this.o.start();
  }
  assign(v: Vehicle | null): void {
    this.v = v;
    if (v && v.spec.kind !== this.kind) { this.kind = v.spec.kind; this.o.setPeriodicWave(engineWave(this.core, this.kind)); }
  }
  update(): void {
    const c = this.core, t = c.now, v = this.v;
    if (!v || !v.driver || v.sunk || v.wreck) { this.g.gain.setTargetAtTime(0, t, 0.1); if (v && !v.driver) this.v = null; return; }
    const e = ENGINES[v.spec.kind], spd = Math.abs(v.speed);
    const dop = c.doppler(v.x, v.z, v.vx, v.vz);
    const thr = clamp01(Math.abs(v.ctl.accel));
    if (e.cyl === 0) {
      this.o.frequency.setTargetAtTime((170 + spd * 58) * dop, t, 0.05);
      this.lp.frequency.setTargetAtTime(4000, t, 0.1);
      this.g.gain.setTargetAtTime(c.gainAt(v.x, v.y, v.z, 5, 70) * 0.1, t, 0.08);
    } else {
      const rpm = rpmAt(e, v.speed, v.spec.topSpeed), rn = (rpm - e.idle) / (e.redline - e.idle);
      this.o.frequency.setTargetAtTime((rpm / 120) * dop, t, 0.08);
      this.lp.frequency.setTargetAtTime(300 + e.bright * (0.15 + 0.5 * thr) * (0.3 + 0.7 * rn), t, 0.1);
      this.g.gain.setTargetAtTime(c.gainAt(v.x, v.y, v.z, 6, 90) * e.level * (0.22 + 0.25 * rn + 0.2 * thr), t, 0.08);
    }
    this.pan.pan.setTargetAtTime(c.panAt(v.x, v.z), t, 0.08);
  }
}

/** Tyres, road and wind for the car she is in. Three noise sources that never stop; only their gains and filters move. */
export class Rolling {
  private readonly sq1: BiquadFilterNode; private readonly sq2: BiquadFilterNode; private readonly sqG: GainNode; private readonly sqTone: OscillatorNode; private readonly sqToneG: GainNode;
  private readonly roadLp: BiquadFilterNode; private readonly roadG: GainNode; private readonly hissG: GainNode;
  private readonly windBp: BiquadFilterNode; private readonly windG: GainNode;
  private wob = 0;
  constructor(private readonly core: AudioCore, out: AudioNode) {
    const c = core;
    // Squeal: two narrow bands a fifth and a bit apart over a wavering tone. Rubber sings at a pitch, it does not hiss.
    const w = c.noiseSrc('white');
    this.sq1 = c.filter('bandpass', 1000, 16); this.sq2 = c.filter('bandpass', 1550, 12);
    this.sqG = c.gain(0);
    w.connect(this.sq1); w.connect(this.sq2); this.sq1.connect(this.sqG); this.sq2.connect(this.sqG);
    this.sqTone = c.osc('sawtooth', 1000); this.sqToneG = c.gain(0.035);
    const toneLp = c.filter('lowpass', 3800, 0.7);
    this.sqTone.connect(toneLp); toneLp.connect(this.sqToneG); this.sqToneG.connect(this.sqG);
    this.sqTone.start();
    this.sqG.connect(out);
    // Road roar under everything, and the hiss of tread over it (louder in the wet).
    const b = c.noiseSrc('brown');
    this.roadLp = c.filter('lowpass', 150, 0.6); this.roadG = c.gain(0);
    b.connect(this.roadLp); this.roadLp.connect(this.roadG); this.roadG.connect(out);
    const p = c.noiseSrc('pink'), hb = c.filter('bandpass', 1100, 0.5);
    this.hissG = c.gain(0);
    p.connect(hb); hb.connect(this.hissG); this.hissG.connect(out);
    // Wind: only above town speeds.
    const w2 = c.noiseSrc('white');
    this.windBp = c.filter('bandpass', 600, 0.7); this.windG = c.gain(0);
    w2.connect(this.windBp); this.windBp.connect(this.windG); this.windG.connect(out);
  }
  /** on: she is in a car. wet 0..1. */
  update(on: boolean, speed: number, slip: number, onGround: boolean, wet: number, dt: number): void {
    const t = this.core.now, spd = Math.abs(speed), g = on && onGround ? 1 : 0;
    const k = clamp01((slip - 0.28) / 0.5);
    const sq = on && onGround ? k * k * (3 - 2 * k) * clamp01(spd / 5) * (1 - 0.65 * wet) : 0;
    this.wob += dt * (5 + slip * 9);
    const f = 880 + spd * 9 + Math.sin(this.wob) * 45 + Math.sin(this.wob * 2.7) * 25 + slip * 160;
    this.sq1.frequency.setTargetAtTime(f, t, 0.03); this.sq2.frequency.setTargetAtTime(f * 1.53, t, 0.03);
    this.sqTone.frequency.setTargetAtTime(f, t, 0.03);
    this.sqG.gain.setTargetAtTime(sq * 1.5, t, 0.05);
    this.roadLp.frequency.setTargetAtTime(110 + spd * 16, t, 0.1);
    this.roadG.gain.setTargetAtTime(g * clamp01(spd / 45) * 0.9, t, 0.1);
    this.hissG.gain.setTargetAtTime(g * clamp01(spd / 40) * (0.16 + 0.5 * wet) + sq * 0.2 * wet, t, 0.1);
    const wv = clamp01((spd - 12) / 45);
    this.windBp.frequency.setTargetAtTime(450 + spd * 22, t, 0.2);
    this.windG.gain.setTargetAtTime(on ? wv * wv * 0.5 : 0, t, 0.15);
  }
}

// ── Horns ────────────────────────────────────────────────────────────────────

interface HornSpec { f: number[]; attack: number; bright: number; level: number }
export const HORNS: Record<VehicleKind, HornSpec> = {
  sedan: { f: [420, 525], attack: 0.012, bright: 2600, level: 0.85 },
  hatch: { f: [612], attack: 0.008, bright: 3400, level: 0.71 },
  coupe: { f: [440, 554], attack: 0.01, bright: 3000, level: 0.85 },
  muscle: { f: [349, 440], attack: 0.014, bright: 2200, level: 0.94 },
  sports: { f: [494, 622], attack: 0.008, bright: 3400, level: 0.85 },
  pickup: { f: [370, 466], attack: 0.014, bright: 2300, level: 0.94 },
  van: { f: [392, 494], attack: 0.014, bright: 2400, level: 0.85 },
  taxi: { f: [466, 587], attack: 0.01, bright: 2900, level: 0.85 },
  // Air horns: lower, slower to speak, and a tritone-ish interval nobody would choose for a car.
  tow: { f: [277, 349], attack: 0.05, bright: 1700, level: 1.02 },
  bus: { f: [185, 233, 277], attack: 0.08, bright: 1400, level: 1.02 },
  cruiser: { f: [440, 587], attack: 0.006, bright: 3600, level: 0.94 },
  // The Bolt's is polite.
  bolt: { f: [415, 523], attack: 0.016, bright: 2000, level: 0.71 },
  cmax: { f: [400, 500], attack: 0.012, bright: 2500, level: 0.8 },
  // A boat's horn is a low single blast; the jet ski's a toy beeper.
  speedboat: { f: [233, 294], attack: 0.06, bright: 1500, level: 0.95 },
  jetski: { f: [740], attack: 0.006, bright: 3800, level: 0.6 },
  // A handlebar bell: two bright rings.
  bike: { f: [2870, 3640], attack: 0.003, bright: 7000, level: 0.5 },
  scooter: { f: [1980, 2640], attack: 0.003, bright: 6500, level: 0.5 },
  train: { f: [311, 370, 440, 554, 622], attack: 0.03, bright: 2400, level: 0.6 },
};

/** A horn that sounds until it is released. Built when the button goes down, torn down when it comes up. */
export class HornVoice {
  private readonly g: GainNode;
  private readonly oscs: OscillatorNode[] = [];
  private readonly level: number;
  constructor(private readonly core: AudioCore, kind: VehicleKind, out: AudioNode, t: number, pitch = 1) {
    const h = HORNS[kind];
    this.level = h.level;
    this.g = core.gain(0);
    this.g.gain.setValueAtTime(0, t);
    this.g.gain.linearRampToValueAtTime(h.level, t + h.attack);
    this.g.connect(out);
    for (let i = 0; i < h.f.length; i++) {
      const f = h.f[i] * pitch, harm = new Float32Array(Math.min(24, Math.floor(9000 / f)));
      // A reed against a diaphragm: strong harmonics with a formant where the trumpet rings.
      for (let k = 1; k <= harm.length; k++) harm[k - 1] = (1 / Math.pow(k, 0.55)) * (1 + 2.2 * Math.exp(-Math.pow((k * f - h.bright) / (h.bright * 0.35), 2)));
      const o = core.osc(core.wave(harm), f), og = core.gain(1 / h.f.length);
      o.connect(og); og.connect(this.g);
      o.start(t);
      this.oscs.push(o);
    }
  }
  release(t: number): void {
    this.g.gain.cancelScheduledValues(t);
    this.g.gain.setValueAtTime(this.level, t);
    this.g.gain.linearRampToValueAtTime(0, t + 0.05);
    for (const o of this.oscs) o.stop(t + 0.08);
  }
}

// ── The part the game runs ───────────────────────────────────────────────────

const FAR = 3;

export class VehicleSounds {
  readonly engine: EngineVoice;
  private readonly rolling: Rolling;
  private readonly far: FarEngine[] = [];
  private readonly own: AudioNode;
  private horn: HornVoice | null = null;
  private readonly aiHorns: { v: Vehicle; voice: HornVoice; g: GainNode; pan: StereoPannerNode }[] = [];
  /** Other players' horns (src/net/): the same voice as an AI car's, at the ghost's place. */
  private readonly netHorns: { r: Remote; voice: HornVoice; g: GainNode; pan: StereoPannerNode }[] = [];
  private readonly beep: GainNode;
  private nextBeep = 0;
  private scanT = 0;
  private wasAir = 0;
  private readonly st: DriveState = { speed: 0, top: 40, accel: 0, handbrake: false, onGround: true, slip: 0 };

  constructor(private readonly core: AudioCore, private readonly game: Game) {
    this.own = core.direct('engine', 1, 0.06);
    this.engine = new EngineVoice(core, this.own);
    this.rolling = new Rolling(core, core.direct('engine', 0.8));
    const nFar = game.quality.name === 'low' ? 2 : FAR;
    for (let i = 0; i < nFar; i++) this.far.push(new FarEngine(core));
    // The reverse beeper on the tow truck and the bus: one oscillator, gated ahead of time.
    const bo = core.osc('square', 1245), bl = core.filter('bandpass', 1245, 3);
    this.beep = core.gain(0);
    bo.connect(bl); bl.connect(this.beep); this.beep.connect(core.direct('sfx', 0.16, 0.2));
    bo.start();

    const r = Math.random;
    game.on('enter', (e) => {
      const kind = e.vehicle.spec.kind, heavy = clamp01((e.vehicle.spec.mass - 1000) / 5000);
      const t = core.now;
      this.engine.setKind(kind);
      if (!core.claim('door', 2, 0.2)) return;
      const out = core.direct('sfx', 0.8, 0.1);
      sfx.door(core, t + 0.02, out, heavy, true, r);
      if (ENGINES[kind].cyl) sfx.starter(core, t + 0.18, out, heavy, r); else sfx.evReady(core, t + 0.25, out);
      this.startAt = t + (ENGINES[kind].cyl ? 0.5 + 0.2 * heavy : 0.2);
    });
    game.on('exit', (e) => {
      this.engine.stop(); this.startAt = 0;
      this.horn?.release(core.now); this.horn = null;
      if (!core.claim('door', 2, 0.2)) return;
      const out = core.direct('sfx', 0.8, 0.1), heavy = clamp01((e.vehicle.spec.mass - 1000) / 5000);
      sfx.door(core, core.now + 0.02, out, heavy, false, r);
      sfx.door(core, core.now + 0.55, out, heavy, true, r);
    });
    game.on('impact', (e) => {
      if (e.speed < 1.5) return;
      const mine = e.vehicle === game.player.vehicle || e.other === game.player.vehicle;
      if (!core.claim('impact', mine ? 5 : 3, 0.12)) return;
      const sp = core.place(e.x, e.vehicle.y + 0.6, e.z, { ref: 9, max: 260, wet: 0.3 });
      if (!sp) return;
      const heavy = clamp01((Math.max(e.vehicle.spec.mass, e.other?.spec.mass ?? 0) - 1000) / 5000);
      sfx.impact(core, core.now + sp.lag, sp.in, e.speed, heavy, r);
    });
    game.on('pedHit', (e) => {
      if (!core.claim('body', 2, 0.15)) return;
      const sp = core.place(e.x, 1, e.z, { ref: 8, max: 120, wet: 0.2 });
      if (sp) sfx.bodyHit(core, core.now + sp.lag, sp.in, e.speed, r);
    });
    game.on('splash', (e) => {
      if (!core.claim('splash', 3, 0.3)) return;
      const sp = core.place(e.x, 0, e.z, { ref: 9, max: 200, wet: 0.5 });
      if (!sp) return;
      const t = core.now + sp.lag;
      sfx.splash(core, t, sp.in, e.big, r);
      // A big splash with a car in the middle of it is a car going down.
      if (e.big && game.vehicles.nearest(e.x, e.z, 4)) sfx.gurgle(core, t + 0.5, sp.in, r);
    });
  }
  private startAt = 0;

  update(dt: number): void {
    const core = this.core, g = this.game, t = core.now, v = g.player.vehicle, st = this.st;
    // ── Her own car ──
    if (v) {
      if (this.startAt && t >= this.startAt) { this.startAt = 0; this.engine.start(); }
      st.speed = v.speed; st.top = v.spec.topSpeed; st.accel = v.ctl.accel; st.handbrake = v.ctl.handbrake; st.onGround = v.onGround; st.slip = v.slip;
      if (v.sunk) this.engine.stop();
      // Landing: only a flight worth the name makes a noise.
      if (v.onGround && this.wasAir > 0.3 && core.claim('land', 2, 0.2)) sfx.landing(core, t, core.direct('sfx', 0.9, 0.1), clamp01(this.wasAir / 1.6), clamp01((v.spec.mass - 1000) / 5000), Math.random);
      this.wasAir = v.onGround ? 0 : v.airTime;
      if (v.ctl.horn && !this.horn) this.horn = new HornVoice(core, v.hornKind ?? v.spec.kind, core.direct('sfx', 0.75, 0.25), t);
      else if (!v.ctl.horn && this.horn) { this.horn.release(t); this.horn = null; }
      // Reversing in something long: beep, beep.
      const k = v.spec.kind;
      if ((k === 'tow' || k === 'bus') && v.speed < -0.4 && v.ctl.accel < 0) {
        if (this.nextBeep < t) this.nextBeep = t + 0.02;
        if (this.nextBeep < t + 0.15) { core.gate(this.beep.gain, this.nextBeep, 0.004, 1, 0.3, 0.01); this.nextBeep += 0.66; }
      }
    } else { this.wasAir = 0; if (this.horn) { this.horn.release(t); this.horn = null; } }
    this.engine.update(st, dt);
    // A boat has no tyres: its hull hiss is the wet-road hiss at full wet, with no squeal.
    const boat = !!v && isBoatKind(v.spec.kind);
    this.rolling.update(!!v && !v.sunk, v ? v.speed : 0, v && !boat ? v.slip : 0, v ? v.onGround : true, boat ? 1 : g.sky.wet, dt);

    // ── Everybody else's ──
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.25; this.assign(v); }
    for (const f of this.far) f.update();
    // AI horns: a short scan for anyone leaning on theirs within earshot.
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.ctl.horn || c === v || c.driver !== 'ai' || this.aiHorns.length >= 2) continue;
      let have = false;
      for (const h of this.aiHorns) if (h.v === c) have = true;
      if (have || core.gainAt(c.x, c.y, c.z, 8, 110) < 0.02) continue;
      const gn = core.gain(0), pan = core.ctx.createStereoPanner();
      gn.connect(pan); pan.connect(core.bus.sfx);
      const send = core.gain(0.3); gn.connect(send); send.connect(core.reverbFor('sfx'));
      this.aiHorns.push({ v: c, voice: new HornVoice(core, c.spec.kind, gn, t, core.doppler(c.x, c.z, c.vx, c.vz)), g: gn, pan });
    }
    for (let i = this.aiHorns.length - 1; i >= 0; i--) {
      const h = this.aiHorns[i], c = h.v;
      h.g.gain.setTargetAtTime(core.gainAt(c.x, c.y, c.z, 8, 110) * 0.8, t, 0.05);
      h.pan.pan.setTargetAtTime(core.panAt(c.x, c.z), t, 0.05);
      if (!c.ctl.horn || c.driver !== 'ai') { h.voice.release(t); this.aiHorns.splice(i, 1); }
    }
    this.remoteHorns(t);
  }

  /**
   * A short tune on a horn (game/emotes.ts): every note is this horn's own voice, pitched by `semi` semitones, from `at`
   * seconds for `dur` seconds. where: the car it comes from (null = her own, heard close). False when it is not heard.
   */
  tune(kind: VehicleKind, notes: readonly (readonly [number, number, number])[], where: { x: number; y: number; z: number } | null): boolean {
    const core = this.core;
    let out: AudioNode, t = core.now + 0.03;
    if (where) {
      const sp = core.place(where.x, where.y + 0.8, where.z, { ref: 8, max: 140, wet: 0.3 });
      if (!sp) return false;
      out = sp.in; t += sp.lag;
    } else out = core.direct('sfx', 0.75, 0.25);
    for (const [at, dur, semi] of notes) {
      const v = new HornVoice(core, kind, out, t + at, Math.pow(2, semi / 12));
      v.release(t + at + dur);
    }
    return true;
  }

  /** Somebody else's horn, from the flag in their state frames. Heard with the same falloff as an AI car's. */
  private remoteHorns(t: number): void {
    const core = this.core, g = this.game, hs = this.netHorns;
    for (const r of g.net.peers) {
      if (!r.horn || !r.kind || hs.length >= 2) continue;
      let have = false;
      for (const h of hs) if (h.r === r) have = true;
      if (have || core.gainAt(r.x, r.y, r.z, 8, 110) < 0.02) continue;
      const gn = core.gain(0), pan = core.ctx.createStereoPanner();
      gn.connect(pan); pan.connect(core.bus.sfx);
      const send = core.gain(0.3); gn.connect(send); send.connect(core.reverbFor('sfx'));
      hs.push({ r, voice: new HornVoice(core, r.look && r.look.horn ? HORN_CHOICES[r.look.horn] ?? r.kind : r.kind, gn, t, core.doppler(r.x, r.z, r.vx, r.vz)), g: gn, pan });
    }
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i], r = h.r;
      h.g.gain.setTargetAtTime(core.gainAt(r.x, r.y, r.z, 8, 110) * 0.8, t, 0.05);
      h.pan.pan.setTargetAtTime(core.panAt(r.x, r.z), t, 0.05);
      if (!r.horn || !r.seen) { h.voice.release(t); hs.splice(i, 1); }
    }
  }

  /** Give the few far-engine voices to the nearest driven cars, keeping a voice on the car it already has where it can. */
  private assign(mine: Vehicle | null): void {
    const core = this.core, list = this.game.vehicles.list, far = this.far;
    for (const f of far) if (f.v && (!f.v.driver || f.v === mine || core.gainAt(f.v.x, f.v.y, f.v.z, 6, 90) < 0.03)) f.assign(null);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c === mine || !c.driver || c.sunk) continue;
      const gc = core.gainAt(c.x, c.y, c.z, 6, 90);
      if (gc < 0.05) continue;
      let have = false, free: FarEngine | null = null, worst: FarEngine | null = null, wg = gc;
      for (const f of far) {
        if (f.v === c) have = true;
        else if (!f.v) free = f;
        else { const fg = core.gainAt(f.v.x, f.v.y, f.v.z, 6, 90); if (fg < wg * 0.7) { wg = fg; worst = f; } }
      }
      if (have) continue;
      (free ?? worst)?.assign(c);
    }
  }
}
