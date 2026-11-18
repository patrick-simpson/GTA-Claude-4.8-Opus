// Vegetation as files, and the one material all of it shares.
//
// tools/blender/flora.py writes public/models/flora.glb: every tree species at
// two levels of detail, a shrub and a run of hedge (node names and the UV
// contract are in that file's header). This module
//   * paints the atlas those UVs address (bark down column 0, leaf pictures with
//     alpha in the other cells) on a canvas, so no image ships;
//   * builds the material: alpha-tested leaf cards with alpha-to-coverage where
//     the scene target is multisampled, alpha that thickens with the mip level so
//     a crown does not thin out and sparkle at distance, normals that are never
//     flipped for back faces (the loader gives leaves normals that swell out from
//     the crown, so a card lit from "behind" is still the sunny side of the tree),
//     and a little light through the leaves when looking toward the sun;
//   * loads the file and hands back plain geometries;
//   * owns TreeField, which draws every tree in the city from three instanced
//     meshes per species: full detail near the camera, the far model within
//     shadow range (both cast), and the far model without shadows beyond that,
//     culled to the view on the CPU. It refills them only when the camera has
//     moved a few meters or turned a few degrees.
//
// Nothing here runs on the `low` preset: phones keep the shapes ground.ts draws.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RNG, TAU } from '../core/util';

export type Rect4 = readonly [number, number, number, number];
const cell = (c: number, r: number, w = 1, h = 1, pad = 0.006): Rect4 =>
  [c * 0.25 + pad, r * 0.25 + pad, (c + w) * 0.25 - pad, (r + h) * 0.25 - pad];
/** Atlas cells, as u0, v0, u1, v1 with v running DOWN the picture. Stalks grow from v1. */
export const CELL = {
  shrub: cell(2, 2), flowers: cell(3, 2), grass: cell(1, 3), dune: cell(2, 3), hedge: cell(3, 3),
} as const;
/** u below this is bark. Must match flora.py. */
const BARK_U = 0.25;

type Ctx = CanvasRenderingContext2D;

