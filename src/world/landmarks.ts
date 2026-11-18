// The landmarks people remember: Pelican Pier and its Ferris wheel, Last Light
// Breakwater and the lighthouse, the Perpetual Bridge, the seven stunt ramps,
// and the residents: Gerald the gull, one very large duck, and a 3 AM visitor.
//
// Every deck here already exists in plan.groundAt(), which is what the physics
// drives on. The meshes are built from the same formulas so that wheels touch
// what the eye sees; nothing in this file decides where a surface is.
//
// The wheel stands on stilts on purpose. The pier's stunt ramp fires cars
// straight down the pier head and off the end toward the duck, so the middle
// ten meters stay clear and the gondolas pass overhead.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials } from './materials';
import type { AtlasRect } from './textures';
import { Batch } from './batch';
import { BREAKWATER, BRIDGE, DECK_Y, LIGHTHOUSE, PIER, PIER_HEAD, RAMPS, WATER_Y, groundAt } from './plan';
import { RNG, TAU, angleDiff, clamp, damp, headingOf, lerp, money, pickRand, rand, smooth } from '../core/util';

const INK = 0x14213d, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, TEAL = 0x2a9d8f;
const DEEP_TEAL = 0x1f7a70, TIMBER = 0x5c4a3a, STONE = 0x8d8a80, CONCRETE = 0xcbc4b2, RUST = 0x8e4a2a, GLASS = 0x222c40;
const SODIUM = 0xffb04a, WARM = 0xffe2a0;

interface Ctx {
  game: Game;
  mats: CityMaterials;
  parent: THREE.Group;
  /** One batch each for every sign and every lamp halo in this file: two draw calls for the lot. */
  signs: Batch;
  glow: Batch;
  cast: boolean;
}

function mesh(b: Batch, mat: THREE.Material, parent: THREE.Object3D, cast: boolean, name: string): THREE.Mesh {
  const m = new THREE.Mesh(b.toGeometry(), mat);
  m.name = name;
  m.castShadow = cast; m.receiveShadow = true;
  m.matrixAutoUpdate = false;
  parent.add(m);
  return m;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * A local frame in plan.ts's ramp convention: `a` runs along heading h from the
 * origin, `s` across it. Sharing the convention with rampHeight() is what keeps
 * the ramp meshes and the physics from disagreeing about left and right.
 */
interface Frame { x: number; z: number; sn: number; cs: number }
const frame = (x: number, z: number, h: number): Frame => ({ x, z, sn: Math.sin(h), cs: Math.cos(h) });
const fx = (f: Frame, a: number, s: number): number => f.x + a * f.sn - s * f.cs;
const fz = (f: Frame, a: number, s: number): number => f.z + a * f.cs + s * f.sn;

/**
 * A box in a frame whose bottom and top may differ between its two ends, so it can follow a slope.
 * mask: 1 top, 2 bottom, 4 both long sides, 8 the end at a0, 16 the end at a1. `uv` applies to the top.
 */
function slab(
  b: Batch, f: Frame, a0: number, a1: number, s0: number, s1: number,
  lo0: number, hi0: number, lo1: number, hi1: number, hex: number, mask = 31, shade = 1,
  uv: readonly [number, number, number, number] = [0, 0, 1, 1],
): void {
  const x00 = fx(f, a0, s0), z00 = fz(f, a0, s0), x01 = fx(f, a0, s1), z01 = fz(f, a0, s1);
  const x10 = fx(f, a1, s0), z10 = fz(f, a1, s0), x11 = fx(f, a1, s1), z11 = fz(f, a1, s1);
  if (mask & 1) b.quad(x00, hi0, z00, x01, hi0, z01, x11, hi1, z11, x10, hi1, z10, hex, uv[0], uv[1], uv[2], uv[3], shade);
  if (mask & 2) b.quad(x01, lo0, z01, x00, lo0, z00, x10, lo1, z10, x11, lo1, z11, hex, 0, 0, 1, 1, shade * 0.6);
  if (mask & 4) {
    b.quad(x01, lo0, z01, x11, lo1, z11, x11, hi1, z11, x01, hi0, z01, hex, 0, 0, 1, 1, shade);
    b.quad(x10, lo1, z10, x00, lo0, z00, x00, hi0, z00, x10, hi1, z10, hex, 0, 0, 1, 1, shade);
  }
  if (mask & 8) b.quad(x00, lo0, z00, x01, lo0, z01, x01, hi0, z01, x00, hi0, z00, hex, 0, 0, 1, 1, shade);
  if (mask & 16) b.quad(x11, lo1, z11, x10, lo1, z10, x10, hi1, z10, x11, hi1, z11, hex, 0, 0, 1, 1, shade);
}

/** A square bar between two points in space: cables, spokes, rails, struts. w is its level width, h its depth. */
function beam(
  b: Batch, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  w: number, h: number, hex: number, caps = false, shade = 1,
): void {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz) || 1;
  dx /= L; dy /= L; dz /= L;
  // s = d x reference, u = s x d. The reference is up unless the bar itself stands upright.
  let sx: number, sy: number, sz: number;
  if (Math.abs(dy) > 0.98) { sx = 0; sy = dz; sz = -dy; } else { sx = -dz; sy = 0; sz = dx; }
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;
  const ux = sy * dz - sz * dy, uy = sz * dx - sx * dz, uz = sx * dy - sy * dx;
  const hw = w / 2, hh = h / 2;
  const px = sx * hw + ux * hh, py = sy * hw + uy * hh, pz = sz * hw + uz * hh; // corner (+s, +u)
  const qx = sx * hw - ux * hh, qy = sy * hw - uy * hh, qz = sz * hw - uz * hh; // corner (+s, -u)
  b.quad(ax - qx, ay - qy, az - qz, ax + px, ay + py, az + pz, bx + px, by + py, bz + pz, bx - qx, by - qy, bz - qz, hex, 0, 0, 1, 1, shade);
  b.quad(ax + qx, ay + qy, az + qz, ax - px, ay - py, az - pz, bx - px, by - py, bz - pz, bx + qx, by + qy, bz + qz, hex, 0, 0, 1, 1, shade * 0.7);
  b.quad(ax + px, ay + py, az + pz, ax + qx, ay + qy, az + qz, bx + qx, by + qy, bz + qz, bx + px, by + py, bz + pz, hex, 0, 0, 1, 1, shade);
  b.quad(ax - px, ay - py, az - pz, ax - qx, ay - qy, az - qz, bx - qx, by - qy, bz - qz, bx - px, by - py, bz - pz, hex, 0, 0, 1, 1, shade);
  if (caps) {
    b.quad(ax - px, ay - py, az - pz, ax + qx, ay + qy, az + qz, ax + px, ay + py, az + pz, ax - qx, ay - qy, az - qz, hex, 0, 0, 1, 1, shade);
    b.quad(bx + qx, by + qy, bz + qz, bx - px, by - py, bz - pz, bx - qx, by - qy, bz - qz, bx + px, by + py, bz + pz, hex, 0, 0, 1, 1, shade);
  }
}

/** Upright rectangle centered on a point, facing heading f. Takes an atlas piece for signs. */
function vquad(b: Batch, cx: number, cy: number, cz: number, w: number, h: number, f: number, hex: number, r: AtlasRect | null = null): void {
  const tx = Math.cos(f) * w / 2, tz = -Math.sin(f) * w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  b.quad(cx - tx, y0, cz - tz, cx + tx, y0, cz + tz, cx + tx, y1, cz + tz, cx - tx, y1, cz - tz, hex,
    r ? r.u0 : 0, r ? r.v0 : 0, r ? r.u1 : 1, r ? r.v1 : 1);
}

/** A lamp's halo: two crossed cards seen from both sides, since the glow material is not a billboard. */
function halo(b: Batch, x: number, y: number, z: number, size: number, hex: number): void {
  for (let k = 0; k < 4; k++) vquad(b, x, y, z, size, size, k * Math.PI / 2, hex);
}
const pool = (b: Batch, x: number, y: number, z: number, r: number, hex: number): void => b.floor(x - r, z - r, x + r, z + r, y, hex);

/** Striped carnival roof: a pyramid whose faces alternate two colours, over a short valance. */
function tent(b: Batch, cx: number, y: number, cz: number, hx: number, hz: number, rise: number, colA: number, colB: number, strips = 3): void {
  const cor = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let k = 0; k < 4; k++) {
    const p = cor[k], q = cor[(k + 1) % 4];
    for (let i = 0; i < strips; i++) {
      const t0 = i / strips, t1 = (i + 1) / strips;
      b.tri(cx, y + rise, cz, cx + lerp(p[0], q[0], t1), y, cz + lerp(p[1], q[1], t1), cx + lerp(p[0], q[0], t0), y, cz + lerp(p[1], q[1], t0),
        (i + k * strips) % 2 ? colB : colA);
    }
  }
  if (strips > 1) b.box(cx, y - 0.26, cz, hx * 2, 0.26, hz * 2, colB, 0, 4);
}

