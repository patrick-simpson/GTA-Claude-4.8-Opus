// Tepid Falls' neighbourhood houses as Blender models (tools/blender/houses.py; its header is the contract): the South End and
// North End triple-deckers, capes, gable-fronts, Victorians with turrets, corner stores, detached garages and sheds, plus parked
// cars and mailboxes. mainlandBuildings.ts decides which goes on which lot, at which angle and how far back (hood()).
//
// How it is drawn: every design is an InstancedMesh per level of detail (and per hand: the mirror image is its own mesh, since
// an instance cannot take a negative scale). Which instance is in which level is worked out again only when the camera has moved
// 10 m or turned 15 degrees, never per frame: level 0 inside 55 m, level 1 inside 170 m, level 2 out to the draw distance, and
// nothing behind the camera past 25 m. High and medium load houses.glb; the low preset and phones (`lean`) load houses_far.glb
// and draw level 2 alone. Clapboard comes from clap_bc / clap_bn laid over the faces whose vertex alpha is 1; windows (alpha
// 0.55 to 0.65) light at night. Collision is axis-aligned only, so a house set at an angle gets strips along its depth, each the
// bounds of its own slice (as civicAssets.ts), and a house square to the streets one exact box. Christmas finds its eaves from
// those boxes. `?houses=0` keeps the code-built houses.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Game } from '../core/game';
import { obbSlices } from './obbSlices';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS } from './plan';
import { loadTexture } from './mainStreetAssets';

export const HOUSES_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('houses') !== '0';

export type Kind = 'td' | 'cape' | 'gf' | 'vic' | 'store' | 'garage' | 'shed';
export interface HouseDesign { kind: Kind; w: number; D: number; top: number; door: number; front: number; set: number; minSet: number }
/** In step with the META printed by houses.py. `set` is the wall's usual setback from the front of the lot, `minSet` the least it may be; `front` how far the porch or portico stands out. */
export const DESIGN: Record<string, HouseDesign> = {
  td_a: { kind: 'td', w: 8.4, D: 13.4, top: 10.02, door: 1.3, front: 2.3, set: 4.0, minSet: 3.4 },
  td_b: { kind: 'td', w: 8.4, D: 13.4, top: 12.0, door: 1.3, front: 2.3, set: 4.0, minSet: 3.4 },
  td_c: { kind: 'td', w: 9.2, D: 13.4, top: 10.02, door: 4.5, front: 2.3, set: 4.2, minSet: 3.4 },
  td_d: { kind: 'td', w: 8.4, D: 13.4, top: 10.02, door: 1.3, front: 2.3, set: 3.8, minSet: 3.4 },
  cape_a: { kind: 'cape', w: 10.2, D: 8.4, top: 7.54, door: 4.7, front: 1.2, set: 7.5, minSet: 5 },
  cape_b: { kind: 'cape', w: 10.2, D: 8.4, top: 7.54, door: 5.1, front: 1.2, set: 7.5, minSet: 5 },
  cape_c: { kind: 'cape', w: 10.2, D: 8.4, top: 7.54, door: 4.7, front: 1.2, set: 7.0, minSet: 5 },
  gf_a: { kind: 'gf', w: 7.4, D: 11, top: 8.44, door: 1.1, front: 1.9, set: 5.5, minSet: 4 },
  gf_b: { kind: 'gf', w: 7.4, D: 11, top: 8.44, door: 6.3, front: 1.9, set: 5.5, minSet: 4 },
  gf_c: { kind: 'gf', w: 7.4, D: 11, top: 8.44, door: 1.1, front: 1.9, set: 5.0, minSet: 4 },
  vic_a: { kind: 'vic', w: 11.2, D: 11, top: 11.85, door: 6.5, front: 2.0, set: 6.2, minSet: 4.5 },
  vic_b: { kind: 'vic', w: 11.2, D: 11, top: 11.85, door: 6.5, front: 2.0, set: 6.2, minSet: 4.5 },
  store_a: { kind: 'store', w: 9.2, D: 13, top: 7.95, door: 7.95, front: 1.1, set: 1.2, minSet: 0.9 },
  garage_a: { kind: 'garage', w: 3.8, D: 6.2, top: 3.85, door: 1.9, front: 0, set: 0, minSet: 0 },
  garage_b: { kind: 'garage', w: 3.8, D: 6.2, top: 3.85, door: 1.9, front: 0, set: 0, minSet: 0 },
  shed_a: { kind: 'shed', w: 2.7, D: 2.3, top: 2.5, door: 1.35, front: 0, set: 0, minSet: 0 },
};
export const BY_KIND: Record<Kind, string[]> = { td: ['td_a', 'td_b', 'td_c', 'td_d'], cape: ['cape_a', 'cape_b', 'cape_c'], gf: ['gf_a', 'gf_b', 'gf_c'], vic: ['vic_a', 'vic_b'], store: ['store_a'], garage: ['garage_a', 'garage_b'], shed: ['shed_a'] };
const HANDED = new Set(Object.keys(DESIGN).filter((n) => !n.startsWith('garage') && !n.startsWith('shed')));
const CARS = ['car0', 'car1', 'car2'];
const TILE = 1.12;
const NEAR0 = 55, NEAR1 = 170;

