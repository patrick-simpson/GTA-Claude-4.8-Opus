// Tepid Falls' churches and civic buildings as Blender models (tools/blender/buildings.py `-- --civic`; its header is the contract).
//
//   Postponement Hall (after the 1902 city hall and opera house) on the north side of Quorum Square, across Bobbin St: red
//     brick and limestone, a pedimented pavilion, a cupola with four working clock faces and a copper dome.
//   The Dead Letter Office (after the 1911 federal post office) facing the square from the west: granite, a loggia of six
//     columns between end pavilions, broad steps.
//   Our Lady of Perpetual Hesitation (twin-towered brick and granite) on the same block, facing Quorum St.
//   First Church of the Lukewarm (white clapboard, clock stage and spire) and St. Dither's (grey stone Gothic, battlemented
//     corner tower) on the lots The Stacks' builder picks for them (mainlandBuildings.ts).
//   The square's kit: globe lamp posts, benches, the war memorial and the soldier's monument (mainlandPlaces.ts places them).
//
// As Main St and the riverfront: fetched only once the mainland is wanted; high and medium get civic.glb (three levels of
// detail, the occlusion atlas, the brick maps shared with Main St), phones civic_far.glb alone. Stained glass (vertex alpha
// 0.35) glows in its own colour at night; the clock hands are drawn here and follow the game's clock. Collision and the
// shadow casters come from the boxes below, so they exist before the models arrive. `?civic=0` keeps the old code-built hall,
// churches and square furniture.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS, type Rect } from './plan';
import { STREETS_NEW } from './streets';
import { brickUV, buildingMaterial, loadTexture } from './mainStreetAssets';

export const CIVIC_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('civic') !== '0';

/** Where the fixed civic buildings stand (world meters; the model's front-left corner and its frontage). */
// New streets (tepid-streets unit 4): the hall north of Quorum Square, now east of Main St at Bobbin St (real City Hall and
// Castonguay Square at Main x Common St); the post office at the north end of downtown between Tuition Ave and Front St (the
// real federal building), facing west; Our Lady beside Gumdrop St, facing it, set square to it.
export const CIVIC = {
  /** Postponement Hall: front wall on z = -1518 facing south over the square, x 0..40, 24 m deep. */
  hall: STREETS_NEW ? { x0: 111, z: -1839.5, W: 40, D: 24 } : { x0: 0, z: -1518, W: 40, D: 24 },
  /** The Dead Letter Office: front wall on x = -49 facing east toward the square, z -1414..-1444, 22 m deep (new: on x = 203 facing west, z -2247..-2217). */
  dlo: STREETS_NEW ? { x: 203, z0: -2247, W: 30, D: 22 } : { x: -49, z0: -1414, W: 30, D: 22 },
  /** Our Lady of Perpetual Hesitation: front on z = -1412 facing south onto Quorum St, x -110..-88, 34 m deep. */
  lady: { x0: -110, z: -1412, W: 22, D: 34 },
  /**
   * New streets: Our Lady's front-left corner, frontage direction t and front normal n. She stands on open ground north of the
   * Tin Plate St / Gumdrop St junction facing Gumdrop St 14 m ahead (her old place, 14 m off Tarnish St, had those two streets
   * running through her nave: roadqa found it by driving; the spot was searched for clear of every road, building and the river).
   */
  ladyNew: { x: -140.8, z: -1243, tx: 0.5, tz: -0.866, nx: 0.866, nz: 0.5 },
  /** The lots given over to Our Lady and the post office: Lower Main's builder leaves them alone. */
  block: (STREETS_NEW ? { x0: 1e6, z0: 1e6, x1: 1e6 + 1, z1: 1e6 + 1 } : { x0: -120, z0: -1449, x1: -43, z1: -1409 }) as Rect,
  /** The churches on The Stacks' lots: frontage and depth each needs, and its setback from the street. */
  chw: { W: 13, D: 20, SB: 4.4 },
  chs: { W: 11, D: 22, SB: 3.0 },
};

/** Boxes in each model's own frame (x0, x1, z0, z1, top): collision, and the shadow the model casts. */
const BOXES: Record<string, number[][]> = {
  ph: [[0, 40, -24, 0, 20.4], [14, 26, 0, 1.5, 18.4], [16.8, 23.2, -15.2, -8.8, 36]],
  dlo: [[0, 30, -22, 0.8, 11.3]],
  chw: [[0, 13, -20, 0, 11.5], [4, 9, -2, 3, 22], [5.4, 7.6, -0.6, 1.6, 38]],
  chb: [[0, 22, -34, 0, 17], [-0.6, 5.9, -5.6, 1, 30.5], [16.1, 22.6, -5.6, 1, 30.5], [0.6, 4.7, -4.4, -0.2, 42], [17.3, 21.4, -4.4, -0.2, 42]],
  chs: [[0, 11, -22, 0, 10], [-2.2, 3, -3.6, 1.6, 20.5]],
};
/** The clock dials (model frame): centre of the tower, half its width, height and radius of the dials. In step with CLOCKS in buildings.py. */
const CLOCKS: Record<string, { cx: number; cz: number; half: number; y: number; r: number }> = {
  ph: { cx: 20, cz: -12, half: 2.6, y: 25.3, r: 1.45 },
  chw: { cx: 6.5, cz: 0.5, half: 2.2, y: 12.4, r: 1.15 },
};
const NEAR: Record<string, number[]> = { ph: [60, 210], dlo: [45, 150], chw: [50, 190], chb: [60, 230], chs: [45, 160] };
const KIT = ['sq_lamp', 'sq_bench', 'sq_memorial', 'sq_monument'];

