// The stunt park (fun queue item 7): WAIVER PARK, a fenced yard of steel and painted plywood on the open apron east
// of Dock Seven, between the last block (x 580) and the shore. Street z 290 runs straight in at the west gate.
//
//   north band   the Loop-de-Liability (a full vertical loop, 7 m radius, entered heading east from the gate) and a
//                quarter pipe at the east fence to catch whoever comes out of it
//   middle       two half-pipes side by side (run along them, or across them for air) and a spine
//   east fence   the Wall of Debt: a 60 m wall ride, entered heading north at speed along the fence
//   south        a big kicker that clears a row of three containers onto a landing ramp; a long ramp over a 16 m
//                gap to a landing deck; and, through the east gate, a ramp off the shore into Calamity Sound
//
// Everything a car drives on is one height function laid over the plan's ground (plan.ts setGroundExtra), and the
// meshes are built by sampling that same function, so what you see is what the wheels meet. The loop and the wall
// ride cannot be a height map: world/stuntRide.ts holds a car to them (vehicle.ts carHooks) and scores the tricks.
// The park is static scenery for every player; collision boxes for the fence, wall, containers and towers.
//
// Cost: built once, merged per material (about a dozen meshes, frustum-culled), no per-frame work here.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import { setGroundExtra } from './plan';
import { StuntRide } from './stuntRide';

/** The fence, and the pad's height above the street (a kerb, so the pad reads as laid down). */
export const PARK = { x0: 588, z0: 270, x1: 662, z1: 452 };
export const PAD = 0.12;

/** The loop: its foot (entered heading east, +x), radius, and how far it steps to the right (+z) over one turn. */
export const LOOP = { x: 606, z: 289, r: 7, shift: 6, w: 4.6 };
/** The wall ride: its face (x), the z it starts at and runs north (-z) for len metres. */
export const WALL = { x: 659.6, z0: 378, len: 60, hw: 3 };

/** One ramp: height above the pad is p(a) for a along `axis` in [a0, a1], across it in [l0, l1]. */
interface Feature {
  name: string;
  axis: 'x' | 'z';
  a0: number; a1: number; l0: number; l1: number;
  p: (a: number) => number;
  paint: number;
}

const sq = (t: number): number => t * t;
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** A half-pipe whose trough runs along x, centred on zc: 5 m flat, 8 m transitions up to H, a 2 m deck. */
function halfPipe(name: string, zc: number, paint: number): Feature {
  const H = 2.6, F = 2.5, W = 8, D = 2;
  return {
    name, axis: 'z', a0: zc - F - W - D, a1: zc + F + W + D, l0: 596, l1: 636, paint,
    p: (z) => { const d = Math.abs(z - zc); return d < F ? 0 : d < F + W ? H * sq((d - F) / W) : H; },
  };
}

export const FEATURES: Feature[] = [
  // Quarter pipe at the east fence, facing west: catches the loop's exit and the wall ride's.
  { name: 'quarter', axis: 'x', a0: 640, a1: 654, l0: 274, l1: 306, paint: 0xd9893a,
    p: (x) => (x < 651 ? 3.4 * sq((x - 640) / 11) : 3.4) },
  halfPipe('half1', 322, 0x3f7f9a),
  halfPipe('half2', 347, 0x4f8a5c),
  // The spine: two transitions back to back, a ridge along x at z 371.
  { name: 'spine', axis: 'z', a0: 363, a1: 379, l0: 596, l1: 624, paint: 0xc8462c,
    p: (z) => 2.4 * sq(1 - Math.abs(z - 371) / 8) },
  // The big kicker, heading east, over a row of three containers (CONTAINERS) onto the landing ramp.
  { name: 'kicker', axis: 'x', a0: 604, a1: 616, l0: 393, l1: 405.2, paint: 0xe0a526,
    p: (x) => { const t = (x - 604) / 12; return 2.8 * (0.55 * t + 0.45 * t * t); } },
  { name: 'kickLand', axis: 'x', a0: 630, a1: 657, l0: 392, l1: 406.2, paint: 0xe0a526,
    p: (x) => 2.8 * (1 - smooth((x - 630) / 27)) },
  // The long ramp over a 16 m gap to the landing deck, which runs out down a slope to the east.
  { name: 'long', axis: 'x', a0: 598, a1: 612, l0: 419, l1: 431, paint: 0x2f6f8f,
    p: (x) => { const t = (x - 598) / 14; return 3.2 * (0.4 * t + 0.6 * t * t); } },
  { name: 'deck', axis: 'x', a0: 628, a1: 654, l0: 418, l1: 432, paint: 0x2f6f8f,
    p: (x) => (x < 640 ? 3.2 - 0.3 * (x - 628) / 12 : 2.9 * (1 - smooth((x - 640) / 14))) },
  // Out through the east gate, off the shore and into the Sound.
  { name: 'sea', axis: 'x', a0: 650, a1: 662, l0: 441, l1: 449, paint: 0x2a9d8f,
    p: (x) => 3 * sq((x - 650) / 12) * 0.55 + 3 * ((x - 650) / 12) * 0.45 },
];

