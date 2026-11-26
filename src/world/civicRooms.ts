// Fun queue 2, item 47: the three civic rooms, built in code the same way as the diner and the pub (world/nightRooms.ts: one merged
// vertex-coloured mesh with its light baked in, drawn unlit, plus a few canvas boards): the Overdue Library, the Museum of Mild
// Curiosities and the Tepid Falls Depot's ticket hall. A room is built the first time the player is at its door and thrown away
// when she is far (game/civic.ts owns when); it stands in the sky above the door.
//
// Room frame (as nightRooms): u across (0 is the middle), v from the street wall (0) into the room, y up from the floor.

import * as THREE from 'three';
import type { CivicId } from '../game/civicData';
import { BOARD_ROWS, EXHIBITS } from '../game/civicData';
import { Cc, FONT, Mesher, assemble, canvasTex, hash, mul, rgb, type Decal, type Lamp, type RGB } from './nightRooms';

export type SpotKind = 'shelf' | 'desk' | 'plaque' | 'ticket' | 'board' | 'clock' | 'box';
/** Something to walk up to: stand within r of (u, v) and press G. `id` is the book or the exhibit. */
export interface Spot { kind: SpotKind; id: number; u: number; v: number; r: number }
export interface CivicFolk { u: number; v: number; h: number; y: number; pose: 'stand' | 'sit'; role: 'librarian' | 'reader' | 'docent' | 'visitor' | 'clerk' | 'passenger'; path?: number[][] }
export interface CivicSpec {
  w: number; d: number; h: number;
  entry: { u: number; v: number; h: number }; door: { u: number; v: number };
  /** Solid boxes: u0, u1, v0, v1, y0, y1. */
  boxes: number[][];
  spots: Spot[];
  folk: CivicFolk[];
  lamps: Lamp[];
}
export interface BoardRow { to: string; when: string; here: boolean }
export interface CivicRoom {
  group: THREE.Group; spec: CivicSpec; tris: number; dispose(): void;
  /** The depot's live boards (undefined in the other rooms). */
  drawBoard?: (rows: BoardRow[], note: string) => void;
  drawClock?: (hour: number) => void;
}

interface Built { spec: CivicSpec; m: Mesher; decals: Decal[]; live?: { board?: THREE.CanvasTexture; clock?: THREE.CanvasTexture } }

const GOLD: RGB = rgb(0xe3b64a);
const WOODD: RGB = rgb(0x3b2416), WOODM: RGB = rgb(0x6a4126), WOODL: RGB = rgb(0x9a6a3e);

/** The street wall with a door gap (centre doorU, 1.3 wide, 2.5 high), the door itself shut in it, and the walls round the room. */
function shell(m: Mesher, W: number, D: number, H: number, doorU: number, wall: (y: number, i: number) => RGB, floor: (i: number, j: number) => RGB, ceil: RGB, cell = 0.5): void {
  const x0 = -W / 2, x1 = W / 2;
  m.face([x0, 0, 0], [W, 0, 0], [0, 0, D], [0, 1, 0], floor, cell);
  m.face([x0, H, 0], [W, 0, 0], [0, 0, D], [0, -1, 0], ceil, 1);
  const col = (y0: number) => (i: number, j: number): RGB => wall(y0 + (j + 0.5) * 0.4, i);
  m.face([x0, 0, D], [W, 0, 0], [0, H, 0], [0, 0, -1], col(0), 0.4);
  m.face([x0, 0, 0], [0, 0, D], [0, H, 0], [1, 0, 0], col(0), 0.4);
  m.face([x1, 0, D], [0, 0, -D], [0, H, 0], [-1, 0, 0], col(0), 0.4);
  const seg = (a: number, b: number, y0: number, y1: number): void => { if (b > a && y1 > y0) m.face([a, y0, 0.001], [b - a, 0, 0], [0, y1 - y0, 0], [0, 0, 1], col(y0), 0.4); };
  seg(x0, doorU - 0.65, 0, H); seg(doorU + 0.65, x1, 0, H); seg(doorU - 0.65, doorU + 0.65, 2.5, H);
  m.box(doorU - 0.62, doorU + 0.62, 0, 2.48, 0, 0.07, rgb(0x5a3320), { cell: 0.6 });
  m.box(doorU + 0.36, doorU + 0.46, 1.0, 1.1, 0.07, 0.17, GOLD, { cell: 1 });
  m.box(doorU - 0.7, doorU + 0.7, 2.5, 2.58, 0, 0.1, WOODD, { cell: 1 });
}

/** The lamps' strengths scaled (the lamps are written at a glance and tuned here). */
function dim(lamps: Lamp[], k: number): Lamp[] { for (const l of lamps) l.i *= k; return lamps; }

/** A lit pane in a wall (a window at dusk). */
function pane(m: Mesher, u: number, y: number, w: number, h: number, c: number): void {
  m.face([u - w / 2, y, 0.002], [w, 0, 0], [0, h, 0], [0, 0, 1], (i, j) => mul(rgb(c), 1 + hash(i, j) * 0.25), 0.5, 1.1);
  m.box(u - w / 2 - 0.06, u + w / 2 + 0.06, y - 0.06, y + 0.02, 0, 0.12, WOODD, { cell: 2 });
  m.box(u - w / 2 - 0.06, u + w / 2 + 0.06, y + h - 0.02, y + h + 0.06, 0, 0.12, WOODD, { cell: 2 });
  m.box(u - 0.03, u + 0.03, y, y + h, 0, 0.1, WOODD, { cell: 2 });
}

/** A hanging globe lamp (pendant) with a cord, in a warm tint. */
function globe(m: Mesher, u: number, v: number, y: number, H: number, c: RGB): void {
  m.cyl(u, v, 0.015, y + 0.12, H, Cc.dark, 4);
  m.cyl(u, v, 0.2, y, y + 0.28, c, 10, 2.4, true);
  m.cyl(u, v, 0.23, y + 0.28, y + 0.32, Cc.brass, 10);
}

// ── The Overdue Library ─────────────────────────────────────────────────────

const SPINES: RGB[] = [rgb(0x7a2a2a), rgb(0x2d4a6e), rgb(0x2f5d4a), rgb(0x8a6a2a), rgb(0x5a3a6e), rgb(0xa0502a), rgb(0x3a3a44), rgb(0xb0a070), rgb(0x2a5a5a), rgb(0x8e3a52)];

/** Books on a case front: rows of spines between planks, some slots empty. `k` salts the pattern. */
function spines(k: number): (i: number, j: number) => RGB {
  return (i, j) => {
    if (j % 5 === 4) return mul(WOODM, 0.8);
    const h = hash(i + k * 17, (j / 5 | 0) * 7 + k), g = hash(i * 3 + k, j + 11);
    if (hash(i + k, j * 5 + 3) > 0.94) return mul(WOODD, 0.8);
    return mul(SPINES[Math.min(SPINES.length - 1, (h * SPINES.length) | 0)], 0.72 + g * 0.36);
  };
}

