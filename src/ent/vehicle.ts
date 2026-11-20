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
import { loadVehicleAssets, SHEET_TEXELS, type CarMaps, type SendCell, type VehicleAsset } from './vehicleAssets';
import { BRIDGE, groundAt, terrainAt, WATER_Y } from '../world/plan';
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
// The sedan and the hatch are what a stranger drives first, so they get a little more than their sheet says.
const ACCEL_TUNE: Partial<Record<VehicleKind, number>> = { bus: 1.7, tow: 1.15, van: 1.1, sedan: 1.13, hatch: 1.14 };
/** Feet off the pedals, the heavy ones lose speed faster. */
const COAST: Partial<Record<VehicleKind, number>> = { bus: 1.5, tow: 1.5, van: 1.2 };
/** The engine's pull would run out this far past top speed; a governor cuts it at top speed instead, so cars reach their figure rather than creep up on it. */
const OVERRUN = 1.08;

/** Sideways speed (m/s) at which the tires let go, and the lower one at which they bite again. */
const SLIDE_IN = 2.6, SLIDE_OUT = 1.2;
/** Cornering force the steering may ask for, as a multiple of grip. Kept under SLIDE_IN so steering alone never spins a car. */
const CORNER = 1.45;
/** How hard a sliding car's nose is pulled back toward the way it is travelling, 1/s. */
const ALIGN = 2.2;
/** Car against car: enough bounce that a shunt sends the other one rolling. */
const RESTITUTION = 0.22;
/** Car against masonry: almost none, or a crash plays like a bumper car and throws the player back into the road. */
const WALL_REST = 0.07;
/** Water over the wheels deeper than this floats the car off; anything shallower is waded through. */
const DEEP = 0.9;
/** Seconds a ditched car ploughs into the sea before it is written off and the driver climbs out. */
const DITCH = 0.55;
const MARKS = 768, MARK_LIFE = 16, PUFFS = 96;
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

/** Blender models swap to their simpler level past LOD_OUT and back inside LOD_IN; the gap stops a car at the line flickering. */
const LOD_IN2 = 58 * 58, LOD_OUT2 = 64 * 64;
/** The showroom level (interior, lamp internals, brake discs) is for the few cars within arm's reach: the player's and its neighbours. */
const NEAR_IN2 = 13 * 13, NEAR_OUT2 = 16 * 16, NEAR_MAX = 4;

/**
 * Local reflections (high preset): a small cube of the street round the player, redrawn one face a frame every few
 * seconds or when the player has moved on, and handed to every car material in place of the bare sky. Measured on the
 * development machine (frame 6.4 ms): a face costs about 4 ms, the blur rebuild about 5, so a refresh is seven
 * heavier frames; hence every four seconds at rest, and no oftener than every 1.5 s however fast the player drives.
 */
const ENV_SIZE = 128, ENV_EVERY = 4, ENV_MOVE2 = 45 * 45, ENV_MIN = 1.5;

const _nearD = new Float32Array(NEAR_MAX), _nearC: (Car | null)[] = [null, null, null, null];

type Part = [geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean];

/** What one draw set is made of. Kept so the set can be rebuilt larger. */
interface SetParts {
  paint: Part;
  others: Part[];
  wheel: Part;
  /** The geometry whose lamp lenses take a per-instance glow, if any. */
  lampGeo: THREE.BufferGeometry | null;
}

/** One kind at one level of detail: the body meshes, which share a matrix buffer, and its wheels. */
interface DrawSet {
  parts: SetParts;
  /** Paint first. */
  body: THREE.InstancedMesh[];
  wheels: THREE.InstancedMesh;
  mats: Float32Array;
  cols: Float32Array;
  /** Per instance: dust, 0 to 1 (the paint shader's aDirt). */
  dirt: Float32Array;
  dirtAttr: THREE.InstancedBufferAttribute | null;
  wmats: Float32Array;
  /** Per instance: head, tail, brake, reverse; then left indicator, right indicator, daytime strip. */
  lamps: Float32Array | null;
  lamps2: Float32Array | null;
  lampAttr: THREE.InstancedBufferAttribute | null;
  lampAttr2: THREE.InstancedBufferAttribute | null;
  cap: number; wcap: number;
  n: number; nw: number;
  /** How many of the n instances (and nw wheels), counted from the front, are close enough to cast a shadow into view. */
  near: number; nwNear: number;
}

interface KindBatch {
  kind: VehicleKind;
  /** The procedural model: the fallback, and the source of whatever a file does not say. */
  proc: VehicleModel;
  /** What the rest of the game reads. Replaced when the kind's file arrives. */
  model: VehicleModel;
  /** One set, or nearest first for a Blender model above the low preset. */
  sets: DrawSet[];
  /** Which set draws a car at each of the three distances (showroom, street, far). */
  pick: [number, number, number];
  /** The file lights brake lamps as their own section. */
  sections: boolean;
  cap: number;
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
  /** Burnt out (ent/weapons.ts). Nobody drives a wreck, so it is inert already; this only says so. */
  wreck = false;
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
  /** In the sea but not yet written off: the half second of plough and spray before `sunk`. */
  ditch = false;
  dive = 0;
  /** Depth of water over the road under the wheels, m. */
  wade = 0;
  /** On sand or shore turf rather than paving. */
  soft = false;
  /** Seconds since the handbrake was let go, counted down from a short grace. */
  hbT = 0;
  // Skid marks: where each rear wheel last laid one.
  mkOn = false; mlx = 0; mlz = 0; mrx = 0; mrz = 0;
  puffT = 0;
  dead = false;
  // Render cache.
  stale = true;
  shown = -1; cr = 1; cg = 1; cb = 1;
  readonly mat = new Float32Array(16);
  readonly wmat: Float32Array;
  /** Which level of detail it was last drawn at: 0 showroom, 1 street, 2 far. */
  lod = 1;
  /** Frame stamp of the last frame it was among the few nearest the camera. */
  nearest = -1;
  /** Indicator: +1 left, -1 right, and when (game seconds) it cancels. */
  turn = 0; turnEnd = 0;
  /** How dusty it is, 0 showroom to 1 back from the quarry: fixed for the car's life, from its id. */
  dirt = 0;

