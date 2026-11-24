// Blade signs for the placed businesses (world/business.ts): one small board hung on the wall at each door, jutting over the
// sidewalk, the game's name for the place on both faces. All of them are one mesh with one atlas texture: one draw call,
// nothing moves, nothing is done per frame.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { places, CATEGORIES, type Category } from './business';
import { mainlandLots, TOWN_NIGHT, type Door } from './mainlandBuildings';
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

/** Sign boards: [board, lettering, rule]. */
const BOARDS: [string, string, string][] = [
  ['#22392d', '#f1e6c4', '#c9a54a'], ['#5a1f1a', '#f4ead2', '#d9b25c'], ['#1d2f4f', '#f3f1e8', '#8fa7c9'], ['#1c1d1f', '#e8c770', '#e8c770'],
  ['#efe6cc', '#3a2418', '#7a2a22'], ['#255250', '#f2efe2', '#9cc7c0'], ['#c9982f', '#1c1d1f', '#1c1d1f'], ['#f4f2ea', '#a3211c', '#a3211c'],
  ['#a3211c', '#fbf6e6', '#fbf6e6'], ['#3d3a36', '#f2efe6', '#b0aca2'], ['#f1ead6', '#1d2f4f', '#1d2f4f'], ['#4a2d52', '#f0e6d0', '#c9a54a'],
];
/**
 * Names for the shopfronts no business in the directory took (each used once; when they run out a fascia stays bare).
 * None of them is in directory.ts or on Main St.
 */
const SPARE = [
  'Second Guess Thrift', 'Borrowed Time Clock Repair', 'Loose Ends Yarn', 'The Spare Button', 'Mostly Lamps', 'Slight Return Records', 'Even Keel Marine Supply',
  'Low Tide Bait & Tackle', 'Off Season Sporting Goods', 'Nearly New Furniture', 'Last Call Vacuum Repair', 'Lukewarm Hot Tubs', 'Fine Print Copy Shop',
  'Good Enough Auto Glass', 'Half Measure Tailoring', 'The Missing Sock Laundromat', 'Rain Check Umbrellas', 'Tepid Tan', 'Soft Opening Mattress Outlet',
  'Small Change Coin Laundry', 'Idle Hands Hobby Shop', 'Dog Eared Books', 'Snowed In Ski Tune', 'Back Burner Stove Shop', 'Mud Season Boots',
  'Out To Lunch Deli', 'Paper Trail Stationers', 'Blunt Instrument Music', 'Keys While You Wait A While', 'Stale Mate Chess & Games', 'Frost Heave Tire',
  'Shut Eye Bedding', 'Bitter End Rope & Chain', 'The Dented Can', 'Wicked Decent Pizza', 'Upta Camp Outfitters', 'Dooryard Garden Supply', 'Ayuh Appliance',
  'Number Nine Seafood', 'Black Fly Screen Repair', 'Whoopie Pie Works', 'Cant Get There Travel', 'Moxie & Sons Plumbing', 'Flatlander Rentals', 'Yard Sale Every Day',
  'Cold Snap Heating Oil', 'Lobster Trap Storage', 'Red Hot Dog Stand', 'Punt & Paddle', 'Two Lights Electric', 'Sap Run Syrup Supply', 'Blueberry Rake Hardware',
  'Thaw Auto Body', 'Driftwood Framing', 'Fiddlehead Grocery', 'Chowdah House', 'Granite State Of Mind Gifts', 'North Of Normal Vape', 'Leaf Peeper Optical',
  'Plow Guy Supply', 'Storm Door City', 'The Woodpile', 'Camp Road Carpets', 'Ice Out Fishing Co', 'Town Line Redemption', 'Bean Supper Catering',
];

/** A sign board with a name on it, in one of the BOARDS colours. */
function drawBoard(c: CanvasRenderingContext2D, name: string, ox: number, oy: number, k: number): void {
  const [bg, fg, rule] = BOARDS[k % BOARDS.length], serif = (k >> 4) % 3 === 1, caps = (k >> 6) % 2 === 0;
  c.fillStyle = bg; c.fillRect(ox, oy, CW, CH);
  c.strokeStyle = rule; c.lineWidth = 2; c.strokeRect(ox + 5, oy + 5, CW - 10, CH - 10);
  c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  const text = caps ? name.toUpperCase() : name;
  const font = (px: number): string => (serif ? `italic 700 ${px}px Georgia, "Times New Roman", serif` : `700 ${px}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`);
  const cx = ox + CW / 2, maxW = CW - 26;
  for (let px = caps ? 30 : 34; px >= 21; px--) { c.font = font(px); if (c.measureText(text).width <= maxW) { c.fillText(text, cx, oy + CH / 2 + 1); return; } }
  const words = text.split(' ');
  let best = 1, bd = 1e9;
  for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length); if (d < bd) { bd = d; best = i; } }
  const l1 = words.slice(0, best).join(' '), l2 = words.slice(best).join(' ');
  let px = 23;
  c.font = font(px);
  while (px > 10 && Math.max(c.measureText(l1).width, c.measureText(l2).width) > maxW) { px--; c.font = font(px); }
  c.fillText(l1, cx, oy + CH / 2 - px * 0.54); c.fillText(l2, cx, oy + CH / 2 + px * 0.54);
}

