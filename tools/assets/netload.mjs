// Copy of tools/lead/netload.mjs for the asset pipeline: DIST=<dir> OUT=<dir> pick the build and the pictures, nets are 4g (9 Mbps, 60 ms) and f3g (Fast 3G, 1.6 Mbps, 150 ms).
// What a visitor waits through (M6 section 4). Serves dist/ the way the live site does (GitHub Pages: gzip for
// html, js, css and .glb; pictures and fonts raw), slows the network through the DevTools protocol, starts the game
// the moment the title card allows it and photographs it 1, 3, 6 and 12 s later.
//
//   node scratch/m6/netload.mjs --tag before                 all four runs (fast/slow x high/low-on-a-phone)
//   node scratch/m6/netload.mjs --tag after --only slow-low
//
// Times are the page's own clock (ms after navigation). One JSON line per run, then a table, then two contact sheets
// scratch/m6/net-<tag>-high.png and -low.png (rows: fast, slow; columns: 1, 3, 6, 12 s after the start).
//   title     the title card exists (hooks.boot.titleAt)
//   playable  the card says start (hooks.boot.playableAt when the build has it, else hooks.ready)
//   noBoxes   people, trees, props and every car kind within 80 m of the player are drawn from a model file
//   final     ...and those cars from their full file (three levels), where the preset draws more than the far level
//   lastFile  the last response finished

