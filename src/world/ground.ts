// The ground the whole city stands on: terrain and sea, streets and their paint,
// block slabs with curbs and sidewalks, street lamps, traffic signals, every tree
// and the sidewalk furniture.
//
// Flat ground is a few thousand triangles for the entire island, so it is merged
// into ONE mesh per material rather than per map chunk: chunking it would cost
// far more draw calls than it could ever save in triangles. The things that do
// add up (trees, lamps) are instanced and bucketed by region, so the main pass
// and, more importantly, the shadow pass only draw the ones nearby.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials } from './materials';
import type { Prop, PropKind } from './collide';
import { Batch } from './batch';
import { MARKS, TILE_M } from './textures';
import { signalState } from './signals';
import { RNG, TAU, clamp, hash2, noise2, smooth } from '../core/util';
import {
  AVE_HW, BREAKWATER, BRIDGE, CURB, PIER, RAMPS, SIDEWALK, WATER_Y, XS, ZS,
  groundAt, hwX, hwZ, islandSD, terrainAt, type Block, type District, type Rect,
} from './plan';

// Palette (see PLAN.md).
const INK = 0x1e2b44, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, TEAL = 0x2a9d8f;
const SODIUM = 0xffa63d;

/** Edge of the paved city: the outer curb line of the perimeter streets. */
const XW = XS[0] - hwX(0), XE = XS[XS.length - 1] + hwX(XS.length - 1);
const ZN = ZS[0] - hwZ(0), ZSO = ZS[ZS.length - 1] + hwZ(ZS.length - 1);
const SHOULDER = 2.4;
/** How far in from the curb the poles, trees and furniture stand. */
const STRIP = 0.65;
const REGION = 360;

// Scratch objects for building instance matrices. Build time only.
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
const P = new THREE.Vector3(), S = new THREE.Vector3(), COL = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** Fill the shared matrix M: position, heading, scale, and an optional forward lean. */
function xf(x: number, y: number, z: number, h: number, sx = 1, sy = sx, sz = sx, lean = 0): void {
  E.set(lean, h, 0, 'YXZ');
  M.compose(P.set(x, y, z), Q.setFromEuler(E), S.set(sx, sy, sz));
}

/**
 * Oriented ground quad. From the origin, n runs along heading h and t along its
 * right-hand side. u spans t0..t1 and v spans n0..n1.
 */
function gq(
  b: Batch, ox: number, oz: number, h: number, t0: number, t1: number, n0: number, n1: number, y: number,
  hex: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, shade = 1,
): void {
  const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
  b.quad(
    ox + rx * t0 + fx * n0, y, oz + rz * t0 + fz * n0,
    ox + rx * t1 + fx * n0, y, oz + rz * t1 + fz * n0,
    ox + rx * t1 + fx * n1, y, oz + rz * t1 + fz * n1,
    ox + rx * t0 + fx * n1, y, oz + rz * t0 + fz * n1, hex, u0, v0, u1, v1, shade,
  );
}

/** Axis-aligned floor with world-space UVs, so neighbouring pieces tile into each other. */
function wf(b: Batch, x0: number, z0: number, x1: number, z1: number, y: number, hex: number, tile: number, shade = 1): void {
  if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return;
  b.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, hex, x0 / tile, z1 / tile, x1 / tile, z0 / tile, shade);
}

/** The frame between an outer and an inner rectangle, as up to four strips. */
function ring(a: Rect, b: Rect, fn: (x0: number, z0: number, x1: number, z1: number) => void): void {
  if (b.z0 > a.z0) fn(a.x0, a.z0, a.x1, b.z0);
  if (b.z1 < a.z1) fn(a.x0, b.z1, a.x1, a.z1);
  if (b.x0 > a.x0) fn(a.x0, b.z0, b.x0, b.z1);
  if (b.x1 < a.x1) fn(b.x1, b.z0, a.x1, b.z1);
}

const inset = (r: Rect, road: readonly boolean[], d: number): Rect => ({
  x0: r.x0 + (road[3] ? d : 0), x1: r.x1 - (road[1] ? d : 0),
  z0: r.z0 + (road[0] ? d : 0), z1: r.z1 - (road[2] ? d : 0),
});

/** True on a stunt ramp, within 12 m of one, or in its run-up and landing strip. */
function nearRamp(x: number, z: number): boolean {
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z;
    if (dx * dx + dz * dz < 144) return true;
    const s = Math.sin(r.h), c = Math.cos(r.h);
    const along = dx * s + dz * c, side = Math.abs(dx * -c + dz * s);
    if (along > -45 && along < r.len + 30 && side < r.width / 2 + 3.5) return true;
  }
  return false;
}

/** Spots other builders need empty: ramp runs, the park pond and promenade, the mouths of the bridge, pier and breakwater. */
function keepOut(x: number, z: number): boolean {
  if (nearRamp(x, z)) return true;
  if (z < ZN && Math.abs(x - BRIDGE.x) < BRIDGE.hw + 3) return true;
  if (z > ZSO && x > PIER.x0 - 5 && x < PIER.x1 + 5) return true;
  if (x > XE && z > BREAKWATER.z0 - 4 && z < BREAKWATER.z1 + 4) return true;
  if (x > 84 && x < 306 && z > -216 && z < -24) {
    if (Math.abs(z + 120) < 5.5) return true;
    const ex = (x - 186) / 30, ez = (z + 152) / 22;
    if (ex * ex + ez * ez < 1) return true;
  }
  return false;
}

/** Instances collected first and turned into one InstancedMesh per map region (or one in all when region = 0). */
class Inst {
  private buckets = new Map<number, { m: number[]; c: number[] }>();
  readonly meshes: THREE.InstancedMesh[] = [];
  constructor(private geo: THREE.BufferGeometry, private mat: THREE.Material, private region = 0) {}

  /** Add the matrix currently in M. Returns the instance index inside its bucket. */
  add(x: number, z: number, hex = 0xffffff, shade = 1): number {
    const R = this.region;
    const k = R ? (Math.floor(x / R) + 64) * 256 + Math.floor(z / R) + 64 : 0;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = { m: [], c: [] }));
    const e = M.elements;
    for (let i = 0; i < 16; i++) b.m.push(e[i]);
    COL.setHex(hex);
    b.c.push(COL.r * shade, COL.g * shade, COL.b * shade);
    return b.c.length / 3 - 1;
  }

  build(parent: THREE.Object3D, cast: boolean): void {
    for (const b of this.buckets.values()) {
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, b.c.length / 3);
      mesh.instanceMatrix.array.set(b.m);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.c), 3);
      mesh.castShadow = cast; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      this.meshes.push(mesh);
    }
    this.buckets.clear();
  }
}