function paintAtlas(): THREE.DataTexture {
  const S = 1024, Q = 256;
  const mk = (): Ctx => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    return cv.getContext('2d', { willReadFrequently: true })!;
  };
  // Colour and coverage are painted on separate canvases and joined at the end: a canvas
  // stores premultiplied colour, so a transparent texel has none, and the mip chain would
  // then mix black into every leaf edge.
  const col = mk(), mask = mk();
  mask.fillStyle = '#000'; mask.fillRect(0, 0, S, S);
  col.fillStyle = 'rgb(176,188,158)'; col.fillRect(0, 0, S, S);
  const rng = new RNG(4411);
  const R = (a: number, b: number): number => rng.range(a, b);
  const both = (style: string, fn: (c: Ctx) => void): void => {
    col.fillStyle = col.strokeStyle = style; fn(col);
    mask.fillStyle = mask.strokeStyle = '#fff'; fn(mask);
  };
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, style: string): void => both(style, (c) => {
    c.save(); c.translate(x, y); c.rotate(ang);
    c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(len * 0.42, -wid, len, 0); c.quadraticCurveTo(len * 0.42, wid, 0, 0); c.fill();
    c.restore();
  });
  const curve = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, w: number, style: string): void => both(style, (c) => {
    c.lineWidth = w; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(cx, cy, x1, y1); c.stroke();
  });
  const inCell = (cx: number, cy: number, w: number, fn: (x: number, y: number) => void, base?: string): void => {
    const x = cx * Q, y = cy * Q;
    for (const c of [col, mask]) { c.save(); c.beginPath(); c.rect(x, y, w * Q, Q); c.clip(); }
    if (base) { col.fillStyle = base; col.fillRect(x, y, w * Q, Q); }
    fn(x, y);
    for (const c of [col, mask]) c.restore();
  };
  // Leaf pictures are pale and nearly grey: the tree's own colour is its instance tint.
  const tone = (v: number): string => `rgb(${Math.round(v * 0.95)},${Math.round(Math.min(255, v))},${Math.round(v * 0.8)})`;

  const cluster = (cx: number, cy: number, n: number, l0: number, l1: number, lobed: boolean): void => inCell(cx, cy, 1, (x, y) => {
    const mx = x + 128, my = y + 128;
    for (let i = 0; i < 6; i++) {
      const a = R(0, TAU), r = R(60, 100);
      curve(mx, my, mx + Math.cos(a + 0.3) * r * 0.5, my + Math.sin(a + 0.3) * r * 0.5, mx + Math.cos(a) * r, my + Math.sin(a) * r, 3, 'rgb(128,116,96)');
    }
    for (let i = 0; i < n; i++) {
      const layer = i / n, len = R(l0, l1), a = R(0, TAU), rad = (116 - len) * Math.sqrt(rng.next());
      const px = mx + Math.cos(a) * rad, py = my + Math.sin(a) * rad, ang = a + R(-1.0, 1.0);
      const st = tone(132 + 100 * layer + R(-14, 14));
      if (lobed) { leaf(px, py, len * 0.78, len * 0.2, ang - 0.62, st); leaf(px, py, len * 0.78, len * 0.2, ang + 0.62, st); }
      leaf(px, py, len, len * (lobed ? 0.24 : 0.3), ang, st);
      col.strokeStyle = 'rgba(255,255,240,0.25)'; col.lineWidth = 1;
      col.beginPath(); col.moveTo(px, py); col.lineTo(px + Math.cos(ang) * len * 0.9, py + Math.sin(ang) * len * 0.9); col.stroke();
    }
  });
  cluster(1, 0, 80, 26, 40, false);
  cluster(2, 0, 64, 30, 44, true);
  cluster(3, 0, 110, 20, 32, false);
  cluster(2, 2, 170, 13, 23, false);

  // Palm frond: the stem along the strip's middle, leaflets raked toward the tip.
  inCell(1, 1, 3, (x, y) => {
    const my = y + 128, x0 = x + 8, x1 = x + 3 * Q - 8;
    curve(x0, my, (x0 + x1) / 2, my, x1, my, 5, 'rgb(170,168,120)');
    for (let px = x0 + 6; px < x1 - 6; px += 7.5) {
      const f = (px - x0) / (x1 - x0), L = 22 + 100 * Math.pow(Math.sin(Math.PI * Math.pow(f, 0.55)), 0.8);
      for (const s of [-1, 1]) leaf(px, my, L * R(0.88, 1.04), 4.4, s * (1.12 - 0.5 * f + R(-0.06, 0.06)), tone(R(160, 235)));
    }
  });

  // Cypress: sprays that all point up, packed into an oval.
  inCell(1, 2, 1, (x, y) => {
    for (let i = 0; i < 210; i++) {
      const layer = i / 210, len = R(30, 50);
      let ex = 0, ey = 0;
      do { ex = R(-1, 1); ey = R(-1, 1); } while (ex * ex + ey * ey > 1);
      leaf(x + 128 + ex * 96, y + 150 + ey * 92, len, 9, -Math.PI / 2 + R(-0.55, 0.55), tone(118 + 110 * layer + R(-12, 12)));
    }
  });

  // Clipped hedge: no gaps at all.
  inCell(3, 3, 1, (x, y) => {
    both(tone(104), (c) => c.fillRect(x, y, Q, Q));
    for (let i = 0; i < 520; i++) leaf(x + R(0, Q), y + R(0, Q), R(12, 22), R(4, 7), R(0, TAU), tone(104 + 120 * (i / 520) + R(-14, 14)));
  });

  // The ground-cover cells are painted in their real colours and drawn untinted.
  const blades = (x: number, y: number, n: number, spread: number, h0: number, h1: number, lean: number, w: number, hue: () => string): void => {
    for (let i = 0; i < n; i++) {
      const bx = x + 128 + R(-spread, spread), h = R(h0, h1), tip = R(-lean, lean) * (h / h1), by = y + Q - 1, st = hue();
      curve(bx, by, bx + tip * 0.15, by - h * 0.6, bx + tip * 0.6, by - h * 0.72, w, st);
      curve(bx + tip * 0.6, by - h * 0.72, bx + tip * 0.8, by - h * 0.9, bx + tip, by - h, w * 0.45, st);
    }
  };
  const green = (): string => `rgb(${Math.round(R(84, 140))},${Math.round(R(124, 172))},${Math.round(R(46, 78))})`;
  const straw = (): string => `rgb(${Math.round(R(160, 204))},${Math.round(R(158, 192))},${Math.round(R(92, 124))})`;
  inCell(1, 3, 1, (x, y) => blades(x, y, 84, 74, 60, 236, 46, 5, green), 'rgb(112,148,62)');
  inCell(2, 3, 1, (x, y) => blades(x, y, 40, 38, 110, 244, 84, 3.2, straw), 'rgb(182,176,108)');
  inCell(3, 2, 1, (x, y) => {
    blades(x, y, 46, 80, 40, 150, 34, 4.5, green);
    const petals = ['#f4f1e6', '#f2c230', '#e58fb0', '#b49be0', '#f4f1e6'];
    for (let i = 0; i < 15; i++) {
      const bx = x + 128 + R(-92, 92), top = y + R(60, 170), by = y + Q - 1, r = R(8, 12), p = rng.pick(petals);
      curve(bx, by, bx + R(-8, 8), (by + top) / 2, bx, top, 2.6, 'rgb(96,136,60)');
      both(p, (c) => { c.beginPath(); c.arc(bx, top, r, 0, TAU); c.fill(); });
      col.fillStyle = '#c9861c'; col.beginPath(); col.arc(bx, top, r * 0.36, 0, TAU); col.fill();
    }
  }, 'rgb(112,148,62)');

  // Bark: a pale ground with long fissures. Everything is drawn twice, one tile apart, so it repeats down v.
  mask.fillStyle = '#fff'; mask.fillRect(0, 0, Q, S);
  col.fillStyle = 'rgb(186,178,164)'; col.fillRect(0, 0, Q, S);
  col.save(); col.beginPath(); col.rect(0, 0, Q, S); col.clip(); col.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const dark = i % 3 !== 0, x = R(0, Q), y = R(0, S), len = R(30, dark ? 200 : 110), w = R(-9, 9);
    col.strokeStyle = dark ? `rgba(${Math.round(R(58, 96))},${Math.round(R(48, 80))},${Math.round(R(38, 64))},${R(0.35, 0.7)})` : `rgba(226,220,206,${R(0.25, 0.55)})`;
    col.lineWidth = dark ? R(1.5, 5) : R(1.5, 3.5);
    for (const oy of [0, -S]) {
      col.beginPath(); col.moveTo(x, y + oy); col.quadraticCurveTo(x + w, y + oy + len / 2, x + R(-3, 3), y + oy + len); col.stroke();
    }
  }
  col.restore();

  const a = col.getImageData(0, 0, S, S).data, m = mask.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = a[i]; out[i + 1] = a[i + 1]; out[i + 2] = a[i + 2]; out[i + 3] = m[i]; }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