interface Placement { name: string; m: THREE.Matrix4 }
interface Dial { c: THREE.Vector3; n: THREE.Vector3; r: number }

const NIGHT = { value: 0 };
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/** The buildings' material with one more rule: stained glass (alpha 0.30-0.40) lights in its own colour at night. */
function civicMaterial(level: number, maps: { bc: THREE.Texture | null; bn: THREE.Texture | null; ao: THREE.Texture | null }): THREE.MeshStandardMaterial {
  // buildingMaterial's own hook is replaced, not wrapped: snowCover.ts already wraps whatever hook a material has, and
  // reading m.onBeforeCompile hands back that wrapper (the snow would then go in twice). The window rule is repeated here.
  const m = buildingMaterial(level, maps, NIGHT, 'civic');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = NIGHT;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR_ALPHA
      {
        float a = vColor.a;
        float lit = ( a > 0.01 && a < 0.99 ) ? smoothstep( 0.42, 0.5, a ) : 0.0;
        if ( a > 0.55 && a < 0.65 ) lit *= 0.22;      // clock dials (alpha 0.6): lit from behind, not a lamp
        totalEmissiveRadiance += uNight * lit * vec3( 1.0, 0.72, 0.42 ) * ( 0.35 + diffuseColor.rgb * 2.5 );
      }
      {
        float sa = vColor.a;
        float st = ( sa > 0.3 && sa < 0.4 ) ? 1.0 : 0.0;
        vec3 sc = vColor.rgb / max( max( vColor.r, vColor.g ), max( vColor.b, 0.02 ) );
        totalEmissiveRadiance += uNight * st * mix( vec3( 1.0, 0.78, 0.5 ), sc * sc, 0.65 ) * ( 0.75 + 0.5 * vColor.g );
      }
      #endif`);
  };
  return m;
}

