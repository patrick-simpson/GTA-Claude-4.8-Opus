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
// Item 44 (parts): a hard enough hit also tears loose a door (side hit), the bonnet (head-on) or, very hard at a corner,
// a wheel. Each is a flag in the same eight bytes (byte 6's four spare bits), so the frame and the protocol are as they were.
// The shader paints the hole it leaves (a dark patch, the side glass gone); LooseParts below swings the part on its hinge
// for a moment and then lets it fall as debris.
//
// Multiplayer: pack() and unpack() write eight bytes; src/net carries them as a tail on the player's state frame.

import * as THREE from 'three';
import { flip } from '../core/flip';
import { loadKtx } from '../core/ktx';

export const FRONT = 0, REAR = 1, LEFT = 2, RIGHT = 3;
/** Glass panes, two bits each in CarDamage.glass: 0 whole, 1 cracked, 2 shattered. */
export const PANE_FRONT = 0, PANE_REAR = 1, PANE_LEFT = 2, PANE_RIGHT = 3;
/** Bits of CarDamage.lamps. */
export const HEAD_L = 1, HEAD_R = 2, TAIL_L = 4, TAIL_R = 8;
/** What a kind of vehicle can lose (dent()'s `caps`): doors, bonnet, wheels. Cars only; bus, tow truck, cycles and the rest keep what they had. */
export const CAP_DOORS = 1, CAP_HOOD = 2, CAP_WHEEL = 4;
const PART_CAPS: Record<string, number> = {
  sedan: 7, hatch: 7, coupe: 7, muscle: 7, sports: 7, pickup: 7, taxi: 7, cruiser: 7, bolt: 7, cmax: 7,
  van: CAP_WHEEL | CAP_HOOD,
};
export function partCaps(kind: string): number { return PART_CAPS[kind] ?? 0; }
/** Bits in dent()'s `dropped` (1, 2 the bumpers): doors, bonnet, and 32 << wheel (front left, front right, rear left, rear right). */
export const DROP_DOOR_L = 4, DROP_DOOR_R = 8, DROP_HOOD = 16, DROP_WHEEL = 32;
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
  /** Item 44: 1 once gone. Left is +x, the driver's side. */
  doorL = 0;
  doorR = 0;
  hood = 0;
  /** The one wheel that has come off, as a bit of `tyres` (1 front left, 2 front right, 4 rear left, 8 rear right), or 0. Its tyre bit is set too, alone. */
  wheelOff = 0;
  /** Bare metal along each flank, 0 to 1. */
  scrL = 0;
  scrR = 0;

  /** Packed for the shader: glass, lamps, bumpers. */
  bits(): number { return this.glass + this.lamps * 256 + this.bumpF * 4096 + this.bumpR * 16384 + (this.doorL | (this.doorR << 1) | (this.hood << 2)) * 65536; }
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
  power(): number { return 1 - 0.25 * this.severity() - (this.wheelOff ? 0.15 : 0); }
  /** Tyre grip left. */
  grip(): number {
    let blown = 0;
    for (let i = 0; i < 4; i++) if (this.tyres & (1 << i)) blown++;
    return 1 - 0.12 * this.severity() - 0.12 * blown - (this.wheelOff ? 0.12 : 0);
  }
  /** Which way a flat pulls: + toward the car's left. */
  pull(): number {
    const t = this.tyres;
    return (((t & 1) ? 1 : 0) - ((t & 2) ? 1 : 0) + 0.5 * (((t & 4) ? 1 : 0) - ((t & 8) ? 1 : 0))) * (this.wheelOff ? 2 : 1);
  }
  clean(): boolean {
    const z = this.z;
    return z[0] + z[1] + z[2] + z[3] === 0 && !this.glass && !this.lamps && !this.tyres && !this.bumpF && !this.bumpR && !this.doorL && !this.doorR && !this.hood && !this.wheelOff && this.scrL + this.scrR === 0;
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
  /** What came off: 1 front bumper, 2 rear, DROP_DOOR_L, DROP_DOOR_R, DROP_HOOD, DROP_WHEEL << wheel (any mix). */
  dropped: number;
  tyre: boolean;
}
const _res: DentResult = { glass: [], lamps: [], dropped: 0, tyre: false };