let shared: THREE.MeshStandardMaterial | null = null;

/** The one flora material. Vertex colours on; an instance colour tints the leaves and leaves the bark alone. */
export function floraMaterial(): THREE.MeshStandardMaterial {
  if (shared) return shared;
  const m = new THREE.MeshStandardMaterial({
    map: paintAtlas(), vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.36, roughness: 0.7, metalness: 0,
    envMapIntensity: 0.2, fog: true,
  });
  m.alphaToCoverage = true;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
      #ifdef USE_INSTANCING_COLOR
        if ( uv.x < ${BARK_U.toFixed(2)} ) vColor.xyz = color.xyz;
      #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
          {
            // A leaf's alpha averages away as the mip level climbs; give it back, or far crowns go thin and sparkle.
            vec2 tx = vMapUv * 1024.0;
            vec2 ddx = dFdx( tx ), ddy = dFdy( tx );
            float lod = max( 0.0, 0.5 * log2( max( dot( ddx, ddx ), dot( ddy, ddy ) ) ) );
            diffuseColor.a *= 1.0 + 0.22 * lod;
          }
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        #ifdef USE_MAP
          roughnessFactor = vMapUv.x < ${BARK_U.toFixed(2)} ? 0.94 : 0.86;
        #endif`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/float faceDirection = [^;]+;/, 'float faceDirection = 1.0;'))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0 && defined( USE_MAP )
          if ( vMapUv.x >= ${BARK_U.toFixed(2)} ) {
            float back = pow( max( dot( geometryViewDir, - directionalLights[ 0 ].direction ), 0.0 ), 2.0 );
            reflectedLight.directDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * vec3( 0.9, 1.0, 0.4 ) * ( RECIPROCAL_PI * 0.7 * back );
          }
        #endif`);
  };
  shared = m;
  return m;
}

