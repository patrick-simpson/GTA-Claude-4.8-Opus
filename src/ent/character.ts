// The people, as bodies and animation. This file only draws: whoever controls a
// person (the player code, later the pedestrian AI) writes x, y, z, h, pose and
// speed, and everything seen on screen is worked out here from those.
//
// People are skinned meshes modelled in Blender (tools/blender/people.py, read
// by characterAssets.ts): two bodies, two levels of detail each, so the whole
// crowd is at most four draw calls (eight with the shadow pass) however many
// there are. three.js cannot skin per instance, so this file does it: every
// frame each visible person gets one row of a float texture holding their 19
// bone matrices (three texels each, a 3x4) and their palette (one texel a
// part: colour, and alpha 0 to fold a part away, which is how one mesh carries
// every haircut, both sleeve lengths, shorts and the cap). The vertex shader
// reads two bones a vertex from that row. A SkinnedMesh per person was the
// alternative and costs a draw call, a skeleton update and a uniform upload
// each; this costs one texture upload for everybody.
//
// Until the files arrive, and for good if they do not, everyone is drawn the
// old way, which is still here: one InstancedMesh of a soft-edged box drawn up
// to 23 times per person, each with its own matrix, colour and taper.
//
// Animation is procedural. Each pose is a function that fills a small array of
// joint angles ("channels"); a pose change cross-fades from a snapshot of
// wherever the body was. Walking and running place the feet first and solve the
// legs backwards from them, with the cycle advanced by distance covered rather
// than by time, which is what keeps feet from sliding.
//
// Two poses reinterpret the position, because "feet" stops meaning much:
//   sit   (x, y, z) is the seat: the point on the cushion under the hips.
//   swim  y is ignored. The body floats at the sea surface (WATER_Y).

import * as THREE from 'three';
import type { Look, PeopleApi, Person, Pose } from '../core/api';
import type { Game } from '../core/game';
import { RNG, TAU, clamp, clamp01, damp, hash2, lerp, smooth } from '../core/util';
import { flip, sendRange } from '../core/flip';
import { assets } from '../core/assets';
import { groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import type { Ragdolls } from './ragdoll';
import { BONES, MORPHS, PARTS, loadPeople, type BodyKind, type PersonAsset } from './characterAssets';

export type HairCut = 'crop' | 'part' | 'long' | 'bob' | 'tail' | 'bun' | 'curls' | 'afro' | 'bald';
export type TopKind = 'tee' | 'shirt' | 'hoodie' | 'jacket' | 'coverall' | 'dress';
export type BottomKind = 'trousers' | 'jeans' | 'shorts' | 'skirt';
export type HatKind = 'cap' | 'beanie' | 'brim';

/**
 * A Look with the optional details randomLook() adds. A plain Look works
 * everywhere and gets defaults: top and bottom the same colour is a one-piece
 * (coveralls, boots, pony tail: Dess); anything else is a uniform shirt and
 * trousers on the man's body.
 */
export interface StyledLook extends Look {
  cut?: HairCut;
  beard?: boolean | 'stubble';
  topKind?: TopKind;
  bottomKind?: BottomKind;
  shoeKind?: 'sneakers' | 'boots';
  hatKind?: HatKind;
  /** Cap worn brim-backwards. */
  capBack?: boolean;
  glasses?: boolean;
  bag?: boolean;
  /** Which of FACES. */
  face?: number;
  /** Multiplayer: the small details (eye and bag colour, the cast of the face) come from this instead of the body's own number, so they match on every screen. */
  seed?: number;
  /** Which body. Default: by haircut (long, tail and bun are the woman's shape). */
  body?: BodyKind;
}

const MAX_PEOPLE = 160;
// One row of the crowd texture: the bones, three texels each, then the palette.
const PAL0 = BONES.length * 3;
/** After the palette: four texels of morph weights (face, face and eyes, left hand, right hand). */
const MOR0 = PAL0 + PARTS.length;
const TEX_W = MOR0 + 4;
const NLOD = 3;
/** How many people at once may be the full model. */
const NEAR = 8, NEAR_LOW = 2;
/** Nearer than this a person is the full model. The phone preset keeps that for whoever the camera is on. */
const LOD_DIST = 11, LOD_DIST_LOW = 3.5;
/** Past this a person is the crowd model: no face, no fingers. */
const LOD2_DIST = 38, LOD2_DIST_LOW = 9;
const bone = (n: (typeof BONES)[number]): number => BONES.indexOf(n);
const B_HIPS = bone('hips'), B_SPINE = bone('spine'), B_CHEST = bone('chest'), B_NECK = bone('neck'), B_HEAD = bone('head');
const B_ARM = [bone('shoulder_l'), bone('shoulder_r')], B_LEG = [bone('thigh_l'), bone('thigh_r')];
const MAX_PARTS = 23;
const DRAW_DIST = 220;
/** Past this the eyes, hands, neck and hat brim are smaller than a pixel and are left out. */
const DETAIL_DIST = 70;

// ── Proportions of a 1.75 m person (look.height scales the lot at the root) ────

const HIP = 0.9, THIGH = 0.42, SHIN = 0.395, ANKLE = 0.085;
const LEG = THIGH + SHIN;
/** Legs never quite lock straight: a locked knee snaps in and out as the foot target moves. */
const REACH = LEG * 0.985;
const TOE = 0.19, HEEL = 0.07;
const HIP_X = 0.092;
const SPINE = 0.1, NECK = 0.46, SHOULDER = 0.4;
const UPPER = 0.28, FORE = 0.24;
const STAND_HIP = 0.887;

// ── Channels: everything a pose can say about a body ───────────────────────────
// Angles are radians and positive in the natural direction: swing forward,
// abduct outward, bend, lean forward, nod down. Index 0 of a pair is the left.

const RX = 0, RY = 1, RZ = 2;      // pelvis offset from its standing spot
const TIP = 3;                     // whole body toppling about the feet (+ forward)
const YAW = 4, PITCH = 5, ROLL = 6;
const LEAN = 7, TWIST = 8, SROLL = 9;
const HYAW = 10, HPITCH = 11, HROLL = 12;
const ASW = 13, AAB = 14, AEL = 15; // left arm: swing, abduct, elbow. Right arm is +3.
const LSW = 19, LAB = 20, LKN = 21, LFT = 22; // left leg: swing, abduct, knee, ankle. Right leg is +4.
const BREATH = 27;
const WATER = 28;                  // 0 = standing on p.y, 1 = floating at the sea surface
const NCH = 29;
/** The channel numbers, for ent/ragdoll.ts. */
export const CH = { RX, RY, RZ, TIP, YAW, PITCH, ROLL, LEAN, TWIST, SROLL, HYAW, HPITCH, HROLL, ASW, AAB, AEL, LSW, LAB, LKN, LFT } as const;
export { NCH, HIP };

// Colour slots in Body.rgb.
const C_SKIN = 0, C_HAIR = 3, C_TOP = 6, C_BOTTOM = 9, C_SHOES = 12, C_HAT = 15, C_EYE = 18;
const EYE = 0x1a1d29;

class Body implements Person {
  x = 0; y = 0; z = 0; h = 0;
  pose: Pose = 'stand';
  speed = 0;
  visible = true;
  health = 100;
  occupant?: boolean;
  /** Written by the weapons code: 0..1 of an arm (or both) raised along the line of fire, and that line's pitch in radians. */
  aim = 0; aimPitch = 0; aimTwo = false;

  // Animation state. Nothing outside this file reads it.
  readonly cur = new Float32Array(NCH);
  readonly from = new Float32Array(NCH);
  shown: Pose = 'stand';
  blend = 1;
  blendDur = 0.15;
  poseT = 10;
  t: number;
  /** Stride cycle 0..1; the left foot lands at 0, the right at 0.5. */
  phase: number;
  stroke: number;
  gaitSpeed = 0;
  /** Deep enough in the sea that a run is drawn as a wade. */
  wading = false;
  /** Which leg leads a jump (0 left, 1 right): the one the stride had forward. */
  lead = 0;
  falls = 0;
  readonly seed: number;
  readonly swagger: number;
  readonly rgb = new Float32Array(21);
  lookKey = NaN;
  /** Skinned people: colour and visibility of every part, and which body. */
  readonly pal = new Float32Array(PARTS.length * 4);
  /** Morph weights as the shader reads them: jaw nose brow age | blink lookx looky - | left hand fist wheel gun - | right hand. */
  readonly mor = new Float32Array(16);
  /** Written by whoever seats them: on a bench instead of at a wheel. */
  bench = false;
  palFor: Look | null = null;
  kind = 0;
  face = 0;
  /** Ragdoll (ent/ragdoll.ts): the pelvis frame and the limb channels it drives, while it has the body. */
  rag: Float64Array | null = null;
  ragCh: Float32Array | null = null;
  /** Which way the next 'down' lands: +1 face down, -1 face up, 0 = as the fall decides. */
  downFace = 0;
  /** Seconds of dusting off after getting up from a ragdoll, and whether one is owed. */
  dustT = 0;
  dustOwed = false;

  constructor(readonly id: number, public look: Look) {
    this.seed = (Math.imul(id, 2654435761) >>> 0) % 9973;
    const r = hash2(id, 77);
    // Staggered clocks, so a crowd does not breathe and blink in unison.
    this.t = r * 40;
    this.phase = hash2(id, 78);
    this.stroke = hash2(id, 79);
    this.swagger = 0.85 + 0.3 * hash2(id, 80);
  }
}

// ── Scratch storage (update() allocates nothing) ───────────────────────────────

const TGT = new Float32Array(NCH);
const M_PELVIS = new Float64Array(16);
const M_TORSO = new Float64Array(16);
const M_LIMB = new Float64Array(16);
const FOOT_Z = [0, 0], FOOT_Y = [0, 0], FOOT_P = [0, 0], HIP_CAP = [0, 0];
const COLOR = new THREE.Color();
const FWD = new THREE.Vector3();

// Write cursor for part(): the instance buffers being filled and how many are in.
let OUT_M: Float32Array, OUT_C: Float32Array, OUT_S: Float32Array;
let OUT_N = 0;

// Post-multiply a column-major 4x4 in place. Only the columns a rotation mixes are touched.
function rotX(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) {
    const y = m[4 + i], z = m[8 + i];
    m[4 + i] = y * c + z * s;
    m[8 + i] = z * c - y * s;
  }
}
function rotY(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) {
    const x = m[i], z = m[8 + i];
    m[i] = x * c - z * s;
    m[8 + i] = x * s + z * c;
  }
}
function rotZ(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) {
    const x = m[i], y = m[4 + i];
    m[i] = x * c + y * s;
    m[4 + i] = y * c - x * s;
  }
}
function move(m: Float64Array, x: number, y: number, z: number): void {
  m[12] += m[0] * x + m[4] * y + m[8] * z;
  m[13] += m[1] * x + m[5] * y + m[9] * z;
  m[14] += m[2] * x + m[6] * y + m[10] * z;
}