/**
 * A hit on `d` at local point (lx left, lz forward) of a car with half length hl and half width hw, at `speed` m/s
 * closing. Returns what broke (the same object each time).
 */
export function dent(d: CarDamage, lx: number, lz: number, hl: number, hw: number, speed: number, rand: () => number, caps = 0): DentResult {
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
  // Parts (item 44). A side hit that has folded the door takes it off; a head-on that has folded the nose takes the bonnet.
  if (caps & CAP_DOORS) {
    if (main === LEFT && !d.doorL && amt >= 0.26 && z[LEFT] >= 0.35) { d.doorL = 1; r.dropped |= DROP_DOOR_L; }
    if (main === RIGHT && !d.doorR && amt >= 0.26 && z[RIGHT] >= 0.35) { d.doorR = 1; r.dropped |= DROP_DOOR_R; }
  }
  if (caps & CAP_HOOD && main === FRONT && !d.hood && amt >= 0.3 && z[FRONT] >= 0.55) { d.hood = 1; r.dropped |= DROP_HOOD; }
  // A very hard knock at a corner takes the wheel itself (one at a time); the tyre bit stays on, alone, so the wire needs no more.
  const corner = (u > 0 ? 0 : 2) + (s > 0 ? 0 : 1);
  if (caps & CAP_WHEEL && !d.wheelOff && amt >= 0.5 && Math.abs(u) > 0.45 && Math.abs(s) > 0.45 && rand() < 0.6) {
    d.wheelOff = 1 << corner; d.tyres = d.wheelOff; r.dropped |= DROP_WHEEL << corner;
  } else if (!d.wheelOff && amt > 0.22 && Math.abs(u) > 0.4 && rand() < (endOn ? 0.15 : 0.45)) {
    // A hard knock at a wheel can burst its tyre.
    const bit = corner;
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

/** Eight bytes: the four zones, the glass, lamps | tyres << 4, front | rear bumper << 2 | door L, door R, hood, wheel-off flag << 4, scrapes (left low nibble). */
export function pack(d: CarDamage | null, out: DataView, o: number): void {
  if (!d) { for (let i = 0; i < DAMAGE_BYTES; i++) out.setUint8(o + i, 0); return; }
  for (let i = 0; i < 4; i++) out.setUint8(o + i, Math.round(d.z[i] * 255));
  out.setUint8(o + 4, d.glass & 255);
  out.setUint8(o + 5, (d.lamps & 15) | (((d.wheelOff || d.tyres) & 15) << 4));
  out.setUint8(o + 6, (d.bumpF & 3) | ((d.bumpR & 3) << 2) | (d.doorL << 4) | (d.doorR << 5) | (d.hood << 6) | (d.wheelOff ? 128 : 0));
  out.setUint8(o + 7, Math.round(d.scrL * 15) | (Math.round(d.scrR * 15) << 4));
}

/** Read pack()'s bytes into `d`. Returns what newly came off (dent()'s `dropped` bits: bumpers, doors, bonnet, wheel), for the debris. */
export function unpack(d: CarDamage, v: DataView, o: number): number {
  for (let i = 0; i < 4; i++) d.z[i] = v.getUint8(o + i) / 255;
  d.glass = v.getUint8(o + 4);
  const lt = v.getUint8(o + 5), b = v.getUint8(o + 6), sc = v.getUint8(o + 7);
  d.lamps = lt & 15; d.tyres = lt >> 4;
  const f = b & 3, r = (b >> 2) & 3;
  let dropped = (f === 2 && d.bumpF !== 2 ? 1 : 0) | (r === 2 && d.bumpR !== 2 ? 2 : 0);
  d.bumpF = f; d.bumpR = r;
  const dl = (b >> 4) & 1, dr = (b >> 5) & 1, hd = (b >> 6) & 1, wo = b & 128 ? d.tyres & 15 : 0;
  if (dl && !d.doorL) dropped |= DROP_DOOR_L;
  if (dr && !d.doorR) dropped |= DROP_DOOR_R;
  if (hd && !d.hood) dropped |= DROP_HOOD;
  if (wo && wo !== d.wheelOff) dropped |= DROP_WHEEL * wo;
  d.doorL = dl; d.doorR = dr; d.hood = hd; d.wheelOff = wo;
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
  const use = (tex: THREE.Texture): void => { sheet = tex; for (const u of users) u.value = tex; };
  // The compressed copy when the build has one (src/core/ktx.ts), else the picture.
  void loadKtx('models/car_damage.webp', { srgb: false, flip: false }).then((k) => {
    if (k) { use(k); return; }
    const tex = new THREE.TextureLoader().load('models/car_damage.webp', () => use(tex));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
  });
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
vDmgP = vec4(position, 0.0); vDmgS = vec4(0.0); vDmgN = objectNormal; vDmgQ = vec2(0.0);
if (aDmh.w > 4000.0 && aDmh.w < 5000.0) {
  float hl = aDmh.x, hw = aDmh.y, bits = aDmh.z, scr = aDmh.w - 4096.0;
  vDmgQ = vec2(mod(floor(bits / 65536.0), 8.0), hl);
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
  float bst = u > 0.0 ? mod(floor(bits / 4096.0), 4.0) : mod(floor(bits / 16384.0), 4.0);
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
if (vDmgP.w > 0.001 || vDmgS.x + vDmgS.y + vDmgS.z + vDmgS.w + vDmgQ.x > 0.0) {
#ifdef DMG_GLASS
  // A door that has come off takes its side's glass with it.
  if (vDmgQ.x > 0.5 && abs(vDmgN.x) > 0.6 && ((mod(vDmgQ.x, 2.0) > 0.5 && vDmgP.x > 0.0) || (mod(floor(vDmgQ.x / 2.0), 2.0) > 0.5 && vDmgP.x < 0.0))) discard;
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
  // Parts that have come off (item 44): the hole they leave is the dark of the inside.
  if (vDmgQ.x > 0.5) {
    float uu = vDmgP.z / max(vDmgQ.y, 0.1), pq = vDmgQ.x;
    bool inDoor = an.x > 0.45 && uu > -0.22 && uu < 0.30 && vDmgP.y > 0.3 && vDmgP.y < 1.25;
    bool lostDoor = inDoor && ((mod(pq, 2.0) > 0.5 && vDmgP.x > 0.0) || (mod(floor(pq / 2.0), 2.0) > 0.5 && vDmgP.x < 0.0));
    bool lostHood = pq > 3.5 && vDmgN.y > 0.5 && uu > 0.26 && uu < 0.95 && vDmgP.y > 0.5;
    if (lostDoor || lostHood) { diffuseColor.rgb = vec3(0.022, 0.023, 0.027) * (0.7 + 0.6 * smoothstep(0.3, 1.2, vDmgP.y)); dMetal = 0.0; }
  }
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
    sh.vertexShader = def + 'attribute vec4 aDmg;\nattribute vec4 aDmh;\nvarying vec4 vDmgP;\nvarying vec4 vDmgS;\nvarying vec2 vDmgQ;\nvarying vec3 vDmgN;\n' + NOISE + '\n'
      + sh.vertexShader.replace('#include <project_vertex>', VERT + '#include <project_vertex>');
    sh.fragmentShader = def + 'uniform sampler2D tDmg;\nvarying vec4 vDmgP;\nvarying vec4 vDmgS;\nvarying vec2 vDmgQ;\nvarying vec3 vDmgN;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <clearcoat_normal_fragment_begin>', FRAG_NORMAL + '#include <clearcoat_normal_fragment_begin>')
      .replace('#include <lights_physical_fragment>', FRAG_LIGHT + '#include <lights_physical_fragment>\n' + FRAG_COAT);
  };
  mat.customProgramCacheKey = () => key() + '-dmg';
  mat.needsUpdate = true;
}

// ── Parts in the road ────────────────────────────────────────────────────────

/** What a part hangs on while it still hangs, and gets its first push from: a car's pose and speed. */
export interface Anchor { x: number; y: number; z: number; h: number; vx: number; vz: number }

const BUMPER = 0, DOOR = 1, HOOD = 2, WHEEL = 3;
interface Piece {
  i: number; live: boolean; rest: boolean; kind: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  h: number; spin: number; tilt: number; roll: number; tiltT: number; rollT: number; spinA: number;
  /** Extents in meters (a wheel: width, then its diameter twice). */
  sx: number; sy: number; sz: number;
  /** Seconds lived; seconds it is still held on its hinge, and how long it has been; and the hinge in the car's frame (+x left, +z forward). */
  t: number; hang: number; hangT: number; side: number; ax: number; ay: number; az: number; len: number;
  car: Anchor | null; kick: number;
}
/** Seconds a part lies in the road before it shrinks away, and how long the shrinking takes. */
const LIFE = 30, FADE = 2.5;
export const MAX_PARTS = 24;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _ew = new THREE.Euler(0, 0, 0, 'YZX');
const _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color();
const HALF_PI = Math.PI / 2;

/** One kind of part: an instanced mesh and its slots (all made up front, so nothing is allocated while playing). */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly pieces: Piece[] = [];
  private next = 0;
  alive = 0;
  /** (gx, gy, gz): the dimensions of the unit geometry, which the instance scale is taken from. */
  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, readonly cap: number, readonly gx: number, readonly gy: number, readonly gz: number, colored: boolean, shadows: boolean) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows; this.mesh.receiveShadow = shadows;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const mesh = this.mesh;
    if (colored) {
      mesh.setColorAt(0, _c.setHex(0xffffff));
      flip.add(mesh.instanceColor!, (x) => { mesh.instanceColor = x as THREE.InstancedBufferAttribute; });
    }
    flip.add(mesh.instanceMatrix, (x) => { mesh.instanceMatrix = x as THREE.InstancedBufferAttribute; });
    for (let i = 0; i < cap; i++) {
      this.pieces.push({
        i, live: false, rest: true, kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, h: 0, spin: 0, tilt: 0, roll: 0, tiltT: 0, rollT: 0, spinA: 0,
        sx: 1, sy: 1, sz: 1, t: 0, hang: 0, hangT: 0, side: 1, ax: 0, ay: 0, az: 0, len: 1, car: null, kick: 0,
      });
    }
    scene.add(mesh);
  }
  /** A free slot, or the oldest one's. */
  take(kind: number): Piece {
    let p: Piece | null = null;
    for (let i = 0; i < this.cap; i++) if (!this.pieces[i].live) { p = this.pieces[i]; break; }
    if (!p) { p = this.pieces[this.next++ % this.cap]; this.alive--; }
    this.alive++;
    p.live = true; p.rest = false; p.kind = kind; p.t = 0; p.hang = 0; p.hangT = 0; p.car = null; p.kick = 0;
    p.vx = p.vy = p.vz = 0; p.spin = 0; p.tilt = p.roll = p.tiltT = p.rollT = p.spinA = 0; p.side = 1;
    if (p.i >= this.mesh.count) this.mesh.count = p.i + 1;
    return p;
  }
  paint(p: Piece, color: number): void {
    this.mesh.setColorAt(p.i, _c.setHex(color));
    this.mesh.instanceColor!.needsUpdate = true;
  }
  write(p: Piece, f: number): void {
    if (p.kind === WHEEL) _q.setFromEuler(_ew.set(p.spinA, p.h, p.roll)); else _q.setFromEuler(_e.set(-p.tilt, p.h, p.roll));
    _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.sx / this.gx * f, p.sy / this.gy * f, p.sz / this.gz * f));
    this.mesh.setMatrixAt(p.i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  hide(p: Piece): void {
    _m.compose(_v.set(0, -200, 0), _q.identity(), _s.set(0.0001, 0.0001, 0.0001));
    this.mesh.setMatrixAt(p.i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Parts that came off a car (item 44): bumpers, doors, bonnets and wheels. A door or bonnet is held on its hinge a moment (it
 * swings open and flaps), then it and every bumper and wheel is thrown, bounces, slides and settles in the road, can be driven
 * through, and shrinks away after half a minute. At most MAX_PARTS at once (the oldest goes first); three instanced draws, and
 * nothing at all to do while none is out.
 */
export class LooseParts {
  private readonly bumpers: Pool;
  private readonly panels: Pool;
  private readonly wheels: Pool;
  private readonly pools: Pool[];

  constructor(scene: THREE.Scene, shadows: boolean) {
    // A bar the width of a car, curved round its ends, with a darker lower lip.
    const g = new THREE.BoxGeometry(1, 0.26, 0.16, 8, 2, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i); pos.setZ(i, pos.getZ(i) - x * x * 0.35); }
    g.computeVertexNormals();
    this.bumpers = new Pool(scene, g, new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 }), 8, 1, 0.26, 0.16, true, shadows);
    // A door or a bonnet: a plain slab in the car's own paint, sized per car.
    this.panels = new Pool(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.4 }), 12, 1, 1, 1, true, shadows);
    // A wheel: a dark tyre with a pale hub on each face, axle along x.
    const w = new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1);
    w.rotateZ(HALF_PI);
    const wp = w.getAttribute('position') as THREE.BufferAttribute, wn = w.getAttribute('normal') as THREE.BufferAttribute;
    const col = new Float32Array(wp.count * 3);
    for (let i = 0; i < wp.count; i++) {
      const hub = Math.abs(wn.getX(i)) > 0.9 && Math.hypot(wp.getY(i), wp.getZ(i)) < 0.33;
      const k = hub ? 0.62 : 0.07;
      col[i * 3] = col[i * 3 + 1] = k; col[i * 3 + 2] = k * 1.03;
    }
    w.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.wheels = new Pool(scene, w, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.2, roughness: 0.7 }), 4, 1, 1, 1, false, shadows);
    this.pools = [this.bumpers, this.panels, this.wheels];
  }

  /** How many parts are out (hanging or lying). */
  get alive(): number { return this.bumpers.alive + this.panels.alive + this.wheels.alive; }
  /** Every part out: kind (0 bumper, 1 door, 2 bonnet, 3 wheel), where, whether it still hangs on its car and whether it has settled. For tests. */
  list(): { kind: number; x: number; y: number; z: number; hang: boolean; rest: boolean; t: number }[] {
    const out: { kind: number; x: number; y: number; z: number; hang: boolean; rest: boolean; t: number }[] = [];
    for (const pl of this.pools) for (const p of pl.pieces) if (p.live) out.push({ kind: p.kind, x: p.x, y: p.y, z: p.z, hang: p.hang > 0, rest: p.rest, t: p.t });
    return out;
  }

  /** A bumper off a car at (x, y, z) heading h: `front` says which end, w the car's width. */
  drop(x: number, y: number, z: number, h: number, front: boolean, hl: number, w: number, vx: number, vz: number, color: number, rand: () => number): void {
    const s = Math.sin(h), c = Math.cos(h), k = (front ? 1 : -1) * (hl - 0.1);
    const p = this.bumpers.take(BUMPER);
    p.x = x + s * k; p.y = y + 0.45; p.z = z + c * k;
    p.vx = vx * 0.6 + (rand() - 0.5) * 2; p.vy = 1.5 + rand() * 1.5; p.vz = vz * 0.6 + (rand() - 0.5) * 2;
    p.h = h + (front ? 0 : Math.PI); p.spin = (rand() - 0.5) * 6; p.tiltT = 1.45;
    p.sx = w * 0.95; p.sy = 0.26; p.sz = 0.16;
    this.bumpers.paint(p, color);
    this.bumpers.write(p, 1);
  }

  /** A door on its hinge: it swings open on the car for a moment, then falls. `left` is the driver's side (+x). */
  door(car: Anchor, left: boolean, hl: number, hw: number, height: number, color: number, rand: () => number): void {
    const p = this.panels.take(DOOR);
    p.side = left ? 1 : -1; p.car = car;
    p.sx = 0.07; p.sy = Math.min(0.82, height * 0.55); p.sz = 0.52 * hl; p.len = p.sz;
    p.ax = p.side * (hw + 0.01); p.ay = 0.36 + p.sy / 2; p.az = 0.3 * hl;
    p.hang = 0.9 + rand() * 0.5;
    this.panels.paint(p, color);
    this.pose(p);
  }

  /** The bonnet pops up on its hinge at the windscreen end, flaps, then flies off. */
  hood(car: Anchor, hl: number, hw: number, height: number, color: number, rand: () => number): void {
    const p = this.panels.take(HOOD);
    p.car = car;
    p.sx = 2 * hw * 0.8; p.sy = 0.05; p.sz = 0.69 * hl; p.len = p.sz;
    p.ax = 0; p.ay = height * 0.55; p.az = 0.26 * hl;
    p.hang = 0.7 + rand() * 0.4;
    this.panels.paint(p, color);
    this.pose(p);
  }

  /** A wheel that has come off at (lx, lz) of the car: it bounds away on its own, rolling, and falls over. */
  wheel(car: Anchor, lx: number, lz: number, r: number, w: number, rand: () => number): void {
    const s = Math.sin(car.h), c = Math.cos(car.h), p = this.wheels.take(WHEEL);
    p.x = car.x + lx * c + lz * s; p.y = car.y + r; p.z = car.z - lx * s + lz * c;
    const side = lx > 0 ? 1 : -1;
    p.side = side;
    p.vx = car.vx * 0.95 + c * side * (1 + rand() * 1.5); p.vz = car.vz * 0.95 - s * side * (1 + rand() * 1.5);
    p.vy = 2 + rand() * 2;
    p.h = Math.hypot(car.vx, car.vz) > 1 ? Math.atan2(p.vx, p.vz) : car.h;
    p.spinA = rand() * 6; p.sx = w; p.sy = p.sz = 2 * r;
    this.wheels.write(p, 1);
  }

  /** A part still on its hinge: where its car puts it now. */
  private pose(p: Piece): void {
    const car = p.car!, s = Math.sin(car.h), c = Math.cos(car.h), t = p.hangT;
    const hx = car.x + p.ax * c + p.az * s, hy = car.y + p.ay, hz = car.z - p.ax * s + p.az * c;
    if (p.kind === DOOR) {
      // Swings outward about the hinge at its front edge, overshoots and rattles.
      const phi = 1.05 * (1 - Math.exp(-5 * t)) + 0.14 * Math.sin(9 * t) * Math.exp(-2 * t);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const fx = s * cp - p.side * c * sp, fz = c * cp + p.side * s * sp;
      p.x = hx - fx * p.len / 2; p.y = hy; p.z = hz - fz * p.len / 2;
      p.h = Math.atan2(fx, fz); p.tilt = 0; p.roll = 0;
    } else {
      // Hinged at the windscreen end, the front edge flung up.
      const th = 0.95 * (1 - Math.exp(-6 * t)) + 0.12 * Math.sin(11 * t) * Math.exp(-3 * t);
      p.x = hx + s * Math.cos(th) * p.len / 2; p.y = hy + Math.sin(th) * p.len / 2; p.z = hz + c * Math.cos(th) * p.len / 2;
      p.h = car.h; p.tilt = th; p.roll = 0;
    }
    this.panels.write(p, 1);
  }

  /** The hinge lets go. */
  private release(p: Piece, rand: () => number): void {
    const car = p.car!, s = Math.sin(car.h), c = Math.cos(car.h);
    p.hang = 0; p.car = null; p.rest = false;
    if (p.kind === DOOR) {
      p.vx = car.vx * 0.75 + c * p.side * (2 + rand() * 2); p.vz = car.vz * 0.75 - s * p.side * (2 + rand() * 2);
      p.vy = 2.5 + rand() * 1.5; p.spin = p.side * (1 + rand() * 2);
      p.tiltT = 0; p.rollT = (rand() < 0.7 ? 1 : -1) * HALF_PI;
    } else {
      p.vx = car.vx + s * 3; p.vz = car.vz + c * 3;
      p.vy = 5 + rand() * 2; p.spin = (rand() - 0.5) * 6;
      p.tiltT = 0.05; p.rollT = rand() < 0.5 ? 0 : Math.PI;
    }
  }

  /** A car at (x, z) heading h, speed (vx, vz), drives through whatever lies under it: the parts are kicked aside. */
  kick(x: number, z: number, h: number, hl: number, hw: number, vx: number, vz: number, rand: () => number): void {
    const sp = Math.hypot(vx, vz);
    if (sp < 1.5) return;
    const s = Math.sin(h), c = Math.cos(h);
    for (const pl of this.pools) {
      if (!pl.alive) continue;
      for (const p of pl.pieces) {
        if (!p.live || p.hang > 0 || p.kick > 0 || p.t > LIFE - FADE) continue;
        const dx = p.x - x, dz = p.z - z, lz = dx * s + dz * c, lx = dx * c - dz * s;
        if (Math.abs(lz) > hl + 0.2 || Math.abs(lx) > hw + 0.2) continue;
        p.rest = false; p.kick = 0.5;
        p.vx = vx * 1.05 + (rand() - 0.5) * 2 + c * lx * 1.5; p.vz = vz * 1.05 + (rand() - 0.5) * 2 - s * lx * 1.5;
        p.vy = 1.2 + sp * 0.12; p.spin += (rand() - 0.5) * 5;
      }
    }
  }

  update(dt: number, ground: (x: number, z: number) => number, rand: () => number = Math.random): void {
    for (const pl of this.pools) {
      if (!pl.alive) continue;
      for (const p of pl.pieces) {
        if (!p.live) continue;
        p.t += dt;
        if (p.kick > 0) p.kick -= dt;
        if (p.hang > 0) {
          p.hangT += dt; p.hang -= dt;
          if (p.hang <= 0) this.release(p, rand); else { this.pose(p); continue; }
        }
        if (p.t > LIFE) { p.live = false; pl.alive--; pl.hide(p); continue; }
        const fading = p.t > LIFE - FADE;
        if (p.rest && !fading) continue;
        if (!p.rest) this.fall(p, dt, ground);
        pl.write(p, fading ? Math.max(0.0001, (LIFE - p.t) / FADE) : 1);
      }
    }
  }

  /** One step of a free part: gravity, the road, friction, and turning toward the way it lies. */
  private fall(p: Piece, dt: number, ground: (x: number, z: number) => number): void {
    p.vy -= 9.8 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const wheel = p.kind === WHEEL, speed = Math.hypot(p.vx, p.vz);
    if (wheel) {
      // A wheel keeps rolling the way it is going, then wobbles over when it slows.
      if (speed > 0.5) p.h = Math.atan2(p.vx, p.vz);
      p.spinA += speed * dt / (p.sy / 2);
      p.rollT = speed > 2.2 ? 0 : p.side * HALF_PI;
    } else p.h += p.spin * dt;
    const rate = (wheel ? 1.6 : p.kind === BUMPER ? 2.5 : 4) * dt;
    p.tilt += Math.max(-rate, Math.min(rate, p.tiltT - p.tilt));
    p.roll += Math.max(-rate, Math.min(rate, p.rollT - p.roll));
    // How far the middle sits above the road in this attitude.
    _q.setFromEuler(wheel ? _ew.set(p.spinA, p.h, p.roll) : _e.set(-p.tilt, p.h, p.roll));
    const el = _m.makeRotationFromQuaternion(_q).elements;
    const off = wheel ? p.sy / 2 * Math.sqrt(Math.max(0, 1 - el[1] * el[1])) + p.sx / 2 * Math.abs(el[1])
      : 0.5 * (Math.abs(el[1]) * p.sx + Math.abs(el[5]) * p.sy + Math.abs(el[9]) * p.sz);
    const g = ground(p.x, p.z) + off + 0.01;
    let grounded = false;
    if (p.y < g) {
      p.y = g;
      if (Math.abs(p.vy) > 2) p.vy = -p.vy * (wheel ? 0.45 : 0.25); else { p.vy = 0; grounded = true; }
      const f = Math.exp(-(wheel ? (speed > 2.2 ? 0.3 : 3) : p.kind === BUMPER ? 6 : 4) * dt);
      p.vx *= f; p.vz *= f; p.spin *= f;
    }
    if (grounded && p.vx * p.vx + p.vz * p.vz < 0.01 && Math.abs(p.tilt - p.tiltT) < 0.02 && Math.abs(p.roll - p.rollT) < 0.02) p.rest = true;
  }

  clear(): void {
    for (const pl of this.pools) { for (const p of pl.pieces) if (p.live) { p.live = false; p.car = null; pl.hide(p); } pl.alive = 0; }
  }
}
