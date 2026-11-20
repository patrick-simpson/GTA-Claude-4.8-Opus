// The cars as files. tools/blender/cars.py writes public/models/<kind>.glb; this
// reads one and turns it into the few merged geometries the vehicle code draws.
//
// What a file holds: nodes with no transforms, LOD0 .. LOD2 and WHEEL0 ..
// WHEEL2 (two levels in the older files), each a mesh with one primitive per
// material. Materials are told apart by NAME: paint, trim, chrome, glass, lens,
// interior, tire, rim and the lamp sections in LAMP below. Every primitive has
// position, normal and COLOR_0 (linear albedo times baked ambient occlusion;
// paint and glass carry occlusion only; alpha is how opaque a pane is). Empties
// named HEAD* / TAIL* mark where the glow sprites go.
//
// Textures: a kind listed in TEX_KINDS has UVs on its two near levels and two
// pictures beside its file, <kind>_n.webp (tangent-space normals) and
// <kind>_o.webp (ambient occlusion, which those levels then do NOT carry in
// their vertex colours). Tires of every kind share cars_wheel_n/_o.webp, which
// repeats round the wheel. The far level has neither, and phones draw only it.
// Every kind's pictures are copied into ONE pair of sheets, a cell each, and
// the kind's UVs are moved into its cell here: with a texture of its own each
// kind needed materials of its own, and thirty parked cars then spent more
// time changing material than drawing (measured: 0.9 ms a frame at high).
// The frame is already the
// game's: +Z forward, Y up, y = 0 the road, origin midway between the axles,
// +X the car's left. A wheel has its hub at the origin, axle along X, outer
// face toward +X, and is modelled at its real size.
//
// What comes out, per level of detail, is at most four geometries, so a kind
// costs four draw calls however many materials the modeller used:
//   paint   the body shell; the per-instance colour multiplies the occlusion
//   detail  everything else opaque (trim, chrome, lamps, interior), told apart
//           in the shader by a per-vertex `aPbr` = roughness, metalness, lamp
//           section (0 none, then LAMP below; an indicator is 5 on the car's
//           left and 6 on its right)
//   glass   the windows, with the `aSky` height the glass sheen wants
//   wheel   tire and rim, in `aPbr` form too, scaled to radius 1 and width 1
//           so the wheel matrices the game already builds fit it unchanged
//
// Which kinds have a file is the list below, not a probe: a 404 is written to
// the browser console whatever the code does with the response, and the dev
// server answers a missing file with index.html and a 200. Add a kind here when
// its .glb lands in public/models. A listed file that is missing or broken is
// skipped quietly and the kind keeps its procedural model.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleKind } from './vehicleSpecs';

/** Kinds with a file in public/models. Keep in step with that folder. */
export const GLB_KINDS: readonly VehicleKind[] = [
  'sedan', 'hatch', 'coupe', 'muscle', 'sports', 'pickup', 'van', 'taxi', 'tow', 'bus', 'cruiser', 'bolt',
];

/** Kinds with <kind>_n.webp and <kind>_o.webp beside the model. Keep in step with that folder, as GLB_KINDS. */
export const TEX_KINDS: readonly VehicleKind[] = GLB_KINDS;
/** cars_wheel_n.webp and cars_wheel_o.webp are in the folder. */
const WHEEL_TEX: boolean = true;

/** The sheet all kinds' maps are gathered on: a cell of CELL texels for each kind in TEX_KINDS, in reading order. */
const COLS = 4, ROWS = 3, CELL = 1024;
/** The longer side of that sheet in texels: a video card that cannot hold a texture this size must not be sent it. */
export const SHEET_TEXELS = Math.max(COLS, ROWS) * CELL;

/** Baked maps for one unwrap: normals as two channels (z is rebuilt in the shader), occlusion as one. */
export interface CarMaps { normal: THREE.Texture; ao: THREE.Texture }