function library(): Built {
  const W = 14, D = 13, H = 4.4, x0 = -W / 2, x1 = W / 2;
  const lamps: Lamp[] = [];
  for (const u of [-4.6, 0, 4.6]) for (const v of [3.2, 6.8, 10.4]) lamps.push({ u, y: 3.5, v, r: 1, g: 0.8, b: 0.52, i: 1.05, rad: 4.4 });
  // The green reading lamps on the tables.
  for (const [u, v] of [[-3.4, 4.6], [1.0, 4.6], [0, 8.2], [0, 10.0]]) lamps.push({ u, y: 1.15, v, r: 1, g: 0.9, b: 0.5, i: 0.9, rad: 2.1 });
  lamps.push({ u: 3.5, y: 1.6, v: 2.0, r: 1, g: 0.86, b: 0.55, i: 0.9, rad: 2.4 });
  const m = new Mesher(dim(lamps, 0.5), [0.22, 0.17, 0.13]);
  const decals: Decal[] = [];
  const carpet = (i: number, j: number): RGB => {
    const u = x0 + (i + 0.5) * 0.5, v = (j + 0.5) * 0.5, rug = Math.abs(u) < 2.4 && v > 5.3 && v < 12;
    if (rug) { const edge = Math.abs(u) > 2.0 || v < 5.7 || v > 11.6; return mul(edge ? rgb(0xc9a24a) : rgb(0x8a2f2a), 0.85 + hash(i, j) * 0.2); }
    return mul(rgb(0x2a4a3a), 0.82 + hash(i, j * 3) * 0.3);
  };
  shell(m, W, D, H, -5, (y) => (y < 1.1 ? mul(WOODM, 0.95) : y > 4.0 ? WOODD : rgb(0xd8c9a0)), carpet, mul(rgb(0xcbb58a), 0.9));
  // Ceiling beams.
  for (let v = 1.5; v < D; v += 3.6) m.box(x0, x1, H - 0.28, H, v, v + 0.3, WOODD, { cell: 2, skip: '+y' });
  // Windows on the street wall, and a wood rail round the walls.
  pane(m, 1.4, 1.2, 1.4, 1.9, 0x24305a); pane(m, 4.4, 1.2, 1.4, 1.9, 0x24305a);
  m.box(x0, x0 + 0.05, 1.1, 1.16, 0, D, WOODD, { cell: 2 }); m.box(x1 - 0.05, x1, 1.1, 1.16, 0, D, WOODD, { cell: 2 });
  const boxes: number[][] = [];
  const spots: Spot[] = [];
  // A bookcase: body, spine face(s), a trim. `faces` lists the sides that show books.
  const bookcase = (u0: number, u1: number, v0: number, v1: number, hc: number, faces: ('+u' | '-u' | '-v' | '+v')[], salt: number): void => {
    m.box(u0, u1, 0, hc, v0, v1, WOODD, { cell: 1 });
    m.box(u0 - 0.04, u1 + 0.04, hc, hc + 0.1, v0 - 0.04, v1 + 0.04, WOODM, { cell: 1 });
    const hh = hc - 0.1, e = 0.004;
    for (const f of faces) {
      if (f === '+u') m.face([u1 + e, 0.05, v0], [0, 0, v1 - v0], [0, hh, 0], [1, 0, 0], spines(salt), 0.14);
      else if (f === '-u') m.face([u0 - e, 0.05, v1], [0, 0, -(v1 - v0)], [0, hh, 0], [-1, 0, 0], spines(salt + 1), 0.14);
      else if (f === '-v') m.face([u1, 0.05, v0 - e], [-(u1 - u0), 0, 0], [0, hh, 0], [0, 0, -1], spines(salt + 2), 0.14);
      else m.face([u0, 0.05, v1 + e], [u1 - u0, 0, 0], [0, hh, 0], [0, 0, 1], spines(salt + 3), 0.14);
    }
    boxes.push([u0, u1, v0, v1, 0, hc]);
  };
  const tab = (u: number, y: number, v: number, f: '+u' | '-u' | '-v'): void => {
    if (f === '+u') m.box(u - 0.02, u + 0.14, y, y + 0.26, v - 0.07, v + 0.07, GOLD, { cell: 1, emi: 1.7 });
    else if (f === '-u') m.box(u - 0.14, u + 0.02, y, y + 0.26, v - 0.07, v + 0.07, GOLD, { cell: 1, emi: 1.7 });
    else m.box(u - 0.07, u + 0.07, y, y + 0.26, v - 0.14, v + 0.02, GOLD, { cell: 1, emi: 1.7 });
  };
  bookcase(x0, x0 + 0.55, 3.2, 12.45, 3.3, ['+u'], 1);
  bookcase(x1 - 0.55, x1, 3.2, 12.45, 3.3, ['-u'], 3);
  bookcase(x0 + 0.55, x1 - 0.55, 12.45, D, 3.3, ['-v'], 5);
  bookcase(-3.7, -3.1, 6.6, 10.8, 2.7, ['+u', '-u'], 7);
  bookcase(3.1, 3.7, 6.6, 10.8, 2.7, ['+u', '-u'], 9);
  // The shelves with a gold tab to borrow from (ten, one per book), nearest-first by where the player stands.
  const shelf: [number, number, '+u' | '-u' | '-v', number, number, number][] = [
    // [stand u, stand v, face, tab u, tab v, tab y]
    [-5.75, 4.4, '+u', x0 + 0.55, 4.4, 1.5], [-5.75, 7.0, '+u', x0 + 0.55, 7.0, 1.0], [-5.75, 9.6, '+u', x0 + 0.55, 9.6, 1.75], [-5.75, 11.6, '+u', x0 + 0.55, 11.6, 1.2],
    [5.75, 5.2, '-u', x1 - 0.55, 5.2, 1.3], [5.75, 8.2, '-u', x1 - 0.55, 8.2, 1.9], [5.75, 11.0, '-u', x1 - 0.55, 11.0, 1.05],
    [-2.2, 11.75, '-v', -2.2, 12.45, 1.6], [2.2, 11.75, '-v', 2.2, 12.45, 1.15],
    [-2.55, 8.7, '+u', -3.1, 8.7, 1.45],
  ];
  shelf.forEach(([su, sv, f, tu, tv, ty], k) => { tab(tu, ty, tv, f); spots.push({ kind: 'shelf', id: k, u: su, v: sv, r: 1.25 }); });
  // The rolling ladder on the back case.
  m.box(-5.3, -5.24, 0, 3.2, 12.3, 12.38, WOODL, { cell: 1 }); m.box(-4.7, -4.64, 0, 3.2, 12.3, 12.38, WOODL, { cell: 1 });
  for (let y = 0.4; y < 3.1; y += 0.4) m.box(-5.3, -4.64, y, y + 0.04, 12.3, 12.38, WOODL, { cell: 1 });
  // Tables with chairs and green lamps.
  const table = (cu: number, cv: number, w: number, d: number, chairs: [number, number, number][], lamp: boolean): void => {
    const u0 = cu - w / 2, u1 = cu + w / 2, v0 = cv - d / 2, v1 = cv + d / 2;
    m.box(u0, u1, 0.72, 0.78, v0, v1, WOODL, { cell: 0.5 });
    for (const [a, b] of [[u0 + 0.08, v0 + 0.08], [u1 - 0.14, v0 + 0.08], [u0 + 0.08, v1 - 0.14], [u1 - 0.14, v1 - 0.14]]) m.box(a, a + 0.06, 0, 0.72, b, b + 0.06, WOODM, { cell: 1 });
    if (lamp) for (const lu of [cu - w * 0.25, cu + w * 0.25]) { m.cyl(lu, cv, 0.1, 0.78, 0.82, Cc.brass, 8); m.cyl(lu, cv, 0.015, 0.82, 1.08, Cc.brass, 4); m.box(lu - 0.17, lu + 0.17, 1.06, 1.2, cv - 0.13, cv + 0.13, rgb(0x2f8a4e), { cell: 1, emi: 1.15 }); }
    for (let k = 0; k < 3; k++) m.box(cu - w * 0.4 + k * 0.12, cu - w * 0.4 + k * 0.12 + 0.2, 0.78, 0.84 + k * 0.03, cv + d * 0.16, cv + d * 0.16 + 0.28, SPINES[(k * 3 + Math.round(Math.abs(cu) * 2)) % SPINES.length], { cell: 1 });
    boxes.push([u0, u1, v0, v1, 0, 0.8]);
    for (const [cu2, cv2, ch] of chairs) {
      m.box(cu2 - 0.22, cu2 + 0.22, 0.42, 0.48, cv2 - 0.22, cv2 + 0.22, rgb(0x6a2a2a), { cell: 1 });
      for (const [a, b] of [[-0.2, -0.2], [0.16, -0.2], [-0.2, 0.16], [0.16, 0.16]]) m.box(cu2 + a, cu2 + a + 0.04, 0, 0.42, cv2 + b, cv2 + b + 0.04, WOODD, { cell: 1 });
      if (Math.abs(ch) < 1) m.box(cu2 - 0.22, cu2 + 0.22, 0.48, 1.0, cv2 + (ch === 0 ? -0.22 : 0.18), cv2 + (ch === 0 ? -0.18 : 0.22), WOODM, { cell: 1 });
      else m.box(cu2 + (ch > 0 ? -0.22 : 0.18), cu2 + (ch > 0 ? -0.18 : 0.22), 0.48, 1.0, cv2 - 0.22, cv2 + 0.22, WOODM, { cell: 1 });
    }
  };
  table(-3.4, 4.6, 2.4, 1.0, [[-3.8, 5.45, 0.5], [-3.0, 3.75, 0], [-4.8, 4.6, 5]], true);
  table(1.0, 4.6, 2.4, 1.0, [[0.6, 5.45, 0.5], [1.4, 3.75, 0]], true);
  table(0, 9.1, 1.3, 3.8, [[-1.05, 8.2, 5], [1.05, 9.6, -5], [-1.05, 10.4, 5]], true);
  // The librarian's desk: a front, a top, a bell, a stack of cards, a lamp.
  m.box(2.0, 5.0, 0, 1.05, 2.0, 2.9, rgb(0x5a3320), { cell: 0.6 });
  m.box(1.92, 5.08, 1.05, 1.12, 1.92, 2.98, WOODL, { cell: 0.6 });
  m.cyl(2.5, 2.45, 0.07, 1.12, 1.18, Cc.brass, 8); m.cyl(2.5, 2.45, 0.025, 1.18, 1.22, Cc.brass, 6);
  m.box(3.9, 4.4, 1.12, 1.3, 2.2, 2.7, rgb(0xe8dfc4), { cell: 1 }); m.box(4.5, 4.78, 1.12, 1.2, 2.3, 2.6, SPINES[1], { cell: 1 });
  m.cyl(3.2, 2.6, 0.09, 1.12, 1.16, Cc.brass, 8); m.cyl(3.2, 2.6, 0.015, 1.16, 1.4, Cc.brass, 4); m.box(3.03, 3.37, 1.38, 1.5, 2.47, 2.73, rgb(0x2f8a4e), { cell: 1, emi: 1.15 });
  boxes.push([1.92, 5.08, 1.92, 2.98, 0, 1.15]);
  // Hanging globes, banners and notices.
  for (const l of lamps.slice(0, 9)) globe(m, l.u, l.v, l.y - 0.1, H - 0.28, [1, 0.82, 0.55]);
  decals.push({ tex: libraryBanner(), u: 0, y: 3.85, v: D - 0.04, w: 6.2, h: 0.78, face: '-v', k: 1.2 });
  decals.push({ tex: noticeTex(['QUIET', 'PLEASE'], '#1f3a2a', '#f3ead2', '#e3b64a'), u: 6.95, y: 2.0, v: 2.4, w: 1.2, h: 0.82, face: '-u', k: 1 });
  decals.push({ tex: noticeTex(['LATE FEES', 'ONE CENT A DAY', '(PER BOOK, PER MINUTE)'], '#3a2416', '#f3ead2', '#e3b64a', 18), u: 3.5, y: 2.55, v: 0.06, w: 2.6, h: 0.9, face: '+v', k: 1 });
  decals.push({ tex: noticeTex(['RETURNS', 'ANY TIME'], '#6a2a2a', '#f3ead2', '#e3b64a'), u: 3.5, y: 1.68, v: 1.95, w: 1.5, h: 0.5, face: '-v', k: 1 });
  const folk: CivicFolk[] = [
    { u: 3.5, v: 1.45, h: 0, y: 0, pose: 'stand', role: 'librarian' },
    { u: -3.8, v: 5.45, h: Math.PI, y: 0.48, pose: 'sit', role: 'reader' },
    { u: 1.4, v: 3.75, h: 0, y: 0.48, pose: 'sit', role: 'reader' },
    { u: 1.05, v: 9.6, h: Math.PI / 2 * -1, y: 0.48, pose: 'sit', role: 'reader' },
  ];
  const spec: CivicSpec = { w: W, d: D, h: H, entry: { u: -5, v: 1.3, h: 0 }, door: { u: -5, v: 0.8 }, boxes, spots: [...spots, { kind: 'desk', id: 0, u: 3.5, v: 3.45, r: 1.5 }], folk, lamps };
  return { spec, m, decals };
}

