// Progressive, location-based car damage (Nov 23).
//
// Every car carries a CarDamage once it is first hit (null until then, so a clean car costs nothing). A hit adds
// crumple to the zone it struck (front, rear, left, right) by the closing speed: light dings first, then dents, then
// crumpled panels. On the way the zone's lamps break, its glass cracks and then shatters, its bumper sags and then
// falls off into the road, the bonnet buckles up, a tyre can blow; scraping along a wall wears the paint to bare metal.
//
// How it is drawn: per car instance, two vec4 attributes on the body, trim and glass meshes (aDmg: the four zone
// amounts; aDmh: half length, half width, the packed glass/lamp/bumper bits and the scrapes). The shared car
// materials gain a vertex displacement field (push-in toward the middle with a crumple ripple along the normal, the
// bonnet's ridge, the bumper's sag) and a fragment step (faceted normals where the panel is crushed, cavity shading
// and bare-metal scratches from the damage sheet, cracked and shattered glass, dark lamp lenses). The sheet,
// public/models/car_damage.webp, is baked in Blender by tools/blender/damage.py: R dent relief, G scrapes, B glass
// cracks, A shatter cells. The far level and phones get no displacement (aDmh stays zero there): only a darker,
// dirtier paint, the engine smoke and the fire.
//
// Multiplayer: pack() and unpack() write eight bytes; src/net carries them as a tail on the player's state frame.

import * as THREE from 'three';
import { flip } from '../core/flip';

export const FRONT = 0, REAR = 1, LEFT = 2, RIGHT = 3;
/** Glass panes, two bits each in CarDamage.glass: 0 whole, 1 cracked, 2 shattered. */
export const PANE_FRONT = 0, PANE_REAR = 1, PANE_LEFT = 2, PANE_RIGHT = 3;
/** Bits of CarDamage.lamps. */
export const HEAD_L = 1, HEAD_R = 2, TAIL_L = 4, TAIL_R = 8;
/** Bytes pack() writes. */
export const DAMAGE_BYTES = 8;
/** aDmh.w carries this plus the scrapes, so a stale generic attribute (a mesh without the buffer) never reads as damage. */
const TAG = 4096;

export class CarDamage {
  /** Crumple per zone, 0 (straight) to 1 (folded up). */
  readonly z = new Float32Array(4);
  glass = 0;
  lamps = 0;
  /** Bits: front left, front right, rear left, rear right. */
  tyres = 0;
  /** 0 on, 1 hanging, 2 gone. */
  bumpF = 0;
  bumpR = 0;
  /** Bare metal along each flank, 0 to 1. */
  scrL = 0;
  scrR = 0;

  /** Packed for the shader: glass, lamps, bumpers. */
  bits(): number { return this.glass + this.lamps * 256 + this.bumpF * 4096 + this.bumpR * 16384; }
  pane(i: number): number { return (this.glass >> (i * 2)) & 3; }
  setPane(i: number, s: number): boolean {
    if (this.pane(i) >= s) return false;
    this.glass = (this.glass & ~(3 << (i * 2))) | (s << (i * 2));
    return true;
  }
  /** How badly the car is hurt, for its handling: 0 to 1. */
  severity(): number {
    const z = this.z;
    return Math.min(1, (z[FRONT] * 1.2 + z[REAR] * 0.6 + z[LEFT] * 0.45 + z[RIGHT] * 0.45) / 1.6);
  }
  /** Mean crumple, for the far level's darkening. */
  wear(): number { const z = this.z; return (z[0] + z[1] + z[2] + z[3]) * 0.25; }
  /** Engine power left. */
  power(): number { return 1 - 0.25 * this.severity(); }
  /** Tyre grip left. */
  grip(): number {
    let blown = 0;
    for (let i = 0; i < 4; i++) if (this.tyres & (1 << i)) blown++;
    return 1 - 0.12 * this.severity() - 0.12 * blown;
  }
  /** Which way a flat pulls: + toward the car's left. */
  pull(): number {
    const t = this.tyres;
    return ((t & 1) ? 1 : 0) - ((t & 2) ? 1 : 0) + 0.5 * (((t & 4) ? 1 : 0) - ((t & 8) ? 1 : 0));
  }
  clean(): boolean {
    const z = this.z;
    return z[0] + z[1] + z[2] + z[3] === 0 && !this.glass && !this.lamps && !this.tyres && !this.bumpF && !this.bumpR && this.scrL + this.scrR === 0;
  }
}

