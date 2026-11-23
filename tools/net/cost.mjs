// Multiplayer stage 5, hardening, part 2: WHAT THE BACKUP COSTS. Real game pages against the real Worker code run
// locally (`wrangler dev`: workerd, no Cloudflare account, no network), measured with the service's OWN meter.
//
//   node tools/net/cost.mjs                    2, 4 and 8 players; still, moving and fighting, 90 s each
//   node tools/net/cost.mjs --seconds 30 --sizes 2,4
//   node tools/net/cost.mjs --pause            only the pause check (small limits, the movable clock)
//
// The Worker is started with TEST_BUDGET (the local-only variable server/README.md describes): limits so large that
// nothing pauses, and 8 seats. Before and after each window the meter is read through GET /__test?flush (that read
// itself is one Worker request and one Durable Object request, taken off). The pages reach it as `?net=` (the game
// treats that as the backup, as tools/net/hard3.mjs does), so there is no host traffic: only what the backup carries.
// Also counted from each page's own socket: messages and bytes in and out, so the meter can be checked against them.
//  still:  every player on foot, standing; nobody touches anything.
//  moving: every player in a car of their own, accelerator held, the wheel wiggled.
//  fight:  players in pairs, each holding the trigger of a pistol at the other in turns, healed as they go.
// Then: a refused join ("full", seats 2) and the /main lookup, each measured on their own.
// --pause: limits small enough to reach in a minute (doRequests 60: pause line 24), four real pages moving: the
// service must send them home with "rest" before it has counted half the limit, and they must say it and play alone;
// the movable clock then moves a day on and they must be let back in.
//
// What this cannot tell: what Cloudflare really bills. The meter is the service's own estimate (server/src/city.ts):
// messages / 20 for requests is Cloudflare's stated rule; duration is an UPPER bound (every gap up to 10 s counted as
// awake). The game here runs at about a tenth of real speed and several pages share four processors; frames sent on
// the wall clock (state at 10 a second while moving, keepalives, frame times) are counted as in real play only if
// each page keeps up 10 frames a second; the per page message rates are printed so this can be judged.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { services, check, note, failures, sleep, wait, ownCar, onFoot, f1 } from './hardlib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 90));
const SIZES = String(arg('--sizes', '2,4,8')).split(',').map(Number);
const PAUSE_ONLY = process.argv.includes('--pause');
const PORT = 8861;
const HTTP = `http://127.0.0.1:${PORT}`;
const serverDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'server');
const BIG = { workerRequests: 1e9, doRequests: 1e9, doGbSeconds: 1e9, rowsWritten: 1e9, rowsRead: 1e12, seats: 8 };

