// Blade signs for the placed businesses (world/business.ts): one small board hung on the wall at each door, jutting over the
// sidewalk, the game's name for the place on both faces. All of them are one mesh with one atlas texture: one draw call,
// nothing moves, nothing is done per frame.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { places, CATEGORIES, type Category } from './business';
import { groundAt } from './plan';

const CW = 256, CH = 64, COLS = 8;
/** One tint per category, for the stripe at the board's end. */
export const CAT_COLOR: Record<Category, string> = {
  food: '#e4572e', shops: '#f0a202', services: '#2a9d8f', health: '#d1495b', worship: '#6d597a', schools: '#3d5a80', civic: '#14213d',
  lodging: '#8a9a6b', fuel: '#5c6b73', auto: '#a44a3f', banks: '#2f6f4e', offices: '#7b6d8d', leisure: '#4f9d69',
};

/** Fit a name on one or two lines inside a cell. */
function drawCell(c: CanvasRenderingContext2D, name: string, cat: Category, ox: number, oy: number): void {
  c.fillStyle = '#f2e8cf'; c.fillRect(ox, oy, CW, CH);
  c.fillStyle = CAT_COLOR[cat]; c.fillRect(ox, oy, 12, CH);
  c.strokeStyle = '#14213d'; c.lineWidth = 4; c.strokeRect(ox + 2, oy + 2, CW - 4, CH - 4);
  c.fillStyle = '#14213d'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const font = (px: number): string => `700 ${px}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
  const cx = ox + 12 + (CW - 12) / 2, maxW = CW - 12 - 14;
  // One line if it fits at a readable size, else two.
  for (let px = 34; px >= 25; px--) { c.font = font(px); if (c.measureText(name).width <= maxW) { c.fillText(name, cx, oy + CH / 2 + 1); return; } }
  // Two lines at the space nearest the middle.
  const words = name.split(' ');
  let best = 1, bd = 1e9;
  for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length); if (d < bd) { bd = d; best = i; } }
  const l1 = words.slice(0, best).join(' '), l2 = words.slice(best).join(' ');
  let px = 27;
  c.font = font(px);
  while (px > 11 && Math.max(c.measureText(l1).width, c.measureText(l2).width) > maxW) { px--; c.font = font(px); }
  c.fillText(l1, cx, oy + CH / 2 - px * 0.52); c.fillText(l2, cx, oy + CH / 2 + px * 0.52);
}

export class ShopSigns {
  readonly mesh: THREE.Mesh | null = null;
  readonly count: number;

  constructor(game: Game) {
    const list = places(game.plan).filter((p) => p.placed && p.sign);
    this.count = list.length;
    if (!list.length) return;
    const rows = Math.ceil(list.length / COLS);
    const cv = document.createElement('canvas');
    cv.width = COLS * CW; cv.height = rows * CH;
    const c = cv.getContext('2d') as CanvasRenderingContext2D;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    list.forEach((p, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      drawCell(c, p.name, p.cat, col * CW, row * CH);
      const nx = p.nx, nz = p.nz, tx = -nz, tz = nx;
      const gy = groundAt(p.x, p.z) + 2.7, h = 0.5, len = 2.0;
      // Wall end and street end of the board, bottom and top.
      const w0 = [p.wx + nx * 0.06, gy, p.wz + nz * 0.06], o0 = [p.wx + nx * (0.06 + len), gy, p.wz + nz * (0.06 + len)];
      const w1 = [w0[0], gy + h, w0[2]], o1 = [o0[0], gy + h, o0[2]];
      const U = (u: number): number => (col + u) / COLS, V = (v: number): number => 1 - (row + (1 - v)) / rows;
      const base = pos.length / 3;
      const add = (q: number[][], off: number, uvs: number[][]): void => {
        for (let k = 0; k < 4; k++) { pos.push(q[k][0] + tx * off, q[k][1], q[k][2] + tz * off); uv.push(U(uvs[k][0]), V(uvs[k][1])); }
      };
      // Face A is read from the +t side (the wall on its left), face B from the -t side.
      add([w0, o0, o1, w1], 0.02, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      add([o0, w0, w1, o1], -0.02, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      for (let f = 0; f < 2; f++) { const b = base + f * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide }));
    m.name = 'shop-signs';
    m.frustumCulled = true;
    m.matrixAutoUpdate = false;
    this.mesh = m;
    game.scene.add(m);
    // The type is drawn once the web fonts are in, in case they were not at first.
    void document.fonts?.ready.then(() => {
      list.forEach((p, i) => drawCell(c, p.name, p.cat, (i % COLS) * CW, Math.floor(i / COLS) * CH));
      tex.needsUpdate = true;
    });
  }
}
void CATEGORIES;