/** A signboard on a dark backing panel. The picture faces heading f. */
function board(c: Ctx, flat: Batch, x: number, y: number, z: number, w: number, h: number, f: number, name: string): void {
  flat.box(x, y - h / 2 - 0.1, z, w + 0.2, h + 0.2, 0.14, INK, f);
  vquad(c.signs, x + Math.sin(f) * 0.08, y, z + Math.cos(f) * 0.08, w, h, f, 0xffffff, c.mats.tex.signs.rect(name));
}

// ── Pelican Pier ─────────────────────────────────────────────────────────────

const pierY = (z: number): number => DECK_Y * clamp((z - PIER.z0) / 10, 0, 1);

function buildPier(c: Ctx): (dt: number, t: number) => void {
  const { mats, game } = c, col = game.col;
  const deck = new Batch(), flat = new Batch(), apron = new Batch();
  const W = 4; // TILE_M.wood

  // Planks run across the pier (v along x) and lengthwise on the head, the way the two would have been built.
  for (const [zA, zB] of [[PIER.z0, PIER.z0 + 10], [PIER.z0 + 10, PIER_HEAD.z0]]) {
    deck.quad(PIER.x0, pierY(zA), zA, PIER.x0, pierY(zB), zB, PIER.x1, pierY(zB), zB, PIER.x1, pierY(zA), zA, 0xe9dfc8, zA / W, PIER.x0 / W, zB / W, PIER.x1 / W);
  }
  const H = PIER_HEAD;
  deck.quad(H.x0, DECK_Y, H.z1, H.x1, DECK_Y, H.z1, H.x1, DECK_Y, H.z0, H.x0, DECK_Y, H.z0, 0xdfd3b8, H.x0 / W, H.z1 / W, H.x1 / W, H.z0 / W);

  // Seawall Dr ends at z = 406; this is the bit of tarmac that gets a car from there onto the boards.
  apron.floor(PIER.x0 - 2, 406, PIER.x1 + 2, PIER.z0, 0.03, 0xffffff, 22 / 8, 24 / 8);

  // Edge boards and the timber underneath.
  slab(flat, frame(0, PIER.z0, 0), 0, 10, PIER.x0, PIER.x1, -0.2, 0, -0.2, DECK_Y, TIMBER, 4);
  for (const x of [PIER.x0 + 0.1, PIER.x1 - 0.1]) flat.box(x, DECK_Y - 0.6, (PIER.z0 + 10 + H.z0) / 2, 0.22, 0.59, H.z0 - PIER.z0 - 10, TIMBER, 0, 4);
  flat.box(0, DECK_Y - 0.6, (H.z0 + H.z1) / 2, H.x1 - H.x0, 0.59, H.z1 - H.z0, TIMBER, 0, 6);
  for (const x of [-6, 0, 6]) flat.box(x, DECK_Y - 0.95, 540, 0.35, 0.5, 120, TIMBER, 0, 6, 0.8);
  for (let z = 446; z < H.z0 - 4; z += 12) {
    for (const x of [-8.2, 8.2]) flat.cyl(x, -6, z, 0.34, 0.3, DECK_Y + 5.5, TIMBER, 6, false);
    flat.box(0, DECK_Y - 0.85, z, 17.6, 0.3, 0.4, TIMBER, 0, 6, 0.9);
    if (z > 480) {
      beam(flat, -8.2, -0.9, z, 8.2, DECK_Y - 0.9, z, 0.14, 0.14, TIMBER, false, 0.85);
      beam(flat, 8.2, -0.9, z, -8.2, DECK_Y - 0.9, z, 0.14, 0.14, TIMBER, false, 0.85);
    }
  }
  for (let z = H.z0 + 3; z < H.z1; z += 12.4) {
    for (let x = -32; x <= 32; x += 12.8) flat.cyl(x, -6, z, 0.38, 0.34, DECK_Y + 5.5, TIMBER, 6, false);
    flat.box(0, DECK_Y - 0.9, z, 66, 0.3, 0.45, TIMBER, 0, 6, 0.9);
  }

  // Railings: posts with a teal handrail, and one thin wall each for the physics.
  const rail = (x0: number, z0: number, x1: number, z1: number): void => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 2.8));
    let px = x0, pz = z0, py = pierY(z0);
    for (let i = 0; i <= n; i++) {
      const x = lerp(x0, x1, i / n), z = lerp(z0, z1, i / n), y = pierY(z);
      flat.box(x, y, z, 0.12, 1.1, 0.12, BONE, 0, 4);
      if (i > 0) {
        beam(flat, px, py + 1.1, pz, x, y + 1.1, z, 0.17, 0.1, TEAL);
        beam(flat, px, py + 0.58, pz, x, y + 0.58, z, 0.07, 0.07, BONE);
      }
      px = x; pz = z; py = y;
    }
    col.addBox(Math.min(x0, x1) - 0.15, Math.min(z0, z1) - 0.15, Math.max(x0, x1) + 0.15, Math.max(z0, z1) + 0.15, DECK_Y + 1.2, -0.5);
  };
  rail(PIER.x0, PIER.z0 + 2, PIER.x0, H.z0); rail(PIER.x1, PIER.z0 + 2, PIER.x1, H.z0);
  rail(PIER.x0, H.z0, H.x0, H.z0); rail(PIER.x1, H.z0, H.x1, H.z0);
  rail(H.x0, H.z0, H.x0, H.z1); rail(H.x1, H.z0, H.x1, H.z1);
  // The south rail has a gap in line with the ramp. That is not an oversight.
  rail(H.x0, H.z1, -7, H.z1); rail(7, H.z1, H.x1, H.z1);

  const lamp = (x: number, z: number, inward: number): void => {
    const y = pierY(z), lx = x + inward * 0.9;
    flat.box(x, y, z, 0.16, 4.6, 0.16, INK, 0, 4);
    beam(flat, x, y + 4.5, z, lx, y + 4.75, z, 0.1, 0.1, INK);
    flat.box(lx, y + 4.2, z, 0.36, 0.44, 0.36, 0xfff1c9);
    flat.box(lx, y + 4.64, z, 0.5, 0.08, 0.5, INK);
    halo(c.glow, lx, y + 4.4, z, 2.6, SODIUM);
    pool(c.glow, lx + inward * 1.2, y + 0.06, z, 5.5, 0x7a4f1e);
  };
  for (let z = 452; z < H.z0; z += 24) { lamp(PIER.x0 + 0.45, z, 1); lamp(PIER.x1 - 0.45, z, -1); }
  for (const z of [604, 636, 664]) { lamp(H.x0 + 0.5, z, 1); lamp(H.x1 - 0.5, z, -1); }

  // The entrance arch.
  const AZ = PIER.z0 + 1, AX = 9.7;
  for (const sx of [-1, 1]) {
    flat.box(sx * AX, 0, AZ, 0.7, 8.2, 0.7, DEEP_TEAL, 0, 4);
    flat.box(sx * AX, 0, AZ, 1.1, 0.8, 1.1, CONCRETE);
    flat.box(sx * AX, 8.2, AZ, 0.95, 0.3, 0.95, BONE);
    flat.box(sx * AX, 8.5, AZ, 0.45, 0.45, 0.45, MUST);
    col.addBoxC(sx * AX, AZ, 1.1, 1.1, 8.5);
  }
  const archY = (x: number): number => 8.0 + 2.6 * (1 - (x / AX) * (x / AX));
  for (let i = 0; i < 12; i++) {
    const x0 = lerp(-AX, AX, i / 12), x1 = lerp(-AX, AX, (i + 1) / 12);
    beam(flat, x0, archY(x0), AZ, x1, archY(x1), AZ, 0.4, 0.4, VERM);
    if (i > 0) {
      beam(flat, x0, 4.9, AZ, x0, archY(x0), AZ, 0.12, 0.12, BONE);
      for (const f of [0, Math.PI]) vquad(c.glow, x0, archY(x0) + 0.45, AZ + Math.cos(f) * 0.3, 1.5, 1.5, f, i % 2 ? WARM : SODIUM);
      flat.box(x0, archY(x0) + 0.2, AZ, 0.22, 0.22, 0.22, 0xfff1c9);
    }
  }
  beam(flat, -AX, 4.9, AZ, AX, 4.9, AZ, 0.4, 0.3, DEEP_TEAL);
  flat.box(0, 5.15, AZ, 12.5, 3.25, 0.3, INK);
  const plate = mats.tex.signs.rect('pelican-pier');
  vquad(c.signs, 0, 6.78, AZ - 0.17, 12, 3, Math.PI, 0xffffff, plate);
  vquad(c.signs, 0, 6.78, AZ + 0.17, 12, 3, 0, 0xffffff, plate);

  // Harbor Authority paperwork, where it will do the least good.
  const notice = (x: number, z: number, f: number, name: string): void => {
    const y = pierY(z);
    flat.box(x, y, z, 0.09, 2.3, 0.09, INK, 0, 4);
    board(c, flat, x + Math.sin(f) * 0.1, y + 1.75, z + Math.cos(f) * 0.1, 0.84, 1.2, f, name);
  };
  notice(PIER.x0 + 0.7, 447, Math.PI, 'notice-gulls');
  notice(8.3, H.z1 - 0.6, Math.PI, 'notice-duck');
  notice(-30, H.z1 - 0.6, Math.PI, 'notice-fishing');

  // Booths. Local +z is the counter side; f turns it to face the driveway.
  const shops = mats.tex.signs.shops;
  const booth = (cx: number, cz: number, f: number, body: number, stripe: number, sign: string): void => {
    const sn = Math.sin(f), cs = Math.cos(f), y = DECK_Y, w = 4.2, d = 3;
    const lx = (l: number, m: number): number => cx + l * cs + m * sn;
    const lz = (l: number, m: number): number => cz - l * sn + m * cs;
    flat.box(cx, y, cz, w, 2.5, d, body, f);
    flat.box(cx, y, cz, w + 0.08, 0.9, d + 0.08, stripe, f, 4);
    vquad(flat, lx(0, d / 2 + 0.03), y + 1.6, lz(0, d / 2 + 0.03), 3.1, 1.05, f, GLASS);
    flat.box(lx(0, d / 2 + 0.2), y + 0.98, lz(0, d / 2 + 0.2), 3.4, 0.1, 0.45, BONE, f);
    board(c, flat, lx(0, d / 2 + 0.5), y + 3.08, lz(0, d / 2 + 0.5), 3.8, 0.95, f, sign);
    const side = Math.abs(sn) > 0.5;
    tent(flat, cx, y + 2.5, cz, (side ? d : w) / 2 + 0.5, (side ? w : d) / 2 + 0.5, 1.5, stripe, BONE);
    col.addBoxC(cx, cz, side ? d : w, side ? w : d, 4, 0);
  };
  const E = -Math.PI / 2, Wd = Math.PI / 2;
  booth(-25, 610, Wd, BONE, VERM, shops[4 % shops.length]);
  booth(-25, 621, Wd, 0xe9dcc0, TEAL, shops[7 % shops.length]);
  booth(-25, 648, Wd, BONE, MUST, shops[9 % shops.length]);
  booth(-25, 659, Wd, 0xe9dcc0, VERM, shops[12 % shops.length]);
  booth(25, 610, E, BONE, TEAL, shops[14 % shops.length]);
  booth(25, 648, E, 0xe9dcc0, VERM, shops[17 % shops.length]);
  booth(25, 659, E, BONE, INK, shops[20 % shops.length]);
  booth(15, 618, E, MUST, INK, 'pelican-pier'); // the ticket hut

  const wheel = buildWheel(c, flat);

  mesh(deck, mats.wood, c.parent, false, 'pier-deck');
  mesh(apron, mats.asphalt, c.parent, false, 'pier-apron');
  mesh(flat, mats.flat, c.parent, c.cast, 'pier');
  return wheel;
}

