// Riding together (Nov 23, src/net/ride.ts): a player joins another player's car as a passenger. Headless browsers
// against LOCAL stand-ins (the Node home as main, as hard1.mjs does; the real Cloudflare Worker is never touched).
//
//   node tools/net/ride.mjs            (add --shots to save pictures of the passenger seated to shots/ride-*.png)
//
// Three players: D drives, P rides, W watches (and later drives).
//  1. all three online on main;
//  2. P stands beside D's car: P is offered "Ride with <D>", presses F and is seated; D's car lists P; P is drawn
//     sitting in that seat on all three screens, and the three agree where (the car standing still);
//  3. D drives off and then across town: P stays in the seat on every screen all the way (each screen's passenger is
//     within the car as that screen draws it), and P's own camera follows the car;
//  4. P presses F: out beside the car, on foot, unhurt; D's list empties; the others draw P standing;
//  5. P rides again and D leaves town mid-ride: P is stood beside the car safely;
//  6. P rides with W; P's page reloads mid-ride (reconnect): back on foot, W's list drops P, and P can ride again;
//  7. W gets out with P aboard: P is put out; W wrecks the car with P aboard: P is thrown;
//  8. a car with every seat taken offers no ride; no errors on any page.
// Every line carries the facts it was judged on. PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { services, check, failures, sleep, wait, ownCar, f1 } from './hardlib.mjs';

/** Claude FM (audio/claudefm.ts) asks youtube.com for its player whenever a radio plays in a car, a passenger's too: not this test's business. */
const RADIO = /youtube\.com|ytimg\.com|ggpht\.com|googlevideo\.com/;

const SHOTS = process.argv.includes('--shots');
const S = services({ main: 8961, lookup: 8962, backup: 8963 });
const SPOT = { x: -360, z: 294.8 };
const FAR = { x: 313.5, z: 262 };
const size = SHOTS ? [800, 450] : [480, 270];