/**
 * One box in frame `f`: centre, size, colour slot, and how much its bottom end
 * narrows (tx, tz; 1 = straight sides).
 */
function part(
  f: Float64Array, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number,
  rgb: Float32Array, ci: number, tx: number, tz: number,
): void {
  const m = OUT_M, o = OUT_N * 16;
  m[o] = f[0] * sx; m[o + 1] = f[1] * sx; m[o + 2] = f[2] * sx; m[o + 3] = 0;
  m[o + 4] = f[4] * sy; m[o + 5] = f[5] * sy; m[o + 6] = f[6] * sy; m[o + 7] = 0;
  m[o + 8] = f[8] * sz; m[o + 9] = f[9] * sz; m[o + 10] = f[10] * sz; m[o + 11] = 0;
  m[o + 12] = f[0] * cx + f[4] * cy + f[8] * cz + f[12];
  m[o + 13] = f[1] * cx + f[5] * cy + f[9] * cz + f[13];
  m[o + 14] = f[2] * cx + f[6] * cy + f[10] * cz + f[14];
  m[o + 15] = 1;
  const c = OUT_N * 3;
  OUT_C[c] = rgb[ci]; OUT_C[c + 1] = rgb[ci + 1]; OUT_C[c + 2] = rgb[ci + 2];
  OUT_S[OUT_N * 2] = tx; OUT_S[OUT_N * 2 + 1] = tz;
  OUT_N++;
}

/** Move frame `m` from joint `a` to joint `b` of the rest skeleton, the sideways part widened by `wx`. */
function hop(m: Float64Array, J: Float32Array, a: number, b: number, wx: number): void {
  move(m, (J[b * 3] - J[a * 3]) * wx, J[b * 3 + 1] - J[a * 3 + 1], J[b * 3 + 2] - J[a * 3 + 2]);
}

/**
 * Write bone `b`'s skinning matrix into a texture row at `o`: frame `m`, widened
 * by (gx, gz) about its own joint, times the joint's inverse rest position. Stored by rows.
 */
function put(D: Float32Array, o: number, J: Float32Array, b: number, m: Float64Array, gx: number, gz: number): void {
  const jx = J[b * 3], jy = J[b * 3 + 1], jz = J[b * 3 + 2];
  o += b * 12;
  for (let r = 0; r < 3; r++) {
    const x = m[r] * gx, y = m[4 + r], z = m[8 + r] * gz;
    D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = m[12 + r] - (x * jx + y * jy + z * jz);
    o += 4;
  }
}

/**
 * The crowd shader: skin from the row texture, tint by the palette, fold hidden parts to a point.
 * `morph` adds the nearest level's five shape slots; `pbr` gives every surface class its own response.
 */
/** Night fill on people (0 by day): a soft moonlit-blue lift so a figure away from the lamps still reads. Written by People.update. */
const FILL = { value: 0 };

