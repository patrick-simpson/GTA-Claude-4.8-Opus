// Measures a production build (dist/ or any copy of it): video memory of textures, bytes served, errors, and the
// before/after picture set. The folder is served the way the live site does (gzip for html, js, css, json, wasm and
// .glb; pictures raw). Part of the asset pipeline (tools/assets/README.md).
//
//   node tools/assets/measure.mjs --dist scratch/ktx/tree/dist --tag after                 high, then --mobile
//   node tools/assets/measure.mjs --dist <dir> --tag after --only high --shots scratch/ktx/pics/after
//   node tools/assets/measure.mjs --dist <dir> --query ktx=0 --tag after-ktx0
//
// GPU memory: every texImage2D / texStorage2D / compressed upload is counted per texture object (deleteTexture
// takes it back), so it is what the driver was asked to hold: `assetMB` the pictures and model textures that carry
// data (compressed ones counted at their block size), `targetMB` the render targets and shadow maps (the same in
// every build), mips included. One JSON line per run: { run, gpu, served, errors }.

import { chromium } from 'playwright';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; }
const DIST = path.resolve(String(opt.dist || 'dist'));
const tag = String(opt.tag || 'run');
const runs = (opt.only ? String(opt.only).split(',') : ['high', 'mobile']);
const extra = typeof opt.query === 'string' ? opt.query : '';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2' };
const ZIP = new Set(['.html', '.js', '.css', '.glb', '.json', '.wasm']);
const zipped = new Map();
let served = { files: 0, wireBytes: 0 };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(file).toLowerCase();
  let body = fs.readFileSync(file);
  const head = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (ZIP.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    if (!zipped.has(file)) zipped.set(file, zlib.gzipSync(body, { level: 9 }));
    body = zipped.get(file); head['Content-Encoding'] = 'gzip';
  }
  served.files++; served.wireBytes += body.length;
  head['Content-Length'] = body.length;
  res.writeHead(200, head); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/** Runs in the page before anything else: count the video memory the page asks the driver for. */
const HOOK = () => {
  const P = WebGL2RenderingContext.prototype;
  const TEX = new Map(), bound = {};
  const BPP = { 0x8058: 4, 0x8051: 3, 0x8C43: 4, 0x8C41: 3, 0x8229: 1, 0x822B: 2, 0x1908: 4, 0x1907: 3, 0x1903: 1, 0x8227: 2, 0x1909: 1, 0x190A: 2, 0x1906: 1,
    0x881A: 8, 0x8814: 16, 0x8C3A: 4, 0x81A6: 4, 0x81A5: 2, 0x8CAC: 4, 0x88F0: 4, 0x8CAD: 5, 0x822D: 2, 0x822F: 4, 0x881B: 6, 0x822E: 4, 0x8230: 8, 0x8235: 4, 0x8D48: 1, 0x8059: 4, 0x8056: 2, 0x8057: 2, 0x8D62: 2, 0x8C42: 4, 0x8F97: 1, 0x8F95: 2 };
  // Compressed formats: bytes per texel (16-byte blocks of 4x4 = 1, 8-byte blocks = 0.5).
  const CBPP = { 0x8E8C: 1, 0x8E8D: 1, 0x93B0: 1, 0x93D0: 1, 0x9278: 1, 0x9279: 1, 0x9274: 0.5, 0x9275: 0.5, 0x83F0: 0.5, 0x83F1: 0.5, 0x83F2: 1, 0x83F3: 1, 0x8C4C: 0.5, 0x8C4D: 0.5, 0x8C4E: 1, 0x8C4F: 1, 0x8D64: 0.5, 0x9270: 0.5, 0x9271: 0.5, 0x9272: 0.5, 0x9273: 0.5 };
  const rec = (t) => { let r = TEX.get(t); if (!r) { r = { levels: new Map(), asset: false, comp: false, mips: false, store: false }; TEX.set(t, r); } return r; };
  const cur = (tg) => bound[tg] || null;
  const bytes = (f, w, h, comp) => {
    if (comp) { const b = CBPP[f] ?? 1; return Math.ceil(w / 4) * 4 * Math.ceil(h / 4) * 4 * b; }
    return w * h * (BPP[f] ?? 4);
  };
  const wrap = (name, fn) => { const o = P[name]; P[name] = function (...a) { try { fn.apply(this, a); } catch { /* counting must never break the page */ } return o.apply(this, a); }; };
  wrap('bindTexture', (tg, t) => { bound[tg] = t; });
  wrap('deleteTexture', (t) => { TEX.delete(t); });
  wrap('texImage2D', (tg, lv, f, ...r) => {
    const t = cur(tg); if (!t) return;
    let w, h, data;
    if (r.length >= 5) { w = r[0]; h = r[1]; data = r[5]; } else { const s = r[2]; w = s?.width ?? s?.videoWidth ?? 0; h = s?.height ?? s?.videoHeight ?? 0; data = s; }
    const x = rec(t); x.levels.set(tg + ':' + lv, bytes(f, w, h, false)); if (data) x.asset = true;
  });
  wrap('texStorage2D', (tg, n, f, w, h) => {
    const t = cur(tg); if (!t) return; const x = rec(t); x.store = true;
    const comp = f in CBPP;
    for (let l = 0; l < n; l++) x.levels.set(tg + ':' + l, bytes(f, Math.max(1, w >> l), Math.max(1, h >> l), comp));
    if (comp) x.comp = true;
  });
  wrap('compressedTexImage2D', (tg, lv, f, w, h, b, d) => {
    const t = cur(tg); if (!t) return; const x = rec(t); x.comp = true; x.asset = true; x.levels.set(tg + ':' + lv, bytes(f, w, h, true));
  });
  wrap('texSubImage2D', (tg, lv, xo, yo, ...r) => { const t = cur(tg); if (t && r[r.length - 1] !== null) rec(t).asset = true; });
  wrap('compressedTexSubImage2D', (tg) => { const t = cur(tg); if (t) { const x = rec(t); x.asset = true; x.comp = true; } });
  wrap('generateMipmap', (tg) => { const t = cur(tg); if (t) { const x = rec(t); if (!x.store) x.mips = true; } });
  window.__gpuTop = () => [...TEX.values()].filter((x) => x.asset || x.comp).map((x) => { let b = 0; for (const v of x.levels.values()) b += v; if (x.mips) b *= 4 / 3; return { MB: +(b / 1048576).toFixed(2), comp: x.comp, lv: x.levels.size }; }).sort((a, b) => b.MB - a.MB).slice(0, 14);
  window.__gpu = () => {
    let asset = 0, target = 0, comp = 0, n = 0, na = 0;
    for (const x of TEX.values()) {
      let b = 0; for (const v of x.levels.values()) b += v; if (x.mips) b *= 4 / 3;
      n++;
      if (x.asset || x.comp) { asset += b; na++; if (x.comp) comp += b; } else target += b;
    }
    return { assetMB: +(asset / 1048576).toFixed(1), compressedMB: +(comp / 1048576).toFixed(1), targetMB: +(target / 1048576).toFixed(1), textures: n, assetTextures: na };
  };
};