/** Three forty-footers side by side across the kicker's lane, one high. */
export const CONTAINERS = [0, 1, 2].map((i) => ({ x0: 620 + i * 2.44, x1: 620 + (i + 1) * 2.44, z0: 393, z1: 405.2, y1: 2.6 }));

/** Height above the plan's ground of the park at (x, z): the pad, the ramps and the container tops. */
function parkGround(x: number, z: number, base: number): number {
  if (x < PARK.x0 || x > PARK.x1 || z < PARK.z0 || z > PARK.z1) return base;
  const pad = Math.max(base, 0) + PAD;
  let h = 0;
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    const a = f.axis === 'x' ? x : z, l = f.axis === 'x' ? z : x;
    if (a < f.a0 || a > f.a1 || l < f.l0 || l > f.l1) continue;
    const v = f.p(a);
    if (v > h) h = v;
  }
  for (const c of CONTAINERS) if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1 && c.y1 > h) h = c.y1;
  return Math.max(base, pad + h);
}

// ── Textures ─────────────────────────────────────────────────────────────────

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}
function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** One painted plywood sheet (2.44 x 1.22 m in uv units of 1 x 1): worn paint, grain, seams, screw heads. */
function plywoodTexture(): THREE.CanvasTexture {
  const [c, x] = canvas(256, 128);
  x.fillStyle = '#f4f1ea'; x.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 900; i++) {
    const y = Math.random() * 128, l = 10 + Math.random() * 60;
    x.fillStyle = `rgba(90,70,40,${0.03 + Math.random() * 0.05})`;
    x.fillRect(Math.random() * 256, y, l, 1);
  }
  for (let i = 0; i < 40; i++) {
    x.fillStyle = `rgba(30,30,30,${0.05 + Math.random() * 0.08})`;
    x.beginPath(); x.ellipse(Math.random() * 256, Math.random() * 128, 4 + Math.random() * 18, 2 + Math.random() * 6, 0, 0, 7); x.fill();
  }
  // Tyre scuffs.
  for (let i = 0; i < 6; i++) { x.fillStyle = 'rgba(20,20,20,0.10)'; x.fillRect(0, 20 + Math.random() * 90, 256, 3 + Math.random() * 5); }
  x.fillStyle = 'rgba(40,30,20,0.55)'; x.fillRect(0, 0, 256, 2); x.fillRect(0, 0, 2, 128);
  x.fillStyle = 'rgba(40,40,40,0.6)';
  for (let i = 8; i < 256; i += 31) for (const y of [6, 64, 122]) { x.beginPath(); x.arc(i, y, 1.4, 0, 7); x.fill(); }
  return tex(c);
}

function corrugatedTexture(): THREE.CanvasTexture {
  const [c, x] = canvas(128, 64);
  for (let i = 0; i < 128; i++) { const v = 200 + 40 * Math.sin(i / 128 * Math.PI * 24); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, 0, 1, 64); }
  x.fillStyle = 'rgba(80,50,30,0.25)';
  for (let i = 0; i < 30; i++) x.fillRect(Math.random() * 128, 40 + Math.random() * 24, 1 + Math.random() * 3, 2 + Math.random() * 20);
  return tex(c);
}

