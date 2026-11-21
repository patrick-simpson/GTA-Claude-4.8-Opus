// Multiplayer notices: "town full" and "multiplayer resting", in real headless browsers against a LOCAL service.
//
//   node tools/net/notices.mjs             the checks and four pictures (shots/net/notice-*.png)
//   node tools/net/notices.mjs --noshots
//
// It starts its OWN `wrangler dev` (port 8793, a throwaway storage folder) with tiny limits given through the
// local-only test var: 2 seats, and a daily allowance of 200 Durable Object requests (pause line 80).
//  0. F is given two addresses, the first dead: it must fall through to the second, and remember it.
//  1. A and B take the two seats. C is refused: plays alone, sees the notice once and the small line; asks again
//     every few seconds (`&netretry=4`, which only works with a localhost `?net=`).
//  2. A leaves. C is moved in; the line goes away and the count appears.
//  3. The allowance is used up (the script asks the service's test page until the count passes the line). B and C
//     are told to rest: both play alone, the line gives the resume time in the PAGE'S time zone (the browsers run
//     as America/New_York here, so 00:00 UTC must read 7:00 PM or 8:00 PM), and nothing contacts the service again,
//     not even after a reload.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

process.env.TZ = 'America/New_York'; // Chromium takes its time zone from here

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const args = process.argv.slice(2);
const SHOTS = !args.includes('--noshots');
const PORT = 8793;
const HTTP = `http://127.0.0.1:${PORT}`, NET = `ws://127.0.0.1:${PORT}`;
const LIMITS = { seats: 2, doRequests: 200 };
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

// ── The local service ──
const persist = mkdtempSync(path.join(tmpdir(), 'pc-notices-'));
const child = spawn(path.join(serverDir, 'node_modules', '.bin', 'wrangler'),
  ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--show-interactive-dev-session=false', '--var', `TEST_BUDGET:${JSON.stringify(LIMITS)}`],
  { cwd: serverDir, detached: true, stdio: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
const stopServer = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } rmSync(persist, { recursive: true, force: true }); };
const probe = async (q = '') => (await fetch(`${HTTP}/__test${q}`)).json();
for (let i = 0; ; i++) {
  try { if ((await fetch(HTTP + '/')).ok) break; } catch { /* not up yet */ }
  if (i > 200) { console.log('FAIL  the local service did not start (run `npm install` in server/ once)'); stopServer(); process.exit(1); }
  await sleep(300);
}

async function open(tag, { mobile = false, size = [480, 270], retry = 0, net = NET } = {}) {
  const t = await boot({ start: false, mobile, query: `net=${encodeURIComponent(net)}&q=low${retry ? '&netretry=' + retry : ''}`, ...(mobile ? {} : { width: size[0], height: size[1] }) });
  t.tag = tag;
  t.sockets = [];
  t.page.on('websocket', (ws) => { if (ws.url().startsWith(NET)) t.sockets.push(ws.url()); });
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const n = await t.net();
      if (fn(n)) return n;
      if (Date.now() > end) return null;
      await sleep(200);
    }
  };
  t.toasts = () => t.page.evaluate(() => [...document.querySelectorAll('.hud-toast-tx')].map((e) => e.textContent));
  /** Where the line sits, and whether it overlaps the cash slip or the radar. */
  t.layout = () => t.page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? r : null; };
    const hit = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const n = box('.hud-town-note'), all = [...document.querySelectorAll('#hud .hud-cash, #hud .hud-radar, #hud .hud-heat, #hud .hud-drive, #hud .hud-vitals, #hud .hud-vital')];
    return { shown: !!n, w: n ? Math.round(n.width) : 0, h: n ? Math.round(n.height) : 0, inside: !!n && n.left >= 0 && n.right <= innerWidth && n.top >= 0 && n.bottom <= innerHeight,
      overlaps: all.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && hit(n, r); }).map((e) => e.className) };
  });
  return t;
}
const walk = async (t) => {
  await t.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  const x0 = (await t.page.evaluate(() => window.__game.info())).x;
  await t.page.keyboard.down('KeyW'); await sleep(3000); await t.page.keyboard.up('KeyW');
  const i = await t.page.evaluate(() => window.__game.info());
  return { ok: i.state === 'play' && i.x - x0 > 0.1, m: (i.x - x0).toFixed(1) };
};

