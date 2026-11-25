// Cut the Blender trailer: the 19 rendered shots (tools/trailer/shots.json, S01..S19) hard-cut on the beat grid, no
// title cards and no words, a subtle grade, the 60 s edit of the music underneath. The last shot (from the final hit at
// 54.75 s) is the clean plate the game lays its live logo card over (src/ui/promo.ts), so it is left full frame; the
// rest is letterboxed to 2.39:1, as the first trailer was.
//
//   node tools/trailer/cut.mjs [--frames C:/Users/User/trailer/frames] [--out C:/Users/User/trailer/final/trailer_master.mp4]
//                              [--rough]  (missing shots become dark slates; without it a missing frame is an error)
//
// Frames: <frames>/<shot id>/f0001.png ... (Blender frame numbers, 24 fps, 1280x720). Shot lengths come from the same
// beat arithmetic as export.mjs (k0 and beats on tools/promo/storyboard.json's music.grid): 1440 frames in all.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const FPS = 24, W = +(opt.w ?? 1280), H = +(opt.h ?? 720), LEN = 60;
const FR = String(opt.frames ?? 'C:/Users/User/trailer/frames');
const OUT = String(opt.out ?? 'C:/Users/User/trailer/final/trailer_master.mp4');
const shots = JSON.parse(fs.readFileSync(path.join(here, 'shots.json'), 'utf8')).shots.filter((s) => s.k0 != null);
const music = JSON.parse(fs.readFileSync(path.join(here, '../promo/storyboard.json'), 'utf8')).music;
const grid = music.grid;
const at = (k) => (k <= 0 ? 0 : k >= grid.length ? LEN : grid[k]);

export function timeline() {
  return shots.map((s) => {
    const a = at(s.k0), b = s.last ? LEN : at(s.k0 + s.beats);
    const f0 = Math.round(a * FPS), f1 = Math.round(b * FPS);
    return { id: s.id, f0, n: f1 - f0, start: f0 / FPS, move: s.move };
  });
}

const TL = timeline();
if (opt.list) { for (const t of TL) console.log(`${t.id}  frames ${t.f0}-${t.f0 + t.n - 1} (${t.n})  ${t.start.toFixed(2)} s`); console.log('total', TL.reduce((n, t) => n + t.n, 0)); process.exit(0); }

const args = ['-y', '-hide_banner', '-loglevel', 'error'];
const fc = [];
let input = 0, bad = 0;
TL.forEach((t, k) => {
  const dir = path.join(FR, t.id);
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^f\d{4}\.png$/.test(f) && fs.statSync(path.join(dir, f)).size > 0).length : 0;
  if (have >= t.n) {
    args.push('-framerate', String(FPS), '-start_number', '1', '-i', path.join(dir, 'f%04d.png'));
    fc.push(`[${input++}:v]trim=end_frame=${t.n},setpts=PTS-STARTPTS,scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv444p[v${k}]`);
  } else {
    console.log(`${t.id}: ${have} of ${t.n} frames` + (opt.rough ? ' (slate)' : ''));
    bad++;
    args.push('-f', 'lavfi', '-i', `color=c=0x10141c:s=${W}x${H}:r=${FPS}:d=${t.n / FPS}`);
    fc.push(`[${input++}:v]trim=end_frame=${t.n},setpts=PTS-STARTPTS,format=yuv444p[v${k}]`);
  }
});
if (bad && !opt.rough) { console.log('frames missing: not cut (use --rough for slates)'); process.exit(1); }
// The grade: a touch of contrast and saturation, fine grain to hold the gradients through the encode, a short fade up.
const bar = Math.round((H - W / 2.39) / 2);
const last = TL[TL.length - 1].start;
fc.push(`${TL.map((_, k) => `[v${k}]`).join('')}concat=n=${TL.length}:v=1:a=0,eq=contrast=1.035:saturation=1.05,noise=alls=3:allf=t,` +
  `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill:enable='lt(t,${last})',drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill:enable='lt(t,${last})',` +
  `fade=t=in:st=0:d=0.5,format=yuv420p[vout]`);
// Music: the 60 s edit, as tools/promo/cut.mjs makes it.
const e = music.edit, X = e.crossfade ?? 0.06;
args.push('-i', music.file);
const m = input++;
fc.push(`[${m}:a]asplit=2[ma][mb]`);
fc.push(`[ma]atrim=0:${e.aEnd + X / 2},asetpts=PTS-STARTPTS[pa]`);
fc.push(`[mb]atrim=${e.bStart - X / 2},asetpts=PTS-STARTPTS[pb]`);
fc.push(`[pa][pb]acrossfade=d=${X}:c1=tri:c2=tri,apad=whole_dur=${LEN},atrim=0:${LEN}[aout]`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fcFile = OUT.replace(/\.mp4$/, '.filter.txt');
fs.writeFileSync(fcFile, fc.join(';\n'));
args.push('-/filter_complex', fcFile, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(opt.crf ?? 10),
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', String(LEN), OUT);
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
console.log(r.status === 0 ? `wrote ${OUT} (${LEN} s, ${TL.reduce((n, t) => n + t.n, 0)} frames, ${W}x${H}@${FPS})` : 'ffmpeg failed');
process.exit(r.status ?? 1);
