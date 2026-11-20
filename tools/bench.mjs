// The whole-game benchmark: the same stills and camera paths every time, at each preset.
//
//   node tools/bench.mjs                              every scene at high, medium and low, 1920x1080
//   node tools/bench.mjs --q high --scenes downtown,park
//   node tools/bench.mjs --q high --shots shots/bench  also save a picture of each still
//   node tools/bench.mjs --q high --ab "noao::g.post.ao=0::g.post.ao=1"
//        A/B inside one session: the first snippet switches the change on, the second puts it
//        back; `g` is the Game. Renders are interleaved (A B A B ...) because this machine's
//        timings drift by more than most changes are worth.
//        Several pairs: separate them with ||.
//   node tools/bench.mjs --systems                    cost of each system's update, ms per tick
//   node tools/bench.mjs --load [--dist]              load time and the download, file by file
//   node tools/bench.mjs --query "post=0"             extra query for every boot
//   --n 200           renders per still (and per side of an A/B)
//   --nopath          skip the camera paths
//   --boottimeout 90000 --retrywait 75   a boot that fails (somebody's half-saved file, a busy
//        machine) is closed and tried again after the wait, three times in all; if all three
//        fail that preset is reported under "errors" and the run carries on with the next.
//
// A still is 200 renders in batches of eight with a one-pixel read-back after each batch (see SYNC
// below for why not gl.finish): the median batch, and the best tenth. A path is 240 frames of the player being
// carried along a street with the simulation running (tick + render), so it also catches the
// hitches a still cannot: level-of-detail swaps, spawns, uploads.
// What the two numbers mean (M6, Nov 20): a still never ticks, so it sends no instance buffers and reads as the
// GPU's own time for the picture. A path waits for the GPU after EVERY frame, so it reads CPU + GPU end to end
// plus about 5 ms for the wait itself: it overstates what a player gets and cannot see a change that only lets
// the CPU and the GPU work in parallel (src/core/flip.ts took the real loop from 51 to 65 frames a second
// downtown and moved this path number by 1 ms). For the frame rate of the running game use
// scratch/m6/rafprobe.mjs --vsync: the real loop, requestAnimationFrame, no forced wait, standing and moving,
// with 'noFlip' as the same build with the two-copy buffers switched off.
// One JSON line per result, then a table. Exits 1 on any console error.

import { boot } from './pw.mjs';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
}
const W = Number(opt.w ?? 1920), H = Number(opt.h ?? 1080);
const presets = String(opt.q ?? 'high,medium,low').split(',');
const only = typeof opt.scenes === 'string' ? opt.scenes.split(',') : null;
const extra = typeof opt.query === 'string' ? opt.query : '';
const N = Number(opt.n ?? 200);
const BOOT_MS = Number(opt.boottimeout ?? 90000), RETRY_MS = Number(opt.retrywait ?? 75) * 1000;
let gpu = '';

// h: 0 faces south (+Z), pi faces north. `land: 1` scenes boot with the bridge finished and the town open.
const SCENES = [
  { name: 'start', hour: 13 },
  { name: 'downtown', at: [-30, 0, 3.14], hour: 13, path: [-30, 60, -30, -200] },
  { name: 'park', at: [140, -110, 1.57], hour: 13 },
  { name: 'heights', at: [0, -320, 1.57], hour: 13, path: [-240, -320, 300, -320] },
  { name: 'pier', at: [0, 560, 0], hour: 18.5 },
  { name: 'nightrain', at: [-30, 0, 3.14], hour: 22, weather: 'rain', heat: 3, settle: 600 },
  { name: 'midbridge', land: 1, at: [-30, -800, 3.14], hour: 13 },
  { name: 'mainst', land: 1, at: [80, -1300, 3.14], hour: 13, path: [80, -1100, 80, -1560] },
  { name: 'stacks', land: 1, at: [-140, -1300, 3.14], hour: 13 },
];

const errors = [];
const rows = [];
const out = (o) => { rows.push(o); console.log(JSON.stringify(o)); };