/** The passenger as one screen has them: own (this page is P) or another's body, and that screen's car they sit in. */
const view = (t, pid, did) => t.page.evaluate(([pid, did]) => {
  const g = window.__game.game, net = g.net, p = g.player;
  const r3 = (v) => +v.toFixed(3);
  if (net.conn.id === pid) {
    const v = p.riding, per = p.person;
    return { self: true, seated: !!v, visible: per.visible, pose: per.pose, x: r3(per.x), y: r3(per.y), z: r3(per.z), car: v ? { x: r3(v.x), z: r3(v.z), h: v.h } : null, cam: g.cam.mode ?? null };
  }
  const r = net.remotes.get(pid), b = r && r.body;
  const car = did === net.conn.id ? p.vehicle : net.remotes.get(did)?.vehicle;
  return { self: false, mode: r ? r.mode : -1, seated: !!r && r.mode === 3, visible: !!b && b.visible, pose: b ? b.pose : null, x: b ? r3(b.x) : 0, y: b ? r3(b.y) : 0, z: b ? r3(b.z) : 0, car: car ? { x: r3(car.x), z: r3(car.z), h: car.h } : null };
}, [pid, did]);
/** How far the passenger sits from the middle of the car on that screen (a seat is 0.4 to 1.5 m from it). */
const inCar = (v) => v.car ? Math.hypot(v.x - v.car.x, v.z - v.car.z) : 99;
const ride = (t) => t.page.evaluate(() => window.__game.net().ride);
const mode = (t) => t.page.evaluate(() => { const p = window.__game.game.player; return { riding: !!p.riding, driving: !!p.vehicle, health: p.health, pose: p.person.pose, x: p.person.x, z: p.person.z, prompt: window.__game.game.hud.promptText }; });
/** Stand t beside car (at its right side, `out` m from the middle), facing it. */
const beside = (t, car, out = 2.4, back = 0) => t.go(car.x - Math.cos(car.h) * out - Math.sin(car.h) * back, car.z + Math.sin(car.h) * out - Math.cos(car.h) * back, car.h - Math.PI / 2);
const board = async (t, did) => {
  const offered = await wait(async () => (await ride(t)).offer === did, 15000);
  if (!offered) return { offered: false, seated: false };
  await t.key('KeyF');
  const seated = await wait(async () => { const r = await ride(t); return r.riding && r.riding.driver === did; }, 8000);
  return { offered: true, seated: !!seated };
};

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8961)) || !(await S.up(8963))) throw new Error('the local services did not start (run `npm ci` in server/ once)');
  const D = await S.visitor('D', S.viaMain, size), P = await S.visitor('P', S.viaMain, size);
  let W = await S.visitor('W', S.viaMain, size);
  const all = [D, P, W];
  const ns = await Promise.all(all.map((t) => t.until((x) => x.status === 'online' && x.count === 3 && x.home === 'main', 90000)));
  check(ns.every(Boolean), '1. three players online on main', ns.map((x, i) => x ? `${all[i].tag}#${x.id}` : `${all[i].tag} timed out`).join(', '));
  if (!ns.every(Boolean)) throw new Error('not online');
  const [did, pid, wid] = ns.map((x) => x.id);

  // ── 2. Getting in ──
  await D.go(SPOT.x, SPOT.z, Math.PI / 2);
  await ownCar(D, 'sedan');
  await sleep(1500);
  const car0 = await D.car();
  await beside(P, car0, 2.4);
  await W.go(car0.x - Math.cos(car0.h) * 8 + Math.sin(car0.h) * 3, car0.z + Math.sin(car0.h) * 8 + Math.cos(car0.h) * 3, car0.h - Math.PI / 2 - 0.35);
  const b1 = await board(P, did);
  const m1 = await mode(P);
  check(b1.offered, '2. P beside D\'s car is offered a ride', `offer from #${did}`);
  check(b1.seated && m1.riding, '2. F seats P as D\'s passenger', JSON.stringify((await ride(P)).riding));
  const dl = await wait(async () => { const r = await ride(D); return r.riders.some((e) => e[0] === pid) ? r : null; }, 5000);
  check(!!dl, '2. D\'s car lists P', dl ? JSON.stringify(dl.riders) : 'not listed');
  await sleep(2000);
  {
    const [vp, vd, vw] = [await view(P, pid, did), await view(D, pid, did), await view(W, pid, did)];
    const okSeat = (v) => v.seated && v.visible && v.pose === 'sit' && inCar(v) > 0.3 && inCar(v) < 1.8;
    check(okSeat(vp) && okSeat(vd) && okSeat(vw), '2. P drawn sitting in the car on all three screens', [vp, vd, vw].map((v, i) => `${['P', 'D', 'W'][i]}: ${v.visible ? 'shown' : 'hidden'} ${v.pose} ${f1(inCar(v))} m from the car`).join('; '));
    const spread = Math.max(Math.hypot(vp.x - vd.x, vp.z - vd.z), Math.hypot(vp.x - vw.x, vp.z - vw.z), Math.hypot(vd.x - vw.x, vd.z - vw.z));
    check(spread < 0.3, '2. the three screens agree where P sits (car standing)', `largest difference ${spread.toFixed(3)} m`);
    if (SHOTS) {
      // Daylight, the reference card filed away; P and D as their own cameras show it; W (and a second of D) pinned
      // beside the passenger's window.
      for (const t of all) { await t.key('KeyK'); await t.page.evaluate(() => window.__game.setTime(13)); }
      await sleep(3000);
      const pin = (t, out, up) => t.page.evaluate(([out, up]) => {
        const g = window.__game.game, b = g.player.riding ? g.player.person : null;
        const r = [...g.net.remotes.values()].find((o) => o.mode === 3), per = b ?? (r && r.body);
        if (!per) return false;
        const s = Math.sin(per.h), c = Math.cos(per.h);
        window.__game.view(per.x - c * out + s * 1.2, per.y + up, per.z + s * out + c * 1.2, per.x, per.y + 0.9, per.z);
        return true;
      }, [out, up]);
      await P.page.screenshot({ path: 'shots/ride-P.png' });
      await D.page.screenshot({ path: 'shots/ride-D.png' });
      await pin(W, 3.2, 1.5);
      await pin(D, 2.6, 1.3);
      await sleep(800);
      await W.page.screenshot({ path: 'shots/ride-W.png' });
      await D.page.screenshot({ path: 'shots/ride-D-window.png' });
      for (const t of [W, D]) await t.page.evaluate(() => window.__game.view());
      console.log('NOTE  pictures: shots/ride-P.png (the passenger\'s own screen), shots/ride-D.png (the driver\'s), shots/ride-D-window.png and shots/ride-W.png (driver and watcher, camera at the passenger window)');
    }
  }

  // ── 3. Driving off, and across town ──
  {
    const c0 = await D.car();
    await D.page.keyboard.down('KeyW');
    let worst = 0, n = 0, camOk = true;
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      for (const [t, k] of [[P, 'P'], [W, 'W'], [D, 'D']]) {
        const v = await view(t, pid, did);
        if (!v.seated || !v.visible) worst = 99; else worst = Math.max(worst, inCar(v));
        if (k === 'P' && v.cam !== null && v.cam !== 'drive') camOk = false;
        n++;
      }
    }
    await D.page.keyboard.up('KeyW');
    const c1 = await D.car();
    const went = Math.hypot(c1.x - c0.x, c1.z - c0.z);
    check(went > 10, '3. D drove off with P aboard', `${f1(went)} m`);
    check(worst < 1.8, '3. P stays in the seat on every screen while the car moves', `${n} looks, furthest from the car ${worst === 99 ? 'NOT SEATED' : f1(worst) + ' m'}`);
    check(camOk, '3. P\'s camera follows the car (the chase view)');
    // Across town: the car is put down a long way off, as a long drive ends.
    await D.page.evaluate(([x, z]) => { const v = window.__game.game.player.vehicle; v.x = x; v.z = z; v.vx = v.vz = 0; }, [FAR.x, FAR.z]);
    await sleep(2500);
    const [vp, vd, vw] = [await view(P, pid, did), await view(D, pid, did), await view(W, pid, did)];
    const there = (v) => v.seated && v.visible && Math.hypot(v.x - FAR.x, v.z - FAR.z) < 3;
    check(there(vp) && there(vd) && there(vw), '3. across town P is still in the car on every screen', [vp, vd, vw].map((v, i) => `${['P', 'D', 'W'][i]} ${f1(v.x)},${f1(v.z)}`).join('; '));
    const spread = Math.max(Math.hypot(vp.x - vd.x, vp.z - vd.z), Math.hypot(vp.x - vw.x, vp.z - vw.z));
    check(spread < 0.3, '3. the screens agree where P sits there', `largest difference ${spread.toFixed(3)} m`);
  }

  // ── 4. Getting out ──
  {
    const h0 = (await mode(P)).health;
    await P.key('KeyF');
    const out = await wait(async () => { const m = await mode(P); return !m.riding ? m : null; }, 5000);
    await sleep(1200);
    const m = await mode(P), c = await D.car();
    check(!!out && !m.riding && !m.driving && m.health >= h0 && Math.hypot(m.x - c.x, m.z - c.z) < 4.5, '4. F puts P out beside the car, unhurt', `${f1(Math.hypot(m.x - c.x, m.z - c.z))} m from it, health ${m.health}, pose ${m.pose}`);
    const dl2 = await wait(async () => { const r = await ride(D); return r.riders.length === 0 ? r : null; }, 4000);
    check(!!dl2, '4. D\'s car lists nobody');
    const vw = await wait(async () => { const v = await view(W, pid, did); return !v.seated && v.visible && v.pose !== 'sit' ? v : null; }, 4000);
    check(!!vw, '4. W draws P standing again', vw ? `pose ${vw.pose}` : JSON.stringify(await view(W, pid, did)));
  }

  // ── 5. The driver leaves town mid-ride ──
  {
    await W.go(FAR.x + 20, FAR.z + 20, 0);
    const c = await D.car();
    await beside(P, c, 2.4);
    const b = await board(P, did);
    check(b.seated, '5. P rides with D again');
    await sleep(1000);
    const h0 = (await mode(P)).health;
    await D.leave();
    const out = await wait(async () => { const m = await mode(P); return !m.riding ? m : null; }, 12000);
    await sleep(1500);
    const m = await mode(P);
    check(!!out && m.health >= h0 && m.pose !== 'down' && Math.hypot(m.x - c.x, m.z - c.z) < 5, '5. D left town: P stands beside where the car was, safely', `${f1(Math.hypot(m.x - c.x, m.z - c.z))} m from it, health ${m.health}, pose ${m.pose}`);
  }

  // ── 6. Riding with W; P reconnects mid-ride ──
  {
    await W.go(FAR.x, FAR.z + 10, 0);
    await ownCar(W, 'cmax');
    await sleep(1500);
    const c = await W.car();
    await beside(P, c, 2.4);
    const b = await board(P, wid);
    check(b.seated, '6. P rides with W (a C-Max)');
    await sleep(1200);
    await P.page.reload({ waitUntil: 'load' });
    await P.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
    await P.page.evaluate(() => window.__game.start());
    const back = await P.until((x) => x.status === 'online' && x.count === 2, 60000);
    const m = await mode(P);
    check(!!back && !m.riding, '6. P\'s page reloaded mid-ride: back in town, on foot', back ? `#${back.id}` : 'not back');
    const wl = await wait(async () => { const r = await ride(W); return r.riders.length === 0 ? r : null; }, 8000);
    check(!!wl, '6. W\'s car no longer lists the old P');
    const np = back ? back.id : pid;
    await beside(P, await W.car(), 2.4);
    const b2 = await board(P, wid);
    await sleep(1500);
    const vw = await view(W, np, wid);
    check(b2.seated && vw.seated && vw.visible && inCar(vw) < 1.8, '6. P rides with W again after reconnecting, drawn in the seat on W\'s screen', `${f1(inCar(vw))} m from the car`);

    // ── 7. W gets out with P aboard; then wrecks with P aboard ──
    await W.key('KeyF');
    const out = await wait(async () => { const mm = await mode(P); return !mm.riding ? mm : null; }, 6000);
    check(!!out, '7. W got out: P is put out too', out ? `pose ${out.pose}` : 'still riding');
    await sleep(2000);
    const c2 = await W.car() ?? await W.page.evaluate(() => { const g = window.__game.game, v = g.vehicles.nearest(g.player.x, g.player.z, 8); if (v) g.player.enter(v, true); return !!v; });
    const wc = await W.car();
    if (wc) {
      await beside(P, wc, 2.4);
      const b3 = await board(P, wid);
      await sleep(1200);
      const t0 = (await ride(P)).thrown;
      await W.page.evaluate(() => { window.__game.game.player.vehicle.wreck = true; });
      const thrown = await wait(async () => { const r = await ride(P); return r.thrown > t0 ? r : null; }, 6000);
      const mm = await mode(P);
      check(b3.seated && !!thrown && !mm.riding, '7. the car wrecked with P aboard: P is thrown out', `thrown ${thrown ? thrown.thrown : 0}, pose ${mm.pose}`);
    } else check(false, '7. W back in a car for the wreck', String(c2));
  }

  // ── 8. A full car offers no ride; no errors ──
  {
    await W.page.evaluate(() => { const g = window.__game.game; if (g.player.vehicle) g.player.exit(); });
    await sleep(800);
    await W.go(FAR.x + 30, FAR.z + 30, 0);
    await ownCar(W, 'coupe');
    await sleep(1200);
    // A pretend passenger fills the coupe's one seat on P's screen (W's list says somebody sits there).
    const c = await W.car();
    await P.page.evaluate(([wid]) => { const r = window.__game.game.net.ride; r.lists.set(wid, [[250, 0]]); }, [wid]);
    await beside(P, c, 2.4);
    await sleep(1500);
    const r = await ride(P);
    check(r.offer !== wid, '8. a coupe with its one seat taken offers no ride', `offer ${r.offer}`);
    await P.page.evaluate(([wid]) => window.__game.game.net.ride.lists.delete(wid), [wid]);
    for (const t of [P, W]) { const e = t.errs().filter((x) => !RADIO.test(x)); check(e.length === 0, `8. no errors on ${t.tag}'s page`, e.slice(0, 3).join(' | ')); }
    const rs = await Promise.all([ride(P), ride(W)]);
    console.log(`NOTE  P: ${rs[0].ridesSent} Ride events sent, ${rs[0].seatsGot} Seats heard; W: ${rs[1].seatsSent} Seats sent`);
  }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
} finally {
  await S.end();
}
console.log(failures() ? `${failures()} FAILED` : 'ALL PASS');
process.exit(failures() ? 1 : 0);