function libraryBanner(): THREE.CanvasTexture {
  return canvasTex(768, 128, (g) => {
    g.fillStyle = '#2b1a10'; g.fillRect(0, 0, 768, 128);
    g.strokeStyle = '#e3b64a'; g.lineWidth = 6; g.strokeRect(6, 6, 756, 116);
    g.fillStyle = '#e3b64a'; g.font = `800 66px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('THE OVERDUE LIBRARY', 384, 56);
    g.fillStyle = '#f3ead2'; g.font = `600 24px ${FONT}`; g.fillText('Founded when the first book was returned. It has not been.', 384, 102);
  });
}

function noticeTex(lines: string[], bg: string, ink: string, accent: string, sz = 0): THREE.CanvasTexture {
  return canvasTex(384, 256, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 384, 256);
    g.strokeStyle = accent; g.lineWidth = 8; g.strokeRect(8, 8, 368, 240);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const n = lines.length, fs = sz || (n <= 2 ? 78 : 40);
    lines.forEach((t, i) => {
      g.fillStyle = i === 0 ? accent : ink; g.font = `800 ${i === 0 ? fs : Math.round(fs * (sz ? 1.2 : 0.7))}px ${FONT}`;
      g.fillText(t, 192, 128 + (i - (n - 1) / 2) * (fs * 0.95));
    });
  });
}

// ── The Museum of Mild Curiosities ──────────────────────────────────────────

function museum(): Built {
  const W = 16, D = 14, H = 4.8, x0 = -W / 2, x1 = W / 2;
  const lamps: Lamp[] = [];
  for (const [u, v] of [[-4, 3], [4, 3], [-4, 9], [4, 9], [0, 12.4], [0, 6]]) lamps.push({ u, y: 4.2, v, r: 1, g: 0.9, b: 0.72, i: 0.8, rad: 5 });
  // Spot lamps on the exhibits.
  for (const [u, v] of [[-6.6, 4.2], [-6.6, 9.3], [6.6, 4.2], [6.6, 9.4], [0, 12.0], [0, 7.5]]) lamps.push({ u, y: 3.8, v, r: 1, g: 0.88, b: 0.62, i: 1.7, rad: 3.4 });
  const m = new Mesher(dim(lamps, 0.5), [0.2, 0.19, 0.19]);
  const decals: Decal[] = [];
  const marble = (i: number, j: number): RGB => { const u = x0 + (i + 0.5) * 0.5, v = (j + 0.5) * 0.5, c = (Math.floor(u) + Math.floor(v)) & 1 ? rgb(0xd9d2c0) : rgb(0x8c8c88); return mul(c, 0.9 + hash(i, j) * 0.14); };
  shell(m, W, D, H, -5.5, (y) => (y < 1.1 ? rgb(0xcfc6b0) : y > 4.5 ? Cc.brass : rgb(0x3d5360)), marble, mul(rgb(0xd8d0bc), 0.85), 0.5);
  // Coffers and a gold picture rail.
  for (let u = x0 + 2; u < x1; u += 4) m.box(u, u + 0.2, H - 0.3, H, 0, D, rgb(0xb5ab92), { cell: 2, skip: '+y' });
  for (let v = 2; v < D; v += 4) m.box(x0, x1, H - 0.3, H, v, v + 0.2, rgb(0xb5ab92), { cell: 2, skip: '+y' });
  m.box(x0, x0 + 0.05, 1.1, 1.16, 0, D, Cc.brass, { cell: 2 }); m.box(x1 - 0.05, x1, 1.1, 1.16, 0, D, Cc.brass, { cell: 2 }); m.box(x0, x1, 1.1, 1.16, D - 0.05, D, Cc.brass, { cell: 2 });
  pane(m, 2.4, 1.1, 1.6, 2.0, 0x25305c); pane(m, 5.6, 1.1, 1.6, 2.0, 0x25305c);
  const boxes: number[][] = [];
  const spots: Spot[] = [];
  const stone = rgb(0xb9b2a0), slate = rgb(0x4a5560), glass = rgb(0x9fc4d4);
  // A plinth with a top lit from above.
  const plinth = (u0: number, u1: number, v0: number, v1: number, h: number): void => { m.box(u0, u1, 0, h, v0, v1, stone, { cell: 0.5 }); m.box(u0 - 0.05, u1 + 0.05, h, h + 0.05, v0 - 0.05, v1 + 0.05, mul(stone, 1.1), { cell: 1 }); boxes.push([u0 - 0.05, u1 + 0.05, v0 - 0.05, v1 + 0.05, 0, h + 0.05]); };
  // A glass case's frame: four posts and a lid rail (the glass is not drawn: the drawing is of what is inside).
  const frame = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number): void => {
    for (const [a, b] of [[u0, v0], [u1 - 0.04, v0], [u0, v1 - 0.04], [u1 - 0.04, v1 - 0.04]]) m.box(a, a + 0.04, y0, y1, b, b + 0.04, glass, { cell: 1, emi: 0.7 });
    m.box(u0, u1, y1, y1 + 0.04, v0, v1, glass, { cell: 1, emi: 0.7 });
    m.box(u0, u1, y0, y0 + 0.03, v0, v1, glass, { cell: 1, emi: 0.5 });
  };
  // 0: the Perpetual Bridge (left wall, near).
  plinth(-7.8, -6.0, 3.2, 5.2, 0.9);
  const bridge = (): void => {
    m.box(-7.7, -6.1, 0.97, 1.05, 3.9, 4.5, mul(stone, 0.8), { cell: 1 });      // the channel's far bank block
    m.box(-7.7, -6.1, 0.97, 1.03, 4.5, 4.9, rgb(0x2c6f9c), { cell: 1, emi: 0.6 });
    m.box(-7.7, -6.1, 0.97, 1.03, 3.5, 3.9, rgb(0x2c6f9c), { cell: 1, emi: 0.6 });
    m.box(-7.7, -6.1, 0.97, 1.08, 3.3, 3.5, rgb(0x7a8b4a), { cell: 1 });
    m.box(-7.7, -6.1, 0.97, 1.08, 4.9, 5.1, rgb(0x7a8b4a), { cell: 1 });
    m.box(-7.15, -6.65, 1.1, 1.18, 3.3, 5.1, Cc.brass, { cell: 1 });             // the deck
    for (const v of [3.55, 4.1, 4.65, 5.0]) { m.box(-7.15, -7.1, 1.18, 1.34, v, v + 0.03, Cc.brass, { cell: 1 }); m.box(-6.7, -6.65, 1.18, 1.34, v, v + 0.03, Cc.brass, { cell: 1 }); }
    for (const v of [3.9, 4.5]) m.box(-7.0, -6.8, 0.97, 1.1, v - 0.05, v + 0.05, stone, { cell: 1 });
    m.box(-7.15, -7.12, 1.34, 1.37, 3.3, 5.1, Cc.brass, { cell: 1 }); m.box(-6.68, -6.65, 1.34, 1.37, 3.3, 5.1, Cc.brass, { cell: 1 });
  };
  bridge();
  // 1: Lackwool Mill (left wall, far).
  plinth(-7.8, -6.0, 8.4, 10.4, 0.9);
  m.box(-7.6, -6.7, 0.95, 1.6, 8.7, 9.6, rgb(0x8a5a40), { cell: 0.5 });
  m.box(-7.7, -6.6, 1.6, 1.68, 8.6, 9.7, rgb(0x5a3320), { cell: 1 }); m.box(-7.55, -6.75, 1.68, 1.8, 8.75, 9.55, rgb(0x5a3320), { cell: 1 });
  for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2, wu = -6.35 + Math.cos(a) * 0.38, wy = 1.35 + Math.sin(a) * 0.38; m.box(wu - 0.04, wu + 0.04, wy - 0.04, wy + 0.04, 9.7, 9.9, WOODL, { cell: 1 }); }
  m.box(-6.38, -6.32, 1.0, 1.7, 9.74, 9.86, WOODM, { cell: 1 }); m.box(-6.73, -5.97, 1.32, 1.38, 9.74, 9.86, WOODM, { cell: 1 });
  m.box(-6.5, -6.1, 0.95, 1.5, 8.6, 8.95, rgb(0x2c6f9c), { cell: 1, emi: 0.6 });
  for (let k = 0; k < 3; k++) m.box(-6.6 + k * 0.01, -6.35 + k * 0.01, 0.95 + k * 0.13, 1.06 + k * 0.13, 10.0, 10.3, rgb(0xe8dfc4), { cell: 1 });
  // 2: the Great Tornado (right wall, near): a funnel of rings in a case, a barn and a cow.
  plinth(6.0, 7.8, 3.2, 5.2, 0.9);
  frame(6.1, 7.7, 3.3, 5.1, 0.95, 2.35);
  for (let k = 0; k < 9; k++) { const r = 0.12 + k * 0.045, y = 0.97 + k * 0.15; m.cyl(6.9, 4.2, r, y, y + 0.14, mul(rgb(0x6a7280), 1 + (k % 2) * 0.18), 12, 0.5); }
  m.box(6.25, 6.65, 0.95, 1.2, 3.45, 3.8, rgb(0xa8302a), { cell: 1 }); m.box(6.2, 6.7, 1.2, 1.3, 3.4, 3.85, rgb(0x5a3320), { cell: 1 });
  m.box(7.3, 7.6, 0.95, 1.1, 4.7, 4.95, Cc.white, { cell: 1 }); m.box(7.45, 7.6, 1.05, 1.18, 4.62, 4.78, Cc.white, { cell: 1 });
  // 3: the Moose of the Millpond (right wall, far): a big stuffed moose.
  plinth(5.7, 7.8, 8.2, 10.8, 0.45);
  const brown = rgb(0x5a3a26), tan = rgb(0xc4a46a);
  m.box(6.2, 7.2, 1.35, 2.25, 8.65, 10.2, brown, { cell: 0.5 });                    // body
  m.box(6.25, 7.15, 1.2, 1.4, 8.7, 10.15, mul(brown, 0.8), { cell: 0.5 });
  for (const [u, v] of [[6.3, 8.75], [6.95, 8.75], [6.3, 9.95], [6.95, 9.95]]) m.box(u, u + 0.18, 0.5, 1.35, v, v + 0.18, mul(brown, 0.7), { cell: 1 });
  m.box(6.4, 7.0, 2.2, 2.9, 8.35, 8.85, brown, { cell: 0.5 });                       // neck
  m.box(6.4, 7.0, 2.55, 3.0, 7.95, 8.5, mul(brown, 1.1), { cell: 0.5 });             // head
  m.box(6.5, 6.9, 2.5, 2.8, 7.75, 7.98, mul(brown, 0.6), { cell: 1 });               // muzzle
  m.box(6.12, 6.4, 3.0, 3.06, 7.95, 8.5, tan, { cell: 1 }); m.box(7.0, 7.28, 3.0, 3.06, 7.95, 8.5, tan, { cell: 1 });
  m.box(5.85, 6.2, 3.04, 3.1, 7.7, 8.8, tan, { cell: 1 }); m.box(7.2, 7.55, 3.04, 3.1, 7.7, 8.8, tan, { cell: 1 });   // antler palms
  for (const [a, b] of [[5.85, 6.0], [7.4, 7.55]]) for (const v of [7.8, 8.15, 8.5]) m.box(a, b, 3.08, 3.3, v, v + 0.07, tan, { cell: 1 });
  m.box(6.2, 7.2, 1.2, 1.2, 10.15, 10.4, brown, { cell: 1 });
  // 4: the Demolition Derby (back wall): a dented car and a trophy.
  plinth(-1.5, 1.5, 11.0, 12.6, 0.4);
  m.box(-1.2, 1.2, 0.5, 0.95, 11.2, 12.2, rgb(0xb3302a), { cell: 0.5 });             // body
  m.box(-0.7, 0.8, 0.95, 1.35, 11.35, 11.95, rgb(0x2a3340), { cell: 0.5 });          // cabin
  m.box(-1.0, -0.4, 0.95, 1.12, 11.45, 12.1, mul(rgb(0xb3302a), 0.7), { cell: 0.5 }); // the crumple
  for (const [u, v] of [[-1.25, 11.3], [1.05, 11.3], [-1.25, 11.95], [1.05, 11.95]]) m.box(u, u + 0.2, 0.4, 0.8, v, v + 0.25, Cc.dark, { cell: 1 });
  m.box(0.95, 1.25, 0.95, 1.05, 11.75, 11.95, Cc.chrome, { cell: 1 });
  m.cyl(0, 12.3, 0.15, 0.45, 0.6, GOLD, 10); m.cyl(0, 12.3, 0.05, 0.6, 0.95, GOLD, 8); m.cyl(0, 12.3, 0.2, 0.95, 1.2, GOLD, 10, 1.1);
  // The model of the island: a table, the water, the island and the mainland, the bridge, the line and its train.
  m.box(-3.0, 3.0, 0, 0.85, 5.6, 9.4, slate, { cell: 1 });
  m.box(-3.05, 3.05, 0.85, 0.9, 5.55, 9.45, rgb(0x2a2f36), { cell: 1 });
  m.box(-2.95, 2.95, 0.9, 0.98, 5.65, 9.35, rgb(0x2c6f9c), { cell: 1, emi: 0.8 });
  const g0 = -2.8, nv = 16, nu = 28, cs = 0.2;
  for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
    const u = g0 + a * cs, v = 5.75 + b * cs, fu = (u + 0.55) / 1.75, fv = (v - 7.5) / 1.5, d = Math.hypot(fu, fv) + (hash(a, b) - 0.5) * 0.3;
    const land = d < 1 ? 0.06 + (1 - d) * 0.3 : 0, mainland = u > 2.0 && hash(a * 3, b) > 0.04 ? 0.08 + (u - 2.0) * 0.1 : 0;
    const hgt = Math.max(land, mainland);
    if (hgt <= 0) continue;
    const c = mainland > land ? mul(rgb(0x6f9a4e), 0.8 + hash(a, b * 3) * 0.35) : hgt > 0.22 ? mul(rgb(0x4a7a42), 0.85 + hash(b, a) * 0.3) : land > 0.1 ? mul(rgb(0x6f9a4e), 0.8 + hash(a, b * 3) * 0.3) : rgb(0xc9b27a);
    m.box(u, u + cs, 0.98, 0.98 + hgt, v, v + cs, c, { cell: 1 });
  }
  // The town on the island's middle: a few little roofs.
  for (const [u, v, c] of [[-0.9, 7.3, 0xb3302a], [-0.55, 7.7, 0xe9e4d8], [-0.2, 7.2, 0x8a5a40], [-0.7, 7.05, 0x2d4a6e]] as [number, number, number][]) { m.box(u, u + 0.18, 1.2, 1.32, v, v + 0.18, rgb(0xe8dfc4), { cell: 1 }); m.box(u - 0.02, u + 0.2, 1.32, 1.38, v - 0.02, v + 0.2, rgb(c), { cell: 1 }); }
  // The bridge from the island to the mainland, a brass strip on three piers.
  m.box(1.1, 2.15, 1.16, 1.21, 7.4, 7.6, Cc.brass, { cell: 1 });
  for (const u of [1.35, 1.65, 1.95]) m.box(u, u + 0.06, 0.98, 1.16, 7.42, 7.58, rgb(0x6a7280), { cell: 1 });
  // The Budget Line along the mainland: a dark line with little ties, and a three-coach train.
  for (let k = 0; k < 30; k++) m.box(2.7, 3.0, 1.12, 1.15, 5.8 + k * 0.1, 5.86 + k * 0.1, rgb(0x2a2420), { cell: 1 });
  m.box(2.8, 2.84, 1.15, 1.17, 5.8, 8.8, Cc.chrome, { cell: 1 }); m.box(2.86, 2.9, 1.15, 1.17, 5.8, 8.8, Cc.chrome, { cell: 1 });
  for (let k = 0; k < 3; k++) m.box(2.74, 2.96, 1.17, 1.3, 6.3 + k * 0.5, 6.7 + k * 0.5, k === 0 ? rgb(0x2a7a45) : rgb(0xe9e4d8), { cell: 1 });
  // A little boat.
  m.box(1.1, 1.5, 0.99, 1.07, 8.6, 8.8, Cc.white, { cell: 1 }); m.box(1.25, 1.35, 1.07, 1.2, 8.67, 8.73, Cc.red, { cell: 1 });
  m.box(2.0, 2.4, 0.99, 1.07, 6.1, 6.3, Cc.white, { cell: 1 });
  boxes.push([-3.05, 3.05, 5.55, 9.45, 0, 1.0]);
  // Two cases in the back corners, a stand with a case and something in it (the Mayor's scissors, a hubcap).
  const stand = (cu: number, cv: number, what: number): void => {
    m.box(cu - 0.55, cu + 0.55, 0, 0.9, cv - 0.4, cv + 0.4, slate, { cell: 0.5 }); m.box(cu - 0.6, cu + 0.6, 0.9, 0.95, cv - 0.45, cv + 0.45, rgb(0x2a2f36), { cell: 1 });
    frame(cu - 0.55, cu + 0.55, cv - 0.4, cv + 0.4, 0.95, 1.85);
    m.box(cu - 0.5, cu + 0.5, 0.96, 1.4, cv - 0.35, cv + 0.35, rgb(0x6a1f3a), { cell: 1 });
    if (what === 0) { m.box(cu - 0.2, cu - 0.12, 1.4, 1.46, cv - 0.18, cv + 0.18, Cc.chrome, { cell: 1 }); m.box(cu + 0.1, cu + 0.18, 1.4, 1.46, cv - 0.18, cv + 0.18, Cc.chrome, { cell: 1 }); m.box(cu - 0.14, cu + 0.14, 1.4, 1.43, cv - 0.04, cv + 0.04, Cc.red, { cell: 1 }); }
    else { m.cyl(cu, cv, 0.26, 1.4, 1.44, Cc.chrome, 12); m.cyl(cu, cv, 0.09, 1.44, 1.5, mul(Cc.chrome, 0.8), 8); }
    boxes.push([cu - 0.6, cu + 0.6, cv - 0.45, cv + 0.45, 0, 0.95]);
  };
  stand(-6.0, 12.4, 0); stand(6.0, 12.4, 1);
  // The donation box by the door: a brass-bound pedestal with a slot, and the little shop rack by the docent.
  m.box(-2.55, -1.95, 0, 0.95, 1.0, 1.4, rgb(0x6a1f3a), { cell: 0.5 }); m.box(-2.6, -1.9, 0.95, 1.05, 0.95, 1.45, Cc.brass, { cell: 1 });
  m.box(-2.4, -2.1, 1.05, 1.1, 1.15, 1.25, rgb(0x1a0f10), { cell: 1 });
  m.cyl(-2.25, 1.2, 0.012, 1.1, 1.45, Cc.brass, 4); m.box(-2.55, -1.95, 1.43, 1.5, 1.1, 1.3, GOLD, { cell: 1, emi: 1.4 });
  boxes.push([-2.6, -1.9, 0.95, 1.45, 0, 1.1]);
  m.box(4.6, 5.6, 0, 0.8, 0.9, 1.7, WOODM, { cell: 0.5 }); m.box(4.55, 5.65, 0.8, 0.86, 0.85, 1.75, WOODL, { cell: 1 });
  [rgb(0xe4572e), rgb(0x2d4a6e), rgb(0xf0a202), rgb(0x2f5d4a)].forEach((c, k) => m.box(4.7 + k * 0.22, 4.9 + k * 0.22, 0.86, 1.2, 1.0, 1.06, c, { cell: 1 }));
  boxes.push([4.55, 5.65, 0.85, 1.75, 0, 0.86]);
  // Track-light rails and spots.
  for (const v of [3.6, 6.5, 9.4, 12.0]) m.box(x0 + 1, x1 - 1, H - 0.4, H - 0.34, v, v + 0.06, Cc.dark, { cell: 2 });
  for (const l of lamps.slice(6)) { m.cyl(l.u, l.v, 0.1, l.y, l.y + 0.34, Cc.dark, 8); m.disc(l.u, l.v, 0.08, l.y - 0.01, [1, 0.88, 0.66], 8, 2.2, -1); }
  for (const l of lamps.slice(0, 6)) globe(m, l.u, l.v, l.y - 0.3, H - 0.3, [1, 0.88, 0.7]);
  // Banners, one over each exhibit, and the title over the door side.
  const bn = (e: number, u: number, v: number, face: '+u' | '-u' | '-v', y: number): void => { decals.push({ tex: exhibitBanner(e), u, y, v, w: 2.1, h: 0.92, face, k: 1.15 }); };
  bn(0, x0 + 0.04, 4.2, '+u', 2.55); bn(1, x0 + 0.04, 9.4, '+u', 2.55); bn(2, x1 - 0.04, 4.2, '-u', 2.55); bn(3, x1 - 0.04, 9.5, '-u', 3.75); bn(4, 0, D - 0.04, '-v', 2.6);
  decals.push({ tex: noticeTex(['MUSEUM OF', 'MILD CURIOSITIES'], '#3a1020', '#f3ead2', '#e3b64a', 40), u: 0.6, y: 3.2, v: 0.06, w: 3.0, h: 1.05, face: '+v', k: 1.1 });
  decals.push({ tex: noticeTex(['DONATIONS', 'FOR THE PROMENADE', '$5, WITH THANKS'], '#2a1a10', '#f3ead2', '#e3b64a', 22), u: -2.25, y: 1.8, v: 0.06, w: 1.7, h: 0.8, face: '+v', k: 1 });
  decals.push({ tex: noticeTex(['THE ISLAND', 'and Tepid Falls', 'the town, the bridge, the line'], '#101a2c', '#f3ead2', '#e3b64a', 22), u: 0, y: 0.42, v: 5.56, w: 2.4, h: 0.5, face: '+v', k: 1.1 });
  const folk: CivicFolk[] = [
    { u: 3.4, v: 1.5, h: 0, y: 0, pose: 'stand', role: 'docent' },
    { u: -3.0, v: 7.5, h: Math.PI / 2, y: 0, pose: 'stand', role: 'visitor' },
    { u: 4.1, v: 10.0, h: Math.PI / 2, y: 0, pose: 'stand', role: 'visitor' },
  ];
  EXHIBITS.forEach((e, k) => spots.push({ kind: 'plaque', id: e.id, u: k === 0 || k === 1 ? -5.1 : k === 4 ? 0 : 5.1, v: k === 0 ? 4.2 : k === 1 ? 9.3 : k === 2 ? 4.2 : k === 3 ? 9.5 : 10.4, r: 1.6 }));
  spots.push({ kind: 'box', id: 0, u: -2.25, v: 2.1, r: 1.3 });
  const spec: CivicSpec = { w: W, d: D, h: H, entry: { u: -5.5, v: 1.3, h: 0 }, door: { u: -5.5, v: 0.8 }, boxes, spots, folk, lamps };
  return { spec, m, decals };
}

function exhibitBanner(e: number): THREE.CanvasTexture {
  const x = EXHIBITS[e];
  return canvasTex(512, 224, (g) => {
    g.fillStyle = '#20141a'; g.fillRect(0, 0, 512, 224);
    g.strokeStyle = '#e3b64a'; g.lineWidth = 7; g.strokeRect(7, 7, 498, 210);
    g.fillStyle = '#e3b64a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${x.title.length > 22 ? 40 : 48}px ${FONT}`; g.fillText(x.title.toUpperCase(), 256, 70);
    g.fillStyle = '#f3ead2'; g.font = `600 28px ${FONT}`; g.fillText(x.short, 256, 126);
    g.fillStyle = '#c9b88a'; g.font = `500 22px ${FONT}`; g.fillText(x.years, 256, 170);
  });
}