/** A car's damage, or null when it is clean (any Vehicle: the field lives on ent/vehicle.ts's Car). */
export function damageOf(v: object): CarDamage | null {
  return (v as { dmg?: CarDamage | null }).dmg ?? null;
}
/** Panels, glass, lamps, bumpers and tyres made good (the repair shop). */
export function repairDamage(v: object): void {
  if ('dmg' in v) (v as { dmg: CarDamage | null }).dmg = null;
}

/** What one hit broke, for the caller to throw about (glass bits, a bumper in the road). */
export interface DentResult {
  /** Panes, lamps and bumpers that broke: local points (x left, z forward) and what. */
  glass: number[];
  lamps: number[];
  /** 1 front bumper dropped, 2 rear, 3 both. */
  dropped: number;
  tyre: boolean;
}
const _res: DentResult = { glass: [], lamps: [], dropped: 0, tyre: false };

/**
 * A hit on `d` at local point (lx left, lz forward) of a car with half length hl and half width hw, at `speed` m/s
 * closing. Returns what broke (the same object each time).
 */
export function dent(d: CarDamage, lx: number, lz: number, hl: number, hw: number, speed: number, rand: () => number): DentResult {
  const r = _res;
  r.glass.length = 0; r.lamps.length = 0; r.dropped = 0; r.tyre = false;
  // A tap at walking pace is a ding; thirty mph folds the panel; sixty takes most of the zone at once.
  const amt = Math.min(0.7, Math.max(0.02, (speed - 2.5) / 26));
  const u = Math.max(-1, Math.min(1, lz / hl)), s = Math.max(-1, Math.min(1, lx / hw));
  const endOn = Math.abs(u) > Math.abs(s) * 0.85;
  const main = endOn ? (u > 0 ? FRONT : REAR) : (s > 0 ? LEFT : RIGHT);
  add(d, main, amt);
  // Corners fold both ways.
  if (endOn && Math.abs(s) > 0.6) add(d, s > 0 ? LEFT : RIGHT, amt * 0.35);
  if (!endOn && Math.abs(u) > 0.6) add(d, u > 0 ? FRONT : REAR, amt * 0.35);
  const z = d.z;
  for (const end of [FRONT, REAR]) {
    const c = z[end], f = end === FRONT;
    const left = f ? HEAD_L : TAIL_L, right = f ? HEAD_R : TAIL_R;
    const near = main === end || (main === (s > 0 ? LEFT : RIGHT) && (f ? u > 0.6 : u < -0.6));
    if (c > 0.18 && near) {
      const want = (s > 0.2 || c > 0.42 ? left : 0) | (s < -0.2 || c > 0.42 ? right : 0) | (Math.abs(s) <= 0.2 && c > 0.3 ? left | right : 0);
      for (const b of [left, right]) if (want & b && !(d.lamps & b)) { d.lamps |= b; r.lamps.push(b === left ? 0.7 : -0.7, f ? 0.95 : -0.95); }
    }
    const bump = f ? d.bumpF : d.bumpR;
    let nb = bump;
    if (c > 0.6 || (c > 0.42 && amt > 0.4)) nb = 2; else if (c > 0.28) nb = Math.max(nb, 1);
    if (nb !== bump) {
      if (f) d.bumpF = nb; else d.bumpR = nb;
      if (nb === 2) r.dropped |= f ? 1 : 2;
    }
    const pane = f ? PANE_FRONT : PANE_REAR;
    if (c > 0.85 ? d.setPane(pane, 2) : c > 0.4 ? d.setPane(pane, 1) : false) r.glass.push(0, f ? 0.35 : -0.5);
  }
  for (const side of [LEFT, RIGHT]) {
    const c = z[side], pane = side === LEFT ? PANE_LEFT : PANE_RIGHT;
    // Side windows are toughened: they craze, then go all at once.
    if (c > 0.5 || (c > 0.3 && amt > 0.3) ? d.setPane(pane, 2) : c > 0.26 ? d.setPane(pane, 1) : false) r.glass.push(side === LEFT ? 0.9 : -0.9, 0);
  }
  // A hard knock at a wheel can burst its tyre.
  if (amt > 0.22 && Math.abs(u) > 0.4 && rand() < (endOn ? 0.15 : 0.45)) {
    const bit = (u > 0 ? 0 : 2) + (s > 0 ? 0 : 1);
    if (!(d.tyres & (1 << bit))) { d.tyres |= 1 << bit; r.tyre = true; }
  }
  return r;
}