function chainTexture(): THREE.CanvasTexture {
  const [c, x] = canvas(64, 64);
  x.strokeStyle = 'rgba(190,196,200,1)'; x.lineWidth = 2.5;
  x.beginPath();
  for (let i = -64; i < 128; i += 16) { x.moveTo(i, 0); x.lineTo(i + 64, 64); x.moveTo(i + 64, 0); x.lineTo(i, 64); }
  x.stroke();
  return tex(c);
}

/** The sponsors, punning in the town's way. One row of the atlas each. */
const BANNERS: [string, string, string, string][] = [
  ['WAIVER PARK', 'Dock Seven Stunt Grounds · Est. by accident', '#14213d', '#f0a202'],
  ['AIRTIME MUTUAL', 'We cover everything that lands', '#e4572e', '#f2e8cf'],
  ['GRAVITY PENDING LTD.', 'Appeals heard on the way down', '#2a9d8f', '#f2e8cf'],
  ['SPLAT COLA', 'The taste of a hard landing', '#c8262c', '#ffd34d'],
  ['DENT & SONS AUTO BODY', 'See you soon', '#f2e8cf', '#14213d'],
  ['LOOP-DE-LIABILITY', '50 MPH OR BUST · keep hands inside the paperwork', '#f0a202', '#14213d'],
  ['LOW TIDE LOANS', 'Your car, briefly airborne', '#14213d', '#9fd8cf'],
  ['THE WALL OF DEBT', 'Keep up the payments or come off', '#4f8a5c', '#f2e8cf'],
];

function bannerAtlas(): THREE.CanvasTexture {
  const [c, x] = canvas(1024, 1024);
  BANNERS.forEach(([title, sub, bg, fg], i) => {
    const y = i * 128;
    x.fillStyle = bg; x.fillRect(0, y, 1024, 128);
    x.strokeStyle = fg; x.lineWidth = 6; x.strokeRect(10, y + 10, 1004, 108);
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = "800 64px 'Big Shoulders Display', 'Arial Narrow', Impact, sans-serif";
    x.fillText(title, 512, y + 52, 960);
    x.font = "600 24px 'Barlow Semi Condensed', 'Arial Narrow', sans-serif";
    x.fillText(sub.toUpperCase(), 512, y + 100, 960);
  });
  return tex(c, false);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

class Kit {
  readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m4 = new THREE.Matrix4();
  private readonly qq = new THREE.Quaternion();
  private readonly ee = new THREE.Euler();

  add(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
    this.qq.setFromEuler(this.ee.set(rx, ry, rz));
    this.m4.compose(new THREE.Vector3(x, y, z), this.qq, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(this.m4);
    let a = this.parts.get(m);
    if (!a) this.parts.set(m, (a = []));
    a.push(g.index ? g.toNonIndexed() : g);
  }
  box(m: THREE.Material, cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, ry = 0): void {
    this.add(new THREE.BoxGeometry(sx, sy, sz), m, cx, y0 + sy / 2, cz, 0, ry, 0);
  }
  /** A tube from a to b. */
  rod(m: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg = 6): void {
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    const len = a.distanceTo(b);
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.m4.compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(this.m4);
    let arr = this.parts.get(m);
    if (!arr) this.parts.set(m, (arr = []));
    arr.push(g.toNonIndexed());
  }
  /** Raw triangles: positions (and uvs) flat, normals computed. */
  tris(m: THREE.Material, pos: number[], uv: number[]): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    let a = this.parts.get(m);
    if (!a) this.parts.set(m, (a = []));
    a.push(g);
  }
  /** A quad a-b-c-d (counter-clockwise seen from the front), uv as given. */
  quad(m: THREE.Material, p: number[][], uv: number[][], pos: number[], uvs: number[]): void {
    for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...p[i]); uvs.push(...uv[i]); }
    void m;
  }
  build(): THREE.Group {
    const grp = new THREE.Group();
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      grp.add(mesh);
      for (const g of list) g.dispose();
    }
    return grp;
  }
}

export class StuntPark implements WorldPart {
  readonly ride: StuntRide;

