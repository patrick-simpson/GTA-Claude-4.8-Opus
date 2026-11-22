// Multiplayer stage 3, step 2: the same police for everyone. Headless browsers against LOCAL services.
//
//   node tools/net/police.mjs              every check, and two pictures into shots/net/
//   node tools/net/police.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/people.mjs does (read its header): the Node
// home on 8841 is "main" (found through a lookup stand-in on 8842) and a second copy on 8843 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: a guest earns heat by its own deed against the host's people (and the host gets none); the host's screen
// shows police after the guest and not after the host; the guest is shown the same cruisers and officers (numbers,
// places); the guest gets out of sight and the police stand down on both screens; officers shoot the guest and its
// own screen shows the loss; the guest shoots an officer down and the host puts that on the guest's sheet; officers hold the guest and its own screen shows the booking; two players wanted at
// once share the one budget of cars; the host leaves in the middle of a chase and the chase carries on; the service
// goes and the wanted player keeps its heat with private police; on a backup style connection the police are
// private and nothing new is on the wire; what 30 s of a chase costs.
// The test makes its own situations and says where it does:
//  - WHO IS HOST is pinned. The wanted browser tells the service it cannot host (the same thing a hidden tab says:
//    document.hidden is made to read true on that page), so the service keeps the job on the other one. The parts
//    that are about the job moving (the host leaving) are done by closing the host.
//  - The first heat is EARNED (three punches on people the host stood there, with a bystander). Later levels are set
//    with the game's own test hook (setHeat), which the Patrol's code treats as "somebody else moved the pips".
//  - Getting out of sight is a teleport: 600 m in one step instead of a long drive.
//  - A wanted player's health is topped up between parts, so a part is not ended early by the last one's bullets.
// The pages run in real time. There is no video card here, so the game runs at about a quarter speed and the waits
// are long; every wait ends as soon as what it waits for has happened.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8841, LOOKUP = 8842, BACKUP = 8843;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-police-'));
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
  // Binary frames this page sends, counted on the wire itself: by kind, and for World, ToHost and ToPlayer frames by
  // what they carry ('2.4' is the police beat, '4.8' a guest's heat, '5.3' '5.4' '5.5' a hurt, a bust, a crime).
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] === 2 || p[0] === 4 || p[0] === 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  // (A plain `?net=` page opens its socket while it boots, before anything here is listening: loaded a second time,
  // every frame it ever sends is counted.)
  if (again) {
    await t.page.reload({ waitUntil: 'load' });
    await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  }
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  t.heat = (n) => t.page.evaluate((n) => window.__game.setHeat(n), n);
  t.heal = () => t.page.evaluate(() => { const p = window.__game.game.player; if (p.health > 0) p.health = 100; });
  /** Host only: somebody stands at (x, z) facing h. Returns their number, 0 when this page is not simulating. */
  t.stand = (x, z, h = 0, secs = 150) => t.page.evaluate(([x, z, h, secs]) => {
    const g = window.__game.game;
    if (g.net.people.mode !== 'host') return 0;
    return g.systems.find((s) => s.peds && s.traffic).peds.stand(x, z, h, secs);
  }, [x, z, h, secs]);
  /** "I cannot host", as a hidden tab says it (see the header). */
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wire = (t, k, what = 'n') => t.out[what][k] ?? 0;
/** Is `h` running the town's police and every one of `gs` shown them? */
async function settled(h, gs, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const [nh, ...ng] = await Promise.all([h.net(), ...gs.map((g) => g.net())]);
    if (nh.traffic.mode === 'host' && nh.police.mode === 'host' && ng.every((x) => x.traffic.mode === 'guest' && x.police.mode === 'guest' && x.host === nh.id)) return true;
    await sleep(300);
  }
  return false;
}
/** The cruisers on duty after player `id` on the host's screen, and the same numbers on a guest's. */
const after = (nh, id) => nh.police.units.filter((u) => u.lit && !u.shown && u.after === id);
const lit = (n) => n.police.units.filter((u) => u.lit);
function compare(hs, gs) {
  const byId = new Map(gs.map((c) => [c.id, c]));
  let common = 0, worst = 0, worstStill = 0;
  for (const c of hs) {
    const o = byId.get(c.id);
    if (!o) continue;
    common++;
    const d = dist(o, c);
    if (Math.abs(c.speed ?? 1) < 0.5 && (c.pose === undefined || c.pose === 'stand')) worstStill = Math.max(worstStill, d); else worst = Math.max(worst, d);
  }
  return { common, worst: +worst.toFixed(2), worstStill: +worstStill.toFixed(2) };
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. Alone on main: private police, nothing sent ──
  const size = SHOTS ? [960, 540] : [480, 270];
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  await sleep(2500);
  n = await A.net();
  check(n.police.mode === 'local' && !wire(A, '2.4') && !wire(A, '4.8'), 'alone on main: private police, and nothing about police sent', `mode ${n.police.mode}; a budget of ${n.police.budget} cars at this quality`);
  const budget = n.police.budget;

  // ── 2. B joins and says it cannot host: A runs the town's police, B is shown them ──
  const B = await visitor('B', viaMain, size);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}, ${n.count} in town` : 'timed out');
  const H = A, G = B;
  let ok = await settled(H, [G], 90000);
  let nh = await H.net(), ng = await G.net();
  check(ok, 'A runs the police for the town; B hears its police beat and has none of its own', `A ${nh.police.mode} (${nh.police.beatsSent} beats sent), B ${ng.police.mode} (${ng.police.beatsGot} heard)`);
  if (!ok) throw new Error('no shared police');
  const gid = ng.id, hid = nh.id;

  // A quiet street to stage things in (the one tools/net/people.mjs uses).
  const LANE = { x: -340, z: 291.8 };
  const spot = { x: LANE.x - 20, z: LANE.z + 3 };
  await H.go(LANE.x + 10, LANE.z + 16, 0);
  await G.go(spot.x - 1, spot.z, Math.PI / 2);
  await sleep(2000);

  // ── 3. The guest earns heat: three punches on the host's people, a bystander looking on ──
  {
    const h0 = await H.net(), g0 = await G.net();
    let level = 0, punches = 0, landed = 0, detail = '';
    await H.stand(spot.x + 6, spot.z - 5, -Math.PI / 2);
    for (let k = 0; k < 10 && level < 1; k++) {
      const px = spot.x + (k % 2) * 2.5, pz = spot.z + 4 + k * 3;
      const id = await H.stand(px, pz, -Math.PI / 2);
      if (!id) { detail = 'the host could not stand somebody'; await sleep(1000); continue; }
      const shown = await G.until((x) => { const p = x.people.people.find((q) => q.id === id); return !!p && p.pose === 'stand' && Math.hypot(p.x - px, p.z - pz) < 1; }, 15000);
      if (!shown) { detail = 'the person the host stood was not shown to the guest'; continue; }
      await G.go(px - 1.0, pz, Math.PI / 2);
      await sleep(600);
      const c0 = (await G.net()).people.hurtsSent;
      await G.page.evaluate(() => { const g = window.__game.game; g.player.weapons.select(0); g.input.press('fire'); });
      punches++;
      const hit = await G.until((x) => x.people.hurtsSent > c0, 8000);
      if (hit) landed++;
      await sleep(1200);
      level = (await G.net()).police.level;
    }
    ng = await G.until((x) => x.police.level >= 1, 5000) ?? await G.net();
    nh = await H.until((x) => x.police.wanted.some((w) => w.id === gid && w.level >= 1), 10000) ?? await H.net();
    const hi = await H.info();
    check(ng.police.level >= 1 && landed >= 2, 'a guest punches the host\'s people: the GUEST is wanted, on its own screen', `${landed} of ${punches} punches landed; ${ng.police.crimes - g0.police.crimes} crimes witnessed on ${G.tag}'s sheet (last: ${ng.police.lastCrime}); level ${ng.police.level}${detail ? '; ' + detail : ''}`);
    check(nh.police.level === 0 && hi.heat === 0 && nh.police.crimes === h0.police.crimes && nh.people.hurtsDone > h0.people.hurtsDone, 'and the host, which applied the blows, gets no heat for them', `host level ${nh.police.level}, ${nh.police.crimes - h0.police.crimes} crimes on its sheet, ${nh.people.hurtsDone - h0.people.hurtsDone} blows applied`);
    check(nh.police.wanted.some((w) => w.id === gid && w.level === ng.police.level) && wire(G, '4.8') >= 1 && ng.police.heatsSent === wire(G, '4.8'), 'the guest told the host its level in a small frame', `${wire(G, '4.8')} heat frame(s) of 8 bytes; the host has player ${gid} at level ${nh.police.wanted.find((w) => w.id === gid)?.level}`);
  }

  // ── 4. The host's screen shows police after the guest, not after the host; the guest is shown the same cars ──
  {
    await G.go(spot.x - 1, spot.z, Math.PI / 2);
    nh = await H.until((x) => after(x, gid).length >= 1, 90000);
    check(!!nh, 'the host sends a cruiser after the guest', nh ? `${after(nh, gid).length} on duty after player ${gid}, ${dist(after(nh, gid)[0], spot).toFixed(0)} m away` : 'none in 90 s');
    ng = await G.until((x) => lit(x).length >= 1, 20000);
    let cmp = { common: 0, worst: 99, worstStill: 99 }, looks = 0, same = true, chasedHost = 0, worst = 0;
    for (let k = 0; k < 10; k++) {
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      const hs = lit(nh), gs = lit(ng);
      if (hs.length === 0) break;
      cmp = compare(hs, gs); looks++;
      worst = Math.max(worst, cmp.worst, cmp.worstStill);
      if (cmp.common !== hs.length || gs.length !== hs.length) same = false;
      chasedHost += after(nh, hid).length;
      await sleep(400);
    }
    check(looks >= 3 && same && worst < 12, 'the guest is shown the same cruisers, by number, in the same places', `${cmp.common} in common at the last of ${looks} looks; at most ${worst.toFixed(1)} m apart on the two screens (read a moment apart, cars moving)`);
    check(chasedHost === 0 && nh.police.level === 0, 'and nothing is after the host', `host level ${nh.police.level}; cars after the host over those looks: ${chasedHost}`);
    const cruisers = await G.page.evaluate(() => window.__game.net().traffic.cars.filter((c) => c.kind === 'cruiser').map((c) => `${c.id}:${c.duty}`).join());
    check(ng && lit(ng).every((u) => u.shown) && ng.police.spawned === 0, 'the guest has no police of its own: every cruiser it has is the host\'s', `shown cruisers ${cruisers}; cars made by its own Patrol: ${ng ? ng.police.spawned : '?'}`);
  }

  // ── 5. Seen, then out of sight long enough: the police stand down on both screens ──
  // Two places far from here and far from each other (sidewalks in busy parts of town).
  const [farSpot, farSpot2] = await H.page.evaluate(([sx, sz]) => {
    const g = window.__game.game, all = [];
    for (const b of g.plan.blocks) {
      if (b.district !== 'downtown' && b.district !== 'midtown' && b.district !== 'oldtown' && b.district !== 'strand') continue;
      if (b.road[0]) all.push({ x: (b.rect.x0 + b.rect.x1) / 2, z: b.rect.z0 - 3 });
    }
    const d = (a, x, z) => Math.hypot(a.x - x, a.z - z);
    let one = all[0];
    for (const a of all) if (d(a, sx, sz) < 1100 && d(a, sx, sz) > d(one, sx, sz)) one = a;
    let two = all[0], best = -1;
    for (const a of all) { const m = Math.min(d(a, sx, sz), d(a, one.x, one.z)); if (m > best) { best = m; two = a; } }
    return [one, two];
  }, [spot.x, spot.z]);
  {
    // (Standing where it is, the guest would be booked a few seconds after being seen. It goes the moment it is.)
    ng = await G.until((x) => x.police.seen || x.police.booked > 0, 300000, 120);
    const seen = !!ng && ng.police.seen && ng.police.booked === 0;
    await G.go(farSpot.x, farSpot.z, 0);
    const t0 = Date.now(), i0 = await G.info();
    check(seen, 'a cruiser gets to the guest and sees it (by the guest\'s own reckoning)', ng ? `level ${ng.police.level}, seen ${ng.police.seen}; then it is moved ${dist(farSpot, spot).toFixed(0)} m away in one step` : 'not seen in 300 s');
    nh = await H.until((x) => x.police.wanted.some((w) => w.id === gid && w.level >= 1) && after(x, gid).length >= 1, 5000);
    // For a quarter of a minute (of game time) after the Patrol last had somebody, anyone on the pavement who sees them
    // phones it in, so the first place is known. Once the phones stop it moves on, and nobody knows the second.
    for (const end = Date.now() + 200000; Date.now() < end;) { const i = await G.info(); if (i.time - i0.time > 16.5 || i.heat === 0) break; await sleep(500); }
    await G.go(farSpot2.x, farSpot2.z, 0);
    ng = await G.until((x) => x.police.level === 0, 400000);
    const i1 = await G.info();
    check(!!ng && ng.police.booked === 0, 'out of sight long enough, the guest loses its heat (its own search clock, as in single player)', ng ? `after ${((Date.now() - t0) / 1000).toFixed(0)} s on the wall, ${(i1.time - i0.time).toFixed(1)} s of its game time; level ${ng.police.level}` : 'still wanted after 300 s');
    nh = await H.until((x) => x.police.wanted.every((w) => w.level === 0) && lit(x).length === 0, 120000);
    ng = await G.until((x) => lit(x).length === 0, 15000);
    const now = await H.net();
    check(!!nh && !!ng, 'and the police stand down on both screens', `host: player ${gid} at level ${now.police.wanted.find((w) => w.id === gid)?.level}, ${lit(now).length} cars on duty (${now.police.units.length} driving home); guest: ${ng ? lit(ng).length : '?'} on duty shown`);
  }

  // ── 6. Level 3: officers shoot the guest, and its own screen shows the loss ──
  let chaseCost = null;
  {
    await G.go(spot.x - 1, spot.z, Math.PI / 2);
    await G.heal();
    await sleep(500);
    const g0 = await G.net(), h0 = await H.net(), hi0 = await H.info();
    await G.heat(3);
    ng = await G.until((x) => x.police.hurtsGot > g0.police.hurtsGot || x.police.booked > g0.police.booked, 400000, 150);
    const gi = await G.info();
    [nh, ng] = await Promise.all([H.net(), G.net()]);
    const hi = await H.info();
    check(ng.police.hurtsGot > g0.police.hurtsGot && gi.health < 100, 'at level 3 the host\'s officers shoot the guest: its own screen shows the health gone', `${nh.police.shots - h0.police.shots} shots, ${nh.police.hits - h0.police.hits} hits by the host's count; ${ng.police.hurtsGot - g0.police.hurtsGot} told to the guest (5 bytes each); its health ${gi.health.toFixed(1)}`);
    check(hi.health === hi0.health && nh.police.hurtsSent >= 1 && wire(H, '5.3') === nh.police.hurtsSent, 'the host is not hurt, and it told the guest alone', `host health ${hi.health}; ${wire(H, '5.3')} hurt frame(s) on the wire`);
    // The same officers on both screens.
    let cmp = { common: 0, worst: 99, worstStill: 99 }, worst = 0, same = 0, looks = 0, uniforms = 0;
    for (let k = 0; k < 8; k++) {
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      const ho = nh.police.officers.filter((c) => !c.shown), go = ng.police.officers.filter((c) => c.shown);
      if (ho.length) { cmp = compare(ho, go); looks++; worst = Math.max(worst, cmp.worst, cmp.worstStill); if (cmp.common === ho.length && go.length === ho.length) same++; }
      await sleep(350);
    }
    uniforms = await G.page.evaluate(() => { const g = window.__game.game; return g.systems.find((s) => s.tag === 'police').cops.filter((c) => c.shown && c.p.visible && c.p.look.hat === 0xf2e8cf && c.p.look.top === 0xa9c1d4).length; });
    check(looks >= 3 && same >= looks - 1 && worst < 4 && uniforms >= 1, 'the guest is shown the same officers, by number, in the same places, in uniform', `${cmp.common} in common; the same set at ${same} of ${looks} looks; at most ${worst.toFixed(1)} m apart; ${uniforms} in the Patrol's cap and shirt on the guest's screen`);
    check(ng.police.shotsGot >= 1 && nh.police.shotsSent >= 1, 'and the shots are shown to the guest too', `${nh.police.shotsSent} sent with the police beat, ${ng.police.shotsGot} drawn`);

    // ── Pictures: the guest with the Patrol round it, from the host's screen and from its own ──
    if (SHOTS) {
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      const gi2 = await G.info();
      const car = lit(nh).sort((a, b) => dist(a, gi2) - dist(b, gi2))[0] ?? { x: gi2.x + 10, z: gi2.z };
      const d = Math.max(1, dist(car, gi2)), ux = (car.x - gi2.x) / d, uz = (car.z - gi2.z) / d, reach = Math.min(d, 16);
      // (From above head height, so a car that stops in between does not hide the Patrol.)
      const view = [gi2.x - ux * 4.5 - uz * 2.2, gi2.y + 4.6, gi2.z - uz * 4.5 + ux * 2.2, gi2.x + ux * reach * 0.8, gi2.y + 0.6, gi2.z + uz * reach * 0.8];
      for (const t of [H, G]) await t.page.evaluate((v) => window.__game.view(...v), view);
      await sleep(3500);
      const shots = await Promise.all([H.shot('shots/net/police-host.png'), G.shot('shots/net/police-guest.png')]);
      for (const t of [H, G]) await t.page.evaluate(() => window.__game.view());
      console.log('shots', shots.join(' '), `(${lit(nh).length} cruisers on duty, ${nh.police.officers.length} officers; the nearest car ${d.toFixed(0)} m from the guest)`);
    }

    // ── 30 s of this chase: what it costs ──
    await G.heal();
    const keys = ['2.4', '4.8', '5.3', '5.4', '5.5'];
    const snap = () => ({ a: { ...A.out.n }, b: { ...B.out.n }, ab: { ...A.out.bytes }, bb: { ...B.out.bytes } });
    const w0 = snap(), [a0, b0] = await Promise.all([A.net(), B.net()]);
    for (let k = 0; k < 6; k++) { await sleep(5000); await G.heal(); }
    const w1 = snap(), [a1, b1] = await Promise.all([A.net(), B.net()]);
    const dn = (k) => (w1.a[k] ?? 0) - (w0.a[k] ?? 0) + (w1.b[k] ?? 0) - (w0.b[k] ?? 0), db = (k) => (w1.ab[k] ?? 0) - (w0.ab[k] ?? 0) + (w1.bb[k] ?? 0) - (w0.bb[k] ?? 0);
    const pm = keys.reduce((s, k) => s + dn(k), 0), pb = keys.reduce((s, k) => s + db(k), 0);
    const sentM = a1.sent.msgs - a0.sent.msgs + b1.sent.msgs - b0.sent.msgs, sentB = a1.sent.bytes - a0.sent.bytes + b1.sent.bytes - b0.sent.bytes;
    const cars = a1.police.units.length, cops = a1.police.officers.length;
    chaseCost = { pm, pb, sentM, sentB };
    console.log(`  30 s of a level ${b1.police.level} chase, ${cars} cruisers and ${cops} officers out: the police's own frames were ${pm} messages and ${pb} bytes = ${(pb / 30).toFixed(1)} bytes/s (beat ${dn('2.4')}/${db('2.4')} B, heat ${dn('4.8')}/${db('4.8')} B, hurt ${dn('5.3')}/${db('5.3')} B, bust ${dn('5.4')}, crime ${dn('5.5')})`);
    console.log(`  the cruisers ride in the traffic frames (15 bytes a moving car, ten a second: at most ${cars * 150} bytes/s for these ${cars}) and the officers in the people frames (8 bytes when one changes course)`);
    console.log(`  everything, both players together: ${sentM} messages and ${sentB} bytes sent (${(sentM / 30).toFixed(1)} messages/s, ${(sentB / 30).toFixed(0)} bytes/s); traffic frames ${db('2.1')} B, people frames ${db('2.3')} B`);
    check(pm > 0 && pb / 30 < 200, 'the police\'s own frames cost under 200 bytes a second during a chase', `${(pb / 30).toFixed(1)} bytes/s, ${(pm / 30).toFixed(2)} messages/s`);
    check(sentM / 30 < 40, 'both players together stay inside one player\'s rate limit (40 messages a second)', `${(sentM / 30).toFixed(1)} a second`);
  }

  // ── 6b. The guest shoots an officer down: the host, which decides it, puts it on the GUEST's sheet ──
  {
    await G.heal();
    let done = false, detail = '';
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      ng = await G.until((x) => x.police.mode === 'guest' && x.police.officers.some((c) => c.shown && c.health > 0 && c.pose !== 'down'), 60000);
      if (!ng) { detail = 'no officer on their feet was shown to the guest'; continue; }
      const who = ng.police.officers.find((c) => c.shown && c.health > 0 && c.pose !== 'down').id;
      const g0 = ng, h0 = await H.net();
      // Five pistol rounds (26 each) through the game's own "a bullet has hit this person", as tools/net/people.mjs does:
      // aiming the camera from a headless page is not what is being tested.
      const hit = await G.page.evaluate(async (wid) => {
        const g = window.__game.game, pol = g.systems.find((s) => s.tag === 'police');
        let k = 0;
        for (; k < 5; k++) {
          const c = pol.cops.find((o) => o.shown && o.wid === wid);
          if (!c) break;
          g.player.weapons.hurtPerson(c.p, 26, 1, 0, false);
          await new Promise((r) => setTimeout(r, 250));
        }
        return k;
      }, who);
      if (hit < 4) { detail = 'the officer left the guest\'s screen before four rounds'; continue; }
      ng = await G.until((x) => x.police.crimesGot > g0.police.crimesGot, 20000);
      nh = await H.net();
      const oh = nh.police.officers.find((c) => c.id === who);
      if (!ng) { detail = `the host did not count officer ${who} as down (health there ${oh ? oh.health : 'gone'})`; continue; }
      done = true;
      await sleep(1500);
      ng = await G.net();
      const og = ng.police.officers.find((c) => c.id === who), hi = await H.info();
      check(nh.police.crimesSent > h0.police.crimesSent && ng.police.lastCrime === 'officerDown' && ng.police.level > g0.police.level, 'a guest shoots an officer down: the host puts it on the guest\'s sheet, and the guest\'s level rises', `officer ${who}: ${hit} rounds told to the host (8 bytes each); the host answered with a 9 byte frame; the guest went from level ${g0.police.level} to ${ng.police.level} (${ng.police.lastCrime})`);
      check(nh.police.level === 0 && hi.heat === 0 && nh.police.crimes === h0.police.crimes && !!oh && oh.health === 0 && oh.pose === 'down' && (!og || og.pose === 'down'), 'the host gets no heat for it, and the officer is down on both screens', `host level ${nh.police.level}; officer ${who} on the host: ${oh ? `${oh.pose}, health ${oh.health}` : 'gone'}; on the guest: ${og ? og.pose : 'no longer shown'}`);
    }
    if (!done) check(false, 'a guest shoots an officer down: the host puts it on the guest\'s sheet, and the guest\'s level rises', `3 tries; the last: ${detail}`);
  }

  // ── 7. Level 2: the officers walk up and hold the guest, and its own screen shows the booking ──
  {
    await G.heal();
    const g0 = await G.net(), h0 = await H.net(), i0 = await G.info();
    await G.heat(2);
    ng = await G.until((x) => x.police.booked > g0.police.booked, 400000, 150);
    await sleep(1500);
    const i1 = await G.info();
    [nh, ng] = await Promise.all([H.net(), G.net()]);
    const hi = await H.info();
    check(ng.police.booked === g0.police.booked + 1 && ng.police.bustsGot === g0.police.bustsGot + 1 && i1.heat === 0 && dist(i1, i0) > 50 && i1.money < i0.money, 'at level 2 the host\'s officers hold the guest: booked on its own screen, by the single player rules', `booked ${ng.police.booked - g0.police.booked} time(s) on the host's word (a 3 byte frame); fined ${i0.money - i1.money}; set down ${dist(i1, i0).toFixed(0)} m away at the station; heat ${i1.heat}`);
    check(nh.police.bustsSent === h0.police.bustsSent + 1 && nh.police.booked === h0.police.booked && hi.money === (await H.info()).money && nh.police.level === 0, 'the host booked the guest and not itself', `${nh.police.bustsSent - h0.police.bustsSent} bust sent; the host's own bookings ${nh.police.booked}`);
    // (A car whose crew is out waits for them to walk back before its bar goes dark.)
    nh = await H.until((x) => x.police.wanted.every((w) => w.level === 0) && lit(x).length === 0, 120000);
    check(!!nh, 'and the cars stand down', nh ? `${nh.police.units.length} driving home, none on duty` : `still on duty after 120 s: ${(await H.net()).police.units.map((u) => `${u.state}/crew ${u.crew}`).join(', ')}`);
  }

  // ── 8. Both wanted at once: one budget ──
  {
    await H.heal(); await G.heal();
    await H.heat(5); await G.heat(5);
    let most = 0, total = 0, bothAt = 0, shares = '', looks = 0, over = 0, mostG = 0, mostH = 0;
    for (const end = Date.now() + 150000; Date.now() < end;) {
      nh = await H.net();
      const on = lit(nh).length, forG = after(nh, gid).length, forH = after(nh, hid).length;
      looks++;
      most = Math.max(most, on); total = Math.max(total, nh.police.units.length); mostG = Math.max(mostG, forG); mostH = Math.max(mostH, forH);
      if (on > budget) over++;
      const w = nh.police.wanted.find((x) => x.id === gid);
      if (w && w.level === 5 && nh.police.level === 5) shares = `${w.cars} for the guest and ${nh.police.share} for the host`;
      if (forG >= 2 && forH >= 2 && !bothAt) bothAt = Date.now();
      // (Long enough after both have cars for a seventh to have been sent, were there no budget.)
      if (bothAt && on >= budget && Date.now() - bothAt > 25000) break;
      await H.heal(); await G.heal();
      await sleep(700);
    }
    const alone = await H.page.evaluate(() => { const g = window.__game.game, q = 0.5 + 0.5 * Math.min(1, Math.max(0, g.quality.density)); return Math.max(1, Math.round(5 * q)); });
    check(mostG >= 2 && mostH >= 2, 'host and guest both at level 5: each has cars after it', `at most ${mostH} after the host and ${mostG} after the guest; shares of the budget: ${shares}`);
    check(over === 0 && most <= budget && most >= budget - 1, 'and never more on duty in total than one player alone can have', `at most ${most} on duty over ${looks} looks (${total} with those driving home); the budget is ${budget}; one player at level 5 alone gets ${alone} pursuing cars (and 2 for a roadblock when driving), so two unshared would have ${alone * 2} pursuing`);
    await H.heat(0); await G.heat(0);
    nh = await H.until((x) => lit(x).length === 0 && x.police.wanted.every((w) => w.level === 0), 150000);
    check(!!nh, 'both lose their heat: every car stands down', nh ? `${nh.police.units.length} driving home` : `still on duty after 150 s: ${(await H.net()).police.units.map((u) => `${u.state}/crew ${u.crew}`).join(', ')}`);
    await H.heal(); await G.heal();
  }

  // ── 9. The host leaves in the middle of a chase: another browser carries the chase on ──
  const C = await visitor('C', viaMain);
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3);
  check(!!n, 'a third browser joins', n ? `${n.count} in town` : 'timed out');
  ok = await settled(H, [G, C], 90000);
  if (!ok) throw new Error('three browsers: the police did not settle on A');
  let chased = false;
  {
    // Somewhere the cars need a while to reach, so the change happens while they are on their way.
    await G.go(farSpot.x, farSpot.z, 0);
    await C.go(farSpot.x + 6, farSpot.z, 0);
    await sleep(1500);
    await G.heat(2);
    nh = await H.until((x) => after(x, gid).length >= 1, 120000);
    const ids = nh ? after(nh, gid).map((u) => u.id) : [];
    const shownC = await C.until((x) => ids.length > 0 && ids.every((id) => lit(x).some((u) => u.id === id && u.shown)), 20000);
    const gi0 = await G.info();
    const d0 = nh ? Math.min(...after(nh, gid).map((u) => dist(u, gi0))) : 0;
    check(!!nh && !!shownC, 'a chase is on: the host has cars after the guest, and the third browser is shown them too', nh ? `cruiser(s) ${ids.join(', ')} after player ${gid}, the nearest ${d0.toFixed(0)} m off` : 'no car in 120 s');
    const c0 = await C.net();
    // (The third browser may host again, and says so at once; the wanted one still may not.)
    await C.pin(false);
    await C.page.evaluate(() => { window.__game.game.net.perfAt = 0; });
    await leave(H);
    ok = await settled(C, [G], 60000);
    let nc = await C.net();
    check(ok && nc.host !== hid, 'the host (A) leaves: the third browser runs the police now', `C ${nc.police.mode}, B ${(await G.net()).police.mode}`);
    nc = await C.until((x) => ids.some((id) => after(x, gid).some((u) => u.id === id)), 30000) ?? await C.net();
    const kept = ids.filter((id) => after(nc, gid).some((u) => u.id === id));
    ng = await G.net();
    check(nc.police.adopted - c0.police.adopted >= ids.length && kept.length >= 1 && ng.police.level === 2, 'it took over the same cruisers where they were, and they are after the same player', `${nc.police.adopted - c0.police.adopted} taken over; cruiser(s) ${kept.join(', ')} of ${ids.join(', ')} are after player ${gid} again; the guest is still at level ${ng.police.level}`);
    await sleep(3000);
    nc = await C.net();
    check(nc.police.level === 0 && after(nc, nc.id).length === 0, 'and taking the police over put nothing on the new host\'s own sheet', `new host level ${nc.police.level} (${nc.police.crimes} crimes, last "${nc.police.lastCrime}"); ${nc.police.adoptedOfficers} officer(s) taken over; cars after it: ${after(nc, nc.id).length}`);
    const shownG = await G.until((x) => kept.some((id) => lit(x).some((u) => u.id === id && u.shown)), 20000);
    check(!!shownG, 'and the wanted guest goes on being shown them, now from the new host', shownG ? `${lit(shownG).length} on duty on its screen` : 'not shown');
    // The chase carries on: the cars close in, see the guest, or book it.
    let d1 = d0, seen = false, booked = false;
    for (const end = Date.now() + 240000; Date.now() < end;) {
      [nc, ng] = await Promise.all([C.net(), G.net()]);
      const gi = await G.info(), us = after(nc, gid);
      if (us.length) d1 = Math.min(d1, ...us.map((u) => dist(u, gi)));
      seen = seen || ng.police.seen; booked = ng.police.booked > shownG?.police.booked;
      if (seen || booked || d1 < 40) break;
      await sleep(500);
    }
    chased = seen || booked || d1 < 40;
    check(chased, 'the chase carries on under the new host', `the nearest car came from ${d0.toFixed(0)} m to ${d1.toFixed(0)} m; the guest was ${seen ? 'seen' : booked ? 'booked' : 'not yet seen'}`);
  }

  // ── 10. The service goes away in the middle of a chase: private police again, the heat kept ──
  {
    await G.heal();
    await G.go(spot.x - 1, spot.z, Math.PI / 2);
    await C.go(LANE.x + 10, LANE.z + 16, 0);
    await sleep(800);
    await G.heat(2);
    let nc = await C.until((x) => x.police.mode === 'host' && after(x, gid).length >= 1, 120000);
    ng = await G.until((x) => x.police.mode === 'guest' && x.police.level === 2 && lit(x).some((u) => u.shown), 30000);
    check(!!nc && !!ng, 'a chase is on again', nc && ng ? `${after(nc, gid).length} car(s) after player ${gid}; ${lit(ng).length} shown to it` : 'no car, or the guest was not shown it');
    const g0 = ng ?? await G.net();
    await stop(home);
    ng = await G.until((x) => x.status !== 'online' && x.police.mode === 'local' && x.traffic.mode === 'local', 30000);
    nc = await C.until((x) => x.status !== 'online' && x.police.mode === 'local', 30000);
    await sleep(1500);
    ng = ng && await G.net();
    const gi = await G.info();
    const mine = ng ? ng.police.units.filter((u) => !u.shown) : [];
    check(!!ng && ng.police.level === 2 && gi.heat === 2, 'service gone: the wanted player keeps its heat', ng ? `level ${ng.police.level}, single player (${ng.status})` : 'timed out');
    check(!!ng && mine.length >= 1 && ng.police.adopted > g0.police.adopted && ng.police.units.every((u) => !u.shown), 'and the cruisers it was being shown are its own private police now, where they stood', ng ? `${ng.police.adopted - g0.police.adopted} taken over; ${mine.length} private car(s), none shown` : '');
    // They go on chasing: after a moment each is after this browser's own player and driving.
    const drives = await G.until((x) => x.police.units.some((u) => !u.shown && u.lit && (Math.abs(u.speed) > 1 || u.state === 'park')), 60000);
    check(!!drives, 'and they carry on after it', drives ? drives.police.units.map((u) => `${u.state} at ${u.speed.toFixed(1)} m/s`).join(', ') : 'no private car moved in 60 s');
    // (A car whose crew is out waits for them to walk back before it goes: the wait ends when the last bar is dark.)
    const nc2 = await C.until((x) => x.police.units.every((u) => !u.lit), 150000);
    const last = nc2 ?? await C.net();
    check(!!nc && !!nc2 && nc2.police.level === 0, 'the old host, alone and not wanted, sends its cars home', nc2 ? `${nc2.police.units.length} driving home, none on duty` : `cars still on duty after 150 s: level ${last.police.level}; ${last.police.units.map((u) => `${u.state}/${u.role}/crew ${u.crew}`).join(', ')}; officers ${last.police.officers.map((c) => `${c.pose}/${c.mode}`).join(', ')}`);
    const errs = [...G.errors, ...C.errors, ...A.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8842/.test(e));
    check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await leave(G); await leave(C);
  }

  // ── 11. A backup style connection: private police, and nothing new on the wire ──
  {
    const D = await visitor('D', viaBackup, [480, 270], true), E = await visitor('E', viaBackup, [480, 270], true);
    let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const id0 = await D.info();
    await E.go(id0.x + 4, id0.z + 1.5, id0.h);
    await sleep(3000);
    await E.heat(2);
    ne = await E.until((x) => x.police.units.length >= 1, 90000);
    await sleep(3000);
    [nd, ne] = await Promise.all([D.net(), E.net()]);
    const dCruisers = await D.page.evaluate(() => window.__game.game.vehicles.list.filter((v) => v.spec.kind === 'cruiser').length);
    check(ne.police.mode === 'local' && ne.police.level === 2 && ne.police.units.length >= 1 && ne.police.units.every((u) => !u.shown) && ne.police.spawned >= 1, 'on the backup a wanted player has private police, as before', `E: ${ne.police.mode}, level ${ne.police.level}, ${ne.police.units.length} car(s) of its own`);
    check(nd.police.mode === 'local' && nd.police.units.length === 0 && dCruisers === 0 && nd.police.level === 0, 'and the other player sees none of it', `D: ${nd.police.mode}, ${dCruisers} cruisers on its streets`);
    const kinds = [...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])];
    const quiet = (x) => x.police.beatsSent === 0 && x.police.beatsGot === 0 && x.police.heatsSent === 0 && x.police.heatsGot === 0 && x.police.toPlayerBytes === 0;
    check(kinds.includes('1') && kinds.every((k) => k === '0' || k === '1' || k === '3') && quiet(nd) && quiet(ne), 'nothing about police is sent there: only the frames of stage 1', `kinds on the wire: ${kinds.join(', ') || 'none'} (0 keepalive, 1 state, 3 event); ${wire(D, '1') + wire(E, '1')} state frames counted`);
    const errs2 = [...D.errors, ...E.errors];
    check(errs2.length === 0, 'no errors on the backup pages', errs2.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
  }
  if (chaseCost) console.log(`  (the chase in part 6: ${(chaseCost.pb / 30).toFixed(1)} bytes/s of police frames on top of the traffic and people frames)`);
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
