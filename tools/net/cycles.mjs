// Other players' bikes and scooters (fun queue 2, item 9): A rides a bicycle and then an e-scooter, B must see a
// bike/scooter (not a stand-in car) with A on it, moving, and leaning into a turn; when A steps off, the ghost goes.
//   node tools/net/cycles.mjs        (local stand-ins only, as boats.mjs; the real Worker is never touched)
import { services, check, failures, sleep, wait, f1 } from './hardlib.mjs';

const S = services({ main: 8981, lookup: 8982, backup: 8983 });
const sees = (t, aid) => t.page.evaluate((aid) => {
  const g = window.__game.game, r = g.net.remotes.get(aid), v = r && r.vehicle, per = r && r.body;
  return { kind: v ? v.spec.kind : null, x: v ? v.x : 0, z: v ? v.z : 0, roll: v ? v.roll : 0, inList: v ? g.vehicles.list.includes(v) || g.vehicles.ghosts.includes(v) : false,
    per: per ? { vis: per.visible, pose: per.pose, d: v ? Math.hypot(per.x - v.x, per.z - v.z) : 99 } : null };
}, aid);

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8981)) || !(await S.up(8983))) throw new Error('the local services did not start');
  const A = await S.visitor('A', S.viaMain), B = await S.visitor('B', S.viaMain);
  const ns = await Promise.all([A, B].map((t) => t.until((x) => x.status === 'online' && x.count === 2, 90000)));
  check(ns.every(Boolean), '1. two players online', ns.map((x) => x ? '#' + x.id : 'timeout').join(', '));
  if (!ns.every(Boolean)) throw new Error('not online');
  const aid = ns[0].id;
  // Open lawn at the library quad; B stands a few metres off the line A rides.
  // The athletics lawn: 30 m of open ground east of x -523. B stands off the line A rides.
  await A.go(-523, -2602, Math.PI / 2);
  await B.go(-500, -2594, -Math.PI / 2);
  await sleep(3500);
  for (const kind of ['bike', 'scooter']) {
    if (kind === 'scooter') { await A.go(-523, -2590, Math.PI / 2); await sleep(1500); }
    const on = await A.page.evaluate((kind) => { const g = window.__game.game, p = g.player, v = g.vehicles.spawn(kind, p.x, p.z, Math.PI / 2); p.enter(v, true); return p.vehicle === v ? v.spec.kind : null; }, kind);
    check(on === kind, `${kind}: A gets on`, String(on));
    const seen = await wait(async () => { const v = await sees(B, aid); return v.kind === kind ? v : null; }, 10000);
    check(!!seen, `${kind}: B sees a ${kind} for A`, seen ? seen.kind : JSON.stringify(await sees(B, aid)));
    if (!seen) continue;
    // Ride straight, then lean into a turn.
    await A.page.keyboard.down('KeyW');
    const pts = [];
    for (let i = 0; i < 4; i++) { await sleep(300); pts.push(await sees(B, aid)); }
    await A.page.keyboard.down('KeyA');
    await sleep(500);
    // B looks at A from the side, in daylight (the picture is the check on how the lean and the rider read).
    await B.page.evaluate((aid) => { const G = window.__game, r = G.game.net.remotes.get(aid), v = r && r.vehicle; G.setTime && G.setTime(12); if (v) G.view(v.x + 3.5, v.y + 1.4, v.z + 1.5, v.x, v.y + 0.8, v.z); }, aid);
    await sleep(250);
    await B.page.screenshot({ path: `scratch/q2-09b/shots/mp_${kind}_B.png` });
    let lean = 0;
    for (let i = 0; i < 6; i++) { await sleep(250); const v = await sees(B, aid); lean = Math.max(lean, Math.abs(v.roll)); pts.push(v); }
    const aSide = await A.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { roll: +v.roll.toFixed(3), sp: +v.speed.toFixed(1), yaw: +v.yawRate.toFixed(2), steer: +v.ctl.steer.toFixed(2) } : null; });
    await A.page.keyboard.up('KeyA'); await A.page.keyboard.up('KeyW');
    const moved = Math.hypot(pts[3].x - pts[0].x, pts[3].z - pts[0].z);
    check(moved > 0.8, `${kind}: B sees it move`, `${f1(moved)} m`);
    check(lean > 0.08, `${kind}: B sees it lean into the turn`, `peak roll seen by B ${lean.toFixed(2)} rad; A: ${JSON.stringify(aSide)}`);
    
    await B.page.evaluate(() => window.__game.view());
    await A.page.evaluate(() => window.__game.game.player.exit());
    const gone = await wait(async () => { const v = await sees(B, aid); return v.kind === null ? v : null; }, 8000);
    check(!!gone, `${kind}: A steps off: the ghost is gone from B`, gone ? 'gone' : JSON.stringify(await sees(B, aid)));
  }
  for (const t of [A, B]) { const e = t.errs(); check(e.length === 0, `no errors on ${t.tag}`, e.slice(0, 3).join(' | ')); }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
} finally { await S.end(); }
console.log(failures() ? `${failures()} FAILED` : 'ALL PASS');
process.exit(failures() ? 1 : 0);