// ── Small models ─────────────────────────────────────────────────────────────
// All face +Z and stand on y = 0.

function lampGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 0.2, 0.15, 0.7, INK, 6);
  b.cyl(0, 0.7, 0, 0.1, 0.07, 5.9, INK, 6);
  b.box(0, 6.5, 1.0, 0.09, 0.09, 2.2, INK, 0, 7);
  b.box(0, 6.37, 2.05, 0.46, 0.16, 0.95, INK, 0, 7);
  b.box(0, 6.32, 2.05, 0.32, 0.05, 0.75, 0xf6e7b4, 0, 6);
  return b.toGeometry();
}
const LAMP_REACH = 2.05, LAMP_H = 6.3;

/** Mast with an arm reaching `arm` meters to the model's right (-X), a head hanging from its tip and one on the pole. */
function signalGeo(arm: number): THREE.BufferGeometry {
  const b = new Batch(), body = 0xd9930f;
  b.cyl(0, 0, 0, 0.22, 0.17, 0.6, INK, 6);
  b.cyl(0, 0.6, 0, 0.12, 0.09, 5.6, INK, 6);
  b.box(-arm / 2, 5.95, 0, arm + 0.12, 0.12, 0.12, INK, 0, 7);
  b.box(-arm, HEAD_Y[0], 0, 0.46, 1.25, 0.3, body, 0, 7);
  b.box(0, HEAD_Y[1], 0.24, 0.46, 1.25, 0.3, body, 0, 7);
  return b.toGeometry();
}
const HEAD_Y = [4.8, 2.7], HEAD_Z = [0.165, 0.405];

function hydrantGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 0.21, 0.21, 0.07, 0xb9432a, 6);
  b.cyl(0, 0.07, 0, 0.15, 0.13, 0.5, VERM, 6, false);
  b.cyl(0, 0.57, 0, 0.16, 0.06, 0.16, BONE, 6);
  b.box(0, 0.3, 0, 0.46, 0.11, 0.11, VERM, 0, 7);
  b.box(0, 0.29, 0.13, 0.13, 0.13, 0.12, BONE, 0, 7);
  return b.toGeometry();
}
function binGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 0.27, 0.33, 0.9, TEAL, 8, false);
  b.cyl(0, 0.62, 0, 0.325, 0.335, 0.1, BONE, 8, false);
  b.cyl(0, 0.9, 0, 0.36, 0.36, 0.07, INK, 8);
  return b.toGeometry();
}
function mailboxGeo(): THREE.BufferGeometry {
  const b = new Batch(), blue = 0x27457a;
  b.box(0, 0, 0, 0.42, 0.3, 0.42, 0x16203a, 0, 4);
  b.box(0, 0.3, 0, 0.54, 0.72, 0.5, blue, 0, 5);
  b.box(0, 1.02, 0, 0.54, 0.1, 0.36, blue, 0, 5);
  b.box(0, 0.66, 0.255, 0.4, 0.12, 0.02, BONE, 0, 7);
  return b.toGeometry();
}
function benchGeo(): THREE.BufferGeometry {
  const b = new Batch(), wood = 0xa8744a;
  b.box(-0.7, 0, 0, 0.07, 0.42, 0.5, INK, 0, 5);
  b.box(0.7, 0, 0, 0.07, 0.42, 0.5, INK, 0, 5);
  b.box(0, 0.42, 0.02, 1.7, 0.07, 0.5, wood, 0, 7);
  b.box(0, 0.6, -0.23, 1.7, 0.4, 0.06, wood, 0, 7);
  return b.toGeometry();
}
function postGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 0.05, 0.05, 2.7, INK, 5);
  b.box(0, 2.0, 0.07, 0.52, 0.62, 0.04, MUST, 0, 7);
  b.box(0, 2.4, 0.075, 0.52, 0.12, 0.04, INK, 0, 7);
  return b.toGeometry();
}
function newsGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.box(0, 0, 0, 0.34, 0.14, 0.3, 0x333333, 0, 4);
  b.box(0, 0.14, 0, 0.46, 0.9, 0.4, 0xffffff, 0, 5);
  b.box(0, 0.6, 0.205, 0.34, 0.32, 0.02, 0x2a2a2a, 0, 7);
  return b.toGeometry();
}

/** One canopy mass: a lumpy faceted ball, darker underneath. Tinted per instance. */
function blobGeo(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Keyed on the corner itself, so the copies of a shared corner move together.
    const k = 0.86 + 0.3 * hash2(Math.round(x * 40) + Math.round(z * 40) * 131, Math.round(y * 40));
    p.setXYZ(i, x * k, y * k * 0.94, z * k);
    const sh = 0.66 + 0.34 * smooth(y * 0.5 + 0.55);
    col[i * 3] = sh; col[i * 3 + 1] = sh; col[i * 3 + 2] = sh;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function trunkGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 1, 0.7, 1, 0xffffff, 6, false);
  return b.toGeometry();
}

/** A palm's crown: drooping fronds as bent ribbons, seen from both sides. */
function palmGeo(): THREE.BufferGeometry {
  const b = new Batch(), N = 9;
  const R = [0.15, 1.2, 2.3, 3.1], W = [0.22, 0.42, 0.34, 0.04];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU, cx = Math.cos(a), cz = Math.sin(a);
    // Alternate fronds ride high and hang low so the crown reads as a ball, not a wheel.
    const Y = i % 2 ? [0.1, 0.75, 0.7, 0.0] : [0.0, 0.4, 0.05, -0.95];
    for (let k = 0; k < 3; k++) {
      const x0 = cx * R[k], z0 = cz * R[k], x1 = cx * R[k + 1], z1 = cz * R[k + 1];
      const w0 = W[k], w1 = W[k + 1];
      b.quad(
        x0 + cz * w0, Y[k], z0 - cx * w0, x1 + cz * w1, Y[k + 1], z1 - cx * w1,
        x1 - cz * w1, Y[k + 1], z1 + cx * w1, x0 - cz * w0, Y[k], z0 + cx * w0,
        0xffffff, 0, 0, 1, 1, 1 - k * 0.1,
      );
    }
  }
  b.cyl(0, -0.3, 0, 0.3, 0.2, 0.4, 0xb9a070, 5);
  return b.toGeometry();
}

// ── The sea ──────────────────────────────────────────────────────────────────

