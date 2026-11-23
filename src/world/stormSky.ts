// Rare weather (fun queue item 8), the shared parts: the clock both events are scheduled from, and the storm's sky.
//
// THE CLOCK. Both the tornado (world/tornado.ts) and the flood (world/flood.ts) are pure functions of absolute game
// time: hours since 1970 on the game clock. Sky.hour only says the hour of the day, so the day is recovered from the
// real clock: the game runs one game hour to the real minute (Sky.rate 1/60), so `Date.now() / 60000` and the
// absolute game hour move together and differ by a constant. The absolute hour is taken as the value with the same
// hour of day nearest to `Date.now() / 60000`. In a shared town every browser has the same hour (net/town.ts) and,
// give or take a few seconds of clock skew, the same Date.now(), so every browser lands on the same day and sees the
// same event at the same moment without a byte on the wire. Alone it is simply a clock that never repeats.
//
// THE SKY. The Sky class has no tint control and is not ours to edit, so its update() is wrapped once (as moose.ts
// wraps the traffic update) and afterwards the storm's look is laid on top of whatever the weather made: a dark
// green-grey dome and fog, weaker sun, more fog, and rain in the air even if the town's weather is dry. Each event
// asks for an amount with set(); the strongest ask wins. With nothing asked the wrapper is one comparison.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { clamp01, lerp } from '../core/util';

/** A number in [0, 1) from two integers, the same in every browser. */
export function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Real ms to one game hour at the game's own rate. */
const HOUR_MS = 60000;

/** Absolute game hours (since 1970) for the sky's hour of day. See the header. */
export function absHours(hour: number, now = Date.now()): number {
  const t = now / HOUR_MS;
  return hour + 24 * Math.round((t - hour) / 24);
}

/** What one event asks of the sky, 0..1 each. */
export interface StormAsk {
  /** The green-black supercell look. */
  green: number;
  /** Plain dark rain cloud. */
  dark: number;
  /** Rain in the air. */
  rain: number;
}

type SkyGuts = {
  update(dt: number): void;
  uniforms: Record<string, THREE.IUniform>;
  rainU: Record<string, THREE.IUniform>;
  rain: THREE.Mesh;
  rainOff: THREE.Vector3;
  fog: THREE.FogExp2;
  horBase: THREE.Color; horGlow: THREE.Color; fogFlat: THREE.Color;
  sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight;
  glowAmt: number;
};

const GREEN_ZEN = new THREE.Color(0x1d2a22), GREEN_MID = new THREE.Color(0x3a5243), GREEN_HOR = new THREE.Color(0x5d7a5c);
const GREEN_CLOUD = new THREE.Color(0x26342b), GREEN_LIT = new THREE.Color(0x6f8a6a);
const DARK_ZEN = new THREE.Color(0x2b3138), DARK_HOR = new THREE.Color(0x6b7276);
const HEMI_GREEN = new THREE.Color(0x7d9a80);

/** One per game: both events share it. */
export class StormSky {
  private readonly asks = new Map<string, StormAsk>();
  private wrapped = false;
  private readonly c = new THREE.Color();
  private readonly t = new THREE.Color();
  /** Strongest ask this frame, for the tests and the HUD. */
  readonly now: StormAsk = { green: 0, dark: 0, rain: 0 };
  /** Lightning flash, 0..1, decays; the tornado sets it. */
  flash = 0;

  constructor(private readonly game: Game) {}

  set(who: string, a: StormAsk | null): void {
    if (!a || (a.green <= 0 && a.dark <= 0 && a.rain <= 0)) this.asks.delete(who);
    else this.asks.set(who, a);
    if (!this.wrapped && this.asks.size) this.wrap();
  }

  private wrap(): void {
    const sky = this.game.sky as unknown as SkyGuts | undefined;
    if (!sky || !sky.uniforms || !sky.rainU) return;
    this.wrapped = true;
    const orig = sky.update.bind(sky);
    sky.update = (dt: number): void => {
      orig(dt);
      if (this.asks.size || this.flash > 0) this.apply(sky, dt);
      else { this.now.green = this.now.dark = this.now.rain = 0; }
    };
  }