function buildWheel(c: Ctx, flat: Batch): (dt: number, t: number) => void {
  const { mats, game } = c;
  const HY = 30, HZ = 634, R = 20, RI = 17.6, RM = 9, RP = 19, ZR = 1.6, N = 32, G = 16;

  // What stands still: four splayed legs, the axle, and a boarding platform either side of the driveway.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      beam(flat, sx * 15, DECK_Y + 0.8, HZ + sz * 6.5, sx * 0.7, HY, HZ + sz * 2.7, 0.95, 0.95, INK);
      flat.box(sx * 15, DECK_Y, HZ + sz * 6.5, 2.4, 0.9, 2.4, CONCRETE);
      game.col.addBoxC(sx * 15, HZ + sz * 6.5, 2.6, 2.6, 4, 0);
    }
    beam(flat, sx * 13.1, 5, HZ - 6, sx * 13.1, 5, HZ + 6, 0.4, 0.4, INK);
    const cx = sx * 8.5, top = 6.9;
    flat.box(cx, top, HZ, 6, 0.3, 7, 0xd9cbb0, 0, 7);
    for (const px of [-2.8, 2.8]) for (const pz of [-3.3, 3.3]) {
      flat.box(cx + px, DECK_Y, HZ + pz, 0.3, top - DECK_Y, 0.3, INK, 0, 4);
      flat.box(cx + px, top + 0.3, HZ + pz, 0.1, 1.1, 0.1, BONE, 0, 4);
    }
    for (const pz of [-3.3, 3.3]) {
      beam(flat, cx - 2.8, DECK_Y, HZ + pz, cx + 2.8, top, HZ + pz, 0.14, 0.14, BONE);
      beam(flat, cx + 2.8, DECK_Y, HZ + pz, cx - 2.8, top, HZ + pz, 0.14, 0.14, BONE);
      beam(flat, cx - 2.8, top + 1.4, HZ + pz, cx + 2.8, top + 1.4, HZ + pz, 0.14, 0.1, TEAL);
    }
    const ox = cx + sx * 2.8;
    beam(flat, ox, top + 1.4, HZ - 3.3, ox, top + 1.4, HZ + 0.9, 0.14, 0.1, TEAL);
    // Stairs, drawn as one plank with a handrail: nobody climbs them, the wheel has no refunds.
    const sz = HZ + 2.3;
    beam(flat, sx * 20.5, DECK_Y, sz, sx * 11.5, top + 0.3, sz, 1.4, 0.22, 0xd9cbb0);
    for (const o of [-0.7, 0.7]) beam(flat, sx * 20.5, DECK_Y + 1, sz + o, sx * 11.5, top + 1.3, sz + o, 0.08, 0.08, TEAL);
    for (let k = 1; k < 9; k++) {
      const f = k / 9, x = lerp(sx * 20.5, sx * 11.5, f), y = lerp(DECK_Y, top + 0.3, f);
      flat.box(x, y + 0.1, sz, 0.5, 0.1, 1.4, INK, 0, 5);
    }
    game.col.addBox(cx - 3, HZ - 3.5, cx + 3, HZ + 3.5, top + 1.5, 0);
  }
  beam(flat, 0, HY, HZ - 3.4, 0, HY, HZ + 3.4, 1.1, 1.1, INK, true);
  for (const sz of [-1, 1]) flat.box(0, HY - 1, HZ + sz * 2.9, 2.6, 2, 1, INK);

  // What turns. Built around the origin so the group only ever needs a rotation.
  const rot = new Batch(), lights = new Batch();
  for (const side of [-1, 1]) {
    const z = side * ZR, f = side > 0 ? 0 : Math.PI, gz = side * (ZR + 0.28);
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * TAU, a1 = ((i + 1) / N) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      beam(rot, c0 * R, s0 * R, z, c1 * R, s1 * R, z, 0.32, 0.32, BONE);
      beam(rot, c0 * RI, s0 * RI, z, c1 * RI, s1 * RI, z, 0.2, 0.2, BONE);
      beam(rot, c0 * RI, s0 * RI, z, c0 * R, s0 * R, z, 0.14, 0.14, BONE);
      beam(rot, c0 * R, s0 * R, z, c1 * RI, s1 * RI, z, 0.1, 0.1, BONE);
      beam(rot, c0 * RM, s0 * RM, z, c1 * RM, s1 * RM, z, 0.14, 0.14, BONE);
      vquad(lights, c0 * R, s0 * R, gz, 2.1, 2.1, f, i % 2 ? WARM : SODIUM);
    }
    for (let k = 0; k < G; k++) {
      const a = (k / G) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      beam(rot, ca * 1.5, sa * 1.5, z, ca * RI, sa * RI, z, 0.2, 0.2, BONE);
      for (const r of [5.5, 9.5, 13.5]) vquad(lights, ca * r, sa * r, gz, 1.3, 1.3, f, k % 2 ? 0xff9a4a : WARM);
      // Hub plate: a sunburst, because a wheel this size deserves a middle.
      const b0 = ((k + (side > 0 ? 0 : 1)) / G) * TAU, b1 = ((k + (side > 0 ? 1 : 0)) / G) * TAU, hz = side * 2.2;
      rot.tri(0, 0, hz, Math.cos(b0) * 3, Math.sin(b0) * 3, hz, Math.cos(b1) * 3, Math.sin(b1) * 3, hz, k % 2 ? MUST : VERM);
    }
    vquad(lights, 0, 0, side * 2.5, 7, 7, f, 0xff7a4a);
  }
  for (let k = 0; k < G; k++) {
    const a = (k / G) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    beam(rot, ca * RP, sa * RP, -ZR, ca * RP, sa * RP, ZR, 0.16, 0.16, INK);
  }
  beam(rot, 0, 0, -2.15, 0, 0, 2.15, 2.2, 2.2, VERM);

  const spin = new THREE.Group();
  spin.name = 'ferris-wheel';
  spin.position.set(0, HY, HZ);
  c.parent.add(spin);
  mesh(rot, mats.flat, spin, c.cast, 'wheel');
  mesh(lights, mats.glow, spin, false, 'wheel-lights');

  // One gondola, hanging from the origin. White paint takes the instance colour; the dark parts stay dark.
  const g = new Batch();
  for (const z of [-1.12, 1.12]) g.box(0, -1.05, z, 0.1, 1.05, 0.1, 0x3a3a44, 0, 4);
  tent(g, 0, -1.0, 0, 1.3, 1.3, 0.6, 0xffffff, 0xffffff, 1);
  g.box(0, -1.08, 0, 2.6, 0.08, 2.6, 0xd0d0d0, 0, 6);
  g.box(0, -1.95, 0, 1.9, 0.87, 1.9, 0x2a3348, 0, 4);
  for (const x of [-0.98, 0.98]) for (const z of [-0.98, 0.98]) g.box(x, -1.95, z, 0.16, 0.87, 0.16, 0xffffff, 0, 4);
  g.box(0, -2.95, 0, 2.1, 1.0, 2.1, 0xffffff, 0, 7);
  g.box(0, -2.12, 0, 2.2, 0.14, 2.2, 0xb8b8b8, 0, 7);
  const cars = new THREE.InstancedMesh(g.toGeometry(), mats.flat, G);
  cars.name = 'gondolas';
  cars.castShadow = c.cast;
  // They ride around the whole wheel, so cull against the wheel, not against wherever they started.
  cars.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, HY, HZ), R + 5);
  const tints = [VERM, MUST, TEAL, BONE], tint = new THREE.Color();
  for (let k = 0; k < G; k++) cars.setColorAt(k, tint.setHex(tints[k % 4]));
  c.parent.add(cars);

  const M = new THREE.Matrix4();
  let theta = 0.2;
  return (dt, t) => {
    theta = (theta + dt * 0.07) % TAU;
    spin.rotation.z = theta;
    for (let k = 0; k < G; k++) {
      const a = theta + (k / G) * TAU;
      M.makeRotationZ(Math.sin(t * 0.9 + k * 1.7) * 0.035);
      M.setPosition(Math.cos(a) * RP, HY + Math.sin(a) * RP, HZ);
      cars.setMatrixAt(k, M);
    }
    cars.instanceMatrix.needsUpdate = true;
  };
}