/** Models arrive after boot; wait until no model request has been outstanding for a while. */
async function settleModels(t) {
  for (let i = 0; i < 6; i++) { await t.page.waitForTimeout(1500); await t.step(4); }
}

// How a frame is timed. gl.finish() cannot be trusted here: under ANGLE on Windows it waits by
// sleeping, so with the system timer at its default 15.6 ms a frame reads as 3, 15 or 31 ms and
// nothing in between (the first M6 numbers were all multiples of it). Reading one pixel back
// blocks until the GPU has really drawn everything, so frames are drawn in batches of eight with
// one read-back after each, and the batch time divided out. Other programs share this GPU, so the
// figure reported is the median batch; `best` is the fastest tenth.
const SYNC = `
  const __px = new Uint8Array(4);
  const sync = (g) => { const gl = g.renderer.getContext(); g.renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, __px); };
  const batch = (g, k) => { const t0 = performance.now(); for (let i = 0; i < k; i++) g.render(); sync(g); return (performance.now() - t0) / k; };
`;

async function still(t, n) {
  return t.page.evaluate(`(() => { ${SYNC}
    const g = window.__game.game, k = 8, rounds = Math.ceil(${n} / k), ms = [];
    batch(g, k);
    for (let r = 0; r < rounds; r++) ms.push(batch(g, k));
    ms.sort((a, b) => a - b);
    return { ms: +ms[rounds >> 1].toFixed(2), best: +ms[Math.floor(rounds / 10)].toFixed(2) };
  })()`);
}

async function ab(t, on, off, n) {
  return t.page.evaluate(`(() => { ${SYNC}
    const g = window.__game.game, k = 8, rounds = Math.ceil(${n} / k), a = [], b = [];
    const A = new Function('g', ${JSON.stringify(on)}), B = new Function('g', ${JSON.stringify(off)});
    A(g); batch(g, 3); B(g); batch(g, 3);
    for (let r = 0; r < rounds; r++) { B(g); batch(g, 2); b.push(batch(g, k)); A(g); batch(g, 2); a.push(batch(g, k)); }
    B(g);
    const med = (v) => { v.sort((x, y) => x - y); return +v[v.length >> 1].toFixed(2); };
    return { base: med(b), with: med(a) };
  })()`);
}

async function path(t, p, frames = 240) {
  return t.page.evaluate(([p, frames]) => {
    const G = window.__game, g = G.game, gl = g.renderer.getContext(), px = new Uint8Array(4);
    const h = Math.atan2(p[2] - p[0], p[3] - p[1]);
    const ms = [];
    for (let i = 0; i < frames; i++) {
      const f = i / (frames - 1);
      g.player.teleport(p[0] + (p[2] - p[0]) * f, p[1] + (p[3] - p[1]) * f, h);
      if (i === 0) g.cam.snap();
      const t0 = performance.now();
      g.tick(1 / 60); g.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (i >= 10) ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    return { avg: +avg.toFixed(2), p95: +ms[Math.floor(ms.length * 0.95)].toFixed(2), max: +ms[ms.length - 1].toFixed(2) };
  }, [p, frames]);
}

/** Textures reachable from the scene, and what they hold on the GPU (RGBA8 unless typed, a third more with mipmaps). */
const memory = (t) => t.page.evaluate(() => {
  const g = window.__game.game, seen = new Set();
  let bytes = 0, biggest = [];
  const add = (tex) => {
    if (!tex || !tex.isTexture || seen.has(tex.uuid)) return;
    seen.add(tex.uuid);
    const im = tex.image; if (!im) return;
    const w = im.width || im.videoWidth || 0, h = im.height || 0, d = im.depth || 1;
    const per = tex.type === 1015 ? 16 : tex.type === 1016 ? 8 : 4;
    const b = w * h * d * per * (tex.generateMipmaps ? 1.333 : 1);
    bytes += b; biggest.push([Math.round(b / 1048576 * 10) / 10, w + 'x' + h, tex.name || '']);
  };
  g.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      for (const k in m) add(m[k]);
      if (m.uniforms) for (const k in m.uniforms) add(m.uniforms[k] && m.uniforms[k].value);
    }
  });
  add(g.scene.environment); add(g.scene.background);
  biggest.sort((a, b) => b[0] - a[0]);
  const r = g.renderer;
  return {
    textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs ? r.info.programs.length : 0,
    sceneTexMB: +(bytes / 1048576).toFixed(1), top: biggest.slice(0, 6),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
  };
});