const NIGHT = { value: 0 };
const UP = new THREE.Vector3(0, 1, 0);

interface Group { key: string; mats: number[]; pos: number[]; col: number[]; car: boolean; meshes: (THREE.InstancedMesh | null)[] }

/** Clapboard coordinates in meters on siding faces (alpha 1); a still point everywhere else. */
function houseUV(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    let u: number, v: number;
    const nx = n.getX(i), nz = n.getZ(i), hl = Math.hypot(nx, nz) || 1;
    u = (p.getX(i) * (-nz / hl) + p.getZ(i) * (nx / hl)) / TILE; v = p.getY(i) / TILE;
    if (!c || c.getW(i) < 0.995) { u = 0.5 + u * 1e-4; v = 0.3 + v * 1e-4; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** The buildings' material (vertex colour, windows lit at night from the alpha), with the siding maps laid only over alpha-1 faces. */
function houseMaterial(level: number, bc: THREE.Texture | null, bn: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  if (level < 2 && bc && bn) { m.map = bc; m.normalMap = bn; m.normalScale.set(0.9, 0.9); }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = NIGHT;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <map_fragment>', `
      #ifdef USE_MAP
      {
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        #ifdef USE_COLOR_ALPHA
        if ( vColor.a < 0.995 ) sampledDiffuseColor = vec4( 1.0 );
        #endif
        diffuseColor *= sampledDiffuseColor;
      }
      #endif`)
      .replace('#include <normal_fragment_maps>', `
      #ifdef USE_NORMALMAP_TANGENTSPACE
      {
        vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
        #ifdef USE_COLOR_ALPHA
        mapN.xy *= ( vColor.a > 0.995 ) ? normalScale : vec2( 0.0 );
        #else
        mapN.xy *= normalScale;
        #endif
        normal = normalize( tbn * mapN );
      }
      #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR_ALPHA
      {
        float a = vColor.a;
        float lit = ( a > 0.01 && a < 0.99 ) ? smoothstep( 0.42, 0.5, a ) : 0.0;
        totalEmissiveRadiance += uNight * lit * vec3( 1.0, 0.72, 0.42 ) * ( 0.35 + diffuseColor.rgb * 2.5 );
      }
      #endif`);
  };
  m.customProgramCacheKey = () => 'houses' + level;
  return m;
}

export class Houses {
  readonly group = new THREE.Group();
  private groups = new Map<string, Group>();
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private low: boolean;
  private lean: boolean;
  private shown = true;
  private cam = new THREE.Vector3();
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastFwd = new THREE.Vector3(0, 0, -1);
  private fwd = new THREE.Vector3();
  private mats: THREE.MeshStandardMaterial[] = [];
  private count = 0;
  /** Number of instances placed and, after the last regroup, drawn per level (for the benches). */
  stats = { placed: 0, l0: 0, l1: 0, l2: 0 };

  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.lean = !!game.quality.lean;
    this.group.name = 'house-models';
    parent.add(this.group);
  }

  private grp(key: string, car: boolean): Group {
    let g = this.groups.get(key);
    if (!g) { g = { key, mats: [], pos: [], col: [], car, meshes: [null, null, null] }; this.groups.set(key, g); }
    return g;
  }

  /**
   * A house of `name` (a DESIGN key) or a car/mailbox: front-left corner (x, y, z), its front running along t and facing n
   * (horizontal unit vectors, t x up = n). `mir` picks the mirror image. Adds the collision unless `solid` is false.
   */
  place(name: string, mir: boolean, x: number, y: number, z: number, tx: number, tz: number, nx: number, nz: number, solid = true, tint = 0xffffff): void {
    const d = DESIGN[name];
    const key = mir && HANDED.has(name) ? name.replace(/^([a-z]+_[a-z])/, '$1m') : name;
    const car = CARS.includes(name);
    const g = this.grp(key, car || name === 'mailbox');
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(tx, 0, tz), UP, new THREE.Vector3(nx, 0, nz)).setPosition(x, y, z);
    g.mats.push(...m.elements);
    const w = d ? d.w : 1, D = d ? d.D : 1, mid = new THREE.Vector3(w / 2, 0, -D / 2).applyMatrix4(m);
    g.pos.push(mid.x, mid.z);
    const c = new THREE.Color(tint);
    g.col.push(c.r, c.g, c.b);
    this.stats.placed++;
    if (d && solid) this.box(m, 0, d.w, -d.D, 0, d.top, y, tx, tz);
  }

  /** A box in a model's frame, as one axis box or as strips along its depth when the model is set at an angle. */
  private box(m: THREE.Matrix4, x0: number, x1: number, z0: number, z1: number, top: number, y: number, tx: number, tz: number): void {
    const col = this.game.col, p = new THREE.Vector3(), q = new THREE.Vector3();
    p.set(x0, 0, z0).applyMatrix4(m); q.set(x1, 0, z1).applyMatrix4(m);
    if (Math.abs(tx) > 0.01 && Math.abs(tz) > 0.01) {
      const cs: number[] = [];
      for (const [u, w] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) { p.set(u, 0, w).applyMatrix4(m); cs.push(p.x, p.z); }
      obbSlices(cs, (ax, az, bx, bz) => col.addBox(ax, az, bx, bz, y + top, y - 1));
      return;
    }
    col.addBox(Math.min(p.x, q.x), Math.min(p.z, q.z), Math.max(p.x, q.x), Math.max(p.z, q.z), y + top, y - 1);
  }

  update(): void {
    if (!this.stats.placed) return;
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const see = cam.z < -975 + this.game.quality.drawDist + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    if (this.state !== 'done' || !see) return;
    const env = this.env();
    if (this.mats.length && this.mats[0].envMap !== env) for (const m of this.mats) { m.envMap = env; m.envMapIntensity = 0.7; m.needsUpdate = true; }
    this.game.camera.getWorldDirection(this.fwd);
    if (cam.distanceToSquared(this.lastPos) < 100 && this.fwd.dot(this.lastFwd) > 0.966) return;
    this.lastPos.copy(cam); this.lastFwd.copy(this.fwd);
    this.regroup(cam);
  }

  setNight(n: number): void { NIGHT.value = n; }

  /** Put every instance in the level its distance asks for. Runs when the camera has moved or turned enough, not per frame. */
  private regroup(cam: THREE.Vector3): void {
    const far = this.game.quality.drawDist + 20, far2 = far * far, n0 = NEAR0 * NEAR0, n1 = NEAR1 * NEAR1;
    const flat = this.low || this.lean, fx = this.fwd.x, fz = this.fwd.z, fl = Math.hypot(fx, fz) || 1;
    const tot = [0, 0, 0];
    for (const g of this.groups.values()) {
      const n = g.pos.length / 2, cnt = [0, 0, 0];
      const meshes = g.meshes, carNear = g.car ? 90 * 90 : 1e12;
      for (let i = 0; i < n; i++) {
        const dx = g.pos[2 * i] - cam.x, dz = g.pos[2 * i + 1] - cam.z, d2 = dx * dx + dz * dz;
        if (d2 > far2) continue;
        if (g.car && d2 > carNear) continue;
        if (d2 > 625 && (dx * fx + dz * fz) / fl < -0.2 * Math.sqrt(d2)) continue;
        const lv = flat || g.key === 'mailbox' ? 2 : d2 < n0 ? 0 : d2 < n1 ? 1 : 2;
        const mesh = meshes[lv];
        if (!mesh) continue;
        const k = cnt[lv]++;
        const arr = mesh.instanceMatrix.array as Float32Array;
        for (let e = 0; e < 16; e++) arr[k * 16 + e] = g.mats[i * 16 + e];
        if (g.car && mesh.instanceColor) { const ca = mesh.instanceColor.array as Float32Array; ca[k * 3] = g.col[i * 3]; ca[k * 3 + 1] = g.col[i * 3 + 1]; ca[k * 3 + 2] = g.col[i * 3 + 2]; }
      }
      for (let lv = 0; lv < 3; lv++) {
        const mesh = meshes[lv];
        if (!mesh) continue;
        mesh.count = cnt[lv]; mesh.visible = cnt[lv] > 0; tot[lv] += cnt[lv];
        if (cnt[lv]) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
      }
    }
    this.stats.l0 = tot[0]; this.stats.l1 = tot[1]; this.stats.l2 = tot[2];
  }

  private async load(): Promise<void> {
    const flat = this.low || this.lean;
    const [buf, bc, bn] = await Promise.all([
      assets.bytes(flat ? 'models/houses_far.glb' : 'models/houses.glb'),
      flat ? null : loadTexture('models/clap_bc.webp', true, true),
      flat ? null : loadTexture('models/clap_bn.webp', true, false),
    ]);
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) { this.state = 'done'; return; }
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      houseUV(mesh.geometry);
      geo.set(o.name, mesh.geometry);
    });
    this.mats = [0, 1, 2].map((l) => houseMaterial(l, bc, bn));
    for (const g of this.groups.values()) {
      const n = g.pos.length / 2;
      for (let lv = 0; lv < 3; lv++) {
        if (flat && lv < 2) continue;
        if (g.key === 'mailbox' && lv !== 2) continue;
        const geom = geo.get(g.key === 'mailbox' ? 'mailbox' : `${g.key}_${lv}`);
        if (!geom) continue;
        const im = new THREE.InstancedMesh(geom, this.mats[lv], n);
        if (g.car) im.setColorAt(0, new THREE.Color(1, 1, 1));
        im.count = 0; im.visible = false; im.frustumCulled = false; im.name = `${g.key}_${lv}`;
        im.castShadow = !flat && lv < 2 && !g.car && g.key !== 'mailbox'; im.receiveShadow = true;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
        g.meshes[lv] = im;
      }
    }
    this.state = 'done';
    this.lastPos.set(1e9, 0, 0);
  }
}

/** The one Houses of the mainland (made by buildMainlandBuildings); null with `?houses=0`. */
export let houses: Houses | null = null;
export function makeHouses(game: Game, parent: THREE.Object3D, env: () => THREE.Texture | null): Houses | null {
  houses = HOUSES_ON ? new Houses(game, parent, env) : null;
  return houses;
}
