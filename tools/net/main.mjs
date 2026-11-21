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
//  - a stand-in backup on port 8800 that knows where main is: it answers an unflagged join with "go to main" as the
//    Worker does, and passes a flagged one (`nm=1`) through to the real local Worker. (The real Worker can only ever
//    know a trycloudflare address; server/test/local.mjs checks its side of this.)
// It also checks that everybody ends up in ONE town: two browsers opened together both land on main, a browser on
// the backup moves to main by itself when main comes back (`&netprobe=3` shortens the wait, test only), the backup
// sends newcomers to main, and a full main never spills into the backup.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { boot } from '../pw.mjs';

const MAIN1 = 8796, BACKUP = 8797, LOOKUP = 8798, MAIN2 = 8799, STANDIN = 8800, MAIN3 = 8801, DEAD = 8802;
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-main-'));
const kids = [];
const up = async (port) => { for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome(port, extra = {}) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, 'home'), ...extra } });
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

// The stand-in backup: "go to main" for an unflagged join while it knows a main, else straight through to the Worker.
const { WebSocketServer, WebSocket: NodeSocket } = createRequire(path.join(serverDir, 'package.json'))('ws');
let standMain = null;
const stand = { plain: 0, flagged: 0 };
const standin = new WebSocketServer({ port: STANDIN, host: '127.0.0.1' });
standin.on('connection', (c, req) => {
  const flagged = /[?&]nm=1(&|$)/.test(req.url);
  if (flagged) stand.flagged++; else stand.plain++;
  c.on('error', () => {});
  if (!flagged && standMain) { c.send(JSON.stringify({ t: 'main', u: standMain })); c.close(4010, 'main'); return; }
  const to = new NodeSocket(`ws://127.0.0.1:${BACKUP}${req.url}`, { origin: req.headers.origin });
  const early = [];
  to.on('open', () => { for (const [d, b] of early) to.send(d, { binary: b }); early.length = 0; });
  c.on('message', (d, b) => (to.readyState === 1 ? to.send(d, { binary: b }) : early.push([d, b])));
  to.on('message', (d, b) => c.send(d, { binary: b }));
  to.on('close', () => c.close());
  to.on('error', () => c.close());
  c.on('close', () => to.close());
});

