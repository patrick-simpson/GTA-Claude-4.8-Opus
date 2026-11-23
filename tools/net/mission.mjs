// Multiplayer stage 4, step 2: one player's mission, and one player's job, in a shared town. Headless browsers
// against LOCAL services.
//
//   node tools/net/mission.mjs              every check, and two pictures into shots/net/
//   node tools/net/mission.mjs --noshots
//
// It starts everything itself and stops it again, as tools/net/facts.mjs does: the Node home on 8871 is "main" (found
// through a lookup stand-in on 8872) and a second copy on 8873 is the address the game is given. Never run two of
// these tests at once.
// Two players in town on main, A the host and B its guest. First the GUEST, then the HOST, is the runner, and does:
//  - the story mission "Double-Entry" (m03: the shortest with a mission car, a white van to bring to Gus) and
//  - a shift in a cab with one fare, picked up and paid.
// What is checked, each time from the runner's screen, the other player's screen and the host's list of town cars:
// the van is shown to the other player from the moment the script makes it, parked, as the runner's; with the runner
// at the wheel there is one van, the runner's; when the runner gets out it stays the runner's (not handed to the
// town, nothing asked of the host), the other player cannot get into it, and nothing is sent while it stands; when
// the clock runs out and the runner tries again there is one van, on every screen, and no copy where the old one
// stood; a van that burns out with the runner beside it is not made one of the host's wrecks, and when the mission is
// set aside it is gone for everybody; the mission run to its end pays the runner and nobody else, and the van, which
// the runner is sitting in, is from then on an ordinary car that goes to the town when they get out. The cab: the
// same while the job holds it, and the town's once the shift is over. A towing job started by the guest never takes
// one of the town's parked cars off the guest's screen, and the car to be towed is shown to the other player. A third
// browser that arrives while a job holds a car is shown it (one more list); when the holder leaves town it is gone.
// The test makes its own situations and says where it does:
//  - WHO IS HOST is pinned as in facts.mjs (B says it cannot host, as a hidden tab does).
//  - The runner's save is given the two missions before this one, and the mission is started with the runner's own
//    start() instead of walking to Gus. Dialogue is read with the G key; doors are the F key.
//  - Nobody drives across town (the pages run at a fraction of full speed, with no video card): the car the runner
//    sits in is PUT where the script wants it, standing still, and the script then sees it there as it would a
//    driven one. The cab is made with the drive() test hook.
//  - Clocks are run out by the test: the mission's countdown, the 25 s "walk away" wait, the job's 20 s off the clock.
//  - The van is burnt out with the game's own charCar().
// Every line carries the facts it was judged on, so a FAIL line is also the record of what the screens showed.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8871, LOOKUP = 8872, BACKUP = 8873;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-mission-'));
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
const open = [];
async function visitor(tag, query, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  // Binary frames this page sends, counted on the wire itself, by kind and by what they carry: '3.9' is an Event
  // saying which cars a script is holding for this player, '4.3' a Take (asking the host for a car), '4.4' a Leave
  // (handing the host a car).
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] >= 2 && p[0] <= 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  /** This player's own car. */
  t.car = () => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { kind: v.spec.kind, color: v.color, x: v.x, z: v.z, h: v.h, speed: v.speed, health: v.health, shared: !!v.shared, held: !!v.held } : null; });
  /** The story and the jobs as this player has them: the mission in hand, what it wants, the job, the cash, what is filed. */
  t.todo = () => t.page.evaluate(() => {
    const g = window.__game.game, td = g.todo, m = td.missions, j = td.jobs;
    return { busy: td.busy, cur: m.cur ? m.cur.id : null, failed: m.failed, want: m.want(), job: j.want(), money: g.player.money, filed: td.save.data.missions.slice(), fares: td.save.data.stats.fares, heat: g.player.heat, health: g.player.health };
  });
  /** A car a script of this player's made or is using: the mission's by its tag, the job's towed car ('#towed'). */
  t.mine = (tag) => t.page.evaluate((tag) => {
    const g = window.__game.game, td = g.todo, v = tag === '#towed' ? td.jobs.towed : td.missions.ents.get(tag);
    return v && v.spec ? { kind: v.spec.kind, color: v.color, x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h, driver: v.driver, shared: !!v.shared, held: !!v.held, wreck: !!v.wreck, listed: g.vehicles.list.includes(v) } : null;
  }, tag);
  /**
   * Every car of a kind within r of a point, as this browser has it, that was not already standing in town when the
   * test last called mark() and is not one of the traffic's with its driver in it. `list`: the cars on its streets
   * (its own to simulate, or the town's placed by the host: shared). `ghosts`: other players' cars, drawn and solid
   * here, with nobody able to get in (the car a player is driving, driver 'ai'; a car a script holds for them,
   * parked, driver null). `town`: on the host, the standing cars its traffic frames carry (the town's cars).
   */
  t.seen = (kind, x, z, r = 9) => t.page.evaluate(([kind, x, z, r]) => {
    const g = window.__game.game, near = (v) => v.spec.kind === kind && Math.hypot(v.x - x, v.z - z) < r && !v.removed && !v.sunk;
    const one = (v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1), driver: v.driver, shared: !!v.shared, held: !!v.held, wreck: !!v.wreck });
    const pre = g.vehicles.list.filter((v) => v.__pre);
    const info = g.net.shared.info();
    const town = info.mode !== 'host' ? [] : info.cars.filter((c) => c.kind === kind && c.driver === null && Math.hypot(c.x - x, c.z - z) < r && !pre.some((v) => Math.hypot(v.x - c.x, v.z - c.z) < 0.6));
    return { list: g.vehicles.list.filter((v) => near(v) && !v.__pre && v.driver !== 'ai').map(one), ghosts: g.vehicles.ghostList.filter(near).map(one), town };
  }, [kind, x, z, r]);
  /** Every car on this browser's streets now is "already in town": seen() leaves them out from here on. */
  t.mark = () => t.page.evaluate(() => { for (const v of window.__game.game.vehicles.list) v.__pre = true; });
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const wire = (t, k, what = 'n') => t.out[what][k] ?? 0;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** Wait until fn() is truthy. */
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8872|request failed: ws/;

