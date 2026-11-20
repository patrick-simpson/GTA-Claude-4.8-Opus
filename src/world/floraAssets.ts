// Vegetation as files, and the materials all of it shares.
//
// tools/blender/flora.py writes public/models/flora2.glb and five pictures beside it (that
// file's header is the contract). A tree is stored as what is unique about it: its wood at two
// levels of detail and a point per branch tip. This module
//   * joins the colour and coverage pictures into the atlas (kept apart on disk so the colour
//     under a transparent texel survives compression and the mip chain);
//   * assembles each kind that is actually planted: every tip gets its template (a twig and
//     three or four bent cards of leaves rendered from leaf geometry), and the leaves get
//     normals that are part the card's own and part the crown's, so a crown shades as a volume
//     and a card still catches the light its own way;
//   * builds the material: alpha-tested cards with alpha-to-coverage, alpha that thickens with
//     the mip level so a crown does not thin out and sparkle at distance, a normal map (bark
//     from its height field, leaves from the fold of each leaf), and light through the leaves
//     when the sun is behind them;
//   * owns TreeField, which draws every tree from three things: the full model near the camera,
//     the middle model out to shadow range, and beyond that ONE instanced mesh of impostors
//     (crossed cards and a cap, baked from the full models) for every kind at once. Where two
//     levels meet both are drawn for a few meters and dithered against each other in the
//     shader, from the true distance, so nothing pops and nothing waits on the CPU. The middle
//     model is also the only shadow caster: near trees stay in its mesh, thrown off screen in
//     the colour pass and drawn in the shadow pass, which costs a tenth of casting the full model.
//
// Nothing here runs on the `low` preset: phones keep the shapes ground.ts draws.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { putChanged } from '../core/util';
import { flip, sendRange } from '../core/flip';

export type Rect4 = readonly [number, number, number, number];
const AW = 2048, AH = 1536, Q = 256, FAR_PX = 2048;
const cell = (c: number, r: number, pad = 5): Rect4 => [(c * Q + pad) / AW, (r * Q + pad) / AH, ((c + 1) * Q - pad) / AW, ((r + 1) * Q - pad) / AH];
/** Atlas cells, as u0, v0, u1, v1 with v running DOWN the picture. Stalks grow from v1. Must match flora.py. */
export const CELL = {
  shrub: cell(7, 2), hedge: cell(3, 3), ivy: cell(4, 3), fern: cell(5, 3), reed: cell(6, 3), fallen: cell(7, 3),
  grass: cell(0, 4), dune: cell(1, 4), flowers: cell(2, 4), bedwarm: cell(3, 4), bedcool: cell(4, 4),
} as const;
/** v above this (the top third of the picture) is bark. */
const BARK_V = (2 * Q) / AH;

// ── Pictures ─────────────────────────────────────────────────────────────────

function blank(r: number, g: number, b: number, a: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

interface Pix { w: number; h: number; d: Uint8ClampedArray }

async function pixels(url: string): Promise<Pix | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  // The dev server answers a missing file with the index page.
  if (!blob.type.startsWith('image')) return null;
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = document.createElement('canvas');
  // Read the size first: a closed bitmap reports 0 by 0, and a 0 by 0 texture samples as opaque black.
  const w = bmp.width, h = bmp.height;
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bmp, 0, 0);
  const d = cx.getImageData(0, 0, w, h).data;
  bmp.close();
  if (!w || !h || d.length !== w * h * 4) return null;
  return { w, h, d };
}

