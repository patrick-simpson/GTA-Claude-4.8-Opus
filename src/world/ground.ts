// The ground the whole city stands on: terrain and sea, streets and their paint,
// block slabs with curbs and sidewalks, street lamps, traffic signals, every tree
// and the sidewalk furniture.
//
// Flat ground is a few thousand triangles for the entire island, so it is merged
// into ONE mesh per material rather than per map chunk: chunking it would cost
// far more draw calls than it could ever save in triangles. The things that do
// add up (trees, lamps) are instanced and bucketed by region, so the main pass
// and, more importantly, the shadow pass only draw the ones nearby.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import type { CityMaterials } from './materials';
import type { Prop, PropKind } from './collide';
import { Batch } from './batch';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MARKS, TILE_M } from './textures';
import { signalState } from './signals';
import { CELL, Cover, EXTRA, TreeField, loadFlora, floraMaterial, type Planting } from './floraAssets';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG, TAU, clamp, hash2, noise2, smooth } from '../core/util';
import {
  AVE_HW, BREAKWATER, BRIDGE, BRIDGE_SPAN, BRIDGE_SPANS, CURB, PIER, RAMPS, SIDEWALK, WATER_Y, XS, ZS,
  groundAt, hwX, hwZ, islandSD, roadY, terrainAt, type Block, type District, type Rect,
} from './plan';
import {
  COAST, DAM_Z, EXTRA_LOTS, FOOTBRIDGE, FOOTBRIDGE_Z, HILL, LAKE, MAIN_SPLIT_Z, MAIN_Y, MXS, MZS, POND_Y, RAIL, RAIL_TRESTLE,
  RIVER_HW, ROAD_BRIDGE, STREAM_HW, STREAM_Z0, TRIB_HW, coastSD, hillAt, mainlandTerrain, riverX, waterDist,
} from './mainland';
import { sawhorses } from './progress';

// Palette (see PLAN.md).
const INK = 0x1e2b44, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, TEAL = 0x2a9d8f;
const SODIUM = 0xffa63d;

/** Edge of the paved city: the outer curb line of the perimeter streets. */
const XW = XS[0] - hwX(0), XE = XS[XS.length - 1] + hwX(XS.length - 1);
const ZN = ZS[0] - hwZ(0), ZSO = ZS[ZS.length - 1] + hwZ(ZS.length - 1);
const SHOULDER = 2.4;
const ST_HW_M = 6;
/** Z of the mainland end of the finished bridge: where the landing's own road begins. */
const bridgeFullEnd = (): number => BRIDGE.z1 - BRIDGE_SPANS * BRIDGE_SPAN;
/** How far in from the curb the poles, trees and furniture stand. */
const STRIP = 0.65;
const REGION = 360;

// Scratch objects for building instance matrices. Build time only.
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
const P = new THREE.Vector3(), S = new THREE.Vector3(), COL = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
// Scratch for laying a sheared pole down.
const FELL_P = new THREE.Vector3(), FELL_S = new THREE.Vector3(), FELL_A = new THREE.Vector3(), FELL_Q = new THREE.Quaternion();
/** What a lamp or signal needs to be shown fallen: its instance, the model axis its arm runs along, its halo and its signal heads. */
interface Felled { inst: Inst; i: number; axis: 0 | 2; halo: number; sig: number }

/** Fill the shared matrix M: position, heading, scale, and an optional forward lean. */
function xf(x: number, y: number, z: number, h: number, sx = 1, sy = sx, sz = sx, lean = 0): void {
  E.set(lean, h, 0, 'YXZ');
  M.compose(P.set(x, y, z), Q.setFromEuler(E), S.set(sx, sy, sz));
}

/**
 * Oriented ground quad. From the origin, n runs along heading h and t along its
 * right-hand side. u spans t0..t1 and v spans n0..n1.
 */
function gq(
  b: Batch, ox: number, oz: number, h: number, t0: number, t1: number, n0: number, n1: number, y: number,
  hex: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, shade = 1,
): void {
  const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
  b.quad(
    ox + rx * t0 + fx * n0, y, oz + rz * t0 + fz * n0,
    ox + rx * t1 + fx * n0, y, oz + rz * t1 + fz * n0,
    ox + rx * t1 + fx * n1, y, oz + rz * t1 + fz * n1,
    ox + rx * t0 + fx * n1, y, oz + rz * t0 + fz * n1, hex, u0, v0, u1, v1, shade,
  );
}

/** Axis-aligned floor with world-space UVs, so neighbouring pieces tile into each other. */
function wf(b: Batch, x0: number, z0: number, x1: number, z1: number, y: number, hex: number, tile: number, shade = 1): void {
  if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return;
  b.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, hex, x0 / tile, z1 / tile, x1 / tile, z0 / tile, shade);
}

/** The frame between an outer and an inner rectangle, as up to four strips. */
function ring(a: Rect, b: Rect, fn: (x0: number, z0: number, x1: number, z1: number) => void): void {
  if (b.z0 > a.z0) fn(a.x0, a.z0, a.x1, b.z0);
  if (b.z1 < a.z1) fn(a.x0, b.z1, a.x1, a.z1);
  if (b.x0 > a.x0) fn(a.x0, b.z0, b.x0, b.z1);
  if (b.x1 < a.x1) fn(b.x1, b.z0, a.x1, b.z1);
}

const inset = (r: Rect, road: readonly boolean[], d: number): Rect => ({
  x0: r.x0 + (road[3] ? d : 0), x1: r.x1 - (road[1] ? d : 0),
  z0: r.z0 + (road[0] ? d : 0), z1: r.z1 - (road[2] ? d : 0),
});

/** True on a stunt ramp, within 12 m of one, or in its run-up and landing strip. */
function nearRamp(x: number, z: number): boolean {
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z;
    if (dx * dx + dz * dz < 144) return true;
    const s = Math.sin(r.h), c = Math.cos(r.h);
    const along = dx * s + dz * c, side = Math.abs(dx * -c + dz * s);
    if (along > -45 && along < r.len + 30 && side < r.width / 2 + 3.5) return true;
  }
  return false;
}

/** Spots other builders need empty: ramp runs, the park pond and promenade, the mouths of the bridge, pier and breakwater. */
function keepOut(x: number, z: number): boolean {
  if (z < MAIN_SPLIT_Z) {
    // The mainland's: the railway, the bridge's landing, the footpath to the footbridge, the Thruway's stub, the water's edge.
    if (Math.abs(z - RAIL.z) < 5.5 && x > RAIL.x0 - 4 && x < RAIL.x1 + 4) return true;
    if (Math.abs(x - BRIDGE.x) < BRIDGE.hw + 5 && z > MZS[MZS.length - 1] + 5) return true;
    if (Math.abs(z - FOOTBRIDGE_Z) < 3.5 && x > MXS[8] && x < 660) return true;
    if (Math.abs(x - MXS[0]) < AVE_HW + 3 && z < MZS[0]) return true;
    return waterDist(x, z) < 3;
  }
  if (nearRamp(x, z)) return true;
  if (z < ZN && Math.abs(x - BRIDGE.x) < BRIDGE.hw + 3) return true;
  if (z > ZSO && x > PIER.x0 - 5 && x < PIER.x1 + 5) return true;
  if (x > XE && z > BREAKWATER.z0 - 4 && z < BREAKWATER.z1 + 4) return true;
  if (x > 84 && x < 306 && z > -216 && z < -24) {
    if (Math.abs(z + 120) < 5.5) return true;
    const ex = (x - 186) / 30, ez = (z + 152) / 22;
    if (ex * ex + ez * ez < 1) return true;
  }
  return false;
}

/** Instances collected first and turned into one InstancedMesh per map region (or one in all when region = 0). */
class Inst {
  private buckets = new Map<number, { m: number[]; c: number[] }>();
  readonly meshes: THREE.InstancedMesh[] = [];
  private keys: number[] = [];
  constructor(private geo: THREE.BufferGeometry, private mat: THREE.Material, private region = 0) {}

  /** Add the matrix currently in M. Returns the instance index inside its bucket. */
  add(x: number, z: number, hex = 0xffffff, shade = 1): number {
    const R = this.region;
    const k = R ? (Math.floor(x / R) + 64) * 256 + Math.floor(z / R) + 64 : 0;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = { m: [], c: [] }));
    const e = M.elements;
    for (let i = 0; i < 16; i++) b.m.push(e[i]);
    COL.setHex(hex);
    b.c.push(COL.r * shade, COL.g * shade, COL.b * shade);
    return b.c.length / 3 - 1;
  }

  /** The mesh holding whatever was added at (x, z). Valid after build(). */
  meshAt(x: number, z: number): THREE.InstancedMesh | null {
    const R = this.region;
    const i = this.keys.indexOf(R ? (Math.floor(x / R) + 64) * 256 + Math.floor(z / R) + 64 : 0);
    return i < 0 ? null : this.meshes[i];
  }

  build(parent: THREE.Object3D, cast: boolean): void {
    for (const [k, b] of this.buckets) {
      this.keys.push(k);
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, b.c.length / 3);
      mesh.instanceMatrix.array.set(b.m);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.c), 3);
      mesh.castShadow = cast; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      this.meshes.push(mesh);
    }
    this.buckets.clear();
  }
}

// ── Small models ─────────────────────────────────────────────────────────────
// All face +Z and stand on y = 0.

/**
 * Street furniture is turned and bevelled rather than boxed: lathe profiles for anything a foundry
 * or a spinning shop would make, swept tubes for arms, rounded boxes for sheet-metal cabinets.
 * Every part carries its own roughness and metalness (`aPbr`), so one material and one draw call
 * hold painted steel, galvanised pipe, cast iron and timber side by side.
 */
class Parts {
  private pos: number[] = []; private nor: number[] = []; private col: number[] = []; private pbr: number[] = []; private idx: number[] = [];

  /** Pour a geometry in: scaled, turned (Euler x, y, z) and moved. The geometry is consumed. */
  add(g: THREE.BufferGeometry, hex: number, rough: number, metal: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    PM.compose(PV.set(x, y, z), PQ.setFromEuler(PE.set(rx, ry, rz)), PS.set(sx, sy, sz));
    PN.getNormalMatrix(PM);
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), base = this.pos.length / 3;
    COL.setHex(hex);
    for (let i = 0; i < p.count; i++) {
      PV.fromBufferAttribute(p, i).applyMatrix4(PM);
      this.pos.push(PV.x, PV.y, PV.z);
      PV.fromBufferAttribute(n, i).applyMatrix3(PN).normalize();
      this.nor.push(PV.x, PV.y, PV.z);
      this.col.push(COL.r, COL.g, COL.b);
      this.pbr.push(rough, metal);
    }
    const ix = g.index;
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    g.dispose();
    return this;
  }

  /** A turned part: radius, height pairs from the bottom up. */
  lathe(profile: number[], seg: number, hex: number, rough: number, metal: number, x = 0, y = 0, z = 0): this {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < profile.length; i += 2) pts.push(new THREE.Vector2(Math.max(profile[i], 0.0005), profile[i + 1]));
    return this.add(new THREE.LatheGeometry(pts, seg), hex, rough, metal, x, y, z);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, rough: number, metal: number, rx = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, d), hex, rough, metal, x, y, z, rx);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.pbr, 2));
    g.setIndex(this.idx);
    return g;
  }
}
const PM = new THREE.Matrix4(), PN = new THREE.Matrix3(), PV = new THREE.Vector3(), PQ = new THREE.Quaternion(), PE = new THREE.Euler(), PS = new THREE.Vector3();

/**
 * What the furniture is drawn with. On the physically based shelf it reads roughness and metalness
 * per vertex; on the cheap shelf (phones, `?pbr=0`) it is the plain two-sided paint and `aPbr` is ignored.
 */
function propMaterial(mats: CityMaterials): THREE.Material {
  if (!mats.pbr) return mats.flatDouble;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true, envMapIntensity: 0.55 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec2 aPbr;\nvarying vec2 vPbr;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPbr = aPbr;');
    sh.fragmentShader = 'varying vec2 vPbr;\n' + sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vPbr.y;');
  };
  return m;
}

// Finishes: [roughness, metalness].
const PAINTED = [0.5, 0.3], GALV = [0.46, 0.85], IRON = [0.62, 0.35], TIMBER = [0.82, 0], ENAMEL = [0.42, 0.15];
const STEEL = 0x9aa1a6;

function lampGeo(): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = PAINTED;
  p.lathe([0.2, 0, 0.2, 0.07, 0.15, 0.13, 0.125, 0.7, 0.1, 0.78, 0.085, 0.82], 6, INK, r, m);
  p.add(new THREE.CylinderGeometry(0.06, 0.085, 5.5, 6, 1, true), INK, r, m, 0, 3.57, 0);
  // A swan neck out over the road, and a cobra head with its lens underneath.
  const neck = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 6.25, 0), new THREE.Vector3(0, 6.62, 0.35), new THREE.Vector3(0, 6.68, 1.1), new THREE.Vector3(0, 6.52, 1.72)]);
  p.add(new THREE.TubeGeometry(neck, 5, 0.045, 4, false), INK, r, m);
  p.add(new THREE.SphereGeometry(1, 7, 3), INK, 0.42, m, 0, 6.46, 2.05, 0, 0, 0, 0.24, 0.1, 0.5);
  p.add(new THREE.CircleGeometry(1, 8), 0xf6e7b4, 0.25, 0, 0, 6.352, 2.1, Math.PI / 2, 0, 0, 0.16, 0.34, 1);
  return p.build();
}
const LAMP_REACH = 2.05, LAMP_H = 6.3;

/** Mast with an arm reaching `arm` meters to the model's right (-X), a head hanging from its tip and one on the pole. */
function signalGeo(arm: number): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = [0.5, 0.45], body = 0xd9930f;
  p.lathe([0.24, 0, 0.24, 0.06, 0.17, 0.12, 0.15, 0.55, 0.12, 0.62], 6, STEEL, r, m);
  p.add(new THREE.CylinderGeometry(0.09, 0.12, 5.6, 6, 1, true), STEEL, r, m, 0, 3.42, 0);
  p.add(new THREE.CylinderGeometry(0.05, 0.075, arm + 0.1, 5, 1, false), STEEL, r, m, -(arm + 0.1) / 2, 5.95, 0, 0, 0, Math.PI / 2);
  const heads: [number, number, number][] = [[-arm, HEAD_Y[0], 0], [0, HEAD_Y[1], 0.24]];
  for (const [x, y0, z] of heads) {
    p.box(0.46, 1.25, 0.3, x, y0 + 0.625, z, body, ENAMEL[0], ENAMEL[1]);
    // A hood over each lamp, open underneath.
    for (let l = 0; l < 3; l++) {
      p.add(new THREE.CylinderGeometry(0.18, 0.18, 0.22, 4, 1, true, Math.PI / 2, Math.PI), 0x20242c, 0.6, 0.2, x, y0 + 1.0 - l * 0.375, z + 0.26, Math.PI / 2);
    }
  }
  return p.build();
}
const HEAD_Y = [4.8, 2.7], HEAD_Z = [0.165, 0.405];