import { chromium } from 'playwright';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(process.env.DIST || path.join(ROOT, 'dist')), OUT = path.resolve(process.env.OUT || path.join(ROOT, 'scratch', 'm6'));
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; }
const tag = opt.tag || 'run';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
const ZIP = new Set(['.html', '.js', '.css', '.glb', '.svg', '.json', '.wasm']);
const zipped = new Map();
let sent = { files: 0, bytes: 0, wire: {}, raw: 0, rawBy: {} };
const kb = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v / 1000)]));
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
  // What the server sent is the count that cannot be missed (a worker's requests do not reach the page's own log).
  const e = ext.slice(1) || 'html', rawLen = fs.statSync(file).size;
  sent.files++; sent.bytes += body.length; sent.wire[e] = (sent.wire[e] || 0) + body.length; sent.raw += rawLen; sent.rawBy[e] = (sent.rawBy[e] || 0) + rawLen;
  head['Content-Length'] = body.length;
  res.writeHead(200, head); res.end(body);
});
// Packed before the first request: packing a file while the page waits for it would be charged to whichever run came first.
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(DIST)) if (ZIP.has(path.extname(f).toLowerCase())) zipped.set(f, zlib.gzipSync(fs.readFileSync(f), { level: 9 }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const NETS = { '4g': { down: 9e6 / 8, up: 3e6 / 8, latency: 60 }, f3g: { down: 1.6e6 / 8, up: 0.75e6 / 8, latency: 150 }, fast: { down: 25e6 / 8, up: 5e6 / 8, latency: 40 }, slow: { down: 6e6 / 8, up: 1.5e6 / 8, latency: 100 } };
const RUNS = [['4g', 'high'], ['f3g', 'high'], ['4g', 'low'], ['f3g', 'low']].filter(([n, q]) => !opt.only || String(opt.only).split(',').includes(`${n}-${q}`));
const SHOTS = [1, 3, 6, 12];
const FLORA = ['flora2.glb', 'flora_atlas.webp', 'flora_mask.webp', 'flora_nrm.webp', 'flora_far.webp', 'flora_far_mask.webp'];

/** Runs in the page. Property names survive the minifier; class names do not, so the owners are found by what they hold. */
const probe = (low) => {
  const h = window.__game, out = { now: performance.now() };
  if (!h || !h.game) return out;
  const g = h.game, P = (window.__p ??= {});
  const find = (pred) => {
    const seen = new Set(), q = [[g, 0]];
    while (q.length) {
      const [o, d] = q.shift();
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      try { if (o !== g && pred(o)) return o; } catch { /* a getter that throws is not what we want */ }
      if (d >= 3 || Array.isArray(o) || ArrayBuffer.isView(o) || o.isObject3D || o instanceof Node || o instanceof Map || o instanceof Set) continue;
      for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') q.push([v, d + 1]); }
    }
    return null;
  };
  out.ready = !!h.ready; out.titleAt = h.boot?.titleAt; out.playableAt = h.boot?.playableAt; out.builtAt = h.boot?.builtAt; out.state = g.state; out.error = h.error || '';
  try {
    if (g.people && !P.people) P.people = find((o) => Array.isArray(o.assets) && 'tex' in o && typeof o.adopt === 'function');
    out.people = P.people ? P.people.assets.length >= 2 : false;
    out.loads = h.loads ? h.loads() : null;
    const v = g.vehicles, p = g.player;
    if (v && p) {
      const near = new Set();
      for (const c of v.list) { const dx = c.x - p.x, dz = c.z - p.z; if (dx * dx + dz * dz < 6400) near.add(c.spec.kind); }
      out.near = near.size; out.kinds = v.assets.size;
      out.carsAny = [...near].every((k) => v.assets.has(k));
      out.carsFull = [...near].every((k) => { const a = v.assets.get(k); return !!a && (low || a.lods.length >= 3); });
    }
  } catch (e) { out.err = String(e); }
  return out;
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const rows = [];
for (const [net, q] of RUNS) {
  const phone = q === 'low';
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NETS[net].latency, downloadThroughput: NETS[net].down, uploadThroughput: NETS[net].up });
  const urls = new Map(), wire = {}, raw = {}, doneAt = new Map(); let files = 0, inFlight = 0, lastDone = 0, wireTotal = 0;
  cdp.on('Network.requestWillBeSent', (e) => { if (!urls.has(e.requestId)) inFlight++; urls.set(e.requestId, e.request.url); });
  cdp.on('Network.loadingFinished', (e) => {
    const u = urls.get(e.requestId) || ''; if (u.startsWith('data:') || u.startsWith('blob:')) { inFlight--; return; }
    const ext = (path.extname(new URL(u).pathname) || '.html').slice(1);
    doneAt.set(path.basename(new URL(u).pathname), Date.now()); wire[ext] = (wire[ext] || 0) + e.encodedDataLength; wireTotal += e.encodedDataLength; files++; inFlight--; lastDone = Date.now();
    try { raw[ext] = (raw[ext] || 0) + fs.statSync(path.join(DIST, decodeURIComponent(new URL(u).pathname).replace(/\/$/, '/index.html'))).size; } catch { /* not a file of ours */ }
  });
  cdp.on('Network.loadingFailed', () => { inFlight--; });

  sent = { files: 0, bytes: 0, wire: {}, raw: 0, rawBy: {} };
  let holdShot = false;
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?q=${q}&save=0${opt.query ? '&' + opt.query : ''}`, { waitUntil: 'commit', timeout: 120000 });
  const r = { net, q, title: null, playable: null, start: null, noBoxes: null, final: null, lastFile: null };
  let offset = 0, shot = 0, lastFileAt = 0, lastSeen = null;
  for (;;) {
    let s;
    try { s = await page.evaluate(probe, phone); } catch { await new Promise((z) => setTimeout(z, 50)); continue; }
    offset = Date.now() - s.now; lastSeen = s;
    if (r.title === null && s.titleAt !== undefined) r.title = Math.round(s.titleAt);
    if (r.playable === null && (s.playableAt || (s.playableAt === undefined && s.ready))) {
      r.playable = Math.round(s.playableAt || s.now);
      r.ready = Math.round(s.now);
      await page.evaluate(() => window.__game.start());
      r.start = Math.round(await page.evaluate(() => performance.now()));
    }
    // The trees and the street furniture have no hook in the older builds: they count from the moment their files are in.
    const mk = s.loads?.marks;
    const flora = phone || (mk ? mk.flora !== undefined : FLORA.every((f) => doneAt.has(f))), props = phone || (mk ? mk.props !== undefined : doneAt.has('props.glb'));
    // The card while it is holding the start for the downloads, once per run.
    if (!holdShot && s.builtAt && r.playable === null && s.now - s.builtAt > 2500) { holdShot = true; await page.screenshot({ path: path.join(OUT, `net-${tag}-${net}-${q}-hold.png`) }); }
    if (s.people && flora && props && s.near !== undefined) {
      if (r.noBoxes === null && s.carsAny) r.noBoxes = Math.round(s.now);
      if (r.final === null && s.carsFull) r.final = Math.round(s.now);
    }
    if (r.start !== null && shot < SHOTS.length && s.now - r.start >= SHOTS[shot] * 1000) {
      await page.screenshot({ path: path.join(OUT, `net-${tag}-${net}-${q}-${SHOTS[shot]}s.png`) });
      shot++;
    }
    if (lastDone) lastFileAt = lastDone - offset;
    const idle = s.loads ? s.loads.filesDone >= s.loads.files && s.now - s.loads.lastAt > 2500 : lastDone && Date.now() - lastDone > 2500;
    if (s.error) { errors.push(s.error.slice(0, 300)); break; }
    if ((shot >= SHOTS.length && r.final !== null && idle) || Date.now() - t0 > 420000) break;
    await new Promise((z) => setTimeout(z, 60));
  }
  r.lastFile = lastSeen?.loads?.lastAt || Math.round(lastFileAt); r.files = sent.files; r.wireKB = Math.round(sent.bytes / 1000);
  r.wire = kb(sent.wire); r.rawKB = Math.round(sent.raw / 1000); r.raw = kb(sent.rawBy);
  r.built = lastSeen?.builtAt; r.marks = lastSeen?.loads?.marks;
  r.errors = errors; r.last = lastSeen && { people: lastSeen.people, near: lastSeen.near, kinds: lastSeen.kinds, err: lastSeen.err, loads: lastSeen.loads };
  rows.push(r);
  console.log(JSON.stringify(r));
  await ctx.close();
}

// Contact sheets: one per preset, a row per network, a column per moment.
for (const q of ['high', 'low']) {
  const nets = RUNS.filter((x) => x[1] === q).map((x) => x[0]);
  if (!nets.length) continue;
  const tw = q === 'low' ? 844 : 960, th = q === 'low' ? 390 : 540;
  const cells = nets.map((n) => SHOTS.map((s) => `<div><img src="net-${tag}-${n}-${q}-${s}s.png" width="${tw}" height="${th}"><b>${n} ${q} +${s}s</b></div>`).join('')).join('');
  const html = `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${SHOTS.length},${tw}px);font:20px sans-serif">${cells}<style>div{position:relative}b{position:absolute;left:6px;top:4px;color:#fff;background:#000a;padding:1px 6px}img{display:block}</style></body>`;
  const f = path.join(OUT, `net-${tag}-${q}.html`);
  fs.writeFileSync(f, html);
  const pg = await browser.newPage({ viewport: { width: tw * SHOTS.length, height: th * nets.length } });
  await pg.goto('file:///' + f.replace(/\\/g, '/'));
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUT, `net-${tag}-${q}.png`) });
  await pg.close();
}
await browser.close();
server.close();
console.log('\nnet  q     title playable noBoxes  final lastFile files  wire kB  raw kB');
for (const r of rows) console.log(`${r.net.padEnd(4)} ${r.q.padEnd(5)} ${String(r.title).padStart(5)} ${String(r.playable).padStart(8)} ${String(r.noBoxes).padStart(7)} ${String(r.final).padStart(6)} ${String(r.lastFile).padStart(8)} ${String(r.files).padStart(5)} ${String(r.wireKB).padStart(8)} ${String(r.rawKB).padStart(7)}`);
if (rows.some((r) => r.errors.length)) { console.log('ERRORS', JSON.stringify(rows.map((r) => r.errors))); process.exitCode = 1; }
