// Multiplayer stage 2, step 2: signals on one clock, a guest's car against the host's cars, and two players' cars
// against each other. Headless browsers against LOCAL services.
//
//   node tools/net/bump.mjs              every check, and two pictures into shots/net/
//   node tools/net/bump.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/traffic.mjs does (read its header): the Node
// home on 8821 is "main" (found through a lookup stand-in on 8822) and a second copy on 8823 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: alone with no service the signals run on game time, as they always did; host and guest have the same
// signal time and the same lamps at the same crossing, after ONE change of clock each; a guest drives into the side
// of a standing shared car and on BOTH screens that car is knocked sideways and loses health; two players drive at
// each other head on and neither gets through, on main and on the backup; on the backup the signals stay on game
// time and no knock is reported to anybody.
// The pages run in real time. There is no video card here, so frames are slow and the tolerances are generous.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8821, LOOKUP = 8822, BACKUP = 8823;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-bump-'));
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
  // Binary frames this page sends, by kind (first byte): 2 is a World frame, 4 a ToHost frame.
  t.out = { 2: 0, 4: 0 };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => { const p = f.payload; if (typeof p !== 'string' && p.length > 0 && p[0] in t.out) t.out[p[0]]++; }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  /** The signals as this page has them now: their clock, game time, and the lamp for each way at one lit crossing. */
  t.signal = () => t.page.evaluate(() => {
    const g = window.__game.game, id = g.plan.nodes.findIndex((n) => n.hasLight);
    return { t: g.signalTime, wall: Date.now() / 1000, time: g.time, own: g.signalClock === null, shift: g.signalShift, id, phase: g.plan.nodes[id].phase, ew: g.world.signal(id, true), ns: g.world.signal(id, false) };
  });
  /** This player's own car. */
  t.car = () => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: v.x, z: v.z, h: v.h, speed: v.speed, health: v.health } : null; });
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.traffic.mode === 'host');
  if (hi < 0 || ns.some((x, i) => i !== hi && (x.traffic.mode !== 'guest' || x.host !== ns[hi].id))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi) };
}
/** The lamp the game's own rule gives (src/world/signals.ts), worked out again here. */
function lamp(phase, horiz, time) {
  let t = (time + phase) % 26;
  if (horiz) t = (t + 13) % 26;
  return t < 10 ? 'green' : t < 12.5 ? 'yellow' : 'red';
}

const HOLD_S = 10;
/**
 * Two players drive at each other, nose to nose, full throttle. Neither may get through the other, on either screen.
 * Returns what was measured, or null when the street was not clear enough to try.
 */
