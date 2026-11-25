// Offline capture for the promo (fun queue item 20). Drives the real game frame by frame, never in real time,
// so every frame is complete: the simulation is frozen and advanced by hand, the camera follows a scripted path,
// motion blur is the average of sub-frames, and supersampling renders the page bigger and shrinks each frame.
//
//   node tools/promo/capture.mjs                         every shot in storyboard.json, final quality
//   node tools/promo/capture.mjs --rough                 1280x720, 30 fps, 1 sub-frame, no supersampling
//   node tools/promo/capture.mjs --shot tower,tornado    only these shots
//   node tools/promo/capture.mjs --bench 3               time 3 final-quality frames of each chosen shot, write nothing
//
// Options: --w 1920 --h 1080 --fps 60 --ss 2 (render at w*ss x h*ss) --sub 8 (sub-frames per output frame)
//          --out C:/Users/User/promo/frames  --storyboard tools/promo/storyboard.json --query q=high
// Run it on the RTX: set PW_GPU=high. Frames land in <out>/<shot id>/f00000.png, one folder per shot.
//
// How a frame is made (all in the page, see FRAME below): for each sub-frame the game is ticked by
// dt = timeScale / (fps * sub) (a slow-motion shot has timeScale < 1), the camera is placed from the shot's path at
// that sub-frame's time, one frame is drawn, and it is blended into a 2D accumulator with weight 1/(i+1), which
// leaves the plain average of all sub-frames. The average is shrunk to w x h with high-quality smoothing and sent
// back as PNG. The HUD, touch layer and title card are hidden by a style rule, so only the canvas is captured.
//
// A shot in storyboard.json:
//   { "id": "tower", "beats": 8, "setup": "<JS run in the page: g = window.__game, P = window.__promo>",
//     "wait": 4000, "warm": 2, "timeScale": 1,
//     "cam": { "keys": [ { "t": 0, "pos": [x,y,z], "at": [x,y,z], "fov": 50 }, ... ] }   // t is 0..1 of the shot
//     or "cam": { "follow": "car", "offset": [side, up, back], "look": [side, up, ahead], "fov": 55 } }
// Shot lengths come from tools/promo/timeline.mjs: whole beats on the measured beat grid (storyboard.music.grid).
// In the page, P.t is the shot's simulated time so far and P.beats its beat times in simulated seconds (slow motion
// scales them), so a setup can put events on the beat (the fireworks shells do).

import { boot } from '../pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { timeline } from './timeline.mjs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[k] = v;
}
const rough = !!opt.rough;
const W = +(opt.w ?? (rough ? 1280 : 1920)), H = +(opt.h ?? (rough ? 720 : 1080));
const FPS = +(opt.fps ?? (rough ? 30 : 60));
const SS = +(opt.ss ?? (rough ? 1 : 2));
const SUB = +(opt.sub ?? (rough ? 1 : 8));
const OUT = String(opt.out ?? 'C:/Users/User/promo/frames' + (rough ? '-rough' : ''));
const BOARD = String(opt.storyboard ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'storyboard.json'));
const bench = opt.bench ? +opt.bench : 0;

const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const want = typeof opt.shot === 'string' ? new Set(opt.shot.split(',')) : null;
const shots = board.shots.filter((s) => s.capture !== false && (!want || want.has(s.id)));
const when = new Map(timeline(board).map((x) => [x.id, x]));