function add(d: CarDamage, zone: number, a: number): void {
  // A panel already folded gives less: the next hit meets the frame.
  d.z[zone] = Math.min(1, d.z[zone] + a * (1 - 0.35 * d.z[zone]));
}

/** Rubbing along a wall: paint wears off that flank. */
export function scrape(d: CarDamage, left: boolean, amount: number): void {
  if (left) d.scrL = Math.min(1, d.scrL + amount); else d.scrR = Math.min(1, d.scrR + amount);
}

/** The per-instance numbers: aDmg (zones) then aDmh (half length, half width, bits, tag + scrapes). Zero for a clean car. */
export function shaderValues(d: CarDamage | null, hl: number, hw: number, out: Float32Array, o: number): void {
  if (!d) { out.fill(0, o, o + 8); return; }
  out[o] = d.z[0]; out[o + 1] = d.z[1]; out[o + 2] = d.z[2]; out[o + 3] = d.z[3];
  out[o + 4] = hl; out[o + 5] = hw; out[o + 6] = d.bits();
  out[o + 7] = TAG + Math.round(d.scrL * 15) * 16 + Math.round(d.scrR * 15);
}

// ── The wire ─────────────────────────────────────────────────────────────────

/** Eight bytes: the four zones, the glass, lamps | tyres << 4, front | rear bumper << 2, scrapes (left low nibble). */
export function pack(d: CarDamage | null, out: DataView, o: number): void {
  if (!d) { for (let i = 0; i < DAMAGE_BYTES; i++) out.setUint8(o + i, 0); return; }
  for (let i = 0; i < 4; i++) out.setUint8(o + i, Math.round(d.z[i] * 255));
  out.setUint8(o + 4, d.glass & 255);
  out.setUint8(o + 5, (d.lamps & 15) | ((d.tyres & 15) << 4));
  out.setUint8(o + 6, (d.bumpF & 3) | ((d.bumpR & 3) << 2));
  out.setUint8(o + 7, Math.round(d.scrL * 15) | (Math.round(d.scrR * 15) << 4));
}

/** Read pack()'s bytes into `d`. Returns which bumpers newly came off (1 front, 2 rear), for the debris. */
export function unpack(d: CarDamage, v: DataView, o: number): number {
  for (let i = 0; i < 4; i++) d.z[i] = v.getUint8(o + i) / 255;
  d.glass = v.getUint8(o + 4);
  const lt = v.getUint8(o + 5), b = v.getUint8(o + 6), sc = v.getUint8(o + 7);
  d.lamps = lt & 15; d.tyres = lt >> 4;
  const f = b & 3, r = (b >> 2) & 3;
  const dropped = (f === 2 && d.bumpF !== 2 ? 1 : 0) | (r === 2 && d.bumpR !== 2 ? 2 : 0);
  d.bumpF = f; d.bumpR = r;
  d.scrL = (sc & 15) / 15; d.scrR = (sc >> 4) / 15;
  return dropped;
}

// ── The shaders ──────────────────────────────────────────────────────────────