// ── Gerald ───────────────────────────────────────────────────────────────────

const GERALD_LINES: ((n: string) => string)[] = [
  (n) => `Gerald took ${n}. Gerald has no regrets.`,
  (n) => `Gerald has collected a ${n} pier toll. There is no pier toll.`,
  (n) => `${n} gone. Gerald calls it a convenience fee.`,
  (n) => `Gerald relieved you of ${n} and several illusions.`,
  (n) => `Gerald took ${n}. The Harbor Authority has been warned about Gerald.`,
  (n) => `You have donated ${n} to Gerald. Gerald thanks you for nothing in particular.`,
];

class Gerald {
  private root = new THREE.Group();
  private head: THREE.Mesh;
  private wings: THREE.Mesh[] = [];
  /** Rail-top perches: x, y, z, and the heading he settles into (facing the boards, watching pockets). */
  private perches: [number, number, number, number][] = [];
  private at = 0;
  private from = 0;
  private flying = false;
  private k = 0;
  private dur = 1;
  private cool = 0;
  private hop = 0;
  private nextHop = 2;
  private glance = 0;
  private nextGlance = 1;
  private tilt = 0;
  private static readonly SCALE = 1.7;

  constructor(private game: Game, c: Ctx) {
    const white = 0xf7f3e8, grey = 0x9aa3ad, leg = 0xe89a1c;
    const body = new Batch();
    body.box(0, 0.14, 0, 0.2, 0.19, 0.4, white);
    body.box(0, 0.17, 0.2, 0.16, 0.15, 0.1, white);
    body.box(0, 0.32, -0.05, 0.22, 0.04, 0.42, grey);
    body.box(0, 0.27, -0.3, 0.12, 0.04, 0.18, 0x30333b);
    for (const x of [-0.05, 0.05]) { body.box(x, 0, 0.02, 0.025, 0.15, 0.025, leg, 0, 4); body.box(x, 0, 0.05, 0.06, 0.012, 0.09, leg); }
    mesh(body, c.mats.flat, this.root, c.cast, 'gerald');

    const hd = new Batch();
    hd.box(0, -0.03, 0, 0.1, 0.1, 0.1, white, 0, 4);
    hd.box(0, 0.05, 0.02, 0.14, 0.13, 0.16, white);
    hd.box(0, 0.075, 0.15, 0.045, 0.04, 0.13, MUST);
    hd.box(0, 0.068, 0.215, 0.047, 0.03, 0.03, VERM);
    for (const x of [-0.072, 0.072]) hd.box(x, 0.115, 0.06, 0.012, 0.028, 0.028, INK);
    this.head = new THREE.Mesh(hd.toGeometry(), c.mats.flat);
    this.head.position.set(0, 0.33, 0.17);
    this.root.add(this.head);

    const wg = new Batch();
    wg.quad(0, 0, 0.12, 0.5, 0, 0.08, 0.62, 0, -0.1, 0, 0, -0.14, grey);
    wg.tri(0.5, 0, 0.08, 0.86, 0, -0.06, 0.62, 0, -0.1, 0x30333b);
    const geo = wg.toGeometry();
    for (const sx of [1, -1]) {
      const w = new THREE.Mesh(geo, c.mats.flatDouble);
      w.position.set(sx * 0.1, 0.33, 0);
      w.scale.x = sx;
      w.visible = false;
      this.root.add(w);
      this.wings.push(w);
    }

    const top = 1.16;
    for (const [x, z] of [[-9, 462], [9, 486], [-9, 514], [9, 542], [-9, 570], [9, 596]]) this.perches.push([x, pierY(z) + top, z, headingOf(-x, 0)]);
    this.perches.push([-34, DECK_Y + top, 622, Math.PI / 2], [34, DECK_Y + top, 646, -Math.PI / 2], [-20, DECK_Y + top, 668, Math.PI], [20, DECK_Y + top, 600, 0]);
    const p = this.perches[0];
    this.root.position.set(p[0], p[1], p[2]);
    this.root.rotation.y = p[3];
    this.root.scale.setScalar(Gerald.SCALE);
    this.root.name = 'gerald';
    c.parent.add(this.root);
  }

  /** Leave for another perch, by preference one well away from whoever is asking. */
  private flee(px: number, pz: number): void {
    let to = this.at;
    for (let tries = 0; tries < 8; tries++) {
      to = Math.floor(rand(this.perches.length));
      const q = this.perches[to];
      if (to !== this.at && (tries > 5 || Math.hypot(q[0] - px, q[2] - pz) > 22)) break;
    }
    if (to === this.at) to = (this.at + 1) % this.perches.length;
    const a = this.perches[this.at], b = this.perches[to];
    this.from = this.at; this.at = to;
    this.flying = true; this.k = 0;
    this.dur = Math.max(1.4, Math.hypot(b[0] - a[0], b[2] - a[2]) / 10);
    this.root.rotation.y = headingOf(b[0] - a[0], b[2] - a[2]);
    this.head.rotation.set(0, 0, 0);
    for (const w of this.wings) w.visible = true;
  }

