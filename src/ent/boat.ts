// Boats you can drive: the Riptide 21 runabout and the Skeeter jet ski, moored at the dock on the east side of
// Pelican Pier, and three floating jump ramps out in the harbour.
//
// A boat is a Vehicle (core/api.ts) like any car, so the player's seat, the chase camera, the HUD, the engine sound
// (audio/vehicles.ts ENGINES) and the network's player state all take it as they find it; but it is not one of
// game.vehicles' cars. This file moves it, and ent/player.ts boards and leaves it (Player.boats).
//
// The physics, sub-stepped at 1/120 s:
//   * Buoyancy from five points on the hull bottom (bow, two at the chines amidships, two at the transom), each
//     sampling the sea's height (world/sea.ts: the swell the water shader draws). A point pushes up in proportion to
//     how deep it is, so the hull heaves, pitches and rolls to the waves on its own, and leaves the water when a
//     crest drops away under it faster than it can fall.
//   * Planing: past about a third of top speed the hull rises (it needs less of itself in the water) and its drag
//     falls; around the hump the bow lifts hard, then settles on the plane. Lift and the lean into a turn are
//     added to the water the points see, so buoyancy itself holds the boat at those angles.
//   * Thrust only while the stern is wet; steering only while it is too. Sideways slip dies at the hull's grip.
//   * Capsize-proof but tippable: roll and pitch run free to about 35 degrees, then a hard stop brings them back.
//   * The seabed is solid: in the shallows the hull grinds to a halt (beached), and a boat cannot reach dry land.
//   * Ramps are wedges riding the water: on one, the hull follows its face and leaves the top with the speed it had.
//
// Effects: spray off the bow and a rooster tail at speed (fx/particles.ts spray), a foam wake strip on the water
// behind each boat (one dynamic ribbon each, registered with core/flip), and a splash on landing.
//
// Models: public/models/boats.glb (tools/blender/boats.py: <kind>_LOD0..2 and ramp_LOD0..1), or boats_far.glb on
// the phone preset (the far levels alone). Until a file is in, simple stand-in shapes are drawn.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vehicle, VehicleControls } from '../core/api';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { flip } from '../core/flip';
import { WATER_Y, groundAt } from '../world/plan';
import { seaClock, seaSlope, seaY } from '../world/sea';
import { waterLevelAt } from '../world/mainland';
import { SPECS, type VehicleKind, type VehicleSpec } from './vehicleSpecs';

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const G = 9.81;
const STEP = 1 / 120;

export type BoatKind = 'speedboat' | 'jetski';

interface Hull {
  /** Buoyancy points [across (+ = left), along (+ = forward)], meters from the middle of the hull. */
  pts: readonly (readonly [number, number])[];
  /** How deep the hull sits at rest, meters below its y. */
  draft: number;
  /** Seats [across, along, up]: the point on the cushion under a sitter's hips, the driver's first (tools/blender/boats.py's seats). */
  seats: readonly (readonly [number, number, number])[];
  /** Turn rate at full lock, rad/s. */
  turn: number;
  /** Lean into a turn per (rad/s x m/s), and its limit. */
  lean: number; leanMax: number;
  /** Peak bow lift at the hump, radians. */
  bow: number;
  /** Spray size. */
  spray: number;
  /** The points' mean `along`: pitch turns about it. */
  azm: number;
}

const HULLS: Record<BoatKind, Hull> = {
  speedboat: {
    pts: [[0, 2.75], [0.98, 0.4], [-0.98, 0.4], [0.85, -2.85], [-0.85, -2.85]],
    draft: 0.34,
    seats: [[0.48, -0.36, 0.46], [-0.48, -0.36, 0.46], [0.5, -1.85, 0.53], [-0.2, -1.85, 0.53]],
    turn: 0.95, lean: 0.03, leanMax: 0.38, bow: 0.13, spray: 1.3, azm: -0.43,
  },
  jetski: {
    pts: [[0, 1.4], [0.5, 0.1], [-0.5, 0.1], [0.42, -1.4], [-0.42, -1.4]],
    draft: 0.24,
    seats: [[0, -0.5, 0.7], [0, -0.98, 0.73]],
    turn: 1.6, lean: 0.055, leanMax: 0.6, bow: 0.1, spray: 0.85, azm: -0.24,
  },
};

/** The dock on the east side of Pelican Pier (x 9 is the pier's edge). The boats lie bow to the sea. */
export const DOCK = { x: 10.5, z0: 520, z1: 600, y: WATER_Y + 0.42, w: 3 };
const HOMES: Record<BoatKind, { x: number; z: number; h: number }> = {
  speedboat: { x: DOCK.x + DOCK.w / 2 + 1.55, z: 566, h: 0 },
  jetski: { x: DOCK.x + DOCK.w / 2 + 0.95, z: 544, h: 0 },
};

/** Floating jump ramps in the harbour, either side of the pier and off its head. h is the way you ride up them. */
interface Ramp { x: number; z: number; h: number; len: number; w: number; tall: number; y: number; obj: THREE.Object3D }
const RAMP_SPOTS: readonly { x: number; z: number; h: number }[] = [
  { x: 70, z: 640, h: Math.PI / 2 },
  { x: -75, z: 650, h: -Math.PI / 2 },
  { x: 30, z: 760, h: 0.35 },
];
const RAMP_LEN = 9, RAMP_W = 5.2, RAMP_TALL = 1.9;

/** The water's surface at a point: the swell on the open sea, the mainland's river (a step above it) in the river. */
const surfaceY = (x: number, z: number): number => (z < -860 ? waterLevelAt(x, z) : seaY(x, z));

const WAKE_N = 96, WAKE_LIFE = 9;

