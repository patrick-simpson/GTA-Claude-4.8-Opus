// Gathers the cars' baked maps into two ready-made sheets, offline, so the asset pipeline can compress them to KTX2:
//   public/models/cars_sheet_n.webp  (x, y of tangent normals in red and green)
//   public/models/cars_sheet_o.webp  (occlusion in all three channels)
// Layout = vehicleAssets.ts: 4 x 4 cells of 1024 texels, one per kind of TEX_KINDS in reading order, row 0 on top.
// A kind without its pictures leaves a flat cell (normal 128,128; occlusion 255), exactly as the runtime does.
// cars.py runs this after every export; run it alone after editing any <kind>_n.webp / <kind>_o.webp:
//   node tools/assets/carsheet.mjs
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = path.join(ROOT, 'public', 'models');
const KINDS = ['sedan', 'hatch', 'coupe', 'muscle', 'sports', 'pickup', 'van', 'taxi', 'tow', 'bus', 'cruiser', 'bolt', 'cmax'];
const COLS = 4, ROWS = 4, CELL = 1024, W = COLS * CELL, H = ROWS * CELL;
const n = Buffer.alloc(W * H * 3), o = Buffer.alloc(W * H * 3, 255);
for (let i = 0; i < W * H; i++) { n[i * 3] = 128; n[i * 3 + 1] = 128; n[i * 3 + 2] = 255; }

async function read(file) {
  const f = path.join(M, file);
  if (!fs.existsSync(f)) return null;
  const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== CELL || info.height !== CELL || info.channels !== 3) { console.warn(file, 'is', info.width, 'x', info.height, 'x', info.channels, '- left flat'); return null; }
  return data;
}
function put(sheet, data, cx, cy, rebuildB) {
  for (let y = 0; y < CELL; y++) {
    const dst = ((cy * CELL + y) * W + cx * CELL) * 3, src = y * CELL * 3;
    data.copy(sheet, dst, src, src + CELL * 3);
    if (rebuildB) for (let x = 0; x < CELL; x++) sheet[dst + x * 3 + 2] = 255;
  }
}
let have = 0;
for (let i = 0; i < KINDS.length; i++) {
  const [cx, cy] = [i % COLS, Math.floor(i / COLS)];
  const [nd, od] = [await read(KINDS[i] + '_n.webp'), await read(KINDS[i] + '_o.webp')];
  if (nd) { put(n, nd, cx, cy, true); have++; }
  if (od) { put(o, od, cx, cy, false); have++; }
}
await sharp(n, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 96, smartSubsample: false, effort: 6 }).toFile(path.join(M, 'cars_sheet_n.webp'));
await sharp(o, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 92, effort: 6 }).toFile(path.join(M, 'cars_sheet_o.webp'));
console.log('cars_sheet_n.webp and cars_sheet_o.webp written from', have, 'pictures');
