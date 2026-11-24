// The places between the landmarks: Mercy Park's features, Flounder Field, the
// billboards, Low Tide Beach and the working harbor at Dock Seven.
//
// Everything static is merged per place and per material (not per map chunk:
// these are a handful of far-apart sites, and one mesh per site culls just as
// well for a fraction of the draw calls). Only the moored boats and the buoys
// move, as two instanced meshes.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials } from './materials';
import type { AtlasRect, SignAtlas } from './textures';
import { CONTAINER_UV, FENCE_UV, TILE_M } from './textures';
import { Batch } from './batch';
import type { Colliders } from './collide';
import { CURB, SIDEWALK, WATER_Y, ZS, groundAt, islandSD } from './plan';
import { plantExtra } from './floraAssets';
import { RNG, TAU, lerp } from '../core/util';
import { flip, sendRange } from '../core/flip';

const INK = 0x14213d, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, TEAL = 0x2a9d8f;
const BRICK = 0x9c4a3c, TERRA = 0xc96f4a, SAGE = 0x8a9a6b;
const STEEL = 0x47525e, STONE = 0xcfc6b0, CONCRETE = 0xb9b3a4, TIMBER = 0x8a5a3c;
/** Sodium light as a vertex colour for the additive glow sprite. */
const SODIUM = 0xc98a36, FLOOD = 0xbfb596;

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Quad whose winding is fixed up so its front faces along (ox, oy, oz): saves reasoning about order for every odd-angled face. */
function oq(
  b: Batch, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
  ox: number, oy: number, oz: number, hex: number, shade = 1,
): void {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  if (nx * ox + ny * oy + nz * oz >= 0) b.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, hex, 0, 0, 1, 1, shade);
  else b.quad(ax, ay, az, dx, dy, dz, cx, cy, cz, bx, by, bz, hex, 0, 0, 1, 1, shade);
}

function otri(
  b: Batch, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, ox: number, oy: number, oz: number, hex: number, shade = 1,
): void {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  if (nx * ox + ny * oy + nz * oz >= 0) b.tri(ax, ay, az, bx, by, bz, cx, cy, cz, hex, shade);
  else b.tri(ax, ay, az, cx, cy, cz, bx, by, bz, hex, shade);
}

/** Square-section member between two points at any angle: braces, stays, booms. Ends are left open (they are always buried). */
function beam(b: Batch, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, hex: number, shade = 1): void {
  let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  // u = d x ref, v = d x u
  const rx = Math.abs(dy) > 0.9 ? 1 : 0, ry = Math.abs(dy) > 0.9 ? 0 : 1;
  let ux = dy * 0 - dz * ry, uy = dz * rx - dx * 0, uz = dx * ry - dy * rx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const h = t / 2;
  for (let k = 0; k < 4; k++) {
    // Face normal n and the in-face direction w for each of the four sides.
    const sgn = k < 2 ? 1 : -1, useU = k % 2 === 0;
    const nx = (useU ? ux : vx) * sgn, ny = (useU ? uy : vy) * sgn, nz = (useU ? uz : vz) * sgn;
    const wx = useU ? vx : ux, wy = useU ? vy : uy, wz = useU ? vz : uz;
    const px = nx * h, py = ny * h, pz = nz * h, qx = wx * h, qy = wy * h, qz = wz * h;
    oq(b,
      x0 + px - qx, y0 + py - qy, z0 + pz - qz, x0 + px + qx, y0 + py + qy, z0 + pz + qz,
      x1 + px + qx, y1 + py + qy, z1 + pz + qz, x1 + px - qx, y1 + py - qy, z1 + pz - qz,
      nx, ny, nz, hex, shade * (ny > 0.5 ? 1 : ny < -0.5 ? 0.7 : 0.88));
  }
}

/** One segment of an elliptical ring lying flat or sloping: inner edge (a0, b0) at y0, outer edge (a1, b1) at y1. Faces up. */
function ringUp(b: Batch, cx: number, cz: number, a0: number, b0: number, y0: number, a1: number, b1: number, y1: number, t0: number, t1: number, hex: number, shade = 1): void {
  const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
  oq(b, cx + a0 * c1, y0, cz + b0 * s1, cx + a1 * c1, y1, cz + b1 * s1, cx + a1 * c0, y1, cz + b1 * s0, cx + a0 * c0, y0, cz + b0 * s0, 0, 1, 0, hex, shade);
}

/** One segment of an elliptical wall. dir = +1 faces outward, -1 inward. */
function ringWall(b: Batch, cx: number, cz: number, a: number, bb: number, y0: number, y1: number, t0: number, t1: number, dir: number, hex: number, shade = 1): void {
  const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
  const tm = (t0 + t1) / 2;
  oq(b, cx + a * c0, y0, cz + bb * s0, cx + a * c1, y0, cz + bb * s1, cx + a * c1, y1, cz + bb * s1, cx + a * c0, y1, cz + bb * s0,
    Math.cos(tm) * dir, 0, Math.sin(tm) * dir, hex, shade);
}

/** Flat elliptical disc facing up, as a fan. */
function disc(b: Batch, cx: number, cz: number, a: number, bb: number, y: number, hex: number, seg: number, shade = 1): void {
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * TAU, t1 = ((i + 1) / seg) * TAU;
    b.tri(cx, y, cz, cx + a * Math.cos(t1), y, cz + bb * Math.sin(t1), cx + a * Math.cos(t0), y, cz + bb * Math.sin(t0), hex, shade);
  }
}

/** Upward rectangle with world-space UVs, so neighbouring pieces of paving share one continuous pattern. */
function wfloor(b: Batch, x0: number, z0: number, x1: number, z1: number, y: number, hex: number, tile: number): void {
  b.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, hex, x0 / tile, -z1 / tile, x1 / tile, -z0 / tile);
}

/** Round paving in 1 m strips (their stepped edge is hidden under whatever kerb goes round it). */
function wdisc(b: Batch, cx: number, cz: number, r: number, y: number, hex: number, tile: number): void {
  for (let x = -r; x < r; x += 1) {
    const xm = Math.min(Math.abs(x), Math.abs(x + 1)), hz = Math.sqrt(Math.max(0, r * r - xm * xm));
    wfloor(b, cx + x, cz - hz, cx + x + 1, cz + hz, y, hex, tile);
  }
}

// ── The kit every place builds with ──────────────────────────────────────────

class Kit {
  /** Plain vertex-colour geometry, one batch per place. */
  private flats = new Map<string, Batch>();
  f = new Batch();
  /** Thin things seen from both sides: canopies, umbrellas, roofs. */
  dbl = new Batch();
  sign = new Batch();
  /** Painted billboards and posters (tools/art): their own atlases, so their own batches. */
  bb = new Batch();
  pst = new Batch();
  decal = new Batch();
  marks = new Batch();
  cobble = new Batch();
  cont = new Batch();
  fence = new Batch();
  /** Lamp faces: bone by day, self-lit at night. */
  lamp = new Batch();
  glow = new Batch();
  readonly col: Colliders;
  readonly signs: SignAtlas;
  readonly density: number;

  constructor(readonly game: Game, readonly mats: CityMaterials) {
    this.col = game.col;
    this.signs = mats.tex.signs;
    this.density = game.quality.density;
  }

  place(name: string): void {
    let b = this.flats.get(name);
    if (!b) this.flats.set(name, (b = new Batch()));
    this.f = b;
  }

  /** A sign from the atlas on an upright rectangle centered on (x, z), facing heading hd. Read left to right from the front. */
  board(key: string, x: number, y0: number, z: number, w: number, h: number, hd: number): void {
    const r = this.signs.rect(key), c = Math.cos(hd), s = Math.sin(hd), hw = w / 2;
    // From the front the viewer's left is the board's local -X.
    this.sign.quad(x - hw * c, y0, z + hw * s, x + hw * c, y0, z - hw * s, x + hw * c, y0 + h, z - hw * s, x - hw * c, y0 + h, z + hw * s,
      0xffffff, r.u0, r.v0, r.u1, r.v1);
  }

  /** A board with a dark backing panel so it has a back and an edge. */
  hoarding(key: string, x: number, y0: number, z: number, w: number, h: number, hd: number): void {
    const c = Math.cos(hd), s = Math.sin(hd);
    this.f.box(x - 0.2 * s, y0 - 0.2, z - 0.2 * c, w + 0.4, h + 0.4, 0.3, INK, hd, 7);
    const art = ART_BOARDS.indexOf(key);
    if (art < 0) { this.board(key, x, y0, z, w, h, hd); return; }
    // boards.webp is 2 columns x 4 rows of 1024 x 512, row 0 at the top.
    const u0 = (art % 2) * 0.5, vt = 1 - Math.floor(art / 2) * 0.25, hw = w / 2;
    this.bb.quad(x - hw * c, y0, z + hw * s, x + hw * c, y0, z - hw * s, x + hw * c, y0 + h, z - hw * s, x - hw * c, y0 + h, z + hw * s, 0xffffff, u0 + 0.002, vt - 0.248, u0 + 0.498, vt - 0.002);
  }

  /** A poster (posters.webp: 4 columns x 2 rows of 512 x 1024) on both faces of an upright panel centered on (x, z) along heading hd. */
  poster(slot: number, x: number, y0: number, z: number, w: number, h: number, hd: number, off = 0.04): void {
    const c = Math.cos(hd), s = Math.sin(hd), hw = w / 2, u0 = (slot % 4) * 0.25, vt = 1 - Math.floor(slot / 4) * 0.5;
    for (const side of [1, -1]) {
      const nx = s * off * side, nz = c * off * side, k = side;
      // Seen from the back, the viewer's left is the board's local +X.
      this.pst.quad(x - hw * c * k + nx, y0, z + hw * s * k + nz, x + hw * c * k + nx, y0, z - hw * s * k + nz,
        x + hw * c * k + nx, y0 + h, z - hw * s * k + nz, x - hw * c * k + nx, y0 + h, z + hw * s * k + nz,
        0xffffff, u0 + 0.002, vt - 0.498, u0 + 0.248, vt - 0.002);
    }
  }

  /** Light pool on the ground. Additive, so it only shows once mats.glow fades in at dusk. */
  pool(x: number, y: number, z: number, size: number, hex: number): void {
    const h = size / 2;
    this.glow.quad(x - h, y, z + h, x + h, y, z + h, x + h, y, z - h, x - h, y, z - h, hex);
  }

  /** Upright glow facing heading hd (seen from both sides: the glow material is not culled... it is, so draw both). */
  halo(x: number, y: number, z: number, size: number, hd: number, hex: number): void {
    const c = Math.cos(hd) * size / 2, s = Math.sin(hd) * size / 2, h = size / 2;
    this.glow.quad(x - c, y - h, z + s, x + c, y - h, z - s, x + c, y + h, z - s, x - c, y + h, z + s, hex);
    this.glow.quad(x + c, y - h, z - s, x - c, y - h, z + s, x - c, y + h, z + s, x + c, y + h, z - s, hex);
  }

  /** A lamp post with one or two heads along heading hd, a light pool and a collision circle. */
  lampPost(x: number, z: number, h: number, hd: number, twin: boolean, reach = 1.2): void {
    const g = groundAt(x, z), f = this.f;
    f.cyl(x, g, z, 0.16, 0.1, h, INK, 6, false);
    const c = Math.cos(hd), s = Math.sin(hd);
    for (const side of twin ? [-1, 1] : [1]) {
      const lx = x + s * reach * side, lz = z + c * reach * side;
      beam(f, x, g + h - 0.1, z, lx, g + h + 0.15, lz, 0.12, INK);
      f.box(lx, g + h + 0.1, lz, 0.5, 0.16, 0.9, INK, hd, 5);
      this.lamp.box(lx, g + h + 0.02, lz, 0.4, 0.08, 0.8, BONE, hd, 6);
      this.halo(lx, g + h, lz, 1.8, hd, SODIUM);
      this.halo(lx, g + h, lz, 1.8, hd + Math.PI / 2, SODIUM);
    }
    this.pool(x, g + 0.09, z, h * 2.6, SODIUM);
    this.col.addProp(x, z, 0.25, h, 'lamp', false);
  }

