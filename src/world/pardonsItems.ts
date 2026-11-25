// Pardon's Finds, the models (pardonsCatalogue.ts has the list): each item is a handful of primitives merged into one
// vertex-coloured geometry, built when it is wanted (a day shows 3 to 5), about 0.15 to 0.45 m, base on y = 0, front on +z.
// The same geometry paints the ledger's icons: a little oblique picture in colour when found, a black silhouette when not.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FINDS, FIND_COUNT, RARITY_LABEL, RARITY_ORDER, findsCatalogued, hasFound, type Rarity } from './pardonsCatalogue';

type V3 = [number, number, number];
/** shape, colour, dims, position, rotation (radians), scale (applied before the rotation). */
type Part = ['b' | 'c' | 's' | 't' | 'k' | 'i', number, number[], V3, V3?, V3?];

const P = Math.PI;
const WOOD = 0x9b6a3c, DK = 0x5a3a22, STEEL = 0x9aa0a6, BLACK = 0x1e1e20, WHITE = 0xeeeeea, BRASS = 0xc9a13a, GOLD = 0xe0b020, RED = 0xb3202a, GREEN = 0x2f7a4a, ORANGE = 0xf29c1f;
const bx = (c: number, w: number, h: number, d: number, p: V3, r?: V3): Part => ['b', c, [w, h, d], p, r];
const cy = (c: number, rt: number, rb: number, h: number, p: V3, r?: V3, seg = 12): Part => ['c', c, [rt, rb, h, seg], p, r];
const sp = (c: number, r: number, p: V3, s?: V3): Part => ['s', c, [r], p, undefined, s];
const to = (c: number, R: number, r: number, p: V3, rot?: V3, s?: V3): Part => ['t', c, [R, r, 6, 16], p, rot, s];
const co = (c: number, r: number, h: number, p: V3, rot?: V3): Part => ['k', c, [r, h], p, rot];

function antler(side: number, y: number, c = 0xd9cdb0): Part[] {
  return [bx(c, 0.014, 0.22, 0.014, [side * 0.07, y + 0.1, 0], [0, 0, -side * 0.6]), bx(c, 0.012, 0.11, 0.012, [side * 0.15, y + 0.2, 0], [0, 0, side * 0.1]), bx(c, 0.012, 0.09, 0.012, [side * 0.1, y + 0.17, 0], [0, 0, -side * 0.9])];
}
function duck(body: number, head: number, extra: Part[]): Part[] {
  return [bx(WOOD, 0.28, 0.02, 0.22, [0, 0.01, 0]), sp(body, 0.1, [0, 0.12, 0], [1, 0.85, 1.25]), sp(head, 0.05, [0, 0.25, 0.1]), bx(ORANGE, 0.045, 0.016, 0.05, [0, 0.24, 0.17]),
    sp(BLACK, 0.008, [0.03, 0.27, 0.14]), sp(BLACK, 0.008, [-0.03, 0.27, 0.14]), bx(body, 0.05, 0.1, 0.1, [0, 0.15, -0.12], [0.5, 0, 0]), ...extra];
}

