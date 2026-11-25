// Delivery files for src/ui/promo.ts from the Blender trailer's master (tools/trailer/cut.mjs). The trailer is rendered at
// 1280x720, 24 fps, so BOTH slots are 720p and nothing is upscaled: the desktop slot (promo_1080.*) is a high-bitrate
// 720p, the phone slot (promo_720.*) a lighter one. Size budgets as tools/promo/encode.mjs: under ~25 MB and ~12 MB.
//
//   node tools/trailer/encode.mjs [--in C:/Users/User/trailer/final/trailer_master.mp4] [--out C:/Users/User/trailer/deliver]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const IN = String(opt.in ?? 'C:/Users/User/trailer/final/trailer_master.mp4');
const OUT = String(opt.out ?? 'C:/Users/User/trailer/deliver');
fs.mkdirSync(OUT, { recursive: true });
const dur = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', IN]).stdout.toString().trim();
const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (r.status) throw new Error('ffmpeg failed'); };
for (const p of [{ slot: 1080, mb: 22 }, { slot: 720, mb: 10.5 }]) {
  const audio = 160;
  const vk = Math.floor((p.mb * 8 * 1024) / dur - audio - 40);
  const log = path.join(os.tmpdir(), `trailer-2pass-${p.slot}`);
  const mp4 = path.join(OUT, `promo_${p.slot}.mp4`), webm = path.join(OUT, `promo_${p.slot}.webm`);
  const x264 = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-b:v', `${vk}k`, '-maxrate', `${Math.floor(vk * 1.8)}k`, '-bufsize', `${vk * 3}k`];
  ff(['-i', IN, ...x264, '-pass', '1', '-passlogfile', log, '-an', '-f', 'mp4', 'NUL']);
  ff(['-i', IN, ...x264, '-pass', '2', '-passlogfile', log, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${audio}k`, '-movflags', '+faststart', mp4]);
  const vp9 = ['-c:v', 'libvpx-vp9', '-b:v', `${Math.floor(vk * 0.8)}k`, '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1'];
  ff(['-i', IN, ...vp9, '-pass', '1', '-passlogfile', log + 'v', '-an', '-f', 'webm', 'NUL']);
  ff(['-i', IN, ...vp9, '-pass', '2', '-passlogfile', log + 'v', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', `${audio}k`, webm]);
  for (const f of [mp4, webm]) console.log(`${path.basename(f)}: ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}
