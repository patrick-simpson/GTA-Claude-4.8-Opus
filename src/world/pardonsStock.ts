// Pardon's Surplus & Salvage, store unit 2: the sales floor stocked, lit and peopled.
//
// The layout and the fixture kit come from tools/blender/buildings.py `-- --stock` (its header has the contract):
//   models/pardons_stock.json  fixtures [kit, x, z, rot, dept] and gondola runs [x, z0, z1, dept, height], store frame
//   models/pardons_kit.glb     one mesh per fixture (gondolas, endcaps, racks, furniture, roll racks, carts, registers)
//   models/pardons_lm.webp     the floor light baked in Cycles: R the floor with its contact shadows, G the open room
// The goods on the shelves are built here: a few unit shapes (box, can, bottle, bag, blister card, garment, roll,
// sign) instanced by department, each instance picking one cell of a packaging atlas drawn here on a canvas (invented
// brands only). Everything inside is unlit (MeshBasicMaterial) with its light read from the baked map by world
// position, so the whole interior costs no lights and nothing at all once the interior group is hidden.
// The floor adds a glossy reflection of the troffer grid worked out in the shader (no reflection pass).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { assets } from '../core/assets';
import { loadKtx } from '../core/ktx';
import { RNG } from '../core/util';
import { CORRALS, PD, pdRect } from './pardonsSite';

type Fx = [string, number, number, number, number];
type Run = [number, number, number, number, number];
interface StockFile { fx: Fx[]; runs: Run[]; depts: string[] }

