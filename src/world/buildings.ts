// The skyline: everything that stands on a lot in plan.lots.
//
// One generator per district, so each reads differently from a moving car and
// from the air: glass towers (Ledger District), brick mid-rises over shopfronts
// (Tinker Row), crooked tile-roofed houses (Fishbone), clapboard houses on lawns
// (Gull Heights), sawtooth sheds and tank farms (The Cannery), container stacks
// (Dock Seven) and false-front boardwalk shops (Saltwater Strand).
//
// HOW IT IS PUT TOGETHER
//   * Walls are described in a "frame": a wall side of a rectangle with s running
//     left to right AS SEEN FROM OUTSIDE and `out` pointing away from the wall.
//     Every sign, shopfront and door goes through panel(), which lays u along s,
//     so lettering can never come out mirrored whichever way the wall faces.
//   * Geometry is merged per material. The heavy materials (walls, flat colour,
//     ground-floor kit) are split by district zone so the GPU can skip what is
//     behind the camera; the light ones (signs, roofs, fences) are only split into
//     three north-south strips, because a draw call costs more than their triangles.
//   * Each lot has its own RNG seeded from its index: changing one generator never
//     reshuffles the rest of the city.
//   * Yard surfaces (lawns, paving) ride 5 cm above the block slab that ground.ts
//     lays; anything painted on top of them uses the polygon-offset decal material
//     at the same height.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials } from './materials';
import { Batch } from './batch';
import { CURB, RAMPS, SIDEWALK, type Block, type District, type Lot, type Rect } from './plan';
import { CONTAINER_UV, FENCE_UV, KIT_M } from './textures';
import { RNG, clamp, lerp } from '../core/util';

const INK = 0x14213d, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, TEAL = 0x2a9d8f;
const STONE = 0xd8cfba, IRON = 0x2e3338, CONC = 0xb7b2a6, HEDGE = 0x5d7d4c, BRICK = 0xa8503a, VERDIGRIS = 0x4fa493;
const GLASS = [0xcfe0e4, 0xf2e8cf, 0x8fd0c4, 0x8fa3c8, 0xe9cfa6, 0xb9d6cf];
const BRICKS = [0xb5563f, 0x9c4a38, 0xc77b58, 0x8a5a48, 0xcda67c, 0x7d4b3e, 0xa9654a, 0xd8cdb4];
const STUCCO = [0xf0c79a, 0xf2e2c0, 0xe9b08a, 0xf3d488, 0xcfd9b8, 0xe7a58f, 0xb9d6cf, 0xf4ead6];
const SIDING = [0xf2e8cf, 0xcfdcc2, 0xbcd9d4, 0xf3dc9c, 0xb8cbe0, 0xe8b9a0, 0xe6e2da, 0xd9c7a3];
const SHINGLES = [0x5b5f66, 0x7a5a48, 0x4f6b6a, 0x8f4a3c, 0x6b6a5e];
const METAL = [0x9fb3a4, 0xb98468, 0xa9c4c0, 0xd9d0b8, 0xd6b56a, 0x8d9aa6];
const BOARDWALK = [0xf4b9a0, 0xf6d98b, 0x9fd6cb, 0xf2e8cf, 0xe98f6f, 0xa9cfe0, 0xc5d6a4];
const AWN = [VERM, TEAL, MUST, INK, BONE, 0x9caf88, 0xc9714a];
const SHOPFRONT = [0xf2e8cf, 0xd9e2cf, 0xbfd8d2, 0xf0d9a8, 0xe9b7a0, 0xcfd3d6];
// Midtown brick, knocked back from vermilion: oxblood, dusty rose, buff, sage-painted, soot, so no street is one colour.
const MIDBRICK = [0x9c5547, 0x7f4a40, 0xc08f7c, 0xcdb48c, 0x9fae8f, 0x6e6a66, 0xb06a52, 0xd8cdb4];
const BOXES = [VERM, MUST, TEAL, 0x2b4170, BONE, BRICK, 0x9caf88, 0xc9714a, 0x3f6f8f];

/** Height of lawns, drives and paving: just proud of the block slab so the two never flicker. */
const GY = CURB + 0.05;

/** Where the story's addresses ended up, for missions and the map. x, z = the middle of the frontage. */
export interface BuildingSite { x: number; z: number; /** Side the frontage looks at: 0 north, 1 east, 2 south, 3 west. */ side: number }
export const BUILDING_SITES: Record<string, BuildingSite> = {};

type MK = 'flat' | 'kit' | 'f0' | 'f1' | 'f2' | 'f3' | 'sign' | 'gravel' | 'tile' | 'shingle' | 'corr'
  | 'cont' | 'fence' | 'grass' | 'wood' | 'cobble' | 'decal';
const HEAVY = new Set<MK>(['flat', 'kit', 'f0', 'f1', 'f2', 'f3']);
const NO_SHADOW = new Set<MK>(['sign', 'fence', 'grass', 'gravel', 'cobble', 'decal', 'kit']);

interface UV { u0: number; v0: number; u1: number; v1: number }

/** One wall side of a rect. s runs left to right seen from outside; (nx, nz) points outward. */
interface Frame { ox: number; oz: number; tx: number; tz: number; nx: number; nz: number; len: number; depth: number }

function frameOf(r: Rect, side: number): Frame {
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  switch (side & 3) {
    case 0: return { ox: r.x1, oz: r.z0, tx: -1, tz: 0, nx: 0, nz: -1, len: w, depth: d };
    case 1: return { ox: r.x1, oz: r.z1, tx: 0, tz: -1, nx: 1, nz: 0, len: d, depth: w };
    case 2: return { ox: r.x0, oz: r.z1, tx: 1, tz: 0, nx: 0, nz: 1, len: w, depth: d };
    default: return { ox: r.x0, oz: r.z0, tx: 0, tz: 1, nx: -1, nz: 0, len: d, depth: w };
  }
}
const PX = (f: Frame, s: number, o: number): number => f.ox + f.tx * s + f.nx * o;
const PZ = (f: Frame, s: number, o: number): number => f.oz + f.tz * s + f.nz * o;

/** The part of `r` between s0..s1 along side `side` and d0..d1 meters in from that side. */
function cut(r: Rect, side: number, s0: number, s1: number, d0: number, d1: number): Rect {
  const f = frameOf(r, side);
  const ax = PX(f, s0, -d0), az = PZ(f, s0, -d0), bx = PX(f, s1, -d1), bz = PZ(f, s1, -d1);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}
const inset = (r: Rect, m: number): Rect => ({ x0: r.x0 + m, z0: r.z0 + m, x1: r.x1 - m, z1: r.z1 - m });
const hits = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/** Upright quad on a wall. u follows s, so atlas pieces read the right way round. */
function panel(b: Batch, f: Frame, s0: number, s1: number, y0: number, y1: number, out: number, hex: number, uv: UV, shade = 1): void {
  const ax = PX(f, s0, out), az = PZ(f, s0, out), bx = PX(f, s1, out), bz = PZ(f, s1, out);
  b.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, hex, uv.u0, uv.v0, uv.u1, uv.v1, shade);
}
/** Quad from a low edge (y0, out0) to a high edge (y1, out1); with out1 < out0 it faces up and outward (awnings, lean-to roofs). */
function slope(b: Batch, f: Frame, s0: number, s1: number, y0: number, out0: number, y1: number, out1: number, hex: number, uv: UV, shade = 1): void {
  b.quad(PX(f, s0, out0), y0, PZ(f, s0, out0), PX(f, s1, out0), y0, PZ(f, s1, out0),
    PX(f, s1, out1), y1, PZ(f, s1, out1), PX(f, s0, out1), y1, PZ(f, s0, out1), hex, uv.u0, uv.v0, uv.u1, uv.v1, shade);
}
/** Box given in wall coordinates: centered at (s, out), `ls` long along the wall and `lo` deep. */
function lbox(b: Batch, f: Frame, s: number, out: number, y0: number, ls: number, lo: number, h: number, hex: number, faces = 5, shade = 1): void {
  b.box(PX(f, s, out), y0, PZ(f, s, out), Math.abs(f.tx) * ls + Math.abs(f.nx) * lo, h, Math.abs(f.tz) * ls + Math.abs(f.nz) * lo, hex, 0, faces, shade);
}

interface LotCtx {
  i: number; lot: Lot; r: Rect; rng: RNG; block: Block;
  /** Which of the lot's sides look straight onto a sidewalk: [north, east, south, west]. */
  street: boolean[];
  /** Story role, '' for an ordinary lot. */
  kind: string;
}

class Builder {
  private bats = new Map<string, Batch>();
  private zone = '';
  private wide = 'C';
  private decks = new Map<number, string[]>();
  private reshuffles = 0;
  private clear: Rect[] = [];
  private special = new Map<number, string>();
  private dens: number;
  readonly beacons = [new Batch(), new Batch()];
  private nBeacon = 0;

