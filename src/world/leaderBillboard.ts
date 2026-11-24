// Fun queue item 15: the leaderboard billboard. A lit 2:1 board on a single mast, the face a canvas painted as a
// Harbor Authority notice (bone paper, ink rules, a vermilion stamp), one category at a time (game/leaderboard.ts
// decides the page and when it turns). Readable from the street: five rows, big type.
//
// Cost: one canvas texture (1024 x 512) per board, repainted only when the page turns (every few seconds); a handful of
// meshes. The face is unlit (MeshBasicMaterial), so it reads as floodlit by day and glows at night.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { groundAt } from './plan';
import type { BoardPage } from '../game/leaderboard';

const INK = '#14213d', BONE = '#f2e8cf', VERMILION = '#e4572e', MUSTARD = '#f0a202';
const W = 1024, H = 512;
const HEAD = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

export class LeaderBillboard {
  readonly group = new THREE.Group();
  /** The title of the page on the board, for the tests. */
  shown = '';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;

  constructor(game: Game, x: number, z: number, hd: number, w = 11, base = 6.8) {
    const g = groundAt(x, z), h = w / 2;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const steel = new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.55, metalness: 0.7 });
    const back = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.8, metalness: 0.3 });
    const face = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, color: 0xbdbdbd });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, px: number, py: number, pz: number): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz); m.castShadow = mat !== face; m.receiveShadow = false;
      this.group.add(m);
      return m;
    };
    // Mast, foot, the box behind the face, the face, a catwalk and three lamp heads.
    add(new THREE.BoxGeometry(0.8, base + h * 0.6, 0.8), steel, 0, (base + h * 0.6) / 2, -0.6);
    add(new THREE.BoxGeometry(1.3, 0.35, 1.3), back, 0, 0.17, -0.6);
    add(new THREE.BoxGeometry(w + 0.5, h + 0.5, 0.5), back, 0, base + h / 2, -0.15);
    add(new THREE.PlaneGeometry(w, h), face, 0, base + h / 2, 0.11);
    add(new THREE.BoxGeometry(w, 0.1, 1), steel, 0, base - 0.5, 0.6);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, toneMapped: false });
    for (const lx of [-w / 3, 0, w / 3]) {
      add(new THREE.BoxGeometry(0.4, 0.22, 0.55), back, lx, base - 0.35, 1.3);
      add(new THREE.BoxGeometry(0.3, 0.04, 0.42), lampMat, lx, base - 0.47, 1.3);
    }
    this.group.position.set(x, g, z);
    this.group.rotation.y = hd;
    game.scene.add(this.group);
    this.group.updateMatrixWorld(true);
    for (const o of this.group.children) o.matrixAutoUpdate = false;
    // The mast stops cars and people.
    const mx = x - Math.sin(hd) * 0.6, mz = z - Math.cos(hd) * 0.6;
    game.col.addProp(mx, mz, 0.55, base, 'post', false);
    try { void document.fonts.load(`700 80px ${HEAD}`).then(() => { if (this.last) this.paint(...this.last); }, () => {}); } catch { /* no font loading API */ }
  }

  private last: [BoardPage, number, number] | null = null;

  /** Paint a page: `n` of `of`. */
  paint(p: BoardPage, n: number, of: number): void {
    this.last = [p, n, of];
    this.shown = p.title;
    const c = this.ctx;
    c.fillStyle = BONE; c.fillRect(0, 0, W, H);
    // Ruled edge and a header band.
    c.strokeStyle = INK; c.lineWidth = 10; c.strokeRect(12, 12, W - 24, H - 24);
    c.fillStyle = INK; c.fillRect(12, 12, W - 24, 84);
    c.fillStyle = BONE; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = `800 60px ${HEAD}`;
    c.fillText(p.town ? 'TOWN RECORDS' : 'YOUR RECORDS', 36, 56);
    c.textAlign = 'right'; c.font = `500 24px ${MONO}`;
    c.fillText(`FORM LB-${String(n + 1).padStart(2, '0')} · ${n + 1}/${of}`, W - 36, 56);
    // The category.
    c.fillStyle = INK; c.textAlign = 'left'; c.font = `800 76px ${HEAD}`;
    fit(c, p.title.toUpperCase(), 36, 140, W - 72);
    c.fillStyle = MUSTARD; c.fillRect(36, 180, W - 72, 8);
    // Five rows.
    const rows = p.rows.slice(0, 5);
    const y0 = 224, step = 47;
    if (!rows.length) {
      c.fillStyle = INK; c.globalAlpha = 0.6; c.font = `600 40px ${MONO}`;
      c.fillText('NOTHING ON FILE. BE THE FIRST.', 40, y0 + step);
      c.globalAlpha = 1;
    }
    rows.forEach((r, i) => {
      const y = y0 + i * step;
      c.fillStyle = r.me ? VERMILION : INK;
      c.textAlign = 'left'; c.font = `700 44px ${MONO}`;
      c.fillText(`${i + 1}`, 36, y);
      c.font = `800 50px ${HEAD}`;
      fit(c, r.name, 84, y, 600);
      c.textAlign = 'right'; c.font = `700 46px ${MONO}`;
      fit2(c, p.fmt(r.v), W - 36, y, 300);
    });
    // Footer: your own, and the stamp.
    c.textAlign = 'left'; c.fillStyle = INK; c.font = `600 30px ${MONO}`;
    c.fillText(p.mine !== null ? `YOUR BEST: ${p.fmt(p.mine)}` : 'YOUR BEST: NONE FILED', 36, H - 42);
    c.save();
    c.translate(W - 130, H - 44); c.rotate(-0.12);
    c.strokeStyle = VERMILION; c.fillStyle = VERMILION; c.lineWidth = 5; c.globalAlpha = 0.85;
    c.strokeRect(-92, -21, 184, 42);
    c.font = `800 30px ${HEAD}`; c.textAlign = 'center';
    c.fillText('CERTIFIED', 0, 2);
    c.restore();
    this.tex.needsUpdate = true;
  }
}

/** Text squeezed to fit `maxW`. */
function fit(c: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number): void {
  const w = c.measureText(s).width;
  if (w <= maxW) { c.fillText(s, x, y); return; }
  c.save(); c.translate(x, y); c.scale(maxW / w, 1); c.fillText(s, 0, 0); c.restore();
}

/** Right-aligned text squeezed to fit `maxW`. */
function fit2(c: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number): void {
  const w = c.measureText(s).width;
  if (w <= maxW) { c.fillText(s, x, y); return; }
  c.save(); c.translate(x, y); c.scale(maxW / w, 1); c.fillText(s, 0, 0); c.restore();
}
