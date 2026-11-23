// Trouble: the Harbor Patrol's sirens and helicopter, guns, things blowing up,
// cars on fire, and what the people on the sidewalk make of it all.
//
// The siren is the Patrol's own: a long climb, three yelps off the top, and a
// slide back down, 2.6 s round. Each cruiser's oscillator has the whole cycle
// scheduled ahead on its frequency, so the frame only moves its level, its pan
// and (through `detune`, which adds to the pattern) its Doppler shift.

import type { Vehicle } from '../core/api';
import type { Game } from '../core/game';
import type { WeaponId } from '../ent/weapons';
import type { AudioCore } from './audio';
import { hiss, ping, thud, type Rand } from './sfx';
import { Bed, type Rig } from './world';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Sirens ───────────────────────────────────────────────────────────────────

export const SIREN_CYCLE = 2.6;
const sirenWave = new WeakMap<AudioCore, PeriodicWave>();

/** One cycle of the Harbor Patrol pattern written onto a frequency parameter, starting at t. */
export function sirenCycle(p: AudioParam, t: number): void {
  p.setValueAtTime(470, t);
  p.exponentialRampToValueAtTime(1040, t + 1.1);
  p.setValueAtTime(1040, t + 1.25);
  for (let i = 0; i < 3; i++) {
    const a = t + 1.25 + i * 0.25;
    p.exponentialRampToValueAtTime(690, a + 0.21);
    p.exponentialRampToValueAtTime(1040, a + 0.25);
  }
  p.exponentialRampToValueAtTime(470, t + SIREN_CYCLE);
}

/** A siren: the horn on the roof and nothing else. Connect `out` wherever it should be heard. */
export class Siren {
  readonly out: GainNode;
  readonly osc: OscillatorNode;
  private until: number;
  constructor(private readonly core: AudioCore, t: number, phase = 0) {
    let w = sirenWave.get(core);
    if (!w) { const h = new Float32Array(14); for (let k = 1; k <= 14; k++) h[k - 1] = 1 / Math.pow(k, 0.75); sirenWave.set(core, (w = core.wave(h))); }
    this.osc = core.osc(w, 470);
    // A re-entrant horn: nothing below 400 Hz gets out of it, and it shouts around 1.5 kHz.
    const hp = core.filter('highpass', 420, 0.7), pk = core.filter('peaking', 1550, 1.1, 9), lp = core.filter('lowpass', 4200, 0.7);
    this.out = core.gain(0.36);
    this.osc.connect(hp); hp.connect(pk); pk.connect(lp); lp.connect(this.out);
    this.osc.start(t);
    // Start part-way round, so two cars never wail in step.
    this.until = t - phase * SIREN_CYCLE;
    this.ahead(t);
  }
  /** Keep the pattern written at least a second ahead. */
  ahead(t: number): void {
    while (this.until < t + 1) { sirenCycle(this.osc.frequency, Math.max(this.until, 0)); this.until += SIREN_CYCLE; }
  }
  stop(t: number): void {
    this.out.gain.setTargetAtTime(0, t, 0.05);
    this.osc.stop(t + 0.4);
  }
}

// ── Guns ─────────────────────────────────────────────────────────────────────