// ── The Depot ───────────────────────────────────────────────────────────────

function depot(): Built {
  const W = 15, D = 11, H = 4.8, x0 = -W / 2, x1 = W / 2;
  const lamps: Lamp[] = [];
  for (const u of [-4.5, 0, 4.5]) for (const v of [3, 7.5]) lamps.push({ u, y: 3.7, v, r: 1, g: 0.8, b: 0.5, i: 1.1, rad: 4.6 });
  lamps.push({ u: -3.2, y: 2.6, v: 10.4, r: 1, g: 0.85, b: 0.55, i: 1.4, rad: 3.6 }, { u: 3.4, y: 2.2, v: 10.3, r: 1, g: 0.8, b: 0.5, i: 1.5, rad: 2.8 });
  lamps.push({ u: -6.4, y: 0.7, v: 9.4, r: 1, g: 0.5, b: 0.18, i: 1.1, rad: 2.4 });
  const m = new Mesher(dim(lamps, 0.5), [0.22, 0.17, 0.13]);
  const decals: Decal[] = [];
  const tile = (i: number, j: number): RGB => mul(((i >> 1) + (j >> 1)) & 1 ? rgb(0xd9c7a0) : rgb(0xa8553a), 0.88 + hash(i, j) * 0.16);
  shell(m, W, D, H, -5.5, (y) => (y < 1.4 ? rgb(0x2f5d4a) : y > 4.5 ? WOODD : rgb(0xe3d6b0)), tile, mul(rgb(0xc4b48c), 0.9), 0.4);
  for (let v = 1.2; v < D; v += 3.2) m.box(x0, x1, H - 0.32, H, v, v + 0.3, WOODD, { cell: 2, skip: '+y' });
  m.box(x0, x0 + 0.05, 1.4, 1.46, 0, D, WOODD, { cell: 2 }); m.box(x1 - 0.05, x1, 1.4, 1.46, 0, D, WOODD, { cell: 2 }); m.box(x0, x1, 1.4, 1.46, D - 0.05, D, WOODD, { cell: 2 });
  pane(m, 0.5, 1.3, 1.5, 2.1, 0x233059); pane(m, 3.8, 1.3, 1.5, 2.1, 0x233059);
  const boxes: number[][] = [];
  const spots: Spot[] = [];
  const folk: CivicFolk[] = [];
  // Benches in two rows each side, facing the windows on the back wall. The seats are the people on them.
  const bench = (cu: number, cv: number, sit: number[]): void => {
    const u0 = cu - 1.2, u1 = cu + 1.2;
    m.box(u0, u1, 0.42, 0.48, cv - 0.25, cv + 0.25, WOODL, { cell: 0.5 });
    m.box(u0, u1, 0.48, 1.0, cv - 0.28, cv - 0.22, WOODM, { cell: 0.5 });
    for (const a of [u0 + 0.06, u1 - 0.16]) m.box(a, a + 0.1, 0, 0.42, cv - 0.25, cv + 0.25, WOODD, { cell: 1 });
    boxes.push([u0, u1, cv - 0.3, cv + 0.3, 0, 0.5]);
    for (const k of sit) folk.push({ u: cu - 0.8 + k * 0.8, v: cv, h: 0, y: 0.48, pose: 'sit', role: 'passenger' });
  };
  bench(-3.6, 4.0, [0]); bench(-3.6, 6.4, [1]); bench(3.6, 4.0, []); bench(3.6, 6.4, [2]);
  // The ticket window: counter, brass grille, a lit recess for the clerk.
  m.box(1.9, 5.0, 0, 1.05, 9.5, 10.1, rgb(0x5a3320), { cell: 0.6 });
  m.box(1.8, 5.1, 1.05, 1.12, 9.45, 10.15, WOODL, { cell: 0.6 });
  m.face([1.9, 1.5, 10.95], [3.1, 0, 0], [0, 1.4, 0], [0, 0, -1], (i, j) => mul(rgb(0xffd68a), 1 + hash(i, j) * 0.2), 0.4, 1.3);
  for (const u of [1.9, 5.0 - 0.06]) m.box(u, u + 0.06, 1.12, 2.9, 10.9, 10.98, WOODD, { cell: 1 });
  m.box(1.9, 5.0, 2.9, 3.0, 10.85, 11, WOODD, { cell: 1 }); m.box(1.9, 5.0, 1.1, 1.18, 10.85, 11, WOODD, { cell: 1 });
  for (let u = 2.1; u < 4.95; u += 0.22) m.box(u, u + 0.025, 1.18, 2.9, 10.86, 10.9, Cc.brass, { cell: 1 });
  m.box(2.7, 4.2, 1.12, 1.15, 9.5, 9.7, GOLD, { cell: 1 });
  boxes.push([1.8, 5.1, 9.45, 11, 0, 1.15]);
  // The board's frame on the back wall left, and the clock's, the stove, a cart of cases, a plant.
  m.box(-5.5, -0.9, 2.55, 2.62, 10.86, 11, WOODD, { cell: 1 }); m.box(-5.5, -0.9, 4.28, 4.36, 10.86, 11, WOODD, { cell: 1 });
  // The pot-bellied stove in the left corner: body, door glowing, pipe to the ceiling.
  m.cyl(-6.4, 9.4, 0.34, 0.2, 0.95, rgb(0x2a2c30), 12); m.cyl(-6.4, 9.4, 0.22, 0.95, 1.12, rgb(0x2a2c30), 12); m.cyl(-6.4, 9.4, 0.1, 1.1, H, rgb(0x2a2c30), 8);
  for (const [a, b] of [[-6.15, 9.4]]) m.box(a - 0.01, a + 0.05, 0.45, 0.8, b - 0.12, b + 0.12, rgb(0xff8a2a), { cell: 1, emi: 1.8 });
  m.cyl(-6.4, 9.4, 0.4, 0, 0.2, rgb(0x3a3d42), 12);
  boxes.push([-6.8, -6.0, 9.0, 9.8, 0, 1.2]);
  // Luggage: a cart with cases, near the right wall.
  m.box(5.6, 6.8, 0.2, 0.28, 3.0, 4.0, WOODM, { cell: 1 }); m.box(5.55, 5.65, 0.28, 1.1, 3.0, 3.06, WOODD, { cell: 1 });
  [[5.75, 3.1, rgb(0x6a3a1a), 0.5], [6.25, 3.2, rgb(0x3a4a6a), 0.42], [5.85, 3.55, rgb(0x8a2a2a), 0.36]].forEach(([a, b, c, h]) => m.box(a as number, (a as number) + 0.45, 0.28, 0.28 + (h as number), b as number, (b as number) + 0.35, c as RGB, { cell: 1 }));
  for (const [a, b] of [[5.7, 3.1], [6.6, 3.1], [5.7, 3.9], [6.6, 3.9]]) m.cyl(a, b, 0.1, 0, 0.2, Cc.dark, 6);
  boxes.push([5.55, 6.8, 3.0, 4.0, 0, 0.9]);
  // A potted plant by each door side, a newspaper rack and a notice board on the left wall.
  for (const [pu, pv] of [[-6.8, 3.0], [6.8, 8.6]]) { m.cyl(pu, pv, 0.22, 0, 0.5, rgb(0x8a4a2a), 8); for (let k = 0; k < 6; k++) { const a = k * 1.05; m.box(pu + Math.cos(a) * 0.18 - 0.09, pu + Math.cos(a) * 0.18 + 0.09, 0.5, 0.95 + (k % 3) * 0.2, pv + Math.sin(a) * 0.18 - 0.09, pv + Math.sin(a) * 0.18 + 0.09, rgb(0x2f7a45), { cell: 1 }); } }
  boxes.push([-7.05, -6.55, 2.75, 3.25, 0, 1], [6.55, 7.05, 8.35, 8.85, 0, 1]);
  for (const l of lamps.slice(0, 6)) globe(m, l.u, l.v, l.y - 0.1, H - 0.32, [1, 0.8, 0.5]);
  // The boards: the departures, the clock, the poster, the signs.
  const bd = canvasTex(768, 256, (g) => { g.fillStyle = '#10161c'; g.fillRect(0, 0, 768, 256); });
  decals.push({ tex: bd, u: -3.2, y: 3.45, v: D - 0.04, w: 4.6, h: 1.5, face: '-v', k: 1.25 });
  const ck = canvasTex(256, 256, (g) => { g.fillStyle = '#e9e1c8'; g.fillRect(0, 0, 256, 256); });
  decals.push({ tex: ck, u: x1 - 0.05, y: 3.5, v: 5.5, w: 1.2, h: 1.2, face: '-u', k: 1.1 });
  decals.push({ tex: noticeTex(['TICKETS', 'THE BUDGET LINE'], '#1f3a2a', '#f3ead2', '#e3b64a', 40), u: 3.45, y: 3.45, v: D - 0.04, w: 3.1, h: 0.9, face: '-v', k: 1.1 });
  decals.push({ tex: noticeTex(['WAITING ROOM', 'Trains run in principle.', 'Please be patient in practice.'], '#2a1a10', '#f3ead2', '#e3b64a', 22), u: x0 + 0.04, y: 2.7, v: 6.0, w: 2.4, h: 1.05, face: '+u', k: 1.05 });
  decals.push({ tex: routePoster(), u: x0 + 0.04, y: 2.35, v: 3.2, w: 1.6, h: 1.0, face: '+u', k: 1.05 });
  decals.push({ tex: noticeTex(['DEPOT', 'Trains in principle'], '#1f3a2a', '#f3ead2', '#e3b64a', 40), u: 0.5, y: 3.2, v: 0.06, w: 3.0, h: 1.0, face: '+v', k: 1.1 });
  folk.push({ u: 3.45, v: 10.45, h: Math.PI, y: 0, pose: 'stand', role: 'clerk' });
  folk.push({ u: -1.4, v: 8.4, h: 0, y: 0, pose: 'stand', role: 'passenger' });
  spots.push({ kind: 'ticket', id: 0, u: 3.45, v: 8.7, r: 1.5 }, { kind: 'board', id: 0, u: -3.2, v: 8.6, r: 1.7 }, { kind: 'clock', id: 0, u: 6.4, v: 5.5, r: 1.5 });
  const spec: CivicSpec = { w: W, d: D, h: H, entry: { u: -5.5, v: 1.3, h: 0 }, door: { u: -5.5, v: 0.8 }, boxes, spots, folk, lamps };
  return { spec, m, decals, live: { board: bd, clock: ck } };
}