const _v = new THREE.Vector3();

/** Copy a file geometry into plain float attributes and give the leaves normals that swell out from the crown. */
function rebuild(g: THREE.BufferGeometry, name: string): THREE.BufferGeometry | null {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv'), c = g.getAttribute('color');
  if (!p || !uv) return null;
  const N = p.count, pos = new Float32Array(N * 3), nor = new Float32Array(N * 3), tex = new Float32Array(N * 2), col = new Float32Array(N * 3);
  const box = new THREE.Box3();
  for (let i = 0; i < N; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), u = uv.getX(i);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    tex[i * 2] = u; tex[i * 2 + 1] = uv.getY(i);
    if (n) { nor[i * 3] = n.getX(i); nor[i * 3 + 1] = n.getY(i); nor[i * 3 + 2] = n.getZ(i); } else nor[i * 3 + 1] = 1;
    // getX undoes the normalisation the exporter packs colours in.
    col[i * 3] = c ? c.getX(i) : 1; col[i * 3 + 1] = c ? c.getY(i) : 1; col[i * 3 + 2] = c ? c.getZ(i) : 1;
    if (u >= BARK_U) box.expandByPoint(_v.set(x, y, z));
  }
  if (!box.isEmpty()) {
    const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
    const rx = Math.max(0.2, (box.max.x - box.min.x) / 2), ry = Math.max(0.2, (box.max.y - box.min.y) / 2), rz = Math.max(0.2, (box.max.z - box.min.z) / 2);
    const frond = name.startsWith('palmcrown');
    for (let i = 0; i < N; i++) {
      if (tex[i * 2] < BARK_U) continue;
      if (frond) {
        // A frond is a real surface: keep its own normal, turned to the sky side.
        const s = nor[i * 3 + 1] < 0 ? -1 : 1;
        _v.set(nor[i * 3] * s, nor[i * 3 + 1] * s + 0.7, nor[i * 3 + 2] * s);
      } else {
        _v.set((pos[i * 3] - cx) / rx, (pos[i * 3 + 1] - cy) / ry + 0.3, (pos[i * 3 + 2] - cz) / rz);
      }
      _v.normalize();
      nor[i * 3] = _v.x; nor[i * 3 + 1] = _v.y; nor[i * 3 + 2] = _v.z;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(tex, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.index) out.setIndex(Array.from(g.index.array));
  return out;
}

/** Geometries by node name (`oak_L0`, `palmcrown_L1`, ...). Null if the file is missing or broken; never throws, never logs an error. */
export async function loadFlora(): Promise<Map<string, THREE.BufferGeometry> | null> {
  try {
    const res = await fetch('models/flora.glb');
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // "glTF". The dev server answers a missing file with the index page.
    if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const out = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = /_L\d$/.test(o.name) ? o.name : o.parent?.name ?? o.name;
      const g = rebuild(mesh.geometry, name);
      if (g) out.set(name, g);
      mesh.geometry.dispose();
    });
    return out.size ? out : null;
  } catch (e) {
    console.warn('models/flora.glb did not load; keeping the simple trees', e);
    return null;
  }
}

