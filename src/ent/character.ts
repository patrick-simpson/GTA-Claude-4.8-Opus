// The people, as bodies and animation. This file only draws: whoever controls a
// person (the player code, later the pedestrian AI) writes x, y, z, h, pose and
// speed, and everything seen on screen is worked out here from those.
//
// Everyone in the city is one InstancedMesh: a single soft-edged box drawn up
// to 23 times per person, each with its own matrix, colour and taper. That is
// one draw call for the crowd (two with the shadow pass) however many there are.
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
import { WATER_Y, groundAt } from '../world/plan';

export type HairCut = 'crop' | 'bob' | 'tail' | 'bun' | 'bald';

/**
 * A Look with the optional details randomLook() adds. A plain Look works
 * everywhere; it gets the defaults (pony tail, rolled sleeves, long trousers).
 */
export interface StyledLook extends Look {
  cut?: HairCut;
  beard?: boolean;
  /** Forearms bare. Default true. */
  shortSleeves?: boolean;
  /** Shins bare. Default false. */
  shorts?: boolean;
  /** Cap worn brim-backwards. */
  capBack?: boolean;
}

const MAX_PEOPLE = 160;
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

// Colour slots in Body.rgb.
const C_SKIN = 0, C_HAIR = 3, C_TOP = 6, C_BOTTOM = 9, C_SHOES = 12, C_HAT = 15, C_EYE = 18;
const EYE = 0x1a1d29;

class Body implements Person {
  x = 0; y = 0; z = 0; h = 0;
  pose: Pose = 'stand';
  speed = 0;
  visible = true;
  health = 100;

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
  const front = hash2(b.seed, b.falls) < 0.3;
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

function sit(b: Body, o: Float32Array): void {
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
const CUTS: HairCut[] = ['crop', 'crop', 'crop', 'crop', 'bob', 'bob', 'tail', 'tail', 'bun', 'bald'];

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
  }

  spawn(x: number, z: number, h: number, look?: Look): Person {
    const b = new Body(this.nextId++, look ?? this.randomLook());
    b.x = x; b.z = z; b.h = h;
    b.y = groundAt(x, z);
    this.bodies.push(b);
    return b;
  }

  remove(p: Person): void {
    const i = this.bodies.indexOf(p as Body);
    if (i < 0) return;
    const last = this.bodies.pop() as Body;
    if (i < this.bodies.length) this.bodies[i] = last;
  }

  randomLook(rng: RNG = this.rng): Look {
    // Re-roll the things you notice first until they differ from the last person made.
    let top = rng.int(0, TOPS.length - 1);
    while (TOPS[top] === TOPS[this.lastTop]) top = rng.int(0, TOPS.length - 1);
    let bottom = rng.int(0, BOTTOMS.length - 1);
    while (bottom === this.lastBottom) bottom = rng.int(0, BOTTOMS.length - 1);
    let hair = rng.int(0, HAIRS.length - 1);
    while (HAIRS[hair] === HAIRS[this.lastHair]) hair = rng.int(0, HAIRS.length - 1);
    this.lastTop = top; this.lastBottom = bottom; this.lastHair = hair;

    const cut = rng.pick(CUTS);
    let hat: number | null = null;
    if (rng.chance(0.34)) {
      hat = rng.pick(HATS);
      // A cap the colour of the shirt under it reads as a uniform.
      while (hat === TOPS[top]) hat = rng.pick(HATS);
    }
    const look: StyledLook = {
      skin: rng.pick(SKINS),
      hair: HAIRS[hair],
      top: TOPS[top],
      bottom: BOTTOMS[bottom],
      shoes: rng.pick(SHOES),
      hat,
      // Two rolls averaged: most people are near the middle, a few are tall or small.
      height: 0.92 + 0.16 * (rng.next() + rng.next()) / 2,
      build: 0.9 + 0.25 * (rng.next() + rng.next()) / 2,
      cut,
      beard: (cut === 'crop' || cut === 'bald') && rng.chance(0.3),
      shortSleeves: rng.chance(0.55),
      shorts: rng.chance(0.22),
      capBack: hat !== null && rng.chance(0.15),
    };
    return look;
  }

