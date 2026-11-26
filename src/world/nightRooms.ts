// Fun queue 2, item 35: the two rooms of Main St's night life, built in code (no Blender): the Side Door Diner and the Hog Wallow Pub.
//
// A room is one merged mesh of vertex-coloured faces with its light baked in (warm pendant lamps lit per vertex, so no real
// light costs anything), drawn unlit, plus a few canvas-textured boards (menu, signs, dartboard, band banner). It is built the
// first time the player is at the door and thrown away when she is far; game/nightlife.ts owns when. The room itself stands
// in the sky above the street door (a pocket: collision boxes at ROOM_Y, a floor you stand on), so nothing in the town is moved
// or cut for it, and the walk in and out is a teleport like the HQ lifts' ride.
//
// Room frame: u across (0 is the middle), v from the street wall (0) into the room, y up from the floor. World x = ox + u,
// z = oz + v, y = ROOM_Y + y. Headings are the game's (0 faces +v, PI/2 faces +u).

import * as THREE from 'three';
import type { VenueId } from '../game/nightData';
import { BAND } from '../game/nightData';
import { nightBloom } from '../core/post';

export const ROOM_Y = 640;
export { neon as neonTex };

export interface Lamp { u: number; y: number; v: number; r: number; g: number; b: number; i: number; rad: number }
export interface SeatSpec { u: number; v: number; h: number; y: number; kind: 'stool' | 'booth'; taken: boolean }
export interface FolkSpec { u: number; v: number; h: number; y: number; pose: 'stand' | 'sit'; role: 'cook' | 'waitress' | 'customer' | 'landlord' | 'band' | 'regular'; path?: number[][]; band?: boolean }
export interface RoomSpec {
  w: number; d: number; h: number;
  /** Where you appear, and the spot by the street door that leaves. */
  entry: { u: number; v: number; h: number }; door: { u: number; v: number };
  /** Solid boxes: u0, u1, v0, v1, y0, y1. */
  boxes: number[][];
  seats: SeatSpec[];
  folk: FolkSpec[];
  juke?: { u: number; v: number };
  darts?: { u: number; v: number; h: number };
  lamps: Lamp[];
}
export interface Room { group: THREE.Group; spec: RoomSpec; dispose(): void; tris: number }

export type RGB = [number, number, number];
const tmp = new THREE.Color();
export const rgb = (hex: number): RGB => { tmp.set(hex); return [tmp.r, tmp.g, tmp.b]; };
export const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const hash = (i: number, j: number): number => (((i * 73856093) ^ (j * 19349663)) >>> 0) % 256 / 255;

