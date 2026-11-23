// Multiplayer stage 4, step 3: missions done together. Headless browsers against LOCAL services.
//
//   node tools/net/crew.mjs              every check, and two pictures into shots/net/
//   node tools/net/crew.mjs --noshots
//
// It starts everything itself and stops it again, as tools/net/mission.mjs does (the Node home on 8871 is "main",
// found through a lookup stand-in on 8872; a second copy on 8873 is the address the game is given). Never run two of
// these tests at once.
//
// Three players in town on main: A the host, B and C its guests (WHO IS HOST is pinned as in mission.mjs: B and C say
// they cannot host, as a hidden tab does). Two rounds of "Double-Entry" (m03: a white van to bring to Gus):
//  1. B (a guest) starts it with A 10 m away and C 60 m away. A is drafted, C is not. A is shown the objective and
//     the markers; A gets into the van and is shown the countdown; the clock runs out (the test runs it out): A sees
//     the failure and is let go; B tries again: A, still near, is drafted again, the van A was in is taken away; A gets
//     into the new van and the test PUTS it at Gus's (nobody drives across town at these speeds); the mission passes
//     on B's screen, judged on the van A is driving; both are paid 250; A's story (which had only m01) has m03 filed,
//     and A's next offers are worked out from that. C is paid nothing.
//  2. The same with A (the host) as the starter and B as the helper, C again 60 m off.
//  Then nothing is sent about crews for 10 s with no mission running, and no errors.
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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-crew-'));
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
const STEP_TEXT_GET = 'Take the white van outside the Dock Seven office on Ironbound Ave.';
const STEP_TEXT_DELIVER = "Bring the van to Gus's Arcade on Strand Blvd before the audit. Do not bend it.";
const g1 = (c) => c.guest ? `${c.guest.who}'s ${c.guest.mission}, objective "${c.guest.objective ?? '(none)'}", timer ${c.guest.timer ?? 'none'} ${c.guest.value}, ${c.guest.marks} marks (${c.guest.blips} blips)` : 'not on a crew';

