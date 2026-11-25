// Fun queue 2, item 23: co-op missions for 2 to 4 players. Headless browsers against LOCAL services.
//
//   node tools/net/coop.mjs [--noshots]
//
// Started and stopped as tools/net/pursuit.mjs is (never run two of these tests at once). A is the host and the caller;
// B and C are pinned hidden, so they say they cannot host (they still join and play). The jobs ride on PlayerEvent.Coop
// (24), an ordinary Event frame the service relays unread: nothing in server/ is touched.
//  0. A alone at the haul's lot: G gives the "needs two or more players" toast, no call.
//  1. TWO-TRUCK HAUL with 2 players (A, B; C is in town but stays away): the call reaches B and C (a toast, a C on the
//     radar), B joins, A starts; both are handed trucks; the trucks arrive; the SAME pay on both screens, in their purses.
//  2. The haul with 3 players: the gap rule (a truck strung out far from the rest makes the clock run fast), then all arrive.
//  3. THE DRIVE-UP JOB with 3 (A drives, B and C crack): the bar fills only with the driver close and a cracker on foot
//     at the vault; then the getaway to the hideout with the crackers close; pay for three.
//  4. LIGHT UP THE STAND with 2 and with 3: everybody is stood in the bowl, plates held together, three rounds, pay.
//  5. A cracker leaves mid-job: the job goes on with the rest; the last partner leaves: set aside, no pay.
//  6. The caller leaves mid-job: the other is let go, no pay.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8891, LOOKUP = 8892, BACKUP = 8893;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-coop-'));
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
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8892|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.co = () => t.page.evaluate(() => window.__game.game.todo.coop.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.cwait = async (fn, ms = 20000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.co(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.prompt = () => t.page.evaluate(() => window.__game.game.todo.coop.prompt);
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `coop-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; g.player.health = 100; if (p) p.clear(); });
/** On foot at (x, z), out of any car. */
const footAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); return true; }, [x, z, h]);
/** In a fresh sedan at (x, z), standing still. */
const carAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); const v = g.vehicles.spawn('sedan', x, z, h); g.player.enter(v, true); g.cam.snap(); return !!g.player.vehicle; }, [x, z, h]);
/** This player's car, stopped, at (x, z). */
const moveCar = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const v = window.__game.game.player.vehicle; if (!v) return false; v.x = x; v.z = z; v.h = h; v.vx = v.vy = v.vz = 0; return true; }, [x, z, h]);
const carOf = (t) => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: v.x, z: v.z, kind: v.spec.kind } : null; });
const blipsOf = (t) => t.page.evaluate(() => { const out = []; window.__game.game.todo.coop.blips(out); return out; });
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const geo = (await A.co()).geo;
  const site = (m) => geo[m - 1];
  check(geo.length === 3 && geo[0].dest && geo[1].safe && geo[1].hide, 'three jobs with their places worked out', JSON.stringify(geo.map((g) => g.start)));

  // ── 0. Solo ──
  {
    await calm(A);
    await carAt(A, site(1).start.x, site(1).start.z, 0);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /Two-Truck Haul.*needs 2\+ players/.test(pr), 'alone at the lot: the prompt says it needs 2+ players', pr);
    await A.key('KeyG');
    // (The stranger's first-minute notice may be on screen: the toast queues behind it.)
    const toast = await wait(async () => (await A.page.evaluate(() => (document.body.innerText.match(/needs two or more players[^\n]*/) || [''])[0])) || null, 14000) || '';
    check(!!toast && (await A.co()).phase === 'idle', 'alone: G gives the toast and no call', toast.slice(0, 60));
  }

  const B = await visitor('B', [960, 540]);
  await B.pin(true);
  const C = await visitor('C');
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net()]); return ns[0].traffic.mode === 'host' && ns[1].traffic.mode === 'guest' && ns[2].traffic.mode === 'guest' ? ns : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];
  const FAR = { x: -560, z: 380 };

  /** Everybody to a calm place, A at the lot of job m calls it, the named others walk up and join. Returns once the job runs on all. */
  async function begin(m, joiners, limit = 0) {
    for (const t of [A, B, C]) await calm(t);
    const s = site(m).start;
    await footAt(A, s.x, s.z + 3, 0);
    for (const t of [B, C]) await footAt(t, FAR.x + (t === B ? 0 : 30), FAR.z, 0);
    await sleep(1200);
    if (limit) await A.page.evaluate((l) => { window.__game.game.todo.coop.testLimit = l; }, limit);
    await A.key('KeyG');
    const ac = await A.cwait((r) => r.phase === 'calling', 4000);
    if (!ac) return null;
    for (const t of joiners) {
      const inv = await t.cwait((r) => r.invites.length === 1, 6000);
      if (!inv) return null;
      await footAt(t, s.x + 4 * (t === B ? 1 : -1), s.z + 3, 0);
    }
    const a3 = await A.cwait((r) => r.ids.length === 1 + joiners.length, 8000);
    if (!a3) return null;
    await A.key('KeyG');
    const all = [A, ...joiners];
    const go = await Promise.all(all.map((t) => t.cwait((r) => r.phase === 'run', 6000)));
    return go.every(Boolean) ? { all, go } : null;
  }
  async function closeCards(ts) { for (const t of ts) { await t.key('KeyG'); } await sleep(600); }

  // ── 1. The haul with two ──
  {
    for (const t of [A, B, C]) await calm(t);
    const s = site(1).start;
    await footAt(A, s.x, s.z + 3, 0); await footAt(B, FAR.x, FAR.z, 0); await footAt(C, FAR.x + 30, FAR.z, 0);
    await sleep(1200);
    const pr = await A.prompt();
    check(!!pr && /^\[G\] Call the co-op job "Two-Truck Haul"/.test(pr), 'with others in town: "[G] Call the co-op job"', pr);
    await A.key('KeyG');
    const binv = await B.cwait((r) => r.invites.length === 1, 6000), cinv = await C.cwait((r) => r.invites.length === 1, 6000);
    const toast = await B.page.evaluate(() => (document.body.innerText.match(/called a co-op job[^\n]*/) || [''])[0]);
    const pb = (await blipsOf(B)).filter((b) => b.label === 'C' && b.kind === 'goal').length;
    check(!!binv && !!cinv && /Two-Truck Haul/.test(toast) && pb === 1, 'B and C are invited: a toast and a C on the radar', `${toast.slice(0, 70)} / C blips ${pb}`);
    await footAt(B, s.x + 4, s.z + 3, 0);
    const bj = await B.cwait((r) => r.phase === 'joined', 6000), a2 = await A.cwait((r) => r.ids.length === 2, 6000);
    check(!!bj && !!a2, 'B walked up and joined; A sees two', a2 ? a2.ids.join(',') : 'no');
    await A.page.evaluate(() => { window.__game.game.todo.coop.testLimit = 0; });
    await A.key('KeyG');
    const go = await Promise.all([A, B].map((t) => t.cwait((r) => r.phase === 'run', 5000)));
    check(go.every((g) => g && g.mission === 1 && g.ids.length === 2 && g.ids[0] === ids[0]), 'A pressed G: the haul runs on both screens, A first', go.map((g) => g ? `${g.phase} ids ${g.ids}` : 'no').join(' | '));
    const cs = await Promise.all([A, B].map(carOf));
    check(cs.every(Boolean) && cs[0].kind === 'van' && cs[1].kind === 'pickup', 'each is handed a truck (a van, a pickup)', JSON.stringify(cs.map((c) => c && c.kind)));
    const cst = await C.co();
    check(cst.phase === 'idle', 'C, who stayed away, is not on it', cst.phase);
    await sleep(1500);
    await B.shot('haul-start');
    const d = site(1).dest;
    const m0 = [await A.money(), await B.money(), await C.money()];
    await moveCar(A, d.x, d.z, 0);
    await sleep(1800);
    const half = await B.cwait((r) => r.flags === 1 && r.prog >= 0.49 && r.prog <= 0.51, 6000);
    check(!!half && (await A.co()).phase === 'run', 'one truck there: the job waits (1 of 2 on both screens)', half ? `flags ${half.flags} prog ${half.prog}` : 'no');
    await moveCar(B, d.x + 6, d.z + 4, 0);
    const ends = await Promise.all([A, B].map((t) => t.cwait((r) => r.phase === 'card', 8000)));
    check(ends.every((e) => e && e.result.how === 1), 'both there: JOB DONE on both screens', ends.map((e) => e ? e.result.how : 'no').join(', '));
    const pays = ends.map((e) => e ? e.result.pay : -1);
    check(pays[0] === pays[1] && pays[0] >= 700 && pays[0] <= 1100, 'the same pay for both (base for two, a quick-job bonus)', JSON.stringify(pays));
    await sleep(500);
    const m1 = [await A.money(), await B.money(), await C.money()];
    check(m1[0] - m0[0] === pays[0] && m1[1] - m0[1] === pays[0] && m1[2] === m0[2], 'it went into both purses and not into C\'s', `${m0} -> ${m1}`);
    await B.shot('haul-card');
    await closeCards([A, B]);
    const idle = await Promise.all([A, B].map((t) => t.cwait((r) => r.phase === 'idle', 4000)));
    check(idle.every(Boolean), 'the card closes with G on both', '');
  }

  // ── 2. The haul with three, and the gap rule ──
  {
    const run = await begin(1, [B, C]);
    check(!!run && run.go.every((g) => g.ids.length === 3), 'three on the haul', run ? run.go.map((g) => g.ids.length).join(',') : 'no');
    const d = site(1).dest, s = site(1).start;
    await moveCar(A, s.x, s.z, 0);
    await moveCar(B, s.x - 40, s.z - 220, 0);
    await moveCar(C, s.x - 40, s.z - 230, 0);
    await sleep(2000);
    const l0 = (await A.co()).left;
    await sleep(3000);
    const ap = await A.co();
    check(ap.apart === true && l0 - ap.left >= 5, 'strung out over the gap limit: the clock runs fast', `apart ${ap.apart}, ${l0 - ap.left} s in 3 s`);
    const bt = await B.page.evaluate(() => (document.body.innerText.match(/STAY TOGETHER[^\n]*/) || [''])[0]);
    check(/STAY TOGETHER/.test(bt), 'B is told to stay together', bt.slice(0, 50));
    await moveCar(A, d.x, d.z, 0); await moveCar(B, d.x + 5, d.z + 5, 0);
    await sleep(1500);
    const mid = await A.co();
    check(mid.phase === 'run' && mid.arrived.length === 2, 'two of three there: still running', `${mid.phase} ${mid.arrived.length}`);
    await moveCar(C, d.x - 5, d.z - 5, 0);
    const ends = await Promise.all([A, B, C].map((t) => t.cwait((r) => r.phase === 'card', 8000)));
    const pays = ends.map((e) => e ? e.result.pay : -1);
    check(ends.every((e) => e && e.result.how === 1) && pays.every((p) => p === pays[0]) && pays[0] >= 875, 'all three there: the same pay on three screens, more than for two', JSON.stringify(pays));
    await closeCards([A, B, C]);
    await sleep(800);
  }

  // ── 3. The Drive-Up Job with three ──
  {
    const run = await begin(2, [B, C]);
    check(!!run && run.go.every((g) => g.mission === 2 && g.ids.length === 3), 'the drive-up job runs with three', run ? run.go.map((g) => g.ids.length).join(',') : 'no');
    const cs = await Promise.all([A, B, C].map(carOf));
    check(cs[0] && cs[0].kind === 'muscle' && cs[1] && cs[1].kind === 'sedan', 'the driver has the getaway car, the crackers sedans', JSON.stringify(cs.map((c) => c && c.kind)));
    const g2 = site(2);
    // Crackers on foot at the vault but the driver is far: no progress.
    await footAt(B, g2.safe.x, g2.safe.z, 0); await footAt(C, g2.safe.x + 2, g2.safe.z + 1, 0);
    await sleep(2500);
    const noDriver = await A.co();
    check(noDriver.stage === 1 && noDriver.prog < 0.02, 'crackers there but the driver is not close: the vault stays shut', `prog ${noDriver.prog}`);
    await moveCar(A, g2.safe.x - 20, g2.safe.z + 4, 0);
    await sleep(4000);
    const some = await B.cwait((r) => r.stage === 1 && r.prog > 0.1, 8000);
    check(!!some, 'the driver parks close: the bar fills on the crackers\' screens too', some ? `prog ${some.prog}` : 'no');
    await B.shot('vault');
    const open2 = await Promise.all([A, B, C].map((t) => t.cwait((r) => r.stage === 2, 24000)));
    check(open2.every(Boolean), 'the vault opens: the getaway on all three screens', open2.map((r) => r ? r.stage : 'no').join(','));
    // Getaway: driver to the hideout, crackers far: not yet.
    await moveCar(A, g2.hide.x, g2.hide.z, 0);
    await sleep(2500);
    const wait2 = await A.co();
    check(wait2.phase === 'run', 'the driver is at the hideout without the crackers: not yet', wait2.phase);
    await footAt(B, g2.hide.x + 4, g2.hide.z, 0); await footAt(C, g2.hide.x - 4, g2.hide.z + 3, 0);
    const ends = await Promise.all([A, B, C].map((t) => t.cwait((r) => r.phase === 'card', 8000)));
    const pays = ends.map((e) => e ? e.result.pay : -1);
    check(ends.every((e) => e && e.result.how === 1) && pays.every((p) => p === pays[0]) && pays[0] >= 1375, 'crackers close: JOB DONE, the same pay for three', JSON.stringify(pays));
    const roles2 = ends[1] ? ends[1].result.rows.map((r) => r.role).join(',') : '';
    check(roles2 === 'DRIVER,CRACKER,CRACKER', 'the card lists the roles', roles2);
    await closeCards([A, B, C]);
    await sleep(800);
  }

  // ── 4. Light Up the Stand: two, then three ──
  for (const crew of [2, 3]) {
    const joiners = crew === 2 ? [B] : [B, C];
    const run = await begin(3, joiners);
    check(!!run && run.go.every((g) => g.mission === 3 && g.ids.length === crew), `the floodlights job runs with ${crew}`, run ? run.go.map((g) => g.ids.length).join(',') : 'no');
    const ps = await Promise.all(run.all.map((t) => t.page.evaluate(() => { const p = window.__game.game.player; return { x: p.x, z: p.z }; })));
    check(ps.every((p) => Math.hypot(p.x + 421, p.z + 70) < 20), 'everybody is stood in the derby bowl', JSON.stringify(ps.map((p) => [Math.round(p.x), Math.round(p.z)])));
    let last = '';
    let okRounds = 0;
    for (let round = 1; round <= 3; round++) {
      const a = await A.co();
      const stuck = await A.cwait((r) => r.stage === round, 30000);
      if (!stuck) break;
      const pl = stuck.plates;
      if (pl.length !== crew) break;
      // One missing: no progress.
      if (round === 1) {
        for (let k = 0; k < crew - 1; k++) await footAt(run.all[k], pl[k].x, pl[k].z, 0);
        await sleep(2500);
        const part = await A.co();
        check(part.prog < 0.02 && part.stage === 1, 'one plate empty: the lights stay dark', `prog ${part.prog}`);
      }
      for (let k = 0; k < crew; k++) await footAt(run.all[k], pl[k].x, pl[k].z, 0);
      if (round === 1) { await sleep(3000); await run.all[crew - 1].shot('plates'); }
      const nextStage = await A.cwait((r) => r.stage > round || r.phase === 'card', 20000);
      if (nextStage) okRounds++;
      last = JSON.stringify(pl.map((p) => [Math.round(p.x), Math.round(p.z)]));
    }
    const ends = await Promise.all(run.all.map((t) => t.cwait((r) => r.phase === 'card', 20000)));
    const pays = ends.map((e) => e ? e.result.pay : -1);
    check(okRounds === 3 && ends.every((e) => e && e.result.how === 1) && pays.every((p) => p === pays[0] && p > 0), `three rounds held: JOB DONE for ${crew}, the same pay`, `rounds ${okRounds} pays ${JSON.stringify(pays)}`);
    await closeCards(run.all);
    await sleep(800);
    const out = await Promise.all(run.all.map((t) => t.page.evaluate(() => { const p = window.__game.game.player; return Math.hypot(p.x + 421, p.z + 70); })));
    check(out.every((d) => d > 40), 'afterwards everybody is back out at the gate', out.map((d) => Math.round(d)).join(','));
  }

  // ── 5. A cracker leaves, then the last partner leaves ──
  {
    const run = await begin(1, [B, C], 400);
    check(!!run, 'a three-player haul for the leaving test', '');
    await C.page.close();
    open.splice(open.indexOf(C), 1);
    const a2 = await A.cwait((r) => r.ids.length === 2 && r.phase === 'run', 8000);
    const b2 = await B.cwait((r) => r.ids.length === 2 && r.phase === 'run', 8000);
    check(!!a2 && !!b2, 'C left: the haul goes on with two, on both screens', a2 ? `${a2.ids.length}/${b2 ? b2.ids.length : '-'}` : 'no');
    const l0 = (await A.money());
    await B.page.close();
    open.splice(open.indexOf(B), 1);
    const end = await A.cwait((r) => r.phase === 'card', 8000);
    check(!!end && end.result.how === 3 && end.result.pay === 0 && (await A.money()) === l0, 'the last partner left: set aside, no pay', end ? `${end.result.how} ${end.result.why}` : 'no');
    await closeCards([A]);
    await sleep(600);
  }

  // ── 6. The caller leaves ──
  {
    const D = await visitor('D', [960, 540]); await D.pin(true);
    const E = await visitor('E'); await E.pin(true);
    await wait(async () => { const x = await Promise.all([A.net(), D.net(), E.net()]); return x.every((r) => r.status === 'online' && r.count === 3) ? x : null; }, 60000);
    await calm(A);
    // D calls the lights job (D is a guest, hidden): A and E join.
    const s = site(3).start;
    await footAt(D, s.x, s.z + 3, 0);
    await footAt(A, FAR.x, FAR.z, 0); await footAt(E, FAR.x + 30, FAR.z, 0);
    await sleep(1500);
    await D.key('KeyG');
    const dc = await D.cwait((r) => r.phase === 'calling', 4000);
    check(!!dc, 'a guest (D) can be the caller', dc ? dc.phase : 'no');
    for (const t of [A, E]) { await t.cwait((r) => r.invites.length === 1, 6000); await footAt(t, s.x + (t === A ? 4 : -4), s.z + 3, 0); }
    await D.cwait((r) => r.ids.length === 3, 8000);
    await D.key('KeyG');
    const go = await Promise.all([D, A, E].map((t) => t.cwait((r) => r.phase === 'run', 6000)));
    check(go.every(Boolean), 'the job runs under the guest\'s call', go.map((g) => g ? g.phase : 'no').join(','));
    const m0 = await A.money();
    await D.page.close();
    open.splice(open.indexOf(D), 1);
    const ends = await Promise.all([A, E].map((t) => t.cwait((r) => r.phase === 'card', 8000)));
    check(ends.every((e) => e && e.result.how === 3 && e.result.pay === 0) && (await A.money()) === m0, 'the caller left: the others are let go, no pay', ends.map((e) => e ? e.result.how : 'no').join(','));
    await closeCards([A, E]);
    const errs = [A, E].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on the pages that stayed', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