  build(parent: THREE.Object3D, lampMat: THREE.Material): void {
    const m = this.mats;
    const add = (b: Batch, mat: THREE.Material, cast: boolean, order = 0): void => {
      if (b.empty) return;
      const mesh = new THREE.Mesh(b.toGeometry(), mat);
      mesh.castShadow = cast; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = order;
      parent.add(mesh);
    };
    for (const b of this.flats.values()) add(b, m.flat, true);
    add(this.dbl, m.flatDouble, true);
    add(this.cobble, m.cobble, false);
    add(this.cont, m.container, true);
    add(this.fence, m.fence, false);
    add(this.decal, m.decal, false);
    add(this.marks, m.marks, false);
    add(this.sign, m.sign, false);
    add(this.bb, m.boards, false);
    add(this.pst, m.posters, false);
    add(this.lamp, lampMat, false);
    add(this.glow, m.glow, false, 2);
  }
}

const blockRect = (game: Game, i: number, j: number) => game.plan.blocks[i * (ZS.length - 1) + j].rect;
const placeSign = (K: Kit, word: RegExp, fallback: string): string => K.signs.places.find((n) => word.test(n)) ?? fallback;

// ── Mercy Park ───────────────────────────────────────────────────────────────

const POND = { x: 186, z: -152, a: 26, b: 18 };
const PROM_Z = -120, PROM_HW = 2.5;

function buildPark(K: Kit): void {
  K.place('park');
  const f = K.f, rng = new RNG(4107);
  const r0 = blockRect(K.game, 6, 2), r1 = blockRect(K.game, 7, 3);
  const x0 = r0.x0, x1 = r1.x1, Y = CURB;
  // Paving sits a few centimeters proud of the lawn slab: it is a different mesh from another builder, and coplanar would flicker.
  const PY = Y + 0.04;
  const stoneTint = 0xe6dcc4;

  // Promenade, with a low stone edging either side.
  wfloor(K.cobble, x0, PROM_Z - PROM_HW, x1, PROM_Z + PROM_HW, PY, stoneTint, TILE_M.cobble);
  for (const s of [-1, 1]) f.box((x0 + x1) / 2, Y, PROM_Z + s * (PROM_HW + 0.15), x1 - x0, 0.1, 0.3, STONE, 0, 5);

  // Pond: a formal basin. The lawn is a flat slab, so the water sits above it inside a raised rim rather than below.
  const P = POND, WY = Y + 0.2, RY = Y + 0.4, N = 44;
  disc(f, P.x, P.z, P.a * 0.62, P.b * 0.62, WY, 0x23867c, N);
  for (let i = 0; i < N; i++) {
    const t0 = (i / N) * TAU, t1 = ((i + 1) / N) * TAU;
    ringUp(f, P.x, P.z, P.a * 0.62, P.b * 0.62, WY, P.a, P.b, WY, t0, t1, 0x35a596);
    ringWall(f, P.x, P.z, P.a, P.b, WY, RY, t0, t1, -1, STONE, 0.8);
    ringUp(f, P.x, P.z, P.a, P.b, RY, P.a + 0.9, P.b + 0.9, RY, t0, t1, STONE, i % 2 ? 1 : 0.94);
    ringWall(f, P.x, P.z, P.a + 0.9, P.b + 0.9, Y, RY, t0, t1, 1, STONE, 0.86);
  }
  // Rim as a ring of small blocks: the basin is only decoration under the plan's flat ground, so this is what keeps walkers out of the water.
  for (let i = 0; i < 100; i++) {
    const t = (i / 100) * TAU;
    K.col.addBoxC(P.x + Math.cos(t) * (P.a + 0.45), P.z + Math.sin(t) * (P.b + 0.45), 1.7, 1.7, RY + 0.6, Y - 0.2);
  }
  // Lily pads, and the ducks the sign asks you to keep off.
  for (let i = 0; i < 16; i++) {
    const t = rng.range(0, TAU), k = rng.range(0.25, 0.9), r = rng.range(0.35, 0.7);
    disc(f, P.x + Math.cos(t) * P.a * k, P.z + Math.sin(t) * P.b * k, r, r, WY + 0.02, i % 5 === 0 ? 0xa7b67f : SAGE, 6);
  }
  for (const [dx, dz, h] of [[-9, 5, 0.6], [-7.2, 6.4, 0.9], [11, -6, 2.4]] as const) {
    const x = P.x + dx, z = P.z + dz, c = Math.cos(h), s = Math.sin(h);
    f.box(x, WY, z, 0.5, 0.3, 0.75, MUST, h, 5);
    f.box(x + s * 0.3, WY + 0.26, z + c * 0.3, 0.3, 0.3, 0.3, MUST, h, 5);
    f.box(x + s * 0.52, WY + 0.33, z + c * 0.52, 0.16, 0.08, 0.16, VERM, h, 5);
  }

  // The founder, on the promenade's axis above the pond, pointing out to sea.
  const SX = 186, SZ = PROM_Z;
  wdisc(K.cobble, SX, SZ, 5.6, PY + 0.01, 0xd9cbb0, TILE_M.cobble);
  for (let i = 0; i < 28; i++) {
    const t0 = (i / 28) * TAU, t1 = ((i + 1) / 28) * TAU;
    // The kerb ring is skipped where the promenade passes through.
    if (Math.abs(Math.sin((t0 + t1) / 2)) * 5.6 < PROM_HW + 0.3) continue;
    ringUp(f, SX, SZ, 5.4, 5.4, Y + 0.12, 5.8, 5.8, Y + 0.12, t0, t1, STONE);
    ringWall(f, SX, SZ, 5.8, 5.8, Y, Y + 0.12, t0, t1, 1, STONE, 0.85);
    ringWall(f, SX, SZ, 5.4, 5.4, Y, Y + 0.12, t0, t1, -1, STONE, 0.85);
  }
  f.box(SX, Y, SZ, 2.6, 0.45, 2.6, STONE, 0, 5, 0.92);
  f.box(SX, Y + 0.45, SZ, 1.9, 2.5, 1.9, STONE, 0, 5);
  f.box(SX, Y + 2.95, SZ, 2.2, 0.25, 2.2, STONE, 0, 7, 0.95);
  K.col.addBoxC(SX, SZ, 2.6, 2.6, Y + 3.2);
  const plaque = K.signs.has('notice-gulls') ? 'notice-gulls' : K.signs.notices[0];
  K.board(plaque, SX, Y + 0.85, SZ + 0.97, 1.2, 1.2 / 0.7, 0);
  K.board(plaque, SX, Y + 0.85, SZ - 0.97, 1.2, 1.2 / 0.7, Math.PI);
  {
    // Verdigris bronze, half again life size. He faces south (+Z); his right arm is at -X.
    const B = 0x4d8275, BD = 0x3c6a60, k = 1.5, y = Y + 3.2;
    const bx = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, hex = B, sh = 1): void =>
      f.box(SX + lx * k, y + ly * k, SZ + lz * k, sx * k, sy * k, sz * k, hex, 0, 7, sh);
    bx(-0.2, 0, 0, 0.3, 0.95, 0.34, BD); bx(0.2, 0, 0, 0.3, 0.95, 0.34, BD);
    bx(0, 0.62, -0.02, 0.86, 0.55, 0.5, B, 0.92);            // coat skirt
    bx(0, 1.12, 0, 0.78, 0.62, 0.44);                        // chest
    bx(0.5, 0.72, 0, 0.2, 0.98, 0.26);                       // left arm, at his side
    bx(-0.5, 1.48, 0.42, 0.2, 0.2, 1.0);                     // right arm, levelled at the horizon
    bx(-0.5, 1.5, 0.92, 0.1, 0.1, 0.24, BD);                 // and one finger
    bx(0, 1.74, 0, 0.2, 0.1, 0.2, BD);
    bx(0, 1.82, 0.02, 0.36, 0.38, 0.36);
    bx(0, 2.18, 0.02, 0.62, 0.05, 0.62, BD);                 // hat brim
    bx(0, 2.23, 0.02, 0.4, 0.34, 0.4);
    // The gull, and what the gull has done.
    const gy = 2.57;
    bx(0.02, gy + 0.1, 0, 0.16, 0.15, 0.36, 0xf7f3e8);
    bx(0.02, gy + 0.2, -0.02, 0.2, 0.05, 0.28, 0x9aa3a8);
    bx(0.02, gy + 0.22, 0.2, 0.12, 0.12, 0.12, 0xf7f3e8);
    bx(0.02, gy + 0.25, 0.3, 0.04, 0.04, 0.1, MUST);
    bx(-0.02, gy, 0, 0.02, 0.1, 0.02, MUST); bx(0.06, gy, 0, 0.02, 0.1, 0.02, MUST);
    bx(0.14, 1.95, 0.225, 0.06, 0.28, 0.01, 0xf7f3e8); bx(0.3, 1.5, 0.225, 0.05, 0.22, 0.01, 0xf7f3e8);
  }

  // Bandstand, astride the promenade so the path runs through it. Its floor is paving at
  // lawn level because groundAt() knows nothing of platforms; the posts are the collision.
  const BX = 258, BZ = PROM_Z, BR = 4.6;
  wdisc(K.cobble, BX, BZ, 5.4, PY + 0.01, 0xe0b8a0, TILE_M.cobble);
  for (let i = 0; i < 8; i++) {
    const t = ((i + 0.5) / 8) * TAU, t2 = ((i + 1.5) / 8) * TAU;
    const px = BX + Math.cos(t) * BR, pz = BZ + Math.sin(t) * BR, qx = BX + Math.cos(t2) * BR, qz = BZ + Math.sin(t2) * BR;
    f.cyl(px, Y, pz, 0.2, 0.2, 0.5, STONE, 6);
    f.cyl(px, Y + 0.5, pz, 0.12, 0.1, 2.9, BONE, 6, false);
    K.col.addProp(px, pz, 0.22, 3.4, 'post', false);
    beam(f, px, Y + 3.3, pz, qx, Y + 3.3, qz, 0.3, BONE);
    // Railing on every side except the two the promenade walks through (east and west).
    const open = Math.abs(Math.sin((t + t2) / 2)) < 0.4;
    if (!open) {
      beam(f, px, Y + 0.95, pz, qx, Y + 0.95, qz, 0.1, VERM);
      beam(f, px, Y + 0.35, pz, qx, Y + 0.35, qz, 0.07, VERM);
      for (let u = 1; u < 6; u++) f.box(lerp(px, qx, u / 6), Y + 0.35, lerp(pz, qz, u / 6), 0.06, 0.6, 0.06, VERM, 0, 4);
    }
  }
  // Roof in two pitches like a paper hat, seen from underneath as well.
  K.dbl.cyl(BX, Y + 3.45, BZ, 5.7, 2.6, 1.1, TEAL, 8, false);
  K.dbl.cyl(BX, Y + 4.55, BZ, 2.6, 0.12, 1.5, TEAL, 8, false, 0.9);
  f.cyl(BX, Y + 5.95, BZ, 0.1, 0.05, 0.9, MUST, 5);
  f.box(BX, Y + 6.5, BZ, 0.3, 0.3, 0.3, MUST, Math.PI / 4, 7);
  K.lamp.box(BX, Y + 3.25, BZ, 0.5, 0.2, 0.5, BONE, 0, 6);
  K.pool(BX, PY + 0.06, BZ, 13, SODIUM);

  // Flower beds and benches down both sides of the promenade, inside the strip the trees leave clear.
  const flowers = [VERM, MUST, BONE, 0xe98a6b];
  const busy = (x: number): boolean => Math.abs(x - SX) < 13 || Math.abs(x - BX) < 13 || x < x0 + 11 || x > x1 - 11;
  let n = 0;
  for (let x = x0 + 12; x < x1 - 12; x += 15, n++) {
    for (const s of [-1, 1]) {
      const z = PROM_Z + s * (PROM_HW + 1.5);
      if (!busy(x + 4.5)) {
        f.box(x + 4.5, Y, z, 9, 0.16, 1.5, 0x5b4130, 0, 5);
        f.box(x + 4.5, Y + 0.16, z, 8.7, 0.2, 1.2, SAGE, 0, 5, 0.9);
        const ca = flowers[(n + (s > 0 ? 1 : 0)) % 4], cb = flowers[(n + 2 + (s > 0 ? 1 : 0)) % 4];
        const step = K.density < 0.7 ? 0.9 : 0.55;
        for (let u = 0.35; u < 8.7; u += step) for (const v of [-0.3, 0.3]) {
          const band = Math.floor(u / 2.2) % 2 === 0;
          f.box(x + u + 0.15 + rng.range(-0.08, 0.08), Y + 0.34, z + v + rng.range(-0.08, 0.08), 0.3, 0.14 + rng.range(0, 0.1), 0.3, band ? ca : cb, rng.range(0, 1.5), 5);
        }
      }
      // A bench in the gap after each bed, facing the path.
      const bxm = x + 12;
      if (!busy(bxm) && bxm < x1 - 12) bench(K, bxm, PROM_Z + s * (PROM_HW + 1.25), s > 0 ? Math.PI : 0);
    }
  }
  // Benches round the pond's north bank, looking at the water.
  for (const t of [-2.2, -1.57, -0.95]) {
    const x = P.x + Math.cos(t) * (P.a + 2.2), z = P.z + Math.sin(t) * (P.b + 2.2);
    bench(K, x, z, Math.atan2(-Math.cos(t), -Math.sin(t)));
  }

  // Lamps along the promenade.
  for (const x of [x0 + 26, 146, 222, x1 - 26]) K.lampPost(x, PROM_Z - PROM_HW - 0.9, 4.6, 0, false, 0.9);

  // A gate at each end of the promenade, signed on both faces.
  const key = placeSign(K, /mercy/i, 'mercy-park');
  for (const gx of [x0 + 5, x1 - 5]) {
    for (const s of [-1, 1]) {
      const z = PROM_Z + s * 4.1;
      f.box(gx, Y, z, 0.9, 0.5, 0.9, STONE, 0, 5, 0.9);
      f.box(gx, Y + 0.5, z, 0.65, 4.9, 0.65, STONE, 0, 5);
      f.box(gx, Y + 5.4, z, 0.85, 0.2, 0.85, STONE, 0, 7, 0.95);
      K.lamp.box(gx, Y + 5.6, z, 0.4, 0.45, 0.4, BONE, 0, 5);
      K.halo(gx, Y + 5.85, z, 1.6, 0, SODIUM); K.halo(gx, Y + 5.85, z, 1.6, Math.PI / 2, SODIUM);
      K.col.addProp(gx, z, 0.5, 5.5, 'post', false);
    }
    f.box(gx, Y + 3.15, PROM_Z, 0.34, 2.3, 8.3, INK, 0, 7);
    K.board(key, gx - 0.18, Y + 3.3, PROM_Z, 8, 2, -Math.PI / 2);
    K.board(key, gx + 0.18, Y + 3.3, PROM_Z, 8, 2, Math.PI / 2);
  }
}