/** One shot: a crack, a body and a tail. The reverb the tail rings in comes from wherever `out` sends. */
export function gunshot(core: AudioCore, t: number, out: AudioNode, id: WeaponId, r: Rand): void {
  const k = 0.94 + r() * 0.12;
  if (id === 'pistol') {
    hiss(core, t, out, 'white', 'highpass', 2400, 0.5, 0.85, 0.0005, 0.022);
    thud(core, t, out, 250 * k, 85, 0.75, 0.09);
    hiss(core, t, out, 'pink', 'bandpass', 640 * k, 0.8, 0.9, 0.001, 0.07);
    const b = hiss(core, t + 0.01, out, 'white', 'lowpass', 3200, 0.5, 0.2, 0.01, 0.45);
    b.frequency.setValueAtTime(3200, t + 0.01); b.frequency.exponentialRampToValueAtTime(700, t + 0.45);
  } else if (id === 'smg') {
    hiss(core, t, out, 'white', 'highpass', 3000, 0.5, 0.6, 0.0005, 0.013);
    thud(core, t, out, 330 * k, 130, 0.45, 0.05);
    hiss(core, t, out, 'pink', 'bandpass', 1050 * k, 1, 0.7, 0.001, 0.04);
    hiss(core, t + 0.008, out, 'white', 'lowpass', 2600, 0.5, 0.12, 0.008, 0.22);
    // The bolt.
    hiss(core, t + 0.032, out, 'white', 'bandpass', 3800 * k, 6, 0.3, 0.0005, 0.012);
  } else if (id === 'shotgun') {
    hiss(core, t, out, 'white', 'highpass', 1800, 0.5, 0.9, 0.0005, 0.035);
    thud(core, t, out, 150 * k, 42, 1, 0.22);
    hiss(core, t, out, 'pink', 'lowpass', 900, 0.6, 1.1, 0.001, 0.16);
    const b = hiss(core, t + 0.01, out, 'white', 'lowpass', 2400, 0.5, 0.34, 0.015, 0.9);
    b.frequency.setValueAtTime(2400, t + 0.01); b.frequency.exponentialRampToValueAtTime(400, t + 0.8);
    // Pump: back, forward.
    hiss(core, t + 0.42, out, 'white', 'bandpass', 1400 * k, 3, 0.5, 0.004, 0.05);
    hiss(core, t + 0.57, out, 'white', 'bandpass', 2100 * k, 3, 0.55, 0.003, 0.04);
    thud(core, t + 0.57, out, 180, 90, 0.2, 0.05);
  } else if (id === 'launcher') {
    thud(core, t, out, 120, 38, 0.7, 0.28);
    hiss(core, t, out, 'pink', 'lowpass', 700, 0.6, 0.8, 0.002, 0.12);
    const b = hiss(core, t, out, 'white', 'bandpass', 500, 1.2, 0.55, 0.06, 0.9);
    b.frequency.setValueAtTime(500, t); b.frequency.exponentialRampToValueAtTime(2800, t + 0.55);
  } else {
    // A fist through the air.
    const b = hiss(core, t, out, 'white', 'bandpass', 700, 1.5, 0.25, 0.03, 0.09);
    b.frequency.setValueAtTime(600, t); b.frequency.exponentialRampToValueAtTime(1600, t + 0.1);
  }
}

/** What a bullet does when it does not hit anybody. 0 a wall (it sings), 1 a car (it rings), 2 the ground (it thumps). */
export function ricochet(core: AudioCore, t: number, out: AudioNode, kind: 0 | 1 | 2, r: Rand): void {
  if (kind === 0) {
    hiss(core, t, out, 'white', 'bandpass', 2600, 1.2, 0.7, 0.0005, 0.02);
    if (r() < 0.55) {
      const f = 2600 + r() * 2800, o = core.osc('sine', f), g = core.gain(0), wob = core.osc('sine', 28 + r() * 30), wg = core.gain(f * 0.03);
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (0.35 + r() * 0.25), t + 0.3);
      wob.connect(wg); wg.connect(o.frequency);
      core.env(g.gain, t, 0.003, 0.28, 0.28);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.35); wob.start(t); wob.stop(t + 0.35);
    }
  } else if (kind === 1) {
    hiss(core, t, out, 'white', 'bandpass', 1700 + r() * 600, 24, 2.2, 0.0005, 0.09);
    hiss(core, t, out, 'white', 'bandpass', 3900 + r() * 1500, 30, 1.4, 0.0005, 0.06);
    thud(core, t, out, 210, 110, 0.2, 0.04);
  } else {
    hiss(core, t, out, 'pink', 'lowpass', 1300, 0.6, 0.4, 0.001, 0.06);
    hiss(core, t + 0.02, out, 'white', 'bandpass', 3000, 0.8, 0.06, 0.01, 0.12);
  }
}