export interface VehicleLod {
  paint: THREE.BufferGeometry;
  detail: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  /** Unit wheel (radius 1, width 1, outer face +X), or null if the file has none. */
  wheel: THREE.BufferGeometry | null;
}

export interface VehicleAsset {
  kind: VehicleKind;
  /** Nearest first: one, two or three levels, as many as the file has. */
  lods: VehicleLod[];
  /** The file lights its brake lamps as their own section; without it the tail lenses do both jobs. */
  sections: boolean;
  /** Lamp centers, from nodes named HEAD* / TAIL* if the file has them, else from the lens meshes. May be empty. */
  head: THREE.Vector3[];
  tail: THREE.Vector3[];
  /** The baked maps of the near levels, where the kind has them and the preset wants them. */
  maps: CarMaps | null;
  /** The shared tire maps, likewise. */
  wheelMaps: CarMaps | null;
  /** From nodes named SEAT / BEACON, if present. */
  seat: THREE.Vector3 | null;
  beacon: THREE.Vector3 | null;
  /** Things found wrong with the file and corrected here, for the modeller. */
  notes: string[];
}

/** Roughness, metalness, lamp class for the materials the file's own numbers do not cover. */
const LAMP: Record<string, number> = { lamp_head: 1, lamp_tail: 2, lamp_brake: 3, lamp_rev: 4, lamp_ind: 5, lamp_drl: 7 };

const _v = new THREE.Vector3(), _nm = new THREE.Matrix3();

/** Several primitives poured into one geometry. */
class Bin {
  pos: number[] = []; nor: number[] = []; col: number[] = []; pbr: number[] = []; idx: number[] = []; uv: number[] = [];
  /** Every primitive poured in so far had texture coordinates. */
  hasUv = true;
  /** Colours carry alpha (the glass: how opaque each pane is). */
  constructor(readonly alpha = false) {}

  add(g: THREE.BufferGeometry, m: THREE.Matrix4, rough: number, metal: number, lamp: number): void {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color'), u = g.getAttribute('uv');
    if (!p) return;
    if (!u) this.hasUv = false;
    const base = this.pos.length / 3;
    _nm.getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      if (u) this.uv.push(u.getX(i), u.getY(i)); else this.uv.push(0, 0);
      const px = _v.x;
      if (n) _v.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize(); else _v.set(0, 1, 0);
      this.nor.push(_v.x, _v.y, _v.z);
      // getX undoes the 16-bit normalisation the exporter packs colours in.
      if (c) this.col.push(c.getX(i), c.getY(i), c.getZ(i)); else this.col.push(1, 1, 1);
      if (this.alpha) this.col.push(c && c.itemSize > 3 ? c.getW(i) : 1);
      // An indicator lens belongs to the side of the car it is on.
      this.pbr.push(rough, metal, lamp === 5 && px < 0 ? 6 : lamp);
    }
    const ix = g.getIndex(), count = ix ? ix.count : p.count, flip = m.determinant() < 0;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = base + (ix ? ix.getX(i) : i), b = base + (ix ? ix.getX(i + 1) : i + 1), d = base + (ix ? ix.getX(i + 2) : i + 2);
      if (flip) this.idx.push(a, d, b); else this.idx.push(a, b, d);
    }
  }

  build(pbr: boolean, sky: boolean): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, this.alpha ? 4 : 3));
    if (pbr) g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.pbr, 3));
    if (this.hasUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (sky) {
      // How far up the glass each vertex is: the top of a windshield shows sky, the bottom the dash.
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < this.pos.length; i += 3) { lo = Math.min(lo, this.pos[i]); hi = Math.max(hi, this.pos[i]); }
      const a = new Float32Array(this.pos.length / 3);
      for (let i = 0; i < a.length; i++) a[i] = hi > lo ? (this.pos[i * 3 + 1] - lo) / (hi - lo) : 0.5;
      g.setAttribute('aSky', new THREE.BufferAttribute(a, 1));
    }
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

