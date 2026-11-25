// Fun queue 2, item 18: the street race builder, between players. Headless browsers against LOCAL services (free ports; never
// the live town).
//
//   node tools/net/builder.mjs [--noshots]
//
// A is the host; B (and later C) are pinned hidden, so they say they cannot host.
//  1. A publishes a race it built: the host keeps it in the town facts (rb.0), and B, who arrives afterwards, sees it in
//     Town Races from the welcome.
//  2. Forged and broken publishes from B (a pin in the sea, an out of range name, 9 laps, two pins, a cell off the map,
//     a flood) are all refused by the host: the list stays as it was.
//  3. A calls the built race at its start line; B is invited, joins, both race and finish; the host writes the town best
//     into the race's fact and both pages show it.
// Pictures in shots/built-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8861, LOOKUP = 8862, BACKUP = 8863;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-built-'));
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
  t.race = () => t.page.evaluate(() => window.__game.game.todo.racing.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.rwait = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.race(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.prompt = () => t.page.evaluate(() => window.__game.game.todo.racing.prompt);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `built-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
/** In a fresh car at (x, z), facing h, standing still. */
const carAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; G.teleport(x, z, h); const v = g.vehicles.spawn('sedan', x, z, h); g.player.enter(v, true); g.cam.snap(); return !!g.player.vehicle; }, [x, z, h]);
const routeOf = (t, name) => t.page.evaluate((name) => { const r = window.__game.game.todo.jobs.races.find((x) => x.name === name); return r ? { idx: r.idx, start: r.start, first: r.cps[0], laps: r.laps, n: r.cps.length, par: r.par } : null; }, name);
/** Drive along the race path at `speed` m/s, `side` meters right of the line, once GO is given (the page's own timer). */
const drive = (t, speed, side) => t.page.evaluate(([speed, side]) => {
  const g = window.__game.game, R = g.todo.racing;
  let pts = null, seg = 0, along = 0, last = performance.now();
  const id = setInterval(() => {
    const v = g.player.vehicle;
    if (!v) return;
    if (R.phase !== 'race') { last = performance.now(); if (['done', 'podium', 'idle'].includes(R.phase)) clearInterval(id); return; }
    if (!pts) pts = R.path();
    const now = performance.now();
    let d = speed * (now - last) / 1000; last = now;
    while (d > 0 && seg < pts.length - 1) {
      const a = pts[seg], b = pts[seg + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (along + d < L) { along += d; d = 0; } else { d -= L - along; along = 0; seg++; }
    }
    if (seg >= pts.length - 1) { seg = pts.length - 2; along = Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].z - pts[seg].z); }
    const a = pts[seg], b = pts[seg + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1, k = along / L, dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
    v.x = a.x + (b.x - a.x) * k + dz * side; v.z = a.z + (b.z - a.z) * k - dx * side; v.h = Math.atan2(dx, dz);
    v.vx = dx * speed * 0.2; v.vz = dz * speed * 0.2; v.vy = 0;
  }, 25);
  return true;
}, [speed, side]);
function fmtMs(ms) { const t = Math.round(ms / 100), m = Math.floor(t / 600), s = (t % 600) / 10; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; }
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const cellOf = (x, z) => [Math.round((x + 1100) / 4), Math.round((z + 3100) / 4)];
const sendRaw = (t, kind, o) => t.page.evaluate(async ([kind, o]) => {
  const P = await import('/src/net/protocol.ts');
  const g = window.__game.game;
  if (kind === 'frame') return g.net.conn.send(P.encodeBuilt(o));
  // a hand made frame: header, name, laps, flags, n, cells (any values, as a forger would send them)
  const n = o.cells.length >> 1, buf = P.makeFrame(P.Frame.Event, 9 + 4 * n - P.FRAME_HEADER_BYTES), d = new DataView(buf), u = new Uint8Array(buf);
  u[2] = P.PlayerEvent.Built; u[3] = 1; d.setUint16(4, o.name, true); u[6] = o.laps; u[7] = o.back ? 1 : 0; u[8] = n;
  o.cells.forEach((c, i) => d.setUint16(9 + 2 * i, c, true));
  return g.net.conn.send(buf);
}, [kind, o]);

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const strand = await A.page.evaluate(() => { const r = window.__game.game.todo.jobs.races.find((x) => x.name === 'Strand Sprint'); return r.cps.map((p) => ({ x: p.x, z: p.z })); });
  const pins = strand.slice(0, 3);
  const spec = { name: 777, laps: 1, back: false, cells: pins.flatMap((p) => cellOf(p.x, p.z)) };
  const specText = await A.page.evaluate((s) => { const r = window.__game.game.todo.raceBuilder; const b = r.build(s); return typeof b === 'string' ? b : `${Math.round(b.length)} m`; }, spec);
  check(/ m$/.test(specText), 'A builds a three checkpoint race on the island', specText);

  // ── 1. Publish, and a late joiner sees it ──
  {
    const why = await A.page.evaluate((s) => window.__game.game.todo.raceBuilder.publish(s), spec);
    check(why === null, 'A publishes it (host: kept at once)', String(why));
    const a = await wait(async () => { const x = await A.net(); return x.built.slots[0] ? x : null; }, 6000);
    check(!!a && a.built.accepted === 1 && a.built.written === 1, 'the host keeps it in a town fact (rb.0)', a ? JSON.stringify(a.built.slots[0]) : 'no');
    const again = await A.page.evaluate((s) => window.__game.game.todo.raceBuilder.publish(s), spec);
    check(/Wait \d+ s/.test(String(again)), 'publishing again at once is held back (rate limit)', String(again));
    const B = await visitor('B', [960, 540]);
    await B.pin(true);
    await B.until((x) => x.status === 'online' && x.count === 2, 60000);
    const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net()]); return ns[0].traffic.mode === 'host' && ns[1].traffic.mode === 'guest' ? ns : null; }, 60000);
    check(!!roles, 'B arrives as a guest');
    const bt = await wait(() => B.page.evaluate(() => { const r = window.__game.game.todo.raceBuilder; const e = r.link.entries(); const d = r.all([]).find((x) => x.idx === 64); return e.length === 1 && e[0].slot === 0 && d ? { name: d.name, laps: d.laps } : null; }), 15000);
    check(!!bt, 'B sees it in Town Races from the welcome, and has it as route 64', JSON.stringify(bt));
    await B.page.evaluate(() => { const g = window.__game.game; g.setPaused(true); g.todo.menu.setTab(0); });
    await sleep(600);
    await B.page.click('.rb-tab');
    await B.page.click('[data-page="town"]');
    await B.page.click('.rb [data-i="0"]');
    await sleep(500);
    await B.shot('town-races');
    const list = await B.page.evaluate(() => document.querySelector('.rb-list')?.innerText ?? '');
    check(/Town Races/.test(await B.page.evaluate(() => document.querySelector('.rb-pages')?.innerText ?? '')) && /checkpoints/.test(list), 'the Town Races list shows it with its length and checkpoints', list.replace(/\n/g, ' | ').slice(0, 200));
    await B.page.evaluate(() => { window.__game.game.setPaused(false); });

    // ── 2. Forgeries ──
    const before = await A.net();
    const sea = [cellOf(-1000, 300), cellOf(-1000, 330), cellOf(-1000, 360)].flat();
    const ok1 = [
      await sendRaw(B, 'raw', { name: 5, laps: 1, back: false, cells: sea }),
      await sendRaw(B, 'raw', { name: 3000, laps: 1, back: false, cells: spec.cells }),
      await sendRaw(B, 'raw', { name: 5, laps: 9, back: false, cells: spec.cells }),
      await sendRaw(B, 'raw', { name: 5, laps: 1, back: false, cells: spec.cells.slice(0, 4) }),
      await sendRaw(B, 'raw', { name: 5, laps: 1, back: false, cells: [5000, 5000, 5001, 5001, 5002, 5002] }),
      await sendRaw(B, 'raw', { name: 6, laps: 2, back: false, cells: spec.cells }),
      await sendRaw(B, 'raw', { name: 7, laps: 1, back: false, cells: spec.cells.map((c) => (c + 400) % 2048) }),
    ];
    await sleep(1500);
    const after = await A.net();
    check(ok1.every(Boolean) && after.built.slots.filter(Boolean).length === 1 && after.built.accepted === before.built.accepted, 'seven forged or broken publishes from B: none kept', `sent ${ok1.filter(Boolean).length}, slots ${after.built.slots.filter(Boolean).length}, accepted ${after.built.accepted}`);
    check(after.built.refused >= before.built.refused + 6, 'the host counted them as refused', `refused ${before.built.refused} -> ${after.built.refused}; last: ${after.built.why}`);
    const bnow = await B.net();
    check(bnow.built.slots.filter(Boolean).length === 1 && bnow.built.heard === 0, 'B has no forged race either', JSON.stringify({ slots: bnow.built.slots.filter(Boolean).length, heard: bnow.built.heard }));
    // a good one gets in, then a flood is held back
    const good2 = { name: 12, laps: 1, back: true, cells: [...cellOf(strand[1].x, strand[1].z), ...cellOf(strand[2].x, strand[2].z), ...cellOf(strand[0].x, strand[0].z)] };
    const sent2 = await sendRaw(B, 'frame', good2);
    const a2 = await wait(async () => { const x = await A.net(); return x.built.accepted === 2 ? x : null; }, 6000);
    check(sent2 && !!a2, 'a real publish from B is kept (host checked it, wrote the second half of rb.0)', a2 ? JSON.stringify(a2.built.slots.map((s) => s && s.name)) : 'no');
    const sent3 = await sendRaw(B, 'frame', { ...good2, name: 13 });
    await sleep(1200);
    const a3 = await A.net();
    check(sent3 && a3.built.accepted === 2 && a3.built.limited >= 1, 'a second publish from B within 30 s is held back by the host', JSON.stringify({ accepted: a3.built.accepted, limited: a3.built.limited }));

    // ── 3. Call the built race ──
    const R = await A.page.evaluate(() => { const r = window.__game.game.todo.racing.def(64); return r ? { idx: r.idx, name: r.name, start: r.start, dir: r.dir, par: r.par, cps: r.cps.length, laps: r.laps } : null; });
    check(!!R && R.idx === 64, 'the built race is route 64 on the host', JSON.stringify(R && { idx: R.idx, name: R.name, cps: R.cps, par: R.par }));
    const h0 = Math.atan2(R.dir.x, R.dir.z);
    await calm(A); await calm(B);
    await carAt(A, R.start.x, R.start.z, h0);
    await carAt(B, R.start.x - 90 * Math.cos(h0), R.start.z + 90 * Math.sin(h0), h0);
    await sleep(2000);
    const pr = await A.prompt();
    check(!!pr && pr.startsWith(`[G] Call a race: "${R.name}"`), 'with B in town, the start line says "[G] Call a race"', pr);
    await A.shot('start-line');
    await A.key('KeyG');
    const binv = await B.rwait((r) => r.invites.length === 1, 6000);
    check(!!binv, 'B is invited to the built race', binv ? JSON.stringify(binv.invites) : 'no');
    await carAt(B, R.start.x + 6 * Math.cos(h0), R.start.z - 6 * Math.sin(h0), h0);
    const bj = await B.rwait((r) => r.phase === 'joined', 6000);
    const a3r = await A.rwait((r) => r.racers.length === 2, 6000);
    check(!!bj && !!a3r, 'B drove to the line and joined', a3r ? a3r.racers.map((r) => r.name).join(', ') : 'no');
    await A.key('KeyG');
    const grids = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'grid', 5000)));
    check(grids.every(Boolean), 'the grid on both screens');
    await sleep(4300);
    await Promise.all([drive(A, 40, -2), drive(B, 33, 2)]);
    const go = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'race', 8000)));
    check(go.every(Boolean), 'GO on both screens');
    await sleep(6000);
    await B.shot('running');
    const ends = await Promise.all([A, B].map((t) => t.rwait((r) => r.phase === 'podium', 120000, 500)));
    check(ends.every(Boolean), 'both finish: the podium on both screens');
    const res = ends.map((e) => e ? e.results.map((r) => `${r.place}.${r.id}:${r.total}`).join(' ') : '');
    check(!!res[0] && res[0] === res[1], 'the same order and times on both', res[0]);
    await A.shot('podium');
    const winner = ends[0].results[0];
    const bestA = await wait(async () => { const x = await A.net(); const s = x.built.slots[0]; return s && s.best > 0 ? x : null; }, 8000);
    const bestB = await wait(async () => { const x = await B.net(); const s = x.built.slots[0]; return s && s.best > 0 ? x : null; }, 8000);
    check(!!bestA && !!bestB && Math.abs(bestA.built.slots[0].best * 100 - winner.total) < 101 && bestA.built.slots[0].best === bestB.built.slots[0].best, 'the town best was written into the race fact, and both pages have it', bestA ? `best ${bestA.built.slots[0].best} tenths vs ${winner.total} ms` : 'no');
    const rec = await B.page.evaluate(() => { const r = window.__game.game.net.race.record(64); return r ? { race: r.race, by: r.raceBy } : null; });
    check(!!rec && rec.by === winner.name, 'the record shows who holds it', JSON.stringify(rec));
    const mine = await A.page.evaluate(() => { const r = window.__game.game.todo.raceBuilder, d = r.all([]).find((x) => x.idx === 64); return d ? r.best(d) : null; });
    check(mine > 0, 'A has its own best time for it locally', String(mine));
    const errs = [A, B].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on either page', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
