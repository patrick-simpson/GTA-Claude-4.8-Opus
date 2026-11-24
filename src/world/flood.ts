// Rare weather, part two (fun queue item 8): after a long heavy rain the Muddle River comes up over a few game hours,
// spills over its banks into the riverside streets of Tepid Falls (Water St, the mills, Far Bank Rd, Lesser Tepid),
// floats the cars parked there off down the street, and goes down again.
//
// WHEN. Absolute game time (world/stormSky.ts absHours) is cut into EP-hour episodes; a seeded hash of each says
// whether it has a flood (P: about twice a real day of play) and when it starts. The water level is a pure function of
// that clock, so in a shared town every screen has the same water at the same height with no messages. What it does to
// cars is done by each browser to its own.
//
// TIMELINE (game hours from the start; a game hour is a real minute at the default rate): 0..3.5 heavy rain; the river
// rises from 0.5, is level with the town (the top of the banks) at about 2.6, at its peak (PEAK, three-quarters of a
// metre over the riverside streets) from 4 to 6, back in its banks by about 8 and normal by 9.
//
// LOOK. One flat plane over the river's reach of town at the water level, drawn with a muddy, fast-flowing water shader.
// While the level is below the town the ground hides it everywhere but the river channel (the depth test does the
// work). Over the top, it is masked to a reach from the river's edge that grows with the level: the same reach the
// code below uses for the cars, so what floats is what looks wet. Foam where it is shallow (the banks' slope is
// ported from mainland.ts) and along the edge of the spill.
//
// CARS. Deeper than FLOAT over the ground, a car (this browser's own) floats at the surface, turns slowly and drifts
// with the current, kept off the main channel so it is still in the street when the water goes down. Its air time is
// held at zero so landing again is not a stunt jump.
//
// ROADS. Mainland streets under water are closed to traffic (plan edges' `closed`, the flag traffic already obeys),
// and given back exactly as they were when the water goes down.
//
// COST when there is no flood: one hash on an episode change and a comparison; the plane is hidden.
//
// Test hook: `__storm.flood.start()` (from the beginning) or `.start(4)` (four game hours in, at the peak); `.stop()`.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { RoadEdge as Edge } from './plan';
import { clamp01, smooth } from '../core/util';
import { groundAt } from './plan';
import { STREETS_NEW } from './streets';
import { MAIN_Y, RIVER_HW, TRIB_HW, riverX, tribZ } from './mainland';
import { absHours, floatCar, hash01, stormSky } from './stormSky';
import { StormSound } from '../audio/storm';

const EP = 12;
const P = 1 / 60;
const SALT = 50411;
/** Game hours the whole flood lasts. */
const LEN = 9;
/** River level normally (below the dam) and at the flood's peak. */
const BASE = -0.8;
export const FLOOD_PEAK = MAIN_Y + 0.75;
/** Deeper than this over the ground and a car floats. */
const FLOAT = 0.62;
/** The flooded part of town: the river's whole run through it. */
// New streets: downtown and Front St run up the river to Tuition Ave, and the depot sits by the line at z -2150.
const X0 = 140, X1 = 570, Z0 = STREETS_NEW ? -2200 : -1965, Z1 = -1078;
/** How far from the river's edge the water reaches, m: the banks (22 m) until it is over the top, then out to ~120. */
export function floodReach(level: number): number {
  return level <= MAIN_Y ? 22 : 22 + 100 * smooth((level - MAIN_Y) / (FLOOD_PEAK - MAIN_Y));
}
/** Metres from the river's (or Sidle Brook's) edge, like mainland.ts waterDist but only those two. */
function riverDist(x: number, z: number): number {
  let d = Math.abs(x - riverX(z)) - RIVER_HW;
  if (x > 300 && z > -1600 && z < -1470 && x > riverX(z) - 10) d = Math.min(d, Math.abs(z - tribZ(x)) - TRIB_HW);
  return d;
}
/** Water depth over the ground at (x, z) for this level, 0 where it is dry. */
export function floodDepth(x: number, z: number, level: number): number {
  if (level <= BASE + 0.05 || x < X0 || x > X1 || z < Z0 || z > Z1) return 0;
  if (riverDist(x, z) > floodReach(level)) return 0;
  return Math.max(0, level - groundAt(x, z));
}