export class ShopSigns {
  readonly mesh: THREE.Mesh | null = null;
  /** The sign boards over the footprint buildings' doors (and the lamps over the plain doors): one mesh, one atlas. */
  readonly boards: THREE.Mesh | null = null;
  readonly count: number;
  /** For the checks: boards lettered for a business, boards given a spare name, boards left bare. */
  stats = { named: 0, spare: 0, bare: 0, lamps: 0 };

  /** The boards over the doors: the business that took the door, else a spare name, each name once in town. */
  private fascias(game: Game): THREE.Mesh | null {
    const jobs: { d: Door; name: string }[] = [], lamps: Door[] = [], taken = new Set<Door>();
    for (const p of places(game.plan)) if (p.placed && p.fascia) { jobs.push({ d: p.fascia, name: p.name }); taken.add(p.fascia); }
    this.stats.named = jobs.length;
    let sp = 0;
    for (const l of mainlandLots(game.plan)) for (const d of l.doors ?? []) {
      if (d.ly) lamps.push(d);
      if (taken.has(d) || d.opt || d.sw <= 0) continue;
      if (sp < SPARE.length) { jobs.push({ d, name: SPARE[sp++] }); this.stats.spare++; } else this.stats.bare++;
    }
    this.stats.lamps = lamps.length;
    if (!jobs.length && !lamps.length) return null;
    const SC = game.quality.lean ? 0.5 : 1, rows = Math.ceil((jobs.length + 1) / COLS);
    const cv = document.createElement('canvas');
    cv.width = COLS * CW * SC; cv.height = rows * CH * SC;
    const c = cv.getContext('2d') as CanvasRenderingContext2D;
    c.scale(SC, SC);
    const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
    const paint = (): void => {
      c.fillStyle = '#ffedc4'; c.fillRect(0, 0, CW, CH); // cell 0: the lamps' warm white
      jobs.forEach((j, i) => drawBoard(c, j.name, ((i + 1) % COLS) * CW, Math.floor((i + 1) / COLS) * CH, hash(j.name)));
    };
    paint();
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const quad = (cx: number, y: number, cz: number, nx: number, nz: number, w: number, h: number, cell: number, inset: number): void => {
      const tx = nz, tz = -nx, col = cell % COLS, row = Math.floor(cell / COLS), b = pos.length / 3;
      const u0 = (col + inset) / COLS, u1 = (col + 1 - inset) / COLS, v0 = 1 - (row + 1 - inset) / rows, v1 = 1 - (row + inset) / rows;
      pos.push(cx - tx * w / 2, y, cz - tz * w / 2, cx + tx * w / 2, y, cz + tz * w / 2, cx + tx * w / 2, y + h, cz + tz * w / 2, cx - tx * w / 2, y + h, cz - tz * w / 2);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    jobs.forEach((j, i) => quad(j.d.sx, j.d.sy, j.d.sz, j.d.nx, j.d.nz, j.d.sw, j.d.sh, i + 1, 0));
    for (const d of lamps) quad(d.x + d.nx * 0.07, d.ly ?? 0, d.z + d.nz * 0.07, d.nx, d.nz, 0.36, 0.13, 0, 0.3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
    const m = new THREE.Mesh(g, mat);
    m.name = 'shop-boards'; m.matrixAutoUpdate = false;
    // Unlit boards: by day as painted, after dark as a sign with a lamp on it (dimmer, so the bloom does not burn the lettering out).
    m.onBeforeRender = () => { const k = 1 - 0.3 * TOWN_NIGHT.value; if (mat.color.r !== k) mat.color.setRGB(k, k, k); };
    game.scene.add(m);
    void document.fonts?.ready.then(() => { paint(); tex.needsUpdate = true; });
    return m;
  }

  constructor(game: Game) {
    const list = places(game.plan).filter((p) => p.placed && p.sign);
    this.boards = this.fascias(game);
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
    const bmat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
    const m = new THREE.Mesh(g, bmat);
    // Painted boards with no lamp of their own: they go down with the daylight.
    m.onBeforeRender = () => { const k = 1 - 0.55 * TOWN_NIGHT.value; if (bmat.color.r !== k) bmat.color.setRGB(k, k, k); };
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