  update(dt: number, t: number): void {
    const root = this.root, pl = this.game.player;
    this.cool -= dt;
    if (this.flying) {
      this.k += dt / this.dur;
      const a = this.perches[this.from], b = this.perches[this.at], k = Math.min(this.k, 1), e = smooth(k);
      const lift = Math.sin(Math.PI * k) * (2.5 + this.dur * 0.6);
      root.position.set(lerp(a[0], b[0], e), lerp(a[1], b[1], e) + lift, lerp(a[2], b[2], e));
      const flap = 0.15 + 0.85 * Math.sin(t * 17);
      this.wings[0].rotation.z = flap; this.wings[1].rotation.z = -flap;
      root.rotation.x = -0.25 * Math.cos(Math.PI * k);
      if (this.k >= 1) {
        this.flying = false;
        root.rotation.set(0, b[3], 0);
        for (const w of this.wings) w.visible = false;
        this.hop = 0.3;
      }
      return;
    }

    const p = this.perches[this.at];
    let wantYaw = this.glance, near = false;
    if (pl) {
      const dx = pl.x - p[0], dz = pl.z - p[2], d2 = dx * dx + dz * dz;
      const level = Math.abs(pl.y - (p[1] - 1.16)) < 2.5;
      if (d2 < 200 && level) {
        // He watches you come. It is the pocket he is watching.
        near = true;
        wantYaw = clamp(angleDiff(root.rotation.y, headingOf(dx, dz)), -1.5, 1.5);
      }
      if (level && pl.vehicle && d2 < 30) this.flee(pl.x, pl.z);
      else if (level && !pl.vehicle && d2 < 9) {
        if (this.cool <= 0 && pl.money >= 1) {
          const n = Math.min(Math.floor(pl.money), 1 + Math.floor(rand(5)));
          pl.money -= n;
          this.cool = 20;
          this.game.hud.toast(pickRand(GERALD_LINES)(money(n)), 4);
          this.flee(pl.x, pl.z);
        } else if (d2 < 2.6) this.flee(pl.x, pl.z);
      }
      if (this.flying) return;
    }

    // Idle business: glance about, cock the head, hop on the spot.
    this.nextGlance -= dt;
    if (this.nextGlance <= 0) {
      this.nextGlance = rand(0.7, 2.4);
      this.glance = rand(-1.3, 1.3);
      this.tilt = rand() < 0.35 ? rand(-0.4, 0.4) : 0;
    }
    this.head.rotation.y = damp(this.head.rotation.y, wantYaw, near ? 9 : 14, dt);
    this.head.rotation.z = damp(this.head.rotation.z, this.tilt, 10, dt);
    this.nextHop -= dt;
    if (this.nextHop <= 0) {
      this.nextHop = rand(2.2, 5.5);
      this.hop = 0.3;
      if (!near) root.rotation.y = p[3] + rand(-0.7, 0.7);
    }
    let y = p[1];
    if (this.hop > 0) {
      this.hop -= dt;
      y += Math.sin(Math.PI * clamp(this.hop / 0.3, 0, 1)) * 0.16;
    }
    root.position.set(p[0], y, p[2]);
  }
}

// ── Last Light Breakwater ────────────────────────────────────────────────────

