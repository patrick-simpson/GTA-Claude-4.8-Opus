// Everything that hangs in the air for a moment: tire smoke, dust, sparks,
// chips, spray, steam, fire. One pooled system, two draw calls: an
// alpha-blended pool lit by the sky's key light and fill, and an additive
// pool for what gives off light itself.
//
// Both pools are rings. A new particle takes the slot of the oldest one, so
// a burst can never fail and nothing is allocated after the constructor. All
// state is in typed arrays; update() walks them once, oldest first, and packs
// what is alive straight into the four instance attributes.
//
// The look comes from a small atlas painted once at start-up (four lumpy
// puffs, a droplet, a chip, a foam ring, a spark), a fake sphere normal per
// sprite for the lighting, erosion of the puff's own density as it ages (so
// smoke thins from its edges and holes instead of ghosting out evenly), and a
// soft fade against scene depth where the post pipeline has a depth texture.
//
// The depth texture read is last frame's: the scene target is multisampled,
// so while this frame is being drawn the texture still holds the previous
// resolve. That is one frame stale, harmless for a fade a quarter-meter wide,
// and it is the only way to read it without a second depth pass. It is only
// legal because the target is multisampled; onBeforeRender checks.

import * as THREE from 'three';
import { flip, sendRange } from '../core/flip';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Prop } from '../world/collide';
import { BRIDGE, WATER_Y, groundAt, terrainAt } from '../world/plan';
import { clamp, clamp01, noise2 } from '../core/util';

// ── Atlas ────────────────────────────────────────────────────────────────────

const CELL = 128, COLS = 4, ROWS = 2;
const C_DOT = 4, C_CHIP = 5, C_RING = 6, C_SPARK = 7;

const sstep = (a: number, b: number, v: number): number => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const fbm = (x: number, y: number): number => (noise2(x, y) + 0.5 * noise2(x * 2.03 + 7.1, y * 2.03 + 3.7) + 0.25 * noise2(x * 4.1 + 1.3, y * 4.1 + 9.2)) / 1.75;

