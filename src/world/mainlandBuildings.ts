// Tepid Falls, built: everything that stands on plan.mainlandLots and mainland.ts EXTRA_LOTS.
//
// HOW IT IS PUT TOGETHER
//   * One wall sheet (textures.ts MWALL) carries every wall, roof, window, door and shopfront
//     in town, so the whole mainland is three or four materials: `wall`, the shared `flat`,
//     the mainland's own sign atlas, and the shared fence strip. Geometry is merged per
//     material into 300 m chunks (MainKit), and the lot is hidden from the island altogether.
//   * Depth is real where the player walks past it: window openings are cut into the wall and
//     the sash set back in a reveal, sills and cornices stand proud, shop doors are recessed,
//     porches are posts and decks. Side and back walls are flat bands with windows laid on.
//     The low preset keeps the cut walls but drops reveals, sills and porch rails.
//   * Walls are described in a Frame, as in buildings.ts: s runs left to right AS SEEN FROM
//     OUTSIDE, so a sign can never come out mirrored whichever way the wall faces.
//   * Each lot has its own RNG seeded from its index.
//   * mainlandPlaces.ts (landmarks) draws into the same kit and calls kit.finish() last.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials, Surface } from './materials';
import { Batch } from './batch';
import { CURB, groundAt, type Block, type Lot, type Rect } from './plan';
import { FENCE_UV, MAIN_SHOPS, MWALL, makeMainlandTextures, mwallV, signKey, type MainlandTextures } from './textures';
import { RNG } from '../core/util';
import { FASCIA_OUT, MainStreet } from './mainStreetAssets';
import { PardonsStore } from './pardonsStore';

const CELL = MWALL.cell, ROW = MWALL.rows, RED = MWALL.redBrick;
/** Edge of a chunk of town. Small enough that the shadow pass and the distance cull below drop most of the town most of the time. */
const CH = 150;
const STONE = 0xcfcac0, TAR = 0x4a4b4d, IRON = 0x2e3338, WHITE = 0xf1ede2;

/** Brick for the flat-lintel blocks: buff, brown, painted cream, painted grey-green, liver, ochre. The arched ones are all MWALL.redBrick. */
const BRICKS = [0xcdb48c, 0x7f4a40, 0xd8cdb4, 0x9aa69a, 0x8a4233, 0xb98a5a, 0xc56a4c];
/** Shopfront paint: bottle green, oxblood, navy, black, cream, teal, mustard. */
const SHOPCOL = [0x2c4a3a, 0x6a2620, 0x25395c, 0x26282b, 0xd9cfb4, 0x2f5a57, 0xb8892e];
const AWNING = [0x8c2f25, 0x2c4a3a, 0x25395c, 0xd9cfb4, 0xc9892e, 0x3c3c3c];
/** House paint: weathered whites and greys first (they come up most), then barn red, mustard, sage, cream, moss, tan, slate. */
const PAINT = [0xe8e4d8, 0xddd9cc, 0xe8e4d8, 0xc4c6c0, 0xa3a8a6, 0x8f9a9c, 0x8a3b2e, 0xc7a544, 0x97a685, 0xd8c9a0, 0x7d8a72, 0xb9a48a, 0x6f7d8c, 0x8a3b2e];
const ROOF = [0x4b4e53, 0x5b4d45, 0x3f4744, 0x6b6e70, 0x4a3f3a];
const DOORC = [0x7a2a22, 0x2c4a3a, 0x25395c, 0xe8e2d0, 0x3a3a3a, 0x8a6a3a];
const STORES = ['m-variety', 'm-store3', 'm-superette', 'm-store4', 'm-store5', 'm-store6', 'm-store7', 'm-store8'];
/** How far a house's wall stands back from the front of its lot: the porch and a strip of yard. */
const SET = 3.2;

/** One wall side of a rect. s runs left to right seen from outside; (nx, nz) points outward. */
export interface Frame { ox: number; oz: number; tx: number; tz: number; nx: number; nz: number; len: number; depth: number }

export function frameOf(r: Rect, side: number): Frame {
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  switch (side & 3) {
    case 0: return { ox: r.x1, oz: r.z0, tx: -1, tz: 0, nx: 0, nz: -1, len: w, depth: d };
    case 1: return { ox: r.x1, oz: r.z1, tx: 0, tz: -1, nx: 1, nz: 0, len: d, depth: w };
    case 2: return { ox: r.x0, oz: r.z1, tx: 1, tz: 0, nx: 0, nz: 1, len: w, depth: d };
    default: return { ox: r.x0, oz: r.z0, tx: 0, tz: 1, nx: -1, nz: 0, len: d, depth: w };
  }
}
export const PX = (f: Frame, s: number, o: number): number => f.ox + f.tx * s + f.nx * o;
export const PZ = (f: Frame, s: number, o: number): number => f.oz + f.tz * s + f.nz * o;

/** The part of `r` between s0..s1 along side `side` and d0..d1 meters in from that side. */
export function cut(r: Rect, side: number, s0: number, s1: number, d0: number, d1: number): Rect {
  const f = frameOf(r, side);
  const ax = PX(f, s0, -d0), az = PZ(f, s0, -d0), bx = PX(f, s1, -d1), bz = PZ(f, s1, -d1);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}

/** The rect between s0..s1 along a frame and o0..o1 out from its wall line. */
export function frect(f: Frame, s0: number, s1: number, o0: number, o1: number): Rect {
  const ax = PX(f, s0, o0), az = PZ(f, s0, o0), bx = PX(f, s1, o1), bz = PZ(f, s1, o1);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}

const C = new THREE.Color();
/** hex scaled by k, as a hex (for flat trim that should follow a wall's shade). */
export function dim(hex: number, k: number): number {
  C.setHex(hex, THREE.SRGBColorSpace);
  return (Math.min(255, Math.round(((hex >> 16) & 255) * k)) << 16) | (Math.min(255, Math.round(((hex >> 8) & 255) * k)) << 8) | Math.min(255, Math.round((hex & 255) * k));
}
export function blend(a: number, b: number, t: number): number {
  const m = (sh: number): number => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

class Chunks {
  private map = new Map<string, Batch>();
  at(x: number, z: number): Batch {
    const k = Math.floor(x / CH) + ':' + Math.floor(z / CH);
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = new Batch()));
    return b;
  }
  build(mat: THREE.Material, parent: THREE.Object3D, cast: boolean, out: THREE.Mesh[], near = 0): number {
    let tris = 0;
    for (const b of this.map.values()) {
      if (b.empty) continue;
      const m = new THREE.Mesh(b.toGeometry(), mat);
      m.castShadow = cast; m.receiveShadow = true; m.matrixAutoUpdate = false;
      m.userData.near = near;
      parent.add(m);
      out.push(m);
      tris += b.idx.length / 3;
    }
    this.map.clear();
    return tris;
  }
}

/** A window style for facade(): atlas row, opening size, sill height above the floor, and whether the piece brings its own brick surround. */
export interface WinStyle { row: number; w: number; h: number; sill: number; own: boolean }
export const WIN = {
  sash: { row: ROW.sash, w: 1.1, h: 2.05, sill: 0.8, own: false },
  arch: { row: ROW.arch, w: 1.2, h: 2.4, sill: 0.6, own: true },
  round: { row: ROW.round, w: 1.25, h: 2.5, sill: 0.55, own: true },
  mill: { row: ROW.mill, w: 1.7, h: 3.0, sill: 0.5, own: true },
  house: { row: ROW.house, w: 0.85, h: 1.6, sill: 0.8, own: false },
} as const;

/** The mainland's batches, materials and the handful of shapes every builder there uses. */
export class MainKit {
  readonly group = new THREE.Group();
  readonly tex: MainlandTextures;
  readonly wallMat: Surface;
  readonly signMat: Surface;
  readonly low: boolean;
  private wall = new Chunks(); private flat = new Chunks(); private sign = new Chunks(); private fence = new Chunks();
  /** Batches of the chunk chosen by at(): wall sheet, flat colour, signs, fence strip. */
  W!: Batch; F!: Batch; S!: Batch; N!: Batch;
  tris = 0;
  private shown = true;
  private meshes: THREE.Mesh[] = [];
  private cullAt = new THREE.Vector3(1e9, 0, 0);

  constructor(readonly game: Game, readonly mats: CityMaterials, parent: THREE.Object3D) {
    this.low = game.quality.name === 'low';
    this.group.name = 'mainland-buildings';
    parent.add(this.group);
    const t = this.tex = makeMainlandTextures(game.quality);
    // Clones of the island's brick and sign materials with the mainland's sheets in them: same shading, night levels copied in setNight().
    const w = this.wallMat = mats.facade[1].clone();
    w.map = t.wall; w.emissiveMap = t.glow;
    if (w instanceof THREE.MeshStandardMaterial) {
      w.roughnessMap = w.metalnessMap = t.pbr ? t.pbr.orm : null;
      w.normalMap = t.pbr && !this.low && game.quality.name === 'high' ? t.pbr.normal : null;
      if (!t.pbr) { w.roughness = 0.85; w.metalness = 0; }
    }
    const s = this.signMat = mats.sign.clone();
    s.map = t.signs.tex; s.emissiveMap = t.signs.tex;
  }

  at(x: number, z: number): void {
    this.W = this.wall.at(x, z); this.F = this.flat.at(x, z); this.S = this.sign.at(x, z); this.N = this.fence.at(x, z);
  }

  /** Turn everything batched so far into meshes. Safe to call more than once. */
  finish(): void {
    const M = this.meshes;
    this.tris += this.wall.build(this.wallMat, this.group, true, M) + this.flat.build(this.mats.flat, this.group, true, M)
      + this.sign.build(this.signMat, this.group, false, M, 420) + this.fence.build(this.mats.fence, this.group, false, M, 300);
    this.cullAt.set(1e9, 0, 0);
  }

  setNight(): void {
    this.wallMat.emissiveIntensity = this.mats.facade[1].emissiveIntensity;
    this.signMat.emissiveIntensity = this.mats.sign.emissiveIntensity;
  }

  update(): void {
    const env = (this.mats.flat as THREE.MeshStandardMaterial).envMap ?? null;
    if ((this.wallMat as THREE.MeshStandardMaterial).envMap !== env && this.wallMat instanceof THREE.MeshStandardMaterial) {
      this.wallMat.envMap = env; if (this.signMat instanceof THREE.MeshStandardMaterial) this.signMat.envMap = env;
    }
    // Same rule as ground.ts: beyond fog range of the far shore, none of it is drawn.
    const far = this.game.quality.drawDist, see = this.game.camera.getWorldPosition(P3).z < -975 + far + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    // Within sight of the shore, a chunk is drawn only once the fog has let go of it: from the island that is the
    // waterfront and nothing behind it. Signs stop at 420 m and fences at 300, where neither can be made out.
    // Looked at again when the camera has moved 15 m, not every frame.
    if (!see || P3.distanceToSquared(this.cullAt) < 225) return;
    this.cullAt.copy(P3);
    for (const m of this.meshes) { const s = m.geometry.boundingSphere; if (s) m.visible = s.center.distanceTo(P3) - s.radius * 0.7 < (m.userData.near || far); }
  }

  solid(r: Rect, top: number, base = 0): void { this.game.col.addBox(r.x0, r.z0, r.x1, r.z1, top, base); }

  // ── Quads on a frame ───────────────────────────────────────────────────────