/** Two-ended additive light cone along +x (and -x when `both`), fading to nothing at the far end. */
function coneGeometry(len: number, r0: number, r1: number, seg: number, hex: number, gain: number, drop: number, both: boolean): THREE.BufferGeometry {
  const pos: number[] = [], colr: number[] = [], idx: number[] = [];
  const C = new THREE.Color(hex);
  const rings = [0, 0.12, 0.35, 0.65, 1];
  for (const dir of both ? [1, -1] : [1]) {
    const base = pos.length / 3;
    for (const t of rings) {
      const r = lerp(r0, r1, t), k = gain * (1 - t) * (1 - t);
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * TAU;
        pos.push(dir * t * len, Math.cos(a) * r - drop * t * len, Math.sin(a) * r);
        colr.push(C.r * k, C.g * k, C.b * k);
      }
    }
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * seg + i, b = base + j * seg + ((i + 1) % seg);
      idx.push(a, b, a + seg, b, b + seg, a + seg);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function buildLighthouse(c: Ctx): { update(dt: number, t: number): void; setNight(n: number): void } {
  const { mats, game } = c, q = game.quality;
  const flat = new Batch(), stone = new Batch();
  const rng = new RNG(3003);
  const LX = LIGHTHOUSE.x, LZ = LIGHTHOUSE.z, LR = LIGHTHOUSE.r;
  const HWB = (BREAKWATER.z1 - BREAKWATER.z0) / 2;
  const F = frame(BREAKWATER.x0, (BREAKWATER.z0 + BREAKWATER.z1) / 2, Math.PI / 2); // a = east, s = south
  const by = (a: number): number => DECK_Y * clamp(a / 12, 0, 1);
  const grey = (): number => rng.range(0.78, 1.06);
  const T = 4; // TILE_M.cobble

  // A footpath of setts from Keel Row to the foot of the causeway.
  slab(stone, F, -54, 0, -4, 4, 0, 0.03, 0, 0.03, 0xd6cfbf, 1, 1, [-1, -13.5, 1, 0]);

  // The causeway: setts on top, rubble flanks that fall away into the water.
  const END = LX - LR + 3 - BREAKWATER.x0;
  const st: number[] = [0, 12];
  for (let k = 1; k <= 20; k++) st.push(12 + ((END - 12) * k) / 20);
  const out = st.map(() => [HWB + 3.5 + rng.range(-1, 2), HWB + 3.5 + rng.range(-1, 2)]);
  for (let i = 0; i < st.length - 1; i++) {
    const a0 = st[i], a1 = st[i + 1], y0 = by(a0), y1 = by(a1);
    slab(stone, F, a0, a1, -HWB, HWB, 0, y0, 0, y1, 0xe2dccd, 1, 1, [-HWB / T, a0 / T, HWB / T, a1 / T]);
    flat.quad(fx(F, a0, HWB), y0, fz(F, a0, HWB), fx(F, a0, out[i][0]), -4, fz(F, a0, out[i][0]),
      fx(F, a1, out[i + 1][0]), -4, fz(F, a1, out[i + 1][0]), fx(F, a1, HWB), y1, fz(F, a1, HWB), STONE, 0, 0, 1, 1, grey());
    flat.quad(fx(F, a1, -HWB), y1, fz(F, a1, -HWB), fx(F, a1, -out[i + 1][1]), -4, fz(F, a1, -out[i + 1][1]),
      fx(F, a0, -out[i][1]), -4, fz(F, a0, -out[i][1]), fx(F, a0, -HWB), y0, fz(F, a0, -HWB), STONE, 0, 0, 1, 1, grey());
  }
  // Armor stone. Tops stay near deck height so the edge reads as rough, not as a wall.
  const rock = (x: number, z: number, t: number): void => {
    const sy = rng.range(1, 2.2), top = lerp(0.6, -0.5, t) + rng.range(-0.25, 0.2);
    flat.box(x, top - sy, z, rng.range(1.4, 3.2), sy, rng.range(1.4, 3.2), STONE, rng.range(0, Math.PI), 5, grey());
  };
  for (let k = Math.round(190 * q.density); k > 0; k--) {
    const a = rng.range(44, END), t = rng.next(), s = rng.sign() * (HWB + 0.7 + t * 4);
    rock(fx(F, a, s), fz(F, a, s), t);
  }

  // The round platform under the tower.
  const SEG = 32, rim = Array.from({ length: SEG }, () => LR + 4 + rng.range(-1, 2));
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * TAU, a1 = ((i + 1) / SEG) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1), o0 = rim[i], o1 = rim[(i + 1) % SEG];
    stone.tri(LX, DECK_Y, LZ, LX + c1 * LR, DECK_Y, LZ + s1 * LR, LX + c0 * LR, DECK_Y, LZ + s0 * LR, 0xe2dccd);
    // Batch.tri has no say over UVs; give the last three vertices world-space ones so the setts tile.
    stone.uv.length -= 6;
    stone.uv.push(LX / T, LZ / T, (LX + c1 * LR) / T, (LZ + s1 * LR) / T, (LX + c0 * LR) / T, (LZ + s0 * LR) / T);
    flat.quad(LX + c1 * o1, -4, LZ + s1 * o1, LX + c0 * o0, -4, LZ + s0 * o0, LX + c0 * LR, DECK_Y, LZ + s0 * LR, LX + c1 * LR, DECK_Y, LZ + s1 * LR, STONE, 0, 0, 1, 1, grey());
  }
  for (let k = Math.round(60 * q.density); k > 0; k--) {
    const a = rng.range(0, TAU), t = rng.next(), r = LR + 0.8 + t * 4;
    if (Math.cos(a) < -0.9) continue; // not across the causeway
    rock(LX + Math.cos(a) * r, LZ + Math.sin(a) * r, t);
  }

  // The tower.
  flat.cyl(LX, DECK_Y, LZ, 6.4, 6, 1.8, 0xb9b2a2, 18, true);
  const Y0 = DECK_Y + 1.8, TH = 29, BANDS = 6, GY = Y0 + TH;
  const rAt = (y: number): number => lerp(5, 3.1, (y - Y0) / TH);
  for (let k = 0; k < BANDS; k++) {
    const y = Y0 + (k * TH) / BANDS;
    flat.cyl(LX, y, LZ, rAt(y), rAt(y + TH / BANDS), TH / BANDS, k % 2 ? BONE : VERM, 18, false);
  }
  flat.cyl(LX, GY - 0.9, LZ, rAt(GY - 0.9) + 0.05, 4.5, 0.9, BONE, 18, false);
  flat.cyl(LX, GY, LZ, 4.6, 4.6, 0.35, INK, 18, true);
  for (let i = 0; i < 18; i++) {
    const a0 = (i / 18) * TAU, a1 = ((i + 1) / 18) * TAU, r = 4.4, y = GY + 1.4;
    flat.box(LX + Math.cos(a0) * r, GY + 0.35, LZ + Math.sin(a0) * r, 0.08, 1.05, 0.08, INK, 0, 4);
    beam(flat, LX + Math.cos(a0) * r, y, LZ + Math.sin(a0) * r, LX + Math.cos(a1) * r, y, LZ + Math.sin(a1) * r, 0.09, 0.09, INK);
  }
  flat.cyl(LX, GY + 0.35, LZ, 2.5, 2.5, 0.9, BONE, 12, false);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    flat.box(LX + Math.cos(a) * 2.36, GY + 1.25, LZ + Math.sin(a) * 2.36, 0.13, 3, 0.13, INK, -a, 4);
  }
  flat.cyl(LX, GY + 4.25, LZ, 2.7, 2.7, 0.25, INK, 12, true);
  flat.cyl(LX, GY + 4.5, LZ, 3.1, 0.25, 2.4, VERM, 12, false);
  flat.cyl(LX, GY + 6.9, LZ, 0.14, 0.14, 1.2, INK, 6, true);
  flat.box(LX, GY + 8, LZ, 0.5, 0.5, 0.5, MUST);
  // Porch and door toward the causeway, and a few windows up the stair.
  flat.box(LX - 5.7, DECK_Y, LZ, 2.6, 3.4, 2.8, BONE);
  flat.box(LX - 5.8, DECK_Y + 3.4, LZ, 3.1, 0.3, 3.3, VERM);
  vquad(flat, LX - 7.03, DECK_Y + 1.35, LZ, 1.4, 2.5, -Math.PI / 2, GLASS);
  const win = (y: number, f: number): void => {
    const r = rAt(y - 0.75) + 0.05, sn = Math.sin(f), cs = Math.cos(f);
    vquad(flat, LX + sn * r, y, LZ + cs * r, 0.9, 1.5, f, GLASS);
    flat.box(LX + sn * (r + 0.05), y - 0.95, LZ + cs * (r + 0.05), 1.2, 0.16, 0.3, INK, f);
  };
  win(9.5, -Math.PI / 2); win(16.5, 0); win(16.5, Math.PI); win(23.5, -Math.PI / 2); win(23.5, Math.PI / 2);
  game.col.addBoxC(LX, LZ, 9, 9, GY + 8, 0);
  game.col.addBoxC(LX - 5.7, LZ, 2.6, 2.8, 4, 0);

  // The name plate beside the way in.
  for (const z of [F.z - HWB - 3.6, F.z - HWB - 0.6]) flat.box(BREAKWATER.x0 + 5, 0, z, 0.2, 4.2, 0.2, INK, 0, 4);
  board(c, flat, BREAKWATER.x0 + 4.85, 3.4, F.z - HWB - 2.1, 6, 1.5, -Math.PI / 2, 'last-light');

  mesh(stone, mats.cobble, c.parent, false, 'breakwater-top');
  mesh(flat, mats.flat, c.parent, c.cast, 'lighthouse');

  // The lamp room is its own mesh so it can be lit from inside at night.
  const LY = GY + 2.75;
  const lb = new Batch();
  lb.cyl(LX, GY + 1.25, LZ, 2.3, 2.3, 3, 0xffffff, 12, false);
  const lampMat = new THREE.MeshLambertMaterial({ color: 0xc9dcd6, emissive: 0xffd98a, emissiveIntensity: 0 });
  mesh(lb, lampMat, c.parent, false, 'lighthouse-lamp');
  halo(c.glow, LX, LY, LZ, 18, 0xfff0c0);

  // Not fogged: a beam that fades with distance on its own and then again in fog simply vanishes.
  const beamMat = new THREE.MeshBasicMaterial({
    vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, fog: false, opacity: 0,
  });
  const beams = new THREE.Mesh(coneGeometry(320, 1, 13, 10, 0xfff0c0, 0.5, 0.012, true), beamMat);
  beams.name = 'lighthouse-beams';
  beams.position.set(LX, LY, LZ);
  beams.visible = false;
  c.parent.add(beams);

  // The visitor. Self-lit, so it shows against a 3 AM sky without help from the moon.
  const ub = new Batch();
  ub.cyl(0, -0.95, 0, 1.4, 5.2, 0.95, 0xb8c4c0, 20, false, 0.5);
  ub.cyl(0, 0, 0, 5.2, 5.2, 0.22, 0x8e9a98, 20, false, 0.75);
  ub.cyl(0, 0.22, 0, 5.2, 2.3, 0.75, 0xcfd8d4, 20, false, 1);
  ub.cyl(0, 0.97, 0, 2.3, 1.9, 0.6, 0x9fe0d0, 14, false, 0.9);
  ub.cyl(0, 1.57, 0, 1.9, 0.8, 0.5, 0xbff0e2, 14, true, 1);
  ub.cyl(0, 2.07, 0, 0.05, 0.05, 0.9, 0xcfd8d4, 4, false);
  ub.box(0, 2.9, 0, 0.22, 0.22, 0.22, 0xff7a4a);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    ub.box(Math.cos(a) * 4.3, -0.42, Math.sin(a) * 4.3, 0.55, 0.22, 0.55, i % 2 ? 0xffd36b : 0xff7a4a, -a);
  }
  const ufo = new THREE.Group();
  ufo.name = 'ufo';
  ufo.visible = false;
  mesh(ub, new THREE.MeshBasicMaterial({ vertexColors: true }), ufo, false, 'saucer');
  const ray = new THREE.Mesh(coneGeometry(11.5, 1.1, 4.4, 14, 0xc8ffe0, 0.42, 0, false), beamMat);
  ray.rotation.z = -Math.PI / 2; // the cone is built along +x; this points it at the lamp room
  ray.position.y = -0.8;
  ufo.add(ray);
  c.parent.add(ufo);
  const UY = GY + 21;

  let night = 0;
  return {
    update(dt, t) {
      if (beams.visible) beams.rotation.y = (beams.rotation.y + dt * 0.24) % TAU;
      const sky = game.sky, hr = sky ? sky.hour : 12;
      const here = hr >= 3 && hr < 3 + 25 / 60;
      ufo.visible = here;
      if (here) {
        ufo.position.set(LX + Math.sin(t * 0.31) * 1.6, UY + Math.sin(t * 1.1) * 0.7, LZ + Math.cos(t * 0.23) * 1.6);
        ufo.rotation.set(Math.sin(t * 1.7) * 0.09, t * 0.8, Math.cos(t * 1.3) * 0.09);
      }
    },
    setNight(n) {
      night = n;
      lampMat.emissiveIntensity = smooth(n * 1.4) * 1.2;
      beamMat.opacity = night;
      beams.visible = n > 0.03;
    },
  };
}

// ── The Perpetual Bridge ─────────────────────────────────────────────────────

