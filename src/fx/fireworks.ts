// Fireworks over Pelican Pier.
//
// The show: on Saturdays and US holidays (the real calendar, the same one fx/season reads), at 9 PM game time, a
// four-minute show fires from a barge off the end of Pelican Pier and builds to a finale. Its time is read from the
// game clock (sky.hour), which in a shared town is the host's clock (net/town.ts), and every shell in it comes from a
// seeded list made from the date, so every screen in a town sees the same shell at the same moment without a byte
// being sent. ?fireworks=show makes every night a show night (tests); ?fireworks=off switches the show off.
//
// The player's own: a stall halfway up the pier (Pier-o-Technics) sells a box of six for $150; L (or the touch
// button) sets one off where she stands. Local to this screen for now.
//
// What is drawn: every spark, trail, strobe, crackle pop and water glint is one instanced quad in ONE additive draw
// call (stretched along its motion on screen, never smaller than a pixel and a half, so the show reads from across
// the island and from the bridge); the smoke is a second, normally blended draw call lit by the bursts near it.
// The flash of each burst lifts the scene's hemisphere light for a moment, scaled by how far the camera is from it,
// so the sea, the pier and the fronts nearby light up in the burst's colour. Buffers are allocated once, capped,
// and registered with game.flip; nothing is allocated per frame. Sound: audio/fireworks.ts, delayed by distance.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { flip } from '../core/flip';
import { money } from '../core/util';
import { WATER_Y, groundAt, isWater } from '../world/plan';
import { fwBoom, fwCrackle, fwLift } from '../audio/fireworks';

// ── Calendar ─────────────────────────────────────────────────────────────────

const nthWeekday = (y: number, m: number, wd: number, n: number): number => {
  const first = new Date(y, m, 1).getDay();
  return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
};
const lastWeekday = (y: number, m: number, wd: number): number => {
  const days = new Date(y, m + 1, 0).getDate(), last = new Date(y, m, days).getDay();
  return days - ((last - wd + 7) % 7);
};

/** The name of the US holiday on this date, or null. Fireworks nights: the federal holidays and New Year's Eve. */
export function usHoliday(d: Date): string | null {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (m === 0 && day === 1) return "New Year's Day";
  if (m === 0 && day === nthWeekday(y, 0, 1, 3)) return 'Martin Luther King Jr. Day';
  if (m === 1 && day === nthWeekday(y, 1, 1, 3)) return "Presidents' Day";
  if (m === 4 && day === lastWeekday(y, 4, 1)) return 'Memorial Day';
  if (m === 5 && day === 19) return 'Juneteenth';
  if (m === 6 && day === 4) return 'the Fourth of July';
  if (m === 8 && day === nthWeekday(y, 8, 1, 1)) return 'Labor Day';
  if (m === 9 && day === nthWeekday(y, 9, 1, 2)) return 'Columbus Day';
  if (m === 10 && day === 11) return 'Veterans Day';
  if (m === 10 && day === nthWeekday(y, 10, 4, 4)) return 'Thanksgiving';
  if (m === 11 && day === 25) return 'Christmas';
  if (m === 11 && day === 31) return "New Year's Eve";
  return null;
}

/** Why tonight is a show night, or null. */
export function showReason(d: Date): string | null {
  return usHoliday(d) ?? (d.getDay() === 6 ? 'Saturday night' : null);
}

const urlMode = ((): string => {
  try { return new URLSearchParams(location.search).get('fireworks') ?? ''; } catch { return ''; }
})();

// ── Shells ───────────────────────────────────────────────────────────────────

export type ShellType = 'peony' | 'chrys' | 'willow' | 'palm' | 'crossette' | 'ring' | 'heart' | 'strobe' | 'crackle' | 'glitter' | 'salute';
const TYPES: ShellType[] = ['peony', 'chrys', 'willow', 'palm', 'crossette', 'ring', 'heart', 'strobe', 'crackle', 'glitter', 'salute'];

/** Linear colours, a little over 1 so the night bloom catches them. */
const PAL: [number, number, number][] = [
  [1, 0.07, 0.04], [0.1, 1, 0.16], [0.12, 0.26, 1], [0.62, 0.12, 1], [1, 0.52, 0.1],
  [0.92, 0.92, 1], [1, 0.28, 0.03], [0.1, 0.85, 0.8], [1, 0.22, 0.5],
];
const GOLD: [number, number, number] = [1, 0.5, 0.14];

interface Shell { used: boolean; type: ShellType; c1: number; c2: number; scale: number; whistle: boolean; local: boolean }
interface Flash { x: number; y: number; z: number; r: number; g: number; b: number; i: number; age: number }
interface Glow { x: number; y: number; z: number; r: number; g: number; b: number; i: number; age: number; life: number }
interface Cue { t: number; type: ShellType; x: number; z: number; h: number; c1: number; c2: number; scale: number }

// Particle kinds.
const K_PLAIN = 0, K_STROBE = 1, K_TWINKLE = 2, K_CRACKLE = 3, K_COMET = 4, K_SHELL = 5, K_TRAIL = 6, K_POP = 7;