function hydrantGeo(): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = IRON;
  p.lathe([0.2, 0, 0.2, 0.05, 0.14, 0.09, 0.13, 0.5, 0.165, 0.52, 0.165, 0.56, 0.13, 0.58, 0.11, 0.67, 0.045, 0.74, 0.04, 0.8, 0, 0.8], 7, VERM, r, m);
  p.add(new THREE.CylinderGeometry(0.055, 0.055, 0.4, 5, 1, true), VERM, r, m, 0, 0.36, 0, 0, 0, Math.PI / 2);
  for (const s of [-1, 1]) p.add(new THREE.CylinderGeometry(0.068, 0.068, 0.05, 5), BONE, r, m, s * 0.215, 0.36, 0, 0, 0, Math.PI / 2);
  p.add(new THREE.CylinderGeometry(0.075, 0.075, 0.2, 6, 1, true), VERM, r, m, 0, 0.33, 0.1, Math.PI / 2);
  p.add(new THREE.CylinderGeometry(0.088, 0.088, 0.05, 6), BONE, r, m, 0, 0.33, 0.215, Math.PI / 2);
  return p.build();
}
function binGeo(): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = PAINTED;
  // Up the outside, over the rolled rim and back down the inside to a dark floor.
  p.lathe([0.25, 0, 0.27, 0.03, 0.33, 0.86, 0.36, 0.88, 0.36, 0.93, 0.31, 0.95, 0.3, 0.62], 8, TEAL, r, m);
  p.lathe([0.318, 0.585, 0.336, 0.59, 0.336, 0.7, 0.33, 0.705], 8, BONE, r, m);
  p.add(new THREE.CircleGeometry(0.3, 8), 0x15171c, 0.9, 0, 0, 0.62, 0, -Math.PI / 2);
  return p.build();
}
function mailboxGeo(): THREE.BufferGeometry {
  const p = new Parts(), blue = 0x27457a, [r, m] = ENAMEL;
  for (const sx of [-0.2, 0.2]) p.box(0.05, 0.32, 0.4, sx, 0.16, 0, 0x16203a, r, m);
  p.add(new RoundedBoxGeometry(0.54, 0.64, 0.5, 1, 0.03), blue, r, m, 0, 0.62, 0);
  // The barrel top, its axis across the box.
  p.add(new THREE.CylinderGeometry(0.25, 0.25, 0.54, 8, 1, false, 0, Math.PI), blue, r, m, 0, 0.93, 0, 0, 0, Math.PI / 2);
  p.box(0.4, 0.12, 0.02, 0, 0.66, 0.255, BONE, 0.6, 0);
  p.box(0.3, 0.03, 0.03, 0, 0.99, 0.235, 0x16203a, 0.4, 0.6);
  return p.build();
}
function benchGeo(): THREE.BufferGeometry {
  const p = new Parts(), wood = 0xa8744a, [r, m] = TIMBER, [ir, im] = IRON;
  for (let i = 0; i < 4; i++) p.box(1.7, 0.035, 0.105, 0, 0.44, -0.17 + i * 0.125, wood, r, m);
  for (let i = 0; i < 2; i++) p.box(1.7, 0.15, 0.03, 0, 0.64 + i * 0.2, -0.25 - i * 0.032, wood, r, m, -0.16);
  for (const x of [-0.72, 0.72]) {
    p.box(0.05, 0.44, 0.05, x, 0.22, 0.22, INK, ir, im);
    p.box(0.05, 0.98, 0.05, x, 0.49, -0.27, INK, ir, im, -0.1);
    p.box(0.05, 0.05, 0.54, x, 0.4, -0.01, INK, ir, im);
    p.box(0.07, 0.04, 0.52, x, 0.66, -0.01, INK, ir, im);
    p.box(0.04, 0.24, 0.04, x, 0.54, 0.22, INK, ir, im);
  }
  return p.build();
}
function postGeo(): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = GALV;
  p.lathe([0.09, 0, 0.09, 0.02, 0.045, 0.05, 0.04, 2.7, 0, 2.72], 6, STEEL, r, m);
  p.box(0.52, 0.62, 0.035, 0, 2.03, 0.06, MUST, ENAMEL[0], ENAMEL[1]);
  p.box(0.52, 0.13, 0.04, 0, 2.46, 0.06, INK, ENAMEL[0], ENAMEL[1]);
  return p.build();
}
function newsGeo(): THREE.BufferGeometry {
  const p = new Parts(), [r, m] = ENAMEL;
  p.box(0.34, 0.14, 0.3, 0, 0.07, 0, 0x333333, 0.7, 0.3);
  p.add(new RoundedBoxGeometry(0.46, 0.9, 0.4, 1, 0.03), 0xffffff, r, m, 0, 0.59, 0);
  p.box(0.34, 0.32, 0.02, 0, 0.76, 0.2, 0x1c2026, 0.12, 0);
  p.box(0.09, 0.14, 0.03, 0.15, 0.46, 0.2, 0x8c9096, 0.4, 0.9);
  return p.build();
}

/** One canopy mass: a lumpy faceted ball, darker underneath. Tinted per instance. */
function blobGeo(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Keyed on the corner itself, so the copies of a shared corner move together.
    const k = 0.86 + 0.3 * hash2(Math.round(x * 40) + Math.round(z * 40) * 131, Math.round(y * 40));
    p.setXYZ(i, x * k, y * k * 0.94, z * k);
    const sh = 0.66 + 0.34 * smooth(y * 0.5 + 0.55);
    col[i * 3] = sh; col[i * 3 + 1] = sh; col[i * 3 + 2] = sh;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function trunkGeo(): THREE.BufferGeometry {
  const b = new Batch();
  b.cyl(0, 0, 0, 1, 0.7, 1, 0xffffff, 6, false);
  return b.toGeometry();
}

/** A palm's crown: drooping fronds as bent ribbons, seen from both sides. */
function palmGeo(): THREE.BufferGeometry {
  const b = new Batch(), N = 9;
  const R = [0.15, 1.2, 2.3, 3.1], W = [0.22, 0.42, 0.34, 0.04];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU, cx = Math.cos(a), cz = Math.sin(a);
    // Alternate fronds ride high and hang low so the crown reads as a ball, not a wheel.
    const Y = i % 2 ? [0.1, 0.75, 0.7, 0.0] : [0.0, 0.4, 0.05, -0.95];
    for (let k = 0; k < 3; k++) {
      const x0 = cx * R[k], z0 = cz * R[k], x1 = cx * R[k + 1], z1 = cz * R[k + 1];
      const w0 = W[k], w1 = W[k + 1];
      b.quad(
        x0 + cz * w0, Y[k], z0 - cx * w0, x1 + cz * w1, Y[k + 1], z1 - cx * w1,
        x1 - cz * w1, Y[k + 1], z1 + cx * w1, x0 - cz * w0, Y[k], z0 + cx * w0,
        0xffffff, 0, 0, 1, 1, 1 - k * 0.1,
      );
    }
  }
  b.cyl(0, -0.3, 0, 0.3, 0.2, 0.4, 0xb9a070, 5);
  return b.toGeometry();
}

/** A boulder: a welded, lumpy ball with smooth normals. Scaled, turned and tinted per instance. */
function rockGeo(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('uv'); ico.deleteAttribute('normal');
  const g = mergeVertices(ico);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.74 + 0.5 * hash2(Math.round(x * 31) + Math.round(z * 17) * 7, Math.round(y * 29));
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return new Parts().add(g, 0xffffff, 0.93, 0).build();
}

/** A bleached log with one broken limb, lying along x. */
function driftGeo(): THREE.BufferGeometry {
  const p = new Parts(), hex = 0xc9c0ae;
  const spine = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.6, 0.1, 0), new THREE.Vector3(-0.5, 0.15, 0.14), new THREE.Vector3(0.6, 0.12, -0.1), new THREE.Vector3(1.6, 0.17, 0.06)]);
  p.add(new THREE.TubeGeometry(spine, 6, 0.1, 6, false), hex, 0.92, 0);
  p.add(new THREE.SphereGeometry(0.1, 6, 3), hex, 0.92, 0, -1.6, 0.1, 0);
  p.add(new THREE.SphereGeometry(0.1, 6, 3), hex, 0.92, 0, 1.6, 0.17, 0.06);
  p.add(new THREE.CylinderGeometry(0.025, 0.06, 0.8, 5), hex, 0.92, 0, 0.35, 0.42, 0.12, 0.5, 0, -0.6);
  return p.build();
}


// ── The mainland's helpers ───────────────────────────────────────────────────

/** The two paved rectangles of Tepid Falls: the town west of the river, and the far bank's few streets. */
const TOWN_A: Rect = { x0: MXS[0] - 6, z0: MZS[0] - 6, x1: MXS[8] + 6, z1: MZS[MZS.length - 1] + 6 };
const TOWN_B: Rect = { x0: MXS[9] - 6, z0: MZS[0] - 6, x1: MXS[10] + 6, z1: MZS[4] + 6 };
const inTown = (x: number, z: number, m: number): boolean =>
  (x > TOWN_A.x0 - m && x < TOWN_A.x1 + m && z > TOWN_A.z0 - m && z < TOWN_A.z1 + m)
  || (x > TOWN_B.x0 - m && x < TOWN_B.x1 + m && z > TOWN_B.z0 - m && z < TOWN_B.z1 + m);
const inExtraLot = (x: number, z: number, m: number): boolean =>
  EXTRA_LOTS.some((l) => x > l.rect.x0 - m && x < l.rect.x1 + m && z > l.rect.z0 - m && z < l.rect.z1 + m);
const onHill = (x0: number, z0: number, x1: number, z1: number): boolean =>
  x1 > HILL.x0 && x0 < HILL.x1 && z1 > HILL.z0 && z0 < HILL.z1;

/**
 * gq() for the mainland: the same oriented quad, lying at roadY() + dy. On the flat that is one quad;
 * where it touches Dithers Hill it is cut into cells small enough to follow the slope, each corner
 * sampled from the same function the physics drives on.
 */
function gqh(
  b: Batch, ox: number, oz: number, h: number, t0: number, t1: number, n0: number, n1: number, dy: number,
  hex: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, shade = 1,
): void {
  const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
  const X = (t: number, n: number): number => ox + rx * t + fx * n, Z = (t: number, n: number): number => oz + rz * t + fz * n;
  const xs = [X(t0, n0), X(t1, n0), X(t1, n1), X(t0, n1)], zs = [Z(t0, n0), Z(t1, n0), Z(t1, n1), Z(t0, n1)];
  const hilly = onHill(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs));
  const NT = hilly ? Math.max(1, Math.ceil((t1 - t0) / 4)) : 1, NN = hilly ? Math.max(1, Math.ceil((n1 - n0) / 4)) : 1;
  for (let i = 0; i < NT; i++) for (let j = 0; j < NN; j++) {
    const ta = t0 + ((t1 - t0) * i) / NT, tb = t0 + ((t1 - t0) * (i + 1)) / NT;
    const na = n0 + ((n1 - n0) * j) / NN, nb = n0 + ((n1 - n0) * (j + 1)) / NN;
    const ua = u0 + ((u1 - u0) * i) / NT, ub = u0 + ((u1 - u0) * (i + 1)) / NT;
    const va = v0 + ((v1 - v0) * j) / NN, vb = v0 + ((v1 - v0) * (j + 1)) / NN;
    const ax = X(ta, na), az = Z(ta, na), bx = X(tb, na), bz = Z(tb, na), cx = X(tb, nb), cz = Z(tb, nb), dx = X(ta, nb), dz = Z(ta, nb);
    b.quad(ax, roadY(ax, az) + dy, az, bx, roadY(bx, bz) + dy, bz, cx, roadY(cx, cz) + dy, cz, dx, roadY(dx, dz) + dy, dz, hex, ua, va, ub, vb, shade);
  }
}

/** wf() for the mainland: an axis-aligned floor with world UVs at roadY() + dy, cut up where it lies on the hill. */
function wfh(b: Batch, x0: number, z0: number, x1: number, z1: number, dy: number, hex: number, tile: number, shade = 1): void {
  if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return;
  const hilly = onHill(x0, z0, x1, z1);
  const NX = hilly ? Math.ceil((x1 - x0) / 4) : 1, NZ = hilly ? Math.ceil((z1 - z0) / 4) : 1;
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
    const xa = x0 + ((x1 - x0) * i) / NX, xb = x0 + ((x1 - x0) * (i + 1)) / NX;
    const za = z0 + ((z1 - z0) * j) / NZ, zb = z0 + ((z1 - z0) * (j + 1)) / NZ;
    b.quad(xa, roadY(xa, zb) + dy, zb, xb, roadY(xb, zb) + dy, zb, xb, roadY(xb, za) + dy, za, xa, roadY(xa, za) + dy, za,
      hex, xa / tile, zb / tile, xb / tile, za / tile, shade);
  }
}

/** An upright strip from (ax, az) to (bx, bz), from lo to hi above the road: a curb face that follows the ground. */
function vfh(b: Batch, ax: number, az: number, bx: number, bz: number, lo: number, hi: number, hex: number, shade: number): void {
  const L = Math.hypot(bx - ax, bz - az), N = onHill(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)) ? Math.max(1, Math.ceil(L / 4)) : 1;
  for (let i = 0; i < N; i++) {
    const x0 = ax + ((bx - ax) * i) / N, z0 = az + ((bz - az) * i) / N, x1 = ax + ((bx - ax) * (i + 1)) / N, z1 = az + ((bz - az) * (i + 1)) / N;
    const y0 = roadY(x0, z0), y1 = roadY(x1, z1);
    b.quad(x0, y0 + lo, z0, x1, y1 + lo, z1, x1, y1 + hi, z1, x0, y0 + hi, z0, hex, 0, 0, 1, 1, shade);
  }
}

/** A square bar between two points: cables, rails, struts. */
function bar(b: Batch, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, hex: number): void {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz) || 1;
  dx /= L; dy /= L; dz /= L;
  let sx: number, sy: number, sz: number;
  if (Math.abs(dy) > 0.98) { sx = 1; sy = 0; sz = 0; } else { sx = -dz; sy = 0; sz = dx; }
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;
  const ux = sy * dz - sz * dy, uy = sz * dx - sx * dz, uz = sx * dy - sy * dx, k = w / 2;
  const c = [[sx + ux, sy + uy, sz + uz], [sx - ux, sy - uy, sz - uz], [-sx - ux, -sy - uy, -sz - uz], [-sx + ux, -sy + uy, -sz + uz]];
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    b.quad(ax + q[0] * k, ay + q[1] * k, az + q[2] * k, ax + p[0] * k, ay + p[1] * k, az + p[2] * k,
      bx + p[0] * k, by + p[1] * k, bz + p[2] * k, bx + q[0] * k, by + q[1] * k, bz + q[2] * k, hex, 0, 0, 1, 1, i % 2 ? 0.8 : 1);
  }
}

const F1 = (n: number): string => n.toFixed(1);
/** mainland.ts's coast and fresh water, ported like islandSD. The river is left out above the dam: the mill pond has its own surface. */
const MAIN_SD = /* glsl */ `
float mainCoastSD(vec2 p) {
  p -= vec2(${F1(COAST.cx)}, ${F1(COAST.cz)});
  vec2 q = abs(p) - vec2(${F1(COAST.hx - COAST.r)}, ${F1(COAST.hz - COAST.r)});
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${F1(COAST.r)};
  float th = atan(p.y, p.x);
  return sd + 10.0 * sin(th * 4.0 + 0.7) + 6.0 * sin(th * 9.0 + 2.1) + 3.0 * sin(th * 17.0);
}
float mainWaterDist(vec2 p) {
  float d = 1.0e9;
  float rx = 340.0 + 30.0 * sin((p.y + 1100.0) / 210.0);
  if (p.x > 230.0 && p.x < 450.0 && p.y > ${F1(DAM_Z)}) d = abs(p.x - rx) - ${F1(RIVER_HW)};
  if (p.x > 300.0 && p.y > -1600.0 && p.y < -1470.0 && p.x > rx - 10.0) d = min(d, abs(p.y - (-1530.0 + 14.0 * sin((p.x - 400.0) / 160.0))) - ${F1(TRIB_HW)});
  if (p.x < -740.0) {
    if (p.x > -860.0 && p.y > ${F1(STREAM_Z0)}) d = min(d, abs(p.x - (-800.0 + 22.0 * sin((p.y + 1000.0) / 130.0))) - ${F1(STREAM_HW)});
    if (p.y < -1930.0) { vec2 e = (p - vec2(${F1(LAKE.x)}, ${F1(LAKE.z)})) / vec2(${F1(LAKE.a)}, ${F1(LAKE.b)}); d = min(d, (length(e) - 1.0) * ${F1(LAKE.a)}); }
  }
  return d;
}
`;

