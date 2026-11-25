// Fun queue 2, item 24: convoys, a shared waypoint. Headless browsers against LOCAL services.
//
//   node tools/net/convoy.mjs [--noshots]
//
// Started and stopped as tools/net/coop.mjs is (never run two of these tests at once). A is the host and the leader;
// B and C are pinned hidden (guests). The convoy rides on PlayerEvent.Convoy (25), an ordinary Event frame the service
// relays unread: nothing in server/ is touched. Keys: . (full stop) leads, joins or leaves.
//  0. Alone in town: . gives a toast, no convoy.
//  1. A sets a waypoint and presses .: B and C get the offer; B joins and its waypoint, route target and radar follow A;
//     C, who did not join, has no waypoint and no role.
//  2. A sets a new waypoint: B follows with a toast; C is untouched.
//  3. Arrival: A and B close to the point after a long trip: both paid, C not; the same again right away: nothing
//     (cooldown); a short hop: nothing; the leader alone at the point: nothing until a member is close too.
//  4. A member leaves; the leader leaves and hands the lead on; that leader drops off the net and the last one leads on.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8891, LOOKUP = 8892, BACKUP = 8893;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-convoy-'));
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
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8892|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });


const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.cv = () => t.page.evaluate(() => window.__game.game.todo.convoy.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.cwait = async (fn, ms = 12000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.cv(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.way = () => t.page.evaluate(() => { const w = window.__game.game.todo.waypoint; return w ? { x: w.x, z: w.z } : null; });
  t.setWay = (x, z) => t.page.evaluate(([x, z]) => { window.__game.game.todo.waypoint = { x, z }; return true; }, [x, z]);
  t.noCooldown = () => t.page.evaluate(() => window.__game.game.todo.convoy.testResetCooldown());
  t.toast = (re, ms = 6000) => wait(async () => (await t.page.evaluate((s) => (document.body.innerText.match(new RegExp(s)) || [''])[0], re.source)) || null, ms);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `convoy-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; g.player.health = 100; if (p) p.clear(); });
const footAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); return true; }, [x, z, h]);
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const near = (a, b, m = 6) => !!a && !!b && Math.hypot(a.x - b.x, a.z - b.z) < m;

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const D1 = { x: -250, z: 330 }, D2 = { x: 300, z: -300 }, HOME = { x: 49, z: 76 };

  // ── 0. Alone: no convoy ──
  await calm(A);
  await footAt(A, HOME.x, HOME.z);
  await A.setWay(D1.x, D1.z);
  await A.key('Period');
  await sleep(500);
  check((await A.cv()).role === 'none' && !!(await A.toast(/needs other players in town/, 5000)), 'alone in town: a toast, no convoy');

  const B = await visitor('B', [960, 540]); await B.pin(true);
  const C = await visitor('C'); await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  const roles = await wait(async () => { const ns = await Promise.all([A.net(), B.net(), C.net()]); return ns.every((r) => r.status === 'online' && r.count === 3) ? ns : null; }, 60000);
  check(!!n && !!roles, 'three in town', roles ? roles.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = roles ? roles.map((r) => r.id) : [];
  for (const t of [A, B, C]) { await calm(t); await t.noCooldown(); }
  await footAt(A, HOME.x, HOME.z);
  await footAt(B, HOME.x + 20, HOME.z + 10);
  await footAt(C, -560, 380);

  // ── 1. Start and join ──
  {
    await A.setWay(D1.x, D1.z);
    await A.key('Period');
    const a = await A.cwait((r) => r.role === 'lead');
    check(!!a && a.members.length === 1 && near(a.dest, D1), 'A presses . with a waypoint: leads a convoy to it', a ? JSON.stringify(a.dest) : 'no');
    const ob = await B.cwait((r) => r.offers.length === 1), oc = await C.cwait((r) => r.offers.length === 1);
    check(!!ob && !!oc && ob.offers[0].leader === ids[0], 'B and C both get the offer (the leader named)', JSON.stringify([ob && ob.offers, oc && oc.offers]).slice(0, 120));
    check(!!(await B.toast(/is leading a convoy/, 4000)), 'the offer shows as a toast');
    check(!(await B.way()), 'B has no waypoint of its own before joining');
    await B.key('Period');
    const b = await B.cwait((r) => r.role === 'member' && r.leader === ids[0]);
    const a2 = await A.cwait((r) => r.members.length === 2);
    check(!!b && !!a2, 'B joins: member on B, two in the roster on A', b && a2 ? `${b.role} ${a2.members}` : 'no');
    check(near(await B.way(), D1), "B's waypoint is the leader's destination", JSON.stringify(await B.way()));
    const tgt = await B.page.evaluate(() => { const t = window.__game.game.todo.target(); return t ? { x: t.x, z: t.z } : null; });
    check(near(tgt, D1), "B's route target (the navigation) is the same point");
    const bl = await A.page.evaluate(() => { const o = []; window.__game.game.todo.convoy.blips(o); return o; });
    check(bl.length === 1 && bl[0].label === 'V', 'A sees B as a V on the radar', JSON.stringify(bl));
    const ro = await B.page.evaluate(() => window.__game.game.todo.convoy.roster().length);
    check(ro === 2, 'the big map roster on B lists both cars', String(ro));
    await sleep(600);
    const cc = await C.cv();
    check(cc.role === 'none' && !(await C.way()), 'C (not a member): no role, no waypoint, only an offer', `${cc.role} offers=${cc.offers.length}`);
    await A.shot('lead'); await B.shot('member');
  }

  // ── 2. The destination changes ──
  {
    await A.setWay(D2.x, D2.z);
    const b = await B.cwait((r) => near(r.dest, D2));
    check(!!b, "the leader's new waypoint reaches B as its destination", b ? JSON.stringify(b.dest) : 'no');
    check(near(await B.way(), D2) && near(await A.way(), D2), 'B waypoint and A waypoint both at the new point');
    check(!!(await B.toast(/changed the destination/, 5000)), 'B gets a toast about the change');
    const cc = await C.cv();
    check(cc.role === 'none' && !(await C.way()), 'C unaffected by the change');
  }

  // ── 3. Arrival: paid once ──
  {
    const m = [await A.money(), await B.money(), await C.money()];
    await footAt(B, D2.x + 12, D2.z); await sleep(500);
    await footAt(A, D2.x + 5, D2.z);
    const done = await Promise.all([A, B].map((t) => t.cwait((r) => r.role === 'none' && r.arrived === 1, 8000)));
    check(done.every(Boolean), 'the leader judges the arrival: the convoy disbands on both', done.map((d) => d ? d.arrived : 'no').join(','));
    const m2 = [await A.money(), await B.money(), await C.money()];
    check(m2[0] - m[0] === 150 && m2[1] - m[1] === 150, 'arriving together paid $150 to A and to B', `${m2[0] - m[0]} ${m2[1] - m[1]}`);
    check(m2[2] === m[2], 'C (not a member) was not paid');
    await B.shot('arrived');
    // Again, right away: a second convoy to a far point, no pay.
    await footAt(A, HOME.x, HOME.z); await footAt(B, HOME.x + 20, HOME.z + 10);
    await A.setWay(D1.x, D1.z); await A.key('Period');
    await B.cwait((r) => r.offers.length === 1); await B.key('Period');
    await A.cwait((r) => r.members.length === 2);
    const m3 = [await A.money(), await B.money()];
    await footAt(B, D1.x + 12, D1.z); await sleep(500); await footAt(A, D1.x + 5, D1.z);
    const d2 = await Promise.all([A, B].map((t) => t.cwait((r) => r.role === 'none' && r.arrived === 2, 8000)));
    const m4 = [await A.money(), await B.money()];
    check(d2.every(Boolean) && m4[0] === m3[0] && m4[1] === m3[1], 'a second arrival right away pays nothing (once every few minutes)', `${m4[0] - m3[0]} ${m4[1] - m3[1]}`);
    check(!!(await A.toast(/paid once every few minutes/, 14000)), 'and says why');
    // A short hop pays nothing even with the cooldown off.
    await A.noCooldown(); await B.noCooldown();
    await footAt(A, HOME.x, HOME.z); await footAt(B, HOME.x + 20, HOME.z + 10);
    await A.setWay(HOME.x + 120, HOME.z); await A.key('Period');
    await B.cwait((r) => r.offers.length === 1); await B.key('Period');
    await A.cwait((r) => r.members.length === 2);
    const m5 = [await A.money(), await B.money()];
    await footAt(B, HOME.x + 130, HOME.z); await sleep(500); await footAt(A, HOME.x + 122, HOME.z);
    const d3 = await Promise.all([A, B].map((t) => t.cwait((r) => r.role === 'none' && r.arrived === 3, 8000)));
    const m6 = [await A.money(), await B.money()];
    check(d3.every(Boolean) && m6[0] === m5[0] && m6[1] === m5[1], 'a short hop (under 300 m) pays nothing', `${m6[0] - m5[0]}`);
    // The leader alone at the destination (member far away) does not pay or end.
    await A.noCooldown(); await B.noCooldown();
    await footAt(A, HOME.x, HOME.z); await footAt(B, HOME.x + 20, HOME.z + 10);
    await A.setWay(D2.x, D2.z); await A.key('Period');
    await B.cwait((r) => r.offers.length === 1); await B.key('Period');
    await A.cwait((r) => r.members.length === 2);
    const m7 = await A.money();
    await footAt(A, D2.x + 5, D2.z); await sleep(1500);
    const al = await A.cv();
    check(al.role === 'lead' && (await A.money()) === m7, 'the leader alone at the destination: nothing yet (needs 2+ cars close)', al.role);
    await footAt(B, D2.x + 20, D2.z);
    const d4 = await Promise.all([A, B].map((t) => t.cwait((r) => r.role === 'none' && r.arrived === 4, 8000)));
    check(d4.every(Boolean) && (await A.money()) - m7 === 150, 'once the member is close too: paid', `${(await A.money()) - m7}`);
  }

  // ── 4. Leaving: a member, the leader's hand-over, the leader dropping off ──
  {
    for (const [i, t] of [A, B, C].entries()) { await t.noCooldown(); await footAt(t, HOME.x + 10 * i, HOME.z); }
    await A.setWay(D1.x, D1.z); await A.key('Period');
    for (const t of [B, C]) { await t.cwait((r) => r.offers.length === 1); await t.key('Period'); }
    const a3 = await A.cwait((r) => r.members.length === 3);
    check(!!a3, 'three in the convoy (A leads, B and C follow)', a3 ? String(a3.members) : 'no');
    await C.key('Period');
    const lv = await A.cwait((r) => r.members.length === 2);
    check(!!lv && (await C.cv()).role === 'none', 'C leaves: the leader sees two', lv ? String(lv.members) : 'no');
    await C.cwait((r) => r.offers.length === 1); await C.key('Period');
    await A.cwait((r) => r.members.length === 3);
    // The leader leaves: the lead goes on to B.
    await A.key('Period');
    const nb = await B.cwait((r) => r.role === 'lead');
    const nc = await C.cwait((r) => r.role === 'member' && r.leader === ids[1]);
    check(!!nb && !!nc && (await A.cv()).role === 'none', 'the leader leaves: the lead is handed to B, C follows B', `${nb && nb.role} ${nc && nc.leader}`);
    check(!!(await C.toast(/leads it now|leads the convoy/, 5000)), 'C is told');
    // The new leader drops off the net: C takes over.
    await B.page.close(); open.splice(open.indexOf(B), 1);
    const nc2 = await C.cwait((r) => r.role === 'lead', 15000);
    check(!!nc2 && nc2.members.length === 1, 'the leader leaves town: C leads on', nc2 ? String(nc2.members) : 'no');
    await C.key('Period');
    check(!!(await C.cwait((r) => r.role === 'none')), 'a lone leader pressing . ends the convoy');
    const errs = [A, C].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
    check(errs.length === 0, 'no errors from the game on the pages that stayed', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
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