const VIEWS = [
  { name: 'downtown', land: 0, at: [-23.5, 22, 3.14], view: [-27.4, 2.1, 26, -31.5, 1.6, -60] },
  { name: 'speedscan', land: 0, at: [27, 100, 3.14], view: [27, 3, 112, 27, 22, 40] },
  { name: 'car', land: 0, at: [-30, 70, 3.14], drive: 'bolt', closeup: true },
  { name: 'mainst', land: 1, at: [80, -1300, 3.14] },
  { name: 'pardons', land: 1, at: [-628, -1135, 0] },
  { name: 'pardonssign', land: 1, at: [-640, -1215, 0], view: [-640, 3.2, -1215, -640, 4.5, -1160] },
];
const HOURS = [14, 22];
const mobile = (m) => m === 'mobile';
const mem = {};
const allErrors = [];

for (const m of runs) {
  const phone = mobile(m);
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
  for (const land of [0, 1]) {
    const views = VIEWS.filter((v) => v.land === land);
    const ctx = await browser.newContext(phone ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    const THIRD = /youtube|ytimg|googlevideo|doubleclick|google\.com|gstatic|googleads|ggpht|compute-pressure/i;
    page.on('console', (x) => { if (x.type() === 'error' && !THIRD.test(x.text() + (x.location()?.url ?? ''))) errors.push(x.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push(String(e.stack || e).slice(0, 300)));
    await page.addInitScript(HOOK);
    served = { files: 0, wireBytes: 0 };
    const q = [phone ? 'q=low' : 'q=high', 'save=0', 'net=0', land ? 'bridge=8&stage=4' : '', extra].filter(Boolean).join('&');
    await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 120000 });
    await page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
    const step = (n) => page.evaluate((n) => window.__game.step(n), n);
    const game = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__game, ${JSON.stringify(arg ?? null)})`);
    for (let i = 0; i < 7; i++) { await page.waitForTimeout(1500); await step(4); }
    const run = { run: `${tag}-${m}-${land ? 'land' : 'island'}`, served: { files: served.files, wireMB: +(served.wireBytes / 1e6).toFixed(2) } };
    const hours = opt.shots ? HOURS : [14];
    for (const v of views) {
      for (const h of hours) {
        await game((g) => { g.view(); g.setHeat(0); g.setWeather('clear'); });
        await game((g, hh) => g.setTime(hh), h);
        await game((g, a) => g.teleport(a[0], a[1], a[2]), v.at);
        if (v.drive) await game((g, k) => g.drive(k), v.drive);
        await step(120);
        for (let i = 0; i < 3; i++) { await page.waitForTimeout(1200); await step(6); }
        if (v.closeup) await game((g) => { const p = g.game.player; g.view(p.x + 2.6, 1.0, p.z + 2.8, p.x, 0.62, p.z); });
        else if (v.view) await game((g, a) => g.view(a[0], a[1], a[2], a[3], a[4], a[5]), v.view);
        await step(30);
        if (opt.shots) {
          const out = path.resolve(String(opt.shots), `${v.name}-${h}.png`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await page.screenshot({ path: out });
        }
      }
    }
    run.gpu = await page.evaluate(() => window.__gpu());
    if (opt.top) run.top = await page.evaluate(() => window.__gpuTop());
    run.errors = errors;
    allErrors.push(...errors);
    console.log(JSON.stringify(run));
    await ctx.close();
  }
  await browser.close();
}
server.close();
if (allErrors.length) process.exitCode = 1;