  /** Vertical quad on the frame, `o` meters out from the wall line, facing out. */
  vq(b: Batch, f: Frame, s0: number, s1: number, y0: number, y1: number, o: number, hex: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, shade = 1): void {
    const ax = PX(f, s0, o), az = PZ(f, s0, o), bx = PX(f, s1, o), bz = PZ(f, s1, o);
    b.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, hex, u0, v0, u1, v1, shade);
  }
  /** Horizontal quad between offsets o0 (inner) and o1 (outer), facing up or down. */
  hq(b: Batch, f: Frame, s0: number, s1: number, o0: number, o1: number, y: number, up: boolean, hex: number, shade = 1, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
    const ax = PX(f, s0, o1), az = PZ(f, s0, o1), bx = PX(f, s1, o1), bz = PZ(f, s1, o1);
    const cx = PX(f, s1, o0), cz = PZ(f, s1, o0), dx = PX(f, s0, o0), dz = PZ(f, s0, o0);
    if (up) b.quad(ax, y, az, bx, y, bz, cx, y, cz, dx, y, dz, hex, u0, v0, u1, v1, shade);
    else b.quad(dx, y, dz, cx, y, cz, bx, y, bz, ax, y, az, hex, u0, v0, u1, v1, shade);
  }
  /** Quad across the wall line at s, from o0 (inner) to o1 (outer); `plus` = seen from the +s side. */
  jq(b: Batch, f: Frame, s: number, o0: number, o1: number, y0: number, y1: number, plus: boolean, hex: number, shade = 1, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
    const ix = PX(f, s, o0), iz = PZ(f, s, o0), ex = PX(f, s, o1), ez = PZ(f, s, o1);
    if (plus) b.quad(ex, y0, ez, ix, y0, iz, ix, y1, iz, ex, y1, ez, hex, u0, v0, u1, v1, shade);
    else b.quad(ix, y0, iz, ex, y0, ez, ex, y1, ez, ix, y1, iz, hex, u0, v0, u1, v1, shade);
  }
  /** Sloped quad from (o0, y0) up or down to (o1, y1), its top face up. */
  sq(b: Batch, f: Frame, s0: number, s1: number, o0: number, y0: number, o1: number, y1: number, hex: number, shade = 1, u0 = 0, v0 = 0, u1 = 1, v1 = 1, under = false): void {
    const ax = PX(f, s0, o1), az = PZ(f, s0, o1), bx = PX(f, s1, o1), bz = PZ(f, s1, o1);
    const cx = PX(f, s1, o0), cz = PZ(f, s1, o0), dx = PX(f, s0, o0), dz = PZ(f, s0, o0);
    if (!under) b.quad(ax, y1, az, bx, y1, bz, cx, y0, cz, dx, y0, dz, hex, u0, v0, u1, v1, shade);
    else b.quad(dx, y0, dz, cx, y0, cz, bx, y1, bz, ax, y1, az, hex, u0, v0, u1, v1, shade);
  }
  /** A bar standing proud of the wall: front, top, underside and both ends. In flat colour. */
  ledge(f: Frame, s0: number, s1: number, y0: number, y1: number, o0: number, o1: number, hex: number, shade = 1, b = this.F): void {
    this.vq(b, f, s0, s1, y0, y1, o1, hex, 0, 0, 1, 1, shade);
    this.hq(b, f, s0, s1, o0, o1, y1, true, hex, shade * 1.06);
    if (this.low) return;
    this.hq(b, f, s0, s1, o0, o1, y0, false, hex, shade * 0.7);
    this.jq(b, f, s0, o0, o1, y0, y1, false, hex, shade * 0.9); this.jq(b, f, s1, o0, o1, y0, y1, true, hex, shade * 0.9);
  }
  /** Axis-aligned box given in frame coordinates. faces: 1 top, 2 bottom, 4 sides. */
  fbox(f: Frame, s0: number, s1: number, o0: number, o1: number, y0: number, y1: number, hex: number, faces = 5, shade = 1): void {
    const ax = PX(f, s0, o0), az = PZ(f, s0, o0), bx = PX(f, s1, o1), bz = PZ(f, s1, o1);
    this.F.box((ax + bx) / 2, y0, (az + bz) / 2, Math.abs(bx - ax), y1 - y0, Math.abs(bz - az), hex, 0, faces, shade);
  }

  /** A plank rising along the wall from (s0, y0) to (s1, y1), between offsets o0 and o1: both faces. For stairs. */
  ramp(b: Batch, f: Frame, s0: number, y0: number, s1: number, y1: number, o0: number, o1: number, hex: number, shade = 1): void {
    const ax = PX(f, s0, o0), az = PZ(f, s0, o0), bx = PX(f, s0, o1), bz = PZ(f, s0, o1), cx = PX(f, s1, o1), cz = PZ(f, s1, o1), dx = PX(f, s1, o0), dz = PZ(f, s1, o0);
    b.quad(ax, y0, az, bx, y0, bz, cx, y1, cz, dx, y1, dz, hex, 0, 0, 1, 1, shade);
    b.quad(dx, y1, dz, cx, y1, cz, bx, y0, bz, ax, y0, az, hex, 0, 0, 1, 1, shade);
  }
  /** A signboard on two posts, read from both sides: `face` is the side its front looks at. Returns the board's height. */
  board(cx: number, cz: number, face: number, y: number, w: number, name: string, legs = 1, post = 0x3a3a38): number {
    const r: Rect = face & 1 ? { x0: cx - 0.05, x1: cx + 0.05, z0: cz - w / 2, z1: cz + w / 2 } : { x0: cx - w / 2, x1: cx + w / 2, z0: cz - 0.05, z1: cz + 0.05 };
    let hh = 0;
    for (const sd of [face, face + 2]) { const f = frameOf(r, sd); hh = this.signAt(f, f.len / 2, y + legs, w, 0.012, name); }
    for (const t of [-1, 1]) this.F.box(face & 1 ? cx : cx + t * (w / 2 + 0.07), y, face & 1 ? cz + t * (w / 2 + 0.07) : cz, 0.14, legs + hh + 0.1, 0.14, post);
    this.game.col.addBox(r.x0 - 0.1, r.z0 - 0.1, r.x1 + 0.1, r.z1 + 0.1, y + legs + hh, y - 1);
    return hh;
  }
  /** A run of fence from the fence strip along one edge of a (zero-width) rect, with its collision. */
  fenceRun(seg: Rect, y: number, kind: 'picket' | 'chain' | 'rail', solid = true): void {
    const F = FENCE_UV[kind], h = kind === 'chain' ? 1.5 : F.h, len = Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0);
    if (len < 1) return;
    this.N.quad(seg.x0, y, seg.z0, seg.x1, y, seg.z1, seg.x1, y + h, seg.z1, seg.x0, y + h, seg.z0, 0xffffff, 0, F.v0 + 0.004, len / F.tileM, F.v1 - 0.004);
    if (solid) this.game.col.addBox(seg.x0 - 0.06, seg.z0 - 0.06, seg.x1 + 0.06, seg.z1 + 0.06, y + h, y - 1);
  }

  /** Four sloped sides between rect r0 at y0 and rect r1 at y1: hips, mansards, spires, a tapering stack. With `row`, in the wall sheet (keep each rise under a cell). */
  frustum(r0: Rect, y0: number, r1: Rect, y1: number, hex: number, row = -1, shade = 1): void {
    const us = 1 / (CELL * 16), B = row < 0 ? this.F : this.W, [v0, v1] = row < 0 ? [0, 1] : mwallV(row);
    for (let s = 0; s < 4; s++) {
      const a = frameOf(r0, s), b = frameOf(r1, s), slope = Math.hypot(y1 - y0, (a.depth - b.depth) / 2);
      B.quad(a.ox, y0, a.oz, PX(a, a.len, 0), y0, PZ(a, a.len, 0), PX(b, b.len, 0), y1, PZ(b, b.len, 0), b.ox, y1, b.oz, hex,
        0, v0, row < 0 ? 1 : a.len * us, row < 0 ? 1 : v0 + (v1 - v0) * Math.min(1, slope / CELL), shade * (s & 1 ? 0.96 : 1));
    }
  }
  /** A round bar or pipe between two points. */
  pipe(b: Batch, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, hex: number, seg = 6, shade = 1): void {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz) || 1;
    let ux = -dz, uz = dx;
    const ul = Math.hypot(ux, uz);
    if (ul < 1e-6) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
    const vx = (dy * uz) / L, vy = (dz * ux - dx * uz) / L, vz = (-dy * ux) / L;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0) * r, s0 = Math.sin(a0) * r, c1 = Math.cos(a1) * r, s1 = Math.sin(a1) * r;
      const ax = ux * c0 + vx * s0, ay = vy * s0, az = uz * c0 + vz * s0, bx = ux * c1 + vx * s1, by = vy * s1, bz = uz * c1 + vz * s1;
      b.quad(x0 + ax, y0 + ay, z0 + az, x0 + bx, y0 + by, z0 + bz, x1 + bx, y1 + by, z1 + bz, x1 + ax, y1 + ay, z1 + az, hex, 0, 0, 1, 1, shade);
    }
  }

  // ── Walls ──────────────────────────────────────────────────────────────────

  /** Plain wall of one MWALL row. Courses are counted from `ybase`, so strips cut round an opening still line up. */
  band(f: Frame, s0: number, s1: number, y0: number, y1: number, hex: number, row: number, ybase = y0, shade = 1, o = 0, per: number = CELL): void {
    if (s1 - s0 < 0.01 || y1 - y0 < 0.01) return;
    const [v0, v1] = mwallV(row), dv = v1 - v0, us = 1 / (CELL * 16), u0 = s0 * us, u1 = s1 * us;
    let y = y0;
    while (y < y1 - 1e-4) {
      const k = Math.floor((y - ybase) / per + 1e-6), top = Math.min(y1, ybase + (k + 1) * per);
      this.vq(this.W, f, s0, s1, y, top, o, hex, u0, v0 + ((y - ybase) / per - k) * dv, u1, v0 + ((top - ybase) / per - k) * dv, shade);
      y = top;
    }
  }
  /** One 64 px piece (window or door) of `row`, cell k. */
  piece(f: Frame, s: number, w: number, y: number, h: number, o: number, row: number, k: number, hex = 0xffffff, shade = 1): void {
    const [v0, v1] = mwallV(row), u0 = ((k % 32) + 0.02) / 32;
    this.vq(this.W, f, s, s + w, y, y + h, o, hex, u0, v0, u0 + 0.96 / 32, v1, shade);
  }
  /** A window in an opening the caller has left in the wall: reveal, sash set back, and for plain sashes a stone sill and lintel. */
  window(f: Frame, s: number, y: number, st: WinStyle, k: number, wall: number, shade: number, trim = 0xffffff): void {
    const d = this.low ? 0 : 0.17, F = this.F, jh = dim(wall, 0.72);
    if (d) {
      this.jq(F, f, s, -d, 0, y, y + st.h, true, jh, shade); this.jq(F, f, s + st.w, -d, 0, y, y + st.h, false, jh, shade);
      this.hq(F, f, s, s + st.w, -d, 0, y + st.h, false, jh, shade * 0.8); this.hq(F, f, s, s + st.w, -d, 0, y, true, st.own ? jh : STONE, shade);
    }
    this.piece(f, s, st.w, y, st.h, -d, st.row, k, st.own ? 0xffffff : trim, st.own ? shade : 1);
    if (st.own || this.low) return;
    this.ledge(f, s - 0.1, s + st.w + 0.1, y - 0.13, y, 0, 0.07, STONE);
    this.vq(F, f, s - 0.12, s + st.w + 0.12, y + st.h, y + st.h + 0.26, 0.015, STONE);
  }
  /**
   * Floors of a wall with a row of windows cut into each. `own` styles are red brick pieces: pass MWALL.redBrick as `hex`.
   * Returns nothing; windows are spaced `pitch` apart and centred.
   */
  facade(f: Frame, s0: number, s1: number, yb: number, fh: number, floors: number, hex: number, shade: number, st: WinStyle, pitch: number, seed: number, trim = 0xffffff, wallRow: number = ROW.brick): void {
    const n = Math.max(1, Math.floor((s1 - s0 - 0.5) / pitch)), m = (s1 - s0 - n * pitch) / 2 + (pitch - st.w) / 2;
    for (let fl = 0; fl < floors; fl++) {
      const y = yb + fl * fh, a = y + st.sill, b = a + st.h;
      this.band(f, s0, s1, y, a, hex, wallRow, y, shade, 0, fh + 0.001);
      this.band(f, s0, s1, b, y + fh, hex, wallRow, y, shade, 0, fh + 0.001);
      let prev = s0;
      for (let i = 0; i < n; i++) {
        const ws = s0 + m + i * pitch;
        this.band(f, prev, ws, a, b, hex, wallRow, y, shade, 0, fh + 0.001);
        this.window(f, ws, a, st, (seed * 7 + fl * 13 + i * 5) % 32, hex, shade, trim);
        prev = ws + st.w;
      }
      this.band(f, prev, s1, a, b, hex, wallRow, y, shade, 0, fh + 0.001);
    }
  }
  /** A blank wall with windows laid on it, for sides and backs nobody walks along. */
  plainWall(f: Frame, s0: number, s1: number, y0: number, y1: number, hex: number, shade: number, row: number = ROW.brick, wins?: { st: WinStyle; yb: number; fh: number; floors: number; pitch: number; seed: number; trim?: number }): void {
    this.band(f, s0, s1, y0, y1, hex, row, y0, shade);
    if (!wins) return;
    const { st, pitch } = wins, n = Math.floor((s1 - s0 - 1) / pitch), m = (s1 - s0 - n * pitch) / 2 + (pitch - st.w) / 2;
    for (let fl = 0; fl < wins.floors; fl++) for (let i = 0; i < n; i++) {
      this.piece(f, s0 + m + i * pitch, st.w, wins.yb + fl * wins.fh + st.sill, st.h, 0.02, st.row, (wins.seed * 3 + fl * 11 + i * 7) % 32, st.own ? 0xffffff : wins.trim ?? 0xffffff, st.own ? shade : 1);
    }
  }
  /** Corbelled brick cornice along the top of a wall: the dentil band of the sheet on a projecting course, capped. */
  cornice(f: Frame, s0: number, s1: number, ytop: number, hex: number, shade: number, h = 0.62, out = 0.16): void {
    const [, v1] = mwallV(ROW.corbel), us = 1 / (CELL * 16);
    this.vq(this.W, f, s0, s1, ytop - h, ytop, out, hex, s0 * us, v1 - 47 / 2048, s1 * us, v1, shade);
    this.hq(this.F, f, s0, s1, -0.3, out + 0.04, ytop, true, dim(hex, 0.8), shade);
    if (this.low) return;
    this.hq(this.F, f, s0, s1, 0, out, ytop - h, false, dim(hex, 0.5), shade);
    this.jq(this.F, f, s0, 0, out, ytop - h, ytop, false, dim(hex, 0.8), shade); this.jq(this.F, f, s1, 0, out, ytop - h, ytop, true, dim(hex, 0.8), shade);
  }
  /** A sign from the mainland atlas, w meters wide at its own aspect unless h is given, centred on s. */
  signAt(f: Frame, s: number, y: number, w: number, o: number, name: string, h = 0): number {
    const r = this.tex.signs.rect(name), hh = h || w / r.aspect;
    this.vq(this.S, f, s - w / 2, s + w / 2, y, y + hh, o, 0xffffff, r.u0, r.v0, r.u1, r.v1);
    return hh;
  }
  /** Pitched roof over `r` with its ridge along x (alongX) or z: shingled slopes with an overhang, soffits, and the two gable ends filled in `gableRow`. */
  gableRoof(r: Rect, y: number, rise: number, alongX: boolean, over: number, roofHex: number, wallHex: number, gableRow: number, shade = 1, roofRow: number = ROW.shingle): void {
    const W = this.W, [v0, v1] = mwallV(roofRow), us = 1 / (CELL * 16);
    for (const side of alongX ? [0, 2] : [1, 3]) {
      const f = frameOf(r, side), half = f.depth / 2, run = half + over, k = rise / half;
      const slope = Math.hypot(run, run * k), rows = Math.max(1, Math.round(slope / CELL));
      // Slope: eave at o = +over (below the wall top by over * k), ridge at o = -half.
      this.sq(W, f, -over, f.len + over, -half, y + rise, over, y - over * k, roofHex, shade, 0, v0, (f.len + 2 * over) * us * rows * CELL / slope * (slope / (rows * CELL)), v0 + (v1 - v0) * Math.min(1, slope / (rows * CELL)));
      if (!this.low) this.sq(this.F, f, -over, f.len + over, 0, y, over, y - over * k, dim(wallHex, 0.8), shade * 0.8, 0, 0, 1, 1, true);
    }
    const [g0, g1] = mwallV(gableRow);
    for (const side of alongX ? [1, 3] : [0, 2]) {
      const f = frameOf(r, side), a = [PX(f, 0, 0), PZ(f, 0, 0)], b = [PX(f, f.len, 0), PZ(f, f.len, 0)], m = [PX(f, f.len / 2, 0), PZ(f, f.len / 2, 0)];
      W.tri(a[0], y, a[1], b[0], y, b[1], m[0], y + rise, m[1], wallHex, shade);
      W.uv.length -= 6;
      W.uv.push(0, g0, f.len * us, g0, f.len * us / 2, g0 + (g1 - g0) * Math.min(1, rise / CELL));
    }
  }
}
const P3 = new THREE.Vector3();