/** The models, by catalogue index. */
const RECIPES: Part[][] = [
  // 0 snowshoe
  [to(WOOD, 0.12, 0.014, [0, 0.02, 0], [P / 2, 0, 0], [1, 1.9, 1]), bx(WOOD, 0.24, 0.012, 0.012, [0, 0.022, 0.05]), bx(WOOD, 0.24, 0.012, 0.012, [0, 0.022, -0.06]), bx(DK, 0.04, 0.014, 0.12, [0, 0.024, -0.3]), bx(0xc9b27a, 0.2, 0.004, 0.36, [0, 0.016, -0.02]), bx(0x2a4a8a, 0.06, 0.02, 0.05, [0, 0.03, 0.02])],
  // 1 box of badges
  [bx(0x7b6a52, 0.3, 0.1, 0.22, [0, 0.05, 0]), bx(0x6a5a44, 0.3, 0.012, 0.22, [0, 0.106, 0], [0.05, 0, 0]), cy(0x4caf50, 0.04, 0.04, 0.01, [-0.08, 0.115, 0.02], [0.3, 0, 0.2]), cy(0xffd23f, 0.04, 0.04, 0.01, [0.03, 0.12, -0.02], [-0.2, 0, 0.1]), cy(WHITE, 0.04, 0.04, 0.01, [0.09, 0.115, 0.04], [0.1, 0, -0.3]), bx(0x4caf50, 0.05, 0.07, 0.008, [-0.02, 0.15, 0.02], [0, 0.3, 0.2]), bx(0xe8e8e0, 0.05, 0.07, 0.008, [0.06, 0.15, 0.0], [0, -0.2, -0.1])],
  // 2 canoe paddle (lying along z)
  [cy(WOOD, 0.014, 0.014, 0.8, [0, 0.02, 0], [P / 2, 0, 0], 8), bx(0xb07a44, 0.2, 0.014, 0.28, [0, 0.02, 0.5]), sp(DK, 0.026, [0, 0.025, -0.4]), bx(BLACK, 0.01, 0.004, 0.08, [0, 0.036, 0.5])],
  // 3 lava lamp
  [cy(STEEL, 0.05, 0.075, 0.08, [0, 0.04, 0]), cy(0xcfe4ee, 0.035, 0.065, 0.3, [0, 0.23, 0]), cy(STEEL, 0.015, 0.04, 0.07, [0, 0.42, 0]), sp(STEEL, 0.017, [0, 0.46, 0])],
  // 4 phone book
  [bx(0xe6c200, 0.17, 0.065, 0.24, [0, 0.0325, 0]), bx(0xf4efe0, 0.15, 0.06, 0.225, [0.012, 0.0325, 0.0]), bx(0xb59400, 0.17, 0.066, 0.01, [0, 0.033, -0.115]), bx(BLACK, 0.12, 0.004, 0.05, [0, 0.067, 0.04])],
  // 5 gnome
  [cy(0x2c5aa0, 0.06, 0.085, 0.15, [0, 0.075, 0]), sp(0xf2c9a0, 0.055, [0, 0.19, 0]), co(WHITE, 0.055, 0.13, [0, 0.14, 0.05], [P - 0.3, 0, 0]), co(RED, 0.06, 0.2, [0, 0.31, 0]), bx(DK, 0.1, 0.02, 0.07, [0, 0.01, 0.05]), sp(0xd88a8a, 0.014, [0, 0.19, 0.055])],
  // 6 doorknobs in a crate
  [bx(WOOD, 0.32, 0.02, 0.22, [0, 0.01, 0]), bx(WOOD, 0.32, 0.1, 0.014, [0, 0.06, 0.103]), bx(WOOD, 0.32, 0.1, 0.014, [0, 0.06, -0.103]), bx(WOOD, 0.014, 0.1, 0.22, [0.153, 0.06, 0]), bx(WOOD, 0.014, 0.1, 0.22, [-0.153, 0.06, 0]),
    sp(BRASS, 0.04, [-0.08, 0.1, 0]), sp(STEEL, 0.04, [0.02, 0.11, 0.03]), sp(0x6a4a30, 0.04, [0.09, 0.1, -0.03]), sp(BRASS, 0.04, [-0.01, 0.12, -0.05]), sp(0xd9d9d0, 0.04, [-0.1, 0.12, 0.05])],
  // 7 singing trout plaque
  [bx(DK, 0.36, 0.03, 0.26, [0, 0.015, 0]), sp(0x4a8f5a, 0.09, [0, 0.07, 0.01], [1.9, 0.55, 0.7]), bx(0x3a7a4a, 0.05, 0.02, 0.1, [0.19, 0.07, 0.01], [0, 0, 0.3]), sp(WHITE, 0.012, [-0.12, 0.1, 0.05]), sp(BLACK, 0.006, [-0.125, 0.1, 0.057])],
  // 8 traffic cone
  [bx(BLACK, 0.24, 0.02, 0.24, [0, 0.01, 0]), cy(0xff6a13, 0.02, 0.1, 0.38, [0, 0.21, 0]), cy(WHITE, 0.048, 0.066, 0.08, [0, 0.22, 0]), bx(BLACK, 0.012, 0.03, 0.002, [0.03, 0.12, 0.092])],
  // 9 VHS
  [bx(BLACK, 0.19, 0.03, 0.105, [0, 0.015, 0]), bx(WHITE, 0.12, 0.002, 0.07, [0, 0.031, 0]), bx(0xc03030, 0.06, 0.003, 0.012, [0, 0.032, 0.01]), bx(0x333338, 0.17, 0.008, 0.02, [0, 0.02, 0.054])],
  // 10 mug
  [cy(0xf3f3ee, 0.045, 0.04, 0.1, [0, 0.05, 0]), to(0xf3f3ee, 0.028, 0.009, [0.06, 0.05, 0]), cy(0x2a4a8a, 0.0455, 0.0425, 0.03, [0, 0.055, 0]), cy(0x3a2a1a, 0.04, 0.04, 0.002, [0, 0.095, 0])],
  // 11 EXIT 130 1/2 sign
  [bx(STEEL, 0.1, 0.02, 0.07, [0, 0.01, 0]), bx(0x0b6b3a, 0.34, 0.2, 0.012, [0, 0.12, 0]), bx(WHITE, 0.3, 0.16, 0.002, [0, 0.12, 0.007]), bx(0x0b6b3a, 0.28, 0.14, 0.002, [0, 0.12, 0.009]), bx(WHITE, 0.2, 0.03, 0.002, [0, 0.14, 0.011]), bx(WHITE, 0.1, 0.02, 0.002, [0.03, 0.09, 0.011])],
  // 12 lighthouse lens
  [to(BRASS, 0.12, 0.014, [0, 0.015, 0], [P / 2, 0, 0]), cy(0xaee4e8, 0.1, 0.12, 0.08, [0, 0.06, 0]), to(BRASS, 0.1, 0.01, [0, 0.105, 0], [P / 2, 0, 0]), cy(0xbfeef2, 0.08, 0.1, 0.07, [0, 0.14, 0]), to(BRASS, 0.08, 0.01, [0, 0.18, 0], [P / 2, 0, 0]), cy(0xaee4e8, 0.055, 0.08, 0.07, [0, 0.215, 0]), sp(0xdff8fa, 0.052, [0, 0.25, 0], [1, 0.7, 1]), bx(0x555555, 0.01, 0.12, 0.002, [0.06, 0.14, 0.092], [0, 0, 0.5])],
  // 13 moose-antler coat rack
  [cy(DK, 0.09, 0.12, 0.03, [0, 0.015, 0]), cy(WOOD, 0.014, 0.018, 0.55, [0, 0.3, 0]), sp(WOOD, 0.03, [0, 0.58, 0]), ...antler(1, 0.55), ...antler(-1, 0.55), bx(0x3a5a8a, 0.1, 0.12, 0.012, [0.12, 0.38, 0.0], [0, 0, 0.1])],
  // 14 bridge bolt (lying along z), with a tag
  [cy(0x6c6f73, 0.055, 0.055, 0.04, [0, 0.055, -0.15], [P / 2, 0, 0], 6), cy(0x7a7d82, 0.025, 0.025, 0.28, [0, 0.055, 0.0], [P / 2, 0, 0]), cy(0x6c6f73, 0.045, 0.045, 0.03, [0, 0.055, 0.1], [P / 2, 0, 0], 6), bx(0xf0e6c0, 0.06, 0.002, 0.08, [0.05, 0.12, -0.08], [0.2, 0.3, 0.3]), bx(0xd04a20, 0.04, 0.003, 0.012, [0.05, 0.123, -0.08], [0.2, 0.3, 0.3])],
  // 15 hard hat
  [sp(0xf2c400, 0.13, [0, 0.0, 0], [1, 0.95, 1.1]), cy(0xe0b400, 0.15, 0.15, 0.012, [0, 0.02, 0.02]), bx(0xe0b400, 0.04, 0.03, 0.26, [0, 0.12, 0]), bx(BLACK, 0.06, 0.04, 0.002, [0, 0.07, 0.14])],
  // 16 barometer
  [cy(BRASS, 0.11, 0.11, 0.05, [0, 0.12, 0], [P / 2, 0, 0], 20), cy(0xf2ecd8, 0.09, 0.09, 0.052, [0, 0.12, 0.001], [P / 2, 0, 0], 20), bx(BLACK, 0.006, 0.07, 0.003, [-0.012, 0.125, 0.028], [0, 0, 0.7]), bx(RED, 0.012, 0.012, 0.003, [0.0, 0.082, 0.028]), bx(0x555555, 0.1, 0.02, 0.06, [0, 0.01, 0])],
  // 17 accordion
  [bx(0x8a1b24, 0.3, 0.2, 0.22, [0, 0.1, 0]), ...[-0.1, -0.05, 0, 0.05, 0.1].map((x) => bx(0xe8e0d0, 0.008, 0.205, 0.225, [x, 0.1, 0])), bx(BLACK, 0.04, 0.22, 0.24, [0.17, 0.11, 0]), bx(BLACK, 0.04, 0.22, 0.24, [-0.17, 0.11, 0]), bx(WHITE, 0.01, 0.09, 0.04, [0.2, 0.15, 0.0]), bx(BLACK, 0.01, 0.01, 0.04, [0.205, 0.12, 0.0])],
  // 18 deflated inflatable moose
  [bx(0x7a5a3c, 0.32, 0.03, 0.22, [0, 0.015, 0], [0, 0.2, 0]), sp(0x7a5a3c, 0.07, [0.2, 0.025, 0.02], [1.3, 0.35, 1]), bx(0x7a5a3c, 0.09, 0.02, 0.05, [0.13, 0.02, 0.1], [0, 0.3, 0]), bx(0xd9cdb0, 0.012, 0.012, 0.14, [0.22, 0.04, 0.12], [0, 0.5, 0]), bx(0xd9cdb0, 0.012, 0.012, 0.14, [0.23, 0.04, -0.08], [0, -0.5, 0]), bx(0xe8d84a, 0.04, 0.012, 0.02, [-0.05, 0.035, 0.0])],
  // 19 fax machine
  [bx(0xd8d0be, 0.34, 0.1, 0.26, [0, 0.05, 0]), bx(0xbfb7a6, 0.3, 0.012, 0.12, [0, 0.12, -0.05], [-0.5, 0, 0]), bx(WHITE, 0.2, 0.004, 0.12, [0, 0.13, 0.1], [0.3, 0, 0]), bx(0x3a8a4a, 0.07, 0.02, 0.002, [-0.1, 0.075, 0.131]), bx(0x555555, 0.1, 0.03, 0.002, [0.06, 0.075, 0.131])],
  // 20 sale sign for the sale sign
  [cy(0x8a6a44, 0.008, 0.008, 0.2, [0, 0.1, 0]), bx(0xc62828, 0.32, 0.2, 0.012, [0, 0.27, 0]), bx(WHITE, 0.26, 0.03, 0.002, [0, 0.31, 0.007]), bx(WHITE, 0.2, 0.03, 0.002, [0, 0.25, 0.007]), bx(0xffe14a, 0.1, 0.05, 0.002, [0.09, 0.2, 0.007]), bx(DK, 0.1, 0.02, 0.1, [0, 0.01, 0])],
  // 21 Gerald II
  duck(0x6b5a3a, GREEN, [bx(RED, 0.05, 0.02, 0.01, [0, 0.2, 0.08]), bx(0xf0e6c0, 0.07, 0.012, 0.002, [0, 0.01, 0.111])]),
  // 22 snow globe of the store
  [cy(0x3b2a1c, 0.08, 0.1, 0.05, [0, 0.025, 0]), sp(0xd2eaf5, 0.11, [0, 0.16, 0]), bx(0x9a9a98, 0.07, 0.04, 0.05, [0, 0.09, 0.06]), bx(RED, 0.075, 0.012, 0.055, [0, 0.12, 0.06]), ...[[-0.05, 0.2], [0.06, 0.13], [0.02, 0.24], [-0.08, 0.14], [0.08, 0.2]].map(([x, y]) => sp(WHITE, 0.008, [x, y, 0.09]))],
  // 23 fourteen keys
  [to(STEEL, 0.05, 0.006, [0, 0.01, 0], [P / 2, 0, 0]), ...Array.from({ length: 14 }, (_, k): Part => { const a = (k / 14) * P * 2; return bx(BRASS, 0.016, 0.004, 0.07, [Math.cos(a) * 0.1, 0.01, Math.sin(a) * 0.1], [0, -a + P / 2, 0]); })],
  // 24 decoy duck, gold-ish
  duck(0xd9a521, 0xc99a1c, [bx(RED, 0.09, 0.004, 0.05, [0.1, 0.12, 0.06], [0, 0.4, 0.5]), bx(WHITE, 0.07, 0.003, 0.012, [0.1, 0.123, 0.06], [0, 0.4, 0.5])]),
  // 25 tide table
  [bx(0x1f4e8c, 0.2, 0.035, 0.28, [0, 0.0175, 0]), bx(0xf4efe0, 0.185, 0.03, 0.27, [0.008, 0.0175, 0]), bx(0xd8b44a, 0.2, 0.036, 0.03, [0, 0.018, 0.1]), bx(0x7ab8e8, 0.12, 0.004, 0.04, [0, 0.037, -0.05]), bx(0x7ab8e8, 0.08, 0.004, 0.04, [0.02, 0.037, 0.03])],
  // 26 Sasquatch's receipt
  [bx(BLACK, 0.12, 0.02, 0.12, [0, 0.01, 0]), cy(STEEL, 0.004, 0.004, 0.24, [0, 0.14, 0]), bx(0xf4efe0, 0.06, 0.3, 0.003, [0.0, 0.17, 0.0], [0, 0.2, 0.05]), bx(0xf4efe0, 0.06, 0.12, 0.003, [0.015, 0.07, 0.01], [0, -0.5, 0.2]), bx(0x2a2a2a, 0.04, 0.003, 0.003, [0, 0.25, 0.01]), bx(0x6a4a30, 0.1, 0.004, 0.2, [0.13, 0.002, 0.04])],
  // 27 meteorite
  [cy(0x3a3a40, 0.07, 0.09, 0.03, [0, 0.015, 0]), ['i', 0x2b2b30, [0.12, 1], [0, 0.14, 0], undefined, [1, 0.85, 1.1]], ['i', 0xff7a1a, [0.035, 0], [0.07, 0.17, 0.07]], ['i', 0xffa040, [0.025, 0], [-0.05, 0.12, 0.09]], ['i', 0xff7a1a, [0.02, 0], [0.0, 0.22, 0.04]], bx(0xf0e6c0, 0.07, 0.04, 0.002, [0, 0.03, 0.093])],
  // 28 blueprints
  [cy(0xe9e4d2, 0.04, 0.04, 0.36, [0, 0.04, 0], [P / 2, 0, 0], 14), cy(0x2a6fd8, 0.044, 0.044, 0.03, [0, 0.04, 0.1], [P / 2, 0, 0], 14), cy(0x2a6fd8, 0.044, 0.044, 0.03, [0, 0.04, -0.1], [P / 2, 0, 0], 14), bx(0x1f5fbf, 0.16, 0.003, 0.22, [0.1, 0.0015, 0.05], [0, 0.1, 0]), bx(0xdfe9f8, 0.1, 0.004, 0.006, [0.1, 0.004, 0.05], [0, 0.1, 0]), bx(0xdfe9f8, 0.1, 0.004, 0.006, [0.1, 0.004, 0.09], [0, 0.1, 0])],
  // 29 the Golden Cart
  [bx(GOLD, 0.2, 0.012, 0.13, [0, 0.07, 0]), bx(GOLD, 0.2, 0.1, 0.01, [0, 0.12, 0.065], [0.0, 0, 0]), bx(GOLD, 0.2, 0.1, 0.01, [0, 0.12, -0.065]), bx(GOLD, 0.01, 0.1, 0.13, [0.1, 0.12, 0]), bx(GOLD, 0.01, 0.1, 0.13, [-0.1, 0.12, 0]), bx(0xb8860b, 0.2, 0.012, 0.11, [0, 0.17, 0.0], [0, 0, 0]), bx(GOLD, 0.01, 0.1, 0.01, [-0.11, 0.2, 0.06], [0, 0, 0.3]), bx(GOLD, 0.01, 0.01, 0.13, [-0.145, 0.24, 0]),
    ...[[-0.08, 0.05], [0.08, 0.05], [-0.08, -0.05], [0.08, -0.05]].map(([x, z]) => cy(0x333338, 0.025, 0.025, 0.02, [x, 0.03, z], [0, 0, P / 2])), bx(0xb8860b, 0.01, 0.04, 0.12, [0.0, 0.05, 0])],
];
if (RECIPES.length !== FIND_COUNT) throw new Error('pardonsItems: one recipe per find');