function bench(K: Kit, x: number, z: number, hd: number): void {
  const f = K.f, y = groundAt(x, z), c = Math.cos(hd), s = Math.sin(hd);
  for (const lx of [-0.75, 0.75]) f.box(x + lx * c, y, z - lx * s, 0.08, 0.44, 0.5, INK, hd, 4);
  f.box(x, y + 0.44, z, 1.8, 0.07, 0.52, TIMBER, hd, 7);
  f.box(x - s * 0.25, y + 0.6, z - c * 0.25, 1.8, 0.36, 0.07, TIMBER, hd, 7, 0.92);
  K.col.addProp(x, z, 0.8, 0.9, 'bench', false);
}

// ── Flounder Field ───────────────────────────────────────────────────────────

/** The demolition derby's bowl inside Flounder Field (game/derby.ts): middle, the concrete barrier's semi-axes, the gate outside. */
export const DERBY = { x: -421, z: -70, a: 29, b: 18, gateX: -476, gateZ: -70 } as const;

function buildArena(K: Kit): void {
  K.place('arena');
  const f = K.f, d = K.dbl;
  const cx = -421, cz = -70, A = 47, B = 36, Y = CURB, N = 56, TOP = 14;
  const seat = [TEAL, BONE, VERM, BONE];

  // Collision: the stands as a ring of slices (fun queue item 13, the derby): solid from the outer wall in to just
  // behind the derby's concrete barrier, so nobody drives in from the street; inside, game/derby.ts keeps the cars
  // off the barrier itself (an ellipse, not boxes).
  const S = 24, RA = DERBY.a + 0.9, RB = DERBY.b + 0.9;
  for (let k = 0; k < S; k++) {
    const xa = -A + (k / S) * 2 * A, xb = -A + ((k + 1) / S) * 2 * A, xm = Math.min(Math.abs(xa), Math.abs(xb));
    const hz = B * Math.sqrt(Math.max(0, 1 - (xm / A) * (xm / A)));
    const xs = xa < 0 && xb > 0 ? 0 : xm;
    const hi = xs >= RA ? 0 : RB * Math.sqrt(Math.max(0, 1 - (xs / RA) * (xs / RA)));
    if (hi <= 0) { K.col.addBox(cx + xa, cz - hz, cx + xb, cz + hz, Y + TOP); continue; }
    K.col.addBox(cx + xa, cz + hi, cx + xb, cz + hz, Y + TOP);
    K.col.addBox(cx + xa, cz - hz, cx + xb, cz - hi, Y + TOP);
  }

  // The floor: a churned dirt bowl for the demolition derby, ruts and puddles of oil, under the floodlights.
  const PYY = Y + 0.03;
  // (The dirt itself, ruts and oil, is game/derby.ts's own mesh: slush on it in winter, not a snowfield.)
  disc(f, cx, cz, 31, 20, PYY, 0x6e4d33, N);
  // Concrete barriers (jersey blocks) round the bowl, every fourth one painted; tyre walls stacked in front of them.
  {
    const NB = 72;
    for (let i = 0; i < NB; i++) {
      const t0 = (i / NB) * TAU, t1 = ((i + 1) / NB) * TAU, tm = (t0 + t1) / 2;
      const x0 = cx + DERBY.a * Math.cos(t0), z0 = cz + DERBY.b * Math.sin(t0), x1 = cx + DERBY.a * Math.cos(t1), z1 = cz + DERBY.b * Math.sin(t1);
      const len = Math.hypot(x1 - x0, z1 - z0), nx = Math.cos(tm) / DERBY.a, nz = Math.sin(tm) / DERBY.b, rot = Math.atan2(nx, nz);
      const mx = cx + (DERBY.a + 0.3) * Math.cos(tm), mz = cz + (DERBY.b + 0.3) * Math.sin(tm);
      const hue = i % 4 === 0 ? (i % 8 === 0 ? VERM : MUST) : CONCRETE;
      f.box(mx, PYY, mz, len * 0.97, 0.3, 0.8, hue, rot, 5, 0.92);
      f.box(mx, PYY + 0.3, mz, len * 0.97, 0.55, 0.42, hue, rot, 5, 1);
      f.box(mx, PYY + 0.85, mz, len * 0.97, 0.08, 0.3, hue, rot, 5, 1.05);
    }
    const r = new RNG(77);
    for (let i = 0; i < 36; i++) {
      const t = (i / 36) * TAU + 0.04;
      if (Math.abs(Math.cos(t)) > 0.985 && Math.cos(t) < 0) continue; // the gate, west
      for (let j = -1; j <= 1; j++) {
        const tt = t + j * 0.03, x = cx + (DERBY.a - 0.35) * Math.cos(tt), z = cz + (DERBY.b - 0.35) * Math.sin(tt);
        const n = 3 + ((r.next() * 2) | 0);
        for (let q = 0; q < n; q++) {
          f.cyl(x, PYY + q * 0.24, z, 0.36, 0.36, 0.22, 0x1b1b1d, 10, true, 0.85 + r.next() * 0.2);
          if (q % 2 === 0 && j === 0) f.cyl(x, PYY + q * 0.24 + 0.07, z, 0.365, 0.365, 0.05, i % 3 ? BONE : VERM, 10, false, 0.9);
        }
      }
    }
  }
  // The gate on the west side, by the lot: a steel frame and a striped banner over the arch.
  {
    const gx = cx - A - 0.6;
    for (const u of [-3.4, 3.4]) { f.box(gx - 1.2, Y, cz + u, 0.5, 6.4, 0.5, STEEL, 0, 5); K.col.addProp(gx - 1.2, cz + u, 0.35, 6.4, 'post', false); }
    f.box(gx - 1.2, Y + 5.6, cz, 0.6, 1.1, 7.4, INK, 0, 5);
    for (let k = 0; k < 6; k++) f.box(gx - 1.55, Y + 5.75, cz - 3 + k * 1.2, 0.08, 0.8, 0.6, k % 2 ? MUST : VERM, 0, 5);
    d.quad(gx - 0.35, Y, cz - 3, gx - 0.35, Y, cz + 3, gx - 0.35, Y + 4.8, cz + 3, gx - 0.35, Y + 4.8, cz - 3, 0x2a2420);
  }

  for (let i = 0; i < N; i++) {
    const t0 = (i / N) * TAU, t1 = ((i + 1) / N) * TAU, tm = (t0 + t1) / 2;
    // Outer wall: terracotta between bone ribs, a bone crown with a vermilion band.
    ringWall(f, cx, cz, A, B, Y, 11.6, t0, t1, 1, TERRA);
    ringWall(f, cx, cz, A + 0.3, B + 0.3, 11.6, TOP, t0, t1, 1, BONE);
    ringWall(f, cx, cz, A + 0.42, B + 0.42, 12.5, 13.3, t0, t1, 1, VERM);
    ringUp(f, cx, cz, 45, 34, TOP, A + 0.3, B + 0.3, TOP, t0, t1, STONE);

    // Stands: seven tiers of riser and tread, coloured in blocks with stone aisles between.
    const aisle = i % 4 === 0, hue = aisle ? STONE : seat[Math.floor(i / 4) % 4];
    for (let k = 0; k < 7; k++) {
      const a = 31 + k * 2, b = 20 + k * 2, y = 1.3 + k * 1.58 + Y;
      ringWall(f, cx, cz, a, b, k === 0 ? PYY : y - 1.58, y, t0, t1, -1, k === 0 ? BONE : hue, 0.72);
      ringUp(f, cx, cz, a, b, y, a + 2, b + 2, y, t0, t1, hue, k % 2 ? 1 : 0.9);
    }
    ringWall(f, cx, cz, 45, 34, Y + 1.3 + 6 * 1.58, TOP, t0, t1, -1, BONE, 0.85);

    // Rib at each joint, turned to face straight out of the oval.
    const c0 = Math.cos(t0), s0 = Math.sin(t0);
    const nx = c0 / A, nz = s0 / B, rot = Math.atan2(nx, nz);
    const longSide = Math.abs(Math.sin(t0)) > 0.5;
    f.box(cx + (A + 0.35) * c0, Y, cz + (B + 0.35) * s0, 0.9, longSide ? 17.4 : TOP + 0.5, 1.3, BONE, rot, 5, 0.96);

    // Arches below and a row of windows above, laid just proud of the wall (double-sided, so winding is moot).
    const ax = cx + A * c0, az = cz + B * s0, bx = cx + A * Math.cos(t1), bz = cz + B * Math.sin(t1);
    let tx = bx - ax, tz = bz - az;
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    let ox = tz, oz = -tx;
    if (ox * Math.cos(tm) + oz * Math.sin(tm) < 0) { ox = -ox; oz = -oz; }
    const mx = (ax + bx) / 2 + ox * 0.14, mz = (az + bz) / 2 + oz * 0.14;
    const aw = Math.min(1.45, tl / 2 - 0.75), ah = 4.3, dark = 0x1a2740;
    d.quad(mx - tx * aw, Y, mz - tz * aw, mx + tx * aw, Y, mz + tz * aw, mx + tx * aw, Y + ah, mz + tz * aw, mx - tx * aw, Y + ah, mz - tz * aw, dark);
    for (let q = 0; q < 6; q++) {
      const p0 = (q / 6) * Math.PI, p1 = ((q + 1) / 6) * Math.PI;
      d.tri(mx, Y + ah, mz, mx + tx * aw * Math.cos(p0), Y + ah + aw * Math.sin(p0), mz + tz * aw * Math.cos(p0),
        mx + tx * aw * Math.cos(p1), Y + ah + aw * Math.sin(p1), mz + tz * aw * Math.cos(p1), dark);
    }
    for (const u of [-0.75, 0.75]) {
      const wx = mx + tx * u, wz = mz + tz * u;
      d.quad(wx - tx * 0.42, Y + 7.6, wz - tz * 0.42, wx + tx * 0.42, Y + 7.6, wz + tz * 0.42, wx + tx * 0.42, Y + 10, wz + tz * 0.42, wx - tx * 0.42, Y + 10, wz - tz * 0.42, dark);
    }

    // Canopy over the two long sides only; the ends stay open so the pitch reads from outside.
    if (Math.abs(Math.sin(tm)) > 0.5) {
      const c1 = Math.cos(t1), s1 = Math.sin(t1), hueC = i % 2 ? BONE : 0xe7dcc0;
      d.quad(cx + (A + 1.6) * c0, Y + 17.4, cz + (B + 1.6) * s0, cx + (A + 1.6) * c1, Y + 17.4, cz + (B + 1.6) * s1,
        cx + (A - 10) * c1, Y + 15.6, cz + (B - 10) * s1, cx + (A - 10) * c0, Y + 15.6, cz + (B - 10) * s0, hueC);
      d.quad(cx + (A - 10) * c0, Y + 15.6, cz + (B - 10) * s0, cx + (A - 10) * c1, Y + 15.6, cz + (B - 10) * s1,
        cx + (A - 10) * c1, Y + 14.9, cz + (B - 10) * s1, cx + (A - 10) * c0, Y + 14.9, cz + (B - 10) * s0, VERM);
      beam(f, cx + (A + 0.4) * c0, Y + 17.2, cz + (B + 0.4) * s0, cx + (A - 9.8) * c0, Y + 15.4, cz + (B - 9.8) * s0, 0.3, STEEL);
    }
  }

  // Name and crest, to the parking lot (west) and to Ledger St (south).
  const name = placeSign(K, /flounder/i, 'flounder-field');
  const fish = K.signs.has('hang-fish') ? 'hang-fish' : K.signs.hanging[0];
  const sx = cx - A - 1.5, sz = cz + B + 1.3;
  for (const u of [-9, 0, 9]) {
    f.box(sx + 0.5, Y + 11, cz + u, 0.4, 10.6, 0.4, STEEL, 0, 4);
    f.box(cx + u, Y + 11, sz - 0.5, 0.4, 9.4, 0.4, STEEL, 0, 4);
  }
  K.hoarding(name, sx, Y + 15, cz, 26, 6.5, -Math.PI / 2);
  f.box(sx + 0.5, Y + 21.5, cz, 0.4, 4, 0.4, STEEL, 0, 4);
  K.board(fish, sx, Y + 21.9, cz, 6.4, 6.4, -Math.PI / 2);
  K.hoarding(name, cx, Y + 14.6, sz, 22, 5.5, 0);
  K.board(fish, cx, Y + 20.4, sz, 5.4, 5.4, 0);
  f.box(cx, Y + 20, sz - 0.5, 0.4, 3.4, 0.4, STEEL, 0, 4);

  // Four light towers in the corners the oval leaves free.
  for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
    const x = cx + ex * 44.5, z = cz + ez * 33.5, hd = Math.atan2(cx - x, cz - z), H = 30;
    const c = Math.cos(hd), s = Math.sin(hd);
    f.cyl(x, Y, z, 1.0, 0.5, 2, STONE, 6);
    f.cyl(x, Y + 2, z, 0.55, 0.3, H - 2, STEEL, 6, false);
    f.box(x + s * 0.3, Y + H - 1, z + c * 0.3, 8, 5, 0.5, INK, hd, 7);
    f.box(x, Y + H - 2.2, z, 2.4, 0.15, 2.4, STEEL, hd, 7);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 5; q++) {
      const lx = (q - 2) * 1.5, ly = Y + H - 0.55 + r * 1.5;
      K.lamp.box(x + lx * c + s * 0.62, ly, z - lx * s + c * 0.62, 1.1, 1.1, 0.16, BONE, hd, 5);
    }
    K.halo(x + s * 0.9, Y + H + 1.5, z + c * 0.9, 20, hd, FLOOD);
    K.col.addProp(x, z, 1, H, 'post', false);
  }
  // What the towers do to the pitch.
  K.pool(cx - 13, PYY + 0.3, cz, 50, 0x4a4636); K.pool(cx + 13, PYY + 0.3, cz, 50, 0x4a4636);

  // The lot to the west. Stall rows leave a lane 16 m wide down x = -540 for the stunt ramp and its run-up.
  K.place('arena');
  const lot = blockRect(K.game, 0, 3), line2 = K.mats.tex.marks.rect('line'), paint = 0xe9e2cf;
  const zA = lot.z0 + 6, rows = Math.floor((lot.z1 - 6 - zA) / 2.7), zB = zA + rows * 2.7;
  const m = K.marks;
  for (const sxp of [-584, -562, -518, -496]) {
    m.quad(sxp + 0.08, Y, zB, sxp + 0.08, Y, zA, sxp - 0.08, Y, zA, sxp - 0.08, Y, zB, paint, 0, line2.v0, (zB - zA) / 9.6, line2.v1);
    for (let k = 0; k <= rows; k++) {
      const z = zA + k * 2.7;
      m.quad(sxp - 5, Y, z + 0.08, sxp + 5, Y, z + 0.08, sxp + 5, Y, z - 0.08, sxp - 5, Y, z - 0.08, paint, 0, line2.v0, 10 / 9.6, line2.v1);
    }
  }
  for (const lx of [-584, -496]) for (const k of [5, rows - 5]) K.lampPost(lx, zA + k * 2.7, 9, Math.PI / 2, true, 1.6);
}