async function headOn(P, Q, where) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const x0 = where.x + attempt * 30, z = where.z;
    await P.go(x0, z, Math.PI / 2);
    await Q.go(x0 + 44, z, -Math.PI / 2);
    await Promise.all([P.page.evaluate(() => window.__game.drive('sedan')), Q.page.evaluate(() => window.__game.drive('sedan'))]);
    // Each must see the other in a car before they set off.
    const seen = async (t) => !!(await t.until((n) => n.remotes.some((r) => r.vehicle === 'sedan'), 20000));
    if (!(await seen(P)) || !(await seen(Q))) continue;
    await Promise.all([P.page.keyboard.down('KeyW'), Q.page.keyboard.down('KeyW')]);
    let minTrue = 99, minP = 99, minQ = 99, top = 0, held = 0, gap = 99, crossed = false, metAt = 0;
    for (const end = Date.now() + 50000; Date.now() < end;) {
      const [cp, cq, np, nq] = await Promise.all([P.car(), Q.car(), P.net(), Q.net()]);
      if (!cp || !cq) break;
      const rp = np.remotes.find((r) => r.vehicle), rq = nq.remotes.find((r) => r.vehicle);
      gap = cq.x - cp.x;
      minTrue = Math.min(minTrue, gap);
      // On each screen: this player's own car against the other's as drawn there.
      if (rp) minP = Math.min(minP, rp.x - cp.x);
      if (rq) minQ = Math.min(minQ, cq.x - rq.x);
      top = Math.max(top, Math.abs(cp.speed), Math.abs(cq.speed));
      if (gap < 1) { crossed = true; break; }
      // They have met when they are a car's length and a half apart; then both keep the throttle down for HOLD_S more.
      if (!metAt && gap < 7) metAt = Date.now();
      held = metAt ? (Date.now() - metAt) / 1000 : 0;
      if (held >= HOLD_S) break;
      await sleep(150);
    }
    await Promise.all([P.page.keyboard.up('KeyW'), Q.page.keyboard.up('KeyW')]);
    if (!metAt && !crossed) continue;
    await sleep(2500);
    const [cp, cq] = await Promise.all([P.car(), Q.car()]);
    return { minTrue, minP, minQ, top, held, crossed, gap: cq.x - cp.x, sp: Math.max(Math.abs(cp.speed), Math.abs(cq.speed)), hp: cp.health, hq: cq.health, side: Math.max(Math.abs(cp.z - z), Math.abs(cq.z - z)) };
  }
  return null;
}
function judgeHeadOn(m, home) {
  if (!m) { check(false, `${home}: two players drive at each other and both are stopped`, 'the two never met'); return; }
  // (A sedan is about 4.5 m long: nose to nose the middles are that far apart. Through a car that is not solid the gap goes to 0 and negative.)
  check(!m.crossed && m.held >= HOLD_S && m.minTrue > 2.5 && m.gap < 30, `${home}: two players drive at each other and both are stopped`, `top speed ${m.top.toFixed(1)} m/s; then ${HOLD_S} s of full throttle on both sides and neither got through: never under ${m.minTrue.toFixed(1)} m middle to middle, ${m.gap.toFixed(1)} m apart at the end`);
  check(m.minP > 2.5 && m.minQ > 2.5, `${home}: and on each screen the other car was never driven into`, `nearest the other was drawn to this player's own car: ${m.minP.toFixed(1)} m on one screen, ${m.minQ.toFixed(1)} m on the other`);
  check(m.hp < 100 && m.hq < 100, `${home}: both cars took damage, each on its own browser`, `health ${m.hp.toFixed(0)} and ${m.hq.toFixed(0)}; ${m.side.toFixed(1)} m knocked sideways at most; speed ${m.sp.toFixed(1)} m/s 2.5 s after letting go`);
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. No service at all: the signals run on game time, as they always did ──
  {
    const S = await visitor('S', 'net=0');
    await sleep(6000);
    const a = await S.signal();
    await sleep(3000);
    const b = await S.signal();
    const n = await S.net();
    check(a.own && b.own && a.t === a.time && b.t === b.time && a.shift === 0 && n.traffic.signal.jumps === 0 && !n.traffic.signal.town, 'single player: the signals run on game time exactly', `signal time ${b.t.toFixed(2)} s, game time ${b.time.toFixed(2)} s, clock changes ${n.traffic.signal.jumps}`);
    check(b.ew === lamp(b.phase, true, b.time) && b.ns === lamp(b.phase, false, b.time) && b.ew !== b.ns, 'single player: the lamps are what the old rule gives for that time', `crossing ${b.id}: east-west ${b.ew}, north-south ${b.ns}`);
    await leave(S);
  }

  // ── 2. Two on main: one clock for the signals ──
  const A = await visitor('A', viaMain, SHOTS ? [960, 540] : [480, 270]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  // B arrives later, and A's game clock is run on by a minute first, so the two game clocks are far apart.
  await A.page.evaluate(() => { const g = window.__game.game; for (let i = 0; i < 1200; i++) g.tick(0.05); });
  await sleep(3000);
  const B = await visitor('B', viaMain, SHOTS ? [960, 540] : [480, 270]);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}` : 'timed out');
  const spot = await A.info();
  await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  await B.until((x) => x.traffic.mode !== 'local' && x.traffic.cars.length >= 3, 30000);
  let r = null;
  for (let k = 0; k < 30 && !r; k++) { r = await roles([A, B]); if (!r) await sleep(300); }
  check(!!r, 'one of the two is the host and the other its guest', r ? `${r.host.tag} hosts, ${r.guests[0].tag} is a guest` : 'no host');
  {
    // The guest eases onto the host's clock: wait for that to finish, then look several times.
    await r.guests[0].until((x) => x.traffic.mode !== 'guest' || (x.traffic.framesGot > 5 && Math.abs(x.traffic.signal.easing) < 30), 40000);
    let worst = 0, same = 0, looks = 0, gameApart = 0;
    for (let k = 0; k < 12; k++) {
      const [a, b] = await Promise.all([A.signal(), B.signal()]);
      // (Each page says what its signal time was and what the wall clock said at that same instant, so it does not
      // matter that two busy pages answer a moment apart.)
      worst = Math.max(worst, Math.abs((a.t - a.wall) - (b.t - b.wall)));
      gameApart = Math.abs(a.time - b.time);
      if (a.ew === b.ew && a.ns === b.ns) same++;
      looks++;
      await sleep(700);
    }
    const [na, nb] = await Promise.all([A.net(), B.net()]);
    // (The guest's lamps are meant to be behind the host's by exactly as much as the host's cars are on its screen:
    // 130 ms, the trip, and the wait for the page to get round to the message, which here is most of a slow frame.)
    // So the allowance is a third of a second and two of the slower page's frames; the lamps take 26 s to go round.
    const fps = Math.max(1, Math.min((await A.info()).fps, (await B.info()).fps)), allow = 0.3 + 2 / fps;
    check(worst < allow, `host and guest have the same signal time, within ${allow.toFixed(2)} s (frames here take ${(1000 / fps).toFixed(0)} ms)`, `at most ${worst.toFixed(2)} s apart over ${looks} looks (their game clocks are ${gameApart.toFixed(1)} s apart)`);
    // (Two looks may fall either side of a change of lamp: the two pages are read a moment apart.)
    check(same >= looks - 2, 'and the same lamps at the same crossing', `${same} of ${looks} looks`);
    check(na.traffic.signal.jumps === 1 && nb.traffic.signal.jumps === 1 && na.traffic.signal.town && nb.traffic.signal.town, 'each saw its lamps change clock once and no more', `A ${na.traffic.signal.jumps}, B ${nb.traffic.signal.jumps}`);
    // And the clock is the wall's, not the game's: ten seconds later it is ten seconds on, however slow the frames.
    const a0 = await A.signal(), w0 = Date.now();
    await sleep(5000);
    const a1 = await A.signal(), wall = (Date.now() - w0) / 1000;
    check(Math.abs(a1.t - a0.t - wall) < 0.5, 'the town clock keeps real time', `${(a1.t - a0.t).toFixed(2)} s in ${wall.toFixed(2)} s (game time moved ${(a1.time - a0.time).toFixed(2)} s)`);
  }

  // ── 3. A guest drives into the side of a standing shared car ──
  {
    let done = false, detail = 'no standing car found to drive at';
    for (let attempt = 0; attempt < 14 && !done; attempt++) {
      r = await roles([A, B]);
      if (!r) { await sleep(500); continue; }
      const G = r.guests[0], H = r.host;
      const hSpot = await H.info();
      const ng0 = await G.until((x) => x.traffic.mode === 'guest' && x.traffic.cars.some((c) => c.speed === 0 && c.driver === 'ai' && c.health === 100), 30000);
      if (!ng0) continue;
      const gi0 = await G.info();
      const stand = ng0.traffic.cars.filter((k) => k.speed === 0 && k.driver === 'ai' && k.health === 100).sort((p, q) => dist(p, gi0) - dist(q, gi0));
      const c = stand[attempt % Math.min(3, stand.length)];
      const s = Math.sin(c.h), co = Math.cos(c.h);
      // From its left (the middle of the road), square on to its door. (A standing car does not go sideways or turn by itself.)
      const start = { x: c.x - co * 12, z: c.z + s * 12 };
      const h0 = (await H.net()).traffic.cars.find((k) => k.id === c.id);
      if (!h0 || Math.abs(h0.speed) > 0.3) { detail = 'the car set off before the guest could line up'; continue; }
      const before = { g: (await G.net()).traffic, h: (await H.net()).traffic };
      await G.go(start.x, start.z, c.h + Math.PI / 2);
      await G.page.evaluate(() => window.__game.drive('sedan'));
      await G.page.keyboard.down('KeyW');
      let hit = false, guest = true, top = 0, nearest = 99;
      // (Game time runs several times slower than the wall here: frames are slow and a step is capped.)
      for (const end = Date.now() + 45000; Date.now() < end;) {
        const [x, i] = await Promise.all([G.net(), G.car()]);
        if (x.traffic.mode !== 'guest') { guest = false; break; }
        const now = x.traffic.cars.find((k) => k.id === c.id);
        if (now && i) nearest = Math.min(nearest, dist(now, i));
        if (i) top = Math.max(top, Math.abs(i.speed));
        if (x.traffic.hitsSent > before.g.hitsSent) { hit = true; break; }
        await sleep(100);
      }
      await G.page.keyboard.up('KeyW');
      if (!guest) { detail = 'the host changed in the middle'; continue; }
      if (!hit) { detail = `the guest never reached the car (nearest ${nearest.toFixed(1)} m)`; await G.go(hSpot.x + 4, hSpot.z + 1.5, 0); continue; }
      // Both screens, for three seconds: how far sideways the car has gone, how far it has turned, and its health.
      const side = (k) => (k.x - c.x) * co - (k.z - c.z) * s;
      let sideH = 0, sideG = 0, turnH = 0, turnG = 0, healthH = 100, healthG = 100, viewAt = 0, shot = !SHOTS;
      for (const end = Date.now() + 6000; Date.now() < end;) {
        const [xh, xg] = await Promise.all([H.net(), G.net()]);
        const kh = xh.traffic.cars.find((k) => k.id === c.id), kg = xg.traffic.cars.find((k) => k.id === c.id);
        const turn = (k) => Math.abs(Math.atan2(Math.sin(k.h - c.h), Math.cos(k.h - c.h)));
        if (kh) { sideH = Math.max(sideH, side(kh)); turnH = Math.max(turnH, turn(kh)); healthH = Math.min(healthH, kh.health); }
        if (kg) { sideG = Math.max(sideG, side(kg)); turnG = Math.max(turnG, turn(kg)); healthG = Math.min(healthG, kg.health); }
        if (!shot && !viewAt && kh && kg && healthG < 100) {
          // Both screens look at the struck car from the same place above the street.
          const view = [c.x - s * 13 - co * 5, spot.y + 11, c.z - co * 13 + s * 5, c.x + co * 1.5, spot.y + 0.5, c.z - s * 1.5];
          await Promise.all([H, G].map((t) => t.page.evaluate((v) => window.__game.view(...v), view)));
          viewAt = Date.now();
        }
        if (!shot && viewAt && Date.now() - viewAt > 1000) {
          shot = true;
          const shots = await Promise.all([H.shot('shots/net/bump-host.png'), G.shot('shots/net/bump-guest.png')]);
          console.log('shots', shots.join(' '), `(${H.tag} was the host, ${G.tag} the guest who hit car ${c.id})`);
          for (const t of [H, G]) await t.page.evaluate(() => window.__game.view());
        }
        await sleep(150);
      }
      const after = { g: (await G.net()).traffic, h: (await H.net()).traffic };
      const gi = await G.car();
      if (after.h.mode !== 'host' || after.g.mode !== 'guest') { detail = 'the host changed in the middle'; continue; }
      done = true;
      const sent = after.g.hitsSent - before.g.hitsSent, bytes = after.g.hitBytesSent - before.g.hitBytesSent, dealt = after.h.hitsDone - before.h.hitsDone;
      check(sent >= 1 && dealt >= 1 && G.out[4] >= sent, 'the guest told the host about the knock, and the host dealt it', `${G.tag} hit car ${c.id} (a ${c.kind}) at up to ${top.toFixed(1)} m/s: ${sent} report(s), ${bytes} bytes, ${dealt} dealt by ${H.tag}`);
      check(sent <= 12, 'in a handful of small messages', `${sent} frames of 10 bytes for one crash`);
      check((sideH > 0.1 || turnH > 0.04) && healthH < 100, 'on the HOST\'s screen the car is knocked sideways and damaged', `${sideH.toFixed(2)} m sideways, turned ${turnH.toFixed(2)} rad, health ${healthH}`);
      check((sideG > 0.1 || turnG > 0.04) && healthG < 100, 'on the GUEST\'s screen the same car is knocked sideways and damaged', `${sideG.toFixed(2)} m sideways, turned ${turnG.toFixed(2)} rad, health ${healthG} (shown in steps of 5)`);
      check(!!gi && nearest > 1.2, 'and the guest\'s own car stopped against it at once, without passing through', `never nearer than ${nearest.toFixed(2)} m, middle to middle (a sedan is 1.8 m wide)`);
      const host = await H.info();
      check(host.heat === 0, 'the host is not blamed for the guest\'s crash', `host heat ${host.heat}`);
    }
    if (!done) check(false, 'a guest drives into a shared car and it is knocked and damaged on both screens', detail);
  }

  // ── 4. Two players, head on, on main ──
  judgeHeadOn(await headOn(A, B, { x: -340, z: 291.8 }), 'main');
  {
    const errs = [...A.errors, ...B.errors];
    check(errs.length === 0, 'no errors from the game on either page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
  }
  await leave(A); await leave(B);

  // ── 5. A backup style connection: signals on game time, nothing reported, and the cars still bump ──
  const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
  let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
  check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
  await sleep(5000);
  {
    const [a, b] = await Promise.all([D.signal(), E.signal()]);
    [nd, ne] = await Promise.all([D.net(), E.net()]);
    check(a.own && b.own && a.t === a.time && b.t === b.time && nd.traffic.signal.jumps === 0 && ne.traffic.signal.jumps === 0, 'on the backup the signals stay on each browser\'s game time, as before', `D ${a.t.toFixed(2)} = ${a.time.toFixed(2)}, E ${b.t.toFixed(2)} = ${b.time.toFixed(2)}`);
  }
  // One of them rams a car of its own private traffic: that is nobody else's business.
  {
    const i0 = await D.info();
    let rammed = false, top = 0;
    for (let attempt = 0; attempt < 5 && !rammed; attempt++) {
      const x = await D.until((q) => q.traffic.cars.some((c) => c.speed === 0 && c.driver === 'ai'), 30000);
      if (!x) break;
      const c = x.traffic.cars.filter((k) => k.speed === 0 && k.driver === 'ai').sort((p, q) => dist(p, i0) - dist(q, i0))[attempt % 2] ?? x.traffic.cars[0];
      const s = Math.sin(c.h), co = Math.cos(c.h);
      await D.go(c.x - s * 12, c.z - co * 12, c.h);
      await D.page.evaluate(() => window.__game.drive('sedan'));
      await D.page.keyboard.down('KeyW');
      for (const end = Date.now() + 12000; Date.now() < end && !rammed;) {
        const [q, i] = await Promise.all([D.net(), D.car()]);
        const now = q.traffic.cars.find((k) => k.id === c.id);
        if (i) top = Math.max(top, Math.abs(i.speed));
        if (now && now.health < 100) rammed = true;
        await sleep(150);
      }
      await D.page.keyboard.up('KeyW');
    }
    [nd, ne] = await Promise.all([D.net(), E.net()]);
    check(rammed, 'on the backup a player rams a car of its own private traffic', `at up to ${top.toFixed(1)} m/s`);
    check(D.out[4] === 0 && E.out[4] === 0 && D.out[2] === 0 && E.out[2] === 0 && nd.traffic.hitsSent === 0 && ne.traffic.hitsGot === 0, 'and nothing about it is sent: no ToHost frame, no World frame', `on the wire: ToHost ${D.out[4] + E.out[4]}, World ${D.out[2] + E.out[2]}`);
  }
  judgeHeadOn(await headOn(D, E, { x: -340, z: 291.8 }), 'backup');
  {
    const errs = [...D.errors, ...E.errors];
    check(errs.length === 0, 'no errors on the backup pages', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
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
