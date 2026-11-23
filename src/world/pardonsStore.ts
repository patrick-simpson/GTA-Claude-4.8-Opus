// Pardon's Surplus & Salvage: the big box on Second Thought Ave, its lot, and the store shell you can walk into.
// Where everything stands: pardonsSite.ts. The models: tools/blender/buildings.py `-- --store` (its header lists the
// objects in models/pardons.glb and what each is for). Unit 1 of the store: the place, the shell, the checkouts;
// the merchandise (pardonsSite.ts DEPARTMENTS) and baked interior light come next.
//
// Loaded through the download queue only once the mainland is wanted, like Main St's models:
//   high / medium: models/pardons.glb (exterior, interior, props); low (phones): models/pardons_far.glb alone.
// Collision, the lot's paint and the shadow box exist from the start, so the store is solid before it is drawn.
// The interior is drawn only with the camera inside or close in front of the glass; its light is in its vertex
// colours (unlit materials), so it costs no lights. The roof is a collision box from the ceiling up, which keeps the
// camera under the ceiling (camera.ts ducks under anything solid above it).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS, groundAt } from './plan';
import { CORRALS, DRIVES_N, LOT_COLS, LOT_LAMPS, PD, ROAD_SIGN, STALL, pdRect } from './pardonsSite';

const NIGHT = { value: 0 };