// ── Billboards ───────────────────────────────────────────────────────────────

/** Order of the cells in public/textures/art/boards.webp (tools/art/compose.mjs BOARDS). */
const ART_BOARDS = ['bb-speedscan', 'bb-pardons', 'bb-dithers', 'bb-lackwool', 'bb-radio881', 'bb-tepid', 'bb-bridge', 'bb-derby'];
/** Posters in posters.webp order: duck, moose, bond, derby, fair, cat, lighthouse, notice. */
const POSTER_SLOTS = 8;

/** A 2:1 board on a steel frame. `posts` 1 = a single mast (fits a sidewalk), 2 = a trestle. */
function billboard(K: Kit, key: string, x: number, z: number, hd: number, w = 12, base = 6.5, posts = 2): void {
  const f = K.f, g = groundAt(x, z), h = w / 2, c = Math.cos(hd), s = Math.sin(hd);
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
  const top = g + base + h;
  for (const lx of posts === 1 ? [0] : [-w * 0.3, w * 0.3]) {
    const [px, pz] = at(lx, -0.75);
    f.box(px, g, pz, posts === 1 ? 0.8 : 0.5, base + h - 0.4, posts === 1 ? 0.8 : 0.5, STEEL, hd, 4);
    f.box(px, g, pz, 1.2, 0.35, 1.2, CONCRETE, hd, 5);
    K.col.addProp(px, pz, posts === 1 ? 0.6 : 0.45, base, 'post', false);
    if (posts === 2) { const [qx, qz] = at(lx, -2.6); beam(f, qx, g, qz, px, g + base + h * 0.6, pz, 0.28, STEEL); }
  }
  for (const y of [g + base + 0.8, top - 0.8]) { const [bx, bz] = at(0, -0.42); f.box(bx, y, bz, w * 0.98, 0.3, 0.3, STEEL, hd, 7); }
  K.hoarding(key, x, g + base, z, w, h, hd);
  // Bone trim round the picture, a catwalk under it, and lamps on arms that throw light back up the board.
  for (const [lx, sx2, ly, sy] of [[0, w + 0.5, -0.25, 0.25], [0, w + 0.5, h, 0.25], [-w / 2 - 0.125, 0.25, 0, h], [w / 2 + 0.125, 0.25, 0, h]] as const) {
    const [bx, bz] = at(lx, 0.02); f.box(bx, g + base + ly, bz, sx2, sy, 0.24, BONE, hd, 7);
  }
  { const [bx, bz] = at(0, 0.55); f.box(bx, g + base - 0.55, bz, w, 0.1, 1, STEEL, hd, 7); }
  const lamps = Math.max(2, Math.round(w / 4));
  for (let i = 0; i < lamps; i++) {
    const lx = ((i + 0.5) / lamps - 0.5) * w;
    const [ax, az] = at(lx, 1.5);
    f.box(ax, g + base - 0.5, az, 0.34, 0.2, 0.5, INK, hd, 5);
    K.lamp.box(ax, g + base - 0.3, az, 0.26, 0.05, 0.4, BONE, hd, 5);
  }
  // Additive wash over the face: it is what makes the board read as floodlit rather than merely not dark.
  const [hx, hz] = at(0, 0.3);
  K.halo(hx, g + base + h / 2, hz, w * 1.5, hd, 0x5a4a2c);
}

