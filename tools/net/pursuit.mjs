// Fun queue item 12: Hot Pursuit, a police chase between players. Headless browsers against LOCAL services.
//
//   node tools/net/pursuit.mjs [--noshots]
//
// Started and stopped as tools/net/race.mjs is (the same ports: never run two of these tests at once). A is the host;
// B and C are pinned hidden, so they say they cannot host.
//  0. A alone at Harbor Patrol Station No. 1: G gives the "needs two or more players" toast, no round.
//  1. B and C arrive. A calls Hot Pursuit: B and C get the invitation (a toast and a P on the radar), drive to the
//     station and join; A presses G again: A is the cop in a cruiser, held for the (shortened) head start; B and C GO.
//  2. A turns the siren on with Q: B and C see it (and the C on their radar); A's radar has two fuzzy circles.
//  3. The chase: B stops beside the cop and is BUSTED after 3 s (the bar fills on B's and A's screens); C stays away.
//  4. The clock runs out: the same podium on all three (A 1 bust, B busted, C escaped), cash, and the town records
//     (most busts, longest escape) written by the host, held by C and shown at the station.
// Pictures (unless --noshots) in shots/pursuit-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-pursuit-'));
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
  t.hp = () => t.page.evaluate(() => window.__game.game.todo.pursuit.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.hwait = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.hp(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.prompt = () => t.page.evaluate(() => window.__game.game.todo.pursuit.prompt);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `pursuit-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
/** In a fresh car at (x, z), facing h, standing still. */
const carAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; G.teleport(x, z, h); const v = g.vehicles.spawn('sedan', x, z, h); g.player.enter(v, true); g.cam.snap(); return !!g.player.vehicle; }, [x, z, h]);
/** This player's car, stopped, at (x, z). */
const moveCar = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const v = window.__game.game.player.vehicle; if (!v) return false; v.x = x; v.z = z; v.h = h; v.vx = v.vy = v.vz = 0; return true; }, [x, z, h]);
const carOf = (t) => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: v.x, z: v.z, h: v.h, kind: v.spec.kind } : null; });
const blipsOf = (t) => t.page.evaluate(() => { const out = []; window.__game.game.todo.pursuit.blips(out); return out; });
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const st = (await A.hp()).stations;
  check(st.length === 2 && st[1].z < -900, 'two stations: the island and the mainland', JSON.stringify(st));
  const S = st[0];

  // ── 0. Solo ──
  {
    await calm(A);
    await carAt(A, S.x, S.z + 3, 0);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /Hot Pursuit \(needs 2\+ players\)/.test(pr), 'alone at the station: the prompt says it needs 2+ players', pr);
    await A.key('KeyG');
    await sleep(600);
    const toast = await A.page.evaluate(() => (document.body.innerText.match(/needs two or more players[^\n]*/) || [''])[0]);
    const ph = (await A.hp()).phase;
    check(!!toast && ph === 'idle', 'alone: G gives the toast and no round', `${ph} / ${toast.slice(0, 60)}`);
  }

  const B = await visitor('B', [960, 540]);
  await B.pin(true);
  const C = await visitor('C');
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net()]); return ns[0].traffic.mode === 'host' && ns[1].traffic.mode === 'guest' && ns[2].traffic.mode === 'guest' ? ns : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];

  // ── 1. The call ──
  {
    for (const t of [A, B, C]) await calm(t);
    await carAt(B, S.x - 150, S.z + 3, Math.PI / 2);
    await carAt(C, S.x + 150, S.z + 3, -Math.PI / 2);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /^\[G\] Call Hot Pursuit/.test(pr), 'with others in town: "[G] Call Hot Pursuit"', pr);
    await A.page.evaluate(() => { const P = window.__game.game.todo.pursuit; P.testHead = 5; P.testRound = 28; });
    await A.key('KeyG');
    const ac = await A.hwait((r) => r.phase === 'calling', 4000);
    check(!!ac, 'A is calling', ac ? ac.phase : 'no');
    const binv = await B.hwait((r) => r.invites.length === 1, 6000), cinv = await C.hwait((r) => r.invites.length === 1, 6000);
    const toast = await B.page.evaluate(() => (document.body.innerText.match(/called Hot Pursuit[^\n]*/) || [''])[0]);
    const pb = (await blipsOf(B)).filter((b) => b.label === 'P' && b.kind === 'goal').length;
    check(!!binv && !!cinv && /Harbor Patrol/.test(toast) && pb === 1, 'B and C are invited: a toast and a P on the radar', `${toast.slice(0, 80)} / P blips ${pb}`);
    await moveCar(B, S.x - 8, S.z + 3, Math.PI / 2);
    await moveCar(C, S.x + 8, S.z + 3, -Math.PI / 2);
    const bj = await B.hwait((r) => r.phase === 'joined', 6000), cj = await C.hwait((r) => r.phase === 'joined', 6000);
    const a3 = await A.hwait((r) => r.players.length === 3, 6000);
    check(!!bj && !!cj && !!a3, 'B and C drove to the station and joined; A sees three players', a3 ? a3.players.map((r) => r.name).join(', ') : 'no');
    await A.key('KeyG');
    const go = await Promise.all([A, B, C].map((t) => t.hwait((r) => r.phase === 'head', 5000)));
    check(go.every((g) => g && g.cop === ids[0]), 'A pressed G: the round on all three screens, A the cop', go.map((g) => g ? `${g.phase} cop ${g.cop}` : 'no').join(', '));
    const a = await A.hp(), car0 = await carOf(A);
    check(a.cruiser && !!car0 && car0.kind === 'cruiser', 'the cop is in a cruiser', JSON.stringify(car0));
    await A.page.keyboard.down('KeyW'); await sleep(1200); await A.page.keyboard.up('KeyW');
    const car1 = await carOf(A);
    const moved = car1 && car0 ? Math.hypot(car1.x - car0.x, car1.z - car0.z) : 99;
    check(moved < 0.5, 'the cop waits out the head start (held at the station)', `moved ${moved.toFixed(2)} m`);
    // C makes its getaway.
    await moveCar(C, S.x + 420, S.z + 3, Math.PI / 2);
  }

  // ── 2. The siren ──
  {
    await A.key('KeyQ');
    const sb = await B.hwait((r) => r.siren, 4000), sc = await C.hwait((r) => r.siren, 4000);
    check((await A.hp()).siren && !!sb && !!sc, 'Q turns the siren on, and B and C hear it', `${!!sb} ${!!sc}`);
    await sleep(700);
    const cb = (await blipsOf(B)).filter((b) => b.label === 'C').length;
    const ca = (await blipsOf(A)).filter((b) => b.r > 0).map((b) => b.r);
    check(cb === 1 && ca.length === 2, 'B sees the cop on the radar; the cop sees two fuzzy circles', `B C-blips ${cb}, A circles ${JSON.stringify(ca)}`);
    check(ca.length === 2 && Math.min(...ca) < Math.max(...ca), 'the nearer wanted player has the smaller circle', JSON.stringify(ca));
    await A.shot('siren');
    const lit = await A.page.evaluate(async () => {
      const g = window.__game.game, v = g.player.vehicle;
      let big = 0, near = 0;
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 50));
        g.scene.traverse((o) => { if (o.isSprite && o.visible && Math.hypot(o.position.x - v.x, o.position.z - v.z) < 2 && o.position.y > v.y + 1) { near++; if (o.scale.x > 1) big++; } });
      }
      return { big, near };
    });
    check(lit.near > 0 && lit.big > 0, 'the light bar flashes on the cop\'s own cruiser', JSON.stringify(lit));
  }

  // ── 3. The chase: B is busted ──
  {
    const rel = await A.hwait((r) => r.phase === 'chase', 8000);
    check(!!rel, 'the head start is over: the chase is on', rel ? rel.phase : 'no');
    await A.page.evaluate(() => { window.__game.game.player.heat = 3; });
    await sleep(400);
    const heat = await A.page.evaluate(() => window.__game.game.player.heat);
    check(heat === 0, 'the Harbor Patrol stays out of it (a player in the round keeps no heat)', `heat ${heat}`);
    const ac = await carOf(A);
    await moveCar(B, ac.x + Math.cos(ac.h) * 4.5, ac.z - Math.sin(ac.h) * 4.5, ac.h);
    const mid = await A.hwait((r) => r.players.some((p) => p.id === ids[1] && p.hold > 0.2 && !p.busted), 4000, 150);
    check(!!mid, 'the BUSTED bar fills on the cop\'s screen too', mid ? JSON.stringify(mid.players.find((p) => p.id === ids[1])) : 'no');
    await A.shot('busting');
    const bb = await Promise.all([A, B, C].map((t) => t.hwait((r) => r.players.some((p) => p.id === ids[1] && p.busted), 8000)));
    check(bb.every(Boolean), 'B is BUSTED on all three screens', bb.map((x) => x ? 'yes' : 'no').join(', '));
    await sleep(300);
    await B.shot('busted');
    const cfree = (await C.hp()).players.find((p) => p.id === ids[2]);
    check(!!cfree && !cfree.busted, 'C is still free', JSON.stringify(cfree));
  }

  // ── 4. The end ──
  {
    const ends = await Promise.all([A, B, C].map((t) => t.hwait((r) => r.phase === 'podium', 60000, 500)));
    check(ends.every(Boolean), 'the podium on all three screens', ends.map((e) => e ? e.phase : 'no').join(', '));
    const res = ends.map((e) => e ? e.results.map((r) => `${r.id}:${r.cop ? 'cop ' : ''}${r.how}`).join(' ') : '');
    console.log('      results: ' + res.join('  //  '));
    check(!!res[0] && res.every((r) => r === res[0]), 'the same results on all three screens', res[0]);
    const r0 = ends[0] ? ends[0].results : [];
    const ra = r0.find((r) => r.id === ids[0]), rb = r0.find((r) => r.id === ids[1]), rc = r0.find((r) => r.id === ids[2]);
    check(!!ra && ra.cop && ra.busts === 1 && !!rb && /busted/.test(rb.how) && !!rc && rc.how === 'ESCAPED', 'A the cop with 1 bust, B busted, C escaped', JSON.stringify(r0));
    const paid = ends.map((e, i) => e ? (e.results.find((r) => r.id === ids[i]) || {}).cash : -1);
    const notes = ends.map((e) => e ? e.notes.join(' | ') : '');
    check(notes[0].includes('1 bust in a round') && notes[0].includes('0:28 on the run') && notes.every((x) => x === notes[0]), 'the same new-record notes on every podium', notes[0]);
    check(paid[0] > 0 && paid[2] > 0 && paid[2] > paid[1], 'cash: the cop for the bust, C for escaping (more than B)', JSON.stringify(paid));
    await sleep(500);
    await C.shot('podium');
    const rec = await wait(async () => { const x = (await C.net()).pursuit.record; return x && x.busts === 1 && x.escape === 28 ? x : null; }, 8000);
    check(!!rec, 'the host wrote the town records (1 bust, 0:28 on the run) and C has them', JSON.stringify(rec));
    await A.key('KeyG');
    await calm(A);
    await carAt(A, S.x, S.z + 3, 0);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /records: 1 bust by .+, 0:28 on the run by /.test(pr), 'the records are shown at the station', pr);
    const errs = [A, B, C].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
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
