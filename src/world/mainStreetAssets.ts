// Main St's brick blocks as Blender models (tools/blender/buildings.py writes them; its header is the contract).
//
// Lower Main's builder (mainlandBuildings.ts) hands every frontage on Main St between Front St and Bobbin St to
// MainStreet.row() instead of cutting it into its own boxes: the frontage is filled with designs in the order of the
// real street they follow (tools/briefs/tepid-reference.md), each stretched a little along the street and back to
// fill the lot exactly. The builder still owns collision and the shop signs (drawn from its own sign sheet onto the
// fascia every design carries at a known height); everything else of these buildings is in the file.
//
// The files are fetched through the download queue only once the mainland is wanted (the bridge's last spans, or a
// camera over the channel), so the island never pays for them:
//   high / medium: models/mainst.glb (three levels of detail per design) + the brick maps and the occlusion atlas;
//   low (phones):  models/mainst_far.glb alone, the far level of every design, vertex colour only.
// Every building is a THREE.LOD at (near 0 m, street NEAR1, far NEAR2); the shopfront glass is a child of the near two.
// Windows light at night from the alpha of their vertex colour (see the contract in buildings.py).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { progress } from './progress';
import { BRIDGE_SPANS } from './plan';

export interface MSDesign { w: number; D: number; top: number; HS: number; signs: number[][] }

/** From the BLD_META line buildings.py prints (shots/blender/mainst_meta.json): width, depth, parapet top, shop height, fascias [x0, x1, y0, y1]. */
export const DESIGNS: Record<string, MSDesign> = {
  secondguess: { w: 22.8, D: 18, top: 13.0, HS: 4.6, signs: [[0.75, 7.22, 3.45, 4.3], [8.17, 14.63, 3.45, 4.3], [15.58, 22.05, 3.45, 4.3]] },
  hemming: { w: 9.8, D: 20, top: 16.3, HS: 4.6, signs: [[0.75, 9.05, 3.45, 4.3]] },
  monotony: { w: 24.0, D: 24, top: 12.6, HS: 5.0, signs: [[0.75, 7.62, 3.45, 4.7], [8.57, 15.43, 3.45, 4.7], [16.38, 23.25, 3.45, 4.7]] },
  bleached: { w: 10.2, D: 17, top: 12.4, HS: 4.4, signs: [[0.75, 4.62, 3.45, 4.1], [5.57, 9.45, 3.45, 4.1]] },
  lukewarm: { w: 15.4, D: 22, top: 17.4, HS: 5.0, signs: [[0.75, 7.22, 3.45, 4.7], [8.17, 14.65, 3.45, 4.7]] },
  overdue: { w: 15.6, D: 16, top: 15.1, HS: 4.4, signs: [[0.75, 7.32, 3.45, 4.1], [8.27, 14.85, 3.45, 4.1]] },
  chaperone: { w: 8.8, D: 17, top: 15.7, HS: 4.4, signs: [[0.75, 8.05, 3.45, 4.1]] },
  pressed: { w: 9.0, D: 18, top: 13.2, HS: 4.5, signs: [[0.75, 8.25, 3.45, 4.2]] },
  gridbear: { w: 10.4, D: 18, top: 12.2, HS: 4.4, signs: [[0.75, 9.65, 3.45, 4.1]] },
  jack: { w: 10.0, D: 16, top: 9.5, HS: 4.6, signs: [[0.75, 9.25, 3.45, 4.3]] },
  barrel: { w: 13.8, D: 17, top: 12.0, HS: 4.4, signs: [[0.75, 6.42, 3.45, 4.1], [7.38, 13.05, 3.45, 4.1]] },
  smallchange: { w: 19.6, D: 22, top: 9.4, HS: 4.8, signs: [[0.75, 9.33, 3.45, 4.5], [10.28, 18.85, 3.45, 4.5]] },
};
/** The fascia's face, meters out from the wall line. */
export const FASCIA_OUT = 0.105;

/**
 * Order along each side, south to north from the landing (the real street read the same way; see the reference).
 * West side (x 56.5, facing the river): the long Greek Revival row, then the narrow four-storey blocks, the three
 * Romanesque sections, the sheet-metal front, the Colonial Revival pair and the five-and-ten. East side (x 83.5): the
 * gabled Queen Anne row first, because it is what a player arriving from the bridge should see, then the hardware
 * block, the department store, the deco bank and the blonde-brick block.
 */
