// Fun queue 2, item 29: more chat-wheel lines, and Follow me. Headless browsers against LOCAL services.
//
//   node tools/net/chatwheel.mjs [--noshots]
//
// Two pages (A and B) in town on a local main and backup server, as tools/net/convoy.mjs does (never the live town).
// The lines ride on PlayerEvent.Chat (21): phrase indices only. Line 36 is Follow me (game/follow.ts).
//  0. Both in town; A's wheel opens with the new Follow me item and the More group.
//  1. A says a new line (37, "Nice driving!") and an old one (6, "Yes. In writing."): both are in B's log.
//  2. A says Follow me (36): A's confirmation toast; B has a beacon for A (halo and ring in the scene) and an F blip
//     on the radar, with about 20 s to go.
//  3. The light stays on for the whole time, then goes off (the beacon, the halo, the ring and the blip) at about 20 s.
//  4. A has no beacon of its own; no errors from the game on either page.
// Prints PASS or FAIL per check; ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8894, LOOKUP = 8895, BACKUP = 8896;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-chatwheel-'));
const kids = [];
const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome(port, dir) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, dir) } });
  kids.push(c);
  return c;
}
const stop = async (c) => { if (c.exitCode === null) { const gone = new Promise((r) => c.once('exit', r)); try { c.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); } };
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${MAIN}` }));
}).listen(LOOKUP, '127.0.0.1');
const viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8895|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag) {
  const t = await boot({ start: false, query: `q=low&${viaMain}`, width: 640, height: 360 });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.chat = () => t.page.evaluate(() => window.__game.game.chat.info());
  t.scene = () => t.page.evaluate(() => { const s = window.__game.game.scene; return { halo: s.children.filter((c) => c.name === 'net_follow').length, ring: s.children.filter((c) => c.name === 'net_follow_ring').length }; });
  t.radarF = () => t.page.evaluate(() => window.__game.game.hud.nav.blips.filter((b) => b.label === 'F').length);
  t.toast = (re, ms = 6000) => wait(async () => (await t.page.evaluate((s) => (document.body.innerText.match(new RegExp(s)) || [''])[0], re.source)) || null, ms);
  t.say = (phrase) => t.page.evaluate((p) => window.__game.game.chat.say(p, 255), phrase);
  t.teleport = (x, z) => t.page.evaluate(([x, z]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, 0); return true; }, [x, z]);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `chatwheel-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A');
  const B = await visitor('B');
  const both = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.status === 'online' && b.status === 'online' && a.count === 2 && b.count === 2 ? [a, b] : null; }, 60000);
  check(!!both, 'two pages in town, each sees the other');
  if (!both) throw new Error('the two pages did not meet');
  const [idA, idB] = [both[0].id, both[1].id];
  await sleep(800);
  await A.teleport(49, 76);
  await B.teleport(55, 80);
  await sleep(1200);

  // ── 0. The wheel ──
  await A.page.evaluate(() => window.__game.game.chat.show());
  await sleep(300);
  const wheel = await A.page.evaluate(() => [...document.querySelectorAll('.chw-it')].map((e) => e.textContent));
  check(wheel.includes('Follow me!') && wheel.includes('More...'), 'the wheel has Follow me! and More... at the top', wheel.join(' | '));
  await A.page.evaluate(() => window.__game.game.chat.close());
  await A.page.evaluate(() => window.__game.game.chat.show());
  await A.shot('wheel');
  await A.page.evaluate(() => window.__game.game.chat.close());

  // ── 1. New and old lines both arrive ──
  await A.say(37); // Nice driving!
  await sleep(1700);
  await A.say(6); // Yes. In writing.
  const got = await wait(async () => { const l = (await B.chat()).log; return l.some((x) => x.includes('Nice driving!')) && l.some((x) => x.includes('Yes. In writing.')) ? l : null; }, 8000);
  check(!!got, 'B shows the new line (Nice driving!) and an old one (Yes. In writing.)', got ? got.slice(-2).join(' | ') : (await B.chat()).log.join(' | '));
  check((await A.chat()).log.some((x) => x.startsWith('You: Nice driving!')), "A's own log shows the line it said");
  await sleep(1200);

  // ── 2. Follow me lights A for B ──
  await sleep(1700);
  const t0 = Date.now();
  await A.say(36); // Follow me!
  check(!!(await A.toast(/lit up for everybody in town/, 4000)), "A gets the confirmation (lit up for everybody in town)");
  const lit = await wait(async () => { const c = await B.chat(); return c.beacons.length === 1 && c.beacons[0].id === idA ? c.beacons[0] : null; }, 5000, 100);
  check(!!lit, "B has a beacon for A", lit ? `left ${lit.left} s` : "none");
  const sc = await B.scene();
  check(sc.halo === 1 && sc.ring === 1, 'the halo and the ground ring are in B\'s scene', JSON.stringify(sc));
  const f = await wait(() => B.radarF().then((n) => (n >= 1 ? n : null)), 4000, 150);
  check(!!f, 'B has an F badge on the radar for A');
  const a0 = await A.chat();
  check(a0.beacons.length === 0, "A has no beacon of its own");
  await B.shot('beacon');
  // A close look at A from B's side: the halo over A and the ring under A's feet.
  await B.page.evaluate((id) => { const G = window.__game, r = G.game.net.peers.find((p) => p.id === id); if (r) G.view(r.x + 6, r.y + 6, r.z + 12, r.x, r.y + 2.5, r.z); return !!r; }, idA);
  await sleep(700);
  await B.shot('beacon-close');
  await sleep(6000);
  const mid = await B.chat();
  check(mid.beacons.length === 1 && mid.beacons[0].left > 5 && mid.beacons[0].left < 16, 'still lit about 8 s later', mid.beacons[0] ? `left ${mid.beacons[0].left} s` : 'off');

  // ── 3. The light goes off at about 20 s ──
  const off = await wait(async () => { const c = await B.chat(); return c.beacons.length === 0 ? Date.now() - t0 : null; }, 30000, 150);
  const secs = off ? off / 1000 : -1;
  check(secs >= 18 && secs <= 23, 'the beacon goes off after about 20 s', `${secs.toFixed(1)} s`);
  const after = await B.scene();
  check(after.halo === 0 && after.ring === 0, 'the halo and the ring are taken out of the scene', JSON.stringify(after));
  await sleep(600);
  check((await B.radarF()) === 0, 'the radar F badge is gone too');

  // ── 4. Nothing from the game on the pages ──
  const errs = [A, B].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
  check(errs.length === 0, 'no errors from the game on either page', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
  void idB;
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  for (const t of open.splice(0)) await t.close().catch(() => {});
  lookup.close();
  await Promise.all(kids.map(stop));
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
