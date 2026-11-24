// Fast travel in a shared town (src/game/travel.ts, PlayerEvent.Cab 22). Headless browsers against LOCAL stand-ins
// (the Node home as main, as ride.mjs does; ports 8811-8813; the real Cloudflare Worker is never touched).
//
//   node tools/net/travel.mjs
//
// Three players: D takes the cab, P rides with D, W watches.
//  1. all three online;
//  2. D on foot takes the cab across the island: W sees D vanish from the start and appear at the destination
//     (D's copy on W's screen within a few metres of where D really stands), D is charged, W heard the two puffs;
//  3. D drives with P aboard and takes the cab to the other end of town: the car is on a lane at the destination,
//     P is still seated in it on P's own screen, on D's and on W's, all within the car;
//  4. P, a passenger, is refused the cab ("ask your driver");
//  5. no errors on any page.
// PASS or FAIL per check; ALL PASS at the end; exits 1 on a FAIL.

import { services, check, failures, sleep, wait, ownCar, f1 } from './hardlib.mjs';

const S = services({ main: 8811, lookup: 8812, backup: 8813 });
const SPOT = { x: -360, z: 294.8 };
const A = { name: 'Flounder Field (the arena lot)', x: -476, z: -70, nx: -1, nz: 0 };
const B = { name: 'Pelican Pier (the landing)', x: 0, z: 400, nx: 0, nz: 1 };