class Wake {
  readonly mesh: THREE.Mesh;
  private readonly px = new Float32Array(WAKE_N); private readonly pz = new Float32Array(WAKE_N);
  private readonly lx = new Float32Array(WAKE_N); private readonly lz = new Float32Array(WAKE_N);
  private readonly t0 = new Float32Array(WAKE_N); private readonly w0 = new Float32Array(WAKE_N);
  private readonly k0 = new Float32Array(WAKE_N); private readonly d0 = new Float32Array(WAKE_N);
  private head = 0; private count = 0; private dist = 0;
  private lastX = NaN; private lastZ = NaN;
  readonly pos: THREE.BufferAttribute; readonly aw: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, mat: THREE.Material) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 3), 3);
    this.aw = new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage); this.aw.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos); geo.setAttribute('aW', this.aw);
    const idx: number[] = [];
    for (let i = 0; i < WAKE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    flip.geo(geo, 'position'); flip.geo(geo, 'aW');
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Drop a point under the stern when the boat has gone far enough. strength 0..1. */
  drop(x: number, z: number, lx: number, lz: number, hw: number, strength: number, now: number): void {
    const d = Math.hypot(x - this.lastX, z - this.lastZ);
    if (d < 1.1 && this.count > 0) return;
    if (!(d < 30)) this.cut();
    this.dist += Number.isFinite(d) ? d : 0;
    this.lastX = x; this.lastZ = z;
    const i = this.head;
    this.px[i] = x; this.pz[i] = z; this.lx[i] = lx; this.lz[i] = lz; this.t0[i] = now; this.w0[i] = hw; this.k0[i] = strength; this.d0[i] = this.dist;
    this.head = (i + 1) % WAKE_N; this.count = Math.min(WAKE_N, this.count + 1);
  }

  /** The boat left the water or jumped: the next point starts a new strip. */
  cut(): void { this.count = 0; this.lastX = NaN; }

  update(now: number): void {
    // Forget what has faded.
    while (this.count > 0 && now - this.t0[(this.head - this.count + WAKE_N) % WAKE_N] > WAKE_LIFE) this.count--;
    const n = this.count;
    this.mesh.visible = n > 1;
    if (n < 2) return;
    const P = this.pos.array as Float32Array, A = this.aw.array as Float32Array;
    for (let j = 0; j < n; j++) {
      const i = (this.head - n + j + WAKE_N) % WAKE_N, age = now - this.t0[i];
      const hw = this.w0[i] * 0.8 + age * 1.05, x = this.px[i], z = this.pz[i];
      const fade = (1 - age / WAKE_LIFE), a = fade * fade * this.k0[i] * (j === n - 1 ? 0 : 1);
      for (let s = 0; s < 2; s++) {
        const sg = s === 0 ? 1 : -1, vx = x + this.lx[i] * hw * sg, vz = z + this.lz[i] * hw * sg, o = (j * 2 + s) * 3;
        P[o] = vx; P[o + 1] = surfaceY(vx, vz) + 0.05; P[o + 2] = vz;
        A[o] = a; A[o + 1] = sg; A[o + 2] = this.d0[i];
      }
    }
    this.pos.needsUpdate = true; this.aw.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
}

const WAKE_VERT = /* glsl */ `
attribute vec3 aW;
varying vec3 vW;
varying vec3 vP;
#include <common>
#include <fog_pars_vertex>
void main() {
  vW = aW;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WAKE_FRAG = /* glsl */ `
uniform float uNight;
varying vec3 vW;
varying vec3 vP;
#include <common>
#include <fog_pars_fragment>
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float u = abs(vW.y);
  float n = vnoise(vP.xz * 1.7) * 0.6 + vnoise(vP.xz * 4.3) * 0.4;
  // Bright churn down the middle, a sharp line of foam along each arm of the V, lace between.
  float mid = (1.0 - smoothstep(0.0, 0.45, u)) * (0.55 + 0.45 * n);
  float arm = smoothstep(0.62, 0.9, u) * (1.0 - smoothstep(0.93, 1.0, u)) * (0.6 + 0.4 * n);
  float lace = smoothstep(0.42, 0.75, n) * 0.55;
  float a = clamp(max(max(mid, arm), lace) * vW.x, 0.0, 1.0);
  if (a < 0.01) discard;
  vec3 col = vec3(0.93, 0.96, 0.97) * (1.0 - 0.75 * uNight);
  gl_FragColor = vec4(col, a * 0.85);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * Thrown spray: soft white points under gravity, a ring buffer of them drawn in one call. The boats' own, so this
 * file needs nothing added to fx/particles.ts. Positions and looks are rewritten every frame (registered with flip).
 */
class Spray {
  readonly points: THREE.Points;
  private readonly n: number;
  private readonly p: Float32Array; private readonly v: Float32Array; private readonly age: Float32Array;
  private readonly life: Float32Array; private readonly s0: Float32Array; private readonly floor: Float32Array;
  private next = 0;
  private live = 0;
  private readonly pos: THREE.BufferAttribute; private readonly look: THREE.BufferAttribute;
  readonly mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, low: boolean) {
    this.n = low ? 320 : 1100;
    const n = this.n;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(9); this.life = new Float32Array(n).fill(1); this.s0 = new Float32Array(n); this.floor = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.look = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos); geo.setAttribute('aL', this.look);
    flip.geo(geo, 'position'); flip.geo(geo, 'aL');
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uScale: { value: 400 }, uNight: { value: 0 } },
      vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, fog: true, transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, size: number): void {
    for (let k = 0; k < count; k++) {
      const i = this.next, o = i * 3, j = 0.35 * size;
      this.next = (i + 1) % this.n;
      this.p[o] = x + (Math.random() - 0.5) * j; this.p[o + 1] = y + 0.05; this.p[o + 2] = z + (Math.random() - 0.5) * j;
      this.v[o] = vx * (0.85 + Math.random() * 0.3) + (Math.random() - 0.5) * 1.6;
      this.v[o + 1] = vy * (0.7 + Math.random() * 0.5);
      this.v[o + 2] = vz * (0.85 + Math.random() * 0.3) + (Math.random() - 0.5) * 1.6;
      this.age[i] = 0; this.life[i] = 0.5 + Math.random() * 0.5; this.s0[i] = (0.25 + Math.random() * 0.35) * size; this.floor[i] = y - 0.15;
    }
    this.live = 1.5;
  }

  update(dt: number, cam: THREE.PerspectiveCamera, heightPx: number, night: number): void {
    if (this.live <= 0) { this.points.visible = false; return; }
    this.live -= dt;
    this.points.visible = true;
    const P = this.pos.array as Float32Array, L = this.look.array as Float32Array, drag = Math.exp(-0.9 * dt);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      if (this.age[i] >= this.life[i]) { L[i * 2 + 1] = 0; continue; }
      this.age[i] += dt;
      this.v[o + 1] -= G * dt;
      this.v[o] *= drag; this.v[o + 1] *= drag; this.v[o + 2] *= drag;
      this.p[o] += this.v[o] * dt; this.p[o + 1] += this.v[o + 1] * dt; this.p[o + 2] += this.v[o + 2] * dt;
      if (this.p[o + 1] < this.floor[i] && this.v[o + 1] < 0) this.age[i] = this.life[i];
      const a = this.age[i] / this.life[i];
      P[o] = this.p[o]; P[o + 1] = this.p[o + 1]; P[o + 2] = this.p[o + 2];
      L[i * 2] = this.s0[i] * (1 + 1.6 * a); L[i * 2 + 1] = this.age[i] >= this.life[i] ? 0 : (1 - a) * (1 - a) * 0.6;
    }
    this.pos.needsUpdate = true; this.look.needsUpdate = true;
    this.mat.uniforms.uScale.value = heightPx / (2 * Math.tan((cam.fov * Math.PI) / 360));
    this.mat.uniforms.uNight.value = night;
  }
}