  constructor(private readonly game: Game, parent: THREE.Group) {
    setGroundExtra(parkGround);
    const K = new Kit();
    const ply = plywoodTexture();
    const paints = new Map<number, THREE.Material>();
    const paint = (c: number): THREE.Material => {
      let m = paints.get(c);
      if (!m) paints.set(c, (m = new THREE.MeshStandardMaterial({ color: c, map: ply, roughness: 0.78, metalness: 0 })));
      return m;
    };
    const steel = new THREE.MeshStandardMaterial({ color: 0xa4acb3, roughness: 0.38, metalness: 0.85 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.7 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.92 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x8e8a82, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2e8cf, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const chain = new THREE.MeshStandardMaterial({ map: chainTexture(), color: 0xc0c6ca, metalness: 0.6, roughness: 0.45, alphaTest: 0.5, side: THREE.DoubleSide });
    chain.map!.repeat.set(1, 1);
    const banner = new THREE.MeshStandardMaterial({ map: bannerAtlas(), roughness: 0.7, side: THREE.DoubleSide });
    const corr = corrugatedTexture();
    const flagMats = [0xe4572e, 0xf0a202, 0x2a9d8f, 0xf2e8cf].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, side: THREE.DoubleSide }));
    const col = this.game.col;

    // The pad: one slab over the fence's rectangle, a kerb's height up, with painted lane lines.
    {
      const P = PARK, pos: number[] = [], uv: number[] = [];
      const y = PAD;
      K.quad(padMat, [[P.x0, y, P.z1], [P.x1, y, P.z1], [P.x1, y, P.z0], [P.x0, y, P.z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], pos, uv);
      // Kerb faces down to the street.
      for (const [ax, az, bx, bz] of [[P.x0, P.z0, P.x0, P.z1], [P.x0, P.z1, P.x1, P.z1], [P.x1, P.z1, P.x1, P.z0], [P.x1, P.z0, P.x0, P.z0]])
        K.quad(padMat, [[ax, -0.6, az], [bx, -0.6, bz], [bx, y, bz], [ax, y, az]], [[0, 0], [1, 0], [1, 1], [0, 1]], pos, uv);
      K.tris(padMat, pos, uv);
      const lp: number[] = [], lu: number[] = [];
      const line = (x0: number, z0: number, x1: number, z1: number): void =>
        K.quad(lineMat, [[x0, y + 0.01, z1], [x1, y + 0.01, z1], [x1, y + 0.01, z0], [x0, y + 0.01, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], lp, lu);
      // The loop's run-in and run-out lanes, and the wall ride's lane.
      for (const dz of [-1.6, 1.6]) { line(588, LOOP.z + dz - 0.08, 606, LOOP.z + dz + 0.08); line(606, LOOP.z + LOOP.shift + dz - 0.08, 640, LOOP.z + LOOP.shift + dz + 0.08); }
      for (let z = 440; z > 312; z -= 6) line(654.5, z - 3, 654.7, z);
      // Chevrons in front of the kicker and the long ramp.
      for (const [zc, x0] of [[399, 590], [425, 584]] as const)
        for (let i = 0; i < 4; i++) { const x = x0 + 4 + i * 2.2; line(x, zc - 2, x + 0.25, zc + 2); }
      K.tris(lineMat, lp, lu);
    }

    // Ramps, sampled from the height function: plywood tops, side skirts, and steel coping along the top edges.
    for (const f of FEATURES) {
      const m = paint(f.paint), skirt = paint(0x4a5560);
      const pos: number[] = [], uv: number[] = [], sp: number[] = [], su: number[] = [];
      const P = (a: number, l: number, y: number): number[] => (f.axis === 'x' ? [a, y, l] : [l, y, a]);
      const n = Math.max(2, Math.ceil((f.a1 - f.a0) / 0.4));
      let arc = 0, prevY = PAD + f.p(f.a0), prevA = f.a0;
      for (let i = 0; i < n; i++) {
        const a0 = f.a0 + (f.a1 - f.a0) * i / n, a1 = f.a0 + (f.a1 - f.a0) * (i + 1) / n;
        const y0 = PAD + f.p(a0), y1 = PAD + f.p(a1);
        const d = Math.hypot(a1 - a0, y1 - y0) / 2.44;
        const L = (f.l1 - f.l0) / 1.22;
        // Wind so the top faces up whichever axis it runs along.
        const quadP = f.axis === 'x'
          ? [P(a0, f.l1, y0), P(a1, f.l1, y1), P(a1, f.l0, y1), P(a0, f.l0, y0)]
          : [P(a0, f.l0, y0), P(a1, f.l0, y1), P(a1, f.l1, y1), P(a0, f.l1, y0)];
        K.quad(m, quadP, [[arc, 0], [arc + d, 0], [arc + d, L], [arc, L]], pos, uv);
        arc += d;
        // Skirts on both lateral sides, down to the pad.
        for (const [l, s] of [[f.l0, -1], [f.l1, 1]] as const) {
          if (y0 - PAD < 0.02 && y1 - PAD < 0.02) continue;
          const q = [P(a0, l, PAD), P(a1, l, PAD), P(a1, l, y1), P(a0, l, y0)];
          const flipW = (f.axis === 'x') === (s > 0);
          K.quad(skirt, flipW ? q : [q[1], q[0], q[3], q[2]], flipW ? [[a0 / 2.44, 0], [a1 / 2.44, 0], [a1 / 2.44, y1 / 1.22], [a0 / 2.44, y0 / 1.22]]
            : [[a1 / 2.44, 0], [a0 / 2.44, 0], [a0 / 2.44, y0 / 1.22], [a1 / 2.44, y1 / 1.22]], sp, su);
        }
        // Coping: a steel pipe along the edge wherever the side stands up.
        if (y0 - PAD > 0.3) for (const l of [f.l0, f.l1]) { const A = P(prevA, l, prevY), B = P(a1, l, y1); K.rod(steel, A[0], A[1] + 0.04, A[2], B[0], B[1] + 0.04, B[2], 0.05, 5); }
        prevY = y1; prevA = a1;
      }
      // End faces where a ramp stops in the air.
      for (const [a, s] of [[f.a0, -1], [f.a1, 1]] as const) {
        const y = PAD + f.p(a);
        if (y - PAD < 0.05) continue;
        const q = [P(a, f.l0, PAD), P(a, f.l1, PAD), P(a, f.l1, y), P(a, f.l0, y)];
        const front = (f.axis === 'x') === (s < 0);
        K.quad(skirt, front ? q : [q[1], q[0], q[3], q[2]], [[0, 0], [(f.l1 - f.l0) / 2.44, 0], [(f.l1 - f.l0) / 2.44, y / 1.22], [0, y / 1.22]], sp, su);
        // A pipe along the lip.
        const A = P(a, f.l0, y + 0.05), B = P(a, f.l1, y + 0.05);
        K.rod(steel, A[0], A[1], A[2], B[0], B[1], B[2], 0.06, 6);
      }
      K.tris(m, pos, uv);
      K.tris(skirt, sp, su);
    }

    // Containers in the kicker's gap.
    const contCols = [0x2a7f8f, 0xc23b22, 0xd9a21b];
    CONTAINERS.forEach((c, i) => {
      const m = new THREE.MeshStandardMaterial({ color: contCols[i], map: corr, roughness: 0.6, metalness: 0.35 });
      K.box(m, (c.x0 + c.x1) / 2, PAD, (c.z0 + c.z1) / 2, c.x1 - c.x0 - 0.04, c.y1, c.z1 - c.z0);
      col.addBox(c.x0, c.z0, c.x1, c.z1, PAD + c.y1, PAD - 0.5);
    });

    this.buildLoop(K, steel, darkSteel, paint(0xe4572e));
    this.buildWall(K, steel, paint(0x4f8a5c));

    // The fence: concrete barrier blocks with chain link above, posts every 3 m, gates where lanes run through.
    const gaps: Record<string, [number, number][]> = {
      w: [[281, 299], [390, 449]], e: [[391, 451.5]], n: [[614, 638], [652, 661.5]], s: [[598, 618]],
    };
    const sides: [string, number, number, number, number][] = [
      ['n', PARK.x0, PARK.z0, PARK.x1, PARK.z0], ['s', PARK.x0, PARK.z1, PARK.x1, PARK.z1],
      ['w', PARK.x0, PARK.z0, PARK.x0, PARK.z1], ['e', PARK.x1, PARK.z0, PARK.x1, PARK.z1],
    ];
    const cp: number[] = [], cu: number[] = [];
    let flagI = 0;
    for (const [k, ax, az, bx, bz] of sides) {
      const alongX = az === bz, a0 = alongX ? ax : az, a1 = alongX ? bx : bz;
      const segs: [number, number][] = [];
      let s = a0;
      for (const [g0, g1] of gaps[k]) { segs.push([s, g0]); s = g1; }
      segs.push([s, a1]);
      for (const [s0, s1] of segs) {
        if (s1 - s0 < 0.5) continue;
        const fixed = alongX ? az : ax;
        const X = (a: number): number => (alongX ? a : fixed), Z = (a: number): number => (alongX ? fixed : a);
        // Barrier blocks.
        const len = s1 - s0, mid = (s0 + s1) / 2;
        K.box(concrete, X(mid), PAD, Z(mid), alongX ? len : 0.6, 0.85, alongX ? 0.6 : len);
        col.addBox(alongX ? s0 : fixed - 0.4, alongX ? fixed - 0.4 : s0, alongX ? s1 : fixed + 0.4, alongX ? fixed + 0.4 : s1, PAD + 2.9, PAD - 1);
        // Chain link from 0.85 to 2.9 m.
        const y0 = PAD + 0.85, y1 = PAD + 2.9;
        K.quad(chain, [[X(s0), y0, Z(s0)], [X(s1), y0, Z(s1)], [X(s1), y1, Z(s1)], [X(s0), y1, Z(s0)]], [[0, 0], [len / 1.2, 0], [len / 1.2, 1.7], [0, 1.7]], cp, cu);
        for (let a = s0; a <= s1 + 0.01; a += len / Math.max(1, Math.round(len / 3))) {
          K.rod(steel, X(a), PAD, Z(a), X(a), y1 + 0.1, Z(a), 0.04, 5);
          // A flag on every fourth post.
          if (flagI++ % 4 === 0) {
            const top = y1 + 2.2;
            K.rod(steel, X(a), y1, Z(a), X(a), top, Z(a), 0.03, 4);
            const fp = [X(a), top, Z(a), X(a), top - 0.7, Z(a), X(a) + (alongX ? 1.1 : 0), top - 0.35, Z(a) + (alongX ? 0 : 1.1)];
            K.tris(flagMats[flagI % flagMats.length], fp, [0, 1, 0, 0, 1, 0.5]);
          }
        }
        K.rod(steel, X(s0), y1, Z(s0), X(s1), y1, Z(s1), 0.035, 5);
      }
    }
    K.tris(chain, cp, cu);

    // Banners: on the fences, facing in, one row of the atlas each.
    const ban = (row: number, cx: number, y: number, cz: number, w: number, h: number, ry: number): void => {
      const g = new THREE.PlaneGeometry(w, h);
      const u = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < u.count; i++) u.setY(i, 1 - (row + 1 - u.getY(i)) / 8);
      K.add(g, banner, cx, y, cz, 0, ry, 0);
    };
    // The entrance arch over the west gate.
    for (const z of [280.6, 299.4]) { K.rod(darkSteel, PARK.x0, PAD, z, PARK.x0, PAD + 7, z, 0.18, 8); col.addProp(PARK.x0, z, 0.3, 7, 'post', false); }
    ban(0, PARK.x0, PAD + 6.1, 290, 18.4, 2.3, -Math.PI / 2);
    ban(0, PARK.x0 + 0.05, PAD + 6.1, 290, 18.4, 2.3, Math.PI / 2);
    K.rod(darkSteel, PARK.x0, PAD + 7.3, 280.6, PARK.x0, PAD + 7.3, 299.4, 0.12, 6);
    const fy = PAD + 1.85;
    ban(1, 600, fy, PARK.z0 + 0.35, 10, 1.25, 0);
    ban(2, 660, fy, PARK.z0 + 0.35, 4, 0.5, 0);
    ban(3, PARK.x0 + 0.35, fy, 315, 10, 1.25, Math.PI / 2);
    ban(4, PARK.x0 + 0.35, fy, 355, 10, 1.25, Math.PI / 2);
    ban(6, PARK.x0 + 0.35, fy, 380, 10, 1.25, Math.PI / 2);
    ban(3, 640, fy, PARK.z1 - 0.35, 10, 1.25, Math.PI);
    ban(1, 590, fy, PARK.z1 - 0.35, 10, 1.25, Math.PI);
    // On the loop's crossbeam and the wall's top.
    ban(5, LOOP.x - 0.25, PAD + 2 * LOOP.r + 2.2, LOOP.z + LOOP.shift / 2, 12, 1.5, -Math.PI / 2);
    ban(5, LOOP.x + 0.25, PAD + 2 * LOOP.r + 2.2, LOOP.z + LOOP.shift / 2, 12, 1.5, Math.PI / 2);
    ban(7, WALL.x - 0.08, PAD + 7.2, WALL.z0 - WALL.len / 2, 16, 2, -Math.PI / 2);
    // Between the half-pipes, on the shared deck.
    ban(2, 616, PAD + 3.6, 334.5, 12, 1.5, 0);
    ban(2, 616, PAD + 3.6, 334.6, 12, 1.5, Math.PI);

    const grp = K.build();
    grp.name = 'stunt-park';
    parent.add(grp);
    this.ride = new StuntRide(game);
  }