/** Notice stands on the sidewalks: two posts and a panel carrying four posters (two a side). */
function buildPosters(K: Kit): void {
  K.place('posters');
  const rng = new RNG(8802), park0 = blockRect(K.game, 6, 2), park1 = blockRect(K.game, 7, 3);
  let slot = 0, n = 0;
  const stand = (x: number, z: number, hd: number): void => {
    const f = K.f, g = groundAt(x, z), c = Math.cos(hd), s = Math.sin(hd);
    for (const lx of [-1.15, 1.15]) f.box(x + lx * c, g, z - lx * s, 0.12, 3.1, 0.12, STEEL, hd, 4);
    f.box(x, g + 0.7, z, 2.6, 2.2, 0.07, INK, hd, 7);
    f.box(x, g + 2.9, z, 2.8, 0.12, 0.18, BONE, hd, 7);
    for (const lx of [-0.62, 0.62]) K.poster(slot++ % POSTER_SLOTS, x + lx * c, g + 0.8, z - lx * s, 1.0, 2.0, hd);
    K.col.addProp(x, z, 0.6, 3, 'post', false);
    n++;
  };
  for (const blk of K.game.plan.blocks) {
    const r = blk.rect;
    if (r.x1 > park0.x0 && r.x0 < park1.x1 && r.z1 > park0.z0 && r.z0 < park1.z1) continue;
    if (r.z0 < -520 || r.z1 > 520 || r.x0 < -660 || r.x1 > 660) continue; // the island only; the mainland has its own streets
    if (!rng.chance(0.3) || n >= 30) continue;
    // One stand on the sidewalk of a street-facing edge, turned along the walk like a blade sign so people coming down the pavement see its faces.
    const edge = rng.int(0, 3), cx = (r.x0 + r.x1) / 2 + rng.range(-12, 12), cz = (r.z0 + r.z1) / 2 + rng.range(-12, 12), m = SIDEWALK / 2 + 0.2;
    if (edge === 0) stand(cx, r.z0 + m, Math.PI / 2);
    else if (edge === 1) stand(cx, r.z1 - m, Math.PI / 2);
    else if (edge === 2) stand(r.x0 + m, cz, 0);
    else stand(r.x1 - m, cz, 0);
  }
}

function buildBillboards(K: Kit): void {
  K.place('boards');
  const bb = K.signs.billboards, pick = (i: number): string => bb[Math.min(i, bb.length - 1)];
  // WDOOF, on the far sidewalk of Strand Blvd just east of where the game starts, turned a
  // little toward the player. The pier and the wheel are west of south from there, so it frames them.
  billboard(K, 'wdoof', 52, 302.3, Math.PI + 0.26, 10, 7.5, 1);
  // WDOOF again, beside the bridge approach, for anyone lining up the big jump.
  // The rest are painted boards (public/textures/art): they stand where an avenue runs out, facing back down it.
  billboard(K, 'bb-bridge', 2, -458, 0.12, 14, 7);                // beside the bridge approach, for anyone lining up the big jump
  billboard(K, 'bb-speedscan', -624, -20, Math.PI / 2, 14, 7);    // west end of Ledger St
  billboard(K, 'bb-pardons', 606, -20, -Math.PI / 2, 14, 7);      // east end of Ledger St
  billboard(K, 'bb-derby', 310, 428, Math.PI, 14, 7);             // south end of Ironbound Ave
  billboard(K, 'bb-dithers', 310, -456, 0, 14, 7);                // north end of Ironbound Ave
  billboard(K, 'bb-lackwool', -624, 290, Math.PI / 2, 14, 7);     // west end of Strand Blvd
  billboard(K, 'bb-radio881', -624, -78, Math.PI / 2, 14, 7);     // a second board a block north of the Ledger St one
  billboard(K, 'bb-tepid', 606, 38, -Math.PI / 2, 14, 7);         // and one a block south of the east one
  void pick;
}

// ── Low Tide Beach ───────────────────────────────────────────────────────────

/** Z of the waterline on the south shore at x. */
function waterline(x: number): number {
  for (let z = 410; z < 640; z += 0.5) if (islandSD(x, z) > -5.5) return z;
  return 640;
}
/** A spot on the south beach: f = 0 by the seawall, 1 near the water. */
const beachZ = (x: number, f: number): number => lerp(420, waterline(x) - 7, f);

function buildBeach(K: Kit): void {
  K.place('beach');
  const f = K.f, d = K.dbl, rng = new RNG(8821);
  const hues = [VERM, MUST, TEAL, INK, TERRA];
  const sandY = (x: number, z: number): number => groundAt(x, z) - 0.03;

  const towel = (x: number, z: number, rot: number, hex: number): void => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx: number, lz: number): [number, number, number] => { const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c; return [wx, sandY(wx, wz) + 0.04, wz]; };
    // Three bands: colour, bone, colour.
    for (let k = 0; k < 3; k++) {
      const a = P(-0.45, -0.95 + k * 0.633), b = P(0.45, -0.95 + k * 0.633), cc = P(0.45, -0.95 + (k + 1) * 0.633), dd = P(-0.45, -0.95 + (k + 1) * 0.633);
      oq(K.decal, a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], dd[0], dd[1], dd[2], 0, 1, 0, k === 1 ? BONE : hex);
    }
  };

  const umbrella = (x: number, z: number, hex: number): void => {
    const y = sandY(x, z), R = 1.7, rim = y + 1.85, apex = y + 2.4;
    f.cyl(x, y - 0.2, z, 0.045, 0.045, 2.65, BONE, 5, false);
    const off = rng.range(0, 1);
    for (let i = 0; i < 8; i++) {
      const t0 = ((i + off) / 8) * TAU, t1 = ((i + 1 + off) / 8) * TAU;
      d.tri(x, apex, z, x + Math.cos(t1) * R, rim, z + Math.sin(t1) * R, x + Math.cos(t0) * R, rim, z + Math.sin(t0) * R, i % 2 ? BONE : hex);
    }
    f.box(x, apex, z, 0.1, 0.12, 0.1, BONE, 0, 5);
    K.col.addProp(x, z, 0.12, 2.2, 'post', false);
    const a = rng.range(0, TAU);
    towel(x + Math.cos(a) * 1.5, z + Math.sin(a) * 1.5, rng.range(-0.5, 0.5), hues[rng.int(0, 4)]);
    if (rng.chance(0.6)) towel(x + Math.cos(a + 2.4) * 1.7, z + Math.sin(a + 2.4) * 1.7, rng.range(-0.5, 0.5), hex);
  };

  // Hand-placed in loose threes. Nothing in the pier's lane, nor in the beach ramp's run-up and landing (x -180..-60).
  const spots: [number, number, number][] = [
    [-262, 0.5, 0], [-250, 0.72, 2], [-222, 0.4, 1],
    [-58, 0.52, 2], [-45, 0.76, 0], [-30, 0.4, 1],
    [30, 0.5, 1], [41, 0.72, 0],
    [104, 0.66, 2], [116, 0.42, 4], [128, 0.74, 0],
    [196, 0.7, 1], [208, 0.48, 0], [246, 0.6, 2], [262, 0.38, 3], [290, 0.68, 1],
  ];
  spots.forEach(([x, fr, hi], i) => {
    if (K.density < 0.7 && i % 3 === 2) return;
    umbrella(x, beachZ(x, fr), hues[hi]);
  });

  // Beach huts in a row under the seawall, doors to the sea.
  [VERM, MUST, TEAL, INK, TERRA].forEach((hex, i) => {
    const x = 46 + i * 5.2, z = 422.5, y = groundAt(x, z), W = 3.4, D = 3.6, H = 2.5, fy = y + 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.box(x + sx * (W / 2 - 0.25), y - 0.2, z + sz * (D / 2 - 0.25), 0.24, 0.5, 0.24, TIMBER, 0, 4);
    f.box(x, fy, z, W, H, D, BONE, 0, 6);
    // Painted boards: stripes that wrap front and back.
    for (let k = 0; k < 7; k += 2) f.box(x - W / 2 + (k + 0.5) * (W / 7), fy + 0.02, z, W / 7, H - 0.02, D + 0.08, hex, 0, 4);
    f.box(x, fy, z + D / 2 + 0.06, 0.95, 1.95, 0.06, hex, 0, 5, 0.8);
    f.box(x + 0.3, fy + 0.95, z + D / 2 + 0.1, 0.08, 0.08, 0.06, BONE, 0, 5);
    // Gable roof, ridge running front to back.
    const e = 0.3, ry = fy + H, ridge = ry + 1.15, za = z - D / 2 - e, zb = z + D / 2 + e;
    for (const sx of [-1, 1]) oq(d, x + sx * (W / 2 + e), ry - 0.12, za, x + sx * (W / 2 + e), ry - 0.12, zb, x, ridge, zb, x, ridge, za, sx, 1, 0, hex, 0.82);
    for (const zz of [z - D / 2, z + D / 2]) otri(f, x - W / 2, ry, zz, x + W / 2, ry, zz, x, ridge - 0.14, zz, 0, 0, zz > z ? 1 : -1, BONE);
    K.col.addBoxC(x, z, W, D, y + 3.6);
  });

  // Lifeguard chair east of the pier, with the red flag up.
  {
    const x = 22, z = beachZ(22, 0.86), y = sandY(x, z), H = 2.5;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(f, x + sx * 1.05, y - 0.2, z + sz * 1.05, x + sx * 0.7, y + H, z + sz * 0.7, 0.14, BONE);
    for (const sx of [-1, 1]) { beam(f, x + sx * 0.98, y + 0.5, z - 0.98, x + sx * 0.78, y + 1.9, z + 0.78, 0.08, BONE); beam(f, x - 0.9, y + 1.2, z + sx * 0.9, x + 0.9, y + 1.2, z + sx * 0.9, 0.08, BONE); }
    f.box(x, y + H, z, 1.9, 0.1, 1.9, BONE, 0, 7);
    f.box(x, y + H + 0.1, z - 0.15, 1.0, 0.5, 0.9, VERM, 0, 5);
    f.box(x, y + H + 0.6, z - 0.55, 1.0, 0.75, 0.1, VERM, 0, 7);
    for (const sx of [-1, 1]) f.box(x + sx * 0.9, y + H + 0.1, z, 0.06, 0.8, 0.06, BONE, 0, 4);
    for (const sx of [-1, 1]) beam(f, x + sx * 0.9, y + H + 0.9, z - 0.9, x + sx * 0.9, y + H + 0.9, z + 0.9, 0.06, BONE);
    // Ladder up the back.
    for (const sx of [-1, 1]) beam(f, x + sx * 0.3, y, z - 2.1, x + sx * 0.3, y + H, z - 0.95, 0.07, BONE);
    for (let k = 1; k < 7; k++) f.box(x, y + (H * k) / 7, z - 2.1 + (1.15 * k) / 7, 0.6, 0.05, 0.08, BONE, 0, 7);
    f.cyl(x + 0.85, y + H, z - 0.85, 0.035, 0.035, 2.6, BONE, 4, false);
    d.quad(x + 0.85, y + H + 1.9, z - 0.85, x + 1.85, y + H + 1.95, z - 0.75, x + 1.85, y + H + 2.5, z - 0.75, x + 0.85, y + H + 2.55, z - 0.85, VERM);
    K.col.addProp(x, z, 1.2, H + 1, 'post', false);
  }

  // Volleyball court on the flat sand.
  {
    const x = 156, z = beachZ(156, 0.3), y = sandY(x, z), hw = 4.5;
    for (const s of [-1, 1]) { f.cyl(x, y - 0.2, z + s * hw, 0.07, 0.07, 2.75, INK, 5); K.col.addProp(x, z + s * hw, 0.12, 2.5, 'post', false); }
    const fu = FENCE_UV.chain;
    K.fence.quad(x, y + 1.45, z + hw, x, y + 1.45, z - hw, x, y + 2.45, z - hw, x, y + 2.45, z + hw, BONE, 0, fu.v0 + 0.02, (hw * 2) / 0.6, fu.v0 + 0.02 + (fu.v1 - fu.v0) * 0.4);
    beam(f, x, y + 2.45, z - hw, x, y + 2.45, z + hw, 0.07, BONE);
    beam(f, x, y + 1.45, z - hw, x, y + 1.45, z + hw, 0.05, BONE);
    // Court boundary tape.
    const t = 0.07;
    for (const s of [-1, 1]) {
      K.decal.quad(x - 8, y + 0.04, z + s * hw + t, x + 8, y + 0.04, z + s * hw + t, x + 8, y + 0.04, z + s * hw - t, x - 8, y + 0.04, z + s * hw - t, TEAL);
      K.decal.quad(x + s * 8 - t, y + 0.04, z + hw, x + s * 8 + t, y + 0.04, z + hw, x + s * 8 + t, y + 0.04, z - hw, x + s * 8 - t, y + 0.04, z - hw, TEAL);
    }
    f.box(x + 3.2, y, z + 1.4, 0.24, 0.24, 0.24, BONE, 0.6, 5);   // the ball, as cubist as everything else here
  }

  // Driftwood along the tide line.
  for (const x of [-305, -212, -72, 74, 172, 268]) {
    const z = waterline(x) - 2.5 - rng.range(0, 2), a = rng.range(-0.5, 0.5), l = rng.range(1.4, 2.4);
    const ax = x - Math.cos(a) * l, az = z - Math.sin(a) * l, bx = x + Math.cos(a) * l, bz = z + Math.sin(a) * l;
    beam(f, ax, groundAt(ax, az) + 0.1, az, bx, groundAt(bx, bz) + 0.16, bz, 0.3, 0xa89f8a);
    beam(f, x, groundAt(x, z) + 0.14, z, x + Math.sin(a) * 0.9, groundAt(x, z) + 0.55, z - Math.cos(a) * 0.9, 0.14, 0x9a917d);
  }
}

