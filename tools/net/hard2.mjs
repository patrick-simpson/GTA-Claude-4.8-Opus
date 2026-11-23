// Multiplayer stage 5, hardening, part 2: JOINING A RUNNING CITY, RECONNECTING, and MAIN RESTARTING. Headless
// browsers against LOCAL services.
//
//   node tools/net/hard2.mjs
//
// The Node home on 8884 is "main" (found through a lookup stand-in on 8885), a second copy on 8886 the backup. Page C
// reaches main through a small stand-in for the NETWORK on 8887 (its own lookup on 8889 names that address): a TCP
// relay that can hold everything both ways for a while, as a dropped Wi-Fi does, and then either let it all through
// (a short drop: the socket survives) or, if main gave up on the socket meanwhile, reset it (a long drop: the socket
// dies when the network comes back, as it does in real life). Never run two network tests at once.
//  1. A joins a city already running: A (the host) is on a mission with B on its crew, B is wanted (police and the
//     helicopter after B), a wreck stands, props are down and a car is alight. C joins: C is shown all of it (the
//     police, the one helicopter, the wreck, the props, the fire, A's mission van as A's), and is on nobody's crew.
//  2. C, a helper at the wheel of A's lent van, loses the network for 10 s: back in the same seat, nothing doubled,
//     still on the crew and at the wheel.
//  3. The same, 60 s, and C in the pause menu: main lets C go; when the network comes back C has a new seat, A has no
//     ghost of the old one, C is on nobody's crew, the van is there once (A's), and once C resumes nobody sees PAUSED.
//  3b. NOT judged, printed: C is the starter and A drives C's lent van when C loses the network for 60 s.
//  4. C runs a tow and loses the network for 60 s: the car to tow leaves the others' screens with C, and comes back
//     with C (once).
//  5. MAIN restarts (stopped; started again a little later at a NEW address, as its self update does with a new
//     tunnel address): everybody falls back to the backup in one town, then goes back to main by themselves (the
//     background try is shortened to 5 s), and the town's facts (bridge, clock, weather seed) are the same.
// Every line carries the facts it was judged on. PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import net from 'node:net';
import { createServer } from 'node:http';
import {
  services, check, note, failures, sleep, wait, rolesSoon, modes, look, lookText, propsNear, knock, downAt, pickParked,
  startM, read, shownHeld, townCarsNear, onFoot, ownCar, f1,
} from './hardlib.mjs';

const MAIN = 8884, LOOKUP = 8885, BACKUP = 8886, RELAY = 8887, NEWMAIN = 8888, CLOOKUP = 8889;
const S = services({ main: MAIN, lookup: LOOKUP, backup: BACKUP });
const MSPOT = { x: 313.5, z: 262 };

