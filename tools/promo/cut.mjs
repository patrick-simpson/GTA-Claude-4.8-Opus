// Cut the captured shots to the music with ffmpeg: hard cuts on the beat (each shot is a whole number of beats long),
// the paperwork cards laid over their shots, a 2.39:1 letterbox, the track underneath.
//
//   node tools/promo/cut.mjs --rough        C:/Users/User/promo/frames-rough -> C:/Users/User/promo/rough/promo_rough.mp4
//   node tools/promo/cut.mjs                C:/Users/User/promo/frames       -> C:/Users/User/promo/final/promo_1080.mp4
// Options: --frames DIR --cards DIR --out FILE --fps N --storyboard FILE
//
// Music: storyboard.music.file, edited to 60 s: [0, edit.aEnd] then [edit.bStart, end of track], joined with a short
// crossfade on a downbeat (both points are beats of the same bar phase, so the grid runs on unbroken), padded to
// music.length. Without the file: a beat click on the grid. Missing frames for a shot become a slate (dark card).
// Shot and card times come from timeline.mjs (the measured beat grid).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { timeline } from './timeline.mjs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const rough = !!opt.rough;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const board = JSON.parse(fs.readFileSync(String(opt.storyboard ?? path.join(here, 'storyboard.json')), 'utf8'));
const FPS = +(opt.fps ?? (rough ? 30 : 60));
const W = rough ? 1280 : 1920, H = rough ? 720 : 1080;
const FR = String(opt.frames ?? (rough ? 'C:/Users/User/promo/frames-rough' : 'C:/Users/User/promo/frames'));
const CARDS = String(opt.cards ?? (rough ? 'C:/Users/User/promo/cards' : 'C:/Users/User/promo/cards-1080'));
const OUT = String(opt.out ?? (rough ? 'C:/Users/User/promo/rough/promo_rough.mp4' : 'C:/Users/User/promo/final/promo_1080.mp4'));
const TL = timeline(board);

const args = ['-y', '-hide_banner', '-loglevel', 'error'];
const fc = [];
const segs = [];
let input = 0, total = 0;
for (const tl of TL) {
  const s = tl.shot, dur = tl.dur;
  const n = Math.round(tl.end * FPS) - Math.round(tl.start * FPS);
  const dir = path.join(FR, s.id);
  let v;
  if (fs.existsSync(path.join(dir, 'f00000.png'))) {
    args.push('-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'));
    v = `[${input++}:v]scale=${W}:${H}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${dur},trim=end_frame=${n},setpts=PTS-STARTPTS`;
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=0x14213d:s=${W}x${H}:r=${FPS}:d=${dur}`);
    v = `[${input++}:v]drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='${s.id} (not captured)':fontcolor=0xf2e8cf:fontsize=${H / 18}:x=(w-tw)/2:y=(h-th)/2,trim=end_frame=${n},setpts=PTS-STARTPTS`;
  }
  fc.push(`${v},format=yuv420p[v${segs.length}]`);
  const card = path.join(CARDS, s.id + '.png');
  if (s.card && fs.existsSync(card)) {
    const a = tl.rel(s.card.in ?? 0), b = Math.min(dur, tl.rel(s.card.out ?? s.beats));
    args.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', card);
    const c = input++;
    fc.push(`[${c}:v]format=rgba,scale=${W}:${H},fade=t=in:st=${a}:d=0.12:alpha=1,fade=t=out:st=${Math.max(a, b - 0.15)}:d=0.15:alpha=1[c${segs.length}]`);
    fc.push(`[v${segs.length}][c${segs.length}]overlay=0:0:shortest=1,format=yuv420p[w${segs.length}]`);
    segs.push(`[w${segs.length}]`);
  } else segs.push(`[v${segs.length}]`);
}
total = TL[TL.length - 1].end;
// Letterbox to 2.39:1, except the last shot: the end card is laid over it live, full frame.
const bar = Math.round((H - W / 2.39) / 2);
const lastStart = TL[TL.length - 1].start;
fc.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=0,drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill:enable='lt(t,${lastStart})',drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill:enable='lt(t,${lastStart})'[vout]`);

const music = board.music?.file && fs.existsSync(board.music.file) ? board.music : null;
if (music) {
  const e = music.edit, X = 0.06;
  args.push('-i', music.file);
  const m = input++;
  if (e) {
    fc.push(`[${m}:a]asplit=2[ma][mb]`);
    fc.push(`[ma]atrim=0:${e.aEnd + X / 2},asetpts=PTS-STARTPTS[pa]`);
    fc.push(`[mb]atrim=${e.bStart - X / 2},asetpts=PTS-STARTPTS[pb]`);
    fc.push(`[pa][pb]acrossfade=d=${X}:c1=tri:c2=tri,apad=whole_dur=${total},atrim=0:${total}[aout]`);
  } else fc.push(`[${m}:a]atrim=${music.start ?? 0}:${(music.start ?? 0) + total},asetpts=PTS-STARTPTS,afade=t=out:st=${total - 1.5}:d=1.5[aout]`);
} else {
  // A beat click (accent on the bar) at the storyboard's tempo, as a stand-in for the track.
  const beat = 60 / board.bpm;
  args.push('-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*(1000+600*lt(mod(t\\,${4 * beat})\\,0.05))*t)*exp(-40*mod(t\\,${beat}))':s=48000:d=${total}`);
  fc.push(`[${input++}:a]anull[aout]`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const fcFile = OUT.replace(/\.mp4$/, '.filter.txt');
fs.writeFileSync(fcFile, fc.join(';\n'));
args.push('-/filter_complex', fcFile, '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-profile:v', 'high', '-preset', rough ? 'medium' : 'slow', '-crf', rough ? '20' : '17', '-pix_fmt', 'yuv420p',
  '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(total), OUT);
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
console.log(r.status === 0 ? `wrote ${OUT} (${total.toFixed(2)} s, ${music ? 'music' : 'beat clicks, no music file'})` : 'ffmpeg failed');
process.exit(r.status ?? 1);