/** One car as a few words. */
const car1 = (c) => `${c.wreck ? 'wreck' : 'car'} at ${c.x},${c.z} ${c.driver === 'player' ? 'driven by this player' : c.driver === 'ai' ? 'with a driver' : 'nobody in it'}${c.shared ? ', the town\'s (placed by the host)' : ''}${c.held ? ', held by a script' : ''}`;
const seenText = (s) => `${s.list.length} on its streets${s.list.length ? ' (' + s.list.map(car1).join('; ') + ')' : ''}, ${s.ghosts.length} drawn as another player's${s.ghosts.length ? ' (' + s.ghosts.map(car1).join('; ') + ')' : ''}`;
/** Cars a script is holding for player `id`, as page t is shown them (nothing on a page from before this step). */
const heldBy = (n, id, kind) => (n.held?.theirs ?? []).filter((c) => c.id === id && (!kind || c.kind === kind));
/** Everything about one kind of car round one point, from all three points of view, in one line. */
async function look(R, O, H, kind, at, r = 9) {
  const [rs, os, hs, on, rn] = await Promise.all([R.seen(kind, at.x, at.z, r), O.seen(kind, at.x, at.z, r), H.seen(kind, at.x, at.z, r), O.net(), R.net()]);
  const town = hs.town;
  const theirs = heldBy(on, rn.id, kind).filter((c) => Math.hypot(c.x - at.x, c.z - at.z) < r);
  const driving = on.remotes.filter((p) => p.id === rn.id && p.vehicle === kind && Math.hypot(p.x - at.x, p.z - at.z) < r).length;
  const text = `runner ${R.tag}: ${seenText(rs)} | other ${O.tag}: ${seenText(os)}; of those ${theirs.length} shown as held for ${R.tag}, ${driving} as ${R.tag} driving | host ${H.tag}'s standing town cars there: ${town.length}${town.length ? ' (' + town.map((c) => `#${c.id} ${c.driver ? 'driven' : 'standing'} health ${c.health}`).join(', ') + ')' : ''}`;
  return { rs, os, town, theirs, driving, text };
}

/** Stand beside a car at (x, z) heading h, facing it. side -1: the driver's door. */
const beside = (t, c, side = -1) => t.go(c.x + Math.cos(c.h) * 2.3 * side, c.z - Math.sin(c.h) * 2.3 * side, c.h);
/** Walk to a car and get in with the door key: true once this player is at its wheel. */
async function getIn(t, c, kind, tries = 3) {
  for (let k = 0; k < tries; k++) {
    await beside(t, c, k % 2 ? 1 : -1);
    await sleep(700);
    await t.key('KeyF');
    const ok = await wait(async () => { const v = await t.car(); return v && v.kind === kind; }, 15000);
    if (ok) return true;
  }
  return false;
}
async function getOut(t) {
  await wait(async () => { const v = await t.car(); return !v || Math.abs(v.speed) < 0.15; }, 25000);
  const at = await t.car();
  if (!at) return null;
  await t.key('KeyF');
  const out = await wait(async () => !(await t.car()), 20000);
  return out ? at : null;
}
/** Read the dialogue (G) until the script wants something done, or the mission is over. */
async function read(t, tries = 60) {
  for (let k = 0; k < tries; k++) {
    const s = await t.todo();
    if (!s.cur || s.failed || (s.want && s.want.t !== 'say')) return s;
    await t.key('KeyG');
    await sleep(350);
  }
  return t.todo();
}
/**
 * PUT the car this player sits in near `at` (within `reach` m), standing still, clear of walls and of every other car.
 * The header says why nobody drives there. Returns where it was put.
 */
