// The real loop (requestAnimationFrame, no forced sync) with one thing switched off at a time:
// what limits the frame rate a player actually gets, standing and moving.
//
//   node scratch/m6/rafprobe.mjs --q high --scene downtown [--secs 2.5] [--rounds 2] [--cfg full,frozen] [--speed 22] [--query ..]
//
// Moving is the player carried along the scene's street at --speed m/s (default 22, about 50 mph),
// turning round at the ends. One JSON line: per config, standing and moving, fps and avg/p95/max ms.
// Copy of tools/lead/rafprobe.mjs for the asset pipeline: --dist <folder> serves a production build (gzip like the live
// site) instead of the source, --mobile is a phone-sized touch page (use with --q low). Always the vsync browser.
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import pathMod from 'node:path';
const boot = null;

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; }
const q = String(opt.q ?? 'high'), name = String(opt.scene ?? 'downtown');
const SC = {
  downtown: { at: [-30, 0, 3.14], path: [-30, 60, -30, -200] },
  heights: { at: [0, -320, 1.57], path: [-240, -320, 300, -320] },
  mainst: { land: 1, at: [80, -1300, 3.14], path: [80, -1100, 80, -1560] },
  park: { at: [140, -110, 1.57], path: [60, -110, 300, -110] },
  // Pardon's (src/world/pardonsStore.ts): inside along the sales floor, and the lot in front.
  pardons: { land: 1, at: [-628, -1135, 0], path: [-606, -1126, -676, -1126] },
  pardonslot: { land: 1, at: [-640, -1200, 0], path: [-640, -1270, -640, -1172] },
}[name];
const query = [`q=${q}`, 'save=0', SC.land ? 'bridge=8&stage=4' : '', typeof opt.query === 'string' ? opt.query : ''].filter(Boolean).join('&');
// --vsync: the same page in a browser that paces frames at 60 a second (pw.mjs switches that off), which is
// what a player's screen does: then the question is how many frames miss their 16.7 ms.
async function boot60() {
  const { chromium } = await import('playwright');
  const DIST = pathMod.resolve(String(opt.dist || 'dist'));
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = pathMod.join(DIST, p);
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const ext = pathMod.extname(f).toLowerCase(); let body = fs.readFileSync(f);
    const head = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    if (['.html', '.js', '.css', '.glb', '.json', '.wasm'].includes(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body, { level: 1 }); head['Content-Encoding'] = 'gzip'; }
    head['Content-Length'] = body.length; res.writeHead(200, head); res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', ...(opt.gpu === 'high' ? ['--force_high_performance_gpu'] : opt.gpu === 'low' ? ['--force_low_power_gpu'] : [])] });
  const page = await (await browser.newContext(opt.mobile ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  await page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
  return { page, errors, game: (fn, arg) => page.evaluate(`(${fn.toString()})(window.__game, ${JSON.stringify(arg ?? null)})`),
    step: (n = 1) => page.evaluate((n) => window.__game.step(n), n), close: async () => { await browser.close(); server.close(); } };
}
const t = await boot60();
try {
  for (let i = 0; i < 6; i++) { await t.page.waitForTimeout(1500); await t.step(4); }
  await t.game((g) => g.setTime(13));
  await t.game((g, a) => g.teleport(a[0], a[1], a[2]), SC.at);
  await t.step(90); await t.page.waitForTimeout(400); await t.step(10);
  const res = await t.page.evaluate(async ([p, at, secs, rounds, cfgOnly, speed, modes]) => {
    const G = window.__game, g = G.game, gl = g.renderer.getContext(), V = g.vehicles, proto = Object.getPrototypeOf(g);
    const off = (obj, fn = 'update') => { const o = obj[fn]; obj[fn] = () => {}; return () => { obj[fn] = o; }; };
    const prime = () => {
      const Scene = g.scene.constructor, SM = g.post.compMat.constructor, IBG = V.glow.geo.constructor, Mesh = V.glow.mesh.constructor, RT = g.post.aoA.constructor;
      const ps = new Scene(), seen = new Set(), mats = {};
      const pos = new (V.glow.geo.attributes.position.constructor)(new Float32Array(9), 3);
      const add = (a) => {
        if (!a || a.isInterleavedBufferAttribute || a.usage !== 35048 || seen.has(a)) return; seen.add(a);
        const n = a.itemSize, type = n === 16 ? 'mat4' : n === 1 ? 'float' : 'vec' + n, use = n === 16 ? 'aX[0].x' : n === 1 ? 'aX' : 'aX.x';
        const geo = new IBG(); geo.setAttribute('position', pos); geo.setAttribute('aX', a); geo.instanceCount = 1;
        const mat = mats[type] || (mats[type] = new SM({ vertexShader: `attribute ${type} aX; void main(){ gl_Position = vec4(position.xy + ${use} * 1e-30, 0.0, 1.0); }`, fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }' }));
        const m = new Mesh(geo, mat); m.frustumCulled = false; ps.add(m);
      };
      g.scene.traverse((o) => { if (o.geometry) for (const k in o.geometry.attributes) add(o.geometry.attributes[k]); add(o.instanceMatrix); add(o.instanceColor); });
      const rt = new RT(4, 4), proto = Object.getPrototypeOf(g);
      g.render = function () { g.renderer.setRenderTarget(rt); g.renderer.render(ps, g.camera); proto.render.call(g); };
      return () => { delete g.render; rt.dispose(); };
    };
    const ARR = 34962, bind0 = gl.bindBuffer.bind(gl), usages = new WeakMap();
    let cur = null, upFrame = -1, upN = 0;
    gl.bindBuffer = (tg, b) => { if (tg === ARR) cur = b; bind0(tg, b); };
    const usage = () => { let u = usages.get(cur); if (u === undefined && cur) { u = gl.getBufferParameter(ARR, 0x8765); usages.set(cur, u); } return u; };
    const sub = (fn) => () => { const o = gl.bufferSubData; gl.bufferSubData = function (tg, at, arr, so, len) { if (tg !== ARR || !fn(at, arr, so, len)) o.apply(gl, arguments); }; return () => { gl.bufferSubData = o; }; };
    const nth = () => { if (g.frame !== upFrame) { upFrame = g.frame; upN = 0; } return upN++; };
    // Ping-pong: two GPU buffers for every dynamic attribute, used on alternate frames, so the one written this
    // frame is never the one the GPU drew from in the frame before.
    const flip = () => {
      const recs = new Map();
      const add = (a, owner, kind, key) => { if (!a || a.isInterleavedBufferAttribute || a.usage !== 35048) return; let r = recs.get(a); if (!r) { const B = new a.constructor(a.array, a.itemSize, a.normalized, a.meshPerAttribute); B.setUsage(a.usage); r = { A: a, B, owners: [], seen: a.version, age: 9 }; recs.set(a, r); } r.owners.push([owner, kind, key]); };
      g.scene.traverse((o) => { if (o.geometry) for (const k in o.geometry.attributes) add(o.geometry.attributes[k], o.geometry, 'geo', k); add(o.instanceMatrix, o, 'im'); add(o.instanceColor, o, 'ic'); });
      const set = (r, X) => { for (const [o, kind, key] of r.owners) { if (kind === 'im') o.instanceMatrix = X; else if (kind === 'ic') o.instanceColor = X; else o.attributes[key] = X; } };
      let n = 0;
      g.render = function () {
        const useB = (n++ & 1) === 1;
        for (const r of recs.values()) {
          if (r.A.version !== r.seen) { r.seen = r.A.version; r.age = 0; } else r.age++;
          if (useB && r.age <= 1) r.B.needsUpdate = true;
          set(r, useB ? r.B : r.A);
        }
        proto.render.call(g);
      };
      return () => { delete g.render; for (const r of recs.values()) set(r, r.A); };
    };
    const cfgs = {
      noFlip: () => { g.flip.enabled = false; return () => { g.flip.enabled = true; }; },
      flipHarness: flip,
      respec: sub((at, arr) => { gl.bufferData(ARR, arr, usage()); return true; }),
      respecDyn: sub((at, arr) => { if (usage() !== 35048) return false; gl.bufferData(ARR, arr, 35048); return true; }),
      respecAsStream: sub((at, arr) => { gl.bufferData(ARR, arr, 35040); return true; }),
      oneUp: sub(() => nth() > 0),
      fourUp: sub(() => nth() > 3),
      halfUp: sub(() => nth() % 2 === 1),
      prime,
      full: () => () => {},
      // Four ragdolls kept in the air near the player (ent/ragdoll.ts): what a few flying people cost.
      rag4: () => {
        const ps = [0, 1, 2, 3].map((i) => g.people.spawn(g.player.x + 3 + i, g.player.z + 4, 0));
        const go = () => { for (let i = 0; i < ps.length; i++) { const p = ps[i]; if (g.people.rag.flying(p)) continue; p.x = g.player.x + 3 + i * 1.5; p.z = g.player.z + 5; p.y = g.player.person.y; p.pose = 'stand'; g.people.rag.hitByCar(p, 9 + i * 3, 4, { always: true, silly: false }); } };
        go(); const id = setInterval(go, 400);
        return () => { clearInterval(id); for (const p of ps) g.people.remove(p); };
      },
      frozen: () => { g.tick = () => {}; return () => { delete g.tick; }; },
      noHud: () => off(g.hud),
      hudHidden: () => { const els = [...document.body.children].filter((e) => e !== g.canvas && e.style.display !== 'none'); for (const e of els) e.style.display = 'none'; return () => { for (const e of els) e.style.display = ''; }; },
      noBufUp: () => off(gl, 'bufferSubData'),
      noTexUp: () => off(gl, 'texSubImage2D'),
      noReflect: () => off(V, 'reflect'),
      noShadowUpd: () => { g.renderer.shadowMap.autoUpdate = false; return () => { g.renderer.shadowMap.autoUpdate = true; }; },
      noPost: () => { if (!g.post) return () => {}; g.post.enabled = false; return () => { g.post.enabled = true; }; },
      // Photo mode (src/fx/photo.ts) open, with and without depth of field: the difference is what the blur costs.
      photo: () => { g.photo.enter(); Object.assign(g.photo.set, { dof: 0 }); g.photo.apply(); return () => g.photo.leave(); },
      photoDof: () => { g.photo.enter(); Object.assign(g.photo.set, { dof: 0.9, focus: 6 }); g.photo.apply(); return () => g.photo.leave(); },
      noAO: () => { if (!g.post) return () => {}; g.post.aoOn = false; return () => { g.post.aoOn = true; }; },
    };
    const names = Object.keys(cfgs).filter((k) => !cfgOnly || cfgOnly.includes(k));
    const len = Math.hypot(p[2] - p[0], p[3] - p[1]), h0 = Math.atan2(p[2] - p[0], p[3] - p[1]);
    const run = async (move) => {
      const stamps = []; let t0 = 0;
      if (move) g.player.teleport(p[0], p[1], h0); else G.teleport(at[0], at[1], at[2]);
      g.cam.snap();
      const inner = g.tick; // a config may have replaced it
      g.tick = function (dt) {
        const now = performance.now(); if (!t0) t0 = now;
        if (move) { let d = ((now - t0) / 1000 * speed) % (2 * len); const back = d > len; if (back) d = 2 * len - d; const f = d / len; g.player.teleport(p[0] + (p[2] - p[0]) * f, p[1] + (p[3] - p[1]) * f, back ? h0 + Math.PI : h0); }
        stamps.push(now); inner.call(g, dt);
      };
      g.frozen = false;
      await new Promise((r) => setTimeout(r, secs * 1000 + 250));
      g.frozen = true;
      if (inner === proto.tick) delete g.tick; else g.tick = inner;
      const d = []; for (let i = 8; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
      d.sort((a, b) => a - b);
      return d;
    };
    const acc = {};
    for (const k of names) acc[k] = { stand: [], move: [] };
    await run(false); await run(true); // warm up: the first run of a session always has a long frame
    for (let r = 0; r < rounds; r++) for (const k of names) {
      const undo = cfgs[k]();
      for (const m of modes) acc[k][m].push(...await run(m === 'move'));
      undo();
    }
    const stat = (d) => { if (!d.length) return null; d.sort((a, b) => a - b); const avg = d.reduce((a, b) => a + b, 0) / d.length; return `${(1000 / avg).toFixed(1)}fps med ${d[d.length >> 1].toFixed(1)} ${avg.toFixed(1)}/${d[Math.floor(d.length * 0.95)].toFixed(1)}/${d[d.length - 1].toFixed(1)} >18:${Math.round(100 * d.filter((x) => x > 18).length / d.length)}% >25:${Math.round(100 * d.filter((x) => x > 25).length / d.length)}%`; };
    const out = {};
    for (const k of names) out[k] = { stand: stat(acc[k].stand), move: stat(acc[k].move) };
    return out;
  }, [SC.path, SC.at, Number(opt.secs ?? 2.5), Number(opt.rounds ?? 2), typeof opt.cfg === 'string' ? opt.cfg.split(',') : null, Number(opt.speed ?? 22), typeof opt.modes === 'string' ? opt.modes.split(',') : ['stand', 'move']]);
  const gpu = await t.page.evaluate(() => { const gl = window.__game.game.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
  console.log(JSON.stringify({ q, scene: name, gpu, 'fps avg/p95/max ms': 1 }));
  for (const k in res) console.log(`  ${k.padEnd(12)} stand ${res[k].stand ?? '-'}   move ${res[k].move ?? '-'}`);
} finally {
  console.log(JSON.stringify({ errors: t.errors }));
  await t.close();
}
