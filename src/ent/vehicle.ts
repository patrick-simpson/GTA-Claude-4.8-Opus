// How cars drive and how they are drawn.
//
// The physics is arcade and hand-rolled (PLAN.md, "Vehicle physics design"):
// velocity is split into a part along the nose and a part across it, the nose
// is steered like a bicycle, and the sideways part is bled off by the tires.
// Everything interesting (drifts, handbrake turns, catching a slide) falls out
// of how fast that sideways part is allowed to die.
//
// Height is tracked per axle rather than per car. Each axle falls under
// gravity and lands on groundAt(), taking the speed the ground is rising at,
// so a ramp throws the front wheels first and the rear a moment later and the
// car leaves nose-up with no special case. Curbs are told apart from ramps by
// looking a short way ahead: a ramp keeps rising, a curb does not.
//
// Parked cars sleep. A sleeping car costs three comparisons a frame and keeps
// its instance matrices cached until something touches it.
//
// Signs: pitch > 0 is nose up, roll > 0 leans to the right. Steering > 0 is to
// the right, which DEcreases the heading (see core/util.ts).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle, VehicleControls, VehiclesApi } from '../core/api';
import { RNG, clamp, clamp01, damp, smooth } from '../core/util';
import { SPECS, type VehicleKind, type VehicleSpec } from './vehicleSpecs';
import { vehicleModel, wheelGeometry, type VehicleModel } from './vehicleModels';
import { groundAt, isWater, WATER_Y } from '../world/plan';
import type { Box, Prop } from '../world/collide';

const STEP = 1 / 120;
/** Heavier than real gravity: jumps land sooner and cars feel planted. */
const GRAV = 13;
/** A rise taller than this in one stride is a wall, not a bump. */
const WALL = 0.7;

// The spec's `accel` is the shove off the line. These scale it so the stopwatch
// reads what the brief asks for (sedan 0-60 in about 8 s, sports about 4 s).
const ACCEL_K = 0.63;
// The bus tops out at 60 mph, so its 0-60 time is nearly its whole run; without
// help it takes most of a minute.
const ACCEL_TUNE: Partial<Record<VehicleKind, number>> = { bus: 1.4, tow: 1.15, van: 1.1 };
/** The engine's pull would run out this far past top speed; a governor cuts it at top speed instead, so cars reach their figure rather than creep up on it. */
const OVERRUN = 1.08;

/** Sideways speed (m/s) at which the tires let go, and the lower one at which they bite again. */
const SLIDE_IN = 2.6, SLIDE_OUT = 1.2;
/** Cornering force the steering may ask for, as a multiple of grip. Kept under SLIDE_IN so steering alone never spins a car. */
const CORNER = 1.45;
/** How hard a sliding car's nose is pulled back toward the way it is travelling, 1/s. */
const ALIGN = 2.2;
const RESTITUTION = 0.22;
/** Closing speed (m/s) above which a hit is reported and costs health. */
const HARD_HIT = 3;
const DAMAGE = 1.5;

const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion(), _qg = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const _cullCam = new THREE.PerspectiveCamera(), _pv = new THREE.Matrix4(), _frustum = new THREE.Frustum(), _sphere = new THREE.Sphere();
/** The sun's shadow box is 130 m across and follows the camera's focus; cars within this of the focus are drawn into it. */
const SHADOW_R2 = 95 * 95, WHEEL_R2 = 320 * 320;

interface KindBatch {
  kind: VehicleKind;
  model: VehicleModel;
  paint: THREE.InstancedMesh;
  trim: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  cap: number;
  n: number;
  /** How many of the n instances, counted from the front, are close enough to cast a shadow into view. */
  near: number;
}

class Car implements Vehicle {
  x = 0; y = 0; z = 0;
  h = 0; pitch = 0; roll = 0;
  vx = 0; vy = 0; vz = 0;
  yawRate = 0;
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null;
  color = 0xffffff;
  health = 100;
  onGround = true;
  airTime = 0;
  slip = 0;
  lights = false;
  sunk = false;
  readonly hl: number;
  readonly hw: number;

  // Everything below is private to this file.
  asleep = true;
  /** Where it fell asleep, so a teleport by other code is noticed. */
  sx = 0; sz = 0; sh = 0;
  rest = 0;
  /** Radius of the circle around the whole body, for cheap rejects. */
  readonly rad: number;
  readonly invM: number;
  readonly invI: number;
  /** Smoothed steering, -1..1, and the front wheels' drawn angle. */
  steerPos = 0; steerAng = 0;
  sliding = false;
  /** Seconds left of loose handling after a knock, so the spin from a hit shows before the tires take charge again. */
  loose = 0;
  // Per-axle height state (front, rear).
  yF = 0; yR = 0; vyF = 0; vyR = 0; gF = 0; gR = 0;
  onF = true; onR = true;
  groundRoll = 0;
  /** Correction for the wheels straddling a curb, where the center line is on one level and a side on the other. */
  lift = 0;
  // Visual only.
  susp = 0; suspV = 0; rollV = 0; pitchV = 0;
  spinF = 0; spinR = 0;
  /** Acceleration along the nose in the last step, for the body's squat and dive. */
  along = 0;
  braking = false; reversing = false;
  sinkT = 0;
  hitT = 0;
  dead = false;
  // Render cache.
  stale = true;
  shown = -1; cr = 1; cg = 1; cb = 1;
  readonly mat = new Float32Array(16);
  readonly wmat: Float32Array;

  constructor(readonly id: number, readonly spec: VehicleSpec, readonly batch: KindBatch) {
    this.hl = spec.length / 2;
    this.hw = spec.width / 2;
    this.rad = Math.hypot(this.hl, this.hw);
    this.invM = 1 / spec.mass;
    // A box's moment of inertia, padded: real numbers make every tap a pirouette.
    this.invI = 1 / (spec.mass * (spec.length * spec.length + spec.width * spec.width) / 12 * 1.5);
    this.wmat = new Float32Array(16 * batch.model.wheels.length);
  }

  get speed(): number { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }

  doorPos(side: -1 | 1, out: { x: number; z: number }): void {
    const s = Math.sin(this.h), c = Math.cos(this.h);
    const off = -side * (this.hw + 0.6), along = this.batch.model.seat.z;
    // Left of a car facing (s, c) is (c, -s).
    out.x = this.x + c * off + s * along;
    out.z = this.z - s * off + c * along;
  }
}

/** Radial falloff with a hot core, for lamp glows. */
function glowTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.1, '#e0e0e0');
  gr.addColorStop(0.25, '#707070');
  gr.addColorStop(0.5, '#303030');
  gr.addColorStop(1, '#000000');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/** Two overlapping beams on the road, brightest a little ahead of the bumper. The bottom of the canvas is the near end. */
function poolTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = 'lighter';
  for (const cx of [23, 41]) {
    g.save();
    g.translate(cx, 84);
    g.scale(1, 3.1);
    const gr = g.createRadialGradient(0, 4, 0, 0, 0, 19);
    gr.addColorStop(0, '#c8c8c8');
    gr.addColorStop(0.35, '#8c8c8c');
    gr.addColorStop(0.7, '#484848');
    gr.addColorStop(1, '#000000');
    g.fillStyle = gr;
    g.fillRect(-32, -42, 64, 84);
    g.restore();
  }
  return new THREE.CanvasTexture(cv);
}

const GLOW_VS = /* glsl */`
attribute vec3 aPos;
attribute vec4 aCol;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  vCol = aCol.rgb;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  mv.xy += position.xy * aCol.w;
  // Pulled toward the eye so the sprite is not cut in half by the lens it sits on.
  mv.z += 0.3;
  gl_Position = projectionMatrix * mv;
}`;
const POOL_VS = /* glsl */`
attribute vec3 aPos;
attribute vec4 aCol;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  vCol = vec3(1.0, 0.84, 0.55) * aCol.z;
  vec2 f = aCol.xy;
  vec2 r = vec2(-f.y, f.x);
  vec2 p = r * position.x * 7.0 + f * (position.y + 0.5) * 16.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(aPos.x + p.x, aPos.y, aPos.z + p.y, 1.0);
}`;
const GLOW_FS = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  // Squared: the canvas ramp is linear, and a linear halo ends in a visible rim once it is converted for the screen.
  float a = texture2D(map, vUv).r;
  gl_FragColor = vec4(vCol * a * a, 1.0);
  #include <colorspace_fragment>
}`;

/** Instanced quads with our own attributes: one draw call for every lamp in town. */
class Sprites {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  n = 0;
  private geo = new THREE.InstancedBufferGeometry();
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;

  constructor(readonly cap: number, vs: string, map: THREE.Texture, order: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } }, vertexShader: vs, fragmentShader: GLOW_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
  }

  add(x: number, y: number, z: number, a: number, b: number, c: number, d: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = a; this.col[i * 4 + 1] = b; this.col[i * 4 + 2] = c; this.col[i * 4 + 3] = d;
  }

  flush(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) { this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; }
  }
}

export class Vehicles implements VehiclesApi {
  private cars: Car[] = [];
  /** The same array as `cars`, seen through the public interface. */
  readonly list: readonly Vehicle[] = this.cars;

  private nextId = 1;
  private rng = new RNG(7719);
  private batches = new Map<VehicleKind, KindBatch>();
  private batchList: KindBatch[] = [];
  private paintMat: THREE.MeshStandardMaterial;
  private trimMat: THREE.MeshStandardMaterial;
  private glassMat: THREE.MeshStandardMaterial;
  private glassTintMat: THREE.MeshStandardMaterial;
  private wheels: THREE.InstancedMesh;
  private wheelCap = 512;
  private wheelsNear = 0;
  private wheelsAll = 0;
  private wheelGeo: THREE.BufferGeometry;
  private wheelMat: THREE.MeshStandardMaterial;
  private glow: Sprites;
  private pool: Sprites;
  private awake: Car[] = [];
  private pairA: Car[] = [];
  private pairB: Car[] = [];
  private pairs = 0;
  /** The car being tested by the collider callbacks below, and its heading. */
  private cur!: Car;
  private curS = 0; private curC = 1;
  private wet = 0;

  constructor(private game: Game) {
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.4 });
    this.trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.7 });
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x0a1424, metalness: 0.9, roughness: 0.1 });
    this.glassTintMat = this.glassMat.clone();
    this.glassTintMat.vertexColors = true;
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.75 });
    this.wheelGeo = wheelGeometry();
    this.wheels = this.makeWheels(this.wheelCap);
    this.glow = new Sprites(1024, GLOW_VS, glowTexture(), 6);
    this.pool = new Sprites(96, POOL_VS, poolTexture(), 5);
    game.scene.add(this.glow.mesh, this.pool.mesh);
  }

  // ── Roster ─────────────────────────────────────────────────────────────────

  spawn(kind: VehicleKind, x: number, z: number, h: number, color?: number): Vehicle {
    const spec = SPECS[kind];
    const c = new Car(this.nextId++, spec, this.batch(kind));
    c.color = color ?? spec.colors[Math.floor(this.rng.next() * spec.colors.length)];
    c.x = x; c.z = z; c.h = h;
    this.seat(c);
    this.cars.push(c);
    return c;
  }

  remove(v: Vehicle): void {
    const i = this.cars.indexOf(v as Car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  nearest(x: number, z: number, maxDist: number, pred?: (v: Vehicle) => boolean): Vehicle | null {
    let best: Car | null = null, bd = maxDist * maxDist;
    for (const c of this.cars) {
      const dx = c.x - x, dz = c.z - z, d = dx * dx + dz * dz;
      if (d < bd && (!pred || pred(c))) { bd = d; best = c; }
    }
    return best;
  }

  resolveCircle(p: { x: number; z: number }, r: number, y: number): Vehicle | null {
    let hit: Car | null = null;
    for (const c of this.cars) {
      const reach = c.rad + r;
      let dx = p.x - c.x;
      if (dx > reach || dx < -reach) continue;
      let dz = p.z - c.z;
      if (dz > reach || dz < -reach) continue;
      // Standing on the roof, or under a car that is up on a bridge.
      if (y > c.y + c.spec.height - 0.1 || y + 1.7 < c.y) continue;
      const s = Math.sin(c.h), co = Math.cos(c.h);
      let lf = dx * s + dz * co, lr = -dx * co + dz * s;
      const ef = lf - clamp(lf, -c.hl, c.hl), er = lr - clamp(lr, -c.hw, c.hw);
      const d2 = ef * ef + er * er;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), push = (r - d) / d;
        lf += ef * push; lr += er * push;
      } else if (c.hw - Math.abs(lr) < c.hl - Math.abs(lf)) lr = (lr < 0 ? -1 : 1) * (c.hw + r);
      else lf = (lf < 0 ? -1 : 1) * (c.hl + r);
      p.x = c.x + lf * s - lr * co;
      p.z = c.z + lf * co + lr * s;
      dx = 0; dz = 0;
      hit = c;
    }
    return hit;
  }

  /** Put a car on the ground where it stands, at rest and asleep. */
  private seat(c: Car): void {
    const s = Math.sin(c.h), co = Math.cos(c.h), half = c.spec.wheelbase / 2, t = c.spec.track / 2;
    c.gF = c.yF = groundAt(c.x + s * half, c.z + co * half);
    c.gR = c.yR = groundAt(c.x - s * half, c.z - co * half);
    c.vyF = c.vyR = 0;
    c.onF = c.onR = c.onGround = true;
    c.y = (c.yF + c.yR) / 2;
    c.pitch = Math.atan2(c.yF - c.yR, c.spec.wheelbase);
    const gl = Math.max(groundAt(c.x + co * t, c.z - s * t), c.y - 0.4);
    const gr = Math.max(groundAt(c.x - co * t, c.z + s * t), c.y - 0.4);
    c.groundRoll = c.roll = Math.atan2(gl - gr, c.spec.track);
    c.lift = clamp((gl + gr) / 2 - c.y, -0.2, 0.2);
    c.vx = c.vy = c.vz = c.yawRate = 0;
    c.airTime = 0; c.slip = 0; c.sliding = false;
    this.sleep(c);
  }

  private sleep(c: Car): void {
    c.asleep = true;
    c.vx = c.vy = c.vz = c.yawRate = 0;
    c.vyF = c.vyR = 0;
    c.susp = c.suspV = c.rollV = c.pitchV = 0;
    c.slip = 0; c.sliding = false; c.loose = 0; c.rest = 0;
    c.lights = false; c.braking = false; c.reversing = false;
    c.sx = c.x; c.sz = c.z; c.sh = c.h;
    c.stale = true;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const list = this.cars, awake = this.awake, game = this.game;
    // The sky is built before the vehicles, but tests stub the game with less.
    const sky = game.sky as Game['sky'] | undefined;
    this.wet = sky ? sky.wet : 0;
    const night = sky ? sky.night : 0;
    // A zero-length step would divide by it; there is nothing to simulate anyway.
    if (dt <= 0) { this.sync(night); return; }

    awake.length = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.asleep) {
        if (c.x !== c.sx || c.z !== c.sz || c.h !== c.sh) { this.seat(c); c.asleep = false; }
        else if (c.driver !== null || c.vx !== 0 || c.vz !== 0 || c.vy !== 0 || c.yawRate !== 0) c.asleep = false;
        else continue;
      }
      awake.push(c);
    }

    if (awake.length > 0) {
      const n = Math.max(1, Math.ceil(dt / STEP - 1e-6)), h = dt / n;
      this.findPairs(dt);
      for (let s = 0; s < n; s++) {
        for (let i = 0; i < awake.length; i++) {
          const c = awake[i];
          if (c.sunk) { this.sink(c, h); continue; }
          this.step(c, h);
          this.cur = c; this.curS = Math.sin(c.h); this.curC = Math.cos(c.h);
          game.col.forBoxes(c.x, c.z, c.rad + 0.3, this.onBox);
          game.col.forProps(c.x, c.z, c.rad + 0.6, this.onProp);
        }
        for (let i = 0; i < this.pairs; i++) this.collide(this.pairA[i], this.pairB[i]);
      }
      let dead = false;
      for (let i = 0; i < awake.length; i++) {
        const c = awake[i];
        this.settle(c, dt);
        c.lights = c.driver !== null && night > 0.5 && !c.sunk;
        if (c.dead) dead = true;
      }
      if (dead) for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
    }
    this.pairs = 0;
    this.sync(night);
  }

  /** Once a frame: which cars could touch during it. Awake pairs are listed once; sleepers only against the awake. */
  private findPairs(dt: number): void {
    const list = this.cars, awake = this.awake;
    let n = 0;
    for (let i = 0; i < awake.length; i++) {
      const a = awake[i];
      const reachA = a.rad + (Math.abs(a.vx) + Math.abs(a.vz)) * dt + 0.5;
      for (let j = 0; j < list.length; j++) {
        const b = list[j];
        if (b === a || (!b.asleep && b.id < a.id)) continue;
        const reach = reachA + b.rad + (b.asleep ? 0 : (Math.abs(b.vx) + Math.abs(b.vz)) * dt);
        const dx = b.x - a.x;
        if (dx > reach || dx < -reach) continue;
        const dz = b.z - a.z;
        if (dz > reach || dz < -reach) continue;
        this.pairA[n] = a; this.pairB[n] = b; n++;
      }
    }
    this.pairs = n;
  }

  // ── Driving ────────────────────────────────────────────────────────────────

  private step(c: Car, dt: number): void {
    const sp = c.spec, ctl = c.ctl;
    let sh = Math.sin(c.h), ch = Math.cos(c.h);
    let vf = c.vx * sh + c.vz * ch;
    let vr = -c.vx * ch + c.vz * sh;
    const driven = c.driver !== null;
    const throttle = driven ? clamp(ctl.accel, -1, 1) : 0;
    const wish = driven ? clamp(ctl.steer, -1, 1) : 0;
    const hb = driven && ctl.handbrake;
    const absV = Math.abs(vf);
    if (c.loose > 0) c.loose -= dt;
    if (c.hitT > 0) c.hitT -= dt;

    // Keys are all-or-nothing, so the wheel is turned for the player: briskly
    // toward the wish, faster back to center, more gently the faster the car goes.
    const turningIn = wish * c.steerPos >= 0 && Math.abs(wish) > Math.abs(c.steerPos);
    const rate = (turningIn ? 5.5 - 3 * clamp01(absV / sp.topSpeed) : 8.5) * dt;
    const ds = wish - c.steerPos;
    c.steerPos += ds > rate ? rate : ds < -rate ? -rate : ds;

    const gripBase = sp.grip * (1 - 0.22 * this.wet);
    const speed2 = vf * vf + vr * vr;

    if (c.onF || c.onR) {
      // The steering limit narrows with speed so the cornering force asked for
      // never exceeds what the tires give. A sliding car is allowed more lock:
      // that is what lets a drift be held and a handbrake turn come round.
      const free = c.sliding || hb;
      const tanMax = Math.tan(sp.steer);
      const tanLim = Math.min(tanMax, gripBase * (free ? 3.6 : CORNER) * sp.wheelbase / (vf * vf + 0.01));
      const tanS = c.steerPos * tanLim;
      c.steerAng = Math.atan(c.steerPos * Math.max(tanLim, 0.16));

      // Engine, brakes, drag.
      const a0 = sp.accel * ACCEL_K * (ACCEL_TUNE[sp.kind] ?? 1);
      let along = 0, brake = 0;
      c.reversing = false;
      if (throttle > 0) {
        if (vf < -0.6) brake = throttle;
        else { const u = vf / (sp.topSpeed * OVERRUN); along = throttle * a0 * (1 - u * u) * clamp01((sp.topSpeed - vf) / (0.01 * sp.topSpeed)); }
      } else if (throttle < 0) {
        if (vf > 0.6) brake = -throttle;
        else { const u = vf / (sp.topSpeed * 0.3); along = throttle * a0 * 0.8 * Math.max(0, 1 - u * u); c.reversing = true; }
      }
      // Feet off: engine braking and drag bring it to rest in a block or so. A car nobody is in sits in gear.
      let drag = throttle === 0 ? 1.5 + 0.045 * absV : 0.15;
      drag += brake * sp.brake * (1 - 0.15 * this.wet);
      if (hb) drag += sp.brake * 0.5;
      if (!driven) drag += 5;
      c.braking = brake > 0.05 || hb;
      // Hills: the part of gravity along the slope.
      const slope = (c.yF - c.yR) / sp.wheelbase;
      along -= GRAV * slope / Math.sqrt(1 + slope * slope);
      vf += along * dt;
      const dv = drag * dt;
      c.along = along - (absV > 0.5 ? (vf > 0 ? drag : -drag) : 0);
      if (vf > dv) vf -= dv; else if (vf < -dv) vf += dv; else vf = 0;

      // Tires. Sideways speed dies exponentially, but no faster than the tires
      // can physically push: without the cap a car turned broadside stops as if
      // it had hit glue.
      // Only the cars with power to spare break the rear loose: nobody wants a bus that drifts by accident.
      const power = sp.drive === 'rwd' && throttle > 0.8 && Math.abs(c.steerPos) > 0.45 && vf > 1.5 && vf < 15 ? clamp01((sp.accel - 6) / 3) : 0;
      let grip = gripBase;
      if (hb) grip *= 0.25; else if (c.sliding || c.loose > 0) grip *= 0.5; else grip *= 1 - 0.5 * power;
      const cap = gripBase * 1.75 * (hb ? 0.5 : c.sliding ? 0.75 : 1) * dt;
      const avr = Math.abs(vr);
      let dvr = avr * (1 - Math.exp(-grip * dt));
      if (dvr > cap) dvr = cap;
      vr += vr > 0 ? -dvr : dvr;

      if (!c.sliding) { if (avr > SLIDE_IN && speed2 > 16) c.sliding = true; }
      else if ((avr < SLIDE_OUT && !hb) || speed2 < 4) c.sliding = false;

      // Heading.
      if (c.onF) {
        let yawWish = -vf * tanS / sp.wheelbase;
        yawWish *= 1 + 0.5 * power;
        // A sliding car weathervanes: left alone, the nose swings back to the way it is going.
        if (c.sliding && !hb) yawWish -= ALIGN * (vr / Math.sqrt(speed2 + 4)) * clamp(vf / 3, -1, 1);
        const lazy = c.sliding || hb || c.loose > 0;
        // Steering against the spin is answered at once: that is the catch. A spin
        // that is already turning carries on by itself for a while, which is what
        // takes a handbrake turn past ninety degrees after the nose has stopped leading.
        const fading = Math.abs(yawWish) < Math.abs(c.yawRate);
        const k = !lazy ? 14 : yawWish * c.yawRate < 0 ? 9 : fading ? (hb ? 1.3 : 3) : 6;
        c.yawRate = damp(c.yawRate, yawWish, k, dt);
      }

      const launch = sp.drive === 'rwd' && throttle > 0.9 && vf < 6 && a0 > 5.5 ? (1 - Math.max(vf, 0) / 6) * 0.6 : 0;
      c.slip = clamp01(Math.max((avr - 1.5) / 5, hb && speed2 > 9 ? 0.6 : 0, launch));
    } else {
      // In the air nothing steers and nothing pushes.
      c.yawRate *= Math.exp(-0.5 * dt);
      c.slip = 0; c.along = 0;
      c.steerAng = Math.atan(c.steerPos * 0.3);
    }

    c.vx = sh * vf - ch * vr;
    c.vz = ch * vf + sh * vr;
    c.h += c.yawRate * dt;
    sh = Math.sin(c.h); ch = Math.cos(c.h);

    let nx = c.x + c.vx * dt, nz = c.z + c.vz * dt;
    const bd = this.game.plan.bounds;
    if (nx < bd.x0) { nx = bd.x0; if (c.vx < 0) c.vx = 0; } else if (nx > bd.x1) { nx = bd.x1; if (c.vx > 0) c.vx = 0; }
    if (nz < bd.z0) { nz = bd.z0; if (c.vz < 0) c.vz = 0; } else if (nz > bd.z1) { nz = bd.z1; if (c.vz > 0) c.vz = 0; }

    // Ground that rises more than a wheel can climb is a wall: the back of a
    // ramp, the side of the pier. Probe the leading bumper and both flanks.
    const half = sp.wheelbase / 2, t = sp.track / 2;
    const lead = vf >= 0 ? 1 : -1;
    const gLead = groundAt(nx + sh * lead * c.hl, nz + ch * lead * c.hl);
    let gl = groundAt(nx + ch * t, nz - sh * t);
    let gr = groundAt(nx - ch * t, nz + sh * t);
    let blocked = false;
    // The bumper is ahead of the axle, so on a ramp the ground under it is honestly higher: allow for that, or the bus cannot climb one.
    if (gLead > (lead > 0 ? c.yF : c.yR) + WALL + (c.hl - half) * 0.45) blocked = this.wall(c, nx + sh * lead * c.hl, nz + ch * lead * c.hl, -sh * lead, -ch * lead) || blocked;
    if (gl > c.y + WALL) blocked = this.wall(c, nx + ch * t, nz - sh * t, -ch, sh) || blocked;
    if (gr > c.y + WALL) blocked = this.wall(c, nx - ch * t, nz + sh * t, ch, -sh) || blocked;
    if (blocked) {
      nx = c.x; nz = c.z;
      gl = groundAt(nx + ch * t, nz - sh * t);
      gr = groundAt(nx - ch * t, nz + sh * t);
    }
    const moved = Math.hypot(nx - c.x, nz - c.z);
    const ux = moved > 1e-6 ? (nx - c.x) / moved : sh, uz = moved > 1e-6 ? (nz - c.z) / moved : ch;
    c.x = nx; c.z = nz;

    // Axles.
    const wasAir = c.airTime;
    const onF0 = c.onF, onR0 = c.onR;
    const fx = nx + sh * half, fz = nz + ch * half, rx = nx - sh * half, rz = nz - ch * half;
    let land = 0;
    {
      const g = groundAt(fx, fz);
      // An axle in the air while the other is planted is held up by the chassis, mostly.
      let vy = c.vyF - GRAV * (onR0 && !onF0 ? 0.3 : 1) * dt;
      let y = c.yF + vy * dt;
      if (y <= g + (onF0 ? 0.02 : 0)) {
        const f = this.follow(g, c.gF, c.vyF, moved, dt, fx, fz, ux, uz);
        if (!onF0) land = Math.max(land, f - vy);
        y = g; vy = f; c.onF = true;
      } else c.onF = false;
      c.yF = y; c.vyF = vy; c.gF = g;
    }
    {
      const g = groundAt(rx, rz);
      let vy = c.vyR - GRAV * (onF0 && !onR0 ? 0.3 : 1) * dt;
      let y = c.yR + vy * dt;
      if (y <= g + (onR0 ? 0.02 : 0)) {
        const f = this.follow(g, c.gR, c.vyR, moved, dt, rx, rz, ux, uz);
        if (!onR0) land = Math.max(land, f - vy);
        y = g; vy = f; c.onR = true;
      } else c.onR = false;
      c.yR = y; c.vyR = vy; c.gR = g;
    }
    c.onGround = c.onF || c.onR;
    if (c.onGround) {
      c.airTime = 0;
      if (land > 1.2 && wasAir > 0.08) {
        c.suspV += Math.min(land, 14) * 0.2;
        if (land > 6.5) this.impact(c, land * 0.45, null, c.x, c.z, land > 11 ? (land - 11) * 2 : 0);
      }
    } else {
      if (c.airTime === 0) {
        // The front left the lip first and has been falling longer. Left alone that
        // difference keeps turning the car over all the way down; keep only a little of it.
        const mid = (c.vyF + c.vyR) / 2;
        c.vyF = mid + (c.vyF - mid) * 0.3; c.vyR = mid + (c.vyR - mid) * 0.3;
      }
      c.airTime += dt;
      // The slow nose-down every thrown car does.
      const drop = 0.13 * half * dt;
      c.yF -= drop; c.yR += drop;
    }
    // The axles are independent, so nothing but this keeps the car from standing on its tail.
    const maxD = sp.wheelbase * 0.62, d = c.yF - c.yR;
    if (d > maxD) { c.yF -= (d - maxD) / 2; c.yR += (d - maxD) / 2; }
    else if (d < -maxD) { c.yF -= (d + maxD) / 2; c.yR += (d + maxD) / 2; }

    c.y = (c.yF + c.yR) / 2;
    c.vy = (c.vyF + c.vyR) / 2;
    c.pitch = Math.atan2(c.yF - c.yR, sp.wheelbase);
    if (c.onF && c.onR) {
      // A flank hanging over a drop (the pier's edge) must not tip the car into it.
      gl = Math.max(gl, c.y - 0.35); gr = Math.max(gr, c.y - 0.35);
      c.groundRoll = damp(c.groundRoll, clamp(Math.atan2(gl - gr, sp.track), -0.5, 0.5), 12, dt);
      c.lift = damp(c.lift, clamp((gl + gr) / 2 - c.y, -0.2, 0.2), 14, dt);
    } else {
      c.groundRoll = damp(c.groundRoll, 0, 1.2, dt);
      c.lift = damp(c.lift, 0, 6, dt);
    }
    c.roll = c.groundRoll;

    if (c.y < WATER_Y + 0.15 && isWater(c.x, c.z)) {
      c.sunk = true;
      c.sinkT = 0;
      c.onGround = c.onF = c.onR = false;
      c.sliding = false; c.slip = 0; c.braking = false; c.reversing = false;
      this.game.emit('splash', { x: c.x, z: c.z, big: true });
    }
  }

  /**
   * The vertical speed an axle takes from the ground it has just met.
   * On a slope that is the rate the ground is rising, which is what launches a
   * car off a ramp. A curb rises just as fast for one step, so a steep rise is
   * checked a stride ahead: a ramp keeps climbing, a curb is already over, and
   * the curb gets a small kick instead of a launch.
   */
  private follow(g: number, gPrev: number, vyPrev: number, moved: number, dt: number, x: number, z: number, ux: number, uz: number): number {
    const rise = g - gPrev;
    if (rise > 0.12 * moved + 0.004) {
      if (groundAt(x + ux * 0.4, z + uz * 0.4) - g > 0.035) return Math.min(rise / dt, 0.6 * moved / dt + 0.5);
      return Math.max(vyPrev > 0 ? vyPrev : 0, Math.min(rise * 5, 0.9));
    }
    return Math.max(rise / dt, -40);
  }

  /** Stop against ground too steep to climb. n points away from it. Returns true if the car was moving into it. */
  private wall(c: Car, px: number, pz: number, nx: number, nz: number): boolean {
    const vn = c.vx * nx + c.vz * nz;
    if (vn >= 0) return false;
    c.vx -= (1 + RESTITUTION) * vn * nx;
    c.vz -= (1 + RESTITUTION) * vn * nz;
    c.yawRate *= 0.6;
    if (-vn > HARD_HIT) this.impact(c, -vn, null, px, pz, (-vn - HARD_HIT) * DAMAGE);
    return true;
  }

  private impact(c: Car, speed: number, other: Car | null, x: number, z: number, damage: number): void {
    if (c.hitT > 0) return;
    c.hitT = 0.2;
    c.health = Math.max(0, c.health - damage);
    this.game.emit('impact', { vehicle: c, speed, other, x, z });
  }

  /** Deep water: the engine is dead, the car bobs, fills and goes down. */
  private sink(c: Car, dt: number): void {
    c.sinkT += dt;
    const k = Math.exp(-1.8 * dt);
    c.vx *= k; c.vz *= k; c.yawRate *= k;
    c.x += c.vx * dt; c.z += c.vz * dt; c.h += c.yawRate * dt;
    const f = smooth(c.sinkT / 5), sp = c.spec;
    const floor = groundAt(c.x, c.z);
    const bob = Math.sin(c.sinkT * 3.2) * 0.04 * (1 - f);
    const level = Math.max(floor, WATER_Y - 0.3 - f * (sp.height + 0.15) + bob);
    // Engine first: the nose goes down ahead of the tail.
    const tip = Math.sin(f * Math.PI) * 0.28 * sp.wheelbase / 2;
    c.yF = damp(c.yF, Math.max(floor, level - tip), 4, dt);
    c.yR = damp(c.yR, level + tip * 0.4, 4, dt);
    c.vyF = c.vyR = 0;
    c.y = (c.yF + c.yR) / 2; c.vy = 0;
    c.pitch = Math.atan2(c.yF - c.yR, sp.wheelbase);
    c.groundRoll = damp(c.groundRoll, Math.sin(c.sinkT * 2.1) * 0.05 * (1 - f), 3, dt);
    c.roll = c.groundRoll;
    c.lift = 0; c.airTime = 0; c.slip = 0; c.along = 0;
    // The player's car stays until the player code has dealt with whoever is inside.
    if (c.sinkT > 5 && c.driver !== 'player') c.dead = true;
  }

  /** Once a frame: the body's sway on its springs, wheel spin, and whether the car may go back to sleep. */
  private settle(c: Car, dt: number): void {
    const sp = c.spec;
    const vf = c.speed;
    // In the air the wheels hang: the body rides a little high on them.
    const acc = ((c.onGround || c.sunk ? 0 : -0.06) - c.susp) * 150 - c.suspV * 15;
    c.suspV += acc * dt;
    c.susp += c.suspV * dt;
    if (c.susp > 0.15) { c.susp = 0.15; c.suspV = 0; } else if (c.susp < -0.08) { c.susp = -0.08; c.suspV = 0; }
    const lat = c.onGround ? c.yawRate * vf : 0;
    c.rollV = damp(c.rollV, clamp(lat * 0.0075, -0.08, 0.08), 7, dt);
    c.pitchV = damp(c.pitchV, clamp(c.along * 0.0055, -0.07, 0.05), 7, dt);
    const turn = vf * dt / sp.wheelR;
    c.spinF = (c.spinF + turn) % (Math.PI * 2);
    // The handbrake locks the rear wheels.
    if (!(c.driver !== null && c.ctl.handbrake && c.onGround)) c.spinR = (c.spinR + turn) % (Math.PI * 2);
    c.stale = true;

    const still = c.driver === null && !c.sunk && c.onF && c.onR && c.vx * c.vx + c.vz * c.vz < 0.01
      && Math.abs(c.yawRate) < 0.02 && Math.abs(c.susp) < 0.004 && Math.abs(c.suspV) < 0.03;
    c.rest = still ? c.rest + dt : 0;
    if (c.rest > 0.5) this.sleep(c);
  }

  // ── Collisions ─────────────────────────────────────────────────────────────

  /**
   * Bounce the current car off something that does not move. (px, pz) is the
   * point of contact and n points from the obstacle toward the car. An
   * off-center hit turns the car, which is what makes a glancing blow slide
   * along a wall instead of stopping dead.
   */
  private bounce(c: Car, px: number, pz: number, nx: number, nz: number): void {
    const rx = px - c.x, rz = pz - c.z;
    const vn = (c.vx + c.yawRate * rz) * nx + (c.vz - c.yawRate * rx) * nz;
    if (vn >= 0) return;
    const rn = rz * nx - rx * nz;
    const j = -(1 + RESTITUTION) * vn / (c.invM + rn * rn * c.invI);
    c.vx += j * nx * c.invM; c.vz += j * nz * c.invM;
    c.yawRate += rn * j * c.invI;
    // Scraping costs a little speed along the wall, never more than the hit was hard.
    const tx = -nz, tz = nx, vt = c.vx * tx + c.vz * tz;
    const rub = Math.min(Math.abs(vt), 0.22 * j * c.invM);
    c.vx -= (vt > 0 ? rub : -rub) * tx; c.vz -= (vt > 0 ? rub : -rub) * tz;
    if (-vn > 2) c.loose = Math.max(c.loose, 0.35);
    if (-vn > HARD_HIT) this.impact(c, -vn, null, px, pz, (-vn - HARD_HIT) * DAMAGE);
  }

  private onBox = (b: Box): void => {
    const c = this.cur, sh = this.curS, ch = this.curC;
    if (c.y > b.y1 - 0.3 || c.y + c.spec.height < b.y0) return;
    const ex = (b.x1 - b.x0) / 2, ez = (b.z1 - b.z0) / 2;
    const dx = c.x - (b.x0 + ex), dz = c.z - (b.z0 + ez);
    const ash = Math.abs(sh), ach = Math.abs(ch);
    // Separating axes: the wall's two and the car's two. The shallowest overlap is the way out.
    const oX = ex + c.hl * ash + c.hw * ach - Math.abs(dx);
    if (oX <= 0) return;
    const oZ = ez + c.hl * ach + c.hw * ash - Math.abs(dz);
    if (oZ <= 0) return;
    const df = dx * sh + dz * ch, dr = -dx * ch + dz * sh;
    const oF = c.hl + ex * ash + ez * ach - Math.abs(df);
    if (oF <= 0) return;
    const oR = c.hw + ex * ach + ez * ash - Math.abs(dr);
    if (oR <= 0) return;
    let nx: number, nz: number, o: number, px: number, pz: number;
    if (Math.min(oX, oZ) <= Math.min(oF, oR) + 0.01) {
      // A face of the wall: the contact is the car's corner (or edge) buried deepest in it.
      if (oX < oZ) { nx = dx < 0 ? -1 : 1; nz = 0; o = oX; } else { nx = 0; nz = dz < 0 ? -1 : 1; o = oZ; }
      const fn = sh * nx + ch * nz, rn = -ch * nx + sh * nz;
      const sf = Math.abs(fn) < 0.04 ? 0 : fn > 0 ? -1 : 1, sr = Math.abs(rn) < 0.04 ? 0 : rn > 0 ? -1 : 1;
      px = c.x + sh * c.hl * sf - ch * c.hw * sr;
      pz = c.z + ch * c.hl * sf + sh * c.hw * sr;
    } else {
      // A corner of the wall has come in through the car's side or end.
      if (oF < oR) { const s = df < 0 ? -1 : 1; nx = sh * s; nz = ch * s; o = oF; } else { const s = dr < 0 ? -1 : 1; nx = -ch * s; nz = sh * s; o = oR; }
      px = b.x0 + ex + (Math.abs(nx) < 0.04 ? 0 : nx > 0 ? ex : -ex);
      pz = b.z0 + ez + (Math.abs(nz) < 0.04 ? 0 : nz > 0 ? ez : -ez);
    }
    c.x += nx * o; c.z += nz * o;
    this.bounce(c, px + nx * o, pz + nz * o, nx, nz);
  };

  private onProp = (p: Prop): void => {
    const c = this.cur, sh = this.curS, ch = this.curC;
    if (c.y > p.h) return;
    const dx = p.x - c.x, dz = p.z - c.z;
    const lf = dx * sh + dz * ch, lr = -dx * ch + dz * sh;
    const ef = lf - clamp(lf, -c.hl, c.hl), er = lr - clamp(lr, -c.hw, c.hw);
    const d2 = ef * ef + er * er;
    if (d2 >= p.r * p.r) return;
    if (p.breakable && c.vx * c.vx + c.vz * c.vz > 4) {
      this.game.col.breakProp(p, c.vx, c.vz);
      c.vx *= 0.975; c.vz *= 0.975;
      return;
    }
    // Solid: a wall one post wide. The normal runs from the post to the nearest point of the body.
    let nf: number, nr: number, pen: number;
    if (d2 > 1e-6) { const d = Math.sqrt(d2); nf = -ef / d; nr = -er / d; pen = p.r - d; }
    else if (c.hl - Math.abs(lf) < c.hw - Math.abs(lr)) { nf = lf < 0 ? 1 : -1; nr = 0; pen = c.hl - Math.abs(lf) + p.r; }
    else { nf = 0; nr = lr < 0 ? 1 : -1; pen = c.hw - Math.abs(lr) + p.r; }
    const nx = nf * sh - nr * ch, nz = nf * ch + nr * sh;
    c.x += nx * pen; c.z += nz * pen;
    this.bounce(c, p.x, p.z, nx, nz);
  };

  /** Car against car: find the shallowest way apart, part them by weight, and trade momentum at the point of contact. */
  private collide(a: Car, b: Car): void {
    const dx = b.x - a.x, dz = b.z - a.z, reach = a.rad + b.rad;
    if (dx * dx + dz * dz > reach * reach) return;
    if (a.y > b.y + b.spec.height || b.y > a.y + a.spec.height) return;
    const sa = Math.sin(a.h), ca = Math.cos(a.h), sb = Math.sin(b.h), cb = Math.cos(b.h);
    const c = Math.abs(sa * sb + ca * cb), s = Math.abs(ca * sb - sa * cb);
    const dfa = dx * sa + dz * ca, dra = -dx * ca + dz * sa, dfb = dx * sb + dz * cb, drb = -dx * cb + dz * sb;
    const o0 = a.hl + b.hl * c + b.hw * s - Math.abs(dfa);
    if (o0 <= 0) return;
    const o1 = a.hw + b.hl * s + b.hw * c - Math.abs(dra);
    if (o1 <= 0) return;
    const o2 = b.hl + a.hl * c + a.hw * s - Math.abs(dfb);
    if (o2 <= 0) return;
    const o3 = b.hw + a.hl * s + a.hw * c - Math.abs(drb);
    if (o3 <= 0) return;
    // n points from a to b.
    let nx: number, nz: number, o = o0;
    { const k = dfa < 0 ? -1 : 1; nx = sa * k; nz = ca * k; }
    if (o1 < o) { o = o1; const k = dra < 0 ? -1 : 1; nx = -ca * k; nz = sa * k; }
    if (o2 < o) { o = o2; const k = dfb < 0 ? -1 : 1; nx = sb * k; nz = cb * k; }
    if (o3 < o) { o = o3; const k = drb < 0 ? -1 : 1; nx = -cb * k; nz = sb * k; }

    // Contact: the average of whichever corners are inside the other car.
    let px = 0, pz = 0, cnt = 0;
    for (let i = 0; i < 4; i++) {
      const f = i < 2 ? 1 : -1, r = i % 2 ? 1 : -1;
      let qx = a.x + sa * a.hl * f - ca * a.hw * r, qz = a.z + ca * a.hl * f + sa * a.hw * r;
      let ex = qx - b.x, ez = qz - b.z;
      if (Math.abs(ex * sb + ez * cb) <= b.hl + 0.02 && Math.abs(-ex * cb + ez * sb) <= b.hw + 0.02) { px += qx; pz += qz; cnt++; }
      qx = b.x + sb * b.hl * f - cb * b.hw * r; qz = b.z + cb * b.hl * f + sb * b.hw * r;
      ex = qx - a.x; ez = qz - a.z;
      if (Math.abs(ex * sa + ez * ca) <= a.hl + 0.02 && Math.abs(-ex * ca + ez * sa) <= a.hw + 0.02) { px += qx; pz += qz; cnt++; }
    }
    if (cnt > 0) { px /= cnt; pz /= cnt; } else { px = (a.x + b.x) / 2; pz = (a.z + b.z) / 2; }

    const im = a.invM + b.invM;
    const pa = o * a.invM / im, pb = o * b.invM / im;
    a.x -= nx * pa; a.z -= nz * pa;
    b.x += nx * pb; b.z += nz * pb;
    if (b.asleep) { b.asleep = false; b.stale = true; }

    const rax = px - a.x, raz = pz - a.z, rbx = px - b.x, rbz = pz - b.z;
    const vn = ((b.vx + b.yawRate * rbz) - (a.vx + a.yawRate * raz)) * nx + ((b.vz - b.yawRate * rbx) - (a.vz - a.yawRate * rax)) * nz;
    if (vn >= 0) return;
    const rna = raz * nx - rax * nz, rnb = rbz * nx - rbx * nz;
    const j = -(1 + RESTITUTION) * vn / (im + rna * rna * a.invI + rnb * rnb * b.invI);
    a.vx -= j * nx * a.invM; a.vz -= j * nz * a.invM; a.yawRate -= rna * j * a.invI;
    b.vx += j * nx * b.invM; b.vz += j * nz * b.invM; b.yawRate += rnb * j * b.invI;
    // Paint rubbing on paint.
    const tx = -nz, tz = nx;
    const vt = (b.vx - a.vx) * tx + (b.vz - a.vz) * tz;
    const jt = clamp(-vt / im, -0.25 * j, 0.25 * j);
    a.vx -= jt * tx * a.invM; a.vz -= jt * tz * a.invM;
    b.vx += jt * tx * b.invM; b.vz += jt * tz * b.invM;
    const closing = -vn;
    if (closing > 2) { a.loose = Math.max(a.loose, 0.4); b.loose = Math.max(b.loose, 0.4); }
    if (closing > HARD_HIT) {
      // The lighter car takes the larger share of the damage.
      const dmg = (closing - HARD_HIT) * DAMAGE;
      b.health = Math.max(0, b.health - dmg * b.invM / im);
      this.impact(a, closing, b, px, pz, dmg * a.invM / im);
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private batch(kind: VehicleKind): KindBatch {
    let b = this.batches.get(kind);
    if (b) return b;
    const model = vehicleModel(kind);
    const cap = Math.max(8, Math.ceil(SPECS[kind].common * 8));
    b = { kind, model, cap, n: 0, near: 0, paint: null!, trim: null!, glass: null! };
    this.makeMeshes(b);
    this.batches.set(kind, b);
    this.batchList.push(b);
    return b;
  }

  private makeMeshes(b: KindBatch): void {
    const scene = this.game.scene, shadows = this.game.quality.shadows;
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, mat, b.cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances are spread over the whole island; culling is done by hand in sync().
      m.frustumCulled = false;
      m.castShadow = shadows; m.receiveShadow = shadows;
      m.count = 0;
      m.onBeforeShadow = () => { m.count = b.near; };
      m.onAfterShadow = () => { m.count = b.n; };
      scene.add(m);
      return m;
    };
    b.paint = make(b.model.paint, this.paintMat);
    b.paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    b.trim = make(b.model.trim, this.trimMat);
    b.glass = make(b.model.glass, b.model.glass.hasAttribute('color') ? this.glassTintMat : this.glassMat);
  }

  private grow(b: KindBatch): void {
    for (const m of [b.paint, b.trim, b.glass]) { this.game.scene.remove(m); m.dispose(); }
    b.cap *= 2;
    this.makeMeshes(b);
  }

  private makeWheels(cap: number): THREE.InstancedMesh {
    const shadows = this.game.quality.shadows;
    const m = new THREE.InstancedMesh(this.wheelGeo, this.wheelMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = shadows; m.receiveShadow = shadows;
    m.count = 0;
    m.onBeforeShadow = () => { m.count = this.wheelsNear; };
    m.onAfterShadow = () => { m.count = this.wheelsAll; };
    this.game.scene.add(m);
    return m;
  }

  /** Rebuild one car's cached matrices: the body on its springs, and each wheel on the ground under its corner. */
  private pose(c: Car): void {
    const sp = c.spec, ws = c.batch.model.wheels;
    _e.set(-(c.pitch + c.pitchV), c.h, c.groundRoll + c.rollV);
    _q.setFromEuler(_e);
    _p.set(c.x, c.y + c.lift - c.susp, c.z);
    _m.compose(_p, _q, _one);
    _m.toArray(c.mat);
    // The wheels follow the road, not the body, so the gap in the arches opens and closes.
    _e.set(-c.pitch, c.h, c.groundRoll);
    _qg.setFromEuler(_e);
    _s.set(sp.wheelW, sp.wheelR, sp.wheelR);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i], left = w.x > 0, front = i < 2;
      _p.copy(w).applyQuaternion(_qg);
      _p.x += c.x; _p.y += c.y + c.lift; _p.z += c.z;
      // Right-hand wheels are turned about so the same hub faces outward, which reverses their spin.
      _qw.setFromAxisAngle(Y_AXIS, (front ? -c.steerAng : 0) + (left ? 0 : Math.PI));
      _qs.setFromAxisAngle(X_AXIS, (front ? c.spinF : c.spinR) * (left ? 1 : -1));
      _q.copy(_qg).multiply(_qw).multiply(_qs);
      _m.compose(_p, _q, _s);
      _m.toArray(c.wmat, i * 16);
    }
    c.stale = false;
  }

  /** Write the instance buffers for every car near enough to matter, and the lamps of the ones that are lit. */
  private sync(night: number): void {
    const game = this.game;
    const cam = game.view ? game.view.pos : game.camera.position;
    const far = game.quality.drawDist * 0.7, far2 = far * far;
    const glow = this.glow, pool = this.pool;
    for (const b of this.batchList) b.n = 0;
    glow.n = 0; pool.n = 0;
    let nw = 0;
    let wheelArr = this.wheels.instanceMatrix.array as Float32Array;

    // Two passes so the cars near enough to throw a shadow into view come first in every buffer: the shadow pass
    // then draws only that head of the list (see makeMeshes), and everything farther is culled against the view.
    // The frustum is a frame old (the camera moves after the cars do), so it is taken with a wider lens.
    const focus = game.cam ? game.cam.focus : cam;
    if (game.view) { game.camera.position.copy(game.view.pos); game.camera.lookAt(game.view.target); }
    game.camera.updateMatrixWorld();
    _cullCam.fov = Math.min(150, game.camera.fov + 30); _cullCam.aspect = game.camera.aspect;
    _cullCam.updateProjectionMatrix();
    _pv.multiplyMatrices(_cullCam.projectionMatrix, game.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < this.cars.length; k++) {
      const c = this.cars[k];
      const fx = focus.x - c.x, fz = focus.z - c.z, near = fx * fx + fz * fz < SHADOW_R2;
      if (near !== (pass === 0)) continue;
      const dx = cam.x - c.x, dz = cam.z - c.z, dy = cam.y - c.y, d2 = dx * dx + dz * dz, d3 = d2 + dy * dy;
      if (d3 > far2) continue;
      if (!near) {
        _sphere.center.set(c.x, c.y + 1, c.z); _sphere.radius = c.spec.length * 0.5 + 1.5;
        if (!_frustum.intersectsSphere(_sphere)) continue;
      }
      if (c.stale) this.pose(c);
      const b = c.batch;
      if (b.n >= b.cap) this.growKeeping(b);
      const i = b.n++;
      (b.paint.instanceMatrix.array as Float32Array).set(c.mat, i * 16);
      (b.trim.instanceMatrix.array as Float32Array).set(c.mat, i * 16);
      (b.glass.instanceMatrix.array as Float32Array).set(c.mat, i * 16);
      if (c.color !== c.shown) { _col.setHex(c.color); c.cr = _col.r; c.cg = _col.g; c.cb = _col.b; c.shown = c.color; }
      const ca = b.paint.instanceColor!.array as Float32Array;
      ca[i * 3] = c.cr; ca[i * 3 + 1] = c.cg; ca[i * 3 + 2] = c.cb;

      // Past a few hundred meters a wheel is a pixel in the shade of its arch.
      if (d3 < WHEEL_R2) {
        const nWheels = c.wmat.length / 16;
        if (nw + nWheels > this.wheelCap) {
          const old = this.wheels;
          this.wheelCap *= 2;
          this.wheels = this.makeWheels(this.wheelCap);
          (this.wheels.instanceMatrix.array as Float32Array).set((old.instanceMatrix.array as Float32Array).subarray(0, nw * 16));
          game.scene.remove(old); old.dispose();
          wheelArr = this.wheels.instanceMatrix.array as Float32Array;
        }
        wheelArr.set(c.wmat, nw * 16);
        nw += nWheels;
      }

      if ((c.lights || c.braking || c.reversing) && d2 < 62500) this.lamps(c, dx, dz, Math.sqrt(d2), night);
    }
    if (pass === 0) { for (const b of this.batchList) b.near = b.n; this.wheelsNear = nw; }
    }

    for (const b of this.batchList) {
      const on = b.n > 0;
      b.paint.count = b.trim.count = b.glass.count = b.n;
      b.paint.visible = b.trim.visible = b.glass.visible = on;
      if (!on) continue;
      b.paint.instanceMatrix.needsUpdate = b.trim.instanceMatrix.needsUpdate = b.glass.instanceMatrix.needsUpdate = true;
      b.paint.instanceColor!.needsUpdate = true;
    }
    this.wheels.count = this.wheelsAll = nw;
    this.wheels.visible = nw > 0;
    this.wheels.instanceMatrix.needsUpdate = true;
    glow.flush(); pool.flush();
  }

  /** Growing replaces the meshes, so carry over what this frame has already written. */
  private growKeeping(b: KindBatch): void {
    const pm = b.paint.instanceMatrix.array as Float32Array, pc = b.paint.instanceColor!.array as Float32Array;
    this.grow(b);
    for (const m of [b.paint, b.trim, b.glass]) (m.instanceMatrix.array as Float32Array).set(pm);
    (b.paint.instanceColor!.array as Float32Array).set(pc);
  }

  /** Glow sprites at the lamp positions. They only show from the side they shine toward. */
  private lamps(c: Car, dx: number, dz: number, dist: number, night: number): void {
    const model = c.batch.model, m = c.mat, glow = this.glow;
    // +1 when the camera is dead ahead of the car, -1 dead astern.
    const facing = dist > 0.01 ? (dx * Math.sin(c.h) + dz * Math.cos(c.h)) / dist : 0;
    const grow = 1 + dist / 110;
    const fade = 1 - smooth((dist - 170) / 80);
    const ahead = smooth((facing + 0.15) / 0.6) * fade, astern = smooth((-facing + 0.15) / 0.6) * fade;
    if (c.lights && ahead > 0.01) {
      const s = 1.0 * grow, k = ahead;
      for (const l of model.head) {
        glow.add(m[0] * l.x + m[4] * l.y + m[8] * l.z + m[12], m[1] * l.x + m[5] * l.y + m[9] * l.z + m[13], m[2] * l.x + m[6] * l.y + m[10] * l.z + m[14], k, k * 0.86, k * 0.58, s);
      }
    }
    if (astern > 0.01) {
      // Brake lamps show by day as well, only fainter against the sun.
      let r = 0, g = 0, b = 0, s = 0;
      if (c.braking) { const k = 0.75 + 0.6 * night; r = 1.5 * k; g = 0.1 * k; b = 0.05 * k; s = 0.85; }
      else if (c.reversing) { r = 0.8; g = 0.8; b = 0.72; s = 0.6; }
      else if (c.lights) { r = 0.6; g = 0.04; b = 0.02; s = 0.55; }
      if (s > 0) {
        s *= grow; r *= astern; g *= astern; b *= astern;
        for (const l of model.tail) {
          glow.add(m[0] * l.x + m[4] * l.y + m[8] * l.z + m[12], m[1] * l.x + m[5] * l.y + m[9] * l.z + m[13], m[2] * l.x + m[6] * l.y + m[10] * l.z + m[14], r, g, b, s);
        }
      }
    }
    if (c.lights && dist < 180) {
      const s = Math.sin(c.h), co = Math.cos(c.h), reach = c.hl - 0.4;
      // Held a hand above the street so it still shows where the beam climbs a curb.
      this.pool.add(c.x + s * reach, c.y + 0.2, c.z + co * reach, s, co, 0.3 * (1 - smooth((dist - 110) / 70)), 0);
    }
  }
}
