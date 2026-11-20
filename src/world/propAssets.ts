// Street furniture as a file, for close up.
//
// tools/blender/props.py writes public/models/props.glb (that file's header is the contract):
// the hydrant, bin, mailbox, bench, sign post, news box and street lamp with their bevels, bolts
// and flanges, ambient occlusion baked into the vertex colours and the finish (roughness,
// metalness) in the texture coordinate. ground.ts still builds every one of them in code and
// places them as before: those are the far level of detail, the phone's models, the shadow
// casters, and what is drawn until this file arrives. PropField draws the modelled ones over
// the top for whatever stands within NEAR meters of the camera, reading each instance's
// matrix from the mesh ground.ts owns, so a hydrant that has been knocked off or a lamp that
// has been laid down is the same in both. The two never overlap: each material throws its
// vertices off screen on its own side of NEAR, from the same distance.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { putChanged } from '../core/util';
import { flip, sendRange } from '../core/flip';
import { assets } from '../core/assets';

/** Inside this the modelled prop is drawn, outside it the one built in code. A hydrant is 14 pixels tall at this range. */
export const NEAR = 42;
/** The far material's uniform: (1, distance). The distance stays 0, cutting nothing, until the models are in. */
export const CUT_FAR = { value: new THREE.Vector2(1, 0) };
export const CUT_NEAR = { value: new THREE.Vector2(-1, NEAR) };

/** The vertex-shader lines that make a prop material draw only its side of the cut. */
export const CUT_VERTEX = `
  #ifdef USE_INSTANCING
    {
      vec4 foot = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
      if ( ( distance( foot.xz, cameraPosition.xz ) - uCut.y ) * uCut.x < 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    }
  #endif`;

export const PROPS_FILE = 'models/props.glb';

/** The models by name, with the attributes ground.ts's prop material reads. Null if the file is missing or broken; never throws. */
export async function loadProps(): Promise<Map<string, THREE.BufferGeometry> | null> {
  try {
    const buf = await assets.bytes(PROPS_FILE);
    // "glTF". The dev server answers a missing file with the index page.
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const out = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.geometry, p = src.getAttribute('position'), n = src.getAttribute('normal'), c = src.getAttribute('color'), uv = src.getAttribute('uv');
      if (!p || !n || !c || !uv || !src.index) return;
      const col = new Float32Array(p.count * 3), pbr = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) {
        col[i * 3] = c.getX(i); col[i * 3 + 1] = c.getY(i); col[i * 3 + 2] = c.getZ(i);
        pbr[i * 2] = uv.getX(i); pbr[i * 2 + 1] = uv.getY(i);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', p); g.setAttribute('normal', n);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 2));
      g.setIndex(src.index);
      out.set(o.name, g);
    });
    return out.size ? out : null;
  } catch (e) {
    console.warn('models/props.glb did not load; keeping the simple street furniture', e);
    return null;
  }
}

interface Entry { mesh: THREE.InstancedMesh; src: THREE.InstancedMesh[]; at: THREE.Sphere[]; cap: number }
const _p = new THREE.Vector3();

export class PropField {
  private entries: Entry[] = [];
  private last = new THREE.Vector3(1e9, 0, 0);
  private seen = -1;

  /** `kinds`: a model and the instanced meshes (one per map region) that say where it stands. */
  constructor(parent: THREE.Object3D, mat: THREE.Material, kinds: { geo: THREE.BufferGeometry; src: readonly THREE.InstancedMesh[] }[]) {
    for (const k of kinds) {
      if (!k.src.length) continue;
      const cap = 96;
      const mesh = new THREE.InstancedMesh(k.geo, mat, cap);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      flip.mesh(mesh, true);
      // The model built in code is still in the shadow pass, so this one need not be.
      mesh.castShadow = false; mesh.receiveShadow = true;
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.count = 0; mesh.visible = false;
      parent.add(mesh);
      const at = k.src.map((s) => { s.computeBoundingSphere(); return s.boundingSphere!.clone(); });
      this.entries.push({ mesh, src: k.src.slice(), at, cap });
    }
    CUT_FAR.value.y = NEAR;
  }

  /** Refill when the camera has moved a couple of meters, or when anything was knocked over. */
  update(cam: THREE.Camera): void {
    cam.getWorldPosition(_p);
    let ver = 0;
    for (const e of this.entries) for (const s of e.src) ver += s.instanceMatrix.version;
    if (ver === this.seen && _p.distanceToSquared(this.last) < 4) return;
    this.seen = ver; this.last.copy(_p);
    const R2 = (NEAR + 2.5) ** 2;
    for (const e of this.entries) {
      const out = e.mesh.instanceMatrix.array as Float32Array, oc = e.mesh.instanceColor!.array as Float32Array;
      // Walking a block changes which benches are near for a kind or two, not for all of them: send only those.
      let n = 0, chM = false, chC = false;
      for (let b = 0; b < e.src.length && n < e.cap; b++) {
        const s = e.src[b], sp = e.at[b];
        if (!s.visible || Math.hypot(sp.center.x - _p.x, sp.center.z - _p.z) > sp.radius + NEAR + 3) continue;
        const m = s.instanceMatrix.array as Float32Array, c = s.instanceColor ? (s.instanceColor.array as Float32Array) : null;
        for (let i = 0; i < s.count && n < e.cap; i++) {
          const o = i * 16, dx = m[o + 12] - _p.x, dz = m[o + 14] - _p.z;
          // A broken prop is scaled to nothing.
          if (dx * dx + dz * dz > R2 || (m[o] === 0 && m[o + 5] === 0 && m[o + 10] === 0)) continue;
          if (putChanged(out, n * 16, m, o, 16)) chM = true;
          if (c) { if (putChanged(oc, n * 3, c, i * 3, 3)) chC = true; }
          else if (oc[n * 3] !== 1 || oc[n * 3 + 1] !== 1 || oc[n * 3 + 2] !== 1) { oc[n * 3] = oc[n * 3 + 1] = oc[n * 3 + 2] = 1; chC = true; }
          n++;
        }
      }
      e.mesh.count = n; e.mesh.visible = n > 0;
      if (n && chM) sendRange(e.mesh.instanceMatrix, n * 16);
      if (n && chC) sendRange(e.mesh.instanceColor!, n * 3);
    }
  }
}