function routePoster(): THREE.CanvasTexture {
  return canvasTex(384, 240, (g) => {
    g.fillStyle = '#e9dfc0'; g.fillRect(0, 0, 384, 240);
    g.strokeStyle = '#1f3a2a'; g.lineWidth = 8; g.strokeRect(8, 8, 368, 224);
    g.fillStyle = '#1f3a2a'; g.font = `800 34px ${FONT}`; g.textAlign = 'center'; g.fillText('THE BUDGET LINE', 192, 52);
    g.lineWidth = 6; g.strokeStyle = '#1f3a2a'; g.beginPath(); g.moveTo(60, 190); g.lineTo(190, 120); g.lineTo(320, 100); g.stroke();
    g.fillStyle = '#e4572e';
    for (const [x, y, t] of [[60, 190, 'Budget Gap'], [190, 120, 'The Depot'], [320, 100, 'North Halt']] as [number, number, string][]) {
      g.beginPath(); g.arc(x, y, 11, 0, 7); g.fill();
      g.fillStyle = '#1f3a2a'; g.font = `700 24px ${FONT}`; g.textAlign = 'center'; g.fillText(t, x, y + 38); g.fillStyle = '#e4572e';
    }
  });
}

/** Paint the departures: a dark board, amber letters, one row per train (where, when). */
function paintBoard(tex: THREE.CanvasTexture, rows: BoardRow[], note: string): void {
  const cv = tex.image as HTMLCanvasElement, g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#10161c'; g.fillRect(0, 0, 768, 256);
  g.fillStyle = '#e3b64a'; g.fillRect(0, 0, 768, 48);
  g.fillStyle = '#10161c'; g.font = `800 34px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('DEPARTURES', 22, 26); g.textAlign = 'right'; g.fillText('THE BUDGET LINE', 746, 26);
  g.font = `700 36px ${FONT}`;
  for (let i = 0; i < BOARD_ROWS; i++) {
    const y = 80 + i * 40, r = rows[i];
    if (!r) continue;
    g.fillStyle = r.here ? '#8fe39b' : '#ffcf6a';
    g.textAlign = 'left'; g.fillText(r.to, 22, y); g.textAlign = 'right'; g.fillText(r.when, 746, y);
  }
  g.fillStyle = '#9fb4c0'; g.font = `600 22px ${FONT}`; g.textAlign = 'center'; g.fillText(note, 384, 240);
  tex.needsUpdate = true;
}

function paintClock(tex: THREE.CanvasTexture, hour: number): void {
  const cv = tex.image as HTMLCanvasElement, g = cv.getContext('2d') as CanvasRenderingContext2D;
  const h = ((hour % 24) + 24) % 24, mm = (h % 1) * 60;
  g.fillStyle = '#e9e1c8'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#3b2416'; g.beginPath(); g.arc(128, 128, 124, 0, 7); g.fill();
  g.fillStyle = '#f3ecd6'; g.beginPath(); g.arc(128, 128, 112, 0, 7); g.fill();
  g.strokeStyle = '#2a1a10'; g.lineCap = 'round';
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.lineWidth = k % 3 ? 4 : 8; g.beginPath(); g.moveTo(128 + Math.sin(a) * 96, 128 - Math.cos(a) * 96); g.lineTo(128 + Math.sin(a) * 108, 128 - Math.cos(a) * 108); g.stroke(); }
  const hand = (a: number, len: number, w: number): void => { g.lineWidth = w; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len); g.stroke(); };
  hand(((h % 12) + mm / 60) / 12 * Math.PI * 2, 58, 9); hand(mm / 60 * Math.PI * 2, 88, 6);
  g.fillStyle = '#b3302a'; g.beginPath(); g.arc(128, 128, 8, 0, 7); g.fill();
  tex.needsUpdate = true;
}

/** Build one civic room's meshes. */
export function buildCivicRoom(id: CivicId): CivicRoom {
  const b = id === 'library' ? library() : id === 'museum' ? museum() : depot();
  const room = assemble('hall-' + id, b.spec, b.m, b.decals) as CivicRoom;
  if (b.live?.board) { const t = b.live.board; room.drawBoard = (rows, note) => paintBoard(t, rows, note); }
  if (b.live?.clock) { const t = b.live.clock; room.drawClock = (h) => paintClock(t, h); }
  return room;
}

