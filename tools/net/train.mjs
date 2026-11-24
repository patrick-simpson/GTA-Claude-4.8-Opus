// A drives the Budget Line (src/world/train.ts), B must see the train move with A's locomotive (net/remote.ts kind 'train').
//   node tools/net/train.mjs        (local stand-ins only, ports 8831-8833; the real Worker is never touched)
import { services, check, failures, sleep, wait, f1 } from './hardlib.mjs';

const S = services({ main: 8831, lookup: 8832, backup: 8833 });
const info = (t) => t.page.evaluate(async () => { const m = await import('/src/world/train.ts'); const i = m.trains.cur.info(); const c = m.trains.cur.cab; return { mode: i.mode, x: i.x, z: i.z, v: i.v, cx: c.x, cz: c.z, veh: window.__game.game.player.vehicle?.spec?.kind ?? null }; });

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8831)) || !(await S.up(8833))) throw new Error('the local services did not start');
  const A = await S.visitor('A', S.viaMain), B = await S.visitor('B', S.viaMain);
  const ns = await Promise.all([A, B].map((t) => t.until((x) => x.status === 'online' && x.count === 2, 90000)));
  check(ns.every(Boolean), '1. two players online');
  if (!ns.every(Boolean)) throw new Error('not online');
  await A.page.evaluate(() => window.__game.setTime(6.05));
  await B.page.evaluate(() => window.__game.setTime(6.05));
  await A.go(-1500, -1500, 0); await B.go(-1500, -1500, 0);
  await sleep(4000);
  const a0 = await info(A);
  await A.go(a0.cx - 3, a0.cz - 1, 0); await sleep(1500);
  await A.page.keyboard.press('KeyF'); await sleep(1500);
  const a1 = await info(A);
  check(a1.veh === 'train', '2. A is in the cab', a1.veh);
  await A.page.keyboard.down('KeyW');
  await sleep(12000);
  const pa = await info(A), pb = await info(B);
  await A.page.keyboard.up('KeyW');
  check(pa.v > 1, '3. A is moving', f1(pa.v));
  check(pb.mode === 'remote', '3. B has the train in remote mode', pb.mode);
  check(Math.abs(pb.cx - pa.cx) < 15 && pb.cx > a0.cx + 5, '3. B sees the locomotive near A\'s', `A ${f1(pa.cx)} B ${f1(pb.cx)} start ${f1(a0.cx)}`);
  for (const t of [A, B]) { const e = t.errs(); check(e.length === 0, `4. no errors on ${t.tag}`, e.slice(0, 3).join(' | ')); }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
} finally { await S.end(); }
console.log(failures() ? `${failures()} FAILED` : 'ALL PASS');
process.exit(failures() ? 1 : 0);