function partGeo(p: Part): THREE.BufferGeometry {
  const [k, color, d, pos, rot, sc] = p;
  let g: THREE.BufferGeometry;
  switch (k) {
    case 'b': g = new THREE.BoxGeometry(d[0], d[1], d[2]); break;
    case 'c': g = new THREE.CylinderGeometry(d[0], d[1], d[2], d[3] ?? 12); break;
    case 's': g = new THREE.SphereGeometry(d[0], 12, 9); break;
    case 't': g = new THREE.TorusGeometry(d[0], d[1], d[2], d[3]); break;
    case 'k': g = new THREE.ConeGeometry(d[0], d[1], 12); break;
    default: g = new THREE.IcosahedronGeometry(d[0], d[1]); break;
  }
  if (sc) g.scale(sc[0], sc[1], sc[2]);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
  g.translate(pos[0], pos[1], pos[2]);
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const c = new THREE.Color(color), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const cache = new Map<number, THREE.BufferGeometry>();
/** The merged, vertex-coloured geometry of find `i` (built once). */
export function findGeometry(i: number): THREE.BufferGeometry {
  let g = cache.get(i);
  if (!g) { g = mergeGeometries(RECIPES[i].map(partGeo))!; g.computeBoundingSphere(); cache.set(i, g); }
  return g;
}

// ── The ledger ──────────────────────────────────────────────────────────────

const icons = new Map<string, string>();
/** An oblique picture of find `i` as a data URL: in colour, or a flat black silhouette. */
export function findIcon(i: number, found: boolean): string {
  const key = i + (found ? 'f' : 's');
  const hit = icons.get(key);
  if (hit) return hit;
  const g = findGeometry(i), pos = g.getAttribute('position'), col = g.getAttribute('color');
  const yaw = -0.6, pitch = 0.45, cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), spn = Math.sin(pitch);
  const n = pos.count, X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let k = 0; k < n; k++) {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const rx = x * cy_ + z * sy, rz = -x * sy + z * cy_;
    const ry = y * cp - rz * spn, rz2 = y * spn + rz * cp;
    X[k] = rx; Y[k] = ry; Z[k] = rz2;
    x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
  }
  const S = 88, pad = 6, k = (S - pad * 2) / Math.max(x1 - x0, y1 - y0, 0.05);
  const ox = (S - (x1 - x0) * k) / 2 - x0 * k, oy = (S + (y1 - y0) * k) / 2 + y0 * k;
  const tris: { t: number; z: number }[] = [];
  for (let t = 0; t < n / 3; t++) tris.push({ t, z: (Z[t * 3] + Z[t * 3 + 1] + Z[t * 3 + 2]) / 3 });
  tris.sort((a, b) => a.z - b.z);
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  c.lineJoin = 'round';
  for (const { t } of tris) {
    const a = t * 3, b = a + 1, d = a + 2;
    let shade = 1;
    if (found) {
      const ux = X[b] - X[a], uy = Y[b] - Y[a], uz = Z[b] - Z[a], vx = X[d] - X[a], vy = Y[d] - Y[a], vz = Z[d] - Z[a];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      shade = 0.55 + 0.45 * Math.max(0, nx * -0.3 + ny * 0.7 + nz * 0.6);
    }
    const fill = found
      ? `rgb(${Math.round(col.getX(a) ** (1 / 2.2) * 255 * shade)},${Math.round(col.getY(a) ** (1 / 2.2) * 255 * shade)},${Math.round(col.getZ(a) ** (1 / 2.2) * 255 * shade)})`
      : '#22201e';
    c.fillStyle = fill; c.strokeStyle = fill; c.lineWidth = 0.7;
    c.beginPath(); c.moveTo(X[a] * k + ox, oy - Y[a] * k); c.lineTo(X[b] * k + ox, oy - Y[b] * k); c.lineTo(X[d] * k + ox, oy - Y[d] * k); c.closePath(); c.fill(); c.stroke();
  }
  const url = cv.toDataURL('image/png');
  icons.set(key, url);
  return url;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Section H of the Progress page: the Finds Ledger, a grid of what has been filed and what has not. */
