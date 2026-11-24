// Drive the local ComfyUI (C:\Users\User\ComfyUI) over its HTTP API.
//
//   node tools/art/comfy.mjs start                 start the server (6 GB settings) and wait until it answers
//   node tools/art/comfy.mjs gen tools/art/jobs.json [id,id]   render the jobs (all, or just those ids)
//   node tools/art/comfy.mjs stop                  ask the server to quit
//
// Each job: { id, prompt, w, h, seed, [steps], [cfg], [neg] }. Output: scratch/art/raw/<id>.png.
// The shared style prefix and negative prompt (no lettering, no logos, no real brands) live in jobs.json.
// Text is never generated: tools/art/compose.mjs sets it in the game's own fonts.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMFY = process.env.COMFY_DIR || 'C:/Users/User/ComfyUI/ComfyUI_windows_portable';
const BASE = 'http://127.0.0.1:8188';
const OUT = path.join(ROOT, 'scratch', 'art', 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => { try { return (await fetch(BASE + '/system_stats')).ok; } catch { return false; } };

async function start() {
  if (await alive()) return console.log('already running');
  const py = path.join(COMFY, 'python_embeded', 'python.exe');
  // --lowvram: stream weights for a 6 GB card. --bf16-vae: the SDXL VAE overflows in fp16 (black pictures).
  const args = ['-s', 'ComfyUI/main.py', '--windows-standalone-build', '--lowvram', '--bf16-vae', '--disable-auto-launch', '--port', '8188'];
  const p = spawn(py, args, { cwd: COMFY, detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 120; i++) { if (await alive()) return console.log('up'); await sleep(2000); }
  throw new Error('ComfyUI did not come up');
}

function fill(graph, v) {
  const s = JSON.stringify(graph);
  const num = (k, x) => (r) => r.replace(`"${k}"`, String(x));
  let o = s;
  for (const [k, x] of Object.entries({ __W__: v.w, __H__: v.h, __SEED__: v.seed, __STEPS__: v.steps, __CFG__: v.cfg })) o = o.replace(`"${k}"`, String(x));
  const g = JSON.parse(o);
  g['3'].inputs.text = v.positive; g['4'].inputs.text = v.negative; g['8'].inputs.filename_prefix = v.prefix;
  delete g._note;
  return g;
}

async function gen(file, only) {
  const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows', 'sdxl-txt2img.json'), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  await start();
  for (const j of jobs.jobs) {
    if (only && !only.includes(j.id)) continue;
    const dest = path.join(OUT, j.id + '.png');
    if (!only && fs.existsSync(dest)) { console.log('skip', j.id); continue; }
    const t0 = Date.now();
    const g = fill(graph, {
      w: j.w, h: j.h, seed: j.seed ?? 1, steps: j.steps ?? jobs.steps ?? 28, cfg: j.cfg ?? jobs.cfg ?? 6.5,
      positive: `${j.prompt}, ${jobs.style}`, negative: `${j.neg ? j.neg + ', ' : ''}${jobs.negative}`, prefix: 'pc_' + j.id,
    });
    const r = await (await fetch(BASE + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: g }) })).json();
    if (!r.prompt_id) throw new Error('rejected: ' + JSON.stringify(r).slice(0, 400));
    let img = null;
    for (;;) {
      await sleep(1500);
      const h = (await (await fetch(`${BASE}/history/${r.prompt_id}`)).json())[r.prompt_id];
      if (h?.status?.status_str === 'error') throw new Error('job failed: ' + j.id);
      if (h?.outputs?.['8']?.images?.[0]) { img = h.outputs['8'].images[0]; break; }
    }
    const buf = Buffer.from(await (await fetch(`${BASE}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`)).arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(j.id, ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'start') await start();
else if (cmd === 'gen') await gen(a, b ? b.split(',') : null);
else if (cmd === 'stop') { try { await fetch(BASE + '/api/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"unload_models":true}' }); } catch {} console.log('models freed (close the server window or kill python to quit)'); }
else console.log('usage: start | gen jobs.json [ids] | stop');