const RIVER_VERT = /* glsl */ `
attribute float aEdge, aFoam;
varying vec3 vW;
varying float vEdge, vFoam;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vEdge = aEdge; vFoam = aFoam;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

// The mill pond and the falls: the sea's shading with the noise scrolling downstream (+z), and white water where aFoam says.
const RIVER_FRAG = /* glsl */ `
uniform float uTime, uNight;
uniform vec3 uLight, uShallow, uDeep, uShallowN, uDeepN, uFoam, uGlint;
uniform sampler2D uNoise;
varying vec3 vW;
varying float vEdge, vFoam;
#include <common>
#include <fog_pars_fragment>
const float E = 1.0 / 256.0;
vec2 slope(vec2 uv) {
  float h = texture2D(uNoise, uv).r;
  return vec2(texture2D(uNoise, uv + vec2(E, 0.0)).r - h, texture2D(uNoise, uv + vec2(0.0, E)).r - h);
}
void main() {
  vec2 p = vW.xz;
  float t = uTime;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 g = slope(vec2(p.x / 41.0, p.y / 41.0 - t * 0.03)) + slope(vec2(p.x / 15.0 + 0.3, p.y / 15.0 - t * 0.085)) * 0.6;
  float near = 1.0 - smoothstep(70.0, 460.0, dist);
  vec3 N = normalize(vec3(-g.x * 22.0 * near, 1.0, -g.y * 22.0 * near));
  // A river is browner and greener than the sea, and darker in the channel.
  vec3 col = mix(mix(uShallow, uShallowN, uNight), mix(uDeep, uDeepN, uNight), 0.3 + 0.45 * vEdge) * vec3(0.8, 0.92, 0.74);
  col *= 1.0 + clamp((dot(N, uLight) - uLight.y) * 1.5, -0.22, 0.3) * near;
  #ifdef USE_FOG
    vec3 sky = mix(fogColor, mix(uShallow, uShallowN, uNight) * 1.1, 0.3) * (1.0 - 0.55 * uNight);
  #else
    vec3 sky = vec3(0.8, 0.88, 0.9);
  #endif
  float fres = pow(1.0 - max(dot(normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.4)), V), 0.0), 3.0);
  col = mix(col, sky, fres * 0.42);
  vec3 H = normalize(uLight + V);
  col += uGlint * smoothstep(0.2, 0.85, pow(max(dot(N, H), 0.0), 240.0));
  // White water: streaks stretched along the fall and running down it.
  float n1 = texture2D(uNoise, vec2(p.x / 7.0, p.y / 30.0 - t * 0.5)).r;
  float n2 = texture2D(uNoise, vec2(p.x / 2.3, p.y / 12.0 - t * 0.9)).g;
  float white = clamp(vFoam * (0.5 + 1.5 * n1 * n2 + 0.35 * n2), 0.0, 1.0);
  col = mix(col, uFoam * (1.0 - 0.72 * uNight), white);
  float alpha = max(smoothstep(0.0, 0.22, vEdge) * 0.9, white);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ── The sea ──────────────────────────────────────────────────────────────────

const SEA_VERT = /* glsl */ `
varying vec3 vW;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

// islandSD() is plan.ts's coastline, ported, so the shallows and the foam line
// follow the real shore without baking a map. Wave slopes come from the shared
// noise tile: it is mip-mapped, so far water flattens itself instead of sparkling.
const SHORE_SD = /* glsl */ `
float isleShoreSD(vec2 p) {
  p -= vec2(0.0, -5.0);
  vec2 q = abs(p) - vec2(540.0, 365.0);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 140.0;
  float th = atan(p.y, p.x);
  return sd + 13.0 * sin(th * 5.0 + 1.3) + 8.0 * sin(th * 11.0 + 0.4) + 4.0 * sin(th * 23.0);
}
` + MAIN_SD.replace('float mainWaterDist', 'float mainWaterDistUnused') + /* glsl */ `
float shoreSD(vec2 p) { return p.y < ${F1(MAIN_SPLIT_Z)} ? mainCoastSD(p) : isleShoreSD(p); }
`;

const SEA_FRAG = /* glsl */ `
uniform float uTime, uNight;
uniform vec3 uLight, uShallow, uDeep, uShallowN, uDeepN, uFoam, uGlint;
uniform sampler2D uNoise;
varying vec3 vW;
#include <common>
#include <fog_pars_fragment>

float islandSD(vec2 p) {
  p -= vec2(0.0, -5.0);
  vec2 q = abs(p) - vec2(540.0, 365.0);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 140.0;
  float th = atan(p.y, p.x);
  return sd + 13.0 * sin(th * 5.0 + 1.3) + 8.0 * sin(th * 11.0 + 0.4) + 4.0 * sin(th * 23.0);
}
${MAIN_SD}
const float E = 1.0 / 256.0;
vec2 slope(vec2 uv) {
  float h = texture2D(uNoise, uv).r;
  return vec2(texture2D(uNoise, uv + vec2(E, 0.0)).r - h, texture2D(uNoise, uv + vec2(0.0, E)).r - h);
}
void main() {
  vec2 p = vW.xz;
  float sd = islandSD(p);
  // riv: 1 in the mainland's fresh water, where the surface runs downstream and no surf rolls in.
  float riv = 0.0;
  if (p.y < ${F1(MAIN_SPLIT_Z)}) {
    float cs = mainCoastSD(p), wd = -mainWaterDist(p) - 4.2;
    riv = step(cs, wd);
    sd = max(cs, wd);
  }
  if (sd < -30.0) discard;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float t = uTime;

  vec2 pf = p - vec2(0.0, t * 1.3) * riv * step(200.0, p.x);
  vec2 g = slope(pf / 131.0 + t * vec2(0.0045, 0.003))
         + slope(pf / 47.0 + t * vec2(-0.011, 0.008)) * 0.75
         + slope(pf / 19.0 + t * vec2(0.017, -0.022)) * 0.5;
  // Far from the camera the slope noise only reads as grey marble blotches: ease it flat with distance.
  float near = 1.0 - smoothstep(90.0, 600.0, dist);
  vec3 N = normalize(vec3(-g.x * 26.0 * near, 1.0, -g.y * 26.0 * near));

  float off = smoothstep(-8.0, 190.0, sd);
  vec3 col = mix(mix(uShallow, uShallowN, uNight), mix(uDeep, uDeepN, uNight), pow(off, 0.62));
  // Wave faces turned to the light are a shade brighter, the far faces a shade darker.
  col *= 1.0 + clamp((dot(N, uLight) - uLight.y) * 1.5, -0.22, 0.3) * near;

  #ifdef USE_FOG
    // Pulled toward the water's own teal and dimmed by night, so a bright dusk horizon never turns the sea to paper.
    vec3 sky = mix(fogColor, mix(uShallow, uShallowN, uNight) * 1.1, 0.3) * (1.0 - 0.55 * uNight);
  #else
    vec3 sky = vec3(0.8, 0.88, 0.9);
  #endif
  float fres = pow(1.0 - max(dot(normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.4)), V), 0.0), 3.0);
  col = mix(col, sky, fres * 0.38);

  vec3 H = normalize(uLight + V);
  float spec = pow(max(dot(N, H), 0.0), 240.0);
  col += uGlint * smoothstep(0.2, 0.85, spec);

  // Foam: a wobbling line at the waterline (sd is about -5.5 where the sand meets
  // sea level) and a few thin bands rolling in behind it.
  float n = texture2D(uNoise, p / 61.0 + t * 0.004).g;
  float s = sd + 5.5 + (n - 0.5) * 4.0;
  float edge = 1.0 - smoothstep(0.8, 2.8, s + sin(t * 0.6 + n * 6.2832) * 1.1);
  float bands = smoothstep(0.84, 0.97, sin(s * 0.4 - t * 0.75 + n * 9.0) * 0.5 + 0.5) * (1.0 - smoothstep(3.0, 30.0, s)) * (1.0 - riv);
  float lace = 0.5 + 0.5 * smoothstep(0.3, 0.62, texture2D(uNoise, p / 8.0 + vec2(t * 0.012, -t * 0.009)).r);
  float foam = clamp(edge * lace + bands * 0.65 * lace, 0.0, 1.0);
  // The swash: 0 on dry sand, 1 once properly afloat. It breathes with the same slow wave as the foam line.
  float swash = smoothstep(-1.4, 1.6, s + sin(t * 0.6 + n * 6.2832) * 1.1);
  col = mix(col, uFoam * (1.0 - 0.72 * uNight), foam * 0.92);

  // Clear over the sand, opaque once the bottom is out of sight.
  float alpha = max(mix(0.3, 1.0, smoothstep(-6.0, 55.0, sd)), foam * 0.9) * swash;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ── Districts ────────────────────────────────────────────────────────────────

type Surface = 'sidewalk' | 'grass' | 'asphalt' | 'cobble' | 'wood';
/** What a block is paved with inside its sidewalk ring. */
const FILL: Record<District, [Surface, number]> = {
  downtown: ['sidewalk', 0xe6dfcd], midtown: ['sidewalk', 0xcfc8b7], oldtown: ['cobble', 0xffffff],
  suburb: ['grass', 0xe6e0b0], industrial: ['asphalt', 0xffffff], port: ['sidewalk', 0xbfb8a8],
  strand: ['wood', 0xffffff], park: ['grass', 0xdfe2b0], arena: ['asphalt', 0xf2f0ea],
  // Tepid Falls. Lots are empty until part 2, so each district shows the ground its buildings will stand on.
  mill: ['cobble', 0xd8cdc0], main: ['sidewalk', 0xd9d2c0], square: ['grass', 0xdfe2b0], stacks: ['grass', 0xd9dba6],
  college: ['grass', 0xd2e0a4], yard: ['asphalt', 0xe6e0d2], exits: ['asphalt', 0xf0ede6], lake: ['grass', 0xdfe2b0], sister: ['grass', 0xdfe2b0],
};

type Species = 'plane' | 'maple' | 'oak' | 'cypress' | 'palm';
/** Street trees per district: species, spacing along the curb in meters, and how many of the spots are planted. */
const STREET_TREES: Record<District, [Species, number, number]> = {
  downtown: ['plane', 15, 0.85], midtown: ['plane', 14, 0.8], oldtown: ['plane', 21, 0.5],
  suburb: ['maple', 10, 0.9], industrial: ['plane', 40, 0.1], port: ['plane', 40, 0.06],
  strand: ['palm', 13, 0.5], park: ['oak', 12, 0.85], arena: ['plane', 22, 0.5],
  // Maine has no palms and few planes: maples on the streets, oaks on the square and the hill.
  mill: ['maple', 26, 0.4], main: ['maple', 15, 0.8], square: ['oak', 11, 0.9], stacks: ['maple', 11, 0.85],
  college: ['oak', 13, 0.8], yard: ['maple', 40, 0.12], exits: ['maple', 34, 0.2], lake: ['oak', 20, 0.5], sister: ['maple', 14, 0.6],
};
const LEAF: Record<Species, number[]> = {
  plane: [0x7f9c54, 0x8ca95e, 0x70904f],
  maple: [0x618f49, 0x78a251, 0x517e45, 0xdb962c, 0xc9663b],
  oak: [0x507f46, 0x5e8b4b, 0x437048],
  cypress: [0x355e4b, 0x3f6b55],
  palm: [0x6f9a50, 0x82aa5a],
};

/** The leaf pictures are pale and the crowns shade themselves, so the old flat-shaded leaf colours go on a little brighter. */
const LEAF_GAIN = 1.2;

// Furniture kinds, in the order of their instanced meshes.
const HYDRANT = 0, BIN = 1, MAILBOX = 2, BENCH = 3, POST = 4, NEWS = 5;
/** Collision for each: kind, radius, height, breakable. A newspaper box collides (and breaks) like a mailbox. */
const FURN: [PropKind, number, number, boolean][] = [
  ['hydrant', 0.28, 0.75, true], ['bin', 0.38, 1.0, true], ['mailbox', 0.4, 1.15, true],
  ['bench', 0.5, 0.9, false], ['post', 0.14, 2.7, true], ['mailbox', 0.34, 1.05, true],
];
/** Relative odds of each kind, then how full the curb is. */
const FURN_MIX: Record<District, [number[], number]> = {
  downtown: [[1, 2.2, 0.8, 1.6, 0.7, 1.4], 0.62], midtown: [[1, 2, 1, 1.4, 0.6, 1], 0.55],
  oldtown: [[1, 1.6, 0.8, 1.6, 0.3, 0.5], 0.5], suburb: [[1.2, 0.8, 1.2, 0.4, 0.3, 0], 0.3],
  industrial: [[1.2, 1, 0, 0, 0.2, 0], 0.22], port: [[1.2, 1, 0, 0, 0.2, 0], 0.2],
  strand: [[0.8, 2.2, 0.4, 2.6, 0.5, 0.8], 0.65], park: [[0.5, 2, 0, 3, 0.3, 0], 0.5],
  arena: [[1, 2, 0, 1, 0.6, 0.4], 0.4],
  mill: [[1.2, 1, 0.3, 0.4, 0.2, 0], 0.25], main: [[1, 2, 1, 1.6, 0.5, 1.2], 0.55], square: [[0.5, 2, 0, 3, 0.2, 0], 0.5],
  stacks: [[1.2, 0.8, 1.2, 0.4, 0.2, 0], 0.3], college: [[0.6, 1.4, 0.3, 2.4, 0.2, 0.2], 0.3], yard: [[1.2, 1, 0, 0, 0.2, 0], 0.15],
  exits: [[1.2, 1, 0, 0, 0.4, 0], 0.2], lake: [[1, 1, 0, 1, 0, 0], 0.1], sister: [[1, 1, 0, 1, 0, 0], 0.1],
};
const NEWS_COLORS = [VERM, MUST, TEAL, 0x27457a];

// Signal lamps: red, yellow, green.
const LIT = [0xff3b24, 0xffc21a, 0x2fe6a2], DIM = [0x3a1410, 0x3a2c0c, 0x0c2e22];

// ── The builder ──────────────────────────────────────────────────────────────

class Ground implements WorldPart {
  private readonly plan: Game['plan'];
  private readonly den: number;
  private readonly root = new THREE.Group();

  private seaU!: Record<string, THREE.IUniform>;
  private poolMat!: THREE.MeshBasicMaterial;
  private haloMat!: THREE.PointsMaterial;
  private readonly glintDay = new THREE.Color(0xfff0c4);
  private readonly glintNight = new THREE.Color(0x8fa6c4);

  /** Occupied spots on the sidewalks, as x, z, r triples in 8 m cells, so nothing is planted inside anything else. */
  private claims = new Map<number, number[]>();

  // One canopy mesh, one trunk mesh and one palm crown serve every species.
  private trunks: Inst; private blobs: Inst; private palms: Inst;
  private lamps: Inst;
  private propMat!: THREE.Material;
  private sandMat: THREE.MeshStandardMaterial | null = null;
  /** Small things drawn only within `lim` meters of their bounding sphere: a bin at 300 m is a pixel, but it is still a draw call and triangles. */
  private nearOnly: { o: THREE.Object3D; c: THREE.Vector3; r: number; lim: number }[] = [];
  /** Every tree again, as the Blender models want it: drawn by `field` once models/flora.glb has loaded. */
  private planted: Planting = { kind: [], m: [], c: [] };
  private field: TreeField | null = null;
  private furn: Inst[];
  private slotKind: number[] = [];
  private slotIdx: number[] = [];
  private slotProp: Prop[] = [];
  private felled = new Map<Prop, Felled>();
  private haloPos: THREE.BufferAttribute | null = null;
  private mainShown = true;
  private pools = new Batch();
  private halos: number[] = [];

  // Signals: one entry per approach; six lamps each (two heads of three).
  private sigNode: number[] = [];
  private sigHoriz: boolean[] = [];
  private sigLast!: Int8Array;
  private bulbs: THREE.InstancedMesh | null = null;
  /** The mainland's signal lamps are a second mesh, so they can be left undrawn from the island. Approaches from `sigMain` on are its. */
  private bulbsMain: THREE.InstancedMesh | null = null;
  private sigMain = 0;
  /** Everything of the far shore's that is one big mesh: shown only when the camera is within fog range of the mainland's coast. */
  private mainOnly: THREE.Object3D[] = [];
  private readonly litC = new Float32Array(9);
  private readonly dimC = new Float32Array(9);

