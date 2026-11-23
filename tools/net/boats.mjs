// Other players' boats (src/net/remote.ts): A boards the speedboat at the Pelican Pier dock and drives, B must see a
// boat (not the hatchback stand-in) with A seated on it, moving smoothly, with its wake; when A leaves, the ghost goes.
//   node tools/net/boats.mjs        (local stand-ins only, as ride.mjs; the real Worker is never touched)
import { services, check, failures, sleep, wait, f1 } from './hardlib.mjs';

const S = services({ main: 8971, lookup: 8972, backup: 8973 });
const sees = (t, aid) => t.page.evaluate((aid) => {
  const g = window.__game.game, r = g.net.remotes.get(aid), v = r && r.vehicle, b = g.player.boats;
  const per = r && r.body;
  return { kind: v ? v.spec.kind : null, isBoat: !!v && b.has === undefined ? false : !!v && b.ghosts.includes(v), car: v ? g.vehicles.list.includes(v) : false,
    x: v ? v.x : 0, y: v ? v.y : 0, z: v ? v.z : 0, wake: v && v.wake ? v.wake.mesh.visible : false,
    ghosts: b.ghosts.length, per: per ? { vis: per.visible, pose: per.pose, d: v ? Math.hypot(per.x - v.x, per.z - v.z) : 99, dy: v ? per.y - v.y : 0 } : null };
}, aid);

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8971)) || !(await S.up(8973))) throw new Error('the local services did not start');
  const A = await S.visitor('A', S.viaMain), B = await S.visitor('B', S.viaMain);
  const ns = await Promise.all([A, B].map((t) => t.until((x) => x.status === 'online' && x.count === 2, 90000)));
  check(ns.every(Boolean), '1. two players online', ns.map((x) => x ? '#' + x.id : 'timeout').join(', '));
  if (!ns.every(Boolean)) throw new Error('not online');
  const aid = ns[0].id;
  // Both at the dock; B stands on the pier a little way off.
  await A.go(13, 560, 0);
  await B.go(7, 540, Math.PI / 2);
  await sleep(3000);
  const boarded = await A.page.evaluate(() => {
    const g = window.__game.game, p = g.player, v = p.boats.list.find((b) => b.spec.kind === 'speedboat');
    if (!v) return null;
    p.enter(v, true);
    return p.vehicle === v ? { x: v.x, z: v.z } : false;
  });
  check(!!boarded, '2. A boards the speedboat at the dock', JSON.stringify(boarded));
  const seen = await wait(async () => { const v = await sees(B, aid); return v.kind === 'speedboat' ? v : null; }, 10000);
  check(!!seen, '2. B sees a speedboat for A', seen ? seen.kind : JSON.stringify(await sees(B, aid)));
  if (seen) {
    check(!seen.car, '2. it is a boat, not a car in the vehicles list');
    check(seen.per && seen.per.vis && seen.per.pose === 'sit' && seen.per.d < 2.5, '2. A is drawn sitting on the boat', JSON.stringify(seen.per));
  }
  // Drive out to sea.
  await A.page.keyboard.down('KeyW');
  const pts = [];
  for (let i = 0; i < 14; i++) { await sleep(300); const v = await sees(B, aid); pts.push(v); }
  await A.page.keyboard.up('KeyW');
  const a1 = await A.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { x: v.x, z: v.z, sp: v.speed } : null; });
  const moved = Math.hypot(pts[13].x - pts[0].x, pts[13].z - pts[0].z);
  check(moved > 8, '3. B sees the boat move', `${f1(moved)} m; A speed ${a1 ? f1(a1.sp) : '?'}`);
  let worst = 0; for (let i = 1; i < pts.length; i++) worst = Math.max(worst, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  check(worst < 12, '3. no jumps between looks (0.3 s apart)', `largest step ${f1(worst)} m`);
  check(pts.slice(-3).every((v) => v.per && v.per.d < 2.5 && v.per.vis), '3. A stays on the boat while it moves');
  check(pts.slice(-3).some((v) => v.wake), '3. the ghost has its wake', String(pts[13].wake));
  check(pts.every((v) => v.ghosts === 1), '3. exactly one ghost boat on B');
  // Leaving.
  await A.page.evaluate(() => window.__game.game.player.exit());
  const gone = await wait(async () => { const v = await sees(B, aid); return v.kind === null && v.ghosts === 0 ? v : null; }, 8000);
  check(!!gone, '4. A got out: the ghost boat is gone from B', gone ? 'ghosts 0' : JSON.stringify(await sees(B, aid)));
  const pv = await B.page.evaluate((aid) => { const r = window.__game.game.net.remotes.get(aid); return r && r.body ? r.body.visible : null; }, aid);
  check(pv === true, '4. A is drawn on foot', String(pv));
  for (const t of [A, B]) { const e = t.errs(); check(e.length === 0, `5. no errors on ${t.tag}`, e.slice(0, 3).join(' | ')); }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
} finally { await S.end(); }
console.log(failures() ? `${failures()} FAILED` : 'ALL PASS');
process.exit(failures() ? 1 : 0);
