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

import { RAILWAY } from './railway';
import { obbSlices } from './obbSlices';
import * as THREE from 'three';
import { CAMPUS_BOXES } from './dithersPlan';
import { PD } from './pardonsSite';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials, Surface } from './materials';
import { Batch } from './batch';
import { CURB, groundAt, streetSurface, type Block, type CityPlan, type Lot, type Rect } from './plan';
import { plantExtra } from './floraAssets';
import { STREETS_NEW } from './streets';
import { EXTRA_LOTS, FOOTBRIDGE_Z, waterDist, coastSD } from './mainland';
import { FOOTPRINTS, FP_STRIDE } from './footprintData';
import { DIRECTORY } from './directory';
import { FENCE_UV, MAIN_SHOPS, MWALL, makeMainlandTextures, mwallV, signKey, type MainlandTextures } from './textures';
import { RNG } from '../core/util';
import { FASCIA_OUT, MS_XE, MS_XW, MainStreet } from './mainStreetAssets';
import { LACKWOOL, RIVER_ON, Riverfront } from './riverfrontAssets';
import { PardonsStore } from './pardonsStore';
import { CIVIC, civic, makeCivic } from './civicAssets';
import { civicHero, heroFit, makeCivicHero } from './civicHero';
import { BY_KIND, DESIGN, HOUSES_ON, houses, makeHouses, type Kind } from './houseAssets';

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
/** True when the whole outline of an axis rectangle is at least `m` clear of every mainland road. */
function rectClearOfRoads(G: { clearOfRoads(x: number, z: number, m: number): boolean }, r: Rect, m: number): boolean {
  for (let x = r.x0; x <= r.x1 + 0.01; x += 1) if (!G.clearOfRoads(x, r.z0, m) || !G.clearOfRoads(x, r.z1, m)) return false;
  for (let z = r.z0; z <= r.z1 + 0.01; z += 1) if (!G.clearOfRoads(r.x0, z, m) || !G.clearOfRoads(r.x1, z, m)) return false;
  return true;
}
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
  /** Phones: the simple versions (no dressing on side walls, no roof plant). */
  readonly lean: boolean;
  private wall = new Chunks(); private flat = new Chunks(); private sign = new Chunks(); private fence = new Chunks();
  /** Batches of the chunk chosen by at(): wall sheet, flat colour, signs, fence strip. */
  W!: Batch; F!: Batch; S!: Batch; N!: Batch;
  tris = 0;
  private shown = true;
  private meshes: THREE.Mesh[] = [];
  private cullAt = new THREE.Vector3(1e9, 0, 0);

  constructor(readonly game: Game, readonly mats: CityMaterials, parent: THREE.Object3D) {
    this.low = game.quality.name === 'low';
    this.lean = !!game.quality.lean;
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
    if (row < 0) { this.vq(this.F, f, s0, s1, y0, y1, o, hex, 0, 0, 1, 1, shade); return; }
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
  /**
   * One row of windows laid on a wall that is already drawn (no reveal), spaced `pitch` apart and centred between s0 and s1. With `dress`
   * each gets a sill and a lintel standing a little proud (not on the low preset or phones).
   */
  winRow(f: Frame, s0: number, s1: number, y: number, st: WinStyle, pitch: number, seed: number, trim = 0xffffff, shade = 1, dress = false, o = 0.02): void {
    const n = Math.floor((s1 - s0 - 1) / pitch), m = (s1 - s0 - n * pitch) / 2 + (pitch - st.w) / 2;
    for (let i = 0; i < n; i++) {
      const s = s0 + m + i * pitch;
      this.piece(f, s, st.w, y, st.h, o, st.row, (seed + i * 7) % 32, st.own ? 0xffffff : trim, st.own ? shade : 1);
      if (!dress || st.own || this.low || this.lean) continue;
      this.vq(this.F, f, s - 0.1, s + st.w + 0.1, y - 0.14, y, o + 0.035, STONE, 0, 0, 1, 1, shade);
      this.vq(this.F, f, s - 0.12, s + st.w + 0.12, y + st.h, y + st.h + 0.2, o + 0.02, STONE, 0, 0, 1, 1, shade * 0.97);
    }
  }
  /** A blank wall with windows laid on it, for sides and backs nobody walks along. */
  plainWall(f: Frame, s0: number, s1: number, y0: number, y1: number, hex: number, shade: number, row: number = ROW.brick, wins?: { st: WinStyle; yb: number; fh: number; floors: number; pitch: number; seed: number; trim?: number; dress?: boolean }): void {
    this.band(f, s0, s1, y0, y1, hex, row, y0, shade);
    if (!wins) return;
    for (let fl = 0; fl < wins.floors; fl++) this.winRow(f, s0, s1, wins.yb + fl * wins.fh + wins.st.sill, wins.st, wins.pitch, wins.seed * 3 + fl * 11, wins.trim ?? 0xffffff, shade, !!wins.dress);
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
  /** gableRoof() on the four frames of an oriented rectangle (oframes order): the ridge runs along the front wall (alongFront) or across it. */
  ogable(fr: Frame[], y: number, rise: number, alongFront: boolean, over: number, roofHex: number, wallHex: number, gableRow: number, shade = 1, roofRow: number = ROW.shingle): void {
    const W = this.W, [v0, v1] = mwallV(roofRow), us = 1 / (CELL * 16);
    for (const side of alongFront ? [0, 2] : [1, 3]) {
      const f = fr[side], half = f.depth / 2, run = half + over, k = rise / half;
      const slope = Math.hypot(run, run * k), rows = Math.max(1, Math.round(slope / CELL));
      this.sq(W, f, -over, f.len + over, -half, y + rise, over, y - over * k, roofHex, shade, 0, v0, (f.len + 2 * over) * us, v0 + (v1 - v0) * Math.min(1, slope / (rows * CELL)));
      if (!this.low) this.sq(this.F, f, -over, f.len + over, 0, y, over, y - over * k, dim(wallHex, 0.8), shade * 0.8, 0, 0, 1, 1, true);
    }
    const [g0, g1] = mwallV(gableRow);
    for (const side of alongFront ? [1, 3] : [0, 2]) {
      const f = fr[side];
      W.tri(PX(f, 0, 0), y, PZ(f, 0, 0), PX(f, f.len, 0), y, PZ(f, f.len, 0), PX(f, f.len / 2, 0), y + rise, PZ(f, f.len / 2, 0), wallHex, shade);
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
export const OPERA: Rect = STREETS_NEW ? { x0: 109, z0: -1866, x1: 153, z1: -1837.5 } : { x0: -2, z0: -1543, x1: 42, z1: -1514.5 };

// ── The new streets' lots (tepid-streets.md unit 4) ──────────────────────────
//
// Under the new streets (streets.ts) every building stands on the street graph's oriented frontage lots instead of the old
// grid's. The builders here draw in axis-aligned rects, so each lot becomes the biggest axis rect, facing the side nearest its
// heading, that keeps a sidewalk clear of every road and of its neighbours. Main St's two rows are laid out on their own (the
// Blender models fill them), and the set pieces keep their sites (NEW_SITES): nothing else is built there.

/** The set pieces' sites under the new streets. */
export const NEW_SITES = {
  /** Quorum Square: east of Main St at Bobbin St (real Castonguay Square, Main x Common St), behind the east row. */
  square: { x0: 103, z0: -1839, x1: 159.5, z1: -1776.5 } as Rect,
  /** Postponement Hall and its forecourt, north of the square across its north walk, facing south over it. */
  hall: { x0: 109, z0: -1866, x1: 153, z1: -1837.5 } as Rect,
  /** The Holding Pattern: west of Main St from Tarnish St to Applejack St, between Dutch Elm St and the west row's backs (the real Concourse). */
  hp: { x0: 15, z0: -1935, x1: 48, z1: -1772 } as Rect,
};
/** New streets: ground kept for set pieces that are not lots. ground.ts keeps its woods off the same rectangles. */
export const RESERVED: Rect[] = STREETS_NEW ? [
  NEW_SITES.square, NEW_SITES.hall, NEW_SITES.hp,
  { x0: 200, z0: -2250, x1: 228, z1: -2214 },   // the Dead Letter Office
  { x0: -153, z0: -1320, x1: -104, z1: -1274 }, // Our Lady (set at an angle to Tarnish St)
  { x0: 222, z0: -1768, x1: 262, z1: -1664 },   // the depot, its platform and the water tower by the west-bank line
  ...(RAILWAY ? RAILWAY.reserved : []),          // the railway's corridor (world/railway.ts): no lot on the track, the yard or the lead
  { x0: 176, z0: -1568, x1: 252, z1: -1196 },   // Threadbare mill yards, Water St to the river walk
  { x0: 176, z0: -1896, x1: 290, z1: -1884 },   // the walk from Front St to the footbridge
  { x0: PD.XE - PD.SW - 8, z0: PD.LOT.z0 - 4, x1: PD.XE + 6, z1: PD.ZF + PD.SD + 6 }, // Pardon's: its lot and store (pardonsSite.ts); no footprint or gap-fill building on them
  ...CAMPUS_BOXES.map((b): Rect => ({ x0: b[0], z0: b[1], x1: b[2], z1: b[3] })), // Dithers College (dithersPlan.ts)
] : [];

const hitsR = (a: Rect, b: Rect, m = 0): boolean => a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;

/** Main St's frontages between the cross streets: z from, z to (south to north), per side. */
const MAIN_ROWS: Record<'w' | 'e', [number, number][]> = {
  w: [[-1643, -1757], [-1777, -1865], [-1885, -1948], [-1969, -2048]],
  e: [[-1640, -1757], [-1777, -1864], [-1884, -1950], [-1988, -2062]],
};

/** A lot at its own angle: centre, heading of its front (forward = (sin h, cos h)), frontage w across it, depth d. */
export interface Ori { cx: number; cz: number; h: number; w: number; d: number }
/** A lot, and for houses that stand at the street's own angle (houseAssets.ts) the oriented lot they stand on. */
export interface OLot extends Lot {
  ori?: Ori;
  /** Built from a real OSM footprint (footprintData.ts): kit code (0 house .. 9 hall), the LiDAR height in metres (0 unknown) and the footprint's index. */
  osm?: { t: number; hm: number; i: number };
  /** Where the front wall stands once built (hood() and osm() fill it in): the wall's foot and the unit normal out of the front. Businesses hang their signs here. */
  wall?: { x: number; z: number; nx: number; nz: number };
  /** The street doors osm() drew on this building, each with the place its sign goes: businesses (business.ts) take a door each, shopSigns.ts letters the signs. */
  doors?: Door[];
}
/**
 * A street door on a footprint building: its foot on the wall line and the unit normal out of the wall, and the sign board over it
 * (centre of its foot, standing just off the wall; w x h metres). `opt`: only lettered when a business is there (a block of flats needs no sign).
 */
export interface Door { x: number; z: number; nx: number; nz: number; sx: number; sy: number; sz: number; sw: number; sh: number; opt?: boolean; used?: boolean; /** Height of the lamp over the door (0: none). */ ly?: number }
/** How far into the night the town is (0 day .. 1 night), for the unlit sign boards (shopSigns.ts) to dim by. */
export const TOWN_NIGHT = { value: 0 };
let MASK: Map<number, Ori[]> | null = null;
/** Builds the footprint buildings' spatial hash (20 m cells): trees and street furniture ask `buildingNear` so nothing grows through a store. Call before the trees are planted. */
export function primeBuildingMask(plan: CityPlan): void {
  if (MASK || !plan.streets) return;
  MASK = new Map();
  for (const l of mainlandLots(plan)) {
    const o = l.ori;
    if (!o || !l.osm || l.osm.t === 0) continue;
    const r = Math.hypot(o.w, o.d) / 2 + 4;
    for (let cx = Math.floor((o.cx - r) / 20); cx <= Math.floor((o.cx + r) / 20); cx++) for (let cz = Math.floor((o.cz - r) / 20); cz <= Math.floor((o.cz + r) / 20); cz++) {
      const k = cx * 4096 + cz;
      const a = MASK.get(k);
      if (a) a.push(o); else MASK.set(k, [o]);
    }
  }
}
/** Whether (x, z) is within m metres of a footprint building (after primeBuildingMask). */
export function buildingNear(x: number, z: number, m: number): boolean {
  if (!MASK) return false;
  const a = MASK.get(Math.floor(x / 20) * 4096 + Math.floor(z / 20));
  if (!a) return false;
  for (const o of a) {
    const fx = Math.sin(o.h), fz = Math.cos(o.h), ex = x - o.cx, ez = z - o.cz;
    if (Math.abs(ex * fz - ez * fx) < o.w / 2 + m && Math.abs(ex * fx + ez * fz) < o.d / 2 + m) return true;
  }
  return false;
}

/** `?osm=0`: the street graph's lots only, as before the footprints (for comparing). */
const OSM_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('osm') !== '0';
const oriCorners = (o: Ori, m = 0): number[] => {
  const fx = Math.sin(o.h), fz = Math.cos(o.h), rx = fz, rz = -fx, hw = o.w / 2 + m, hd = o.d / 2 + m;
  return [o.cx + fx * hd + rx * hw, o.cz + fz * hd + rz * hw, o.cx + fx * hd - rx * hw, o.cz + fz * hd - rz * hw,
    o.cx - fx * hd - rx * hw, o.cz - fz * hd - rz * hw, o.cx - fx * hd + rx * hw, o.cz - fz * hd + rz * hw];
};
/** Whether two oriented rectangles (a grown by m on every side) overlap: separating axis test. */
function oriHit(a: Ori, b: Ori, m: number): boolean {
  const ca = oriCorners(a, m), cb = oriCorners(b);
  for (const l of [a, b]) for (const [ax, az] of [[Math.sin(l.h), Math.cos(l.h)], [Math.cos(l.h), -Math.sin(l.h)]]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const pa = ca[k] * ax + ca[k + 1] * az, pb = cb[k] * ax + cb[k + 1] * az;
      a0 = Math.min(a0, pa); a1 = Math.max(a1, pa); b0 = Math.min(b0, pb); b1 = Math.max(b1, pb);
    }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
const rectOri = (r: Rect): Ori => ({ cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, h: 0, w: r.x1 - r.x0, d: r.z1 - r.z0 });


/**
 * Where the real town is open and the street plan's frontage lots would build it solid (audit #12): Water St's 30-lot row over the
 * real ponds goes, and the South End and West End keep about a quarter of their lots (more where a real footprint stands: those are
 * placed first and keep their ground). Deterministic per lot.
 */
function keepStack(x: number, z: number, block: number): boolean {
  if (x > 120 && x < 172 && z > -1595 && z < -1115) return false;
  const south = z > -1640 && x < 120, west = x < 20 && z < -1640 && z > -2060 && x > -700;
  if (!south && !west) return true;
  const h = Math.imul(Math.round(x * 7) ^ Math.imul(Math.round(z * 13), 2654435761) ^ block, 2246822519) >>> 0;
  // (Was a quarter: OpenStreetMap has simply not traced these streets' houses. The real South End and West End are built
  // up lot after lot, so most lots keep their house and the gaps are the exception.)
  return (h % 1000) / 1000 < 0.8;
}

let LOTS: OLot[] | null = null;
/** The lots the builders here and mainlandPlaces.ts build on: plan.mainlandLots, or under the new streets the converted ones. */
export function mainlandLots(plan: CityPlan): OLot[] {
  const G = plan.streets;
  if (!G) return plan.mainlandLots;
  if (LOTS) return LOTS;
  const out: OLot[] = [], taken: Rect[] = [], takenO: Ori[] = [];
  const clear = (r: Rect, margin: number): boolean => {
    if (r.x1 - r.x0 < 4 || r.z1 - r.z0 < 4) return false;
    for (const q of RESERVED) if (hitsR(r, q)) return false;
    for (const q of taken) if (hitsR(r, q, 0.6)) return false;
    if (takenO.length) { const ro = rectOri(r); for (const t of takenO) if (oriHit(ro, t, 0.6)) return false; }
    const nx = Math.ceil((r.x1 - r.x0) / 3), nz = Math.ceil((r.z1 - r.z0) / 3);
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      if (i > 0 && i < nx && j > 0 && j < nz) continue;
      if (!G.clearOfRoads(r.x0 + ((r.x1 - r.x0) * i) / nx, r.z0 + ((r.z1 - r.z0) * j) / nz, margin)) return false;
    }
    return G.clearOfRoads((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, margin);
  };
  // Main St: wall-to-wall rows on both sides, cut into lots of about 36 m, as deep as the street behind allows.
  for (const side of ['w', 'e'] as const) for (const [za, zb] of MAIN_ROWS[side]) {
    const n = Math.max(1, Math.round((za - zb) / 36)), step = (za - zb) / n;
    for (let i = 0; i < n; i++) {
      const Z1 = za - i * step - (i ? 0.3 : 0), Z0 = za - (i + 1) * step + (i < n - 1 ? 0.3 : 0);
      // Where a cross street comes in at an angle it cuts the corner: shorten the end lot rather than lose it.
      let placed = false;
      for (const trim of [0, 6, 12, 18]) {
        if (placed) break;
        const z1 = i === 0 ? Z1 - trim : Z1, z0 = i === n - 1 ? Z0 + trim : Z0;
        if ((i !== 0 && i !== n - 1 && trim) || z1 - z0 < 12) continue;
      for (let D = 24; D >= 10; D -= 1) {
        const r: Rect = side === 'w' ? { x0: MS_XW - D, z0, x1: MS_XW, z1 } : { x0: MS_XE, z0, x1: MS_XE + D, z1 };
        // The fronts sit on the sidewalk's back edge, so test only the back three quarters against the roads.
        const back: Rect = side === 'w' ? { ...r, x1: r.x1 - D / 4 } : { ...r, x0: r.x0 + D / 4 };
        if (!clear(back, 3.0)) continue;
        out.push({ rect: r, block: 100000 + (side === 'w' ? 900 : 950) + Math.round(-za / 100), district: 'main', face: side === 'w' ? 1 : 3, interior: false });
        // An alley behind: neighbours keep 3 m off the backs.
        taken.push(side === 'w' ? { ...r, x0: r.x0 - 3 } : { ...r, x1: r.x1 + 3 });
        placed = true;
        break;
      }
      }
    }
  }
  // Real footprints (OSM, warped with the street plan; footprintData.ts): a building where a real one stands, turned to face the
  // nearest street, sized like the real one. Set pieces, roads, water and the rail corridor keep their ground; these go in before the
  // graph's own lots, which then give way where a footprint stands (and thin out where the real town is open: see `keepStack`).
  if (OSM_ON) {
    const idx: number[] = [];
    for (let i = 0; i < FOOTPRINTS.length / FP_STRIDE; i++) idx.push(i);
    // Big and civic things first, houses last, so a mill never loses its ground to the sheds around it.
    const rank = (i: number): number => { const t = FOOTPRINTS[i * FP_STRIDE + 5]; return t === 0 ? 2 : t === 1 ? 1 : 0; };
    idx.sort((a, b) => rank(a) - rank(b) || FOOTPRINTS[b * FP_STRIDE + 2] * FOOTPRINTS[b * FP_STRIDE + 3] - FOOTPRINTS[a * FP_STRIDE + 2] * FOOTPRINTS[a * FP_STRIDE + 3]);
    const landOk = (x: number, z: number): boolean => coastSD(x, z) < -6 && waterDist(x, z) > 9;
    for (const i of idx) {
      const b = i * FP_STRIDE, cx = FOOTPRINTS[b], cz = FOOTPRINTS[b + 1], L = FOOTPRINTS[b + 2], W = FOOTPRINTS[b + 3], ha = FOOTPRINTS[b + 4], t = FOOTPRINTS[b + 5], hm = FOOTPRINTS[b + 6] / 10;
      if (RESERVED.some((q) => cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1)) continue;
      if (!landOk(cx, cz)) continue;
      const ne = G.nearestEdge(cx, cz, (e) => !e.deck), pp = G.pointAt(ne.edge, ne.s);
      let dx = pp.x - cx, dz = pp.z - cz; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      // The face looking most nearly at the street.
      const ax = Math.sin(ha), az = Math.cos(ha), cands: [number, number, boolean][] = [[ax, az, true], [-ax, -az, true], [az, -ax, false], [-az, ax, false]];
      let best = cands[0], bd = -2;
      for (const c of cands) { const v = c[0] * dx + c[1] * dz; if (v > bd) { bd = v; best = c; } }
      let h = Math.atan2(best[0], best[1]);
      let w = best[2] ? W : L, d = best[2] ? L : W;
      const house = t === 0;
      if (house) {
        // A house looks squarely at its street, door to the sidewalk: the street's own normal where it passes nearest. (The real footprint's
        // angle is often some degrees off the game's street, or belongs to a lane the game does not have.)
        const tl = Math.hypot(pp.dx, pp.dz) || 1;
        let sx = -pp.dz / tl, sz = pp.dx / tl;
        if (sx * dx + sz * dz < 0) { sx = -sx; sz = -sz; }
        if (sx * dx + sz * dz > 0.6) h = Math.atan2(sx, sz);
      }
      if (house) { w = Math.max(7, Math.min(w, 11)); d = Math.max(7, Math.min(d, 12)); }
      else if (t === 1) { w = Math.max(9, Math.min(w, 24)); d = Math.max(9, Math.min(d, 20)); }
      else { w = Math.max(10, Math.min(w, 85)); d = Math.max(9, Math.min(d, 60)); }
      let got: Ori | null = null;
      const roadM = house ? 2.4 : 3.2;
      /** Whether an oriented footprint (or house lot) stands on free ground: off the set pieces, the other buildings, the roads and the water. */
      const fits = (o: Ori): number => {
        if (RESERVED.some((q) => oriHit(o, rectOri(q), 0.5))) return 1;
        if (taken.some((q) => oriHit(o, rectOri(q), house ? 0 : 1)) || takenO.some((q) => oriHit(o, q, house ? 0 : 1))) return 2;
        const cs = oriCorners(o);
        for (let c = 0; c < 8; c += 2) {
          const mx = (cs[c] + cs[(c + 2) % 8]) / 2, mz = (cs[c + 1] + cs[(c + 3) % 8]) / 2;
          if (!landOk(cs[c], cs[c + 1])) return 4;
          if (!G.clearOfRoads(cs[c], cs[c + 1], roadM) || !G.clearOfRoads(mx, mz, roadM)) return 3;
        }
        return G.clearOfRoads(o.cx, o.cz, 3) ? 0 : 3;
      };
      // The game's streets are wider than the real ones, so a real frontage often lands on the sidewalk: slide the building straight back from the nearest street until it clears.
      for (const k of house ? [1] : [1, 0.85, 0.7]) {
        if (got) break;
        const kw = w * k, kd = d * k;
        for (const bk of [0, 1.5, 3, 4.5, 6, 8, 10]) {
          const sx = -dx * bk, sz = -dz * bk;
          const o: Ori = house
            ? { cx: cx + sx + Math.sin(h) * (kd / 2 + 4.2 - (kd + 6.5) / 2), cz: cz + sz + Math.cos(h) * (kd / 2 + 4.2 - (kd + 6.5) / 2), h, w: Math.max(kw + 1.8, 9.8), d: Math.max(kd + 6.5, 15) }
            : { cx: cx + sx, cz: cz + sz, h, w: kw, d: kd };
          const f = fits(o);
          if (f === 0) { got = o; break; }
          if (f === 1 || f === 2) break;
        }
      }
      if (!got) continue;
      const cs = oriCorners(got);
      const rect: Rect = { x0: Math.min(cs[0], cs[2], cs[4], cs[6]), z0: Math.min(cs[1], cs[3], cs[5], cs[7]), x1: Math.max(cs[0], cs[2], cs[4], cs[6]), z1: Math.max(cs[1], cs[3], cs[5], cs[7]) };
      const fx2 = Math.sin(got.h), fz2 = Math.cos(got.h), face = Math.abs(fz2) >= Math.abs(fx2) ? (fz2 < 0 ? 0 : 2) : (fx2 > 0 ? 1 : 3);
      out.push({ rect, block: 101000 + i, district: 'stacks', face, interior: false, ori: got, osm: { t, hm, i } });
      takenO.push(got);
    }
  }
  // Every other frontage lot of the graph, squared to the axes.
  for (const l of G.lots) {
    const fx = Math.sin(l.h), fz = Math.cos(l.h);
    if (OSM_ON && l.district === 'stacks' && !keepStack(l.cx, l.cz, l.block)) continue;
    // Houses (houseAssets.ts) stand on the oriented lot itself, at its own angle, not on a squared-off part of it.
    if (HOUSES_ON && l.district === 'stacks') {
      let got: Ori | null = null;
      for (const k of [1, 0.9, 0.8, 0.7]) {
        if (got) break;
        for (const back of [0, 1.5]) {
          const w = l.w * k, d = l.d * k;
          const o: Ori = { cx: l.cx - fx * back - fx * (l.d - d) / 2, cz: l.cz - fz * back - fz * (l.d - d) / 2, h: l.h, w, d: d - back };
          if (RESERVED.some((q) => oriHit(o, rectOri(q), 0)) || taken.some((q) => oriHit(o, rectOri(q), 0.6)) || takenO.some((t) => oriHit(o, t, 0.6))) continue;
          got = o; break;
        }
      }
      if (got) {
        const cs = oriCorners({ ...got, w: got.w * 0.8, d: got.d * 0.8 });
        const rect: Rect = { x0: Math.min(cs[0], cs[2], cs[4], cs[6]), z0: Math.min(cs[1], cs[3], cs[5], cs[7]), x1: Math.max(cs[0], cs[2], cs[4], cs[6]), z1: Math.max(cs[1], cs[3], cs[5], cs[7]) };
        const fc = Math.abs(fz) >= Math.abs(fx) ? (fz < 0 ? 0 : 2) : (fx > 0 ? 1 : 3);
        out.push({ rect, block: 100000 + l.block, district: l.district, face: fc, interior: false, ori: got });
        takenO.push(got);
        continue;
      }
    }
    const face = Math.abs(fz) >= Math.abs(fx) ? (fz < 0 ? 0 : 2) : (fx > 0 ? 1 : 3);
    const fnx = face === 1 ? 1 : face === 3 ? -1 : 0, fnz = face === 2 ? 1 : face === 0 ? -1 : 0;
    let done = false;
    for (const k of [1, 0.9, 0.8, 0.7, 0.6]) {
      for (const back of [0, 2, 4]) {
        const w = l.w * k, d = l.d * k;
        const hx = (face & 1 ? d : w) / 2, hz = (face & 1 ? w : d) / 2;
        // Keep the front where the lot's front was, pushed back when a diagonal street cuts the corner.
        const fcx = l.cx + fx * l.d / 2 - fnx * back, fcz = l.cz + fz * l.d / 2 - fnz * back;
        const cx = fcx - fnx * hx, cz = fcz - fnz * hz;
        const r: Rect = { x0: cx - hx, z0: cz - hz, x1: cx + hx, z1: cz + hz };
        if (!clear(r, 3.0)) continue;
        out.push({ rect: r, block: 100000 + l.block, district: l.district, face, interior: false });
        taken.push(r);
        done = true;
        break;
      }
      if (done) break;
    }
  }
  // Lesser Tepid's houses across the river and the blockhouse lot, where no new road crosses them.
  for (const x of EXTRA_LOTS) {
    if (x.district !== 'sister') continue;
    if (!clear(x.rect, 2.5)) continue;
    out.push({ rect: x.rect, block: -1, district: x.district, face: x.face, interior: false });
    taken.push(x.rect);
  }
  // Businesses OSM has no building for (the real shop is in an unmapped or merged footprint): a generic shop, hall or church on free ground
  // beside the nearest street at its spot, so the directory never points at bare ground (item 19b, business.ts SNAP).
  if (OSM_ON) {
    const dist = (x: number, z: number): number => {
      let best = 1e9;
      for (const l of out) {
        const o = l.ori;
        let d: number;
        if (o) { const fx = Math.sin(o.h), fz = Math.cos(o.h), ex = x - o.cx, ez = z - o.cz; d = Math.hypot(Math.max(Math.abs(ex * fz - ez * fx) - o.w / 2, 0), Math.max(Math.abs(ex * fx + ez * fz) - o.d / 2, 0)); }
        else d = Math.hypot(Math.max(l.rect.x0 - x, 0, x - l.rect.x1), Math.max(l.rect.z0 - z, 0, z - l.rect.z1));
        if (d < best) best = d;
      }
      for (const b of CAMPUS_BOXES) best = Math.min(best, Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3])));
      return best;
    };
    let n = 0;
    for (const [, ci, x, z, open] of DIRECTORY) {
      if (open || dist(x, z) <= 26) continue;
      const ne = G.nearestEdge(x, z, (e) => !e.deck);
      if (ne.d > 110) continue;
      const pp = G.pointAt(ne.edge, ne.s);
      let dx = pp.x - x, dz = pp.z - z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const h = Math.atan2(dx, dz), t = ci === 4 ? 7 : ci === 5 ? 8 : 2, w = ci === 4 ? 13 : 12, d = ci === 4 ? 16 : 9.5;
      for (const bk of [0, 3, 6, 9, 12, 15, 20, 26, 32, 40, 50]) {
        const o: Ori = { cx: x - dx * bk, cz: z - dz * bk, h, w, d };
        if (RESERVED.some((q) => oriHit(o, rectOri(q), 0.5)) || taken.some((q) => oriHit(o, rectOri(q), 1)) || takenO.some((q) => oriHit(o, q, 1))) continue;
        const cs = oriCorners(o);
        let ok = G.clearOfRoads(o.cx, o.cz, 3) && coastSD(o.cx, o.cz) < -6 && waterDist(o.cx, o.cz) > 9;
        for (let c = 0; ok && c < 8; c += 2) ok = G.clearOfRoads(cs[c], cs[c + 1], 3.2) && G.clearOfRoads((cs[c] + cs[(c + 2) % 8]) / 2, (cs[c + 1] + cs[(c + 3) % 8]) / 2, 3.2) && waterDist(cs[c], cs[c + 1]) > 9;
        if (!ok) continue;
        const rect: Rect = { x0: Math.min(cs[0], cs[2], cs[4], cs[6]), z0: Math.min(cs[1], cs[3], cs[5], cs[7]), x1: Math.max(cs[0], cs[2], cs[4], cs[6]), z1: Math.max(cs[1], cs[3], cs[5], cs[7]) };
        const fx2 = Math.sin(h), fz2 = Math.cos(h), face = Math.abs(fz2) >= Math.abs(fx2) ? (fz2 < 0 ? 0 : 2) : (fx2 > 0 ? 1 : 3);
        out.push({ rect, block: 102000 + n, district: 'stacks', face, interior: false, ori: o, osm: { t, hm: 0, i: 5000 + n } });
        takenO.push(o); n++;
        break;
      }
    }
  }
  LOTS = out;
  return out;
}

// ── Lower Main ───────────────────────────────────────────────────────────────

interface Seg { s0: number; s1: number; kind: 'shop' | 'gap' | 'bank' | 'movie'; floors: number; depth: number; top: number }

class Builder {
  private shopDeck: number[] = [];
  private deckAt = 0;
  private usedOnBlock = new Map<number, Set<number>>();
  private ghost = 0;
  /** Main St's Blender-modelled blocks (mainStreetAssets.ts); null builds every frontage here as before. */
  ms: MainStreet | null = null;
  /** The riverfront's Blender models (riverfrontAssets.ts): Lackwool Mill, the footbridge, The Holding Pattern's kit. null: as before. */
  rf: Riverfront | null = null;
  private hpDone = new Set<number>();
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

  /** New streets: lots main() leaves for the churches stacks() puts there. */
  private churchLots = new Set<number>();
  private churchA = -1;
  private churchB = -1;
  /** Under the new streets, pick the two churches' lots near the plan's candidates, of any district in town. */
  pickChurches(lots: Lot[]): void {
    if (!STREETS_NEW) return;
    const near = (tx: number, tz: number): number => {
      let best = -1, bd = 1e9;
      lots.forEach((l, i) => {
        if ((l.district !== 'main' && l.district !== 'stacks') || l.block < 100000 || l.block >= 100900 || this.churchLots.has(i)) return;
        const w = l.rect.x1 - l.rect.x0, d = l.rect.z1 - l.rect.z0, [a, b] = l.face & 1 ? [d, w] : [w, d];
        if (a < 15 || b < 22) return;
        const dd = Math.hypot((l.rect.x0 + l.rect.x1) / 2 - tx, (l.rect.z0 + l.rect.z1) / 2 - tz);
        if (dd < bd) { bd = dd; best = i; }
      });
      if (best >= 0) this.churchLots.add(best);
      return best;
    };
    this.churchA = near(-15, -1954); this.churchB = near(-34, -2042);
  }

  main(lots: Lot[], blocks: Block[], first: number): void {
    const k = this.k;
    // The two set pieces go on Main St itself: the bank just north of the square, the picture house just south of it.
    const pickNear = (x: number, z: number): number => {
      let best = -1, bd = 1e9;
      lots.forEach((l, i) => {
        if (l.district !== 'main' || l.interior || l.face !== 1 || Math.abs(l.rect.x1 - MS_XW) > 2) return;
        const d = Math.hypot((l.rect.x0 + l.rect.x1) / 2 - x, (l.rect.z0 + l.rect.z1) / 2 - z);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const bankLot = STREETS_NEW ? pickNear(50, -1905) : pickNear(50, -1592), movieLot = STREETS_NEW ? pickNear(50, -1700) : pickNear(50, -1350);
    lots.forEach((lot, i) => {
      if (lot.district !== 'main' && !onMain(lot)) return;
      if (this.churchLots.has(i)) return;
      if (lot.rect.x0 < OPERA.x1 && lot.rect.x1 > OPERA.x0 && lot.rect.z0 < OPERA.z1 && lot.rect.z1 > OPERA.z0) return;
      const cb = CIVIC.block;
      if (civic && lot.rect.x0 < cb.x1 && lot.rect.x1 > cb.x0 && lot.rect.z0 < cb.z1 && lot.rect.z1 > cb.z0) return;
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
    // The back wall stops short of any street (the Holding Pattern's lane runs close behind it).
    const SG = this.game.plan.streets;
    let dep = 15, br = cut(lot, face, g.s0, g.s1, back, back + dep);
    while (SG && dep > 9 && !rectClearOfRoads(SG, br, 1.2)) br = cut(lot, face, g.s0, g.s1, back, back + (dep -= 0.5));
    const f = frameOf(br, face), w = f.len;
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

  stacks(lots: OLot[], blocks: Block[], first: number): void {
    const k = this.k;
    const size = (l: Lot): [number, number] => { const w = l.rect.x1 - l.rect.x0, d = l.rect.z1 - l.rect.z0; return l.face & 1 ? [d, w] : [w, d]; };
    const taken = new Set<number>();
    const pick = (tx: number, tz: number, fr: number, dp: number): number => {
      let best = -1, bd = 1e9;
      lots.forEach((l, i) => {
        if (l.district !== 'stacks' || l.interior || taken.has(i) || l.osm) return;
        const [a, b] = size(l);
        if (a < fr || b < dp) return;
        const d = Math.hypot((l.rect.x0 + l.rect.x1) / 2 - tx, (l.rect.z0 + l.rect.z1) / 2 - tz);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) taken.add(best);
      return best;
    };
    // New streets: the two smaller churches go to the plan's candidates on Dutch Elm St (real First Baptist on Elm St) and
    // north of it (real Pleasant St Methodist); main() has left those lots alone (churchLots).
    const churchA = STREETS_NEW ? this.churchA : pick(-290, -1450, 15, 25), churchB = STREETS_NEW ? this.churchB : pick(-430, -1240, 15, 25), school = pick(-200, -1680, 24, 19);
    const storeOn = new Set<number>();
    let stores = 0;
    lots.forEach((lot, i) => {
      const sister = lot.district === 'sister';
      if (lot.district !== 'stacks' && !(sister && lot.rect.z0 > -1420) && i !== churchA && i !== churchB) return;
      if (lot.osm && lot.osm.t !== 0) return;
      const r = lot.rect, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, y = groundAt(cx, cz), rng = new RNG(91000 + first + i);
      k.at(cx, cz);
      if (lot.interior) { this.backLot(r, y, rng); return; }
      if (i === churchA || i === churchB) { this.church(r, lot.face, y, i === churchA); return; }
      if (i === school) { this.school(r, lot.face, y); return; }
      const block = blocks[lot.block], f = frameOf(r, lot.face);
      if (!storeOn.has(lot.block) && lot.block % 3 === 0 && (lot.ori ? !!houses && this.cornerO(lot.ori) : !!block && this.corner(lot, block))) {
        storeOn.add(lot.block);
        if (houses && lot.ori) this.hood(lot, rng, true);
        else this.store(r, lot.face, y, rng, STORES[stores++ % STORES.length], lot.block);
        return;
      }
      if (houses && lot.ori && lot.district === 'stacks') { this.hood(lot, rng, false); return; }
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

  /**
   * One lot's house (houseAssets.ts) at the lot's own angle, with its driveway, front walk, mailbox, a car in some drives, a garage
   * or a shed behind and chain-link fences. Setback by type (triple-deckers close to the walk, capes well back); the mix by
   * district: the South End by the mills and the North End are mostly triple-deckers, the leafy streets west of downtown capes,
   * gable-fronts and Victorians, and Victorians also gather near downtown. Frame: u along the frontage left to right as seen from
   * the street, q in from the lot's front edge (the walk's back edge is 0.6 m before q = 0).
   */
  private hood(lot: OLot, rng: RNG, store: boolean): void {
    const o = lot.ori, H = houses, k = this.k;
    if (!o || !H) return;
    const nx = Math.sin(o.h), nz = Math.cos(o.h), tx = nz, tz = -nx;
    const loc = (u: number, q: number): [number, number] => [o.cx + nx * (o.d / 2 - q) + tx * u, o.cz + nz * (o.d / 2 - q) + tz * u];
    const gy = (u: number, q: number): number => { const [x, z] = loc(u, q); return groundAt(x, z); };
    const west = o.cx < 20 && o.cz < -1640 && o.cz > -2060, south = o.cz > -1640, north = o.cz < -2060;
    const dm = Math.hypot(o.cx - 70, o.cz + 1850);
    const wt: Record<string, number> = south ? { td: 5.5, cape: 0.7, gf: 1.8, vic: 0.4 } : north ? { td: 4, cape: 1.2, gf: 2.4, vic: 0.8 }
      : west ? { td: 1, cape: 3.5, gf: 2, vic: 1.6 } : { td: 3, cape: 2, gf: 2, vic: 0.6 };
    if (dm < 330) wt.vic += 1.8;
    const kinds: Kind[] = [];
    if (store) kinds.push('store');
    const bag = ['td', 'cape', 'gf', 'vic'], tot = bag.reduce((a, b) => a + wt[b], 0);
    let r0 = rng.range(0, tot), first = 'td';
    for (const b of bag) { r0 -= wt[b]; if (r0 <= 0) { first = b; break; } }
    // A real footprint with a LiDAR height picks its storeys: tall is a triple-decker, middling a gable-front or Victorian, low a cape.
    if (lot.osm && lot.osm.hm > 0) first = lot.osm.hm > 8.2 ? 'td' : lot.osm.hm > 6.3 ? (rng.chance(0.7) ? 'gf' : 'vic') : 'cape';
    kinds.push(first as Kind, 'gf', 'cape', 'td');
    let name = '';
    for (const kd of kinds) {
      const n = rng.pick(BY_KIND[kd]), d = DESIGN[n];
      if (d.w + 1.2 <= o.w && d.minSet + d.D <= o.d - 0.4) { name = n; break; }
    }
    if (!name) return;
    const D = DESIGN[name], W = D.w, mir = rng.chance(0.5);
    const hasDrive = D.kind !== 'store' && o.w >= W + 4.6 && rng.chance(0.82);
    const ds = rng.chance(0.5) ? 1 : -1;
    const uc = hasDrive ? -ds * (o.w / 2 - W / 2 - 0.5) : rng.range(-0.4, 0.4) * Math.max(0, o.w - W - 1) / 2;
    const leafy = west && (D.kind === 'cape' || D.kind === 'gf' || D.kind === 'vic');
    const set = Math.min(Math.max(D.set + (leafy ? rng.range(-0.5, 1.8) : rng.range(-0.3, 0.4)), D.minSet), o.d - 0.4 - D.D);
    const u0 = uc - W / 2, [ox, oz] = loc(u0, set);
    const y = (Math.max(gy(u0, set), gy(u0 + W, set), gy(u0, set + D.D), gy(u0 + W, set + D.D)) + groundAt(ox, oz)) / 2;
    k.at(ox, oz);
    H.place(name, mir, ox, y, oz, tx, tz, nx, nz);
    const f0 = loc(-o.w / 2, 0);
    const F = { ox: f0[0], oz: f0[1], tx, tz, nx, nz, len: o.w, depth: o.d };
    const sy = gy(0, o.d / 2);
    // Front walk from the door to the street's sidewalk, and the drive (with its garage if there is one) out across the sidewalk to the kerb.
    const doorU = u0 + (mir ? W - D.door : D.door), lean = k.lean;
    lot.wall = { x: loc(doorU, set)[0], z: loc(doorU, set)[1], nx, nz };
    const S = streetSurface();
    /** Out from the lot's front edge at u: where the sidewalk begins, where the roadway does, and the sidewalk's height. Null when no street passes in front. */
    const reach = (u: number): [number, number, number] | null => {
      if (!S) return null;
      let a = -1, h = 0;
      for (let q = 0; q <= 24; q += 0.6) {
        const [x, z] = loc(u, -q), pr = S.probe(x, z);
        if (pr.kind === 'walk') { if (a < 0) { a = q; h = pr.h; } }
        else if (pr.kind === 'road') return [a < 0 ? q : a, q, a < 0 ? pr.h : h];
      }
      return null;
    };
    /** Paving on the ground between u = ua..ub from q = qa (nearer the street) in to qb, in 3 m steps that follow the slope. */
    const strip = (ua: number, ub: number, qa: number, qb: number, hex: number, hy?: (x: number, z: number) => number): void => {
      const n = Math.max(1, Math.ceil((qb - qa) / 3)), Y = hy ?? ((x: number, z: number): number => groundAt(x, z) + 0.04);
      for (let i = 0; i < n; i++) {
        const q0 = qa + ((qb - qa) * i) / n, q1 = qa + ((qb - qa) * (i + 1)) / n;
        const A = loc(ua, q0), B = loc(ub, q0), Cc = loc(ub, q1), Dd = loc(ua, q1);
        const ya = Math.max(Y(A[0], A[1]), Y(B[0], B[1])), yb = Math.max(Y(Cc[0], Cc[1]), Y(Dd[0], Dd[1]));
        k.F.quad(A[0], ya, A[1], B[0], ya, B[1], Cc[0], yb, Cc[1], Dd[0], yb, Dd[1], hex, 0, 0, 1, 1, 1);
      }
    };
    const qEnd = set - D.front - 1.0, rw = reach(doorU);
    if (qEnd > 0.5) strip(doorU - 0.6, doorU + 0.6, -(rw ? rw[0] + 0.15 : 0.6), qEnd, 0xb9b5ab);
    const ud = ds * (o.w / 2 - 1.9);
    let qGar = -1;
    if (hasDrive && rng.chance(0.34)) {
      const q = o.d - 0.4 - 6.2;
      if (q >= set + 2) {
        qGar = q;
        const gn = rng.pick(BY_KIND.garage), [gx, gz] = loc(ud - 1.9, q);
        H.place(gn, false, gx, gy(ud, q + 3), gz, tx, tz, nx, nz);
      }
    }
    if (hasDrive) {
      const qd = qGar > 0 ? qGar + 0.3 : set + D.D * rng.range(0.45, 0.8), tar = rng.chance(0.5), rd = reach(ud);
      strip(ud - 1.5, ud + 1.5, -(rd ? rd[0] + 0.1 : 0.6), qd, tar ? 0x4c4d50 : 0xa59f92);
      // The apron: across the sidewalk to the kerb, a little wider than the drive.
      if (rd && S && rd[1] > rd[0] + 0.5) strip(ud - 1.9, ud + 1.9, -rd[1] - 0.05, -rd[0] - 0.1, tar ? 0x595a5d : 0xb1ab9e, (x, z) => { const pr = S.probe(x, z); return (pr.kind === 'walk' ? pr.h : rd[2]) + 0.025; });
      // A car in the drive, nose to the street or away from it.
      if (rng.chance(0.42)) {
        const qc = rng.range(3.3, 5.0) + 2.35, lim = qGar > 0 ? qGar - 0.3 : o.d - 0.4;
        if (qc + 2.4 < lim) {
          const flip = rng.chance(0.5), cnx = flip ? -nx : nx, cnz = flip ? -nz : nz, [cx, cz] = loc(ud, qc);
          H.place(rng.pick(['car0', 'car1', 'car2']), false, cx, groundAt(cx, cz) + 0.02, cz, cnz, -cnx, cnx, cnz, false, rng.pick([0xf2f2f2, 0x3b3f44, 0x8a2a30, 0x2a4676, 0xa5acb1, 0x37543f, 0x1d1d1f, 0xb8a98a, 0xe8e8e8]));
        }
      }
    }
    // A shed in the back corner opposite the drive, and a mailbox on the curb side.
    if (rng.chance(0.42)) {
      const us = -(hasDrive ? ds : (rng.chance(0.5) ? 1 : -1)) * (o.w / 2 - 1.9), q = o.d - 0.4 - 2.3;
      if (q >= set + D.D + 0.3) { const [sx, sz] = loc(us - 1.35, q); H.place('shed_a', false, sx, groundAt(sx, sz), sz, tx, tz, nx, nz); }
    }
    if (rng.chance(0.6)) {
      const um = Math.max(-o.w / 2 + 0.4, Math.min(o.w / 2 - 0.4, hasDrive ? ud - ds * 2.0 : uc + (W / 2 + 1.0) * (rng.chance(0.5) ? 1 : -1))), [mx, mz] = loc(um, 0.5);
      H.place('mailbox', false, mx, groundAt(mx, mz), mz, tx, tz, nx, nz, false);
    }
    // Fences: chain-link down the sides and across the back, a low picket along the front in the leafy streets. Not solid (they may run at an angle).
    const run = (ua: number, qa: number, ub: number, qb: number, kind: 'picket' | 'chain'): void => {
      const [ax, az] = loc(ua, qa), [bx, bz] = loc(ub, qb);
      k.fenceRun({ x0: ax, z0: az, x1: bx, z1: bz }, sy, kind, false);
    };
    if (D.kind !== 'store' && rng.chance(west ? 0.35 : 0.55)) {
      const q0 = Math.max(set + 1.0, 2.5), hw = o.w / 2 - 0.2;
      for (const sd of [-1, 1]) if (!(hasDrive && sd === ds) || rng.chance(0.2)) run(sd * hw, q0, sd * hw, o.d - 0.2, 'chain');
      if (qGar < 0) run(-hw, o.d - 0.2, hw, o.d - 0.2, 'chain');
    }
    void F; void leafy;
    if (D.kind === 'store') return;
    // The front boundary, with gaps for the walk and the drive: a clipped hedge, a picket fence, a low stone wall or chain-link. The leafy
    // streets west of downtown are mostly hedges and pickets, the South End by the mills more often open or wired.
    const r1 = rng.next(), cuts = west ? [0.22, 0.44, 0.58, 0.6] : south ? [0.1, 0.22, 0.29, 0.41] : [0.14, 0.3, 0.41, 0.49];
    const kind = r1 < cuts[0] ? (lean ? 'picket' : 'hedge') : r1 < cuts[1] ? 'picket' : r1 < cuts[2] ? 'stone' : r1 < cuts[3] ? 'chain' : '';
    if (kind) {
      const hw = o.w / 2 - 0.2, gaps: [number, number][] = [[doorU - 0.9, doorU + 0.9]];
      if (hasDrive) gaps.push([ud - 1.9, ud + 1.9]);
      gaps.sort((a, b) => a[0] - b[0]);
      let at = -hw;
      const seg = (a: number, b: number): void => { if (b - a > 1.2) { const A = loc(a, 0.4), B = loc(b, 0.4); this.bound(kind, A[0], A[1], B[0], B[1]); } };
      for (const [a, b] of gaps) { seg(at, a); at = Math.max(at, b); }
      seg(at, hw);
      // A hedge often turns the corner and runs back to the house on the side away from the drive.
      if (kind === 'hedge' && rng.chance(0.5)) { const sd = hasDrive ? -ds : 1, A = loc(sd * hw, 1.4), B = loc(sd * hw, Math.max(2.5, set)); this.bound(kind, A[0], A[1], B[0], B[1]); }
    }
    // A small tree in the front yard, shrubs by the foundation (the town's one tree field draws them, ground.ts).
    const GREEN = [0x5e8b4b, 0x4f7d45, 0x6a9550];
    if (set > 4.6 && rng.chance(0.38)) {
      const ut = (hasDrive ? -ds : doorU > 0 ? -1 : 1) * rng.range(0.8, Math.max(0.9, o.w / 2 - 1.6)), [x, z] = loc(ut, set * rng.range(0.32, 0.5));
      if (Math.abs(ut - doorU) > 1.7) plantExtra(rng.pick(['cherry', 'birch', 'maple', 'cherry']), x, groundAt(x, z), z, rng.range(0, 6.28), rng.range(0.4, 0.56), rng.pick(GREEN));
    }
    if (!lean) for (const sd of [-1, 1]) {
      const us = uc + sd * (W / 2 - 0.9);
      if (!rng.chance(0.42) || Math.abs(us - doorU) < 1.6) continue;
      const [x, z] = loc(us, set - D.front - 0.7);
      plantExtra('shrub', x, groundAt(x, z) + 0.4, z, rng.range(0, 6.28), rng.range(0.75, 1.1), rng.pick(GREEN));
    }
  }

  /** A yard boundary from A to B (its outside is on the left hand going from A to B... the street side of a front run): hedge modules, a fence from the strip, or a low stone wall. None is solid. */
  private bound(kind: string, ax: number, az: number, bx: number, bz: number): void {
    const k = this.k, len = Math.hypot(bx - ax, bz - az);
    if (len < 1) return;
    const dx = (bx - ax) / len, dz = (bz - az) / len, ya = groundAt(ax, az), yb = groundAt(bx, bz);
    if (kind === 'picket' || kind === 'chain') { k.fenceRun({ x0: ax, z0: az, x1: bx, z1: bz }, (ya + yb) / 2 - 0.05, kind, false); return; }
    if (kind === 'hedge') {
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i < n; i++) { const x = ax + dx * len * (i + 0.5) / n, z = az + dz * len * (i + 0.5) / n; plantExtra('hedge', x, groundAt(x, z) + 0.3, z, Math.atan2(-dz, dx), 1, 0x56803f); }
      return;
    }
    // Stone: two faces from the sheet's granite, a flat cap, closed ends.
    const y0 = Math.min(ya, yb) - 0.3, y1 = Math.max(ya, yb) + 0.55, th = 0.4, onx = -dz, onz = dx;
    const f: Frame = { ox: ax, oz: az, tx: dx, tz: dz, nx: onx, nz: onz, len, depth: th };
    const g: Frame = { ox: bx - onx * th, oz: bz - onz * th, tx: -dx, tz: -dz, nx: -onx, nz: -onz, len, depth: th };
    k.band(f, 0, len, y0, y1, 0xb9b4a8, ROW.granite, y0, 1); k.band(g, 0, len, y0, y1, 0xb9b4a8, ROW.granite, y0, 0.9);
    k.hq(k.F, f, 0, len, -th, 0, y1, true, 0xa29e93);
    k.jq(k.F, f, 0, -th, 0, y0, y1, false, 0x9a968b); k.jq(k.F, f, len, -th, 0, y0, y1, true, 0x9a968b);
  }

  // ── Real footprints: the generic commercial, industrial and civic kits (OSM footprints, footprintData.ts) ──────────────────────
  //
  // Every kit here is quads on oriented Frames (no axis-aligned boxes), so a building stands at the real footprint's own angle. One
  // box per building, walls from the mainland's wall sheet, a flat roof, the street side dressed by kit: shopfronts (shops and strip
  // malls), a vestibule under a big sign (big-box stores, with their parking), loading doors (industrial), brick bays (mills,
  // apartments), plain windows (halls). The LiDAR height (hm, metres) picks the storeys; without one a kit has its own default.

  /** The four wall frames of an oriented rectangle, front (the side facing out along o.h) first, then clockwise seen from above. */
  private oframes(o: Ori): Frame[] {
    const nx = Math.sin(o.h), nz = Math.cos(o.h), tx = nz, tz = -nx, out: Frame[] = [];
    const nn: [number, number][] = [[nx, nz], [tx, tz], [-nx, -nz], [-tx, -tz]];
    for (let s = 0; s < 4; s++) {
      const [ax, az] = nn[s], bx = az, bz = -ax, len = s & 1 ? o.d : o.w, half = s & 1 ? o.w / 2 : o.d / 2;
      out.push({ ox: o.cx + ax * half - bx * len / 2, oz: o.cz + az * half - bz * len / 2, tx: bx, tz: bz, nx: ax, nz: az, len, depth: s & 1 ? o.w : o.d });
    }
    return out;
  }

  /** A closed box of walls on an oriented rect, top included, all in the flat colour batch (rooftop plant, tower shafts). */
  private obox(o: Ori, y0: number, y1: number, hex: number, shade = 1): void {
    const k = this.k, fr = this.oframes(o);
    for (let s = 0; s < 4; s++) k.vq(k.F, fr[s], 0, fr[s].len, y0, y1, 0, hex, 0, 0, 1, 1, shade * (s === 0 ? 1 : s === 2 ? 0.8 : 0.9));
    k.hq(k.F, fr[0], 0, fr[0].len, -o.d, 0, y1, true, dim(hex, 0.85), shade);
  }

  /**
   * A shopfront on an oriented frame: glass bays and a door from the sheet's shop row, a fascia in a colour, sometimes an awning. Returns
   * its door and where the sign goes on the fascia (shopSigns.ts letters it with the business that takes the door).
   */
  private oshop(f: Frame, s0: number, s1: number, y: number, HS: number, rng: RNG, awn = true): Door {
    const k = this.k, lean = !!this.game.quality.lean, col = rng.pick(SHOPCOL), tint = blend(col, 0xffffff, 0.5), gh = Math.min(3.0, HS - 0.9), [v0, v1] = mwallV(ROW.shop, 2);
    const pw = 0.4, a = s0 + pw, b = s1 - pw, dw = 1.9, n = Math.max(1, Math.round((b - a - dw) / 2.6)), bw = (b - a - dw) / n, doorAt = rng.int(0, n);
    const cell = (sa: number, sb: number, c: number): void => {
      k.vq(k.W, f, sa, sb, y + 0.02, y + gh, 0.02, tint, (c + 0.01) / 16, v0, (c + 0.99) / 16, v1);
      // Storefront glazing: dark aluminium mullions at each edge, a kick plate under the glass and a head rail over it.
      if (k.low || lean) return;
      const al = 0x2b2f33;
      k.vq(k.F, f, sa, sa + 0.07, y, y + gh + 0.04, 0.05, al); k.vq(k.F, f, sb - 0.07, sb, y, y + gh + 0.04, 0.05, al);
      k.vq(k.F, f, sa, sb, y, y + 0.34, 0.045, al, 0, 0, 1, 1, 0.9); k.vq(k.F, f, sa, sb, y + gh - 0.1, y + gh + 0.04, 0.045, al);
    };
    let s = a, doorS = (s0 + s1) / 2;
    const c0 = rng.int(0, 11);
    for (let i = 0; i <= n; i++) {
      if (i === doorAt) { cell(s, s + dw, 12 + rng.int(0, 3)); doorS = s + dw / 2; s += dw; }
      if (i < n) { cell(s, s + bw, (c0 + i * 5) % 12); s += bw; }
    }
    k.vq(k.F, f, s0, a, y, y + HS - 0.25, 0.06, col, 0, 0, 1, 1, 0.92); k.vq(k.F, f, b, s1, y, y + HS - 0.25, 0.06, col, 0, 0, 1, 1, 0.92);
    k.vq(k.F, f, s0, s1, y + gh, y + HS - 0.04, 0.1, dim(col, 1.1));
    const sw = Math.min(s1 - s0 - 1.2, 4.6), sh = Math.min(HS - gh - 0.3, sw / 4), ok = sw > 1.5 && sh > 0.3;
    if (awn && rng.chance(0.35) && s1 - s0 > 4) {
      const ac = rng.pick(AWNING), y1 = y + gh + 0.05, y0 = y + 2.5, out = 1.4;
      k.sq(k.F, f, s0 + 0.5, s1 - 0.5, 0.08, y1, out, y0, ac);
      k.sq(k.F, f, s0 + 0.5, s1 - 0.5, 0.08, y1 - 0.02, out, y0 - 0.02, ac, 0.6, 0, 0, 1, 1, true);
    }
    const sc = (s0 + s1) / 2;
    return { x: PX(f, doorS, 0), z: PZ(f, doorS, 0), nx: f.nx, nz: f.nz, sx: PX(f, sc, 0.14), sy: y + gh + (HS - gh - 0.04 - sh) / 2, sz: PZ(f, sc, 0.14), sw: ok ? sh * 4 : 0, sh: ok ? sh : 0 };
  }

  /** A door laid on a wall with a canopy over it and a slab step, for the kits without a shopfront. Returns it with the sign board's place above. */
  private entry(f: Frame, c: number, y: number, kind: number, hex: number, dw = 1.2, canopy = 0x3a3d40, signW = 2.4, signY = 3.05, o = 0): Door {
    const k = this.k;
    k.piece(f, c - dw / 2, dw, y, 2.3, o + 0.035, ROW.door, kind, hex, 1);
    if (!k.low) {
      k.ledge(f, c - dw / 2 - 0.5, c + dw / 2 + 0.5, y + 2.42, y + 2.56, o, o + 1.0, canopy);
      if (!k.lean) k.ledge(f, c - dw / 2 - 0.3, c + dw / 2 + 0.3, y - 0.3, y + 0.05, o, o + 0.9, 0xb9b6ac);
    }
    return { x: PX(f, c, o), z: PZ(f, c, o), nx: f.nx, nz: f.nz, sx: PX(f, c, o + 0.06), sy: y + signY, sz: PZ(f, c, o + 0.06), sw: signW, sh: signW / 4, opt: true, ly: y + 2.68 };
  }

  /** What a footprint building is walled in: brick, clapboard, vinyl siding, painted render (row -1: smooth) or concrete block. */
  private skin(rng: RNG, t: number): { kind: 'brick' | 'clap' | 'vinyl' | 'stucco' | 'block'; row: number; hex: number; trim: number } {
    const r = rng.next(), c = t === 3 ? [0.3, 0.3, 0.3, 0.68] : t === 1 ? [0.42, 0.68, 1, 1] : [0.38, 0.6, 0.72, 0.87];
    if (r < c[0]) return { kind: 'brick', row: ROW.brick, hex: rng.pick(BRICKS), trim: STONE };
    if (r < c[1]) return { kind: 'clap', row: ROW.clap, hex: rng.pick(PAINT), trim: WHITE };
    if (r < c[2]) return { kind: 'vinyl', row: ROW.clap, hex: rng.pick([0xe9e6dc, 0xd9d4c2, 0xcfd6d8, 0xc8cfc0, 0xe2d8c0, 0xb9c2c9, 0xd6c9b0]), trim: WHITE };
    if (r < c[3]) return { kind: 'stucco', row: -1, hex: rng.pick([0xe3d9c2, 0xd9c7a6, 0xcfc8ba, 0xe8e2d2, 0xc9b596, 0xbfc4bd, 0xd8b99a]), trim: 0xf1ede2 };
    // (Painted block: the brick row in a pale paint reads as small units; the granite row's courses are far too big for it.)
    return { kind: 'block', row: ROW.brick, hex: rng.pick([0xd9d5c8, 0xc9c6bb, 0xe2dccb, 0xbfc3c0, 0xd6cdb6]), trim: 0x8d8a82 };
  }

  /** A hipped roof on an oriented rectangle: four shingled slopes up to a ridge (a point on a square), eaves standing `over` out with a soffit. */
  private ohip(o: Ori, y: number, rise: number, over: number, hex: number): void {
    const k = this.k, [v0, v1] = mwallV(ROW.shingle), us = 1 / (CELL * 16), m = Math.min(o.w, o.d);
    const a = this.oframes({ ...o, w: o.w + 2 * over, d: o.d + 2 * over }), b = this.oframes({ ...o, w: o.w - m + 0.04, d: o.d - m + 0.04 }), fr = this.oframes(o);
    const ye = y - over * rise / (m / 2), slope = Math.hypot(rise + y - ye, m / 2 + over), rows = Math.max(1, Math.round(slope / CELL));
    for (let s = 0; s < 4; s++) {
      const A = a[s], B = b[s];
      k.W.quad(A.ox, ye, A.oz, PX(A, A.len, 0), ye, PZ(A, A.len, 0), PX(B, B.len, 0), y + rise, PZ(B, B.len, 0), B.ox, y + rise, B.oz, hex,
        0, v0, A.len * us, v0 + (v1 - v0) * Math.min(1, slope / (rows * CELL)), s === 0 ? 1 : s === 2 ? 0.86 : 0.93);
      if (!k.low) k.hq(k.F, fr[s], -over, fr[s].len + over, 0, over, ye, false, 0xd9d5c8, 0.8);
    }
  }

  /** Slices an oriented box into axis boxes that sit inside its true footprint (see obbSlices). */
  private osolid(o: Ori, top: number, base: number): void {
    const k = this.k;
    obbSlices(oriCorners(o), (x0, z0, x1, z1) => k.solid({ x0, z0, x1, z1 }, top, base));
  }

  /** An oriented box placed in a frame's own coordinates (s along the wall, o out from it), in flat colour. */
  private ofb(f: Frame, s0: number, s1: number, o0: number, o1: number, y0: number, y1: number, hex: number, shade = 1): void {
    this.obox({ cx: PX(f, (s0 + s1) / 2, (o0 + o1) / 2), cz: PZ(f, (s0 + s1) / 2, (o0 + o1) / 2), h: Math.atan2(f.nx, f.nz), w: s1 - s0, d: o1 - o0 }, y0, y1, hex, shade);
  }

  /** A four-sided pyramid on an oriented square. */
  private spire(o: Ori, y: number, h: number, hex: number, shade = 1): void {
    const fr = this.oframes(o);
    for (let s = 0; s < 4; s++) { const f = fr[s]; this.k.F.tri(PX(f, 0, 0), y, PZ(f, 0, 0), PX(f, f.len, 0), y, PZ(f, f.len, 0), o.cx, y + h, o.cz, hex, shade * (s === 0 ? 1 : s === 2 ? 0.8 : 0.9)); }
  }

  /** A parapet with a capped top round a flat roof, so the roof has an edge. */
  private coping(fr: Frame[], top: number, hex: number, h = 0.5): void {
    const k = this.k;
    for (let s = 0; s < 4; s++) {
      const f = fr[s];
      k.vq(k.F, f, -0.15, f.len + 0.15, top, top + h, 0.12, hex, 0, 0, 1, 1, s === 2 ? 0.86 : 0.97);
      k.hq(k.F, f, -0.15, f.len + 0.15, -0.2, 0.12, top + h, true, dim(hex, 1.08));
      if (!k.low) k.vq(k.F, f, f.len + 0.15, -0.15, top, top + h, -0.2, dim(hex, 0.8));
    }
  }

  /** Welded membrane seams across a flat roof, a line every `pitch` m, so a big roof is not one flat colour. */
  private seams(o: Ori, fr: Frame[], top: number, hex: number, pitch: number): void {
    const f = fr[0], n = Math.floor(o.w / pitch);
    for (let i = 1; i < n; i++) this.k.hq(this.k.F, f, i * pitch - 0.07, i * pitch + 0.07, -o.d + 0.3, -0.3, top + 0.02, true, hex);
  }

  /**
   * Big-box store, New England retail style: a split-face block base, EIFS above with a brand frieze, pilasters, a tower over the glazed
   * entrance with a canopy, corrugated metal sides, dock doors on the back, and a parapet.
   */
  private bigBox(o: Ori, fr: Frame[], y: number, top: number, rng: RNG, lean: boolean): Door {
    const k = this.k, f0 = fr[0], w = o.w, HS = top - y;
    const eifs = rng.pick([0xd8d0bc, 0xe2ded2, 0xcfc6b0, 0xc4c9c7, 0xd9cfae]), brand = rng.pick([0x1f3d6e, 0x7a1f1c, 0x1d5a3a, 0xc08a1a]);
    const block = 0xa9a396, metal = rng.pick([0xc9cdca, 0xbfc5c6, 0xd2d0c6]), ew = Math.min(14, w * 0.5), e0 = rng.chance(0.5) ? w * 0.18 : w - w * 0.18 - ew;
    k.band(f0, 0, w, y, y + 2.2, block, ROW.granite, y, 1);
    k.vq(k.F, f0, 0, w, y + 2.2, top, 0, eifs);
    k.ledge(f0, 0, w, y + 2.15, y + 2.32, 0, 0.1, dim(eifs, 0.82));
    k.vq(k.F, f0, 0, w, top - 1.45, top - 0.7, 0.04, brand);
    k.vq(k.F, f0, 0, w, top - 2.5, top - 2.42, 0.012, dim(eifs, 0.62));
    if (!lean) for (let x = 6; x < w - 3; x += 12) if (x < e0 - 3 || x > e0 + ew + 3) k.ledge(f0, x - 0.35, x + 0.35, y + 2.2, top, 0, 0.2, dim(eifs, 0.93));
    // The glazed entrance, a canopy over it, two flanking piers and the tower block above with the sign on its brand panel.
    const door = this.oshop(f0, e0, e0 + ew, y, 5.2, rng, false);
    k.ledge(f0, e0 - 1.5, e0 - 0.5, y, y + 5.3, 0, 0.9, dim(eifs, 1.05));
    k.ledge(f0, e0 + ew + 0.5, e0 + ew + 1.5, y, y + 5.3, 0, 0.9, dim(eifs, 1.05));
    k.ledge(f0, e0 - 1.5, e0 + ew + 1.5, y + 5.2, top + 2.4, 0, 0.9, dim(eifs, 1.05));
    k.ledge(f0, e0 - 1.65, e0 + ew + 1.65, top + 2.3, top + 2.6, 0, 1.0, dim(eifs, 0.84));
    k.vq(k.F, f0, e0 - 0.6, e0 + ew + 0.6, y + 5.45, top + 2.1, 0.93, brand);
    const sh = Math.min(2, HS - 4.0, (ew + 0.4) / 4);
    door.sx = PX(f0, e0 + ew / 2, 0.97); door.sz = PZ(f0, e0 + ew / 2, 0.97); door.sy = y + 5.45 + (HS - 3.35 - sh) / 2; door.sw = sh * 4; door.sh = sh;
    if (!lean) k.ledge(f0, e0 - 0.3, e0 + ew + 0.3, y + 4.5, y + 4.72, 0.9, 3.4, 0x3a3d40);
    // Corrugated metal on the sides and the back, dock doors along the back.
    for (let s = 1; s < 4; s++) {
      const f = fr[s], sh = s === 2 ? 0.86 : 0.97;
      k.band(f, 0, f.len, y, y + 1.2, block, ROW.granite, y, sh);
      k.band(f, 0, f.len, y + 1.2, top, metal, ROW.seam, y + 1.2, sh);
      if (s === 2 && !lean) { const n = Math.max(1, Math.floor(f.len / 18)); for (let i = 0; i < n; i++) { const c = (i + 0.5) * f.len / n; k.piece(f, c - 1.4, 2.8, y, 3.2, 0.03, ROW.door, 7, 0xffffff, 1); k.ledge(f, c - 1.7, c + 1.7, y + 3.3, y + 3.5, 0, 0.5, 0x4a4d50); } }
      if (s !== 2 && !lean) k.piece(f, f.len * 0.3, 1.1, y, 2.2, 0.03, ROW.door, 5, 0xffffff, 1);
      // Ribs down the metal and a band under the parapet, so a side that looks at a street is not one plain sheet.
      if (!lean) { const n = Math.max(2, Math.round(f.len / 10)); for (let i = 1; i < n; i++) k.vq(k.F, f, i * f.len / n - 0.09, i * f.len / n + 0.09, y + 1.2, top, 0.05, dim(metal, 0.78), 0, 0, 1, 1, sh); }
      k.vq(k.F, f, 0, f.len, top - 1.1, top - 0.6, 0.04, brand, 0, 0, 1, 1, sh);
    }
    this.coping(fr, top, dim(eifs, 0.9), 0.55);
    return door;
  }

  /** A church on a footprint: brick or white clapboard, tall windows, a gabled roof and a steeple (a square tower, a louvred belfry and a spire) on the front. */
  private oChurch(o: Ori, fr: Frame[], y: number, hm: number, rng: RNG, roofHex: number, lean: boolean): number {
    const k = this.k, brick = rng.chance(0.4), hex = brick ? MWALL.redBrick : WHITE, wr = brick ? ROW.brick : ROW.clap, trim = brick ? 0xe6e0d2 : WHITE;
    const w = o.w, d = o.d, eave = Math.min(8.6, Math.max(5.8, hm > 0 ? hm * 0.45 : 6.6)), top = y + eave, f0 = fr[0];
    const dw = 0.95, door = w / 2;
    for (let s = 0; s < 4; s++) {
      const f = fr[s], sh = s === 0 ? 1 : s === 2 ? 0.9 : 0.95;
      k.band(f, 0, f.len, y, y + 1.0, 0xb4b1a6, ROW.granite, y, sh);
      k.band(f, 0, f.len, y + 1.0, top, hex, wr, y + 1.0, sh);
      if (!k.low) { k.ledge(f, 0, f.len, y + 0.95, y + 1.08, 0, 0.1, trim); k.ledge(f, -0.1, 0.2, y + 1.0, top, 0, 0.08, trim); k.ledge(f, f.len - 0.2, f.len + 0.1, y + 1.0, top, 0, 0.08, trim); }
      const n = Math.max(1, Math.floor((f.len - 3) / 4.2)), pitch = f.len / n;
      for (let i = 0; i < n; i++) {
        const c = (i + 0.5) * pitch;
        if (s === 0 && Math.abs(c - door) < 3.4) continue;
        const cell = (i * 5 + s * 3 + (hm | 0)) % 32;
        if (brick) k.piece(f, c - 0.75, 1.5, y + 1.8, 3.2, 0.02, ROW.round, cell, 0xffffff, sh);
        else k.piece(f, c - 0.7, 1.4, y + 1.8, 3.2, 0.03, ROW.sash, cell, 0xffffff, 1);
      }
    }
    // The front door under the tower, with a stone step.
    k.piece(f0, door - dw, dw * 2, y + 0.3, 2.6, 0.04, ROW.door, MWALL.doors.hall, 0x7a2a22);
    this.ofb(f0, door - 1.6, door + 1.6, 0, 1.0, y, y + 0.3, 0xb9b6ac);
    const alongFront = w >= d, rise = Math.max(2.8, Math.min(6.5, (alongFront ? d : w) * 0.32));
    k.ogable(fr, top, rise, alongFront, 0.45, roofHex, hex, wr);
    if (lean) return top;
    const tw = w * d > 1200 ? 5.4 : 4.4, ty = top + rise * 0.7 + 3.4, bw = tw - 1.0, by = ty + 3.0, sp = 9 + (tw > 5 ? 3 : 0);
    const tower: Ori = { cx: PX(f0, door, 0.9 - tw / 2), cz: PZ(f0, door, 0.9 - tw / 2), h: o.h, w: tw, d: tw }, tf = this.oframes(tower);
    const belfry: Ori = { cx: tower.cx, cz: tower.cz, h: o.h, w: bw, d: bw }, bf = this.oframes(belfry);
    for (let s = 0; s < 4; s++) {
      const f = tf[s], b = bf[s], sh = s === 0 ? 1 : s === 2 ? 0.9 : 0.95;
      k.band(f, 0, f.len, y, ty, hex, wr, y, sh);
      k.ledge(f, -0.12, f.len + 0.12, ty - 0.12, ty + 0.16, 0, 0.14, trim);
      k.band(b, 0, b.len, ty, by, hex, wr, ty, sh);
      k.vq(k.F, b, b.len / 2 - 0.65, b.len / 2 + 0.65, ty + 0.55, ty + 2.5, 0.03, 0x24272a);
      k.ledge(b, b.len / 2 - 0.8, b.len / 2 + 0.8, ty + 2.5, ty + 2.62, 0, 0.1, trim);
      k.ledge(b, -0.15, b.len + 0.15, by - 0.1, by + 0.14, 0, 0.18, trim);
      if (s === 0) { k.piece(f, tw / 2 - 0.55, 1.1, y + 7.4, 2.6, 0.03, ROW.sash, 7, 0xffffff, 1); k.piece(f, tw / 2 - 0.5, 1.0, ty - 3.2, 2.0, 0.03, ROW.sash, 11, 0xffffff, 1); }
    }
    this.spire(belfry, by + 0.14, sp, brick ? 0x4a4d52 : 0xf1eee6, 1);
    k.F.cyl(belfry.cx, by + 0.14 + sp, belfry.cz, 0.05, 0.03, 1.5, 0xd8c070, 5, true);
    return top;
  }

  /** A brick school or hall: stone base and belt courses, tall sash windows, a columned portico with a pediment, a cupola, a flagpole. */
  private oSchool(o: Ori, fr: Frame[], y: number, hm: number, rng: RNG, lean: boolean): number {
    const k = this.k, w = o.w, d = o.d, f0 = fr[0], FH = 4.0, fl = Math.max(2, Math.min(3, hm > 0 ? Math.round(hm / FH) : 2));
    const hex = rng.pick([0xa5573f, 0xb0654a, 0x9c4a3a, 0xa5573f]), b0 = y + 0.9, top = b0 + fl * FH + 0.8, seed = rng.int(0, 31);
    const st: WinStyle = { row: ROW.sash, w: 1.5, h: 2.7, sill: 0.8, own: false };
    const pw = Math.min(10, w * 0.3), c0 = (w - pw) / 2, c1 = c0 + pw;
    for (let s = 0; s < 4; s++) {
      const f = fr[s], sh = s === 0 ? 1 : s === 2 ? 0.92 : 0.96;
      k.band(f, 0, f.len, y, b0, 0xb9b6ac, ROW.granite, y, sh);
      if (s === 0) {
        k.facade(f, 0, c0, b0, FH, fl, hex, 1, st, 3.2, seed, 0xffffff, ROW.brick); k.facade(f, c1, w, b0, FH, fl, hex, 1, st, 3.2, seed + 3, 0xffffff, ROW.brick);
        k.band(f, c0, c1, b0, b0 + fl * FH, hex, ROW.brick, b0, 1);
        k.band(f, 0, w, b0 + fl * FH, top, hex, ROW.brick, b0 + fl * FH, 1);
        k.cornice(f, 0, w, top, hex, 1);
      } else k.plainWall(f, 0, f.len, y, top, hex, sh, ROW.brick, { st, yb: b0, fh: FH, floors: fl, pitch: 3.6, seed: seed + s, trim: 0xffffff });
      if (!lean) for (let i = 1; i < fl; i++) k.ledge(f, -0.08, f.len + 0.08, b0 + i * FH - 0.1, b0 + i * FH + 0.1, 0, 0.1, STONE);
      if (!lean) { k.ledge(f, -0.15, 0.4, y, top, 0, 0.12, STONE); k.ledge(f, f.len - 0.4, f.len + 0.15, y, top, 0, 0.12, STONE); }
    }
    // Portico: four white columns, a slab and a pediment, the double door behind, steps in front.
    k.piece(f0, w / 2 - 1.1, 2.2, y + 0.9, 2.7, 0.04, ROW.door, MWALL.doors.hall, 0x2c4a3a);
    k.piece(f0, w / 2 - 0.7, 1.4, b0 + FH + 0.5, 2.5, 0.04, ROW.sash, 9, 0xffffff, 1);
    if (!lean) {
      const pd = 3.0;
      this.ofb(f0, c0 - 0.4, c1 + 0.4, 0, pd, y + 4.5, y + 4.85, WHITE);
      for (let i = 0; i < 4; i++) { const s = c0 + 0.5 + i * (pw - 1) / 3, cx = PX(f0, s, pd - 0.45), cz = PZ(f0, s, pd - 0.45); k.F.cyl(cx, y + 0.3, cz, 0.26, 0.23, 4.2, 0xf1ede2, 10, true); k.game.col.addProp(cx, cz, 0.26, 4.5, 'post', false); }
      this.ofb(f0, c0 - 0.2, c1 + 0.2, 0, pd + 0.5, y, y + 0.3, 0xb9b6ac); this.ofb(f0, c0 + 1, c1 - 1, pd + 0.5, pd + 1.2, y, y + 0.15, 0xb9b6ac);
      k.F.tri(PX(f0, c0 - 0.4, pd), y + 4.85, PZ(f0, c0 - 0.4, pd), PX(f0, c1 + 0.4, pd), y + 4.85, PZ(f0, c1 + 0.4, pd), PX(f0, w / 2, pd), y + 6.5, PZ(f0, w / 2, pd), WHITE);
      // The cupola on the roof, a flagpole on the lawn.
      const cup: Ori = { cx: o.cx, cz: o.cz, h: o.h, w: 2.8, d: 2.8 };
      this.obox(cup, top + 0.4, top + 2.6, WHITE, 1);
      this.spire({ ...cup, w: 3.1, d: 3.1 }, top + 2.6, 3.4, 0x4a4d52);
      const px = PX(f0, 3, pd + 3), pz = PZ(f0, 3, pd + 3);
      k.F.cyl(px, y, pz, 0.06, 0.05, 9, 0xd8d8d4, 6, true); k.game.col.addProp(px, pz, 0.15, 8, 'post', false);
    }
    this.coping(fr, top, dim(hex, 0.9), 0.6);
    return top;
  }

  osm(lots: OLot[], first: number): void {
    const k = this.k, G = this.game.plan.streets, lean = !!this.game.quality.lean;
    for (const lot of lots) {
      const q = lot.osm, o = lot.ori;
      if (!q || !o || q.t === 0) continue;
      const rng = new RNG(88000 + first + q.i), fr = this.oframes(o), cs = oriCorners(o);
      let gmin = 1e9, gmax = -1e9, gsum = 0;
      for (const [px, pz] of [[cs[0], cs[1]], [cs[2], cs[3]], [cs[4], cs[5]], [cs[6], cs[7]], [o.cx, o.cz]]) { const g = groundAt(px, pz); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); gsum += g; }
      if (gmax - gmin > 3.6) continue;
      const y = gsum / 5, base = gmin - 0.4, w = o.w, d = o.d, t = q.t, hm = q.hm;
      k.at(o.cx, o.cz);
      const FH = t === 6 ? 3.6 : t === 4 || t === 5 ? 4.2 : 3.1;
      const floorsOf = (def: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, hm > 0 ? Math.round(hm / FH) : def));
      const hex = t === 6 ? MWALL.redBrick : rng.pick(BRICKS), seed = rng.int(0, 31);
      let top = y + 4.8, HS = 4.35, fl = 1;
      let roofHex = rng.pick(ROOF), gabled = false;
      // The walls below the floor line hide the slope.
      const under = (): void => { for (const f of fr) k.band(f, 0, f.len, base, y, 0x9c978c, ROW.granite, base, 0.9); };
      if (t === 2 || t === 3 || t === 1) {
        // Shops, strip malls and blocks of flats. Each has its own walling (brick, clapboard, vinyl, render, block) and window size; a long
        // one is a row of bays with their own shade and parapet; small ones take a gable or a hipped roof, the rest a flat roof behind a
        // parapet. Every side has windows on every floor, the back its service doors: no wall of it is blank.
        const shop = t !== 1, f0 = fr[0], sk = this.skin(rng, t), soft = sk.kind === 'clap' || sk.kind === 'vinyl';
        fl = t === 1 ? floorsOf(3, 2, 4) : t === 2 ? floorsOf(w * d > 280 ? 2 : 1, 1, 3) : 1;
        HS = shop ? (t === 3 ? 4.2 : 4.35) : FH;
        const body = y + HS + (fl - 1) * FH, area = w * d;
        const form = t === 3 || lean ? 'flat' : area < 240 && (soft || rng.chance(0.4)) ? 'gable' : area < 560 && rng.chance(soft ? 0.8 : 0.3) ? 'hip' : 'flat';
        top = body + (form === 'flat' ? 0.55 : 0.3);
        under();
        const st: WinStyle = { ...WIN.sash, w: rng.pick([1.0, 1.1, 1.3]), h: rng.pick([1.75, 2.05]) }, pitch = st.w + rng.range(1.5, 2.3);
        const nb = w > 26 ? Math.max(2, Math.round(w / rng.range(9, 13))) : 1, bw = w / nb, mid = nb >> 1;
        const doors: Door[] = lot.doors = [], capHex = sk.kind === 'brick' ? dim(sk.hex, 0.9) : sk.trim;
        for (let b = 0; b < nb; b++) {
          const s0 = b * bw, s1 = s0 + bw, hx = nb > 1 ? dim(sk.hex, 0.9 + 0.16 * rng.next()) : sk.hex;
          const up = form === 'flat' && nb > 1 && !lean ? rng.pick([0, 0.6, 1.1]) : 0, ptop = top + up;
          if (shop) {
            const units = Math.max(1, Math.round(bw / (t === 3 ? 7.5 : 10))), uw = bw / units;
            for (let u = 0; u < units; u++) doors.push(this.oshop(f0, s0 + u * uw, s0 + (u + 1) * uw, y, HS, rng, t !== 3));
          } else if (b === mid) {
            // The street door in the middle bay under a canopy, ground-floor windows either side of it.
            const c = (s0 + s1) / 2;
            k.band(f0, c - 1.5, c + 1.5, y, y + FH, hx, sk.row, y, 1, 0, FH + 0.001);
            for (const [a0, a1] of [[s0, c - 1.5], [c + 1.5, s1]]) {
              if (a1 - a0 > st.w + 1.2) k.facade(f0, a0, a1, y, FH, 1, hx, 1, st, pitch, seed + b, 0xffffff, sk.row);
              else k.band(f0, a0, a1, y, y + FH, hx, sk.row, y, 1, 0, FH + 0.001);
            }
            doors.push(this.entry(f0, c, y, rng.pick([MWALL.doors.panel, MWALL.doors.oval, MWALL.doors.lights]), rng.pick(DOORC), 1.2, dim(sk.trim, 0.85)));
          } else k.facade(f0, s0, s1, y, FH, 1, hx, 1, st, pitch, seed + b, 0xffffff, sk.row);
          if (fl > 1) k.facade(f0, s0, s1, y + HS, FH, fl - 1, hx, 1, st, pitch, seed + b * 3 + 1, 0xffffff, sk.row);
          k.band(f0, s0, s1, body, ptop, hx, sk.row, body, 1);
          if (sk.kind === 'brick') k.cornice(f0, s0, s1, ptop, hx, 1);
          else k.ledge(f0, s0, s1, ptop - 0.3, ptop, 0, 0.1, sk.trim);
          if (up > 0) {
            // A bay's parapet standing above its neighbours: its back, its ends and a cap.
            k.vq(k.F, f0, s1, s0, top, ptop, -0.3, dim(hx, 0.8));
            k.jq(k.F, f0, s0, -0.3, 0, top, ptop, false, dim(hx, 0.85)); k.jq(k.F, f0, s1, -0.3, 0, top, ptop, true, dim(hx, 0.85));
            if (sk.kind !== 'brick') k.hq(k.F, f0, s0, s1, -0.3, 0.12, ptop, true, capHex);
          }
          if (b > 0 && !k.low) k.ledge(f0, s0 - 0.2, s0 + 0.2, y + (shop ? HS : 0), top, 0, 0.12, sk.kind === 'brick' ? dim(sk.hex, 0.82) : sk.trim);
        }
        if (t === 3 && !lean) {
          // A strip mall: one canopy the length of the frontage on posts.
          const cc = rng.pick([0x2c4a3a, 0x25395c, 0x6a2620, 0x3c3c3c]), n = Math.max(2, Math.round(w / 7.5));
          k.ledge(f0, 0, w, y + 2.7, y + 3.0, 0, 2.1, cc);
          for (let u = 0; u <= n; u += 2) { const su = Math.min(w - 0.1, Math.max(0.1, u * w / n)); k.F.cyl(PX(f0, su, 2.0), y, PZ(f0, su, 2.0), 0.07, 0.07, 2.72, 0x2b2f33, 6, false); }
        }
        const dress = !lean, sp = pitch + 0.4;
        for (let s = 1; s < 4; s++) {
          const f = fr[s], sh = s === 2 ? 0.92 : 0.96;
          k.plainWall(f, 0, f.len, y, top, sk.hex, sh, sk.row, { st, yb: y + HS, fh: FH, floors: fl - 1, pitch: sp, seed: seed + s, trim: 0xffffff, dress });
          // The ground floor: windows down the sides (fewer on a shop), service doors and downspouts on the back.
          if (s !== 2) k.winRow(f, shop ? 2.5 : 0, f.len, y + st.sill + (shop ? 0.3 : 0), st, shop ? sp * 1.6 : sp, seed + s * 5, 0xffffff, sh, dress);
          else {
            const nd = Math.max(1, Math.round(f.len / 12)), dl = f.len / nd;
            for (let i = 0; i < nd; i++) {
              const c = (i + 0.5) * dl;
              k.piece(f, c - 0.5, 1.0, y, 2.15, 0.03, ROW.door, MWALL.doors.steel, 0xffffff, sh);
              if (!shop) { k.winRow(f, i * dl, c - 0.7, y + st.sill, st, sp, seed + i, 0xffffff, sh, dress); k.winRow(f, c + 0.7, (i + 1) * dl, y + st.sill, st, sp, seed + i + 9, 0xffffff, sh, dress); }
            }
            if (dress) for (const x of [0.35, f.len - 0.35]) k.vq(k.F, f, x - 0.06, x + 0.06, y, top, 0.05, 0x4a4d50, 0, 0, 1, 1, sh);
          }
        }
        // Corner boards on boarded walls.
        if (soft && !k.low) for (const f of fr) { k.vq(k.F, f, 0, 0.16, y, top, 0.035, WHITE); k.vq(k.F, f, f.len - 0.16, f.len, y, top, 0.035, WHITE); }
        if (form === 'gable') {
          const along = w >= d, rise = Math.max(1.8, Math.min(4.2, (along ? d : w) * 0.3));
          k.ogable(fr, top, rise, along, 0.45, roofHex, sk.hex, sk.row < 0 ? ROW.clap : sk.row);
          gabled = true;
        } else if (form === 'hip') {
          this.ohip(o, top, Math.max(1.6, Math.min(3.6, Math.min(w, d) * 0.26)), 0.45, roofHex);
          gabled = true;
        } else if (!lean) {
          this.coping(fr, top, capHex, 0.4);
          if (area > 300) this.roofPlant(o, top + 0.02, rng, Math.min(3, Math.floor(area / 300)));
        }
      } else if (t === 7) {
        if (civicHero) {
          // A Blender hero church (civicHero.ts) stands here; the collision box below is the footprint's, as before.
          civicHero.add(heroFit(7, o.cx, o.cz, o.h, w, d, y));
          top = y + Math.min(8.6, Math.max(5.8, hm > 0 ? hm * 0.45 : 6.6)); HS = top - y; gabled = true;
        } else { top = this.oChurch(o, fr, y, hm, rng, roofHex, lean); HS = top - y; gabled = true; }
      } else if (t >= 8) {
        if (civicHero) {
          civicHero.add(heroFit(8, o.cx, o.cz, o.h, w, d, y));
          top = y + 0.9 + Math.max(2, Math.min(3, hm > 0 ? Math.round(hm / 4) : 2)) * 4 + 0.8; HS = top - y; gabled = true;
        } else { top = this.oSchool(o, fr, y, hm, rng, lean); HS = top - y; }
      } else if (t === 4) {
        // Big-box store: a tall plain box, a glazed entrance under a big sign, and the car park in front.
        HS = Math.max(6.2, hm > 0 ? Math.min(hm, 11) : 8); top = y + HS; under();
        lot.doors = [this.bigBox(o, fr, y, top, rng, lean)];
        roofHex = 0xb9bbb7;
        if (!lean) this.seams(o, fr, top, 0xa3a5a2, 9);
        this.parkingLot(o, fr[0], lean, G);
        if (!lean) this.roofPlant(o, top, rng, Math.floor(w * d / 700));
      } else if (t === 5) {
        // Industrial shed: ribbed metal on a block base, a brick office at one end of the front with the door and the firm's sign, roller
        // doors under canopies on the front and one side, high windows and ribs round every side, and a low gable (a flat roof on the widest).
        HS = Math.max(5.5, hm > 0 ? Math.min(hm, 10) : 6.5); top = y + HS; under();
        const mh = rng.pick([0x8d9aa3, 0xb5a98a, 0x9aa59a, 0xa4a8a5, 0x7f8f7a, 0x6f8296, 0xb9b3a2, 0x8a5a4a]), tc = dim(mh, 0.62), f0 = fr[0];
        const ow = Math.min(11, Math.max(6, w * 0.3)), oh = 3.5, a0 = rng.chance(0.5) ? 0 : w - ow, obr = rng.pick(BRICKS);
        for (let s = 0; s < 4; s++) {
          const f = fr[s], sh = s === 0 ? 1 : s === 2 ? 0.86 : 0.97, docks = s === 0 || s === 1, n = Math.max(1, Math.round(f.len / (docks ? 13 : 9)));
          k.band(f, 0, f.len, y, y + 0.9, 0xa9a396, ROW.granite, y, sh); k.band(f, 0, f.len, y + 0.9, top, mh, ROW.seam, y + 0.9, sh);
          k.vq(k.F, f, 0, f.len, top - 0.4, top, 0.04, tc, 0, 0, 1, 1, sh);
          for (let i = 0; i < n; i++) {
            const c = (i + 0.5) * f.len / n, office = s === 0 && c > a0 - 2 && c < a0 + ow + 2;
            if (i && !lean) k.vq(k.F, f, i * f.len / n - 0.07, i * f.len / n + 0.07, y + 0.9, top - 0.4, 0.05, tc, 0, 0, 1, 1, sh);
            if (!office && HS > 5.9) for (const dx of [-1.02, 0.02]) k.piece(f, c + dx, 1.0, top - 2.05, 1.2, 0.03, ROW.sash, (seed + i * 5 + s * 3 + (dx > 0 ? 1 : 0)) % 32, 0xffffff, 1);
            if (!docks || office) continue;
            k.piece(f, c - 1.6, 3.2, y, 3.4, 0.03, ROW.door, MWALL.doors.garage, 0xffffff, 1);
            if (!lean) { k.ledge(f, c - 2.0, c + 2.0, y + 3.5, y + 3.66, 0, 0.9, tc); if (i % 2 === 0 && f.len / n > 8.5) k.piece(f, c + 2.4, 1.0, y, 2.15, 0.03, ROW.door, MWALL.doors.steel, 0xffffff, 1); }
          }
        }
        // The office end: brick to 3.5 m with windows, the door under a canopy, a stone coping, the sign on the metal above.
        k.band(f0, a0, a0 + ow, y, y + oh, obr, ROW.brick, y, 1, 0.12);
        k.ledge(f0, a0 - 0.05, a0 + ow + 0.05, y + oh, y + oh + 0.14, 0, 0.2, STONE);
        k.jq(k.F, f0, a0, 0, 0.12, y, y + oh, false, dim(obr, 0.8)); k.jq(k.F, f0, a0 + ow, 0, 0.12, y, y + oh, true, dim(obr, 0.8));
        k.winRow(f0, a0 ? a0 + 2.4 : a0, a0 ? a0 + ow : a0 + ow - 2.4, y + 0.9, WIN.sash, 2.5, seed, 0xffffff, 1, !lean, 0.14);
        const door = this.entry(f0, a0 ? a0 + 1.4 : a0 + ow - 1.4, y, MWALL.doors.lights, 0xffffff, 1.1, tc, Math.min(ow - 1, 5.2, (HS - oh - 1.1) * 4), oh + 0.45, 0.12);
        door.opt = false; lot.doors = [door];
        const across = Math.min(w, d);
        if (across <= 36 && !lean) {
          k.ogable(fr, top, Math.max(1.1, Math.min(2.8, across * 0.1)), w >= d, 0.3, 0x8f9496, mh, ROW.seam, 1, ROW.seam);
          gabled = true;
        } else if (!lean) { this.coping(fr, top, dim(mh, 0.85), 0.4); this.seams(o, fr, top, 0x55575a, 7); this.roofPlant(o, top, rng, Math.floor(w * d / 500)); }
        // A lean-to on posts along one side, where it keeps off the roads.
        const f3 = fr[3], l0 = f3.len * 0.25, l1 = Math.min(f3.len - 2, l0 + 12), yh = y + 3.7;
        if (!lean && w * d > 500 && l1 - l0 > 6 && (!G || (G.clearOfRoads(PX(f3, l0, 4.6), PZ(f3, l0, 4.6), 2.5) && G.clearOfRoads(PX(f3, l1, 4.6), PZ(f3, l1, 4.6), 2.5))) && !RESERVED.some((r) => { const x = PX(f3, (l0 + l1) / 2, 4), z = PZ(f3, (l0 + l1) / 2, 4); return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1; })) {
          k.sq(k.F, f3, l0, l1, 0, yh, 3.8, yh - 0.8, 0x8f9496); k.sq(k.F, f3, l0, l1, 0, yh - 0.03, 3.8, yh - 0.83, 0x6c7072, 0.7, 0, 0, 1, 1, true);
          for (const sp of [l0 + 0.2, (l0 + l1) / 2, l1 - 0.2]) { const px = PX(f3, sp, 3.6), pz = PZ(f3, sp, 3.6), g = groundAt(px, pz) - 0.2; k.F.cyl(px, g, pz, 0.07, 0.07, yh - 0.76 - g, 0x3a3d40, 6, false); this.game.col.addProp(px, pz, 0.12, 3, 'post', false); }
        }
      } else if (t === 6) {
        // Mill: red brick bays on every wall, five floors at most, a stair tower and a chimney on the big ones.
        fl = floorsOf(3, 2, 5); top = y + fl * FH + 0.6; under();
        for (let s = 0; s < 4; s++) { const f = fr[s]; k.facade(f, 0, f.len, y, FH, fl, hex, 1, WIN.mill, 3.4, seed + s * 3, 0xffffff, ROW.brick); }
        k.cornice(fr[0], 0, w, top, hex, 1);
        // The mill door: a granite portal on the front with the double door in it.
        k.ledge(fr[0], w / 2 - 1.5, w / 2 + 1.5, y, y + 3.8, 0, 0.3, STONE);
        lot.doors = [this.entry(fr[0], w / 2, y, MWALL.doors.hall, 0x2c4a3a, 1.9, 0x3a3d40, 2.4, 4.0, 0.3)];
        const nx = Math.sin(o.h), nz = Math.cos(o.h), tx = nz, tz = -nx;
        // Granite string course under the first floor, a coped roof with a monitor of clerestory windows along it.
        if (!lean) {
          for (const f of fr) k.ledge(f, -0.05, f.len + 0.05, y + FH + 0.02, y + FH + 0.2, 0, 0.1, STONE);
          this.coping(fr, top, dim(hex, 0.9), 0.35);
          if (w > 24) {
            const mon: Ori = { cx: o.cx, cz: o.cz, h: o.h, w: w * 0.6, d: Math.min(6, d * 0.3) }, mf = this.oframes(mon), my = top + 1.9;
            this.obox(mon, top, my, dim(hex, 0.95), 0.95);
            for (const s of [0, 2]) { const f = mf[s], n = Math.floor(f.len / 2.4); for (let i = 0; i < n; i++) k.piece(f, (i + 0.5) * f.len / n - 0.55, 1.1, top + 0.3, 1.3, 0.02, ROW.sash, (seed + i * 5 + s) % 32, 0xffffff, 1); }
          }
        }
        // The stair tower: brick to above the roof, arched louvres, a slate cap.
        if (w * d > 800 && !lean) {
          const st: Ori = { cx: o.cx + nx * (d / 2 + 0.2) - tx * (w / 2 - 4), cz: o.cz + nz * (d / 2 + 0.2) - tz * (w / 2 - 4), h: o.h, w: 5, d: 5 }, sf = this.oframes(st);
          this.obox(st, base, top + 5, hex, 0.95);
          for (const f of sf) { k.vq(k.F, f, f.len / 2 - 0.7, f.len / 2 + 0.7, top + 2.2, top + 4.2, 0.03, 0x24272a); k.ledge(f, -0.1, f.len + 0.1, top + 4.8, top + 5.0, 0, 0.2, STONE); }
          this.spire({ ...st, w: 5.4, d: 5.4 }, top + 5.0, 3.6, 0x4a4d52);
        }
        if (w * d > 1200 && !lean) {
          const cx = o.cx - nx * d / 2 + tx * (w / 3), cz = o.cz - nz * d / 2 + tz * (w / 3), bh = top + 14 - base;
          k.F.cyl(cx, base, cz, 1.9, 1.15, bh, dim(hex, 0.9), 10, false, 0.95);
          k.F.cyl(cx, top + 11, cz, 1.3, 1.3, 0.5, 0xe4ddd0, 10, false); k.F.cyl(cx, top + 13.6, cz, 1.35, 1.35, 0.5, dim(hex, 0.8), 10, true);
        }
      }
      if (!gabled) k.hq(k.F, fr[0], 0, fr[0].len, -d, 0, top, true, roofHex);
      this.osolid(o, top, base - 0.6);
      // The front wall the businesses hang their signs on.
      lot.wall = { x: fr[0].ox + fr[0].tx * w / 2, z: fr[0].oz + fr[0].tz * w / 2, nx: fr[0].nx, nz: fr[0].nz };
    }
  }

  /** Asphalt in front of a store, clipped back until it stands clear of the roads, with a row of bay lines. */
  private parkingLot(o: Ori, f0: Frame, lean: boolean, G: CityPlan['streets']): void {
    const k = this.k;
    let dep = 18;
    const ok = (dd: number): boolean => {
      if (!G) return true;
      for (const s of [0.5, o.w * 0.5, o.w - 0.5]) for (const oo of [dd, dd * 0.5]) if (!G.clearOfRoads(PX(f0, s, oo), PZ(f0, s, oo), 1.5)) return false;
      return true;
    };
    while (dep > 6 && !ok(dep)) dep -= 3;
    if (dep <= 6) return;
    let gy = -1e9;
    for (const s of [0, o.w]) for (const oo of [0, dep]) gy = Math.max(gy, groundAt(PX(f0, s, oo), PZ(f0, s, oo)));
    if (gy - groundAt(PX(f0, o.w / 2, dep / 2), PZ(f0, o.w / 2, dep / 2)) > 1.2) return;
    k.hq(k.F, f0, 0, o.w, 0.05, dep, gy + 0.04, true, TAR, 1);
    if (lean) return;
    const n = Math.min(14, Math.floor(o.w / 3));
    for (let i = 1; i < n; i++) k.hq(k.F, f0, (i * o.w) / n - 0.06, (i * o.w) / n + 0.06, dep - 5.5, dep - 0.6, gy + 0.05, true, 0xe9e7df, 1);
  }

  /** Air handlers and vents on a flat roof. */
  private roofPlant(o: Ori, top: number, rng: RNG, n: number): void {
    for (let i = 0; i < Math.min(n, 6); i++) {
      const u = rng.range(-0.35, 0.35) * o.w, v = rng.range(-0.3, 0.3) * o.d, nx = Math.sin(o.h), nz = Math.cos(o.h);
      this.obox({ cx: o.cx + nz * u + nx * v, cz: o.cz - nx * u + nz * v, h: o.h, w: rng.range(1.8, 3.2), d: rng.range(1.5, 2.4) }, top, top + rng.range(0.9, 1.5), 0x9ea2a4, 0.95);
    }
  }

  /** Whether an oriented lot has a cross street just beside it (a point 7 m past either side is on or by a road). */
  private cornerO(o: Ori): boolean {
    const G = this.game.plan.streets;
    if (!G) return false;
    const nx = Math.sin(o.h), nz = Math.cos(o.h);
    for (const sd of [-1, 1]) for (const q of [0.25, 0.5]) {
      const u = sd * (o.w / 2 + 7), x = o.cx + nx * (o.d / 2 - o.d * q * 0.5) + nz * u, z = o.cz + nz * (o.d / 2 - o.d * q * 0.5) - nx * u;
      if (!G.clearOfRoads(x, z, 3)) return true;
    }
    return false;
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
    if (civic) {
      // The Blender model (civicAssets.ts): First Church of the Lukewarm, or St. Dither's with its tower at the front-left corner.
      const c = first ? CIVIC.chw : CIVIC.chs, L = frameOf(lot, face), s0 = (L.len - c.W + (first ? 0 : 2.2)) / 2;
      civic.place(first ? 'chw' : 'chs', PX(L, s0, -c.SB), y, PZ(L, s0, -c.SB), L.tx, L.tz, L.nx, L.nz);
      const sb = s0 > 5 ? s0 / 2 - (first ? 0 : 1.1) : L.len - 1.5;
      this.k.board(PX(L, sb, -1.6), PZ(L, sb, -1.6), face, y, 2.4, 'm-church', first ? 0.9 : 0.7, 0xf1ede2);
      return;
    }
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

    if (this.rf) {
      // Lackwool Mill, modelled in Blender (riverfrontAssets.ts): here only what the physics feels.
      const L = LACKWOOL, top = y + L.RIDGE - 0.8;
      k.solid({ x0: L.X0, z0: L.Z0, x1: L.X0 + L.D, z1: L.Z0 + L.N * L.SEC }, top, y - 1);
      k.solid({ x0: L.ell.x0, z0: L.ell.z0, x1: L.ell.x1, z1: L.ell.z1 }, y + L.ell.ridge - 0.8, y - 1);
      k.solid({ x0: L.tower.x0, z0: L.tower.z0, x1: L.tower.x1, z1: L.tower.z1 }, y + L.tower.top, y - 1);
      k.solid({ x0: L.boiler.x0, z0: L.boiler.z0, x1: L.boiler.x1, z1: L.boiler.z1 }, y + L.boiler.ridge - 0.8, y - 1);
      k.solid({ x0: L.stack.x - 2.7, z0: L.stack.z - 2.7, x1: L.stack.x + 2.7, z1: L.stack.z + 2.7 }, y + L.stack.top, y - 1);
      this.rf.mill(y);
    } else {
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
    }

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
      for (const [a, b] of z < FOOTBRIDGE_Z && z1 > FOOTBRIDGE_Z ? [[z, FOOTBRIDGE_Z - 3], [FOOTBRIDGE_Z + 3, z1]] : [[z, z1]]) k.fenceRun({ x0: 247.8, z0: a, x1: 247.8, z1: b }, y, 'rail');
      if (!k.low) for (const bz of [z + 14, z + 44]) if (Math.abs(bz - FOOTBRIDGE_Z) > 6 && bz < z1) {
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
      // The Holding Pattern: behind the east side of Main St from the square's cross street to Trestle St, every block is
      // Main St's wall of shops and the lot behind it.
      if (!STREETS_NEW && this.rf && r.x0 > 82 && r.x1 < 162 && r.z0 > -1500 && r.z1 < -1185) {
        if (Math.abs(r.x0 - 83.5) < 1.5) this.row({ ...r, x1: r.x0 + 17 }, 3, ly, rng, lot.block, true, null);
        if (!this.hpDone.has(lot.block)) {
          this.hpDone.add(lot.block);
          const same = lots.filter((l) => l.block === lot.block && l.district === 'mill');
          const bz0 = Math.min(...same.map((l) => l.rect.z0)), bz1 = Math.max(...same.map((l) => l.rect.z1)), bx1 = Math.max(...same.map((l) => l.rect.x1));
          this.holdingPattern({ x0: 83.5 + 17.5, z0: bz0, x1: bx1, z1: bz1 }, ly, new RNG(91000 + lot.block));
        }
        return;
      }
      // A lot that touches Main St but faces a cross street gives its west 17 m to Main St's wall of shops.
      if (!STREETS_NEW && Math.abs(r.x0 - 83.5) < 1.5 && r.x1 - r.x0 > 44) { this.row({ ...r, x1: r.x0 + 17 }, 3, ly, rng, lot.block, true, null); rr = { ...r, x0: r.x0 + 19 }; }
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

  /**
   * New streets: The Holding Pattern west of Main St (owner's decision: the real Concourse's place). Its lanes are the graph's
   * Holding Pattern Ln, so the lot is the tarmac between them and Dutch Elm St: strips clear of every road, stalls nose-in
   * from the lanes, lamp standards on the widest strips, dumpsters by the west row's back doors.
   */
  holdingPatternWest(): void {
    const k = this.k, rf = this.rf!, col = k.game.col, G = this.game.plan.streets!, R = NEW_SITES.hp, PAINT = 0xe2ded0;
    const rng = new RNG(91777), y = groundAt((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2);
    const ok = (x: number, z: number): boolean => G.clearOfRoads(x, z, 0.4);
    let lampAt = R.z0 + 8;
    for (let z = R.z0; z < R.z1 - 0.01; z += 2) {
      const za = z, zb = Math.min(z + 2, R.z1), zm = (za + zb) / 2;
      k.at((R.x0 + R.x1) / 2, zm);
      let run = -1;
      for (let x = R.x0; x <= R.x1 + 0.01; x += 0.5) {
        const inside = x < R.x1 && ok(x, za + 0.1) && ok(x, zb - 0.1);
        if (inside && run < 0) run = x;
        if ((!inside || x >= R.x1) && run >= 0) {
          const xa = run, xb = x;
          run = -1;
          if (xb - xa < 3) continue;
          k.F.floor(xa, za, xb, zb, y + 0.04, 0x47484b, 1, 1, rng.range(0.95, 1.03));
          if (k.low) continue;
          // Stall lines every 2.75 m, 5 m long, from each side of a strip wide enough to park in.
          const lines = (Math.round(za / 2.75) !== Math.round(zb / 2.75));
          if (lines && xb - xa >= 5.6) k.F.floor(xa + 0.2, zm - 0.06, xa + 5.2, zm + 0.06, y + 0.046, PAINT);
          if (lines && xb - xa >= 11.4) k.F.floor(xb - 5.2, zm - 0.06, xb - 0.2, zm + 0.06, y + 0.046, PAINT);
          if (xb - xa >= 12 && zm > lampAt) {
            lampAt = zm + 28;
            const lx = (xa + xb) / 2;
            rf.lamp(lx, y + 0.04, zm, 0);
            col.addProp(lx, zm, 0.35, y + 9, 'post', false);
          }
        }
      }
    }
    // The backs of Main St's west row, with their dumpsters where the lane leaves room.
    for (let zc = R.z0 + 6; zc < R.z1 - 4; zc += rng.range(11, 17)) {
      const dx = MS_XW - 12.4;
      if (!G.clearOfRoads(dx, zc, 1.3)) continue;
      k.at(dx, zc);
      rf.dumpster(dx, y + 0.04, zc, -Math.PI / 2);
      col.addBox(dx - 0.7, zc - 1.05, dx + 0.6, zc + 1.05, y + 1.25, y - 0.5);
    }
  }

  /**
   * The Holding Pattern, the big lot behind the east side of Main St (after the real downtown's): a service lane along the
   * blocks' brick backs with their dumpsters, then rows of 60-degree stalls either side of three aisles, two curbed
   * planted islands down the double rows with lamp standards on them, cross aisles at both ends. `r` starts at the backs.
   */
  private holdingPattern(r: Rect, y: number, rng: RNG): void {
    const k = this.k, rf = this.rf!, col = k.game.col, PAINT = 0xe2ded0, z0 = r.z0 + 7.5, z1 = r.z1 - 7.5;
    k.at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
    k.F.floor(r.x0, r.z0 + 0.4, r.x1 - 0.3, r.z1 - 0.4, y + 0.04, 0x47484b, 1, 1, rng.range(0.94, 1.04));
    // Patched and sealed strips, as old lots are.
    if (!k.low) for (let i = 0; i < 5; i++) {
      const px = rng.range(r.x0 + 8, r.x1 - 10), pz = rng.range(r.z0 + 6, r.z1 - 16);
      k.F.floor(px, pz, px + rng.range(3, 9), pz + rng.range(4, 14), y + 0.043, rng.pick([0x3b3c3f, 0x55565a, 0x404144]));
    }
    const x = (o: number): number => r.x0 + o;
    // Stall rows (x0..x1 of the row, and which way the stalls lean), islands between the double rows.
    const rows: [number, number, number][] = [[x(6), x(11.5), 1], [x(18.5), x(24), -1], [x(26), x(31.5), -1], [x(38.5), x(44), 1], [x(46), x(51.5), 1]];
    const islands = [x(24), x(44)];
    const run = z1 - z0, slant = 5.5 / Math.tan(Math.PI / 3), pitch = 2.75 / Math.sin(Math.PI / 3);
    if (!k.low) for (const [a, b, lean] of rows) {
      const n = Math.floor((run - slant) / pitch), ang = Math.atan2(lean * slant, b - a), len = Math.hypot(b - a, slant);
      for (let i = 0; i <= n; i++) {
        const zc = z0 + slant / 2 + i * pitch;
        k.F.box((a + b) / 2, y + 0.045, zc, len, 0.008, 0.11, PAINT, -ang, 1);
      }
      k.F.floor(a, z0 - 0.06, b, z0 + 0.06, y + 0.046, PAINT); k.F.floor(a, z1 - 0.06, b, z1 + 0.06, y + 0.046, PAINT);
    }
    // Direction arrows in the aisles, alternating, as one-way aisles are marked.
    if (!k.low) [x(15), x(35), x(55)].forEach((ax, i) => {
      for (let zc = z0 + 10; zc < z1 - 6; zc += 26) {
        const d = i % 2 ? -1 : 1;
        k.F.box(ax, y + 0.045, zc, 0.22, 0.008, 3.0, PAINT, 0, 1);
        k.F.box(ax - 0.45, y + 0.045, zc + d * 1.2, 0.18, 0.008, 1.2, PAINT, d * 0.7, 1); k.F.box(ax + 0.45, y + 0.045, zc + d * 1.2, 0.18, 0.008, 1.2, PAINT, -d * 0.7, 1);
      }
    });
    for (const ix of islands) {
      k.F.box(ix + 1, y, (z0 + z1) / 2, 2.0, 0.17, run + 1.5, 0xb9b3a4, 0, 5);
      k.F.floor(ix + 0.15, z0 - 0.6, ix + 1.85, z1 + 0.6, y + 0.172, 0x5d6844, 1, 1, rng.range(0.9, 1.1));
      const nl = Math.max(2, Math.round(run / 28));
      for (let i = 0; i <= nl; i++) {
        const lz = z0 + run * i / nl;
        rf.lamp(ix + 1, y + 0.17, lz, 0);
        col.addProp(ix + 1, lz, 0.35, y + 9, 'post', false);
      }
    }
    // Along the backs: the service lane's dumpsters, by the rear doors.
    for (let zc = r.z0 + 4 + rng.range(0, 6); zc < r.z1 - 3; zc += rng.range(9, 17)) {
      const dx = r.x0 - 0.9;
      rf.dumpster(dx, y + 0.04, zc, Math.PI / 2);
      col.addBox(dx - 0.6, zc - 1.05, dx + 0.7, zc + 1.05, y + 1.25, y - 0.5);
    }
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
  const rf = new Riverfront(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  if (RIVER_ON) { b.rf = rf; rf.footbridge(); }
  // The churches and civic buildings (civicAssets.ts): the post office and Our Lady here, the hall and the square's kit in
  // mainlandPlaces.ts, the two smaller churches on The Stacks' lots below.
  const cv = makeCivic(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  if (cv) {
    const d = CIVIC.dlo, l = CIVIC.lady, ln = CIVIC.ladyNew;
    if (STREETS_NEW) {
      // Facing west onto Tuition Ave, and Our Lady square to Tarnish St.
      cv.place('dlo', d.x, groundAt(d.x + d.D / 2, d.z0 + d.W / 2), d.z0, 0, 1, -1, 0);
      cv.place('chb', ln.x, groundAt(ln.x - ln.nx * 17, ln.z - ln.nz * 17), ln.z, ln.tx, ln.tz, ln.nx, ln.nz);
    } else {
      cv.place('dlo', d.x, groundAt(d.x - d.D / 2, d.z0 - d.W / 2), d.z0, 0, -1, 1, 0);
      cv.place('chb', l.x0, groundAt(l.x0 + l.W / 2, l.z - l.D / 2), l.z, 1, 0, 0, 1);
    }
  }
  makeCivicHero(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  const lots = mainlandLots(plan);
  makeHouses(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  b.pickChurches(lots);
  b.main(lots, plan.blocks, plan.lots.length);
  b.stacks(lots, plan.blocks, plan.lots.length);
  b.osm(lots, plan.lots.length);
  b.mill(lots, plan.lots.length);
  if (STREETS_NEW && b.rf) b.holdingPatternWest();
  // No kit.finish() here: mainlandPlaces.ts draws the landmarks into the same batches and builds the meshes.
  const pd = new PardonsStore(game, parent, () => (mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
  return {
    update: () => { kit.update(); ms.update(); rf.update(); pd.update(); cv?.update(); civicHero?.update(); houses?.update(); },
    setNight: (n: number) => { TOWN_NIGHT.value = n; kit.setNight(); ms.setNight(n); rf.setNight(n); pd.setNight(n); cv?.setNight(n); civicHero?.setNight(n); houses?.setNight(n); },
  };
}

void CURB; void IRON; void WHITE;
