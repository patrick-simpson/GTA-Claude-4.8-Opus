// The people as files. tools/blender/people.py writes public/models/person_f.glb
// and person_m.glb; this reads one and turns each level of detail into a single
// geometry the crowd shader in character.ts can draw instanced.
//
// What a file holds (checked here, not assumed): an armature of 19 joints named
// as in BONES, and up to three skinned meshes, LOD0 .. LOD2, each one primitive
// per material. Materials are told apart by NAME (PARTS). Every primitive has
// position, normal, COLOR_0 (baked occlusion times a tint), JOINTS_0 and
// WEIGHTS_0; the colour's alpha is the surface class / 16, +8 when the vertex
// keeps its own colour. LOD0 also has five morph targets, m0..m4, whose meaning depends
// on where the vertex is (see MORPH_GROUP). The frame is the game's: +Z forward,
// +Y up, feet at y = 0, +X the person's left.
//
// What comes out per level is one geometry with
//   position, normal, color
//   aSkin = (bone a, bone b, weight of a, part id)
//   aInfo = (surface class 0..7, 1 if the vertex keeps its own colour, morph group)
//   aM0 .. aM4 = morph deltas (nearest level only)
// Two bones a vertex is all the modeller uses, and half the texture reads of
// four. The game does not use the file's skeleton as objects at all: every
// bone's rest frame is the world's, so a joint is just a position (`joints`),
// and character.ts builds each bone's matrix itself from its own pose channels.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l',
  'shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r',
  'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r',
] as const;

/** Material names in the file, in part-id order. Keep in step with MATS in people.py. */
export const PARTS = [
  'head', 'body', 'arm', 'leg', 'eyewhite', 'iris', 'brow',
  'tee', 'shirt', 'hoodie', 'jacket', 'coverall', 'dress',
  'trousers', 'jeans', 'shorts', 'skirt', 'sneakers', 'boots',
  'hair_crop', 'hair_part', 'hair_long', 'hair_tail', 'hair_bun', 'hair_curls', 'hair_afro', 'hair_bald', 'beard', 'stubble',
  'cap', 'peak_f', 'peak_b', 'beanie', 'brimhat', 'glasses', 'bag', 'belt',
] as const;

/** Surface classes, as people.py numbers them. */
export const CLS = { skin: 0, cloth: 1, leather: 2, rubber: 3, hair: 4, metal: 5, eye: 6, plastic: 7 } as const;
/** Which set of morph weights a vertex takes: the face, an eye, the left hand, the right hand. */
export const MORPH_GROUP = { face: 0, eye: 1, handL: 2, handR: 3 } as const;
export const MORPHS = 5;

export type BodyKind = 'f' | 'm';
export const BODY_KINDS: readonly BodyKind[] = ['f', 'm'];

export interface PersonAsset {
  kind: BodyKind;
  /** Nearest first; one to three levels, as many as the file has. Only the first can carry morphs (aM0..). */
  lods: THREE.BufferGeometry[];
  /** Rest position of each joint, BONES order, xyz. */
  joints: Float32Array;
  /** Things found wrong with the file, for the modeller. */
  notes: string[];
}

const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _l = new THREE.Matrix3();

