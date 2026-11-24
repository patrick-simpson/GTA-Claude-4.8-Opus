// The delivery files for src/ui/promo.ts, from the master the cut made:
//   promo_1080.mp4 (H.264 high, AAC)  promo_1080.webm (VP9, Opus)  promo_720.mp4  promo_720.webm
//
//   node tools/promo/encode.mjs [--in C:/Users/User/promo/final/promo_1080.mp4] [--out C:/Users/User/promo/deliver]
//   node tools/promo/encode.mjs --in C:/Users/User/promo/rough/promo_rough2.mp4 --out C:/Users/User/promo/standin --only 720
//
// Two-pass to a size budget (GitHub Pages: keep each under ~25 MB at 1080p, ~12 MB at 720p), so a busy promo never
// balloons. The files go in public/promo/ only when the lead ships the final (never the rough cut).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const IN = String(opt.in ?? 'C:/Users/User/promo/final/promo_1080.mp4');
const OUT = String(opt.out ?? 'C:/Users/User/promo/deliver');
fs.mkdirSync(OUT, { recursive: true });
const dur = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', IN]).stdout.toString().trim();
const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (r.status) throw new Error('ffmpeg failed'); };
const plans = [
  { h: 1080, mb: 24 }, { h: 720, mb: 11 },
].filter((p) => !opt.only || String(p.h) === String(opt.only));
for (const p of plans) {
  const audio = 160; // kbps
  const vk = Math.floor((p.mb * 8 * 1024) / dur - audio - 40);
  const scale = `scale=-2:${p.h}:flags=lanczos`;
  const log = path.join(os.tmpdir(), `promo-2pass-${p.h}`);
  const mp4 = path.join(OUT, `promo_${p.h}.mp4`), webm = path.join(OUT, `promo_${p.h}.webm`);
  ff(['-i', IN, '-vf', scale, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-b:v', `${vk}k`, '-pass', '1', '-passlogfile', log, '-an', '-f', 'mp4', 'NUL']);
  ff(['-i', IN, '-vf', scale, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-b:v', `${vk}k`, '-pass', '2', '-passlogfile', log, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${audio}k`, '-movflags', '+faststart', mp4]);
  ff(['-i', IN, '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', `${Math.floor(vk * 0.8)}k`, '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pass', '1', '-passlogfile', log + 'v', '-an', '-f', 'webm', 'NUL']);
  ff(['-i', IN, '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', `${Math.floor(vk * 0.8)}k`, '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pass', '2', '-passlogfile', log + 'v',
    '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', `${audio}k`, webm]);
  for (const f of [mp4, webm]) console.log(`${path.basename(f)}: ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}