  private apply(s: SkyGuts, dt: number): void {
    let green = 0, dark = 0, rain = 0;
    for (const a of this.asks.values()) { green = Math.max(green, a.green); dark = Math.max(dark, a.dark); rain = Math.max(rain, a.rain); }
    const n = this.now; n.green = green; n.dark = dark; n.rain = rain;
    const u = s.uniforms;
    const night = this.game.sky.night, day = 1 - night * 0.85;
    const k = Math.max(green, dark);
    const lerpU = (name: string, target: THREE.Color, amt: number): void => {
      const v = u[name]?.value as THREE.Color | undefined;
      if (v) v.lerp(this.t.copy(target).multiplyScalar(day), amt);
    };
    // Green when it is a supercell, slate when it is only a long rain.
    const mixC = (gc: THREE.Color, dc: THREE.Color): THREE.Color => this.c.copy(dc).lerp(gc, green / Math.max(k, 1e-3));
    if (k > 0) {
      lerpU('uZen', mixC(GREEN_ZEN, DARK_ZEN), 0.85 * k);
      lerpU('uMid', mixC(GREEN_MID, DARK_HOR), 0.85 * k);
      lerpU('uHor', mixC(GREEN_HOR, DARK_HOR), 0.75 * k);
      lerpU('uGlow', mixC(GREEN_HOR, DARK_HOR), 0.9 * k);
      lerpU('uCloudShade', mixC(GREEN_CLOUD, DARK_ZEN), 0.9 * k);
      lerpU('uCloudLit', mixC(GREEN_LIT, DARK_HOR), 0.8 * k);
      if (u.uCover) u.uCover.value = Math.max(u.uCover.value as number, k);
      if (u.uSunDisc) u.uSunDisc.value = (u.uSunDisc.value as number) * (1 - k);
      const fogC = mixC(GREEN_HOR, DARK_HOR);
      this.t.copy(fogC).multiplyScalar(day * 0.9);
      s.horBase.lerp(this.t, 0.8 * k); s.horGlow.lerp(this.t, 0.9 * k); s.fogFlat.lerp(this.t, 0.8 * k);
      s.glowAmt *= 1 - k;
      s.fog.density *= 1 + 1.6 * k;
      s.sun.intensity *= 1 - 0.78 * k;
      s.hemi.intensity *= 1 - 0.3 * k;
      s.hemi.color.lerp(this.t.copy(HEMI_GREEN).multiplyScalar(day), 0.5 * green);
    }
    if (this.flash > 0) {
      s.hemi.intensity += this.flash * 2.5;
      const z = u.uZen?.value as THREE.Color | undefined;
      if (z) z.lerp(this.t.setRGB(0.75, 0.8, 0.9), this.flash * 0.6);
      this.flash = Math.max(0, this.flash - dt * 6);
    }
    // Rain: the sky's own streaks, turned on and moved here when its weather is dry.
    if (rain > 0.01) {
      const ru = s.rainU;
      const own = s.rain.visible;
      if (!own) {
        const fall = ru.uFall.value as THREE.Vector3, box = ru.uBox.value as THREE.Vector3, o = s.rainOff;
        o.x = (o.x + fall.x * dt) % (box.x * 10);
        o.y = (o.y + fall.y * dt) % (box.y * 10);
        o.z = (o.z + fall.z * dt) % (box.z * 10);
        (ru.uColor.value as THREE.Color).setRGB(0.55, 0.6, 0.58).multiplyScalar(lerp(1, 0.35, night));
        s.rain.visible = true;
      }
      ru.uAmount.value = Math.max(own ? (ru.uAmount.value as number) : 0, clamp01(rain));
    }
  }
}

const SKIES = new WeakMap<Game, StormSky>();
/** The one StormSky of this game. */
export function stormSky(game: Game): StormSky {
  let s = SKIES.get(game);
  if (!s) SKIES.set(game, (s = new StormSky(game)));
  return s;
}

/**
 * Vertical motion of a car through the public Vehicle fields is not enough: ent/vehicle.ts integrates each axle on its
 * own (yF, yR, vyF, vyR) and derives y and vy from them every step. These reach the axles when they are there.
 */
type Axles = { yF?: number; yR?: number; vyF?: number; vyR?: number; y: number; vy: number };
/** Add `dvy` (m/s) to a car's climb, and `dy` (m) to its height; `tilt` (m/s) pitches the nose up (+) or down. */
export function nudgeCar(v: object, dvy: number, dy = 0, tilt = 0): void {
  const c = v as Axles;
  if (typeof c.vyF === 'number' && typeof c.vyR === 'number' && typeof c.yF === 'number' && typeof c.yR === 'number') {
    c.vyF += dvy + tilt; c.vyR += dvy - tilt; c.yF += dy; c.yR += dy;
  }
  c.vy += dvy; c.y += dy;
}
/** Hold a car's climb at no more than `max` m/s. */
export function capClimb(v: object, max: number): void {
  const c = v as Axles;
  if (typeof c.vyF === 'number' && c.vyF > max) c.vyF = max;
  if (typeof c.vyR === 'number' && c.vyR > max) c.vyR = max;
  if (c.vy > max) c.vy = max;
}
/** Float a car with its middle at height y: level axles, no climb or fall. */
export function floatCar(v: object, y: number, tilt = 0): void {
  const c = v as Axles;
  if (typeof c.yF === 'number' && typeof c.yR === 'number') {
    if ((c.yF + c.yR) / 2 < y) { c.yF = y + tilt; c.yR = y - tilt; }
    if (typeof c.vyF === 'number' && c.vyF < 0) c.vyF = 0;
    if (typeof c.vyR === 'number' && c.vyR < 0) c.vyR = 0;
  }
  if (c.y < y) c.y = y;
  if (c.vy < 0) c.vy = 0;
}
