// Multiplayer stage 2, step 3: the same parked cars for everyone, and taking and leaving cars.
// Headless browsers against LOCAL services.
//
//   node tools/net/cars.mjs              every check, and two pictures into shots/net/
//   node tools/net/cars.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/traffic.mjs does (read its header): the Node
// home on 8831 is "main" (found through a lookup stand-in on 8832) and a second copy on 8833 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: alone with no service the parked cars are exactly what the old rule parks; two players on main have the
// same parked cars (numbers, kinds, colours, places); a guest takes a parked car and drives off, and on the other
// screen that car is driven by the guest and gone from its place; a third browser arriving afterwards sees the same;
// the guest gets out and everybody sees the car stay there, once; another player then takes it; a guest takes a
// traffic car from its driver; two players ask for the same car and exactly one gets it; the host leaves at the wheel
// and the places, the standing cars and the car it was driving are still there; on a backup style connection the
// parked cars are private as before and nothing about them is sent; message and byte counts for 30 s.
// The pages run in real time. There is no video card here, so frames are slow and the waits are generous.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8831, LOOKUP = 8832, BACKUP = 8833;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-cars-'));
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
  // Binary frames this page sends, by kind (first byte) and, for World, ToHost and ToPlayer, by what they carry (third byte).
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] === 2 || p[0] === 4 || p[0] === 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  /** The parked cars in their places on this screen: [number, kind, colour, x, z, heading, shared]. */
  t.parked = () => t.page.evaluate(() => window.__game.game.net.cars.list());
  t.empties = () => t.page.evaluate(() => window.__game.game.net.cars.empties());
  /** How many cars this browser has on the street within r of a point (the other players' drawn cars are not among them). */
  t.around = (x, z, r) => t.page.evaluate(([x, z, r]) => window.__game.game.vehicles.list.filter((v) => Math.hypot(v.x - x, v.z - z) < r).length, [x, z, r]);
  /** This player's own car. */
  t.car = () => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { kind: v.spec.kind, color: v.color, x: v.x, z: v.z, h: v.h, speed: v.speed, health: v.health } : null; });
  /** The use-the-door key. */
  t.door = () => t.page.keyboard.press('KeyF', { delay: 60 });
  await t.page.evaluate(() => window.__game.start());
  return t;
}
/**
 * Call off this page's own police. They are not shared yet (a later step), so a cruiser chasing one player is a car
 * nobody else can see, and on a host it can shunt the town's parked cars. The checks that count places must not
 * depend on whether a chase happens to be on, so the test ends any chase it has caused before them.
 */