function build(meshes: THREE.SkinnedMesh[], notes: string[]): THREE.BufferGeometry | null {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], skin: number[] = [], idx: number[] = [], info: number[] = [];
  const mor: number[][] = [[], [], [], [], []];
  const HL = BONES.indexOf('hand_l'), HR = BONES.indexOf('hand_r');
  let morphed = false;
  for (const mesh of meshes) {
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    const part = (PARTS as readonly string[]).indexOf(mat.name);
    if (part < 0) { notes.push(`unknown material ${mat.name}`); continue; }
    const g = mesh.geometry;
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color');
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    const mp = g.morphAttributes.position;
    const eye = mat.name === 'eyewhite' || mat.name === 'iris';
    if (mp && mp.length >= MORPHS) morphed = true;
    if (!p || !si || !sw) { notes.push(`${mat.name} has no skin`); continue; }
    // File bone order to ours.
    const map = mesh.skeleton.bones.map((b) => (BONES as readonly string[]).indexOf(b.name));
    // Geometry space to the rest pose in the world: any joint's world matrix times its inverse bind.
    _m.multiplyMatrices(mesh.skeleton.bones[0].matrixWorld, mesh.skeleton.boneInverses[0]).multiply(mesh.bindMatrix);
    _n.getNormalMatrix(_m);
    _l.setFromMatrix4(_m);
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(_m);
      pos.push(_v.x, _v.y, _v.z);
      if (n) _v.fromBufferAttribute(n, i).applyMatrix3(_n).normalize(); else _v.set(0, 1, 0);
      nor.push(_v.x, _v.y, _v.z);
      if (c) col.push(c.getX(i), c.getY(i), c.getZ(i)); else col.push(1, 1, 1);
      // The two heaviest influences, renormalised.
      let a = 0, b = 0, wa = 0, wb = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k), j = map[si.getComponent(i, k)] ?? -1;
        if (j < 0 || w <= 0) continue;
        if (w > wa) { b = a; wb = wa; a = j; wa = w; } else if (w > wb) { b = j; wb = w; }
      }
      if (wa <= 0) { wa = 1; notes.push(`${mat.name}: a vertex with no weight`); }
      if (wb <= 0) b = a;
      skin.push(a, b, wa / (wa + wb), part);
      const sc = c && c.itemSize > 3 ? Math.round(c.getW(i) * 16) : 1;
      info.push(sc & 7, sc >= 8 ? 1 : 0, eye ? 1 : a === HL ? 2 : a === HR ? 3 : 0);
      // Deltas turn with the mesh, they do not move with it.
      for (let k = 0; k < MORPHS; k++) {
        if (mp && mp[k]) { _v.fromBufferAttribute(mp[k], i).applyMatrix3(_l); mor[k].push(_v.x, _v.y, _v.z); }
        else mor[k].push(0, 0, 0);
      }
    }
    const ix = g.getIndex(), count = ix ? ix.count : p.count;
    for (let i = 0; i < count; i++) idx.push(base + (ix ? ix.getX(i) : i));
  }
  if (!idx.length) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aSkin', new THREE.Float32BufferAttribute(skin, 4));
  out.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  if (morphed) for (let k = 0; k < MORPHS; k++) out.setAttribute(`aM${k}`, new THREE.Float32BufferAttribute(mor[k], 3));
  out.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return out;
}

function parse(kind: BodyKind, scene: THREE.Object3D): PersonAsset | null {
  scene.updateMatrixWorld(true);
  const notes: string[] = [];
  const sets: THREE.SkinnedMesh[][] = [[], [], []];
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const name = m.name.startsWith('LOD') ? m.name : m.parent?.name ?? '';
    for (let i = 0; i < 3; i++) if (name.startsWith(`LOD${i}`)) sets[i].push(m);
  });
  if (!sets[0].length) return null;
  const joints = new Float32Array(BONES.length * 3);
  const sk = sets[0][0].skeleton;
  for (let i = 0; i < BONES.length; i++) {
    const b = sk.bones.find((x) => x.name === BONES[i]);
    if (!b) return null;
    _v.setFromMatrixPosition(b.matrixWorld);
    joints[i * 3] = _v.x; joints[i * 3 + 1] = _v.y; joints[i * 3 + 2] = _v.z;
  }
  const near = build(sets[0], notes);
  if (!near) return null;
  const lods = [near];
  for (let i = 1; i < 3; i++) { const g = sets[i].length ? build(sets[i], notes) : null; if (g) lods.push(g); }
  // Axes, checked: feet on the ground, head up, left hand at +X, toes toward +Z.
  near.computeBoundingBox();
  const box = near.boundingBox as THREE.Box3;
  const J = (n: (typeof BONES)[number], a: number): number => joints[BONES.indexOf(n) * 3 + a];
  if (Math.abs(box.min.y) > 0.02 || box.max.y < 1.5 || box.max.y > 2) notes.push(`stands from ${box.min.y.toFixed(2)} to ${box.max.y.toFixed(2)}`);
  if (J('hand_l', 0) <= 0 || J('head', 1) < J('hips', 1)) notes.push('left is not +X or up is not +Y');
  if (box.max.z < -box.min.z) notes.push('faces -Z');
  return { kind, lods, joints, notes };
}

/**
 * Both bodies, or null if either file is missing or wrong: the caller keeps its
 * box people. Never throws and never logs an error. A 404 the browser logs by
 * itself; these files are part of the build, so that only happens if one is deleted.
 */
export async function loadPeople(): Promise<PersonAsset[] | null> {
  const loader = new GLTFLoader();
  const out: PersonAsset[] = [];
  for (const kind of BODY_KINDS) {
    try {
      const res = await fetch(`models/person_${kind}.glb`);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      // "glTF". The dev server answers a missing file with the index page.
      if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;
      const gltf = await loader.parseAsync(buf, '');
      const a = parse(kind, gltf.scene);
      if (!a) return null;
      if (a.notes.length) console.warn(`person_${kind}.glb:`, [...new Set(a.notes)].join('; '));
      out.push(a);
    } catch {
      return null;
    }
  }
  return out;
}