const SPRAY_VERT = /* glsl */ `
attribute vec2 aL;
uniform float uScale;
varying float vA;
#include <common>
#include <fog_pars_vertex>
void main() {
  vA = aL.y;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aL.y > 0.0 ? clamp(aL.x * uScale / -mvPosition.z, 1.0, 96.0) : 0.0;
  #include <fog_vertex>
}`;
const SPRAY_FRAG = /* glsl */ `
uniform float uNight;
varying float vA;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  float a = vA * (1.0 - smoothstep(0.25, 1.0, r));
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.92, 0.95, 0.97) * (1.0 - 0.75 * uNight), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const P0 = new THREE.Vector3();

export class Boat implements Vehicle {
  readonly hull: Hull;
  x: number; y: number; z: number;
  h: number; pitch = 0; roll = 0;
  vx = 0; vy = 0; vz = 0;
  yawRate = 0;
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null;
  health = 100;
  onGround = true;
  airTime = 0;
  slip = 0;
  lights = false;
  sunk = false;
  /** Never the town's: net/cars.ts leaves a held vehicle alone when its player gets out. */
  held = true;
  readonly hl: number; readonly hw: number;
  readonly seatX: number;
  /** Where it is moored. */
  readonly home: { x: number; z: number; h: number };
  /** 0..1, how far onto the plane. */
  plane = 0;
  /** Share of the hull in the water, 0..1. */
  wet = 1;
  pitchV = 0; rollV = 0;
  readonly obj = new THREE.Group();
  readonly wake: Wake;
  /** Seconds the player has been far from it while it was away from home. */
  awayT = 0;
  onRamp: Ramp | null = null;
  sprayAcc = 0;
  tailAcc = 0;
  fallV = 0;
  /** A town-run hull (Boats.craft): its owner dresses it and poses it; never stepped, boarded or given a speedboat's model. */
  custom = false;

  constructor(readonly id: number, readonly kind: BoatKind, public color: number, wakeMat: THREE.Material, scene: THREE.Scene) {
    this.spec = SPECS[kind];
    this.hull = HULLS[kind];
    this.hl = this.spec.length / 2; this.hw = this.spec.width / 2;
    this.seatX = this.hull.seats[0][0];
    this.home = HOMES[kind];
    this.x = this.home.x; this.z = this.home.z; this.h = this.home.h;
    this.y = seaY(this.x, this.z);
    this.wake = new Wake(scene, wakeMat);
    scene.add(this.obj);
  }
  readonly spec: VehicleSpec;

  get speed(): number { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }

  doorPos(side: -1 | 1, out: { x: number; z: number }): void {
    // Beside the helm (the hull's widest point), a step out from the gunwale.
    const s = Math.sin(this.h), c = Math.cos(this.h), off = -side * (this.hw + 0.55), back = this.hull.seats[0][1];
    out.x = this.x + c * off + s * back;
    out.z = this.z - s * off + c * back;
  }

  /** A seat in world space: [across, along, up] from the hull's middle, turned with the hull. */
  seatPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const st = this.hull.seats[Math.min(i, this.hull.seats.length - 1)];
    out.set(st[0], st[2], st[1]).applyEuler(new THREE.Euler(-this.pitch, this.h, this.roll, 'YXZ'));
    return out.set(this.x + out.x, this.y + out.y, this.z + out.z);
  }

  /** Back to its mooring, at rest. */
  moor(): void {
    this.x = this.home.x; this.z = this.home.z; this.h = this.home.h;
    this.y = seaY(this.x, this.z);
    this.vx = this.vy = this.vz = this.yawRate = this.pitch = this.roll = this.pitchV = this.rollV = 0;
    this.awayT = 0; this.onRamp = null;
    this.wake.cut();
  }
}

/** A ramp's face height at a point, or -Infinity off its footprint. along/across into out if given. */
function rampAt(r: Ramp, x: number, z: number): number {
  const s = Math.sin(r.h), c = Math.cos(r.h), dx = x - r.x, dz = z - r.z;
  const along = dx * s + dz * c, across = dx * c - dz * s;
  if (Math.abs(across) > r.w / 2 || Math.abs(along) > r.len / 2) return -Infinity;
  return r.y + r.tall * (along + r.len / 2) / r.len;
}

export class Boats {
  readonly list: Boat[] = [];
  readonly ramps: Ramp[] = [];
  private readonly wakeMat: THREE.ShaderMaterial;
  private readonly spray: Spray;
  private acc = 0;
  private readonly sl = { x: 0, z: 0, vy: 0 };
  private readonly low: boolean;
  private paint = new Map<Boat, THREE.Material>();
  private readonly loadedMats: THREE.MeshStandardMaterial[] = [];
  private envSeen: THREE.Texture | null = null;
  /** For the tests: what the last frame did. */
  readonly stats = { steps: 0, loaded: false, file: '' };

  constructor(private game: Game) {
    this.low = game.quality.name === 'low';
    this.wakeMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNight: { value: 0 } },
      vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG,
      fog: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const scene = game.scene;
    this.spray = new Spray(scene, this.low);
    this.list.push(new Boat(9001, 'speedboat', 0xf2e8cf, this.wakeMat, scene));
    this.list.push(new Boat(9002, 'jetski', 0xf0a202, this.wakeMat, scene));
    for (const b of this.list) b.obj.add(this.standIn(b));
    for (const s of RAMP_SPOTS) {
      const r: Ramp = { ...s, len: RAMP_LEN, w: RAMP_W, tall: RAMP_TALL, y: WATER_Y, obj: new THREE.Group() };
      r.obj.add(this.rampStandIn());
      scene.add(r.obj);
      this.ramps.push(r);
    }
    scene.add(this.dock());
    // The dock's deck is somewhere to stand, with a step up to the pier at its north end (the pier is 0.4 m, the dock
    // a meter lower), and a wall to a hull.
    game.col.addBox(DOCK.x - DOCK.w / 2, DOCK.z0, DOCK.x + DOCK.w / 2, DOCK.z1, DOCK.y, DOCK.y - 0.45);
    game.col.addBox(DOCK.x - DOCK.w / 2, DOCK.z0 + 4, DOCK.x - DOCK.w / 2 + 1.2, DOCK.z0 + 8, 0.02, DOCK.y - 0.45);
    void this.load();
  }

  /** Is this one of ours? */
  has(v: Vehicle | null | undefined): v is Boat { return !!v && this.list.includes(v as Boat); }

  /** The nearest boat whose hull is within reach of a person at (x, y, z). */
  nearest(x: number, y: number, z: number, reach: number): Boat | null {
    let best: Boat | null = null, bd = reach;
    for (const b of this.list) {
      if (b.driver !== null || Math.abs(b.y - y) > 2.6) continue;
      const dx = x - b.x, dz = z - b.z, s = Math.sin(b.h), c = Math.cos(b.h);
      const along = Math.abs(dx * s + dz * c) - b.hl, across = Math.abs(dz * s - dx * c) - b.hw;
      const d = Math.hypot(Math.max(along, 0), Math.max(across, 0));
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // ── Other players' boats (for net/remote.ts to draw instead of a ghost car) ──────────────────────────

  readonly ghosts: Boat[] = [];
  private named: Map<string, THREE.Object3D> | null = null;
  private ghostId = 9100;

  /** Another player's boat, drawn here as their state frames say: never stepped, never boarded. */
  ghost(kind: BoatKind, color: number): Boat {
    const b = new Boat(this.ghostId++, kind, color, this.wakeMat, this.game.scene);
    b.held = true; b.driver = 'player';
    b.obj.add(this.standIn(b));
    if (this.named) this.dress(b.obj, kind, this.named, b);
    this.ghosts.push(b);
    return b;
  }

  /** Move a ghost to its owner's latest pose. Its wake and spray follow from how fast it went. */
  ghostPose(b: Boat, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, dt: number): void {
    if (dt > 0) { b.vx = (x - b.x) / dt; b.vz = (z - b.z) / dt; b.vy = (y - b.y) / dt; }
    b.x = x; b.y = y; b.z = z; b.h = yaw; b.pitch = pitch; b.roll = roll;
    b.wet = y - seaY(x, z) < 0.6 ? 1 : 0;
    b.plane = clamp01((Math.hypot(b.vx, b.vz) - b.spec.topSpeed * 0.28) / (b.spec.topSpeed * 0.25));
    this.pose(b);
  }

  /** A hull for the town's ferry (sim/ferry.ts): a wake and spray as a ghost's, sized to it, no model of its own. Pose it with ghostPose. */
  craft(hl: number, hw: number): Boat {
    const b = new Boat(this.ghostId++, 'speedboat', 0xe9e0c8, this.wakeMat, this.game.scene);
    (b as { hl: number }).hl = hl; (b as { hw: number }).hw = hw;
    b.held = true; b.driver = 'player'; b.custom = true; b.wet = 1;
    this.ghosts.push(b);
    return b;
  }

  unghost(b: Boat): void {
    const i = this.ghosts.indexOf(b);
    if (i >= 0) this.ghosts.splice(i, 1);
    this.game.scene.remove(b.obj, b.wake.mesh);
    flip.remove(b.wake.pos); flip.remove(b.wake.aw);
    b.wake.mesh.geometry.dispose();
    this.paint.delete(b);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.acc = Math.min(this.acc + dt, 0.1);
    let n = 0;
    while (this.acc >= STEP) { this.acc -= STEP; n++; for (const b of this.list) this.step(b, STEP); }
    this.stats.steps = n;
    const now = this.game.time, g = this.game;
    const pl = g.player.person;
    for (const b of this.list) {
      this.effects(b, dt);
      b.wake.update(now);
      // Left somewhere else: back to the dock once the player has been well away from it for a while.
      const away = Math.hypot(b.x - b.home.x, b.z - b.home.z) > 30;
      const far = Math.hypot(pl.x - b.x, pl.z - b.z) > 90;
      b.awayT = b.driver === null && away && far ? b.awayT + dt : 0;
      if (b.awayT > 8) b.moor();
      this.pose(b);
    }
    for (const b of this.ghosts) { this.effects(b, dt); b.wake.update(now); }
    for (const r of this.ramps) {
      r.y = seaY(r.x, r.z) - 0.12;
      r.obj.position.set(r.x, r.y, r.z);
      r.obj.rotation.set(0, r.h, 0);
    }
    this.wakeMat.uniforms.uNight.value = g.sky?.night ?? 0;
    this.spray.update(dt, g.camera as THREE.PerspectiveCamera, g.renderer.domElement.height, g.sky?.night ?? 0);
    const env = (g.world.mats.flat as THREE.MeshStandardMaterial).envMap ?? null;
    if (env !== this.envSeen) { this.envSeen = env; for (const m of this.loadedMats) { m.envMap = env; m.needsUpdate = true; } }
  }

  private pose(b: Boat): void {
    b.obj.position.set(b.x, b.y, b.z);
    b.obj.rotation.set(-b.pitch, b.h, b.roll, 'YXZ');
  }

  private step(b: Boat, dt: number): void {
    const H = b.hull, sp = b.spec, ctl = b.ctl, t = seaClock.t;
    const s = Math.sin(b.h), c = Math.cos(b.h);
    const fx = s, fz = c, lx = c, lz = -s;
    let vf = b.vx * fx + b.vz * fz, vs = b.vx * lx + b.vz * lz;
    const spd = Math.abs(vf);
    const driven = b.driver !== null;
    const thr = driven ? clamp(ctl.accel, -1, 1) : 0, steer = driven ? clamp(ctl.steer, -1, 1) : 0;

    // ── Planing and the attitude the water holds it at ──
    const planeT = clamp01((spd - sp.topSpeed * 0.28) / (sp.topSpeed * 0.25));
    b.plane += (planeT - b.plane) * Math.min(1, dt * 2.5);
    const hump = Math.exp(-(((spd - sp.topSpeed * 0.3) / (sp.topSpeed * 0.14)) ** 2));
    const bowLift = H.bow * hump + 0.035 * b.plane + 0.03 * Math.max(0, thr) * (1 - b.plane);
    const lean = clamp(-b.yawRate * spd * H.lean, -H.leanMax, H.leanMax);
    const draft = H.draft * (1 - 0.5 * b.plane);
    const sinP = Math.sin(b.pitch), sinR = Math.sin(b.roll), sinB = Math.sin(bowLift), sinL = Math.sin(lean);

    // ── Buoyancy, point by point ──
    const k = G / draft, w = 1 / H.pts.length;
    let ay = -G, tp = 0, tr = 0, wetN = 0, sternWet = 0, mA2 = 0, mX2 = 0, bed = -Infinity, bedPush = 0;
    for (let i = 0; i < H.pts.length; i++) {
      const [ax, az] = H.pts[i];
      const px = b.x + fx * az + lx * ax, pz = b.z + fz * az + lz * ax;
      const bottom = b.y + az * sinP + ax * sinR - draft;
      seaSlope(px, pz, this.sl, t);
      const surf = seaY(px, pz, t) + az * sinB + ax * sinL;
      const e = surf - bottom;
      mA2 += w * (az - H.azm) ** 2; mX2 += w * ax * ax;
      if (e > 0) {
        const f = k * Math.min(e, draft * 2.6) * w;
        ay += f - 7 * (b.vy - this.sl.vy) * w;
        tp += f * (az - H.azm); tr += f * ax;
        wetN++;
        if (az < 0) sternWet++;
      }
      // The seabed: a point that would be under it is held on it.
      const gnd = groundAt(px, pz);
      if (gnd > bottom - 0.02) { bed = Math.max(bed, gnd); bedPush = Math.max(bedPush, gnd - bottom); }
    }
    b.wet = wetN / H.pts.length;
    const stern = sternWet > 0;

    // ── Ramps: the face is solid, and the hull rides up it ──
    let ramp: Ramp | null = null, rampTop = -Infinity;
    for (const r of this.ramps) {
      const top = rampAt(r, b.x, b.z);
      if (top > rampTop) { rampTop = top; ramp = r; }
    }
    if (ramp && rampTop > -Infinity) {
      const bottom = b.y - draft * 0.6;
      if (bottom < rampTop + 0.05 && (b.onRamp === ramp || bottom > rampTop - 0.6)) {
        const ra = Math.sin(ramp.h) * fx + Math.cos(ramp.h) * fz;   // how squarely it meets the face
        const slope = ramp.tall / ramp.len;
        b.y = rampTop + draft * 0.6;
        const along = b.vx * Math.sin(ramp.h) + b.vz * Math.cos(ramp.h);
        b.vy = Math.max(b.vy, along * slope);
        const want = Math.atan(slope) * ra;
        b.pitch += (want - b.pitch) * Math.min(1, dt * 18); b.pitchV = 0;
        b.roll *= 1 - Math.min(1, dt * 8); b.rollV = 0;
        b.onRamp = ramp;
        ay = Math.max(ay, 0);
      } else if (bottom < rampTop - 0.6) {
        // Against its back or side: pushed off the way it came.
        const ox = b.x - ramp.x, oz = b.z - ramp.z, ol = Math.hypot(ox, oz) || 1;
        b.x += ox / ol * 0.2; b.z += oz / ol * 0.2;
        const into = (b.vx * ox + b.vz * oz) / ol;
        if (into < 0) { b.vx -= 1.6 * into * ox / ol; b.vz -= 1.6 * into * oz / ol; }
        b.onRamp = null;
      } else b.onRamp = null;
    } else b.onRamp = null;
    const onRamp = b.onRamp !== null;

    const was = b.onGround;
    b.onGround = b.wet > 0 || onRamp || bedPush > 0;
    if (!b.onGround) { b.airTime += dt; b.fallV = b.vy; } else {
      if (!was && b.airTime > 0.25) this.landed(b, -b.fallV);
      b.airTime = 0;
    }

    // ── Heave, pitch and roll ──
    b.vy += ay * dt;
    if (b.wet > 0 && !onRamp) {
      b.pitchV += (0.55 * tp / Math.max(mA2, 0.1) - 5.5 * b.pitchV * b.wet) * dt;
      b.rollV += (0.55 * tr / Math.max(mX2, 0.05) - 6 * b.rollV * b.wet) * dt;
    } else if (!onRamp) {
      // In the air the nose slowly drops, and the hull keeps whatever spin it left with.
      b.pitchV -= 0.35 * dt;
    }
    // Tippable, never capsized: a hard stop past about 35 degrees.
    const R = 0.6;
    if (Math.abs(b.roll) > R) b.rollV -= Math.sign(b.roll) * (Math.abs(b.roll) - R) * 60 * dt;
    if (Math.abs(b.pitch) > R) b.pitchV -= Math.sign(b.pitch) * (Math.abs(b.pitch) - R) * 60 * dt;
    b.pitch += b.pitchV * dt; b.roll += b.rollV * dt;
    b.y += b.vy * dt;
    if (bedPush > 0) {
      // Aground: lifted onto the bottom and dragged to a stop.
      b.y += Math.min(bedPush, 0.5);
      if (b.vy < 0) b.vy = 0;
      const f = Math.exp(-dt * (2 + 10 * clamp01(bedPush * 3)));
      b.vx *= f; b.vz *= f;
      vf = b.vx * fx + b.vz * fz; vs = b.vx * lx + b.vz * lz;
    }
    void bed;

    // ── Thrust, drag and grip ──
    let af = 0;
    const top = sp.topSpeed;
    if (stern && !onRamp) {
      if (thr > 0) af += thr * sp.accel * (1 - 0.3 * (vf / top) ** 2) * (vf < 0 ? 1.6 : 1);
      else if (thr < 0) af += vf > 0.6 ? thr * sp.brake : thr * sp.accel * 0.4 * clamp01(1 - -vf / 6);
    }
    if (b.wet > 0 && !onRamp) {
      // Hull drag: the square law, plus the hump before the plane, plus a little that stops a drifting boat.
      af -= Math.sign(vf) * (sp.accel * 0.7 * (vf / top) ** 2 + 0.9 * hump * (1 - b.plane) + 0.25 * b.wet);
      if (Math.abs(vf) < 0.25 && thr === 0) af -= vf * 2;
    } else af -= vf * 0.02;
    vf += af * dt;
    const grip = (b.wet > 0 ? sp.grip * (driven && ctl.handbrake ? 0.35 : 1) * (0.6 + 0.4 * b.wet) : 0.05) + (onRamp ? 6 : 0);
    vs *= Math.exp(-grip * dt);
    b.slip = clamp01(thr > 0 ? (1 - b.plane) * thr * clamp01(1 - spd / (top * 0.45)) + (b.wet === 0 ? 1 : 0) : 0);

    // ── Steering ──
    const authority = stern && !onRamp ? clamp((spd + 1.5) / 7, 0.25, 1) * (1 - 0.3 * clamp01(spd / top)) : 0;
    const dir = vf < -0.3 ? -1 : 1;
    const want = -steer * H.turn * authority * dir;
    if (stern && !onRamp) b.yawRate += (want - b.yawRate) * Math.min(1, dt * (2.5 + 2 * b.wet));
    else if (onRamp) b.yawRate *= 1 - Math.min(1, dt * 10);
    b.h += b.yawRate * dt;

    // ── Moored: a soft line to the dock while nobody drives it near home ──
    if (!driven) {
      const hx = b.home.x - b.x, hz = b.home.z - b.z, d = Math.hypot(hx, hz);
      if (d < 20) {
        const ns = Math.sin(b.h), nc = Math.cos(b.h);
        const ax = hx * 0.15, az = hz * 0.15;
        vf += (ax * ns + az * nc) * dt; vs += (ax * nc - az * ns) * dt;
        vf *= 1 - Math.min(1, dt * 1.5); vs *= 1 - Math.min(1, dt * 1.5);
        let dh = b.home.h - b.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        b.yawRate += (dh * 1.2 - b.yawRate * 1.5) * dt;
      }
    }

    const ns = Math.sin(b.h), nc = Math.cos(b.h);
    b.vx = ns * vf + nc * vs; b.vz = nc * vf - ns * vs;
    const ox = b.x, oz = b.z;
    b.x += b.vx * dt; b.z += b.vz * dt;

    // ── Land, the pier and anything else solid ──
    if (groundAt(b.x, b.z) > WATER_Y - 0.15) {
      // Dry land (or the pier's deck) under the middle: no further. The bottom has already slowed it.
      b.x = ox; b.z = oz;
      b.vx *= -0.2; b.vz *= -0.2;
    }
    const col = this.game.col;
    for (const end of [1, -1]) {
      const along = end * (b.hl - b.hw * 0.8);
      P0.set(b.x + ns * along, 0, b.z + nc * along);
      const qx = P0.x, qz = P0.z, p = { x: qx, z: qz };
      if (col.resolveCircle(p, b.hw * 0.9, b.y + 0.4)) {
        const dx = p.x - qx, dz = p.z - qz, dl = Math.hypot(dx, dz);
        if (dl > 1e-5) {
          b.x += dx; b.z += dz;
          const into = (b.vx * dx + b.vz * dz) / dl;
          if (into < 0) {
            b.vx -= 1.3 * into * dx / dl; b.vz -= 1.3 * into * dz / dl;
            if (into < -5 && b.driver === 'player') this.game.cam.shake(clamp(-into / 25, 0.1, 0.5));
          }
        }
      }
    }
  }

  private landed(b: Boat, v: number): void {
    const g = this.game, big = v > 6.5;
    if (b.driver === 'player') g.cam.shake(clamp(v / 22, 0.08, 0.55));
    const y = seaY(b.x, b.z);
    const n = Math.round(clamp(v * 3, 6, 40));
    this.spray.emit(b.x, y, b.z, b.vx * 0.3, 3 + v * 0.6, b.vz * 0.3, n, b.hull.spray * 1.4);
    if (big) g.emit('splash', { x: b.x, z: b.z, big: v > 10 });
    b.wake.cut();
  }

  private effects(b: Boat, dt: number): void {
    const spd = Math.hypot(b.vx, b.vz);
    const s = Math.sin(b.h), c = Math.cos(b.h), lx = c, lz = -s;
    if (b.wet > 0 && spd > 1.5 && !b.onRamp) {
      const sx = b.x - s * b.hl * 0.85, sz = b.z - c * b.hl * 0.85;
      b.wake.drop(sx, sz, lx, lz, b.hw, clamp01((spd - 1) / 9), this.game.time);
    } else if (b.wet === 0) b.wake.cut();
    if (b.wet === 0 || spd < 4) return;
    // Bow spray: thrown out to both sides, more and higher the faster; on the plane it moves aft with the wet area.
    const k = clamp01((spd - 4) / 18), at = b.hl * (0.55 - 0.45 * b.plane);
    b.sprayAcc += dt * 45 * k;
    while (b.sprayAcc >= 1) {
      b.sprayAcc -= 1;
      for (const side of [1, -1]) {
        const px = b.x + s * at + lx * side * b.hw * 0.85, pz = b.z + c * at + lz * side * b.hw * 0.85;
        const out = 1.5 + spd * 0.16;
        this.spray.emit(px, surfaceY(px, pz), pz, b.vx * 0.45 + lx * side * out, 1.2 + spd * 0.13, b.vz * 0.45 + lz * side * out, 1, b.hull.spray);
      }
    }
    // The rooster tail: a plume thrown up behind the transom (the jet ski's is its jet).
    b.tailAcc += dt * 30 * k * (b.kind === 'jetski' ? 1.2 : 0.8) * Math.max(0.3, b.ctl.accel);
    while (b.tailAcc >= 1) {
      b.tailAcc -= 1;
      const px = b.x - s * b.hl * 1.02, pz = b.z - c * b.hl * 1.02;
      this.spray.emit(px, surfaceY(px, pz), pz, b.vx * 0.55 - s * 2.5, 2.5 + spd * 0.17, b.vz * 0.55 - c * 2.5, 1, b.hull.spray * 1.2);
    }
  }

  // ── Looks ──────────────────────────────────────────────────────────────────

  private mat(hex: number, rough: number, metal = 0): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal });
  }

  /** A few boxes in the boat's shape, for the moment before its model is in. */
  private standIn(b: Boat): THREE.Object3D {
    const g = new THREE.Group(), L = b.spec.length, W = b.spec.width;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.7, L * 0.85), this.mat(b.color, 0.35));
    hull.position.set(0, 0.0, -L * 0.05);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(W * 0.45, L * 0.3, 4), this.mat(b.color, 0.35));
    bow.rotation.set(Math.PI / 2, Math.PI / 4, 0); bow.position.set(0, 0.05, L * 0.42); bow.scale.set(1, 1, 0.7);
    g.add(hull, bow);
    g.name = 'standin';
    return g;
  }

  private rampStandIn(): THREE.Object3D {
    const shape = new THREE.Shape();
    shape.moveTo(-RAMP_LEN / 2, 0); shape.lineTo(RAMP_LEN / 2, RAMP_TALL); shape.lineTo(RAMP_LEN / 2, -0.4); shape.lineTo(-RAMP_LEN / 2, -0.4);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: RAMP_W, bevelEnabled: false });
    geo.translate(0, 0, -RAMP_W / 2);
    geo.rotateY(-Math.PI / 2);
    const m = new THREE.Mesh(geo, this.mat(0xe4572e, 0.6));
    m.name = 'standin';
    return m;
  }

  /** The floating dock along the pier's east side: a plank deck on floats, with cleats. Three meshes in all. */
  private dock(): THREE.Object3D {
    const g = new THREE.Group(), L = DOCK.z1 - DOCK.z0;
    const wood = this.mat(0x8a6a4c, 0.85), float = this.mat(0x3a3f44, 0.6), steel = this.mat(0xb8bcc0, 0.35, 0.8);
    const planks: THREE.BufferGeometry[] = [], floats: THREE.BufferGeometry[] = [], cleats: THREE.BufferGeometry[] = [];
    // Planks across the deck with a finger's gap between them, on two stringers.
    for (let z = DOCK.z0 + 0.15; z < DOCK.z1; z += 0.3) planks.push(new THREE.BoxGeometry(DOCK.w, 0.07, 0.27).translate(DOCK.x, DOCK.y - 0.035, z));
    for (const dx of [-1, 1]) planks.push(new THREE.BoxGeometry(0.15, 0.18, L).translate(DOCK.x + dx * (DOCK.w / 2 - 0.1), DOCK.y - 0.16, DOCK.z0 + L / 2));
    for (let z = DOCK.z0 + 2; z < DOCK.z1; z += 4) floats.push(new THREE.BoxGeometry(DOCK.w * 0.9, 0.35, 2.2).translate(DOCK.x, DOCK.y - 0.32, z));
    for (const kind of ['speedboat', 'jetski'] as const) {
      for (const dz of [-2, 2]) cleats.push(new THREE.CylinderGeometry(0.06, 0.08, 0.18, 8).translate(DOCK.x + DOCK.w / 2 - 0.2, DOCK.y + 0.09, HOMES[kind].z + dz));
    }
    // The step down from the pier.
    planks.push(new THREE.BoxGeometry(1.2, 0.08, 4).translate(DOCK.x - DOCK.w / 2 + 0.6, 0.02 - 0.04, DOCK.z0 + 6));
    for (const [geos, mat] of [[planks, wood], [floats, float], [cleats, steel]] as const) {
      const m = new THREE.Mesh(mergeGeometries(geos as THREE.BufferGeometry[]), mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      g.add(m);
    }
    g.name = 'boat dock';
    return g;
  }

  /** Fetch the models: everything on medium and high, the far levels alone on the phone preset. */
  private async load(): Promise<void> {
    const file = this.low ? 'models/boats_far.glb' : 'models/boats.glb';
    try {
      const buf = await assets.bytes(file);
      if (!buf || buf.byteLength < 20) return;
      const u8 = new Uint8Array(buf, 0, 4);
      if (u8[0] !== 0x67 || u8[1] !== 0x6c || u8[2] !== 0x54 || u8[3] !== 0x46) return;
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      const named = new Map<string, THREE.Object3D>();
      gltf.scene.traverse((o) => { if (o.name) named.set(o.name, o); });
      for (const b of this.list) this.dress(b.obj, b.kind, named, b);
      for (const r of this.ramps) this.dress(r.obj, 'ramp', named, null);
      for (const b of this.ghosts) if (!b.custom) this.dress(b.obj, b.kind, named, b);
      this.named = named;
      this.stats.loaded = true; this.stats.file = file;
    } catch (e) {
      console.warn(`${file} did not load; the boats stay as stand-ins`, e);
    }
  }

  private matFor(src: THREE.Material, boat: Boat | null): THREE.MeshStandardMaterial {
    const name = src.name || '';
    if (name === 'paint' && boat) {
      let m = this.paint.get(boat) as THREE.MeshStandardMaterial | undefined;
      if (!m) {
        m = new THREE.MeshStandardMaterial({ name, color: boat.color, vertexColors: true, roughness: 0.22, metalness: 0.05 });
        this.paint.set(boat, m); this.loadedMats.push(m);
      }
      return m;
    }
    const key = name;
    const found = this.loadedMats.find((m) => m.name === key && m.userData.shared);
    if (found) return found;
    const look: Record<string, [number, number]> = {
      glass: [0.05, 0], chrome: [0.18, 1], vinyl: [0.55, 0], trim: [0.5, 0], rubber: [0.9, 0], hull: [0.3, 0.05],
      deck: [0.75, 0], metal: [0.35, 0.7], wood: [0.8, 0], float: [0.6, 0],
    };
    const [rough, metal] = look[name] ?? [0.6, 0];
    const m = new THREE.MeshStandardMaterial({ name, vertexColors: true, roughness: rough, metalness: metal });
    if (name === 'paint') m.color.setHex(0xe4572e);
    if (name === 'glass') { m.transparent = true; m.opacity = 0.42; m.color.setHex(0x334044); m.depthWrite = false; }
    m.userData.shared = true;
    this.loadedMats.push(m);
    return m;
  }

  /** Swap a stand-in for the model's levels of detail. */
  private dress(into: THREE.Object3D, kind: string, named: Map<string, THREE.Object3D>, boat: Boat | null): void {
    const lods: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i++) { const o = named.get(`${kind}_LOD${i}`); if (o) lods.push(o); }
    if (!lods.length) return;
    const lod = new THREE.LOD();
    const at = kind === 'ramp' ? [0, 90] : [0, 35, 140];
    lods.forEach((o, i) => {
      const c = o.clone(true);
      c.position.set(0, 0, 0); c.rotation.set(0, 0, 0);
      c.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((x) => this.matFor(x, boat)) : this.matFor(mesh.material, boat);
        mesh.castShadow = i === 0 && !this.low; mesh.receiveShadow = i < 2;
      });
      lod.addLevel(c, this.low ? 0 : at[Math.min(i, at.length - 1)]);
    });
    const old = into.getObjectByName('standin');
    if (old) into.remove(old);
    into.add(lod);
  }
}