const SEA_VERT = /* glsl */ `
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

// islandSD() is plan.ts's coastline, ported, so the shallows and the foam line
// follow the real shore without baking a map. Wave slopes come from the shared
// noise tile: it is mip-mapped, so far water flattens itself instead of sparkling.
const SEA_FRAG = /* glsl */ `
uniform float uTime, uNight;
uniform vec3 uLight, uShallow, uDeep, uShallowN, uDeepN, uFoam, uGlint;
uniform sampler2D uNoise;
varying vec3 vW;
#include <common>
#include <fog_pars_fragment>

float islandSD(vec2 p) {
  p -= vec2(0.0, -5.0);
  vec2 q = abs(p) - vec2(540.0, 365.0);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 140.0;
  float th = atan(p.y, p.x);
  return sd + 13.0 * sin(th * 5.0 + 1.3) + 8.0 * sin(th * 11.0 + 0.4) + 4.0 * sin(th * 23.0);
}
const float E = 1.0 / 256.0;
vec2 slope(vec2 uv) {
  float h = texture2D(uNoise, uv).r;
  return vec2(texture2D(uNoise, uv + vec2(E, 0.0)).r - h, texture2D(uNoise, uv + vec2(0.0, E)).r - h);
}
void main() {
  vec2 p = vW.xz;
  float sd = islandSD(p);
  if (sd < -30.0) discard;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float t = uTime;

  vec2 g = slope(p / 131.0 + t * vec2(0.0045, 0.003))
         + slope(p / 47.0 + t * vec2(-0.011, 0.008)) * 0.75
         + slope(p / 19.0 + t * vec2(0.017, -0.022)) * 0.5;
  vec3 N = normalize(vec3(-g.x * 26.0, 1.0, -g.y * 26.0));

  float off = smoothstep(-8.0, 190.0, sd);
  vec3 col = mix(mix(uShallow, uShallowN, uNight), mix(uDeep, uDeepN, uNight), pow(off, 0.62));
  // Wave faces turned to the light are a shade brighter, the far faces a shade darker.
  col *= 1.0 + clamp((dot(N, uLight) - uLight.y) * 1.5, -0.22, 0.3);

  #ifdef USE_FOG
    vec3 sky = fogColor;
  #else
    vec3 sky = vec3(0.8, 0.88, 0.9);
  #endif
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col = mix(col, sky, fres * 0.5);

  vec3 H = normalize(uLight + V);
  float spec = pow(max(dot(N, H), 0.0), 240.0);
  col += uGlint * smoothstep(0.2, 0.85, spec);

  // Foam: a wobbling line at the waterline (sd is about -5.5 where the sand meets
  // sea level) and a few thin bands rolling in behind it.
  float n = texture2D(uNoise, p / 61.0 + t * 0.004).g;
  float s = sd + 5.5 + (n - 0.5) * 4.0;
  float edge = 1.0 - smoothstep(0.8, 2.8, s + sin(t * 0.6 + n * 6.2832) * 1.1);
  float bands = smoothstep(0.84, 0.97, sin(s * 0.4 - t * 0.75 + n * 9.0) * 0.5 + 0.5) * (1.0 - smoothstep(3.0, 30.0, s));
  float foam = clamp(edge + bands * 0.65, 0.0, 1.0);
  col = mix(col, uFoam * (1.0 - 0.72 * uNight), foam * 0.92);

  // Clear over the sand, opaque once the bottom is out of sight.
  float alpha = max(mix(0.4, 1.0, smoothstep(-6.0, 55.0, sd)), foam);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ── Districts ────────────────────────────────────────────────────────────────

type Surface = 'sidewalk' | 'grass' | 'asphalt' | 'cobble' | 'wood';
/** What a block is paved with inside its sidewalk ring. */
const FILL: Record<District, [Surface, number]> = {
  downtown: ['sidewalk', 0xe6dfcd], midtown: ['sidewalk', 0xcfc8b7], oldtown: ['cobble', 0xffffff],
  suburb: ['grass', 0xf4efc4], industrial: ['asphalt', 0xffffff], port: ['sidewalk', 0xbfb8a8],
  strand: ['wood', 0xffffff], park: ['grass', 0xffffff], arena: ['asphalt', 0xf2f0ea],
};

type Species = 'plane' | 'maple' | 'oak' | 'cypress' | 'palm';
/** Street trees per district: species, spacing along the curb in meters, and how many of the spots are planted. */
const STREET_TREES: Record<District, [Species, number, number]> = {
  downtown: ['plane', 15, 0.85], midtown: ['plane', 14, 0.8], oldtown: ['plane', 21, 0.5],
  suburb: ['maple', 10, 0.9], industrial: ['plane', 40, 0.1], port: ['plane', 40, 0.06],
  strand: ['palm', 13, 0.9], park: ['oak', 12, 0.85], arena: ['plane', 22, 0.5],
};
const LEAF: Record<Species, number[]> = {
  plane: [0x7f9c54, 0x8ca95e, 0x70904f],
  maple: [0x618f49, 0x78a251, 0x517e45, 0xdb962c, 0xc9663b],
  oak: [0x507f46, 0x5e8b4b, 0x437048],
  cypress: [0x355e4b, 0x3f6b55],
  palm: [0x6f9a50, 0x82aa5a],
};

// Furniture kinds, in the order of their instanced meshes.
const HYDRANT = 0, BIN = 1, MAILBOX = 2, BENCH = 3, POST = 4, NEWS = 5;
/** Collision for each: kind, radius, height, breakable. A newspaper box collides (and breaks) like a mailbox. */
const FURN: [PropKind, number, number, boolean][] = [
  ['hydrant', 0.28, 0.75, true], ['bin', 0.38, 1.0, true], ['mailbox', 0.4, 1.15, true],
  ['bench', 0.75, 0.9, false], ['post', 0.14, 2.7, true], ['mailbox', 0.34, 1.05, true],
];
/** Relative odds of each kind, then how full the curb is. */
const FURN_MIX: Record<District, [number[], number]> = {
  downtown: [[1, 2.2, 0.8, 1.6, 0.7, 1.4], 0.62], midtown: [[1, 2, 1, 1.4, 0.6, 1], 0.55],
  oldtown: [[1, 1.6, 0.8, 1.6, 0.3, 0.5], 0.5], suburb: [[1.2, 0.8, 1.2, 0.4, 0.3, 0], 0.3],
  industrial: [[1.2, 1, 0, 0, 0.2, 0], 0.22], port: [[1.2, 1, 0, 0, 0.2, 0], 0.2],
  strand: [[0.8, 2.2, 0.4, 2.6, 0.5, 0.8], 0.65], park: [[0.5, 2, 0, 3, 0.3, 0], 0.5],
  arena: [[1, 2, 0, 1, 0.6, 0.4], 0.4],
};
const NEWS_COLORS = [VERM, MUST, TEAL, 0x27457a];

// Signal lamps: red, yellow, green.
const LIT = [0xff3b24, 0xffc21a, 0x2fe6a2], DIM = [0x3a1410, 0x3a2c0c, 0x0c2e22];

// ── The builder ──────────────────────────────────────────────────────────────

class Ground implements WorldPart {
  private readonly plan: Game['plan'];
  private readonly den: number;
  private readonly root = new THREE.Group();

  private seaU!: Record<string, THREE.IUniform>;
  private poolMat!: THREE.MeshBasicMaterial;
  private haloMat!: THREE.PointsMaterial;
  private readonly glintDay = new THREE.Color(0xfff0c4);
  private readonly glintNight = new THREE.Color(0x8fa6c4);

  /** Occupied spots on the sidewalks, as x, z, r triples in 8 m cells, so nothing is planted inside anything else. */
  private claims = new Map<number, number[]>();

  // One canopy mesh, one trunk mesh and one palm crown serve every species.
  private trunks: Inst; private blobs: Inst; private palms: Inst;
  private lamps: Inst;
  private furn: Inst[];
  private slotKind: number[] = [];
  private slotIdx: number[] = [];
  private slotProp: Prop[] = [];
  private pools = new Batch();
  private halos: number[] = [];

  // Signals: one entry per approach; six lamps each (two heads of three).
  private sigNode: number[] = [];
  private sigHoriz: boolean[] = [];
  private sigLast!: Int8Array;
  private bulbs: THREE.InstancedMesh | null = null;
  private readonly litC = new Float32Array(9);
  private readonly dimC = new Float32Array(9);

  constructor(private game: Game, private mats: CityMaterials, parent: THREE.Group) {
    this.plan = game.plan;
    this.den = clamp(game.quality.density, 0, 1);
    this.root.name = 'ground';
    parent.add(this.root);

    const flat = mats.flat;
    this.trunks = new Inst(trunkGeo(), flat, REGION);
    this.blobs = new Inst(blobGeo(), flat, REGION);
    this.palms = new Inst(palmGeo(), mats.flatDouble, REGION);
    this.lamps = new Inst(lampGeo(), flat, REGION);
    this.furn = [hydrantGeo(), binGeo(), mailboxGeo(), benchGeo(), postGeo(), newsGeo()].map((g) => new Inst(g, flat));

    this.terrain();
    this.sea();
    this.surfaces();
    // Order matters from here: each claims its spots and the next works around them.
    this.signals();
    this.streetLamps();
    this.furniture();
    this.trees();

    this.lamps.build(this.root, true);
    this.trunks.build(this.root, true);
    this.blobs.build(this.root, true);
    this.palms.build(this.root, true);
    // Knee-high props are not worth a place in the shadow pass.
    for (const f of this.furn) f.build(this.root, false);
    this.lights();
    this.claims.clear();

    const earlier = game.col.onBreak;
    game.col.onBreak = (p, vx, vz) => {
      if (p.slot >= 0 && this.slotProp[p.slot] === p) {
        const mesh = this.furn[this.slotKind[p.slot]].meshes[0];
        mesh.setMatrixAt(this.slotIdx[p.slot], ZERO);
        mesh.instanceMatrix.needsUpdate = true;
      }
      earlier?.(p, vx, vz);
      game.emit('propBreak', { prop: p, vx, vz });
    };

    this.setNight(mats.night);
    this.update(0);
  }

  private mesh(b: Batch, mat: THREE.Material, order = 0): void {
    if (b.empty) return;
    const m = new THREE.Mesh(b.toGeometry(), mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.renderOrder = order;
    this.root.add(m);
  }

  private claim(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const a = this.claims.get((i + 512) * 1024 + j + 512);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 3) {
        const dx = a[k] - x, dz = a[k + 1] - z, rr = a[k + 2] + r;
        if (dx * dx + dz * dz < rr * rr) return false;
      }
    }
    const key = (cx + 512) * 1024 + cz + 512;
    let a = this.claims.get(key);
    if (!a) this.claims.set(key, (a = []));
    a.push(x, z, r);
    return true;
  }

  // ── Terrain ────────────────────────────────────────────────────────────────

  private terrain(): void {
    const STEP = 8, X0 = -784, Z0 = -608, NX = 196, NZ = 151;
    const pos = new Float32Array((NX + 1) * (NZ + 1) * 3), col = new Float32Array(pos.length);
    const uv = new Float32Array((NX + 1) * (NZ + 1) * 2), sds = new Float32Array((NX + 1) * (NZ + 1));

    // Tints over the sand texture, by distance from the coast (negative = inland).
    const stops: [number, THREE.Color][] = ([
      [-86, 0x9db074], [-66, 0xc6c98a], [-54, 0xffffff], [-13, 0xf6ecd2], [-6.5, 0xa8936b],
      [2, 0x9fbda0], [26, 0x4f8d86], [80, 0x1c4458],
    ] as [number, number][]).map(([d, hex]) => [d, new THREE.Color(hex)]);
    const dry = new THREE.Color(0xb7b377), lush = new THREE.Color(0x859b5f), c = new THREE.Color();

    let v = 0;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++, v++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP, sd = islandSD(x, z);
        sds[v] = sd;
        // Six centimeters under everything built, so roads and slabs never flicker against it.
        pos[v * 3] = x; pos[v * 3 + 1] = terrainAt(x, z) - 0.06; pos[v * 3 + 2] = z;
        uv[v * 2] = x / TILE_M.sand; uv[v * 2 + 1] = z / TILE_M.sand;

        const n = noise2(x * 0.028 + 9, z * 0.028), n2 = noise2(x * 0.09, z * 0.09 + 31);
        // Ragged bands, and on the south shore the sand runs all the way up to Seawall Dr.
        const s = sd + (n - 0.5) * 16 + 44 * smooth((z - 250) / 150);
        let k = 0;
        while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
        const a = stops[k], b = stops[k + 1];
        c.copy(a[1]).lerp(b[1], smooth((s - a[0]) / (b[0] - a[0])));
        if (s < -60) c.lerp(n2 > 0.5 ? dry : lush, Math.abs(n2 - 0.5) * 1.3 * smooth((-60 - s) / 20));
        const g = 0.94 + 0.12 * n2;
        col[v * 3] = c.r * g; col[v * 3 + 1] = c.g * g; col[v * 3 + 2] = c.b * g;
      }
    }

    const idx: number[] = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP;
        // Nothing shows under the paved city, or beyond where the water turns opaque.
        if (x > XW + 1 && x + STEP < XE - 1 && z > ZN + 1 && z + STEP < ZSO - 1) continue;
        const a = j * (NX + 1) + i, b = a + 1, d = a + NX + 1, e = d + 1;
        if (Math.min(sds[a], sds[b], sds[d], sds[e]) > 70) continue;
        idx.push(d, e, b, d, b, a);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, this.mats.sand);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.root.add(m);
  }

  // ── Sea ────────────────────────────────────────────────────────────────────

  private sea(): void {
    const C = (hex: number): THREE.IUniform => ({ value: new THREE.Color(hex) });
    this.seaU = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uNight: { value: 0 },
      uLight: { value: new THREE.Vector3(0.5, 0.6, 0.62).normalize() },
      uShallow: C(0x43b5a4), uDeep: C(0x17325c), uShallowN: C(0x0c2c36), uDeepN: C(0x050b18),
      uFoam: C(0xf7f0dd), uGlint: { value: new THREE.Color() },
      uNoise: { value: this.mats.tex.noise },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.seaU, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG,
      fog: true, transparent: true, depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(9000, 9000);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = WATER_Y;
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    // Before every other see-through thing, so halos and spray are never painted over by water behind them.
    m.renderOrder = -2;
    m.name = 'sea';
    this.root.add(m);
  }

  // ── Streets, paint and blocks ──────────────────────────────────────────────

  private surfaces(): void {
    const plan = this.plan, mats = this.mats;
    const street = new Batch(), avenue = new Batch(), marks = new Batch(), curb = new Batch();
    const surf: Record<Surface, Batch> = { sidewalk: new Batch(), grass: new Batch(), asphalt: new Batch(), cobble: new Batch(), wood: new Batch() };
    const tile: Record<Surface, number> = { sidewalk: TILE_M.sidewalk, grass: TILE_M.grass, asphalt: TILE_M.asphalt, cobble: TILE_M.cobble, wood: TILE_M.wood };
    const rng = new RNG(5501);
    const PAINT = 0xefe9da;

    for (const e of plan.edges) {
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const from = e.horiz ? A.hx : A.hz, len = e.len - from - (e.horiz ? B.hx : B.hz);
      const b = e.hw === AVE_HW ? avenue : street;
      if (e.horiz) gq(b, A.x + from, A.z, Math.PI / 2, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
      else gq(b, A.x, A.z + from, 0, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
    }

    const cross = mats.tex.marks.rect('crosswalk'), stop = mats.tex.marks.rect('stopline');
    const arrow = mats.tex.marks.rect('arrow'), manhole = mats.tex.marks.rect('manhole'), stain = mats.tex.marks.rect('stain');
    for (const n of plan.nodes) {
      wf(surf.asphalt, n.x - n.hx, n.z - n.hz, n.x + n.hx, n.z + n.hz, 0, 0xffffff, TILE_M.asphalt);
      if (n.hx > 0 && n.hz > 0 && rng.chance(0.7)) {
        const mx = n.x + rng.range(-0.5, 0.5) * n.hx, mz = n.z + rng.range(-0.5, 0.5) * n.hz;
        gq(marks, mx, mz, 0, -0.5, 0.5, -0.5, 0.5, 0, 0xffffff, manhole.u0, manhole.v0, manhole.u1, manhole.v1);
      }
      if (!n.hasLight) continue;
      for (const eid of n.edges) {
        const e = plan.edges[eid];
        // Heading that leaves the intersection along this street.
        const away = e.horiz ? (e.a === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.a === n.id ? 0 : Math.PI);
        const half = e.horiz ? n.hx : n.hz;
        const ox = n.x + Math.sin(away) * half, oz = n.z + Math.cos(away) * half;
        gq(marks, ox, oz, away, -e.hw, e.hw, 0.9, 3.9, 0, PAINT, -e.hw / MARKS.tileM, cross.v0, e.hw / MARKS.tileM, cross.v1);
        // Traffic coming in keeps to its right, which is this frame's left.
        const lanes = e.lanes * 3.5;
        gq(marks, ox, oz, away, -lanes, 0, 4.8, 5.3, 0, PAINT, 0, stop.v0, lanes / MARKS.tileM, stop.v1);
        if (e.lanes === 2) for (const lane of [-1.8, -5.2]) {
          // v is flipped so the arrow points at the intersection.
          gq(marks, ox, oz, away, lane - 0.7, lane + 0.7, 8.5, 11.9, 0, PAINT, arrow.u0, arrow.v1, arrow.u1, arrow.v0);
        }
      }
    }

    const CW = 0.3, STONE = 0xd6cfbe;
    for (const b of plan.blocks) {
      const r = b.rect, road = b.road;
      const r1 = inset(r, road, CW), r2 = inset(r, road, SIDEWALK);
      ring(r, r1, (x0, z0, x1, z1) => curb.floor(x0, z0, x1, z1, CURB, STONE));
      // Curb faces start below the road so no sliver of daylight shows under them.
      const y0 = -0.08;
      if (road[0]) curb.quad(r.x1, y0, r.z0, r.x0, y0, r.z0, r.x0, CURB, r.z0, r.x1, CURB, r.z0, STONE, 0, 0, 1, 1, 0.78);
      if (road[2]) curb.quad(r.x0, y0, r.z1, r.x1, y0, r.z1, r.x1, CURB, r.z1, r.x0, CURB, r.z1, STONE, 0, 0, 1, 1, 0.78);
      if (road[1]) curb.quad(r.x1, y0, r.z1, r.x1, y0, r.z0, r.x1, CURB, r.z0, r.x1, CURB, r.z1, STONE, 0, 0, 1, 1, 0.78);
      if (road[3]) curb.quad(r.x0, y0, r.z0, r.x0, y0, r.z1, r.x0, CURB, r.z1, r.x0, CURB, r.z0, STONE, 0, 0, 1, 1, 0.78);
      ring(r1, r2, (x0, z0, x1, z1) => wf(surf.sidewalk, x0, z0, x1, z1, CURB, 0xffffff, TILE_M.sidewalk));
      const [kind, hex] = FILL[b.district];
      wf(surf[kind], r2.x0, r2.z0, r2.x1, r2.z1, CURB, hex, tile[kind]);

      // Working yards are never clean.
      if (b.district === 'industrial' || b.district === 'port' || b.district === 'arena') {
        for (let k = 0; k < 7; k++) {
          const sx = rng.range(r2.x0 + 6, r2.x1 - 6), sz = rng.range(r2.z0 + 6, r2.z1 - 6), s = rng.range(1.6, 4);
          gq(marks, sx, sz, rng.range(0, TAU), -s, s, -s, s, CURB, 0xffffff, stain.u0, stain.v0, stain.u1, stain.v1);
        }
      }
    }

    // Outside the perimeter streets a flush concrete shoulder finishes the road edge.
    // It stays at street height because groundAt() says the ground out there is 0.
    const sh = 0xe9dfc6, t = TILE_M.sidewalk, sw = surf.sidewalk;
    const bx0 = BRIDGE.x - BRIDGE.hw, bx1 = BRIDGE.x + BRIDGE.hw;
    wf(sw, XW - SHOULDER, ZN - SHOULDER, bx0, ZN, 0, sh, t);
    wf(sw, bx1, ZN - SHOULDER, XE + SHOULDER, ZN, 0, sh, t);
    wf(sw, XW - SHOULDER, ZSO, PIER.x0, ZSO + SHOULDER, 0, sh, t);
    wf(sw, PIER.x1, ZSO, XE + SHOULDER, ZSO + SHOULDER, 0, sh, t);
    wf(sw, XW - SHOULDER, ZN, XW, ZSO, 0, sh, t);
    wf(sw, XE, ZN, XE + SHOULDER, BREAKWATER.z0, 0, sh, t);
    wf(sw, XE, BREAKWATER.z1, XE + SHOULDER, ZSO, 0, sh, t);
    // The three ways off the grid: road to the foot of the bridge, planks to the pier, a causeway to the breakwater.
    const bl = ZN - BRIDGE.z0;
    gq(avenue, BRIDGE.x, ZN, Math.PI, -BRIDGE.hw, BRIDGE.hw, 0, bl, 0, 0xffffff, 0, 0, 1, bl / TILE_M.avenue);
    wf(surf.wood, PIER.x0, ZSO, PIER.x1, PIER.z0, 0, 0xffffff, TILE_M.wood);
    wf(sw, XE, BREAKWATER.z0, BREAKWATER.x0, BREAKWATER.z1, 0, 0xd8d0bc, t);

    this.mesh(street, mats.street);
    this.mesh(avenue, mats.avenue);
    this.mesh(curb, mats.flat);
    this.mesh(surf.sidewalk, mats.sidewalk);
    this.mesh(surf.grass, mats.grass);
    this.mesh(surf.asphalt, mats.asphalt);
    this.mesh(surf.cobble, mats.cobble);
    this.mesh(surf.wood, mats.wood);
    this.mesh(marks, mats.marks);
  }

  // ── Traffic signals ────────────────────────────────────────────────────────

  private signals(): void {
    const plan = this.plan;
    const ARM = [5.0, 7.25];   // street: head over the one lane; avenue: over the line between the two
    const masts = ARM.map((a) => new Inst(signalGeo(a), this.mats.flat));
    const bulbM: number[] = [];

    for (const n of plan.nodes) {
      if (!n.hasLight) continue;
      for (const eid of n.edges) {
        const e = plan.edges[eid];
        // Traffic on this street arriving here travels along heading hd. Its mast stands on
        // the far right corner with the arm reaching back over its lanes, heads facing it.
        const hd = e.horiz ? (e.b === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.b === n.id ? 0 : Math.PI);
        const dx = Math.sin(hd), dz = Math.cos(hd), rx = -dz, rz = dx;
        const along = (e.horiz ? n.hx : n.hz) + 0.75, across = e.hw + 0.75;
        const px = n.x + dx * along + rx * across, pz = n.z + dz * along + rz * across;
        const y = groundAt(px, pz), hs = hd + Math.PI, wide = e.lanes === 2 ? 1 : 0;
        xf(px, y, pz, hs);
        masts[wide].add(px, pz);
        this.claim(px, pz, 1.2);
        this.game.col.addProp(px, pz, 0.2, y + 6.2, 'signal', false);

        // Model space to world: +X is (cos hs, -sin hs), +Z is (sin hs, cos hs).
        const cs = Math.cos(hs), sn = Math.sin(hs);
        for (let head = 0; head < 2; head++) {
          const lx = head === 0 ? -ARM[wide] : 0, lz = HEAD_Z[head];
          for (let l = 0; l < 3; l++) {
            xf(px + lx * cs + lz * sn, y + HEAD_Y[head] + 1.0 - l * 0.375, pz - lx * sn + lz * cs, hs);
            for (let k = 0; k < 16; k++) bulbM.push(M.elements[k]);
          }
        }
        this.sigNode.push(n.id);
        this.sigHoriz.push(e.horiz);
      }
    }
    for (const m of masts) m.build(this.root, true);

    const count = this.sigNode.length;
    this.sigLast = new Int8Array(count).fill(-1);
    for (let l = 0; l < 3; l++) {
      COL.setHex(LIT[l]).toArray(this.litC, l * 3);
      COL.setHex(DIM[l]).toArray(this.dimC, l * 3);
    }
    if (!count) return;
    // Unlit material: a signal lamp is its own light, day or night.
    const bulbs = new THREE.InstancedMesh(new THREE.CircleGeometry(0.15, 6), new THREE.MeshBasicMaterial({ fog: true }), count * 6);
    bulbs.instanceMatrix.array.set(bulbM);
    bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 18), 3);
    bulbs.matrixAutoUpdate = false;
    this.root.add(bulbs);
    this.bulbs = bulbs;
  }

  // ── Street lamps ───────────────────────────────────────────────────────────

  private streetLamps(): void {
    const plan = this.plan;
    for (const e of plan.edges) {
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const s0 = (e.horiz ? A.hx : A.hz) + 9, s1 = e.len - (e.horiz ? B.hx : B.hz) - 9;
      const count = Math.max(2, Math.round((s1 - s0) / 32) + 1);
      for (let k = 0; k < count; k++) {
        const s = s0 + ((s1 - s0) * k) / (count - 1);
        const side = (k + e.id) % 2 ? 1 : -1, off = side * (e.hw + STRIP);
        const x = e.horiz ? A.x + s : A.x + off, z = e.horiz ? A.z + off : A.z + s;
        // The arm points back at the middle of the road.
        const h = e.horiz ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        if (keepOut(x, z) || !this.claim(x, z, 1.0)) continue;
        this.lamp(x, z, h);
      }
    }
  }

  private lamp(x: number, z: number, h: number): void {
    const y = groundAt(x, z);
    xf(x, y, z, h);
    this.lamps.add(x, z);
    this.game.col.addProp(x, z, 0.18, y + 6.5, 'lamp', false);
    const fx = Math.sin(h), fz = Math.cos(h);
    this.halos.push(x + fx * LAMP_REACH, y + LAMP_H, z + fz * LAMP_REACH);
    // The pool of light is centered under the head and cut at the curb line: the part on the
    // road lies on the road, the part behind lies on the sidewalk, and the UVs keep it one disc.
    const R = 9, n0 = LAMP_REACH - R, n1 = LAMP_REACH + R, cut = (STRIP - n0) / (n1 - n0);
    gq(this.pools, x, z, h, -R, R, STRIP, n1, 0, SODIUM, 0, cut, 1, 1, 0.5);
    gq(this.pools, x, z, h, -R, R, n0, STRIP, y, SODIUM, 0, 0, 1, cut, 0.5);
  }

  /** Light pools and halos: both invisible by day, faded in by setNight. */
  private lights(): void {
    // The shared glow material has no polygon offset, and a pool has to lie exactly on the road.
    this.poolMat = this.mats.glow.clone();
    this.poolMat.polygonOffset = true;
    this.poolMat.polygonOffsetFactor = -3;
    this.poolMat.polygonOffsetUnits = -6;
    if (!this.pools.empty) {
      const m = new THREE.Mesh(this.pools.toGeometry(), this.poolMat);
      m.matrixAutoUpdate = false;
      m.renderOrder = 1;
      this.root.add(m);
    }
    // True billboards for the price of one draw call. Not fogged: far lamps prick through the haze.
    this.haloMat = new THREE.PointsMaterial({
      map: this.mats.tex.glow, color: SODIUM, size: 7.5, sizeAttenuation: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.halos, 3));
    const pts = new THREE.Points(g, this.haloMat);
    pts.matrixAutoUpdate = false;
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    this.root.add(pts);
    this.halos = [];
    this.pools = new Batch();
  }

  // ── Sidewalk furniture ─────────────────────────────────────────────────────

  /** Walk the curb strip of every street-facing side of a block. `inward` is the heading from the curb into the block. */
  private eachSide(b: Block, fn: (len: number, at: (s: number, d: number) => [number, number], inward: number, avenue: boolean) => void): void {
    const r = b.rect;
    for (let side = 0; side < 4; side++) {
      if (!b.road[side]) continue;
      const ew = side % 2 === 0;
      const len = ew ? r.x1 - r.x0 : r.z1 - r.z0;
      const inward = [0, -Math.PI / 2, Math.PI, Math.PI / 2][side];
      const avenue = (side === 0 ? hwZ(b.j) : side === 2 ? hwZ(b.j + 1) : side === 1 ? hwX(b.i + 1) : hwX(b.i)) === AVE_HW;
      fn(len, (s, d) => [
        ew ? r.x0 + s : side === 1 ? r.x1 - d : r.x0 + d,
        ew ? (side === 0 ? r.z0 + d : r.z1 - d) : r.z0 + s,
      ], inward, avenue);
    }
  }

  private furniture(): void {
    const rng = new RNG(7310), col = this.game.col;
    for (const b of this.plan.blocks) {
      const [odds, fill] = FURN_MIX[b.district];
      const total = odds.reduce((a, v) => a + v, 0);
      this.eachSide(b, (len, at, inward, avenue) => {
        let busStop = false;
        for (let s = rng.range(6, 11); s < len - 6; s += rng.range(7, 12)) {
          // Every number is drawn whether or not the spot is used, so a lower
          // density thins the street out without rearranging it.
          let pick = rng.next() * total, kind = 0;
          while (kind < odds.length - 1 && pick > odds[kind]) pick -= odds[kind++];
          const keep = rng.next() < fill * this.den, tint = rng.pick(NEWS_COLORS), turn = rng.range(-0.12, 0.12);
          if (kind === POST && (busStop || !avenue)) kind = BIN;
          if (!keep) continue;
          const [x, z] = at(s, STRIP);
          const [pk, pr, ph, breakable] = FURN[kind];
          if (keepOut(x, z) || !this.claim(x, z, pr + 0.5)) continue;
          if (kind === POST) busStop = true;
          const y = groundAt(x, z);
          xf(x, y, z, inward + turn);
          const i = this.furn[kind].add(x, z, kind === NEWS ? tint : 0xffffff);
          const slot = this.slotProp.length;
          this.slotKind.push(kind); this.slotIdx.push(i);
          this.slotProp.push(col.addProp(x, z, pr, y + ph, pk, breakable, slot));
        }
      });
    }
  }

  // ── Trees ──────────────────────────────────────────────────────────────────

  private trees(): void {
    const plan = this.plan, den = this.den;
    const rng = new RNG(9127);

    // Street trees, in the curb strip between the lamps and the furniture.
    for (const b of plan.blocks) {
      const [species, gap, share] = STREET_TREES[b.district];
      this.eachSide(b, (len, at) => {
        for (let s = gap * 0.5; s < len - 4; s += gap) {
          const j = rng.range(-1.5, 1.5), keep = rng.next() < share && rng.next() < den, alt = rng.next();
          if (!keep) continue;
          const [x, z] = at(s + j, STRIP + 0.2);
          const sp = species === 'maple' && alt < 0.12 ? 'cypress' : species;
          if (!keepOut(x, z) && this.claim(x, z, 1.7)) this.tree(sp, x, z, rng);
        }
      });
    }

    // Gull Heights: a tree wherever back yards meet. A lot corner is the one spot a house cannot be standing on.
    for (const lot of plan.lots) {
      if (lot.district !== 'suburb') continue;
      const r = lot.rect;
      for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) {
        const keep = rng.next() < 0.85 * den, alt = rng.next();
        if (keep && !keepOut(x, z) && this.claim(x, z, 3.5)) this.tree(alt < 0.2 ? 'cypress' : alt < 0.55 ? 'oak' : 'maple', x, z, rng);
      }
    }

    // Mercy Park: clumps on a jittered grid, thicker toward the edges, clear of the pond, the promenade and the ramp run.
    const G = 11;
    for (let x = 96; x < 292; x += G) for (let z = -206; z < -34; z += G) {
      const px = x + rng.range(0, G - 2), pz = z + rng.range(0, G - 2), roll = rng.next(), alt = rng.next();
      const edge = Math.min(px - 90, 296 - px, pz + 210, -30 - pz);
      const want = (0.2 + 0.55 * smooth(noise2(px * 0.045, pz * 0.045) * 1.6 - 0.3) + 0.3 * smooth(1 - edge / 26)) * den;
      if (roll > want || keepOut(px, pz) || !this.claim(px, pz, 3.2)) continue;
      this.tree(alt < 0.16 ? 'cypress' : alt < 0.4 ? 'maple' : 'oak', px, pz, rng);
    }

    // Low Tide Beach: a row of palms along the Seawall Dr shoulder, and loose pairs further down the sand.
    for (let x = -350; x < 304; x += 16) {
      const px = x + rng.range(-3, 3), keep = rng.next() < den, pair = rng.next() < 0.22 * den, ox = rng.range(-8, 8), oz = rng.range(20, 36);
      if (keep && !keepOut(px, ZSO + 4.4) && islandSD(px, ZSO + 4.4) < -40) this.tree('palm', px, ZSO + 4.4, rng);
      if (pair && !keepOut(px + ox, ZSO + oz) && islandSD(px + ox, ZSO + oz) < -34) {
        this.tree('palm', px + ox, ZSO + oz, rng);
        if (!keepOut(px + ox + 3.5, ZSO + oz + 2.5)) this.tree('palm', px + ox + 3.5, ZSO + oz + 2.5, rng);
      }
    }

    // The scrub between the outer streets and the dunes: scattered and wind-bent, none on the beach or the port's waterfront.
    for (let x = -712; x < 712; x += 26) for (let z = -548; z < ZSO; z += 26) {
      const px = x + rng.range(0, 20), pz = z + rng.range(0, 20), roll = rng.next(), alt = rng.next();
      const outside = px < XW - 9 || px > XE + 9 || pz < ZN - 9;
      if (!outside || roll > 0.5 * den || (px > XE && pz > 150) || islandSD(px, pz) > -66 || keepOut(px, pz)) continue;
      this.tree(alt < 0.45 ? 'cypress' : alt < 0.75 ? 'oak' : 'maple', px, pz, rng);
    }
  }

  private tree(sp: Species, x: number, z: number, rng: RNG): void {
    // Sunk a hand's width so no trunk hovers over the terrain's six-centimeter drop.
    const y = groundAt(x, z) - 0.1, k = rng.range(0.85, 1.18), leaf = LEAF[sp];
    const blob = (dx: number, dy: number, dz: number, r: number, ry: number, hex: number): void => {
      xf(x + dx, y + dy, z + dz, rng.range(0, TAU), r, ry, r);
      this.blobs.add(x, z, hex, rng.range(0.9, 1.08));
    };
    let th = 3, tr = 0.25, bark = 0x6b4a36;
    const a = rng.range(0, TAU), ax = Math.cos(a), az = Math.sin(a);
    if (sp === 'palm') {
      th = rng.range(6.5, 9.5); tr = 0.2; bark = 0xa08a6a;
      const h = rng.range(0, TAU), lean = rng.range(0.02, 0.11);
      xf(x, y, z, h, tr, th, tr, lean);
      this.trunks.add(x, z, bark);
      // Top of the leaning trunk.
      const top = th * Math.sin(lean);
      xf(x + Math.sin(h) * top, y + th * Math.cos(lean), z + Math.cos(h) * top, rng.range(0, TAU), k, k, k, lean);
      this.palms.add(x, z, rng.pick(leaf), rng.range(0.9, 1.05));
    } else if (sp === 'cypress') {
      th = 1.4; tr = 0.2; bark = 0x5a4334;
      const hex = rng.pick(leaf);
      blob(0, 1.0 + 3.6 * k, 0, 1.15 * k, 3.9 * k, hex);
      blob(0, 1.0 + 6.2 * k, 0, 0.7 * k, 2.2 * k, hex);
    } else if (sp === 'plane') {
      th = rng.range(3.3, 4.1); tr = 0.2; bark = 0xb0a488;
      blob(0, th + 1.2 * k, 0, 2.1 * k, 1.7 * k, rng.pick(leaf));
      blob(ax * 0.9, th + 2.2 * k, az * 0.9, 1.5 * k, 1.3 * k, rng.pick(leaf));
    } else if (sp === 'maple') {
      th = rng.range(2.5, 3.3); tr = 0.25;
      // One tree in seven has turned early, mustard or rust, top to bottom.
      const hex = rng.chance(0.14) ? leaf[rng.int(3, 4)] : leaf[rng.int(0, 2)];
      blob(0, th + 1.5 * k, 0, 2.6 * k, 2.1 * k, hex);
      blob(ax * 1.5, th + 1.9 * k, az * 1.5, 1.8 * k, 1.5 * k, hex);
      blob(-ax * 1.2, th + 2.7 * k, -az * 1.2, 1.7 * k, 1.4 * k, hex);
    } else {
      th = rng.range(3.2, 4.3); tr = 0.36; bark = 0x5a4334;
      blob(0, th + 1.9 * k, 0, 3.3 * k, 2.5 * k, rng.pick(leaf));
      blob(ax * 2.1, th + 2.3 * k, az * 2.1, 2.4 * k, 1.9 * k, rng.pick(leaf));
      blob(-ax * 1.7, th + 3.3 * k, -az * 1.7, 2.2 * k, 1.8 * k, rng.pick(leaf));
    }
    if (sp !== 'palm') {
      // The trunk runs a little way into the canopy so no gap opens between them.
      xf(x, y, z, a, tr, th + 0.9, tr);
      this.trunks.add(x, z, bark);
    }
    this.game.col.addProp(x, z, tr + 0.08, y + 8, 'tree', false);
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const u = this.seaU;
    u.uTime.value += dt;
    // The sky is built after the world, so it may not be there yet.
    const light = this.game.sky?.lightDir;
    if (light) (u.uLight.value as THREE.Vector3).copy(light);

    const bulbs = this.bulbs;
    if (!bulbs) return;
    const nodes = this.plan.nodes, time = this.game.time, last = this.sigLast;
    const c = bulbs.instanceColor!.array as Float32Array;
    let changed = false;
    for (let a = 0; a < last.length; a++) {
      const st = signalState(nodes[this.sigNode[a]], this.sigHoriz[a], time);
      const on = st === 'red' ? 0 : st === 'yellow' ? 1 : 2;
      if (on === last[a]) continue;
      last[a] = on;
      changed = true;
      for (let k = 0; k < 6; k++) {
        const l = k % 3, src = l === on ? this.litC : this.dimC, o = (a * 6 + k) * 3;
        c[o] = src[l * 3]; c[o + 1] = src[l * 3 + 1]; c[o + 2] = src[l * 3 + 2];
      }
    }
    if (changed) bulbs.instanceColor!.needsUpdate = true;
  }

  setNight(n: number): void {
    const u = this.seaU;
    u.uNight.value = n;
    // Warm and strong under the sun, pale and thin under the moon.
    (u.uGlint.value as THREE.Color).copy(this.glintDay).lerp(this.glintNight, n).multiplyScalar(0.95 - 0.5 * n);
    const glow = smooth(n * 1.2), on = n > 0.01;
    this.poolMat.opacity = glow; this.poolMat.visible = on;
    this.haloMat.opacity = glow; this.haloMat.visible = on;
  }
}

export function buildGround(game: Game, mats: CityMaterials, parent: THREE.Group): WorldPart {
  return new Ground(game, mats, parent);
}
