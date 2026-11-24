// GPU-bound A/B on the RTX: render N frames back to back with gl.finish (no vsync, no waiting), each config
// interleaved over several rounds, so the GPU clocks stay up and the numbers separate. Use it when rafprobe --vsync
// is too noisy to tell two configs apart (battery, power plan, other jobs on the GPU).
//
//   node tools/lead/gpubench.mjs --scene downtown --cfg full,noShadow,noPost [--rounds 4] [--n 80] [--query ..] [--w 1280 --h 720]
//
// Scenes: downtown (night), storm (tornado + rain), hq (inside the lobby, night), hqout, pardons, mainst, park.
// One line per config: mean and best ms per frame over the rounds. Configs act on the live game and are undone.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../pw.mjs';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; }
const name = String(opt.scene ?? 'downtown');
const SC = {
  downtown: { time: 23, at: [-30, 0, 3.14] },
  storm: { time: 17, at: [-30, 0, 3.14], storm: 1 },
  hq: { time: 23, at: [27, 32, 0] },
  hqout: { time: 23, at: [27, -20, 0] },
  pardons: { land: 1, time: 13, at: [-628, -1135, 0] },
  mainst: { land: 1, time: 13, at: [80, -1300, 3.14] },
  park: { time: 13, at: [140, -110, 1.57] },
  hood: { land: 1, time: 13, at: [-182, -1296, 1.06 + 3.14] },
  hood2: { land: 1, time: 13, at: [-240, -1850, -1.86 + 3.14] },
}[name];
const query = ['q=' + (opt.q ?? 'high'), 'save=0', 'net=0', (typeof opt.query === 'string' && /xmas=/.test(opt.query) ? '' : 'xmas=0'), SC.land ? 'bridge=8&stage=4' : '', typeof opt.query === 'string' ? opt.query : ''].filter(Boolean).join('&');
const server = await createServer({ root: ROOT, logLevel: 'error', clearScreen: false, optimizeDeps: { noDiscovery: true, include: [] },
  cacheDir: path.join(os.tmpdir(), 'pc-vite-' + process.pid), server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', (opt.gpu === 'low' ? '--force_low_power_gpu' : '--force_high_performance_gpu')] });
const page = await (await browser.newContext({ viewport: { width: Number(opt.w ?? 1280), height: Number(opt.h ?? 720) }, deviceScaleFactor: 1 })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/403/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.stack || e)));
try {
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  await page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(1500); await page.evaluate(() => window.__game.step(4)); }
  await page.evaluate(([s]) => { const G = window.__game; G.setTime(s.time); G.teleport(s.at[0], s.at[1], s.at[2]); if (s.storm) { G.setWeather('rain'); window.__storm.tornado.start(); } G.step(90); }, [SC]);
  await page.waitForTimeout(500); await page.evaluate(() => window.__game.step(30));
  const res = await page.evaluate(async ([cfgNames, rounds, N]) => {
    const g = window.__game.game, gl = g.renderer.getContext();
    const hide = (o) => { const v = o.visible; o.visible = false; return () => { o.visible = v; }; };
    const cfgs = {
      full: () => () => {},
      noXmas: () => hide(g.christmas.group),
      noBulbs: () => { const h = []; g.christmas.group.traverse((o) => { if (o.isInstancedMesh && o.material.toneMapped === false && o.visible) { o.visible = false; h.push(o); } }); return () => h.forEach((o) => { o.visible = true; }); },
      noGreen: () => { const h = []; g.christmas.group.traverse((o) => { if (o.isInstancedMesh && o.material.toneMapped !== false && o.count > 100 && o.visible) { o.visible = false; h.push(o); } }); return () => h.forEach((o) => { o.visible = true; }); },
      noKit: () => { const h = []; g.christmas.group.traverse((o) => { if (o.parent === g.christmas.group && !o.isInstancedMesh && o.visible) { o.visible = false; h.push(o); } }); return () => h.forEach((o) => { o.visible = true; }); },
      noTreeShadow: () => { const h = []; g.christmas.group.traverse((o) => { if (o.castShadow) { o.castShadow = false; h.push(o); } }); return () => h.forEach((o) => { o.castShadow = true; }); },
      noShadow: () => { const e = g.renderer.shadowMap.enabled; g.renderer.shadowMap.autoUpdate = false; g.sky.sun.castShadow = false; return () => { g.renderer.shadowMap.autoUpdate = true; g.sky.sun.castShadow = true; }; },
      noPost: () => { g.post.enabled = false; return () => { g.post.enabled = true; }; },
      noAO: () => { g.post.aoOn = false; return () => { g.post.aoOn = true; }; },
      noSky: () => hide(g.sky.dome),
      // The dome drawn after the opaque things, at the far plane, so covered pixels never run its shader.
      skyLast: () => {
        const d = g.sky.dome, m = d.material, vs = m.vertexShader, ro = d.renderOrder;
        m.vertexShader = vs.replace('gl_Position = vec4(p.xy, 0.0, p.w);', 'gl_Position = vec4(p.xy, p.w, p.w);'); m.depthTest = true; m.needsUpdate = true; d.renderOrder = 1000;
        return () => { m.vertexShader = vs; m.depthTest = false; m.needsUpdate = true; d.renderOrder = ro; };
      },
      noTornado: () => hide(window.__storm.tornado.root),
      noCloud: () => hide(window.__storm.tornado.cloud),
      noShells: () => { const u = window.__storm.tornado.shells.map(hide); return () => u.forEach((f) => f()); },
      noRain: () => hide(g.sky.rain),
      halfRes: () => { const r = g.renderer.getPixelRatio(); g.renderer.setPixelRatio(r * 0.5); g.post.setSize(innerWidth, innerHeight, r * 0.5); return () => { g.renderer.setPixelRatio(r); g.post.setSize(innerWidth, innerHeight, r); }; },
    };
    const acc = {}, cpus = {}; for (const k of cfgNames) acc[k] = [];
    for (let r = 0; r < rounds; r++) for (const k of cfgNames) {
      const undo = cfgs[k]();
      for (let i = 0; i < 15; i++) { g.render(); gl.finish(); }
      let cpu = 0; const t0 = performance.now(); for (let i = 0; i < N; i++) { const a = performance.now(); g.render(); cpu += performance.now() - a; gl.finish(); }
      acc[k].push((performance.now() - t0) / N); (cpus[k] ||= []).push(cpu / N); undo();
    }
    const info = g.renderer.info.render;
    return { acc, cpus, calls: info.calls, tris: info.triangles };
  }, [String(opt.cfg ?? 'full,noShadow,noPost').split(','), Number(opt.rounds ?? 4), Number(opt.n ?? 80)]);
  const gpu = await page.evaluate(() => { const gl = window.__game.game.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
  console.log(JSON.stringify({ scene: name, gpu: gpu.slice(0, 60), calls: res.calls, tris: res.tris }));
  for (const k in res.acc) { const a = res.acc[k]; console.log(`  ${k.padEnd(11)} mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)} ms  best ${Math.min(...a).toFixed(2)}  rounds ${a.map((x) => x.toFixed(1)).join(' ')}  js-submit ${(res.cpus[k].reduce((x, y) => x + y, 0) / a.length).toFixed(2)}`); }
} finally { console.log(JSON.stringify({ errors: errors.slice(0, 3) })); await browser.close(); await server.close(); }