  /** The loop: a ribbon on the inside of a 7 m circle that steps sideways as it goes round, rails, ribs and two towers. */
  private buildLoop(K: Kit, steel: THREE.Material, dark: THREE.Material, deck: THREE.Material): void {
    const L = LOOP, N = 128, hw = L.w / 2;
    const pos: number[] = [], uv: number[] = [], back: number[] = [], bu: number[] = [];
    const at = (t: number, r: number, dz: number): number[] => [L.x + r * Math.sin(t), PAD + L.r - r * Math.cos(t), L.z + L.shift * t / (Math.PI * 2) + dz];
    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
      const u0 = i * (Math.PI * 2 * L.r / N) / 2.44, u1 = u0 + (Math.PI * 2 * L.r / N) / 2.44;
      const v1 = L.w / 1.22;
      // The driving face looks in toward the centre.
      K.quad(deck, [at(t0, L.r, hw), at(t1, L.r, hw), at(t1, L.r, -hw), at(t0, L.r, -hw)], [[u0, v1], [u1, v1], [u1, 0], [u0, 0]], pos, uv);
      K.quad(dark, [at(t0, L.r + 0.25, -hw), at(t1, L.r + 0.25, -hw), at(t1, L.r + 0.25, hw), at(t0, L.r + 0.25, hw)], [[0, 0], [1, 0], [1, 1], [0, 1]], back, bu);
      for (const s of [-1, 1]) {
        // Edge plates between the deck and its back, and a guard rail on posts.
        const a = at(t0, L.r, s * hw), b = at(t1, L.r, s * hw), c = at(t1, L.r + 0.25, s * hw), d = at(t0, L.r + 0.25, s * hw);
        K.quad(dark, s > 0 ? [a, b, c, d] : [b, a, d, c], [[0, 0], [1, 0], [1, 1], [0, 1]], back, bu);
        const ra = at(t0, L.r - 0.55, s * (hw + 0.05)), rb = at(t1, L.r - 0.55, s * (hw + 0.05));
        K.rod(steel, ra[0], ra[1], ra[2], rb[0], rb[1], rb[2], 0.06, 5);
        if (i % 4 === 0) { const p0 = at(t0, L.r, s * (hw + 0.05)); K.rod(steel, p0[0], p0[1], p0[2], ra[0], ra[1], ra[2], 0.04, 4); }
      }
      // Ribs round the back every 8 segments.
      if (i % 8 === 0) {
        const a = at(t0, L.r + 0.25, -hw - 0.1), b = at(t0, L.r + 0.25, hw + 0.1), o = at(t0, L.r + 0.75, 0);
        K.rod(steel, a[0], a[1], a[2], o[0], o[1], o[2], 0.07, 5);
        K.rod(steel, b[0], b[1], b[2], o[0], o[1], o[2], 0.07, 5);
      }
    }
    K.tris(deck, pos, uv);
    K.tris(dark, back, bu);
    // A spine of tube round the outside, through the ribs.
    for (let i = 0; i < N; i += 2) {
      const a = at((i / N) * Math.PI * 2, L.r + 0.75, 0), b = at(((i + 2) / N) * Math.PI * 2, L.r + 0.75, 0);
      K.rod(steel, a[0], a[1], a[2], b[0], b[1], b[2], 0.11, 6);
    }
    // Two lattice towers either side, a crossbeam over the top, and the top of the loop hung from it.
    const top = PAD + 2 * L.r + 1.2, zA = L.z - hw - 3, zB = L.z + L.shift + hw + 3;
    for (const z of [zA, zB]) {
      for (const dx of [-0.8, 0.8]) for (const dz of [-0.8, 0.8]) K.rod(dark, L.x + dx * 1.6, PAD, z + dz * 1.6, L.x + dx * 0.5, top, z + dz * 0.5, 0.09, 6);
      for (let y = PAD + 1.5; y < top; y += 2.2) {
        const k = 1.6 - (1.1 * (y - PAD)) / (top - PAD), k2 = 1.6 - (1.1 * (y + 2.2 - PAD)) / (top - PAD);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)
          K.rod(dark, L.x + sx * 0.8 * k, y, z + sz * 0.8 * k, L.x - sz * 0.8 * k2, Math.min(top, y + 2.2), z + sx * 0.8 * k2, 0.04, 4);
      }
      this.game.col.addProp(L.x, z, 1.4, top, 'post', false);
    }
    K.rod(dark, L.x, top, zA, L.x, top, zB, 0.22, 8);
    const tz = L.z + L.shift / 2;
    for (const dz of [-1.6, 1.6]) K.rod(steel, L.x, top, tz + dz, L.x, PAD + 2 * L.r + 0.25, tz + dz, 0.05, 4);
    // Run-in and run-out plates on the pad, so the loop does not start out of nothing.
    const plates: number[] = [], pu: number[] = [];
    for (const [x0, x1, z] of [[600, 606, L.z], [606, 612, L.z + L.shift]] as const)
      K.quad(deck, [[x0, PAD + 0.02, z + hw], [x1, PAD + 0.02, z + hw], [x1, PAD + 0.02, z - hw], [x0, PAD + 0.02, z - hw]], [[0, 1], [1, 1], [1, 0], [0, 0]], plates, pu);
    K.tris(deck, plates, pu);
  }

  /** The wall ride: a 60 m plywood wall at the east fence with a curved foot, posts and braces behind. */
  private buildWall(K: Kit, steel: THREE.Material, face: THREE.Material): void {
    const W = WALL, z0 = W.z0 - W.len - 6, z1 = W.z0 + 6, H = 6.6, x = W.x;
    const pos: number[] = [], uv: number[] = [];
    K.quad(face, [[x, PAD, z0], [x, PAD, z1], [x, PAD + H, z1], [x, PAD + H, z0]], [[0, 0], [(z1 - z0) / 2.44, 0], [(z1 - z0) / 2.44, H / 1.22], [0, H / 1.22]], pos, uv);
    // The foot: a quarter circle of 1.2 m, so a wheel can roll up onto the face.
    const R = 1.2, n = 6;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI / 2, a1 = ((i + 1) / n) * Math.PI / 2;
      const p = (a: number): [number, number] => [x - R + R * Math.sin(a), PAD + R - R * Math.cos(a)];
      const [xa, ya] = p(a0), [xb, yb] = p(a1);
      K.quad(face, [[xa, ya, z1], [xb, yb, z1], [xb, yb, z0], [xa, ya, z0]], [[0, i / n], [0, (i + 1) / n], [(z1 - z0) / 2.44, (i + 1) / n], [(z1 - z0) / 2.44, i / n]], pos, uv);
    }
    K.tris(face, pos, uv);
    K.box(face, x + 0.15, PAD, (z0 + z1) / 2, 0.3, H, z1 - z0);
    for (let z = z0; z <= z1 + 0.01; z += 4) {
      K.rod(steel, x + 0.6, PAD, z, x + 0.6, PAD + H + 0.2, z, 0.08, 6);
      K.rod(steel, x + 0.6, PAD + H, z, x + 1.4, PAD, z, 0.05, 5);
    }
    K.rod(steel, x + 0.1, PAD + H + 0.05, z0, x + 0.1, PAD + H + 0.05, z1, 0.07, 6);
    this.game.col.addBox(x, z0, x + 0.9, z1, PAD + H, PAD - 1);
  }

  update(dt: number): void { this.ride.update(dt); }
}