function skinned(tex: THREE.DataTexture, lit: boolean, morph: boolean, pbr: boolean): (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) => void {
  return (shader) => {
    shader.uniforms.uPeople = { value: tex };
    let v = shader.vertexShader.replace('#include <common>', `#include <common>
attribute vec4 aSkin;
attribute vec3 aInfo;
attribute float aRow;
${morph ? 'attribute vec3 aM0;\nattribute vec3 aM1;\nattribute vec3 aM2;\nattribute vec3 aM3;\nattribute vec3 aM4;' : ''}
uniform highp sampler2D uPeople;
varying float vCls;
varying vec3 vBind;
vec4 pcM0, pcM1, pcM2, pcPal;
void pcFetch() {
  int r = int(aRow + 0.5), a = int(aSkin.x + 0.5) * 3, b = int(aSkin.y + 0.5) * 3;
  pcM0 = mix(texelFetch(uPeople, ivec2(b, r), 0), texelFetch(uPeople, ivec2(a, r), 0), aSkin.z);
  pcM1 = mix(texelFetch(uPeople, ivec2(b + 1, r), 0), texelFetch(uPeople, ivec2(a + 1, r), 0), aSkin.z);
  pcM2 = mix(texelFetch(uPeople, ivec2(b + 2, r), 0), texelFetch(uPeople, ivec2(a + 2, r), 0), aSkin.z);
  pcPal = texelFetch(uPeople, ivec2(${PAL0} + int(aSkin.w + 0.5), r), 0);
}`);
    if (lit) {
      v = v.replace('#include <color_vertex>', 'pcFetch();\n#include <color_vertex>\nvColor.rgb *= mix(pcPal.rgb, vec3(1.0), aInfo.y);\nvCls = aInfo.x;\nvBind = position;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = vec3(dot(pcM0.xyz, objectNormal), dot(pcM1.xyz, objectNormal), dot(pcM2.xyz, objectNormal));');
    }
    const shape = morph ? `vec3 pcQ = position;
{
  int r = int(aRow + 0.5), g = int(aInfo.z + 0.5);
  vec4 f0 = texelFetch(uPeople, ivec2(${MOR0}, r), 0), f1 = texelFetch(uPeople, ivec2(${MOR0 + 1}, r), 0);
  vec4 wa = f0; float wb = f1.x;
  if (g == 1) { wa = vec4(0.0, 0.0, f0.z, f1.y); wb = f1.z; }
  else if (g > 1) { wa = texelFetch(uPeople, ivec2(${MOR0} + g, r), 0); wb = 0.0; }
  pcQ += aM0 * wa.x + aM1 * wa.y + aM2 * wa.z + aM3 * wa.w + aM4 * wb;
}
vec4 pcP = vec4(pcQ, 1.0);` : 'vec4 pcP = vec4(position, 1.0);';
    shader.vertexShader = v.replace('#include <begin_vertex>',
      (lit ? '' : 'pcFetch();\n') + shape + '\nvec3 transformed = vec3(dot(pcM0, pcP), dot(pcM1, pcP), dot(pcM2, pcP)) * pcPal.a;');
    if (lit) {
      shader.uniforms.uFill = FILL;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFill;')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * uFill * vec3(0.74, 0.82, 1.0);');
    }
    if (!pbr) return;
    // Skin, cloth, leather, rubber, hair, metal, eye, plastic: each its own roughness; cloth gets a
    // soft sheen at grazing angles and skin a warmer shadow side, which is as much subsurface as this can afford.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCls;\nvarying vec3 vBind;')
      // Up close cloth has a weave and skin is not one flat colour. Both fade out before they can shimmer.
      .replace('#include <color_fragment>', `#include <color_fragment>
int pcC = int(vCls + 0.5);
float pcNear = 1.0 - smoothstep(0.35, 1.2, fwidth(vBind.y) * 1100.0);
vec2 pcW = vec2(sin(vBind.x * 1100.0 + vBind.z * 700.0), sin(vBind.y * 1100.0));
if (pcC == 1) diffuseColor.rgb *= 1.0 + 0.07 * pcNear * pcW.x * pcW.y + 0.035 * sin(vBind.y * 31.0 + 2.0 * sin(vBind.x * 17.0 + vBind.z * 13.0));
else if (pcC == 0) diffuseColor.rgb *= vec3(1.0, 0.985, 0.975) + vec3(0.03, 0.045, 0.045) * sin(vBind.y * 23.0 + 3.0 * sin(vBind.x * 41.0 + vBind.z * 29.0));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (pcC == 1) normal = normalize(normal + 0.10 * pcNear * vec3(pcW.x, pcW.y, 0.0));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = pcC == 0 ? 0.56 : pcC == 1 ? 0.93 : pcC == 2 ? 0.46 : pcC == 3 ? 0.78 : pcC == 4 ? 0.52 : pcC == 5 ? 0.32 : pcC == 6 ? 0.06 : 0.28;`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (pcC == 5) metalnessFactor = 1.0;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
float pcRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
if (pcC == 1) { reflectedLight.indirectDiffuse *= 1.0 + 0.7 * pcRim; reflectedLight.directDiffuse *= 1.0 + 0.4 * pcRim; }
else if (pcC == 0) { reflectedLight.indirectDiffuse *= vec3(1.14, 1.0, 0.9); reflectedLight.directDiffuse *= vec3(1.0) + vec3(0.22, 0.05, 0.0) * pcRim; }
else if (pcC == 4) { reflectedLight.indirectDiffuse *= 1.0 + 0.5 * pcRim; }
// Eyes are wet and catch light from everywhere: without this they are two dark holes under any hat.
else if (pcC == 6) { reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.22 * (0.25 + reflectedLight.indirectDiffuse); }`);
  };
}

// ── Pose helpers ──────────────────────────────────────────────────────────────

/** A 0..1 value that sits still most of the time, then eases to the next one: glances, weight shifts. */
function drift(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  return lerp(hash2(i, seed), hash2(i + 1, seed), smooth((f - 0.6) / 0.4));
}

/** Smooth minimum: where the two legs trade the job of holding the pelvis up, round the corner. */
function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/**
 * Solve one leg in the fore-aft plane: hip at height hipY (over the body's own
 * spot), ankle wanted at (az, ay), foot at `foot` radians toe-down from level.
 * `pitch` is the pelvis's own forward tilt, which the hip joint has to undo.
 */
function leg(o: Float32Array, i: number, hipY: number, az: number, ay: number, pitch: number, foot: number): void {
  const dy = hipY - ay;
  const d = clamp(Math.hypot(az, dy), 0.3, REACH);
  const along = Math.atan2(az, dy);
  const open = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1));
  const knee = Math.PI - Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN), -1, 1));
  const swing = along + open;
  const k = i * 4;
  o[LSW + k] = swing + pitch;
  o[LKN + k] = knee;
  o[LFT + k] = foot + swing - knee;
}

// Water over the knee: nobody runs through that, whatever speed the body is being moved at.
const WADE_DEPTH = 0.6;

function strideLen(v: number, run: boolean): number {
  return run ? 1 + 0.4 * v : Math.max(0.3, 1.14 * Math.sqrt(v));
}

function blendTime(from: Pose, to: Pose): number {
  if (from === 'down') return 0.5;                  // getting up
  if (to === 'down') return 0.1;                    // the fall has its own timing
  // Standing up out of the sea lifts the whole body through the surface: any quicker and she pops.
  if (from === 'swim') return 0.45;
  if (to === 'swim') return 0.3;
  if (from === 'sit' || to === 'sit') return 0.25;
  if (to === 'jump') return 0.1;
  return 0.16;
}

// ── The poses ────────────────────────────────────────────────────────────────

function stand(b: Body, o: Float32Array): void {
  o.fill(0);
  const t = b.t, s = b.seed;
  const breath = Math.sin(t * 1.5);
  // Weight settles on one leg for a while, then the other: contrapposto, not attention.
  let sh = drift(t * 0.13, s) * 2 - 1;
  sh = Math.sign(sh) * Math.sqrt(Math.abs(sh));
  const roll = 0.05 * sh;
  o[RX] = 0.032 * sh;
  o[ROLL] = roll;
  const hip = STAND_HIP - 0.003 * breath;
  o[RY] = hip - HIP;
  for (let i = 0; i < 2; i++) {
    const side = i ? -1 : 1;
    // The idle foot rests a little ahead with its knee soft.
    const idle = Math.max(0, -side * sh);
    leg(o, i, hip + side * HIP_X * Math.sin(roll) - 0.012 * idle, 0.07 * idle - 0.01, ANKLE, 0, 0);
  }
  const tilt = -roll - o[RX] / 0.8;
  o[LAB] = tilt + 0.03;
  o[LAB + 4] = -tilt + 0.03;
  o[SROLL] = -roll * 1.25;
  o[LEAN] = 0.02 - 0.012 * breath;
  o[TWIST] = 0.05 * Math.sin(t * 0.31 + s);
  o[HYAW] = 0.6 * (drift(t * 0.3 + 3.1, s + 11) * 2 - 1);
  o[HPITCH] = 0.03 + 0.1 * (drift(t * 0.21, s + 5) * 2 - 1);
  o[HROLL] = roll * 0.5;
  for (let i = 0; i < 2; i++) {
    const side = i ? -1 : 1, k = i * 3;
    o[ASW + k] = 0.05 + 0.03 * Math.sin(t * 0.6 + s + i * 2) - 0.03 * side * sh;
    o[AAB + k] = 0.1 + 0.012 * breath + 0.03 * side * sh;
    o[AEL + k] = 0.22 + 0.04 * Math.sin(t * 0.47 + s + i);
  }
  o[BREATH] = breath;
}

function gait(b: Body, o: Float32Array, run: boolean): void {
  o.fill(0);
  // Chest-deep water holds the legs to a wade however fast the body is carried along.
  const v = b.wading ? Math.min(b.gaitSpeed, 1.5) : b.gaitSpeed;
  // Barely moving is nearly standing: without this a crawl is a slow-motion march.
  const g = smooth(v / 0.6);
  const S = strideLen(v, run);
  // Fraction of the cycle a foot spends on the ground. Under half means both are in the air at once.
  const D = run ? clamp(0.95 / S, 0.22, 0.4) : Math.min(0.62, 0.9 / S);
  const travel = S * D;
  const zf = travel * (run ? 0.32 : 0.43), zb = zf - travel;
  // The foot leaves and meets the ground already moving backwards at ground speed.
  // Running keeps only part of that: the full figure throws the trailing foot a quarter meter
  // further back and the leading one as far forward, and at a sprint that is the splits.
  const m = -S * (1 - D) * (run ? 0.45 : 1);
  const ph = b.phase;
  const strikeA = run ? 0.1 : 0.34, offA = run ? 0.95 : 0.62;
  const liftH = run ? 0.18 + 0.035 * v : 0.06 + 0.025 * v;
  const base = lerp(STAND_HIP, run ? 0.852 : 0.878, g);

  for (let i = 0; i < 2; i++) {
    let f = ph + i * 0.5;
    f -= Math.floor(f);
    let z: number, lift = 0, fp: number, hold: number;
    if (f < D) {
      const u = f / D;
      z = zf - u * travel;
      fp = -strikeA * (1 - smooth(u / 0.2)) + offA * smooth((u - 0.5) / 0.5);
      // A running leg stops carrying the body well before it leaves the ground.
      hold = run ? 1 - smooth((u - 0.45) / 0.4) : 1;
    } else {
      const w = (f - D) / (1 - D), w2 = w * w, w3 = w2 * w;
      z = (2 * w3 - 3 * w2 + 1) * zb + (w3 - 2 * w2 + w) * m + (3 * w2 - 2 * w3) * zf + (w3 - w2) * m;
      // Running kicks the heel up early in the swing; walking just clears the ground.
      lift = liftH * Math.sin(Math.PI * w) * (1 + (run ? 0.8 : 0.1) * Math.cos(Math.PI * w));
      fp = offA * (1 - smooth(w / 0.5)) - strikeA * smooth((w - 0.65) / 0.35);
      hold = Math.max(run ? 0 : 1 - smooth(w / 0.2), smooth((w - 0.9) / 0.1));
    }
    fp *= g;
    const ay = ANKLE + lift * g + (fp > 0 ? TOE : -HEEL) * Math.sin(fp);
    FOOT_Z[i] = z; FOOT_Y[i] = ay; FOOT_P[i] = fp;
    // How high the pelvis may ride before this leg can no longer reach its foot.
    HIP_CAP[i] = lerp(base + 0.2, ay + Math.sqrt(Math.max(REACH * REACH - z * z, 0.01)), hold);
  }
  let hip = base;
  if (run) hip += 0.035 * g * Math.cos(2 * TAU * (ph - (D + 0.5) / 2));
  hip = Math.min(hip, smin(HIP_CAP[0], HIP_CAP[1], 0.03));
  o[RY] = hip - HIP;

  const pitch = (run ? 0.1 + 0.012 * v : 0.02) * g;
  o[PITCH] = pitch;
  // Over the left foot at mid-stance: hips sway that way and the free side drops.
  const side = Math.sin(TAU * (ph - D / 2 + 0.25)) * g;
  const roll = (run ? 0.045 : 0.055) * side;
  o[ROLL] = roll;
  o[RX] = (run ? 0.012 : 0.022) * side;
  const yaw = -(run ? 0.17 : Math.min(0.16, 0.1 * S / 1.35)) * g * Math.cos(TAU * ph);
  o[YAW] = yaw;
  o[TWIST] = -yaw * (run ? 2.3 : 1.9);
  o[SROLL] = -roll * 1.2;
  o[LEAN] = (run ? 0.08 + 0.014 * v : 0.03 + 0.015 * v) * g;
  o[HYAW] = -(yaw + o[TWIST]);
  o[HPITCH] = -(pitch + o[LEAN]) * 0.8 + 0.02 * g * Math.cos(2 * TAU * ph);
  o[HROLL] = roll * 0.3;

  for (let i = 0; i < 2; i++) {
    const sgn = i ? -1 : 1;
    leg(o, i, hip + sgn * HIP_X * Math.sin(roll), FOOT_Z[i], FOOT_Y[i], pitch, FOOT_P[i]);
  }
  // Legs lean against the pelvis's sway and tilt so the feet stay under the body, near one line.
  const tilt = -roll - o[RX] / 0.8;
  const narrow = lerp(0.03, -0.035, g);
  o[LAB] = tilt + narrow;
  o[LAB + 4] = -tilt + narrow;

  // Arms swing against the legs, a beat late.
  const A = (run ? 0.9 : Math.min(0.75, 0.42 * S / 1.35) * b.swagger) * g;
  const sw = -Math.cos(TAU * (ph - 0.03));
  for (let i = 0; i < 2; i++) {
    const a = (i ? -sw : sw), k = i * 3;
    o[ASW + k] = (run ? 0.12 : 0.04) * g + A * a;
    o[AAB + k] = lerp(0.1, run ? 0.17 : 0.09, g);
    o[AEL + k] = run ? lerp(0.22, 1.45 + 0.3 * a, g) : 0.22 + (0.1 + 0.28 * Math.max(0, a)) * g;
  }
  o[BREATH] = Math.sin(b.t * (run ? 4 : 2));
}

function jump(b: Body, o: Float32Array): void {
  o.fill(0);
  const k = smooth(b.poseT / 0.2);
  const a = b.lead * 4, c = 4 - a;
  o[PITCH] = 0.14 * k;
  o[LEAN] = 0.08 * k;
  o[HPITCH] = -0.2 * k;
  o[LSW + a] = 1.05 * k; o[LKN + a] = 1.5 * k; o[LFT + a] = 0.35 * k;
  o[LSW + c] = 0.4 * k; o[LKN + c] = 1.2 * k; o[LFT + c] = 0.6 * k;
  o[LAB] = o[LAB + 4] = 0.06;
  o[ASW] = 2.55 * k; o[ASW + 3] = 2.25 * k;
  o[AAB] = o[AAB + 3] = 0.1 + 0.25 * k;
  o[AEL] = o[AEL + 3] = 0.2 + 0.2 * k;
}

function fall(b: Body, o: Float32Array): void {
  o.fill(0);
  const t = b.t * 10;
  const a = b.lead * 4, c = 4 - a;
  o[PITCH] = -0.05;
  o[LEAN] = 0.14;
  o[HPITCH] = 0.3;
  // Legs reach for the ground, pedalling a little; arms windmill for balance.
  o[LSW + a] = 0.42 + 0.1 * Math.sin(t * 0.8); o[LKN + a] = 0.5; o[LFT + a] = 0.3;
  o[LSW + c] = -0.12 - 0.1 * Math.sin(t * 0.8); o[LKN + c] = 0.75; o[LFT + c] = 0.55;
  o[LAB] = o[LAB + 4] = 0.12;
  for (let i = 0; i < 2; i++) {
    const k = i * 3, p = t + i * 2.1;
    o[ASW + k] = 0.35 + 0.3 * Math.cos(p);
    o[AAB + k] = 1.75 + 0.22 * Math.sin(p);
    o[AEL + k] = 0.45;
  }
}

function swim(b: Body, o: Float32Array): void {
  o.fill(0);
  // 0 = treading water upright, 1 = front crawl.
  const s = smooth((b.gaitSpeed - 0.2) / 0.9);
  const ps = b.stroke, kick = TAU * ps * 3;
  o[WATER] = 1;
  o[PITCH] = lerp(0.2, 1.36, s);
  // Treading: chin at the waterline. Crawling: back just awash.
  o[RY] = -HIP + lerp(-0.6 + 0.025 * Math.sin(kick), -0.17 + 0.015 * Math.sin(2 * TAU * ps), s);
  o[RZ] = -0.2 * s;
  o[LEAN] = lerp(0.06, -0.12, s);
  // Shoulders roll toward whichever arm is coming forward over the water.
  o[TWIST] = 0.45 * s * Math.cos(TAU * (ps - 0.775));
  o[HYAW] = -o[TWIST] * 0.7;
  o[HPITCH] = lerp(-0.12, -0.95, s);
  for (let i = 0; i < 2; i++) {
    let f = ps + i * 0.5;
    f -= Math.floor(f);
    let swing: number, ab: number, el: number;
    if (f < 0.55) {
      // Pull: from full reach ahead, down under the body, back to the hip.
      const u = f / 0.55;
      swing = lerp(2.95, 0.1, smooth(u)); ab = 0.08; el = 0.7 * Math.sin(Math.PI * u);
    } else {
      // Recover: out wide and low over the water. Going around the side means no
      // angle ever wraps, so blends in and out of the water never spin an arm.
      const w = (f - 0.55) / 0.45;
      swing = lerp(0.1, 2.95, smooth(w)); ab = 1.2 * Math.sin(Math.PI * w); el = 0.9 * Math.sin(Math.PI * w);
    }
    const a = i * 3, p = kick + i * Math.PI;
    o[ASW + a] = lerp(0.35 + 0.45 * Math.sin(p), swing, s);
    o[AAB + a] = lerp(1.05, ab, s);
    o[AEL + a] = lerp(0.5, el, s);
    const l = i * 4;
    o[LSW + l] = lerp(0.45 + 0.35 * Math.sin(p), 0.08 + 0.26 * Math.sin(p), s);
    o[LKN + l] = lerp(0.9 + 0.4 * Math.sin(p + 1.2), 0.22 + 0.2 * Math.sin(p - 1), s);
    o[LAB + l] = lerp(0.3, 0.05, s);
    o[LFT + l] = lerp(0.3, 0.9, s);
  }
}

function down(b: Body, o: Float32Array): void {
  o.fill(0);
  const f = b.poseT / 0.42;
  // Toppling speeds up like anything falling, then one small bounce and stillness.
  const e = f < 1 ? f * f : 1;
  const bounce = f > 1 ? Math.exp(-(f - 1) * 5) * Math.sin((f - 1) * 8) * 0.07 : 0;
  // Most land on their backs; some fall forward. It changes fall to fall.
  const front = b.downFace ? b.downFace > 0 : hash2(b.seed, b.falls) < 0.3;
  const dir = front ? 1 : -1;
  const flip = hash2(b.seed + 1, b.falls) < 0.5 ? 1 : 0;
  const a = flip * 4, c = 4 - a, aa = flip * 3, ac = 3 - aa;
  const mid = Math.sin(Math.PI * clamp01(f));
  o[TIP] = dir * (Math.PI / 2) * (e - bounce);
  // Lying, the body's middle rests half its own thickness off the ground.
  o[RZ] = -dir * 0.115 * e;
  o[RY] = -0.2 * mid;
  o[LEAN] = 0.25 * mid * -dir;
  if (front) {
    o[ASW + aa] = lerp(1.2, 3.3, e); o[AAB + aa] = 0.55 * e; o[AEL + aa] = 0.25;
    o[ASW + ac] = lerp(1.5, 3.2, e); o[AAB + ac] = 1.0 * e; o[AEL + ac] = 0.6 * e + 0.2;
    o[LSW + a] = 0; o[LKN + a] = 0.5 * mid + 0.06; o[LAB + a] = 0.1 * e; o[LFT + a] = 1.3 * e;
    o[LSW + c] = 0; o[LKN + c] = 0.3 * mid + 0.1; o[LAB + c] = 0.25 * e; o[LFT + c] = 1.3 * e;
    o[HYAW] = (flip ? -1.15 : 1.15) * e;
    o[HPITCH] = -0.25 * e;
  } else {
    o[ASW + aa] = 1.1 * mid; o[AAB + aa] = 0.2 + 1.0 * e; o[AEL + aa] = 0.2;
    o[ASW + ac] = 0.9 * mid; o[AAB + ac] = 0.2 + 0.3 * e; o[AEL + ac] = 0.15;
    // One knee ends up raised with the foot flat: knocked over, not laid out.
    o[LSW + a] = 0.55 * e + 0.3 * mid; o[LKN + a] = 1.23 * e + 0.2 * mid; o[LAB + a] = 0.12 * e; o[LFT + a] = 0.75 * e;
    o[LSW + c] = 0.3 * mid; o[LKN + c] = 0.5 * mid + 0.04; o[LAB + c] = 0.22 * e; o[LFT + c] = 0.3 * e;
    o[HYAW] = (flip ? -0.6 : 0.6) * e;
    o[HPITCH] = 0.35 * mid;
  }
}

/** On a bench: thighs level, shins down, back against the slats, hands in the lap. */
function sitBench(b: Body, o: Float32Array): void {
  o.fill(0);
  const t = b.t, breath = Math.sin(t * 1.5), s = b.seed;
  const pitch = -0.12;
  o[RY] = -HIP + 0.1;
  o[PITCH] = pitch;
  o[LEAN] = 0.06 - 0.012 * breath;
  o[HPITCH] = 0.08 + 0.08 * (drift(t * 0.2, s + 5) * 2 - 1);
  o[HYAW] = 0.5 * (drift(t * 0.25, s + 11) * 2 - 1);
  // One foot a little ahead of the other; nobody sits square.
  const fwd = hash2(s, 3) < 0.5 ? 0 : 4;
  for (let i = 0; i < 2; i++) {
    const l = i * 4, ahead = l === fwd ? 1 : 0;
    o[LSW + l] = 1.5 + pitch; o[LKN + l] = 1.5 - 0.3 * ahead; o[LAB + l] = 0.12;
    // Sole flat on the ground whatever the knee is doing.
    o[LFT + l] = -pitch + o[LSW + l] - o[LKN + l] + (ahead ? 0.05 : 0);
    const k = i * 3;
    o[ASW + k] = 0.42 + 0.02 * Math.sin(t * 0.7 + i * 2);
    o[AAB + k] = -0.02;
    o[AEL + k] = 1.05;
  }
  o[BREATH] = breath;
}

function sit(b: Body, o: Float32Array): void {
  if (b.bench) { sitBench(b, o); return; }
  o.fill(0);
  const t = b.t, breath = Math.sin(t * 1.5);
  const pitch = -0.2;
  o[RY] = -HIP + 0.085;
  o[PITCH] = pitch;
  o[LEAN] = 0.1 - 0.01 * breath;
  o[HPITCH] = 0.1;
  o[HYAW] = 0.25 * (drift(t * 0.25, b.seed + 11) * 2 - 1);
  // Left foot resting, right foot further out on the pedal.
  o[LSW] = 1.32; o[LKN] = 1.05; o[LAB] = 0.1;
  o[LSW + 4] = 1.25; o[LKN + 4] = 0.8; o[LAB + 4] = 0.08;
  o[LFT] = -0.3 - pitch + o[LSW] - o[LKN];
  o[LFT + 4] = -0.45 - pitch + o[LSW + 4] - o[LKN + 4];
  for (let i = 0; i < 2; i++) {
    const k = i * 3;
    o[ASW + k] = 1.0 + 0.025 * Math.sin(t * 0.9 + i * 3);
    o[AAB + k] = -0.08;
    o[AEL + k] = 0.5;
  }
  o[BREATH] = breath;
}

/** The three fields above, for the code that writes them (ent/weapons.ts). */
export interface Aimable { aim: number; aimPitch: number; aimTwo: boolean }

/**
 * Laid over whatever the legs are doing: the right arm out along the line of
 * fire, the left hand under the weapon if it needs two, head and chest squared up.
 */
function aimOver(b: Body, c: Float32Array): void {
  const k = smooth(b.aim), up = Math.PI / 2 + b.aimPitch;
  c[ASW + 3] = lerp(c[ASW + 3], up, k);
  c[AAB + 3] = lerp(c[AAB + 3], 0.04, k);
  c[AEL + 3] = lerp(c[AEL + 3], 0.1, k);
  if (b.aimTwo) {
    c[ASW] = lerp(c[ASW], up - 0.12, k);
    c[AAB] = lerp(c[AAB], -0.38, k);
    c[AEL] = lerp(c[AEL], 0.55, k);
    c[TWIST] = lerp(c[TWIST], -0.3, k);
  } else {
    c[TWIST] = lerp(c[TWIST], 0.18, k);
  }
  c[HYAW] = lerp(c[HYAW], b.aimTwo ? 0.3 : -0.18, k);
  c[HPITCH] = lerp(c[HPITCH], 0, k);
  c[SROLL] = lerp(c[SROLL], 0, k);
}

/** After a ragdoll: wobble, pat the dust off the front, a shake of the head. Laid over standing or walking. */
function dustOff(b: Body, c: Float32Array, dt: number): void {
  b.dustT = Math.max(0, b.dustT - dt);
  const u = b.dustT / 1.8, w = smooth(Math.min(1, (1 - u) * 6)) * smooth(Math.min(1, u * 4));
  if (w <= 0) return;
  const t = b.t, pat = Math.sin(t * 15);
  c[ROLL] = lerp(c[ROLL], 0.07 * Math.sin(t * 4.5), w);
  c[RX] = lerp(c[RX], 0.035 * Math.sin(t * 4.5 + 0.6), w);
  c[LEAN] = lerp(c[LEAN], 0.32, w);
  c[HPITCH] = lerp(c[HPITCH], 0.35, w);
  c[HYAW] = lerp(c[HYAW], 0.3 * Math.sin(t * 9), w);
  // Right hand brushes down the front; left one slaps a thigh.
  c[ASW + 3] = lerp(c[ASW + 3], 0.75 + 0.25 * pat, w); c[AAB + 3] = lerp(c[AAB + 3], -0.15, w); c[AEL + 3] = lerp(c[AEL + 3], 1.35 + 0.25 * pat, w);
  c[ASW] = lerp(c[ASW], 0.25 + 0.2 * Math.sin(t * 15 + 1.5), w); c[AAB] = lerp(c[AAB], 0.12, w); c[AEL] = lerp(c[AEL], 0.6, w);
}

/** A ragdoll takes over the body: its pelvis frame (column-major 4x4, scale included) and its channels replace the animation. */
export function ragAttach(p: Person, m: Float64Array, ch: Float32Array): void {
  const b = p as Body;
  b.rag = m; b.ragCh = ch;
}

/** The current channels, for a ragdoll to start from. */
export function ragPose(p: Person, out: Float32Array): void {
  out.set((p as Body).cur);
}

/** The ragdoll lets go: blend from its limbs into the 'down' pose, already landed, facing `face`. */
export function ragDetach(p: Person, face: number, ch: Float32Array): void {
  const b = p as Body;
  if (!b.rag) return;
  b.rag = null; b.ragCh = null;
  b.downFace = face;
  b.from.set(ch);
  b.blend = 0; b.blendDur = 0.35;
  b.shown = 'down'; b.poseT = 10;
  b.dustOwed = true;
}

function target(b: Body, o: Float32Array): void {
  switch (b.shown) {
    case 'stand': stand(b, o); break;
    case 'walk': gait(b, o, false); break;
    case 'run': gait(b, o, !b.wading); break;
    case 'jump': jump(b, o); break;
    case 'fall': fall(b, o); break;
    case 'swim': swim(b, o); break;
    case 'down': down(b, o); break;
    case 'sit': sit(b, o); break;
  }
}

// ── Geometry and material ────────────────────────────────────────────────────

/**
 * The one shape everybody is made of: a unit box with its edges cut back. The
 * faces keep flat normals and the cut strips blend between them, so a box
 * reads as a moulded toy block with soft edges instead of a hard cube.
 */
function partGeometry(c: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  // Vertex (corner k, axis a): corner k's copy that lies on the face across axis a.
  for (let k = 0; k < 8; k++) {
    const s = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
    for (let a = 0; a < 3; a++) {
      const p = [s[0] * (0.5 - c), s[1] * (0.5 - c), s[2] * (0.5 - c)];
      p[a] = s[a] * 0.5;
      const n = [0, 0, 0];
      n[a] = s[a];
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      // Slightly darker toward the bottom of every part: a hint of grounding for free.
      const shade = 0.8 + 0.2 * (p[1] + 0.5);
      col.push(shade, shade, shade);
    }
  }
  const P = (i: number): THREE.Vector3 => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  // Wind every triangle outward by checking it against the direction from the centre.
  const tri = (i: number, j: number, k: number): void => {
    const a = P(i), b = P(j), d = P(k);
    const n = b.clone().sub(a).cross(d.clone().sub(a));
    if (n.dot(a.clone().add(b).add(d)) < 0) idx.push(i, k, j); else idx.push(i, j, k);
  };
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, d = (a + 2) % 3;
    for (let sa = 0; sa < 2; sa++) {
      // The face across axis a on side sa.
      const k0 = sa << a;
      const q = [k0, k0 | (1 << b), k0 | (1 << b) | (1 << d), k0 | (1 << d)].map((k) => k * 3 + a);
      tri(q[0], q[1], q[2]); tri(q[0], q[2], q[3]);
    }
    for (let sb = 0; sb < 2; sb++) for (let sd = 0; sd < 2; sd++) {
      // The edge running along axis a: a strip between the two faces it joins.
      const k0 = (sb << b) | (sd << d), k1 = k0 | (1 << a);
      tri(k0 * 3 + b, k1 * 3 + b, k1 * 3 + d); tri(k0 * 3 + b, k1 * 3 + d, k0 * 3 + d);
    }
  }
  for (let k = 0; k < 8; k++) tri(k * 3, k * 3 + 1, k * 3 + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Per-instance taper: the bottom end of a part is narrowed by aShape, the top left alone. */
function taper(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aShape;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xz *= mix(aShape, vec2(1.0), position.y + 0.5);');
}

// ── Wardrobe ─────────────────────────────────────────────────────────────────

const SKINS = [0xf3d3b8, 0xe8b990, 0xd9a273, 0xc08a5c, 0xa26b45, 0x7d4d30, 0x5c3822];
const HAIRS = [0x1d1a1a, 0x1d1a1a, 0x3a2a20, 0x3a2a20, 0x6a4a30, 0xa57a42, 0xd8b56e, 0x9c4326, 0x8e8d88, 0xe4dfd3];
const TOPS = [0xf2e8cf, 0x2a9d8f, 0xf0a202, 0xe4572e, 0x14213d, 0x8a9a6b, 0x9c4a3c, 0x7fb0bd, 0xc9774f, 0xf2e8cf];
const BOTTOMS = [0x3d5a80, 0x2b3c5a, 0x6f8fae, 0xb8a57a, 0x9a8c68, 0x2b2d33, 0x45474d];
const SHOES = [0x2b2d33, 0x2b2d33, 0x5a3a26, 0x7a5236, 0xf2e8cf, 0x14213d, 0xe4572e];
const HATS = [0x14213d, 0xe4572e, 0xf0a202, 0x2a9d8f, 0xf2e8cf, 0x8a9a6b, 0x9c4a3c];
const CUTS_F: HairCut[] = ['long', 'long', 'tail', 'tail', 'bun', 'part', 'curls', 'afro', 'crop'];
const CUTS_M: HairCut[] = ['crop', 'crop', 'crop', 'part', 'part', 'curls', 'afro', 'bald', 'bald'];
const TOPS_F: TopKind[] = ['tee', 'tee', 'shirt', 'hoodie', 'jacket', 'dress', 'dress'];
const TOPS_M: TopKind[] = ['tee', 'tee', 'shirt', 'shirt', 'hoodie', 'jacket', 'jacket'];
const IRIS = [0x3a2414, 0x3a2414, 0x4a2e18, 0x2a1a10, 0x5a6a48, 0x4a6a8a, 0x6a5a3a];
/** jaw, nose, brow, age: the faces the one head is pulled into. The last is Dess: nobody's twin, and tired. */
const FACES = [[0, 0, 0, 0], [0.8, 0.5, 0.7, 0], [-0.8, -0.6, -0.4, 0], [0.3, 0.9, 0.2, 1], [-0.4, 0.6, -0.7, 0.55], [0.9, -0.5, 0.3, 0.3], [-0.2, 0.2, 0.9, 0.8], [0.5, -0.8, -0.5, 0], [0.15, -0.15, 0.2, 0.4]];
const DESS_FACE = FACES.length - 1;

// ── The people ───────────────────────────────────────────────────────────────

export class People implements PeopleApi {
  private readonly bodies: Body[] = [];
  readonly list: readonly Person[] = this.bodies;

  private readonly mesh: THREE.InstancedMesh;
  private readonly shape: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  // Upload ranges are handed to three again every frame; keeping the objects avoids making new ones.
  private readonly rangeM = { start: 0, count: 0 };
  private readonly rangeC = { start: 0, count: 0 };
  private readonly rangeS = { start: 0, count: 0 };
  private readonly rng = new RNG(7719);
  private nextId = 1;
  private lastTop = -1;
  private lastBottom = -1;
  private lastHair = -1;

  // The skinned crowd. Empty until the models have loaded.
  private assets: PersonAsset[] = [];
  /** One mesh per body and level of detail: index = body * NLOD + lod. */
  private readonly skins: THREE.Mesh[] = [];
  private readonly rows: THREE.InstancedBufferAttribute[] = [];
  private readonly counts: number[] = [];
  /** Which row lists changed this frame: the others are not sent to the GPU again. */
  private readonly rowDirty: boolean[] = [];
  private readonly near = new Float64Array(NEAR);
  private readonly data = new Float32Array(TEX_W * MAX_PEOPLE * 4);
  private readonly tex = new THREE.DataTexture(this.data, TEX_W, MAX_PEOPLE, THREE.RGBAFormat, THREE.FloatType);

  /** Ragdolls (ent/ragdoll.ts), stepped at the top of update() so the bodies they move are drawn where they are. Set by Game. */
  rag!: Ragdolls;

  constructor(private readonly game: Game) {
    const max = MAX_PEOPLE * MAX_PARTS;
    const geo = partGeometry(0.16);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.shape.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aShape', this.shape);

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = taper;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = 'people';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.tint;
    // The shadow pass has to taper the boxes too, or limbs cast shadows fatter than they are.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = taper;
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Instances are scattered across the whole island, so one bounding sphere means
    // nothing. Who gets drawn is decided per person in update().
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    game.scene.add(this.mesh);

    // `?people=0` keeps the box people, for comparing the two.
    if (new URLSearchParams(location.search).get('people') !== '0') {
      assets.hold(loadPeople().then((a) => { if (a) this.adopt(a); }), 'people');
    }
  }

  private adopt(assets: PersonAsset[]): void {
    const low = this.game.quality.name === 'low';
    // The phone preset lights them per vertex; the rest get the city's own physically based shading.
    const make = (morph: boolean): THREE.Material => {
      const m = low
        ? new THREE.MeshLambertMaterial({ vertexColors: true })
        : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
      m.onBeforeCompile = skinned(this.tex, true, morph, !low);
      // Both closures print the same source, which is all three compares by default.
      m.customProgramCacheKey = () => `people${morph ? 1 : 0}${low ? 0 : 1}`;
      return m;
    };
    const mats = [make(false), make(true)];
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = skinned(this.tex, false, false, false);
    depth.customProgramCacheKey = () => 'people-depth';
    const names = ['position', 'normal', 'color', 'aSkin', 'aInfo'];
    for (const a of assets) {
      for (let lod = 0; lod < NLOD; lod++) {
        const src = a.lods[Math.min(lod, a.lods.length - 1)], g = new THREE.InstancedBufferGeometry();
        const morph = src.hasAttribute('aM0');
        g.setIndex(src.getIndex());
        for (const n of names) g.setAttribute(n, src.getAttribute(n));
        if (morph) for (let k = 0; k < MORPHS; k++) g.setAttribute(`aM${k}`, src.getAttribute(`aM${k}`));
        const row = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE), 1);
        row.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aRow', row); flip.geo(g, 'aRow');
        g.instanceCount = 0;
        const m = new THREE.Mesh(g, mats[morph ? 1 : 0]);
        m.name = `people_${a.kind}${lod}`;
        m.customDepthMaterial = depth;
        m.castShadow = true;
        m.receiveShadow = true;
        // Vertices are placed by the shader, anywhere on the island.
        m.frustumCulled = false;
        m.visible = false;
        this.game.scene.add(m);
        this.skins.push(m); this.rows.push(row); this.counts.push(0);
      }
    }
    this.assets = assets;
  }

  spawn(x: number, z: number, h: number, look?: Look): Person {
    const b = new Body(this.nextId++, look ?? this.randomLook());
    b.x = x; b.z = z; b.h = h;
    b.y = groundAt(x, z);
    this.bodies.push(b);
    return b;
  }

  /** Show p in its pose at once, with no blend from the last one (somebody put straight into a car seat: ent/occupants.ts). */
  settle(p: Person): void {
    const b = p as Body;
    b.shown = b.pose; b.blend = 1; b.poseT = 10;
  }

  remove(p: Person): void {
    if (this.rag) this.rag.drop(p);
    const i = this.bodies.indexOf(p as Body);
    if (i < 0) return;
    const last = this.bodies.pop() as Body;
    if (i < this.bodies.length) this.bodies[i] = last;
  }

  /** fixed: the look depends on `rng` alone, so every browser makes the same person from the same seed (src/net/). */
  randomLook(rng: RNG = this.rng, fixed = false): Look {
    // Re-roll the things you notice first until they differ from the last person made.
    let top = rng.int(0, TOPS.length - 1);
    while (!fixed && TOPS[top] === TOPS[this.lastTop]) top = rng.int(0, TOPS.length - 1);
    let bottom = rng.int(0, BOTTOMS.length - 1);
    while (!fixed && bottom === this.lastBottom) bottom = rng.int(0, BOTTOMS.length - 1);
    let hair = rng.int(0, HAIRS.length - 1);
    while (!fixed && HAIRS[hair] === HAIRS[this.lastHair]) hair = rng.int(0, HAIRS.length - 1);
    if (!fixed) { this.lastTop = top; this.lastBottom = bottom; this.lastHair = hair; }

    const body: BodyKind = rng.chance(0.5) ? 'f' : 'm';
    const f = body === 'f';
    const cut = rng.pick(f ? CUTS_F : CUTS_M);
    let hat: number | null = null;
    if (rng.chance(cut === 'afro' || cut === 'bun' ? 0.08 : 0.3)) {
      hat = rng.pick(HATS);
      // A cap the colour of the shirt under it reads as a uniform.
      while (hat === TOPS[top]) hat = rng.pick(HATS);
    }
    const topKind = rng.pick(f ? TOPS_F : TOPS_M);
    const hatKind: HatKind = rng.chance(0.55) ? 'cap' : rng.chance(0.55) ? 'beanie' : 'brim';
    const look: StyledLook = {
      skin: rng.pick(SKINS),
      hair: HAIRS[hair],
      top: TOPS[top],
      bottom: BOTTOMS[bottom],
      shoes: rng.pick(SHOES),
      hat,
      // Two rolls averaged: most people are near the middle, a few are tall or small.
      height: (f ? 0.9 : 0.95) + 0.14 * (rng.next() + rng.next()) / 2,
      build: 0.9 + 0.25 * (rng.next() + rng.next()) / 2,
      cut, body, topKind, hatKind,
      bottomKind: rng.chance(0.2) ? 'shorts' : f && rng.chance(0.2) ? 'skirt' : rng.chance(0.5) ? 'jeans' : 'trousers',
      shoeKind: rng.chance(0.68) ? 'sneakers' : 'boots',
      beard: !f && rng.chance(0.38) ? (rng.chance(0.5) ? true : 'stubble') : false,
      capBack: rng.chance(0.15),
      glasses: rng.chance(0.16),
      bag: rng.chance(0.16),
      face: rng.int(0, FACES.length - 2),
    };
    if (fixed) look.seed = rng.int(0, 9972);
    return look;
  }

  update(dt: number): void {
    if (this.rag) this.rag.update(dt);
    const g = this.game, cam = g.camera;
    // A pinned screenshot view only reaches the camera at render time, after this
    // runs, so read it directly or the first frame of every pinned shot is culled
    // against wherever the camera used to be.
    const eye = g.view ? g.view.pos : cam.position;
    if (g.view) FWD.subVectors(g.view.target, g.view.pos).normalize();
    else FWD.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const far = Math.min(DRAW_DIST, g.quality.drawDist * 0.3);
    const far2 = far * far, detail2 = DETAIL_DIST * DETAIL_DIST;

    FILL.value = 1.0 * g.sky.night;
    OUT_M = this.mesh.instanceMatrix.array as Float32Array;
    OUT_C = this.tint.array as Float32Array;
    OUT_S = this.shape.array as Float32Array;
    OUT_N = 0;
    const room = MAX_PEOPLE * MAX_PARTS - MAX_PARTS;

    const skinned = this.assets.length > 0;
    const low = g.quality.name === 'low';
    const lod2 = (low ? LOD_DIST_LOW : LOD_DIST) ** 2, lod3 = (low ? LOD2_DIST_LOW : LOD2_DIST) ** 2;
    let row = 0;
    for (let i = 0; i < this.counts.length; i++) this.counts[i] = 0;
    // The full model carries every garment and haircut, so its vertex cost is several people's. Only the
    // nearest few get it; in a packed crowd the rest are the middle model, which at that range looks the same.
    const near = this.near, nNear = low ? NEAR_LOW : NEAR;
    near.fill(Infinity);
    if (skinned) {
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        // (Somebody seen through a car's glass is never one of the few given the full model: ent/occupants.ts.)
        if (!b.visible || b.occupant) continue;
        const dx = b.x - eye.x, dy = b.y - eye.y, dz = b.z - eye.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= lod2 || d2 >= near[nNear - 1] || dx * FWD.x + dy * FWD.y + dz * FWD.z < -1) continue;
        let j = nNear - 1;
        while (j > 0 && near[j - 1] > d2) { near[j] = near[j - 1]; j--; }
        near[j] = d2;
      }
    }
    const nearCut = near[nNear - 1];

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const dx = b.x - eye.x, dy = b.y - eye.y, dz = b.z - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // Behind the camera still counts for 25 m: their shadows fall into view, and the
      // camera read here is a frame old.
      const seen = b.visible && d2 < far2 && dx * FWD.x + dy * FWD.y + dz * FWD.z > -25 && OUT_N <= room && row < MAX_PEOPLE;
      if (!seen) {
        // Whatever happened off screen has finished happening by the time they are seen again.
        if (b.shown !== b.pose) { b.shown = b.pose; b.blend = 1; b.poseT = 10; }
        continue;
      }
      this.animate(b, dt);
      if (skinned) {
        this.palette(b);
        const m = b.kind * NLOD + (d2 > lod3 ? 2 : d2 > lod2 || d2 > nearCut || b.occupant ? 1 : 0);
        const ra = this.rows[m].array as Float32Array, ri = this.counts[m]++;
        if (ra[ri] !== row) { ra[ri] = row; this.rowDirty[m] = true; }
        this.skin(b, row++, this.assets[b.kind].joints);
      } else {
        this.draw(b, d2 > detail2);
      }
    }

    for (let i = 0; i < this.skins.length; i++) {
      const n = this.counts[i], r = this.rows[i];
      (this.skins[i].geometry as THREE.InstancedBufferGeometry).instanceCount = n;
      this.skins[i].visible = n > 0;
      if (n > 0 && this.rowDirty[i]) sendRange(r, n);
      this.rowDirty[i] = false;
    }
    if (row > 0) this.tex.needsUpdate = true;

    const n = OUT_N;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this.rangeM.count = n * 16; this.rangeC.count = n * 3; this.rangeS.count = n * 2;
    const im = this.mesh.instanceMatrix;
    im.updateRanges.length = 0; im.updateRanges.push(this.rangeM); im.needsUpdate = true;
    this.tint.updateRanges.length = 0; this.tint.updateRanges.push(this.rangeC); this.tint.needsUpdate = true;
    this.shape.updateRanges.length = 0; this.shape.updateRanges.push(this.rangeS); this.shape.needsUpdate = true;
  }

  private animate(b: Body, dt: number): void {
    if (b.pose !== b.shown) {
      b.from.set(b.cur);
      b.blend = 0;
      b.blendDur = blendTime(b.shown, b.pose);
      if (b.pose === 'down') b.falls++;
      // Up from a ragdoll's landing: a stagger and a dusting-off, once.
      if (b.shown === 'down' && b.dustOwed && (b.pose === 'stand' || b.pose === 'walk' || b.pose === 'run')) { b.dustT = 1.8; b.dustOwed = false; }
      if (b.shown === 'down' && b.pose !== 'down') b.downFace = 0;
      if (b.pose === 'jump') b.lead = b.phase > 0.25 && b.phase < 0.75 ? 0 : 1;
      b.shown = b.pose;
      b.poseT = 0;
    }
    b.t += dt;
    b.poseT += dt;
    // A short person's legs are short too: the same ground speed is a quicker gait, or the feet slide by the difference.
    const hk = b.look.height || 1;
    b.gaitSpeed = damp(b.gaitSpeed, b.speed / hk, 12, dt);
    // The two bands overlap so a seabed hovering at the line does not flicker between gaits.
    const wading = b.y < waterLevelAt(b.x, b.z) - WADE_DEPTH - (b.wading ? -0.08 : 0.08);
    if (wading !== b.wading) {
      b.wading = wading;
      if (b.shown === 'run') { b.from.set(b.cur); b.blend = 0; b.blendDur = 0.25; }
    }
    if (b.shown === 'walk' || b.shown === 'run') {
      // Wading keeps its cadence from the real speed, so the short wading stride just slips a little in the water.
      b.phase += (b.speed / hk * dt) / strideLen(b.gaitSpeed, b.shown === 'run' && !b.wading) * (b.wading ? 0.7 : 1);
      b.phase -= Math.floor(b.phase);
    } else if (b.shown === 'swim') {
      // A slow tick even when still, so treading water keeps moving.
      b.stroke += dt * (0.3 + b.speed / 3);
      b.stroke -= Math.floor(b.stroke);
    }

    target(b, TGT);
    const cur = b.cur;
    if (b.blend < 1) {
      b.blend = Math.min(1, b.blend + dt / b.blendDur);
      const w = smooth(b.blend), from = b.from;
      for (let i = 0; i < NCH; i++) cur[i] = from[i] + (TGT[i] - from[i]) * w;
    } else {
      cur.set(TGT);
    }
    if (b.aim > 0.004 && b.shown !== 'down' && b.shown !== 'swim') aimOver(b, cur);
    if (b.ragCh) cur.set(b.ragCh);
    else if (b.dustT > 0) dustOff(b, cur, dt);

    // The face is this person's own; the eyes blink and wander; the hands close on whatever the body is doing.
    const m = b.mor, F = FACES[b.face] ?? FACES[0];
    for (let i = 0; i < 4; i++) m[i] = F[i] + 0.3 * (hash2((b.look as StyledLook).seed ?? b.seed, 40 + i) - 0.5);
    const bt = (b.t * 0.29 + b.seed * 0.137) % 1;
    const lying = b.shown === 'down';
    m[4] = b.ragCh ? 0 : lying ? 0.9 : bt < 0.04 ? Math.sin(Math.PI * bt / 0.04) : 0.12 * F[3];
    const still = b.shown === 'stand' || b.shown === 'sit' ? 1 : 0.35;
    m[5] = damp(m[5], still * 0.9 * (drift(b.t * 0.37, b.seed + 21) * 2 - 1), 14, dt);
    m[6] = damp(m[6], still * 0.5 * (drift(b.t * 0.31, b.seed + 22) * 2 - 1), 14, dt);
    const aim = lying || b.shown === 'swim' ? 0 : smooth(b.aim);
    const wheel = b.shown === 'sit' && !b.bench ? 1 : 0;
    const fist = b.shown === 'run' && !b.wading ? 0.75 : b.shown === 'jump' || b.shown === 'fall' ? 0 : b.shown === 'walk' ? 0.15 : 0.05;
    const r = 1 - Math.exp(-10 * dt);
    m[8] += (fist * (1 - wheel) * (b.aimTwo ? 1 - aim : 1) - m[8]) * r; m[9] += (Math.max(wheel, b.aimTwo ? aim * 0.8 : 0) - m[9]) * r; m[10] = 0;
    m[12] += (fist * (1 - wheel) * (1 - aim) - m[12]) * r; m[13] += (wheel * (1 - aim) - m[13]) * r; m[14] += (aim - m[14]) * r;
  }

  private colors(b: Body): void {
    const L = b.look;
    const key = L.skin + L.hair * 3 + L.top * 7 + L.bottom * 13 + L.shoes * 31 + (L.hat ?? -1) * 61;
    if (key === b.lookKey) return;
    b.lookKey = key;
    const hex = [L.skin, L.hair, L.top, L.bottom, L.shoes, L.hat ?? L.hair, EYE];
    for (let i = 0; i < 7; i++) {
      COLOR.setHex(hex[i]);
      b.rgb[i * 3] = COLOR.r; b.rgb[i * 3 + 1] = COLOR.g; b.rgb[i * 3 + 2] = COLOR.b;
    }
  }

  /** Colour and visibility of every part of a skinned body, and which body it is. Redone only when the look is replaced. */
  private palette(b: Body): void {
    if (b.palFor === b.look) return;
    b.palFor = b.look;
    const L = b.look as StyledLook, pal = b.pal;
    // A plain Look: one colour head to foot is the coveralls (Dess); otherwise a uniform.
    const plain = L.cut === undefined && L.topKind === undefined;
    const onePiece = plain && L.top === L.bottom;
    let cut: HairCut = L.cut ?? (onePiece ? 'tail' : 'crop');
    if (cut === 'bob') cut = 'long';
    const body: BodyKind = L.body ?? (plain ? (onePiece ? 'f' : 'm') : cut === 'long' || cut === 'tail' || cut === 'bun' ? 'f' : 'm');
    b.kind = Math.max(0, this.assets.findIndex((a) => a.kind === body));
    const top: TopKind = L.topKind ?? (onePiece ? 'coverall' : 'shirt');
    const bottom: BottomKind = top === 'coverall' ? 'trousers' : L.bottomKind ?? 'trousers';
    const shoes = L.shoeKind ?? 'boots';
    const hat = L.hat !== null, hk: HatKind = L.hatKind ?? 'cap';
    const bare = bottom === 'shorts' || bottom === 'skirt' || top === 'dress';
    // Under a hat the big cuts are tucked in: the close crop shows at the sides instead.
    const shown = hat && (cut === 'part' || cut === 'curls' || cut === 'afro' || cut === 'bun') ? 'crop' : cut;
    b.face = L.face ?? (onePiece ? DESS_FACE : b.seed % (FACES.length - 1));
    for (let i = 0; i < PARTS.length; i++) {
      const p = PARTS[i];
      let hex = L.skin, on = true, k = 1;
      switch (p) {
        case 'head': case 'body': break;
        case 'arm': on = top === 'tee' || top === 'dress'; break;
        case 'leg': on = bare; break;
        case 'eyewhite': hex = 0xd9d4c8; break;
        case 'iris': hex = IRIS[(L.seed ?? b.seed) % IRIS.length]; break;
        case 'brow': hex = L.hair; k = 0.6; break;
        // Under an open jacket: a pale tee, or a dark one if the jacket is pale.
        case 'tee': on = top === 'tee' || top === 'jacket'; hex = top === 'tee' ? L.top : (L.top >> 16) > 0xb0 ? 0x2b2d33 : 0xe6e0d0; break;
        case 'shirt': case 'hoodie': case 'jacket': case 'coverall': case 'dress': hex = L.top; on = top === p; break;
        case 'trousers': case 'jeans': case 'shorts': case 'skirt': hex = L.bottom; on = bottom === p && top !== 'dress'; break;
        case 'sneakers': case 'boots': hex = L.shoes; on = shoes === p; break;
        case 'hair_crop': hex = L.hair; on = shown === 'crop'; break;
        case 'hair_part': hex = L.hair; on = shown === 'part'; break;
        case 'hair_long': hex = L.hair; on = shown === 'long'; break;
        case 'hair_tail': hex = L.hair; on = shown === 'tail'; break;
        case 'hair_bun': hex = L.hair; on = shown === 'bun'; break;
        case 'hair_curls': hex = L.hair; on = shown === 'curls'; break;
        case 'hair_afro': hex = L.hair; on = shown === 'afro'; break;
        case 'hair_bald': hex = L.hair; on = shown === 'bald'; break;
        case 'beard': hex = L.hair; on = L.beard === true; break;
        case 'stubble': hex = L.hair; on = L.beard === 'stubble'; break;
        case 'cap': hex = L.hat ?? 0; on = hat && hk === 'cap'; break;
        case 'peak_f': hex = L.hat ?? 0; on = hat && hk === 'cap' && !L.capBack; break;
        case 'peak_b': hex = L.hat ?? 0; on = hat && hk === 'cap' && L.capBack === true; break;
        case 'beanie': hex = L.hat ?? 0; on = hat && hk === 'beanie'; break;
        case 'brimhat': hex = L.hat ?? 0; on = hat && hk === 'brim'; break;
        case 'glasses': hex = 0x17171c; on = L.glasses === true; break;
        case 'bag': hex = [0x5a3a26, 0x2b2d33, 0x8a6a3a, 0x3d5a80][(L.seed ?? b.seed) % 4]; on = L.bag === true; break;
        // The belt is cut to go outside the coveralls; every other top hangs over where one would be.
        case 'belt': hex = 0x2a1c12; on = top === 'coverall'; break;
      }
      COLOR.setHex(hex);
      pal[i * 4] = COLOR.r * k; pal[i * 4 + 1] = COLOR.g * k; pal[i * 4 + 2] = COLOR.b * k;
      if (p === 'stubble') {
        // Stubble is skin with the hair's colour coming through it.
        pal[i * 4] = lerp(pal[0], pal[i * 4], 0.45); pal[i * 4 + 1] = lerp(pal[1], pal[i * 4 + 1], 0.45); pal[i * 4 + 2] = lerp(pal[2], pal[i * 4 + 2], 0.45);
      }
      pal[i * 4 + 3] = on ? 1 : 0;
    }
  }

  /**
   * One person's row of the crowd texture: the same chain of frames draw() hangs
   * its boxes on, now one per bone of the file's skeleton, with the spine's and
   * neck's turns shared between two joints each and the collar bones lifting
   * when an arm goes up.
   */
  private skin(b: Body, row: number, J: Float32Array): void {
    const c = b.cur, D = this.data, o = row * TEX_W * 4;
    const L = b.look, k = L.height, W = L.build;
    // Build widens the trunk most, its depth less, the limbs least: a broad person is not a stretched one.
    const wide = 1 + (W - 1) * 0.8, deep = 1 + (W - 1) * 0.6, limb = 1 + (W - 1) * 0.45;
    D.set(b.pal, o + PAL0 * 4);
    D.set(b.mor, o + MOR0 * 4);

    const P = M_PELVIS;
    const sh = Math.sin(b.h) * k, ch = Math.cos(b.h) * k;
    P[0] = ch; P[1] = 0; P[2] = -sh; P[3] = 0;
    P[4] = 0; P[5] = k; P[6] = 0; P[7] = 0;
    P[8] = sh; P[9] = 0; P[10] = ch; P[11] = 0;
    P[12] = b.x; P[13] = lerp(b.y, waterLevelAt(b.x, b.z), c[WATER]); P[14] = b.z; P[15] = 1;
    rotX(P, c[TIP]);
    move(P, c[RX], HIP + c[RY], c[RZ]);
    rotY(P, c[YAW]);
    rotX(P, c[PITCH]);
    rotZ(P, c[ROLL]);
    if (b.rag) P.set(b.rag);
    put(D, o, J, B_HIPS, P, wide, deep);

    const F = M_LIMB;
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, j = i * 4, t = B_LEG[i];
      F.set(P);
      hop(F, J, B_HIPS, t, wide);
      rotZ(F, s * c[LAB + j]);
      rotX(F, -c[LSW + j]);
      put(D, o, J, t, F, limb, limb);
      hop(F, J, t, t + 1, 1);
      rotX(F, c[LKN + j]);
      put(D, o, J, t + 1, F, limb, limb);
      hop(F, J, t + 1, t + 2, 1);
      rotX(F, c[LFT + j]);
      put(D, o, J, t + 2, F, 1, 1);
    }

    const T = M_TORSO;
    T.set(P);
    hop(T, J, B_HIPS, B_SPINE, 1);
    rotY(T, c[TWIST] * 0.4);
    rotX(T, c[LEAN] * 0.5);
    rotZ(T, c[SROLL] * 0.5);
    put(D, o, J, B_SPINE, T, wide, deep);
    hop(T, J, B_SPINE, B_CHEST, 1);
    rotY(T, c[TWIST] * 0.6);
    rotX(T, c[LEAN] * 0.5);
    rotZ(T, c[SROLL] * 0.5);
    put(D, o, J, B_CHEST, T, wide, deep * (1 + 0.03 * c[BREATH]));

    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, j = i * 3, a = B_ARM[i];
      F.set(T);
      hop(F, J, B_CHEST, a, wide);
      // The collar bone follows an arm raised past the horizontal.
      rotZ(F, s * clamp((Math.max(Math.abs(c[ASW + j]), c[AAB + j]) - 0.9) * 0.3, 0, 0.35));
      put(D, o, J, a, F, 1, 1);
      hop(F, J, a, a + 1, wide);
      // Abduct first, then swing: an arm raised overhead stays out to its own side.
      rotX(F, -c[ASW + j]);
      rotZ(F, s * c[AAB + j]);
      put(D, o, J, a + 1, F, limb, limb);
      hop(F, J, a + 1, a + 2, 1);
      rotX(F, -c[AEL + j]);
      put(D, o, J, a + 2, F, limb, limb);
      hop(F, J, a + 2, a + 3, 1);
      // A hand hangs a little curled in toward the leg, not in line with the forearm.
      rotZ(F, -s * 0.12);
      put(D, o, J, a + 3, F, 1, 1);
    }

    hop(T, J, B_CHEST, B_NECK, 1);
    rotY(T, c[HYAW] * 0.35);
    rotX(T, c[HPITCH] * 0.4);
    rotZ(T, c[HROLL] * 0.4);
    put(D, o, J, B_NECK, T, 1, 1);
    hop(T, J, B_NECK, B_HEAD, 1);
    rotY(T, c[HYAW] * 0.65);
    rotX(T, c[HPITCH] * 0.6);
    rotZ(T, c[HROLL] * 0.6);
    put(D, o, J, B_HEAD, T, 1, 1);
  }

  private draw(b: Body, far: boolean): void {
    this.colors(b);
    const c = b.cur, rgb = b.rgb;
    const L = b.look as StyledLook;
    const k = L.height, W = L.build;
    const cut: HairCut = L.cut ?? 'tail';
    const sleeve = L.topKind === 'tee' ? C_SKIN : C_TOP;
    const shin = L.bottomKind === 'shorts' || L.bottomKind === 'skirt' ? C_SKIN : C_BOTTOM;

    // Root: feet spot, heading, height. Then out to the pelvis.
    const P = M_PELVIS;
    const sh = Math.sin(b.h) * k, ch = Math.cos(b.h) * k;
    P[0] = ch; P[1] = 0; P[2] = -sh; P[3] = 0;
    P[4] = 0; P[5] = k; P[6] = 0; P[7] = 0;
    P[8] = sh; P[9] = 0; P[10] = ch; P[11] = 0;
    P[12] = b.x; P[13] = lerp(b.y, waterLevelAt(b.x, b.z), c[WATER]); P[14] = b.z; P[15] = 1;
    rotX(P, c[TIP]);
    move(P, c[RX], HIP + c[RY], c[RZ]);
    rotY(P, c[YAW]);
    rotX(P, c[PITCH]);
    rotZ(P, c[ROLL]);
    if (b.rag) P.set(b.rag);
    part(P, 0, 0.04, 0, 0.335 * W, 0.2, 0.2, rgb, C_BOTTOM, 0.9, 0.95);

    const F = M_LIMB;
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, j = i * 4;
      F.set(P);
      move(F, s * HIP_X * W, 0, 0);
      rotZ(F, s * c[LAB + j]);
      rotX(F, -c[LSW + j]);
      part(F, 0, -THIGH / 2 + 0.01, 0, 0.158 * (0.6 + 0.4 * W), THIGH + 0.08, 0.175, rgb, C_BOTTOM, 0.8, 0.8);
      move(F, 0, -THIGH, 0);
      rotX(F, c[LKN + j]);
      part(F, 0, -SHIN / 2 + 0.005, 0, 0.126, SHIN + 0.07, 0.138, rgb, shin, 0.78, 0.78);
      move(F, 0, -SHIN, 0);
      rotX(F, c[LFT + j]);
      part(F, 0, -ANKLE / 2 + 0.008, 0.06, 0.118, 0.1, 0.27, rgb, C_SHOES, 1.06, 1.04);
    }

    const T = M_TORSO;
    T.set(P);
    move(T, 0, SPINE, 0);
    rotY(T, c[TWIST]);
    rotX(T, c[LEAN]);
    rotZ(T, c[SROLL]);
    part(T, 0, 0.22, 0, 0.4 * W, 0.5, 0.215 * (1 + 0.035 * c[BREATH]), rgb, C_TOP, 0.8, 0.9);

    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, j = i * 3;
      F.set(T);
      move(F, s * (0.2 * W + 0.04), SHOULDER, 0);
      // Abduct first, then swing: an arm raised overhead stays out to its own side.
      rotX(F, -c[ASW + j]);
      rotZ(F, s * c[AAB + j]);
      part(F, 0, -UPPER / 2 + 0.015, 0, 0.108, UPPER + 0.08, 0.118, rgb, C_TOP, 0.85, 0.85);
      move(F, 0, -UPPER, 0);
      rotX(F, -c[AEL + j]);
      if (far) {
        part(F, 0, -FORE / 2 - 0.04, 0, 0.094, FORE + 0.13, 0.104, rgb, sleeve, 0.8, 0.8);
      } else {
        part(F, 0, -FORE / 2, 0, 0.094, FORE + 0.06, 0.104, rgb, sleeve, 0.82, 0.82);
        part(F, 0, -FORE - 0.045, 0.004, 0.08, 0.11, 0.1, rgb, C_SKIN, 0.82, 0.8);
      }
    }

    // Head. T becomes the head frame; the neck is hung first while it is still the torso's.
    if (!far) part(T, 0, NECK + 0.02, 0, 0.1, 0.1, 0.105, rgb, C_SKIN, 1, 1);
    move(T, 0, NECK, 0);
    rotY(T, c[HYAW]);
    rotX(T, c[HPITCH]);
    rotZ(T, c[HROLL]);
    part(T, 0, 0.16, 0.01, 0.215, 0.26, 0.225, rgb, C_SKIN, 0.86, 0.9);
    if (!far) {
      part(T, 0.05, 0.168, 0.124, 0.03, 0.046, 0.012, rgb, C_EYE, 1, 1);
      part(T, -0.05, 0.168, 0.124, 0.03, 0.046, 0.012, rgb, C_EYE, 1, 1);
      if (L.beard) part(T, 0, 0.072, 0.075, 0.205, 0.115, 0.115, rgb, C_HAIR, 0.82, 0.85);
    }
    if (L.hat !== null) {
      part(T, 0, 0.278, 0.005, 0.212, 0.105, 0.222, rgb, C_HAT, 1.13, 1.13);
      if (!far) part(T, 0, 0.238, L.capBack ? -0.165 : 0.175, 0.2, 0.024, 0.14, rgb, C_HAT, 1, 1);
    } else if (cut !== 'bald') {
      part(T, 0, 0.262, 0.004, 0.236, 0.09, 0.246, rgb, C_HAIR, 1, 1);
    }
    if (cut === 'bob') part(T, 0, 0.125, -0.055, 0.25, 0.26, 0.15, rgb, C_HAIR, 1.04, 1);
    else if (cut === 'bald') part(T, 0, 0.135, -0.06, 0.232, 0.085, 0.13, rgb, C_HAIR, 1, 1);
    else part(T, 0, 0.175, -0.072, 0.236, 0.13, 0.1, rgb, C_HAIR, 0.95, 1);
    if (!far) {
      if (cut === 'tail') part(T, 0, 0.14, -0.155, 0.075, 0.19, 0.075, rgb, C_HAIR, 0.55, 0.55);
      else if (cut === 'bun' && L.hat === null) part(T, 0, 0.275, -0.11, 0.1, 0.1, 0.1, rgb, C_HAIR, 0.9, 0.9);
    }
  }
}