  update(dt: number): void {
    const g = this.game, cam = g.camera;
    // A pinned screenshot view only reaches the camera at render time, after this
    // runs, so read it directly or the first frame of every pinned shot is culled
    // against wherever the camera used to be.
    const eye = g.view ? g.view.pos : cam.position;
    if (g.view) FWD.subVectors(g.view.target, g.view.pos).normalize();
    else FWD.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const far = Math.min(DRAW_DIST, g.quality.drawDist * 0.3);
    const far2 = far * far, detail2 = DETAIL_DIST * DETAIL_DIST;

    OUT_M = this.mesh.instanceMatrix.array as Float32Array;
    OUT_C = this.tint.array as Float32Array;
    OUT_S = this.shape.array as Float32Array;
    OUT_N = 0;
    const room = MAX_PEOPLE * MAX_PARTS - MAX_PARTS;

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const dx = b.x - eye.x, dy = b.y - eye.y, dz = b.z - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // Behind the camera still counts for 25 m: their shadows fall into view, and the
      // camera read here is a frame old.
      const seen = b.visible && d2 < far2 && dx * FWD.x + dy * FWD.y + dz * FWD.z > -25 && OUT_N <= room;
      if (!seen) {
        // Whatever happened off screen has finished happening by the time they are seen again.
        if (b.shown !== b.pose) { b.shown = b.pose; b.blend = 1; b.poseT = 10; }
        continue;
      }
      this.animate(b, dt);
      this.draw(b, d2 > detail2);
    }

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
      if (b.pose === 'jump') b.lead = b.phase > 0.25 && b.phase < 0.75 ? 0 : 1;
      b.shown = b.pose;
      b.poseT = 0;
    }
    b.t += dt;
    b.poseT += dt;
    b.gaitSpeed = damp(b.gaitSpeed, b.speed, 12, dt);
    // The two bands overlap so a seabed hovering at the line does not flicker between gaits.
    const wading = b.y < WATER_Y - WADE_DEPTH - (b.wading ? -0.08 : 0.08);
    if (wading !== b.wading) {
      b.wading = wading;
      if (b.shown === 'run') { b.from.set(b.cur); b.blend = 0; b.blendDur = 0.25; }
    }
    if (b.shown === 'walk' || b.shown === 'run') {
      // Wading keeps its cadence from the real speed, so the short wading stride just slips a little in the water.
      b.phase += (b.speed * dt) / strideLen(b.gaitSpeed, b.shown === 'run' && !b.wading) * (b.wading ? 0.7 : 1);
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

  private draw(b: Body, far: boolean): void {
    this.colors(b);
    const c = b.cur, rgb = b.rgb;
    const L = b.look as StyledLook;
    const k = L.height, W = L.build;
    const cut: HairCut = L.cut ?? 'tail';
    const sleeve = L.shortSleeves === false ? C_TOP : C_SKIN;
    const shin = L.shorts ? C_SKIN : C_BOTTOM;

    // Root: feet spot, heading, height. Then out to the pelvis.
    const P = M_PELVIS;
    const sh = Math.sin(b.h) * k, ch = Math.cos(b.h) * k;
    P[0] = ch; P[1] = 0; P[2] = -sh; P[3] = 0;
    P[4] = 0; P[5] = k; P[6] = 0; P[7] = 0;
    P[8] = sh; P[9] = 0; P[10] = ch; P[11] = 0;
    P[12] = b.x; P[13] = lerp(b.y, WATER_Y, c[WATER]); P[14] = b.z; P[15] = 1;
    rotX(P, c[TIP]);
    move(P, c[RX], HIP + c[RY], c[RZ]);
    rotY(P, c[YAW]);
    rotX(P, c[PITCH]);
    rotZ(P, c[ROLL]);
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