/** One round: S starts m03, H helps from 10 m, F stands 60 m off. */
async function round(S, H, F, host, opts) {
  const who = `${S.tag} (${S === host ? 'the host' : 'a guest'}) starts "Double-Entry"`;
  const [sn, hn, fn] = await Promise.all([S.net(), H.net(), F.net()]);
  const sid = sn.id, hid = hn.id, fid = fn.id;
  const spot = { x: 313.5, z: 262 };
  const kerb = await S.page.evaluate(([x, z]) => { const n = window.__game.game.plan.nearestNode(x, z); return n.x + n.hx + 2.2; }, [spot.x, spot.z]);
  // Everybody on foot first.
  for (const t of [S, H, F]) if (await t.car()) { await t.key('KeyF'); await sleep(2000); }
  await S.go(kerb, spot.z - 3, 0); await H.go(kerb, spot.z - 13, 0); await F.go(kerb, spot.z - 63, 0);
  for (const t of [S, H, F]) await calm(t);
  // The helper's story has only the first mission: m03 is two ahead of it.
  await H.page.evaluate((only) => { const d = window.__game.game.todo.save.data; if (only) { d.missions.length = 0; d.missions.push('m01'); } }, opts.helperFresh);
  await sleep(3000);
  const s0 = await S.todo(), h0 = await H.todo(), f0 = await F.todo();
  const c0 = { S: wire(S, '3.10'), H: wire(H, '3.10'), F: wire(F, '3.10'), Sb: wire(S, '3.10', 'bytes'), Hb: wire(H, '3.10', 'bytes') };
  const dists = await S.page.evaluate(([a, b]) => { const g = window.__game.game, p = g.player, rs = window.__game.net().remotes; const d = (id) => { const r = rs.find((x) => x.id === id); return r ? Math.round(Math.hypot(r.x - p.x, r.z - p.z)) : -1; }; return [d(a), d(b)]; }, [hid, fid]);

  // ── The mission begins: who is in it ──
  await S.page.evaluate(() => {
    const td = window.__game.game.todo, d = td.save.data.missions;
    for (const id of ['m01', 'm02']) if (!d.includes(id)) d.push(id);
    // (From an earlier round as a helper: not yet done, for this round.)
    for (let i = d.length - 1; i >= 0; i--) if (d[i] === 'm03') d.splice(i, 1);
    td.missions.start(td.missions.missions.find((m) => m.id === 'm03'));
  });
  const hc = await wait(async () => { const c = await H.crew(); return c.boss === sid ? c : null; }, 15000) ?? await H.crew();
  await sleep(2000);
  let [sc, fc] = await Promise.all([S.crew(), F.crew()]);
  let ht = await H.todo();
  const ft = await F.todo();
  check(sc.team.length === 1 && sc.team[0] === hid && hc.boss === sid && !!hc.guest && ht.busy === 'crew:m03',
    `${who}: ${H.tag}, ${dists[0]} m away, is on the crew with no prompt`, `${S.tag}'s crew [${sc.team}] (${H.tag} is ${hid}); ${H.tag}: boss ${hc.boss}, busy ${ht.busy}; ${g1(hc)}`);
  check(fc.boss === 0 && !fc.guest && ft.busy === null && !sc.team.includes(fid), `${who}: ${F.tag}, ${dists[1]} m away, is not`, `${F.tag}: boss ${fc.boss}, busy ${ft.busy}`);
  check(!!hc.guest && hc.guest.line.includes(hc.guest.who) && hc.guest.line.includes('Double-Entry') && hc.guest.who === sn.name,
    `${who}: ${H.tag}'s game says whose job it is and what`, hc.guest ? `"${hc.guest.line}"; ${S.tag}'s name is "${sn.name}"` : 'nothing');

  // ── What the helper is shown ──
  let s = await read(S);
  const van = await S.mine('van');
  await sleep(2500);
  let hcs = await H.crew();
  check(s.want && s.want.t === 'getVehicle' && hcs.guest && hcs.guest.objective === STEP_TEXT_GET && hcs.guest.blips >= 1 && hcs.guest.marks >= 1,
    `${who}: the starter's objective is on ${H.tag}'s screen, with its marker and radar blip`, `${S.tag} wants ${s.want ? s.want.t : 'nothing'}; ${H.tag}: ${g1(hcs)}`);
  if (!van) throw new Error('no mission van');
  let hs = await H.seen('van', van.x, van.z);
  check(hs.list.length === 1 && hs.list[0].shared && hs.ghosts.length === 0, `${who}: ${H.tag} is shown the van as one with a door (it is on the crew)`, `${H.tag}: ${JSON.stringify(hs)}`);
  const fs = await F.seen('van', van.x, van.z);
  check(fs.ghosts.length === 1 && fs.list.length === 0, `${who}: ${F.tag} (not on the crew) is shown it as ${S.tag}'s, with no door`, `${F.tag}: ${JSON.stringify(fs)}`);

  // ── The helper gets in ──
  let ok = await getIn(H, van, 'van');
  await sleep(3000);
  s = await read(S);
  hcs = await H.crew(); sc = await S.crew();
  let hcar = await H.car();
  check(ok && hcar && hcar.lent && sc.lentOut.includes(hid) && s.want && s.want.t === 'deliver',
    `${who}: ${H.tag} gets into the van (lent by ${S.tag}'s browser), and ${S.tag}'s script takes that as the van taken`, `${H.tag} ${hcar ? `in a ${hcar.kind}${hcar.lent ? ', lent' : ''}` : 'on foot'}; ${S.tag} lent to [${sc.lentOut}], wants ${s.want ? s.want.t : 'nothing'}`);
  hcs = await wait(async () => { const c = await H.crew(); return c.guest && c.guest.timer === 'Audit begins in' ? c : null; }, 10000) ?? await H.crew();
  check(hcs.guest && hcs.guest.objective === STEP_TEXT_DELIVER && hcs.guest.timer === 'Audit begins in' && hcs.guest.mode === 1 && hcs.guest.value > 100 && hcs.guest.value <= 170,
    `${who}: ${H.tag} is shown the next objective and the mission's countdown`, g1(hcs));
  {
    // The two screens: the same moment from each side.
    const [ss, hss] = await Promise.all([S.seen('van', van.x, van.z, 20), H.seen('van', van.x, van.z, 20)]);
    const one = ss.ghosts.length + ss.list.length === 1 && hss.list.length === 1 && hss.ghosts.length === 0;
    check(one, `${who}: one van on each screen: ${H.tag}'s own on its screen, drawn as ${H.tag} driving it on ${S.tag}'s`, `${S.tag}: ${JSON.stringify(ss)} | ${H.tag}: ${JSON.stringify(hss)}`);
  }
  if (opts.shots) {
    const at = await H.car();
    const view = [at.x + 10, 6, at.z - 14, at.x, 0.8, at.z];
    for (const t of [S, H]) await t.page.evaluate((x) => window.__game.view(...x), view);
    await sleep(5000);
    await Promise.all([S.shot('shots/net/crew-starter.png'), H.shot('shots/net/crew-helper.png')]);
    for (const t of [S, H]) await t.page.evaluate(() => window.__game.view());
    check(true, 'pictures: shots/net/crew-starter.png (the starter, the helper at the wheel of the van) and crew-helper.png (the helper\'s screen: the objective and the countdown)');
  }

  if (opts.getOut) {
    // ── The helper gets out in the middle of it: the van goes back to the starter's browser ──
    const b0 = wire(H, '3.10', 'bytes'), n0 = wire(H, '3.10');
    await wait(async () => { const v = await H.car(); return !v || Math.abs(v.speed) < 0.15; }, 20000);
    await H.key('KeyF');
    const out = await wait(async () => !(await H.car()), 20000);
    await sleep(4000);
    const [bv, sc2, hc2, st] = await Promise.all([S.mine('van'), S.crew(), H.crew(), S.todo()]);
    const hs3 = bv ? await H.seen('van', bv.x, bv.z, 6) : null;
    check(!!out && !!bv && bv.listed && bv.held && sc2.lentOut.length === 0 && st.want && st.want.t === 'deliver',
      `${who}: ${H.tag} gets out in the middle of it: the van is the script's again in ${S.tag}'s browser, standing where ${H.tag} left it`, `van on ${S.tag}: ${bv ? JSON.stringify(bv) : 'none'}; lent to [${sc2.lentOut}]; ${S.tag} wants ${st.want ? st.want.t : 'nothing'}; ${H.tag} sent ${wire(H, '3.10') - n0} crew frames, ${wire(H, '3.10', 'bytes') - b0} bytes`);
    check(!!hs3 && hs3.list.length === 1 && hs3.list[0].shared && hs3.ghosts.length === 0 && !!hc2.guest && /^Get back in the /.test(hc2.guest.objective ?? ''),
      `${who}: ${H.tag} sees it standing there (with its door) and is told to get back in`, `${H.tag}: ${hs3 ? JSON.stringify(hs3) : 'nothing'}; ${g1(hc2)}`);
    ok = !!bv && await getIn(H, bv, 'van');
    await sleep(3000);
    hcar = await H.car();
    check(ok && !!hcar && hcar.lent, `${who}: and gets back in`, hcar ? JSON.stringify(hcar) : 'on foot');
    s = await read(S);
  }

  if (opts.failFirst) {
    // ── The clock runs out ──
    await S.page.evaluate(() => { window.__game.game.todo.missions.timer = 0.01; });
    s = await wait(async () => { const x = await S.todo(); return x.failed ? x : null; }, 15000) ?? await S.todo();
    const hf = await wait(async () => { const c = await H.crew(); return c.boss === 0 ? c : null; }, 15000) ?? await H.crew();
    ht = await H.todo();
    check(s.failed === 'PAST DUE' && hf.boss === 0 && !hf.guest && hf.lastEnd === 'failed: PAST DUE' && ht.busy === null,
      `${who}: the clock runs out: ${H.tag} sees the failure and is let go`, `${S.tag} failed ${s.failed}; ${H.tag}: ${hf.lastEnd}, boss ${hf.boss}, busy ${ht.busy}`);
    // ── Tried again: the helper near the checkpoint is drafted again; the van they were in is taken away ──
    await S.key('KeyG');
    s = await wait(async () => { const x = await S.todo(); return x.cur === 'm03' && !x.failed ? x : null; }, 15000) ?? await S.todo();
    const hr = await wait(async () => { const c = await H.crew(); return c.boss === sid ? c : null; }, 15000) ?? await H.crew();
    await sleep(3000);
    hcar = await H.car();
    const nv = await S.mine('van');
    check(s.cur === 'm03' && !s.failed && hr.boss === sid && !hcar && !!nv && nv.listed,
      `${who}: tried again: ${H.tag} (near the checkpoint) is on the crew again, out of the old van, and the script has a new one`, `${S.tag}: ${s.cur} ${s.failed ?? ''}; ${H.tag}: boss ${hr.boss}, ${hcar ? 'still in a ' + hcar.kind : 'on foot'}; new van ${nv ? `at ${nv.x},${nv.z}` : 'none'}`);
    const hs2 = nv ? await H.seen('van', nv.x, nv.z, 30) : null;
    check(!!hs2 && hs2.list.length + hs2.ghosts.length === 1, `${who}: and there is one van on ${H.tag}'s screen`, hs2 ? JSON.stringify(hs2) : 'no van');
    ok = !!nv && await getIn(H, nv, 'van');
    await sleep(3000);
    s = await read(S);
    check(ok && s.want && s.want.t === 'deliver', `${who}: ${H.tag} gets into the new van`, `wants ${s.want ? s.want.t : 'nothing'}`);
  }

  // ── The helper drives it to Gus (put there by the test) ──
  const gus = s.want && s.want.at ? s.want.at : { x: 35.5, z: 295.7 };
  // The starter and the far player are elsewhere: only the helper's car is at Gus's.
  const where = await put(H, gus);
  s = await wait(async () => { const x = await read(S); return !x.cur ? x : null; }, 40000, 500) ?? await S.todo();
  const hp = await wait(async () => { const c = await H.crew(); return c.boss === 0 ? c : null; }, 15000) ?? await H.crew();
  await sleep(2000);
  const [s1, h1, f1] = await Promise.all([S.todo(), H.todo(), F.todo()]);
  check(!s1.cur && s1.filed.includes('m03') && s1.money === s0.money + 250, `${who}: the van ${H.tag} is driving is at Gus's and stopped: the mission passes on ${S.tag}'s screen, ${S.tag} paid 250`,
    `put ${where ? where.far + ' m from the ring' : 'nowhere'}; ${S.tag} cash ${s0.money} to ${s1.money}, filed ${s1.filed.join(' ')}`);
  check(hp.lastEnd === 'passed' && h1.money === h0.money + 250 && h1.busy === null && hp.boss === 0, `${who}: ${H.tag} is paid the full 250 in its own browser and let go`, `${H.tag} cash ${h0.money} to ${h1.money}; ${hp.lastEnd}; busy ${h1.busy}`);
  check(h1.filed.includes('m03') && h1.filed.filter((x) => x === 'm03').length === 1, `${who}: m03 is filed in ${H.tag}'s own story${opts.helperFresh ? ' though it had only reached m01' : ''}`, `${H.tag} filed ${h0.filed.join(' ') || 'nothing'} -> ${h1.filed.join(' ')}; offers now ${h1.offers.join(' ')}; own bridge ${JSON.stringify(h0.own)} -> ${JSON.stringify(h1.own)}`);
  if (opts.helperFresh) check(h1.offers.includes('m02') && h1.offers.includes('m04') && !h1.offers.includes('m03'), `${who}: ${H.tag}'s next missions: the one it skipped (m02, Finch) and the one after m03 (m04, Vance)`, `offers ${h1.offers.join(' ')}`);
  check(f1.money === f0.money && f1.filed.length === f0.filed.length && f1.busy === null, `${who}: ${F.tag} is paid nothing and has nothing filed`, `${F.tag}: cash ${f0.money} to ${f1.money}, filed ${f1.filed.join(' ') || 'nothing'}`);
  hcar = await H.car();
  check(!!hcar && hcar.kind === 'van' && !hcar.held && !hcar.lent, `${who}: the mission over with ${H.tag} at the wheel: the van is ${H.tag}'s, an ordinary car`, hcar ? JSON.stringify(hcar) : 'on foot');
  console.log(`      bytes: crew frames this round: ${S.tag} ${wire(S, '3.10') - c0.S} frames ${wire(S, '3.10', 'bytes') - c0.Sb} bytes; ${H.tag} ${wire(H, '3.10') - c0.H} frames ${wire(H, '3.10', 'bytes') - c0.Hb} bytes; ${F.tag} ${wire(F, '3.10') - c0.F}; ${S.tag}'s crew stats ${JSON.stringify(await S.crew().then((c) => ({ teams: c.teams, shows: c.shows, showBytes: c.showBytes, lent: c.lent, back: c.back, reclaimed: c.reclaimed })))}`);
  check(wire(F, '3.10') === c0.F, `${who}: ${F.tag} sent nothing about it`, `${wire(F, '3.10') - c0.F} frames`);
  // Out of the van, which goes to the town like any car.
  await H.key('KeyF'); await sleep(3000);
}

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
  const roles = await wait(async () => { const [a, b, c] = await Promise.all([A.net(), B.net(), C.net()]); return a.traffic.mode === 'host' && b.traffic.mode === 'guest' && c.traffic.mode === 'guest' ? [a, b, c] : null; }, 60000);
  check(!!n && !!roles, 'three in town: A the host, B and C its guests', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  await sleep(3000);
  {
    // With nobody running a mission, nothing about crews is sent.
    const n0 = wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10');
    await sleep(8000);
    check(wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10') === n0 && n0 === 0, 'no mission running: no crew frames at all', `${n0} before, ${wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10') - n0} in 8 s`);
  }

  await round(B, A, C, A, { shots: SHOTS, failFirst: true, helperFresh: true });
  await sleep(3000);
  await round(A, B, C, A, { shots: false, failFirst: false, helperFresh: true, getOut: true });

  {
    const n0 = wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10');
    await sleep(10000);
    check(wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10') === n0, 'after the missions, nothing about crews is sent (10 s)', `${wire(A, '3.10') + wire(B, '3.10') + wire(C, '3.10') - n0} frames`);
    console.log(`      bytes: every crew frame of the run: A ${wire(A, '3.10')} frames ${wire(A, '3.10', 'bytes')} bytes; B ${wire(B, '3.10')} frames ${wire(B, '3.10', 'bytes')} bytes; C ${wire(C, '3.10')}`);
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