// ── Dock Seven ───────────────────────────────────────────────────────────────

const QUAY = { x0: 362, x1: 540, zLand: 462, zSea: 480, edge: 483.5 };
const SHIP = { x0: 394, x1: 506, z: 541, hb: 8 };

function crane(K: Kit, x: number, hex: number, load: boolean): void {
  const f = K.f, Q = QUAY, hw = 10, LEG = 30, GY = 31.5, tip = SHIP.z + 9, back = Q.zLand - 12;
  for (const sx of [-1, 1]) {
    const lx = x + sx * hw;
    for (const z of [Q.zLand, Q.zSea]) {
      f.box(lx, 0, z, 3.4, 0.9, 1.8, STEEL, 0, 5);                 // bogie
      f.box(lx, 0.9, z, 1.3, LEG, 1.3, hex, 0, 4);
      K.col.addBoxC(lx, z, 1.6, 1.8, LEG);
    }
    // Side frames: a high sill (cars pass under it), a top beam, and one diagonal.
    f.box(lx, 11, (Q.zLand + Q.zSea) / 2, 1.0, 1.1, Q.zSea - Q.zLand, hex, 0, 7);
    f.box(lx, LEG - 0.3, (Q.zLand + Q.zSea) / 2, 1.1, 1.3, Q.zSea - Q.zLand + 1.3, hex, 0, 7);
    beam(f, lx, 12, Q.zLand, lx, LEG - 0.5, Q.zSea, 0.7, hex);
    // A-frame mast over the seaward legs, and the stays that hold the boom up.
    beam(f, lx, LEG, Q.zSea, x + sx * 2.6, 47, Q.zSea - 3, 0.9, hex);
    beam(f, lx, LEG, Q.zLand, x + sx * 2.6, 47, Q.zSea - 3, 0.6, hex);
    beam(f, x + sx * 2.6, 47, Q.zSea - 3, x + sx * 3, GY + 1.8, tip - 14, 0.3, STEEL);
    beam(f, x + sx * 2.6, 47, Q.zSea - 3, x + sx * 3, GY + 1.8, Q.zSea + 28, 0.3, STEEL);
    beam(f, x + sx * 2.6, 47, Q.zSea - 3, x + sx * 3, GY + 1.8, back + 2, 0.3, STEEL);
    // Boom girders, one each side of the trolley track.
    f.box(x + sx * 3, GY, (tip + back) / 2, 0.9, 1.9, tip - back, hex, 0, 7);
  }
  for (const z of [Q.zLand, Q.zSea]) {
    f.box(x, 11, z, hw * 2, 1.1, 1.0, hex, 0, 7);
    f.box(x, LEG - 0.3, z, hw * 2 + 1.1, 1.3, 1.1, hex, 0, 7);
  }
  f.box(x, 46.6, Q.zSea - 3, 6.2, 0.8, 0.9, hex, 0, 7);
  K.lamp.box(x, 47.4, Q.zSea - 3, 0.5, 0.5, 0.5, BONE, 0, 5);
  K.halo(x, 47.7, Q.zSea - 3, 3, 0, 0x8a2a14); K.halo(x, 47.7, Q.zSea - 3, 3, Math.PI / 2, 0x8a2a14);
  for (let z = back + 3; z < tip; z += 9) f.box(x, GY + 0.6, z, 6.4, 0.5, 0.5, hex, 0, 7);
  // Machinery house on the back of the boom, bone with a navy roof.
  f.box(x, GY + 1.9, back + 8, 7.5, 4.2, 9, BONE, 0, 5);
  f.box(x, GY + 6.1, back + 8, 7.9, 0.3, 9.4, INK, 0, 7);
  f.box(x, GY + 3.2, back + 8, 7.56, 1, 6, 0x1d3557, 0, 4);
  // Trolley, operator's cab and the spreader hanging from it.
  const tz = load ? SHIP.z - 4 : Q.zSea + 14;
  f.box(x, GY - 0.5, tz, 5.2, 0.6, 3.4, STEEL, 0, 7);
  f.box(x + 3.6, GY - 3.3, tz + 2.6, 2.3, 2.6, 2.6, BONE, 0, 7);
  f.box(x + 3.6, GY - 2.3, tz + 2.6, 2.36, 0.9, 2.66, 0x1d3557, 0, 4);
  const sy = load ? 19 : 25;
  for (const cx of [-1, 1]) for (const cz of [-1, 1]) f.box(x + cx * 1.9, sy, tz + cz * 1, 0.09, GY - 0.5 - sy, 0.09, INK, 0, 4);
  f.box(x, sy - 0.4, tz, 5.6, 0.4, 2.5, MUST, 0, 7);
  if (load) box20(K.cont, x, sy - 0.4 - 2.6, tz, 6.1, TEAL, true);
  // Floodlights under the sill, lighting the apron.
  for (const sx of [-1, 1]) K.lamp.box(x + sx * 5, 10.8, Q.zSea, 1.2, 0.2, 0.6, BONE, 0, 6);
  K.pool(x, 0.1, (Q.zLand + Q.zSea) / 2 + 2, 46, 0x6e6247);
}

/** A shipping container lying along X, centered on (cx, cz), base at y0. `len` is its length (6.1 or 12.2). */
function box20(b: Batch, cx: number, y0: number, cz: number, len: number, hex: number, top: boolean): void {
  const hl = len / 2, hw = 1.22, y1 = y0 + 2.6, U = CONTAINER_UV;
  const u1 = len / 12.2, uo = len > 7 ? 0 : 0.5;
  b.quad(cx - hl, y0, cz + hw, cx + hl, y0, cz + hw, cx + hl, y1, cz + hw, cx - hl, y1, cz + hw, hex, uo, U.side.v0, uo + u1, U.side.v1);
  b.quad(cx + hl, y0, cz - hw, cx - hl, y0, cz - hw, cx - hl, y1, cz - hw, cx + hl, y1, cz - hw, hex, uo, U.side.v0, uo + u1, U.side.v1);
  b.quad(cx + hl, y0, cz + hw, cx + hl, y0, cz - hw, cx + hl, y1, cz - hw, cx + hl, y1, cz + hw, hex, U.door.u0, U.door.v0, U.door.u1, U.door.v1);
  b.quad(cx - hl, y0, cz - hw, cx - hl, y0, cz + hw, cx - hl, y1, cz + hw, cx - hl, y1, cz - hw, hex, U.back.u0, U.back.v0, U.back.u1, U.back.v1);
  if (top) b.quad(cx - hl, y1, cz + hw, cx + hl, y1, cz + hw, cx + hl, y1, cz - hw, cx - hl, y1, cz - hw, hex, U.roof.u0, U.roof.v0, U.roof.u1, U.roof.v1, 0.9);
}