/** Wrap every update the frame calls and run the real simulation for a while. */
const systems = (t, ticks) => t.page.evaluate((ticks) => {
  const g = window.__game.game, acc = {}, undo = [];
  const wrap = (obj, name, fn = 'update') => {
    if (!obj || typeof obj[fn] !== 'function') return;
    const orig = obj[fn]; acc[name] = 0;
    obj[fn] = function (...a) { const t0 = performance.now(); const r = orig.apply(this, a); acc[name] += performance.now() - t0; return r; };
    undo.push(() => { obj[fn] = orig; });
  };
  wrap(g.player, 'player'); wrap(g.vehicles, 'vehicles'); wrap(g.people, 'people'); wrap(g.world, 'world');
  for (const s of g.systems) wrap(s, s.constructor.name);
  wrap(g.cam, 'camera'); wrap(g.sky, 'sky'); wrap(g.hud, 'hud'); wrap(g.touchUI, 'touch');
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) g.tick(1 / 60);
  const total = (performance.now() - t0) / ticks;
  for (const u of undo) u();
  const res = { tick: +total.toFixed(3) };
  for (const k in acc) res[k] = +(acc[k] / ticks).toFixed(3);
  return res;
}, ticks);

async function runPreset(q, land) {
  const scenes = SCENES.filter((s) => (s.land ?? 0) === land && (!only || only.includes(s.name)));
  if (!scenes.length) return;
  const query = [`q=${q}`, 'save=0', land ? 'bridge=8&stage=4' : '', extra].filter(Boolean).join('&');
  // Somebody else's half-saved file can sink a boot: give it a minute and try again, twice.
  // `start: false` because pw.mjs's own start step throws when the page never made a game, and a
  // throw there would leave its browser and server running under the timings that follow.
  let t = null, why = '';
  for (let attempt = 0; attempt < 3 && !t; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS));
    let b = null;
    try { b = await boot({ query, width: W, height: H, start: false, timeout: BOOT_MS }); } catch (e) { why = String(e); }
    if (b && !b.errors.length) {
      await b.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
      t = b;
    } else {
      if (b) { why = b.errors[0]; await b.close(); }
      console.log(`boot failed, attempt ${attempt + 1} of 3 (${why.slice(0, 160)})`);
    }
  }
  if (!t) throw new Error(`boot failed three times: ${why.slice(0, 200)}`);
  try {
    if (!gpu) {
      gpu = await t.page.evaluate(() => { const gl = window.__game.game.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
      console.log(JSON.stringify({ gpu, size: `${W}x${H}`, pixelRatio: await t.page.evaluate(() => window.__game.game.renderer.getPixelRatio()) }));
    }
    await settleModels(t);
    for (const s of scenes) {
      await t.game((g, w) => g.setWeather(w), s.weather ?? 'clear');
      await t.game((g, h) => g.setTime(h), s.hour);
      if (s.at) await t.game((g, a) => g.teleport(a[0], a[1], a[2] ?? 0), s.at);
      await t.game((g, n) => g.setHeat(n), s.heat ?? 0);
      await t.step(s.settle ?? 90);
      await t.page.waitForTimeout(400);
      await t.step(10);
      if (typeof opt.shots === 'string') await t.shot(`${opt.shots}/${q}-${s.name}.png`);
      const info = await t.info();
      const row = { q, scene: s.name, place: info.place, calls: info.calls, tris: info.tris };
      if (typeof opt.ab === 'string') {
        // Several pairs in one boot: "name::on::off||name2::on2::off2".
        for (const pair of opt.ab.split('||')) {
          const [name, on, off] = pair.split('::');
          const r = await ab(t, on, off, N);
          out({ ...row, ab: name, base: r.base, with: r.with, saved: +(r.base - r.with).toFixed(2) });
        }
        continue;
      } else {
        Object.assign(row, await still(t, N));
        row.fps = Math.round(1000 / row.ms);
        if (s.path && !opt.nopath) row.path = await path(t, s.path);
        if (opt.systems) row.systems = await systems(t, 600);
        Object.assign(row, await memory(t));
      }
      out(row);
    }
  } finally {
    for (const e of t.errors) errors.push(`${q}: ${e}`);
    await t.close();
  }
}

async function runLoad() {
  // A cold cache every time: a new browser per run. `ready` is the world built, `playable` the title card's Play (it waits
  // for what is round the player to arrive: src/core/assets.ts), `models` the last model file in.
  // The game reads its model files in a worker, whose requests are not in the page's own resource log, so this run
  // reads them on the page (`fetchworker=0`) to list every file. For what a visitor on a real line waits through, use
  // scratch/m6/netload.mjs: the production build served gzipped as the live site does, on a slowed network.
  const t = await boot({ dist: !!opt.dist, start: false, wait: false, query: ['save=0', 'fetchworker=0', extra].filter(Boolean).join('&'), width: W, height: H });
  try {
    await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 120000 });
    const ready = await t.page.evaluate(() => Math.round(performance.now()));
    let last = -1, quiet = 0;
    while (quiet < 4) {
      await t.page.waitForTimeout(700);
      const n = await t.page.evaluate(() => performance.getEntriesByType('resource').length);
      quiet = n === last ? quiet + 1 : 0; last = n;
    }
    const res = await t.page.evaluate(() => performance.getEntriesByType('resource').map((r) => ({
      file: r.name.split('/').slice(-1)[0].split('?')[0], kB: Math.round((r.encodedBodySize || r.transferSize) / 1024), end: Math.round(r.responseEnd),
    })));
    const total = res.reduce((a, r) => a + r.kB, 0), models = res.reduce((a, r) => Math.max(a, r.end), 0);
    const byKind = {};
    for (const r of res) { const k = /\.glb$/.test(r.file) ? 'models' : /\.webp$/.test(r.file) ? 'model textures' : /\.(woff2?|css)$/.test(r.file) ? 'fonts+css' : 'code'; byKind[k] = (byKind[k] || 0) + r.kB; }
    const boot = await t.page.evaluate(() => ({ ...window.__game.boot, marks: window.__game.loads?.().marks }));
    out({ load: opt.dist ? 'dist' : 'source', titleMs: Math.round(boot.titleAt), readyMs: ready, playableMs: boot.playableAt, lastFileMs: models, files: res.length, totalKB: total, byKind, inScene: boot.marks });
    res.sort((a, b) => b.kB - a.kB);
    for (const r of res.slice(0, opt.dist ? 60 : 14)) console.log(`  ${String(r.kB).padStart(6)} kB  ${String(r.end).padStart(6)} ms  ${r.file}`);
  } finally {
    for (const e of t.errors) errors.push(`load: ${e}`);
    await t.close();
  }
}

if (opt.load) await runLoad();
else for (const q of presets) for (const land of [0, 1]) {
  try { await runPreset(q, land); } catch (e) { errors.push(`${q}/${land}: ${String(e).slice(0, 300)}`); }
}

if (!opt.load) {
  console.log('\npreset  scene       calls     tris    ms   fps  path avg/p95/max');
  for (const r of rows) {
    const ms = r.ab ? `${r.base} -> ${r.with} (${r.ab} saves ${r.saved})` : `${String(r.ms).padStart(5)} ${String(r.best).padStart(5)} ${String(r.fps).padStart(5)}`;
    console.log(`${r.q.padEnd(7)} ${r.scene.padEnd(10)} ${String(r.calls).padStart(6)} ${String(r.tris).padStart(8)} ${ms}  ${r.path ? `${r.path.avg}/${r.path.p95}/${r.path.max}` : ''}`);
  }
}
console.log(JSON.stringify({ errors }));
process.exit(errors.length ? 1 : 0);