const ORDER: Record<'w' | 'e', string[]> = {
  w: ['overdue', 'chaperone', 'pressed', 'pressed', 'pressed', 'gridbear', 'jack', 'barrel', 'smallchange', 'bleached', 'chaperone', 'overdue'],
  e: ['secondguess', 'secondguess', 'hemming', 'monotony', 'lukewarm', 'bleached', 'hemming', 'chaperone', 'gridbear', 'barrel'],
};
/** The stretch of Main St given over to the models: from Front St to Bobbin St (Quorum Square). */
const Z_SOUTH = -1075, Z_NORTH = -1508;
const NEAR1 = 48, NEAR2 = 150;
const BRICK_W = 1.6, BRICK_H = 1.0075;

export interface MSFrame { ox: number; oz: number; tx: number; tz: number; nx: number; nz: number; len: number; depth: number }
interface Placement { name: string; m: THREE.Matrix4 }
export interface MSPiece { name: string; s0: number; s1: number; depth: number; d: MSDesign; sx: number; mirror: boolean }

const NIGHT = { value: 0 };

export class MainStreet {
  readonly group = new THREE.Group();
  private placed: Placement[] = [];
  private state: 'idle' | 'loading' | 'done' = 'idle';
  private low: boolean;
  private glass: THREE.MeshStandardMaterial | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private shown = true;
  private cam = new THREE.Vector3();

