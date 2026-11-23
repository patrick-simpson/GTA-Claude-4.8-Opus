// Multiplayer stage 4, step 3, second piece: more of missions done together. Headless browsers against LOCAL services.
//
//   node tools/net/crew2.mjs
//
// Started and stopped as tools/net/crew.mjs is (the same ports: never run two of these tests at once). Three players
// in town on main, A the host (pinned: B and C say they cannot host), B and C its guests.
//  1. "Birdwatching" (m05: a man to meet and a car to follow), started by C with A and B both near: TWO helpers.
//     Both are drafted; both are shown Kittiwake (the mission's person, the same look) and the black sedan; B's own
//     action counts (B, in a car of its own, is PUT stopped at the goto: the step passes on C's screen with C nowhere
//     near); Kittiwake leaves both screens when the script lets him go; the sedan is marked as the target on both;
//     C sets the mission aside: both are told and let go, and nothing of it is left on their screens.
//  2. "Double-Entry" (m03), started by A with B and C near. C gets into the van and LEAVES TOWN at the wheel (its page
//     closes): the van stands again in A's browser where C had it, the script says get back in; B gets in, is put at
//     Gus's: passed, A and B paid.
//  3. A new C joins. B starts m03 with C near; C gets in the van; B LEAVES TOWN mid mission: C is let go with a word,
//     and keeps the van as an ordinary car of its own, still at the wheel.
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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-crew2-'));
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
    return v && v.spec ? { kind: v.spec.kind, x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h, driver: v.driver, held: !!v.held, wreck: !!v.wreck, listed: g.vehicles.list.includes(v) } : null;
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

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', viaMain);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain);
  await B.pin(true);
  let C = await visitor('C', viaMain);
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const [a, b, c] = await three(A, B, C); return a.traffic.mode === 'host' && b.traffic.mode === 'guest' && c.traffic.mode === 'guest' ? [a, b, c] : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  let [an, bn, cn] = await three(A, B, C);

  // ── 1. Birdwatching: two helpers, a person and a target, a helper's own action, set aside ──
  {
    const who = 'C (a guest) starts "Birdwatching" with A and B near';
    const at = { x: -24, z: 330 };
    await A.go(at.x, at.z); await B.go(at.x + 6, at.z); await C.go(at.x - 6, at.z);
    for (const t of [A, B, C]) await calm(t);
    await sleep(3000);
    const c0 = { A: wire(A, '3.10'), B: wire(B, '3.10'), C: wire(C, '3.10'), Cb: wire(C, '3.10', 'bytes') };
    await startM(C, 'm05', 4);
    const [ac, bc] = await Promise.all([
      wait(async () => { const c = await A.crew(); return c.boss === cn.id ? c : null; }, 15000).then((x) => x ?? A.crew()),
      wait(async () => { const c = await B.crew(); return c.boss === cn.id ? c : null; }, 15000).then((x) => x ?? B.crew()),
    ]);
    const cc = await C.crew();
    check(cc.team.length === 2 && cc.team.includes(an.id) && cc.team.includes(bn.id) && ac.boss === cn.id && bc.boss === cn.id,
      `${who}: two helpers at once: both are on the crew`, `C's crew [${cc.team}] (A ${an.id}, B ${bn.id}); A boss ${ac.boss}, B boss ${bc.boss}`);
    // The dialogue, read on C's screen; then the goto (in anything with wheels, stopped) is the business.
    let s = await read(C);
    const kit = await C.page.evaluate(() => { const e = window.__game.game.todo.missions.ents.get('kit'); return e ? { x: +e.x.toFixed(1), z: +e.z.toFixed(1), top: e.look.top, hair: e.look.hair, skin: e.look.skin } : null; });
    const gull = await C.mine('gull');
    await sleep(3000);
    const [a1, b1] = await Promise.all([A.crew(), B.crew()]);
    const same = (c) => !!kit && c.extras.length === 1 && Math.hypot(c.extras[0].x - kit.x, c.extras[0].z - kit.z) < 0.3 && c.extras[0].top === kit.top && c.extras[0].hair === kit.hair && c.extras[0].skin === kit.skin;
    check(!!kit && same(a1) && same(b1), `${who}: Kittiwake (the mission's person) stands on both helpers' screens, where C has him, in the same look`,
      `C: ${JSON.stringify(kit)}; A: ${JSON.stringify(a1.extras)}; B: ${JSON.stringify(b1.extras)}`);
    const [as, bs] = gull ? await Promise.all([A.seen('sedan', gull.x, gull.z, 4), B.seen('sedan', gull.x, gull.z, 4)]) : [null, null];
    check(!!as && !!bs && as.list.length + as.ghosts.length === 1 && bs.list.length + bs.ghosts.length === 1, `${who}: and the black sedan, on both`, `C: ${JSON.stringify(gull)}; A: ${JSON.stringify(as)}; B: ${JSON.stringify(bs)}`);
    check(s.want && s.want.t === 'goto' && a1.guest && b1.guest && a1.guest.objective === b1.guest.objective && /^Pull up on Calamity Ave/.test(a1.guest.objective ?? ''),
      `${who}: both are shown C's objective`, `C wants ${s.want ? s.want.t : 'nothing'}; A: ${g1(a1)}; B: ${g1(b1)}`);
    // ── B's own action: B, in a car, stopped at the goto. C is on foot, 40 m away. ──
    const goal = s.want.at;
    await ownCar(B);
    const where = await put(B, goal, 6);
    const cpos = await C.page.evaluate(() => { const p = window.__game.game.player; return { x: p.x, z: p.z, car: !!p.vehicle }; });
    s = await wait(async () => { const x = await C.todo(); return x.want && x.want.i > 6 ? x : null; }, 30000) ?? await C.todo();
    check(s.cur === 'm05' && !s.failed && s.want && s.want.i > 6, `${who}: B, at the wheel of its own car, stops at the goto: the step passes on C's screen (C ${Math.round(Math.hypot(cpos.x - goal.x, cpos.z - goal.z))} m away, ${cpos.car ? 'in a car' : 'on foot'})`,
      `B put ${where ? where.far + ' m from the mark' : 'nowhere'}; C now at step ${s.want ? s.want.i + ' (' + s.want.t + ')' : 'none'}`);
    // Kittiwake's line, then he is let go of; the tail begins. (C steps back first: the tail is judged on C alone, and
    // standing on the sedan's bumper would fail it, "MADE".)
    await C.go(-26.6, 372);
    s = await read(C);
    await sleep(3000);
    const [a2, b2] = await Promise.all([A.crew(), B.crew()]);
    check(s.want && s.want.t === 'tail' && a2.extras.length === 0 && b2.extras.length === 0, `${who}: the script lets Kittiwake go: he leaves both helpers' screens`, `C wants ${s.want ? s.want.t : 'nothing'}; A ${JSON.stringify(a2.extras)}; B ${JSON.stringify(b2.extras)}`);
    const a3 = await wait(async () => { const c = await A.crew(); return c.guest && c.guest.targets >= 1 && /^Follow Kittiwake/.test(c.guest.objective ?? '') ? c : null; }, 10000) ?? await A.crew();
    const b3 = await B.crew();
    const tgt = await C.page.evaluate(() => window.__game.game.todo.missions.target);
    const gnow = await C.mine('gull');
    check(!!a3.guest && a3.guest.targets >= 1 && !!b3.guest && b3.guest.targets >= 1 && !!tgt && !!gnow && Math.hypot(tgt.x - gnow.x, tgt.z - gnow.z) < 1,
      `${who}: the sedan to follow is marked as the target on both helpers' screens (C's target is the sedan)`, `A: ${g1(a3)}; B: ${g1(b3)}; C's target ${JSON.stringify(tgt)}, sedan ${JSON.stringify(gnow)}`);
    // ── Set aside ──
    await C.page.evaluate(() => window.__game.game.todo.missions.abandon());
    const [a4, b4] = await Promise.all([
      wait(async () => { const c = await A.crew(); return c.boss === 0 ? c : null; }, 15000).then((x) => x ?? A.crew()),
      wait(async () => { const c = await B.crew(); return c.boss === 0 ? c : null; }, 15000).then((x) => x ?? B.crew()),
    ]);
    await sleep(2500);
    const [at4, bt4] = await Promise.all([A.todo(), B.todo()]);
    const [as4, bs4] = gnow ? await Promise.all([A.seen('sedan', gnow.x, gnow.z, 8), B.seen('sedan', gnow.x, gnow.z, 8)]) : [null, null];
    const aside = `${cn.name} set the job aside. Your time is your own again.`;
    check(a4.lastEnd === 'set aside' && b4.lastEnd === 'set aside' && a4.lastLine === aside && b4.lastLine === aside && at4.busy === null && bt4.busy === null,
      `${who}: C sets it aside: both helpers are told and let go`, `A: ${g1(a4)}, busy ${at4.busy}; B: ${g1(b4)}, busy ${bt4.busy}`);
    check(a4.extras.length === 0 && b4.extras.length === 0 && !!as4 && !!bs4 && as4.ghosts.length + as4.list.filter((v) => v.held || v.shared).length === 0 && bs4.ghosts.length + bs4.list.filter((v) => v.held || v.shared).length === 0,
      `${who}: nothing of it is left on their screens (no person, no sedan)`, `A: ${JSON.stringify(as4)}; B: ${JSON.stringify(bs4)}`);
    console.log(`      bytes: crew frames in this mission: C ${wire(C, '3.10') - c0.C} frames ${wire(C, '3.10', 'bytes') - c0.Cb} bytes; A ${wire(A, '3.10') - c0.A}; B ${wire(B, '3.10') - c0.B}; C's stats ${JSON.stringify(await C.crew().then((c) => ({ shows: c.shows, showBytes: c.showBytes, things: c.things, thingBytes: c.thingBytes, teams: c.teams })))}`);
    await onFoot(B);
  }

  // ── 2. Double-Entry with two helpers; one leaves town at the wheel ──
  {
    const who = 'A (the host) starts "Double-Entry" with B and C near';
    const spot = { x: 313.5, z: 262 };
    const kerb = await A.page.evaluate(([x, z]) => { const n = window.__game.game.plan.nearestNode(x, z); return n.x + n.hx + 2.2; }, [spot.x, spot.z]);
    for (const t of [A, B, C]) await onFoot(t);
    await A.go(kerb, spot.z - 3); await B.go(kerb, spot.z - 10); await C.go(kerb, spot.z - 16);
    for (const t of [A, B, C]) await calm(t);
    await sleep(3000);
    const [a0, b0] = await Promise.all([A.todo(), B.todo()]);
    await startM(A, 'm03', 2);
    await wait(async () => { const [b, c] = await Promise.all([B.crew(), C.crew()]); return b.boss === an.id && c.boss === an.id; }, 15000);
    let s = await read(A);
    const van = await A.mine('van');
    await sleep(2500);
    const ok = !!van && await getIn(C, van, 'van');
    await sleep(3000);
    s = await read(A);
    const ccar = await C.car(), ac = await A.crew();
    check(ok && !!ccar && ccar.lent && ac.lentOut.includes(cn.id) && ac.team.length === 2 && s.want && s.want.t === 'deliver', `${who}: C (one of two helpers) gets into the van`, `C in ${ccar ? ccar.kind : 'nothing'}; A lent to [${ac.lentOut}], crew [${ac.team}]; A wants ${s.want ? s.want.t : 'nothing'}`);
    // Drive it a little way (put), then C's page closes with C at the wheel.
    const moved = await put(C, { x: kerb, z: spot.z + 25 }, 6);
    await sleep(3000);
    const before = await A.mine('van');
    const cerrs = C.errors.filter((e) => !NOISE.test(e));
    await C.close().catch(() => {});
    open.splice(open.indexOf(C), 1);
    const back = await wait(async () => { const [v, c] = await Promise.all([A.mine('van'), A.crew()]); return v && v.listed && c.lentOut.length === 0 && !c.team.includes(cn.id) ? { v, c } : null; }, 30000);
    await sleep(2000);
    s = await read(A);
    const av = await A.mine('van');
    check(!!back && !!av && av.listed && av.held && !!before && Math.hypot(av.x - before.x, av.z - before.z) < 4 && s.want && s.want.t === 'deliver',
      `${who}: C leaves town at the wheel: the van stands again in A's browser where C had it, held, and the job goes on`,
      `put ${moved ? moved.far : '?'} m; van on A before ${JSON.stringify(before)}, after ${JSON.stringify(av)}; A's crew [${back ? back.c.team : '?'}]; A wants ${s.want ? s.want.t : 'nothing'}`);
    const bc = await wait(async () => { const c = await B.crew(); return c.guest && /^Get back in the /.test(c.guest.objective ?? '') ? c : null; }, 10000) ?? await B.crew();
    const bs = av ? await B.seen('van', av.x, av.z, 6) : null;
    check(!!bc.guest && /^Get back in the /.test(bc.guest.objective ?? '') && !!bs && bs.list.length === 1 && bs.list[0].shared, `${who}: B, the other helper, is told to get back in, and sees the van with its door`, `B: ${g1(bc)}; ${JSON.stringify(bs)}`);
    const ok2 = !!av && await getIn(B, av, 'van');
    await sleep(3000);
    s = await read(A);
    const gus = s.want && s.want.at ? s.want.at : { x: 35.5, z: 295.7 };
    const where = await put(B, gus);
    s = await wait(async () => { const x = await read(A); return !x.cur ? x : null; }, 40000, 500) ?? await A.todo();
    await wait(async () => (await B.crew()).boss === 0, 15000);
    await sleep(2000);
    const [a1, b1, bc1] = await Promise.all([A.todo(), B.todo(), B.crew()]);
    check(ok2 && !a1.cur && a1.filed.includes('m03') && a1.money === a0.money + 250 && b1.money === b0.money + 250 && bc1.lastEnd === 'passed' && b1.filed.includes('m03'),
      `${who}: B takes the van to Gus (put ${where ? where.far : '?'} m off): passed; A and B each paid 250`, `A cash ${a0.money} to ${a1.money}; B cash ${b0.money} to ${b1.money}, ${bc1.lastEnd}, filed ${b1.filed.join(' ')}`);
    check(cerrs.length === 0, `${who}: no errors on C before it left`, cerrs.slice(0, 2).join(' | ').slice(0, 300) || 'none');
    await onFoot(B);
  }

  // ── 3. A new C; the starter (B) leaves town mid mission ──
  {
    C = await visitor('C', viaMain);
    await C.pin(true);
    n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
    cn = await C.net(); bn = await B.net(); an = await A.net();
    check(!!n && an.traffic.mode === 'host', 'a new C is in town; A is still the host', `${n ? n.count : '?'} in town; A ${an.traffic.mode}`);
    const who = 'B (a guest) starts "Double-Entry" with the new C near';
    const spot = { x: 313.5, z: 262 };
    const kerb = await B.page.evaluate(([x, z]) => { const n = window.__game.game.plan.nearestNode(x, z); return n.x + n.hx + 2.2; }, [spot.x, spot.z]);
    await A.go(kerb, spot.z - 80);
    await B.go(kerb, spot.z - 3); await C.go(kerb, spot.z - 12);
    for (const t of [A, B, C]) await calm(t);
    await sleep(4000);
    {
      const bnet = await B.net(), bcr = await B.crew();
      const me = await B.page.evaluate(() => { const p = window.__game.game.player; return { x: p.x, z: p.z }; });
      console.log(`      before B starts: B's view of the others ${JSON.stringify(bnet.remotes.map((r) => ({ id: r.id, seen: r.seen, d: Math.round(Math.hypot(r.x - me.x, r.z - me.z)) })))}; B's crew: boss ${bcr.boss}, others ${JSON.stringify(bcr.others)}`);
    }
    await startM(B, 'm03', 2);
    const drafted = await wait(async () => (await C.crew()).boss === bn.id, 15000);
    {
      const [bc0, cc0] = await Promise.all([B.crew(), C.crew()]);
      check(!!drafted, `${who}: C is on B's crew`, `B's crew [${bc0.team}] (C is ${cn.id}); C: boss ${cc0.boss}, last "${cc0.lastLine}"; B ${JSON.stringify(await B.todo().then((t) => ({ cur: t.cur, busy: t.busy })))}`);
    }
    await read(B);
    const van = await B.mine('van');
    await sleep(2500);
    const ok = !!van && await getIn(C, van, 'van');
    await sleep(3000);
    let ccar = await C.car();
    check(ok && !!ccar && ccar.lent, `${who}: C gets into the van`, ccar ? JSON.stringify(ccar) : 'on foot');
    const berrs = B.errors.filter((e) => !NOISE.test(e));
    await B.close().catch(() => {});
    open.splice(open.indexOf(B), 1);
    const cc = await wait(async () => { const c = await C.crew(); return c.boss === 0 ? c : null; }, 30000) ?? await C.crew();
    await sleep(3000);
    ccar = await C.car();
    const ct = await C.todo();
    check(cc.boss === 0 && !cc.guest && ct.busy === null && /has left town/.test(cc.lastLine), `${who}: B leaves town mid mission: C is let go, with a word`, `C: boss ${cc.boss}, busy ${ct.busy}, "${cc.lastLine}"`);
    check(!!ccar && ccar.kind === 'van' && !ccar.lent && !ccar.held && cc.borrowed === 0, `${who}: C keeps the van it was driving, as an ordinary car of its own, still at the wheel`, ccar ? JSON.stringify(ccar) : 'on foot');
    check(berrs.length === 0, `${who}: no errors on B before it left`, berrs.slice(0, 2).join(' | ').slice(0, 300) || 'none');
    await onFoot(C);
    await sleep(3000);
    const cs = ccar ? await A.seen('van', ccar.x, ccar.z, 12) : null;
    console.log(`      A's view of that van afterwards: ${JSON.stringify(cs)}`);
  }

  {
    const errs = [...A.errors, ...C.errors].filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on A or the new C', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