let home = startHome(MAIN1);
const backup = spawn(path.join(serverDir, 'node_modules', '.bin', 'wrangler'),
  ['dev', '--port', String(BACKUP), '--ip', '127.0.0.1', '--persist-to', path.join(tmp, 'backup'), '--show-interactive-dev-session=false'],
  { cwd: serverDir, detached: true, stdio: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
backup.detached = true;
kids.push(backup);

let t = null;
const others = [];
try {
  if (!(await up(MAIN1)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  const query = `q=low&net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}&netprobe=3`;
  const viaStandin = query.replace(String(BACKUP), String(STANDIN));
  // Another browser: started, with its sockets' ports recorded.
  const visitor = async (q) => {
    const v = await boot({ start: false, query: q, width: 480, height: 270 });
    others.push(v);
    v.ports = [];
    v.page.on('websocket', (ws) => v.ports.push(new URL(ws.url()).port));
    v.net = () => v.page.evaluate(() => window.__game.net());
    v.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await v.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
    await v.page.evaluate(() => window.__game.start());
    return v;
  };
  const leave = async (v) => { others.splice(others.indexOf(v), 1); await v.close(); };
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

  // 5. Main comes back while the page is online on the backup: it moves over by itself, and whoever is on main sees it arrive.
  await sleep(5000);
  n = await net();
  check(n.status === 'online' && n.home === 'backup' && n.moves === 0, 'while main is down the page stays on the backup (its background tries find nothing)', say(n) + `, ${n.probes} background tries`);
  home = startHome(MAIN1);
  await up(MAIN1);
  mainNow = `http://127.0.0.1:${MAIN1}`;
  const t0 = Date.now();
  n = await until((x) => x.status === 'online' && x.home === 'main', 20000);
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  check(!!n && n.moves === 1 && n.service === 0 && sockets.at(-1) === String(MAIN1), 'main back: the page on the backup moves to main by itself', say(n) + `, ${took} s after main came up (tries every 3 to 4 s here, 2 to 2.5 min live)`);
  let v = await visitor(query);
  let m = await v.until((x) => x.status === 'online' && x.count === 2);
  n = await until((x) => x.count === 2, 10000);
  check(!!m && m.home === 'main' && !!n && n.remotes.some((r) => r.id === m.id) && m.remotes.some((r) => r.id === n.id), 'and it is in the same town as a newcomer on main: each sees the other', `newcomer ${v.ports.join()}; ` + say(m));
  await leave(v);
  // The other way round: somebody is already on main and sees the mover arrive.
  await stop(home);
  mainNow = null;
  n = await until((x) => x.status === 'online' && x.home === 'backup');
  await sleep(5000);                                 // a background try fails and the lookup says "no main": nothing left to try
  home = startHome(MAIN1);
  await up(MAIN1);
  const seen = [];
  const watcher = new NodeSocket(`ws://127.0.0.1:${MAIN1}/?v=3&name=1.2`, { origin: 'http://localhost:5173' });
  watcher.on('message', (d, b) => { if (!b) seen.push(JSON.parse(String(d))); });
  watcher.on('error', () => {});
  for (let i = 0; i < 50 && !seen.some((x) => x.t === 'welcome'); i++) await sleep(100);
  mainNow = `http://127.0.0.1:${MAIN1}`;             // only now can the page learn that main is back
  n = await until((x) => x.status === 'online' && x.home === 'main' && x.count === 2, 20000);
  await sleep(300);
  const hello = seen.find((x) => x.t === 'welcome');
  check(!!n && n.moves === 2 && !!hello && hello.players.length === 1 && seen.some((x) => x.t === 'join' && x.id === n.id) && n.remotes.some((r) => r.id === hello.id),
    'a player already on main sees the mover arrive from the backup, and the mover sees that player', say(n) + `; the player on main heard ${seen.map((x) => x.t).join()}`);
  watcher.close();

  // 5b. The next visit: main from memory.
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await t.page.evaluate(() => window.__game.start());
  n = await until((x) => x.status === 'online');
  check(!!n && n.home === 'main' && n.attempts === 1, 'after the move the next visit goes straight to main', say(n));

  // 5c. Two browsers opened together, nothing remembered: both land on main, in one town.
  {
    const [a, b] = await Promise.all([visitor(query), visitor(query)]);
    const [x, y] = await Promise.all([a.until((k) => k.status === 'online' && k.count === 3), b.until((k) => k.status === 'online' && k.count === 3)]);
    check(!!x && !!y && x.home === 'main' && y.home === 'main' && !a.ports.includes(String(BACKUP)) && !b.ports.includes(String(BACKUP)) && x.remotes.some((r) => r.id === y.id) && y.remotes.some((r) => r.id === x.id),
      'two browsers opened together both land on main and see each other; neither touched the backup', `${say(x)} | ${say(y)}; sockets ${a.ports.join()} | ${b.ports.join()}`);
    await leave(a); await leave(b);
  }

  // 5d. The backup knows main is alive: a browser that reaches it without having tried main is sent there.
  {
    mainNow = null;                                  // the lookup is no help (as when it timed out on the live site)
    standMain = `http://127.0.0.1:${MAIN1}`;
    const s0 = { ...stand };
    v = await visitor(viaStandin);
    m = await v.until((x) => x.status === 'online');
    check(!!m && m.home === 'main' && m.redirects === 1 && m.count === 2 && v.ports.join() === `${STANDIN},${MAIN1}` && stand.plain - s0.plain === 1 && stand.flagged === s0.flagged,
      'redirect: the backup does not seat an unflagged browser, it sends it to main, and it joins the town there', `${say(m)}; sockets ${v.ports.join()}`);
    await leave(v);

    // ...and one that cannot reach main is seated on the backup when it says so, and is not sent round again.
    standMain = `http://127.0.0.1:${DEAD}`;
    const s1 = { ...stand };
    const t1 = Date.now();
    v = await visitor(viaStandin);
    m = await v.until((x) => x.status === 'online');
    const secs = ((Date.now() - t1) / 1000).toFixed(1);
    await sleep(3000);
    const m2 = await v.net();
    check(!!m && m.home === 'backup' && m.redirects === 1 && m2.status === 'online' && m2.id === m.id && stand.plain - s1.plain === 1 && stand.flagged - s1.flagged === 1 && v.ports.join() === `${STANDIN},${DEAD},${DEAD},${STANDIN}`,
      'main unreachable: sent to main, tried it twice, came back flagged, was seated on the backup and stayed', `${say(m)}; sockets ${v.ports.join()}; online ${secs} s after the page started`);
    await leave(v);
  }

  // 5e. Main is full (one seat here, taken): the browser waits for main. It never spills into the backup.
  {
    const small = startHome(MAIN3, { PC_SEATS: '1', PC_STATE: path.join(tmp, 'small') });
    await up(MAIN3);
    const filler = new NodeSocket(`ws://127.0.0.1:${MAIN3}/?v=3&name=1.2`, { origin: 'http://localhost:5173' });
    await new Promise((r) => { filler.once('message', r); filler.once('error', r); });
    mainNow = `http://127.0.0.1:${MAIN3}`;
    standMain = null;
    v = await visitor(query);
    m = await v.until((x) => x.status === 'full');
    await sleep(4000);
    let later = await v.net();
    check(!!m && m.home === 'main' && later.status === 'full' && later.home === 'main' && v.ports.join() === String(MAIN3), 'main full: the browser waits for main (town full notice) and does not go to the backup', `${say(later)}; sockets ${v.ports.join()}`);
    await leave(v);
    mainNow = null;
    standMain = `http://127.0.0.1:${MAIN3}`;
    const s2 = { ...stand };
    v = await visitor(viaStandin);
    m = await v.until((x) => x.status === 'full');
    await sleep(4000);
    later = await v.net();
    check(!!m && later.status === 'full' && later.home === 'main' && v.ports.join() === `${STANDIN},${MAIN3}` && stand.plain - s2.plain === 1 && stand.flagged === s2.flagged, 'the same when the backup sent it there: full main, no seat on the backup', `${say(later)}; sockets ${v.ports.join()}`);
    await leave(v);
    filler.close();
    await stop(small);
    standMain = null;
  }

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
  for (const v of others) await v.close().catch(() => {});
  for (const c of kids) await stop(c);
  for (const c of standin.clients) c.terminate();
  standin.close();
  lookup.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