  constructor(readonly id: number, readonly spec: VehicleSpec, readonly batch: KindBatch) {
    // Most cars are clean enough; a few have not seen a hose this year.
    const h = Math.abs(Math.sin(id * 127.1 + 311.7) * 43758.5453) % 1;
    this.dirt = h * h * (spec.kind === 'bolt' ? 0.3 : 0.9);
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

/** A one-channel canvas from a function of u (-1..1 across) and v (0 at the bottom to 1). */
function ramp(w: number, h: number, f: (u: number, v: number) => number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = Math.round(clamp01(f((x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h)) * 255);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}

/**
 * Two beams on the road that widen as they go, brightest a few meters ahead of
 * the bumper. v = 0 is the near end, and every edge reaches black: a quad that
 * ends while still lit is what made the old pool read as a disc of fog.
 */
function poolTexture(): THREE.CanvasTexture {
  return ramp(64, 128, (u, v) => {
    const w = 0.15 + 0.5 * v;
    const dl = (u + 0.2) / w, dr = (u - 0.2) / w;
    const across = Math.exp(-dl * dl * 2.2) + Math.exp(-dr * dr * 2.2);
    const along = smooth(v / 0.13) * Math.pow(1 - smooth((v - 0.2) / 0.8), 1.7);
    const edge = 1 - smooth((Math.abs(u) - 0.65) / 0.35);
    // The shader squares it.
    return Math.sqrt(Math.min(1, across * 0.62 * along * edge));
  });
}

/** The dark under a car: a soft-edged slab. */
function shadowTexture(): THREE.CanvasTexture {
  return ramp(32, 64, (u, v) => {
    const qx = Math.max(Math.abs(u) - 0.7, 0), qy = Math.max(Math.abs(v * 2 - 1) - 0.76, 0);
    return 1 - smooth(Math.hypot(qx / 0.3, qy / 0.24));
  });
}

/** Rubber on the road: soft across, uncut along, so one stretch butts onto the next. */
function markTexture(): THREE.CanvasTexture {
  return ramp(16, 4, (u) => 1 - smooth((Math.abs(u) - 0.45) / 0.55));
}

/** Smoke, dust and spray. */
function puffTexture(): THREE.CanvasTexture {
  return ramp(32, 32, (u, v) => { const r = Math.hypot(u, v * 2 - 1); return (1 - smooth(r)) * (1 - 0.35 * r); });
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
  // aCol.w picks the lamp: 0 the headlights' warm reach, 1 the short red wash under brake lamps.
  vCol = mix(vec3(1.0, 0.66, 0.27), vec3(1.0, 0.05, 0.02), aCol.w) * aCol.z;
  vec2 f = aCol.xy;
  vec2 r = vec2(-f.y, f.x);
  vec2 p = r * position.x * mix(6.6, 3.6, aCol.w) + f * (position.y + 0.5) * mix(16.5, 3.4, aCol.w);
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

// Dark or pale things laid on the road (shadows, rubber) or hung in the air (smoke): plain alpha, one tint for the lot.
const GROUND_VS = /* glsl */`
attribute vec3 aPos;
attribute vec4 aCol;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  vCol = vec3(aCol.w);
  // aCol.xy is the quad's long side as a vector on the ground, aCol.z its width.
  vec2 f = aCol.xy;
  vec2 r = normalize(vec2(-f.y, f.x)) * aCol.z;
  vec2 p = r * position.x + f * position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(aPos.x + p.x, aPos.y, aPos.z + p.y, 1.0);
}`;
const PUFF_VS = /* glsl */`
attribute vec3 aPos;
attribute vec4 aCol;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  vCol = vec3(aCol.x);
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  mv.xy += position.xy * aCol.w;
  gl_Position = projectionMatrix * mv;
}`;
const FLAT_FS = /* glsl */`
uniform sampler2D map;
uniform vec3 tint;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(tint, texture2D(map, vUv).r * vCol.x);
  #include <colorspace_fragment>
}`;

/** three.js's own text for one of its shader chunks, with one line of it changed; the chunk untouched if that line is not where it was. */
function chunk(name: keyof typeof THREE.ShaderChunk, after: string, line: string, to: string): string {
  const src = THREE.ShaderChunk[name], at = src.indexOf(after), i = at < 0 ? -1 : src.indexOf(line, at);
  return i < 0 ? src : src.slice(0, i) + to + src.slice(i + line.length);
}

/**
 * The sun in the lacquer. The coat's own lobe is a core about three degrees across, which on a bonnet is a spark a
 * few pixels long; a real coat carries a faint bloom round that core (fine scratches, the flake under it), and the
 * bloom is what lets the eye find the highlight and read the panel's curve from it. So: the core as it was, and a
 * second lobe five times as wide at a seventh of the weight.
 */
const LACQUER_SUN = chunk('lights_physical_pars_fragment', 'vec3 BRDF_GGX_Clearcoat', 'float D = D_GGX( alpha, dotNH );',
  'float D = D_GGX( alpha, dotNH ) + 0.15 * D_GGX( max( alpha, 0.04 ), dotNH );');

/**
 * What the lacquer shows of the street. The cube is 128 texels a face and is taken from above the camera's focus, not
 * from the car; read nearly sharp (as a coat this smooth asks), a texel is a degree wide and a flat panel spans only a
 * few degrees of it, so a whole roof took the colour of one sunlit wall and a flank the colour of the paving, with a
 * hard edge wherever the texel or the panel ended. On black there is nothing under the coat to hide that. Read
 * through a soft lens instead (about three degrees) the same cube is what a polished car shows from across the road:
 * sky grading down to the roofs, the street's colours run together and nearly all greyed (the sky by half), and under the horizon the road,
 * darker than the cube has it because down there a car mostly sees its own shade, and just above the horizon a
 * brighter band, because that line across a flank is what says "polished". On pale paint the coat's share is a
 * little under what it was; on dark paint, where the coat is all there is to see and the base's veil is taken away
 * (sPale, below), it is a little over.
 */
const LACQUER_STREET = chunk('lights_fragment_maps', 'USE_CLEARCOAT', 'clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );', `{
      vec3 ccR = inverseTransformDirection( reflect( - geometryViewDir, geometryClearcoatNormal ), viewMatrix );
      vec3 ccE = getIBLRadiance( geometryViewDir, geometryClearcoatNormal, max( material.clearcoatRoughness, 0.15 ) );
      float ccGnd = 1.0 - smoothstep( -0.07, 0.03, ccR.y );
      float ccSat = mix( 0.15, 0.55, smoothstep( 0.1, 0.7, ccR.y ) ) - 0.05 * ccGnd;
      ccE = mix( vec3( dot( ccE, vec3( 0.2126, 0.7152, 0.0722 ) ) ), ccE, ccSat );
      ccE *= ( 1.0 - 0.6 * ccGnd ) * ( 1.0 + 0.9 * ( 1.0 - ccGnd ) * ( 1.0 - smoothstep( 0.0, 0.35, ccR.y ) ) );
      clearcoatRadiance += ccE * mix( 1.25, 0.9, sPale );
    }`);

/**
 * A sheen that does not wait for the reflection map: sky colour added at
 * grazing angles and on faces that look up, and (glass only) rising toward the
 * top of the pane. Without it the glass is a black hole whenever the
 * environment is dim, and paint is matte plastic.
 */
function sheen(mat: THREE.MeshStandardMaterial, sky: { value: THREE.Color }, key: string, base: number, fres: number, up: number, grad: number, gloss = 0, pane = false, dirt = false, lacquer = false, flake = false, soft = false): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSky = sky;
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    if (grad > 0) vs = 'attribute float aSky;\nvarying float vSky;\n' + vs.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSky = aSky;');
    // Dust: a per-car amount (aDirt), thin over the whole body and thick along the sills where the road throws it.
    // It dulls the colour toward road dust, roughens the base and takes the lacquer's shine away with it.
    if (dirt) vs = 'attribute float aDirt;\nvarying float vDirt;\n' + vs.replace('#include <begin_vertex>', '#include <begin_vertex>\nvDirt = aDirt * (0.2 + 0.8 * (1.0 - smoothstep(0.25, 1.0, position.y)));');
    if (flake) vs = 'varying vec3 vObj;\n' + vs.replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
    // Baked occlusion (the textured levels): it darkens the colour the way the vertex bake did, softened on paint,
    // and three.js takes it out of the ambient light and the reflections besides.
    let colour = `#include <color_fragment>
      #ifdef USE_AOMAP
        float sAo = texture2D( aoMap, vAoMapUv ).r;
        diffuseColor.rgb *= 0.45 + 0.55 * sAo;
      #else
        float sAo = 1.0;
      #endif`;
    // With that map the dust also knows where it settles: in the shut-lines and under the handles.
    if (dirt) colour += '\nfloat sDirt = min(1.0, vDirt * (0.75 + 2.2 * (1.0 - sAo)));\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.26, 0.2), sDirt * 0.55);';
    if (lacquer) {
      // Which paints are metallic is read off the colour: whites and creams are solid, and so is taxi yellow;
      // everything else has aluminium flake in it. A solid colour is a dielectric under its lacquer, a metallic
      // one a rough metal whose normal is jittered flake by flake, so the sun breaks into sparks on it.
      colour += `
      float sLo = min( vColor.r, min( vColor.g, vColor.b ) );
      float sMet = 1.0 - max( smoothstep( 0.6, 0.78, sLo ), step( 0.4, vColor.r ) * step( vColor.b, 0.07 ) * step( 0.1, vColor.g ) );`;
      fs = fs
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * mix( 1.5, 1.0, sMet );')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * mix( 0.1, 1.0, sMet );')
        .replace('#include <lights_physical_pars_fragment>', LACQUER_SUN);
      // With the street cube to reflect, the coat reads it softened (see LACQUER_STREET).
      if (soft) fs = fs.replace('#include <lights_fragment_maps>', LACQUER_STREET).replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        // How pale the paint is. three.js lets the base under the coat shine as bare plastic would, rough and broad:
        // on black that is a dull sheen over the whole sunlit panel and a veil of the street's colours, as strong as
        // the coat's own picture. A dark base under lacquer gives back about a third of that.
        float sPale = smoothstep( 0.03, 0.3, max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) ) );
        material.specularColor *= mix( 0.3, 1.0, sPale );
        material.specularF90 = mix( 0.3, 1.0, sPale );`);
      // After the maps and before the clearcoat takes its own copy of the smooth normal: the lacquer stays a mirror.
      if (flake) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // Flakes about a pixel across whatever the distance (a real one is far smaller, and averages out to nothing).
          float fPix = max( length( fwidth( vObj ) ), 1e-5 );
          float fCell = exp2( ceil( log2( fPix * 0.55 ) ) );
          vec3 fc = floor( vObj / fCell );
          vec3 fh = fract( sin( vec3( dot( fc, vec3( 127.1, 311.7, 74.7 ) ), dot( fc, vec3( 269.5, 183.3, 246.1 ) ), dot( fc, vec3( 113.5, 271.9, 124.6 ) ) ) ) * 43758.5453 ) - 0.5;
          normal = normalize( normal + fh * 0.075 * sMet * ( 1.0 - smoothstep( 0.004, 0.02, fPix ) )${dirt ? ' * ( 1.0 - sDirt )' : ''} );
        }`);
    }
    fs = fs.replace('#include <color_fragment>', colour);
    if (dirt) {
      fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.roughness = mix(material.roughness, 0.95, sDirt * 0.8);
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - sDirt * 0.85;
        #endif`);
    }
    sh.vertexShader = vs;
    sh.fragmentShader = 'uniform vec3 uSky;\n' + (grad > 0 ? 'varying float vSky;\n' : '') + (dirt ? 'varying float vDirt;\n' : '') + (flake ? 'varying vec3 vObj;\n' : '') + fs.replace('#include <opaque_fragment>', `{
      float sF = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
      float sUp = max(inverseTransformDirection(normal, viewMatrix).y, 0.0);
      outgoingLight += uSky * (0.3 + 0.7 * sAo) * (${base.toFixed(3)} + ${fres.toFixed(3)} * sF * sF * sF + ${up.toFixed(3)} * sUp${grad > 0 ? ` + ${grad.toFixed(3)} * vSky * vSky` : ''});
      ${gloss > 0 ? `
      // What makes lacquer read as lacquer is a hard edge in its reflection. The environment map is a soft sky, so
      // the horizon is drawn in here: bright just above the line, cut off sharply below it.
      vec3 sR = inverseTransformDirection(reflect(-normalize(vViewPosition), normalize(normal)), viewMatrix);
      float sH = smoothstep(${soft ? '-0.12, 0.03' : '-0.035, 0.0'}, sR.y) * (1.0 - smoothstep(0.0, 0.42, sR.y));
      outgoingLight += uSky * sH * sAo * ${gloss.toFixed(3)} * (0.22 + 1.6 * sF * sF)${dirt ? ' * (1.0 - sDirt * 0.85)' : ''};` : ''}
      ${pane ? `
      // Glass by Fresnel: four percent of what is in front of it comes back when you look through it squarely,
      // nearly all of it at a glancing angle, and what is reflected is not let through. The reflection itself must
      // not be dimmed by the pane's transparency, so it is scaled up by what the blend will take away.
      float sFr = 0.04 + 0.96 * pow(sF, 5.0);
      diffuseColor.a = min(1.0, 1.0 - (1.0 - diffuseColor.a) * (1.0 - sFr) + 0.5 * vSky * vSky * diffuseColor.a);
      outgoingLight += (reflectedLight.directSpecular + reflectedLight.indirectSpecular) * (1.0 / max(diffuseColor.a, 0.1) - 1.0);` : ''}
    }
    #include <opaque_fragment>`);
  };
  // Both materials share this function's source, which is what three keys programs on by default.
  mat.customProgramCacheKey = () => key;
}

