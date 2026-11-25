// Fun queue 2, item 26: spectator betting on a street race. Headless browsers against LOCAL services.
//
//   node tools/net/betting.mjs [--noshots]
//
// Started and stopped as tools/net/race.mjs is (own ports, never two of these tests at once). A is the host and calls the
// Downtown Circuit; B joins it; C and D stay on foot and are the spectators.
//  1. A calls: C and D get a betting window at once (toast, tag); with one driver in it a bet is refused; B joins: two drivers,
//     the same odds on every screen; B (a racer) cannot bet, not on A and not on themself; stakes under $10 and over $500 refused.
//  2. C backs B ($100, the slower), D backs A ($100): the money comes out at once. A presses G: the window is closed for late bets.
//  3. The race: both are paid by the result the spectators saw (the Done frames): C loses the stake (bt.lost), D is paid floor(stake
//     x multiple) (bt.won); the toasts say so.
//  4. A calls a second race and drives away: the race is called off and C's stake comes back.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8981, LOOKUP = 8982, BACKUP = 8983;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-bet-'));
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
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `bet-${name}.png`) }) : null;
  t.bt = () => t.page.evaluate(() => window.__game.game.todo.betting.info());
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
const onFoot = (t, x, z) => t.page.evaluate(([x, z]) => { const G = window.__game, g = G.game; G.teleport(x, z, 0); g.player.money = 1000; g.player.health = 100; return true; }, [x, z]);
const money = (t) => t.page.evaluate(() => window.__game.game.player.money);
const win = (t) => t.bt().then((b) => b.wins.find((w) => w.kind === 'race') ?? null);
const place = (t, key, stake) => t.page.evaluate(([key, stake]) => { const b = window.__game.game.todo.betting, w = [...b.wins.values()].find((x) => x.kind === 'race'); return w ? b.place(w.id, key, stake) : 'no window'; }, [key, stake]);
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const dt = await routeOf(A, 'Downtown Circuit');
  const B = await visitor('B', [960, 540]); await B.pin(true);
  const C = await visitor('C', [960, 540]); await C.pin(true);
  const D = await visitor('D'); await D.pin(true);
  n = await D.until((x) => x.status === 'online' && x.count === 4, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net(), D.net()]); return ns[0].traffic.mode === 'host' && ns.slice(1).every((x) => x.traffic.mode === 'guest') ? ns : null; }, 60000);
  check(!!n && !!roles, 'four in town: A the host, B, C and D its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];
  const h0 = Math.atan2(dt.first.x - dt.start.x, dt.first.z - dt.start.z);

  // ── 1. The window ──
  for (const t of [A, B, C, D]) await calm(t);
  await carAt(A, dt.start.x, dt.start.z, h0);
  await carAt(B, dt.start.x - 110, dt.start.z, Math.PI / 2);
  await onFoot(C, dt.start.x + 60, dt.start.z + 240);
  await onFoot(D, dt.start.x - 60, dt.start.z + 260);
  await B.key('KeyK');
  await sleep(1500);
  await A.key('KeyG');
  const ac = await A.rwait((r) => r.phase === 'calling', 4000);
  check(!!ac, 'A called the Downtown Circuit', ac ? ac.phase : 'no');
  const wc = await wait(async () => { const w = await win(C); return w && w.state === 'open' ? w : null; }, 8000), wd = await wait(async () => { const w = await win(D); return w && w.state === 'open' ? w : null; }, 8000);
  check(!!wc && !!wd && /Downtown Circuit/.test(wc.title), 'C and D (spectators) have a betting window open', wc ? wc.title : 'none');
  const toast = await C.page.evaluate(() => (document.body.innerText.match(/Bets are open on[^\n]*/) || [''])[0]);
  check(/Bets are open on Downtown Circuit/.test(toast), 'C got the toast', toast);
  const tag = await C.page.evaluate(() => { const e = document.getElementById('bt-tag'); return e && e.classList.contains('on') ? e.textContent : ''; });
  check(/^Bets open · Downtown Circuit/.test(tag), 'and the BETS tag is on screen', tag);
  check(wc.entrants.length === 1, 'with only the caller in, there is one driver on the slip', String(wc.entrants.length));
  const lone = await place(C, wc.entrants[0].key, 50);
  check(lone !== '' && (await money(C)) === 1000, 'a bet with one driver is refused, nothing taken', lone);

  // B joins.
  await carAt(B, dt.start.x - Math.cos(h0) * 8, dt.start.z + Math.sin(h0) * 8, h0);
  const bj = await B.rwait((r) => r.phase === 'joined', 6000);
  const wc2 = await wait(async () => { const w = await win(C); return w && w.entrants.length === 2 ? w : null; }, 8000), wd2 = await wait(async () => { const w = await win(D); return w && w.entrants.length === 2 ? w : null; }, 8000);
  check(!!bj && !!wc2 && !!wd2, 'B joined: two drivers on both spectators slips', wc2 ? wc2.entrants.map((e) => e.name).join(', ') : 'no');
  const sameOdds = JSON.stringify(wc2.entrants.map((e) => [e.key, e.mult])) === JSON.stringify(wd2.entrants.map((e) => [e.key, e.mult]));
  check(sameOdds && wc2.entrants.every((e) => e.mult > 1 && e.mult < 2), 'the same odds on both screens, over x1 and under x2 for two drivers', JSON.stringify(wc2.entrants.map((e) => e.mult)));
  await B.shot('b');
  // A racer cannot bet.
  const bw = await B.page.evaluate(() => { const b = window.__game.game.todo.betting; const w = [...b.wins.values()].find((x) => x.kind === 'race'); return w ? { id: w.id, blocked: b.blocked(w), onA: b.place(w.id, 'p' + w.caller, 50), onB: b.place(w.id, 'p' + window.__game.game.todo.racing.link.me(), 50) } : null; });
  check(!!bw && bw.blocked !== '' && bw.onA !== '' && bw.onB !== '', 'B (in the race) cannot bet on A or on themself', bw ? `${bw.onA} | ${bw.onB}` : 'no window');
  check((await B.bt()).hold === 0 && (await money(B)) > 0, 'B has nothing held');
  const aw = await A.page.evaluate(() => { const b = window.__game.game.todo.betting; return { wins: b.info().wins.length, r: b.place('race:' + window.__game.game.todo.racing.link.me(), 'p1', 50) }; });
  check(aw.r !== '', 'A (the caller) has no slip on its own race', aw.r);

  // ── 2. The bets ──
  const kA = 'p' + ids[0], kB = 'p' + ids[1];
  check(wc2.entrants.some((e) => e.key === kA) && wc2.entrants.some((e) => e.key === kB), 'the drivers are A and B (by their ids)', wc2.entrants.map((e) => e.key).join(','));
  const lowC = await place(C, kB, 9), highC = await place(C, kB, 501);
  check(lowC !== '' && highC !== '' && (await money(C)) === 1000, 'stakes under $10 and over $500 are refused', `${lowC} | ${highC}`);
  const okC = await place(C, kB, 100), okD = await place(D, kA, 100);
  check(okC === '' && okD === '' && (await money(C)) === 900 && (await money(D)) === 900, 'C backs B ($100) and D backs A ($100): $100 each comes out at once', `${okC} ${okD}`);
  const multA = wd2.entrants.find((e) => e.key === kA).mult;
  await sleep(500);
  await C.page.keyboard.press('KeyZ', { delay: 60 }); await sleep(600);
  const slip = await C.page.evaluate(() => ({ on: document.querySelector('.bt-back').classList.contains('on'), text: document.querySelector('.bt-card').innerText.slice(0, 260) }));
  check(slip.on && /Your bet: \$100/.test(slip.text), 'C slip shows the bet', slip.text.replace(/\n/g, ' | ').slice(0, 160));
  await C.shot('slip');
  await C.page.keyboard.press('Escape', { delay: 60 });

  // Go: the window closes.
  await A.key('KeyG');
  const grids = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'grid', 5000)));
  check(grids.every(Boolean), 'A pressed G: the grid');
  const closed = await wait(async () => { const w = await win(C); return w && w.state === 'closed' ? w : null; }, 6000), closedD = await wait(async () => { const w = await win(D); return w && w.state === 'closed' ? w : null; }, 6000);
  check(!!closed && !!closedD, 'both windows closed at the start', closed ? closed.state : 'no');
  const late = await place(D, kB, 50);
  check(late !== '' && (await money(D)) === 900, 'a late bet is refused', late);

  // ── 3. The race and the pay ──
  await sleep(4300);
  await Promise.all([drive(A, 44, -2.5), drive(B, 39, 2.5)]);
  const go = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'race', 8000)));
  check(go.every(Boolean), 'GO');
  const ends = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'podium', 120000, 500)));
  check(ends.every(Boolean), 'the podium on both racers screens');
  const order = ends[0] ? ends[0].results.map((r) => r.id) : [];
  check(order[0] === ids[0] && order[1] === ids[1], 'A won, B second', order.join(','));
  const settledC = await wait(async () => { const w = await win(C); return w && w.state === 'settled' ? w : null; }, 20000), settledD = await wait(async () => { const w = await win(D); return w && w.state === 'settled' ? w : null; }, 20000);
  check(!!settledC && !!settledD, 'both spectators settled from the Done frames they saw', settledC ? settledC.result : 'no');
  const mC = await money(C), mD = await money(D), bC = await C.bt(), bD = await D.bt();
  const back = Math.floor(100 * multA);
  check(mC === 900 && bC.lost === 100 && bC.won === 0 && bC.hold === 0, 'C backed the loser: $100 gone, bt.lost 100', `money ${mC}, lost ${bC.lost}`);
  check(mD === 900 + back && bD.won === back - 100 && bD.lost === 0 && bD.hold === 0, `D backed the winner: paid $${back} (x${multA}), bt.won ${back - 100}`, `money ${mD}, won ${bD.won}`);
  const toastD = await D.page.evaluate(() => (document.body.innerText.match(/won! You backed them[^\n]*/) || [''])[0]);
  const toastC = await C.page.evaluate(() => (document.body.innerText.match(/won\. Your \$100[^\n]*/) || [''])[0]);
  check(/paid out/.test(toastD) && /did not come in/.test(toastC), 'toasts told each result', `${toastD.slice(0, 70)} // ${toastC.slice(0, 70)}`);
  await D.shot('paid');

  // ── 4. A race called off: the stake comes back ──
  await A.key('KeyG');
  await wait(async () => (await A.race()).phase === 'idle', 20000);
  await B.key('KeyG');
  await wait(async () => (await B.race()).phase === 'idle', 20000);
  await carAt(A, dt.start.x, dt.start.z, h0);
  await carAt(B, dt.start.x - 110, dt.start.z, Math.PI / 2);
  await sleep(1500);
  await A.key('KeyG');
  await A.rwait((r) => r.phase === 'calling', 4000);
  const w2 = await wait(async () => { const w = await win(C); return w && w.state === 'open' ? w : null; }, 8000);
  check(!!w2, 'a second race called: a new window for C');
  await carAt(B, dt.start.x - Math.cos(h0) * 8, dt.start.z + Math.sin(h0) * 8, h0);
  await B.rwait((r) => r.phase === 'joined', 6000);
  const w2b = await wait(async () => { const w = await win(C); return w && w.entrants.length === 2 ? w : null; }, 8000);
  const m0 = await money(C);
  const ok2 = w2b ? await place(C, 'p' + ids[0], 50) : 'no';
  check(ok2 === '' && (await money(C)) === m0 - 50, 'C bets $50 on A', ok2);
  await carAt(A, dt.start.x + 400, dt.start.z + 400, 0);
  const off = await wait(async () => { const w = await win(C); return w && w.state === 'void' ? w : null; }, 10000);
  const bC2 = await C.bt();
  check(!!off && (await money(C)) === m0 && bC2.hold === 0, 'A drove away: the race is called off and the $50 is back', off ? off.state : 'no');

  const errs = [A, B, C, D].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
  check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