export class Civic {
  readonly group = new THREE.Group();
  private placed: Placement[] = [];
  private props = new Map<string, THREE.Matrix4[]>();
  private casters: THREE.BufferGeometry[] = [];
  private dials: Dial[] = [];
  private hands: THREE.InstancedMesh | null = null;
  private handMin = -1;
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private low: boolean;
  private mats: THREE.MeshStandardMaterial[] = [];
  private shown = true;
  private cam = new THREE.Vector3();

  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.group.name = 'civic-models';
    parent.add(this.group);
  }

  /** A model whose front-left corner is (x, y, z), its front running along t and facing n (horizontal unit vectors, t x up = n). */
  place(name: string, x: number, y: number, z: number, tx: number, tz: number, nx: number, nz: number): void {
    const m = new THREE.Matrix4().makeBasis(V(tx, 0, tz), UP, V(nx, 0, nz)).setPosition(x, y, z);
    this.placed.push({ name, m });
    const col = this.game.col, p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const [x0, x1, z0, z1, top] of BOXES[name] ?? []) {
      p.set(x0, 0, z0).applyMatrix4(m); q.set(x1, 0, z1).applyMatrix4(m);
      if (Math.abs(tx) > 0.01 && Math.abs(tz) > 0.01) {
        // Set at an angle: the box as strips along its depth, each the bounds of its own slice (collide.ts has only axis boxes).
        const n = Math.max(2, Math.ceil(Math.max(x1 - x0, z1 - z0) / 4));
        for (let i = 0; i < n; i++) {
          const za = z0 + ((z1 - z0) * i) / n, zb = z0 + ((z1 - z0) * (i + 1)) / n;
          let ax = 1e9, az = 1e9, bx = -1e9, bz = -1e9;
          for (const [u, w] of [[x0, za], [x1, za], [x0, zb], [x1, zb]]) { p.set(u, 0, w).applyMatrix4(m); ax = Math.min(ax, p.x); az = Math.min(az, p.z); bx = Math.max(bx, p.x); bz = Math.max(bz, p.z); }
          const sh = Math.min(bx - ax, bz - az) * 0.18;
          col.addBox(ax + sh, az + sh, bx - sh, bz - sh, y + top, y - 1);
        }
        continue;
      }
      col.addBox(Math.min(p.x, q.x), Math.min(p.z, q.z), Math.max(p.x, q.x), Math.max(p.z, q.z), y + top, y - 1);
      this.casters.push(new THREE.BoxGeometry(x1 - x0, top - 0.6, z1 - z0).translate((x0 + x1) / 2, (top - 0.6) / 2, (z0 + z1) / 2)
        .applyMatrix4(m).deleteAttribute('uv').deleteAttribute('normal'));
    }
    const c = CLOCKS[name];
    if (c) {
      for (const [ax, az] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const lc = V(c.cx + ax * (c.half + 0.12), c.y, c.cz + az * (c.half + 0.12)).applyMatrix4(m);
        this.dials.push({ c: lc, n: V(ax, 0, az).transformDirection(m), r: c.r });
      }
    }
  }

  /** One of the square's kit (sq_lamp, sq_bench, sq_memorial, sq_monument), its front toward +z before turning by `rot`. */
  prop(name: string, x: number, y: number, z: number, rot: number): void {
    let list = this.props.get(name);
    if (!list) { list = []; this.props.set(name, list); }
    list.push(new THREE.Matrix4().makeRotationY(rot).setPosition(x, y, z));
  }

  update(): void {
    if (!this.placed.length) return;
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const see = cam.z < -975 + this.game.quality.drawDist + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    const env = this.env();
    if (this.mats.length && this.mats[0].envMap !== env) {
      for (const m of this.mats) { m.envMap = env; m.envMapIntensity = 0.9; m.needsUpdate = true; }
    }
    if (see && this.hands) this.tick();
  }

  setNight(n: number): void { NIGHT.value = n; }

  /** The hands: moved when the game's minute changes. */
  private tick(): void {
    const hour = this.game.sky.hour, min = Math.floor(hour * 60);
    if (min === this.handMin || !this.hands) return;
    this.handMin = min;
    const aM = (hour % 1) * Math.PI * 2, aH = ((hour % 12) / 12) * Math.PI * 2;
    const m = new THREE.Matrix4(), s = new THREE.Matrix4(), d = new THREE.Vector3(), r = new THREE.Vector3(), x = new THREE.Vector3();
    let i = 0;
    for (const dl of this.dials) {
      r.crossVectors(UP, dl.n);
      for (const [a, len, w, out] of [[aH, 0.58, 0.085, 0.03], [aM, 0.88, 0.055, 0.06]]) {
        d.copy(UP).multiplyScalar(Math.cos(a)).addScaledVector(r, Math.sin(a));
        x.crossVectors(d, dl.n);
        m.makeBasis(x, d, dl.n).setPosition(dl.c.x + dl.n.x * out, dl.c.y, dl.c.z + dl.n.z * out);
        s.makeScale(w * dl.r, len * dl.r, 0.03);
        this.hands.setMatrixAt(i++, m.multiply(s));
      }
    }
    this.hands.instanceMatrix.needsUpdate = true;
  }

  private async load(): Promise<void> {
    const file = this.low ? 'models/civic_far.glb' : 'models/civic.glb';
    const [buf, bc, bn, ao] = await Promise.all([
      assets.bytes(file),
      this.low ? null : loadTexture('models/mainst_bc.webp', true, false),
      this.low ? null : loadTexture('models/mainst_bn.webp', true, false),
      this.low || this.game.quality.lean ? null : loadTexture('models/civic_o.webp', false, false),
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
    const mat = [0, 1, 2].map((l) => { const m = civicMaterial(l, maps); this.mats.push(m); return m; });
    for (const p of this.placed) {
      const lod = new THREE.LOD();
      lod.matrixAutoUpdate = false; lod.matrix.copy(p.m); lod.matrixWorldNeedsUpdate = true;
      const near = NEAR[p.name] ?? [50, 170];
      for (const level of this.low ? [2] : [0, 1, 2]) {
        const g = geo.get(`${p.name}_${level}`);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, mat[level]);
        mesh.receiveShadow = true;
        lod.addLevel(mesh, this.low || level === 0 ? 0 : near[level - 1]);
      }
      this.group.add(lod);
    }
    for (const name of KIT) {
      const g = geo.get(name), list = this.props.get(name);
      if (!g || !list?.length) continue;
      const im = new THREE.InstancedMesh(g, mat[2], list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
      im.castShadow = name !== 'sq_bench' && !this.low; im.receiveShadow = true; im.name = name;
      this.group.add(im);
    }
    if (this.dials.length) {
      const hg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.4, 0.5);
      this.hands = new THREE.InstancedMesh(hg, new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6, metalness: 0.3 }), this.dials.length * 2);
      this.hands.name = 'clock-hands'; this.handMin = -1; this.hands.frustumCulled = false;
      this.group.add(this.hands);
      this.tick();
    }
    const merged = this.casters.length ? mergeGeometries(this.casters) : null;
    if (merged) {
      const caster = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      caster.castShadow = true; caster.name = 'civic-shadow';
      this.group.add(caster);
    }
    this.state = 'done';
  }
}

/** The one Civic of the mainland (made by buildMainlandBuildings before the places are drawn); null with `?civic=0`. */
export let civic: Civic | null = null;
export function makeCivic(game: Game, parent: THREE.Object3D, env: () => THREE.Texture | null): Civic | null {
  civic = CIVIC_ON ? new Civic(game, parent, env) : null;
  return civic;
}
