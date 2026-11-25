// Fun queue 2, item 19: the little props the town events set out (game/events.ts): striped market stalls, banners on
// two poles, floodlights, strings of lamps and the people (spectators, a parade, carollers). All plain boxes and one
// small canvas texture per sign, so a whole fair is a few dozen draws and only exists in the scene while an event is on
// and the player is near it.

import * as THREE from 'three';
import { groundAt } from '../world/plan';
import { flip } from '../core/flip';
import { RNG } from '../core/util';

const texCache = new Map<string, THREE.CanvasTexture>();

/** A sign: words on a coloured board. */
export function signTex(text: string, bg: string, fg: string, w = 512, h = 128): THREE.CanvasTexture {
  const key = `s|${text}|${bg}|${fg}|${w}`;
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.strokeStyle = fg; x.lineWidth = 6; x.strokeRect(6, 6, w - 12, h - 12);
  let size = h * 0.5;
  x.font = `800 ${size}px "Big Shoulders Display","Arial Narrow",system-ui,sans-serif`;
  while (x.measureText(text).width > w - 40 && size > 14) { size -= 3; x.font = `800 ${size}px "Big Shoulders Display","Arial Narrow",system-ui,sans-serif`; }
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2 + 3);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

function stripeTex(a: string, b: string): THREE.CanvasTexture {
  const key = `t|${a}|${b}`;
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 8;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? b : a; x.fillRect(i * 16, 0, 16, 8); }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  texCache.set(key, t);
  return t;
}

const mats = new Map<number, THREE.MeshStandardMaterial>();
const std = (hex: number): THREE.MeshStandardMaterial => {
  let m = mats.get(hex);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8, metalness: 0 }); mats.set(hex, m); }
  return m;
};
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
function box(g: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, hex: number | THREE.Material, rx = 0): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo, typeof hex === 'number' ? std(hex) : hex);
  m.scale.set(w, h, d); m.position.set(x, y, z); m.rotation.x = rx;
  m.castShadow = true;
  g.add(m);
  return m;
}

/** A market stall at (x, z) facing heading h (the customer side is +z of the stall, rotated by h). */
export function stall(x: number, z: number, h: number, a: string, b: string, label: string, y = groundAt(x, z)): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z); g.rotation.y = h;
  box(g, 2.6, 1.0, 1.0, 0, 0.5, 0, 0x6b4a2e);
  box(g, 2.6, 0.08, 1.1, 0, 1.04, 0, 0x8a6a42);
  box(g, 2.7, 2.3, 0.1, 0, 1.15, -0.62, 0x5a3e26);
  for (const s of [-1, 1]) box(g, 0.1, 2.5, 0.1, s * 1.3, 1.25, 0.55, 0x4a3320);
  const tex = stripeTex(a, b);
  tex.repeat.set(1, 1);
  const awn = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  awn.scale.set(3.0, 0.08, 1.9); awn.position.set(0, 2.55, 0.15); awn.rotation.x = 0.28; awn.castShadow = true;
  g.add(awn);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: signTex(label, '#14213d', '#f2e8cf'), toneMapped: false }));
  sign.position.set(0, 2.15, 0.62);
  g.add(sign);
  // Things on the counter, as little coloured blocks.
  const rng = new RNG(Math.round(x * 7 + z * 13) | 1);
  for (let i = 0; i < 6; i++) box(g, 0.22 + rng.next() * 0.2, 0.2 + rng.next() * 0.2, 0.22, -1 + i * 0.4, 1.2, 0.05, [0xe4572e, 0xf0a202, 0x2a9d8f, 0xf2e8cf, 0x8a3b2e, 0x3d6b9a][i]);
  return g;
}

/** A banner on two poles across (x, z), its face toward heading h. */
export function banner(x: number, z: number, h: number, label: string, width = 8, high = 6.5, bg = '#b3262e', fg = '#f2e8cf', y = groundAt(x, z)): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z); g.rotation.y = h;
  for (const s of [-1, 1]) box(g, 0.2, high + 0.8, 0.2, s * (width / 2 + 0.1), (high + 0.8) / 2, 0, 0x3a3a3a);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map: signTex(label, bg, fg, 1024, 256), side: THREE.DoubleSide, toneMapped: false }));
  sign.position.set(0, high - width / 8, 0);
  g.add(sign);
  return g;
}

/** A floodlight: a pole, a bright head and a faint cone of light (no real light: it costs nothing). */
export function floodlight(x: number, z: number, aimX: number, aimZ: number, hex = 0xfff2c8, y = groundAt(x, z)): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  box(g, 0.35, 13, 0.35, 0, 6.5, 0, 0x555555);
  const head = box(g, 2.2, 0.9, 0.5, 0, 13.2, 0, new THREE.MeshBasicMaterial({ color: hex, toneMapped: false }));
  head.castShadow = false;
  const ang = Math.atan2(aimX - x, aimZ - z), len = Math.hypot(aimX - x, aimZ - z, 13);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(5.5, len, 20, 1, true), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: true }));
  cone.geometry.translate(0, -len / 2, 0);
  cone.position.set(0, 13.2, 0);
  cone.lookAt(new THREE.Vector3(aimX - x, -13, aimZ - z).add(cone.position));
  cone.rotateX(Math.PI / 2);
  g.add(cone);
  g.userData.ang = ang;
  return g;
}

