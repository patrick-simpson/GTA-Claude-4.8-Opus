// Run a Blender step for the trailer with the house rules: the window is always VISIBLE (never -b), at most two Blender
// windows on the laptop at once (another worker may have one open), and heavy work pauses when the battery is at 20% or
// less until it is back to 80%. Each Blender run quits itself when done (os._exit), so nothing is left open.
//
//   node tools/trailer/run.mjs build  P1_tower [--look golden] [--engine CYCLES|EEVEE]
//   node tools/trailer/run.mjs render P1_tower [--still 48 | --frames 1-96] [--pct 50] [--samples 64] [--tag t] [--engine EEVEE]
//   node tools/trailer/run.mjs batch  P1_tower,P2_mainst,...  [render options]     every frame of each, resumable
//
// Paths: exports in C:/Users/User/trailer/export/<id>, blends in .../blend/<id>.blend, frames in .../frames/<id>
// (or --out). Logs beside them.

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const ROOT = 'C:/Users/User/trailer';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const [cmd, ids, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) { const k = rest[i].replace(/^--/, ''); opt[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blenders = () => { try { return (execSync('tasklist /FI "IMAGENAME eq blender.exe" /NH', { encoding: 'utf8' }).match(/blender\.exe/gi) || []).length; } catch { return 0; } };
const battery = () => {
  try {
    const s = execSync('powershell -NoProfile -Command "$b = Get-CimInstance Win32_Battery; \\"$($b.EstimatedChargeRemaining) $($b.BatteryStatus)\\""', { encoding: 'utf8' }).trim().split(/\s+/);
    return { pct: +s[0], ac: +s[1] !== 1 };   // BatteryStatus 1 = discharging
  } catch { return { pct: 100, ac: true }; }
};

async function gate() {
  for (;;) {
    const b = battery();
    if (b.pct <= 20) {
      console.log(`battery ${b.pct}%: waiting for 80%`);
      while (battery().pct < 80) await sleep(120000);
      continue;
    }
    const n = blenders();
    if (n >= 2) { console.log(`${n} Blender windows open: waiting`); await sleep(60000); continue; }
    return;
  }
}

function blender(args, log) {
  return new Promise((resolve) => {
    const out = fs.openSync(log, 'w');
    const p = spawn(BLENDER, args, { stdio: ['ignore', out, out], windowsHide: false });
    p.on('exit', (code) => { fs.closeSync(out); resolve(code); });
  });
}

const pass = (keys) => keys.flatMap((k) => (opt[k] !== undefined ? ['--' + k, String(opt[k])] : []));

for (const id of String(ids).split(',')) {
  await gate();
  const blend = `${ROOT}/blend/${id}.blend`;
  if (cmd === 'build') {
    const t0 = Date.now();
    await blender(['--factory-startup', '--python', path.join(here, 'blender/build_shot.py'), '--', '--shot', `${ROOT}/export/${id}`, '--quit', ...pass(['look', 'engine', 'samples'])], `${ROOT}/blend/${id}.build.log`);
    const log = JSON.parse(fs.readFileSync(blend + '.log.json', 'utf8'));
    console.log(`${id}: built in ${((Date.now() - t0) / 1000).toFixed(0)} s` + (log.error ? '\n' + log.error : '') + (log.mat_errors ? '\nmaterial errors: ' + log.mat_errors.slice(0, 5).join('\n') : ''));
    for (const s of log.steps) console.log('  ' + s.msg + ' ' + JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'msg' && k !== 't'))));
  } else if (cmd === 'render' || cmd === 'batch') {
    // --out may hold {id}, so one command can batch several shots.
    const out = String(opt.out ?? (cmd === 'batch' ? `${ROOT}/frames/{id}` : `${ROOT}/look/{id}`)).replace('{id}', id);
    fs.mkdirSync(out, { recursive: true });
    // Resume: a run cut off mid-frame leaves an empty placeholder that Blender would skip. Remove those first.
    for (const f of fs.readdirSync(out)) if (/^f\d+\.png$/.test(f) && fs.statSync(path.join(out, f)).size === 0) fs.unlinkSync(path.join(out, f));
    const t0 = Date.now();
    await blender([blend, '--python', path.join(here, 'blender/render.py'), '--', '--out', out, ...pass(['still', 'frames', 'pct', 'samples', 'tag', 'engine', 'threshold', 'w', 'h', 'diffuse', 'glossy', 'transmission', 'bounces', 'volstep', 'denoiser'])], `${out}.render.log`);
    const tag = opt.tag ?? '';
    const tf = fs.readdirSync(out).filter((f) => f.startsWith('timing') && (!tag || f.includes(tag)));
    for (const f of tf) { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); const s = j.frames.map((x) => x.s); console.log(`${id} ${f}: ${j.engine} ${j.res.join('x')}% s${j.samples}: ${s.length} frames, mean ${(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(1)} s/frame`); }
    console.log(`${id}: ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  }
}