function buildHarbor(K: Kit): void {
  K.place('harbor');
  const f = K.f, Q = QUAY, rng = new RNG(7707);

  // Quay apron: painted concrete, crane rails and a hatched edge. Decals, so they lie on the ground as it is.
  const D = K.decal;
  const dq = (x0: number, z0: number, x1: number, z1: number, hex: number): void => D.quad(x0, 0, z1, x1, 0, z1, x1, 0, z0, x0, 0, z0, hex);
  dq(Q.x0, Q.zLand - 14, Q.x1, Q.edge, CONCRETE);
  for (const z of [Q.zLand, Q.zSea]) for (const o of [-0.75, 0.75]) dq(Q.x0, z + o - 0.09, Q.x1, z + o + 0.09, 0x3b4048);
  // The beach is flat out to the edge and then shelves slowly, so a decal alone ends in the shallows with no face to it. Past the edge the
  // apron is a real slab with a wall down below the waterline, a fender strip and a kerb. Walkers cannot stand on it (ground is the plan's), so it is solid.
  const QT = 0.02, WZ = 506, WB = WATER_Y - 1.6;
  f.floor(Q.x0, Q.edge - 0.1, Q.x1, WZ, QT, CONCRETE);
  for (let x = Q.x0; x < Q.x1; x += 3) f.floor(x, Q.edge + 0.2, x + 1.5, Q.edge + 1.2, QT + 0.01, MUST);
  oq(f, Q.x0, WB, WZ, Q.x1, WB, WZ, Q.x1, QT, WZ, Q.x0, QT, WZ, 0, 0, 1, CONCRETE, 0.8);
  oq(f, Q.x0, WB, Q.edge, Q.x0, WB, WZ, Q.x0, QT, WZ, Q.x0, QT, Q.edge, -1, 0, 0, CONCRETE, 0.7);
  oq(f, Q.x1, WB, Q.edge, Q.x1, WB, WZ, Q.x1, QT, WZ, Q.x1, QT, Q.edge, 1, 0, 0, CONCRETE, 0.7);
  for (let x = Q.x0 + 3; x < Q.x1; x += 7) oq(f, x, WATER_Y - 1.2, WZ + 0.12, x + 0.7, WATER_Y - 1.2, WZ + 0.12, x + 0.7, QT - 0.1, WZ + 0.12, x, QT - 0.1, WZ + 0.12, 0, 0, 1, INK);
  f.box((Q.x0 + Q.x1) / 2, QT, WZ - 0.2, Q.x1 - Q.x0, 0.22, 0.4, STONE, 0, 5, 0.95);
  K.col.addBox(Q.x0, Q.edge, Q.x1, WZ, 0.9, -3);
  // Low kerbs frame the landward side so the slab reads as laid down, not as a decal that wandered onto the sand.
  f.box((Q.x0 + Q.x1) / 2, 0, Q.zLand - 14, Q.x1 - Q.x0, 0.12, 0.3, STONE, 0, 5, 0.9);
  f.box(Q.x0, 0, (Q.zLand - 14 + Q.edge) / 2, 0.3, 0.12, Q.edge - Q.zLand + 14, STONE, 0, 5, 0.9);
  for (let x = Q.x0 + 6; x < Q.x1; x += 14) {
    f.cyl(x, QT, WZ - 0.9, 0.3, 0.26, 0.6, INK, 7, false);
    f.cyl(x, QT + 0.6, WZ - 0.9, 0.42, 0.42, 0.16, INK, 7);
    K.col.addProp(x, WZ - 0.9, 0.42, 0.8, 'post', false);
  }

  crane(K, 410, VERM, false);
  crane(K, 452, MUST, true);
  crane(K, 494, VERM, false);

  // The coaster alongside: navy hull, vermilion boot-topping, bone house aft, mustard funnel. Bow to the east.
  const S = SHIP, DK = 4.6, KEEL = -3.2, bowX = S.x1 + 16;
  K.col.addBox(S.x0, S.z - S.hb, S.x1 + 8, S.z + S.hb, DK + 1, KEEL);
  const hullBand = (y0: number, y1: number, hex: number, out: number): void => {
    const hb = S.hb + out;
    for (const s of [-1, 1]) {
      oq(f, S.x0 - out, y0, S.z + s * hb, S.x1, y0, S.z + s * hb, S.x1, y1, S.z + s * hb, S.x0 - out, y1, S.z + s * hb, 0, 0, s, hex);
      oq(f, S.x1, y0, S.z + s * hb, bowX + out, y0, S.z, bowX + out + (y1 > 2 ? 2.5 : 0), y1, S.z, S.x1, y1, S.z + s * hb, 0.4, 0, s, hex, 0.92);
    }
    oq(f, S.x0 - out, y0, S.z - hb, S.x0 - out, y0, S.z + hb, S.x0 - out, y1, S.z + hb, S.x0 - out, y1, S.z - hb, -1, 0, 0, hex, 0.85);
  };
  hullBand(KEEL, DK, INK, 0);
  hullBand(WATER_Y - 0.5, WATER_Y + 0.9, VERM, 0.06);
  hullBand(DK - 0.5, DK - 0.25, BONE, 0.06);
  f.floor(S.x0, S.z - S.hb, S.x1, S.z + S.hb, DK, 0x7d8a86);
  otri(f, S.x1, DK, S.z - S.hb, S.x1, DK, S.z + S.hb, bowX + 2.5, DK, S.z, 0, 1, 0, 0x7d8a86);
  for (const s of [-1, 1]) {   // bulwark at the bow
    oq(f, S.x1 - 10, DK, S.z + s * S.hb, S.x1, DK, S.z + s * S.hb, S.x1, DK + 1.6, S.z + s * S.hb, S.x1 - 10, DK + 1.6, S.z + s * S.hb, 0, 0, s, INK);
    oq(f, S.x1, DK, S.z + s * S.hb, bowX + 2.5, DK, S.z, bowX + 3.2, DK + 1.6, S.z, S.x1, DK + 1.6, S.z + s * S.hb, 0.4, 0, s, INK, 0.92);
    oq(K.dbl, S.x1 - 10, DK + 0.01, S.z + s * (S.hb - 0.05), S.x1, DK + 0.01, S.z + s * (S.hb - 0.05), S.x1, DK + 1.6, S.z + s * (S.hb - 0.05), S.x1 - 10, DK + 1.6, S.z + s * (S.hb - 0.05), 0, 0, -s, BONE, 0.8);
  }
  f.cyl(S.x1 + 6, DK, S.z, 0.25, 0.15, 9, BONE, 5);
  // Accommodation block aft.
  const hx = S.x0 + 11;
  f.box(hx, DK, S.z, 14, 5.6, 14, BONE, 0, 5);
  f.box(hx, DK + 5.6, S.z, 11, 2.8, 12, BONE, 0, 5, 0.96);
  f.box(hx + 0.5, DK + 8.4, S.z, 8, 2.8, 17, BONE, 0, 7);
  f.box(hx + 0.6, DK + 9.5, S.z, 8.06, 1.0, 17.06, 0x1d3557, 0, 4);
  for (const y of [DK + 2.2, DK + 6.6]) f.box(hx, y, S.z, 14.06 - (y > DK + 5 ? 3 : 0), 0.8, 14.06 - (y > DK + 5 ? 2 : 0), 0x1d3557, 0, 4);
  f.box(hx - 3, DK + 11.2, S.z, 3.6, 5, 3, MUST, 0, 5);
  f.box(hx - 3, DK + 15, S.z, 3.7, 1.2, 3.1, INK, 0, 5);
  f.cyl(hx + 3, DK + 11.2, S.z, 0.2, 0.1, 7, BONE, 5);
  f.box(hx + 3, DK + 16, S.z, 0.3, 0.2, 5, BONE, 0, 7);
  K.lamp.box(hx + 3, DK + 18.2, S.z, 0.4, 0.4, 0.4, BONE, 0, 5);
  for (const s of [-1, 1]) K.lamp.box(hx + 4.6, DK + 9.6, S.z + s * 6, 0.1, 0.7, 3, BONE, 0, 4);
  // Deck cargo: five bays of forty-footers, six across, stacked unevenly; the bay under the working crane is half unloaded.
  const tints = [VERM, TEAL, MUST, BONE, BRICK, 0x3a6ea5, SAGE, TERRA];
  for (let bay = 0; bay < 6; bay++) {
    const bxx = S.x0 + 28 + bay * 13.1;
    for (let row = 0; row < 6; row++) {
      const tiers = bay === 2 ? (row < 3 ? 1 : 0) : rng.int(2, 4);
      for (let t = 0; t < tiers; t++) box20(K.cont, bxx, DK + 0.2 + t * 2.6, S.z + (row - 2.5) * 2.5, 12.2, tints[rng.int(0, tints.length - 1)], t === tiers - 1);
    }
  }
  // Mooring lines to the quay.
  for (const x of [S.x0 + 4, S.x1 - 4]) beam(f, x, DK, S.z - S.hb, x + (x < 450 ? -8 : 8), 0.6, 505.1, 0.12, BONE);
}

// ── Strand block interiors ───────────────────────────────────────────────────

/**
 * Behind its shop rows a Strand block was one bare slab of planking. Each core is now tiled with
 * pads, and every pad that is clear of buildings and parking courts becomes a planted bed, a row
 * of painted stalls or a paved court under trees. The trees, shrubs and hedges are requests to the
 * ground's tree field (plantExtra), so they arrive with the Blender models; phones get a clipped
 * green block in the beds instead.
 */
function buildStrandCores(K: Kit): void {
  K.place('strand');
  const rng = new RNG(8841), plan = K.game.plan, col = K.col, f = K.f, low = K.game.quality.name === 'low';
  const GREEN = [0x6f9a50, 0x82aa5a, 0x5e8b4b, 0x7f9c54], SOIL = 0x4d3c2c, Y = CURB + 0.05;
  const free = (x0: number, z0: number, x1: number, z1: number): boolean => {
    let ok = true;
    col.forBoxes((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 2, (b) => {
      if (b.x0 < x1 + 1 && b.x1 > x0 - 1 && b.z0 < z1 + 1 && b.z1 > z0 - 1 && b.y0 < 4) ok = false;
    });
    return ok;
  };
  const tree = (kind: string, x: number, y: number, z: number): void => {
    const h = rng.range(0, TAU), hex = rng.pick(GREEN);
    if (kind === 'palm') {
      const th = rng.range(6, 8.5);
      plantExtra('palmtrunk', x, y, z, h, 1, 0xffffff, 1, th / 8);
      plantExtra('palmcrown', x, y + th, z, h + 1, rng.range(0.85, 1.05), hex);
    } else plantExtra(kind, x, y, z, h, rng.range(0.6, 0.8), hex);
    col.addProp(x, z, 0.3, y + 8, 'tree', false);
  };
  const PW = 13, PD = 9, GAP = 3;
  for (const blk of plan.blocks) {
    if (blk.district !== 'strand') continue;
    const r = blk.rect, m = SIDEWALK + 16.5;
    const c = { x0: r.x0 + m, x1: r.x1 - m, z0: r.z0 + m, z1: r.z1 - m }, W = c.x1 - c.x0, D = c.z1 - c.z0;
    if (W < PW + 1 || D < PD + 1) continue;
    const courts = plan.lots.filter((l) => l.block === blk.id && l.interior).map((l) => l.rect);
    const nx = Math.floor((W + GAP) / (PW + GAP)), nz = Math.floor((D + GAP) / (PD + GAP));
    const sx = (W - nx * PW) / (nx + 1), sz = (D - nz * PD) / (nz + 1);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x0 = c.x0 + sx + i * (PW + sx), z0 = c.z0 + sz + j * (PD + sz), x1 = x0 + PW, z1 = z0 + PD;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, roll = rng.next();
      if (courts.some((q) => q.x0 < x1 + 1 && q.x1 > x0 - 1 && q.z0 < z1 + 1 && q.z1 > z0 - 1) || !free(x0, z0, x1, z1)) continue;
      if (roll < 0.4) {
        // A raised bed: stone kerb, dark soil, a hedge down each long side, shrubs between and a palm or two.
        f.box(cx, CURB, cz, PW - 1, 0.5, PD - 1, STONE, 0, 5);
        f.floor(x0 + 0.85, z0 + 0.85, x1 - 0.85, z1 - 0.85, CURB + 0.51, SOIL);
        col.addBoxC(cx, cz, PW - 1, PD - 1, CURB + 0.5);
        if (low) f.box(cx, CURB + 0.5, cz, PW - 2.4, 0.6, PD - 2.4, 0x4f7a45, 0, 5);
        for (let hx = x0 + 1.9; hx < x1 - 1.6; hx += 2) for (const hz of [z0 + 1.25, z1 - 1.25]) plantExtra('hedge', hx, CURB + 0.5, hz, 0, 1, 0x5e8b4b);
        for (let k = 0; k < 8; k++) plantExtra('shrub', rng.range(x0 + 1.8, x1 - 1.8), CURB + 0.45, rng.range(z0 + 2.2, z1 - 2.2), rng.range(0, TAU), rng.range(0.9, 1.5), rng.pick(GREEN));
        tree('palm', cx - 3 + rng.range(-0.6, 0.6), CURB + 0.45, cz + rng.range(-0.8, 0.8));
        if (rng.chance(0.6)) tree('palm', cx + 3 + rng.range(-0.6, 0.6), CURB + 0.45, cz + rng.range(-0.8, 0.8));
      } else if (roll < 0.72) {
        // Parking: asphalt, painted stalls with wheel stops, and a hedge in a kerbed strip along the back.
        f.floor(x0, z0, x1, z1, Y, 0x55585b);
        for (let s = x0 + 0.5; s < x1 - 0.3; s += 2.4) {
          K.decal.floor(s - 0.06, z0 + 0.5, s + 0.06, z0 + 5.5, Y, 0xe6e0d0);
          if (s + 2.4 < x1 - 0.3) f.box(s + 1.2, Y, z0 + 1.0, 1.7, 0.13, 0.22, CONCRETE, 0, 5);
        }
        f.box(cx, CURB, z1 - 0.7, PW, 0.32, 1.2, STONE, 0, 5);
        f.floor(x0 + 0.2, z1 - 1.1, x1 - 0.2, z1 - 0.3, CURB + 0.33, SOIL);
        col.addBoxC(cx, z1 - 0.7, PW, 1.2, CURB + 0.32);
        if (low) f.box(cx, CURB + 0.32, z1 - 0.7, PW - 0.6, 0.7, 0.7, 0x4f7a45, 0, 5);
        for (let hx = x0 + 1.2; hx < x1 - 0.9; hx += 2) plantExtra('hedge', hx, CURB + 0.3, z1 - 0.7, 0, 1, 0x5e8b4b);
      } else {
        // A cobbled court: a tree in a pit at each corner, a planted tub in the middle, benches facing it.
        wfloor(K.cobble, x0, z0, x1, z1, Y, 0xffffff, TILE_M.cobble);
        const kind = rng.chance(0.5) ? 'plane' : 'maple';
        for (const tx of [x0 + 2.2, x1 - 2.2]) for (const tz of [z0 + 2, z1 - 2]) {
          K.decal.floor(tx - 0.7, tz - 0.7, tx + 0.7, tz + 0.7, Y, 0x3a2e24);
          tree(kind, tx, CURB, tz);
        }
        f.cyl(cx, Y, cz, 1.05, 1.2, 0.62, TERRA, 12, false);
        f.cyl(cx, Y + 0.5, cz, 1.08, 1.08, 0.04, SOIL, 12);
        col.addProp(cx, cz, 1.25, 1.1, 'bench', false);
        for (let k = 0; k < 3; k++) plantExtra('shrub', cx + rng.range(-0.4, 0.4), Y + 0.5, cz + rng.range(-0.4, 0.4), rng.range(0, TAU), rng.range(0.8, 1.1), rng.pick(GREEN));
        bench(K, cx, z0 + 1.1, 0);
        bench(K, cx, z1 - 1.1, Math.PI);
      }
    }
  }
}