// ── The network stand-in for C ──
const relay = { target: MAIN, hold: false, conns: new Set(), resets: 0, flushed: 0 };
const relayServer = net.createServer((client) => {
  const c = { client, up: net.connect(relay.target, '127.0.0.1'), toUp: [], toClient: [], upGone: false };
  relay.conns.add(c);
  client.on('data', (d) => { if (relay.hold) c.toUp.push(d); else c.up.write(d); });
  c.up.on('data', (d) => { if (relay.hold) c.toClient.push(d); else client.write(d); });
  // Main closed its end: with the network up the browser hears it; with it down, nothing reaches the browser now.
  c.up.on('close', () => { c.upGone = true; if (!relay.hold) client.destroy(); });
  c.up.on('error', () => {});
  client.on('close', () => { relay.conns.delete(c); c.up.destroy(); });
  client.on('error', () => {});
}).listen(RELAY, '127.0.0.1');
/** The network back: everything held goes on; a socket main gave up on meanwhile is reset (the browser's next word gets an RST). */
function release() {
  relay.hold = false;
  for (const c of relay.conns) {
    if (c.upGone) { relay.resets++; c.client.resetAndDestroy(); continue; }
    for (const d of c.toUp.splice(0)) c.up.write(d);
    for (const d of c.toClient.splice(0)) c.client.write(d);
    relay.flushed++;
  }
}
const cLookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${RELAY}` }));
}).listen(CLOOKUP, '127.0.0.1');
const viaRelay = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${CLOOKUP}`)}&netprobe=5`;

const keepWanted = async (t, lvl = 4) => { await t.heal(); const n = await t.net(); if (n.police.level < lvl) await t.heat(lvl); };
const remoteIds = (n) => n.remotes.map((r) => r.id);
async function getIn(t, c, kind, tries = 3) {
  for (let k = 0; k < tries; k++) {
    await t.go(c.x + Math.cos(c.h) * 2.3 * (k % 2 ? 1 : -1), c.z - Math.sin(c.h) * 2.3 * (k % 2 ? 1 : -1), c.h);
    await sleep(700);
    await t.key('KeyF');
    const ok = await wait(async () => { const v = await t.car(); return v && v.kind === kind; }, 15000);
    if (ok) return true;
  }
  return false;
}
/** Vans within 6 m of (x, z) on a screen: its own (`mine`), and other players' and held cars drawn there (`drawn`; a held car drawn is a ghost too: counted once). */
const vansNear = (t, x, z) => t.ask((g, [x, z]) => {
  const near = (v) => v.spec.kind === 'van' && !v.removed && !v.sunk && Math.hypot(v.x - x, v.z - z) < 6;
  return { mine: g.vehicles.list.filter(near).map((v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1), held: !!v.held, lent: !!v.lent, shared: !!v.shared, me: g.player.vehicle === v })), drawn: new Set([...g.vehicles.ghostList, ...g.net.held.list()].filter(near)).size };
}, [x, z]);

S.startMain(); S.startBackup();
try {
  if (!(await S.up(MAIN)) || !(await S.up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await S.visitor('A', `${S.viaMain}&netprobe=5`);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await S.visitor('B', `${S.viaMain}&netprobe=5`);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2, 60000);
  const an = await A.net(), bn = await B.net();
  let r = await rolesSoon([A, B], 60000);
  check(!!r && r.host === A, 'two in town: A the host, B its guest', await modes([A, B]));

  // ── 1. C joins a city already running ──
  let C = null, cn = null;
  const things = {};
  {
    const label = 'C joins mid mission, mid chase, with a fire, a wreck and props down';
    const kerb = await A.page.evaluate(([x, z]) => { const nd = window.__game.game.plan.nearestNode(x, z); return nd.x + nd.hx + 2.2; }, [MSPOT.x, MSPOT.z]);
    things.kerb = kerb;
    await A.go(kerb, MSPOT.z - 3); await B.go(kerb, MSPOT.z - 10);
    for (const t of [A, B]) await t.calm();
    await sleep(3000);
    await startM(A, 'm03', 2);
    const drafted = await wait(async () => (await B.crew()).boss === an.id, 20000);
    await read(A);
    const van = await A.mine('van');
    things.van = van;
    check(!!drafted && !!van, 'setting up: B is on A\'s crew, the van stands', `B boss ${(await B.crew()).boss}; van ${JSON.stringify(van)}`);
    // A wreck, two props down, then the chase, then a car alight.
    const w = await B.ask(pickParked, [kerb, MSPOT.z, 15, 80, []]);
    if (w) await A.page.evaluate(async (w) => { const g = window.__game.game, v = g.net.cars.parkedAt(w.place); if (!v) return; const { charCar } = await import('/src/ent/weapons.ts'); charCar(v); }, w);
    things.wreck = w;
    things.props = [];
    for (const p of (await A.ask(propsNear, [kerb, MSPOT.z, 50])).filter((p) => p.d > 6).slice(0, 2)) if (await A.ask(knock, [p.x, p.z, 3, 0])) things.props.push(p);
    await keepWanted(B);
    const ch = await wait(async () => { await keepWanted(B); const x = await A.net(); return x.police.units.some((u) => u.after === bn.id) && x.police.heli.present ? x : null; }, 90000, 500);
    const f = await B.ask(pickParked, [kerb, MSPOT.z, 15, 80, w ? [w.place] : []]);
    if (f) await A.page.evaluate((f) => { const v = window.__game.game.net.cars.parkedAt(f.place); if (v) v.health = 15; }, f);
    things.fire = f;
    check(!!w && !!f && things.props.length === 2 && !!ch, 'setting up: a wreck, two props down, B chased with the helicopter up, a car alight', `wreck ${JSON.stringify(w)}, fire ${JSON.stringify(f)}, props ${things.props.length}, chase ${ch ? ch.police.units.length + ' cars' : 'none'}`);
    C = await S.visitor('C', viaRelay);
    await C.pin(true);
    await C.go(kerb + 6, MSPOT.z - 20);
    n = await C.until((x) => x.status === 'online' && x.count === 3 && x.home === 'main', 90000);
    cn = await C.net();
    check(!!n, `${label}: C is in town on main (through the network stand-in)`, await modes([A, B, C]));
    await sleep(6000);
    await keepWanted(B);
    const seen = await wait(async () => {
      await keepWanted(B);
      const [x, h] = await Promise.all([C.net(), A.net()]);
      return x.police.mode === 'guest' && x.police.units.length >= 1 && x.police.heli.present && x.police.heli.shown && h.police.heli.present ? { x, h } : null;
    }, 30000, 500);
    const cx = seen ? seen.x : await C.net(), hx = seen ? seen.h : await A.net();
    check(!!seen, `${label}: C is shown the police and the one helicopter`, `C: ${cx.police.units.length} cars (A runs ${hx.police.units.length}), heli ${cx.police.heli.present ? (cx.police.heli.shown ? 'shown' : 'OWN') : 'none'}`);
    const cw = w ? await wait(() => C.ask((g, [x, z]) => g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 3), [w.x, w.z]), 15000) : null;
    check(!!cw, `${label}: C is shown the wreck`, JSON.stringify(w));
    const cp = await wait(async () => { for (const p of things.props) if (!(await C.ask(downAt, [p.x, p.z]))) return false; return true; }, 15000);
    check(!!cp && things.props.length === 2, `${label}: C has the props that are down`, things.props.map((p) => `${p.kind} ${f1(p.x)},${f1(p.z)}`).join('; '));
    const cf = f ? await wait(() => C.ask((g, [x, z]) => g.player.weapons.burnInfo().some((b) => Math.hypot(b.x - x, b.z - z) < 4) || g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 14), [f.x, f.z]), 15000) : null;
    check(!!cf, `${label}: C is shown the car alight (or what is left of it)`, JSON.stringify(f));
    const cv = van ? await shownHeld(C, van.x, van.z) : null;
    const town = van ? townCarsNear(await A.net(), van.x, van.z, 2) : [];
    check(!!cv && cv.d < 1.5 && town.length === 0, `${label}: C is shown A's mission van as A's, not as one of the town's`, `on C ${JSON.stringify(cv)}; A's town cars there ${JSON.stringify(town)}`);
    const [cc, ac] = await Promise.all([C.crew(), A.crew()]);
    check(cc.boss === 0 && !cc.guest && ac.team.length === 1 && ac.team[0] === bn.id, `${label}: C, who was not there when it began, is on nobody's crew`, `C boss ${cc.boss}; A's crew [${ac.team}]`);
    const lc = await C.ask(look, [kerb, MSPOT.z, 120]);
    check(lc.doubles.length === 0, `${label}: no car is there twice on C's screen`, lookText(lc));
    await B.heat(0);
    for (const t of [A, B, C]) await t.calm();
    await A.page.evaluate(() => window.__game.game.todo.missions.abandon());
    await wait(async () => (await B.crew()).boss === 0, 15000);
  }

  // A mission with C on the crew, C at the wheel of the lent van.
  const kerb = things.kerb;
  const helper = async (label) => {
    for (const t of [A, B, C]) await onFoot(t);
    await A.go(kerb, MSPOT.z - 3); await C.go(kerb, MSPOT.z - 9); await B.go(kerb, MSPOT.z - 70);
    for (const t of [A, B, C]) await t.calm();
    await sleep(3000);
    await startM(A, 'm03', 2);
    const d = await wait(async () => (await C.crew()).boss === an.id, 20000);
    await read(A);
    const van = await A.mine('van');
    await sleep(2500);
    const ok = !!d && !!van && await getIn(C, van, 'van');
    await sleep(2500);
    const car = await C.car(), ac = await A.crew();
    check(ok && !!car && car.lent && ac.lentOut.includes(cn.id), `${label}: setting up: C is on A's crew, at the wheel of the lent van`, `C in ${car ? JSON.stringify(car) : 'nothing'}; A lent to [${ac.lentOut}]`);
    return van;
  };

  // ── 2. A short drop: 10 s ──
  {
    const label = 'C loses the network for 10 s';
    const van = await helper(label);
    const id0 = (await C.net()).id;
    relay.hold = true;
    await sleep(10000);
    const during = await A.net();
    release();
    await sleep(6000);
    const [cn2, an2, cc, ac, car] = await Promise.all([C.net(), A.net(), C.crew(), A.crew(), C.car()]);
    check(cn2.status === 'online' && cn2.id === id0 && relay.resets === 0, `${label}: C is back in the same seat (no new socket)`, `C ${cn2.status} id ${id0} then ${cn2.id}; relay resets ${relay.resets}; A saw ${during.count} in town during the drop`);
    check(an2.count === 3 && remoteIds(an2).filter((i) => i === id0).length === 1, `${label}: A has C once, and no one else new`, `A's others [${remoteIds(an2)}]`);
    check(cc.boss === an.id && !!car && car.lent && ac.lentOut.includes(id0), `${label}: still on A's crew and at the wheel of the lent van`, `C boss ${cc.boss}; C in ${JSON.stringify(car)}; A lent to [${ac.lentOut}]`);
    const at = car ?? van;
    const vs = await Promise.all([A, C].map((t) => vansNear(t, at.x, at.z)));
    const total = (v) => v.mine.length + v.drawn;
    check(vs.every((v) => total(v) === 1), `${label}: one van on each screen`, `A ${JSON.stringify(vs[0])}; C ${JSON.stringify(vs[1])}`);
  }

  // ── 3. A long drop: 60 s, C in the pause menu ──
  {
    const label = 'C loses the network for 60 s, paused, at the wheel of A\'s lent van';
    const car0 = await C.car();
    const id0 = (await C.net()).id;
    await C.page.evaluate(() => window.__game.game.setPaused(true));
    const paused = await wait(async () => { const r = (await A.net()).remotes.find((x) => x.id === id0); const p = await A.page.evaluate((id) => window.__game.game.net.remotes.get(id)?.paused, id0); return p ? r : null; }, 10000);
    check(!!paused, `${label}: A sees C paused before the drop`, '');
    const resets0 = relay.resets;
    relay.hold = true;
    const held0 = Date.now();
    const gone = await wait(async () => !remoteIds(await A.net()).includes(id0), 58000, 1000);
    const ac1 = await A.crew();
    const vanA = await A.mine('van');
    await sleep(Math.max(0, held0 + 60000 - Date.now()));
    release();
    const back = await wait(async () => { const x = await C.net(); return x.status === 'online' && x.id !== id0 ? x : null; }, 60000, 500);
    await C.page.evaluate(() => window.__game.game.setPaused(false));
    await sleep(5000);
    const [cn3, an3, bn3, cc, ct, car] = await Promise.all([C.net(), A.net(), B.net(), C.crew(), C.todo(), C.car()]);
    cn = cn3;
    check(!!gone, `${label}: main lets C's seat go while the network is down, and A's crew lets C go`, `${gone ? 'gone' : 'still there'}; A's crew [${ac1.team}], lent to [${ac1.lentOut}]; A's van ${JSON.stringify(vanA)}`);
    check(!!back && relay.resets > resets0, `${label}: when the network is back C has a new seat`, back ? `id ${id0} then ${back.id}; relay resets ${relay.resets - resets0}` : `C ${cn3.status} id ${cn3.id}`);
    check(an3.count === 3 && !remoteIds(an3).includes(id0) && !remoteIds(bn3).includes(id0) && remoteIds(an3).includes(cn3.id), `${label}: no ghost of the old seat on A or B`, `A's others [${remoteIds(an3)}], B's [${remoteIds(bn3)}]; old ${id0}, new ${cn3.id}`);
    check(cc.boss === 0 && !cc.guest && ct.busy === null && cc.borrowed === 0, `${label}: C is on nobody's crew and has nothing borrowed`, `C boss ${cc.boss}, busy ${ct.busy}, borrowed ${cc.borrowed}, "${cc.lastLine}"`);
    const at = vanA ?? car0 ?? { x: kerb, z: MSPOT.z };
    const vs = await Promise.all([A, B, C].map((t) => vansNear(t, at.x, at.z)));
    const total = (v) => v.mine.length + v.drawn;
    check(vs.every((v) => total(v) === 1) && (!car || car.kind !== 'van'), `${label}: the van is there once on every screen (A's; C is set down beside it)`, `C at the wheel of ${car ? car.kind + (car.lent ? ' (lent)' : '') : 'nothing'}; A ${JSON.stringify(vs[0])}; B ${JSON.stringify(vs[1])}; C ${JSON.stringify(vs[2])}`);
    const pa = await wait(() => A.page.evaluate((id) => { const r = window.__game.game.net.remotes.get(id); return r && r.seen && !r.paused; }, cn3.id), 10000);
    check(!!pa && (await C.me()).state === 'play', `${label}: C resumes: nobody sees C paused`, `C ${(await C.me()).state}`);
    const lv = await Promise.all([A, C].map((t) => t.ask(look, [kerb, MSPOT.z, 80])));
    check(lv.every((l) => l.doubles.length === 0), `${label}: no car is there twice`, lv.map(lookText).join(' || '));
    await A.page.evaluate(() => window.__game.game.todo.missions.abandon());
    for (const t of [A, C]) await onFoot(t);
  }

  // ── 3b. The other way round, NOT judged (a known gap, printed): C is the starter, A drives C's lent van, C drops 60 s ──
  {
    const label = 'C (the starter) loses the network for 60 s while A drives C\'s lent van';
    for (const t of [A, B, C]) await onFoot(t);
    await C.go(kerb, MSPOT.z - 3); await A.go(kerb, MSPOT.z - 9); await B.go(kerb, MSPOT.z - 70);
    for (const t of [A, B, C]) await t.calm();
    await sleep(3000);
    const cid = (await C.net()).id;
    await startM(C, 'm03', 2);
    const d = await wait(async () => (await A.crew()).boss === cid, 20000);
    await read(C);
    const van = await C.mine('van');
    await sleep(2500);
    const ok = !!d && !!van && await getIn(A, van, 'van');
    const car = await A.car();
    if (ok && car && car.lent) {
      relay.hold = true;
      const held0 = Date.now();
      await wait(async () => !remoteIds(await A.net()).includes(cid), 58000, 1000);
      await sleep(Math.max(0, held0 + 60000 - Date.now()));
      release();
      await wait(async () => { const x = await C.net(); return x.status === 'online' && x.id !== cid && x.count === 3 ? x : null; }, 60000, 500);
      await sleep(5000);
      const [ac, ct, acar] = await Promise.all([A.crew(), C.todo(), A.car()]);
      const vs = await Promise.all([A, B, C].map((t) => vansNear(t, acar ? acar.x : van.x, acar ? acar.z : van.z)));
      note(`${label}: A boss ${ac.boss} "${ac.lastLine}", A at the wheel of ${acar ? acar.kind + (acar.lent ? ' (lent)' : ' (its own now)') : 'nothing'}; C ${ct.cur} failed ${ct.failed}; vans within 6 m of A: A ${JSON.stringify(vs[0])}; B ${JSON.stringify(vs[1])}; C ${JSON.stringify(vs[2])}`);
    } else note(`${label}: not set up (A drafted ${!!d}, in the van ${ok}, ${JSON.stringify(car)})`);
    await C.page.evaluate(() => window.__game.game.todo.missions.abandon());
    for (const t of [A, C]) await onFoot(t);
  }

  // ── 4. A long drop with a tow on ──
  {
    const label = 'C, towing, loses the network for 60 s';
    await C.go(kerb + 10, MSPOT.z + 40); await A.go(kerb, MSPOT.z + 20);
    await ownCar(C, 'tow');
    const ok = await C.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    const tw = await C.mine('#towed');
    const id0 = (await C.net()).id;
    const s0 = tw ? await wait(async () => { const x = await shownHeld(A, tw.x, tw.z); return x && x.d < 1.5 ? x : null; }, 15000) : null;
    check(ok && !!tw && !!s0, `${label}: setting up: A is shown C's car to tow`, `C's ${JSON.stringify(tw)}; on A ${JSON.stringify(s0)}`);
    const resets0 = relay.resets;
    relay.hold = true;
    const gone = tw ? await wait(async () => { const x = await shownHeld(A, tw.x, tw.z); return !remoteIds(await A.net()).includes(id0) && (!x || x.d > 3); }, 65000, 1000) : null;
    await sleep(10000);
    release();
    const back = await wait(async () => { const x = await C.net(); return x.status === 'online' && x.id !== id0 && x.count === 3 ? x : null; }, 60000, 500);
    const tw2 = await C.mine('#towed');
    const s1 = tw2 ? await wait(async () => { const x = await shownHeld(A, tw2.x, tw2.z); return x && x.d < 1.5 ? x : null; }, 20000) : null;
    const [cj, lv] = await Promise.all([C.todo(), A.ask(look, [tw ? tw.x : kerb, tw ? tw.z : MSPOT.z, 40])]);
    check(!!gone && relay.resets > resets0, `${label}: the car to tow leaves A's screen with C`, `${gone ? 'gone' : 'still there'}; resets ${relay.resets - resets0}`);
    check(!!back && cj.job === 'tow' && !!s1 && lv.doubles.length === 0, `${label}: C comes back still towing, and A is shown that car again, once`, `C ${back ? back.status : '?'} job "${cj.job}"; on A ${JSON.stringify(s1)}; A: ${lookText(lv)}`);
    await C.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    await onFoot(C);
  }

  // ── 5. Main restarts at a new address ──
  {
    const label = 'main restarts at a new address';
    for (const t of [A, B, C]) await t.calm();
    // Facts worth keeping: the host sets the hour and the weather, and its points move the bridge.
    const h0 = await rolesSoon([A, B, C], 30000);
    const H = h0 ? h0.host : A;
    await H.page.evaluate(() => { window.__game.setTime(14.5); window.__game.setWeather('rain'); window.__game.progress.add(300); });
    await sleep(8000);
    const before = await Promise.all([A, B, C].map((t) => t.net()));
    const tb = before[0].town;
    await S.stopMain();
    const fell = await wait(async () => { const ns = await Promise.all([A, B, C].map((t) => t.net())); return ns.every((x) => x.status === 'online' && x.home === 'backup' && x.count === 3) ? ns : null; }, 120000, 1000);
    check(!!fell, `${label}: with main gone everybody falls back to the backup, in one town`, (await Promise.all([A, B, C].map((t) => t.net()))).map((x, i) => `${'ABC'[i]} ${x.status} ${x.home} ${x.count} in town`).join('; '));
    // A little later (3 minutes in real life), main is back at a new address: the lookup and the network say so.
    await sleep(8000);
    S.startMainAt(NEWMAIN);
    if (!(await S.up(NEWMAIN))) throw new Error('main did not start again');
    S.addr = `http://127.0.0.1:${NEWMAIN}`;
    relay.target = NEWMAIN;
    const t0 = Date.now();
    const moved = await wait(async () => { const ns = await Promise.all([A, B, C].map((t) => t.net())); return ns.every((x) => x.status === 'online' && x.home === 'main' && x.count === 3) ? ns : null; }, 240000, 1000);
    const ns = moved ?? await Promise.all([A, B, C].map((t) => t.net()));
    check(!!moved, `${label}: everybody goes back to main by themselves, in one town`, `${((Date.now() - t0) / 1000).toFixed(0)} s; ${ns.map((x, i) => `${'ABC'[i]} ${x.status} ${x.home} ${x.count} in town, moves ${x.moves}`).join('; ')}`);
    await sleep(4000);
    const ta = (await A.net()).town;
    const pick = (t) => ({ bridge: t.bridge, clock: t.clock, seed: t.seed, forced: t.forced, weather: t.townWeather, hour: t.townHour });
    const same = JSON.stringify(ta.bridge) === JSON.stringify(tb.bridge) && ta.clock === tb.clock && ta.seed === tb.seed && ta.forced === tb.forced && ta.townWeather === tb.townWeather;
    check(same && tb.bridge && tb.bridge[0] + tb.bridge[2] > 0 && tb.forced === 'rain', `${label}: the town's facts are the same (bridge, clock, weather seed, the weather set)`, `before ${JSON.stringify(pick(tb))}; after ${JSON.stringify(pick(ta))}`);
    r = await rolesSoon([A, B, C], 60000);
    check(!!r, `${label}: one host again, the others its guests`, await modes([A, B, C]));
    note(`relay: ${relay.resets} sockets reset, ${relay.flushed} let through after a hold`);
  }

  const errs = [A, B, C].flatMap((t) => t.errs().map((e) => `${t.tag}: ${e}`));
  check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 500) || '"errors": []');
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  await S.end();
  relayServer.close(); cLookup.close();
  for (const c of relay.conns) { c.client.destroy(); c.up.destroy(); }
}
console.log(`${failures() ? failures() + ' FAILED' : 'ALL PASS'} (${((Date.now() - S.t0) / 60000).toFixed(1)} min)`);
process.exit(failures() ? 1 : 0);
