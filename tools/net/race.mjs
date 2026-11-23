// Fun queue item 11: races between players. Headless browsers against LOCAL services.
//
//   node tools/net/race.mjs [--noshots]
//
// Started and stopped as tools/net/crew.mjs is (the same ports: never run two of these tests at once). A is the host;
// B and C are pinned hidden, so they say they cannot host.
//  0. A, alone in town, runs a SOLO time trial (the Ledger Loop): "[G] Race" at the marker, straight to the grid,
//     driven by script; a podium card; the host (A) writes the town record as a fact.
//  1. B and C arrive. A calls the Downtown Circuit: B and C get the invitation (a toast, a marker and an R on the radar);
//     both drive to the marker and join; A presses G again: the grid on all three screens, the countdown lights.
//  2. GO. They race, driven by script at different speeds along the route (2 laps): live positions on every screen;
//     the podium: the same order and the same times on all three; cash for places.
//  3. The record: written by the host, held by every page, and seen by a late joiner D at the marker prompt.
// Pictures (unless --noshots) in shots/race-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8871, LOOKUP = 8872, BACKUP = 8873;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-race-'));
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
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8872|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.race = () => t.page.evaluate(() => window.__game.game.todo.racing.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.rwait = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.race(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.prompt = () => t.page.evaluate(() => window.__game.game.todo.racing.prompt);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `race-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
/** In a fresh car at (x, z), facing h, standing still. */
const carAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; G.teleport(x, z, h); const v = g.vehicles.spawn('sedan', x, z, h); g.player.enter(v, true); g.cam.snap(); return !!g.player.vehicle; }, [x, z, h]);
const routeOf = (t, name) => t.page.evaluate((name) => { const r = window.__game.game.todo.jobs.races.find((x) => x.name === name); return r ? { idx: r.idx, start: r.start, first: r.cps[0], laps: r.laps, n: r.cps.length, par: r.par } : null; }, name);
/** Drive along the race path at `speed` m/s, `side` meters right of the line, once GO is given (the page's own timer). */
const drive = (t, speed, side) => t.page.evaluate(([speed, side]) => {
  const g = window.__game.game, R = g.todo.racing;
  let pts = null, seg = 0, along = 0, last = performance.now();
  const id = setInterval(() => {
    const v = g.player.vehicle;
    if (!v) return;
    if (R.phase !== 'race') { last = performance.now(); if (['done', 'podium', 'idle'].includes(R.phase)) clearInterval(id); return; }
    if (!pts) pts = R.path();
    const now = performance.now();
    let d = speed * (now - last) / 1000; last = now;
    while (d > 0 && seg < pts.length - 1) {
      const a = pts[seg], b = pts[seg + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (along + d < L) { along += d; d = 0; } else { d -= L - along; along = 0; seg++; }
    }
    if (seg >= pts.length - 1) { seg = pts.length - 2; along = Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].z - pts[seg].z); }
    const a = pts[seg], b = pts[seg + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1, k = along / L, dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
    v.x = a.x + (b.x - a.x) * k + dz * side; v.z = a.z + (b.z - a.z) * k - dx * side; v.h = Math.atan2(dx, dz);
    v.vx = dx * speed * 0.2; v.vz = dz * speed * 0.2; v.vy = 0;
  }, 25);
  return true;
}, [speed, side]);
function fmtMs(ms) { const t = Math.round(ms / 100), m = Math.floor(t / 600), s = (t % 600) / 10; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; }
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const solo = await routeOf(A, 'The Ledger Loop');
  const dt = await routeOf(A, 'Downtown Circuit');
  const tf = await routeOf(A, 'Tepid Falls Loop'), cr = await routeOf(A, 'The Coast Run');
  check(!!solo && !!dt && !!tf && !!cr && dt.laps === 2 && tf.laps === 2, 'the three new routes are there (Downtown Circuit and Tepid Falls Loop 2 laps)', JSON.stringify({ dt: dt && dt.idx, tf: tf && { idx: tf.idx, start: tf.start }, cr: cr && cr.idx }));

  // ── 0. Solo: A alone in town ──
  {
    await calm(A);
    await carAt(A, solo.start.x, solo.start.z, Math.atan2(solo.first.x - solo.start.x, solo.first.z - solo.start.z));
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /^\[G\] Race: "The Ledger Loop"/.test(pr), 'alone at a marker: "[G] Race" with par and the record', pr);
    await A.key('KeyG');
    const g = await A.rwait((r) => r.phase === 'grid', 5000);
    check(!!g && g.racers.length === 1, 'alone: G goes straight to the grid (one racer)', g ? `${g.phase}, ${g.racers.length}` : 'no grid');
    await drive(A, 26, 0);
    const done = await A.rwait((r) => r.phase === 'podium', 60000, 500);
    const rs = done ? done.results : [];
    check(!!done && rs.length === 1 && rs[0].how === 1 && rs[0].total > 0, 'solo time trial finished: the podium card', done ? JSON.stringify(rs) : 'never');
    const rec = await wait(async () => { const x = await A.net(); return x.race.records.find((q) => q.route === solo.idx) ?? null; }, 8000);
    check(!!rec && Math.abs(rec.race - (rs[0] ? rs[0].total : 0)) < 101, 'the host (A) wrote the town record for the solo run', JSON.stringify(rec));
    await A.key('KeyG');
  }

  const B = await visitor('B', [960, 540]);
  await B.pin(true);
  const C = await visitor('C');
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net()]); return ns[0].traffic.mode === 'host' && ns[1].traffic.mode === 'guest' && ns[2].traffic.mode === 'guest' ? ns : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];

  // ── 1. A calls the Downtown Circuit ──
  const h0 = Math.atan2(dt.first.x - dt.start.x, dt.first.z - dt.start.z);
  {
    for (const t of [A, B, C]) await calm(t);
    await carAt(A, dt.start.x, dt.start.z, h0);
    // (B a block west on the same street, C two blocks south: both on streets, both out of reach of the marker.)
    await carAt(B, dt.start.x - 110, dt.start.z, Math.PI / 2);
    await carAt(C, dt.start.x, dt.start.z + 200, Math.PI);
    await B.key('KeyK');
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /^\[G\] Call a race: "Downtown Circuit" · 2 laps/.test(pr), 'with others in town: "[G] Call a race", laps, par and record at the marker', pr);
    await A.key('KeyG');
    const ac = await A.rwait((r) => r.phase === 'calling', 4000);
    check(!!ac, 'A is calling', ac ? ac.phase : 'no');
    const binv = await B.rwait((r) => r.invites.length === 1, 6000), cinv = await C.rwait((r) => r.invites.length === 1, 6000);
    const toast = await B.page.evaluate(() => (document.body.innerText.match(/called a race[^\n]*/) || [''])[0]);
    check(!!binv && !!cinv && /Downtown Circuit/.test(toast), 'B and C are invited: a toast and a marker', toast);
    const blip = await B.page.evaluate(() => { const out = []; window.__game.game.todo.racing.blips(out); return out.filter((b) => b.label === 'R' && b.kind === 'goal').length; });
    check(blip === 1, 'B has the race on the radar', `goal R blips ${blip}`);
    await sleep(800);
    await B.shot('invitation');
    // B and C drive up to the marker.
    await carAt(B, dt.start.x - Math.cos(h0) * 8, dt.start.z + Math.sin(h0) * 8, h0);
    await carAt(C, dt.start.x + Math.cos(h0) * 8, dt.start.z - Math.sin(h0) * 8, h0);
    const bj = await B.rwait((r) => r.phase === 'joined', 6000), cj = await C.rwait((r) => r.phase === 'joined', 6000);
    const a3 = await A.rwait((r) => r.racers.length === 3, 6000);
    check(!!bj && !!cj && !!a3, 'B and C drove to the marker and joined; A sees three racers', a3 ? a3.racers.map((r) => r.name).join(', ') : 'no');
    await A.key('KeyG');
    const grids = await Promise.all([A, B, C].map((t) => t.rwait((r) => r.phase === 'grid', 5000)));
    check(grids.every(Boolean), 'A pressed G: the grid on all three screens', grids.map((g) => g ? g.phase : 'no').join(', '));
    await sleep(4300);
    await A.shot('grid');
    const cars = await Promise.all([A, B, C].map((t) => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: +v.x.toFixed(1), z: +v.z.toFixed(1) } : null; })));
    const apart = cars.every((c, i) => c && cars.every((d, j) => i === j || Math.hypot(c.x - d.x, c.z - d.z) > 4));
    check(apart, 'three cars stand on three grid slots', JSON.stringify(cars));
    const lights = await A.page.evaluate(() => { const e = document.getElementById('rc-lights'); return e && e.style.display !== 'none' ? e.innerText.trim() : ''; });
    check(/[123]/.test(lights), 'the countdown lights are up', lights);
  }

  // ── 2. The race ──
  {
    await Promise.all([drive(A, 44, -2.5), drive(B, 39, 2.5), drive(C, 34, 0)]);
    const go = await Promise.all([A, B, C].map((t) => t.rwait((r) => r.phase === 'race', 8000)));
    check(go.every(Boolean), 'GO on all three screens', go.map((g) => g ? g.phase : 'no').join(', '));
    await sleep(16000);
    const mid = await Promise.all([A, B, C].map((t) => t.race()));
    console.log('      boards: ' + mid.map((m) => m.board.join(' | ')).join('  //  '));
    check(mid.every((m) => m.board.length === 3), 'live positions on every screen', mid.map((m) => m.board[0]).join(', '));
    const aName = mid[0].racers.find((r) => r.id === ids[0])?.name ?? '?';
    check(mid.every((m) => (m.board[0] ?? '').includes(aName)), 'every screen has A leading', `${mid.map((m) => m.board[0]).join(', ')} vs ${aName}`);
    await B.shot('midrace');
    const ends = await Promise.all([A, B, C].map((t) => t.rwait((r) => r.phase === 'podium', 90000, 500)));
    check(ends.every(Boolean), 'the podium on all three screens', ends.map((e) => e ? e.phase : 'no').join(', '));
    const res = ends.map((e) => e ? e.results.map((r) => `${r.place}.${r.id}:${r.total}`).join(' ') : '');
    console.log('      results: ' + res.join('  //  '));
    check(!!res[0] && res.every((r) => r === res[0]), 'the same order and the same times on all three screens', res[0]);
    const order = ends[0] ? ends[0].results.map((r) => r.id) : [];
    check(JSON.stringify(order) === JSON.stringify(ids), 'the order is A, B, C (fastest first)', `${order} vs ${ids}`);
    const paid = ends[0] ? ends[0].results.map((r) => r.cash) : [];
    check(paid.length === 3 && paid[0] > paid[1] && paid[1] > paid[2] && paid[2] > 0, 'cash for places, more for higher', JSON.stringify(paid));
    await sleep(500);
    await A.shot('podium');
  }

  // ── 3. The record, and a late joiner ──
  {
    const winner = (await A.race()).results[0];
    const rec = await wait(async () => { const x = await C.net(); return x.race.records.find((q) => q.route === dt.idx && Math.abs(q.race - winner.total) < 101) ?? null; }, 8000);
    check(!!rec && rec.raceBy === winner.name && rec.lap > 0, 'the host wrote the Downtown Circuit record (race and lap), and C has it', JSON.stringify(rec));
    const D = await visitor('D');
    await D.pin(true);
    await D.until((x) => x.status === 'online' && x.count === 4, 60000);
    await calm(D);
    await carAt(D, dt.start.x, dt.start.z, h0);
    await sleep(1500);
    const pr = await D.prompt();
    const dr = (await D.net()).race.records.find((q) => q.route === dt.idx);
    check(!!pr && pr.includes(`record ${fmtMs(winner.total)} by ${winner.name}`) && !!dr, 'a late joiner sees the record and who holds it at the marker', pr);
    const errs = [A, B, C, D].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
  }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  for (const t of open.splice(0)) await t.close().catch(() => {});
  lookup.close();
  await stop(home); await stop(backup);
  for (const c of kids) await stop(c);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