function buildBridge(c: Ctx): void {
  const { mats, game } = c, col = game.col;
  const flat = new Batch(), deck = new Batch();
  const F = frame(BRIDGE.x, BRIDGE.z0, Math.PI); // a = north, s = east
  const L = BRIDGE.z0 - BRIDGE.z1, HW = BRIDGE.hw, SEG = 5, n = Math.round(L / SEG);
  const dy = (a: number): number => BRIDGE.top * smooth(a / (L - 20));
  const V = 12; // TILE_M.avenue

  // Gull Heights Rd stops at z0 + 9; carry the avenue across the gap.
  slab(deck, F, -9, 0, -HW, HW, 0, 0, 0, 0, 0xffffff, 1, 1, [0, -9 / V, 1, 0]);

  for (let i = 0; i < n; i++) {
    const a0 = i * SEG, a1 = a0 + SEG, y0 = dy(a0), y1 = dy(a1), last = i === n - 1;
    slab(deck, F, a0, a1, -HW, HW, 0, y0, 0, y1, 0xffffff, 1, 1, [0, a0 / V, 1, a1 / V]);
    slab(flat, F, a0, a1, -HW, HW, y0 - 0.9, y0 - 0.02, y1 - 0.9, y1 - 0.02, CONCRETE, 2 | 4 | (last ? 16 : 0));
    if (i % 2 === 0) slab(flat, F, a0, a0 + 0.5, -9.6, 9.6, y0 - 2, y0 - 0.9, y0 - 2, y0 - 0.9, DEEP_TEAL, 2 | 8 | 16);
    for (const sg of [-1, 1]) {
      const s0 = sg > 0 ? HW - 0.6 : -HW, s1 = s0 + 0.6, sr = sg * (HW - 0.3);
      slab(flat, F, a0, a1, s0, s1, y0, y0 + 0.9, y1, y1 + 0.9, CONCRETE, 1 | 4 | (i === 0 ? 8 : 0) | (last ? 16 : 0));
      beam(flat, fx(F, a0, sr), y0 + 1.25, fz(F, a0, sr), fx(F, a1, sr), y1 + 1.25, fz(F, a1, sr), 0.12, 0.12, DEEP_TEAL);
      flat.box(fx(F, a0, sr), y0 + 0.9, fz(F, a0, sr), 0.1, 0.35, 0.1, DEEP_TEAL, 0, 4);
      slab(flat, F, a0, a1 + (last ? 2.2 : 0), sg * 6.7 - 0.5, sg * 6.7 + 0.5, y0 - 2.6, y0 - 0.9, y1 - 2.6, y1 - 0.9, DEEP_TEAL, 2 | 4 | (last ? 16 : 0));
      // Stepped walls for the physics: each one as tall as its own five meters of deck.
      col.addBox(fx(F, a0, s0), fz(F, a0, 0), fx(F, a0, s1), fz(F, a1, 0), Math.max(y0, y1) + 1.3, -10);
    }
  }

  // Towers, with the main cables draped over them.
  const T1 = 95, T2 = 245, TOP1 = 44, TOP2 = 52, A0 = 2, A3 = L - 2, CS = HW + 2;
  const cableY = (a: number): number => {
    if (a <= T1) { const t = (a - A0) / (T1 - A0); return lerp(dy(A0) + 1.4, TOP1, t) - 20 * t * (1 - t); }
    if (a <= T2) { const t = (a - T1) / (T2 - T1); return lerp(TOP1, TOP2, t) - 132 * t * (1 - t); }
    const t = (a - T2) / (A3 - T2);
    return lerp(TOP2, dy(A3) + 1.4, t) - 24 * t * (1 - t);
  };
  const tower = (a: number, top: number): void => {
    const z = fz(F, a, 0), d = dy(a), x = F.x;
    for (const sg of [-1, 1]) {
      const lx = fx(F, a, sg * CS);
      flat.box(lx, -9, z, 3.6, d + 7.8, 4.8, CONCRETE, 0, 5);
      flat.box(lx, d - 1.2, z, 2.8, top - 9 - (d - 1.2), 3.6, DEEP_TEAL, 0, 5);
      flat.box(lx, top - 9, z, 2.3, 9, 3, DEEP_TEAL, 0, 5);
      flat.box(lx, top, z, 2.9, 0.7, 3.6, VERM);
      flat.box(lx, top + 0.7, z, 0.5, 2.2, 0.5, MUST);
      col.addBoxC(lx, z, 3.6, 4.8, top, -9);
      halo(c.glow, lx, top + 3.2, z, 5, 0xff4a2a);
    }
    flat.box(x, d - 4.4, z, 24, 1.8, 3, CONCRETE, 0, 7);
    flat.box(x, d + 8.5, z, CS * 2 - 2.6, 1.6, 2.4, DEEP_TEAL, 0, 7);
    flat.box(x, top - 4, z, CS * 2 - 2.2, 2, 2.2, DEEP_TEAL, 0, 7);
    const xb = CS - 1.3;
    beam(flat, x - xb, d + 10.1, z, x + xb, top - 4, z, 0.5, 0.5, BONE);
    beam(flat, x + xb, d + 10.1, z, x - xb, top - 4, z, 0.5, 0.5, BONE);
  };
  tower(T1, TOP1); tower(T2, TOP2);
  const stations: number[] = [A0];
  for (let a = SEG; a < A3; a += SEG) stations.push(a);
  stations.push(A3);
  for (const sg of [-1, 1]) {
    const s = sg * CS;
    for (let i = 0; i < stations.length - 1; i++) {
      const a0 = stations[i], a1 = stations[i + 1];
      beam(flat, fx(F, a0, s), cableY(a0), fz(F, a0, s), fx(F, a1, s), cableY(a1), fz(F, a1, s), 0.55, 0.55, BONE);
    }
    for (let a = 10; a < A3; a += 10) {
      const top = cableY(a), bot = dy(a) + 0.3;
      if (top - bot < 3 || Math.abs(a - T1) < 4 || Math.abs(a - T2) < 4) continue;
      beam(flat, fx(F, a, s), top, fz(F, a, s), fx(F, a, sg * (HW + 0.15)), bot, fz(F, a, 0), 0.17, 0.17, BONE);
      flat.box(fx(F, a, sg * (HW + 0.15)), bot - 0.5, fz(F, a, 0), 0.5, 0.6, 0.6, DEEP_TEAL);
    }
    // Past the last hanger the cable has nothing left to hold, and hangs.
    const ex = fx(F, 0, s), ye = cableY(A3);
    beam(flat, ex, ye, fz(F, A3, 0), ex, ye - 1.6, fz(F, L + 1.5, 0), 0.5, 0.5, BONE);
    beam(flat, ex, ye - 1.6, fz(F, L + 1.5, 0), ex, ye - 6.5, fz(F, L + 2.6, 0), 0.42, 0.42, BONE);
    beam(flat, ex, ye - 6.5, fz(F, L + 2.6, 0), ex + sg * 0.4, ye - 11, fz(F, L + 2.9, 0), 0.34, 0.34, BONE, true);
    // Anchorage on the shore.
    flat.box(ex, -1, fz(F, 2, 0), 3.2, 3.8, 10, CONCRETE);
    col.addBoxC(ex, fz(F, 2, 0), 3.2, 10, 2.8, -1);
  }
  // Trestles: one where the land gives out, one that the last span was supposed to lean on.
  for (const a of [48, 292]) {
    const z = fz(F, a, 0), d = dy(a);
    for (const sg of [-1, 1]) flat.box(fx(F, a, sg * 6.7), -9, z, 2.2, d + 5.6, 2.2, CONCRETE, 0, 4);
    flat.box(F.x, d - 3.4, z, 17, 0.8, 2.6, CONCRETE, 0, 7);
  }

  // The end. Rebar reaching for a far shore that was never poured.
  const rng = new RNG(1987);
  const yL = dy(L);
  for (let k = 0; k < 18; k++) {
    const s = rng.range(-9.6, 9.6), y = yL - rng.range(0.15, 0.78), l1 = rng.range(0.8, 2.3), bend = rng.range(-0.5, 0.5), droop = rng.range(0.05, 0.5);
    const x1 = fx(F, L + l1, s + bend), z1 = fz(F, L + l1, 0), l2 = rng.range(0.5, 1.7);
    beam(flat, fx(F, L, s), y, fz(F, L, 0), x1, y - droop, z1, 0.09, 0.09, RUST);
    beam(flat, x1, y - droop, z1, fx(F, 0, s + bend * 2.2), y - droop - l2, fz(F, L + l1 + l2 * 0.4, 0), 0.09, 0.09, RUST, true);
  }
  for (let k = 0; k < 7; k++) {
    const s = rng.range(-9, 9);
    flat.box(fx(F, 0, s), yL - rng.range(1, 1.9), fz(F, L + rng.range(0.3, 1.1), 0), rng.range(0.8, 2.2), rng.range(0.4, 0.9), rng.range(0.6, 1.4), 0xb3ab99, rng.range(0, 3), 7, rng.range(0.8, 1));
  }

  // Lamps on alternate sides, growing out of the barrier.
  for (let a = 30, k = 0; a < L - 10; a += 30, k++) {
    if (Math.abs(a - T1) < 6 || Math.abs(a - T2) < 6) continue;
    const sg = k % 2 ? 1 : -1, x = fx(F, a, sg * (HW - 0.3)), z = fz(F, a, 0), y = dy(a) + 0.9, lx = x - sg * 1.6;
    flat.box(x, y, z, 0.16, 5.4, 0.16, INK, 0, 4);
    beam(flat, x, y + 5.3, z, lx, y + 5.6, z, 0.1, 0.1, INK);
    flat.box(lx, y + 5.15, z, 0.4, 0.4, 0.4, 0xfff1c9);
    halo(c.glow, lx, y + 5.3, z, 3, SODIUM);
  }

  // Three warnings, in case the first two are not enough.
  const zs = fz(F, -6, 0), xs = fx(F, 0, HW + 3);
  for (const o of [-1.7, 1.7]) flat.box(xs + o, 0, zs, 0.18, 3.4, 0.18, INK, 0, 4);
  board(c, flat, xs, 3.3, zs + 0.1, 4.4, 2.2, 0, 'bridge-out');
  board(c, flat, F.x, dy(T2) + 12.4, fz(F, T2, 0) + 1.3, 9, 4.5, 0, 'bridge-out');
  const ze = fz(F, L - 22, 0), xe = fx(F, 0, HW - 0.3);
  flat.box(xe, dy(L - 22) + 0.9, ze, 0.16, 2.6, 0.16, INK, 0, 4);
  board(c, flat, xe, dy(L - 22) + 3.4, ze + 0.1, 3.2, 1.6, 0, 'bridge-out');

  mesh(deck, mats.avenue, c.parent, false, 'bridge-deck');
  mesh(flat, mats.flat, c.parent, c.cast, 'bridge');
}