/**
 * Everything on a Blender car that is neither paint nor glass, in one draw call:
 * roughness and metalness ride on each vertex (aPbr.xy) instead of on the
 * material, and the lamp lenses (aPbr.z = 1 head, 2 tail) glow by their own
 * baked colour times a per-instance level (aLamp). Wheels use it too; they have
 * no aLamp, which reads as zero.
 */
function detailMaterial(maps: CarMaps | null = null, relief = true): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, envMapIntensity: 1.6 });
  if (maps) {
    // Lens ribs and grille mesh are not there to be seen from across the street: the street level takes the occlusion only.
    if (relief) mat.normalMap = maps.normal;
    mat.aoMap = maps.ao; mat.aoMapIntensity = 0.7;
    // The pictures are read top row first (no flip), which turns the bitangent the shader derives upside down.
    mat.normalScale.set(1, -1);
  }
  mat.onBeforeCompile = (sh) => {
    if (maps) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <normal_fragment_maps>', NORMAL_RG)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.22 + 0.78 * texture2D( aoMap, vAoMapUv ).r;');
    }
    sh.vertexShader = 'attribute vec3 aPbr;\nattribute vec4 aLamp;\nattribute vec3 aLamp2;\nvarying vec3 vPbr;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
      float lk = aPbr.z;
      vPbr = vec3(aPbr.xy, lk < 0.5 ? 0.0 : lk < 1.5 ? aLamp.x : lk < 2.5 ? aLamp.y : lk < 3.5 ? aLamp.z : lk < 4.5 ? aLamp.w : lk < 5.5 ? aLamp2.x : lk < 6.5 ? aLamp2.y : aLamp2.z);`);
    sh.fragmentShader = 'varying vec3 vPbr;\n' + sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vPbr.z;');
  };
  mat.customProgramCacheKey = () => (maps ? 'cardetail-maps' : 'cardetail');
  return mat;
}

/** three.js's normal-map chunk, reading a two-channel map: x and y from the picture, z from their length. */
const NORMAL_RG = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
  'vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).rg * 2.0 - 1.0, 0.0 );\n\tmapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );');
if (!NORMAL_RG.includes('mapN.z = sqrt')) console.warn('vehicle.ts: three.js changed its normal-map chunk; car normal maps will read flat');

/** Instanced quads with our own attributes: one draw call for every lamp in town. */
class Sprites {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  n = 0;
  private geo = new THREE.InstancedBufferGeometry();
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;

  /** With a tint the quads are alpha-blended in that one colour; without, additive light. */
  constructor(readonly cap: number, vs: string, map: THREE.Texture, order: number, readonly tint?: THREE.Color) {
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
    const mat = tint ? new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, tint: { value: tint } }, vertexShader: vs, fragmentShader: FLAT_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // Laid a finger above the road; the offset keeps them from flickering into it at a distance.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }) : new THREE.ShaderMaterial({
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

/**
 * The first milestone drew its own skid marks, tyre smoke and dust in this file. src/fx/ does that
 * properly now, so these are off; the code stays one release in case the new system has to be pulled.
 */
const OLD_MARKS: boolean = false;

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
  /** The Blender models' materials, shared by every kind. */
  private bodyMat: THREE.Material;
  /** The same with flake in it, for the showroom level. */
  private bodyNear: THREE.Material;
  private detailMat: THREE.MeshStandardMaterial;
  private paneMat: THREE.MeshStandardMaterial;
  /**
   * The materials that carry the baked maps (one sheet for every kind, so one set of materials): paint and detail for
   * the showroom level, then for the street level. Made when the first textured kind arrives.
   */
  private texMats: THREE.Material[] | null = null;
  /** The wheels' material with the shared tire maps, made when they arrive. */
  private wheelTexMat: THREE.MeshStandardMaterial | null = null;
  private assets = new Map<VehicleKind, VehicleAsset>();
  private wheelGeo: THREE.BufferGeometry;
  private wheelMat: THREE.MeshStandardMaterial;
  private glow: Sprites;
  private pool: Sprites;
  private shadow: Sprites;
  private marks: Sprites;
  private smoke: Sprites;
  private markBorn = new Float32Array(MARKS);
  private markA = new Float32Array(MARKS);
  private markAt = 0;
  /** Seconds until the last mark laid has faded; the fade loop is skipped at zero. */
  private marksLive = 0;
  /** Per puff: x y z, vx vy vz, age, life, size, alpha. */
  private puffs = new Float32Array(PUFFS * 10);
  private puffAt = 0;
  private puffsLive = 0;
  private time = 0;
  private fxSeed = 9176;
  private camX = 0; private camZ = 0;
  private sky = { value: new THREE.Color() };
  private smokeTint = new THREE.Color();
  private awake: Car[] = [];
  private pairA: Car[] = [];
  private pairB: Car[] = [];
  private pairs = 0;
  /** The car being tested by the collider callbacks below, and its heading. */
  private cur!: Car;
  private curS = 0; private curC = 1;
  private wet = 0;
  private frame = 0;
  private envRT: THREE.WebGLCubeRenderTarget | null = null;
  private envCam: THREE.CubeCamera | null = null;
  /** -1 before the first capture, 0..5 the face due next, 6 at rest. */
  private envFace = -1;
  private envWait = 0;
  private envAt = new THREE.Vector3();
  private envMats: THREE.MeshStandardMaterial[] = [];
  /** CPU milliseconds the capture has cost: the frame just drawn, and the worst frame so far (for the bench). */
  envMs = 0; envMax = 0;

  constructor(private game: Game) {
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.3, envMapIntensity: 1.3 });
    sheen(this.paintMat, this.sky, 'paint', 0, 0.3, 0.1, 0, 0, false, true);
    this.trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.7 });
    // Ink navy lifted toward the sea. Near-black metal showed only what the environment gave it, which by day was nothing.
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x1d3a52, metalness: 0.3, roughness: 0.15, envMapIntensity: 1.6 });
    this.glassTintMat = this.glassMat.clone();
    this.glassTintMat.vertexColors = true;
    // With the street itself to reflect, the painted-on sky sheen steps back to a trace (k).
    const local = game.quality.name === 'high' && new URLSearchParams(location.search).get('carenv') !== '0';
    const k = local ? 0.3 : 1;
    if (local) {
      this.envRT = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.envCam = new THREE.CubeCamera(0.5, 600, this.envRT);
    }
    sheen(this.glassMat, this.sky, 'glass', 0.04 * k, 0.75 * k, 0.2 * k, 0.44 * k);
    sheen(this.glassTintMat, this.sky, 'glass', 0.04 * k, 0.75 * k, 0.2 * k, 0.44 * k);
    this.mirror(this.glassTintMat, 1.3);
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.75 });
    this.wheelGeo = wheelGeometry();
    // Phones keep the cheap paint: a clearcoat is a second specular lobe on every pixel of every car.
    const low = game.quality.name === 'low';
    this.bodyMat = low ? this.paintMat : this.coat(null, false);
    this.bodyNear = low ? this.paintMat : this.coat(null, true);
    this.detailMat = this.mirror(detailMaterial(), 1.25);
    // Near glass lets a little of the cabin through. Far glass and phones use the opaque tinted one.
    this.paneMat = this.glassTintMat.clone();
    this.paneMat.transparent = true; this.paneMat.opacity = 0.82;
    // A dielectric, so three.js gives it glass's own four percent; the old part-metal pane was a tinted mirror.
    if (local) { this.paneMat.metalness = 0; this.paneMat.roughness = 0.04; this.paneMat.color.setHex(0x0c1a24); }
    sheen(this.paneMat, this.sky, 'pane', 0.04 * k, 0.75 * k, 0.2 * k, 0.44 * k, 0, true);
    this.mirror(this.paneMat, 1.4);
    // ?glb=0 keeps every kind procedural, for comparing.
    // ?cartex=0 leaves the baked maps unfetched (the near levels then have no occlusion at all: for timing only).
    // So does a video card too small for the shared sheet: a texture it refuses reads as black, which is a black car.
    const sheetFits = game.renderer.capabilities.maxTextureSize >= SHEET_TEXELS;
    // A kind's baked maps go to the video card one cell of the shared sheets at a time (place() in vehicleAssets.ts).
    const send: SendCell = (sheet, texels, size, x, y, blank) => this.sendCell(sheet, texels, size, x, y, blank);
    if (new URLSearchParams(location.search).get('glb') !== '0') void loadVehicleAssets((a) => this.adopt(a), !low && sheetFits && new URLSearchParams(location.search).get('cartex') !== '0', undefined, send);
    this.glow = new Sprites(1024, GLOW_VS, glowTexture(), 6);
    this.pool = new Sprites(96, POOL_VS, poolTexture(), 5);
    this.shadow = new Sprites(160, GROUND_VS, shadowTexture(), 2, new THREE.Color(0x0b1322));
    this.marks = new Sprites(MARKS, GROUND_VS, markTexture(), 3, new THREE.Color(0x0a0c11));
    this.smoke = new Sprites(PUFFS, PUFF_VS, puffTexture(), 7, this.smokeTint);
    // The marks are a ring that is always drawn whole; a slot not yet used is a quad of no width.
    this.marks.n = MARKS;
    for (let i = 0; i < MARKS; i++) this.marks.col[i * 4] = 1;
    game.scene.add(this.glow.mesh, this.pool.mesh, this.shadow.mesh, this.marks.mesh, this.smoke.mesh);
    this.marks.mesh.visible = this.shadow.mesh.visible = this.smoke.mesh.visible = false;
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
    c.wade = 0; c.soft = false; c.mkOn = false;
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
    this.reflect(dt);
    const night = sky ? sky.night : 0;
    // A zero-length step would divide by it; there is nothing to simulate anyway.
    if (dt <= 0) { this.sync(night); return; }
    this.time += dt;
    const eye = game.view ? game.view.pos : game.camera.position;
    this.camX = eye.x; this.camZ = eye.z;
    const day = 1 - night;
    this.sky.value.setRGB(0.5, 0.67, 0.8).multiplyScalar(0.04 + 0.96 * day);
    // Bone by day; under the sodium lamps smoke is only a shade paler than the road.
    this.smokeTint.setRGB(0.88, 0.8, 0.62).multiplyScalar(0.22 + 0.78 * day);

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
          if (c.sunk || c.ditch) { this.sink(c, h); continue; }
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
        this.trail(c, dt);
        c.lights = c.driver !== null && night > 0.5 && !c.sunk;
        if (c.dead) dead = true;
      }
      if (dead) for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
    }
    this.pairs = 0;
    this.fx(dt);
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
    const rate = (turningIn ? 7 - 3 * clamp01(absV / sp.topSpeed) : 8.5) * dt;
    const ds = wish - c.steerPos;
    c.steerPos += ds > rate ? rate : ds < -rate ? -rate : ds;

    // Sand gives under the tires: less bite, and (below) it drags.
    const gripBase = sp.grip * (1 - 0.22 * this.wet) * (c.soft ? 0.7 : 1);
    if (hb) c.hbT = 0.6; else if (c.hbT > 0) c.hbT -= dt;
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
        // Capped at about 25 mph: enough for a reverse flick, not a getaway gear.
        else { const u = vf / Math.min(sp.topSpeed * 0.3, 11); along = throttle * a0 * 0.6 * Math.max(0, 1 - u * u); c.reversing = true; }
      }
      // Wading: the engine labors and the water pushes back harder the faster the car goes. Nothing
      // here holds a stopped car, so it can always back out.
      if (c.wade > 0) along *= 1 - 0.35 * clamp01(c.wade / 0.6);
      // Feet off: engine braking and drag bring it to rest in a block or so. A car nobody is in sits in gear.
      // Light at speed, so lifting through a bend is not half a brake; firmer near walking pace so it does stop.
      let drag = throttle === 0 ? (0.55 + 0.02 * absV) * (COAST[sp.kind] ?? 1) + (absV < 5 ? 1 - absV / 5 : 0) : 0.15;
      drag += brake * sp.brake * (1 - 0.15 * this.wet);
      // Locked rears scrub little speed: the slide has to carry the car round.
      if (hb) drag += sp.brake * 0.4;
      if (c.wade > 0) drag += c.wade * (0.3 + 2.4 * absV + 0.15 * absV * absV);
      if (c.soft) drag += 1.2 * clamp01(absV / 2);
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
      if (hb) grip *= sp.drive === 'rwd' ? 0.2 : 0.25; else if (c.sliding || c.loose > 0) grip *= 0.5; else grip *= 1 - 0.5 * power;
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
        // Not for a moment after the handbrake, and less the further round the car already is: a turn
        // that has gone past sixty degrees should finish, not unwind.
        if (c.sliding && !hb && c.hbT <= 0) yawWish -= ALIGN * (vr / Math.sqrt(speed2 + 4)) * clamp(vf / 8, -1, 1);
        const lazy = c.sliding || hb || c.loose > 0;
        // Steering against the spin is answered at once: that is the catch. A spin
        // that is already turning carries on by itself for a while, which is what
        // takes a handbrake turn past ninety degrees after the nose has stopped leading.
        const fading = Math.abs(yawWish) < Math.abs(c.yawRate);
        const k = !lazy ? 14 : yawWish * c.yawRate < 0 ? 9 : fading ? (hb ? 0.7 : c.hbT > 0 ? 1.6 : 3) : 6;
        c.yawRate = damp(c.yawRate, yawWish, k, dt);
      }

      const launch = sp.drive === 'rwd' && throttle > 0.9 && vf < 6 && a0 > 5.5 ? (1 - Math.max(vf, 0) / 6) * 0.6 : 0;
      c.slip = clamp01(Math.max((avr - 1.5) / 5, hb && speed2 > 9 ? 0.6 : 0, launch, c.soft ? 0.25 * clamp01(absV / 8) : 0));
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

    c.wade = c.onGround && c.y < WATER_Y ? WATER_Y - c.y : 0;
    // Everything off the paved grid that is not a deck or the bridge is sand or shore turf. The box
    // is the city core's, as in groundAt().
    c.soft = c.onGround && c.wade === 0 && (c.x < -610 || c.x > 610 || c.z < -440 || c.z > 410)
      && !(c.z < -430 && Math.abs(c.x - BRIDGE.x) <= BRIDGE.hw + 2) && Math.abs(c.y - terrainAt(c.x, c.z)) < 0.03;

    // The sea takes a car that lands in it or wades in past its sills. Surf to the hubs is only slow going.
    if (c.y < WATER_Y - 0.1 && groundAt(c.x, c.z) < WATER_Y - DEEP) {
      c.ditch = true;
      c.sinkT = 0;
      c.dive = clamp(-c.vy * 0.07, 0, 0.7);
      c.onGround = c.onF = c.onR = false;
      c.sliding = false; c.slip = 0; c.braking = false; c.reversing = false; c.wade = 0; c.soft = false;
      this.game.emit('splash', { x: c.x, z: c.z, big: true });
      // A wall of spray thrown the way the car was going, and a ring around it.
      const sp1 = Math.hypot(c.vx, c.vz), n = 22;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, r = 0.6 + this.rand() * c.hw, out = 1.5 + this.rand() * 2.5 + sp1 * 0.12;
        this.puff(c.x + Math.sin(a) * r + sh * c.hl * 0.6, WATER_Y + 0.2, c.z + Math.cos(a) * r + ch * c.hl * 0.6,
          Math.sin(a) * out + c.vx * 0.35, 3 + this.rand() * 4 + sp1 * 0.1, Math.cos(a) * out + c.vz * 0.35, 0.9 + this.rand() * 0.6, 1.3 + this.rand() * 1.2, 0.85);
      }
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
    c.vx -= (1 + WALL_REST) * vn * nx;
    c.vz -= (1 + WALL_REST) * vn * nz;
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

  /**
   * Deep water: the engine is dead, the car bobs, fills and goes down. The
   * first half second is the plough: it digs its nose in and sheds most of its
   * speed in spray, and only then is it `sunk`, which is the player code's cue
   * to put the driver in the water. Flipping at the waterline threw the driver
   * out of a car still doing sixty.
   */
  private sink(c: Car, dt: number): void {
    c.sinkT += dt;
    if (c.ditch) {
      if (c.sinkT > DITCH) { c.ditch = false; c.sunk = true; }
      c.puffT -= dt;
      if (c.puffT <= 0) {
        c.puffT = 0.03;
        const s = Math.sin(c.h), co = Math.cos(c.h), side = (this.rand() - 0.5) * 2 * c.hw;
        this.puff(c.x + s * c.hl + co * side, WATER_Y + 0.15, c.z + co * c.hl - s * side, c.vx * 0.5 + co * side * 2, 2.5 + this.rand() * 3, c.vz * 0.5 - s * side * 2, 0.7, 1.1 + this.rand(), 0.8);
      }
    }
    const k = Math.exp(-(c.sunk ? 1.8 : 3.4) * dt);
    c.vx *= k; c.vz *= k; c.yawRate *= k;
    c.x += c.vx * dt; c.z += c.vz * dt; c.h += c.yawRate * dt;
    const f = smooth(c.sinkT / 5), sp = c.spec;
    const floor = groundAt(c.x, c.z);
    const bob = Math.sin(c.sinkT * 3.2) * 0.04 * (1 - f);
    const early = Math.exp(-2.5 * c.sinkT);
    const level = Math.max(floor, WATER_Y - 0.3 - f * (sp.height + 0.15) + bob - c.dive * early);
    // Engine first: the nose goes down ahead of the tail, and digs in hardest as it lands.
    const tip = (Math.sin(f * Math.PI) * 0.28 + early * 0.3) * sp.wheelbase / 2;
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
    const acc = ((c.onGround || c.sunk || c.ditch ? 0 : -0.06) - c.susp) * 150 - c.suspV * 15;
    c.suspV += acc * dt;
    // Sand is not flat, whatever the height map says: work the springs a few centimeters.
    if (c.soft) c.suspV += Math.sin(c.x * 0.63 + c.z * 0.71) * 5 * clamp01(Math.abs(vf) / 6) * dt;
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

    const still = c.driver === null && !c.sunk && !c.ditch && c.onF && c.onR && c.vx * c.vx + c.vz * c.vz < 0.01
      && Math.abs(c.yawRate) < 0.02 && Math.abs(c.susp) < 0.004 && Math.abs(c.suspV) < 0.03;
    c.rest = still ? c.rest + dt : 0;
    if (c.rest > 0.5) this.sleep(c);
  }

  // ── Rubber, smoke and spray ────────────────────────────────────────────────

  /** Layout uses `rng`; effects must not disturb it, or the city's paint would depend on how you drove. */
  private rand(): number {
    this.fxSeed = (Math.imul(this.fxSeed, 1664525) + 1013904223) >>> 0;
    return this.fxSeed / 4294967296;
  }

  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, alpha: number): void {
    const p = this.puffs, i = this.puffAt * 10;
    this.puffAt = (this.puffAt + 1) % PUFFS;
    p[i] = x; p[i + 1] = y; p[i + 2] = z; p[i + 3] = vx; p[i + 4] = vy; p[i + 5] = vz;
    p[i + 6] = 0; p[i + 7] = life; p[i + 8] = size; p[i + 9] = alpha;
    this.puffsLive = Math.max(this.puffsLive, life);
  }

  private mark(x0: number, z0: number, x1: number, z1: number, y: number, w: number, a: number): void {
    const m = this.marks, i = this.markAt;
    this.markAt = (i + 1) % MARKS;
    m.pos[i * 3] = (x0 + x1) / 2; m.pos[i * 3 + 1] = y; m.pos[i * 3 + 2] = (z0 + z1) / 2;
    m.col[i * 4] = x1 - x0; m.col[i * 4 + 1] = z1 - z0; m.col[i * 4 + 2] = w; m.col[i * 4 + 3] = a;
    this.markBorn[i] = this.time; this.markA[i] = a;
    this.marksLive = MARK_LIFE;
  }

  /** Once a frame per awake car: what it throws up from water. (Marks, smoke and dust: see OLD_MARKS.) */
  private trail(c: Car, dt: number): void {
    const dx = c.x - this.camX, dz = c.z - this.camZ;
    if (c.sunk || c.ditch || dx * dx + dz * dz > 22500) { c.mkOn = false; return; }
    const ws = c.batch.model.wheels;
    const s = Math.sin(c.h), co = Math.cos(c.h);
    const v2 = c.vx * c.vx + c.vz * c.vz;
    const skid = c.onGround && !c.soft && c.wade === 0 && c.slip > 0.4 && v2 > 9 && ws.length >= 4;
    // Rear wheels: the handbrake locks them and the power spins them. +X on the model is the car's left, which is (cos h, -sin h).
    const wl = ws[Math.min(2, ws.length - 1)], wr = ws[Math.min(3, ws.length - 1)];
    const lx = c.x + s * wl.z + co * wl.x, lz = c.z + co * wl.z - s * wl.x;
    const rx = c.x + s * wr.z + co * wr.x, rz = c.z + co * wr.z - s * wr.x;
    const y = c.y + c.lift;
    if (skid) {
      const ex = lx - c.mlx, ez = lz - c.mlz, d2 = ex * ex + ez * ez;
      if (!c.mkOn || d2 > 0.3) {
        // Skid marks, tyre smoke and dust are drawn by src/fx/ now (skids.ts, particles.ts).
        // Only the water stays here: wading spray and a sinking car's bubbles.
        if (OLD_MARKS && c.mkOn && d2 < 9) {
          const a = 0.62 * clamp01((c.slip - 0.3) * 2.5), w = c.spec.wheelW * 1.25;
          this.mark(c.mlx, c.mlz, lx, lz, y + 0.025, w, a);
          this.mark(c.mrx, c.mrz, rx, rz, y + 0.025, w, a);
        }
        c.mlx = lx; c.mlz = lz; c.mrx = rx; c.mrz = rz; c.mkOn = true;
      }
    } else c.mkOn = false;

    c.puffT -= dt;
    if (c.puffT > 0) return;
    const left = this.rand() < 0.5, wx = left ? lx : rx, wz = left ? lz : rz;
    if (OLD_MARKS && skid) {
      c.puffT = 0.045;
      this.puff(wx, y + 0.25, wz, c.vx * 0.25 + (this.rand() - 0.5), 0.7 + this.rand() * 0.6, c.vz * 0.25 + (this.rand() - 0.5), 0.9 + this.rand() * 0.5, 0.9 + this.rand() * 0.6, 0.62 * c.slip);
    } else if (c.wade > 0.04 && v2 > 4) {
      // Thrown up from the leading end, harder the faster it wades.
      c.puffT = 0.035;
      const sp1 = Math.sqrt(v2), lead = c.speed >= 0 ? 1 : -1, side = (this.rand() - 0.5) * 2 * c.hw;
      this.puff(c.x + s * c.hl * lead + co * side, WATER_Y + 0.1, c.z + co * c.hl * lead - s * side, c.vx * 0.6 + co * side * 1.5, 1.2 + sp1 * 0.22, c.vz * 0.6 - s * side * 1.5,
        0.55, 0.6 + Math.min(sp1, 14) * 0.06, 0.75 * clamp01(sp1 / 6));
    } else if (OLD_MARKS && c.soft && v2 > 20) {
      c.puffT = 0.08;
      this.puff(wx, y + 0.2, wz, c.vx * 0.2 + (this.rand() - 0.5), 0.5 + this.rand() * 0.5, c.vz * 0.2 + (this.rand() - 0.5), 1.1, 0.9 + this.rand() * 0.6, 0.3 * clamp01(v2 / 150 + 0.3));
    } else c.puffT = 0;
  }

  /** Age the marks and the puffs. Both loops stop when there is nothing left to fade. */
  private fx(dt: number): void {
    if (this.marksLive > 0) {
      this.marksLive -= dt;
      const m = this.marks, t = this.time;
      for (let i = 0; i < MARKS; i++) {
        const a = this.markA[i];
        if (a === 0) continue;
        // Full strength for most of their life, then gone over the last few seconds.
        const k = clamp01((MARK_LIFE - (t - this.markBorn[i])) / 5);
        m.col[i * 4 + 3] = a * k;
        if (k === 0) this.markA[i] = 0;
      }
      m.flush();
      if (this.marksLive <= 0) m.mesh.visible = false;
    }
    const sm = this.smoke;
    if (this.puffsLive > 0) {
      this.puffsLive -= dt;
      const p = this.puffs, k = Math.exp(-2.2 * dt);
      sm.n = 0;
      for (let i = 0; i < PUFFS * 10; i += 10) {
        const life = p[i + 7];
        if (life === 0) continue;
        const age = (p[i + 6] += dt);
        if (age >= life) { p[i + 7] = 0; continue; }
        p[i + 3] *= k; p[i + 5] *= k;
        // Spray falls back; smoke, being lighter, has stopped rising by then anyway.
        p[i + 4] -= (p[i + 4] > 1.2 ? 9 : 0.4) * dt;
        p[i] += p[i + 3] * dt; p[i + 1] += p[i + 4] * dt; p[i + 2] += p[i + 5] * dt;
        const u = age / life;
        sm.add(p[i], p[i + 1], p[i + 2], p[i + 9] * (1 - u) * Math.min(1, u * 10), 0, 0, p[i + 8] * (1 + 1.6 * u));
      }
      sm.flush();
    } else if (sm.mesh.visible) { sm.n = 0; sm.flush(); }
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
    const j = -(1 + WALL_REST) * vn / (c.invM + rn * rn * c.invI);
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
    const v2 = c.vx * c.vx + c.vz * c.vz;
    if (p.breakable && v2 > 4) {
      this.game.col.breakProp(p, c.vx, c.vz);
      // Enough to feel the bump, not enough to punish it.
      c.vx *= 0.94; c.vz *= 0.94;
      return;
    }
    if (p.hard) {
      // A lamp post stops a hatchback at parking speed and loses to a bus at a crawl:
      // the bar is momentum, so it drops as the mass rises.
      const v = Math.sqrt(v2);
      if (v > clamp(13500 * c.invM, 3.5, 9.5)) {
        this.game.col.breakProp(p, c.vx, c.vz);
        c.vx *= 0.7; c.vz *= 0.7;
        this.impact(c, v, null, p.x, p.z, (v - HARD_HIT) * DAMAGE * 0.5);
        return;
      }
    }
    // Solid: a wall one post wide. The normal runs from the post to the nearest point of the body.
    let nf: number, nr: number, pen: number;
    if (d2 > 1e-6) { const d = Math.sqrt(d2); nf = -ef / d; nr = -er / d; pen = p.r - d; }
    else if (c.hl - Math.abs(lf) < c.hw - Math.abs(lr)) { nf = lf < 0 ? 1 : -1; nr = 0; pen = c.hl - Math.abs(lf) + p.r; }
    else { nf = 0; nr = lr < 0 ? 1 : -1; pen = c.hw - Math.abs(lr) + p.r; }
    const nx = nf * sh - nr * ch, nz = nf * ch + nr * sh;
    c.x += nx * pen; c.z += nz * pen;
    // Square on the nose there is no torque to turn the car, and it sat pinned on a pole
    // with the throttle down. A thin post lets the bumper slip off to one side instead.
    if (p.r < 0.6 && Math.abs(nf) > 0.85) {
      const slip = lr > 0 ? -0.05 : 0.05;
      c.vx -= ch * slip; c.vz += sh * slip;
    }
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
    const proc = vehicleModel(kind);
    // How far up its pane each glass vertex is, for the sheen's gradient: the top of a windshield shows sky, the bottom the dash.
    const gp = proc.glass.getAttribute('position');
    if (gp && !proc.glass.hasAttribute('aSky')) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < gp.count; i++) { const y = gp.getY(i); if (y < lo) lo = y; if (y > hi) hi = y; }
      const sky = new Float32Array(gp.count);
      for (let i = 0; i < gp.count; i++) sky[i] = hi > lo ? (gp.getY(i) - lo) / (hi - lo) : 0.5;
      proc.glass.setAttribute('aSky', new THREE.BufferAttribute(sky, 1));
    }
    b = { kind, proc, model: proc, sets: [], pick: [0, 0, 0], sections: false, cap: Math.max(8, Math.ceil(SPECS[kind].common * 8)) };
    this.dress(b);
    this.batches.set(kind, b);
    this.batchList.push(b);
    return b;
  }

  /**
   * Metallic base under a hard lacquer. The base is left fairly rough (flake scatters) and the coat is what shines:
   * a touch of roughness on it spreads the sun into a highlight the size of a hand instead of a single pixel.
   */
  private coat(maps: CarMaps | null, flake: boolean): THREE.MeshPhysicalMaterial {
    const local = !!this.envRT;
    const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: local ? 0.35 : 0.55, roughness: local ? 0.5 : 0.4, clearcoat: 1, clearcoatRoughness: local ? 0.09 : 0.025, envMapIntensity: 1.7 });
    if (maps) { m.aoMap = maps.ao; m.aoMapIntensity = 0.6; }
    // Flake is worked out per pixel and shows only within a few meters, so only the showroom level pays for it.
    if (local) sheen(m, this.sky, flake ? 'coatf' : 'coat', 0, 0.06, 0.02, 0, 0.1, false, true, true, flake, true);
    else sheen(m, this.sky, flake ? 'coatf' : 'coat', 0, 0.3, 0.1, 0, 0.55, false, true, true, flake);
    return this.mirror(m, 1.6);
  }

  /**
   * One kind's cell of a shared sheet to the video card. The texels go up as a small texture of their own, which the
   * card gives its chain of smaller copies cheaply, and each level is then copied into its place in the sheet, on
   * the card: the sheet is never read and written at once, and its whole chain is never rebuilt. Fresh storage is
   * filled with `blank` first, so a cell that has not arrived reads as smooth and unshaded, not as zeros.
   *
   * Measured on the development machine as the send plus the frame after it, a plain frame being 0.7 ms: both sheets
   * re-sent whole, 12 to 18 ms; this, 10 to 12; an upload straight into the sheet with three.js's rebuild of the
   * whole chain, about the same; an upload into the sheet with each level halved in place, 8 to 10. Whichever way
   * the cell is written, most of what is left follows the sheet's size and not the cell's, so the cure for the rest
   * is a layer for each kind (a texture array), not a cleverer copy.
   */
  private sendCell(sheet: THREE.DataTexture, texels: Uint8Array<ArrayBuffer>, size: number, x: number, y: number, blank: number): void {
    const r = this.game.renderer, gl = r.getContext() as WebGL2RenderingContext;
    const made = (): WebGLTexture | undefined => (r.properties.get(sheet) as { __webglTexture?: WebGLTexture }).__webglTexture;
    const fresh = !made();
    // The storage, with the whole chain, is made while the sheet still says it wants a chain.
    r.initTexture(sheet);
    const tex = made();
    if (!tex || typeof gl.blitFramebuffer !== 'function') { sheet.source.dataReady = true; sheet.needsUpdate = true; return; }
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST), mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
    const from = gl.createFramebuffer(), to = gl.createFramebuffer();
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    if (fresh) {
      const v = blank / 255, top = Math.floor(Math.log2(Math.max(sheet.image.width, sheet.image.height)));
      for (let l = 0; l <= top; l++) {
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, l);
        gl.clearBufferfv(gl.COLOR, 0, [v, v, v, v]);
      }
    }
    const cell = new THREE.DataTexture(texels, size, size, sheet.format as THREE.PixelFormat, sheet.type);
    cell.generateMipmaps = true; cell.minFilter = THREE.LinearMipmapLinearFilter;
    cell.needsUpdate = true;
    r.initTexture(cell);
    const src = (r.properties.get(cell) as { __webglTexture?: WebGLTexture }).__webglTexture ?? null;
    let ok = !!src;
    for (let l = 0; (size >> l) >= 1 && ok; l++) {
      const s = size >> l, cx = x >> l, cy = y >> l;
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, l);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, l);
      if (l === 0) ok = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      // Texel for texel between two textures: the copy stays inside the cell at every level.
      if (ok) gl.blitFramebuffer(0, 0, s, s, cx, cy, cx + s, cy + s, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    cell.dispose();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.deleteFramebuffer(from); gl.deleteFramebuffer(to);
    // A card that will not draw into those levels is sent the whole sheet, as before.
    if (!ok) { sheet.source.dataReady = true; sheet.needsUpdate = true; }
  }

  /** Enrol a material for the local reflection cube: it takes the cube (at this strength) once the first capture is in. */
  private mirror<T extends THREE.MeshStandardMaterial>(m: T, intensity: number): T {
    if (!this.envRT) return m;
    this.envMats.push(m);
    m.envMapIntensity = intensity;
    if (this.envFace >= 0) m.envMap = this.envRT.texture;
    return m;
  }

  /**
   * Keep the reflection cube current. The first capture is all six faces at once (nothing is on screen worth a
   * smooth frame yet); after that one face a frame, and the blurred copy the materials read is rebuilt when the
   * sixth lands. Cars are left out of their own reflections.
   */
  private reflect(dt: number): void {
    const rt = this.envRT, cc = this.envCam, game = this.game;
    this.envMs = 0;
    if (!rt || !cc || !game.renderer || this.frame < 4) return;
    const focus = game.cam ? game.cam.focus : game.camera.position;
    if (this.envFace === 6) {
      this.envWait -= dt;
      const dx = focus.x - this.envAt.x, dz = focus.z - this.envAt.z;
      if (this.envWait > 0 && !(dx * dx + dz * dz > ENV_MOVE2 && this.envWait < ENV_EVERY - ENV_MIN)) return;
      this.envFace = 0;
    }
    const first = this.envFace < 0, r = game.renderer, t0 = performance.now();
    if (first || this.envFace === 0) {
      this.envWait = ENV_EVERY; this.envAt.copy(focus);
      cc.position.set(focus.x, focus.y + 1.3, focus.z);
      cc.updateMatrixWorld(true);
    }
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, hidden: THREE.Object3D[] = [];
    const hide = (o: THREE.Object3D): void => { if (o.visible) { o.visible = false; hidden.push(o); } };
    for (const b of this.batchList) for (const st of b.sets) { for (const m of st.body) hide(m); hide(st.wheels); }
    for (const sp of [this.glow, this.pool, this.shadow, this.marks, this.smoke]) hide(sp.mesh);
    // The sun's shadow map from the frame before is as good as new for this.
    r.shadowMap.autoUpdate = false;
    if (first) { cc.update(r, game.scene); this.envFace = 6; }
    else { r.setRenderTarget(rt, this.envFace); r.render(game.scene, cc.children[this.envFace] as THREE.Camera); this.envFace++; }
    r.shadowMap.autoUpdate = auto;
    r.setRenderTarget(prev);
    for (const o of hidden) o.visible = true;
    if (this.envFace === 6) {
      rt.texture.needsPMREMUpdate = true;
      if (first) for (const m of this.envMats) { m.envMap = rt.texture; m.needsUpdate = true; }
    }
    this.envMs = performance.now() - t0;
    if (!first && this.envMs > this.envMax) this.envMax = this.envMs;
  }

  /** A kind's file has arrived: from the next frame its cars are drawn from it. */
  private adopt(a: VehicleAsset): void {
    this.assets.set(a.kind, a);
    const b = this.batches.get(a.kind);
    if (!b) return;
    this.dress(b);
    for (const c of this.cars) if (c.batch === b) { c.stale = true; c.lod = 1; }
  }

  /** (Re)build a kind's draw sets: from its file if that is here, else from the procedural model. */
  private dress(b: KindBatch): void {
    for (const s of b.sets) { b.cap = Math.max(b.cap, s.cap); this.dropSet(s); }
    const a = this.assets.get(b.kind), p = b.proc;
    const list: SetParts[] = [];
    if (a) {
      const low = this.game.quality.name === 'low', l0 = a.lods[0];
      // The file says where its lamps are; the wheel centers, seat and beacon it does not carry come from the spec.
      b.model = {
        paint: l0.paint, trim: l0.detail ?? p.trim, glass: l0.glass ?? p.glass, wheels: p.wheels,
        head: a.head.length ? a.head : p.head, tail: a.tail.length ? a.tail : p.tail,
        beacon: a.beacon ?? p.beacon, seat: a.seat ?? p.seat,
      };
      // Phones draw the far level only.
      const lods = low ? [a.lods[a.lods.length - 1]] : a.lods, n = lods.length;
      b.pick = n === 3 ? [0, 1, 2] : n === 2 ? [0, 0, 1] : [0, 0, 0];
      b.sections = a.sections;
      const maps = low ? null : a.maps;
      if (maps && !this.texMats) this.texMats = [this.coat(maps, true), this.mirror(detailMaterial(maps), 1.25), this.coat(maps, false), this.mirror(detailMaterial(maps, false), 1.25)];
      const tex = maps ? this.texMats : null;
      if (!low && a.wheelMaps && !this.wheelTexMat) this.wheelTexMat = this.mirror(detailMaterial(a.wheelMaps), 1.25);
      lods.forEach((l, i) => {
        const others: Part[] = [];
        // A level is drawn with the maps only if every part of it was unwrapped for them.
        const uv = !!tex && l.paint.hasAttribute('uv') && (!l.detail || l.detail.hasAttribute('uv'));
        const near = n === 3 && i === 0;
        const bodyMat = uv ? tex![near ? 0 : 2] : near ? this.bodyNear : this.bodyMat, detailMat = uv ? tex![near ? 1 : 3] : this.detailMat;
        const wheelMat = !low && this.wheelTexMat && l.wheel?.hasAttribute('uv') ? this.wheelTexMat : this.detailMat;
        // Bumpers and mirrors add nothing to the shadow the shell already throws, except close up, where the
        // mirror, the wing and the rack are what you are looking at.
        if (l.detail) others.push([l.detail, detailMat, n === 3 && i === 0]);
        // All but the far level have a cabin to show through the glass.
        if (l.glass) others.push([l.glass, n > 1 && i < n - 1 ? this.paneMat : this.glassTintMat, true]);
        list.push({
          paint: [l.paint, bodyMat, true], others,
          wheel: l.wheel ? [l.wheel, wheelMat, true] : [this.wheelGeo, this.wheelMat, true], lampGeo: l.detail,
        });
      });
    } else {
      b.model = p; b.pick = [0, 0, 0]; b.sections = false;
      list.push({
        paint: [p.paint, this.paintMat, true],
        others: [[p.trim, this.trimMat, true], [p.glass, p.glass.hasAttribute('color') ? this.glassTintMat : this.glassMat, true]],
        wheel: [this.wheelGeo, this.wheelMat, true], lampGeo: null,
      });
    }
    b.sets = list.map((parts) => {
      const s: DrawSet = {
        parts, body: [], wheels: null!, mats: null!, cols: null!, dirt: null!, dirtAttr: null, wmats: null!, lamps: null, lamps2: null, lampAttr: null, lampAttr2: null,
        cap: b.cap, wcap: b.cap * p.wheels.length, n: 0, nw: 0, near: 0, nwNear: 0,
      };
      this.fillSet(s);
      return s;
    });
  }

  private fillSet(s: DrawSet): void {
    const scene = this.game.scene, shadows = this.game.quality.shadows, q = s.parts;
    const dyn = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => new THREE.InstancedBufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    s.mats = new Float32Array(s.cap * 16); s.cols = new Float32Array(s.cap * 3); s.wmats = new Float32Array(s.wcap * 16);
    const bodyMats = dyn(s.mats, 16);
    const make = (part: Part, wheel: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(part[0], part[1], 0);
      m.instanceMatrix = wheel ? dyn(s.wmats, 16) : bodyMats;
      // Instances are spread over the whole island; culling is done by hand in sync().
      m.frustumCulled = false;
      m.castShadow = shadows && part[2]; m.receiveShadow = shadows;
      m.count = 0;
      m.onBeforeShadow = () => { m.count = wheel ? s.nwNear : s.near; };
      m.onAfterShadow = () => { m.count = wheel ? s.nw : s.n; };
      scene.add(m);
      return m;
    };
    s.body = [make(q.paint, false), ...q.others.map((o) => make(o, false))];
    s.body[0].instanceColor = dyn(s.cols, 3);
    s.dirt = new Float32Array(s.cap); s.dirtAttr = dyn(s.dirt, 1);
    q.paint[0].setAttribute('aDirt', s.dirtAttr);
    s.wheels = make(q.wheel, true);
    if (q.lampGeo) {
      s.lamps = new Float32Array(s.cap * 4); s.lamps2 = new Float32Array(s.cap * 3);
      s.lampAttr = dyn(s.lamps, 4); s.lampAttr2 = dyn(s.lamps2, 3);
      q.lampGeo.setAttribute('aLamp', s.lampAttr); q.lampGeo.setAttribute('aLamp2', s.lampAttr2);
    }
  }

  private dropSet(s: DrawSet): void {
    for (const m of [...s.body, s.wheels]) { this.game.scene.remove(m); m.dispose(); }
  }

  /** Growing replaces the meshes and their buffers, so carry over what this frame has already written. */
  private growSet(s: DrawSet): void {
    const { mats, cols, wmats, lamps, lamps2, dirt } = s;
    this.dropSet(s);
    s.cap *= 2; s.wcap *= 2;
    this.fillSet(s);
    s.mats.set(mats); s.cols.set(cols); s.wmats.set(wmats); s.dirt.set(dirt);
    if (lamps && s.lamps) s.lamps.set(lamps);
    if (lamps2 && s.lamps2) s.lamps2.set(lamps2);
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
    const glow = this.glow, pool = this.pool, shadow = this.shadow;
    for (const b of this.batchList) for (const s of b.sets) { s.n = 0; s.nw = 0; }
    glow.n = 0; pool.n = 0; shadow.n = 0;

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
    // The few cars nearest the camera get the showroom level: four slots, kept sorted.
    const stamp = ++this.frame, nd = _nearD, nc = _nearC; let nn = 0;
    for (let k = 0; k < this.cars.length; k++) {
      const c = this.cars[k], dx = cam.x - c.x, dy = cam.y - c.y, dz = cam.z - c.z, d = dx * dx + dy * dy + dz * dz;
      if (d > NEAR_OUT2) continue;
      let i = nn;
      if (nn < NEAR_MAX) nn++; else if (d >= nd[NEAR_MAX - 1]) continue; else i = NEAR_MAX - 1;
      while (i > 0 && nd[i - 1] > d) { nd[i] = nd[i - 1]; nc[i] = nc[i - 1]; i--; }
      nd[i] = d; nc[i] = c;
    }
    for (let j = 0; j < nn; j++) { nc[j]!.nearest = stamp; nc[j] = null; }
    const blink = (this.time * 1.4) % 1 < 0.5;
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
      if (c.nearest === stamp && d3 < (c.lod === 0 ? NEAR_OUT2 : NEAR_IN2)) c.lod = 0;
      else c.lod = d3 > (c.lod === 2 ? LOD_IN2 : LOD_OUT2) ? 2 : 1;
      let s = b.sets[b.pick[c.lod]];
      if (s.n >= s.cap) this.growSet(s);
      const i = s.n++;
      s.mats.set(c.mat, i * 16);
      if (c.color !== c.shown) { _col.setHex(c.color); c.cr = _col.r; c.cg = _col.g; c.cb = _col.b; c.shown = c.color; }
      s.cols[i * 3] = c.cr; s.cols[i * 3 + 1] = c.cg; s.cols[i * 3 + 2] = c.cb;
      s.dirt[i] = c.wreck ? 0.7 : c.dirt;
      // The lenses themselves light up; the glow sprites in lamps() are the halo round them.
      if (s.lamps && s.lamps2) {
        const L = s.lamps, L2 = s.lamps2;
        L[i * 4] = c.lights ? 2.8 : 0;
        L[i * 4 + 1] = b.sections ? (c.lights ? 1.1 : 0) : c.braking ? 3.5 : c.lights ? 0.9 : 0;
        // One lens does both jobs on most cars: the brake section glows dimly with the tail lamps and flares when braking.
        L[i * 4 + 2] = c.braking ? 3.6 : c.lights ? 0.8 : 0;
        L[i * 4 + 3] = c.reversing ? 2.6 : 0;
        // Indicators: on while a driver holds a real turn at town speed, and for a moment after, like a stalk that cancels late.
        if (c.driver !== null && Math.abs(c.ctl.steer) > 0.45 && c.vx * c.vx + c.vz * c.vz < 170) { c.turn = c.ctl.steer > 0 ? -1 : 1; c.turnEnd = this.time + 1.3; }
        else if (c.turn !== 0 && (this.time > c.turnEnd || c.driver === null)) c.turn = 0;
        L2[i * 3] = blink && c.turn > 0 ? 3 : 0; L2[i * 3 + 1] = blink && c.turn < 0 ? 3 : 0;
        L2[i * 3 + 2] = c.driver !== null && !c.sunk ? (c.lights ? 1.2 : 1.8) : 0;
      }

      // Past a few hundred meters a wheel is a pixel in the shade of its arch. (wcap is cap times the wheels per car, so these always fit.)
      if (d3 < WHEEL_R2) { s.wmats.set(c.wmat, s.nw * 16); s.nw += c.wmat.length / 16; }

      // The dark under the car. The sun's shadow does this at noon; at dusk, at night and with shadows off nothing
      // else does, and the car floats. It stays behind when the car leaves the ground.
      if (d3 < 25600 && !c.sunk && !c.ditch && c.y > WATER_Y - 0.2) {
        const a = (c.onGround ? 1 : Math.max(0, 1 - c.airTime * 5)) * (1 - clamp01((Math.abs(c.pitch) - 0.06) * 7)) * (1 - smooth((d3 - 14400) / 11200));
        if (a > 0.02) {
          const s = Math.sin(c.h), co = Math.cos(c.h), len = c.spec.length + 0.7;
          shadow.add(c.x, c.y + c.lift + 0.03, c.z, s * len, co * len, c.spec.width + 0.6, 0.46 * a);
        }
      }

      if ((c.lights || c.braking || c.reversing) && d2 < 62500) this.lamps(c, dx, dz, Math.sqrt(d2), night);
    }
    if (pass === 0) for (const b of this.batchList) for (const s of b.sets) { s.near = s.n; s.nwNear = s.nw; }
    }

    for (const b of this.batchList) for (const s of b.sets) {
      const on = s.n > 0;
      for (const m of s.body) { m.count = s.n; m.visible = on; }
      s.wheels.count = s.nw; s.wheels.visible = s.nw > 0;
      if (!on) continue;
      s.body[0].instanceMatrix.needsUpdate = true;
      s.body[0].instanceColor!.needsUpdate = true;
      if (s.dirtAttr) s.dirtAttr.needsUpdate = true;
      if (s.lampAttr) s.lampAttr.needsUpdate = true;
      if (s.lampAttr2) s.lampAttr2.needsUpdate = true;
      if (s.nw) s.wheels.instanceMatrix.needsUpdate = true;
    }
    glow.flush(); pool.flush(); shadow.flush();
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
    if (dist < 180 && c.onGround) {
      const s = Math.sin(c.h), co = Math.cos(c.h), far = 1 - smooth((dist - 110) / 70);
      // Lamps come on at half dark, when the road is still lit: the pool grows in with the night instead of arriving as a grey smudge.
      const dark = clamp01((night - 0.5) / 0.35);
      // Held a hand above the street so it still shows where the beam climbs a curb.
      if (c.lights) this.pool.add(c.x + s * (c.hl - 0.6), c.y + 0.2, c.z + co * (c.hl - 0.6), s, co, 0.7 * dark * dark * far, 0);
      if (c.braking && night > 0.4) this.pool.add(c.x - s * (c.hl - 0.5), c.y + 0.2, c.z - co * (c.hl - 0.5), -s, -co, 0.24 * night * night * far, 1);
    }
  }
}