// Installed once per page: the camera path, the accumulator and the frame function.
const INSTALL = ({ W, H, RW, RH }) => {
  const g = window.__game, game = g.game;
  const P = (window.__promo = window.__promo || {});
  const style = document.createElement('style');
  style.textContent = 'body > :not(#c) { display: none !important; } #c { cursor: none; }';
  document.head.appendChild(style);
  game.gov.enabled = false;
  game.gov.force(0);
  const acc = document.createElement('canvas'); acc.width = RW; acc.height = RH;
  const ax = acc.getContext('2d');
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ox = out.getContext('2d');
  ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
  const V = (a) => new (game.camera.position.constructor)(a[0], a[1], a[2]);
  const ease = (x) => x * x * (3 - 2 * x);
  // Catmull-Rom through the keys, eased per segment: smooth dolly and crane moves with no kinks.
  const cr = (p0, p1, p2, p3, u) => p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * u
    + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u));
  P.place = (cam, s) => {
    let pos, at, fov = cam.fov ?? 55;
    if (cam.follow && !P[cam.follow]) return;
    if (cam.follow) {
      const v = P[cam.follow];
      const o = cam.offset ?? [0, 3, 9], l = cam.look ?? [0, 1, 12];
      // Vehicles face +z at heading 0 (sin h, cos h is forward).
      // world: true keeps the offset in world axes (a camera that tracks without turning with the subject).
      const h = cam.world ? 0 : v.h ?? 0, fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
      const vx = v.x ?? v.pos?.x, vy = v.y ?? v.pos?.y ?? 0, vz = v.z ?? v.pos?.z;
      pos = [vx + rx * o[0] - fx * o[2], vy + o[1], vz + rz * o[0] - fz * o[2]];
      at = [vx + rx * l[0] + fx * l[2], vy + l[1], vz + rz * l[0] + fz * l[2]];
    } else {
      const k = cam.keys;
      let i = 0;
      while (i < k.length - 2 && s > k[i + 1].t) i++;
      const a = k[i], b = k[Math.min(i + 1, k.length - 1)];
      const u = b.t > a.t ? ease(Math.min(1, Math.max(0, (s - a.t) / (b.t - a.t)))) : 0;
      const a0 = k[Math.max(0, i - 1)], b1 = k[Math.min(k.length - 1, i + 2)];
      pos = cr(a0.pos, a.pos, b.pos, b1.pos, u);
      at = cr(a0.at, a.at, b.at, b1.at, u);
      fov = (a.fov ?? fov) + ((b.fov ?? fov) - (a.fov ?? fov)) * u;
      // ref: the keys are relative to a P object's x, y, z (a moose site, a store floor, the train), read every frame.
      if (cam.ref && P[cam.ref]) { const r = P[cam.ref], o = [r.x ?? 0, r.y ?? 0, r.z ?? 0]; pos = pos.map((x, j) => x + o[j]); at = at.map((x, j) => x + o[j]); }
      if (cam.shake) { pos = pos.map((x, j) => x + Math.sin(s * 47 + j * 2.1) * cam.shake); }
    }
    game.view = { pos: V(pos), target: V(at) };
    game.camera.fov = fov;
    game.camera.updateProjectionMatrix();
  };
  P.placeDefault = P.place; // a shot's setup may replace P.place with its own camera; the next shot starts from this one again
  /** One output frame: sub sub-frames from shot time s0 to s1 (0..1), each advancing the world by dt. */
  P.frame = async (cam, s0, s1, sub, dt, wantPng) => {
    for (let i = 0; i < sub; i++) {
      game.tick(dt);
      P.t = (P.t ?? 0) + dt;
      if (P.each) try { P.each(dt); } catch (e) { P.each = null; console.warn('promo each: ' + e); }
      P.place(cam, s0 + (s1 - s0) * ((i + 0.5) / sub));
      game.render();
      ax.globalAlpha = 1 / (i + 1);
      ax.drawImage(game.canvas, 0, 0, RW, RH);
    }
    if (!wantPng) { game.renderer.getContext().finish(); return ''; }
    ox.drawImage(acc, 0, 0, W, H);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
};

