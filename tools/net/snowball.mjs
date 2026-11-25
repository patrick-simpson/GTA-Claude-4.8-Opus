// Fun queue 2, item 27: team snowball fights, three players. Headless browsers against LOCAL services.
//
//   node tools/net/snowball.mjs [--noshots]
//
// Started and stopped as tools/net/convoy.mjs is (never run two of these tests at once). A is the host and the referee;
// B and C are pinned hidden (guests). The fight rides on PlayerEvent.Snow (27), an ordinary Event frame the service relays
// unread: nothing in server/ is touched. Snow is forced on with ?snow=1.
//  1. A starts a round at Mercy Park; B and C hear of it (a toast, the roster).
//  2. B and C join: teams balanced (A red, B blue, C red), the townsfolk fill each side to three (red 1, blue 2), the same
//     roster and the same clock on all three screens.
//  3. B throws at A: the throw is seen on the other screens, the host judges the hit, the same score is on all three, A is
//     splatted (and loses no health), the throw's ball is gone everywhere.
//  4. The billboard on every screen shows the same score as the roster.
//  5. C walks off the field: dropped from the roster on A and B, a townsperson fills in for red (B keeps blue to two).
//  6. The host leaves town: B (still in) has the round called off, is free, is not paid.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8901, LOOKUP = 8902, BACKUP = 8903;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-snow-'));
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
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8902|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&snow=1&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.sn = () => t.page.evaluate(() => window.__game.game.todo.snow.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.swait = async (fn, ms = 12000, every = 150) => { const end = Date.now() + ms; for (;;) { const n = await t.sn(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.hp = () => t.page.evaluate(() => window.__game.game.player.health);
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.splats = () => t.page.evaluate(() => window.__splats || 0);
  t.toast = (re, ms = 6000) => wait(async () => (await t.page.evaluate((s) => (document.body.innerText.match(new RegExp(s)) || [''])[0], re.source)) || null, ms);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `snowball-${name}.png`) }) : null;
  await t.page.evaluate(() => {
    window.__game.start();
    const G = window.__game.game; window.__splats = 0;
    const wrap = () => { const tag = G.todo.snowTag; if (!tag) return setTimeout(wrap, 200); const sp = tag.splat.bind(tag); tag.splat = () => { window.__splats++; return sp(); }; };
    wrap();
  });
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; g.player.health = 100; if (p) p.clear(); });
const footAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); g.cam.yaw = h; g.cam.pitch = -0.02; g.cam.snap(); return true; }, [x, z, h]);
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', [960, 540]); await B.pin(true);
  const C = await visitor('C'); await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net()]); return ns.every((r) => r.status === 'online' && r.count === 3) ? ns : null; }, 60000);
  check(!!n && !!roles, 'three in town', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];
  for (const t of [A, B, C]) await calm(t);
  const site = (await A.sn()).sites[0];
  const FX = site.x, FZ = site.z;
  check(site.name === 'Mercy Park', 'the field is at Mercy Park', JSON.stringify(site));
  await footAt(A, FX - 10, FZ, Math.PI / 2);
  await footAt(B, FX + 20, FZ + 40, 0);   // beside the field, not on it yet
  await footAt(C, FX + 20, FZ - 40, 0);
  await sleep(1500);

  // ── 1. A starts ──
  await A.key('KeyG');
  const a1 = await A.swait((r) => r.mine === ids[0] && r.phase >= 1);
  check(!!a1 && a1.team === 1 && a1.hosting && a1.botsR === 2 && a1.botsB === 3, 'A starts a round alone: red, with 2 + 3 townsfolk', a1 ? JSON.stringify([a1.team, a1.botsR, a1.botsB]) : 'no');
  const hb = await B.swait((r) => r.known.length === 1), hc = await C.swait((r) => r.known.length === 1);
  check(!!hb && !!hc && hb.known[0].host === ids[0] && hb.known[0].site === 0, 'B and C hear of it (the roster names A and the field)', JSON.stringify(hb && hb.known));
  check(!!(await B.toast(/started a snowball fight at Mercy Park/, 4000)), 'B gets a toast');

  // ── 2. B and C join ──
  await footAt(B, FX + 8, FZ + 4, -Math.PI / 2);
  await sleep(500);
  await B.key('KeyG');
  const b2 = await B.swait((r) => r.mine === ids[0], 8000);
  check(!!b2 && b2.team === 2, 'B walks on and presses G: joined, blue (the sides are balanced)', b2 ? String(b2.team) : 'no');
  await footAt(C, FX - 12, FZ - 4, Math.PI / 2);
  await sleep(500);
  await C.key('KeyG');
  const c2 = await C.swait((r) => r.mine === ids[0], 8000);
  check(!!c2 && c2.team === 1, 'C joins: red (red 1, blue 1 before)', c2 ? String(c2.team) : 'no');
  const sync = await wait(async () => { const rs = await Promise.all([A, B, C].map((t) => t.sn())); return rs.every((r) => r.ids.length === 3 && r.botsR === 1 && r.botsB === 2) ? rs : null; }, 8000);
  check(!!sync, 'the same roster on all three: A, C red, B blue, townsfolk 1 red + 2 blue', sync ? JSON.stringify(sync.map((r) => [r.botsR, r.botsB])) : JSON.stringify(await Promise.all([A, B, C].map((t) => t.sn().then((r) => [r.ids.length, r.botsR, r.botsB])))));
  check(!!sync && JSON.stringify(sync[0].ids.map((x) => x.id + ':' + x.team)) === JSON.stringify(sync[1].ids.map((x) => x.id + ':' + x.team)) && JSON.stringify(sync[1].ids) === JSON.stringify(sync[2].ids), 'the rosters are identical (ids and teams)', sync ? JSON.stringify(sync[0].ids) : '');
  const live = await wait(async () => { const rs = await Promise.all([A, B, C].map((t) => t.sn())); return rs.every((r) => r.phase === 2) ? rs : null; }, 10000);
  check(!!live && Math.abs(live[0].left - live[1].left) < 3 && Math.abs(live[0].left - live[2].left) < 3, 'the count is over and the clocks agree (within 3 s)', live ? live.map((r) => r.left).join(', ') : 'not running');
  const bots = await Promise.all([A, B, C].map((t) => t.sn().then((r) => r.bots.length)));
  check(bots.every((x) => x === 3) || bots[0] === 3, 'the host runs 3 townsfolk; the others see them too', bots.join(', '));
  await sleep(800);
  const seen = await Promise.all([B, C].map((t) => t.sn().then((r) => r.bots.length)));
  check(seen.every((x) => x === 3), 'B and C draw all three townsfolk', seen.join(', '));

  // ── 3. B throws at A ──
  {
    await A.page.evaluate(() => { window.__game.game.player.health = 100; });
    const a0 = await A.sn(), sp0 = await A.splats(), hp0 = await A.hp();
    let r = a0, hit = false, thrown = 0, sawBall = false;
    for (let k = 0; k < 14 && !hit; k++) {
      const pa = await A.page.evaluate(() => { const p = window.__game.game.player; return { x: p.x, z: p.z }; });
      // B stands 8 m east of A, looking west; A is held still.
      await footAt(B, pa.x + 8, pa.z, -Math.PI / 2);
      await footAt(A, pa.x, pa.z, Math.PI / 2);
      await sleep(450);
      const ammo = (await B.sn()).ammo;
      if (!ammo) { await B.key('KeyR'); await sleep(1300); }
      await B.key('KeyG'); thrown++;
      for (let i = 0; i < 6 && !sawBall; i++) { const c = await C.sn(); const a = await A.sn(); if (c.balls > 0 && a.balls > 0) sawBall = true; else await sleep(60); }
      await sleep(1000);
      r = await A.sn();
      hit = r.blue > a0.blue || (await A.splats()) > sp0;
    }
    check(thrown >= 1 && sawBall, 'the throw is seen on the other screens (a ball in flight on A and C)', `${thrown} throws`);
    const same = await wait(async () => { const rs = await Promise.all([A, B, C].map((t) => t.sn())); return rs.every((x) => x.red === rs[0].red && x.blue === rs[0].blue) && (rs[0].red + rs[0].blue) > a0.red + a0.blue ? rs : null; }, 8000);
    check(!!same, 'a hit was judged and the same score is on all three screens', same ? same.map((x) => x.red + '-' + x.blue).join(' ') : JSON.stringify(await Promise.all([A, B, C].map((t) => t.sn().then((x) => x.red + '-' + x.blue)))));
    check((await A.splats()) > sp0, 'A was splatted (the screen flash)', String((await A.splats()) - sp0));
    check((await A.hp()) === 100 && hp0 === 100, 'no health lost', String(await A.hp()));
    await sleep(800);
    const balls = await Promise.all([A, B, C].map((t) => t.sn().then((x) => x.balls)));
    check(balls.every((x) => x === 0 || x <= 4), 'balls are not left flying (the townsfolk throw some)', balls.join(', '));
    if (SHOTS) { await A.shot('A'); await B.shot('B'); }
  }

  // ── 4. The billboard ──
  {
    const rs = await wait(async () => {
      const x = await Promise.all([A, B, C].map((t) => t.sn()));
      const keys = x.map((r) => (r.boards[0] ? r.boards[0].key : ''));
      const ok = x.every((r, i) => keys[i].startsWith(`1|${r.red}|${r.blue}|`));
      return ok ? { x, keys } : null;
    }, 8000);
    check(!!rs, 'the billboard on every screen shows the roster\'s score', rs ? rs.keys.join(' || ') : JSON.stringify(await Promise.all([A, B, C].map((t) => t.sn().then((r) => [r.red, r.blue, r.boards[0] && r.boards[0].key])))));
    check(!!rs && rs.x.every((r) => r.red === rs.x[0].red && r.blue === rs.x[0].blue), 'and it is the same score everywhere', rs ? rs.x.map((r) => `${r.red}-${r.blue}`).join(' ') : '');
  }

  // ── 5. C leaves the field ──
  {
    await footAt(C, FX + 80, FZ, 0);
    const a5 = await A.swait((r) => r.ids.length === 2 && r.botsR === 2 && r.botsB === 2, 8000);
    check(!!a5, 'C walks off: gone from the roster, a townsperson fills red again (2 red + 2 blue, B is blue)', a5 ? JSON.stringify([a5.ids.length, a5.botsR, a5.botsB]) : JSON.stringify(await A.sn().then((r) => [r.ids.length, r.botsR, r.botsB])));
    const b5 = await B.swait((r) => r.ids.length === 2, 6000);
    check(!!b5, 'B sees the same', b5 ? String(b5.ids.length) : 'no');
    const c5 = await C.sn();
    check(c5.mine === 0 && (await C.page.evaluate(() => window.__game.game.todo.busy)) === null, 'C is out and free', String(c5.mine));
  }

  // ── 6. The host leaves ──
  {
    const m0 = await B.money();
    await A.page.close(); open.splice(open.indexOf(A), 1);
    const b6 = await B.swait((r) => r.mine === 0, 15000);
    check(!!b6, 'the host leaves town: the round is called off for B, B is free', b6 ? 'out' : 'still in');
    check(!!(await B.toast(/called off/, 5000)), 'B is told it is called off');
    check((await B.money()) === m0, 'no prize for a called-off round');
    const busy = await B.page.evaluate(() => window.__game.game.todo.busy);
    check(busy === null, 'B is not busy', String(busy));
    const errs = [B, C].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
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