/** Something going up: the crack, the thump you feel, the roar, and bits coming down for a second and a half after. */
export function explosion(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  hiss(core, t, out, 'white', 'lowpass', 6000, 0.5, 1, 0.001, 0.07);
  thud(core, t, out, 72, 23, 1.1, 1.1);
  thud(core, t + 0.01, out, 140, 40, 0.6, 0.3);
  const b = hiss(core, t, out, 'brown', 'lowpass', 2000, 0.5, 1.5, 0.008, 1.7);
  b.frequency.setValueAtTime(2000, t); b.frequency.exponentialRampToValueAtTime(140, t + 1.3);
  hiss(core, t, out, 'pink', 'bandpass', 420, 0.6, 0.8, 0.004, 0.8);
  // Debris.
  for (let i = 0; i < 9; i++) {
    const at = t + 0.25 + r() * 1.3;
    hiss(core, at, out, 'white', 'bandpass', 700 + r() * 3600, 2 + r() * 10, 0.12 + r() * 0.2, 0.001, 0.03 + r() * 0.09);
  }
  for (let i = 0; i < 5; i++) ping(core, t + 0.3 + r() * 1.1, out, 1800 + r() * 5000, 0.02 + r() * 0.03, 0.05 + r() * 0.12);
}

// ── People ───────────────────────────────────────────────────────────────────

/** A sharp breath in. pitch: the voice's own, 140..320 Hz, which here only moves the mouth. */
export function gasp(core: AudioCore, t: number, out: AudioNode, pitch: number, r: Rand): void {
  const k = 0.8 + (pitch - 140) / 450 + r() * 0.1;
  const a = hiss(core, t, out, 'white', 'bandpass', 950 * k, 4, 0.9, 0.09, 0.2);
  a.frequency.setValueAtTime(900 * k, t); a.frequency.exponentialRampToValueAtTime(1750 * k, t + 0.2);
  const b = hiss(core, t, out, 'white', 'bandpass', 2700 * k, 5, 0.35, 0.09, 0.18);
  b.frequency.setValueAtTime(2500 * k, t); b.frequency.exponentialRampToValueAtTime(3300 * k, t + 0.2);
}

/** A voiced cry with no word in it: `up` true is a yelp, false the grunt of somebody hit. */
export function cry(core: AudioCore, t: number, out: AudioNode, pitch: number, up: boolean, r: Rand): void {
  const d = up ? 0.2 + r() * 0.08 : 0.13 + r() * 0.05, f = pitch * (up ? 1.5 : 0.95);
  const o = core.osc('sawtooth', f), g = core.gain(0), k = 0.85 + (pitch - 140) / 600;
  if (up) { o.frequency.setValueAtTime(f * 0.8, t); o.frequency.linearRampToValueAtTime(f * 1.5, t + d * 0.35); o.frequency.linearRampToValueAtTime(f * 1.05, t + d); }
  else { o.frequency.setValueAtTime(f * 1.15, t); o.frequency.exponentialRampToValueAtTime(f * 0.7, t + d); }
  // Two formants: an open "ah" for the yelp, a closed "uh" for the grunt.
  const f1 = core.filter('bandpass', (up ? 880 : 520) * k, 5), f2 = core.filter('bandpass', (up ? 1500 : 980) * k, 6), f3 = core.filter('bandpass', 2800 * k, 6);
  const g3 = core.gain(0.3);
  o.connect(f1); o.connect(f2); o.connect(f3); f1.connect(g); f2.connect(g); f3.connect(g3); g3.connect(g);
  core.gate(g.gain, t, 0.015, up ? 0.55 : 0.7, d * 0.6, d * 0.4);
  g.connect(out);
  o.start(t); o.stop(t + d + 0.05);
  hiss(core, t, out, 'white', 'bandpass', 1900 * k, 2, 0.1, 0.01, d);
}