// Shots are grouped by their page address: a shot may add to it ("query": "season=summer"), and each group gets
// its own browser, since the season is read once at load.
const BASE = String(opt.query ?? 'q=high&net=0');
const groups = new Map();
for (const s of shots) { const q = s.query ? `${BASE}&${s.query}` : BASE; if (!groups.has(q)) groups.set(q, []); groups.get(q).push(s); }
console.log(`capture ${W}x${H} @${FPS} ss${SS} sub${SUB} ${shots.length} shots in ${groups.size} loads -> ${OUT}${bench ? ' (bench)' : ''}`);
const timing = [];
for (const [query, list] of groups) {
const t = await boot({ width: W * SS, height: H * SS, query });
// Shot scripts can report with console.log('promo: ...') or console.warn; those lines are echoed here.
t.page.on('console', (m) => { if (/^(promo|cannon)/.test(m.text())) console.log('  page: ' + m.text()); });
if (t.errors.length) console.log('boot errors:', t.errors.slice(0, 3));
await t.page.evaluate(INSTALL, { W, H, RW: W * SS, RH: H * SS });
for (const shot of list) {
  const tl = when.get(shot.id);
  // Frames are counted from the shot's start and end times on the output clock, so rounding never accumulates.
  const frames = bench || Math.round(tl.end * FPS) - Math.round(tl.start * FPS);
  const dt = (shot.timeScale ?? 1) / (FPS * SUB);
  const dir = path.join(OUT, shot.id);
  if (!bench) fs.mkdirSync(dir, { recursive: true });
  // Setup: place the world (teleport, time, weather, spawns), then let it settle and the models arrive in real time.
  // A setup that throws is logged and the shot is still captured (as whatever the camera sees), so one bad shot never stops a run.
  const bad = await t.page.evaluate(`(async () => { const g = window.__game, P = window.__promo;
    for (const k of Object.keys(P)) if (k !== 'place' && k !== 'frame' && k !== 'placeDefault') delete P[k];
    P.place = P.placeDefault;
    g.game.view = null; try { ${shot.setup ?? ''} } catch (e) { return String(e); } return ''; })()`);
  if (bad) console.log(`${shot.id}: setup failed: ${bad}`);
  // Keys held from the warm-up to the end of the shot (a car's throttle): real key events the game's input reads.
  if (shot.keys) await t.page.focus('#c').catch(() => {});
  // keysLate: the keys go down only when the shot starts (a car that waits through the warm-up, then goes).
  if (!shot.keysLate) for (const k of shot.keys ?? []) await t.page.keyboard.down(k);
  const warm = Math.round((shot.warm ?? 1) * 60);
  for (let i = 0; i < warm; i += 30) await t.step(Math.min(30, warm - i));
  await t.page.waitForTimeout(rough ? Math.min(shot.wait ?? 3000, 3000) : (shot.wait ?? 5000));
  await t.page.evaluate(([b, k]) => { window.__promo.t = 0; window.__promo.beats = b.map((x) => x * k); }, [tl.beats, shot.timeScale ?? 1]);
  if (shot.preroll) {
    const e = await t.page.evaluate(`(() => { const g = window.__game, P = window.__promo; try { ${shot.preroll} } catch (e) { return String(e); } return ''; })()`);
    if (e) console.log(`${shot.id}: preroll failed: ${e}`);
  }
  if (shot.keysLate) for (const k of shot.keys ?? []) await t.page.keyboard.down(k);
  await t.step(2);
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    const s0 = f / frames, s1 = (f + 1) / frames;
    const png = await t.page.evaluate(([cam, s0, s1, sub, dt, want]) => window.__promo.frame(cam, s0, s1, sub, dt, want), [shot.cam, s0, s1, SUB, dt, !bench]);
    if (png) fs.writeFileSync(path.join(dir, `f${String(f).padStart(5, '0')}.png`), Buffer.from(png, 'base64'));
  }
  for (const k of shot.keys ?? []) await t.page.keyboard.up(k);
  const ms = (Date.now() - t0) / frames;
  timing.push({ id: shot.id, frames, msPerFrame: Math.round(ms) });
  console.log(`${shot.id}: ${frames} frames, ${ms.toFixed(0)} ms/frame`);
}
if (t.errors.length) console.log('errors:', t.errors.slice(0, 5));
await t.close();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, bench ? 'bench.json' : 'timing.json'), JSON.stringify({ W, H, FPS, SS, SUB, timing }, null, 1));