// ── Stunt ramps ──────────────────────────────────────────────────────────────

function buildRamps(c: Ctx): void {
  const top = new Batch(), side = new Batch();
  for (const r of RAMPS) {
    const F = frame(r.x, r.z, r.h), hw = r.width / 2;
    // Two strips, because one ramp straddles a curb: each half sits on whatever groundAt() says is under it.
    for (const [s0, s1] of [[-hw, 0], [0, hw]]) {
      const sm = (s0 + s1) / 2;
      const base = groundAt(fx(F, r.len / 2, sm), fz(F, r.len / 2, sm)) - r.height / 2;
      slab(top, F, 0, r.len, s0, s1, 0, base, 0, base + r.height, 0xffffff, 1, 1, [s0 / 2, 0, s1 / 2, r.len / 2]);
      slab(side, F, 0, r.len, s0, s1, base - 0.04, base, base - 0.04, base + r.height, INK, 4 | 16);
      // A raised vermilion kerb just outside the driven width: thickness for the eye, nothing for the wheels.
      const k0 = s0 < 0 ? s0 - 0.3 : s1, k1 = k0 + 0.3;
      slab(side, F, 0, r.len, k0, k1, base - 0.04, base + 0.14, base - 0.04, base + r.height + 0.14, VERM, 1 | 4 | 8 | 16);
      slab(side, F, r.len, r.len + 0.06, s0, s1, base + r.height - 0.5, base + r.height - 0.1, base + r.height - 0.5, base + r.height - 0.1, MUST, 16);
    }
  }
  mesh(top, c.mats.ramp, c.parent, false, 'ramps');
  mesh(side, c.mats.flat, c.parent, c.cast, 'ramp-sides');
}

// ── The duck ─────────────────────────────────────────────────────────────────

const DUCK_LINES = [
  'HONK.',
  'The duck has filed a complaint.',
  'HONK. (It meant that.)',
  'The duck is not a vessel. The duck is, however, annoyed.',
  'The duck regards you with one enormous painted eye.',
  'HONK. Form 404-D has been updated to include you by name.',
  'The duck was here first.',
];

/** Smooth ellipsoids with per-vertex colour: the one thing in the city that is not made of boxes. */
class Blob {
  pos: number[] = []; nor: number[] = []; col: number[] = []; idx: number[] = [];
  private c = new THREE.Color();
  ball(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, hex: number, pitch = 0, seg = 20, rings = 12): void {
    const base = this.pos.length / 3, ct = Math.cos(pitch), st = Math.sin(pitch), C = this.c.setHex(hex);
    for (let j = 0; j <= rings; j++) {
      const v = (j / rings) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
      for (let i = 0; i <= seg; i++) {
        const u = (i / seg) * TAU, ux = sv * Math.cos(u), uz = sv * Math.sin(u);
        const py = cv * ry, pz = uz * rz, ny = cv / ry, nz = uz / rz, nx = ux / rx;
        const ny2 = ny * ct - nz * st, nz2 = ny * st + nz * ct, nl = Math.hypot(nx, ny2, nz2);
        this.pos.push(cx + ux * rx, cy + py * ct - pz * st, cz + py * st + pz * ct);
        this.nor.push(nx / nl, ny2 / nl, nz2 / nl);
        this.col.push(C.r, C.g, C.b);
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, b = a + seg + 1;
      this.idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function buildDuck(c: Ctx): (dt: number, t: number) => void {
  const { game } = c;
  const DX = 6, DZ = 712;
  const b = new Blob(), yel = 0xf6ae0a;
  b.ball(0, 1.9, 0, 3.6, 2.9, 4.8, yel);                      // body
  b.ball(0, 3.4, 2.6, 2.6, 1.9, 2.2, yel);                    // chest, so the neck is not a ball on a ball
  b.ball(0, 6, 2.5, 2.35, 2.3, 2.35, yel);                    // head
  b.ball(0, 4.1, -4.2, 1.5, 1.1, 2.3, yel, -0.75);            // tail, cocked up
  for (const sx of [-1, 1]) {
    b.ball(sx * 3.25, 2.7, -0.4, 0.75, 1.7, 2.9, 0xe89c06, 0.12);   // wings
    b.ball(sx * 1.25, 6.75, 4.2, 0.4, 0.46, 0.36, INK, 0, 12, 8);   // eyes
    b.ball(sx * 1.3, 6.95, 4.5, 0.13, 0.13, 0.1, 0xffffff, 0, 8, 6);
  }
  b.ball(0, 5.55, 4.9, 1.35, 0.42, 1.5, VERM, 0.1);           // bill
  b.ball(0, 5.2, 4.7, 1.1, 0.3, 1.2, 0xc94a26, 0.1);
  // Phong, alone in a Lambert city: the duck is meant to look like wet vinyl.
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 70, specular: 0x777766 });
  const duck = new THREE.Mesh(b.toGeometry(), mat);
  duck.castShadow = c.cast;
  const spin = new THREE.Group(), rock = new THREE.Group();
  spin.add(duck); rock.add(spin);
  rock.name = 'duck';
  rock.position.set(DX, WATER_Y, DZ);
  spin.rotation.y = 2.6;
  c.parent.add(rock);
  // It turns, so the wall around it is a square that fits the duck at any heading.
  game.col.addBoxC(DX, DZ, 8.5, 8.5, 8.5, -4);

  let cool = 0, touching = false, amp = 0, vel = 0, px = 0, pz = 1;
  return (dt, t) => {
    cool -= dt;
    let hit = false, hx = 0, hz = 0;
    const pl = game.player;
    if (pl && pl.y < 9) {
      const dx = pl.x - DX, dz = pl.z - DZ;
      if (dx * dx + dz * dz < 49) { hit = true; hx = dx; hz = dz; }
    }
    const list = game.vehicles ? game.vehicles.list : null;
    if (!hit && list) for (let i = 0; i < list.length; i++) {
      const v = list[i], dx = v.x - DX;
      if (dx > 8.5 || dx < -8.5) continue;
      const dz = v.z - DZ;
      if (dx * dx + dz * dz < 72 && v.y < 9) { hit = true; hx = dx; hz = dz; break; }
    }
    // Only the moment of contact counts: leaning on the duck does not make it honk forever.
    if (hit && !touching && cool <= 0) {
      cool = 3;
      const l = Math.hypot(hx, hz) || 1;
      px = -hx / l; pz = -hz / l;
      vel += 1.5;
      game.emit('duck', { x: DX, z: DZ });
      game.hud.toast(pickRand(DUCK_LINES), 3.5);
    }
    touching = hit;
    vel += (-16 * amp - 1.1 * vel) * dt;
    amp += vel * dt;
    spin.rotation.y += dt * 0.06;
    rock.position.y = WATER_Y + Math.sin(t * 0.9) * 0.22;
    rock.rotation.x = Math.sin(t * 0.53 + 1) * 0.025 + amp * pz;
    rock.rotation.z = Math.sin(t * 0.7) * 0.03 - amp * px;
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildLandmarks(game: Game, mats: CityMaterials, parent: THREE.Group): WorldPart {
  const group = new THREE.Group();
  group.name = 'landmarks';
  parent.add(group);
  const c: Ctx = { game, mats, parent: group, signs: new Batch(), glow: new Batch(), cast: game.quality.shadows };

  const wheel = buildPier(c);
  const gerald = new Gerald(game, c);
  const light = buildLighthouse(c);
  buildBridge(c);
  buildRamps(c);
  const duck = buildDuck(c);
  mesh(c.signs, mats.sign, group, false, 'landmark-signs');
  mesh(c.glow, mats.glow, group, false, 'landmark-glow');

  let t = 0;
  return {
    update(dt) {
      t += dt;
      wheel(dt, t);
      gerald.update(dt, t);
      light.update(dt, t);
      duck(dt, t);
    },
    setNight(n) { light.setNight(n); },
  };
}