let sheet: THREE.Texture | null = null;
/** The Blender sheet, shared by every car material. Until it arrives a flat grey stands in (no relief, no cracks). */
function damageSheet(): THREE.Texture {
  if (sheet) return sheet;
  const blank = new THREE.DataTexture(new Uint8Array([128, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  sheet = blank;
  const tex = new THREE.TextureLoader().load('models/car_damage.webp', () => { sheet = tex; for (const u of users) u.value = tex; });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return blank;
}
const users: { value: THREE.Texture }[] = [];

const NOISE = /* glsl */ `
float dmgH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dmgN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dmgH(i), dmgH(i + vec3(1, 0, 0)), f.x), mix(dmgH(i + vec3(0, 1, 0)), dmgH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(dmgH(i + vec3(0, 0, 1)), dmgH(i + vec3(1, 0, 1)), f.x), mix(dmgH(i + vec3(0, 1, 1)), dmgH(i + vec3(1, 1, 1)), f.x), f.y), f.z) * 2.0 - 1.0;
}`;

// Local frame: +z forward, +x the car's left, y up from the road.
const VERT = /* glsl */ `
vDmgP = vec4(position, 0.0); vDmgS = vec4(0.0); vDmgN = objectNormal;
if (aDmh.w > 4000.0 && aDmh.w < 5000.0) {
  float hl = aDmh.x, hw = aDmh.y, bits = aDmh.z, scr = aDmh.w - 4096.0;
  vec3 p = position;
  float u = clamp(p.z / hl, -1.2, 1.2), s = clamp(p.x / hw, -1.2, 1.2);
  float wf = smoothstep(0.3, 1.0, u), wr = smoothstep(0.3, 1.0, -u);
  float mid = 1.0 - smoothstep(0.6, 1.0, abs(u));
  float wl = smoothstep(0.25, 1.0, s) * mid, wrs = smoothstep(0.25, 1.0, -s) * mid;
  float cf = aDmg.x * wf, cb = aDmg.y * wr, cl = aDmg.z * wl, cr = aDmg.w * wrs;
  float crush = cf + cb + cl + cr;
  vec3 d = vec3(0.0);
  float n1 = 0.0;
  if (crush > 0.001) {
    n1 = dmgN(p * 4.0);
    float n2 = dmgN(p * 11.0 + 3.7);
    d.z -= aDmg.x * wf * wf * 0.42;
    d.z += aDmg.y * wr * wr * 0.36;
    d.x -= cl * 0.17 * (0.75 + 0.25 * n1);
    d.x += cr * 0.17 * (0.75 + 0.25 * n1);
    d += objectNormal * (n1 * 0.65 + n2 * 0.35) * crush * 0.075;
    d.y += (cf + cb) * n1 * 0.035;
  }
#ifndef DMG_GLASS
  float bon = smoothstep(0.3, 0.7, aDmg.x);
  if (bon > 0.0 && objectNormal.y > 0.5 && u > 0.25 && u < 0.93) {
    float t = (u - 0.25) / 0.68;
    d.y += bon * sin(t * 3.14159) * 0.13 * (1.0 - 0.5 * abs(s)) * (0.85 + 0.15 * n1);
    crush += bon * 0.5 * sin(t * 3.14159);
  }
  float bz = smoothstep(0.84, 0.93, abs(u)) * (1.0 - smoothstep(0.62, 0.8, p.y));
  float bst = u > 0.0 ? mod(floor(bits / 4096.0), 4.0) : floor(bits / 16384.0);
  if (bz > 0.0 && bst > 0.5) {
    if (bst < 1.5) { d.y -= bz * (0.04 + 0.14 * (0.5 + 0.5 * s)); d.z += sign(u) * bz * 0.07; }
    else { d.z = mix(d.z, sign(u) * 0.84 * hl - p.z + d.z * 0.5, bz); d.x -= p.x * 0.06 * bz; }
  }
#endif
  transformed += d;
  vDmgP.w = clamp(crush * 1.5, 0.0, 1.0);
  vDmgS = vec4(floor(scr / 16.0) / 15.0, mod(scr, 16.0) / 15.0, mod(bits, 256.0), 0.0);
#ifdef DMG_DETAIL
  float lb = mod(floor(bits / 256.0), 16.0);
  float bit = (u > 0.0 ? 0.0 : 2.0) + (s > 0.0 ? 0.0 : 1.0);
  if (aPbr.z > 0.5 && aPbr.z < 6.5 && mod(floor(lb / exp2(bit)), 2.0) > 0.5) { vPbr.z = 0.0; vDmgS.w = 1.0; }
#endif
}
`;

const FRAG_COLOR = /* glsl */ `
float dMetal = 0.0;
if (vDmgP.w > 0.001 || vDmgS.x + vDmgS.y + vDmgS.z + vDmgS.w > 0.0) {
#ifdef DMG_GLASS
  float gb = vDmgS.z;
  if (gb > 0.5) {
    float pane = abs(vDmgN.z) > abs(vDmgN.x) ? (vDmgN.z > 0.0 ? 0.0 : 1.0) : (vDmgN.x > 0.0 ? 2.0 : 3.0);
    float st = mod(floor(gb / exp2(pane * 2.0)), 4.0);
    if (st > 0.5) {
      vec2 gp = pane < 1.5 ? vDmgP.xy : vDmgP.zy;
      vec4 cr = texture2D(tDmg, (gp - vec2(0.15, 1.15)) * 0.55 + vec2(pane * 0.29, 0.0));
      if (st > 1.5 && pane > 0.5 && cr.a > 0.14) discard;
      float line = st > 1.5 ? max(cr.b, 0.6) : cr.b;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.82, 0.84), line * 0.85);
      diffuseColor.a = max(diffuseColor.a, line);
      dMetal = -line;
    }
  }
#else
  vec3 an = abs(vDmgN);
  vec2 uvD = (an.x > 0.6 ? vDmgP.zy : an.y > 0.6 ? vDmgP.xz : vDmgP.xy) * 0.6;
  if (vDmgP.w > 0.001) {
    float hD = texture2D(tDmg, uvD).r;
    diffuseColor.rgb *= 1.0 - vDmgP.w * (0.12 + 0.32 * (1.0 - hD));
  }
  float dScr = vDmgN.x > 0.0 ? vDmgS.x : vDmgS.y;
  if (dScr > 0.0) {
    // A band at bumper and door-handle height, streaky, and patchier along the car than across it.
    float side = smoothstep(0.45, 0.75, an.x) * smoothstep(0.3, 0.42, vDmgP.y) * (1.0 - smoothstep(0.78, 0.95, vDmgP.y));
    float sg = texture2D(tDmg, vec2(vDmgP.z * 0.3, vDmgP.y * 0.8)).g;
    float patchy = texture2D(tDmg, vec2(vDmgP.z * 0.11 + 0.5, 0.3)).r;
    dMetal = smoothstep(0.6 - dScr * 0.5, 0.8 - dScr * 0.5, sg) * side * smoothstep(0.15, 0.45, patchy + dScr * 0.45);
    // Bare steel, with the primer showing grey round the bright gouges.
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.42, 0.43, 0.44), vec3(0.72, 0.73, 0.75), smoothstep(0.5, 0.9, sg)), dMetal);
  }
#ifdef DMG_DETAIL
  if (vDmgS.w > 0.5) diffuseColor.rgb = diffuseColor.rgb * 0.15 + vec3(0.015);
#endif
#endif
}
`;

const FRAG_NORMAL = /* glsl */ `
if (vDmgP.w > 0.01) {
  vec3 dfn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  normal = normalize(mix(normal, dfn, min(vDmgP.w * 1.1, 0.75)));
}
`;

const FRAG_LIGHT = /* glsl */ `
#ifndef DMG_GLASS
  roughnessFactor = mix(roughnessFactor, 0.42, dMetal);
  metalnessFactor = mix(metalnessFactor, 1.0, dMetal);
#else
  roughnessFactor = mix(roughnessFactor, 0.6, -dMetal);
#endif
`;

const FRAG_COAT = /* glsl */ `
#ifdef USE_CLEARCOAT
  material.clearcoat *= 1.0 - max(dMetal, 0.0);
  if (vDmgP.w > 0.01) clearcoatNormal = normal;
#endif
`;

/**
 * Give one of the shared car materials the damage: `part` says which (the body and its trim are displaced alike;
 * the trim also darkens broken lamps; glass cracks and shatters). Chains onto what the material already does.
 */
export function damageShader(mat: THREE.Material, part: 'paint' | 'detail' | 'glass'): void {
  // world/snowCover.ts hangs its own step on every material's getter: reading onBeforeCompile returns the material's
  // hook with the snow already chained on, and the setter chains it on again. Chain onto the material's own hook only.
  type Hook = (sh: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void;
  const own = (mat as unknown as { _obc?: Hook })._obc ?? mat.onBeforeCompile;
  const prev: Hook = (sh, r) => own.call(mat, sh, r);
  const key = mat.customProgramCacheKey.bind(mat);
  const uni = { value: damageSheet() };
  users.push(uni);
  const def = part === 'glass' ? '#define DMG_GLASS\n' : part === 'detail' ? '#define DMG_DETAIL\n' : '';
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.tDmg = uni;
    sh.vertexShader = def + 'attribute vec4 aDmg;\nattribute vec4 aDmh;\nvarying vec4 vDmgP;\nvarying vec4 vDmgS;\nvarying vec3 vDmgN;\n' + NOISE + '\n'
      + sh.vertexShader.replace('#include <project_vertex>', VERT + '#include <project_vertex>');
    sh.fragmentShader = def + 'uniform sampler2D tDmg;\nvarying vec4 vDmgP;\nvarying vec4 vDmgS;\nvarying vec3 vDmgN;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <clearcoat_normal_fragment_begin>', FRAG_NORMAL + '#include <clearcoat_normal_fragment_begin>')
      .replace('#include <lights_physical_fragment>', FRAG_LIGHT + '#include <lights_physical_fragment>\n' + FRAG_COAT);
  };
  mat.customProgramCacheKey = () => key() + '-dmg';
  mat.needsUpdate = true;
}

// ── Bumpers in the road ──────────────────────────────────────────────────────

interface Piece { x: number; y: number; z: number; vx: number; vy: number; vz: number; h: number; spin: number; tilt: number; w: number; t: number; rest: boolean }
const MAX_PIECES = 16, PIECE_LIFE = 150;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Bumpers that came off: they fall, skid and lie in the road a couple of minutes. One instanced draw. */
export class LooseParts {
  readonly mesh: THREE.InstancedMesh;
  private pieces: Piece[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, shadows: boolean) {
    // A bar the width of a car, curved round its ends, with a darker lower lip.
    const g = new THREE.BoxGeometry(1, 0.26, 0.16, 8, 2, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i); pos.setZ(i, pos.getZ(i) - x * x * 0.35); }
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 });
    this.mesh = new THREE.InstancedMesh(g, mat, MAX_PIECES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows; this.mesh.receiveShadow = shadows;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.setHex(0xffffff));
    const mesh = this.mesh;
    flip.add(mesh.instanceMatrix, (x) => { mesh.instanceMatrix = x as THREE.InstancedBufferAttribute; });
    flip.add(mesh.instanceColor!, (x) => { mesh.instanceColor = x as THREE.InstancedBufferAttribute; });
    scene.add(this.mesh);
  }

  /** A bumper off a car at (x, y, z) heading h: `front` says which end, w the car's width. */
  drop(x: number, y: number, z: number, h: number, front: boolean, hl: number, w: number, vx: number, vz: number, color: number, rand: () => number): void {
    const s = Math.sin(h), c = Math.cos(h), k = (front ? 1 : -1) * (hl - 0.1);
    const i = this.pieces.length < MAX_PIECES ? this.pieces.length : (this.next++ % MAX_PIECES);
    this.pieces[i] = {
      x: x + s * k, y: y + 0.45, z: z + c * k, vx: vx * 0.6 + (rand() - 0.5) * 2, vy: 1.5 + rand() * 1.5, vz: vz * 0.6 + (rand() - 0.5) * 2,
      h: h + (front ? 0 : Math.PI), spin: (rand() - 0.5) * 6, tilt: 0, w: w * 0.95, t: 0, rest: false,
    };
    this.mesh.setColorAt(i, _c.setHex(color));
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = this.pieces.length;
  }

  update(dt: number, ground: (x: number, z: number) => number): void {
    let moved = false;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.t += dt;
      if (p.t > PIECE_LIFE) { p.y -= dt * 0.3; p.rest = false; moved = true; }
      if (p.rest) continue;
      moved = true;
      const g = ground(p.x, p.z);
      if (p.t <= PIECE_LIFE) {
        p.vy -= 9.8 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.h += p.spin * dt;
        p.tilt = Math.min(1.35, p.tilt + dt * 2.5);
        if (p.y < g + 0.08) {
          p.y = g + 0.08;
          p.vy = Math.abs(p.vy) > 2 ? -p.vy * 0.25 : 0;
          const f = Math.exp(-6 * dt);
          p.vx *= f; p.vz *= f; p.spin *= f;
          if (p.vx * p.vx + p.vz * p.vz < 0.01 && p.vy === 0) { p.rest = true; p.tilt = 1.45; }
        }
      }
      _e.set(-p.tilt, p.h, 0);
      _q.setFromEuler(_e);
      _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.w, 1, 1));
      this.mesh.setMatrixAt(i, _m);
    }
    if (moved) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void { this.pieces.length = 0; this.mesh.count = 0; }
}