export function findsLedgerHtml(todayLeft: number): string {
  const n = findsCatalogued();
  const per = RARITY_ORDER.map((r: Rarity) => {
    const all = FINDS.map((f, i) => (f.rarity === r ? i : -1)).filter((i) => i >= 0);
    return `${RARITY_LABEL[r].toLowerCase()} ${all.filter(hasFound).length}/${all.length}`;
  }).join(' · ');
  const cells = FINDS.map((f, i) => {
    const got = hasFound(i);
    return `<div class="mn-find ${got ? 'got' : ''} r-${f.rarity}" title="${got ? esc(f.line) : 'Not yet filed'}">
  <img alt="" width="44" height="44" src="${findIcon(i, got)}"><b>${got ? esc(f.name) : '???'}</b>
  <em>${f.rarity === 'ultra' ? 'ULTRA' : f.rarity}</em>${got ? `<small>${esc(f.line)}</small>` : ''}</div>`;
  }).join('');
  return `<h3>Section H · Pardon's Finds ledger (${n} of ${FIND_COUNT})</h3>
<p class="mn-note">${per}. Hidden in the aisles at Pardon's Surplus &amp; Salvage; the day's set is the same for everyone. Today: ${todayLeft > 0 ? `${todayLeft} still out on the floor.` : 'nothing left to file.'}</p>
<div class="mn-finds">${cells}</div>`;
}