const put = (t, at, reach = 7) => t.page.evaluate(async ([at, reach]) => {
  const g = window.__game.game, v = g.player.vehicle;
  if (!v) return null;
  const { groundAt, isWater } = await import('/src/world/plan.ts');
  const all = [...g.vehicles.list, ...g.vehicles.ghostList];
  const free = (x, z) => {
    if (isWater(x, z)) return false;
    const y = groundAt(x, z);
    for (const o of all) if (o !== v && !o.removed && Math.hypot(o.x - x, o.z - z) < 6.5) return false;
    for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) if (g.col.pointBlocked(x + dx, z + dz, y + 0.5) || g.col.resolveCircle({ x: x + dx, z: z + dz }, 1.1, y)) return false;
    return true;
  };
  let spot = null;
  for (let r = 0; r <= reach && !spot; r += 1.5) for (let k = 0; k < (r ? 12 : 1) && !spot; k++) { const a = k / 12 * Math.PI * 2, x = at.x + Math.cos(a) * r, z = at.z + Math.sin(a) * r; if (free(x, z)) spot = { x, z }; }
  spot = spot ?? { x: at.x, z: at.z };
  v.x = spot.x; v.z = spot.z; v.y = Math.max(groundAt(spot.x, spot.z), 0);
  v.vx = v.vy = v.vz = 0; v.yawRate = 0; v.pitch = 0; v.roll = 0;
  g.vehicles.wake(v);
  g.cam.snap();
  return { x: +spot.x.toFixed(2), z: +spot.z.toFixed(2), far: +Math.hypot(spot.x - at.x, spot.z - at.z).toFixed(1) };
}, [at, reach]);
/** A place on the roadway, 30 to 200 m from `from`, with no car within 12 m: somewhere for the test to make a cab. */
const clearRoad = (t, from) => t.page.evaluate(([from]) => {
  const g = window.__game.game, all = [...g.vehicles.list, ...g.vehicles.ghostList];
  let best = null;
  for (const n of g.plan.nodes) {
    const d = Math.hypot(n.x - from.x, n.z - from.z);
    if (d < 30 || d > 200 || n.land !== 0 || !(n.hx > 0) || !(n.hz > 0)) continue;
    if (all.some((o) => !o.removed && Math.hypot(o.x - n.x, o.z - n.z) < 12)) continue;
    if (!best || d < best.d) best = { x: n.x, z: n.z, d };
  }
  return best;
}, [from]);
/** No police of this page's own making in the way of the checks (as cars.mjs does). */
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });

/** The mission, from the first line to the pay, with `R` running it and `O` looking on. `H` is the host (one of the two). */
async function story(R, O, H, shots) {
  const who = `${R.tag} (${R === H ? 'the host' : 'a guest'}) runs "Double-Entry"`;
  const rid = (await R.net()).id;
  const spot = { x: 313.5, z: 262 };
  const kerb = await R.page.evaluate(([x, z]) => { const n = window.__game.game.plan.nearestNode(x, z); return n.x + n.hx + 2.2; }, [spot.x, spot.z]);
  // (The other player stands more than 30 m off while the mission begins: within that it would be on the runner's crew
  // (stage 4, step 3, crew.mjs). This test is about a mission that is the runner's alone.)
  await R.go(kerb, spot.z - 3, 0); await O.go(kerb, spot.z - 45, 0);
  await calm(R); await calm(O);
  await sleep(2500);
  await R.mark(); await O.mark();
  const before = await look(R, O, H, 'van', spot);
  const inWay = await Promise.all([R, O].map((t) => t.page.evaluate(([x, z]) => window.__game.game.vehicles.list.filter((v) => Math.hypot(v.x - x, v.z - z) < 5).map((v) => `${v.spec.kind}${v.shared ? ' (the town\'s)' : ''}`), [spot.x, spot.z])));
  const o0 = await O.todo();
  const held0 = { n: wire(R, '3.9'), b: wire(R, '3.9', 'bytes') }, take0 = wire(O, '4.3'), leave0 = wire(R, '4.4');
  const other0 = wire(O, '3.9');
  const heldSent = () => `${wire(R, '3.9') - held0.n} frames, ${wire(R, '3.9', 'bytes') - held0.b} bytes from ${R.tag} so far; ${wire(O, '3.9') - other0} from ${O.tag}`;

  // ── The script makes the van ──
  await R.page.evaluate(() => {
    const td = window.__game.game.todo, d = td.save.data.missions;
    for (const id of ['m01', 'm02']) if (!d.includes(id)) d.push(id);
    td.missions.start(td.missions.missions.find((m) => m.id === 'm03'));
  });
  let s = await read(R);
  await O.go(kerb, spot.z - 11, 0);
  let van = await R.mine('van');
  check(s.cur === 'm03' && !!s.want && s.want.t === 'getVehicle' && !!van && van.listed, `${who}: the lines are read and the script has made the white van`, `wants ${s.want ? s.want.t : 'nothing'}; van ${van ? car1(van) : 'none'}; standing on the spot before: ${R.tag} had ${inWay[0].join(', ') || 'nothing'}, ${O.tag} had ${inWay[1].join(', ') || 'nothing'} (vans: ${before.text})`);
  if (!van) throw new Error('no mission van: the rest cannot run');
  const at = { x: van.x, z: van.z };
  await sleep(3000);
  let v = await look(R, O, H, 'van', at);
  check(v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 1 && !v.os.ghosts[0].driver && v.town.length === 0 && v.rs.list.length === 1 && !v.rs.list[0].shared,
    `${who}: the parked van is on the other screen too, as ${R.tag}'s, and is not one of the town's cars`, v.text);

  // ── At the wheel ──
  let ok = await getIn(R, van, 'van');
  await sleep(2500);
  s = await read(R);
  v = await look(R, O, H, 'van', at);
  check(ok && v.driving === 1 && v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 0 && v.town.length === 0 && s.want && s.want.t === 'deliver',
    `${who}: at its wheel, the other screen has one van, ${R.tag} driving it`, `the script wants ${s.want ? s.want.t : 'nothing'}; ${v.text}`);

  // ── Out of it ──
  const h1 = wire(R, '3.9');
  let left = await getOut(R);
  await sleep(9000);
  van = await R.mine('van');
  v = await look(R, O, H, 'van', at);
  check(!!left && !!van && van.listed && !van.shared && wire(R, '4.4') === leave0 && v.town.length === 0,
    `${who}: the runner gets out: the van stays ${R.tag}'s own (not handed to the town, nothing asked of the host)`, `van on ${R.tag}: ${van ? car1(van) : 'gone'}; Leaves sent ${wire(R, '4.4') - leave0}; ${v.text}`);
  check(v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 1 && !v.os.ghosts[0].driver && v.driving === 0,
    `${who}: and the other screen shows it parked there, once, as ${R.tag}'s`, v.text);
  if (shots) {
    // The same view on both screens: the runner beside the van it has just got out of.
    const view = [at.x + 9, 5, at.z - 12, at.x, 0.8, at.z + 1];
    for (const t of [R, O]) await t.page.evaluate((x) => window.__game.view(...x), view);
    await O.go(kerb + 1.5, at.z - 5, 0);
    await sleep(6000);
    await Promise.all([H.shot('shots/net/mission-host.png'), (H === R ? O : R).shot('shots/net/mission-guest.png')]);
    v = await look(R, O, H, 'van', at);
    check(v.os.ghosts.length + v.os.list.length === 1 && v.rs.list.length === 1, 'pictures: shots/net/mission-host.png and mission-guest.png (the guest beside its mission van, the same van on the host\'s screen)', v.text);
    for (const t of [R, O]) await t.page.evaluate(() => window.__game.view());
  }
  // Ten seconds with nothing happening to it.
  {
    const n0 = wire(R, '3.9');
    await sleep(10000);
    check(wire(R, '3.9') === n0 && wire(O, '3.9') === other0, `${who}: while the van stands, nothing is sent about it`, `${wire(R, '3.9') - n0} frames in 10 s; getting out cost ${wire(R, '3.9') - h1}; ${heldSent()}`);
  }
  // The other player tries the door.
  // (From the road side: there may be a car of the town's at the kerb, and that one does have a door.)
  await beside(O, van, -1);
  await sleep(700);
  await O.key('KeyF');
  await sleep(9000);
  let oc = await O.car();
  s = await R.todo();
  v = await look(R, O, H, 'van', at, 14);
  check((!oc || oc.kind !== 'van') && s.cur === 'm03' && !s.failed && v.rs.list.length === 1 && v.theirs.length === 1,
    `${who}: the other player tries the door: it is not theirs to take, and the mission goes on`, `${O.tag} is ${oc ? 'at the wheel of a ' + oc.kind : 'on foot'}, asked the host ${wire(O, '4.3') - take0} times; ${R.tag}'s mission: ${s.cur ?? 'none'}${s.failed ? ', failed: ' + s.failed : ''}; ${v.text}`);
  if (oc) { await getOut(O); await sleep(6000); }
  // (Out of the 30 m the retry below drafts from: see the top of this function.)
  await O.go(kerb, at.z - 45, 0);

  // ── The clock runs out, and the runner tries again ──
  s = await R.todo();
  if (!s.failed && s.cur === 'm03') await R.page.evaluate(() => { window.__game.game.todo.missions.timer = 0.01; });
  s = await wait(async () => { const x = await R.todo(); return x.failed ? x : null; }, 15000) ?? await R.todo();
  await sleep(2500);
  v = await look(R, O, H, 'van', at, 14);
  check(!!s.failed && v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 1 && v.town.length === 0,
    `${who}: the mission fails with the runner out of the van (the clock): the van is still there as ${R.tag}'s`, `failed: ${s.failed ?? 'no'}; ${v.text}`);
  await R.key('KeyG');
  s = await wait(async () => { const x = await R.todo(); return x.cur === 'm03' && !x.failed ? x : null; }, 15000) ?? await R.todo();
  // (Long enough for a car the host still had to be shown again: its record goes whole every 8 s.)
  await sleep(11000);
  let rc = await R.car();
  v = await look(R, O, H, 'van', at, 30);
  check(s.cur === 'm03' && !s.failed && !!rc && rc.kind === 'van' && v.rs.list.length === 1 && v.rs.ghosts.length === 0 && v.os.list.length === 0 && v.os.ghosts.length === 1 && v.driving === 1 && v.town.length === 0,
    `${who}: tried again from the checkpoint: one van on every screen, the runner in it, and no copy left behind`, `${R.tag} is ${rc ? 'in a ' + rc.kind : 'on foot'}; mission ${s.cur ?? 'none'}${s.failed ? ', failed: ' + s.failed : ''}; within 30 m: ${v.text}`);

  // ── Burnt out beside the runner, then set aside ──
  left = await getOut(R);
  await sleep(4000);
  await R.page.evaluate(async () => {
    const { charCar } = await import('/src/ent/weapons.ts');
    const v = window.__game.game.todo.missions.ents.get('van');
    if (v) charCar(v);
  });
  s = await wait(async () => { const x = await R.todo(); return x.failed ? x : null; }, 15000) ?? await R.todo();
  await sleep(5000);
  van = await R.mine('van');
  v = await look(R, O, H, 'van', at, 14);
  check(s.failed === 'WRITTEN OFF' && !!van && van.wreck && !van.shared && v.town.length === 0 && v.os.list.length === 0 && v.os.ghosts.length === 1 && v.os.ghosts[0].wreck && v.theirs.length === 1,
    `${who}: the van burns out with the runner out of it: the job is written off, the wreck is still ${R.tag}'s (not one of the host's), and the other screen shows it burnt`, `failed: ${s.failed ?? 'no'}; van on ${R.tag}: ${van ? car1(van) : 'gone'}; ${v.text}`);
  // Walked away from: the 25 s wait is run out.
  await R.page.evaluate(() => { const m = window.__game.game.todo.missions; if (m.cur && m.failed) m.failT = 26; });
  s = await wait(async () => { const x = await R.todo(); return !x.cur ? x : null; }, 15000) ?? await R.todo();
  await sleep(11000);
  v = await look(R, O, H, 'van', at, 30);
  check(!s.cur && s.busy === null && v.rs.list.length + v.rs.ghosts.length === 0 && v.os.list.length + v.os.ghosts.length === 0 && v.town.length === 0 && v.theirs.length === 0,
    `${who}: the mission is set aside: the van is gone for everybody (the runner, the other player, the host's town)`, `mission ${s.cur ?? 'none'}; within 30 m: ${v.text}`);

  // ── Again, to the end ──
  const cash0 = s.money;
  await R.go(kerb, spot.z - 3, 0);
  await O.go(kerb, spot.z - 45, 0);
  await sleep(1500);
  await R.page.evaluate(() => { const td = window.__game.game.todo; td.missions.start(td.missions.missions.find((m) => m.id === 'm03')); });
  s = await read(R);
  await O.go(kerb, spot.z - 11, 0);
  van = await R.mine('van');
  ok = !!van && await getIn(R, van, 'van');
  s = await read(R);
  const gus = s.want && s.want.at ? s.want.at : { x: 35.5, z: 295.7 };
  const where = await put(R, gus);
  s = await wait(async () => { const x = await read(R); return !x.cur ? x : null; }, 40000, 500) ?? await R.todo();
  await sleep(4000);
  const o1 = await O.todo();
  rc = await R.car();
  v = await look(R, O, H, 'van', where ?? gus, 14);
  check(ok && !s.cur && s.filed.includes('m03') && s.money === cash0 + 250, `${who}: taken up again and run to the end (the van is put at Gus's by the test): filed, and the runner is paid 250`, `put ${where ? `${where.far} m from the ring` : 'nowhere'}; filed ${s.filed.join(' ')}; cash ${cash0} to ${s.money}`);
  check(o1.money === o0.money && o1.filed.length === o0.filed.length && o1.busy === null && o1.cur === null, `${who}: the other player is paid nothing and has nothing filed or in hand`, `${O.tag}: cash ${o0.money} to ${o1.money}, filed ${o1.filed.join(' ') || 'nothing'}, busy ${o1.busy ?? 'no'}`);
  check(!!rc && rc.kind === 'van' && !rc.held && v.driving === 1 && v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 0 && v.town.length === 0,
    `${who}: at the end the runner is still sitting in the van: it is an ordinary car of theirs now, one on each screen`, `${R.tag} is ${rc ? `in a ${rc.kind}${rc.held ? ' (still held)' : ''}` : 'on foot'}; ${v.text}`);
  left = await getOut(R);
  const stood = await wait(async () => { const x = await look(R, O, H, 'van', where ?? gus, 14); return x.town.length === 1 && x.os.list.length === 1 && x.os.ghosts.length === 0 ? x : null; }, 25000, 500);
  v = stood ?? await look(R, O, H, 'van', where ?? gus, 14);
  check(!!stood && v.rs.list.length === 1 && v.town.length === 1, `${who}: the runner gets out: now it is handed to the town like any car, and stands there once on each screen`, v.text);
  console.log(`      bytes: cars held for ${R.tag} over the whole mission: ${heldSent()}`);
  return where ?? gus;
}

