// The riverfront and The Holding Pattern as Blender models (tools/blender/buildings.py `-- --river`; its header is the contract).
//
//   Lackwool Mill (after the Lockwood mill): the five-storey main wing beside the river, six 31.5 m sections and two gable
//     ends, the four-storey wing toward Water St, the stair tower with its belfry, the boiler house and the round stack.
//   The Exact Change Footbridge (after the Two Cent Bridge): lattice towers on stone piers, cables, hangers, stays and the
//     lattice stiffening trusses that are its railings. ground.ts keeps the plank deck and the collision.
//   Threadbare Falls: white water over the dam, drawn here with its own shader (the pond and the river are ground.ts's).
//   The Holding Pattern: lamp standards and dumpsters, placed by Lower Main's builder through lamp() and dumpster().
//
// As Main St: fetched only once the mainland is wanted; high and medium get riverfront.glb (three levels of detail and
// the occlusion atlas, the brick maps shared with Main St), phones riverfront_far.glb alone. `?river=0` keeps the old
// code-built mill, footbridge superstructure and back lots (mainlandBuildings.ts, mainlandPlaces.ts, ground.ts ask RIVER_ON).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS, WATER_Y } from './plan';
import { DAM_Z, FOOTBRIDGE, FOOTBRIDGE_Z, MAIN_Y, POND_Y, RIVER_HW, riverX } from './mainland';
import { brickUV, buildingMaterial, loadTexture } from './mainStreetAssets';

export const RIVER_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('river') !== '0';

/** Lackwool Mill on the ground (world meters). The main wing's street front is the plane x = X0, its sections run south from Z0. */
export const LACKWOOL = {
  X0: 214, D: 25, Z0: -1556, SEC: 31.5, N: 6, RIDGE: 24.6,
  /** The wing toward Water St: north front on Z0, from the main wing west. */
  ell: { x0: 214 - 18.9, x1: 214, z0: -1556, z1: -1536, ridge: 20.4 },
  /** The stair tower, standing 6 m proud of the street front. */
  tower: { x0: 208, x1: 214.6, z0: -1465.7, z1: -1457.3, top: 37.3 },
  boiler: { x0: 196, x1: 207, z0: -1530, z1: -1514.25, ridge: 10.6 },
  stack: { x: 201.5, z: -1506, r: 2.7, top: 46.1 },
};
const NEAR = { mill: [42, 170], fb: [110, 380], stack: [80, 260] };

interface Placement { name: string; m: THREE.Matrix4; near: number[] }

const NIGHT = { value: 0 };
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
/** A frame whose model x runs along t and model z out along n (t x up = n). */
const frame = (ox: number, oy: number, oz: number, t: THREE.Vector3, n: THREE.Vector3): THREE.Matrix4 =>
  new THREE.Matrix4().makeBasis(t, V(0, 1, 0), n).setPosition(ox, oy, oz);