function picture(p: Pix, alpha: Pix | null, srgb: boolean): THREE.DataTexture {
  const out = new Uint8Array(p.d.length);
  out.set(p.d);
  if (alpha) for (let i = 3; i < out.length; i += 4) out[i] = alpha.d[i - 3];
  const t = new THREE.DataTexture(out, p.w, p.h, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// Until the pictures arrive every card is fully transparent, so nothing half-made is ever drawn.
const TEX = {
  map: blank(120, 130, 100, 0, true) as THREE.Texture, nrm: blank(128, 128, 255, 255, false) as THREE.Texture,
  far: blank(120, 130, 100, 0, true) as THREE.Texture, farMask: blank(0, 0, 0, 255, false) as THREE.Texture,
};

// ── The material ─────────────────────────────────────────────────────────────

const made: { m: THREE.MeshStandardMaterial; far: boolean }[] = [];
export const FAR_GAIN = { value: 0.6 };
const NO_FADE = new THREE.Vector4(-2, -1, 1e8, 2e8);

/**
 * A flora material. `fade` is the distance band it is drawn in (starts to appear, fully there,
 * starts to go, gone), measured from the camera to the instance's foot. `far` makes it the
 * impostor's: the card is built in the vertex shader from the instance's cell and size.
 */
function makeMaterial(fade: THREE.Vector4, far: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: far ? TEX.far : TEX.map, vertexColors: !far, side: THREE.DoubleSide, alphaTest: far ? 0.4 : 0.36, roughness: 0.75, metalness: 0,
    envMapIntensity: 0.2, fog: true,
  });
  if (!far) { m.normalMap = TEX.nrm; m.normalScale.set(1, 1); }
  m.alphaToCoverage = true;
  const farMask = { get value(): THREE.Texture { return TEX.farMask; } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFade = { value: fade };
    sh.uniforms.uFarMask = farMask;
    sh.uniforms.uFarGain = FAR_GAIN;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uFade; varying float vFade;
        ${far ? 'attribute vec4 aImp; attribute float aFade; attribute float aKind;' : 'attribute float leaf;'}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          {
            vec4 foot = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
            float dc = distance( foot.xz, cameraPosition.xz );
            ${far ? 'float fin = smoothstep( aFade - 10.0, aFade, dc ), fout = 1.0;' : 'float fin = smoothstep( uFade.x, uFade.y, dc ), fout = 1.0 - smoothstep( uFade.z, uFade.w, dc );'}
            // Negative on the way out. The level coming in keeps the pixels its dither value is under and the one going
            // out keeps the rest, so between them every pixel is drawn once: two dithers of the same sign leave holes.
            vFade = fout < 1.0 ? - fout : fin;
            // Out of its band: off the screen, so it costs no pixels (the shadow pass has its own shader and still draws it).
            if ( fin * fout <= 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
          }
        #else
          vFade = 1.0;
        #endif`);
    if (far) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          {
            // Two side views a kind in a 128 x 256 cell, sixteen cells a row; the views from above are below them.
            float slot = aImp.x * 2.0 + aKind;
            vec2 px = aKind > 1.5
              ? vec2( mod( aImp.x, 16.0 ) * 128.0 + 64.0 + position.x * 60.0, 1536.0 + floor( aImp.x / 16.0 ) * 128.0 + 64.0 + position.z * 60.0 )
              : vec2( mod( slot, 16.0 ) * 128.0 + 64.0 + ( aKind > 0.5 ? - position.z : position.x ) * 60.0, floor( slot / 16.0 ) * 256.0 + 252.0 - position.y * 248.0 );
            vMapUv = px / ${FAR_PX.toFixed(1)};
          }`)
        .replace('#include <beginnormal_vertex>', `vec3 objectNormal = aKind > 1.5 ? vec3( 0.0, 1.0, 0.0 ) : normalize( vec3( position.x * 0.8, position.y * 1.4 - 0.45, position.z * 0.8 ) );`)
        .replace('#include <begin_vertex>', `vec3 transformed = vec3( position.x * aImp.y, aKind > 1.5 ? aImp.w : position.y * aImp.z, position.z * aImp.y );`);
    } else {
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          if ( leaf < 0.75 ) vColor.xyz = color.xyz;
        #endif`);
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vFade; uniform sampler2D uFarMask; uniform float uFarGain;
        float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }`)
      .replace('#include <map_fragment>', `
        {
          float dn = ign( gl_FragCoord.xy ), df = abs( vFade );
          if ( df < 0.999 && df <= ( vFade < 0.0 ? 1.0 - dn : dn ) ) discard;
        }
        #include <map_fragment>
        float isLeaf = ${far ? 'texture2D( uFarMask, vMapUv ).g' : `step( ${BARK_V.toFixed(4)}, vMapUv.y )`};
        {
          // A leaf's alpha averages away as the mip level climbs; give it back, or far crowns go thin and sparkle.
          vec2 tx = vMapUv * ${far ? `vec2( ${FAR_PX.toFixed(1)} )` : `vec2( ${AW.toFixed(1)}, ${AH.toFixed(1)} )`};
          vec2 ddx = dFdx( tx ), ddy = dFdy( tx );
          float lod = max( 0.0, 0.5 * log2( max( dot( ddx, ddx ), dot( ddy, ddy ) ) ) );
          diffuseColor.a *= 1.0 + 0.25 * lod;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix( 0.94, 0.7, isLeaf );`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/float faceDirection = [^;]+;/, 'float faceDirection = 1.0;'))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          {
            // Light through the leaves: strongest looking toward the sun, and on the side of the crown turned from it.
            vec3 sunDir = directionalLights[ 0 ].direction;
            float back = pow( max( dot( geometryViewDir, - sunDir ), 0.0 ), 3.0 );
            float thru = back * ( 0.3 + 0.7 * max( - dot( normal, sunDir ), 0.0 ) );
            reflectedLight.directDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * vec3( 1.0, 1.0, 0.42 ) * ( RECIPROCAL_PI * 1.5 * thru * isLeaf );
          }
        #endif`);
    if (far) {
      // Only the leaves take the tree's tint; the mask's green channel says which texels they are.
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          diffuseColor.rgb *= mix( vec3( 1.0 ), vColor, isLeaf );
        #endif
        // A card has no crown in front of it to shade it, so it comes out lighter than the model it stands for: the
        // difference, measured where the two are dithered together.
        diffuseColor.rgb *= uFarGain;`);
    }
  };
  m.customProgramCacheKey = () => (far ? 'flora-far' : 'flora');
  made.push({ m, far });
  return m;
}

let shared: THREE.MeshStandardMaterial | null = null;

/** The plain flora material (ground cover uses it). Vertex colours on; an instance colour tints the leaves and leaves the bark alone. */
export function floraMaterial(): THREE.MeshStandardMaterial {
  if (!shared) {
    shared = makeMaterial(NO_FADE, false);
    void loadPictures();
  }
  return shared;
}

/** Every flora material reflects the same sky. */
export function floraEnv(env: THREE.Texture | null): void {
  for (const v of made) if (v.m.envMap !== env) v.m.envMap = env;
}

let picturesAsked: Promise<boolean> | null = null;

function loadPictures(): Promise<boolean> {
  if (picturesAsked) return picturesAsked;
  picturesAsked = (async () => {
    try {
      const [col, mask, nrm, far, farMask] = await Promise.all(
        ['flora_atlas', 'flora_mask', 'flora_nrm', 'flora_far', 'flora_far_mask'].map((n) => pixels(`models/${n}.webp`)));
      if (!col || !mask || col.w !== mask.w || col.h !== mask.h) return false;
      TEX.map = picture(col, mask, true);
      if (nrm) TEX.nrm = picture(nrm, null, false);
      if (far && farMask && far.w === farMask.w) { TEX.far = picture(far, farMask, true); TEX.farMask = picture(farMask, null, false); }
      for (const v of made) {
        v.m.map = v.far ? TEX.far : TEX.map;
        if (!v.far) v.m.normalMap = TEX.nrm;
      }
      return true;
    } catch (e) {
      console.warn('the flora pictures did not load', e);
      return false;
    }
  })();
  return picturesAsked;
}

// ── The file ─────────────────────────────────────────────────────────────────

/** Plain arrays: 3 position, 3 normal, 2 uv, 4 colour (r, g, b, leaf) a vertex. */
interface Raw { n: number; p: Float32Array; nr: Float32Array; uv: Float32Array; c: Float32Array; idx: Uint32Array }
interface KindInfo { cell: number; hw?: number; h?: number; cb?: number; yc?: number; ms: number; mk: number }
export interface FloraFile {
  wood: Map<string, Raw>;
  /** Per kind, ten numbers a tip: where, which way, scale, roll, occlusion, template. */
  tips: Map<string, Float32Array>;
  tpl: Raw[][];
  kinds: Record<string, KindInfo>;
  /** How many variants there are of each base name (`oak` -> 3). */
  variants: Map<string, number>;
}

function raw(mesh: THREE.Mesh): Raw | null {
  const g = mesh.geometry, p = g.getAttribute('position'), nm = g.getAttribute('normal'), uv = g.getAttribute('uv'), c = g.getAttribute('color');
  if (!p || !uv || !g.index) return null;
  const n = p.count, out: Raw = { n, p: new Float32Array(n * 3), nr: new Float32Array(n * 3), uv: new Float32Array(n * 2), c: new Float32Array(n * 4), idx: Uint32Array.from(g.index.array) };
  const t = mesh.position, s = mesh.scale;
  for (let i = 0; i < n; i++) {
    // getX undoes the normalisation the exporter packs everything in; the node carries the box the positions were packed into.
    out.p[i * 3] = p.getX(i) * s.x + t.x; out.p[i * 3 + 1] = p.getY(i) * s.y + t.y; out.p[i * 3 + 2] = p.getZ(i) * s.z + t.z;
    if (nm) { out.nr[i * 3] = nm.getX(i); out.nr[i * 3 + 1] = nm.getY(i); out.nr[i * 3 + 2] = nm.getZ(i); } else out.nr[i * 3 + 1] = 1;
    out.uv[i * 2] = uv.getX(i); out.uv[i * 2 + 1] = uv.getY(i);
    out.c[i * 4] = c ? c.getX(i) : 1; out.c[i * 4 + 1] = c ? c.getY(i) : 1; out.c[i * 4 + 2] = c ? c.getZ(i) : 1; out.c[i * 4 + 3] = c && c.itemSize > 3 ? c.getW(i) : 0;
  }
  return out;
}

/** The models and their pictures. Null if anything is missing or broken; never throws, never logs an error. */
export async function loadFlora(): Promise<FloraFile | null> {
  try {
    const [res, pics] = await Promise.all([fetch('models/flora2.glb'), loadPictures()]);
    if (!res.ok || !pics) return null;
    const buf = await res.arrayBuffer();
    // "glTF". The dev server answers a missing file with the index page.
    if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const extras = (gltf.asset as { extras?: { kinds?: Record<string, KindInfo> } }).extras;
    if (!extras?.kinds) return null;
    const file: FloraFile = { wood: new Map(), tips: new Map(), tpl: [], kinds: extras.kinds, variants: new Map() };
    gltf.scene.traverse((o) => {
      const pts = o as THREE.Points, mesh = o as THREE.Mesh;
      if (pts.isPoints) {
        const g = pts.geometry, p = g.getAttribute('position'), d = g.getAttribute('normal'), c = g.getAttribute('color');
        if (!p || !d || !c) return;
        const a = new Float32Array(p.count * 10);
        for (let i = 0; i < p.count; i++) a.set([p.getX(i), p.getY(i), p.getZ(i), d.getX(i), d.getY(i), d.getZ(i), c.getX(i), c.getY(i), c.getZ(i), c.getW(i)], i * 10);
        file.tips.set(o.name.replace(/_t$/, ''), a);
        g.dispose();
      } else if (mesh.isMesh) {
        const r = raw(mesh);
        mesh.geometry.dispose();
        if (!r) return;
        const t = /^tpl(\d+)_L(\d)$/.exec(o.name);
        if (t) (file.tpl[+t[1]] ??= [])[+t[2]] = r;
        else file.wood.set(o.name, r);
      }
    });
    for (const k of Object.keys(file.kinds)) {
      const b = k.replace(/\d+$/, '');
      file.variants.set(b, (file.variants.get(b) ?? 0) + 1);
    }
    return file.wood.size ? file : null;
  } catch (e) {
    console.warn('models/flora2.glb did not load; keeping the simple trees', e);
    return null;
  }
}

/** One kind at one level of detail, whole: its wood, and its template set at every tip. flora.py's expand() is the same sum. */
function assemble(file: FloraFile, kind: string, lod: 0 | 1): THREE.BufferGeometry | null {
  const wood = file.wood.get(`${kind}_w${lod}`), tips = file.tips.get(kind), info = file.kinds[kind];
  if (!wood || !info) return null;
  const step = lod ? info.ms : 1, scale = lod ? info.mk : 1, nt = tips ? tips.length / 10 : 0;
  let nv = wood.n, ni = wood.idx.length;
  for (let i = 0; i < nt; i += step) { const t = file.tpl[tips![i * 10 + 9] | 0]?.[lod]; if (t) { nv += t.n; ni += t.idx.length; } }
  const pos = new Float32Array(nv * 3), nor = new Int8Array(nv * 3), uv = new Uint16Array(nv * 2), col = new Uint8Array(nv * 3), leaf = new Uint8Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const put = (v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, r: number, g: number, b: number, lf: number): void => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    const l = Math.hypot(nx, ny, nz) || 1;
    nor[v * 3] = Math.round((nx / l) * 127); nor[v * 3 + 1] = Math.round((ny / l) * 127); nor[v * 3 + 2] = Math.round((nz / l) * 127);
    uv[v * 2] = Math.round(u * 65535); uv[v * 2 + 1] = Math.round(w * 65535);
    col[v * 3] = Math.min(255, r * 255); col[v * 3 + 1] = Math.min(255, g * 255); col[v * 3 + 2] = Math.min(255, b * 255);
    leaf[v] = lf * 255;
  };
  for (let i = 0; i < wood.n; i++) {
    put(i, wood.p[i * 3], wood.p[i * 3 + 1], wood.p[i * 3 + 2], wood.nr[i * 3], wood.nr[i * 3 + 1], wood.nr[i * 3 + 2], wood.uv[i * 2], wood.uv[i * 2 + 1], wood.c[i * 4], wood.c[i * 4 + 1], wood.c[i * 4 + 2], wood.c[i * 4 + 3]);
  }
  idx.set(wood.idx, 0);
  let v0 = wood.n, i0 = wood.idx.length;
  if (tips && nt) {
    // The crown, as the box its tips fill: a leaf's normal leans out from the middle of it.
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = 0; i < nt; i++) {
      const x = tips[i * 10], y = tips[i * 10 + 1], z = tips[i * 10 + 2];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const rx = Math.max(0.4, (x1 - x0) / 2), ry = Math.max(0.4, (y1 - y0) / 2), rz = Math.max(0.4, (z1 - z0) / 2);
    const palm = /^(palm|date)/.test(kind);
    for (let i = 0; i < nt; i += step) {
      const o = i * 10, t = file.tpl[tips[o + 9] | 0]?.[lod];
      if (!t) continue;
      const px = tips[o], py = tips[o + 1], pz = tips[o + 2], dx = tips[o + 3], dy = tips[o + 4], dz = tips[o + 5];
      const s = tips[o + 6] * scale, roll = tips[o + 7], ao = tips[o + 8];
      // side = d x up, or +x when the tip points straight up; up = side x d.
      let sx = -dz, sy = 0, sz = dx;
      const sl = Math.hypot(sx, sz);
      if (sl < 1e-3) { sx = 1; sz = 0; } else { sx /= sl; sz /= sl; }
      const ux = sy * dz - sz * dy, uy = sz * dx - sx * dz, uz = sx * dy - sy * dx;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const ax = sx * cr + ux * sr, ay = sy * cr + uy * sr, az = sz * cr + uz * sr;
      const bx = ux * cr - sx * sr, by = uy * cr - sy * sr, bz = uz * cr - sz * sr;
      for (let k = 0; k < t.n; k++) {
        const qx = t.p[k * 3], qy = t.p[k * 3 + 1], qz = t.p[k * 3 + 2];
        const x = px + (ax * qx + dx * qy + bx * qz) * s, y = py + (ay * qx + dy * qy + by * qz) * s, z = pz + (az * qx + dz * qy + bz * qz) * s;
        const mx = t.nr[k * 3], my = t.nr[k * 3 + 1], mz = t.nr[k * 3 + 2];
        let nx = ax * mx + dx * my + bx * mz, ny = ay * mx + dy * my + by * mz, nz = az * mx + dz * my + bz * mz;
        const lf = t.c[k * 4 + 3];
        if (lf > 0.25) {
          let ox = (x - cx) / rx, oy = (y - cy) / ry + 0.35, oz = (z - cz) / rz;
          const ol = Math.hypot(ox, oy, oz) || 1;
          ox /= ol; oy /= ol; oz /= ol;
          // The card's own normal, turned to whichever side faces out of the crown (a frond: to the sky).
          const flip = (palm ? ny : nx * ox + ny * oy + nz * oz) < 0 ? -1 : 1, own = palm ? 0.8 : 0.45, crown = palm ? 0.35 : 0.8;
          nx = nx * flip * own + (palm ? 0 : ox) * crown; ny = ny * flip * own + (palm ? 1 : oy) * crown; nz = nz * flip * own + (palm ? 0 : oz) * crown;
        }
        put(v0 + k, x, y, z, nx, ny, nz, t.uv[k * 2], t.uv[k * 2 + 1], t.c[k * 4] * ao, t.c[k * 4 + 1] * ao, t.c[k * 4 + 2] * ao, lf);
      }
      for (let k = 0; k < t.idx.length; k++) idx[i0 + k] = t.idx[k] + v0;
      v0 += t.n; i0 += t.idx.length;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2, true));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.setAttribute('leaf', new THREE.BufferAttribute(leaf, 1, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** Two upright cards crossed and one lying flat, all of unit size: the impostor's shader gives them their tree. */
function impostorGeo(): THREE.BufferGeometry {
  const p: number[] = [], k: number[] = [], idx: number[] = [];
  const quad = (kind: number, v: number[][]): void => {
    const b = p.length / 3;
    for (const q of v) { p.push(q[0], q[1], q[2]); k.push(kind); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad(0, [[-1, 0, 0], [1, 0, 0], [1, 1, 0], [-1, 1, 0]]);
  quad(1, [[0, 0, -1], [0, 0, 1], [0, 1, 1], [0, 1, -1]]);
  quad(2, [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((p.length / 3) * 2), 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(k, 1));
  g.setIndex(idx);
  return g;
}

// ── Drawing them ─────────────────────────────────────────────────────────────

/** Everything planted: a kind per entry (`oak`, `palmtrunk`, or one variant by name, `oak2`), 16 matrix numbers and 3 colour numbers each. */
export interface Planting { kind: string[]; m: number[]; c: number[] }

interface Kind {
  n: number; m: Float32Array; c: Float32Array;
  near: THREE.InstancedMesh | null; mid: THREE.InstancedMesh | null;
  /** Impostor cell, half width, height, height of the cap; null if the kind has none and simply stops at `cut`. */
  imp: [number, number, number, number] | null;
  N: number; M: number; cut: number;
  /** The middle model stays in its mesh out to here, for its shadow. */
  cast: number;
}

/**
 * Where the full model gives way to the middle one, that to the impostor, and how far out a tree still throws a
 * shadow; then the same for shrubs and hedges. The middle model is most of what trees cost (about 1.2 of 1.8 ms
 * in Gull Heights, a third of it the shadow pass), so it hands over to the impostor before the shadow runs out,
 * and from there to the edge of the shadow it is in the shadow pass only.
 */
const RANGE = { tree: [26, 60, 78], small: [13, 40, 46] } as const;
const BAND_N = 5, BAND_M = 10, PAD = 3.5;
const _p = new THREE.Vector3(), _d = new THREE.Vector3();

function upload(a: THREE.BufferAttribute, count: number): void {
  sendRange(a, count * a.itemSize);
}

export class TreeField {
  private kinds: Kind[] = [];
  private far: THREE.InstancedMesh | null = null;
  private farImp: THREE.InstancedBufferAttribute | null = null;
  private farFade: THREE.InstancedBufferAttribute | null = null;
  private last = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();

  constructor(parent: THREE.Object3D, file: FloraFile, plan: Planting, private drawDist: number) {
    // A planted `oak` is one of oak0, oak1, oak2: which one depends only on where it stands.
    const groups = new Map<string, number[]>();
    plan.kind.forEach((k, i) => {
      let name = k;
      if (!file.kinds[name]) {
        const nv = file.variants.get(k);
        if (!nv) return;
        const x = plan.m[i * 16 + 12], z = plan.m[i * 16 + 14];
        name = k + (Math.abs(Math.floor(x * 7.31 + z * 13.77)) % nv);
      }
      let g = groups.get(name);
      if (!g) groups.set(name, (g = []));
      g.push(i);
    });
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const mat = (key: string, f: [number, number, number, number]): THREE.MeshStandardMaterial => {
      let m = mats.get(key);
      if (!m) mats.set(key, (m = makeMaterial(new THREE.Vector4(f[0], f[1], f[2], f[3]), false)));
      return m;
    };
    let farCount = 0;
    for (const [name, idx] of groups) {
      const info = file.kinds[name];
      const small = /^(shrub|hedge)/.test(name);
      const [N, M, S] = small ? RANGE.small : RANGE.tree;
      const g0 = assemble(file, name, 0), g1 = assemble(file, name, 1);
      if (!g0 || !g1) continue;
      const n = idx.length, m = new Float32Array(n * 16), c = new Float32Array(n * 3);
      idx.forEach((src, i) => {
        for (let k = 0; k < 16; k++) m[i * 16 + k] = plan.m[src * 16 + k];
        for (let k = 0; k < 3; k++) c[i * 3 + k] = plan.c[src * 3 + k];
      });
      const imp: Kind['imp'] = info.cell >= 0 && info.hw && info.h ? [info.cell, info.hw, info.h, (info.yc ?? 0.6) * info.h] : null;
      // A hedge has no impostor: its middle model carries on to where a hedge is a line a pixel high.
      const cut = imp ? M : 130;
      const tag = small ? 's' : 't';
      const mk = (g: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, cast: boolean): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(g, material, n);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        flip.mesh(mesh, true);
        mesh.castShadow = cast; mesh.receiveShadow = true;
        mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
        mesh.count = 0; mesh.visible = false;
        parent.add(mesh);
        return mesh;
      };
      const near = mk(g0, mat('n' + tag, [-2, -1, N - BAND_N, N]), false);
      const mid = mk(g1, mat('m' + tag + (imp ? '' : 'x'), [N - BAND_N, N, cut - BAND_M, cut]), true);
      this.kinds.push({ n, m, c, near, mid, imp, N, M, cut, cast: Math.max(cut, S) });
      if (imp) farCount += n;
    }
    if (farCount) {
      const g = impostorGeo();
      this.farImp = new THREE.InstancedBufferAttribute(new Float32Array(farCount * 4), 4).setUsage(THREE.DynamicDrawUsage);
      this.farFade = new THREE.InstancedBufferAttribute(new Float32Array(farCount), 1).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aImp', this.farImp); g.setAttribute('aFade', this.farFade);
      const mesh = new THREE.InstancedMesh(g, makeMaterial(NO_FADE, true), farCount);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(farCount * 3), 3);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      flip.mesh(mesh, true); flip.geo(g, 'aImp'); flip.geo(g, 'aFade');
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.count = 0; mesh.visible = false;
      parent.add(mesh);
      this.far = mesh;
    }
  }

  /** Sort every tree into its levels for this camera. Does nothing until the camera has moved or turned enough to matter. */
  update(cam: THREE.PerspectiveCamera): void {
    cam.getWorldPosition(_p); cam.getWorldDirection(_d);
    if (_p.distanceToSquared(this.last) < 9 && _d.dot(this.lastDir) > 0.995) return;
    this.last.copy(_p); this.lastDir.copy(_d);
    const hl = Math.hypot(_d.x, _d.z), cone = hl > 0.55;
    const fx = _d.x / (hl || 1), fz = _d.z / (hl || 1);
    // Half the horizontal view, plus the turn allowed before the next refill and the width of a crown.
    const half = Math.min(1.5, Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect) + 0.22);
    const cos2 = Math.cos(half) ** 2, F2 = this.drawDist * this.drawDist;
    const far = this.far, fm = far ? (far.instanceMatrix.array as Float32Array) : null, fc = far ? (far.instanceColor!.array as Float32Array) : null;
    const fi = this.farImp ? (this.farImp.array as Float32Array) : null, ff = this.farFade ? (this.farFade.array as Float32Array) : null;
    // Each buffer is sent only if this refill changed it (bit 1 the matrices, 2 the colours, 4 and 8 the impostor's own).
    let nf = 0, chF = 0;
    for (const k of this.kinds) {
      let nn = 0, nm = 0, chN = 0, chM = 0;
      const nearM = k.near ? (k.near.instanceMatrix.array as Float32Array) : null, nearC = k.near ? (k.near.instanceColor!.array as Float32Array) : null;
      const midM = k.mid ? (k.mid.instanceMatrix.array as Float32Array) : null, midC = k.mid ? (k.mid.instanceColor!.array as Float32Array) : null;
      const N2 = (k.N + PAD) ** 2, M2 = (k.cast + PAD) ** 2, I2 = k.imp ? Math.max(0, k.M - BAND_M - PAD) ** 2 : Infinity;
      for (let i = 0; i < k.n; i++) {
        const dx = k.m[i * 16 + 12] - _p.x, dz = k.m[i * 16 + 14] - _p.z, d2 = dx * dx + dz * dz;
        if (d2 > M2 && (d2 < I2 || d2 > F2)) continue;
        // Behind the camera or off to the side (a crown's width of slack close up, where the cone is narrow).
        let seen = true;
        if (cone && d2 > 196) { const dot = dx * fx + dz * fz; seen = dot > 0 && dot * dot > cos2 * d2; }
        const mo = i * 16, co = i * 3;
        // The full model casts no shadow, so it need not be drawn unseen. The middle one does, so it must.
        if (d2 < N2 && seen && nearM) { if (putChanged(nearM, nn * 16, k.m, mo, 16)) chN |= 1; if (putChanged(nearC!, nn * 3, k.c, co, 3)) chN |= 2; nn++; }
        if (d2 < M2 && midM) { if (putChanged(midM, nm * 16, k.m, mo, 16)) chM |= 1; if (putChanged(midC!, nm * 3, k.c, co, 3)) chM |= 2; nm++; }
        if (d2 > I2 && d2 <= F2 && seen && fm && k.imp) {
          if (putChanged(fm, nf * 16, k.m, mo, 16)) chF |= 1;
          if (putChanged(fc!, nf * 3, k.c, co, 3)) chF |= 2;
          for (let j = 0; j < 4; j++) { const at = nf * 4 + j, was = fi![at]; fi![at] = k.imp[j]; if (fi![at] !== was) chF |= 4; }
          if (ff![nf] !== k.M) { ff![nf] = k.M; chF |= 8; }
          nf++;
        }
      }
      for (const [mesh, cnt, ch] of [[k.near, nn, chN], [k.mid, nm, chM]] as const) {
        if (!mesh) continue;
        mesh.count = cnt; mesh.visible = cnt > 0;
        if (cnt && ch & 1) upload(mesh.instanceMatrix, cnt);
        if (cnt && ch & 2) upload(mesh.instanceColor!, cnt);
      }
    }
    if (far) {
      far.count = nf; far.visible = nf > 0;
      if (nf && chF & 1) upload(far.instanceMatrix, nf);
      if (nf && chF & 2) upload(far.instanceColor!, nf);
      if (nf && chF & 4) upload(this.farImp!, nf);
      if (nf && chF & 8) upload(this.farFade!, nf);
    }
  }
}

// ── Asked for by other builders ──────────────────────────────────────────────

/** Plantings other builders ask for (places.ts runs after the ground is built). ground.ts adds them to its own when the models arrive. */
export const EXTRA: Planting = { kind: [], m: [], c: [] };
const _xm = new THREE.Matrix4(), _xq = new THREE.Quaternion(), _xe = new THREE.Euler(), _xs = new THREE.Vector3(), _xc = new THREE.Color();

/**
 * Ask for one model of `kind` standing at a spot. Kinds: plane, maple, oak, cherry, cypress, pine, spruce, birch,
 * sugarmaple, redoak, elm, shrub, hedge, hedgeloose, palmtrunk + palmcrown (fan palm, 8 m trunk), datetrunk +
 * datecrown (4 m trunk). A bare name picks one of its variants by position; `oak2` names one.
 */
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

  /** One card lying on the ground (fallen leaves), `size` square. */
  flat(x: number, y: number, z: number, cell: Rect4, size: number, heading: number, shade = 1): void {
    const R = this.region, key = (Math.floor(x / R) + 64) * 256 + Math.floor(z / R) + 64;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { p: [], u: [], c: [] }));
    const c = (Math.cos(heading) * size) / 2, s = (Math.sin(heading) * size) / 2;
    b.p.push(x - c + s, y, z - s - c, x + c + s, y, z + s - c, x + c - s, y, z + s + c, x - c - s, y, z - s + c);
    b.u.push(cell[0], cell[3], cell[2], cell[3], cell[2], cell[1], cell[0], cell[1]);
    for (let k = 0; k < 12; k++) b.c.push(shade);
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
