// SpeedScan headquarters (tools/briefs/speedscan-hq.md): the owner's company tower, the summit of the Ledger District.
//
// The model is Blender's (tools/blender/speedscan.py; its header is the contract): it stands on the whole of block 44
// (Calamity Ave to Gannet St, Ledger St to Bollard St), the plaza on its south side facing the spawn. buildings.ts
// hands the block to this file instead of cutting it into lots, and keeps collision for it (HQ_SOLIDS below).
//
// Files, fetched through the download queue at boot:
//   high / medium: models/speedscan.glb (hq_0 near, hq_1 street, hq_2 far, logo_0 and logo_2);
//   low (phones):  models/speedscan_far.glb (hq_2 and logo_2 only).
// The tower is a THREE.LOD; the logo (the owner's artwork as geometry) is one merged mesh over the six spots in
// LOGO_SPOTS; the stink lines are one mesh of camera-facing ribbons bent by the vertex shader (a clock uniform, no
// per-frame buffers), plus nothing else: three or four draw calls in all.
// Inside (the lobby, two lifts, the office floor 42 with the card-printer room, the roof deck): speedscanInterior.ts,
// made here and fed hq_lobby (the stand-in lobby glass) and the logo once this file's model is in.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { assets } from '../core/assets';
import { SpeedScanInterior } from './speedscanInterior';

/** The model's origin in the world: the middle of block 44's lots (x -16.5..70.5, z -6.5..70.5), at street level. */
export const HQ = { x: 27, z: 32 };
/** Model-frame boxes the player cannot walk into: x0, x1, z0, z1, top (in step with speedscan.py). */
// The lobby (x -31..31, z -14..10) is a room: speedscanInterior.ts adds its walls, the tower above the podium (boxes with
// a bottom) and, on phones, a box filling it.
export const HQ_SOLIDS: number[][] = [
  [-42, 42, -37, -14, 20],         // podium behind the lobby
  [-42, -31, -14, 10, 20], [31, 42, -14, 10, 20],   // and either side of it
  [-32, -14, 18, 30, 0.8],         // fountain
  [13, 31, 32.6, 34.8, 3.4],       // monument sign
  [-12.45, -11.55, 16.05, 16.95, 7.2], [11.55, 12.45, 16.05, 16.95, 7.2],   // canopy columns
];
/** Where the logo goes, model frame: x, y, z of its middle, turn about y (it faces +z unturned), width in meters. */
const LOGO_SPOTS: number[][] = [
  [0, 314, 1.36, 0, 49], [0, 314, -31.36, Math.PI, 49], [26.2, 314, -15, Math.PI / 2, 30], [-26.2, 314, -15, -Math.PI / 2, 30],
  [0, 199, 4.1, 0, 54],            // over the first setback, facing the spawn
  [0, 8.5, 18.12, 0, 16],          // the canopy's fascia
  [22, 1.9, 34.3, 0, 16],          // the monument on the plaza
];
const NEAR1 = 140, NEAR2 = 480;

const U = { uNight: { value: 0 }, uTime: { value: 0 } };

/** The stink lines: where each rises from (model frame) and how far. */
const STINK: number[][] = [
  [0, 350, -15, 150], [9, 349, -9, 130], [-9, 349, -21, 140], [10, 349, -22, 120], [-10, 349, -8, 135],
  [22, 323, -2, 95], [-22, 323, -28, 100], [22, 323, -28, 90], [-22, 323, -2, 105],
];
const SEGS = 40;