  /** `env`: the reflection map the town's own materials use (the scene has none of its own). */
  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.group.name = 'main-street-models';
    parent.add(this.group);
  }

  /** Which side of Main St a frontage is on, if it is one the models fill. */
  side(f: MSFrame): 'w' | 'e' | null {
    if (Math.abs(f.nx) < 0.9) return null;
    const z0 = f.oz, z1 = f.oz + f.tz * f.len;
    if (Math.max(z0, z1) > Z_SOUTH || Math.min(z0, z1) < Z_NORTH) return null;
    if (f.nx > 0 && Math.abs(f.ox - 56.5) < 2) return 'w';
    if (f.nx < 0 && Math.abs(f.ox - 83.5) < 2) return 'e';
    return null;
  }

  /** Cut one frontage into designs, stretched to fill it, and remember where each goes. `y` is the sidewalk. */
  row(f: MSFrame, side: 'w' | 'e', y: number): MSPiece[] {
    const order = ORDER[side];
    // Where along the order to start: by distance up the street, so neighbouring lots carry on from each other.
    const zs = Math.max(f.oz, f.oz + f.tz * f.len);
    let at = Math.max(0, Math.floor((Z_SOUTH - zs) / 26)) % order.length;
    const names: string[] = [];
    let acc = 0;
    for (let guard = 0; guard < 12; guard++) {
      const w = DESIGNS[order[at % order.length]].w;
      if (names.length && acc + w / 2 > f.len) break;
      names.push(order[at % order.length]); acc += w; at++;
    }
    while (names.length > 1 && f.len / acc < 0.82) acc -= DESIGNS[names.pop()!].w;
    // The order reads from the south end: where the frontage runs southward, lay it from its far end.
    if (f.tz > 0) names.reverse();
    const sx = f.len / acc, mirror = f.tx * f.nz - f.tz * f.nx < 0;
    const out: MSPiece[] = [];
    let s = 0;
    for (const name of names) {
      const d = DESIGNS[name], w = d.w * sx, depth = Math.min(f.depth, d.D * 1.25);
      out.push({ name, s0: s, s1: s + w, depth, d, sx, mirror });
      // Model x runs along t, or against it from the far end when t, up and n would make a mirror image.
      const o0 = mirror ? s + w : s, tdir = mirror ? -1 : 1;
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(f.tx * tdir * sx, 0, f.tz * tdir * sx),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(f.nx * depth / d.D, 0, f.nz * depth / d.D),
      ).setPosition(f.ox + f.tx * o0, y, f.oz + f.tz * o0);
      this.placed.push({ name, m });
      s += w;
    }
    return out;
  }

  /** Where along the frontage (s) a point x of the design lands. */
  static sOf(p: MSPiece, x: number): number { return p.mirror ? p.s1 - x * p.sx : p.s0 + x * p.sx; }

  update(): void {
    if (!this.placed.length) return;
    const cam = this.game.camera.getWorldPosition(this.cam);
    if (this.state === 'idle' && (progress.spans >= BRIDGE_SPANS - 1 || cam.z < -900)) { this.state = 'loading'; void this.load(); }
    const see = cam.z < -975 + this.game.quality.drawDist + 60;
    if (see !== this.shown) { this.shown = see; this.group.visible = see; }
    const env = this.env();
    if (this.glass && this.glass.envMap !== env) {
      this.glass.envMap = env; this.glass.needsUpdate = true;
      for (const m of this.mats) { m.envMap = env; m.envMapIntensity = 0.9; m.needsUpdate = true; }
    }
  }

  setNight(n: number): void { NIGHT.value = n; }

  private async texture(url: string, flip: boolean, srgb: boolean): Promise<THREE.Texture | null> {
    try {
      const blob = await assets.blob(url);
      if (!blob || !blob.type.startsWith('image')) return null;
      const bmp = await createImageBitmap(blob, { imageOrientation: flip ? 'flipY' : 'none' });
      const t = new THREE.Texture(bmp);
      t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4; t.needsUpdate = true;
      return t;
    } catch { return null; }
  }

  private material(level: number, maps: { bc: THREE.Texture | null; bn: THREE.Texture | null; ao: THREE.Texture | null }): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
    if (level < 2 && maps.bc && maps.bn) { m.map = maps.bc; m.normalMap = maps.bn; m.normalScale.set(0.9, 0.9); }
    if (level === 0 && maps.ao) { maps.ao.wrapS = maps.ao.wrapT = THREE.ClampToEdgeWrapping; maps.ao.channel = 1; m.aoMap = maps.ao; }
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = NIGHT;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_COLOR_ALPHA
        {
          float a = vColor.a;
          float lit = ( a > 0.01 && a < 0.99 ) ? smoothstep( 0.42, 0.5, a ) : 0.0;
          totalEmissiveRadiance += uNight * lit * vec3( 1.0, 0.72, 0.42 ) * ( 0.35 + diffuseColor.rgb * 2.5 );
        }
        #endif`);
    };
    m.customProgramCacheKey = () => 'mainst' + level;
    this.mats.push(m);
    return m;
  }

  /** Brick coordinates in meters on brick faces (alpha 1); a still point inside a mortar joint everywhere else. */
  private static brickUV(g: THREE.BufferGeometry): void {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color');
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u: number, v: number;
      if (ay > 0.7) { u = x / BRICK_W; v = z / BRICK_W; } else if (ax > az) { u = z / BRICK_W; v = y / BRICK_H; } else { u = x / BRICK_W; v = y / BRICK_H; }
      if (!c || c.getW(i) < 0.995) { u = 0.06 + u * 1e-4; v = v * 1e-4; }
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  private async load(): Promise<void> {
    const file = this.low ? 'models/mainst_far.glb' : 'models/mainst.glb';
    const [buf, bc, bn, ao] = await Promise.all([
      assets.bytes(file),
      this.low ? null : this.texture('models/mainst_bc.webp', true, false),
      this.low ? null : this.texture('models/mainst_bn.webp', true, false),
      this.low ? null : this.texture('models/mainst_o.webp', false, false),
    ]);
    // "glTF". The dev server answers a missing file with the index page.
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) { this.state = 'done'; return; }
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry;
      if (o.name.endsWith('_0') && g.getAttribute('uv')) { g.setAttribute('uv1', g.getAttribute('uv')); g.deleteAttribute('uv'); }
      if (!o.name.endsWith('g')) MainStreet.brickUV(g);
      g.computeBoundingSphere();
      geo.set(o.name, g);
    });
    const maps = { bc, bn, ao };
    const mat = [this.material(0, maps), this.material(1, maps), this.material(2, maps)];
    this.glass = new THREE.MeshStandardMaterial({ color: 0x8fa3aa, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.3, depthWrite: false });
    for (const p of this.placed) {
      const lod = new THREE.LOD();
      lod.matrixAutoUpdate = false; lod.matrix.copy(p.m); lod.matrixWorldNeedsUpdate = true;
      for (const level of this.low ? [2] : [0, 1, 2]) {
        const g = geo.get(`${p.name}_${level}`);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, mat[level]);
        // The facades are single sheets, which shade themselves in the shadow map; the boxes below cast instead.
        mesh.castShadow = false; mesh.receiveShadow = true;
        const gg = geo.get(`${p.name}_${level}g`);
        if (gg) { const gm = new THREE.Mesh(gg, this.glass); gm.renderOrder = 2; mesh.add(gm); }
        lod.addLevel(mesh, this.low ? 0 : level === 0 ? 0 : level === 1 ? NEAR1 : NEAR2);
      }
      this.group.add(lod);
    }
    // One mesh of plain boxes, one per building, drawn only into the shadow map (writes neither colour nor depth on screen).
    const boxes = this.placed.map((p) => {
      const d = DESIGNS[p.name];
      return new THREE.BoxGeometry(d.w, d.top, d.D).translate(d.w / 2, d.top / 2, -d.D / 2).applyMatrix4(p.m).deleteAttribute('uv').deleteAttribute('normal');
    });
    const merged = boxes.length ? mergeGeometries(boxes) : null;
    if (merged) {
      const caster = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      caster.castShadow = true; caster.name = 'main-street-shadow';
      this.group.add(caster);
    }
    this.state = 'done';
  }
}