/** Fresh Coat: the ball in the can, then the can. */
export function spray(core: AudioCore, t: number, out: AudioNode, r: Rand): void {
  for (let i = 0; i < 5; i++) hiss(core, t + i * 0.09 + r() * 0.02, out, 'white', 'bandpass', 2400 + r() * 500, 9, 1, 0.0005, 0.025);
  const s = core.burst('white', t + 0.6, 1.3), hp = core.filter('highpass', 4200, 0.7), g = core.gain(0);
  core.gate(g.gain, t + 0.6, 0.03, 0.22, 1.1, 0.08);
  s.connect(hp); hp.connect(g); g.connect(out);
}

/** A cruiser's radio keying up: squelch and two tones. Not speech. */
export function dispatch(core: AudioCore, t: number, out: AudioNode): void {
  hiss(core, t, out, 'white', 'bandpass', 1900, 1.2, 0.25, 0.004, 0.1);
  const bp = core.filter('bandpass', 1500, 1.5);
  bp.connect(out);
  for (const [f, at] of [[1320, 0.14], [1760, 0.24]] as const) {
    const o = core.osc('square', f), g = core.gain(0);
    core.gate(g.gain, t + at, 0.004, 0.12, 0.07, 0.01);
    o.connect(g); g.connect(bp); o.start(t + at); o.stop(t + at + 0.12);
  }
  hiss(core, t + 0.36, out, 'white', 'bandpass', 1900, 1.2, 0.2, 0.002, 0.05);
}

// ── Standing sounds ──────────────────────────────────────────────────────────

/** The Patrol's helicopter: blades, the gearbox, the turbine. */
export function heliBed(r: Rig): void {
  const blade = 19.5;
  const thump = r.noise('brown', 'lowpass', 190, 0.7, 0.7);
  r.lfo(blade, -0.6, thump.g.gain, 'sawtooth');
  const chop = r.noise('pink', 'bandpass', 850, 0.7, 0.2);
  r.lfo(blade, -0.18, chop.g.gain, 'sawtooth');
  r.tone('sawtooth', blade * 4, 0.08, 400);
  r.noise('white', 'bandpass', 3300, 3.5, 0.035);
  r.tone('sine', 2140, 0.008);
}

const sparks = new WeakMap<AudioCore, AudioBuffer>();
/** A car burning: the roar, the hiss, and crackle from a buffer of sparse clicks played at a rate nobody chose. */
export function fireBed(r: Rig): void {
  const c = r.core;
  let buf = sparks.get(c);
  if (!buf) {
    const n = Math.floor(c.rate * 3.7);
    buf = c.ctx.createBuffer(1, n, c.rate);
    const d = buf.getChannelData(0);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < n; i++) if (rnd() < 0.0009) { const a = (rnd() * 2 - 1) * (0.3 + 0.7 * rnd()), len = 20 + Math.floor(rnd() * 120); for (let k = 0; k < len && i + k < n; k++) d[i + k] += a * (rnd() * 2 - 1) * (1 - k / len); }
    sparks.set(c, buf);
  }
  const s = c.ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.playbackRate.value = 0.93;
  const bp = c.filter('bandpass', 2600, 0.5), g = c.gain(0.9);
  s.connect(bp); bp.connect(g); g.connect(r.out); s.start();
  r.src.push(s);
  const roar = r.noise('brown', 'lowpass', 420, 0.6, 0.6);
  r.lfo(0.9, 0.15, roar.g.gain); r.lfo(2.3, 0.1, roar.g.gain);
  const h = r.noise('pink', 'bandpass', 1500, 0.6, 0.1);
  r.lfo(1.7, 0.05, h.g.gain);
}

// ── The part the game runs ───────────────────────────────────────────────────

interface PoliceLike { units: { v: Vehicle; state: string }[]; heli: { x: number; y: number; z: number; present: boolean } }
interface SirenSlot { v: Vehicle; s: Siren; g: GainNode; pan: StereoPannerNode }
/** How hard each weapon is played: the recipes are written to one scale, and this is the balance between them. */
export const GUN_LEVEL: Record<WeaponId, number> = { fists: 1, pistol: 1.5, smg: 1.25, shotgun: 1, launcher: 1 };
const BURN_AT = 20;

