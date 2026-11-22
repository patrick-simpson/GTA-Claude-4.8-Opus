// Multiplayer stage 4, step 1: the same hour, the same weather and the same bridge for everyone in town. Headless
// browsers against LOCAL services.
//
//   node tools/net/facts.mjs              every check, and two pictures into shots/net/
//   node tools/net/facts.mjs --noshots
//
// It starts everything itself and stops it again, as tools/net/heli.mjs does: the Node home on 8851 is "main" (found
// through a lookup stand-in on 8852) and a second copy on 8853 is reached as a plain `?net=` address, which the game
// treats as the BACKUP. Never run two of these tests at once.
// Checks, on main: a browser alone in town is led by the town's clock and writes the bridge fact once; a second
// browser with LESS bridge of its own sees the town's, and keeps its own apart; nothing is sent while nothing changes;
// the host sets the hour and the weather and the guest follows (one fact each); a guest that sets them is put back and
// changes nobody; a guest's points reach the town (one Give) and its own progress; the host finishes a span and the
// guest sees it; a late joiner with MORE bridge of its own brings the town up to it and sees the town's hour and
// weather at once (two pictures); the host leaves and the next host carries hour, weather and bridge on without
// writing anything; a joiner after that sees them too, earns points, and its saved progress is its own; the service
// is stopped (the bridge on the screen stays) and started again (the facts are still there); the same browser loaded
// without the town shows its own bridge. On a backup style connection: the same hour and weather with nothing sent,
// the bridge each player's own.
// The test makes its own situations and says where it does:
//  - Each browser's own bridge is set with `?bridge=N` (which also stops that page saving it), except the one whose
//    saved progress is read, which starts fresh.
//  - WHO IS HOST is pinned as in police.mjs when it matters (a browser says it cannot host, as a hidden tab does).
//  - Points are earned with the game's own progress.add(), hour and weather set with the test hooks the cheats share.
// The pages run in real time at a fraction of full speed (no video card here); the town's clock is real time, so the
// hours are compared as read. Prints PASS or FAIL per check, with the facts on every line; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8851, LOOKUP = 8852, BACKUP = 8853;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-facts-'));
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
const viaBackup = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}`;
const open = [];
async function visitor(tag, query, size = [480, 270], again = false) {
  const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  // What this page sends, counted on the wire itself. Binary: by kind, and ToHost frames by what they ask ('4.10' is
  // a Give, '4.11' a Mine). Text: every fact written, whole.
  t.out = { n: {}, bytes: {} };
  t.facts = [];
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string') { if (p.includes('"fact"')) t.facts.push(p); return; }
    if (p.length === 0) return;
    const k = p[0] === 2 || p[0] === 4 || p[0] === 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  if (again) {
    await t.page.reload({ waitUntil: 'load' });
    await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  }
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.town = async () => (await t.net()).town;
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.setTime = (h) => t.page.evaluate((h) => window.__game.setTime(h), h);
  t.setWeather = (w) => t.page.evaluate((w) => window.__game.setWeather(w), w);
  t.earn = (p) => t.page.evaluate((p) => window.__game.progress.add(p), p);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const wire = (t, k, what = 'n') => t.out[what][k] ?? 0;
const f2 = (v) => v === null || v === undefined ? 'none' : (+v).toFixed(2);
/** Hours between two readings of a 24 hour clock. */
const apart = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** One line of everything a page knows about the town. */
const say = (t, w) => w ? `${t.tag}: ${w.host ? 'host' : 'guest'} on ${w.home || 'nothing'}, ${w.led ? 'led' : 'not led'}, hour ${f2(w.hour)} (town ${f2(w.townHour)}), ${w.weather} (town ${w.townWeather ?? 'none'}${w.forced ? ', forced' : ''}), clock fact ${w.clock}, bridge fact ${JSON.stringify(w.bridge)}, shown ${JSON.stringify(w.shown)}, own ${JSON.stringify(w.own)}${w.apart ? ' kept apart' : ''}, facts sent ${w.factsSent} (${w.factBytes} B) got ${w.factsGot}, gives ${w.gives} got ${w.givesGot}, claims ${w.claims} got ${w.claimsGot}` : `${t.tag}: no answer`;
const all = async (...ts) => (await Promise.all(ts.map(async (t) => say(t, await t.town())))).join(' || ');
/** Both pages read at one moment: the hours on the two screens, and how far apart they are. */
async function hours(a, b) {
  const [x, y] = await Promise.all([a.town(), b.town()]);
  return { x, y, gap: apart(x.hour, y.hour) };
}
/** Wait until the two screens show the same hour (within `tol` game hours) and the same weather. */
async function agree(a, b, ms = 30000, tol = 0.1) {
  let r = await hours(a, b);
  for (const end = Date.now() + ms; Date.now() < end && !(r.gap <= tol && r.x.weather === r.y.weather); r = await hours(a, b)) await sleep(300);
  return r;
}
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8852|request failed: ws/;

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];

  // ── 1. Alone in town on main ──
  const A = await visitor('A', `${viaMain}&bridge=3`, size);
  let n = await A.until((x) => x.status === 'online' && x.town.led && x.town.inTown && !!x.town.bridge);
  let a = n ? n.town : await A.town();
  check(!!n && n.home === 'main' && a.host, 'A is online on main, alone, and is the host', say(A, a));
  check(!!n && apart(a.hour, a.townHour) <= 0.06 && a.weather === a.townWeather, 'alone in town its sky is already the town\'s (hour and weather)', say(A, a));
  check(!!n && same(a.bridge, [3, 0, 0]) && same(a.shown, [3, 0, 0]) && A.facts.length === 1, 'and it has written the town\'s bridge once: its own 3 spans', `${say(A, a)}; on the wire: ${A.facts.join(' ') || 'nothing'}`);

  // ── 2. A second browser with less bridge of its own ──
  const B = await visitor('B', `${viaMain}&bridge=1`, size);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2 && x.town.led && !!x.town.bridge);
  let b = n ? n.town : await B.town();
  const ib = await B.info();
  check(!!n && !b.host && same(b.shown, [3, 0, 0]) && ib.spans === 3, 'B (1 span of its own) is shown the town\'s 3 spans', `${say(B, b)}; the game says ${ib.spans} spans`);
  check(!!n && same(b.own, [1, 0, 0]) && b.apart, 'and its own 1 span is kept apart, untouched', say(B, b));
  let r = await agree(A, B);
  check(r.gap <= 0.1 && r.x.weather === r.y.weather, 'A and B show the same hour and the same weather', `${f2(r.gap)} game hours apart; ${say(A, r.x)} || ${say(B, r.y)}`);
  check(B.facts.length === 0 && wire(B, '4.10') + wire(B, '4.11') === 0, 'B has sent nothing about any of it (no fact, no Give, no Mine)', `facts ${B.facts.length}, Give ${wire(B, '4.10')}, Mine ${wire(B, '4.11')}`);

  // ── 3. Nothing changes, nothing is sent ──
  {
    const fa = A.facts.length, fb = B.facts.length, ga = wire(A, '4.10') + wire(A, '4.11'), gb = wire(B, '4.10') + wire(B, '4.11');
    const [a0, b0] = await Promise.all([A.town(), B.town()]);
    await sleep(12000);
    const [a1, b1] = await Promise.all([A.town(), B.town()]);
    const sent = A.facts.length - fa + B.facts.length - fb + wire(A, '4.10') + wire(A, '4.11') - ga + wire(B, '4.10') + wire(B, '4.11') - gb;
    check(sent === 0 && a1.factsGot === a0.factsGot && b1.factsGot === b0.factsGot, '12 s with nothing changing: no fact, Give or Mine from either', `sent ${sent}; facts heard A ${a1.factsGot - a0.factsGot}, B ${b1.factsGot - b0.factsGot}`);
    const moved = apart(a1.hour, a0.hour);
    check(moved > 0.12 && moved < 0.4 && apart(b1.hour, b0.hour) > 0.12, 'yet the hour has moved on by itself on both (about 0.2 game hours in 12 s)', `A ${f2(a0.hour)} to ${f2(a1.hour)}, B ${f2(b0.hour)} to ${f2(b1.hour)}`);
  }

  // ── 4. The host sets the hour and the weather ──
  {
    const f0 = A.facts.length;
    const t0 = Date.now();
    await A.setTime(18.25);
    await sleep(1000);
    r = await agree(A, B, 90000);
    // (The town's clock keeps running: a real minute is a game hour.)
    const due = 18.25 + (Date.now() - t0) / 60000;
    check(r.gap <= 0.1 && apart(r.x.hour, due) <= 0.15 && r.y.clock === r.x.clock, 'the host sets a quarter past six in the evening: the guest follows', `due ${f2(due)}; ${f2(r.gap)} apart; ${say(A, r.x)} || ${say(B, r.y)}`);
    const want = r.x.weather === 'rain' ? 'overcast' : 'rain';
    await A.setWeather(want);
    n = await B.until((x) => x.town.weather === want, 30000);
    r = await hours(A, B);
    check(!!n && r.x.weather === want && r.y.weather === want && r.y.forced === want, `the host asks for ${want}: the guest has it too`, `${say(A, r.x)} || ${say(B, r.y)}`);
    const mine = A.facts.slice(f0);
    check(mine.length === 2 && B.facts.length === 0, 'that cost two facts from the host and nothing from the guest', `${mine.join(' ')} (${mine.reduce((s, x) => s + x.length, 0)} bytes)`);

    // A guest cannot change the town.
    const before = await hours(A, B);
    await B.setTime(3);
    await B.setWeather(want === 'rain' ? 'clear' : 'rain');
    await sleep(2500);
    r = await agree(A, B, 90000);
    check(r.gap <= 0.1 && apart(r.x.hour, 3) > 2 && r.y.weather === want && r.x.weather === want && B.facts.length === 0, 'a guest that sets the hour and the weather is put back, and changes nobody', `before ${f2(before.x.hour)}; ${f2(r.gap)} apart; ${say(A, r.x)} || ${say(B, r.y)}`);
  }

  // ── 5. Points: a guest's reach the town; the host finishes a span ──
  {
    const g0 = wire(B, '4.10');
    await B.earn(30);
    b = await B.town();
    check(same(b.shown, [3, 0, 30]) && same(b.own, [1, 0, 30]), 'a guest earns 30 points: on its own screen at once, and on its own progress', say(B, b));
    n = await A.until((x) => same(x.town.shown, [3, 0, 30]), 20000);
    const nb = await B.until((x) => same(x.town.bridge, [3, 0, 30]), 20000);
    a = await A.town();
    check(!!n && !!nb && same(a.own, [3, 0, 0]) && wire(B, '4.10') - g0 === 1, 'the host counts them for the town (one Give, 7 bytes), writes the fact, and its own progress is not touched', `${await all(A, B)}; Gives ${wire(B, '4.10') - g0}, ${wire(B, '4.10', 'bytes')} bytes`);
    await A.earn(520);
    n = await B.until((x) => same(x.town.shown, [4, 0, 0]), 20000);
    const [ia, ib2] = await Promise.all([A.info(), B.info()]);
    [a, b] = await Promise.all([A.town(), B.town()]);
    check(!!n && same(a.shown, [4, 0, 0]) && ia.spans === 4 && ib2.spans === 4, 'the host earns the rest of span 4: the span is built on both screens', `${say(A, a)} || ${say(B, b)}; the games say ${ia.spans} and ${ib2.spans} spans`);
    check(same(b.own, [1, 0, 30]) && same(a.own, [3, 0, 520]), 'each player\'s own progress has only what that player earned', `A own ${JSON.stringify(a.own)}, B own ${JSON.stringify(b.own)}`);
  }

  // ── 6. A late joiner with MORE bridge of its own ──
  // (The pictures want evening rain, whatever the time of the run. Asked for BEFORE C arrives, so that C has them
  // from its welcome and not from a fact heard later, which would be a slow change of weather on its screen.)
  await A.setTime(18.25); await A.setWeather('rain');
  await sleep(1500);
  const C = await visitor('C', `${viaMain}&bridge=6`, size);
  {
    await C.pin(true);
    n = await C.until((x) => x.status === 'online' && x.count === 3 && x.town.led, 60000);
    let c = n ? n.town : await C.town();
    r = await agree(A, C, 20000);
    check(!!n && r.gap <= 0.1 && r.y.weather === 'rain' && r.x.weather === 'rain', 'C joins later: it has the town\'s hour and weather from its welcome', `${f2(r.gap)} apart; ${say(A, r.x)} || ${say(C, r.y)}`);
    n = await A.until((x) => same(x.town.shown, [6, 0, 0]), 30000);
    const nb = await B.until((x) => same(x.town.shown, [6, 0, 0]), 20000);
    c = await C.town();
    const [ia, ib2, ic] = await Promise.all([A.info(), B.info(), C.info()]);
    check(!!n && !!nb && same(c.shown, [6, 0, 0]) && ia.spans === 6 && ib2.spans === 6 && ic.spans === 6, 'C has 6 spans of its own: the town takes them up, and all three screens have 6', `${await all(A, B, C)}; Mines from C ${wire(C, '4.11')} (${wire(C, '4.11', 'bytes')} bytes)`);
    b = await B.town();
    check(same(b.own, [1, 0, 30]) && same(c.own, [6, 0, 0]) && wire(C, '4.11') >= 1 && wire(C, '4.11') <= 2 && C.facts.length === 0, 'B\'s own progress is still its own; C asked the host with a Mine and wrote no fact', `B own ${JSON.stringify(b.own)}, C own ${JSON.stringify(c.own)}, Mines ${wire(C, '4.11')}`);

    if (SHOTS) {
      // The same view of the bridge on the host and on the late joiner: six new spans, evening, rain.
      const view = [170, 34, -720, -70, 8, -900];
      for (const t of [A, C]) { await t.page.evaluate((x) => window.__game.teleport(x, -430, Math.PI), t === A ? -33 : -27); await t.page.evaluate((v) => window.__game.view(...v), view); }
      await sleep(20000);
      r = await agree(A, C, 10000);
      await Promise.all([A.shot('shots/net/facts-host.png'), C.shot('shots/net/facts-guest.png')]);
      check(r.gap <= 0.1 && r.x.weather === r.y.weather, 'pictures: shots/net/facts-host.png and facts-guest.png (the same bridge, hour and weather)', `${f2(r.gap)} apart; ${say(A, r.x)} || ${say(C, r.y)}`);
      for (const t of [A, C]) await t.page.evaluate(() => window.__game.view());
    }
  }

  // ── 7. The host leaves ──
  {
    const was = await hours(A, B);
    const errsA = A.errors.filter((e) => !NOISE.test(e));
    check(errsA.length === 0, 'no errors from the game on A', errsA.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await B.pin(false);
    await leave(A);
    n = await B.until((x) => x.town.host && x.count === 2, 60000);
    await sleep(4000);
    r = await agree(B, C, 20000);
    check(!!n && r.x.host && !r.y.host, 'A leaves: B is the host now', `${say(B, r.x)} || ${say(C, r.y)}`);
    check(r.gap <= 0.1 && r.x.weather === r.y.weather && r.x.clock === was.x.clock && apart(r.x.hour, r.x.townHour) <= 0.06, 'the town\'s hour and weather carry on, the same on both', `clock fact was ${was.x.clock}; ${f2(r.gap)} apart; ${say(B, r.x)} || ${say(C, r.y)}`);
    check(same(r.x.shown, [6, 0, 0]) && same(r.y.shown, [6, 0, 0]) && same(r.x.bridge, [6, 0, 0]) && B.facts.length === 0, 'the bridge is still the town\'s 6 spans, and the new host had nothing to write', `${say(B, r.x)}; facts from B ${B.facts.length}`);
    await B.earn(10);
    n = await C.until((x) => same(x.town.shown, [6, 0, 10]), 20000);
    check(!!n && B.facts.length === 1, 'the new host earns 10 points: the guest sees them (one fact)', `${await all(B, C)}; ${B.facts.join(' ')}`);
  }

  // ── 8. A joiner after the host change, with nothing of its own; what is saved is its own ──
  const D = await visitor('D', `${viaMain}&netprobe=3`, size);
  {
    await D.pin(true);
    n = await D.until((x) => x.status === 'online' && x.count === 3 && x.town.led && !!x.town.bridge, 60000);
    let d = n ? n.town : await D.town();
    r = await agree(B, D, 20000);
    const id = await D.info();
    check(!!n && same(d.shown, [6, 0, 10]) && id.spans === 6 && same(d.own, [0, 0, 0]) && r.gap <= 0.1 && r.x.weather === r.y.weather, 'D joins after the host change with no bridge of its own: it sees the town\'s 6 spans, hour and weather', `${f2(r.gap)} apart; ${say(B, r.x)} || ${say(D, r.y)}`);
    check(wire(D, '4.11') === 0 && D.facts.length === 0, 'and has nothing to say about it (no Mine, no fact)', `Mines ${wire(D, '4.11')}, facts ${D.facts.length}`);
    await D.earn(40);
    n = await B.until((x) => same(x.town.shown, [6, 0, 50]), 20000);
    const saved = await D.page.evaluate(() => { window.__game.progress.save(); return localStorage.getItem('portcalamity.progress.v1'); });
    d = await D.town();
    check(!!n && same(d.own, [0, 0, 40]) && same(d.shown, [6, 0, 50]) && same(JSON.parse(saved ?? '{}'), { spans: 0, stage: 0, bank: 40, total: 40 }), 'D earns 40: the town has 50 in the bank, D\'s own progress has 40, and what its browser saves is its own', `${say(D, d)}; saved: ${saved}`);
    n = await C.until((x) => same(x.town.bridge, [6, 0, 50]), 20000);
    check(!!n, 'the fact with the 50 reaches the other guest', await all(C));
    const errs = [...B.errors, ...C.errors].filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on B or C', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await D.pin(false);
    await leave(B); await leave(C);
  }

  // ── 9. The service stops and starts again ──
  {
    n = await D.until((x) => x.town.host && x.count <= 1, 30000);
    const was = await D.town();
    await sleep(6000);
    await stop(home);
    // (With main gone the game falls back to the backup, as it would for a visitor.)
    n = await D.until((x) => x.status !== 'online' || x.home !== 'main', 30000);
    await sleep(4000);
    let d = await D.town();
    const id = await D.info();
    check(!!n && same(d.shown, [6, 0, 50]) && id.spans === 6 && !d.inTown && d.bridge === null && same(d.own, [0, 0, 40]), 'main stops: D plays on (on the backup or alone), and the bridge on its screen stays (6 spans)', say(D, d));
    let stored = {};
    try { stored = JSON.parse(readFileSync(path.join(tmp, 'main', 'facts.json'), 'utf8')); } catch { /* reported below */ }
    check(same(stored.bridge, [6, 0, 50]) && stored.clock === was.clock && Array.isArray(stored['weather.seed']), 'the service has kept the town\'s facts on disk', JSON.stringify(stored));
    const f0 = D.facts.length;
    home = startHome(MAIN, 'main');
    await up(MAIN);
    n = await D.until((x) => x.status === 'online' && x.home === 'main' && x.town.led && x.town.inTown && !!x.town.bridge, 180000, 500);
    await sleep(3000);
    d = await D.town();
    check(!!n && n.home === 'main' && same(d.bridge, [6, 0, 50]) && same(d.shown, [6, 0, 50]) && d.clock === was.clock && apart(d.hour, d.townHour) <= 0.06, 'it starts again: D is back in town with the same bridge and the same clock', `clock fact was ${was.clock}; ${say(D, d)}`);
    check(D.facts.length === f0, 'and writes nothing on coming back', `facts ${D.facts.length - f0}`);
  }

  // ── 10. Alone again: the same browser without the town ──
  {
    const errs = D.errors.filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on D', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    D.errors.length = 0;
    await D.page.goto(`${new URL(D.url).origin}/?q=low&net=0`, { waitUntil: 'load' });
    await D.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
    await D.page.evaluate(() => window.__game.start());
    await sleep(3000);
    const [d, id] = await Promise.all([D.town(), D.info()]);
    check(same(d.shown, [0, 0, 40]) && id.spans === 0 && !d.apart && !d.led, 'loaded again without the town, D has its own bridge: no new spans, its own 40 points', `${say(D, d)}; the game says ${id.spans} spans`);
    const h0 = d.hour;
    await D.setTime(12);
    await sleep(1500);
    const d2 = await D.town();
    check(apart(d2.hour, 12) < 0.2, 'and alone the hour is its own to set', `${f2(h0)} to ${f2(d2.hour)}`);
    check(D.errors.length === 0, 'no errors alone', D.errors.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await leave(D);
  }

  // ── 11. A backup style connection ──
  {
    const E = await visitor('E', `${viaBackup}&bridge=2`, [480, 270], true), F = await visitor('F', `${viaBackup}&bridge=5`, [480, 270], true);
    await F.pin(true);
    let ne = await E.until((x) => x.status === 'online' && x.count === 2 && x.town.led && x.town.host, 60000), nf = await F.until((x) => x.status === 'online' && x.count === 2 && x.town.led);
    check(!!ne && !!nf && ne.home === 'backup' && nf.home === 'backup', 'two browsers on a backup style connection', ne && nf ? `${ne.home}, ${nf.home}` : 'timed out');
    r = await agree(E, F, 20000);
    check(r.gap <= 0.1 && r.x.weather === r.y.weather && r.x.led && r.y.led, 'on the backup they show the same hour and the same weather', `${f2(r.gap)} apart; ${say(E, r.x)} || ${say(F, r.y)}`);
    const [ie, iff] = await Promise.all([E.info(), F.info()]);
    check(same(r.x.shown, [2, 0, 0]) && same(r.y.shown, [5, 0, 0]) && ie.spans === 2 && iff.spans === 5 && !r.x.inTown && !r.y.inTown && !r.x.apart && !r.y.apart && r.x.bridge === null, 'the bridge there is each player\'s own (2 spans and 5)', `${say(E, r.x)} || ${say(F, r.y)}`);
    await E.earn(30);
    await sleep(8000);
    const kinds = [...new Set([...Object.keys(E.out.n), ...Object.keys(F.out.n)])];
    check(kinds.every((k) => k === '0' || k === '1' || k === '3') && E.facts.length + F.facts.length === 0, 'and nothing about hour, weather or bridge is sent there, points earned or not', `kinds on the wire: ${kinds.join(', ') || 'none'} (0 keepalive, 1 state, 3 event); facts ${E.facts.length + F.facts.length}`);
    const H = E, G = F;
    const t0 = Date.now();
    await H.setTime(7);
    await sleep(1000);
    r = await agree(H, G, 90000);
    const due = 7 + (Date.now() - t0) / 60000;
    check(apart(r.x.hour, due) <= 0.15 && r.gap <= 0.1 && H.facts.length === 1 && G.facts.length === 0, 'the backup\'s host sets seven in the morning: the other follows (one fact)', `${f2(r.gap)} apart; ${say(H, r.x)} || ${say(G, r.y)}; ${H.facts.join(' ')}`);
    const errs2 = [...E.errors, ...F.errors].filter((e) => !NOISE.test(e));
    check(errs2.length === 0, 'no errors on the backup pages', errs2.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
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