/** A string of lamps between two points, sagging: one instanced mesh of glowing beads. */
export function lampString(pts: { ax: number; az: number; bx: number; bz: number; y: number }[], hexes = [0xff4030, 0xffc040, 0x40d060, 0x4080ff, 0xffffff]): THREE.InstancedMesh {
  let n = 0;
  for (const p of pts) n += Math.max(4, Math.round(Math.hypot(p.bx - p.ax, p.bz - p.az) / 0.6));
  const m = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 6, 4), new THREE.MeshBasicMaterial({ toneMapped: false }), n);
  const mx = new THREE.Matrix4(), c = new THREE.Color();
  let i = 0;
  for (const p of pts) {
    const k = Math.max(4, Math.round(Math.hypot(p.bx - p.ax, p.bz - p.az) / 0.6));
    for (let j = 0; j < k; j++, i++) {
      const t = j / (k - 1), sag = Math.sin(t * Math.PI) * 0.7;
      mx.makeTranslation(p.ax + (p.bx - p.ax) * t, p.y - sag, p.az + (p.bz - p.az) * t);
      m.setMatrixAt(i, mx); m.setColorAt(i, c.setHex(hexes[i % hexes.length]));
    }
  }
  m.frustumCulled = false;
  return m;
}

const SHIRTS = [0xe4572e, 0x2a9d8f, 0xf2e8cf, 0x14213d, 0xf0a202, 0x3d6b9a, 0x8a3b2e, 0xd9d4c7, 0x5a7a3a, 0x222222, 0xb3262e, 0x6d4a8a];

/** A set of simple standing people, each placed (and, for a parade, moved) by the caller. */
export class People {
  readonly mesh: THREE.InstancedMesh;
  readonly n: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(n: number, shirts: readonly number[] = SHIRTS, seed = 11) {
    this.n = n;
    const body = new THREE.BoxGeometry(0.5, 0.7, 0.3); body.translate(0, 1.0, 0);
    const legs = new THREE.BoxGeometry(0.38, 0.65, 0.26); legs.translate(0, 0.33, 0);
    const head = new THREE.BoxGeometry(0.24, 0.26, 0.26); head.translate(0, 1.5, 0);
    const parts = [body, legs, head], pos: number[] = [], nor: number[] = [], idx: number[] = [];
    let off = 0;
    for (const g of parts) {
      const p = g.getAttribute('position'), nn = g.getAttribute('normal'), ix = g.getIndex() as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(nn.getX(i), nn.getY(i), nn.getZ(i)); }
      for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
      off += p.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const R = new RNG(seed), c = new THREE.Color();
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, c.setHex(shirts[Math.floor(R.next() * shirts.length)]).multiplyScalar(0.75 + R.next() * 0.3));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    flip.mesh(this.mesh);
    for (let i = 0; i < n; i++) this.put(i, 0, -9999, 0, 0, 1);
  }

  put(i: number, x: number, y: number, z: number, yaw: number, scale = 1, lean = 0): void {
    this.e.set(lean, yaw, 0); this.q.setFromEuler(this.e);
    this.v.set(x, y, z); this.s.set(scale, scale, scale);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }

  commit(): void { this.mesh.instanceMatrix.needsUpdate = true; }
}

/** An antler pair (the prize): two forked branches of boxes, about 0.6 m across. */
export function antlers(): THREE.Group {
  const g = new THREE.Group();
  const bone = new THREE.MeshStandardMaterial({ color: 0xd8c9a6, roughness: 0.7 });
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(s * 0.12, 0, 0);
    arm.rotation.z = -s * 0.5;
    const main = new THREE.Mesh(boxGeo, bone); main.scale.set(0.045, 0.55, 0.045); main.position.y = 0.27; arm.add(main);
    for (const [y, l, a] of [[0.18, 0.28, 0.9], [0.34, 0.26, 0.8], [0.5, 0.2, 0.7]] as const) {
      const t = new THREE.Mesh(boxGeo, bone); t.scale.set(0.04, l, 0.04);
      t.position.set(s * 0.05 * 0.5 + Math.sin(a) * l * 0.0, y + l * 0.35, 0.0);
      t.rotation.z = s * a * 0.5; t.rotation.x = 0.35;
      t.position.z = 0.08;
      arm.add(t);
    }
    g.add(arm);
  }
  g.traverse((o) => { o.castShadow = false; });
  return g;
}