let KIT: MainKit | null = null;
/** The kit mainlandBuildings made, for mainlandPlaces.ts to go on drawing into. */
export function mainKit(): MainKit {
  if (!KIT) throw new Error('mainlandBuildings must be built before mainlandPlaces');
  return KIT;
}

/** Loom Row's lots on the east side of Main St: they are built as Main St, not as mill yards. */
const onMain = (l: Lot): boolean => l.district === 'mill' && l.block >= 0 && !l.interior && l.face === 3 && Math.abs(l.rect.x0 - 83.5) < 1.5;

/** Where Postponement Hall stands (mainlandPlaces.ts), north of the square across Bobbin St: Lower Main's builder leaves these lots alone. */
export const OPERA: Rect = { x0: -2, z0: -1543, x1: 42, z1: -1514.5 };

// ── Lower Main ───────────────────────────────────────────────────────────────

interface Seg { s0: number; s1: number; kind: 'shop' | 'gap' | 'bank' | 'movie'; floors: number; depth: number; top: number }

class Builder {
  private shopDeck: number[] = [];
  private deckAt = 0;
  private usedOnBlock = new Map<number, Set<number>>();
  private ghost = 0;
  /** Main St's Blender-modelled blocks (mainStreetAssets.ts); null builds every frontage here as before. */
  ms: MainStreet | null = null;
  constructor(private k: MainKit, private game: Game) {
    const r = new RNG(7711);
    this.shopDeck = MAIN_SHOPS.map((_, i) => i);
    for (let i = this.shopDeck.length - 1; i > 0; i--) { const j = r.int(0, i); [this.shopDeck[i], this.shopDeck[j]] = [this.shopDeck[j], this.shopDeck[i]]; }
  }

  /** The next shop name not yet used on this block. */
  private shopName(block: number): string {
    let used = this.usedOnBlock.get(block);
    if (!used) this.usedOnBlock.set(block, (used = new Set()));
    for (let tries = 0; tries < this.shopDeck.length; tries++) {
      const i = this.shopDeck[this.deckAt++ % this.shopDeck.length];
      if (!used.has(i)) { used.add(i); return signKey(MAIN_SHOPS[i][0]); }
    }
    return signKey(MAIN_SHOPS[0][0]);
  }

