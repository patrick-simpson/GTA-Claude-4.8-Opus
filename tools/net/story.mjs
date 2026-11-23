// Multiplayer stage 4, step 5: the rest of "the same story". Headless browsers against LOCAL services.
//
//   node tools/net/story.mjs              every check, and two pictures into shots/net/ (story-a.png, story-b.png)
//   node tools/net/story.mjs --noshots
//   node tools/net/story.mjs --only=targets,tail,jobs,pause,town   (a part of it)
//
// Started and stopped as tools/net/crew.mjs is (the same ports: never run two of these tests at once). Three players
// in town on main, A the host (pinned: B and C say they cannot host), B and C its guests.
//  1. targets: B starts "Feathers" (m07: three vans to wreck) with A near, C far. A (the helper) hurts the vans through
//     the same calls its weapons make (rounds: Fight.hitCar; a rocket going off: Weapons.explode; a ram: its own car
//     driven into one): B's browser applies each claim and the vans burn and go up on B's screen, and the step passes.
//     A claim from out of reach is refused; C (not on the crew) does nothing to them, with rounds or a blast.
//  2. tail: B starts "Birdwatching" (m05) with A near. In the tail B stands 200 m off and A follows at about 40 m: the
//     distance that counts is A's and nothing is lost; with A also far off, "Losing them" counts up.
//  3. jobs: C runs a taxi shift, a courier run and a tow; A and B are shown the fare at the kerb (same person, same
//     place), "fare aboard" / "N of M parcels" / "towing" on C's tag, and the towed car behind C's truck. The towed
//     car's cost is measured both ways (the Held list as before, and the hook in the Job frame).
//  4. pause: B pauses at the wheel; A sees PAUSED on B's tag; A's rounds and a blast do nothing to B or B's car; A's car
//     driven into B's does not move it; B resumes and is hurt at once. Pausing is refused while wanted at two pips
//     and just after being hurt, and allowed again a few seconds later.
//  5. town: A (the host) opens stage 2 of the far town on its own: the town takes it; B and C (own stage 0) are told
//     whose points did it, see the town's barriers and park the town's kerb cars (the same ones as A, at the same
//     spot); the menu and the fund box say "the town's" and show B's own apart; then B's points finish stage 3 and
//     C is told it was B's.
// Every line carries the facts it was judged on. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-story-'));
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
  // Binary frames this page sends, by kind and what they carry: '3.10' is a crew frame (Event, PlayerEvent.Crew).
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] >= 2 && p[0] <= 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.crew = () => t.page.evaluate(() => window.__game.net().crew);
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.car = () => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { kind: v.spec.kind, x: v.x, z: v.z, h: v.h, speed: v.speed, held: !!v.held, lent: !!v.lent } : null; });
  t.todo = () => t.page.evaluate(() => {
    const g = window.__game.game, td = g.todo, m = td.missions;
    return { busy: td.busy, cur: m.cur ? m.cur.id : null, failed: m.failed, want: m.want(), money: g.player.money, filed: td.save.data.missions.slice(), offers: m.offers().map((o) => o.m.id), own: window.__game.net().town.own };
  });
  t.mine = (tag) => t.page.evaluate((tag) => {
    const g = window.__game.game, v = g.todo.missions.ents.get(tag);
    return v && v.spec ? { kind: v.spec.kind, x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h, driver: v.driver, held: !!v.held, wreck: !!v.wreck, listed: g.vehicles.list.includes(v), health: +v.health.toFixed(1) } : null;
  }, tag);
  /** Cars of a kind within r of a point on this page: its own (list) and other players' drawn here (ghosts); `door`: in the list as one of the town's kind (shared). */
  t.seen = (kind, x, z, r = 9) => t.page.evaluate(([kind, x, z, r]) => {
    const g = window.__game.game, near = (v) => v.spec.kind === kind && Math.hypot(v.x - x, v.z - z) < r && !v.removed && !v.sunk;
    const one = (v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1), driver: v.driver, shared: !!v.shared, held: !!v.held, lent: !!v.lent });
    return { list: g.vehicles.list.filter((v) => near(v) && v.driver !== 'ai').map(one), ghosts: g.vehicles.ghostList.filter(near).map(one) };
  }, [kind, x, z, r]);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const wire = (t, k, what = 'n') => t.out[what][k] ?? 0;
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8872|request failed: ws/;
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; if (p) p.clear(); });
const beside = (t, c, side = -1) => t.go(c.x + Math.cos(c.h) * 2.3 * side, c.z - Math.sin(c.h) * 2.3 * side, c.h);
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
async function read(t, tries = 60) {
  for (let k = 0; k < tries; k++) {
    const s = await t.todo();
    if (!s.cur || s.failed || (s.want && s.want.t !== 'say')) return s;
    await t.key('KeyG');
    await sleep(350);
  }
  return t.todo();
}
/** PUT the car this player sits in near `at`, standing still, clear of walls and cars (as mission.mjs does). */
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

