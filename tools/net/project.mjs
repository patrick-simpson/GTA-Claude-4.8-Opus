// Fun queue 2, item 28: the town project (the Millpond Promenade). Headless browsers against LOCAL services only.
//
//   node tools/net/project.mjs [--noshots]
//
// Started and stopped as tools/net/snowball.mjs is (never run two of these tests at once). A is the host and starts with the
// whole of Tepid Falls open (?bridge=8&stage=4: the project's goals come after its four stages); B is pinned hidden (a guest).
// The project is stages 5, 6 and 7 of the same ledger and the same fact (FACT_BRIDGE): no new key, no new frame, the service
// untouched.
//  1. A and B in town; both show the town at stage 4 and the project not begun (fence up, the goal in hand 1500 points).
//  2. Points: A earns 700, B (a guest) 500: B's go to the host in a Give frame; both screens show the same bank.
//  3. Cash: B walks up to the project board, G, pays what is needed: stage 5 opens for both (the same stage on both pages,
//     the fence down and the promenade standing on both, B's pocket lighter by exactly that).
//  4. C joins later (own progress nothing): shows stage 5 on arrival, the promenade up, no fence; walking in pays the
//     ribbon purse once ($150), not twice.
//  5. B's wire: it writes no fact (only the host can); its points went as Give frames.
//  6. A finishes the rest: stages 6 and 7 for everybody; every tier up, no goal left.
//  7. The service is stopped and started again on the same state directory: D, a fourth player who joins fresh, is shown stage 7
//     (the fact was stored).
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8911, LOOKUP = 8912, BACKUP = 8913;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-proj-'));
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
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8912|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag, extra = '', size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${extra}${extra ? '&' : ''}${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.sent = { text: [], bin: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string') { t.sent.text.push(p.slice(0, 120)); return; }
    if (!p || p.length === 0) return;
    const k = p[0] >= 2 && p[0] <= 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.sent.bin[k] = (t.sent.bin[k] ?? 0) + 1;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.town = () => t.page.evaluate(() => window.__game.net().town);
  t.pj = () => t.page.evaluate(() => window.__game.game.todo.project.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.add = (n) => t.page.evaluate(async (n) => { const { progress } = await import('/src/world/progress.ts'); progress.add(n); }, n);
  t.foot = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); g.cam.yaw = h; }, [x, z, h]);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `project-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; g.player.health = 100; if (p) p.clear(); });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const view = (t, ...a) => t.page.evaluate((a) => { window.__game.game.todo.save.data.best['pj.ribbon'] = 7; window.__game.view(...a); }, a);

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];

  // ── 1. A and B ──
  const A = await visitor('A', 'bridge=8&stage=4', size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', '', size); await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2, 60000);
  const roles = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.traffic.mode === 'host' && b.traffic.mode === 'guest' ? [a, b] : null; }, 60000);
  check(!!n && !!roles, 'A (host) and B (guest) in town', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  for (const t of [A, B]) await calm(t);
  const s1 = await wait(async () => { const [a, b] = await Promise.all([A.town(), B.town()]); return same(a.shown.slice(0, 2), [8, 4]) && same(b.shown.slice(0, 2), [8, 4]) ? [a, b] : null; }, 30000);
  check(!!s1, 'both show the town at stage 4 (all of Tepid Falls open), the project not begun', s1 ? JSON.stringify(s1.map((x) => x.shown)) : JSON.stringify([(await A.town()).shown, (await B.town()).shown]));
  await A.foot(186, -1927, -Math.PI / 2); await B.foot(186, -1927, -Math.PI / 2);
  await sleep(2500);
  const p1 = await Promise.all([A.pj(), B.pj()]);
  check(p1.every((p) => p.on && p.built && p.stage === 0 && p.tiers[0] === true && p.tiers[1] === false && p.goal && p.goal.n === 5 && p.goal.cost === 1500), 'the yard is fenced on both screens and the goal in hand is stage 5, 1500 points', JSON.stringify(p1.map((p) => [p.stage, p.tiers, p.goal])));
  if (SHOTS) { await view(A, 184, 7.5, -1919, 197, 3, -1928); await sleep(800); await A.shot('board-closed'); await A.page.evaluate(() => window.__game.view()); }

  // ── 2. Points ──
  await A.add(700);
  const b2 = await wait(async () => { const x = await B.town(); return x.shown[2] >= 690 ? x : null; }, 25000);
  check(!!b2, 'A earns 700: B shows the same bank (the host writes the fact)', b2 ? JSON.stringify(b2.shown) : JSON.stringify((await B.town()).shown));
  await B.add(500);
  const a2 = await wait(async () => { const x = await A.town(); return x.shown[2] >= 1190 ? x : null; }, 25000);
  const b2b = await wait(async () => { const x = await B.town(); return x.shown[2] >= 1190 ? x : null; }, 25000);
  check(!!a2 && !!b2b && Math.abs(a2.shown[2] - b2b.shown[2]) <= 5 && a2.shown[1] === 4, 'B (a guest) earns 500: it goes to the host and both show about 1200 of 1500', `A ${JSON.stringify(a2 && a2.shown)}, B ${JSON.stringify(b2b && b2b.shown)}; B's frames ${JSON.stringify(B.sent.bin)}`);

  // ── 3. Cash at the board ──
  await B.page.evaluate(() => { window.__game.game.player.money = 5000; });
  await B.foot(189.5, -1927, -Math.PI / 2);
  const prompt = await wait(async () => { const t = await B.page.evaluate(() => window.__game.game.hud.promptText); return /Give to the Promenade fund/.test(t ?? '') ? t : null; }, 8000);
  check(!!prompt, 'B at the coin box: the prompt names the fund and what is to go', String(prompt));
  const need = Math.ceil(1500 - (await B.town()).shown[2]);
  const m0 = await B.money();
  await B.key('KeyG');
  const open5 = await wait(async () => { const [a, b] = await Promise.all([A.town(), B.town()]); return a.shown[1] === 5 && b.shown[1] === 5 ? [a, b] : null; }, 30000);
  const m1 = await B.money();
  check(!!open5 && m0 - m1 >= need - 1 && m0 - m1 <= need + 1, `B gives about $${need} at the board: stage 5 opens on both screens, B's pocket is $${m0 - m1} lighter`, open5 ? JSON.stringify(open5.map((x) => x.shown)) : 'no');
  await sleep(2500);
  const p3 = await Promise.all([A.pj(), B.pj()]);
  check(p3.every((p) => p.stage === 1 && p.tiers[0] === false && p.tiers[1] === true && p.tiers[2] === false), 'the fence is gone and the promenade stands on both screens (stage 1 of 3)', JSON.stringify(p3.map((p) => [p.stage, p.tiers])));
  const fin = await Promise.all([A.town(), B.town()]);
  check(fin.every((f) => /finished The Gates Open/.test(f.lastFinish)), 'each is told whose points finished it', JSON.stringify(fin.map((f) => f.lastFinish)));
  if (SHOTS) { await view(B, 182, 9, -1900, 240, 3, -1932); await sleep(900); await B.shot('stage1'); await B.page.evaluate(() => window.__game.view()); }

  // ── 4. C joins later ──
  const C = await visitor('C', '', size);
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const c4 = await wait(async () => { const x = await C.town(); return x.shown[1] === 5 ? x : null; }, 30000);
  check(!!n && !!c4 && c4.own[1] === 0, 'C joins later with nothing of its own: it shows the town\'s stage 5 at once', c4 ? `shown ${JSON.stringify(c4.shown)}, own ${JSON.stringify(c4.own)}` : 'no');
  await calm(C);
  await C.foot(240, -1990, 0);
  await sleep(1500);
  const cm0 = await C.money();
  await C.foot(250, -1932, 0);
  await sleep(2000);
  const cm1 = await C.money();
  await C.foot(250, -1990, 0); await sleep(800); await C.foot(250, -1932, 0); await sleep(1500);
  const cm2 = await C.money();
  const pc = await C.pj();
  check(pc.stage === 1 && pc.tiers[1] === true && pc.tiers[0] === false && cm1 - cm0 === 150 && cm2 === cm1 && pc.stats.ribbons === 1, 'C walks in: the promenade is up, the ribbon purse is $150 once and not twice', `money ${cm0} -> ${cm1} -> ${cm2}; ribbons ${pc.stats.ribbons}`);

  // ── 5. B's wire ──
  const textFacts = B.sent.text.filter((s) => /"t":\s*"fact"/.test(s));
  const gives = ['2.10', '3.10', '4.10', '5.10'].reduce((a, k) => a + (B.sent.bin[k] ?? 0), 0);
  check(textFacts.length === 0 && gives >= 1, 'B (a guest) wrote no fact; its points went as Give frames', `frames ${JSON.stringify(B.sent.bin)}; text ${B.sent.text.length}, facts ${textFacts.length}`);

  // ── 6. A finishes the rest ──
  await A.page.evaluate(() => window.__game.setTime(21));
  await A.add(2000 + 2500 + 20);
  const done = await wait(async () => { const x = await Promise.all([A, B, C].map((t) => t.town())); return x.every((y) => y.shown[1] === 7) ? x : null; }, 40000);
  check(!!done, 'A earns the rest (stages 6 and 7): all three screens show stage 7', done ? JSON.stringify(done.map((x) => x.shown)) : JSON.stringify(await Promise.all([A, B, C].map((t) => t.town().then((x) => x.shown)))));
  await sleep(2500);
  const p6 = await Promise.all([A, B, C].map((t) => t.pj()));
  check(p6.every((p) => p.stage === 3 && p.tiers[0] === false && p.tiers[1] && p.tiers[2] && p.tiers[3] && p.goal === null), 'every tier is up on all three (promenade, lamps, pavilion) and no goal is left', JSON.stringify(p6.map((p) => [p.stage, p.tiers, p.goal])));
  const cf = await C.town();
  check(/points finished/.test(cf.lastFinish), 'C is told whose points finished it', cf.lastFinish);
  if (SHOTS) {
    await A.foot(186, -1927, -Math.PI / 2); await sleep(1500);
    await A.page.evaluate(() => window.__game.setTime(21));
    await view(A, 214, 8, -1922, 250, 3, -1932); await sleep(1500); await A.shot('night');
    await A.page.evaluate(() => window.__game.setTime(12));
    await view(A, 183, 11, -1901, 252, 2, -1934); await sleep(1500); await A.shot('day');
    await A.page.evaluate(() => window.__game.view());
  }

  // ── 7. The service restarts ──
  await sleep(7000);   // facts are stored at most every 5 s
  for (const t of open.splice(0)) await t.close().catch(() => {});
  await stop(home);
  home = startHome(MAIN, 'main');
  check(await up(MAIN), 'the main service is started again on the same state directory', '');
  const D = await visitor('D', '', size);
  const dn = await D.until((x) => x.status === 'online' && x.home === 'main', 60000);
  const d7 = await wait(async () => { const x = await D.town(); return x.shown[1] === 7 ? x : null; }, 30000);
  await D.foot(186, -1927, -Math.PI / 2);
  await sleep(2500);
  const pd = await D.pj();
  check(!!dn && !!d7 && pd.stage === 3 && pd.tiers[1] && pd.tiers[3] && !pd.tiers[0], 'D joins the restarted service: the town\'s stage 7 was stored, the whole promenade stands', d7 ? `shown ${JSON.stringify(d7.shown)}, own ${JSON.stringify(d7.own)}, tiers ${JSON.stringify(pd.tiers)}` : 'no');

  {
    const errs = [A, B, C, D].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on A, B, C or D', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