interface Part { mesh: THREE.Mesh; name: string; rough: number; metal: number; box: THREE.Box3 }

/** The meshes under one named node, with their material names and world-space bounds. */
function parts(root: THREE.Object3D): Part[] {
  const out: Part[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    mesh.geometry.computeBoundingBox();
    out.push({
      mesh, name: (mat.name || 'trim').toLowerCase(), rough: mat.roughness ?? 0.6, metal: mat.metalness ?? 0,
      box: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
    });
  });
  return out;
}

/** Left and right lamp centers from the lens meshes: the middle of each half. (The glow shader pulls its sprites toward the eye, so they need not sit proud of the lens.) */
function lampPoints(ps: Part[], name: string, fix: THREE.Matrix4): THREE.Vector3[] {
  const L = new THREE.Box3(), R = new THREE.Box3(), m = new THREE.Matrix4();
  for (const p of ps) {
    if (p.name !== name) continue;
    const pos = p.mesh.geometry.getAttribute('position');
    m.multiplyMatrices(fix, p.mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) { _v.fromBufferAttribute(pos, i).applyMatrix4(m); (_v.x >= 0 ? L : R).expandByPoint(_v); }
  }
  const out: THREE.Vector3[] = [];
  for (const b of [L, R]) {
    if (b.isEmpty()) continue;
    out.push(b.getCenter(new THREE.Vector3()));
  }
  return out;
}

function buildLod(body: THREE.Object3D, wheel: THREE.Object3D | null, fix: THREE.Matrix4): VehicleLod | null {
  const paint = new Bin(), detail = new Bin(), glass = new Bin(true), m = new THREE.Matrix4();
  for (const p of parts(body)) {
    m.multiplyMatrices(fix, p.mesh.matrixWorld);
    if (p.name === 'paint') paint.add(p.mesh.geometry, m, 0, 0, 0);
    else if (p.name === 'glass' || p.name === 'lens') glass.add(p.mesh.geometry, m, 0, 0, 0);
    else detail.add(p.mesh.geometry, m, p.rough, p.metal, LAMP[p.name] ?? 0);
  }
  const pg = paint.build(false, false);
  if (!pg) return null;
  let wg: THREE.BufferGeometry | null = null;
  if (wheel) {
    const wp = parts(wheel), box = new THREE.Box3(), rim = new THREE.Box3(), bin = new Bin();
    for (const p of wp) { box.union(p.box); if (p.name === 'rim') rim.union(p.box); }
    if (!box.isEmpty()) {
      const w = box.max.x - box.min.x, r = Math.max(box.max.y, -box.min.y, box.max.z, -box.min.z);
      // Outer face toward +X is the contract; a rim that sits on the -X side is turned round.
      const turned = !rim.isEmpty() && rim.min.x + rim.max.x < -1e-4;
      const s = new THREE.Matrix4().makeScale(1 / w, 1 / r, 1 / r);
      if (turned) s.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
      for (const p of wp) { m.multiplyMatrices(s, p.mesh.matrixWorld); bin.add(p.mesh.geometry, m, p.rough, p.metal, 0); }
      wg = bin.build(true, false);
    }
  }
  return { paint: pg, detail: detail.build(true, false), glass: glass.build(false, true), wheel: wg };
}

