// Fun queue item 15: the town leaderboard. Headless browsers against LOCAL services (started and stopped here, the same
// ports as tools/net/race.mjs and pursuit.mjs: never run two of these tests at once).
//
//   node tools/net/board.mjs [--noshots]
//
//  1. A (the host) and B (pinned hidden, a guest) in town. A's car is thrown up off the street: A's own best "Highest
//     jump" moves, A offers it to itself (the host), and the town fact goes out. B sees A's name and height in the
//     town's board, on the downtown billboard, and in the pause menu (Stats, Form S-3), with B's own best beside it.
//  2. B jumps higher: B's offer goes to the host as a ToHost frame, the host writes it, and both screens put B first,
//     A second.
//  3. C arrives late: the welcome's facts give C the same board.
//  4. An unbelievable offer (over the category's ceiling) is refused by the host.
// Pictures (unless --noshots) in shots/board-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-board-'));
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
  const t = await boot({ start: false, query: `q=low&save=0&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.lb = () => t.page.evaluate(() => window.__game.game.systems.find((s) => s && s.constructor && s.constructor.name === 'Leaderboard').info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.lwait = async (fn, ms = 20000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.lb(); if (fn(n)) return n; if (Date.now() > end) return n; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `board-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
/** In a fresh car on the street by the start (`t` along the block), settled, then thrown straight up at `vy` m/s. */
async function jump(t, at, vy) {
  await t.page.evaluate((at) => { const G = window.__game, g = G.game, c = g.plan.curbPoint(5, 6, 2, at); G.teleport(c.x, c.z + 3, c.h); const v = g.vehicles.spawn('sedan', c.x, c.z, c.h); g.player.enter(v, true); g.cam.snap(); }, at);
  await sleep(2000);
  await t.page.evaluate((vy) => { const v = window.__game.game.player.vehicle; v.vy = v.vyF = v.vyR = vy; v.y += 0.3; v.yF += 0.3; v.yR += 0.3; v.onGround = false; }, vy);
  await sleep(6000);
}
const topOf = (info, key) => ((info.net && info.net.tops.find((x) => x[0] === key)) || [key]).slice(1);
const nameOf = (s) => String(s).split('=')[0];
const valOf = (s) => Number(String(s).split('=')[1]);

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  const B = await visitor('B', [960, 540]);
  await B.pin(true);
  const roles = await (async () => { for (const end = Date.now() + 60000; Date.now() < end; await sleep(300)) { const [a, b] = await Promise.all([A.net(), B.net()]); if (a.status === 'online' && b.status === 'online' && a.count === 2 && a.host === a.id) return [a, b]; } return null; })();
  check(!!roles, 'A and B in town, A the host', roles ? `${roles[0].id} host, ${roles[1].id}` : 'timed out');
  const nameA = roles ? roles[0].name : '?', nameB = roles ? roles[1].name : '?';
  for (const t of [A, B]) await calm(t);
  let la = await A.lwait((x) => x.town, 8000), lbB = await B.lwait((x) => x.town, 8000);
  check(la.town && lbB.town, 'both boards are the town\'s', `${la.town} ${lbB.town}`);

  // ── 1. A's jump ──
  await jump(A, 0.45, 14);
  la = await A.lwait((x) => topOf(x, 'high').length > 0, 8000);
  const aHigh = la.pages[0].mine, aTop = topOf(la, 'high');
  check(aHigh > 30 && la.jumps >= 1, 'A\'s own best Highest jump moved', `${aHigh} dm, ${la.jumps} jump(s)`);
  check(aTop.length === 1 && valOf(aTop[0]) === aHigh && la.net.written >= 1, 'the host (A) wrote it to the town', JSON.stringify(aTop));
  lbB = await B.lwait((x) => topOf(x, 'high').length > 0, 8000);
  const bTop = topOf(lbB, 'high');
  check(bTop.length === 1 && valOf(bTop[0]) === aHigh && lbB.pages[0].rows[0].startsWith(nameOf(aTop[0])), 'B has A\'s record on its board', JSON.stringify(bTop));
  // B's billboard: turn it to the Highest jump page and look.
  const shown = await B.page.evaluate(() => { const b = window.__game.game.systems.find((s) => s && s.constructor && s.constructor.name === 'Leaderboard'); for (let i = 0; i < 40 && b.signs[0].shown !== 'Highest jump'; i++) { b.page++; b.draw(); } return b.signs[0].shown; });
  check(shown === 'Highest jump', 'B\'s billboard shows Highest jump', shown);
  if (SHOTS) {
    await B.page.evaluate(() => { const G = window.__game, b = G.game.systems.find((s) => s && s.constructor && s.constructor.name === 'Leaderboard'), s = b.signs[0].group, h = s.rotation.y, x = s.position.x, z = s.position.z, y = s.position.y; b.pageT = -60; G.view(x + Math.sin(h) * 22 + Math.cos(h) * 5, y + 4, z + Math.cos(h) * 22 - Math.sin(h) * 5, x, y + 9.5, z); });
    await sleep(2500);
    await B.shot('B-billboard');
  }
  // B's menu: Stats, Form S-3.
  await B.page.keyboard.press('Escape');
  await sleep(500);
  await B.page.evaluate(() => { const b = [...document.querySelectorAll('.mn-tab')].find((x) => /Stats/i.test(x.textContent)); if (b) b.click(); });
  await sleep(500);
  const menu = await B.page.evaluate(() => { const r = [...document.querySelectorAll('.lb-row')].find((x) => /Highest jump/.test(x.textContent)); return { row: r ? r.innerText.replace(/\s+/g, ' ') : '', head: (document.querySelector('.lb-sec h3') || {}).textContent || '' }; });
  check(menu.row.includes(nameOf(aTop[0])) && /yours: none filed/.test(menu.row) && /Town leaderboard/.test(menu.head), 'B\'s menu (Stats, Form S-3) lists A\'s jump, with B\'s own beside it', menu.row);
  if (SHOTS) { await B.page.evaluate(() => { const s = document.querySelector('.lb-sec'); if (s) s.scrollIntoView(); }); await sleep(300); await B.shot('B-menu'); }
  await B.page.keyboard.press('Escape');
  await sleep(400);

  // ── 2. B jumps higher: the guest's offer ──
  await calm(B);
  await jump(B, 0.2, 20);
  lbB = await B.lwait((x) => topOf(x, 'high').length >= 2, 10000);
  la = await A.lwait((x) => topOf(x, 'high').length >= 2, 4000);
  const bHigh = lbB.pages[0].mine, t2 = topOf(la, 'high'), t2b = topOf(lbB, 'high');
  check(bHigh > aHigh && lbB.net.offersSent >= 1 && la.net.offersGot >= 1, 'B jumped higher and offered it to the host', `B ${bHigh} dm vs A ${aHigh}; sent ${lbB.net.offersSent}, got ${la.net.offersGot}`);
  check(t2.length === 2 && valOf(t2[0]) === bHigh && valOf(t2[1]) === aHigh && JSON.stringify(t2) === JSON.stringify(t2b), 'both boards: B first, A second', JSON.stringify(t2b));

  // ── 3. The late joiner ──
  const C = await visitor('C');
  await C.pin(true);
  const lc = await C.lwait((x) => x.town && topOf(x, 'high').length >= 2, 60000);
  check(JSON.stringify(topOf(lc, 'high')) === JSON.stringify(t2), 'C, arriving late, has the same board from the welcome', JSON.stringify(topOf(lc, 'high')));
  check(lc.pages[0].rows.length === 2 && lc.pages[0].mine === null, 'C\'s Highest jump page: two rows, and none of C\'s own', JSON.stringify(lc.pages[0]));

  // ── 4. An unbelievable offer ──
  await B.page.evaluate(() => { const b = window.__game.game.systems.find((s) => s && s.constructor && s.constructor.name === 'Leaderboard'); b.link.offer(0, 99999); });
  await sleep(1500);
  la = await A.lb();
  check(la.net.refused >= 1 && valOf(topOf(la, 'high')[0]) === bHigh, 'the host refuses a jump over the ceiling', `refused ${la.net.refused}`);
  void nameA; void nameB;
  const errs = [A, B, C].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
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