const VERT = /* glsl */ `
varying vec3 vW;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uTime, uLevel, uReach, uAlpha;
uniform vec3 uMud, uMudDeep, uSky, uFoam, uLight, uSun;
uniform sampler2D uNoise;
varying vec3 vW;
#include <common>
#include <fog_pars_fragment>
float riverX(float z) { return 340.0 + 30.0 * sin((z + 1100.0) / 210.0); }
float riverDist(vec2 p) {
  float rx = riverX(p.y);
  float d = abs(p.x - rx) - ${RIVER_HW.toFixed(1)};
  if (p.x > 300.0 && p.y > -1600.0 && p.y < -1470.0 && p.x > rx - 10.0) d = min(d, abs(p.y - (-1530.0 + 14.0 * sin((p.x - 400.0) / 160.0))) - ${TRIB_HW.toFixed(1)});
  return d;
}
float groundH(float d) {
  if (d >= 22.0) return ${MAIN_Y.toFixed(1)};
  if (d <= -10.0) return -3.4;
  float t = clamp((22.0 - d) / 32.0, 0.0, 1.0);
  return ${MAIN_Y.toFixed(1)} - ${(MAIN_Y + 3.4).toFixed(1)} * t * t * (3.0 - 2.0 * t);
}
void main() {
  vec2 p = vW.xz;
  float d = riverDist(p);
  float edge = uReach - d;
  if (edge < 0.0) discard;
  float depth = uLevel - groundH(d);
  // Downstream is +z; the main channel runs fastest, the spill over the streets slowly.
  float fast = 1.0 - smoothstep(-10.0, 20.0, d);
  float flow = mix(0.25, 2.2, fast);
  vec2 uv = p * vec2(0.035, 0.018) - vec2(0.0, uTime * flow * 0.02);
  float n = texture2D(uNoise, uv).r * 0.6 + texture2D(uNoise, uv * 2.7 + vec2(0.31, -uTime * flow * 0.03)).g * 0.4;
  float n2 = texture2D(uNoise, p * 0.11 - vec2(0.0, uTime * flow * 0.09)).r;
  float n3 = texture2D(uNoise, p * 0.37 + vec2(uTime * 0.05, -uTime * flow * 0.16)).g;
  vec3 col = mix(uMud, uMudDeep, smoothstep(0.3, 3.0, depth));
  col *= 0.62 + 0.75 * n;
  // A wide, flat-on look at the sky in the brown water, more of it at a grazing angle.
  vec3 toCam = normalize(cameraPosition - vW);
  float fres = 0.04 + 0.42 * pow(1.0 - max(toCam.y, 0.0), 5.0);
  col = mix(col, uSky * 0.8, fres * (0.7 + 0.6 * n3));
  vec3 nrm = normalize(vec3((n - 0.5) * 0.3 + (n3 - 0.5) * 0.5, 1.0, (n2 - 0.5) * 0.3 + (n3 - 0.5) * 0.4));
  float spec = pow(max(dot(reflect(-uLight, nrm), toCam), 0.0), 60.0);
  col += uSun * spec * 0.9;
  // Foam: churned water in the channel, the shallows over the banks and the leading edge of the spill.
  float foam = smoothstep(0.62, 0.8, n2 + fast * 0.15) * fast * 0.6;
  foam = max(foam, (1.0 - smoothstep(0.0, 0.35, depth)) * smoothstep(0.35, 0.6, n2));
  foam = max(foam, (1.0 - smoothstep(0.0, 4.0, edge)) * smoothstep(0.3, 0.55, n));
  col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.8);
  float a = uAlpha * smoothstep(0.0, 1.5, edge) * mix(0.75, 0.97, smoothstep(0.05, 0.6, depth));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

interface Ev { t0: number }

export class Flood implements WorldPart {
  readonly stats = { active: false, phase: 0, level: BASE, reach: 0, floating: 0, closed: 0, ms: 0 };
  private readonly mesh: THREE.Mesh;
  private readonly u: Record<string, THREE.IUniform>;
  private readonly sound: StormSound;
  private ep = NaN;
  private evs: Ev[] = [];
  private forced: Ev | null = null;
  private time = 0;
  private said = '';
  /** Streets this flood closed, and what their flag was before. */
  private readonly shut = new Map<Edge, boolean>();
  private roadT = 0;

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.u = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uLevel: { value: BASE }, uReach: { value: 22 }, uAlpha: { value: 0.94 },
      uMud: { value: new THREE.Color(0x6b5a3c) }, uMudDeep: { value: new THREE.Color(0x3e3624) },
      uSky: { value: new THREE.Color(0x8a9090) }, uFoam: { value: new THREE.Color(0xd8d0bc) },
      uLight: { value: new THREE.Vector3(0.5, 0.6, 0.5).normalize() }, uSun: { value: new THREE.Color(0xffffff) },
      uNoise: { value: game.world.mats.tex.noise },
    };
    const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      fog: true, transparent: true, depthWrite: false,
    }));
    this.mesh.name = 'flood';
    this.mesh.position.set((X0 + X1) / 2, BASE, (Z0 + Z1) / 2);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.sound = new StormSound(() => this.game.audio?.core ?? null);
  }

  /** Test hook: a flood starting now, or `hours` game hours in (4: at its peak). */
  start(hours = 0): void { this.forced = { t0: absHours(this.game.sky.hour) - hours }; }
  stop(): void { this.forced = null; this.evs = []; this.ep = NaN; }

  private scheduled(e: number): Ev | null {
    if (hash01(e, SALT) >= P) return null;
    return { t0: e * EP + 0.5 + hash01(e, SALT + 1) * (EP - LEN - 1) };
  }

  /** The water level at flood hour `ph`. */
  static level(ph: number): number {
    if (ph <= 0 || ph >= LEN) return BASE;
    const up = smooth(ph / 4), down = smooth((ph - 6) / 3);
    return BASE + (FLOOD_PEAK - BASE) * up * (1 - down);
  }

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky || !g.vehicles) return;
    const t0 = performance.now();
    const abs = absHours(sky.hour);
    const e = Math.floor(abs / EP);
    if (e !== this.ep) { this.ep = e; this.evs = [this.scheduled(e - 1), this.scheduled(e)].filter((x): x is Ev => x !== null); }
    let ev: Ev | null = this.forced;
    if (!ev) for (const c of this.evs) if (abs >= c.t0 && abs <= c.t0 + LEN) ev = c;
    const ph = ev ? abs - ev.t0 : -1;
    const st = this.stats;
    if (!ev || ph < 0 || ph > LEN) {
      if (this.forced && ph > LEN) this.forced = null;
      if (st.active) this.end();
      this.sound.update(dt, { siren: 0, roar: 0, rain: 0 });
      st.ms = performance.now() - t0;
      return;
    }
    st.active = true; st.phase = ph;
    this.time += dt;
    const level = Flood.level(ph), reach = floodReach(level);
    st.level = level; st.reach = reach;
    // ── Rain ──
    const rain = smooth(ph / 0.3) * (1 - smooth((ph - 3.5) / 0.8));
    stormSky(g).set('flood', { green: 0, dark: rain * 0.7, rain });
    if (!sky.led && rain > 0.5 && sky.weather !== 'rain' && sky.weather !== 'snow') sky.setWeather('rain');
    const cam = g.camera.position;
    const near = cam.z < Z1 + 400 && cam.z > Z0 - 400 && cam.x > X0 - 500 && cam.x < X1 + 500;
    this.sound.update(dt, { siren: 0, roar: 0, rain: near ? rain * 0.7 : 0 });
    // ── Radio ──
    const say = ph < 2.6 ? 'watch' : ph < 6.5 ? 'warning' : 'falling';
    if (say !== this.said) {
      this.said = say;
      g.hud?.toast(say === 'watch'
        ? 'RADIO: Flood watch for Tepid Falls. The Muddle River is rising after the rain. Residents of Water St are advised to move their cars and their expectations.'
        : say === 'warning'
          ? 'RADIO: Flood warning. The Muddle River is over its banks in Tepid Falls. Water St and Far Bank Rd are closed. Do not drive into flood water. Do not float into it either.'
          : 'RADIO: The Muddle River is going down. Tepid Falls thanks everyone who stayed calm and asks the rest to collect their cars.', 8);
    }
    // ── The water ──
    const show = level > BASE + 0.05;
    this.mesh.visible = show;
    if (show) {
      this.mesh.position.y = level;
      const u = this.u;
      u.uTime.value = this.time; u.uLevel.value = level; u.uReach.value = reach;
      const day = 1 - sky.night * 0.9;
      const hemi = (sky as unknown as { hemi?: THREE.HemisphereLight }).hemi;
      const sun = (sky as unknown as { sun?: THREE.DirectionalLight }).sun;
      const amb = hemi ? Math.max(0.08, hemi.intensity * 0.55) : 0.6;
      (u.uMud.value as THREE.Color).setRGB(0.3, 0.25, 0.16).multiplyScalar(amb);
      (u.uMudDeep.value as THREE.Color).setRGB(0.16, 0.14, 0.09).multiplyScalar(amb);
      (u.uFoam.value as THREE.Color).setRGB(0.85, 0.82, 0.74).multiplyScalar(Math.min(1.2, amb * 1.3));
      const fog = g.scene.fog as THREE.FogExp2 | null;
      if (fog) (u.uSky.value as THREE.Color).copy(fog.color).multiplyScalar(0.9);
      if (sun) (u.uSun.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1, sun.intensity / 3) * day);
      (u.uLight.value as THREE.Vector3).copy(sky.lightDir);
    }
    // ── Cars ──
    let floating = 0;
    if (level > MAIN_Y - 6) {
      for (const v of g.vehicles.list) {
        if (v.shared || v.removed || v.sunk || v.x < X0 || v.x > X1 || v.z < Z0 || v.z > Z1) continue;
        const depth = floodDepth(v.x, v.z, level);
        if (depth < FLOAT) continue;
        floating++;
        floatCar(v, level - 0.55, Math.sin(this.time * 0.8 + v.id) * 0.05);
        v.airTime = 0;
        // With the current, slowly; and back out of the main channel, so it ends up in a street, not the river.
        const rd = riverDist(v.x, v.z), side = Math.sign(v.x - riverX(v.z)) || 1;
        const wx = rd < 12 ? side * 0.9 : 0, wz = 0.5 + 0.9 * clamp01(1 - rd / 40);
        const k = Math.min(1, dt * 0.6);
        v.vx += (wx - v.vx) * k; v.vz += (wz - v.vz) * k;
        v.yawRate += ((hash01(v.id, 21) - 0.5) * 0.3 - v.yawRate) * k;
        v.roll = Math.cos(this.time * 0.6 + v.id * 1.7) * 0.04;
      }
    }
    st.floating = floating;
    // ── Roads ──
    this.roadT -= dt;
    if (this.roadT <= 0) { this.roadT = 2; this.roads(level); }
    st.ms = performance.now() - t0;
  }

  /** Close the mainland streets the water is over; give back the ones it has left. */
  private roads(level: number): void {
    const plan = this.game.plan;
    if (!plan) return;
    for (const e of plan.edges) {
      if (!e.land) continue;
      const a = plan.nodes[e.a], b = plan.nodes[e.b];
      let wet = false;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        if (floodDepth(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, level) > 0.12) { wet = true; break; }
      }
      if (wet && !this.shut.has(e)) { this.shut.set(e, e.closed); e.closed = true; }
      else if (!wet && this.shut.has(e)) { e.closed = this.shut.get(e)!; this.shut.delete(e); }
    }
    this.stats.closed = this.shut.size;
  }

  private end(): void {
    const st = this.stats;
    st.active = false; st.level = BASE; st.floating = 0;
    this.mesh.visible = false;
    this.said = '';
    for (const [e, was] of this.shut) e.closed = was;
    this.shut.clear();
    st.closed = 0;
    stormSky(this.game).set('flood', null);
  }
}

