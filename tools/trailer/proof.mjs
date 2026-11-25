// Proof outputs for rendered shots: an mp4 of the frames and a side-by-side still (left: the game's own frame from the
// export's ref/, right: the Blender render of the same moment).
//
//   node tools/trailer/proof.mjs P1_tower,P2_mainst,P3_train [--frame 48] [--root C:/Users/User/trailer]
// Writes <root>/proof/<id>.mp4 (H.264, CRF 14, 24 fps) and <root>/proof/<id>_side.jpg (3840x1080).
// Export frame f (0-based) is Blender frame f + 1.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const ids = String(argv[0]).split(',');
const opt = {};
for (let i = 1; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const ROOT = String(opt.root ?? 'C:/Users/User/trailer');
const F = +(opt.frame ?? 48);
const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (r.status) throw new Error('ffmpeg failed'); };

for (const id of ids) {
  const dir = path.join(ROOT, 'proof', id);
  const frames = fs.readdirSync(dir).filter((f) => /^f\d{4}\.png$/.test(f) && fs.statSync(path.join(dir, f)).size > 0).sort();
  if (!frames.length) { console.log(id + ': no frames'); continue; }
  const first = +frames[0].slice(1, 5);
  ff(['-framerate', '24', '-start_number', String(first), '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(ROOT, 'proof', id + '.mp4')]);
  const ref = path.join(ROOT, 'export', id, 'ref', `f${String(F).padStart(5, '0')}.jpg`);
  const ren = path.join(dir, `f${String(F + 1).padStart(4, '0')}.png`);
  if (fs.existsSync(ref) && fs.existsSync(ren)) {
    ff(['-i', ref, '-i', ren, '-filter_complex', '[0]scale=1920:1080:flags=lanczos[a];[a][1]hstack', '-q:v', '2', path.join(ROOT, 'proof', id + '_side.jpg')]);
  }
  console.log(`${id}: ${frames.length} frames -> ${id}.mp4` + (fs.existsSync(ren) ? `, ${id}_side.jpg` : ''));
}