const g1 = (c) => c.guest ? `${c.guest.who}'s ${c.guest.mission}, objective "${c.guest.objective ?? '(none)'}", timer ${c.guest.timer ?? 'none'}, ${c.guest.marks} marks (${c.guest.blips} blips, ${c.guest.targets} targets), people ${JSON.stringify(c.extras)}` : `not on a crew (last: ${c.lastEnd}, "${c.lastLine}")`;
const STORY = (upTo) => (t) => t.page.evaluate((upTo) => { const d = window.__game.game.todo.save.data.missions; d.length = 0; for (let k = 1; k <= upTo; k++) d.push(`m0${k}`); }, upTo);
async function startM(t, id, filed) {
  await STORY(filed)(t);
  await t.page.evaluate((id) => { const td = window.__game.game.todo; td.missions.start(td.missions.missions.find((m) => m.id === id)); }, id);
}
/** A car of this player's own, made beside them, and them at its wheel (a stand-in for any car off the street). */
const ownCar = (t, kind = 'sedan') => t.page.evaluate((kind) => { const g = window.__game.game, p = g.player, v = g.vehicles.spawn(kind, p.x + 4, p.z, p.h); p.enter(v, true); return !!g.player.vehicle; }, kind);
const onFoot = async (t) => { if (await t.car()) { await t.key('KeyF'); await wait(async () => !(await t.car()), 15000); await sleep(1500); } };
async function three(A, B, C) {
  const ns = await Promise.all([A.net(), B.net(), C.net()]);
  return ns;
}

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const part = (name) => ONLY.length === 0 || ONLY.includes(name);
const hp = (v) => (v ? Math.round(v.health ?? -1) : null);
/** On page t: the car of `kind` nearest (x, z) that is another player's held car drawn here (held.ts), and what it is. */
const shownHeld = (t, x, z) => t.page.evaluate(([x, z]) => {
  const n = window.__game.game.net, list = n.held.list();
  let best = null, bd = 1e9;
  for (const v of list) { const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = v; } }
  return best ? { x: +best.x.toFixed(1), z: +best.z.toFixed(1), d: +bd.toFixed(1), shared: !!best.shared, health: Math.round(best.health), wreck: !!best.wreck, door: n.held.shownSlot(best) } : null;
}, [x, z]);
/** Page t's rounds on that car, through the same call its weapons make when a round strikes a car. */
const shootHeld = (t, x, z, dmg) => t.page.evaluate(([x, z, dmg]) => {
  const n = window.__game.game.net, list = n.held.list();
  let best = null, bd = 1e9;
  for (const v of list) { const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = v; } }
  return best && bd < 6 ? n.fight.hitCar(best, dmg) : null;
}, [x, z, dmg]);
/** A rocket of page t's going off at (x, y, z), as Weapons does when one lands (a Blast for everybody). */
const boom = (t, x, z, r = 6, dmg = 120) => t.page.evaluate(([x, z, r, dmg]) => { const g = window.__game.game; g.player.weapons.explode(x, 0.9, z, r, dmg, true); }, [x, z, r, dmg]);
const runner = (t) => t.page.evaluate(() => { const m = window.__game.game.todo.missions; return { cur: m.cur ? m.cur.id : null, i: m.i, t: m.want()?.t ?? null, farT: m.farT, nearT: m.nearT, failed: m.failed, label: m.view.label, value: m.view.value }; });
const me = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.player, v = p.vehicle; return { x: p.x, z: p.z, health: p.health, heat: p.heat, state: g.state, car: v ? { x: +v.x.toFixed(2), z: +v.z.toFixed(2), health: +v.health.toFixed(1) } : null }; });
const remoteOf = (t, id) => t.page.evaluate((id) => { const r = window.__game.game.net.remotes.get(id); return r ? { paused: r.paused, job: r.job, x: r.x, z: r.z, kind: r.kind } : null; }, id);
const jobsOf = (t) => t.page.evaluate(() => window.__game.game.net.jobs.info());
const towed = (t) => t.page.evaluate(() => { const j = window.__game.game.todo.jobs, v = j.towed; return v ? { x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h, hooked: j.hooked, hl: v.hl } : null; });

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain, size);
  await B.pin(true);
  const C = await visitor('C', viaMain);
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const [a, b, c] = await three(A, B, C); return a.traffic.mode === 'host' && b.traffic.mode === 'guest' && c.traffic.mode === 'guest' ? [a, b, c] : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const [an, bn, cn] = await three(A, B, C);
  {
    // Nothing new is sent while nothing happens: no Job frames and no crew Hit frames.
    await sleep(3000);
    const n0 = ['3.11', '3.10'].reduce((a, k) => a + wire(A, k) + wire(B, k) + wire(C, k), 0);
    await sleep(6000);
    const n1 = ['3.11', '3.10'].reduce((a, k) => a + wire(A, k) + wire(B, k) + wire(C, k), 0);
    check(n0 === 0 && n1 === 0, 'nothing running: no job or crew frames at all (6 s)', `${n0} before, ${n1 - n0} in 6 s`);
  }

  // ── 1. Targets: a helper's rounds, blast and ram on the starter's vans ──
  if (part('targets')) {
    const who = 'B (a guest) starts "Feathers" with A near';
    const at = { x: -130, z: 150 };
    for (const t of [A, B, C]) await onFoot(t);
    await B.go(at.x, at.z); await A.go(at.x + 8, at.z); await C.go(at.x + 120, at.z + 60);
    for (const t of [A, B, C]) await calm(t);
    await sleep(3000);
    await startM(B, 'm07', 6);
    const drafted = await wait(async () => (await A.crew()).boss === bn.id, 15000);
    const cc0 = await C.crew();
    check(!!drafted && cc0.boss === 0, `${who}: A is on B's crew, C is not`, `A boss ${(await A.crew()).boss} (B is ${bn.id}); C boss ${cc0.boss}`);
    let s = await read(B);
    // The goto: B walks there (put on foot).
    if (s.want && s.want.t === 'goto') { await B.go(s.want.at.x, s.want.at.z); await A.go(s.want.at.x + 6, s.want.at.z); }
    s = await wait(async () => { const x = await read(B); return x.want && x.want.t === 'destroy' ? x : null; }, 40000) ?? await B.todo();
    const vans = await Promise.all(['g1', 'g2', 'g3'].map((k) => B.mine(k)));
    check(s.want && s.want.t === 'destroy' && vans.every((v) => v && !v.wreck), `${who}: the step is to wreck the three vans`, `B wants ${s.want ? s.want.t : 'nothing'}; vans ${JSON.stringify(vans.map((v) => v && [v.x, v.z]))}`);
    const [g1, g2, g3] = vans;
    await A.go(g1.x + 14, g1.z, -Math.PI / 2);
    await C.go(g3.x + 18, g3.z + 4);
    await sleep(2500);
    const a1 = await shownHeld(A, g1.x, g1.z), c1 = await shownHeld(C, g3.x, g3.z);
    check(!!a1 && a1.d < 1.5 && a1.shared && !!c1 && c1.d < 1.5 && !c1.shared, `${who}: A is shown the vans with a door (crew), C as another player's cars`, `A: ${JSON.stringify(a1)}; C: ${JSON.stringify(c1)}`);
    // C, not on the crew: rounds and a blast do nothing to them.
    const c0 = await C.crew(), b0 = await B.crew();
    for (let k = 0; k < 3; k++) { await shootHeld(C, g3.x, g3.z, 30); await sleep(300); }
    await boom(C, g3.x + 1, g3.z);
    await sleep(3000);
    const [c1c, b1c, g3b] = await Promise.all([C.crew(), B.crew(), B.mine('g3')]);
    check(c1c.hitsSent === c0.hitsSent && b1c.hitsGot === b0.hitsGot && hp(g3b) === hp(g3), `${who}: C (not on the crew) shoots and blasts a van: nothing happens to it`, `C sent ${c1c.hitsSent - c0.hitsSent} claims; B heard ${b1c.hitsGot - b0.hitsGot}; van 3 health on B ${hp(g3)} then ${hp(g3b)}`);
    // A's rounds on van 1.
    const a0 = await A.crew();
    for (let k = 0; k < 6; k++) { await shootHeld(A, g1.x, g1.z, 25); await sleep(450); }
    const v1 = await wait(async () => { const v = await B.mine('g1'); return v && (v.wreck || hp(v) < 20) ? v : null; }, 20000) ?? await B.mine('g1');
    const [a1c, b1h] = await Promise.all([A.crew(), B.crew()]);
    check(!!v1 && (v1.wreck || hp(v1) < 20) && b1h.hitsDone > b1c.hitsDone, `${who}: A's rounds (Fight.hitCar, 6 x 25) are claimed and B's browser takes them off van 1: it is burning`,
      `A sent ${a1c.hitsSent - a0.hitsSent} claim(s) (${a1c.hitBytes - a0.hitBytes} bytes, ${(a1c.hitDamageSent - a0.hitDamageSent).toFixed(0)} health); B applied ${b1h.hitsDone - b1c.hitsDone}, refused ${b1h.hitsRefused - b1c.hitsRefused} (${b1h.lastHitRefusal || 'none'}), ${(b1h.hitDamageDone - b1c.hitDamageDone).toFixed(0)} health; van 1 on B: health ${hp(v1)}, wreck ${v1 && v1.wreck}`);
    // A rocket of A's going off beside van 2.
    await A.go(g2.x + 16, g2.z);
    await sleep(1000);
    await boom(A, g2.x + 1.2, g2.z);
    const v2 = await wait(async () => { const v = await B.mine('g2'); return v && (v.wreck || hp(v) < 20) ? v : null; }, 15000) ?? await B.mine('g2');
    check(!!v2 && (v2.wreck || hp(v2) < 20), `${who}: A's blast beside van 2 hurts it on B's screen (B lets a crew member's blast reach its held cars)`, `van 2 on B: health ${hp(v2)}, wreck ${v2 && v2.wreck}`);
    // Out of reach: A 400 m off.
    await A.go(g3.x + 400, g3.z);
    await sleep(2500);
    const b2 = await B.crew();
    await shootHeld(A, g3.x, g3.z, 20);
    await wait(async () => (await B.crew()).hitsGot > b2.hitsGot, 8000);
    const b3 = await B.crew(), g3c = await B.mine('g3');
    check(b3.hitsRefused > b2.hitsRefused && /out of reach/.test(b3.lastHitRefusal) && hp(g3c) === hp(g3), `${who}: a claim from 400 m off is refused`, `B heard ${b3.hitsGot - b2.hitsGot}, refused ${b3.hitsRefused - b2.hitsRefused} ("${b3.lastHitRefusal}"); van 3 health ${hp(g3c)}`);
    // A rams van 3 in a car of its own.
    const s3 = Math.sin(g3.h), c3 = Math.cos(g3.h);
    await A.go(g3.x - s3 * 12, g3.z - c3 * 12, g3.h);
    await ownCar(A, 'pickup');
    const b4 = await B.crew();
    let rams = 0;
    for (let k = 0; k < 6 && rams < 3; k++) {
      await A.page.evaluate(([x, z, h]) => {
        const g = window.__game.game, v = g.player.vehicle;
        v.x = x - Math.sin(h) * 9; v.z = z - Math.cos(h) * 9; v.h = h; v.vx = Math.sin(h) * 16; v.vz = Math.cos(h) * 16; v.yawRate = 0; g.vehicles.wake(v);
      }, [g3.x, g3.z, g3.h]);
      await sleep(2500);
      rams = (await B.crew()).ramsDone - b4.ramsDone;
    }
    const b5 = await B.crew(), v3 = await B.mine('g3'), a5 = await A.crew();
    check(rams >= 1 && hp(v3) < hp(g3), `${who}: A drives its own car into van 3: the ram is claimed and counted on B's screen`, `${a5.ramsSent} ram claim(s) sent; B applied ${b5.ramsDone - b4.ramsDone} ram(s), refused ${b5.hitsRefused - b4.hitsRefused} (${b5.lastHitRefusal || 'none'}); van 3 health ${hp(g3)} then ${hp(v3)}`);
    await onFoot(A);
    // Finish van 3 with rounds (where it is now: the ram shoved it on B's screen); all three go up and the step passes on B.
    const g3n = await B.mine('g3');
    await A.go(g3n.x + 14, g3n.z);
    await sleep(2500);
    const shots3 = [];
    for (let k = 0; k < 6; k++) { shots3.push(await shootHeld(A, g3n.x, g3n.z, 25)); await sleep(450); }
    console.log(`      van 3 after the ram on B ${JSON.stringify(g3n)}; A's rounds at it: ${JSON.stringify(shots3)}`);
    const done = await wait(async () => { const x = await B.todo(); return x.want && x.want.t !== 'destroy' ? x : null; }, 150000, 1000);
    const end = await Promise.all(['g1', 'g2', 'g3'].map((k) => B.mine(k)));
    const ab = await shownHeld(A, g1.x, g1.z);
    check(!!done && !done.failed, `${who}: all three go up on B's screen and the destroy step passes, judged by B's browser (B never fired)`, `B now wants ${done ? done.want.t : 'still destroy'}; vans on B: ${JSON.stringify(end.map((v) => v && { h: hp(v), wreck: v.wreck }))}; van 1 on A: ${JSON.stringify(ab)}`);
    const bb = await B.crew(), ab2 = await A.crew();
    console.log(`      bytes: A's Hit claims ${ab2.hitsSent} frames, ${ab2.hitBytes} bytes (9 a frame); B applied ${bb.hitsDone}, refused ${bb.hitsRefused}`);
    if (SHOTS) {
      await A.go(g1.x + 12, g1.z - 10);
      await A.page.evaluate(([x, z]) => window.__game.view(x + 12, 7, z - 16, x, 0.8, z + 20), [g1.x, g1.z]);
      await sleep(5000);
      await A.shot('shots/net/story-a.png');
      await A.page.evaluate(() => window.__game.view());
      check(true, 'picture: shots/net/story-a.png (the helper A\'s screen at the cannery: the vans its claims burnt out on B\'s screen)');
    }
    await B.page.evaluate(() => window.__game.game.todo.missions.abandon());
    await wait(async () => (await A.crew()).boss === 0, 15000);
    for (const t of [A, B, C]) await calm(t);
  }

  // ── 2. Tail: judged on the nearest crew member ──
  if (part('tail')) {
    const who = 'B starts "Birdwatching" with A near';
    const at = { x: -24, z: 330 };
    for (const t of [A, B, C]) await onFoot(t);
    await B.go(at.x, at.z); await A.go(at.x + 6, at.z); await C.go(at.x + 200, at.z);
    for (const t of [A, B, C]) await calm(t);
    await sleep(3000);
    await startM(B, 'm05', 4);
    await wait(async () => (await A.crew()).boss === bn.id, 15000);
    let s = await read(B);
    // The goto (anything with wheels, stopped): A's car does it.
    await ownCar(A);
    await put(A, s.want.at, 6);
    s = await wait(async () => { const x = await read(B); return x.want && x.want.t === 'tail' ? x : null; }, 40000) ?? await B.todo();
    await onFoot(A);
    check(s.want && s.want.t === 'tail', `${who}: the tail begins`, `B wants ${s.want ? s.want.t : 'nothing'}`);
    // B 200 m off; A follows at about 40 m, put there every half second.
    const sedan0 = await B.mine('gull');
    await B.go(sedan0.x + 200, sedan0.z + 40);
    let worst = 0, last = null, aD = [];
    for (let k = 0; k < 24; k++) {
      const v = await B.mine('gull');
      if (!v) break;
      await A.go(v.x + 30, v.z + 26);
      await sleep(500);
      last = await runner(B);
      worst = Math.max(worst, last.farT);
      const bme = await me(B);
      aD.push(Math.round(Math.hypot(bme.x - v.x, bme.z - v.z)));
    }
    check(!!last && last.cur === 'm05' && !last.failed && last.t === 'tail' && worst < 0.5 && last.label === 250,
      `${who}: B ${aD[aD.length - 1]} m off, A about 40 m behind the sedan: the distance that counts is A's ("Following at"), nothing is being lost`,
      `B's runner: ${JSON.stringify(last)}; most "losing them" time seen ${worst.toFixed(2)} s; B's distance to the sedan ${aD.slice(-3).join(', ')} m`);
    // Both far: Losing them counts up.
    await A.go(sedan0.x + 260, sedan0.z + 80);
    const lost = await wait(async () => { const r = await runner(B); return r.farT > 0.3 || r.failed ? r : null; }, 30000) ?? await runner(B);
    check(lost.farT > 0.3 || !!lost.failed, `${who}: with A far off too, "Losing them" counts (judged on the nearest, now 200 m+)`, JSON.stringify(lost));
    await B.page.evaluate(() => window.__game.game.todo.missions.abandon());
    await wait(async () => (await A.crew()).boss === 0, 15000);
  }

  // ── 3. Jobs shown to the others ──
  if (part('jobs')) {
    const who = 'C runs jobs';
    const at = { x: 30, z: 300 };
    for (const t of [A, B, C]) await onFoot(t);
    await C.go(at.x, at.z); await A.go(at.x + 30, at.z); await B.go(at.x - 30, at.z);
    for (const t of [A, B, C]) await calm(t);
    await sleep(2500);
    const w0 = { C: wire(C, '3.11'), Cb: wire(C, '3.11', 'bytes') };
    // Taxi.
    await ownCar(C, 'taxi');
    const started = await C.page.evaluate(() => window.__game.game.todo.jobs.startJob('taxi'));
    const fare = await C.page.evaluate(() => { const j = window.__game.game.todo.jobs, r = j.rider; return r ? { x: +r.x.toFixed(2), z: +r.z.toFixed(2), top: r.look.top, skin: r.look.skin, hair: r.look.hair, dest: j.dest } : null; });
    const [aj, bj] = await Promise.all([
      wait(async () => { const j = await jobsOf(A); const t = j.theirs.find((x) => x.id === cn.id); return t && t.rider ? t : null; }, 10000),
      wait(async () => { const j = await jobsOf(B); const t = j.theirs.find((x) => x.id === cn.id); return t && t.rider ? t : null; }, 10000),
    ]);
    const same = (t) => !!t && !!fare && Math.hypot(t.rider.x - fare.x, t.rider.z - fare.z) < 0.3 && t.rider.top === fare.top && t.rider.skin === fare.skin && t.rider.hair === fare.hair;
    check(started && same(aj) && same(bj), `${who}: a taxi shift: A and B are shown the fare waiting at the kerb, where C has them, the same person`, `C: ${JSON.stringify(fare)}; A: ${JSON.stringify(aj)}; B: ${JSON.stringify(bj)}`);
    await put(C, fare.dest, 5);
    const aboard = await wait(async () => { const r = await remoteOf(A, cn.id); const j = await jobsOf(A); const t = j.theirs.find((x) => x.id === cn.id); return r && r.job === 'fare aboard' && t && !t.rider ? { r, t } : null; }, 20000);
    const cview = await C.page.evaluate(() => window.__game.game.todo.jobs.view().aboard);
    check(!!aboard && cview, `${who}: C stops beside them: the fare is aboard on C's screen; on A's the person at the kerb is gone and C's tag says "fare aboard"`, aboard ? JSON.stringify(aboard) : `C aboard ${cview}; A sees ${JSON.stringify(await remoteOf(A, cn.id))}`);
    await C.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    const off = await wait(async () => { const r = await remoteOf(A, cn.id); const j = await jobsOf(A); return r && r.job === '' && !j.theirs.some((x) => x.id === cn.id) ? r : null; }, 10000);
    check(!!off, `${who}: the shift ends: A is told, the tag is plain again`, JSON.stringify(await remoteOf(A, cn.id)));
    // Courier.
    await onFoot(C);
    await ownCar(C, 'van');
    await C.page.evaluate(() => window.__game.game.todo.jobs.startJob('courier'));
    const drops = await C.page.evaluate(() => window.__game.game.todo.jobs.drops.slice());
    const t1 = await wait(async () => { const r = await remoteOf(B, cn.id); return r && /^\d+ of \d+ parcels?$/.test(r.job) ? r : null; }, 10000);
    await put(C, drops[0], 5);
    const t2 = await wait(async () => { const r = await remoteOf(B, cn.id); return r && r.job === `${drops.length - 1} of ${drops.length} parcels` ? r : null; }, 20000);
    check(!!t1 && t1.job === `${drops.length} of ${drops.length} parcels` && !!t2, `${who}: a courier run: B sees C's parcels on C's tag, and one fewer when C stops at a drop`, `${JSON.stringify(t1)} then ${JSON.stringify(t2 ?? await remoteOf(B, cn.id))}`);
    await C.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    await wait(async () => (await remoteOf(B, cn.id))?.job === '', 10000);
    // Tow.
    await onFoot(C);
    await ownCar(C, 'tow');
    const towOk = await C.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    let tw = await towed(C);
    await sleep(2500);
    const seen0 = tw ? await shownHeld(A, tw.x, tw.z) : null;
    check(towOk && !!tw && !!seen0 && seen0.d < 1.5, `${who}: a tow: the car to be towed is shown on A where C has it`, `C's: ${JSON.stringify(tw)}; on A: ${JSON.stringify(seen0)}`);
    await put(C, { x: tw.x + Math.sin(tw.h) * 9, z: tw.z + Math.cos(tw.h) * 9 }, 2);
    await wait(async () => (await towed(C))?.hooked, 15000);
    await A.go(tw.x + 20, tw.z + 20); await B.go(tw.x - 20, tw.z + 20);
    const hooked = await wait(async () => { const j = await jobsOf(A); const r = await remoteOf(A, cn.id); return j.hookedShown >= 1 && r && r.job === 'towing' ? j : null; }, 15000);
    check(!!hooked && (await towed(C))?.hooked, `${who}: hooked: A puts the car behind C's truck (the Job frame says so) and C's tag says "towing"`, JSON.stringify(hooked ?? await jobsOf(A)));
    // Drive with it on the hook, the cheap way and the old way, 6 s each: what the towed car costs C to show.
    const drive = async (cheap) => {
      await C.page.evaluate((cheap) => { window.__game.game.net.jobs.cheapTow = cheap; }, cheap);
      const h0 = await C.page.evaluate(() => ({ ...window.__game.game.net.held.stats }));
      const j0 = (await jobsOf(C)).bytesSent;
      await C.page.keyboard.down('KeyW'); await sleep(6000); await C.page.keyboard.up('KeyW');
      const h1 = await C.page.evaluate(() => ({ ...window.__game.game.net.held.stats }));
      const j1 = (await jobsOf(C)).bytesSent;
      return { frames: h1.sent - h0.sent, bytes: h1.bytesSent - h0.bytesSent, job: j1 - j0 };
    };
    const cheap = await drive(true);
    await sleep(1500);
    tw = await towed(C);
    const onA = tw ? await shownHeld(A, tw.x, tw.z) : null;
    const old = await drive(false);
    await C.page.evaluate(() => { window.__game.game.net.jobs.cheapTow = true; });
    const ct = await C.car();
    check(cheap.bytes < old.bytes && !!onA && onA.d < 4, `${who}: on the hook, the towed car's moves are not sent: Held bytes in 6 s of driving ${cheap.bytes} (the old way: ${old.bytes}); A still draws it behind C's truck`,
      `cheap ${JSON.stringify(cheap)}; old ${JSON.stringify(old)}; C's truck ${JSON.stringify(ct)}; the towed car on C ${JSON.stringify(tw)}, on A ${JSON.stringify(onA)}`);
    console.log(`      bytes: towing, 6 s of driving: Held ${cheap.frames} frames ${cheap.bytes} bytes now, ${old.frames} frames ${old.bytes} bytes the old way; Job frames over all three jobs on C: ${wire(C, '3.11') - w0.C} frames, ${wire(C, '3.11', 'bytes') - w0.Cb} bytes (14 a frame)`);
    await C.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    await onFoot(C);
  }

  // ── 4. Pause in town ──
  if (part('pause')) {
    const who = 'B pauses at the wheel';
    const at = { x: 40, z: 250 };
    for (const t of [A, B, C]) await onFoot(t);
    await B.go(at.x, at.z); await A.go(at.x + 16, at.z); await C.go(at.x - 60, at.z);
    for (const t of [A, B, C]) await calm(t);
    await ownCar(B, 'sedan');
    await sleep(6000);
    // The guard: wanted at two pips, then just hurt.
    await B.page.evaluate(() => { window.__game.game.player.heat = 2; });
    await B.page.evaluate(() => window.__game.game.setPaused(true));
    const g1 = await me(B), why1 = (await B.net()).pause.refused;
    await calm(B);
    await B.page.evaluate(() => window.__game.game.player.hurt(2, null));
    await B.page.evaluate(() => window.__game.game.setPaused(true));
    const g2 = await me(B), why2 = (await B.net()).pause.refused;
    check(g1.state === 'play' && /Harbor Patrol/.test(why1) && g2.state === 'play' && /fight/.test(why2), `${who}: refused while wanted at two pips, and just after being hurt`, `${g1.state}: "${why1}"; ${g2.state}: "${why2}"`);
    const free = await wait(async () => (await B.net()).pause.why === null, 120000, 1000);
    await B.page.evaluate(() => window.__game.game.setPaused(true));
    const b0 = await me(B);
    const mark = await wait(async () => { const r = await remoteOf(A, bn.id); return r && r.paused ? r : null; }, 10000);
    check(!!free && b0.state === 'paused' && !!mark, `${who}: a few seconds later it is allowed: A sees PAUSED on B's tag`, `B ${b0.state}; A's view of B ${JSON.stringify(mark ?? await remoteOf(A, bn.id))}`);
    // A's rounds at B's car, a blast beside it, and A's car into it.
    const f0 = await A.page.evaluate(() => ({ ...window.__game.game.net.fight.stats }));
    const shot = await A.page.evaluate((id) => { const n = window.__game.game.net, r = n.remotes.get(id); return r && r.vehicle ? n.fight.hitCar(r.vehicle, 30) : null; }, bn.id);
    await boom(A, b0.car.x + 1.5, b0.car.z);
    await ownCar(A, 'pickup');
    await A.page.evaluate(([x, z]) => {
      const g = window.__game.game, v = g.player.vehicle, h = Math.atan2(x - v.x, z - v.z);
      v.h = h; v.x = x - Math.sin(h) * 9; v.z = z - Math.cos(h) * 9; v.vx = Math.sin(h) * 14; v.vz = Math.cos(h) * 14; g.vehicles.wake(v);
    }, [b0.car.x, b0.car.z]);
    await sleep(4000);
    const b1 = await me(B), f1 = await A.page.evaluate(() => ({ ...window.__game.game.net.fight.stats })), bf = await B.page.evaluate(() => ({ ...window.__game.game.net.fight.stats }));
    check(shot === true && b1.health === b0.health && b1.car.health === b0.car.health && Math.hypot(b1.car.x - b0.car.x, b1.car.z - b0.car.z) < 0.05,
      `${who}: A's rounds, a blast beside the car and A's car driven into it do nothing to B or B's car; it stands where it stood`,
      `A spared ${f1.pausedSpared - f0.pausedSpared} round(s) (claims sent ${f1.claimsSent - f0.claimsSent}); B heard ${bf.blastsGot} blast(s), ${bf.pausedBlasts} while paused; B health ${b0.health} then ${b1.health}, car ${JSON.stringify(b0.car)} then ${JSON.stringify(b1.car)}`);
    if (SHOTS) {
      await onFoot(A);
      await A.go(b0.car.x + 9, b0.car.z + 4);
      await A.page.evaluate(([x, z]) => window.__game.view(x + 7, 3.5, z + 6, x, 1.4, z), [b0.car.x, b0.car.z]);
      await sleep(5000);
      await A.shot('shots/net/story-b.png');
      await A.page.evaluate(() => window.__game.view());
      check(true, 'picture: shots/net/story-b.png (A\'s screen: B paused at the wheel, PAUSED on the tag)');
    }
    // Resume: fair game at once.
    await B.page.evaluate(() => window.__game.game.setPaused(false));
    const back = await wait(async () => { const r = await remoteOf(A, bn.id); return r && !r.paused ? r : null; }, 10000);
    const b2 = await me(B);
    await boom(A, b2.car.x + 1.5, b2.car.z);
    const hurt = await wait(async () => { const x = await me(B); return x.car && x.car.health < b2.car.health ? x : null; }, 10000);
    check(!!back && !!hurt, `${who}: B resumes: the tag is plain again and the next blast hurts B's car at once`, `A's view ${JSON.stringify(back)}; B's car ${b2.car.health} then ${hurt ? hurt.car.health : '(unchanged)'}`);
    for (const t of [A, B]) await onFoot(t);
  }

  // ── 5. The town's bridge: kerbs, barriers, wording, whose points ──
  if (part('town')) {
    const who = 'the town';
    const imp = (t, f) => t.page.evaluate(f);
    await B.page.evaluate(() => window.__game.game.setPaused(false));
    // A, the host, opens stage 2 on its own: the town takes it (the furthest).
    await imp(A, async () => { const { progress } = await import('/src/world/progress.ts'); progress.setStage(2); });
    const bt = await wait(async () => { const x = (await B.net()).town; return x.shown && x.shown[1] === 2 ? x : null; }, 20000);
    const ct = (await C.net()).town, at0 = (await A.net()).town;
    check(!!bt && bt.own[1] === 0 && ct.shown[1] === 2, `${who}: A opens stage 2 on its own: B and C show the town's (stage 2) and keep their own (stage 0) apart`, `B ${JSON.stringify(bt && { shown: bt.shown, own: bt.own })}; C shown ${JSON.stringify(ct.shown)}; A ${JSON.stringify({ shown: at0.shown, own: at0.own, bridge: at0.bridge })}`);
    check(new RegExp(`^${an.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s points finished`).test(bt ? bt.lastFinish : '') && /^Your points finished/.test(at0.lastFinish), `${who}: B is told whose points finished it (A's name), A that they were its own`, `B: "${bt ? bt.lastFinish : ''}"; A: "${at0.lastFinish}"; A is ${an.name}`);
    // Barriers and kerb cars on B's screen, and A's, at the same spot in the square (stage 2).
    for (const t of [A, B]) await t.go(30, -1440);
    const works = (t) => t.page.evaluate(() => window.__game.game.systems.find((s) => s && s.constructor && s.constructor.name === 'ProgressWorks').info());
    // (Eight a look, a look every 0.35 s of game time: a slow page, the host most of all, takes a while to park them all.)
    let wa = null, wb = null;
    for (let k = 0, prev = ''; k < 40; k++) {
      await sleep(3000);
      [wa, wb] = await Promise.all([works(A), works(B)]);
      const now = `${wa.kerbs.length}/${wb.kerbs.length}`;
      if (k >= 3 && now === prev) break;
      prev = now;
    }
    const key = (k) => `${k.x},${k.z}`;
    const kb = new Set(wb.kerbs.map(key)), ka = new Set(wa.kerbs.map(key));
    const both = [...kb].filter((k) => ka.has(k)).length;
    check(wb.barriers.length > 0 && wb.barriers.every((s) => s > 2) && wb.kerbs.length > 0 && wb.kerbs.every((k) => !k.closed && k.stage <= 2) && wb.kerbs.some((k) => k.stage === 2),
      `${who}: B (own stage 0) sees the town's barriers (only across streets of stage 3 and 4) and parks kerb cars on the town's stage 2 streets`,
      `barriers by stage ${JSON.stringify(wb.barriers)}; ${wb.kerbs.length} kerb cars, stages ${JSON.stringify(wb.kerbs.map((k) => k.stage))}`);
    // (A place is skipped while some other car stands on it, which can differ between two screens for a moment.)
    check(kb.size > 0 && both >= 0.85 * Math.max(ka.size, kb.size), `${who}: A and B, at the same spot, park the same kerb cars (85% or more of them at the same places)`, `A ${ka.size}, B ${kb.size}, at the same places ${both}`);
    // Wording: the menu's progress page and the fund box.
    const html = await B.page.evaluate(() => window.__game.game.todo.menu.progressHtml());
    await B.go(-16.5 + 1.2, -1066);
    await sleep(2500);
    const prompt = await B.page.evaluate(() => window.__game.game.hud.promptText);
    check(/the town's/.test(html) && /Your own/.test(html) && /^\[G\] Pay into the town's fund: .* Yours: 0 of 8 spans/.test(prompt ?? ''), `${who}: the menu and the fund box say "the town's", and show B's own apart`,
      `menu: ${(html.match(/Section A[^<]*/) ?? [''])[0]} / ${(html.match(/Your own<\/span><span>[^<]*/) ?? ['no own row'])[0]}; box: "${prompt}"`);
    // B's points finish stage 3: C is told it was B's.
    const cost = await B.page.evaluate(async () => { const m = await import('/src/world/progress.ts'); const g = m.progress.goal(); return g ? Math.ceil(g.cost - g.have) + 1 : 0; });
    await B.page.evaluate(async (n) => { const { progress } = await import('/src/world/progress.ts'); progress.add(n); }, cost);
    const cf = await wait(async () => { const x = (await C.net()).town; return x.shown[1] === 3 ? x : null; }, 20000);
    // (The fact goes to B and C at once; B's page may take a moment longer to read it.)
    const bf = await wait(async () => { const x = (await B.net()).town; return x.finishes >= 2 ? x : null; }, 10000) ?? (await B.net()).town;
    check(!!cf && new RegExp(`^${bn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s points finished`).test(cf.lastFinish) && /^Your points finished/.test(bf.lastFinish),
      `${who}: B's points (${cost}) finish stage 3: C is told it was B's, B that it was its own`, `C: "${cf ? cf.lastFinish : '(not yet)'}", shown ${JSON.stringify(cf ? cf.shown : null)}; B: "${bf.lastFinish}"; B is ${bn.name}`);
  }

  {
    const errs = [...A.errors, ...B.errors, ...C.errors].filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on A, B or C', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