export class TroubleSounds {
  private readonly police: PoliceLike | null;
  private readonly sirens: SirenSlot[] = [];
  private readonly maxSirens: number;
  private readonly heli: Bed;
  private readonly fire: Bed;
  private fireV: Vehicle | null = null;
  private scanT = 0;
  private sirensOn = false;
  private shots = 0; private wall = 0; private car = 0; private ground = 0;

  constructor(private readonly core: AudioCore, private readonly game: Game) {
    this.police = (game.systems.find((s) => (s as { tag?: string }).tag === 'police') as unknown as PoliceLike | undefined) ?? null;
    this.maxSirens = game.quality.name === 'low' ? 2 : 3;
    this.heli = new Bed(core, heliBed, core.bus.sfx, 0.9, 0.15);
    this.fire = new Bed(core, fireBed, core.bus.sfx, 0.8, 0.1);
    const r = Math.random, w = game.player.weapons, st = w.stats;
    this.shots = st.shots; this.wall = st.wall; this.car = st.car; this.ground = st.ground;

    game.on('siren', (e) => { this.sirensOn = e.on; this.scanT = 0; });
    game.on('shot', (e) => {
      // The same event carries her own gunfire and anything exploding. A shot of hers moved the weapon's counter; a blast did not.
      const mine = st.shots !== this.shots;
      this.shots = st.shots;
      if (mine) {
        const id = w.spec.id, auto = id === 'smg';
        if (!core.claim(auto ? 'smg' : 'gun', auto ? 4 : 3, auto ? 0.06 : 0.1)) return;
        const out = core.direct('sfx', GUN_LEVEL[id], 0.3);
        gunshot(core, core.now, out, id, r);
        this.alarm(e.x, e.z);
        return;
      }
      if (!core.claim('boom', 3, 0.4)) return;
      const sp = core.place(e.x, 1.5, e.z, { ref: 30, max: 1100, wet: 0.5 });
      if (sp) explosion(core, core.now + sp.lag, sp.in, r);
      this.alarm(e.x, e.z);
    });
    game.on('gunshot', (e) => {
      if (!core.claim('copgun', 3, 0.1)) return;
      const sp = core.place(e.x, 1.5, e.z, { ref: 14, max: 420, wet: 0.45 });
      // (An officer's sidearm, or whatever another player is firing.)
      const id: WeaponId = e.id === 'smg' || e.id === 'shotgun' || e.id === 'launcher' ? e.id : 'pistol';
      if (sp) { const g = core.gain(GUN_LEVEL[id]); g.connect(sp.in); gunshot(core, core.now + sp.lag, g, id, r); }
    });
    game.on('personHit', (e) => {
      if (!core.claim('cry', 2, 0.25)) return;
      const sp = core.place(e.x, 1.5, e.z, { ref: 6, max: 90, wet: 0.2 });
      if (!sp) return;
      const t = core.now + sp.lag + 0.03;
      thud(core, t, sp.in, 130, 60, 0.4, 0.07);
      cry(core, t + 0.02, sp.in, this.pitch(e.person.id), false, r);
    });
    game.on('pedHit', (e) => {
      if (!core.claim('cry', 2, 0.25)) return;
      const sp = core.place(e.x, 1.5, e.z, { ref: 6, max: 90, wet: 0.2 });
      if (sp) cry(core, core.now + sp.lag + 0.04, sp.in, 150 + r() * 160, e.speed > 9, r);
      this.alarm(e.x, e.z);
    });
    game.on('roadblock', () => { if (core.claim('dispatch', 1, 0.6)) dispatch(core, core.now + 0.05, core.direct('sfx', 0.5, 0.05)); });
    game.on('respray', () => { if (core.claim('spray', 1, 2)) spray(core, core.now + 0.05, core.direct('sfx', 0.6, 0.15), r); });
  }

  /** A voice for a person, the same every time for the same one. */
  private pitch(id: number): number { return 150 + ((id * 37) % 100) * 1.6; }

