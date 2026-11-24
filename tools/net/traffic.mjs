// Multiplayer stage 2, step 1: the same moving traffic for everyone. Headless browsers against LOCAL services.
//
//   node tools/net/traffic.mjs              every check, and two pictures into shots/net/
//   node tools/net/traffic.mjs --noshots
//
// It starts everything itself and stops it again:
//  - the Node home (server/home/main.ts) on port 8811, which is "main" (found through a lookup stand-in on 8812, as
//    tools/net/main.mjs does);
//  - a second copy on 8813 that the pages reach as a plain `?net=` address, which the game treats as the BACKUP. (The
//    game decides "main or backup" by how it found the service, not by what the service is, so this is the same code
//    path as the real Worker without needing wrangler.)
// Checks: host and guest see the same cars (same numbers, kinds, colours, positions) at the same crossing; a guest far
// from the host still has cars round it, out of the one budget; the guest's own car is stopped by a shared car; the
// host leaves and another browser takes the cars over; a browser that loses the service keeps them as private
// traffic; on a backup style connection no World frame is sent and traffic is private; messages and bytes for 30 s.
// The pages run in real time. There is no video card here, so frames are slow and the tolerances are distances.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8811, LOOKUP = 8812, BACKUP = 8813;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-traffic-'));
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
async function visitor(tag, query, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  // Every binary frame this page sends that is a World frame (first byte 2), counted on the wire itself.
  // World frames of any sort, and those of them that are traffic (since stage 2, step 3 a few are about the parked cars).
  t.worldOut = 0; t.trafficOut = 0;
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => { const p = f.payload; if (typeof p !== 'string' && p.length > 0 && p[0] === 2) { t.worldOut++; if (p[2] === 1) t.trafficOut++; } }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (cars, p, r) => cars.filter((c) => dist(c, p) < r);
/** Both ends read as close together in time as two pages allow. */
const both = (A, B) => Promise.all([A.net(), B.net(), A.info(), B.info()]);
/** Who is the host of these right now, and who are its guests? Null in the instant of a change. */
async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.traffic.mode === 'host');
  if (hi < 0 || ns.some((x, i) => i !== hi && (x.traffic.mode !== 'guest' || x.host !== ns[hi].id))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi) };
}
/** The host's list against a guest's: numbers in common, and how far apart the same car is on the two screens. */
function compare(h, g) {
  const byId = new Map(h.map((c) => [c.id, c]));
  let common = 0, worst = 0, worstStill = 0, wrong = 0;
  for (const c of g) {
    const o = byId.get(c.id);
    if (!o) continue;
    common++;
    if (o.kind !== c.kind || o.color !== c.color) wrong++;
    const d = dist(o, c);
    if (o.speed === 0 && c.speed === 0) worstStill = Math.max(worstStill, d); else worst = Math.max(worst, d);
  }
  return { common, worst: +worst.toFixed(2), worstStill: +worstStill.toFixed(2), wrong };
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. Alone on main: private traffic, nothing sent ──
  const A = await visitor('A', viaMain, SHOTS ? [960, 540] : [480, 270]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  await sleep(3000);
  n = await A.net();
  const alone = (await A.info()).traffic;
  check(n.traffic.mode === 'local' && n.traffic.framesSent === 0 && A.worldOut === 0 && alone > 0, 'alone on main: its own traffic, and no World frame sent', `mode ${n.traffic.mode}, ${alone} cars, ${A.worldOut} World frames`);

  // ── 2. B joins: A hosts, B shows A's cars ──
  const B = await visitor('B', viaMain, SHOTS ? [960, 540] : [480, 270]);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}, ${n.count} in town` : 'timed out');
  const spot = await A.info();
  await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  n = await B.until((x) => x.traffic.mode !== 'local' && x.traffic.cars.length >= 3, 30000);
  // (The service gives the job to whichever browser draws faster, and may move it at any time: on a machine with no
  // video card it does. So every check below asks who the host is at that moment.)
  let r = await roles([A, B]);
  check(!!r, 'one of the two is the host and the other its guest', r ? `${r.host.tag} hosts (player ${r.hn.id}), ${r.guests[0].tag} is a guest` : 'no host');
  let gi = await r.guests[0].info();
  check(gi.traffic === r.gn[0].traffic.cars.filter((c) => c.driver === 'ai').length, 'the guest drives no traffic of its own: every moving car it has is one of the host\'s', `${gi.traffic} cars with a driver, ${r.gn[0].traffic.cars.length} shared`);
  check(r.hn.traffic.cars.length <= alone + 2 && r.hn.traffic.cars.length <= 24, 'no more cars in total than a single player game has', `${r.hn.traffic.cars.length} shared, ${alone} when A was alone`);

  // The same crossing, several looks: the same numbers, kinds and colours, and each car in the same place.
  await sleep(4000);
  let worst = 0, worstStill = 0, wrong = 0, missing = 0, looks = 0, seen = 0;
  for (let k = 0; k < 14; k++) {
    r = await roles([A, B]);
    if (!r) { await sleep(300); continue; }
    const c = compare(r.hn.traffic.cars, r.gn[0].traffic.cars);
    worst = Math.max(worst, c.worst); worstStill = Math.max(worstStill, c.worstStill); wrong += c.wrong;
    missing = Math.max(missing, Math.max(r.hn.traffic.cars.length, r.gn[0].traffic.cars.length) - c.common);
    seen = Math.max(seen, c.common); looks++;
    await sleep(400);
  }
  check(looks >= 8 && seen >= 3 && missing <= 2, 'host and guest have the same cars by number', `${seen} cars in common, at most ${missing} on one screen only at any look (${looks} looks)`);
  check(wrong === 0, 'the same model and colour on both screens', `${wrong} mismatches`);
  // (A moving car is drawn about 130 ms in the past on the guest, and the two pages are read a moment apart.)
  check(worst < 8 && worstStill < 0.3, 'each car is in the same place on both screens', `moving cars at most ${worst} m apart, standing cars ${worstStill} m`);

  // ── Pictures: the same crossing, the same moment, from both players' screens ──
  if (SHOTS) {
    // A crossing with cars at it: where one is waiting at the line, or failing that wherever one is nearest.
    let at = null;
    for (const end = Date.now() + 40000; Date.now() < end && !at;) {
      r = await roles([A, B]);
      const cars = r ? near(r.gn[0].traffic.cars, spot, 150) : [];
      at = cars.find((c) => c.speed === 0 && c.driver === 'ai' && near(cars, c, 30).length >= 2) ?? null;
      if (!at) await sleep(300);
    }
    at ??= near((await A.net()).traffic.cars, spot, 400).sort((p, q) => dist(p, spot) - dist(q, spot))[0] ?? spot;
    // Both players walk up to it, and both screens look at it from the same place above the corner.
    const s = Math.sin(at.h), co = Math.cos(at.h);
    await A.go(at.x + co * 7 + s * 4, at.z - s * 7 + co * 4, at.h);
    await B.go(at.x + co * 7 + s * 8, at.z - s * 7 + co * 8, at.h);
    const view = [at.x - s * 22 + co * 9, spot.y + 17, at.z - co * 22 - s * 9, at.x + s * 8, spot.y, at.z + co * 8];
    for (const t of [A, B]) await t.page.evaluate((v) => window.__game.view(...v), view);
    await sleep(2500);
    const shots = await Promise.all([A.shot('shots/net/traffic-a.png'), B.shot('shots/net/traffic-b.png')]);
    r = await roles([A, B]);
    console.log('shots', shots.join(' '), r ? `(${r.host.tag} was the host)` : '');
    for (const t of [A, B]) await t.page.evaluate(() => window.__game.view());
    await A.go(spot.x, spot.z, spot.h); await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  }

  // ── 3. Thirty seconds of an ordinary town: what it costs ──
  {
    // Playwright's ws 'framesent' counter sees only about half of the frames a page sends, so the wire is no judge of
    // the host's count. Instead the guest's own receive counter must reach 95% of what the host says it sent.
    const [a0, b0] = await both(A, B);
    await sleep(30000);
    const [a1, b1] = await both(A, B);
    const d = (k, f) => f(a1) - f(a0) + (k ? f(b1) - f(b0) : 0);
    const frames = d(1, (x) => x.traffic.framesSent), bytes = d(1, (x) => x.traffic.bytesSent), got = d(1, (x) => x.traffic.framesGot);
    const changes = d(1, (x) => x.traffic.takeovers);
    const sentM = d(1, (x) => x.sent.msgs), sentB = d(1, (x) => x.sent.bytes), gotM = d(1, (x) => x.got.msgs), gotB = d(1, (x) => x.got.bytes);
    const cars = Math.max(a1.traffic.cars.length, b1.traffic.cars.length);
    console.log(`  30 s, two players, ${cars} shared cars: ${frames} World frames, ${bytes} bytes sent by the host (${(bytes / 30).toFixed(0)} bytes/s, ${(bytes / Math.max(1, frames)).toFixed(0)} per frame, ${(frames / 30).toFixed(1)} frames/s); the host changed ${changes} time(s)`);
    console.log(`  everything, both players together: ${sentM} messages and ${sentB} bytes sent (${(sentM / 30).toFixed(1)} messages/s, ${(sentB / 30).toFixed(0)} bytes/s), ${gotM} messages and ${gotB} bytes received`);
    check(frames > 0 && frames <= 30 * 10 + 30, 'World frames: ten a second or fewer (10 / s, plus 10% for the timer)', `${frames} in 30 s by the host's count`);
    check(got >= frames * 0.95, 'and the guest receives at least 95% of the host\'s count', `${got} of ${frames}`);
    check(sentM / 30 < 40, 'both players together stay inside one player\'s rate limit (40 messages a second)', `${(sentM / 30).toFixed(1)} a second`);
  }

  // ── 4. A player far from the host still has cars round it ──
  await A.go(-340, 291.8, 1.5708);
  await B.go(330, 291.8, 1.5708);
  await sleep(1000);
  let na, nb, ia, ib;
  [na, nb, ia, ib] = await both(A, B);
  const apart = dist(ia, ib);
  let roundB = 0, roundA = 0, total = 0, hostTag = '?';
  for (const end = Date.now() + 60000; Date.now() < end;) {
    [na, nb, ia, ib] = await both(A, B);
    // Each on their own screen.
    roundB = near(nb.traffic.cars, ib, 170).length; roundA = near(na.traffic.cars, ia, 170).length;
    total = Math.max(na.traffic.cars.length, nb.traffic.cars.length);
    hostTag = na.traffic.mode === 'host' ? 'A' : nb.traffic.mode === 'host' ? 'B' : '?';
    if (roundB >= 4 && roundA >= 4 && hostTag !== '?') break;
    await sleep(500);
  }
  check(apart > 400 && roundA >= 4 && roundB >= 4, 'two players far apart both have cars round them', `${apart.toFixed(0)} m apart, ${roundA} within 170 m of A and ${roundB} of B, each on their own screen; ${hostTag} is the host`);
  check(total <= alone + 2, 'out of the same budget as one player has', `${total} in all (${alone} for one player)`);

  // ── 5. The guest's own car is stopped by a shared car ──
  {
    let done = false, detail = 'no standing car found to drive at', base = null;
    for (let attempt = 0; attempt < 10 && !done; attempt++) {
      r = await roles([A, B]);
      if (!r) { await sleep(500); continue; }
      const G = r.guests[0];
      // The test stands the car itself, so that nothing depends on which of the host's drivers happens to be waiting
      // where: the host's player leaves a sedan in the guest's street, which makes it one of the town's standing cars in
      // the traffic frames (stage 2, step 3), shown and solid on the guest like every other. Then the host goes back.
      const gi0 = base ?? (base = await G.info()), hi0 = await r.host.info();
      const px = (gi0.x < 0 ? gi0.x + 26 : gi0.x - 40) + attempt * 7, pz = gi0.z;
      await r.host.go(px, pz, Math.PI / 2);
      await r.host.page.evaluate(() => { window.__game.drive('sedan'); window.__game.game.player.exit(); });
      const there = (x) => x.traffic.cars.find((k) => k.driver === null && k.kind === 'sedan' && Math.hypot(k.x - px, k.z - pz) < 4);
      const ng0 = await G.until((x) => x.traffic.mode === 'guest' && !!there(x), 20000);
      await r.host.go(hi0.x, hi0.z, hi0.h);
      if (!ng0) { detail = 'the car the host left was not shown to the guest'; continue; }
      const c = there(ng0);
      const s = Math.sin(c.h), co = Math.cos(c.h), start = { x: c.x - s * 12, z: c.z - co * 12 };
      await G.go(start.x, start.z, c.h);
      await G.page.evaluate(() => window.__game.drive('sedan'));
      const hits0 = ng0.traffic.hitsSent;
      let met = false;
      await G.page.keyboard.down('KeyW');
      let minAlong = 99, moved = 0, left = false, held = 0, guest = true;
      const trail = [];
      for (const end = Date.now() + 30000; Date.now() < end;) {
        const [x, i] = await Promise.all([G.net(), G.info()]);
        const now = x.traffic.cars.find((k) => k.id === c.id);
        if (x.traffic.mode !== 'guest') { guest = false; break; }
        // (The guest's own screen reports each knock it gives a shared car.)
        met = x.traffic.hitsSent > hits0;
        if (!now || dist(now, c) > 1.5) { left = true; break; }
        const along = (now.x - i.x) * s + (now.z - i.z) * co;
        minAlong = Math.min(minAlong, along); moved = dist(i, start);
        // Held: it got going, and for the last two seconds of full throttle it has gone nowhere.
        trail.push({ t: Date.now(), m: moved });
        while (trail.length > 1 && Date.now() - trail[0].t > 2000) trail.shift();
        held = moved > 3 && Date.now() - trail[0].t > 1700 && Math.abs(moved - trail[0].m) < 0.25 ? held + 1 : 0;
        if (held >= 3) break;
        await sleep(150);
      }
      await G.page.keyboard.up('KeyW');
      const inCar = await G.page.evaluate(() => window.__game.info().vehicle);
      if (!guest) { detail = 'the host changed in the middle'; continue; }
      // (Since stage 2, step 2 the host shoves the car that was struck and its driver may make off: tools/net/bump.mjs
      // checks that. Here it only matters that the guest met it and did not go through it.)
      // (A knock counted while still far from the car was some other car running into the guest's from behind: try again.)
      if (left && (!met || minAlong > 6)) { detail = 'the car was moved away before the guest reached it'; continue; }
      if (!left && held < 3) { detail = `the guest's car neither reached the car nor was held (${moved.toFixed(1)} m driven)`; continue; }
      done = true;
      // (12 m between centres at the start; nose to tail they touch at about 4.5. Through a car that is not solid it would reach 0 and go negative.)
      check(moved > 3 && minAlong > 2.5 && (held >= 3 || (left && met)), 'the guest\'s own car is stopped by a shared car', `${G.tag} drove ${moved.toFixed(1)} m at full throttle, never nearer than ${minAlong.toFixed(2)} m centre to centre, then ${left ? 'the struck car made off' : 'went nowhere'}`);
      check(inCar === 'sedan', 'and the guest is still in its own car', String(inCar));
    }
    if (!done) check(false, 'the guest\'s own car is stopped by a shared car', detail);
  }

  // ── 5b. The other way round: the host's drivers see a guest's car standing in their lane, and stop for it ──
  {
    let done = false, detail = 'no moving car found';
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      r = await roles([A, B]);
      if (!r) { await sleep(500); continue; }
      const G = r.guests[0];
      const x0 = await G.until((x) => x.traffic.mode === 'guest' && x.traffic.cars.some((c) => c.speed > 5), 30000);
      if (!x0) continue;
      const c = x0.traffic.cars.filter((k) => k.speed > 5)[attempt % 3] ?? x0.traffic.cars.find((k) => k.speed > 5);
      const s = Math.sin(c.h), co = Math.cos(c.h);
      await G.go(c.x + s * 18, c.z + co * 18, c.h);
      await G.page.evaluate(() => window.__game.drive('sedan'));
      let nearest = 99, waited = 0, guest = true, gap = 0;
      for (const end = Date.now() + 45000; Date.now() < end;) {
        const [x, i] = await Promise.all([G.net(), G.info()]);
        if (x.traffic.mode !== 'guest') { guest = false; break; }
        const now = x.traffic.cars.find((k) => k.id === c.id);
        if (!now) break;
        const d = dist(now, i), behind = (i.x - now.x) * Math.sin(now.h) + (i.z - now.z) * Math.cos(now.h);
        nearest = Math.min(nearest, d);
        // Standing behind it, in its lane, close.
        waited = now.speed === 0 && behind > 3 && behind < 12 && d < 12 ? waited + 1 : 0;
        gap = behind;
        if (waited >= 8 || d > 60) break;
        await sleep(200);
      }
      if (!guest) { detail = 'the host changed in the middle'; continue; }
      if (waited < 8 && nearest > 6) { detail = `the car turned off or stopped short (nearest ${nearest.toFixed(1)} m)`; continue; }
      // Round it in the next lane (a lane is 3.4 m over) is not through it: drivers do pass a standing car, the more so
      // one that was knocked in the check before and is making off. Another car is tried.
      if (waited < 8 && nearest > 3 && gap < -4) { detail = `the car went round in the next lane (nearest ${nearest.toFixed(1)} m, middle to middle)`; continue; }
      done = true;
      check(waited >= 8 && nearest > 3, 'a shared car stops behind a guest\'s standing car instead of driving through it', `${G.tag}: it waited ${gap.toFixed(1)} m behind (middle to middle); nearest ${nearest.toFixed(2)} m`);
    }
    if (!done) check(false, 'a shared car stops behind a guest\'s standing car instead of driving through it', detail);
  }

  // ── 6. The host leaves: another browser takes the cars over, and a third sees them carry on ──
  const C = await visitor('C', viaMain, SHOTS ? [960, 540] : [480, 270]);
  await C.until((x) => x.status === 'online' && x.count === 3);
  ib = await B.info();
  await A.go(ib.x - 6, ib.z + 2, 0);
  await C.go(ib.x + 6, ib.z + 2, 0);
  let nc = await C.until((x) => x.traffic.mode !== 'local' && x.traffic.cars.length >= 3, 30000);
  check(!!nc, 'a third browser joins and is shown the cars', nc ? `${nc.traffic.cars.length} cars` : 'timed out');
  await sleep(6000);
  r = null;
  for (let k = 0; k < 20 && !r; k++) { r = await roles([A, B, C]); if (!r) await sleep(300); }
  if (!r) throw new Error('three browsers, no host');
  const gone = r.host, goneId = r.hn.id, rest = r.guests, lists = r.gn.map((x) => x.traffic.cars), took = r.gn.map((x) => x.traffic.adopted);
  await leave(gone);
  let r2 = null;
  for (const end = Date.now() + 25000; Date.now() < end && !r2;) { const q = await roles(rest); if (q && q.hn.host !== goneId && q.hn.count === 2) r2 = q; else await sleep(150); }
  check(!!r2, `the host (${gone.tag}) left: one of the others is the host now and the other its guest`, r2 ? `${r2.host.tag} hosts, ${r2.guests[0].tag} is its guest` : 'timed out');
  if (!r2) throw new Error('nobody took over');
  const H = r2.host, G = r2.guests[0], hi = rest.indexOf(H), was = lists[hi];
  const kept = r2.hn.traffic.cars.filter((c) => was.some((o) => o.id === c.id && o.kind === c.kind && dist(o, c) < 40)).length;
  const adopted = r2.hn.traffic.adopted - took[hi];
  check(adopted >= was.length * 0.7 && kept >= was.length * 0.7, 'the new host took the wheel of the cars it was showing', `${adopted} taken over, ${r2.hn.traffic.dropped} could not be placed (ever), ${kept} of ${was.length} still there under the same number`);
  await sleep(8000);
  let cmp = { common: 0, wrong: 0, worst: 99, worstStill: 99 }, rolling = 0, count = 0;
  for (let k = 0; k < 10; k++) {
    const q = await roles([H, G]);
    if (!q) { await sleep(300); continue; }
    cmp = compare(q.hn.traffic.cars, q.gn[0].traffic.cars);
    rolling = q.hn.traffic.cars.filter((c) => Math.abs(c.speed) > 1.5).length; count = q.hn.traffic.cars.length;
    break;
  }
  check(cmp.common >= 3 && cmp.wrong === 0 && cmp.worst < 8 && cmp.worstStill < 0.3, 'and the guest goes on seeing the same cars, now from the new host', `${cmp.common} in common, moving at most ${cmp.worst} m apart, standing ${cmp.worstStill} m`);
  check(rolling >= 2 && count >= was.length * 0.6, 'the traffic is still moving after the change (no pile up)', `${rolling} of ${count} cars rolling 8 s later`);

  // ── 7. The service goes away: everybody keeps the cars as private traffic ──
  let q7 = null;
  for (let k = 0; k < 20 && !q7; k++) { q7 = await roles([H, G]); if (!q7) await sleep(300); }
  if (!q7) throw new Error('two browsers, no host');
  const G7 = q7.guests[0], H7 = q7.host, shownG = q7.gn[0].traffic.cars.length, took7 = q7.gn[0].traffic.adopted;
  await stop(home);
  let ng = await G7.until((x) => x.status !== 'online' && x.traffic.mode === 'local', 20000);
  let nh = await H7.until((x) => x.status !== 'online' && x.traffic.mode === 'local', 20000);
  await sleep(5000);
  const [ig, ih] = await Promise.all([G7.info(), H7.info()]);
  ng = await G7.net();
  check(!!ng && !!nh && ng.traffic.adopted - took7 >= shownG * 0.7 && ig.traffic >= shownG * 0.5 && ih.traffic > 0, 'service gone: both are single player, and the guest drives the cars it was showing as its own', ng ? `${G7.tag} took over ${ng.traffic.adopted - took7} of ${shownG}, has ${ig.traffic} cars with drivers now; the old host has ${ih.traffic}` : 'timed out');
  const g0 = ng.traffic.cars;
  await sleep(4000);
  ng = await G7.net();
  const movedOn = ng.traffic.cars.filter((c) => { const o = g0.find((k) => k.id === c.id); return o && dist(o, c) > 1; }).length;
  check(movedOn >= 2, 'and they are driving', `${movedOn} cars moved in 4 s`);
  const errs = [...H.errors, ...G.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8812/.test(e));
  check(errs.length === 0, 'no errors from the game on either page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
  await leave(H); await leave(G);

  // ── 8. A backup style connection: no World frames, private traffic ──
  const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
  let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
  check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
  const id0 = await D.info();
  await E.go(id0.x + 4, id0.z + 1.5, id0.h);
  await sleep(10000);
  [nd, ne] = await Promise.all([D.net(), E.net()]);
  const [idd, ide] = await Promise.all([D.info(), E.info()]);
  check(nd.traffic.mode === 'local' && ne.traffic.mode === 'local' && idd.traffic > 0 && ide.traffic > 0, 'on the backup each keeps private traffic', `D ${nd.traffic.mode} with ${idd.traffic} cars, E ${ne.traffic.mode} with ${ide.traffic}`);
  check(D.worldOut === 0 && E.worldOut === 0 && nd.traffic.framesSent === 0 && ne.traffic.framesSent === 0 && nd.traffic.framesGot === 0 && ne.traffic.framesGot === 0, 'and no World frame is sent or received', `on the wire: D ${D.worldOut}, E ${E.worldOut}`);
  check(nd.remotes.length === 1 && ne.remotes.length === 1 && nd.remotes[0].seen && ne.remotes[0].seen, 'while they still see each other', `D sees ${nd.remotes.length}, E sees ${ne.remotes.length}`);
  const errs2 = [...D.errors, ...E.errors];
  check(errs2.length === 0, 'no errors on the backup pages', errs2.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
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