let worker = null, persist = null, log = '';
async function startWorker(budget) {
  persist ??= mkdtempSync(path.join(tmpdir(), 'pc-cost-'));
  log = '';
  worker = spawn(path.join(serverDir, 'node_modules', '.bin', 'wrangler'),
    ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--show-interactive-dev-session=false', '--var', `TEST_BUDGET:${JSON.stringify(budget)}`],
    { cwd: serverDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
  worker.stdout.on('data', (d) => (log += d)); worker.stderr.on('data', (d) => (log += d));
  for (const end = Date.now() + 90000; Date.now() < end;) {
    try { const r = await fetch(HTTP + '/'); if (r.ok && (await r.text()).startsWith('port-calamity-')) return; } catch { /* not yet */ }
    await sleep(400);
  }
  throw new Error('wrangler dev did not start: ' + log.slice(-1500));
}
async function stopWorker() {
  const c = worker; worker = null;
  if (!c || c.exitCode !== null) return;
  const gone = new Promise((r) => c.once('exit', r));
  try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([gone, sleep(8000)]);
  try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
}
/** The meter: the count so far (the read itself is taken off: 1 Worker request, 1 DO request). */
async function meter(q = 'flush') {
  const r = await (await fetch(`${HTTP}/__test?${q}`)).json();
  return r;
}
const diff = (a, b) => {
  const out = {};
  for (const k of Object.keys(b.used)) out[k] = b.used[k] - a.used[k];
  // Each read counts itself (1 Worker request, 1 DO request) before it answers: the second read's own are taken off.
  out.workerRequests -= 1; out.doRequests -= 1;
  return out;
};

const S = services({ main: 8863, lookup: 8864, backup: PORT });
const via = `net=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}`;
const pages = [];
const sumv = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const sockTotals = () => pages.reduce((s, t) => ({ out: s.out + sumv(t.out.n) + t.outText.n, outB: s.outB + sumv(t.out.bytes) + t.outText.bytes, inn: s.inn + sumv(t.inn.n), innB: s.innB + sumv(t.inn.bytes) }), { out: 0, outB: 0, inn: 0, innB: 0 });

async function grow(n) {
  while (pages.length < n) {
    const t = await S.visitor(String.fromCharCode(65 + pages.length), via, [400, 225], true);
    pages.push(t);
  }
  const ok = await wait(async () => (await Promise.all(pages.map((t) => t.net()))).every((x) => x.status === 'online' && x.count === n), 120000, 1000);
  check(!!ok, `${n} pages online on the backup together`, (await Promise.all(pages.map((t) => t.net()))).map((x) => `${x.status} ${x.home} ${x.count}`).join('; '));
}
const keys = (t, down, ks) => Promise.all(ks.map((k) => (down ? t.page.keyboard.down(k) : t.page.keyboard.up(k)).catch(() => {})));
async function settle() {
  for (const t of pages) { await keys(t, false, ['KeyW', 'KeyA', 'KeyD']); await t.page.evaluate(() => window.__game.game.input.held.delete('fire')).catch(() => {}); }
  for (const t of pages) { await onFoot(t); await t.calm(); await t.heal(); }
}
const SPOT = { x: -360, z: 294.8 };
const ACT = {
  async still(end) {
    for (let i = 0; i < pages.length; i++) await pages[i].go(SPOT.x + i * 30, SPOT.z, 0);
    await sleep(Math.max(0, end - Date.now()));
  },
  async moving(end) {
    for (let i = 0; i < pages.length; i++) { await pages[i].go(SPOT.x + i * 30, SPOT.z + 2, 0); await ownCar(pages[i]); await keys(pages[i], true, ['KeyW']); }
    for (let k = 0; Date.now() < end; k++) {
      const key = k % 2 ? 'KeyA' : 'KeyD';
      await Promise.all(pages.map(async (t) => { await keys(t, true, [key]); await sleep(500); await keys(t, false, [key]); }));
      await sleep(Math.min(4000, Math.max(0, end - Date.now())));
    }
  },
  async fight(end) {
    for (let i = 0; i < pages.length; i++) {
      const pair = Math.floor(i / 2), side = i % 2;
      await pages[i].go(SPOT.x + pair * 40 + side * 8, SPOT.z, side ? Math.PI / 2 : -Math.PI / 2);
      await pages[i].page.evaluate(() => { const w = window.__game.game.player.weapons; w.giveAll(); w.mags[1] = 999; w.select(1); });
    }
    await sleep(2000);
    while (Date.now() < end) {
      await Promise.all(pages.map((t) => t.page.evaluate(() => { window.__game.game.input.press('fire'); }).catch(() => {})));
      await sleep(1500);
      await Promise.all(pages.map(async (t) => { await t.page.evaluate(() => window.__game.game.input.held.delete('fire')).catch(() => {}); await t.heal(); await t.calm(); }));
      await sleep(300);
    }
    for (const t of pages) await t.page.evaluate(() => window.__game.game.player.weapons.select(0)).catch(() => {});
  },
};

const results = [];
async function window_(n, what) {
  await settle();
  await sleep(3000);
  const s0 = sockTotals(), m0 = await meter(), t0 = Date.now();
  await ACT[what](t0 + SECONDS * 1000);
  const secs = (Date.now() - t0) / 1000;
  const m1 = await meter(), s1 = sockTotals();
  const d = diff(m0, m1);
  const perPH = (v) => (v / secs) * 3600 / n;
  const row = { n, what, secs, msgsIn: s1.out - s0.out, msgsOut: s1.inn - s0.inn, bytesIn: s1.outB - s0.outB, bytesOut: s1.innB - s0.innB, ...d };
  row.doReqPerPH = perPH(d.doRequests); row.wReqPerPH = perPH(d.workerRequests); row.gbsPerPH = perPH(d.doGbSeconds); row.rowsPerPH = perPH(d.rowsWritten);
  row.msgsInPerPH = perPH(row.msgsIn); row.awakeFrac = d.doGbSeconds / 0.128 / secs;
  results.push(row);
  console.log(`      ${n} players ${what.padEnd(6)} ${f1(secs)} s: into the service ${row.msgsIn} msgs (${f1(row.msgsIn / secs / n)}/s a player), out ${row.msgsOut}; meter: DO requests ${f1(d.doRequests)}, Worker requests ${d.workerRequests}, GB-s ${d.doGbSeconds.toFixed(2)} (awake ${(row.awakeFrac * 100).toFixed(0)}% of the time), rows written ${d.rowsWritten}, read ${d.rowsRead}`);
}

async function refusals() {
  // A refused join: the town is full (seats 2 here). Raw sockets (the `ws` package the server's own tests use).
  const { default: WebSocket } = await import(path.join(serverDir, 'node_modules', 'ws', 'index.js'));
  const open = () => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?v=4&name=1.2`, { headers: { Origin: 'http://localhost:5173' } });
    const got = [];
    ws.on('message', (m) => got.push(String(m)));
    ws.on('close', (code) => res({ ws, code, got }));
    ws.on('open', () => setTimeout(() => res({ ws, code: null, got, open: true }), 600));
    ws.on('error', () => res({ ws, code: -1, got }));
  });
  const a = await open(), b = await open();
  await sleep(1000);
  const m0 = await meter();
  const c = await open();
  await sleep(500);
  const m1 = await meter();
  const d1 = diff(m0, m1);
  const e = await open();
  await sleep(500);
  const m2 = await meter();
  const d2 = diff(m1, m2);
  for (const x of [a, b, c, e]) try { x.ws.close(); } catch { /* closed */ }
  check(c.code === 4008 && e.code === 4008, 'a third join with 2 seats is refused "full" (twice)', `codes ${c.code}, ${e.code}; ${c.got[0] ?? ''}`);
  console.log(`      refused join, the first in this isolate: Worker requests ${d1.workerRequests}, DO requests ${f1(d1.doRequests)}, rows written ${d1.rowsWritten}, GB-s ${d1.doGbSeconds.toFixed(3)}`);
  console.log(`      refused join, answered from memory:     Worker requests ${d2.workerRequests}, DO requests ${f1(d2.doRequests)}, rows written ${d2.rowsWritten}, GB-s ${d2.doGbSeconds.toFixed(3)}`);
  results.push({ refusedFirst: d1, refusedMemo: d2 });
  await sleep(2000);
  // GET /main, as a page load asks it.
  const g0 = await meter('flush&forget');
  await fetch(`${HTTP}/main`, { headers: { Origin: 'http://localhost:5173' } });
  const g1 = await meter('flush');
  await fetch(`${HTTP}/main`, { headers: { Origin: 'http://localhost:5173' } });
  const g2 = await meter('flush');
  const l1 = diff(g0, g1), l2 = diff(g1, g2);
  console.log(`      GET /main, the first in a minute:  Worker requests ${l1.workerRequests}, DO requests ${f1(l1.doRequests)}, rows written ${l1.rowsWritten}`);
  console.log(`      GET /main, answered from memory:  Worker requests ${l2.workerRequests}, DO requests ${f1(l2.doRequests)}, rows written ${l2.rowsWritten}`);
  results.push({ mainFirst: l1, mainMemo: l2 });
}

async function pauseCheck() {
  // The pause line: doRequests limit 60 a day = 30 the game's share, pause at 24 (80% of it, 40% of the limit).
  await startWorker({ doRequests: 60, seats: 8 });
  for (let i = 0; i < 4; i++) pages.push(await S.visitor(String.fromCharCode(65 + i), via, [400, 225]));
  const on = await wait(async () => (await Promise.all(pages.map((t) => t.net()))).every((x) => x.status === 'online' && x.count === 4), 120000, 1000);
  check(!!on, 'pause: four pages online', (await Promise.all(pages.map((t) => t.net()))).map((x) => `${x.status} ${x.count}`).join('; '));
  for (let i = 0; i < pages.length; i++) { await pages[i].go(SPOT.x + i * 30, SPOT.z + 2, 0); await ownCar(pages[i]); await keys(pages[i], true, ['KeyW']); }
  const rested = await wait(async () => (await Promise.all(pages.map((t) => t.net()))).every((x) => x.notice === 'rest'), 240000, 1000);
  const m = await meter();
  const ns = await Promise.all(pages.map((t) => t.net()));
  check(!!rested && m.spent === 'doRequests', 'pause: the service sends everybody home with "rest" when the requests meter reaches its line', ns.map((x) => `${x.status} notice ${x.notice} "${String(x.noteText).slice(0, 60)}"`).join('; ') + `; meter ${JSON.stringify(m.used)} spent ${m.spent}`);
  check(m.used.doRequests >= m.lines.doRequests && m.used.doRequests < 30, 'pause: it rested at or past 40% of the (test) limit and before 50%', `counted ${f1(m.used.doRequests)} of a limit of 60 (line ${m.lines.doRequests}, half 30)`);
  const solo = await Promise.all(pages.map((t) => t.me()));
  check(solo.every((x) => x.state === 'play') && ns.every((x) => x.status !== 'online'), 'pause: everybody plays on alone', solo.map((x, i) => `${ns[i].status} ${x.state}`).join('; '));
  const resume = ns[0].resumeAt;
  check(resume > 0 && new Date(resume).getUTCHours() === 0 && new Date(resume).getUTCMinutes() <= 5, 'pause: the notice says it resumes at 00:00 UTC (plus at most 5 minutes of spread)', new Date(resume).toISOString());
  // A day on, on the service's movable clock: a page that reloads (with its rest time cleared, as it would be the next day) gets in.
  await meter('add=86400000');
  const t = pages[0];
  await t.page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/rest/i.test(k)) localStorage.removeItem(k); });
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  await t.page.evaluate(() => window.__game.start());
  const back = await t.until((x) => x.status === 'online', 60000);
  const m2 = await meter();
  check(!!back && !m2.spent, 'pause: the next day (movable clock) the town takes players again', `${back ? back.status : 'not online'}; meter day ${m2.day} spent ${m2.spent}`);
}

try {
  if (PAUSE_ONLY) await pauseCheck();
  else {
    await startWorker(BIG);
    for (const n of SIZES) {
      await grow(n);
      for (const what of ['still', 'moving', 'fight']) await window_(n, what);
    }
    for (const t of pages.splice(0)) await t.leave();
    await stopWorker();
    await startWorker({ ...BIG, seats: 2 });
    await refusals();
    console.log('\n      RESULT ' + JSON.stringify(results));
  }
  const errs = pages.flatMap((t) => t.errs().map((e) => `${t.tag}: ${e}`)).filter((e) => !/4008|4009|rest/.test(e));
  check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 500) || '"errors": []');
} catch (e) {
  check(false, 'the measurement ran to the end', String(e && e.stack || e).slice(0, 800));
} finally {
  await S.end();
  await stopWorker();
  if (persist) rmSync(persist, { recursive: true, force: true });
}
console.log(`${failures() ? failures() + ' FAILED' : 'ALL PASS'}`);
process.exit(failures() ? 1 : 0);