const pages = [];
try {
  // ── 0. The address list: main first, then backup, and the one that worked is remembered ──
  const F = await open('F', { net: `ws://127.0.0.1:8799,${NET}` });   // nobody listens on 8799
  pages.push(F);
  let f = await F.until((n) => n.status === 'online');
  check(!!f && f.service === 1 && f.attempts === 2, 'two addresses, the first dead: the second is tried at once and works', f ? `service ${f.service} after ${f.attempts} attempts` : JSON.stringify(await F.net()).slice(0, 200));
  await F.page.reload({ waitUntil: 'load' });
  await F.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  f = await F.until((n) => n.status === 'online');
  check(!!f && f.service === 1 && f.attempts === 1, 'on the next visit the address that worked is tried first', f ? `service ${f.service} after ${f.attempts} attempt` : '');
  await F.close(); pages.splice(pages.indexOf(F), 1);
  await sleep(500);

  // ── 1. Town full ──
  const A = await open('A'), B = await open('B');
  pages.push(A, B);
  check(!!(await A.until((n) => n.status === 'online')) && !!(await B.until((n) => n.status === 'online' && n.remotes.length === 1)), 'A and B take the two seats (the test town has 2)');
  const C = await open('C', { size: [1280, 720], retry: 4 });
  pages.push(C);
  let n = await C.until((n) => n.notice === 'full');
  check(!!n && n.status === 'full' && n.count === 0 && n.seats === 2 && /^Town full · 2 of 2\nOn the waiting list$/.test(n.noteText), 'C is refused a seat: single player, with the small line', n ? JSON.stringify(n.noteText) : JSON.stringify(await C.net()).slice(0, 200));
  check(!!n && n.retryAt > Date.now() && n.retryAt - Date.now() < 6000, 'C will ask again shortly (4 s here; 3 minutes and a spread in the real game)', n ? `in ${((n.retryAt - Date.now()) / 1000).toFixed(1)} s` : '');
  await C.page.evaluate(() => window.__game.start());
  const told = async (t, re) => { for (let i = 0; i < 40; i++) { if ((await t.toasts()).some((x) => re.test(x))) return true; await sleep(250); } return false; };
  check(await told(C, /^Town is full: all 2 berths are taken\./), 'on entry C gets the notice once, in the game\'s voice', (await C.toasts()).join(' | ').slice(0, 160));
  let lay = await C.layout();
  check(lay.shown && lay.inside && lay.overlaps.length === 0, 'the line is on screen and covers neither the cash slip nor the radar (1280 x 720)', JSON.stringify(lay));
  if (SHOTS) {
    await sleep(1500);
    console.log('shot', await C.shot('shots/net/notice-full.png'));
    const M = await open('M', { mobile: true, retry: 60 });
    pages.push(M);
    await M.until((n) => n.notice === 'full');
    await M.page.evaluate(() => window.__game.start());
    await told(M, /^Town is full/);
    await sleep(1500);
    lay = await M.layout();
    check(lay.shown && lay.inside && lay.overlaps.length === 0, 'the same on a phone layout (844 x 390, touch)', JSON.stringify(lay));
    console.log('shot', await M.shot('shots/net/notice-full-mobile.png'));
    await M.close(); pages.splice(pages.indexOf(M), 1);
  }
  const w = await walk(C);
  check(w.ok, 'C can play alone while waiting', `walked ${w.m} m`);
  for (let i = 0; i < 40 && C.sockets.length < 2; i++) await sleep(250);
  const asked = C.sockets.length;
  check(asked >= 2, 'C has asked again, quietly, while waiting', `${asked} sockets so far`);

  // ── 2. A seat opens ──
  await A.close(); pages.splice(pages.indexOf(A), 1);
  const t0 = Date.now();
  n = await C.until((n) => n.status === 'online' && n.remotes.length === 1, 45000);
  check(!!n && n.notice === '' && n.noteText === '' && n.countText === '2 in town', 'a seat opens: C is moved in, the line goes and "2 in town" appears', n ? `after ${((Date.now() - t0) / 1000).toFixed(0)} s` : JSON.stringify(await C.net()).slice(0, 200));
  check((await C.layout()).shown === false, 'the "town full" line is no longer shown');

  // ── 3. Resting ──
  await B.page.evaluate(() => window.__game.start());
  let s = await probe();
  for (let i = 0; i < 200 && !s.spent; i++) s = await probe();   // every look is a request to the town, and counted
  check(s.spent === 'doRequests', 'the day\'s (tiny) allowance is used up', `${s.used.doRequests.toFixed(1)} of a line of ${s.lines.doRequests}`);
  // The next message from either player (a keepalive, within 2 s) is what makes the town send everybody home.
  const nb = await B.until((n) => n.notice === 'rest', 15000);
  n = await C.until((n) => n.notice === 'rest', 15000);
  const tz = await C.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const midnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
  const want = new Date(midnight).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  check(!!n && !!nb && n.status === 'resting' && nb.status === 'resting' && n.count === 0 && n.remotes.length === 0, 'B and C are told to rest: both single player, nobody else drawn', n ? '' : JSON.stringify(await C.net()).slice(0, 200));
  check(!!n && n.noteText.replace(/ /g, ' ') === `Multiplayer resting\nBack at ${want}` && /^(7|8):00 PM$/.test(want), `the line gives the resume time in the page's own time zone (${tz})`, n ? JSON.stringify(n.noteText) : '');
  check(!!n && Math.abs(n.resumeAt - midnight) < 3000 && n.restUntil >= n.resumeAt && n.restUntil <= n.resumeAt + 5 * 60000 + 1, 'the service will next be asked at the resume time plus up to 5 minutes', n ? `resume in ${((n.resumeAt - Date.now()) / 3600000).toFixed(2)} h, asking ${((n.restUntil - n.resumeAt) / 1000).toFixed(0)} s after` : '');
  check(await told(C, /^Multiplayer is resting until (7|8):00/), 'C gets the resting notice once', (await C.toasts()).join(' | ').slice(0, 200));
  lay = await C.layout();
  check(lay.shown && lay.inside && lay.overlaps.length === 0, 'the resting line covers neither the cash slip nor the radar', JSON.stringify(lay));
  if (SHOTS) { await sleep(1200); console.log('shot', await C.shot('shots/net/notice-rest.png')); }
  const before = C.sockets.length, used0 = (await probe()).used;
  await sleep(9000);
  const w2 = await walk(C);
  check(C.sockets.length === before && w2.ok, 'while resting C opens no socket at all, and plays on', `${C.sockets.length - before} new sockets in 12 s, walked ${w2.m} m`);
  // A reload must not ask either: the resume time is remembered by the browser.
  const fresh = [];
  C.page.on('websocket', (ws) => { if (ws.url().startsWith(NET)) fresh.push(ws.url()); });
  await C.page.reload({ waitUntil: 'load' });
  await C.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await C.page.evaluate(() => window.__game.start());
  n = await C.until((n) => n.notice === 'rest', 8000);
  await sleep(6000);
  const used1 = (await probe()).used;
  check(!!n && fresh.length === 0 && n.attempts === 0, 'after a reload: still resting, still no socket (the time is remembered)', `${fresh.length} sockets ${fresh.join(' ').slice(0, 120)}, ${n ? n.attempts : '?'} attempts`);
  check(used1.workerRequests === used0.workerRequests && Math.abs(used1.doRequests - used0.doRequests - 1) < 1e-9, 'and the service saw nothing from the players in that time (only this script\'s own look)', JSON.stringify([used0, used1]).slice(0, 300));
  if (SHOTS) {
    const M = await open('M2', { mobile: true });
    pages.push(M);
    // A new visitor has no remembered time: one request, answered by the Worker from memory.
    await M.until((n) => n.notice === 'rest');
    await M.page.evaluate(() => window.__game.start());
    await told(M, /^Multiplayer is resting/);
    await sleep(1500);
    await sleep(5000);
    lay = await M.layout();
    const m = await M.net();
    // (The one socket was opened while the page booted, before this script could listen for it: count the attempts.)
    check(lay.shown && lay.inside && lay.overlaps.length === 0 && m.attempts === 1 && M.sockets.length === 0, 'a new visitor on a phone: one ask, the notice, and no more', `${m.attempts} attempt, ${JSON.stringify(lay)}`);
    console.log('shot', await M.shot('shots/net/notice-rest-mobile.png'));
  }
  const own = (e) => /WebSocket connection to 'ws:\/\/127\.0\.0\.1/.test(e);
  const errs = pages.flatMap((t) => t.errors.filter((e) => !own(e)).map((e) => t.tag + ': ' + e));
  check(errs.length === 0, 'no console errors on any page', errs.slice(0, 3).join(' | ').slice(0, 300));
} catch (e) {
  check(false, 'the script ran to the end', String(e?.stack ?? e).split('\n').slice(0, 3).join(' '));
} finally {
  for (const t of pages) await t.close().catch(() => {});
  stopServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