const calm = (t) => t.page.evaluate(() => {
  const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police');
  g.player.heat = 0;
  if (p) p.clear();
  return !!p;
});
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.traffic.mode === 'host');
  if (hi < 0 || ns.some((x, i) => i !== hi && (x.traffic.mode !== 'guest' || x.host !== ns[hi].id))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi) };
}
async function settled(ts, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end;) { const r = await roles(ts); if (r) return r; await sleep(300); }
  return null;
}
const key = (l) => JSON.stringify(l.map((c) => c.slice(0, 6)).sort((a, b) => a[0] - b[0]));
/** Wait until fn() is truthy. */
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
/** Stand beside the driver's door of a car at (x, z) heading h, facing it. */
const beside = (t, c, side = -1) => t.go(c.x + Math.cos(c.h) * 2.3 * side, c.z - Math.sin(c.h) * 2.3 * side, c.h);
/** Walk to a car and get in with the door key: true once this player is at its wheel. */
async function getIn(t, c, kind, tries = 3) {
  for (let k = 0; k < tries; k++) {
    await beside(t, c, k % 2 ? 1 : -1);
    await sleep(700);
    await t.door();
    const ok = await wait(async () => { const v = await t.car(); return v && v.kind === kind; }, 20000);
    if (ok) return true;
  }
  return false;
}
async function getOut(t) {
  // (Stopped, or as good as: a car left rolling is only handed to the town once it stands.)
  await wait(async () => { const v = await t.car(); return !v || Math.abs(v.speed) < 0.15; }, 25000);
  const at = await t.car();
  await t.door();
  const out = await wait(async () => !(await t.car()), 20000);
  return out ? at : null;
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. No service at all: the parked cars are what the old rule parks ──
  let aloneCount = 0;
  {
    const S = await visitor('S', 'net=0');
    await sleep(3000);
    const r = await S.page.evaluate(async () => {
      const g = window.__game.game, plan = g.plan;
      const { RNG } = await import('/src/core/util.ts');
      const { SPECS, commonKind } = await import('/src/ent/vehicleSpecs.ts');
      // The rule as it was before this step (core/game.ts, placeStart), worked out again here.
      const truck = plan.curbPoint(5, 6, 2, 0.45), coupe = plan.curbPoint(5, 6, 2, 0.62), bolt = plan.curbPoint(5, 6, 2, 0.30), cmax = plan.curbPoint(6, 3, 2, 0.5);
      const rng = new RNG(4021), want = [];
      for (const s of plan.parking) {
        const keep = rng.chance(0.55 * g.quality.density);
        const kind = commonKind(rng.next());
        const tint = rng.next();
        if (!keep) continue;
        if (Math.abs(s.x - truck.x) < 16 && Math.abs(s.z - truck.z) < 16) continue;
        if (Math.abs(s.x - coupe.x) < 9 && Math.abs(s.z - coupe.z) < 9) continue;
        if (Math.abs(s.x - bolt.x) < 9 && Math.abs(s.z - bolt.z) < 9) continue;
        if (Math.abs(s.x - cmax.x) < 9 && Math.abs(s.z - cmax.z) < 9) continue;
        const colors = SPECS[kind].colors;
        want.push({ kind, color: colors[Math.floor(tint * colors.length)], x: s.x, z: s.z, h: s.h });
      }
      const list = g.vehicles.list.filter((v) => v.driver === null);
      let found = 0;
      for (const w of want) if (list.some((v) => v.spec.kind === w.kind && v.color === w.color && Math.abs(v.x - w.x) < 0.01 && Math.abs(v.z - w.z) < 0.01 && Math.abs(v.h - w.h) < 0.001 && !v.shared)) found++;
      // In the order they were parked: the cars after the four that open the game.
      let inOrder = 0;
      const all = g.vehicles.list;
      for (let i = 0; i < want.length; i++) { const v = all[i + 4]; if (v && v.spec.kind === want[i].kind && v.color === want[i].color && v.x === want[i].x && v.z === want[i].z) inOrder++; }
      return { want: want.length, found, inOrder, standing: list.length, places: plan.parking.length, spots: g.parkSpots.length, first: all.slice(0, 4).map((v) => v.spec.kind).join(' ') };
    });
    const n = await S.net();
    aloneCount = r.want + 4;
    check(r.found === r.want && r.inOrder === r.want && r.standing === r.want + 4, 'single player: the parked cars are exactly the ones the old rule parks, in the same order', `${r.found} of ${r.want} found (${r.inOrder} in the same order), ${r.standing} standing cars in all with the four that open the game (${r.first}); ${r.places} kerb places`);
    check(n.cars.asks === 0 && n.cars.parkedSent === 0 && n.traffic.mode === 'local', 'single player: nothing is asked or sent', `mode ${n.traffic.mode}`);
    check(S.errors.length === 0, 'single player: no errors', S.errors.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await leave(S);
  }

  // ── 2. Two on main: the same parked cars ──
  const big = SHOTS ? [960, 540] : [480, 270];
  const A = await visitor('A', viaMain, big);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain, big);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}` : 'timed out');
  const spot = await A.info();
  await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  let r = await settled([A, B], 45000);
  check(!!r, 'one of the two is the host and the other its guest', r ? `${r.host.tag} hosts, ${r.guests[0].tag} is a guest` : 'no host');
  await sleep(2500);
  let town = 0;
  {
    const [pa, pb, na, nb] = await Promise.all([A.parked(), B.parked(), A.net(), B.net()]);
    town = na.cars.town;
    const same = key(pa) === key(pb);
    const nearby = pa.filter((c) => Math.hypot(c[3] - spot.x, c[4] - spot.z) < 120).length;
    check(same && pa.length === town && pa.length > aloneCount, 'both have the same parked cars: same numbers, kinds, colours and places', `${pa.length} and ${pb.length} cars (${nearby} within 120 m of where they stand); the town parks ${town} of ${na.cars.places} places, where this quality setting alone parks ${aloneCount}`);
    // (Whichever of the two is the host at this moment: the job can move between two slow pages.)
    const sh = (l) => l.filter((c) => c[6]).length, modes = [na.traffic.mode, nb.traffic.mode];
    const fits = (l, m) => (m === 'host' ? sh(l) === 0 : sh(l) === l.length);
    check(modes.includes('host') && modes.includes('guest') && fits(pa, modes[0]) && fits(pb, modes[1]), 'the host simulates them; on the guest they stand as the town\'s cars', `A (${modes[0]}): ${sh(pa)} of ${pa.length} placed by the town; B (${modes[1]}): ${sh(pb)} of ${pb.length}`);
    check(na.cars.empty === 0 && nb.cars.empty === 0, 'and no place is empty yet', `${na.cars.empty}, ${nb.cars.empty}`);
  }

  // ── 3. A guest takes a parked car and drives off ──
  r = await settled([A, B]);
  let G = r.guests[0], H = r.host;
  let taken = null, C = null;
  {
    const gi = await G.info();
    const list = (await G.parked()).map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
    // A car along the street from where they stand, not one of the four the game opens with.
    const pick = list.filter((c) => c.id < list.length + 99 && dist(c, gi) > 25 && dist(c, gi) < 160 && c.kind !== 'bus').sort((p, q) => dist(p, gi) - dist(q, gi))[0];
    const g0 = (await G.net()).cars, h0 = (await H.net()).cars;
    const ok = await getIn(G, pick, pick.kind);
    const mine = await G.car();
    check(ok && !!mine && mine.color === pick.color, 'a guest walks up to a parked car and gets in', mine ? `${G.tag} is in car ${pick.id}, a ${mine.kind}` : 'never got in');
    const g1 = (await G.net()).cars, h1 = (await H.net()).cars;
    check(g1.asks - g0.asks >= 1 && g1.grants - g0.grants === 1 && h1.given - h0.given === 1, 'by asking the host, who granted it', `${g1.asks - g0.asks} ask(s), ${g1.grants - g0.grants} grant; the host gave ${h1.given - h0.given}`);
    taken = pick;
    // Out from the kerb and up the street.
    await G.page.keyboard.down('KeyW'); await G.page.keyboard.down('KeyA');
    await sleep(1200);
    await G.page.keyboard.up('KeyA');
    await wait(async () => { const v = await G.car(); return v && dist(v, pick) > 8; }, 40000);
    await G.page.keyboard.up('KeyW');
    const at = await G.car();
    const seen = await H.until((x) => x.remotes.some((q) => q.vehicle === pick.kind && Math.hypot(q.x - pick.x, q.z - pick.z) > 8), 20000);
    const rem = seen ? seen.remotes.find((q) => q.vehicle === pick.kind) : null;
    check(!!rem && rem.color === pick.color, 'on the host\'s screen the guest is driving that car, the same kind and colour', rem ? `a ${rem.vehicle}, ${dist(rem, pick).toFixed(1)} m from its place (the guest has it ${at ? dist(at, pick).toFixed(1) : '?'} m away)` : 'not seen driving');
    const [ph, eh, nearH] = await Promise.all([H.parked(), H.empties(), H.around(pick.x, pick.z, 1.5)]);
    check(!ph.some((c) => c[0] === pick.id) && eh.includes(pick.id) && nearH === 0, 'and it is gone from its parking place there', `place ${pick.id}: ${eh.length} empty place(s) on the host, ${nearH} cars standing in it`);

    // ── 4. A third browser arrives afterwards ──
    C = await visitor('C', viaMain);
    n = await C.until((x) => x.status === 'online' && x.count === 3 && x.traffic.mode === 'guest' && x.cars.parkedGot > 0, 60000);
    check(!!n, 'C arrives in town later', n ? `${n.count} in town` : 'timed out');
    const sawG = await C.until((x) => x.remotes.some((q) => q.vehicle === pick.kind && q.color === pick.color), 30000);
    const [pc, ec, ph2, nearC] = await Promise.all([C.parked(), C.empties(), H.parked(), C.around(pick.x, pick.z, 1.5)]);
    check(key(pc) === key(ph2) && !pc.some((c) => c[0] === pick.id) && ec.includes(pick.id) && nearC === 0, 'and has the same parked cars as the host, with that place empty', `${pc.length} cars, as the host's ${ph2.length}; ${ec.length} empty place(s)`);
    check(!!sawG, 'and sees the guest in the taken car', sawG ? 'yes' : 'no');

    // ── The two pictures: the host's and the guest's view of the guest in the taken car, past the same parked cars ──
    if (SHOTS && at) {
      const s = Math.sin(at.h), co = Math.cos(at.h);
      // From over the middle of the street behind it, looking up the kerb it left.
      const view = [at.x - s * 13 - co * 3.5, spot.y + 5.5, at.z - co * 13 + s * 3.5, at.x + s * 9, spot.y + 0.6, at.z + co * 9];
      for (const t of [H, G]) await t.page.evaluate((v) => window.__game.view(...v), view);
      await sleep(3000);
      const shots = await Promise.all([H.shot('shots/net/cars-host.png'), G.shot('shots/net/cars-guest.png')]);
      console.log('shots', shots.join(' '), `(${H.tag} was the host, ${G.tag} the guest in car ${pick.id}, a ${pick.kind})`);
      for (const t of [H, G]) await t.page.evaluate(() => window.__game.view());
    }
  }

  // ── 5. The guest gets out: the car stays there for everybody, and another player can take it ──
  {
    const others = [A, B, C].filter((t) => t !== G);
    const g0 = (await G.net()).cars;
    const at = await getOut(G);
    check(!!at, 'the guest gets out', at ? `at ${at.x.toFixed(1)}, ${at.z.toFixed(1)}` : 'still at the wheel');
    const left = (x) => x.traffic.cars.find((c) => c.driver === null && c.kind === taken.kind && c.color === taken.color && Math.hypot(c.x - at.x, c.z - at.z) < 6);
    const seen = await Promise.all([G, ...others].map((t) => t.until((x) => !!left(x), 30000)));
    await sleep(1500);
    const cars = seen.every((x) => !!x) ? (await Promise.all([G, ...others].map((t) => t.net()))).map((x) => left(x) ?? null) : seen.map(() => null);
    const ids = cars.map((c) => (c ? c.id : 0));
    check(cars.every((c) => !!c) && ids.every((i) => i === ids[0]), 'everybody sees the car stay where it was left, as the same standing car', cars.map((c, i) => `${[G, ...others][i].tag}: ${c ? `car ${c.id} at ${c.x.toFixed(1)}, ${c.z.toFixed(1)}` : 'not there'}`).join('; '));
    const counts = await Promise.all([G, ...others].map((t) => t.around((cars[0] ?? at).x, (cars[0] ?? at).z, 2)));
    check(counts.every((k) => k === 1), 'once on each screen, not twice', counts.join(', '));
    const g1 = (await G.net()).cars;
    check(g1.leaves - g0.leaves === 1 && g1.lefts - g0.lefts === 1, 'handed to the host in one small message, and numbered in one back', `${g1.leaveBytes - g0.leaveBytes} bytes there, 5 back`);
    await G.go(at.x + 12, at.z + 9, 0);
    // Another guest takes it.
    const rr = await settled([A, B, C]);
    const T = rr ? rr.guests.find((t) => t !== G) ?? rr.guests[0] : C;
    const c = cars[0] ?? at;
    const ok = await getIn(T, { x: c.x, z: c.z, h: c.h }, taken.kind);
    const mine = await T.car();
    check(ok && !!mine && mine.color === taken.color, 'another player then takes that car', mine ? `${T.tag} is in it` : `${T.tag} never got in`);
    const gone = await G.until((x) => !left(x) && x.remotes.some((q) => q.vehicle === taken.kind && q.color === taken.color), 30000);
    check(!!gone, 'and the one who left it sees them drive it, and no car left standing', gone ? 'yes' : 'no');
    await T.page.keyboard.down('KeyW'); await sleep(2500); await T.page.keyboard.up('KeyW');
    await getOut(T);
    await T.go(spot.x - 6, spot.z + 2, spot.h);
    await G.go(spot.x + 4, spot.z + 1.5, spot.h);
  }

  // ── 6. A guest takes a traffic car from its driver ──
  {
    let done = false, detail = 'no standing traffic car found';
    for (let attempt = 0; attempt < 10 && !done; attempt++) {
      const rr = await settled([A, B, C]);
      if (!rr) continue;
      const T = rr.guests[attempt % rr.guests.length], Hn = rr.host;
      const x0 = await T.until((x) => x.traffic.mode === 'guest' && x.traffic.cars.some((c) => c.driver === 'ai' && c.speed === 0), 30000);
      if (!x0) continue;
      const ti = await T.info();
      const c = x0.traffic.cars.filter((k) => k.driver === 'ai' && k.speed === 0 && k.kind !== 'bus').sort((p, q) => dist(p, ti) - dist(q, ti))[attempt % 2];
      if (!c) continue;
      // (Counted over every page: the host's job can move between slow pages in the middle.)
      const given = async () => (await Promise.all([A, B, C].map((t) => t.net()))).reduce((a, x) => a + x.cars.given, 0);
      const h0 = await given(), t0 = (await T.net()).cars;
      await beside(T, c, -1);
      await sleep(500);
      await T.door();
      const ok = await wait(async () => { const v = await T.car(); return v && v.kind === c.kind && v.color === c.color; }, 15000);
      if (!ok) { detail = `car ${c.id} drove off, or was not granted`; continue; }
      done = true;
      const t1 = (await T.net()).cars, h1 = await given();
      check(t1.grants - t0.grants === 1 && h1 - h0 === 1, 'a guest takes a traffic car that had a driver in it', `${T.tag} took car ${c.id}, a ${c.kind}, from its driver: ${t1.asks - t0.asks} ask(s), ${t1.grants - t0.grants} grant(s), ${t1.refusals - t0.refusals} refusal(s); given by a host: ${h1 - h0}`);
      const Hs = (await settled([A, B, C]))?.host ?? Hn;
      const seen = await Hs.until((x) => !x.traffic.cars.some((k) => k.id === c.id && k.kind === c.kind && k.driver === 'ai' && Math.hypot(k.x - c.x, k.z - c.z) < 30) && x.remotes.some((q) => q.vehicle === c.kind && q.color === c.color), 20000);
      check(!!seen, 'on the host it is out of the traffic and driven by that guest, the same kind and colour', seen ? 'yes' : 'no');
      const wanted = (await T.info()).heat;
      console.log(`  (the taker's own wanted level afterwards: ${wanted}; the driver is simply gone, as in single player)`);
      await getOut(T);
      await T.go(spot.x - 6, spot.z + 2, spot.h);
    }
    if (!done) check(false, 'a guest takes a traffic car that had a driver in it', detail);
    const calmed = await Promise.all([A, B, C].map(calm));
    if (!calmed.every(Boolean)) check(false, 'the test could call off the police it caused', calmed.join(', '));
  }

  // ── 6b. A guest drives into a parked car: it is pushed for everybody, and is a standing car from then on ──
  {
    let done = false, detail = 'never reached a parked car';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      const rr = await settled([A, B, C]);
      if (!rr) continue;
      const T = rr.guests[0], Hn = rr.host, O = rr.guests[1];
      const ti = await T.info();
      const list = (await T.parked()).map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
      const pick = list.filter((c) => dist(c, ti) > 30 && dist(c, ti) < 220 && c.kind !== 'bus' && c.id < 760).sort((p, q) => dist(p, ti) - dist(q, ti))[2 + attempt * 2];
      if (!pick) continue;
      const s = Math.sin(pick.h), co = Math.cos(pick.h);
      // From the middle of the road, square on to its door.
      await T.go(pick.x - co * 8, pick.z + s * 8, pick.h + Math.PI / 2);
      await T.page.evaluate(() => window.__game.drive('sedan'));
      const t0 = (await T.net()).cars;
      await T.page.keyboard.down('KeyW');
      const hit = await T.until((x) => x.cars.parkHitsSent > t0.parkHitsSent, 30000);
      await sleep(600);
      await T.page.keyboard.up('KeyW');
      if (!hit) { detail = `no knock on car ${pick.id} was reported`; await getOut(T); continue; }
      const moved = (x) => x.traffic.cars.find((c) => c.driver === null && c.kind === pick.kind && c.color === pick.color && Math.hypot(c.x - pick.x, c.z - pick.z) < 8);
      const seen = await Promise.all([Hn, T, O].map((t) => t.until((x) => !!moved(x), 20000)));
      const cars = seen.map((x) => (x ? moved(x) : null));
      if ((await roles([A, B, C]))?.host !== Hn) { detail = 'the host changed in the middle'; await getOut(T); continue; }
      done = true;
      const t1 = (await T.net()).cars, h1 = (await Hn.net()).cars;
      // Once it has come to rest, as each screen has it. On the host (the first) it is the real car: it must have been
      // shifted, turned or dented by the knock (a car leaves its place at 0.15 m, counted as |dx| + |dz|; the figures
      // here are rounded to a centimetre, so the test asks for 0.1 m in a straight line, 0.03 rad, or any dent).
      await sleep(2500);
      const fin = (await Promise.all([Hn, T, O].map((t) => t.net()))).map((x) => moved(x) ?? null);
      const off = (c) => Math.hypot(c.x - pick.x, c.z - pick.z), turn = (c) => Math.abs(Math.atan2(Math.sin(c.h - pick.h), Math.cos(c.h - pick.h)));
      const all = fin.every((c) => !!c), hc = fin[0];
      const real = all && (off(hc) >= 0.1 || turn(hc) >= 0.03 || hc.health < 100);
      const agree = all && fin.every((c) => c.id === hc.id && Math.hypot(c.x - hc.x, c.z - hc.z) < 0.3 && Math.abs(Math.atan2(Math.sin(c.h - hc.h), Math.cos(c.h - hc.h))) < 0.1);
      check(cars.every((c) => !!c) && real && agree && h1.parkHitsDone >= 1, 'a guest drives into a parked car and it is pushed on every screen, as one of the host\'s standing cars', hc ? `car ${pick.id}, a ${pick.kind}, is now standing car ${hc.id}: on the host ${off(hc).toFixed(2)} m from its place, turned ${turn(hc).toFixed(3)} rad, health ${hc.health}; shown ${fin.slice(1).map((c) => (c ? Math.hypot(c.x - hc.x, c.z - hc.z).toFixed(2) : '?')).join(' and ')} m from there on the other two screens; ${t1.parkHitsSent - t0.parkHitsSent} knock(s) of 11 bytes told, ${h1.parkHitsDone} dealt` : 'not seen');
      const [e1, e2, e3, p2, p3] = await Promise.all([Hn.empties(), T.empties(), O.empties(), T.parked(), O.parked()]);
      check([e1, e2, e3].every((e) => e.includes(pick.id)) && !p2.some((c) => c[0] === pick.id) && !p3.some((c) => c[0] === pick.id), 'and its place counts as empty for all three', `${e1.length} empty place(s)`);
      if (hc) {
        const counts = await Promise.all([Hn, O].map((t) => t.around(hc.x, hc.z, 1.5)));
        check(counts.every((k) => k === 1), 'and there is one car there, not two', counts.join(', '));
      }
      await getOut(T);
      await T.go(spot.x - 6, spot.z + 2, spot.h);
    }
    if (!done) check(false, 'a guest drives into a parked car and it is pushed on every screen', detail);
  }

  // ── 6c. The host takes a parked car itself and leaves it ──
  {
    const rr = await settled([A, B, C]);
    const Hn = rr.host, O = rr.guests;
    const hi = await Hn.info();
    const list = (await Hn.parked()).map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
    const pick = list.filter((c) => dist(c, hi) > 20 && dist(c, hi) < 200 && c.kind !== 'bus' && c.id < 760).sort((p, q) => dist(p, hi) - dist(q, hi))[0];
    const ok = await getIn(Hn, pick, pick.kind);
    const seen = await Promise.all(O.map((t) => t.until((x) => x.remotes.some((q) => q.vehicle === pick.kind && q.color === pick.color), 20000)));
    await sleep(1500);
    const lists = await Promise.all(O.map((t) => t.parked())), near = await Promise.all(O.map((t) => t.around(pick.x, pick.z, 1.5)));
    const still = (await roles([A, B, C]))?.host === Hn;
    check(ok && (!still || (seen.every((x) => !!x) && lists.every((l) => !l.some((c) => c[0] === pick.id)) && near.every((k) => k === 0))), 'the host gets into a parked car as in single player, and the others see it driven and its place empty', still ? `${Hn.tag} took car ${pick.id}; cars left in the place on the other screens: ${near.join(', ')}` : 'the host changed in the middle: only the getting in was checked');
    await Hn.page.keyboard.down('KeyW'); await Hn.page.keyboard.down('KeyA'); await sleep(1500); await Hn.page.keyboard.up('KeyA'); await sleep(1500); await Hn.page.keyboard.up('KeyW');
    const at = await getOut(Hn);
    // (It may roll on a little after the door opens; where it comes to rest is where it is.)
    const left = (x) => x.traffic.cars.find((c) => c.driver === null && c.kind === pick.kind && c.color === pick.color && at && Math.hypot(c.x - at.x, c.z - at.z) < 6);
    const after = await Promise.all([Hn, ...O].map((t) => t.until((x) => !!left(x), 30000)));
    await sleep(2000);
    const fin = (await Promise.all([Hn, ...O].map((t) => t.net()))).map((x) => left(x));
    const counts = fin[0] ? await Promise.all([Hn, ...O].map((t) => t.around(fin[0].x, fin[0].z, 1.5))) : [];
    check(!!at && after.every((x) => !!x) && fin.every((c) => !!c && c.id === fin[0].id && Math.hypot(c.x - fin[0].x, c.z - fin[0].z) < 0.5) && counts.every((k) => k === 1), 'the host gets out and everybody has the car standing where it was left, once', `${fin.filter((x) => !!x).length} of 3 see it${fin[0] ? ` as car ${fin[0].id}, ${at ? Math.hypot(fin[0].x - at.x, fin[0].z - at.z).toFixed(1) : '?'} m from where the door opened` : ''}; cars there: ${counts.join(', ')}`);
    await Hn.go(spot.x, spot.z, spot.h);
  }

  // ── 7. Two players ask for the same car at the same moment ──
  {
    let done = false, detail = 'never two guests';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const rr = await settled([A, B, C]);
      if (!rr || rr.guests.length < 2) continue;
      const [P, Q] = rr.guests, Hn = rr.host;
      const pi = await P.info();
      const list = (await Hn.parked()).map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
      const pick = list.filter((c) => dist(c, pi) > 25 && dist(c, pi) < 200 && c.kind !== 'bus' && c.id !== taken.id).sort((p, q) => dist(p, pi) - dist(q, pi))[attempt];
      // One at each door.
      await beside(P, pick, -1); await beside(Q, pick, 1);
      const ready = await wait(async () => (await Promise.all([P.parked(), Q.parked()])).every((l) => l.some((c) => c[0] === pick.id)), 15000);
      if (!ready) { detail = 'the car was not on both screens'; continue; }
      await sleep(800);
      const h0 = (await Hn.net()).cars;
      // Both hands on the doors in the same instant: each page asks the host for the car at once.
      const asks = await Promise.all([P, Q].map((t) => t.page.evaluate((id) => { const g = window.__game.game, v = g.parkSpots[id].v; if (!v) return 'none'; g.player.enter(v); return g.takeShared(v); }, pick.id)));
      const who = await wait(async () => { const cs = await Promise.all([P.car(), Q.car()]); return cs.some((c) => c && c.kind === pick.kind) ? cs : null; }, 20000);
      await sleep(4000);
      const cs = await Promise.all([P.car(), Q.car()]);
      const inIt = cs.filter((c) => c && c.kind === pick.kind && c.color === pick.color).length;
      const h1 = (await Hn.net()).cars, [np, nq] = await Promise.all([P.net(), Q.net()]);
      if ((await roles([A, B, C]))?.host !== Hn) { detail = 'the host changed in the middle'; continue; }
      done = true;
      check(asks.every((a) => a === 'wait') && h1.asked - h0.asked === 2 && h1.given - h0.given === 1 && h1.refused - h0.refused === 1, 'two players ask for the same car in the same moment: the host grants it once and refuses once', `${P.tag} and ${Q.tag} asked for car ${pick.id}: the host was asked ${h1.asked - h0.asked} times, gave ${h1.given - h0.given}, refused ${h1.refused - h0.refused}`);
      check(!!who && inIt === 1, 'exactly one of them is in it', `${cs.map((c, i) => `${[P, Q][i].tag}: ${c ? 'at the wheel' : 'on foot'}`).join(', ')}`);
      const loser = cs[0] ? Q : P, ln = cs[0] ? nq : np;
      const li = await loser.info();
      check(li.vehicle === null && ln.cars.refusals >= 1 && loser.errors.length === 0, 'the other is refused quietly: still on foot, nothing on screen', `${loser.tag}: ${ln.cars.refusals} refusal(s), no toast, no error`);
      const nearL = await loser.around(pick.x, pick.z, 1.5);
      check(nearL === 0 || (await loser.net()).remotes.some((q) => q.vehicle === pick.kind), 'and on the refused player\'s screen the car is the winner\'s', `${nearL} car(s) of its own left in the place`);
      const W = cs[0] ? P : Q;
      await getOut(W);
    }
    if (!done) check(false, 'two players ask for the same car and exactly one gets it', detail);
  }

  // ── 8. Thirty seconds of the town as it now stands: what it costs ──
  {
    for (const t of [A, B, C]) await t.go(spot.x + (t === A ? 0 : t === B ? 4 : -6), spot.z + (t === A ? 0 : 1.5), spot.h);
    await sleep(3000);
    const rr = await settled([A, B, C]);
    const Hn = rr ? rr.host : A;
    const snap = async () => ({ n: await Promise.all([A, B, C].map((t) => t.net())), out: JSON.parse(JSON.stringify([A, B, C].map((t) => t.out))) });
    const s0 = await snap();
    await sleep(30000);
    const s1 = await snap();
    const sum = (f) => s1.n.reduce((a, x, i) => a + f(x) - f(s0.n[i]), 0);
    const wire = (k, what) => s1.out.reduce((a, o, i) => a + (o[what][k] ?? 0) - (s0.out[i][what][k] ?? 0), 0);
    const parkedB = wire('2.2', 'bytes'), parkedN = wire('2.2', 'n'), trafB = wire('2.1', 'bytes'), trafN = wire('2.1', 'n');
    const standing = (await Hn.net()).traffic.cars.filter((c) => c.driver === null).length, all = (await Hn.net()).traffic.cars.length;
    console.log(`  30 s, three players standing about, ${town} parked places of which ${s1.n[0].cars.empty} are empty, ${all} cars in the traffic frames (${standing} of them standing with nobody in):`);
    console.log(`    parked cars: ${parkedN} frame(s), ${parkedB} bytes (${(parkedB / 30).toFixed(1)} bytes/s) from the host`);
    console.log(`    traffic:     ${trafN} frames, ${trafB} bytes (${(trafB / 30).toFixed(0)} bytes/s, ${(trafB / Math.max(1, trafN)).toFixed(0)} per frame)`);
    console.log(`    asking and answering: ${wire('4.3', 'n') + wire('4.4', 'n') + wire('4.2', 'n')} ToHost and ${wire('5.1', 'n') + wire('5.2', 'n')} ToPlayer frames (none: nobody touched a car)`);
    console.log(`    everything, all three together: ${sum((x) => x.sent.msgs)} messages and ${sum((x) => x.sent.bytes)} bytes sent (${(sum((x) => x.sent.msgs) / 30).toFixed(1)} messages/s, ${(sum((x) => x.sent.bytes) / 30).toFixed(0)} bytes/s)`);
    check(parkedN <= 5 && parkedB / 30 < 20, 'untouched parked cars cost next to nothing: a few bytes a second', `${parkedN} frames, ${(parkedB / 30).toFixed(1)} bytes/s`);
    check(sum((x) => x.sent.msgs) / 30 < 40, 'all three together stay inside one player\'s rate limit (40 messages a second)', `${(sum((x) => x.sent.msgs) / 30).toFixed(1)} a second`);
    const t = [A, B, C].reduce((a, p) => { for (const k of ['4.2', '4.3', '4.4', '5.1', '5.2']) { a.n += p.out.n[k] ?? 0; a.b += p.out.bytes[k] ?? 0; } return a; }, { n: 0, b: 0 });
    console.log(`    the whole test so far: ${t.n} frames, ${t.b} bytes of asking, answering, leaving and knocking parked cars`);
  }

  // ── 9. The host leaves, at the wheel ──
  {
    await Promise.all([A, B, C].map(calm));
    await sleep(1500);
    await Promise.all([A, B, C].map(calm));
    const rr = await settled([A, B, C]);
    const Hn = rr.host, rest = rr.guests;
    // It gets into a car of its own first, so that it drops out of town at the wheel.
    // (In the middle of a street with nothing parked beside it, so that it pushes nothing as it appears.)
    await Hn.go(-340, 291.8, Math.PI / 2);
    await Hn.page.evaluate(() => window.__game.drive('sedan'));
    const hc = await Hn.car();
    await rest[0].until((x) => x.remotes.some((q) => q.vehicle === 'sedan'), 20000);
    await sleep(1500);
    const before = await Promise.all(rest.map(async (t) => ({ parked: key(await t.parked()), empties: (await t.empties()).join(','), standing: (await t.net()).traffic.cars.filter((c) => c.driver === null).map((c) => ({ id: c.id, kind: c.kind, color: c.color, x: c.x, z: c.z })) })));
    await leave(Hn);
    const r2 = await settled(rest, 60000);
    check(!!r2, 'the host leaves and one of the others takes over', r2 ? `${r2.host.tag} hosts now` : 'no new host');
    await sleep(4000);
    const after = await Promise.all(rest.map(async (t) => ({ parked: key(await t.parked()), empties: (await t.empties()).join(','), n: await t.net() })));
    const diff = after.map((a, i) => { const b = new Set(before[i].empties.split(',')); return a.empties.split(',').filter((e) => e && !b.has(e)); });
    const lost = after.map((a, i) => { const now = new Set(a.empties.split(',')); return before[i].empties.split(',').filter((e) => e && !now.has(e)); });
    console.log(`  (places newly empty after the change of host: ${diff.map((d, i) => `${rest[i].tag} [${d.join(' ')}]`).join(', ')}; no longer empty: ${lost.map((d, i) => `${rest[i].tag} [${d.join(' ')}]`).join(', ')}; the new host's own record of places it emptied: ${after.map((a) => a.n.cars.lost).filter(Boolean).join(' | ') || 'none'})`);
    check(after.every((a, i) => a.parked === before[i].parked && a.empties === before[i].empties) && after[0].parked === after[1].parked, 'the parked cars are still there, the same on both, with the same places empty', `${JSON.parse(after[0].parked).length} cars, ${after[0].empties.split(',').filter(Boolean).length} empty place(s); before: ${before.map((b) => b.empties.split(',').filter(Boolean).length).join(' and ')}; lists equal now: ${after[0].parked === after[1].parked}`);
    const kept = before[0].standing.filter((c) => after.every((a) => a.n.traffic.cars.some((k) => k.id === c.id && k.driver === null && k.kind === c.kind && k.color === c.color && Math.hypot(k.x - c.x, k.z - c.z) < 1)));
    check(before[0].standing.length > 0 && kept.length === before[0].standing.length, 'the cars players left standing are still there, with the same numbers', `${kept.length} of ${before[0].standing.length}`);
    const stray = await Promise.all(rest.map((t) => t.until((x) => x.traffic.cars.some((k) => k.driver === null && k.kind === 'sedan' && Math.hypot(k.x - hc.x, k.z - hc.z) < 3), 20000)));
    check(stray.every((x) => !!x), 'and the car the old host was driving is left where it was last seen', stray.map((x, i) => `${rest[i].tag}: ${x ? 'there' : 'missing'}`).join(', '));
    const hostNow = r2 ? r2.host : rest[0];
    check((await hostNow.parked()).every((c) => !c[6]), 'the new host simulates the parked cars itself', 'none shared');
    // And the new host's guest can still take one.
    if (r2) {
      const T = r2.guests[0], ti = await T.info();
      const list = (await T.parked()).map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
      const pick = list.filter((c) => dist(c, ti) > 20 && c.kind !== 'bus').sort((p, q) => dist(p, ti) - dist(q, ti))[1];
      const ok = await getIn(T, pick, pick.kind);
      check(ok, 'and its guest can take a parked car from it', ok ? `${T.tag} took car ${pick.id}` : 'no');
    }
    const errs = [...A.errors, ...B.errors, ...C.errors];
    check(errs.length === 0, 'no errors from the game on any page on main', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    for (const t of rest) await leave(t);
  }

  // ── 10. A backup style connection: parked cars are private, as before ──
  {
    const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
    const nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const di = await D.info();
    await E.go(di.x + 4, di.z + 1.5, di.h);
    await sleep(4000);
    const [pd, pe] = await Promise.all([D.parked(), E.parked()]);
    check(pd.length === aloneCount && pe.length === aloneCount && pd.every((c) => !c[6]) && pe.every((c) => !c[6]), 'each has its own parked cars, as many as alone, none of them the town\'s', `${pd.length} and ${pe.length} (alone: ${aloneCount})`);
    const list = pd.map((c) => ({ id: c[0], kind: c[1], color: c[2], x: c[3], z: c[4], h: c[5] }));
    const pick = list.filter((c) => dist(c, di) > 20 && c.kind !== 'bus').sort((p, q) => dist(p, di) - dist(q, di))[0];
    const ok = await getIn(D, pick, pick.kind);
    await D.page.keyboard.down('KeyW'); await sleep(3000); await D.page.keyboard.up('KeyW');
    await sleep(1500);
    const [n1, n2, pe2] = await Promise.all([D.net(), E.net(), E.parked()]);
    check(ok && n1.cars.asks === 0 && n1.cars.grants === 0, 'one gets into a parked car at once, without asking anybody', `asks ${n1.cars.asks}`);
    check(pe2.some((c) => c[0] === pick.id) && n2.cars.empty === 0 && n2.remotes.some((q) => q.vehicle === pick.kind), 'the other still has its own copy of that car in its place, and sees the first drive theirs: as before this step', `${pe2.length} parked on the other screen`);
    const wire = (t) => Object.keys(t.out.n).filter((k) => k.startsWith('2') || k.startsWith('4') || k.startsWith('5'));
    const quiet = (x) => x.cars.parkedSent + x.cars.parkedGot + x.cars.asks + x.cars.asked + x.cars.leaves + x.cars.stood + x.cars.answerBytes + x.cars.askBytes + x.traffic.framesSent + x.traffic.framesGot === 0;
    check(wire(D).length === 0 && wire(E).length === 0 && quiet(n1) && quiet(n2), 'and nothing about cars is sent on the backup: no World, ToHost or ToPlayer frame', `by each page's own counts, and on the wire (kinds seen there: ${[...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])].join(', ') || 'none; a socket opened before the test was listening is not seen'})`);
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