function buildAsset(kind: VehicleKind, scene: THREE.Object3D): VehicleAsset | null {
  scene.updateMatrixWorld(true);
  const named = new Map<string, THREE.Object3D>();
  scene.traverse((o) => { if (o.name) named.set(o.name.toUpperCase(), o); });
  const lod0 = named.get('LOD0');
  if (!lod0) return null;
  const notes: string[] = [];
  const p0 = parts(lod0);

  // The frame is checked, not trusted: long axis along Z, head lamps ahead of tail lamps.
  const fix = new THREE.Matrix4(), all = new THREE.Box3(), hb = new THREE.Box3(), tb = new THREE.Box3();
  for (const p of p0) { all.union(p.box); if (p.name === 'lamp_head') hb.union(p.box); if (p.name === 'lamp_tail') tb.union(p.box); }
  if (all.max.x - all.min.x > (all.max.z - all.min.z) * 1.15) {
    fix.makeRotationY(Math.PI / 2);
    notes.push('long axis is X, expected Z; turned 90 degrees at load');
    hb.applyMatrix4(fix); tb.applyMatrix4(fix);
  }
  if (!hb.isEmpty() && !tb.isEmpty() && hb.min.z + hb.max.z < tb.min.z + tb.max.z) {
    fix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
    notes.push('faces -Z, expected +Z; turned round at load');
  }
  if (Math.abs(all.min.y) > 0.6) notes.push(`lowest point is y = ${all.min.y.toFixed(2)}, expected the road at 0`);

  const lods: VehicleLod[] = [];
  for (let i = 0; i < 3; i++) {
    const body = named.get('LOD' + i);
    if (!body) break;
    const l = buildLod(body, named.get('WHEEL' + i) ?? named.get('WHEEL' + (i - 1)) ?? named.get('WHEEL0') ?? null, fix);
    if (!l) { if (i === 0) return null; break; }
    lods.push(l);
  }
  if (!lods.length) return null;

  const at = (prefix: string): THREE.Vector3[] => {
    const out: THREE.Vector3[] = [];
    for (const [name, o] of named) {
      if (name.startsWith(prefix) && !(o as THREE.Mesh).isMesh && !o.children.length) out.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(fix));
    }
    // Left first, as the procedural models have it.
    return out.sort((a, b) => b.x - a.x);
  };
  let head = at('HEAD'), tail = at('TAIL');
  if (!head.length) head = lampPoints(p0, 'lamp_head', fix);
  if (!tail.length) tail = lampPoints(p0, 'lamp_tail', fix);
  return { kind, lods, maps: null, wheelMaps: null, sections: p0.some((p) => p.name === 'lamp_brake'), head, tail, seat: at('SEAT')[0] ?? null, beacon: at('BEACON')[0] ?? null, notes };
}

interface Pix { w: number; h: number; d: Uint8Array<ArrayBuffer> }

/**
 * One baked map's texels, `channels` bytes each (1: occlusion, 2: the x and y of a normal), unpacked through a canvas:
 * a twelve-car fleet of full RGBA maps is four times the video memory for nothing. Never throws; null if the file is
 * missing or is not a picture.
 */
async function pixels(url: string, channels: 1 | 2): Promise<Pix | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    // The dev server answers a missing file with the index page.
    if (!blob.type.startsWith('image')) return null;
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    // Read the size BEFORE closing: a closed bitmap reports 0 by 0, and a 0 by 0 texture samples as opaque black.
    const w = bmp.width, h = bmp.height;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, w, h).data;
    bmp.close();
    if (!w || !h || d.length !== w * h * 4) return null;
    const out = new Uint8Array(w * h * channels);
    for (let i = 0, j = 0; i < d.length; i += 4) { out[j++] = d[i]; if (channels === 2) out[j++] = d[i + 1]; }
    return { w, h, d: out };
  } catch {
    return null;
  }
}