  main(lots: Lot[], blocks: Block[], first: number): void {
    const k = this.k;
    // The two set pieces go on Main St itself: the bank just north of the square, the picture house just south of it.
    const pickNear = (x: number, z: number): number => {
      let best = -1, bd = 1e9;
      lots.forEach((l, i) => {
        if (l.district !== 'main' || l.interior || l.face !== 1 || Math.abs(l.rect.x1 - 56.5) > 2) return;
        const d = Math.hypot((l.rect.x0 + l.rect.x1) / 2 - x, (l.rect.z0 + l.rect.z1) / 2 - z);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const bankLot = pickNear(50, -1592), movieLot = pickNear(50, -1350);
    lots.forEach((lot, i) => {
      if (lot.district !== 'main' && !onMain(lot)) return;
      if (lot.rect.x0 < OPERA.x1 && lot.rect.x1 > OPERA.x0 && lot.rect.z0 < OPERA.z1 && lot.rect.z1 > OPERA.z0) return;
      const rng = new RNG(52000 + first + i), r = lot.rect, y = groundAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      k.at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      if (lot.interior) { this.parking(r, y, rng); return; }
      const block = blocks[lot.block];
      this.row(r, lot.face, y, rng, lot.block, block ? block.ave[lot.face] : false, i === bankLot ? 'bank' : i === movieLot ? 'movie' : null);
    });
  }

  /** One lot's frontage on `face`, cut into buildings wall to wall. Loom Row calls this too, for its side of Main St. */
  row(r: Rect, face: number, y: number, rng: RNG, blockId: number, ave: boolean, special: 'bank' | 'movie' | null): void {
    const f = frameOf(r, face);
    const side = special ? null : this.ms?.side(f) ?? null;
    if (side) { this.modelled(r, face, f, side, y, blockId); return; }
    // Cut the frontage into buildings 7 to 13 m wide, wall to wall.
    const segs: Seg[] = [];
    let s = 0;
    while (s < f.len - 0.01) {
      let w = special && s === 0 ? Math.min(f.len, 15) : rng.range(7, 12.5);
      if (f.len - s - w < 6.5) w = f.len - s;
      const floors = ave ? rng.int(2, 4) : rng.int(2, 3);
      const gap = !special && s > 0 && f.len - s - w > 1 && rng.chance(0.07);
      segs.push({ s0: s, s1: s + w, kind: special && s === 0 ? special : gap ? 'gap' : 'shop', floors, depth: Math.min(f.depth, rng.range(13, 20)), top: 0 });
      s += w;
    }
    segs.forEach((g, j) => {
      if (g.kind === 'gap') { this.parking(cut(r, face, g.s0, g.s1, 0, f.depth), y, rng); return; }
      const openL = j === 0 || segs[j - 1].kind === 'gap', openR = j === segs.length - 1 || segs[j + 1].kind === 'gap';
      if (g.kind === 'bank') this.bank(r, face, g, y);
      else if (g.kind === 'movie') this.movie(r, face, g, y, rng);
      else this.block(r, face, g, y, rng, blockId, openL, openR, ave);
    });
  }

  /** A Main St frontage filled with the Blender models: here only their collision and the signs on their fascias. */
  private modelled(r: Rect, face: number, f: Frame, side: 'w' | 'e', y: number, blockId: number): void {
    const k = this.k;
    for (const p of this.ms!.row(f, side, y)) {
      k.solid(cut(r, face, p.s0, p.s1, 0, p.depth), y + p.d.top, y - 1);
      for (const [x0, x1, y0, y1] of p.d.signs) {
        const uw = (x1 - x0) * p.sx, sh = Math.min(0.78, y1 - y0 - 0.08), sw = Math.min(uw - 0.5, sh * 4.4);
        k.signAt(f, (MainStreet.sOf(p, x0) + MainStreet.sOf(p, x1)) / 2, y + (y0 + y1) / 2 - sh / 2, sw, FASCIA_OUT * p.depth / p.d.D + 0.015, this.shopName(blockId), sh);
      }
    }
  }

  private parking(r: Rect, y: number, rng: RNG): void {
    const k = this.k;
    k.F.floor(r.x0 + 0.3, r.z0 + 0.3, r.x1 - 0.3, r.z1 - 0.3, y + 0.04, 0x55565a, 1, 1, rng.range(0.9, 1.05));
    // Stall lines, as thin strips proud of the tarmac by less than a tire would notice.
    const w = r.x1 - r.x0, d = r.z1 - r.z0, alongX = w >= d, n = Math.floor(((alongX ? w : d) - 2) / 2.7);
    for (let i = 0; i <= n && !k.low; i++) {
      const t = 1 + i * 2.7;
      if (alongX) k.F.floor(r.x0 + t, r.z0 + 1, r.x0 + t + 0.12, r.z0 + 5.6, y + 0.05, 0xd9d6c8);
      else k.F.floor(r.x0 + 1, r.z0 + t, r.x0 + 5.6, r.z0 + t + 0.12, y + 0.05, 0xd9d6c8);
    }
  }

  /** A brick commercial block: shopfront, two to three floors of windows, cornice, flat roof. */
  private block(lot: Rect, face: number, g: Seg, y: number, rng: RNG, blockId: number, openL: boolean, openR: boolean, ave: boolean): void {
    const k = this.k, br = cut(lot, face, g.s0, g.s1, 0, g.depth), f = frameOf(br, face);
    const red = rng.chance(0.5), hex = red ? RED : rng.pick(BRICKS), shade = rng.range(0.82, 1.12);
    const st: WinStyle = red ? (rng.chance(0.3) ? WIN.round : WIN.arch) : WIN.sash;
    const HS = 4.35, fh = st === WIN.round ? 3.7 : 3.5, up = g.floors - 1, par = rng.range(0.9, 1.5);
    const top = y + HS + up * fh + par, seed = rng.int(0, 999);
    const trim = rng.pick([0xffffff, 0xffffff, 0xe4dcc6, 0x51604f, 0x3a3a3a]);
    g.top = top;
    k.solid(br, top, y - 1);

    // Front: shopfront, upper floors, parapet, cornice.
    this.shopfront(f, 0, f.len, y, HS, rng, blockId, hex, shade);
    k.facade(f, 0, f.len, y + HS, fh, up, hex, shade, st, rng.range(2.3, 2.9), seed, trim);
    k.band(f, 0, f.len, y + HS + up * fh, top, hex, ROW.brick, y + HS + up * fh, shade);
    k.cornice(f, 0, f.len, top, hex, shade, 0.62, 0.16 + rng.range(0, 0.1));
    if (!k.low && rng.chance(0.5)) k.ledge(f, 0, f.len, y + HS - 0.02, y + HS + 0.16, 0, 0.09, red ? STONE : dim(hex, 0.8), shade);

    // Sides and back: plain brick; windows where a street, a gap or a lower neighbour leaves the wall in view.
    const wins = { st: WIN.sash, yb: y + HS, fh, floors: up, pitch: 3.4, seed, trim };
    const L = frameOf(br, face + 1), R = frameOf(br, face + 3), B = frameOf(br, face + 2);
    k.plainWall(L, 0, L.len, y, top, hex, shade * 0.94, ROW.brick, openL ? wins : undefined);
    k.plainWall(R, 0, R.len, y, top, hex, shade * 0.94, ROW.brick, openR ? wins : undefined);
    k.plainWall(B, 0, B.len, y, top, hex, shade * 0.9, ROW.brick, { ...wins, yb: y + 0.6, floors: up + 1, pitch: 3.1 });
    k.piece(B, B.len * 0.5 - 0.5, 1, y, 2.2, 0.03, ROW.door, MWALL.doors.steel);
    // A ghost sign high on a side wall that faces a gap or the corner: three in the sheet, taken in turn.
    for (const [side, open] of [[L, openL], [R, openR]] as [Frame, boolean][]) {
      if (!open || side.len < 11 || !rng.chance(0.4)) continue;
      const [v0, v1] = mwallV(ROW.ghost), i = this.ghost++ % 3, w = Math.min(9, side.len - 2), sy = top - 1.2 - w / 4;
      k.vq(k.W, side, side.len / 2 - w / 2, side.len / 2 + w / 2, sy, sy + w / 4, 0.03, hex, i / 4 + 0.002, v0, (i + 1) / 4 - 0.002, v1, shade * 0.94);
    }
    // Roof: tar inside the parapet, and the things that live up there.
    const ry = top - 0.2;
    k.F.floor(br.x0 + 0.05, br.z0 + 0.05, br.x1 - 0.05, br.z1 - 0.05, ry, TAR, 1, 1, rng.range(0.85, 1.1));
    if (!k.low) {
      const cx = rng.range(br.x0 + 2, br.x1 - 2), cz = rng.range(br.z0 + 2, br.z1 - 2);
      if (rng.chance(0.6)) k.F.box(cx, ry, cz, 1.1, rng.range(1.6, 2.6), 1.1, dim(hex, 0.9), 0, 5, shade);
      else k.F.box(cx, ry, cz, 2.2, 1.1, 1.6, 0x9a9c98, 0, 5);
    }
    void ave;
  }

  /** Cast-iron and glass shopfront between pilasters, with a recessed door, a fascia board with the shop's sign, and sometimes an awning. */
  private shopfront(f: Frame, s0: number, s1: number, y: number, HS: number, rng: RNG, blockId: number, wall: number, shade: number, sign?: string): void {
    const k = this.k, col = rng.pick(SHOPCOL), tint = blend(col, 0xffffff, 0.5), gh = 3.0, [v0, v1] = mwallV(ROW.shop, 2);
    const pw = 0.42, a = s0 + pw, b = s1 - pw, dw = 1.9, n = Math.max(1, Math.round((b - a - dw) / 2.5)), bw = (b - a - dw) / n;
    const doorAt = rng.int(0, n), rec = k.low ? 0 : 0.85, set = k.low ? 0 : 0.1;
    const cell = (sa: number, sb: number, o: number, c: number): void => k.vq(k.W, f, sa, sb, y + 0.02, y + gh, o, tint, (c + 0.01) / 16, v0, (c + 0.99) / 16, v1);
    let s = a, c0 = rng.int(0, 11);
    for (let i = 0; i <= n; i++) {
      if (i === doorAt) {
        cell(s, s + dw, -rec, 12 + rng.int(0, 3));
        if (rec) {
          k.jq(k.F, f, s, -rec, -set, y, y + gh, true, col); k.jq(k.F, f, s + dw, -rec, -set, y, y + gh, false, col);
          k.hq(k.F, f, s, s + dw, -rec, 0, y + 0.02, true, 0x8d8a82); k.hq(k.F, f, s, s + dw, -rec, 0, y + gh, false, dim(col, 0.7));
        }
        s += dw;
      }
      if (i < n) { cell(s, s + bw, -set, (c0 + i * 5) % 12); s += bw; }
    }
    // Pilasters, the lintel over the glass, the fascia with the sign, and the cornice above it.
    k.fbox(f, s0, a, -0.1, 0.12, y, y + HS - 0.25, col, 4); k.fbox(f, b, s1, -0.1, 0.12, y, y + HS - 0.25, col, 4);
    if (set) k.hq(k.F, f, a, b, -set, 0.02, y + gh, false, dim(col, 0.7));
    k.ledge(f, s0, s1, y + gh, y + HS - 0.22, 0, 0.08, col);
    k.ledge(f, s0, s1, y + HS - 0.22, y + HS - 0.04, 0, 0.26, dim(col, 1.15));
    const sw = Math.min(s1 - s0 - 1.2, 4.2), sh = Math.min(1.02, sw / 4);
    k.signAt(f, (s0 + s1) / 2, y + gh + (HS - 0.22 - gh - sh) / 2, sh * 4, 0.095, sign ?? this.shopName(blockId), sh);
    if (rng.chance(0.38)) {
      // Canvas awning: top, underside and a valance. Flat colour is single-sided, so each face is its own quad.
      const ac = rng.pick(AWNING), aw0 = s0 + 0.5, aw1 = s1 - 0.5, y1 = y + gh + 0.05, y0 = y + 2.5, out = 1.5;
      k.sq(k.F, f, aw0, aw1, 0.08, y1, out, y0, ac);
      k.sq(k.F, f, aw0, aw1, 0.08, y1 - 0.02, out, y0 - 0.02, ac, 0.6, 0, 0, 1, 1, true);
      k.vq(k.F, f, aw0, aw1, y0 - 0.28, y0, out, ac, 0, 0, 1, 1, 0.9);
      k.vq(k.F, f, aw1, aw0, y0 - 0.28, y0, out - 0.01, ac, 0, 0, 1, 1, 0.55);
    }
    void wall; void shade;
  }

  /** Tepid Savings & Trust: a granite temple front, four columns under a pediment, set back from the walk. */
  private bank(lot: Rect, face: number, g: Seg, y: number): void {
    const k = this.k, back = 2.6, H = 9.6, hex = 0xdcd9cf;
    const br = cut(lot, face, g.s0, g.s1, back, back + 15), f = frameOf(br, face), w = f.len;
    g.top = y + H;
    k.solid(br, y + H, y - 1);
    for (const side of [1, 2, 3]) { const sf = frameOf(br, face + side); k.plainWall(sf, 0, sf.len, y, y + H, hex, 0.95, ROW.granite, { st: WIN.sash, yb: y + 1, fh: 4, floors: 2, pitch: 3.6, seed: side }); }
    // Front wall behind the columns: a tall door between two round-headed windows either side.
    k.band(f, 0, w, y, y + H, hex, ROW.granite, y, 1);
    k.piece(f, w / 2 - 1.1, 2.2, y + 0.45, 3.6, 0.03, ROW.door, MWALL.doors.hall, 0x6b4a32);
    for (const sx of [0.16, 0.3, 0.7, 0.84]) k.piece(f, w * sx - 0.7, 1.4, y + 1.5, 3.4, 0.03, ROW.sash, Math.round(sx * 40), 0x4a4a48);
    // Steps, stylobate, columns, entablature with the name, pediment.
    k.fbox(f, 0.4, w - 0.4, 0, back - 0.2, y, y + 0.45, STONE, 5);
    k.fbox(f, 0, w, 0, back, y, y + 0.22, dim(STONE, 0.92), 5);
    k.game.col.addBox(br.x0, br.z0, br.x1, br.z1, y + H, y - 1);
    const ey = y + 6.4;
    for (let i = 0; i < 4; i++) {
      const s = 1.5 + i * (w - 3) / 3, cx = PX(f, s, back - 0.9), cz = PZ(f, s, back - 0.9);
      k.F.cyl(cx, y + 0.45, cz, 0.44, 0.38, ey - y - 0.45, 0xe6e3da, k.low ? 6 : 10, false);
      k.F.box(cx, y + 0.45, cz, 1.05, 0.2, 1.05, STONE); k.F.box(cx, ey - 0.22, cz, 1.0, 0.22, 1.0, STONE);
      k.game.col.addProp(cx, cz, 0.5, 6, 'post', false);
    }
    k.ledge(f, 0.3, w - 0.3, ey, ey + 1.1, 0, back - 0.3, 0xe0ddd3);
    k.signAt(f, w / 2, ey + 0.18, Math.min(w - 2.4, 8), back - 0.28, 'm-bank', 0.74);
    k.ledge(f, 0.1, w - 0.1, ey + 1.1, ey + 1.28, 0, back - 0.1, STONE);
    const py = ey + 1.28, pk = py + 2.1, o = back - 0.2;
    k.F.tri(PX(f, 0.2, o), py, PZ(f, 0.2, o), PX(f, w - 0.2, o), py, PZ(f, w - 0.2, o), PX(f, w / 2, o), pk, PZ(f, w / 2, o), 0xd6d3c9);
    for (const [sa, sb, ya, yb] of [[0.2, w / 2, py, pk], [w / 2, w - 0.2, pk, py]] as number[][]) {
      const ax = PX(f, sa, o), az = PZ(f, sa, o), bx = PX(f, sb, o), bz = PZ(f, sb, o), cx = PX(f, sb, 0), cz = PZ(f, sb, 0), dx = PX(f, sa, 0), dz = PZ(f, sa, 0);
      k.F.quad(ax, ya, az, bx, yb, bz, cx, yb, cz, dx, ya, dz, 0x8f948f);
    }
    k.F.floor(br.x0, br.z0, br.x1, br.z1, y + H, TAR);
    k.ledge(f, 0, w, y + H - 0.4, y + H, 0, 0.12, STONE);
  }

  /** The Hesitation: a picture house with a marquee out over the walk and a fin above it. */
  private movie(lot: Rect, face: number, g: Seg, y: number, rng: RNG): void {
    const k = this.k, H = 12.5, hex = 0xd8cdb4, shade = 0.98;
    const br = cut(lot, face, g.s0, g.s1, 0, Math.min(frameOf(lot, face).depth, 26)), f = frameOf(br, face), w = f.len;
    g.top = y + H;
    k.solid(br, y + H, y - 1);
    for (const side of [1, 2, 3]) { const sf = frameOf(br, face + side); k.plainWall(sf, 0, sf.len, y, y + H, hex, 0.92); }
    k.band(f, 0, w, y + 3.3, y + H, hex, ROW.brick, y, shade);
    k.cornice(f, 0, w, y + H, hex, shade, 0.7, 0.2);
    // Brick piers up the blank front, the way a 1920s house dressed a wall with no windows in it.
    for (let i = 0; i < 5 && !k.low; i++) { const s = 0.4 + i * (w - 1.3) / 4; k.fbox(f, s, s + 0.5, 0, 0.14, y + 4.9, y + H - 0.7, dim(hex, 0.9), 4); }
    // The lobby: doors in the middle, poster cases either side, all under the marquee.
    const col = 0x6a2620, tint = blend(col, 0xffffff, 0.45), [v0, v1] = mwallV(ROW.shop, 2), rec = k.low ? 0 : 1.2, a = w / 2 - 3.2, b = w / 2 + 3.2;
    for (let i = 0; i < 3; i++) k.vq(k.W, f, a + i * 6.4 / 3, a + (i + 1) * 6.4 / 3, y + 0.02, y + 3.3, -rec, tint, (12 + i + 0.01) / 16, v0, (12 + i + 0.99) / 16, v1);
    if (rec) {
      k.jq(k.F, f, a, -rec, 0, y, y + 3.3, true, col); k.jq(k.F, f, b, -rec, 0, y, y + 3.3, false, col);
      k.hq(k.F, f, a, b, -rec, 0, y + 0.02, true, 0x7a2a22); k.hq(k.F, f, a, b, -rec, 0, y + 3.3, false, 0xe8dfc6);
    }
    k.band(f, 0, a, y, y + 3.3, hex, ROW.brick, y, shade); k.band(f, b, w, y, y + 3.3, hex, ROW.brick, y, shade);
    for (const s of [a / 2, (b + w) / 2]) { k.fbox(f, s - 0.6, s + 0.6, 0, 0.07, y + 1, y + 2.7, 0x2a2a2a, 4); k.vq(k.F, f, s - 0.5, s + 0.5, y + 1.1, y + 2.6, 0.08, rng.pick([0xc9892e, 0x2f5a57, 0x8c2f25])); }
    // Marquee: a box over the pavement lettered on three sides, and a fin with the house's colours.
    const m0 = w / 2 - 4.4, m1 = w / 2 + 4.4, my = y + 3.35, mo = 2.6;
    k.ledge(f, m0, m1, my, my + 1.5, 0, mo, 0x2a2420);
    k.signAt(f, w / 2, my + 0.12, 8.2, mo + 0.02, 'm-marquee', 1.26);
    const rr = k.tex.signs.rect('m-marquee');
    k.jq(k.S, f, m0 - 0.02, 0.1, mo - 0.1, my + 0.12, my + 1.38, false, 0xffffff, 1, rr.u0, rr.v0, rr.u0 + (rr.u1 - rr.u0) * 0.5, rr.v1);
    k.jq(k.S, f, m1 + 0.02, 0.1, mo - 0.1, my + 0.12, my + 1.38, true, 0xffffff, 1, rr.u0, rr.v0, rr.u0 + (rr.u1 - rr.u0) * 0.5, rr.v1);
    k.fbox(f, w / 2 - 0.25, w / 2 + 0.25, 0.1, 1.5, my + 1.5, y + H + 1.6, 0x6a2620, 5);
    k.fbox(f, w / 2 - 0.29, w / 2 + 0.29, 1.5, 1.62, my + 1.5, y + H + 1.6, 0xe7d9a8, 5);
    k.F.floor(br.x0, br.z0, br.x1, br.z1, y + H - 0.2, TAR);
  }

  // ── The Stacks (and the dozen houses of Lesser Tepid) ───────────────────────
  // 558 lots of wooden houses. Every one is drawn straight into the town's chunked batches, so the whole
  // district is the same few meshes as Main St: about 330 triangles for a triple-decker with its porches
  // and back stairs, 170 for a gabled house. Mirroring swaps the plan (door, drive, stairs), never a texture.

  stacks(lots: Lot[], blocks: Block[], first: number): void {
    const k = this.k;
    const size = (l: Lot): [number, number] => { const w = l.rect.x1 - l.rect.x0, d = l.rect.z1 - l.rect.z0; return l.face & 1 ? [d, w] : [w, d]; };
    const taken = new Set<number>();
    const pick = (tx: number, tz: number, fr: number, dp: number): number => {
      let best = -1, bd = 1e9;
      lots.forEach((l, i) => {
        if (l.district !== 'stacks' || l.interior || taken.has(i)) return;
        const [a, b] = size(l);
        if (a < fr || b < dp) return;
        const d = Math.hypot((l.rect.x0 + l.rect.x1) / 2 - tx, (l.rect.z0 + l.rect.z1) / 2 - tz);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) taken.add(best);
      return best;
    };
    const churchA = pick(-290, -1450, 15, 25), churchB = pick(-430, -1240, 15, 25), school = pick(-200, -1680, 24, 19);
    const storeOn = new Set<number>();
    let stores = 0;
    lots.forEach((lot, i) => {
      const sister = lot.district === 'sister';
      if (lot.district !== 'stacks' && !(sister && lot.rect.z0 > -1420)) return;
      const r = lot.rect, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, y = groundAt(cx, cz), rng = new RNG(91000 + first + i);
      k.at(cx, cz);
      if (lot.interior) { this.backLot(r, y, rng); return; }
      if (i === churchA || i === churchB) { this.church(r, lot.face, y, i === churchA); return; }
      if (i === school) { this.school(r, lot.face, y); return; }
      const block = blocks[lot.block], f = frameOf(r, lot.face);
      if (block && !storeOn.has(lot.block) && lot.block % 3 === 0 && this.corner(lot, block)) {
        storeOn.add(lot.block);
        this.store(r, lot.face, y, rng, STORES[stores++ % STORES.length], lot.block);
        return;
      }
      const n = !sister && f.len >= 23 ? 2 : 1, sw = sister ? 14 : f.len / n, off = sister ? (f.len - 14) / 2 : 0;
      for (let j = 0; j < n; j++) this.houseSlot(r, lot.face, off + j * sw, sw, y, rng, !sister);
      // A fence down one side and along the back, set just inside the line so two neighbours' fences never lie in one plane.
      if (rng.chance(sister ? 0.3 : 0.55)) {
        const kind = rng.chance(0.55) ? 'picket' : 'chain';
        k.fenceRun(cut(r, lot.face, 0.15, 0.15, SET, f.depth - 0.15), y, kind);
        if (rng.chance(0.7)) k.fenceRun(cut(r, lot.face, 0.15, f.len - 0.15, f.depth - 0.15, f.depth - 0.15), y, kind);
      }
    });
  }

  /** Whether a lot stands on a corner of its block: two of its sides within a sidewalk of a street. */
  private corner(l: Lot, b: Block): boolean {
    const r = l.rect, B = b.rect, d = [r.z0 - B.z0, B.x1 - r.x1, B.z1 - r.z1, r.x0 - B.x0];
    return d.filter((v, s) => b.road[s] && v < 4.5).length >= 2;
  }

  /** One house and its driveway in a slice of a lot's frontage. */
  private houseSlot(lot: Rect, face: number, s0: number, sw: number, y: number, rng: RNG, drive: boolean): void {
    const k = this.k, L = frameOf(lot, face), mir = rng.chance(0.5);
    const triple = L.depth >= 15.5 && rng.chance(0.5);
    const w = Math.min(triple ? rng.range(7.4, 8.2) : rng.range(6.2, 7.4), sw - 4.1);
    const D = Math.min(triple ? rng.range(11.5, 13) : rng.range(8.5, 10.5), L.depth - SET - (triple ? 2.4 : 1.2));
    const hs = mir ? s0 + 0.8 : s0 + sw - 0.8 - w;
    if (triple) this.triple(lot, face, hs, w, D, y, rng, mir); else this.gable(lot, face, hs, w, D, y, rng, mir);
    if (!drive) return;
    const ds = mir ? s0 + sw - 3.0 : s0 + 0.5, dl = Math.min(L.depth - 1, SET + D * rng.range(0.5, 1));
    k.hq(k.F, L, ds, ds + 2.5, -dl, 0, y + 0.03, true, rng.chance(0.5) ? 0x6f6e70 : 0xa59f92, rng.range(0.9, 1.05));
    if (L.depth >= 17 && rng.chance(0.3)) this.garage(cut(lot, face, ds - 0.2, ds + 2.8, L.depth - 6.4, L.depth - 0.8), face, y, rng);
  }

  /**
   * Clapboard walls on a stone footing with windows laid on, and a door on the front at each of `doorFloors` floors.
   * Returns where along the front the door stands.
   */
  private shell(br: Rect, face: number, y: number, base: number, FH: number, floors: number, hex: number, trim: number, shade: number, rng: RNG, doorLeft: boolean, doorFloors: number): number {
    const k = this.k, top = y + base + floors * FH, seed = rng.int(0, 31), doorHex = rng.pick(DOORC);
    let at = 0;
    for (let sd = 0; sd < 4; sd++) {
      const f = frameOf(br, face + sd), sh = shade * (sd === 0 ? 1 : sd === 2 ? 0.92 : 0.96);
      k.vq(k.F, f, 0, f.len, y - 0.3, y + base, 0, 0x8f8d86, 0, 0, 1, 1, sh);
      k.band(f, 0, f.len, y + base, top, hex, ROW.clap, y + base, sh);
      const n = Math.max(sd === 0 ? 2 : 1, Math.floor((f.len - 0.8) / (sd === 0 ? 2.5 : 3.1))), pitch = f.len / n, slot = doorLeft ? 0 : n - 1;
      if (sd === 0) at = (slot + 0.5) * pitch;
      for (let fl = 0; fl < floors; fl++) for (let i = 0; i < n; i++) {
        const s = (i + 0.5) * pitch, yy = y + base + fl * FH;
        if (sd === 0 && i === slot && fl < doorFloors) k.piece(f, s - 0.5, 1, yy, 2.12, 0.03, ROW.door, (fl === 0 ? MWALL.doors.panel : MWALL.doors.oval) + 8 * ((seed + fl) % 4), doorHex);
        else if (sd !== 2 || (i + fl + seed) % 3) k.piece(f, s - 0.43, 0.86, yy + 0.8, 1.6, 0.03, ROW.house, (seed + sd * 5 + fl * 3 + i * 7) % 32, trim);
      }
    }
    return at;
  }

  /** Porch balustrade along the front between a and b: boarded in like the wall, or turned balusters from the fence strip. */
  private rail(f: Frame, a: number, b: number, o: number, yy: number, boarded: boolean, hex: number, trim: number, shade: number): void {
    const k = this.k, P = FENCE_UV.picket;
    if (b - a < 0.3 || k.low) return;
    if (boarded) { k.band(f, a, b, yy, yy + 0.95, hex, ROW.clap, yy, shade, o); k.vq(k.F, f, b, a, yy, yy + 0.95, o - 0.05, dim(hex, 0.72), 0, 0, 1, 1, shade); }
    else k.vq(k.N, f, a, b, yy, yy + 0.95, o, trim, 0, P.v0 + 0.004, (b - a) / P.tileM, P.v1 - 0.004);
  }
  /** The same across the two ends of a porch. */
  private railEnds(f: Frame, pa: number, pb: number, o: number, yy: number, boarded: boolean, hex: number, trim: number, shade: number): void {
    const k = this.k, P = FENCE_UV.picket;
    if (k.low) return;
    for (const [s, plus] of [[pa, false], [pb, true]] as [number, boolean][]) {
      if (boarded) {
        k.jq(k.F, f, s, 0, o, yy, yy + 0.95, plus, dim(hex, 0.86), shade);
        k.jq(k.F, f, s + (plus ? -0.05 : 0.05), 0, o, yy, yy + 0.95, !plus, dim(hex, 0.72), shade);
      } else k.jq(k.N, f, s, 0, o, yy, yy + 0.95, plus, trim, 1, 0, P.v0 + 0.004, o / P.tileM, P.v1 - 0.004);
    }
  }
  /** Two steps down from a porch deck at `sd`, and a path to the sidewalk. */
  private steps(f: Frame, sd: number, pd: number, y: number, deck: number): void {
    const k = this.k;
    k.fbox(f, sd - 0.65, sd + 0.65, pd, pd + 0.3, y, y + deck * 0.66, 0x9a968a, 5);
    k.fbox(f, sd - 0.65, sd + 0.65, pd + 0.3, pd + 0.6, y, y + deck * 0.33, 0x9a968a, 5);
    k.hq(k.F, f, sd - 0.5, sd + 0.5, pd + 0.6, SET + 0.2, y + 0.03, true, 0xa9a69c);
  }

  /** A triple-decker: three flats, a porch to each stacked on the front, flat roof with a deep cornice, stairs up the back. */
  private triple(lot: Rect, face: number, hs: number, w: number, D: number, y: number, rng: RNG, mir: boolean): void {
    const k = this.k, br = cut(lot, face, hs, hs + w, SET, SET + D), f = frameOf(br, face);
    const hex = rng.pick(PAINT), trim = rng.chance(0.8) ? WHITE : dim(hex, 0.62), shade = rng.range(0.9, 1.04);
    const FH = 2.9, base = 0.55, top = y + base + 3 * FH, pd = 2, boarded = rng.chance(0.55);
    k.solid(br, top + 0.3, y - 1);
    const sd = this.shell(br, face, y, base, FH, 3, hex, trim, shade, rng, mir, 3);
    for (let s = 0; s < 4; s++) { const sf = frameOf(br, face + s); k.ledge(sf, -0.3, sf.len + 0.3, top - 0.14, top + 0.3, 0, 0.3, trim); }
    k.F.floor(br.x0 - 0.3, br.z0 - 0.3, br.x1 + 0.3, br.z1 + 0.3, top + 0.31, 0x55575a);

    // The porches: a deck to each floor and a roof over the top one, on posts the full height.
    const half = w > 7.7 && rng.chance(0.4);
    const pa = half && !mir ? w / 2 - 0.2 : 0.15, pb = half && mir ? w / 2 + 0.2 : w - 0.15;
    k.solid(frect(f, pa, pb, 0, pd), top, y - 1);
    for (let fl = 0; fl <= 3; fl++) { const yy = y + base + fl * FH; k.fbox(f, pa, pb, 0, pd + (fl === 3 ? 0.2 : 0), yy - 0.2, yy, fl === 3 ? trim : 0xa9a69b, 7); }
    for (const s of half ? [pa + 0.1, pb - 0.1] : [pa + 0.1, (pa + pb) / 2, pb - 0.1]) k.fbox(f, s - 0.08, s + 0.08, pd - 0.2, pd - 0.04, y + base, top - 0.2, trim, 4);
    k.vq(k.F, f, pa, pb, y, y + base - 0.2, pd - 0.03, 0x6b6a64);
    for (let fl = 0; fl < 3; fl++) {
      const yy = y + base + fl * FH;
      if (fl === 0) { this.rail(f, pa, sd - 0.7, pd - 0.06, yy, boarded, hex, trim, shade); this.rail(f, sd + 0.7, pb, pd - 0.06, yy, boarded, hex, trim, shade); }
      else this.rail(f, pa, pb, pd - 0.06, yy, boarded, hex, trim, shade);
      this.railEnds(f, pa, pb, pd - 0.06, yy, boarded, hex, trim, shade);
    }
    this.steps(f, sd, pd, y, base);

    // The back stairs: two flights side by side with a landing at each flat's kitchen door.
    if (!k.low) {
      const B = frameOf(br, face + 2), a = mir ? 0.4 : B.len - 4.9, b = a + 4.5, L1 = y + base + FH, L2 = L1 + FH, wd = 0x8f8a7c;
      k.ramp(k.F, B, a + 0.9, y, b - 0.9, L1, 0, 1, wd); k.fbox(B, b - 0.9, b, 0, 2, L1 - 0.12, L1, wd, 7);
      k.ramp(k.F, B, b - 0.9, L1, a + 0.9, L2, 1, 2, wd); k.fbox(B, a, a + 0.9, 0, 2, L2 - 0.12, L2, wd, 7);
      for (const s of [a + 0.06, b - 0.06]) k.fbox(B, s - 0.06, s + 0.06, 1.88, 2, y, L2 + 1, wd, 4);
      k.piece(B, b - 0.95, 0.9, L1, 2.05, 0.03, ROW.door, MWALL.doors.panel + 8, 0xd8d2c4); k.piece(B, a + 0.05, 0.9, L2, 2.05, 0.03, ROW.door, MWALL.doors.panel + 16, 0xd8d2c4);
      k.solid(frect(B, a, b, 0, 2), L2, y - 1);
    }
  }

  /** A clapboard house under a gable, one or two floors, with a porch across the front. */
  private gable(lot: Rect, face: number, hs: number, w: number, D: number, y: number, rng: RNG, mir: boolean): void {
    const k = this.k, br = cut(lot, face, hs, hs + w, SET, SET + D), f = frameOf(br, face);
    const hex = rng.pick(PAINT), trim = rng.chance(0.8) ? WHITE : dim(hex, 0.62), shade = rng.range(0.9, 1.04), roof = rng.pick(ROOF);
    const FH = 2.75, base = 0.5, floors = rng.chance(0.8) ? 2 : 1, top = y + base + floors * FH;
    const front = rng.chance(0.6), rise = (front ? w : D) * (floors === 1 ? 0.42 : 0.36), pd = 1.8;
    k.solid(br, top + rise * 0.6, y - 1);
    const sd = this.shell(br, face, y, base, FH, floors, hex, trim, shade, rng, mir, 1);
    k.gableRoof(br, top, rise, front ? (face & 1) === 1 : (face & 1) === 0, 0.35, roof, hex, ROW.clap, shade);
    if (front) k.piece(f, w / 2 - 0.36, 0.72, top + 0.3, 1.25, 0.03, ROW.house, rng.int(0, 31), trim);
    k.F.box(br.x0 + (br.x1 - br.x0) * rng.range(0.4, 0.6), top, br.z0 + (br.z1 - br.z0) * rng.range(0.4, 0.6), 0.62, rise + 0.8, 0.62, 0x8a4a3a, 0, 5);

    const half = rng.chance(0.45), yr = y + base + 2.45, boarded = rng.chance(0.25);
    const pa = half && !mir ? w / 2 - 0.2 : 0.1, pb = half && mir ? w / 2 + 0.2 : w - 0.1;
    k.solid(frect(f, pa, pb, 0, pd), yr + 0.4, y - 1);
    k.fbox(f, pa, pb, 0, pd, y + base - 0.2, y + base, 0xa9a69b, 7);
    k.vq(k.F, f, pa, pb, y, y + base - 0.2, pd - 0.03, 0x6b6a64);
    for (const s of half ? [pa + 0.1, pb - 0.1] : [pa + 0.1, (pa + pb) / 2, pb - 0.1]) k.fbox(f, s - 0.07, s + 0.07, pd - 0.18, pd - 0.04, y + base, yr, trim, 4);
    k.sq(k.F, f, pa - 0.2, pb + 0.2, 0, yr + 0.5, pd + 0.25, yr, roof);
    k.sq(k.F, f, pa - 0.2, pb + 0.2, 0, yr + 0.48, pd + 0.25, yr - 0.02, trim, 0.8, 0, 0, 1, 1, true);
    k.vq(k.F, f, pa - 0.2, pb + 0.2, yr - 0.16, yr + 0.01, pd + 0.25, trim);
    this.rail(f, pa, sd - 0.7, pd - 0.06, y + base, boarded, hex, trim, shade); this.rail(f, sd + 0.7, pb, pd - 0.06, y + base, boarded, hex, trim, shade);
    this.railEnds(f, pa, pb, pd - 0.06, y + base, boarded, hex, trim, shade);
    this.steps(f, sd, pd, y, base);
  }

  /** A one-car garage or shed: clapboard, a lift door on `face`, a low gable. */
  private garage(r: Rect, face: number, y: number, rng: RNG): void {
    const k = this.k, hex = rng.pick(PAINT), h = 2.5, sh = rng.range(0.85, 1);
    k.solid(r, y + h + 0.6, y - 1);
    for (let s = 0; s < 4; s++) { const f = frameOf(r, face + s); k.band(f, 0, f.len, y, y + h, hex, ROW.clap, y, sh); }
    const f = frameOf(r, face);
    k.piece(f, f.len / 2 - 1.2, 2.4, y, 2.1, 0.03, ROW.door, MWALL.doors.garage, 0xf0ece0);
    k.gableRoof(r, y + h, 0.9, (face & 1) === 1, 0.25, rng.pick(ROOF), hex, ROW.clap, sh);
  }

  /** A lot with no street to face: somebody's back land. A shed, a vegetable patch, or just the grass. */
  private backLot(r: Rect, y: number, rng: RNG): void {
    const k = this.k, w = r.x1 - r.x0, d = r.z1 - r.z0;
    if (w < 7 || d < 9) return;
    if (rng.chance(0.45)) { const x = rng.range(r.x0 + 1, r.x1 - 4.6), z = rng.range(r.z0 + 1, r.z1 - 6.8); this.garage({ x0: x, z0: z, x1: x + 3.4, z1: z + 5.6 }, rng.chance(0.5) ? 0 : 2, y, rng); return; }
    if (k.low || !rng.chance(0.4)) return;
    const x = rng.range(r.x0 + 1, r.x1 - 6), z = rng.range(r.z0 + 1, r.z1 - 7);
    k.F.floor(x, z, x + 5, z + 6, y + 0.03, 0x5a4632);
    for (let i = 0; i < 4; i++) k.F.box(x + 2.5, y, z + 0.9 + i * 1.4, 4.4, 0.3, 0.5, rng.pick([0x4f7a3a, 0x6a8f3f, 0x3f6a3a]), 0, 5);
    if (rng.chance(0.5)) { k.fenceRun({ x0: x - 0.4, z0: z - 0.4, x1: x + 5.4, z1: z - 0.4 }, y, 'picket', false); k.fenceRun({ x0: x - 0.4, z0: z - 0.4, x1: x - 0.4, z1: z + 6.4 }, y, 'picket', false); }
  }

  /** A corner store: a shopfront under a flat of clapboard, flat roof, the sign of one of the eight in town. */
  private store(lot: Rect, face: number, y: number, rng: RNG, sign: string, blockId: number): void {
    const k = this.k, L = frameOf(lot, face), w = Math.min(L.len - 1.5, 11), D = Math.min(L.depth - 2, 12), s0 = rng.chance(0.5) ? 0.6 : L.len - 0.6 - w;
    const br = cut(lot, face, s0, s0 + w, 0.4, 0.4 + D), f = frameOf(br, face), hex = rng.pick(PAINT), HS = 4.35, FH = 2.9, top = y + HS + FH + 0.5, seed = rng.int(0, 31);
    k.solid(br, top, y - 1);
    this.shopfront(f, 0, w, y, HS, rng, blockId, hex, 1, sign);
    k.band(f, 0, w, y + HS, top, hex, ROW.clap, y + HS, 1);
    for (let i = 0; i < 3; i++) k.piece(f, (i + 0.5) * w / 3 - 0.43, 0.86, y + HS + 0.75, 1.6, 0.03, ROW.house, (seed + i * 3) % 32, WHITE);
    for (let s = 1; s < 4; s++) {
      const sf = frameOf(br, face + s), n = Math.floor(sf.len / 3.2);
      k.band(sf, 0, sf.len, y, top, hex, ROW.clap, y, 0.95);
      for (let i = 0; i < n; i++) for (const yy of [y + 1.3, y + HS + 0.75]) k.piece(sf, (i + 0.5) * sf.len / n - 0.43, 0.86, yy, 1.6, 0.03, ROW.house, (seed + s * 5 + i * 7 + Math.round(yy)) % 32, WHITE);
    }
    for (let s = 0; s < 4; s++) { const sf = frameOf(br, face + s); k.ledge(sf, -0.2, sf.len + 0.2, top - 0.3, top + 0.1, 0, 0.2, WHITE); }
    k.F.floor(br.x0 - 0.2, br.z0 - 0.2, br.x1 + 0.2, br.z1 + 0.2, top + 0.11, 0x55575a);
  }

  /** First Provisional Church: white clapboard, tall plain windows, a square tower on the front with a belfry and a white spire. */
  private church(lot: Rect, face: number, y: number, first: boolean): void {
    const k = this.k, L = frameOf(lot, face), w = 10, SB = 6, D = Math.min(18, L.depth - SB - 1.5), s0 = (L.len - w) / 2;
    const br = cut(lot, face, s0, s0 + w, SB, SB + D), f = frameOf(br, face), hex = 0xefece2, top = y + 7;
    k.solid(br, top + 3, y - 1);
    for (let s = 0; s < 4; s++) {
      const sf = frameOf(br, face + s);
      k.vq(k.F, sf, 0, sf.len, y - 0.3, y + 0.6, 0, 0x8f8d86);
      k.band(sf, 0, sf.len, y + 0.6, top, hex, ROW.clap, y + 0.6, s === 0 ? 1 : 0.95);
      if (s & 1) for (let i = 0; i < 4; i++) k.piece(sf, (i + 0.5) * sf.len / 4 - 0.55, 1.1, y + 1.9, 3.7, 0.03, ROW.sash, (i * 3 + s) % 32, 0xffffff);
    }
    k.gableRoof(br, top, 4.6, (face & 1) === 1, 0.4, 0x45484d, hex, ROW.clap);
    // The tower stands half out of the front wall; the belfry is a size smaller, the spire four white slopes.
    const tw = 3.6, tr = frect(f, w / 2 - tw / 2, w / 2 + tw / 2, -1.6, 1.9), ty = y + 12.5, by = ty + 2.6;
    const bel: Rect = { x0: tr.x0 + 0.35, z0: tr.z0 + 0.35, x1: tr.x1 - 0.35, z1: tr.z1 - 0.35 };
    k.solid(tr, by, y - 1);
    for (let s = 0; s < 4; s++) {
      const tf = frameOf(tr, face + s), bf = frameOf(bel, face + s);
      k.band(tf, 0, tf.len, y, ty, hex, ROW.clap, y, s === 0 ? 1 : 0.95);
      k.ledge(tf, -0.12, tf.len + 0.12, ty - 0.1, ty + 0.14, 0, 0.14, WHITE);
      k.band(bf, 0, bf.len, ty, by, hex, ROW.clap, ty, 1);
      k.vq(k.F, bf, bf.len / 2 - 0.55, bf.len / 2 + 0.55, ty + 0.5, ty + 2.2, 0.03, 0x2e3338);
      k.ledge(bf, -0.2, bf.len + 0.2, by - 0.1, by + 0.12, 0, 0.2, WHITE);
      const ax = PX(bf, 0, 0.1), az = PZ(bf, 0, 0.1), bx = PX(bf, bf.len, 0.1), bz = PZ(bf, bf.len, 0.1);
      k.F.tri(ax, by + 0.12, az, bx, by + 0.12, bz, (bel.x0 + bel.x1) / 2, by + 9.5, (bel.z0 + bel.z1) / 2, 0xf4f1e8);
      if (s === 0) {
        k.piece(tf, tw / 2 - 0.85, 1.7, y + 0.45, 3, 0.03, ROW.door, MWALL.doors.hall, 0x8c2f25);
        k.piece(tf, tw / 2 - 0.5, 1, y + 6.4, 2.6, 0.03, ROW.sash, 5, 0xffffff);
        k.fbox(tf, 0.2, tw - 0.2, 0, 1.3, y, y + 0.45, 0xb9b6ac, 5); k.fbox(tf, 0, tw, 1.3, 1.7, y, y + 0.22, 0xb9b6ac, 5);
      }
    }
    // The notice board on the lawn (the second church in town is the same denomination, less sure of it).
    const bx = PX(L, s0 > 4 ? s0 / 2 : L.len / 2 + 4, -2.2), bz = PZ(L, s0 > 4 ? s0 / 2 : L.len / 2 + 4, -2.2);
    k.board(bx, bz, face, y, 2.4, 'm-church', first ? 0.9 : 0.7, 0xf1ede2);
  }

  /** Indecision Elementary: two floors of red brick with big sashes, a stone doorway in the middle, a flagpole. */
  private school(lot: Rect, face: number, y: number): void {
    const k = this.k, L = frameOf(lot, face), w = Math.min(L.len - 3, 26), D = Math.min(L.depth - 7, 13), s0 = (L.len - w) / 2;
    const br = cut(lot, face, s0, s0 + w, 5, 5 + D), f = frameOf(br, face), hex = 0x9c4a3a, fh = 3.9, b0 = y + 0.8, top = b0 + 2 * fh + 0.9;
    const c0 = w / 2 - 2.3, c1 = w / 2 + 2.3;
    k.solid(br, top, y - 1);
    k.band(f, 0, w, y, b0, 0xbdb9ae, ROW.granite, y);
    k.facade(f, 0, c0, b0, fh, 2, hex, 1, WIN.sash, 2.2, 3);
    k.facade(f, c1, w, b0, fh, 2, hex, 1, WIN.sash, 2.2, 5);
    k.band(f, c0, c1, b0, b0 + 2 * fh, hex, ROW.brick, b0, 1);
    k.band(f, 0, w, b0 + 2 * fh, top, hex, ROW.brick, b0 + 2 * fh, 1);
    k.cornice(f, 0, w, top, hex, 1);
    k.fbox(f, c0 + 0.5, c1 - 0.5, 0, 0.3, y, y + 4.6, STONE, 5);
    k.piece(f, w / 2 - 1, 2, y + 0.8, 2.6, 0.31, ROW.door, MWALL.doors.hall, 0x2c4a3a);
    k.signAt(f, w / 2, y + 3.55, 3.3, 0.31, 'm-school');
    k.piece(f, w / 2 - 0.7, 1.4, b0 + fh + 0.8, 2.3, 0.02, ROW.sash, 9, 0xffffff);
    k.fbox(f, c0, c1, 0.3, 1.5, y, y + 0.8, 0xb9b6ac, 5); k.fbox(f, c0 - 0.3, c1 + 0.3, 1.5, 2.2, y, y + 0.4, 0xb9b6ac, 5);
    for (let s = 1; s < 4; s++) { const sf = frameOf(br, face + s); k.plainWall(sf, 0, sf.len, y, top, hex, 0.95, ROW.brick, { st: WIN.sash, yb: b0, fh, floors: 2, pitch: 2.6, seed: s }); }
    k.F.floor(br.x0, br.z0, br.x1, br.z1, top - 0.2, TAR);
    const px = PX(L, s0 + 2, -2.4), pz = PZ(L, s0 + 2, -2.4);
    k.F.cyl(px, y, pz, 0.06, 0.05, 8.5, 0xd8d8d4, 6, true);
    k.game.col.addProp(px, pz, 0.15, 8, 'post', false);
    const ff = frameOf({ x0: px, z0: pz, x1: px + 0.02, z1: pz + 0.02 }, face + 1);
    k.vq(k.F, ff, 0, 1.5, y + 7.4, y + 8.4, 0, 0x25395c); k.vq(k.F, ff, 1.5, 0, y + 7.4, y + 8.4, 0, 0x25395c);
  }

  // ── Loom Row: the Threadbare mills ──────────────────────────────────────────

  mill(lots: Lot[], first: number): void {
    const k = this.k, y = groundAt(214, -1460), GRAN = 0xb5b1a6;
    // The yards: setts from Water St to the river walk.
    for (const [z0, z1] of [[-1565, -1470], [-1470, -1356], [-1334, -1200]]) { k.at(214, (z0 + z1) / 2); k.F.floor(180, z0, 248, z1, y + 0.05, 0x8a8780, 1, 1, 0.95); }

    // Mill No. 1 and No. 2 under one roof: five floors, sixty bays, 192 m beside the river.
    const M: Rect = { x0: 212, z0: -1556, x1: 234, z1: -1364 }, fh = 4.2, b0 = y + 0.9, top = b0 + 5 * fh + 0.8;
    k.at(223, -1460);
    k.solid(M, top, y - 1);
    for (const side of [1, 3]) {
      const f = frameOf(M, side);
      k.band(f, 0, f.len, y, b0, GRAN, ROW.granite, y);
      k.facade(f, 0, f.len, b0, fh, 5, RED, 1, WIN.mill, 3.2, side * 7);
      k.band(f, 0, f.len, b0 + 5 * fh, top, RED, ROW.brick, b0 + 5 * fh, 1);
      k.cornice(f, 0, f.len, top, RED, 1, 0.62, 0.2);
    }
    for (const side of [0, 2]) {
      const f = frameOf(M, side);
      k.plainWall(f, 0, f.len, y, top, RED, 0.95, ROW.brick, { st: WIN.mill, yb: b0, fh, floors: 5, pitch: 3.2, seed: side + 3 });
      k.cornice(f, 0, f.len, top, RED, 0.95, 0.62, 0.2);
    }
    k.F.floor(M.x0, M.z0, M.x1, M.z1, top - 0.25, TAR);
    k.F.box(223, top - 0.25, -1460, 5, 1.5, 170, 0x7d7f80, 0, 5);

    // The stair tower: two floors clear of the roof, a clock to each side, a slate mansard.
    const T: Rect = { x0: 204, z0: -1464.5, x1: 212.5, z1: -1455.5 }, tt = top + 9;
    k.solid(T, tt + 4, y - 1);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(T, s);
      k.band(f, 0, f.len, y, tt, RED, ROW.brick, y, s === 3 ? 1 : 0.96);
      if (s !== 1) for (let fl = 0; fl < 6; fl++) k.piece(f, f.len / 2 - 0.6, 1.2, b0 + fl * fh + (fl ? 0.9 : 3), 2.4, 0.03, ROW.arch, fl * 3 + s, 0xffffff);
      k.ledge(f, -0.1, f.len + 0.1, top - 0.1, top + 0.2, 0, 0.12, STONE);
      k.signAt(f, f.len / 2, tt - 5.1, 3.7, 0.05, 'm-clock');
      k.cornice(f, 0, f.len, tt, RED, 1, 0.62, 0.22);
    }
    const tw = frameOf(T, 3);
    k.piece(tw, tw.len / 2 - 1.1, 2.2, y, 3.1, 0.035, ROW.door, MWALL.doors.hall, 0x3a4a3a);
    k.signAt(tw, tw.len / 2, y + 3.3, 6, 0.05, 'm-mill');
    k.frustum({ x0: T.x0 - 0.25, z0: T.z0 - 0.25, x1: T.x1 + 0.25, z1: T.z1 + 0.25 }, tt, { x0: T.x0 + 2, z0: T.z0 + 2, x1: T.x1 - 2, z1: T.z1 - 2 }, tt + 4.2, 0x596068, ROW.shingle);
    k.F.floor(T.x0 + 2, T.z0 + 2, T.x1 - 2, T.z1 - 2, tt + 4.2, 0x3a3d40);
    k.F.cyl((T.x0 + T.x1) / 2, tt + 4.2, -1460, 0.07, 0.04, 5, 0x2e3338, 5, false);

    // The boiler house and the stack with the company's name down it.
    k.at(214, -1321);
    const BH: Rect = { x0: 198, z0: -1331, x1: 221, z1: -1311 }, bt = y + 9.4;
    k.solid(BH, bt, y - 1);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(BH, s);
      if (s === 3) { k.band(f, 0, f.len, y, y + 0.9, GRAN, ROW.granite, y); k.facade(f, 0, f.len, y + 0.9, 7.7, 1, RED, 1, { ...WIN.round, w: 1.9, h: 5, sill: 0.9 }, 3.6, 4); k.band(f, 0, f.len, y + 8.6, bt, RED, ROW.brick, y + 8.6); }
      else k.plainWall(f, 0, f.len, y, bt, RED, 0.95, ROW.brick, { st: { ...WIN.round, w: 1.9, h: 5, sill: 1.8 }, yb: y, fh: 8, floors: 1, pitch: 4.4, seed: s });
      k.cornice(f, 0, f.len, bt, RED, 1);
    }
    k.F.floor(BH.x0, BH.z0, BH.x1, BH.z1, bt - 0.25, TAR);
    const sx = 229, sz = -1321, SH = 44.2, hw = (t: number): number => 2.3 - 0.95 * t, sq = (h: number): Rect => ({ x0: sx - h, z0: sz - h, x1: sx + h, z1: sz + h });
    for (let i = 0; i < 13; i++) k.frustum(sq(hw(i / 13)), y + i * 3.4, sq(hw((i + 1) / 13)), y + (i + 1) * 3.4, RED, ROW.brick);
    k.F.box(sx, y + SH - 1.6, sz, 3.2, 0.5, 3.2, dim(RED, 0.75)); k.F.box(sx, y + SH, sz, 3.4, 0.7, 3.4, dim(RED, 0.6));
    k.F.floor(sx - 1, sz - 1, sx + 1, sz + 1, y + SH + 0.72, 0x151515);
    k.solid(sq(2.3), y + SH, y - 1);
    {
      const [v0, v1] = mwallV(ROW.ghost), u0 = 0.752, u1 = 0.998, ya = y + 23, yb = y + 37, ta = 23 / SH, tb = 37 / SH;
      for (const side of [1, 2, 3]) {
        const a = frameOf(sq(hw(ta)), side), b = frameOf(sq(hw(tb)), side), W = k.W, o = 0.05, hwid = 1.3;
        W.quad(PX(a, a.len / 2 - hwid, o), ya, PZ(a, a.len / 2 - hwid, o), PX(a, a.len / 2 + hwid, o), ya, PZ(a, a.len / 2 + hwid, o),
          PX(b, b.len / 2 + hwid, o), yb, PZ(b, b.len / 2 + hwid, o), PX(b, b.len / 2 - hwid, o), yb, PZ(b, b.len / 2 - hwid, o), RED);
        W.uv.length -= 8;
        W.uv.push(u1, v0, u1, v1, u0, v1, u0, v0);
      }
    }

    // The weave shed: one floor under ten north lights, a loading dock to Water St.
    k.at(216, -1255);
    const WS: Rect = { x0: 192, z0: -1298, x1: 240, z1: -1212 }, wy = y + 6, TOOTH = 8.6, us = 1 / (CELL * 16);
    k.solid(WS, wy + 1.5, y - 1);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(WS, s);
      if (s & 1) { k.band(f, 0, f.len, y, y + 0.9, GRAN, ROW.granite, y); k.facade(f, 0, f.len, y + 0.9, 5.1, 1, RED, 1, WIN.mill, 3.4, 9 + s); }
      else k.plainWall(f, 0, f.len, y, s === 0 ? wy + 2.8 : wy, RED, 0.95);
      k.ledge(f, 0, f.len, wy - 0.02, wy + 0.16, 0, 0.1, STONE);
    }
    const [m0, m1] = mwallV(ROW.mill), [e0, e1] = mwallV(ROW.seam), [g0, g1] = mwallV(ROW.brick);
    for (let i = 0; i < 10; i++) {
      const tr: Rect = { x0: WS.x0, x1: WS.x1, z0: WS.z0 + i * TOOTH, z1: WS.z0 + (i + 1) * TOOTH }, f = frameOf(tr, 0);
      if (i) k.vq(k.W, f, 0, f.len, wy, wy + 2.8, 0, 0xffffff, 0, m0, 1, m1);
      k.sq(k.W, f, 0, f.len, -TOOTH, wy, 0, wy + 2.8, 0xaab0b0, 1, 0, e0, f.len * us, e1);
      const fw = frameOf(tr, 3), fe = frameOf(tr, 1), W = k.W;
      W.tri(fw.ox, wy, fw.oz, PX(fw, TOOTH, 0), wy, PZ(fw, TOOTH, 0), fw.ox, wy + 2.8, fw.oz, RED);
      W.uv.length -= 6; W.uv.push(0, g0, TOOTH * us, g0, 0, g0 + (g1 - g0) * 2.8 / CELL);
      W.tri(fe.ox, wy, fe.oz, PX(fe, TOOTH, 0), wy, PZ(fe, TOOTH, 0), PX(fe, TOOTH, 0), wy + 2.8, PZ(fe, TOOTH, 0), RED);
      W.uv.length -= 6; W.uv.push(0, g0, TOOTH * us, g0, TOOTH * us, g0 + (g1 - g0) * 2.8 / CELL);
    }
    {
      const f = frameOf(WS, 3), d0 = 10, d1 = 54;
      k.fbox(f, d0, d1, 0, 3.2, y, y + 1.15, 0xa9a69c, 5);
      k.solid(frect(f, d0, d1, 0, 3.2), y + 1.15, y - 1);
      k.fbox(f, d0 - 0.5, d1 + 0.5, 0, 3.8, y + 4.7, y + 4.9, 0x5a5d5e, 7);
      for (let i = 0; i < 5; i++) k.piece(f, d0 + 2.5 + i * 9, 3.4, y + 1.15, 3.2, 0.2, ROW.door, MWALL.doors.garage, 0x6b7a72);
    }

    // The river walk, railed on the water side, with a break where the footbridge lands.
    for (let z = -1560; z < -1204; z += 59) {
      const z1 = Math.min(z + 59, -1204);
      k.at(246, (z + z1) / 2);
      k.F.floor(244, z, 247.6, z1, y + 0.08, 0xb9b3a4, 1, 1, 0.97);
      for (const [a, b] of z < -1345 && z1 > -1345 ? [[z, -1348], [-1342, z1]] : [[z, z1]]) k.fenceRun({ x0: 247.8, z0: a, x1: 247.8, z1: b }, y, 'rail');
      if (!k.low) for (const bz of [z + 14, z + 44]) if (Math.abs(bz + 1345) > 6 && bz < z1) {
        k.F.box(244.5, y + 0.4, bz, 0.45, 0.07, 1.7, 0x6a4a32); k.F.box(244.3, y + 0.47, bz, 0.07, 0.42, 1.7, 0x6a4a32);
        k.F.box(244.5, y, bz - 0.7, 0.4, 0.4, 0.08, IRON, 0, 4); k.F.box(244.5, y, bz + 0.7, 0.4, 0.4, 0.08, IRON, 0, 4);
      }
    }

    // The headrace, its gatehouse, and the penstock down the bank to the wheelhouse below the dam.
    k.at(256, -1580);
    k.F.box(250.7, y, -1595, 0.6, 0.6, 34, GRAN); k.F.box(257.3, y, -1595, 0.6, 0.6, 34, GRAN); k.F.box(254, y, -1612.3, 7.2, 0.6, 0.6, GRAN);
    k.F.floor(251, -1612, 257, -1578, y + 0.32, 0x3c5a60);
    for (const wx of [250.7, 257.3]) k.game.col.addBox(wx - 0.3, -1612, wx + 0.3, -1578, y + 0.6, y - 1);
    const GH: Rect = { x0: 249.5, z0: -1578, x1: 258.5, z1: -1570 }, gt = y + 5.2;
    k.solid(GH, gt + 1.5, y - 2);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(GH, s);
      k.plainWall(f, 0, f.len, y - 1.5, gt, RED, 1, ROW.brick, s === 0 ? undefined : { st: WIN.arch, yb: y + 0.8, fh: 4, floors: 1, pitch: 3, seed: s });
      k.cornice(f, 0, f.len, gt, RED, 1, 0.5, 0.14);
    }
    k.piece(frameOf(GH, 3), 3.5, 1, y, 2.2, 0.03, ROW.door, MWALL.doors.steel);
    k.frustum({ x0: GH.x0 - 0.3, z0: GH.z0 - 0.3, x1: GH.x1 + 0.3, z1: GH.z1 + 0.3 }, gt, { x0: GH.x0 + 3.5, z0: GH.z0 + 3.9, x1: GH.x1 - 3.5, z1: GH.z1 - 3.9 }, gt + 2.4, 0x596068, ROW.shingle);
    const WH: Rect = { x0: 262, z0: -1553, x1: 272, z1: -1541 }, hy = Math.min(groundAt(262, -1547), groundAt(272, -1547)), ht = y + 3.6;
    k.solid(WH, ht, hy - 1);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(WH, s);
      k.plainWall(f, 0, f.len, hy - 1, ht, RED, 0.97, ROW.brick, { st: WIN.arch, yb: ht - 3.6, fh: 3.4, floors: 1, pitch: 3.2, seed: s + 5 });
      k.cornice(f, 0, f.len, ht, RED, 1, 0.5, 0.14);
    }
    k.F.floor(WH.x0, WH.z0, WH.x1, WH.z1, ht - 0.2, TAR);
    const RUST = 0x6f4a38, p0 = [254, y + 1.5, -1570], p1 = [266, y + 1.3, -1553];
    k.pipe(k.F, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 1, RUST, k.low ? 6 : 10);
    for (let i = 1; i < 6; i++) {
      const t = i / 6, px = p0[0] + (p1[0] - p0[0]) * t, py = p0[1] + (p1[1] - p0[1]) * t, pz = p0[2] + (p1[2] - p0[2]) * t, g = groundAt(px, pz);
      if (!k.low) k.pipe(k.F, px - 0.1, py, pz - 0.14, px + 0.1, py, pz + 0.14, 1.12, dim(RUST, 0.8), 10);
      if (i % 2) k.F.box(px, g - 0.5, pz, 2.6, py - g, 1, 0xa9a69c, Math.atan2(p1[0] - p0[0], p1[2] - p0[2]) + Math.PI / 2, 4);
      k.game.col.addBox(px - 1.2, pz - 1.6, px + 1.2, pz + 1.6, py + 1, g - 1);
    }