/** Where W draws D (body on foot, or the ghost car) and how far that is from where D really stands. */
const seen = async (W, did) => W.page.evaluate((did) => {
  const g = window.__game.game, r = g.net.remotes.get(did);
  if (!r) return null;
  return { x: r.x, z: r.z, mode: r.mode, seen: r.seen, cabs: g.net.cabsGot };
}, did);
const me = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.player; return { x: p.x, z: p.z, money: p.money, car: !!p.vehicle, riding: !!p.riding, active: g.todo.travel.active }; });
const take = (t, dest) => t.page.evaluate((d) => { const g = window.__game.game, cab = g.todo.travel; g.player.heat = 0; g.player.money = 300; const m0 = g.player.money; const r = cab.go(d); return { r, m0, label: cab.label(d).text }; }, dest);
const settle = async (t) => wait(async () => !(await me(t)).active, 15000, 200);

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8811)) || !(await S.up(8813))) throw new Error('the local services did not start (run `npm ci` in server/ once)');
  const size = [480, 270];
  const D = await S.visitor('D', S.viaMain, size), P = await S.visitor('P', S.viaMain, size), W = await S.visitor('W', S.viaMain, size);
  const all = [D, P, W];
  const ns = await Promise.all(all.map((t) => t.until((x) => x.status === 'online' && x.count === 3 && x.home === 'main', 90000)));
  check(ns.every(Boolean), '1. three players online on main', ns.map((x, i) => x ? `${all[i].tag}#${x.id}` : `${all[i].tag} timed out`).join(', '));
  if (!ns.every(Boolean)) throw new Error('not online');
  const [did, pid] = ns.map((x) => x.id);

  // ── 2. On foot ──
  await D.go(SPOT.x, SPOT.z, 0); await W.go(SPOT.x + 5, SPOT.z, 0); await P.go(SPOT.x - 5, SPOT.z, 0);
  await sleep(2500);
  const v0 = await seen(W, did);
  check(!!v0 && Math.hypot(v0.x - SPOT.x, v0.z - SPOT.z) < 4, '2. W sees D at the start', v0 ? `${f1(Math.hypot(v0.x - SPOT.x, v0.z - SPOT.z))} m off` : 'no copy');
  const c0 = v0?.cabs ?? 0;
  const t1 = await take(D, A);
  check(t1.r === '', '2. D books the cab on foot', t1.r || t1.label);
  await settle(D);
  const dm = await me(D);
  await sleep(2500);
  const v1 = await seen(W, did);
  const off = v1 ? Math.hypot(v1.x - dm.x, v1.z - dm.z) : 99;
  check(Math.hypot(dm.x - A.x, dm.z - A.z) < 40, '2. D arrives near the destination', `${f1(Math.hypot(dm.x - A.x, dm.z - A.z))} m from the door`);
  check(!!v1 && off < 3 && Math.hypot(v1.x - SPOT.x, v1.z - SPOT.z) > 100, '2. W sees D at the destination, not where D left', v1 ? `W draws D ${f1(off)} m from where D stands` : 'no copy');
  check(dm.money < t1.m0 && t1.m0 - dm.money >= 5, '2. the fare was charged', `$${t1.m0} -> $${f1(dm.money)}`);
  check((v1?.cabs ?? 0) - c0 >= 2, '2. W heard the leaving and the arriving puff (Cab events)', `${(v1?.cabs ?? 0) - c0} heard`);

  // ── 3. Driving with a passenger ──
  await D.go(SPOT.x, SPOT.z, Math.PI / 2);
  await ownCar(D, 'sedan');
  await sleep(1500);
  const car0 = await D.car();
  await P.go(car0.x - Math.cos(car0.h) * 2.4, car0.z + Math.sin(car0.h) * 2.4, car0.h - Math.PI / 2);
  const offered = await wait(async () => (await P.page.evaluate(() => window.__game.net().ride)).offer === did, 15000);
  await P.key('KeyF');
  const seated = await wait(async () => { const r = await P.page.evaluate(() => window.__game.net().ride); return r.riding && r.riding.driver === did; }, 8000);
  check(!!offered && !!seated, '3. P is seated in D\'s car', offered ? 'offered, seated' : 'no offer');
  const t2 = await take(D, B);
  check(t2.r === '', '3. D books the cab in the car', t2.r || t2.label);
  await settle(D);
  await sleep(3000);
  const dm2 = await me(D);
  const dc = await D.car();
  const pv = await P.page.evaluate(() => { const g = window.__game.game, p = g.player, v = p.riding; return { riding: !!v, x: p.person.x, z: p.person.z, cx: v ? v.x : 0, cz: v ? v.z : 0 }; });
  const wv = await W.page.evaluate((did) => { const g = window.__game.game, r = g.net.remotes.get(did); const rp = [...g.net.remotes.values()].find((o) => o.mode === 3); return { car: r ? [r.x, r.z] : null, pass: rp && rp.body ? [rp.body.x, rp.body.z] : null }; }, did);
  check(!!dc && dm2.car && Math.hypot(dm2.x - B.x, dm2.z - B.z) < 80 && Math.hypot(dm2.x - car0.x, dm2.z - car0.z) > 300, '3. D\'s car arrives near the destination, D still driving', `${f1(Math.hypot(dm2.x - B.x, dm2.z - B.z))} m from the stop`);
  check(pv.riding && Math.hypot(pv.x - pv.cx, pv.z - pv.cz) < 2.2 && Math.hypot(pv.cx - dm2.x, pv.cz - dm2.z) < 2, '3. P travelled along: still seated in the car on P\'s own screen', `${f1(Math.hypot(pv.x - pv.cx, pv.z - pv.cz))} m from the seat; car ${f1(Math.hypot(pv.cx - dm2.x, pv.cz - dm2.z))} m from D\'s`);
  check(!!wv.car && !!wv.pass && Math.hypot(wv.car[0] - dm2.x, wv.car[1] - dm2.z) < 3 && Math.hypot(wv.pass[0] - wv.car[0], wv.pass[1] - wv.car[1]) < 2.2, '3. W sees the car at the destination with P in it', wv.car && wv.pass ? `car ${f1(Math.hypot(wv.car[0] - dm2.x, wv.car[1] - dm2.z))} m from D, P ${f1(Math.hypot(wv.pass[0] - wv.car[0], wv.pass[1] - wv.car[1]))} m from the car` : JSON.stringify(wv));

  // ── 4. A passenger cannot book ──
  const t3 = await P.page.evaluate((d) => { const g = window.__game.game; g.player.money = 300; return g.todo.travel.label(d); }, A);
  check(!t3.ok && /passenger/.test(t3.text), '4. P, a passenger, is told to ask the driver', t3.text);

  const errs = all.flatMap((t) => t.errs().map((e) => `${t.tag}: ${e}`));
  check(errs.length === 0, '5. no errors on any page', errs.slice(0, 3).join(' | '));
} catch (e) {
  check(false, 'the test ran to its end', String(e && e.message || e));
} finally {
  await S.end();
}
console.log(failures() ? `FAILED: ${failures()}` : 'ALL PASS');
process.exit(failures() ? 1 : 0);