const SHOW_X = 0, SHOW_Z = 800, SHOW_LEN = 240, SHOW_HOUR = 21;
const STALL = { x: 6.2, z: 500 };
const BOX_PRICE = 150, BOX_SHELLS = 6;

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The show for one date: about 330 shells over four minutes, building to the finale. */
function program(seed: number): Cue[] {
  const r = rng(seed), out: Cue[] = [];
  const pick = (list: ShellType[]): ShellType => list[(r() * list.length) | 0];
  const col = (): number => (r() * PAL.length) | 0;
  const add = (t: number, type: ShellType, spread = 1, h = 0): void => {
    out.push({ t, type, x: SHOW_X + (r() - 0.5) * 240 * spread, z: SHOW_Z + (r() - 0.5) * 70, h: h || 140 + r() * 90,
      c1: col(), c2: col(), scale: 0.85 + r() * 0.35 });
  };
  // Opening: single big shells, a breath apart.
  for (let t = 2; t < 55; t += 2.6 + r() * 1.4) add(t, pick(['peony', 'chrys', 'willow', 'peony', 'ring']), 0.6);
  // The body: pairs and themes.
  for (let t = 55; t < 150; t += 1.5 + r() * 1.2) {
    const ty = pick(TYPES.slice(0, 10));
    add(t, ty);
    if (r() < 0.35) add(t + 0.15, ty);
  }
  // A heart for the pier, and a willow curtain.
  add(100, 'heart', 0.1, 150); add(101.5, 'heart', 0.6, 135);
  for (let i = 0; i < 7; i++) add(130 + i * 0.35, 'willow', 0.15 + i * 0.14, 175);
  // The build: faster, higher, more at once.
  for (let t = 150; t < 205; t += 0.7 + r() * 0.6) {
    add(t, pick(['peony', 'chrys', 'crossette', 'palm', 'strobe', 'crackle', 'glitter', 'ring']));
    if (r() < 0.4) add(t + 0.1, pick(['peony', 'crackle', 'strobe']));
  }
  // The finale: salvos, then the salutes and a last gold willow curtain.
  for (let t = 205; t < 228; t += 0.12 + r() * 0.15) add(t, pick(['peony', 'chrys', 'crackle', 'strobe', 'palm', 'crossette', 'glitter', 'peony']), 1.15, 150 + r() * 110);
  for (let i = 0; i < 12; i++) add(228 + i * 0.25, 'willow', 1.2, 190);
  for (let i = 0; i < 8; i++) add(229 + i * 0.4, 'salute', 1, 160 + r() * 40);
  for (let i = 0; i < 10; i++) add(232.5 + r() * 0.8, 'crackle', 1.2, 170);
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const SPARK_VS = /* glsl */ `
attribute vec4 aPos;   // xyz, world size
attribute vec4 aCol;   // linear rgb * intensity, unused
attribute vec4 aVel;   // velocity (world), stretch seconds
uniform float uProjY;
uniform float uResY;
uniform float uMinPx;
varying vec3 vCol;
varying vec2 vUv;
void main() {
  vec4 c = viewMatrix * vec4(aPos.xyz, 1.0);
  vec3 vv = mat3(viewMatrix) * aVel.xyz;
  float sp = length(vv.xy);
  vec2 ax = sp > 1e-4 ? vv.xy / sp : vec2(1.0, 0.0);
  float W = aPos.w;
  float L = W + sp * aVel.w;
  float depth = max(-c.z, 0.5);
  float px = W * uProjY * uResY * 0.5 / depth;
  float k = 1.0;
  if (px < uMinPx) {
    float s = uMinPx / max(px, 1e-4);
    float W2 = W * s, L2 = max(L, W2);
    // Not all the energy is kept: a far-off spark stays a bright point, as the eye sees it, not a grey smudge.
    k = sqrt((W * L) / (W2 * L2));
    W = W2; L = L2;
  }
  vec2 off = ax * (position.x * L) + vec2(-ax.y, ax.x) * (position.y * W);
  c.xy += off;
  vCol = aCol.rgb * k;
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * c;
}`;

const SPARK_FS = /* glsl */ `
varying vec3 vCol;
varying vec2 vUv;
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 5.0) + 0.6 * exp(-d2 * 30.0);
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

const SMOKE_VS = /* glsl */ `
attribute vec4 aPos;   // xyz, size
attribute vec4 aCol;   // lit rgb, alpha
attribute float aSeed;
varying vec4 vCol;
varying vec2 vUv;
varying float vSeed;
void main() {
  vec4 c = viewMatrix * vec4(aPos.xyz, 1.0);
  float a = aSeed * 6.2832;
  vec2 p = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
  c.xy += p * aPos.w;
  vCol = aCol; vUv = position.xy * 2.0; vSeed = aSeed;
  gl_Position = projectionMatrix * c;
}`;

const SMOKE_FS = /* glsl */ `
varying vec4 vCol;
varying vec2 vUv;
varying float vSeed;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  // A lumpy edge from a few sines, so a puff is not a disc.
  float ang = atan(vUv.y, vUv.x);
  float lump = 0.82 + 0.1 * sin(ang * 3.0 + vSeed * 20.0) + 0.08 * sin(ang * 7.0 - vSeed * 13.0);
  float a = smoothstep(lump, lump * 0.25, d) * vCol.a;
  gl_FragColor = vec4(vCol.rgb, a);
}`;

// ── The system ───────────────────────────────────────────────────────────────

const _v = new THREE.Vector3();
const _col = new THREE.Color();

export class Fireworks {
  // Sparks, structure of arrays.
  private readonly cap: number;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly cr: Float32Array; private readonly cg: Float32Array; private readonly cb: Float32Array;
  private readonly inten: Float32Array; private readonly size: Float32Array; private readonly drag: Float32Array;
  private readonly grav: Float32Array; private readonly stretch: Float32Array; private readonly emit: Float32Array;
  private readonly acc: Float32Array; private readonly phase: Float32Array; private readonly kind: Uint8Array;
  private head = 0;
  live = 0;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly sparkGeo = new THREE.InstancedBufferGeometry();
  private readonly sparkMesh: THREE.Mesh;
  private readonly sparkMat: THREE.ShaderMaterial;

  // Smoke.
  private readonly scap: number;
  private readonly sx: Float32Array; private readonly sy: Float32Array; private readonly sz: Float32Array;
  private readonly sage: Float32Array; private readonly slife: Float32Array; private readonly ss0: Float32Array; private readonly ss1: Float32Array;
  private readonly sr: Float32Array; private readonly sg: Float32Array; private readonly sb: Float32Array;
  private shead = 0;
  private slive = 0;
  private readonly bPos: THREE.InstancedBufferAttribute;
  private readonly bCol: THREE.InstancedBufferAttribute;
  private readonly bSeed: THREE.InstancedBufferAttribute;
  private readonly smokeGeo = new THREE.InstancedBufferGeometry();
  private readonly smokeMesh: THREE.Mesh;

  private readonly shells: Shell[] = [];
  private readonly flashes: Flash[] = [];
  private readonly glows: Glow[] = [];
  private readonly q: number;
  private readonly rnd = rng(12345);
  private windX = 0.6; private windZ = 0.3;

  // The show.
  private cues: Cue[] = [];
  private cueSeed = -1;
  private cueAt = 0;
  private showT = -1;
  private reasonText: string | null = null;
  private announced = false;
  /** Seconds into tonight's show, or -1 when none is running. */
  get showTime(): number { return this.showT; }
  /** A test or the lead can force the show: 'auto' follows the calendar, 'on' every night, 'off' never. */
  mode: 'auto' | 'on' | 'off' = urlMode === 'show' || urlMode === '1' ? 'on' : urlMode === 'off' ? 'off' : 'auto';

  // The player's box.
  boxes = 0;
  private prompting = false;
  private told = 0;
  private reasonCheck = -1e9;
  private btn: HTMLButtonElement | null = null;

  // The flash on the scene.
  private flashLevel = 0;
  private readonly flashCol = new THREE.Color();
  private hemi: THREE.HemisphereLight | null = null;
  private saveI = 0;
  private readonly saveSky = new THREE.Color();
  private readonly saveGnd = new THREE.Color();
  private lifted = false;

  /** Debug numbers for tests. */
  readonly stats = { bursts: 0, launched: 0, peak: 0 };

  constructor(private readonly game: Game, parent: THREE.Object3D) {
    const low = game.quality.name === 'low';
    this.q = low ? 0.4 : Math.min(1, Math.max(0.6, game.quality.density));
    this.cap = low ? 2500 : 9000;
    this.scap = low ? 160 : 520;
    const f = (n: number): Float32Array => new Float32Array(n);
    const n = this.cap;
    this.px = f(n); this.py = f(n); this.pz = f(n); this.vx = f(n); this.vy = f(n); this.vz = f(n);
    this.age = f(n); this.life = f(n); this.cr = f(n); this.cg = f(n); this.cb = f(n); this.inten = f(n); this.size = f(n);
    this.drag = f(n); this.grav = f(n); this.stretch = f(n); this.emit = f(n); this.acc = f(n); this.phase = f(n);
    this.kind = new Uint8Array(n);

    const quad = new THREE.PlaneGeometry(1, 1);
    const inst = (geo: THREE.InstancedBufferGeometry, name: string, count: number, w: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(count * w), w).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a); flip.geo(geo, name);
      return a;
    };
    for (const geo of [this.sparkGeo, this.smokeGeo]) {
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      geo.instanceCount = 0;
    }
    // +16: the water glints ride at the end of the spark buffer.
    this.aPos = inst(this.sparkGeo, 'aPos', n + 16, 4);
    this.aCol = inst(this.sparkGeo, 'aCol', n + 16, 4);
    this.aVel = inst(this.sparkGeo, 'aVel', n + 16, 4);
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { uProjY: { value: 1.7 }, uResY: { value: 720 }, uMinPx: { value: low ? 2.0 : 1.5 } },
      vertexShader: SPARK_VS, fragmentShader: SPARK_FS,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    this.sparkMesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);

    const m = this.scap;
    this.sx = f(m); this.sy = f(m); this.sz = f(m); this.sage = f(m); this.slife = f(m); this.ss0 = f(m); this.ss1 = f(m);
    this.sr = f(m); this.sg = f(m); this.sb = f(m);
    this.bPos = inst(this.smokeGeo, 'aPos', m, 4);
    this.bCol = inst(this.smokeGeo, 'aCol', m, 4);
    this.bSeed = new THREE.InstancedBufferAttribute(new Float32Array(m), 1);
    for (let i = 0; i < m; i++) this.bSeed.array[i] = Math.random();
    this.smokeGeo.setAttribute('aSeed', this.bSeed);
    const smokeMat = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VS, fragmentShader: SMOKE_FS, transparent: true, depthWrite: false, fog: false,
    });
    this.smokeMesh = new THREE.Mesh(this.smokeGeo, smokeMat);

    for (const mesh of [this.smokeMesh, this.sparkMesh]) {
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.visible = false;
      parent.add(mesh);
    }
    // After the particles (20, 21) and the water; smoke under the sparks.
    this.smokeMesh.renderOrder = 22; this.sparkMesh.renderOrder = 23;
    this.sparkMesh.onBeforeRender = (renderer, _s, camera): void => {
      const u = this.sparkMat.uniforms, rt = renderer.getRenderTarget();
      u.uProjY.value = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
      u.uResY.value = rt ? rt.height : renderer.domElement.height;
    };

    for (let i = 0; i < 64; i++) this.shells.push({ used: false, type: 'peony', c1: 0, c2: 0, scale: 1, whistle: false, local: false });
    for (let i = 0; i < 14; i++) this.flashes.push({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, i: 0, age: 9 });
    for (let i = 0; i < 16; i++) this.glows.push({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, i: 0, age: 9, life: 0 });

    this.buildStall(parent);
    this.hookFlash();
    addEventListener('keydown', (e) => {
      if (!this.game.input.is(e.code, 'fireworks') || e.repeat || this.game.state !== 'play') return;
      this.lightOne();
    });
    // Tests and the lead: window.__game.game is not exposed, so hang the system where a test can reach it.
    (game as unknown as { fireworks?: Fireworks }).fireworks = this;
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Launch one shell from (x, ground y, z) to burst h metres up. */
  launch(type: ShellType, x: number, y: number, z: number, h: number, c1 = 0, c2 = 1, scale = 1, local = false): void {
    const s = this.shells.find((k) => !k.used);
    if (!s) return;
    s.used = true; s.type = type; s.c1 = c1 % PAL.length; s.c2 = c2 % PAL.length; s.scale = scale; s.local = local;
    s.whistle = this.rnd() < 0.18;
    // A shell climbs on a slightly slower gravity than the stars (drag), bursting just short of the top.
    const g = 16, vy = Math.sqrt(2 * g * h);
    const i = this.add(x, y + 0.5, z, (this.rnd() - 0.5) * 2, vy, (this.rnd() - 0.5) * 2, (vy / g) * 0.96, 0.9, 1, 0.55, 0.2, 2.2);
    this.kind[i] = K_SHELL; this.grav[i] = g; this.drag[i] = 0; this.emit[i] = 45 * this.q; this.stretch[i] = 0.03;
    this.phase[i] = this.shells.indexOf(s);
    this.stats.launched++;
    const core = this.game.audio?.core;
    if (core && core.claim('fwlift', 4, 0.5)) {
      const sp = core.place(x, y + 1, z, { ref: local ? 6 : 25, max: 1400, wet: 0.35 });
      if (sp) fwLift(core, core.now + sp.lag, sp.in, s.whistle);
    }
  }

  /** The player sets one off where she stands. */
  lightOne(): void {
    const g = this.game, p = g.player;
    if (!p || p.vehicle) return;
    if (this.boxes <= 0) { g.hud.toast('No fireworks. Pier-o-Technics, halfway up Pelican Pier, sells them.', 4); return; }
    this.boxes--;
    const a = this.rnd() * 6.283;
    const types: ShellType[] = ['peony', 'chrys', 'willow', 'palm', 'crossette', 'ring', 'heart', 'strobe', 'crackle', 'glitter'];
    const ty = types[(this.rnd() * types.length) | 0];
    const sx = p.x + Math.cos(a) * 1.5, sz = p.z + Math.sin(a) * 1.5, h = 55 + this.rnd() * 30;
    const c1 = (this.rnd() * PAL.length) | 0, c2 = (this.rnd() * PAL.length) | 0;
    this.launch(ty, sx, p.y, sz, h, c1, c2, 0.6, true);
    // Everybody else in town sees the same shell at the same spot (net/extras.ts, event code 19).
    g.net?.extras.fireworks(ty, sx, p.y, sz, h, c1, c2, 0.6);
    g.hud.toast(this.boxes > 0 ? `Fire in the hole. ${this.boxes} left in the box.` : 'That was the last one. The box is now a hat.', 3);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (dt <= 0) return;
    const g = this.game;
    this.windX = 0.7 + 0.35 * Math.sin(g.time * 0.13);
    this.windZ = 0.35 + 0.3 * Math.sin(g.time * 0.09 + 1.7);
    this.runShow(dt);
    this.stall(dt);
    this.stepSparks(dt);
    this.stepSmoke(dt);
    this.stepFlash(dt);
  }

  // ── The show ───────────────────────────────────────────────────────────────

  private runShow(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky) return;
    // The real date, checked once a real minute.
    const now = Date.now();
    if (now - this.reasonCheck > 60000) { this.reasonCheck = now; this.reasonText = showReason(new Date(now)); }
    const on = this.mode === 'on' || (this.mode === 'auto' && this.reasonText !== null);
    const since = (sky.hour - SHOW_HOUR + 24) % 24;
    // The show runs four real minutes from 9 PM; with the clock running, its time IS the clock (shared in a town).
    let t = sky.rate > 0 ? since / sky.rate : (this.showT >= 0 ? this.showT + dt : -1);
    if (!on || sky.weather === 'rain' || t < 0 || t > SHOW_LEN + 2) t = -1;
    if (t < 0) { this.showT = -1; this.announced = false; return; }
    const d = new Date(now), seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    if (seed !== this.cueSeed) { this.cueSeed = seed; this.cues = program(seed); this.cueAt = 0; this.showT = -1; }
    // Joined late, or the clock jumped (a cheat, a host's correction): pick up from here without firing the past.
    if (this.showT < 0 || Math.abs(t - this.showT) > 2 || t < this.showT) {
      this.cueAt = 0;
      while (this.cueAt < this.cues.length && this.cues[this.cueAt].t < t - 0.5) this.cueAt++;
    }
    this.showT = t;
    if (!this.announced && t < 30) {
      this.announced = true;
      const why = this.mode === 'on' && !this.reasonText ? 'tonight' : `for ${this.reasonText}`;
      g.hud.toast(`Fireworks over Pelican Pier ${why}. Best seen from the pier, the beach, or anywhere with a view of the bay.`, 6);
    }
    while (this.cueAt < this.cues.length && this.cues[this.cueAt].t <= t) {
      const c = this.cues[this.cueAt++];
      this.launch(c.type, c.x, WATER_Y + 1.2, c.z, c.h, c.c1, c.c2, c.scale);
    }
  }

  // ── Spark pool ─────────────────────────────────────────────────────────────

  /** Take the oldest slot. */
  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number,
    r: number, g: number, b: number, inten: number, size: number): number {
    let i = this.head;
    // Never recycle a shell still climbing: its burst would be lost.
    for (let k = 0; k < 64 && this.life[i] > 0 && this.kind[i] === K_SHELL; k++) i = i + 1 === this.cap ? 0 : i + 1;
    this.head = i + 1 === this.cap ? 0 : i + 1;
    if (this.life[i] === 0) this.live++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.cr[i] = r; this.cg[i] = g; this.cb[i] = b; this.inten[i] = inten; this.size[i] = size;
    this.drag[i] = 1.2; this.grav[i] = 9.8; this.stretch[i] = 0.06; this.emit[i] = 0; this.acc[i] = 0; this.phase[i] = 0; this.kind[i] = K_PLAIN;
    return i;
  }

  private star(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, life: number,
    c: [number, number, number], inten: number, size: number, drag: number, grav: number, kind: number): number {
    const s = speed * (0.93 + this.rnd() * 0.14);
    const i = this.add(x, y, z, dx * s, dy * s, dz * s, life * (0.85 + this.rnd() * 0.3), c[0], c[1], c[2], inten, size);
    this.drag[i] = drag; this.grav[i] = grav; this.kind[i] = kind;
    this.phase[i] = this.rnd() * 6.283;
    return i;
  }

  private burst(slot: number, x: number, y: number, z: number): void {
    const s = this.shells[slot];
    if (!s) return;
    s.used = false;
    this.stats.bursts++;
    const r = this.rnd, q = this.q, sc = s.scale, c1 = PAL[s.c1], c2 = PAL[s.c2];
    const sp = (base: number): number => base * sc;
    const n = (base: number): number => Math.max(6, Math.round(base * q * (0.6 + 0.4 * sc)));
    let flashI = 1.0 * sc;
    const sphere = (count: number, fn: (dx: number, dy: number, dz: number, k: number) => void): void => {
      const rot = r() * 6.283;
      for (let k = 0; k < count; k++) {
        const yy = 1 - 2 * (k + 0.5) / count, rr = Math.sqrt(1 - yy * yy), th = k * 2.39996 + rot;
        fn(Math.cos(th) * rr + (r() - 0.5) * 0.06, yy + (r() - 0.5) * 0.06, Math.sin(th) * rr + (r() - 0.5) * 0.06, k);
      }
    };
    switch (s.type) {
      case 'peony':
        sphere(n(170), (dx, dy, dz, k) => this.star(x, y, z, dx, dy, dz, sp(80), 2.0, k % 5 === 0 ? c2 : c1, 7, 1.3, 1.35, 6, K_PLAIN));
        break;
      case 'chrys':
        sphere(n(140), (dx, dy, dz, k) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(78), 2.2, c1, 6, 1.1, 1.25, 6, K_PLAIN);
          if (k % 2 === 0) this.emit[i] = 22 * q;
          this.stretch[i] = 0.09;
        });
        break;
      case 'willow':
        sphere(n(120), (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy * 0.8 + 0.15, dz, sp(48), 5.5, GOLD, 4.5, 1.0, 1.8, 4.0, K_TWINKLE);
          this.emit[i] = 12 * q; this.stretch[i] = 0.16;
        });
        flashI *= 0.7;
        break;
      case 'palm': {
        const arms = 7 + ((r() * 4) | 0);
        for (let k = 0; k < arms; k++) {
          const a = (k / arms) * 6.283 + r() * 0.3, up = 0.35 + r() * 0.4, h = Math.sqrt(1 - up * up);
          const i = this.star(x, y, z, Math.cos(a) * h, up, Math.sin(a) * h, sp(46), 3.0, GOLD, 6, 1.5, 0.9, 7, K_COMET);
          this.emit[i] = 80 * q; this.phase[i] = 99; this.stretch[i] = 0.1;
        }
        sphere(n(40), (dx, dy, dz) => this.star(x, y, z, dx, dy, dz, sp(30), 1.2, c1, 5, 1.0, 1.5, 5, K_PLAIN));
        break;
      }
      case 'crossette': {
        const arms = 10;
        sphere(arms, (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(55), 2.4, c1, 8, 1.6, 1.0, 6, K_COMET);
          this.emit[i] = 50 * q; this.phase[i] = 0.75 + r() * 0.25;
        });
        break;
      }
      case 'ring': {
        // A tilted plane through the burst.
        const nx = r() - 0.5, ny = 0.3 + r(), nz = r() - 0.5;
        _v.set(nx, ny, nz).normalize();
        const ux = -_v.z, uz = _v.x, ul = Math.hypot(ux, uz) || 1;
        const ax = ux / ul, az = uz / ul;
        const bx = _v.y * az, by = _v.z * ax - _v.x * az, bz = -_v.y * ax;
        const cnt = n(90);
        for (let k = 0; k < cnt; k++) {
          const a = (k / cnt) * 6.283, ca = Math.cos(a), sa = Math.sin(a);
          this.star(x, y, z, ax * ca + bx * sa, by * sa, az * ca + bz * sa, sp(70), 2.0, c1, 8, 1.3, 1.4, 4, K_PLAIN);
        }
        sphere(n(30), (dx, dy, dz) => this.star(x, y, z, dx, dy, dz, sp(18), 1.4, c2, 6, 1.1, 1.4, 4, K_PLAIN));
        break;
      }
      case 'heart': {
        // Face whoever is watching this screen.
        const cam = this.game.camera.position;
        let fx = cam.x - x, fz = cam.z - z;
        const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
        const rx = -fz, rz = fx;
        const cnt = n(100);
        for (let k = 0; k < cnt; k++) {
          const t = (k / cnt) * 6.283, st = Math.sin(t);
          const hx = 16 * st * st * st / 17, hy = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
          const i = this.star(x, y, z, rx * hx, hy, rz * hx, sp(62), 1.9, PAL[s.c1 === 2 ? 0 : 8], 8, 1.3, 1.5, 2.5, K_PLAIN);
          this.vx[i] = rx * hx * sp(62); this.vy[i] = hy * sp(62); this.vz[i] = rz * hx * sp(62);
        }
        break;
      }
      case 'strobe':
        sphere(n(110), (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(60), 3.2, [1, 1, 1], 10, 1.5, 1.6, 3.5, K_STROBE);
          this.age[i] = -0.4 * r();
        });
        flashI *= 0.8;
        break;
      case 'crackle': {
        sphere(n(110), (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(62), 3, GOLD, 5, 1.0, 1.4, 6, K_CRACKLE);
          this.phase[i] = 0.9 + r() * 0.9; this.emit[i] = 10 * q;
        });
        const core = this.game.audio?.core;
        if (core && core.claim('fwcrackle', 3, 2.5)) {
          const p = core.place(x, y, z, { ref: 50, max: 1600, wet: 0.5 });
          if (p) fwCrackle(core, core.now + p.lag + 0.9, p.in, 1.2, Math.round(70 * sc), r);
        }
        break;
      }
      case 'glitter':
        sphere(n(120), (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(58), 3.8, [1, 0.85, 0.6], 6, 1.0, 1.6, 4.5, K_TWINKLE);
          this.emit[i] = 8 * q;
        });
        break;
      case 'salute':
        // A titanium salute: a white flash, a short hot ring of sparks, and the loudest bang of the night.
        sphere(n(90), (dx, dy, dz) => {
          const i = this.star(x, y, z, dx, dy, dz, sp(95), 0.6, [1, 0.95, 0.85], 14, 1.2, 2.5, 2, K_PLAIN);
          this.stretch[i] = 0.12;
        });
        flashI *= 2.2;
        break;
    }
    // The core flash of the bang itself.
    const fc = s.type === 'willow' || s.type === 'crackle' || s.type === 'palm' ? GOLD : s.type === 'salute' || s.type === 'strobe' ? [1, 1, 1] as [number, number, number] : c1;
    const fi = this.add(x, y, z, 0, 0, 0, 0.18, fc[0] * 0.6 + 0.4, fc[1] * 0.6 + 0.4, fc[2] * 0.6 + 0.4, 10 * flashI, 6 * sc);
    this.kind[fi] = K_POP; this.grav[fi] = 0; this.drag[fi] = 0;
    this.addFlash(x, y, z, fc, flashI);
    this.addGlow(x, y, z, fc, flashI, s.type === 'willow' ? 3.5 : 1.6);
    this.addSmoke(x, y, z, sc, fc);
    const core = this.game.audio?.core;
    if (core && core.claim('fwboom', 6, 0.6)) {
      const p = core.place(x, y, z, { ref: s.local ? 25 : 70, max: 2600, wet: 0.6 });
      if (p) fwBoom(core, core.now + p.lag, p.in, s.type === 'salute' ? 1.6 : sc);
    }
  }

  private stepSparks(dt: number): void {
    const { px, py, pz, vx, vy, vz, age, life, cr, cg, cb, inten, size, drag, grav, stretch, emit, acc, phase, kind, cap } = this;
    const oP = this.aPos.array as Float32Array, oC = this.aCol.array as Float32Array, oV = this.aVel.array as Float32Array;
    const wx = this.windX, wz = this.windZ, r = this.rnd;
    let n = 0;
    if (this.live > 0) {
      let i = this.head;
      for (let k = 0; k < cap; k++, i = i + 1 === cap ? 0 : i + 1) {
        const L = life[i];
        if (L === 0) continue;
        let ag = age[i] + dt;
        const kd = kind[i];
        if (ag >= L) {
          life[i] = 0; this.live--;
          if (kd === K_SHELL) this.burst(phase[i] | 0, px[i], py[i], pz[i]);
          continue;
        }
        age[i] = ag;
        if (ag < 0) continue; // a strobe star not lit yet
        // Drag pulls toward the wind, gravity pulls down.
        const dk = 1 - Math.exp(-drag[i] * dt);
        let x = vx[i], y = vy[i] - grav[i] * dt, z = vz[i];
        x += (wx - x) * dk; y -= y * dk; z += (wz - z) * dk;
        vx[i] = x; vy[i] = y; vz[i] = z;
        const X = px[i] + x * dt, Y = py[i] + y * dt, Z = pz[i] + z * dt;
        px[i] = X; py[i] = Y; pz[i] = Z;
        const f = ag / L;
        // Trails: dim, short-lived sparks left behind, gold-tinted.
        if (emit[i] > 0) {
          let a = acc[i] + emit[i] * dt;
          while (a >= 1) {
            a -= 1;
            const t = this.add(X + (r() - 0.5) * 0.4, Y + (r() - 0.5) * 0.4, Z + (r() - 0.5) * 0.4, x * 0.05 + (r() - 0.5) * 1.5, y * 0.05 + (r() - 0.5) * 1.5, z * 0.05 + (r() - 0.5) * 1.5,
              kd === K_SHELL ? 0.45 : kd === K_TWINKLE ? 1.4 : 0.7,
              cr[i] * 0.4 + 0.6, cg[i] * 0.4 + 0.33, cb[i] * 0.4 + 0.08, kd === K_SHELL ? 2.2 : inten[i] * 0.35 * (1 - f), size[i] * 0.7);
            this.kind[t] = K_TRAIL; this.drag[t] = 2.5; this.grav[t] = 2; this.stretch[t] = 0;
            if (kd === K_TWINKLE) this.kind[t] = K_TWINKLE;
          }
          acc[i] = a;
        }
        if (kd === K_COMET && ag >= phase[i]) {
          // Crossette: the comet splits into a cross of four.
          life[i] = 0; this.live--;
          const sl = Math.hypot(x, y, z) || 1, ux = x / sl, uy = y / sl, uz = z / sl;
          let ax = -uz, ay = 0, az = ux; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
          const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
          for (let c = 0; c < 4; c++) {
            const s0 = c === 0 ? 1 : c === 1 ? -1 : 0, s1 = c === 2 ? 1 : c === 3 ? -1 : 0, v = 34;
            const t = this.add(X, Y, Z, x * 0.4 + (ax * s0 + bx * s1) * v, y * 0.4 + (ay * s0 + by * s1) * v, z * 0.4 + (az * s0 + bz * s1) * v, 1.3,
              cr[i], cg[i], cb[i], 8, 1.2);
            this.emit[t] = 30 * this.q; this.drag[t] = 1.4; this.grav[t] = 6; this.stretch[t] = 0.08;
          }
          continue;
        }
        if (kd === K_CRACKLE && ag >= phase[i]) {
          // Each crackling star ends in a sharp white pop.
          kind[i] = K_POP; life[i] = ag + 0.07; inten[i] = 16; size[i] = 2.2; emit[i] = 0;
          cr[i] = 1; cg[i] = 0.95; cb[i] = 0.85;
          continue;
        }
        // Brightness: white-hot at first, the star's colour within a quarter second, fading out.
        let b = inten[i];
        let rr = cr[i], gg = cg[i], bb = cb[i];
        if (kd !== K_TRAIL && kd !== K_SHELL && ag < 0.25) {
          const w = 1 - ag / 0.25;
          rr += (1 - rr) * w; gg += (1 - gg) * w; bb += (1 - bb) * w;
        }
        if (kd === K_POP) b *= 1 - f;
        else if (kd === K_TRAIL) b *= (1 - f) * (1 - f);
        else {
          const fade = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
          b *= fade * fade;
          if (kd === K_STROBE) b *= Math.sin(ag * 38 + phase[i] * 7) > 0.55 ? 1.6 : 0.03;
          else if (kd === K_TWINKLE) b *= Math.sin(ag * 47 + phase[i] * 13) * Math.sin(ag * 31 + phase[i]) > 0.1 ? 1.5 : 0.25;
        }
        if (b < 0.01) continue;
        const o = n * 4;
        oP[o] = X; oP[o + 1] = Y; oP[o + 2] = Z; oP[o + 3] = size[i];
        oC[o] = rr * b; oC[o + 1] = gg * b; oC[o + 2] = bb * b; oC[o + 3] = 0;
        oV[o] = x; oV[o + 1] = y; oV[o + 2] = z; oV[o + 3] = stretch[i];
        n++;
      }
    }
    // Water glints: the burst's light on the sea, where its reflection would sit for this camera.
    const cam = this.game.camera.position, W = WATER_Y + 0.08;
    for (const gl of this.glows) {
      if (gl.age >= gl.life) continue;
      gl.age += dt;
      if (cam.y <= W + 0.3) continue;
      const my = 2 * W - gl.y, t = (cam.y - W) / (cam.y - my);
      const X = cam.x + (gl.x - cam.x) * t, Z = cam.z + (gl.z - cam.z) * t;
      if (!isWater(X, Z)) continue;
      const d = Math.hypot(X - cam.x, Z - cam.z);
      // Too close and it would fill the screen: a glint is something seen across water.
      const near = Math.min(1, Math.max(0, (d - 30) / 90));
      const k = Math.exp(-gl.age / (gl.life * 0.35)) * gl.i * near * 0.5;
      if (k < 0.01) continue;
      const o = n * 4;
      oP[o] = X; oP[o + 1] = W; oP[o + 2] = Z; oP[o + 3] = 2 + d * 0.025;
      oC[o] = gl.r * k; oC[o + 1] = gl.g * k; oC[o + 2] = gl.b * k; oC[o + 3] = 0;
      // Stretched toward the camera along the water: a long shimmer, as on a real bay.
      oV[o] = 0; oV[o + 1] = 1; oV[o + 2] = 0; oV[o + 3] = d * 0.1;
      n++;
    }
    if (n > this.stats.peak) this.stats.peak = n;
    const vis = n > 0;
    if (vis || this.sparkMesh.visible) {
      this.sparkGeo.instanceCount = n;
      this.sparkMesh.visible = vis;
      if (vis) for (const a of [this.aPos, this.aCol, this.aVel]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    }
  }

  // ── Smoke ──────────────────────────────────────────────────────────────────

  private addSmoke(x: number, y: number, z: number, sc: number, c: [number, number, number]): void {
    const cnt = Math.max(2, Math.round(7 * this.q));
    for (let k = 0; k < cnt; k++) {
      const i = this.shead;
      this.shead = i + 1 === this.scap ? 0 : i + 1;
      if (this.slife[i] === 0) this.slive++;
      const a = this.rnd() * 6.283, rr = this.rnd() * 35 * sc;
      this.sx[i] = x + Math.cos(a) * rr; this.sy[i] = y + (this.rnd() - 0.6) * 30 * sc; this.sz[i] = z + Math.sin(a) * rr;
      this.sage[i] = 0; this.slife[i] = 16 + this.rnd() * 10;
      this.ss0[i] = 14 * sc; this.ss1[i] = 45 * sc;
      this.sr[i] = c[0]; this.sg[i] = c[1]; this.sb[i] = c[2];
    }
  }

  private stepSmoke(dt: number): void {
    if (this.slive === 0) { if (this.smokeMesh.visible) { this.smokeMesh.visible = false; this.smokeGeo.instanceCount = 0; } return; }
    const oP = this.bPos.array as Float32Array, oC = this.bCol.array as Float32Array;
    // Night air lit by the town, from the hemisphere light the sky set this frame.
    const h = this.hemi;
    const amb = h ? h.intensity * 0.18 : 0.05;
    const ar = h ? h.color.r * amb : amb, ag = h ? h.color.g * amb : amb, ab = h ? h.color.b * amb : amb;
    const wx = this.windX * 2.2, wz = this.windZ * 2.2;
    let n = 0;
    for (let i = 0; i < this.scap; i++) {
      const L = this.slife[i];
      if (L === 0) continue;
      const a = this.sage[i] + dt;
      if (a >= L) { this.slife[i] = 0; this.slive--; continue; }
      this.sage[i] = a;
      const X = (this.sx[i] += wx * dt), Y = (this.sy[i] += 0.25 * dt), Z = (this.sz[i] += wz * dt);
      const f = a / L;
      // Lit by its own burst for a moment, then by any burst near it.
      let lr = ar, lg = ag, lb = ab;
      const own = 0.5 * Math.exp(-a * 2.5);
      lr += this.sr[i] * own; lg += this.sg[i] * own; lb += this.sb[i] * own;
      for (const fl of this.flashes) {
        if (fl.i < 0.02) continue;
        const d2 = (fl.x - X) ** 2 + (fl.y - Y) ** 2 + (fl.z - Z) ** 2;
        const k = fl.i * 0.6 / (1 + d2 / 6400);
        lr += fl.r * k; lg += fl.g * k; lb += fl.b * k;
      }
      const o = n * 4;
      oP[o] = X; oP[o + 1] = Y; oP[o + 2] = Z; oP[o + 3] = this.ss0[i] + (this.ss1[i] - this.ss0[i]) * Math.sqrt(f);
      oC[o] = 0.55 * lr; oC[o + 1] = 0.55 * lg; oC[o + 2] = 0.55 * lb;
      oC[o + 3] = 0.16 * Math.min(1, a * 1.5) * (1 - f) * (1 - f);
      n++;
    }
    this.smokeGeo.instanceCount = n;
    this.smokeMesh.visible = n > 0;
    if (n > 0) for (const at of [this.bPos, this.bCol]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * 4); at.needsUpdate = true; }
  }

  // ── Flash on the scene ─────────────────────────────────────────────────────

  private addFlash(x: number, y: number, z: number, c: [number, number, number], i: number): void {
    let best = this.flashes[0];
    for (const f of this.flashes) if (f.i < best.i) best = f;
    best.x = x; best.y = y; best.z = z; best.r = c[0] * 0.5 + 0.5; best.g = c[1] * 0.5 + 0.5; best.b = c[2] * 0.5 + 0.5; best.i = i; best.age = 0;
  }

  private addGlow(x: number, y: number, z: number, c: [number, number, number], i: number, life: number): void {
    let best = this.glows[0];
    for (const g of this.glows) if (g.age / Math.max(g.life, 0.01) > best.age / Math.max(best.life, 0.01)) best = g;
    best.x = x; best.y = y; best.z = z; best.r = c[0]; best.g = c[1]; best.b = c[2]; best.i = 2.2 * i; best.age = 0; best.life = life;
  }

  private stepFlash(dt: number): void {
    const cam = this.game.camera.position;
    let tot = 0, r = 0, g = 0, b = 0;
    for (const f of this.flashes) {
      if (f.i <= 0) continue;
      f.age += dt;
      f.i *= Math.exp(-dt / 0.16);
      if (f.i < 0.01) { f.i = 0; continue; }
      const d = Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z);
      const k = f.i / (1 + (d / 420) ** 2);
      tot += k; r += f.r * k; g += f.g * k; b += f.b * k;
    }
    this.flashLevel = Math.min(tot, 2.5) * (0.35 + 0.65 * (this.game.sky?.night ?? 1));
    if (tot > 0) this.flashCol.setRGB(r / tot, g / tot, b / tot);
  }

  /** Lift the hemisphere light by the flash for this render only, and put it back afterwards. */
  private hookFlash(): void {
    const scene = this.game.scene;
    const sky = this.game.sky as unknown as { hemi?: THREE.HemisphereLight } | undefined;
    this.hemi = sky?.hemi ?? null;
    if (!this.hemi) scene.traverse((o) => { if (!this.hemi && (o as THREE.HemisphereLight).isHemisphereLight) this.hemi = o as THREE.HemisphereLight; });
    const prevB = scene.onBeforeRender, prevA = scene.onAfterRender;
    scene.onBeforeRender = (...args): void => {
      prevB.apply(scene, args);
      const h = this.hemi;
      if (!h || this.flashLevel < 0.01 || this.lifted) return;
      this.lifted = true;
      this.saveI = h.intensity; this.saveSky.copy(h.color); this.saveGnd.copy(h.groundColor);
      const k = this.flashLevel * 1.2;
      _col.copy(this.flashCol).multiplyScalar(k);
      h.color.multiplyScalar(h.intensity).add(_col);
      h.groundColor.multiplyScalar(h.intensity).add(_col);
      h.intensity = 1;
    };
    scene.onAfterRender = (...args): void => {
      prevA.apply(scene, args);
      const h = this.hemi;
      if (!h || !this.lifted) return;
      this.lifted = false;
      h.intensity = this.saveI; h.color.copy(this.saveSky); h.groundColor.copy(this.saveGnd);
    };
  }

  // ── The stall ──────────────────────────────────────────────────────────────

  private buildStall(parent: THREE.Object3D): void {
    const grp = new THREE.Group();
    grp.name = 'fireworks-stall';
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.8 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.6 });
    const counter = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.05, 2.6), wood);
    counter.position.set(0, 0.52, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.5, 2.6), wood);
    back.position.set(0.6, 1.25, 0);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 3.0), red);
    roof.position.set(0.1, 2.55, 0); roof.rotation.z = -0.12;
    // The sign: painted on a canvas, lit after dark.
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
    const c = cv.getContext('2d');
    if (c) {
      c.fillStyle = '#14213d'; c.fillRect(0, 0, 512, 128);
      c.fillStyle = '#f0a202'; c.font = 'bold 54px Georgia, serif'; c.textAlign = 'center';
      c.fillText('PIER-O-TECHNICS', 256, 62);
      c.fillStyle = '#f2e8cf'; c.font = '24px Georgia, serif';
      c.fillText(`FIREWORKS · ${BOX_SHELLS} FOR ${money(BOX_PRICE)} · AIM UP`, 256, 104);
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const signMat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.7 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), signMat);
    sign.position.set(-0.6, 2.15, 0); sign.rotation.y = -Math.PI / 2;
    // A few boxes on the counter, the cheerful kind.
    const boxMat = [0xe4572e, 0x2a9d8f, 0xf0a202].map((hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55 }));
    for (let k = 0; k < 5; k++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24 + (k % 2) * 0.12, 0.28), boxMat[k % 3]);
      b.position.set(-0.1 + (k % 2) * 0.15, 1.17 + (k % 2) * 0.06, -0.9 + k * 0.42);
      grp.add(b);
    }
    grp.add(counter, back, roof, sign);
    grp.position.set(STALL.x + 1.4, 0, STALL.z);
    // The pier deck height at this z (world/plan.ts groundAt reads the deck).
    grp.position.y = groundAt(STALL.x + 1.4, STALL.z);
    grp.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    parent.add(grp);
  }

  private stall(dt: number): void {
    const g = this.game, p = g.player;
    if (!p) return;
    this.told -= dt;
    const d = Math.hypot(p.x - STALL.x, p.z - STALL.z);
    const near = !p.vehicle && d < 3.2 && g.state === 'play';
    if (near) {
      const text = `[G] Buy a box of fireworks (${BOX_SHELLS} shells): ${money(BOX_PRICE)}${this.boxes ? ` · you have ${this.boxes}` : ''}`;
      g.hud.prompt(text); this.prompting = true;
      if (g.input.eat('interact')) {
        if (p.money < BOX_PRICE) { if (this.told <= 0) { this.told = 4; g.hud.toast(`Pier-o-Technics wants ${money(BOX_PRICE)}. They do not take IOUs; IOUs are flammable.`, 4); } }
        else {
          p.money -= BOX_PRICE; this.boxes += BOX_SHELLS;
          g.hud.toast(`A box of ${BOX_SHELLS}. Press L (or the rocket button) to light one where you stand. Point it at the sky, not at Gerald.`, 6);
        }
      }
    } else if (this.prompting) { g.hud.prompt(null); this.prompting = false; }
    this.touchButton();
  }

  /** On a touch screen, a round rocket button while she has fireworks and is on foot. */
  private touchButton(): void {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const want = coarse && this.boxes > 0 && this.game.state === 'play' && !this.game.player.vehicle;
    if (!want) { if (this.btn && this.btn.style.display !== 'none') this.btn.style.display = 'none'; return; }
    if (!this.btn) {
      const b = document.createElement('button');
      b.textContent = 'LIGHT';
      b.setAttribute('aria-label', 'Light a firework');
      Object.assign(b.style, {
        position: 'fixed', right: '18px', top: '42%', width: '56px', height: '56px', borderRadius: '50%', zIndex: '30',
        border: '2px solid rgba(242,232,207,0.8)', background: 'rgba(20,33,61,0.55)', color: '#f2e8cf', fontSize: '12px', fontWeight: 'bold', touchAction: 'none',
      } as Partial<CSSStyleDeclaration>);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.lightOne(); });
      document.body.appendChild(b);
      this.btn = b;
    }
    if (this.btn.style.display === 'none') this.btn.style.display = '';
  }
}