  constructor(private game: Game, private mats: CityMaterials, parent: THREE.Group) {
    this.plan = game.plan;
    this.den = clamp(game.quality.density, 0, 1);
    this.root.name = 'ground';
    parent.add(this.root);

    const flat = mats.flat;
    this.trunks = new Inst(trunkGeo(), flat, REGION);
    this.blobs = new Inst(blobGeo(), flat, REGION);
    this.palms = new Inst(palmGeo(), mats.flatDouble, REGION);
    this.propMat = propMaterial(mats);
    this.lamps = new Inst(lampGeo(), this.propMat, REGION);
    // Bucketed by region like the lamps: the models have real triangle counts now, and far ones should be culled.
    this.furn = [hydrantGeo(), binGeo(), mailboxGeo(), benchGeo(), postGeo(), newsGeo()].map((g) => new Inst(g, this.propMat, REGION));

    if (game.quality.name !== 'low') this.toneGrass();
    this.terrain();
    this.mainTerrain();
    this.sea();
    this.mainWater();
    this.surfaces();
    this.mainSurfaces();
    this.mainStructures();
    // Order matters from here: each claims its spots and the next works around them.
    this.signals();
    this.streetLamps();
    this.furniture();
    this.trees();
    this.finish();

    this.lamps.build(this.root, true);
    this.trunks.build(this.root, true);
    this.blobs.build(this.root, true);
    this.palms.build(this.root, true);
    // The far shore's lamps and stand-in trees are bucketed by region like the island's; out of sight, they are not drawn at all.
    for (const inst of [this.lamps, this.trunks, this.blobs]) {
      for (const m of inst.meshes) { m.computeBoundingSphere(); if (m.boundingSphere!.center.z < MAIN_SPLIT_Z - 120) this.mainOnly.push(m); }
    }
    // Knee-high props are not worth a place in the shadow pass.
    for (const f of this.furn) { f.build(this.root, false); this.hideFar(f.meshes, 150); }
    this.lights();
    this.claims.clear();

    const earlier = game.col.onBreak;
    game.col.onBreak = (p, vx, vz) => {
      if (p.slot >= 0 && this.slotProp[p.slot] === p) {
        const mesh = this.furn[this.slotKind[p.slot]].meshAt(p.x, p.z);
        if (mesh) { mesh.setMatrixAt(this.slotIdx[p.slot], ZERO); mesh.instanceMatrix.needsUpdate = true; }
      }
      const f = this.felled.get(p);
      if (f) this.fell(p, f, vx, vz);
      earlier?.(p, vx, vz);
      game.emit('propBreak', { prop: p, vx, vz });
    };

    this.setNight(mats.night);
    this.update(0);

    // Phones keep the simple trees. `?flora=0` keeps them anywhere, for comparing.
    if (game.quality.name !== 'low' && new URLSearchParams(location.search).get('flora') !== '0') {
      void loadFlora().then((geo) => { if (geo) this.plantFlora(geo); });
    }
  }

  /** The tree models have arrived: draw them and retire the stand-ins. Collision never changes. */
  private plantFlora(geo: Map<string, THREE.BufferGeometry>): void {
    const p = this.planted;
    // Whatever places.ts asked for (courtyard trees and planting) joins the same field.
    const all: Planting = { kind: p.kind.concat(EXTRA.kind), m: p.m.concat(EXTRA.m), c: p.c.concat(EXTRA.c) };
    this.field = new TreeField(this.root, geo, all, this.game.quality.drawDist);
    for (const inst of [this.trunks, this.blobs, this.palms]) for (const m of inst.meshes) { this.root.remove(m); m.dispose(); }
    this.planted = { kind: [], m: [], c: [] };
    this.field.update(this.game.camera);
  }

  /** Record the matrix in M as one model of `kind`, its leaves tinted `hex`. */
  private plant(kind: string, hex: number, gain = 1): void {
    const p = this.planted;
    p.kind.push(kind);
    for (let i = 0; i < 16; i++) p.m.push(M.elements[i]);
    COL.setHex(hex);
    p.c.push(COL.r * gain, COL.g * gain, COL.b * gain);
  }

  /**
   * Lay a sheared lamp or signal down. It falls square to its own arm, to whichever side
   * the hit was heading, so the arm ends up flat on the ground and not buried or in the air.
   */
  private fell(p: Prop, f: Felled, vx: number, vz: number): void {
    const mesh = f.inst.meshAt(p.x, p.z);
    if (mesh) {
      mesh.getMatrixAt(f.i, M);
      M.decompose(FELL_P, Q, FELL_S);
      const a = FELL_A.set(f.axis === 0 ? 1 : 0, 0, f.axis === 2 ? 1 : 0).applyQuaternion(Q);
      // Turning about a tips "up" toward (-a.z, 0, a.x).
      if (-a.z * vx + a.x * vz < 0) a.negate();
      Q.premultiply(FELL_Q.setFromAxisAngle(a, 1.5));
      FELL_P.x -= a.z * 0.5; FELL_P.z += a.x * 0.5; FELL_P.y += 0.12;
      mesh.setMatrixAt(f.i, M.compose(FELL_P, Q, FELL_S));
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (f.halo >= 0 && this.haloPos) { this.haloPos.setY(f.halo, -900); this.haloPos.needsUpdate = true; }
    const fb = f.sig >= this.sigMain ? this.bulbsMain : this.bulbs;
    if (f.sig >= 0 && fb) {
      const s0 = f.sig >= this.sigMain ? f.sig - this.sigMain : f.sig;
      for (let k = 0; k < 6; k++) fb.setMatrixAt(s0 * 6 + k, ZERO);
      fb.instanceMatrix.needsUpdate = true;
    }
  }

  private mesh(b: Batch, mat: THREE.Material, order = 0): void {
    if (b.empty) return;
    const m = new THREE.Mesh(b.toGeometry(), mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.renderOrder = order;
    this.root.add(m);
  }

  private hideFar(meshes: readonly THREE.Mesh[], lim: number): void {
    for (const m of meshes) {
      const inst = m as THREE.InstancedMesh;
      let sp: THREE.Sphere | null;
      if (inst.isInstancedMesh) { inst.computeBoundingSphere(); sp = inst.boundingSphere; }
      else { m.geometry.computeBoundingSphere(); sp = m.geometry.boundingSphere; }
      if (sp) this.nearOnly.push({ o: m, c: sp.center.clone(), r: sp.radius, lim });
    }
  }

  private claim(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const a = this.claims.get((i + 512) * 1024 + j + 512);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 3) {
        const dx = a[k] - x, dz = a[k + 1] - z, rr = a[k + 2] + r;
        if (dx * dx + dz * dz < rr * rr) return false;
      }
    }
    const key = (cx + 512) * 1024 + cz + 512;
    let a = this.claims.get(key);
    if (!a) this.claims.set(key, (a = []));
    a.push(x, z, r);
    return true;
  }

  // ── Terrain ────────────────────────────────────────────────────────────────

