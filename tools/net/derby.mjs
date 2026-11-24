// Fun queue item 13: the demolition derby at Flounder Field. Headless browsers against LOCAL services.
//
//   node tools/net/derby.mjs [--noshots]
//
// Started and stopped as tools/net/pursuit.mjs is (the same ports: never run two of these tests at once). A is the
// host; B is pinned hidden, so it says it cannot host.
//  0. A alone in town at the gate: "you and 7 locals"; G starts a derby at once: 8 numbered cars (A's and 7 AI), the
//     countdown, then the AI ram each other: hits, dents, bumpers in the dirt; a short round ends on the podium with
//     8 rows; G closes it and A is back outside the gate in the battered car.
//  1. B arrives. A calls a derby: B gets the invitation (a toast and a D on the radar), drives to the gate and joins;
//     A presses G again: both get derby cars in the bowl, 6 AI fill the field; B sees the AI as ghosts that move and
//     dent; B rams an AI car (a hit, counted on B's screen and reported to A); the round ends: the same order on both
//     podiums, and the host writes the town record for hits in one derby, which B holds.
// Pictures (unless --noshots) in shots/derby-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-derby-'));
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
  t.hp = () => t.page.evaluate(() => window.__game.game.todo.derby.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.hwait = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.hp(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.prompt = () => t.page.evaluate(() => window.__game.game.todo.derby.prompt);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `derby-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
/** In a fresh car at (x, z), facing h, standing still. */
const carAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; G.teleport(x, z, h); const v = g.vehicles.spawn('sedan', x, z, h); g.player.enter(v, true); g.cam.snap(); return !!g.player.vehicle; }, [x, z, h]);
/** This player's car, stopped, at (x, z). */
const moveCar = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const v = window.__game.game.player.vehicle; if (!v) return false; v.x = x; v.z = z; v.h = h; v.vx = v.vy = v.vz = 0; return true; }, [x, z, h]);
const carOf = (t) => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: v.x, z: v.z, h: v.h, kind: v.spec.kind } : null; });
const blipsOf = (t) => t.page.evaluate(() => { const out = []; window.__game.game.todo.derby.blips(out); return out; });
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }


const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
const G = { x: -476, z: -70 };
const inBowl = (c) => !!c && c.x !== null && Math.hypot(c.x + 421, c.z + 70) < 30;
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  check((await A.hp()).gate.x === G.x, 'the gate is where the test expects it');

  // ── 0. Solo against the AI ──
  {
    await calm(A);
    await carAt(A, G.x, G.z, Math.PI / 2);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /you and 7 locals/.test(pr), 'alone at the gate: "[G] Demolition derby: you and 7 locals"', pr);
    await A.page.evaluate(() => { window.__game.game.todo.derby.testRound = 24; });
    await A.key('KeyG');
    const c0 = await A.hwait((r) => r.phase === 'count' || r.phase === 'fight', 4000);
    const ok0 = c0 && c0.cars.length === 8 && c0.cars.filter((c) => c.ai).length === 7 && c0.cars.every(inBowl);
    check(!!ok0, 'G starts at once: 8 cars in the bowl, 7 of them AI', c0 ? `${c0.phase} ${c0.cars.length} cars` : 'no');
    const mine = await carOf(A);
    check(inBowl(mine), 'A is at the wheel of a derby car in the bowl', JSON.stringify(mine));
    const f = await A.hwait((r) => r.phase === 'fight' && r.hits >= 3, 25000);
    check(!!f, 'the AI ram each other: hits counted', f ? `hits ${f.hits}, wall ${f.wall}, bumpers ${f.bumpers}` : JSON.stringify((await A.hp()).hits));
    await sleep(3000);
    const m = await A.hp();
    const worst = Math.max(...m.cars.map((c) => c.dmg ? Math.max(...c.dmg) : 0));
    const hurt = m.cars.filter((c) => c.hp < 90).length;
    check(worst >= 0.7 && hurt >= 3, 'the damage is brutal: a zone folded past 0.7, three or more cars under 90', `worst ${worst}, hurt ${hurt}, bumpers ${m.bumpers}`);
    await A.shot('solo');
    const pod = await A.hwait((r) => r.phase === 'podium', 40000);
    check(!!pod && pod.results.length === 8 && pod.results[0].place === 1, 'the round ends on a podium of 8', pod ? JSON.stringify(pod.results.map((r) => r.num)) : 'no');
    const card = await A.page.evaluate(() => { const c = document.getElementById('dd-card'); return c && c.style.display === 'block' ? c.innerText : ''; });
    check(/DEMOLITION DERBY/.test(card) && /\(you\)/.test(card), 'the podium card is up', card.slice(0, 80).replace(/\n/g, ' '));
    await A.key('KeyG');
    const back = await A.hwait((r) => r.phase === 'idle', 4000);
    const out = await carOf(A);
    check(!!back && !!out && Math.hypot(out.x - G.x, out.z - G.z) < 12, 'G closes it: A is back outside the gate in the derby car', JSON.stringify(out));
  }

  const B = await visitor('B', [960, 540]);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net()]); return ns[0].traffic.mode === 'host' && ns[1].traffic.mode === 'guest' ? ns : null; }, 60000);
  check(!!n && !!roles, 'two in town: A the host, B its guest', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];

  // ── 1. Together ──
  {
    for (const t of [A, B]) await calm(t);
    await carAt(A, G.x, G.z, Math.PI / 2);
    await carAt(B, G.x - 160, G.z, Math.PI / 2);
    await sleep(1500);
    const pr = await A.prompt();
    check(!!pr && /^\[G\] Call a demolition derby/.test(pr), 'with others in town: "[G] Call a demolition derby"', pr);
    await A.page.evaluate(() => { window.__game.game.todo.derby.testRound = 30; });
    await A.key('KeyG');
    const ac = await A.hwait((r) => r.phase === 'calling', 4000);
    check(!!ac, 'A is calling', ac ? ac.phase : 'no');
    const binv = await B.hwait((r) => r.invites.length === 1, 6000);
    const toast = (await wait(() => B.page.evaluate(() => (document.body.innerText.match(/called a demolition derby[\s\S]{0,40}/) || [''])[0]), 9000, 300)) || '';
    const db = (await blipsOf(B)).filter((b) => b.label === 'D' && b.kind === 'goal').length;
    check(!!binv && /Flounder Field/.test(toast) && db === 1, 'B is invited: a toast and a D on the radar', `${toast.slice(0, 80)} / D blips ${db}`);
    await moveCar(B, G.x - 12, G.z + 4, Math.PI / 2);
    const bj = await B.hwait((r) => r.phase === 'joined', 6000);
    const aj = await A.hwait((r) => r.cars.length === 2, 4000);
    check(!!bj && !!aj, 'B drove to the gate and joined', bj ? bj.phase : 'no');
    await A.key('KeyG');
    const bs = await B.hwait((r) => (r.phase === 'count' || r.phase === 'fight') && r.cars.length === 8, 6000);
    const as = await A.hp();
    check(!!bs && bs.cars.filter((c) => c.ai).length === 6 && as.cars.length === 8, 'G: both in, 6 AI fill the field to 8', bs ? `${bs.cars.length} cars on B, ${as.cars.length} on A` : 'no');
    const bcar = await carOf(B);
    check(inBowl(bcar), 'B is at the wheel of a derby car in the bowl', JSON.stringify(bcar));
    await B.hwait((r) => r.phase === 'fight', 8000);
    await sleep(3000);
    const g1 = (await B.hp()).cars.filter((c) => c.ai);
    await sleep(1500);
    const g2 = (await B.hp()).cars.filter((c) => c.ai);
    const moved = g1.filter((c, i) => g2[i] && Math.hypot(c.x - g2[i].x, c.z - g2[i].z) > 1).length;
    check(moved >= 3, 'B sees the AI cars (ghosts) moving', `${moved} of ${g1.length} moved`);
    // B rams the nearest AI car: a hit on B's screen, told to A.
    let bh = null;
    for (let k = 0; k < 8 && !bh; k++) {
      await B.page.evaluate(() => {
        const g = window.__game.game, d = g.todo.derby, v = g.player.vehicle; if (!v) return;
        let best = null, bd = 1e9;
        for (const e of d.ents.values()) if (e.ai && e.car && !e.out) { const q = Math.hypot(e.car.x - v.x, e.car.z - v.z); if (q < bd) { bd = q; best = e.car; } }
        if (!best) return;
        const a = Math.atan2(best.x - v.x, best.z - v.z); v.x = best.x - Math.sin(a) * 6; v.z = best.z - Math.cos(a) * 6; v.h = a;
        v.vx = Math.sin(a) * 16; v.vz = Math.cos(a) * 16;
      });
      bh = await B.hwait((r) => (r.cars.find((c) => c.id === ids[1]) || {}).hits >= 1, 2500);
    }
    check(!!bh, 'B rams an AI car: a hit on B\'s screen', bh ? JSON.stringify(bh.cars.find((c) => c.id === ids[1])) : 'no');
    const ah = await A.hwait((r) => (r.cars.find((c) => c.id === ids[1]) || {}).hits >= 1, 4000);
    check(!!ah, 'A hears of B\'s hit', ah ? JSON.stringify(ah.cars.find((c) => c.id === ids[1])) : 'no');
    const bd = await B.hp();
    const gd = bd.cars.filter((c) => c.ai && c.dmg && Math.max(...c.dmg) > 0.3).length;
    check(gd >= 3, 'the AI cars\' dents reach B', `${gd} dented ghosts`);
    await B.shot('carnage');
    const ends = await Promise.all([A.hwait((r) => r.phase === 'podium', 45000), B.hwait((r) => r.phase === 'podium', 45000)]);
    const oa = ends[0] ? ends[0].results.map((r) => r.id).join(',') : 'none', ob = ends[1] ? ends[1].results.map((r) => r.id).join(',') : 'none';
    check(!!ends[0] && !!ends[1] && oa === ob && ends[0].results.length === 8, 'the same podium order on both screens', `${oa} / ${ob}`);
    await sleep(600);
    await B.shot('podium');
    const rec = await wait(async () => { const x = (await B.net()).derby.record; return x && x.hits >= 1 ? x : null; }, 8000);
    check(!!rec, 'the host wrote the town record for hits in one derby, and B has it', JSON.stringify(rec));
    for (const t of [A, B]) await t.key('KeyG');
    const idle = await Promise.all([A.hwait((r) => r.phase === 'idle', 4000), B.hwait((r) => r.phase === 'idle', 4000)]);
    check(idle.every(Boolean), 'both close the podium', idle.map((x) => x ? x.phase : 'no').join(','));
    const errs = [A, B].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
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
