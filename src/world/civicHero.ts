// Tepid Falls' footprint churches, schools and halls (kit 7 and 8 of footprintData.ts) as Blender hero models
// (tools/blender/civic_hero.py; its header is the contract): three churches (white clapboard with a tall spire, red-brick
// Gothic with a stone-and-slate spire, stone Romanesque with a square tower), a brick elementary school with a cupola and a
// large brick high school with a portico and a clock tower, and a brick town hall with a copper-domed clock tower. mainlandBuildings.ts osm() picks one by footprint, hands the
// spec to add() and keeps the footprint's collision box and its front wall (business doors) exactly as before; nothing is
// drawn there in code any more, the model stands in its place once it has loaded (a few seconds after the mainland is wanted).
// Each model is a THREE.LOD (near, street, far). High and medium load civic_hero.glb; the low preset and phones (`lean`)
// load civic_hero_far.glb (street and far levels only). Materials are civicAssets.ts's (brick map by position, lit windows,
// stained glass that glows in its own colour at night). `?hero=0` keeps the code-built churches and schools.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS } from './plan';
import { brickUV, loadTexture } from './mainStreetAssets';
import { civicMaterial, setCivicNight } from './civicAssets';

export const HERO_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('hero') !== '0';

export type HeroName = 'church_clap' | 'church_gothic' | 'church_rom' | 'school_elem' | 'school_high' | 'civic_hall';
/** Each model's plan (width along x, depth along z, metres) and height; printed by civic_hero.py as CIVIC_HERO_STATS. */
const DIMS: Record<HeroName, [number, number, number]> = {
  church_clap: [13.1, 25.15, 33.5], church_gothic: [18.1, 30.45, 43.5], church_rom: [17.0, 30.04, 33.5],
  school_elem: [45.0, 20.42, 17.3], school_high: [80.8, 40.12, 37.7], civic_hall: [49.2, 29.22, 31.5],
};
const CHURCHES: HeroName[] = ['church_clap', 'church_gothic', 'church_rom'];

export interface HeroSpec { name: HeroName; x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number }

let churchCount = 0, bigCount = 0;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** Which model a footprint of kit `t` (7 church, 8 school or hall) with this plan gets, and where and how big it stands. h: the footprint's heading (front normal is (sin h, cos h)). */
export function heroFit(t: number, cx: number, cz: number, h: number, w: number, d: number, y: number): HeroSpec {
  const church = t === 7;
  const name: HeroName = church ? CHURCHES[churchCount++ % 3] : w * d < 900 ? 'school_elem' : w * d < 2400 || bigCount++ & 1 ? 'civic_hall' : 'school_high';
  const [W0, D0] = DIMS[name];
  // Turn the model a quarter when that fits the footprint's shape much better (the front looks along the street otherwise).
  const dist = (fw: number, fd: number): number => Math.abs(Math.log(fw / W0 / (fd / D0)));
  const rot = dist(d, w) + 0.35 < dist(w, d);
  const fw = rot ? d : w, fd = rot ? w : d;
  const sx = clamp(fw / W0, 0.7, 1.6), sz = clamp(fd / D0, 0.7, 1.6), sy = clamp(Math.sqrt(sx * sz), 0.85, 1.3);
  return { name, x: cx, y, z: cz, yaw: h + (rot ? (churchCount & 1 ? Math.PI / 2 : -Math.PI / 2) : 0), sx, sy, sz };
}

export class CivicHero {
  readonly group = new THREE.Group();
  private specs: HeroSpec[] = [];
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private mats: THREE.MeshStandardMaterial[] = [];
  private shown = true;
  private cam = new THREE.Vector3();
  private lean: boolean;

  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.lean = !!game.quality.lean || game.quality.name === 'low';
    this.group.name = 'civic-hero';
    parent.add(this.group);
    churchCount = 0; bigCount = 0;
  }

  add(s: HeroSpec): void { this.specs.push(s); }

  update(): void {
    if (!this.specs.length) return;
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const see = cam.z < -975 + this.game.quality.drawDist + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    const env = this.env();
    if (this.mats.length && this.mats[0].envMap !== env) for (const m of this.mats) { m.envMap = env; m.envMapIntensity = 0.9; m.needsUpdate = true; }
  }

  setNight(n: number): void { setCivicNight(n); }

  private async load(): Promise<void> {
    const lean = this.lean;
    const [buf, bc, bn] = await Promise.all([
      assets.bytes(lean ? 'models/civic_hero_far.glb' : 'models/civic_hero.glb'),
      lean ? null : loadTexture('models/mainst_bc.webp', true, false),
      lean ? null : loadTexture('models/mainst_bn.webp', true, false),
    ]);
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) { this.state = 'done'; return; }
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const me = o as THREE.Mesh;
      if (!me.isMesh) return;
      brickUV(me.geometry); me.geometry.computeBoundingSphere();
      geo.set(o.name, me.geometry);
    });
    const maps = { bc, bn, ao: null };
    const mat = [0, 1, 2].map((l) => { const m = civicMaterial(l, maps); this.mats.push(m); return m; });
    const levels = lean ? [1, 2] : [0, 1, 2], dist = lean ? [0, 200] : [0, 70, 220];
    for (const sp of this.specs) {
      const lod = new THREE.LOD();
      lod.name = 'hero-' + sp.name;
      levels.forEach((l, i) => {
        const g = geo.get(`${sp.name}_${l}`); if (!g) return;
        const mesh = new THREE.Mesh(g, mat[l]);
        mesh.castShadow = l < 2 && !lean; mesh.receiveShadow = true;
        lod.addLevel(mesh, dist[i]);
      });
      if (!lod.levels.length) continue;
      lod.position.set(sp.x, sp.y, sp.z); lod.rotation.y = sp.yaw; lod.scale.set(sp.sx, sp.sy, sp.sz);
      lod.updateMatrix(); lod.matrixAutoUpdate = false;
      this.group.add(lod);
    }
    this.state = 'done';
  }
}

/** The one CivicHero of the mainland (made by buildMainlandBuildings before osm() runs); null with `?hero=0`. */
export let civicHero: CivicHero | null = null;
export function makeCivicHero(game: Game, parent: THREE.Object3D, env: () => THREE.Texture | null): CivicHero | null {
  civicHero = HERO_ON ? new CivicHero(game, parent, env) : null;
  return civicHero;
}