/** Red = internal shading detail, green = coverage. The canvas stays opaque so nothing is premultiplied away. */
function paintAtlas(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = CELL * COLS; cv.height = CELL * ROWS;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(cv.width, cv.height);
  const d = img.data;
  let seed = 9173;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Chip outline: an uneven pentagon, as radius per corner.
  const chipR = [0.78, 0.5, 0.86, 0.58, 0.7];

  for (let cell = 0; cell < COLS * ROWS; cell++) {
    const ox = (cell % COLS) * CELL, oy = Math.floor(cell / COLS) * CELL;
    // Puffs: a handful of overlapping lobes, broken up by noise.
    const bx: number[] = [], by: number[] = [], br: number[] = [];
    if (cell < 4) {
      for (let k = 0; k < 9; k++) {
        const a = rnd() * 6.2832, r = k === 0 ? 0 : 0.14 + rnd() * 0.3;
        bx.push(Math.cos(a) * r); by.push(Math.sin(a) * r); br.push(0.2 + rnd() * 0.2);
      }
    }
    const nx = rnd() * 40, ny = rnd() * 40;
    for (let j = 0; j < CELL; j++) for (let i = 0; i < CELL; i++) {
      const x = (i + 0.5) / CELL * 2 - 1, y = (j + 0.5) / CELL * 2 - 1;
      const rc = Math.hypot(x, y);
      let a = 0, det = 1;
      if (cell < 4) {
        let s = 0;
        for (let k = 0; k < 9; k++) { const dx = x - bx[k], dy = y - by[k]; s += Math.exp(-(dx * dx + dy * dy) / (br[k] * br[k])); }
        const n = fbm(x * 3.2 + nx, y * 3.2 + ny);
        a = sstep(0.12, 2.1, s * (0.4 + 1.2 * n)) * (1 - sstep(0.5, 0.97, rc));
        det = clamp01(0.15 + 1.0 * fbm(x * 4.5 + ny, y * 4.5 + nx) + 0.25 * (1 - rc));
      } else if (cell === C_DOT) {
        const k = clamp01(1 - rc * rc); a = k * k;
      } else if (cell === C_CHIP) {
        const ang = (Math.atan2(y, x) + Math.PI) / 6.2832 * 5, i0 = Math.floor(ang) % 5, f = ang - Math.floor(ang);
        const edge = chipR[i0] + (chipR[(i0 + 1) % 5] - chipR[i0]) * f;
        a = 1 - sstep(edge - 0.06, edge, rc);
        det = 0.55 + 0.45 * noise2(x * 6 + nx, y * 6 + ny);
      } else if (cell === C_RING) {
        const ang = Math.atan2(y, x);
        const wob = 0.74 + 0.05 * Math.sin(ang * 5 + nx) + 0.03 * Math.sin(ang * 11 + ny);
        const band = Math.exp(-((rc - wob) * (rc - wob)) / (0.085 * 0.085));
        a = band * clamp01(0.25 + 1.3 * fbm(Math.cos(ang) * 4 + nx, Math.sin(ang) * 4 + ny)) * (1 - sstep(0.9, 0.99, rc));
      } else {
        // Spark: a hot head at +x and a tail thinning to nothing at -x.
        const w = 0.07 + 0.2 * clamp01((x + 1) / 2);
        a = Math.exp(-(y * y) / (w * w)) * sstep(-1, 0.3, x) * (1 - sstep(0.8, 0.99, x));
      }
      const p = ((oy + j) * cv.width + ox + i) * 4;
      d[p] = Math.round(clamp01(det) * 255); d[p + 1] = Math.round(clamp01(a) * 255); d[p + 2] = 0; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const VS = /* glsl */ `
attribute vec4 aPos;   // xyz, size (m)
attribute vec4 aCol;   // rgb (linear albedo, or emitted light in the additive pool), alpha
attribute vec4 aVel;   // xyz: streak vector in world meters (zero for a round sprite); w: rotation
attribute vec4 aMisc;  // atlas cell, heat, erosion, lies flat (1) or faces the camera (0)
uniform float uMaxSize;
varying vec2 vUv;
varying vec2 vOff;
varying vec4 vCol;
varying vec4 vP;       // heat, erosion, view distance, soft-fade depth (0 = none)
varying float vNear;
void main() {
  vec2 q = position.xy * 2.0;
  float size = aPos.w;
  float s = sin(aVel.w), c = cos(aVel.w);
  vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0);
  float soft = 0.0;
  vOff = r;
  vNear = 1.0;
  if (aMisc.w > 0.5) {
    mv = viewMatrix * vec4(aPos.xyz + vec3(r.x, 0.0, r.y) * size * 0.5, 1.0);
    vOff = vec2(0.0, 0.6);
  } else {
    float dist = max(-mv.z, 0.01);
    // Overdraw guard: no sprite may cover more than a set share of the screen,
    // and one that drifts into the lens thins out instead of filling it.
    size = min(size, uMaxSize * dist);
    vNear = smoothstep(0.5, 2.4, dist);
    vec3 sv = (viewMatrix * vec4(aVel.xyz, 0.0)).xyz;
    float sl = length(sv.xy);
    if (sl > 1e-4) {
      vec2 ax = sv.xy / sl;
      // Head at the particle, tail behind it.
      mv.xy += ax * ((q.x - 1.0) * 0.5 * sl + q.x * size * 0.5) + vec2(-ax.y, ax.x) * q.y * size * 0.5;
      vOff = q;
    } else {
      mv.xy += r * size * 0.5;
    }
    soft = size * 0.45;
  }
  float cell = floor(aMisc.x + 0.5);
  vUv = (vec2(mod(cell, ${COLS}.0), floor(cell / ${COLS}.0)) + uv) / vec2(${COLS}.0, ${ROWS}.0);
  vCol = aCol;
  vP = vec4(aMisc.y, aMisc.z, -mv.z, soft);
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
uniform sampler2D map;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uGnd;
uniform vec3 uLightV;
#ifdef SOFT
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform vec2 uNearFar;
uniform float uSoft;
#endif
varying vec2 vUv;
varying vec2 vOff;
varying vec4 vCol;
varying vec4 vP;
varying float vNear;
void main() {
  vec4 t = texture2D(map, vUv);
  // Erosion: the thin parts of the puff go first.
  float a = clamp((t.g - vP.y) / max(1.0 - vP.y, 0.05), 0.0, 1.0) * vCol.a * vNear;
  #ifdef SOFT
  if (vP.w > 0.0 && uSoft > 0.5) {
    float d = texture2D(tDepth, gl_FragCoord.xy / uRes).x;
    float z = uNearFar.x * uNearFar.y / (uNearFar.y - (uNearFar.y - uNearFar.x) * d);
    a *= clamp((z - vP.z) / vP.w, 0.0, 1.0);
  }
  #endif
  if (a < 0.004) discard;
  float fogF = 1.0 - exp(-fogDensity * fogDensity * vP.z * vP.z);
  #ifdef ADD
  vec3 col = vCol.rgb * (0.55 + 0.45 * t.r) * (1.0 - fogF);
  #else
  // A sprite is a flat card; pretend it is a ball so the key light has a side to fall on.
  vec3 n = normalize(vec3(vOff * 0.55, 1.0));
  float wrap = clamp(dot(n, uLightV) * 0.5 + 0.5, 0.0, 1.0);
  vec3 light = uSun * wrap + mix(uGnd, uSky, n.y * 0.5 + 0.5);
  vec3 col = vCol.rgb * light * (0.72 + 0.36 * t.r);
  // Heat: a fireball is smoke that is still glowing.
  col += mix(vec3(1.0, 0.16, 0.015), vec3(1.0, 0.62, 0.22), clamp(vP.x * 0.8 - 0.2, 0.0, 1.0)) * vP.x * 7.0 * (0.12 + 1.5 * t.r * t.r) * t.g;
  col = mix(col, fogColor, fogF);
  #endif
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── Pool ─────────────────────────────────────────────────────────────────────

const NO_FLOOR = -1, STICK = 0, DIE = -2;

class Pool {
  head = 0;
  live = 0;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array;
  /** 0 = free slot. */
  readonly life: Float32Array;
  readonly s0: Float32Array; readonly s1: Float32Array;
  readonly rot: Float32Array; readonly rotV: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array; readonly a: Float32Array;
  /** Per second, toward the wind's velocity times `wind`. */
  readonly drag: Float32Array;
  /** m/s² downward; negative for hot or light things that rise. */
  readonly grav: Float32Array;
  readonly wind: Float32Array;
  readonly floor: Float32Array;
  /** NO_FLOOR, DIE at the floor, STICK to it, or bounces left before sticking. */
  readonly bounce: Int8Array;
  readonly cell: Float32Array;
  readonly heat: Float32Array; readonly heatT: Float32Array;
  /** Seconds to fade in. */
  readonly fin: Float32Array;
  /** Opaque until the last 1/fadeK of life. 1 = straight-line fade. */
  readonly fadeK: Float32Array;
  /** Seconds of travel the sprite is stretched over. */
  readonly streak: Float32Array;
  readonly flat: Float32Array;
  readonly erode: Float32Array;

  readonly aPos: THREE.InstancedBufferAttribute;
  readonly aCol: THREE.InstancedBufferAttribute;
  readonly aVel: THREE.InstancedBufferAttribute;
  readonly aMisc: THREE.InstancedBufferAttribute;
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;

  constructor(readonly cap: number, mat: THREE.ShaderMaterial, order: number) {
    const f = (): Float32Array => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.rot = f(); this.rotV = f();
    this.r = f(); this.g = f(); this.b = f(); this.a = f();
    this.drag = f(); this.grav = f(); this.wind = f(); this.floor = f(); this.bounce = new Int8Array(cap);
    this.cell = f(); this.heat = f(); this.heatT = f(); this.fin = f(); this.fadeK = f(); this.streak = f(); this.flat = f(); this.erode = f();

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (name: string): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, at); flip.geo(this.geo, name);
      return at;
    };
    this.aPos = attr('aPos'); this.aCol = attr('aCol'); this.aVel = attr('aVel'); this.aMisc = attr('aMisc');
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Take the oldest slot. Returns its index so the caller can set whatever is not a default. */
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    r: number, g: number, b: number, a: number): number {
    const i = this.head;
    this.head = i + 1 === this.cap ? 0 : i + 1;
    if (this.life[i] === 0) this.live++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.rot[i] = Math.random() * 6.2832; this.rotV[i] = Math.random() - 0.5;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a[i] = a;
    this.drag[i] = 0; this.grav[i] = 0; this.wind[i] = 0; this.floor[i] = 0; this.bounce[i] = NO_FLOOR;
    this.cell[i] = (Math.random() * 4) | 0; this.heat[i] = 0; this.heatT[i] = 1; this.fin[i] = 0; this.fadeK[i] = 1;
    this.streak[i] = 0; this.flat[i] = 0; this.erode[i] = 0;
    return i;
  }

  /** Integrate, retire, and pack the living into the instance buffers, oldest first so newer smoke draws over older. */
  step(dt: number, wx: number, wz: number): void {
    if (this.live === 0) { if (this.mesh.visible) { this.mesh.visible = false; this.geo.instanceCount = 0; } return; }
    const { px, py, pz, vx, vy, vz, age, life, s0, s1, rot, rotV, r, g, b, a, drag, grav, wind, floor, bounce, cell, heat, heatT, fin, fadeK, streak, flat, erode, cap } = this;
    const oP = this.aPos.array as Float32Array, oC = this.aCol.array as Float32Array, oV = this.aVel.array as Float32Array, oM = this.aMisc.array as Float32Array;
    let n = 0, i = this.head;
    for (let k = 0; k < cap; k++, i = i + 1 === cap ? 0 : i + 1) {
      const L = life[i];
      if (L === 0) continue;
      const ag = age[i] + dt;
      if (ag >= L) { life[i] = 0; this.live--; continue; }
      age[i] = ag;
      const dk = Math.min(drag[i] * dt, 1), w = wind[i];
      let x = vx[i], y = vy[i] - grav[i] * dt, z = vz[i];
      x += (wx * w - x) * dk; y -= y * dk; z += (wz * w - z) * dk;
      let Y = py[i] + y * dt;
      const bn = bounce[i];
      if (bn !== NO_FLOOR && Y < floor[i]) {
        if (bn === DIE) { life[i] = 0; this.live--; continue; }
        Y = floor[i];
        if (bn > 0 && y < -1.2) { y = -y * 0.38; x *= 0.6; z *= 0.6; bounce[i] = bn - 1; }
        else { x = y = z = 0; grav[i] = 0; rotV[i] = 0; bounce[i] = NO_FLOOR; streak[i] = 0; }
      }
      vx[i] = x; vy[i] = y; vz[i] = z;
      const X = (px[i] += x * dt), Z = (pz[i] += z * dt);
      py[i] = Y;
      const ro = (rot[i] += rotV[i] * dt);
      const t = ag / L, u = 1 - t, f = fin[i];
      const al = a[i] * (f > ag ? ag / f : 1) * Math.min(1, u * fadeK[i]);
      const st = streak[i];
      const hT = heatT[i], hk = ag < hT ? 1 - ag / hT : 0;
      const o = n * 4;
      oP[o] = X; oP[o + 1] = Y; oP[o + 2] = Z; oP[o + 3] = s0[i] + (s1[i] - s0[i]) * (1 - u * u);
      oC[o] = r[i]; oC[o + 1] = g[i]; oC[o + 2] = b[i]; oC[o + 3] = al;
      oV[o] = x * st; oV[o + 1] = y * st; oV[o + 2] = z * st; oV[o + 3] = ro;
      oM[o] = cell[i]; oM[o + 1] = heat[i] * hk * hk; oM[o + 2] = t * erode[i]; oM[o + 3] = flat[i];
      n++;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const at of [this.aPos, this.aCol, this.aVel, this.aMisc] as const) {
        sendRange(at, n * 4);
      }
    }
  }
}

// ── The system ───────────────────────────────────────────────────────────────

interface CarFx { smoke: number; dust: number; eng: number; air: number; accel: number; launch: number }
interface Geyser { x: number; y: number; z: number; t: number; acc: number }
/** Returned by fire(): move it by writing x, y, z; call stop() to put it out. */
export interface FireHandle { x: number; y: number; z: number; scale: number; active: boolean; stop(): void }
interface FireSlot extends FireHandle { acc: number }
export interface P3 { x: number; y: number; z: number }

const rnd = Math.random;
const sym = (): number => Math.random() * 2 - 1;
const GEYSER_S = 8;

export class Fx {
  /** The alpha-blended, lit pool and the additive pool. */
  private readonly A: Pool;
  private readonly B: Pool;
  private readonly uni: Record<string, THREE.IUniform>;
  private readonly cars = new WeakMap<Vehicle, CarFx>();
  private readonly geysers: Geyser[] = [];
  private readonly fires: FireSlot[] = [];
  private readonly tmpC = new THREE.Color();
  private readonly low: boolean;
  /** 0..1 share of the full emission rates this quality tier can afford. */
  private readonly rate: number;
  private rainAcc = 0;
  private windX = 0.6;
  private windZ = 0.35;

  /** Everything that can be asked for by name. The M3 ones (muzzleFlash on) are built and tested but nothing calls them yet. */
  readonly emitters = {
    tireSmoke: (x: number, y: number, z: number, vx: number, vz: number, amount: number): void => this.tireSmoke(x, y, z, vx, vz, amount),
    dust: (x: number, y: number, z: number, vx: number, vz: number, amount: number, sand: boolean): void => this.dust(x, y, z, vx, vz, amount, sand),
    /** Snow thrown up: a snowbank burst (n about 20) or a tire's spray (n 1 or 2). fx/snow.ts. */
    powder: (x: number, y: number, z: number, vx: number, vz: number, n: number): void => this.powder(x, y, z, vx, vz, n),
    /** One breath in the cold, from a mouth at (x, y, z) facing (dx, dz). */
    breath: (x: number, y: number, z: number, dx: number, dz: number): void => {
      const i = this.A.add(x + dx * 0.15, y, z + dz * 0.15, dx * 0.5, 0.12, dz * 0.5, 1.1 + rnd() * 0.4, 0.06, 0.42, 0.95, 0.97, 1, 0.2);
      this.A.drag[i] = 2.5; this.A.grav[i] = -0.05; this.A.wind[i] = 1; this.A.fin[i] = 0.1; this.A.erode[i] = 0.5;
    },
    sparks: (x: number, y: number, z: number, dx: number, dy: number, dz: number, n: number, speed: number): void => this.sparks(x, y, z, dx, dy, dz, n, speed),
    debris: (x: number, y: number, z: number, vx: number, vz: number, n: number, color: number, speed: number): void => this.debris(x, y, z, vx, vz, n, color, speed),
    splash: (x: number, z: number, big: boolean): void => this.splash(x, z, big),
    geyser: (x: number, y: number, z: number): void => this.geyser(x, y, z),
    muzzleFlash: (x: number, y: number, z: number, dx: number, dy: number, dz: number): void => this.muzzleFlash(x, y, z, dx, dy, dz),
    tracer: (from: P3, to: P3): void => this.tracer(from, to),
    bulletImpact: (x: number, y: number, z: number, nx: number, ny: number, nz: number): void => this.bulletImpact(x, y, z, nx, ny, nz),
    explosion: (x: number, y: number, z: number, scale = 1): void => this.explosion(x, y, z, scale),
    fire: (x: number, y: number, z: number, scale = 1): FireHandle => this.fire(x, y, z, scale),
  };

  constructor(private game: Game) {
    const q = game.quality;
    this.low = q.name === 'low';
    this.rate = this.low ? 0.4 : q.density;
    // About 4,000 on high. The phone preset gets a fifth of that and nothing that reads depth.
    const capA = this.low ? 600 : Math.round(3000 * q.density), capB = this.low ? 200 : Math.round(1000 * q.density);
    const soft = !this.low && game.post !== null;

    const atlas = paintAtlas();
    this.uni = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      map: { value: atlas }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.4, 4000) },
      uSoft: { value: 0 }, uSun: { value: new THREE.Color() }, uSky: { value: new THREE.Color() }, uGnd: { value: new THREE.Color() },
      uLightV: { value: new THREE.Vector3(0, 1, 0) },
      // Sprite size over distance. 0.42 is about a third of the screen's height at this field of view; phones get less.
      uMaxSize: { value: this.low ? 0.3 : 0.42 },
    };
    const mat = (add: boolean): THREE.ShaderMaterial => new THREE.ShaderMaterial({
      uniforms: this.uni, vertexShader: VS, fragmentShader: FS,
      defines: { ...(add ? { ADD: 1 } : {}), ...(soft ? { SOFT: 1 } : {}) },
      transparent: true, depthWrite: false, fog: true,
      blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // After the water, the old road decals and every lamp glow, before the rain sheet.
    this.A = new Pool(capA, mat(false), 20);
    this.B = new Pool(capB, mat(true), 21);
    game.scene.add(this.A.mesh, this.B.mesh);

    const lightV = this.uni.uLightV.value as THREE.Vector3, res = this.uni.uRes.value as THREE.Vector2, nf = this.uni.uNearFar.value as THREE.Vector2;
    // Uniforms that depend on the camera of the pass actually being drawn.
    this.A.mesh.onBeforeRender = (renderer, _scene, camera): void => {
      lightV.copy(game.sky.lightDir).transformDirection(camera.matrixWorldInverse);
      if (!soft) return;
      const rt = renderer.getRenderTarget();
      const cam = camera as THREE.PerspectiveCamera;
      // Only a multisampled target leaves its depth texture readable while it is being drawn into.
      const ok = rt !== null && rt.samples > 0 && rt.depthTexture !== null;
      this.uni.tDepth.value = ok ? rt.depthTexture : null;
      this.uni.uSoft.value = ok ? 1 : 0;
      if (ok) { res.set(rt.width, rt.height); nf.set(cam.near, cam.far); }
    };

    for (let i = 0; i < 6; i++) this.geysers.push({ x: 0, y: 0, z: 0, t: 0, acc: 0 });
    for (let i = 0; i < 16; i++) {
      const f: FireSlot = { x: 0, y: 0, z: 0, scale: 1, active: false, acc: 0, stop() { this.active = false; } };
      this.fires.push(f);
    }

    game.on('impact', (e) => this.onImpact(e.vehicle, e.speed, e.x, e.z));
    game.on('propBreak', (e) => this.onPropBreak(e.prop, e.vx, e.vz));
    game.on('splash', (e) => this.splash(e.x, e.z, e.big));
  }

  /** Particles alive right now, both pools. */
  get live(): number { return this.A.live + this.B.live; }
  get capacity(): number { return this.A.cap + this.B.cap; }

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (dt <= 0) return;
    // Light: what a Lambert surface would get from the same two lights the scene uses.
    const k = 1 / Math.PI;
    (this.uni.uSun.value as THREE.Color).copy(sky.sun.color).multiplyScalar(sky.sun.intensity * k);
    (this.uni.uSky.value as THREE.Color).copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity * k);
    (this.uni.uGnd.value as THREE.Color).copy(sky.hemi.groundColor).multiplyScalar(sky.hemi.intensity * k);
    this.windX = 0.7 + 0.35 * Math.sin(g.time * 0.13);
    this.windZ = 0.35 + 0.3 * Math.sin(g.time * 0.09 + 1.7);

    const cam = g.camera.position;
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const dx = v.x - cam.x, dz = v.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 > 19600) continue;
      this.car(v, dt, d2);
    }
    // The other players' cars (multiplayer; not in `list`) give off the same things.
    const ghosts = g.vehicles.ghostList;
    for (let i = 0; i < ghosts.length; i++) {
      const v = ghosts[i];
      const dx = v.x - cam.x, dz = v.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 > 19600) continue;
      this.car(v, dt, d2);
    }
    for (const gy of this.geysers) if (gy.t > 0) this.runGeyser(gy, dt);
    for (const f of this.fires) if (f.active) this.runFire(f, dt);
    if (sky.weather === 'rain') this.rain(dt);
    sky.snowfall?.update(dt);

    this.A.step(dt, this.windX, this.windZ);
    this.B.step(dt, this.windX, this.windZ);
  }

  private near(x: number, z: number, r: number): boolean {
    const c = this.game.camera.position, dx = x - c.x, dz = z - c.z;
    return dx * dx + dz * dz < r * r;
  }

  // ── Cars ───────────────────────────────────────────────────────────────────

  private car(v: Vehicle, dt: number, d2: number): void {
    let st = this.cars.get(v);
    if (!st) { st = { smoke: 0, dust: 0, eng: 0, air: 0, accel: 0, launch: 0 }; this.cars.set(v, st); }
    const air = st.air, wasAccel = st.accel;
    st.air = v.airTime; st.accel = v.ctl.accel;
    if (v.sunk || v.y < WATER_Y - 0.05) return;
    // Further off, fewer: the cloud reads the same and costs a third.
    const lod = this.rate * (d2 < 1600 ? 1 : d2 < 6400 ? 0.6 : 0.3);
    const s = Math.sin(v.h), c = Math.cos(v.h), sp = v.spec;
    const v2 = v.vx * v.vx + v.vz * v.vz;
    // Off the paved grid, on the terrain itself (not a deck, not the bridge): sand or turf. Same test the physics uses.
    const soft = v.onGround && (v.x < -610 || v.x > 610 || v.z < -440 || v.z > 410)
      && !(v.z < -430 && Math.abs(v.x - BRIDGE.x) <= BRIDGE.hw + 2) && Math.abs(v.y - terrainAt(v.x, v.z)) < 0.05;
    const rx = v.x - s * sp.wheelbase * 0.5, rz = v.z - c * sp.wheelbase * 0.5, ht = sp.track * 0.5;

    if (v.onGround && air > 0.3) {
      // Landing: the suspension bottoms out and whatever was lying on the surface goes up.
      const n = Math.round((5 + Math.min(air, 1.5) * 12) * lod);
      for (let i = 0; i < n; i++) {
        const fb = i & 1 ? 0.5 : -0.5, side = i & 2 ? 1 : -1;
        const wx = v.x + s * sp.wheelbase * fb - c * ht * side, wz = v.z + c * sp.wheelbase * fb + s * ht * side;
        this.dust(wx, v.y + 0.1, wz, v.vx * 0.3 - c * side * (1 + rnd() * 2), v.vz * 0.3 + s * side * (1 + rnd() * 2), soft ? 1 : 0.5, soft);
      }
    }

    if (v.onGround && !soft && v.slip > 0.35 && v2 > 6) {
      st.smoke += dt * 100 * v.slip * lod;
      let guard = 6;
      while (st.smoke >= 1 && guard-- > 0) {
        st.smoke -= 1;
        const side = rnd() < 0.5 ? 1 : -1;
        this.tireSmoke(rx - c * ht * side, v.y + 0.12, rz + s * ht * side, v.vx, v.vz, v.slip);
      }
      if (st.smoke > 1) st.smoke = 0;
    } else if (soft && v2 > 20) {
      st.dust += dt * 16 * lod * clamp01(v2 / 200 + 0.3);
      while (st.dust >= 1) {
        st.dust -= 1;
        const side = rnd() < 0.5 ? 1 : -1;
        this.dust(rx - c * ht * side, v.y + 0.12, rz + s * ht * side, v.vx * 0.25, v.vz * 0.25, 1, true);
      }
    }

    // Hard launch: a second of rich exhaust out of the back.
    // Not the Bolt: it is electric and has no tailpipe.
    if (v.driver !== null && v.spec.kind !== 'bolt' && v.ctl.accel > 0.9 && wasAccel < 0.5 && Math.abs(v.speed) < 4) st.launch = 0.45;
    if (st.launch > 0) {
      st.launch -= dt;
      if (rnd() < dt * 40 * lod) {
        const side = sp.track * 0.3;
        const i = this.A.add(v.x - s * (v.hl + 0.05) - c * side, v.y + 0.32, v.z - c * (v.hl + 0.05) + s * side,
          v.vx - s * (2 + rnd() * 2) + sym() * 0.4, 0.2 + rnd() * 0.5, v.vz - c * (2 + rnd() * 2) + sym() * 0.4,
          0.7 + rnd() * 0.5, 0.14, 0.75 + rnd() * 0.5, 0.11, 0.11, 0.12, 0.34);
        this.A.drag[i] = 2.6; this.A.grav[i] = -0.6; this.A.wind[i] = 1; this.A.erode[i] = 0.6; this.A.fin[i] = 0.04;
      }
    }

    // A hurt engine: steam first, then oil smoke as it gets worse.
    if (v.health < 50 && d2 < 10000) {
      const bad = v.health < 25;
      st.eng += dt * lod * (6 + (50 - v.health) * 0.3);
      while (st.eng >= 1) {
        st.eng -= 1;
        const tone = bad ? 0.05 + rnd() * 0.04 : 0.82 + rnd() * 0.1;
        const i = this.A.add(v.x + s * v.hl * 0.7 + sym() * 0.25, v.y + sp.height * 0.6, v.z + c * v.hl * 0.7 + sym() * 0.25,
          v.vx * 0.5 + sym() * 0.3, 1 + rnd() * 0.9, v.vz * 0.5 + sym() * 0.3,
          bad ? 2.2 + rnd() * 1.4 : 1.3 + rnd() * 0.8, 0.3, bad ? 2 + rnd() * 1.2 : 1.2 + rnd() * 0.6, tone, tone, tone * 1.03, bad ? 0.5 : 0.2);
        this.A.drag[i] = 0.9; this.A.grav[i] = -0.5; this.A.wind[i] = 1; this.A.erode[i] = 0.55; this.A.fin[i] = 0.12;
      }
    }
  }

  /** One puff of burnt rubber at a wheel. Hangs where it was made and drifts off on the wind. */
  private tireSmoke(x: number, y: number, z: number, vx: number, vz: number, amount: number): void {
    const A = this.A, tone = 0.78 + rnd() * 0.12;
    // A wet road keeps the rubber cool: mostly spray, little smoke.
    const wet = 1 - 0.55 * this.game.sky.wet;
    const i = A.add(x + sym() * 0.15, y + rnd() * 0.1, z + sym() * 0.15, vx * 0.14 + sym() * 0.6, 0.3 + rnd() * 0.55, vz * 0.14 + sym() * 0.6,
      3 + rnd() * 2.2, 0.55 + rnd() * 0.3, 2.8 + rnd() * 1.8, tone, tone, tone * 1.02, (0.13 + 0.1 * rnd()) * clamp01(amount * 1.3) * wet);
    A.drag[i] = 1.5; A.grav[i] = -0.22; A.wind[i] = 1; A.fin[i] = 0.12; A.erode[i] = 0.35; A.fadeK[i] = 1.15;
  }

  private dust(x: number, y: number, z: number, vx: number, vz: number, amount: number, sand: boolean): void {
    const A = this.A, k = 0.85 + rnd() * 0.3;
    const i = A.add(x + sym() * 0.2, y, z + sym() * 0.2, vx + sym() * 0.7, 0.4 + rnd() * 0.7, vz + sym() * 0.7,
      1.5 + rnd() * 1.1, 0.4 + rnd() * 0.2, 1.7 + rnd() * 1.1, (sand ? 0.6 : 0.42) * k, (sand ? 0.5 : 0.4) * k, (sand ? 0.34 : 0.37) * k, (sand ? 0.3 : 0.16) * amount);
    A.drag[i] = 1.8; A.grav[i] = 0.15; A.wind[i] = 1; A.fin[i] = 0.06; A.erode[i] = 0.6;
  }

  private powder(x: number, y: number, z: number, vx: number, vz: number, n: number): void {
    const A = this.A, m = Math.max(1, Math.round(n * this.rate));
    for (let k = 0; k < m; k++) {
      const t = 0.92 + rnd() * 0.08;
      let i = A.add(x + sym() * 1.2, y + rnd() * 0.6, z + sym() * 1.2, vx * (0.3 + rnd() * 0.6) + sym() * 2.2, 1.2 + rnd() * 3, vz * (0.3 + rnd() * 0.6) + sym() * 2.2,
        1.6 + rnd() * 1.6, 0.8 + rnd() * 0.6, 3 + rnd() * 2.5, 0.9 * t, 0.93 * t, 0.98 * t, 0.7 + 0.25 * rnd());
      A.drag[i] = 2.2; A.grav[i] = 0.6; A.wind[i] = 1; A.fin[i] = 0.04; A.erode[i] = 0.4;
      if (n > 3 && rnd() < 0.6) {
        i = A.add(x + sym() * 0.6, y + 0.2 + rnd() * 0.4, z + sym() * 0.6, vx * 0.5 + sym() * 2.5, 2 + rnd() * 3.5, vz * 0.5 + sym() * 2.5,
          0.9 + rnd() * 0.5, 0.09, 0.07, 0.92, 0.95, 1, 0.9);
        A.cell[i] = C_DOT; A.grav[i] = 9.8; A.drag[i] = 0.4;
      }
    }
  }

  // ── Impacts and props ──────────────────────────────────────────────────────

  private onImpact(v: Vehicle, speed: number, x: number, z: number): void {
    if (!this.near(x, z, 160)) return;
    const sp = Math.hypot(v.vx, v.vz) || 1, y = v.y + 0.35 + rnd() * 0.4;
    const k = clamp01(speed / 25);
    // Metal on masonry throws its sparks back along the way the car came, and up.
    this.sparks(x, y, z, -v.vx / sp * 0.5, 0.5, -v.vz / sp * 0.5, Math.round(clamp(speed * 1.8, 6, 46) * this.rate), 4 + speed * 0.3);
    this.debris(x, y, z, v.vx * 0.3, v.vz * 0.3, Math.round(clamp(speed * 0.55, 2, 14) * this.rate), v.color, 2 + speed * 0.2);
    const n = Math.round(k * 6 * this.rate);
    for (let i = 0; i < n; i++) this.dust(x, y, z, v.vx * 0.2 + sym() * 2, v.vz * 0.2 + sym() * 2, 0.9, false);
  }

  /** Bright streaks under gravity that bounce once and die. (dx, dy, dz) biases the spray; it need not be unit length. */
  private sparks(x: number, y: number, z: number, dx: number, dy: number, dz: number, n: number, speed: number): void {
    const B = this.B, floor = Math.max(groundAt(x, z), WATER_Y) + 0.03;
    for (let k = 0; k < n; k++) {
      let ax = sym(), ay = sym(), az = sym();
      const l = Math.hypot(ax, ay, az) || 1, s = speed * (0.35 + rnd() * 0.9);
      ax = (ax / l + dx) * s; ay = (ay / l + dy) * s; az = (az / l + dz) * s;
      const hot = 0.6 + rnd() * 0.8;
      // Iron sparks: near white where they leave, orange as they cool. The alpha fade does the cooling.
      const i = B.add(x, y, z, ax, ay, az, 0.35 + rnd() * 0.75, 0.035 + rnd() * 0.02, 0.02, 16 * hot, 8.5 * hot, 2.6 * hot, 1);
      B.grav[i] = 9.8; B.drag[i] = 0.5; B.bounce[i] = 1; B.floor[i] = floor; B.cell[i] = C_SPARK; B.streak[i] = 0.028; B.fadeK[i] = 1.6; B.rotV[i] = 0;
    }
  }

  /** Solid chips that fly, bounce once and lie where they stop. Half take `color` (sRGB hex), half are dark trim. */
  private debris(x: number, y: number, z: number, vx: number, vz: number, n: number, color: number, speed: number): void {
    const A = this.A, c = this.tmpC.setHex(color), floor = Math.max(groundAt(x, z), WATER_Y) + 0.03;
    for (let k = 0; k < n; k++) {
      const a = rnd() * 6.2832, s = speed * (0.3 + rnd() * 0.9), own = k & 1, sh = 0.7 + rnd() * 0.5;
      const i = A.add(x + sym() * 0.2, y + sym() * 0.2, z + sym() * 0.2, vx + Math.cos(a) * s, 1.5 + rnd() * speed * 0.9, vz + Math.sin(a) * s,
        2.4 + rnd() * 1.6, 0.05 + rnd() * 0.09, 0.05 + rnd() * 0.09, own ? c.r * sh : 0.03, own ? c.g * sh : 0.03, own ? c.b * sh : 0.032, 1);
      A.s1[i] = A.s0[i];
      A.grav[i] = 9.8; A.drag[i] = 0.25; A.bounce[i] = 1; A.floor[i] = floor; A.cell[i] = C_CHIP; A.fadeK[i] = 5; A.rotV[i] = sym() * 14;
    }
  }

  private onPropBreak(p: Prop, vx: number, vz: number): void {
    if (!this.near(p.x, p.z, 160)) return;
    const y = groundAt(p.x, p.z);
    const col = p.kind === 'hydrant' ? 0xb3261e : p.kind === 'bin' ? 0x2f4a3c : p.kind === 'mailbox' ? 0x27457a : p.kind === 'bench' ? 0x7a5230
      : p.kind === 'cone' ? 0xe8601c : p.kind === 'tree' ? 0x4a5d2a : 0x6f7378;
    const sp = Math.hypot(vx, vz);
    this.debris(p.x, y + p.h * 0.5, p.z, vx * 0.45, vz * 0.45, Math.round((8 + Math.min(p.h * 4, 8)) * this.rate), col, 2 + sp * 0.18);
    const n = Math.round(4 * this.rate);
    for (let i = 0; i < n; i++) this.dust(p.x, y + 0.3, p.z, vx * 0.2 + sym() * 1.5, vz * 0.2 + sym() * 1.5, 0.8, false);
    if (p.kind === 'hydrant') this.geyser(p.x, y, p.z);
    else if (p.hard) this.sparks(p.x, y + 0.3, p.z, 0, 0.6, 0, Math.round(10 * this.rate), 5);
  }

  /** A sheared hydrant: about eight seconds of mains pressure. */
  private geyser(x: number, y: number, z: number): void {
    let slot = this.geysers[0];
    for (const g of this.geysers) if (g.t < slot.t) slot = g;
    slot.x = x; slot.y = y; slot.z = z; slot.t = GEYSER_S; slot.acc = 0;
  }

  private runGeyser(g: Geyser, dt: number): void {
    g.t -= dt;
    if (!this.near(g.x, g.z, 220)) return;
    // Full bore at once, then the pressure sags as the main is shut off.
    const p = Math.min(1, (GEYSER_S - g.t) / 0.25) * clamp01(0.25 + g.t / 2.2), A = this.A;
    g.acc += dt * 120 * this.rate;
    while (g.acc >= 1) {
      g.acc -= 1;
      const pick = rnd();
      if (pick < 0.54) {
        // The column: fast, narrow, stretched along its own travel.
        const i = A.add(g.x + sym() * 0.07, g.y + 0.25, g.z + sym() * 0.07, sym() * 0.55, (13 + rnd() * 3.5) * p, sym() * 0.55,
          2.9, 0.38, 1.5 + rnd() * 0.9, 0.86, 0.91, 0.95, 0.42);
        A.grav[i] = 9.8; A.drag[i] = 0.22; A.wind[i] = 1.5; A.bounce[i] = DIE; A.floor[i] = g.y; A.streak[i] = 0.06; A.erode[i] = 0.5; A.fadeK[i] = 1.5;
      } else if (pick < 0.8) {
        // Spray falling out of the column on every side.
        const a = rnd() * 6.2832, s = 0.8 + rnd() * 2.6;
        const i = A.add(g.x, g.y + 0.4 + rnd() * 1.5, g.z, Math.cos(a) * s, (5 + rnd() * 8) * p, Math.sin(a) * s,
          2.6, 0.05 + rnd() * 0.06, 0.05, 0.9, 0.94, 0.97, 0.7);
        A.grav[i] = 9.8; A.drag[i] = 0.3; A.wind[i] = 1; A.bounce[i] = DIE; A.floor[i] = g.y; A.cell[i] = C_DOT; A.streak[i] = 0.03; A.fadeK[i] = 4;
      } else if (pick < 0.96) {
        // Mist hanging around the top half.
        const h = (3 + rnd() * 7) * p;
        const i = A.add(g.x + sym() * 0.8, g.y + h, g.z + sym() * 0.8, sym() * 0.8, -0.4 - rnd(), sym() * 0.8,
          2 + rnd() * 1.5, 1.1, 3.2 + rnd() * 1.8, 0.85, 0.89, 0.93, 0.16);
        A.drag[i] = 0.8; A.grav[i] = 0.6; A.wind[i] = 1; A.fin[i] = 0.3; A.erode[i] = 0.5; A.bounce[i] = DIE; A.floor[i] = g.y - 0.5;
      } else {
        // Where it lands.
        const a = rnd() * 6.2832, r = 0.5 + rnd() * 2.2 * p;
        const i = A.add(g.x + Math.cos(a) * r, g.y + 0.04, g.z + Math.sin(a) * r, 0, 0, 0, 0.5, 0.25, 1.1, 0.9, 0.93, 0.96, 0.3);
        A.cell[i] = C_RING; A.flat[i] = 1; A.rotV[i] = 0;
      }
    }
  }

  // ── Water ──────────────────────────────────────────────────────────────────

  /** Something went into the sea: a column, droplets and a spreading ring of foam. */
  private splash(x: number, z: number, big: boolean): void {
    if (!this.near(x, z, 320)) return;
    const A = this.A, k = big ? 1 : 0.42, y = WATER_Y;
    const nCol = Math.round((big ? 46 : 12) * this.rate), nDrop = Math.round((big ? 60 : 18) * this.rate), nFoam = Math.round((big ? 18 : 6) * this.rate);
    for (let n = 0; n < nCol; n++) {
      const a = rnd() * 6.2832, s = rnd() * 1.5 * k, up = (6 + rnd() * 9) * Math.sqrt(k);
      const i = A.add(x + Math.cos(a) * rnd() * 1.2 * k, y + 0.1, z + Math.sin(a) * rnd() * 1.2 * k, Math.cos(a) * s, up, Math.sin(a) * s,
        1.3 + rnd() * 0.8, 0.5 * k, (1.2 + rnd() * 0.9) * k, 0.86, 0.91, 0.94, 0.45);
      A.grav[i] = 9.8; A.drag[i] = 0.5; A.wind[i] = 1; A.bounce[i] = DIE; A.floor[i] = y - 0.2; A.streak[i] = 0.08; A.erode[i] = 0.5; A.fadeK[i] = 1.5;
    }
    for (let n = 0; n < nDrop; n++) {
      const a = rnd() * 6.2832, s = (1.5 + rnd() * 6) * k, up = (3 + rnd() * 9) * Math.sqrt(k);
      const i = A.add(x, y + 0.2, z, Math.cos(a) * s, up, Math.sin(a) * s, 2.5, 0.05 + rnd() * 0.08, 0.05, 0.9, 0.94, 0.97, 0.8);
      A.grav[i] = 9.8; A.drag[i] = 0.2; A.bounce[i] = DIE; A.floor[i] = y; A.cell[i] = C_DOT; A.streak[i] = 0.03; A.fadeK[i] = 5;
    }
    for (let n = 0; n < 2; n++) {
      const i = A.add(x, y + 0.05 + n * 0.01, z, 0, 0, 0, 2.2 + n * 0.9, 1.2 * k, (8 + n * 5) * k, 0.88, 0.92, 0.94, 0.6 - n * 0.2);
      A.cell[i] = C_RING; A.flat[i] = 1; A.rotV[i] = 0.1; A.fin[i] = 0.1;
    }
    // Churned foam low on the water, spreading with the ring.
    for (let n = 0; n < nFoam; n++) {
      const a = rnd() * 6.2832, s = (1 + rnd() * 2) * k;
      const i = A.add(x + Math.cos(a) * k, y + 0.15, z + Math.sin(a) * k, Math.cos(a) * s, 0.3, Math.sin(a) * s, 1.6 + rnd(), 0.7 * k, 2.4 * k, 0.86, 0.9, 0.93, 0.3);
      A.drag[i] = 1.2; A.erode[i] = 0.6; A.fin[i] = 0.1;
    }
  }

  /** Rain meeting the ground around whatever the camera is looking at. */
  private rain(dt: number): void {
    const A = this.A, f = this.game.cam.focus;
    this.rainAcc += dt * 170 * this.rate * clamp01(this.game.sky.wet * 3 + 0.3);
    while (this.rainAcc >= 1) {
      this.rainAcc -= 1;
      const a = rnd() * 6.2832, r = Math.sqrt(rnd()) * 17;
      const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r, y = Math.max(groundAt(x, z), WATER_Y) + 0.03;
      let i = A.add(x, y, z, 0, 0, 0, 0.2 + rnd() * 0.1, 0.05, 0.26 + rnd() * 0.14, 0.82, 0.86, 0.9, 0.4);
      A.cell[i] = C_RING; A.flat[i] = 1; A.rotV[i] = 0;
      if (rnd() < 0.5) {
        i = A.add(x, y + 0.02, z, sym() * 0.4, 1 + rnd() * 0.8, sym() * 0.4, 0.2, 0.045, 0.03, 0.85, 0.89, 0.93, 0.55);
        A.cell[i] = C_DOT; A.grav[i] = 9.8; A.streak[i] = 0.03;
      }
    }
  }

  // ── Ready for M3: built, checked in a harness, called by nothing yet ───────

  /** At the muzzle, pointing along (dx, dy, dz), unit length. */
  private muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const A = this.A, B = this.B;
    let i = B.add(x + dx * 0.12, y + dy * 0.12, z + dz * 0.12, 0, 0, 0, 0.055, 0.42, 0.2, 22, 15, 6, 1);
    B.cell[i] = C_DOT; B.fadeK[i] = 2;
    for (let k = 0; k < 3; k++) {
      i = B.add(x, y, z, (dx + sym() * 0.25) * 16, (dy + sym() * 0.25) * 16, (dz + sym() * 0.25) * 16, 0.045, 0.09, 0.05, 24, 14, 4, 1);
      B.cell[i] = C_SPARK; B.streak[i] = 0.02; B.rotV[i] = 0;
    }
    i = A.add(x + dx * 0.2, y + dy * 0.2, z + dz * 0.2, dx * 1.6 + sym() * 0.3, dy * 1.6 + 0.4, dz * 1.6 + sym() * 0.3, 0.7 + rnd() * 0.4, 0.1, 0.6, 0.55, 0.55, 0.57, 0.22);
    A.drag[i] = 3; A.wind[i] = 1; A.erode[i] = 0.6;
  }

  /** A bullet's streak from muzzle to target. It travels; the life is the flight time. */
  private tracer(from: P3, to: P3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return;
    const sp = 280, k = sp / d, B = this.B;
    const i = B.add(from.x, from.y, from.z, dx * k, dy * k, dz * k, d / sp, 0.05, 0.05, 14, 10, 4, 1);
    B.cell[i] = C_SPARK; B.streak[i] = Math.min(0.03, d / sp); B.fadeK[i] = 20; B.rotV[i] = 0;
  }

  /** Where a round lands. (nx, ny, nz) is the surface normal. */
  private bulletImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.sparks(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, nx * 0.9, ny * 0.9 + 0.2, nz * 0.9, Math.round(6 * this.rate) + 1, 4.5);
    const A = this.A;
    for (let k = 0; k < 3; k++) {
      const s = 0.8 + rnd() * 1.6, tone = 0.4 + rnd() * 0.15;
      const i = A.add(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * s + sym() * 0.4, ny * s + 0.3 + sym() * 0.4, nz * s + sym() * 0.4,
        0.7 + rnd() * 0.6, 0.1, 0.55 + rnd() * 0.35, tone, tone * 0.97, tone * 0.92, 0.3);
      A.drag[i] = 2.5; A.wind[i] = 1; A.erode[i] = 0.6;
    }
    this.debris(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * 1.5, nz * 1.5, 3, 0x77736b, 1.6);
  }

  /** Flash, a fireball that rolls up and cools into dark smoke, embers, chips. scale 1 is a car's fuel tank. */
  private explosion(x: number, y: number, z: number, scale = 1): void {
    const A = this.A, B = this.B, k = scale, floor = Math.max(groundAt(x, z), WATER_Y) + 0.03;
    let i = B.add(x, y + 0.6 * k, z, 0, 0, 0, 0.11, 5 * k, 9 * k, 20, 14, 7, 1);
    B.cell[i] = C_DOT; B.fadeK[i] = 1.4;
    // The ball: launched outward, stopped by drag within a few meters, then carried up by its own heat.
    const nBall = Math.round(40 * this.rate) + 6;
    for (let n = 0; n < nBall; n++) {
      const a = rnd() * 6.2832, e = rnd() * 1.3, s = (3 + rnd() * 9) * k, ch = Math.cos(e);
      const tone = 0.035 + rnd() * 0.05;
      i = A.add(x + sym() * 0.4 * k, y + 0.4 * k + rnd() * 0.6 * k, z + sym() * 0.4 * k, Math.cos(a) * ch * s, Math.sin(e) * s + 2 * k, Math.sin(a) * ch * s,
        3.6 + rnd() * 2.6, 1.3 * k, (3.4 + rnd() * 2.2) * k, tone, tone, tone, 0.7);
      A.drag[i] = 3.2; A.grav[i] = -1.6 - rnd(); A.wind[i] = 1; A.erode[i] = 0.4; A.fadeK[i] = 1.2;
      A.heat[i] = 1.5 + rnd() * 1.1; A.heatT[i] = 0.8 + rnd() * 0.8; A.rotV[i] = sym() * 1.2;
    }
    // Dust kicked out along the ground.
    const nDust = Math.round(14 * this.rate);
    for (let n = 0; n < nDust; n++) {
      const a = rnd() * 6.2832, s = (6 + rnd() * 6) * k;
      i = A.add(x, floor + 0.3, z, Math.cos(a) * s, 0.4, Math.sin(a) * s, 1.8 + rnd() * 1.2, 0.6 * k, 2.6 * k, 0.4, 0.38, 0.34, 0.3);
      A.drag[i] = 2.2; A.wind[i] = 1; A.erode[i] = 0.6; A.fin[i] = 0.05;
    }
    // Embers: slow to fall, slow to go out.
    const nEmb = Math.round(34 * this.rate);
    for (let n = 0; n < nEmb; n++) {
      const a = rnd() * 6.2832, e = 0.2 + rnd() * 1.2, s = (6 + rnd() * 12) * k, ch = Math.cos(e), hot = 0.5 + rnd() * 0.8;
      i = B.add(x, y + 0.5 * k, z, Math.cos(a) * ch * s, Math.sin(e) * s, Math.sin(a) * ch * s, 1.3 + rnd() * 1.8, 0.05 + rnd() * 0.03, 0.025, 14 * hot, 6 * hot, 1.4 * hot, 1);
      B.grav[i] = 5.5; B.drag[i] = 0.9; B.wind[i] = 1; B.bounce[i] = 1; B.floor[i] = floor; B.cell[i] = C_SPARK; B.streak[i] = 0.03; B.fadeK[i] = 1.5; B.rotV[i] = 0;
    }
    this.debris(x, y + 0.4, z, 0, 0, Math.round(16 * this.rate), 0x2a2a2c, 7 * k);
    this.game.cam.shake(clamp01(0.9 * k * (1 - Math.hypot(x - this.game.cam.focus.x, z - this.game.cam.focus.z) / 90)));
  }

  /** Start a fire that burns until the handle's stop() is called. Move it by writing the handle's x, y, z. */
  private fire(x: number, y: number, z: number, scale = 1): FireHandle {
    let slot = this.fires[0];
    for (const f of this.fires) if (!f.active) { slot = f; break; }
    slot.x = x; slot.y = y; slot.z = z; slot.scale = scale; slot.active = true; slot.acc = 0;
    return slot;
  }

  private runFire(f: FireSlot, dt: number): void {
    if (!this.near(f.x, f.z, 200)) return;
    const A = this.A, B = this.B, k = f.scale;
    f.acc += dt * 70 * this.rate;
    while (f.acc >= 1) {
      f.acc -= 1;
      const pick = rnd();
      if (pick < 0.7) {
        // Flame: tongues that rise fast, narrow and go out.
        const hot = 0.7 + rnd() * 0.6;
        const i = B.add(f.x + sym() * 0.45 * k, f.y + rnd() * 0.25 * k, f.z + sym() * 0.45 * k, sym() * 0.4, (1.8 + rnd() * 1.8) * k, sym() * 0.4,
          0.45 + rnd() * 0.4, (0.85 + rnd() * 0.45) * k, 0.25 * k, 2.3 * hot, 0.72 * hot, 0.06 * hot, 0.6);
        B.grav[i] = -2.5; B.drag[i] = 0.8; B.wind[i] = 1; B.fin[i] = 0.06; B.erode[i] = 0.55; B.rotV[i] = sym() * 2;
      } else if (pick < 0.95) {
        const tone = 0.04 + rnd() * 0.05;
        const i = A.add(f.x + sym() * 0.3 * k, f.y + (0.9 + rnd() * 0.5) * k, f.z + sym() * 0.3 * k, sym() * 0.3, (1.6 + rnd()) * k, sym() * 0.3,
          3 + rnd() * 2.2, 0.6 * k, (2.4 + rnd() * 1.4) * k, tone, tone, tone, 0.5);
        A.grav[i] = -0.9; A.drag[i] = 0.6; A.wind[i] = 1.6; A.fin[i] = 0.35; A.erode[i] = 0.55; A.heat[i] = 0.35; A.heatT[i] = 0.4;
      } else {
        const hot = 0.5 + rnd() * 0.8;
        const i = B.add(f.x + sym() * 0.4 * k, f.y + 0.5 * k, f.z + sym() * 0.4 * k, sym() * 1.2, (2.5 + rnd() * 3) * k, sym() * 1.2,
          1 + rnd() * 1.4, 0.045, 0.02, 14 * hot, 6 * hot, 1.4 * hot, 1);
        B.grav[i] = 1.5; B.drag[i] = 0.7; B.wind[i] = 2; B.cell[i] = C_SPARK; B.streak[i] = 0.03; B.fadeK[i] = 1.5; B.rotV[i] = 0;
      }
    }
  }
}