// ── Drawing them ─────────────────────────────────────────────────────────────

/** Everything planted: a kind per entry (`oak`, `palmtrunk`, ...), 16 matrix numbers and 3 colour numbers each. */
export interface Planting { kind: string[]; m: number[]; c: number[] }

interface Kind { n: number; m: Float32Array; c: Float32Array; tiers: THREE.InstancedMesh[]; small: boolean }

const NEAR = 40, MID = 72;
const _p = new THREE.Vector3(), _d = new THREE.Vector3();

export class TreeField {
  private kinds: Kind[] = [];
  private last = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();

  constructor(parent: THREE.Object3D, geo: Map<string, THREE.BufferGeometry>, plan: Planting, private far: number) {
    const mat = floraMaterial();
    const names = [...new Set(plan.kind)];
    for (const name of names) {
      const g0 = geo.get(name + '_L0'), g1 = geo.get(name + '_L1') ?? g0;
      if (!g0 || !g1) continue;
      const idx: number[] = [];
      plan.kind.forEach((k, i) => { if (k === name) idx.push(i); });
      const n = idx.length, m = new Float32Array(n * 16), c = new Float32Array(n * 3);
      idx.forEach((src, i) => {
        for (let k = 0; k < 16; k++) m[i * 16 + k] = plan.m[src * 16 + k];
        for (let k = 0; k < 3; k++) c[i * 3 + k] = plan.c[src * 3 + k];
      });
      const tiers = [[g0, Math.min(n, 220), true], [g1, Math.min(n, 700), true], [g1, n, false]].map(([g, cap, cast]) => {
        const mesh = new THREE.InstancedMesh(g as THREE.BufferGeometry, mat, cap as number);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((cap as number) * 3), 3);
        mesh.castShadow = cast as boolean; mesh.receiveShadow = cast as boolean;   // beyond shadow range there is nothing to receive, and the program is cheaper
        mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
        mesh.count = 0;
        parent.add(mesh);
        return mesh;
      });
      this.kinds.push({ n, m, c, tiers, small: g1 === g0 });
    }
  }

  /** Sort every tree into its tier for this camera. Does nothing until the camera has moved or turned enough to matter. */
  update(cam: THREE.PerspectiveCamera): void {
    cam.getWorldPosition(_p); cam.getWorldDirection(_d);
    if (_p.distanceToSquared(this.last) < 9 && _d.dot(this.lastDir) > 0.995) return;
    this.last.copy(_p); this.lastDir.copy(_d);
    const hl = Math.hypot(_d.x, _d.z), cone = hl > 0.55;
    const fx = _d.x / (hl || 1), fz = _d.z / (hl || 1);
    // Half the horizontal view, plus the turn allowed before the next refill and the width of a crown.
    const half = Math.min(1.5, Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect) + 0.22);
    const cos2 = Math.cos(half) ** 2, F2 = this.far * this.far;
    for (const k of this.kinds) {
      const cnt = [0, 0, 0], cap = k.tiers.map((t) => t.instanceMatrix.count);
      // A shrub is not worth a full-detail tier further than a street's width away.
      const N2 = k.small ? 0 : NEAR * NEAR, M2 = k.small ? 40 * 40 : MID * MID;
      for (let i = 0; i < k.n; i++) {
        const dx = k.m[i * 16 + 12] - _p.x, dz = k.m[i * 16 + 14] - _p.z, d2 = dx * dx + dz * dz;
        let t = 2;
        if (d2 < N2 && cnt[0] < cap[0]) t = 0;
        else if (d2 < M2 && cnt[1] < cap[1]) t = 1;
        else {
          if (d2 > F2) continue;
          if (cone && d2 > 14400) { const dot = dx * fx + dz * fz; if (dot < 0 || dot * dot < cos2 * d2) continue; }
        }
        const mesh = k.tiers[t], at = cnt[t]++;
        (mesh.instanceMatrix.array as Float32Array).set(k.m.subarray(i * 16, i * 16 + 16), at * 16);
        (mesh.instanceColor!.array as Float32Array).set(k.c.subarray(i * 3, i * 3 + 3), at * 3);
      }
      for (let t = 0; t < 3; t++) {
        const mesh = k.tiers[t];
        mesh.count = cnt[t];
        mesh.visible = cnt[t] > 0;
        if (!cnt[t]) continue;
        mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, cnt[t] * 16); mesh.instanceMatrix.needsUpdate = true;
        const ic = mesh.instanceColor!;
        ic.clearUpdateRanges(); ic.addUpdateRange(0, cnt[t] * 3); ic.needsUpdate = true;
      }
    }
  }
}