// ── Out on the water ─────────────────────────────────────────────────────────

/** Walk out from the middle of the island along bearing th (0 = east, PI/2 = south) until the coast is `sd` meters behind. */
function offshore(th: number, sd: number): { x: number; z: number } {
  const c = Math.cos(th), s = Math.sin(th);
  for (let r = 300; r < 1400; r += 2) if (islandSD(c * r, -5 + s * r) >= sd) return { x: c * r, z: -5 + s * r };
  return { x: c * 1400, z: s * 1400 };
}

function buildRocks(K: Kit): void {
  K.place('harbor');
  const f = K.f, rng = new RNG(311);
  // Bearings chosen to miss the pier and duck (due south), the breakwater (east-south-east) and the bridge (due north).
  for (const [th, sd] of [[2.05, 70], [2.5, 55], [1.02, 150], [-0.45, 60], [3.6, 65], [-2.0, 80], [-1.05, 70]] as const) {
    const p = offshore(th, sd);
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const r = rng.range(2.2, 5.5) * (i === 0 ? 1.3 : 0.8), a = rng.range(0, TAU), dd = i === 0 ? 0 : rng.range(4, 9);
      const x = p.x + Math.cos(a) * dd, z = p.z + Math.sin(a) * dd, h = r * rng.range(0.5, 0.95);
      f.cyl(x, WATER_Y - 2.5, z, r * 1.25, r * 0.8, 2.5 + h * 0.55, 0x6b6558, 7, false, 0.9);
      f.cyl(x + rng.range(-0.4, 0.4), WATER_Y + h * 0.55, z + rng.range(-0.4, 0.4), r * 0.8, r * 0.35, h * 0.45, 0x7c7566, 7);
      // Tide stain round the foot.
      f.cyl(x, WATER_Y - 0.1, z, r * 1.02, r * 0.99, 0.5, 0x3f4a44, 7, false);
      if (i === 0) K.col.addBoxC(x, z, r * 1.4, r * 1.4, WATER_Y + h, WATER_Y - 3);
    }
  }
}

interface Floater { x: number; z: number; h: number; ph: number; amp: number; s: number }

function boatGeometry(): THREE.BufferGeometry {
  // Faces +Z. Everything is near-white because the instance colour paints it.
  const b = new Batch(), hb = 1.2, y0 = -0.5, y1 = 0.6, zs = -3, zm = 1.3, zt = 3.5;
  const HULL = 0xffffff, DARK = 0x4a4a4a;
  for (const s of [-1, 1]) {
    oq(b, s * hb, y0, zs, s * hb, y0, zm, s * hb, y1, zm, s * hb, y1, zs, s, 0, 0, HULL, 0.9);
    oq(b, s * hb, y0, zm, 0, y0, zt - 0.5, 0, y1 + 0.25, zt, s * hb, y1, zm, s, 0, 0.5, HULL, 0.82);
    oq(b, s * (hb + 0.04), y1 - 0.22, zs, s * (hb + 0.04), y1 - 0.22, zm, s * (hb + 0.04), y1 - 0.06, zm, s * (hb + 0.04), y1 - 0.06, zs, s, 0, 0, DARK);
  }
  oq(b, -hb, y0, zs, hb, y0, zs, hb, y1, zs, -hb, y1, zs, 0, 0, -1, HULL, 0.75);
  b.floor(-hb, zs, hb, zm, y1 - 0.25, 0xd8d0c0);
  otri(b, -hb, y1 - 0.25, zm, hb, y1 - 0.25, zm, 0, y1, zt - 0.1, 0, 1, 0, 0xd8d0c0);
  b.box(0, y1 - 0.25, -1.2, 1.6, 1.6, 1.8, 0xffffff, 0, 5);
  b.box(0, y1 + 0.55, -1.2, 1.64, 0.45, 1.84, 0x39424a, 0, 4);
  b.box(0, y1 + 1.35, -1.1, 1.9, 0.1, 2.3, DARK, 0, 7);
  b.cyl(0, y1 - 0.25, 0.5, 0.06, 0.04, 3.4, DARK, 4, false);
  beam(b, 0, y1 + 1.6, 0.5, 0, y1 + 0.9, 2.6, 0.07, DARK);
  b.box(0.5, y1 - 0.25, -2.5, 0.7, 0.45, 0.7, 0xffc94d, 0, 5);
  return b.toGeometry();
}

function buoyGeometry(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, -0.5, 0, 0.75, 0.75, 1.0, 0xffffff, 8);
  b.cyl(0, 0.5, 0, 0.5, 0.14, 1.7, 0xffffff, 4, false, 0.85);
  b.cyl(0, 2.2, 0, 0.22, 0.22, 0.3, 0xfff2c0, 6);
  b.cyl(0, 0.38, 0, 0.78, 0.78, 0.14, 0x555555, 8, false);
  return b.toGeometry();
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildPlaces(game: Game, mats: CityMaterials, parent: THREE.Group): WorldPart {
  const group = new THREE.Group();
  group.name = 'places';
  parent.add(group);

  const K = new Kit(game, mats);
  buildPark(K);
  buildArena(K);
  buildBillboards(K);
  buildPosters(K);
  buildBeach(K);
  buildHarbor(K);
  buildRocks(K);
  buildStrandCores(K);

  // Lamp faces share one material whose glow setNight() turns up. Warm, a touch brighter than the sodium street lamps.
  const lampMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffdf9a, emissiveIntensity: 0 });
  K.build(group, lampMat);

  // Fishing boats at moorings in the east and south-east, and channel buoys off Dock Seven.
  const boats: Floater[] = [], buoys: Floater[] = [];
  const rng = new RNG(5150);
  for (const [th, sd] of [[-0.34, 46], [-0.2, 70], [-0.06, 40], [0.08, 62], [0.62, 60], [0.7, 96], [1.12, 58], [1.24, 84], [1.3, 44], [1.92, 60]] as const) {
    const p = offshore(th, sd);
    boats.push({ x: p.x, z: p.z, h: rng.range(0, TAU), ph: rng.range(0, TAU), amp: rng.range(0.8, 1.2), s: rng.range(0.9, 1.25) });
  }
  for (const [th, sd] of [[0.74, 150], [0.8, 210], [0.98, 150], [1.04, 210], [1.4, 120], [1.76, 120], [0.14, 110], [-0.5, 110], [2.3, 100]] as const) {
    const p = offshore(th, sd);
    buoys.push({ x: p.x, z: p.z, h: rng.range(0, TAU), ph: rng.range(0, TAU), amp: 1.5, s: 1 });
  }
  const instanced = (geo: THREE.BufferGeometry, list: Floater[], tints: number[]): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(geo, mats.flat, list.length);
    const c = new THREE.Color();
    list.forEach((_, i) => im.setColorAt(i, c.setHex(tints[i % tints.length])));
    im.castShadow = true;
    // They are spread round half the island; a bounding sphere that size would never cull anyway.
    im.frustumCulled = false;
    group.add(im);
    return im;
  };
  const boatMesh = instanced(boatGeometry(), boats, [0xf2e8cf, 0x58b3a4, 0xea8262, 0xf3c14e, 0xdfe7e2, 0x6c8fb0]);
  const buoyMesh = instanced(buoyGeometry(), buoys, [VERM, TEAL]);

  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Qn = new THREE.Quaternion(), Sc = new THREE.Vector3(), E = new THREE.Euler(0, 0, 0, 'YXZ');
  let t = 0;
  const float = (im: THREE.InstancedMesh, list: Floater[], lift: number): void => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      // Three unrelated periods so no two boats ever nod in step. They also swing slowly on their moorings.
      P.set(b.x, WATER_Y + lift + Math.sin(t * 0.9 + b.ph) * 0.11 * b.amp, b.z);
      E.set(Math.sin(t * 1.13 + b.ph * 2) * 0.035 * b.amp, b.h + Math.sin(t * 0.07 + b.ph) * 0.25, Math.sin(t * 0.71 + b.ph * 3) * 0.06 * b.amp);
      Qn.setFromEuler(E);
      Sc.setScalar(b.s);
      im.setMatrixAt(i, M.compose(P, Qn, Sc));
    }
    sendRange(im.instanceMatrix, list.length * 16);
  };
  float(boatMesh, boats, 0.12);
  float(buoyMesh, buoys, 0.1);
  // Rewritten every frame they are near: the driver should keep these in memory, not treat each write as a new static mesh.
  boatMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); buoyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  flip.mesh(boatMesh); flip.mesh(buoyMesh);
  /** Past this from the nearest of them a bob is under a pixel, and they are moved eight times a second, not sixty. */
  const BOB_NEAR2 = 300 * 300;
  let bobSkip = 0;

  // Boats hauled out above the tide line on the east shore, bows inland, heeled over on their bilges.
  {
    const ths = [-0.46, -0.37, -0.3, -0.17, -0.06, 0.04, 0.12, 0.2], tints = [0xf2e8cf, 0x58b3a4, 0xea8262, 0xf3c14e, 0xdfe7e2, 0x6c8fb0];
    const hauled = new THREE.InstancedMesh(boatGeometry(), mats.flat, ths.length), c = new THREE.Color();
    ths.forEach((th, i) => {
      const p = offshore(th, -19 - (i % 3) * 4), y = groundAt(p.x, p.z);
      E.set(rng.range(-0.03, 0.05), Math.atan2(-p.x, -(p.z + 5)) + rng.range(-0.6, 0.6), (i % 2 ? 1 : -1) * rng.range(0.17, 0.27));
      hauled.setMatrixAt(i, M.compose(P.set(p.x, y + 0.62, p.z), Qn.setFromEuler(E), Sc.setScalar(rng.range(0.85, 1.1))));
      hauled.setColorAt(i, c.setHex(tints[i % tints.length]));
      game.col.addBoxC(p.x, p.z, 3.2, 3.2, y + 1.6);
    });
    hauled.castShadow = true; hauled.receiveShadow = true;
    hauled.frustumCulled = false;
    group.add(hauled);
  }

  return {
    update(dt: number): void {
      t += dt;
      const cam = game.camera.position;
      let near = false;
      for (const list of [boats, buoys]) for (const b of list) { const dx = b.x - cam.x, dz = b.z - cam.z; if (dx * dx + dz * dz < BOB_NEAR2) { near = true; break; } }
      if (!near && ++bobSkip % 8) return;
      float(boatMesh, boats, 0.12);
      float(buoyMesh, buoys, 0.1);
    },
    setNight(n: number): void {
      lampMat.emissiveIntensity = n * 1.5;
    },
  };
}