/** One shift in a cab with one fare, `R` driving and `O` looking on. */
async function fare(R, O, H, from) {
  const who = `${R.tag} (${R === H ? 'the host' : 'a guest'}) takes a fare`;
  const road = await clearRoad(R, from);
  if (!road) { check(false, `${who}: a clear place on the road for the test's cab`, 'none found'); return; }
  await R.go(road.x, road.z, 0);
  await calm(R); await calm(O);
  await sleep(1500);
  await R.mark(); await O.mark();
  const o0 = await O.todo(), s0 = await R.todo();
  const held0 = { n: wire(R, '3.9'), b: wire(R, '3.9', 'bytes') }, take0 = wire(O, '4.3'), leave0 = wire(R, '4.4');
  await R.page.evaluate(() => window.__game.drive('taxi'));
  await sleep(2500);
  const began = await R.page.evaluate(() => window.__game.game.todo.jobs.startJob('taxi'));
  let s = await R.todo();
  check(began && s.busy === 'taxi' && s.job.phase === 0 && !!s.job.at, `${who}: in a cab (made by the test), the shift starts and somebody is waiting`, `busy ${s.busy ?? 'no'}; the fare is ${s.job.at ? `${Math.round(dist(s.job.at, road))} m off` : 'nowhere'}`);
  if (!began || !s.job.at) return;
  let where = await put(R, s.job.at, 6.5);
  s = await wait(async () => { const x = await R.todo(); return x.job.phase === 1 ? x : null; }, 20000) ?? await R.todo();
  check(s.job.phase === 1 && !!s.job.at, `${who}: the cab is put beside the fare, who gets in: there is somewhere to take them`, `phase ${s.job.phase}; put ${where ? where.far + ' m from them' : 'nowhere'}; ${s.job.at ? Math.round(dist(s.job.at, where ?? road)) + ' m to go' : ''}`);
  const dest = s.job.at;
  const at = where ?? road;
  await O.go(at.x + 5, at.z + 5, 0);
  await sleep(3000);
  let v = await look(R, O, H, 'taxi', at, 6);
  check(v.driving === 1 && v.os.ghosts.length === 1 && v.os.list.length === 0 && v.town.length === 0, `${who}: the other screen has the one cab, ${R.tag} driving it`, v.text);

  // Out of the cab in the middle of the fare.
  const left = await getOut(R);
  await sleep(9000);
  let rs = await R.seen('taxi', at.x, at.z, 6);
  v = await look(R, O, H, 'taxi', at, 6);
  s = await R.todo();
  check(!!left && s.busy === 'taxi' && rs.list.length === 1 && !rs.list[0].shared && wire(R, '4.4') === leave0 && v.town.length === 0,
    `${who}: out of the cab in the middle of the fare: the job is still on and the cab stays ${R.tag}'s own (not handed to the town)`, `busy ${s.busy ?? 'no'}; Leaves sent ${wire(R, '4.4') - leave0}; ${v.text}`);
  check(v.os.ghosts.length === 1 && v.os.list.length === 0 && v.theirs.length === 1 && !v.os.ghosts[0].driver, `${who}: and the other screen shows it parked there, once, as ${R.tag}'s`, v.text);
  if (left) {
    await beside(O, left, -1);
    await sleep(700);
    await O.key('KeyF');
    await sleep(9000);
  }
  const oc = await O.car();
  s = await R.todo();
  v = await look(R, O, H, 'taxi', at, 6);
  check((!oc || oc.kind !== 'taxi') && s.busy === 'taxi' && v.theirs.length === 1 && v.rs.list.length === 1, `${who}: the other player tries the cab's door: it is not theirs to take, and the job goes on`, `${O.tag} is ${oc ? 'at the wheel of a ' + oc.kind : 'on foot'}, asked the host ${wire(O, '4.3') - take0} times; ${R.tag} busy ${s.busy ?? 'no'}`);
  if (oc) { await getOut(O); await sleep(6000); }
  await O.go(at.x + 5, at.z + 5, 0);

  // Back in, and the fare is taken where they are going.
  const back = !!left && await getIn(R, left, 'taxi');
  s = await R.todo();
  where = back && s.busy === 'taxi' && dest ? await put(R, s.job.at ?? dest, 6.5) : null;
  s = await wait(async () => { const x = await R.todo(); return x.fares > s0.fares ? x : null; }, 20000) ?? await R.todo();
  const o1 = await O.todo();
  check(back && s.fares === s0.fares + 1 && s.money > s0.money, `${who}: back in, the cab is put where the fare is going: paid`, `back in ${back}; fares ${s0.fares} to ${s.fares}; cash ${s0.money} to ${s.money}`);
  check(o1.money === o0.money && o1.fares === o0.fares && o1.busy === null, `${who}: the other player is paid nothing for it`, `${O.tag}: cash ${o0.money} to ${o1.money}, fares ${o1.fares}, busy ${o1.busy ?? 'no'}`);

  // The shift ends with the runner out of the cab: the 20 s are run out.
  const end = where ?? at;
  await O.go(end.x + 5, end.z + 5, 0);
  const out = await getOut(R);
  await sleep(1500);
  await R.page.evaluate(() => { const j = window.__game.game.todo.jobs; if (j.job === 'taxi') j.awayT = 19.9; });
  s = await wait(async () => { const x = await R.todo(); return x.busy === null ? x : null; }, 20000) ?? await R.todo();
  const stood = await wait(async () => { const x = await look(R, O, H, 'taxi', end, 6); return x.town.length === 1 && x.os.list.length === 1 && x.os.ghosts.length === 0 ? x : null; }, 30000, 500);
  v = stood ?? await look(R, O, H, 'taxi', end, 6);
  check(!!out && s.busy === null && !!stood && v.rs.list.length === 1 && v.theirs.length === 0, `${who}: off the clock with the runner out of the cab: the cab goes to the town like any car, once on each screen`, `busy ${s.busy ?? 'no'}; ${v.text}`);
  console.log(`      bytes: cars held for ${R.tag} over the shift: ${wire(R, '3.9') - held0.n} frames, ${wire(R, '3.9', 'bytes') - held0.b} bytes`);
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];

  // ── 1. Two in town on main, A the host ──
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain, size);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  const roles = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.traffic.mode === 'host' && b.traffic.mode === 'guest' && b.host === a.id ? [a, b] : null; }, 60000);
  check(!!n && !!roles, 'B is in town with A: A is the host, B its guest', roles ? `A ${roles[0].traffic.mode}, B ${roles[1].traffic.mode}` : 'no host and guest');
  await sleep(3000);

  // ── 2. The guest's mission and fare ──
  let at = await story(B, A, A, SHOTS);
  await fare(B, A, A, at);

  // ── 3. A guest's towing job and the town's parked cars ──
  {
    const road = await clearRoad(B, at);
    if (road) await B.go(road.x, road.z, 0);
    await sleep(1500);
    await B.page.evaluate(() => window.__game.drive('tow'));
    await sleep(2000);
    const bid = (await B.net()).id;
    const p0 = (await B.page.evaluate(() => window.__game.game.net.cars.list())).length;
    let lost = 0, rounds = 0, shownHeld = 0, goneAfter = 0;
    const notes = [];
    for (let k = 0; k < 4; k++) {
      const began = await B.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
      if (!began) { notes.push('no job'); continue; }
      rounds++;
      await sleep(2500);
      const towed = await B.mine('#towed');
      const p1 = (await B.page.evaluate(() => window.__game.game.net.cars.list())).length;
      const os = towed ? await A.seen(towed.kind, towed.x, towed.z, 3) : null;
      const theirs = towed ? heldBy(await A.net(), bid, towed.kind).filter((c) => Math.hypot(c.x - towed.x, c.z - towed.z) < 3).length : 0;
      if (theirs === 1 && os && os.ghosts.length === 1) shownHeld++;
      lost += p0 - p1;
      await B.page.evaluate(() => window.__game.game.todo.jobs.stop());
      await sleep(2500);
      const after = towed ? await A.seen(towed.kind, towed.x, towed.z, 3) : null;
      if (after && after.ghosts.length === 0) goneAfter++;
      notes.push(`${towed ? `${towed.kind} at ${towed.x},${towed.z}` : 'no car'}: the guest's town cars ${p0} to ${p1}; on the host ${os ? os.ghosts.length : 0} drawn as B's (${theirs} held), ${after ? after.ghosts.length : '?'} after the job is dropped`);
    }
    const p2 = (await B.page.evaluate(() => window.__game.game.net.cars.list())).length;
    check(rounds >= 2 && lost === 0 && p2 === p0, 'a guest starts and drops towing jobs: none of the town\'s parked cars leaves the guest\'s screen for it', `${rounds} jobs; ${notes.join(' | ')}; at the end ${p2} of ${p0}`);
    check(rounds >= 2 && shownHeld === rounds && goneAfter === rounds, 'and the car to be towed is on the host\'s screen as the guest\'s while the job has it, and gone when it is dropped', `${shownHeld} of ${rounds} shown, ${goneAfter} of ${rounds} gone afterwards`);
    await getOut(B);
    await sleep(4000);
  }

  // ── 4. The host's mission and fare ──
  at = await story(A, B, A, false);
  await fare(A, B, A, at);

  // ── 5. What it cost, and the errors ──
  {
    const [na, nb] = await Promise.all([A.net(), B.net()]);
    console.log(`      bytes: every "held cars" frame of the run: A ${wire(A, '3.9')} frames, ${wire(A, '3.9', 'bytes')} bytes; B ${wire(B, '3.9')} frames, ${wire(B, '3.9', 'bytes')} bytes (all sent bytes: A ${na.sent.bytes ?? '?'}, B ${nb.sent.bytes ?? '?'})`);
    const n0 = wire(A, '3.9') + wire(B, '3.9');
    await sleep(10000);
    check(wire(A, '3.9') + wire(B, '3.9') === n0, 'with no mission or job in hand, nothing is sent about held cars (10 s)', `${wire(A, '3.9') + wire(B, '3.9') - n0} frames`);
    const errs = [...A.errors, ...B.errors].filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on A or B', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
  }

  // ── 6. Somebody arrives while a job is holding a car; then the holder leaves town ──
  {
    const road = await clearRoad(B, at);
    if (road) await B.go(road.x, road.z, 0);
    await sleep(1500);
    await B.page.evaluate(() => window.__game.drive('tow'));
    await sleep(2000);
    let began = false;
    for (let k = 0; k < 5 && !began; k++) began = await B.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    await sleep(3000);
    const towed = await B.mine('#towed'), bid = (await B.net()).id, n0 = wire(B, '3.9'), a0 = wire(A, '3.9');
    const C = await visitor('C', viaMain);
    await C.pin(true);
    n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
    const got = towed && await wait(async () => { const [sc, nc] = await Promise.all([C.seen(towed.kind, towed.x, towed.z, 3), C.net()]); return sc.ghosts.length === 1 && sc.list.length === 0 && heldBy(nc, bid, towed.kind).length === 1 ? sc : null; }, 40000, 500);
    await sleep(2000);
    const cs = towed ? await C.seen(towed.kind, towed.x, towed.z, 3) : null;
    check(began && !!n && !!got && wire(B, '3.9') - n0 === 1 && wire(A, '3.9') === a0 && wire(C, '3.9') === 0,
      'C arrives while B\'s towing job holds a car: C is shown it as B\'s, for one more list from B and nothing from anybody else', `job ${began}; ${towed ? `${towed.kind} at ${towed.x},${towed.z}` : 'no car'}; C: ${cs ? seenText(cs) : 'nothing'}; lists from B since C came: ${wire(B, '3.9') - n0} (${wire(B, '3.9', 'bytes')} bytes in all), from A ${wire(A, '3.9') - a0}, from C ${wire(C, '3.9')}`);
    // B closes the page with the job still on.
    await leave(B);
    const gone = towed && await wait(async () => { const [sa, sc] = await Promise.all([A.seen(towed.kind, towed.x, towed.z, 3), C.seen(towed.kind, towed.x, towed.z, 3)]); return sa.ghosts.length + sa.list.length + sa.town.length === 0 && sc.ghosts.length + sc.list.length === 0 ? [sa, sc] : null; }, 40000, 500);
    const [sa, sc] = gone || (towed ? await Promise.all([A.seen(towed.kind, towed.x, towed.z, 3), C.seen(towed.kind, towed.x, towed.z, 3)]) : [null, null]);
    check(!!gone, 'B leaves town with the job still on: the car it was holding is gone from the other two screens', `A: ${sa ? seenText(sa) : 'nothing'}, town cars there ${sa ? sa.town.length : '?'} | C: ${sc ? seenText(sc) : 'nothing'}`);
    const errs = [...A.errors, ...C.errors].filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on A or C', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
