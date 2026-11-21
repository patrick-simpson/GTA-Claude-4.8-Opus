// "Where is main": a real headless browser finds the MAIN service through the lookup, remembers it, follows it to
// a new address, falls back to the BACKUP when main is gone, and to single player when both are.
//
//   node tools/net/main.mjs
//
// It starts everything itself, all local, and stops it again:
//  - the Node home (server/home/main.ts), which is "main", on port 8796 and later a second copy on 8799;
//  - `wrangler dev` (the Worker), which is "the backup", on port 8797;
//  - a tiny stand-in for the lookup on port 8798: GET /main answers {"u": ...} as the Worker does. (The real Worker
//    may only ever name https://<name>.trycloudflare.com, which no local test can be; `&netmain=` is the test-only
//    way to point the game at a stand-in, and it is read only alongside a local `?net=`.)
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN1 = 8796, BACKUP = 8797, LOOKUP = 8798, MAIN2 = 8799;
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-main-'));
const kids = [];
const up = async (port) => { for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome(port) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, 'home') } });
  kids.push(c);
  return c;
}
const stop = async (c) => { if (c.exitCode === null) { const gone = new Promise((r) => c.once('exit', r)); try { c.detached ? process.kill(-c.pid, 'SIGTERM') : c.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); } };

// The stand-in for the lookup.
let mainNow = `http://127.0.0.1:${MAIN1}`, asked = 0;
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  asked++;
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: mainNow }));
}).listen(LOOKUP, '127.0.0.1');

let home = startHome(MAIN1);
const backup = spawn(path.join(serverDir, 'node_modules', '.bin', 'wrangler'),
  ['dev', '--port', String(BACKUP), '--ip', '127.0.0.1', '--persist-to', path.join(tmp, 'backup'), '--show-interactive-dev-session=false'],
  { cwd: serverDir, detached: true, stdio: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
backup.detached = true;
kids.push(backup);

let t = null;
try {
  if (!(await up(MAIN1)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  const query = `q=low&net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
  t = await boot({ start: false, query, width: 480, height: 270 });
  const sockets = [];
  t.page.on('websocket', (ws) => sockets.push(new URL(ws.url()).port));
  const net = () => t.page.evaluate(() => window.__game.net());
  const until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  const say = (n) => (n ? `${n.status} on ${n.home || 'nothing'}, ${n.attempts} attempt(s), ${n.lookups} lookup(s)` : 'timed out');
  await t.page.evaluate(() => window.__game.start());

  // 1. Nothing remembered: ask the lookup, then main.
  let n = await until((x) => x.status === 'online');
  check(!!n && n.home === 'main' && n.lookups === 1 && n.attempts === 1 && asked === 1, 'first visit: the page asks where main is, once, and joins main', say(n));
  check(sockets.join() === String(MAIN1), 'and the backup was never contacted', `sockets to ports ${sockets.join()}`);

  // 2. The next visit: the remembered address, and nobody is asked.
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await t.page.evaluate(() => window.__game.start());
  n = await until((x) => x.status === 'online');
  check(!!n && n.home === 'main' && n.lookups === 0 && n.attempts === 1 && asked === 1, 'next visit: main is tried from memory, the lookup is NOT asked', say(n) + `, lookup asked ${asked} time(s) in all`);

  // 3. The tunnel restarts: main is at a new address.
  await stop(home);
  home = startHome(MAIN2);
  await up(MAIN2);
  mainNow = `http://127.0.0.1:${MAIN2}`;
  n = await until((x) => x.status === 'online' && x.attempts >= 3);
  check(!!n && n.home === 'main' && n.lookups === 1 && sockets.at(-1) === String(MAIN2) && !sockets.includes(String(BACKUP)), 'main moved: the old address fails, the lookup is asked once, the page joins main at the new address', say(n) + `, sockets ${sockets.join()}`);

  // 4. Main is gone: the backup.
  await stop(home);
  mainNow = null;
  n = await until((x) => x.status === 'online' && x.home === 'backup');
  check(!!n && sockets.at(-1) === String(BACKUP), 'main down: the page falls back to the backup', say(n));

  // 5. Main comes back: a later visit finds it again (the backup said nothing new until it was asked).
  home = startHome(MAIN1);
  await up(MAIN1);
  mainNow = `http://127.0.0.1:${MAIN1}`;
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await t.page.evaluate(() => window.__game.start());
  n = await until((x) => x.status === 'online');
  check(!!n && n.home === 'main' && n.lookups === 1, 'main back: the next visit asks and returns to main', say(n));

  // 6. Both gone: single player, playable, quiet.
  await stop(home);
  await stop(backup);
  mainNow = null;
  n = await until((x) => x.status === 'waiting' && x.count === 0 && x.attempts >= 3, 90000);
  await t.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  const x0 = (await t.info()).x;
  await t.page.keyboard.down('KeyW'); await sleep(3000); await t.page.keyboard.up('KeyW');
  const i = await t.info();
  check(!!n && i.state === 'play' && i.x - x0 > 0.1, 'both down: single player, and the game plays', say(n) + `, walked ${(i.x - x0).toFixed(1)} m`);
  const own = t.errors.filter((e) => /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|WebSocket is closed before the connection is established/.test(e));
  const rest = t.errors.filter((e) => !own.includes(e));
  check(rest.length === 0, 'no errors from the game through all of it', rest.slice(0, 2).join(' | ').slice(0, 300) || `the browser's own "WebSocket connection failed" line, ${own.length} time(s)`);
  await t.close(); t = null;

  // 7. A link cannot point the lookup anywhere else, and with ?net=0 nobody is asked (the production constants are set now, so a bare page would reach the real service).
  const before = asked;
  for (const [label, q] of [['a non-local &netmain is ignored', `q=low&net=${encodeURIComponent('ws://127.0.0.1:8790')}&netmain=${encodeURIComponent('https://example.com')}`], ['&netmain with the net switched off is ignored: nothing connects, nothing is asked', `q=low&net=0&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`]]) {
    const p = await boot({ start: false, query: q, width: 480, height: 270 });
    const reqs = [];
    p.page.on('request', (r) => { if (/\/main(\?|$)/.test(r.url())) reqs.push(r.url()); });
    await p.page.evaluate(() => window.__game.start());
    await sleep(2500);
    const m = await p.page.evaluate(() => window.__game.net());
    check(m.lookups === 0 && reqs.length === 0 && asked === before && m.home !== 'main', label, `status ${m.status}, ${m.lookups} lookups`);
    await p.close();
  }
} catch (e) {
  failed++;
  console.log('FAIL  ' + (e && e.stack ? e.stack : e));
} finally {
  if (t) await t.close().catch(() => {});
  for (const c of kids) await stop(c);
  lookup.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