  /** Up to two people near a bang catch their breath or cry out. */
  private alarm(x: number, z: number): void {
    const c = this.core, list = this.game.people.list, me = this.game.player.person, r = Math.random;
    let n = 0;
    for (let i = 0; i < list.length && n < 2; i++) {
      const p = list[i];
      if (p === me || p.pose === 'down' || !p.visible) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > 28 || d < 0.5) continue;
      if (!c.claim('gasp', 2, 0.9)) return;
      const sp = c.place(p.x, p.y + 1.6, p.z, { ref: 5, max: 70, wet: 0.2 });
      if (!sp) continue;
      const t = c.now + 0.12 + r() * 0.35;
      if (r() < 0.6) gasp(c, t, sp.in, this.pitch(p.id), r); else cry(c, t, sp.in, this.pitch(p.id), true, r);
      n++;
    }
  }

  /** Give the siren voices to the nearest cruisers with their bars lit. */
  private assign(): void {
    const c = this.core, t = c.now, units = this.police && this.sirensOn ? this.police.units : null;
    for (let i = this.sirens.length - 1; i >= 0; i--) {
      const s = this.sirens[i];
      let live = false;
      if (units) for (const u of units) if (u.v === s.v && u.state !== 'leave') live = true;
      if (!live || c.gainAt(s.v.x, s.v.y, s.v.z, 14, 560) < 0.004) { s.s.stop(t); this.sirens.splice(i, 1); }
    }
    if (!units) return;
    for (const u of units) {
      if (u.state === 'leave' || this.sirens.length >= this.maxSirens) continue;
      let have = false;
      for (const s of this.sirens) if (s.v === u.v) have = true;
      if (have || c.gainAt(u.v.x, u.v.y, u.v.z, 14, 560) < 0.01) continue;
      const g = c.gain(0), pan = c.ctx.createStereoPanner(), send = c.gain(0.35);
      const s = new Siren(c, t, (u.v.id * 0.37) % 1);
      s.out.connect(g); g.connect(pan); pan.connect(c.bus.sfx); g.connect(send); send.connect(c.reverbFor('sfx'));
      this.sirens.push({ v: u.v, s, g, pan });
    }
  }

  update(dt: number): void {
    const c = this.core, g = this.game, t = c.now, r = Math.random;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25;
      this.assign();
      const h = this.police?.heli;
      this.heli.set(h && h.present ? c.gainAt(h.x, h.y, h.z, 55, 900) : 0, 0.25, h ? c.panAt(h.x, h.z) : 0);
      // The nearest car that is alight.
      let best: Vehicle | null = null, bg = 0.01;
      const list = g.vehicles.list;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.health >= BURN_AT || v.sunk || v.wreck) continue;
        const gv = c.gainAt(v.x, v.y, v.z, 7, 120);
        if (gv > bg) { bg = gv; best = v; }
      }
      this.fireV = best;
      this.fire.set(best ? bg : 0, 0.25, best ? c.panAt(best.x, best.z) : 0);
    }
    for (const s of this.sirens) {
      const v = s.v;
      s.s.ahead(t);
      s.s.osc.detune.setTargetAtTime(1200 * Math.log2(c.doppler(v.x, v.z, v.vx, v.vz)), t, 0.08);
      s.g.gain.setTargetAtTime(c.gainAt(v.x, v.y, v.z, 14, 560) * 0.55, t, 0.06);
      s.pan.pan.setTargetAtTime(c.panAt(v.x, v.z), t, 0.06);
    }
    // Where her bullets ended up: the weapon keeps count by what they hit.
    const st = g.player.weapons.stats;
    const kind = st.wall !== this.wall ? 0 : st.car !== this.car ? 1 : st.ground !== this.ground ? 2 : -1;
    this.wall = st.wall; this.car = st.car; this.ground = st.ground;
    if (kind >= 0 && r() < (kind === 1 ? 0.9 : 0.6) && c.claim('rico', 3, 0.08)) {
      const sp = c.place(st.lastX, st.lastY, st.lastZ, { ref: 7, max: 140, wet: 0.3 });
      if (sp) ricochet(c, t + sp.lag, sp.in, kind as 0 | 1 | 2, r);
    }
  }
}