function canvasTex(n: number, draw: (c: CanvasRenderingContext2D, n: number) => void, srgb = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = cv.height = n;
  const c = cv.getContext('2d')!;
  draw(c, n);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
function rnd(seed: number): () => number { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Split-face block, 2 blocks x 4 courses (0.8 x 0.8 m) per repeat; near white, multiplied by the vertex colour. */
const CMU_M = 0.8;
function cmuTex(): THREE.CanvasTexture {
  return canvasTex(256, (c, n) => {
    const r = rnd(7), bw = n / 2, bh = n / 4;
    c.fillStyle = '#9c9c98'; c.fillRect(0, 0, n, n);
    for (let row = 0; row < 4; row++) for (let k = -1; k < 3; k++) {
      const x = k * bw + (row % 2) * bw / 2, y = row * bh, g = 222 + r() * 24;
      c.fillStyle = `rgb(${g},${g},${g - 3})`; c.fillRect(x + 2, y + 2, bw - 3, bh - 3);
      for (let i = 0; i < 260; i++) { const v = g - 30 + r() * 50; c.fillStyle = `rgba(${v},${v},${v},0.35)`; c.fillRect(x + 2 + r() * (bw - 4), y + 2 + r() * (bh - 4), 1 + r() * 2, 1 + r() * 2); }
    }
  });
}
/** Vinyl composition tile, 8 x 8 tiles of 0.305 m per repeat. */
const VCT_M = 0.305 * 8;
function vctTex(): THREE.CanvasTexture {
  return canvasTex(512, (c, n) => {
    const r = rnd(11), t = n / 8;
    c.fillStyle = '#b9b2a4'; c.fillRect(0, 0, n, n);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const k = r() < 0.04 ? 0.95 : 1, base = [236, 231, 220].map((v) => Math.round(v * k - r() * 6));
      c.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; c.fillRect(i * t + 0.5, j * t + 0.5, t - 1, t - 1);
      for (let s = 0; s < 90; s++) { const v = 150 + r() * 80; c.fillStyle = `rgba(${v},${v - 6},${v - 14},0.45)`; c.fillRect(i * t + r() * t, j * t + r() * t, 1.5, 1.5); }
    }
  });
}
/** Drop ceiling: two 0.6 x 1.2 m tiles per 1.2 m repeat, white T-bar grid, fissured tile. */
const CEIL_M = 1.2;
function ceilTex(): THREE.CanvasTexture {
  return canvasTex(256, (c, n) => {
    const r = rnd(5);
    c.fillStyle = '#e6e5e0'; c.fillRect(0, 0, n, n);
    for (let i = 0; i < 1600; i++) { const v = 196 + r() * 40; c.fillStyle = `rgba(${v},${v},${v - 4},0.6)`; c.fillRect(r() * n, r() * n, 1 + r() * 3, 1); }
    c.fillStyle = '#c9c8c3';
    c.fillRect(0, 0, n, 4); c.fillRect(0, 0, 4, n); c.fillRect(n / 2 - 2, 0, 4, n);
  });
}
function asphaltTex(): THREE.CanvasTexture {
  return canvasTex(256, (c, n) => {
    const r = rnd(3);
    c.fillStyle = '#5e6061'; c.fillRect(0, 0, n, n);
    for (let i = 0; i < 9000; i++) { const v = 60 + r() * 70; c.fillStyle = `rgba(${v},${v},${v},0.5)`; c.fillRect(r() * n, r() * n, 1 + r() * 1.5, 1 + r() * 1.5); }
    for (let i = 0; i < 4; i++) { c.fillStyle = 'rgba(40,40,40,0.05)'; c.beginPath(); c.arc(r() * n, r() * n, 10 + r() * 40, 0, 7); c.fill(); }
  });
}

/** World-space coordinates in units of `m` meters, from position and normal (the meshes are placed by matrix, so give it). */
function planarUV(g: THREE.BufferGeometry, m: number, mat: THREE.Matrix4): void {
  const p = g.getAttribute('position'), nr = g.getAttribute('normal');
  const uv = new Float32Array(p.count * 2), v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(mat);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(mat); n.fromBufferAttribute(nr, i).applyMatrix3(nm);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u: number, w: number;
    if (ay > 0.7) { u = v.x / m; w = v.z / m; } else if (ax > az) { u = v.z / m; w = v.y / m; } else { u = v.x / m; w = v.y / m; }
    uv[i * 2] = u; uv[i * 2 + 1] = w;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class PardonsStore {
  readonly group = new THREE.Group();
  private interior = new THREE.Group();
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private low: boolean;
  private Y: number;
  private M: THREE.Matrix4;
  private inv: THREE.Matrix4;
  private cam = new THREE.Vector3();
  private loc = new THREE.Vector3();
  private shown = true;
  private glass: THREE.MeshStandardMaterial | null = null;
  private stdMats: THREE.MeshStandardMaterial[] = [];
  private lens: THREE.MeshBasicMaterial | null = null;
  private leaves: { mesh: THREE.Object3D; x0: number; dir: number; open: number }[] = [];
  private doorAt: { x: number; z: number }[] = [];
  /** Whether the camera is inside the store (for the rest of the game: sound, weather). */
  inside = false;

  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.group.name = 'pardons'; this.interior.name = 'pardons-interior';
    this.Y = groundAt(PD.XE - PD.SW / 2, PD.ZF + PD.SD / 2);
    this.M = new THREE.Matrix4().makeRotationY(Math.PI).setPosition(PD.XE, this.Y, PD.ZF);
    this.inv = this.M.clone().invert();
    parent.add(this.group);
    this.solid();
    this.lot();
    this.shadowBox();
    for (const [d0, d1] of PD.DOORS) this.doorAt.push({ x: (d0 + d1) / 2, z: PD.SBZ });
  }

  /** Walls, the storefront with its door gaps, the roof from the ceiling up, the soffit, columns, counters, bollards, lot furniture. */
  private solid(): void {
    const col = this.game.col, Y = this.Y;
    const box = (x0: number, z0: number, x1: number, z1: number, y1: number, y0 = -1) => { const r = pdRect(x0, z0, x1, z1); col.addBox(r.x0, r.z0, r.x1, r.z1, Y + y1, Y + y0); };
    const { SW, SD, SH, SEW, SBZ, SEH, SCH } = PD;
    box(0, -SD - 0.1, SW, -SD + 0.3, SH);
    box(SW - 0.3, -SD, SW + 0.1, 0.1, SH);
    box(-0.1, -SD, 0.3, SBZ + 0.05, SEH);
    box(SEW - 0.3, -0.3, SW, 0.1, SH);
    box(SEW - 0.3, -0.3, SEW, SBZ + 0.05, SEH);
    let x = 0;
    for (const [d0, d1] of PD.DOORS) { box(x, SBZ - 0.15, d0, SBZ + 0.05, SEH); box(d0, SBZ - 0.15, d1, SBZ + 0.05, SEH, 2.3); x = d1; }
    box(x, SBZ - 0.15, SEW, SBZ + 0.05, SEH);
    box(0, -SD, SW, 0, SEH, SCH);
    box(0, 0, SEW, SBZ, SEH, SCH);
    box(0.3, PD.SOFFIT_Z, 60, -0.3, SCH, PD.SOFFIT_Y);
    for (const cx of PD.COLS_X) for (const cz of PD.COLS_Z) box(cx - 0.17, cz - 0.17, cx + 0.17, cz + 0.17, SCH);
    for (const lx of PD.LANES) { box(lx, -7.22, lx + 0.82, -2.3, 1.12); box(lx + 0.8, -3.6, lx + 1.5, -2.3, 0.82); }
    box(1.0, -6.45, 7.05, -5.55, 1.1); box(6.2, -9.0, 7.0, -6.4, 1.05);
    for (let k = 0; k < 11; k++) { const bx = 1.1 + k * 2.08; box(bx - 0.16, SBZ + 3.54, bx + 0.16, SBZ + 3.86, 1.16); }
    // The lot: lamp bases, corrals, the road sign's posts.
    for (const [lx, lz] of LOT_LAMPS) col.addBoxC(lx, lz, 0.7, 0.7, Y + 0.7, Y - 1);
    for (const q of CORRALS) col.addBoxC(q.x, q.z, 6.1, 1.4, Y + 1.05, Y - 1);
    for (const s of [-1.7, 1.7]) col.addBoxC(ROAD_SIGN.x, ROAD_SIGN.z + s, 0.6, 0.6, Y + 9.4, Y - 1);
    col.addBoxC(ROAD_SIGN.x, ROAD_SIGN.z, 1.2, 5.8, Y + 0.6, Y - 1);
  }

  /** Asphalt over the block, yellow stall lines, curbed islands at the row ends, aprons over the walks at the driveways. */
  private lot(): void {
    const Y = this.Y, L = PD.LOT;
    const quad = (out: number[], x0: number, z0: number, x1: number, z1: number, y: number) => out.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    const asp: number[] = [];
    quad(asp, L.x0, L.z0, L.x1, L.z1, Y + 0.02);
    quad(asp, L.x0, L.z1, PD.XE - PD.SW, PD.ZF + PD.SD + 3, Y + 0.02);   // round the west end toward the back
    for (const [a, b] of DRIVES_N) quad(asp, a, L.z0 - 3.6, b, L.z0, Y + 0.025);
    quad(asp, L.x1, -1172, L.x1 + 3.6, -1164, Y + 0.025);
    const lines: number[] = [], LW = 0.06;
    const n = Math.floor((STALL.z1 - STALL.z0) / STALL.w);
    for (const c of LOT_COLS) {
      if (c.kind === 'A') continue;
      for (let k = 0; k <= n; k++) { const z = STALL.z0 + k * STALL.w; quad(lines, c.x0 + 0.3, z - LW, c.x1 - 0.3, z + LW, Y + 0.035); }
      if (c.kind === 'D') quad(lines, (c.x0 + c.x1) / 2 - LW, STALL.z0, (c.x0 + c.x1) / 2 + LW, STALL.z1, Y + 0.035);
    }
    // Crosswalk stripes from the lot to the doors.
    for (const [d0, d1] of PD.DOORS) {
      const xw = PD.XE - (d0 + d1) / 2;
      for (let k = -3; k <= 3; k++) quad(lines, xw + k * 0.9 - 0.25, PD.ZF - PD.SBZ - 12, xw + k * 0.9 + 0.25, PD.ZF - PD.SBZ - 4.4, Y + 0.035);
    }
    const geo = (a: number[]) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); g.computeVertexNormals(); return g; };
    const ag = geo(asp); planarUV(ag, 9, new THREE.Matrix4());
    const am = new THREE.Mesh(ag, new THREE.MeshStandardMaterial({ map: asphaltTex(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    am.receiveShadow = true; am.name = 'pardons-lot'; am.renderOrder = -1;
    const lm = new THREE.Mesh(geo(lines), new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    lm.receiveShadow = true;
    // Islands: a curb and grass at each end of the double rows.
    const isl: THREE.BufferGeometry[] = [], grass: THREE.BufferGeometry[] = [];
    for (const c of LOT_COLS) {
      if (c.kind !== 'D') continue;
      for (const zc of [STALL.z0 - 1.3, STALL.z1 + 1.3]) {
        isl.push(new THREE.BoxGeometry(c.x1 - c.x0 - 0.6, 0.16, 2.2).translate((c.x0 + c.x1) / 2, Y + 0.08, zc));
        grass.push(new THREE.BoxGeometry(c.x1 - c.x0 - 0.9, 0.02, 1.9).translate((c.x0 + c.x1) / 2, Y + 0.17, zc));
      }
    }
    const im = new THREE.Mesh(mergeGeometries(isl), new THREE.MeshStandardMaterial({ color: 0xc8c3b8, roughness: 0.9 }));
    const gm = new THREE.Mesh(mergeGeometries(grass), new THREE.MeshStandardMaterial({ color: 0x5d7a3a, roughness: 1 }));
    for (const m of [am, lm, im, gm]) { m.receiveShadow = true; m.matrixAutoUpdate = false; this.group.add(m); }
  }

  private shadowBox(): void {
    const { SW, SD, SH, SEW, SBZ, SEH } = PD;
    const g = mergeGeometries([
      new THREE.BoxGeometry(SW, SH, SD).translate(SW / 2, SH / 2, -SD / 2),
      new THREE.BoxGeometry(SEW, SEH, SBZ + 2).translate(SEW / 2, SEH / 2, (SBZ - 2) / 2),
    ].map((b) => b.deleteAttribute('uv').deleteAttribute('normal').applyMatrix4(this.M)));
    const caster = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    caster.castShadow = true; caster.name = 'pardons-shadow'; caster.matrixAutoUpdate = false;
    this.group.add(caster);
  }

  update(): void {
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const dx = cam.x - (PD.XE - PD.SW / 2), dz = cam.z - (PD.ZF + PD.SD / 2);
    const see = dx * dx + dz * dz < (this.game.quality.drawDist + 120) ** 2;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    if (!see) return;
    const l = this.loc.copy(cam).applyMatrix4(this.inv);
    this.inside = l.x > -0.5 && l.x < PD.SW + 0.5 && l.z > -PD.SD - 0.5 && l.z < PD.SBZ && l.y < PD.SEH;
    const front = l.z >= PD.SBZ && l.z < PD.SBZ + 45 && l.x > -20 && l.x < PD.SEW + 20;
    this.interior.visible = !this.low && (this.inside || front);
    // The doors open for whoever is near: the player (or the camera) within 4 m of the opening.
    const p = this.game.player;
    const pl = this.loc.set(p ? p.x : cam.x, this.Y, p ? p.z : cam.z).applyMatrix4(this.inv);
    const dt = 1 / 60;
    for (const lf of this.leaves) {
      const d = this.doorAt.reduce((m, q) => Math.min(m, Math.hypot(pl.x - q.x, pl.z - q.z)), 1e9);
      const want = d < 4.2 ? 1 : 0;
      lf.open += Math.sign(want - lf.open) * Math.min(Math.abs(want - lf.open), dt * 1.6);
      lf.mesh.position.x = lf.x0 + lf.dir * 1.4 * (lf.open * lf.open * (3 - 2 * lf.open));
    }
    const env = this.env();
    if (this.glass && this.glass.envMap !== env) {
      this.glass.envMap = env; this.glass.needsUpdate = true;
      for (const m of this.stdMats) { m.envMap = env; m.envMapIntensity = 0.7; m.needsUpdate = true; }
    }
  }

  setNight(n: number): void {
    NIGHT.value = n;
    if (this.lens) this.lens.color.setScalar(0.25 + 1.6 * n);
  }

  private async load(): Promise<void> {
    const buf = await assets.bytes(this.low ? 'models/pardons_far.glb' : 'models/pardons.glb');
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) { this.state = 'done'; return; }
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.computeBoundingSphere(); geo.set(o.name, m.geometry); } });
    const std = (extra: THREE.MeshStandardMaterialParameters = {}) => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...extra }); this.stdMats.push(m); return m; };
    const put = (name: string, mat: THREE.Material, into: THREE.Object3D, matrix = this.M, shadow = false) => {
      const g = geo.get(name);
      if (!g) return null;
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); mesh.matrixWorldNeedsUpdate = true;
      mesh.receiveShadow = shadow; mesh.castShadow = false; mesh.name = name;
      into.add(mesh);
      return mesh;
    };
    if (this.low) { put('pd_far', std(), this.group, this.M, true); this.state = 'done'; return; }
    const ext = std();
    put('pd_ext', ext, this.group, this.M, true);
    const cg = geo.get('pd_cmu');
    if (cg) planarUV(cg, CMU_M, this.M);
    put('pd_cmu', std({ map: cmuTex(), roughness: 0.92, color: new THREE.Color(1.22, 1.22, 1.22) }), this.group, this.M, true);
    this.glass = new THREE.MeshStandardMaterial({ color: 0x6f8189, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.32, depthWrite: false });
    const gm = put('pd_glass', this.glass, this.group);
    if (gm) gm.renderOrder = 2;
    // Interior: unlit, its light in the vertex colours.
    put('pd_int', new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }), this.interior);
    const fg = geo.get('pd_floor'), ceg = geo.get('pd_ceil');
    if (fg) planarUV(fg, VCT_M, this.M);
    if (ceg) planarUV(ceg, CEIL_M, this.M);
    put('pd_floor', new THREE.MeshBasicMaterial({ vertexColors: true, map: vctTex(), color: 0xeeeeee, fog: false }), this.interior, new THREE.Matrix4().makeTranslation(0, 0.04, 0).multiply(this.M));
    put('pd_ceil', new THREE.MeshBasicMaterial({ vertexColors: true, map: ceilTex(), color: 0xc8c8c8, fog: false }), this.interior);
    put('pd_lights', new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 1.88, 1.8), fog: false }), this.interior);
    this.group.add(this.interior);
    this.doors();
    // Props: the road sign, corrals, lamp standards (one geometry each, placed by matrix).
    const at = (x: number, z: number, rot: number) => new THREE.Matrix4().makeRotationY(rot).setPosition(x, this.Y, z);
    const pm = std();
    put('pd_sign', pm, this.group, at(ROAD_SIGN.x, ROAD_SIGN.z, Math.PI / 2), true);
    for (const q of CORRALS) put('pd_corral', pm, this.group, at(q.x, q.z, q.open > 0 ? Math.PI / 2 : -Math.PI / 2), true);
    this.lens = new THREE.MeshBasicMaterial({ color: 0x404040 });
    this.setNight(NIGHT.value);
    for (const [lx, lz] of LOT_LAMPS) { put('pd_lamp', pm, this.group, at(lx, lz, 0), true); put('pd_lens', this.lens, this.group, at(lx, lz, 0)); }
    this.state = 'done';
  }

  /** Four sliding glass leaves in bronze frames, sliding sideways behind the fixed glass. */
  private doors(): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.5, metalness: 0.4 });
    const W = 1.5, H = 2.28, T = 0.05;
    const fr = mergeGeometries([
      new THREE.BoxGeometry(W, 0.1, T).translate(0, 0.05, 0), new THREE.BoxGeometry(W, 0.12, T).translate(0, H - 0.06, 0),
      new THREE.BoxGeometry(0.08, H, T).translate(-W / 2 + 0.04, H / 2, 0), new THREE.BoxGeometry(0.08, H, T).translate(W / 2 - 0.04, H / 2, 0),
      new THREE.BoxGeometry(W, 0.06, T * 1.2).translate(0, 1.0, 0),
    ]);
    const pane = new THREE.PlaneGeometry(W - 0.16, H - 0.22).translate(0, H / 2, 0);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false; holder.matrix.copy(this.M);
    for (const [d0, d1] of PD.DOORS) {
      for (const [x0, dir] of [[d0 + W / 2, -1], [d1 - W / 2, 1]] as [number, number][]) {
        const leaf = new THREE.Group();
        leaf.position.set(x0, 0, PD.SBZ - 0.22);
        leaf.add(new THREE.Mesh(fr, frame));
        const p = new THREE.Mesh(pane, this.glass!); p.renderOrder = 2; leaf.add(p);
        holder.add(leaf);
        this.leaves.push({ mesh: leaf, x0, dir, open: 0 });
      }
    }
    this.group.add(holder);
  }
}