// ── Asked for by other builders ──────────────────────────────────────────────

/** Plantings other builders ask for (places.ts runs after the ground is built). ground.ts adds them to its own when the models arrive. */
export const EXTRA: Planting = { kind: [], m: [], c: [] };
const _xm = new THREE.Matrix4(), _xq = new THREE.Quaternion(), _xe = new THREE.Euler(), _xs = new THREE.Vector3(), _xc = new THREE.Color();

/** Ask for one model of `kind` (`plane`, `maple`, `oak`, `cypress`, `shrub`, `hedge`, `palmtrunk`, `palmcrown`) standing at a spot. */
export function plantExtra(kind: string, x: number, y: number, z: number, heading: number, scale: number, hex: number, gain = 1.2, sy = scale): void {
  _xm.compose(_p.set(x, y, z), _xq.setFromEuler(_xe.set(0, heading, 0)), _xs.set(scale, sy, scale));
  EXTRA.kind.push(kind);
  for (let i = 0; i < 16; i++) EXTRA.m.push(_xm.elements[i]);
  _xc.setHex(hex);
  EXTRA.c.push(_xc.r * gain, _xc.g * gain, _xc.b * gain);
}

/** Ground cover: crossed cards from the atlas (grass, dune grass, flowers), merged into one mesh per map region. */
export class Cover {
  private buckets = new Map<number, { p: number[]; u: number[]; c: number[] }>();
  constructor(private region: number) {}

  /** `blades` cards of w by h crossed at (x, y, z). Lit as the ground they stand on, darker at the root. */
  tuft(x: number, y: number, z: number, cell: Rect4, w: number, h: number, heading: number, shade = 1, blades = 2): void {
    const R = this.region, key = (Math.floor(x / R) + 64) * 256 + Math.floor(z / R) + 64;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { p: [], u: [], c: [] }));
    const lo = shade * 0.62;
    for (let k = 0; k < blades; k++) {
      const a = heading + (k * Math.PI) / blades, dx = (Math.cos(a) * w) / 2, dz = (Math.sin(a) * w) / 2;
      b.p.push(x - dx, y, z - dz, x + dx, y, z + dz, x + dx, y + h, z + dz, x - dx, y + h, z - dz);
      b.u.push(cell[0], cell[3], cell[2], cell[3], cell[2], cell[1], cell[0], cell[1]);
      b.c.push(lo, lo, lo, lo, lo, lo, shade, shade, shade, shade, shade, shade);
    }
  }

  build(parent: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const b of this.buckets.values()) {
      const n = b.p.length / 3, nor = new Float32Array(n * 3), idx: number[] = [];
      for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
      for (let q = 0; q < n; q += 4) idx.push(q, q + 1, q + 2, q, q + 2, q + 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, floraMaterial());
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}
