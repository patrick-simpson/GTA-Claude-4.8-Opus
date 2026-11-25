// Wildlife models (fun queue 2, item 33), built in code: a deer, a goose, a gull and a black bear, each a few vertex-coloured
// parts (body, neck, head, legs, wings, tail) that hang off each other like bones. A part is one InstancedMesh; every animal
// of a kind writes one instance per part per frame, so a flock of forty geese is six draw calls whatever it does. A part that
// is used several times over (the four legs of a deer) shares one mesh and one geometry, drawn at four pivots.
//
// Units are metres, +z is the way the animal faces, +y is up, the feet stand on y = 0. Rotations are about each part's pivot:
// a positive x turn dips the nose.

import * as THREE from 'three';
import { sendRange } from '../core/flip';

// ── A small builder: ellipsoids, tapered limbs and boxes merged into one vertex-coloured geometry ──────────────────

const SPH = new THREE.SphereGeometry(1, 10, 7);
const BOX = new THREE.BoxGeometry(1, 1, 1);

export class Build {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  private readonly c = new THREE.Color();
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  /** The part's own origin in model space; everything is stored relative to it. */
  constructor(readonly pivot: readonly [number, number, number]) {}

  private put(g: THREE.BufferGeometry, color: number): void {
    const p = g.getAttribute('position'), nm = g.getAttribute('normal'), ix = g.getIndex()!;
    const base = this.pos.length / 3;
    this.c.setHex(color);
    for (let i = 0; i < p.count; i++) {
      this.v.set(p.getX(i), p.getY(i), p.getZ(i)).multiply(this.s).applyQuaternion(this.q);
      this.pos.push(this.v.x + this.m.elements[12], this.v.y + this.m.elements[13], this.v.z + this.m.elements[14]);
      this.n.set(nm.getX(i) / this.s.x, nm.getY(i) / this.s.y, nm.getZ(i) / this.s.z).applyQuaternion(this.q).normalize();
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
    for (let i = 0; i < ix.count; i++) this.idx.push(ix.getX(i) + base);
  }

  /** An ellipsoid of radii r about (x, y, z), turned by (rx, ry, rz). */
  ell(x: number, y: number, z: number, ax: number, ay: number, az: number, color: number, rx = 0, ry = 0, rz = 0): this {
    this.s.set(ax, ay, az);
    this.q.setFromEuler(this.e.set(rx, ry, rz, 'YXZ'));
    this.m.makeTranslation(x - this.pivot[0], y - this.pivot[1], z - this.pivot[2]);
    this.put(SPH, color);
    return this;
  }

  /** A limb from a to b, radius r0 at a and r1 at b. */
  limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r0: number, r1: number, color: number): this {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 1e-6;
    this.q.setFromUnitVectors(this.v.set(0, 1, 0), this.n.set(dx / len, dy / len, dz / len));
    const g = new THREE.CylinderGeometry(r1, r0, len, 6, 1, false);
    this.s.set(1, 1, 1);
    this.m.makeTranslation((ax + bx) / 2 - this.pivot[0], (ay + by) / 2 - this.pivot[1], (az + bz) / 2 - this.pivot[2]);
    this.put(g, color);
    g.dispose();
    return this;
  }

  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, rx = 0, ry = 0, rz = 0): this {
    this.s.set(sx, sy, sz);
    this.q.setFromEuler(this.e.set(rx, ry, rz, 'YXZ'));
    this.m.makeTranslation(x - this.pivot[0], y - this.pivot[1], z - this.pivot[2]);
    this.put(BOX, color);
    return this;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

// ── The pose an animal is in, and how each species turns it into joint angles ──────────────────────────────────────

export class Pose {
  /** Stride phase (radians) and swing (radians). */
  gait = 0; amp = 0;
  /** 0 head up and watching .. 1 head down grazing (deer, goose); for a gull, a bow, -0.4 to 0.5. */
  head = 0;
  /** Bear: 0 on four legs .. 1 standing up on the hind legs. */
  up = 0;
  /** Wings: the flap phase (radians), and 0 folded .. 1 out (a part drawn only while it is out). */
  flap = 0; spread = 0;
  /** Gull wing dihedral (a gliding gull's M). */
  dih = 0;
  /** Deer: 0 tail down .. 1 the white flag up. */
  tail = 0;
  /** A buck carries antlers. */
  buck = false;
}

export interface Rot { x: number; y: number; z: number }
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export interface PartDef {
  /** Index of the part this one hangs from, or -1 for the root. */
  parent: number;
  /** The joint, in model space. */
  pivot: [number, number, number];
  /** The mesh this part is drawn in: its own index, or an earlier part's to share its geometry. */
  mesh: number;
  /** Builds the geometry (only for a part that owns its mesh). */
  build?: (b: Build) => void;
}

export interface Species {
  parts: PartDef[];
  solve(k: number, p: Pose, o: Rot): void;
  /** Is this part drawn for this pose? */
  vis(k: number, p: Pose): boolean;
}

// Colours.
const DEER = { coat: 0x7f6542, dark: 0x4a3a28, belly: 0xd8cbb0, white: 0xf3eee2, muzzle: 0xc9bca3, hoof: 0x1d1813, antler: 0xcdbb94 };

const deer = ((): Species => {
  const parts: PartDef[] = [
    { parent: -1, pivot: [0, 0.9, -0.05], mesh: 0, build: (b) => {
      b.ell(0, 0.9, 0.0, 0.2, 0.24, 0.5, DEER.coat).ell(0, 0.92, 0.33, 0.19, 0.25, 0.26, DEER.coat).ell(0, 0.93, -0.36, 0.2, 0.25, 0.3, DEER.coat);
      b.ell(0, 0.74, 0.0, 0.17, 0.12, 0.42, DEER.belly).ell(0.14, 0.82, -0.38, 0.1, 0.2, 0.2, DEER.coat).ell(-0.14, 0.82, -0.38, 0.1, 0.2, 0.2, DEER.coat);
      b.ell(0, 1.07, -0.34, 0.1, 0.05, 0.22, DEER.dark);
    } },
    { parent: 0, pivot: [0, 1.0, 0.46], mesh: 1, build: (b) => {
      b.limb(0, 1.0, 0.46, 0, 1.44, 0.66, 0.12, 0.075, DEER.coat).ell(0, 1.12, 0.52, 0.09, 0.16, 0.1, DEER.belly, 0.3);
    } },
    { parent: 1, pivot: [0, 1.44, 0.66], mesh: 2, build: (b) => {
      b.ell(0, 1.48, 0.78, 0.072, 0.082, 0.15, DEER.coat, 0.15).ell(0, 1.45, 0.93, 0.05, 0.05, 0.09, DEER.muzzle, 0.15).ell(0, 1.45, 1.0, 0.032, 0.026, 0.028, DEER.hoof);
      b.ell(0.095, 1.58, 0.72, 0.034, 0.1, 0.02, DEER.coat, 0, 0, -0.75).ell(-0.095, 1.58, 0.72, 0.034, 0.1, 0.02, DEER.coat, 0, 0, 0.75);
      b.ell(0.066, 1.5, 0.83, 0.018, 0.02, 0.02, DEER.hoof).ell(-0.066, 1.5, 0.83, 0.018, 0.02, 0.02, DEER.hoof);
    } },
    { parent: 2, pivot: [0, 1.55, 0.74], mesh: 3, build: (b) => {
      for (const s of [1, -1]) {
        b.limb(0.05 * s, 1.55, 0.74, 0.12 * s, 1.84, 0.68, 0.026, 0.017, DEER.antler).limb(0.12 * s, 1.84, 0.68, 0.17 * s, 2.0, 0.8, 0.017, 0.01, DEER.antler);
        b.limb(0.09 * s, 1.7, 0.71, 0.09 * s, 1.92, 0.78, 0.016, 0.009, DEER.antler).limb(0.115 * s, 1.8, 0.69, 0.14 * s, 1.96, 0.62, 0.015, 0.008, DEER.antler);
      }
    } },
    // Legs (one shared geometry, four pivots): the four joints below hang down 0.8 m.
    { parent: 0, pivot: [0.115, 0.8, 0.38], mesh: 4, build: (b) => {
      b.limb(0, 0.8, 0, 0, 0.42, 0, 0.072, 0.045, DEER.coat).limb(0, 0.42, 0, 0, 0.05, 0.01, 0.037, 0.027, DEER.dark).ell(0, 0.025, 0.012, 0.03, 0.03, 0.045, DEER.hoof);
    } },
    { parent: 0, pivot: [-0.115, 0.8, 0.38], mesh: 4 },
    { parent: 0, pivot: [0.12, 0.8, -0.4], mesh: 4 },
    { parent: 0, pivot: [-0.12, 0.8, -0.4], mesh: 4 },
    { parent: 0, pivot: [0, 1.04, -0.62], mesh: 8, build: (b) => {
      b.ell(0, 0.96, -0.66, 0.045, 0.1, 0.035, DEER.coat, 0.25).ell(0, 0.95, -0.69, 0.05, 0.1, 0.03, DEER.white, 0.25);
    } },
  ];
  return {
    parts,
    solve(k, p, o) {
      o.x = o.y = o.z = 0;
      if (k === 1) o.x = lerp(-0.1, 1.9, p.head);
      else if (k === 2) o.x = lerp(0.25, 0.0, p.head);
      else if (k >= 4 && k <= 7) o.x = Math.sin(p.gait + (k === 4 || k === 7 ? 0 : Math.PI)) * p.amp;
      else if (k === 8) o.x = lerp(0.2, 2.35, p.tail);
    },
    vis: (k, p) => k !== 3 || p.buck,
  };
})();

const GOOSE = { body: 0x7b6b58, breast: 0xc2b8a6, black: 0x1a1918, white: 0xf1ece2, wing: 0x6c5c4a, tip: 0x2c2824, leg: 0x2b2b2b };

const goose = ((): Species => {
  const parts: PartDef[] = [
    { parent: -1, pivot: [0, 0.36, 0], mesh: 0, build: (b) => {
      b.ell(0, 0.36, 0, 0.15, 0.14, 0.32, GOOSE.body).ell(0, 0.33, 0.2, 0.13, 0.13, 0.18, GOOSE.breast).ell(0, 0.36, -0.22, 0.12, 0.12, 0.17, GOOSE.body);
      b.ell(0, 0.38, -0.42, 0.06, 0.04, 0.1, GOOSE.black).ell(0, 0.33, -0.38, 0.08, 0.06, 0.08, GOOSE.white);
      b.ell(0.13, 0.43, -0.03, 0.04, 0.1, 0.26, GOOSE.wing, 0, 0, 0.15).ell(-0.13, 0.43, -0.03, 0.04, 0.1, 0.26, GOOSE.wing, 0, 0, -0.15);
    } },
    // Neck and head in one: the neck reaches up (or down to the grass) and the head goes with it.
    { parent: 0, pivot: [0, 0.46, 0.26], mesh: 1, build: (b) => {
      b.limb(0, 0.46, 0.26, 0, 0.77, 0.36, 0.062, 0.042, GOOSE.black).ell(0, 0.8, 0.4, 0.042, 0.042, 0.068, GOOSE.black);
      b.ell(0.034, 0.79, 0.4, 0.012, 0.026, 0.036, GOOSE.white).ell(-0.034, 0.79, 0.4, 0.012, 0.026, 0.036, GOOSE.white).ell(0, 0.785, 0.49, 0.028, 0.018, 0.05, GOOSE.black);
    } },
    { parent: 0, pivot: [0.06, 0.26, 0.0], mesh: 2, build: (b) => {
      b.limb(0, 0.26, 0, 0, 0.03, 0.02, 0.016, 0.012, GOOSE.leg).ell(0, 0.012, 0.06, 0.04, 0.008, 0.06, GOOSE.leg);
    } },
    { parent: 0, pivot: [-0.06, 0.26, 0.0], mesh: 2 },
    { parent: 0, pivot: [0.12, 0.46, 0.04], mesh: 4, build: (b) => {
      b.ell(0.28, 0.46, 0.0, 0.3, 0.02, 0.13, GOOSE.wing).ell(0.56, 0.46, -0.02, 0.14, 0.014, 0.08, GOOSE.tip);
    } },
    { parent: 0, pivot: [-0.12, 0.46, 0.04], mesh: 5, build: (b) => {
      b.ell(-0.28, 0.46, 0.0, 0.3, 0.02, 0.13, GOOSE.wing).ell(-0.56, 0.46, -0.02, 0.14, 0.014, 0.08, GOOSE.tip);
    } },
  ];
  return {
    parts,
    solve(k, p, o) {
      o.x = o.y = o.z = 0;
      if (k === 1) o.x = lerp(-0.05, 2.0, p.head);
      else if (k === 2 || k === 3) o.x = Math.sin(p.gait + (k === 2 ? 0 : Math.PI)) * p.amp + p.spread * 1.25;
      else if (k === 4) o.z = 0.12 + Math.sin(p.flap) * 0.85 * p.spread;
      else if (k === 5) o.z = -(0.12 + Math.sin(p.flap) * 0.85 * p.spread);
    },
    vis: (k, p) => k < 4 || p.spread > 0.02,
  };
})();

const GULL = { white: 0xf2f0ea, mantle: 0xa0aab3, tip: 0x232323, bill: 0xe2b333, spot: 0xc23a2c, leg: 0xdca97c };

const gull = ((): Species => {
  const parts: PartDef[] = [
    { parent: -1, pivot: [0, 0.22, 0], mesh: 0, build: (b) => {
      b.ell(0, 0.22, 0, 0.095, 0.09, 0.23, GULL.white).ell(0, 0.22, 0.14, 0.085, 0.09, 0.12, GULL.white).ell(0, 0.27, -0.03, 0.09, 0.05, 0.2, GULL.mantle);
      b.ell(0, 0.22, -0.27, 0.05, 0.03, 0.09, GULL.white).ell(0, 0.235, -0.36, 0.045, 0.016, 0.04, GULL.tip);
      b.ell(0, 0.325, 0.21, 0.048, 0.07, 0.05, GULL.white, -0.3).ell(0, 0.385, 0.255, 0.052, 0.05, 0.07, GULL.white);
      b.limb(0, 0.382, 0.315, 0, 0.368, 0.41, 0.018, 0.01, GULL.bill).ell(0, 0.36, 0.4, 0.009, 0.007, 0.012, GULL.spot);
      b.ell(0.04, 0.398, 0.275, 0.011, 0.011, 0.011, GULL.tip).ell(-0.04, 0.398, 0.275, 0.011, 0.011, 0.011, GULL.tip);
    } },
    { parent: 0, pivot: [0.04, 0.16, 0.0], mesh: 1, build: (b) => {
      b.limb(0, 0.16, 0, 0, 0.02, 0.02, 0.011, 0.009, GULL.leg).ell(0, 0.008, 0.045, 0.026, 0.006, 0.045, GULL.leg);
    } },
    { parent: 0, pivot: [-0.04, 0.16, 0.0], mesh: 1 },
    { parent: 0, pivot: [0.08, 0.25, 0.03], mesh: 3, build: (b) => {
      b.ell(0.2, 0.25, 0.0, 0.2, 0.015, 0.09, GULL.mantle).ell(0.12, 0.25, 0.07, 0.1, 0.012, 0.03, GULL.white);
    } },
    { parent: 0, pivot: [-0.08, 0.25, 0.03], mesh: 4, build: (b) => {
      b.ell(-0.2, 0.25, 0.0, 0.2, 0.015, 0.09, GULL.mantle).ell(-0.12, 0.25, 0.07, 0.1, 0.012, 0.03, GULL.white);
    } },
    { parent: 3, pivot: [0.4, 0.25, 0.03], mesh: 5, build: (b) => {
      b.ell(0.54, 0.25, -0.01, 0.16, 0.012, 0.065, GULL.mantle).ell(0.68, 0.25, -0.03, 0.09, 0.013, 0.05, GULL.tip);
    } },
    { parent: 4, pivot: [-0.4, 0.25, 0.03], mesh: 6, build: (b) => {
      b.ell(-0.54, 0.25, -0.01, 0.16, 0.012, 0.065, GULL.mantle).ell(-0.68, 0.25, -0.03, 0.09, 0.013, 0.05, GULL.tip);
    } },
  ];
  return {
    parts,
    solve(k, p, o) {
      o.x = o.y = o.z = 0;
      if (k === 1 || k === 2) o.x = Math.sin(p.gait + (k === 1 ? 0 : Math.PI)) * p.amp + p.spread * 1.0;
      else if (k === 3) o.z = 0.06 + p.dih * 0.3 + Math.sin(p.flap) * 0.55 * p.spread;
      else if (k === 4) o.z = -(0.06 + p.dih * 0.3 + Math.sin(p.flap) * 0.55 * p.spread);
      else if (k === 5) o.z = 0.1 - p.dih * 0.45 + Math.sin(p.flap - 0.8) * 0.4 * p.spread;
      else if (k === 6) o.z = -(0.1 - p.dih * 0.45 + Math.sin(p.flap - 0.8) * 0.4 * p.spread);
    },
    vis: (k, p) => k < 3 || p.spread > 0.02,
  };
})();

const BEAR = { fur: 0x211b18, back: 0x2a221d, muzzle: 0x8b6b49, nose: 0x0b0b0b, claw: 0xcbc1ac };

const bear = ((): Species => {
  // Hips at 0.72 m: rear legs 0.72 long, a black bear's shoulder just under a metre.
  const parts: PartDef[] = [
    { parent: -1, pivot: [0, 0.72, -0.42], mesh: 0, build: (b) => {
      b.ell(0, 0.92, 0.0, 0.33, 0.34, 0.62, BEAR.fur).ell(0, 1.02, 0.3, 0.3, 0.3, 0.3, BEAR.back).ell(0, 0.88, -0.4, 0.31, 0.3, 0.28, BEAR.fur);
      b.ell(0, 0.76, 0.05, 0.28, 0.2, 0.5, BEAR.fur);
    } },
    { parent: 0, pivot: [0, 1.09, 0.62], mesh: 1, build: (b) => {
      b.ell(0, 1.07, 0.66, 0.2, 0.2, 0.2, BEAR.back).ell(0, 1.07, 0.86, 0.16, 0.15, 0.2, BEAR.fur).ell(0, 1.01, 1.04, 0.08, 0.07, 0.11, BEAR.muzzle).ell(0, 1.04, 1.13, 0.036, 0.03, 0.03, BEAR.nose);
      b.ell(0.13, 1.21, 0.8, 0.055, 0.055, 0.025, BEAR.fur).ell(-0.13, 1.21, 0.8, 0.055, 0.055, 0.025, BEAR.fur);
    } },
    { parent: 0, pivot: [0.2, 0.74, 0.4], mesh: 2, build: (b) => {
      b.limb(0, 0.74, 0, 0, 0.07, 0.02, 0.125, 0.085, BEAR.fur).ell(0, 0.04, 0.07, 0.09, 0.05, 0.12, BEAR.fur).ell(0, 0.015, 0.16, 0.05, 0.015, 0.025, BEAR.claw);
    } },
    { parent: 0, pivot: [-0.2, 0.74, 0.4], mesh: 2 },
    { parent: 0, pivot: [0.21, 0.74, -0.42], mesh: 2 },
    { parent: 0, pivot: [-0.21, 0.74, -0.42], mesh: 2 },
  ];
  return {
    parts,
    solve(k, p, o) {
      o.x = o.y = o.z = 0;
      if (k === 0) { o.x = -1.2 * p.up; o.z = Math.sin(p.gait) * 0.035 * p.amp; }
      else if (k === 1) o.x = p.head + 1.0 * p.up;
      else if (k === 2 || k === 3) o.x = Math.sin(p.gait + (k === 2 ? 0 : Math.PI)) * p.amp + 0.9 * p.up;
      else o.x = Math.sin(p.gait + (k === 5 ? 0 : Math.PI)) * p.amp + 1.2 * p.up;
    },
    vis: () => true,
  };
})();

export const SPECIES = { deer, goose, gull, bear };
export type Kind = keyof typeof SPECIES;

// ── The instanced rig: one mesh per distinct part, rewritten each frame through game.flip ─────────────────────────

export class Rig {
  readonly meshes: (THREE.InstancedMesh | null)[] = [];
  private readonly count: number[] = [];
  private readonly W: THREE.Matrix4[] = [];
  private readonly root = new THREE.Matrix4();
  private readonly lm = new THREE.Matrix4();
  private readonly lq = new THREE.Quaternion();
  private readonly rq = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly rot: Rot = { x: 0, y: 0, z: 0 };
  private readonly col = new THREE.Color();
  /** Instances written this frame (the most any mesh holds). */
  n = 0;

  constructor(readonly sp: Species, cap: number, mat: THREE.Material, readonly group: THREE.Group, flipMesh: (m: THREE.InstancedMesh) => void, shadows: boolean) {
    sp.parts.forEach((d, k) => {
      this.W.push(new THREE.Matrix4());
      this.count.push(0);
      if (d.mesh !== k) { this.meshes.push(null); return; }
      const b = new Build(d.pivot);
      d.build!(b);
      const uses = sp.parts.filter((q) => q.mesh === k).length;
      const m = new THREE.InstancedMesh(b.geometry(), mat, cap * uses);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * uses * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.castShadow = shadows; m.receiveShadow = false; m.count = 0; m.visible = false;
      m.name = 'fauna';
      flipMesh(m);
      group.add(m);
      this.meshes.push(m);
    });
  }

  begin(): void { this.count.fill(0); this.n = 0; }

  /** Write one animal: root at (x, y, z) facing h, uniformly scaled, tilted by pitch and roll, tinted. */
  add(x: number, y: number, z: number, h: number, scale: number, pitch: number, roll: number, p: Pose, tint: number): void {
    this.rq.setFromEuler(this.e.set(pitch, h, roll, 'YXZ'));
    this.root.compose(this.v.set(x, y, z), this.rq, this.s.set(scale, scale, scale));
    this.col.setHex(tint);
    const parts = this.sp.parts, rot = this.rot;
    for (let k = 0; k < parts.length; k++) {
      const d = parts[k];
      this.sp.solve(k, p, rot);
      this.lq.setFromEuler(this.e.set(rot.x, rot.y, rot.z, 'XYZ'));
      if (d.parent < 0) this.v.set(d.pivot[0], d.pivot[1], d.pivot[2]);
      else { const q = parts[d.parent].pivot; this.v.set(d.pivot[0] - q[0], d.pivot[1] - q[1], d.pivot[2] - q[2]); }
      this.lm.compose(this.v, this.lq, this.one);
      this.W[k].multiplyMatrices(d.parent < 0 ? this.root : this.W[d.parent], this.lm);
      if (!this.sp.vis(k, p)) continue;
      const m = this.meshes[d.mesh] as THREE.InstancedMesh, i = this.count[d.mesh]++;
      if (i >= (m.instanceMatrix.count)) { this.count[d.mesh]--; continue; }
      m.setMatrixAt(i, this.W[k]);
      m.setColorAt(i, this.col);
    }
    this.n++;
  }

  end(): void {
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k];
      if (!m) continue;
      const c = this.count[k];
      m.count = c;
      m.visible = c > 0;
      if (c > 0) { sendRange(m.instanceMatrix, c * 16); if (m.instanceColor) sendRange(m.instanceColor, c * 3); }
    }
  }

  setShadows(on: boolean): void { for (const m of this.meshes) if (m) m.castShadow = on; }
  setVisible(on: boolean): void { if (!on) for (const m of this.meshes) if (m) m.visible = false; }
}