  constructor(private game: Game, private mats: CityMaterials) {
    this.dens = game.quality.density;
    // Ramps keep their run-up (40 m behind the low lip) and landing free of anything solid.
    for (const p of RAMPS) {
      const s = Math.sin(p.h), c = Math.cos(p.h), hw = p.width / 2 + 9;
      const xs: number[] = [], zs: number[] = [];
      for (const a of [-40, p.len + 12]) for (const sd of [-hw, hw]) { xs.push(p.x + s * a - c * sd); zs.push(p.z + c * a + s * sd); }
      this.clear.push({ x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) });
    }
    // The container-yard jump gets a whole lane: you land among the stacks, not in one.
    this.clear.push({ x0: 494, x1: 516, z0: 180, z1: 400 });
  }

  // ── Batches ────────────────────────────────────────────────────────────────

  private b(k: MK): Batch {
    const key = k + '|' + (HEAVY.has(k) ? this.zone : this.wide);
    let b = this.bats.get(key);
    if (!b) this.bats.set(key, (b = new Batch()));
    return b;
  }

  private mat(k: MK): THREE.Material {
    const m = this.mats;
    switch (k) {
      case 'f0': return m.facade[0];
      case 'f1': return m.facade[1];
      case 'f2': return m.facade[2];
      case 'f3': return m.facade[3];
      case 'kit': return m.kit;
      case 'sign': return m.sign;
      case 'gravel': return m.roofGravel;
      case 'tile': return m.roofTile;
      case 'shingle': return m.shingle;
      case 'corr': return m.corrugated;
      case 'cont': return m.container;
      case 'fence': return m.fence;
      case 'grass': return m.grass;
      case 'wood': return m.wood;
      case 'cobble': return m.cobble;
      case 'decal': return m.decal;
      default: return m.flat;
    }
  }

  finish(parent: THREE.Object3D): THREE.Mesh[] {
    for (const [key, bat] of this.bats) {
      if (bat.empty) continue;
      const k = key.slice(0, key.indexOf('|')) as MK;
      const m = new THREE.Mesh(bat.toGeometry(), this.mat(k));
      m.name = 'bld:' + key;
      m.castShadow = !NO_SHADOW.has(k); m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      // Decals do not write depth, so they must be drawn after the surface they lie on.
      if (k === 'decal') m.renderOrder = 1;
      parent.add(m);
    }
    this.bats.clear();
    return this.beacons.map((bat, i) => {
      const m = new THREE.Mesh(bat.toGeometry(), this.mats.glow);
      m.name = 'bld:beacon' + i; m.matrixAutoUpdate = false; m.renderOrder = 3; m.visible = false;
      parent.add(m);
      return m;
    });
  }

  // ── Small parts ────────────────────────────────────────────────────────────

  /** True with probability p, scaled by the quality preset. Always draws one number, so layouts match across presets. */
  private opt(rng: RNG, p: number): boolean { return rng.next() < p * this.dens; }

  /** Horizontal surface with world-space UVs, so neighbours tile into each other. */
  private ground(k: MK, r: Rect, y: number, hex: number, tile = 8, shade = 1): void {
    this.b(k).quad(r.x0, y, r.z1, r.x1, y, r.z1, r.x1, y, r.z0, r.x0, y, r.z0, hex, r.x0 / tile, r.z1 / tile, r.x1 / tile, r.z0 / tile, shade);
  }

  private ring(r: Rect, y: number, h: number, out: number, hex: number, shade = 1): void {
    this.b('flat').box((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2, r.x1 - r.x0 + out * 2, h, r.z1 - r.z0 + out * 2, hex, 0, 7, shade);
  }

  private parapet(r: Rect, y: number, h: number, t: number, hex: number, shade = 1): void {
    const b = this.b('flat'), w = r.x1 - r.x0, d = r.z1 - r.z0, mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
    b.box(mx, y, r.z0 + t / 2, w, h, t, hex, 0, 5, shade);
    b.box(mx, y, r.z1 - t / 2, w, h, t, hex, 0, 5, shade);
    b.box(r.x0 + t / 2, y, mz, t, h, d - t * 2, hex, 0, 5, shade);
    b.box(r.x1 - t / 2, y, mz, t, h, d - t * 2, hex, 0, 5, shade);
  }

  /** Flat roof: gravel, a parapet, and the roof edge it implies. */
  private flatRoof(r: Rect, y: number, hex: number, ph = 0.7): void {
    this.ground('gravel', r, y, 0xffffff);
    if (ph > 0) this.parapet(r, y, ph, 0.3, hex, 0.86);
  }

  private piers(r: Rect, y0: number, y1: number, hex: number, s = 0.9): void {
    const b = this.b('flat'), o = s / 2 - 0.14;
    for (const x of [r.x0 + o, r.x1 - o]) for (const z of [r.z0 + o, r.z1 - o]) b.box(x, y0, z, s, y1 - y0, s, hex, 0, 5);
  }

  private kitPiece(f: Frame, name: string, s: number, y: number, hex: number, out = 0.05): void {
    const [w, h] = KIT_M[name];
    panel(this.b('kit'), f, s, s + w, y, y + h, out, hex, this.mats.tex.kit.rect(name));
  }

  /** Canvas awning with its underside, hung from `yTop` and reaching `proj` over the sidewalk. */
  private awning(f: Frame, s0: number, s1: number, yTop: number, drop: number, proj: number, hex: number, striped: boolean): void {
    const rc = this.mats.tex.kit.rect(striped ? 'awningStripe' : 'awningSolid'), b = this.b('kit');
    const uv: UV = { u0: rc.u0, v0: rc.v0, u1: rc.u0 + (rc.u1 - rc.u0) * clamp((s1 - s0) / 4, 0.25, 1), v1: rc.v1 };
    slope(b, f, s0, s1, yTop - drop, proj, yTop, 0.07, hex, uv);
    slope(b, f, s1, s0, yTop - drop, proj, yTop, 0.07, hex, uv, 0.6);
  }

  /** A 4:1 (or whatever the piece is) signboard on a wall, `w` meters wide. Returns its height. */
  private signBoard(f: Frame, name: string, s: number, y: number, w: number, out = 0.1, backing = true): number {
    const rc = this.mats.tex.signs.rect(name), h = w / rc.aspect;
    if (backing) lbox(this.b('flat'), f, s + w / 2, out / 2, y - 0.06, w + 0.12, out, h + 0.12, IRON, 7);
    panel(this.b('sign'), f, s, s + w, y, y + h, out + 0.03, 0xffffff, rc);
    return h;
  }

  /** Round pictogram on an iron bracket, at right angles to the wall so it reads from both ways along the street. */
  private hangSign(f: Frame, s: number, y: number, name: string): void {
    const rc = this.mats.tex.signs.rect(name), b = this.b('sign');
    lbox(this.b('flat'), f, s, 0.6, y + 0.86, 0.06, 1.2, 0.06, IRON, 7);
    const quad = (sa: number, oa: number, ob: number): void => {
      const ax = PX(f, sa, oa), az = PZ(f, sa, oa), bx = PX(f, sa, ob), bz = PZ(f, sa, ob);
      b.quad(ax, y, az, bx, y, bz, bx, y + 0.8, bz, ax, y + 0.8, az, 0xffffff, rc.u0, rc.v0, rc.u1, rc.v1);
    };
    quad(s + 0.02, 1.1, 0.3);
    quad(s - 0.02, 0.3, 1.1);
  }

  /** Clapboard walls on all four sides: the plank texture turned so the boards run level. */
  private siding(r: Rect, y0: number, y1: number, hex: number, shade = 1): void {
    const b = this.b('wood');
    for (let k = 0; k < 4; k++) {
      const f = frameOf(r, k);
      const ax = PX(f, 0, 0), az = PZ(f, 0, 0), bx = PX(f, f.len, 0), bz = PZ(f, f.len, 0);
      b.quad(ax, y1, az, ax, y0, az, bx, y0, bz, bx, y1, bz, hex, 0, 0, (y1 - y0) / 4, f.len / 4, shade * (k === 0 || k === 3 ? 0.94 : 1));
    }
  }

  /** Pitched roof over `r` with its eaves at y. The roof materials are double-sided, so the overhang shows from below. */
  private gable(k: MK, r: Rect, y: number, rise: number, alongX: boolean, over: number, hex: number, wallHex: number, shade = 1): void {
    const b = this.b(k), g = this.b('flat');
    const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2, yR = y + rise;
    if (alongX) {
      const half = (r.z1 - r.z0) / 2, yE = y - (over * rise) / half, x0 = r.x0 - over, x1 = r.x1 + over;
      const u = (x1 - x0) / 4, v = Math.hypot(half + over, yR - yE) / 4;
      b.quad(x0, yE, r.z1 + over, x1, yE, r.z1 + over, x1, yR, mz, x0, yR, mz, hex, 0, 0, u, v, shade);
      b.quad(x1, yE, r.z0 - over, x0, yE, r.z0 - over, x0, yR, mz, x1, yR, mz, hex, 0, 0, u, v, shade * 0.9);
      g.tri(r.x0, y, r.z0, r.x0, y, r.z1, r.x0, yR, mz, wallHex, 0.92);
      g.tri(r.x1, y, r.z1, r.x1, y, r.z0, r.x1, yR, mz, wallHex, 0.92);
    } else {
      const half = (r.x1 - r.x0) / 2, yE = y - (over * rise) / half, z0 = r.z0 - over, z1 = r.z1 + over;
      const u = (z1 - z0) / 4, v = Math.hypot(half + over, yR - yE) / 4;
      b.quad(r.x1 + over, yE, z1, r.x1 + over, yE, z0, mx, yR, z0, mx, yR, z1, hex, 0, 0, u, v, shade);
      b.quad(r.x0 - over, yE, z0, r.x0 - over, yE, z1, mx, yR, z1, mx, yR, z0, hex, 0, 0, u, v, shade * 0.9);
      g.tri(r.x0, y, r.z1, r.x1, y, r.z1, mx, yR, r.z1, wallHex, 0.92);
      g.tri(r.x1, y, r.z0, r.x0, y, r.z0, mx, yR, r.z0, wallHex, 0.92);
    }
  }

  private pyramid(r: Rect, y: number, h: number, hex: number): void {
    const b = this.b('flat'), mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2, t = y + h;
    b.tri(r.x0, y, r.z1, r.x1, y, r.z1, mx, t, mz, hex, 1);
    b.tri(r.x1, y, r.z1, r.x1, y, r.z0, mx, t, mz, hex, 0.86);
    b.tri(r.x1, y, r.z0, r.x0, y, r.z0, mx, t, mz, hex, 0.74);
    b.tri(r.x0, y, r.z0, r.x0, y, r.z1, mx, t, mz, hex, 0.9);
  }

  /**
   * Textured walls around any convex outline. Points go the same way round as Batch.walls
   * (along the south side toward +X first), which is what keeps the windows facing out.
   */
  private prism(k: MK, p: number[], y0: number, y1: number, hex: number, bay: number, floorH: number, seed: number, capHex = -1): void {
    const b = this.b(k), n = p.length / 2, fl = Math.max(1, Math.round((y1 - y0) / floorH)) / 8, vo = ((seed * 5) % 8) / 8;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const u = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / bay)) / 8, uo = ((seed * 7 + i * 3) % 8) / 8;
      b.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, hex, uo, vo, uo + u, vo + fl);
      cx += ax / n; cz += az / n;
    }
    if (capHex < 0) return;
    const c = this.b('flat');
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      c.tri(cx, y1, cz, p[i * 2], y1, p[i * 2 + 1], p[j * 2], y1, p[j * 2 + 1], capHex);
    }
  }

  private fence(kind: keyof typeof FENCE_UV, f: Frame, s0: number, s1: number, out = 0, y = CURB, hex = 0xffffff): void {
    if (s1 - s0 < 0.4) return;
    const F = FENCE_UV[kind];
    panel(this.b('fence'), f, s0, s1, y, y + F.h, out, hex, { u0: 0, v0: F.v0, u1: (s1 - s0) / F.tileM, v1: F.v1 });
  }

  /** Red aircraft-warning lamp: a small solid lantern by day, a glow that blinks at night. */
  private beacon(x: number, y: number, z: number): void {
    const g = this.beacons[this.nBeacon++ & 1], s = 3.4, c = 0xff2f1c;
    // The glow material is single-sided, so each plane is laid twice.
    g.quad(x - s, y - s, z, x + s, y - s, z, x + s, y + s, z, x - s, y + s, z, c);
    g.quad(x + s, y - s, z, x - s, y - s, z, x - s, y + s, z, x + s, y + s, z, c);
    g.quad(x, y - s, z + s, x, y - s, z - s, x, y + s, z - s, x, y + s, z + s, c);
    g.quad(x, y - s, z - s, x, y - s, z + s, x, y + s, z + s, x, y + s, z - s, c);
    g.quad(x - s, y, z + s, x + s, y, z + s, x + s, y, z - s, x - s, y, z - s, c);
    g.quad(x - s, y, z - s, x + s, y, z - s, x + s, y, z + s, x - s, y, z + s, c);
    this.b('flat').box(x, y - 0.3, z, 0.6, 0.6, 0.6, 0xd42a18, 0, 5);
  }

  private mast(x: number, y: number, z: number, h: number, light: boolean): void {
    const b = this.b('flat');
    b.cyl(x, y, z, 0.28, 0.2, h * 0.6, 0xe6e0d0, 5, false);
    b.cyl(x, y + h * 0.6, z, 0.2, 0.07, h * 0.4, VERM, 5, false);
    if (light) this.beacon(x, y + h + 0.3, z);
  }

  private waterTank(x: number, y: number, z: number, s = 1): void {
    const b = this.b('flat');
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) b.box(x + dx * 1.05 * s, y, z + dz * 1.05 * s, 0.18, 2.2, 0.18, IRON, 0, 4);
    b.cyl(x, y + 2.2, z, 1.7 * s, 1.7 * s, 3 * s, 0x8c6a4c, 10, false);
    b.cyl(x, y + 2.2 + 3 * s, z, 1.9 * s, 0.1, 1.3 * s, 0x5a544c, 10, false);
  }

  /** Rooftop plant: the boxes, vents and tanks you see from the bridge. */
  private clutter(r: Rect, y: number, rng: RNG, tall: boolean): void {
    const b = this.b('flat'), w = r.x1 - r.x0 - 2, d = r.z1 - r.z0 - 2;
    if (w < 4 || d < 4) return;
    const at = (): [number, number] => [r.x0 + 1 + w * rng.next(), r.z0 + 1 + d * rng.next()];
    const pw = clamp(w * rng.range(0.28, 0.5), 2.4, 14), pd = clamp(d * rng.range(0.28, 0.5), 2.4, 14), ph = tall ? rng.range(2.6, 4.4) : 2.4;
    const px = lerp(r.x0 + 1 + pw / 2, r.x1 - 1 - pw / 2, rng.next()), pz = lerp(r.z0 + 1 + pd / 2, r.z1 - 1 - pd / 2, rng.next());
    b.box(px, y, pz, pw, ph, pd, 0xa9a394, 0, 5);
    b.box(px, y + ph * 0.45, pz, pw + 0.12, ph * 0.3, pd + 0.12, 0x6f6c64, 0, 4);
    const n = rng.int(1, tall ? 4 : 3);
    for (let i = 0; i < n; i++) {
      const [x, z] = at(), on = this.opt(rng, 1), wide = rng.chance(0.5);
      if (on) { b.box(x, y, z, wide ? 2 : 1.3, 1.1, wide ? 1.3 : 2, 0xc9c6bb, 0, 5); b.box(x, y + 1.1, z, 0.9, 0.12, 0.9, 0x55585a, 0, 5); }
    }
    for (let i = 0; i < 2; i++) { const [x, z] = at(); if (this.opt(rng, 0.8)) b.cyl(x, y, z, 0.28, 0.28, 1.1, 0x8f8a80, 6); }
  }

  /** Iron fire escape: a landing per upper floor, a rail, and a stair zig-zagging between them. */
  private fireEscape(f: Frame, s: number, floors: number, gf: number, fh: number): void {
    const b = this.b('flat'), w = 2.7, dp = 0.95;
    for (let k = 1; k < floors; k++) {
      const y = CURB + gf + (k - 1) * fh + 0.45;
      lbox(b, f, s + w / 2, dp / 2 + 0.03, y, w, dp, 0.08, IRON, 7);
      lbox(b, f, s + w / 2, dp, y + 0.95, w, 0.05, 0.06, IRON, 4);
      for (const e of [0.03, w - 0.03]) {
        lbox(b, f, s + e, dp / 2, y + 0.95, 0.05, dp, 0.06, IRON, 4);
        lbox(b, f, s + e, dp - 0.02, y + 0.08, 0.05, 0.05, 0.9, IRON, 4);
      }
      if (k < floors - 1) {
        const a = k & 1 ? s + 0.35 : s + w - 0.35, c = k & 1 ? s + w - 0.35 : s + 0.35;
        for (const [o0, o1] of [[0.2, 0.7], [0.7, 0.2]]) {
          b.quad(PX(f, a, o0), y + 0.08, PZ(f, a, o0), PX(f, a, o1), y + 0.08, PZ(f, a, o1),
            PX(f, c, o1), y + fh + 0.08, PZ(f, c, o1), PX(f, c, o0), y + fh + 0.08, PZ(f, c, o0), IRON, 0, 0, 1, 1, 0.9);
        }
      }
    }
    lbox(b, f, s + 0.3, dp - 0.1, CURB + gf - 1.6, 0.4, 0.05, 2.1, IRON, 4);
  }

  /** Next shop sign from one city-wide shuffled deck, so no pun repeats until all are up; then it is reshuffled. */
  private dealSign(_block: number): string | null {
    let d = this.decks.get(0);
    if (!d || !d.length) {
      d = this.mats.tex.signs.shops.slice();
      const rng = new RNG(977 + this.reshuffles++ * 31);
      for (let i = d.length - 1; i > 0; i--) { const j = rng.int(0, i); [d[i], d[j]] = [d[j], d[i]]; }
      this.decks.set(0, d);
    }
    return d.pop() ?? null;
  }

  /** A run of 4 m shopfronts along a wall, with awnings and a share of the pun signs. */
  private shopRow(L: LotCtx, f: Frame, s0: number, s1: number, y: number, wallHex: number, signP: number): void {
    const rng = L.rng, n = Math.floor((s1 - s0) / 4);
    if (n < 1) return;
    const pad = (s1 - s0 - n * 4) / 2;
    for (let k = 0; k < n; k++) {
      const s = s0 + pad + k * 4;
      this.kitPiece(f, 'shop' + rng.int(0, 3), s, y, rng.chance(0.3) ? wallHex : rng.pick(SHOPFRONT));
      const name = rng.chance(signP) ? this.dealSign(L.lot.block) : null;
      const aw = rng.next(), proj = rng.range(1, 1.4), col = rng.pick(AWN), stripe = rng.chance(0.5);
      if (name) this.signBoard(f, name, s + 0.2, y + 3.04, 3.6, 0.12);
      if (aw < 0.65) this.awning(f, s + 0.15, s + 3.85, y + (name ? 2.98 : 3.1), 0.55, proj, col, stripe);
    }
  }

  private box(r: Rect, y1: number): void { this.game.col.addBox(r.x0, r.z0, r.x1, r.z1, y1); }

  /** Shrink a lot until it is clear of every ramp's run-up; null if nothing useful is left. */
  private fit(r: Rect): Rect | null {
    let cur = r;
    for (const c of this.clear) {
      if (!hits(cur, c)) continue;
      const opts: Rect[] = [{ ...cur, z1: c.z0 }, { ...cur, z0: c.z1 }, { ...cur, x1: c.x0 }, { ...cur, x0: c.x1 }];
      let best: Rect | null = null, ba = 0;
      for (const o of opts) { const a = Math.max(0, o.x1 - o.x0) * Math.max(0, o.z1 - o.z0); if (a > ba) { ba = a; best = o; } }
      if (!best) return null;
      cur = best;
    }
    return cur.x1 - cur.x0 < 8 || cur.z1 - cur.z0 < 8 ? null : cur;
  }

  private site(name: string, f: Frame, side: number): void {
    BUILDING_SITES[name] = { x: PX(f, f.len / 2, 0), z: PZ(f, f.len / 2, 0), side };
  }

  // ── The run ────────────────────────────────────────────────────────────────

  run(): void {
    const plan = this.game.plan;
    const pick = (name: string, d: District, x: number, z: number, pred?: (l: Lot) => boolean): void => {
      let best = -1, bd = Infinity;
      plan.lots.forEach((l, i) => {
        if (l.district !== d || l.interior || this.special.has(i) || (pred && !pred(l))) return;
        if (this.clear.some((c) => hits(l.rect, c))) return;
        const dx = (l.rect.x0 + l.rect.x1) / 2 - x, dz = (l.rect.z0 + l.rect.z1) / 2 - z, dd = dx * dx + dz * dz;
        if (dd < bd) { bd = dd; best = i; }
      });
      if (best >= 0) this.special.set(best, name);
      else if (pred) pick(name, d, x, z);
    };
    const roomy = (l: Lot): boolean => Math.min(l.rect.x1 - l.rect.x0, l.rect.z1 - l.rect.z0) >= 30;
    pick('tallest', 'downtown', 20, 30, roomy);
    pick('bollard', 'downtown', -190, -70, roomy);
    pick('zig', 'downtown', 135, 130, roomy);
    pick('wedge', 'downtown', -85, -170, roomy);
    pick('twin', 'downtown', 250, 30, roomy);
    pick('civic', 'downtown', 55, -70, roomy);
    pick('r404', 'downtown', -85, 130);
    pick('marlowe', 'industrial', -420, 235);
    pick('office', 'port', 330, 240);
    // The first thing the player sees, across Strand Blvd from the spawn point.
    const firstView = (l: Lot): boolean => l.face === 0 && l.rect.z0 > 295 && l.rect.x0 > -40 && l.rect.x1 < 90;
    pick('gus', 'strand', 34, 310, firstView);
    pick('finch', 'strand', 0, 310, firstView);

    plan.lots.forEach((lot, i) => {
      const block = plan.blocks[lot.block], r = lot.rect, br = block.rect, e = SIDEWALK + 0.02;
      const cx = (r.x0 + r.x1) / 2;
      this.wide = cx < -250 ? 'W' : cx < 310 ? 'C' : 'E';
      const d = lot.district;
      this.zone = d === 'suburb' ? 'sub' + (cx < -200 ? 0 : cx < 200 ? 1 : 2) : d === 'downtown' || d === 'strand' ? d + (cx < -30 ? 0 : 1) : d;
      const L: LotCtx = {
        i, lot, r, block, rng: new RNG(40961 + i * 7919), kind: this.special.get(i) ?? '',
        street: [block.road[0] && r.z0 - br.z0 < e, block.road[1] && br.x1 - r.x1 < e, block.road[2] && br.z1 - r.z1 < e, block.road[3] && r.x0 - br.x0 < e],
      };
      switch (d) {
        case 'downtown': this.downtown(L); break;
        case 'midtown': this.midtown(L); break;
        case 'oldtown': this.oldtown(L); break;
        case 'suburb': this.suburb(L); break;
        case 'industrial': this.industrial(L); break;
        case 'port': this.port(L); break;
        case 'strand': this.strand(L); break;
        default: break;
      }
    });
  }

  // ── Ledger District ────────────────────────────────────────────────────────

  private downtown(L: LotCtx): void {
    const { rng, lot } = L;
    if (lot.interior) { this.court(L); return; }
    const r = inset(L.r, 1.2);
    switch (L.kind) {
      case 'tallest': this.tallest(L, r); return;
      case 'bollard': this.bollard(L, r); return;
      case 'zig': this.oldTower(L, r, 102.3, true); return;
      case 'wedge': this.chamferTower(L, r, 111.6, true); return;
      case 'twin': this.twin(L, r); return;
      case 'civic': this.civic(L, r); return;
      default: break;
    }
    // Height falls away from the middle of downtown, so the skyline has one summit.
    const dist = Math.hypot((r.x0 + r.x1) / 2 - 20, (r.z0 + r.z1) / 2 - 30);
    const H = clamp((126 - dist * 0.33) * rng.range(0.74, 1.12), 45, 110);
    const style = rng.next();
    if (style < 0.24) this.oldTower(L, r, Math.min(H, 82), false);
    else if (style < 0.44) this.chamferTower(L, r, H, false);
    else this.glassTower(L, r, H, style < 0.72);
  }

  /** Stone ground floor with lobby glazing on the street sides. Returns the height of its top. */
  private base(L: LotCtx, r: Rect, hex: number): number {
    const y1 = CURB + 4.4;
    this.b('flat').box((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2, r.x1 - r.x0, y1, r.z1 - r.z0, hex, 0, 4);
    for (let k = 0; k < 4; k++) {
      if (!L.street[k]) continue;
      const f = frameOf(r, k), n = Math.floor((f.len - 1.2) / 4), pad = (f.len - n * 4) / 2;
      const egg = L.kind === 'r404' && k === L.lot.face;
      for (let i = 0; i < n; i++) {
        if (egg && i < 2) continue;
        if (n > 4 && i % 3 === 2) continue;   // a blank pier now and then, so it reads as masonry
        this.kitPiece(f, 'shop' + L.rng.int(0, 3), pad + i * 4, CURB, 0xf4efe3);
      }
      if (egg) this.room404(f, pad + 2.2);
    }
    this.ring(r, y1 - 0.35, 0.35, 0.16, hex, 0.88);
    this.lobbyDress(L, r, y1);
    return y1;
  }

  /** Gives each tower's street level one of a few faces: bare stone, a cafe awning, a bank sign, or a brass marquee. Own RNG, so the lots' layouts are untouched. */
  private lobbyDress(L: LotCtx, r: Rect, y1: number): void {
    if (L.kind === 'r404') return;
    const rg = new RNG((Math.imul(L.i + 7, 2654435761) ^ 0x5bd1e995) >>> 0); rg.next(); rg.next();
    const v = rg.int(0, 5) % 4, col = rg.pick(AWN);
    if (v === 0) return;
    for (let j = 0; j < 4; j++) {
      const k = (L.lot.face + j) & 3;   // the face the lot looks at first, so the dressing is on the side people see
      if (!L.street[k]) continue;
      const f = frameOf(r, k), n = Math.floor((f.len - 1.2) / 4);
      if (n < 2) continue;
      const pad = (f.len - n * 4) / 2, i0 = rg.int(0, Math.max(0, n - 2));
      if (v === 1) this.awning(f, pad + i0 * 4 + 0.15, pad + (i0 + 2) * 4 - 0.15, CURB + 3.2, 0.6, 1.2, col, true);
      else if (v === 2) { const nm = this.dealSign(L.lot.block); if (nm) this.signBoard(f, nm, pad + i0 * 4 + 0.2, CURB + 3.04, 3.6, 0.12); }
      else {
        const s0 = pad + i0 * 4, w = 7.6;
        lbox(this.b('flat'), f, s0 + w / 2, 0.9, CURB + 3.3, w, 1.8, 0.14, MUST, 5);
        lbox(this.b('flat'), f, s0 + w / 2, 1.78, CURB + 3.3, w, 0.05, 0.3, INK, 5);
      }
      break;
    }
    void y1;
  }

  /** The easter egg: a brass plate, and the outline of a door that was never cut. */
  private room404(f: Frame, s: number): void {
    const b = this.b('flat'), y = CURB, o = 0.03;
    const strip = (s0: number, s1: number, y0: number, y1: number, hex: number, out = o): void => panel(b, f, s0, s1, y0, y1, out, hex, { u0: 0, v0: 0, u1: 1, v1: 1 });
    // A door that was painted but never hung: navy panel, trim, kick plate and a handle, so it reads as a joke and not as missing geometry.
    strip(s - 0.1, s + 1.37, y, y + 2.55, 0x4d4a44);
    strip(s, s + 1.27, y, y + 2.45, INK, o + 0.02);
    strip(s + 0.12, s + 1.15, y + 1.3, y + 2.25, 0x1b2c50, o + 0.03);
    strip(s, s + 1.27, y, y + 0.3, VERM, o + 0.035);
    lbox(b, f, s + 1.05, 0.1, y + 1.0, 0.1, 0.1, 0.1, MUST, 5);
    strip(s - 0.2, s + 1.47, y, y + 0.02, BONE, 0.5);   // doormat
    this.signBoard(f, 'room-404', s - 0.05, y + 2.62, 1.4, 0.06, true);
    this.site('room404', { ...f, ox: PX(f, s + 0.6, 0) - f.tx * f.len / 2, oz: PZ(f, s + 0.6, 0) - f.tz * f.len / 2 }, this.lastSide(f));
  }

  private lastSide(f: Frame): number { return f.nz < 0 ? 0 : f.nx > 0 ? 1 : f.nz > 0 ? 2 : 3; }

  private glassTower(L: LotCtx, r: Rect, H: number, stepped: boolean): void {
    const rng = L.rng, tint = rng.pick(GLASS), trim = rng.pick([BONE, STONE, 0x33435f, 0x2c5d5a, 0xb9b2a2]);
    let y = this.base(L, r, rng.pick([STONE, 0xc9c2b2, 0xe6dcc6, 0x9c968a]));
    let t = inset(r, 0.3);
    const podium = rng.chance(0.6) ? 3.6 * rng.int(1, 3) : 0;
    if (podium) {
      this.b('f0').walls(t.x0, t.z0, t.x1, t.z1, y, y + podium, rng.pick(GLASS), 3.4, 3.6, 8, L.i + 1);
      y += podium;
      this.flatRoof(t, y, trim, 0.6);
      this.box(r, y + 0.6);
      t = inset(t, clamp(Math.min(t.x1 - t.x0, t.z1 - t.z0) * rng.range(0.08, 0.16), 2, 5));
    }
    const top = CURB + Math.round(H / 3.6) * 3.6, fr = stepped ? [0.64, 0.86, 1] : [1];
    for (let k = 0; k < fr.length; k++) {
      const y1 = k === fr.length - 1 ? top : y + Math.round(((top - y) * (fr[k] - (k ? fr[k - 1] : 0)) / (1 - (k ? fr[k - 1] : 0))) / 3.6) * 3.6;
      this.b('f0').walls(t.x0, t.z0, t.x1, t.z1, y, y1, tint, 3.4, 3.6, 8, L.i);
      this.piers(t, y, y1 + 0.5, trim);
      for (let by = y + 32.4; by < y1 - 8; by += 32.4) this.ring(t, by, 0.5, 0.1, trim);
      if (k === 0) this.box(podium ? t : r, y1);
      if (k < fr.length - 1) {
        this.flatRoof(t, y1, trim, 0.5);
        t = inset(t, clamp(Math.min(t.x1 - t.x0, t.z1 - t.z0) * 0.11, 1.6, 3.4));
      }
      y = y1;
    }
    this.flatRoof(t, y, trim, 1);
    this.clutter(t, y, rng, true);
    const mx = lerp(t.x0 + 2, t.x1 - 2, rng.next()), mz = lerp(t.z0 + 2, t.z1 - 2, rng.next());
    if (H > 84) this.mast(mx, y, mz, rng.range(9, 18), true);
    else if (rng.chance(0.4)) this.mast(mx, y, mz, rng.range(5, 9), false);
  }

  /** Brick-and-stone tower from before the glass: setbacks, belt courses, a water tank. `crown` adds the mustard cap of the signature one. */
  private oldTower(L: LotCtx, r: Rect, H: number, crown: boolean): void {
    const rng = L.rng, tint = crown ? 0xb5563f : rng.pick(BRICKS), F = 3.3;
    let y = this.base(L, r, STONE), t = inset(r, 0.3);
    const top = y + Math.round((H - 4.4) / F) * F, fr = crown ? [0.4, 0.6, 0.76, 0.89, 1] : rng.chance(0.5) ? [0.62, 0.85, 1] : [0.7, 1];
    const y00 = y;
    for (let k = 0; k < fr.length; k++) {
      const y1 = k === fr.length - 1 ? top : y00 + Math.round(((top - y00) * fr[k]) / F) * F;
      this.b('f1').walls(t.x0, t.z0, t.x1, t.z1, y, y1, tint, 3.4, F, 8, L.i);
      this.piers(t, y, y1, STONE, 1.1);
      this.ring(t, y1 - 0.5, 0.5, 0.22, STONE);
      if (k === 0) this.box(r, y1);
      this.flatRoof(t, y1, STONE, k === fr.length - 1 ? 0.9 : 0.6);
      if (k < fr.length - 1) t = inset(t, clamp(Math.min(t.x1 - t.x0, t.z1 - t.z0) * (crown ? 0.085 : 0.1), 1.4, 3.6));
      y = y1;
    }
    if (crown) {
      const c = inset(t, 1.2);
      this.pyramid(c, y, 10, MUST);
      this.mast((c.x0 + c.x1) / 2, y + 9.4, (c.z0 + c.z1) / 2, 10, true);
    } else {
      this.clutter(t, y, rng, false);
      this.waterTank(lerp(t.x0 + 3, t.x1 - 3, rng.next()), y, lerp(t.z0 + 3, t.z1 - 3, rng.next()), 1.15);
      if (H > 76) this.beacon(t.x0 + 1, y + 2, t.z0 + 1);
    }
  }

  /** Glass tower with its corners cut off. `wedge` gives the signature one its slanted crown. */
  private chamferTower(L: LotCtx, r: Rect, H: number, wedge: boolean): void {
    const rng = L.rng, tint = wedge ? 0x8fd0c4 : rng.pick(GLASS), trim = wedge ? 0x24454a : rng.pick([STONE, 0x33435f, 0x2c5d5a]);
    const y = this.base(L, r, wedge ? 0xc9c2b2 : STONE), t = inset(r, 0.4);
    const c = Math.min(t.x1 - t.x0, t.z1 - t.z0) * rng.range(0.17, 0.27), top = y + Math.round((H - 4.4) / 3.6) * 3.6;
    const oct = (q: Rect, k: number): number[] => [q.x0 + k, q.z1, q.x1 - k, q.z1, q.x1, q.z1 - k, q.x1, q.z0 + k, q.x1 - k, q.z0, q.x0 + k, q.z0, q.x0, q.z0 + k, q.x0, q.z1 - k];
    this.prism('f0', oct(t, c), y, top, tint, 3.4, 3.6, L.i, 0x8d877b);
    for (let by = y + 28.8; by < top - 6; by += 28.8) this.prism('flat', oct(inset(t, -0.12), c), by, by + 0.5, trim, 9, 9, 0);
    this.box(t, top);
    const q = inset(t, c * 0.55), mx = (q.x0 + q.x1) / 2, mz = (q.z0 + q.z1) / 2;
    if (wedge) {
      // A single slope the full width of the tower, high side to the north so it catches the sun from the sea.
      const b = this.b('flat'), rise = 17, w = inset(t, c * 0.3);
      b.quad(w.x0, top, w.z1, w.x1, top, w.z1, w.x1, top + rise, w.z0, w.x0, top + rise, w.z0, 0x1d2c4d);
      b.quad(w.x1, top, w.z0, w.x0, top, w.z0, w.x0, top + rise, w.z0, w.x1, top + rise, w.z0, 0x9fc9c2, 0, 0, 1, 1, 0.8);
      b.tri(w.x1, top, w.z1, w.x1, top, w.z0, w.x1, top + rise, w.z0, 0x9fc9c2, 0.95);
      b.tri(w.x0, top, w.z0, w.x0, top, w.z1, w.x0, top + rise, w.z0, 0x9fc9c2, 0.7);
      this.mast(w.x1 - 1.5, top + rise - 1, w.z0 + 0.6, 12, true);
      this.beacon(w.x0 + 1, top + rise + 0.6, w.z0 + 0.6);
    } else {
      this.prism('flat', oct(q, c * 0.4), top, top + 4.2, 0x77746c, 9, 9, 0, 0x5c5952);
      this.clutter(inset(q, 1), top + 4.2, rng, true);
      if (H > 84) this.mast(mx, top + 4.2, mz, rng.range(8, 14), true);
    }
  }

  /** The summit of the skyline: four setbacks, a verdigris pyramid and a spire. */
  private tallest(L: LotCtx, r: Rect): void {
    let y = this.base(L, r, 0xe6dcc6), t = inset(r, 0.3);
    const m = Math.min(t.x1 - t.x0, t.z1 - t.z0), navy = 0x2b3a5c;
    this.b('f0').walls(t.x0, t.z0, t.x1, t.z1, y, y + 10.8, 0x8fa3c8, 3.4, 3.6, 8, 3);
    y += 10.8;
    this.flatRoof(t, y, STONE, 0.8);
    this.box(r, y + 0.8);
    const tops = [79.2, 115.2, 140.4, 154.8], ins = [0.09, 0.08, 0.07, 0.06];
    for (let k = 0; k < 4; k++) {
      t = inset(t, m * ins[k]);
      const y1 = CURB + 4.4 + tops[k];
      this.b('f0').walls(t.x0, t.z0, t.x1, t.z1, y, y1, BONE, 3.4, 3.6, 8, 5);
      this.piers(t, y, y1 + 1.6, navy, 1.3);
      for (let by = y + 21.6; by < y1 - 6; by += 21.6) this.ring(t, by, 0.6, 0.12, navy);
      this.ring(t, y1 - 0.7, 0.7, 0.2, STONE);
      this.ground('gravel', t, y1, 0xffffff);
      if (k === 0) this.box(t, y1);
      if (k === 1) for (const x of [t.x0 + 0.6, t.x1 - 0.6]) for (const z of [t.z0 + 0.6, t.z1 - 0.6]) this.beacon(x, y1 + 2.4, z);
      y = y1;
    }
    this.pyramid(inset(t, 0.5), y, 13, VERDIGRIS);
    this.mast((t.x0 + t.x1) / 2, y + 12.4, (t.z0 + t.z1) / 2, 24, true);
    this.site('tallest', frameOf(r, L.lot.face), L.lot.face);
  }

  /** The round one. */
  private bollard(L: LotCtx, r: Rect): void {
    const y = this.base(L, r, 0xc9c2b2), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    this.flatRoof(r, y, STONE, 0.6);
    this.box(r, y + 0.6);
    const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2 - 1.5, top = y + 104.4, N = 20;
    const circle = (rad: number): number[] => {
      const p: number[] = [];
      for (let i = 0; i < N; i++) { const a = ((i + 0.5) / N) * Math.PI * 2; p.push(cx + Math.sin(a) * rad, cz + Math.cos(a) * rad); }
      return p;
    };
    this.prism('f0', circle(R), y, top, 0x8fd0c4, 3.4, 3.6, L.i, 0x8d877b);
    for (let by = y + 25.2; by < top; by += 25.2) this.prism('flat', circle(R + 0.14), by, by + 0.6, BONE, 9, 9, 0);
    this.prism('flat', circle(R + 0.25), top, top + 1.2, BONE, 9, 9, 0, BONE);
    const b = this.b('flat');
    b.cyl(cx, top + 1.2, cz, R * 0.9, R * 0.62, R * 0.36, VERDIGRIS, N, false);
    b.cyl(cx, top + 1.2 + R * 0.36, cz, R * 0.62, R * 0.12, R * 0.22, VERDIGRIS, N, true, 0.9);
    this.mast(cx, top + 1.2 + R * 0.58, cz, 14, true);
    this.game.col.addBoxC(cx, cz, R * 1.8, R * 1.8, top);
  }

  /** Two slabs on one podium, joined by a bridge. */
  private twin(L: LotCtx, r: Rect): void {
    let y = this.base(L, r, STONE);
    const t = inset(r, 0.3), navy = 0x33435f;
    this.b('f0').walls(t.x0, t.z0, t.x1, t.z1, y, y + 7.2, 0xcfe0e4, 3.4, 3.6, 8, 2);
    y += 7.2;
    this.flatRoof(t, y, STONE, 0.6);
    this.box(r, y + 0.6);
    const side = t.x1 - t.x0 >= t.z1 - t.z0 ? 2 : 1, f = frameOf(t, side), a = f.len * 0.4;
    const slabs = [cut(t, side, 1.5, a, 2, f.depth - 2), cut(t, side, f.len - a, f.len - 1.5, 2, f.depth - 2)];
    const hs = [93.6, 79.2], tints = [0x8fa3c8, 0xcfe0e4];
    slabs.forEach((s, k) => {
      const y1 = y + hs[k];
      this.b('f0').walls(s.x0, s.z0, s.x1, s.z1, y, y1, tints[k], 3.4, 3.6, 8, L.i + k);
      this.piers(s, y, y1 + 0.8, navy, 1);
      this.flatRoof(s, y1, navy, 1);
      this.clutter(s, y1, L.rng, true);
      this.box(s, y1);
      this.mast((s.x0 + s.x1) / 2, y1, (s.z0 + s.z1) / 2, k ? 8 : 14, true);
    });
    const br = cut(t, side, a - 0.2, f.len - a + 0.2, f.depth / 2 - 2.2, f.depth / 2 + 2.2);
    this.b('flat').box((br.x0 + br.x1) / 2, y + 50.4, (br.z0 + br.z1) / 2, br.x1 - br.x0, 4.2, br.z1 - br.z0, navy, 0, 7);
    this.ring(br, y + 51.6, 1.6, 0.06, 0x9fb9c4);
  }

  /** City hall annex: limestone, a portico, a small green dome, and the councilwoman's name over the door. */
  private civic(L: LotCtx, r: Rect): void {
    const face = L.lot.face, f0 = frameOf(r, face), body = cut(r, face, 0, f0.len, 5.2, f0.depth), f = frameOf(body, face);
    const b = this.b('flat'), py = CURB + 1.2, top = py + 3.3 * 5, mid = f.len / 2, pw = Math.min(f.len * 0.62, 22);
    b.box((body.x0 + body.x1) / 2, 0, (body.z0 + body.z1) / 2, body.x1 - body.x0, py, body.z1 - body.z0, STONE, 0, 4, 0.9);
    this.b('f1').walls(body.x0, body.z0, body.x1, body.z1, py, top, 0xe9dfc8, 3.4, 3.3, 8, 4);
    this.piers(body, py, top, STONE, 1.4);
    this.ring(body, py - 0.25, 0.25, 0.14, STONE);
    this.ring(body, top - 0.7, 0.7, 0.3, STONE);
    this.flatRoof(body, top, STONE, 1);
    const cx = (body.x0 + body.x1) / 2, cz = (body.z0 + body.z1) / 2, R = Math.min(body.x1 - body.x0, body.z1 - body.z0) * 0.2;
    b.cyl(cx, top, cz, R, R, 3.2, STONE, 14, false);
    b.cyl(cx, top + 3.2, cz, R * 1.04, R * 0.7, R * 0.5, VERDIGRIS, 14, false);
    b.cyl(cx, top + 3.2 + R * 0.5, cz, R * 0.7, R * 0.1, R * 0.34, VERDIGRIS, 14, true, 0.9);
    this.mast(cx, top + 3.2 + R * 0.84, cz, 7, false);
    // Portico: three steps, six columns, an entablature carrying the sign, a pediment.
    for (let k = 0; k < 3; k++) lbox(b, f, mid, 2.5 - k * 0.3, CURB + k * 0.4 - (k ? 0 : CURB), pw - k * 0.8, 5 - k * 0.6, k ? 0.4 : 0.4 + CURB, STONE, 5, 1 - k * 0.04);
    for (let k = 0; k < 6; k++) b.cyl(PX(f, mid - pw / 2 + 1.6 + (k * (pw - 3.2)) / 5, 3.1), py, PZ(f, mid - pw / 2 + 1.6 + (k * (pw - 3.2)) / 5, 3.1), 0.52, 0.44, 8.4, 0xf4ecd8, 10, false);
    const ey = py + 8.4;
    lbox(b, f, mid, 1.9, ey, pw - 1.4, 3.8, 1.7, STONE, 7);
    this.signBoard(f, 'vance-office', mid - 2.9, ey + 0.14, 5.8, 3.82, false);
    const sl = mid - pw / 2 + 0.5, sr = mid + pw / 2 - 0.5, y0 = ey + 1.7, y1 = y0 + 2.7, o = 3.8;
    b.tri(PX(f, sl, o), y0, PZ(f, sl, o), PX(f, sr, o), y0, PZ(f, sr, o), PX(f, mid, o), y1, PZ(f, mid, o), 0xe9dfc8);
    b.quad(PX(f, sl, o), y0, PZ(f, sl, o), PX(f, mid, o), y1, PZ(f, mid, o), PX(f, mid, 0), y1, PZ(f, mid, 0), PX(f, sl, 0), y0, PZ(f, sl, 0), 0x8d877b);
    b.quad(PX(f, mid, o), y1, PZ(f, mid, o), PX(f, sr, o), y0, PZ(f, sr, o), PX(f, sr, 0), y0, PZ(f, sr, 0), PX(f, mid, 0), y1, PZ(f, mid, 0), 0x8d877b, 0, 0, 1, 1, 0.85);
    for (const ds of [-2.4, 0, 2.4]) this.kitPiece(f, 'door', mid + ds - 0.6, py, 0xd9c9a8);
    this.box(body, top + 1);
    this.box(cut(r, face, mid - pw / 2, mid + pw / 2, 0.2, 5.2), y1);
    this.site('vance', f0, face);
  }

  // ── Tinker Row ─────────────────────────────────────────────────────────────

  private midtown(L: LotCtx): void {
    const { rng, lot } = L;
    if (lot.interior) { this.court(L); return; }
    const st = L.street, R = L.r;
    const r: Rect = { x0: R.x0 + (st[3] ? 0.4 : 0.3), x1: R.x1 - (st[1] ? 0.4 : 0.3), z0: R.z0 + (st[0] ? 0.4 : 0.3), z1: R.z1 - (st[2] ? 0.4 : 0.3) };
    const floors = rng.int(4, 9), gf = 3.6, F = 3.3, top = CURB + gf + (floors - 1) * F;
    const tint = rng.pick(MIDBRICK), trim = rng.chance(0.65) ? STONE : 0x5a4a42;
    this.b('flat').box((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2, r.x1 - r.x0, CURB + gf, r.z1 - r.z0, tint, 0, 4, 0.82);
    for (let k = 0; k < 4; k++) {
      const f = frameOf(r, k);
      if (st[k]) this.shopRow(L, f, 0.3, f.len - 0.3, CURB, tint, k === lot.face ? 0.5 : 0.3);
      else if (f.len > 6) this.kitPiece(f, 'doorSteel', rng.range(1, f.len - 2.4), CURB, 0xc9c6bb);
    }
    this.b('f1').walls(r.x0, r.z0, r.x1, r.z1, CURB + gf, top, tint, 3.4, F, 8, L.i);
    this.ring(r, CURB + gf - 0.04, 0.24, 0.1, trim);
    this.ring(r, top - 0.5, 0.5, 0.2, trim);
    this.flatRoof(r, top, rng.chance(0.5) ? tint : rng.pick([0x5a5d60, 0x6d7a63, 0x8a8478, 0x4a4d52]), 0.75);
    this.clutter(r, top, rng, false);
    if (rng.chance(0.3)) this.waterTank(lerp(r.x0 + 3, r.x1 - 3, rng.next()), top, lerp(r.z0 + 3, r.z1 - 3, rng.next()));
    const ff = frameOf(r, lot.face);
    if (this.opt(rng, 0.6) && ff.len > 9) this.fireEscape(ff, rng.range(1.5, ff.len - 4.5), floors, gf, F);
    this.box(r, top + 0.75);
  }

  // ── Fishbone ───────────────────────────────────────────────────────────────

  private oldtown(L: LotCtx): void {
    const { rng, lot } = L;
    if (lot.interior) { this.court(L); return; }
    const f = frameOf(L.r, lot.face), n = Math.max(1, Math.floor(f.len / rng.range(5.6, 7.8)));
    const cuts: number[] = [0];
    for (let k = 1; k < n; k++) cuts.push((f.len / n) * k + rng.range(-0.7, 0.7));
    cuts.push(f.len);
    const alongX = f.tx !== 0;
    for (let k = 0; k < n; k++) {
      const s0 = cuts[k], s1 = cuts[k + 1], w = s1 - s0;
      const setback = rng.range(0.3, 1.3), dep = Math.min(f.depth - setback - rng.range(0.6, 4), rng.range(8, 12.5));
      const hr = cut(L.r, lot.face, s0, s1, setback, setback + dep), hf = frameOf(hr, lot.face);
      const floors = rng.int(2, 4), gf = 3.4, F = 3.2, top = CURB + gf + (floors - 1) * F;
      const brick = rng.chance(0.3), tint = brick ? rng.pick(BRICKS) : rng.pick(STUCCO);
      this.b('flat').box((hr.x0 + hr.x1) / 2, 0, (hr.z0 + hr.z1) / 2, hr.x1 - hr.x0, CURB + gf, hr.z1 - hr.z0, tint, 0, 4, 0.9);
      this.b(brick ? 'f1' : 'f2').walls(hr.x0, hr.z0, hr.x1, hr.z1, CURB + gf, top, tint, brick ? 3.4 : 3.2, brick ? 3.3 : F, 8, L.i + k);
      // Ground floor: a shop or a front door, centered; the plain wall shows either side.
      const ps = (w - 4) / 2, shop = rng.chance(0.5), sign = shop && rng.chance(0.75) ? this.dealSign(lot.block) : null;
      const hang = rng.chance(0.4), hname = rng.pick(this.mats.tex.signs.hanging), aw = rng.chance(0.5), acol = rng.pick(AWN);
      if (w >= 4.2) {
        this.kitPiece(hf, shop ? 'shop' + rng.int(0, 3) : 'rowhouse' + rng.int(0, 1), ps, CURB, shop ? rng.pick(SHOPFRONT) : tint);
        if (sign) this.signBoard(hf, sign, ps + 0.4, CURB + 2.98, 3.2, 0.1);
        if (shop && aw) this.awning(hf, ps + 0.15, ps + 3.85, CURB + (sign ? 2.94 : 3.05), 0.5, 1.05, acol, true);
        if (shop && hang) this.hangSign(hf, ps + 0.1, CURB + 3.5, hname);
      }
      this.ring(hr, CURB + gf - 0.03, 0.16, 0.07, STONE, 0.9);
      this.ring(hr, CURB, 0.6, 0.05, 0x6f625a, 0.85);   // plinth: the walls stop looking like they were poured from the sidewalk
      if (w < 4.2 && w > 1.8) this.kitPiece(hf, 'door', (w - 1.2) / 2, CURB, tint);
      // Roof: ridge along the street, gable to the street, or a flat with a parapet.
      const kind = rng.next(), rise = rng.range(1.7, 3.1);
      if (kind < 0.62) this.gable('tile', hr, top, rise, alongX, 0.35, 0xffffff, tint, rng.range(0.82, 1));
      else if (kind < 0.86) this.gable('tile', hr, top, rise * 1.15, !alongX, 0.35, 0xffffff, tint, rng.range(0.82, 1));
      else this.flatRoof(hr, top, tint, 0.8);
      if (rng.chance(0.7)) {
        const cs = rng.range(0.8, w - 0.8), b = this.b('flat');
        lbox(b, hf, cs, -dep * rng.range(0.3, 0.7), top, 0.7, 0.7, rise + 1, BRICK, 5, 0.9);
      }
      this.box(hr, top + rise * 0.6);
    }
  }

  // ── Gull Heights ───────────────────────────────────────────────────────────

  private suburb(L: LotCtx): void {
    const { rng, lot } = L, r = this.fit(L.r);
    if (!r) return;
    this.ground('grass', r, GY, 0xffffff, 8, rng.range(0.88, 1.02));
    const face = lot.face, f = frameOf(r, face), len = f.len, depth = f.depth;
    if (lot.interior || len < 16 || depth < 16) { this.garden(L, r); return; }
    const two = rng.chance(0.42), gLeft = rng.chance(0.5), fs = clamp(depth * 0.24, 4.5, 7.5), gw = 4.4;
    const hw = clamp(len - gw - rng.range(5, 8), 7.5, 12.5), hd = clamp(depth - fs - rng.range(5, 9), 6.6, 9.5);
    const s0 = clamp((len - hw - gw) / 2 + rng.range(-1, 1), 1, len - hw - gw - 1);
    const hs = gLeft ? s0 + gw : s0, gs = gLeft ? s0 : s0 + hw;
    const hr = cut(r, face, hs, hs + hw, fs, fs + hd), gr = cut(r, face, gs, gs + gw, fs + 1, fs + 7);
    const tint = rng.pick(SIDING), roof = rng.pick(SHINGLES), trim = 0xffffff;
    const wallH = two ? 5.8 : 3.1, yT = CURB + wallH, hf = frameOf(hr, face), b = this.b('flat');
    this.siding(hr, CURB, yT, tint);
    const ridgeAlong = rng.chance(0.7) ? f.tx !== 0 : f.tx === 0, rise = rng.range(2.1, 3.1);
    this.gable('shingle', hr, yT, rise, ridgeAlong, 0.45, roof, tint);
    // Front: door on a porch, windows either side and above.
    const sd = clamp(hw * rng.range(0.3, 0.7), 2.2, hw - 2.2);
    this.kitPiece(hf, 'door', sd - 0.6, CURB + 0.3, trim);
    for (const ws of [0.7, hw - 2.2]) if (Math.abs(ws + 0.75 - sd) > 2.3) this.kitPiece(hf, 'window', ws, CURB + 1.1, trim);
    if (two) for (const ws of [0.7, hw / 2 - 0.75, hw - 2.2]) this.kitPiece(hf, 'window', ws, CURB + 3.9, trim);
    lbox(b, hf, sd, 0.95, CURB, 3.6, 1.9, 0.3, 0xcfc6b2, 5);
    lbox(b, hf, sd, 2.1, CURB, 1.4, 0.4, 0.15, 0xcfc6b2, 5);
    for (const e of [-1.65, 1.65]) lbox(b, hf, sd + e, 1.75, CURB + 0.3, 0.14, 0.14, 2.35, trim, 4);
    slope(this.b('shingle'), hf, sd - 2, sd + 2, CURB + 2.6, 2.1, CURB + 3.0, 0.02, roof, { u0: 0, v0: 0, u1: 1, v1: 0.55 });
    // Sides and back.
    const gSide = (face + (gLeft ? 1 : 3)) & 3;
    for (let k = 0; k < 4; k++) {
      if (k === face) continue;
      const sf = frameOf(hr, k);
      for (const t of [0.26, 0.74]) {
        if (k !== gSide) this.kitPiece(sf, rng.chance(0.8) ? 'window' : 'windowDark', sf.len * t - 0.75, CURB + 1.1, trim);
        if (two) this.kitPiece(sf, 'window', sf.len * t - 0.75, CURB + 3.9, trim);
      }
    }
    lbox(b, hf, rng.range(1, hw - 1), -hd * 0.5, yT, 0.7, 0.7, rise + 0.9, BRICK, 5, 0.9);
    // Garage, drive and front walk.
    this.siding(gr, CURB, CURB + 3.3, tint);
    this.gable('shingle', gr, CURB + 3.3, 1.1, f.tx === 0, 0.3, roof, tint);
    this.kitPiece(frameOf(gr, face), 'garage', 0.4, CURB, trim);
    this.ground('decal', cut(r, face, gs + 0.3, gs + gw - 0.3, 0, fs + 1), GY, CONC);
    this.ground('decal', cut(r, face, hs + sd - 0.55, hs + sd + 0.55, 0, fs - 2.2), GY, 0xc9c2b2);
    this.box(hr, yT + rise * 0.6);
    this.box(gr, CURB + 3.6);
    // Boundary: picket, hedge or open lawn. Only the front and one side, so neighbours do not double up.
    const edge = rng.next(), gaps: [number, number][] = [[gs, gs + gw], [hs + sd - 0.9, hs + sd + 0.9]];
    gaps.sort((p, q) => p[0] - q[0]);
    const runs: [number, number][] = [[0.3, gaps[0][0]], [gaps[0][1], gaps[1][0]], [gaps[1][1], len - 0.3]];
    const sideF = frameOf(r, (face + 1) & 3);
    if (edge < 0.36) {
      for (const [a, c] of runs) this.fence('picket', f, a, c, -0.3);
      this.fence('picket', sideF, 0.3, sideF.len - 0.3, -0.25);
    } else if (edge < 0.66) {
      for (const [a, c] of runs) if (c - a > 1) lbox(b, f, (a + c) / 2, -0.7, CURB, c - a, 0.8, 1.05, HEDGE, 5, rng.range(0.85, 1.05));
      lbox(b, sideF, sideF.len / 2, -0.55, CURB, sideF.len - 1, 0.7, 1.2, HEDGE, 5, 0.92);
    }
    // Back yard.
    const yard = depth - fs - hd;
    if (this.opt(rng, 0.38) && yard > 6) {
      const sh = cut(r, face, len - 4.4, len - 1.4, depth - 4.2, depth - 1.4);
      this.siding(sh, CURB, CURB + 2.3, 0xb9a184);
      this.gable('shingle', sh, CURB + 2.3, 0.9, f.tx !== 0, 0.2, roof, 0xb9a184);
      this.kitPiece(frameOf(sh, face), 'door', 0.9, CURB, 0xd9d2c0);
      this.box(sh, CURB + 2.8);
    }
    if (this.opt(rng, 0.2) && yard > 8.5) this.pool(PX(f, 4.6, -(depth - 4.4)), PZ(f, 4.6, -(depth - 4.4)));
  }

  private pool(x: number, z: number): void {
    const b = this.b('flat');
    b.cyl(x, CURB, z, 2.5, 2.5, 1.2, 0xe9e4d8, 16, false);
    b.cyl(x, CURB, z, 2.38, 2.38, 1.05, 0x4fb3b0, 16, true);
    b.box(x + 2.75, CURB, z, 0.5, 1.2, 0.7, 0xd9d2c0, 0, 5);
    this.game.col.addBoxC(x, z, 4.4, 4.4, CURB + 1.2);
  }

  /** A lot too small or too hidden for a house: vegetable beds, a shed, perhaps a pool. */
  private garden(L: LotCtx, r: Rect): void {
    const rng = L.rng, b = this.b('flat'), q = inset(r, 1.2), w = q.x1 - q.x0, d = q.z1 - q.z0;
    this.parapet(q, CURB, 1.1, 0.7, HEDGE, 0.95);
    const n = Math.floor((w - 4) / 2.6);
    for (let k = 0; k < n; k++) {
      const x = q.x0 + 2.4 + k * 2.6, z1 = q.z0 + d * 0.5;
      b.box(x, CURB, (q.z0 + 2 + z1) / 2, 1.5, 0.35, z1 - q.z0 - 2, 0x7a5a44, 0, 5);
      b.box(x, CURB + 0.35, (q.z0 + 2 + z1) / 2, 1.2, 0.3, z1 - q.z0 - 2.4, rng.pick([0x6f9a55, 0x88a85e, 0x557a48]), 0, 5);
    }
    if (d > 12 && w > 9) {
      const sh: Rect = { x0: q.x1 - 4.6, x1: q.x1 - 1.4, z0: q.z1 - 4.4, z1: q.z1 - 1.4 };
      this.siding(sh, CURB, CURB + 2.3, 0xb9a184);
      this.gable('shingle', sh, CURB + 2.3, 0.9, true, 0.2, rng.pick(SHINGLES), 0xb9a184);
      this.box(sh, CURB + 2.8);
      if (w > 14 && this.opt(rng, 0.6)) this.pool(q.x0 + 4.4, q.z1 - 4.4);
    }
  }

  // ── The Cannery ────────────────────────────────────────────────────────────

  private industrial(L: LotCtx): void {
    const { rng, lot } = L;
    if (L.kind === 'marlowe') { this.towYard(L); return; }
    const r = this.fit(L.r);
    if (!r) return;
    const face = lot.face, f = frameOf(r, face), p = rng.next();
    if (lot.interior || p > 0.76 || f.len < 24 || f.depth < 24) { this.tankFarm(L, r); return; }
    const sr = cut(r, face, 2, f.len - 2, rng.range(6, 9), f.depth - 2), ff = frameOf(sr, face);
    const H = 4.5 * rng.int(2, 3), top = CURB + H, tint = rng.pick(METAL), b = this.b('flat');
    this.b('f3').walls(sr.x0, sr.z0, sr.x1, sr.z1, CURB, top, tint, 4.5, 4.5, 8, L.i);
    b.box((sr.x0 + sr.x1) / 2, 0, (sr.z0 + sr.z1) / 2, sr.x1 - sr.x0 + 0.3, CURB + 0.7, sr.z1 - sr.z0 + 0.3, 0x8d8a82, 0, 5);
    // Loading side: docks under a canopy, roller doors, a staff door.
    for (let s = 2.5; s + 6 < ff.len - 3;) {
      if (rng.chance(0.62)) {
        this.kitPiece(ff, 'dock', s, CURB, tint, 0.2);
        slope(this.b('corr'), ff, s - 0.4, s + 6.4, CURB + 4.1, 2.6, CURB + 4.6, 0.2, 0xd9d4c8, { u0: 0, v0: 0, u1: 1.7, v1: 0.66 });
        for (const e of [0, 6]) lbox(b, ff, s + e, 2.4, CURB, 0.14, 0.14, 4.1, IRON, 4);
      } else this.kitPiece(ff, 'roller', s + 1.5, CURB, tint, 0.2);
      s += 6 + rng.range(2, 5);
    }
    this.kitPiece(ff, 'doorSteel', ff.len - 1.9, CURB, 0xc9c6bb, 0.2);
    if (p < 0.5) this.sawtooth(sr, top, tint);
    else {
      this.flatRoof(sr, top, tint, 0.6);
      const long = sr.x1 - sr.x0 >= sr.z1 - sr.z0, mx = (sr.x0 + sr.x1) / 2, mz = (sr.z0 + sr.z1) / 2;
      // A monitor skylight down the spine.
      b.box(mx, top, mz, long ? (sr.x1 - sr.x0) * 0.7 : 4, 1.6, long ? 4 : (sr.z1 - sr.z0) * 0.7, 0x49696f, 0, 4);
      b.box(mx, top + 1.6, mz, long ? (sr.x1 - sr.x0) * 0.7 + 0.6 : 4.6, 0.2, long ? 4.6 : (sr.z1 - sr.z0) * 0.7 + 0.6, 0xbdb8aa, 0, 7);
    }
    if (rng.chance(0.45)) {
      const cx = lerp(sr.x0 + 3, sr.x1 - 3, rng.next()), cz = lerp(sr.z0 + 3, sr.z1 - 3, rng.next()), h = H + rng.range(12, 22);
      b.cyl(cx, CURB, cz, 1.5, 1.05, h, BRICK, 10, false);
      b.cyl(cx, CURB + h, cz, 1.2, 1.15, 0.9, 0x3d3a37, 10, true);
      if (h > 30) this.beacon(cx, CURB + h + 1.6, cz);
    }
    // Something left out on the apron.
    const n = rng.int(0, 3);
    for (let k = 0; k < n; k++) {
      const s = rng.range(1, ff.len - 3), on = this.opt(rng, 1), hex = rng.pick([0xb99a6a, 0xa9895c, TEAL, 0x7a8a8a]), h = rng.range(1, 2.4);
      if (!on) continue;
      lbox(b, ff, s + 0.9, 4.2, CURB, 1.8, 1.4, h, hex, 5);
      const c = cut(sr, face, s, s + 1.8, -4.9, -3.5);
      this.box(c, CURB + h);
    }
    this.box(sr, top + 1.5);
  }

  /** North-light roof: a row of teeth, each a corrugated slope and an upright strip of glass. */
  private sawtooth(r: Rect, y: number, tint: number): void {
    const c = this.b('corr'), b = this.b('flat'), w = r.x1 - r.x0, d = r.z1 - r.z0, alongX = w >= d;
    const long = alongX ? w : d, n = Math.max(2, Math.round(long / 7.5)), step = long / n, rise = 2.5, glass = 0x49696f;
    const v = Math.hypot(step, rise) / 4;
    for (let k = 0; k < n; k++) {
      if (alongX) {
        const xa = r.x0 + k * step, xb = xa + step;
        b.quad(xa, y, r.z0, xa, y, r.z1, xa, y + rise, r.z1, xa, y + rise, r.z0, glass, 0, 0, 1, 1, 0.9);
        c.quad(xb, y, r.z1, xb, y, r.z0, xa, y + rise, r.z0, xa, y + rise, r.z1, 0xd9d4c8, 0, 0, d / 4, v);
        b.tri(xa, y, r.z1, xb, y, r.z1, xa, y + rise, r.z1, tint, 0.85);
        b.tri(xb, y, r.z0, xa, y, r.z0, xa, y + rise, r.z0, tint, 0.7);
      } else {
        const za = r.z0 + k * step, zb = za + step;
        b.quad(r.x1, y, za, r.x0, y, za, r.x0, y + rise, za, r.x1, y + rise, za, glass, 0, 0, 1, 1, 0.9);
        c.quad(r.x0, y, zb, r.x1, y, zb, r.x1, y + rise, za, r.x0, y + rise, za, 0xd9d4c8, 0, 0, w / 4, v);
        b.tri(r.x0, y, za, r.x0, y, zb, r.x0, y + rise, za, tint, 0.7);
        b.tri(r.x1, y, zb, r.x1, y, za, r.x1, y + rise, za, tint, 0.85);
      }
    }
  }

  private tankFarm(L: LotCtx, r: Rect): void {
    const rng = L.rng, b = this.b('flat'), q = inset(r, 2.2), w = q.x1 - q.x0, d = q.z1 - q.z0;
    if (w < 9 || d < 9) return;
    this.parapet(q, 0, CURB + 0.7, 0.35, CONC, 0.95);
    const cell = rng.range(11, 14), nx = Math.max(1, Math.floor(w / cell)), nz = Math.max(1, Math.floor(d / cell));
    const cw = w / nx, cd = d / nz, tints = [0xe6dfcc, 0x9fb3a4, 0xb98468, 0xd9d0b8];
    const tint = rng.pick(tints);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const cx = q.x0 + (i + 0.5) * cw, cz = q.z0 + (j + 0.5) * cd, roll = rng.next();
      const R = Math.min(cw, cd) * rng.range(0.27, 0.36), h = rng.range(6, 11);
      if (roll < 0.74) {
        b.cyl(cx, CURB, cz, R, R, h, rng.chance(0.75) ? tint : rng.pick(tints), 14, false);
        b.cyl(cx, CURB + h, cz, R, R * 0.12, R * 0.26, 0xbdb8aa, 14, true);
        b.cyl(cx, CURB + h * 0.62, cz, R + 0.06, R + 0.06, 0.35, 0x8a5a44, 14, false);
        b.box(cx + R + 0.12, CURB, cz, 0.24, h + 0.6, 0.5, IRON, 0, 5);
        this.game.col.addBoxC(cx, cz, R * 1.8, R * 1.8, CURB + h);
      } else if (roll < 0.9) {
        const hut: Rect = { x0: cx - 2.4, x1: cx + 2.4, z0: cz - 1.8, z1: cz + 1.8 };
        this.b('f3').walls(hut.x0, hut.z0, hut.x1, hut.z1, CURB, CURB + 4.5, rng.pick(METAL), 4.5, 4.5, 8, L.i + i);
        b.box(cx, CURB + 4.5, cz, 5.2, 0.25, 4, 0x8d877b, 0, 7);
        this.box(hut, CURB + 4.7);
      }
    }
    // Pipe rack down the gaps between the rows of tanks.
    const pipes = [0xe6dfcc, 0xb5563f, TEAL];
    if (nz > 1) for (let j = 1; j < nz; j++) {
      const z = q.z0 + j * cd;
      for (let x = q.x0 + 2; x < q.x1 - 1; x += 6) { b.box(x, CURB, z - 0.6, 0.18, 4.1, 0.18, IRON, 0, 4); b.box(x, CURB, z + 0.6, 0.18, 4.1, 0.18, IRON, 0, 4); b.box(x, CURB + 4.1, z, 0.2, 0.2, 1.6, IRON, 0, 7); }
      pipes.forEach((hex, k) => b.box((q.x0 + q.x1) / 2, CURB + 4.3, z - 0.45 + k * 0.45, w - 3, 0.3, 0.3, hex, 0, 7));
    } else if (nx > 1) for (let i = 1; i < nx; i++) {
      const x = q.x0 + i * cw;
      for (let z = q.z0 + 2; z < q.z1 - 1; z += 6) { b.box(x - 0.6, CURB, z, 0.18, 4.1, 0.18, IRON, 0, 4); b.box(x + 0.6, CURB, z, 0.18, 4.1, 0.18, IRON, 0, 4); b.box(x, CURB + 4.1, z, 1.6, 0.2, 0.2, IRON, 0, 7); }
      pipes.forEach((hex, k) => b.box(x - 0.45 + k * 0.45, CURB + 4.3, (q.z0 + q.z1) / 2, 0.3, 0.3, d - 3, hex, 0, 7));
    }
  }

  /** Marlowe Towing: Dess's yard, chained shut by the Harbor Authority. The story starts from wanting it back. */
  private towYard(L: LotCtx): void {
    const { rng, lot } = L, face = lot.face, r = inset(L.r, 0.6), f = frameOf(r, face), b = this.b('flat');
    this.ground('flat', r, GY, 0x6f6a61);
    const mid = f.len / 2, g0 = mid - 3.6, g1 = mid + 3.6, col = this.game.col;
    for (let k = 0; k < 4; k++) {
      const fk = frameOf(r, k);
      if (k !== face) { this.fence('chain', fk, 0, fk.len); continue; }
      this.fence('chain', fk, 0, g0); this.fence('chain', fk, g1, fk.len);
      this.fence('chain', fk, g0, g1, 0, CURB, 0xc9c2b2);
    }
    const t = 0.12;
    col.addBox(r.x0 - t, r.z0 - t, r.x1 + t, r.z0 + t, CURB + 2.4); col.addBox(r.x0 - t, r.z1 - t, r.x1 + t, r.z1 + t, CURB + 2.4);
    col.addBox(r.x0 - t, r.z0, r.x0 + t, r.z1, CURB + 2.4); col.addBox(r.x1 - t, r.z0, r.x1 + t, r.z1, CURB + 2.4);
    // Gate posts, the sign over the gate (readable from both sides) and the Authority's paperwork.
    for (const s of [g0, g1]) lbox(b, f, s, 0, CURB, 0.3, 0.3, 5.6, IRON, 5);
    const sy = CURB + 3.5, rc = this.mats.tex.signs.rect('marlowe-towing'), sw = 7.2, sh = sw / rc.aspect;
    lbox(b, f, mid, 0, sy - 0.08, sw + 0.16, 0.12, sh + 0.16, IRON, 7);
    panel(this.b('sign'), f, mid - sw / 2, mid + sw / 2, sy, sy + sh, 0.09, 0xffffff, rc);
    panel(this.b('sign'), { ...f, ox: PX(f, f.len, 0), oz: PZ(f, f.len, 0), tx: -f.tx, tz: -f.tz, nx: -f.nx, nz: -f.nz }, mid - sw / 2, mid + sw / 2, sy, sy + sh, 0.09, 0xffffff, rc);
    lbox(b, f, mid, 0.1, CURB + 0.95, 7, 0.08, 0.26, VERM, 7);
    lbox(b, f, mid, 0.1, CURB + 1.5, 7, 0.08, 0.12, BONE, 7);
    for (const s of [g0 - 1.7, g1 + 0.8]) this.signBoard(f, 'notice-seized', s, CURB + 0.95, 0.9, 0.05, true);
    // Inside: the office hut, the two-bay shed, and what was left when the gate was locked.
    const hut = cut(r, face, 2.5, 9.5, f.depth - 7.5, f.depth - 2.5);
    this.siding(hut, CURB, CURB + 3, 0xd9cfb4);
    b.box((hut.x0 + hut.x1) / 2, CURB + 3, (hut.z0 + hut.z1) / 2, hut.x1 - hut.x0 + 0.6, 0.25, hut.z1 - hut.z0 + 0.6, 0x77746c, 0, 7);
    const hf = frameOf(hut, face);
    this.kitPiece(hf, 'door', 1, CURB, 0xd9d2c0); this.kitPiece(hf, 'windowDark', 3.6, CURB + 1, 0xffffff);
    this.box(hut, CURB + 3.2);
    if (f.len > 30) {
      const shed = cut(r, face, f.len - 16, f.len - 2.5, f.depth - 11, f.depth - 2.5), sf = frameOf(shed, face);
      this.b('f3').walls(shed.x0, shed.z0, shed.x1, shed.z1, CURB, CURB + 4.5, 0x9fb3a4, 4.5, 4.5, 8, 2);
      this.kitPiece(sf, 'roller', 1.6, CURB, 0x9fb3a4, 0.2); this.kitPiece(sf, 'roller', 6.4, CURB, 0x9fb3a4, 0.2);
      slope(this.b('corr'), sf, -0.4, sf.len + 0.4, CURB + 4.5, 0.5, CURB + 5.6, -sf.depth - 0.4, 0xd9d4c8, { u0: 0, v0: 0, u1: sf.len / 4, v1: sf.depth / 4 });
      this.box(shed, CURB + 5);
    }
    for (let k = 0; k < 5; k++) {
      const x = PX(f, rng.range(3, f.len - 3), -rng.range(5, f.depth * 0.55)), z = PZ(f, rng.range(3, f.len - 3), -rng.range(5, f.depth * 0.55));
      const n = rng.int(2, 5);
      if (k < 3) for (let i = 0; i < n; i++) b.cyl(x, CURB + i * 0.24, z, 0.4, 0.4, 0.22, 0x26282b, 8);
      else b.cyl(x, CURB, z, 0.3, 0.3, 0.9, k === 3 ? TEAL : VERM, 8);
    }
    // Impounded and left: cars and a wrecker under bone tarps, a tire stack, oil stains, and the Authority's tape across the bays.
    const alongX = f.tx !== 0;
    const lump = (cx: number, cz: number, len: number, wid: number, tarp: boolean, hex: number): void => {
      const lx = alongX ? len : wid, lz = alongX ? wid : len;
      b.box(cx, CURB, cz, lx, 0.8, lz, tarp ? BONE : hex, 0, 7, 0.96);
      b.box(cx, CURB + 0.8, cz, alongX ? len * 0.5 : wid * 0.92, 0.7, alongX ? wid * 0.92 : len * 0.5, tarp ? BONE : 0x9fb3a4, 0, 7, tarp ? 0.9 : 0.7);
      this.box({ x0: cx - lx / 2, x1: cx + lx / 2, z0: cz - lz / 2, z1: cz + lz / 2 }, CURB + 1.5);
    };
    const rows = [f.depth * 0.3, f.depth * 0.52];
    rows.forEach((dd, ri) => {
      for (let s = 4 + ri * 3; s < f.len - 18 && s < f.len; s += 6.2) {
        if (Math.abs(s + 2.2 - mid) < 5 || (ri && s < 11)) continue;
        const wrecker = rng.chance(0.25), tarp = rng.chance(0.55);
        lump(PX(f, s + 2.2, -dd), PZ(f, s + 2.2, -dd), wrecker ? 6.2 : 4.4, wrecker ? 2.3 : 1.9, tarp, wrecker ? MUST : rng.pick([VERM, TEAL, 0x6f7a86, 0xb98468]));
        if (!tarp) { const sx = PX(f, s + 2.2, -dd), sz = PZ(f, s + 2.2, -dd); b.box(sx, CURB + 0.2, sz, alongX ? 4.5 : 0.4, 0.04, alongX ? 0.4 : 4.5, 0x26282b, 0, 7); }
      }
    });
    const tx = PX(f, g0 - 3, -4), tz = PZ(f, g0 - 3, -4);
    for (let i = 0; i < 4; i++) b.cyl(tx, CURB + i * 0.24, tz, 0.42, 0.42, 0.22, 0x26282b, 8);
    this.box({ x0: tx - 0.5, x1: tx + 0.5, z0: tz - 0.5, z1: tz + 0.5 }, CURB + 1);
    for (let k = 0; k < 4; k++) {   // oil stains
      const ox = PX(f, rng.range(3, f.len - 3), -rng.range(3, f.depth * 0.6)), oz = PZ(f, rng.range(3, f.len - 3), -rng.range(3, f.depth * 0.6));
      this.ground('decal', { x0: ox - 0.9, x1: ox + 0.9, z0: oz - 0.7, z1: oz + 0.7 }, GY + 0.01, 0x2b2b2a);
    }
    lbox(b, hf, 2.4, 0.12, CURB + 1.3, 4.6, 0.03, 0.14, VERM, 7);   // seizure tape across the office door
    this.site('marlowe', f, face);
  }

  // ── Dock Seven ─────────────────────────────────────────────────────────────

  private port(L: LotCtx): void {
    const { rng, lot } = L, face = lot.face, r = inset(L.r, 2.5), f = frameOf(r, face);
    if (L.kind === 'office') {
      // Harbor office at the gate: clapboard, a flat roof, and the district's nameplate up on posts.
      const o = cut(r, face, 2, Math.min(f.len - 2, 26), 1, 11), of = frameOf(o, face), top = CURB + 6.6, b = this.b('flat');
      this.siding(o, CURB, top, 0xe9e1cc);
      this.kitPiece(of, 'door', of.len / 2 - 0.6, CURB, 0xbfd8d2);
      for (let s = 1.2; s + 1.5 < of.len - 1; s += 3.1) {
        if (Math.abs(s + 0.75 - of.len / 2) > 1.6) this.kitPiece(of, 'window', s, CURB + 1, 0xffffff);
        this.kitPiece(of, 'window', s, CURB + 4.1, 0xffffff);
      }
      this.ring(o, CURB + 3.2, 0.2, 0.08, TEAL);
      this.flatRoof(o, top, 0xe9e1cc, 0.6);
      this.clutter(o, top, rng, false);
      const sw = Math.min(of.len - 3, 10), sh = this.signBoard(of, 'dock-seven', of.len / 2 - sw / 2, top + 1.6, sw, 0.14);
      for (const e of [-sw / 2 + 0.6, sw / 2 - 0.6]) lbox(b, of, of.len / 2 + e, 0.05, top, 0.16, 0.16, 1.6 + sh, IRON, 4);
      this.box(o, top + 0.6);
      this.site('dockOffice', of, face);
      if (f.depth > 30) this.containers(cut(r, face, 0, f.len, 18, f.depth), rng);
      return;
    }
    const fr = this.fit(r);
    if (!lot.interior && fr && rng.chance(0.17) && Math.min(fr.x1 - fr.x0, fr.z1 - fr.z0) > 26) {
      const s = inset(fr, 2), sf = frameOf(s, face), top = CURB + 4.5 * rng.int(2, 3), tint = rng.pick(METAL);
      this.b('f3').walls(s.x0, s.z0, s.x1, s.z1, CURB, top, tint, 4.5, 4.5, 8, L.i);
      this.gable('corr', s, top, 2.6, s.x1 - s.x0 >= s.z1 - s.z0, 0.5, 0xd9d4c8, tint);
      for (let x = 3; x + 3 < sf.len - 3; x += rng.range(7, 10)) this.kitPiece(sf, 'roller', x, CURB, tint, 0.2);
      this.kitPiece(sf, 'doorSteel', sf.len - 2, CURB, 0xc9c6bb, 0.2);
      this.box(s, top + 1.3);
      return;
    }
    this.containers(r, rng);
  }

  /** Rows of stacked boxes with drive lanes between each pair of rows. Anything in a ramp's way is simply left out. */
  private containers(r: Rect, rng: RNG): void {
    const w = r.x1 - r.x0, d = r.z1 - r.z0, alongX = w >= d, long = alongX ? w : d, across = alongX ? d : w;
    const LEN = 12.2, WID = 2.44, H = 2.6, lane = 6.4, pitch = WID * 2 + 0.3 + lane;
    const nSlot = Math.floor((long + 0.5) / (LEN + 0.5)), nPair = Math.floor((across + lane) / pitch);
    if (nSlot < 1 || nPair < 1) return;
    const l0 = (long - (nSlot * (LEN + 0.5) - 0.5)) / 2, a0 = (across - (nPair * pitch - lane)) / 2;
    for (let p = 0; p < nPair; p++) for (let q = 0; q < 2; q++) for (let s = 0; s < nSlot; s++) {
      const roll = rng.next(), n = roll < 0.1 ? 0 : roll < 0.32 ? 1 : roll < 0.62 ? 2 : roll < 0.86 ? 3 : 4;
      const lc = l0 + s * (LEN + 0.5) + LEN / 2, ac = a0 + p * pitch + q * (WID + 0.3) + WID / 2;
      const cx = alongX ? r.x0 + lc : r.x0 + ac, cz = alongX ? r.z0 + ac : r.z0 + lc;
      const foot: Rect = alongX ? { x0: cx - LEN / 2, x1: cx + LEN / 2, z0: cz - WID / 2, z1: cz + WID / 2 } : { x0: cx - WID / 2, x1: cx + WID / 2, z0: cz - LEN / 2, z1: cz + LEN / 2 };
      const halves = n === 1 && rng.chance(0.35);
      let hex = rng.pick(BOXES);
      for (let k = 0; k < n; k++) {
        if (rng.chance(0.6)) hex = rng.pick(BOXES);
        const sh = rng.range(0.8, 1), named = rng.chance(0.5), flip = rng.chance(0.5), top = k === n - 1;
        if (this.clear.some((c) => hits(foot, c))) continue;
        if (halves) for (const e of [-1, 1]) this.container(alongX ? cx + e * 3.1 : cx, alongX ? cz : cz + e * 3.1, CURB, 6.06, alongX, e < 0 ? hex : rng.pick(BOXES), top, sh, named, flip);
        else this.container(cx, cz, CURB + k * H, LEN, alongX, hex, top, sh, named, flip);
      }
      if (n && !this.clear.some((c) => hits(foot, c))) this.box(foot, CURB + n * H);
    }
  }

  private container(cx: number, cz: number, y: number, len: number, alongX: boolean, hex: number, top: boolean, sh: number, named: boolean, flip: boolean): void {
    const b = this.b('cont'), hl = len / 2, hw = 1.22, H = 2.6, S = CONTAINER_UV.side;
    const r: Rect = alongX ? { x0: cx - hl, x1: cx + hl, z0: cz - hw, z1: cz + hw } : { x0: cx - hw, x1: cx + hw, z0: cz - hl, z1: cz + hl };
    const u0 = len < 8 && named ? 0.5 : 0, side: UV = { u0, v0: S.v0, u1: u0 + len / 12.2, v1: S.v1 };
    for (let k = 0; k < 4; k++) {
      const f = frameOf(r, k), isLong = alongX ? (k & 1) === 0 : (k & 1) === 1;
      panel(b, f, 0, f.len, y, y + H, 0, hex, isLong ? side : (k < 2) !== flip ? CONTAINER_UV.door : CONTAINER_UV.back, sh * (k === 0 || k === 3 ? 0.9 : 1));
    }
    if (!top) return;
    const R = CONTAINER_UV.roof, n = Math.round(len / 2.44), st = len / n, yT = y + H;
    for (let i = 0; i < n; i++) {
      if (alongX) {
        const xa = r.x0 + i * st, xb = xa + st;
        b.quad(xb, yT, r.z1, xb, yT, r.z0, xa, yT, r.z0, xa, yT, r.z1, hex, R.u0, R.v0, R.u1, R.v1, sh);
      } else {
        const za = r.z0 + i * st, zb = za + st;
        b.quad(r.x0, yT, zb, r.x1, yT, zb, r.x1, yT, za, r.x0, yT, za, hex, R.u0, R.v0, R.u1, R.v1, sh);
      }
    }
  }

  // ── Saltwater Strand ───────────────────────────────────────────────────────

  private strand(L: LotCtx): void {
    const { rng, lot } = L;
    if (lot.interior) { this.court(L); return; }
    const r = this.fit(L.r);
    if (!r) return;
    const f = frameOf(r, lot.face), end = f.len - 0.4;
    let s = 0.4, kind = L.kind;
    while (s < end - 5) {
      let w = kind === 'gus' ? Math.min(18, end - s) : kind === 'finch' ? Math.min(11, end - s) : rng.range(6.5, 10.5);
      if (end - (s + w) < 5.5) w = end - s;
      this.shack(L, r, s, s + w, kind);
      kind = '';
      s += w + (rng.chance(0.22) ? rng.range(0.9, 1.6) : 0);
    }
  }

  /** One boardwalk shop: painted clapboard, glass across the front, a striped awning and a false front to carry the sign. */
  private shack(L: LotCtx, r: Rect, s0: number, s1: number, kind: string): void {
    const { rng, lot } = L, face = lot.face, f = frameOf(r, face), w = s1 - s0, b = this.b('flat');
    const two = kind === 'gus' ? true : kind === 'finch' ? false : rng.chance(0.4);
    const dep = Math.min(f.depth - 1.5, rng.range(9, 14)), br = cut(r, face, s0, s1, 0.4, 0.4 + dep), fb = frameOf(br, face);
    const top = CURB + (two ? 6.9 : 3.9) + rng.range(0, 0.4);
    const tint = kind === 'gus' ? 0xe8674a : kind === 'finch' ? 0x7fbdb2 : rng.pick(BOARDWALK), accent = kind === 'gus' ? MUST : rng.pick(AWN);
    this.siding(br, CURB, top, tint);
    const n = Math.floor((w - 0.4) / 4), pad = (w - n * 4) / 2, front = kind === 'finch' ? 0xcfe0d6 : rng.pick(SHOPFRONT);
    for (let k = 0; k < n; k++) this.kitPiece(fb, 'shop' + rng.int(0, 3), pad + k * 4, CURB, front);
    if (n > 0) this.awning(fb, pad - 0.1, pad + n * 4 + 0.1, CURB + 3.2, 0.65, 1.6, accent, true);
    if (two) for (let x = 1; x + 1.5 < w - 0.8; x += 2.9) this.kitPiece(fb, 'window', x, CURB + 4.5, 0xffffff);
    // The false front: taller than the roof behind it, because the sign is the whole point.
    const name = kind === 'gus' ? 'gus-arcade' : kind === 'finch' ? 'barnacle-finch' : this.dealSign(lot.block);
    const sw = clamp(w - 1.2, 4, kind === 'gus' ? 13 : 9), sh = name ? sw / 4 : 0, ext = sh + 0.7;
    const cap = rng.pick([tint, BONE, accent]);
    lbox(b, fb, w / 2, -0.15, top, w, 0.3, ext, tint, 5);
    lbox(b, fb, w / 2, -0.15, top + ext, w * 0.56, 0.3, 0.5, cap, 5);
    lbox(b, fb, w / 2, -0.12, top + ext - 0.14, w + 0.2, 0.36, 0.14, cap, 7);
    if (name) this.signBoard(fb, name, (w - sw) / 2, top + 0.3, sw, 0.08);
    this.flatRoof(br, top, tint, 0.5);
    if (kind === 'gus') {
      // Mustard pilasters and a joystick the size of a lamp post.
      for (let k = 0; k <= 4; k++) lbox(b, fb, 0.3 + (k * (w - 0.6)) / 4, 0.06, CURB, 0.5, 0.12, top - CURB + ext, MUST, 5);
      const jx = PX(fb, w * 0.2, -dep * 0.5), jz = PZ(fb, w * 0.2, -dep * 0.5);
      b.box(jx, top, jz, 2.6, 0.7, 2.6, INK, 0, 5);
      b.cyl(jx, top + 0.7, jz, 0.2, 0.2, 3.4, 0xd9d4c8, 6, false);
      b.cyl(jx, top + 3.9, jz, 0.25, 0.85, 0.6, VERM, 10, false);
      b.cyl(jx, top + 4.5, jz, 0.85, 0.85, 0.4, VERM, 10, false);
      b.cyl(jx, top + 4.9, jz, 0.85, 0.2, 0.6, VERM, 10, true);
      this.site('gus', fb, face);
    } else if (kind === 'finch') {
      // A float on the roof, traps by the door, a fish on a bracket.
      const jx = PX(fb, w * 0.75, -dep * 0.45), jz = PZ(fb, w * 0.75, -dep * 0.45);
      b.cyl(jx, top, jz, 0.12, 0.12, 1, IRON, 5, false);
      b.cyl(jx, top + 1, jz, 0.3, 1.2, 0.9, BONE, 10, false);
      b.cyl(jx, top + 1.9, jz, 1.2, 0.35, 1.1, VERM, 10, false);
      b.cyl(jx, top + 3, jz, 0.1, 0.1, 1.3, VERM, 5, true);
      for (let k = 0; k < 3; k++) lbox(b, fb, w - 0.9, 0.5, CURB + k * 0.5, 0.9, 0.7, 0.46, k & 1 ? 0x8c6a4c : 0x9c7a56, 5);
      this.hangSign(fb, 0.5, CURB + 3.3, 'hang-fish');
      this.site('finch', fb, face);
    } else {
      this.clutter(br, top, rng, false);
      if (rng.chance(0.3)) this.hangSign(fb, rng.chance(0.5) ? 0.4 : w - 0.4, CURB + 3.3, rng.pick(this.mats.tex.signs.hanging));
    }
    this.kitPiece(frameOf(br, (face + 2) & 3), 'doorSteel', rng.range(0.6, Math.max(0.7, w - 2)), CURB, 0xc9c6bb);
    this.box(br, top + ext);
  }

  // ── Interior lots ──────────────────────────────────────────────────────────

  /** A lot with no street frontage: a plaza, a walled garden or a parking court, each with a small annex. */
  private court(L: LotCtx): void {
    const { rng, lot } = L, r = inset(L.r, 1), w = r.x1 - r.x0, d = r.z1 - r.z0, b = this.b('flat');
    if (w < 8 || d < 8) return;
    const long = w >= d ? 2 : 1, f = frameOf(r, long);
    if (lot.district === 'downtown') {
      this.ground('flat', r, GY, 0xcfc8b6);
      const a = inset(r, Math.min(w, d) * 0.22), top = CURB + 3.6 * rng.int(4, 9), tint = rng.pick(GLASS);
      this.b('f0').walls(a.x0, a.z0, a.x1, a.z1, CURB, top, tint, 3.4, 3.6, 8, L.i);
      this.flatRoof(a, top, STONE, 0.8);
      this.clutter(a, top, rng, true);
      this.box(a, top + 0.8);
      for (const x of [r.x0 + 1.6, r.x1 - 1.6]) for (const z of [r.z0 + 1.6, r.z1 - 1.6]) {
        b.box(x, CURB, z, 2.2, 0.6, 2.2, STONE, 0, 5);
        b.box(x, CURB + 0.6, z, 1.8, 0.7, 1.8, HEDGE, 0, 5);
      }
    } else if (lot.district === 'oldtown') {
      this.ground('cobble', r, GY, 0xffffff, 4);
      this.parapet(r, 0, CURB + 1.7, 0.35, BRICK, 0.9);
      const a = cut(r, long, f.len * 0.5 - 3.2, f.len * 0.5 + 3.2, f.depth * 0.5 - 3.6, f.depth * 0.5 + 3.6), tint = rng.pick(STUCCO), top = CURB + 6.4;
      this.b('f2').walls(a.x0, a.z0, a.x1, a.z1, CURB, top, tint, 3.2, 3.2, 8, L.i);
      this.gable('tile', a, top, 2, a.x1 - a.x0 >= a.z1 - a.z0, 0.35, 0xffffff, tint);
      this.box(a, top + 1.2);
      b.cyl(r.x0 + 3, CURB, r.z0 + 3, 0.9, 0.9, 0.8, 0x9c968a, 10, false);
      b.cyl(r.x0 + 3, CURB, r.z0 + 3, 0.72, 0.72, 0.6, 0x3f6f78, 10, true);
    } else {
      // Parking court: stalls down both long sides, an annex across one end.
      this.ground('flat', r, GY, 0x55585b);
      for (let s = 9; s < f.len - 2; s += 2.7) for (const dd of [0.4, f.depth - 5.4]) {
        const c = cut(r, long, s - 0.06, s + 0.06, dd, dd + 5);
        this.ground('decal', c, GY, 0xe6e0d0);
      }
      // A second tint down the aisle breaks the single sheet of paving, and parked cars (plain boxes, no makes) say someone uses it.
      this.ground('decal', cut(r, long, 8, f.len - 1, f.depth * 0.5 - 2.4, f.depth * 0.5 + 2.4), GY + 0.004, 0x4a4d50);
      const ax = f.tx !== 0;
      for (let s = 9; s < f.len - 4; s += 2.7) for (const dd of [0.4, f.depth - 5.4]) {
        if (rng.next() > 0.4) continue;
        const cx = PX(f, s + 1.35, -(dd + 2.5)), cz = PZ(f, s + 1.35, -(dd + 2.5)), lx = ax ? 1.8 : 4.2, lz = ax ? 4.2 : 1.8;
        const hex = rng.pick([VERM, TEAL, MUST, BONE, 0x6f7a86, INK, 0xb98468]);
        b.box(cx, CURB, cz, lx, 0.75, lz, hex, 0, 7, 0.95);
        b.box(cx, CURB + 0.75, cz, ax ? 1.6 : 2.2, 0.6, ax ? 2.2 : 1.6, 0x2c3e50, 0, 7, 0.8);
        this.box({ x0: cx - lx / 2, x1: cx + lx / 2, z0: cz - lz / 2, z1: cz + lz / 2 }, CURB + 1.4);
      }
      for (const [px, pz] of [[r.x0 + 1.2, r.z0 + 1.2], [r.x1 - 1.2, r.z1 - 1.2]]) b.box(px, CURB, pz, 1.4, 0.7, 1.4, HEDGE, 0, 5);
      const a = cut(r, long, 0.5, 7, 1.5, f.depth - 1.5), brick = lot.district === 'midtown', top = CURB + (rng.chance(0.5) ? 3.6 : 6.9), tint = rng.pick(brick ? BRICKS : BOARDWALK);
      if (brick) { b.box((a.x0 + a.x1) / 2, 0, (a.z0 + a.z1) / 2, a.x1 - a.x0, CURB + 0.3, a.z1 - a.z0, tint, 0, 4); this.b('f1').walls(a.x0, a.z0, a.x1, a.z1, CURB, top, tint, 3.4, 3.3, 8, L.i); } else this.siding(a, CURB, top, tint);
      this.kitPiece(frameOf(a, (long + 3) & 3), 'doorSteel', 1, CURB, 0xc9c6bb);
      this.flatRoof(a, top, tint, 0.6);
      this.clutter(a, top, rng, false);
      this.box(a, top + 0.6);
      for (let k = 0; k < 2; k++) {
        const dm = cut(r, long, f.len - 2.4, f.len - 0.6, 1.5 + k * 3.6, 4.5 + k * 3.6);
        b.box((dm.x0 + dm.x1) / 2, CURB, (dm.z0 + dm.z1) / 2, dm.x1 - dm.x0, 1.4, dm.z1 - dm.z0, k ? 0x2f5f5a : 0x33435f, 0, 5);
        this.box(dm, CURB + 1.4);
      }
    }
  }
}

/** Everything standing on plan.lots, merged into a few dozen meshes, with collision registered for every solid footprint. */
export function buildBuildings(game: Game, mats: CityMaterials, parent: THREE.Group): WorldPart {
  const group = new THREE.Group();
  group.name = 'buildings';
  parent.add(group);
  const builder = new Builder(game, mats);
  builder.run();
  const lamps = builder.finish(group);
  let t = 0, night = 0;
  return {
    // Two sets of warning lights taking turns, the way a real skyline never quite blinks in step.
    update(dt: number): void {
      if (night < 0.02) return;
      t = (t + dt) % 2.6;
      lamps[0].visible = t < 1.1;
      lamps[1].visible = t > 1.3 && t < 2.4;
    },
    setNight(n: number): void {
      night = n;
      if (n < 0.02) { lamps[0].visible = false; lamps[1].visible = false; }
    },
  };
}