function rnd(seed: number): () => number { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── Baked light, shared by every interior material ─────────────────────────────
export const LM = {
  uLm: { value: null as THREE.Texture | null },
  uLmT: { value: new THREE.Vector4(PD.XE, PD.ZF, 1 / PD.SW, 1 / (PD.SD + PD.SBZ)) },
  uLmY: { value: 0 },
  uLmK: { value: 1.0 },
  uGloss: { value: 1.0 },
  /** Floor wear in the store frame (same mapping as uLm): R the worn traffic paths, G scuffs and cart-wheel marks. */
  uWear: { value: null as THREE.Texture | null },
};
const W_LIGHT = new THREE.DataTexture(new Uint8Array([200, 200, 0, 255]), 1, 1);
W_LIGHT.needsUpdate = true;
LM.uLm.value = W_LIGHT;
const NO_WEAR = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
NO_WEAR.needsUpdate = true;
LM.uWear.value = NO_WEAR;

/**
 * Make an unlit material read the baked light: 'floor' (R, a pool under each troffer, the worn paths and scuffs, and the
 * troffers' reflection), 'obj' (G, darker low down: fixtures, goods, the walls) or 'ceil' (B, the ceiling's own light).
 */
export function bakedLight<T extends THREE.MeshBasicMaterial>(mat: T, kind: 'floor' | 'obj' | 'ceil', atlas: boolean | 'tray' = false): T {
  mat.defines = { ...(mat.defines ?? {}), ...(kind === 'floor' ? { LM_FLOOR: '' } : {}), ...(kind === 'ceil' ? { LM_CEIL: '' } : {}), ...(atlas ? { USE_ATLAS: '' } : {}), ...(atlas === 'tray' ? { USE_TRAY: '' } : {}) };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, LM);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform vec4 uLmT; varying vec2 vLmUv; varying vec3 vLmW;
#ifdef USE_ATLAS
attribute vec2 aCell;
#endif
#ifdef USE_TRAY
attribute vec4 aRep; varying vec4 vTrU; varying vec2 vTrC;
#endif`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_ATLAS
vMapUv = (aCell + uv * 0.94 + 0.03) / 16.0;
#endif
#ifdef USE_TRAY
vTrU = vec4(uv * aRep.xy, aRep.zw); vTrC = aCell;
#endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 lw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
lw = instanceMatrix * lw;
#endif
lw = modelMatrix * lw; vLmW = lw.xyz; vLmUv = vec2((uLmT.x - lw.x) * uLmT.z, (uLmT.y - lw.z + 62.0) * uLmT.w); }`);
    if (atlas === 'tray') sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vTrU; varying vec2 vTrC;`)
      .replace('#include <map_fragment>', `{ // a row of facings: the cell repeated along the tray and up its stack, mip level from the unbroken coordinates
  vec2 f = vec2(vTrU.z + fract(vTrU.x) * vTrU.w, fract(vTrU.y));
  vec2 k = vec2(vTrU.w * 0.94 / 16.0, 0.94 / 16.0);
  diffuseColor *= textureGrad(map, (vTrC + f * 0.94 + 0.03) / 16.0, dFdx(vTrU.xy) * k, dFdy(vTrU.xy) * k);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uLm; uniform sampler2D uWear; uniform vec4 uLmT; uniform float uLmY; uniform float uLmK; uniform float uGloss; varying vec2 vLmUv; varying vec3 vLmW;`)
      .replace('#include <opaque_fragment>', `{ vec3 lm = texture2D(uLm, clamp(vLmUv, 0.001, 0.999)).rgb;
#ifdef LM_FLOOR
  vec2 sp = vec2(uLmT.x - vLmW.x, uLmT.y - vLmW.z);
  vec2 gp = vec2(mod(sp.x - 0.6, 3.6) - 1.8, mod(sp.y + 12.0, 2.4) - 1.2);
  float pool = exp(-dot(gp, gp) / 2.2) * step(sp.y, -9.6);
  vec3 wear = texture2D(uWear, vLmUv).rgb;
  float lit = pow(lm.r * 2.0, 1.45) * (0.8 + 0.38 * pool);
  outgoingLight *= lit * uLmK * (1.0 - 0.16 * wear.r) * (1.0 - 0.5 * wear.g);
  outgoingLight *= mix(vec3(1.0), vec3(0.97, 0.95, 0.9), wear.r);
  vec3 V = normalize(vLmW - cameraPosition);
  float t = (uLmY + 4.29 - vLmW.y) / max(-V.y, 0.04);
  vec2 hit = vLmW.xz + V.xz * t;
  vec2 s = vec2(uLmT.x - hit.x, uLmT.y - hit.y);
  vec2 g = vec2(mod(s.x - 0.6, 3.6) - 1.8, mod(s.y + 12.0, 2.4) - 1.2);
  float b = 0.05 + 0.025 * t;
  float tro = (1.0 - smoothstep(0.3 - b, 0.3 + b, abs(g.x))) * (1.0 - smoothstep(0.6 - b, 0.6 + b, abs(g.y)));
  tro *= step(s.y, -10.0) * step(-61.0, s.y) * step(1.8, s.x) * step(s.x, 80.6);
  float fr = 0.025 + 0.5 * pow(1.0 - clamp(-V.y, 0.0, 1.0), 5.0);
  outgoingLight += (vec3(0.92, 0.94, 0.97) * tro * 1.5 + 0.08) * fr * uGloss * smoothstep(0.12, 0.42, lm.r) * (1.0 + 0.6 * wear.r);
#elif defined(LM_CEIL)
  float cb = (lm.b < 0.04 || vLmW.y - uLmY < 4.0) ? 0.5 : max(lm.b, 0.34);
  outgoingLight *= pow(cb * 2.0, 1.6) * uLmK * 0.97;
#else
  outgoingLight *= pow(lm.g * 2.0, 1.3) * uLmK * mix(0.7, 1.0, smoothstep(0.0, 1.9, vLmW.y - uLmY)) * mix(1.0, 0.86, smoothstep(2.6, 4.3, vLmW.y - uLmY));
#endif
}
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'pdlm-' + kind + (atlas ? '-a' + atlas : '');
  return mat;
}

// ── Floor wear: traffic paths and scuffs, 5 px a meter over the store frame ─────────
export function drawWear(runs: Run[]): THREE.CanvasTexture {
  const K = 5, W = Math.round(PD.SW * K), H = Math.round((PD.SD + PD.SBZ) * K);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const r = rnd(9127);
  const X = (x: number) => x * K, Y = (z: number) => (PD.SBZ - z) * K;
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  c.filter = 'blur(6px)';
  const path = (pts: [number, number][], w: number, a: number) => {
    c.strokeStyle = `rgba(255,0,0,${a})`; c.lineWidth = w * K; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); pts.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.stroke();
  };
  // The way in from both doors to the front aisle, the front aisle (action alley), the checkout lanes, the back aisle.
  path([[5, 1.4], [5.5, -4], [8, -10.2]], 2.2, 0.9); path([[18, 1.4], [18, -4], [16, -10.2]], 2.2, 0.9);
  path([[1.5, -10.3], [60, -10.3], [80, -10.6]], 2.6, 0.85);
  for (const lx of PD.LANES) path([[lx + 1.6, -1.6], [lx + 1.6, -8.5]], 0.9, 0.6);
  path([[2, -58.6], [80, -58.6]], 1.8, 0.45); path([[59.5, -10], [59.5, -58]], 2.0, 0.6); path([[46.5, -10], [46.5, -58]], 1.6, 0.45);
  const xs = new Set<number>();
  for (const [x, z0, z1] of runs) for (const ax of [x - 1.8, x + 1.8]) { const k = Math.round(ax * 10); if (xs.has(k)) continue; xs.add(k); path([[ax, Math.min(-10.5, z1 + 0.5)], [ax, z0 - 0.5]], 1.1, 0.35 + r() * 0.25); }
  c.filter = 'none';
  // Scuffs: short dark strokes (heels, cart wheels) thickest where the traffic is, and a few long wheel arcs.
  c.globalCompositeOperation = 'lighter';
  const img = c.getImageData(0, 0, W, H).data;
  for (let k = 0; k < 2600; k++) {
    const x = r() * W, y = r() * H, tr = img[(Math.floor(y) * W + Math.floor(x)) * 4] / 255;
    if (r() > 0.15 + tr) continue;
    c.strokeStyle = `rgba(0,${Math.round(40 + r() * 90)},0,${0.25 + r() * 0.4})`; c.lineWidth = 0.5 + r() * 1.2;
    const a = r() * Math.PI, l = 1 + r() * 4;
    c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a) * l, y + Math.sin(a) * l + (r() - 0.5) * 2, x + Math.cos(a) * l * 2, y + Math.sin(a) * l * 2); c.stroke();
  }
  for (let k = 0; k < 40; k++) {
    const x = X(2 + r() * 76), y = Y(-10 - r() * 46);
    c.strokeStyle = 'rgba(0,30,0,0.5)'; c.lineWidth = 0.7;
    c.beginPath(); c.arc(x, y, 8 + r() * 30, r() * 6, r() * 6 + 0.6 + r()); c.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
  return t;
}

// ── The packaging atlas: 16 x 16 cells of 128 px ──────────────────────────────
const N = 16, C = 128;
const ROW = { box: 0, can: 3, bag: 5, bottle: 6, hbabox: 7, carton: 8, card: 9, hw: 10, fabric: 11, cloth: 12, rug: 13, sign: 14, dept: 15 };
const BRANDS = ['Crunchwell', 'Oatsy', "Pip's", 'Larder Lane', 'Cozy Kettle', 'Brightbite', 'Honeyfield', "Wheatley's", 'Tidewater',
  'Hollis Farm', 'Maplewood', 'Ruddy Bear', 'Fizzbo', 'Pemberly', 'Sunny Acres', 'Hearthside', 'Lupine', 'Dockside', 'Nordic Nook', 'Granny Pratt'];
const HBA = ['Puritee', 'Softwell', 'Glimmer', 'Fresh Ayre', 'Dermaplain', 'Velvetine', 'Minty', 'Aquaria'];
const HW = ['Torqmaster', 'Ironbark', 'Gripwell', 'HandyPal', 'Boltco', 'Stoutline'];
const HOUSE = ['Hearth & Home', 'Kitchenry', 'Dwellwell', 'Cupboard Co'];
const DEPT_SIGNS = ['GROCERY', 'HEALTH & BEAUTY', 'HOUSEWARES', 'HARDWARE', 'CLOTHING', 'FABRIC', 'FURNITURE', 'FLOORING & RUGS'];
const SALE = [['$4.99', 'Compare at $12'], ['$1.29', 'WOW!'], ['$19.99', 'Compare at $49'], ['ALL RUGS', '40% OFF'], ['$2 YD', 'Fabric'],
  ['$7.99', 'NEW!'], ['AS IS', 'All sales final'], ['$299', 'Sofa'], ['$0.99', 'LIMIT 6'], ['$3.49', 'Compare at $8'], ['$12.99', "Pardon's Price"],
  ['$5 EA', 'Mix & Match'], ['HALF OFF', 'Marked price'], ['$149', 'Queen set'], ['$9.99', 'Lots of colors'], ['$0.50', 'Clearance']];
/** Garment colours as clothes come: navy, black, heather, white, maroon, olive, khaki, denim, forest, pastels, mustard. */
const APPAREL: [number, number, number][] = [[222, 38, 22], [0, 0, 11], [0, 0, 52], [40, 12, 88], [352, 40, 27], [78, 22, 32], [40, 28, 60],
  [214, 32, 40], [150, 26, 24], [340, 32, 76], [205, 34, 70], [45, 48, 50], [20, 22, 40], [0, 0, 30], [260, 18, 35], [10, 45, 48]];
const HAND = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
const HEAD = '"Arial Black", "Arial", sans-serif';

function drawAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = cv.height = N * C;
  const c = cv.getContext('2d')!;
  const r = rnd(4071);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;
  /** Draw in a virtual cell of the item's real aspect (width / height) so the lettering is not stretched. */
  const cell = (i: number, j: number, aspect: number, fn: (W: number, H: number) => void) => {
    c.save(); c.translate(i * C, j * C); c.beginPath(); c.rect(0, 0, C, C); c.clip();
    let W = C, H = C;
    if (aspect < 1) { W = C * aspect; c.scale(1 / aspect, 1); } else { H = C / aspect; c.scale(1, aspect); }
    fn(W, H); c.restore();
  };
  const text = (s: string, x: number, y: number, size: number, col: string, font = HEAD, maxW = 1e9, stroke?: string) => {
    c.font = `${size}px ${font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = c.measureText(s).width, k = w > maxW ? maxW / w : 1;
    c.save(); c.translate(x, y); c.scale(k, 1);
    if (stroke) { c.lineWidth = Math.max(1.5, size / 8); c.strokeStyle = stroke; c.strokeText(s, 0, 0); }
    c.fillStyle = col; c.fillText(s, 0, 0); c.restore();
  };
  const noise = (W: number, H: number, n: number, a: number) => { for (let k = 0; k < n; k++) { c.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${a})`; c.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2); } };
  // Boxes: cereal, crackers, pasta, snacks (front about 0.7 wide to 1 tall).
  for (let k = 0; k < 48; k++) cell(k % N, ROW.box + Math.floor(k / N), 0.7, (W, H) => {
    const h = r() * 360, bg = hsl(h, 55 + r() * 35, 35 + r() * 25);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    c.fillStyle = hsl(h + 180 * r(), 70, 55); c.fillRect(0, H * 0.06, W, H * 0.26);
    text(pick(BRANDS), W / 2, H * 0.19, 17, '#fff', HEAD, W - 8, 'rgba(0,0,0,0.5)');
    c.fillStyle = '#f6f3ea'; c.beginPath(); c.ellipse(W / 2, H * 0.62, W * 0.36, H * 0.15, 0, 0, 7); c.fill();
    const fc = hsl(20 + r() * 40, 70, 45 + r() * 20);
    for (let q = 0; q < 14; q++) { c.fillStyle = fc; c.beginPath(); c.arc(W / 2 + (r() - 0.5) * W * 0.5, H * 0.58 + (r() - 0.5) * H * 0.12, 3 + r() * 3, 0, 7); c.fill(); }
    text(pick(['Honey Oat', 'Frosted', 'Whole Grain', 'Cinnamon', 'Original', 'Rice Puffs', 'Elbows', 'Saltines', 'Corn Flakes']), W / 2, H * 0.4, 10, '#fff', 'Arial', W - 6);
    c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(4, H * 0.86, W * 0.45, 10);
    text('NET WT 12 OZ', 4 + W * 0.225, H * 0.86 + 5, 7, '#333', 'Arial', W * 0.43);
  });
  // Cans: a wrap label (about 2.3 wide to 1 tall), grey rims top and bottom.
  for (let k = 0; k < 32; k++) cell(k % N, ROW.can + Math.floor(k / N), 2.3, (W, H) => {
    const h = r() * 360;
    c.fillStyle = hsl(h, 60, 30 + r() * 30); c.fillRect(0, 0, W, H);
    c.fillStyle = '#f4f1e6'; c.beginPath(); c.ellipse(W * 0.5, H / 2, W * 0.17, H * 0.34, 0, 0, 7); c.fill();
    text(pick(BRANDS), W * 0.5, H * 0.42, 11, hsl(h, 70, 30), HEAD, W * 0.3);
    text(pick(['Green Beans', 'Sweet Corn', 'Tomatoes', 'Chick Peas', 'Soup', 'Peaches', 'Baked Beans', 'Tuna']), W * 0.5, H * 0.62, 8, '#333', 'Arial', W * 0.3);
    const fc = hsl(r() * 120, 70, 45);
    for (let q = 0; q < 6; q++) { c.fillStyle = fc; c.beginPath(); c.arc(W * ((q % 2 ? 0.74 : 0.08) + r() * 0.18), H * (0.3 + r() * 0.4), 4 + r() * 4, 0, 7); c.fill(); }
    c.fillStyle = '#b9bdc1'; c.fillRect(0, 0, W, H * 0.07); c.fillRect(0, H * 0.94, W, H * 0.06);
  });
  // Bags of chips and snacks (0.8 to 1).
  for (let k = 0; k < 16; k++) cell(k, ROW.bag, 0.8, (W, H) => {
    const h = r() * 360, g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, hsl(h, 80, 55)); g.addColorStop(1, hsl(h + 20, 80, 30));
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.25)'; for (let y = 0; y < H * 0.08; y += 3) c.fillRect(0, y, W, 1);
    c.fillStyle = hsl(h + 180, 80, 50); c.beginPath(); c.ellipse(W / 2, H * 0.32, W * 0.42, H * 0.13, -0.15, 0, 7); c.fill();
    text(pick(BRANDS), W / 2, H * 0.32, 15, '#fff', HEAD, W * 0.8, 'rgba(0,0,0,0.6)');
    for (let q = 0; q < 9; q++) { c.fillStyle = hsl(40 + r() * 15, 80, 60); c.beginPath(); c.ellipse(W * (0.25 + r() * 0.5), H * (0.6 + r() * 0.22), 9, 6, r() * 3, 0, 7); c.fill(); }
    text(pick(['Kettle Cooked', 'Cheese Curls', 'Pretzels', 'Popcorn', 'Tortilla']), W / 2, H * 0.9, 9, '#fff', 'Arial', W - 6);
  });
  // Bottles (shampoo, lotion, cleaner): cap colour in the top 16 %.
  for (let k = 0; k < 16; k++) cell(k, ROW.bottle, 0.45, (W, H) => {
    const h = r() * 360, pale = r() < 0.5;
    c.fillStyle = pale ? hsl(h, 40, 88) : hsl(h, 60, 45); c.fillRect(0, 0, W, H);
    c.fillStyle = r() < 0.5 ? '#f2f2f2' : hsl(h + 30, 50, 30); c.fillRect(0, 0, W, H * 0.16);
    c.fillStyle = '#fff'; c.fillRect(W * 0.1, H * 0.42, W * 0.8, H * 0.32);
    text(pick(HBA), W / 2, H * 0.52, 12, hsl(h, 60, 30), HEAD, W * 0.75);
    text(pick(['Shampoo', 'Lotion', 'Body Wash', 'Conditioner', 'All-Purpose']), W / 2, H * 0.65, 8, '#555', 'Arial', W * 0.75);
  });
  // Health and beauty boxes: toothpaste, soap, vitamins (1.3 to 1).
  for (let k = 0; k < 16; k++) cell(k, ROW.hbabox, 1.3, (W, H) => {
    const h = r() * 360;
    c.fillStyle = '#f7f7f4'; c.fillRect(0, 0, W, H);
    c.fillStyle = hsl(h, 70, 45); c.fillRect(0, 0, W * 0.38, H); c.fillRect(0, H * 0.78, W, H * 0.22);
    text(pick(HBA), W * 0.66, H * 0.38, 14, hsl(h, 70, 35), HEAD, W * 0.58);
    text(pick(['Toothpaste', 'Bar Soap', 'Vitamin C', 'Cotton Swabs', 'Bandages']), W * 0.66, H * 0.6, 9, '#444', 'Arial', W * 0.58);
  });
  // Housewares cartons with a drawing of what is inside (1.2 to 1).
  for (let k = 0; k < 16; k++) cell(k, ROW.carton, 1.2, (W, H) => {
    const kraft = r() < 0.5, h = r() * 360;
    c.fillStyle = kraft ? '#c39a6b' : '#f3f1ec'; c.fillRect(0, 0, W, H); noise(W, H, 300, 0.06);
    c.strokeStyle = kraft ? '#3b2a1a' : hsl(h, 60, 35); c.lineWidth = 3; c.fillStyle = kraft ? 'rgba(0,0,0,0)' : hsl(h, 50, 75);
    const t = k % 4;
    c.beginPath();
    if (t === 0) { c.rect(W * 0.2, H * 0.35, W * 0.4, H * 0.3); c.moveTo(W * 0.6, H * 0.42); c.lineTo(W * 0.75, H * 0.42); }
    else if (t === 1) { c.moveTo(W * 0.3, H * 0.6); c.lineTo(W * 0.5, H * 0.25); c.lineTo(W * 0.7, H * 0.6); c.closePath(); c.moveTo(W * 0.5, H * 0.6); c.lineTo(W * 0.5, H * 0.75); }
    else if (t === 2) { c.ellipse(W * 0.45, H * 0.5, W * 0.18, H * 0.18, 0, 0, 7); }
    else { c.rect(W * 0.25, H * 0.3, W * 0.3, H * 0.4); c.rect(W * 0.58, H * 0.4, W * 0.18, H * 0.3); }
    c.fill(); c.stroke();
    text(pick(HOUSE), W / 2, H * 0.14, 11, kraft ? '#2b1d10' : hsl(h, 60, 30), HEAD, W - 10);
    text(pick(['12-PC SET', 'NON-STICK', 'TABLE LAMP', 'STORAGE BINS', '4 MUGS', 'SHEET SET']), W / 2, H * 0.86, 10, kraft ? '#2b1d10' : '#333', 'Arial', W - 10);
  });
  // Blister cards: a coloured header with the hang hole, the product under clear plastic (0.65 to 1).
  for (let k = 0; k < 16; k++) cell(k, ROW.card, 0.65, (W, H) => {
    const h = [0, 210, 45, 120, 25][k % 5] + r() * 10;
    c.fillStyle = hsl(h, 75, 45); c.fillRect(0, 0, W, H);
    c.fillStyle = '#f2f2ef'; c.fillRect(W * 0.08, H * 0.3, W * 0.84, H * 0.62);
    c.fillStyle = '#222'; c.beginPath(); c.ellipse(W / 2, H * 0.07, 6, 3, 0, 0, 7); c.fill();
    text(pick(HW), W / 2, H * 0.19, 12, '#fff', HEAD, W - 8, 'rgba(0,0,0,0.4)');
    c.fillStyle = pick(['#555a60', '#f2c230', '#c43a2a', '#2b2b2b', '#8a8d91']);
    const t = k % 3;
    if (t === 0) { c.fillRect(W * 0.45, H * 0.36, W * 0.1, H * 0.3); c.fillRect(W * 0.4, H * 0.62, W * 0.2, H * 0.25); }
    else if (t === 1) { c.beginPath(); c.arc(W / 2, H * 0.6, W * 0.25, 0, 7); c.fill(); c.fillStyle = '#ddd'; c.beginPath(); c.arc(W / 2, H * 0.6, W * 0.08, 0, 7); c.fill(); }
    else for (let q = 0; q < 6; q++) c.fillRect(W * (0.2 + (q % 3) * 0.22), H * (0.4 + Math.floor(q / 3) * 0.22), W * 0.12, H * 0.16);
  });
  // Hardware: paint labels and tool boxes (1.3 to 1).
  for (let k = 0; k < 16; k++) cell(k, ROW.hw, 1.3, (W, H) => {
    if (k < 8) {
      c.fillStyle = '#f5f5f2'; c.fillRect(0, 0, W, H);
      c.fillStyle = hsl(r() * 360, 50, 40 + r() * 35); c.fillRect(0, H * 0.55, W, H * 0.3);
      text(pick(HW), W / 2, H * 0.22, 14, '#1f3f7a', HEAD, W - 10); text('INTERIOR SATIN', W / 2, H * 0.42, 8, '#333', 'Arial', W - 10);
      c.fillStyle = '#9da1a5'; c.fillRect(0, 0, W, H * 0.06);
    } else {
      c.fillStyle = pick(['#c4302b', '#e07b1a', '#f2c230', '#2b2d30', '#2f5a9e']); c.fillRect(0, 0, W, H);
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(0, H * 0.3, W, 4);
      text(pick(HW), W / 2, H * 0.62, 15, '#fff', HEAD, W - 10, 'rgba(0,0,0,0.5)');
      text(pick(['TOOL BOX', '120-PC KIT', 'DRILL', 'SHOP VAC']), W / 2, H * 0.85, 9, '#fff', 'Arial', W - 10);
    }
  });
  // Fabric patterns.
  const pattern = (W: number, H: number, k: number) => {
    const h = r() * 360, bg = hsl(h, 10 + r() * 24, 30 + r() * 45);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    const t = k % 6, fg = hsl(h + 30 + r() * 120, 18 + r() * 22, 40 + r() * 35);
    if (t === 0) for (let q = 0; q < 40; q++) { const x = r() * W, y = r() * H; c.fillStyle = fg; for (let p = 0; p < 5; p++) { c.beginPath(); c.arc(x + 4 * Math.cos(p * 1.26), y + 4 * Math.sin(p * 1.26), 3, 0, 7); c.fill(); } c.fillStyle = '#f4e27a'; c.beginPath(); c.arc(x, y, 2, 0, 7); c.fill(); }
    else if (t === 1) { c.fillStyle = fg; c.globalAlpha = 0.5; for (let x = 0; x < W; x += 24) { c.fillRect(x, 0, 10, H); } for (let y = 0; y < H; y += 24) c.fillRect(0, y, W, 10); c.globalAlpha = 1; }
    else if (t === 2) { c.fillStyle = fg; for (let x = 0; x < W; x += 16) c.fillRect(x, 0, 6, H); }
    else if (t === 3) { c.fillStyle = fg; for (let y = 6; y < H; y += 16) for (let x = (y % 32) / 2; x < W; x += 16) { c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.fill(); } }
    else if (t === 4) { c.fillStyle = fg; c.globalAlpha = 0.45; for (let x = 0; x < W; x += 12) { c.fillRect(x, 0, 6, H); c.fillRect(0, x, W, 6); } c.globalAlpha = 1; }
    else { noise(W, H, 900, 0.12); }
    noise(W, H, 400, 0.05);
  };
  for (let k = 0; k < 16; k++) cell(k, ROW.fabric, 1, (W, H) => pattern(W, H, k));
  // Clothing: solids, denim, flannel, stripes, prints.
  for (let k = 0; k < 16; k++) cell(k, ROW.cloth, 1, (W, H) => {
    const t = k % 8 > 4 ? 4 : k % 8;
    if (t === 0) { c.fillStyle = hsl(215, 45, 28 + r() * 15); c.fillRect(0, 0, W, H); c.strokeStyle = 'rgba(255,255,255,0.12)'; for (let x = -H; x < W; x += 3) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + H, H); c.stroke(); } }
    else if (t === 1) { pattern(W, H, 4); }
    else if (t === 2) { c.fillStyle = hsl(r() * 360, 12, 84); c.fillRect(0, 0, W, H); c.fillStyle = hsl(r() * 360, 30, 32); for (let y = 0; y < H; y += 14) c.fillRect(0, y, W, 4); }
    else if (t === 3) { pattern(W, H, 3); }
    else { const [a, b, l] = APPAREL[Math.floor(r() * APPAREL.length)]; c.fillStyle = hsl(a, b, l + (r() - 0.5) * 6); c.fillRect(0, 0, W, H); noise(W, H, 600, 0.05); c.fillStyle = 'rgba(0,0,0,0.06)'; for (let y = 0; y < H; y += 2) c.fillRect(0, y, W, 1); }
  });
  // Rugs (0-7) and flooring (8-15).
  for (let k = 0; k < 16; k++) cell(k, ROW.rug, 1, (W, H) => {
    if (k < 8) {
      const h = [0, 350, 20, 210, 30, 15, 200, 40][k];
      c.fillStyle = hsl(h, 38, 28); c.fillRect(0, 0, W, H);
      c.strokeStyle = hsl(h + 30, 50, 70); c.lineWidth = 5; c.strokeRect(8, 8, W - 16, H - 16);
      c.strokeStyle = hsl(h + 180, 40, 40); c.lineWidth = 3; c.strokeRect(16, 16, W - 32, H - 32);
      c.fillStyle = hsl(h + 30, 50, 65); c.beginPath(); c.moveTo(W / 2, 24); c.lineTo(W - 30, H / 2); c.lineTo(W / 2, H - 24); c.lineTo(30, H / 2); c.closePath(); c.fill();
      c.fillStyle = hsl(h, 55, 35); c.beginPath(); c.arc(W / 2, H / 2, 14, 0, 7); c.fill();
      noise(W, H, 900, 0.08);
    } else if (k < 12) {
      c.fillStyle = '#b08a5e'; c.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 21) { c.fillStyle = hsl(28 + r() * 8, 40, 38 + r() * 18); c.fillRect(0, y, W, 20); c.fillStyle = 'rgba(0,0,0,0.18)'; for (let q = 0; q < 6; q++) c.fillRect(0, y + r() * 20, W, 1); }
    } else { c.fillStyle = hsl([35, 30, 210, 0][k - 12], [20, 10, 25, 0][k - 12], [62, 45, 40, 55][k - 12]); c.fillRect(0, 0, W, H); noise(W, H, 2500, 0.1); }
  });
  // Hand-lettered sale signs (1.55 to 1): a printed red header, the price in marker.
  for (let k = 0; k < 16; k++) cell(k, ROW.sign, 1.55, (W, H) => {
    c.fillStyle = '#fbfaf5'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#cc2229'; c.fillRect(0, 0, W, H * 0.24);
    text("PARDON'S", W / 2, H * 0.12, 13, '#fff', HEAD, W - 10);
    const [a, b] = SALE[k];
    c.save(); c.translate(W / 2, H * 0.52); c.rotate((r() - 0.5) * 0.12);
    text(a, 0, 0, a.length > 6 ? 24 : 32, k % 3 === 2 ? '#1d3f8f' : '#cc2229', HAND, W - 12); c.restore();
    text(b, W / 2, H * 0.83, 12, '#222', HAND, W - 12);
  });
  // Department signs (4 to 1) and towels / linens.
  for (let k = 0; k < 16; k++) cell(k, ROW.dept, k < 8 ? 4 : 1, (W, H) => {
    if (k < 8) {
      c.fillStyle = '#cc2229'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#fff'; c.fillRect(0, 2, W, 2); c.fillRect(0, H - 4, W, 2);
      text(DEPT_SIGNS[k], W / 2, H / 2 + 1, H * 0.62, '#fff', HEAD, W - 10);
    } else {
      c.fillStyle = hsl(r() * 360, 35 + r() * 40, 45 + r() * 40); c.fillRect(0, 0, W, H); noise(W, H, 1600, 0.08);
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(0, H * 0.7, W, H * 0.06);
    }
  });
  return cv;
}

// ── Unit goods shapes, pivot at the bottom of the front face, front toward +z, uv over one cell ──
function geo(pos: number[], uv: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
type V3 = [number, number, number];
function quads(list: { p: V3[]; t: [number, number][] }[]): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  for (const { p, t } of list) for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...p[i]); uv.push(...t[i]); }
  return geo(pos, uv);
}
const FULL: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const STRIP: [number, number][] = [[0, 0], [0.12, 0], [0.12, 1], [0, 1]];
const TOP: [number, number][] = [[0, 0.9], [1, 0.9], [1, 1], [0, 1]];
/** Unit box x -0.5..0.5, y 0..1, z -1..0; no bottom or back. */
function boxGeo(pinch = 0): THREE.BufferGeometry {
  const t = 1 - pinch;
  return quads([
    { p: [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, -pinch * 0.5], [-0.5, 1, -pinch * 0.5]], t: FULL },
    { p: [[0.5, 0, 0], [0.5, 0, -1], [0.5, 1, -1 + pinch * 0.5], [0.5, 1, -pinch * 0.5]], t: STRIP },
    { p: [[-0.5, 0, -1], [-0.5, 0, 0], [-0.5, 1, -pinch * 0.5], [-0.5, 1, -1 + pinch * 0.5]], t: STRIP },
    { p: [[-0.5, 1, -pinch * 0.5], [0.5, 1, -pinch * 0.5], [0.5, 1, -1 + pinch * 0.5], [-0.5, 1, -1 + pinch * 0.5]], t: t < 1 ? TOP : TOP },
  ]);
}
/** Unit lathe (radius 0.5 at most, height 1) about the y axis, centre at z = -0.5; profile [r, y]. */
function latheGeo(profile: [number, number][], n: number): THREE.BufferGeometry {
  const list: { p: V3[]; t: [number, number][] }[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    for (let j = 0; j < profile.length - 1; j++) {
      const [r0, y0] = profile[j], [r1, y1] = profile[j + 1];
      const P = (r: number, a: number, y: number): V3 => [r * Math.sin(a + Math.PI), y, -0.5 + r * Math.cos(a + Math.PI)];
      list.push({ p: [P(r0, a0, y0), P(r0, a1, y0), P(r1, a1, y1), P(r1, a0, y1)], t: [[i / n, y0], [(i + 1) / n, y0], [(i + 1) / n, y1], [i / n, y1]] });
    }
  }
  const [rt, yt] = profile[profile.length - 1];
  const R = (i: number): V3 => { const a = (i / n) * Math.PI * 2; return [rt * Math.sin(a), yt, -0.5 + rt * Math.cos(a)]; };
  for (let i = 0; i < n; i += 2) list.push({ p: [[0, yt, -0.5], R(i), R(i + 1), R(i + 2)], t: [[0.5, 0.99], [0.5, 0.99], [0.5, 0.99], [0.5, 0.99]] });
  return quads(list);
}
/**
 * A garment draped on a hanger, with its own fold shading in the vertex colours (the goods are unlit): x -0.5..0.5
 * (shoulders), y -1..0 (hook at 0), z -0.5..0.5 (its thickness). A rounded body whose folds deepen toward the hem,
 * the shoulders sloping off the hanger, and sleeves hanging at the sides (long or short).
 */
function garmentGeo(long: boolean, NX = 8, NY = 5, NS = 3): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [];
  const ph = 0.7;
  const halfW = (v: number) => (v < 0.18 ? 0.47 - 0.6 * v : 0.362 + 0.06 * (v - 0.18));
  const P = (u: number, v: number, side: number): { p: V3; s: number } => {
    const a = 2 * u - 1, bulge = Math.sqrt(Math.max(0, 1 - a * a));
    const fold = Math.sin(Math.PI * 2 * 2.5 * u + ph) * Math.pow(v, 1.3);
    const yTop = -0.075 - 0.11 * Math.abs(a) * Math.min(1, Math.abs(a) * 1.4);
    const y = yTop + (-1 - yTop) * v + 0.025 * fold * v;          // the hem waves a little with the folds
    const x = a * halfW(v) + 0.02 * fold;
    const z = side * (0.5 * bulge * (0.55 + 0.45 * (1 - v * 0.5))) + 0.35 * fold * (side > 0 ? 1 : 0.6);
    const s = (0.84 + 0.16 * fold) * (0.78 + 0.22 * bulge) * (1 - 0.14 * v) * (side > 0 ? 1 : 0.92);
    return { p: [x, y, z], s };
  };
  const tri = (a: { p: V3; s: number }, b: { p: V3; s: number }, c: { p: V3; s: number }, ua: number[], ub: number[], uc: number[]) => {
    pos.push(...a.p, ...b.p, ...c.p); uv.push(...ua, ...ub, ...uc); col.push(a.s, a.s, a.s, b.s, b.s, b.s, c.s, c.s, c.s);
  };
  for (const side of [1, -1]) for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
    const u0 = i / NX, u1 = (i + 1) / NX, v0 = j / NY, v1 = (j + 1) / NY;
    const a = P(u0, v0, side), b = P(u1, v0, side), c = P(u1, v1, side), d = P(u0, v1, side);
    const T = (u: number, v: number) => [u, 1 - v * 0.97];
    tri(a, d, c, T(u0, v0), T(u0, v1), T(u1, v1)); tri(a, c, b, T(u0, v0), T(u1, v1), T(u1, v0));
  }
  // Sleeves: a flattened tube from the shoulder down the side, a little forward of the body's edge.
  const SL = long ? 0.78 : 0.3;
  for (const sx of [-1, 1]) for (let j = 0; j < NS; j++) {
    const v0 = j / NS, v1 = (j + 1) / NS;
    const E = (v: number, k: number): { p: V3; s: number } => {
      const out = long ? 0.47 - 0.07 * v : 0.47 + 0.06 * v;
      const x = sx * (out + k * 0.13 * (1 - 0.35 * v) * (long ? 1 : 1.2)) * (k < 0 ? 1 : 1);
      const y = -0.16 - 0.04 * (1 - Math.abs(sx)) - SL * v;
      return { p: [x - sx * 0.13 * (k < 0 ? 1 : 0) * 0, y, 0.12 + 0.1 * Math.sin(v * 3) * (long ? 1 : 0)], s: (0.86 - 0.18 * v) * (k ? 0.9 : 1) };
    };
    const a = E(v0, -1), b = E(v0, 0), c = E(v1, 0), d = E(v1, -1);
    tri(a, d, c, [0.02, 0.9 - v0 * 0.5], [0.02, 0.9 - v1 * 0.5], [0.14, 0.9 - v1 * 0.5]); tri(a, c, b, [0.02, 0.9 - v0 * 0.5], [0.14, 0.9 - v1 * 0.5], [0.14, 0.9 - v0 * 0.5]);
  }
  // The hanger: a hook and a bar along the shoulders, dark plastic (the cell's corner, shaded black).
  const H = (p: V3[]) => { const z = { s: 0.12 }; tri({ p: p[0], ...z }, { p: p[1], ...z }, { p: p[2], ...z }, [0.5, 0.97], [0.5, 0.97], [0.5, 0.97]); tri({ p: p[0], ...z }, { p: p[2], ...z }, { p: p[3], ...z }, [0.5, 0.97], [0.5, 0.97], [0.5, 0.97]); };
  H([[-0.012, -0.075, 0.02], [0.012, -0.075, 0.02], [0.012, 0.05, 0.02], [-0.012, 0.05, 0.02]]);
  H([[-0.06, 0.05, 0.02], [0.012, 0.05, 0.02], [0.012, 0.035, 0.02], [-0.06, 0.035, 0.02]]);
  const g = geo(pos, uv);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
/** A roll of flooring or a rug: a lathe of n sides, shaded round its girth (lit from local +z, which is up once it lies
 *  down), end caps in rings round a cardboard core. Same frame as latheGeo. */
function rollGeo(n: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [];
  const P = (r: number, a: number, y: number): number[] => [r * Math.sin(a + Math.PI), y, -0.5 + r * Math.cos(a + Math.PI)];
  const sh = (a: number) => 0.62 + 0.38 * Math.max(0, -Math.cos(a + Math.PI) * 0.8 + 0.2);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, s0 = sh(a0), s1 = sh(a1);
    pos.push(...P(0.5, a0, 0), ...P(0.5, a1, 0), ...P(0.5, a1, 1), ...P(0.5, a0, 0), ...P(0.5, a1, 1), ...P(0.5, a0, 1));
    uv.push(i / n, 0.02, (i + 1) / n, 0.02, (i + 1) / n, 0.98, i / n, 0.02, (i + 1) / n, 0.98, i / n, 0.98);
    col.push(s0, s0, s0, s1, s1, s1, s1, s1, s1, s0, s0, s0, s1, s1, s1, s0, s0, s0);
    const rings = [0.5, 0.38, 0.27, 0.16, 0.1];
    for (const y of [0, 1]) for (let k = 0; k < rings.length; k++) {
      const ra = rings[k], rb = rings[k + 1] ?? 0, s = k === rings.length - 1 ? 0.18 : k === rings.length - 2 ? 0.9 : (k % 2 ? 0.72 : 0.88);
      const q = [P(ra, a0, y), P(ra, a1, y), P(rb, a1, y), P(rb, a0, y)];
      for (const t of y ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) { pos.push(...q[t]); uv.push(0.5, k < 2 ? 0.5 : 0.95); col.push(s, s * (k === 3 ? 0.85 : 1), s * (k === 3 ? 0.7 : 1)); }
    }
  }
  const g = geo(pos, uv);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
/** A hand-lettered card on a short post: card x -0.5..0.5, y 0.35..1 (relative), double-sided, uv full. */
function signGeo(): THREE.BufferGeometry {
  return quads([
    { p: [[-0.5, 0.3, 0.01], [0.5, 0.3, 0.01], [0.5, 1, 0.01], [-0.5, 1, 0.01]], t: FULL },
    { p: [[0.5, 0.3, -0.01], [-0.5, 0.3, -0.01], [-0.5, 1, -0.01], [0.5, 1, -0.01]], t: FULL },
    { p: [[-0.02, 0, 0], [0.02, 0, 0], [0.02, 0.3, 0], [-0.02, 0.3, 0]], t: [[0.5, 0.02], [0.5, 0.02], [0.5, 0.02], [0.5, 0.02]] },
    { p: [[0, 0, -0.02], [0, 0, 0.02], [0, 0.3, 0.02], [0, 0.3, -0.02]], t: [[0.5, 0.02], [0.5, 0.02], [0.5, 0.02], [0.5, 0.02]] },
  ]);
}
/** Hanging department sign: panel x -0.5..0.5, y -0.5..0.5, both faces, two wires up to y = 1.5 (scaled). */
function hangGeo(): THREE.BufferGeometry {
  const W = (x: number) => ({ p: [[x - 0.003, 0.5, 0], [x + 0.003, 0.5, 0], [x + 0.003, 3, 0], [x - 0.003, 3, 0]] as V3[], t: [[0.5, 0.97], [0.5, 0.97], [0.5, 0.97], [0.5, 0.97]] as [number, number][] });
  return quads([
    { p: [[-0.5, -0.5, 0.02], [0.5, -0.5, 0.02], [0.5, 0.5, 0.02], [-0.5, 0.5, 0.02]], t: FULL },
    { p: [[0.5, -0.5, -0.02], [-0.5, -0.5, -0.02], [-0.5, 0.5, -0.02], [0.5, 0.5, -0.02]], t: FULL },
    { p: [[-0.5, 0.5, 0.02], [0.5, 0.5, 0.02], [0.5, 0.5, -0.02], [-0.5, 0.5, -0.02]], t: [[0.5, 0.97], [0.5, 0.97], [0.5, 0.97], [0.5, 0.97]] },
    W(-0.4), W(0.4),
  ]);
}

const GEOS = (): Record<string, THREE.BufferGeometry> => ({
  box: boxGeo(), bag: boxGeo(0.7),
  can: latheGeo([[0.5, 0], [0.5, 1]], 6),
  bottle: latheGeo([[0.5, 0], [0.5, 0.72], [0.17, 1]], 6),
  card: quads([{ p: [[-0.5, -1, 0], [0.5, -1, 0], [0.5, 0, 0], [-0.5, 0, 0]], t: FULL }]),
  garment: garmentGeo(true), garmentS: garmentGeo(false), garmentF: garmentGeo(true, 3, 2, 1), garmentSF: garmentGeo(false, 3, 2, 1),
  roll: rollGeo(12),
  sign: signGeo(), hang: hangGeo(),
});

type Shopper = {
  p: Person; path: [number, number, number][]; i: number; wait: number; kind: 'aisle' | 'door' | 'still' | 'queue'; ax: number[];
  /** Index of the cart this one pushes, or -1. */
  cart: number;
  /** Checkout line: the lane, the place in line (0 = at the register), and what they are doing. */
  lane?: number; slot?: number; st?: 'line' | 'pay' | 'leave' | 'away';
};

// ── The stocker ───────────────────────────────────────────────────────────────
interface Batch { m: number[]; cell: number[]; col: number[] }
const KIT_TINT: Record<string, number[]> = {
  pk_sofa: [0x8a8f96, 0x2f3e5c, 0xb59a78, 0x7d8f74, 0x6e2c33, 0x4a4a4e, 0xc9c1b2],
  pk_recl: [0x5a3d2b, 0x3e3330, 0x7a6a5a, 0x2e2e33],
  pk_dress: [0xffffff, 0xc49a74, 0x8a6a50, 0xf0ece4], pk_table: [0xffffff, 0xb08460, 0x6a4a35],
};

export class PardonsStock {
  readonly group = new THREE.Group();
  private shoppers: Shopper[] = [];
  /** Carts pushed by shoppers: one instance each, placed every frame ahead of whoever pushes it. */
  private carts: THREE.Mesh[] = [];
  private fxMat: THREE.Material | null = null;
  private cartKit: THREE.BufferGeometry | null = null;
  private r = rnd(458);
  private lookRng = new RNG(458);
  private aisles: { x: number; z0: number; z1: number }[] = [];
  /** Store-frame positions of shoppers by the doors (for the sliding doors). */
  readonly nearDoors: { x: number; z: number }[] = [];

  constructor(private game: Game, private M: THREE.Matrix4, private Y: number, private exterior: THREE.Object3D) {
    this.group.name = 'pardons-stock';
    this.group.matrixAutoUpdate = false; this.group.matrix.copy(M);
    LM.uLmY.value = Y;
  }

  async load(): Promise<void> {
    const lk = await loadKtx('models/pardons_lm.webp', { srgb: false, flip: false });
    if (lk) LM.uLm.value = lk;
    const [jb, kb, lb] = await Promise.all([assets.bytes('models/pardons_stock.json'), assets.bytes('models/pardons_kit.glb'), lk ? Promise.resolve(null) : assets.blob('models/pardons_lm.webp')]);
    if (lb && lb.size > 100 && lb.type.startsWith('image')) {
      const url = URL.createObjectURL(lb);
      try {
        const t = await new THREE.TextureLoader().loadAsync(url);
        t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; LM.uLm.value = t;
      } catch { /* the white stand-in stays */ } finally { URL.revokeObjectURL(url); }
    }
    if (!jb || !kb || new DataView(kb).getUint32(0, true) !== 0x46546c67) return;
    let stock: StockFile;
    try { stock = JSON.parse(new TextDecoder().decode(jb)) as StockFile; } catch { return; }
    const gltf = await new GLTFLoader().parseAsync(kb, '');
    const kit = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) kit.set(o.name, m.geometry); });
    LM.uWear.value = drawWear(stock.runs);
    this.collide(stock);
    this.fixtures(stock, kit);
    this.goods(stock);
    this.lotCarts(kit);
    this.people(stock);
  }

  private collide(s: StockFile): void {
    const col = this.game.col, Y = this.Y;
    const box = (x0: number, z0: number, x1: number, z1: number, h: number) => { const r = pdRect(x0, z0, x1, z1); col.addBox(r.x0, r.z0, r.x1, r.z1, Y + h, Y - 1); };
    for (const [x, z0, z1, , h] of s.runs) box(x - 0.62, z0, x + 0.62, z1, h);
    const SZ: Record<string, [number, number, number]> = { pk_rround: [1.25, 1.25, 1.4], pk_rline: [1.6, 0.7, 1.4], pk_sofa: [2.1, 0.92, 0.9], pk_recl: [0.9, 0.9, 1.05],
      pk_matt: [1.56, 2.06, 0.64], pk_dress: [1.54, 0.54, 0.88], pk_table: [1.5, 1.6, 0.8], pk_rugbin: [2.4, 0.8, 1.6], pk_candy: [0.36, 1.6, 1.6] };
    for (const [k, x, z, rot] of s.fx) {
      if (k === 'pk_rack') { box(x - 1.25, z - 3.65, x + 1.25, z + 0.05, 2.5); continue; }
      const d = SZ[k]; if (!d) continue;
      const sw = Math.abs(Math.sin(rot)) > 0.7, w = sw ? d[1] : d[0], dd = sw ? d[0] : d[1];
      box(x - w / 2, z - dd / 2, x + w / 2, z + dd / 2, d[2]);
    }
    box(8.0, 0.7, 13.6, 1.3, 1.0); box(8.6, -0.05, 14.2, 0.55, 1.0);
  }

  private fixtures(s: StockFile, kit: Map<string, THREE.BufferGeometry>): void {
    const by = new Map<string, Batch>();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    for (const [k, x, z, rot] of s.fx) {
      if (!kit.has(k)) continue;
      const key = k + ':' + this.chunkOf(x, z);
      let b = by.get(key); if (!b) by.set(key, b = { m: [], cell: [], col: [] });
      m4.compose(p.set(x, 0, z), q.setFromAxisAngle(up, rot), one).toArray(b.m, b.m.length);
      const tints = KIT_TINT[k], c = new THREE.Color(tints ? tints[Math.floor(this.r() * tints.length)] : 0xffffff);
      b.col.push(c.r, c.g, c.b);
    }
    const mat = bakedLight(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }), 'obj');
    this.fxMat = mat; this.cartKit = kit.get('pk_cart') ?? null;
    for (const [key, b] of by) this.group.add(this.inst(kit.get(key.split(':')[0])!, mat, b, key));
  }

  private inst(g: THREE.BufferGeometry, mat: THREE.Material, b: Batch, name: string, atlas = false): THREE.InstancedMesh {
    const n = b.m.length / 16;
    const geom = atlas ? g.clone() : g;
    if (atlas) geom.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(b.cell), 2));
    const im = new THREE.InstancedMesh(geom, mat, n);
    im.instanceMatrix.array.set(b.m); im.instanceMatrix.needsUpdate = true;
    if (b.col.length) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.col), 3);
    im.matrixAutoUpdate = false; im.name = name;
    im.computeBoundingSphere();
    return im;
  }

  /** Stock every shelf, rack, table and bay, by department, and hang the signs. */
  private goods(s: StockFile): void {
    const geos = GEOS();
    const atlasTex = new THREE.CanvasTexture(drawAtlas());
    atlasTex.colorSpace = THREE.SRGBColorSpace; atlasTex.anisotropy = 8;
    const mat = bakedLight(new THREE.MeshBasicMaterial({ map: atlasTex, fog: false }), 'obj', true);
    const matDS = bakedLight(new THREE.MeshBasicMaterial({ map: atlasTex, fog: false, side: THREE.DoubleSide }), 'obj', true);
    const matCloth = bakedLight(new THREE.MeshBasicMaterial({ map: atlasTex, fog: false, side: THREE.DoubleSide, vertexColors: true }), 'obj', true);
    const batches = new Map<string, Batch>();
    const trays = new Map<string, Batch & { rep: number[] }>();
    const r = this.r;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    /** Small shelf goods go in the chunk's near set (drawn only close by); everything else is drawn wherever its chunk is in view. */
    let nearOnly: boolean | 'f' = false;
    const put = (g: string, _dept: number, x: number, y: number, z: number, rot: number, w: number, h: number, d: number, row: number, i: number, tilt = 0, shade = 1, tx = 0) => {
      const key = g + ':' + this.chunkOf(x, z) + (nearOnly === 'f' ? ':f' : nearOnly ? ':n' : '');
      let b = batches.get(key); if (!b) batches.set(key, b = { m: [], cell: [], col: [] });
      m4.compose(p.set(x, y, z), q.setFromEuler(e.set(tx, rot, tilt, 'YXZ')), sc.set(w, h, d)).toArray(b.m, b.m.length);
      b.cell.push(i % N, N - 1 - row - Math.floor(i / N));
      const k = shade * (0.9 + r() * 0.12); b.col.push(k, k, k);
    };
    /** The far stand-in for a group of facings: one flat card at the shelf edge, the product's cell repeated across and up. */
    const tray = (x: number, y: number, z: number, rot: number, w: number, h: number, nx: number, ny: number, row: number, i: number, u0: number, uw: number) => {
      const key = 't:' + this.chunkOf(x, z);
      let b = trays.get(key); if (!b) trays.set(key, b = { m: [], cell: [], col: [], rep: [] });
      m4.compose(p.set(x, y, z), q.setFromEuler(e.set(0, rot, 0, 'YXZ')), sc.set(w, h, 1)).toArray(b.m, b.m.length);
      b.cell.push(i % N, N - 1 - row - Math.floor(i / N));
      b.rep.push(nx, ny, u0, uw);
      const k = 0.86 + r() * 0.1; b.col.push(k, k, k);
    };
    type Fam = { g: string; row: number; n: number; off?: number; w: [number, number]; h: [number, number]; d: number; stack?: number };
    const FAM: Record<string, Fam> = {
      cereal: { g: 'box', row: ROW.box, n: 48, w: [0.19, 0.23], h: [0.27, 0.33], d: 0.3 },
      crackers: { g: 'box', row: ROW.box, n: 48, w: [0.22, 0.28], h: [0.16, 0.2], d: 0.3, stack: 2 },
      cans: { g: 'can', row: ROW.can, n: 32, w: [0.085, 0.1], h: [0.11, 0.13], d: 0.09, stack: 2 },
      bags: { g: 'bag', row: ROW.bag, n: 16, w: [0.22, 0.27], h: [0.28, 0.34], d: 0.12 },
      jars: { g: 'bottle', row: ROW.bottle, n: 16, w: [0.08, 0.1], h: [0.16, 0.2], d: 0.09 },
      bottles: { g: 'bottle', row: ROW.bottle, n: 16, w: [0.07, 0.1], h: [0.2, 0.3], d: 0.08 },
      hbabox: { g: 'box', row: ROW.hbabox, n: 16, w: [0.12, 0.2], h: [0.08, 0.12], d: 0.25, stack: 3 },
      carton: { g: 'box', row: ROW.carton, n: 16, w: [0.3, 0.45], h: [0.22, 0.34], d: 0.45 },
      towels: { g: 'box', row: ROW.dept, n: 8, off: 8, w: [0.3, 0.36], h: [0.08, 0.1], d: 0.4, stack: 3 },
      paint: { g: 'can', row: ROW.hw, n: 8, w: [0.17, 0.17], h: [0.19, 0.19], d: 0.17, stack: 1 },
      toolbox: { g: 'box', row: ROW.hw, n: 16, w: [0.4, 0.5], h: [0.2, 0.3], d: 0.45 },
    };
    const DEPT_FAMS: string[][] = [
      ['cereal', 'crackers', 'cans', 'bags', 'jars', 'cans', 'crackers'],
      ['bottles', 'hbabox', 'bottles', 'hbabox', 'jars'],
      ['carton', 'towels', 'bottles', 'carton', 'cans'],
      ['paint', 'toolbox', 'carton'],
    ];
    /** One shelf facing: items left to right along the section, fronts at the shelf edge. */
    const facing = (dept: number, fam: Fam, cx: number, cz: number, rot: number, y: number, len: number, clear: number, edge: number) => {
      // Local frame: along = (cos rot, -sin rot) (x after rotY), front = (sin rot, cos rot).
      const fx = Math.sin(rot), fz = Math.cos(rot), ax = Math.cos(rot), az = -Math.sin(rot);
      let u = -len / 2 + 0.01;
      while (u < len / 2 - 0.05) {
        const pickI = (fam.off ?? 0) + Math.floor(r() * fam.n), w = fam.w[0] + r() * (fam.w[1] - fam.w[0]);
        const h = Math.min(clear - 0.03, fam.h[0] + r() * (fam.h[1] - fam.h[0]));
        const rep = 1 + Math.floor(r() * 4);
        if (u + w >= len / 2) break;
        const stack = fam.stack ? Math.max(1, Math.min(fam.stack, Math.floor(clear / (h + 0.005)))) : 1;
        const u0 = u;
        let k = 0;
        nearOnly = true;
        for (; k < rep && u + w < len / 2; k++) {
          if (r() < 0.04) { u += w; continue; }      // a gap where something sold
          const back = r() * 0.03, uc = u + w / 2;
          for (let sIdx = 0; sIdx < stack; sIdx++) {
            const bx = cx + ax * uc + fx * (edge - back), bz = cz + az * uc + fz * (edge - back);
            put(fam.g, dept, bx, y + sIdx * (h + 0.004), bz, rot + (r() - 0.5) * 0.06, w, h, fam.d, fam.row, pickI);
          }
          u += w + 0.005;
        }
        nearOnly = false;
        const tc = (u0 + u) / 2, tw = u - u0;
        if (k > 0) tray(cx + ax * tc + fx * (edge - 0.012), y, cz + az * tc + fz * (edge - 0.012), rot, tw, stack * (h + 0.004), k, stack, fam.row, pickI,
          fam.g === 'can' ? 0.33 : 0, fam.g === 'can' ? 0.34 : 1);
      }
    };
    const famFor = (dept: number, seed: number) => FAM[DEPT_FAMS[dept][seed % DEPT_FAMS[dept].length]];
    let sec = 0;
    for (const [k, x, z, rot, dept] of s.fx) {
      sec++;
      if (k === 'pk_gond' || k === 'pk_gondp') {
        for (const side of [-1, 1]) {
          const rr = side * Math.PI / 2;
          if (k === 'pk_gond') {
            const levels: [number, number][] = [[0.15, 0.38], [0.55, 0.38], [0.95, 0.38], [1.35, 0.45]];
            levels.forEach(([y, cl], li) => facing(dept, famFor(dept, Math.floor(sec / 3) + li * 3 + (side > 0 ? 1 : 0)), x, z, rr, y, 1.2, cl, 0.575));
          } else {
            facing(dept, FAM.paint, x, z, rr, 0.15, 1.2, 0.38, 0.575);
            facing(dept, (sec % 2) ? FAM.toolbox : FAM.carton, x, z, rr, 0.55, 1.2, 0.42, 0.575);
            for (const hy of [1.0, 1.32, 1.64, 1.96]) for (let i = 0; i < 5; i++) {
              if (r() < 0.12) continue;
              const hz = z - 0.61 + 0.16 + i * 0.225, ci = Math.floor(r() * 16), n = 2 + Math.floor(r() * 3);
              const w = 0.13 + r() * 0.04, hh = Math.min(0.28, 0.18 + r() * 0.1);
              for (let c = 0; c < n; c++) put('card', dept, x + side * (0.27 - c * 0.05), hy + 0.01, hz, rr, w, hh, 1, ROW.card, ci);
            }
          }
        }
      } else if (k === 'pk_end') {
        const fam = famFor(dept, sec + 5);
        for (const [y, cl] of [[0.15, 0.38], [0.55, 0.38], [0.95, 0.38], [1.35, 0.45]] as [number, number][]) facing(dept, fam, x, z, rot, y, 1.16, cl, 0.25);
        put('sign', dept, x - Math.sin(rot) * 0.235, 1.84, z - Math.cos(rot) * 0.235, rot, 0.56, 0.52, 1, ROW.sign, Math.floor(r() * 16));
      } else if (k === 'pk_low') {
        // Fabric bolts stood on end in two rows a side, the fabric's edge to the aisle.
        for (const side of [-1, 1]) for (const [ox, oy, hh] of [[0.5, 0.75, 0.55], [0.22, 0.75, 0.6]] as [number, number, number][]) {
          let u = -0.6;
          while (u < 0.56) {
            const t = 0.055 + r() * 0.035;
            put('box', dept, x + side * (ox + 0.1), oy, z + u + t / 2, side * Math.PI / 2, t, hh + r() * 0.04, 0.2, ROW.fabric, Math.floor(r() * 16), (r() - 0.5) * 0.08);
            u += t + 0.004;
          }
        }
      } else if (k === 'pk_rround' || k === 'pk_rline') {
        // One kind to a rack, as the real store sorts them: tees, shirts or coats and dresses; colours run in a few
        // neighbouring cells (a rack of one style in several colours), every garment a little different in tone.
        const ci = Math.floor(r() * 16), tint = 0.8 + r() * 0.2, kind = r();
        const g = kind < 0.4 ? 'garmentS' : 'garment', gh = kind < 0.4 ? 0.7 : kind < 0.8 ? 0.8 : 1.02;
        const cellAt = () => (ci + Math.floor(r() * r() * 3)) % 16;
        if (k === 'pk_rround') {
          const n = 44;
          for (let i = 0; i < n; i++) {
            if (r() < 0.06) continue;
            const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.03, gx = x + Math.cos(a) * 0.6, gz = z + Math.sin(a) * 0.6;
            const gg = gh * (0.97 + r() * 0.06), cc = cellAt(), tl = (r() - 0.5) * 0.04;
            nearOnly = true; put(g, dept, gx, 1.33, gz, -a, 0.5, gg, 0.085, ROW.cloth, cc, tl, tint);
            nearOnly = 'f'; put(g + 'F', dept, gx, 1.33, gz, -a, 0.5, gg, 0.085, ROW.cloth, cc, tl, tint); nearOnly = false;
          }
        } else {
          const along = Math.abs(Math.sin(rot)) < 0.5;
          for (const off of [-0.27, 0.27]) for (let u = -0.7; u <= 0.7; u += 0.06) {
            if (r() < 0.06) continue;
            const gx = along ? x + u : x + off, gz = along ? z + off : z + u;
            const gg = gh * (0.97 + r() * 0.06), cc = cellAt(), tl = (r() - 0.5) * 0.04, ro = (along ? Math.PI / 2 : 0) + (r() - 0.5) * 0.12;
            nearOnly = true; put(g, dept, gx, 1.37, gz, ro, 0.5, gg, 0.075, ROW.cloth, cc, tl, tint);
            nearOnly = 'f'; put(g + 'F', dept, gx, 1.37, gz, ro, 0.5, gg, 0.075, ROW.cloth, cc, tl, tint); nearOnly = false;
          }
        }
      } else if (k === 'pk_rack') {
        for (const ly of [0.15, 0.75, 1.35, 1.95]) for (let i = 0; i < 4; i++) {
          if (ly > 1.9 && r() < 0.5) continue;
          const rad = 0.24 + r() * 0.04;
          put('roll', dept, x - 0.9 + i * 0.6, ly + rad * 2, z + 0.02, 0, rad * 2, 3.55, rad * 2, ROW.rug, 8 + Math.floor(r() * 8), 0, 1, -Math.PI / 2);
        }
      } else if (k === 'pk_rugbin') {
        for (let c = 0; c < 4; c++) for (let i = 0; i < 6; i++) {
          const rad = 0.08 + r() * 0.05, hh = 1.5 + r() * 0.9;
          const rx = x - 0.9 + c * 0.6 + (r() - 0.5) * 0.3, rz = z + (r() - 0.5) * 0.45;
          // A standing roll: the unit roll stands on its end; lean a little.
          put('roll', dept, rx, 0.08, rz + rad, r() * 6, rad * 2, hh, rad * 2, ROW.rug, Math.floor(r() * 8), (r() - 0.5) * 0.12);
        }
      } else if (k === 'pk_sofa' && sec % 2 === 0) {
        put('sign', dept, x + 0.7, 0.86, z - 0.3, 0, 0.42, 0.4, 1, ROW.sign, 7);
      } else if (k === 'pk_matt' && sec % 2 === 1) {
        put('sign', dept, x, 0.64, z + 0.6, 0, 0.42, 0.4, 1, ROW.sign, 13);
      }
    }
    // Hanging department signs over the main aisle into each department, and over the middle of the long ones.
    const DS = [[11, -9.9], [11, -41], [34.5, -9.9], [34.5, -35], [53, -9.9], [70.5, -9.9], [70.5, -31], [71, -50.5]];
    DS.forEach(([sx, sz], i) => put('hang', -1, sx, 3.35, sz, 0, i === 7 ? 3.2 : 2.8, 0.7, 1, ROW.dept, i));
    // Floor signs in clothing and rugs; a sign on every fourth run's top.
    for (const [x, z0, z1, dept, h] of s.runs) if (r() < 0.3) put('sign', dept, x, h + 0.03, (z0 + z1) / 2, Math.PI / 2, 0.56, 0.52, 1, ROW.sign, Math.floor(r() * 16));
    for (let i = 0; i < 6; i++) put('sign', 4, 51.3 + (i % 2) * 3.3, 0, -14 - i * 7, 0, 0.5, 1.5, 1, ROW.sign, [4, 11, 14, 5, 9, 1][i]);
    put('sign', 7, 64.5, 0, -50.3, 0, 0.6, 1.4, 1, ROW.sign, 3); put('sign', 7, 75.5, 0, -50.3, 0, 0.6, 1.4, 1, ROW.sign, 3);
    for (const [key, b] of batches) {
      const [g, ck, n] = key.split(':');
      const im = this.inst(geos[g], geos[g].getAttribute('color') ? matCloth : g === 'card' ? matDS : mat, b, 'pk-' + key, true);
      this.group.add(im);
      if (n === 'n') this.chunk(ck).near.push(im);
      else if (n === 'f') { im.visible = false; this.chunk(ck).far.push(im); }
    }
    const trayMat = bakedLight(new THREE.MeshBasicMaterial({ map: atlasTex, fog: false }), 'obj', 'tray');
    const trayGeo = quads([{ p: [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0]], t: FULL }]);
    for (const [key, b] of trays) {
      const g = trayGeo.clone();
      g.setAttribute('aRep', new THREE.InstancedBufferAttribute(new Float32Array(b.rep), 4));
      const im = this.inst(g, trayMat, b, 'pk-' + key, true);
      im.visible = false;
      this.group.add(im);
      this.chunk(key.split(':')[1]).far.push(im);
    }
  }

  // ── Chunks: goods and fixtures are batched per 10 m square so that whole squares out of view are skipped, and the
  // small shelf goods of a square are swapped for its trays beyond NEAR_D. ──
  private static CH = 10;
  private chunks = new Map<string, { x: number; z: number; near: THREE.Object3D[]; far: THREE.Object3D[]; on: boolean }>();
  private chunkOf(x: number, z: number): string { return Math.floor(x / PardonsStock.CH) + ',' + Math.floor(z / PardonsStock.CH); }
  private chunk(k: string) {
    let c = this.chunks.get(k);
    if (!c) { const [i, j] = k.split(',').map(Number); this.chunks.set(k, c = { x: (i + 0.5) * PardonsStock.CH, z: (j + 0.5) * PardonsStock.CH, near: [], far: [], on: true }); }
    return c;
  }
  /** Near goods within this many meters of the camera (to the nearest edge of their square). */
  nearD = 9;
  private lod(cx: number, cz: number): void {
    const H = PardonsStock.CH / 2;
    for (const c of this.chunks.values()) {
      const dx = Math.max(0, Math.abs(cx - c.x) - H), dz = Math.max(0, Math.abs(cz - c.z) - H);
      const on = dx * dx + dz * dz < this.nearD * this.nearD;
      if (on === c.on) continue;
      c.on = on;
      for (const o of c.near) o.visible = on;
      for (const o of c.far) o.visible = !on;
    }
  }

  /** Carts nested in the lot corrals and a couple left loose in the stalls (lit like the lot, not the store). */
  private lotCarts(kit: Map<string, THREE.BufferGeometry>): void {
    const g = kit.get('pk_cart'); if (!g) return;
    const ms: THREE.Matrix4[] = [];
    const rot = new THREE.Matrix4();
    for (const c of CORRALS) {
      const a = c.open > 0 ? Math.PI / 2 : -Math.PI / 2;
      const base = new THREE.Matrix4().makeRotationY(a).setPosition(c.x, this.Y, c.z);
      for (let i = 0; i < 5; i++) ms.push(base.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -2.3 + i * 0.32)).multiply(rot.makeRotationY(-Math.PI / 2)));
    }
    for (const [x, z, a] of [[-628.5, -1186, 0.7], [-657.2, -1242, 2.6], [-611.0, -1168.5, 1.4]]) ms.push(new THREE.Matrix4().makeRotationY(a).setPosition(x, this.Y, z));
    const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 }), ms.length);
    ms.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere(); im.name = 'pardons-lot-carts';
    this.exterior.add(im);
  }

  /** Shoppers on the aisles and at the checkouts, cashiers, and one or two going in and out of the doors. */
  private people(s: StockFile): void {
    const ppl = this.game.people; if (!ppl) return;
    const r = this.r;
    for (const [x, z0, z1, dept] of s.runs) {
      if (dept >= 4 && dept !== 5) continue;
      for (const ax of [x - 1.8, x + 1.8]) if (!this.aisles.some((a) => Math.abs(a.x - ax) < 0.1)) this.aisles.push({ x: ax, z0: z0 + 0.4, z1: Math.min(-10.6, z1) });
    }
    this.aisles = this.aisles.filter((a) => !PD.COLS_X.some((cx) => Math.abs(cx - a.x) < 0.6));
    this.aisles.push({ x: 51.35, z0: -55, z1: -10.6 }, { x: 54.65, z0: -55, z1: -10.6 }, { x: 59.5, z0: -55, z1: -10.6 }, { x: 70.2, z0: -49, z1: -10.6 });
    const spawn = (x: number, z: number, h: number): Person => {
      const [wx, wz] = this.toWorld(x, z);
      const p = ppl.spawn(wx, wz, h + Math.PI, ppl.randomLook(this.lookRng));
      p.y = this.Y; p.visible = false; return p;
    };
    for (let i = 0; i < 11; i++) {
      const a = this.aisles[Math.floor(r() * this.aisles.length)];
      const z = a.z0 + r() * (a.z1 - a.z0);
      this.shoppers.push({ p: spawn(a.x, z, 0), path: [[a.x, z, 0]], i: 0, wait: r() * 3, kind: 'aisle', ax: [], cart: i % 2 === 0 ? 0 : -1 });
    }
    const doorPaths: [number, number, number][][] = [[[8, -10, 3], [8, -2, 0], [5, -0.8, 0], [5, 6.5, 5], [5, -0.8, 0], [8, -2, 0]], [[18, -10, 3], [18, -0.8, 0], [18, 6.5, 7], [18, -0.8, 0]]];
    doorPaths.forEach((path, i) => this.shoppers.push({ p: spawn(path[0][0], path[0][1], 0), path, i: 0, wait: i * 6, kind: 'door', ax: [], cart: i === 0 ? 0 : -1 }));
    // Cashiers at lanes 1, 3, 4 and 6, and a line at each that moves up as each customer pays and goes out.
    for (const li of [0, 2, 3, 5]) {
      const lx = PD.LANES[li];
      const c = spawn(lx + 1.2, -4.1, 0); this.face(c, -1, 0); c.pose = 'stand';
      this.shoppers.push({ p: c, path: [], i: 0, wait: 0, kind: 'still', ax: [], cart: -1 });
      for (let k = 0; k < 2 + (li % 2); k++) {
        const [qx, qz] = this.qPos(li, k);
        const q = spawn(qx, qz, 0); this.face(q, 0, 1); q.pose = 'stand';
        this.shoppers.push({ p: q, path: [], i: 0, wait: 2 + r() * 6, kind: 'queue', ax: [], cart: (k + li) % 2 === 0 ? 0 : -1, lane: li, slot: k, st: k === 0 ? 'pay' : 'line' });
      }
    }
    // Number the carts and make their instances (the kit's cart, lit like the fixtures).
    let n = 0;
    for (const s of this.shoppers) if (s.cart >= 0) s.cart = n++;
    if (this.cartKit && this.fxMat && n) {
      // Separate meshes, not instances: moving an instance means re-uploading its buffer every frame, which stalls the
      // Iris Xe (about 4 ms); a mesh's matrix is a uniform. Their geometry needs a white colour per instance: none here.
      const g = this.cartKit.clone(); const cm = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
      bakedLight(cm, 'obj');
      for (let i = 0; i < n; i++) { const m = new THREE.Mesh(g, cm); m.matrixAutoUpdate = false; m.name = 'pk-pushed-cart'; this.carts.push(m); this.group.add(m); }
    }
  }

  /** Where the k-th in line stands at a lane (store frame): in the lane's aisle, back from the register. */
  private qPos(li: number, k: number): [number, number] { return [PD.LANES[li] + 2.25, -4.8 - k * 1.9]; }

  private toWorld(x: number, z: number): [number, number] { return [PD.XE - x, PD.ZF - z]; }
  /** Point a person along a store-frame direction. */
  private face(p: Person, dx: number, dz: number): void { p.h = Math.atan2(-dx, -dz); }

  update(dt: number, shown: boolean, cx = 0, cz = 0, px = 1e9, pz = 1e9): void {
    this.nearDoors.length = 0;
    if (shown) this.lod(cx, cz);
    const r = this.r;
    for (const s of this.shoppers) {
      s.p.visible = (shown || s.kind === 'door') && s.st !== 'away';
      if (s.kind === 'still') continue;
      const lx = PD.XE - s.p.x, lz = PD.ZF - s.p.z;
      if (s.kind !== 'aisle' && lz > -3 && s.p.visible) this.nearDoors.push({ x: lx, z: lz });
      if (!shown && s.kind !== 'door') { this.cartAt(s); continue; }
      if (s.kind === 'queue') { this.queueStep(s, dt, lx, lz, px, pz); this.cartAt(s); continue; }
      if (s.wait > 0) { s.wait -= dt; s.p.speed = 0; s.p.pose = 'stand'; this.cartAt(s); continue; }
      const tgt = s.path[s.i];
      const dx = tgt[0] - lx, dz = tgt[1] - lz, d = Math.hypot(dx, dz);
      if (d < 0.15) {
        s.wait = tgt[2] * (0.5 + r());
        if (s.kind === 'door') { s.i = (s.i + 1) % s.path.length; continue; }
        // Aisle shoppers: browse along the aisle, now and then go round by the front aisle to another one.
        if (s.ax.length === 0) {
          const a = this.aisles.find((q) => Math.abs(q.x - lx) < 0.2);
          if (a && r() < 0.75) {
            s.path = [[a.x, a.z0 + r() * (a.z1 - a.z0), 2 + r() * 4]]; s.i = 0;
            if (r() < 0.5 && s.cart < 0) this.face(s.p, r() < 0.5 ? 1 : -1, 0);
          } else {
            const b = this.aisles[Math.floor(r() * this.aisles.length)];
            s.path = [[lx, -10.2, 0], [b.x, -10.2, 0], [b.x, b.z0 + r() * (b.z1 - b.z0), 3]]; s.i = 0; s.ax = [1];
          }
        } else if (s.i < s.path.length - 1) s.i++;
        else s.ax = [];
        continue;
      }
      this.walk(s, lx, lz, dx, dz, d, dt, s.cart >= 0 ? 0.95 : 1.15, px, pz);
      this.cartAt(s);
    }
  }

  /**
   * One step toward (lx + dx, lz + dz), stepping round the player: within reach ahead they veer to the side away from
   * the player, and right in front of the player they stop and wait.
   */
  private walk(s: Shopper, lx: number, lz: number, dx: number, dz: number, d: number, dt: number, sp: number, px: number, pz: number): void {
    let ux = dx / d, uz = dz / d;
    const ox = px - lx, oz = pz - lz, od = Math.hypot(ox, oz), ahead = ox * ux + oz * uz;
    const reach = s.cart >= 0 ? 2.4 : 1.7;
    if (od < reach && ahead > -0.2) {
      if (od < (s.cart >= 0 ? 1.5 : 0.75) && ahead > 0.25) { s.p.speed = 0; s.p.pose = 'stand'; return; }
      const cross = ux * oz - uz * ox, k = (1 - od / reach) * 1.8;
      const sx = cross > 0 ? uz : -uz, sz = cross > 0 ? -ux : ux;      // away from the side the player is on
      ux += sx * k; uz += sz * k;
      const n = Math.hypot(ux, uz); ux /= n; uz /= n;
    }
    const step = Math.min(d, sp * dt);
    const [wx, wz] = this.toWorld(lx + ux * step, lz + uz * step);
    s.p.x = wx; s.p.z = wz; s.p.y = this.Y;
    this.face(s.p, ux, uz);
    s.p.speed = sp; s.p.pose = 'walk';
  }

  /** The checkout line: move up to your place, pay at the front, go out by the nearer door, come back to the end of a line. */
  private queueStep(s: Shopper, dt: number, lx: number, lz: number, px: number, pz: number): void {
    const li = s.lane!, r = this.r;
    if (s.st === 'away') {
      s.wait -= dt; if (s.wait > 0) return;
      // Back in from the aisles to the end of this lane's line.
      s.slot = this.shoppers.filter((o) => o.kind === 'queue' && o.lane === li && (o.st === 'line' || o.st === 'pay')).length;
      s.st = 'line';
      const [qx] = this.qPos(li, 0), [wx, wz] = this.toWorld(qx + (r() - 0.5) * 0.4, -12.5);
      s.p.x = wx; s.p.z = wz;
      return;
    }
    if (s.st === 'leave') {
      const tgt = s.path[s.i], dx = tgt[0] - lx, dz = tgt[1] - lz, d = Math.hypot(dx, dz);
      if (d < 0.2) { if (++s.i >= s.path.length) { s.st = 'away'; s.wait = 4 + r() * 8; s.p.speed = 0; } return; }
      this.walk(s, lx, lz, dx, dz, d, dt, 1.1, px, pz);
      return;
    }
    const [tx, tz] = this.qPos(li, s.slot!);
    const dx = tx - lx, dz = tz - lz, d = Math.hypot(dx, dz);
    if (d > 0.12) { this.walk(s, lx, lz, dx, dz, d, dt, 0.9, px, pz); return; }
    this.face(s.p, 0, 1); s.p.speed = 0; s.p.pose = 'stand';
    if (s.slot !== 0) return;
    if (s.st !== 'pay') { s.st = 'pay'; s.wait = 6 + r() * 8; return; }
    s.wait -= dt; if (s.wait > 0) return;
    // Paid: out through the end of the lane to the nearer door, and everyone behind moves up one.
    const door = tx > 34 ? 18 : 5;
    s.st = 'leave'; s.i = 0; s.slot = -1;
    s.path = [[tx, -1.6, 0], [door + (r() - 0.5), -1.0, 0], [door, 3.2, 0]];
    for (const o of this.shoppers) if (o.kind === 'queue' && o.lane === li && o.st === 'line' && o.slot! > 0) o.slot!--;
  }

  /** Put this shopper's cart in front of them, handle at their hands (hidden with them). */
  private cartAt(s: Shopper): void {
    const cm = this.carts[s.cart];
    if (s.cart < 0 || !cm) return;
    cm.visible = s.p.visible;
    if (!s.p.visible) return;
    const lx = PD.XE - s.p.x, lz = PD.ZF - s.p.z;
    const fx = -Math.sin(s.p.h), fz = -Math.cos(s.p.h);
    cm.matrix.makeRotationY(Math.atan2(fz, -fx)).setPosition(lx + fx * 0.8, 0, lz + fz * 0.8);
    cm.matrixWorldNeedsUpdate = true;
  }
}