export class Mesher {
  pos: number[] = []; col: number[] = []; idx: number[] = [];
  constructor(private lamps: Lamp[], private amb: RGB) {}

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, emi: number): void {
    let r = 0, g = 0, b = 0;
    if (emi <= 0) {
      r = this.amb[0]; g = this.amb[1]; b = this.amb[2];
      for (const l of this.lamps) {
        const dx = l.u - x, dy = l.y - y, dz = l.v - z, d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) || 1;
        const ndl = Math.max(0, (nx * dx + ny * dy + nz * dz) / d) * 0.8 + 0.2, k = l.i * ndl / (1 + d2 / (l.rad * l.rad));
        r += l.r * k; g += l.g * k; b += l.b * k;
      }
      // The corner where a wall meets the floor is darker.
      if (ny === 0) { const a = 0.78 + 0.22 * Math.min(1, y / 0.9); r *= a; g *= a; b *= a; }
      r *= c[0]; g *= c[1]; b *= c[2];
    } else { r = c[0] * emi; g = c[1] * emi; b = c[2] * emi; }
    this.pos.push(x, y, z); this.col.push(r, g, b);
  }

  /** A flat rectangle o + s*du + t*dv, in cells of about `cell` metres, each coloured by col(i, j). */
  face(o: number[], du: number[], dv: number[], n: number[], col: RGB | ((i: number, j: number) => RGB), cell = 0.5, emi = 0): void {
    const lu = Math.hypot(du[0], du[1], du[2]), lv = Math.hypot(dv[0], dv[1], dv[2]);
    const nu = Math.max(1, Math.round(lu / cell)), nv = Math.max(1, Math.round(lv / cell));
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const c = typeof col === 'function' ? col(i, j) : col, base = this.pos.length / 3;
      for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]) {
        const s = a / nu, t = b / nv;
        this.vert(o[0] + du[0] * s + dv[0] * t, o[1] + du[1] * s + dv[1] * t, o[2] + du[2] * s + dv[2] * t, n[0], n[1], n[2], c, emi);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** A box (u0..u1, y0..y1, v0..v1): its top and four sides (the underside only when asked). */
  box(u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, col: RGB | ((i: number, j: number) => RGB), o: { cell?: number; emi?: number; under?: boolean; skip?: string } = {}): void {
    const cell = o.cell ?? 0.5, emi = o.emi ?? 0, sk = o.skip ?? '';
    const du = u1 - u0, dy = y1 - y0, dv = v1 - v0;
    if (!sk.includes('+u')) this.face([u1, y0, v0], [0, 0, dv], [0, dy, 0], [1, 0, 0], col, cell, emi);
    if (!sk.includes('-u')) this.face([u0, y0, v1], [0, 0, -dv], [0, dy, 0], [-1, 0, 0], col, cell, emi);
    if (!sk.includes('+y')) this.face([u0, y1, v0], [du, 0, 0], [0, 0, dv], [0, 1, 0], col, cell, emi);
    if (!sk.includes('+v')) this.face([u0, y0, v1], [du, 0, 0], [0, dy, 0], [0, 0, 1], col, cell, emi);
    if (!sk.includes('-v')) this.face([u1, y0, v0], [-du, 0, 0], [0, dy, 0], [0, 0, -1], col, cell, emi);
    if (o.under) this.face([u0, y0, v1], [du, 0, 0], [0, 0, -dv], [0, -1, 0], col, cell, emi);
  }

  /** An upright cylinder, `seg` sides, with its top (and the underside when asked). */
  cyl(u: number, v: number, r: number, y0: number, y1: number, col: RGB, seg = 10, emi = 0, under = false): void {
    for (let k = 0; k < seg; k++) {
      const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
      const nx = Math.cos(am), nz = Math.sin(am), base = this.pos.length / 3;
      for (const [a, y] of [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]) this.vert(u + Math.cos(a) * r, y, v + Math.sin(a) * r, nx, 0, nz, col, emi);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.disc(u, v, r, y1, col, seg, emi, 1);
    if (under) this.disc(u, v, r, y0, col, seg, emi, -1);
  }
  disc(u: number, v: number, r: number, y: number, col: RGB, seg = 10, emi = 0, ny = 1): void {
    const c0 = this.pos.length / 3;
    this.vert(u, y, v, 0, ny, 0, col, emi);
    for (let k = 0; k <= seg; k++) { const a = k / seg * Math.PI * 2; this.vert(u + Math.cos(a) * r, y, v + Math.sin(a) * r, 0, ny, 0, col, emi); }
    for (let k = 0; k < seg; k++) this.idx.push(c0, c0 + 1 + k, c0 + 2 + k);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** A small canvas texture, drawn once. */
export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d') as CanvasRenderingContext2D);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
export const FONT = "'Barlow Semi Condensed', 'Arial Narrow', sans-serif";

export interface Decal { tex: THREE.Texture; u: number; y: number; v: number; w: number; h: number; face: '+u' | '-u' | '+v' | '-v'; k?: number }

function neon(text: string, col: string, glow: string): THREE.CanvasTexture {
  return canvasTex(512, 160, (g) => {
    g.clearRect(0, 0, 512, 160);
    g.font = `800 96px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = glow; g.shadowBlur = 28; g.fillStyle = glow; g.fillText(text, 256, 84);
    g.shadowBlur = 10; g.fillStyle = col; g.fillText(text, 256, 84);
  });
}
export function board(lines: [string, string][], title: string, bg: string, ink: string, accent: string): THREE.CanvasTexture {
  return canvasTex(512, 320, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, 512, 320);
    g.strokeStyle = accent; g.lineWidth = 8; g.strokeRect(8, 8, 496, 304);
    g.fillStyle = accent; g.font = `800 46px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(title, 256, 62);
    g.fillStyle = ink; g.font = `600 30px ${FONT}`;
    lines.forEach(([a, b], i) => {
      const y = 108 + i * 42;
      g.textAlign = 'left'; g.fillText(a, 34, y);
      g.textAlign = 'right'; g.fillText(b, 478, y);
    });
  });
}
function dartboardTex(): THREE.CanvasTexture {
  return canvasTex(256, 256, (g) => {
    const cx = 128, cy = 128;
    g.fillStyle = '#1b1410'; g.beginPath(); g.arc(cx, cy, 126, 0, 7); g.fill();
    for (let k = 0; k < 20; k++) {
      const a0 = k / 20 * Math.PI * 2, a1 = (k + 1) / 20 * Math.PI * 2, odd = k & 1;
      for (const [r0, r1, c1, c2] of [[18, 100, '#e8d9a8', '#16130f'], [100, 112, '#2e8b4a', '#c0352b'], [62, 74, '#2e8b4a', '#c0352b']] as [number, number, string, string][]) {
        g.fillStyle = odd ? c1 : c2; g.beginPath(); g.arc(cx, cy, r1, a0, a1); g.arc(cx, cy, r0, a1, a0, true); g.closePath(); g.fill();
      }
    }
    g.fillStyle = '#2e8b4a'; g.beginPath(); g.arc(cx, cy, 18, 0, 7); g.fill();
    g.fillStyle = '#c0352b'; g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill();
  });
}

export const Cc = {
  cream: rgb(0xefe2c0), teal: rgb(0x2a8a85), chrome: rgb(0xcfd6da), red: rgb(0xb3302a), dark: rgb(0x26292d), wood: rgb(0x8a5a36),
  navy: rgb(0x0d1830), brass: rgb(0xc9a24a), pie: rgb(0xd69a3c), berry: rgb(0x7a2548), white: rgb(0xf2ede0), mustard: rgb(0xe0a42a),
};

export function pendant(m: Mesher, u: number, v: number, y: number, col: RGB, flare = 1): void {
  m.cyl(u, v, 0.02, y + 0.15, 3.6, Cc.dark, 4);
  m.cyl(u, v, 0.3, y + 0.05, y + 0.2, mul(col, 0.35), 10);
  m.cyl(u, v, 0.22, y, y + 0.06, col, 10, 2.6 * flare, true);
}

// ── The diner ───────────────────────────────────────────────────────────────

function diner(): { spec: RoomSpec; m: Mesher; decals: Decal[] } {
  const W = 11, D = 10, H = 3.2, x0 = -W / 2, x1 = W / 2;
  const lamps: Lamp[] = [];
  for (const u of [-2.4, 2.4]) for (const v of [2.4, 5.2]) lamps.push({ u, y: 2.55, v, r: 1, g: 0.78, b: 0.5, i: 1.25, rad: 3.4 });
  lamps.push({ u: -1, y: 2.5, v: 7.6, r: 1, g: 0.85, b: 0.6, i: 1.3, rad: 3 }, { u: 0, y: 2.8, v: 9.4, r: 1, g: 0.8, b: 0.55, i: 0.9, rad: 3 });
  lamps.push({ u: -4.6, y: 2.2, v: 2.5, r: 1, g: 0.35, b: 0.55, i: 0.7, rad: 2 });
  const m = new Mesher(lamps, [0.3, 0.22, 0.17]);
  const decals: Decal[] = [];
  const checker = (i: number, j: number): RGB => ((i + j) & 1 ? Cc.cream : Cc.dark);
  // Floor, ceiling, walls (teal below the chrome rail, cream above, a red stripe up under the ceiling).
  m.face([x0, 0, 0], [W, 0, 0], [0, 0, D], [0, 1, 0], checker, 0.5);
  m.face([x0, H, 0], [W, 0, 0], [0, 0, D], [0, -1, 0], mul(Cc.cream, 0.9), 1);
  const wallCol = (bandY: (j: number) => number) => (i: number, j: number): RGB => { void i; const y = bandY(j); return y < 1.05 ? Cc.teal : y > 2.75 ? Cc.red : Cc.cream; };
  const band = (j: number): number => (j + 0.5) * 0.4;
  m.face([x0, 0, D], [W, 0, 0], [0, H, 0], [0, 0, -1], wallCol(band), 0.4);        // back
  m.face([x0, 0, 0], [0, 0, D], [0, H, 0], [1, 0, 0], wallCol(band), 0.4);         // left
  m.face([x1, 0, D], [0, 0, -D], [0, H, 0], [-1, 0, 0], wallCol(band), 0.4);       // right
  // The street wall, with the door gap at u -3 and two windows.
  const sw = (a: number, b: number, y0: number, y1: number): void => m.face([a, y0, 0.001], [b - a, 0, 0], [0, y1 - y0, 0], [0, 0, 1], wallCol((j) => y0 + (j + 0.5) * 0.4), 0.4);
  sw(x0, -3.65, 0, H); sw(-2.35, 0, 0, H); sw(0, 2.2, 0, 0.95); sw(0, 2.2, 2.4, H); sw(2.2, 3, 0, H); sw(3, 5, 0, 0.95); sw(3, 5, 2.4, H); sw(5, x1, 0, H); sw(-3.65, -2.35, 2.4, H);
  for (const [a, b] of [[0, 2.2], [3, 5]]) {
    m.face([a, 0.95, 0.002], [b - a, 0, 0], [0, 1.45, 0], [0, 0, 1], (i, j) => mul(rgb(j > 1 ? 0x1c2f5e : 0x2a2f55), 1 + hash(i, j) * 0.25), 0.7, 1.15);
    m.box(a - 0.05, b + 0.05, 0.9, 0.97, 0, 0.1, Cc.chrome, { cell: 2 }); m.box(a - 0.05, b + 0.05, 2.38, 2.45, 0, 0.1, Cc.chrome, { cell: 2 });
    m.box((a + b) / 2 - 0.025, (a + b) / 2 + 0.025, 0.95, 2.4, 0, 0.1, Cc.chrome, { cell: 2 });
  }
  m.box(-3.62, -2.38, 0, 2.4, 0, 0.06, rgb(0x6b2a22), { cell: 0.6, skip: '' });                // the door, shut, in the gap
  m.box(x0, x1, 1.05, 1.1, 0.0, 0.0, Cc.chrome, { cell: 2 });
  // Chrome rail along the back, left and right walls.
  m.box(x0, x1, 1.05, 1.1, D - 0.05, D, Cc.chrome, { cell: 1 });
  m.box(x0, x0 + 0.05, 1.05, 1.1, 0, D, Cc.chrome, { cell: 1 }); m.box(x1 - 0.05, x1, 1.05, 1.1, 0, D, Cc.chrome, { cell: 1 });
  // Windows over the booths on the right wall.
  for (const [a, b] of [[1.5, 3.6], [4.6, 6.8]]) {
    m.face([x1 - 0.003, 1.4, a], [0, 0, b - a], [0, 1.1, 0], [-1, 0, 0], (i, j) => mul(rgb(j > 0 ? 0x1c2f5e : 0x2a2f55), 1 + hash(i, j) * 0.25), 0.7, 1.15);
    m.box(x1 - 0.06, x1, 1.34, 1.4, a - 0.05, b + 0.05, Cc.chrome, { cell: 2 }); m.box(x1 - 0.06, x1, 2.5, 2.56, a - 0.05, b + 0.05, Cc.chrome, { cell: 2 });
    m.box(x1 - 0.06, x1, 1.4, 2.5, a - 0.05, a, Cc.chrome, { cell: 2 }); m.box(x1 - 0.06, x1, 1.4, 2.5, b, b + 0.05, Cc.chrome, { cell: 2 });
  }
  // The counter: base, top, chrome foot rail, stools.
  m.box(-3.6, 2.4, 0, 1.0, 7, 7.8, rgb(0xb3302a), { cell: 0.6 });
  m.box(-3.65, 2.45, 1.0, 1.08, 6.95, 7.85, rgb(0xe9e4d8), { cell: 0.6 });
  m.box(-3.55, 2.35, 0.2, 0.26, 6.9, 6.95, Cc.chrome, { cell: 2 });
  const seats: SeatSpec[] = [];
  for (const u of [-3, -2, -1, 0, 1]) {
    m.cyl(u, 6.4, 0.2, 0.62, 0.7, rgb(0xb3302a), 10); m.cyl(u, 6.4, 0.04, 0.05, 0.62, Cc.chrome, 6); m.cyl(u, 6.4, 0.18, 0, 0.05, Cc.chrome, 8);
    seats.push({ u, v: 6.4, h: 0, y: 0.68, kind: 'stool', taken: u === -2 || u === 1 });
  }
  // The kitchen: griddle shelf, hood, pass-through plates, coffee machine.
  m.box(-3.6, 2.4, 0, 0.95, 9.2, 9.95, Cc.chrome, { cell: 0.8 });
  m.box(-3.4, -0.4, 0.95, 1.0, 9.35, 9.85, rgb(0x2c2f33), { cell: 0.6 });
  m.box(-3.8, -1.2, 2.1, 2.6, 9.0, 9.95, rgb(0x8a9298), { cell: 0.8 });
  m.box(-0.9, -0.2, 1.0, 1.55, 9.4, 9.8, rgb(0x303236), { cell: 0.5 }); m.box(-1.5, -1.2, 1.0, 1.35, 9.45, 9.75, Cc.cream, { cell: 0.5 });
  for (let k = 0; k < 4; k++) m.cyl(-3.0 + k * 0.55, 7.4, 0.16, 1.08, 1.1, Cc.white, 8);   // plates on the counter
  m.box(-0.2, 0.2, 1.08, 1.5, 7.35, 7.65, Cc.chrome, { cell: 0.5 });                      // the napkin dispenser / syrup row
  // The pie case at the counter's end: chrome frame, two shelves of pies, lit.
  m.box(2.5, 3.5, 0, 1.0, 7, 7.8, rgb(0xb3302a), { cell: 0.6 });
  m.box(2.5, 3.5, 1.0, 1.05, 7, 7.8, Cc.chrome, { cell: 1 });
  for (const [a, b] of [[2.5, 7], [3.45, 7], [2.5, 7.75], [3.45, 7.75]]) m.box(a, a + 0.05, 1.05, 1.95, b, b + 0.05, Cc.chrome, { cell: 1 });
  m.box(2.5, 3.5, 1.45, 1.48, 7, 7.8, Cc.chrome, { cell: 1 }); m.box(2.5, 3.5, 1.93, 1.97, 7, 7.8, Cc.chrome, { cell: 1 });
  m.cyl(2.78, 7.4, 0.17, 1.05, 1.17, Cc.pie, 10, 1.1); m.cyl(3.22, 7.4, 0.17, 1.05, 1.17, Cc.berry, 10, 1.1);
  m.cyl(2.78, 7.4, 0.17, 1.48, 1.6, Cc.berry, 10, 1.15); m.cyl(3.22, 7.4, 0.17, 1.48, 1.6, rgb(0xe8cf86), 10, 1.15);
  m.box(2.52, 3.48, 1.97, 2.0, 7.02, 7.78, rgb(0xfff0c8), { cell: 1, emi: 1.4 });
  // Booths: two each side. The block is the bench, the table and the high backs.
  const folk: FolkSpec[] = [];
  const bx: number[][] = [];
  const boothAt = (wall: number, inward: number, c: number, npc: number): void => {
    const ua = wall, ub = wall + inward * 1.4, lo = Math.min(ua, ub), hi = Math.max(ua, ub);
    for (const sgn of [-1, 1]) {
      const va = c + sgn * 0.65, vb = c + sgn * 1.5;
      m.box(lo, hi, 0, 0.46, Math.min(va, vb), Math.max(va, vb), rgb(0xa32d27), { cell: 0.5 });
      m.box(lo, hi, 0.46, 1.15, sgn > 0 ? vb - 0.12 : vb, sgn > 0 ? vb : vb + 0.12, rgb(0xa32d27), { cell: 0.5 });
    }
    const t0 = wall + inward * 0.2, t1 = wall + inward * 1.25;
    m.box(Math.min(t0, t1), Math.max(t0, t1), 0.72, 0.76, c - 0.55, c + 0.55, rgb(0xe9e4d8), { cell: 0.5 });
    m.cyl((t0 + t1) / 2, c, 0.05, 0, 0.72, Cc.chrome, 6);
    const pu = wall + inward * 0.75;
    bx.push([Math.min(t0, t1), Math.max(t0, t1), c - 0.55, c + 0.55, 0, 0.8], [lo, hi, c + 1.4, c + 1.5, 0, 1.15], [lo, hi, c - 1.5, c - 1.4, 0, 1.15]);
    [-1, 1].forEach((sgn, k) => seats.push({ u: pu, v: c + sgn * 0.95, h: sgn > 0 ? Math.PI : 0, y: 0.46, kind: 'booth', taken: (npc >> k & 1) === 1 }));
    m.cyl(pu, c - 0.1, 0.03, 0.76, 0.86, Cc.chrome, 5); m.cyl(pu, c + 0.15, 0.04, 0.76, 0.84, Cc.mustard, 5);
  };
  boothAt(x1, -1, 2.6, 3); boothAt(x1, -1, 5.7, 1); boothAt(x0, 1, 5.7, 2);
  for (const s of seats) if (s.taken) folk.push({ u: s.u, v: s.v, h: s.h, y: s.y, pose: 'sit', role: 'customer' });
  // The jukebox on the left wall.
  m.box(x0 + 0.02, x0 + 0.62, 0, 1.55, 2.0, 3.0, rgb(0x6b1f4a), { cell: 0.5 });
  m.box(x0 + 0.1, x0 + 0.64, 0.95, 1.5, 2.06, 2.94, rgb(0xffd479), { cell: 0.3, emi: 1.7, skip: '-u' });
  for (let k = 0; k < 4; k++) m.box(x0 + 0.62, x0 + 0.66, 1.0, 1.45, 2.14 + k * 0.2, 2.22 + k * 0.2, [rgb(0xff3a7d), rgb(0x3be0d0), rgb(0xffe04a), rgb(0x7a5cff)][k], { cell: 0.3, emi: 2.2, skip: '-u' });
  m.cyl(x0 + 0.32, 2.5, 0.48, 1.55, 1.75, rgb(0x6b1f4a), 12);
  m.box(x0 + 0.62, x0 + 0.66, 0.15, 0.85, 2.1, 2.9, rgb(0x2a1020), { cell: 0.5, skip: '-u' });
  // Pendant lamps and the neon.
  for (const l of lamps.slice(0, 4)) pendant(m, l.u, l.v, 2.62, [1, 0.8, 0.5]);
  pendant(m, -1, 7.6, 2.55, [1, 0.8, 0.5]);
  decals.push({ tex: neon('DINER', '#ffe9f0', '#ff3a7d'), u: x0 + 0.04, y: 2.35, v: 2.5, w: 2.4, h: 0.75, face: '+u', k: 1.4 });
  decals.push({ tex: neon('PIE', '#e9fffd', '#27e0c8'), u: x1 - 0.04, y: 2.45, v: 8.4, w: 1.4, h: 0.45, face: '-u', k: 1.3 });
  decals.push({ tex: neon('OPEN', '#fff3d0', '#ff7a2a'), u: -1.5, y: 2.05, v: 0.06, w: 1.0, h: 0.3, face: '+v', k: 1.4 });
  decals.push({ tex: board([['Coffee (free refills)', '$2'], ['Slice of pie', '$3'], ['Short stack', '$5'], ['Cheeseburger plate', '$7'], ['Meatloaf & mash', '$9']], 'TODAY AT THE SIDE DOOR', '#1d2b2a', '#f3ead2', '#f0b43c'), u: 1.0, y: 2.2, v: D - 0.04, w: 3.2, h: 1.0, face: '-v' });
  folk.push({ u: -1.4, v: 9.0, h: 0, y: 0, pose: 'stand', role: 'cook' });
  folk.push({ u: -2.8, v: 8.35, h: 0, y: 0, pose: 'stand', role: 'waitress', path: [[-2.8, 8.35], [1.6, 8.35], [1.6, 8.35], [-2.8, 8.35]] });
  const spec: RoomSpec = {
    w: W, d: D, h: H, entry: { u: -3, v: 1.3, h: 0 }, door: { u: -3, v: 0.8 },
    boxes: [[-3.65, 3.5, 6.95, 7.85, 0, 1.1], [-3.6, 2.4, 9.2, 10, 0, 1], [3.5, x1, 7.0, D, 0, 1.1], [x0, -3.6, 7.0, D, 0, 1.1], [x0, x0 + 0.62, 2.0, 3.0, 0, 1.6], ...bx],
    seats, folk, juke: { u: x0 + 1.3, v: 2.5 }, lamps,
  };
  return { spec, m, decals };
}

// ── The pub ─────────────────────────────────────────────────────────────────

function pub(): { spec: RoomSpec; m: Mesher; decals: Decal[] } {
  const W = 12, D = 11, H = 3.4, x0 = -W / 2, x1 = W / 2;
  const lamps: Lamp[] = [
    { u: -3, y: 2.7, v: 2.6, r: 1, g: 0.76, b: 0.5, i: 1.0, rad: 3.3 }, { u: 0.2, y: 2.7, v: 4.6, r: 1, g: 0.76, b: 0.5, i: 1.0, rad: 3.3 },
    { u: 0.2, y: 2.7, v: 7.4, r: 1, g: 0.76, b: 0.5, i: 0.95, rad: 3.3 }, { u: -3, y: 2.7, v: 6.8, r: 1, g: 0.76, b: 0.5, i: 0.85, rad: 3.3 },
    { u: 3.4, y: 2.4, v: 3.6, r: 1, g: 0.78, b: 0.5, i: 1.05, rad: 3 }, { u: 3.4, y: 2.4, v: 6.8, r: 1, g: 0.78, b: 0.5, i: 1.05, rad: 3 },
    { u: -5, y: 2.5, v: 5, r: 1, g: 0.9, b: 0.7, i: 1.5, rad: 2.2 },
    { u: -4.4, y: 3.0, v: 9.2, r: 1, g: 0.55, b: 0.2, i: 1.2, rad: 3 }, { u: -1.6, y: 3.0, v: 9.2, r: 0.95, g: 0.3, b: 0.6, i: 1, rad: 3 },
  ];
  const m = new Mesher(lamps, [0.22, 0.16, 0.12]);
  const decals: Decal[] = [];
  const plank = (i: number, j: number): RGB => mul(rgb(0x5a3a26), 0.8 + hash(i, j * 5) * 0.4);
  m.face([x0, 0, 0], [W, 0, 0], [0, 0, D], [0, 1, 0], plank, 0.4);
  m.face([x0, H, 0], [W, 0, 0], [0, 0, D], [0, -1, 0], rgb(0x3a2619), 1);
  for (let u = x0 + 1.5; u < x1; u += 2.5) m.box(u, u + 0.25, H - 0.25, H, 0, D, rgb(0x2c1b11), { cell: 1, skip: '+y' });
  const brick = (i: number, j: number): RGB => { const y = (j + 0.5) * 0.3; if (y < 1.25) return mul(rgb(0x4b2f1f), 0.9 + hash(i, j) * 0.15); return mul(rgb(0x6e4636), 0.88 + hash(i + (j & 1) * 3, j) * 0.26); };
  m.face([x0, 0, D], [W, 0, 0], [0, H, 0], [0, 0, -1], brick, 0.3);
  m.face([x0, 0, 0], [0, 0, D], [0, H, 0], [1, 0, 0], brick, 0.3);
  m.face([x1, 0, D], [0, 0, -D], [0, H, 0], [-1, 0, 0], brick, 0.3);
  const sw = (a: number, b: number, y0: number, y1: number): void => m.face([a, y0, 0.001], [b - a, 0, 0], [0, y1 - y0, 0], [0, 0, 1], (i, j) => brick(i, j + Math.round(y0 / 0.3)), 0.3);
  sw(x0, -4.15, 0, H); sw(-2.85, -1.2, 0, H); sw(-1.2, 1.2, 0, 1.1); sw(-1.2, 1.2, 2.4, H); sw(1.2, 1.8, 0, H); sw(1.8, 4.2, 0, 1.1); sw(1.8, 4.2, 2.4, H); sw(4.2, x1, 0, H); sw(-4.15, -2.85, 2.4, H);
  for (const [a, b] of [[-1.2, 1.2], [1.8, 4.2]]) {
    m.face([a, 1.1, 0.002], [b - a, 0, 0], [0, 1.3, 0], [0, 0, 1], rgb(0x3b2a12), 0.6, 1.1);
    m.box(a - 0.06, b + 0.06, 1.04, 1.12, 0, 0.12, rgb(0x2c1b11), { cell: 2 });
    m.box(a - 0.06, b + 0.06, 2.38, 2.46, 0, 0.12, rgb(0x2c1b11), { cell: 2 });
  }
  m.box(-4.12, -2.88, 0, 2.4, 0, 0.07, rgb(0x3c2415), { cell: 0.6 });
  // Wood rail along the panelling.
  m.box(x0, x1, 1.25, 1.31, D - 0.04, D, rgb(0x2c1b11), { cell: 2 });
  m.box(x0, x0 + 0.04, 1.25, 1.31, 0, D, rgb(0x2c1b11), { cell: 2 }); m.box(x1 - 0.04, x1, 1.25, 1.31, 0, D, rgb(0x2c1b11), { cell: 2 });
  const seats: SeatSpec[] = [], folk: FolkSpec[] = [];
  // The bar on the right wall: counter, brass rail, taps, the back bar with its bottles and mirror.
  m.box(3.6, 4.5, 0, 1.08, 2.0, 8.6, rgb(0x4a2c18), { cell: 0.6 });
  m.box(3.5, 4.6, 1.08, 1.16, 1.9, 8.7, rgb(0x7a4a28), { cell: 0.6 });
  m.box(3.52, 3.56, 0.25, 0.3, 2.0, 8.6, Cc.brass, { cell: 2 });
  for (const v of [3.9, 4.4, 4.9, 5.4]) { m.cyl(4.1, v, 0.035, 1.16, 1.42, Cc.brass, 6); m.box(3.9, 4.1, 1.38, 1.44, v - 0.03, v + 0.03, Cc.brass, { cell: 1 }); }
  for (const v of [3.0, 4.2, 5.4, 6.6, 7.8]) {
    m.cyl(3.0, v, 0.21, 0.64, 0.72, rgb(0x6b2a1f), 10); m.cyl(3.0, v, 0.04, 0.05, 0.64, Cc.dark, 6); m.cyl(3.0, v, 0.18, 0, 0.05, Cc.dark, 8);
    seats.push({ u: 3.0, v, h: Math.PI / 2, y: 0.7, kind: 'stool', taken: v === 4.2 || v === 6.6 });
  }
  m.box(5.55, 6, 0, 1.0, 2.2, 8.2, rgb(0x3a2214), { cell: 0.6 });
  m.box(5.5, 6, 1.0, 1.06, 2.15, 8.25, rgb(0x6a4126), { cell: 0.6 });
  for (const y of [1.55, 2.05]) m.box(5.62, 5.98, y, y + 0.05, 2.3, 8.1, rgb(0x6a4126), { cell: 0.6 });
  const bottle = [rgb(0x7a3b12), rgb(0xd9822b), rgb(0x2f8a4e), rgb(0xd8d2c0), rgb(0x9b3a22), rgb(0x2f6fa8)];
  for (let k = 0; k < 14; k++) for (const [y, o] of [[1.6, 0], [2.1, 3]] as [number, number][]) m.cyl(5.8, 2.45 + k * 0.4, 0.05, y, y + 0.28, bottle[(k + o) % bottle.length], 6, 0.55);
  m.face([5.995, 1.2, 3], [0, 0, 4.5], [0, 1.4, 0], [-1, 0, 0], rgb(0x6e8794), 0.5, 0.55);
  // The stage on the back wall: platform, kit, amps, mic.
  m.box(-5.7, -0.3, 0, 0.4, 8.0, D, rgb(0x2c1b11), { cell: 0.5 });
  m.box(-5.7, -0.3, 0.4, 0.43, 8.0, D, rgb(0x5a3a24), { cell: 0.5, skip: '' });
  m.cyl(-1.6, 10.0, 0.3, 0.43, 0.9, rgb(0xa32d27), 12); m.cyl(-2.2, 10.2, 0.16, 0.9, 1.0, Cc.white, 10); m.cyl(-1.0, 10.2, 0.16, 0.9, 1.0, Cc.white, 10);
  m.cyl(-2.4, 9.7, 0.015, 0.43, 1.4, Cc.chrome, 4); m.disc(-2.4, 9.7, 0.2, 1.4, Cc.brass, 10); m.cyl(-0.7, 9.7, 0.015, 0.43, 1.3, Cc.chrome, 4); m.disc(-0.7, 9.7, 0.18, 1.3, Cc.brass, 10);
  m.cyl(-1.4, 9.2, 0.18, 0.43, 0.75, rgb(0x4a2c18), 8);
  m.box(-5.5, -4.8, 0.43, 1.2, 9.9, 10.5, rgb(0x1a1a1c), { cell: 0.5 }); m.box(-5.45, -4.85, 0.9, 1.1, 9.88, 9.9, rgb(0x6a6a70), { cell: 0.5 });
  m.box(-3.9, -3.2, 0.43, 1.0, 10.2, 10.7, rgb(0x1a1a1c), { cell: 0.5 });
  m.cyl(-3.0, 8.5, 0.015, 0.43, 1.55, Cc.chrome, 4); m.box(-3.03, -2.97, 1.5, 1.6, 8.5, 8.58, Cc.dark, { cell: 1 });
  // Darts: the board on the left wall, the line on the floor, a chalk board of scores.
  m.box(x0 + 0.02, x0 + 0.1, 1.45, 2.05, 4.7, 5.3, rgb(0x2c1b11), { cell: 1 });
  m.box(-3.62, -3.58, 0.0, 0.012, 3.5, 6.5, rgb(0xe6e0d0), { cell: 3, skip: '' });
  decals.push({ tex: dartboardTex(), u: x0 + 0.115, y: 1.75, v: 5.0, w: 0.55, h: 0.55, face: '+u', k: 1.15 });
  decals.push({ tex: board([['Bram', '412'], ['Walt', '388'], ['You', '?']], 'DARTS', '#222a22', '#f2ecd8', '#f0b43c'), u: x0 + 0.04, y: 1.9, v: 6.7, w: 0.9, h: 0.56, face: '+u', k: 0.95 });
  // Tables with stools.
  const table = (u: number, v: number, sit: number): void => {
    m.cyl(u, v, 0.48, 0.74, 0.79, rgb(0x6a4126), 14); m.cyl(u, v, 0.05, 0, 0.74, rgb(0x2c1b11), 6); m.cyl(u, v, 0.28, 0, 0.04, rgb(0x2c1b11), 8);
    [[-1.0, 0], [1.0, 0]].forEach(([d], k) => {
      const su = u + d, sv = v;
      m.cyl(su, sv, 0.2, 0.42, 0.48, rgb(0x6b2a1f), 10); m.cyl(su, sv, 0.04, 0, 0.42, rgb(0x2c1b11), 5);
      seats.push({ u: su, v: sv, h: d < 0 ? Math.PI / 2 : -Math.PI / 2, y: 0.48, kind: 'stool', taken: (sit >> k & 1) === 1 });
    });
    m.cyl(u - 0.1, v + 0.12, 0.05, 0.79, 0.88, Cc.white, 6);
  };
  table(-1.8, 3.4, 1); table(0.6, 6.0, 2);
  for (const s of seats) if (s.taken) folk.push({ u: s.u, v: s.v, h: s.h, y: s.y, pose: 'sit', role: 'customer' });
  // Pendants over the tables and bar, the stage lamps.
  for (const l of lamps.slice(0, 6)) pendant(m, l.u, l.v, l.y - 0.05, [1, 0.72, 0.42]);
  for (const l of lamps.slice(7)) { m.cyl(l.u, l.v, 0.2, l.y, l.y + 0.3, Cc.dark, 8); m.disc(l.u, l.v, 0.16, l.y - 0.01, [l.r, l.g, l.b], 8, 2.2, -1); }
  decals.push({ tex: neon('HOG WALLOW', '#fff1d6', '#ff9a3c'), u: x1 - 0.06, y: 2.85, v: 5.6, w: 3.2, h: 0.62, face: '-u', k: 1.3 });
  decals.push({ tex: neon('OPEN', '#e9ffe9', '#3cd870'), u: -1.5, y: 2.05, v: 0.06, w: 1.0, h: 0.3, face: '+v', k: 1.4 });
  decals.push({ tex: board([['Ginger ale', '$2'], ['Root beer float', '$3'], ['Soft pretzel', '$4'], ["Shepherd's pie", '$8']], 'ON TAP & IN THE KITCHEN', '#17251d', '#f3ead2', '#7fd1a0'), u: 4.6, y: 2.35, v: 2.04, w: 1.8, h: 1.1, face: '+v', k: 1 });
  decals.push({ tex: canvasTex(512, 200, (g) => {
    g.fillStyle = '#2b1a2e'; g.fillRect(0, 0, 512, 200); g.strokeStyle = '#f0b43c'; g.lineWidth = 8; g.strokeRect(8, 8, 496, 184);
    g.fillStyle = '#f0b43c'; g.font = `800 52px ${FONT}`; g.textAlign = 'center'; g.fillText('LIVE MUSIC', 256, 76);
    g.fillStyle = '#f6efe0'; g.font = `700 42px ${FONT}`; g.fillText(BAND.name.toUpperCase(), 256, 126);
    g.font = `600 28px ${FONT}`; g.fillText('Thursday, Friday, Saturday nights', 256, 166);
  }), u: -3, y: 2.35, v: D - 0.04, w: 3.4, h: 1.3, face: '-v', k: 1 });
  folk.push({ u: 5.0, v: 5.2, h: -Math.PI / 2, y: 0, pose: 'stand', role: 'landlord' });
  folk.push({ u: -2.9, v: 5.9, h: -Math.PI / 2, y: 0, pose: 'stand', role: 'regular' });
  folk.push({ u: -3.0, v: 8.9, h: Math.PI, y: 0.43, pose: 'stand', role: 'band', band: true });
  folk.push({ u: -4.3, v: 9.0, h: Math.PI, y: 0.43, pose: 'stand', role: 'band', band: true });
  folk.push({ u: -1.4, v: 9.2, h: 0, y: 0.75, pose: 'sit', role: 'band', band: true });
  const spec: RoomSpec = {
    w: W, d: D, h: H, entry: { u: -3.5, v: 1.3, h: 0 }, door: { u: -3.5, v: 0.8 },
    boxes: [[3.5, 4.6, 1.9, 8.7, 0, 1.2], [5.5, 6, 2.15, 8.25, 0, 1.2], [4.6, 6, 1.8, 2.1, 0, 1.2], [4.6, 6, 8.2, 8.8, 0, 1.2], [-5.7, -0.3, 8.0, D, 0, 0.5], [x0, x0 + 0.1, 4.7, 5.3, 0, 2.1], [-2.3, -1.3, 2.9, 3.9, 0, 0.8], [0.1, 1.1, 5.5, 6.5, 0, 0.8]],
    seats, folk, darts: { u: -3.2, v: 5, h: -Math.PI / 2 }, lamps,
  };
  return { spec, m, decals };
}

/** Put a built room's mesh and boards together (also for the civic rooms, world/civicRooms.ts). */
export function assemble<S>(name: string, spec: S, m: Mesher, decals: Decal[]): { group: THREE.Group; spec: S; dispose(): void; tris: number } {
  const group = new THREE.Group();
  group.name = name;
  const geo = m.build();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const main = new THREE.Mesh(geo, mat); main.name = 'room'; main.frustumCulled = false;
  main.onBeforeRender = () => { nightBloom.scale = 0; };
  group.add(main);
  const disposers: (() => void)[] = [() => { geo.dispose(); mat.dispose(); }];
  const quad = new THREE.PlaneGeometry(1, 1);
  disposers.push(() => quad.dispose());
  for (const d of decals) {
    const dm = new THREE.MeshBasicMaterial({ map: d.tex, transparent: true, fog: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    dm.color.setScalar(d.k ?? 1);
    const mesh = new THREE.Mesh(quad, dm);
    mesh.scale.set(d.w, d.h, 1); mesh.position.set(d.u, d.y, d.v); mesh.renderOrder = 3; mesh.frustumCulled = false;
    mesh.rotation.y = d.face === '+u' ? Math.PI / 2 : d.face === '-u' ? -Math.PI / 2 : d.face === '+v' ? 0 : Math.PI;
    group.add(mesh);
    disposers.push(() => { dm.dispose(); d.tex.dispose(); });
  }
  return { group, spec, tris: m.idx.length / 3, dispose: () => { for (const f of disposers) f(); } };
}

/** Build one room's meshes. */
export function buildRoom(id: VenueId): Room {
  const { spec, m, decals } = id === 'diner' ? diner() : pub();
  return assemble('night-' + id, spec, m, decals);
}