  private terrain(): void {
    const STEP = 8, X0 = -784, Z0 = -608, NX = 196, NZ = 151;
    const pos = new Float32Array((NX + 1) * (NZ + 1) * 3), col = new Float32Array(pos.length);
    const uv = new Float32Array((NX + 1) * (NZ + 1) * 2), sds = new Float32Array((NX + 1) * (NZ + 1));
    // 1 on sand above the waterline, 0 on grass and on the sea floor: the terrain material's cue.
    const sandy = new Float32Array((NX + 1) * (NZ + 1));

    // Tints over the sand texture, by distance from the coast (negative = inland).
    const stops: [number, THREE.Color][] = ([
      [-86, 0x9db074], [-66, 0xc6c98a], [-54, 0xffffff], [-13, 0xf6ecd2], [-4, 0xe4d6b6],
      [2, 0x9fbda0], [26, 0x4f8d86], [80, 0x1c4458],
    ] as [number, number][]).map(([d, hex]) => [d, new THREE.Color(hex)]);
    const dry = new THREE.Color(0xb7b377), lush = new THREE.Color(0x859b5f), c = new THREE.Color();

    let v = 0;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++, v++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP, sd = islandSD(x, z);
        sds[v] = sd;
        // Six centimeters under everything built, so roads and slabs never flicker against it.
        pos[v * 3] = x; pos[v * 3 + 1] = terrainAt(x, z) - 0.06; pos[v * 3 + 2] = z;
        uv[v * 2] = x / TILE_M.sand; uv[v * 2 + 1] = z / TILE_M.sand;

        const n = noise2(x * 0.028 + 9, z * 0.028), n2 = noise2(x * 0.09, z * 0.09 + 31);
        // Ragged bands, and on the south shore the sand runs all the way up to Seawall Dr.
        // The shift must only move the inland stops: applied to the underwater tints it paints sea-floor green on dry sand.
        const base = sd + (n - 0.5) * 16;
        const s = base > -13 ? base : Math.min(base + 44 * smooth((z - 250) / 150), -13);
        let k = 0;
        while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
        const a = stops[k], b = stops[k + 1];
        c.copy(a[1]).lerp(b[1], smooth((s - a[0]) / (b[0] - a[0])));
        if (s < -60) c.lerp(n2 > 0.5 ? dry : lush, Math.abs(n2 - 0.5) * 1.3 * smooth((-60 - s) / 20));
        sandy[v] = clamp((s + 66) / 12, 0, 1) * (1 - clamp(base / 6, 0, 1));
        const g = 0.94 + 0.12 * n2;
        col[v * 3] = c.r * g; col[v * 3 + 1] = c.g * g; col[v * 3 + 2] = c.b * g;
      }
    }

    const idx: number[] = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP;
        // Nothing shows under the paved city, or beyond where the water turns opaque.
        if (x > XW + 1 && x + STEP < XE - 1 && z > ZN + 1 && z + STEP < ZSO - 1) continue;
        const a = j * (NX + 1) + i, b = a + 1, d = a + NX + 1, e = d + 1;
        if (Math.min(sds[a], sds[b], sds[d], sds[e]) > 70) continue;
        idx.push(d, e, b, d, b, a);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aSand', new THREE.BufferAttribute(sandy, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, this.terrainMaterial());
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.root.add(m);
  }

  // ── Sea ────────────────────────────────────────────────────────────────────

  private sea(): void {
    const C = (hex: number): THREE.IUniform => ({ value: new THREE.Color(hex) });
    this.seaU = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uNight: { value: 0 },
      uLight: { value: new THREE.Vector3(0.5, 0.6, 0.62).normalize() },
      uShallow: C(0x43b5a4), uDeep: C(0x1b4f68), uShallowN: C(0x0c2c36), uDeepN: C(0x050b18),
      uFoam: C(0xf7f0dd), uGlint: { value: new THREE.Color() },
      uNoise: { value: this.mats.tex.noise },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.seaU, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG,
      fog: true, transparent: true, depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(9000, 9000);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = WATER_Y;
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    // Before every other see-through thing, so halos and spray are never painted over by water behind them.
    m.renderOrder = -2;
    m.name = 'sea';
    this.root.add(m);
  }

  // ── Streets, paint and blocks ──────────────────────────────────────────────

  private surfaces(): void {
    const plan = this.plan, mats = this.mats;
    const street = new Batch(), avenue = new Batch(), marks = new Batch(), curb = new Batch();
    const surf: Record<Surface, Batch> = { sidewalk: new Batch(), grass: new Batch(), asphalt: new Batch(), cobble: new Batch(), wood: new Batch() };
    const tile: Record<Surface, number> = { sidewalk: TILE_M.sidewalk, grass: TILE_M.grass, asphalt: TILE_M.asphalt, cobble: TILE_M.cobble, wood: TILE_M.wood };
    const rng = new RNG(5501);
    const PAINT = 0xefe9da;

    for (const e of plan.edges) {
      if (e.land) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const from = e.horiz ? A.hx : A.hz, len = e.len - from - (e.horiz ? B.hx : B.hz);
      const b = e.hw === AVE_HW ? avenue : street;
      if (e.horiz) gq(b, A.x + from, A.z, Math.PI / 2, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
      else gq(b, A.x, A.z + from, 0, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
    }

    const cross = mats.tex.marks.rect('crosswalk'), stop = mats.tex.marks.rect('stopline');
    const arrow = mats.tex.marks.rect('arrow'), manhole = mats.tex.marks.rect('manhole'), stain = mats.tex.marks.rect('stain');
    for (const n of plan.nodes) {
      if (n.land) continue;
      wf(surf.asphalt, n.x - n.hx, n.z - n.hz, n.x + n.hx, n.z + n.hz, 0, 0xffffff, TILE_M.asphalt);
      if (n.hx > 0 && n.hz > 0 && rng.chance(0.7)) {
        const mx = n.x + rng.range(-0.5, 0.5) * n.hx, mz = n.z + rng.range(-0.5, 0.5) * n.hz;
        gq(marks, mx, mz, 0, -0.5, 0.5, -0.5, 0.5, 0, 0xffffff, manhole.u0, manhole.v0, manhole.u1, manhole.v1);
      }
      if (!n.hasLight) continue;
      for (const eid of n.edges) {
        const e = plan.edges[eid];
        if (e.deck) continue;
        // Heading that leaves the intersection along this street.
        const away = e.horiz ? (e.a === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.a === n.id ? 0 : Math.PI);
        const half = e.horiz ? n.hx : n.hz;
        const ox = n.x + Math.sin(away) * half, oz = n.z + Math.cos(away) * half;
        gq(marks, ox, oz, away, -e.hw, e.hw, 0.9, 3.9, 0, PAINT, -e.hw / MARKS.tileM, cross.v0, e.hw / MARKS.tileM, cross.v1);
        // Traffic coming in keeps to its right, which is this frame's left.
        const lanes = e.lanes * 3.5;
        gq(marks, ox, oz, away, -lanes, 0, 4.8, 5.3, 0, PAINT, 0, stop.v0, lanes / MARKS.tileM, stop.v1);
        if (e.lanes === 2) for (const lane of [-1.8, -5.2]) {
          // v is flipped so the arrow points at the intersection.
          gq(marks, ox, oz, away, lane - 0.7, lane + 0.7, 8.5, 11.9, 0, PAINT, arrow.u0, arrow.v1, arrow.u1, arrow.v0);
        }
      }
    }

    const CW = 0.3, STONE = 0xd6cfbe;
    for (const b of plan.blocks) {
      if (b.land) continue;
      const r = b.rect, road = b.road;
      const r1 = inset(r, road, CW), r2 = inset(r, road, SIDEWALK);
      ring(r, r1, (x0, z0, x1, z1) => curb.floor(x0, z0, x1, z1, CURB, STONE));
      // Curb faces start below the road so no sliver of daylight shows under them.
      const y0 = -0.08;
      if (road[0]) curb.quad(r.x1, y0, r.z0, r.x0, y0, r.z0, r.x0, CURB, r.z0, r.x1, CURB, r.z0, STONE, 0, 0, 1, 1, 0.78);
      if (road[2]) curb.quad(r.x0, y0, r.z1, r.x1, y0, r.z1, r.x1, CURB, r.z1, r.x0, CURB, r.z1, STONE, 0, 0, 1, 1, 0.78);
      if (road[1]) curb.quad(r.x1, y0, r.z1, r.x1, y0, r.z0, r.x1, CURB, r.z0, r.x1, CURB, r.z1, STONE, 0, 0, 1, 1, 0.78);
      if (road[3]) curb.quad(r.x0, y0, r.z0, r.x0, y0, r.z1, r.x0, CURB, r.z1, r.x0, CURB, r.z0, STONE, 0, 0, 1, 1, 0.78);
      ring(r1, r2, (x0, z0, x1, z1) => wf(surf.sidewalk, x0, z0, x1, z1, CURB, 0xffffff, TILE_M.sidewalk));
      const [kind, hex] = FILL[b.district];
      wf(surf[kind], r2.x0, r2.z0, r2.x1, r2.z1, CURB, hex, tile[kind]);

      // Working yards are never clean.
      if (b.district === 'industrial' || b.district === 'port' || b.district === 'arena') {
        for (let k = 0; k < 7; k++) {
          const sx = rng.range(r2.x0 + 6, r2.x1 - 6), sz = rng.range(r2.z0 + 6, r2.z1 - 6), s = rng.range(1.6, 4);
          gq(marks, sx, sz, rng.range(0, TAU), -s, s, -s, s, CURB, 0xffffff, stain.u0, stain.v0, stain.u1, stain.v1);
        }
      }
    }

    // Outside the perimeter streets a flush concrete shoulder finishes the road edge.
    // It stays at street height because groundAt() says the ground out there is 0.
    const sh = 0xe9dfc6, t = TILE_M.sidewalk, sw = surf.sidewalk;
    const bx0 = BRIDGE.x - BRIDGE.hw, bx1 = BRIDGE.x + BRIDGE.hw;
    wf(sw, XW - SHOULDER, ZN - SHOULDER, bx0, ZN, 0, sh, t);
    wf(sw, bx1, ZN - SHOULDER, XE + SHOULDER, ZN, 0, sh, t);
    wf(sw, XW - SHOULDER, ZSO, PIER.x0, ZSO + SHOULDER, 0, sh, t);
    wf(sw, PIER.x1, ZSO, XE + SHOULDER, ZSO + SHOULDER, 0, sh, t);
    wf(sw, XW - SHOULDER, ZN, XW, ZSO, 0, sh, t);
    wf(sw, XE, ZN, XE + SHOULDER, BREAKWATER.z0, 0, sh, t);
    wf(sw, XE, BREAKWATER.z1, XE + SHOULDER, ZSO, 0, sh, t);
    // The three ways off the grid: road to the foot of the bridge, planks to the pier, a causeway to the breakwater.
    const bl = ZN - BRIDGE.z0;
    gq(avenue, BRIDGE.x, ZN, Math.PI, -BRIDGE.hw, BRIDGE.hw, 0, bl, 0, 0xffffff, 0, 0, 1, bl / TILE_M.avenue);
    wf(surf.wood, PIER.x0, ZSO, PIER.x1, PIER.z0, 0, 0xffffff, TILE_M.wood);
    wf(sw, XE, BREAKWATER.z0, BREAKWATER.x0, BREAKWATER.z1, 0, 0xd8d0bc, t);

    this.mesh(street, mats.street);
    this.mesh(avenue, mats.avenue);
    this.mesh(curb, mats.flat);
    this.mesh(surf.sidewalk, mats.sidewalk);
    this.mesh(surf.grass, mats.grass);
    this.mesh(surf.asphalt, mats.asphalt);
    this.mesh(surf.cobble, mats.cobble);
    this.mesh(surf.wood, mats.wood);
    this.mesh(marks, mats.marks);
  }

  // ── Traffic signals ────────────────────────────────────────────────────────

  private signals(): void {
    const plan = this.plan;
    const ARM = [5.0, 7.25];   // street: head over the one lane; avenue: over the line between the two
    const masts = ARM.map((a) => new Inst(signalGeo(a), this.propMat, REGION));
    const bulbM: number[] = [];

    let seenMain = false;
    for (const n of plan.nodes) {
      if (!n.hasLight) continue;
      // Nodes are in order, the island's first: everything from here on is the mainland's.
      if (n.land && !seenMain) { seenMain = true; this.sigMain = this.sigNode.length; }
      for (const eid of n.edges) {
        const e = plan.edges[eid];
        if (e.deck) continue;
        // Traffic on this street arriving here travels along heading hd. Its mast stands on
        // the far right corner with the arm reaching back over its lanes, heads facing it.
        const hd = e.horiz ? (e.b === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.b === n.id ? 0 : Math.PI);
        const dx = Math.sin(hd), dz = Math.cos(hd), rx = -dz, rz = dx;
        const along = (e.horiz ? n.hx : n.hz) + 0.75, across = e.hw + 0.75;
        const px = n.x + dx * along + rx * across, pz = n.z + dz * along + rz * across;
        const y = groundAt(px, pz), hs = hd + Math.PI, wide = e.lanes === 2 ? 1 : 0;
        xf(px, y, pz, hs);
        const mi = masts[wide].add(px, pz);
        this.claim(px, pz, 1.2);
        const sp = this.game.col.addProp(px, pz, 0.2, y + 6.2, 'signal', false);
        sp.hard = true;
        this.felled.set(sp, { inst: masts[wide], i: mi, axis: 0, halo: -1, sig: this.sigNode.length });

        // Model space to world: +X is (cos hs, -sin hs), +Z is (sin hs, cos hs).
        const cs = Math.cos(hs), sn = Math.sin(hs);
        for (let head = 0; head < 2; head++) {
          const lx = head === 0 ? -ARM[wide] : 0, lz = HEAD_Z[head];
          for (let l = 0; l < 3; l++) {
            xf(px + lx * cs + lz * sn, y + HEAD_Y[head] + 1.0 - l * 0.375, pz - lx * sn + lz * cs, hs);
            for (let k = 0; k < 16; k++) bulbM.push(M.elements[k]);
          }
        }
        this.sigNode.push(n.id);
        this.sigHoriz.push(e.horiz);
      }
    }
    for (const m of masts) { m.build(this.root, true); this.hideFar(m.meshes, 330); }

    const count = this.sigNode.length;
    if (!seenMain) this.sigMain = count;
    this.sigLast = new Int8Array(count).fill(-1);
    for (let l = 0; l < 3; l++) {
      COL.setHex(LIT[l]).toArray(this.litC, l * 3);
      COL.setHex(DIM[l]).toArray(this.dimC, l * 3);
    }
    if (!count) return;
    // Unlit material: a signal lamp is its own light, day or night.
    const geo = new THREE.CircleGeometry(0.15, 12), mat = new THREE.MeshBasicMaterial({ fog: true });
    const make = (from: number, to: number): THREE.InstancedMesh | null => {
      if (to <= from) return null;
      const bulbs = new THREE.InstancedMesh(geo, mat, (to - from) * 6);
      bulbs.instanceMatrix.array.set(bulbM.slice(from * 96, to * 96));
      bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((to - from) * 18), 3);
      bulbs.matrixAutoUpdate = false;
      this.root.add(bulbs);
      return bulbs;
    };
    this.bulbs = make(0, this.sigMain);
    this.bulbsMain = make(this.sigMain, count);
    if (this.bulbsMain) this.mainOnly.push(this.bulbsMain);
  }

  // ── Street lamps ───────────────────────────────────────────────────────────

  private streetLamps(): void {
    const plan = this.plan;
    for (const e of plan.edges) {
      if (e.deck) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const s0 = (e.horiz ? A.hx : A.hz) + 9, s1 = e.len - (e.horiz ? B.hx : B.hz) - 9;
      const count = Math.max(2, Math.round((s1 - s0) / 32) + 1);
      for (let k = 0; k < count; k++) {
        const s = s0 + ((s1 - s0) * k) / (count - 1);
        const side = (k + e.id) % 2 ? 1 : -1, off = side * (e.hw + STRIP);
        const x = e.horiz ? A.x + s : A.x + off, z = e.horiz ? A.z + off : A.z + s;
        // The arm points back at the middle of the road.
        const h = e.horiz ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        // Not in front of the one door in town that matters (ROOM 404, on Eel Alley).
        if (Math.abs(x + 129.3) < 6 && Math.abs(z - 126.7) < 5) continue;
        // No lamp posts standing in a river (Trestle St's bridge), or on the tracks.
        if (e.land && waterDist(x, z) < 26) continue;
        if (keepOut(x, z) || !this.claim(x, z, 1.0)) continue;
        this.lamp(x, z, h);
      }
    }
  }

  private lamp(x: number, z: number, h: number): void {
    const y = groundAt(x, z);
    xf(x, y, z, h);
    const li = this.lamps.add(x, z);
    const lp = this.game.col.addProp(x, z, 0.18, y + 6.5, 'lamp', false);
    lp.hard = true;
    this.felled.set(lp, { inst: this.lamps, i: li, axis: 2, halo: this.halos.length / 3, sig: -1 });
    const fx = Math.sin(h), fz = Math.cos(h);
    this.halos.push(x + fx * LAMP_REACH, y + LAMP_H, z + fz * LAMP_REACH);
    // The pool of light is centered under the head and cut at the curb line: the part on the
    // road lies on the road, the part behind lies on the sidewalk, and the UVs keep it one disc.
    const R = 9, n0 = LAMP_REACH - R, n1 = LAMP_REACH + R, cut = (STRIP - n0) / (n1 - n0);
    if (z < MAIN_SPLIT_Z) {
      // On the mainland the road is at the plateau's height, and on the hill it slopes: lifted a finger so it never dips under.
      const lift = hillAt(x, z) > 0 ? 0.04 : 0;
      gqh(this.pools, x, z, h, -R, R, STRIP, n1, lift, SODIUM, 0, cut, 1, 1, 0.5);
      gqh(this.pools, x, z, h, -R, R, n0, STRIP, CURB + lift, SODIUM, 0, 0, 1, cut, 0.5);
      return;
    }
    gq(this.pools, x, z, h, -R, R, STRIP, n1, 0, SODIUM, 0, cut, 1, 1, 0.5);
    gq(this.pools, x, z, h, -R, R, n0, STRIP, y, SODIUM, 0, 0, 1, cut, 0.5);
  }

  /** Light pools and halos: both invisible by day, faded in by setNight. */
  private lights(): void {
    // The shared glow material has no polygon offset, and a pool has to lie exactly on the road.
    this.poolMat = this.mats.glow.clone();
    this.poolMat.polygonOffset = true;
    this.poolMat.polygonOffsetFactor = -3;
    this.poolMat.polygonOffsetUnits = -6;
    // From eye height a pool is seen at a grazing angle, and the small mip levels of a radial
    // gradient are one flat colour: the disc became an orange rectangle with ruled edges.
    const pm = this.poolMat.map;
    if (pm) { pm.generateMipmaps = false; pm.minFilter = THREE.LinearFilter; pm.needsUpdate = true; }
    if (!this.pools.empty) {
      const m = new THREE.Mesh(this.pools.toGeometry(), this.poolMat);
      m.matrixAutoUpdate = false;
      m.renderOrder = 1;
      this.root.add(m);
    }
    // True billboards for the price of one draw call. Not fogged: far lamps prick through the haze.
    this.haloMat = new THREE.PointsMaterial({
      map: this.mats.tex.glow, color: SODIUM, size: 7.5, sizeAttenuation: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true, opacity: 0,
    });
    // Additive light must not mix toward a bright fog colour (that adds white); it just dims, slower than geometry does.
    this.haloMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fa = exp(-fogDensity * vFogDepth * 0.35);
        #else
          float fa = 1.0 - smoothstep(fogNear, fogFar * 1.5, vFogDepth);
        #endif
        gl_FragColor.rgb *= fa; gl_FragColor.a *= fa;
      #endif`);
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.halos, 3));
    this.haloPos = g.getAttribute('position') as THREE.BufferAttribute;
    const pts = new THREE.Points(g, this.haloMat);
    pts.matrixAutoUpdate = false;
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    this.root.add(pts);
    this.halos = [];
    this.pools = new Batch();
  }

  // ── Sidewalk furniture ─────────────────────────────────────────────────────

  /** Walk the curb strip of every street-facing side of a block. `inward` is the heading from the curb into the block. */
  private eachSide(b: Block, fn: (len: number, at: (s: number, d: number) => [number, number], inward: number, avenue: boolean) => void): void {
    const r = b.rect;
    for (let side = 0; side < 4; side++) {
      if (!b.road[side]) continue;
      const ew = side % 2 === 0;
      const len = ew ? r.x1 - r.x0 : r.z1 - r.z0;
      const inward = [0, -Math.PI / 2, Math.PI, Math.PI / 2][side];
      const avenue = b.ave[side];
      fn(len, (s, d) => [
        ew ? r.x0 + s : side === 1 ? r.x1 - d : r.x0 + d,
        ew ? (side === 0 ? r.z0 + d : r.z1 - d) : r.z0 + s,
      ], inward, avenue);
    }
  }

  private furniture(): void {
    const rng = new RNG(7310), col = this.game.col;
    for (const b of this.plan.blocks) {
      const [odds, fill] = FURN_MIX[b.district];
      const total = odds.reduce((a, v) => a + v, 0);
      this.eachSide(b, (len, at, inward, avenue) => {
        let busStop = false;
        for (let s = rng.range(6, 11); s < len - 6; s += rng.range(7, 12)) {
          // Every number is drawn whether or not the spot is used, so a lower
          // density thins the street out without rearranging it.
          let pick = rng.next() * total, kind = 0;
          while (kind < odds.length - 1 && pick > odds[kind]) pick -= odds[kind++];
          const keep = rng.next() < fill * this.den, tint = rng.pick(NEWS_COLORS), turn = rng.range(-0.12, 0.12);
          if (kind === POST && (busStop || !avenue)) kind = BIN;
          if (!keep) continue;
          const [x, z] = at(s, STRIP);
          const [pk, pr, ph, breakable] = FURN[kind];
          // The bench claims its full length even though it collides as less.
          if (keepOut(x, z) || !this.claim(x, z, (kind === BENCH ? 0.75 : pr) + 0.5)) continue;
          if (kind === POST) busStop = true;
          const y = groundAt(x, z);
          xf(x, y, z, inward + turn);
          const i = this.furn[kind].add(x, z, kind === NEWS ? tint : 0xffffff);
          const slot = this.slotProp.length;
          this.slotKind.push(kind); this.slotIdx.push(i);
          const fp = col.addProp(x, z, pr, y + ph, pk, breakable, slot);
          fp.hard = kind === BENCH;
          this.slotProp.push(fp);
        }
      });
    }
  }

  // ── Trees ──────────────────────────────────────────────────────────────────

  private trees(): void {
    const plan = this.plan, den = this.den;
    const rng = new RNG(9127);

    // Street trees, in the curb strip between the lamps and the furniture.
    for (const b of plan.blocks) {
      if (b.land) continue;
      const [species, gap, share] = STREET_TREES[b.district];
      this.eachSide(b, (len, at) => {
        for (let s = gap * 0.5; s < len - 4; s += gap) {
          const j = rng.range(-1.5, 1.5), keep = rng.next() < share && rng.next() < den, alt = rng.next();
          if (!keep) continue;
          const [x, z] = at(s + j, STRIP + 0.2);
          const sp = species === 'maple' && alt < 0.12 ? 'cypress' : species;
          // Palm crowns hang in front of sign boards; the spawn-side WDOOF board is the first one a player sees.
          if (sp === 'palm' && Math.abs(x - 52) < 12 && Math.abs(z - 302) < 12) continue;
          if (!keepOut(x, z) && this.claim(x, z, 1.7)) this.tree(sp, x, z, rng);
        }
      });
    }

    // Gull Heights: a tree wherever back yards meet. A lot corner is the one spot a house cannot be standing on.
    for (const lot of plan.lots) {
      if (lot.district !== 'suburb') continue;
      const r = lot.rect;
      for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) {
        const keep = rng.next() < 0.85 * den, alt = rng.next();
        if (keep && !keepOut(x, z) && this.claim(x, z, 3.5)) this.tree(alt < 0.2 ? 'cypress' : alt < 0.55 ? 'oak' : 'maple', x, z, rng);
      }
    }

    // Mercy Park: clumps on a jittered grid, thicker toward the edges, clear of the pond, the promenade and the ramp run.
    const G = 11;
    for (let x = 96; x < 292; x += G) for (let z = -206; z < -34; z += G) {
      const px = x + rng.range(0, G - 2), pz = z + rng.range(0, G - 2), roll = rng.next(), alt = rng.next();
      const edge = Math.min(px - 90, 296 - px, pz + 210, -30 - pz);
      const want = (0.2 + 0.55 * smooth(noise2(px * 0.045, pz * 0.045) * 1.6 - 0.3) + 0.3 * smooth(1 - edge / 26)) * den;
      if (roll > want || keepOut(px, pz) || !this.claim(px, pz, 3.2)) continue;
      this.tree(alt < 0.16 ? 'cypress' : alt < 0.4 ? 'maple' : 'oak', px, pz, rng);
    }

    // Low Tide Beach: a row of palms along the Seawall Dr shoulder, and loose pairs further down the sand.
    for (let x = -350; x < 304; x += 16) {
      const px = x + rng.range(-3, 3), keep = rng.next() < den, pair = rng.next() < 0.22 * den, ox = rng.range(-8, 8), oz = rng.range(20, 36);
      if (keep && !keepOut(px, ZSO + 4.4) && islandSD(px, ZSO + 4.4) < -40) this.tree('palm', px, ZSO + 4.4, rng);
      if (pair && !keepOut(px + ox, ZSO + oz) && islandSD(px + ox, ZSO + oz) < -34) {
        this.tree('palm', px + ox, ZSO + oz, rng);
        if (!keepOut(px + ox + 3.5, ZSO + oz + 2.5)) this.tree('palm', px + ox + 3.5, ZSO + oz + 2.5, rng);
      }
    }

    // The scrub between the outer streets and the dunes: scattered and wind-bent, none on the beach or the port's waterfront.
    for (let x = -712; x < 712; x += 26) for (let z = -548; z < ZSO; z += 26) {
      const px = x + rng.range(0, 20), pz = z + rng.range(0, 20), roll = rng.next(), alt = rng.next();
      const outside = px < XW - 9 || px > XE + 9 || pz < ZN - 9;
      if (!outside || roll > 0.5 * den || (px > XE && pz > 150) || islandSD(px, pz) > -66 || keepOut(px, pz)) continue;
      this.tree(alt < 0.45 ? 'cypress' : alt < 0.75 ? 'oak' : 'maple', px, pz, rng);
    }
    this.mainTrees();
  }

  // ── The mainland ───────────────────────────────────────────────────────────

  /** Add a mesh that belongs to the far shore: drawn only when the camera is within sight of it. */
  private far(m: THREE.Mesh, order = 0): THREE.Mesh {
    m.matrixAutoUpdate = false;
    m.renderOrder = order;
    this.root.add(m);
    this.mainOnly.push(m);
    return m;
  }

  private meshM(b: Batch, mat: THREE.Material, order = 0, cast = false): void {
    if (b.empty) return;
    const m = new THREE.Mesh(b.toGeometry(), mat);
    m.receiveShadow = true; m.castShadow = cast;
    this.far(m, order);
  }

  /** Beach, bluff, plateau, riverbanks and countryside: one grid like the island's, cut into bands so the frustum can drop most of it. */
  private mainTerrain(): void {
    const STEP = 8, X0 = -976, Z0 = -2528, NX = 250, NZ = 212, W = NX + 1, BANDS = 4;
    const pos = new Float32Array(W * (NZ + 1) * 3), col = new Float32Array(pos.length);
    const uv = new Float32Array(W * (NZ + 1) * 2), sds = new Float32Array(W * (NZ + 1)), sandy = new Float32Array(W * (NZ + 1));
    const stops: [number, THREE.Color][] = ([
      [-86, 0x9db074], [-66, 0xc6c98a], [-54, 0xffffff], [-13, 0xf6ecd2], [-4, 0xe4d6b6],
      [2, 0x9fbda0], [26, 0x4f8d86], [80, 0x1c4458],
    ] as [number, number][]).map(([d, hex]) => [d, new THREE.Color(hex)]);
    const dry = new THREE.Color(0xb7b377), lush = new THREE.Color(0x859b5f), bank = new THREE.Color(0x8d8468), bed = new THREE.Color(0x4a5f58), c = new THREE.Color();
    let v = 0;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++, v++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP, sd = coastSD(x, z), wd = waterDist(x, z);
        sds[v] = Math.max(sd, -wd);
        pos[v * 3] = x; pos[v * 3 + 1] = mainlandTerrain(x, z) - 0.06; pos[v * 3 + 2] = z;
        uv[v * 2] = x / TILE_M.sand; uv[v * 2 + 1] = z / TILE_M.sand;
        const n = noise2(x * 0.028 + 9, z * 0.028), n2 = noise2(x * 0.09, z * 0.09 + 31);
        // The bluff is grass and the sand starts at its foot: the island's inland bands, squeezed into the thirty meters above the beach.
        const base = sd + (n - 0.5) * 10;
        const s = base > -13 ? base : -13 + (base + 13) * 2.4;
        let k = 0;
        while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
        const a = stops[k], b = stops[k + 1];
        c.copy(a[1]).lerp(b[1], smooth((s - a[0]) / (b[0] - a[0])));
        if (s < -60) c.lerp(n2 > 0.5 ? dry : lush, Math.abs(n2 - 0.5) * 1.3 * smooth((-60 - s) / 20));
        sandy[v] = clamp((s + 66) / 12, 0, 1) * (1 - clamp(base / 6, 0, 1));
        // Riverbanks: earth and stone down to the water, dark silt under it.
        if (wd < 24) { const t = smooth((24 - wd) / 20); c.lerp(wd < 0.5 ? bed : bank, t * 0.85); sandy[v] *= 1 - t; }
        const g = 0.94 + 0.12 * n2;
        col[v * 3] = c.r * g; col[v * 3 + 1] = c.g * g; col[v * 3 + 2] = c.b * g;
      }
    }
    const bands: number[][] = [];
    for (let k = 0; k < BANDS; k++) bands.push([]);
    const all: number[] = [];
    const inside = (r: Rect, x: number, z: number): boolean => x > r.x0 + 1 && x + STEP < r.x1 - 1 && z > r.z0 + 1 && z + STEP < r.z1 - 1;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const x = X0 + i * STEP, z = Z0 + j * STEP;
        if (inside(TOWN_A, x, z) || inside(TOWN_B, x, z)) continue;
        const a = j * W + i, b = a + 1, d = a + W, e = d + 1;
        if (Math.min(sds[a], sds[b], sds[d], sds[e]) > 70) continue;
        all.push(d, e, b, d, b, a);
        bands[Math.min(BANDS - 1, Math.floor((j * BANDS) / NZ))].push(d, e, b, d, b, a);
      }
    }
    // Normals from the whole grid, so no seam shows where two bands meet.
    const full = new THREE.BufferGeometry();
    const attrs: Record<string, THREE.BufferAttribute> = {
      position: new THREE.BufferAttribute(pos, 3), color: new THREE.BufferAttribute(col, 3),
      uv: new THREE.BufferAttribute(uv, 2), aSand: new THREE.BufferAttribute(sandy, 1),
    };
    for (const k in attrs) full.setAttribute(k, attrs[k]);
    full.setIndex(all);
    full.computeVertexNormals();
    const mat = this.sandMat ?? this.terrainMaterial();
    const hx = (NX * STEP) / 2, hz = (NZ * STEP) / BANDS / 2;
    for (let k = 0; k < BANDS; k++) {
      const geo = new THREE.BufferGeometry();
      for (const name in attrs) geo.setAttribute(name, attrs[name]);
      geo.setAttribute('normal', full.getAttribute('normal'));
      geo.setIndex(bands[k]);
      const center = new THREE.Vector3(X0 + hx, 4, Z0 + hz * (2 * k + 1));
      geo.boundingSphere = new THREE.Sphere(center, Math.hypot(hx, hz) + 24);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.name = 'mainland-terrain';
      this.root.add(m);
      this.mainOnly.push(m);
    }
  }

  /** The mill pond above Threadbare Dam, the sheet of water over its crest, and the foam below. */
  private mainWater(): void {
    const pos: number[] = [], edge: number[] = [], foam: number[] = [], idx: number[] = [];
    const row = (z: number, y: number, half: number, eSide: number, eMid: number, f: number): number => {
      const x = riverX(z);
      pos.push(x - half, y, z, x, y, z, x + half, y, z);
      edge.push(eSide, eMid, eSide); foam.push(f, f, f);
      return pos.length / 3 - 3;
    };
    const strip = (a: number, b: number): void => { idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); };
    const zc = DAM_Z - 1.5;
    let prev = -1;
    for (let z = -2528; ; z += 12) {
      const r = row(Math.min(z, zc), POND_Y, RIVER_HW + 8, 0, 1, 0);
      if (prev >= 0) strip(prev, r);
      prev = r;
      if (z >= zc) break;
    }
    const c0 = row(zc, POND_Y, RIVER_HW + 2, 1, 1, 0.3), c1 = row(DAM_Z + 1.6, POND_Y - 0.04, RIVER_HW + 2, 1, 1, 0.85), c2 = row(DAM_Z + 7, WATER_Y + 0.07, RIVER_HW + 2, 1, 1, 1);
    strip(c0, c1); strip(c1, c2);
    // Below the falls only the white is drawn (edge 0), over the tidal river the sea shader already paints.
    const a0 = row(DAM_Z + 7, WATER_Y + 0.06, RIVER_HW + 2, 0, 0, 1), a1 = row(DAM_Z + 22, WATER_Y + 0.05, RIVER_HW + 2, 0, 0, 0.6), a2 = row(DAM_Z + 52, WATER_Y + 0.04, RIVER_HW + 2, 0, 0, 0);
    strip(a0, a1); strip(a1, a2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    geo.setAttribute('aFoam', new THREE.Float32BufferAttribute(foam, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.seaU, vertexShader: RIVER_VERT, fragmentShader: RIVER_FRAG,
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.name = 'mill-pond';
    this.far(m, -1);
  }

  /** Tepid Falls' streets, paint and blocks: the island's recipe, laid at the plateau's height and bent over the hill. */
  private mainSurfaces(): void {
    const plan = this.plan, mats = this.mats;
    const street = new Batch(), avenue = new Batch(), marks = new Batch(), curb = new Batch();
    const surf: Record<Surface, Batch> = { sidewalk: new Batch(), grass: new Batch(), asphalt: new Batch(), cobble: new Batch(), wood: new Batch() };
    const tile: Record<Surface, number> = { sidewalk: TILE_M.sidewalk, grass: TILE_M.grass, asphalt: TILE_M.asphalt, cobble: TILE_M.cobble, wood: TILE_M.wood };
    const rng = new RNG(5502);
    const PAINT = 0xefe9da;

    for (const e of plan.edges) {
      if (!e.land || e.deck) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const from = e.horiz ? A.hx : A.hz, len = e.len - from - (e.horiz ? B.hx : B.hz);
      const b = e.hw === AVE_HW ? avenue : street;
      if (e.horiz) gqh(b, A.x + from, A.z, Math.PI / 2, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
      else gqh(b, A.x, A.z + from, 0, -e.hw, e.hw, 0, len, 0, 0xffffff, 0, 0, 1, len / TILE_M.street);
    }

    const cross = mats.tex.marks.rect('crosswalk'), stop = mats.tex.marks.rect('stopline');
    const arrow = mats.tex.marks.rect('arrow'), manhole = mats.tex.marks.rect('manhole'), stain = mats.tex.marks.rect('stain');
    for (const n of plan.nodes) {
      if (!n.land) continue;
      wfh(surf.asphalt, n.x - n.hx, n.z - n.hz, n.x + n.hx, n.z + n.hz, 0, 0xffffff, TILE_M.asphalt);
      if (n.hx > 0 && n.hz > 0 && rng.chance(0.7)) {
        const mx = n.x + rng.range(-0.5, 0.5) * n.hx, mz = n.z + rng.range(-0.5, 0.5) * n.hz;
        gqh(marks, mx, mz, 0, -0.5, 0.5, -0.5, 0.5, 0, 0xffffff, manhole.u0, manhole.v0, manhole.u1, manhole.v1);
      }
      if (!n.hasLight) continue;
      for (const eid of n.edges) {
        const e = plan.edges[eid];
        if (e.deck) continue;
        const away = e.horiz ? (e.a === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.a === n.id ? 0 : Math.PI);
        const half = e.horiz ? n.hx : n.hz;
        const ox = n.x + Math.sin(away) * half, oz = n.z + Math.cos(away) * half;
        gqh(marks, ox, oz, away, -e.hw, e.hw, 0.9, 3.9, 0, PAINT, -e.hw / MARKS.tileM, cross.v0, e.hw / MARKS.tileM, cross.v1);
        const lanes = e.lanes * 3.5;
        gqh(marks, ox, oz, away, -lanes, 0, 4.8, 5.3, 0, PAINT, 0, stop.v0, lanes / MARKS.tileM, stop.v1);
        if (e.lanes === 2) for (const lane of [-1.8, -5.2]) {
          gqh(marks, ox, oz, away, lane - 0.7, lane + 0.7, 8.5, 11.9, 0, PAINT, arrow.u0, arrow.v1, arrow.u1, arrow.v0);
        }
      }
    }

    const CW = 0.3, STONE = 0xd6cfbe;
    for (const b of plan.blocks) {
      if (!b.land) continue;
      const r = b.rect, road = b.road;
      const r1 = inset(r, road, CW), r2 = inset(r, road, SIDEWALK);
      ring(r, r1, (x0, z0, x1, z1) => wfh(curb, x0, z0, x1, z1, CURB, STONE, 1));
      if (road[0]) vfh(curb, r.x1, r.z0, r.x0, r.z0, -0.08, CURB, STONE, 0.78);
      if (road[2]) vfh(curb, r.x0, r.z1, r.x1, r.z1, -0.08, CURB, STONE, 0.78);
      if (road[1]) vfh(curb, r.x1, r.z1, r.x1, r.z0, -0.08, CURB, STONE, 0.78);
      if (road[3]) vfh(curb, r.x0, r.z0, r.x0, r.z1, -0.08, CURB, STONE, 0.78);
      ring(r1, r2, (x0, z0, x1, z1) => wfh(surf.sidewalk, x0, z0, x1, z1, CURB, 0xffffff, TILE_M.sidewalk));
      const [kind, hex] = FILL[b.district];
      wfh(surf[kind], r2.x0, r2.z0, r2.x1, r2.z1, CURB, hex, tile[kind]);
      if (b.district === 'yard' || b.district === 'mill' || b.district === 'exits') {
        for (let k = 0; k < 5; k++) {
          const sx = rng.range(r2.x0 + 6, r2.x1 - 6), sz = rng.range(r2.z0 + 6, r2.z1 - 6), s = rng.range(1.6, 4);
          gqh(marks, sx, sz, rng.range(0, TAU), -s, s, -s, s, CURB, 0xffffff, stain.u0, stain.v0, stain.u1, stain.v1);
        }
      }
    }

    // The ways off the grid: the bridge's landing, the Thruway running out of funding to the north, and the footpaths to the footbridge.
    const zs = MZS[MZS.length - 1] + ST_HW_M, ll = bridgeFullEnd() - zs;
    gqh(avenue, BRIDGE.x, zs, 0, -BRIDGE.hw, BRIDGE.hw, 0, ll, 0, 0xffffff, 0, 0, 1, ll / TILE_M.avenue);
    gqh(avenue, MXS[0], MZS[0] - ST_HW_M, Math.PI, -AVE_HW, AVE_HW, 0, 226, 0, 0xffffff, 0, 0, 1, 226 / TILE_M.avenue);
    const sw = surf.sidewalk, t = TILE_M.sidewalk, pz = FOOTBRIDGE_Z;
    wfh(sw, MXS[8] + ST_HW_M, pz - 1.4, FOOTBRIDGE.x0, pz + 1.4, 0.02, 0xd8d0bc, t);
    wfh(sw, FOOTBRIDGE.x1, pz - 1.4, 652, pz + 1.4, 0.02, 0xd8d0bc, t);

    this.meshM(street, mats.street);
    this.meshM(avenue, mats.avenue);
    this.meshM(curb, mats.flat);
    this.meshM(surf.sidewalk, mats.sidewalk);
    this.meshM(surf.grass, mats.grass);
    this.meshM(surf.asphalt, mats.asphalt);
    this.meshM(surf.cobble, mats.cobble);
    this.meshM(marks, mats.marks);
  }

  /** What stands in or over the water, and the railway: Trestle St's bridge, the footbridge, the dam, the tracks, the Thruway's divider. */
  private mainStructures(): void {
    const plan = this.plan, col = this.game.col, flat = new Batch();
    const CONC = 0xcbc4b2, IRON_C = 0x4f5a63, TIMB = 0x6b5440, RAILC = 0x54585e, BALLAST = 0x7d776c, Y = MAIN_Y;

    // Trestle St over the river: a slab on three piers with solid parapets.
    const rb = ROAD_BRIDGE, zc = (rb.z0 + rb.z1) / 2, rxm = riverX(zc);
    const bx0 = rxm - RIVER_HW - 26, bx1 = rxm + RIVER_HW + 26;
    flat.box((bx0 + bx1) / 2, Y - 1.1, zc, bx1 - bx0, 1.08, 13.2, CONC, 0, 6);
    for (const k of [-0.75, 0, 0.75]) flat.box(rxm + k * RIVER_HW, -4, zc, 2.2, Y + 2.9, 11, CONC, 0, 4);
    for (const sg of [-1, 1]) {
      const z = zc + sg * 6.3;
      flat.box((bx0 + bx1) / 2, Y, z, bx1 - bx0 + 8, 1.0, 0.6, CONC, 0, 5);
      col.addBox(bx0 - 4, z - 0.3, bx1 + 4, z + 0.3, Y + 1.2, Y - 1.5);
    }

    // The Exact Change Footbridge: a plank deck hung from two pairs of posts. Bollards keep cars off it.
    const fb = FOOTBRIDGE, fz = FOOTBRIDGE_Z, fl = fb.x1 - fb.x0, T0 = fb.x0 + 7, T1 = fb.x1 - 7, TOP = Y + 9.5;
    flat.box((fb.x0 + fb.x1) / 2, Y - 0.22, fz, fl, 0.22, 2.8, TIMB, 0, 7);
    for (let x = fb.x0 + 1; x < fb.x1; x += 2) flat.box(x, Y - 0.001, fz, 0.06, 0.012, 2.8, 0x4a3a2c, 0, 1);
    const sag = (x: number): number => { const u = (x - T0) / (T1 - T0); return TOP - (TOP - Y - 1.5) * 4 * u * (1 - u); };
    for (const sg of [-1, 1]) {
      const z = fz + sg * 1.75;
      for (const tx of [T0, T1]) {
        flat.box(tx, Y - 6, z, 0.45, TOP - Y + 6.3, 0.45, IRON_C, 0, 5);
        col.addBoxC(tx, z, 0.45, 0.45, TOP, Y - 6);
      }
      for (let x = T0; x < T1 - 0.01; x += (T1 - T0) / 16) bar(flat, x, sag(x), z, x + (T1 - T0) / 16, sag(x + (T1 - T0) / 16), z, 0.14, IRON_C);
      bar(flat, T0, TOP, z, fb.x0 - 9, Y, z, 0.14, IRON_C);
      bar(flat, T1, TOP, z, fb.x1 + 9, Y, z, 0.14, IRON_C);
      for (let x = T0 + 7; x < T1 - 3; x += 7) bar(flat, x, sag(x), z, x, Y - 0.1, fz + sg * 1.42, 0.05, IRON_C);
      // Railings, and the wall the physics feels for them.
      bar(flat, fb.x0, Y + 1.05, fz + sg * 1.42, fb.x1, Y + 1.05, fz + sg * 1.42, 0.07, IRON_C);
      bar(flat, fb.x0, Y + 0.55, fz + sg * 1.42, fb.x1, Y + 0.55, fz + sg * 1.42, 0.05, IRON_C);
      for (let x = fb.x0; x <= fb.x1 + 0.01; x += 3) flat.box(x, Y, fz + sg * 1.42, 0.07, 1.05, 0.07, IRON_C, 0, 4);
      col.addBox(fb.x0, fz + sg * 1.42 - 0.06, fb.x1, fz + sg * 1.42 + 0.06, Y + 1.1, Y - 0.6);
      for (const bx of [fb.x0 - 0.6, fb.x1 + 0.6]) {
        flat.box(bx, Y, fz + sg * 0.75, 0.24, 0.9, 0.24, IRON_C, 0, 5);
        col.addProp(bx, fz + sg * 0.75, 0.15, Y + 0.9, 'post', false).hard = true;
      }
    }
    flat.box(T0, TOP - 0.5, fz, 0.3, 0.3, 3.5, IRON_C);
    flat.box(T1, TOP - 0.5, fz, 0.3, 0.3, 3.5, IRON_C);

    // Threadbare Dam: a concrete weir from bank to bank, abutments either end. The water over it is mainWater()'s.
    const dx = riverX(DAM_Z);
    flat.box(dx, -4, DAM_Z, RIVER_HW * 2 + 30, POND_Y - 0.06 + 4, 3, CONC, 0, 5);
    col.addBox(dx - RIVER_HW - 15, DAM_Z - 1.5, dx + RIVER_HW + 15, DAM_Z + 1.5, POND_Y, -5);
    for (const sg of [-1, 1]) {
      flat.box(dx + sg * (RIVER_HW + 13), -2, DAM_Z + 1, 9, Y + 2.6, 9, CONC, 0, 5);
      col.addBoxC(dx + sg * (RIVER_HW + 13), DAM_Z + 1, 9, 9, Y + 0.6, -2);
    }
    for (let x = dx - RIVER_HW + 3; x < dx + RIVER_HW; x += 6) flat.box(x, POND_Y - 0.06, DAM_Z - 1.1, 0.3, 0.75, 0.3, IRON_C, 0, 5);

    // The railway. One running line, sidings in the yard, a timber trestle over the river. No trains yet.
    const paved = (x: number, z: number): boolean => inTown(x, z, 0) && groundAt(x, z) < Y + 0.1;
    const track = (x0: number, x1: number, z: number, yard: boolean): void => {
      for (let x = x0; x < x1; x += 2) {
        const xm = x + 1, g = groundAt(xm, z);
        const deck = xm > RAIL_TRESTLE.x0 && xm < RAIL_TRESTLE.x1 && Math.abs(z - RAIL.z) < 1, road = !deck && paved(xm, z);
        // A siding stops short of every street; the running line crosses them flush with the asphalt.
        if (yard && (road || paved(xm - 9, z) || paved(xm + 9, z) || g < Y)) continue;
        if (g < Y - 0.5 && !deck) continue;
        const top = road ? g + 0.04 : deck ? Y + 0.2 : g + 0.26;
        if (!road && !deck) flat.box(xm, g - 0.1, z, 2, 0.22, 3.4, BALLAST, 0, 5);
        if (!road) flat.box(xm, top - 0.2, z, 0.26, 0.1, 2.5, TIMB, 0, 5);
        for (const sg of [-1, 1]) flat.box(xm, top - 0.1, z + sg * 0.72, 2, 0.1, 0.08, RAILC, 0, 5);
      }
    };
    track(RAIL.x0, RAIL.x1, RAIL.z, false);
    for (const dz of [-4.6, 4.6]) track(MXS[3] + 12, MXS[8] - 12, RAIL.z + dz, true);
    const tl = RAIL_TRESTLE.x1 - RAIL_TRESTLE.x0, tm = (RAIL_TRESTLE.x0 + RAIL_TRESTLE.x1) / 2;
    flat.box(tm, Y - 0.5, RAIL.z, tl, 0.5, 4.4, TIMB, 0, 7);
    for (let x = RAIL_TRESTLE.x0 + 8; x < RAIL_TRESTLE.x1 - 4; x += 14) {
      for (const sg of [-1, 1]) bar(flat, x, Y - 0.5, RAIL.z + sg * 1.6, x, -4.5, RAIL.z + sg * 2.6, 0.5, TIMB);
      flat.box(x, Y - 3.2, RAIL.z, 0.3, 0.3, 5, TIMB);
    }
    for (const end of [RAIL.x0 - 1, RAIL.x1 + 1]) {
      const g = groundAt(end, RAIL.z);
      flat.box(end, g, RAIL.z, 0.5, 1.1, 2.6, 0xe4572e);
      col.addBoxC(end, RAIL.z, 0.6, 2.6, g + 1.1, g - 0.5);
    }
    // Crossbucks at every level crossing, one for each direction of traffic.
    for (const e of plan.edges) {
      if (!e.land || e.deck || e.horiz) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      if (A.z > RAIL.z || B.z < RAIL.z || A.x < RAIL.x0 || A.x > RAIL.x1) continue;
      for (const sg of [-1, 1]) {
        const px = A.x - sg * (e.hw + 0.9), pz = RAIL.z + sg * 4.6, g = groundAt(px, pz);
        flat.box(px, g, pz, 0.12, 3.5, 0.12, 0xf2e8cf, 0, 5);
        bar(flat, px - 0.75, g + 2.55, pz, px + 0.75, g + 3.35, pz, 0.17, 0xf2e8cf);
        bar(flat, px - 0.75, g + 3.35, pz, px + 0.75, g + 2.55, pz, 0.17, 0xf2e8cf);
        flat.box(px, g + 2.0, pz, 0.5, 0.3, 0.05, 0xe4572e);
        this.claim(px, pz, 0.8);
        col.addProp(px, pz, 0.12, g + 3.5, 'post', true);
      }
    }

    // The Thruway is divided: a concrete barrier down the middle, with gaps at every crossing.
    for (const e of plan.edges) {
      if (!e.land || e.deck || e.horiz) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      if (A.x !== MXS[0]) continue;
      const z0 = A.z + A.hz + 16, z1 = B.z - B.hz - 16;
      if (z1 - z0 < 8) continue;
      flat.box(A.x, Y, (z0 + z1) / 2, 0.6, 0.8, z1 - z0, CONC, 0, 5);
      col.addBox(A.x - 0.3, z0, A.x + 0.3, z1, Y + 0.8, Y - 0.5);
    }
    // And it ends, for now, at a barrier two hundred meters past Town Line Rd.
    const zn = MZS[0] - ST_HW_M - 222;
    sawhorses(flat, MXS[0], Y, zn, 0, AVE_HW * 2 - 0.4);
    col.addBox(MXS[0] - AVE_HW, zn - 0.3, MXS[0] + AVE_HW, zn + 0.3, Y + 1.15, Y - 0.5);

    this.meshM(flat, this.mats.flat, 0, this.game.quality.shadows);
  }

  /** Street trees for the town, clumps on the slopes of the hill and round the square, and woods over the countryside. */
  private mainTrees(): void {
    const plan = this.plan, den = this.den, rng = new RNG(9131);
    for (const b of plan.blocks) {
      if (!b.land) continue;
      const [species, gap, share] = STREET_TREES[b.district];
      this.eachSide(b, (len, at) => {
        for (let s = gap * 0.5; s < len - 4; s += gap) {
          const j = rng.range(-1.5, 1.5), keep = rng.next() < share && rng.next() < den, alt = rng.next();
          if (!keep) continue;
          const [x, z] = at(s + j, STRIP + 0.2);
          // The dark conifer stands in for a white pine until Maine's own trees are modelled.
          const sp = species === 'maple' && alt < 0.2 ? 'cypress' : species;
          if (!keepOut(x, z) && this.claim(x, z, 1.7)) this.tree(sp, x, z, rng);
        }
      });
    }
    for (const b of plan.blocks) {
      if (b.district !== 'college' && b.district !== 'square') continue;
      const r = b.rect, sq = b.district === 'square', G = sq ? 11 : 15;
      for (let x = r.x0 + 7; x < r.x1 - 7; x += G) for (let z = r.z0 + 7; z < r.z1 - 7; z += G) {
        const px = x + rng.range(0, G - 3), pz = z + rng.range(0, G - 3), roll = rng.next(), alt = rng.next();
        const hh = hillAt(px, pz), edge = Math.min(px - r.x0, r.x1 - px, pz - r.z0, r.z1 - pz);
        // Only where nothing will be built: the slopes of the hill, and the rim of the square.
        if (sq ? edge > 16 : hh < 0.6 || hh > HILL.h - 0.5) continue;
        const want = (sq ? 0.75 : 0.2 + 0.6 * smooth(noise2(px * 0.03 + 5, pz * 0.03) * 1.8 - 0.4)) * den;
        if (roll > want || Math.abs(px - MXS[2]) < 12 || keepOut(px, pz) || !this.claim(px, pz, 3.2)) continue;
        this.tree(alt < 0.3 ? 'cypress' : alt < 0.6 ? 'maple' : 'oak', px, pz, rng);
      }
    }
    for (let x = -950; x < 1000; x += 24) for (let z = -2510; z < -1000; z += 24) {
      const px = x + rng.range(0, 19), pz = z + rng.range(0, 19), roll = rng.next(), alt = rng.next();
      if (inTown(px, pz, 9)) continue;
      const want = (0.22 + 0.75 * smooth(noise2(px * 0.012 + 3, pz * 0.012 + 11) * 2 - 0.55)) * den;
      if (roll > want || coastSD(px, pz) > -36 || waterDist(px, pz) < 7 || keepOut(px, pz) || inExtraLot(px, pz, 4)) continue;
      this.tree(alt < 0.5 ? 'cypress' : alt < 0.72 ? 'oak' : 'maple', px, pz, rng);
    }
  }

  private tree(sp: Species, x: number, z: number, rng: RNG): void {
    // Sunk a hand's width so no trunk hovers over the terrain's six-centimeter drop.
    const y = groundAt(x, z) - 0.1, k = rng.range(0.85, 1.18), leaf = LEAF[sp];
    let tint = -1;
    const blob = (dx: number, dy: number, dz: number, r: number, ry: number, hex: number): void => {
      if (tint < 0) tint = hex;
      xf(x + dx, y + dy, z + dz, rng.range(0, TAU), r, ry, r);
      this.blobs.add(x, z, hex, rng.range(0.9, 1.08));
    };
    let th = 3, tr = 0.25, bark = 0x6b4a36;
    const a = rng.range(0, TAU), ax = Math.cos(a), az = Math.sin(a);
    if (sp === 'palm') {
      th = rng.range(6.5, 9.5); tr = 0.2; bark = 0xa08a6a;
      const h = rng.range(0, TAU), lean = rng.range(0.02, 0.11);
      xf(x, y, z, h, tr, th, tr, lean);
      this.trunks.add(x, z, bark);
      // The modelled trunk is 8 m tall and stretched to this palm's height.
      xf(x, y, z, h, 1, th / 8, 1, lean);
      this.plant('palmtrunk', 0xffffff);
      // Top of the leaning trunk.
      const top = th * Math.sin(lean);
      xf(x + Math.sin(h) * top, y + th * Math.cos(lean), z + Math.cos(h) * top, rng.range(0, TAU), k, k, k, lean);
      const hex = rng.pick(leaf);
      this.palms.add(x, z, hex, rng.range(0.9, 1.05));
      this.plant('palmcrown', hex, LEAF_GAIN);
    } else if (sp === 'cypress') {
      th = 1.4; tr = 0.2; bark = 0x5a4334;
      const hex = rng.pick(leaf);
      blob(0, 1.0 + 3.6 * k, 0, 1.15 * k, 3.9 * k, hex);
      blob(0, 1.0 + 6.2 * k, 0, 0.7 * k, 2.2 * k, hex);
    } else if (sp === 'plane') {
      th = rng.range(3.3, 4.1); tr = 0.2; bark = 0xb0a488;
      blob(0, th + 1.2 * k, 0, 2.1 * k, 1.7 * k, rng.pick(leaf));
      blob(ax * 0.9, th + 2.2 * k, az * 0.9, 1.5 * k, 1.3 * k, rng.pick(leaf));
    } else if (sp === 'maple') {
      th = rng.range(2.5, 3.3); tr = 0.25;
      // One tree in seven has turned early, mustard or rust, top to bottom.
      const hex = rng.chance(0.14) ? leaf[rng.int(3, 4)] : leaf[rng.int(0, 2)];
      blob(0, th + 1.5 * k, 0, 2.6 * k, 2.1 * k, hex);
      blob(ax * 1.5, th + 1.9 * k, az * 1.5, 1.8 * k, 1.5 * k, hex);
      blob(-ax * 1.2, th + 2.7 * k, -az * 1.2, 1.7 * k, 1.4 * k, hex);
    } else {
      th = rng.range(3.2, 4.3); tr = 0.36; bark = 0x5a4334;
      blob(0, th + 1.9 * k, 0, 3.3 * k, 2.5 * k, rng.pick(leaf));
      blob(ax * 2.1, th + 2.3 * k, az * 2.1, 2.4 * k, 1.9 * k, rng.pick(leaf));
      blob(-ax * 1.7, th + 3.3 * k, -az * 1.7, 2.2 * k, 1.8 * k, rng.pick(leaf));
    }
    if (sp !== 'palm') {
      // The trunk runs a little way into the canopy so no gap opens between them.
      xf(x, y, z, a, tr, th + 0.9, tr);
      this.trunks.add(x, z, bark);
      xf(x, y, z, a, k * (sp === 'plane' ? 0.88 : 1));
      this.plant(sp, tint, LEAF_GAIN);
    }
    this.game.col.addProp(x, z, tr + 0.08, y + 8, 'tree', false);
  }

  // ── Finishing the land ─────────────────────────────────────────────────────

  /**
   * The terrain's own copy of the sand material. Sand is pulled pale and warm (the shared sand
   * paint goes khaki under the sky's teal fill), and the strip the sea reaches is dark and glossy:
   * that band is worked out per pixel from the coastline itself, so it is a clean line and not
   * the eight-meter smear vertex colours gave.
   */
  private terrainMaterial(): THREE.Material {
    const m = this.mats.sand.clone() as THREE.MeshStandardMaterial;
    // The per-pixel tide line is for medium and high; phones get the paler sand and nothing else.
    const wet = this.game.quality.name === 'low' ? 'float wetS = 0.0;' : `
          float sdS = shoreSD( vShore ) + 2.2 * sin( vShore.x * 0.09 + vShore.y * 0.05 ) + 1.3 * sin( vShore.y * 0.21 - vShore.x * 0.13 );
          float wetS = smoothstep( -15.5, -9.0, sdS ) * vSand;
          diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.6, 0.55, 0.48 ), wetS );`;
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aSand;\nvarying float vSand;\nvarying vec2 vShore;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSand = aSand; vShore = position.xz;');
      sh.fragmentShader = 'varying float vSand;\nvarying vec2 vShore;\n' + SHORE_SD + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          float sLum = dot( diffuseColor.rgb, vec3( 0.3, 0.55, 0.15 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, sLum * mix( vec3( 0.92, 1.0, 0.72 ), vec3( 1.13, 1.0, 0.8 ), vSand ), 0.3 + 0.42 * vSand );
          ${wet}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.3, wetS );');
    };
    this.sandMat = m;
    return m;
  }

  /** Lawns everywhere get broad dry and lush patches, so a park is not one flat green. World-anchored, so it never swims. */
  private toneGrass(): void {
    const noise = this.mats.tex.noise;
    this.mats.grass.onBeforeCompile = (sh) => {
      sh.uniforms.uTone = { value: noise };
      sh.vertexShader = 'varying vec2 vTone;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTone = ( modelMatrix * vec4( position, 1.0 ) ).xz;');
      sh.fragmentShader = 'uniform sampler2D uTone;\nvarying vec2 vTone;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        {
          float ta = texture2D( uTone, vTone / 113.0 ).r, tb = texture2D( uTone, vTone / 29.0 ).g, tc = texture2D( uTone, vTone / 6.0 ).r;
          float tk = clamp( 0.5 + ( ta - 0.5 ) * 2.4 + ( tb - 0.5 ) * 1.3, 0.0, 1.0 );
          diffuseColor.rgb *= mix( vec3( 1.14, 1.05, 0.76 ), vec3( 0.76, 0.9, 0.8 ), tk ) * ( 0.9 + 0.2 * tc );
        }`);
    };
  }

  /** Tufts, flowers and dune grass; shrubs in the scrub; rocks and driftwood along the shore and at the breakwater's foot. */
  private finish(): void {
    const rng = new RNG(3301), den = this.den, col = this.game.col;
    const cover = this.game.quality.name === 'low' ? null : new Cover(REGION);
    const gy = (x: number, z: number): number => groundAt(x, z) - 0.05;
    const grass = (x: number, z: number, s = 1): void => {
      const w = rng.range(0.55, 0.9) * s, h = rng.range(0.32, 0.58) * s, a = rng.range(0, TAU), sh = rng.range(0.78, 1.05);
      cover?.tuft(x, gy(x, z), z, CELL.grass, w, h, a, sh);
    };
    const flower = (x: number, z: number): void => {
      const w = rng.range(0.6, 0.85), h = rng.range(0.45, 0.7), a = rng.range(0, TAU);
      cover?.tuft(x, gy(x, z), z, CELL.flowers, w, h, a, 1);
    };
    const dune = (x: number, z: number): void => {
      const w = rng.range(0.8, 1.25), h = rng.range(0.75, 1.3), a = rng.range(0, TAU), sh = rng.range(0.85, 1.05);
      cover?.tuft(x, terrainAt(x, z) - 0.1, z, CELL.dune, w, h, a, sh, 3);
    };

    // Mercy Park: rough grass in drifts, flower beds either side of the promenade.
    for (let i = 0; i < 1700 * den; i++) {
      const x = rng.range(90, 300), z = rng.range(-212, -28);
      if (keepOut(x, z) || noise2(x * 0.06 + 3, z * 0.06) < 0.42) continue;
      grass(x, z);
    }
    for (let x = 92; x < 300; x += 7) for (const side of [-1, 1]) {
      const cx = x + rng.range(-2, 2), cz = -120 + side * rng.range(7.5, 10.5), n = rng.int(6, 11), want = rng.next() < 0.55;
      if (!want || keepOut(cx, cz)) continue;
      for (let k = 0; k < n; k++) {
        const a = rng.range(0, TAU), r = rng.range(0, 2.2), px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
        flower(px, pz);
        if (k % 2) grass(px + 0.4, pz - 0.3);
      }
    }

    // Gull Heights: the strip of lawn behind the sidewalk is never mown to the edge.
    for (const b of this.plan.blocks) {
      if (b.district !== 'suburb') continue;
      this.eachSide(b, (len, at) => {
        for (let s = 2; s < len - 2; s += rng.range(1.2, 2.6)) {
          const d = SIDEWALK + rng.range(0.3, 1.5), roll = rng.next();
          const [x, z] = at(s, d);
          if (roll < 0.3 * den) grass(x, z, 0.8);
          else if (roll < 0.34 * den) for (let k = 0; k < 4; k++) flower(x + rng.range(-0.7, 0.7), z + rng.range(-0.7, 0.7));
        }
      });
    }

    // Outside the streets: tussocks and shrubs in the scrub, dune grass on dry sand.
    for (let i = 0; i < 20000 * den; i++) {
      const x = rng.range(-760, 760), z = rng.range(-590, 560), roll = rng.next();
      if ((x > XW - 3 && x < XE + 3 && z > ZN - 3 && z < ZSO + 3) || keepOut(x, z)) continue;
      // The working waterfront is not a nature reserve.
      if (x > XE - 5 && z > 150) continue;
      const sd = islandSD(x, z), n = noise2(x * 0.045, z * 0.045 + 7);
      const sand = sd + 44 * smooth((z - 250) / 150) > -62;
      if (!sand) {
        if (n < 0.4 || roll > 0.6) continue;
        grass(x, z, 1.25);
        if (roll < 0.04) {
          xf(x, gy(x, z), z, rng.range(0, TAU), rng.range(0.9, 1.7));
          this.plant('shrub', rng.pick(LEAF.oak), LEAF_GAIN);
        }
      } else if (sd < -17 && n > 0.43) {
        // On Low Tide Beach only along the top, under the seawall: the rest is for towels.
        if (z > ZSO && sd > -74) continue;
        for (let k = rng.int(5, 9); k > 0; k--) dune(x + rng.range(-2.2, 2.2), z + rng.range(-2.2, 2.2));
      }
    }
    // The mainland's rough grass: the countryside, the riverbanks, the bluff. Drawn after the island's so its dice are untouched.
    const rm = new RNG(3311);
    for (let i = 0; i < 16000 * den; i++) {
      const x = rm.range(-950, 1000), z = rm.range(-2400, -1000), roll = rm.next();
      if (inTown(x, z, 3) || keepOut(x, z) || coastSD(x, z) > -30 || inExtraLot(x, z, 0)) continue;
      if (noise2(x * 0.045, z * 0.045 + 7) < 0.42 || roll > 0.7) continue;
      grass(x, z, 1.25);
      if (roll < 0.03) {
        xf(x, gy(x, z), z, rng.range(0, TAU), rng.range(0.9, 1.7));
        this.plant('shrub', rng.pick(LEAF.oak), LEAF_GAIN);
      }
    }
    if (cover) this.hideFar(cover.build(this.root), 160);

    // Stone and timber. Its own dice, so the phone preset (no ground cover) has the same rocks in the same places.
    const R = new RNG(3302);
    const rocks = new Inst(rockGeo(), this.propMat, REGION), logs = new Inst(driftGeo(), this.propMat, REGION);
    const GREY = [0x8a857a, 0x7a766c, 0x9a9488, 0x6f6d66];
    const rock = (x: number, y: number, z: number, s: number): void => {
      E.set(R.range(-0.3, 0.3), R.range(0, TAU), R.range(-0.3, 0.3), 'YXZ');
      M.compose(P.set(x, y, z), Q.setFromEuler(E), S.set(s * R.range(0.8, 1.3), s * R.range(0.55, 0.9), s * R.range(0.8, 1.3)));
      rocks.add(x, z, R.pick(GREY), R.range(0.85, 1.05));
    };
    for (let i = 0; i < 10000; i++) {
      const x = R.range(-760, 760), z = R.range(-590, 560), roll = R.next();
      const sd = islandSD(x, z);
      if (sd < -32 || sd > -3 || keepOut(x, z)) continue;
      // Not on the swimming beach and not along the docks.
      if ((z > ZSO - 30 && x > -390 && x < 340) || (x > 540 && z > 140)) continue;
      if (sd > -15) {
        for (let k = R.int(1, 3); k > 0; k--) {
          const s = R.range(0.35, 1.0) * (roll < 0.15 ? 1.9 : 1), rx = x + R.range(-2, 2), rz = z + R.range(-2, 2);
          const y = Math.max(terrainAt(rx, rz), WATER_Y - 0.6) - s * 0.25;
          rock(rx, y, rz, s);
          if (s > 1.2) col.addBoxC(rx, rz, s * 1.5, s * 1.5, y + s * 0.6, y - 2);
        }
      } else if (roll < 0.22) {
        E.set(0, R.range(0, TAU), R.range(-0.05, 0.05), 'YXZ');
        M.compose(P.set(x, terrainAt(x, z) - 0.04, z), Q.setFromEuler(E), S.setScalar(R.range(0.7, 1.5)));
        logs.add(x, z, 0xffffff, R.range(0.8, 1.05));
      }
    }
    // Armour stone along both flanks of the breakwater and round its head.
    const bw = BREAKWATER;
    for (let x = bw.x0 + 8; x < bw.x1 + 2; x += R.range(1.5, 2.5)) for (const side of [-1, 1]) {
      const s = R.range(0.9, 1.7), z = side < 0 ? bw.z0 - R.range(0.3, 1.6) : bw.z1 + R.range(0.3, 1.6);
      rock(x, WATER_Y - 0.15 + R.range(-0.2, 0.25), z, s);
    }
    for (let z = bw.z0 - 1; z < bw.z1 + 1; z += 1.9) rock(bw.x1 + R.range(0.5, 1.8), WATER_Y - 0.1, z, R.range(1.0, 1.7));
    // The Muddle below the dam runs over ledge: stones along both banks, boulders under the falls.
    const RM = new RNG(3312);
    for (let i = 0; i < 1100; i++) {
      const z = RM.range(DAM_Z + 4, -1000), x = riverX(z) + RM.sign() * (RIVER_HW + RM.range(-4, 5)), big = RM.chance(0.15);
      const s = RM.range(0.4, 1.2) * (big ? 1.8 : 1);
      rock(x, Math.max(mainlandTerrain(x, z), WATER_Y - 0.5) - s * 0.25, z, s);
    }
    for (let i = 0; i < 70; i++) {
      const z = DAM_Z + RM.range(7, 34), s = RM.range(0.8, 2.1);
      rock(riverX(z) + RM.range(-33, 33), WATER_Y - 0.25 + RM.range(-0.2, 0.2), z, s);
    }
    rocks.build(this.root, false);
    logs.build(this.root, false);
    this.hideFar(rocks.meshes, 420); this.hideFar(logs.meshes, 200);
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const env = (this.mats.flat as THREE.MeshStandardMaterial).envMap, pm = this.propMat as THREE.MeshStandardMaterial;
    if (pm !== this.mats.flatDouble && pm.envMap !== env) pm.envMap = env;
    if (this.sandMat && this.sandMat.envMap !== env) this.sandMat.envMap = env;
    const cp = this.game.camera.getWorldPosition(P);
    for (const n of this.nearOnly) n.o.visible = cp.distanceTo(n.c) - n.r < n.lim;
    // The mainland's coast is at about z = -980: beyond fog range of it, none of the far shore is drawn.
    const seeMain = cp.z < -975 + this.game.quality.drawDist + 60;
    if (seeMain !== this.mainShown) { this.mainShown = seeMain; for (const o of this.mainOnly) o.visible = seeMain; }
    if (this.field) {
      this.field.update(this.game.camera);
      const fm = floraMaterial();
      if (fm.envMap !== env) fm.envMap = env;
    }
    const u = this.seaU;
    u.uTime.value += dt;
    // The sky is built after the world, so it may not be there yet.
    const light = this.game.sky?.lightDir;
    if (light) (u.uLight.value as THREE.Vector3).copy(light);

    const nodes = this.plan.nodes, time = this.game.time, last = this.sigLast;
    // Two meshes, one loop each: the island's approaches, then the mainland's (skipped while they are not drawn).
    for (const [bulbs, from, to] of [[this.bulbs, 0, this.sigMain], [this.bulbsMain, this.sigMain, last.length]] as const) {
      if (!bulbs || !bulbs.visible) continue;
      const c = bulbs.instanceColor!.array as Float32Array;
      let changed = false;
      for (let a = from; a < to; a++) {
        const st = signalState(nodes[this.sigNode[a]], this.sigHoriz[a], time);
        const on = st === 'red' ? 0 : st === 'yellow' ? 1 : 2;
        if (on === last[a]) continue;
        last[a] = on;
        changed = true;
        for (let k = 0; k < 6; k++) {
          const l = k % 3, src = l === on ? this.litC : this.dimC, o = ((a - from) * 6 + k) * 3;
          c[o] = src[l * 3]; c[o + 1] = src[l * 3 + 1]; c[o + 2] = src[l * 3 + 2];
        }
      }
      if (changed) bulbs.instanceColor!.needsUpdate = true;
    }
  }

  setNight(n: number): void {
    const u = this.seaU;
    u.uNight.value = n;
    // Warm and strong under the sun, pale and thin under the moon.
    (u.uGlint.value as THREE.Color).copy(this.glintDay).lerp(this.glintNight, n).multiplyScalar(0.95 - 0.5 * n);
    const glow = smooth(n * 1.2), on = n > 0.01;
    this.poolMat.opacity = glow; this.poolMat.visible = on;
    this.haloMat.opacity = glow; this.haloMat.visible = on;
  }
}

export function buildGround(game: Game, mats: CityMaterials, parent: THREE.Group): WorldPart {
  return new Ground(game, mats, parent);
}