function texture(d: Uint8Array<ArrayBuffer>, w: number, h: number, channels: 1 | 2, repeat: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(d, w, h, channels === 1 ? THREE.RedFormat : THREE.RGFormat);
  // Row 0 of the picture is v = 0 in a glTF's coordinates, which is how a DataTexture already reads.
  t.unpackAlignment = 1;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  if (repeat) t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** The tires' maps: a pair of textures of their own, repeating round the wheel. */
async function wheelTextures(): Promise<CarMaps | null> {
  const [n, o] = await Promise.all([pixels('models/cars_wheel_n.webp', 2), pixels('models/cars_wheel_o.webp', 1)]);
  return n && o ? { normal: texture(n.d, n.w, n.h, 2, true), ao: texture(o.d, o.w, o.h, 1, true) } : null;
}

let sheet: { maps: CarMaps; n: Uint8Array<ArrayBuffer>; o: Uint8Array<ArrayBuffer> } | null = null;

/** The shared sheets, made on first use: flat normals and no occlusion until a kind's pictures are copied in. */
function sheets(): NonNullable<typeof sheet> {
  if (!sheet) {
    const W = COLS * CELL, H = ROWS * CELL;
    const n = new Uint8Array(W * H * 2).fill(128), o = new Uint8Array(W * H).fill(255);
    sheet = { maps: { normal: texture(n, W, H, 2, false), ao: texture(o, W, H, 1, false) }, n, o };
  }
  return sheet;
}

/**
 * Give a kind its cell of the sheets: move the UVs of its unwrapped levels there, then copy its two pictures in. A
 * picture that is missing or the wrong size leaves the cell blank (smooth and unshaded), which is a car with no
 * occlusion, not a broken one.
 */
async function place(asset: VehicleAsset): Promise<void> {
  const i = TEX_KINDS.indexOf(asset.kind);
  if (i < 0 || i >= COLS * ROWS) return;
  const cx = i % COLS, cy = Math.floor(i / COLS), s = sheets();
  for (const l of asset.lods) {
    for (const g of [l.paint, l.detail]) {
      const uv = g?.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!uv) continue;
      const a = uv.array as Float32Array;
      for (let k = 0; k < a.length; k += 2) { a[k] = (Math.min(1, Math.max(0, a[k])) + cx) / COLS; a[k + 1] = (Math.min(1, Math.max(0, a[k + 1])) + cy) / ROWS; }
      uv.needsUpdate = true;
    }
  }
  asset.maps = s.maps;
  const [n, o] = await Promise.all([pixels(`models/${asset.kind}_n.webp`, 2), pixels(`models/${asset.kind}_o.webp`, 1)]);
  const W = COLS * CELL;
  if (n && n.w === CELL && n.h === CELL) {
    for (let y = 0; y < CELL; y++) s.n.set(n.d.subarray(y * CELL * 2, (y + 1) * CELL * 2), ((cy * CELL + y) * W + cx * CELL) * 2);
    s.maps.normal.needsUpdate = true;
  }
  if (o && o.w === CELL && o.h === CELL) {
    for (let y = 0; y < CELL; y++) s.o.set(o.d.subarray(y * CELL, (y + 1) * CELL), (cy * CELL + y) * W + cx * CELL);
    s.maps.ao.needsUpdate = true;
  }
}

/**
 * Fetch and build every listed kind, one after another so no frame carries two
 * parses. `onLoad` runs once per kind that arrives; nothing runs for one that
 * does not. Never throws and never logs an error.
 */
export async function loadVehicleAssets(onLoad: (a: VehicleAsset) => void, textures = true, kinds: readonly VehicleKind[] = GLB_KINDS): Promise<void> {
  const loader = new GLTFLoader();
  const wheelMaps = textures && WHEEL_TEX ? await wheelTextures() : null;
  for (const kind of kinds) {
    try {
      const res = await fetch(`models/${kind}.glb`);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      // "glTF". The dev server answers a missing file with the index page.
      if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) continue;
      const gltf = await loader.parseAsync(buf, '');
      const asset = buildAsset(kind, gltf.scene);
      if (!asset) { console.warn(`models/${kind}.glb: no LOD0 with a paint mesh; keeping the procedural ${kind}`); continue; }
      for (const n of asset.notes) console.warn(`models/${kind}.glb: ${n}`);
      // The maps come before the car is shown: its near levels have no occlusion of their own to fall back on.
      if (textures) await place(asset);
      asset.wheelMaps = wheelMaps;
      onLoad(asset);
    } catch (e) {
      console.warn(`models/${kind}.glb did not load; keeping the procedural ${kind}`, e);
    }
  }
}