export class Riverfront {
  readonly group = new THREE.Group();
  private placed: Placement[] = [];
  private lamps: THREE.Matrix4[] = [];
  private dumps: THREE.Matrix4[] = [];
  private casters: THREE.BufferGeometry[] = [];
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private low: boolean;
  private mats: THREE.MeshStandardMaterial[] = [];
  private water: THREE.MeshLambertMaterial[] = [];
  private shown = true;
  private cam = new THREE.Vector3();
  private time = { value: 0 };

  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.group.name = 'riverfront-models';
    parent.add(this.group);
  }

  /** Lackwool Mill, its foot at height y. */
  mill(y: number): void {
    const L = LACKWOOL, S = V(0, 0, 1), W = V(-1, 0, 0), N = V(0, 0, -1), E = V(1, 0, 0);
    for (let i = 0; i < L.N; i++) this.put('lw_sec', frame(L.X0, y, L.Z0 + i * L.SEC, S, W), NEAR.mill);
    this.put('lw_end', frame(L.X0 + L.D, y, L.Z0, W, N), NEAR.mill);
    this.put('lw_end', frame(L.X0, y, L.Z0 + L.N * L.SEC, E, S), NEAR.mill);
    this.put('lw_ell', frame(L.ell.x1, y, L.ell.z0, W, N), NEAR.mill);
    this.put('lw_tower', frame(L.tower.x0, y, L.tower.z0, S, W), NEAR.mill);
    this.put('lw_boiler', frame(L.boiler.x0, y, L.boiler.z0, S, W), NEAR.mill);
    this.put('lw_stack', new THREE.Matrix4().makeTranslation(L.stack.x, y, L.stack.z), NEAR.stack);
    const box = (x0: number, x1: number, z0: number, z1: number, h: number): void => {
      this.casters.push(new THREE.BoxGeometry(x1 - x0, h, z1 - z0).translate((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2).deleteAttribute('uv').deleteAttribute('normal'));
    };
    box(L.X0, L.X0 + L.D, L.Z0, L.Z0 + L.N * L.SEC, L.RIDGE - 0.8);
    box(L.ell.x0, L.ell.x1, L.ell.z0, L.ell.z1, L.ell.ridge - 0.8);
    box(L.tower.x0, L.tower.x1, L.tower.z0, L.tower.z1, L.tower.top + 3);
    box(L.boiler.x0, L.boiler.x1, L.boiler.z0, L.boiler.z1, L.boiler.ridge - 0.8);
    box(L.stack.x - 1.7, L.stack.x + 1.7, L.stack.z - 1.7, L.stack.z + 1.7, L.stack.top);
  }

  /** The footbridge's superstructure, from the deck's west end at deck level. */
  footbridge(): void { this.put('fb', new THREE.Matrix4().makeTranslation(FOOTBRIDGE.x0, MAIN_Y, FOOTBRIDGE_Z), NEAR.fb); }

  /** The Holding Pattern's lamp standard (arms along x before turning by `rot`) and dumpster (front toward +z). */
  lamp(x: number, y: number, z: number, rot: number): void { this.lamps.push(new THREE.Matrix4().makeRotationY(rot).setPosition(x, y, z)); }
  dumpster(x: number, y: number, z: number, rot: number): void { this.dumps.push(new THREE.Matrix4().makeRotationY(rot).setPosition(x, y, z)); }

  private put(name: string, m: THREE.Matrix4, near: number[]): void { this.placed.push({ name, m, near }); }

  update(): void {
    if (!this.placed.length) return;
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const see = cam.z < -975 + this.game.quality.drawDist + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    if (see) this.time.value = performance.now() / 1000 % 1000;
    const env = this.env();
    if (this.mats.length && this.mats[0].envMap !== env) {
      for (const m of this.mats) { m.envMap = env; m.envMapIntensity = 0.9; m.needsUpdate = true; }
    }
  }

  setNight(n: number): void { NIGHT.value = n; }

  private async load(): Promise<void> {
    this.falls();
    const file = this.low ? 'models/riverfront_far.glb' : 'models/riverfront.glb';
    const [buf, bc, bn, ao] = await Promise.all([
      assets.bytes(file),
      this.low ? null : loadTexture('models/mainst_bc.webp', true, false),
      this.low ? null : loadTexture('models/mainst_bn.webp', true, false),
      // A phone at medium (quality.lean) skips the baked occlusion: 0.8 MB for shading a small screen hardly shows.
      this.low || this.game.quality.lean ? null : loadTexture('models/riverfront_o.webp', false, false),
    ]);
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) { this.state = 'done'; return; }
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry;
      if (o.name.endsWith('_0') && g.getAttribute('uv')) { g.setAttribute('uv1', g.getAttribute('uv')); g.deleteAttribute('uv'); }
      brickUV(g);
      g.computeBoundingSphere();
      geo.set(o.name, g);
    });
    const maps = { bc, bn, ao };
    const mat = [0, 1, 2].map((l) => { const m = buildingMaterial(l, maps, NIGHT, 'river'); this.mats.push(m); return m; });
    for (const p of this.placed) {
      const lod = new THREE.LOD();
      lod.matrixAutoUpdate = false; lod.matrix.copy(p.m); lod.matrixWorldNeedsUpdate = true;
      for (const level of this.low ? [2] : [0, 1, 2]) {
        const g = geo.get(`${p.name}_${level}`);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, mat[level]);
        mesh.castShadow = p.name === 'fb' && level < 2; mesh.receiveShadow = true;
        lod.addLevel(mesh, this.low || level === 0 ? 0 : p.near[level - 1]);
      }
      this.group.add(lod);
    }
    // The lot's kit: one instanced mesh each, drawn only within 260 m of the camera.
    for (const [name, list] of [['hp_lamp', this.lamps], ['hp_dump', this.dumps]] as [string, THREE.Matrix4[]][]) {
      const g = geo.get(name);
      if (!g || !list.length) continue;
      const im = new THREE.InstancedMesh(g, mat[2], list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
      im.castShadow = name === 'hp_lamp'; im.receiveShadow = true; im.name = name;
      this.group.add(im);
    }
    const merged = this.casters.length ? mergeGeometries(this.casters) : null;
    if (merged) {
      const caster = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      caster.castShadow = true; caster.name = 'riverfront-shadow';
      this.group.add(caster);
    }
    this.state = 'done';
  }

  // ── Threadbare Falls ───────────────────────────────────────────────────────
  // The sheet leaves the crest, curls over and comes down through the line of ground.ts's own crest water (kept just
  // above it everywhere, so it covers it); below the foot a field of standing waves and boils, white near the dam and
  // thinning downstream; a veil of spray along the foot. Foam is noise scrolled downstream, weighted per vertex.

  private falls(): void {
    const cx = riverX(DAM_Z), HW = RIVER_HW + 1.5;
    // (z downstream from the dam's centre line, height, foam weight): kept above ground.ts's crest line, which runs
    // straight from (DAM_Z + 1.6, POND_Y - 0.04) to (DAM_Z + 7, WATER_Y + 0.07).
    const prof: [number, number, number][] = [[-2.6, POND_Y + 0.05, 0.1], [-1.4, POND_Y + 0.06, 0.18], [0.4, POND_Y + 0.05, 0.3], [1.3, POND_Y + 0.02, 0.45],
      [2.0, POND_Y - 0.03, 0.62], [2.6, 0.24, 0.8], [3.2, 0.1, 0.92], [3.8, -0.04, 1], [4.6, -0.16, 1], [5.6, -0.3, 1], [6.6, -0.45, 1], [7.4, WATER_Y + 0.26, 1]];
    const sheet = this.grid(76, prof.length, (i, j) => {
      const x = -HW + (2 * HW) * i / 76, [z, y, w] = prof[j];
      let s = 0;
      for (let k = 1; k <= j; k++) s += Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]);
      const edge = THREE.MathUtils.smoothstep(HW - Math.abs(x), 0, 3);
      return [x, y + 0.04 * Math.sin(x * 0.7) * (j > 3 ? 1 : 0), z, x / 4, s * 1.4, w * (0.6 + 0.4 * edge)];
    });
    const ZC0 = 7.4, ZC1 = 40;
    const churn = this.grid(76, 40, (i, j) => {
      const x = -HW + (2 * HW) * i / 76, t = j / 40, z = ZC0 + (ZC1 - ZC0) * t * t;
      const near = Math.exp(-(z - ZC0) / 15), edge = THREE.MathUtils.smoothstep(HW - Math.abs(x), 0, 5);
      const bump = 0.22 * near * (0.5 + 0.5 * Math.sin(x * 1.1 + z * 0.8) * Math.cos(x * 0.37 - z * 1.3)) + 0.05 * Math.max(0, Math.sin(z * 2.1 + x * 0.3));
      const streak = 0.5 + 0.5 * Math.sin(x * 0.55 + 1.7 * Math.sin(z * 0.11));
      const w = Math.min(1, (near * 1.3 + 0.45 * streak * Math.exp(-(z - ZC0) / 26))) * edge;
      return [x, WATER_Y + 0.26 - 0.18 * (1 - near) + bump * edge, z, x / 4, 16 + (z - ZC0) * 1.1, w];
    });
    const mist = this.grid(38, 6, (i, j) => {
      const x = -HW + 2 * HW * i / 38, y = WATER_Y + 0.1 + j * 0.55;
      return [x, y, 6.2 + j * 0.5 + 0.4 * Math.sin(x * 0.4), x / 3, y, Math.max(0, 1 - j / 5) * THREE.MathUtils.smoothstep(HW - Math.abs(x), 0, 6)];
    });
    const parts: [THREE.BufferGeometry, number, number][] = [[sheet, 2.2, 0.42], [churn, 1.1, 0.0], [mist, 0.6, 0]];
    for (const [g, speed, alpha] of parts) {
      const m = this.waterMat(speed, alpha, g === mist);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(cx, 0, DAM_Z); mesh.renderOrder = 3; mesh.name = 'falls';
      mesh.frustumCulled = true;
      this.group.add(mesh);
    }
  }

  /** A grid of (cols + 1) x rows vertices from f(i, j) = [x, y, z, u, v, foam]. */
  private grid(cols: number, rows: number, f: (i: number, j: number) => number[]): THREE.BufferGeometry {
    const n = (cols + 1) * rows, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), w = new Float32Array(n), idx: number[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i, p = f(i, j);
      pos.set(p.slice(0, 3), k * 3); uv.set(p.slice(3, 5), k * 2); w[k] = p[5];
      if (i < cols && j < rows - 1) { const a = k, b = k + 1, c = k + cols + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('fuv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('fw', new THREE.BufferAttribute(w, 1));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    return g;
  }

  private waterMat(speed: number, alpha: number, mist: boolean): THREE.MeshLambertMaterial {
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: mist ? THREE.DoubleSide : THREE.FrontSide });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 fuv; attribute float fw; varying vec2 vF; varying float vW; uniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vF = fuv; vW = fw;
        ${mist ? '' : 'transformed.y += fw * 0.05 * sin( uTime * 3.1 + fuv.x * 5.0 + fuv.y * 3.0 ) * sin( uTime * 1.7 - fuv.x * 2.3 );'}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec2 vF; varying float vW; uniform float uTime;
        float fh1( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        float fn1( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( fh1( i ), fh1( i + vec2( 1.0, 0.0 ) ), f.x ), mix( fh1( i + vec2( 0.0, 1.0 ) ), fh1( i + vec2( 1.0, 1.0 ) ), f.x ), f.y ); }
        float fbm3( vec2 p ) { return 0.5 * fn1( p ) + 0.3 * fn1( p * 2.13 + 7.1 ) + 0.2 * fn1( p * 4.7 - 3.3 ); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        float fFoam;
        {
          ${mist
    ? `float n = fn1( vec2( vF.x * 1.3, vF.y * 1.6 - uTime * ${speed.toFixed(2)} ) );
          fFoam = 1.0; diffuseColor.rgb = vec3( 0.92, 0.94, 0.95 ); diffuseColor.a = vW * smoothstep( 0.35, 0.8, n ) * 0.32;`
    : `float n = fbm3( vec2( vF.x * 1.5, vF.y * 1.1 - uTime * ${speed.toFixed(2)} ) );
          float n2 = fn1( vec2( vF.x * 4.6 + 2.0, vF.y * 3.2 - uTime * ${(speed * 1.6).toFixed(2)} ) );
          fFoam = smoothstep( 0.18, 0.6, vW * ( 0.5 + 0.7 * n ) + 0.25 * ( n2 - 0.5 ) );
          vec3 water = vec3( 0.16, 0.24, 0.22 );
          diffuseColor.rgb = mix( water, vec3( 0.9, 0.93, 0.94 ), fFoam );
          diffuseColor.a = mix( ${alpha.toFixed(2)}, 0.96, fFoam ) * smoothstep( 0.01, 0.3, vW );`}
        }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * fFoam * 0.06;');
    };
    m.customProgramCacheKey = () => 'falls' + (mist ? 'm' : '') + speed;
    this.water.push(m);
    return m;
  }
}