function stinkLines(): THREE.Mesh {
  const n = STINK.length, vpl = (SEGS + 1) * 2;
  const base = new Float32Array(n * vpl * 3), tv = new Float32Array(n * vpl * 2), seed = new Float32Array(n * vpl * 2);
  const idx: number[] = [];
  STINK.forEach(([x, y, z, len], li) => {
    for (let s = 0; s <= SEGS; s++) for (let e = 0; e < 2; e++) {
      const v = li * vpl + s * 2 + e;
      base.set([HQ.x + x, y, HQ.z + z], v * 3);
      tv.set([s / SEGS, e * 2 - 1], v * 2);
      seed.set([li * 1.618 % 1, len], v * 2);
    }
    for (let s = 0; s < SEGS; s++) { const a = li * vpl + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(base, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(tv, 2));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(HQ.x, 400, HQ.z - 15), 160);
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    transparent: true, depthWrite: false, fog: true, toneMapped: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uTime;
      attribute vec2 aT;
      attribute vec2 aSeed;
      varying vec2 vT;
      #include <fog_pars_vertex>
      vec3 at(vec3 b, float t, float ph, float len) {
        float y = t * len, w = uTime;
        float amp = 1.5 + 11.0 * t;
        vec2 off = vec2(sin(y * 0.075 - w * 1.6 + ph * 6.28), sin(y * 0.058 - w * 1.15 + ph * 9.0 + 1.3)) * amp;
        off += vec2(0.8, 0.45) * (t * t * 38.0) * (0.75 + 0.25 * sin(w * 0.13 + ph * 4.0));
        return b + vec3(off.x, y, off.y);
      }
      void main() {
        float ph = aSeed.x, len = aSeed.y;
        // Each line grows, holds and lets go on its own cycle, so they keep rising off the roof.
        float t = aT.x;
        vec3 p = at(position, t, ph, len), q = at(position, t + 0.02, ph, len);
        vec3 tg = normalize(q - p), toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(tg, toCam));
        float width = mix(2.6, 1.0, t) * 2.2;
        p += side * aT.y * width;
        vT = vec2(t, aT.y);
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float uNight;
      uniform float uTime;
      varying vec2 vT;
      #include <fog_pars_fragment>
      void main() {
        float t = vT.x, a = abs(vT.y);
        float core = 1.0 - smoothstep(0.28, 0.42, a);
        float halo = (1.0 - smoothstep(0.3, 1.0, a)) * 0.55;
        // Brighter pulses travel up each line.
        float pulse = 0.82 + 0.18 * sin(t * 24.0 - uTime * 4.0);
        vec3 lime = vec3(0.64, 0.90, 0.21), green = vec3(0.09, 0.64, 0.29);
        vec3 col = mix(lime, green, smoothstep(0.0, 0.9, t)) * pulse;
        float ends = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.62, 1.0, t));
        float alpha = (core * 0.92 + halo * mix(0.25, 1.0, uNight)) * ends;
        col *= mix(1.0, 2.2, uNight) * mix(1.0, 1.25, core);
        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
      }`,
  });
  m.uniforms.uNight = U.uNight; m.uniforms.uTime = U.uTime;
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'speedscan-stink'; mesh.renderOrder = 3;
  return mesh;
}

/** The tower's shading: glass grid and lit offices from world position (see the alpha contract in speedscan.py). */
function towerMaterial(level: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSsP;\nvarying vec3 vSsN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSsP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSsN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec3 vSsP;
        varying vec3 vSsN;
        float ssHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ssA = 0.0, ssWin = 0.0, ssLobby = 0.0, ssLamp = 0.0, ssMull = 0.0;
        vec2 ssCell = vec2(0.0);
        #ifdef USE_COLOR_ALPHA
        ssA = vColor.a;
        ssWin = (ssA > 0.3 && ssA < 0.7) ? 1.0 : 0.0;
        ssLobby = (ssA > 0.75 && ssA < 0.95) ? 1.0 : 0.0;
        ssLamp = ssA > 0.97 ? 1.0 : 0.0;
        #endif
        {
          vec3 an = abs(vSsN);
          float along = an.x > an.z ? vSsP.z : vSsP.x;
          ssCell = vec2(floor(along / 3.0), floor(vSsP.y / 3.8));
          vec2 f = vec2(fract(along / 3.0), fract(vSsP.y / 3.8));
          float side = an.y < 0.5 ? 1.0 : 0.0;
          ssMull = ssWin * side * clamp(step(f.x, 0.035) + step(0.965, f.x) + step(f.y, 0.2), 0.0, 1.0);
          float r = ssHash(ssCell + 0.37);
          diffuseColor.rgb *= mix(1.0, mix(0.82, 1.14, r), ssWin);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.095, 0.105), ssMull);
        }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.9, ssWin * (1.0 - ssMull));
        metalnessFactor = mix(metalnessFactor, 0.55, ssLobby);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.1, ssWin * (1.0 - ssMull));
        roughnessFactor = mix(roughnessFactor, 0.12, ssLobby);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // About two offices in five are lit, a little more on the lower floors; some under cool light.
          float lit = step(0.6 - 0.15 * smoothstep(300.0, 40.0, vSsP.y), ssHash(ssCell * 1.7 + 3.1));
          vec3 warm = mix(vec3(1.0, 0.76, 0.46), vec3(0.72, 0.86, 1.0), step(0.72, ssHash(ssCell.yy + vec2(9.0, 2.0))));
          totalEmissiveRadiance += uNight * (ssWin * (1.0 - ssMull) * lit * warm * 1.3 + ssLobby * vec3(1.0, 0.82, 0.58) * 1.5);
          totalEmissiveRadiance += ssLobby * vec3(1.0, 0.85, 0.62) * 0.12;   // the lit lobby shows through by day
          totalEmissiveRadiance += ssLamp * diffuseColor.rgb * mix(0.25, 2.6, uNight);
        }`);
  };
  m.customProgramCacheKey = () => 'speedscan' + level;
  return m;
}

function logoMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * mix(0.12, 1.25, uNight);');
  };
  m.customProgramCacheKey = () => 'speedscan-logo';
  return m;
}

export class SpeedScanHQ {
  readonly group = new THREE.Group();
  private low: boolean;
  private glassMats: THREE.MeshStandardMaterial[] = [];
  /** The lobby, the lifts, the office floor and the roof deck (speedscanInterior.ts). */
  readonly interior: SpeedScanInterior;

  /** `env`: the reflection map the city's own materials use (the glass is mostly reflection). */
  constructor(private game: Game, parent: THREE.Object3D, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.group.name = 'speedscan-hq';
    parent.add(this.group);
    this.interior = new SpeedScanInterior(game, this.group, HQ, env);
    // ?hq=0 leaves the tower out (the block stays empty): for timing what it costs.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('hq') === '0') return;
    this.group.add(stinkLines());
    void this.load();
  }

  update(dt: number): void {
    U.uTime.value = (U.uTime.value + dt) % 3600;
    this.interior.update(dt);
    const env = this.env();
    for (const m of this.glassMats) if (m.envMap !== env) { m.envMap = env; m.envMapIntensity = 1; m.needsUpdate = true; }
  }

  setNight(n: number): void { U.uNight.value = n; }

  private async load(): Promise<void> {
    const buf = await assets.bytes(this.low ? 'models/speedscan_far.glb' : 'models/speedscan.glb');
    // "glTF". The dev server answers a missing file with the index page.
    if (!buf || buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return;
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) geo.set(o.name, mesh.geometry); });
    const lod = new THREE.LOD();
    lod.name = 'speedscan-tower';
    lod.position.set(HQ.x, 0, HQ.z);
    for (const level of this.low ? [2] : [0, 1, 2]) {
      const g = geo.get(`hq_${level}`);
      if (!g) continue;
      g.computeBoundingSphere();
      const mat = towerMaterial(level);
      this.glassMats.push(mat);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = !this.low; mesh.receiveShadow = !this.low;
      lod.addLevel(mesh, this.low ? 0 : level === 0 ? 0 : level === 1 ? NEAR1 : NEAR2);
    }
    this.group.add(lod);
    // The lobby's warm glass as one panel: drawn while the real lobby is not (hq_0 and hq_1 have a hole there).
    let standIn: THREE.Mesh | null = null;
    const sg = !this.low ? geo.get('hq_lobby') : undefined;
    if (sg && this.glassMats[0]) {
      sg.computeBoundingSphere();
      standIn = new THREE.Mesh(sg, this.glassMats[0]);
      standIn.position.set(HQ.x, 0, HQ.z); standIn.name = 'speedscan-lobby-standin';
      this.group.add(standIn);
    }
    this.interior.attach(standIn, geo.get('logo_0') ?? null);
    const lg = geo.get(this.low ? 'logo_2' : 'logo_0') ?? geo.get('logo_2');
    if (lg) {
      const copies = LOGO_SPOTS.map(([x, y, z, ry, w]) => {
        const m = new THREE.Matrix4().compose(new THREE.Vector3(HQ.x + x, y, HQ.z + z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(w, w, w));
        return lg.clone().applyMatrix4(m);
      });
      const merged = mergeGeometries(copies);
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, logoMaterial());
        mesh.name = 'speedscan-logo';
        this.group.add(mesh);
      }
    }
    this.update(0);
  }
}