    // The blocks west of Water St: tenement rows for the hands, and the smaller mills that spun off the big one.
    lots.forEach((lot, i) => {
      if (lot.district !== 'mill' || lot.block < 0 || onMain(lot)) return;
      const r = lot.rect, rng = new RNG(77000 + first + i), ly = groundAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      k.at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      let rr = r;
      // A lot that touches Main St but faces a cross street gives its west 17 m to Main St's wall of shops.
      if (Math.abs(r.x0 - 83.5) < 1.5 && r.x1 - r.x0 > 44) { this.row({ ...r, x1: r.x0 + 17 }, 3, ly, rng, lot.block, true, null); rr = { ...r, x0: r.x0 + 19 }; }
      if (rng.chance(0.55)) this.tenement(rr, lot.face, ly, rng); else this.smallMill(rr, lot.face, ly, rng);
    });
  }

  /** A brick tenement row: three floors of segmental windows, a door and a granite stoop every third bay. */
  private tenement(lot: Rect, face: number, y: number, rng: RNG): void {
    const k = this.k, L = frameOf(lot, face), w = L.len - 1.2, D = Math.min(11.5, L.depth - 3), br = cut(lot, face, 0.6, 0.6 + w, 1.7, 1.7 + D), f = frameOf(br, face);
    const fh = 3.3, b0 = y + 0.7, top = b0 + 3 * fh + 0.7, shade = rng.range(0.85, 1.05), pitch = 2.7, seed = rng.int(0, 99), GRAN = 0xb5b1a6;
    k.solid(br, top, y - 1);
    k.band(f, 0, w, y, b0, GRAN, ROW.granite, y);
    k.facade(f, 0, w, b0, fh, 3, RED, shade, WIN.arch, pitch, seed);
    k.band(f, 0, w, b0 + 3 * fh, top, RED, ROW.brick, b0 + 3 * fh, shade);
    k.cornice(f, 0, w, top, RED, shade);
    const n = Math.max(1, Math.floor((w - 0.5) / pitch)), m = (w - n * pitch) / 2;
    for (let i = 1; i < n; i += 3) {
      const s = m + i * pitch;
      k.piece(f, s - 0.52, 1.04, b0, 2.3, 0.03, ROW.door, MWALL.doors.panel + 8 * (i % 4), rng.pick(DOORC));
      k.vq(k.F, f, s - 0.64, s + 0.64, b0 + 2.3, b0 + 2.5, 0.04, STONE);
      k.fbox(f, s - 0.8, s + 0.8, 0, 1, y, b0, GRAN, 5); k.fbox(f, s - 0.8, s + 0.8, 1, 1.4, y, y + 0.35, GRAN, 5);
    }
    const wins = { st: WIN.sash, yb: b0, fh, floors: 3, pitch: 3, seed, trim: 0xe4dcc6 };
    for (let s = 1; s < 4; s++) { const sf = frameOf(br, face + s); k.plainWall(sf, 0, sf.len, y, top, RED, shade * 0.94, ROW.brick, wins); }
    k.F.floor(br.x0 + 0.05, br.z0 + 0.05, br.x1 - 0.05, br.z1 - 0.05, top - 0.2, TAR);
    if (!k.low) for (let s = 4; s < w - 2; s += 8.1) k.F.box(PX(f, s, -D / 2), top - 0.2, PZ(f, s, -D / 2), 0.9, 1.5, 0.9, dim(RED, 0.85), 0, 5, shade);
  }

  /** One of the lesser mills: two to four floors of the big one's windows, a loading door, a flat roof. */
  private smallMill(lot: Rect, face: number, y: number, rng: RNG): void {
    const k = this.k, L = frameOf(lot, face), w = Math.min(L.len - 3, 46), D = Math.min(L.depth - 5, 16), s0 = (L.len - w) / 2;
    const br = cut(lot, face, s0, s0 + w, 2, 2 + D), f = frameOf(br, face), floors = rng.int(2, 4), fh = 4.2, b0 = y + 0.8, top = b0 + floors * fh + 0.8;
    const shade = rng.range(0.85, 1.05), seed = rng.int(0, 99);
    k.solid(br, top, y - 1);
    k.band(f, 0, w, y, b0, 0xb5b1a6, ROW.granite, y);
    k.facade(f, 0, w, b0, fh, floors, RED, shade, WIN.mill, 3.3, seed);
    k.band(f, 0, w, b0 + floors * fh, top, RED, ROW.brick, b0 + floors * fh, shade);
    k.cornice(f, 0, w, top, RED, shade, 0.62, 0.2);
    const wins = { st: WIN.mill, yb: b0, fh, floors, pitch: 3.6, seed };
    for (let s = 1; s < 4; s++) { const sf = frameOf(br, face + s); k.plainWall(sf, 0, sf.len, y, top, RED, shade * 0.94, ROW.brick, wins); k.cornice(sf, 0, sf.len, top, RED, shade * 0.94, 0.62, 0.2); }
    k.piece(frameOf(br, face + 1), 1.2, 3, y, 3.1, 0.04, ROW.door, MWALL.doors.garage, 0x5d6b64);
    k.F.floor(br.x0 + 0.05, br.z0 + 0.05, br.x1 - 0.05, br.z1 - 0.05, top - 0.2, TAR);
    if (!k.low) k.F.box((br.x0 + br.x1) / 2, top - 0.2, (br.z0 + br.z1) / 2, 2.4, 2.2, 2.4, dim(RED, 0.9), 0, 5, shade);
  }
}

export function buildMainlandBuildings(game: Game, mats: CityMaterials, parent: THREE.Object3D): WorldPart {
  const kit = KIT = new MainKit(game, mats, parent), plan = game.plan;
  const b = new Builder(kit, game);
  // `?mainst=0`: Main St built in code as before, for comparing.
  const ms = new MainStreet(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  if (new URLSearchParams(location.search).get('mainst') !== '0') b.ms = ms;
  b.main(plan.mainlandLots, plan.blocks, plan.lots.length);
  b.stacks(plan.mainlandLots, plan.blocks, plan.lots.length);
  b.mill(plan.mainlandLots, plan.lots.length);
  // No kit.finish() here: mainlandPlaces.ts draws the landmarks into the same batches and builds the meshes.
  const pd = new PardonsStore(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  return { update: () => { kit.update(); ms.update(); pd.update(); }, setNight: (n: number) => { kit.setNight(); ms.setNight(n); pd.setNight(n); } };
}

void CURB; void IRON; void WHITE;
