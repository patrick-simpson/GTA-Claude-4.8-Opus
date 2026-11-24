// Dithers College's two hero buildings as Blender models (tools/blender/campus.py; its header is the contract): the Overdue
// Library (Georgian brick block, portico, the stepped clock tower and spire) and the Chapel of Second Thoughts (brick nave,
// tall arched windows, white steeple). Each is a THREE.LOD of three meshes: near (inside 120 m), street (inside 280 m) and far.
// High and medium load campus_hero.glb; the low preset and phones (`lean`) load campus_hero_far.glb (street and far only).
// Brick is a tiled map we draw ourselves (no photograph) laid by position and normal over the faces whose vertex alpha is 1;
// glass and clock faces (alpha 0.55 to 0.65) light at night. The code-built massing stays in the campus until a model is in.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';

const NIGHT = { value: 0 };
const TILE = 0.6;

export interface HeroSpec { name: 'library' | 'chapel'; x: number; y: number; z: number; yaw: number }

export function setHeroNight(n: number): void { NIGHT.value = n; }

function brickMap(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 192, 192);
  let s = 5; const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < 8; r++) for (let i = -1; i < 4; i++) {
    const v = 214 + Math.floor(rnd() * 42), x = i * 64 + (r & 1 ? 32 : 0);
    g.fillStyle = `rgb(${v},${v - 4},${v - 8})`; g.fillRect(x + 2, r * 24 + 2, 60, 20);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

function brickUV(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), col = g.getAttribute('color');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = n.getX(i), nz = n.getZ(i), hl = Math.hypot(nx, nz) || 1;
    let u = (p.getX(i) * (-nz / hl) + p.getZ(i) * (nx / hl)) / TILE, v = p.getY(i) / TILE;
    if (!col || col.getW(i) < 0.995) { u = 0.5 + u * 1e-4; v = 0.3 + v * 1e-4; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function heroMaterial(map: THREE.Texture | null, env: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, envMap: env, envMapIntensity: 0.5 });
  if (map) m.map = map;
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
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR_ALPHA
      {
        float a = vColor.a;
        float lit = ( a > 0.01 && a < 0.99 ) ? smoothstep( 0.42, 0.5, a ) : 0.0;
        totalEmissiveRadiance += uNight * lit * vec3( 1.0, 0.72, 0.42 ) * ( 0.35 + diffuseColor.rgb * 2.5 );
      }
      #endif`);
  };
  m.customProgramCacheKey = () => 'dithershero';
  return m;
}

/** Loads the models and puts one LOD per spec in `parent`; resolves true when they are in (so the caller can drop the stand-ins). */
export async function loadHeroes(game: Game, parent: THREE.Object3D, specs: HeroSpec[], env: () => THREE.Texture | null): Promise<boolean> {
  const lean = !!game.quality.lean || game.quality.name === 'low';
  const buf = await assets.bytes(lean ? 'models/campus_hero_far.glb' : 'models/campus_hero.glb');
  if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return false;
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const geo = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { brickUV(me.geometry); geo.set(o.name, me.geometry); } });
  const mats = [heroMaterial(lean ? null : brickMap(), env()), heroMaterial(brickMap(), env()), heroMaterial(null, env())];
  for (const sp of specs) {
    const lod = new THREE.LOD();
    lod.name = 'hero-' + sp.name;
    const dist = lean ? [0, 220] : [0, 120, 280];
    const lv = lean ? [1, 2] : [0, 1, 2];
    lv.forEach((l, i) => {
      const g = geo.get(`${sp.name}_${l}`); if (!g) return;
      const mesh = new THREE.Mesh(g, mats[l]);
      mesh.castShadow = l < 2 && !lean; mesh.receiveShadow = true;
      lod.addLevel(mesh, dist[i]);
    });
    if (!lod.levels.length) continue;
    lod.position.set(sp.x, sp.y, sp.z); lod.rotation.y = sp.yaw;
    lod.updateMatrix(); lod.matrixAutoUpdate = false;
    parent.add(lod);
  }
  return true;
}
